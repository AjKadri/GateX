import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CREATE_CPU_SIGNATURE,
  GATEX_CREATION,
  GATEX_DEPLOYMENT_ACCOUNT,
  GateDBlockedError,
  MINT_SIGNATURE,
  TAPEOUT_SIGNATURE,
  TINY_APPROVAL_PAYLOAD,
  assertCanonicalDeploymentSelected,
  authorizeCanonicalCreateCpuTransaction,
  authorizeCanonicalMintTransaction,
  authorizeCanonicalTapeoutTransaction,
  buildCanonicalCreateCpuTransaction,
  buildCanonicalMintTransaction,
  buildCanonicalTapeoutTransaction,
  decodeCreateCpuCall,
  creationCall,
  creationLogFilter,
  decodeCreateReturn,
  encodeGateDCall,
  expectedMintValue,
  loadProtocolLock,
  loadCanonicalDeployment,
  mintCall,
  padTopicAddress,
  requireGateDProtocolFacts,
  sha256Hex,
  tapeoutLogFilter,
  transactionPlanDigest
} from "../src/protocol/index.js";
import type { CanonicalCreateCpuTransaction } from "../src/protocol/index.js";

function word(data: string, index: number): bigint {
  return BigInt(`0x${data.slice(10 + index * 64, 10 + (index + 1) * 64)}`);
}

test("Gate D promotes the recovered ABI and unresolved-bound warnings", () => {
  const lock = loadProtocolLock();
  requireGateDProtocolFacts(lock);
  assert.equal(lock.gateD?.functions.length, 29);
  assert.equal(lock.gateD?.events.length, 5);
  assert.equal(lock.gateD?.constraints.universalMinPrice, null);
  assert.equal(lock.gateD?.constraints.universalMaxPrice, null);
  assert.equal(lock.gateD?.warnings.some((warning) => warning.includes("source/build")), true);
  assert.throws(() => requireGateDProtocolFacts({ ...lock, gateD: undefined }), GateDBlockedError);
});

test("createCPU encoding preserves dynamic UTF-8 strings and argument order", () => {
  const lock = loadProtocolLock();
  const data = encodeGateDCall(lock, "createCPU(string,string,string,uint256,uint256)", [GATEX_CREATION.name, GATEX_CREATION.symbol, "TinyApproval", GATEX_CREATION.cap, GATEX_CREATION.priceWei]);
  assert.equal(data.slice(0, 10), "0x47f9b5fd");
  assert.equal(word(data, 0), 160n);
  assert.equal(word(data, 1), 224n);
  assert.equal(word(data, 2), 288n);
  assert.equal(word(data, 3), GATEX_CREATION.cap);
  assert.equal(word(data, 4), GATEX_CREATION.priceWei);
  assert.equal(sha256Hex(data).length, 66);
});

test("Gate D transaction helpers use integer wei and locked targets", () => {
  const lock = loadProtocolLock();
  const mint = mintCall(lock, GATEX_DEPLOYMENT_ACCOUNT, "0x1111111111111111111111111111111111111111", 0n, 89n, GATEX_CREATION.priceWei, 660_000_000_000_000n);
  assert.equal(mint.value, "0x2a93626efd000");
  assert.equal(expectedMintValue(89n, GATEX_CREATION.priceWei, 660_000_000_000_000n), 749_000_000_000_000n);
  const creation = creationCall(lock, GATEX_DEPLOYMENT_ACCOUNT, "TinyApproval", 6_600_000_000_000_000n);
  assert.equal(creation.to, lock.factory.proxy);
  assert.equal(transactionPlanDigest(creation).valueWei, 6_600_000_000_000_000n);
});

test("Gate D duplicate filters bind the authorized creator and processor", () => {
  const lock = loadProtocolLock();
  const creation = creationLogFilter(lock, GATEX_DEPLOYMENT_ACCOUNT, "0x45156a9");
  assert.deepEqual(creation.topics, [lock.gateD?.events[0]?.topic0, null, null, padTopicAddress(GATEX_DEPLOYMENT_ACCOUNT)]);
  const tapeout = tapeoutLogFilter(lock, "0x1111111111111111111111111111111111111111", GATEX_DEPLOYMENT_ACCOUNT, "0x1", "0x2");
  assert.deepEqual(tapeout.topics, [lock.gateD?.events[3]?.topic0, null, padTopicAddress(GATEX_DEPLOYMENT_ACCOUNT)]);
});

