import assert from "node:assert/strict";
import test from "node:test";
import { compileMachine } from "../src/compiler/compiler.js";
import { AGENT_APPROVAL_SOURCE } from "../src/examples/agentApproval.js";
import { loadCanonicalDeployment } from "../src/protocol/deployment.js";
import { decodeMintCall, decodeTapeoutCall } from "../src/protocol/gate-d-abi.js";
import { loadProtocolLock } from "../src/protocol/lock.js";
import type { ReadOnlyRpcClient, ReadOnlyRpcMethod } from "../src/protocol/rpc.js";
import type { CircuitBindingReadback } from "../src/app/binding.js";
import type { LiveStepResult, ReadOnlyQuote } from "../src/app/protocol.js";
import {
  CANCELLED_MESSAGE,
  TapeoutExecutor,
  X_LAYER_ADD_CHAIN_PARAMS,
  planTapeout,
  readSafetyLimits,
  safetyLimitViolation,
  switchToXLayer,
  verifyNewCircuit,
  type PendingRecord,
  type PlanInput,
  type StorageLike,
  type TapeoutDeps,
  type TapeoutPlan,
  type VerificationTarget
} from "../src/app/tapeout.js";
import type { Eip1193Provider } from "../src/app/wallet.js";
import type { CompiledMachine } from "../src/compiler/types.js";

const lock = loadProtocolLock();
const deployment = loadCanonicalDeployment();
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";
const PRICE = 1_000_000_000_000n;
const FEE = 660_000_000_000_000n;
const TAPEOUT_FEE = 1_300_000_000_000_000n;
const GAS_PRICE = 100_000_000n;
const GAS = 100_000n;
const CEILING = BigInt(readSafetyLimits(lock)?.provisionalPerArtifactGasCeiling ?? 0);
const providers = lock.snapshot.providers;
const compiledPromise: Promise<CompiledMachine> = compileMachine(AGENT_APPROVAL_SOURCE);

function word(value: bigint): string { return value.toString(16).padStart(64, "0"); }
function topicAddress(value: string): string { return `0x${value.slice(2).toLowerCase().padStart(64, "0")}`; }
function eventTopic(signature: string): string { return lock.gateD?.events.find((event) => event.signature === signature)?.topic0 as string; }

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

class BrokenStorage implements StorageLike {
  getItem(): string | null { throw new Error("storage blocked"); }
  setItem(): void { throw new Error("storage blocked"); }
  removeItem(): void { throw new Error("storage blocked"); }
}

interface MinedTx { hash: string; request: { from: string; to: string; data: string; value: string }; block: number; ok: boolean }

/** A tiny in-memory X Layer: balances, prices, and the three calls GateX makes. Both fake providers read it unless overridden. */
class FakeChain {
  nand = 0n;
  latch = 0n;
  minted = 100n;
  cap = 10_000n;
  native = 10n ** 18n;
  nonce = 7n;
  block = 1_000;
  nextId = 3n;
  needNand = 98n;
  needLatch = 2n;
  gas = GAS;
  price = PRICE;
  fee = FEE;
  tapeoutFee = TAPEOUT_FEE;
  gasPrice = GAS_PRICE;
  revertOn = new Set<string>();
  chainIds = new Map<string, number>();
  gasOverride = new Map<string, bigint>();
  receiptHidden = new Set<string>();
  receiptFailed = new Set<string>();
  receiptBlockHash = new Map<string, string>();
  headLag = 1;
  requestLog: Array<{ provider: string; method: string }> = [];
  txs = new Map<string, MinedTx>();
  disagree = false;
  quoteCalls = 0;
  private counter = 0;

  get head(): number { return this.block + this.headLag; }
  blockHash(number: number): string { return `0x${number.toString(16).padStart(64, "0")}`; }

  quote = async (account: string): Promise<ReadOnlyQuote> => {
    this.quoteCalls += 1;
    return { block: { number: this.head, hash: this.blockHash(this.head), tag: `0x${this.head.toString(16)}` }, providers, chainIds: providers.map((provider) => this.chainIds.get(provider) ?? 196), minted: this.minted, cap: this.cap, mintPriceWei: this.price, protocolFeeWei: this.fee, tapeoutFeeWei: this.tapeoutFee, gasPriceWei: this.gasPrice, account, nativeBalanceWei: this.native, nonce: this.nonce, nandBalance: this.nand, latchBalance: this.latch, agreement: !this.disagree };
  };

  newHash(): string { this.counter += 1; return `0x${this.counter.toString(16).padStart(64, "0")}`; }

  /** Applies the effect of a mined transaction and records it so receipts can be served. */
  mine(hash: string, request: { from: string; to: string; data: string; value: string }, ok = true): void {
    this.block += 1;
    if (ok) {
      if (request.to.toLowerCase() === deployment.token.toLowerCase()) {
        const call = decodeMintCall(lock, request.data);
        if (call.id === 0n) this.nand += call.amount; else this.latch += call.amount;
        this.minted += call.amount;
      } else {
        this.nand -= this.needNand;
        this.latch -= this.needLatch;
        this.nextId += 1n;
      }
    }
    this.nonce += 1n;
    this.txs.set(hash, { hash, request, block: this.block, ok });
  }

