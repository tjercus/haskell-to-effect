# Agent notes

## Working with Effect

Use the Effect source in `./docs/repos/effect` when working with Effect: reading its API,
checking signatures, or looking up how something is done. Prefer it over memory and web
searches, because Effect 4 differs a lot from Effect 3.

- **What it is:** a clone of https://github.com/Effect-TS/effect, checked out at the tag
  that matches the installed `effect` version (`effect@4.1.4`). It is git-ignored.
- **Where to look:**
  - `packages/effect/src/`: the `effect` package. Unstable modules, such as `cli`, are in
    subdirectories.
  - `packages/platform/node/`: `@effect/platform-node`.
  - `LLMS.md` and `MIGRATION.md` at the repository root: usage guidance and the changes
    from Effect 3.
- **If the directory is missing,** clone it again:
  `git clone --depth 1 --branch effect@<version> https://github.com/Effect-TS/effect.git docs/repos/effect`
- **After upgrading `effect`:** check out the matching tag, so the source matches the code
  that runs:
  `git -C docs/repos/effect fetch --depth 1 origin tag effect@<version> && git -C docs/repos/effect checkout effect@<version>`
