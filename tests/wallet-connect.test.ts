import test from "node:test";
import assert from "node:assert/strict";
import { connectOkx, revokeOkx, type Eip1193Provider, type WalletState } from "../src/app/wallet.js";

const ACCOUNT = "0x845d8071a14f869caf6b12de9426f27d419adc3f";

function fakeProvider(options: { permissions?: "ok" | "reject" | "unsupported"; revoke?: "ok" | "unsupported" } = {}): { provider: Eip1193Provider; calls: string[] } {
  const calls: string[] = [];
  const provider: Eip1193Provider = {
    request: async ({ method }: { method: string }) => {
      calls.push(method);
      if (method === "wallet_requestPermissions") {
        if (options.permissions === "reject") throw Object.assign(new Error("User rejected"), { code: 4001 });
        if (options.permissions === "unsupported") throw Object.assign(new Error("Method not found"), { code: -32601 });
        return [{ parentCapability: "eth_accounts" }];
      }
      if (method === "wallet_revokePermissions") { if (options.revoke === "unsupported") throw new Error("Method not found"); return null; }
      if (method === "eth_chainId") return "0xc4";
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [ACCOUNT];
      throw new Error(`unexpected ${method}`);
    }
  } as Eip1193Provider;
  return { provider, calls };
}

const base = (provider: Eip1193Provider): WalletState => ({ provider, status: "disconnected" } as WalletState);

test("connect asks the wallet for permission every time, then reads the account", async () => {
  const { provider, calls } = fakeProvider();
  const result = await connectOkx(base(provider));
  assert.equal(calls[0], "wallet_requestPermissions");
  assert.ok(calls.includes("eth_requestAccounts"));
  assert.equal(result.status, "ready");
  assert.equal(result.account, ACCOUNT);
});

test("a rejected permission request leaves the wallet disconnected and asks nothing else", async () => {
  const { provider, calls } = fakeProvider({ permissions: "reject" });
  const result = await connectOkx(base(provider));
  assert.equal(result.status, "disconnected");
  assert.equal(result.account, undefined);
  assert.deepEqual(calls, ["wallet_requestPermissions"]);
});

test("wallets without wallet_requestPermissions still connect through eth_requestAccounts", async () => {
  const { provider, calls } = fakeProvider({ permissions: "unsupported" });
  const result = await connectOkx(base(provider));
  assert.equal(result.status, "ready");
  assert.ok(calls.includes("eth_requestAccounts"));
});

test("revoking never throws, even when the wallet does not support it", async () => {
  const { provider, calls } = fakeProvider({ revoke: "unsupported" });
  await revokeOkx(base(provider));
  assert.deepEqual(calls, ["wallet_revokePermissions"]);
});
