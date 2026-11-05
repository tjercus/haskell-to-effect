import { Result } from "effect";
import { LexError } from "../errors.ts";
import { type Pos, span } from "./span.ts";
import { type Token, reservedIds, reservedOps } from "./token.ts";

const isSymbolChar = (c: string): boolean => "!#$%&*+./<=>?@\\^|-~:".includes(c);
const isSpecialChar = (c: string): boolean => "(),;[]`{}".includes(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isHexDigit = (c: string): boolean => /^[0-9a-fA-F]$/.test(c);
const isOctDigit = (c: string): boolean => c >= "0" && c <= "7";
const isLower = (c: string): boolean => c === "_" || /^\p{Ll}$/u.test(c);
const isUpper = (c: string): boolean => /^\p{Lu}$/u.test(c);
const isIdentChar = (c: string): boolean => c === "'" || c === "_" || /^[\p{L}\p{N}]$/u.test(c);
const isWhite = (c: string): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";

const charEscapes: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  '"': '"',
  "'": "'",
};

/** Haskell 2010 lexer (minus qualified names, floats and some escapes). */
class Lexer {
  private offset = 0;
  private line = 1;
  private col = 1;
  private readonly tokens: Array<Token> = [];

  constructor(private readonly src: string) {}

  run(): Array<Token> {
    for (;;) {
      this.skipWhitespaceAndComments();
      if (this.atEnd()) break;
      this.lexToken();
    }
    const here = this.pos();
    this.tokens.push({ _tag: "EOF", text: "", span: span(here, here) });
    return this.tokens;
  }

  // ---- position handling -------------------------------------------------

  private pos(): Pos {
    return { offset: this.offset, line: this.line, col: this.col };
  }

  private atEnd(): boolean {
    return this.offset >= this.src.length;
  }

  private peek(ahead = 0): string {
    return this.src[this.offset + ahead] ?? "";
  }

  private advance(): string {
    const c = this.src[this.offset++] ?? "";
    if (c === "\n" || (c === "\r" && this.peek() !== "\n")) {
      this.line++;
      this.col = 1;
    } else if (c === "\t") {
      this.col += 8 - ((this.col - 1) % 8);
    } else if (c !== "\r") {
      this.col++;
    }
    return c;
  }

  private error(message: string, start: Pos, end: Pos = this.pos()): LexError {
    return new LexError({ message, span: span(start, end) });
  }

  // ---- whitespace & comments ---------------------------------------------

  private skipWhitespaceAndComments(): void {
    for (;;) {
      const c = this.peek();
      if (isWhite(c)) {
        this.advance();
      } else if (c === "-" && this.peek(1) === "-" && this.isLineComment()) {
        while (!this.atEnd() && this.peek() !== "\n" && this.peek() !== "\r") this.advance();
      } else if (c === "{" && this.peek(1) === "-") {
        this.skipBlockComment();
      } else {
        return;
      }
    }
  }

  /** `--` starts a comment only if the whole symbol run is dashes (so `-->` is an operator). */
  private isLineComment(): boolean {
    let i = this.offset;
    while (this.src[i] === "-") i++;
    const next = this.src[i] ?? "";
    return !isSymbolChar(next);
  }

  private skipBlockComment(): void {
    const start = this.pos();
    this.advance();
    this.advance();
    let depth = 1;
    while (depth > 0) {
      if (this.atEnd()) throw this.error("unterminated block comment", start);
      if (this.peek() === "{" && this.peek(1) === "-") {
        this.advance();
        this.advance();
        depth++;
      } else if (this.peek() === "-" && this.peek(1) === "}") {
        this.advance();
        this.advance();
        depth--;
      } else {
        this.advance();
      }
    }
  }

  // ---- tokens ------------------------------------------------------------

  private lexToken(): void {
    const start = this.pos();
    const c = this.peek();

    if (isSpecialChar(c)) {
      this.advance();
      this.push({ _tag: "Special", text: c, span: span(start, this.pos()) });
    } else if (isLower(c)) {
      const text = this.takeWhile(isIdentChar);
      const s = span(start, this.pos());
      this.push(
        reservedIds.has(text)
          ? { _tag: "ReservedId", text, span: s }
          : { _tag: "VarId", text, span: s },
      );
    } else if (isUpper(c)) {
      const text = this.takeWhile(isIdentChar);
      if (this.peek() === "." && (isIdentChar(this.peek(1)) || isSymbolChar(this.peek(1)))) {
        throw this.error(`qualified names are not supported (found '${text}.')`, start, this.pos());
      }
      this.push({ _tag: "ConId", text, span: span(start, this.pos()) });
    } else if (isSymbolChar(c)) {
      const text = this.takeWhile(isSymbolChar);
      const s = span(start, this.pos());
      if (reservedOps.has(text)) this.push({ _tag: "ReservedOp", text, span: s });
      else if (text.startsWith(":")) this.push({ _tag: "ConSym", text, span: s });
      else this.push({ _tag: "VarSym", text, span: s });
    } else if (isDigit(c)) {
      this.lexNumber(start);
    } else if (c === "'") {
      this.lexChar(start);
    } else if (c === '"') {
      this.lexString(start);
    } else {
      this.advance();
      throw this.error(`unexpected character '${c}'`, start);
    }
  }

