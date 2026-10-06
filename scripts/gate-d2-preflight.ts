import { runGateD2Preflight } from "../src/protocol/gate-d2.js";
import { loadProtocolLock, providerClients } from "../src/protocol/index.js";

function jsonValue(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

try {
  const lock = loadProtocolLock();
  const result = await runGateD2Preflight(lock, providerClients(lock));
  console.log(JSON.stringify({ ...result, authorization: { transactionsSent: false, signaturesRequested: false, walletOpened: false } }, jsonValue, 2));
  if (result.status !== "PASS") process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ status: "BLOCKED", label: "D2_PREFLIGHT", authorization: { transactionsSent: false, signaturesRequested: false, walletOpened: false }, reason: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2));
  process.exitCode = 2;
}
