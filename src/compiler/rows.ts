// The registry readers every phase shares.
//
// A phase asks a QUESTION about a name and gets an answer from a row. The
// question is spelled out here once, so two phases cannot answer it differently
// — which is what happened before the registry existed, when the lexer, the
// parser and codegen each carried their own idea of which names were methods.
//
// Nothing here decides anything. Each function is a projection of `names.ts`.

import type { Family, FieldFamily, IterateeSlots, On, Position } from "../registry/vocabulary.ts";
import { FIELD_FAMILY_TYPES } from "../registry/vocabulary.ts";
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
const FIELD_FAMILIES: readonly Family[] = Object.keys(FIELD_FAMILY_TYPES) as FieldFamily[];

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

/** A stage's stated body layout, or undefined when the name is not a stage. */
function bodyLayoutOf(name: string): Readonly<Record<string, Position>> | undefined {
  return (row(name) as { bodyPositions?: Readonly<Record<string, Position>> } | undefined)?.bodyPositions;
}

/** Is `name` a stage — a name whose argument is a BODY with a stated layout? */
export function isStageName(name: string): boolean {
  return bodyLayoutOf(name) !== undefined;
}

/**
 * Where a path inside a stage's body stands, and whether a longer key still
 * claims something below it.
 *
 * BOTH facts, because a caller needs both: the position is what a leaf under
 * this path holds, and `deeper` says an object under it must keep descending
 * before the row can answer for its keys. Without the second, `$setWindowFields`'s
 * body would settle as a value and its `output` keys would never reach the
 * window position; without the first, `$merge("out")` — a body with no keys to
 * descend into — would never reach any position at all.
 */
export type BodySlot = { at: Position; deeper: boolean };

/** A body path, one segment per key. `null` is a COMPUTED key — `{ [k]: … }`. */
export type BodyPath = readonly (string | null)[];

const segmentsOf = (key: string): readonly string[] => (key === "" ? [] : key.split("."));

/**
 * Does `key` cover `path`'s first `key.length` segments?
 *
 * A `*` covers any key, including a computed one. A LITERAL segment never covers
 * a computed key: `{ [k]: … }` cannot be known to be the key the row names.
 */
function covers(key: readonly string[], path: BodyPath): boolean {
  if (key.length > path.length) return false;
  return key.every((seg, i) => seg === "*" || seg === path[i]);
}

const wildcards = (key: readonly string[]): number => key.filter((seg) => seg === "*").length;

/**
 * Which position `path` holds inside `stage`'s body — see `bodyPositions` for the
 * path vocabulary. Undefined when `stage` is not a stage at all.
 *
 * The longest covering key wins, and a literal beats a `*` of the same length,
 * so `$group`'s `{ "": "value", "*": "group", _id: "value" }` reads as written:
 * `_id` is an expression and every other key is an accumulator.
 */
export function bodySlotAt(stage: string, path: BodyPath): BodySlot | undefined {
  const layout = bodyLayoutOf(stage);
  if (layout === undefined) return undefined;
  const keys = Object.keys(layout).map((key) => ({ key, seg: segmentsOf(key) }));
  const deeper = keys.some(({ seg }) => seg.length > path.length && covers(seg.slice(0, path.length), path));
  let best: { key: string; seg: readonly string[] } | undefined;
  for (const cand of keys) {
    if (!covers(cand.seg, path)) continue;
    if (best === undefined || cand.seg.length > best.seg.length) best = cand;
    else if (cand.seg.length === best.seg.length && wildcards(cand.seg) < wildcards(best.seg)) best = cand;
  }
  // Every stage row states the `""` key, so a covering key always exists.
  return best === undefined ? undefined : { at: layout[best.key], deeper };
}

/**
 * What a `{ … }` callback body on this name MEANS: pipeline STAGES for the one
 * kind of row that says so, JavaScript for every other. Undefined when the name
 * has no row — and a nameless callee's block is JavaScript too.
 */
export function blockBodyOf(name: string): "javascript" | "stages" {
  return (row(name) as { blockBody?: "javascript" | "stages" } | undefined)?.blockBody ?? "javascript";
}

