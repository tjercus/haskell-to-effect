#!/usr/bin/env node
/**
 * hs2effect: compile a Haskell module to TypeScript on Effect, and run it.
 *
 *   hs2effect check   <file.hs>
 *   hs2effect compile <file.hs> [--out <dir>]
 *   hs2effect run     <file.hs>
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Path, Result } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";
import {
  type Compiled,
  compile,
  entrySource,
  formatDiagnostic,
  formatError,
  runtimeSource,
} from "./compile.ts";

const sourceFile = Argument.File("file", { mustExist: true }).pipe(
  Argument.withDescription("The Haskell source file (.hs)"),
);

/** Compiles a file; on error prints the diagnostic and sets a failing exit code. */
const compileFile = Effect.fn("compileFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* fs.readFileString(file);
  const fileName = path.basename(file);
  const result = compile(source, { fileName });
  if (Result.isFailure(result)) {
    yield* Console.error(formatError(result.failure, source, file));
    process.exitCode = 1;
    return Option.none<{ compiled: Compiled; moduleName: string }>();
  }
  for (const w of result.success.warnings) {
    yield* Console.error(formatDiagnostic("warning", w, source, file));
  }
  const moduleName = fileName.replace(/\.l?hs$/, "");
  return Option.some({ compiled: result.success, moduleName });
});

/** Writes `<Module>.ts`, `hs-runtime.ts` and `run.ts` to `dir`. Returns the entry file. */
const writeOutput = Effect.fn("writeOutput")(function* (
  dir: string,
  compiled: Compiled,
  moduleName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(dir, { recursive: true });
  const moduleFile = `${moduleName}.ts`;
  yield* fs.writeFileString(path.join(dir, moduleFile), compiled.code);
  yield* fs.writeFileString(path.join(dir, "hs-runtime.ts"), runtimeSource());
  const entry = path.join(dir, "run.ts");
  yield* fs.writeFileString(entry, entrySource(moduleFile, moduleName));
  return entry;
});

const check = Command.make(
  "check",
  { file: sourceFile },
  Effect.fn("check")(function* ({ file }) {
    const result = yield* compileFile(file);
    if (Option.isSome(result)) {
      yield* Console.log(`${file}: OK`);
    }
  }),
).pipe(Command.withDescription("Parse and type-check a Haskell module"));

const compileCommand = Command.make(
  "compile",
  {
    file: sourceFile,
    out: Flag.Directory("out").pipe(
      Flag.withAlias("o"),
      Flag.withDescription("Output directory (default: the source file's directory)"),
      Flag.optional,
    ),
  },
  Effect.fn("compile")(function* ({ file, out }) {
    const path = yield* Path.Path;
    const result = yield* compileFile(file);
    if (Option.isNone(result)) {
      return;
    }
    const dir = Option.getOrElse(out, () => path.dirname(file));
    const entry = yield* writeOutput(dir, result.value.compiled, result.value.moduleName);
    yield* Console.log(
      `Wrote ${path.join(dir, `${result.value.moduleName}.ts`)}; run it with: node ${entry}`,
    );
  }),
).pipe(Command.withDescription("Compile a Haskell module to TypeScript"));

const run = Command.make(
  "run",
  { file: sourceFile },
  Effect.fn("run")(function* ({ file }) {
    const path = yield* Path.Path;
    const result = yield* compileFile(file);
    if (Option.isNone(result)) {
      return;
    }
    // Compile into the package directory, so that the generated code can resolve `effect`.
    // (Node does not strip types from files under node_modules.)
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const dir = path.join(packageRoot, ".hs2effect", "run", result.value.moduleName);
    const entry = yield* writeOutput(dir, result.value.compiled, result.value.moduleName);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    process.exitCode = yield* spawner.exitCode(
      ChildProcess.make(process.execPath, [entry], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
  }),
).pipe(Command.withDescription("Compile and run a Haskell module"));

const hs2effect = Command.make("hs2effect").pipe(
  Command.withDescription("Compile a small subset of Haskell to TypeScript on Effect"),
  Command.withSubcommands([check, compileCommand, run]),
);

Command.run(hs2effect, { version: "0.1.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
