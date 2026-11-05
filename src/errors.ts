import { Data } from "effect";
import type { Span } from "./syntax/span.ts";

/** An invalid character sequence in the source text. */
export class LexError extends Data.TaggedError("LexError")<{
  readonly message: string;
  readonly span: Span;
}> {}

/** A token sequence that does not form a valid program. */
export class ParseError extends Data.TaggedError("ParseError")<{
  readonly message: string;
  readonly span: Span;
}> {}

export type SyntaxError = LexError | ParseError;

/** An unbound, duplicated or otherwise ill-scoped name. */
export class ScopeError extends Data.TaggedError("ScopeError")<{
  readonly message: string;
  readonly span: Span;
}> {}

/** A program that is not well-typed. */
export class TypeCheckError extends Data.TaggedError("TypeError")<{
  readonly message: string;
  readonly span: Span;
}> {}
