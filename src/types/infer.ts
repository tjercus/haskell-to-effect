/**
 * Hindley–Milner type inference over Core, with checked type signatures.
 *
 * - Unification variables are mutable (`MetaRef`) and carry a let-level; a binding group is
 *   generalised over the metas created at a deeper level that remain unsolved.
 * - Signatures are checked by skolemising: their variables become rigid `TVar`s that unify
 *   only with themselves, so a body less general than its signature is rejected. A rigid
 *   variable may not be unified with a meta from an outer level (it would escape).
 * - Within a binding group, bindings with signatures are checked after the bindings that
 *   do not have them (Report 4.5.2), and may be used polymorphically (polymorphic recursion).
 *
 * Besides checking, inference records types for code generation: the type of every
 * expression, the monomorphic type of every lambda- or pattern-bound variable, and the
 * type scheme of every let-bound variable. Generalised variables are rigid `TVar`s, so
 * the recorded types of a polymorphic binding's body refer to its scheme's variables.
 */
import { Result } from "effect";
import type { Bind, CExpr, CPat, GuardedBody, Match, Program } from "../core/core.ts";
import { bindsOf } from "../core/core.ts";
import { dependencyGroups } from "../core/scc.ts";
import { TypeCheckError } from "../errors.ts";
import { prims, tupleArity } from "../prelude.ts";
import type * as S from "../syntax/ast.ts";
import { parseType } from "../syntax/parser.ts";
import { type Span, noSpan } from "../syntax/span.ts";
import {
  type MetaRef,
  type Scheme,
  type TVar,
  type Type,
  TypePrinter,
  con,
  isFun,
  prune,
  substVars,
  tBool,
  tChar,
  tFun,
  tFuns,
  tIO,
  tInt,
  tList,
  tString,
  tUnit,
  zonk,
} from "./types.ts";

export interface TypedProgram {
  readonly program: Program;
  /** Type scheme of every let-bound (top-level or local) variable, by `Name.id`. */
  readonly schemes: ReadonlyMap<number, Scheme>;
  /** Type of every lambda- or pattern-bound variable, by `Name.id`. */
  readonly varTypes: ReadonlyMap<number, Type>;
  /** Type of every expression node. Call `zonk` before inspecting. */
  readonly exprTypes: ReadonlyMap<CExpr, Type>;
  /** Type scheme of a Prelude primitive. */
  readonly primScheme: (name: string) => Scheme | undefined;
  /** Type scheme of a data constructor (including `[]`, `:`, `()` and tuples). */
  readonly conScheme: (name: string) => Scheme;
}

export interface InferOptions {
  /** Require a top-level `main :: IO t` (default `true`). */
  readonly requireMain?: boolean;
}

/** Raised inside unification; turned into a `TypeCheckError` with context by `unify`. */
class Mismatch {
  constructor(readonly detail: string | undefined) {}
}

/** Generalisation level of rigid variables that are only ever instantiated. */
const GENERIC = Number.MAX_SAFE_INTEGER;

const varNames = (i: number): string => (i < 26 ? String.fromCharCode(97 + i) : `t${i - 25}`);

class Infer {
  private level = 0;
  private nextId = 1;
  private readonly schemes = new Map<number, Scheme>();
  private readonly varTypes = new Map<number, Type>();
  private readonly exprTypes = new Map<CExpr, Type>();
  /** Monomorphic types of let-bound variables whose group is being inferred. */
  private readonly pending = new Map<number, Type>();
  private readonly primSchemes = new Map<string, Scheme>();
  private readonly conSchemes = new Map<string, Scheme>();
  private readonly typeArity = new Map<string, number>([
    ["Int", 0],
    ["Char", 0],
    ["String", 0],
    ["IO", 1],
    ["()", 0],
    ["[]", 1],
    ["->", 2],
  ]);

