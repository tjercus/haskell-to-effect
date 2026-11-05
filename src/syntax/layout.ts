/**
 * The layout rule (Haskell 2010 Report, section 10.3).
 *
 * The algorithm runs in two steps:
 *
 * 1. `annotate` marks where the rule applies: `{n}` after a layout keyword (`let`, `where`,
 *    `do`, `of`) that is not followed by `{`, and `<n>` before the first token of each line.
 * 2. `LayoutStream` implements the function `L` lazily, turning those markers into virtual
 *    `{`, `;` and `}` tokens while the parser pulls tokens from it.
 *
 * Laziness is what makes the Report's `parse-error(t)` side condition work. When the parser
 * meets a token that cannot continue an implicit block, such as `in` in `let x = 1 in x`, it
 * calls `closeImplicit`. That rewinds the stream to that token, pops the implicit context and
 * inserts a virtual `}`. The context stack then matches what the parser saw, so later lines
 * are laid out correctly.
 */
import type { Pos, Span } from "./span.ts";
import type { Token } from "./token.ts";

const layoutKeywords = new Set(["let", "where", "do", "of"]);

type Annotated =
  | { readonly _tag: "Token"; readonly token: Token }
  /** `{n}`: open an implicit block whose items start at column `n` (0 at end of input). */
  | { readonly _tag: "Open"; readonly n: number; readonly at: Pos }
  /** `<n>`: the next token is the first on its line, at column `n`. */
  | { readonly _tag: "Indent"; readonly n: number; readonly at: Pos };

export type LayoutMode =
  /** A whole module: an implicit top-level block opens unless it starts with `module` or `{`. */
  | "module"
  /** A bare expression: no top-level block. */
  | "expression";

const annotate = (tokens: ReadonlyArray<Token>, mode: LayoutMode): Array<Annotated> => {
  const out: Array<Annotated> = [];
  const first = tokens[0];
  let openedBefore = false;

  if (
    mode === "module" &&
    first !== undefined &&
    !(first._tag === "ReservedId" && first.text === "module") &&
    !(first._tag === "Special" && first.text === "{")
  ) {
    out.push({
      _tag: "Open",
      n: first._tag === "EOF" ? 0 : first.span.start.col,
      at: first.span.start,
    });
    openedBefore = true;
  }

  tokens.forEach((t, idx) => {
    const prev = tokens[idx - 1];
    if (
      !openedBefore &&
      prev !== undefined &&
      t._tag !== "EOF" &&
      t.span.start.line > prev.span.end.line
    ) {
      out.push({ _tag: "Indent", n: t.span.start.col, at: t.span.start });
    }
    openedBefore = false;
    out.push({ _tag: "Token", token: t });

    const next = tokens[idx + 1];
    if (
      t._tag === "ReservedId" &&
      layoutKeywords.has(t.text) &&
      next !== undefined &&
      !(next._tag === "Special" && next.text === "{")
    ) {
      out.push({
        _tag: "Open",
        n: next._tag === "EOF" ? 0 : next.span.start.col,
        at: next.span.start,
      });
      openedBefore = true;
    }
  });
  return out;
};

/** The state of `L`: input position, layout context stack, and markers still to process. */
interface State {
  readonly pos: number;
  /** Context stack, innermost last. `0` is an explicit `{ … }` block. */
  readonly stack: ReadonlyArray<number>;
  /** Markers to process before `input[pos]` (from the empty-block case of `{n}`). */
  readonly queue: ReadonlyArray<Annotated | Token>;
}

const virtual = (text: "{" | ";" | "}", at: Pos): Token => ({
  _tag: "Special",
  text,
  span: { start: at, end: at } satisfies Span,
  virtual: true,
});

export class LayoutStream {
  private readonly input: ReadonlyArray<Annotated>;
  private readonly out: Array<Token> = [];
  /** `before[k]` is the state from which `out[k]` was produced. */
  private readonly before: Array<State> = [];
  private state: State = { pos: 0, stack: [], queue: [] };

  constructor(tokens: ReadonlyArray<Token>, mode: LayoutMode) {
    this.input = annotate(tokens, mode);
  }

