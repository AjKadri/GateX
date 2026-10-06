import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_APPROVAL_SOURCE } from "../src/examples/agentApproval.js";
import { compileMachine } from "../src/compiler/compiler.js";
import { encodeInputMask, encodeStateIndex, packBits } from "../src/compiler/encoding.js";
import { interpretAst } from "../src/compiler/interpreter.js";
import { deserializeArtifact, serializeArtifact } from "../src/compiler/serialization.js";
import { simulateDecodedNetlist } from "../src/compiler/simulator.js";
import { GateXValidationError, validateMachine } from "../src/compiler/validation.js";
import { parseMachine } from "../src/compiler/parser.js";
import { extractTapeOutPayload } from "../src/protocol/wire.js";
import { loadProtocolLock } from "../src/protocol/lock.js";
import { verifyMintReceipt, verifyTapeoutReceipt } from "../src/protocol/receipts.js";
import { buildCanonicalMintTransaction, buildCanonicalTapeoutTransaction } from "../src/protocol/transaction-integrity.js";
import { loadCanonicalDeployment } from "../src/protocol/deployment.js";

const OVERLAPPING_REVOKED_SOURCE = `
machine AgentApprovalRevoked {
  states IDLE, REQUESTED, APPROVED, USED, REVOKED;
  initial IDLE;
  inputs request, approve, execute, cancel, human_ok, scope_ok;
  outputs permit;
  terminal USED;
  reset_on cancel;

  IDLE -> REQUESTED when request;
  REQUESTED -> APPROVED when approve && human_ok && scope_ok;
  REQUESTED -> REVOKED when approve;
  APPROVED -> USED when execute && human_ok && scope_ok emit permit;
}
`;

const DISJOINT_REVOKED_SOURCE = `
machine AgentApprovalRevoked {
  states IDLE, REQUESTED, APPROVED, USED, REVOKED;
  initial IDLE;
  inputs request, approve, execute, cancel, human_ok, scope_ok;
  outputs permit;
  terminal USED;
  reset_on cancel;

  IDLE -> REQUESTED when request;
  REQUESTED -> APPROVED when approve && human_ok && scope_ok;
  REQUESTED -> REVOKED when approve && (!human_ok || !scope_ok);
  APPROVED -> USED when execute && human_ok && scope_ok emit permit;
}
`;

function assertLocalEquivalence(compiled: Awaited<ReturnType<typeof compileMachine>>): number {
  let cases = 0;
  for (let state = 0; state < 1 << compiled.machine.stateBits; state += 1) {
    for (let input = 0; input < 1 << compiled.machine.inputs.length; input += 1) {
      const stateBytes = encodeStateIndex(state, compiled.machine.stateBits);
      const inputBytes = encodeInputMask(input, compiled.machine.inputs.length);
      const ast = interpretAst(compiled.machine, stateBytes, inputBytes);
      const netlist = simulateDecodedNetlist(compiled.bytes, stateBytes, inputBytes);
      assert.deepEqual([...netlist.nextStateBytes], [...ast.nextStateBytes], `next state state=${state} input=${input}`);
      assert.deepEqual([...netlist.outputBytes], [...ast.outputBytes], `output state=${state} input=${input}`);
      assert.equal(netlist.currentStateValid, ast.currentStateValid, `validity state=${state} input=${input}`);
      cases += 1;
    }
  }
  return cases;
}

function assertStep(compiled: Awaited<ReturnType<typeof compileMachine>>, state: number, input: number, next: number, output: boolean): void {
  const step = simulateDecodedNetlist(compiled.bytes, encodeStateIndex(state, compiled.machine.stateBits), encodeInputMask(input, compiled.machine.inputs.length));
  assert.deepEqual([...step.nextStateBytes], [...encodeStateIndex(next, compiled.machine.stateBits)]);
  assert.equal(step.outputs[0], output);
}

function topicAddress(value: string): string {
  return `0x${value.slice(2).padStart(64, "0")}`;
}

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function eventTopic(signature: string): string {
  return loadProtocolLock().gateD?.events.find((event) => event.signature === signature)?.topic0 as string;
}

