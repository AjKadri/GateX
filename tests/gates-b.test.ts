import assert from "node:assert/strict";
import test from "node:test";
import { compileMachine } from "../src/compiler/compiler.js";
import { encodeInputMask, encodeStateIndex, packBits } from "../src/compiler/encoding.js";
import { interpretAst } from "../src/compiler/interpreter.js";
import { deserializeArtifact, serializeArtifact } from "../src/compiler/serialization.js";
import { simulateDecodedNetlist } from "../src/compiler/simulator.js";
import { TINY_APPROVAL_SOURCE } from "../src/examples/tinyApproval.js";

function sameBytes(left: Uint8Array, right: Uint8Array): void {
  assert.deepEqual([...left], [...right]);
}

test("TinyApproval compiles with exactly two LATCH records", async () => {
  const compiled = await compileMachine(TINY_APPROVAL_SOURCE);
  assert.equal(compiled.machine.states.map((state) => state.name).join(","), "LOCKED,READY,USED");
  assert.equal(compiled.machine.stateBits, 2);
  assert.equal(compiled.latchCount, 2);
  assert.equal(compiled.artifact.records.slice(0, 2).every((record) => record.kind === "latch"), true);
  assert.equal(compiled.artifact.records.some((record) => record.kind === "latch" && record.data >= compiled.artifact.inputCount + compiled.artifact.records.length), false);
});

test("TinyApproval matches the independent AST interpreter over all 32 cases", async () => {
  const compiled = await compileMachine(TINY_APPROVAL_SOURCE);
  for (let state = 0; state < 4; state += 1) {
    for (let input = 0; input < 8; input += 1) {
      const stateBytes = encodeStateIndex(state, compiled.machine.stateBits);
      const inputBytes = encodeInputMask(input, compiled.machine.inputs.length);
      const ast = interpretAst(compiled.machine, stateBytes, inputBytes);
      const netlist = simulateDecodedNetlist(compiled.bytes, stateBytes, inputBytes);
      sameBytes(netlist.nextStateBytes, ast.nextStateBytes);
      sameBytes(netlist.outputBytes, ast.outputBytes);
      assert.equal(netlist.currentStateValid, ast.currentStateValid, `state=${state} input=${input}`);
    }
  }
});

test("TinyApproval sequential authorize, execute, repeated execute, reset, and corrupt-state traces pass", async () => {
  const compiled = await compileMachine(TINY_APPROVAL_SOURCE);
  const input = (authorize: boolean, execute: boolean, reset: boolean) =>
    packBits([authorize, execute, reset]);
  let state = encodeStateIndex(0, compiled.machine.stateBits);

  let step = simulateDecodedNetlist(compiled.bytes, state, input(true, false, false));
  sameBytes(step.nextStateBytes, encodeStateIndex(1, 2));
  assert.equal(step.outputs[0], false);
  state = step.nextStateBytes;

  step = simulateDecodedNetlist(compiled.bytes, state, input(false, true, false));
  sameBytes(step.nextStateBytes, encodeStateIndex(2, 2));
  assert.equal(step.outputs[0], true);
  state = step.nextStateBytes;

  step = simulateDecodedNetlist(compiled.bytes, state, input(false, true, false));
  sameBytes(step.nextStateBytes, encodeStateIndex(2, 2));
  assert.equal(step.outputs[0], false);

  step = simulateDecodedNetlist(compiled.bytes, state, input(true, true, true));
  sameBytes(step.nextStateBytes, encodeStateIndex(0, 2));
  assert.equal(step.outputs[0], false);

  step = simulateDecodedNetlist(compiled.bytes, new Uint8Array([0b11]), input(false, true, false));
  sameBytes(step.nextStateBytes, encodeStateIndex(0, 2));
  assert.equal(step.outputs[0], false);
  assert.equal(step.currentStateValid, false);
});

test("mutation tests pin LSB-first bit order, reset priority, and current-state output timing", async () => {
  const compiled = await compileMachine(TINY_APPROVAL_SOURCE);

  const authorize = simulateDecodedNetlist(compiled.bytes, new Uint8Array([0]), encodeInputMask(1, 3));
  const swappedInput = simulateDecodedNetlist(compiled.bytes, new Uint8Array([0]), encodeInputMask(2, 3));
  assert.deepEqual([...authorize.nextStateBytes], [1]);
  assert.deepEqual([...swappedInput.nextStateBytes], [0]);

  const ready = encodeStateIndex(1, 2);
  const execute = encodeInputMask(2, 3);
  const swappedState = simulateDecodedNetlist(compiled.bytes, encodeStateIndex(2, 2), execute);
  const readyStep = simulateDecodedNetlist(compiled.bytes, ready, execute);
  assert.deepEqual([...readyStep.nextStateBytes], [2]);
  assert.deepEqual([...swappedState.nextStateBytes], [2]);
  assert.notDeepEqual([...readyStep.outputBytes], [...swappedState.outputBytes]);

  const resetAndExecute = simulateDecodedNetlist(compiled.bytes, ready, encodeInputMask(6, 3));
  assert.deepEqual([...resetAndExecute.nextStateBytes], [0]);
  assert.deepEqual([...resetAndExecute.outputBytes], [0]);

  assert.equal(readyStep.outputs[0], true);
  assert.deepEqual([...readyStep.nextStateBytes], [2]);
});

test("decoded serialization round-trips and repeated compilation produces identical bytes and hashes", async () => {
  const first = await compileMachine(TINY_APPROVAL_SOURCE);
  const second = await compileMachine(TINY_APPROVAL_SOURCE);
  sameBytes(first.bytes, second.bytes);
  assert.equal(first.hash, second.hash);
  sameBytes(serializeArtifact(deserializeArtifact(first.bytes)), first.bytes);
  assert.equal(first.hash.length, 64);
});

