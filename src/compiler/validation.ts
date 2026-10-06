import type { Expr, MachineAst, ValidatedMachine } from "./types.js";

export class GateXValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join("\n"));
    this.name = "GateXValidationError";
  }
}

export interface EvaluationEnvironment {
  inputs: ReadonlyMap<string, boolean>;
  state: string;
}

export function evaluateAstExpression(expression: Expr, environment: EvaluationEnvironment): boolean {
  switch (expression.kind) {
    case "literal":
      return expression.value;
    case "symbol": {
      const value = environment.inputs.get(expression.name);
      if (value === undefined) {
        throw new Error(`Unknown input ${expression.name}`);
      }
      return value;
    }
    case "state-is":
      return environment.state === expression.state;
    case "not":
      return !evaluateAstExpression(expression.expr, environment);
    case "and":
      return evaluateAstExpression(expression.left, environment) && evaluateAstExpression(expression.right, environment);
    case "or":
      return evaluateAstExpression(expression.left, environment) || evaluateAstExpression(expression.right, environment);
  }
}

function and(left: Expr, right: Expr): Expr {
  return { kind: "and", left, right, span: { start: left.span.start, end: right.span.end } };
}

function or(left: Expr, right: Expr): Expr {
  return { kind: "or", left, right, span: { start: left.span.start, end: right.span.end } };
}

function not(expression: Expr): Expr {
  return { kind: "not", expr: expression, span: { ...expression.span } };
}

function literal(value: boolean, span: { start: number; end: number }): Expr {
  return { kind: "literal", value, span: { ...span } };
}

function symbol(name: string, span: { start: number; end: number }): Expr {
  return { kind: "symbol", name, span: { ...span } };
}

function containsSymbol(expression: Expr, name: string): boolean {
  switch (expression.kind) {
    case "symbol": return expression.name === name;
    case "not": return containsSymbol(expression.expr, name);
    case "and":
    case "or": return containsSymbol(expression.left, name) || containsSymbol(expression.right, name);
    case "literal":
    case "state-is": return false;
  }
}

function materializeResetOn(machine: MachineAst): MachineAst {
  if (!machine.resetOn) return machine;
  const reset = symbol(machine.resetInput, machine.span);
  const notReset = not(reset);
  const transitions: MachineAst["transitions"] = [];
  for (const state of machine.states) {
    transitions.push({ from: state.name, to: machine.initialState, guard: reset, span: state.span });
    const explicit = machine.transitions.filter((transition) => transition.from === state.name);
    const explicitGuards = explicit.map((transition) => transition.guard);
    const anyExplicit = explicitGuards.reduce((left, right) => left === undefined ? right : or(left, right), undefined as Expr | undefined);
    for (const transition of explicit) {
      transitions.push({
        ...transition,
        guard: and(transition.guard, notReset)
      });
    }
    const fallbackGuard = anyExplicit === undefined ? notReset : and(notReset, not(anyExplicit));
    transitions.push({ from: state.name, to: state.name, guard: fallbackGuard, span: state.span });
  }
  return { ...machine, transitions, resetOn: false };
}

function stateBitWidth(stateCount: number): number {
  return Math.max(1, Math.ceil(Math.log2(stateCount)));
}

function duplicateNames(names: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      duplicates.add(name);
    }
    seen.add(name);
  }
  return [...duplicates];
}

function collectExpressionIssues(
  expression: Expr,
  inputNames: ReadonlySet<string>,
  stateNames: ReadonlySet<string>,
  context: string,
  issues: string[]
): void {
  switch (expression.kind) {
    case "literal":
      return;
    case "symbol":
      if (!inputNames.has(expression.name)) {
        issues.push(`${context}: unknown input symbol ${expression.name}`);
      }
      return;
    case "state-is":
      if (!stateNames.has(expression.state)) {
        issues.push(`${context}: unknown state symbol ${expression.state}`);
      }
      return;
    case "not":
      collectExpressionIssues(expression.expr, inputNames, stateNames, context, issues);
      return;
    case "and":
    case "or":
      collectExpressionIssues(expression.left, inputNames, stateNames, context, issues);
      collectExpressionIssues(expression.right, inputNames, stateNames, context, issues);
      return;
  }
}

function inputAssignments(inputNames: string[]): ReadonlyMap<string, boolean>[] {
  const assignments: ReadonlyMap<string, boolean>[] = [];
  const count = 1 << inputNames.length;
  for (let mask = 0; mask < count; mask += 1) {
    const values = new Map<string, boolean>();
    inputNames.forEach((name, index) => values.set(name, (mask & (1 << index)) !== 0));
    assignments.push(values);
  }
  return assignments;
}

