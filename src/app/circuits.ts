import { decodeBytesReturn, decodeCircuitInfo } from "../protocol/abi.js";
import { decodeGateDAddress, encodeGateDCall, decodeGateDUint256, hexFromBytes, sha256Hex } from "../protocol/gate-d-abi.js";
import type { ReadOnlyRpcClient } from "../protocol/rpc.js";
import type { ProtocolLock } from "../protocol/types.js";

// Read-only listing of every circuit on the GateX processor. Every circuit is read from both locked providers at one block.
// Circuit ids run from 1 to the highest existing id; processor.nextId() is the counter that gives that range.

export const PAGE_SIZE = 30;
export const MAX_IN_FLIGHT = 4;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface CircuitsDeps {
  lock: ProtocolLock;
  processor: string;
  clients: ReadonlyMap<string, ReadOnlyRpcClient>;
  /** Hex block tag of the common block both providers agreed on. */
  blockTag: string;
}

export interface Dimensions { nIn: number; nOut: number; nState: number; gateCount: number }

export interface CircuitRecord {
  id: string;
  /** Both providers returned identical owner, dimensions and payload. */
  confirmed: boolean;
  /** Why a circuit is unconfirmed. */
  note?: string;
  /** Nothing could be read for this circuit; the fields below are then empty. */
  unreadable?: boolean;
  owner: string;
  dimensions: Dimensions;
  payloadBytes: number;
  /** Lowercase hex without 0x. */
  payloadSha256: string;
  nand?: number;
  latch?: number;
}

interface ProviderRead {
  ok: true;
  owner: string;
  dimensions: Dimensions;
  payloadBytes: number;
  payloadSha256: string;
  nand?: number;
  latch?: number;
}
interface ProviderFailure { ok: false; missing: boolean; message: string }

function asHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`${label} is not hex`);
  return value;
}

function isRevert(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).toLowerCase().includes("revert");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripPrefix(hash: string): string {
  return hash.toLowerCase().replace(/^0x/, "");
}

/** NAND and LATCH counts from a TapeOut payload (NAND record: opcode 0 + 6 bytes, LATCH record: opcode 1 + 3 bytes). Undefined when the bytes are not a clean record stream. */
export function countGates(payload: Uint8Array): { nand: number; latch: number } | undefined {
  let nand = 0;
  let latch = 0;
  let cursor = 0;
  while (cursor < payload.length) {
    const opcode = payload[cursor];
    if (opcode === 0) { nand += 1; cursor += 7; }
    else if (opcode === 1) { latch += 1; cursor += 4; }
    else return undefined;
  }
  return cursor === payload.length ? { nand, latch } : undefined;
}

function client(deps: CircuitsDeps, provider: string): ReadOnlyRpcClient {
  const found = deps.clients.get(provider);
  if (found === undefined) throw new Error(`No locked client for ${provider}`);
  return found;
}

async function call(deps: CircuitsDeps, provider: string, signature: string, args: readonly (string | number | bigint)[] = []): Promise<string> {
  const raw = await client(deps, provider).request("eth_call", [{ to: deps.processor, data: encodeGateDCall(deps.lock, signature, args) }, deps.blockTag]);
  return asHex(raw, signature);
}

async function readFromProvider(deps: CircuitsDeps, provider: string, id: bigint): Promise<ProviderRead | ProviderFailure> {
  try {
    const owner = decodeGateDAddress(await call(deps, provider, "ownerOf(uint256)", [id])).toLowerCase();
    if (owner === ZERO_ADDRESS) return { ok: false, missing: true, message: "no owner" };
    const [infoRaw, netlistRaw] = await Promise.all([call(deps, provider, "circuitInfo(uint256)", [id]), call(deps, provider, "netlist(uint256)", [id])]);
    const info = decodeCircuitInfo(infoRaw);
    const payload = decodeBytesReturn(netlistRaw);
    const gates = countGates(payload);
    const counted = gates !== undefined && gates.nand + gates.latch === info.gateCount ? gates : undefined;
    return { ok: true, owner, dimensions: { nIn: info.nIn, nOut: info.nOut, nState: info.nState, gateCount: info.gateCount }, payloadBytes: payload.length, payloadSha256: stripPrefix(sha256Hex(hexFromBytes(payload))), ...(counted === undefined ? {} : counted) };
  } catch (error) {
    return { ok: false, missing: isRevert(error), message: describe(error) };
  }
}

function fingerprint(read: ProviderRead): string {
  const { owner, dimensions, payloadSha256 } = read;
  return [owner, dimensions.nIn, dimensions.nOut, dimensions.nState, dimensions.gateCount, payloadSha256].join("|");
}

const EMPTY_DIMENSIONS: Dimensions = { nIn: 0, nOut: 0, nState: 0, gateCount: 0 };

