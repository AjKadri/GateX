export interface FixtureVector {
  state: string;
  inputs: string;
  expectedNextState: string;
  expectedOutputs: string;
  calldata: string;
  rawReturn: string;
  [key: string]: unknown;
}

export interface LiveFixture {
  name: string;
  processor: string;
  circuitId: string;
  netlist: string;
  dimensions: { nIn: number; nOut: number; nState: number; gateCount?: number };
  metadataSnapshot?: { result: string };
  blockTag: string;
  blockHash: string;
  method: "eval" | "step";
  vectors: FixtureVector[];
  [key: string]: unknown;
}

export interface TransientFixture {
  name: string;
  processor: string;
  circuitId: string;
  netlist: string;
  dimensions: { nIn: number; nOut: number; nState: number; gateCount?: number };
  blockTag: string;
  blockHash: string;
  vectors: FixtureVector[];
  simulationOnly: true;
  simulatedCircuitId: string;
  manufactureTraceRequest: { params: readonly unknown[]; [key: string]: unknown };
  tracePostState: Record<string, unknown>;
  reconstructedOverrides: Record<string, unknown>;
  readbackRequest: { params: readonly unknown[]; [key: string]: unknown };
  metadataRawReturn: string;
}

export interface CandidateBaseline {
  value: {
    blockTag: string;
    blockNumber: number;
    blockHash: string;
    traceProvider: string;
    evaluationProviders: string[];
    processor: string;
    token: string;
    sender: string;
    tapeoutValue: string;
    initialOverrides: Record<string, unknown>;
    assetQuantities: { nand: number; latch: number };
    simulatedIdAtPin: string;
    traceOptions: { tracer: string; tracerConfig: { diffMode: boolean }; stateOverrides: Record<string, unknown> };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GateCFixtureDocument {
  schemaVersion: number;
  project: string;
  kind: "TEST_DATA_NOT_PROTOCOL_CONSTANTS";
  historicalEvidenceOnly: true;
  liveFixtures: LiveFixture[];
  transientFixtures: TransientFixture[];
  candidateBaseline: CandidateBaseline;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Fixture field ${key} must be a string`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Fixture field ${key} must be a safe integer`);
  return value;
}

function parseVector(value: unknown): FixtureVector {
  if (!isRecord(value)) throw new Error("Fixture vector must be an object");
  requiredString(value, "state");
  requiredString(value, "inputs");
  requiredString(value, "expectedNextState");
  requiredString(value, "expectedOutputs");
  requiredString(value, "calldata");
  requiredString(value, "rawReturn");
  return value as FixtureVector;
}

function parseDimensions(value: unknown): { nIn: number; nOut: number; nState: number; gateCount?: number } {
  if (!isRecord(value)) throw new Error("Fixture dimensions must be an object");
  const dimensions = { nIn: requiredNumber(value, "nIn"), nOut: requiredNumber(value, "nOut"), nState: requiredNumber(value, "nState") } as { nIn: number; nOut: number; nState: number; gateCount?: number };
  if ("gateCount" in value) dimensions.gateCount = requiredNumber(value, "gateCount");
  return dimensions;
}

function parseCommonFixture(value: unknown): LiveFixture {
  if (!isRecord(value)) throw new Error("Fixture must be an object");
  const method = value.method === undefined ? "step" : requiredString(value, "method");
  if (method !== "eval" && method !== "step") throw new Error(`Unsupported fixture method ${method}`);
  if (!Array.isArray(value.vectors)) throw new Error("Fixture vectors must be an array");
  return {
    ...(value as LiveFixture),
    name: requiredString(value, "name"),
    processor: requiredString(value, "processor"),
    circuitId: requiredString(value, "circuitId"),
    netlist: requiredString(value, "netlist"),
    dimensions: parseDimensions(value.dimensions),
    blockTag: requiredString(value, "blockTag"),
    blockHash: requiredString(value, "blockHash"),
    method,
    vectors: value.vectors.map(parseVector)
  };
}

export function parseFixtureDocument(value: unknown): GateCFixtureDocument {
  if (!isRecord(value)) throw new Error("Gate C fixture document must be an object");
  if (value.kind !== "TEST_DATA_NOT_PROTOCOL_CONSTANTS" || value.historicalEvidenceOnly !== true) throw new Error("Gate C fixtures must remain historical test data");
  if (!Array.isArray(value.liveFixtures) || !Array.isArray(value.transientFixtures)) throw new Error("Gate C fixture arrays are missing");
  const liveFixtures = value.liveFixtures.map(parseCommonFixture);
  const transientFixtures = value.transientFixtures.map((item) => {
    if (!isRecord(item) || item.simulationOnly !== true) throw new Error("Transient fixture must be simulation-only");
    const common = parseCommonFixture({ ...(item as Record<string, unknown>), circuitId: item.simulatedCircuitId, method: "step" });
    return {
      ...common,
      ...(item as unknown as TransientFixture),
      simulationOnly: true as const,
      simulatedCircuitId: requiredString(item, "simulatedCircuitId"),
      manufactureTraceRequest: item.manufactureTraceRequest as TransientFixture["manufactureTraceRequest"],
      tracePostState: item.tracePostState as Record<string, unknown>,
      reconstructedOverrides: item.reconstructedOverrides as Record<string, unknown>,
      readbackRequest: item.readbackRequest as TransientFixture["readbackRequest"],
      metadataRawReturn: requiredString(item, "metadataRawReturn")
    };
  });
  if (!isRecord(value.candidateBaseline) || !isRecord(value.candidateBaseline.value)) throw new Error("Candidate baseline is missing");
  const baseline = value.candidateBaseline.value;
  requiredString(baseline, "blockTag");
  requiredNumber(baseline, "blockNumber");
  requiredString(baseline, "blockHash");
  requiredString(baseline, "traceProvider");
  requiredString(baseline, "processor");
  requiredString(baseline, "token");
  requiredString(baseline, "sender");
  requiredString(baseline, "tapeoutValue");
  requiredString(baseline, "simulatedIdAtPin");
  return {
    ...(value as GateCFixtureDocument),
    schemaVersion: requiredNumber(value, "schemaVersion"),
    project: requiredString(value, "project"),
    kind: "TEST_DATA_NOT_PROTOCOL_CONSTANTS",
    historicalEvidenceOnly: true,
    liveFixtures,
    transientFixtures,
    candidateBaseline: value.candidateBaseline as CandidateBaseline
  };
}
