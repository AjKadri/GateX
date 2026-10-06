import { GateXValidationError } from "../compiler/validation.js";

export interface Diagnostic { code: string; message: string; location: string; }

export function route(currentHash = typeof window === "undefined" ? "" : window.location.hash): "/" | "/workspace" | "/evidence" {
  const path = currentHash.replace(/^#/, "") || "/";
  return path === "/workspace" || path === "/evidence" ? path : "/";
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
