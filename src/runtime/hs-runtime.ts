/**
 * Runtime for programs compiled by haskell-to-effect.
 *
 * Value representation:
 *   Int → number, Bool → boolean, Char → one-character string, () → undefined,
 *   [a] → List<A> (immutable cons cells), (a, b) → readonly [A, B],
 *   data types → { _tag: "Con", a0, a1, … }, IO a → Effect<A>.
 *
 * Curried Prelude functions take their type parameters in the order in which the type
 * variables first appear in the Haskell signature (see src/prelude.ts); generated code passes
 * explicit type arguments in that order.
 *
 * This file is copied next to every compiled module, so it only uses erasable TypeScript
 * syntax and depends on nothing but `effect`.
 */
import { Cause, Effect, Exit } from "effect";

// ---- representation -----------------------------------------------------------------

export type Char = string;
export type List<A> =
  | { readonly _tag: "Nil" }
  | { readonly _tag: "Cons"; readonly head: A; readonly tail: List<A> };
export type IO<A> = Effect.Effect<A>;
export type Maybe<A> = { readonly _tag: "Nothing" } | { readonly _tag: "Just"; readonly a0: A };
export type Either<A, B> =
  | { readonly _tag: "Left"; readonly a0: A }
  | { readonly _tag: "Right"; readonly a0: B };

export const Nil: List<never> = { _tag: "Nil" };
export const Cons = <A>(head: A, tail: List<A>): List<A> => ({ _tag: "Cons", head, tail });
export const cons =
  <A>(head: A) =>
  (tail: List<A>): List<A> =>
    Cons(head, tail);

export const Nothing: Maybe<never> = { _tag: "Nothing" };
export const Just = <A>(a0: A): Maybe<A> => ({ _tag: "Just", a0 });
export const Left = <A, B>(a0: A): Either<A, B> => ({ _tag: "Left", a0 });
export const Right = <A, B>(a0: B): Either<A, B> => ({ _tag: "Right", a0 });

export const fromArray = <A>(xs: ReadonlyArray<A>): List<A> => {
  let list: List<A> = Nil;
  for (let i = xs.length - 1; i >= 0; i--) list = Cons(xs[i] as A, list);
  return list;
};

export const toArray = <A>(list: List<A>): Array<A> => {
  const out: Array<A> = [];
  for (let l = list; l._tag === "Cons"; l = l.tail) out.push(l.head);
  return out;
};

/** A JS string as a Haskell `String`. */
export const str = (s: string): List<Char> => fromArray(Array.from(s));

/** A Haskell `String` as a JS string. */
export const toJs = (s: List<Char>): string => toArray(s).join("");

// ---- errors -------------------------------------------------------------------------

/** A Haskell runtime error: `error`, a failed pattern match, `head []`, … */
export class HaskellError extends Error {
  override readonly name = "HaskellError";
}

export const patternFail = (message: string): never => {
  throw new HaskellError(message);
};

export const error = <A>(message: List<Char>): A => {
  throw new HaskellError(toJs(message));
};

// ---- constructor order (for compare) ------------------------------------------------------

const constructorIndex = new Map<string, number>([
  ["Nil", 0],
  ["Cons", 1],
  ["Nothing", 0],
  ["Just", 1],
  ["Left", 0],
  ["Right", 1],
]);

/** Records the declaration order of a data type's constructors. */
export const registerConstructors = (names: ReadonlyArray<string>): void => {
  names.forEach((n, i) => constructorIndex.set(n, i));
};

// ---- structural equality and ordering -------------------------------------------------------

type Tagged = { readonly _tag: string } & Record<string, unknown>;

const isTagged = (x: unknown): x is Tagged => typeof x === "object" && x !== null && "_tag" in x;

const fields = (x: Tagged): Array<unknown> => {
  const out: Array<unknown> = [];
  for (let i = 0; `a${i}` in x; i++) out.push(x[`a${i}`]);
  return out;
};

