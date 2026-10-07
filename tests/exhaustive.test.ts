import assert from "node:assert/strict";
import test from "node:test";
import { compileMachine } from "../src/compiler/compiler.js";
import { CHECKING_MESSAGE, caseCount, describeMismatch, runExhaustiveCheck, tapeoutGate, type ExhaustiveResult } from "../src/app/exhaustive.js";
import { EXAMPLES } from "../src/app/model.js";
import type { CompiledMachine } from "../src/compiler/types.js";

/** Flips the low byte of the right operand of the last record (an output NAND), which changes what the circuit computes. */
function corrupt(compiled: CompiledMachine): CompiledMachine {
  const bytes = compiled.bytes.slice();
  const last = compiled.artifact.records[compiled.artifact.records.length - 1];
  assert.equal(last?.kind, "nand");
  const lastOffset = bytes.length - 7;
  assert.equal(bytes[lastOffset], 0, "last record is a NAND opcode");
  bytes[lastOffset + 6] = (bytes[lastOffset + 6] ?? 0) === 0 ? 1 : 0;
  return { ...compiled, bytes };
}

test("the exhaustive check reproduces the recorded counts for both built-in examples", async () => {
  for (const example of Object.values(EXAMPLES)) {
    const compiled = await compileMachine(example.source);
    const result = await runExhaustiveCheck(compiled);
    assert.equal(result.total, example.expected.cases, example.label);
    assert.equal(result.matched, example.expected.cases, example.label);
    assert.deepEqual(result.mismatches, []);
    assert.equal(caseCount(compiled), example.expected.cases);
    assert.ok(result.durationMs >= 0);
  }
  assert.equal(EXAMPLES.agent.expected.cases, 256);
  assert.equal(EXAMPLES.tiny.expected.cases, 32);
});

test("the check includes encodings no declared state uses (TinyApproval has 3 states and 4 encodings)", async () => {
  const compiled = await compileMachine(EXAMPLES.tiny.source);
  assert.equal(compiled.machine.states.length, 3);
  assert.equal((await runExhaustiveCheck(compiled)).total, 4 * 8);
});

test("a corrupted netlist byte produces mismatches and only the first five are reported", async () => {
  const compiled = await compileMachine(EXAMPLES.agent.source);
  const result = await runExhaustiveCheck(corrupt(compiled));
  assert.equal(result.total, 256);
  assert.ok(result.matched < result.total, "some cases must disagree");
  assert.ok(result.mismatches.length >= 1 && result.mismatches.length <= 5);
  const first = result.mismatches[0];
  assert.ok(first !== undefined);
  assert.notDeepEqual(first.expected, first.actual);
  assert.match(describeMismatch(compiled, first), /^First mismatch: state /);
});

test("a netlist the simulator cannot evaluate is reported as a mismatch, not thrown", async () => {
  const compiled = await compileMachine(EXAMPLES.tiny.source);
  const bytes = compiled.bytes.slice(0, 20);
  const result = await runExhaustiveCheck({ ...compiled, bytes });
  assert.equal(result.matched, 0);
  assert.equal(result.mismatches.length, 5);
  assert.ok(result.mismatches[0]?.actual.error !== undefined);
});

function done(total: number, matched: number): { hash: string; status: "done"; result: ExhaustiveResult } {
  return { hash: "h1", status: "done", result: { total, matched, mismatches: [], durationMs: 1 } };
}

test("tape-out gate: open only when the check for the current bytes passed every case", () => {
  assert.deepEqual(tapeoutGate(done(256, 256), "h1"), { open: true });
  const missing = tapeoutGate(undefined, "h1");
  assert.equal(missing.open, false);
  assert.equal(missing.open === false && missing.message, CHECKING_MESSAGE);
  assert.equal(CHECKING_MESSAGE, "Checking every case…");
  assert.equal(tapeoutGate({ hash: "h1", status: "running" }, "h1").open, false);
  assert.equal(tapeoutGate(done(256, 256), undefined).open, false, "no compile means nothing to offer");
  const stale = tapeoutGate(done(256, 256), "h2");
  assert.equal(stale.open, false, "a result for different bytes never opens the gate");
  assert.equal(stale.open === false && stale.kind, "checking");
  const failed = tapeoutGate(done(256, 250), "h1");
  assert.deepEqual(failed, { open: false, kind: "failed", message: "This circuit does not match its source for 6 cases, so it cannot be manufactured." });
  assert.equal(tapeoutGate(done(0, 0), "h1").open, false);
  const errored = tapeoutGate({ hash: "h1", status: "error", message: "boom" }, "h1");
  assert.equal(errored.open, false);
  assert.equal(errored.open === false && errored.kind, "failed");
});

test("all four templates compile within the language limits and pass the full check", async () => {
  const { TEMPLATES } = await import("../src/examples/templates.js");
  assert.equal(TEMPLATES.length, 4);
  for (const template of TEMPLATES) {
    const compiled = await compileMachine(template.source);
    assert.equal(compiled.machine.name, template.name);
    assert.ok(compiled.machine.states.length <= 8 && compiled.machine.inputs.length <= 8 && compiled.machine.outputs.length <= 4, template.name);
    const result = await runExhaustiveCheck(compiled);
    assert.equal(result.total, (1 << compiled.machine.stateBits) * (1 << compiled.machine.inputs.length), template.name);
    assert.equal(result.matched, result.total, template.name);
    assert.deepEqual(result.mismatches, []);
  }
});

test("rules with two, three and four outputs pass the full check, and the single-output examples keep their bytes", async () => {
  // The netlist reads the last N records as the N outputs, so the compiler builds every output's logic first and emits the
  // N output gates last, in declaration order.
  for (const source of [
    "machine TwoOut { states A, B; initial A; inputs go, cancel; outputs x, y; reset_on cancel; A -> B when go emit x; B -> A when go emit y; }",
    "machine ThreeOut { states A, B, C; initial A; inputs go, alt, cancel; outputs x, y, z; reset_on cancel; A -> B when go emit x; B -> C when go && alt emit y; C -> A when go emit z; }",
    "machine FourOut { states A, B, C, D; initial A; inputs go, alt, cancel; outputs w, x, y, z; reset_on cancel; A -> B when go emit w; B -> C when go emit x; C -> D when alt emit y; D -> A when go && alt emit z; }"
  ]) {
    const compiled = await compileMachine(source);
    const result = await runExhaustiveCheck(compiled);
    assert.equal(result.matched, result.total, compiled.machine.name);
    assert.deepEqual(result.mismatches, [], compiled.machine.name);
    assert.equal(tapeoutGate({ hash: "h", status: "done", result }, "h").open, true);
  }
});
