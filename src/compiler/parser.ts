import { GateXSyntaxError, tokenize, type Token } from "./tokenizer.js";
import type { Expr, MachineAst, SourceSpan } from "./types.js";

export class GateXParseError extends GateXSyntaxError {
  name = "GateXParseError";
}

class Parser {
  private cursor = 0;
  private readonly terminalStates = new Set<string>();
  private resetOn = false;

  constructor(private readonly tokens: Token[]) {}

  parse(): MachineAst {
    const machineToken = this.expectIdentifier("machine");
    const nameToken = this.expectKind("identifier", "machine name");
    this.expect("{");

    const states: MachineAst["states"] = [];
    const inputs: MachineAst["inputs"] = [];
    const outputs: MachineAst["outputs"] = [];
    const transitions: MachineAst["transitions"] = [];
    const emissions: MachineAst["emissions"] = [];
    let initialState = "";
    let resetInput = "";
    let end = nameToken.span.end;

    while (!this.check("}")) {
      const declaration = this.peek();
      if (declaration.kind === "eof") {
        throw new GateXParseError("Expected closing brace", declaration.span);
      }

      switch (declaration.value) {
        case "states": {
          const keyword = this.advance();
          const names = this.parseNameList("state name");
          const semicolon = this.expect(";");
          for (const name of names) states.push({ name: name.value, terminal: false, span: { start: keyword.span.start, end: semicolon.span.end } });
          end = semicolon.span.end;
          break;
        }
        case "state": {
          const keyword = this.advance();
          const state = this.expectKind("identifier", "state name");
          const terminal = this.match("terminal");
          const semicolon = this.expect(";");
          states.push({
            name: state.value,
            terminal,
            span: { start: keyword.span.start, end: semicolon.span.end }
          });
          end = semicolon.span.end;
          break;
        }
        case "inputs": {
          const keyword = this.advance();
          const names = this.parseNameList("input name");
          const semicolon = this.expect(";");
          for (const name of names) inputs.push({ name: name.value, span: { start: keyword.span.start, end: semicolon.span.end } });
          end = semicolon.span.end;
          break;
        }
        case "input": {
          const keyword = this.advance();
          const input = this.expectKind("identifier", "input name");
          const semicolon = this.expect(";");
          inputs.push({ name: input.value, span: { start: keyword.span.start, end: semicolon.span.end } });
          end = semicolon.span.end;
          break;
        }
        case "outputs": {
          const keyword = this.advance();
          const names = this.parseNameList("output name");
          const semicolon = this.expect(";");
          for (const name of names) outputs.push({ name: name.value, span: { start: keyword.span.start, end: semicolon.span.end } });
          end = semicolon.span.end;
          break;
        }
        case "output": {
          const keyword = this.advance();
          const output = this.expectKind("identifier", "output name");
          const semicolon = this.expect(";");
          outputs.push({ name: output.value, span: { start: keyword.span.start, end: semicolon.span.end } });
          end = semicolon.span.end;
          break;
        }
        case "terminal": {
          this.advance();
          for (const name of this.parseNameList("terminal state name")) this.terminalStates.add(name.value);
          end = this.expect(";").span.end;
          break;
        }
        case "initial": {
          this.advance();
          initialState = this.expectKind("identifier", "initial state").value;
          end = this.expect(";").span.end;
          break;
        }
        case "reset": {
          this.advance();
          resetInput = this.expectKind("identifier", "reset input").value;
          end = this.expect(";").span.end;
          break;
        }
        case "reset_on": {
          this.advance();
          resetInput = this.expectKind("identifier", "reset input").value;
          this.resetOn = true;
          end = this.expect(";").span.end;
          break;
        }
        case "transition": {
          const transition = this.parseTransition(this.advance());
          transitions.push(transition);
          end = transition.span.end;
          break;
        }
        case "emit": {
          const keyword = this.advance();
          const output = this.expectKind("identifier", "output name");
          this.expect("=");
          const expression = this.parseExpression();
          const semicolon = this.expect(";");
          emissions.push({
            name: output.value,
            expression,
            span: { start: keyword.span.start, end: semicolon.span.end }
          });
          end = semicolon.span.end;
          break;
        }
        default:
          if (declaration.kind === "identifier" && this.tokens[this.cursor + 1]?.value === "->") {
            const transition = this.parseTransition(declaration);
            transitions.push(transition);
            end = transition.span.end;
            break;
          }
          throw new GateXParseError(`Unexpected declaration ${JSON.stringify(declaration.value)}`, declaration.span);
      }
    }

    const closing = this.expect("}");
    this.expectKind("eof", "end of source");
    const finalizedStates = states.map((state) => this.terminalStates.has(state.name) ? { ...state, terminal: true } : state);
    const finalizedEmissions = [...emissions];
    const generatedEmissions = new Map<string, Expr[]>();
    for (const transition of transitions) {
      for (const output of transition.emits ?? []) {
        let expression: Expr = {
          kind: "and",
          left: { kind: "state-is", state: transition.from, span: { ...transition.span } },
          right: transition.guard,
          span: { start: transition.span.start, end: transition.span.end }
        };
        if (this.resetOn) {
          const resetGuard: Expr = { kind: "symbol", name: resetInput, span: { ...transition.span } };
          expression = {
            kind: "and",
            left: expression,
            right: { kind: "not", expr: resetGuard, span: { start: transition.span.start, end: transition.span.end } },
            span: { start: transition.span.start, end: transition.span.end }
          };
        }
        const existing = generatedEmissions.get(output) ?? [];
        existing.push(expression);
        generatedEmissions.set(output, existing);
      }
    }
    for (const [name, expressions] of generatedEmissions) {
      const generated = expressions.reduce((left, right) => left === undefined ? right : {
        kind: "or",
        left,
        right,
        span: { start: left.span.start, end: right.span.end }
      } as Expr, undefined as Expr | undefined);
      if (generated === undefined) continue;
      const existing = finalizedEmissions.find((emission) => emission.name === name);
      if (existing !== undefined) {
        existing.expression = {
          kind: "or",
          left: existing.expression,
          right: generated,
          span: { start: existing.span.start, end: generated.span.end }
        };
      } else {
        finalizedEmissions.push({ name, expression: generated, span: generated.span });
      }
    }
    return {
      name: nameToken.value,
      states: finalizedStates,
      inputs,
      outputs,
      initialState,
      resetInput,
      transitions,
      emissions: finalizedEmissions,
      ...(this.resetOn ? { resetOn: true } : {}),
      span: { start: machineToken.span.start, end: closing.span.end || end }
    };
  }

