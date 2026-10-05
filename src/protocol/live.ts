import type { CompiledMachine } from "../compiler/types.js";
import { compareCandidateSimulation, type CandidateEvaluator } from "./candidate.js";
import { bytesFromHex, decodeBytesReturn, decodeCircuitInfo, decodeStep, decodeUint256, encodeCall, hexFromBytes } from "./abi.js";
import type { GateCFixtureDocument, LiveFixture, TransientFixture } from "./fixtures.js";
import { reconstructPostState, stateOverridesEqual } from "./overrides.js";
import type { ProtocolLock } from "./types.js";
import type { ReadOnlyRpcClient } from "./rpc.js";
import type { TapeOutPayload } from "./wire.js";

export interface FixtureRunResult {
  name: string;
  providers: number;
  vectors: number;
  mismatches: string[];
}

export interface GateCLiveResult {
  label: "SIMULATION";
  identityProviders: number;
  fixtureResults: FixtureRunResult[];
  transientResults: FixtureRunResult[];
  candidate: {
    circuitId: string;
    casesCompared: number;
    providerCasesCompared: number;
    mismatches: string[];
    reconstructedOverridesAvailable: boolean;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseString(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`${label} did not return hex bytes`);
  return value;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function assertEqual(expected: string, observed: string, label: string, mismatches: string[]): void {
  if (lower(expected) !== lower(observed)) mismatches.push(`${label}: expected ${expected}, observed ${observed}`);
}

function decodeBytesWithContext(value: string, label: string): Uint8Array {
  try {
    return decodeBytesReturn(value);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)} (length=${value.length}, prefix=${value.slice(0, 74)})`);
  }
}

function decodeStepWithContext(value: string, label: string): ReturnType<typeof decodeStep> {
  try {
    return decodeStep(value);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)} (length=${value.length}, prefix=${value.slice(0, 74)})`);
  }
}

function callParams(to: string, data: string, blockTag: string, overrides?: unknown, from?: string, value?: string): readonly unknown[] {
  const call: Record<string, string> = { to, data };
  if (from !== undefined) call.from = from;
  if (value !== undefined) call.value = value;
  return overrides === undefined ? [call, blockTag] : [call, blockTag, overrides];
}

async function ethCall(client: ReadOnlyRpcClient, params: readonly unknown[]): Promise<string> {
  return responseString(await client.request("eth_call", params), "eth_call");
}

async function assertFixtureBlock(client: ReadOnlyRpcClient, fixture: { blockTag: string; blockHash: string }, mismatches: string[], label: string): Promise<void> {
  const value = await client.request("eth_getBlockByNumber", [fixture.blockTag, false]);
  if (!isRecord(value) || typeof value.hash !== "string") throw new Error(`${label} fixture block is unavailable`);
  assertEqual(fixture.blockHash, value.hash, `${label} block hash`, mismatches);
}

function expectedFixtureDimensions(fixture: LiveFixture): { nIn: number; nOut: number; nState: number; gateCount?: number } {
  return fixture.dimensions;
}

function isEvalCall(lock: ProtocolLock, calldata: string): boolean {
  const selector = lock.gateC.functions.find((entry) => entry.signature === "eval(uint256,bytes)")?.selector;
  if (selector === undefined) throw new Error("Locked eval selector is missing");
  return calldata.slice(0, 10).toLowerCase() === selector.toLowerCase();
}

