# haskell-to-effect

A small compiler from a subset of Haskell to typed TypeScript that runs on
[Effect](https://effect.website). Pure code becomes curried, generically typed functions;
`IO` becomes `Effect`, and `do` blocks become `Effect.gen`.

```haskell
module Main where

data Shape = Circle Int | Rect Int Int

area :: Shape -> Int
area (Circle r) = 3 * r * r
area (Rect w h) = w * h

main :: IO ()
main = do
  name <- getLine
  putStrLn ("Hello, " ++ name)
  print (area (Rect 2 3))
```

compiles to

```ts
import { Effect } from "effect";
import * as rt from "./hs-runtime.ts";

export type Shape =
  | { readonly _tag: "Circle"; readonly a0: number }
  | { readonly _tag: "Rect"; readonly a0: number; readonly a1: number };
export const Circle = (a0: number): Shape => ({ _tag: "Circle", a0 });
export const Rect =
  (a0: number) =>
  (a1: number): Shape => ({ _tag: "Rect", a0, a1 });

export const area = (arg: Shape): number => {
  switch (arg._tag) {
    case "Circle": {
      const r = arg.a0;
      return 3 * r * r;
    }
    default: {
      const w = arg.a0;
      const h = arg.a1;
      return w * h;
    }
  }
};

export const main: rt.IO<undefined> = Effect.gen(function* () {
  const name: rt.List<rt.Char> = yield* rt.getLine;
  yield* rt.putStrLn(rt.appendList(rt.str("Hello, "), name));
  return yield* rt.printWith(rt.showInt)(area(Rect(2)(3)));
});
```

(abridged: the output also contains a `show` function and a constructor registration for
`Shape`). The generated code passes `tsc --strict`.

## Usage

Requires Node.js 22.18 or later (for built-in TypeScript type stripping), or Nix (see
[With Nix](#with-nix)).

```sh
vp install
vp pack                                   # builds dist/cli.mjs (the `hs2effect` binary)

node dist/cli.mjs check   Main.hs         # parse and type-check
node dist/cli.mjs compile Main.hs -o out  # write out/Main.ts, out/hs-runtime.ts, out/run.ts
node dist/cli.mjs run     Main.hs         # compile and run
```

During development, run the CLI from source with `vpx src/cli.ts <command> …`.

`compile` writes three files: the module, a copy of the runtime, and `run.ts`, which runs
`main`. Run it with `node out/run.ts`. The output needs the `effect` package to be
resolvable from its directory. Node does not strip types from files under `node_modules`,
so the output directory must not be inside one. `run` takes care of both by compiling into
`.hs2effect/run/` inside this package.

Errors and warnings are reported with the offending source line:

```
Main.hs:2:14: error: couldn't match expected type 'Int' with actual type 'Bool' in argument 2 of '+'
  |
2 |   print (1 + True)
  |              ^^^^
```

Runtime errors are printed as GHC prints them, with exit code 1:

```
Main: Main.hs:(4,1)-(5,20): Non-exhaustive patterns in function name
```

### With Nix

Instead of installing Node.js and pnpm yourself, you can use the Nix flake:

```sh
nix run . -- run Main.hs     # build the CLI and run a program
nix build                    # builds result/bin/hs2effect
```

The packaged `hs2effect run` writes generated programs under
`$XDG_CACHE_HOME/haskell-to-effect/` (default `~/.cache`), because the Nix store is
read-only.

## The supported subset

| Area         | Supported                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Modules      | One module, with an optional `module Main (…) where` header. No imports; the Prelude below is built in.                                                                                                                        |
| Declarations | Functions with several equations, pattern bindings, type signatures (`f, g :: t`), `data` with type parameters and positional fields. `deriving` clauses are accepted and ignored.                                             |
| Expressions  | Literals (`Int`, `Char`, `String`), application, operators, sections (`(+ 1)`, ``(`div` 2)``), negation, lambdas, `let`, `where`, `if`, `case`, `do`, lists, tuples, type annotations (`e :: t`).                              |
| Patterns     | Variables, `_`, literals (including negative and string literals), constructors, `x : xs`, `[a, b]`, tuples, as-patterns (`xs@(x : _)`), nested patterns. Boolean guards, including `otherwise`.                               |
| Layout       | The full Haskell 2010 layout rule, including the `parse-error(t)` case (`let x = 1 in x` on one line), and explicit `{ ; }`.                                                                                                   |
| Types        | Hindley–Milner inference with let-polymorphism; checked signatures, including polymorphic recursion. Types: `Int`, `Char`, `Bool`, `String`, `()`, lists, tuples, functions, `IO`, `Maybe`, `Either`, and your own data types. |
| Operators    | The Prelude operators with their standard fixities: `. $                                                                                                                                                                       |     | && == /= < <= > >= : ++ + - *` and `` `div` `` `` `mod` ``. |

The Prelude:

|                        |                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IO                     | `putStr`, `putStrLn`, `print`, `getLine`, `return`, `pure`, `>>=`, `>>`, `mapM_`                                                                                                                                  |
| Comparison and display | `show`, `==`, `/=`, `<`, `<=`, `>`, `>=`, `max`, `min`                                                                                                                                                            |
| Arithmetic             | `+`, `-`, `*`, `div`, `mod`, `negate`, `abs`                                                                                                                                                                      |
| Booleans               | `&&`, `\|\|`, `not`, `otherwise`                                                                                                                                                                                  |
| Lists                  | `map`, `filter`, `foldr`, `foldl`, `length`, `head`, `tail`, `null`, `reverse`, `++`, `concat`, `concatMap`, `sum`, `product`, `take`, `drop`, `replicate`, `zip`, `elem`, `lines`, `words`, `unlines`, `unwords` |
| Tuples and functions   | `fst`, `snd`, `id`, `const`, `.`, `$`, `flip`, `error`                                                                                                                                                            |
| Data types             | `Bool` (`True`, `False`), `Maybe` (`Nothing`, `Just`), `Either` (`Left`, `Right`)                                                                                                                                 |

The compiler rejects the following with a message saying they are not supported:

- type classes, instances and constraints (`Eq a =>`), and higher-kinded types (`m a`)
- `import`, `newtype`, `type` synonyms, records, strictness annotations
- fixity declarations and user-defined operators
- pattern guards (`| Just x <- e`), multiple guards (`| a, b`) and lazy patterns (`~p`)
- floating-point literals, qualified names, ranges (`[1 ..]`), list comprehensions

## Differences from Haskell

Programs in the subset are valid Haskell, and most behave the same under GHC. These are
the exceptions:

1. **Evaluation is strict.** Function arguments, `let` and `where` bindings, and top-level
   values are evaluated when they are reached, not when they are needed.
   - **No laziness tricks:** infinite lists and other knot-tying definitions do not work.
   - **Unused bindings still run:** an unused binding that fails (`x = head []`), or a slow
     `where` binding used by only one guard, still runs.
   - **`&&`, `||` and `if` short-circuit as usual.**
   - **IO actions run in program order:** a failing expression inside an IO action fails
     when that action runs, not before. `>>` evaluates its second action only after the
     first has run, and top-level IO values are deferred until they run.
2. **There are no type classes.** `show`, `print`, `==`, `/=`, `<`, `<=`, `>`, `>=`, `max`
   and `min` work on every type structurally, without `Show`, `Eq` or `Ord` constraints.
   - **Ordering:** data types are ordered by constructor declaration order, as with a
     derived `Ord`.
   - **Functions:** comparing functions is a runtime error, and showing one prints
     `<function>`. GHC rejects both at compile time.
   - **Arithmetic is `Int` only.**
3. **`Int` is a JavaScript number.** It is exact up to ±2⁵³ and does not wrap on overflow.
   `div` and `mod` round as in Haskell, and division by zero is an error.
4. **Recursion through function values is limited in depth.** Other recursion runs at any
   depth:
   - **Tail calls are loops:**
     - calls a function makes to itself, such as accumulator loops, `go` helpers and
       `p x || anyOf p xs`, wherever they appear in `if`, `case` and guards
     - tail calls between mutually recursive functions, such as `isEven`/`isOdd` or a
       state machine: the group is merged into one loop
   - **Other recursive calls,** such as `1 + len xs` or `x : append xs ys`, run on the
     JavaScript stack while it is shallow. Beyond 1,000 nested calls they continue on a
     stack on the heap, which is slower but unlimited.
   - **IO recursion** (loops in `do` blocks) is stack-safe.
   - **The Prelude list functions** are loops.
   - **The limit:** a function that recurses through a function value, such as
     `size (Rose cs) = 1 + sum (map size cs)`, or a lambda calling it, uses JavaScript
     stack frames on every level. It overflows Node's default stack a few thousand levels
     deep, at about 2,000 for that `size`.
5. **`show` is resolved from static types.** Inside a polymorphic function, where the
   static type is not known, `show` inspects the runtime value instead. That is exact,
   except that the empty string then shows as `[]` instead of `""`.
6. **`String` is a list of `Char`.** It is converted to a JavaScript string only at I/O,
   just as slow as in Haskell.
7. **Messages differ in detail.** Runtime errors follow GHC's format but omit the
   `CallStack` lines. Compile errors and warnings cover the same problems as GHC's but are
   worded differently.

## How it works

```
source → lexer → layout → parser → lowering → type inference → code generation → TypeScript
```

- **Syntax** (`src/syntax/`):
  - **Lexer:** the Haskell 2010 lexer, with source spans.
  - **Layout:** the layout rule is a lazy token stream that the parser asks to close
    implicit blocks (`parse-error(t)`).
  - **Parser:** recursive descent, with the Report's fixity resolution for operators and
    sections.
- **Core** (`src/core/`): name resolution and desugaring into a small language of `Var`,
  `Prim`, `Con`, `Lit`, `App`, `Lam`, `Let`, `If`, `Match` and `Typed`. Bindings are split
  into dependency groups.
- **Types** (`src/types/`):
  - **Inference:** Hindley–Milner with level-based generalisation.
  - **Signatures:** checked with rigid type variables.
  - **Better errors:** expected types are pushed into lambdas and branches, so mismatches
    are reported where they occur.
- **Code generation** (`src/codegen/`):
  - **Types:** polymorphic bindings become generic arrow functions with explicit type
    arguments at every call, and `show` is type-directed.
  - **Pattern matching:** matches become decision trees (Maranget's algorithm), with
    exhaustiveness and redundancy warnings.
  - **IO:** `do` blocks become `Effect.gen`.
  - **Recursion:** tail calls become loops. Functions with other recursive calls also get
    a generator version that runs on a trampoline once the recursion is deep.
- **Runtime** (`src/runtime/hs-runtime.ts`):
  - **Representation:** cons lists, and structural equality, ordering and `show`.
  - **The Prelude itself.**
  - **Console I/O:** through Effect's `Terminal` service. `testTerminal` provides scripted
    input and captured output for tests.

`PLAN.md` has the design decisions and the history of the milestones.

## Development

With Nix, `nix develop` opens a shell with Node.js 24 and pnpm, and puts
`node_modules/.bin` (`vp`, `tsc`) on `PATH`. Run `vp install` in it first.

```sh
vp check   # format, lint and type-check
vp test    # unit tests and golden tests
vp pack    # build dist/
```

Golden tests live in `tests/golden/programs/`. Each `<name>.hs` is compiled, the generated
TypeScript is type-checked with `tsc --strict`, and the program is run with Node:

- **Success:** stdout must equal `<name>.stdout`, with `<name>.stdin` as input if present.
- **Expected failure:** if `<name>.stderr` exists, the program must exit with code 1 and
  print that text.

The expected outputs are what GHC prints. GHC is not used in the tests, so add new
programs carefully.

After changing dependencies (`pnpm-lock.yaml`), update `pnpmDeps.hash` in `flake.nix`:
run `nix build`, and copy the `got:` hash from the error.