test("Gate D retains the exact TinyApproval artifact boundary", () => {
  assert.deepEqual(TINY_APPROVAL_PAYLOAD, { bytes: 631, nand: 89, latch: 2, records: 91, nIn: 3, nOut: 1, nState: 2, sha256: "7ec1ed9fe2e0c5f92a45b2ad49fe3da969c109f01522d8306fe127aba76cabac" });
  assert.equal("eth_sendTransaction" in { request: () => undefined }, false);
});

test("createCPU return decoding treats simulation addresses as non-receipt data", () => {
  const decoded = decodeCreateReturn(`0x${"00".repeat(12)}1111111111111111111111111111111111111111${"00".repeat(12)}2222222222222222222222222222222222222222`);
  assert.deepEqual(decoded, { token: "0x1111111111111111111111111111111111111111", processor: "0x2222222222222222222222222222222222222222" });
});

test("canonical createCPU transaction owns request, decoded preview and calldata hash", () => {
  const lock = loadProtocolLock();
  const approval = {
    sender: GATEX_DEPLOYMENT_ACCOUNT,
    name: "GateX",
    symbol: "GTX",
    story: "Compiles application state machines into verified TapeOut NAND/LATCH circuits on X Layer.",
    cap: GATEX_CREATION.cap,
    priceWei: GATEX_CREATION.priceWei,
    feeWei: 6_600_000_000_000_000n
  };
  const transaction = buildCanonicalCreateCpuTransaction(lock, approval);
  assert.equal(transaction.method, CREATE_CPU_SIGNATURE);
  assert.equal(transaction.request.to, lock.factory.proxy);
  assert.equal(transaction.request.value, "0x1772aa3f848000");
  assert.deepEqual(transaction.preview, { name: approval.name, symbol: approval.symbol, story: approval.story, cap: approval.cap, priceWei: approval.priceWei });
  assert.equal(transaction.calldataSha256, "0x319feba0420ed68a30aa92dfcf4032293b26c8cf6e6e2d10836a1c2c29c7fbb9");
  assert.equal(transaction.calldataSha256, sha256Hex(transaction.request.data));
  assert.equal(Object.isFrozen(transaction), true);
  assert.equal(Object.isFrozen(transaction.request), true);
  assert.deepEqual(authorizeCanonicalCreateCpuTransaction(lock, transaction, approval), transaction.request);
  assert.equal("eth_sendTransaction" in transaction.request, false);
  assert.throws(() => authorizeCanonicalCreateCpuTransaction(lock, { ...transaction, request: { ...transaction.request, from: "0x1111111111111111111111111111111111111111" } }, approval), /sender mismatch/);
  assert.throws(() => authorizeCanonicalCreateCpuTransaction(lock, { ...transaction, request: { ...transaction.request, to: "0x2222222222222222222222222222222222222222" } }, approval), /target mismatch/);
  assert.throws(() => authorizeCanonicalCreateCpuTransaction(lock, { ...transaction, request: { ...transaction.request, value: "0x0" } }, approval), /value mismatch/);
});

test("D1R failed createCPU fixture proves the malformed metadata is rejected", () => {
  const lock = loadProtocolLock();
  const fixture = JSON.parse(readFileSync("tests/fixtures/gate-d1r-failed-create.json", "utf8")) as { transactionHash: string; calldataSha256: string; calldata: string };
  assert.equal(fixture.transactionHash, "0x2a3447e3fd3067a2b4cee0ddba6547585dd024b478caacba60a1c336a646c198");
  assert.equal(sha256Hex(fixture.calldata), fixture.calldataSha256);
  const decoded = decodeCreateCpuCall(lock, fixture.calldata);
  assert.deepEqual(decoded, { name: "GateX", symbol: "", story: "", cap: GATEX_CREATION.cap, priceWei: GATEX_CREATION.priceWei });

  const approval = {
    sender: GATEX_DEPLOYMENT_ACCOUNT,
    name: "GateX",
    symbol: "GTX",
    story: "Compiles application state machines into verified TapeOut NAND/LATCH circuits on X Layer.",
    cap: GATEX_CREATION.cap,
    priceWei: GATEX_CREATION.priceWei,
    feeWei: 6_600_000_000_000_000n
  };
  const failedRequest: CanonicalCreateCpuTransaction = {
    method: CREATE_CPU_SIGNATURE,
    request: { from: approval.sender, to: lock.factory.proxy, data: fixture.calldata, value: "0x1772aa3f848000" },
    preview: decoded,
    calldataSha256: fixture.calldataSha256
  };
  assert.throws(() => authorizeCanonicalCreateCpuTransaction(lock, failedRequest, approval), /symbol mismatch/);
  assert.throws(() => authorizeCanonicalCreateCpuTransaction(lock, { ...failedRequest, calldataSha256: "0xdeadbeef" }, approval), /calldata hash mismatch/);
});

