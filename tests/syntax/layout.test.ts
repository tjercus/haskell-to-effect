import { Result } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { type LayoutMode, layoutAll } from "../../src/syntax/layout.ts";
import { lex } from "../../src/syntax/lexer.ts";
import { parseErr, parseOk, stripSpans } from "./helpers.ts";

/** Token texts after layout, with virtual braces and semicolons rendered like explicit ones. */
const render = (src: string, mode: LayoutMode = "module"): string => {
  const tokens = lex(src);
  if (Result.isFailure(tokens)) throw new Error(tokens.failure.message);
  return layoutAll(tokens.success, mode)
    .filter((t) => t._tag !== "EOF")
    .map((t) => t.text)
    .join(" ");
};

const lines = (...ls: Array<string>): string => ls.join("\n");

describe("layout algorithm (no parser feedback)", () => {
  test("top-level declarations in a module without a header", () => {
    expect(render(lines("f = 1", "g = 2"))).toBe("{ f = 1 ; g = 2 }");
  });

  test("module header: the block opens after `where`", () => {
    expect(render(lines("module Main where", "f = 1", "g = 2"))).toBe(
      "module Main where { f = 1 ; g = 2 }",
    );
  });

  test("continuation lines are indented further", () => {
    expect(render(lines("f = a", "  + b", "g = c"))).toBe("{ f = a + b ; g = c }");
  });

  test("let block closes when a line is indented less", () => {
    expect(render(lines("let x = 1", "    y = 2", "in x"), "expression")).toBe(
      "let { x = 1 ; y = 2 } in x",
    );
  });

  test("nested do and case blocks", () => {
    const src = lines(
      "f x = case x of",
      "  Just y -> do",
      "    a",
      "    b",
      "  Nothing -> c",
      "g = 1",
    );
    expect(render(src)).toBe(
      "{ f x = case x of { Just y -> do { a ; b } ; Nothing -> c } ; g = 1 }",
    );
  });

  test("where blocks", () => {
    const src = lines("f = x + y", "  where x = 1", "        y = 2", "g = 3");
    expect(render(src)).toBe("{ f = x + y where { x = 1 ; y = 2 } ; g = 3 }");
  });

  test("a block's column is that of its first token, not of the keyword", () => {
    const src = lines("f = do a", "       b", "g = 1");
    expect(render(src)).toBe("{ f = do { a ; b } ; g = 1 }");
  });

  test("explicit braces switch layout off inside them", () => {
    const src = lines("f = let { x = 1;", "y = 2 } in x");
    expect(render(src)).toBe("{ f = let { x = 1 ; y = 2 } in x }");
  });

  test("a block that is not indented further is empty", () => {
    expect(render(lines("f = do", "g = 1"))).toBe("{ f = do { } ; g = 1 }");
  });

  test("a layout keyword at end of input opens an empty block", () => {
    expect(render("f = do")).toBe("{ f = do { } }");
  });

  test("tabs count to the next multiple of 8", () => {
    expect(render(lines("f = do", "\ta", "        b"))).toBe("{ f = do { a ; b } }");
  });

  test("comments and blank lines do not affect layout", () => {
    const src = lines("f = do", "  a -- comment", "", "  {- block -}", "  b");
    expect(render(src)).toBe("{ f = do { a ; b } }");
  });

  test("empty input", () => {
    expect(render("")).toBe("{ }");
  });
});

/** The layout version must parse exactly like the explicitly braced version. */
const sameAs = (layout: string, braced: string): void => {
  expect(stripSpans(parseOk(layout))).toEqual(stripSpans(parseOk(braced)));
};

describe("layout in the parser", () => {
  test("multi-line let", () => {
    sameAs(lines("let x = 1", "    y = 2", "in x + y"), "let { x = 1; y = 2 } in x + y");
  });

  test("`in` indented less than the bindings but more than `let`", () => {
    sameAs(lines("let f x = x * 2", "    g = f 3", " in g"), "let { f x = x * 2; g = f 3 } in g");
  });

  test("continuation lines inside a binding", () => {
    sameAs(lines("let x = 1 +", "      2", "    y = 3", "in x"), "let { x = 1 + 2; y = 3 } in x");
  });

  test("explicit semicolons inside an implicit block", () => {
    sameAs("let x = 1; y = 2 in x", "let { x = 1; y = 2 } in x");
  });

  describe("parse-error(t): a token that cannot continue the block closes it", () => {
    test("`in` on the same line", () => {
      sameAs("let x = 1 in x", "let { x = 1 } in x");
    });

    test("`in` at the same column as the bindings", () => {
      sameAs(lines("let x = 1", "    in x"), "let { x = 1 } in x");
    });

    test("closing parenthesis and comma", () => {
      sameAs("(let x = 1 in x, 2)", "(let { x = 1 } in x, 2)");
      sameAs("[let x = 1 in x]", "[let { x = 1 } in x]");
    });

    test("an inner block closed by `in` stays closed for later lines", () => {
      sameAs(
        lines("let a = let b = 1 in b", "    c = 2", "in a + c"),
        "let { a = let { b = 1 } in b; c = 2 } in a + c",
      );
    });

    test("a line at the closed block's column continues the enclosing binding", () => {
      // After `in` closes the inner block, `+ 2` (column 15) is a continuation of `foo`.
      sameAs(
        lines("let foo = let a = 1 in a", "              + 2", "in foo"),
        "let { foo = let { a = 1 } in a + 2 } in foo",
      );
    });

    test("if/then/else across lines inside a binding", () => {
      sameAs(
        lines("let x = if a", "        then 1", "        else 2", "in x"),
        "let { x = if a then 1 else 2 } in x",
      );
    });
  });

  describe("errors", () => {
    test("a binding indented less than the block ends it", () => {
      expect(parseErr(lines("let x = 1", "  y = 2", "in x"))).toMatch(
        /unexpected 'y', expected 'in'/,
      );
    });

    test("virtual tokens are described in error messages", () => {
      expect(parseErr(lines("let x = 1", "    y", "in x"))).toMatch(
        /unexpected the end of an indented block, expected '='/,
      );
    });

    test("an unclosed explicit block", () => {
      expect(parseErr("let { x = 1")).toMatch(/unexpected end of input, expected ';' or '}'/);
    });
  });
});
