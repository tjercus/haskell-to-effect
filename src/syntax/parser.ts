import { Result } from "effect";
import { type LexError, ParseError } from "../errors.ts";
import type {
  Alt,
  ConDecl,
  DataDecl,
  Decl,
  Expr,
  GuardedExpr,
  Literal,
  Module,
  OpRef,
  Pat,
  Rhs,
  Stmt,
  TopDecl,
  Type,
} from "./ast.ts";
import { type Fixity, fixityOf, negationFixity, showFixity } from "./fixity.ts";
import { type LayoutMode, LayoutStream } from "./layout.ts";
import { lex } from "./lexer.ts";
import { type Span, merge } from "./span.ts";
import { type Token, describeToken } from "./token.ts";

// ---- fixity resolution (Haskell 2010 Report, section 10.6) ---------------------

/** A flat infix expression `e1 op1 e2 op2 …` with prefix negations, before resolution. */
type InfixItem =
  | { readonly _tag: "Operand"; readonly expr: Expr }
  | { readonly _tag: "Negate"; readonly span: Span }
  | { readonly _tag: "Operator"; readonly op: OpRef };

interface NamedFixity extends Fixity {
  readonly name: string;
}

const describeOp = (f: NamedFixity): string => `'${f.name}' [${showFixity(f)}]`;

const resolveInfix = (items: ReadonlyArray<InfixItem>): Expr => {
  let i = 0;
  const start: NamedFixity = { name: "", prec: -1, assoc: "none" };
  const neg: NamedFixity = { name: "prefix -", ...negationFixity };

  const parseNeg = (op1: NamedFixity): Expr => {
    const item = items[i++];
    if (item === undefined) throw new Error("resolveInfix: missing operand");
    if (item._tag === "Operand") return parse1(op1, item.expr);
    if (item._tag === "Negate") {
      if (op1.prec >= 6) {
        throw new ParseError({
          message: `cannot mix ${describeOp(op1)} and prefix '-' [infixl 6] in the same infix expression; add parentheses`,
          span: item.span,
        });
      }
      const r = parseNeg(neg);
      return parse1(op1, { _tag: "Neg", expr: r, span: merge(item.span, r.span) });
    }
    throw new Error("resolveInfix: unexpected operator");
  };

  const parse1 = (op1: NamedFixity, e1: Expr): Expr => {
    for (;;) {
      const item = items[i];
      if (item === undefined) return e1;
      if (item._tag !== "Operator") throw new Error("resolveInfix: expected operator");
      const op2: NamedFixity = { name: item.op.name, ...fixityOf(item.op.name) };
      if (op1.prec === op2.prec && (op1.assoc !== op2.assoc || op1.assoc === "none")) {
        throw new ParseError({
          message: `cannot mix ${describeOp(op1)} and ${describeOp(op2)} in the same infix expression; add parentheses`,
          span: item.op.span,
        });
      }
      if (op1.prec > op2.prec || (op1.prec === op2.prec && op1.assoc === "left")) return e1;
      i++;
      const r = parseNeg(op2);
      e1 = { _tag: "BinOp", op: item.op, left: e1, right: r, span: merge(e1.span, r.span) };
    }
  };

  return parseNeg(start);
};

// ---- parser -------------------------------------------------------------------

const isLiteral = (t: Token): t is Extract<Token, { _tag: "Int" | "Char" | "String" }> =>
  t._tag === "Int" || t._tag === "Char" || t._tag === "String";

const literalOf = (t: Extract<Token, { _tag: "Int" | "Char" | "String" }>): Literal =>
  t._tag === "Int" ? { _tag: "Int", value: t.value } : { _tag: t._tag, value: t.value };

const unsupportedTopDecls: Record<string, string> = {
  import: "imports are not supported; the Prelude is built in",
  type: "type synonyms are not supported",
  newtype: "newtype declarations are not supported; use 'data'",
  class: "type classes are not supported",
  instance: "type class instances are not supported",
  infix: "fixity declarations are not supported",
  infixl: "fixity declarations are not supported",
  infixr: "fixity declarations are not supported",
  default: "default declarations are not supported",
  foreign: "foreign declarations are not supported",
  deriving: "standalone deriving is not supported",
};

