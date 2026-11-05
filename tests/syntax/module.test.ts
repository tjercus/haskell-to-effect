import { Result } from "effect";
import { describe, expect, test } from "vite-plus/test";
import type { Module } from "../../src/syntax/ast.ts";
import { parseModule } from "../../src/syntax/parser.ts";
import { prettyModule } from "../../src/syntax/pretty.ts";
import { parseErr, parseOk, sexpr, stripSpans } from "./helpers.ts";

const lines = (...ls: Array<string>): string => ls.join("\n");

const moduleOk = (src: string): Module => {
  const r = parseModule(src);
  if (Result.isFailure(r)) throw new Error(`parse failed: ${r.failure.message}`);
  return r.success;
};

const moduleErr = (src: string): string => {
  const r = parseModule(src);
  if (Result.isSuccess(r)) throw new Error(`expected a parse error for: ${src}`);
  return r.failure.message;
};

/** Parses with layout, checks the explicitly braced rendering, and checks it round-trips. */
const braced = (src: string, expected: string): void => {
  const m = moduleOk(src);
  const printed = prettyModule(m);
  expect(printed).toBe(expected);
  expect(stripSpans(moduleOk(printed))).toEqual(stripSpans(m));
};

describe("modules", () => {
  test("the example program from the plan", () => {
    braced(
      lines(
        "module Main where",
        "",
        "data Shape = Circle Int | Rect Int Int",
        "",
        "area :: Shape -> Int",
        "area (Circle r) = 3 * r * r",
        "area (Rect w h) = w * h",
        "",
        "main :: IO ()",
        "main = do",
        "  name <- getLine",
        '  putStrLn ("Hello, " ++ name)',
        "  print (area (Rect 2 3))",
      ),
      "module Main where { data Shape = Circle Int | Rect Int Int; area :: Shape -> Int; " +
        "area (Circle r) = 3 * r * r; area (Rect w h) = w * h; main :: IO (); " +
        'main = do { name <- getLine; putStrLn ("Hello, " ++ name); print (area (Rect 2 3)) } }',
    );
  });

  test("no header", () => {
    const m = moduleOk(lines("x = 1", "y = 2"));
    expect(m.name).toBeUndefined();
    expect(m.decls).toHaveLength(2);
  });

  test("export list", () => {
    const m = moduleOk(
      lines("module Main (main, Shape(..), Tree(Leaf, Node), (<+>)) where", "main = main"),
    );
    expect(m.name).toBe("Main");
    expect(m.exports).toEqual(["main", "Shape", "Tree", "<+>"]);
  });

  test("empty module", () => {
    expect(moduleOk("module Main where").decls).toEqual([]);
    expect(moduleOk("").decls).toEqual([]);
  });
});

describe("guards and where", () => {
  test("guarded equations with a where block", () => {
    braced(
      lines(
        "classify :: Int -> String",
        "classify n",
        '  | n < 0 = "negative"',
        '  | n == 0 = "zero"',
        "  | otherwise = big n",
        "  where",
        '    big m = if m > 100 then "big" else "small"',
        "    limit = 100",
      ),
      '{ classify :: Int -> String; classify n | n < 0 = "negative" | n == 0 = "zero" | ' +
        'otherwise = big n where { big m = if m > 100 then "big" else "small"; limit = 100 } }',
    );
  });

  test("where on a pattern binding and nested where", () => {
    braced(
      lines("(a, b) = (x, y)", "  where x = f 1", "          where f n = n", "        y = 2"),
      "{ (a, b) = (x, y) where { x = f 1 where { f n = n }; y = 2 } }",
    );
  });
});

describe("case", () => {
  test("alternatives with nested patterns, guards and where", () => {
    braced(
      lines(
        "f xs = case xs of",
        "  [] -> 0",
        "  (x:rest)",
        "    | x > 0 -> x + r",
        "    | otherwise -> r",
        "    where r = f rest",
        "  [_, Just (a, b)] -> -1",
      ),
      "{ f xs = case xs of { [] -> 0; x : rest | x > 0 -> x + r | otherwise -> r where { r = f rest }; " +
        "[_, Just (a, b)] -> - 1 } }",
    );
  });

  test("negative literal and string patterns", () => {
    braced(
      lines("g n = case n of", '  -1 -> "minus one"', '  _ -> "other"'),
      '{ g n = case n of { -1 -> "minus one"; _ -> "other" } }',
    );
  });

  test("case on one line, closed by the parse-error rule", () => {
    expect(sexpr(parseOk("(case x of A -> 1, 2)"))).toBe("(tuple (case x [A -> 1]) 2)");
  });

  test("an explicit `}` closes the implicit block inside it first", () => {
    expect(stripSpans(parseOk("let { f x = case x of A -> 1 } in f"))).toEqual(
      stripSpans(parseOk("let { f x = case x of { A -> 1 } } in f")),
    );
  });

  test("operators may follow an explicitly closed case", () => {
    expect(sexpr(parseOk("case x of { A -> 1 } + 2"))).toBe("(+ (case x [A -> 1]) 2)");
  });
});

