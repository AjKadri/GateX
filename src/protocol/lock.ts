import lockDocument from "../../protocol/lock.json" with { type: "json" };
import type { IdentityTarget, MissingProtocolFact, ProtocolLock } from "./types.js";

export class GateCConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateCConfigurationError";
  }
}

export class GateCBlockedError extends Error {
  constructor(public readonly missing: MissingProtocolFact[]) {
    super(missing.map((item) => `${item.key}: ${item.reason}`).join("\n"));
    this.name = "GateCBlockedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new GateCConfigurationError(`Protocol lock field ${key} is missing or invalid`);
  return value;
}

export function loadProtocolLock(): ProtocolLock {
  const value: unknown = lockDocument;
  if (!isRecord(value)) throw new GateCConfigurationError("protocol/lock.json is not an object");
  const snapshot = value.snapshot;
  if (!isRecord(snapshot) || !Array.isArray(snapshot.providers) || snapshot.providers.length < 2) {
    throw new GateCConfigurationError("protocol/lock.json must lock at least two providers");
  }
  if (typeof value.chainId !== "number" || typeof snapshot.blockNumber !== "number") {
    throw new GateCConfigurationError("protocol/lock.json is missing chain or block identity");
  }
  if (!Array.isArray(value.dependencyRuntimeRecords)) {
    throw new GateCConfigurationError("protocol/lock.json is missing dependency runtime records");
  }
  requireString(snapshot, "blockHash");
  requireString(value, "warning");
  const gateC = value.gateC;
  if (!isRecord(gateC) || !Array.isArray(gateC.functions) || !isRecord(gateC.abiEncoding) || !isRecord(gateC.wireFormat) || !isRecord(gateC.candidateSimulation)) {
    throw new GateCConfigurationError("protocol/lock.json is missing the promoted Gate C protocol configuration");
  }
  return value as ProtocolLock;
}

function addTarget(targets: Map<string, IdentityTarget>, key: string, address: string, expectedRuntimeKeccak256: string): void {
  const normalizedAddress = address.toLowerCase();
  const existing = targets.get(normalizedAddress);
  if (existing !== undefined && existing.expectedRuntimeKeccak256.toLowerCase() !== expectedRuntimeKeccak256.toLowerCase()) {
    throw new GateCConfigurationError(`Conflicting runtime hashes for locked address ${address}`);
  }
  if (existing === undefined) targets.set(normalizedAddress, { key, address, expectedRuntimeKeccak256 });
}

export function identityTargets(lock: ProtocolLock): IdentityTarget[] {
  const targets = new Map<string, IdentityTarget>();
  addTarget(targets, "factory.proxy", lock.factory.proxy, lock.factory.proxyRuntimeKeccak256);
  addTarget(targets, "factory.implementation", lock.factory.implementation, lock.factory.implementationRuntimeKeccak256);
  addTarget(targets, "circuit.implementation", lock.circuit.implementation, lock.circuit.implementationRuntimeKeccak256);
  addTarget(targets, "transistor.implementation", lock.transistor.implementation, lock.transistor.implementationRuntimeKeccak256);
  addTarget(targets, "sample.processor", lock.sample.processor, lock.sample.processorRuntimeKeccak256);
  addTarget(targets, "sample.transistors", lock.sample.transistors, lock.sample.transistorProxyRuntimeKeccak256);
  for (const record of lock.dependencyRuntimeRecords) {
    addTarget(targets, `${record.role}:${record.address}`, record.address, record.runtimeKeccak256);
  }
  return [...targets.values()].sort((left, right) => left.address.toLowerCase().localeCompare(right.address.toLowerCase()));
}

export function missingGateCProtocolFacts(lock: ProtocolLock): MissingProtocolFact[] {
  const missing: MissingProtocolFact[] = [];
  const required = ["netlist(uint256)", "circuitInfo(uint256)", "eval(uint256,bytes)", "step(uint256,bytes,bytes)", "tapeout(bytes,uint32,uint32)"];
  const functions = lock.gateC?.functions ?? [];
  for (const signature of required) {
    const entry = functions.find((candidate) => candidate.signature === signature);
    if (entry === undefined || !/^0x[0-9a-fA-F]{8}$/.test(entry.selector)) {
      missing.push({ key: `protocol/lock.json gateC.functions.${signature}`, reason: "The locked function signature or selector is missing" });
    }
  }
  if (lock.gateC?.candidateSimulation?.label !== "SIMULATION") {
    missing.push({ key: "protocol/lock.json gateC.candidateSimulation", reason: "The exact read-only candidate procedure is not locked with the SIMULATION label" });
  }
  if (lock.gateC?.wireFormat?.header !== false || lock.gateC?.wireFormat?.padding !== false || lock.gateC?.wireFormat?.terminator !== false) {
    missing.push({ key: "protocol/lock.json gateC.wireFormat", reason: "The raw TapeOut payload boundary is not locked" });
  }
  return missing;
}

export function requireGateCProtocolFacts(lock: ProtocolLock): void {
  const missing = missingGateCProtocolFacts(lock);
  if (missing.length > 0) throw new GateCBlockedError(missing);
}
