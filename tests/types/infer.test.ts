import { Result } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { bindsOf } from "../../src/core/core.ts";
import { lowerModule } from "../../src/core/lower.ts";
import { parseModule } from "../../src/syntax/parser.ts";
import { type TypedProgram, inferProgram } from "../../src/types/infer.ts";
import { prune, showScheme } from "../../src/types/types.ts";

const lines = (...ls: Array<string>): string => ls.join("\n");

const infer = (src: string, requireMain = false) => {
  const parsed = parseModule(src);
  if (Result.isFailure(parsed)) {
    throw new Error(`parse failed: ${parsed.failure.message}`);
  }
  const lowered = lowerModule(parsed.success);
  if (Result.isFailure(lowered)) {
    throw new Error(`lowering failed: ${lowered.failure.message}`);
  }
  return inferProgram(lowered.success, { requireMain });
};

const typed = (...ls: Array<string>): TypedProgram => {
  const r = infer(lines(...ls));
  if (Result.isFailure(r)) {
    throw new Error(`type error: ${r.failure.message}`);
  }
  return r.success;
};

/** `name :: type` for every top-level binding, in source order. */
const types = (...ls: Array<string>): Array<string> => {
  const t = typed(...ls);
  return t.program.groups
    .flatMap(bindsOf)
    .toSorted((a, b) => a.span.start.offset - b.span.start.offset)
    .map((b) => {
      const s = t.schemes.get(b.name.id);
      return `${b.name.text} :: ${s === undefined ? "?" : showScheme(s)}`;
    });
};

const typeErr = (...ls: Array<string>): string => {
  const r = infer(lines(...ls));
  if (Result.isSuccess(r)) {
    throw new Error("expected a type error");
  }
  return r.failure.message;
};

describe("inference", () => {
  test("literals and arithmetic", () => {
    expect(
      types("a = 1", "b = 'c'", 'c = "s"', "d = 1 + 2 * 3", "e = True && not False", "f = ()"),
    ).toEqual(["a :: Int", "b :: Char", "c :: String", "d :: Int", "e :: Bool", "f :: ()"]);
  });

  test("polymorphic functions", () => {
    expect(
      types(
        "ident x = x",
        "konst x y = x",
        "compose f g x = f (g x)",
        "flip' f x y = f y x",
        "apply f = f",
        "twice f = f . f",
      ),
    ).toEqual([
      "ident :: a -> a",
      "konst :: a -> b -> a",
      "compose :: (a -> b) -> (c -> a) -> c -> b",
      "flip' :: (a -> b -> c) -> b -> a -> c",
      "apply :: a -> a",
      "twice :: (a -> a) -> a -> a",
    ]);
  });

  test("lists, tuples, sections and Prelude functions", () => {
    expect(
      types(
        "xs = [1, 2, 3]",
        "pair = (1, 'x')",
        "inc = (+ 1)",
        "evens = filter (\\n -> n `mod` 2 == 0)",
        "swap (a, b) = (b, a)",
        "heads = map head",
        "total = foldr (+) 0",
      ),
    ).toEqual([
      "xs :: [Int]",
      "pair :: (Int, Char)",
      "inc :: Int -> Int",
      "evens :: [Int] -> [Int]",
      "swap :: (a, b) -> (b, a)",
      "heads :: [[a]] -> [a]",
      "total :: [Int] -> Int",
    ]);
  });

  test("user data types and pattern matching", () => {
    expect(
      types(
        "data Tree a = Leaf | Node (Tree a) a (Tree a)",
        "size Leaf = 0",
        "size (Node l _ r) = size l + 1 + size r",
        "insert x Leaf = Node Leaf x Leaf",
        "insert x t@(Node l y r)",
        "  | x < y = Node (insert x l) y r",
        "  | x > y = Node l y (insert x r)",
        "  | otherwise = t",
        "toList Leaf = []",
        "toList (Node l x r) = toList l ++ [x] ++ toList r",
        "fromMaybe d m = case m of",
        "  Nothing -> d",
        "  Just x -> x",
      ),
    ).toEqual([
      "size :: Tree a -> Int",
      "insert :: a -> Tree a -> Tree a",
      "toList :: Tree a -> [a]",
      "fromMaybe :: a -> Maybe a -> a",
    ]);
  });

  test("let-polymorphism", () => {
    expect(types("p = let ident x = x in (ident 1, ident 'c')")).toEqual(["p :: (Int, Char)"]);
  });

  test("lambda-bound variables are monomorphic", () => {
    expect(typeErr("p = (\\f -> (f 1, f 'c')) (\\x -> x)")).toMatch(
      /couldn't match expected type 'Int' with actual type 'Char' in argument 1 of 'f'/,
    );
  });

  test("mutual recursion is generalised together", () => {
    expect(types("f x = g x", "g x = f x")).toEqual(["f :: a -> b", "g :: a -> b"]);
    expect(
      types(
        "isEven 0 = True",
        "isEven n = isOdd (n - 1)",
        "isOdd 0 = False",
        "isOdd n = isEven (n - 1)",
      ),
    ).toEqual(["isEven :: Int -> Bool", "isOdd :: Int -> Bool"]);
  });

  test("pattern bindings and where", () => {
    expect(
      types(
        '(q, r) = (7 `div` 2, "rest")',
        "area w h = w * h + extra",
        "  where extra = w `div` 2",
      ),
    ).toEqual(["p :: (Int, String)", "q :: Int", "r :: String", "area :: Int -> Int -> Int"]);
  });

  test("do blocks are IO", () => {
    expect(
      types(
        "main = do",
        "  line <- getLine",
        "  let n = length line",
        "  (a, b) <- return (n, line)",
        "  print a",
        "  putStrLn b",
        'greet name = putStrLn ("Hello, " ++ name)',
      ),
    ).toEqual(["main :: IO ()", "greet :: String -> IO ()"]);
  });

  test("show, print and == are polymorphic built-ins", () => {
    expect(
      types("a = show 1 ++ show 'c' ++ show [True]", "b = [1] == [2]", "c = print (Just 'x')"),
    ).toEqual(["a :: String", "b :: Bool", "c :: IO ()"]);
  });

  test("strings are lists of characters", () => {
    expect(types("a = \"abc\" == ['a', 'b', 'c']", 'b = case "hi" of { c : _ -> c }')).toEqual([
      "a :: Bool",
      "b :: Char",
    ]);
  });
});

