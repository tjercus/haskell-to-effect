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
  | {
      readonly _tag: "Case";
      readonly scrutinee: Expr;
      readonly alts: ReadonlyArray<Alt>;
      readonly span: Span;
    }
  | { readonly _tag: "Do"; readonly stmts: ReadonlyArray<Stmt>; readonly span: Span }
  /** Type annotation `e :: t`. */
  | { readonly _tag: "Typed"; readonly expr: Expr; readonly type: Type; readonly span: Span }
  | { readonly _tag: "Tuple"; readonly elems: ReadonlyArray<Expr>; readonly span: Span }
  | { readonly _tag: "List"; readonly elems: ReadonlyArray<Expr>; readonly span: Span };

/** A `case` alternative `pat -> e` or `pat | guard -> e …`, with optional `where`. */
export interface Alt {
  readonly pat: Pat;
  readonly rhs: Rhs;
  readonly span: Span;
}

/** A statement in a `do` block. The last statement of a block is always an `ExprStmt`. */
export type Stmt =
  | { readonly _tag: "BindStmt"; readonly pat: Pat; readonly expr: Expr; readonly span: Span }
  | { readonly _tag: "LetStmt"; readonly decls: ReadonlyArray<Decl>; readonly span: Span }
  | { readonly _tag: "ExprStmt"; readonly expr: Expr; readonly span: Span };

// ---- types -------------------------------------------------------------------

export type Type =
  | { readonly _tag: "TVar"; readonly name: string; readonly span: Span }
  /** Type constructor: `Int`, `Maybe`, and the special `()`, `[]`, `(,)`, `(->)`. */
  | { readonly _tag: "TCon"; readonly name: string; readonly span: Span }
  | { readonly _tag: "TApp"; readonly fn: Type; readonly arg: Type; readonly span: Span }
  | { readonly _tag: "TFun"; readonly from: Type; readonly to: Type; readonly span: Span }
  | { readonly _tag: "TList"; readonly elem: Type; readonly span: Span }
  | { readonly _tag: "TTuple"; readonly elems: ReadonlyArray<Type>; readonly span: Span };

// ---- declarations ------------------------------------------------------------

/** `| guard = body` (or `->` in a case alternative). */
export interface GuardedExpr {
  readonly guard: Expr;
  readonly body: Expr;
  readonly span: Span;
}

/** The right-hand side of an equation or case alternative, with its `where` bindings. */
export type Rhs =
  | {
      readonly _tag: "Unguarded";
      readonly body: Expr;
      readonly where: ReadonlyArray<Decl>;
      readonly span: Span;
    }
  | {
      readonly _tag: "Guarded";
      readonly guards: ReadonlyArray<GuardedExpr>;
      readonly where: ReadonlyArray<Decl>;
      readonly span: Span;
    };

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
  | { readonly _tag: "PatBind"; readonly pat: Pat; readonly rhs: Rhs; readonly span: Span }
  /** `f, g :: t` */
  | {
      readonly _tag: "TypeSig";
      readonly names: ReadonlyArray<string>;
      readonly type: Type;
      readonly span: Span;
    };

/** A data constructor declaration `C t1 … tn` (positional fields only). */
export interface ConDecl {
  readonly name: string;
  readonly fields: ReadonlyArray<Type>;
  readonly span: Span;
}

/** `data T a b = C1 … | C2 … deriving (…)` */
export interface DataDecl {
  readonly _tag: "DataDecl";
  readonly name: string;
  readonly params: ReadonlyArray<string>;
  readonly constructors: ReadonlyArray<ConDecl>;
  /** Class names in the `deriving` clause; accepted for GHC compatibility. */
  readonly deriving: ReadonlyArray<string>;
  readonly span: Span;
}

export type TopDecl = Decl | DataDecl;

export interface Module {
  /** `undefined` when the module header is omitted (the module is then `Main`). */
  readonly name: string | undefined;
  /** The export list, if any; names only. */
  readonly exports: ReadonlyArray<string> | undefined;
  readonly decls: ReadonlyArray<TopDecl>;
  readonly span: Span;
}

// ---- helpers -----------------------------------------------------------------

/** Whether a name is an operator (symbolic) rather than an identifier. */
export const isSymbolic = (name: string): boolean =>
  !/^[\p{L}_]/u.test(name) && !/^[([]/.test(name);

/** Whether a name refers to a data constructor. */
export const isConName = (name: string): boolean =>
  name.startsWith(":") || /^[\p{Lu}([]/u.test(name);
