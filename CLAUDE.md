<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Running Scripts

Run TypeScript and JavaScript files with `vpx <file>`, for example `vpx ./scripts/seed.ts --dry-run`. It handles enums, decorators, JSX, and tsconfig `paths`, so do not add `tsx` or `ts-node` to run scripts. `vpx --watch <file>` reruns the file when a file it uses changes, in place of `tsx watch`. `vp node <file>` runs plain Node.js.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# This project: haskell-to-effect

A compiler from a Haskell subset to typed TypeScript on Effect. See `README.md` for the
language and its differences from Haskell, and `PLAN.md` for design decisions.

Notes for agents, including where to find the Effect source (`./docs/repos/effect`), are in
@AGENTS.md.

- Pipeline: `src/syntax` (lexer, layout, parser) → `src/core` (lowering to Core) →
  `src/types` (inference) → `src/codegen` (decision trees, TypeScript) → `src/compile.ts`.
  The CLI is `src/cli.ts`; the runtime copied next to compiled programs is
  `src/runtime/hs-runtime.ts` (erasable TypeScript only, depends only on `effect`).
- Every program in the subset must stay valid Haskell, and behave as under GHC except for
  the documented differences (strict evaluation, no type classes, 53-bit `Int`, …).
- Prelude functions are declared with Haskell types in `src/prelude.ts` and implemented in
  the runtime, with type parameters in the order the type variables first appear.
- Golden tests (`tests/golden/programs/*.hs`) check that generated code passes
  `tsc --strict` and prints the expected output; expected outputs are what GHC prints,
  written by hand. Generated output goes to `.hs2effect/` (git-ignored), never under
  `node_modules` (Node does not strip types there).
- Core and type snapshots use inline snapshots; review them when they change.
