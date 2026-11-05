import { Result } from "effect";
import type { Expr, Pat } from "../../src/syntax/ast.ts";
import { parseExpr } from "../../src/syntax/parser.ts";

/** Parses or throws, so tests can focus on the result. */
export const parseOk = (src: string): Expr => {
  const r = parseExpr(src);
  if (Result.isFailure(r)) throw new Error(`parse failed: ${r.failure.message}`);
  return r.success;
};

/** The error message of a failing parse. */
export const parseErr = (src: string): string => {
  const r = parseExpr(src);
  if (Result.isSuccess(r)) throw new Error(`expected a parse error for: ${src}`);
  return r.failure.message;
};

/** Removes source spans, so ASTs can be compared structurally. */
export const stripSpans = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripSpans);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "span")
        .map(([k, v]) => [k, stripSpans(v)]),
    );
  }
  return value;
};

const pat = (p: Pat): string => {
  switch (p._tag) {
    case "PVar":
      return p.name;
    case "PWildcard":
      return "_";
    case "PLit":
      return JSON.stringify(p.lit.value);
    case "PAs":
      return `${p.name}@${pat(p.pat)}`;
    case "PTuple":
      return `(tuple ${p.elems.map(pat).join(" ")})`;
    case "PList":
      return `(list ${p.elems.map(pat).join(" ")})`;
    case "PCon":
      return p.args.length === 0 ? p.name : `(${p.name} ${p.args.map(pat).join(" ")})`;
  }
};

/** A fully parenthesised S-expression, to make associativity and precedence explicit. */
export const sexpr = (e: Expr): string => {
  switch (e._tag) {
    case "Var":
    case "Con":
      return e.name;
    case "Lit":
      return JSON.stringify(e.lit.value);
    case "App":
      return `(${sexpr(e.fn)} ${sexpr(e.arg)})`;
    case "BinOp":
      return `(${e.op.name} ${sexpr(e.left)} ${sexpr(e.right)})`;
    case "Neg":
      return `(neg ${sexpr(e.expr)})`;
    case "LeftSection":
      return `(lsection ${sexpr(e.left)} ${e.op.name})`;
    case "RightSection":
      return `(rsection ${e.op.name} ${sexpr(e.right)})`;
    case "Lambda":
      return `(\\ ${e.params.map(pat).join(" ")} -> ${sexpr(e.body)})`;
    case "Let":
      return `(let [${e.decls
        .map((d) =>
          d._tag === "FunClause"
            ? `${[d.name, ...d.params.map(pat)].join(" ")} = ${sexpr(d.rhs.body)}`
            : `${pat(d.pat)} = ${sexpr(d.rhs.body)}`,
        )
        .join("; ")}] ${sexpr(e.body)})`;
    case "If":
      return `(if ${sexpr(e.cond)} ${sexpr(e.thenBranch)} ${sexpr(e.elseBranch)})`;
    case "Tuple":
      return `(tuple ${e.elems.map(sexpr).join(" ")})`;
    case "List":
      return `(list ${e.elems.map(sexpr).join(" ")})`;
  }
};
