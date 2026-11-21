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

export function internalError(detail: string, pos: number = 0): never {
  throw new CodegenError(`jsmql internal error (please report to the jsmql maintainers): ${detail}`, pos);
}
