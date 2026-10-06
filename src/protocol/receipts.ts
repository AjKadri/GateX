import type { ProtocolLock } from "./types.js";

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash?: string;
  blockHash?: string;
  blockNumber?: string;
  removed?: boolean;
}

export interface RpcReceipt {
  status?: string;
  transactionHash?: string;
  blockHash?: string;
  blockNumber?: string;
  from?: string;
  to?: string | null;
  gasUsed?: string;
  effectiveGasPrice?: string;
  logs?: RpcLog[];
}

export interface RpcTransaction {
  hash?: string;
  from?: string;
  to?: string | null;
  value?: string;
  input?: string;
  nonce?: string;
  blockHash?: string;
  blockNumber?: string;
}

export interface MintReceiptExpectation {
  transactionHash: string;
  sender: string;
  token: string;
  data: string;
  valueWei: bigint;
  id: bigint;
  amount: bigint;
}

export interface MintReceiptVerification {
  provider: string;
  blockNumber: bigint;
  blockHash: string;
  confirmations: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  actualGasCostWei: bigint;
  actualTransactionCostWei: bigint;
  minted: { recipient: string; id: bigint; amount: bigint; paidWei: bigint };
  transferSingle: { operator: string; from: string; to: string; id: bigint; amount: bigint };
}

export interface TapeoutReceiptExpectation {
  transactionHash: string;
  sender: string;
  processor: string;
  data: string;
  valueWei: bigint;
  gateCount: number;
  nState: number;
}

export interface TapeoutReceiptVerification {
  provider: string;
  blockNumber: bigint;
  blockHash: string;
  confirmations: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  actualGasCostWei: bigint;
  actualTransactionCostWei: bigint;
  tapedOut: { circuitId: bigint; author: string; gateCount: number; nState: number };
  transfer: { from: string; to: string; circuitId: bigint };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is missing`);
  return value;
}

function quantity(value: unknown, label: string): bigint {
  const text = stringField(value, label);
  if (!/^0x[0-9a-fA-F]+$/.test(text)) throw new Error(`${label} is not a hex quantity`);
  return BigInt(text);
}

function address(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid address ${value}`);
  return value.toLowerCase();
}

function word(data: string, index: number): bigint {
  if (!/^0x(?:[0-9a-fA-F]{64})+$/.test(data)) throw new Error("Event data is not ABI word-aligned");
  const start = 2 + index * 64;
  if (start + 64 > data.length) throw new Error("Event data word is truncated");
  return BigInt(`0x${data.slice(start, start + 64)}`);
}

function topic(lock: ProtocolLock, signature: string): string {
  const event = lock.gateD?.events.find((candidate) => candidate.signature === signature);
  if (event === undefined) throw new Error(`Locked event is missing: ${signature}`);
  return event.topic0.toLowerCase();
}

