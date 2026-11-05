/**
 * Runs a compiled program in-process with the runtime's test `Terminal`, which feeds it
 * input lines and records what it displays.
 */
import { Effect, Result } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { compile, runtimeSource } from "../../src/compile.ts";

const outDir = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
  ".hs2effect",
  "unit",
  "terminal",
);

test("a compiled program reads and writes through the Terminal service", async () => {
  const source = [
    "main = do",
    '  putStrLn "What is your name?"',
    "  name <- getLine",
    "  n <- getLine",
    '  mapM_ (\\i -> putStrLn (show i ++ " " ++ name)) [1, 2]',
    "  print (length n)",
  ].join("\n");
  const r = compile(source, { fileName: "Main.hs" });
  if (Result.isFailure(r)) throw new Error(r.failure.message);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "Main.ts"), r.success.code);
  writeFileSync(join(outDir, "hs-runtime.ts"), runtimeSource());

  const program = (await import(join(outDir, "Main.ts"))) as {
    main: Effect.Effect<unknown, never, never>;
  };
  const runtime = (await import(
    join(outDir, "hs-runtime.ts")
  )) as typeof import("../../src/runtime/hs-runtime.ts");
  const output: Array<string> = [];
  await Effect.runPromise(
    Effect.provide(program.main, runtime.testTerminal(["Ada", "abc"], output)),
  );
  expect(output.join("")).toBe("What is your name?\n1 Ada\n2 Ada\n3\n");
});