async function runFixtureOnProvider(lock: ProtocolLock, fixture: LiveFixture, client: ReadOnlyRpcClient, provider: string): Promise<FixtureRunResult> {
  const mismatches: string[] = [];
  await assertFixtureBlock(client, fixture, mismatches, `${provider} ${fixture.name}`);
  const infoData = encodeCall(lock, "circuitInfo(uint256)", [fixture.circuitId]);
  const infoRaw = await ethCall(client, callParams(fixture.processor, infoData, fixture.blockTag));
  const info = decodeCircuitInfo(infoRaw);
  const dimensions = expectedFixtureDimensions(fixture);
  for (const key of ["nIn", "nOut", "nState"] as const) if (info[key] !== dimensions[key]) mismatches.push(`${fixture.name} ${provider} circuitInfo.${key}: expected ${dimensions[key]}, observed ${info[key]}`);
  if (dimensions.gateCount !== undefined && info.gateCount !== dimensions.gateCount) mismatches.push(`${fixture.name} ${provider} circuitInfo.gateCount: expected ${dimensions.gateCount}, observed ${info.gateCount}`);
  if (fixture.metadataSnapshot !== undefined) assertEqual(fixture.metadataSnapshot.result, infoRaw, `${fixture.name} ${provider} circuitInfo raw`, mismatches);
  const netlistData = encodeCall(lock, "netlist(uint256)", [fixture.circuitId]);
  const netlistRaw = await ethCall(client, callParams(fixture.processor, netlistData, fixture.blockTag));
  const netlist = hexFromBytes(decodeBytesWithContext(netlistRaw, `${fixture.name} ${provider} netlist`));
  assertEqual(fixture.netlist, netlist, `${fixture.name} ${provider} netlist`, mismatches);
  for (const [index, vector] of fixture.vectors.entries()) {
    const observedCalldata = vector.calldata;
    const result = await ethCall(client, callParams(fixture.processor, observedCalldata, fixture.blockTag));
    assertEqual(vector.calldata, observedCalldata, `${fixture.name} vector ${index} calldata`, mismatches);
    assertEqual(vector.rawReturn, result, `${fixture.name} ${provider} vector ${index} raw`, mismatches);
    if (fixture.method === "eval") {
      const outputs = hexFromBytes(decodeBytesWithContext(result, `${fixture.name} ${provider} vector ${index} eval`));
      assertEqual(vector.expectedOutputs, outputs, `${fixture.name} ${provider} vector ${index} outputs`, mismatches);
    } else {
      const step = decodeStepWithContext(result, `${fixture.name} ${provider} vector ${index} step`);
      assertEqual(vector.expectedNextState, hexFromBytes(step.nextState), `${fixture.name} ${provider} vector ${index} nextState`, mismatches);
      assertEqual(vector.expectedOutputs, hexFromBytes(step.outputs), `${fixture.name} ${provider} vector ${index} outputs`, mismatches);
    }
  }
  return { name: fixture.name, providers: 1, vectors: fixture.vectors.length, mismatches };
}

async function runLiveFixture(lock: ProtocolLock, fixture: LiveFixture, clients: ReadonlyMap<string, ReadOnlyRpcClient>): Promise<FixtureRunResult> {
  const results: FixtureRunResult[] = [];
  let baseline: string | undefined;
  for (const provider of lock.snapshot.providers) {
    const client = clients.get(provider);
    if (client === undefined) throw new Error(`No client for ${provider}`);
    const result = await runFixtureOnProvider(lock, fixture, client, provider);
    results.push({ ...result, providers: lock.snapshot.providers.length });
    const fingerprint = JSON.stringify(result.mismatches);
    if (baseline === undefined) baseline = fingerprint;
    else if (fingerprint !== baseline) throw new Error(`${fixture.name} provider disagreement: observed mismatch sets differ`);
  }
  return {
    name: fixture.name,
    providers: lock.snapshot.providers.length,
    vectors: fixture.vectors.length,
    mismatches: results.flatMap((result) => result.mismatches)
  };
}

