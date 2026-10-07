// Planner and executor for taping out a visitor's own compiled rule from their own wallet.
//
// Everything here is pure logic with injected dependencies (RPC clients, quote reader, storage, clock), so it can be
// tested with fakes. The UI drives it one step at a time. Guarantees:
//   - transactions are built only by the canonical builders in src/protocol/transaction-integrity.ts;
//   - every signature request is preceded by a fresh dual-provider simulation and a fresh quote comparison;
//   - the only addresses ever called are the deployment token (mints) and processor (tapeout);
//   - a step whose hash is recorded as pending (surviving page reloads) is never sent twice;
//   - when anything is uncertain the flow refuses, with a plain-English reason, instead of throwing.
import { encodeInputMask, encodeStateIndex } from "../compiler/encoding.js";
import { interpretAst } from "../compiler/interpreter.js";
import { artifactHash } from "../compiler/serialization.js";
import type { CompiledMachine } from "../compiler/types.js";
import { decodeUint256 } from "../protocol/abi.js";
import type { CanonicalDeployment } from "../protocol/deployment.js";
import { hexFromBytes } from "../protocol/gate-d-abi.js";
import { verifyMintReceipt, verifyTapeoutReceipt } from "../protocol/receipts.js";
import type { ReadOnlyRpcClient } from "../protocol/rpc.js";
import {
  authorizeCanonicalMintTransaction,
  authorizeCanonicalTapeoutTransaction,
  buildCanonicalMintTransaction,
  buildCanonicalTapeoutTransaction,
  type CanonicalMintTransaction,
  type CanonicalTapeoutTransaction,
  type MintApproval,
  type TapeoutApproval
} from "../protocol/transaction-integrity.js";
import type { ProtocolLock } from "../protocol/types.js";
import { extractTapeOutPayload } from "../protocol/wire.js";
import type { CircuitBindingReadback } from "./binding.js";
import { weiToOkb, type CommonReadBlock, type LiveStepResult, type ReadOnlyQuote } from "./protocol.js";
import type { Eip1193Provider } from "./wallet.js";

export const X_LAYER_CHAIN_HEX = "0xc4";
export const NAND_TOKEN_ID = 0n;
export const LATCH_TOKEN_ID = 1n;
export const RECEIPT_POLL_INTERVAL_MS = 2_000;
export const RECEIPT_TIMEOUT_MS = 180_000;
export const CANCELLED_MESSAGE = "Cancelled in wallet. Nothing was sent.";
const PENDING_KEY_PREFIX = "gatex.tapeout.pending.v1";

export type StepKind = "mint-nand" | "mint-latch" | "tapeout";

export type RefusalCode =
  | "no-account" | "bad-account" | "wallet-chain" | "chain" | "providers-disagree" | "quote-unavailable" | "quote-incomplete"
  | "stale-quote" | "limits" | "limits-unavailable" | "payload" | "artifact-mismatch" | "locked-config" | "supply-cap" | "balance"
  | "estimate" | "gas-ceiling" | "changed" | "simulation" | "pending" | "storage" | "wallet" | "target" | "integrity" | "busy" | "step";

export interface Refusal { ok: false; reason: string; code: RefusalCode }

