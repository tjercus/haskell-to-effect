import type { Span } from "./span.ts";

export const reservedIds = new Set([
  "case",
  "class",
  "data",
  "default",
  "deriving",
  "do",
  "else",
  "foreign",
  "if",
  "import",
  "in",
  "infix",
  "infixl",
  "infixr",
  "instance",
  "let",
  "module",
  "newtype",
  "of",
  "then",
  "type",
  "where",
  "_",
]);

export const reservedOps = new Set(["..", ":", "::", "=", "\\", "|", "<-", "->", "@", "~", "=>"]);

export type Token =
  | { readonly _tag: "VarId"; readonly text: string; readonly span: Span }
  | { readonly _tag: "ConId"; readonly text: string; readonly span: Span }
  | { readonly _tag: "VarSym"; readonly text: string; readonly span: Span }
  | { readonly _tag: "ConSym"; readonly text: string; readonly span: Span }
  | { readonly _tag: "ReservedId"; readonly text: string; readonly span: Span }
  | { readonly _tag: "ReservedOp"; readonly text: string; readonly span: Span }
  /**
   * One of `( ) , ; [ ] \` { }`. Braces and semicolons inserted by the layout rule are
   * marked `virtual`.
   */
  | {
      readonly _tag: "Special";
      readonly text: string;
      readonly span: Span;
      readonly virtual?: true;
    }
  | { readonly _tag: "Int"; readonly text: string; readonly value: number; readonly span: Span }
  | { readonly _tag: "Char"; readonly text: string; readonly value: string; readonly span: Span }
  | { readonly _tag: "String"; readonly text: string; readonly value: string; readonly span: Span }
  | { readonly _tag: "EOF"; readonly text: ""; readonly span: Span };

export const describeToken = (t: Token): string => {
  switch (t._tag) {
    case "EOF":
      return "end of input";
    case "Int":
    case "Char":
    case "String":
      return `literal ${t.text}`;
    case "Special":
      if (t.virtual) {
        if (t.text === "{") {
          return "the start of an indented block";
        }
        if (t.text === ";") {
          return "a new line at the same indentation";
        }
        return "the end of an indented block";
      }
      return `'${t.text}'`;
    default:
      return `'${t.text}'`;
  }
};
