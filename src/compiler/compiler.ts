import { boolAnd, boolConst, boolNot, boolOr, boolVar, evaluateNormalized, normalizeBoolean, type NormalizedBool } from "./normalize.js";
import { parseMachine } from "./parser.js";
import { artifactHash, serializeArtifact } from "./serialization.js";
import type { CompiledMachine, MachineAst, NandRecord, NetlistArtifact, ValidatedMachine } from "./types.js";
import { validateMachine } from "./validation.js";

interface TruthRow {
  stateValue: number;
  inputMask: number;
  expressionValue: boolean;
}

class NandBuilder {
  readonly records: NandRecord[] = [];
  private readonly cache = new Map<string, number>();
  private nextSignal: number;

  constructor(private readonly baseSignal: number) {
    this.nextSignal = baseSignal + 1;
  }

  signalFor(expression: NormalizedBool, variables: ReadonlyMap<string, number>): number {
    switch (expression.kind) {
      case "const":
        return this.constant(expression.value);
      case "var": {
        const signal = variables.get(expression.name);
        if (signal === undefined) throw new Error(`No signal allocated for ${expression.name}`);
        return signal;
      }
      case "not": {
        const signal = variables.get(expression.expr.name);
        if (signal === undefined) throw new Error(`No signal allocated for ${expression.expr.name}`);
        return this.emitNand(signal, signal, true);
      }
      case "and": {
        const signals = expression.terms.map((term) => this.signalFor(term, variables));
        if (signals.length === 0) return this.constant(true);
        return signals.slice(1).reduce((left, right) => this.not(this.emitNand(left, right, true)), signals[0] as number);
      }
      case "or": {
        const signals = expression.terms.map((term) => this.signalFor(term, variables));
        if (signals.length === 0) return this.constant(false);
        return signals.slice(1).reduce((left, right) => {
          const notLeft = this.not(left);
          const notRight = this.not(right);
          return this.emitNand(notLeft, notRight, true);
        }, signals[0] as number);
      }
    }
  }

  materialize(expression: NormalizedBool, variables: ReadonlyMap<string, number>): number {
    const signal = this.signalFor(expression, variables);
    const inverted = this.emitNand(signal, signal, false);
    return this.emitNand(inverted, inverted, false);
  }

  /**
   * Materializes several expressions so that their results are the LAST records produced, in order.
   * The netlist reads the final N records as the N outputs, so every output's logic is built first,
   * then one inverter per output, then one final gate per output. For a single expression this emits
   * exactly the same records as `materialize`.
   */
  materializeAll(expressions: readonly NormalizedBool[], variables: ReadonlyMap<string, number>): number[] {
    const signals = expressions.map((expression) => this.signalFor(expression, variables));
    const inverted = signals.map((signal) => this.emitNand(signal, signal, false));
    return inverted.map((signal) => this.emitNand(signal, signal, false));
  }

  private not(signal: number): number {
    return this.emitNand(signal, signal, true);
  }

  private constant(value: boolean): number {
    const key = value ? "const:true" : "const:false";
    const existing = this.cache.get(key);
    if (existing !== undefined) return existing;
    const baseNot = this.emitNand(this.baseSignal, this.baseSignal, true);
    const trueSignal = this.emitNand(this.baseSignal, baseNot, true);
    const result = value ? trueSignal : this.emitNand(trueSignal, trueSignal, true);
    this.cache.set("const:true", trueSignal);
    this.cache.set("const:false", result);
    return result;
  }

  private emitNand(left: number, right: number, cacheable: boolean): number {
    const first = Math.min(left, right);
    const second = Math.max(left, right);
    const key = `nand:${first}:${second}`;
    if (cacheable) {
      const existing = this.cache.get(key);
      if (existing !== undefined) return existing;
    }
    const signal = this.nextSignal;
    this.nextSignal += 1;
    this.records.push({ kind: "nand", left, right });
    if (cacheable) this.cache.set(key, signal);
    return signal;
  }
}

function normalizedInputEnvironment(machine: ValidatedMachine, stateValue: number, inputMask: number): Map<string, boolean> {
  const environment = new Map<string, boolean>();
  machine.inputs.forEach((input, index) => environment.set(`input:${input.name}`, (inputMask & (1 << index)) !== 0));
  const valid = stateValue < machine.states.length;
  machine.states.forEach((state, index) => environment.set(`state:${state.name}`, valid && stateValue === index));
  for (let bit = 0; bit < machine.stateBits; bit += 1) {
    environment.set(`stateBit:${bit}`, valid && (stateValue & (1 << bit)) !== 0);
  }
  return environment;
}