class Parser {
  private i = 0;
  /** Span of the last consumed non-virtual token, used to end spans of blocks. */
  private lastReal: Span | undefined;

  constructor(private readonly stream: LayoutStream) {}

  // ---- token helpers ----------------------------------------------------------

  private peek(ahead = 0): Token {
    return this.stream.at(this.i + ahead);
  }

  private next(): Token {
    const t = this.peek();
    if (t._tag !== "EOF") this.i++;
    if (!(t._tag === "Special" && t.virtual)) this.lastReal = t.span;
    return t;
  }

  /** A span from `start` to the end of the last consumed source token. */
  private spanFrom(start: Span): Span {
    return merge(start, this.lastReal ?? start);
  }

  private is(tag: Token["_tag"], text?: string, ahead = 0): boolean {
    const t = this.peek(ahead);
    return t._tag === tag && (text === undefined || t.text === text);
  }

  private isSpecial(text: string, ahead = 0): boolean {
    return this.is("Special", text, ahead);
  }

  private error(message: string, at: Span = this.peek().span): ParseError {
    return new ParseError({ message, span: at });
  }

  private unexpected(expected: string): ParseError {
    return this.error(`unexpected ${describeToken(this.peek())}, expected ${expected}`);
  }

  private expect(tag: Token["_tag"], text: string, expected = `'${text}'`): Token {
    if (!this.is(tag, text)) throw this.unexpected(expected);
    return this.next();
  }

  private expectSpecial(text: string): Token {
    return this.expect("Special", text);
  }

  // ---- entry points -------------------------------------------------------------

  expressionOnly(): Expr {
    const e = this.exp();
    if (!this.is("EOF")) throw this.unexpected("end of input");
    return e;
  }

  typeOnly(): Type {
    const t = this.type();
    if (!this.is("EOF")) throw this.unexpected("end of input");
    return t;
  }

  /** `module → module modid [exports] where body | body` */
  moduleOnly(): Module {
    const start = this.peek().span;
    let name: string | undefined;
    let exports: Array<string> | undefined;
    if (this.is("ReservedId", "module")) {
      this.next();
      const id = this.peek();
      if (id._tag !== "ConId") throw this.unexpected("a module name");
      this.next();
      name = id.text;
      if (this.isSpecial("(")) exports = this.exportList();
      this.expect("ReservedId", "where");
    }
    const decls = this.block(
      "a declaration",
      () => this.isTopDeclStart(),
      () => this.topDecl(),
    );
    if (!this.is("EOF")) throw this.unexpected("end of input");
    return { name, exports, decls, span: this.spanFrom(start) };
  }

  private exportList(): Array<string> {
    this.expectSpecial("(");
    const names: Array<string> = [];
    while (!this.isSpecial(")")) {
      const t = this.peek();
      if (t._tag === "VarId" || t._tag === "ConId") {
        this.next();
        names.push(t.text);
        if (t._tag === "ConId" && this.isSpecial("(")) {
          // `T(..)` or `T(A, B)`: constructors are exported with the type.
          this.next();
          while (!this.isSpecial(")")) {
            if (this.is("EOF")) throw this.unexpected("')'");
            this.next();
          }
          this.next();
        }
      } else if (
        this.isSpecial("(") &&
        (this.is("VarSym", undefined, 1) || this.is("ConSym", undefined, 1))
      ) {
        this.next();
        names.push(this.next().text);
        this.expectSpecial(")");
      } else {
        throw this.unexpected("an exported name");
      }
      if (!this.isSpecial(",")) break;
      this.next();
    }
    this.expectSpecial(")");
    return names;
  }

  private isTopDeclStart(): boolean {
    const t = this.peek();
    return (
      this.isApatStart() ||
      (t._tag === "ReservedId" && (t.text === "data" || t.text in unsupportedTopDecls))
    );
  }

  private topDecl(): TopDecl {
    const t = this.peek();
    if (t._tag === "ReservedId") {
      if (t.text === "data") return this.dataDecl();
      const unsupported = unsupportedTopDecls[t.text];
      if (unsupported !== undefined) throw this.error(unsupported);
    }
    return this.decl();
  }

