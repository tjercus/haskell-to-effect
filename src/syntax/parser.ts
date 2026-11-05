import { Result } from "effect";
import { type LexError, ParseError } from "../errors.ts";
import type { Decl, Expr, Literal, OpRef, Pat, Rhs } from "./ast.ts";
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

class Parser {
  private i = 0;

  constructor(private readonly stream: LayoutStream) {}

  // ---- token helpers ----------------------------------------------------------

  private peek(ahead = 0): Token {
    return this.stream.at(this.i + ahead);
  }

  private next(): Token {
    const t = this.peek();
    if (t._tag !== "EOF") this.i++;
    return t;
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

  // ---- expressions ------------------------------------------------------------

  /** `exp → infixexp` */
  private exp(): Expr {
    return resolveInfix(this.infixItems(false).items);
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
        case "do":
          throw this.error(`'${t.text}' expressions are not supported yet`);
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
    const first = resolveInfix(items);
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
    if (start._tag === "VarId") {
      // `f apat* = e` is a function clause; anything else is a pattern binding.
      const saved = this.i;
      let params: Array<Pat> | undefined = [];
      try {
        this.next();
        while (this.isApatStart()) params.push(this.apat());
        if (!this.is("ReservedOp", "=")) params = undefined;
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        params = undefined;
      }
      if (params !== undefined) {
        const rhs = this.rhs();
        return {
          _tag: "FunClause",
          name: start.text,
          params,
          rhs,
          span: merge(start.span, rhs.body.span),
        };
      }
      this.i = saved;
    }
    const pat = this.pat();
    if (!this.is("ReservedOp", "=")) throw this.unexpected("'='");
    const rhs = this.rhs();
    return { _tag: "PatBind", pat, rhs, span: merge(pat.span, rhs.body.span) };
  }

  private rhs(): Rhs {
    this.expect("ReservedOp", "=");
    return { _tag: "Unguarded", body: this.exp() };
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

/** Parses a single expression, applying the layout rule. */
export const parseExpr = (source: string): Result.Result<Expr, LexError | ParseError> =>
  runParser(source, "expression", (p) => p.expressionOnly());
