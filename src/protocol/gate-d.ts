import { decodeCreateReturn, decodeGateDAddress, decodeGateDBool, decodeGateDString, decodeGateDUint256, encodeGateDCall, hexFromBytes, padTopicAddress, sha256Hex } from "./gate-d-abi.js";
import { identityTargets } from "./lock.js";
import { runtimeKeccak256 } from "./identity.js";
import type { ProtocolLock, ProviderVerification } from "./types.js";
import type { ReadOnlyRpcClient } from "./rpc.js";

export const GATEX_DEPLOYMENT_ACCOUNT = "0x9fa5db29dfc46e9bfdde271e44364d4ba64244c4";
export const GATEX_CREATION = { name: "GateX", symbol: "GTX", cap: 1_000_000n, priceWei: 1_000_000_000_000n } as const;
export const TINY_APPROVAL_PAYLOAD = {
  bytes: 631,
  nand: 89,
  latch: 2,
  records: 91,
  nIn: 3,
  nOut: 1,
  nState: 2,
  sha256: "7ec1ed9fe2e0c5f92a45b2ad49fe3da969c109f01522d8306fe127aba76cabac"
} as const;

export interface GateDCall {
  from?: string;
  to: string;
  data: string;
  value?: string;
}

export interface GateDProviderRefresh {
  provider: string;
  chainId: number;
  blockNumber: number;
  blockHash: string;
  gasPriceWei: bigint;
  identities: ProviderVerification["identities"];
  fees: { deployWei: bigint; factoryProtocolWei: bigint; sampleTapeoutWei: bigint };
  account: { balanceWei: bigint; nonce: bigint };
  registry: ProcessorObservation[];
}

export interface ProcessorObservation {
  processor: string;
  token: string;
  isCPU: boolean;
  factory: string;
  tokenCircuits: string;
  creator: string;
  name: string;
  symbol: string;
  tokenName: string;
  tokenSymbol: string;
  capWei: bigint;
  priceWei: bigint;
  protocolFeeWei: bigint;
}

export interface CreationPreflight {
  call?: GateDCall;
  calldataSha256?: string;
  valueWei?: bigint;
  simulations: Array<{ provider: string; ok: boolean; returnValue?: string; simulatedToken?: string; simulatedProcessor?: string; error?: string }>;
  gasEstimates: Array<{ provider: string; ok: boolean; gas?: bigint; error?: string }>;
  accepted: boolean;
  blockers: string[];
}

export interface GateDRefresh {
  commonBlock: { number: number; hash: string; tag: string };
  providers: GateDProviderRefresh[];
  providerAgreement: boolean;
  gasPriceAgreement: boolean;
  identityAgreement: boolean;
  account: string;
  existingMatches: ProcessorObservation[];
  creation?: CreationPreflight;
  blockers: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function quantity(value: bigint | number): string {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 0n) throw new Error(`Negative JSON-RPC quantity ${parsed}`);
  return `0x${parsed.toString(16)}`;
}

function parseQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${label} is not a hex quantity`);
  return BigInt(value);
}

function normalizeAddress(value: string): string {
  return value.toLowerCase();
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is missing`);
  return value;
}

function normalizeHash(value: string): string {
  return value.toLowerCase();
}

async function mapLimit<T, R>(items: readonly T[], limit: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await operation(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => worker()));
  return results;
}

async function readBlock(client: ReadOnlyRpcClient, blockNumber: number): Promise<{ number: number; hash: string }> {
  const result = await client.request("eth_getBlockByNumber", [quantity(blockNumber), false]);
  if (!isRecord(result)) throw new Error("RPC returned no block");
  return { number: Number(parseQuantity(result.number, "block number")), hash: normalizeHash(requireString(result.hash, "block hash")) };
}

async function call(client: ReadOnlyRpcClient, tx: GateDCall, blockTag: string): Promise<string> {
  return requireString(await client.request("eth_call", [tx, blockTag]), "eth_call result");
}

