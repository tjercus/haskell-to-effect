import { Result } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { lex } from "../../src/syntax/lexer.ts";
import type { Token } from "../../src/syntax/token.ts";

const tokens = (src: string): Array<Token> => {
  const r = lex(src);
  if (Result.isFailure(r)) {
    throw new Error(r.failure.message);
  }
  return [...r.success];
};

/** `Tag:text` for every token except EOF. */
const kinds = (src: string): Array<string> =>
  tokens(src)
    .filter((t) => t._tag !== "EOF")
    .map((t) => `${t._tag}:${t.text}`);

const lexErr = (src: string): string => {
  const r = lex(src);
  if (Result.isSuccess(r)) {
    throw new Error(`expected a lex error for: ${src}`);
  }
  return r.failure.message;
};

describe("lexer", () => {
  test("identifiers, keywords and specials", () => {
    expect(kinds("let x' = Just y_1 in (f, [x])")).toEqual([
      "ReservedId:let",
      "VarId:x'",
      "ReservedOp:=",
      "ConId:Just",
      "VarId:y_1",
      "ReservedId:in",
      "Special:(",
      "VarId:f",
      "Special:,",
      "Special:[",
      "VarId:x",
      "Special:]",
      "Special:)",
    ]);
  });

  test("operators: reserved, varsym and consym, with maximal munch", () => {
    expect(kinds("a -> b <- c :: d .. e : f :+ g >>= h `div` i \\ j")).toEqual([
      "VarId:a",
      "ReservedOp:->",
      "VarId:b",
      "ReservedOp:<-",
      "VarId:c",
      "ReservedOp:::",
      "VarId:d",
      "ReservedOp:..",
      "VarId:e",
      "ReservedOp::",
      "VarId:f",
      "ConSym::+",
      "VarId:g",
      "VarSym:>>=",
      "VarId:h",
      "Special:`",
      "VarId:div",
      "Special:`",
      "VarId:i",
      "ReservedOp:\\",
      "VarId:j",
    ]);
  });

  test("line comments, including dash runs; `-->` is an operator", () => {
    expect(kinds("a -- comment\nb --- more\nc --> d")).toEqual([
      "VarId:a",
      "VarId:b",
      "VarId:c",
      "VarSym:-->",
      "VarId:d",
    ]);
  });

  test("nested block comments", () => {
    expect(kinds("a {- outer {- inner -} still -} b")).toEqual(["VarId:a", "VarId:b"]);
    expect(lexErr("a {- never closed")).toMatch(/unterminated block comment/);
  });

  test("integer literals", () => {
    const ints = tokens("0 42 0x1F 0o17").flatMap((t) => (t._tag === "Int" ? [t.value] : []));
    expect(ints).toEqual([0, 42, 31, 15]);
    expect(lexErr("1.5")).toMatch(/floating-point/);
    expect(lexErr("99999999999999999999")).toMatch(/too large/);
  });

  test("character and string literals with escapes", () => {
    const values = tokens(
      String.raw`'a' '\n' '\'' '\65' '\x41' "hi\t\"there\"" "a\&b" "\1234\&5"`,
    ).flatMap((t) => (t._tag === "Char" || t._tag === "String" ? [t.value] : []));
    expect(values).toEqual(["a", "\n", "'", "A", "A", 'hi\t"there"', "ab", "Ӓ5"]);
  });

  test("string gaps", () => {
    const [t] = tokens('"hello \\\n    \\world"');
    expect(t?._tag === "String" && t.value).toBe("hello world");
  });

  test("literal errors", () => {
    expect(lexErr('"abc')).toMatch(/unterminated string/);
    expect(lexErr("''")).toMatch(/empty character/);
    expect(lexErr("'ab'")).toMatch(/unterminated character/);
    expect(lexErr(String.raw`"\q"`)).toMatch(/unsupported escape/);
  });

  test("qualified names are rejected", () => {
    expect(lexErr("Data.List.map")).toMatch(/qualified names are not supported/);
  });

  test("source positions, with tabs at 8-column stops", () => {
    const [a, b, c] = tokens("a\n\tb  c");
    expect(a?.span.start).toEqual({ offset: 0, line: 1, col: 1 });
    expect(b?.span.start).toEqual({ offset: 3, line: 2, col: 9 });
    expect(c?.span.start).toEqual({ offset: 6, line: 2, col: 12 });
    expect(c?.span.end).toEqual({ offset: 7, line: 2, col: 13 });
  });

  test("ends with EOF", () => {
    expect(tokens("").map((t) => t._tag)).toEqual(["EOF"]);
  });
});
