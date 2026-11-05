/**
 * Lowering: resolves names and desugars the surface syntax into Core in a single pass.
 *
 * Scope errors reported here: unbound variables, constructors, types and type variables;
 * duplicate definitions; non-contiguous or arity-mismatched equations; repeated pattern
 * variables; constructor patterns with the wrong number of arguments; and type signatures
 * without a binding.
 */
import { Result } from "effect";
import { ScopeError } from "../errors.ts";
import { builtinData, builtinTypes, primNames, tupleArity, tupleName } from "../prelude.ts";
import * as S from "../syntax/ast.ts";
import { type Span, merge, noSpan } from "../syntax/span.ts";
import type {
  Bind,
  CExpr,
  CPat,
  Clause,
  ConInfo,
  DataInfo,
  GuardedBody,
  Guard,
  Name,
  Program,
} from "./core.ts";
import { dependencyGroups } from "./scc.ts";

/** Lexical scope for variables; falls back to the Prelude at the top. */
class Scope {
  constructor(
    private readonly vars: ReadonlyMap<string, Name>,
    private readonly parent: Scope | undefined,
  ) {}

  static readonly empty = new Scope(new Map(), undefined);

  extend(vars: ReadonlyMap<string, Name>): Scope {
    return vars.size === 0 ? this : new Scope(vars, this);
  }

  lookup(text: string): Name | undefined {
    return this.vars.get(text) ?? this.parent?.lookup(text);
  }
}

/** A clause of a function-like definition, before lowering. */
interface SurfaceClause {
  readonly pats: ReadonlyArray<S.Pat>;
  readonly rhs: S.Rhs;
  readonly span: Span;
}

const fail = (message: string, span: Span): never => {
  throw new ScopeError({ message, span });
};

const patVars = (
  p: S.Pat,
  acc: Array<{ name: string; span: Span }> = [],
): Array<{ name: string; span: Span }> => {
  switch (p._tag) {
    case "PVar":
      acc.push({ name: p.name, span: p.span });
      break;
    case "PAs":
      acc.push({ name: p.name, span: p.span });
      patVars(p.pat, acc);
      break;
    case "PCon":
      for (const a of p.args) patVars(a, acc);
      break;
    case "PTuple":
    case "PList":
      for (const a of p.elems) patVars(a, acc);
      break;
    case "PWildcard":
    case "PLit":
      break;
  }
  return acc;
};

class Lowerer {
  private nextId = 1;
  private readonly cons = new Map<string, ConInfo>();
  /** Type constructors in scope, with their arity. */
  private readonly types = new Map<string, number>(builtinTypes);
  private readonly data: Array<DataInfo> = [];

  constructor() {
    for (const d of builtinData) {
      const params = d.params;
      const constructors = d.constructors.map((c, tag): ConInfo => ({
        name: c.name,
        typeName: d.name,
        fields: c.fields.map((f): S.Type => ({ _tag: "TVar", name: f, span: noSpan })),
        tag,
      }));
      this.addData({ name: d.name, params, constructors, builtin: true, span: undefined });
    }
  }

  private fresh(text: string): Name {
    return { text, id: this.nextId++ };
  }

  private addData(info: DataInfo): void {
    this.types.set(info.name, info.params.length);
    for (const c of info.constructors) this.cons.set(c.name, c);
    this.data.push(info);
  }

  // ---- modules ----------------------------------------------------------------------

  lowerModule(m: S.Module): Program {
    const dataDecls = m.decls.filter((d): d is S.DataDecl => d._tag === "DataDecl");
    const valueDecls = m.decls.filter((d): d is S.Decl => d._tag !== "DataDecl");

    for (const d of dataDecls) {
      if (this.types.has(d.name)) fail(`multiple declarations of the type '${d.name}'`, d.span);
      this.types.set(d.name, d.params.length);
    }
    for (const d of dataDecls) this.lowerData(d);

    const { binds } = this.lowerBindings(valueDecls, Scope.empty, true);
    return { moduleName: m.name ?? "Main", data: this.data, groups: dependencyGroups(binds) };
  }

