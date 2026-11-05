import { Result } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { parseExpr } from "../../src/syntax/parser.ts";
import { prettyExpr } from "../../src/syntax/pretty.ts";
import { parseErr, parseOk, sexpr, stripSpans } from "./helpers.ts";

const s = (src: string): string => sexpr(parseOk(src));

describe("parser: precedence and associativity", () => {
  test.each([
    ["1 + 2 * 3", "(+ 1 (* 2 3))"],
    ["1 - 2 - 3", "(- (- 1 2) 3)"],
    ["a : b : c", "(: a (: b c))"],
    ["xs ++ ys ++ zs", "(++ xs (++ ys zs))"],
    ["f . g . h", "(. f (. g h))"],
    ["f $ g $ x", "($ f ($ g x))"],
    ["a || b && c", "(|| a (&& b c))"],
    ["x == 1 && y < 2", "(&& (== x 1) (< y 2))"],
    ["a `div` b * c", "(* (div a b) c)"],
    ["n `mod` 2 == 0", "(== (mod n 2) 0)"],
    ["f x y + g z", "(+ ((f x) y) (g z))"],
    ["Just x : xs", "(: (Just x) xs)"],
    ["m >>= f >>= g", "(>>= (>>= m f) g)"],
    ["a <+> b <+> c", "(<+> (<+> a b) c)"], // unknown operators default to infixl 9
  ])("%s", (src, expected) => {
    expect(s(src)).toBe(expected);
  });
});

describe("parser: negation", () => {
  test.each([
    ["- x", "(neg x)"],
    ["- 2 * 3", "(neg (* 2 3))"],
    ["- 2 + 3", "(+ (neg 2) 3)"],
    ["a == - b", "(== a (neg b))"],
    ["f (-1)", "(f (neg 1))"],
    ["x - 1", "(- x 1)"],
  ])("%s", (src, expected) => {
    expect(s(src)).toBe(expected);
  });

  test("negation cannot follow a tighter operator", () => {
    expect(parseErr("a * - b")).toMatch(/cannot mix '\*' \[infixl 7\] and prefix '-'/);
    expect(parseErr("a + - b")).toMatch(/cannot mix '\+' \[infixl 6\] and prefix '-'/);
  });
});

describe("parser: fixity errors", () => {
  test("non-associative operators cannot be chained", () => {
    expect(parseErr("a == b == c")).toMatch(/cannot mix '==' \[infix 4\] and '==' \[infix 4\]/);
    expect(parseErr("a < b > c")).toMatch(/cannot mix/);
  });
});

describe("parser: atoms, tuples, lists, sections", () => {
  test.each([
    ["()", "()"],
    ["[]", "[]"],
    ["(,)", "(,)"],
    ["(,,) a", "((,,) a)"],
    ["(+)", "+"],
    ["(-)", "-"],
    ["(:)", ":"],
    ["(1, 'c', \"s\")", '(tuple 1 "c" "s")'],
    ["[1, 2, 3]", "(list 1 2 3)"],
    ["((x))", "x"],
    ["(+ 1)", "(rsection + 1)"],
    ["(1 +)", "(lsection 1 +)"],
    ["(`div` 2)", "(rsection div 2)"],
    ["(n `mod`)", "(lsection n mod)"],
    ["(subtract 1)", "(subtract 1)"],
    ["(- 1)", "(neg 1)"],
    ["(a + b +)", "(lsection (+ a b) +)"],
    ["(: [])", "(rsection : [])"],
    ["(. f . g)", "(rsection . (. f g))"],
  ])("%s", (src, expected) => {
    expect(s(src)).toBe(expected);
  });

  test("invalid sections", () => {
    expect(parseErr("(a + b *)")).toMatch(/left section/);
    expect(parseErr("(* a + b)")).toMatch(/right section/);
    expect(parseErr("(a == b ==)")).toMatch(/cannot mix/);
    expect(parseErr("(`div`)")).toMatch(/backticks/);
  });
});