async function readUint(client: ReadOnlyRpcClient, target: string, signature: string, lock: ProtocolLock, blockTag: string): Promise<bigint> {
  return decodeGateDUint256(await call(client, { to: target, data: encodeGateDCall(lock, signature) }, blockTag));
}

async function readAddress(client: ReadOnlyRpcClient, target: string, signature: string, lock: ProtocolLock, blockTag: string): Promise<string> {
  return decodeGateDAddress(await call(client, { to: target, data: encodeGateDCall(lock, signature) }, blockTag));
}

async function readString(client: ReadOnlyRpcClient, target: string, signature: string, lock: ProtocolLock, blockTag: string): Promise<string> {
  return decodeGateDString(await call(client, { to: target, data: encodeGateDCall(lock, signature) }, blockTag));
}

async function readIdentityAtBlock(lock: ProtocolLock, provider: string, client: ReadOnlyRpcClient, blockNumber: number): Promise<ProviderVerification> {
  const block = await readBlock(client, blockNumber);
  const chainId = Number(parseQuantity(await client.request("eth_chainId", []), `${provider} chain ID`));
  if (chainId !== lock.chainId) throw new Error(`${provider} returned chain ${chainId}, expected ${lock.chainId}`);
  const identities: ProviderVerification["identities"] = [];
  for (const target of identityTargets(lock)) {
    const code = requireString(await client.request("eth_getCode", [target.address, quantity(blockNumber)]), `${provider} code ${target.address}`);
    const observed = runtimeKeccak256(code);
    if (normalizeHash(observed) !== normalizeHash(target.expectedRuntimeKeccak256)) throw new Error(`${provider} runtime mismatch for ${target.key}: ${observed} != ${target.expectedRuntimeKeccak256}`);
    identities.push({ key: target.key, address: target.address, expectedRuntimeKeccak256: target.expectedRuntimeKeccak256, observedRuntimeKeccak256: observed });
  }
  return { provider, chainId, blockNumber: block.number, blockHash: block.hash, identities };
}

async function observeProcessor(lock: ProtocolLock, client: ReadOnlyRpcClient, blockTag: string, processor: string): Promise<ProcessorObservation> {
  const token = await readAddress(client, processor, "transistors()", lock, blockTag);
  const isCPU = decodeGateDBool(await call(client, { to: lock.factory.proxy, data: encodeGateDCall(lock, "isCPU(address)", [processor]) }, blockTag));
  const [factory, name, symbol, tokenCircuits, creator, tokenName, tokenSymbol, capWei, priceWei, protocolFeeWei] = await Promise.all([
    readAddress(client, processor, "factory()", lock, blockTag),
    readString(client, processor, "name()", lock, blockTag),
    readString(client, processor, "symbol()", lock, blockTag),
    readAddress(client, token, "circuits()", lock, blockTag),
    readAddress(client, token, "creator()", lock, blockTag),
    readString(client, token, "cpuName()", lock, blockTag),
    readString(client, token, "cpuSymbol()", lock, blockTag),
    readUint(client, token, "supplyCap()", lock, blockTag),
    readUint(client, token, "mintPrice()", lock, blockTag),
    readUint(client, token, "protocolFee()", lock, blockTag)
  ]);
  return { processor, token, isCPU, factory, tokenCircuits, creator, name, symbol, tokenName, tokenSymbol, capWei, priceWei, protocolFeeWei };
}