  constructor(private readonly program: Program) {
    for (const d of program.data) {
      this.typeArity.set(d.name, d.params.length);
    }
    for (const d of program.data) {
      const vars = d.params.map((p) => this.rigid(p, GENERIC));
      const env = new Map(d.params.map((p, i): [string, Type] => [p, vars[i] ?? tUnit]));
      const result = con(d.name, ...vars);
      for (const c of d.constructors) {
        const fields = c.fields.map((f) => this.convert(f, env, undefined));
        this.conSchemes.set(c.name, { vars, type: tFuns(fields, result) });
      }
    }
    for (const p of prims) {
      const parsed = parseType(p.type);
      if (Result.isFailure(parsed)) {
        throw new Error(`invalid Prelude type for ${p.name}: ${p.type}`);
      }
      const vars: Array<TVar> = [];
      const type = this.convert(parsed.success, new Map(), (name) => {
        const v = this.rigid(name, GENERIC);
        vars.push(v);
        return v;
      });
      this.primSchemes.set(p.name, { vars, type });
    }
  }

  // ---- variables, schemes ----------------------------------------------------------------

  private meta(): Type {
    const ref: MetaRef = { id: this.nextId++, level: this.level, link: undefined };
    return { _tag: "TMeta", ref };
  }

  private rigid(name: string, level: number): TVar {
    return { _tag: "TVar", name, id: this.nextId++, level };
  }

  private instantiate(s: Scheme): Type {
    if (s.vars.length === 0) {
      return s.type;
    }
    return substVars(s.type, new Map(s.vars.map((v) => [v.id, this.meta()])));
  }

  /**
   * Quantifies over the unsolved metas created deeper than the current level. A recursive
   * group is generalised together, so that metas shared between its bindings become the
   * same variable in every scheme.
   */
  private generalizeGroup(types: ReadonlyArray<Type>): Array<Scheme> {
    const all: Array<TVar> = [];
    const bind = (ty: Type): void => {
      const p = prune(ty);
      if (p._tag === "TMeta" && p.ref.level > this.level) {
        const v = this.rigid(varNames(all.length), this.level + 1);
        all.push(v);
        p.ref.link = v;
      } else if (p._tag === "TCon") {
        for (const a of p.args) {
          bind(a);
        }
      }
    };
    for (const t of types) {
      bind(t);
    }
    const generalized = new Set(all.map((v) => v.id));
    return types.map((t) => {
      const type = zonk(t);
      const vars: Array<TVar> = [];
      const collect = (ty: Type): void => {
        if (ty._tag === "TVar" && generalized.has(ty.id) && !vars.includes(ty)) {
          vars.push(ty);
        } else if (ty._tag === "TCon") {
          for (const a of ty.args) {
            collect(a);
          }
        }
      };
      collect(type);
      return { vars, type };
    });
  }

  private conScheme(name: string, span: Span): Scheme {
    const known = this.conSchemes.get(name);
    if (known !== undefined) {
      return known;
    }
    const a = this.rigid("a", GENERIC);
    if (name === "()") {
      return { vars: [], type: tUnit };
    }
    if (name === "[]") {
      return { vars: [a], type: tList(a) };
    }
    if (name === ":") {
      return { vars: [a], type: tFuns([a, tList(a)], tList(a)) };
    }
    const arity = tupleArity(name);
    if (arity === undefined) {
      return this.fail(`unknown constructor '${name}'`, span);
    }
    const vars = Array.from({ length: arity }, (_, i) => this.rigid(varNames(i), GENERIC));
    const scheme: Scheme = { vars, type: tFuns(vars, con(name, ...vars)) };
    this.conSchemes.set(name, scheme);
    return scheme;
  }

  // ---- syntax types --------------------------------------------------------------------