/** Structural comparison: negative, zero or positive. */
export const compareAny = (a: unknown, b: unknown): number => {
  if (typeof a === "function" || typeof b === "function") {
    throw new HaskellError("cannot compare functions");
  }
  if (typeof a === "number" || typeof a === "string" || typeof a === "boolean") {
    return a < (b as typeof a) ? -1 : a > (b as typeof a) ? 1 : 0;
  }
  if (a === undefined) return 0;
  if (Array.isArray(a)) {
    const bs = b as ReadonlyArray<unknown>;
    for (let i = 0; i < a.length; i++) {
      const c = compareAny(a[i], bs[i]);
      if (c !== 0) return c;
    }
    return 0;
  }
  if (isTagged(a) && isTagged(b)) {
    // Walk list spines iteratively so that long lists do not overflow the stack.
    let x: Tagged = a;
    let y: Tagged = b;
    while (x._tag === "Cons" && y._tag === "Cons") {
      const c = compareAny(x["head"], y["head"]);
      if (c !== 0) return c;
      x = x["tail"] as Tagged;
      y = y["tail"] as Tagged;
    }
    if (x._tag !== y._tag)
      return (constructorIndex.get(x._tag) ?? 0) - (constructorIndex.get(y._tag) ?? 0);
    const fx = fields(x);
    const fy = fields(y);
    for (let i = 0; i < fx.length; i++) {
      const c = compareAny(fx[i], fy[i]);
      if (c !== 0) return c;
    }
    return 0;
  }
  return 0;
};

export const equals = (a: unknown, b: unknown): boolean => compareAny(a, b) === 0;

export const eq =
  <A>(a: A) =>
  (b: A): boolean =>
    equals(a, b);
export const neq =
  <A>(a: A) =>
  (b: A): boolean =>
    !equals(a, b);
export const lt =
  <A>(a: A) =>
  (b: A): boolean =>
    compareAny(a, b) < 0;
export const le =
  <A>(a: A) =>
  (b: A): boolean =>
    compareAny(a, b) <= 0;
export const gt =
  <A>(a: A) =>
  (b: A): boolean =>
    compareAny(a, b) > 0;
export const ge =
  <A>(a: A) =>
  (b: A): boolean =>
    compareAny(a, b) >= 0;
export const max =
  <A>(a: A) =>
  (b: A): A =>
    compareAny(a, b) >= 0 ? a : b;
export const min =
  <A>(a: A) =>
  (b: A): A =>
    compareAny(a, b) <= 0 ? a : b;

// ---- arithmetic and booleans ------------------------------------------------------------

export const add =
  (a: number) =>
  (b: number): number =>
    a + b;
export const sub =
  (a: number) =>
  (b: number): number =>
    a - b;
export const mul =
  (a: number) =>
  (b: number): number =>
    a * b;

/** `div`: integer division rounding towards negative infinity. */
export const divInt = (a: number, b: number): number => {
  if (b === 0) throw new HaskellError("divide by zero");
  return Math.floor(a / b);
};

/** `mod`: the result has the sign of the divisor. */
export const modInt = (a: number, b: number): number => {
  if (b === 0) throw new HaskellError("divide by zero");
  return ((a % b) + b) % b;
};

export const div =
  (a: number) =>
  (b: number): number =>
    divInt(a, b);
export const mod =
  (a: number) =>
  (b: number): number =>
    modInt(a, b);
export const negate = (a: number): number => -a;
export const abs = (a: number): number => Math.abs(a);

export const and =
  (a: boolean) =>
  (b: boolean): boolean =>
    a && b;
export const or =
  (a: boolean) =>
  (b: boolean): boolean =>
    a || b;
export const not = (a: boolean): boolean => !a;

// ---- lists ------------------------------------------------------------------------------

export const map =
  <A, B>(f: (a: A) => B) =>
  (xs: List<A>): List<B> =>
    fromArray(toArray(xs).map((x) => f(x)));

export const filter =
  <A>(p: (a: A) => boolean) =>
  (xs: List<A>): List<A> =>
    fromArray(toArray(xs).filter((x) => p(x)));

export const foldr =
  <A, B>(f: (a: A) => (b: B) => B) =>
  (z: B) =>
  (xs: List<A>): B => {
    const arr = toArray(xs);
    let acc = z;
    for (let i = arr.length - 1; i >= 0; i--) acc = f(arr[i] as A)(acc);
    return acc;
  };