  receiptFor(provider: string, hash: string): { receipt: unknown; transaction: unknown } | null {
    const tx = this.txs.get(hash);
    if (tx === undefined || this.receiptHidden.has(provider)) return null;
    const blockHash = this.receiptBlockHash.get(provider) ?? this.blockHash(tx.block);
    const blockNumber = `0x${tx.block.toString(16)}`;
    const failed = !tx.ok || this.receiptFailed.has(provider);
    const logs: unknown[] = [];
    if (!failed) {
      if (tx.request.to.toLowerCase() === deployment.token.toLowerCase()) {
        const call = decodeMintCall(lock, tx.request.data);
        logs.push(
          { address: deployment.token, topics: [eventTopic("Minted(address,uint256,uint256,uint256)"), topicAddress(tx.request.from), `0x${word(call.id)}`], data: `0x${word(call.amount)}${word(BigInt(tx.request.value))}` },
          { address: deployment.token, topics: [eventTopic("TransferSingle(address,address,address,uint256,uint256)"), topicAddress(tx.request.from), topicAddress(ZERO), topicAddress(tx.request.from)], data: `0x${word(call.id)}${word(call.amount)}` }
        );
      } else {
        const circuitId = this.nextId - 1n;
        logs.push(
          { address: deployment.processor, topics: [eventTopic("TapedOut(uint256,address,uint32,uint32)"), `0x${word(circuitId)}`, topicAddress(tx.request.from)], data: `0x${word(100n)}${word(2n)}` },
          { address: deployment.processor, topics: [eventTopic("Transfer(address,address,uint256)"), topicAddress(ZERO), topicAddress(tx.request.from), `0x${word(circuitId)}`], data: "0x" }
        );
      }
    }
    return {
      receipt: { status: failed ? "0x0" : "0x1", transactionHash: hash, blockHash, blockNumber, from: tx.request.from, to: tx.request.to, gasUsed: "0x186a0", effectiveGasPrice: "0x5f5e100", logs },
      transaction: { hash, from: tx.request.from, to: tx.request.to, value: tx.request.value, input: tx.request.data, blockHash, blockNumber }
    };
  }

  clients(): ReadonlyMap<string, ReadOnlyRpcClient> {
    return new Map(providers.map((provider) => [provider, { request: (method: ReadOnlyRpcMethod, params: readonly unknown[]) => this.handle(provider, method, params) } as ReadOnlyRpcClient]));
  }

  private async handle(provider: string, method: ReadOnlyRpcMethod, params: readonly unknown[]): Promise<unknown> {
    this.requestLog.push({ provider, method });
    switch (method) {
      case "eth_chainId": return `0x${(this.chainIds.get(provider) ?? 196).toString(16)}`;
      case "eth_blockNumber": return `0x${this.head.toString(16)}`;
      case "eth_getTransactionCount": return `0x${this.nonce.toString(16)}`;
      case "eth_getTransactionByHash": {
        const found = this.receiptFor(provider, params[0] as string);
        return found === null ? null : found.transaction;
      }
      case "eth_getTransactionReceipt": {
        const found = this.receiptFor(provider, params[0] as string);
        return found === null ? null : found.receipt;
      }
      case "eth_call":
      case "eth_estimateGas": {
        const call = params[0] as { from: string; to: string; data: string; value: string };
        if (this.revertOn.has(provider)) throw new Error(`RPC ${method} failed at ${provider}: ${JSON.stringify({ code: 3, message: "execution reverted: simulated revert" })}`);
        const value = BigInt(call.value);
        if (this.native < value) throw new Error(`RPC ${method} failed at ${provider}: ${JSON.stringify({ code: -32000, message: "insufficient funds for transfer" })}`);
        const gas = this.gasOverride.get(provider) ?? this.gas;
        if (call.to.toLowerCase() === deployment.token.toLowerCase()) {
          const mint = decodeMintCall(lock, call.data);
          if (value !== mint.amount * this.price + this.fee) throw new Error(`RPC ${method} failed at ${provider}: ${JSON.stringify({ code: 3, message: "execution reverted: bad payment" })}`);
          if (this.minted + mint.amount > this.cap) throw new Error(`RPC ${method} failed at ${provider}: ${JSON.stringify({ code: 3, message: "execution reverted: cap" })}`);
          return method === "eth_call" ? "0x" : `0x${gas.toString(16)}`;
        }
        if (call.to.toLowerCase() === deployment.processor.toLowerCase()) {
          decodeTapeoutCall(lock, call.data);
          if (value !== this.tapeoutFee) throw new Error(`RPC ${method} failed at ${provider}: ${JSON.stringify({ code: 3, message: "execution reverted: fee" })}`);
          if (this.nand < this.needNand || this.latch < this.needLatch) throw new Error(`RPC ${method} failed at ${provider}: ${JSON.stringify({ code: 3, message: "execution reverted: ERC1155 burn exceeds balance" })}`);
          return method === "eth_call" ? `0x${word(this.nextId)}` : `0x${gas.toString(16)}`;
        }
        throw new Error(`Unexpected call target ${call.to}`);
      }
      default: throw new Error(`Unexpected RPC method ${method}`);
    }
  }
}

interface WalletOptions { chain?: string; accounts?: string[]; sendError?: unknown; hold?: Promise<void>; noHash?: boolean }

class FakeWallet implements Eip1193Provider {
  calls: Array<{ method: string; params?: unknown[] }> = [];
  sent: Array<Record<string, unknown>> = [];
  chain: string;
  accounts: string[];
  sendError?: unknown;
  hold?: Promise<void>;
  noHash: boolean;
  constructor(private readonly chainState: FakeChain, options: WalletOptions = {}) {
    this.chain = options.chain ?? "0xc4";
    this.accounts = options.accounts ?? [ACCOUNT];
    this.sendError = options.sendError;
    this.hold = options.hold;
    this.noHash = options.noHash ?? false;
  }
  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    this.calls.push(args);
    if (args.method === "eth_chainId") return this.chain;
    if (args.method === "eth_accounts") return this.accounts;
    if (args.method === "eth_sendTransaction") {
      if (this.hold !== undefined) await this.hold;
      if (this.sendError !== undefined) throw this.sendError;
      const request = (args.params as Array<{ from: string; to: string; data: string; value: string }>)[0] as { from: string; to: string; data: string; value: string };
      this.sent.push(request);
      if (this.noHash) return undefined;
      const hash = this.chainState.newHash();
      this.chainState.mine(hash, request);
      return hash;
    }
    throw new Error(`Unexpected wallet method ${args.method}`);
  }
}

interface Harness { chain: FakeChain; storage: MemoryStorage; clock: { now: number }; deps: TapeoutDeps; executor: TapeoutExecutor; compiled: CompiledMachine }