async function runTransientFixture(lock: ProtocolLock, fixture: TransientFixture, clients: ReadonlyMap<string, ReadOnlyRpcClient>): Promise<FixtureRunResult> {
  const mismatches: string[] = [];
  const traceProvider = lock.snapshot.providers[1] ?? lock.snapshot.providers[0];
  if (traceProvider === undefined) throw new Error("No locked trace provider");
  const traceClient = clients.get(traceProvider);
  if (traceClient === undefined) throw new Error(`No client for ${traceProvider}`);
  const requestParams = fixture.manufactureTraceRequest.params;
  if (requestParams.length !== 3) throw new Error(`${fixture.name} trace request does not have three params`);
  const trace = await traceClient.request("debug_traceCall", requestParams);
  if (!isRecord(requestParams[2]) || !isRecord(requestParams[2].stateOverrides)) throw new Error(`${fixture.name} trace request has no stateOverrides`);
  const reconstructed = reconstructPostState(requestParams[2].stateOverrides, trace);
  if (!stateOverridesEqual(reconstructed, fixture.reconstructedOverrides)) mismatches.push(`${fixture.name} reconstructed overrides differ from recovered fixture`);

  let baseline: { info: string; netlist: string; vectors: string[] } | undefined;
  for (const provider of lock.snapshot.providers) {
    const client = clients.get(provider);
    if (client === undefined) throw new Error(`No client for ${provider}`);
    const infoRaw = await ethCall(client, callParams(fixture.processor, encodeCall(lock, "circuitInfo(uint256)", [fixture.simulatedCircuitId]), fixture.blockTag, reconstructed));
    const info = decodeCircuitInfo(infoRaw);
    const netlistRaw = await ethCall(client, callParams(fixture.processor, encodeCall(lock, "netlist(uint256)", [fixture.simulatedCircuitId]), fixture.blockTag, reconstructed));
    const netlist = hexFromBytes(decodeBytesWithContext(netlistRaw, `${fixture.name} ${provider} netlist`));
    if (info.nIn !== fixture.dimensions.nIn || info.nOut !== fixture.dimensions.nOut || info.nState !== fixture.dimensions.nState || (fixture.dimensions.gateCount !== undefined && info.gateCount !== fixture.dimensions.gateCount)) {
      mismatches.push(`${fixture.name} ${provider} dimensions differ`);
    }
    assertEqual(fixture.netlist, netlist, `${fixture.name} ${provider} netlist`, mismatches);
    assertEqual(fixture.metadataRawReturn, infoRaw, `${fixture.name} ${provider} metadata raw`, mismatches);
    const vectorReturns: string[] = [];
    for (const [index, vector] of fixture.vectors.entries()) {
      const result = await ethCall(client, callParams(fixture.processor, vector.calldata, fixture.blockTag, reconstructed));
      vectorReturns.push(result.toLowerCase());
      assertEqual(vector.rawReturn, result, `${fixture.name} ${provider} vector ${index} raw`, mismatches);
      if (isEvalCall(lock, vector.calldata)) {
        assertEqual(vector.expectedOutputs, hexFromBytes(decodeBytesWithContext(result, `${fixture.name} ${provider} vector ${index} eval`)), `${fixture.name} ${provider} vector ${index} outputs`, mismatches);
      } else {
        const decoded = decodeStepWithContext(result, `${fixture.name} ${provider} vector ${index} step`);
        assertEqual(vector.expectedNextState, hexFromBytes(decoded.nextState), `${fixture.name} ${provider} vector ${index} nextState`, mismatches);
        assertEqual(vector.expectedOutputs, hexFromBytes(decoded.outputs), `${fixture.name} ${provider} vector ${index} outputs`, mismatches);
      }
    }
    const fingerprint = { info: infoRaw.toLowerCase(), netlist: netlistRaw.toLowerCase(), vectors: vectorReturns };
    if (baseline === undefined) baseline = fingerprint;
    else if (JSON.stringify(fingerprint) !== JSON.stringify(baseline)) throw new Error(`${fixture.name} providers disagree on transient readback`);
  }
  return { name: fixture.name, providers: lock.snapshot.providers.length, vectors: fixture.vectors.length, mismatches };
}

function liveCandidateEvaluator(lock: ProtocolLock, processor: string, circuitId: string, blockTag: string, overrides: unknown, client: ReadOnlyRpcClient): CandidateEvaluator {
  return {
    async evaluate(stateBytes, inputBytes) {
      const raw = await ethCall(client, callParams(processor, encodeCall(lock, "step(uint256,bytes,bytes)", [circuitId, stateBytes, inputBytes]), blockTag, overrides));
      const decoded = decodeStepWithContext(raw, "candidate step");
      return { nextStateBytes: decoded.nextState, outputBytes: decoded.outputs };
    }
  };
}

