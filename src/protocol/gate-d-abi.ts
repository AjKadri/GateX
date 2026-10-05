import { sha256 } from "@noble/hashes/sha2.js";
import type { ProtocolLock } from "./types.js";

export class GateDAbiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateDAbiError";
  }
}

type AbiValue = string | number | bigint | Uint8Array;

function gateDFunction(lock: ProtocolLock, signature: string): { selector: string } {
  const entry = lock.gateD?.functions.find((candidate) => candidate.signature === signature);
  if (entry === undefined) throw new GateDAbiError(`No locked Gate D ABI entry for ${signature}`);
  return entry;
}

function hexToBytes(value: string): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new GateDAbiError(`Expected even-length hex bytes, received ${value}`);
  const result = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  return result;
}

function bytesToHex(value: Uint8Array): string {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function word(value: bigint): Uint8Array {
  if (value < 0n || value >= (1n << 256n)) throw new GateDAbiError(`ABI integer is outside uint256: ${value}`);
  const result = new Uint8Array(32);
  let remaining = value;
  for (let index = 31; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

function asUint(value: AbiValue): bigint {
  if (value instanceof Uint8Array) throw new GateDAbiError("Expected an ABI integer");
  try {
    return typeof value === "bigint" ? value : BigInt(value);
  } catch {
    throw new GateDAbiError(`Invalid ABI integer ${String(value)}`);
  }
}

function asAddress(value: AbiValue): Uint8Array {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new GateDAbiError(`Expected an EVM address, received ${String(value)}`);
  const result = new Uint8Array(32);
  result.set(hexToBytes(value), 12);
  return result;
}

function asBytes(value: AbiValue): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new GateDAbiError("Expected bytes or string");
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

function paddedDynamic(value: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil(value.length / 32) * 32;
  return concat(word(BigInt(value.length)), value, new Uint8Array(paddedLength - value.length));
}

function selector(lock: ProtocolLock, signature: string): Uint8Array {
  return hexToBytes(gateDFunction(lock, signature).selector);
}

function encodeCreate(lock: ProtocolLock, args: readonly AbiValue[]): Uint8Array {
  if (args.length !== 5 || !args.slice(0, 3).every((value) => typeof value === "string") || args.slice(3).some((value) => value instanceof Uint8Array)) {
    throw new GateDAbiError("createCPU expects name, symbol, story, supply cap and mint price");
  }
  const dynamic = args.slice(0, 3).map(asBytes);
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let offset = 5 * 32;
  for (const value of dynamic) {
    const encoded = paddedDynamic(value);
    heads.push(word(BigInt(offset)));
    tails.push(encoded);
    offset += encoded.length;
  }
  heads.push(word(asUint(args[3] as AbiValue)), word(asUint(args[4] as AbiValue)));
  return concat(selector(lock, "createCPU(string,string,string,uint256,uint256)"), ...heads, ...tails);
}

export function encodeGateDCall(lock: ProtocolLock, signature: string, args: readonly AbiValue[] = []): string {
  switch (signature) {
    case "createCPU(string,string,string,uint256,uint256)":
      return bytesToHex(encodeCreate(lock, args));
    case "tapeout(bytes,uint32,uint32)": {
      if (args.length !== 3 || !(args[0] instanceof Uint8Array)) throw new GateDAbiError("tapeout expects bytes, nIn and nOut");
      return bytesToHex(concat(selector(lock, signature), word(96n), word(asUint(args[1] as AbiValue)), word(asUint(args[2] as AbiValue)), paddedDynamic(args[0])));
    }
    case "mint(uint256,uint256)":
      if (args.length !== 2) throw new GateDAbiError("mint expects id and amount");
      return bytesToHex(concat(selector(lock, signature), word(asUint(args[0] as AbiValue)), word(asUint(args[1] as AbiValue))));
    case "balanceOf(address,uint256)":
      if (args.length !== 2) throw new GateDAbiError("balanceOf expects owner and id");
      return bytesToHex(concat(selector(lock, signature), asAddress(args[0] as AbiValue), word(asUint(args[1] as AbiValue))));
    case "isCPU(address)":
      if (args.length !== 1) throw new GateDAbiError("isCPU expects an address");
      return bytesToHex(concat(selector(lock, signature), asAddress(args[0] as AbiValue)));
    case "safeTransferFrom(address,address,uint256,uint256,bytes)":
      throw new GateDAbiError("safeTransferFrom is outside the Gate D acquisition plan");
    default: {
      if (args.length === 0) return bytesToHex(selector(lock, signature));
      if (args.length === 1 && !(args[0] instanceof Uint8Array)) return bytesToHex(concat(selector(lock, signature), word(asUint(args[0] as AbiValue))));
      throw new GateDAbiError(`Unsupported Gate D encoding for ${signature}`);
    }
  }
}

function words(value: string): Uint8Array {
  const bytes = hexToBytes(value);
  if (bytes.length % 32 !== 0) throw new GateDAbiError("ABI return is not word aligned");
  return bytes;
}

function readWord(value: string, index: number): bigint {
  const bytes = words(value);
  const offset = index * 32;
  if (offset + 32 > bytes.length) throw new GateDAbiError("ABI return word is truncated");
  let result = 0n;
  for (const byte of bytes.slice(offset, offset + 32)) result = (result << 8n) | BigInt(byte);
  return result;
}

export function decodeGateDUint256(value: string): bigint {
  if (words(value).length !== 32) throw new GateDAbiError("Expected one uint256 ABI word");
  return readWord(value, 0);
}

export function decodeGateDAddress(value: string, index = 0): string {
  const bytes = words(value);
  const offset = index * 32;
  if (offset + 32 > bytes.length) throw new GateDAbiError("ABI address word is truncated");
  return bytesToHex(bytes.slice(offset + 12, offset + 32));
}

export function decodeGateDBool(value: string): boolean {
  const decoded = decodeGateDUint256(value);
  if (decoded !== 0n && decoded !== 1n) throw new GateDAbiError(`ABI bool is not canonical: ${decoded}`);
  return decoded === 1n;
}

export function decodeGateDString(value: string): string {
  const bytes = words(value);
  const offset = Number(readWord(value, 0));
  if (offset % 32 !== 0 || offset + 32 > bytes.length) throw new GateDAbiError("ABI string offset is invalid");
  const length = Number(readWord(bytesToHex(bytes), offset / 32));
  if (!Number.isSafeInteger(length) || offset + 32 + length > bytes.length) throw new GateDAbiError("ABI string is truncated");
  return new TextDecoder().decode(bytes.slice(offset + 32, offset + 32 + length));
}

export function decodeCreateReturn(value: string): { token: string; processor: string } {
  const bytes = words(value);
  if (bytes.length < 64) throw new GateDAbiError("createCPU return is truncated");
  return { token: decodeGateDAddress(value, 0), processor: decodeGateDAddress(value, 1) };
}

export function sha256Hex(value: string): string {
  return bytesToHex(sha256(hexToBytes(value)));
}

export function hexFromBytes(value: Uint8Array): string {
  return bytesToHex(value);
}

export function padTopicAddress(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}
