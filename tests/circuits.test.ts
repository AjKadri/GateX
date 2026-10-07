import assert from "node:assert/strict";
import test from "node:test";
import { compileMachine } from "../src/compiler/compiler.js";
import { extractTapeOutPayload } from "../src/protocol/wire.js";
import { loadCanonicalDeployment } from "../src/protocol/deployment.js";
import { loadProtocolLock } from "../src/protocol/lock.js";
import { sha256Hex, hexFromBytes } from "../src/protocol/gate-d-abi.js";
import type { ReadOnlyRpcClient, ReadOnlyRpcMethod } from "../src/protocol/rpc.js";
import { EXAMPLES } from "../src/app/model.js";
import { TEMPLATES } from "../src/examples/templates.js";
import { MAX_IN_FLIGHT, checkAgainstCircuit, checkHeadline, countGates, distinctOwners, matchKnownRule, readCircuit, readCircuitCount, readCircuitsPage, type CircuitsDeps, type Dimensions, type KnownRule } from "../src/app/circuits.js";
import { MAX_SHARED_SOURCE_CHARS, decodeSource, encodeSource, parseCircuitParam, verificationLink } from "../src/app/share.js";
import { MAX_SAVED_SOURCE_CHARS, MY_CIRCUITS_KEY, readMyCircuits, rememberMyCircuit } from "../src/app/my-circuits.js";
import { route, routeQuery } from "../src/app/ui-state.js";

const lock = loadProtocolLock();
const deployment = loadCanonicalDeployment();
const providers = lock.snapshot.providers;
const OWNER_A = "0x1111111111111111111111111111111111111111";
const OWNER_B = "0x2222222222222222222222222222222222222222";
const signatures = new Map((lock.gateD?.functions ?? []).map((entry) => [entry.selector.toLowerCase(), entry.signature]));

function word(value: bigint | number): string { return BigInt(value).toString(16).padStart(64, "0"); }
function sha(payload: Uint8Array): string { return sha256Hex(hexFromBytes(payload)).replace(/^0x/, "").toLowerCase(); }

interface FakeCircuit { owner: string; dims: Dimensions; payload: Uint8Array }

async function compiledCircuit(source: string, owner: string): Promise<FakeCircuit> {
  const compiled = await compileMachine(source);
  const extracted = await extractTapeOutPayload(lock, compiled.bytes);
  return { owner, dims: extracted.dimensions, payload: extracted.payload };
}

/** A tiny processor: nextId, ownerOf, circuitInfo, netlist. Each provider can be made to differ or fail per circuit id. */
class FakeProcessor {
  circuits = new Map<bigint, FakeCircuit>();
  nextId = 1n;
  override = new Map<string, (id: bigint, signature: string) => string | Error | undefined>();
  inFlight = 0;
  maxInFlight = 0;
  infoCalls = 0;
  constructor(private readonly delay = false) {}

  clients(): ReadonlyMap<string, ReadOnlyRpcClient> {
    return new Map(providers.map((provider) => [provider, { request: (method: ReadOnlyRpcMethod, params: readonly unknown[]) => this.handle(provider, method, params) } as ReadOnlyRpcClient]));
  }

  private async handle(provider: string, method: ReadOnlyRpcMethod, params: readonly unknown[]): Promise<unknown> {
    if (method !== "eth_call") throw new Error(`unexpected ${method}`);
    const call = params[0] as { to: string; data: string };
    assert.equal(call.to.toLowerCase(), deployment.processor.toLowerCase());
    assert.equal(typeof params[1], "string");
    const signature = signatures.get(call.data.slice(0, 10).toLowerCase());
    assert.ok(signature !== undefined, `known selector ${call.data.slice(0, 10)}`);
    const id = call.data.length >= 74 ? BigInt(`0x${call.data.slice(10, 74)}`) : 0n;
    const tracked = signature === "circuitInfo(uint256)";
    if (tracked) { this.infoCalls += 1; this.inFlight += 1; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight); }
    try {
      if (this.delay) await new Promise((resolve) => setTimeout(resolve, 2));
      const hook = this.override.get(provider)?.(id, signature);
      if (hook instanceof Error) throw hook;
      if (hook !== undefined) return hook;
      if (signature === "nextId()") return `0x${word(this.nextId)}`;
      const circuit = this.circuits.get(id);
      if (circuit === undefined) throw new Error(`RPC eth_call failed at ${provider}: {"code":3,"message":"execution reverted"}`);
      if (signature === "ownerOf(uint256)") return `0x${word(BigInt(circuit.owner))}`;
      if (signature === "circuitInfo(uint256)") return `0x${word(circuit.dims.nIn)}${word(circuit.dims.nOut)}${word(circuit.dims.nState)}${word(circuit.dims.gateCount)}`;
      if (signature === "netlist(uint256)") return `0x${word(32)}${word(circuit.payload.length)}${hexFromBytes(circuit.payload).slice(2).padEnd(Math.ceil(circuit.payload.length / 32) * 64, "0")}`;
      throw new Error(`unexpected call ${signature}`);
    } finally {
      if (tracked) this.inFlight -= 1;
    }
  }

  deps(): CircuitsDeps { return { lock, processor: deployment.processor, clients: this.clients(), blockTag: "0x10" }; }
}