export const foldl =
  <B, A>(f: (b: B) => (a: A) => B) =>
  (z: B) =>
  (xs: List<A>): B => {
    let acc = z;
    for (let l = xs; l._tag === "Cons"; l = l.tail) acc = f(acc)(l.head);
    return acc;
  };

export const length = <A>(xs: List<A>): number => {
  let n = 0;
  for (let l = xs; l._tag === "Cons"; l = l.tail) n++;
  return n;
};

export const head = <A>(xs: List<A>): A => {
  if (xs._tag === "Nil") throw new HaskellError("Prelude.head: empty list");
  return xs.head;
};

export const tail = <A>(xs: List<A>): List<A> => {
  if (xs._tag === "Nil") throw new HaskellError("Prelude.tail: empty list");
  return xs.tail;
};

export const null_ = <A>(xs: List<A>): boolean => xs._tag === "Nil";

export const reverse = <A>(xs: List<A>): List<A> => {
  let out: List<A> = Nil;
  for (let l = xs; l._tag === "Cons"; l = l.tail) out = Cons(l.head, out);
  return out;
};

export const appendList = <A>(xs: List<A>, ys: List<A>): List<A> => {
  if (ys._tag === "Nil") return xs;
  const arr = toArray(xs);
  let out: List<A> = ys;
  for (let i = arr.length - 1; i >= 0; i--) out = Cons(arr[i] as A, out);
  return out;
};

export const append =
  <A>(xs: List<A>) =>
  (ys: List<A>): List<A> =>
    appendList(xs, ys);

export const concat = <A>(xss: List<List<A>>): List<A> => fromArray(toArray(xss).flatMap(toArray));

export const concatMap =
  <A, B>(f: (a: A) => List<B>) =>
  (xs: List<A>): List<B> =>
    fromArray(toArray(xs).flatMap((x) => toArray(f(x))));

export const sum = (xs: List<number>): number => toArray(xs).reduce((a, b) => a + b, 0);
export const product = (xs: List<number>): number => toArray(xs).reduce((a, b) => a * b, 1);

export const take =
  <A>(n: number) =>
  (xs: List<A>): List<A> => {
    const out: Array<A> = [];
    for (let l = xs; l._tag === "Cons" && out.length < n; l = l.tail) out.push(l.head);
    return fromArray(out);
  };

export const drop =
  <A>(n: number) =>
  (xs: List<A>): List<A> => {
    let l = xs;
    for (let i = 0; i < n && l._tag === "Cons"; i++) l = l.tail;
    return l;
  };

export const replicate =
  <A>(n: number) =>
  (x: A): List<A> =>
    fromArray(Array.from({ length: Math.max(0, n) }, () => x));

export const zip =
  <A, B>(xs: List<A>) =>
  (ys: List<B>): List<readonly [A, B]> => {
    const out: Array<readonly [A, B]> = [];
    let a = xs;
    let b = ys;
    while (a._tag === "Cons" && b._tag === "Cons") {
      out.push([a.head, b.head]);
      a = a.tail;
      b = b.tail;
    }
    return fromArray(out);
  };

export const elem =
  <A>(x: A) =>
  (xs: List<A>): boolean => {
    for (let l = xs; l._tag === "Cons"; l = l.tail) if (equals(x, l.head)) return true;
    return false;
  };

export const lines = (s: List<Char>): List<List<Char>> => {
  const js = toJs(s);
  if (js === "") return Nil;
  const parts = js.split("\n");
  if (js.endsWith("\n")) parts.pop();
  return fromArray(parts.map(str));
};

export const words = (s: List<Char>): List<List<Char>> =>
  fromArray(
    toJs(s)
      .split(/\s+/)
      .filter((w) => w !== "")
      .map(str),
  );

export const unlines = (ls: List<List<Char>>): List<Char> =>
  str(
    toArray(ls)
      .map((l) => `${toJs(l)}\n`)
      .join(""),
  );

export const unwords = (ws: List<List<Char>>): List<Char> => str(toArray(ws).map(toJs).join(" "));