  /** The `k`-th output token, produced on demand. The stream ends with EOF forever. */
  at(k: number): Token {
    while (this.out.length <= k) {
      const last = this.out[this.out.length - 1];
      if (last?._tag === "EOF") return last;
      this.before.push(this.state);
      this.out.push(this.produce());
    }
    const t = this.out[k];
    if (t === undefined) throw new Error("LayoutStream: unreachable");
    return t;
  }

  /** Whether output token `k` would be produced inside an implicit (layout) block. */
  inImplicitBlock(k: number): boolean {
    this.at(k);
    const st = this.before[k];
    const top = st?.stack[st.stack.length - 1];
    return top !== undefined && top !== 0;
  }

  /**
   * The `parse-error(t)` rule: token `k` cannot continue the innermost implicit block, so close
   * that block just before it. Output from `k` onwards is discarded and produced again with the
   * context popped; `out[k]` becomes a virtual `}`.
   */
  closeImplicit(k: number): void {
    if (!this.inImplicitBlock(k))
      throw new Error("LayoutStream.closeImplicit: no implicit block to close");
    const st = this.before[k];
    const t = this.out[k];
    if (st === undefined || t === undefined) throw new Error("LayoutStream: unreachable");
    this.out.length = k;
    this.before.length = k;
    this.before.push(st);
    this.out.push(virtual("}", t.span.start));
    this.state = { ...st, stack: st.stack.slice(0, -1) };
  }

  /** One step of `L`. */
  private produce(): Token {
    for (;;) {
      const { pos, stack, queue } = this.state;
      const top = stack[stack.length - 1];
      const [queued, ...restQueue] = queue;
      const item: Annotated | Token | undefined = queued ?? this.input[pos];
      const fromQueue = queued !== undefined;
      const consume = (extra: Partial<State> = {}): void => {
        this.state = fromQueue
          ? { pos, stack, queue: restQueue, ...extra }
          : { pos: pos + 1, stack, queue, ...extra };
      };

      if (item === undefined) throw new Error("LayoutStream: input must end with EOF");

      if (item._tag === "Indent") {
        if (top !== undefined && item.n === top) {
          consume();
          return virtual(";", item.at);
        }
        if (top !== undefined && item.n < top) {
          this.state = { pos, stack: stack.slice(0, -1), queue };
          return virtual("}", item.at);
        }
        consume();
        continue;
      }

      if (item._tag === "Open") {
        if (item.n > (top ?? 0)) {
          consume({ stack: [...stack, item.n] });
          return virtual("{", item.at);
        }
        // Empty block: `{` `}`, then treat the next token as the start of a line.
        consume();
        const rest = this.state.queue;
        this.state = {
          ...this.state,
          queue: [virtual("}", item.at), { _tag: "Indent", n: item.n, at: item.at }, ...rest],
        };
        return virtual("{", item.at);
      }

      const t = item._tag === "Token" ? item.token : item;
      if (t._tag === "EOF") {
        // Close any implicit blocks still open; explicit ones are reported by the parser.
        if (top !== undefined && top !== 0) {
          this.state = { pos, stack: stack.slice(0, -1), queue };
          return virtual("}", t.span.start);
        }
        return t;
      }
      if (t._tag === "Special" && !t.virtual && t.text === "{") {
        consume({ stack: [...stack, 0] });
        return t;
      }
      if (t._tag === "Special" && !t.virtual && t.text === "}") {
        // An explicit `}` closes an explicit block. If an implicit block is innermost, the
        // parser closes that first with `closeImplicit`, and this token is produced again.
        consume(top === 0 ? { stack: stack.slice(0, -1) } : {});
        return t;
      }
      consume();
      return t;
    }
  }
}

/**
 * Runs `L` to the end with no parser feedback, so the `parse-error(t)` rule never fires.
 * Used for testing and debugging.
 */
export const layoutAll = (tokens: ReadonlyArray<Token>, mode: LayoutMode): Array<Token> => {
  const stream = new LayoutStream(tokens, mode);
  const out: Array<Token> = [];
  for (let k = 0; ; k++) {
    const t = stream.at(k);
    out.push(t);
    if (t._tag === "EOF") return out;
  }
};
