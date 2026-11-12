/**
 * Pattern-match compilation: a `Match` (ordered clauses of nested patterns) becomes a
 * decision tree, using the matrix algorithm of Maranget, "Compiling Pattern Matching to
 * Good Decision Trees" (2008), with the first-row column heuristic.
 *
 * Every value is tested at most once on any path through the tree. Clause order is
 * preserved: a row is only reached when all earlier rows that could match have failed.
 * A clause with guards gets a fallback subtree, compiled from the rows after it, which runs
 * when all its guards fail.
 *
 * The compiler also finds what the match misses (a witness pattern for every `Fail` leaf)
 * and which clauses are unreachable.
 */
import type { CPat, DataInfo, Name } from "../core/core.ts";
import type { Literal } from "../syntax/ast.ts";
import { prettyLiteral } from "../syntax/pretty.ts";
import { tupleArity } from "../prelude.ts";

/** A value being matched: a JS expression that reads it, such as `arg.tail.head`. */
export type Occurrence = string;

export interface Binding {
  readonly name: Name;
  readonly occ: Occurrence;
}

export type SwitchKind = "tag" | "bool" | "literal";

export type Decision =
  /** No clause matches. */
  | { readonly _tag: "Fail" }
  /** Clause `clause` matches; `fallback` runs if its guards all fail. */
  | {
      readonly _tag: "Leaf";
      readonly clause: number;
      readonly bindings: ReadonlyArray<Binding>;
      readonly fallback: Decision | undefined;
    }
  /** Tests `occ`. Without `default`, the cases are exhaustive. */
  | {
      readonly _tag: "Switch";
      readonly occ: Occurrence;
      readonly kind: SwitchKind;
      readonly cases: ReadonlyArray<{ readonly test: string; readonly body: Decision }>;
      readonly default: Decision | undefined;
    };

export interface CompiledMatch {
  readonly tree: Decision;
  /** Clauses that some leaf of the tree reaches. */
  readonly reachable: ReadonlySet<number>;
  /** For every way the match can fail, a witness: one pattern per scrutinee. */
  readonly missing: ReadonlyArray<ReadonlyArray<string>>;
}

/** How a constructor is represented and tested. */
interface Con {
  readonly name: string;
  readonly arity: number;
  /** The `_tag` (for "tag"), `true`/`false` (for "bool"), or `undefined` for products. */
  readonly test: string | undefined;
  readonly child: (occ: Occurrence, i: number) => Occurrence;
}

/** The constructors of a type: `all` in declaration order (`undefined` if infinite). */
interface Signature {
  readonly kind: SwitchKind | "product";
  readonly all: ReadonlyArray<string> | undefined;
}

interface Row {
  /** One pattern per occurrence; `undefined` is a wildcard. */
  readonly pats: ReadonlyArray<CPat | undefined>;
  readonly clause: number;
  readonly bindings: ReadonlyArray<Binding>;
}

/** What is known about an occurrence on the current path, for building witnesses. */
type Fact =
  | { readonly _tag: "Is"; readonly con: string; readonly children: ReadonlyArray<Occurrence> }
  | { readonly _tag: "IsLit"; readonly lit: Literal }
  | { readonly _tag: "Not"; readonly cons: ReadonlyArray<string>; readonly sig: Signature };

const field = (occ: Occurrence, i: number): Occurrence => `${occ}.a${i}`;

const noSpan = { start: { offset: 0, line: 0, col: 0 }, end: { offset: 0, line: 0, col: 0 } };

/** `"ab"` as the pattern `'a' : 'b' : []`, so string literals combine with list patterns. */
const expandString = (value: string): CPat =>
  Array.from(value).reduceRight<CPat>(
    (tail, c) => ({
      _tag: "PCon",
      name: ":",
      args: [{ _tag: "PLit", lit: { _tag: "Char", value: c }, span: noSpan }, tail],
      span: noSpan,
    }),
    { _tag: "PCon", name: "[]", args: [], span: noSpan },
  );

export class MatchCompiler {
  private readonly cons = new Map<string, { readonly data: DataInfo; readonly index: number }>();
  private readonly reachable = new Set<number>();
  private readonly missing: Array<Array<string>> = [];
  private roots: ReadonlyArray<Occurrence> = [];
  private guarded: ReadonlyArray<boolean> = [];

  constructor(data: ReadonlyArray<DataInfo>) {
    for (const d of data) {
      d.constructors.forEach((c, index) => this.cons.set(c.name, { data: d, index }));
    }
  }

