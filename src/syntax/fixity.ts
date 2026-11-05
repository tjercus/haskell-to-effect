export type Assoc = "left" | "right" | "none";

export interface Fixity {
  readonly prec: number;
  readonly assoc: Assoc;
}

const infixl = (prec: number): Fixity => ({ prec, assoc: "left" });
const infixr = (prec: number): Fixity => ({ prec, assoc: "right" });
const infix = (prec: number): Fixity => ({ prec, assoc: "none" });

/** Fixities of the built-in operators, as declared in the Haskell 2010 Prelude. */
const table: ReadonlyMap<string, Fixity> = new Map([
  [".", infixr(9)],
  ["!!", infixl(9)],
  ["^", infixr(8)],
  ["*", infixl(7)],
  ["/", infixl(7)],
  ["div", infixl(7)],
  ["mod", infixl(7)],
  ["quot", infixl(7)],
  ["rem", infixl(7)],
  ["+", infixl(6)],
  ["-", infixl(6)],
  [":", infixr(5)],
  ["++", infixr(5)],
  ["==", infix(4)],
  ["/=", infix(4)],
  ["<", infix(4)],
  ["<=", infix(4)],
  [">", infix(4)],
  [">=", infix(4)],
  ["elem", infix(4)],
  ["notElem", infix(4)],
  ["&&", infixr(3)],
  ["||", infixr(2)],
  [">>", infixl(1)],
  [">>=", infixl(1)],
  ["=<<", infixr(1)],
  ["$", infixr(0)],
  ["$!", infixr(0)],
  ["seq", infixr(0)],
]);

/** Operators without a fixity declaration default to `infixl 9`. */
export const defaultFixity: Fixity = infixl(9);

/** Prefix negation behaves like `infixl 6`. */
export const negationFixity: Fixity = infixl(6);

export const fixityOf = (name: string): Fixity => table.get(name) ?? defaultFixity;

export const showFixity = (f: Fixity): string =>
  `${f.assoc === "none" ? "infix" : `infix${f.assoc[0]}`} ${f.prec}`;
