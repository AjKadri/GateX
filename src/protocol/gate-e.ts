import { AGENT_APPROVAL_SOURCE } from "../examples/agentApproval.js";
import { compileMachine } from "../compiler/compiler.js";
import { compareCandidateSimulation, compareCandidateSimulationWithConcurrency, localCandidateEvaluator, type CandidateEvaluator } from "./candidate.js";
import { decodeBytesReturn, decodeCircuitInfo, decodeStep, decodeUint256, encodeCall, hexFromBytes } from "./abi.js";
import { buildCanonicalMintTransaction, buildCanonicalTapeoutTransaction, type CanonicalMintTransaction, type CanonicalTapeoutTransaction } from "./transaction-integrity.js";
import { assertCanonicalDeploymentSelected, loadCanonicalDeployment, type CanonicalDeployment } from "./deployment.js";
import { decodeGateDAddress, decodeGateDBool, decodeGateDString, decodeGateDUint256, encodeGateDCall, hexFromBytes as gateDHexFromBytes, sha256Hex } from "./gate-d-abi.js";
import { identityTargets, requireGateDProtocolFacts } from "./lock.js";
import { reconstructPostState } from "./overrides.js";
import type { GateDCall } from "./gate-d.js";
import type { ReadOnlyRpcClient } from "./rpc.js";
import type { ProtocolLock, ProviderVerification } from "./types.js";
import { GateXValidationError } from "../compiler/validation.js";

const OVERLAPPING_REVOKED_SOURCE = `
machine AgentApprovalRevoked {
  states IDLE, REQUESTED, APPROVED, USED, REVOKED;
  initial IDLE;
  inputs request, approve, execute, cancel, human_ok, scope_ok;
  outputs permit;
  terminal USED;
  reset_on cancel;

  IDLE -> REQUESTED when request;
  REQUESTED -> APPROVED when approve && human_ok && scope_ok;
  REQUESTED -> REVOKED when approve;
  APPROVED -> USED when execute && human_ok && scope_ok emit permit;
}
`;

const DISJOINT_REVOKED_SOURCE = `
machine AgentApprovalRevoked {
  states IDLE, REQUESTED, APPROVED, USED, REVOKED;
  initial IDLE;
  inputs request, approve, execute, cancel, human_ok, scope_ok;
  outputs permit;
  terminal USED;
  reset_on cancel;

  IDLE -> REQUESTED when request;
  REQUESTED -> APPROVED when approve && human_ok && scope_ok;
  REQUESTED -> REVOKED when approve && (!human_ok || !scope_ok);
  APPROVED -> USED when execute && human_ok && scope_ok emit permit;
}
`;

export interface GateEProviderState {
  provider: string;
  chainId: number;
  blockHash: string;
  identities: ProviderVerification["identities"];
  processorRuntime: string;
  tokenRuntime: string;
  balanceWei: bigint;
  nonce: bigint;
  gasPriceWei: bigint;
  inventory: {
    nandId: bigint;
    latchId: bigint;
    nandBalance: bigint;
    latchBalance: bigint;
    minted: bigint;
    cap: bigint;
    priceWei: bigint;
    fixedMintFeeWei: bigint;
    tapeoutFeeWei: bigint;
    nextCircuitId: bigint;
  };
  linkage: {
    registryProcessor: string;
    isCPU: boolean;
    factory: string;
    processorToken: string;
    tokenProcessor: string;
    creator: string;
  };
}

export interface GateESimulation {
  provider: string;
  ok: boolean;
  returnValue?: string;
  gas?: bigint;
  error?: string;
}

