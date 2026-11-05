# haskell-to-effect — plan

A minimal compiler from a small Haskell subset to **typed TypeScript** running on
**Effect**. `main :: IO ()` becomes an `Effect`; pure code becomes plain, curried,
generically-typed TS functions. Delivered as a CLI (`hs2effect`).

## Decisions

| Topic                   | Decision                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evaluation              | **Strict.** `&&`, `\|\|`, `if`, `case` short-circuit; no infinite lists / knot-tying.                                                                                                    |
| Type classes            | **None.** `==`, `/=`, `show`, `print` are special-cased polymorphic built-ins; arithmetic and comparison are `Int`-only. Consequently `do` always means `IO`.                            |
| Output                  | **Typed TypeScript** (ES module) that must pass `tsc --strict --noEmit`. Only erasable syntax (no `enum`/`namespace`), so Node runs it directly via type stripping.                      |
| Deliverable             | **CLI only** for now: `hs2effect check \| compile \| run`.                                                                                                                               |
| Compiler implementation | Written with Effect: tagged errors per phase (with source spans), `effect/cli`, `FileSystem`, `@effect/platform-node`. Passes themselves are pure functions returning `Result`/`Either`. |

## Supported subset

- **Module:** a single `module Main where`; no imports; fixed built-in Prelude.
- **Declarations:** top-level functions (multiple equations), optional type signatures,
  `data T a = C1 t | C2 t t` (positional fields, type parameters allowed). `deriving`
  clauses are accepted and ignored (`show`/`==` are built in), so programs stay valid for GHC.
- **Expressions:** literals (`Int`, `Char`, `String`, `Bool`), application, lambdas,
  `let … in`, `where`, `if`, `case`, operator sections, list literals, tuples, `do`.
- **Patterns:** var, `_`, literals, constructors, `x:xs`, `[]`, tuples, as-patterns, nested;
  boolean guards incl. `otherwise` (no pattern guards).
- **Type annotations:** `e :: t`.
- **Operators (fixed Report fixities):** `. $ || && == /= < <= > >= : ++ + - * `div` `mod``.
- **Layout:** layout rule for `where`/`let`/`do`/`of`, plus explicit `{ ; }`.
- **Prelude:** `putStrLn print getLine return >>= >> show map filter foldr length head tail
  error div mod not fst snd id const`.

Out of scope: type classes/instances, records, `newtype`, `type` synonyms,
modules/imports, user operators/fixity, list comprehensions, `Integer`/`Double`, extensions.

## Haskell → TypeScript mapping

| Haskell                                    | TypeScript                                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Int`                                      | `number` (53-bit; documented deviation)                                                                                            |
| `Char`                                     | `Char` (alias of `string`, length 1)                                                                                               |
| `Bool`                                     | `boolean`                                                                                                                          |
| `[a]`                                      | `List<A>` = `{ _tag: "Nil" } \| { _tag: "Cons"; head: A; tail: List<A> }`                                                          |
| `String`                                   | `List<Char>` (converted to/from JS strings only at IO boundaries)                                                                  |
| `(a, b)`                                   | `readonly [A, B]`                                                                                                                  |
| `a -> b`                                   | `(a: A) => B` (always curried)                                                                                                     |
| `IO a`                                     | `IO<A>` = `Effect.Effect<A, never, Terminal>`                                                                                      |
| `data Maybe a = Nothing \| Just a`         | `type Maybe<A> = { _tag: "Nothing" } \| { _tag: "Just"; a0: A }` + constructor functions `Nothing`, `Just: <A>(a0: A) => Maybe<A>` |
| polymorphic binding `∀a b.`                | generic type params `<A, B>` on the generated arrow function                                                                       |
| unresolved type variable (e.g. `print []`) | `unknown`                                                                                                                          |
| `do` block                                 | `Effect.gen(function* () { … })`                                                                                                   |
| `>>=` / `>>` / `return`                    | `Effect.flatMap` / `Effect.andThen` / `Effect.succeed`                                                                             |
| `error "msg"`                              | `throw` → surfaces as an Effect defect                                                                                             |

Pattern matches compile to `switch (x._tag)` so TS narrowing type-checks the field accesses;
non-exhaustive matches end in `rt.patternFail("<file>:<line>:<col>")`.

`show` is type-directed when the argument type is known at the call site (this distinguishes
`show ""` from `show []`, and `String` from other lists); inside polymorphic code it falls back
to a runtime reflection `show`. `==` is runtime structural equality (comparing functions throws).

### Example

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

export const area = (x: Shape): number => {
  switch (x._tag) {
    case "Circle": {
      const r = x.a0;
      return 3 * r * r;
    }
    case "Rect": {
      const w = x.a0,
        h = x.a1;
      return w * h;
    }
  }
};

export const main: rt.IO<void> = Effect.gen(function* () {
  const name = yield* rt.getLine;
  yield* rt.putStrLn(rt.append(rt.str("Hello, "))(name));
  yield* rt.putStrLn(rt.showInt(area(Rect(2)(3))));
});
```

## Architecture

