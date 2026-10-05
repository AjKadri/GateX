import { readFileSync } from "node:fs";
import { compileMachine } from "../src/compiler/compiler.js";
import { TINY_APPROVAL_SOURCE } from "../src/examples/tinyApproval.js";
import { extractTapeOutPayload } from "../src/protocol/wire.js";
import { GATEX_DEPLOYMENT_ACCOUNT, TINY_APPROVAL_PAYLOAD, runGateD0Preflight } from "../src/protocol/gate-d.js";
import { loadProtocolLock, providerClients, requireGateDProtocolFacts } from "../src/protocol/index.js";

function jsonValue(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

try {
  const lock = loadProtocolLock();
  requireGateDProtocolFacts(lock);
  const compiled = await compileMachine(TINY_APPROVAL_SOURCE);
  const payload = await extractTapeOutPayload(lock, compiled.bytes);
  if (payload.payloadBytes !== TINY_APPROVAL_PAYLOAD.bytes || payload.payloadHash !== TINY_APPROVAL_PAYLOAD.sha256 || payload.dimensions.nIn !== TINY_APPROVAL_PAYLOAD.nIn || payload.dimensions.nOut !== TINY_APPROVAL_PAYLOAD.nOut || payload.dimensions.nState !== TINY_APPROVAL_PAYLOAD.nState) {
    throw new Error(`TinyApproval payload does not match the locked Gate D artifact: ${JSON.stringify(payload, jsonValue)}`);
  }
  const story = process.env.GATEX_STORY;
  const refresh = await runGateD0Preflight(lock, providerClients(lock), GATEX_DEPLOYMENT_ACCOUNT, story);
  const status = refresh.blockers.length === 0 && refresh.creation?.accepted === true ? "PASS" : "BLOCKED";
  console.log(JSON.stringify({
    status,
    label: "READ_ONLY_SENDER_PREFLIGHT",
    authorization: { transactionsSent: false, signaturesRequested: false, walletOpened: false },
    creationStorySupplied: story !== undefined,
    artifact: {
      localContainerBytes: compiled.bytes.length,
      localContainerSha256: compiled.hash,
      tapeoutPayloadBytes: payload.payloadBytes,
      tapeoutPayloadSha256: payload.payloadHash,
      nand: compiled.nandCount,
      latch: compiled.latchCount,
      records: compiled.artifact.records.length,
      dimensions: payload.dimensions
    },
    refresh
  }, jsonValue, 2));
  if (status !== "PASS") process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ status: "BLOCKED", reason: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 2;
}
