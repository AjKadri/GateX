import assert from "node:assert/strict";
import test from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import ruleGateArtifact from "../contracts/RuleGate.json" with { type: "json" };
import { loadCanonicalDeployment } from "../src/protocol/deployment.js";
import { loadProtocolLock } from "../src/protocol/lock.js";
import type { ReadOnlyRpcClient, ReadOnlyRpcMethod } from "../src/protocol/rpc.js";
import type { Eip1193Provider } from "../src/app/wallet.js";
import type { StorageLike } from "../src/app/tapeout.js";
import {
  ERROR_SELECTORS, RULEGATE, RuleGateClient, SELECTORS, TOPICS, decodeSessionOpenedLog, decodeSessionReturn, decodeSteppedLog, encodeOpen, encodePreview, encodeSession, encodeStep,
  isDeployed, loadRuleGateConfig, pendingStorageKey, stateValue, type RuleGateConfig, type RuleGateDeps
} from "../src/app/rulegate.js";

const lock = loadProtocolLock();
const processor = loadCanonicalDeployment().processor.toLowerCase();
const providers = lock.snapshot.providers;
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const GATE = "0x3333333333333333333333333333333333333333";
const NEW_GATE = "0x4444444444444444444444444444444444444444";
const ZERO = "0x0000000000000000000000000000000000000000";
const CONFIG: RuleGateConfig = { chainId: 196, address: GATE, deployTransaction: null, processor };

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const bytesOf = (...values: number[]): Uint8Array => Uint8Array.from(values);
const word = (value: bigint | number): string => BigInt(value).toString(16).padStart(64, "0");
const pad = (h: string): string => h.padEnd(Math.ceil(h.length / 64) * 64, "0");
const dynamic = (b: Uint8Array): string => word(b.length) + pad(hex(b));
const topicAddress = (a: string): string => `0x${a.slice(2).padStart(64, "0")}`;
function abiTuple(...parts: Uint8Array[]): string {
  let offset = parts.length * 32; const heads: string[] = []; const tails: string[] = [];
  for (const part of parts) { heads.push(word(offset)); const tail = dynamic(part); tails.push(tail); offset += tail.length / 2; }
  return `0x${heads.join("")}${tails.join("")}`;
}
const sig = (s: string): string => `0x${hex(keccak_256(new TextEncoder().encode(s)))}`;

// ---------------------------------------------------------------------------------------------------------------------
// ABI

test("selectors, topics and error selectors match the ABI in contracts/RuleGate.json", () => {
  type Item = { type: string; name?: string; inputs?: Array<{ type: string }> };
  const abi = ruleGateArtifact.abi as Item[];
  const signature = (item: Item): string => `${item.name}(${(item.inputs ?? []).map((input) => input.type).join(",")})`;
  const fn = (name: string): string => sig(signature(abi.find((item) => item.type === "function" && item.name === name) as Item)).slice(0, 10);
  assert.equal(SELECTORS.open, fn("open"));
  assert.equal(SELECTORS.step, fn("step"));
  assert.equal(SELECTORS.preview, fn("preview"));
  assert.equal(SELECTORS.session, fn("session"));
  assert.equal(SELECTORS.sessionCount, fn("sessionCount"));
  assert.equal(SELECTORS.processor, fn("processor"));
  assert.equal(TOPICS.sessionOpened, sig(signature(abi.find((item) => item.type === "event" && item.name === "SessionOpened") as Item)));
  assert.equal(TOPICS.stepped, sig(signature(abi.find((item) => item.type === "event" && item.name === "Stepped") as Item)));
  for (const [name, selector] of Object.entries(ERROR_SELECTORS)) assert.equal(selector, sig(signature(abi.find((item) => item.type === "error" && item.name === name) as Item)).slice(0, 10), name);
  assert.equal(SELECTORS.open, "0x" + hex(keccak_256(new TextEncoder().encode("open(uint256,uint256)"))).slice(0, 8));
});

test("call encoding is the standard ABI layout", () => {
  assert.equal(encodeOpen(3n, 2), `${SELECTORS.open}${word(3)}${word(2)}`);
  assert.equal(encodeSession(9n), `${SELECTORS.session}${word(9)}`);
  assert.equal(encodeStep(5n, bytesOf(1, 2)), `${SELECTORS.step}${word(5)}${word(64)}${word(2)}${"0102".padEnd(64, "0")}`);
  assert.equal(encodePreview(5n, bytesOf(7)), `${SELECTORS.preview}${word(5)}${word(64)}${word(1)}${"07".padEnd(64, "0")}`);
  assert.equal(encodeStep(1n, new Uint8Array(32)).length, 2 + 8 + 64 * 2 + 64 * 2 - 0 + 0);
});

