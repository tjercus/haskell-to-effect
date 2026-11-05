import { type Bind, type BindGroup, type CExpr, type GuardedBody, bindsOf } from "./core.ts";

/** Ids of all variables referenced in an expression. */
export const freeVarIds = (e: CExpr, acc: Set<number> = new Set()): Set<number> => {
  const goBody = (b: GuardedBody): void => {
    switch (b._tag) {
      case "Body":
        freeVarIds(b.expr, acc);
        return;
      case "Guards":
        for (const g of b.guards) {
          freeVarIds(g.cond, acc);
          freeVarIds(g.expr, acc);
        }
        return;
      case "LetBody":
        for (const bind of bindsOf(b.group)) freeVarIds(bind.expr, acc);
        goBody(b.body);
    }
  };
  switch (e._tag) {
    case "Var":
      acc.add(e.name.id);
      break;
    case "Prim":
    case "Con":
    case "Lit":
      break;
    case "App":
      freeVarIds(e.fn, acc);
      freeVarIds(e.arg, acc);
      break;
    case "Lam":
      freeVarIds(e.body, acc);
      break;
    case "Let":
      for (const bind of bindsOf(e.group)) freeVarIds(bind.expr, acc);
      freeVarIds(e.body, acc);
      break;
    case "If":
      freeVarIds(e.cond, acc);
      freeVarIds(e.thenBranch, acc);
      freeVarIds(e.elseBranch, acc);
      break;
    case "Match":
      for (const s of e.scrutinees) acc.add(s.id);
      for (const c of e.clauses) goBody(c.body);
      break;
    case "Typed":
      freeVarIds(e.expr, acc);
      break;
  }
  return acc;
};

/**
 * Splits bindings into strongly connected components (Tarjan's algorithm), returned in
 * dependency order: every group only refers to itself and to earlier groups. Bindings that
 * do not depend on each other keep their source order.
 *
 * With `ignoreSignatures`, references to bindings that have a type signature are not
 * dependencies (Haskell 2010 Report, section 4.5.2); the type checker uses this to infer
 * bindings without signatures before checking the ones that refer to them.
 */
export const dependencyGroups = (
  binds: ReadonlyArray<Bind>,
  options: { readonly ignoreSignatures?: boolean } = {},
): Array<BindGroup> => {
  const index = new Map(binds.map((b, i) => [b.name.id, i]));
  const deps = binds.map((b) =>
    [...freeVarIds(b.expr)].flatMap((id) => {
      const j = index.get(id);
      if (j === undefined) return [];
      if (options.ignoreSignatures && binds[j]?.sig !== undefined) return [];
      return [j];
    }),
  );

  const order: Array<number> = binds.map(() => -1);
  const low: Array<number> = binds.map(() => 0);
  const onStack: Array<boolean> = binds.map(() => false);
  const stack: Array<number> = [];
  const groups: Array<BindGroup> = [];
  let counter = 0;

  const visit = (v: number): void => {
    order[v] = low[v] = counter++;
    stack.push(v);
    onStack[v] = true;
    for (const w of deps[v] ?? []) {
      if (order[w] === -1) {
        visit(w);
        low[v] = Math.min(low[v] ?? 0, low[w] ?? 0);
      } else if (onStack[w]) {
        low[v] = Math.min(low[v] ?? 0, order[w] ?? 0);
      }
    }
    if (low[v] !== order[v]) return;
    const members: Array<number> = [];
    for (;;) {
      const w = stack.pop();
      if (w === undefined) break;
      onStack[w] = false;
      members.push(w);
      if (w === v) break;
    }
    members.sort((a, b) => a - b);
    const component = members.flatMap((i) => {
      const b = binds[i];
      return b === undefined ? [] : [b];
    });
    const [only] = component;
    const selfRecursive = only !== undefined && (deps[v] ?? []).includes(v);
    groups.push(
      component.length === 1 && only !== undefined && !selfRecursive
        ? { _tag: "NonRec", bind: only }
        : { _tag: "Rec", binds: component },
    );
  };

  for (let v = 0; v < binds.length; v++) if (order[v] === -1) visit(v);
  return groups;
};