async function observeRegistry(lock: ProtocolLock, client: ReadOnlyRpcClient, blockTag: string, account: string): Promise<ProcessorObservation[]> {
  const count = Number(await readUint(client, lock.factory.proxy, "cpuCount()", lock, blockTag));
  if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) throw new Error(`Factory cpuCount is outside safe registry scan bounds: ${count}`);
  const addresses = await mapLimit(Array.from({ length: count }, (_, index) => index), 4, (index) => call(client, { to: lock.factory.proxy, data: encodeGateDCall(lock, "cpuAt(uint256)", [index]) }, blockTag).then((value) => decodeGateDAddress(value)));
  const owned = await mapLimit(addresses, 4, async (processor) => {
    const token = await readAddress(client, processor, "transistors()", lock, blockTag);
    const creator = await readAddress(client, token, "creator()", lock, blockTag);
    return normalizeAddress(creator) === normalizeAddress(account) ? observeProcessor(lock, client, blockTag, processor) : undefined;
  });
  return owned.filter((item): item is ProcessorObservation => item !== undefined);
}

async function observeFees(lock: ProtocolLock, client: ReadOnlyRpcClient, blockTag: string): Promise<GateDProviderRefresh["fees"]> {
  const [deployWei, factoryProtocolWei, sampleTapeoutWei] = await Promise.all([
    readUint(client, lock.factory.proxy, "deployFee()", lock, blockTag),
    readUint(client, lock.factory.proxy, "protocolFee()", lock, blockTag),
    readUint(client, lock.sample.processor, "TAPEOUT_FEE()", lock, blockTag)
  ]);
  return { deployWei, factoryProtocolWei, sampleTapeoutWei };
}

async function observeAccount(client: ReadOnlyRpcClient, account: string, blockTag: string): Promise<{ balanceWei: bigint; nonce: bigint }> {
  return {
    balanceWei: parseQuantity(await client.request("eth_getBalance", [account, blockTag]), "account balance"),
    nonce: parseQuantity(await client.request("eth_getTransactionCount", [account, blockTag]), "account nonce")
  };
}

function comparableProviderState(provider: GateDProviderRefresh): string {
  return JSON.stringify({
    chainId: provider.chainId,
    blockNumber: provider.blockNumber,
    blockHash: provider.blockHash,
    fees: Object.fromEntries(Object.entries(provider.fees).map(([key, value]) => [key, value.toString()])),
    account: { balanceWei: provider.account.balanceWei.toString(), nonce: provider.account.nonce.toString() },
    registry: provider.registry.map((item) => ({ ...item, capWei: item.capWei.toString(), priceWei: item.priceWei.toString(), protocolFeeWei: item.protocolFeeWei.toString() }))
  });
}

export function creationCall(lock: ProtocolLock, account: string, story: string, feeWei: bigint): GateDCall {
  return {
    from: account,
    to: lock.factory.proxy,
    data: encodeGateDCall(lock, "createCPU(string,string,string,uint256,uint256)", [GATEX_CREATION.name, GATEX_CREATION.symbol, story, GATEX_CREATION.cap, GATEX_CREATION.priceWei]),
    value: quantity(feeWei)
  };
}

export function mintCall(lock: ProtocolLock, account: string, token: string, id: bigint, amount: bigint, priceWei: bigint, protocolFeeWei: bigint): GateDCall {
  if (amount <= 0n) throw new Error("Mint amount must be positive");
  return {
    from: account,
    to: token,
    data: encodeGateDCall(lock, "mint(uint256,uint256)", [id, amount]),
    value: quantity(amount * priceWei + protocolFeeWei)
  };
}

export function tapeoutCall(lock: ProtocolLock, account: string, processor: string, payload: Uint8Array, feeWei: bigint): GateDCall {
  return {
    from: account,
    to: processor,
    data: encodeGateDCall(lock, "tapeout(bytes,uint32,uint32)", [payload, TINY_APPROVAL_PAYLOAD.nIn, TINY_APPROVAL_PAYLOAD.nOut]),
    value: quantity(feeWei)
  };
}

