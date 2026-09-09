// The bridge between a JavaScript VALUE and the AST literal that spells it.
//
// Constant folding computes values, and a value has to go back into the tree
// before any later phase can see it. Putting it back as a LITERAL — rather than
// as some synthesised carrier node — is what keeps every later phase working on
// a tree the surface could have produced, and it is what lets a folded constant
// reach a rule that matches on literals:
//
//   const k = "name"; $.items.map(k)   folds to   $.items.map("name")
//                                    desugars to  $.items.map(x => x.name)
//
// Not every value has a literal spelling. A Date does not, so a declaration
// holding one KEEPS ITS BINDING and is read at run time — see `asLiteral`
// returning null, and `fold.ts` for why inlining the source expression instead
// would carry its free names to every use site.

import type { Expr } from "../../registry/ast.ts";
// A leaf with no dependencies of its own — see its header for why jsmql mints
// its own ObjectId rather than importing `bson`.
import { ObjectId } from "../../objectid.ts";

/**
 * Can this value be written as a literal at all?
 *
 * ONE boundary for the whole pass. Checked in three places — arithmetic, a
 * number method, `.sum()` — the three answers drift apart, and
 * `[1e308, 1e308].sum()` reaches the driver as `Infinity` while `1e308 * 10`
 * is refused. Asking once removes the question of which policy applies where.
 */
export function isSpellable(value: unknown): boolean {
  return asLiteral(value, 0) !== null;
}

/** A value the tree can carry, or the fact that this node is not a constant. */
export type Reading = { ok: true; value: unknown } | { ok: false };

const NOT_CONSTANT: Reading = { ok: false };

/** A BSON instance the driver consumes as-is rather than as JSON. */
const isBson = (v: unknown, tag: string): boolean =>
  typeof v === "object" && v !== null && (v as { _bsontype?: unknown })._bsontype === tag;

/**
 * The value a LITERAL node holds, or `{ ok: false }` for anything else.
 *
 * Leaves only. Reading `1 + 2` is the evaluator's job; this reads the `1`.
 */
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

/** Is this value a plain object — one whose entries an ObjectLiteral can spell? */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  if (v instanceof Date || v instanceof RegExp || v instanceof Uint8Array) return false;
  if ((v as { _bsontype?: unknown })._bsontype !== undefined) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * The literal that spells `value`, or null when none does.
 *
 * Null is not a failure: a `Date` is a perfectly good constant with no literal
 * spelling in the language. The caller inlines the constant expression instead,
 * which is equally faithful and equally surface-expressible.
 *
 * `pos` is the source offset the literal reports. A folded value has no source
 * of its own, so it borrows the position of the reference it replaces — which is
 * the place a later error should point at.
 */
export function asLiteral(value: unknown, pos: number): Expr | null {
  if (value === null) return { type: "NullLiteral", pos };
  // `undefined` is NOT a value a fold may produce. JavaScript answers it for a
  // read that found nothing — `[1,2,3].at(9)` — and BSON has no such thing, so
  // it reaches the driver as a hole: an array element becomes null and an object
  // key vanishes entirely. A read that found nothing stays a runtime read.
  if (value === undefined) return null;

  switch (typeof value) {
    case "number":
      // `NaN` and the infinities have no literal: JavaScript spells them as
      // global names, and MQL has no way to write them at all.
      return Number.isFinite(value) ? { type: "NumberLiteral", value, pos } : null;
    case "string":
      return { type: "StringLiteral", value, pos };
    case "boolean":
      return { type: "BooleanLiteral", value, pos };
    case "bigint":
      return { type: "BigIntLiteral", value: value.toString(), pos };
  }

  if (value instanceof RegExp) {
    return { type: "RegexLiteral", pattern: value.source, flags: value.flags, pos };
  }
  if (isBson(value, "ObjectId")) {
    const hex = objectIdHex(value);
    if (hex === null) return null;
    return { type: "ObjectIdLiteral", hex, pos };
  }
  if (Array.isArray(value)) {
    const elements: Expr[] = [];
    for (const element of value) {
      const spelled = leafOf(element, pos);
      if (spelled === null) return null;
      elements.push(spelled);
    }
    return { type: "ArrayLiteral", elements, pos };
  }
  if (isPlainObject(value)) {
    const entries: { type: "KeyValueEntry"; key: { kind: "static"; name: string }; value: Expr; pos: number }[] = [];
    for (const [name, held] of Object.entries(value)) {
      const spelled = leafOf(held, pos);
      if (spelled === null) return null;
      entries.push({ type: "KeyValueEntry", key: { kind: "static", name }, value: spelled, pos });
    }
    return { type: "ObjectLiteral", entries, pos };
  }

  // A Date, a Binary, a Decimal128 — a constant with no literal spelling.
  return null;
}

/**
 * An element of an injected structure: its literal where it has one, else the
 * value itself as an `Injected` node — a Date inside `{ startDate, endDate }` keeps
 * the object's keys readable (`$dateDiff(${parts})` is the body it spells) while
 * the Date stays the value it is. `undefined` has no spelling and stops the structure;
 * so does a nested structure `asLiteral` itself refused.
 */
function leafOf(value: unknown, pos: number): Expr | null {
  if (value === undefined) return null;
  // a RegExp inside a structure is data the structure carries, never a regex literal to evaluate
  if (value instanceof RegExp) return { type: "Injected", value, pos };
  const spelled = asLiteral(value, pos);
  if (spelled !== null) return spelled;
  return Array.isArray(value) || isPlainObject(value) ? null : { type: "Injected", value, pos };
}

/** The 24-hex spelling of an ObjectId-shaped value: its `toHexString()`, else its 12 `id` bytes, else its `toString()`. */
function objectIdHex(value: unknown): string | null {
  const v = value as { toHexString?: () => string; id?: unknown; toString?: () => string };
  if (typeof v.toHexString === "function") return v.toHexString().toLowerCase();
  if (v.id instanceof Uint8Array && v.id.length === 12)
    return [...v.id].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (typeof v.toString === "function") {
    const s = v.toString();
    if (/^[0-9a-fA-F]{24}$/.test(s)) return s.toLowerCase();
  }
  return null;
}
