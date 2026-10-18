// Phase 5 — EMIT, and the fold before it. The kind check of HR7: what a value is
// PROVEN to be against what its slot takes. See docs/specs/types.md § The kind check.
//
// One module holds the whole rule, so that the dispatcher (emit/select.ts) and the
// constant evaluator (passes/evaluate.ts) answer the same question the same way. A
// constant whose kinds break a rule is not folded, and the emitter then refuses it.
// A row states each rule. Nothing here names a row.

import type { ArgType, Arity, Kind } from "../registry/vocabulary.ts";
import { BSON_KIND, bsonTagOf, isDate, isPlainObject } from "../registry/vocabulary.ts";
import { elementsOf } from "./rows.ts";

/** A kind a proof can show. `null` is the proof of a value that is certainly null or missing. */
export type Proven = Kind | "null";

/**
 * What the kind check reads of a proof: the kinds the value can have, or `"unknown"`
 * where the proof says nothing. A value that is certainly null or missing proves the
 * kind `"null"`, and that kind fits only a slot that takes `"any"`.
 */
export type Proof = readonly Proven[] | "unknown";

/**
 * Which kind rule a call broke. A slot number indexes the call's own arguments; the
 * receiver of a method has no slot, so the `elements` fault names no operand.
 */
export type KindFault =
  /** `slotType` or `rest`: the operand has no kind that the slot takes. */
  | {
      readonly rule: "slot";
      readonly slot: number;
      readonly expected: ArgType | readonly ArgType[];
      readonly got: readonly Proven[];
      /** The proof is of the ELEMENTS of the operand: a field that holds an array in a query, or a spread. */
      readonly viaElements?: true;
    }
  /** The slot takes an element of the element source, and the operand has no kind that the elements have. */
  | {
      readonly rule: "element";
      readonly slot: number;
      readonly got: readonly Proven[];
      readonly held: readonly Proven[];
      readonly viaElements?: true;
    }
  /** `elements`: the receiver holds an element of a kind that the row never takes. */
  | { readonly rule: "elements"; readonly expected: Kind; readonly held: readonly Proven[] }
  /** `homogeneous`: the operand has another kind than the first operand with a proven kind. */
  | {
      readonly rule: "homogeneous";
      readonly first: number;
      readonly firstKinds: readonly Proven[];
      readonly firstViaElements?: true;
      readonly slot: number;
      readonly got: readonly Proven[];
      readonly viaElements?: true;
    };

/**
 * What the compiler proves of the operands of one call: a proof per argument, and a
 * proof of ONE element of the element source (the receiver of a method, the last
 * operand of a production). An argument beyond the list is unproven.
 *
 * `viaElements[i]` says that `args[i]` is the proof of the ELEMENTS of operand `i`, in
 * place of the operand: a field that holds an array on the query road (SR2), and a spread.
 * `packed` says that the call's arguments came in as ONE packed list (`f(...xs)`, see the
 * desugar pass), so `args` holds one proof per ELEMENT of that list.
 *
 * `items` is the TUPLE form of `elements`: the element source is an array of a fixed length,
 * for example a literal, and `items[i]` is the proof of position `i`. Each position holds a
 * value that is certain, so the `elements` rule judges each position alone. Without `items`,
 * `elements` is a SET proof: one proof for every position.
 */
export type Proofs = {
  readonly args: readonly Proof[];
  readonly elements: Proof;
  readonly items?: readonly Proof[];
  readonly viaElements?: readonly boolean[];
  readonly packed?: true;
};

/** No proof at all. A call that no kind rule judges passes this: a `$op(…)` call is the developer's own MQL. */
export const UNPROVEN: Proofs = { args: [], elements: "unknown" };

