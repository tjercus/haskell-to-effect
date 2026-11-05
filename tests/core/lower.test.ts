import { Result } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { lowerModule } from "../../src/core/lower.ts";
import { prettyProgram } from "../../src/core/pretty.ts";
import { parseModule } from "../../src/syntax/parser.ts";

const lines = (...ls: Array<string>): string => ls.join("\n");

const lower = (src: string) => {
  const parsed = parseModule(src);
  if (Result.isFailure(parsed)) throw new Error(`parse failed: ${parsed.failure.message}`);
  return lowerModule(parsed.success);
};

/** Core of a module, rendered for snapshots. */
const core = (...ls: Array<string>): string => {
  const r = lower(lines(...ls));
  if (Result.isFailure(r)) throw new Error(`lowering failed: ${r.failure.message}`);
  return prettyProgram(r.success);
};

const scopeErr = (...ls: Array<string>): string => {
  const r = lower(lines(...ls));
  if (Result.isSuccess(r)) throw new Error("expected a scope error");
  return r.failure.message;
};

describe("lowering to Core", () => {
  test("the example program", () => {
    expect(
      core(
        "data Shape = Circle Int | Rect Int Int",
        "area :: Shape -> Int",
        "area (Circle r) = 3 * r * r",
        "area (Rect w h) = w * h",
        "main :: IO ()",
        "main = do",
        "  name <- getLine",
        '  putStrLn ("Hello, " ++ name)',
        "  print (area (Rect 2 3))",
      ),
    ).toMatchInlineSnapshot(`
      "data Shape = Circle Int | Rect Int Int
      area :: Shape -> Int
      area = \\arg -> match arg {
        (Circle r) -> ((3 * r) * r)
        (Rect w h) -> (w * h)
      }
      main :: IO ()
      main = (getLine >>= (\\name -> ((putStrLn ("Hello, " ++ name)) >> (print (area (Rect 2 3))))))"
    `);
  });

  test("literal patterns fall through to later equations", () => {
    expect(core("fac 0 = 1", "fac n = n * fac (n - 1)")).toMatchInlineSnapshot(`
      "rec {
        fac = \\arg -> match arg {
          0 -> 1
          n -> (n * (fac (n - 1)))
        }
      }"
    `);
  });

  test("guards, otherwise and where", () => {
    expect(
      core(
        "classify n",
        '  | n < 0 = "negative"',
        "  | n == 0 = zero",
        "  | otherwise = big",
        "  where",
        '    zero = "zero"',
        '    big = if n > limit then "big" else "small"',
        "    limit = 100",
      ),
    ).toMatchInlineSnapshot(`
      "classify = \\n -> match {
        where { zero = "zero" } where { limit = 100 } where { big = if (n > limit) then "big" else "small" } | (n < 0) -> "negative" | (n == 0) -> zero | True -> big
      }"
    `);
  });

  test("`| otherwise = e` alone is just `e`", () => {
    expect(core("f x | otherwise = x")).toMatchInlineSnapshot(`"f = \\x -> x"`);
  });

  test("case: nested patterns, lists, tuples, as-patterns; non-variable scrutinee", () => {
    expect(
      core(
        "f xs = case reverse xs of",
        "  [] -> 0",
        "  [x] -> x",
        "  all@(x : y : _) | x > y -> length all",
        "  (_, Just (a, 'c'), \"s\") : _ -> a",
      ),
    ).toMatchInlineSnapshot(`
      "f = \\xs -> let s = reverse xs in match s {
        [] -> 0
        (x : []) -> x
        all@(x_1 : y : _) | (x_1 > y) -> length all
        ((_, Just (a, 'c'), "s") : _) -> a
      }"
    `);
  });

  test("lambdas, sections, negation and short-circuit operators", () => {
    expect(
      core(
        "a = \\x y -> x",
        "b = \\(Just x) -> x",
        "c = (+ 1)",
        "d = (1 -)",
        "e = (`div` 2)",
        "f = - 5",
        "g x = - x",
        "h p q = p && q || not p",
        "i = map (* 2) $ filter even [1, 2, 3]",
        "  where even n = n `mod` 2 == 0",
        "j = (1, 'x', \"str\", ())",
      ),
    ).toMatchInlineSnapshot(`
      "a = \\x y -> x
      b = \\arg -> match arg {
        (Just x_1) -> x_1
      }
      c = \\x_2 -> (x_2 + 1)
      d = (-) 1
      e = \\x_3 -> div x_3 2
      f = -5
      g = \\x_4 -> negate x_4
      h = \\p q -> if if p then q else False then True else not p
      i = let even = \\n -> ((mod n 2) == 0) in map (\\x_5 -> (x_5 * 2)) (filter even (1 : (2 : (3 : []))))
      j = (1, 'x', "str", ())"
    `);
  });

  test("bindings are grouped by dependency (top level and let)", () => {
    expect(
      core(
        "a = b + 1",
        "b = 2",
        "isEven 0 = True",
        "isEven n = isOdd (n - 1)",
        "isOdd 0 = False",
        "isOdd n = isEven (n - 1)",
        "loop = loop",
        "c = let { x = y; y = 1; z = 3 } in x + z",
      ),
    ).toMatchInlineSnapshot(`
      "b = 2
      a = (b + 1)
      rec {
        isEven = \\arg -> match arg {
          0 -> True
          n -> isOdd (n - 1)
        }
        isOdd = \\arg_1 -> match arg_1 {
          0 -> False
          n_1 -> isEven (n_1 - 1)
        }
      }
      rec {
        loop = loop
      }
      c = let y = 1 in let x = y in let z = 3 in (x + z)"
    `);
  });

  test("pattern bindings become a hidden binding plus selectors", () => {
    expect(core("(q, r) = (7 `div` 2, 7 `mod` 2)", "s = q + r")).toMatchInlineSnapshot(`
      "p = (div 7 2, mod 7 2)
      q = match p {
        (q_1, r) -> q_1
      }
      r_1 = match p {
        (q_2, r_2) -> r_2
      }
      s = (q + r_1)"
    `);
  });

  test("do blocks desugar to >>= and >>", () => {
    expect(
      core(
        "main = do",
        "  line <- getLine",
        "  let n = length line",
        "      m = n * 2",
        "  (a, b) <- return (n, m)",
        "  print a",
        "  print b",
      ),
    ).toMatchInlineSnapshot(`
      "main = (getLine >>= (\\line -> let n = length line in let m = (n * 2) in ((return (n, m)) >>= (\\x -> match x {
        (a, b) -> ((print a) >> (print b))
      }))))"
    `);
  });

  test("type signatures and annotations are kept", () => {
    expect(
      core(
        "data Pair a b = Pair a b",
        "swap :: Pair a b -> Pair b a",
        "swap (Pair x y) = Pair y x",
        "n = (1 :: Int)",
      ),
    ).toMatchInlineSnapshot(`
      "data Pair a b = Pair a b
      swap :: Pair a b -> Pair b a
      swap = \\arg -> match arg {
        (Pair x y) -> Pair y x
      }
      n = (1 :: Int)"
    `);
  });

  test("shadowing gets distinct names", () => {
    expect(core("f x = let x = 1 in \\x -> x", "g map = map")).toMatchInlineSnapshot(`
      "f = \\x -> let x_1 = 1 in \\x_2 -> x_2
      g = \\map -> map"
    `);
  });
});