export function validateMachine(machine: MachineAst): ValidatedMachine {
  const hasGlobalReset = machine.resetOn === true;
  const declaredTransitions = machine.transitions;
  const declaredResetInput = machine.resetInput;
  const resetGuardIssues: string[] = [];
  if (hasGlobalReset) {
    for (const transition of declaredTransitions) {
      if (containsSymbol(transition.guard, declaredResetInput)) {
        resetGuardIssues.push(`reset input ${declaredResetInput} cannot appear in ordinary transition guard`);
      }
    }
  }
  machine = materializeResetOn(machine);
  const issues: string[] = [...resetGuardIssues];
  const stateNames = new Set(machine.states.map((state) => state.name));
  const inputNames = new Set(machine.inputs.map((input) => input.name));
  const outputNames = new Set(machine.outputs.map((output) => output.name));
  const allNames = [...stateNames, ...inputNames, ...outputNames];

  if (machine.states.length === 0) issues.push("machine must declare at least one state");
  if (machine.states.length > 8) issues.push("machine exceeds the locked limit of 8 states");
  if (machine.inputs.length > 8) issues.push("machine exceeds the locked limit of 8 inputs");
  if (machine.outputs.length > 4) issues.push("machine exceeds the locked limit of 4 outputs");

  for (const duplicate of duplicateNames(machine.states.map((state) => state.name))) {
    issues.push(`duplicate state symbol ${duplicate}`);
  }
  for (const duplicate of duplicateNames(machine.inputs.map((input) => input.name))) {
    issues.push(`duplicate input symbol ${duplicate}`);
  }
  for (const duplicate of duplicateNames(machine.outputs.map((output) => output.name))) {
    issues.push(`duplicate output symbol ${duplicate}`);
  }
  const duplicateAcrossKinds = duplicateNames(allNames);
  for (const duplicate of duplicateAcrossKinds) {
    issues.push(`symbol ${duplicate} is declared in more than one namespace`);
  }

  if (!stateNames.has(machine.initialState)) {
    issues.push(`initial state ${machine.initialState || "<missing>"} is not declared`);
  }
  if (!inputNames.has(machine.resetInput)) {
    issues.push(`reset input ${machine.resetInput || "<missing>"} is not declared`);
  }

  const transitionSources = new Set(machine.states.map((state) => state.name));
  for (const state of machine.states) {
    if (state.terminal && !stateNames.has(state.name)) issues.push(`unknown terminal state ${state.name}`);
  }
  for (const transition of machine.transitions) {
    if (!stateNames.has(transition.from)) issues.push(`transition source ${transition.from} is not declared`);
    if (!stateNames.has(transition.to)) issues.push(`transition target ${transition.to} is not declared`);
    collectExpressionIssues(transition.guard, inputNames, stateNames, `transition ${transition.from} -> ${transition.to}`, issues);
  }
  for (const emission of machine.emissions) {
    if (!outputNames.has(emission.name)) issues.push(`emission ${emission.name} is not a declared output`);
    collectExpressionIssues(emission.expression, inputNames, stateNames, `emission ${emission.name}`, issues);
  }
  for (const output of machine.outputs) {
    if (!machine.emissions.some((emission) => emission.name === output.name)) {
      issues.push(`output ${output.name} has no emission expression`);
    }
  }
  for (const emission of machine.emissions) {
    if (machine.emissions.filter((candidate) => candidate.name === emission.name).length > 1) {
      issues.push(`output ${emission.name} has multiple emission expressions`);
    }
  }

  if (issues.length > 0) {
    throw new GateXValidationError(issues);
  }

  const stateIndex = new Map(machine.states.map((state, index) => [state.name, index]));
  const inputIndex = new Map(machine.inputs.map((input, index) => [input.name, index]));
  const outputIndex = new Map(machine.outputs.map((output, index) => [output.name, index]));
  const assignments = inputAssignments(machine.inputs.map((input) => input.name));
  const selected = new Map<string, Map<number, number>>();

  for (const state of machine.states) {
    const byMask = new Map<number, number>();
    const transitions = machine.transitions.filter((transition) => transition.from === state.name);
    if (transitions.length === 0) {
      issues.push(`state ${state.name} has no transitions`);
    }

    assignments.forEach((inputs, mask) => {
      const matches = transitions.filter((transition) =>
        evaluateAstExpression(transition.guard, { inputs, state: state.name })
      );
      if (matches.length === 0) {
        issues.push(`UNSATISFIABLE_TRANSITION state=${state.name} inputMask=${mask} inputs=${witness(machine.inputs.map((input) => input.name), mask)}`);
        return;
      }
      if (matches.length > 1) {
        issues.push(`AMBIGUOUS_TRANSITION ambiguous state=${state.name} inputMask=${mask} inputs=${witness(machine.inputs.map((input) => input.name), mask)} targets=${matches.map((match) => match.to).join(",")}`);
        return;
      }
      const match = matches[0];
      if (match === undefined) return;
      const targetIndex = stateIndex.get(match.to);
      if (targetIndex === undefined) return;
      byMask.set(mask, targetIndex);

      const resetValue = inputs.get(machine.resetInput) ?? false;
      if (resetValue && match.to !== machine.initialState) {
        issues.push(`reset must take ${state.name} to ${machine.initialState} for input mask ${mask}`);
      }
      if (state.terminal && !resetValue && match.to !== state.name) {
        issues.push(`terminal state ${state.name} must self-loop without reset for input mask ${mask}`);
      }
    });
    selected.set(state.name, byMask);
  }

  if (issues.length > 0) {
    throw new GateXValidationError(issues);
  }

  const reachable = new Set<string>([machine.initialState]);
  const queue = [machine.initialState];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const byMask = selected.get(current);
    if (byMask === undefined) continue;
    for (const targetIndex of byMask.values()) {
      const target = machine.states[targetIndex]?.name;
      if (target !== undefined && !reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  for (const state of machine.states) {
    if (!reachable.has(state.name)) issues.push(`state ${state.name} is unreachable from ${machine.initialState}`);
  }

  if (issues.length > 0) {
    throw new GateXValidationError(issues);
  }

  return {
    ...machine,
    stateBits: stateBitWidth(machine.states.length),
    stateIndex,
    inputIndex,
    outputIndex
  };
}

function witness(inputNames: string[], mask: number): string {
  return inputNames.map((name, index) => `${name}=${(mask & (1 << index)) !== 0 ? "1" : "0"}`).join(",");
}
