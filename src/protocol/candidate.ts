import { encodeInputMask, encodeStateIndex } from "../compiler/encoding.js";
import { interpretAst } from "../compiler/interpreter.js";
import { simulateDecodedNetlist } from "../compiler/simulator.js";
import type { CompiledMachine } from "../compiler/types.js";
import type { CandidateComparisonResult } from "./types.js";

export interface CandidateEvaluator {
  evaluate(stateBytes: Uint8Array, inputBytes: Uint8Array): Promise<{ nextStateBytes: Uint8Array; outputBytes: Uint8Array }>;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export async function compareCandidateSimulation(
  compiled: CompiledMachine,
  candidate: CandidateEvaluator
): Promise<CandidateComparisonResult> {
  const mismatches: string[] = [];
  let casesCompared = 0;
  for (let state = 0; state < 1 << compiled.machine.stateBits; state += 1) {
    for (let input = 0; input < 1 << compiled.machine.inputs.length; input += 1) {
      const stateBytes = encodeStateIndex(state, compiled.machine.stateBits);
      const inputBytes = encodeInputMask(input, compiled.machine.inputs.length);
      const ast = interpretAst(compiled.machine, stateBytes, inputBytes);
      const local = simulateDecodedNetlist(compiled.bytes, stateBytes, inputBytes);
      const observed = await candidate.evaluate(stateBytes, inputBytes);
      casesCompared += 1;
      if (!bytesEqual(ast.nextStateBytes, local.nextStateBytes) || !bytesEqual(ast.outputBytes, local.outputBytes)) {
        mismatches.push(`local mismatch state=${hex(stateBytes)} input=${hex(inputBytes)}`);
      }
      if (!bytesEqual(ast.nextStateBytes, observed.nextStateBytes) || !bytesEqual(ast.outputBytes, observed.outputBytes)) {
        mismatches.push(`candidate mismatch state=${hex(stateBytes)} input=${hex(inputBytes)}`);
      }
    }
  }
  return {
    label: "SIMULATION",
    transactionSent: false,
    walletSignatureRequested: false,
    casesCompared,
    mismatches
  };
}

export function localCandidateEvaluator(compiled: CompiledMachine): CandidateEvaluator {
  return {
    async evaluate(stateBytes, inputBytes) {
      const result = simulateDecodedNetlist(compiled.bytes, stateBytes, inputBytes);
      return { nextStateBytes: result.nextStateBytes, outputBytes: result.outputBytes };
    }
  };
}