/** Reads one circuit from both providers. Undefined means it does not exist on either provider. */
export async function readCircuit(deps: CircuitsDeps, id: bigint): Promise<CircuitRecord | undefined> {
  const providers = deps.lock.snapshot.providers;
  const reads = await Promise.all(providers.map((provider) => readFromProvider(deps, provider, id)));
  const good = reads.filter((read): read is ProviderRead => read.ok);
  const failures = reads.filter((read): read is ProviderFailure => !read.ok);
  const idText = id.toString();
  if (good.length === 0) {
    if (failures.every((failure) => failure.missing)) return undefined;
    return { id: idText, confirmed: false, unreadable: true, note: "This circuit could not be read from the providers.", owner: "", dimensions: EMPTY_DIMENSIONS, payloadBytes: 0, payloadSha256: "" };
  }
  const first = good[0] as ProviderRead;
  const record: CircuitRecord = { id: idText, confirmed: false, owner: first.owner, dimensions: first.dimensions, payloadBytes: first.payloadBytes, payloadSha256: first.payloadSha256, ...(first.nand === undefined || first.latch === undefined ? {} : { nand: first.nand, latch: first.latch }) };
  if (good.length < providers.length) return { ...record, note: failures.some((failure) => failure.missing) ? "One provider reports no such circuit." : "Only one provider answered." };
  if (good.every((read) => fingerprint(read) === fingerprint(first))) return { ...record, confirmed: true };
  return { ...record, note: "The two providers returned different data." };
}

async function exists(deps: CircuitsDeps, id: bigint): Promise<boolean> {
  const answers = await Promise.all(deps.lock.snapshot.providers.map(async (provider) => {
    try { return decodeGateDAddress(await call(deps, provider, "ownerOf(uint256)", [id])).toLowerCase() !== ZERO_ADDRESS; } catch (error) { if (isRevert(error)) return false; throw error; }
  }));
  return answers.some(Boolean);
}

export interface CircuitCount { nextId: bigint; /** Highest circuit id that exists. */ top: bigint }

/** Reads nextId() from both providers (they must agree) and works out the highest existing id, so the list does not depend on whether nextId is the next id to be issued or the last one issued. */
export async function readCircuitCount(deps: CircuitsDeps): Promise<CircuitCount> {
  const values = await Promise.all(deps.lock.snapshot.providers.map(async (provider) => decodeGateDUint256(await call(deps, provider, "nextId()"))));
  const nextId = values[0] as bigint;
  if (values.some((value) => value !== nextId)) throw new Error("The two providers disagree about how many circuits exist.");
  if (nextId > 1_000_000n) throw new Error(`Circuit counter is implausibly large: ${nextId}`);
  if (nextId === 0n) return { nextId, top: 0n };
  return { nextId, top: (await exists(deps, nextId)) ? nextId : nextId - 1n };
}

export interface CircuitsPage { rows: CircuitRecord[]; /** Highest id not yet read; 0 when everything has been read. */ nextCursor: bigint }

/** Reads up to `limit` circuits, newest first, starting at id `cursor`, with at most MAX_IN_FLIGHT circuits being read at a time. */
export async function readCircuitsPage(deps: CircuitsDeps, cursor: bigint, limit = PAGE_SIZE): Promise<CircuitsPage> {
  const ids: bigint[] = [];
  for (let id = cursor; id >= 1n && ids.length < limit; id -= 1n) ids.push(id);
  const rows: CircuitRecord[] = [];
  for (let start = 0; start < ids.length; start += MAX_IN_FLIGHT) {
    const batch = await Promise.all(ids.slice(start, start + MAX_IN_FLIGHT).map((id) => readCircuit(deps, id)));
    for (const record of batch) if (record !== undefined) rows.push(record);
  }
  const lowest = ids[ids.length - 1];
  return { rows, nextCursor: lowest === undefined ? 0n : lowest - 1n };
}

// ---------------------------------------------------------------------------------------------------------------------
// Matching against rules this browser knows. Pure: the caller compiles the sources.

export interface KnownRule {
  name: string;
  source: string;
  /** Lowercase hex without 0x. */
  payloadSha256: string;
  dimensions: Dimensions;
}

export interface CheckResult {
  matches: boolean;
  tone: "green" | "neutral";
  hashesEqual: boolean;
  dimensionsEqual: boolean;
}

function sameDimensions(left: Dimensions, right: Dimensions): boolean {
  return left.nIn === right.nIn && left.nOut === right.nOut && left.nState === right.nState && left.gateCount === right.gateCount;
}

/** Read-only comparison of a compile with a circuit on chain. Equal payload bytes (by SHA-256) and equal declared dimensions mean the same circuit. */
export function checkAgainstCircuit(compiledPayloadSha256: string, onChainPayloadSha256: string, dims: { compiled: Dimensions; onChain: Dimensions }): CheckResult {
  const hashesEqual = compiledPayloadSha256.length > 0 && stripPrefix(compiledPayloadSha256) === stripPrefix(onChainPayloadSha256);
  const dimensionsEqual = sameDimensions(dims.compiled, dims.onChain);
  const matches = hashesEqual && dimensionsEqual;
  return { matches, tone: matches ? "green" : "neutral", hashesEqual, dimensionsEqual };
}

export function checkHeadline(result: CheckResult, circuitId: string): string {
  if (result.matches) return `This rule matches circuit #${circuitId} on X Layer (bytes identical)`;
  if (result.hashesEqual) return `This rule has the same bytes as circuit #${circuitId} but a different declared size, so it does not match`;
  return `This rule does not match circuit #${circuitId}`;
}

/** The known rule whose compile is identical to this circuit, if any. Unconfirmed circuits are never labelled as a match. */
export function matchKnownRule(record: CircuitRecord, known: readonly KnownRule[]): KnownRule | undefined {
  if (!record.confirmed || record.unreadable) return undefined;
  return known.find((rule) => checkAgainstCircuit(rule.payloadSha256, record.payloadSha256, { compiled: rule.dimensions, onChain: record.dimensions }).matches);
}

export function distinctOwners(rows: readonly CircuitRecord[]): number {
  return new Set(rows.filter((row) => row.owner !== "").map((row) => row.owner.toLowerCase())).size;
}