  /**
   * Converts a source type. Type variables are looked up in `vars`; unknown ones are created
   * with `freshVar` (or rejected when it is `undefined`). Type constructors must be fully
   * applied: there are no higher-kinded types.
   */
  private convert(
    t: S.Type,
    vars: Map<string, Type>,
    freshVar: ((name: string) => Type) | undefined,
  ): Type {
    const go = (ty: S.Type): Type => this.convert(ty, vars, freshVar);
    switch (t._tag) {
      case "TFun":
        return tFun(go(t.from), go(t.to));
      case "TList":
        return tList(go(t.elem));
      case "TTuple":
        return con(`(${",".repeat(t.elems.length - 1)})`, ...t.elems.map(go));
      case "TVar":
      case "TCon":
      case "TApp": {
        const args: Array<S.Type> = [];
        let head: S.Type = t;
        while (head._tag === "TApp") {
          args.unshift(head.arg);
          head = head.fn;
        }
        if (head._tag === "TVar") {
          if (args.length > 0) {
            this.fail(
              `the type variable '${head.name}' is applied to arguments; higher-kinded types are not supported`,
              t.span,
            );
          }
          const known = vars.get(head.name);
          if (known !== undefined) {
            return known;
          }
          if (freshVar === undefined) {
            return this.fail(`type variable not in scope: '${head.name}'`, head.span);
          }
          const v = freshVar(head.name);
          vars.set(head.name, v);
          return v;
        }
        if (head._tag !== "TCon") {
          return go(head);
        }
        const arity = this.typeArity.get(head.name) ?? tupleArity(head.name);
        if (arity === undefined) {
          return this.fail(`type not in scope: '${head.name}'`, head.span);
        }
        if (args.length !== arity) {
          this.fail(
            `the type '${head.name}' expects ${arity} argument${arity === 1 ? "" : "s"}, but has been given ${args.length}`,
            t.span,
          );
        }
        if (head.name === "String") {
          return tString;
        }
        return con(head.name, ...args.map(go));
      }
    }
  }

  /** The scheme declared by a signature, with its variables rigid at `level`. */
  private sigScheme(sig: S.Type, level: number): Scheme {
    const vars: Array<TVar> = [];
    const type = this.convert(sig, new Map(), (name) => {
      const v = this.rigid(name, level);
      vars.push(v);
      return v;
    });
    return { vars, type };
  }

  // ---- unification -----------------------------------------------------------------------

  private fail(message: string, span: Span): never {
    throw new TypeCheckError({ message, span });
  }

  /**
   * Unifies the `expected` type with the `actual` type of the thing at `span`. `what`
   * describes where, as in `in argument 2 of 'f'`.
   */
  private unify(expected: Type, actual: Type, span: Span, what: string | undefined): void {
    try {
      this.unifyInner(expected, actual);
    } catch (e) {
      if (!(e instanceof Mismatch)) {
        throw e;
      }
      const printer = new TypePrinter();
      const exp = printer.print(expected);
      const act = printer.print(actual);
      const where = what === undefined ? "" : ` ${what}`;
      const detail = e.detail === undefined ? "" : `: ${e.detail}`;
      this.fail(
        `couldn't match expected type '${exp}' with actual type '${act}'${where}${detail}`,
        span,
      );
    }
  }

  private unifyInner(a0: Type, b0: Type): void {
    const a = prune(a0);
    const b = prune(b0);
    if (a._tag === "TMeta" && b._tag === "TMeta" && a.ref === b.ref) {
      return;
    }
    if (a._tag === "TMeta") {
      return this.bindMeta(a.ref, b);
    }
    if (b._tag === "TMeta") {
      return this.bindMeta(b.ref, a);
    }
    if (a._tag === "TVar" && b._tag === "TVar" && a.id === b.id) {
      return;
    }
    if (
      a._tag === "TCon" &&
      b._tag === "TCon" &&
      a.name === b.name &&
      a.args.length === b.args.length
    ) {
      a.args.forEach((x, i) => {
        const y = b.args[i];
        if (y !== undefined) {
          this.unifyInner(x, y);
        }
      });
      return;
    }
    const rigid = a._tag === "TVar" ? a : b._tag === "TVar" ? b : undefined;
    throw new Mismatch(
      rigid === undefined
        ? undefined
        : `'${rigid.name}' is a rigid type variable bound by a type signature`,
    );
  }

