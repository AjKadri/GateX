import type { LatchRecord, NandRecord, NetlistArtifact, NetlistRecord } from "./types.js";

const MAGIC = [0x47, 0x58, 0x31, 0x00];
const HEADER_SIZE = 12;

function writeU24(bytes: Uint8Array, offset: number, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) throw new Error(`Signal index ${value} is outside u24`);
  bytes[offset] = (value >>> 16) & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = value & 0xff;
}

function readU24(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 16) | ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset + 2] ?? 0);
}

function recordByteLength(record: NetlistRecord): number {
  return record.kind === "nand" ? 7 : 4;
}

export function serializeArtifact(artifact: NetlistArtifact): Uint8Array {
  if (artifact.version !== 1) throw new Error(`Unsupported artifact version ${artifact.version}`);
  if (artifact.inputCount < 0 || artifact.inputCount > 8) throw new Error("Input count is outside the locked bound");
  if (artifact.stateBits < 1 || artifact.stateBits > 3) throw new Error("State bit count is outside the locked bound");
  if (artifact.stateCount < 1 || artifact.stateCount > 1 << artifact.stateBits) throw new Error("State count is outside its encoding");
  if (artifact.initialState < 0 || artifact.initialState >= artifact.stateCount) throw new Error("Initial state is outside the state table");
  if (artifact.outputCount < 1 || artifact.outputCount > 4) throw new Error("Output count is outside the locked bound");
  if (artifact.records.length > 0xffff) throw new Error("Record count exceeds u16");
  const size = HEADER_SIZE + artifact.records.reduce((total, record) => total + recordByteLength(record), 0);
  const bytes = new Uint8Array(size);
  MAGIC.forEach((value, index) => (bytes[index] = value));
  bytes[4] = artifact.version;
  bytes[5] = artifact.inputCount;
  bytes[6] = artifact.stateBits;
  bytes[7] = artifact.outputCount;
  bytes[8] = artifact.stateCount;
  bytes[9] = artifact.initialState;
  bytes[10] = (artifact.records.length >>> 8) & 0xff;
  bytes[11] = artifact.records.length & 0xff;
  let cursor = HEADER_SIZE;
  for (const record of artifact.records) {
    if (record.kind === "nand") {
      bytes[cursor] = 0;
      writeU24(bytes, cursor + 1, record.left);
      writeU24(bytes, cursor + 4, record.right);
      cursor += 7;
    } else {
      bytes[cursor] = 1;
      writeU24(bytes, cursor + 1, record.data);
      cursor += 4;
    }
  }
  return bytes;
}

export function deserializeArtifact(bytes: Uint8Array): NetlistArtifact {
  if (bytes.length < HEADER_SIZE) throw new Error("Artifact is shorter than its header");
  MAGIC.forEach((value, index) => {
    if (bytes[index] !== value) throw new Error("Artifact magic does not match GateX v1");
  });
  if (bytes[4] !== 1) throw new Error(`Unsupported artifact version ${bytes[4]}`);
  const inputCount = bytes[5] ?? 0;
  const stateBits = bytes[6] ?? 0;
  const outputCount = bytes[7] ?? 0;
  const stateCount = bytes[8] ?? 0;
  const initialState = bytes[9] ?? 0;
  const recordCount = ((bytes[10] ?? 0) << 8) | (bytes[11] ?? 0);
  const records: NetlistRecord[] = [];
  let cursor = HEADER_SIZE;
  for (let index = 0; index < recordCount; index += 1) {
    const opcode = bytes[cursor];
    if (opcode === 0) {
      if (cursor + 7 > bytes.length) throw new Error("Truncated NAND record");
      const record: NandRecord = { kind: "nand", left: readU24(bytes, cursor + 1), right: readU24(bytes, cursor + 4) };
      records.push(record);
      cursor += 7;
    } else if (opcode === 1) {
      if (cursor + 4 > bytes.length) throw new Error("Truncated LATCH record");
      const record: LatchRecord = { kind: "latch", data: readU24(bytes, cursor + 1) };
      records.push(record);
      cursor += 4;
    } else {
      throw new Error(`Unknown netlist opcode ${opcode}`);
    }
  }
  if (cursor !== bytes.length) throw new Error("Artifact has trailing bytes");
  return { version: 1, inputCount, stateBits, stateCount, initialState, outputCount, records };
}

export async function artifactHash(bytes: Uint8Array): Promise<string> {
  const stableBytes = new Uint8Array(bytes.length);
  stableBytes.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", stableBytes.buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
