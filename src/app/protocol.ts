import { decodeStep, encodeCall, hexFromBytes } from "../protocol/abi.js";
import { encodeGateDCall, decodeGateDUint256 } from "../protocol/gate-d-abi.js";
import { loadCanonicalDeployment } from "../protocol/deployment.js";
import { loadProtocolLock } from "../protocol/lock.js";
import { providerClients, type ReadOnlyRpcClient } from "../protocol/rpc.js";
import type { ProtocolLock } from "../protocol/types.js";

export const browserLock = loadProtocolLock();
export const browserDeployment = loadCanonicalDeployment();
export const browserClients = providerClients(browserLock);

export interface CommonReadBlock {
  number: number;
  hash: string;
  tag: string;
}

export interface LiveStepResult {
  block: CommonReadBlock;
  providers: string[];
  nextState: Uint8Array;
  outputs: Uint8Array;
  mismatches: string[];
}

export interface ReadOnlyQuote {
  block: CommonReadBlock;
  providers: string[];
  chainIds: number[];
  minted: bigint;
  cap: bigint;
  mintPriceWei: bigint;
  protocolFeeWei: bigint;
  tapeoutFeeWei: bigint;
  gasPriceWei: bigint;
  account?: string;
  nativeBalanceWei?: bigint;
  nonce?: bigint;
  nandBalance?: bigint;
  latchBalance?: bigint;
  agreement: boolean;
}

function quantity(value: number | bigint): string {
  return `0x${(typeof value === "bigint" ? value : BigInt(value)).toString(16)}`;
}

function parseQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${label} is not a hex quantity`);
  return BigInt(value);
}

function asHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`${label} is not hex`);
  return value;
}

async function commonBlock(): Promise<CommonReadBlock> {
  const heads = await Promise.all(browserLock.snapshot.providers.map(async (provider) => {
    const client = browserClients.get(provider);
    if (client === undefined) throw new Error(`No locked client for ${provider}`);
    const chainId = Number(parseQuantity(await client.request("eth_chainId", []), `${provider} chain`));
    if (chainId !== browserLock.chainId) throw new Error(`${provider} reported chain ${chainId}, expected ${browserLock.chainId}`);
    return Number(parseQuantity(await client.request("eth_blockNumber", []), `${provider} head`));
  }));
  const number = Math.min(...heads);
  const blocks = await Promise.all(browserLock.snapshot.providers.map(async (provider) => {
    const client = browserClients.get(provider);
    if (client === undefined) throw new Error(`No locked client for ${provider}`);
    const raw = await client.request("eth_getBlockByNumber", [quantity(number), false]);
    if (typeof raw !== "object" || raw === null || typeof (raw as { hash?: unknown }).hash !== "string") throw new Error(`${provider} block ${number} is unavailable`);
    return (raw as { hash: string }).hash.toLowerCase();
  }));
  if (new Set(blocks).size !== 1) throw new Error(`Locked providers disagree at common block ${number}`);
  return { number, hash: blocks[0] as string, tag: quantity(number) };
}

async function callUint(client: ReadOnlyRpcClient, target: string, signature: string, block: string, args: readonly (string | number | bigint)[] = []): Promise<bigint> {
  const raw = await client.request("eth_call", [{ to: target, data: encodeGateDCall(browserLock, signature, args) }, block]);
  return decodeGateDUint256(asHex(raw, signature));
}

export async function readOnlyQuote(account?: string): Promise<ReadOnlyQuote> {
  const block = await commonBlock();
  const values = await Promise.all(browserLock.snapshot.providers.map(async (provider) => {
    const client = browserClients.get(provider);
    if (client === undefined) throw new Error(`No locked client for ${provider}`);
    const chainId = Number(parseQuantity(await client.request("eth_chainId", []), `${provider} chain`));
    const accountReads = account === undefined ? [] : await Promise.all([
      callUint(client, browserDeployment.token, "balanceOf(address,uint256)", block.tag, [account, 0n]),
      callUint(client, browserDeployment.token, "balanceOf(address,uint256)", block.tag, [account, 1n]),
      client.request("eth_getBalance", [account, block.tag]).then((value) => parseQuantity(value, `${provider} balance`)),
      client.request("eth_getTransactionCount", [account, block.tag]).then((value) => parseQuantity(value, `${provider} nonce`))
    ]);
    const [minted, cap, mintPriceWei, protocolFeeWei, tapeoutFeeWei, gasPriceWei] = await Promise.all([
      callUint(client, browserDeployment.token, "minted()", block.tag),
      callUint(client, browserDeployment.token, "supplyCap()", block.tag),
      callUint(client, browserDeployment.token, "mintPrice()", block.tag),
      callUint(client, browserDeployment.token, "protocolFee()", block.tag),
      callUint(client, browserDeployment.processor, "TAPEOUT_FEE()", block.tag),
      client.request("eth_gasPrice", []).then((value) => parseQuantity(value, `${provider} gas price`))
    ]);
    return { chainId, minted, cap, mintPriceWei, protocolFeeWei, tapeoutFeeWei, gasPriceWei, account, nandBalance: accountReads[0], latchBalance: accountReads[1], nativeBalanceWei: accountReads[2], nonce: accountReads[3] };
  }));
  const first = values[0];
  if (first === undefined) throw new Error("No locked provider values returned");
  const stable = (value: typeof first) => [value.chainId, value.minted.toString(), value.cap.toString(), value.mintPriceWei.toString(), value.protocolFeeWei.toString(), value.tapeoutFeeWei.toString(), value.nandBalance?.toString() ?? "", value.latchBalance?.toString() ?? "", value.nativeBalanceWei?.toString() ?? "", value.nonce?.toString() ?? ""].join("|");
  const agreement = values.every((value) => stable(value) === stable(first));
  return { block, providers: browserLock.snapshot.providers, chainIds: values.map((value) => value.chainId), ...first, agreement };
}

export async function readLiveStep(circuitId: string, state: Uint8Array, inputs: Uint8Array): Promise<LiveStepResult> {
  const block = await commonBlock();
  const data = encodeCall(browserLock, "step(uint256,bytes,bytes)", [circuitId, state, inputs]);
  const rawResults = await Promise.all(browserLock.snapshot.providers.map(async (provider) => {
    const client = browserClients.get(provider);
    if (client === undefined) throw new Error(`No locked client for ${provider}`);
    return asHex(await client.request("eth_call", [{ to: browserDeployment.processor, data }, block.tag]), `${provider} step`);
  }));
  const decoded = rawResults.map((raw) => decodeStep(raw));
  const baseline = decoded[0];
  if (baseline === undefined) throw new Error("No live step result returned");
  const baselineState = hexFromBytes(baseline.nextState);
  const baselineOutput = hexFromBytes(baseline.outputs);
  const mismatches: string[] = [];
  decoded.forEach((result, index) => {
    if (hexFromBytes(result.nextState) !== baselineState) mismatches.push(`${browserLock.snapshot.providers[index]} next state disagreement`);
    if (hexFromBytes(result.outputs) !== baselineOutput) mismatches.push(`${browserLock.snapshot.providers[index]} output disagreement`);
  });
  return { block, providers: browserLock.snapshot.providers, nextState: baseline.nextState, outputs: baseline.outputs, mismatches };
}

export function weiToOkb(value: bigint): string {
  const whole = value / 1_000_000_000_000_000_000n;
  const fraction = (value % 1_000_000_000_000_000_000n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

export function lockedIdentitySummary(lock: ProtocolLock = browserLock): string[] {
  return [
    `factory proxy ${lock.factory.proxy}`,
    `factory implementation ${lock.factory.implementation}`,
    `circuit implementation ${lock.circuit.implementation}`,
    `transistor implementation ${lock.transistor.implementation}`,
    `processor ${browserDeployment.processor}`,
    `token ${browserDeployment.token}`,
    `chain ${lock.chainId}`,
    `providers ${lock.snapshot.providers.length}`
  ];
}
