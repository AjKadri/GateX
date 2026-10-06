import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticFromError, route } from "../src/app/ui-state.js";
import { SESSION_STORAGE_KEY, readSessions, sessionKey, writeSessions, type BrowserSession } from "../src/app/session.js";

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

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}
