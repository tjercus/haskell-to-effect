/**
 * Internal type representation for inference.
 *
 * - `TMeta`: a unification variable, solved by setting `ref.link`. Its `level` is the
 *   let-nesting depth at which it was created; generalisation quantifies over metas whose
 *   level is deeper than the enclosing scope.
 * - `TVar`: a rigid (named) type variable. These come from type signatures and from
 *   generalisation, and unify only with themselves.
 * - `TCon`: a fully applied type constructor: `Int`, `Char`, `IO a`, `[] a`, `(,) a b`,
 *   `-> a b`, and user data types.
 */

export interface MetaRef {
  readonly id: number;
  level: number;
  link: Type | undefined;
}

export type Type =
  | { readonly _tag: "TMeta"; readonly ref: MetaRef }
  | { readonly _tag: "TVar"; readonly name: string; readonly id: number; readonly level: number }
  | { readonly _tag: "TCon"; readonly name: string; readonly args: ReadonlyArray<Type> };

export type TVar = Extract<Type, { _tag: "TVar" }>;

/** `forall vars. type` */
export interface Scheme {
  readonly vars: ReadonlyArray<TVar>;
  readonly type: Type;
}

export const con = (name: string, ...args: ReadonlyArray<Type>): Type => ({
  _tag: "TCon",
  name,
  args,
});
export const tInt = con("Int");
export const tChar = con("Char");
export const tBool = con("Bool");
export const tUnit = con("()");
export const tList = (elem: Type): Type => con("[]", elem);
export const tString = tList(tChar);
export const tIO = (a: Type): Type => con("IO", a);
export const tFun = (from: Type, to: Type): Type => con("->", from, to);
export const tFuns = (params: ReadonlyArray<Type>, result: Type): Type =>
  params.reduceRight((acc, p) => tFun(p, acc), result);

export const monoScheme = (type: Type): Scheme => ({ vars: [], type });

/** Follows solved metas at the top of a type. */
export const prune = (t: Type): Type => {
  while (t._tag === "TMeta" && t.ref.link !== undefined) {
    t = t.ref.link;
  }
  return t;
};

/** Replaces all solved metas in a type by their solutions. */
export const zonk = (t: Type): Type => {
  const p = prune(t);
  if (p._tag !== "TCon") {
    return p;
  }
  return p.args.length === 0 ? p : { ...p, args: p.args.map(zonk) };
};

export const isFun = (
  t: Type,
): t is Extract<Type, { _tag: "TCon" }> & { args: readonly [Type, Type] } =>
  t._tag === "TCon" && t.name === "->" && t.args.length === 2;

/** Applies a substitution of rigid variables (by id). */
export const substVars = (t: Type, s: ReadonlyMap<number, Type>): Type => {
  const p = prune(t);
  switch (p._tag) {
    case "TVar":
      return s.get(p.id) ?? p;
    case "TMeta":
      return p;
    case "TCon":
      return p.args.length === 0 ? p : { ...p, args: p.args.map((a) => substVars(a, s)) };
  }
};

// ---- printing ---------------------------------------------------------------------------

/**
 * Prints types consistently: unsolved metas are named `t1`, `t2`, … in order of
 * appearance, and `[Char]` is shown as `String`. Reuse one printer for every type in a
 * message so that names agree.
 */
export class TypePrinter {
  private readonly metaNames = new Map<number, string>();

  print(t: Type): string {
    return this.go(zonk(t), 0);
  }

  /** Prints a scheme with its quantified variables renamed `a`, `b`, … in order of appearance. */
  scheme(s: Scheme): string {
    const renamed = new Map<number, Type>();
    const visit = (t: Type): void => {
      const p = prune(t);
      if (p._tag === "TVar" && s.vars.some((v) => v.id === p.id) && !renamed.has(p.id)) {
        const name =
          renamed.size < 26 ? String.fromCharCode(97 + renamed.size) : `t${renamed.size - 25}`;
        renamed.set(p.id, { _tag: "TVar", name, id: p.id, level: p.level });
      } else if (p._tag === "TCon") {
        for (const a of p.args) {
          visit(a);
        }
      }
    };
    visit(s.type);
    return this.print(substVars(s.type, renamed));
  }

  // ctx: 0 = anywhere, 1 = left of an arrow, 2 = type argument
  private go(t: Type, ctx: number): string {
    switch (t._tag) {
      case "TVar":
        return t.name;
      case "TMeta": {
        let name = this.metaNames.get(t.ref.id);
        if (name === undefined) {
          name = `t${this.metaNames.size + 1}`;
          this.metaNames.set(t.ref.id, name);
        }
        return name;
      }
      case "TCon": {
        const [a, b] = t.args;
        if (t.name === "->" && a && b) {
          const s = `${this.go(a, 1)} -> ${this.go(b, 0)}`;
          return ctx > 0 ? `(${s})` : s;
        }
        if (t.name === "[]" && a) {
          const elem = prune(a);
          if (elem._tag === "TCon" && elem.name === "Char") {
            return "String";
          }
          return `[${this.go(a, 0)}]`;
        }
        if (/^\(,+\)$/.test(t.name)) {
          return `(${t.args.map((x) => this.go(x, 0)).join(", ")})`;
        }
        if (t.args.length === 0) {
          return t.name;
        }
        const s = [t.name, ...t.args.map((x) => this.go(x, 2))].join(" ");
        return ctx > 1 ? `(${s})` : s;
      }
    }
  }
}

export const showType = (t: Type): string => new TypePrinter().print(t);
export const showScheme = (s: Scheme): string => new TypePrinter().scheme(s);
