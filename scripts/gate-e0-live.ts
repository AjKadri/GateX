import { gateEJson, runGateE0Preflight } from "../src/protocol/gate-e.js";
import { loadProtocolLock } from "../src/protocol/lock.js";
import { providerClients } from "../src/protocol/rpc.js";

try {
  const lock = loadProtocolLock();
  const result = await runGateE0Preflight(lock, providerClients(lock));
  console.log(gateEJson(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
