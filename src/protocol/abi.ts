import type { LockedFunction, ProtocolLock } from "./types.js";

export class GateCAbiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateCAbiError";
  }
}

export interface DecodedCircuitInfo {
  nIn: number;
  nOut: number;
  nState: number;
  gateCount: number;
}

export interface DecodedStep {
  nextState: Uint8Array;
  outputs: Uint8Array;
}

function hexToBytes(value: string): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new GateCAbiError(`Expected even-length hex bytes, received ${value}`);
  const result = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  return result;
}

function bytesToHex(value: Uint8Array): string {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function word(value: bigint): Uint8Array {
  if (value < 0n || value >= (1n << 256n)) throw new GateCAbiError(`ABI integer is outside uint256: ${value}`);
  const result = new Uint8Array(32);
  let remaining = value;
  for (let index = 31; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function paddedBytes(value: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil(value.length / 32) * 32;
  return concat(word(BigInt(value.length)), new Uint8Array(paddedLength)).map((byte, index) => index < 32 ? byte : value[index - 32] ?? 0);
}

function functionEntry(lock: ProtocolLock, signature: string): LockedFunction {
  const entry = lock.gateC.functions.find((candidate) => candidate.signature === signature);
  if (entry === undefined) throw new GateCAbiError(`No locked ABI entry for ${signature}`);
  return entry;
}

function selector(lock: ProtocolLock, signature: string): Uint8Array {
  return hexToBytes(functionEntry(lock, signature).selector);
}

function uint(value: string | number | bigint): Uint8Array {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  return word(parsed);
}

function dynamicTuple(lock: ProtocolLock, signature: string, staticArguments: Uint8Array[], dynamicArguments: Uint8Array[]): Uint8Array {
  const headLength = staticArguments.length * 32 + dynamicArguments.length * 32;
  const heads: Uint8Array[] = [...staticArguments];
  const tails: Uint8Array[] = [];
  let offset = headLength;
  for (const argument of dynamicArguments) {
    const encoded = paddedBytes(argument);
    heads.push(word(BigInt(offset)));
    tails.push(encoded);
    offset += encoded.length;
  }
  return concat(selector(lock, signature), ...heads, ...tails);
}

export function encodeCall(lock: ProtocolLock, signature: string, args: readonly (string | number | bigint | Uint8Array)[]): string {
  switch (signature) {
    case "netlist(uint256)":
    case "circuitInfo(uint256)":
      if (args.length !== 1 || typeof args[0] === "object") throw new GateCAbiError(`${signature} expects one uint256`);
      return bytesToHex(concat(selector(lock, signature), uint(args[0] as string | number | bigint)));
    case "eval(uint256,bytes)":
      if (args.length !== 2 || typeof args[0] === "object" || typeof args[1] === "string" || typeof args[1] === "number" || typeof args[1] === "bigint") throw new GateCAbiError("eval expects uint256 and bytes");
      return bytesToHex(dynamicTuple(lock, signature, [uint(args[0] as string | number | bigint)], [args[1] as Uint8Array]));
    case "step(uint256,bytes,bytes)":
      if (args.length !== 3 || typeof args[0] === "object" || typeof args[1] !== "object" || typeof args[2] !== "object") throw new GateCAbiError("step expects uint256 and two bytes arguments");
      return bytesToHex(dynamicTuple(lock, signature, [uint(args[0] as string | number | bigint)], [args[1] as Uint8Array, args[2] as Uint8Array]));
    case "tapeout(bytes,uint32,uint32)":
      if (args.length !== 3 || typeof args[0] !== "object" || typeof args[1] === "object" || typeof args[2] === "object") throw new GateCAbiError("tapeout expects bytes and two uint32 arguments");
      return bytesToHex(concat(selector(lock, signature), word(96n), uint(args[1] as string | number | bigint), uint(args[2] as string | number | bigint), paddedBytes(args[0] as Uint8Array)));
    default:
      throw new GateCAbiError(`Unsupported locked ABI signature ${signature}`);
  }
}

function readWord(bytes: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 32 > bytes.length) throw new GateCAbiError(`ABI word at ${offset} is truncated`);
  let result = 0n;
  for (let index = offset; index < offset + 32; index += 1) result = (result << 8n) | BigInt(bytes[index] ?? 0);
  return result;
}

function readDynamic(bytes: Uint8Array, offsetWord: number): Uint8Array {
  const offset = Number(readWord(bytes, offsetWord));
  if (!Number.isSafeInteger(offset) || offset % 32 !== 0) throw new GateCAbiError("ABI dynamic offset is invalid");
  const length = Number(readWord(bytes, offset));
  if (!Number.isSafeInteger(length) || offset + 32 + length > bytes.length) throw new GateCAbiError("ABI dynamic bytes are truncated");
  const end = offset + 32 + Math.ceil(length / 32) * 32;
  if (end > bytes.length) throw new GateCAbiError("ABI dynamic padding is truncated");
  for (const byte of bytes.slice(offset + 32 + length, end)) if (byte !== 0) throw new GateCAbiError("ABI dynamic padding is non-zero");
  return bytes.slice(offset + 32, offset + 32 + length);
}

export function decodeBytesReturn(value: string): Uint8Array {
  const bytes = hexToBytes(value);
  return readDynamic(bytes, 0);
}

export function decodeCircuitInfo(value: string): DecodedCircuitInfo {
  const bytes = hexToBytes(value);
  const values = [0, 1, 2, 3].map((index) => Number(readWord(bytes, index * 32)));
  if (values.some((item) => !Number.isSafeInteger(item) || item > 0xffffffff)) throw new GateCAbiError("circuitInfo value is outside uint32");
  return { nIn: values[0] as number, nOut: values[1] as number, nState: values[2] as number, gateCount: values[3] as number };
}

export function decodeStep(value: string): DecodedStep {
  const bytes = hexToBytes(value);
  return { nextState: readDynamic(bytes, 0), outputs: readDynamic(bytes, 32) };
}

export function decodeUint256(value: string): bigint {
  const bytes = hexToBytes(value);
  if (bytes.length !== 32) throw new GateCAbiError("uint256 return must be one ABI word");
  return readWord(bytes, 0);
}

export function bytesFromHex(value: string): Uint8Array {
  return hexToBytes(value);
}

export function hexFromBytes(value: Uint8Array): string {
  return bytesToHex(value);
}