async function harness(configure: (chain: FakeChain) => void = () => undefined, overrides: Partial<TapeoutDeps> = {}): Promise<Harness> {
  const chain = new FakeChain();
  configure(chain);
  const storage = new MemoryStorage();
  const clock = { now: 1_000_000 };
  const deps: TapeoutDeps = {
    lock, deployment, clients: chain.clients(), quote: chain.quote, storage,
    readBoundCircuit: async () => { throw new Error("not used"); },
    readLiveStep: async () => { throw new Error("not used"); },
    sleep: async (ms) => { clock.now += ms; },
    now: () => clock.now,
    ...overrides
  };
  return { chain, storage, clock, deps, executor: new TapeoutExecutor(deps), compiled: await compiledPromise };
}

function input(h: Harness, extra: Partial<PlanInput> = {}): PlanInput { return { compiled: h.compiled, account: ACCOUNT, walletChainId: "0xc4", ...extra }; }

async function readyPlan(h: Harness): Promise<TapeoutPlan> {
  const result = await h.executor.plan(input(h));
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  return result as TapeoutPlan;
}

async function refusal(h: Harness, extra: Partial<PlanInput> = {}): Promise<{ reason: string; code: string }> {
  const result = await h.executor.plan(input(h, extra));
  assert.equal(result.ok, false, "expected a refusal");
  return result as { reason: string; code: string };
}

// ------------------------------------------------------------------------------------------------------------ plan maths

test("plan with zero balances needs NAND, LATCH and tapeout with exact values and totals", async () => {
  const h = await harness();
  const plan = await readyPlan(h);
  assert.deepEqual(plan.steps.map((step) => step.kind), ["mint-nand", "mint-latch", "tapeout"]);
  assert.equal(plan.needNand, 98n);
  assert.equal(plan.needLatch, 2n);
  assert.equal(plan.haveNand, 0n);
  assert.equal(plan.haveLatch, 0n);
  const [nand, latch, tapeout] = plan.steps;
  assert.equal(nand?.valueWei, 98n * PRICE + FEE);
  assert.equal(latch?.valueWei, 2n * PRICE + FEE);
  assert.equal(tapeout?.valueWei, TAPEOUT_FEE);
  assert.equal(nand?.transaction.request.value, `0x${(98n * PRICE + FEE).toString(16)}`);
  assert.equal(nand?.transaction.request.to.toLowerCase(), deployment.token.toLowerCase());
  assert.equal(tapeout?.transaction.request.to.toLowerCase(), deployment.processor.toLowerCase());
  assert.equal(plan.totals.valueWei, 98n * PRICE + FEE + 2n * PRICE + FEE + TAPEOUT_FEE);
  assert.equal(nand?.gasEstimate, GAS);
  assert.equal(tapeout?.gasIsUpperBound, true);
  assert.equal(tapeout?.gasEstimate, CEILING);
  assert.equal(plan.totals.estGasWei, (GAS + GAS + CEILING) * GAS_PRICE);
  assert.equal(plan.totals.totalWei, plan.totals.valueWei + plan.totals.estGasWei);
  assert.equal(plan.payloadSha256, (plan.target.payloadSha256));
  assert.equal(plan.account, ACCOUNT);
});

test("plan charges one protocol fee per mint call and skips mints the balance already covers", async () => {
  const covered = await harness((chain) => { chain.nand = 98n; chain.latch = 2n; });
  const onlyTapeout = await readyPlan(covered);
  assert.deepEqual(onlyTapeout.steps.map((step) => step.kind), ["tapeout"]);
  assert.equal(onlyTapeout.totals.valueWei, TAPEOUT_FEE);
  assert.equal(onlyTapeout.steps[0]?.gasIsUpperBound, false);

  const partial = await harness((chain) => { chain.nand = 50n; chain.latch = 2n; });
  const nandOnly = await readyPlan(partial);
  assert.deepEqual(nandOnly.steps.map((step) => step.kind), ["mint-nand", "tapeout"]);
  assert.equal(nandOnly.steps[0]?.amount, 48n);
  assert.equal(nandOnly.steps[0]?.valueWei, 48n * PRICE + FEE);
  assert.equal(nandOnly.haveNand, 50n);

  const latchOnly = await readyPlan(await harness((chain) => { chain.nand = 120n; chain.latch = 0n; }));
  assert.deepEqual(latchOnly.steps.map((step) => step.kind), ["mint-latch", "tapeout"]);
  assert.equal(latchOnly.steps[0]?.amount, 2n);
});

// ------------------------------------------------------------------------------------------------------------ refusals

test("refuses when the two providers disagree", async () => {
  const result = await refusal(await harness((chain) => { chain.disagree = true; }));
  assert.equal(result.code, "providers-disagree");
  assert.match(result.reason, /disagree/);
});

test("refuses when a provider is not on chain 196", async () => {
  const result = await refusal(await harness((chain) => { chain.chainIds.set(providers[1] as string, 1); }));
  assert.equal(result.code, "chain");
});

test("refuses when the wallet is on another chain", async () => {
  const result = await refusal(await harness(), { walletChainId: "0x1" });
  assert.equal(result.code, "wallet-chain");
});

test("refuses without an account", async () => {
  const result = await refusal(await harness(), { account: undefined });
  assert.equal(result.code, "no-account");
  assert.match(result.reason, /Connect an OKX wallet/);
});

