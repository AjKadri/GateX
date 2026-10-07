// Circuits this browser has manufactured, remembered in localStorage. Display convenience only: nothing here is evidence.
export const MY_CIRCUITS_KEY = "gatex.myCircuits";
const MAX_REMEMBERED = 20;

export interface MyCircuit {
  id: string;
  name: string;
  payloadSha256: string;
  owner: string;
  tx: string;
  date: string;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}

function isMyCircuit(value: unknown): value is MyCircuit {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return ["id", "name", "payloadSha256", "owner", "tx", "date"].every((key) => typeof record[key] === "string") && /^0x[0-9a-fA-F]{64}$/.test(record.tx as string);
}

export function readMyCircuits(storage: StorageLike | undefined = defaultStorage()): MyCircuit[] {
  try {
    if (storage === undefined) return [];
    const parsed: unknown = JSON.parse(storage.getItem(MY_CIRCUITS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isMyCircuit) : [];
  } catch {
    return [];
  }
}

/** Adds a circuit (newest first). The same transaction is never listed twice. Storage failures are swallowed. */
export function rememberMyCircuit(circuit: MyCircuit, storage: StorageLike | undefined = defaultStorage()): MyCircuit[] {
  const existing = readMyCircuits(storage);
  if (existing.some((entry) => entry.tx.toLowerCase() === circuit.tx.toLowerCase())) return existing;
  const next = [circuit, ...existing].slice(0, MAX_REMEMBERED);
  try { storage?.setItem(MY_CIRCUITS_KEY, JSON.stringify(next)); } catch { /* the list is a convenience; the circuit exists on chain regardless */ }
  return next;
}
