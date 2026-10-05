import { keccak_256 } from "@noble/hashes/sha3.js";
import { identityTargets } from "./lock.js";
import type { IdentityCheck, ProtocolLock, ProviderVerification, ProviderVerificationSummary } from "./types.js";
import type { ReadOnlyRpcClient } from "./rpc.js";

export class GateCIdentityError extends Error {
  constructor(public readonly code: "CHAIN_ID_MISMATCH" | "BLOCK_MISMATCH" | "RUNTIME_HASH_MISMATCH" | "PROVIDER_DISAGREEMENT", message: string) {
    super(message);
    this.name = "GateCIdentityError";
  }
}

function hexToBytes(value: string): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error(`Expected even-length hex bytes, received ${value}`);
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  return bytes;
}

function hexQuantity(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid block number ${value}`);
  return `0x${value.toString(16)}`;
}

function parseQuantity(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${label} is not a hex quantity`);
  const parsed = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is outside the safe integer range`);
  return parsed;
}

function normalizeHash(value: string): string {
  return value.toLowerCase();
}

export function runtimeKeccak256(code: string): string {
  return `0x${Array.from(keccak_256(hexToBytes(code)), (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is missing`);
  return value;
}

export async function verifyLockedProvider(
  lock: ProtocolLock,
  provider: string,
  client: ReadOnlyRpcClient
): Promise<ProviderVerification> {
  const chainId = parseQuantity(await client.request("eth_chainId", []), `${provider} chain ID`);
  if (chainId !== lock.chainId) throw new GateCIdentityError("CHAIN_ID_MISMATCH", `${provider} returned chain ${chainId}, expected ${lock.chainId}`);

  const blockResult: unknown = await client.request("eth_getBlockByNumber", [hexQuantity(lock.snapshot.blockNumber), false]);
  if (typeof blockResult !== "object" || blockResult === null) throw new Error(`${provider} returned no pinned block`);
  const block = blockResult as Record<string, unknown>;
  const blockNumber = parseQuantity(block.number, `${provider} block number`);
  const blockHash = normalizeHash(requireString(block.hash, `${provider} block hash`));
  if (blockNumber !== lock.snapshot.blockNumber || blockHash !== normalizeHash(lock.snapshot.blockHash)) {
    throw new GateCIdentityError("BLOCK_MISMATCH", `${provider} returned block ${blockNumber}/${blockHash}, expected ${lock.snapshot.blockNumber}/${lock.snapshot.blockHash}`);
  }

  const identities: IdentityCheck[] = [];
  for (const target of identityTargets(lock)) {
    const code = requireString(await client.request("eth_getCode", [target.address, hexQuantity(lock.snapshot.blockNumber)]), `${provider} code for ${target.address}`);
    const observedRuntimeKeccak256 = runtimeKeccak256(code);
    if (normalizeHash(observedRuntimeKeccak256) !== normalizeHash(target.expectedRuntimeKeccak256)) {
      throw new GateCIdentityError(
        "RUNTIME_HASH_MISMATCH",
        `${provider} ${target.key} at ${target.address} returned ${observedRuntimeKeccak256}, expected ${target.expectedRuntimeKeccak256}`
      );
    }
    identities.push({
      key: target.key,
      address: target.address,
      expectedRuntimeKeccak256: target.expectedRuntimeKeccak256,
      observedRuntimeKeccak256
    });
  }
  return { provider, chainId, blockNumber, blockHash, identities };
}

function comparableVerification(report: ProviderVerification): string {
  return JSON.stringify({
    chainId: report.chainId,
    blockNumber: report.blockNumber,
    blockHash: report.blockHash,
    identities: report.identities.map((identity) => [identity.key, identity.address.toLowerCase(), identity.observedRuntimeKeccak256.toLowerCase()])
  });
}

export async function verifyLockedProviders(
  lock: ProtocolLock,
  clients: ReadonlyMap<string, ReadOnlyRpcClient>
): Promise<ProviderVerificationSummary> {
  const reports: ProviderVerification[] = [];
  for (const provider of lock.snapshot.providers) {
    const client = clients.get(provider);
    if (client === undefined) throw new Error(`No read-only RPC client supplied for locked provider ${provider}`);
    reports.push(await verifyLockedProvider(lock, provider, client));
  }
  const baseline = comparableVerification(reports[0] as ProviderVerification);
  for (const report of reports.slice(1)) {
    if (comparableVerification(report) !== baseline) {
      throw new GateCIdentityError("PROVIDER_DISAGREEMENT", `Locked providers disagree: ${reports[0]?.provider} versus ${report.provider}`);
    }
  }
  return {
    providers: reports,
    pinnedBlockNumber: lock.snapshot.blockNumber,
    pinnedBlockHash: lock.snapshot.blockHash
  };
}
