import deploymentDocument from "../../deployments/xlayer-mainnet.json" with { type: "json" };

export interface DeploymentMetadata {
  name: string;
  symbol: string;
  story: string;
  cap: bigint;
  priceWei: bigint;
}

export interface DeploymentBudget {
  cumulativeProjectSpendBeforeD2Wei: bigint;
  projectCeilingWei: bigint;
  desiredPostMandatoryContingencyWei: bigint;
}

export interface CanonicalDeployment {
  chainId: number;
  status: "FINAL_GATE_X_DEPLOYMENT";
  processor: string;
  token: string;
  creator: string;
  creationTransaction: string;
  creationBlock: number;
  creationBlockHash: string;
  registryIndex: number;
  approvedCreationCalldataSha256: string;
  runtimeKeccak256: { processor: string; token: string };
  metadata: DeploymentMetadata;
  budget: DeploymentBudget;
  quarantine: { status: "ACCIDENTAL_DEPLOYMENT_DO_NOT_USE"; processor: string; token: string; creationTransaction: string };
}

export class DeploymentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentConfigurationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) throw new DeploymentConfigurationError(`Deployment manifest field ${key} is invalid`);
  return field;
}

function addressField(value: Record<string, unknown>, key: string): string {
  const address = stringField(value, key);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new DeploymentConfigurationError(`Deployment manifest field ${key} is not an address`);
  return address.toLowerCase();
}

function hashField(value: Record<string, unknown>, key: string): string {
  const hash = stringField(value, key);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new DeploymentConfigurationError(`Deployment manifest field ${key} is not a 32-byte hash`);
  return hash.toLowerCase();
}

function uintField(value: Record<string, unknown>, key: string): bigint {
  const raw = stringField(value, key);
  if (!/^[0-9]+$/.test(raw)) throw new DeploymentConfigurationError(`Deployment manifest field ${key} is not a decimal integer`);
  return BigInt(raw);
}

function safeNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new DeploymentConfigurationError(`Deployment manifest field ${key} is not a safe nonnegative integer`);
  return value;
}

function assertDifferent(label: string, first: string, second: string): void {
  if (first.toLowerCase() === second.toLowerCase()) throw new DeploymentConfigurationError(`Canonical ${label} is quarantined`);
}

export function loadCanonicalDeployment(): CanonicalDeployment {
  const value: unknown = deploymentDocument;
  if (!isRecord(value)) throw new DeploymentConfigurationError("Deployment manifest is not an object");
  const metadata = value.metadata;
  const runtime = value.runtimeKeccak256;
  const budget = value.budget;
  const quarantine = value.quarantine;
  if (!isRecord(metadata) || !isRecord(runtime) || !isRecord(budget) || !isRecord(quarantine)) throw new DeploymentConfigurationError("Deployment manifest sections are incomplete");
  const processor = addressField(value, "processor");
  const token = addressField(value, "token");
  const quarantineProcessor = addressField(quarantine, "processor");
  const quarantineToken = addressField(quarantine, "token");
  assertDifferent("processor", processor, quarantineProcessor);
  assertDifferent("token", token, quarantineToken);
  if (value.status !== "FINAL_GATE_X_DEPLOYMENT") throw new DeploymentConfigurationError("Deployment manifest is not marked FINAL_GATE_X_DEPLOYMENT");
  if (quarantine.status !== "ACCIDENTAL_DEPLOYMENT_DO_NOT_USE") throw new DeploymentConfigurationError("Deployment quarantine status is missing");
  const result: CanonicalDeployment = {
    chainId: safeNumber(value.chainId, "chainId"),
    status: "FINAL_GATE_X_DEPLOYMENT",
    processor,
    token,
    creator: addressField(value, "creator"),
    creationTransaction: hashField(value, "creationTransaction"),
    creationBlock: safeNumber(value.creationBlock, "creationBlock"),
    creationBlockHash: hashField(value, "creationBlockHash"),
    registryIndex: safeNumber(value.registryIndex, "registryIndex"),
    approvedCreationCalldataSha256: hashField(value, "approvedCreationCalldataSha256"),
    runtimeKeccak256: { processor: hashField(runtime, "processor"), token: hashField(runtime, "token") },
    metadata: {
      name: stringField(metadata, "name"),
      symbol: stringField(metadata, "symbol"),
      story: stringField(metadata, "story"),
      cap: uintField(metadata, "cap"),
      priceWei: uintField(metadata, "priceWei")
    },
    budget: {
      cumulativeProjectSpendBeforeD2Wei: uintField(budget, "cumulativeProjectSpendBeforeD2Wei"),
      projectCeilingWei: uintField(budget, "projectCeilingWei"),
      desiredPostMandatoryContingencyWei: uintField(budget, "desiredPostMandatoryContingencyWei")
    },
    quarantine: {
      status: "ACCIDENTAL_DEPLOYMENT_DO_NOT_USE",
      processor: quarantineProcessor,
      token: quarantineToken,
      creationTransaction: hashField(quarantine, "creationTransaction")
    }
  };
  if (result.chainId !== 196) throw new DeploymentConfigurationError(`Deployment manifest chain ${result.chainId} is not X Layer 196`);
  if (result.budget.cumulativeProjectSpendBeforeD2Wei > result.budget.projectCeilingWei) throw new DeploymentConfigurationError("Recorded cumulative project spend exceeds ceiling");
  return result;
}

export function assertCanonicalDeploymentSelected(deployment: CanonicalDeployment, processor: string, token: string): void {
  if (processor.toLowerCase() !== deployment.processor || token.toLowerCase() !== deployment.token) throw new DeploymentConfigurationError("Selected deployment does not match the canonical manifest");
  assertDifferent("processor", processor, deployment.quarantine.processor);
  assertDifferent("token", token, deployment.quarantine.token);
}