test("refuses when the artifact breaks a client safety limit", async () => {
  const limits = readSafetyLimits(lock);
  assert.ok(limits !== undefined);
  const strict = { ...lock, clientSafetyLimits: { ...limits, topLevelRecords: 50 } };
  const h = await harness(undefined, { lock: strict });
  const result = await refusal(h);
  assert.equal(result.code, "limits");
  assert.match(result.reason, /100 gate records; the limit is 50/);
  assert.equal(h.chain.requestLog.length, 0, "no RPC call is made for an over-limit circuit");

  const compiled = await compiledPromise;
  const dims = { nIn: 6, nOut: 1, nState: 2, gateCount: 100 };
  assert.equal(safetyLimitViolation(lock, compiled, 694, dims), undefined);
  assert.match(safetyLimitViolation(lock, compiled, 694, { ...dims, nIn: 9 })?.reason ?? "", /9 inputs; the limit is 8/);
  assert.match(safetyLimitViolation(lock, compiled, 694, { ...dims, nOut: 5 })?.reason ?? "", /5 outputs; the limit is 4/);
  assert.match(safetyLimitViolation(lock, compiled, 694, { ...dims, nState: 4 })?.reason ?? "", /4 state bits; the limit is 3/);
  assert.match(safetyLimitViolation(lock, compiled, 694, { ...dims, gateCount: 513 })?.reason ?? "", /513 gate records/);
  assert.match(safetyLimitViolation(lock, compiled, 3585, dims)?.reason ?? "", /3585 bytes; the limit is 3584/);
  const nineStates = { ...compiled, machine: { ...compiled.machine, states: new Array(9).fill(compiled.machine.states[0]) } } as CompiledMachine;
  assert.match(safetyLimitViolation(lock, nineStates, 694, dims)?.reason ?? "", /9 states; the limit is 8/);
});

test("refuses when the safety limits are missing from the lock", async () => {
  const h = await harness(undefined, { lock: { ...lock, clientSafetyLimits: undefined } });
  assert.equal((await refusal(h)).code, "limits-unavailable");
});

test("refuses an empty payload", async () => {
  const compiled = await compiledPromise;
  assert.equal(safetyLimitViolation(lock, compiled, 0, { nIn: 6, nOut: 1, nState: 2, gateCount: 0 })?.code, "payload");
  assert.equal(safetyLimitViolation(lock, compiled, 10, { nIn: 6, nOut: 1, nState: 2, gateCount: 0 })?.code, "payload");
});

test("refuses when minted plus the deficit would exceed the supply cap", async () => {
  const h = await harness((chain) => { chain.minted = 9_950n; });
  const result = await refusal(h);
  assert.equal(result.code, "supply-cap");
  assert.match(result.reason, /Not enough transistors left under the supply cap/);
  const exact = await harness((chain) => { chain.minted = 9_900n; });
  assert.equal((await exact.executor.plan(input(exact))).ok, true, "exactly filling the cap is allowed");
  const shared = await harness((chain) => { chain.minted = 9_901n; });
  assert.equal((await refusal(shared)).code, "supply-cap", "NAND and LATCH share one cap");
});

test("refuses when the balance cannot cover value, or value plus gas", async () => {
  const valueOnly = 98n * PRICE + FEE + 2n * PRICE + FEE + TAPEOUT_FEE;
  const short = await harness((chain) => { chain.native = valueOnly - 1n; });
  const first = await refusal(short);
  assert.equal(first.code, "balance");
  const noGas = await harness((chain) => { chain.native = valueOnly + 1n; });
  const second = await refusal(noGas);
  assert.equal(second.code, "balance");
  assert.match(second.reason, /including gas/);
  const enough = await harness((chain) => { chain.native = valueOnly + (GAS + GAS + CEILING) * GAS_PRICE; });
  assert.equal((await enough.executor.plan(input(enough))).ok, true);
});

test("refuses when a mint would fail on chain at plan time", async () => {
  const h = await harness((chain) => { chain.revertOn.add(providers[0] as string); });
  const result = await refusal(h);
  assert.equal(result.code, "estimate");
  assert.match(result.reason, /execution reverted: simulated revert/);
});

test("refuses when the quote cannot be read", async () => {
  const h = await harness(undefined, { quote: async () => { throw new Error("RPC eth_call network failure"); } });
  assert.equal((await refusal(h)).code, "quote-unavailable");
});

// ------------------------------------------------------------------------------------------------------------ simulation

test("a revert on either provider blocks sending and never reaches the wallet", async () => {
  for (const reverting of providers) {
    const h = await harness();
    const plan = await readyPlan(h);
    h.chain.revertOn.add(reverting);
    const wallet = new FakeWallet(h.chain);
    const result = await h.executor.sendStep(wallet, plan, plan.steps[0] as never);
    assert.equal(result.status, "refused");
    assert.match((result as { reason: string }).reason, /execution reverted: simulated revert/);
    assert.equal(wallet.sent.length, 0);
    assert.equal(h.executor.pending(ACCOUNT, plan.payloadSha256), undefined);
  }
});

test("a gas estimate above the ceiling blocks sending", async () => {
  const h = await harness();
  const plan = await readyPlan(h);
  h.chain.gasOverride.set(providers[1] as string, CEILING + 1n);
  const wallet = new FakeWallet(h.chain);
  const result = await h.executor.sendStep(wallet, plan, plan.steps[0] as never);
  assert.equal(result.status, "refused");
  assert.equal((result as { code: string }).code, "gas-ceiling");
  assert.equal(wallet.sent.length, 0);
});

test("changed prices or balances since the plan block sending", async () => {
  const h = await harness();
  const plan = await readyPlan(h);
  h.chain.price = PRICE * 2n;
  const wallet = new FakeWallet(h.chain);
  const result = await h.executor.sendStep(wallet, plan, plan.steps[0] as never);
  assert.equal(result.status, "refused");
  assert.equal(wallet.sent.length, 0);

  const second = await harness();
  const plan2 = await readyPlan(second);
  second.chain.nand = 10n;
  const wallet2 = new FakeWallet(second.chain);
  const result2 = await second.executor.sendStep(wallet2, plan2, plan2.steps[0] as never);
  assert.equal((result2 as { code: string }).code, "changed");
  assert.equal(wallet2.sent.length, 0);
});