  /** `data T a … = C1 t … | C2 t … [deriving (C, …)]` */
  private dataDecl(): DataDecl {
    const start = this.next().span;
    const name = this.peek();
    if (name._tag !== "ConId") throw this.unexpected("a type name");
    this.next();
    const params: Array<string> = [];
    while (this.is("VarId")) params.push(this.next().text);
    const constructors: Array<ConDecl> = [];
    if (this.is("ReservedOp", "=")) {
      this.next();
      constructors.push(this.conDecl());
      while (this.is("ReservedOp", "|")) {
        this.next();
        constructors.push(this.conDecl());
      }
    }
    const deriving: Array<string> = [];
    if (this.is("ReservedId", "deriving")) {
      this.next();
      if (this.isSpecial("(")) {
        this.next();
        while (this.is("ConId")) {
          deriving.push(this.next().text);
          if (!this.isSpecial(",")) break;
          this.next();
        }
        this.expectSpecial(")");
      } else {
        const cls = this.peek();
        if (cls._tag !== "ConId") throw this.unexpected("a class name");
        deriving.push(this.next().text);
      }
    }
    return {
      _tag: "DataDecl",
      name: name.text,
      params,
      constructors,
      deriving,
      span: this.spanFrom(start),
    };
  }

  private conDecl(): ConDecl {
    const name = this.peek();
    if (name._tag !== "ConId") {
      throw this.unexpected(
        this.isSpecial("(")
          ? "a constructor name (infix constructors are not supported)"
          : "a constructor name",
      );
    }
    this.next();
    const fields: Array<Type> = [];
    for (;;) {
      if (this.isAtypeStart()) fields.push(this.atype());
      else if (this.is("VarSym", "!")) throw this.error("strictness annotations are not supported");
      else if (this.isSpecial("{")) throw this.error("record syntax is not supported");
      else break;
    }
    return { name: name.text, fields, span: this.spanFrom(name.span) };
  }

  // ---- types --------------------------------------------------------------------

  /** `type → btype [-> type]` */
  private type(): Type {
    const from = this.btype();
    if (this.is("ReservedOp", "=>")) throw this.error("type class constraints are not supported");
    if (!this.is("ReservedOp", "->")) return from;
    this.next();
    const to = this.type();
    return { _tag: "TFun", from, to, span: merge(from.span, to.span) };
  }

  /** `btype → atype+` (type application) */
  private btype(): Type {
    let t = this.atype();
    while (this.isAtypeStart()) {
      const arg = this.atype();
      t = { _tag: "TApp", fn: t, arg, span: merge(t.span, arg.span) };
    }
    return t;
  }

  private isAtypeStart(): boolean {
    return this.is("VarId") || this.is("ConId") || this.isSpecial("(") || this.isSpecial("[");
  }

  private atype(): Type {
    const t = this.peek();
    if (t._tag === "VarId") {
      this.next();
      return { _tag: "TVar", name: t.text, span: t.span };
    }
    if (t._tag === "ConId") {
      this.next();
      return { _tag: "TCon", name: t.text, span: t.span };
    }
    if (this.isSpecial("[")) {
      const open = this.next().span;
      if (this.isSpecial("]"))
        return { _tag: "TCon", name: "[]", span: merge(open, this.next().span) };
      const elem = this.type();
      return { _tag: "TList", elem, span: merge(open, this.expectSpecial("]").span) };
    }
    if (this.isSpecial("(")) {
      const open = this.next().span;
      if (this.isSpecial(")"))
        return { _tag: "TCon", name: "()", span: merge(open, this.next().span) };
      if (this.is("ReservedOp", "->") && this.isSpecial(")", 1)) {
        this.next();
        return { _tag: "TCon", name: "->", span: merge(open, this.next().span) };
      }
      if (this.isSpecial(",")) {
        let name = "(";
        while (this.isSpecial(",")) {
          this.next();
          name += ",";
        }
        return { _tag: "TCon", name: `${name})`, span: merge(open, this.expectSpecial(")").span) };
      }
      const first = this.type();
      if (this.isSpecial(")")) {
        this.next();
        return first;
      }
      const elems = [first];
      while (this.isSpecial(",")) {
        this.next();
        elems.push(this.type());
      }
      return { _tag: "TTuple", elems, span: merge(open, this.expectSpecial(")").span) };
    }
    throw this.unexpected("a type");
  }