test("session return, SessionOpened and Stepped logs round trip", () => {
  const raw = `0x${word(BigInt(ACCOUNT))}${word(7)}${word(4)}${word(160)}${word(160 + 64)}${dynamic(bytesOf(2, 0))}${dynamic(bytesOf(1))}`;
  const decoded = decodeSessionReturn(12n, raw);
  assert.deepEqual({ ...decoded, state: [...decoded.state], lastOutputs: [...decoded.lastOutputs] }, { id: 12n, owner: ACCOUNT, circuitId: 7n, steps: 4, state: [2, 0], lastOutputs: [1] });
  assert.throws(() => decodeSessionReturn(1n, raw.slice(0, -64)), /truncated|invalid/);
  const opened = decodeSessionOpenedLog({ address: GATE, topics: [TOPICS.sessionOpened, `0x${word(3)}`, `0x${word(2)}`, topicAddress(ACCOUNT)], data: `0x${word(1)}` });
  assert.deepEqual(opened, { sessionId: 3n, circuitId: 2n, owner: ACCOUNT, stateBytes: 1 });
  const stepped = decodeSteppedLog({ address: GATE, topics: [TOPICS.stepped, `0x${word(3)}`, `0x${word(2)}`, topicAddress(ACCOUNT)], data: `0x${word(5)}${word(128)}${word(128 + 64)}${word(128 + 128)}${dynamic(bytesOf(4))}${dynamic(bytesOf(3, 0))}${dynamic(bytesOf(1))}` });
  assert.equal(stepped.step, 5); assert.deepEqual([...stepped.inputs], [4]); assert.deepEqual([...stepped.newState], [3, 0]); assert.deepEqual([...stepped.outputs], [1]); assert.equal(stepped.caller, ACCOUNT);
  assert.throws(() => decodeSteppedLog({ address: GATE, topics: [TOPICS.sessionOpened, `0x${word(1)}`, `0x${word(1)}`, topicAddress(ACCOUNT)], data: "0x" }), /not a Stepped/);
  assert.equal(stateValue(bytesOf(0x02, 0x01)), 258);
});

test("config: shipped file is not deployed and names the GateX processor; bad files are refused", () => {
  assert.equal(RULEGATE.address, null);
  assert.equal(isDeployed(RULEGATE), false);
  assert.equal(RULEGATE.processor, processor);
  assert.equal(loadRuleGateConfig({ chainId: 196, address: GATE.toUpperCase().replace("0X", "0x"), deployTransaction: `0x${"ab".repeat(32)}`, processor }).address, GATE);
  assert.throws(() => loadRuleGateConfig({ chainId: 1, address: null, deployTransaction: null, processor }), /chain 196/);
  assert.throws(() => loadRuleGateConfig({ chainId: 196, address: "0x12", deployTransaction: null, processor }), /address/);
  assert.throws(() => loadRuleGateConfig({ chainId: 196, address: null, deployTransaction: null, processor: OTHER }), /processor/);
  assert.throws(() => loadRuleGateConfig({ chainId: 196, address: null, deployTransaction: "0x1", processor }), /deployTransaction/);
});

// ---------------------------------------------------------------------------------------------------------------------
// fake chain: RuleGate + a processor with the AgentApproval-like table IDLE -> REQUESTED -> APPROVED -> USED

interface Session { owner: string; circuitId: bigint; steps: number; state: Uint8Array; last: Uint8Array }
type Req = { from: string; to?: string; data: string; value: string };
interface Tx { hash: string; request: Req; block: number; ok: boolean; logs: unknown[]; contract?: string }

function transition(state: number, input: number): { next: number; out: number } {
  if (state === 3) return { next: 3, out: 0 };
  if (input & 8) return { next: 0, out: 0 };
  if (state === 0 && input & 1) return { next: 1, out: 0 };
  if (state === 1 && input & 2) return { next: 2, out: 0 };
  if (state === 2 && input & 4) return { next: 3, out: 1 };
  return { next: state, out: 0 };
}
const nodeError = (provider: string, method: string, message: string, data?: string): Error => new Error(`RPC ${method} failed at ${provider}: ${JSON.stringify({ code: 3, message, ...(data === undefined ? {} : { data }) })}`);

