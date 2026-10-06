import { decodeCreateCpuCall, decodeMintCall, decodeTapeoutCall, encodeGateDCall, hexFromBytes, sha256Hex } from "./gate-d-abi.js";
import type { GateDCall } from "./gate-d.js";
import type { DecodedCreateCpuArguments } from "./gate-d-abi.js";
import type { ProtocolLock } from "./types.js";

export const CREATE_CPU_SIGNATURE = "createCPU(string,string,string,uint256,uint256)" as const;
export const MINT_SIGNATURE = "mint(uint256,uint256)" as const;
export const TAPEOUT_SIGNATURE = "tapeout(bytes,uint32,uint32)" as const;

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

export interface MintApproval {
  sender: string;
  token: string;
  id: bigint;
  amount: bigint;
  priceWei: bigint;
  protocolFeeWei: bigint;
}

export interface CanonicalMintTransaction {
  method: typeof MINT_SIGNATURE;
  request: Readonly<GateDCall>;
  preview: Readonly<{ id: bigint; amount: bigint }>;
  calldataSha256: string;
  assetCostWei: bigint;
  fixedFeeWei: bigint;
}

export interface TapeoutApproval {
  sender: string;
  processor: string;
  payload: Uint8Array;
  nIn: number;
  nOut: number;
  feeWei: bigint;
}

export interface CanonicalTapeoutTransaction {
  method: typeof TAPEOUT_SIGNATURE;
  request: Readonly<GateDCall>;
  preview: Readonly<{ payloadHex: string; payloadBytes: number; nIn: number; nOut: number }>;
  calldataSha256: string;
  feeWei: bigint;
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

export function buildCanonicalMintTransaction(lock: ProtocolLock, approval: MintApproval): CanonicalMintTransaction {
  if (approval.amount <= 0n) throw new TransactionIntegrityError("Mint amount must be positive");
  const data = encodeGateDCall(lock, MINT_SIGNATURE, [approval.id, approval.amount]);
  const valueWei = approval.amount * approval.priceWei + approval.protocolFeeWei;
  const request: Readonly<GateDCall> = Object.freeze({ from: approval.sender, to: approval.token, data, value: quantity(valueWei) });
  const preview = Object.freeze(decodeMintCall(lock, data));
  const transaction: CanonicalMintTransaction = Object.freeze({ method: MINT_SIGNATURE, request, preview, calldataSha256: sha256Hex(data), assetCostWei: approval.amount * approval.priceWei, fixedFeeWei: approval.protocolFeeWei });
  validateCanonicalMintTransaction(lock, transaction, approval);
  return transaction;
}

export function validateCanonicalMintTransaction(lock: ProtocolLock, transaction: CanonicalMintTransaction, approval: MintApproval): void {
  if (transaction.method !== MINT_SIGNATURE) throw new TransactionIntegrityError("Unexpected mint method");
  if (normalizeAddress(transaction.request.from ?? "") !== normalizeAddress(approval.sender)) throw new TransactionIntegrityError("mint sender mismatch");
  if (normalizeAddress(transaction.request.to) !== normalizeAddress(approval.token)) throw new TransactionIntegrityError("mint target mismatch");
  const decoded = decodeMintCall(lock, transaction.request.data);
  if (decoded.id !== approval.id || decoded.amount !== approval.amount) throw new TransactionIntegrityError("mint arguments mismatch");
  if (transaction.preview.id !== approval.id || transaction.preview.amount !== approval.amount) throw new TransactionIntegrityError("mint preview mismatch");
  const expectedValue = approval.amount * approval.priceWei + approval.protocolFeeWei;
  if (transaction.request.value !== quantity(expectedValue)) throw new TransactionIntegrityError("mint value mismatch");
  if (transaction.assetCostWei !== approval.amount * approval.priceWei || transaction.fixedFeeWei !== approval.protocolFeeWei) throw new TransactionIntegrityError("mint cost preview mismatch");
  if (transaction.calldataSha256 !== sha256Hex(transaction.request.data)) throw new TransactionIntegrityError("mint calldata hash mismatch");
}

export function authorizeCanonicalMintTransaction(lock: ProtocolLock, transaction: CanonicalMintTransaction, approval: MintApproval): Readonly<GateDCall> {
  validateCanonicalMintTransaction(lock, transaction, approval);
  return transaction.request;
}

export function buildCanonicalTapeoutTransaction(lock: ProtocolLock, approval: TapeoutApproval): CanonicalTapeoutTransaction {
  if (approval.payload.length === 0) throw new TransactionIntegrityError("Tapeout payload must not be empty");
  if (!Number.isSafeInteger(approval.nIn) || !Number.isSafeInteger(approval.nOut) || approval.nIn < 0 || approval.nOut < 0) throw new TransactionIntegrityError("Tapeout dimensions are invalid");
  const data = encodeGateDCall(lock, TAPEOUT_SIGNATURE, [approval.payload, approval.nIn, approval.nOut]);
  const request: Readonly<GateDCall> = Object.freeze({ from: approval.sender, to: approval.processor, data, value: quantity(approval.feeWei) });
  const preview = Object.freeze({ payloadHex: hexFromBytes(approval.payload), payloadBytes: approval.payload.length, nIn: approval.nIn, nOut: approval.nOut });
  const transaction: CanonicalTapeoutTransaction = Object.freeze({ method: TAPEOUT_SIGNATURE, request, preview, calldataSha256: sha256Hex(data), feeWei: approval.feeWei });
  validateCanonicalTapeoutTransaction(lock, transaction, approval);
  return transaction;
}

export function validateCanonicalTapeoutTransaction(lock: ProtocolLock, transaction: CanonicalTapeoutTransaction, approval: TapeoutApproval): void {
  if (transaction.method !== TAPEOUT_SIGNATURE) throw new TransactionIntegrityError("Unexpected tapeout method");
  if (normalizeAddress(transaction.request.from ?? "") !== normalizeAddress(approval.sender)) throw new TransactionIntegrityError("tapeout sender mismatch");
  if (normalizeAddress(transaction.request.to) !== normalizeAddress(approval.processor)) throw new TransactionIntegrityError("tapeout target mismatch");
  const decoded = decodeTapeoutCall(lock, transaction.request.data);
  if (hexFromBytes(decoded.payload).toLowerCase() !== hexFromBytes(approval.payload).toLowerCase() || decoded.nIn !== approval.nIn || decoded.nOut !== approval.nOut) throw new TransactionIntegrityError("tapeout arguments mismatch");
  if (transaction.preview.payloadHex.toLowerCase() !== hexFromBytes(approval.payload).toLowerCase() || transaction.preview.payloadBytes !== approval.payload.length || transaction.preview.nIn !== approval.nIn || transaction.preview.nOut !== approval.nOut) throw new TransactionIntegrityError("tapeout preview mismatch");
  if (transaction.request.value !== quantity(approval.feeWei) || transaction.feeWei !== approval.feeWei) throw new TransactionIntegrityError("tapeout value mismatch");
  if (transaction.calldataSha256 !== sha256Hex(transaction.request.data)) throw new TransactionIntegrityError("tapeout calldata hash mismatch");
}

export function authorizeCanonicalTapeoutTransaction(lock: ProtocolLock, transaction: CanonicalTapeoutTransaction, approval: TapeoutApproval): Readonly<GateDCall> {
  validateCanonicalTapeoutTransaction(lock, transaction, approval);
  return transaction.request;
}