// ---- tuples and functions ------------------------------------------------------------------

export const fst = <A, B>(p: readonly [A, B]): A => p[0];
export const snd = <A, B>(p: readonly [A, B]): B => p[1];
export const id = <A>(x: A): A => x;
export const const_ =
  <A, B>(x: A): ((y: B) => A) =>
  () =>
    x;
export const compose =
  <B, C, A>(f: (b: B) => C) =>
  (g: (a: A) => B) =>
  (x: A): C =>
    f(g(x));
export const apply =
  <A, B>(f: (a: A) => B) =>
  (x: A): B =>
    f(x);
export const flip =
  <A, B, C>(f: (a: A) => (b: B) => C) =>
  (y: B) =>
  (x: A): C =>
    f(x)(y);

// ---- show ---------------------------------------------------------------------------------

/** Renders a value at a precedence (as Haskell's `showsPrec`). */
export type Shower<A> = (prec: number, x: A) => string;

const asciiNames = [
  "NUL",
  "SOH",
  "STX",
  "ETX",
  "EOT",
  "ENQ",
  "ACK",
  "a",
  "b",
  "t",
  "n",
  "v",
  "f",
  "r",
  "SO",
  "SI",
  "DLE",
  "DC1",
  "DC2",
  "DC3",
  "DC4",
  "NAK",
  "SYN",
  "ETB",
  "CAN",
  "EM",
  "SUB",
  "ESC",
  "FS",
  "GS",
  "RS",
  "US",
];

/** Escapes one character as GHC's `showLitChar` does; `next` decides whether `\&` is needed. */
const escapeChar = (c: string, next: string | undefined, quote: '"' | "'"): string => {
  const cp = c.codePointAt(0) ?? 0;
  if (c === "\\") return "\\\\";
  if (c === quote) return `\\${quote}`;
  if (cp >= 0x20 && cp < 0x7f) return c;
  if (cp === 0x7f) return "\\DEL";
  if (cp < 0x20) {
    const name = asciiNames[cp] ?? "";
    // "\SO" followed by "H" would read as "\SOH".
    return `\\${name}${name === "SO" && next === "H" ? "\\&" : ""}`;
  }
  return `\\${cp}${next !== undefined && /^[0-9]$/.test(next) ? "\\&" : ""}`;
};

export const showInt: Shower<number> = (p, n) => (n < 0 && p > 6 ? `(${n})` : String(n));
export const showBool: Shower<boolean> = (_, b) => (b ? "True" : "False");
export const showUnit: Shower<undefined> = () => "()";
export const showChar: Shower<Char> = (_, c) => `'${escapeChar(c, undefined, "'")}'`;
export const showFun: Shower<unknown> = () => "<function>";

export const showString: Shower<List<Char>> = (_, s) => {
  const cs = toArray(s);
  return `"${cs.map((c, i) => escapeChar(c, cs[i + 1], '"')).join("")}"`;
};

export const showList =
  <A>(sa: Shower<A>): Shower<List<A>> =>
  (_, xs) =>
    `[${toArray(xs)
      .map((x) => sa(0, x))
      .join(",")}]`;

export const showTuple =
  (ss: ReadonlyArray<Shower<never>>): Shower<ReadonlyArray<unknown>> =>
  (_, xs) =>
    `(${xs.map((x, i) => (ss[i] as Shower<unknown>)(0, x)).join(",")})`;

/** A constructor application: `C f1 … fn`, parenthesised above precedence 10. */
export const showCon = (p: number, name: string, shownFields: ReadonlyArray<string>): string =>
  shownFields.length === 0
    ? name
    : p > 10
      ? `(${name} ${shownFields.join(" ")})`
      : `${name} ${shownFields.join(" ")}`;

export const showMaybe =
  <A>(sa: Shower<A>): Shower<Maybe<A>> =>
  (p, m) =>
    m._tag === "Nothing" ? "Nothing" : showCon(p, "Just", [sa(11, m.a0)]);

export const showEither =
  <A, B>(sa: Shower<A>, sb: Shower<B>): Shower<Either<A, B>> =>
  (p, e) =>
    e._tag === "Left" ? showCon(p, "Left", [sa(11, e.a0)]) : showCon(p, "Right", [sb(11, e.a0)]);

