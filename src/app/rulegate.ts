// RuleGate client: ABI helpers, dual-provider reads and guarded writes for the on-chain session contract.
//
// Pure logic with injected dependencies (RPC clients, storage, clock), so it can be tested with fakes. Guarantees:
//   - every signature request is preceded by eth_call and eth_estimateGas from the account on both providers;
//   - the only address ever called is the configured RuleGate; the value is always 0; the transaction object is exactly
//     { from, to, data, value } (a deployment has no `to`);
//   - a transaction recorded as pending (sessionStorage, per account) is never followed by a second one until it is confirmed or released;
//   - receipts must succeed on both providers, in the same block, and their logs must be identical;
//   - when anything is uncertain the write refuses with a plain-English reason instead of throwing.
import { keccak_256 } from "@noble/hashes/sha3.js";
import ruleGateArtifact from "../../contracts/RuleGate.json" with { type: "json" };
import rulegateDocument from "../../deployments/rulegate.json" with { type: "json" };
import { loadCanonicalDeployment } from "../protocol/deployment.js";
import { hexFromBytes } from "../protocol/gate-d-abi.js";
import type { ReadOnlyRpcClient } from "../protocol/rpc.js";
import type { ProtocolLock } from "../protocol/types.js";
import type { Eip1193Provider } from "./wallet.js";
import { CANCELLED_MESSAGE, X_LAYER_CHAIN_HEX, describeRpcError, isUserRejection, type StorageLike } from "./tapeout.js";

// ---------------------------------------------------------------------------------------------------------------------
// configuration

export interface RuleGateConfig {
  chainId: number;
  /** null until the contract is deployed; the feature is then "not deployed". */
  address: string | null;
  deployTransaction: string | null;
  /** The GateX processor RuleGate was (or will be) deployed against. */
  processor: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export function loadRuleGateConfig(document: unknown, canonicalProcessor = loadCanonicalDeployment().processor): RuleGateConfig {
  const value = document as Partial<RuleGateConfig> | null;
  if (typeof value !== "object" || value === null) throw new Error("deployments/rulegate.json is not an object");
  if (value.chainId !== 196) throw new Error("deployments/rulegate.json is not for chain 196");
  if (value.address !== null && !(typeof value.address === "string" && ADDRESS.test(value.address))) throw new Error("deployments/rulegate.json has an invalid address");
  if (value.deployTransaction !== null && !(typeof value.deployTransaction === "string" && HASH.test(value.deployTransaction))) throw new Error("deployments/rulegate.json has an invalid deployTransaction");
  if (typeof value.processor !== "string" || value.processor.toLowerCase() !== canonicalProcessor.toLowerCase()) throw new Error("deployments/rulegate.json does not name the GateX processor");
  return { chainId: 196, address: value.address === null ? null : value.address.toLowerCase(), deployTransaction: value.deployTransaction ?? null, processor: value.processor.toLowerCase() };
}

export const RULEGATE: RuleGateConfig = loadRuleGateConfig(rulegateDocument);
export function isDeployed(config: RuleGateConfig = RULEGATE): boolean { return config.address !== null; }

// ---------------------------------------------------------------------------------------------------------------------
// ABI

const encoder = new TextEncoder();
function hexOf(bytes: Uint8Array): string { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function topicOf(signature: string): string { return `0x${hexOf(keccak_256(encoder.encode(signature)))}`; }
function selectorOf(signature: string): string { return topicOf(signature).slice(0, 10); }

export class RuleGateAbiError extends Error {
  constructor(message: string) { super(message); this.name = "RuleGateAbiError"; }
}

export function bytesFromHex(value: string): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new RuleGateAbiError(`Expected even-length hex bytes, received ${value.slice(0, 20)}`);
  const result = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  return result;
}

export const SELECTORS = Object.freeze({
  open: selectorOf("open(uint256,uint256)"),
  step: selectorOf("step(uint256,bytes)"),
  preview: selectorOf("preview(uint256,bytes)"),
  session: selectorOf("session(uint256)"),
  sessionCount: selectorOf("sessionCount()"),
  processor: selectorOf("processor()")
});
export const TOPICS = Object.freeze({
  sessionOpened: topicOf("SessionOpened(uint256,uint256,address,uint256)"),
  stepped: topicOf("Stepped(uint256,uint256,address,uint32,bytes,bytes,bytes)")
});
export const ERROR_SELECTORS = Object.freeze({
  NoSuchSession: selectorOf("NoSuchSession()"),
  NotSessionOwner: selectorOf("NotSessionOwner()"),
  BadLength: selectorOf("BadLength()"),
  CircuitChangedStateLength: selectorOf("CircuitChangedStateLength()")
});
export const MAX_STATE_BYTES = 32;
export const MAX_INPUT_BYTES = 32;

function word(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) throw new RuleGateAbiError("value does not fit in uint256");
  return value.toString(16).padStart(64, "0");
}
function paddedBytes(bytes: Uint8Array): string {
  const hex = hexOf(bytes);
  return word(BigInt(bytes.length)) + hex.padEnd(Math.ceil(bytes.length / 32) * 64, "0");
}
function toBig(value: bigint | number | string): bigint { return typeof value === "bigint" ? value : BigInt(value); }

