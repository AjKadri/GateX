import { artifactHash, deserializeArtifact } from "../compiler/serialization.js";
import type { NetlistArtifact, NetlistRecord } from "../compiler/types.js";
import type { ProtocolLock } from "./types.js";

export interface TapeOutPayload {
  localContainer: Uint8Array;
  payload: Uint8Array;
  headerBytes: number;
  payloadBytes: number;
  localHash: string;
  payloadHash: string;
  dimensions: { nIn: number; nOut: number; nState: number; gateCount: number };
}

function writeU24(bytes: Uint8Array, offset: number, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) throw new Error(`Wire signal ${value} is outside u24`);
  bytes[offset] = (value >>> 16) & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = value & 0xff;
}

function mapLocalSignal(signal: number, inputCount: number, recordCount: number, inputStart: number, producedStart: number): number {
  if (signal >= 0 && signal < inputCount) return inputStart + signal;
  if (signal >= inputCount && signal < inputCount + recordCount) return producedStart + signal - inputCount;
  throw new Error(`Local signal ${signal} is outside the artifact signal namespace`);
}

function recordBytes(lock: ProtocolLock, artifact: NetlistArtifact): Uint8Array {
  const wire = lock.gateC.wireFormat;
  const inputStart = wire.signals.inputStart;
  const producedStart = 2 + artifact.inputCount;
  const size = artifact.records.reduce((total, record) => total + (record.kind === "nand" ? wire.nand.bytes : wire.latch.bytes), 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  artifact.records.forEach((record: NetlistRecord, index) => {
    const outputSignal = producedStart + index;
    if (record.kind === "nand") {
      if (wire.nand.opcode !== 0 || wire.nand.bytes !== 7) throw new Error("Gate C wire lock does not describe the supported NAND payload");
      bytes[offset] = wire.nand.opcode;
      writeU24(bytes, offset + 1, mapLocalSignal(record.left, artifact.inputCount, artifact.records.length, inputStart, producedStart));
      writeU24(bytes, offset + 4, mapLocalSignal(record.right, artifact.inputCount, artifact.records.length, inputStart, producedStart));
      offset += wire.nand.bytes;
    } else {
      if (wire.latch.opcode !== 1 || wire.latch.bytes !== 4) throw new Error("Gate C wire lock does not describe the supported LATCH payload");
      bytes[offset] = wire.latch.opcode;
      writeU24(bytes, offset + 1, mapLocalSignal(record.data, artifact.inputCount, artifact.records.length, inputStart, producedStart));
      offset += wire.latch.bytes;
    }
    if (outputSignal !== producedStart + index) throw new Error("Wire signal allocation is not deterministic");
  });
  return bytes;
}

export async function extractTapeOutPayload(lock: ProtocolLock, localContainer: Uint8Array): Promise<TapeOutPayload> {
  if (lock.gateC.wireFormat.header || lock.gateC.wireFormat.padding || lock.gateC.wireFormat.terminator) {
    throw new Error("The locked TapeOut payload cannot be extracted while header, padding, or terminator is enabled");
  }
  const artifact = deserializeArtifact(localContainer);
  const payload = recordBytes(lock, artifact);
  const [localHash, payloadHash] = await Promise.all([artifactHash(localContainer), artifactHash(payload)]);
  return {
    localContainer,
    payload,
    headerBytes: 12,
    payloadBytes: payload.length,
    localHash,
    payloadHash,
    dimensions: { nIn: artifact.inputCount, nOut: artifact.outputCount, nState: artifact.stateBits, gateCount: artifact.records.length }
  };
}