class FakeChain {
  head = 1000;
  sessions = new Map<bigint, Session>();
  count = 0n;
  circuits = new Set<bigint>([1n, 2n]);
  txs = new Map<string, Tx>();
  nonce = 5n;
  counter = 0;
  gate = GATE;
  deployedProcessor = processor;
  revertOn = new Set<string>();
  estimateRevertOn = new Set<string>();
  blockHashSkew = new Set<string>();
  receiptBlockSkew = new Set<string>();
  hiddenReceipt = new Set<string>();
  failedReceipt = new Set<string>();
  extraLogs: unknown[] = [];
  dropRuleGateLogs = false;
  stateSkew = new Set<string>();
  log: Array<{ provider: string; method: string; params: readonly unknown[] }> = [];

  hashOf(n: number, provider: string): string { return `0x${(n + (this.blockHashSkew.has(provider) ? 1_000_000 : 0)).toString(16).padStart(64, "0")}`; }
  clients(): ReadonlyMap<string, ReadOnlyRpcClient> {
    return new Map(providers.map((provider) => [provider, { request: async (method: ReadOnlyRpcMethod, params: readonly unknown[]) => this.handle(provider, method, params) } as ReadOnlyRpcClient]));
  }

  private run(provider: string, method: string, from: string, to: string | undefined, data: string): string {
    if (to === undefined) return "0x";
    if (to.toLowerCase() === NEW_GATE) { if (data === SELECTORS.processor) return `0x${word(BigInt(this.deployedProcessor))}`; throw nodeError(provider, method, "execution reverted"); }
    if (to.toLowerCase() !== this.gate) throw nodeError(provider, method, "no contract at target");
    const selector = data.slice(0, 10); const arg = (i: number): bigint => BigInt(`0x${data.slice(10 + i * 64, 10 + (i + 1) * 64)}`);
    const revert = (name: keyof typeof ERROR_SELECTORS): never => { throw nodeError(provider, method, "execution reverted", ERROR_SELECTORS[name]); };
    const readBytes = (): Uint8Array => { const len = Number(arg(Number(arg(1)) / 32)); const start = 10 + (Number(arg(1)) / 32 + 1) * 64; const h = data.slice(start, start + len * 2); return Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16))); };
    if (selector === SELECTORS.sessionCount) return `0x${word(this.count)}`;
    if (selector === SELECTORS.open) {
      if (arg(1) === 0n || arg(1) > 32n) revert("BadLength");
      if (!this.circuits.has(arg(0))) throw nodeError(provider, method, "execution reverted");
      return `0x${word(this.count + 1n)}`;
    }
    const session = this.sessions.get(arg(0));
    if (session === undefined) revert("NoSuchSession");
    const s = session as Session;
    if (selector === SELECTORS.session) {
      const state = dynamic(s.state); const last = dynamic(s.last);
      return `0x${word(BigInt(s.owner))}${word(s.circuitId)}${word(s.steps)}${word(160)}${word(160 + state.length / 2)}${state}${last}`;
    }
    if (selector === SELECTORS.step || selector === SELECTORS.preview) {
      if (selector === SELECTORS.step && s.owner !== from.toLowerCase()) revert("NotSessionOwner");
      const inputs = readBytes(); if (inputs.length === 0 || inputs.length > 32) revert("BadLength");
      const { next, out } = transition(s.state[0] ?? 0, inputs[0] ?? 0);
      const skew = this.stateSkew.has(provider) && selector === SELECTORS.preview ? 1 : 0;
      const newState = Uint8Array.from(s.state, (b, i) => i === 0 ? next ^ skew : b);
      return abiTuple(newState, Uint8Array.of(out));
    }
    throw nodeError(provider, method, "unknown selector");
  }

  mine(request: Req): string {
    this.head += 1; this.counter += 1; this.nonce += 1n;
    const hash = `0x${this.counter.toString(16).padStart(64, "0")}`;
    const from = request.from.toLowerCase(); const logs: unknown[] = []; let ok = true; let contract: string | undefined;
    if (request.to === undefined) contract = NEW_GATE;
    else if (request.data.startsWith(SELECTORS.open)) {
      const circuitId = BigInt(`0x${request.data.slice(10, 74)}`); const n = Number(BigInt(`0x${request.data.slice(74, 138)}`));
      this.count += 1n; this.sessions.set(this.count, { owner: from, circuitId, steps: 0, state: new Uint8Array(n), last: new Uint8Array() });
      logs.push({ address: this.gate, topics: [TOPICS.sessionOpened, `0x${word(this.count)}`, `0x${word(circuitId)}`, topicAddress(from)], data: `0x${word(n)}` });
    } else if (request.data.startsWith(SELECTORS.step)) {
      const id = BigInt(`0x${request.data.slice(10, 74)}`); const s = this.sessions.get(id) as Session;
      const inputs = Uint8Array.from((request.data.slice(10 + 3 * 64, 10 + 3 * 64 + 2).match(/../g) ?? []).map((x) => parseInt(x, 16)));
      const { next, out } = transition(s.state[0] ?? 0, inputs[0] ?? 0);
      s.state = Uint8Array.from(s.state, (b, i) => i === 0 ? next : b); s.last = Uint8Array.of(out); s.steps += 1;
      logs.push({ address: this.gate, topics: [TOPICS.stepped, `0x${word(id)}`, `0x${word(s.circuitId)}`, topicAddress(from)], data: `0x${word(s.steps)}${word(128)}${word(128 + 64)}${word(128 + 128)}${dynamic(inputs.slice(0, 1))}${dynamic(s.state)}${dynamic(s.last)}` });
    } else ok = false;
    if (this.dropRuleGateLogs) logs.length = 0;
    logs.push(...this.extraLogs);
    this.txs.set(hash, { hash, request, block: this.head, ok, logs, contract });
    return hash;
  }

  private async handle(provider: string, method: ReadOnlyRpcMethod, params: readonly unknown[]): Promise<unknown> {
    this.log.push({ provider, method, params });
    switch (method) {
      case "eth_chainId": return "0xc4";
      case "eth_blockNumber": return `0x${(this.head + (provider === providers[1] ? 1 : 0)).toString(16)}`;
      case "eth_getBlockByNumber": return { hash: this.hashOf(Number(BigInt(params[0] as string)), provider) };
      case "eth_getTransactionCount": return `0x${this.nonce.toString(16)}`;
      case "eth_call": case "eth_estimateGas": {
        if (method === "eth_estimateGas" && this.estimateRevertOn.has(provider)) throw nodeError(provider, method, "gas required exceeds allowance");
        if (this.revertOn.has(provider) && method === "eth_call") throw nodeError(provider, method, "execution reverted");
        const call = params[0] as { from?: string; to?: string; data: string };
        const result = this.run(provider, method, call.from ?? ZERO, call.to, call.data);
        return method === "eth_call" ? result : "0x186a0";
      }
      case "eth_getTransactionReceipt": case "eth_getTransactionByHash": {
        const tx = this.txs.get(params[0] as string);
        if (tx === undefined || this.hiddenReceipt.has(provider)) return null;
        const blockHash = this.hashOf(tx.block + (this.receiptBlockSkew.has(provider) ? 7 : 0), provider);
        const blockNumber = `0x${tx.block.toString(16)}`;
        if (method === "eth_getTransactionByHash") return { hash: tx.hash, from: tx.request.from, to: tx.request.to ?? null, input: tx.request.data, value: tx.request.value, blockHash, blockNumber };
        return { status: !tx.ok || this.failedReceipt.has(provider) ? "0x0" : "0x1", blockHash, blockNumber, logs: tx.logs, ...(tx.contract === undefined ? {} : { contractAddress: tx.contract }) };
      }
      default: throw new Error(`Unexpected RPC method ${method}`);
    }
  }
}

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