  private bindMeta(ref: MetaRef, t: Type): void {
    const check = (ty: Type): void => {
      const p = prune(ty);
      if (p._tag === "TMeta") {
        if (p.ref === ref) {
          const printer = new TypePrinter();
          const self: Type = { _tag: "TMeta", ref };
          throw new Mismatch(
            `cannot construct the infinite type ${printer.print(self)} ~ ${printer.print(t)}`,
          );
        }
        p.ref.level = Math.min(p.ref.level, ref.level);
      } else if (p._tag === "TVar") {
        if (p.level > ref.level) {
          throw new Mismatch(
            `the rigid type variable '${p.name}' would escape the scope of its type signature`,
          );
        }
      } else {
        for (const x of p.args) {
          check(x);
        }
      }
    };
    check(t);
    ref.link = t;
  }

  // ---- programs and binding groups --------------------------------------------------------

  run(requireMain: boolean): TypedProgram {
    for (const g of this.program.groups) {
      this.inferBinds(bindsOf(g));
    }
    const main = this.program.groups.flatMap(bindsOf).find((b) => b.name.text === "main");
    if (main === undefined) {
      if (requireMain) {
        this.fail("the module does not define 'main'", noSpan);
      }
    } else {
      const scheme = this.schemes.get(main.name.id);
      if (scheme !== undefined) {
        const t = this.instantiate(scheme);
        const result = this.meta();
        try {
          this.unifyInner(tIO(result), t);
        } catch (e) {
          if (!(e instanceof Mismatch)) {
            throw e;
          }
          this.fail(
            `'main' must have type 'IO t', but it has type '${new TypePrinter().print(t)}'`,
            main.span,
          );
        }
      }
    }
    return {
      program: this.program,
      schemes: this.schemes,
      varTypes: this.varTypes,
      exprTypes: this.exprTypes,
      primScheme: (name) => this.primSchemes.get(name),
      conScheme: (name) => this.conScheme(name, noSpan),
    };
  }

  /** Infers one (possibly recursive) group of bindings and records their schemes. */
  private inferBinds(binds: ReadonlyArray<Bind>): void {
    // Signatures are known up front, so every binding can use them polymorphically.
    const declared = new Map<number, Scheme>();
    for (const b of binds) {
      if (b.sig === undefined) {
        continue;
      }
      const scheme = this.sigScheme(b.sig, this.level + 1);
      declared.set(b.name.id, scheme);
      this.schemes.set(b.name.id, scheme);
    }
    for (const sub of dependencyGroups(binds, { ignoreSignatures: true })) {
      const members = bindsOf(sub);
      this.level++;
      for (const b of members) {
        if (!declared.has(b.name.id)) {
          this.pending.set(b.name.id, this.meta());
        }
      }
      for (const b of members) {
        const sig = declared.get(b.name.id);
        if (sig !== undefined) {
          const printed = new TypePrinter().print(sig.type);
          this.checkExpr(
            b.expr,
            sig.type,
            `in the definition of '${b.name.text}' (declared as '${printed}')`,
          );
        } else {
          this.checkExpr(
            b.expr,
            this.pending.get(b.name.id) ?? this.meta(),
            `in the definition of '${b.name.text}'`,
          );
        }
      }
      this.level--;
      const inferred = members.flatMap((b) => {
        const mono = this.pending.get(b.name.id);
        this.pending.delete(b.name.id);
        return mono === undefined ? [] : [{ b, mono }];
      });
      const generalized = this.generalizeGroup(inferred.map((x) => x.mono));
      inferred.forEach(({ b }, i) => {
        const scheme = generalized[i];
        if (scheme !== undefined) {
          this.schemes.set(b.name.id, scheme);
        }
      });
    }
  }