function dnfForRows(rows: TruthRow[], variableNames: string[]): NormalizedBool {
  const trueRows = rows.filter((row) => row.expressionValue);
  if (trueRows.length === 0) return boolConst(false);
  if (trueRows.length === rows.length) return boolConst(true);
  return boolOr(
    trueRows.map((row) =>
      boolAnd(
        variableNames.map((name, index) => {
          const value = name.startsWith("input:")
            ? (row.inputMask & (1 << index)) !== 0
            : (row.stateValue & (1 << (index - variableNames.filter((candidate) => candidate.startsWith("input:")).length))) !== 0;
          return value ? boolVar(name) : boolNot(name);
        })
      )
    )
  );
}

function expressionRows(machine: ValidatedMachine, output: (stateValue: number, inputMask: number) => boolean): TruthRow[] {
  const rows: TruthRow[] = [];
  const stateCount = 1 << machine.stateBits;
  const inputCount = 1 << machine.inputs.length;
  for (let stateValue = 0; stateValue < stateCount; stateValue += 1) {
    for (let inputMask = 0; inputMask < inputCount; inputMask += 1) {
      rows.push({ stateValue, inputMask, expressionValue: output(stateValue, inputMask) });
    }
  }
  return rows;
}

function compileTruthFunction(machine: ValidatedMachine, normalized: NormalizedBool): TruthRow[] {
  return expressionRows(machine, (stateValue, inputMask) => {
    if (stateValue >= machine.states.length) return false;
    const environment = normalizedInputEnvironment(machine, stateValue, inputMask);
    return evaluateNormalized(normalized, environment);
  });
}

function buildTransitionRows(machine: ValidatedMachine, bit: number): TruthRow[] {
  const normalizedGuards = machine.transitions.map((transition) => ({
    transition,
    guard: normalizeBoolean(transition.guard)
  }));
  const initialState = machine.stateIndex.get(machine.initialState) ?? 0;
  return expressionRows(machine, (stateValue, inputMask) => {
    if (stateValue >= machine.states.length) return (initialState & (1 << bit)) !== 0;
    const stateName = machine.states[stateValue]?.name;
    const environment = normalizedInputEnvironment(machine, stateValue, inputMask);
    const selected = normalizedGuards.find(
      (candidate) => candidate.transition.from === stateName && evaluateNormalized(candidate.guard, environment)
    );
    if (selected === undefined) throw new Error(`No compiler transition for ${stateName} and input mask ${inputMask}`);
    const target = machine.stateIndex.get(selected.transition.to);
    if (target === undefined) throw new Error(`Compiler transition target ${selected.transition.to} is unknown`);
    return (target & (1 << bit)) !== 0;
  });
}

function buildOutputRows(machine: ValidatedMachine, outputName: string): TruthRow[] {
  const emission = machine.emissions.find((candidate) => candidate.name === outputName);
  if (emission === undefined) throw new Error(`No emission for ${outputName}`);
  const normalized = normalizeBoolean(emission.expression);
  return compileTruthFunction(machine, normalized);
}

function negateNormalized(expression: NormalizedBool): NormalizedBool {
  switch (expression.kind) {
    case "const": return boolConst(!expression.value);
    case "var": return boolNot(expression.name);
    case "not": return boolVar(expression.expr.name);
    case "and": return boolOr(expression.terms.map(negateNormalized));
    case "or": return boolAnd(expression.terms.map(negateNormalized));
  }
}

function stateEquality(machine: ValidatedMachine, stateName: string): NormalizedBool {
  const stateValue = machine.stateIndex.get(stateName);
  if (stateValue === undefined) return boolConst(false);
  const terms = Array.from({ length: machine.stateBits }, (_, bit) => {
    const name = `stateBit:${bit}`;
    return (stateValue & (1 << bit)) === 0 ? boolNot(name) : boolVar(name);
  });
  return boolAnd(terms);
}

function normalizeStructuredExpression(
  expression: ExprLike,
  machine: ValidatedMachine,
  negated = false
): NormalizedBool {
  switch (expression.kind) {
    case "literal":
      return boolConst(negated ? !expression.value : expression.value);
    case "symbol": {
      const variable = `input:${expression.name}`;
      return negated ? boolNot(variable) : boolVar(variable);
    }
    case "state-is": {
      const equality = stateEquality(machine, expression.state);
      return negated ? negateNormalized(equality) : equality;
    }
    case "not":
      return normalizeStructuredExpression(expression.expr, machine, !negated);
    case "and":
      return negated
        ? boolOr([normalizeStructuredExpression(expression.left, machine, true), normalizeStructuredExpression(expression.right, machine, true)])
        : boolAnd([normalizeStructuredExpression(expression.left, machine), normalizeStructuredExpression(expression.right, machine)]);
    case "or":
      return negated
        ? boolAnd([normalizeStructuredExpression(expression.left, machine, true), normalizeStructuredExpression(expression.right, machine, true)])
        : boolOr([normalizeStructuredExpression(expression.left, machine), normalizeStructuredExpression(expression.right, machine)]);
  }
}

