import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileMachine } from "../src/compiler/compiler.js";
import { encodeInputMask, encodeStateIndex } from "../src/compiler/encoding.js";
import { TINY_APPROVAL_SOURCE } from "../src/examples/tinyApproval.js";
import {
  compareCandidateSimulation,
  decodeBytesReturn,
  decodeCircuitInfo,
  decodeStep,
  encodeCall,
  extractTapeOutPayload,
  GateCBlockedError,
  GateCIdentityError,
  identityTargets,
  loadProtocolLock,
  localCandidateEvaluator,
  missingGateCProtocolFacts,
  parseFixtureDocument,
  reconstructPostState,
  runtimeKeccak256,
  stateOverridesEqual,
  verifyLockedProvider,
  verifyLockedProviders
} from "../src/protocol/index.js";
import type { ProtocolLock } from "../src/protocol/types.js";
import type { ReadOnlyRpcClient } from "../src/protocol/rpc.js";

const fixtureDocument = parseFixtureDocument(JSON.parse(readFileSync("tests/fixtures/gate-c.json", "utf8")) as unknown);
const EMPTY_RUNTIME_HASH = runtimeKeccak256("0x");

function syntheticLock(): ProtocolLock {
  const canonical = loadProtocolLock();
  const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}`;
  return {
    project: "GateX test lock",
    status: "TEST",
    updatedLocalDate: "2026-10-05",
    timezone: "Africa/Lagos",
    chainId: 196,
    snapshot: { blockNumber: 10, blockHash: `0x${"ab".repeat(32)}`, timestampUTC: "2026-10-05T00:00:00Z", providers: ["provider-a", "provider-b"] },
    factory: { proxy: address(1), implementation: address(2), implementationRuntimeKeccak256: EMPTY_RUNTIME_HASH, proxyRuntimeKeccak256: EMPTY_RUNTIME_HASH },
    circuit: { beacon: address(3), implementation: address(4), implementationRuntimeKeccak256: EMPTY_RUNTIME_HASH },
    transistor: { beacon: address(5), implementation: address(6), implementationRuntimeKeccak256: EMPTY_RUNTIME_HASH },
    sample: { processor: address(7), transistors: address(8), processorRuntimeKeccak256: EMPTY_RUNTIME_HASH, transistorProxyRuntimeKeccak256: EMPTY_RUNTIME_HASH },
    dependencyRuntimeRecords: [],
    semantics: { nandOpcode: 0, latchOpcode: 1, indexEncoding: "big-endian u24", vectorPacking: "LSB-first within byte", outputs: "last nOut produced signals", stepState: "caller-supplied" },
    fundsWritingAuthorized: false,
    warning: "test lock",
    gateC: canonical.gateC
  };
}

function fakeClient(lock: ProtocolLock, overrides: Partial<{ chainId: number; blockHash: string; code: string }>): ReadOnlyRpcClient {
  return {
    async request(method, params) {
      if (method === "eth_chainId") return `0x${(overrides.chainId ?? lock.chainId).toString(16)}`;
      if (method === "eth_getBlockByNumber") return { number: `0x${lock.snapshot.blockNumber.toString(16)}`, hash: overrides.blockHash ?? lock.snapshot.blockHash };
      if (method === "eth_getCode") return overrides.code ?? "0x";
      throw new Error(`Unexpected read-only method ${method} with ${JSON.stringify(params)}`);
    }
  };
}

test("Gate C loads the canonical lock, promoted ABI and provider identities", () => {
  const lock = loadProtocolLock();
  assert.equal(lock.chainId, 196);
  assert.deepEqual(lock.snapshot.providers, ["https://rpc.xlayer.tech", "https://xlayer.drpc.org"]);
  assert.equal(lock.fundsWritingAuthorized, false);
  assert.equal(lock.warning.includes("source-verified"), true);
  assert.deepEqual(missingGateCProtocolFacts(lock), []);
  assert.equal(lock.gateC.functions.find((item) => item.signature === "step(uint256,bytes,bytes)")?.selector, "0xe8281a1a");
  assert.equal(identityTargets(lock).length >= 8, true);
  assert.equal("fixtures" in (lock as unknown as Record<string, unknown>), false);
});

test("Gate C fixture data stays outside the protocol lock", () => {
  assert.equal(fixtureDocument.kind, "TEST_DATA_NOT_PROTOCOL_CONSTANTS");
  assert.equal(fixtureDocument.historicalEvidenceOnly, true);
  assert.equal(fixtureDocument.liveFixtures.length, 3);
  assert.equal(fixtureDocument.transientFixtures.length, 3);
  assert.equal(fixtureDocument.transientFixtures.find((item) => item.name === "ref-state")?.vectors.length, 32);
});

test("Gate C ABI encoding and return decoding reproduce every locked live fixture vector", () => {
  const lock = loadProtocolLock();
  for (const fixture of fixtureDocument.liveFixtures) {
    const info = fixture.metadataSnapshot?.result;
    if (info !== undefined) {
      const decodedInfo = decodeCircuitInfo(info);
      assert.equal(decodedInfo.nIn, fixture.dimensions.nIn);
      assert.equal(decodedInfo.nOut, fixture.dimensions.nOut);
      assert.equal(decodedInfo.nState, fixture.dimensions.nState);
    }
    for (const vector of fixture.vectors) {
      const data = fixture.method === "eval"
        ? encodeCall(lock, "eval(uint256,bytes)", [fixture.circuitId, hexBytes(vector.inputs)])
        : encodeCall(lock, "step(uint256,bytes,bytes)", [fixture.circuitId, hexBytes(vector.state), hexBytes(vector.inputs)]);
      assert.equal(data.toLowerCase(), vector.calldata.toLowerCase(), `${fixture.name} calldata`);
      if (fixture.method === "eval") assert.equal(hexBytesToString(decodeBytesReturn(vector.rawReturn)), vector.expectedOutputs);
      else {
        const decoded = decodeStep(vector.rawReturn);
        assert.equal(hexBytesToString(decoded.nextState), vector.expectedNextState);
        assert.equal(hexBytesToString(decoded.outputs), vector.expectedOutputs);
      }
    }
  }
  const transient = fixtureDocument.transientFixtures[0];
  assert.ok(transient);
  const request = transient.manufactureTraceRequest.params[0] as { data: string };
  assert.equal(encodeCall(lock, "tapeout(bytes,uint32,uint32)", [hexBytes(transient.netlist), transient.dimensions.nIn, transient.dimensions.nOut]).toLowerCase(), request.data.toLowerCase());
});

test("Gate C preserves the local container/header and extracts the exact TapeOut payload", async () => {
  const lock = loadProtocolLock();
  const compiled = await compileMachine(TINY_APPROVAL_SOURCE);
  const payload = await extractTapeOutPayload(lock, compiled.bytes);
  assert.equal(payload.localContainer.length, 643);
  assert.equal(payload.headerBytes, 12);
  assert.equal(payload.payload.length, 631);
  assert.equal(payload.localHash, "adee32d4133073926d312a711643d16ac7d849c7e662c2bce8f6131c35fd0334");
  assert.equal(payload.payloadHash, "7ec1ed9fe2e0c5f92a45b2ad49fe3da969c109f01522d8306fe127aba76cabac");
  assert.deepEqual(payload.dimensions, { nIn: 3, nOut: 1, nState: 2, gateCount: 91 });
  assert.notDeepEqual([...payload.payload], [...compiled.bytes.slice(0, 631)]);
  assert.equal(payload.payload[0], 1);
});

test("Gate C reconstructs every recovered post-state using only balance/code/storage", () => {
  for (const fixture of fixtureDocument.transientFixtures) {
    const traceOptions = fixture.manufactureTraceRequest.params[2] as { stateOverrides: unknown };
    const result = reconstructPostState(traceOptions.stateOverrides, { post: fixture.tracePostState });
    assert.equal(stateOverridesEqual(result, fixture.reconstructedOverrides), true, fixture.name);
  }
  assert.throws(() => reconstructPostState({ account: { balance: "0x1" } }, { post: { account: { storage: { bad: "not-hex" } } } }), /hex/);
});

test("Gate C verifies chain, pinned block, and implementation identity", async () => {
  const lock = syntheticLock();
  const report = await verifyLockedProvider(lock, "provider-a", fakeClient(lock, {}));
  assert.equal(report.chainId, lock.chainId);
  assert.equal(report.blockNumber, lock.snapshot.blockNumber);
  assert.equal(report.blockHash, lock.snapshot.blockHash);
  assert.equal(report.identities.length, identityTargets(lock).length);
  assert.equal(report.identities.every((identity) => identity.observedRuntimeKeccak256 === EMPTY_RUNTIME_HASH), true);
});

test("Gate C rejects stale blocks, chain changes, implementation changes, and provider disagreement", async () => {
  const lock = syntheticLock();
  await assert.rejects(verifyLockedProvider(lock, "provider-a", fakeClient(lock, { blockHash: `0x${"cd".repeat(32)}` })), (error: unknown) => error instanceof GateCIdentityError && error.code === "BLOCK_MISMATCH");
  await assert.rejects(verifyLockedProvider(lock, "provider-a", fakeClient(lock, { code: "0x00" })), (error: unknown) => error instanceof GateCIdentityError && error.code === "RUNTIME_HASH_MISMATCH");
  await assert.rejects(verifyLockedProvider(lock, "provider-a", fakeClient(lock, { chainId: 1 })), (error: unknown) => error instanceof GateCIdentityError && error.code === "CHAIN_ID_MISMATCH");
  const clients = new Map<string, ReadOnlyRpcClient>([["provider-a", fakeClient(lock, {})], ["provider-b", fakeClient(lock, { blockHash: `0x${"cd".repeat(32)}` })]]);
  await assert.rejects(verifyLockedProviders(lock, clients), GateCIdentityError);
});

test("Gate C candidate comparison remains SIMULATION and checks all 32 cases independently", async () => {
  const compiled = await compileMachine(TINY_APPROVAL_SOURCE);
  const result = await compareCandidateSimulation(compiled, localCandidateEvaluator(compiled));
  assert.equal(result.label, "SIMULATION");
  assert.equal(result.transactionSent, false);
  assert.equal(result.walletSignatureRequested, false);
  assert.equal(result.casesCompared, 32);
  assert.deepEqual(result.mismatches, []);
});

test("Gate C locks vector packing and rejects malformed overrides", () => {
  assert.deepEqual([...encodeInputMask(1, 3)], [0b00000001]);
  assert.deepEqual([...encodeStateIndex(2, 2)], [0b00000010]);
  const lock = loadProtocolLock();
  const missing = missingGateCProtocolFacts({ ...lock, gateC: { ...lock.gateC, functions: [] } });
  assert.equal(missing.length > 0, true);
  assert.throws(() => { throw new GateCBlockedError(missing); }, GateCBlockedError);
  assert.throws(() => reconstructPostState({}, { post: { account: { storage: { bad: "not-hex" } } } }), /hex/);
});

test("Gate C exposes no wallet, signature, or broadcast path", () => {
  const lock = syntheticLock();
  const client = fakeClient(lock, {});
  assert.deepEqual(Object.keys(client), ["request"]);
  assert.equal("eth_sendRawTransaction" in client, false);
  assert.equal("wallet" in client, false);
  assert.equal(lock.gateC.candidateSimulation.label, "SIMULATION");
});

function hexBytes(value: string): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error(`invalid test hex ${value}`);
  const result = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  return result;
}

function hexBytesToString(value: Uint8Array): string {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
