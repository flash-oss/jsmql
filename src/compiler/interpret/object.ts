// The document operators.
//
// A document keeps the order of its keys, and a key that reads as an array index
// would move in a JavaScript object. `spellable` refuses such a document, so no
// rule here checks that. `$arrayToObject` is the one rule that answers it, as an
// `OrderedDocument`, which no other rule reads. A field that the answer needs and the document lacks is
// MISSING, and no literal spells missing, so such a read is a refusal.

import type { Answer, Rule } from "./values.ts";
import { NO, OrderedDocument, isIndexKey, isPlain, ok, spellable } from "./values.ts";
import { keyed, positional } from "./operand.ts";
import { setKey } from "../../registry/mql.ts";

/** A key that the server accepts as a name: it has no null byte, and it does not start with a dollar. */
const isFieldName = (k: unknown): k is string => typeof k === "string" && !k.includes("\u0000") && !k.startsWith("$");

// A document whose key order is unspecified gives a list whose order is unspecified.
const objectToArray = positional(
  1,
  1,
  ([doc], _, walk) => {
    if (doc === null) return ok(null);
    if (!isPlain(doc)) return NO;
    const pairs = Object.entries(doc).map(([k, v]) => ({ k, v }));
    return ok(walk.isSet(doc) ? walk.markSet(pairs) : pairs);
  },
  true,
);

/** The pairs of `$arrayToObject`: all `[key, value]` lists, or all `{ k, v }` documents. */
function pairsOf(list: unknown[]): [string, unknown][] | null {
  const pairs: [string, unknown][] = [];
  const form = list.length === 0 ? "list" : Array.isArray(list[0]) ? "list" : "document";
  for (const item of list) {
    if (form === "list") {
      if (!Array.isArray(item) || item.length !== 2) return null;
      pairs.push([item[0], item[1]]);
    } else {
      if (!isPlain(item)) return null;
      const keys = Object.keys(item);
      if (keys.length !== 2 || !keys.includes("k") || !keys.includes("v")) return null;
      pairs.push([item.k as string, item.v]);
    }
  }
  return pairs.every(([k]) => isFieldName(k)) ? pairs : null;
}

// The pairs of a list in unspecified order give a document in that order. A key that repeats keeps the
// value of its last pair, so the list may be in unspecified order only when no key repeats.
const arrayToObject = positional(
  1,
  1,
  ([list], _, walk) => {
    if (list === null) return ok(null);
    if (!Array.isArray(list)) return NO;
    const pairs = pairsOf(list);
    if (pairs === null) return NO;
    const unordered = walk.isSet(list);
    if (unordered && new Set(pairs.map(([k]) => k)).size !== pairs.length) return NO;
    // A key that repeats keeps its first place and the value of its last pair.
    const kept = new Map(pairs);
    if (!unordered && kept.size > 1 && [...kept.keys()].some(isIndexKey)) return ok(new OrderedDocument([...kept]));
    const out: Record<string, unknown> = {};
    for (const [k, v] of kept) setKey(out, k, v);
    return ok(unordered ? walk.markSet(out) : out);
  },
  true,
);

/**
 * `$mergeObjects` takes documents, or one list of documents. A null document adds nothing. A document
 * of unspecified key order gives keys in that order. A list of unspecified order is a refusal when two
 * of its documents share a key, because the last one wins.
 */
const mergeObjects = positional(
  0,
  Infinity,
  (xs, _, walk) => {
    const list = xs.length === 1 && Array.isArray(xs[0]);
    const docs = list ? (xs[0] as unknown[]) : xs;
    if (!docs.every((d) => d === null || isPlain(d))) return NO;
    const keys = docs.flatMap((d) => (d === null ? [] : Object.keys(d as object)));
    if (list && walk.isSet(xs[0]) && new Set(keys).size !== keys.length) return NO;
    const out: Record<string, unknown> = {};
    for (const d of docs)
      if (d !== null) for (const [k, v] of Object.entries(d as Record<string, unknown>)) setKey(out, k, v);
    const unordered = (list && walk.isSet(xs[0])) || docs.some((d) => walk.isSet(d));
    return ok(unordered ? walk.markSet(out) : out);
  },
  true,
);

/** The field name, and the document that a keyed operand names. A null document gives null. */
function target(
  parts: Record<string, unknown>,
  walk: Parameters<Rule>[1],
): Answer | { name: string; doc: Record<string, unknown> } {
  const field = walk.at(parts.field);
  if (!field.ok) return field;
  const input = walk.at(parts.input);
  if (!input.ok) return input;
  if (!isFieldName(field.value)) return NO;
  if (input.value === null) return ok(null);
  return isPlain(input.value) ? { name: field.value, doc: input.value } : NO;
}

const isTarget = (t: Answer | { name: string }): t is { name: string; doc: Record<string, unknown> } => "name" in t;

const getField = keyed(["field", "input"], [], (parts, walk) => {
  const t = target(parts, walk);
  if (!isTarget(t)) return t;
  return Object.prototype.hasOwnProperty.call(t.doc, t.name) ? spellable(t.doc[t.name]) : NO;
});

const setField = keyed(["field", "input", "value"], [], (parts, walk) => {
  const value = walk.at(parts.value);
  if (!value.ok) return value;
  const t = target(parts, walk);
  if (!isTarget(t)) return t;
  return spellable(setKey({ ...t.doc }, t.name, value.value));
});

const unsetField = keyed(["field", "input"], [], (parts, walk) => {
  const t = target(parts, walk);
  if (!isTarget(t)) return t;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t.doc)) if (k !== t.name) setKey(out, k, v);
  return spellable(out);
});

export const OBJECT: Record<string, Rule> = {
  $objectToArray: objectToArray,
  $arrayToObject: arrayToObject,
  $mergeObjects: mergeObjects,
  $getField: getField,
  $setField: setField,
  $unsetField: unsetField,
};