  private lowerData(d: S.DataDecl): void {
    const seen = new Set<string>();
    for (const p of d.params) {
      if (seen.has(p))
        fail(`the type variable '${p}' appears twice in the declaration of '${d.name}'`, d.span);
      seen.add(p);
    }
    const constructorsSeen = new Set<string>();
    const constructors = d.constructors.map((c, tag): ConInfo => {
      if (this.cons.has(c.name) || constructorsSeen.has(c.name)) {
        fail(`multiple declarations of the constructor '${c.name}'`, c.span);
      }
      constructorsSeen.add(c.name);
      for (const f of c.fields) this.checkType(f, seen);
      return { name: c.name, typeName: d.name, fields: c.fields, tag };
    });
    this.addData({ name: d.name, params: d.params, constructors, builtin: false, span: d.span });
  }

  // ---- types ------------------------------------------------------------------------

  /**
   * Checks that all type constructors are in scope. With `tyvars`, type variables must be
   * among them (data declarations); otherwise they are implicitly quantified.
   */
  private checkType(t: S.Type, tyvars?: ReadonlySet<string>): void {
    switch (t._tag) {
      case "TVar":
        if (tyvars !== undefined && !tyvars.has(t.name))
          fail(`type variable not in scope: '${t.name}'`, t.span);
        return;
      case "TCon":
        if (!this.types.has(t.name) && tupleArity(t.name) === undefined) {
          fail(`type not in scope: '${t.name}'`, t.span);
        }
        return;
      case "TApp":
        this.checkType(t.fn, tyvars);
        this.checkType(t.arg, tyvars);
        return;
      case "TFun":
        this.checkType(t.from, tyvars);
        this.checkType(t.to, tyvars);
        return;
      case "TList":
        this.checkType(t.elem, tyvars);
        return;
      case "TTuple":
        for (const e of t.elems) this.checkType(e, tyvars);
    }
  }

  // ---- binding groups -----------------------------------------------------------------

  /**
   * Lowers the declarations of one recursive scope (top level, `let`, or `where`). Returns the
   * scope extended with the bound names, and the bindings in source order.
   */
  private lowerBindings(
    decls: ReadonlyArray<S.Decl>,
    outer: Scope,
    topLevel: boolean,
  ): { scope: Scope; binds: Array<Bind> } {
    // 1. Group function clauses and collect binders.
    type Item =
      | { _tag: "Fun"; name: string; clauses: Array<SurfaceClause>; span: Span }
      | { _tag: "Pat"; decl: Extract<S.Decl, { _tag: "PatBind" }> };
    const items: Array<Item> = [];
    const names = new Map<string, Name>();
    const definedAt = new Map<string, Span>();
    const sigs = new Map<string, { type: S.Type; span: Span }>();

    const define = (name: string, span: Span): void => {
      const previous = definedAt.get(name);
      if (previous !== undefined) {
        fail(
          `multiple declarations of '${name}' (first defined at line ${previous.start.line})`,
          span,
        );
      }
      if (topLevel && primNames.has(name))
        fail(`'${name}' is already defined in the Prelude`, span);
      definedAt.set(name, span);
      names.set(name, this.fresh(name));
    };

    for (const d of decls) {
      switch (d._tag) {
        case "FunClause": {
          const last = items[items.length - 1];
          const clause: SurfaceClause = { pats: d.params, rhs: d.rhs, span: d.span };
          if (last?._tag === "Fun" && last.name === d.name && d.params.length > 0) {
            last.clauses.push(clause);
            last.span = merge(last.span, d.span);
          } else {
            define(d.name, d.span);
            items.push({ _tag: "Fun", name: d.name, clauses: [clause], span: d.span });
          }
          break;
        }
        case "PatBind": {
          const vars = patVars(d.pat);
          const inPattern = new Set<string>();
          for (const v of vars) {
            if (inPattern.has(v.name))
              fail(`conflicting definitions for '${v.name}' in a pattern`, v.span);
            inPattern.add(v.name);
            define(v.name, v.span);
          }
          items.push({ _tag: "Pat", decl: d });
          break;
        }
        case "TypeSig":
          for (const n of d.names) {
            if (sigs.has(n)) fail(`duplicate type signatures for '${n}'`, d.span);
            this.checkType(d.type);
            sigs.set(n, { type: d.type, span: d.span });
          }
          break;
      }
    }
    for (const [n, sig] of sigs) {
      if (!names.has(n))
        fail(`the type signature for '${n}' lacks an accompanying binding`, sig.span);
    }

    // 2. Lower right-hand sides in the extended (recursive) scope.
    const scope = outer.extend(names);
    const nameOf = (text: string): Name =>
      names.get(text) ?? fail(`internal: unbound '${text}'`, noSpan);
    const binds: Array<Bind> = [];
    for (const item of items) {
      if (item._tag === "Fun") {
        const name = nameOf(item.name);
        const expr = this.lowerFunction(item.clauses, scope, `function '${item.name}'`, item.span);
        binds.push({ name, expr, sig: sigs.get(item.name)?.type, span: item.span });
      } else {
        binds.push(...this.lowerPatBind(item.decl, scope, nameOf, sigs));
      }
    }
    return { scope, binds };
  }

