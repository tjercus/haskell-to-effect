export type {
  Alt,
  ConDecl,
  DataDecl,
  Decl,
  Expr,
  GuardedExpr,
  Literal,
  Module,
  OpRef,
  Pat,
  Rhs,
  Stmt,
  TopDecl,
  Type,
} from "./syntax/ast.ts";
export { LexError, ParseError, type SyntaxError } from "./errors.ts";
export { lex } from "./syntax/lexer.ts";
export { parseExpr, parseModule } from "./syntax/parser.ts";
export { prettyExpr, prettyModule, prettyPat, prettyType } from "./syntax/pretty.ts";
export type { Pos, Span } from "./syntax/span.ts";
export type { Token } from "./syntax/token.ts";
export type {
  Bind,
  BindGroup,
  CExpr,
  CPat,
  Clause,
  ConInfo,
  DataInfo,
  GuardedBody,
  Match,
  Name,
  Program,
} from "./core/core.ts";
export { lowerModule } from "./core/lower.ts";
export { prettyCore, prettyProgram } from "./core/pretty.ts";
export { ScopeError } from "./errors.ts";
export { TypeCheckError } from "./errors.ts";
export { type InferOptions, type TypedProgram, inferProgram } from "./types/infer.ts";
export {
  type Scheme,
  type Type as InferredType,
  showScheme,
  showType,
  zonk,
} from "./types/types.ts";
export { type CodegenOptions, type Warning, generate } from "./codegen/ts.ts";
export { type CompiledMatch, type Decision, MatchCompiler } from "./codegen/match.ts";
export {
  type CompileError,
  type CompileOptions,
  type Compiled,
  GenerateError,
  compile,
  entrySource,
  formatDiagnostic,
  formatError,
  runtimeSource,
} from "./compile.ts";