  /**
   * Compiles clauses (`pats` per clause, one per scrutinee) to a decision tree. `guarded[i]`
   * says whether clause `i` can fall through (because all its guards fail).
   */
  compile(
    scrutinees: ReadonlyArray<Occurrence>,
    clauses: ReadonlyArray<ReadonlyArray<CPat>>,
    guarded: ReadonlyArray<boolean>,
  ): CompiledMatch {
    this.reachable.clear();
    this.missing.length = 0;
    this.roots = scrutinees;
    this.guarded = guarded;
    const rows = clauses.map((pats, clause): Row => ({ pats, clause, bindings: [] }));
    const tree = this.rows(scrutinees, rows, new Map());
    return { tree, reachable: new Set(this.reachable), missing: [...this.missing] };
  }

  // ---- signatures -----------------------------------------------------------------------

  private signature(con: string): Signature {
    if (con === "True" || con === "False") {
      return { kind: "bool", all: ["False", "True"] };
    }
    if (con === "[]" || con === ":") {
      return { kind: "tag", all: ["[]", ":"] };
    }
    if (con === "()" || tupleArity(con) !== undefined) {
      return { kind: "product", all: [con] };
    }
    const info = this.cons.get(con);
    if (info === undefined) {
      return { kind: "tag", all: undefined };
    }
    return { kind: "tag", all: info.data.constructors.map((c) => c.name) };
  }

  private con(name: string): Con {
    switch (name) {
      case "True":
      case "False":
        return { name, arity: 0, test: name === "True" ? "true" : "false", child: field };
      case "[]":
        return { name, arity: 0, test: "Nil", child: field };
      case ":":
        return {
          name,
          arity: 2,
          test: "Cons",
          child: (occ, i) => `${occ}.${i === 0 ? "head" : "tail"}`,
        };
      case "()":
        return { name, arity: 0, test: undefined, child: field };
    }
    const tuple = tupleArity(name);
    if (tuple !== undefined) {
      return { name, arity: tuple, test: undefined, child: (occ, i) => `${occ}[${i}]` };
    }
    const info = this.cons.get(name);
    return {
      name,
      arity: info?.data.constructors[info.index]?.fields.length ?? 0,
      test: name,
      child: field,
    };
  }

  // ---- the matrix algorithm ------------------------------------------------------------------

  /** Moves variable and as-patterns into bindings, and expands string literals. */
  private normalize(occs: ReadonlyArray<Occurrence>, row: Row): Row {
    const bindings = [...row.bindings];
    const pats = row.pats.map((p0, i) => {
      let p = p0;
      for (;;) {
        if (p === undefined || p._tag === "PWildcard") {
          return undefined;
        }
        if (p._tag === "PVar") {
          bindings.push({ name: p.name, occ: occs[i] ?? "" });
          return undefined;
        }
        if (p._tag === "PAs") {
          bindings.push({ name: p.name, occ: occs[i] ?? "" });
          p = p.pat;
          continue;
        }
        if (p._tag === "PLit" && p.lit._tag === "String") {
          p = expandString(p.lit.value);
          continue;
        }
        return p;
      }
    });
    return { pats, clause: row.clause, bindings };
  }

  private rows(
    occs: ReadonlyArray<Occurrence>,
    rows0: ReadonlyArray<Row>,
    facts: ReadonlyMap<Occurrence, Fact>,
  ): Decision {
    const rows = rows0.map((r) => this.normalize(occs, r));
    const [first, ...rest] = rows;
    if (first === undefined) {
      this.missing.push(this.roots.map((r) => this.witness(r, facts, this.roots.length === 1)));
      return { _tag: "Fail" };
    }
    const col = first.pats.findIndex((p) => p !== undefined);
    if (col === -1) {
      this.reachable.add(first.clause);
      const fallback =
        this.guarded[first.clause] === true ? this.rows(occs, rest, facts) : undefined;
      return { _tag: "Leaf", clause: first.clause, bindings: first.bindings, fallback };
    }

    const occ = occs[col] ?? "";
    const head = first.pats[col];
    if (head === undefined) {
      return { _tag: "Fail" };
    }

    if (head._tag === "PLit") {
      return this.literalSwitch(occs, rows, col, facts);
    }

    const name = head._tag === "PCon" ? head.name : "";
    const sig = this.signature(name);
    if (sig.kind === "product") {
      // A single-constructor type: no test, just look inside.
      const c = this.con(name);
      const children = Array.from({ length: c.arity }, (_, i) => c.child(occ, i));
      const next = new Map(facts).set(occ, { _tag: "Is", con: name, children });
      return this.rows(
        this.expandOccs(occs, col, children),
        this.specialize(rows, col, name, c.arity),
        next,
      );
    }

    // Constructors that appear in the column, in declaration order.
    const present = new Set<string>();
    for (const r of rows) {
      const p = r.pats[col];
      if (p?._tag === "PCon") {
        present.add(p.name);
      }
    }
    const heads = (sig.all ?? [...present]).filter((c) => present.has(c));
    const cases = heads.map((h) => {
      const c = this.con(h);
      const children = Array.from({ length: c.arity }, (_, i) => c.child(occ, i));
      const next = new Map(facts).set(occ, { _tag: "Is", con: h, children });
      return {
        test: c.test ?? h,
        body: this.rows(
          this.expandOccs(occs, col, children),
          this.specialize(rows, col, h, c.arity),
          next,
        ),
      };
    });
    const complete = sig.all !== undefined && sig.all.every((c) => present.has(c));
    const fallback = complete
      ? undefined
      : this.rows(
          this.expandOccs(occs, col, []),
          this.defaults(rows, col),
          new Map(facts).set(occ, { _tag: "Not", cons: heads, sig }),
        );
    return {
      _tag: "Switch",
      occ,
      kind: sig.kind === "bool" ? "bool" : "tag",
      cases,
      default: fallback,
    };
  }

