import { decodeState, encodeStateIndex, packBits, unpackCanonicalBits } from "./encoding.js";
import { deserializeArtifact } from "./serialization.js";
import type { LatchRecord, NetlistArtifact } from "./types.js";

export interface NetlistStepResult {
  nextStateBytes: Uint8Array;
  outputBytes: Uint8Array;
  outputs: boolean[];
  currentStateValid: boolean;
}

export function simulateDecodedNetlist(
  artifactOrBytes: NetlistArtifact | Uint8Array,
  stateBytes: Uint8Array,
  inputBytes: Uint8Array
): NetlistStepResult {
  const artifact = artifactOrBytes instanceof Uint8Array ? deserializeArtifact(artifactOrBytes) : artifactOrBytes;
  const state = decodeState(stateBytes, artifact.stateBits, artifact.stateCount);
  let inputBits: boolean[];
  try {
    inputBits = unpackCanonicalBits(inputBytes, artifact.inputCount);
  } catch (error) {
    throw new Error(`Invalid input vector: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!state.valid) {
    return {
      nextStateBytes: encodeStateIndex(artifact.initialState, artifact.stateBits),
      outputBytes: packBits(new Array(artifact.outputCount).fill(false)),
      outputs: new Array(artifact.outputCount).fill(false),
      currentStateValid: false
    };
  }

  const signalCount = artifact.inputCount + artifact.records.length;
  const signals = new Array<boolean | undefined>(signalCount).fill(undefined);
  inputBits.forEach((bit, index) => (signals[index] = bit));
  const latchRecords = artifact.records.slice(0, artifact.stateBits);
  if (latchRecords.length !== artifact.stateBits || latchRecords.some((record) => record.kind !== "latch")) {
    throw new Error("GateX v1 requires all LATCH records to precede NAND records");
  }
  const typedLatchRecords = latchRecords as LatchRecord[];

  artifact.records.forEach((record, recordIndex) => {
    const outputSignal = artifact.inputCount + recordIndex;
    if (record.kind === "latch") {
      const latchBit = recordIndex;
      const oldValue = state.bits[latchBit] ?? false;
      signals[outputSignal] = oldValue ?? false;
      return;
    }
    if (record.left >= outputSignal || record.right >= outputSignal) {
      throw new Error(`NAND record ${recordIndex} references a future signal`);
    }
    const left = signals[record.left];
    const right = signals[record.right];
    if (left === undefined || right === undefined) throw new Error(`NAND record ${recordIndex} references an unset signal`);
    signals[outputSignal] = !(left && right);
  });

  const nextStateBits = typedLatchRecords.map((record) => {
    const value = signals[record.data];
    if (value === undefined) throw new Error(`LATCH references an unset data signal ${record.data}`);
    return value;
  });
  const firstOutputRecord = artifact.records.length - artifact.outputCount;
  if (firstOutputRecord < artifact.stateBits) throw new Error("Artifact has no room for its declared outputs");
  const outputs = artifact.records.slice(firstOutputRecord).map((_, index) => {
    const signal = signals[artifact.inputCount + firstOutputRecord + index];
    if (signal === undefined) throw new Error(`Output signal ${index} is unset`);
    return signal;
  });

  return {
    nextStateBytes: packBits(nextStateBits),
    outputBytes: packBits(outputs),
    outputs,
    currentStateValid: state.valid
  };
}