export function encodeOpen(circuitId: bigint | number | string, stateBytes: bigint | number): string { return `${SELECTORS.open}${word(toBig(circuitId))}${word(toBig(stateBytes))}`; }
export function encodeStep(sessionId: bigint | number | string, inputs: Uint8Array): string { return `${SELECTORS.step}${word(toBig(sessionId))}${word(64n)}${paddedBytes(inputs)}`; }
export function encodePreview(sessionId: bigint | number | string, inputs: Uint8Array): string { return `${SELECTORS.preview}${word(toBig(sessionId))}${word(64n)}${paddedBytes(inputs)}`; }
export function encodeSession(sessionId: bigint | number | string): string { return `${SELECTORS.session}${word(toBig(sessionId))}`; }
export function encodeSessionCount(): string { return SELECTORS.sessionCount; }
export function encodeProcessorCall(): string { return SELECTORS.processor; }

function readWord(bytes: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 32 > bytes.length) throw new RuleGateAbiError("ABI word is truncated");
  let result = 0n;
  for (let index = offset; index < offset + 32; index += 1) result = (result << 8n) | BigInt(bytes[index] ?? 0);
  return result;
}
function readAddress(bytes: Uint8Array, offset: number): string {
  const value = readWord(bytes, offset);
  if (value >> 160n !== 0n) throw new RuleGateAbiError("ABI address has non-zero high bytes");
  return `0x${value.toString(16).padStart(40, "0")}`;
}
function readSmall(bytes: Uint8Array, offset: number, label: string, max = 0xffffffffn): number {
  const value = readWord(bytes, offset);
  if (value > max) throw new RuleGateAbiError(`${label} is out of range`);
  return Number(value);
}
function readDynamic(bytes: Uint8Array, headOffset: number): Uint8Array {
  const offset = readWord(bytes, headOffset);
  if (offset > BigInt(bytes.length) || offset % 32n !== 0n) throw new RuleGateAbiError("ABI dynamic offset is invalid");
  const start = Number(offset);
  const length = readWord(bytes, start);
  if (length > BigInt(bytes.length)) throw new RuleGateAbiError("ABI dynamic length is invalid");
  const size = Number(length);
  const end = start + 32 + Math.ceil(size / 32) * 32;
  if (end > bytes.length) throw new RuleGateAbiError("ABI dynamic bytes are truncated");
  for (const byte of bytes.slice(start + 32 + size, end)) if (byte !== 0) throw new RuleGateAbiError("ABI dynamic padding is non-zero");
  return bytes.slice(start + 32, start + 32 + size);
}

export interface SessionRecord {
  id: bigint;
  owner: string;
  circuitId: bigint;
  steps: number;
  state: Uint8Array;
  lastOutputs: Uint8Array;
}

export function decodeSessionReturn(id: bigint, value: string): SessionRecord {
  const bytes = bytesFromHex(value);
  return { id, owner: readAddress(bytes, 0), circuitId: readWord(bytes, 32), steps: readSmall(bytes, 64, "steps"), state: readDynamic(bytes, 96), lastOutputs: readDynamic(bytes, 128) };
}
export function decodePreviewReturn(value: string): { newState: Uint8Array; outputs: Uint8Array } {
  const bytes = bytesFromHex(value);
  return { newState: readDynamic(bytes, 0), outputs: readDynamic(bytes, 32) };
}
export function decodeUintReturn(value: string): bigint {
  const bytes = bytesFromHex(value);
  if (bytes.length !== 32) throw new RuleGateAbiError("uint256 return must be one word");
  return readWord(bytes, 0);
}
export function decodeAddressReturn(value: string): string {
  const bytes = bytesFromHex(value);
  if (bytes.length !== 32) throw new RuleGateAbiError("address return must be one word");
  return readAddress(bytes, 0);
}

export interface RpcLog { address?: unknown; topics?: unknown; data?: unknown }
function topicWord(log: RpcLog, index: number): Uint8Array {
  if (!Array.isArray(log.topics) || typeof log.topics[index] !== "string" || !HASH.test(log.topics[index] as string)) throw new RuleGateAbiError("log topic is missing");
  return bytesFromHex(log.topics[index] as string);
}
function logData(log: RpcLog): Uint8Array {
  if (typeof log.data !== "string") throw new RuleGateAbiError("log data is missing");
  return bytesFromHex(log.data);
}
export interface SessionOpenedEvent { sessionId: bigint; circuitId: bigint; owner: string; stateBytes: number }
export function decodeSessionOpenedLog(log: RpcLog): SessionOpenedEvent {
  if (topicWord(log, 0).length !== 32 || `0x${hexOf(topicWord(log, 0))}` !== TOPICS.sessionOpened) throw new RuleGateAbiError("not a SessionOpened log");
  const data = logData(log);
  if (data.length !== 32) throw new RuleGateAbiError("SessionOpened data is not one word");
  return { sessionId: readWord(topicWord(log, 1), 0), circuitId: readWord(topicWord(log, 2), 0), owner: readAddress(topicWord(log, 3), 0), stateBytes: readSmall(data, 0, "stateBytes", 255n) };
}
export interface SteppedEvent { sessionId: bigint; circuitId: bigint; caller: string; step: number; inputs: Uint8Array; newState: Uint8Array; outputs: Uint8Array }
export function decodeSteppedLog(log: RpcLog): SteppedEvent {
  if (`0x${hexOf(topicWord(log, 0))}` !== TOPICS.stepped) throw new RuleGateAbiError("not a Stepped log");
  const data = logData(log);
  return { sessionId: readWord(topicWord(log, 1), 0), circuitId: readWord(topicWord(log, 2), 0), caller: readAddress(topicWord(log, 3), 0), step: readSmall(data, 0, "step"), inputs: readDynamic(data, 32), newState: readDynamic(data, 64), outputs: readDynamic(data, 96) };
}

