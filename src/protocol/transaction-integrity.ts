import { decodeCreateCpuCall, encodeGateDCall, sha256Hex } from "./gate-d-abi.js";
import type { GateDCall } from "./gate-d.js";
import type { DecodedCreateCpuArguments } from "./gate-d-abi.js";
import type { ProtocolLock } from "./types.js";

export const CREATE_CPU_SIGNATURE = "createCPU(string,string,string,uint256,uint256)" as const;

export interface CreateCpuApproval {
  sender: string;
  name: string;
  symbol: string;
  story: string;
  cap: bigint;
  priceWei: bigint;
  feeWei: bigint;
}

export interface CanonicalCreateCpuTransaction {
  method: typeof CREATE_CPU_SIGNATURE;
  request: Readonly<GateDCall>;
  preview: Readonly<DecodedCreateCpuArguments>;
  calldataSha256: string;
}

export class TransactionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionIntegrityError";
  }
}

function quantity(value: bigint): string {
  if (value < 0n) throw new TransactionIntegrityError(`Negative transaction value: ${value}`);
  return `0x${value.toString(16)}`;
}

function normalizeAddress(value: string): string {
  return value.toLowerCase();
}

function equalArguments(actual: DecodedCreateCpuArguments, expected: CreateCpuApproval): string | undefined {
  const fields: Array<keyof Pick<DecodedCreateCpuArguments, "name" | "symbol" | "story">> = ["name", "symbol", "story"];
  for (const field of fields) {
    if (actual[field] !== expected[field]) return `${field} mismatch: ${JSON.stringify(actual[field])} != ${JSON.stringify(expected[field])}`;
  }
  if (actual.cap !== expected.cap) return `cap mismatch: ${actual.cap} != ${expected.cap}`;
  if (actual.priceWei !== expected.priceWei) return `priceWei mismatch: ${actual.priceWei} != ${expected.priceWei}`;
  return undefined;
}

export function buildCanonicalCreateCpuTransaction(lock: ProtocolLock, approval: CreateCpuApproval): CanonicalCreateCpuTransaction {
  const data = encodeGateDCall(lock, CREATE_CPU_SIGNATURE, [approval.name, approval.symbol, approval.story, approval.cap, approval.priceWei]);
  const request: Readonly<GateDCall> = Object.freeze({
    from: approval.sender,
    to: lock.factory.proxy,
    data,
    value: quantity(approval.feeWei)
  });
  const preview = decodeCreateCpuCall(lock, request.data);
  const transaction: CanonicalCreateCpuTransaction = {
    method: CREATE_CPU_SIGNATURE,
    request,
    preview: Object.freeze(preview),
    calldataSha256: sha256Hex(request.data)
  };
  const frozen = Object.freeze(transaction);
  validateCanonicalCreateCpuTransaction(lock, frozen, approval);
  return frozen;
}

export function validateCanonicalCreateCpuTransaction(lock: ProtocolLock, transaction: CanonicalCreateCpuTransaction, approval: CreateCpuApproval): void {
  if (transaction.method !== CREATE_CPU_SIGNATURE) throw new TransactionIntegrityError("Unexpected createCPU method");
  if (normalizeAddress(transaction.request.from ?? "") !== normalizeAddress(approval.sender)) throw new TransactionIntegrityError("createCPU sender mismatch");
  if (normalizeAddress(transaction.request.to) !== normalizeAddress(lock.factory.proxy)) throw new TransactionIntegrityError("createCPU target mismatch");
  if (transaction.request.value !== quantity(approval.feeWei)) throw new TransactionIntegrityError("createCPU value mismatch");

  const decoded = decodeCreateCpuCall(lock, transaction.request.data);
  const expectedHash = sha256Hex(transaction.request.data);
  if (transaction.calldataSha256 !== expectedHash) throw new TransactionIntegrityError(`calldata hash mismatch: ${transaction.calldataSha256} != ${expectedHash}`);
  const argumentMismatch = equalArguments(decoded, approval);
  if (argumentMismatch !== undefined) throw new TransactionIntegrityError(`createCPU ${argumentMismatch}`);
  const previewMismatch = equalArguments(transaction.preview, approval);
  if (previewMismatch !== undefined) throw new TransactionIntegrityError(`createCPU preview ${previewMismatch}`);
}

export function authorizeCanonicalCreateCpuTransaction(lock: ProtocolLock, transaction: CanonicalCreateCpuTransaction, approval: CreateCpuApproval): Readonly<GateDCall> {
  validateCanonicalCreateCpuTransaction(lock, transaction, approval);
  return transaction.request;
}