export interface ClientSafetyLimits {
  inputs: number;
  states: number;
  stateBits: number;
  outputs: number;
  topLevelRecords: number;
  coreNetlistBytesMaximum: number;
  provisionalPerArtifactGasCeiling: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TapeoutDeps {
  lock: ProtocolLock;
  deployment: CanonicalDeployment;
  clients: ReadonlyMap<string, ReadOnlyRpcClient>;
  quote(account: string): Promise<ReadOnlyQuote>;
  readBoundCircuit(circuitId: string, expectedPayloadSha256: string, expectedOwner: string): Promise<CircuitBindingReadback>;
  readLiveStep(circuitId: string, state: Uint8Array, inputs: Uint8Array): Promise<LiveStepResult>;
  /** sessionStorage in the browser. Without working storage no transaction is ever sent. */
  storage?: StorageLike;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/** What is needed to verify a manufactured circuit later (also after a reload). */
export interface VerificationTarget {
  account: string;
  payloadSha256: string;
  payloadBytes: number;
  nIn: number;
  nOut: number;
  nState: number;
  gateCount: number;
  compiled: CompiledMachine;
}

interface StepBase {
  kind: StepKind;
  label: string;
  /** Number of transistors bought (mints) or 1 (tapeout). */
  amount: bigint;
  valueWei: bigint;
  gasEstimate: bigint;
  /** True when the gas figure is the locked per-artifact ceiling because the step cannot be estimated until earlier steps are confirmed. */
  gasIsUpperBound: boolean;
}
export interface MintStep extends StepBase { kind: "mint-nand" | "mint-latch"; tokenId: bigint; transaction: CanonicalMintTransaction }
export interface TapeoutStep extends StepBase { kind: "tapeout"; transaction: CanonicalTapeoutTransaction }
export type PlanStep = MintStep | TapeoutStep;

export interface TapeoutPlan {
  ok: true;
  account: string;
  payloadSha256: string;
  payload: Uint8Array;
  nIn: number;
  nOut: number;
  nState: number;
  gateCount: number;
  needNand: bigint;
  needLatch: bigint;
  haveNand: bigint;
  haveLatch: bigint;
  steps: PlanStep[];
  totals: { nandValueWei: bigint; latchValueWei: bigint; tapeoutFeeWei: bigint; valueWei: bigint; estGasWei: bigint; totalWei: bigint };
  quoteBlock: CommonReadBlock;
  quote: ReadOnlyQuote;
  target: VerificationTarget;
}
export type PlanResult = TapeoutPlan | Refusal;

export interface PlanInput {
  compiled: CompiledMachine;
  account?: string;
  /** Chain id reported by the wallet right now, if known. */
  walletChainId?: string;
  /** Refuse unless the quote was read at or after this block (used right after a confirmation). */
  minBlock?: number;
}

export interface PendingRecord {
  version: 1;
  /** "signing": a signature was requested and no hash is known yet. "submitted": the wallet returned a hash. "confirmed": tapeout finished. */
  phase: "signing" | "submitted" | "confirmed";
  kind: StepKind;
  account: string;
  payloadSha256: string;
  hash?: string;
  to: string;
  data: string;
  valueWei: string;
  tokenId?: string;
  amount?: string;
  gateCount?: number;
  nState?: number;
  nonce?: string;
  sentAt: number;
  circuitId?: string;
  blockNumber?: string;
}

export type SimulationResult = { ok: true; gas: bigint; returnValue: string } | Refusal;

export type SendResult =
  | { status: "submitted"; hash: string; record: PendingRecord }
  | { status: "cancelled"; message: string }
  | { status: "refused"; reason: string; code: RefusalCode };

export type ReceiptResult =
  | { ok: true; kind: StepKind; hash: string; blockNumber: bigint; blockHash: string; gasCostWei: bigint; circuitId?: bigint }
  | { ok: false; reason: string; hash: string; final: boolean; timedOut?: boolean };

export interface VerificationResult {
  verified: boolean;
  outcome: "verified" | "mismatch" | "unavailable";
  detail: string;
  readback?: CircuitBindingReadback;
  live?: { local: { nextStateHex: string; outputsHex: string }; chain: { nextStateHex: string; outputsHex: string }; blockNumber: number; match: boolean };
}

// ---------------------------------------------------------------------------------------------------------------------
// small helpers

function refuse(code: RefusalCode, reason: string): Refusal { return { ok: false, code, reason }; }
function lower(value: string): string { return value.toLowerCase(); }
function isAddress(value: unknown): value is string { return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value); }
function normalizeHash(value: string): string { return value.toLowerCase().replace(/^0x/, ""); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function sameAddress(a: string | undefined, b: string | undefined): boolean { return a !== undefined && b !== undefined && lower(a) === lower(b); }
function chainMatches(value: unknown): boolean {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return false;
  return BigInt(value) === BigInt(X_LAYER_CHAIN_HEX);
}
function plural(count: bigint, noun: string): string { return `${count} ${noun}`; }

function parseHexQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${label} is not a hex quantity`);
  return BigInt(value);
}

/** Pulls the node's own message out of the text produced by HttpReadOnlyRpcClient, e.g. "execution reverted: not enough". */
export function describeRpcError(error: unknown): string {
  const text = errorMessage(error);
  const start = text.indexOf("{");
  if (start >= 0) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start));
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as { message?: unknown }).message === "string") return (parsed as { message: string }).message;
    } catch { /* fall through to the raw text */ }
  }
  return text;
}

function errorCode(error: unknown): number | string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

export function isUserRejection(error: unknown): boolean {
  const code = errorCode(error);
  return code === 4001 || code === "4001";
}

function clientsFor(deps: TapeoutDeps): Array<{ provider: string; client: ReadOnlyRpcClient }> | undefined {
  const result: Array<{ provider: string; client: ReadOnlyRpcClient }> = [];
  for (const provider of deps.lock.snapshot.providers) {
    const client = deps.clients.get(provider);
    if (client === undefined) return undefined;
    result.push({ provider, client });
  }
  return result.length >= 2 ? result : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// client safety limits

export function readSafetyLimits(lock: ProtocolLock): ClientSafetyLimits | undefined {
  const raw = lock.clientSafetyLimits;
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const keys = ["inputs", "states", "stateBits", "outputs", "topLevelRecords", "coreNetlistBytesMaximum", "provisionalPerArtifactGasCeiling"] as const;
  const result: Partial<Record<(typeof keys)[number], number>> = {};
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
    result[key] = value;
  }
  return result as ClientSafetyLimits;
}

/** Returns a plain-English reason when the compiled circuit breaks a client safety limit, otherwise undefined. */
export function safetyLimitViolation(lock: ProtocolLock, compiled: CompiledMachine, payloadBytes: number, dimensions: { nIn: number; nOut: number; nState: number; gateCount: number }): { code: "limits" | "limits-unavailable" | "payload"; reason: string } | undefined {
  const limits = readSafetyLimits(lock);
  if (limits === undefined) return { code: "limits-unavailable", reason: "The safety limits for tape-out are missing from the protocol lock, so tape-out is not offered." };
  if (payloadBytes === 0 || dimensions.gateCount === 0) return { code: "payload", reason: "This circuit has no gates, so there is nothing to manufacture." };
  const states = compiled.machine.states.length;
  const checks: Array<[boolean, string]> = [
    [dimensions.nIn > limits.inputs, `This circuit has ${dimensions.nIn} inputs; the limit is ${limits.inputs}.`],
    [states > limits.states, `This circuit has ${states} states; the limit is ${limits.states}.`],
    [dimensions.nState > limits.stateBits, `This circuit needs ${dimensions.nState} state bits; the limit is ${limits.stateBits}.`],
    [dimensions.nOut > limits.outputs, `This circuit has ${dimensions.nOut} outputs; the limit is ${limits.outputs}.`],
    [dimensions.gateCount > limits.topLevelRecords, `This circuit compiles to ${dimensions.gateCount} gate records; the limit is ${limits.topLevelRecords}.`],
    [payloadBytes > limits.coreNetlistBytesMaximum, `The TapeOut payload is ${payloadBytes} bytes; the limit is ${limits.coreNetlistBytesMaximum}.`],
    [compiled.bytes.length > limits.coreNetlistBytesMaximum, `The compiled container is ${compiled.bytes.length} bytes; the limit is ${limits.coreNetlistBytesMaximum}.`]
  ];
  const hit = checks.find(([broken]) => broken);
  return hit === undefined ? undefined : { code: "limits", reason: hit[1] };
}

// ---------------------------------------------------------------------------------------------------------------------
// RPC simulation helpers

interface CallObject { from: string; to: string; data: string; value: string }

function callObject(request: { from?: string; to: string; data: string; value?: string }, account: string): CallObject {
  return { from: account, to: request.to, data: request.data, value: request.value ?? "0x0" };
}

async function bothProviders<T>(deps: TapeoutDeps, run: (client: ReadOnlyRpcClient, provider: string) => Promise<T>): Promise<{ ok: true; values: T[] } | { ok: false; reason: string }> {
  const clients = clientsFor(deps);
  if (clients === undefined) return { ok: false, reason: "Both data providers are required and at least one is not configured." };
  const settled = await Promise.all(clients.map(async ({ provider, client }) => {
    try { return { ok: true as const, value: await run(client, provider) }; } catch (error) { return { ok: false as const, reason: describeRpcError(error), provider }; }
  }));
  const failure = settled.find((entry) => !entry.ok);
  if (failure !== undefined && !failure.ok) return { ok: false, reason: failure.reason };
  return { ok: true, values: settled.map((entry) => (entry as { ok: true; value: T }).value) };
}

async function estimateOnBothProviders(deps: TapeoutDeps, call: CallObject, tag: string): Promise<{ ok: true; gas: bigint } | { ok: false; reason: string }> {
  const result = await bothProviders(deps, async (client) => parseHexQuantity(await client.request("eth_estimateGas", [call, tag]), "gas estimate"));
  if (!result.ok) return result;
  return { ok: true, gas: result.values.reduce((max, value) => value > max ? value : max, 0n) };
}

// ---------------------------------------------------------------------------------------------------------------------
// planning

function approvalForMint(plan: Pick<TapeoutPlan, "account" | "quote">, tokenId: bigint, amount: bigint, token: string): MintApproval {
  return { sender: plan.account, token, id: tokenId, amount, priceWei: plan.quote.mintPriceWei, protocolFeeWei: plan.quote.protocolFeeWei };
}

function approvalForTapeout(plan: Pick<TapeoutPlan, "account" | "quote" | "payload" | "nIn" | "nOut">, processor: string): TapeoutApproval {
  return { sender: plan.account, processor, payload: plan.payload, nIn: plan.nIn, nOut: plan.nOut, feeWei: plan.quote.tapeoutFeeWei };
}

function lockedTokenIds(lock: ProtocolLock): { nand: bigint; latch: bigint } | undefined {
  const acquisition = lock.gateD?.acquisition;
  if (typeof acquisition !== "object" || acquisition === null) return undefined;
  const { nandId, latchId } = acquisition as { nandId?: unknown; latchId?: unknown };
  if (nandId !== 0 || latchId !== 1) return undefined;
  return { nand: NAND_TOKEN_ID, latch: LATCH_TOKEN_ID };
}

function describeQuoteProblem(deps: TapeoutDeps, quote: ReadOnlyQuote, account: string): Refusal | undefined {
  if (quote.chainIds.length < 2 || quote.chainIds.some((chainId) => chainId !== deps.lock.chainId)) return refuse("chain", `The data providers did not both report X Layer (chain ${deps.lock.chainId}), so nothing can be manufactured.`);
  if (!(quote.stateAgreement ?? quote.agreement)) return refuse("providers-disagree", "The two data providers disagree about the current prices or your balances. Refresh in a moment; nothing was sent.");
  if (quote.account === undefined || !sameAddress(quote.account, account)) return refuse("quote-incomplete", "The quote was not read for your connected account. Refresh and try again.");
  if (quote.nandBalance === undefined || quote.latchBalance === undefined || quote.nativeBalanceWei === undefined) return refuse("quote-incomplete", "Your balances could not be read from X Layer. Refresh and try again.");
  return undefined;
}

export async function planTapeout(input: PlanInput, deps: TapeoutDeps): Promise<PlanResult> {
  const { compiled } = input;
  const account = input.account;
  if (account === undefined || account === "") return refuse("no-account", "Connect an OKX wallet to see the exact cost.");
  if (!isAddress(account)) return refuse("bad-account", "The wallet returned an account address GateX does not recognise.");
  if (input.walletChainId !== undefined && !chainMatches(input.walletChainId)) return refuse("wallet-chain", "Your wallet is not on X Layer (chain 196). Switch network to continue.");
  if (!isAddress(deps.deployment.processor) || !isAddress(deps.deployment.token)) return refuse("locked-config", "The deployment addresses are invalid.");
  const ids = lockedTokenIds(deps.lock);
  if (ids === undefined) return refuse("locked-config", "The locked transistor ids do not match the ids GateX reads balances for, so tape-out is not offered.");

  let extracted: Awaited<ReturnType<typeof extractTapeOutPayload>>;
  try { extracted = await extractTapeOutPayload(deps.lock, compiled.bytes); } catch (error) { return refuse("payload", `The TapeOut payload could not be built: ${errorMessage(error)}`); }
  const violation = safetyLimitViolation(deps.lock, compiled, extracted.payload.length, extracted.dimensions);
  if (violation !== undefined) return refuse(violation.code, violation.reason);
  if (extracted.dimensions.gateCount !== compiled.nandCount + compiled.latchCount || extracted.dimensions.gateCount !== compiled.artifact.records.length) return refuse("artifact-mismatch", "The compiled gate counts do not match the payload, so tape-out is not offered.");
  const needNand = BigInt(compiled.nandCount);
  const needLatch = BigInt(compiled.latchCount);

  let quote: ReadOnlyQuote;
  try { quote = await deps.quote(account); } catch (error) { return refuse("quote-unavailable", `X Layer could not be read through both providers: ${describeRpcError(error)}`); }
  const problem = describeQuoteProblem(deps, quote, account);
  if (problem !== undefined) return problem;
  if (input.minBlock !== undefined && quote.block.number < input.minBlock) return refuse("stale-quote", "The providers have not caught up with your last transaction yet.");
  const haveNand = quote.nandBalance as bigint;
  const haveLatch = quote.latchBalance as bigint;
  const nativeBalance = quote.nativeBalanceWei as bigint;

  const deficitNand = needNand > haveNand ? needNand - haveNand : 0n;
  const deficitLatch = needLatch > haveLatch ? needLatch - haveLatch : 0n;
  if (quote.minted + deficitNand + deficitLatch > quote.cap) return refuse("supply-cap", "Not enough transistors left under the supply cap to build this circuit.");

  const nandValueWei = deficitNand > 0n ? deficitNand * quote.mintPriceWei + quote.protocolFeeWei : 0n;
  const latchValueWei = deficitLatch > 0n ? deficitLatch * quote.mintPriceWei + quote.protocolFeeWei : 0n;
  const tapeoutFeeWei = quote.tapeoutFeeWei;
  const valueWei = nandValueWei + latchValueWei + tapeoutFeeWei;
  if (nativeBalance < valueWei) return refuse("balance", `Your wallet holds ${weiToOkb(nativeBalance)} OKB but the protocol charges ${weiToOkb(valueWei)} OKB before gas.`);

  const partial = { account, quote, payload: extracted.payload, nIn: extracted.dimensions.nIn, nOut: extracted.dimensions.nOut };
  const ceiling = BigInt(readSafetyLimits(deps.lock)?.provisionalPerArtifactGasCeiling ?? 0);
  const built: PlanStep[] = [];
  try {
    if (deficitNand > 0n) built.push({ kind: "mint-nand", label: `Buy ${plural(deficitNand, "NAND transistors")}`, amount: deficitNand, tokenId: ids.nand, valueWei: nandValueWei, gasEstimate: 0n, gasIsUpperBound: false, transaction: buildCanonicalMintTransaction(deps.lock, approvalForMint(partial, ids.nand, deficitNand, deps.deployment.token)) });
    if (deficitLatch > 0n) built.push({ kind: "mint-latch", label: `Buy ${plural(deficitLatch, "LATCH transistors")}`, amount: deficitLatch, tokenId: ids.latch, valueWei: latchValueWei, gasEstimate: 0n, gasIsUpperBound: false, transaction: buildCanonicalMintTransaction(deps.lock, approvalForMint(partial, ids.latch, deficitLatch, deps.deployment.token)) });
    built.push({ kind: "tapeout", label: "Manufacture circuit", amount: 1n, valueWei: tapeoutFeeWei, gasEstimate: 0n, gasIsUpperBound: false, transaction: buildCanonicalTapeoutTransaction(deps.lock, approvalForTapeout(partial, deps.deployment.processor)) });
  } catch (error) { return refuse("integrity", `A transaction could not be built safely: ${errorMessage(error)}`); }

  // Gas: mints can be estimated from the current state. Tape-out can only be estimated once its transistors exist, so while mints
  // are still pending it is shown as the locked per-artifact ceiling (an upper bound, never a promise).
  const steps: PlanStep[] = [];
  for (const [index, step] of built.entries()) {
    const estimable = step.kind !== "tapeout" || index === 0;
    if (!estimable) { steps.push({ ...step, gasEstimate: ceiling, gasIsUpperBound: true } as PlanStep); continue; }
    const estimate = await estimateOnBothProviders(deps, callObject(step.transaction.request, account), quote.block.tag);
    if (!estimate.ok) return refuse("estimate", `${step.label} would fail on X Layer: ${estimate.reason}`);
    if (estimate.gas > ceiling) return refuse("gas-ceiling", `${step.label} needs ${estimate.gas} gas, above the safety ceiling of ${ceiling}.`);
    steps.push({ ...step, gasEstimate: estimate.gas } as PlanStep);
  }
  const estGasWei = steps.reduce((total, step) => total + step.gasEstimate * (quote.maxGasPriceWei ?? quote.gasPriceWei), 0n);
  const totalWei = valueWei + estGasWei;
  if (nativeBalance < totalWei) return refuse("balance", `Your wallet holds ${weiToOkb(nativeBalance)} OKB but this needs about ${weiToOkb(totalWei)} OKB including gas.`);

  const target: VerificationTarget = { account, payloadSha256: extracted.payloadHash, payloadBytes: extracted.payload.length, nIn: extracted.dimensions.nIn, nOut: extracted.dimensions.nOut, nState: extracted.dimensions.nState, gateCount: extracted.dimensions.gateCount, compiled };
  return {
    ok: true, account, payloadSha256: extracted.payloadHash, payload: extracted.payload, nIn: extracted.dimensions.nIn, nOut: extracted.dimensions.nOut, nState: extracted.dimensions.nState, gateCount: extracted.dimensions.gateCount,
    needNand, needLatch, haveNand, haveLatch, steps,
    totals: { nandValueWei, latchValueWei, tapeoutFeeWei, valueWei, estGasWei, totalWei },
    quoteBlock: quote.block, quote, target
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// pending-transaction persistence

export function pendingStorageKey(account: string, payloadSha256: string): string {
  return `${PENDING_KEY_PREFIX}:${lower(account)}:${normalizeHash(payloadSha256)}`;
}

function parsePending(raw: string | null): PendingRecord | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Partial<PendingRecord>;
    if (record.version !== 1 || (record.phase !== "signing" && record.phase !== "submitted" && record.phase !== "confirmed")) return undefined;
    if (record.kind !== "mint-nand" && record.kind !== "mint-latch" && record.kind !== "tapeout") return undefined;
    if (!isAddress(record.account) || !isAddress(record.to) || typeof record.data !== "string" || typeof record.valueWei !== "string" || typeof record.payloadSha256 !== "string" || typeof record.sentAt !== "number") return undefined;
    if (record.phase !== "signing" && (typeof record.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(record.hash))) return undefined;
    return record as PendingRecord;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// executor

export class TapeoutExecutor {
  private readonly busy = new Set<string>();
  constructor(private readonly deps: TapeoutDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private sleep(ms: number): Promise<void> { return (this.deps.sleep ?? ((delay) => new Promise<void>((resolve) => setTimeout(resolve, delay))))(ms); }

  plan(input: PlanInput): Promise<PlanResult> { return planTapeout(input, this.deps); }

  /** Re-plans after a confirmation, waiting (bounded) until the providers have caught up with the confirmed block. */
  async planAfter(input: PlanInput, minBlock: number, attempts = 20): Promise<PlanResult> {
    let last: PlanResult = refuse("stale-quote", "The providers have not caught up with your last transaction yet.");
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      last = await planTapeout({ ...input, minBlock }, this.deps);
      if (last.ok || last.code !== "stale-quote") return last;
      await this.sleep(this.deps.pollIntervalMs ?? RECEIPT_POLL_INTERVAL_MS);
    }
    return last;
  }

  // -- pending records -------------------------------------------------------------------------------------------

  pending(account: string, payloadSha256: string): PendingRecord | undefined {
    try { return parsePending(this.deps.storage?.getItem(pendingStorageKey(account, payloadSha256)) ?? null); } catch { return undefined; }
  }

  private writePending(record: PendingRecord): boolean {
    try {
      const key = pendingStorageKey(record.account, record.payloadSha256);
      this.deps.storage?.setItem(key, JSON.stringify(record));
      return this.deps.storage !== undefined && this.deps.storage.getItem(key) === JSON.stringify(record);
    } catch { return false; }
  }

  private clearPending(account: string, payloadSha256: string): void {
    try { this.deps.storage?.removeItem(pendingStorageKey(account, payloadSha256)); } catch { /* nothing to do */ }
  }

  /** The user chose to start over after a finished tape-out ("Manufacture another copy"). */
  clearConfirmed(account: string, payloadSha256: string): void {
    if (this.pending(account, payloadSha256)?.phase === "confirmed") this.clearPending(account, payloadSha256);
  }

  /** The user asserts that an interrupted signature request produced no transaction. Only the "signing" phase can be discarded this way. */
  discardInterruptedSigning(account: string, payloadSha256: string): boolean {
    if (this.pending(account, payloadSha256)?.phase !== "signing") return false;
    this.clearPending(account, payloadSha256);
    return true;
  }

  /**
   * Releases a submitted hash only when both providers have never heard of it AND the account's nonce has moved past the nonce
   * the plan was built at (so the transaction slot was consumed by something else). Anything less keeps the record.
   */
  async releaseDroppedPending(account: string, payloadSha256: string): Promise<{ released: boolean; reason: string }> {
    const record = this.pending(account, payloadSha256);
    if (record === undefined || record.phase !== "submitted" || record.hash === undefined) return { released: false, reason: "There is no submitted transaction to release." };
    if (record.nonce === undefined) return { released: false, reason: "The nonce for this transaction was not recorded, so GateX cannot prove it was dropped." };
    const recordedNonce = BigInt(record.nonce);
    const hash = record.hash;
    const result = await bothProviders(this.deps, async (client) => {
      const [transaction, count] = await Promise.all([client.request("eth_getTransactionByHash", [hash]), client.request("eth_getTransactionCount", [account, "latest"])]);
      return { known: transaction !== null && transaction !== undefined, count: parseHexQuantity(count, "nonce") };
    });
    if (!result.ok) return { released: false, reason: `Could not check both providers: ${result.reason}` };
    if (result.values.some((value) => value.known)) return { released: false, reason: "A provider still knows this transaction. Keep waiting." };
    if (result.values.some((value) => value.count <= recordedNonce)) return { released: false, reason: "Your account nonce has not moved past this transaction, so it may still be in a mempool. Keep waiting." };
    this.clearPending(account, payloadSha256);
    return { released: true, reason: "The transaction was dropped and its slot reused. You can build a fresh plan." };
  }

  // -- simulation --------------------------------------------------------------------------------------------------

  /** Dual-provider eth_call + eth_estimateGas from the visitor's account at the plan block and at the current head, plus a fresh quote comparison. */
  async simulateStep(plan: TapeoutPlan, step: PlanStep): Promise<SimulationResult> {
    const limits = readSafetyLimits(this.deps.lock);
    if (limits === undefined) return refuse("limits-unavailable", "The safety limits are missing from the protocol lock.");
    const call = callObject(step.transaction.request, plan.account);
    const results: Array<{ tag: string; returns: string[]; gas: bigint[] }> = [];
    for (const tag of [plan.quoteBlock.tag, "latest"]) {
      const calls = await bothProviders(this.deps, async (client) => {
        const returnValue = await client.request("eth_call", [call, tag]);
        const gas = parseHexQuantity(await client.request("eth_estimateGas", [call, tag]), "gas estimate");
        if (typeof returnValue !== "string" || !/^0x[0-9a-fA-F]*$/.test(returnValue)) throw new Error("eth_call result is not hex bytes");
        return { returnValue, gas };
      });
      if (!calls.ok) return refuse("simulation", `${step.label} would fail on X Layer: ${calls.reason}`);
      results.push({ tag, returns: calls.values.map((value) => value.returnValue), gas: calls.values.map((value) => value.gas) });
    }
    let returnValue = "0x";
    for (const result of results) {
      if (new Set(result.returns).size !== 1) return refuse("providers-disagree", "The two data providers returned different simulation results. Nothing was sent.");
      returnValue = result.returns[0] as string;
      if (step.kind === "tapeout") {
        try { decodeUint256(returnValue); } catch { return refuse("simulation", "The tape-out simulation did not return a circuit id."); }
      } else if (returnValue !== "0x") return refuse("simulation", "The mint simulation returned unexpected data.");
    }
    const gas = results.flatMap((result) => result.gas).reduce((max, value) => value > max ? value : max, 0n);
    if (gas > BigInt(limits.provisionalPerArtifactGasCeiling)) return refuse("gas-ceiling", `${step.label} needs ${gas} gas, above the safety ceiling of ${limits.provisionalPerArtifactGasCeiling}.`);

    let fresh: ReadOnlyQuote;
    try { fresh = await this.deps.quote(plan.account); } catch (error) { return refuse("quote-unavailable", `X Layer could not be re-read just before signing: ${describeRpcError(error)}`); }
    const problem = describeQuoteProblem(this.deps, fresh, plan.account);
    if (problem !== undefined) return problem;
    const before = plan.quote;
    const unchanged = fresh.mintPriceWei === before.mintPriceWei && fresh.protocolFeeWei === before.protocolFeeWei && fresh.tapeoutFeeWei === before.tapeoutFeeWei
      && fresh.nandBalance === before.nandBalance && fresh.latchBalance === before.latchBalance && fresh.cap === before.cap && fresh.block.number >= before.block.number;
    if (!unchanged) return refuse("changed", "Prices or your balances changed on X Layer since this plan was built. Refresh the plan; nothing was sent.");
    if (fresh.minted + (plan.steps.filter((candidate) => candidate.kind !== "tapeout").reduce((total, candidate) => total + candidate.amount, 0n)) > fresh.cap) return refuse("supply-cap", "Not enough transistors left under the supply cap to build this circuit.");
    return { ok: true, gas, returnValue };
  }

  // -- sending -----------------------------------------------------------------------------------------------------

  /**
   * Runs every guard, then requests exactly one signature for the first remaining step of the plan.
   * `onPhase("checking")` fires before the simulation, `onPhase("confirm")` right before the wallet prompt.
   */
  async sendStep(provider: Eip1193Provider, plan: TapeoutPlan, step: PlanStep, onPhase?: (phase: "checking" | "confirm") => void): Promise<SendResult> {
    const deny = (code: RefusalCode, reason: string): SendResult => ({ status: "refused", code, reason });
    const first = plan.steps[0];
    if (first === undefined || first !== step) return deny("step", "Only the next step of the plan can be sent. Refresh the plan.");
    if (!isAddress(plan.account)) return deny("bad-account", "The plan has no valid account.");
    const key = pendingStorageKey(plan.account, plan.payloadSha256);
    if (this.busy.has(key)) return deny("busy", "A step is already being processed. Nothing was sent twice.");
    this.busy.add(key);
    try {
      const existing = this.pending(plan.account, plan.payloadSha256);
      if (existing !== undefined) return deny("pending", existing.phase === "confirmed" ? "This circuit was already manufactured in this session. Start over to manufacture another copy." : existing.phase === "signing" ? "A previous signature request was interrupted and may have been sent. Check your wallet activity before continuing." : "A transaction for this circuit is already waiting for confirmation. It will not be sent again.");
      if (this.deps.storage === undefined) return deny("storage", "Browser storage is unavailable, so GateX cannot protect against sending a step twice. Nothing was sent.");

      // Re-derive what must be signed from the plan's own numbers and require the built transaction to match it exactly.
      const { deployment, lock } = this.deps;
      let request: Readonly<{ from?: string; to: string; data: string; value?: string }>;
      let expectedTarget: string;
      try {
        if (step.kind === "tapeout") {
          if ((await artifactHash(plan.payload)) !== plan.payloadSha256) return deny("integrity", "The payload to manufacture no longer matches your compile.");
          request = authorizeCanonicalTapeoutTransaction(lock, step.transaction, approvalForTapeout(plan, deployment.processor));
          expectedTarget = deployment.processor;
        } else {
          const tokenId = step.kind === "mint-nand" ? NAND_TOKEN_ID : LATCH_TOKEN_ID;
          if (step.tokenId !== tokenId) return deny("integrity", "The transistor id in this step is not the locked id.");
          request = authorizeCanonicalMintTransaction(lock, step.transaction, approvalForMint(plan, tokenId, step.amount, deployment.token));
          expectedTarget = deployment.token;
        }
      } catch (error) { return deny("integrity", `The transaction failed its integrity check: ${errorMessage(error)}`); }
      if (!sameAddress(request.to, expectedTarget) || !sameAddress(request.from, plan.account) || request.value === undefined) return deny("target", "The transaction target or sender is not the expected one. Nothing was sent.");

      onPhase?.("checking");
      const simulation = await this.simulateStep(plan, step);
      if (!simulation.ok) return deny(simulation.code, simulation.reason);

      let chainId: unknown;
      let accounts: unknown;
      try {
        chainId = await provider.request({ method: "eth_chainId" });
        accounts = await provider.request({ method: "eth_accounts" });
      } catch (error) { return deny("wallet", `The wallet could not be read: ${errorMessage(error)}`); }
      if (!chainMatches(chainId)) return deny("wallet-chain", "Your wallet is not on X Layer (chain 196). Switch network and try again.");
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !sameAddress(accounts[0], plan.account)) return deny("wallet", "The wallet's active account is not the account this plan was made for. Refresh the plan.");

      const record: PendingRecord = { version: 1, phase: "signing", kind: step.kind, account: plan.account, payloadSha256: plan.payloadSha256, to: request.to, data: request.data, valueWei: BigInt(request.value).toString(), tokenId: step.kind === "tapeout" ? undefined : step.tokenId.toString(), amount: step.amount.toString(), gateCount: step.kind === "tapeout" ? plan.gateCount : undefined, nState: step.kind === "tapeout" ? plan.nState : undefined, nonce: plan.quote.nonce?.toString(), sentAt: this.now() };
      if (!this.writePending(record)) return deny("storage", "Browser storage is unavailable, so GateX cannot protect against sending a step twice. Nothing was sent.");

      onPhase?.("confirm");
      let hash: unknown;
      try {
        hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: request.from, to: request.to, data: request.data, value: request.value }] });
      } catch (error) {
        this.clearPending(plan.account, plan.payloadSha256);
        if (isUserRejection(error)) return { status: "cancelled", message: CANCELLED_MESSAGE };
        return deny("wallet", `The wallet did not send the transaction: ${errorMessage(error)}`);
      }
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        // The wallet claims success but returned nothing usable: the outcome is unknown, so the marker stays and blocks a second send.
        return deny("wallet", "The wallet returned no transaction hash. Check your wallet activity; GateX will not send this step again until you do.");
      }
      const submitted: PendingRecord = { ...record, phase: "submitted", hash: hash.toLowerCase() };
      this.writePending(submitted);
      return { status: "submitted", hash: submitted.hash as string, record: submitted };
    } finally {
      this.busy.delete(key);
    }
  }

  // -- receipts ----------------------------------------------------------------------------------------------------

  async awaitReceipt(record: PendingRecord): Promise<ReceiptResult> {
    const hash = record.hash;
    if (record.phase !== "submitted" || hash === undefined) return { ok: false, reason: "There is no submitted transaction to wait for.", hash: hash ?? "", final: false };
    const interval = this.deps.pollIntervalMs ?? RECEIPT_POLL_INTERVAL_MS;
    const timeout = this.deps.timeoutMs ?? RECEIPT_TIMEOUT_MS;
    const started = this.now();
    let waitingFor = "Waiting for confirmation.";
    for (;;) {
      const outcome = await this.checkReceiptOnce(record, hash);
      if (outcome.done) return outcome.result;
      waitingFor = outcome.waiting;
      if (this.now() - started >= timeout) return { ok: false, hash, final: false, timedOut: true, reason: `Still waiting after ${Math.round(timeout / 60_000)} minutes (${waitingFor.replace(/\.$/, "")}). The transaction may still confirm. It has not been sent again.` };
      await this.sleep(interval);
    }
  }

  private async checkReceiptOnce(record: PendingRecord, hash: string): Promise<{ done: true; result: ReceiptResult } | { done: false; waiting: string }> {
    const providers = clientsFor(this.deps);
    if (providers === undefined) return { done: true, result: { ok: false, hash, final: false, reason: "Both data providers are required to confirm a transaction." } };
    const fetched = await Promise.all(providers.map(async ({ provider, client }) => {
      try {
        const receipt = await client.request("eth_getTransactionReceipt", [hash]);
        if (receipt === null || receipt === undefined) return { provider, state: "none" as const };
        const [transaction, head] = await Promise.all([client.request("eth_getTransactionByHash", [hash]), client.request("eth_blockNumber", [])]);
        const status = typeof receipt === "object" ? (receipt as { status?: unknown }).status : undefined;
        if (typeof status === "string" && status.toLowerCase() !== "0x1") return { provider, state: "failed" as const };
        return { provider, state: "mined" as const, receipt, transaction, head };
      } catch { return { provider, state: "none" as const }; }
    }));
    if (fetched.every((entry) => entry.state === "failed")) {
      this.clearPending(record.account, record.payloadSha256);
      return { done: true, result: { ok: false, hash, final: true, reason: "The transaction failed on X Layer (status 0). Nothing was bought or built by it. You can refresh and try again." } };
    }
    if (fetched.some((entry) => entry.state === "failed")) return { done: false, waiting: "The two providers disagree about whether it succeeded." };
    if (fetched.some((entry) => entry.state === "none")) return { done: false, waiting: "Not yet seen by both providers." };

    const verifications: Array<{ blockNumber: bigint; blockHash: string; gasCostWei: bigint; circuitId?: bigint }> = [];
    for (const entry of fetched) {
      if (entry.state !== "mined") continue;
      try {
        if (record.kind === "tapeout") {
          const checked = verifyTapeoutReceipt(this.deps.lock, entry.provider, entry.receipt, entry.transaction, entry.head, { transactionHash: hash, sender: record.account, processor: this.deps.deployment.processor, data: record.data, valueWei: BigInt(record.valueWei), gateCount: record.gateCount ?? -1, nState: record.nState ?? -1 });
          verifications.push({ blockNumber: checked.blockNumber, blockHash: checked.blockHash, gasCostWei: checked.actualGasCostWei, circuitId: checked.tapedOut.circuitId });
        } else {
          const checked = verifyMintReceipt(this.deps.lock, entry.provider, entry.receipt, entry.transaction, entry.head, { transactionHash: hash, sender: record.account, token: this.deps.deployment.token, data: record.data, valueWei: BigInt(record.valueWei), id: BigInt(record.tokenId ?? "-1"), amount: BigInt(record.amount ?? "-1") });
          verifications.push({ blockNumber: checked.blockNumber, blockHash: checked.blockHash, gasCostWei: checked.actualGasCostWei });
        }
      } catch (error) {
        const message = errorMessage(error);
        if (/only \d+ confirmations/.test(message)) return { done: false, waiting: "Mined; waiting for one more block on both providers." };
        return { done: true, result: { ok: false, hash, final: false, reason: `The receipt did not match the transaction GateX sent: ${message}` } };
      }
    }
    const [firstResult] = verifications;
    if (firstResult === undefined) return { done: false, waiting: "Waiting for receipts." };
    if (verifications.some((value) => value.blockHash !== firstResult.blockHash || value.blockNumber !== firstResult.blockNumber)) return { done: true, result: { ok: false, hash, final: false, reason: "The two providers report different blocks for this transaction. GateX will not continue until they agree." } };
    if (verifications.some((value) => value.circuitId !== firstResult.circuitId)) return { done: true, result: { ok: false, hash, final: false, reason: "The two providers report different circuit ids for this transaction." } };

    if (record.kind === "tapeout") this.writePending({ ...record, phase: "confirmed", circuitId: firstResult.circuitId?.toString(), blockNumber: firstResult.blockNumber.toString() });
    else this.clearPending(record.account, record.payloadSha256);
    return { done: true, result: { ok: true, kind: record.kind, hash, blockNumber: firstResult.blockNumber, blockHash: firstResult.blockHash, gasCostWei: firstResult.gasCostWei, circuitId: firstResult.circuitId } };
  }

  // -- verification ------------------------------------------------------------------------------------------------

  verifyNewCircuit(circuitId: string | bigint, target: VerificationTarget): Promise<VerificationResult> { return verifyNewCircuit(circuitId, target, this.deps); }
}

// ---------------------------------------------------------------------------------------------------------------------
// verification of a freshly manufactured circuit

/**
 * Byte-hash equality between the payload read back from X Layer and the local payload is the proof. One live transition
 * (initial state, all inputs 0) is then compared as a sanity check of the evaluation path.
 */
export async function verifyNewCircuit(circuitId: string | bigint, target: VerificationTarget, deps: Pick<TapeoutDeps, "readBoundCircuit" | "readLiveStep">): Promise<VerificationResult> {
  const id = circuitId.toString();
  let readback: CircuitBindingReadback;
  try { readback = await deps.readBoundCircuit(id, target.payloadSha256, target.account); } catch (error) {
    return { verified: false, outcome: "unavailable", detail: `Verification could not complete: ${describeRpcError(error)}` };
  }
  if (readback.status === "unavailable") return { verified: false, outcome: "unavailable", detail: readback.detail ?? "Verification could not complete.", readback };
  const dimensionsMatch = readback.nIn === target.nIn && readback.nOut === target.nOut && readback.nState === target.nState && readback.gateCount === target.gateCount && readback.payloadBytes === target.payloadBytes;
  if (normalizeHash(readback.payloadSha256) !== normalizeHash(target.payloadSha256)) return { verified: false, outcome: "mismatch", detail: "The bytes on chain do not match your compile.", readback };
  if (!sameAddress(readback.owner, target.account)) return { verified: false, outcome: "mismatch", detail: "The circuit on chain is not owned by your account.", readback };
  if (readback.status !== "ready") return { verified: false, outcome: "mismatch", detail: readback.detail ?? "The circuit readback did not match the expected processor, owner or payload.", readback };
  if (!dimensionsMatch) return { verified: false, outcome: "mismatch", detail: "The circuit's dimensions on chain do not match your compile.", readback };

  const machine = target.compiled.machine;
  const initialIndex = machine.stateIndex.get(machine.initialState);
  if (initialIndex === undefined) return { verified: false, outcome: "mismatch", detail: "The initial state of this machine could not be determined.", readback };
  let local: ReturnType<typeof interpretAst>;
  const stateBytes = encodeStateIndex(initialIndex, machine.stateBits);
  const inputBytes = encodeInputMask(0, machine.inputs.length);
  try { local = interpretAst(machine, stateBytes, inputBytes); } catch (error) { return { verified: false, outcome: "mismatch", detail: `The local transition could not be computed: ${errorMessage(error)}`, readback }; }
  let live: LiveStepResult;
  try { live = await deps.readLiveStep(id, stateBytes, inputBytes); } catch (error) {
    return { verified: false, outcome: "unavailable", detail: `The bytes match, but the live transition could not be read: ${describeRpcError(error)}`, readback };
  }
  const localView = { nextStateHex: hexFromBytes(local.nextStateBytes), outputsHex: hexFromBytes(local.outputBytes) };
  const chainView = { nextStateHex: hexFromBytes(live.nextState), outputsHex: hexFromBytes(live.outputs) };
  const match = live.mismatches.length === 0 && localView.nextStateHex === chainView.nextStateHex && localView.outputsHex === chainView.outputsHex;
  const liveDetail = { local: localView, chain: chainView, blockNumber: live.block.number, match };
  if (!match) return { verified: false, outcome: "mismatch", detail: live.mismatches.length > 0 ? `The providers disagree on the live transition: ${live.mismatches.join("; ")}` : "The live transition on chain differs from your compile.", readback, live: liveDetail };
  return { verified: true, outcome: "verified", detail: `The bytes on chain match your compile, and one live transition agrees at block ${live.block.number}.`, readback, live: liveDetail };
}

// ---------------------------------------------------------------------------------------------------------------------
// wallet network switch (only ever called from a click)

export const X_LAYER_ADD_CHAIN_PARAMS = Object.freeze({
  chainId: X_LAYER_CHAIN_HEX,
  chainName: "X Layer",
  nativeCurrency: Object.freeze({ name: "OKB", symbol: "OKB", decimals: 18 }),
  rpcUrls: Object.freeze(["https://rpc.xlayer.tech"]),
  blockExplorerUrls: Object.freeze(["https://www.oklink.com/xlayer"])
});

export async function switchToXLayer(provider: Eip1193Provider): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: X_LAYER_CHAIN_HEX }] });
    return { ok: true };
  } catch (error) {
    if (isUserRejection(error)) return { ok: false, reason: "Network switch cancelled in wallet." };
    if (errorCode(error) !== 4902) return { ok: false, reason: `The wallet could not switch networks: ${errorMessage(error)}` };
  }
  try {
    await provider.request({ method: "wallet_addEthereumChain", params: [{ ...X_LAYER_ADD_CHAIN_PARAMS, nativeCurrency: { ...X_LAYER_ADD_CHAIN_PARAMS.nativeCurrency }, rpcUrls: [...X_LAYER_ADD_CHAIN_PARAMS.rpcUrls], blockExplorerUrls: [...X_LAYER_ADD_CHAIN_PARAMS.blockExplorerUrls] }] });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: isUserRejection(error) ? "Adding X Layer was cancelled in wallet." : `The wallet could not add X Layer: ${errorMessage(error)}` };
  }
}
