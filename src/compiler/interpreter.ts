import { decodeState, encodeStateIndex, inputMap, packBits } from "./encoding.js";
import { evaluateAstExpression } from "./validation.js";
import type { AstStepResult, ValidatedMachine } from "./types.js";

export function interpretAst(
  machine: ValidatedMachine,
  stateBytes: Uint8Array,
  inputBytes: Uint8Array
): AstStepResult {
  const decoded = decodeState(stateBytes, machine.stateBits, machine.states.length);
  const initialState = machine.stateIndex.get(machine.initialState) ?? 0;
  const currentState = decoded.valid ? decoded.value : initialState;
  const inputValues = inputMap(machine, inputBytes);
  const currentStateName = machine.states[currentState]?.name ?? machine.initialState;
  const outputs = machine.outputs.map(() => false);

  if (decoded.valid) {
    const environment = { inputs: inputValues, state: currentStateName };
    const transitions = machine.transitions.filter((transition) => transition.from === currentStateName);
    const selected = transitions.find((transition) => evaluateAstExpression(transition.guard, environment));
    if (selected === undefined) {
      throw new Error(`Validated state ${currentStateName} has no selected transition`);
    }
    const nextState = machine.stateIndex.get(selected.to);
    if (nextState === undefined) throw new Error(`Validated transition targets unknown state ${selected.to}`);
    for (const emission of machine.emissions) {
      const outputIndex = machine.outputIndex.get(emission.name);
      if (outputIndex !== undefined) outputs[outputIndex] = evaluateAstExpression(emission.expression, environment);
    }
    return {
      currentState,
      nextState,
      currentStateValid: true,
      outputs,
      outputBytes: packBits(outputs),
      nextStateBytes: encodeStateIndex(nextState, machine.stateBits)
    };
  }

  return {
    currentState,
    nextState: initialState,
    currentStateValid: false,
    outputs,
    outputBytes: packBits(outputs),
    nextStateBytes: encodeStateIndex(initialState, machine.stateBits)
  };
}

