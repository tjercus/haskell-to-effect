import { type Decl, type Expr, type Literal, type Pat, isSymbolic } from "./ast.ts";
import { fixityOf, negationFixity } from "./fixity.ts";

// Precedence contexts, in the style of `showsPrec`:
//   0      top level (open-ended forms like lambda, let, if allowed)
//   0..9   operand of an infix operator
//   10     function position of an application
//   11     argument position (atomic expressions only)
const APP = 10;
const ATOM = 11;

const escapeChar = (c: string, quote: '"' | "'", next: string): string => {
  switch (c) {
    case "\\":
      return "\\\\";
    case "\n":
      return "\\n";
    case "\t":
      return "\\t";
    case "\r":
      return "\\r";
    case quote:
      return `\\${quote}`;
  }
  const cp = c.codePointAt(0) ?? 0;
  if (cp < 0x20 || cp === 0x7f) {
    // A numeric escape followed by a digit needs `\&` to terminate it.
    return `\\${cp}${quote === '"' && /^[0-9]/.test(next) ? "\\&" : ""}`;
  }
  return c;
};

const escapeString = (s: string, quote: '"' | "'"): string => {
  const chars = Array.from(s); // Haskell Chars are code points
  return chars.map((c, i) => escapeChar(c, quote, chars[i + 1] ?? "")).join("");
};

export const prettyLiteral = (lit: Literal): string => {
  switch (lit._tag) {
    case "Int":
      return String(lit.value);
    case "Char":
      return `'${escapeString(lit.value, "'")}'`;
    case "String":
      return `"${escapeString(lit.value, '"')}"`;
  }
};

const varName = (name: string): string => (isSymbolic(name) ? `(${name})` : name);
const opName = (name: string): string => (isSymbolic(name) ? name : `\`${name}\``);
const parensIf = (b: boolean, s: string): string => (b ? `(${s})` : s);

// ---- patterns ------------------------------------------------------------------

// Pattern contexts: 0 = pat, 1 = lpat, 2 = apat.
const prettyPatPrec = (p: Pat, ctx: number): string => {
  switch (p._tag) {
    case "PVar":
      return varName(p.name);
    case "PWildcard":
      return "_";
    case "PLit":
      return parensIf(ctx > 1 && p.lit._tag === "Int" && p.lit.value < 0, prettyLiteral(p.lit));
    case "PAs":
      return `${p.name}@${prettyPatPrec(p.pat, 2)}`;
    case "PTuple":
      return `(${p.elems.map((e) => prettyPatPrec(e, 0)).join(", ")})`;
    case "PList":
      return `[${p.elems.map((e) => prettyPatPrec(e, 0)).join(", ")}]`;
    case "PCon": {
      const [l, r] = p.args;
      if (isSymbolic(p.name) && p.args.length === 2 && l !== undefined && r !== undefined) {
        return parensIf(ctx > 0, `${prettyPatPrec(l, 1)} ${p.name} ${prettyPatPrec(r, 0)}`);
      }
      if (p.args.length === 0) return varName(p.name);
      return parensIf(
        ctx > 1,
        [varName(p.name), ...p.args.map((a) => prettyPatPrec(a, 2))].join(" "),
      );
    }
  }
};

export const prettyPat = (p: Pat): string => prettyPatPrec(p, 0);

// ---- expressions & declarations ----------------------------------------------------

export const prettyDecl = (d: Decl): string => {
  switch (d._tag) {
    case "FunClause":
      return (
        [varName(d.name), ...d.params.map((p) => prettyPatPrec(p, 2))].join(" ") +
        ` = ${prettyExpr(d.rhs.body)}`
      );
    case "PatBind":
      return `${prettyPat(d.pat)} = ${prettyExpr(d.rhs.body)}`;
  }
};

const prettyPrec = (e: Expr, ctx: number): string => {
  switch (e._tag) {
    case "Var":
    case "Con":
      return varName(e.name);
    case "Lit":
      return prettyLiteral(e.lit);
    case "App":
      return parensIf(ctx > APP, `${prettyPrec(e.fn, APP)} ${prettyPrec(e.arg, ATOM)}`);
    case "BinOp": {
      const { prec, assoc } = fixityOf(e.op.name);
      const l = prettyPrec(e.left, assoc === "left" ? prec : prec + 1);
      const r = prettyPrec(e.right, assoc === "right" ? prec : prec + 1);
      return parensIf(ctx > prec, `${l} ${opName(e.op.name)} ${r}`);
    }
    case "Neg":
      return parensIf(
        ctx > negationFixity.prec,
        `- ${prettyPrec(e.expr, negationFixity.prec + 1)}`,
      );
    case "LeftSection": {
      const { prec, assoc } = fixityOf(e.op.name);
      return `(${prettyPrec(e.left, assoc === "left" ? prec : prec + 1)} ${opName(e.op.name)})`;
    }
    case "RightSection": {
      const { prec, assoc } = fixityOf(e.op.name);
      return `(${opName(e.op.name)} ${prettyPrec(e.right, assoc === "right" ? prec : prec + 1)})`;
    }
    case "Lambda":
      return parensIf(
        ctx > 0,
        `\\${e.params.map((p) => prettyPatPrec(p, 2)).join(" ")} -> ${prettyPrec(e.body, 0)}`,
      );
    case "Let":
      return parensIf(
        ctx > 0,
        `let { ${e.decls.map(prettyDecl).join("; ")} } in ${prettyPrec(e.body, 0)}`,
      );
    case "If":
      return parensIf(
        ctx > 0,
        `if ${prettyPrec(e.cond, 0)} then ${prettyPrec(e.thenBranch, 0)} else ${prettyPrec(e.elseBranch, 0)}`,
      );
    case "Tuple":
      return `(${e.elems.map((x) => prettyPrec(x, 0)).join(", ")})`;
    case "List":
      return `[${e.elems.map((x) => prettyPrec(x, 0)).join(", ")}]`;
  }
};

/** Renders an expression as Haskell source with as few parentheses as fixities allow. */
export const prettyExpr = (e: Expr): string => prettyPrec(e, 0);
