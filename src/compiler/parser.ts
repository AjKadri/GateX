import { GateXSyntaxError, tokenize, type Token } from "./tokenizer.js";
import type { Expr, MachineAst, SourceSpan } from "./types.js";

export class GateXParseError extends GateXSyntaxError {
  name = "GateXParseError";
}

class Parser {
  private cursor = 0;

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
        case "input": {
          const keyword = this.advance();
          const input = this.expectKind("identifier", "input name");
          const semicolon = this.expect(";");
          inputs.push({ name: input.value, span: { start: keyword.span.start, end: semicolon.span.end } });
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
        case "transition": {
          const keyword = this.advance();
          const from = this.expectKind("identifier", "transition source state");
          this.expect("->");
          const to = this.expectKind("identifier", "transition target state");
          this.expectIdentifier("when");
          const guard = this.parseExpression();
          const semicolon = this.expect(";");
          transitions.push({
            from: from.value,
            to: to.value,
            guard,
            span: { start: keyword.span.start, end: semicolon.span.end }
          });
          end = semicolon.span.end;
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
          throw new GateXParseError(`Unexpected declaration ${JSON.stringify(declaration.value)}`, declaration.span);
      }
    }

    const closing = this.expect("}");
    this.expectKind("eof", "end of source");
    return {
      name: nameToken.value,
      states,
      inputs,
      outputs,
      initialState,
      resetInput,
      transitions,
      emissions,
      span: { start: machineToken.span.start, end: closing.span.end || end }
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