  /** Wraps `body` in `Let`s for `binds`, in dependency order. */
  private letGroups(binds: ReadonlyArray<Bind>, body: CExpr): CExpr {
    return dependencyGroups(binds).reduceRight<CExpr>(
      (acc, group) => ({ _tag: "Let", group, body: acc, span: acc.span }),
      body,
    );
  }

  /**
   * A pattern binding `p = e` becomes a hidden binding `t = e` plus, for every variable `x`
   * in `p`, a selector `x = match t { p -> x }`.
   */
  private lowerPatBind(
    d: Extract<S.Decl, { _tag: "PatBind" }>,
    scope: Scope,
    nameOf: (text: string) => Name,
    sigs: ReadonlyMap<string, { type: S.Type }>,
  ): Array<Bind> {
    const rhs = this.guardedToExpr(this.lowerRhs(d.rhs, scope), "pattern binding", d.span);
    if (d.pat._tag === "PVar") {
      return [
        { name: nameOf(d.pat.name), expr: rhs, sig: sigs.get(d.pat.name)?.type, span: d.span },
      ];
    }
    const tuple = this.fresh("p");
    const binds: Array<Bind> = [{ name: tuple, expr: rhs, sig: undefined, span: d.span }];
    for (const v of patVars(d.pat)) {
      const locals = new Map<string, Name>();
      const pat = this.lowerPat(d.pat, locals);
      const local = locals.get(v.name) ?? fail(`internal: missing '${v.name}'`, v.span);
      const expr: CExpr = {
        _tag: "Match",
        scrutinees: [tuple],
        clauses: [
          {
            pats: [pat],
            body: { _tag: "Body", expr: { _tag: "Var", name: local, span: v.span } },
            span: d.span,
          },
        ],
        context: "pattern binding",
        span: d.span,
      };
      binds.push({ name: nameOf(v.name), expr, sig: sigs.get(v.name)?.type, span: d.span });
    }
    return binds;
  }

  // ---- functions, clauses and right-hand sides --------------------------------------------

  /** Lowers the clauses of a function (or lambda) to nested `Lam`s around a `Match`. */
  private lowerFunction(
    clauses: ReadonlyArray<SurfaceClause>,
    scope: Scope,
    context: string,
    span: Span,
  ): CExpr {
    const [first, ...rest] = clauses;
    if (first === undefined) return fail("internal: no clauses", span);
    const arity = first.pats.length;
    for (const c of rest) {
      if (c.pats.length !== arity)
        fail(`the equations for ${context} have different numbers of arguments`, c.span);
    }
    if (arity === 0) return this.guardedToExpr(this.lowerRhs(first.rhs, scope), context, span);

    // Simple case: one clause, only variable/wildcard patterns, no guards: plain lambdas.
    if (
      clauses.length === 1 &&
      first.pats.every((p) => p._tag === "PVar" || p._tag === "PWildcard")
    ) {
      const locals = new Map<string, Name>();
      const params = first.pats.map((p) => {
        const pat = this.lowerPat(p, locals);
        return pat._tag === "PVar" ? pat.name : this.fresh("_");
      });
      const body = this.lowerRhs(first.rhs, scope.extend(locals));
      if (body._tag === "Body") return this.lams(params, body.expr, span);
      const match: CExpr = {
        _tag: "Match",
        scrutinees: [],
        clauses: [{ pats: [], body, span: first.span }],
        context,
        span,
      };
      return this.lams(params, match, span);
    }

    const params = first.pats.map((p) => this.fresh(p._tag === "PVar" ? p.name : "arg"));
    const lowered = clauses.map((c) => this.lowerClause(c, scope));
    const match: CExpr = { _tag: "Match", scrutinees: params, clauses: lowered, context, span };
    return this.lams(params, match, span);
  }