test("the simulation runs on both providers immediately before every signature", async () => {
  const h = await harness();
  const plan = await readyPlan(h);
  h.chain.requestLog.length = 0;
  const wallet = new FakeWallet(h.chain);
  const phases: string[] = [];
  const result = await h.executor.sendStep(wallet, plan, plan.steps[0] as never, (phase) => phases.push(phase));
  assert.equal(result.status, "submitted");
  assert.deepEqual(phases, ["checking", "confirm"]);
  for (const provider of providers) {
    const methods = h.chain.requestLog.filter((entry) => entry.provider === provider).map((entry) => entry.method);
    assert.equal(methods.filter((method) => method === "eth_call").length, 2, `${provider} eth_call at plan block and latest`);
    assert.equal(methods.filter((method) => method === "eth_estimateGas").length, 2);
  }
  const order = wallet.calls.map((call) => call.method);
  assert.deepEqual(order, ["eth_chainId", "eth_accounts", "eth_sendTransaction"]);
});

// ------------------------------------------------------------------------------------------------------------ sending

test("sendStep sends exactly from, to, data and value to the right address", async () => {
  const h = await harness();
  const plan = await readyPlan(h);
  const wallet = new FakeWallet(h.chain);
  const step = plan.steps[0];
  assert.ok(step !== undefined);
  const result = await h.executor.sendStep(wallet, plan, step);
  assert.equal(result.status, "submitted");
  assert.equal(wallet.sent.length, 1);
  const sent = wallet.sent[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), ["data", "from", "to", "value"]);
  assert.deepEqual(sent, { from: step.transaction.request.from, to: step.transaction.request.to, data: step.transaction.request.data, value: step.transaction.request.value });
  assert.equal((sent.to as string).toLowerCase(), deployment.token.toLowerCase());
  const call = wallet.calls.find((entry) => entry.method === "eth_sendTransaction");
  assert.equal(call?.params?.length, 1);
  assert.deepEqual(decodeMintCall(lock, sent.data as string), { id: 0n, amount: 98n });
});

test("sendStep accepts a checksummed wallet account and refuses a different one", async () => {
  const h = await harness();
  const plan = await readyPlan(h);
  const upper = new FakeWallet(h.chain, { accounts: [`0x${ACCOUNT.slice(2).toUpperCase()}`] });
  assert.equal((await h.executor.sendStep(upper, plan, plan.steps[0] as never)).status, "submitted");

  const other = await harness();
  const plan2 = await readyPlan(other);
  const wallet = new FakeWallet(other.chain, { accounts: ["0x2222222222222222222222222222222222222222"] });
  const result = await other.executor.sendStep(wallet, plan2, plan2.steps[0] as never);
  assert.equal(result.status, "refused");
  assert.equal((result as { code: string }).code, "wallet");
  assert.equal(wallet.sent.length, 0);
  assert.equal(other.executor.pending(ACCOUNT, plan2.payloadSha256), undefined);
  const empty = new FakeWallet(other.chain, { accounts: [] });
  assert.equal((await other.executor.sendStep(empty, plan2, plan2.steps[0] as never)).status, "refused");
});

test("sendStep refuses when the wallet is on another chain", async () => {
  const h = await harness();
  const plan = await readyPlan(h);
  const wallet = new FakeWallet(h.chain, { chain: "0x1" });
  const result = await h.executor.sendStep(wallet, plan, plan.steps[0] as never);
  assert.equal(result.status, "refused");
  assert.equal((result as { code: string }).code, "wallet-chain");
  assert.equal(wallet.sent.length, 0);
  assert.equal(h.executor.pending(ACCOUNT, plan.payloadSha256), undefined);
});

test("a user rejection (4001) is a cancellation and records nothing as pending", async () => {
  const h = await harness();
  const plan = await readyPlan(h);
  const wallet = new FakeWallet(h.chain, { sendError: Object.assign(new Error("User rejected the request."), { code: 4001 }) });
  const result = await h.executor.sendStep(wallet, plan, plan.steps[0] as never);
  assert.deepEqual(result, { status: "cancelled", message: CANCELLED_MESSAGE });
  assert.equal(CANCELLED_MESSAGE, "Cancelled in wallet. Nothing was sent.");
  assert.equal(h.executor.pending(ACCOUNT, plan.payloadSha256), undefined);
  assert.equal(h.storage.values.size, 0);
  // and the same step can be offered and sent again afterwards
  const retry = new FakeWallet(h.chain);
  assert.equal((await h.executor.sendStep(retry, plan, plan.steps[0] as never)).status, "submitted");
});

test("only the first remaining step of the plan can be sent", async () => {
  const h = await harness();
  const plan = await readyPlan(h);
  const wallet = new FakeWallet(h.chain);
  const result = await h.executor.sendStep(wallet, plan, plan.steps[2] as never);
  assert.equal((result as { code: string }).code, "step");
  assert.equal(wallet.sent.length, 0);
});

test("a tampered transaction fails its integrity check before any signature", async () => {
  const h = await harness();
  const plan = await readyPlan(h);
  const step = plan.steps[0];
  assert.ok(step !== undefined && step.kind !== "tapeout");
  const tampered = { ...plan, steps: [{ ...step, transaction: { ...step.transaction, request: Object.freeze({ ...step.transaction.request, value: "0x1" }) } }, ...plan.steps.slice(1)] } as TapeoutPlan;
  const wallet = new FakeWallet(h.chain);
  const result = await h.executor.sendStep(wallet, tampered, tampered.steps[0] as never);
  assert.equal((result as { code: string }).code, "integrity");
  assert.equal(wallet.sent.length, 0);
  const redirected = { ...plan, steps: [{ ...step, transaction: { ...step.transaction, request: Object.freeze({ ...step.transaction.request, to: "0x3333333333333333333333333333333333333333" }) } }, ...plan.steps.slice(1)] } as TapeoutPlan;
  const second = await h.executor.sendStep(wallet, redirected, redirected.steps[0] as never);
  assert.equal(second.status, "refused");
  assert.equal(wallet.sent.length, 0);
});

// ------------------------------------------------------------------------------------------------------------ never twice

