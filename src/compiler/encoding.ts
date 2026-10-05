import type { ValidatedMachine } from "./types.js";

export function byteLength(bitCount: number): number {
  return Math.ceil(bitCount / 8);
}

export function packBits(bits: readonly boolean[]): Uint8Array {
  const bytes = new Uint8Array(byteLength(bits.length));
  bits.forEach((bit, index) => {
    if (bit) bytes[Math.floor(index / 8)] = (bytes[Math.floor(index / 8)] ?? 0) | (1 << (index % 8));
  });
  return bytes;
}

export function unpackCanonicalBits(bytes: Uint8Array, bitCount: number): boolean[] {
  const expectedLength = byteLength(bitCount);
  if (bytes.length !== expectedLength) {
    throw new Error(`Expected ${expectedLength} bytes for ${bitCount} bits, received ${bytes.length}`);
  }
  const unusedBits = expectedLength * 8 - bitCount;
  if (unusedBits > 0 && (bytes[bytes.length - 1] ?? 0) >> (8 - unusedBits)) {
    throw new Error(`Non-zero padding bits for ${bitCount}-bit vector`);
  }
  return Array.from({ length: bitCount }, (_, index) => ((bytes[Math.floor(index / 8)] ?? 0) & (1 << (index % 8))) !== 0);
}

export function encodeStateIndex(index: number, stateBits: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index >= 1 << stateBits) {
    throw new Error(`State index ${index} cannot be encoded in ${stateBits} bits`);
  }
  return packBits(Array.from({ length: stateBits }, (_, bit) => (index & (1 << bit)) !== 0));
}

export interface DecodedState {
  value: number;
  valid: boolean;
  bits: boolean[];
}

export function decodeState(bytes: Uint8Array, stateBits: number, stateCount: number): DecodedState {
  if (bytes.length !== byteLength(stateBits)) return { value: 0, valid: false, bits: [] };
  const bits = Array.from({ length: stateBits }, (_, index) => ((bytes[Math.floor(index / 8)] ?? 0) & (1 << (index % 8))) !== 0);
  const value = bits.reduce((result, bit, index) => result | (bit ? 1 << index : 0), 0);
  const unusedBits = bytes.length * 8 - stateBits;
  const hasPadding = unusedBits > 0 && ((bytes[bytes.length - 1] ?? 0) >> (8 - unusedBits)) !== 0;
  return { value, valid: value < stateCount && !hasPadding, bits };
}

export function encodeInputMask(mask: number, inputCount: number): Uint8Array {
  if (!Number.isInteger(mask) || mask < 0 || mask >= 1 << inputCount) {
    throw new Error(`Input mask ${mask} cannot be encoded in ${inputCount} bits`);
  }
  return packBits(Array.from({ length: inputCount }, (_, bit) => (mask & (1 << bit)) !== 0));
}

export function inputMap(machine: ValidatedMachine, bytes: Uint8Array): ReadonlyMap<string, boolean> {
  const bits = unpackCanonicalBits(bytes, machine.inputs.length);
  return new Map(machine.inputs.map((input, index) => [input.name, bits[index] ?? false]));
}
