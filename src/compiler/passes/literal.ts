import type { Expr } from "../../registry/ast.ts";
import { bsonTagOf, isObjectId, objectIdHex, ObjectId } from "../../bson.ts";
import { isDate, isPlainObject as isPlainByPrototype, isRegExp } from "../../bson.ts";
import { OrderedDocument } from "../interpret/values.ts";

export function isSpellable(value: unknown): boolean {
  return asLiteral(value, 0) !== null;
}

export type Reading = { ok: true; value: unknown } | { ok: false };

const NOT_CONSTANT: Reading = { ok: false };

export function readLiteral(node: Expr): Reading {
  switch (node.type) {
    case "NumberLiteral":
      return { ok: true, value: node.value };
    case "StringLiteral":
      return { ok: true, value: node.value };
    case "BooleanLiteral":
      return { ok: true, value: node.value };
    case "NullLiteral":
      return { ok: true, value: null };
    case "UndefinedLiteral":
      return { ok: true, value: undefined };
    case "BigIntLiteral":
      return { ok: true, value: BigInt(node.value) };
    case "RegexLiteral":
      return { ok: true, value: new RegExp(node.pattern, node.flags) };
    case "ObjectIdLiteral":
      return { ok: true, value: new ObjectId(node.hex) };
    default:
      return NOT_CONSTANT;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return isPlainByPrototype(v) && bsonTagOf(v) === undefined;
}

export function asLiteral(value: unknown, pos: number, text = false): Expr | null {
  if (value === null) return { type: "NullLiteral", pos };
  if (value === undefined) return null;

  switch (typeof value) {
    case "number":
      return Number.isFinite(value) ? { type: "NumberLiteral", value, pos } : null;
    case "string":
      return text && value.startsWith("$")
        ? { type: "StringLiteral", value, pos, text: true }
        : { type: "StringLiteral", value, pos };
    case "boolean":
      return { type: "BooleanLiteral", value, pos };
    case "bigint":
      return { type: "BigIntLiteral", value: value.toString(), pos };
  }

  if (isRegExp(value)) {
    return { type: "RegexLiteral", pattern: value.source, flags: value.flags, pos };
  }
  if (isObjectId(value)) {
    const hex = objectIdHex(value);
    if (hex === null) return null;
    return { type: "ObjectIdLiteral", hex, pos };
  }
  if (Array.isArray(value)) {
    const elements: Expr[] = [];
    for (const element of value) {
      const spelled = leafOf(element, pos, text);
      if (spelled === null) return null;
      elements.push(spelled);
    }
    return { type: "ArrayLiteral", elements, pos };
  }
  if (value instanceof OrderedDocument) {
    const pairs: Expr[] = [];
    for (const [key, held] of value.pairs) {
      const spelled = leafOf(held, pos, text);
      if (spelled === null) return null;
      pairs.push({ type: "ArrayLiteral", elements: [{ type: "StringLiteral", value: key, pos }, spelled], pos });
    }
    return {
      type: "OperatorCall",
      name: "$arrayToObject",
      args: [{ type: "ArrayLiteral", elements: [{ type: "ArrayLiteral", elements: pairs, pos }], pos }],
      pos,
    };
  }
  if (isPlainObject(value)) {
    const entries: { type: "KeyValueEntry"; key: { kind: "static"; name: string }; value: Expr; pos: number }[] = [];
    for (const [name, held] of Object.entries(value)) {
      const spelled = leafOf(held, pos, text);
      if (spelled === null) return null;
      entries.push({ type: "KeyValueEntry", key: { kind: "static", name }, value: spelled, pos });
    }
    return { type: "ObjectLiteral", entries, pos };
  }

  if (isDate(value)) return { type: "Injected", value, pos };
  return null;
}

export function nodeOf(value: unknown, pos: number, text = false): Expr {
  return asLiteral(value, pos, text) ?? { type: "Injected", value, pos };
}

function leafOf(value: unknown, pos: number, text: boolean): Expr | null {
  if (value === undefined) return null;
  if (isRegExp(value)) return { type: "Injected", value, pos };
  const spelled = asLiteral(value, pos, text);
  if (spelled !== null) return spelled;
  return Array.isArray(value) || isPlainObject(value) ? null : { type: "Injected", value, pos };
}