class FakeWallet implements Eip1193Provider {
  sent: Array<Record<string, string>> = [];
  chain = "0xc4";
  accounts = [ACCOUNT];
  sendError?: unknown;
  noHash = false;
  mined = true;
  constructor(private readonly chainState: FakeChain) {}
  async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
    if (method === "eth_chainId") return this.chain;
    if (method === "eth_accounts") return this.accounts;
    if (method === "eth_sendTransaction") {
      const request = (params as Req[])[0] as Req;
      this.sent.push(request);
      if (this.sendError !== undefined) throw this.sendError;
      if (this.noHash) return undefined;
      if (!this.mined) return `0x${"dd".repeat(32)}`;
      return this.chainState.mine(request);
    }
    throw new Error(`unexpected wallet method ${method}`);
  }
}

function setup(over: { config?: RuleGateConfig; storage?: StorageLike | null; timeoutMs?: number } = {}) {
  const chain = new FakeChain();
  const storage = over.storage === null ? undefined : (over.storage ?? new MemoryStorage());
  let clock = 0;
  const deps: RuleGateDeps = { config: over.config ?? CONFIG, lock, clients: chain.clients(), ...(storage === undefined ? {} : { storage }), sleep: async (ms) => { clock += ms; }, now: () => clock, pollIntervalMs: 2_000, timeoutMs: over.timeoutMs ?? 60_000 };
  return { chain, storage, deps, client: new RuleGateClient(deps), wallet: new FakeWallet(chain) };
}
function seed(chain: FakeChain, owner = ACCOUNT, state = 0): void {
  chain.count += 1n; chain.sessions.set(chain.count, { owner, circuitId: 2n, steps: 0, state: Uint8Array.of(state), last: new Uint8Array() });
}

// ---------------------------------------------------------------------------------------------------------------------
// reads

