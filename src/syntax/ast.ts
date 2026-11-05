import type { Span } from "./span.ts";

// ---- literals --------------------------------------------------------------

export type Literal =
  | { readonly _tag: "Int"; readonly value: number }
  | { readonly _tag: "Char"; readonly value: string }
  | { readonly _tag: "String"; readonly value: string };

// ---- patterns --------------------------------------------------------------

export type Pat =
  /** `x`, or an operator in parentheses such as `(+)`. */
  | { readonly _tag: "PVar"; readonly name: string; readonly span: Span }
  | { readonly _tag: "PWildcard"; readonly span: Span }
  /** Literal pattern; integer literals may be negative (`-1`). */
  | { readonly _tag: "PLit"; readonly lit: Literal; readonly span: Span }
  /**
   * Constructor pattern: `Just x`, `Nothing`, `()`, `[]`, and `x : xs`
   * (as `PCon(":", [x, xs])`).
   */
  | {
      readonly _tag: "PCon";
      readonly name: string;
      readonly args: ReadonlyArray<Pat>;
      readonly span: Span;
    }
  | { readonly _tag: "PTuple"; readonly elems: ReadonlyArray<Pat>; readonly span: Span }
  | { readonly _tag: "PList"; readonly elems: ReadonlyArray<Pat>; readonly span: Span }
  /** As-pattern `name@pat`. */
  | { readonly _tag: "PAs"; readonly name: string; readonly pat: Pat; readonly span: Span };

// ---- expressions -------------------------------------------------------------

/** An operator occurrence in infix position: `+`, `:`, or `` `div` ``. */
export interface OpRef {
  readonly name: string;
  readonly span: Span;
}

export type Expr =
  /** Variable, or an operator in parentheses such as `(+)`. */
  | { readonly _tag: "Var"; readonly name: string; readonly span: Span }
  /** Constructor: `Just`, `True`, `()`, `[]`, `(,)`, `(:)`. */
  | { readonly _tag: "Con"; readonly name: string; readonly span: Span }
  | { readonly _tag: "Lit"; readonly lit: Literal; readonly span: Span }
  | { readonly _tag: "App"; readonly fn: Expr; readonly arg: Expr; readonly span: Span }
  /** Infix operator application, after fixity resolution. */
  | {
      readonly _tag: "BinOp";
      readonly op: OpRef;
      readonly left: Expr;
      readonly right: Expr;
      readonly span: Span;
    }
  /** Prefix negation `- e`. */
  | { readonly _tag: "Neg"; readonly expr: Expr; readonly span: Span }
  /** `(e op)` */
  | { readonly _tag: "LeftSection"; readonly left: Expr; readonly op: OpRef; readonly span: Span }
  /** `(op e)` */
  | { readonly _tag: "RightSection"; readonly op: OpRef; readonly right: Expr; readonly span: Span }
  | {
      readonly _tag: "Lambda";
      readonly params: ReadonlyArray<Pat>;
      readonly body: Expr;
      readonly span: Span;
    }
  | {
      readonly _tag: "Let";
      readonly decls: ReadonlyArray<Decl>;
      readonly body: Expr;
      readonly span: Span;
    }
  | {
      readonly _tag: "If";
      readonly cond: Expr;
      readonly thenBranch: Expr;
      readonly elseBranch: Expr;
      readonly span: Span;
    }
  | { readonly _tag: "Tuple"; readonly elems: ReadonlyArray<Expr>; readonly span: Span }
  | { readonly _tag: "List"; readonly elems: ReadonlyArray<Expr>; readonly span: Span };

// ---- declarations ------------------------------------------------------------

export type Rhs = { readonly _tag: "Unguarded"; readonly body: Expr };

export type Decl =
  /** One equation of a function (or a simple variable binding when `params` is empty). */
  | {
      readonly _tag: "FunClause";
      readonly name: string;
      readonly params: ReadonlyArray<Pat>;
      readonly rhs: Rhs;
      readonly span: Span;
    }
  /** A pattern binding such as `(a, b) = e`. */
  | { readonly _tag: "PatBind"; readonly pat: Pat; readonly rhs: Rhs; readonly span: Span };

// ---- helpers -----------------------------------------------------------------

/** Whether a name is an operator (symbolic) rather than an identifier. */
export const isSymbolic = (name: string): boolean =>
  !/^[\p{L}_]/u.test(name) && !/^[([]/.test(name);

/** Whether a name refers to a data constructor. */
export const isConName = (name: string): boolean =>
  name.startsWith(":") || /^[\p{Lu}([]/u.test(name);