  private parseNameList(description: string): Token[] {
    const names = [this.expectKind("identifier", description)];
    while (this.match(",")) names.push(this.expectKind("identifier", description));
    return names;
  }

  private parseTransition(keyword: Token): MachineAst["transitions"][number] {
    const from = this.expectKind("identifier", "transition source state");
    this.expect("->");
    const to = this.expectKind("identifier", "transition target state");
    this.expectIdentifier("when");
    const guard = this.parseExpression();
    const emits: string[] = [];
    if (this.match("emit")) {
      do {
        emits.push(this.expectKind("identifier", "emitted output name").value);
      } while (this.match(","));
    }
    const semicolon = this.expect(";");
    return {
      from: from.value,
      to: to.value,
      guard,
      ...(emits.length > 0 ? { emits } : {}),
      span: { start: keyword.span.start, end: semicolon.span.end }
    };
  }

  private parseExpression(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let expression = this.parseAnd();
    while (this.match("||")) {
      const right = this.parseAnd();
      expression = { kind: "or", left: expression, right, span: { start: expression.span.start, end: right.span.end } };
    }
    return expression;
  }

  private parseAnd(): Expr {
    let expression = this.parseUnary();
    while (this.match("&&")) {
      const right = this.parseUnary();
      expression = { kind: "and", left: expression, right, span: { start: expression.span.start, end: right.span.end } };
    }
    return expression;
  }

  private parseUnary(): Expr {
    if (this.match("!")) {
      const operand = this.parseUnary();
      return { kind: "not", expr: operand, span: { start: operand.span.start - 1, end: operand.span.end } };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    if (this.match("(")) {
      const expression = this.parseExpression();
      this.expect(")");
      return expression;
    }

    const identifier = this.expectKind("identifier", "boolean expression");
    if (identifier.value === "true" || identifier.value === "false") {
      return { kind: "literal", value: identifier.value === "true", span: identifier.span };
    }

    if (identifier.value === "state" && this.match("==")) {
      const state = this.expectKind("identifier", "state name after state ==");
      return { kind: "state-is", state: state.value, span: { start: identifier.span.start, end: state.span.end } };
    }

    return { kind: "symbol", name: identifier.value, span: identifier.span };
  }

  private peek(): Token {
    return this.tokens[this.cursor] ?? { kind: "eof", value: "<eof>", span: { start: 0, end: 0 } };
  }

  private advance(): Token {
    const token = this.peek();
    this.cursor += 1;
    return token;
  }

  private check(value: string): boolean {
    return this.peek().value === value;
  }

  private match(value: string): boolean {
    if (!this.check(value)) {
      return false;
    }
    this.advance();
    return true;
  }

  private expect(value: string): Token {
    if (!this.check(value)) {
      throw new GateXParseError(`Expected ${JSON.stringify(value)} but found ${JSON.stringify(this.peek().value)}`, this.peek().span);
    }
    return this.advance();
  }

  private expectIdentifier(value: string): Token {
    const token = this.expect(value);
    if (token.kind !== "identifier") {
      throw new GateXParseError(`Expected keyword ${value}`, token.span);
    }
    return token;
  }

  private expectKind(kind: Token["kind"], description: string): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      throw new GateXParseError(`Expected ${description}`, token.span);
    }
    return this.advance();
  }
}

export function parseMachine(source: string): MachineAst {
  return new Parser(tokenize(source)).parse();
}