  // ---- expressions ---------------------------------------------------------------------

  private lookupVar(id: number, text: string, span: Span): Type {
    const mono = this.pending.get(id) ?? this.varTypes.get(id);
    if (mono !== undefined) {
      return mono;
    }
    const scheme = this.schemes.get(id);
    if (scheme === undefined) {
      return this.fail(`internal: no type for '${text}'`, span);
    }
    return this.instantiate(scheme);
  }

  /**
   * Checks `e` against `expected`. The expected type is pushed into lambdas, `let` bodies and
   * `if` branches, so that a mismatch is reported where it occurs rather than at the
   * enclosing expression.
   */
  private checkExpr(e: CExpr, expected: Type, what: string | undefined): void {
    const exp = prune(expected);
    switch (e._tag) {
      case "Lam":
        if (!isFun(exp)) {
          break;
        }
        this.varTypes.set(e.param.id, exp.args[0]);
        this.checkExpr(e.body, exp.args[1], what);
        this.exprTypes.set(e, expected);
        return;
      case "Let":
        this.inferBinds(bindsOf(e.group));
        this.checkExpr(e.body, expected, what);
        this.exprTypes.set(e, expected);
        return;
      case "If":
        this.unify(
          tBool,
          this.inferExpr(e.cond),
          e.cond.span,
          "in the condition of an if expression",
        );
        this.checkExpr(e.thenBranch, expected, "in the then branch of an if expression");
        this.checkExpr(e.elseBranch, expected, "in the else branch of an if expression");
        this.exprTypes.set(e, expected);
        return;
      default:
        break;
    }
    this.unify(expected, this.inferExpr(e), e.span, what);
  }

  private inferExpr(e: CExpr): Type {
    const t = this.inferNode(e);
    this.exprTypes.set(e, t);
    return t;
  }

  private inferNode(e: CExpr): Type {
    switch (e._tag) {
      case "Var":
        return this.lookupVar(e.name.id, e.name.text, e.span);
      case "Prim": {
        const s = this.primSchemes.get(e.name);
        if (s === undefined) {
          return this.fail(`internal: unknown primitive '${e.name}'`, e.span);
        }
        return this.instantiate(s);
      }
      case "Con":
        return this.instantiate(this.conScheme(e.name, e.span));
      case "Lit":
        return e.lit._tag === "Int" ? tInt : e.lit._tag === "Char" ? tChar : tString;
      case "App":
        return this.inferApp(e);
      case "Lam": {
        const param = this.meta();
        this.varTypes.set(e.param.id, param);
        return tFun(param, this.inferExpr(e.body));
      }
      case "Let":
        this.inferBinds(bindsOf(e.group));
        return this.inferExpr(e.body);
      case "If": {
        this.unify(
          tBool,
          this.inferExpr(e.cond),
          e.cond.span,
          "in the condition of an if expression",
        );
        const t = this.inferExpr(e.thenBranch);
        this.unify(
          t,
          this.inferExpr(e.elseBranch),
          e.elseBranch.span,
          "in the else branch of an if expression",
        );
        return t;
      }
      case "Match":
        return this.inferMatch(e);
      case "Typed": {
        // `e :: t` means `e` has the polymorphic type `forall vars. t`; the expression's own
        // type is an instance of it.
        this.level++;
        const scheme = this.sigScheme(e.type, this.level);
        const printed = new TypePrinter().print(scheme.type);
        this.checkExpr(e.expr, scheme.type, `in an expression annotated with '${printed}'`);
        this.level--;
        return this.instantiate(scheme);
      }
    }
  }