describe("type signatures", () => {
  test("a signature may be less general than the inferred type", () => {
    expect(types("ident :: Int -> Int", "ident x = x")).toEqual(["ident :: Int -> Int"]);
  });

  test("signatures with type variables and data types", () => {
    expect(
      types(
        "data Pair a b = Pair a b",
        "swap :: Pair a b -> Pair b a",
        "swap (Pair x y) = Pair y x",
      ),
    ).toEqual(["swap :: Pair a b -> Pair b a"]);
  });

  test("a signature more general than the body is rejected", () => {
    expect(typeErr("f :: a -> Int", "f x = x")).toMatch(
      /couldn't match expected type 'Int' with actual type 'a' in the definition of 'f' \(declared as 'a -> Int'\): 'a' is a rigid type variable/,
    );
    expect(typeErr("f :: a -> b", "f x = x")).toMatch(/rigid type variable/);
  });

  test("polymorphic recursion needs a signature", () => {
    const src = [
      "data Nested a = Flat a | Nest (Nested [a])",
      "depth :: Nested a -> Int",
      "depth (Flat _) = 0",
      "depth (Nest n) = 1 + depth n",
    ];
    expect(types(...src)).toEqual(["depth :: Nested a -> Int"]);
    expect(typeErr(...src.filter((l) => !l.includes("::")))).toMatch(/infinite type/);
  });

  test("bindings without signatures are inferred before those that use them (Report 4.5.2)", () => {
    // `f` uses `g` at two types. That only works if `g` is generalised before `f` is checked;
    // inferred together as one recursive group, `g` would be monomorphic.
    expect(types("f :: a -> a", "f x = const x (g 1, g 'c')", "g y = const y (f 'c')")).toEqual([
      "f :: a -> a",
      "g :: a -> a",
    ]);
  });

  test("a rigid variable cannot escape into an outer scope", () => {
    expect(typeErr("f x = g", "  where", "    g :: a -> a", "    g y = x")).toMatch(
      /rigid type variable 'a' would escape/,
    );
  });

  test("local signatures", () => {
    expect(types("f = g 1 + g 2", "  where", "    g :: Int -> Int", "    g n = n * 2")).toEqual([
      "f :: Int",
    ]);
  });

  test("type annotations on expressions", () => {
    expect(types("a = (1 :: Int)", "b = (\\x -> x) :: a -> a", "c = (id :: Int -> Int) 3")).toEqual(
      ["a :: Int", "b :: a -> a", "c :: Int"],
    );
    expect(typeErr("b = (\\x -> x + 1) :: a -> a")).toMatch(/rigid type variable/);
  });
});