test("AgentApproval uses the exact flagship declarations and locked DSL", () => {
  const machine = validateMachine(parseMachine(AGENT_APPROVAL_SOURCE));
  assert.deepEqual(machine.states.map((state) => state.name), ["IDLE", "REQUESTED", "APPROVED", "USED"]);
  assert.deepEqual(machine.inputs.map((input) => input.name), ["request", "approve", "execute", "cancel", "human_ok", "scope_ok"]);
  assert.deepEqual(machine.outputs.map((output) => output.name), ["permit"]);
  assert.equal(machine.initialState, "IDLE");
  assert.equal(machine.resetInput, "cancel");
  assert.equal(machine.states.find((state) => state.name === "USED")?.terminal, true);
  assert.equal(machine.stateBits, 2);
  assert.equal(machine.inputs.length, 6);
});

test("AgentApproval compiles deterministically within the locked client limits", async () => {
  const first = await compileMachine(AGENT_APPROVAL_SOURCE);
  const second = await compileMachine(AGENT_APPROVAL_SOURCE);
  assert.deepEqual([...first.bytes], [...second.bytes]);
  assert.equal(first.hash, second.hash);
  assert.equal(first.nandCount, 98);
  assert.equal(first.latchCount, 2);
  assert.equal(first.artifact.records.length, 100);
  assert.equal(first.bytes.length, 706);
  assert.equal(first.hash, "d68c9881fbe8bf0fbf7f86cfa92ad2889389e07e09bb0e7f0068f23eded50003");
  assert.equal(first.artifact.records.length, first.nandCount + first.latchCount);
  assert.ok(first.nandCount > 0);
  assert.ok(first.artifact.records.length <= 512);
  assert.ok(first.bytes.length <= 3584);
  const payload = await extractTapeOutPayload(loadProtocolLock(), first.bytes);
  assert.equal(payload.headerBytes, 12);
  assert.equal(payload.payloadBytes, first.bytes.length - 12);
  assert.equal(payload.payloadBytes, 694);
  assert.equal(payload.payloadHash, "7e4b5f83032beaf32ce2e7c067f1ee24d08feea1e2db8c64ef7c4d7de231dc45");
  assert.deepEqual(payload.dimensions, { nIn: 6, nOut: 1, nState: 2, gateCount: first.artifact.records.length });
  assert.deepEqual([...serializeArtifact(deserializeArtifact(first.bytes))], [...first.bytes]);
});

test("AgentApproval matches the independent interpreter over all 256 cases", async () => {
  const compiled = await compileMachine(AGENT_APPROVAL_SOURCE);
  assert.equal(assertLocalEquivalence(compiled), 256);
});

test("AgentApproval sequential lifecycle, reset priority, terminal behavior, and invalid state recovery pass", async () => {
  const compiled = await compileMachine(AGENT_APPROVAL_SOURCE);
  const request = 1;
  const approveWithGuards = (1 << 1) | (1 << 4) | (1 << 5);
  const executeWithGuards = (1 << 2) | (1 << 4) | (1 << 5);
  assertStep(compiled, 0, request, 1, false);
  assertStep(compiled, 1, approveWithGuards, 2, false);
  assertStep(compiled, 1, (1 << 1) | (1 << 5), 1, false);
  assertStep(compiled, 1, (1 << 1) | (1 << 4), 1, false);
  assertStep(compiled, 2, executeWithGuards, 3, true);
  assertStep(compiled, 2, 1 << 2, 2, false);
  for (let input = 0; input < 1 << 6; input += 1) {
    if ((input & (1 << 3)) === 0) assertStep(compiled, 3, input, 3, false);
    else for (let state = 0; state < 4; state += 1) assertStep(compiled, state, input, 0, false);
  }
  const invalidPadding = simulateDecodedNetlist(compiled.bytes, new Uint8Array([0b100]), packBits([false, false, false, false, false, false]));
  assert.deepEqual([...invalidPadding.nextStateBytes], [0]);
  assert.deepEqual([...invalidPadding.outputBytes], [0]);
  assert.equal(invalidPadding.currentStateValid, false);
});

test("Gate E differentiation kill-test rejects overlapping revocation guards with a witness", async () => {
  assert.throws(
    () => validateMachine(parseMachine(OVERLAPPING_REVOKED_SOURCE)),
    (error: unknown) => error instanceof GateXValidationError
      && /AMBIGUOUS_TRANSITION/.test(error.message)
      && /state=REQUESTED/.test(error.message)
      && /inputMask=50/.test(error.message)
      && /approve=1/.test(error.message)
      && /human_ok=1/.test(error.message)
      && /scope_ok=1/.test(error.message)
  );
});