test("reads: session, count, newest list and preview come from both providers at a common block", async () => {
  const { chain, client } = setup();
  for (let i = 0; i < 25; i += 1) seed(chain, i % 2 === 0 ? ACCOUNT : OTHER);
  const session = await client.readSession(25n);
  assert.equal(session?.owner, ACCOUNT); assert.equal(session?.circuitId, 2n); assert.deepEqual([...(session?.state ?? [])], [0]); assert.equal(session?.block, 1000);
  assert.equal(await client.readSession(99n), undefined);
  assert.equal((await client.readSessionCount()).count, 25n);
  const list = await client.listSessions({ newest: 20 });
  assert.equal(list.rows.length, 20); assert.equal(list.rows[0]?.id, 25n); assert.equal(list.rows[19]?.id, 6n); assert.equal(list.count, 25n);
  const preview = await client.previewStep(25n, bytesOf(1));
  assert.deepEqual([...preview.newState], [1]); assert.deepEqual([...preview.outputs], [0]);
  await assert.rejects(client.previewStep(99n, bytesOf(1)), /no such session/i);
  const tags = new Set(chain.log.filter((entry) => entry.method === "eth_call").map((entry) => entry.params[1]));
  assert.ok([...tags].every((tag) => tag === "0x3e8"), "every read used the common block");
  for (const provider of providers) assert.ok(chain.log.some((entry) => entry.provider === provider && entry.method === "eth_call"));
});

test("reads: disagreement between providers is an error, never a guess", async () => {
  const a = setup(); seed(a.chain); a.chain.stateSkew.add(providers[1] as string);
  await assert.rejects(a.client.previewStep(1n, bytesOf(1)), /different answers/);
  const b = setup(); seed(b.chain); b.chain.blockHashSkew.add(providers[1] as string);
  await assert.rejects(b.client.readSession(1n), /disagree about block/);
  const c = setup(); seed(c.chain); c.chain.revertOn.add(providers[0] as string);
  await assert.rejects(c.client.readSession(1n), /disagree/);
  const d = setup({ config: { ...CONFIG, address: null } });
  await assert.rejects(d.client.readSessionCount(), /not deployed/);
});

test("reads: minBlock waits for the providers to catch up, then gives up with a clear message", async () => {
  const { chain, client } = setup(); seed(chain);
  await assert.rejects(client.readSession(1n, { minBlock: 1500 }), /caught up/);
  assert.ok(chain.log.filter((entry) => entry.method === "eth_blockNumber").length >= 40);
});

// ---------------------------------------------------------------------------------------------------------------------
// writes

const exactKeys = (tx: Record<string, string>): string => Object.keys(tx).sort().join(",");

test("open: exact transaction fields, dual simulation, event decoded from the receipt", async () => {
  const { chain, client, wallet, storage } = setup();
  const phases: string[] = [];
  const result = await client.openSession(wallet, ACCOUNT, 2n, 1, (phase) => phases.push(phase));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sessionId, 1n); assert.equal(result.circuitId, 2n);
  assert.equal(wallet.sent.length, 1);
  assert.deepEqual(wallet.sent[0], { from: ACCOUNT, to: GATE, data: encodeOpen(2n, 1), value: "0x0" });
  assert.equal(exactKeys(wallet.sent[0] as Record<string, string>), "data,from,to,value");
  for (const provider of providers) for (const method of ["eth_call", "eth_estimateGas"]) assert.ok(chain.log.some((entry) => entry.provider === provider && entry.method === method && (entry.params[0] as { from: string }).from === ACCOUNT), `${method} on ${provider}`);
  assert.deepEqual(phases.slice(0, 3), ["checking", "confirm", "waiting"]);
  assert.equal((storage as MemoryStorage).values.size, 0, "pending cleared after confirmation");
});

test("step: exact fields, result decoded from the Stepped event, permit output reported", async () => {
  const { chain, client, wallet } = setup(); seed(chain, ACCOUNT, 2);
  const result = await client.stepSession(wallet, ACCOUNT, 1n, bytesOf(4));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.step, 1); assert.deepEqual([...result.newState], [3]); assert.deepEqual([...result.outputs], [1]); assert.deepEqual([...result.inputs], [4]);
  assert.deepEqual(wallet.sent[0], { from: ACCOUNT, to: GATE, data: encodeStep(1n, bytesOf(4)), value: "0x0" });
  const again = await client.stepSession(wallet, ACCOUNT, 1n, bytesOf(1));
  assert.equal(again.ok && again.step, 2, "a second send is allowed once the first is confirmed");
});