  /** Application spine `f a1 … an`, checking each argument against the parameter type. */
  private inferApp(e: Extract<CExpr, { _tag: "App" }>): Type {
    const spine: Array<Extract<CExpr, { _tag: "App" }>> = [];
    let head: CExpr = e;
    while (head._tag === "App") {
      spine.unshift(head);
      head = head.fn;
    }
    const headName =
      head._tag === "Var"
        ? head.name.text
        : head._tag === "Prim" || head._tag === "Con"
          ? head.name
          : undefined;
    let fnType = this.inferExpr(head);
    spine.forEach((app, i) => {
      let f = prune(fnType);
      if (f._tag === "TMeta") {
        const fresh = tFun(this.meta(), this.meta());
        this.unifyInner(f, fresh);
        f = fresh;
      }
      if (!isFun(f)) {
        const shown = new TypePrinter().print(f);
        return this.fail(
          headName === undefined
            ? `this expression is applied to an argument, but its type '${shown}' is not a function type`
            : `'${headName}' is applied to too many arguments (it has type '${new TypePrinter().print(this.exprTypes.get(head) ?? f)}')`,
          app.span,
        );
      }
      const [param, result] = f.args;
      const what =
        headName === undefined ? "in a function argument" : `in argument ${i + 1} of '${headName}'`;
      this.checkExpr(app.arg, param, what);
      if (app !== e) {
        this.exprTypes.set(app, result);
      }
      fnType = result;
    });
    return fnType;
  }

  private inferMatch(m: Match): Type {
    const scrutinees = m.scrutinees.map((s) => this.lookupVar(s.id, s.text, m.span));
    const result = this.meta();
    const where = m.context.startsWith("function")
      ? `in an equation for ${m.context}`
      : `in a ${m.context}`;
    for (const clause of m.clauses) {
      clause.pats.forEach((p, i) => this.checkPat(p, scrutinees[i] ?? this.meta()));
      this.inferGuarded(clause.body, result, where);
    }
    return result;
  }

  private inferGuarded(body: GuardedBody, result: Type, where: string): void {
    switch (body._tag) {
      case "Body":
        this.checkExpr(body.expr, result, where);
        return;
      case "Guards":
        for (const g of body.guards) {
          this.unify(tBool, this.inferExpr(g.cond), g.cond.span, "in a guard");
          this.checkExpr(g.expr, result, where);
        }
        return;
      case "LetBody":
        this.inferBinds(bindsOf(body.group));
        this.inferGuarded(body.body, result, where);
    }
  }

  // ---- patterns ----------------------------------------------------------------------------

  private checkPat(p: CPat, expected: Type): void {
    switch (p._tag) {
      case "PVar":
        this.varTypes.set(p.name.id, expected);
        return;
      case "PWildcard":
        return;
      case "PLit": {
        const t = p.lit._tag === "Int" ? tInt : p.lit._tag === "Char" ? tChar : tString;
        this.unify(expected, t, p.span, "in a pattern");
        return;
      }
      case "PAs":
        this.varTypes.set(p.name.id, expected);
        this.checkPat(p.pat, expected);
        return;
      case "PCon": {
        let t = this.instantiate(this.conScheme(p.name, p.span));
        const params: Array<Type> = [];
        for (let i = 0; i < p.args.length; i++) {
          const f = prune(t);
          if (!isFun(f)) {
            return this.fail(`internal: constructor '${p.name}' has too few fields`, p.span);
          }
          params.push(f.args[0]);
          t = f.args[1];
        }
        this.unify(expected, t, p.span, `in a pattern with constructor '${p.name}'`);
        p.args.forEach((a, i) => this.checkPat(a, params[i] ?? this.meta()));
      }
    }
  }
}

/** Infers and checks the types of a Core program. */
export const inferProgram = (
  program: Program,
  options: InferOptions = {},
): Result.Result<TypedProgram, TypeCheckError> => {
  try {
    return Result.succeed(new Infer(program).run(options.requireMain ?? true));
  } catch (e) {
    if (e instanceof TypeCheckError) {
      return Result.fail(e);
    }
    throw e;
  }
};