describe("type errors", () => {
  test.each([
    [["a = 1 + 'c'"], /expected type 'Int' with actual type 'Char' in argument 2 of '\+'/],
    [
      ["a = if 1 then 2 else 3"],
      /expected type 'Bool' with actual type 'Int' in the condition of an if/,
    ],
    [
      ["a = if True then 1 else 'c'"],
      /expected type 'Int' with actual type 'Char' in the else branch/,
    ],
    [["f x = x x"], /cannot construct the infinite type t1 ~ t1 -> t2/],
    [["a = head [1] 2"], /'head' is applied to too many arguments/],
    [["a = 1 2"], /applied to an argument, but its type 'Int' is not a function type/],
    [["f (Just x) = x", "f [] = 0"], /in a pattern with constructor '\[\]'/],
    [
      ["f n | n = 1", "    | otherwise = 2", "g = f 1"],
      /expected type 'Bool' with actual type 'Int' in argument 1 of 'f'/,
    ],
    [["f n | n + 1 = 1"], /expected type 'Bool' with actual type 'Int' in a guard/],
    [["f 0 = 'a'", "f n = n"], /in an equation for function 'f'/],
    [["a = case 1 of { 'c' -> 0 }"], /expected type 'Int' with actual type 'Char' in a pattern/],
    [["a = do { x <- getLine; return (x + 1) }"], /expected type 'Int' with actual type 'String'/],
    [
      ["a = putStrLn 1"],
      /expected type 'String' with actual type 'Int' in argument 1 of 'putStrLn'/,
    ],
    [["f :: Maybe -> Int", "f _ = 1"], /the type 'Maybe' expects 1 argument, but has been given 0/],
    [["f :: Int Int", "f = 1"], /the type 'Int' expects 0 arguments, but has been given 1/],
    [["f :: m a -> a", "f x = f x"], /higher-kinded types are not supported/],
    [["f :: Int -> Int", "f x = 'c'"], /in the definition of 'f' \(declared as 'Int -> Int'\)/],
  ])("%j", (src, message) => {
    expect(typeErr(...src)).toMatch(message);
  });

  test("errors point at the offending expression", () => {
    const r = infer(lines("a = 1", "b = a + 'c'"));
    expect(Result.isFailure(r) && r.failure.span.start).toEqual({ offset: 14, line: 2, col: 9 });
  });
});

describe("main", () => {
  test("must exist when required", () => {
    const r = infer("f = 1", true);
    expect(Result.isFailure(r) && r.failure.message).toMatch(/does not define 'main'/);
  });

  test("must be an IO action", () => {
    const r = infer("main = 1", true);
    expect(Result.isFailure(r) && r.failure.message).toMatch(
      /'main' must have type 'IO t', but it has type 'Int'/,
    );
  });

  test("may return any type", () => {
    expect(Result.isSuccess(infer("main = return 'c'", true))).toBe(true);
  });
});

describe("recorded types for code generation", () => {
  test("lambda parameters of a polymorphic binding refer to its scheme variables", () => {
    const t = typed("ident x = x");
    const [bind] = t.program.groups.flatMap(bindsOf);
    const scheme = bind && t.schemes.get(bind.name.id);
    expect(scheme?.vars).toHaveLength(1);
    const expr = bind?.expr;
    const param = expr?._tag === "Lam" ? t.varTypes.get(expr.param.id) : undefined;
    expect(param && prune(param)).toBe(scheme?.vars[0]);
  });

  test("every expression has a type", () => {
    const t = typed("f x = map (+ x) [1, 2]");
    const [bind] = t.program.groups.flatMap(bindsOf);
    expect(bind && t.exprTypes.has(bind.expr)).toBe(true);
    expect(t.exprTypes.size).toBeGreaterThan(5);
  });
});