  // ---- expressions ------------------------------------------------------------

  /** `exp → infixexp [:: type]` */
  private exp(): Expr {
    return this.typeAnnotation(resolveInfix(this.infixItems(false).items));
  }

  private typeAnnotation(e: Expr): Expr {
    if (!this.is("ReservedOp", "::")) return e;
    this.next();
    const type = this.type();
    return { _tag: "Typed", expr: e, type, span: merge(e.span, type.span) };
  }

  private isOperatorStart(): boolean {
    const t = this.peek();
    return (
      t._tag === "VarSym" ||
      t._tag === "ConSym" ||
      (t._tag === "ReservedOp" && t.text === ":") ||
      this.isSpecial("`")
    );
  }

  private opRef(): OpRef {
    if (this.isSpecial("`")) {
      const open = this.next();
      const t = this.peek();
      if (t._tag !== "VarId" && t._tag !== "ConId")
        throw this.unexpected("an identifier between backticks");
      this.next();
      const close = this.expectSpecial("`");
      return { name: t.text, span: merge(open.span, close.span) };
    }
    const t = this.next();
    return { name: t.text, span: t.span };
  }

  /**
   * A flat sequence of operands, operators and prefix negations. With `allowTrailingOp`,
   * stops (without consuming) at `)` when it directly follows an operator: a left section.
   */
  private infixItems(allowTrailingOp: boolean): {
    items: Array<InfixItem>;
    trailing: OpRef | undefined;
  } {
    const items: Array<InfixItem> = [];
    for (;;) {
      if (this.is("VarSym", "-")) {
        items.push({ _tag: "Negate", span: this.next().span });
        continue;
      }
      // lambda, let and if extend as far to the right as possible
      const openEnded =
        this.is("ReservedOp", "\\") || this.is("ReservedId", "let") || this.is("ReservedId", "if");
      items.push({ _tag: "Operand", expr: this.lexp() });
      if (openEnded) break;
      if (!this.isOperatorStart()) break;
      const op = this.opRef();
      if (allowTrailingOp && this.isSpecial(")")) return { items, trailing: op };
      items.push({ _tag: "Operator", op });
    }
    return { items, trailing: undefined };
  }

  /** `lexp → \ apat+ -> exp | let decls in exp | if exp then exp else exp | fexp` */
  private lexp(): Expr {
    const t = this.peek();
    if (t._tag === "ReservedOp" && t.text === "\\") return this.lambda();
    if (t._tag === "ReservedId") {
      switch (t.text) {
        case "let":
          return this.letExpr();
        case "if":
          return this.ifExpr();
        case "case":
          return this.caseExpr();
        case "do":
          return this.doExpr();
      }
    }
    return this.fexp();
  }

  private lambda(): Expr {
    const start = this.next().span;
    const params: Array<Pat> = [];
    while (this.isApatStart()) params.push(this.apat());
    if (params.length === 0) throw this.unexpected("a pattern");
    this.expect("ReservedOp", "->");
    const body = this.exp();
    return { _tag: "Lambda", params, body, span: merge(start, body.span) };
  }

  private letExpr(): Expr {
    const start = this.next().span;
    const decls = this.block(
      "a declaration",
      () => this.isApatStart(),
      () => this.decl(),
    );
    this.expect("ReservedId", "in");
    const body = this.exp();
    return { _tag: "Let", decls, body, span: merge(start, body.span) };
  }

  private caseExpr(): Expr {
    const start = this.next().span;
    const scrutinee = this.exp();
    this.expect("ReservedId", "of");
    const alts = this.block(
      "a case alternative",
      () => this.isPatStart(),
      () => this.alt(),
    );
    if (alts.length === 0)
      throw this.error("a 'case' expression needs at least one alternative", start);
    return { _tag: "Case", scrutinee, alts, span: this.spanFrom(start) };
  }

  private alt(): Alt {
    const pat = this.pat();
    const rhs = this.rhs("->");
    return { pat, rhs, span: merge(pat.span, rhs.span) };
  }