  private lams(params: ReadonlyArray<Name>, body: CExpr, span: Span): CExpr {
    return params.reduceRight<CExpr>(
      (acc, param) => ({ _tag: "Lam", param, body: acc, span }),
      body,
    );
  }

  private lowerClause(c: SurfaceClause, scope: Scope): Clause {
    const locals = new Map<string, Name>();
    const pats = c.pats.map((p) => this.lowerPat(p, locals));
    return { pats, body: this.lowerRhs(c.rhs, scope.extend(locals)), span: c.span };
  }

  private lowerRhs(rhs: S.Rhs, outer: Scope): GuardedBody {
    const { scope, binds } = this.lowerBindings(rhs.where, outer, false);
    let body: GuardedBody;
    if (rhs._tag === "Unguarded") {
      body = { _tag: "Body", expr: this.lowerExpr(rhs.body, scope) };
    } else {
      const guards = rhs.guards.map((g): Guard => ({
        cond: this.lowerExpr(g.guard, scope),
        expr: this.lowerExpr(g.body, scope),
        span: g.span,
      }));
      // `| otherwise = e` (or `| True = e`) alone is just `e`.
      const [only] = guards;
      body =
        guards.length === 1 &&
        only !== undefined &&
        only.cond._tag === "Con" &&
        only.cond.name === "True"
          ? { _tag: "Body", expr: only.expr }
          : { _tag: "Guards", guards };
    }
    return dependencyGroups(binds).reduceRight<GuardedBody>(
      (acc, group) => ({ _tag: "LetBody", group, body: acc }),
      body,
    );
  }

  /** A guarded body used where an expression is needed: guards become a `Match` with no scrutinees. */
  private guardedToExpr(body: GuardedBody, context: string, span: Span): CExpr {
    switch (body._tag) {
      case "Body":
        return body.expr;
      case "LetBody":
        return {
          _tag: "Let",
          group: body.group,
          body: this.guardedToExpr(body.body, context, span),
          span,
        };
      case "Guards":
        return {
          _tag: "Match",
          scrutinees: [],
          clauses: [{ pats: [], body, span }],
          context,
          span,
        };
    }
  }

  // ---- patterns ------------------------------------------------------------------------

  /** Lowers a pattern, adding its variables to `locals` (which must not contain them yet). */
  private lowerPat(p: S.Pat, locals: Map<string, Name>): CPat {
    const bind = (text: string, span: Span): Name => {
      if (locals.has(text)) fail(`conflicting definitions for '${text}' in a pattern`, span);
      const name = this.fresh(text);
      locals.set(text, name);
      return name;
    };
    switch (p._tag) {
      case "PVar":
        return { _tag: "PVar", name: bind(p.name, p.span), span: p.span };
      case "PWildcard":
        return { _tag: "PWildcard", span: p.span };
      case "PLit":
        return { _tag: "PLit", lit: p.lit, span: p.span };
      case "PAs": {
        const name = bind(p.name, p.span);
        return { _tag: "PAs", name, pat: this.lowerPat(p.pat, locals), span: p.span };
      }
      case "PCon": {
        const arity = this.conArity(p.name, p.span);
        if (p.args.length !== arity) {
          fail(
            `the constructor '${p.name}' should have ${arity} argument${arity === 1 ? "" : "s"}, but has been given ${p.args.length}`,
            p.span,
          );
        }
        return {
          _tag: "PCon",
          name: p.name,
          args: p.args.map((a) => this.lowerPat(a, locals)),
          span: p.span,
        };
      }
      case "PTuple":
        return {
          _tag: "PCon",
          name: tupleName(p.elems.length),
          args: p.elems.map((e) => this.lowerPat(e, locals)),
          span: p.span,
        };
      case "PList":
        return p.elems.reduceRight<CPat>(
          (tail, e) => ({
            _tag: "PCon",
            name: ":",
            args: [this.lowerPat(e, locals), tail],
            span: p.span,
          }),
          { _tag: "PCon", name: "[]", args: [], span: p.span },
        );
    }
  }