export interface GateE0Result {
  status: "PASS" | "BLOCKED";
  label: "E0_PREFLIGHT";
  commonBlock: { number: number; hash: string; tag: string };
  canonical: CanonicalDeployment;
  artifact: {
    nand: number;
    latch: number;
    records: number;
    localBytes: number;
    localSha256: string;
    payloadBytes: number;
    payloadSha256: string;
    nIn: number;
    nOut: number;
    nState: number;
  };
  providers: GateEProviderState[];
  deficits: { nand: bigint; latch: bigint };
  revocationKillTest: { overlappingRejected: boolean; witness: string; disjointCases: number; mismatches: string[] };
  mintSimulations: { nand?: { transaction: CanonicalMintTransaction; simulations: GateESimulation[]; estimates: GateESimulation[] }; latch?: { transaction: CanonicalMintTransaction; simulations: GateESimulation[]; estimates: GateESimulation[] } };
  sequentialSimulation: { label: "SIMULATION"; providers: Array<{ provider: string; nandBalance: bigint; latchBalance: bigint; minted: bigint; expectedNandBalance: bigint; expectedLatchBalance: bigint; expectedMinted: bigint }> };
  tapeoutSimulation: {
    transaction: CanonicalTapeoutTransaction;
    simulations: GateESimulation[];
    estimates: GateESimulation[];
    simulatedCircuitIds: bigint[];
    readback: Array<{ provider: string; circuitId: bigint; owner: string; dimensions: { nIn: number; nOut: number; nState: number; gateCount: number }; payloadSha256: string; casesCompared: number; mismatches: string[] }>;
  };
  budget: { currentBalanceWei: bigint; cumulativeBeforeWei: bigint; mandatoryRemainingWei: bigint; projectedCumulativeWei: bigint; projectedBalanceWei: bigint; remainingRoomWei: bigint; contingencyWei: bigint; contingencySatisfied: boolean };
  duplicateSafety: { existingMatchingCircuitIds: bigint[]; method: string };
  blockers: string[];
}