/**
 * Can a value PROVEN to have `kind` fill a slot that takes `expected`? This is the one
 * fit rule of HR7. An unproven value fills any slot, and the server judges it. A
 * `fieldName`, a `fieldPath` and a `regex` slot read a string, and a date slot takes a
 * date alone. A literal `null` proves the kind `"null"`, which fits only `"any"`. An
 * `element` slot takes a kind that the element source can hold, and `elements` is the
 * proof of that source.
 *
 * The two sentinels, MinKey and MaxKey, compare with every kind and compute with none.
 * So they fit every comparison slot (`"orderable"` and `"any"`), and they fail every
 * slot that does arithmetic, because the server refuses `$add: [MinKey, 1]`.
 */
export function kindFits(
  kind: Proven | "unknown",
  expected: ArgType | readonly ArgType[],
  elements: Proof = "unknown",
): boolean {
  if (kind === "unknown") return true;
  if (Array.isArray(expected)) return (expected as readonly ArgType[]).some((t) => kindFits(kind, t, elements));
  switch (expected as ArgType) {
    case "any":
      return true;
    case "value":
      return kind !== "null";
    case "number":
    case "int":
    case "int-or-long":
      return kind === "number";
    case "number-or-date":
      return kind === "number" || kind === "date";
    case "orderable":
      return kind === "number" || kind === "string" || kind === "date" || kind === "objectId" || isSentinel(kind);
    case "string":
    case "fieldName":
    case "fieldPath":
    case "regex":
      return kind === "string";
    case "bool":
    case "array":
    case "object":
    case "date":
      return kind === expected;
    case "element":
      return elements === "unknown" || elements.includes(kind);
    case "timestamp":
    case "callback":
      return false;
  }
}

/** MinKey and MaxKey. They sit at the two ends of the BSON order. */
const isSentinel = (kind: Proven): boolean => kind === "minKey" || kind === "maxKey";

/** Does a proof fit the slot? A value that can have two or more kinds fits when ONE of them fits. */
const proofFits = (proof: Proof, expected: ArgType | readonly ArgType[], elements: Proof): boolean =>
  proof === "unknown" || proof.some((k) => kindFits(k, expected, elements));

/** The type a slot takes: the one `slotType` names, else `rest`. Undefined where the row states none. */
const slotTypeOf = (rule: Arity, i: number): ArgType | readonly ArgType[] | undefined =>
  rule.slotType?.[i] ?? rule.rest;

/** Does a slot take a callback? The lowering of the callback names every spelling that the slot takes, so no kind rule judges it. */
const takesCallback = (t: ArgType | readonly ArgType[]): boolean =>
  Array.isArray(t) ? (t as readonly ArgType[]).includes("callback") : t === "callback";

/** The kinds of a proof that name a kind of value. A null and a sentinel fit every comparison, so they set no kind. */
const concreteKinds = (proof: Proof): readonly Proven[] | null =>
  proof === "unknown" || proof.some((k) => k === "null" || isSentinel(k)) ? null : proof;

/**
 * The `elements` rule of a row: the receiver must hold only elements of the kind the row
 * names. A tuple proof breaks the rule when ANY position has no fitting kind. A set proof
 * breaks it only when NO kind fits, because its one proof stands for every position.
 */
export function elementsFaultOf(name: string, proofs: Proofs): KindFault | null {
  const need = elementsOf(name);
  if (need === undefined || need === "scalar") return null;
  const takes = (p: Proof): boolean => p === "unknown" || p.includes(need);
  const broken = proofs.items !== undefined ? proofs.items.some((p) => !takes(p)) : !takes(proofs.elements);
  if (!broken) return null;
  const held = (proofs.items ?? [proofs.elements]).flatMap((p) => (p === "unknown" ? [] : p));
  return { rule: "elements", expected: need, held: [...new Set(held)] };
}

/**
 * The first kind rule that a call breaks, or null. The order is fixed: each slot, then
 * the shared kind of the operands, then the elements of the receiver. A value that can
 * have two or more kinds breaks a rule only when NO possible kind fits. The one exception
 * is a tuple proof of the elements. Each of its positions is certain. So ONE position
 * with no fitting kind breaks the `elements` rule. See
 * docs/specs/types.md § The kind check.
 */
