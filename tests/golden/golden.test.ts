/**
 * Golden tests: every `programs/<name>.hs` is compiled, the generated TypeScript is
 * type-checked with `tsc --strict`, and the program is run with Node. Its stdout must equal
 * `<name>.stdout`. If `<name>.stderr` exists, the program must fail with exit code 1 and its
 * stderr must contain that text; otherwise it must succeed with empty stderr. `<name>.stdin`,
 * if present, is fed to the program.
 */
import { Result } from "effect";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { compile, entrySource, formatError, runtimeSource } from "../../src/compile.ts";

const programsDir = fileURLToPath(new URL("./programs/", import.meta.url));
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
// Not under node_modules: Node does not strip types there.
const outRoot = resolve(projectRoot, ".hs2effect", "golden");
const programs = readdirSync(programsDir)
  .filter((f) => f.endsWith(".hs"))
  .map((f) => f.slice(0, -3))
  .toSorted();

const optional = (file: string): string | undefined =>
  existsSync(file) ? readFileSync(file, "utf8") : undefined;

let tsc: { status: number | null; output: string } = { status: null, output: "" };

beforeAll(() => {
  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });
  for (const name of programs) {
    const fileName = `${name}.hs`;
    const source = readFileSync(join(programsDir, fileName), "utf8");
    const result = compile(source, { fileName });
    if (Result.isFailure(result)) throw new Error(formatError(result.failure, source, fileName));
    const dir = join(outRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.ts`), result.success.code);
    writeFileSync(join(dir, "hs-runtime.ts"), runtimeSource());
    writeFileSync(join(dir, "run.ts"), entrySource(`${name}.ts`, name));
  }
  writeFileSync(
    join(outRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "esnext",
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
        erasableSyntaxOnly: true,
        skipLibCheck: true,
        types: ["node"],
      },
      include: ["**/*.ts"],
    }),
  );
  const r = spawnSync(join(projectRoot, "node_modules", ".bin", "tsc"), ["-p", outRoot], {
    encoding: "utf8",
  });
  tsc = { status: r.status, output: `${r.stdout}${r.stderr}` };
}, 120_000);

describe("golden programs", () => {
  test("the generated code passes tsc --strict", () => {
    expect(tsc.output).toBe("");
    expect(tsc.status).toBe(0);
  });

  test.each(programs)("%s", (name) => {
    const expectedStdout = readFileSync(join(programsDir, `${name}.stdout`), "utf8");
    const expectedStderr = optional(join(programsDir, `${name}.stderr`));
    const stdin = optional(join(programsDir, `${name}.stdin`));
    const r = spawnSync(process.execPath, [join(outRoot, name, "run.ts")], {
      encoding: "utf8",
      input: stdin ?? "",
      timeout: 30_000,
    });
    expect(r.stdout).toBe(expectedStdout);
    if (expectedStderr === undefined) {
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    } else {
      expect(r.stderr).toContain(expectedStderr.trim());
      expect(r.status).toBe(1);
    }
  });
});