  private doExpr(): Expr {
    const start = this.next().span;
    const stmts = this.block(
      "a statement",
      () => this.isStmtStart(),
      () => this.stmt(),
    );
    const last = stmts[stmts.length - 1];
    if (last === undefined) throw this.error("empty 'do' block", start);
    if (last._tag !== "ExprStmt") {
      throw this.error("the last statement in a 'do' block must be an expression", last.span);
    }
    return { _tag: "Do", stmts, span: this.spanFrom(start) };
  }

  private isStmtStart(): boolean {
    const t = this.peek();
    return (
      this.isAexpStart() ||
      this.is("ReservedId", "_") ||
      this.is("ReservedOp", "\\") ||
      this.is("VarSym", "-") ||
      (t._tag === "ReservedId" && ["let", "if", "case", "do"].includes(t.text))
    );
  }

  /** `stmt → pat <- exp | let decls | exp` */
  private stmt(): Stmt {
    const start = this.peek().span;
    if (this.is("ReservedId", "let")) {
      this.next();
      const decls = this.block(
        "a declaration",
        () => this.isApatStart(),
        () => this.decl(),
      );
      if (!this.is("ReservedId", "in"))
        return { _tag: "LetStmt", decls, span: this.spanFrom(start) };
      // `let … in e` used as an expression statement
      this.next();
      const body = this.exp();
      const expr: Expr = { _tag: "Let", decls, body, span: merge(start, body.span) };
      return { _tag: "ExprStmt", expr, span: expr.span };
    }
    // Try `pat <- e`; otherwise it is an expression statement.
    const saved = this.i;
    try {
      const pat = this.pat();
      if (this.is("ReservedOp", "<-")) {
        this.next();
        const expr = this.exp();
        return { _tag: "BindStmt", pat, expr, span: merge(pat.span, expr.span) };
      }
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
    }
    this.i = saved;
    const expr = this.exp();
    return { _tag: "ExprStmt", expr, span: expr.span };
  }

  private ifExpr(): Expr {
    const start = this.next().span;
    const cond = this.exp();
    if (this.isSpecial(";")) this.next();
    this.expect("ReservedId", "then");
    const thenBranch = this.exp();
    if (this.isSpecial(";")) this.next();
    this.expect("ReservedId", "else");
    const elseBranch = this.exp();
    return { _tag: "If", cond, thenBranch, elseBranch, span: merge(start, elseBranch.span) };
  }

  /** `fexp → aexp+` (function application) */
  private fexp(): Expr {
    let e = this.aexp();
    while (this.isAexpStart()) {
      const arg = this.aexp();
      e = { _tag: "App", fn: e, arg, span: merge(e.span, arg.span) };
    }
    return e;
  }

  private isAexpStart(): boolean {
    const t = this.peek();
    return (
      t._tag === "VarId" ||
      t._tag === "ConId" ||
      isLiteral(t) ||
      this.isSpecial("(") ||
      this.isSpecial("[")
    );
  }

  private aexp(): Expr {
    const t = this.peek();
    if (t._tag === "VarId") {
      this.next();
      return { _tag: "Var", name: t.text, span: t.span };
    }
    if (t._tag === "ConId") {
      this.next();
      return { _tag: "Con", name: t.text, span: t.span };
    }
    if (isLiteral(t)) {
      this.next();
      return { _tag: "Lit", lit: literalOf(t), span: t.span };
    }
    if (this.isSpecial("(")) return this.parenExpr();
    if (this.isSpecial("[")) return this.listExpr();
    throw this.unexpected("an expression");
  }

  private listExpr(): Expr {
    const open = this.next().span;
    if (this.isSpecial("]")) {
      const close = this.next().span;
      return { _tag: "Con", name: "[]", span: merge(open, close) };
    }
    const elems = [this.exp()];
    while (this.isSpecial(",")) {
      this.next();
      elems.push(this.exp());
    }
    if (this.is("ReservedOp", "..")) throw this.error("arithmetic sequences are not supported");
    const close = this.expectSpecial("]").span;
    return { _tag: "List", elems, span: merge(open, close) };
  }

