import assert from "node:assert/strict";
import test from "node:test";
import {
  GATEX_CREATION,
  GATEX_DEPLOYMENT_ACCOUNT,
  GateDBlockedError,
  TINY_APPROVAL_PAYLOAD,
  creationCall,
  creationLogFilter,
  decodeCreateReturn,
  encodeGateDCall,
  expectedMintValue,
  loadProtocolLock,
  mintCall,
  padTopicAddress,
  requireGateDProtocolFacts,
  sha256Hex,
  tapeoutLogFilter,
  transactionPlanDigest
} from "../src/protocol/index.js";

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
