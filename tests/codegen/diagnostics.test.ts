import { Result } from "effect";
import { expect, test } from "vite-plus/test";
import { compile, formatDiagnostic, formatError } from "../../src/compile.ts";

test("errors are formatted with the offending source line", () => {
  const source = ["main = do", "  print (1 + True)"].join("\n");
  const r = compile(source, { fileName: "Main.hs" });
  if (Result.isSuccess(r)) {
    throw new Error("expected an error");
  }
  expect(formatError(r.failure, source, "Main.hs")).toBe(
    [
      "Main.hs:2:14: error: couldn't match expected type 'Int' with actual type 'Bool' in argument 2 of '+'",
      "  |",
      "2 |   print (1 + True)",
      "  |              ^^^^",
    ].join("\n"),
  );
});

test("warnings use the same format", () => {
  const source = ["data C = R | G", "f R = 1", "main = print (f G)"].join("\n");
  const r = compile(source, { fileName: "Main.hs" });
  if (Result.isFailure(r)) {
    throw new Error(r.failure.message);
  }
  const [w] = r.success.warnings;
  if (w === undefined) {
    throw new Error("expected a warning");
  }
  expect(formatDiagnostic("warning", w, source, "Main.hs")).toBe(
    [
      "Main.hs:2:1: warning: pattern match is non-exhaustive in function 'f'; patterns not matched: G",
      "  |",
      "2 | f R = 1",
      "  | ^^^^^^^",
    ].join("\n"),
  );
});

test("errors from every phase carry a location", () => {
  const cases = ['main = "unterminated', "main = (1 +", "main = undefinedName", "main = 1 + 'c'"];
  for (const source of cases) {
    const r = compile(source, { fileName: "Main.hs" });
    expect(Result.isFailure(r) && r.failure.span.start.line).toBe(1);
  }
});