test("Gate E corrected REVOKED DSL compiles and passes exhaustive proof", async () => {
  const first = await compileMachine(DISJOINT_REVOKED_SOURCE);
  const second = await compileMachine(DISJOINT_REVOKED_SOURCE);
  assert.deepEqual([...first.bytes], [...second.bytes]);
  assert.equal(first.hash, second.hash);
  assert.equal(assertLocalEquivalence(first), 512);
  assert.equal(first.machine.states.some((state) => state.name === "REVOKED"), true);
  assert.ok(first.nandCount + first.latchCount <= 512);
  assert.ok(first.bytes.length <= 3584);
});

test("Gate E receipt verification decodes locked mint and tapeout events", () => {
  const lock = loadProtocolLock();
  const deployment = loadCanonicalDeployment();
  const mint = buildCanonicalMintTransaction(lock, { sender: deployment.creator, token: deployment.token, id: 0n, amount: 98n, priceWei: 1_000_000_000_000n, protocolFeeWei: 660_000_000_000_000n });
  const mintHash = "0x" + "11".repeat(32);
  const mintReceipt = {
    status: "0x1", transactionHash: mintHash, blockHash: "0x" + "22".repeat(32), blockNumber: "0x10", from: deployment.creator, to: deployment.token, gasUsed: "0x10", effectiveGasPrice: "0x2",
    logs: [
      { address: deployment.token, topics: [eventTopic("Minted(address,uint256,uint256,uint256)"), topicAddress(deployment.creator), `0x${word(0n)}`], data: `0x${word(98n)}${word(758_000_000_000_000n)}` },
      { address: deployment.token, topics: [eventTopic("TransferSingle(address,address,address,uint256,uint256)"), topicAddress(deployment.creator), topicAddress("0x0000000000000000000000000000000000000000"), topicAddress(deployment.creator)], data: `0x${word(0n)}${word(98n)}` }
    ]
  };
  const mintTransaction = { hash: mintHash, from: deployment.creator, to: deployment.token, value: mint.request.value, input: mint.request.data, blockHash: mintReceipt.blockHash, blockNumber: mintReceipt.blockNumber };
  const mintResult = verifyMintReceipt(lock, "fixture", mintReceipt, mintTransaction, "0x12", { transactionHash: mintHash, sender: deployment.creator, token: deployment.token, data: mint.request.data, valueWei: 758_000_000_000_000n, id: 0n, amount: 98n });
  assert.equal(mintResult.minted.amount, 98n);
  assert.equal(mintResult.transferSingle.id, 0n);
  assert.throws(() => verifyMintReceipt(lock, "fixture", mintReceipt, { ...mintTransaction, input: "0xdead" }, "0x12", { transactionHash: mintHash, sender: deployment.creator, token: deployment.token, data: mint.request.data, valueWei: 758_000_000_000_000n, id: 0n, amount: 98n }), /calldata mismatch/);

  const tapeout = buildCanonicalTapeoutTransaction(lock, { sender: deployment.creator, processor: deployment.processor, payload: new Uint8Array([1, 2, 3]), nIn: 3, nOut: 1, feeWei: 1_300_000_000_000_000n });
  const tapeoutHash = "0x" + "33".repeat(32);
  const tapeoutReceipt = {
    status: "0x1", transactionHash: tapeoutHash, blockHash: "0x" + "44".repeat(32), blockNumber: "0x20", from: deployment.creator, to: deployment.processor, gasUsed: "0x20", effectiveGasPrice: "0x2",
    logs: [
      { address: deployment.processor, topics: [eventTopic("TapedOut(uint256,address,uint32,uint32)"), `0x${word(2n)}`, topicAddress(deployment.creator)], data: `0x${word(3n)}${word(2n)}` },
      { address: deployment.processor, topics: [eventTopic("Transfer(address,address,uint256)"), topicAddress("0x0000000000000000000000000000000000000000"), topicAddress(deployment.creator), `0x${word(2n)}`], data: "0x" }
    ]
  };
  const tapeoutTransaction = { hash: tapeoutHash, from: deployment.creator, to: deployment.processor, value: tapeout.request.value, input: tapeout.request.data, blockHash: tapeoutReceipt.blockHash, blockNumber: tapeoutReceipt.blockNumber };
  const tapeoutResult = verifyTapeoutReceipt(lock, "fixture", tapeoutReceipt, tapeoutTransaction, "0x22", { transactionHash: tapeoutHash, sender: deployment.creator, processor: deployment.processor, data: tapeout.request.data, valueWei: 1_300_000_000_000_000n, gateCount: 3, nState: 2 });
  assert.equal(tapeoutResult.tapedOut.circuitId, 2n);
  assert.equal(tapeoutResult.transfer.to, deployment.creator);
});
