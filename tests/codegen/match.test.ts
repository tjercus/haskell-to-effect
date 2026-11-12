import { Result } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { type Compiled, compile } from "../../src/compile.ts";

const lines = (...ls: Array<string>): string => ls.join("\n");

const compiled = (...ls: Array<string>): Compiled => {
  const r = compile(lines(...ls, "main = return ()"), { fileName: "Main.hs" });
  if (Result.isFailure(r)) {
    throw new Error(r.failure.message);
  }
  return r.success;
};

const warnings = (...ls: Array<string>): Array<string> =>
  compiled(...ls).warnings.map((w) => w.message);

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("exhaustiveness and redundancy warnings", () => {
  test("a missing constructor is named", () => {
    expect(warnings("data Color = Red | Green | Blue", "name Red = 1", "name Green = 2")).toEqual([
      "pattern match is non-exhaustive in function 'name'; patterns not matched: Blue",
    ]);
  });

  test("missing nested patterns", () => {
    expect(warnings("f (Just []) = 0", "f Nothing = 1")).toEqual([
      "pattern match is non-exhaustive in function 'f'; patterns not matched: Just (_ : _)",
    ]);
    expect(warnings("g [] = 0", "g [x] = x")).toEqual([
      "pattern match is non-exhaustive in function 'g'; patterns not matched: _ : (_ : _)",
    ]);
  });

  test("several arguments", () => {
    expect(warnings("h True False = 0", "h False _ = 1")).toEqual([
      "pattern match is non-exhaustive in function 'h'; patterns not matched: True True",
    ]);
  });

  test("literals and guards without otherwise", () => {
    expect(warnings("f 0 = 1", "f 1 = 2")).toEqual([
      "pattern match is non-exhaustive in function 'f'; patterns not matched: _",
    ]);
    expect(warnings("f n | n > 0 = 1")).toEqual([
      "pattern match is non-exhaustive in function 'f'; patterns not matched: _",
    ]);
  });

  test("case expressions and lambdas", () => {
    expect(warnings("f m = case m of { Just x -> x }")).toEqual([
      "pattern match is non-exhaustive in case expression; patterns not matched: Nothing",
    ]);
    expect(warnings("f = \\(Left x) -> x")).toEqual([
      "pattern match is non-exhaustive in lambda; patterns not matched: Right _",
    ]);
  });

  test("redundant clauses", () => {
    const w = compiled("f _ = 0", "f True = 1").warnings;
    expect(w.map((x) => x.message)).toEqual([
      "pattern match is redundant in function 'f': this clause can never match",
    ]);
    expect(w[0]?.span.start.line).toBe(2);
  });

  test("complete matches have no warnings", () => {
    expect(
      warnings(
        "data T = A | B Int",
        "f A = 0",
        "f (B 0) = 1",
        "f (B n) = n",
        "g [] = 0",
        "g (x:xs) = x",
        "h (a, b) = a + b",
        "k n | n > 0 = 1 | otherwise = 0",
        's "a" = 1',
        "s _ = 2",
      ),
    ).toEqual([]);
  });

  test("do-block patterns are not reported (they fail in IO)", () => {
    expect(warnings("f = do { Just x <- return Nothing; print (x + 1) }")).toEqual([]);
  });
});

describe("decision trees", () => {
  test("each value is tested once", () => {
    const { code } = compiled("f [] = 0", "f [x] = x", "f (x:y:_) = x + y");
    expect(count(code, "switch (arg._tag)")).toBe(1);
    expect(count(code, "switch (arg.tail._tag)")).toBe(1);
  });

  test("a clause reached from several leaves becomes a join point", () => {
    const { code } = compiled("both True True = 1", "both _ _ = 0");
    expect(code).toContain("const clause2 = (): number => {");
    expect(count(code, "return clause2();")).toBe(2);
  });

  test("a guarded join point gets a continuation for when its guards fail", () => {
    // Clause 2 is reached both when `a` is True (and `b` is not) and when `a` is False.
    const { code } = compiled("f True True = 1", "f _ b | b = 2", "f _ _ = 3");
    expect(code).toContain("const clause2 = (b: boolean, fail: () => number): number => {");
    expect(count(code, "return clause2(")).toBe(2);
    expect(code).toContain("return clause3();");
  });

  test("string literals are matched character by character", () => {
    const { code } = compiled('f "ab" = 1', "f ('a':_) = 2", "f _ = 3");
    expect(code).toContain('arg.head === "a"');
    expect(code).toContain('arg.tail.head === "b"');
    expect(code).not.toContain("rt.equals");
  });
});
