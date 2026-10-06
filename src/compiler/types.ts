export interface SourceSpan {
  start: number;
  end: number;
}

export type Expr =
  | { kind: "literal"; value: boolean; span: SourceSpan }
  | { kind: "symbol"; name: string; span: SourceSpan }
  | { kind: "state-is"; state: string; span: SourceSpan }
  | { kind: "not"; expr: Expr; span: SourceSpan }
  | { kind: "and"; left: Expr; right: Expr; span: SourceSpan }
  | { kind: "or"; left: Expr; right: Expr; span: SourceSpan };

export interface StateDeclaration {
  name: string;
  terminal: boolean;
  span: SourceSpan;
}

export interface SymbolDeclaration {
  name: string;
  span: SourceSpan;
}

export interface TransitionDeclaration {
  from: string;
  to: string;
  guard: Expr;
  emits?: string[];
  span: SourceSpan;
}

export interface OutputDeclaration {
  name: string;
  expression: Expr;
  span: SourceSpan;
}

export interface MachineAst {
  name: string;
  states: StateDeclaration[];
  inputs: SymbolDeclaration[];
  outputs: SymbolDeclaration[];
  initialState: string;
  resetInput: string;
  transitions: TransitionDeclaration[];
  emissions: OutputDeclaration[];
  resetOn?: boolean;
  span: SourceSpan;
}

export interface ValidatedMachine extends MachineAst {
  stateBits: number;
  stateIndex: ReadonlyMap<string, number>;
  inputIndex: ReadonlyMap<string, number>;
  outputIndex: ReadonlyMap<string, number>;
}

export interface AstStepResult {
  currentState: number;
  nextState: number;
  currentStateValid: boolean;
  outputs: boolean[];
  outputBytes: Uint8Array;
  nextStateBytes: Uint8Array;
}

export interface NandRecord {
  kind: "nand";
  left: number;
  right: number;
}

export interface LatchRecord {
  kind: "latch";
  data: number;
}

export type NetlistRecord = NandRecord | LatchRecord;

export interface NetlistArtifact {
  version: 1;
  inputCount: number;
  stateBits: number;
  stateCount: number;
  initialState: number;
  outputCount: number;
  records: NetlistRecord[];
}

export interface CompiledMachine {
  machine: ValidatedMachine;
  artifact: NetlistArtifact;
  bytes: Uint8Array;
  hash: string;
  nandCount: number;
  latchCount: number;
}