describe("do", () => {
  test("binds, let statements, nested do and if/then/else across lines", () => {
    braced(
      lines(
        "main = do",
        "  let x = 1",
        "      y = 2",
        "  line <- getLine",
        "  if x > y",
        '    then putStrLn "a"',
        "    else do",
        '      putStrLn "b"',
        "      putStrLn line",
        "  let z = 3 in print z",
      ),
      "{ main = do { let { x = 1; y = 2 }; line <- getLine; " +
        'if x > y then putStrLn "a" else do { putStrLn "b"; putStrLn line }; let { z = 3 } in print z } }',
    );
  });

  test("then/else aligned with if (DoAndIfThenElse)", () => {
    braced(
      lines("main = do", "  if c", "  then a", "  else b"),
      "{ main = do { if c then a else b } }",
    );
  });

  test("patterns in binds", () => {
    expect(sexpr(parseOk("do { (a, _) <- p; Just b <- q; r a b }"))).toBe(
      "(do [(tuple a _) <- p] [(Just b) <- q] [((r a) b)])",
    );
  });

  test("a do block on one line inside parentheses", () => {
    expect(sexpr(parseOk("(do a; b) >> c"))).toBe("(>> (do [a] [b]) c)");
  });

  test("do is the body of a lambda", () => {
    expect(sexpr(parseOk("mapM_ (\\x -> do print x) xs"))).toBe(
      "((mapM_ (\\ x -> (do [(print x)]))) xs)",
    );
  });
});

describe("types", () => {
  test("data declarations", () => {
    braced(
      lines(
        "data Opt a = None | Some a deriving (Show, Eq)",
        "data Tree a = Leaf | Node (Tree a) a (Tree a)",
        "data Void",
        "data P = P (Int, Char) [Int] (Int -> Int) deriving Show",
        "data Pair a b = Pair a b",
      ),
      "{ data Opt a = None | Some a deriving (Show, Eq); data Tree a = Leaf | Node (Tree a) a (Tree a); " +
        "data Void; data P = P (Int, Char) [Int] (Int -> Int) deriving (Show); data Pair a b = Pair a b }",
    );
  });

  test("data declarations spanning lines", () => {
    braced(
      lines("data Color", "  = Red", "  | Green", "  | Blue", "  deriving Eq"),
      "{ data Color = Red | Green | Blue deriving (Eq) }",
    );
  });

  test("type signatures", () => {
    braced(
      lines(
        "compose :: (b -> c) -> (a -> b) -> a -> c",
        "pair :: a -> b -> (a, b)",
        "xs, ys :: [Maybe Int]",
        "unit :: ()",
        "apply :: (->) a b -> Either String (IO ())",
      ),
      "{ compose :: (b -> c) -> (a -> b) -> a -> c; pair :: a -> b -> (a, b); xs, ys :: [Maybe Int]; " +
        "unit :: (); apply :: (->) a b -> Either String (IO ()) }",
    );
  });

  test("type signatures in let and where", () => {
    braced(
      lines("f = g 1", "  where", "    g :: Int -> Int", "    g n = n"),
      "{ f = g 1 where { g :: Int -> Int; g n = n } }",
    );
  });

  test("type annotations on expressions", () => {
    expect(sexpr(parseOk("(1 :: Int)"))).toBe("(:: 1 Int)");
    expect(sexpr(parseOk("f (x + 1 :: Int) y"))).toBe("((f (:: (+ x 1) Int)) y)");
    expect(sexpr(parseOk("\\x -> x :: Int"))).toBe("(\\ x -> (:: x Int))");
    expect(sexpr(parseOk("(\\x -> x) :: Int -> Int"))).toBe("(:: (\\ x -> x) Int -> Int)");
  });
});

describe("unsupported or invalid declarations", () => {
  test.each([
    ["import Foo", /imports are not supported/],
    ["class Foo a where", /type classes are not supported/],
    ["instance Show T where", /instances are not supported/],
    ["type Name = String", /type synonyms are not supported/],
    ["newtype N = N Int", /newtype declarations are not supported/],
    ["infixl 6 <+>", /fixity declarations are not supported/],
    ["f :: Eq a => a -> a", /type class constraints are not supported/],
    ["f :: (Eq a, Show a) => a", /type class constraints are not supported/],
    ["data R = R { x :: Int }", /record syntax is not supported/],
    ["data S = S !Int", /strictness annotations are not supported/],
    ["data T = Int :+ Int", /unexpected ':\+'/],
    ["f x | Just y <- x = y", /pattern guards are not supported/],
    ["f x | a, b = y", /multiple guards/],
    [lines("main = do", "  x <- getLine"), /last statement in a 'do' block must be an expression/],
    ["main = do", /empty 'do' block/],
    [lines("module Main", "f = 1"), /expected 'where'/],
    ["f = case x of", /needs at least one alternative/],
  ])("%s", (src, message) => {
    expect(moduleErr(src)).toMatch(message);
  });

  test("errors point at the offending token", () => {
    const r = parseModule(lines("f = 1", "import Foo"));
    expect(Result.isFailure(r) && r.failure.span.start).toEqual({ offset: 6, line: 2, col: 1 });
  });

  test("expressions report errors too", () => {
    expect(parseErr("do { let { x = 1 } }")).toMatch(/last statement/);
  });
});
