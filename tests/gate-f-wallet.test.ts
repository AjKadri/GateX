import test from "node:test";
import assert from "node:assert/strict";
import { bindProviderEvents, discoverOkxProvider, requestOkxAccounts, type Eip1193Provider } from "../src/app/wallet.js";

test("wallet discovery rejects an ambiguous generic ethereum provider", () => {
  const original = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ethereum: { request: async () => "0x1" } } });
  assert.equal(discoverOkxProvider().status, "unavailable");
  Object.defineProperty(globalThis, "window", { configurable: true, value: original });
});

test("wallet connection checks X Layer before requesting accounts", async () => {
  let requestAccountsCalls = 0;
  const provider: Eip1193Provider = { isOkxWallet: true, request: async ({ method }) => {
    if (method === "eth_chainId") return "0x1";
    requestAccountsCalls += 1;
    return ["0x1111111111111111111111111111111111111111"];
  } };
  const result = await requestOkxAccounts({ status: "disconnected", provider, rdns: "com.okex.wallet" });
  assert.equal(result.status, "wrong-network");
  assert.equal(requestAccountsCalls, 0);
});

test("wallet connection rereads the same OKX provider after explicit approval", async () => {
  const calls: string[] = [];
  const provider: Eip1193Provider = { isOkxWallet: true, request: async ({ method }) => {
    calls.push(method);
    if (method === "eth_chainId") return "0xc4";
    if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"];
    if (method === "eth_accounts") return ["0x1111111111111111111111111111111111111111"];
    return [];
  } };
  const result = await requestOkxAccounts({ status: "disconnected", provider, rdns: "com.okex.wallet" });
  assert.equal(result.status, "ready");
  assert.equal(result.account, "0x1111111111111111111111111111111111111111");
  assert.deepEqual(calls, ["eth_chainId", "eth_requestAccounts", "eth_chainId", "eth_accounts"]);
});

test("wallet account and chain events invalidate before rereading readiness", async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let chain = "0xc4";
  let account: string | undefined = "0x1111111111111111111111111111111111111111";
  const provider: Eip1193Provider = {
    isOkxWallet: true,
    request: async ({ method }) => method === "eth_chainId" ? chain : method === "eth_accounts" ? account === undefined ? [] : [account] : []
  };
  provider.on = (event, listener) => { listeners.set(event, listener); };
  const changes: string[] = [];
  bindProviderEvents({ status: "ready", provider, account: "0x1111111111111111111111111111111111111111", chainId: "0xc4" }, (next) => changes.push(next.status));
  account = undefined;
  listeners.get("accountsChanged")?.([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  chain = "0x1";
  listeners.get("chainChanged")?.("0x1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(changes, ["disconnected", "disconnected", "wrong-network", "wrong-network"]);
});