test("a step with a recorded pending hash is never sent again, including after a reload", async () => {
  const h = await harness();
  const plan = await readyPlan(h);
  const wallet = new FakeWallet(h.chain);
  const first = await h.executor.sendStep(wallet, plan, plan.steps[0] as never);
  assert.equal(first.status, "submitted");
  const record = h.executor.pending(ACCOUNT, plan.payloadSha256);
  assert.equal(record?.phase, "submitted");
  assert.equal(record?.hash, (first as { hash: string }).hash);

  const again = await h.executor.sendStep(wallet, plan, plan.steps[0] as never);
  assert.equal((again as { code: string }).code, "pending");
  assert.equal(wallet.sent.length, 1);

  // "reload": a brand new executor and a freshly built plan over the same storage
  const reloaded = new TapeoutExecutor({ ...h.deps });
  h.chain.nand = 0n; // the mint is not visible yet, so the fresh plan offers the same mint again
  const freshPlan = await reloaded.plan(input(h));
  assert.equal(freshPlan.ok, true);
  assert.equal(reloaded.pending(ACCOUNT, plan.payloadSha256)?.hash, record?.hash);
  const walletAfterReload = new FakeWallet(h.chain);
  const afterReload = await reloaded.sendStep(walletAfterReload, freshPlan as TapeoutPlan, (freshPlan as TapeoutPlan).steps[0] as never);
  assert.equal((afterReload as { code: string }).code, "pending");
  assert.equal(walletAfterReload.sent.length, 0);
});

test("an interrupted signing marker blocks a second send until the user discards it", async () => {
  const h = await harness();
  const plan = await readyPlan(h);
  const hold = new Promise<void>(() => undefined); // the wallet prompt never resolves, as if the page was closed
  const stuck = new FakeWallet(h.chain, { hold });
  void h.executor.sendStep(stuck, plan, plan.steps[0] as never);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.executor.pending(ACCOUNT, plan.payloadSha256)?.phase, "signing");
  const reloaded = new TapeoutExecutor({ ...h.deps });
  const wallet = new FakeWallet(h.chain);
  const result = await reloaded.sendStep(wallet, plan, plan.steps[0] as never);
  assert.equal((result as { code: string }).code, "pending");
  assert.equal(wallet.sent.length, 0);
  assert.equal(reloaded.discardInterruptedSigning(ACCOUNT, plan.payloadSha256), true);
  assert.equal((await reloaded.sendStep(wallet, plan, plan.steps[0] as never)).status, "submitted");
});

test("two simultaneous clicks produce exactly one signature request", async () => {
  const h = await harness();
  const plan = await readyPlan(h);
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const wallet = new FakeWallet(h.chain, { hold });
  const first = h.executor.sendStep(wallet, plan, plan.steps[0] as never);
  const second = await h.executor.sendStep(wallet, plan, plan.steps[0] as never);
  assert.equal(second.status, "refused");
  release();
  assert.equal((await first).status, "submitted");
  assert.equal(wallet.sent.length, 1);
});

test("without working storage nothing is sent", async () => {
  for (const storage of [undefined, new BrokenStorage()]) {
    const h = await harness(undefined, { storage });
    const plan = await readyPlan(h);
    const wallet = new FakeWallet(h.chain);
    const result = await h.executor.sendStep(wallet, plan, plan.steps[0] as never);
    assert.equal(result.status, "refused");
    assert.equal((result as { code: string }).code, "storage");
    assert.equal(wallet.sent.length, 0);
  }
});

test("a wallet that returns no hash leaves a blocking marker rather than allowing a resend", async () => {
  const h = await harness();
  const plan = await readyPlan(h);
  const wallet = new FakeWallet(h.chain, { noHash: true });
  const result = await h.executor.sendStep(wallet, plan, plan.steps[0] as never);
  assert.equal(result.status, "refused");
  assert.equal(h.executor.pending(ACCOUNT, plan.payloadSha256)?.phase, "signing");
  assert.equal((await h.executor.sendStep(wallet, plan, plan.steps[0] as never)).status, "refused");
  assert.equal(wallet.sent.length, 1);
});

// ------------------------------------------------------------------------------------------------------------ receipts and full run

test("a full run with zero balances confirms NAND, LATCH and tapeout and returns the circuit id", async () => {
  const h = await harness();
  const wallet = new FakeWallet(h.chain);
  let plan = await readyPlan(h);
  const kinds: string[] = [];
  for (let guard = 0; guard < 5 && plan.steps.length > 0; guard += 1) {
    const step = plan.steps[0] as never as TapeoutPlan["steps"][number];
    kinds.push(step.kind);
    const sent = await h.executor.sendStep(wallet, plan, step);
    assert.equal(sent.status, "submitted", sent.status === "refused" ? sent.reason : "");
    const receipt = await h.executor.awaitReceipt((sent as { record: PendingRecord }).record);
    assert.equal(receipt.ok, true, receipt.ok ? "" : receipt.reason);
    if (receipt.ok && receipt.kind === "tapeout") {
      assert.equal(receipt.circuitId, 3n);
      break;
    }
    const next = await h.executor.planAfter(input(h), receipt.ok ? Number(receipt.blockNumber) : 0);
    assert.equal(next.ok, true, next.ok ? "" : next.reason);
    plan = next as TapeoutPlan;
    assert.equal(h.executor.pending(ACCOUNT, plan.payloadSha256), undefined, "confirmed mints leave no pending record");
  }
  assert.deepEqual(kinds, ["mint-nand", "mint-latch", "tapeout"]);
  assert.equal(h.chain.nand, 0n, "tapeout burned the transistors");
  assert.deepEqual(wallet.sent.map((tx) => tx.to), [deployment.token, deployment.token, deployment.processor]);
  const confirmed = h.executor.pending(ACCOUNT, plan.payloadSha256);
  assert.equal(confirmed?.phase, "confirmed");
  assert.equal(confirmed?.circuitId, "3");

  // After a reload the finished circuit is remembered and the same tapeout is not offered again.
  const reloaded = new TapeoutExecutor({ ...h.deps });
  assert.equal(reloaded.pending(ACCOUNT, plan.payloadSha256)?.phase, "confirmed");
  const freshPlan = await reloaded.plan(input(h));
  assert.equal(freshPlan.ok, true);
  const again = await reloaded.sendStep(new FakeWallet(h.chain), freshPlan as TapeoutPlan, (freshPlan as TapeoutPlan).steps[0] as never);
  assert.equal((again as { code: string }).code, "pending");
  reloaded.clearConfirmed(ACCOUNT, plan.payloadSha256);
  assert.equal(reloaded.pending(ACCOUNT, plan.payloadSha256), undefined);
});