async function chainOfThree(): Promise<{ fake: FakeProcessor; agent: FakeCircuit; tiny: FakeCircuit; template: FakeCircuit }> {
  const fake = new FakeProcessor();
  const tiny = await compiledCircuit(EXAMPLES.tiny.source, OWNER_A);
  const agent = await compiledCircuit(EXAMPLES.agent.source, OWNER_A);
  const template = await compiledCircuit(TEMPLATES[3]?.source ?? "", OWNER_B);
  fake.circuits.set(1n, tiny); fake.circuits.set(2n, agent); fake.circuits.set(3n, template);
  fake.nextId = 4n;
  return { fake, agent, tiny, template };
}

test("circuits are listed newest first, read from both providers, with gate counts from the netlist", async () => {
  const { fake, agent } = await chainOfThree();
  const count = await readCircuitCount(fake.deps());
  assert.deepEqual(count, { nextId: 4n, top: 3n });
  const page = await readCircuitsPage(fake.deps(), count.top);
  assert.deepEqual(page.rows.map((row) => row.id), ["3", "2", "1"]);
  assert.equal(page.nextCursor, 0n);
  assert.ok(page.rows.every((row) => row.confirmed && row.note === undefined));
  const second = page.rows[1];
  assert.equal(second?.owner, OWNER_A);
  assert.equal(second?.nand, 98);
  assert.equal(second?.latch, 2);
  assert.equal(second?.payloadSha256, EXAMPLES.agent.expected.payloadSha);
  assert.deepEqual(second?.dimensions, agent.dims);
  assert.equal(distinctOwners(page.rows), 2);
});

test("the list works whether nextId is the next id to issue or the last id issued", async () => {
  const { fake } = await chainOfThree();
  fake.nextId = 3n;
  assert.equal((await readCircuitCount(fake.deps())).top, 3n);
  fake.nextId = 4n;
  assert.equal((await readCircuitCount(fake.deps())).top, 3n);
  fake.circuits.clear(); fake.nextId = 1n;
  assert.equal((await readCircuitCount(fake.deps())).top, 0n);
  fake.nextId = 0n;
  assert.deepEqual(await readCircuitCount(fake.deps()), { nextId: 0n, top: 0n });
});

test("at most four circuits are read at once, 30 per page, and Load more continues below the last id read", async () => {
  const fake = new FakeProcessor(true);
  const circuit = await compiledCircuit(EXAMPLES.tiny.source, OWNER_A);
  for (let id = 1n; id <= 35n; id += 1n) fake.circuits.set(id, circuit);
  fake.nextId = 36n;
  const deps = fake.deps();
  const { top } = await readCircuitCount(deps);
  assert.equal(top, 35n);
  const first = await readCircuitsPage(deps, top);
  assert.equal(first.rows.length, 30);
  assert.equal(first.rows[0]?.id, "35");
  assert.equal(first.rows[29]?.id, "6");
  assert.equal(first.nextCursor, 5n);
  // Each circuit makes one circuitInfo call per provider, so four circuits in flight means at most 4 per provider at the same moment.
  assert.ok(fake.maxInFlight <= MAX_IN_FLIGHT * providers.length, `max in flight ${fake.maxInFlight}`);
  const second = await readCircuitsPage(deps, first.nextCursor);
  assert.deepEqual(second.rows.map((row) => row.id), ["5", "4", "3", "2", "1"]);
  assert.equal(second.nextCursor, 0n);
});

test("a circuit the providers disagree on is shown as unconfirmed, not dropped", async () => {
  const { fake } = await chainOfThree();
  const other = (await compiledCircuit(EXAMPLES.tiny.source, OWNER_A)).payload;
  const second = providers[1] as string;
  const tampered = `0x${word(32)}${word(other.length)}${hexFromBytes(other).slice(2).padEnd(Math.ceil(other.length / 32) * 64, "0")}`;
  fake.override.set(second, (id, signature) => (id === 2n && signature === "netlist(uint256)" ? tampered : undefined));
  const page = await readCircuitsPage(fake.deps(), 3n);
  assert.deepEqual(page.rows.map((row) => [row.id, row.confirmed]), [["3", true], ["2", false], ["1", true]]);
  assert.match(page.rows[1]?.note ?? "", /different data/);
});