function indexedAddress(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} is not a topic word`);
  return address(`0x${value.slice(-40)}`);
}

function findLog(logs: RpcLog[], topic0: string, target: string): RpcLog {
  const found = logs.find((log) => address(log.address) === address(target) && log.topics[0]?.toLowerCase() === topic0);
  if (found === undefined) throw new Error(`Expected event ${topic0} from ${target} was not found`);
  if (found.removed === true) throw new Error(`Expected event ${topic0} was removed`);
  return found;
}

export function verifyMintReceipt(lock: ProtocolLock, provider: string, receiptValue: unknown, transactionValue: unknown, headValue: unknown, expected: MintReceiptExpectation): MintReceiptVerification {
  const receipt = record(receiptValue, `${provider} receipt`) as unknown as RpcReceipt;
  const transaction = record(transactionValue, `${provider} transaction`) as unknown as RpcTransaction;
  const status = stringField(receipt.status, `${provider} receipt status`).toLowerCase();
  if (status !== "0x1") throw new Error(`${provider} receipt status is ${status}, expected 0x1`);
  if (stringField(receipt.transactionHash, `${provider} receipt hash`).toLowerCase() !== expected.transactionHash.toLowerCase()) throw new Error(`${provider} receipt hash mismatch`);
  if (stringField(transaction.hash, `${provider} transaction hash`).toLowerCase() !== expected.transactionHash.toLowerCase()) throw new Error(`${provider} transaction hash mismatch`);
  if (address(stringField(receipt.from, `${provider} receipt sender`)) !== address(expected.sender)) throw new Error(`${provider} receipt sender mismatch`);
  if (address(stringField(transaction.from, `${provider} transaction sender`)) !== address(expected.sender)) throw new Error(`${provider} transaction sender mismatch`);
  if (address(stringField(receipt.to, `${provider} receipt target`)) !== address(expected.token)) throw new Error(`${provider} receipt target mismatch`);
  if (address(stringField(transaction.to, `${provider} transaction target`)) !== address(expected.token)) throw new Error(`${provider} transaction target mismatch`);
  if (stringField(transaction.input, `${provider} transaction input`).toLowerCase() !== expected.data.toLowerCase()) throw new Error(`${provider} transaction calldata mismatch`);
  if (quantity(transaction.value, `${provider} transaction value`) !== expected.valueWei) throw new Error(`${provider} transaction value mismatch`);

  const blockNumber = quantity(receipt.blockNumber, `${provider} receipt block number`);
  const blockHash = stringField(receipt.blockHash, `${provider} receipt block hash`).toLowerCase();
  if (stringField(transaction.blockNumber, `${provider} transaction block number`).toLowerCase() !== `0x${blockNumber.toString(16)}`) throw new Error(`${provider} transaction block number mismatch`);
  if (stringField(transaction.blockHash, `${provider} transaction block hash`).toLowerCase() !== blockHash) throw new Error(`${provider} transaction block hash mismatch`);
  const head = quantity(headValue, `${provider} head`);
  const confirmations = head - blockNumber + 1n;
  if (confirmations < 2n) throw new Error(`${provider} has only ${confirmations} confirmations`);

  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const mintedLog = findLog(logs, topic(lock, "Minted(address,uint256,uint256,uint256)"), expected.token);
  if (mintedLog.topics.length < 3) throw new Error(`${provider} Minted topics are incomplete`);
  const minted = {
    recipient: indexedAddress(mintedLog.topics[1] as string, `${provider} Minted recipient`),
    id: word(`0x${(mintedLog.topics[2] as string).slice(2)}`, 0),
    amount: word(mintedLog.data, 0),
    paidWei: word(mintedLog.data, 1)
  };
  if (minted.recipient !== address(expected.sender) || minted.id !== expected.id || minted.amount !== expected.amount || minted.paidWei !== expected.valueWei) throw new Error(`${provider} Minted event fields mismatch`);

  const transferLog = findLog(logs, topic(lock, "TransferSingle(address,address,address,uint256,uint256)"), expected.token);
  if (transferLog.topics.length < 4) throw new Error(`${provider} TransferSingle topics are incomplete`);
  const transferSingle = {
    operator: indexedAddress(transferLog.topics[1] as string, `${provider} TransferSingle operator`),
    from: indexedAddress(transferLog.topics[2] as string, `${provider} TransferSingle from`),
    to: indexedAddress(transferLog.topics[3] as string, `${provider} TransferSingle to`),
    id: word(transferLog.data, 0),
    amount: word(transferLog.data, 1)
  };
  if (transferSingle.to !== address(expected.sender) || transferSingle.from !== "0x0000000000000000000000000000000000000000" || transferSingle.id !== expected.id || transferSingle.amount !== expected.amount) throw new Error(`${provider} TransferSingle event fields mismatch`);

  const gasUsed = quantity(receipt.gasUsed, `${provider} receipt gas used`);
  const effectiveGasPrice = quantity(receipt.effectiveGasPrice, `${provider} effective gas price`);
  return { provider, blockNumber, blockHash, confirmations, gasUsed, effectiveGasPrice, actualGasCostWei: gasUsed * effectiveGasPrice, actualTransactionCostWei: gasUsed * effectiveGasPrice + expected.valueWei, minted, transferSingle };
}

export function verifyTapeoutReceipt(lock: ProtocolLock, provider: string, receiptValue: unknown, transactionValue: unknown, headValue: unknown, expected: TapeoutReceiptExpectation): TapeoutReceiptVerification {
  const receipt = record(receiptValue, `${provider} receipt`) as unknown as RpcReceipt;
  const transaction = record(transactionValue, `${provider} transaction`) as unknown as RpcTransaction;
  const status = stringField(receipt.status, `${provider} receipt status`).toLowerCase();
  if (status !== "0x1") throw new Error(`${provider} receipt status is ${status}, expected 0x1`);
  if (stringField(receipt.transactionHash, `${provider} receipt hash`).toLowerCase() !== expected.transactionHash.toLowerCase()) throw new Error(`${provider} receipt hash mismatch`);
  if (stringField(transaction.hash, `${provider} transaction hash`).toLowerCase() !== expected.transactionHash.toLowerCase()) throw new Error(`${provider} transaction hash mismatch`);
  if (address(stringField(receipt.from, `${provider} receipt sender`)) !== address(expected.sender)) throw new Error(`${provider} receipt sender mismatch`);
  if (address(stringField(transaction.from, `${provider} transaction sender`)) !== address(expected.sender)) throw new Error(`${provider} transaction sender mismatch`);
  if (address(stringField(receipt.to, `${provider} receipt target`)) !== address(expected.processor)) throw new Error(`${provider} receipt target mismatch`);
  if (address(stringField(transaction.to, `${provider} transaction target`)) !== address(expected.processor)) throw new Error(`${provider} transaction target mismatch`);
  if (stringField(transaction.input, `${provider} transaction input`).toLowerCase() !== expected.data.toLowerCase()) throw new Error(`${provider} transaction calldata mismatch`);
  if (quantity(transaction.value, `${provider} transaction value`) !== expected.valueWei) throw new Error(`${provider} transaction value mismatch`);

  const blockNumber = quantity(receipt.blockNumber, `${provider} receipt block number`);
  const blockHash = stringField(receipt.blockHash, `${provider} receipt block hash`).toLowerCase();
  if (stringField(transaction.blockNumber, `${provider} transaction block number`).toLowerCase() !== `0x${blockNumber.toString(16)}`) throw new Error(`${provider} transaction block number mismatch`);
  if (stringField(transaction.blockHash, `${provider} transaction block hash`).toLowerCase() !== blockHash) throw new Error(`${provider} transaction block hash mismatch`);
  const head = quantity(headValue, `${provider} head`);
  const confirmations = head - blockNumber + 1n;
  if (confirmations < 2n) throw new Error(`${provider} has only ${confirmations} confirmations`);

  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const tapedOutLog = findLog(logs, topic(lock, "TapedOut(uint256,address,uint32,uint32)"), expected.processor);
  if (tapedOutLog.topics.length < 3) throw new Error(`${provider} TapedOut topics are incomplete`);
  const tapedOut = { circuitId: word(`0x${(tapedOutLog.topics[1] as string).slice(2)}`, 0), author: indexedAddress(tapedOutLog.topics[2] as string, `${provider} TapedOut author`), gateCount: Number(word(tapedOutLog.data, 0)), nState: Number(word(tapedOutLog.data, 1)) };
  if (tapedOut.author !== address(expected.sender) || tapedOut.gateCount !== expected.gateCount || tapedOut.nState !== expected.nState) throw new Error(`${provider} TapedOut event fields mismatch`);

  const transferLog = findLog(logs, topic(lock, "Transfer(address,address,uint256)"), expected.processor);
  if (transferLog.topics.length < 4) throw new Error(`${provider} circuit Transfer topics are incomplete`);
  const transfer = { from: indexedAddress(transferLog.topics[1] as string, `${provider} Transfer from`), to: indexedAddress(transferLog.topics[2] as string, `${provider} Transfer to`), circuitId: word(`0x${(transferLog.topics[3] as string).slice(2)}`, 0) };
  if (transfer.from !== "0x0000000000000000000000000000000000000000" || transfer.to !== address(expected.sender) || transfer.circuitId !== tapedOut.circuitId) throw new Error(`${provider} circuit Transfer event fields mismatch`);

  const gasUsed = quantity(receipt.gasUsed, `${provider} receipt gas used`);
  const effectiveGasPrice = quantity(receipt.effectiveGasPrice, `${provider} effective gas price`);
  return { provider, blockNumber, blockHash, confirmations, gasUsed, effectiveGasPrice, actualGasCostWei: gasUsed * effectiveGasPrice, actualTransactionCostWei: gasUsed * effectiveGasPrice + expected.valueWei, tapedOut, transfer };
}
