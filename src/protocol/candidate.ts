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
  return compareCandidateSimulationWithConcurrency(compiled, candidate, 1);
}

export async function compareCandidateSimulationWithConcurrency(
  compiled: CompiledMachine,
  candidate: CandidateEvaluator,
  concurrency: number
): Promise<CandidateComparisonResult> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Candidate comparison concurrency must be a positive integer");
  const mismatches: string[] = [];
  const cases: Array<{ state: number; input: number }> = [];
  for (let state = 0; state < 1 << compiled.machine.stateBits; state += 1) {
    for (let input = 0; input < 1 << compiled.machine.inputs.length; input += 1) cases.push({ state, input });
  }
  const results = new Array<string[] | undefined>(cases.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      const current = cases[index];
      if (current === undefined) return;
      const stateBytes = encodeStateIndex(current.state, compiled.machine.stateBits);
      const inputBytes = encodeInputMask(current.input, compiled.machine.inputs.length);
      const ast = interpretAst(compiled.machine, stateBytes, inputBytes);
      const local = simulateDecodedNetlist(compiled.bytes, stateBytes, inputBytes);
      const observed = await candidate.evaluate(stateBytes, inputBytes);
      const caseMismatches: string[] = [];
      if (!bytesEqual(ast.nextStateBytes, local.nextStateBytes) || !bytesEqual(ast.outputBytes, local.outputBytes)) caseMismatches.push(`local mismatch state=${hex(stateBytes)} input=${hex(inputBytes)}`);
      if (!bytesEqual(ast.nextStateBytes, observed.nextStateBytes) || !bytesEqual(ast.outputBytes, observed.outputBytes)) caseMismatches.push(`candidate mismatch state=${hex(stateBytes)} input=${hex(inputBytes)}`);
      results[index] = caseMismatches;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));
  for (const caseMismatches of results) if (caseMismatches !== undefined) mismatches.push(...caseMismatches);
  return {
    label: "SIMULATION",
    transactionSent: false,
    walletSignatureRequested: false,
    casesCompared: cases.length,
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