describe("scope errors", () => {
  test.each([
    [["f = y"], /variable not in scope: 'y'/],
    [["f = Foo"], /data constructor not in scope: 'Foo'/],
    [["f (Foo x) = x"], /data constructor not in scope: 'Foo'/],
    [["f :: Foo -> Int", "f x = 1"], /type not in scope: 'Foo'/],
    [["data T = T a"], /type variable not in scope: 'a'/],
    [["data T a a = T a"], /appears twice/],
    [["f 1 = 1", "g = 2", "f 2 = 3"], /multiple declarations of 'f' \(first defined at line 1\)/],
    [["x = 1", "x = 2"], /multiple declarations of 'x'/],
    [["f 1 = 1", "f x y = 2"], /equations for function 'f' have different numbers of arguments/],
    [["f x x = 1"], /conflicting definitions for 'x' in a pattern/],
    [["f = \\(a, a) -> a"], /conflicting definitions for 'a'/],
    [["f (Just x y) = x"], /'Just' should have 1 argument, but has been given 2/],
    [["f Just = 1"], /'Just' should have 1 argument, but has been given 0/],
    [["f :: Int"], /type signature for 'f' lacks an accompanying binding/],
    [["f :: Int", "f :: Int", "f = 1"], /duplicate type signatures for 'f'/],
    [["map = 1"], /'map' is already defined in the Prelude/],
    [["data T = A", "data U = A"], /multiple declarations of the constructor 'A'/],
    [["data T = A | A"], /multiple declarations of the constructor 'A'/],
    [["data Maybe a = M"], /multiple declarations of the type 'Maybe'/],
    [["f = let { x = 1; x = 2 } in x"], /multiple declarations of 'x'/],
    [["f = do", "  x <- getLine", "  print y"], /variable not in scope: 'y'/],
    [["f = x", "  where g = 1"], /variable not in scope: 'x'/],
  ])("%j", (src, message) => {
    expect(scopeErr(...src)).toMatch(message);
  });

  test("errors carry the span of the offending name", () => {
    const r = lower(lines("f = 1", "g = f + y"));
    expect(Result.isFailure(r) && r.failure.span.start).toEqual({ offset: 14, line: 2, col: 9 });
  });

  test("local definitions may shadow the Prelude", () => {
    expect(() => core("f map = map", "g = let filter = 1 in filter")).not.toThrow();
  });
});
