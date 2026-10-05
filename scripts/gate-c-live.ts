import { readFileSync } from "node:fs";
import { compileMachine } from "../src/compiler/compiler.js";
import { TINY_APPROVAL_SOURCE } from "../src/examples/tinyApproval.js";
import { extractTapeOutPayload } from "../src/protocol/wire.js";
import { loadProtocolLock, parseFixtureDocument, providerClients, runGateCLive, verifyLockedProviders } from "../src/protocol/index.js";

const EXPECTED_LOCAL_BYTES = 643;
const EXPECTED_LOCAL_HEADER_BYTES = 12;
const EXPECTED_PAYLOAD_BYTES = 631;
const EXPECTED_LOCAL_SHA256 = "adee32d4133073926d312a711643d16ac7d849c7e662c2bce8f6131c35fd0334";
const EXPECTED_NAND = 89;
const EXPECTED_LATCH = 2;
const EXPECTED_RECORDS = 91;

function fail(message: string): never {
  throw new Error(message);
}

try {
  const lock = loadProtocolLock();
  const fixtures = parseFixtureDocument(JSON.parse(readFileSync("tests/fixtures/gate-c.json", "utf8")) as unknown);
  const baseline = fixtures.candidateBaseline.value;
  if (baseline.processor.toLowerCase() !== lock.sample.processor.toLowerCase()) fail("Candidate fixture processor does not match the locked sample processor");
  if (!lock.snapshot.providers.includes(baseline.traceProvider)) fail("Candidate trace provider is not locked");
  if (baseline.evaluationProviders.length !== lock.snapshot.providers.length || baseline.evaluationProviders.some((provider) => !lock.snapshot.providers.includes(provider))) fail("Candidate evaluation providers do not match the locked provider set");
  if (baseline.blockNumber !== lock.snapshot.blockNumber || baseline.blockHash.toLowerCase() !== lock.snapshot.blockHash.toLowerCase()) fail("Candidate fixture block does not match the locked pinned block");

  const compiled = await compileMachine(TINY_APPROVAL_SOURCE);
  if (compiled.bytes.length !== EXPECTED_LOCAL_BYTES) fail(`TinyApproval local container length changed: ${compiled.bytes.length}`);
  if (compiled.hash !== EXPECTED_LOCAL_SHA256) fail(`TinyApproval local container hash changed: ${compiled.hash}`);
  if (compiled.nandCount !== EXPECTED_NAND || compiled.latchCount !== EXPECTED_LATCH || compiled.artifact.records.length !== EXPECTED_RECORDS) fail("TinyApproval counts changed");
  const payload = await extractTapeOutPayload(lock, compiled.bytes);
  if (payload.headerBytes !== EXPECTED_LOCAL_HEADER_BYTES || payload.payloadBytes !== EXPECTED_PAYLOAD_BYTES) fail(`TinyApproval payload boundary changed: ${payload.headerBytes}/${payload.payloadBytes}`);

  const clients = providerClients(lock);
  const identity = await verifyLockedProviders(lock, clients);
  const live = await runGateCLive(lock, fixtures, compiled, payload, clients, identity.providers.length);
  if (live.fixtureResults.some((result) => result.mismatches.length > 0) || live.transientResults.some((result) => result.mismatches.length > 0) || live.candidate.mismatches.length > 0) fail(JSON.stringify({ live }, null, 2));

  console.log(JSON.stringify({
    status: "PASS",
    label: live.label,
    artifact: {
      localContainerBytes: compiled.bytes.length,
      localHeaderBytes: payload.headerBytes,
      tapeOutPayloadBytes: payload.payloadBytes,
      localSha256: payload.localHash,
      tapeOutPayloadSha256: payload.payloadHash,
      nand: compiled.nandCount,
      latch: compiled.latchCount,
      records: compiled.artifact.records.length,
      dimensions: payload.dimensions
    },
    identity,
    fixtures: live.fixtureResults,
    transientFixtures: live.transientResults,
    candidate: live.candidate,
    walletPath: { transactionSent: false, signatureRequested: false }
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "BLOCKED", reason: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2));
  process.exitCode = 2;
}