test("one provider failing makes the circuit unconfirmed; both failing leaves an unreadable row; a circuit that does not exist is skipped", async () => {
  const { fake } = await chainOfThree();
  const [first, second] = providers as [string, string];
  fake.override.set(second, (id) => (id === 1n ? new Error("RPC eth_call network failure") : undefined));
  let row = await readCircuit(fake.deps(), 1n);
  assert.equal(row?.confirmed, false);
  assert.match(row?.note ?? "", /Only one provider answered/);
  assert.equal(row?.owner, OWNER_A);

  fake.override.set(first, (id) => (id === 1n ? new Error("RPC eth_call network failure") : undefined));
  row = await readCircuit(fake.deps(), 1n);
  assert.equal(row?.confirmed, false);
  assert.equal(row?.unreadable, true);
  assert.equal(row?.id, "1");

  assert.equal(await readCircuit(fake.deps(), 99n), undefined);
  fake.override.clear();
  fake.override.set(first, () => `0x${word(0)}`);
  fake.nextId = 4n;
  await assert.rejects(() => readCircuitCount(fake.deps()), /disagree/);
});

test("a total outage rejects so the page can show a failure with Retry instead of a partial list", async () => {
  const { fake } = await chainOfThree();
  for (const provider of providers) fake.override.set(provider, () => new Error("RPC eth_call network failure"));
  await assert.rejects(() => readCircuitCount(fake.deps()), /network failure/);
});

test("countGates derives NAND and LATCH counts and refuses anything that is not a clean record stream", async () => {
  const circuit = await compiledCircuit(EXAMPLES.agent.source, OWNER_A);
  assert.deepEqual(countGates(circuit.payload), { nand: 98, latch: 2 });
  assert.equal(countGates(circuit.payload.slice(0, circuit.payload.length - 1)), undefined);
  assert.equal(countGates(new Uint8Array([9])), undefined);
  assert.deepEqual(countGates(new Uint8Array()), { nand: 0, latch: 0 });
});

async function known(source: string): Promise<KnownRule> {
  const circuit = await compiledCircuit(source, OWNER_A);
  const compiled = await compileMachine(source);
  return { name: compiled.machine.name, source, payloadSha256: sha(circuit.payload), dimensions: circuit.dims };
}

test("match labelling names the known rule whose compile is byte-identical, and never for unconfirmed circuits", async () => {
  const { fake } = await chainOfThree();
  const rules = [await known(EXAMPLES.agent.source), await known(EXAMPLES.tiny.source), ...(await Promise.all(TEMPLATES.map((template) => known(template.source))))];
  const page = await readCircuitsPage(fake.deps(), 3n);
  assert.deepEqual(page.rows.map((row) => matchKnownRule(row, rules)?.name), ["TimeboxedPermit", "AgentApproval", "TinyApproval"]);
  assert.equal(matchKnownRule(page.rows[1] as (typeof page.rows)[number], []), undefined);
  assert.equal(matchKnownRule({ ...(page.rows[1] as (typeof page.rows)[number]), confirmed: false, note: "x" }, rules), undefined);
  const strangerDims = { ...(page.rows[1] as (typeof page.rows)[number]), dimensions: { nIn: 1, nOut: 1, nState: 1, gateCount: 1 } };
  assert.equal(matchKnownRule(strangerDims, rules), undefined, "same bytes with a different declared size is not a match");
  const unknown = { ...(page.rows[1] as (typeof page.rows)[number]), payloadSha256: "00".repeat(32) };
  assert.equal(matchKnownRule(unknown, rules), undefined);
});

test("checkAgainstCircuit compares payload hashes and declared dimensions only", () => {
  const dims: Dimensions = { nIn: 6, nOut: 1, nState: 2, gateCount: 100 };
  const hash = EXAMPLES.agent.expected.payloadSha;
  const same = checkAgainstCircuit(hash, `0x${hash.toUpperCase()}`, { compiled: dims, onChain: { ...dims } });
  assert.deepEqual(same, { matches: true, tone: "green", hashesEqual: true, dimensionsEqual: true });
  assert.equal(checkHeadline(same, "3"), "This rule matches circuit #3 on X Layer (bytes identical)");
  const different = checkAgainstCircuit(hash, "ab".repeat(32), { compiled: dims, onChain: dims });
  assert.equal(different.matches, false);
  assert.equal(different.tone, "neutral");
  assert.equal(checkHeadline(different, "3"), "This rule does not match circuit #3");
  const sizeOnly = checkAgainstCircuit(hash, hash, { compiled: dims, onChain: { ...dims, nOut: 2 } });
  assert.equal(sizeOnly.matches, false);
  assert.equal(sizeOnly.hashesEqual, true);
  assert.match(checkHeadline(sizeOnly, "3"), /does not match/);
  assert.equal(checkAgainstCircuit("", "", { compiled: dims, onChain: dims }).matches, false, "an empty hash never matches");
});

