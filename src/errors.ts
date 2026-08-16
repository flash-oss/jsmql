// The codegen error classes.
//
// A LEAF, and deliberately so. These classes were declared in `codegen.ts`, which made
// every module that merely needs to REJECT something depend on the whole compiler — and a
// module `codegen.ts` imports back (`literal-gate.ts`, `operator-validation.ts`, the method
// families) then closes a cycle. A cycle here is not a style complaint: it evaluates the
// importer before the module it depends on, which is how nine string methods once fell
// silently out of the registry with no error anywhere.
//
// Throwing is not a compiler service. It belongs where anything can reach it.
//
// See docs/specs/architecture.md § Error types.

export class CodegenError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number = 0) {
    super(message);
    this.name = "CodegenError";
    this.pos = pos;
  }
}

export class UnknownIdentifierError extends CodegenError {
  identifier: string;
  constructor(identifier: string, pos: number = 0) {
    super(`Unknown identifier '${identifier}'. Did you mean '$.${identifier}'?`, pos);
    this.name = "UnknownIdentifierError";
    this.identifier = identifier;
  }
}

/**
 * Throw a `CodegenError` flagged as a jsmql bug. Use for invariants the parser is supposed
 * to uphold — if a user ever sees one of these messages, something has slipped past the
 * parser's validation and we want them to report it. Keeps the wording consistent across
 * every internal-only throw site so they are trivially greppable.
 */
export function internalError(detail: string, pos: number = 0): never {
  throw new CodegenError(`jsmql internal error (please report to the jsmql maintainers): ${detail}`, pos);
}