async function submittedRecord(h: Harness): Promise<PendingRecord> {
  const plan = await readyPlan(h);
  const sent = await h.executor.sendStep(new FakeWallet(h.chain), plan, plan.steps[0] as never);
  assert.equal(sent.status, "submitted");
  return (sent as { record: PendingRecord }).record;
}

test("a failed receipt on both providers is final, clears the pending record and offers the step again", async () => {
  const h = await harness();
  const record = await submittedRecord(h);
  for (const provider of providers) h.chain.receiptFailed.add(provider);
  const result = await h.executor.awaitReceipt(record);
  assert.equal(result.ok, false);
  assert.equal((result as { final: boolean }).final, true);
  assert.match((result as { reason: string }).reason, /failed on X Layer/);
  assert.equal(h.executor.pending(ACCOUNT, record.payloadSha256), undefined);
});

test("providers that disagree on success keep the record and never report success", async () => {
  const h = await harness();
  const record = await submittedRecord(h);
  h.chain.receiptFailed.add(providers[0] as string);
  const result = await h.executor.awaitReceipt(record);
  assert.equal(result.ok, false);
  assert.equal((result as { timedOut?: boolean }).timedOut, true);
  assert.equal(h.executor.pending(ACCOUNT, record.payloadSha256)?.phase, "submitted");
});

test("a receipt seen by only one provider keeps waiting and times out without clearing", async () => {
  const h = await harness();
  const record = await submittedRecord(h);
  h.chain.receiptHidden.add(providers[1] as string);
  const result = await h.executor.awaitReceipt(record);
  assert.equal(result.ok, false);
  assert.equal((result as { timedOut?: boolean }).timedOut, true);
  assert.match((result as { reason: string }).reason, /may still confirm/);
  assert.equal(h.executor.pending(ACCOUNT, record.payloadSha256)?.phase, "submitted");
  assert.ok(h.clock.now - 1_000_000 >= 180_000, "waited the full three minutes on the injected clock");
});

test("providers that report different blocks are refused", async () => {
  const h = await harness();
  const record = await submittedRecord(h);
  h.chain.receiptBlockHash.set(providers[1] as string, `0x${"ab".repeat(32)}`);
  const result = await h.executor.awaitReceipt(record);
  assert.equal(result.ok, false);
  assert.equal(h.executor.pending(ACCOUNT, record.payloadSha256)?.phase, "submitted");
});

test("one confirmation is not enough; the receipt is accepted once both providers are a block ahead", async () => {
  const h = await harness((chain) => { chain.headLag = 0; });
  const record = await submittedRecord(h);
  let polls = 0;
  const deps: TapeoutDeps = { ...h.deps, sleep: async (ms) => { h.clock.now += ms; polls += 1; if (polls === 2) h.chain.headLag = 1; } };
  const result = await new TapeoutExecutor(deps).awaitReceipt(record);
  assert.equal(result.ok, true);
  assert.ok(polls >= 2);
});

test("a receipt whose data does not match what was sent is rejected", async () => {
  const h = await harness();
  const record = await submittedRecord(h);
  const forged: PendingRecord = { ...record, data: `${record.data.slice(0, -2)}ff` };
  const result = await h.executor.awaitReceipt(forged);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /did not match/);
});

test("a dropped transaction is released only when both providers do not know it and the nonce moved on", async () => {
  const h = await harness();
  const record = await submittedRecord(h);
  h.chain.txs.delete(record.hash as string); // both providers have never seen it
  h.chain.nonce = BigInt(record.nonce as string); // nonce has not moved: it may still be in a mempool
  const early = await h.executor.releaseDroppedPending(ACCOUNT, record.payloadSha256);
  assert.equal(early.released, false);
  assert.equal(h.executor.pending(ACCOUNT, record.payloadSha256)?.phase, "submitted");
  h.chain.nonce = BigInt(record.nonce as string) + 1n;
  const later = await h.executor.releaseDroppedPending(ACCOUNT, record.payloadSha256);
  assert.equal(later.released, true);
  assert.equal(h.executor.pending(ACCOUNT, record.payloadSha256), undefined);
});

test("a known transaction is never released", async () => {
  const h = await harness();
  const record = await submittedRecord(h);
  h.chain.nonce += 5n;
  const result = await h.executor.releaseDroppedPending(ACCOUNT, record.payloadSha256);
  assert.equal(result.released, false);
});

test("planAfter waits for the providers to reach the confirmed block", async () => {
  const h = await harness();
  const target = h.chain.head + 3;
  const result = await h.executor.planAfter(input(h), target, 2);
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "stale-quote");
  let sleeps = 0;
  const deps: TapeoutDeps = { ...h.deps, sleep: async () => { sleeps += 1; h.chain.block += 1; } };
  const caught = await new TapeoutExecutor(deps).planAfter(input(h), target);
  assert.equal(caught.ok, true);
  assert.ok(sleeps >= 1);
});

// ------------------------------------------------------------------------------------------------------------ verification

async function target(): Promise<VerificationTarget> {
  const h = await harness();
  return (await readyPlan(h)).target;
}