export interface GateENandMintPreflight {
  commonBlock: { number: number; hash: string; tag: string };
  canonical: CanonicalDeployment;
  artifact: GateE0Result["artifact"];
  providers: GateEProviderState[];
  deficit: bigint;
  transaction: CanonicalMintTransaction;
  simulations: GateESimulation[];
  estimates: GateESimulation[];
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

function address(value: string): string {
  return value.toLowerCase();
}

function hex(value: Uint8Array): string {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function callParams(callObject: GateDCall, blockTag: string, overrides?: unknown): readonly unknown[] {
  return overrides === undefined ? [callObject, blockTag] : [callObject, blockTag, overrides];
}

async function ethCall(client: ReadOnlyRpcClient, callObject: GateDCall, blockTag: string, overrides?: unknown): Promise<string> {
  const value = await client.request("eth_call", callParams(callObject, blockTag, overrides));
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) throw new Error("eth_call result is not hex bytes");
  return value;
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

async function readBlock(client: ReadOnlyRpcClient, blockNumber: number): Promise<{ number: number; hash: string }> {
  const raw = await client.request("eth_getBlockByNumber", [quantity(blockNumber), false]);
  if (!isRecord(raw) || typeof raw.hash !== "string") throw new Error("Common block is unavailable");
  return { number: Number(parseQuantity(raw.number, "block number")), hash: raw.hash.toLowerCase() };
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

async function simulate(client: ReadOnlyRpcClient, transaction: { request: Readonly<GateDCall> }, blockTag: string, overrides?: unknown): Promise<GateESimulation> {
  try {
    return { provider: "", ok: true, returnValue: await ethCall(client, transaction.request, blockTag, overrides) };
  } catch (error) {
    return { provider: "", ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function estimate(client: ReadOnlyRpcClient, transaction: { request: Readonly<GateDCall> }, blockTag: string, overrides?: unknown): Promise<GateESimulation> {
  try {
    return { provider: "", ok: true, gas: parseQuantity(await client.request("eth_estimateGas", callParams(transaction.request, blockTag, overrides)), "gas estimate") };
  } catch (error) {
    return { provider: "", ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readProviderState(lock: ProtocolLock, deployment: CanonicalDeployment, client: ReadOnlyRpcClient, provider: string, block: { number: number; hash: string; tag: string }): Promise<GateEProviderState> {
  const chainId = Number(parseQuantity(await client.request("eth_chainId", []), `${provider} chain ID`));
  if (chainId !== lock.chainId) throw new Error(`${provider} chain ${chainId} != ${lock.chainId}`);
  const { runtimeKeccak256 } = await import("./identity.js");
  const identities = await Promise.all(identityTargets(lock).map(async (target): Promise<ProviderVerification["identities"][number]> => {
    const code = await client.request("eth_getCode", [target.address, block.tag]);
    if (typeof code !== "string") throw new Error(`${provider} code is missing for ${target.key}`);
    const observed = runtimeKeccak256(code).toLowerCase();
    if (observed !== target.expectedRuntimeKeccak256.toLowerCase()) throw new Error(`${provider} locked identity mismatch for ${target.key}: ${observed}`);
    return { key: target.key, address: target.address, expectedRuntimeKeccak256: target.expectedRuntimeKeccak256, observedRuntimeKeccak256: observed };
  }));
  const processorCode = await client.request("eth_getCode", [deployment.processor, block.tag]);
  const tokenCode = await client.request("eth_getCode", [deployment.token, block.tag]);
  if (typeof processorCode !== "string" || typeof tokenCode !== "string") throw new Error(`${provider} canonical runtime code is missing`);
  const processorRuntime = runtimeKeccak256(processorCode).toLowerCase();
  const tokenRuntime = runtimeKeccak256(tokenCode).toLowerCase();
  if (processorRuntime !== deployment.runtimeKeccak256.processor || tokenRuntime !== deployment.runtimeKeccak256.token) throw new Error(`${provider} canonical processor/token runtime mismatch`);

  const [registryProcessor, isCPU, processorToken, factory, tokenProcessor, creator] = await Promise.all([
    ethCall(client, { to: lock.factory.proxy, data: encodeGateDCall(lock, "cpuAt(uint256)", [deployment.registryIndex]) }, block.tag).then(decodeGateDAddress),
    ethCall(client, { to: lock.factory.proxy, data: encodeGateDCall(lock, "isCPU(address)", [deployment.processor]) }, block.tag).then(decodeGateDBool),
    readAddress(client, deployment.processor, "transistors()", lock, block.tag),
    readAddress(client, deployment.processor, "factory()", lock, block.tag),
    readAddress(client, deployment.token, "circuits()", lock, block.tag),
    readAddress(client, deployment.token, "creator()", lock, block.tag)
  ]);
  if (address(registryProcessor) !== deployment.processor || !isCPU || address(processorToken) !== deployment.token || address(factory) !== address(lock.factory.proxy) || address(tokenProcessor) !== deployment.processor || address(creator) !== deployment.creator) throw new Error(`${provider} canonical linkage mismatch`);

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
    readBalance(client, deployment.token, deployment.creator, 0n, lock, block.tag),
    readBalance(client, deployment.token, deployment.creator, 1n, lock, block.tag),
    readUint(client, deployment.processor, "TAPEOUT_FEE()", lock, block.tag),
    readUint(client, deployment.processor, "nextId()", lock, block.tag),
    parseQuantity(await client.request("eth_getBalance", [deployment.creator, block.tag]), `${provider} balance`),
    parseQuantity(await client.request("eth_getTransactionCount", [deployment.creator, block.tag]), `${provider} nonce`),
    parseQuantity(await client.request("eth_gasPrice", []), `${provider} gas price`)
  ]);
  if (name !== deployment.metadata.name || symbol !== deployment.metadata.symbol || tokenName !== deployment.metadata.name || tokenSymbol !== deployment.metadata.symbol || story !== deployment.metadata.story || cap !== deployment.metadata.cap || priceWei !== deployment.metadata.priceWei) throw new Error(`${provider} canonical metadata/economics mismatch`);
  return {
    provider, chainId, blockHash: block.hash, identities, processorRuntime, tokenRuntime, balanceWei, nonce, gasPriceWei,
    inventory: { nandId: 0n, latchId: 1n, nandBalance, latchBalance, minted, cap, priceWei, fixedMintFeeWei, tapeoutFeeWei, nextCircuitId },
    linkage: { registryProcessor, isCPU, factory, processorToken, tokenProcessor, creator }
  };
}

async function duplicateCircuitIds(lock: ProtocolLock, client: ReadOnlyRpcClient, deployment: CanonicalDeployment, blockTag: string, payload: Uint8Array, dimensions: { nIn: number; nOut: number; nState: number; gateCount: number }, overrides?: unknown): Promise<bigint[]> {
  const nextId = await readUint(client, deployment.processor, "nextId()", lock, blockTag, overrides);
  if (nextId > 10_000n) throw new Error(`Circuit enumeration limit exceeded: ${nextId}`);
  const matches: bigint[] = [];
  for (let id = 1n; id <= nextId; id += 1n) {
    const owner = await ethCall(client, { to: deployment.processor, data: encodeGateDCall(lock, "ownerOf(uint256)", [id]) }, blockTag, overrides).then(decodeGateDAddress).catch(() => "");
    const info = decodeCircuitInfo(await ethCall(client, { to: deployment.processor, data: encodeGateDCall(lock, "circuitInfo(uint256)", [id]) }, blockTag, overrides));
    const netlist = decodeBytesReturn(await ethCall(client, { to: deployment.processor, data: encodeGateDCall(lock, "netlist(uint256)", [id]) }, blockTag, overrides));
    if (address(owner) === deployment.creator && info.nIn === dimensions.nIn && info.nOut === dimensions.nOut && info.nState === dimensions.nState && info.gateCount === dimensions.gateCount && hex(netlist).toLowerCase() === hex(payload).toLowerCase()) matches.push(id);
  }
  return matches;
}

function assertAgreement(label: string, results: GateESimulation[]): void {
  if (results.some((result) => !result.ok)) throw new Error(`${label} failed: ${JSON.stringify(results)}`);
  const values = new Set(results.map((result) => result.returnValue ?? `gas:${result.gas?.toString()}`));
  if (values.size !== 1) throw new Error(`${label} provider disagreement`);
}

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function gateEJson(value: GateE0Result): string {
  return JSON.stringify(value, replacer, 2);
}

export async function runGateE0Preflight(lock: ProtocolLock, clients: ReadonlyMap<string, ReadOnlyRpcClient>): Promise<GateE0Result> {
  requireGateDProtocolFacts(lock);
  const deployment = loadCanonicalDeployment();
  assertCanonicalDeploymentSelected(deployment, deployment.processor, deployment.token);
  const compiled = await compileMachine(AGENT_APPROVAL_SOURCE);
  const { extractTapeOutPayload } = await import("./wire.js");
  const extracted = await extractTapeOutPayload(lock, compiled.bytes);
  const artifact = { nand: compiled.nandCount, latch: compiled.latchCount, records: compiled.artifact.records.length, localBytes: compiled.bytes.length, localSha256: compiled.hash, payloadBytes: extracted.payloadBytes, payloadSha256: extracted.payloadHash, nIn: extracted.dimensions.nIn, nOut: extracted.dimensions.nOut, nState: extracted.dimensions.nState };
  const block = await commonBlock(lock, clients);
  const providers = await Promise.all(lock.snapshot.providers.map(async (provider) => {
    const client = clients.get(provider);
    if (client === undefined) throw new Error(`No client for ${provider}`);
    return readProviderState(lock, deployment, client, provider, block);
  }));
  const first = providers[0];
  if (first === undefined) throw new Error("No provider state was returned");
  if (providers.some((provider) => provider.chainId !== lock.chainId || provider.blockHash !== block.hash)) throw new Error("Provider chain or common-block disagreement");
  if (providers.some((provider) => provider.inventory.nandBalance !== first.inventory.nandBalance || provider.inventory.latchBalance !== first.inventory.latchBalance || provider.inventory.minted !== first.inventory.minted || provider.inventory.cap !== first.inventory.cap || provider.inventory.priceWei !== first.inventory.priceWei || provider.inventory.fixedMintFeeWei !== first.inventory.fixedMintFeeWei || provider.inventory.tapeoutFeeWei !== first.inventory.tapeoutFeeWei)) throw new Error("Provider inventory or fee disagreement");

  const nand = first.inventory.nandBalance >= BigInt(artifact.nand) ? 0n : BigInt(artifact.nand) - first.inventory.nandBalance;
  const latch = first.inventory.latchBalance >= BigInt(artifact.latch) ? 0n : BigInt(artifact.latch) - first.inventory.latchBalance;
  if (first.inventory.minted + nand + latch > first.inventory.cap) throw new Error("AgentApproval acquisition exceeds the shared supply cap");
  const mintSimulations: GateE0Result["mintSimulations"] = {};
  const mintTransactions: CanonicalMintTransaction[] = [];
  for (const [kind, amount, id] of [["nand", nand, first.inventory.nandId], ["latch", latch, first.inventory.latchId] ] as const) {
    if (amount === 0n) continue;
    const transaction = buildCanonicalMintTransaction(lock, { sender: deployment.creator, token: deployment.token, id, amount, priceWei: first.inventory.priceWei, protocolFeeWei: first.inventory.fixedMintFeeWei });
    const simulations = await Promise.all(lock.snapshot.providers.map(async (provider) => ({ ...await simulate(clients.get(provider) as ReadOnlyRpcClient, transaction, block.tag), provider })));
    const estimates = await Promise.all(lock.snapshot.providers.map(async (provider) => ({ ...await estimate(clients.get(provider) as ReadOnlyRpcClient, transaction, block.tag), provider })));
    assertAgreement(`${kind} mint simulation`, simulations);
    assertAgreement(`${kind} mint gas estimate`, estimates);
    mintSimulations[kind] = { transaction, simulations, estimates };
    mintTransactions.push(transaction);
  }

  const traceProvider = lock.snapshot.providers[1] ?? lock.snapshot.providers[0];
  if (traceProvider === undefined) throw new Error("No locked trace provider");
  const traceClient = clients.get(traceProvider);
  if (traceClient === undefined) throw new Error(`No client for ${traceProvider}`);
  let postMintOverrides: unknown = {};
  for (const transaction of mintTransactions) postMintOverrides = await tracePostState(traceClient, transaction.request, block.tag, postMintOverrides);
  const sequentialProviders: GateE0Result["sequentialSimulation"]["providers"] = [];
  for (const provider of lock.snapshot.providers) {
    const client = clients.get(provider) as ReadOnlyRpcClient;
    const nandBalance = await readBalance(client, deployment.token, deployment.creator, first.inventory.nandId, lock, block.tag, postMintOverrides);
    const latchBalance = await readBalance(client, deployment.token, deployment.creator, first.inventory.latchId, lock, block.tag, postMintOverrides);
    const minted = await readUint(client, deployment.token, "minted()", lock, block.tag, postMintOverrides);
    const expectedNandBalance = first.inventory.nandBalance + nand;
    const expectedLatchBalance = first.inventory.latchBalance + latch;
    const expectedMinted = first.inventory.minted + nand + latch;
    if (nandBalance !== expectedNandBalance || latchBalance !== expectedLatchBalance || minted !== expectedMinted) throw new Error(`${provider} sequential AgentApproval acquisition state mismatch`);
    sequentialProviders.push({ provider, nandBalance, latchBalance, minted, expectedNandBalance, expectedLatchBalance, expectedMinted });
  }

  const dimensions = { nIn: extracted.dimensions.nIn, nOut: extracted.dimensions.nOut, nState: extracted.dimensions.nState, gateCount: extracted.dimensions.gateCount };
  const duplicateIds: bigint[] = [];
  for (const provider of lock.snapshot.providers) duplicateIds.push(...await duplicateCircuitIds(lock, clients.get(provider) as ReadOnlyRpcClient, deployment, block.tag, extracted.payload, dimensions, postMintOverrides));
  if (new Set(duplicateIds.map((id) => id.toString())).size > 0) throw new Error(`An identical AgentApproval circuit already exists: ${duplicateIds.join(",")}`);

  let overlappingRejected = false;
  let witness = "";
  try {
    await compileMachine(OVERLAPPING_REVOKED_SOURCE);
  } catch (error) {
    if (!(error instanceof GateXValidationError) || !error.message.includes("AMBIGUOUS_TRANSITION") || !error.message.includes("state=REQUESTED") || !error.message.includes("inputMask=50")) throw error;
    overlappingRejected = true;
    witness = "REQUESTED with approve=1, human_ok=1, scope_ok=1";
  }
  const disjointRevoked = await compileMachine(DISJOINT_REVOKED_SOURCE);
  const disjointComparison = await compareCandidateSimulation(disjointRevoked, localCandidateEvaluator(disjointRevoked));
  if (disjointComparison.casesCompared !== 512 || disjointComparison.mismatches.length > 0) throw new Error("REVOKED differentiation proof failed");

  const tapeout = buildCanonicalTapeoutTransaction(lock, { sender: deployment.creator, processor: deployment.processor, payload: extracted.payload, nIn: extracted.dimensions.nIn, nOut: extracted.dimensions.nOut, feeWei: first.inventory.tapeoutFeeWei });
  const tapeoutSimulations = await Promise.all(lock.snapshot.providers.map(async (provider) => ({ ...await simulate(clients.get(provider) as ReadOnlyRpcClient, tapeout, block.tag, postMintOverrides), provider })));
  const tapeoutEstimates = await Promise.all(lock.snapshot.providers.map(async (provider) => ({ ...await estimate(clients.get(provider) as ReadOnlyRpcClient, tapeout, block.tag, postMintOverrides), provider })));
  assertAgreement("AgentApproval tapeout simulation", tapeoutSimulations);
  assertAgreement("AgentApproval tapeout gas estimate", tapeoutEstimates);
  const postTapeoutOverrides = await tracePostState(traceClient, tapeout.request, block.tag, postMintOverrides);
  const simulatedCircuitIds = tapeoutSimulations.map((simulation) => decodeUint256(simulation.returnValue as string));
  if (new Set(simulatedCircuitIds.map((id) => id.toString())).size !== 1) throw new Error("AgentApproval tapeout simulated circuit IDs disagree");
  const readback: GateE0Result["tapeoutSimulation"]["readback"] = [];
  for (const provider of lock.snapshot.providers) {
    const client = clients.get(provider) as ReadOnlyRpcClient;
    const circuitId = simulatedCircuitIds[0] as bigint;
    const info = decodeCircuitInfo(await ethCall(client, { to: deployment.processor, data: encodeGateDCall(lock, "circuitInfo(uint256)", [circuitId]) }, block.tag, postTapeoutOverrides));
    const netlist = decodeBytesReturn(await ethCall(client, { to: deployment.processor, data: encodeGateDCall(lock, "netlist(uint256)", [circuitId]) }, block.tag, postTapeoutOverrides));
    const owner = decodeGateDAddress(await ethCall(client, { to: deployment.processor, data: encodeGateDCall(lock, "ownerOf(uint256)", [circuitId]) }, block.tag, postTapeoutOverrides));
    const candidate: CandidateEvaluator = { async evaluate(stateBytes, inputBytes) {
      const raw = await ethCall(client, { from: deployment.creator, to: deployment.processor, data: encodeCall(lock, "step(uint256,bytes,bytes)", [circuitId, stateBytes, inputBytes]) }, block.tag, postTapeoutOverrides);
      const step = decodeStep(raw);
      return { nextStateBytes: step.nextState, outputBytes: step.outputs };
    } };
    const comparison = await compareCandidateSimulationWithConcurrency(compiled, candidate, 8);
    const payloadSha256 = sha256Hex(gateDHexFromBytes(netlist));
    readback.push({ provider, circuitId, owner: address(owner), dimensions: info, payloadSha256, casesCompared: comparison.casesCompared, mismatches: comparison.mismatches });
    if (address(owner) !== deployment.creator || info.nIn !== dimensions.nIn || info.nOut !== dimensions.nOut || info.nState !== dimensions.nState || info.gateCount !== dimensions.gateCount || gateDHexFromBytes(netlist).toLowerCase() !== gateDHexFromBytes(extracted.payload).toLowerCase() || comparison.mismatches.length > 0) throw new Error(`${provider} AgentApproval simulated readback or 256-case comparison failed`);
  }

  const maxGasPrice = providers.reduce((max, provider) => provider.gasPriceWei > max ? provider.gasPriceWei : max, 0n);
  const gasEstimates = [...(mintSimulations.nand?.estimates ?? []), ...(mintSimulations.latch?.estimates ?? []), ...tapeoutEstimates];
  const gasCost = gasEstimates.reduce((total, estimateResult) => total + (estimateResult.gas ?? 0n) * maxGasPrice, 0n);
  const valueCost = mintTransactions.reduce((total, transaction) => total + parseQuantity(transaction.request.value ?? "0x0", "mint value"), 0n) + parseQuantity(tapeout.request.value ?? "0x0", "tapeout value");
  const mandatoryRemainingWei = valueCost + gasCost;
  const projectedCumulativeWei = deployment.budget.cumulativeProjectSpendBeforeGateEWei + mandatoryRemainingWei;
  const projectedBalanceWei = first.balanceWei - mandatoryRemainingWei;
  const budget = { currentBalanceWei: first.balanceWei, cumulativeBeforeWei: deployment.budget.cumulativeProjectSpendBeforeGateEWei, mandatoryRemainingWei, projectedCumulativeWei, projectedBalanceWei, remainingRoomWei: deployment.budget.projectCeilingWei - projectedCumulativeWei, contingencyWei: deployment.budget.desiredPostMandatoryContingencyWei, contingencySatisfied: projectedBalanceWei >= deployment.budget.desiredPostMandatoryContingencyWei };
  if (projectedCumulativeWei > deployment.budget.projectCeilingWei) throw new Error(`Projected Gate E spend exceeds project ceiling: ${projectedCumulativeWei}`);
  if (!budget.contingencySatisfied) throw new Error(`Projected Gate E balance does not preserve contingency: ${projectedBalanceWei}`);

  return {
    status: "PASS",
    label: "E0_PREFLIGHT",
    commonBlock: block,
    canonical: deployment,
    artifact,
    providers,
    deficits: { nand, latch },
    revocationKillTest: { overlappingRejected, witness, disjointCases: disjointComparison.casesCompared, mismatches: disjointComparison.mismatches },
    mintSimulations,
    sequentialSimulation: { label: "SIMULATION", providers: sequentialProviders },
    tapeoutSimulation: { transaction: tapeout, simulations: tapeoutSimulations, estimates: tapeoutEstimates, simulatedCircuitIds, readback },
    budget,
    duplicateSafety: { existingMatchingCircuitIds: duplicateIds, method: "Enumerate nextId() at the common block and match creator, dimensions, and exact TapeOut payload before manufacture." },
    blockers: []
  };
}

export async function runGateENandMintPreflight(lock: ProtocolLock, clients: ReadonlyMap<string, ReadOnlyRpcClient>): Promise<GateENandMintPreflight> {
  requireGateDProtocolFacts(lock);
  const canonical = loadCanonicalDeployment();
  assertCanonicalDeploymentSelected(canonical, canonical.processor, canonical.token);
  const compiled = await compileMachine(AGENT_APPROVAL_SOURCE);
  const { extractTapeOutPayload } = await import("./wire.js");
  const extracted = await extractTapeOutPayload(lock, compiled.bytes);
  const artifact = { nand: compiled.nandCount, latch: compiled.latchCount, records: compiled.artifact.records.length, localBytes: compiled.bytes.length, localSha256: compiled.hash, payloadBytes: extracted.payloadBytes, payloadSha256: extracted.payloadHash, nIn: extracted.dimensions.nIn, nOut: extracted.dimensions.nOut, nState: extracted.dimensions.nState };
  const block = await commonBlock(lock, clients);
  const providers = await Promise.all(lock.snapshot.providers.map(async (provider) => {
    const client = clients.get(provider);
    if (client === undefined) throw new Error(`No client for ${provider}`);
    return readProviderState(lock, canonical, client, provider, block);
  }));
  const first = providers[0];
  if (first === undefined) throw new Error("No provider state was returned");
  if (providers.some((provider) => provider.chainId !== lock.chainId || provider.blockHash !== block.hash)) throw new Error("Provider chain or common-block disagreement");
  if (providers.some((provider) => provider.inventory.nandBalance !== first.inventory.nandBalance || provider.inventory.latchBalance !== first.inventory.latchBalance || provider.inventory.minted !== first.inventory.minted || provider.inventory.cap !== first.inventory.cap || provider.inventory.priceWei !== first.inventory.priceWei || provider.inventory.fixedMintFeeWei !== first.inventory.fixedMintFeeWei)) throw new Error("Provider NAND mint state disagreement");
  const deficit = first.inventory.nandBalance >= BigInt(artifact.nand) ? 0n : BigInt(artifact.nand) - first.inventory.nandBalance;
  if (deficit <= 0n) throw new Error("NAND deficit is no longer positive; no mint transaction may be exposed");
  if (first.inventory.minted + deficit > first.inventory.cap) throw new Error("NAND mint would exceed the shared supply cap");
  const transaction = buildCanonicalMintTransaction(lock, { sender: canonical.creator, token: canonical.token, id: first.inventory.nandId, amount: deficit, priceWei: first.inventory.priceWei, protocolFeeWei: first.inventory.fixedMintFeeWei });
  const simulations = await Promise.all(lock.snapshot.providers.map(async (provider) => ({ ...await simulate(clients.get(provider) as ReadOnlyRpcClient, transaction, block.tag), provider })));
  const estimates = await Promise.all(lock.snapshot.providers.map(async (provider) => ({ ...await estimate(clients.get(provider) as ReadOnlyRpcClient, transaction, block.tag), provider })));
  assertAgreement("NAND mint simulation", simulations);
  assertAgreement("NAND mint gas estimate", estimates);
  return { commonBlock: block, canonical, artifact, providers, deficit, transaction, simulations, estimates };
}
