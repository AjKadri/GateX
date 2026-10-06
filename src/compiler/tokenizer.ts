import type { SourceSpan } from "./types.js";

export type TokenKind = "identifier" | "symbol" | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  span: SourceSpan;
}

export class GateXSyntaxError extends Error {
  constructor(message: string, public readonly span: SourceSpan) {
    super(`${message} at ${span.start}`);
    this.name = "GateXSyntaxError";
  }
}

const TWO_CHARACTER_SYMBOLS = new Set(["->", "&&", "||", "==", "!="]);
const ONE_CHARACTER_SYMBOLS = new Set(["{", "}", ";", ",", "(", ")", "=", "!", "."]);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const character = source[cursor];
    if (character === undefined) {
      break;
    }

    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }

    if (character === "/" && source[cursor + 1] === "/") {
      cursor += 2;
      while (cursor < source.length && source[cursor] !== "\n") {
        cursor += 1;
      }
      continue;
    }

    const twoCharacter = source.slice(cursor, cursor + 2);
    if (TWO_CHARACTER_SYMBOLS.has(twoCharacter)) {
      tokens.push({ kind: "symbol", value: twoCharacter, span: { start: cursor, end: cursor + 2 } });
      cursor += 2;
      continue;
    }

    if (ONE_CHARACTER_SYMBOLS.has(character)) {
      tokens.push({ kind: "symbol", value: character, span: { start: cursor, end: cursor + 1 } });
      cursor += 1;
      continue;
    }

    if (/[A-Za-z_]/.test(character)) {
      const start = cursor;
      cursor += 1;
      while (cursor < source.length && /[A-Za-z0-9_]/.test(source[cursor] ?? "")) {
        cursor += 1;
      }
      tokens.push({ kind: "identifier", value: source.slice(start, cursor), span: { start, end: cursor } });
      continue;
    }

    throw new GateXSyntaxError(`Unexpected character ${JSON.stringify(character)}`, {
      start: cursor,
      end: cursor + 1
    });
  }

  tokens.push({ kind: "eof", value: "<eof>", span: { start: source.length, end: source.length } });
  return tokens;
}
