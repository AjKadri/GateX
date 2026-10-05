export interface SnapshotLock {
  blockNumber: number;
  blockHash: string;
  timestampUTC: string;
  providers: string[];
}

export interface RuntimeRecord {
  role: string;
  address: string;
  runtimeKeccak256: string;
  [key: string]: unknown;
}

export interface ProtocolLock {
  project: string;
  status: string;
  updatedLocalDate: string;
  timezone: string;
  chainId: number;
  snapshot: SnapshotLock;
  factory: {
    proxy: string;
    implementation: string;
    implementationRuntimeKeccak256: string;
    proxyRuntimeKeccak256: string;
    [key: string]: unknown;
  };
  circuit: {
    beacon: string;
    implementation: string;
    implementationRuntimeKeccak256: string;
    [key: string]: unknown;
  };
  transistor: {
    beacon: string;
    implementation: string;
    implementationRuntimeKeccak256: string;
    [key: string]: unknown;
  };
  sample: {
    processor: string;
    transistors: string;
    processorRuntimeKeccak256: string;
    transistorProxyRuntimeKeccak256: string;
    [key: string]: unknown;
  };
  dependencyRuntimeRecords: RuntimeRecord[];
  semantics: {
    nandOpcode: number;
    latchOpcode: number;
    indexEncoding: string;
    vectorPacking: string;
    outputs: string;
    stepState: string;
    [key: string]: unknown;
  };
  fundsWritingAuthorized: boolean;
  warning: string;
  gateC: GateCProtocolConfig;
  gateD?: GateDProtocolConfig;
  [key: string]: unknown;
}

export interface LockedFunction {
  signature: string;
  selector: string;
  abi: {
    type: "function";
    name: string;
    inputs: Array<{ name: string; type: string }>;
    outputs: Array<{ name: string; type: string }>;
    stateMutability: string;
  };
  use: string;
}

export interface GateCProtocolConfig {
  contractRoles: Record<string, string>;
  functions: LockedFunction[];
  abiEncoding: Record<string, unknown>;
  wireFormat: {
    header: boolean;
    padding: boolean;
    terminator: boolean;
    dimensions: string;
    signals: { zero: number; one: number; inputStart: number; producedStart: string };
    nand: { opcode: number; bytes: number; fields: string; behavior: string };
    latch: { opcode: number; bytes: number; fields: string; behavior: string; forwardDAllowed: boolean };
    outputPlacement: string;
    vectorPacking: string;
    scope: string;
  };
  candidateSimulation: {
    label: "SIMULATION";
    name: string;
    steps: string[];
    requiredRpc: string[];
    failurePolicy: string;
    isolation: string;
  };
  warnings: string[];
}

export interface LockedEvent {
  signature: string;
  topic0: string;
  fragment: string;
  role: string;
  decoding: Record<string, unknown>;
}

export interface GateDProtocolConfig {
  status: string;
  contractRoles: Record<string, string>;
  functions: LockedFunction[];
  events: LockedEvent[];
  currentSnapshot: Record<string, unknown>;
  creation: Record<string, unknown>;
  acquisition: Record<string, unknown>;
  tapeout: Record<string, unknown>;
  duplicateSafety: Record<string, unknown>;
  constraints: Record<string, unknown>;
  warnings: string[];
  [key: string]: unknown;
}

export interface IdentityTarget {
  key: string;
  address: string;
  expectedRuntimeKeccak256: string;
}

export interface IdentityCheck {
  key: string;
  address: string;
  expectedRuntimeKeccak256: string;
  observedRuntimeKeccak256: string;
}

export interface ProviderVerification {
  provider: string;
  chainId: number;
  blockNumber: number;
  blockHash: string;
  identities: IdentityCheck[];
}

export interface ProviderVerificationSummary {
  providers: ProviderVerification[];
  pinnedBlockNumber: number;
  pinnedBlockHash: string;
}

export interface MissingProtocolFact {
  key: string;
  reason: string;
}

export interface CandidateComparisonResult {
  label: "SIMULATION";
  transactionSent: false;
  walletSignatureRequested: false;
  casesCompared: number;
  mismatches: string[];
}