function readback(t: VerificationTarget, overrides: Partial<CircuitBindingReadback> = {}): CircuitBindingReadback {
  return { status: "ready", circuitId: "3", owner: t.account.toLowerCase(), processor: deployment.processor, nIn: t.nIn, nOut: t.nOut, nState: t.nState, gateCount: t.gateCount, payloadBytes: t.payloadBytes, payloadSha256: t.payloadSha256, expectedPayloadSha256: t.payloadSha256, ...overrides };
}

function liveFor(t: VerificationTarget, overrides: Partial<LiveStepResult> = {}): LiveStepResult {
  // initial state IDLE (index 0) with all inputs 0 stays IDLE with output 0
  return { block: { number: 4242, hash: "0x1", tag: "0x1092" }, providers, nextState: new Uint8Array([0]), outputs: new Uint8Array([0]), mismatches: [], ...overrides };
}

test("verifyNewCircuit: matching bytes, owner and live transition verify", async () => {
  const t = await target();
  const result = await verifyNewCircuit(3n, t, { readBoundCircuit: async () => readback(t), readLiveStep: async () => liveFor(t) });
  assert.equal(result.verified, true);
  assert.equal(result.outcome, "verified");
  assert.equal(result.live?.match, true);
  assert.equal(result.live?.local.nextStateHex, "0x00");
});

test("verifyNewCircuit: a payload hash mismatch is not verified", async () => {
  const t = await target();
  const result = await verifyNewCircuit(3n, t, { readBoundCircuit: async () => readback(t, { status: "failed", payloadSha256: "ab".repeat(32) }), readLiveStep: async () => liveFor(t) });
  assert.equal(result.verified, false);
  assert.equal(result.outcome, "mismatch");
  assert.match(result.detail, /do not match your compile/);
});

test("verifyNewCircuit: an owner mismatch is not verified", async () => {
  const t = await target();
  const result = await verifyNewCircuit(3n, t, { readBoundCircuit: async () => readback(t, { status: "failed", owner: "0x2222222222222222222222222222222222222222" }), readLiveStep: async () => liveFor(t) });
  assert.equal(result.verified, false);
  assert.match(result.detail, /not owned by your account/);
});

test("verifyNewCircuit: dimension mismatch, live mismatch and provider disagreement are not verified", async () => {
  const t = await target();
  const dims = await verifyNewCircuit(3n, t, { readBoundCircuit: async () => readback(t, { nIn: t.nIn + 1 }), readLiveStep: async () => liveFor(t) });
  assert.equal(dims.verified, false);
  const live = await verifyNewCircuit(3n, t, { readBoundCircuit: async () => readback(t), readLiveStep: async () => liveFor(t, { nextState: new Uint8Array([1]) }) });
  assert.equal(live.verified, false);
  assert.equal(live.outcome, "mismatch");
  const disagree = await verifyNewCircuit(3n, t, { readBoundCircuit: async () => readback(t), readLiveStep: async () => liveFor(t, { mismatches: ["x next state disagreement"] }) });
  assert.equal(disagree.verified, false);
});

test("verifyNewCircuit: an unavailable readback is never reported as verified", async () => {
  const t = await target();
  const thrown = await verifyNewCircuit(3n, t, { readBoundCircuit: async () => { throw new Error("network timeout"); }, readLiveStep: async () => liveFor(t) });
  assert.equal(thrown.verified, false);
  assert.equal(thrown.outcome, "unavailable");
  const liveDown = await verifyNewCircuit(3n, t, { readBoundCircuit: async () => readback(t), readLiveStep: async () => { throw new Error("network timeout"); } });
  assert.equal(liveDown.verified, false);
  assert.equal(liveDown.outcome, "unavailable");
});

// ------------------------------------------------------------------------------------------------------------ network switch

test("switching network uses wallet_switchEthereumChain, and adds X Layer only on error 4902", async () => {
  const calls: Array<{ method: string; params?: unknown[] }> = [];
  const direct: Eip1193Provider = { request: async (args) => { calls.push(args); return null; } };
  assert.deepEqual(await switchToXLayer(direct), { ok: true });
  assert.deepEqual(calls, [{ method: "wallet_switchEthereumChain", params: [{ chainId: "0xc4" }] }]);

  const missing: Array<{ method: string; params?: unknown[] }> = [];
  const unknownChain: Eip1193Provider = { request: async (args) => { missing.push(args); if (args.method === "wallet_switchEthereumChain") throw Object.assign(new Error("Unrecognized chain"), { code: 4902 }); return null; } };
  assert.deepEqual(await switchToXLayer(unknownChain), { ok: true });
  assert.equal(missing[1]?.method, "wallet_addEthereumChain");
  assert.deepEqual(missing[1]?.params, [{ chainId: "0xc4", chainName: "X Layer", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: ["https://rpc.xlayer.tech"], blockExplorerUrls: ["https://www.oklink.com/xlayer"] }]);
  assert.equal(X_LAYER_ADD_CHAIN_PARAMS.nativeCurrency.decimals, 18);

  const other: Array<string> = [];
  const failing: Eip1193Provider = { request: async (args) => { other.push(args.method); throw Object.assign(new Error("boom"), { code: -32603 }); } };
  const failed = await switchToXLayer(failing);
  assert.equal(failed.ok, false);
  assert.deepEqual(other, ["wallet_switchEthereumChain"], "never adds a chain unless the wallet says it is unknown");

  const rejected: Eip1193Provider = { request: async () => { throw Object.assign(new Error("no"), { code: 4001 }); } };
  assert.equal((await switchToXLayer(rejected)).ok, false);
});

test("the planner never targets any address other than the deployment token and processor", async () => {
  const h = await harness();
  const plan = await readyPlan(h);
  const allowed = new Set([deployment.token.toLowerCase(), deployment.processor.toLowerCase()]);
  for (const step of plan.steps) assert.ok(allowed.has(step.transaction.request.to.toLowerCase()));
  for (const step of plan.steps) assert.equal(step.transaction.request.from?.toLowerCase(), ACCOUNT);
});
