import { GateXValidationError } from "../compiler/validation.js";

export interface Diagnostic { code: string; message: string; location: string; }

export type RoutePath = "/" | "/workspace" | "/circuits" | "/evidence";

function splitHash(currentHash: string): { path: string; query: string } {
  const body = currentHash.replace(/^#/, "");
  const mark = body.indexOf("?");
  return mark === -1 ? { path: body || "/", query: "" } : { path: body.slice(0, mark) || "/", query: body.slice(mark + 1) };
}

export function route(currentHash = typeof window === "undefined" ? "" : window.location.hash): RoutePath {
  const { path } = splitHash(currentHash);
  return path === "/workspace" || path === "/circuits" || path === "/evidence" ? path : "/";
}

/** The query part of a hash route, e.g. "#/workspace?circuit=3" gives circuit=3. */
export function routeQuery(currentHash = typeof window === "undefined" ? "" : window.location.hash): URLSearchParams {
  return new URLSearchParams(splitHash(currentHash).query);
}

export function diagnosticFromError(error: unknown, source: string): Diagnostic[] {
  const message = error instanceof Error ? error.message : String(error);
  const issues = error instanceof GateXValidationError ? error.issues : [message];
  return issues.map((issue) => {
    const match = issue.match(/^([A-Z][A-Z0-9_]+)\b/);
    const inferred = issue.includes("ambiguous") ? "AMBIGUOUS_TRANSITION" : issue.includes("unreachable") ? "UNREACHABLE_STATE" : issue.includes("reset input") ? "RESET_INPUT_INVALID" : issue.includes("no emission") ? "OUTPUT_EXPRESSION_MISSING" : issue.includes("unknown") ? "UNKNOWN_SYMBOL" : undefined;
    const code = match?.[1] ?? inferred ?? (error instanceof GateXValidationError ? "VALIDATION_ERROR" : "PARSE_ERROR");
    const span = (error as { span?: { start?: number } }).span?.start;
    const sourceIndex = typeof span === "number" ? span : Math.max(0, source.indexOf(issue));
    return { code, message: issue, location: `line ${source.slice(0, sourceIndex).split("\n").length}` };
  });
}
