/**
 * A readable rendering of Core, for tests and debugging. Not valid Haskell: `match` shows
 * a `Match` node, `rec { … }` a recursive group, and `where { … }` the bindings of a
 * guarded clause.
 */
import { isSymbolic } from "../syntax/ast.ts";
import { prettyLiteral, prettyType } from "../syntax/pretty.ts";
import { tupleArity } from "../prelude.ts";
import type { Bind, BindGroup, CExpr, CPat, Clause, GuardedBody, Name, Program } from "./core.ts";

class Printer {
  private readonly display = new Map<number, string>();
  private readonly used = new Map<string, number>();

  /** `x`, then `x_1`, `x_2`, … for distinct variables with the same source name. */
  name(n: Name): string {
    const known = this.display.get(n.id);
    if (known !== undefined) return known;
    const count = this.used.get(n.text) ?? 0;
    this.used.set(n.text, count + 1);
    const shown = count === 0 ? n.text : `${n.text}_${count}`;
    const result = isSymbolic(shown) ? `(${shown})` : shown;
    this.display.set(n.id, result);
    return result;
  }

  program(p: Program): string {
    const out: Array<string> = [];
    for (const d of p.data) {
      if (d.builtin) continue;
      const cons = d.constructors.map((c) =>
        [
          c.name,
          ...c.fields.map((f) =>
            f._tag === "TApp" || f._tag === "TFun" ? `(${prettyType(f)})` : prettyType(f),
          ),
        ].join(" "),
      );
      out.push(
        `data ${[d.name, ...d.params].join(" ")}${cons.length > 0 ? ` = ${cons.join(" | ")}` : ""}`,
      );
    }
    for (const g of p.groups) out.push(this.group(g, 0));
    return out.join("\n");
  }

  private group(g: BindGroup, indent: number): string {
    if (g._tag === "NonRec") return this.bind(g.bind, indent);
    const pad = " ".repeat(indent + 2);
    return `rec {\n${g.binds.map((b) => pad + this.bind(b, indent + 2)).join("\n")}\n${" ".repeat(indent)}}`;
  }

  private bind(b: Bind, indent: number): string {
    const name = this.name(b.name);
    const sig = b.sig === undefined ? "" : `${name} :: ${prettyType(b.sig)}\n${" ".repeat(indent)}`;
    return `${sig}${name} = ${this.expr(b.expr, 0, indent)}`;
  }

  private inlineGroup(g: BindGroup, indent: number): string {
    if (g._tag === "NonRec") return this.bind(g.bind, indent);
    return `rec { ${g.binds.map((b) => this.bind(b, indent)).join("; ")} }`;
  }

  // ctx: 0 = anywhere, 1 = function position, 2 = argument position
  expr(e: CExpr, ctx: number, indent: number): string {
    const parens = (b: boolean, s: string): string => (b ? `(${s})` : s);
    switch (e._tag) {
      case "Var":
        return this.name(e.name);
      case "Prim":
      case "Con":
        return isSymbolic(e.name) ? `(${e.name})` : e.name;
      case "Lit":
        return prettyLiteral(e.lit);
      case "App": {
        const args: Array<CExpr> = [];
        let fn: CExpr = e;
        while (fn._tag === "App") {
          args.unshift(fn.arg);
          fn = fn.fn;
        }
        const [l, r] = args;
        if (
          (fn._tag === "Prim" || fn._tag === "Con") &&
          isSymbolic(fn.name) &&
          args.length === 2 &&
          l &&
          r
        ) {
          return `(${this.expr(l, 2, indent)} ${fn.name} ${this.expr(r, 2, indent)})`;
        }
        if (fn._tag === "Con" && tupleArity(fn.name) === args.length) {
          return `(${args.map((a) => this.expr(a, 0, indent)).join(", ")})`;
        }
        return parens(
          ctx >= 2,
          [this.expr(fn, 1, indent), ...args.map((a) => this.expr(a, 2, indent))].join(" "),
        );
      }
      case "Lam": {
        const params: Array<string> = [];
        let body: CExpr = e;
        while (body._tag === "Lam") {
          params.push(this.name(body.param));
          body = body.body;
        }
        return parens(ctx > 0, `\\${params.join(" ")} -> ${this.expr(body, 0, indent)}`);
      }
      case "Let":
        return parens(
          ctx > 0,
          `let ${this.inlineGroup(e.group, indent)} in ${this.expr(e.body, 0, indent)}`,
        );
      case "If":
        return parens(
          ctx > 0,
          `if ${this.expr(e.cond, 0, indent)} then ${this.expr(e.thenBranch, 0, indent)} else ${this.expr(e.elseBranch, 0, indent)}`,
        );
      case "Match": {
        const pad = " ".repeat(indent + 2);
        const head = `match${e.scrutinees.map((s) => ` ${this.name(s)}`).join("")}`;
        const clauses = e.clauses.map((c) => pad + this.clause(c, indent + 2)).join("\n");
        return parens(ctx > 0, `${head} {\n${clauses}\n${" ".repeat(indent)}}`);
      }
      case "Typed":
        return `(${this.expr(e.expr, 0, indent)} :: ${prettyType(e.type)})`;
    }
  }

  private clause(c: Clause, indent: number): string {
    const pats = c.pats.map((p) => this.pat(p, true)).join(" ");
    return `${pats}${pats.length > 0 ? " " : ""}${this.body(c.body, indent)}`.trimStart();
  }

  private body(b: GuardedBody, indent: number): string {
    switch (b._tag) {
      case "Body":
        return `-> ${this.expr(b.expr, 0, indent)}`;
      case "Guards":
        return b.guards
          .map((g) => `| ${this.expr(g.cond, 0, indent)} -> ${this.expr(g.expr, 0, indent)}`)
          .join(" ");
      case "LetBody":
        return `where { ${this.inlineGroup(b.group, indent)} } ${this.body(b.body, indent)}`;
    }
  }

  pat(p: CPat, atomic: boolean): string {
    switch (p._tag) {
      case "PVar":
        return this.name(p.name);
      case "PWildcard":
        return "_";
      case "PLit":
        return prettyLiteral(p.lit);
      case "PAs":
        return `${this.name(p.name)}@${this.pat(p.pat, true)}`;
      case "PCon": {
        if (tupleArity(p.name) !== undefined)
          return `(${p.args.map((a) => this.pat(a, false)).join(", ")})`;
        const [l, r] = p.args;
        if (p.name === ":" && l && r) {
          const s = `${this.pat(l, true)} : ${this.pat(r, false)}`;
          return atomic ? `(${s})` : s;
        }
        if (p.args.length === 0) return p.name;
        const s = [p.name, ...p.args.map((a) => this.pat(a, true))].join(" ");
        return atomic ? `(${s})` : s;
      }
    }
  }
}

export const prettyProgram = (p: Program): string => new Printer().program(p);

export const prettyCore = (e: CExpr): string => new Printer().expr(e, 0, 0);
