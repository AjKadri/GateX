import type { ProtocolLock } from "./types.js";

export type ReadOnlyRpcMethod = "eth_chainId" | "eth_getBlockByNumber" | "eth_getCode" | "eth_call" | "debug_traceCall";

export interface ReadOnlyRpcClient {
  request(method: ReadOnlyRpcMethod, params: readonly unknown[]): Promise<unknown>;
}

export class HttpReadOnlyRpcClient implements ReadOnlyRpcClient {
  constructor(private readonly endpoint: string, private readonly timeoutMs = 10_000) {}

  async request(method: ReadOnlyRpcMethod, params: readonly unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status} from ${this.endpoint}`);
      const body: unknown = await response.json();
      if (!isRecord(body)) throw new Error(`RPC response from ${this.endpoint} is not an object`);
      if ("error" in body) throw new Error(`RPC ${method} failed at ${this.endpoint}: ${JSON.stringify(body.error)}`);
      return body.result;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function providerClients(lock: ProtocolLock): ReadonlyMap<string, ReadOnlyRpcClient> {
  return new Map(lock.snapshot.providers.map((provider) => [provider, new HttpReadOnlyRpcClient(provider)]));
}
