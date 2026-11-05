/**
 * Code generation: typed Core → TypeScript.
 *
 * - Every binding is a `const`; functions are curried arrow functions. A binding whose scheme
 *   quantifies type variables and whose type is a function becomes a generic arrow function
 *   `<a>(x: a): R => …` (eta-expanded if necessary). Polymorphic non-function values use
 *   `never` for their type variables: a value of type `forall a. [a]` can only be empty.
 * - Calls to polymorphic functions get explicit type arguments, computed by matching the
 *   callee's scheme against its inferred type at the call site, so TypeScript never has to
 *   infer them.
 * - Lambda parameters are annotated with their inferred types; bindings declare their return
 *   types (needed for recursion).
 * - `Match` compiles to `if` chains testing `_tag`, so TypeScript's narrowing checks every
 *   field access. `Let`/`Match` in expression position become immediately invoked functions.
 * - `show` and `print` are type-directed: a shower is built from the argument's static type,
 *   with the runtime's reflective `showAny` for unknown (polymorphic) parts.
 */
import type { Bind, BindGroup, CExpr, DataInfo, GuardedBody, Match, Name } from "../core/core.ts";
import { bindsOf } from "../core/core.ts";
import { tupleArity } from "../prelude.ts";
import { type Binding, type CompiledMatch, type Decision, MatchCompiler } from "./match.ts";
import type { Span } from "../syntax/span.ts";
import type { TypedProgram } from "../types/infer.ts";
import { type Scheme, type TVar, type Type, isFun, prune, zonk } from "../types/types.ts";

export interface CodegenOptions {
  /** Source file name, used in pattern-match failure messages. */
  readonly fileName: string;
  /** Import path of the runtime module. */
  readonly runtimeImport: string;
}

const jsReserved = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false " +
    "finally for function if import in instanceof new null return super switch this throw true try " +
    "typeof var void while with yield let static implements interface package private protected public " +
    "await arguments eval undefined NaN Infinity rt process globalThis"
  ).split(" "),
);

const tsReservedTypes = new Set(
  "any unknown never void undefined null string number boolean bigint symbol object this keyof typeof infer is asserts readonly unique".split(
    " ",
  ),
);

/** Curried runtime names of Prelude primitives whose Haskell name is not a JS identifier. */
const primJs: Record<string, string> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "==": "eq",
  "/=": "neq",
  "<": "lt",
  "<=": "le",
  ">": "gt",
  ">=": "ge",
  "&&": "and",
  "||": "or",
  "++": "append",
  ".": "compose",
  $: "apply",
  ">>=": "bind",
  ">>": "seq_",
  return: "return_",
  const: "const_",
  null: "null_",
};

const unsupportedPrims = new Map<string, string>();

type Code = { readonly code: string; readonly atomic: boolean };
const atom = (code: string): Code => ({ code, atomic: true });
const low = (code: string): Code => ({ code, atomic: false });
const paren = (c: Code): string => (c.atomic ? c.code : `(${c.code})`);

const isPrimType = (t: Type): boolean => {
  const p = prune(t);
  return p._tag === "TCon" && ["Int", "Char", "Bool", "()"].includes(p.name);
};

const isOrdPrim = (t: Type): boolean => {
  const p = prune(t);
  return p._tag === "TCon" && (p.name === "Int" || p.name === "Char");
};

/** A compile-time warning, such as a non-exhaustive pattern match. */
export interface Warning {
  readonly message: string;
  readonly span: Span;
}

export class CodegenError extends Error {
  constructor(
    message: string,
    readonly span: Span,
  ) {
    super(message);
  }
}

class Gen {
  private readonly names = new Map<number, string>();
  private readonly usedNames = new Set<string>();
  /** TS names of the type variables in scope, by `TVar.id`. */
  private readonly typeNames = new Map<number, string>();
  /** Binders emitted as generic functions: they take explicit type arguments when called. */
  private readonly genericBinders = new Set<number>();
  private readonly data = new Map<string, DataInfo>();
  /** Local name of the `Effect` module (renamed if a user type or constructor is `Effect`). */
  private readonly effect: string;
  private usesEffect = false;
  private readonly matcher: MatchCompiler;
  /** Warnings found while compiling pattern matches. */
  readonly warnings: Array<Warning> = [];

  constructor(
    private readonly tp: TypedProgram,
    private readonly options: CodegenOptions,
  ) {
    for (const d of tp.program.data) this.data.set(d.name, d);
    this.matcher = new MatchCompiler(tp.program.data);
    for (const d of tp.program.data) for (const c of d.constructors) this.usedNames.add(c.name);
    const taken = tp.program.data.some(
      (d) => d.name === "Effect" || d.constructors.some((c) => c.name === "Effect"),
    );
    this.effect = taken ? "Effect$" : "Effect";
    this.usedNames.add(this.effect);
  }