```
src/
  syntax/
    lexer.ts       tokens with spans
    layout.ts      layout rule as a lazy stream → virtual { ; }
    parser.ts      recursive descent + Pratt for operators
    ast.ts         surface AST
  prelude.ts       built-in values (with Haskell type signatures) and data types
  core/
    core.ts        Core: Var Prim Con Lit App Lam Let If Match Typed
    lower.ts       scoping + desugaring (equations → Match, guards, where → let,
                   sections → lambdas, list literals → cons, do → >>= / >>)
    scc.ts         dependency groups (Tarjan)
    pretty.ts      Core printer for snapshots
  types/
    types.ts       type representation, zonking, printing
    infer.ts       Hindley–Milner, let-polymorphism per dependency group, signature
                   checking; records types for codegen (no separate elaboration pass)
  match.ts         nested patterns → decision trees
  codegen/
    types.ts       Haskell types → TS type syntax
    ts.ts          typed Core → TS source
  runtime/
    hs-runtime.ts  List, Char, IO, show/eq, Prelude, getLine/putStrLn on Terminal
  errors.ts        tagged errors + code-frame formatting
  cli.ts           hs2effect check | compile | run
tests/
  unit/            per-pass tests
  golden/          *.hs + *.stdout (+ optional *.stdin)
  errors/          *.hs + expected diagnostics
```

Pipeline: `lex → layout → parse → rename → desugar → infer → match → codegen`.

## CLI

```
hs2effect check   <file.hs>                 parse + type-check, report diagnostics
hs2effect compile <file.hs> [-o <dir>]      write <dir>/<Module>.ts, hs-runtime.ts, run.ts
hs2effect run     <file.hs>                 compile into .hs2effect/run/ inside the package
                                            (so `effect` resolves) and run it with Node
```

Run compiled output with `node <dir>/run.ts` (Node strips the types; `effect` must be
resolvable from `<dir>`, and `<dir>` must not be under `node_modules`, where Node refuses
to strip types). Diagnostics go to stderr with a code frame; exit code 1 on error.

## Milestones

Each ends with green `vp test` and `vp check`.

1. **Lexer + expression parser** — literals, application, operators with fixities, lambdas,
   `if`, `let` with explicit braces. Done: parse→pretty-print round-trips. ✅
2. **Layout rule** — Report §10.3 as a lazy token stream the parser pulls from; the
   `parse-error(t)` rule is implemented by the parser asking the stream to close the
   innermost implicit block (as GHC does). Done: layout snippets equal their explicitly
   braced versions. ✅
3. **Declarations + patterns** — module header, multi-equation functions, guards, `where`,
   `data`, `case`, signatures, and `do` syntax (semantics in milestone 7). ✅
4. **Rename + desugar to Core** — one pass (`core/lower.ts`); dependency analysis (SCCs)
   happens here, so Core `Let`s are already in dependency order. Done: Core snapshots for
   all syntax forms. ✅
5. **Type inference + elaboration** — HM with level-based generalisation, rigid
   signature variables (escape check, polymorphic recursion), Report 4.5.2 splitting of
   recursive groups at signatures, a light checking mode for better error locations, and
   recorded types (per expression, per binder, per scheme) for codegen. Done:
   inferred-type tests and error tests. ✅
6. **Typed TS codegen for pure code + runtime + `compile`/`run` CLI** — first runnable
   output: `main = print (fac 10)`. Done: golden output passes `tsc --strict` and runs. ✅
   Explicit type arguments at every polymorphic call; type-directed `show` matching GHC's
   output; `>>` defers its second action and top-level IO is suspended, so errors happen
   in program order despite strict evaluation.
7. **IO on Effect** — `do`, `getLine`, `putStrLn`, `print`, `>>=`, `return`; tests provide
   a mock `Terminal` layer for stdin/stdout. Done: the example above runs. **← end-to-end**
8. **Pattern-match compilation** — decision trees, nested patterns, located failures.
9. **Polish** — code frames, larger golden suite, README listing all deviations from Haskell.

Stretch: records, `type` synonyms, opt-in laziness.

## Testing

- **Unit:** tokens, layout output, AST/Core snapshots, inferred types.
- **Golden:** compile each `tests/golden/*.hs` → **type-check output with `tsc --strict`**
  → run with the mock `Terminal` (feeding `*.stdin`) → compare to `*.stdout`.
- **Differential:** if `runghc` is available, run golden programs through GHC as the oracle
  (all programs in the subset are valid Haskell). GHC is not installed on the development
  machine yet, so expected outputs are currently written by hand.
- **Errors:** ill-formed/ill-typed programs with expected diagnostics.

## Risks

- **Generic TS for HM types:** curried generics and local polymorphic `let`s must produce
  types TS accepts; unannotatable cases fall back to `unknown` + a cast in generated code.
- **Deep recursion:** strict recursion over long lists can overflow the JS stack;
  `foldr`/`map`/`length` in the runtime are written iteratively. User-written recursion is
  not: one JS frame per call, so depths around 10,000 overflow Node's default stack
  (tested to 5,000).
- **Effect 4 API surface** (`Terminal`, `effect/cli`, `NodeRuntime`) — verify exact
  signatures when wiring milestones 6–7.
