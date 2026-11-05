/**
 * The built-in Prelude: primitive values (implemented by the runtime) and built-in data types.
 *
 * Types are written in Haskell syntax and parsed by the type checker. Because there are no
 * type classes, `show`, `print`, `==` and the comparison operators are polymorphic in all
 * types; the runtime implements them structurally.
 */

export interface PrimInfo {
  readonly name: string;
  readonly type: string;
}

const prim = (type: string, ...names: Array<string>): Array<PrimInfo> =>
  names.map((name) => ({ name, type }));

export const prims: ReadonlyArray<PrimInfo> = [
  // IO
  ...prim("String -> IO ()", "putStrLn", "putStr"),
  ...prim("a -> IO ()", "print"),
  ...prim("IO String", "getLine"),
  ...prim("a -> IO a", "return", "pure"),
  ...prim("IO a -> (a -> IO b) -> IO b", ">>="),
  ...prim("IO a -> IO b -> IO b", ">>"),
  ...prim("(a -> IO b) -> [a] -> IO ()", "mapM_"),
  // structural show / equality / ordering
  ...prim("a -> String", "show"),
  ...prim("a -> a -> Bool", "==", "/=", "<", "<=", ">", ">="),
  ...prim("a -> a -> a", "max", "min"),
  // arithmetic
  ...prim("Int -> Int -> Int", "+", "-", "*", "div", "mod"),
  ...prim("Int -> Int", "negate", "abs"),
  // booleans
  ...prim("Bool -> Bool -> Bool", "&&", "||"),
  ...prim("Bool -> Bool", "not"),
  ...prim("Bool", "otherwise"),
  // lists
  ...prim("(a -> b) -> [a] -> [b]", "map"),
  ...prim("(a -> Bool) -> [a] -> [a]", "filter"),
  ...prim("(a -> b -> b) -> b -> [a] -> b", "foldr"),
  ...prim("(b -> a -> b) -> b -> [a] -> b", "foldl"),
  ...prim("[a] -> Int", "length"),
  ...prim("[a] -> a", "head"),
  ...prim("[a] -> [a]", "tail", "reverse"),
  ...prim("[a] -> Bool", "null"),
  ...prim("[a] -> [a] -> [a]", "++"),
  ...prim("[[a]] -> [a]", "concat"),
  ...prim("(a -> [b]) -> [a] -> [b]", "concatMap"),
  ...prim("[Int] -> Int", "sum", "product"),
  ...prim("Int -> [a] -> [a]", "take", "drop"),
  ...prim("Int -> a -> [a]", "replicate"),
  ...prim("[a] -> [b] -> [(a, b)]", "zip"),
  ...prim("a -> [a] -> Bool", "elem"),
  ...prim("String -> [String]", "lines", "words"),
  ...prim("[String] -> String", "unlines", "unwords"),
  // tuples and functions
  ...prim("(a, b) -> a", "fst"),
  ...prim("(a, b) -> b", "snd"),
  ...prim("a -> a", "id"),
  ...prim("a -> b -> a", "const"),
  ...prim("(b -> c) -> (a -> b) -> a -> c", "."),
  ...prim("(a -> b) -> a -> b", "$"),
  ...prim("(a -> b -> c) -> b -> a -> c", "flip"),
  ...prim("String -> a", "error"),
];

export const primNames: ReadonlySet<string> = new Set(prims.map((p) => p.name));

/** A data type declared by the Prelude, in the same shape as a user `data` declaration. */
export interface BuiltinData {
  readonly name: string;
  readonly params: ReadonlyArray<string>;
  readonly constructors: ReadonlyArray<{
    readonly name: string;
    readonly fields: ReadonlyArray<string>;
  }>;
}

export const builtinData: ReadonlyArray<BuiltinData> = [
  {
    name: "Bool",
    params: [],
    constructors: [
      { name: "False", fields: [] },
      { name: "True", fields: [] },
    ],
  },
  {
    name: "Maybe",
    params: ["a"],
    constructors: [
      { name: "Nothing", fields: [] },
      { name: "Just", fields: ["a"] },
    ],
  },
  {
    name: "Either",
    params: ["a", "b"],
    constructors: [
      { name: "Left", fields: ["a"] },
      { name: "Right", fields: ["b"] },
    ],
  },
];

/** Built-in type constructors that are not `data` types, with their arity. */
export const builtinTypes: ReadonlyMap<string, number> = new Map([
  ["Int", 0],
  ["Char", 0],
  ["String", 0], // synonym for [Char]
  ["IO", 1],
  ["()", 0],
  ["[]", 1],
  ["->", 2],
]);

/** Arity of a tuple constructor name such as `(,,)`, or `undefined` if it is not one. */
export const tupleArity = (name: string): number | undefined =>
  /^\(,+\)$/.test(name) ? name.length - 1 : undefined;

export const tupleName = (arity: number): string => `(${",".repeat(arity - 1)})`;
