import type { Expr } from "./types.js";

export type NormalizedBool =
  | { kind: "const"; value: boolean }
  | { kind: "var"; name: string }
  | { kind: "not"; expr: { kind: "var"; name: string } }
  | { kind: "and"; terms: NormalizedBool[] }
  | { kind: "or"; terms: NormalizedBool[] };

function variableName(expression: Expr): string {
  if (expression.kind === "symbol") return `input:${expression.name}`;
  if (expression.kind === "state-is") return `state:${expression.state}`;
  throw new Error("Only atoms can be converted to a variable");
}

function literalKey(expression: NormalizedBool): string {
  if (expression.kind === "var") return `+${expression.name}`;
  if (expression.kind === "not") return `-${expression.expr.name}`;
  throw new Error("Expected a literal");
}

function expressionKey(expression: NormalizedBool): string {
  switch (expression.kind) {
    case "const":
      return expression.value ? "1" : "0";
    case "var":
      return `v(${expression.name})`;
    case "not":
      return `n(${expression.expr.name})`;
    case "and":
      return `a(${expression.terms.map(expressionKey).join(",")})`;
    case "or":
      return `o(${expression.terms.map(expressionKey).join(",")})`;
  }
}

function complementKey(expression: NormalizedBool): string {
  if (expression.kind === "var") return `-${expression.name}`;
  if (expression.kind === "not") return `+${expression.expr.name}`;
  throw new Error("Expected a literal");
}

function normalizeNnf(expression: Expr, negated: boolean): NormalizedBool {
  switch (expression.kind) {
    case "literal":
      return { kind: "const", value: negated ? !expression.value : expression.value };
    case "symbol":
    case "state-is": {
      const variable = { kind: "var" as const, name: variableName(expression) };
      return negated ? { kind: "not", expr: variable } : variable;
    }
    case "not":
      return normalizeNnf(expression.expr, !negated);
    case "and":
      return combine(negated ? "or" : "and", [normalizeNnf(expression.left, negated), normalizeNnf(expression.right, negated)]);
    case "or":
      return combine(negated ? "and" : "or", [normalizeNnf(expression.left, negated), normalizeNnf(expression.right, negated)]);
  }
}

function combine(kind: "and" | "or", originalTerms: NormalizedBool[]): NormalizedBool {
  const flattened: NormalizedBool[] = [];
  for (const term of originalTerms) {
    if (term.kind === kind) flattened.push(...term.terms);
    else flattened.push(term);
  }

  if (kind === "and" && flattened.some((term) => term.kind === "const" && !term.value)) return { kind: "const", value: false };
  if (kind === "or" && flattened.some((term) => term.kind === "const" && term.value)) return { kind: "const", value: true };

  const terms = flattened.filter((term) => term.kind !== "const");
  if (terms.length === 0) return { kind: "const", value: kind === "and" };

  const unique = new Map<string, NormalizedBool>();
  for (const term of terms) {
    const key = expressionKey(term);
    if (term.kind === "var" || term.kind === "not") {
      if (unique.has(complementKey(term))) return { kind: "const", value: kind === "or" };
    }
    if (unique.has(key)) continue;
    unique.set(key, term);
  }
  const sorted = [...unique.values()].sort((left, right) => expressionKey(left).localeCompare(expressionKey(right)));
  if (sorted.length === 1) return sorted[0] as NormalizedBool;
  return { kind: kind === "and" ? "and" : "or", terms: sorted };
}

export function normalizeBoolean(expression: Expr): NormalizedBool {
  return normalizeNnf(expression, false);
}

export function evaluateNormalized(expression: NormalizedBool, environment: ReadonlyMap<string, boolean>): boolean {
  switch (expression.kind) {
    case "const":
      return expression.value;
    case "var":
      return environment.get(expression.name) ?? false;
    case "not":
      return !(environment.get(expression.expr.name) ?? false);
    case "and":
      return expression.terms.every((term) => evaluateNormalized(term, environment));
    case "or":
      return expression.terms.some((term) => evaluateNormalized(term, environment));
  }
}

export function normalizedKey(expression: NormalizedBool): string {
  switch (expression.kind) {
    case "const":
      return expression.value ? "1" : "0";
    case "var":
      return `v(${expression.name})`;
    case "not":
      return `n(${expression.expr.name})`;
    case "and":
      return `a(${expression.terms.map(normalizedKey).join(",")})`;
    case "or":
      return `o(${expression.terms.map(normalizedKey).join(",")})`;
  }
}

export function boolConst(value: boolean): NormalizedBool {
  return { kind: "const", value };
}

export function boolVar(name: string): NormalizedBool {
  return { kind: "var", name };
}

export function boolNot(name: string): NormalizedBool {
  return { kind: "not", expr: { kind: "var", name } };
}

export function boolAnd(terms: NormalizedBool[]): NormalizedBool {
  const expression = terms.length === 0 ? boolConst(true) : terms.reduce((left, right) => combine("and", [left, right]));
  return expression;
}

export function boolOr(terms: NormalizedBool[]): NormalizedBool {
  const expression = terms.length === 0 ? boolConst(false) : terms.reduce((left, right) => combine("or", [left, right]));
  return expression;
}