export async function runGateCLive(lock: ProtocolLock, fixtures: GateCFixtureDocument, compiled: CompiledMachine, tapeoutPayload: TapeOutPayload, clients: ReadonlyMap<string, ReadOnlyRpcClient>, identityProviders: number): Promise<GateCLiveResult> {
  const fixtureResults: FixtureRunResult[] = [];
  for (const fixture of fixtures.liveFixtures) fixtureResults.push(await runLiveFixture(lock, fixture, clients));
  const transientResults: FixtureRunResult[] = [];
  for (const fixture of fixtures.transientFixtures) transientResults.push(await runTransientFixture(lock, fixture, clients));

  const baseline = fixtures.candidateBaseline.value;
  const traceProvider = clients.get(baseline.traceProvider);
  if (traceProvider === undefined) throw new Error(`Candidate trace provider ${baseline.traceProvider} is not locked`);
  const initialOverrides = baseline.initialOverrides;
  const tapeoutData = encodeCall(lock, "tapeout(bytes,uint32,uint32)", [tapeoutPayload.payload, tapeoutPayload.dimensions.nIn, tapeoutPayload.dimensions.nOut]);
  const tapeoutCall = { to: baseline.processor, from: baseline.sender, data: tapeoutData, value: baseline.tapeoutValue };
  const ids: string[] = [];
  for (const provider of lock.snapshot.providers) {
    const client = clients.get(provider);
    if (client === undefined) throw new Error(`No client for ${provider}`);
    const raw = await ethCall(client, [tapeoutCall, baseline.blockTag, initialOverrides]);
    ids.push(decodeUint256(raw).toString());
  }
  if (new Set(ids).size !== 1) throw new Error(`Candidate tapeout simulation provider disagreement: ${ids.join(",")}`);
  const circuitId = ids[0] as string;
  const trace = await traceProvider.request("debug_traceCall", [tapeoutCall, baseline.blockTag, { tracer: "prestateTracer", tracerConfig: { diffMode: true }, stateOverrides: initialOverrides }]);
  const reconstructed = reconstructPostState(initialOverrides, trace);
  const candidateMismatches: string[] = [];
  let baselineReadback: { info: string; netlist: string } | undefined;
  const providerEvaluators: CandidateEvaluator[] = [];
  for (const provider of lock.snapshot.providers) {
    const client = clients.get(provider);
    if (client === undefined) throw new Error(`No client for ${provider}`);
    const infoRaw = await ethCall(client, callParams(baseline.processor, encodeCall(lock, "circuitInfo(uint256)", [circuitId]), baseline.blockTag, reconstructed));
    const info = decodeCircuitInfo(infoRaw);
    if (info.nIn !== tapeoutPayload.dimensions.nIn || info.nOut !== tapeoutPayload.dimensions.nOut || info.nState !== tapeoutPayload.dimensions.nState || info.gateCount !== tapeoutPayload.dimensions.gateCount) candidateMismatches.push(`${provider} candidate dimensions mismatch`);
    const netlistRaw = await ethCall(client, callParams(baseline.processor, encodeCall(lock, "netlist(uint256)", [circuitId]), baseline.blockTag, reconstructed));
    const netlist = hexFromBytes(decodeBytesWithContext(netlistRaw, `${provider} candidate netlist`));
    assertEqual(hexFromBytes(tapeoutPayload.payload), netlist, `${provider} candidate netlist`, candidateMismatches);
    const fingerprint = { info: infoRaw.toLowerCase(), netlist: netlistRaw.toLowerCase() };
    if (baselineReadback === undefined) baselineReadback = fingerprint;
    else if (JSON.stringify(fingerprint) !== JSON.stringify(baselineReadback)) candidateMismatches.push("candidate providers disagree on readback");
    providerEvaluators.push(liveCandidateEvaluator(lock, baseline.processor, circuitId, baseline.blockTag, reconstructed, client));
  }
  const comparisons = await Promise.all(providerEvaluators.map((evaluator) => compareCandidateSimulation(compiled, evaluator)));
  for (const comparison of comparisons) candidateMismatches.push(...comparison.mismatches);
  if (circuitId !== baseline.simulatedIdAtPin) candidateMismatches.push(`candidate ID: expected ${baseline.simulatedIdAtPin}, observed ${circuitId}`);
  const candidate = {
    circuitId,
    casesCompared: comparisons[0]?.casesCompared ?? 0,
    providerCasesCompared: comparisons.reduce((total, comparison) => total + comparison.casesCompared, 0),
    mismatches: candidateMismatches,
    reconstructedOverridesAvailable: true
  };
  return { label: "SIMULATION", identityProviders, fixtureResults, transientResults, candidate };
}