test("canonical deployment loader rejects quarantined addresses", () => {
  const deployment = loadCanonicalDeployment();
  assert.equal(deployment.status, "FINAL_GATE_X_DEPLOYMENT");
  assert.notEqual(deployment.processor, deployment.quarantine.processor);
  assert.notEqual(deployment.token, deployment.quarantine.token);
  assert.throws(() => assertCanonicalDeploymentSelected(deployment, deployment.quarantine.processor, deployment.token), /canonical manifest/);
  assert.throws(() => assertCanonicalDeploymentSelected(deployment, deployment.processor, deployment.quarantine.token), /canonical manifest/);
});

test("canonical NAND/LATCH mint requests derive preview, value and hash from one frozen request", () => {
  const lock = loadProtocolLock();
  const deployment = loadCanonicalDeployment();
  const transaction = buildCanonicalMintTransaction(lock, { sender: deployment.creator, token: deployment.token, id: 0n, amount: 89n, priceWei: 1_000_000_000_000n, protocolFeeWei: 660_000_000_000_000n });
  assert.equal(transaction.method, MINT_SIGNATURE);
  assert.deepEqual(transaction.preview, { id: 0n, amount: 89n });
  assert.equal(transaction.request.value, "0x2a93626efd000");
  assert.equal(transaction.calldataSha256, sha256Hex(transaction.request.data));
  assert.equal(Object.isFrozen(transaction), true);
  assert.deepEqual(authorizeCanonicalMintTransaction(lock, transaction, { sender: deployment.creator, token: deployment.token, id: 0n, amount: 89n, priceWei: 1_000_000_000_000n, protocolFeeWei: 660_000_000_000_000n }), transaction.request);
  assert.throws(() => authorizeCanonicalMintTransaction(lock, { ...transaction, calldataSha256: "0xdeadbeef" }, { sender: deployment.creator, token: deployment.token, id: 0n, amount: 89n, priceWei: 1_000_000_000_000n, protocolFeeWei: 660_000_000_000_000n }), /hash mismatch/);
});

test("canonical TinyApproval tapeout request binds payload, dimensions, target and hash", () => {
  const lock = loadProtocolLock();
  const deployment = loadCanonicalDeployment();
  const payload = new Uint8Array([0, 1, 2, 3]);
  const transaction = buildCanonicalTapeoutTransaction(lock, { sender: deployment.creator, processor: deployment.processor, payload, nIn: 3, nOut: 1, feeWei: 1_300_000_000_000_000n });
  assert.equal(transaction.method, TAPEOUT_SIGNATURE);
  assert.deepEqual(transaction.preview, { payloadHex: "0x00010203", payloadBytes: 4, nIn: 3, nOut: 1 });
  assert.equal(transaction.request.value, "0x49e57d6354000");
  assert.equal(transaction.calldataSha256, sha256Hex(transaction.request.data));
  assert.deepEqual(authorizeCanonicalTapeoutTransaction(lock, transaction, { sender: deployment.creator, processor: deployment.processor, payload, nIn: 3, nOut: 1, feeWei: 1_300_000_000_000_000n }), transaction.request);
  assert.throws(() => authorizeCanonicalTapeoutTransaction(lock, { ...transaction, request: { ...transaction.request, to: deployment.quarantine.processor } }, { sender: deployment.creator, processor: deployment.processor, payload, nIn: 3, nOut: 1, feeWei: 1_300_000_000_000_000n }), /target mismatch/);
});