  /**
   * Everything that starts with `(`: unit, tuple constructors, operator names, sections,
   * parenthesised expressions and tuples.
   */
  private parenExpr(): Expr {
    const open = this.next().span;

    // () and (,), (,,), …
    if (this.isSpecial(")")) {
      return { _tag: "Con", name: "()", span: merge(open, this.next().span) };
    }
    if (this.isSpecial(",")) {
      let name = "(";
      while (this.isSpecial(",")) {
        this.next();
        name += ",";
      }
      const close = this.expectSpecial(")").span;
      return { _tag: "Con", name: `${name})`, span: merge(open, close) };
    }

    // (op) and right sections (op e); `(- e)` is negation, not a section
    if (this.isOperatorStart() && !(this.is("VarSym", "-") && !this.isSpecial(")", 1))) {
      const op = this.opRef();
      if (this.isSpecial(")")) {
        const close = this.next().span;
        if (op.span.end.offset - op.span.start.offset !== op.name.length) {
          throw this.error(
            "an identifier in backticks cannot be used as a prefix function; drop the backticks",
            op.span,
          );
        }
        const s = merge(open, close);
        return op.name.startsWith(":")
          ? { _tag: "Con", name: op.name, span: s }
          : { _tag: "Var", name: op.name, span: s };
      }
      const { items } = this.infixItems(false);
      const close = this.expectSpecial(")").span;
      return this.rightSection(op, items, merge(open, close));
    }

    const { items, trailing } = this.infixItems(true);
    if (trailing !== undefined) {
      const close = this.expectSpecial(")").span;
      return this.leftSection(items, trailing, merge(open, close));
    }
    const first = this.typeAnnotation(resolveInfix(items));
    if (this.isSpecial(")")) {
      this.next();
      return first;
    }
    if (!this.isSpecial(",")) throw this.unexpected("')' or ','");
    const elems = [first];
    while (this.isSpecial(",")) {
      this.next();
      elems.push(this.exp());
    }
    const close = this.expectSpecial(")").span;
    return { _tag: "Tuple", elems, span: merge(open, close) };
  }

  /** `(e op)` is legal iff `e op x` would parse as `(e) op x`. */
  private leftSection(items: ReadonlyArray<InfixItem>, op: OpRef, s: Span): Expr {
    const hole: Expr = { _tag: "Var", name: "<hole>", span: op.span };
    const resolved = resolveInfix([
      ...items,
      { _tag: "Operator", op },
      { _tag: "Operand", expr: hole },
    ]);
    if (resolved._tag !== "BinOp" || resolved.op !== op || resolved.right !== hole) {
      throw this.error(
        `the operator '${op.name}' in this left section binds more tightly than its operand; add parentheses`,
        op.span,
      );
    }
    return { _tag: "LeftSection", left: resolved.left, op, span: s };
  }

  /** `(op e)` is legal iff `x op e` would parse as `x op (e)`. */
  private rightSection(op: OpRef, items: ReadonlyArray<InfixItem>, s: Span): Expr {
    const hole: Expr = { _tag: "Var", name: "<hole>", span: op.span };
    const resolved = resolveInfix([
      { _tag: "Operand", expr: hole },
      { _tag: "Operator", op },
      ...items,
    ]);
    if (resolved._tag !== "BinOp" || resolved.op !== op || resolved.left !== hole) {
      throw this.error(
        `the operator '${op.name}' in this right section binds more tightly than its operand; add parentheses`,
        op.span,
      );
    }
    return { _tag: "RightSection", op, right: resolved.right, span: s };
  }

  // ---- declarations -------------------------------------------------------------

  /**
   * `{ item ; … ; item }` with explicit or layout-inserted (virtual) braces; empty items are
   * allowed. In an implicit block, a token that cannot continue the block closes it: this is
   * the `parse-error(t)` rule of the layout algorithm.
   */
  private block<A>(what: string, startsItem: () => boolean, item: () => A): Array<A> {
    const open = this.peek();
    if (!(open._tag === "Special" && open.text === "{")) throw this.unexpected(`'{' or ${what}`);
    this.next();
    const implicit = open.virtual === true;
    const isClose = (): boolean => {
      const t = this.peek();
      return t._tag === "Special" && t.text === "}" && (t.virtual === true) === implicit;
    };
    const closeImplicit = (): Array<A> => {
      this.stream.closeImplicit(this.i);
      this.next();
      return items;
    };

    const items: Array<A> = [];
    for (;;) {
      if (isClose()) {
        this.next();
        return items;
      }
      if (this.isSpecial(";")) {
        this.next();
        continue;
      }
      if (startsItem()) {
        items.push(item());
        if (this.isSpecial(";") || isClose()) continue;
        if (implicit) return closeImplicit();
        throw this.unexpected("';' or '}'");
      }
      if (implicit) return closeImplicit();
      throw this.unexpected(`${what} or '}'`);
    }
  }