/**
 * Is `name` CALLED — `filter(…)` — rather than read — `length`?
 *
 * The one fact that separates `"abc".length` from `"abc".length()`. A name with
 * no row is left to its caller: this function refuses only what a row refuses.
 */
export function isCallable(name: string): boolean {
  return row(name)?.call !== false;
}

/**
 * Every name that is a static NAMESPACE — `Math`, `Object`, `Date` — read off the
 * rows that say `provides`, so a new namespace is a row and never a list here.
 */
export function namespaceNames(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [name, r] of Object.entries(ROWS) as [string, { kind?: string; provides?: unknown }][]) {
    if ((r?.kind === "root" || r?.kind === "global") && r.provides !== undefined) out.add(name);
  }
  return out;
}

/**
 * The index of the argument this name MUTATES in place, or undefined when it
 * mutates none. `Object.assign(target, …)` writes its first argument, so a
 * binding passed there is no longer the constant it was declared as.
 */
export function mutatedArgumentOf(name: string): number | undefined {
  return (row(name) as { mutatesArgumentAt?: number } | undefined)?.mutatesArgumentAt;
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
  if (perFamily !== undefined) {
    if (family !== undefined && perFamily[family]?.args !== undefined) return perFamily[family].args;
    return undefined;
  }
  // A cell that dispatches on the ARGUMENT shape accepts what any of its rules
  // accepts. Read as one rule, so `new Date(a, b, c, d, e, f, g, h)` is refused
  // by the count no rule states rather than accepted because no single rule was
  // found — which is what an undefined answer means to `acceptsArgumentCount`.
  // The two refusal keys (`constant`, `otherwise`) state no count: a constant
  // call is counted by the rule for its class, and the leftover by none.
  const byArgs = (cell as { byArgs?: Readonly<Record<string, { args?: ArgCount; unsupported?: string }>> }).byArgs;
  if (byArgs === undefined) return undefined;
  const allowed = new Set<number>();
  let atLeast: number | undefined;
  for (const branch of Object.values(byArgs)) {
    if (branch.unsupported !== undefined) continue;
    const a = branch.args;
    if (a === undefined) return undefined; // a rule with no count accepts anything
    if (a.none === true) allowed.add(0);
    if (a.exact !== undefined) allowed.add(a.exact);
    for (const n of a.allowed ?? []) allowed.add(n);
    if (a.atLeast !== undefined) atLeast = atLeast === undefined ? a.atLeast : Math.min(atLeast, a.atLeast);
  }
  if (atLeast !== undefined) return { atLeast: Math.min(atLeast, ...allowed) };
  return { allowed: [...allowed].sort((x, y) => x - y) };
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

// ── the facts the emit phase reads ───────────────────────────────────────────

import type { Binds, BodyRule, Returns } from "../registry/vocabulary.ts";
import type { CallbackParams } from "../registry/vocabulary.ts";
import { PRODUCTIONS } from "../registry/productions.ts";

type EmitRow = {
  returns?: Returns;
  params?: CallbackParams;
  binds?: Binds;
  shape?: "single" | "array" | "none" | "flex" | { object: BodyRule };
  asReference?: boolean;
  family?: Family;
  spreadAlternative?: string;
  newKeyword?: "required" | "optional" | "forbidden";
  provides?: unknown;
  token?: string;
};

/** A row of either registry: a NAME (`trim`, `$abs`) or a PRODUCTION (`strictEquality`). The keys cannot collide. */
const emitRow = (name: string): EmitRow | undefined =>
  (ROWS[name] as EmitRow | undefined) ?? ((PRODUCTIONS as Record<string, unknown>)[name] as EmitRow | undefined);

/** The result type a name states, or "unknown" when it states none. */
export function returnsOf(name: string): Returns {
  return emitRow(name)?.returns ?? "unknown";
}

/** What a name's callback parameters bind, in order, for `position` — or undefined when it takes no callback. */
export function callbackParamsOf(name: string, position: Position): readonly string[] | undefined {
  const p = emitRow(name)?.params;
  if (p === undefined) return undefined;
  if (Array.isArray(p)) return p as readonly string[];
  return (p as Readonly<Partial<Record<Position, readonly string[]>>>)[position];
}

/** The variables a MongoDB operator brings into scope, or undefined. */
export function bindsOf(name: string): Binds | undefined {
  return emitRow(name)?.binds;
}

/** The key order a positional call to an object-shaped operator maps onto; empty when it has none. */
export function positionalKeysOf(name: string): readonly string[] {
  const shape = emitRow(name)?.shape;
  return typeof shape === "object" && shape !== null ? (shape.object.positional ?? []) : [];
}

/** The object-shaped operator's body rule, or undefined for any other shape. */
export function bodyRuleOf(name: string): BodyRule | undefined {
  const shape = emitRow(name)?.shape;
  return typeof shape === "object" && shape !== null ? (shape.object as BodyRule) : undefined;
}

/** How a MongoDB operator's operand list is written, or undefined for a stage or a name. */
export function operandShapeOf(name: string): "single" | "array" | "none" | "flex" | "object" | undefined {
  const shape = emitRow(name)?.shape;
  if (shape === undefined) return undefined;
  return typeof shape === "string" ? shape : "object";
}

/** The JavaScript form that takes a spread and lowers to this operator, or undefined. */
export function spreadAlternativeOf(name: string): string | undefined {
  return emitRow(name)?.spreadAlternative;
}

/** The receiver family a value built by this global belongs to (`Set` → "set"), or undefined. */
export function constructedFamilyOf(name: string): Family | undefined {
  return emitRow(name)?.family;
}

/** The production that builds `nodeType` on its own — the first row whose `becomes` is exactly it. */
export function productionForNode(nodeType: string): string | undefined {
  for (const [key, p] of Object.entries(PRODUCTIONS) as [string, { becomes: unknown }][]) {
    if (p.becomes === nodeType) return key;
  }
  return undefined;
}

/** Can this global be handed to a higher-order name unapplied — `map(String)`? */
export function asReferenceOf(name: string): boolean {
  return emitRow(name)?.asReference === true;
}

/** Whether `new` is required, optional or forbidden before this global, or undefined for a non-global. */
export function newKeywordOf(name: string): "required" | "optional" | "forbidden" | undefined {
  return emitRow(name)?.newKeyword;
}

/** Does the row for `name` exist, of kind `root` or `global` — a name reached without a receiver? */
export function isGlobalName(name: string): boolean {
  const k = row(name)?.kind;
  return k === "global" || k === "root";
}

/**
 * The row a CONSTRUCT names, from the production that builds its node type:
 * `CollectionRef` is built by the production whose first token is `$$`, and
 * `$$` is a row. Read off both registries, so a root spelling is never listed
 * beside the node type it builds.
 */
export function rowForNodeType(nodeType: string): string | undefined {
  for (const p of Object.values(PRODUCTIONS) as { becomes: unknown; tokens: readonly string[] }[]) {
    const becomes = Array.isArray(p.becomes) ? p.becomes : [p.becomes];
    if (!becomes.includes(nodeType)) continue;
    const spelling = p.tokens[0];
    if (spelling !== undefined && ROWS[spelling] !== undefined) return spelling;
  }
  return undefined;
}

/**
 * The production an operator node lowers by: keyed by the node it builds and
 * its first token, so `-` the subtraction and `-` the negation are two rows.
 */
export function productionForOperator(nodeType: "BinaryExpr" | "UnaryExpr", op: string): string | undefined {
  for (const [key, p] of Object.entries(PRODUCTIONS) as [string, { becomes: unknown; tokens: readonly string[] }][]) {
    if (p.becomes === nodeType && p.tokens[0] === op) return key;
  }
  return undefined;
}

/** Does this production state that a left-nested chain lowers as one operator? */
export function flattensChain(productionKey: string): boolean {
  return (PRODUCTIONS as Record<string, { flattensChain?: true }>)[productionKey]?.flattensChain === true;
}