test("refusals: not deployed, bad input, wrong chain, wrong account, no storage", async () => {
  const none = setup({ config: { ...CONFIG, address: null } });
  assert.deepEqual(await none.client.openSession(none.wallet, ACCOUNT, 1n, 1), { ok: false, code: "not-deployed", reason: "RuleGate is not deployed yet." });
  const s = setup(); seed(s.chain);
  for (const attempt of [s.client.openSession(s.wallet, ACCOUNT, 0n, 1), s.client.openSession(s.wallet, ACCOUNT, 1n, 0), s.client.openSession(s.wallet, ACCOUNT, 1n, 33), s.client.stepSession(s.wallet, ACCOUNT, 0n, bytesOf(1)), s.client.stepSession(s.wallet, ACCOUNT, 1n, new Uint8Array()), s.client.stepSession(s.wallet, ACCOUNT, 1n, new Uint8Array(33)), s.client.stepSession(s.wallet, "nope", 1n, bytesOf(1))]) {
    const r = await attempt; assert.equal(r.ok, false); assert.equal(r.ok === false && r.code, "bad-input");
  }
  s.wallet.chain = "0x1";
  const wrongChain = await s.client.stepSession(s.wallet, ACCOUNT, 1n, bytesOf(1));
  assert.equal(wrongChain.ok === false && wrongChain.code, "wallet-chain");
  s.wallet.chain = "0xc4"; s.wallet.accounts = [OTHER];
  const wrongAccount = await s.client.stepSession(s.wallet, ACCOUNT, 1n, bytesOf(1));
  assert.equal(wrongAccount.ok === false && wrongAccount.code, "wallet");
  const noStorage = setup({ storage: null }); seed(noStorage.chain);
  const stored = await noStorage.client.stepSession(noStorage.wallet, ACCOUNT, 1n, bytesOf(1));
  assert.equal(stored.ok === false && stored.code, "storage");
  assert.equal(s.wallet.sent.length + noStorage.wallet.sent.length, 0, "nothing was sent in any refusal");
});

test("refusals: simulations that fail or disagree send nothing and speak plainly", async () => {
  const notYours = setup(); seed(notYours.chain, OTHER);
  const r1 = await notYours.client.stepSession(notYours.wallet, ACCOUNT, 1n, bytesOf(1));
  assert.equal(r1.ok, false); assert.match(r1.ok ? "" : r1.reason, /not your session/i); assert.equal(r1.ok === false && r1.code, "simulation");
  const missing = await notYours.client.stepSession(notYours.wallet, ACCOUNT, 9n, bytesOf(1));
  assert.match(missing.ok ? "" : missing.reason, /no such session/i);
  const unknownCircuit = await notYours.client.openSession(notYours.wallet, ACCOUNT, 77n, 1);
  assert.equal(unknownCircuit.ok, false);
  const oneProvider = setup(); seed(oneProvider.chain); oneProvider.chain.revertOn.add(providers[1] as string);
  assert.equal((await oneProvider.client.stepSession(oneProvider.wallet, ACCOUNT, 1n, bytesOf(1))).ok, false);
  const estimate = setup(); seed(estimate.chain); estimate.chain.estimateRevertOn.add(providers[0] as string);
  const r2 = await estimate.client.stepSession(estimate.wallet, ACCOUNT, 1n, bytesOf(1));
  assert.equal(r2.ok === false && r2.code, "simulation");
  const split = setup(); seed(split.chain); split.chain.stateSkew.add(providers[1] as string);
  // the skew only affects preview, so make the two providers answer eth_call differently for step too
  const original = split.deps.clients.get(providers[1] as string) as ReadOnlyRpcClient;
  (split.deps.clients as Map<string, ReadOnlyRpcClient>).set(providers[1] as string, { request: async (method, params) => { const out = await original.request(method, params); return method === "eth_call" ? `${out}00` : out; } });
  const r3 = await split.client.stepSession(split.wallet, ACCOUNT, 1n, bytesOf(1));
  assert.equal(r3.ok === false && r3.code, "providers-disagree");
  for (const s of [notYours, oneProvider, estimate, split]) assert.equal(s.wallet.sent.length, 0);
});

test("user rejection reports the cancellation and leaves nothing pending", async () => {
  const { chain, client, wallet, storage } = setup(); seed(chain);
  wallet.sendError = { code: 4001, message: "User rejected the request." };
  const result = await client.stepSession(wallet, ACCOUNT, 1n, bytesOf(1));
  assert.deepEqual(result, { ok: false, code: "cancelled", reason: "Cancelled in wallet. Nothing was sent." });
  assert.equal((storage as MemoryStorage).values.size, 0);
  wallet.sendError = undefined;
  assert.equal((await client.stepSession(wallet, ACCOUNT, 1n, bytesOf(1))).ok, true);
});