  private conArity(name: string, span: Span): number {
    if (name === "()" || name === "[]") return 0;
    if (name === ":") return 2;
    const tuple = tupleArity(name);
    if (tuple !== undefined) return tuple;
    const info = this.cons.get(name);
    if (info === undefined) return fail(`data constructor not in scope: '${name}'`, span);
    return info.fields.length;
  }

  // ---- expressions -----------------------------------------------------------------------

  /** A variable or operator occurrence. */
  private resolveVar(text: string, scope: Scope, span: Span): CExpr {
    const local = scope.lookup(text);
    if (local !== undefined) return { _tag: "Var", name: local, span };
    if (text === "otherwise") return { _tag: "Con", name: "True", span };
    if (primNames.has(text)) return { _tag: "Prim", name: text, span };
    return fail(`variable not in scope: '${text}'`, span);
  }

  private resolveCon(text: string, span: Span): CExpr {
    this.conArity(text, span);
    return { _tag: "Con", name: text, span };
  }

  private resolveOp(op: S.OpRef, scope: Scope): CExpr {
    return S.isConName(op.name)
      ? this.resolveCon(op.name, op.span)
      : this.resolveVar(op.name, scope, op.span);
  }

  private app(fn: CExpr, ...args: ReadonlyArray<CExpr>): CExpr {
    return args.reduce<CExpr>(
      (f, a) => ({ _tag: "App", fn: f, arg: a, span: merge(f.span, a.span) }),
      fn,
    );
  }

  private isPrim(e: CExpr, name: string): boolean {
    return e._tag === "Prim" && e.name === name;
  }

  lowerExpr(e: S.Expr, scope: Scope): CExpr {
    switch (e._tag) {
      case "Var":
        return this.resolveVar(e.name, scope, e.span);
      case "Con":
        return this.resolveCon(e.name, e.span);
      case "Lit":
        return { _tag: "Lit", lit: e.lit, span: e.span };
      case "App":
        return {
          _tag: "App",
          fn: this.lowerExpr(e.fn, scope),
          arg: this.lowerExpr(e.arg, scope),
          span: e.span,
        };
      case "BinOp": {
        const op = this.resolveOp(e.op, scope);
        const left = this.lowerExpr(e.left, scope);
        const right = this.lowerExpr(e.right, scope);
        // Short-circuit under strict evaluation; `f $ x` is plain application.
        if (this.isPrim(op, "&&")) {
          return {
            _tag: "If",
            cond: left,
            thenBranch: right,
            elseBranch: { _tag: "Con", name: "False", span: e.op.span },
            span: e.span,
          };
        }
        if (this.isPrim(op, "||")) {
          return {
            _tag: "If",
            cond: left,
            thenBranch: { _tag: "Con", name: "True", span: e.op.span },
            elseBranch: right,
            span: e.span,
          };
        }
        if (this.isPrim(op, "$")) return { _tag: "App", fn: left, arg: right, span: e.span };
        return this.app(op, left, right);
      }
      case "Neg": {
        const inner = this.lowerExpr(e.expr, scope);
        if (inner._tag === "Lit" && inner.lit._tag === "Int") {
          return { _tag: "Lit", lit: { _tag: "Int", value: -inner.lit.value }, span: e.span };
        }
        return {
          _tag: "App",
          fn: { _tag: "Prim", name: "negate", span: e.span },
          arg: inner,
          span: e.span,
        };
      }
      case "LeftSection":
        return {
          _tag: "App",
          fn: this.resolveOp(e.op, scope),
          arg: this.lowerExpr(e.left, scope),
          span: e.span,
        };
      case "RightSection": {
        const x = this.fresh("x");
        const op = this.resolveOp(e.op, scope);
        const body = this.app(
          op,
          { _tag: "Var", name: x, span: e.span },
          this.lowerExpr(e.right, scope),
        );
        return { _tag: "Lam", param: x, body, span: e.span };
      }
      case "Lambda":
        return this.lowerFunction(
          [
            {
              pats: e.params,
              rhs: { _tag: "Unguarded", body: e.body, where: [], span: e.body.span },
              span: e.span,
            },
          ],
          scope,
          "lambda",
          e.span,
        );
      case "Let": {
        const { scope: inner, binds } = this.lowerBindings(e.decls, scope, false);
        return this.letGroups(binds, this.lowerExpr(e.body, inner));
      }
      case "If":
        return {
          _tag: "If",
          cond: this.lowerExpr(e.cond, scope),
          thenBranch: this.lowerExpr(e.thenBranch, scope),
          elseBranch: this.lowerExpr(e.elseBranch, scope),
          span: e.span,
        };
      case "Case":
        return this.lowerCase(e, scope);
      case "Do":
        return this.lowerStmts(e.stmts, scope, e.span);
      case "Typed":
        this.checkType(e.type);
        return { _tag: "Typed", expr: this.lowerExpr(e.expr, scope), type: e.type, span: e.span };
      case "Tuple":
        return this.app(
          { _tag: "Con", name: tupleName(e.elems.length), span: e.span },
          ...e.elems.map((x) => this.lowerExpr(x, scope)),
        );
      case "List":
        return e.elems.reduceRight<CExpr>(
          (tail, x) =>
            this.app({ _tag: "Con", name: ":", span: x.span }, this.lowerExpr(x, scope), tail),
          { _tag: "Con", name: "[]", span: e.span },
        );
    }
  }

