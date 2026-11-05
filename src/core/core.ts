/**
 * Core: the small language the surface syntax is lowered to. All names are resolved and
 * unique, and syntactic sugar is gone. The node types are:
 *
 * - `Var`, `Prim` (a Prelude built-in), `Con` (a data constructor), `Lit`
 * - `App` and `Lam` (one argument each)
 * - `Let` (one binding group, in dependency order)
 * - `If`
 * - `Match` (ordered clauses with nested patterns and guards that fall through)
 * - `Typed` (a type annotation, kept for the type checker)
 */
import type { Literal, Type } from "../syntax/ast.ts";
import type { Span } from "../syntax/span.ts";

/** A resolved variable. `id` is unique within a program; `text` is the source name. */
export interface Name {
  readonly text: string;
  readonly id: number;
}

export type CExpr =
  | { readonly _tag: "Var"; readonly name: Name; readonly span: Span }
  | { readonly _tag: "Prim"; readonly name: string; readonly span: Span }
  | { readonly _tag: "Con"; readonly name: string; readonly span: Span }
  | { readonly _tag: "Lit"; readonly lit: Literal; readonly span: Span }
  | { readonly _tag: "App"; readonly fn: CExpr; readonly arg: CExpr; readonly span: Span }
  | { readonly _tag: "Lam"; readonly param: Name; readonly body: CExpr; readonly span: Span }
  | { readonly _tag: "Let"; readonly group: BindGroup; readonly body: CExpr; readonly span: Span }
  | {
      readonly _tag: "If";
      readonly cond: CExpr;
      readonly thenBranch: CExpr;
      readonly elseBranch: CExpr;
      readonly span: Span;
    }
  | Match
  | { readonly _tag: "Typed"; readonly expr: CExpr; readonly type: Type; readonly span: Span };

/**
 * Matches `scrutinees` against each clause in order. A clause applies when every pattern
 * matches and, if it has guards, one of them holds; otherwise matching falls through to the
 * next clause. If no clause applies, the program fails with a pattern-match error that
 * names `context`.
 */
export interface Match {
  readonly _tag: "Match";
  readonly scrutinees: ReadonlyArray<Name>;
  readonly clauses: ReadonlyArray<Clause>;
  /** What is being matched, for error messages: `function 'f'`, `case expression`, … */
  readonly context: string;
  readonly span: Span;
}

export interface Clause {
  /** One pattern per scrutinee. */
  readonly pats: ReadonlyArray<CPat>;
  readonly body: GuardedBody;
  readonly span: Span;
}

export type GuardedBody =
  | { readonly _tag: "Body"; readonly expr: CExpr }
  /** Tried in order; if no guard holds, the enclosing clause fails. */
  | { readonly _tag: "Guards"; readonly guards: ReadonlyArray<Guard> }
  /** `where` bindings scoping over all guards of a clause. */
  | { readonly _tag: "LetBody"; readonly group: BindGroup; readonly body: GuardedBody };

export interface Guard {
  readonly cond: CExpr;
  readonly expr: CExpr;
  readonly span: Span;
}

export type CPat =
  | { readonly _tag: "PVar"; readonly name: Name; readonly span: Span }
  | { readonly _tag: "PWildcard"; readonly span: Span }
  | { readonly _tag: "PLit"; readonly lit: Literal; readonly span: Span }
  /** Constructor pattern; tuples are `(,)`… and lists are `:` / `[]`. Always fully applied. */
  | {
      readonly _tag: "PCon";
      readonly name: string;
      readonly args: ReadonlyArray<CPat>;
      readonly span: Span;
    }
  | { readonly _tag: "PAs"; readonly name: Name; readonly pat: CPat; readonly span: Span };

export interface Bind {
  readonly name: Name;
  readonly expr: CExpr;
  /** The declared type signature, if any. */
  readonly sig: Type | undefined;
  readonly span: Span;
}

/** A binding group: a single non-recursive binding, or mutually recursive bindings. */
export type BindGroup =
  | { readonly _tag: "NonRec"; readonly bind: Bind }
  | { readonly _tag: "Rec"; readonly binds: ReadonlyArray<Bind> };

export interface ConInfo {
  readonly name: string;
  readonly typeName: string;
  readonly fields: ReadonlyArray<Type>;
  /** Position within its data type, starting at 0. */
  readonly tag: number;
}

export interface DataInfo {
  readonly name: string;
  readonly params: ReadonlyArray<string>;
  readonly constructors: ReadonlyArray<ConInfo>;
  readonly builtin: boolean;
  readonly span: Span | undefined;
}

export interface Program {
  readonly moduleName: string;
  readonly data: ReadonlyArray<DataInfo>;
  /** Top-level bindings, in dependency order. */
  readonly groups: ReadonlyArray<BindGroup>;
}

export const bindsOf = (g: BindGroup): ReadonlyArray<Bind> =>
  g._tag === "NonRec" ? [g.bind] : g.binds;