  private decl(): Decl {
    const start = this.peek();
    if (start._tag === "VarId" && (this.is("ReservedOp", "::", 1) || this.isSpecial(",", 1))) {
      return this.typeSig();
    }
    if (start._tag === "VarId") {
      // `f apat* = e` is a function clause; anything else is a pattern binding.
      const saved = this.i;
      let params: Array<Pat> | undefined = [];
      try {
        this.next();
        while (this.isApatStart()) params.push(this.apat());
        if (!this.is("ReservedOp", "=") && !this.is("ReservedOp", "|")) params = undefined;
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        params = undefined;
      }
      if (params !== undefined) {
        const rhs = this.rhs("=");
        return {
          _tag: "FunClause",
          name: start.text,
          params,
          rhs,
          span: merge(start.span, rhs.span),
        };
      }
      this.i = saved;
    }
    const pat = this.pat();
    if (!this.is("ReservedOp", "=") && !this.is("ReservedOp", "|")) throw this.unexpected("'='");
    const rhs = this.rhs("=");
    return { _tag: "PatBind", pat, rhs, span: merge(pat.span, rhs.span) };
  }

  /** `f, g :: type` */
  private typeSig(): Decl {
    const start = this.peek().span;
    const names = [this.next().text];
    while (this.isSpecial(",")) {
      this.next();
      const t = this.peek();
      if (t._tag !== "VarId") throw this.unexpected("a variable name");
      names.push(this.next().text);
    }
    this.expect("ReservedOp", "::");
    const type = this.type();
    return { _tag: "TypeSig", names, type, span: merge(start, type.span) };
  }

  /**
   * `rhs → = exp [where decls] | gdrhs [where decls]`, where `sep` is `=` for equations
   * and `->` for case alternatives.
   */
  private rhs(sep: "=" | "->"): Rhs {
    const start = this.peek().span;
    if (this.is("ReservedOp", "|")) {
      const guards: Array<GuardedExpr> = [];
      while (this.is("ReservedOp", "|")) {
        const bar = this.next().span;
        const guard = this.exp();
        if (this.is("ReservedOp", "<-")) throw this.error("pattern guards are not supported");
        if (this.isSpecial(","))
          throw this.error("multiple guards in one alternative are not supported; use '&&'");
        this.expect("ReservedOp", sep);
        const body = this.exp();
        guards.push({ guard, body, span: merge(bar, body.span) });
      }
      const where = this.whereDecls();
      return { _tag: "Guarded", guards, where, span: this.spanFrom(start) };
    }
    this.expect("ReservedOp", sep);
    const body = this.exp();
    const where = this.whereDecls();
    return { _tag: "Unguarded", body, where, span: this.spanFrom(start) };
  }

  private whereDecls(): Array<Decl> {
    if (!this.is("ReservedId", "where")) return [];
    this.next();
    return this.block(
      "a declaration",
      () => this.isApatStart(),
      () => this.decl(),
    );
  }

  // ---- patterns -----------------------------------------------------------------

  /** `pat → lpat : pat | lpat` */
  private pat(): Pat {
    const left = this.lpat();
    if (this.is("ReservedOp", ":") || this.is("ConSym")) {
      const op = this.next();
      const right = this.pat();
      return {
        _tag: "PCon",
        name: op.text,
        args: [left, right],
        span: merge(left.span, right.span),
      };
    }
    return left;
  }

