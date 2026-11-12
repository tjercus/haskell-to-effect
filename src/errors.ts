import { Schema } from "effect";
import { Span } from "./syntax/span.ts";

/** An invalid character sequence in the source text. */
export class LexError extends Schema.TaggedError<LexError>()("LexError", {
  message: Schema.String,
  span: Span,
}) {}

/** A token sequence that does not form a valid program. */
export class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {
  message: Schema.String,
  span: Span,
}) {}

export type SyntaxError = LexError | ParseError;

/** An unbound, duplicated or otherwise ill-scoped name. */
export class ScopeError extends Schema.TaggedError<ScopeError>()("ScopeError", {
  message: Schema.String,
  span: Span,
}) {}

/** A program that is not well-typed. */
export class TypeCheckError extends Schema.TaggedError<TypeCheckError>()("TypeError", {
  message: Schema.String,
  span: Span,
}) {}

/** A program the code generator cannot translate (an unsupported feature). */
export class GenerateError extends Schema.TaggedError<GenerateError>()("GenerateError", {
  message: Schema.String,
  span: Span,
}) {}