  // ---- names --------------------------------------------------------------------------

  private name(n: Name): string {
    const known = this.names.get(n.id);
    if (known !== undefined) return known;
    let base = n.text.replace(/'/g, "$p");
    if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(base))
      base = `_${base.replace(/[^\p{L}\p{N}_$]/gu, "_")}`;
    if (jsReserved.has(base)) base = `${base}_`;
    let candidate = base;
    for (let i = 1; this.usedNames.has(candidate); i++) candidate = `${base}$${i}`;
    this.usedNames.add(candidate);
    this.names.set(n.id, candidate);
    return candidate;
  }

  private fresh(text: string): string {
    let candidate = text;
    for (let i = 1; this.usedNames.has(candidate); i++) candidate = `${text}$${i}`;
    this.usedNames.add(candidate);
    return candidate;
  }

  /** Brings type variables into scope (as TS type parameters, or as `never`). */
  private withTypeVars<A>(
    vars: ReadonlyArray<TVar>,
    asNever: boolean,
    body: (params: Array<string>) => A,
  ): A {
    const inScope = new Set(this.typeNames.values());
    const params = vars.map((v) => {
      if (asNever) {
        this.typeNames.set(v.id, "never");
        return "never";
      }
      let base = v.name.replace(/'/g, "_");
      if (tsReservedTypes.has(base)) base = `${base}_`;
      let candidate = base;
      for (let i = 1; inScope.has(candidate); i++) candidate = `${base}${i}`;
      inScope.add(candidate);
      this.typeNames.set(v.id, candidate);
      return candidate;
    });
    try {
      return body(params);
    } finally {
      for (const v of vars) this.typeNames.delete(v.id);
    }
  }

  // ---- types --------------------------------------------------------------------------

  private ts(t: Type): string {
    const p = prune(t);
    switch (p._tag) {
      case "TMeta":
        return "unknown";
      case "TVar":
        // A rigid variable not in scope comes from a polymorphic type annotation.
        return this.typeNames.get(p.id) ?? "any";
      case "TCon": {
        const args = p.args.map((a) => this.ts(a));
        switch (p.name) {
          case "Int":
            return "number";
          case "Char":
            return "rt.Char";
          case "Bool":
            return "boolean";
          case "()":
            return "undefined";
          case "[]":
            return `rt.List<${args[0] ?? "unknown"}>`;
          case "IO":
            return `rt.IO<${args[0] ?? "unknown"}>`;
          case "->":
            return `(x: ${args[0] ?? "unknown"}) => ${args[1] ?? "unknown"}`;
          case "Maybe":
            return `rt.Maybe<${args[0] ?? "unknown"}>`;
          case "Either":
            return `rt.Either<${args[0] ?? "unknown"}, ${args[1] ?? "unknown"}>`;
        }
        if (tupleArity(p.name) !== undefined) return `readonly [${args.join(", ")}]`;
        return args.length === 0 ? p.name : `${p.name}<${args.join(", ")}>`;
      }
    }
  }

  /** Explicit type arguments for a reference to something with `scheme`, used at type `at`. */
  private typeArgs(scheme: Scheme | undefined, at: Type | undefined): string {
    if (scheme === undefined || scheme.vars.length === 0 || at === undefined) return "";
    const subst = new Map<number, Type>();
    const match = (s: Type, t: Type): void => {
      const ps = prune(s);
      const pt = prune(t);
      if (ps._tag === "TVar") {
        if (!subst.has(ps.id)) subst.set(ps.id, pt);
      } else if (ps._tag === "TCon" && pt._tag === "TCon" && ps.name === pt.name) {
        ps.args.forEach((a, i) => {
          const b = pt.args[i];
          if (b !== undefined) match(a, b);
        });
      }
    };
    match(scheme.type, zonk(at));
    const args = scheme.vars.map((v) => {
      const t = subst.get(v.id);
      return t === undefined ? "unknown" : this.ts(t);
    });
    return `<${args.join(", ")}>`;
  }

  /** A type in return-annotation position, where function types need parentheses. */
  private tsReturn(t: Type): string {
    return isFun(prune(t)) ? `(${this.ts(t)})` : this.ts(t);
  }

  private typeOf(e: CExpr): Type {
    const t = this.tp.exprTypes.get(e);
    if (t === undefined) throw new CodegenError("internal: expression without a type", e.span);
    return zonk(t);
  }

  // ---- show -------------------------------------------------------------------------------

  /** A `Shower` for values of type `t`; `env` maps type variables to shower expressions. */
  private shower(t: Type, env: ReadonlyMap<number, string> = new Map()): string {
    const p = prune(t);
    if (p._tag === "TMeta") return "rt.showAny";
    if (p._tag === "TVar") return env.get(p.id) ?? "rt.showAny";
    const [a, b] = p.args;
    switch (p.name) {
      case "Int":
        return "rt.showInt";
      case "Char":
        return "rt.showChar";
      case "Bool":
        return "rt.showBool";
      case "()":
        return "rt.showUnit";
      case "->":
      case "IO":
        return "rt.showFun";
      case "[]": {
        const elem = a === undefined ? undefined : prune(a);
        if (elem?._tag === "TCon" && elem.name === "Char") return "rt.showString";
        return `rt.showList(${a === undefined ? "rt.showAny" : this.shower(a, env)})`;
      }
      case "Maybe":
        return `rt.showMaybe(${a === undefined ? "rt.showAny" : this.shower(a, env)})`;
      case "Either":
        return `rt.showEither(${a === undefined ? "rt.showAny" : this.shower(a, env)}, ${b === undefined ? "rt.showAny" : this.shower(b, env)})`;
    }
    if (tupleArity(p.name) !== undefined)
      return `rt.showTuple([${p.args.map((x) => this.shower(x, env)).join(", ")}])`;
    const fn = `show$${p.name}`;
    return p.args.length === 0 ? fn : `${fn}(${p.args.map((x) => this.shower(x, env)).join(", ")})`;
  }

  // ---- data types -------------------------------------------------------------------------

  private dataDecl(d: DataInfo): Array<string> {
    const vars = (this.tp.conScheme(d.constructors[0]?.name ?? "").vars ?? []).slice(
      0,
      d.params.length,
    );
    const out: Array<string> = [];
    this.withTypeVars(vars, false, (params) => {
      const tparams = params.length === 0 ? "" : `<${params.join(", ")}>`;
      const self = `${d.name}${tparams}`;
      const conFields = d.constructors.map((c) => {
        const scheme = this.tp.conScheme(c.name);
        const fields: Array<string> = [];
        let t = scheme.type;
        while (isFun(t)) {
          fields.push(this.ts(t.args[0]));
          t = t.args[1];
        }
        return { c, fields };
      });
      if (d.constructors.length === 0) {
        const own = d.params.length === 0 ? "" : `<${d.params.join(", ")}>`;
        out.push(`export type ${d.name}${own} = never;`);
      } else {
        out.push(`export type ${self} =`);
        conFields.forEach(({ c, fields }, i) => {
          const props = [
            `readonly _tag: "${c.name}"`,
            ...fields.map((f, j) => `readonly a${j}: ${f}`),
          ];
          out.push(`  | { ${props.join("; ")} }${i === conFields.length - 1 ? ";" : ""}`);
        });
      }
      for (const { c, fields } of conFields) {
        if (fields.length === 0) {
          const t =
            params.length === 0 ? d.name : `${d.name}<${params.map(() => "never").join(", ")}>`;
          out.push(`export const ${c.name}: ${t} = { _tag: "${c.name}" };`);
          continue;
        }
        const args = fields.map((_, j) => `a${j}`);
        const lambdas = fields.map((f, j) => `(a${j}: ${f})`);
        const last = lambdas.length - 1;
        const chain = lambdas.map((l, j) => (j === last ? `${l}: ${self}` : l)).join(" => ");
        out.push(
          `export const ${c.name} = ${tparams}${chain} => ({ _tag: "${c.name}", ${args.join(", ")} });`,
        );
      }
      if (d.constructors.length > 0) {
        out.push(
          `rt.registerConstructors([${d.constructors.map((c) => `"${c.name}"`).join(", ")}]);`,
        );
      }
      // Shower (the equivalent of `deriving Show`).
      const env = new Map(vars.map((v, i) => [v.id, `s_${params[i] ?? i}`]));
      const showParams = params.map((p) => `s_${p}: rt.Shower<${p}>`).join(", ");
      const cases = conFields.map(({ c, fields }) => {
        const scheme = this.tp.conScheme(c.name);
        const fieldTypes: Array<Type> = [];
        let t = scheme.type;
        while (isFun(t)) {
          fieldTypes.push(t.args[0]);
          t = t.args[1];
        }
        const shown = fieldTypes.map((ft, j) => `${this.shower(ft, env)}(11, x.a${j})`);
        return fields.length === 0
          ? `    case "${c.name}": return "${c.name}";`
          : `    case "${c.name}": return rt.showCon(p, "${c.name}", [${shown.join(", ")}]);`;
      });
      const body =
        d.constructors.length === 0
          ? `() => ""`
          : `(p, x) => {\n  switch (x._tag) {\n${cases.join("\n")}\n  }\n}`;
      out.push(
        params.length === 0
          ? `export const show$${d.name}: rt.Shower<${self}> = ${body};`
          : `export const show$${d.name} = ${tparams}(${showParams}): rt.Shower<${self}> => ${body};`,
      );
    });
    return out;
  }

  // ---- bindings ---------------------------------------------------------------------------

  private isGenericBinding(b: Bind): boolean {
    const s = this.tp.schemes.get(b.name.id);
    return s !== undefined && s.vars.length > 0 && isFun(prune(s.type));
  }

  private group(g: BindGroup, indent: string, exported: boolean): Array<string> {
    const binds = bindsOf(g);
    for (const b of binds) if (this.isGenericBinding(b)) this.genericBinders.add(b.name.id);
    return binds.flatMap((b) => this.binding(b, indent, exported));
  }

  private binding(b: Bind, indent: string, exported: boolean): Array<string> {
    const scheme = this.tp.schemes.get(b.name.id);
    if (scheme === undefined)
      throw new CodegenError(`internal: no scheme for '${b.name.text}'`, b.span);
    const name = this.name(b.name);
    const prefix = `${indent}${exported ? "export " : ""}const ${name}`;
    const type = prune(scheme.type);
    const generic = this.genericBinders.has(b.name.id);

    return this.withTypeVars(scheme.vars, !generic, (params) => {
      const tparams = generic && params.length > 0 ? `<${params.join(", ")}>` : "";
      if (isFun(type) && (b.expr._tag === "Lam" || generic)) {
        const [paramType, resultType] = type.args;
        let fn: string;
        if (b.expr._tag === "Lam") {
          const param = this.name(b.expr.param);
          const body = this.lamBody(b.expr.body, indent);
          fn = `${tparams}(${param}: ${this.ts(paramType)}): ${this.tsReturn(resultType)} => ${body}`;
        } else {
          // Eta-expand so that the binding can carry type parameters.
          const x = this.fresh("x");
          fn = `${tparams}(${x}: ${this.ts(paramType)}): ${this.tsReturn(resultType)} => ${paren(this.expr(b.expr, indent))}(${x})`;
        }
        return [`${prefix} = ${fn};`];
      }
      const t = this.ts(type);
      // Top-level IO actions are built when they run, so that errors happen in order.
      if (type._tag === "TCon" && type.name === "IO" && exported && !this.isIOChain(b.expr)) {
        return [`${prefix}: ${t} = rt.suspend(() => ${this.expr(b.expr, indent).code});`];
      }
      return [`${prefix}: ${t} = ${this.expr(b.expr, indent).code};`];
    });
  }

  // ---- statements ---------------------------------------------------------------------------

  private needsStatements(e: CExpr): boolean {
    return (
      e._tag === "Let" ||
      e._tag === "Match" ||
      (e._tag === "If" &&
        (this.needsStatements(e.thenBranch) || this.needsStatements(e.elseBranch)))
    );
  }

  /** The body of an arrow function: an expression, or a block. */
  private lamBody(e: CExpr, indent: string): string {
    if (!this.needsStatements(e)) {
      const c = this.expr(e, indent);
      // An object literal body would need parentheses; constructors never produce one here.
      return c.code;
    }
    const inner = `${indent}  `;
    return `{\n${this.returns(e, inner).join("\n")}\n${indent}}`;
  }

  /** Statements that evaluate `e` and return it. */
  private returns(e: CExpr, indent: string): Array<string> {
    return this.statements(e, indent, false);
  }

  /**
   * Statements that evaluate `e` and return it. With `inGen`, they are the body of an
   * `Effect.gen` generator and `e` is an IO action: `>>=` and `>>` become `yield*`
   * statements, and the final action is returned with `return yield*`.
   */
  private statements(e: CExpr, indent: string, inGen: boolean): Array<string> {
    if (inGen) {
      const step = this.ioStep(e);
      if (step?.kind === "bind") {
        const t = this.tp.varTypes.get(step.param.id);
        const annotation = t === undefined ? "" : `: ${this.ts(t)}`;
        return [
          `${indent}const ${this.name(step.param)}${annotation} = yield* ${this.expr(step.action, indent).code};`,
          ...this.statements(step.rest, indent, true),
        ];
      }
      if (step?.kind === "then") {
        return [
          `${indent}yield* ${this.expr(step.action, indent).code};`,
          ...this.statements(step.rest, indent, true),
        ];
      }
    }
    switch (e._tag) {
      case "Let":
        return [...this.group(e.group, indent, false), ...this.statements(e.body, indent, inGen)];
      case "Match":
        return this.match(e, indent, inGen);
      case "If": {
        const branchy = (x: CExpr): boolean =>
          this.needsStatements(x) || (inGen && this.isIOChain(x));
        if (branchy(e.thenBranch) || branchy(e.elseBranch)) {
          return [
            `${indent}if (${this.expr(e.cond, indent).code}) {`,
            ...this.statements(e.thenBranch, `${indent}  `, inGen),
            `${indent}}`,
            ...this.statements(e.elseBranch, indent, inGen),
          ];
        }
        break;
      }
      default:
        break;
    }
    if (inGen) {
      // `return x` at the end of a do block is just the value.
      if (
        e._tag === "App" &&
        e.fn._tag === "Prim" &&
        (e.fn.name === "return" || e.fn.name === "pure")
      ) {
        return [`${indent}return ${this.expr(e.arg, indent).code};`];
      }
      return [`${indent}return yield* ${this.expr(e, indent).code};`];
    }
    return [`${indent}return ${this.expr(e, indent).code};`];
  }

  /** `m >>= \x -> rest` or `m >> rest`, the steps of a desugared do block. */
  private ioStep(
    e: CExpr,
  ):
    | { readonly kind: "bind"; readonly action: CExpr; readonly param: Name; readonly rest: CExpr }
    | { readonly kind: "then"; readonly action: CExpr; readonly rest: CExpr }
    | undefined {
    if (e._tag !== "App" || e.fn._tag !== "App" || e.fn.fn._tag !== "Prim") return undefined;
    const action = e.fn.arg;
    if (e.fn.fn.name === ">>") return { kind: "then", action, rest: e.arg };
    if (e.fn.fn.name === ">>=" && e.arg._tag === "Lam") {
      return { kind: "bind", action, param: e.arg.param, rest: e.arg.body };
    }
    return undefined;
  }

  /** Whether `e` is (a `let` around) a sequence of IO actions, emitted as `Effect.gen`. */
  private isIOChain(e: CExpr): boolean {
    if (e._tag === "Let") return this.isIOChain(e.body);
    return this.ioStep(e) !== undefined;
  }

  private gen(e: CExpr, indent: string): Code {
    this.usesEffect = true;
    const body = this.statements(e, `${indent}  `, true).join("\n");
    return atom(`${this.effect}.gen(function* () {\n${body}\n${indent}})`);
  }

  /** A source range as GHC prints it: `f.hs:3:5-9` or `f.hs:(3,1)-(4,20)`. */
  private location(span: Span): string {
    const { start, end } = span;
    const endCol = Math.max(start.col, end.col - 1);
    return start.line === end.line
      ? `${this.options.fileName}:${start.line}:${start.col}-${endCol}`
      : `${this.options.fileName}:(${start.line},${start.col})-(${end.line},${endCol})`;
  }

  /**
   * A `Match` as a decision tree. A clause reached from more than one leaf becomes a local
   * function (a join point), called with its pattern variables and, if its guards can all
   * fail, a continuation for the rest of the match. Inside `Effect.gen` bodies contain
   * `yield*`, which cannot move into a nested function, so there clauses are duplicated.
   */
  private match(m: Match, indent: string, inGen: boolean): Array<string> {
    const scrutinees = m.scrutinees.map((s) => this.name(s));
    const canFail = m.clauses.map((c) => !this.alwaysReturns(c.body));
    const compiled = this.matcher.compile(
      scrutinees,
      m.clauses.map((c) => c.pats),
      canFail,
    );
    this.checkMatch(m, compiled);

    const leaves = new Map<number, { count: number; bindings: ReadonlyArray<Binding> }>();
    const visit = (d: Decision): void => {
      if (d._tag === "Leaf") {
        const known = leaves.get(d.clause);
        leaves.set(d.clause, {
          count: (known?.count ?? 0) + 1,
          bindings: known?.bindings ?? d.bindings,
        });
        if (d.fallback) visit(d.fallback);
      } else if (d._tag === "Switch") {
        for (const c of d.cases) visit(c.body);
        if (d.default) visit(d.default);
      }
    };
    visit(compiled.tree);

    const out: Array<string> = [];
    const joins = new Map<number, { fn: string; params: ReadonlyArray<Binding> }>();
    if (!inGen) {
      const result = this.ts(this.typeOf(m));
      for (const [clause, { count, bindings }] of leaves) {
        const c = m.clauses[clause];
        if (count < 2 || c === undefined) continue;
        const fn = this.fresh(`clause${clause + 1}`);
        const params = bindings.map((b) => {
          const t = this.tp.varTypes.get(b.name.id);
          return `${this.name(b.name)}: ${t === undefined ? "unknown" : this.ts(t)}`;
        });
        const fail = this.fresh("fail");
        if (canFail[clause] === true) params.push(`${fail}: () => ${result}`);
        const inner = `${indent}  `;
        out.push(
          `${indent}const ${fn} = (${params.join(", ")}): ${result} => {`,
          ...this.guarded(c.body, inner, false),
          ...(canFail[clause] === true ? [`${inner}return ${fail}();`] : []),
          `${indent}};`,
        );
        joins.set(clause, { fn, params: bindings });
      }
    }
    out.push(...this.decision(compiled.tree, m, indent, inGen, joins));
    return out;
  }

  private failure(m: Match): string {
    if (m.context === "do-block pattern") {
      // In IO, a failed pattern in a bind calls `fail`.
      const pat = m.clauses[0]?.pats[0];
      return `user error (Pattern match failure in do expression at ${this.location(pat?.span ?? m.span)})`;
    }
    // GHC's wording: "function f", "case", "lambda".
    const context = m.context.replace(/'/g, "").replace("case expression", "case");
    return `${this.location(m.span)}: Non-exhaustive patterns in ${context}`;
  }

  private decision(
    d: Decision,
    m: Match,
    indent: string,
    inGen: boolean,
    joins: ReadonlyMap<number, { fn: string; params: ReadonlyArray<Binding> }>,
  ): Array<string> {
    const inner = `${indent}  `;
    switch (d._tag) {
      case "Fail":
        return [`${indent}return rt.patternFail(${JSON.stringify(this.failure(m))});`];
      case "Leaf": {
        const join = joins.get(d.clause);
        if (join !== undefined) {
          const args = join.params.map(
            (p) => d.bindings.find((b) => b.name.id === p.name.id)?.occ ?? "undefined",
          );
          if (d.fallback !== undefined) {
            args.push(
              `() => {\n${this.decision(d.fallback, m, inner, inGen, joins).join("\n")}\n${indent}}`,
            );
          }
          return [`${indent}return ${join.fn}(${args.join(", ")});`];
        }
        const clause = m.clauses[d.clause];
        if (clause === undefined) return [];
        return [
          ...d.bindings.map((b) => `${indent}const ${this.name(b.name)} = ${b.occ};`),
          ...this.guarded(clause.body, indent, inGen),
          ...(d.fallback === undefined ? [] : this.decision(d.fallback, m, indent, inGen, joins)),
        ];
      }
      case "Switch": {
        const [only] = d.cases;
        if (d.cases.length === 1 && only !== undefined && d.default === undefined) {
          // The type has a single constructor: nothing to test.
          return this.decision(only.body, m, indent, inGen, joins);
        }
        if (d.kind === "tag") {
          const out = [`${indent}switch (${d.occ}._tag) {`];
          d.cases.forEach((c, i) => {
            // The last case of an exhaustive switch is `default`, so every path returns.
            const last = i === d.cases.length - 1 && d.default === undefined;
            out.push(
              `${inner}${last ? "default" : `case "${c.test}"`}: {`,
              ...this.decision(c.body, m, `${inner}  `, inGen, joins),
              `${inner}}`,
            );
          });
          if (d.default !== undefined) {
            out.push(
              `${inner}default: {`,
              ...this.decision(d.default, m, `${inner}  `, inGen, joins),
              `${inner}}`,
            );
          }
          out.push(`${indent}}`);
          return out;
        }
        // Booleans and literals: an `if` chain; the last alternative needs no test.
        const out: Array<string> = [];
        const alternatives = d.cases.map((c) => ({ test: `${d.occ} === ${c.test}`, body: c.body }));
        const rest = d.default ?? alternatives.pop()?.body;
        for (const a of alternatives) {
          out.push(
            `${indent}if (${a.test}) {`,
            ...this.decision(a.body, m, inner, inGen, joins),
            `${indent}}`,
          );
        }
        if (rest !== undefined) out.push(...this.decision(rest, m, indent, inGen, joins));
        return out;
      }
    }
  }

  /** Warns about non-exhaustive matches and redundant clauses, as GHC does. */
  private checkMatch(m: Match, compiled: CompiledMatch): void {
    if (m.context === "do-block pattern" || m.context === "pattern binding") return;
    if (compiled.missing.length > 0) {
      const shown = [...new Set(compiled.missing.map((w) => (w.length === 0 ? "_" : w.join(" "))))];
      const list = shown.slice(0, 3).join(", ") + (shown.length > 3 ? ", …" : "");
      this.warnings.push({
        message: `pattern match is non-exhaustive in ${m.context}; patterns not matched: ${list}`,
        span: m.span,
      });
    }
    m.clauses.forEach((c, i) => {
      if (!compiled.reachable.has(i)) {
        this.warnings.push({
          message: `pattern match is redundant in ${m.context}: this clause can never match`,
          span: c.span,
        });
      }
    });
  }

  private alwaysReturns(b: GuardedBody): boolean {
    switch (b._tag) {
      case "Body":
        return true;
      case "LetBody":
        return this.alwaysReturns(b.body);
      case "Guards":
        return b.guards.some((g) => g.cond._tag === "Con" && g.cond.name === "True");
    }
  }

  private guarded(b: GuardedBody, indent: string, inGen: boolean): Array<string> {
    switch (b._tag) {
      case "Body":
        return this.statements(b.expr, indent, inGen);
      case "LetBody":
        return [...this.group(b.group, indent, false), ...this.guarded(b.body, indent, inGen)];
      case "Guards": {
        const out: Array<string> = [];
        for (const g of b.guards) {
          if (g.cond._tag === "Con" && g.cond.name === "True") {
            out.push(...this.statements(g.expr, indent, inGen));
            break;
          }
          out.push(
            `${indent}if (${this.expr(g.cond, indent).code}) {`,
            ...this.statements(g.expr, `${indent}  `, inGen),
            `${indent}}`,
          );
        }
        return out;
      }
    }
  }

  // ---- expressions ----------------------------------------------------------------------------

  private iife(e: CExpr, indent: string): Code {
    return atom(`(() => {\n${this.returns(e, `${indent}  `).join("\n")}\n${indent}})()`);
  }

  private expr(e: CExpr, indent: string): Code {
    if (this.isIOChain(e)) return this.gen(e, indent);
    switch (e._tag) {
      case "Var":
        return atom(this.name(e.name));
      case "Prim":
      case "Con":
      case "App":
        return this.application(e, indent);
      case "Lit":
        switch (e.lit._tag) {
          case "Int":
            return e.lit.value < 0 ? atom(`(${e.lit.value})`) : atom(String(e.lit.value));
          case "Char":
            return atom(JSON.stringify(e.lit.value));
          case "String":
            return atom(`rt.str(${JSON.stringify(e.lit.value)})`);
        }
      case "Lam": {
        const t = this.tp.varTypes.get(e.param.id);
        const param = `(${this.name(e.param)}: ${t === undefined ? "unknown" : this.ts(t)})`;
        return low(`${param} => ${this.lamBody(e.body, indent)}`);
      }
      case "Let":
      case "Match":
        return this.iife(e, indent);
      case "If":
        if (this.needsStatements(e)) return this.iife(e, indent);
        return atom(
          `(${this.expr(e.cond, indent).code} ? ${this.expr(e.thenBranch, indent).code} : ${this.expr(e.elseBranch, indent).code})`,
        );
      case "Typed":
        return this.expr(e.expr, indent);
    }
  }

  /** An application spine `head a1 … an` (n may be 0). */
  private application(e: CExpr, indent: string): Code {
    const args: Array<CExpr> = [];
    let head: CExpr = e;
    while (head._tag === "App") {
      args.unshift(head.arg);
      head = head.fn;
    }
    const arg = (i: number): string => {
      const a = args[i];
      if (a === undefined) throw new CodegenError("internal: missing argument", e.span);
      return this.expr(a, indent).code;
    };
    const argType = (i: number): Type => {
      const a = args[i];
      if (a === undefined) throw new CodegenError("internal: missing argument", e.span);
      return this.typeOf(a);
    };
    const call = (fn: string, from: number): Code =>
      atom(
        fn +
          args
            .slice(from)
            .map((_, i) => `(${arg(from + i)})`)
            .join(""),
      );

    if (head._tag === "Prim") {
      const special = this.primApplication(head, args.length, arg, argType);
      if (special !== undefined) return special;
      const unsupported = unsupportedPrims.get(head.name);
      if (unsupported !== undefined) throw new CodegenError(unsupported, head.span);
      const js = `rt.${primJs[head.name] ?? head.name}`;
      const targs =
        args.length > 0
          ? this.typeArgs(this.tp.primScheme(head.name), this.tp.exprTypes.get(head))
          : "";
      return args.length === 0 ? atom(js) : call(js + targs, 0);
    }

    if (head._tag === "Con") {
      const special = this.conApplication(head, args.length, arg, argType);
      if (special !== undefined) return special;
      const builtin = ["Just", "Left", "Right", "Nothing"].includes(head.name);
      const js = builtin ? `rt.${head.name}` : head.name;
      const scheme = this.tp.conScheme(head.name);
      const targs =
        args.length > 0 && isFun(prune(scheme.type))
          ? this.typeArgs(scheme, this.tp.exprTypes.get(head))
          : "";
      return args.length === 0 ? atom(js) : call(js + targs, 0);
    }

    if (head._tag === "Var") {
      if (args.length === 0) return atom(this.name(head.name));
      const targs = this.genericBinders.has(head.name.id)
        ? this.typeArgs(this.tp.schemes.get(head.name.id), this.tp.exprTypes.get(head))
        : "";
      return call(this.name(head.name) + targs, 0);
    }

    return call(paren(this.expr(head, indent)), 0);
  }

  /** Primitives with special code: inlined operators and type-directed `show`/`print`. */
  private primApplication(
    head: Extract<CExpr, { _tag: "Prim" }>,
    n: number,
    arg: (i: number) => string,
    argType: (i: number) => Type,
  ): Code | undefined {
    const binary = (op: string): Code => atom(`(${arg(0)} ${op} ${arg(1)})`);
    const instType = this.tp.exprTypes.get(head);
    const firstParam = (): Type | undefined => {
      const t = instType === undefined ? undefined : prune(zonk(instType));
      return t !== undefined && isFun(t) ? t.args[0] : undefined;
    };
    switch (head.name) {
      case "+":
      case "-":
      case "*":
        return n === 2 ? binary(head.name) : undefined;
      case "div":
        return n === 2 ? atom(`rt.divInt(${arg(0)}, ${arg(1)})`) : undefined;
      case "mod":
        return n === 2 ? atom(`rt.modInt(${arg(0)}, ${arg(1)})`) : undefined;
      case "==":
        if (n !== 2) return undefined;
        return isPrimType(argType(0)) ? binary("===") : atom(`rt.equals(${arg(0)}, ${arg(1)})`);
      case "/=":
        if (n !== 2) return undefined;
        return isPrimType(argType(0)) ? binary("!==") : atom(`(!rt.equals(${arg(0)}, ${arg(1)}))`);
      case "<":
      case "<=":
      case ">":
      case ">=":
        if (n !== 2) return undefined;
        return isOrdPrim(argType(0))
          ? binary(head.name)
          : atom(`(rt.compareAny(${arg(0)}, ${arg(1)}) ${head.name} 0)`);
      case "negate":
        return n === 1 ? atom(`(-${arg(0)})`) : undefined;
      case "not":
        return n === 1 ? atom(`(!${arg(0)})`) : undefined;
      case "++":
        return n === 2 ? atom(`rt.appendList(${arg(0)}, ${arg(1)})`) : undefined;
      case ">>":
        // The second action is built only after the first has run.
        return n === 2 ? atom(`rt.then_(${arg(0)}, () => ${arg(1)})`) : undefined;
      case "show":
      case "print": {
        const t = firstParam();
        const fn = head.name === "show" ? "rt.showWith" : "rt.printWith";
        const shower = `${fn}(${t === undefined ? "rt.showAny" : this.shower(t)})`;
        if (n === 0) return atom(shower);
        if (n === 1) return atom(`${shower}(${arg(0)})`);
        return undefined;
      }
      default:
        return undefined;
    }
  }

  /** Constructors with special representations: Bool, (), lists and tuples. */
  private conApplication(
    head: Extract<CExpr, { _tag: "Con" }>,
    n: number,
    arg: (i: number) => string,
    argType: (i: number) => Type,
  ): Code | undefined {
    switch (head.name) {
      case "True":
        return atom("true");
      case "False":
        return atom("false");
      case "()":
        return atom("undefined");
      case "[]":
        return atom("rt.Nil");
      case ":": {
        const elem =
          n >= 1
            ? `<${this.ts(argType(0))}>`
            : this.typeArgs(this.tp.conScheme(":"), this.tp.exprTypes.get(head));
        if (n === 2) return atom(`rt.Cons${elem}(${arg(0)}, ${arg(1)})`);
        if (n === 1) return atom(`rt.cons${elem}(${arg(0)})`);
        return atom(`rt.cons${elem}`);
      }
    }
    const arity = tupleArity(head.name);
    if (arity === undefined) return undefined;
    if (n === arity)
      return low(`[${Array.from({ length: arity }, (_, i) => arg(i)).join(", ")}] as const`);
    // Partially applied tuple constructor: a curried lambda.
    const t = this.tp.exprTypes.get(head);
    const params: Array<string> = [];
    let ft = t === undefined ? undefined : prune(zonk(t));
    for (let i = 0; i < arity; i++) {
      params.push(ft !== undefined && isFun(ft) ? this.ts(ft.args[0]) : "unknown");
      ft = ft !== undefined && isFun(ft) ? prune(ft.args[1]) : undefined;
    }
    const names = params.map((_, i) => this.fresh(`t${i}`));
    const given = Array.from({ length: n }, (_, i) => arg(i));
    const rest = names.slice(n);
    const lambda = rest.map((x, i) => `(${x}: ${params[n + i] ?? "unknown"}) =>`).join(" ");
    return low(`${lambda} [${[...given, ...rest].join(", ")}] as const`);
  }

  // ---- program ------------------------------------------------------------------------------

  program(): string {
    const body: Array<string> = [];
    for (const d of this.tp.program.data) {
      if (d.builtin) continue;
      body.push(...this.dataDecl(d), "");
    }
    for (const g of this.tp.program.groups) body.push(...this.group(g, "", true), "");
    const effectImport = this.effect === "Effect" ? "Effect" : `Effect as ${this.effect}`;
    return [
      `// Generated by haskell-to-effect from ${this.options.fileName}. Do not edit.`,
      ...(this.usesEffect ? [`import { ${effectImport} } from "effect";`] : []),
      `import * as rt from ${JSON.stringify(this.options.runtimeImport)};`,
      "",
      ...body,
    ].join("\n");
  }
}

/** Generates a TypeScript module for a typed program. Throws `CodegenError`. */
export const generate = (
  tp: TypedProgram,
  options: CodegenOptions,
): { readonly code: string; readonly warnings: ReadonlyArray<Warning> } => {
  const gen = new Gen(tp, options);
  const code = gen.program();
  return { code, warnings: gen.warnings };
};