  private push(t: Token): void {
    this.tokens.push(t);
  }

  private takeWhile(pred: (c: string) => boolean): string {
    const begin = this.offset;
    while (!this.atEnd() && pred(this.peek())) this.advance();
    return this.src.slice(begin, this.offset);
  }

  private lexNumber(start: Pos): void {
    let value: number;
    const base = this.peek() === "0" ? this.peek(1).toLowerCase() : "";
    if ((base === "x" && isHexDigit(this.peek(2))) || (base === "o" && isOctDigit(this.peek(2)))) {
      this.advance();
      this.advance();
      const digits = this.takeWhile(base === "x" ? isHexDigit : isOctDigit);
      value = Number.parseInt(digits, base === "x" ? 16 : 8);
    } else {
      const digits = this.takeWhile(isDigit);
      if (this.peek() === "." && isDigit(this.peek(1))) {
        this.advance();
        this.takeWhile(isDigit);
        throw this.error("floating-point literals are not supported", start);
      }
      if ((this.peek() === "e" || this.peek() === "E") && isDigit(this.peek(1))) {
        throw this.error("floating-point literals are not supported", start);
      }
      value = Number(digits);
    }
    if (!Number.isSafeInteger(value)) {
      throw this.error("integer literal is too large (Int is limited to 53 bits)", start);
    }
    const s = span(start, this.pos());
    this.push({ _tag: "Int", text: this.src.slice(start.offset, s.end.offset), value, span: s });
  }

  private lexChar(start: Pos): void {
    this.advance(); // opening '
    if (this.peek() === "'") {
      this.advance();
      throw this.error("empty character literal", start);
    }
    const value = this.lexCharBody(start, "char");
    if (value === undefined) throw this.error("'\\&' is not allowed in a character literal", start);
    if (this.peek() !== "'") throw this.error("unterminated character literal", start);
    this.advance();
    const s = span(start, this.pos());
    this.push({ _tag: "Char", text: this.src.slice(start.offset, s.end.offset), value, span: s });
  }

  private lexString(start: Pos): void {
    this.advance(); // opening "
    let value = "";
    for (;;) {
      const c = this.peek();
      if (this.atEnd() || c === "\n" || c === "\r")
        throw this.error("unterminated string literal", start);
      if (c === '"') break;
      if (c === "\\" && isWhite(this.peek(1))) {
        this.skipStringGap(start);
        continue;
      }
      value += this.lexCharBody(start, "string") ?? "";
    }
    this.advance(); // closing "
    const s = span(start, this.pos());
    this.push({ _tag: "String", text: this.src.slice(start.offset, s.end.offset), value, span: s });
  }

  /** `\ <whitespace> \` inside a string is ignored. */
  private skipStringGap(litStart: Pos): void {
    this.advance();
    while (isWhite(this.peek())) this.advance();
    if (this.peek() !== "\\")
      throw this.error("invalid string gap: expected '\\' after whitespace", litStart);
    this.advance();
  }

  /** One (possibly escaped) character. Returns `undefined` for the empty escape `\&`. */
  private lexCharBody(litStart: Pos, kind: "char" | "string"): string | undefined {
    const c = this.peek();
    if (this.atEnd() || c === "\n" || c === "\r")
      throw this.error(`unterminated ${kind} literal`, litStart);
    if (c !== "\\") {
      const cp = this.src.codePointAt(this.offset) ?? 0;
      const ch = String.fromCodePoint(cp);
      for (let i = 0; i < ch.length; i++) this.advance();
      return ch;
    }
    const escStart = this.pos();
    this.advance(); // backslash
    const e = this.peek();
    const simple = charEscapes[e];
    if (simple !== undefined) {
      this.advance();
      return simple;
    }
    if (e === "&") {
      this.advance();
      return undefined;
    }
    let digits: string;
    let radix: number;
    if (isDigit(e)) {
      digits = this.takeWhile(isDigit);
      radix = 10;
    } else if (e === "x" && isHexDigit(this.peek(1))) {
      this.advance();
      digits = this.takeWhile(isHexDigit);
      radix = 16;
    } else if (e === "o" && isOctDigit(this.peek(1))) {
      this.advance();
      digits = this.takeWhile(isOctDigit);
      radix = 8;
    } else {
      if (!this.atEnd()) this.advance();
      throw this.error(`unsupported escape sequence '\\${e}'`, escStart);
    }
    const cp = Number.parseInt(digits, radix);
    if (cp > 0x10ffff) throw this.error("character code is out of range", escStart);
    return String.fromCodePoint(cp);
  }
}

/** Splits Haskell source text into tokens, ending with an `EOF` token. */
export const lex = (source: string): Result.Result<ReadonlyArray<Token>, LexError> => {
  try {
    return Result.succeed(new Lexer(source).run());
  } catch (e) {
    if (e instanceof LexError) return Result.fail(e);
    throw e;
  }
};
