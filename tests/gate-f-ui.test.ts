import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticFromError, route } from "../src/app/ui-state.js";
import { SESSION_STORAGE_KEY, readSessions, sessionKey, writeSessions, type BrowserSession } from "../src/app/session.js";
import { compileMachine } from "../src/compiler/compiler.js";
import { AGENT_APPROVAL_SOURCE } from "../src/examples/agentApproval.js";
import { assessGasInclusiveSufficiency, liveVerificationStatus, verifyArtifactBinding, type CircuitBindingReadback } from "../src/app/binding.js";

test("Gate F route contract is limited to overview, workspace and evidence", () => {
  assert.equal(route(""), "/");
  assert.equal(route("#/workspace"), "/workspace");
  assert.equal(route("#/evidence"), "/evidence");
  assert.equal(route("#/wallet"), "/");
});

test("Gate F diagnostics expose stable codes and locations for invalid source", () => {
  const diagnostics = diagnosticFromError(new Error("AMBIGUOUS_TRANSITION state=READY inputMask=1"), "machine X {\n  state READY;\n}");
  assert.equal(diagnostics[0]?.code, "AMBIGUOUS_TRANSITION");
  assert.equal(diagnostics[0]?.location, "line 1");
});

test("browser sessions are keyed by artifact, chain, processor and circuit", () => {
  const session: BrowserSession = { artifactDigest: "abc", chainId: 196, processor: "0xProcessor", circuitId: "2", sourceDigest: "abc", activeState: "IDLE", history: [{ state: "IDLE", inputs: {}, localNext: "REQUESTED", localOutput: "0x00", origin: "LOCAL SIMULATION", recordedAt: "2026-10-06T00:00:00.000Z" }] };
  const storage = new MemoryStorage();
  writeSessions([session], storage);
  assert.equal(storage.getItem(SESSION_STORAGE_KEY)?.includes("LOCAL SIMULATION"), true);
  assert.equal(readSessions(storage)[0]?.activeState, "IDLE");
  assert.notEqual(sessionKey(session), sessionKey({ ...session, circuitId: "1" }));
});

function acceptedReadback(overrides: Partial<CircuitBindingReadback> = {}): CircuitBindingReadback {
  return { status: "ready", circuitId: "2", owner: "0xcreator", processor: "0xprocessor", nIn: 6, nOut: 1, nState: 2, gateCount: 100, payloadBytes: 694, payloadSha256: "0xpayload", expectedPayloadSha256: "0xpayload", ...overrides };
}

function acceptedBinding(source: string, readback: CircuitBindingReadback | undefined) {
  return verifyArtifactBinding({ source, expectedSource: AGENT_APPROVAL_SOURCE, deterministic: true, artifactMatch: true, localHash: "0xlocal", expectedLocalHash: "0xlocal", payloadBytes: 694, expectedPayloadBytes: 694, payloadHash: "0xpayload", expectedPayloadHash: "0xpayload", expectedDimensions: { nIn: 6, nOut: 1, nState: 2, gateCount: 100 }, expectedCircuitId: "2", expectedProcessor: "0xprocessor", readback });
}

test("a different valid source cannot use AgentApproval circuit 2", async () => {
  const differentValidSource = AGENT_APPROVAL_SOURCE.replace("inputs request, approve, execute, cancel, human_ok, scope_ok;", "inputs request, approve, execute, cancel, human_ok, scope_ok, reviewer_ok;").replace("execute && human_ok && scope_ok emit permit;", "execute && human_ok && scope_ok && reviewer_ok emit permit;");
  await compileMachine(differentValidSource);
  assert.equal(acceptedBinding(differentValidSource, acceptedReadback()).status, "STALE");
  assert.equal(acceptedBinding(differentValidSource, acceptedReadback()).liveReady, false);
});

test("artifact mismatch is FAILED and RPC/readback failure is UNAVAILABLE", () => {
  assert.equal(acceptedBinding(AGENT_APPROVAL_SOURCE, acceptedReadback({ payloadSha256: "0xwrong" })).status, "FAILED");
  assert.equal(acceptedBinding(AGENT_APPROVAL_SOURCE, acceptedReadback({ status: "unavailable", detail: "RPC timeout" })).status, "UNAVAILABLE");
  assert.equal(liveVerificationStatus(acceptedReadback(), 1), "FAILED");
});

test("fresh readback is required before current-session LIVE X LAYER binding", () => {
  const result = acceptedBinding(AGENT_APPROVAL_SOURCE, undefined);
  assert.equal(result.status, "PENDING");
  assert.equal(result.liveReady, false);
});

test("gasless quote never claims gas-inclusive sufficiency", () => {
  const assessment = assessGasInclusiveSufficiency(10n, 5n, undefined);
  assert.equal(assessment.status, "UNAVAILABLE");
  assert.equal(assessment.label, "PROTOCOL VALUE BEFORE GAS");
});

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}