test("no double send: pending blocks a second send, also from a new instance over the same storage", async () => {
  const { chain, client, wallet, storage, deps } = setup({ timeoutMs: 10_000 }); seed(chain);
  chain.hiddenReceipt.add(providers[0] as string);
  const first = await client.stepSession(wallet, ACCOUNT, 1n, bytesOf(1));
  assert.equal(first.ok === false && first.code, "timeout");
  assert.equal(wallet.sent.length, 1);
  assert.equal(client.pending(ACCOUNT)?.phase, "submitted");
  const second = await client.stepSession(wallet, ACCOUNT, 1n, bytesOf(2));
  assert.equal(second.ok === false && second.code, "pending");
  const reloaded = new RuleGateClient({ ...deps, storage });
  const third = await reloaded.openSession(wallet, ACCOUNT, 1n, 1);
  assert.equal(third.ok === false && third.code, "pending");
  assert.equal(wallet.sent.length, 1, "still exactly one transaction sent");
  const other = await reloaded.stepSession({ ...wallet, request: wallet.request.bind(wallet) } as Eip1193Provider, OTHER, 1n, bytesOf(1));
  assert.notEqual(other.ok === false && other.code, "pending", "pending is per account");
  // after a reload the hash is followed, not re-sent
  chain.hiddenReceipt.clear();
  const resumed = await reloaded.resume(ACCOUNT);
  assert.equal(resumed !== undefined && resumed.ok, true);
  assert.equal(wallet.sent.length, 1);
  assert.equal(reloaded.pending(ACCOUNT), undefined);
});

test("an interrupted signature request blocks sending until the user discards it", async () => {
  const { chain, client, wallet, storage } = setup(); seed(chain);
  wallet.noHash = true;
  const first = await client.stepSession(wallet, ACCOUNT, 1n, bytesOf(1));
  assert.equal(first.ok === false && first.code, "wallet");
  assert.equal(client.pending(ACCOUNT)?.phase, "signing");
  assert.equal((await client.stepSession(wallet, ACCOUNT, 1n, bytesOf(1))).ok === false, true);
  assert.equal(wallet.sent.length, 1);
  assert.ok((storage as MemoryStorage).values.has(pendingStorageKey(ACCOUNT)));
  assert.equal(client.discardInterruptedSigning(ACCOUNT), true);
  wallet.noHash = false;
  assert.equal((await client.stepSession(wallet, ACCOUNT, 1n, bytesOf(1))).ok, true);
});

test("a dropped transaction is released only when both providers never saw it and the nonce moved", async () => {
  const { chain, client, wallet, storage } = setup({ timeoutMs: 6_000 }); seed(chain);
  wallet.mined = false;
  const sent = await client.stepSession(wallet, ACCOUNT, 1n, bytesOf(1));
  assert.equal(sent.ok === false && sent.code, "timeout");
  assert.equal((await client.releaseDroppedPending(ACCOUNT)).released, false, "nonce has not moved past the recorded one");
  chain.txs.set(`0x${"dd".repeat(32)}`, { hash: `0x${"dd".repeat(32)}`, request: { from: ACCOUNT, data: "0x", value: "0x0" }, block: 1, ok: true, logs: [] });
  chain.nonce += 1n;
  chain.hiddenReceipt.clear();
  assert.equal((await client.releaseDroppedPending(ACCOUNT)).released, false, "a provider still knows the transaction");
  chain.txs.clear();
  assert.equal((await client.releaseDroppedPending(ACCOUNT)).released, true);
  assert.equal(client.pending(ACCOUNT), undefined);
  assert.equal((storage as MemoryStorage).values.size, 0);
  wallet.mined = true;
  assert.equal((await client.stepSession(wallet, ACCOUNT, 1n, bytesOf(1))).ok, true);
});