/**
 * Shows a value from its runtime representation, for polymorphic code where the static type
 * is unknown. Ambiguous only for the empty string, which is shown as `[]`.
 */
export const showAny: Shower<unknown> = (p, x) => {
  if (typeof x === "number") return showInt(p, x);
  if (typeof x === "boolean") return showBool(p, x);
  if (typeof x === "string") return showChar(p, x);
  if (typeof x === "function") return "<function>";
  if (x === undefined) return "()";
  if (Array.isArray(x)) return `(${x.map((e) => showAny(0, e)).join(",")})`;
  if (isTagged(x)) {
    if (x._tag === "Nil" || x._tag === "Cons") {
      const items = toArray(x as List<unknown>);
      if (items.length > 0 && items.every((i) => typeof i === "string")) {
        return showString(0, x as List<Char>);
      }
      return `[${items.map((i) => showAny(0, i)).join(",")}]`;
    }
    return showCon(
      p,
      x._tag,
      fields(x).map((f) => showAny(11, f)),
    );
  }
  return "<unknown>";
};

export const show = <A>(x: A): List<Char> => str(showAny(0, x));
export const showWith =
  <A>(s: Shower<A>) =>
  (x: A): List<Char> =>
    str(s(0, x));

// ---- IO ---------------------------------------------------------------------------------

const write = (s: string): IO<undefined> =>
  Effect.sync(() => {
    process.stdout.write(s);
    return undefined;
  });

export const putStr = (s: List<Char>): IO<undefined> => Effect.suspend(() => write(toJs(s)));
export const putStrLn = (s: List<Char>): IO<undefined> =>
  Effect.suspend(() => write(`${toJs(s)}\n`));
export const printWith =
  <A>(s: Shower<A>) =>
  (x: A): IO<undefined> =>
    Effect.suspend(() => write(`${s(0, x)}\n`));
export const print = <A>(x: A): IO<undefined> => printWith<A>(showAny)(x);

export const return_ = <A>(a: A): IO<A> => Effect.succeed(a);
export const pure = return_;

export const bind =
  <A, B>(m: IO<A>) =>
  (f: (a: A) => IO<B>): IO<B> =>
    Effect.flatMap(m, (a) => f(a));

/** `m >> k` where `k` is evaluated only after `m` has run. */
export const then_ = <A, B>(m: IO<A>, k: () => IO<B>): IO<B> => Effect.flatMap(m, () => k());

export const seq_ =
  <A, B>(m: IO<A>) =>
  (k: IO<B>): IO<B> =>
    then_(m, () => k);

export const mapM_ =
  <A, B>(f: (a: A) => IO<B>) =>
  (xs: List<A>): IO<undefined> =>
    Effect.as(
      Effect.forEach(toArray(xs), (x) => f(x), { discard: true }),
      undefined,
    );

/** Defers building an IO action until it runs, so errors while building it happen in order. */
export const suspend = <A>(f: () => IO<A>): IO<A> => Effect.suspend(f);

/** Runs `main`; a Haskell error is reported as `<prog>: <message>` with exit code 1. */
export const runMain = async (main: IO<unknown>, prog: string): Promise<void> => {
  const exit = await Effect.runPromiseExit(main);
  if (Exit.isSuccess(exit)) return;
  const err = Cause.squash(exit.cause);
  process.stderr.write(
    err instanceof HaskellError
      ? `${prog}: ${err.message}\n`
      : `${prog}: ${Cause.pretty(exit.cause)}\n`,
  );
  process.exitCode = 1;
};

/** Loads a compiled module and runs its `main`, reporting errors raised while loading too. */
export const runModule = async (
  load: () => Promise<{ readonly main: IO<unknown> }>,
  prog: string,
): Promise<void> => {
  let mod: { readonly main: IO<unknown> };
  try {
    mod = await load();
  } catch (e) {
    if (!(e instanceof HaskellError)) throw e;
    process.stderr.write(`${prog}: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }
  await runMain(mod.main, prog);
};
