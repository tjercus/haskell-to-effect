import { Schema } from "effect";

/** A position in the source text. `line` and `col` are 1-based; `offset` is 0-based. */
export const Pos = Schema.Struct({
  offset: Schema.Number,
  line: Schema.Number,
  col: Schema.Number,
});
export type Pos = typeof Pos.Type;

/** A half-open source range `[start, end)`. */
export const Span = Schema.Struct({ start: Pos, end: Pos });
export type Span = typeof Span.Type;

export const span = (start: Pos, end: Pos): Span => ({ start, end });

/** The smallest span covering both `a` and `b` (assumes `a` starts first). */
export const merge = (a: Span, b: Span): Span => ({ start: a.start, end: b.end });

export const showPos = (p: Pos): string => `${p.line}:${p.col}`;

const origin: Pos = { offset: 0, line: 0, col: 0 };

/** A placeholder span for built-in (Prelude) definitions. */
export const noSpan: Span = { start: origin, end: origin };