test("receipts: failure, disagreement, wrong block, missing event and foreign events are handled", async () => {
  const failed = setup(); seed(failed.chain); failed.chain.failedReceipt.add(providers[0] as string); failed.chain.failedReceipt.add(providers[1] as string);
  const r1 = await failed.client.stepSession(failed.wallet, ACCOUNT, 1n, bytesOf(1));
  assert.equal(r1.ok === false && r1.code, "failed"); assert.equal(failed.client.pending(ACCOUNT), undefined);
  const split = setup({ timeoutMs: 6_000 }); seed(split.chain); split.chain.failedReceipt.add(providers[1] as string);
  assert.equal((await split.client.stepSession(split.wallet, ACCOUNT, 1n, bytesOf(1))).ok === false && true, true);
  assert.equal(split.client.pending(ACCOUNT)?.phase, "submitted");
  const skew = setup(); seed(skew.chain); skew.chain.receiptBlockSkew.add(providers[1] as string);
  const r3 = await skew.client.stepSession(skew.wallet, ACCOUNT, 1n, bytesOf(1));
  assert.equal(r3.ok === false && r3.code, "mismatch");
  const noEvent = setup(); seed(noEvent.chain); noEvent.chain.dropRuleGateLogs = true;
  const r4 = await noEvent.client.stepSession(noEvent.wallet, ACCOUNT, 1n, bytesOf(1));
  assert.equal(r4.ok === false && r4.code, "mismatch");
  const foreign = setup(); seed(foreign.chain, ACCOUNT, 2);
  foreign.chain.dropRuleGateLogs = true;
  foreign.chain.extraLogs.push({ address: OTHER, topics: [TOPICS.stepped, `0x${word(1)}`, `0x${word(2)}`, topicAddress(ACCOUNT)], data: `0x${word(9)}${word(128)}${word(192)}${word(256)}${dynamic(bytesOf(4))}${dynamic(bytesOf(3))}${dynamic(bytesOf(1))}` });
  const r5 = await foreign.client.stepSession(foreign.wallet, ACCOUNT, 1n, bytesOf(4));
  assert.equal(r5.ok === false && r5.code, "mismatch", "a Stepped log from another contract is ignored");
  const tampered = setup(); seed(tampered.chain);
  const real = tampered.wallet.request.bind(tampered.wallet);
  tampered.wallet.request = async (args) => { if (args.method === "eth_sendTransaction") { const hash = (await real(args)) as string; const tx = tampered.chain.txs.get(hash) as Tx; tx.request = { ...tx.request, data: encodeStep(1n, bytesOf(2)) }; return hash; } return real(args); };
  const r6 = await tampered.client.stepSession(tampered.wallet, ACCOUNT, 1n, bytesOf(1));
  assert.equal(r6.ok === false && r6.code, "mismatch", "a transaction that differs from what was sent is not accepted");
});

test("deployment: creation transaction has no `to`, is estimated on both providers, and the address is verified", async () => {
  const { chain, client, wallet } = setup({ config: { ...CONFIG, address: null } });
  const data = `${ruleGateArtifact.bytecode}${processor.slice(2).padStart(64, "0")}`;
  const sent = await client.deployRuleGate(wallet, ACCOUNT);
  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  assert.equal(wallet.sent.length, 1);
  assert.deepEqual(wallet.sent[0], { from: ACCOUNT, data, value: "0x0" });
  assert.equal("to" in (wallet.sent[0] as object), false);
  for (const provider of providers) assert.ok(chain.log.some((entry) => entry.provider === provider && entry.method === "eth_estimateGas" && (entry.params[0] as { to?: string }).to === undefined));
  assert.equal((await client.deployRuleGate(wallet, ACCOUNT)).ok === false, true, "a second deployment is blocked while the first is pending");
  const done = await client.awaitDeployment(sent.hash);
  assert.equal(done.ok, true);
  if (done.ok) { assert.equal(done.address, NEW_GATE); assert.equal(done.hash, sent.hash); }
  assert.equal(client.pending(ACCOUNT), undefined);
  for (const provider of providers) assert.ok(chain.log.some((entry) => entry.provider === provider && entry.method === "eth_call" && (entry.params[0] as { to: string }).to === NEW_GATE));
});

test("deployment: a contract that points at another processor is rejected; a failing estimate sends nothing", async () => {
  const bad = setup({ config: { ...CONFIG, address: null } });
  bad.chain.deployedProcessor = OTHER;
  const sent = await bad.client.deployRuleGate(bad.wallet, ACCOUNT);
  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  const done = await bad.client.awaitDeployment(sent.hash);
  assert.equal(done.ok === false && done.code, "mismatch"); assert.match(done.ok ? "" : done.reason, /does not point at the GateX processor/);
  const noGas = setup({ config: { ...CONFIG, address: null } });
  noGas.chain.estimateRevertOn.add(providers[1] as string);
  const refused = await noGas.client.deployRuleGate(noGas.wallet, ACCOUNT);
  assert.equal(refused.ok === false && refused.code, "simulation"); assert.equal(noGas.wallet.sent.length, 0);
  const wrongChain = setup({ config: { ...CONFIG, address: null } }); wrongChain.wallet.chain = "0x1";
  assert.equal((await wrongChain.client.deployRuleGate(wrongChain.wallet, ACCOUNT)).ok === false, true);
  assert.equal(wrongChain.wallet.sent.length, 0);
});