describe("parser: lambda, let, if", () => {
  test.each([
    ["\\x -> x + 1", "(\\ x -> (+ x 1))"],
    ["\\x y -> f x y", "(\\ x y -> ((f x) y))"],
    ["\\(x, _) [a, b] (Just z) -> z", "(\\ (tuple x _) (list a b) (Just z) -> z)"],
    ["\\xs@(x : _) -> x", "(\\ xs@(: x _) -> x)"],
    ["\\(-1) -> 0", "(\\ -1 -> 0)"],
    ["1 + \\x -> x + 2", "(+ 1 (\\ x -> (+ x 2)))"],
    ["f $ \\x -> x", "($ f (\\ x -> x))"],
    ["let { x = 1 } in x", "(let [x = 1] x)"],
    ["let { f x = x * 2; y = f 3 } in y", "(let [f x = (* x 2); y = (f 3)] y)"],
    ["let { (a, b) = p; c : cs = s } in a", "(let [(tuple a b) = p; (: c cs) = s] a)"],
    ["let { ; x = 1 ;; } in x", "(let [x = 1] x)"],
    ["let {} in 1", "(let [] 1)"],
    ["if a then b else c + 1", "(if a b (+ c 1))"],
    ["if a; then b; else c", "(if a b c)"],
    ["if a then if b then c else d else e", "(if a (if b c d) e)"],
    ["x + if c then 1 else 2", "(+ x (if c 1 2))"],
    ["(\\x -> x) . f", "(. (\\ x -> x) f)"],
    ["(if a then b else c) + 1", "(+ (if a b c) 1)"],
  ])("%s", (src, expected) => {
    expect(s(src)).toBe(expected);
  });
});

describe("parser: errors", () => {
  test.each([
    ["1 +", /unexpected end of input, expected an expression/],
    ["(1, 2", /unexpected end of input, expected '\)'/],
    ["\\ -> x", /expected a pattern/],
    ["let { x } in x", /expected '='/],
    ["let { x = 1 in x", /expected ';' or '}'/],
    ["if a then b", /expected 'else'/],
    ["f )", /unexpected '\)', expected end of input/],
    ["[1 ..]", /arithmetic sequences/],
    ["case x of {}", /not supported yet/],
  ])("%s", (src, message) => {
    expect(parseErr(src)).toMatch(message);
  });

  test("errors carry source spans", () => {
    const r = parseExpr("a * - b");
    expect(Result.isFailure(r) && r.failure.span.start).toEqual({ offset: 4, line: 1, col: 5 });
  });
});

describe("pretty-printer round-trip", () => {
  test.each([
    ["1 + 2 * 3", "1 + 2 * 3"],
    ["(1 + 2) * 3", "(1 + 2) * 3"],
    ["1 - (2 - 3)", "1 - (2 - 3)"],
    ["(1 - 2) - 3", "1 - 2 - 3"],
    ["(a : b) : c", "(a : b) : c"],
    ["f (g x) y", "f (g x) y"],
    ["(f x) y", "f x y"],
    ["- (a + b)", "- (a + b)"],
    ["a == (- b)", "a == - b"],
    ["a * (- b)", "a * (- b)"],
    ["(- a) * b", "(- a) * b"],
    ["(\\x -> x) 1", "(\\x -> x) 1"],
    ["f (\\x -> x)", "f (\\x -> x)"],
    ["1 + (\\x -> x)", "1 + (\\x -> x)"],
    ["(if a then b else c) + 1", "(if a then b else c) + 1"],
    ["(+ 1)", "(+ 1)"],
    ["(`div` 2)", "(`div` 2)"],
    ["(a + b +)", "(a + b +)"],
    ["map (+) xs", "map (+) xs"],
    ["\\xs@(x : _) (Just y) (-1) -> (x, [y])", "\\xs@(x : _) (Just y) (-1) -> (x, [y])"],
    ["let { f x = x; y = 2 } in f y", "let { f x = x; y = 2 } in f y"],
    ['"a\\nb\\"c"', '"a\\nb\\"c"'],
    ["'\\''", "'\\''"],
    ['"\\1\\&2"', '"\\1\\&2"'],
  ])("%s", (src, pretty) => {
    const ast = parseOk(src);
    const printed = prettyExpr(ast);
    expect(printed).toBe(pretty);
    expect(stripSpans(parseOk(printed))).toEqual(stripSpans(ast));
  });
});