type ExprLike = ValidatedMachine["transitions"][number]["guard"];

function validStateExpression(machine: ValidatedMachine): NormalizedBool {
  return boolOr(machine.states.map((state) => stateEquality(machine, state.name)));
}

function buildStructuredTransitionExpression(machine: ValidatedMachine, bit: number): NormalizedBool {
  const terms: NormalizedBool[] = [];
  for (const transition of machine.transitions) {
    const target = machine.stateIndex.get(transition.to);
    if (target === undefined || (target & (1 << bit)) === 0) continue;
    terms.push(boolAnd([
      stateEquality(machine, transition.from),
      normalizeStructuredExpression(transition.guard, machine)
    ]));
  }
  const initialState = machine.stateIndex.get(machine.initialState) ?? 0;
  if ((initialState & (1 << bit)) !== 0) {
    terms.push(boolAnd([negateNormalized(validStateExpression(machine)), boolConst(true)]));
  }
  return boolOr(terms);
}

function buildStructuredOutputExpression(machine: ValidatedMachine, outputName: string): NormalizedBool {
  const emission = machine.emissions.find((candidate) => candidate.name === outputName);
  if (emission === undefined) throw new Error(`No emission for ${outputName}`);
  return boolAnd([
    validStateExpression(machine),
    normalizeStructuredExpression(emission.expression, machine)
  ]);
}

function buildArtifact(machine: ValidatedMachine, structured: boolean): NetlistArtifact {
  const variables = new Map<string, number>();
  machine.inputs.forEach((input, index) => variables.set(`input:${input.name}`, index));
  for (let bit = 0; bit < machine.stateBits; bit += 1) variables.set(`stateBit:${bit}`, machine.inputs.length + bit);

  const baseSignal = machine.inputs.length + machine.stateBits - 1;
  const builder = new NandBuilder(baseSignal);
  const nextSignals: number[] = [];
  for (let bit = 0; bit < machine.stateBits; bit += 1) {
    const expression = structured
      ? buildStructuredTransitionExpression(machine, bit)
      : dnfForRows(buildTransitionRows(machine, bit), [
        ...machine.inputs.map((input) => `input:${input.name}`),
        ...Array.from({ length: machine.stateBits }, (_, index) => `stateBit:${index}`)
      ]);
    nextSignals.push(builder.signalFor(expression, variables));
  }

  const outputExpressions = machine.outputs.map((output) => structured
    ? buildStructuredOutputExpression(machine, output.name)
    : dnfForRows(buildOutputRows(machine, output.name), [
      ...machine.inputs.map((input) => `input:${input.name}`),
      ...Array.from({ length: machine.stateBits }, (_, index) => `stateBit:${index}`)
    ]));
  builder.materializeAll(outputExpressions, variables);

  return {
    version: 1,
    inputCount: machine.inputs.length,
    stateBits: machine.stateBits,
    stateCount: machine.states.length,
    initialState: machine.stateIndex.get(machine.initialState) ?? 0,
    outputCount: machine.outputs.length,
    records: [
      ...nextSignals.map((data): NetlistArtifact["records"][number] => ({ kind: "latch", data })),
      ...builder.records
    ]
  };
}

export async function compileMachine(sourceOrAst: string | MachineAst): Promise<CompiledMachine> {
  const machine = validateMachine(typeof sourceOrAst === "string" ? parseMachine(sourceOrAst) : sourceOrAst);
  return compileValidatedMachine(machine);
}

export async function compileValidatedMachine(machine: ValidatedMachine): Promise<CompiledMachine> {
  const initialArtifact = buildArtifact(machine, false);
  const artifact = initialArtifact.records.length > 512 ? buildArtifact(machine, true) : initialArtifact;
  if (artifact.records.length > 512) throw new Error(`Artifact exceeds the locked 512-record bound (${artifact.records.length} records)`);
  const bytes = serializeArtifact(artifact);
  const hash = await artifactHash(bytes);
  return {
    machine,
    artifact,
    bytes,
    hash,
    nandCount: artifact.records.filter((record) => record.kind === "nand").length,
    latchCount: artifact.records.filter((record) => record.kind === "latch").length
  };
}