export function faultOf(name: string, rule: Arity, proofs: Proofs): KindFault | null {
  let spread = false;
  for (let i = 0; i < proofs.args.length; i++) {
    const via = proofs.viaElements?.[i] === true;
    // A packed list reads its elements as the call's own arguments. A spread covers a run of
    // slots, so the slots after it are the rest of the row.
    spread = spread || (proofs.packed === true && via);
    const expected = spread ? rule.rest : slotTypeOf(rule, i);
    const proof = proofs.args[i];
    if (expected === undefined || takesCallback(expected) || proof === "unknown") continue;
    if (proofFits(proof, expected, proofs.elements)) continue;
    const through = via ? ({ viaElements: true } as const) : {};
    return expected === "element" && proofs.elements !== "unknown"
      ? { rule: "element", slot: i, got: proof, held: proofs.elements, ...through }
      : { rule: "slot", slot: i, expected, got: proof, ...through };
  }
  if (rule.homogeneous === true) {
    // Each operand of known concrete kinds takes part, and the kinds they share must not become empty.
    let shared: readonly Proven[] | null = null;
    const taking: { slot: number; kinds: readonly Proven[] }[] = [];
    for (let i = 0; i < proofs.args.length; i++) {
      const kinds = concreteKinds(proofs.args[i]);
      if (kinds === null) continue;
      const left: readonly Proven[] = shared === null ? kinds : shared.filter((k) => kinds.includes(k));
      if (left.length === 0) {
        const other = taking.find((t) => !t.kinds.some((k) => kinds.includes(k))) ?? taking[0];
        return {
          rule: "homogeneous",
          first: other.slot,
          firstKinds: other.kinds,
          ...(proofs.viaElements?.[other.slot] === true ? { firstViaElements: true as const } : {}),
          slot: i,
          got: kinds,
          ...(proofs.viaElements?.[i] === true ? { viaElements: true as const } : {}),
        };
      }
      shared = left;
      taking.push({ slot: i, kinds });
    }
  }
  return elementsFaultOf(name, proofs);
}

/**
 * The kind of a known value — a constant, or a value that the caller passed in. A
 * value with no kind that the registry knows (a regular expression, a function)
 * answers null.
 */
export function kindOfValue(v: unknown): Kind | null {
  if (typeof v === "number" || typeof v === "bigint") return "number";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "bool";
  if (isDate(v)) return "date";
  if (Array.isArray(v)) return "array";
  const tag = bsonTagOf(v);
  if (tag !== undefined) return BSON_KIND[tag] ?? null;
  return isPlainObject(v) ? "object" : null;
}

/** The proof that a known value gives. A null or an undefined proves the kind `"null"`. */
const proofOfValue = (v: unknown): Proof => {
  if (v === null || v === undefined) return ["null"];
  const k = kindOfValue(v);
  return k === null ? "unknown" : [k];
};

/**
 * The proofs of a list of known values, as the evaluator reads them. The last value
 * is the element source: a list proves the kinds of its elements.
 */
export function proofsOfValues(values: readonly unknown[]): Proofs {
  const last = values[values.length - 1];
  const kinds = new Set<Kind>();
  let holdsNull = false;
  // A known value that is an array is of a fixed length, so each position has a proof of its own.
  const items: Proof[] = [];
  if (Array.isArray(last)) {
    for (const el of last) {
      const k = el === null || el === undefined ? null : kindOfValue(el);
      if (k !== null) kinds.add(k);
      holdsNull = holdsNull || el === null || el === undefined;
      // A null element proves the kind `null`, as a null operand does: it fits only a slot that takes any.
      items.push(el === null || el === undefined ? ["null"] : k === null ? "unknown" : [k]);
    }
  }
  // A null element is one of the kinds of the elements. Only null elements prove nothing, as in emit/type.ts.
  const elements: Proof = kinds.size === 0 ? "unknown" : holdsNull ? [...kinds, "null"] : [...kinds];
  return Array.isArray(last)
    ? { args: values.map(proofOfValue), elements, items }
    : { args: values.map(proofOfValue), elements };
}
