// The registry readers every phase shares.
//
// A phase asks a QUESTION about a name and gets an answer from a row. The
// question is spelled out here once, so two phases cannot answer it differently
// — which is what happened before the registry existed, when the lexer, the
// parser and codegen each carried their own idea of which names were methods.
//
// Nothing here decides anything. Each function is a projection of `names.ts`.

import type { Family, IterateeSlots, On, Position } from "../registry/vocabulary.ts";
import { NAMES } from "../registry/names.ts";

/** Every row, by name. Null-prototype: `toString` and `valueOf` are real rows. */
const ROWS: Readonly<Record<string, unknown>> = Object.assign(Object.create(null), NAMES);

type AnyRow = { kind: string; call?: boolean; on?: On; where: readonly Position[] };

const row = (name: string): AnyRow | undefined => ROWS[name] as AnyRow | undefined;

/** `on` in its widest form, so a caller never checks whether it is a list. */
function families(on: On | undefined): readonly Family[] | "any" | undefined {
  if (on === undefined) return undefined;
  if (on === "any") return "any";
  return Array.isArray(on) ? on : [on as Family];
}

/**
 * The families a DOCUMENT FIELD's value can have.
 *
 * `Math`, `Object`, `Number`, `Date` and `Array` are also families, but they are
 * static namespaces reached through a bare name — never through `$.<path>`. So
 * `Math.PI` is a read on a namespace and `$.Math.PI` is a two-segment field path,
 * and the two cannot be told apart without this distinction.
 */
const FIELD_FAMILIES: readonly Family[] = ["string", "array", "number", "object", "date", "regexp", "set"];

/**
 * Is `name` read WITHOUT `()` on something a field can hold?
 *
 * The one question the field-path fold asks. `$.a.b` is the path `a.b`, but
 * `$.a.length` is the size of `a` — and the only thing that separates them is
 * that one of the two names has a row saying it is read rather than called.
 */
export function isFieldProperty(name: string): boolean {
  const r = row(name);
  if (r === undefined || r.call !== false) return false;
  const fams = families(r.on);
  if (fams === undefined) return false;
  if (fams === "any") return true;
  return fams.some((f) => FIELD_FAMILIES.includes(f));
}

/**
 * The keys of a stage's body whose value is a SUB-PIPELINE, or undefined when the
 * name is not a stage. `["*"]` means every key holds one — that is `$facet`.
 *
 * A statement slot is not only a top-level thing: the elements of a sub-pipeline
 * are statements too, and only the row knows which key holds one.
 */
export function subPipelineFieldsOf(name: string): readonly string[] | undefined {
  return (row(name) as { subPipelineFields?: readonly string[] } | undefined)?.subPipelineFields;
}

/**
 * The name that means the same as this mutator without mutating, or undefined.
 * `.sort()` → `"toSorted"`. See `immutableTwin` for what qualifies as a twin.
 */
export function immutableTwinOf(name: string): string | undefined {
  return (row(name) as { immutableTwin?: string } | undefined)?.immutableTwin;
}

/** Which order this mutator writes as an array literal, or undefined. */
export function arrayLiteralOrderOf(name: string): "receiver, then arguments" | "arguments, then receiver" | undefined {
  return (row(name) as { asArrayLiteral?: "receiver, then arguments" | "arguments, then receiver" } | undefined)
    ?.asArrayLiteral;
}

/**
 * The slot layout for `name` on `family`: which argument slots stand in for an
 * arrow and with which spellings, or `{ arrowOnly }` when none does.
 */
export function iterateeSlotsOf(name: string, family: Family): IterateeSlots | undefined {
  const decl = (row(name) as { iterateeSlots?: Readonly<Partial<Record<Family, IterateeSlots>>> } | undefined)
    ?.iterateeSlots;
  return decl?.[family];
}

/**
 * The receiver family a name is called on, as far as the SOURCE shows it.
 *
 * Three cases, and no type inference: a stream is a stream, a receiver that names
 * a static namespace is that namespace, and anything else is the one value family
 * the row lists. Enough for a rewrite, because a receiver that turns out not to be
 * that family is refused by the row's own receiver gate either way.
 */
export function receiverFamily(receiverName: string | null, onStream: boolean, name: string): Family | undefined {
  if (onStream) return "stream";
  const fams = families(row(name)?.on);
  if (fams === undefined || fams === "any") return undefined;
  if (receiverName !== null && fams.includes(receiverName as Family)) return receiverName as Family;
  const values = fams.filter((f) => FIELD_FAMILIES.includes(f));
  return values.length === 1 ? values[0] : undefined;
}

type ArgCount = { exact?: number; allowed?: readonly number[]; atLeast?: number; none?: true };

/**
 * How many arguments a name takes in value position, on a given receiver family.
 *
 * The family is not optional in practice: `max` is `.max()` on an array and
 * `Math.max(a, b)` on the namespace, one row with two counts. Reading the first
 * branch and hoping would refuse `Math.max(3, 7)` for taking two arguments.
 */
export function argCountOf(name: string, family?: Family): ArgCount | undefined {
  const cell = (row(name) as { expr?: unknown } | undefined)?.expr;
  if (cell === null || typeof cell !== "object") return undefined;
  const direct = (cell as { args?: ArgCount }).args;
  if (direct !== undefined) return direct;
  const perFamily = (cell as { perFamily?: Record<string, { args?: ArgCount }> }).perFamily;
  if (perFamily === undefined) return undefined;
  if (family !== undefined && perFamily[family]?.args !== undefined) return perFamily[family].args;
  return undefined;
}

/**
 * Does `count` satisfy the name's argument rule on this receiver?
 *
 * True when there is no rule to check against — a name the registry says nothing
 * about is not this function's to reject.
 */
export function acceptsArgumentCount(name: string, count: number, family?: Family): boolean {
  const rule = argCountOf(name, family);
  if (rule === undefined) return true;
  if (rule.none === true) return count === 0;
  if (rule.exact !== undefined) return count === rule.exact;
  if (rule.allowed !== undefined) return rule.allowed.includes(count);
  if (rule.atLeast !== undefined) return count >= rule.atLeast;
  return true;
}

/** The positions a name is legal in, or undefined when there is no such name. */
export function positionsOf(name: string): readonly Position[] | undefined {
  return row(name)?.where;
}

/** Does the row for `name` list `where`? False for a name with no row at all. */
export function lists(name: string, where: Position): boolean {
  return row(name)?.where.includes(where) === true;
}