  /** `case e of alts`: the scrutinee is bound to a variable (unless it already is one). */
  private lowerCase(e: Extract<S.Expr, { _tag: "Case" }>, scope: Scope): CExpr {
    const scrutinee = this.lowerExpr(e.scrutinee, scope);
    const clauses = e.alts.map((a) =>
      this.lowerClause({ pats: [a.pat], rhs: a.rhs, span: a.span }, scope),
    );
    if (scrutinee._tag === "Var") {
      return {
        _tag: "Match",
        scrutinees: [scrutinee.name],
        clauses,
        context: "case expression",
        span: e.span,
      };
    }
    const s = this.fresh("s");
    return {
      _tag: "Let",
      group: {
        _tag: "NonRec",
        bind: { name: s, expr: scrutinee, sig: undefined, span: scrutinee.span },
      },
      body: { _tag: "Match", scrutinees: [s], clauses, context: "case expression", span: e.span },
      span: e.span,
    };
  }

  /**
   * `do` desugaring (Report 3.14): `e; ss` is `e >> do ss`, `p <- e; ss` is
   * `e >>= \x -> case x of p -> do ss`, and `let ds; ss` is `let ds in do ss`.
   */
  private lowerStmts(stmts: ReadonlyArray<S.Stmt>, scope: Scope, span: Span): CExpr {
    const [st, ...rest] = stmts;
    if (st === undefined) return fail("internal: empty do block", span);
    if (rest.length === 0) {
      if (st._tag !== "ExprStmt")
        return fail("the last statement in a 'do' block must be an expression", st.span);
      return this.lowerExpr(st.expr, scope);
    }
    const prim = (name: string): CExpr => ({ _tag: "Prim", name, span: st.span });
    switch (st._tag) {
      case "ExprStmt":
        return this.app(
          prim(">>"),
          this.lowerExpr(st.expr, scope),
          this.lowerStmts(rest, scope, span),
        );
      case "LetStmt": {
        const { scope: inner, binds } = this.lowerBindings(st.decls, scope, false);
        return this.letGroups(binds, this.lowerStmts(rest, inner, span));
      }
      case "BindStmt": {
        const action = this.lowerExpr(st.expr, scope);
        const locals = new Map<string, Name>();
        const pat = this.lowerPat(st.pat, locals);
        const body = this.lowerStmts(rest, scope.extend(locals), span);
        let fn: CExpr;
        if (pat._tag === "PVar") {
          fn = { _tag: "Lam", param: pat.name, body, span: st.span };
        } else {
          const x = this.fresh("x");
          const match: CExpr = {
            _tag: "Match",
            scrutinees: [x],
            clauses: [{ pats: [pat], body: { _tag: "Body", expr: body }, span: st.span }],
            context: "do-block pattern",
            span: st.span,
          };
          fn = { _tag: "Lam", param: x, body: match, span: st.span };
        }
        return this.app(prim(">>="), action, fn);
      }
    }
  }
}

/** Resolves names and desugars a parsed module into Core. */
export const lowerModule = (m: S.Module): Result.Result<Program, ScopeError> => {
  try {
    return Result.succeed(new Lowerer().lowerModule(m));
  } catch (e) {
    if (e instanceof ScopeError) return Result.fail(e);
    throw e;
  }
};
