import assert from "node:assert/strict";
import test from "node:test";
import { parseMachine } from "../src/compiler/parser.js";
import { validateMachine, GateXValidationError } from "../src/compiler/validation.js";

test("parser accepts the bounded DSL and preserves declarations", () => {
  const ast = parseMachine(`
    // comments are ignored
    machine Example {
      state A;
      state B terminal;
      initial A;
      reset clear;
      input clear;
      output done;
      transition A -> B when !clear;
      transition A -> A when clear;
      transition B -> A when clear;
      transition B -> B when !clear;
      emit done = state == B && !clear;
    }
  `);
  const machine = validateMachine(ast);
  assert.equal(machine.name, "Example");
  assert.equal(machine.stateBits, 1);
  assert.equal(machine.states[1]?.terminal, true);
  assert.equal(machine.outputs[0]?.name, "done");
});

test("validator rejects duplicate symbols, ambiguity, unknown symbols, and unreachable states", () => {
  const duplicate = parseMachine(`
    machine Duplicate {
      state A;
      initial A;
      reset r;
      input r;
      input r;
      output out;
      transition A -> A when true;
      emit out = false;
    }
  `);
  assert.throws(() => validateMachine(duplicate), GateXValidationError);

  const ambiguous = parseMachine(`
    machine Ambiguous {
      state A;
      state B;
      initial A;
      reset r;
      input r;
      output out;
      transition A -> A when true;
      transition A -> B when true;
      transition B -> B when !r;
      transition B -> A when r;
      emit out = false;
    }
  `);
  assert.throws(() => validateMachine(ambiguous), /ambiguous/);

  const unknown = parseMachine(`
    machine Unknown {
      state A;
      initial A;
      reset r;
      input r;
      output out;
      transition A -> A when missing;
      emit out = false;
    }
  `);
  assert.throws(() => validateMachine(unknown), /unknown input symbol/);

  const unreachable = parseMachine(`
    machine Unreachable {
      state A;
      state B;
      state C;
      initial A;
      reset r;
      input r;
      output out;
      transition A -> A when true;
      transition B -> B when !r;
      transition B -> A when r;
      transition C -> C when !r;
      transition C -> A when r;
      emit out = false;
    }
  `);
  assert.throws(() => validateMachine(unreachable), /unreachable/);
});

test("validator enforces reset priority and terminal self-loops", () => {
  const badReset = parseMachine(`
    machine BadReset {
      state A;
      state B terminal;
      initial A;
      reset r;
      input r;
      output out;
      transition A -> B when true;
      transition B -> B when true;
      emit out = false;
    }
  `);
  assert.throws(() => validateMachine(badReset), /reset must take/);

  const badTerminal = parseMachine(`
    machine BadTerminal {
      state A;
      state B terminal;
      initial A;
      reset r;
      input r;
      output out;
      transition A -> B when true;
      transition B -> A when !r;
      transition B -> A when r;
      emit out = false;
    }
  `);
  assert.throws(() => validateMachine(badTerminal), /terminal state/);
});