async function simulateCall(client: ReadOnlyRpcClient, callObject: GateDCall, blockTag: string): Promise<{ ok: boolean; returnValue?: string; error?: string }> {
  try {
    return { ok: true, returnValue: await call(client, callObject, blockTag) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function estimateCall(client: ReadOnlyRpcClient, callObject: GateDCall, blockTag: string): Promise<{ ok: boolean; gas?: bigint; error?: string }> {
  try {
    return { ok: true, gas: parseQuantity(await client.request("eth_estimateGas", [callObject, blockTag]), "gas estimate") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function commonBlock(lock: ProtocolLock, clients: ReadonlyMap<string, ReadOnlyRpcClient>): Promise<{ number: number; hash: string; tag: string }> {
  const heads = await Promise.all(lock.snapshot.providers.map(async (provider) => {
    const client = clients.get(provider);
    if (client === undefined) throw new Error(`No client for ${provider}`);
    return Number(parseQuantity(await client.request("eth_blockNumber", []), `${provider} head`));
  }));
  const number = Math.min(...heads);
  const blocks = await Promise.all(lock.snapshot.providers.map(async (provider) => {
    const client = clients.get(provider);
    if (client === undefined) throw new Error(`No client for ${provider}`);
    return readBlock(client, number);
  }));
  const hashes = new Set(blocks.map((block) => block.hash));
  if (hashes.size !== 1) throw new Error(`Providers disagree at common block ${number}: ${blocks.map((block) => block.hash).join(", ")}`);
  return { number, hash: blocks[0]?.hash as string, tag: quantity(number) };
}

export async function runGateD0Preflight(lock: ProtocolLock, clients: ReadonlyMap<string, ReadOnlyRpcClient>, account = GATEX_DEPLOYMENT_ACCOUNT, story?: string): Promise<GateDRefresh> {
  const blockers: string[] = [];
  const block = await commonBlock(lock, clients);
  const providers = await Promise.all(lock.snapshot.providers.map(async (provider): Promise<GateDProviderRefresh> => {
    const client = clients.get(provider);
    if (client === undefined) throw new Error(`No client for ${provider}`);
    const identity = await readIdentityAtBlock(lock, provider, client, block.number);
    const gasPriceWei = parseQuantity(await client.request("eth_gasPrice", []), `${provider} gas price`);
    return {
      provider,
      chainId: identity.chainId,
      blockNumber: identity.blockNumber,
      blockHash: identity.blockHash,
      gasPriceWei,
      identities: identity.identities,
      fees: await observeFees(lock, client, block.tag),
      account: await observeAccount(client, account, block.tag),
      registry: await observeRegistry(lock, client, block.tag, account)
    };
  }));
  const providerAgreement = providers.every((provider) => comparableProviderState(provider) === comparableProviderState(providers[0] as GateDProviderRefresh));
  const gasPriceAgreement = providers.every((provider) => provider.gasPriceWei === providers[0]?.gasPriceWei);
  const identityAgreement = providers.every((provider) => provider.identities.every((identity, index) => identity.observedRuntimeKeccak256.toLowerCase() === providers[0]?.identities[index]?.observedRuntimeKeccak256.toLowerCase()));
  if (!providerAgreement) blockers.push("Locked providers disagree on refreshed block, fees, account state, or processor registry");
  if (!identityAgreement) blockers.push("Locked providers disagree on refreshed runtime identities");
  const existingMatches = (providers[0]?.registry ?? []).filter((item) => item.isCPU && normalizeAddress(item.factory) === normalizeAddress(lock.factory.proxy) && normalizeAddress(item.creator) === normalizeAddress(account) && item.name === GATEX_CREATION.name && item.symbol === GATEX_CREATION.symbol && item.capWei === GATEX_CREATION.cap && item.priceWei === GATEX_CREATION.priceWei);
  if (existingMatches.length > 1) blockers.push(`Duplicate safety found ${existingMatches.length} matching GateX processors for ${account}`);
  if (story === undefined) blockers.push("Exact factory call cannot be simulated because the required createCPU story string was not supplied");
  let creation: CreationPreflight | undefined;
  if (story !== undefined && providerAgreement && identityAgreement && existingMatches.length === 0) {
    const feeWei = providers[0]?.fees.deployWei as bigint;
    const callObject = creationCall(lock, account, story, feeWei);
    const simulations = await Promise.all(lock.snapshot.providers.map(async (provider) => {
      const client = clients.get(provider) as ReadOnlyRpcClient;
      const result = await simulateCall(client, callObject, block.tag);
      if (!result.ok || result.returnValue === undefined) return { provider, ok: false, error: result.error };
      const decoded = decodeCreateReturn(result.returnValue);
      return { provider, ok: true, returnValue: result.returnValue, simulatedToken: decoded.token, simulatedProcessor: decoded.processor };
    }));
    const gasEstimates = await Promise.all(lock.snapshot.providers.map(async (provider) => {
      const client = clients.get(provider) as ReadOnlyRpcClient;
      const result = await estimateCall(client, callObject, block.tag);
      return { provider, ...result };
    }));
    const successfulSimulations = simulations.filter((result) => result.ok);
    const successfulEstimates = gasEstimates.filter((result) => result.ok);
    const simulationAgreement = successfulSimulations.length === simulations.length && new Set(successfulSimulations.map((result) => `${result.simulatedToken}:${result.simulatedProcessor}`)).size === 1;
    const estimateAgreement = successfulEstimates.length === gasEstimates.length && new Set(successfulEstimates.map((result) => result.gas?.toString())).size === 1;
    const creationBlockers: string[] = [];
    if (!simulationAgreement) creationBlockers.push("Factory eth_call failed or providers returned different simulated return addresses");
    if (!estimateAgreement) creationBlockers.push("Factory eth_estimateGas failed or providers returned different estimates");
    creation = { call: callObject, calldataSha256: sha256Hex(callObject.data), valueWei: feeWei, simulations, gasEstimates, accepted: creationBlockers.length === 0, blockers: creationBlockers };
    blockers.push(...creationBlockers);
  }
  return { commonBlock: block, providers, providerAgreement, gasPriceAgreement, identityAgreement, account, existingMatches, creation, blockers };
}

export function transactionPlanDigest(callObject: GateDCall): { calldataSha256: string; valueWei: bigint } {
  return { calldataSha256: sha256Hex(callObject.data), valueWei: parseQuantity(callObject.value ?? "0x0", "transaction value") };
}

export function topicAddress(topic: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) throw new Error(`Invalid indexed address topic ${topic}`);
  return `0x${topic.slice(-40)}`.toLowerCase();
}

export function creationLogFilter(lock: ProtocolLock, account: string, blockTag: string): Record<string, unknown> {
  const topic0 = lock.gateD?.events.find((event) => event.signature === "CPUCreated(address,address,address,string,uint256,uint256)")?.topic0;
  if (topic0 === undefined) throw new Error("CPUCreated event is not locked");
  return { address: lock.factory.proxy, fromBlock: "0x43b4c67", toBlock: blockTag, topics: [topic0, null, null, padTopicAddress(account)] };
}

export function tapeoutLogFilter(lock: ProtocolLock, processor: string, account: string, fromBlock: string, blockTag: string): Record<string, unknown> {
  const topic0 = lock.gateD?.events.find((event) => event.signature === "TapedOut(uint256,address,uint32,uint32)")?.topic0;
  if (topic0 === undefined) throw new Error("TapedOut event is not locked");
  return { address: processor, fromBlock, toBlock: blockTag, topics: [topic0, null, padTopicAddress(account)] };
}

export function expectedMintValue(amount: bigint, priceWei: bigint, protocolFeeWei: bigint): bigint {
  if (amount <= 0n) throw new Error("Mint amount must be positive");
  return amount * priceWei + protocolFeeWei;
}

export function decodeSimulatedCreation(value: string): { token: string; processor: string } {
  return decodeCreateReturn(value);
}

export function payloadHex(payload: Uint8Array): string {
  return hexFromBytes(payload);
}