test("shared sources survive a round trip, including non-ASCII text, in the URL-safe alphabet", () => {
  for (const source of ["machine A { }", "// grüße — 日本語 🚀\nmachine B {\n  states X;\n}\n", "<script>alert(1)</script> & \"quotes\" 'x'", "a".repeat(MAX_SHARED_SOURCE_CHARS)]) {
    const encoded = encodeSource(source);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeSource(encoded), { ok: true, source });
  }
  assert.equal(encodeSource("???>>>"), "Pz8_Pj4-");
});

test("oversized, malformed and empty shared sources are refused", () => {
  assert.deepEqual(decodeSource(encodeSource("a".repeat(MAX_SHARED_SOURCE_CHARS + 1))), { ok: false, reason: "too long" });
  assert.deepEqual(decodeSource("A".repeat(100_000)), { ok: false, reason: "too long" });
  assert.equal(decodeSource("not base64!").ok, false);
  assert.equal(decodeSource("").ok, false);
  assert.equal(decodeSource("////").ok, false, "+ and / are not URL-safe");
  assert.equal(decodeSource("_w").ok, false, "invalid UTF-8 is refused, not repaired");
  assert.equal(decodeSource("A").ok, false, "a truncated group is refused");
  assert.deepEqual(decodeSource(encodeSource("   \n  ")), { ok: false, reason: "empty" });
});

test("verification links carry the circuit id and the source, and only a plain id is accepted from a link", () => {
  const source = "machine Z { }";
  const link = verificationLink("https://example.test/app/", "3", source);
  assert.equal(link, `https://example.test/app/#/workspace?circuit=3&src=${encodeSource(source)}`);
  assert.equal(verificationLink("https://example.test/", "7"), "https://example.test/#/workspace?circuit=7");
  const query = routeQuery(link.slice(link.indexOf("#")));
  assert.equal(parseCircuitParam(query.get("circuit")), "3");
  assert.deepEqual(decodeSource(query.get("src") ?? ""), { ok: true, source });
  for (const bad of ["0", "-1", "1.5", "3<script>", "03", "12345678901", "", null]) assert.equal(parseCircuitParam(bad), undefined, String(bad));
  assert.equal(route(link.slice(link.indexOf("#"))), "/workspace");
  assert.equal(route("#/circuits"), "/circuits");
  assert.equal(route("#/circuits?x=1"), "/circuits");
  assert.equal(route("#/workspaces?circuit=1"), "/");
});

class MemoryStorage { values = new Map<string, string>(); getItem(key: string): string | null { return this.values.get(key) ?? null; } setItem(key: string, value: string): void { this.values.set(key, value); } }

test("remembered circuits keep their source, old entries without one still load, and oversized sources are not stored", () => {
  const storage = new MemoryStorage();
  const entry = { id: "3", name: "A", payloadSha256: "ab", owner: OWNER_A, tx: `0x${"1".repeat(64)}`, date: "2026-10-07T00:00:00.000Z" };
  storage.setItem(MY_CIRCUITS_KEY, JSON.stringify([{ ...entry, tx: `0x${"2".repeat(64)}` }]));
  rememberMyCircuit({ ...entry, source: "machine A { }" }, storage);
  rememberMyCircuit({ ...entry, tx: `0x${"3".repeat(64)}`, source: "x".repeat(MAX_SAVED_SOURCE_CHARS + 1) }, storage);
  const list = readMyCircuits(storage);
  assert.equal(list.length, 3);
  assert.equal(list.find((item) => item.tx.endsWith("2".repeat(64)))?.source, undefined);
  assert.equal(list.find((item) => item.tx.endsWith("1".repeat(64)))?.source, "machine A { }");
  assert.equal(list.find((item) => item.tx.endsWith("3".repeat(64)))?.source, undefined);
  storage.setItem(MY_CIRCUITS_KEY, JSON.stringify([{ ...entry, source: 42 }]));
  assert.deepEqual(readMyCircuits(storage), []);
});
