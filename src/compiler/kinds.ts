import type { ArgType, Arity, Kind } from "../registry/vocabulary.ts";
import { BSON_KIND, bsonTagOf, isDate, isPlainObject } from "../registry/vocabulary.ts";
import { elementsOf } from "./rows.ts";

export type Proven = Kind | "null";

export type Proof = readonly Proven[] | "unknown";

export type KindFault =
  | {
      readonly rule: "slot";
      readonly slot: number;
      readonly expected: ArgType | readonly ArgType[];
      readonly got: readonly Proven[];
      readonly viaElements?: true;
      readonly hint?: string;
    }
  | {
      readonly rule: "element";
      readonly slot: number;
      readonly got: readonly Proven[];
      readonly held: readonly Proven[];
      readonly viaElements?: true;
    }
  | { readonly rule: "elements"; readonly expected: Kind; readonly held: readonly Proven[] }
  | {
      readonly rule: "homogeneous";
      readonly first: number;
      readonly firstKinds: readonly Proven[];
      readonly firstViaElements?: true;
      readonly slot: number;
      readonly got: readonly Proven[];
      readonly viaElements?: true;
    };

export type Proofs = {
  readonly args: readonly Proof[];
  readonly elements: Proof;
  readonly items?: readonly Proof[];
  readonly viaElements?: readonly boolean[];
  readonly packed?: true;
  readonly whole?: readonly Proof[];
  readonly asElement?: readonly (Proof | undefined)[];
};

export const UNPROVEN: Proofs = { args: [], elements: "unknown" };

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
    case "objectId":
    case "binData":
      return kind === expected;
    case "element":
      return elements === "unknown" || elements.includes(kind);
    case "timestamp":
    case "callback":
      return false;
  }
}

const isSentinel = (kind: Proven): boolean => kind === "minKey" || kind === "maxKey";

const takesArray = (expected: ArgType | readonly ArgType[]): boolean =>
  Array.isArray(expected) ? (expected as readonly ArgType[]).includes("array") : expected === "array";

const proofFits = (proof: Proof, expected: ArgType | readonly ArgType[], elements: Proof): boolean =>
  proof === "unknown" || proof.some((k) => kindFits(k, expected, elements));

const slotTypeOf = (rule: Arity, i: number): ArgType | readonly ArgType[] | undefined =>
  rule.slotType?.[i] ?? rule.rest;

const takesCallback = (t: ArgType | readonly ArgType[]): boolean =>
  Array.isArray(t) ? (t as readonly ArgType[]).includes("callback") : t === "callback";

const concreteKinds = (proof: Proof): readonly Proven[] | null =>
  proof === "unknown" || proof.some((k) => k === "null" || isSentinel(k)) ? null : proof;

function elementsFaultOf(name: string, proofs: Proofs): KindFault | null {
  const need = elementsOf(name);
  if (need === undefined || need === "scalar") return null;
  const takes = (p: Proof): boolean => p === "unknown" || p.includes(need);
  const broken = proofs.items !== undefined ? proofs.items.some((p) => !takes(p)) : !takes(proofs.elements);
  if (!broken) return null;
  const held = (proofs.items ?? [proofs.elements]).flatMap((p) => (p === "unknown" ? [] : p));
  return { rule: "elements", expected: need, held: [...new Set(held)] };
}

export function faultOf(name: string, rule: Arity, proofs: Proofs): KindFault | null {
  let spread = false;
  for (let i = 0; i < proofs.args.length; i++) {
    const via = proofs.viaElements?.[i] === true;
    spread = spread || (proofs.packed === true && via);
    const expected = spread ? rule.rest : slotTypeOf(rule, i);
    if (expected === undefined || takesCallback(expected)) continue;
    const asElement = expected === "element" ? proofs.asElement?.[i] : undefined;
    const whole = asElement === undefined && takesArray(expected) ? proofs.whole?.[i] : undefined;
    const proof = asElement ?? whole ?? proofs.args[i];
    if (proof === "unknown" || proofFits(proof, expected, proofs.elements)) continue;
    const through = asElement !== undefined || (whole === undefined && via) ? ({ viaElements: true } as const) : {};
    return expected === "element" && proofs.elements !== "unknown"
      ? { rule: "element", slot: i, got: proof, held: proofs.elements, ...through }
      : {
          rule: "slot",
          slot: i,
          expected,
          got: proof,
          ...through,
          ...(rule.slotHint?.[i] === undefined ? {} : { hint: rule.slotHint[i] }),
        };
  }
  if (rule.homogeneous === true) {
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
