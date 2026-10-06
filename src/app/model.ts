import { compileMachine } from "../compiler/compiler.js";
import { interpretAst } from "../compiler/interpreter.js";
import { packBits, encodeInputMask, encodeStateIndex } from "../compiler/encoding.js";
import { extractTapeOutPayload } from "../protocol/wire.js";
import { artifactHash } from "../compiler/serialization.js";
import { browserLock } from "./protocol.js";
import { AGENT_APPROVAL_SOURCE } from "../examples/agentApproval.js";
import { TINY_APPROVAL_SOURCE } from "../examples/tinyApproval.js";
import type { CompiledMachine, AstStepResult } from "../compiler/types.js";

export type ExampleKey = "agent" | "tiny";

export interface ExampleDefinition {
  key: ExampleKey;
  label: string;
  circuitId: string;
  source: string;
  expected: { nand: number; latch: number; records: number; localBytes: number; localSha: string; payloadBytes: number; payloadSha: string; cases: number };
}

export const EXAMPLES: Record<ExampleKey, ExampleDefinition> = {
  agent: {
    key: "agent",
    label: "AgentApproval",
    circuitId: "2",
    source: AGENT_APPROVAL_SOURCE.trim(),
    expected: { nand: 98, latch: 2, records: 100, localBytes: 706, localSha: "d68c9881fbe8bf0fbf7f86cfa92ad2889389e07e09bb0e7f0068f23eded50003", payloadBytes: 694, payloadSha: "7e4b5f83032beaf32ce2e7c067f1ee24d08feea1e2db8c64ef7c4d7de231dc45", cases: 256 }
  },
  tiny: {
    key: "tiny",
    label: "TinyApproval",
    circuitId: "1",
    source: TINY_APPROVAL_SOURCE.trim(),
    expected: { nand: 89, latch: 2, records: 91, localBytes: 643, localSha: "adee32d4133073926d312a711643d16ac7d849c7e662c2bce8f6131c35fd0334", payloadBytes: 631, payloadSha: "7ec1ed9fe2e0c5f92a45b2ad49fe3da969c109f01522d8306fe127aba76cabac", cases: 32 }
  }
};

export interface CompiledExample {
  definition: ExampleDefinition;
  compiled: CompiledMachine;
  payload: Awaited<ReturnType<typeof extractTapeOutPayload>>;
  sourceDigest: string;
  deterministic: boolean;
  artifactMatch: boolean;
}

export async function compileExample(key: ExampleKey, source = EXAMPLES[key].source): Promise<CompiledExample> {
  const definition = EXAMPLES[key];
  const compiled = await compileMachine(source);
  const repeat = await compileMachine(source);
  const payload = await extractTapeOutPayload(browserLock, compiled.bytes);
  const sourceDigest = await artifactHash(new TextEncoder().encode(source));
  const deterministic = compiled.hash === repeat.hash && bytesLabel(compiled.bytes) === bytesLabel(repeat.bytes);
  const artifactMatch = compiled.nandCount === definition.expected.nand && compiled.latchCount === definition.expected.latch && compiled.artifact.records.length === definition.expected.records && compiled.bytes.length === definition.expected.localBytes && compiled.hash === definition.expected.localSha && payload.payload.length === definition.expected.payloadBytes && payload.payloadHash === definition.expected.payloadSha;
  return { definition, compiled, payload, sourceDigest, deterministic, artifactMatch };
}

export function localStep(compiled: CompiledMachine, stateIndex: number, inputMask: number): AstStepResult {
  return interpretAst(compiled.machine, encodeStateIndex(stateIndex, compiled.machine.stateBits), encodeInputMask(inputMask, compiled.machine.inputs.length));
}

export function outputNames(compiled: CompiledMachine): string[] {
  return compiled.machine.outputs.map((output) => output.name);
}

export function stateName(compiled: CompiledMachine, value: number): string {
  return compiled.machine.states[value]?.name ?? `INVALID(${value})`;
}

export function bytesLabel(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function inputMaskFromRecord(compiled: CompiledMachine, values: Record<string, boolean>): number {
  return compiled.machine.inputs.reduce((mask, input, index) => mask | (values[input.name] ? 1 << index : 0), 0);
}

export function inputBytes(compiled: CompiledMachine, values: Record<string, boolean>): Uint8Array {
  return packBits(compiled.machine.inputs.map((input) => values[input.name] ?? false));
}
