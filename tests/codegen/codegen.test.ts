import { Result } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { compile } from "../../src/compile.ts";

const lines = (...ls: Array<string>): string => ls.join("\n");

const code = (...ls: Array<string>): string => {
  const r = compile(lines(...ls), { fileName: "Main.hs" });
  if (Result.isFailure(r)) throw new Error(r.failure.message);
  return r.success.code;
};

describe("code generation", () => {
  test("polymorphic functions become generic arrow functions with return types", () => {
    expect(code("ident :: a -> a", "ident x = x", "main = print (ident 1)")).toContain(
      "export const ident = <a>(x: a): a => x;",
    );
  });

  test("calls to polymorphic functions get explicit type arguments", () => {
    expect(code("main = print (map (+ 1) [1])")).toContain("rt.map<number, number>(");
  });

  test("polymorphic non-function values use never", () => {
    expect(code("empty = []", "main = print (length empty)")).toContain(
      "export const empty: rt.List<never> = rt.Nil;",
    );
  });

  test("pattern matching compiles to a switch on the tag", () => {
    const c = code("f (Just x) = x", "f Nothing = 0", "main = print (f (Just 1))");
    expect(c).toContain("switch (arg._tag) {");
    expect(c).toContain('case "Nothing": {');
    // The last case of an exhaustive switch is `default`, so every path returns.
    expect(c).toContain("default: {\n      const x = arg.a0;");
    expect(c).not.toContain("patternFail");
  });

  test("an irrefutable last clause needs no pattern-match failure", () => {
    expect(code("f 0 = 1", "f n = n", "main = print (f 2)")).not.toContain("patternFail");
  });

  test("top-level IO actions are suspended", () => {
    expect(code('main = putStrLn "hi"')).toContain(
      "export const main: rt.IO<undefined> = rt.suspend(",
    );
  });

  test("names that are not valid or are reserved in JS are renamed", () => {
    const c = code("f' x = x", "delete x = x", "main = print (f' (delete 1))");
    expect(c).toContain("export const f$p =");
    expect(c).toContain("export const delete_ =");
  });

  test("do blocks become Effect.gen with one statement per line", () => {
    const c = code("main = do", "  name <- getLine", '  putStrLn ("Hi " ++ name)', "  return ()");
    expect(c).toContain('import { Effect } from "effect";');
    expect(c).toContain("export const main: rt.IO<undefined> = Effect.gen(function* () {");
    expect(c).toContain("  const name: rt.List<rt.Char> = yield* rt.getLine;");
    expect(c).toContain('  yield* rt.putStrLn(rt.appendList(rt.str("Hi "), name));');
    expect(c).toContain("  return undefined;");
  });

  test("modules without do blocks do not import Effect", () => {
    expect(code('main = putStrLn "hi"')).not.toContain('from "effect"');
  });

  test("a user constructor named Effect does not clash with the import", () => {
    const c = code("data Effect = Effect", "main = do { print 1; print 2 }");
    expect(c).toContain('import { Effect as Effect$ } from "effect";');
    expect(c).toContain("Effect$.gen(");
  });
});

describe("tail calls", () => {
  test("a self tail call becomes a loop iteration", () => {
    const c = code(
      "count acc 0 = acc",
      "count acc n = count (acc + 1) (n - 1)",
      "main = print (count 0 5)",
    );
    expect(c).toContain("for (;;) {");
    expect(c).toContain("continue;");
    expect(c).not.toMatch(/return count\(/);
  });

  test("calls that are not in tail position are left alone", () => {
    const c = code("len [] = 0", "len (_:xs) = 1 + len xs", "main = print (len [1])");
    expect(c).not.toContain("for (;;)");
  });

  test("tail calls through || and if are found", () => {
    const c = code(
      "anyOf _ [] = False",
      "anyOf p (x:xs) = p x || anyOf p xs",
      "main = print (anyOf not [True])",
    );
    expect(c).toContain("for (;;) {");
  });

  test("polymorphic recursion at another type is not a loop iteration", () => {
    const c = code(
      "f :: Int -> a -> Int",
      "f 0 _ = 0",
      "f n x = f (n - 1) [x]",
      "main = print (f 3 'c')",
    );
    expect(c).not.toContain("for (;;)");
  });

  test("recursion inside Effect.gen is left alone (it is already stack-safe)", () => {
    const c = code("loop 0 = return ()", "loop n = do { print n; loop (n - 1) }", "main = loop 3");
    expect(c).not.toContain("for (;;)");
  });
});

describe("mutual recursion", () => {
  test("tail calls between functions are merged into one loop", () => {
    const c = code(
      "isEven 0 = True",
      "isEven n = isOdd (n - 1)",
      "isOdd 0 = False",
      "isOdd n = isEven (n - 1)",
      "main = print (isEven 4)",
    );
    expect(c).toContain(
      "const isEven$isOdd$loop = (call: { readonly fn: 0; readonly a: readonly [number] }",
    );
    expect(c).toContain("call = { fn: 1, a: [(n - 1)] };");
    expect(c).toContain(
      "export const isEven = (arg$in: number): boolean => isEven$isOdd$loop({ fn: 0, a: [arg$in] });",
    );
  });

  test("type variables from separate signatures are identified through the tail calls", () => {
    const c = code(
      "keep :: [a] -> [a] -> [a]",
      "keep acc [] = acc",
      "keep acc (x:xs) = skip (x : acc) xs",
      "skip :: [b] -> [b] -> [b]",
      "skip acc [] = acc",
      "skip acc (_:xs) = keep acc xs",
      "main = print (keep [] [1])",
    );
    expect(c).toMatch(/const keep\$skip\$loop = <a>\(call: /);
    expect(c).toContain("export const skip = <a>(");
  });

  test("groups without tail calls between members are left alone", () => {
    const c = code(
      "ping 0 = 0",
      "ping n = 1 + pong (n - 1)",
      "pong 0 = 0",
      "pong n = 1 + ping (n - 1)",
      "main = print (ping 2)",
    );
    expect(c).not.toContain("$loop");
  });
});
