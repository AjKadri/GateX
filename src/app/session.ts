export const SESSION_STORAGE_KEY = "gatex.browser.sessions.v1";

export interface BrowserSession {
  artifactDigest: string;
  chainId: number;
  processor: string;
  circuitId: string;
  sourceDigest: string;
  activeState: string;
  history: Array<{
    state: string;
    inputs: Record<string, boolean>;
    localNext: string;
    localOutput: string;
    origin: "LOCAL SIMULATION" | "LIVE X LAYER" | "HISTORICAL EVIDENCE";
    recordedAt: string;
  }>;
}

export function sessionKey(session: Pick<BrowserSession, "artifactDigest" | "chainId" | "processor" | "circuitId">): string {
  return [session.artifactDigest, session.chainId, session.processor.toLowerCase(), session.circuitId].join(":");
}

export function readSessions(storage: Storage | undefined = typeof localStorage === "undefined" ? undefined : localStorage): BrowserSession[] {
  if (storage === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(SESSION_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSession);
  } catch {
    return [];
  }
}

export function writeSessions(sessions: BrowserSession[], storage: Storage | undefined = typeof localStorage === "undefined" ? undefined : localStorage): void {
  if (storage === undefined) return;
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions.slice(0, 12)));
}

export function upsertSession(session: BrowserSession, storage?: Storage): void {
  const sessions = readSessions(storage).filter((candidate) => sessionKey(candidate) !== sessionKey(session));
  writeSessions([session, ...sessions], storage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSession(value: unknown): value is BrowserSession {
  if (!isRecord(value) || typeof value.artifactDigest !== "string" || typeof value.chainId !== "number" || typeof value.processor !== "string" || typeof value.circuitId !== "string" || typeof value.sourceDigest !== "string" || typeof value.activeState !== "string" || !Array.isArray(value.history)) return false;
  return value.history.every((entry) => isRecord(entry) && typeof entry.state === "string" && isRecord(entry.inputs) && typeof entry.localNext === "string" && typeof entry.localOutput === "string" && (entry.origin === "LOCAL SIMULATION" || entry.origin === "LIVE X LAYER" || entry.origin === "HISTORICAL EVIDENCE") && typeof entry.recordedAt === "string");
}