  /** `lpat → - integer | gcon apat+ | apat` */
  private lpat(): Pat {
    const t = this.peek();
    if (t._tag === "VarSym" && t.text === "-") {
      const lit = this.peek(1);
      if (lit._tag !== "Int") {
        this.next();
        throw this.unexpected("an integer literal after '-' in a pattern");
      }
      this.next();
      this.next();
      return {
        _tag: "PLit",
        lit: { _tag: "Int", value: -lit.value },
        span: merge(t.span, lit.span),
      };
    }
    if (t._tag === "ConId") {
      this.next();
      const args: Array<Pat> = [];
      while (this.isApatStart()) args.push(this.apat());
      const end = args[args.length - 1]?.span ?? t.span;
      return { _tag: "PCon", name: t.text, args, span: merge(t.span, end) };
    }
    return this.apat();
  }

  private isPatStart(): boolean {
    return this.isApatStart() || this.is("VarSym", "-");
  }

  private isApatStart(): boolean {
    const t = this.peek();
    return (
      t._tag === "VarId" ||
      t._tag === "ConId" ||
      isLiteral(t) ||
      this.is("ReservedId", "_") ||
      this.isSpecial("(") ||
      this.isSpecial("[")
    );
  }

  private apat(): Pat {
    const t = this.peek();
    if (t._tag === "VarId") {
      this.next();
      if (this.is("ReservedOp", "@")) {
        this.next();
        const pat = this.apat();
        return { _tag: "PAs", name: t.text, pat, span: merge(t.span, pat.span) };
      }
      return { _tag: "PVar", name: t.text, span: t.span };
    }
    if (t._tag === "ReservedId" && t.text === "_") {
      this.next();
      return { _tag: "PWildcard", span: t.span };
    }
    if (t._tag === "ConId") {
      this.next();
      return { _tag: "PCon", name: t.text, args: [], span: t.span };
    }
    if (isLiteral(t)) {
      this.next();
      return { _tag: "PLit", lit: literalOf(t), span: t.span };
    }
    if (this.isSpecial("(")) return this.parenPat();
    if (this.isSpecial("[")) return this.listPat();
    if (this.is("ReservedOp", "~")) throw this.error("lazy patterns are not supported");
    throw this.unexpected("a pattern");
  }

  private parenPat(): Pat {
    const open = this.next().span;
    if (this.isSpecial(")")) {
      return { _tag: "PCon", name: "()", args: [], span: merge(open, this.next().span) };
    }
    if (this.is("VarSym") && this.isSpecial(")", 1)) {
      const name = this.next().text;
      const close = this.next().span;
      return { _tag: "PVar", name, span: merge(open, close) };
    }
    const first = this.pat();
    if (this.isSpecial(")")) {
      this.next();
      return first;
    }
    if (!this.isSpecial(",")) throw this.unexpected("')' or ','");
    const elems = [first];
    while (this.isSpecial(",")) {
      this.next();
      elems.push(this.pat());
    }
    const close = this.expectSpecial(")").span;
    return { _tag: "PTuple", elems, span: merge(open, close) };
  }

  private listPat(): Pat {
    const open = this.next().span;
    if (this.isSpecial("]")) {
      return { _tag: "PCon", name: "[]", args: [], span: merge(open, this.next().span) };
    }
    const elems = [this.pat()];
    while (this.isSpecial(",")) {
      this.next();
      elems.push(this.pat());
    }
    const close = this.expectSpecial("]").span;
    return { _tag: "PList", elems, span: merge(open, close) };
  }
}

const runParser = <A>(
  source: string,
  mode: LayoutMode,
  entry: (p: Parser) => A,
): Result.Result<A, LexError | ParseError> => {
  const tokens = lex(source);
  if (Result.isFailure(tokens)) return Result.fail(tokens.failure);
  try {
    return Result.succeed(entry(new Parser(new LayoutStream(tokens.success, mode))));
  } catch (e) {
    if (e instanceof ParseError) return Result.fail(e);
    throw e;
  }
};

/** Parses a whole module, applying the layout rule. */
export const parseModule = (source: string): Result.Result<Module, LexError | ParseError> =>
  runParser(source, "module", (p) => p.moduleOnly());

/** Parses a type, such as a Prelude signature. */
export const parseType = (source: string): Result.Result<Type, LexError | ParseError> =>
  runParser(source, "expression", (p) => p.typeOnly());

/** Parses a single expression, applying the layout rule. */
export const parseExpr = (source: string): Result.Result<Expr, LexError | ParseError> =>
  runParser(source, "expression", (p) => p.expressionOnly());