/** The state value held in a state byte string (little-endian, as the compiler encodes state indexes). */
export function stateValue(bytes: Uint8Array): number { return bytes.reduce((result, byte, index) => result + byte * 2 ** (8 * index), 0); }

// ---------------------------------------------------------------------------------------------------------------------
// types and helpers

export const RECEIPT_POLL_INTERVAL_MS = 2_000;
export const RECEIPT_TIMEOUT_MS = 180_000;
const PENDING_KEY_PREFIX = "gatex.rulegate.pending.v1";

export interface RuleGateDeps {
  config: RuleGateConfig;
  lock: ProtocolLock;
  clients: ReadonlyMap<string, ReadOnlyRpcClient>;
  /** sessionStorage in the browser. Without working storage no transaction is ever sent. */
  storage?: StorageLike;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export type RuleGateFailureCode = "not-deployed" | "bad-input" | "pending" | "busy" | "storage" | "simulation" | "providers-disagree" | "wallet" | "wallet-chain" | "target" | "cancelled" | "failed" | "timeout" | "mismatch";
export interface RuleGateFailure { ok: false; reason: string; code: RuleGateFailureCode; hash?: string }
export type Phase = "checking" | "confirm" | "waiting";

export interface OpenResult { ok: true; sessionId: bigint; circuitId: bigint; hash: string; blockNumber: bigint }
export interface StepResult { ok: true; sessionId: bigint; step: number; inputs: Uint8Array; newState: Uint8Array; outputs: Uint8Array; hash: string; blockNumber: bigint }
export interface DeployResult { ok: true; hash: string }
export interface DeploymentConfirmed { ok: true; address: string; hash: string; blockNumber: bigint }

export interface RuleGatePending {
  version: 1;
  /** "signing": a signature was requested and no hash is known yet. "submitted": the wallet returned a hash. */
  phase: "signing" | "submitted";
  kind: "open" | "step" | "deploy";
  account: string;
  to?: string;
  data: string;
  hash?: string;
  nonce?: string;
  sentAt: number;
  sessionId?: string;
  circuitId?: string;
  stateBytes?: number;
}

export interface SessionView extends SessionRecord { block: number }

const lower = (value: string): string => value.toLowerCase();
const isAddress = (value: unknown): value is string => typeof value === "string" && ADDRESS.test(value);
const sameAddress = (a: unknown, b: unknown): boolean => typeof a === "string" && typeof b === "string" && lower(a) === lower(b);
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const fail = (code: RuleGateFailureCode, reason: string, hash?: string): RuleGateFailure => ({ ok: false, code, reason, ...(hash === undefined ? {} : { hash }) });
function hexQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${label} is not a hex quantity`);
  return BigInt(value);
}
function hexResult(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`${label} is not hex`);
  return value;
}

const REVERT_WORDS: Record<string, string> = {
  [ERROR_SELECTORS.NoSuchSession]: "There is no such session.",
  [ERROR_SELECTORS.NotSessionOwner]: "This is not your session. Only the wallet that opened it can advance it.",
  [ERROR_SELECTORS.BadLength]: "A length is not allowed: state and inputs must be 1 to 32 bytes.",
  [ERROR_SELECTORS.CircuitChangedStateLength]: "The circuit returned a state of a different length than the session stores."
};

/** Plain words for a failed call. Known RuleGate errors are named; anything else falls back to the node's own message. */
export function explainFailure(error: unknown): string {
  const text = errorMessage(error);
  const start = text.indexOf("{");
  if (start >= 0) {
    try {
      const parsed = JSON.parse(text.slice(start)) as { data?: unknown; message?: unknown };
      const data = typeof parsed.data === "string" ? parsed.data : typeof parsed.data === "object" && parsed.data !== null && typeof (parsed.data as { data?: unknown }).data === "string" ? (parsed.data as { data: string }).data : undefined;
      const known = data === undefined ? undefined : REVERT_WORDS[lower(data).slice(0, 10)];
      if (known !== undefined) return known;
    } catch { /* fall through */ }
  }
  const inner = describeRpcError(error);
  const named = Object.entries(ERROR_SELECTORS).find(([name]) => inner.includes(name));
  return named === undefined ? inner : (REVERT_WORDS[named[1]] ?? inner);
}
function isRevert(error: unknown): boolean { return errorMessage(error).toLowerCase().includes("revert"); }

export function pendingStorageKey(account: string): string { return `${PENDING_KEY_PREFIX}:${lower(account)}`; }

function parsePending(raw: string | null): RuleGatePending | undefined {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<RuleGatePending> | null;
    if (typeof value !== "object" || value === null || value.version !== 1) return undefined;
    if (value.phase !== "signing" && value.phase !== "submitted") return undefined;
    if (value.kind !== "open" && value.kind !== "step" && value.kind !== "deploy") return undefined;
    if (!isAddress(value.account) || typeof value.data !== "string" || typeof value.sentAt !== "number") return undefined;
    if (value.phase === "submitted" && !(typeof value.hash === "string" && HASH.test(value.hash))) return undefined;
    return value as RuleGatePending;
  } catch { return undefined; }
}

interface Tx { from: string; to?: string; data: string; value: "0x0" }

// ---------------------------------------------------------------------------------------------------------------------
// client

export class RuleGateClient {
  private readonly busy = new Set<string>();
  constructor(private readonly deps: RuleGateDeps) {}

  get config(): RuleGateConfig { return this.deps.config; }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private sleep(ms: number): Promise<void> { return (this.deps.sleep ?? ((delay) => new Promise<void>((resolve) => setTimeout(resolve, delay))))(ms); }

  private providers(): Array<{ provider: string; client: ReadOnlyRpcClient }> | undefined {
    const result: Array<{ provider: string; client: ReadOnlyRpcClient }> = [];
    for (const provider of this.deps.lock.snapshot.providers) {
      const client = this.deps.clients.get(provider);
      if (client === undefined) return undefined;
      result.push({ provider, client });
    }
    return result.length >= 2 ? result : undefined;
  }

  private async both<T>(run: (client: ReadOnlyRpcClient, provider: string) => Promise<T>): Promise<{ ok: true; values: T[] } | { ok: false; reason: string; error: unknown }> {
    const providers = this.providers();
    if (providers === undefined) return { ok: false, reason: "Both data providers are required and at least one is not configured.", error: new Error("providers") };
    const settled = await Promise.all(providers.map(async ({ client, provider }) => {
      try { return { ok: true as const, value: await run(client, provider) }; } catch (error) { return { ok: false as const, error }; }
    }));
    const failure = settled.find((entry) => !entry.ok);
    if (failure !== undefined && !failure.ok) return { ok: false, reason: explainFailure(failure.error), error: failure.error };
    return { ok: true, values: settled.map((entry) => (entry as { ok: true; value: T }).value) };
  }

  // -- reads ---------------------------------------------------------------------------------------------------------

  /** The highest block both providers have, with identical block hashes there. Waits (bounded) until it reaches `minBlock`. */
  async commonBlock(minBlock = 0): Promise<{ number: number; tag: string }> {
    const interval = this.deps.pollIntervalMs ?? RECEIPT_POLL_INTERVAL_MS;
    for (let attempt = 0; ; attempt += 1) {
      const heads = await this.both(async (client) => {
        const chain = Number(hexQuantity(await client.request("eth_chainId", []), "chain id"));
        if (chain !== this.deps.lock.chainId) throw new Error(`a provider reported chain ${chain}, expected ${this.deps.lock.chainId}`);
        return Number(hexQuantity(await client.request("eth_blockNumber", []), "head"));
      });
      if (!heads.ok) throw new Error(heads.reason);
      const number = Math.min(...heads.values);
      if (number < minBlock && attempt < 20) { await this.sleep(interval); continue; }
      if (number < minBlock) throw new Error("The providers have not caught up with your last transaction yet.");
      const tag = `0x${number.toString(16)}`;
      const blocks = await this.both(async (client) => {
        const raw = await client.request("eth_getBlockByNumber", [tag, false]);
        const hash = typeof raw === "object" && raw !== null ? (raw as { hash?: unknown }).hash : undefined;
        if (typeof hash !== "string") throw new Error(`block ${number} is unavailable`);
        return lower(hash);
      });
      if (!blocks.ok) throw new Error(blocks.reason);
      if (new Set(blocks.values).size !== 1) throw new Error(`The providers disagree about block ${number}.`);
      return { number, tag };
    }
  }

  private address(): string {
    if (this.deps.config.address === null) throw new Error("RuleGate is not deployed yet.");
    return this.deps.config.address;
  }

  /** eth_call on both providers at the same block; the raw answers must be identical. A revert on both is reported as `{ reverted }`. */
  private async callBoth(to: string, data: string, tag: string): Promise<{ raw: string } | { reverted: string }> {
    const settled = await Promise.all((this.providers() ?? []).map(async ({ client }) => {
      try { return { raw: hexResult(await client.request("eth_call", [{ to, data }, tag]), "eth_call result") }; } catch (error) { return { error }; }
    }));
    if (settled.length < 2) throw new Error("Both data providers are required.");
    const reverted = settled.filter((entry) => "error" in entry && isRevert(entry.error));
    if (reverted.length === settled.length) return { reverted: explainFailure((reverted[0] as { error: unknown }).error) };
    const other = settled.find((entry) => "error" in entry);
    if (other !== undefined && "error" in other) throw new Error(reverted.length > 0 ? "The two providers disagree about this session." : `X Layer could not be read: ${explainFailure(other.error)}`);
    const raws = settled.map((entry) => (entry as { raw: string }).raw);
    if (new Set(raws).size !== 1) throw new Error("The two providers returned different answers. Nothing is shown as fact.");
    return { raw: raws[0] as string };
  }

  private async readSessionAt(tag: string, id: bigint): Promise<SessionRecord | undefined> {
    const result = await this.callBoth(this.address(), encodeSession(id), tag);
    if ("reverted" in result) return undefined;
    return decodeSessionReturn(id, result.raw);
  }

  /** Undefined when there is no such session (both providers say so). Throws when the providers disagree or cannot be read. */
  async readSession(id: bigint, options: { minBlock?: number } = {}): Promise<SessionView | undefined> {
    const block = await this.commonBlock(options.minBlock ?? 0);
    const record = await this.readSessionAt(block.tag, id);
    return record === undefined ? undefined : { ...record, block: block.number };
  }

  async readSessionCount(): Promise<{ count: bigint; block: number }> {
    const block = await this.commonBlock();
    return { count: await this.countAt(block.tag), block: block.number };
  }

  private async countAt(tag: string): Promise<bigint> {
    const result = await this.callBoth(this.address(), encodeSessionCount(), tag);
    if ("reverted" in result) throw new Error("RuleGate did not answer sessionCount().");
    return decodeUintReturn(result.raw);
  }

  /** The newest sessions, all read at one common block. */
  async listSessions(options: { newest: number }): Promise<{ count: bigint; block: number; rows: SessionRecord[] }> {
    const block = await this.commonBlock();
    const count = await this.countAt(block.tag);
    const ids: bigint[] = [];
    for (let id = count; id >= 1n && ids.length < options.newest; id -= 1n) ids.push(id);
    const rows: SessionRecord[] = [];
    for (let start = 0; start < ids.length; start += 4) {
      const batch = await Promise.all(ids.slice(start, start + 4).map((id) => this.readSessionAt(block.tag, id)));
      for (const record of batch) {
        if (record === undefined) throw new Error("A session counted by RuleGate could not be read.");
        rows.push(record);
      }
    }
    return { count, block: block.number, rows };
  }

  /** What the contract's own preview says the next step would do for these inputs. Throws a plain message when it cannot. */
  async previewStep(id: bigint, inputs: Uint8Array, options: { minBlock?: number } = {}): Promise<{ newState: Uint8Array; outputs: Uint8Array; block: number }> {
    const block = await this.commonBlock(options.minBlock ?? 0);
    const result = await this.callBoth(this.address(), encodePreview(id, inputs), block.tag);
    if ("reverted" in result) throw new Error(result.reverted);
    return { ...decodePreviewReturn(result.raw), block: block.number };
  }

  // -- pending records -----------------------------------------------------------------------------------------------

  pending(account: string): RuleGatePending | undefined {
    try { return parsePending(this.deps.storage?.getItem(pendingStorageKey(account)) ?? null); } catch { return undefined; }
  }
  private writePending(record: RuleGatePending): boolean {
    try {
      const key = pendingStorageKey(record.account);
      this.deps.storage?.setItem(key, JSON.stringify(record));
      return this.deps.storage !== undefined && this.deps.storage.getItem(key) === JSON.stringify(record);
    } catch { return false; }
  }
  private clearPending(account: string): void {
    try { this.deps.storage?.removeItem(pendingStorageKey(account)); } catch { /* nothing to do */ }
  }
  /** The user asserts an interrupted signature request produced no transaction. Only the "signing" phase can be discarded this way. */
  discardInterruptedSigning(account: string): boolean {
    if (this.pending(account)?.phase !== "signing") return false;
    this.clearPending(account);
    return true;
  }
  /** Releases a submitted hash only when both providers have never heard of it and the account nonce has moved past the recorded one. */
  async releaseDroppedPending(account: string): Promise<{ released: boolean; reason: string }> {
    const record = this.pending(account);
    if (record === undefined || record.phase !== "submitted" || record.hash === undefined) return { released: false, reason: "There is no submitted transaction to release." };
    if (record.nonce === undefined) return { released: false, reason: "The nonce for this transaction was not recorded, so GateX cannot prove it was dropped." };
    const hash = record.hash;
    const result = await this.both(async (client) => {
      const [transaction, count] = await Promise.all([client.request("eth_getTransactionByHash", [hash]), client.request("eth_getTransactionCount", [account, "latest"])]);
      return { known: transaction !== null && transaction !== undefined, count: hexQuantity(count, "nonce") };
    });
    if (!result.ok) return { released: false, reason: `Could not check both providers: ${result.reason}` };
    if (result.values.some((value) => value.known)) return { released: false, reason: "A provider still knows this transaction. Keep waiting." };
    if (result.values.some((value) => value.count <= BigInt(record.nonce as string))) return { released: false, reason: "Your account nonce has not moved past this transaction, so it may still be in a mempool. Keep waiting." };
    this.clearPending(account);
    return { released: true, reason: "The transaction was dropped and its slot reused. You can send again." };
  }

  // -- guarded send --------------------------------------------------------------------------------------------------

  private async guardedSend(provider: Eip1193Provider, account: string, kind: RuleGatePending["kind"], tx: Tx, meta: Pick<RuleGatePending, "sessionId" | "circuitId" | "stateBytes">, onPhase?: (phase: Phase) => void): Promise<{ ok: true; record: RuleGatePending } | RuleGateFailure> {
    if (!isAddress(account)) return fail("bad-input", "There is no valid account.");
    const { address } = this.deps.config;
    if (kind !== "deploy") {
      if (address === null) return fail("not-deployed", "RuleGate is not deployed yet.");
      if (!sameAddress(tx.to, address) || tx.value !== "0x0" || !sameAddress(tx.from, account)) return fail("target", "The transaction target, value or sender is not the expected one. Nothing was sent.");
    } else if (tx.to !== undefined || tx.value !== "0x0") return fail("target", "A deployment must have no target and no value. Nothing was sent.");
    if (this.busy.has(lower(account))) return fail("busy", "A transaction is already being processed. Nothing was sent twice.");
    this.busy.add(lower(account));
    try {
      const existing = this.pending(account);
      if (existing !== undefined) return fail("pending", existing.phase === "signing" ? "A previous signature request was interrupted and may have been sent. Check your wallet activity before continuing." : "A transaction is already waiting for confirmation. It will not be sent again.");
      if (this.deps.storage === undefined) return fail("storage", "Browser storage is unavailable, so GateX cannot protect against sending twice. Nothing was sent.");

      onPhase?.("checking");
      const call = { from: account, ...(tx.to === undefined ? {} : { to: tx.to }), data: tx.data, value: "0x0" };
      const simulated = await this.both(async (client) => {
        const returnValue = kind === "deploy" ? "0x" : hexResult(await client.request("eth_call", [call, "latest"]), "eth_call result");
        const gas = hexQuantity(await client.request("eth_estimateGas", [call, "latest"]), "gas estimate");
        const nonce = hexQuantity(await client.request("eth_getTransactionCount", [account, "latest"]), "nonce");
        return { returnValue, gas, nonce };
      });
      if (!simulated.ok) return fail("simulation", `This would fail on X Layer: ${simulated.reason} Nothing was sent.`);
      if (new Set(simulated.values.map((value) => value.returnValue)).size !== 1) return fail("providers-disagree", "The two data providers returned different simulation results. Nothing was sent.");

      let chainId: unknown;
      let accounts: unknown;
      try {
        chainId = await provider.request({ method: "eth_chainId" });
        accounts = await provider.request({ method: "eth_accounts" });
      } catch (error) { return fail("wallet", `The wallet could not be read: ${errorMessage(error)}`); }
      if (typeof chainId !== "string" || !/^0x[0-9a-fA-F]+$/.test(chainId) || BigInt(chainId) !== BigInt(X_LAYER_CHAIN_HEX)) return fail("wallet-chain", "Your wallet is not on X Layer (chain 196). Switch network and try again.");
      if (!Array.isArray(accounts) || !sameAddress(accounts[0], account)) return fail("wallet", "The wallet's active account is not the account this action was prepared for. Reconnect and try again.");

      const nonce = simulated.values.reduce((max, value) => value.nonce > max ? value.nonce : max, 0n).toString();
      const record: RuleGatePending = { version: 1, phase: "signing", kind, account, ...(tx.to === undefined ? {} : { to: tx.to }), data: tx.data, nonce, sentAt: this.now(), ...meta };
      if (!this.writePending(record)) return fail("storage", "Browser storage is unavailable, so GateX cannot protect against sending twice. Nothing was sent.");

      onPhase?.("confirm");
      let hash: unknown;
      try {
        hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: tx.from, ...(tx.to === undefined ? {} : { to: tx.to }), data: tx.data, value: tx.value }] });
      } catch (error) {
        this.clearPending(account);
        if (isUserRejection(error)) return fail("cancelled", CANCELLED_MESSAGE);
        return fail("wallet", `The wallet did not send the transaction: ${errorMessage(error)}`);
      }
      if (typeof hash !== "string" || !HASH.test(hash)) return fail("wallet", "The wallet returned no transaction hash. Check your wallet activity; GateX will not send again until you do.");
      const submitted: RuleGatePending = { ...record, phase: "submitted", hash: lower(hash) };
      this.writePending(submitted);
      return { ok: true, record: submitted };
    } finally {
      this.busy.delete(lower(account));
    }
  }

  // -- receipts ------------------------------------------------------------------------------------------------------

  private async checkOnce(record: RuleGatePending, hash: string): Promise<{ state: "waiting"; why: string } | { state: "failed" } | { state: "error"; reason: string } | { state: "ok"; blockNumber: bigint; logs: RpcLog[]; contractAddress?: string }> {
    const providers = this.providers();
    if (providers === undefined) return { state: "error", reason: "Both data providers are required to confirm a transaction." };
    const fetched = await Promise.all(providers.map(async ({ client }) => {
      try {
        const receipt = await client.request("eth_getTransactionReceipt", [hash]);
        if (receipt === null || receipt === undefined) return { state: "none" as const };
        const transaction = await client.request("eth_getTransactionByHash", [hash]);
        const status = (receipt as { status?: unknown }).status;
        if (typeof status === "string" && status.toLowerCase() !== "0x1") return { state: "failed" as const };
        return { state: "mined" as const, receipt: receipt as Record<string, unknown>, transaction: transaction as Record<string, unknown> | null };
      } catch { return { state: "none" as const }; }
    }));
    if (fetched.every((entry) => entry.state === "failed")) return { state: "failed" };
    if (fetched.some((entry) => entry.state === "failed")) return { state: "waiting", why: "The two providers disagree about whether it succeeded." };
    if (fetched.some((entry) => entry.state === "none")) return { state: "waiting", why: "Not yet seen by both providers." };
    const mined = fetched.filter((entry): entry is Extract<typeof entry, { state: "mined" }> => entry.state === "mined");
    for (const entry of mined) {
      const tx = entry.transaction;
      const matches = tx !== null && typeof tx === "object" && sameAddress(tx.from, record.account) && lower(String(tx.input ?? tx.data ?? "")) === lower(record.data) && /^0x0*$/.test(String(tx.value ?? "0x0")) && (record.to === undefined ? tx.to === null || tx.to === undefined : sameAddress(tx.to, record.to));
      if (!matches) return { state: "error", reason: "The transaction on chain is not the one GateX sent. Nothing further was done." };
    }
    const summary = mined.map((entry) => ({ blockHash: lower(String(entry.receipt.blockHash)), blockNumber: String(entry.receipt.blockNumber), logs: JSON.stringify(entry.receipt.logs ?? []), contract: lower(String(entry.receipt.contractAddress ?? "")) }));
    const first = summary[0];
    if (first === undefined) return { state: "waiting", why: "Waiting for receipts." };
    if (summary.some((entry) => entry.blockHash !== first.blockHash || BigInt(entry.blockNumber) !== BigInt(first.blockNumber))) return { state: "error", reason: "The two providers report different blocks for this transaction. GateX will not continue until they agree." };
    if (summary.some((entry) => entry.logs !== first.logs || entry.contract !== first.contract)) return { state: "error", reason: "The two providers report different receipts for this transaction." };
    const receipt = (mined[0] as (typeof mined)[number]).receipt;
    return { state: "ok", blockNumber: BigInt(first.blockNumber), logs: Array.isArray(receipt.logs) ? receipt.logs as RpcLog[] : [], ...(first.contract === "" ? {} : { contractAddress: first.contract }) };
  }

  private async waitForReceipt(record: RuleGatePending): Promise<{ ok: true; blockNumber: bigint; logs: RpcLog[]; contractAddress?: string } | RuleGateFailure> {
    const hash = record.hash;
    if (record.phase !== "submitted" || hash === undefined) return fail("failed", "There is no submitted transaction to wait for.");
    const interval = this.deps.pollIntervalMs ?? RECEIPT_POLL_INTERVAL_MS;
    const timeout = this.deps.timeoutMs ?? RECEIPT_TIMEOUT_MS;
    const started = this.now();
    for (;;) {
      const outcome = await this.checkOnce(record, hash);
      if (outcome.state === "failed") { this.clearPending(record.account); return fail("failed", "The transaction failed on X Layer (status 0). Nothing changed. You can try again.", hash); }
      if (outcome.state === "error") return fail("mismatch", outcome.reason, hash);
      if (outcome.state === "ok") return { ok: true, blockNumber: outcome.blockNumber, logs: outcome.logs, ...(outcome.contractAddress === undefined ? {} : { contractAddress: outcome.contractAddress }) };
      if (this.now() - started >= timeout) return fail("timeout", `Still waiting after ${Math.round(timeout / 60_000)} minutes (${outcome.why.replace(/\.$/, "")}). The transaction may still confirm. It has not been sent again.`, hash);
      await this.sleep(interval);
    }
  }

  private ruleGateLogs(logs: RpcLog[]): RpcLog[] {
    return logs.filter((log) => sameAddress(log.address, this.deps.config.address));
  }

  private async finishOpen(record: RuleGatePending): Promise<OpenResult | RuleGateFailure> {
    const waited = await this.waitForReceipt(record);
    if (!waited.ok) return waited;
    const events: SessionOpenedEvent[] = [];
    for (const log of this.ruleGateLogs(waited.logs)) {
      try { const event = decodeSessionOpenedLog(log); if (sameAddress(event.owner, record.account) && event.circuitId === BigInt(record.circuitId ?? "-1") && event.stateBytes === record.stateBytes) events.push(event); } catch { /* not ours */ }
    }
    if (events.length !== 1) return fail("mismatch", "The confirmed transaction has no matching SessionOpened event from RuleGate.", record.hash);
    this.clearPending(record.account);
    const event = events[0] as SessionOpenedEvent;
    return { ok: true, sessionId: event.sessionId, circuitId: event.circuitId, hash: record.hash as string, blockNumber: waited.blockNumber };
  }

  private async finishStep(record: RuleGatePending): Promise<StepResult | RuleGateFailure> {
    const waited = await this.waitForReceipt(record);
    if (!waited.ok) return waited;
    const events: SteppedEvent[] = [];
    for (const log of this.ruleGateLogs(waited.logs)) {
      try { const event = decodeSteppedLog(log); if (sameAddress(event.caller, record.account) && event.sessionId === BigInt(record.sessionId ?? "-1")) events.push(event); } catch { /* not ours */ }
    }
    if (events.length !== 1) return fail("mismatch", "The confirmed transaction has no matching Stepped event from RuleGate.", record.hash);
    this.clearPending(record.account);
    const event = events[0] as SteppedEvent;
    return { ok: true, sessionId: event.sessionId, step: event.step, inputs: event.inputs, newState: event.newState, outputs: event.outputs, hash: record.hash as string, blockNumber: waited.blockNumber };
  }

  // -- public writes -------------------------------------------------------------------------------------------------

  async openSession(provider: Eip1193Provider, account: string, circuitId: bigint, stateBytes: number, onPhase?: (phase: Phase, hash?: string) => void): Promise<OpenResult | RuleGateFailure> {
    if (this.deps.config.address === null) return fail("not-deployed", "RuleGate is not deployed yet.");
    if (typeof circuitId !== "bigint" || circuitId < 1n || circuitId >= 1n << 64n) return fail("bad-input", "The circuit id is not valid.");
    if (!Number.isInteger(stateBytes) || stateBytes < 1 || stateBytes > MAX_STATE_BYTES) return fail("bad-input", "The state length must be 1 to 32 bytes.");
    const sent = await this.guardedSend(provider, account, "open", { from: account, to: this.deps.config.address, data: encodeOpen(circuitId, stateBytes), value: "0x0" }, { circuitId: circuitId.toString(), stateBytes }, onPhase);
    if (!sent.ok) return sent;
    onPhase?.("waiting", sent.record.hash);
    return this.finishOpen(sent.record);
  }

  async stepSession(provider: Eip1193Provider, account: string, sessionId: bigint, inputs: Uint8Array, onPhase?: (phase: Phase, hash?: string) => void): Promise<StepResult | RuleGateFailure> {
    if (this.deps.config.address === null) return fail("not-deployed", "RuleGate is not deployed yet.");
    if (typeof sessionId !== "bigint" || sessionId < 1n) return fail("bad-input", "The session id is not valid.");
    if (inputs.length < 1 || inputs.length > MAX_INPUT_BYTES) return fail("bad-input", "Inputs must be 1 to 32 bytes.");
    const sent = await this.guardedSend(provider, account, "step", { from: account, to: this.deps.config.address, data: encodeStep(sessionId, inputs), value: "0x0" }, { sessionId: sessionId.toString() }, onPhase);
    if (!sent.ok) return sent;
    onPhase?.("waiting", sent.record.hash);
    return this.finishStep(sent.record);
  }

  /** Follows a transaction that was submitted before a page reload. */
  async resume(account: string, onPhase?: (phase: Phase, hash?: string) => void): Promise<OpenResult | StepResult | RuleGateFailure | undefined> {
    const record = this.pending(account);
    if (record === undefined || record.phase !== "submitted" || record.kind === "deploy") return undefined;
    onPhase?.("waiting", record.hash);
    return record.kind === "open" ? this.finishOpen(record) : this.finishStep(record);
  }

  // -- deployment (owner tool, development builds only) ----------------------------------------------------------------

  /** The creation data: RuleGate bytecode followed by the abi-encoded processor address. */
  deploymentData(): string { return `${ruleGateArtifact.bytecode}${this.deps.config.processor.slice(2).toLowerCase().padStart(64, "0")}`; }

  async deployRuleGate(provider: Eip1193Provider, account: string, onPhase?: (phase: Phase, hash?: string) => void): Promise<DeployResult | RuleGateFailure> {
    const sent = await this.guardedSend(provider, account, "deploy", { from: account, data: this.deploymentData(), value: "0x0" }, {}, onPhase);
    if (!sent.ok) return sent;
    return { ok: true, hash: sent.record.hash as string };
  }

  /** Waits for the deployment receipt on both providers, then checks that the new contract's processor() is the GateX processor on both. */
  async awaitDeployment(hash: string, onPhase?: (phase: Phase, hash?: string) => void): Promise<DeploymentConfirmed | RuleGateFailure> {
    if (!HASH.test(hash)) return fail("bad-input", "That is not a transaction hash.");
    const probe = await this.providers()?.[0]?.client.request("eth_getTransactionByHash", [hash]).catch(() => null);
    const sender = typeof probe === "object" && probe !== null ? (probe as { from?: unknown }).from : undefined;
    const record = isAddress(sender) ? this.pending(sender) : undefined;
    const target: RuleGatePending = record !== undefined && record.hash === lower(hash) && record.kind === "deploy" ? record : { version: 1, phase: "submitted", kind: "deploy", account: isAddress(sender) ? sender : "0x0000000000000000000000000000000000000000", data: this.deploymentData(), hash: lower(hash), sentAt: this.now() };
    onPhase?.("waiting", hash);
    const waited = await this.waitForReceipt(target);
    if (!waited.ok) return waited;
    const address = waited.contractAddress;
    if (address === undefined || !isAddress(address)) return fail("mismatch", "The deployment receipt has no contract address.", hash);
    const checked = await this.both(async (client) => decodeAddressReturn(hexResult(await client.request("eth_call", [{ to: address, data: encodeProcessorCall() }, "latest"]), "processor() result")));
    if (!checked.ok) return fail("mismatch", `The new contract could not be checked: ${checked.reason}`, hash);
    if (checked.values.some((value) => !sameAddress(value, this.deps.config.processor))) return fail("mismatch", "The new contract does not point at the GateX processor. Do not use it.", hash);
    if (isAddress(sender)) this.clearPending(sender);
    return { ok: true, address: lower(address), hash: lower(hash), blockNumber: waited.blockNumber };
  }
}