  private literalSwitch(
    occs: ReadonlyArray<Occurrence>,
    rows: ReadonlyArray<Row>,
    col: number,
    facts: ReadonlyMap<Occurrence, Fact>,
  ): Decision {
    const occ = occs[col] ?? "";
    const lits: Array<Literal> = [];
    for (const r of rows) {
      const p = r.pats[col];
      if (p?._tag === "PLit" && !lits.some((l) => l.value === p.lit.value)) {
        lits.push(p.lit);
      }
    }
    const cases = lits.map((lit) => {
      const keep = rows.flatMap((r): Array<Row> => {
        const p = r.pats[col];
        if (p !== undefined && !(p._tag === "PLit" && p.lit.value === lit.value)) {
          return [];
        }
        return [{ ...r, pats: r.pats.filter((_, i) => i !== col) }];
      });
      return {
        test: lit._tag === "Int" ? String(lit.value) : JSON.stringify(lit.value),
        body: this.rows(
          this.expandOccs(occs, col, []),
          keep,
          new Map(facts).set(occ, { _tag: "IsLit", lit }),
        ),
      };
    });
    const sig: Signature = { kind: "literal", all: undefined };
    const fallback = this.rows(
      this.expandOccs(occs, col, []),
      this.defaults(rows, col),
      new Map(facts).set(occ, { _tag: "Not", cons: [], sig }),
    );
    return { _tag: "Switch", occ, kind: "literal", cases, default: fallback };
  }

  private expandOccs(
    occs: ReadonlyArray<Occurrence>,
    col: number,
    children: ReadonlyArray<Occurrence>,
  ): Array<Occurrence> {
    return [...occs.slice(0, col), ...children, ...occs.slice(col + 1)];
  }

  /** Rows that match constructor `name` at `col`, with its fields in place of the column. */
  private specialize(
    rows: ReadonlyArray<Row>,
    col: number,
    name: string,
    arity: number,
  ): Array<Row> {
    return rows.flatMap((r): Array<Row> => {
      const p = r.pats[col];
      let fields: ReadonlyArray<CPat | undefined>;
      if (p === undefined) {
        fields = Array.from({ length: arity }, () => undefined);
      } else if (p._tag === "PCon" && p.name === name) {
        fields = p.args;
      } else {
        return [];
      }
      return [{ ...r, pats: [...r.pats.slice(0, col), ...fields, ...r.pats.slice(col + 1)] }];
    });
  }

  /** Rows with a wildcard at `col`, without the column. */
  private defaults(rows: ReadonlyArray<Row>, col: number): Array<Row> {
    return rows.flatMap((r): Array<Row> => {
      if (r.pats[col] !== undefined) {
        return [];
      }
      return [{ ...r, pats: r.pats.filter((_, i) => i !== col) }];
    });
  }

  // ---- witnesses ----------------------------------------------------------------------------

  /** A pattern describing the values of `occ` that reach the current point. */
  private witness(occ: Occurrence, facts: ReadonlyMap<Occurrence, Fact>, top: boolean): string {
    const fact = facts.get(occ);
    if (fact === undefined) {
      return "_";
    }
    switch (fact._tag) {
      case "IsLit":
        return prettyLiteral(fact.lit);
      case "Not": {
        const missing = fact.sig.all?.find((c) => !fact.cons.includes(c));
        if (missing === undefined) {
          return "_";
        }
        const arity = this.con(missing).arity;
        return this.showCon(
          missing,
          Array.from({ length: arity }, () => "_"),
          top,
        );
      }
      case "Is":
        return this.showCon(
          fact.con,
          fact.children.map((c) => this.witness(c, facts, false)),
          top,
        );
    }
  }

  private showCon(name: string, args: ReadonlyArray<string>, top: boolean): string {
    if (tupleArity(name) !== undefined) {
      return `(${args.join(", ")})`;
    }
    if (name === ":") {
      const s = `${args[0] ?? "_"} : ${args[1] ?? "_"}`;
      return top ? s : `(${s})`;
    }
    if (args.length === 0) {
      return name;
    }
    const s = `${name} ${args.join(" ")}`;
    return top ? s : `(${s})`;
  }
}
