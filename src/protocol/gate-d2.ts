import { compileMachine } from "../compiler/compiler.js";
import { TINY_APPROVAL_SOURCE } from "../examples/tinyApproval.js";
import { compareCandidateSimulation, type CandidateEvaluator } from "./candidate.js";
import { decodeBytesReturn, decodeCircuitInfo, decodeStep, decodeUint256, encodeCall, hexFromBytes } from "./abi.js";
import { buildCanonicalMintTransaction, buildCanonicalTapeoutTransaction, type CanonicalMintTransaction, type CanonicalTapeoutTransaction } from "./transaction-integrity.js";
import { assertCanonicalDeploymentSelected, loadCanonicalDeployment, type CanonicalDeployment } from "./deployment.js";
import { TINY_APPROVAL_PAYLOAD, type GateDCall } from "./gate-d.js";
import { decodeGateDBool, decodeGateDAddress, decodeGateDString, decodeGateDUint256, encodeGateDCall, sha256Hex } from "./gate-d-abi.js";
import { identityTargets, requireGateDProtocolFacts } from "./lock.js";
import { reconstructPostState } from "./overrides.js";
import { extractTapeOutPayload } from "./wire.js";
import type { ReadOnlyRpcClient } from "./rpc.js";
import type { ProtocolLock } from "./types.js";

const REQUIRED_NAND = BigInt(TINY_APPROVAL_PAYLOAD.nand);
const REQUIRED_LATCH = BigInt(TINY_APPROVAL_PAYLOAD.latch);

export interface GateD2Simulation {
  provider: string;
  ok: boolean;
  returnValue?: string;
  gas?: bigint;
  error?: string;
}

export interface GateD2Result {
  status: "PASS" | "BLOCKED";
  label: "D2_PREFLIGHT";
  commonBlock: { number: number; hash: string; tag: string };
  canonical: CanonicalDeployment;
  providers: Array<{
    provider: string;
    chainId: number;
    blockHash: string;
    identities: Array<{ key: string; address: string; expected: string; observed: string }>;
    processorRuntime: string;
    tokenRuntime: string;
    balanceWei: bigint;
    nonce: bigint;
    gasPriceWei: bigint;
    inventory: { nandId: bigint; latchId: bigint; nandBalance: bigint; latchBalance: bigint; minted: bigint; cap: bigint; priceWei: bigint; fixedMintFeeWei: bigint; tapeoutFeeWei: bigint; nextCircuitId: bigint };
    linkage: { registryProcessor: string; isCPU: boolean; factory: string; processorToken: string; tokenProcessor: string; creator: string };
    metadata: { name: string; symbol: string; tokenName: string; tokenSymbol: string; story: string };
  }>;
  deficits: { nand: bigint; latch: bigint };
  capSafety: { currentMinted: bigint; planned: bigint; cap: bigint; safe: boolean };
  mintSimulations: { nand?: { transaction: CanonicalMintTransaction; simulations: GateD2Simulation[] }; latch?: { transaction: CanonicalMintTransaction; simulations: GateD2Simulation[] } };
  sequentialSimulation: { label: "SIMULATION"; providers: Array<{ provider: string; nandBalance: bigint; latchBalance: bigint; minted: bigint; expectedNandBalance: bigint; expectedLatchBalance: bigint; expectedMinted: bigint }> };
  tapeoutSimulation: {
    transaction: CanonicalTapeoutTransaction;
    payload: { bytes: number; sha256: string; nIn: number; nOut: number; nState: number; gateCount: number };
    simulations: GateD2Simulation[];
    readback: Array<{ provider: string; circuitId: bigint; dimensions: { nIn: number; nOut: number; nState: number; gateCount: number }; payloadSha256: string; owner: string; casesCompared: number; mismatches: string[] }>;
  };
  budget: { currentBalanceWei: bigint; cumulativeBeforeWei: bigint; mandatoryRemainingWei: bigint; projectedCumulativeWei: bigint; projectedBalanceWei: bigint; remainingRoomWei: bigint; contingencyWei: bigint; contingencySatisfied: boolean };
  duplicateSafety: { existingMatchingCircuitIds: bigint[]; method: string; limitation?: string };
  blockers: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quantity(value: bigint | number): string {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 0n) throw new Error(`Negative quantity ${parsed}`);
  return `0x${parsed.toString(16)}`;
}

function parseQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${label} is not a hex quantity`);
  return BigInt(value);
}

function lockedTokenId(lock: ProtocolLock, key: "nandId" | "latchId"): bigint {
  const value = lock.gateD?.acquisition[key];
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  throw new Error(`protocol/lock.json gateD.acquisition.${key} is missing or invalid`);
}

function stringResult(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`${label} is not hex bytes`);
  return value;
}

function address(value: string): string {
  return value.toLowerCase();
}

function callParams(callObject: GateDCall, blockTag: string, overrides?: unknown): readonly unknown[] {
  return overrides === undefined ? [callObject, blockTag] : [callObject, blockTag, overrides];
}

async function ethCall(client: ReadOnlyRpcClient, callObject: GateDCall, blockTag: string, overrides?: unknown): Promise<string> {
  return stringResult(await client.request("eth_call", callParams(callObject, blockTag, overrides)), "eth_call result");
}

async function readUint(client: ReadOnlyRpcClient, target: string, signature: string, lock: ProtocolLock, blockTag: string, overrides?: unknown): Promise<bigint> {
  return decodeGateDUint256(await ethCall(client, { to: target, data: encodeGateDCall(lock, signature) }, blockTag, overrides));
}

async function readAddress(client: ReadOnlyRpcClient, target: string, signature: string, lock: ProtocolLock, blockTag: string, overrides?: unknown): Promise<string> {
  return decodeGateDAddress(await ethCall(client, { to: target, data: encodeGateDCall(lock, signature) }, blockTag, overrides));
}

async function readString(client: ReadOnlyRpcClient, target: string, signature: string, lock: ProtocolLock, blockTag: string, overrides?: unknown): Promise<string> {
  return decodeGateDString(await ethCall(client, { to: target, data: encodeGateDCall(lock, signature) }, blockTag, overrides));
}

async function readBalance(client: ReadOnlyRpcClient, token: string, owner: string, id: bigint, lock: ProtocolLock, blockTag: string, overrides?: unknown): Promise<bigint> {
  return decodeGateDUint256(await ethCall(client, { to: token, data: encodeGateDCall(lock, "balanceOf(address,uint256)", [owner, id]) }, blockTag, overrides));
}

async function readBlock(client: ReadOnlyRpcClient, number: number): Promise<{ number: number; hash: string }> {
  const result = await client.request("eth_getBlockByNumber", [quantity(number), false]);
  if (!isRecord(result) || typeof result.hash !== "string") throw new Error("Common block is unavailable");
  return { number: Number(parseQuantity(result.number, "block number")), hash: result.hash.toLowerCase() };
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
  if (new Set(blocks.map((block) => block.hash)).size !== 1) throw new Error(`Providers disagree at common block ${number}`);
  return { number, hash: blocks[0]?.hash as string, tag: quantity(number) };
}

async function tracePostState(client: ReadOnlyRpcClient, callObject: GateDCall, blockTag: string, initialOverrides: unknown): Promise<unknown> {
  const trace = await client.request("debug_traceCall", [callObject, blockTag, { tracer: "prestateTracer", tracerConfig: { diffMode: true }, stateOverrides: initialOverrides }]);
  return reconstructPostState(initialOverrides, trace);
}

async function simulate(client: ReadOnlyRpcClient, transaction: { request: Readonly<GateDCall> }, blockTag: string, overrides?: unknown): Promise<GateD2Simulation> {
  try {
    return { provider: "", ok: true, returnValue: await ethCall(client, transaction.request, blockTag, overrides) };
  } catch (error) {
    return { provider: "", ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function estimate(client: ReadOnlyRpcClient, transaction: { request: Readonly<GateDCall> }, blockTag: string, overrides?: unknown): Promise<GateD2Simulation> {
  try {
    return { provider: "", ok: true, gas: parseQuantity(await client.request("eth_estimateGas", callParams(transaction.request, blockTag, overrides)), "gas estimate") };
  } catch (error) {
    return { provider: "", ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function verifyProvider(lock: ProtocolLock, deployment: CanonicalDeployment, client: ReadOnlyRpcClient, provider: string, block: { number: number; hash: string; tag: string }): Promise<GateD2Result["providers"][number]> {
  const chainId = Number(parseQuantity(await client.request("eth_chainId", []), `${provider} chain ID`));
  if (chainId !== lock.chainId) throw new Error(`${provider} chain ${chainId} != ${lock.chainId}`);
  const identities: Array<{ key: string; address: string; expected: string; observed: string }> = [];
  for (const target of identityTargets(lock)) {
    const code = stringResult(await client.request("eth_getCode", [target.address, block.tag]), `${provider} code ${target.address}`);
    const { runtimeKeccak256 } = await import("./identity.js");
    const observed = runtimeKeccak256(code).toLowerCase();
    if (observed !== target.expectedRuntimeKeccak256.toLowerCase()) throw new Error(`${provider} locked identity mismatch for ${target.key}: ${observed}`);
    identities.push({ key: target.key, address: target.address, expected: target.expectedRuntimeKeccak256.toLowerCase(), observed });
  }
  const processorCode = stringResult(await client.request("eth_getCode", [deployment.processor, block.tag]), `${provider} canonical processor code`);
  const tokenCode = stringResult(await client.request("eth_getCode", [deployment.token, block.tag]), `${provider} canonical token code`);
  const { runtimeKeccak256 } = await import("./identity.js");
  const processorRuntime = runtimeKeccak256(processorCode).toLowerCase();
  const tokenRuntime = runtimeKeccak256(tokenCode).toLowerCase();
  if (processorRuntime !== deployment.runtimeKeccak256.processor) throw new Error(`${provider} canonical processor runtime mismatch`);
  if (tokenRuntime !== deployment.runtimeKeccak256.token) throw new Error(`${provider} canonical token runtime mismatch`);

  const registryProcessor = decodeGateDAddress(await ethCall(client, { to: lock.factory.proxy, data: encodeGateDCall(lock, "cpuAt(uint256)", [deployment.registryIndex]) }, block.tag));
  const isCPU = decodeGateDBool(await ethCall(client, { to: lock.factory.proxy, data: encodeGateDCall(lock, "isCPU(address)", [deployment.processor]) }, block.tag));
  const processorToken = await readAddress(client, deployment.processor, "transistors()", lock, block.tag);
  const factory = await readAddress(client, deployment.processor, "factory()", lock, block.tag);
  const tokenProcessor = await readAddress(client, deployment.token, "circuits()", lock, block.tag);
  const creator = await readAddress(client, deployment.token, "creator()", lock, block.tag);
  if (address(registryProcessor) !== deployment.processor || !isCPU || address(processorToken) !== deployment.token || address(tokenProcessor) !== deployment.processor || address(factory) !== address(lock.factory.proxy) || address(creator) !== deployment.creator) throw new Error(`${provider} canonical linkage mismatch`);
  const nandId = lockedTokenId(lock, "nandId");
  const latchId = lockedTokenId(lock, "latchId");
  const [name, symbol, tokenName, tokenSymbol, story, cap, priceWei, fixedMintFeeWei, minted, nandBalance, latchBalance, tapeoutFeeWei, nextCircuitId, balanceWei, nonce, gasPriceWei] = await Promise.all([
    readString(client, deployment.processor, "name()", lock, block.tag),
    readString(client, deployment.processor, "symbol()", lock, block.tag),
    readString(client, deployment.token, "cpuName()", lock, block.tag),
    readString(client, deployment.token, "cpuSymbol()", lock, block.tag),
    readString(client, deployment.token, "story()", lock, block.tag),
    readUint(client, deployment.token, "supplyCap()", lock, block.tag),
    readUint(client, deployment.token, "mintPrice()", lock, block.tag),
    readUint(client, deployment.token, "protocolFee()", lock, block.tag),
    readUint(client, deployment.token, "minted()", lock, block.tag),
    readBalance(client, deployment.token, deployment.creator, nandId, lock, block.tag),
    readBalance(client, deployment.token, deployment.creator, latchId, lock, block.tag),
    readUint(client, deployment.processor, "TAPEOUT_FEE()", lock, block.tag),
    readUint(client, deployment.processor, "nextId()", lock, block.tag),
    parseQuantity(await client.request("eth_getBalance", [deployment.creator, block.tag]), `${provider} balance`),
    parseQuantity(await client.request("eth_getTransactionCount", [deployment.creator, block.tag]), `${provider} nonce`),
    parseQuantity(await client.request("eth_gasPrice", []), `${provider} gas price`)
  ]);
  if (name !== deployment.metadata.name || symbol !== deployment.metadata.symbol || tokenName !== deployment.metadata.name || tokenSymbol !== deployment.metadata.symbol || story !== deployment.metadata.story || cap !== deployment.metadata.cap || priceWei !== deployment.metadata.priceWei) throw new Error(`${provider} canonical metadata/economics mismatch`);
  return {
    provider, chainId, blockHash: block.hash, identities, processorRuntime, tokenRuntime, balanceWei, nonce, gasPriceWei,
    inventory: { nandId, latchId, nandBalance, latchBalance, minted, cap, priceWei, fixedMintFeeWei, tapeoutFeeWei, nextCircuitId },
    linkage: { registryProcessor, isCPU, factory, processorToken, tokenProcessor, creator },
    metadata: { name, symbol, tokenName, tokenSymbol, story }
  };
}

async function duplicateCircuitIds(lock: ProtocolLock, client: ReadOnlyRpcClient, deployment: CanonicalDeployment, blockTag: string, payload: Uint8Array, dimensions: { nIn: number; nOut: number; nState: number; gateCount: number }, overrides?: unknown): Promise<bigint[]> {
  const nextId = await readUint(client, deployment.processor, "nextId()", lock, blockTag, overrides);
  if (nextId > 10_000n) throw new Error(`Circuit enumeration limit exceeded: nextId=${nextId}`);
  const matches: bigint[] = [];
  for (let id = 0n; id < nextId; id += 1n) {
    const owner = await ethCall(client, { to: deployment.processor, data: encodeGateDCall(lock, "ownerOf(uint256)", [id]) }, blockTag, overrides).then(decodeGateDAddress).catch(() => "");
    const info = decodeCircuitInfo(await ethCall(client, { to: deployment.processor, data: encodeGateDCall(lock, "circuitInfo(uint256)", [id]) }, blockTag, overrides));
    const raw = await ethCall(client, { to: deployment.processor, data: encodeGateDCall(lock, "netlist(uint256)", [id]) }, blockTag, overrides);
    if (address(owner) === address(deployment.creator) && info.nIn === dimensions.nIn && info.nOut === dimensions.nOut && info.nState === dimensions.nState && info.gateCount === dimensions.gateCount && hexFromBytes(decodeBytesReturn(raw)).toLowerCase() === hexFromBytes(payload).toLowerCase()) matches.push(id);
  }
  return matches;
}

function expectAgreement(label: string, results: GateD2Simulation[]): void {
  if (results.some((result) => !result.ok)) throw new Error(`${label} provider simulation failed: ${JSON.stringify(results)}`);
  const returns = new Set(results.map((result) => result.returnValue ?? `gas:${result.gas?.toString()}`));
  if (returns.size !== 1) throw new Error(`${label} provider results disagree`);
}

export async function runGateD2Preflight(lock: ProtocolLock, clients: ReadonlyMap<string, ReadOnlyRpcClient>): Promise<GateD2Result> {
  requireGateDProtocolFacts(lock);
  const deployment = loadCanonicalDeployment();
  assertCanonicalDeploymentSelected(deployment, deployment.processor, deployment.token);
  const block = await commonBlock(lock, clients);
  const providers = await Promise.all(lock.snapshot.providers.map(async (provider) => {
    const client = clients.get(provider);
    if (client === undefined) throw new Error(`No client for ${provider}`);
    return verifyProvider(lock, deployment, client, provider, block);
  }));
  const first = providers[0];
  if (first === undefined) throw new Error("No provider verification result");
  if (providers.some((item) => item.blockHash !== block.hash || item.chainId !== lock.chainId)) throw new Error("Provider common-block or chain disagreement");
  if (providers.some((item) => item.inventory.nandBalance !== first.inventory.nandBalance || item.inventory.latchBalance !== first.inventory.latchBalance || item.inventory.minted !== first.inventory.minted || item.inventory.cap !== first.inventory.cap || item.inventory.priceWei !== first.inventory.priceWei || item.inventory.fixedMintFeeWei !== first.inventory.fixedMintFeeWei || item.inventory.tapeoutFeeWei !== first.inventory.tapeoutFeeWei)) throw new Error("Provider inventory or fee disagreement");
  const nand = first.inventory.nandBalance >= REQUIRED_NAND ? 0n : REQUIRED_NAND - first.inventory.nandBalance;
  const latch = first.inventory.latchBalance >= REQUIRED_LATCH ? 0n : REQUIRED_LATCH - first.inventory.latchBalance;
  const planned = nand + latch;
  const capSafety = { currentMinted: first.inventory.minted, planned, cap: first.inventory.cap, safe: first.inventory.minted + planned <= first.inventory.cap };
  if (!capSafety.safe) throw new Error(`Planned mint exceeds shared cap: ${first.inventory.minted}+${planned}>${first.inventory.cap}`);

  const mintSimulations: GateD2Result["mintSimulations"] = {};
  const mintTransactions: CanonicalMintTransaction[] = [];
  if (nand > 0n) {
    const transaction = buildCanonicalMintTransaction(lock, { sender: deployment.creator, token: deployment.token, id: first.inventory.nandId, amount: nand, priceWei: first.inventory.priceWei, protocolFeeWei: first.inventory.fixedMintFeeWei });
    const simulations = await Promise.all(lock.snapshot.providers.map(async (provider) => { const result = await simulate(clients.get(provider) as ReadOnlyRpcClient, transaction, block.tag); return { ...result, provider }; }));
    const estimates = await Promise.all(lock.snapshot.providers.map(async (provider) => { const result = await estimate(clients.get(provider) as ReadOnlyRpcClient, transaction, block.tag); return { ...result, provider }; }));
    expectAgreement("NAND mint simulation", simulations);
    expectAgreement("NAND mint gas estimate", estimates);
    mintSimulations.nand = { transaction, simulations: estimates.map((result, index) => ({ ...result, returnValue: simulations[index]?.returnValue })) };
    mintTransactions.push(transaction);
  }
  if (latch > 0n) {
    const transaction = buildCanonicalMintTransaction(lock, { sender: deployment.creator, token: deployment.token, id: first.inventory.latchId, amount: latch, priceWei: first.inventory.priceWei, protocolFeeWei: first.inventory.fixedMintFeeWei });
    const simulations = await Promise.all(lock.snapshot.providers.map(async (provider) => { const result = await simulate(clients.get(provider) as ReadOnlyRpcClient, transaction, block.tag); return { ...result, provider }; }));
    const estimates = await Promise.all(lock.snapshot.providers.map(async (provider) => { const result = await estimate(clients.get(provider) as ReadOnlyRpcClient, transaction, block.tag); return { ...result, provider }; }));
    expectAgreement("LATCH mint simulation", simulations);
    expectAgreement("LATCH mint gas estimate", estimates);
    mintSimulations.latch = { transaction, simulations: estimates.map((result, index) => ({ ...result, returnValue: simulations[index]?.returnValue })) };
    mintTransactions.push(transaction);
  }

  const sequentialProviders: GateD2Result["sequentialSimulation"]["providers"] = [];
  const postMintOverrides = new Map<string, unknown>();
  const traceProvider = lock.snapshot.providers[1] ?? lock.snapshot.providers[0];
  if (traceProvider === undefined) throw new Error("No locked trace provider is available");
  const traceClient = clients.get(traceProvider);
  if (traceClient === undefined) throw new Error(`No client for locked trace provider ${traceProvider}`);
  let reconstructedPostMint: unknown = {};
  for (const transaction of mintTransactions) reconstructedPostMint = await tracePostState(traceClient, transaction.request, block.tag, reconstructedPostMint);
  for (const provider of lock.snapshot.providers) {
    const client = clients.get(provider) as ReadOnlyRpcClient;
    const overrides = reconstructedPostMint;
    const nandBalance = await readBalance(client, deployment.token, deployment.creator, first.inventory.nandId, lock, block.tag, overrides);
    const latchBalance = await readBalance(client, deployment.token, deployment.creator, first.inventory.latchId, lock, block.tag, overrides);
    const minted = await readUint(client, deployment.token, "minted()", lock, block.tag, overrides);
    sequentialProviders.push({ provider, nandBalance, latchBalance, minted, expectedNandBalance: first.inventory.nandBalance + nand, expectedLatchBalance: first.inventory.latchBalance + latch, expectedMinted: first.inventory.minted + planned });
    if (nandBalance !== first.inventory.nandBalance + nand || latchBalance !== first.inventory.latchBalance + latch || minted !== first.inventory.minted + planned) throw new Error(`${provider} sequential post-mint state mismatch`);
    postMintOverrides.set(provider, overrides);
  }

  const compiled = await compileMachine(TINY_APPROVAL_SOURCE);
  const extracted = await extractTapeOutPayload(lock, compiled.bytes);
  const payloadBytes = extracted.payload;
  const payload = { bytes: extracted.payloadBytes, sha256: extracted.payloadHash, nIn: extracted.dimensions.nIn, nOut: extracted.dimensions.nOut, nState: extracted.dimensions.nState, gateCount: extracted.dimensions.gateCount };
  if (payload.bytes !== TINY_APPROVAL_PAYLOAD.bytes || payload.sha256 !== TINY_APPROVAL_PAYLOAD.sha256) throw new Error("TinyApproval payload changed before D2");
  const duplicateIds: bigint[] = [];
  for (const provider of lock.snapshot.providers) duplicateIds.push(...await duplicateCircuitIds(lock, clients.get(provider) as ReadOnlyRpcClient, deployment, block.tag, payloadBytes, payload, postMintOverrides.get(provider)));
  if (new Set(duplicateIds.map((id) => id.toString())).size > 0) throw new Error(`An identical TinyApproval circuit already exists: ${duplicateIds.join(",")}`);
  const tapeoutTransaction = buildCanonicalTapeoutTransaction(lock, { sender: deployment.creator, processor: deployment.processor, payload: payloadBytes, nIn: payload.nIn, nOut: payload.nOut, feeWei: first.inventory.tapeoutFeeWei });
  const tapeoutSimulation = await Promise.all(lock.snapshot.providers.map(async (provider) => { const result = await simulate(clients.get(provider) as ReadOnlyRpcClient, tapeoutTransaction, block.tag, postMintOverrides.get(provider)); return { ...result, provider }; }));
  const tapeoutEstimates = await Promise.all(lock.snapshot.providers.map(async (provider) => { const result = await estimate(clients.get(provider) as ReadOnlyRpcClient, tapeoutTransaction, block.tag, postMintOverrides.get(provider)); return { ...result, provider }; }));
  expectAgreement("Tapeout simulation", tapeoutSimulation);
  expectAgreement("Tapeout gas estimate", tapeoutEstimates);

  const readback: GateD2Result["tapeoutSimulation"]["readback"] = [];
  const postTapeout = await tracePostState(traceClient, tapeoutTransaction.request, block.tag, reconstructedPostMint);
  for (const provider of lock.snapshot.providers) {
    const client = clients.get(provider) as ReadOnlyRpcClient;
    const id = decodeUint256(tapeoutSimulation.find((result) => result.provider === provider)?.returnValue as string);
    const info = decodeCircuitInfo(await ethCall(client, { to: deployment.processor, data: encodeGateDCall(lock, "circuitInfo(uint256)", [id]) }, block.tag, postTapeout));
    const netlist = decodeBytesReturn(await ethCall(client, { to: deployment.processor, data: encodeGateDCall(lock, "netlist(uint256)", [id]) }, block.tag, postTapeout));
    const owner = decodeGateDAddress(await ethCall(client, { to: deployment.processor, data: encodeGateDCall(lock, "ownerOf(uint256)", [id]) }, block.tag, postTapeout));
    const candidate: CandidateEvaluator = { async evaluate(stateBytes, inputBytes) { const raw = await ethCall(client, { to: deployment.processor, from: deployment.creator, data: encodeCall(lock, "step(uint256,bytes,bytes)", [id, stateBytes, inputBytes]) }, block.tag, postTapeout); const step = decodeStep(raw); return { nextStateBytes: step.nextState, outputBytes: step.outputs }; } };
    const comparison = await compareCandidateSimulation(compiled, candidate);
    readback.push({ provider, circuitId: id, dimensions: info, payloadSha256: sha256Hex(hexFromBytes(netlist)), owner: address(owner), casesCompared: comparison.casesCompared, mismatches: comparison.mismatches });
    if (info.nIn !== payload.nIn || info.nOut !== payload.nOut || info.nState !== payload.nState || info.gateCount !== payload.gateCount || hexFromBytes(netlist).toLowerCase() !== hexFromBytes(payloadBytes).toLowerCase() || address(owner) !== address(deployment.creator) || comparison.mismatches.length > 0) throw new Error(`${provider} simulated tapeout readback or 32-case comparison failed`);
  }
  if (new Set(readback.map((item) => item.circuitId.toString())).size !== 1) throw new Error("Tapeout simulated circuit IDs disagree");

  const gasPrices = providers.map((item) => item.gasPriceWei);
  const maxGasPrice = gasPrices.reduce((max, value) => value > max ? value : max, 0n);
  const gasQuotes = [mintSimulations.nand?.simulations, mintSimulations.latch?.simulations, tapeoutEstimates].filter((quotes): quotes is GateD2Simulation[] => quotes !== undefined).map((quotes) => quotes.reduce((max, result) => (result.gas ?? 0n) > max ? result.gas ?? 0n : max, 0n));
  const gasCost = gasQuotes.reduce((total, gas) => total + gas * maxGasPrice, 0n);
  const valueCost = (mintSimulations.nand?.transaction.request.value ? parseQuantity(mintSimulations.nand.transaction.request.value, "NAND value") : 0n) + (mintSimulations.latch?.transaction.request.value ? parseQuantity(mintSimulations.latch.transaction.request.value, "LATCH value") : 0n) + parseQuantity(tapeoutTransaction.request.value ?? "0x0", "tapeout value");
  const mandatoryRemainingWei = valueCost + gasCost;
  const cumulativeBeforeWei = deployment.budget.cumulativeProjectSpendBeforeD2Wei;
  const projectedCumulativeWei = cumulativeBeforeWei + mandatoryRemainingWei;
  const projectedBalanceWei = first.balanceWei - mandatoryRemainingWei;
  const budget = { currentBalanceWei: first.balanceWei, cumulativeBeforeWei, mandatoryRemainingWei, projectedCumulativeWei, projectedBalanceWei, remainingRoomWei: deployment.budget.projectCeilingWei - projectedCumulativeWei, contingencyWei: deployment.budget.desiredPostMandatoryContingencyWei, contingencySatisfied: projectedBalanceWei >= deployment.budget.desiredPostMandatoryContingencyWei };
  if (projectedCumulativeWei > deployment.budget.projectCeilingWei) throw new Error(`Projected D2 spend exceeds project ceiling: ${projectedCumulativeWei}`);
  const blockers: string[] = [];
  return { status: blockers.length === 0 ? "PASS" : "BLOCKED", label: "D2_PREFLIGHT", commonBlock: block, canonical: deployment, providers, deficits: { nand, latch }, capSafety, mintSimulations, sequentialSimulation: { label: "SIMULATION", providers: sequentialProviders }, tapeoutSimulation: { transaction: tapeoutTransaction, payload, simulations: tapeoutEstimates.map((result, index) => ({ ...result, returnValue: tapeoutSimulation[index]?.returnValue })), readback }, budget, duplicateSafety: { existingMatchingCircuitIds: duplicateIds, method: "Enumerate processor nextId() at the pinned block, read ownerOf/circuitInfo/netlist, and match creator, dimensions and exact payload before tapeout." }, blockers };
}
