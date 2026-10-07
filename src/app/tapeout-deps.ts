import type { TapeoutDeps, StorageLike } from "./tapeout.js";
import { browserClients, browserDeployment, browserLock, readBoundCircuit, readLiveStep, readOnlyQuote } from "./protocol.js";

/** sessionStorage if it really works (some private modes expose it but throw on write); otherwise undefined, which blocks sending. */
function workingSessionStorage(): StorageLike | undefined {
  try {
    if (typeof sessionStorage === "undefined") return undefined;
    const probe = "gatex.tapeout.probe";
    sessionStorage.setItem(probe, "1");
    sessionStorage.removeItem(probe);
    return sessionStorage;
  } catch {
    return undefined;
  }
}

export function browserTapeoutDeps(): TapeoutDeps {
  return { lock: browserLock, deployment: browserDeployment, clients: browserClients, quote: readOnlyQuote, readBoundCircuit, readLiveStep, storage: workingSessionStorage() };
}
