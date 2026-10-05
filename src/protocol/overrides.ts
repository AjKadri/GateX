export type StateOverrides = Record<string, {
  balance?: string;
  code?: string;
  stateDiff?: Record<string, string>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`${label} must be hex`);
  return value;
}

function validateInitialOverrides(value: unknown): StateOverrides {
  if (!isRecord(value)) throw new Error("Initial stateOverrides must be an object");
  const result: StateOverrides = {};
  for (const [address, raw] of Object.entries(value)) {
    if (!isRecord(raw)) throw new Error(`Initial override for ${address} must be an object`);
    const override: StateOverrides[string] = {};
    if ("balance" in raw) override.balance = requireHex(raw.balance, `${address}.balance`);
    if ("code" in raw) override.code = requireHex(raw.code, `${address}.code`);
    if ("stateDiff" in raw) {
      if (!isRecord(raw.stateDiff)) throw new Error(`${address}.stateDiff must be an object`);
      override.stateDiff = {};
      for (const [slot, slotValue] of Object.entries(raw.stateDiff)) override.stateDiff[requireHex(slot, `${address}.stateDiff slot`)] = requireHex(slotValue, `${address}.stateDiff value`);
    }
    result[address] = override;
  }
  return result;
}

export function reconstructPostState(initialOverrides: unknown, traceResult: unknown): StateOverrides {
  const result = validateInitialOverrides(initialOverrides);
  if (!isRecord(traceResult) || !isRecord(traceResult.post)) throw new Error("prestateTracer diffMode result has no post-state");
  for (const [address, raw] of Object.entries(traceResult.post)) {
    if (!isRecord(raw)) throw new Error(`Trace post account ${address} must be an object`);
    const current = result[address] ?? {};
    const next: StateOverrides[string] = clone(current);
    if ("balance" in raw) next.balance = requireHex(raw.balance, `${address}.balance`);
    if ("code" in raw) next.code = requireHex(raw.code, `${address}.code`);
    if ("storage" in raw) {
      if (!isRecord(raw.storage)) throw new Error(`${address}.storage must be an object`);
      const stateDiff = { ...(next.stateDiff ?? {}) };
      for (const [slot, value] of Object.entries(raw.storage)) stateDiff[requireHex(slot, `${address}.storage slot`)] = requireHex(value, `${address}.storage value`);
      next.stateDiff = stateDiff;
    }
    result[address] = next;
  }
  return result;
}

export function stateOverridesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
