import type { StorageLike } from "./tapeout.js";
import { browserClients, browserLock } from "./protocol.js";
import { RULEGATE, type RuleGateDeps } from "./rulegate.js";

/** sessionStorage if it really works; otherwise undefined, which blocks sending. */
function workingSessionStorage(): StorageLike | undefined {
  try {
    if (typeof sessionStorage === "undefined") return undefined;
    const probe = "gatex.rulegate.probe";
    sessionStorage.setItem(probe, "1");
    sessionStorage.removeItem(probe);
    return sessionStorage;
  } catch {
    return undefined;
  }
}

export function browserRuleGateDeps(): RuleGateDeps {
  return { config: RULEGATE, lock: browserLock, clients: browserClients, storage: workingSessionStorage() };
}
