import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    entry: ["src/index.ts", "src/cli.ts"],
    // The runtime is copied next to every compiled program, so it ships as source.
    copy: [{ from: "src/runtime/hs-runtime.ts", to: "dist/runtime" }],
    deps: {
      // tsdown <0.23 compatibility: resolve external dependency subpaths.
      // Remove to preserve subpath imports as written (the new default).
      // https://tsdown.dev/options/dependencies#deps-resolvedepsubpath
      resolveDepSubpath: true,
    },
    dts: {
      generator: "tsgo",
    },
    exports: true,
  },
  lint: {
    rules: {
      // Always brace the bodies of `if`, `else`, `for` and `while`, even one-line returns.
      curly: ["error", "all"],
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
