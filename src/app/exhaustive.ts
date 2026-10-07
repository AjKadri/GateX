import { encodeInputMask, encodeStateIndex } from "../compiler/encoding.js";
import { interpretAst } from "../compiler/interpreter.js";
import { simulateDecodedNetlist } from "../compiler/simulator.js";
import type { CompiledMachine } from "../compiler/types.js";

// The full check: every state encoding x every input assignment, source-level interpreter against the decoded-netlist simulator.
// It enumerates exactly what tests/gates-b.test.ts enumerates: state values 0 .. 2^stateBits - 1 (so encodings that no declared
// state uses are included, and both engines must send them to the initial state with cleared outputs) and input masks
// 0 .. 2^inputs - 1. TinyApproval is 4 x 8 = 32 cases and AgentApproval is 4 x 64 = 256.

export interface CaseOutcome {
  nextState: string;
  outputs: string;
  currentStateValid: boolean;
  error?: string;
}

export interface CaseMismatch {
  state: number;
  inputs: number;
  expected: CaseOutcome;
  actual: CaseOutcome;
}

export interface ExhaustiveResult {
  total: number;
  matched: number;
  /** The first five disagreements only. The number of disagreements is total - matched. */
  mismatches: CaseMismatch[];
  durationMs: number;
}

const MAX_REPORTED = 5;
const CASES_PER_CHUNK = 256;

function hex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function caseCount(compiled: CompiledMachine): number {
  return (1 << compiled.machine.stateBits) * (1 << compiled.machine.inputs.length);
}

export async function runExhaustiveCheck(compiled: CompiledMachine): Promise<ExhaustiveResult> {
  const started = now();
  const stateBits = compiled.machine.stateBits;
  const inputCount = compiled.machine.inputs.length;
  const stateValues = 1 << stateBits;
  const inputMasks = 1 << inputCount;
  const total = stateValues * inputMasks;
  const mismatches: CaseMismatch[] = [];
  let matched = 0;
  let sinceYield = 0;

  for (let state = 0; state < stateValues; state += 1) {
    const stateBytes = encodeStateIndex(state, stateBits);
    for (let inputs = 0; inputs < inputMasks; inputs += 1) {
      const inputBytes = encodeInputMask(inputs, inputCount);
      const ast = interpretAst(compiled.machine, stateBytes, inputBytes);
      const expected: CaseOutcome = { nextState: hex(ast.nextStateBytes), outputs: hex(ast.outputBytes), currentStateValid: ast.currentStateValid };
      let actual: CaseOutcome;
      let agrees = false;
      try {
        const netlist = simulateDecodedNetlist(compiled.bytes, stateBytes, inputBytes);
        actual = { nextState: hex(netlist.nextStateBytes), outputs: hex(netlist.outputBytes), currentStateValid: netlist.currentStateValid };
        agrees = sameBytes(netlist.nextStateBytes, ast.nextStateBytes) && sameBytes(netlist.outputBytes, ast.outputBytes) && netlist.currentStateValid === ast.currentStateValid;
      } catch (error) {
        actual = { nextState: "", outputs: "", currentStateValid: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (agrees) matched += 1;
      else if (mismatches.length < MAX_REPORTED) mismatches.push({ state, inputs, expected, actual });
      sinceYield += 1;
      if (sinceYield >= CASES_PER_CHUNK) { sinceYield = 0; await yieldToBrowser(); }
    }
  }
  return { total, matched, mismatches, durationMs: now() - started };
}

export function describeMismatch(compiled: CompiledMachine, mismatch: CaseMismatch): string {
  const stateLabel = compiled.machine.states[mismatch.state]?.name ?? `unused encoding ${mismatch.state}`;
  const inputs = compiled.machine.inputs.map((input, index) => `${input.name}=${(mismatch.inputs & (1 << index)) !== 0 ? 1 : 0}`).join(" ");
  const actual = mismatch.actual.error !== undefined ? `the circuit could not be evaluated (${mismatch.actual.error})` : `the circuit gave next ${mismatch.actual.nextState}, outputs ${mismatch.actual.outputs}`;
  return `First mismatch: state ${stateLabel}, inputs ${inputs || "none"}. The source says next ${mismatch.expected.nextState}, outputs ${mismatch.expected.outputs}; ${actual}.`;
}

/** What the UI remembers about the check for one compiled artifact. `hash` is the local container hash of the bytes that were checked. */
export type ExhaustiveUi =
  | { hash: string; status: "running" }
  | { hash: string; status: "done"; result: ExhaustiveResult }
  | { hash: string; status: "error"; message: string };

export type TapeoutGate =
  | { open: true }
  | { open: false; kind: "checking" | "failed"; message: string };

export const CHECKING_MESSAGE = "Checking every case…";

/** The only way the tape-out panel and the send guard decide whether manufacturing may be offered. Pure, so it can be tested. */
export function tapeoutGate(check: ExhaustiveUi | undefined, currentHash: string | undefined): TapeoutGate {
  if (currentHash === undefined || check === undefined || check.hash !== currentHash || check.status === "running") return { open: false, kind: "checking", message: CHECKING_MESSAGE };
  if (check.status === "error") return { open: false, kind: "failed", message: "The full check could not finish, so this circuit cannot be manufactured." };
  const { total, matched } = check.result;
  if (total > 0 && matched === total) return { open: true };
  const failing = total - matched;
  return { open: false, kind: "failed", message: `This circuit does not match its source for ${failing} ${failing === 1 ? "case" : "cases"}, so it cannot be manufactured.` };
}
