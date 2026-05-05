import { lookupOperator } from "./operators.js";
import type { Expr, ArrayElement, ObjectEntry } from "./ast.js";

export class CodegenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodegenError";
  }
}

export function generate(expr: Expr): unknown {
  switch (expr.type) {
    case "NumberLiteral":
      return expr.value;
    case "StringLiteral":
      return expr.value;
    case "BooleanLiteral":
      return expr.value;
    case "NullLiteral":
      return null;
    case "FieldRef":
      return `$${expr.path}`;

    case "ArrayLiteral":
      return expr.elements.map((el) => generateArrayElement(el));

    case "ObjectLiteral":
      return generateObjectEntries(expr.entries);

    case "OperatorCall":
      return generateOperatorCall(expr.name, expr.style, expr.args);
  }
}

function generateArrayElement(el: ArrayElement): unknown {
  if (el.type === "SpreadElement") {
    throw new CodegenError("Spread elements in arrays are not supported in MQL output");
  }
  return generate(el);
}

function generateObjectEntries(entries: ObjectEntry[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.type === "SpreadElement") {
      throw new CodegenError("Spread elements in objects are not supported in MQL output");
    }
    result[entry.key] = generate(entry.value);
  }
  return result;
}

function generateOperatorCall(
  name: string,
  style: "positional" | "object",
  args: Expr[],
): Record<string, unknown> {
  // Object-style: the single arg is an ObjectLiteral, pass it through
  if (style === "object") {
    const objArg = args[0];
    if (!objArg || objArg.type !== "ObjectLiteral") {
      throw new CodegenError(`Object-style call to ${name} must have exactly one object argument`);
    }
    return { [name]: generateObjectEntries(objArg.entries) };
  }

  // Positional-style: look up shape from registry
  const def = lookupOperator(name);

  if (!def) {
    return generateUnknownOperator(name, args);
  }

  const { shape } = def;

  switch (shape.kind) {
    case "none":
      return { [name]: {} };

    case "single": {
      if (args.length !== 1) {
        throw new CodegenError(`Operator ${name} expects exactly 1 argument, got ${args.length}`);
      }
      return { [name]: generate(args[0]) };
    }

    case "array": {
      if (args.length === 0) {
        throw new CodegenError(`Operator ${name} expects at least 1 argument`);
      }
      const generated = args.map((a) => generate(a));
      // Single-arg array operators still produce an array (MQL requires it)
      return { [name]: generated };
    }

    case "object": {
      if (args.length === 0) {
        throw new CodegenError(`Operator ${name} expects at least 1 argument`);
      }
      const keys = shape.keys;
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < args.length; i++) {
        const key = keys[i];
        if (!key) {
          throw new CodegenError(
            `Operator ${name} received more positional arguments than expected (max ${keys.length})`,
          );
        }
        obj[key] = generate(args[i]);
      }
      return { [name]: obj };
    }
  }
}

function generateUnknownOperator(name: string, args: Expr[]): Record<string, unknown> {
  if (args.length === 0) {
    return { [name]: {} };
  }
  if (args.length === 1) {
    const only = args[0];
    if (only.type === "ObjectLiteral") {
      return { [name]: generateObjectEntries(only.entries) };
    }
    return { [name]: generate(only) };
  }
  return { [name]: args.map((a) => generate(a)) };
}
