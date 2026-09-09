// The registry readers every phase shares.
//
// A phase asks a QUESTION about a name and gets an answer from a row. The
// question is spelled out here once, so two phases cannot answer it differently:
// there is one place that decides whether a name is a method, and every phase
// reads it.
//
// Nothing here decides anything. Each function is a projection of `names.ts`.

import type {
  Family,
  FieldFamily,
  IterateeSlots,
  On,
  Position,
  SlotPosition,
  MutatorForm,
  Kind,
  SlotForm,
} from "../registry/vocabulary.ts";
import { FIELD_FAMILY_TYPES, isSlotLayout } from "../registry/vocabulary.ts";
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
function bodyLayoutOf(name: string): Readonly<Record<string, SlotPosition>> | undefined {
  return (row(name) as { bodyPositions?: Readonly<Record<string, SlotPosition>> } | undefined)?.bodyPositions;
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
export type BodySlot = { at: Position; otherwise: Position; deeper: boolean };

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
  if (best === undefined) return undefined;
  const stated = layout[best.key];
  return typeof stated === "string"
    ? { at: stated, otherwise: stated, deeper }
    : { at: stated.list, otherwise: stated.otherwise, deeper };
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
 *
 * The fact belongs to the STATIC spelling: `o.assign(p)` writes nothing and
 * answers a new object, so a caller passes the receiver and gets undefined for
 * the method form.
 */
export function mutatedArgumentOf(name: string, receiver?: string | null): number | undefined {
  if (receiver !== undefined && (receiver === null || !namespaceNames().has(receiver))) return undefined;
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
 * The short spellings that may stand in place of the arrow at one argument slot,
 * resolved exactly as the rewrite resolves them: the name's own layout, then the
 * row it runs as on a stream, then the array layout a stream borrows. Empty when
 * the slot takes the arrow alone — which is what a refusal must then say.
 */
export function slotFormsOf(name: string, family: Family, slot: number): readonly SlotForm[] {
  const runsAs = picksOneOf(name);
  const layout =
    iterateeSlotsOf(name, family) ??
    (runsAs === null ? undefined : iterateeSlotsOf(runsAs, family)) ??
    (family === "stream" ? iterateeSlotsOf(name, "array") : undefined);
  if (layout === undefined || !isSlotLayout(layout)) return [];
  const byIndex: Readonly<Record<number, readonly SlotForm[]>> = layout;
  return byIndex[slot] ?? [];
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
/** What a method needs of its receiver's ELEMENTS: `"scalar"` when an element that is an array makes the server refuse. */
export function elementsOf(name: string): "scalar" | undefined {
  return (row(name) as { elements?: "scalar" } | undefined)?.elements;
}

/** The kind of ONE element of the array a name returns, where its own lowering fixes it. */
export function elementKindOf(name: string): Kind | undefined {
  return (row(name) as { elementKind?: Kind } | undefined)?.elementKind;
}

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
  shape?: "single" | "array" | "none" | "flex" | "verbatim" | { object: BodyRule };
  family?: Family;
  spreadAlternative?: string;
  newKeyword?: "required" | "optional" | "forbidden";
  provides?: unknown;
  token?: string;
};

/** A row of either registry: a NAME (`trim`, `$abs`) or a PRODUCTION (`strictEquality`). The keys cannot collide. */
const emitRow = (name: string): EmitRow | undefined =>
  (ROWS[name] as EmitRow | undefined) ?? ((PRODUCTIONS as Record<string, unknown>)[name] as EmitRow | undefined);

/**
 * The ONE document-field family a method's row is spelled on, or null when it is
 * spelled on several (or on none). A receiver the registry cannot type still
 * has this family when the call is valid at all: `.map` on an unproven field is
 * a call on an array, or a server error — never a call on a string.
 */
export function soleFieldFamilyOf(name: string): Family | null {
  const fams = families(row(name)?.on);
  if (fams === undefined || fams === "any") return null;
  const fields = fams.filter((f) => f !== "stream");
  return fields.length === 1 ? fields[0] : null;
}

/**
 * The one kind a method's row states for EVERY document-field family it is
 * spelled on, or null when the families disagree, one is "same" / "element", or
 * the row states none. `.size()` is a number on an array and on an object alike.
 */
export function agreedReturnOf(name: string): Kind | null {
  const fams = families(row(name)?.on);
  const r = returnsOf(name);
  if (fams === undefined || fams === "any" || typeof r !== "object" || r === null) return null;
  const kinds = new Set<string>();
  for (const f of fams) {
    if (f === "stream") continue;
    const k = (r as Record<string, string | undefined>)[f];
    if (k === undefined || k === "same" || k === "element" || k === "unknown") return null;
    kinds.add(k);
  }
  return kinds.size === 1 ? ([...kinds][0] as Kind) : null;
}

/** Does the registry have a row for this name at all? A typo has none. */
export function isKnownName(name: string): boolean {
  return row(name) !== undefined;
}

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

/** The position a row states for its OPERAND, where it is not the row's own language. */
export function operandPositionOf(name: string): Position | undefined {
  return (row(name) as { operandPosition?: Position } | undefined)?.operandPosition;
}

/** The expression twin a QUERY operator lifts to when its operand is read at run time, or undefined. */
export function liftsToOf(name: string): { op: string; negated?: true } | undefined {
  return (row(name) as { liftsTo?: { op: string; negated?: true } } | undefined)?.liftsTo;
}

/**
 * A STAGE's stated body rule, or undefined when the row states none.
 * A stage's body is its own field, not the `shape.object` an operator uses.
 */
export function stageBodyRuleOf(name: string): BodyRule | undefined {
  return (row(name) as { body?: BodyRule } | undefined)?.body;
}

/** A STAGE's own smallest correct call, for the refusal of a wrong-type body; undefined when the row states none. */
export function bodyExampleOf(name: string): string | undefined {
  return (row(name) as { bodyExample?: string } | undefined)?.bodyExample;
}

/** How a MongoDB operator's operand list is written, or undefined for a stage or a name. */
export function operandShapeOf(name: string): "single" | "array" | "none" | "flex" | "verbatim" | "object" | undefined {
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
/** The containers a row states its stage may not stand inside. */
export function forbiddenInOf(name: string): readonly string[] {
  return (row(name) as { forbiddenIn?: readonly string[] } | undefined)?.forbiddenIn ?? [];
}

/** Stages this container refuses at ANY depth inside its bodies, not only as a direct step. */
export function bansNestedOf(name: string): readonly string[] {
  return (row(name) as { bansNested?: readonly string[] } | undefined)?.bansNested ?? [];
}

/** How a placement refusal for this name is worded, where the generic sentence is wrong for it. */
export function placementOf(name: string): { first?: string; container?: string } {
  return (row(name) as { placement?: { first?: string; container?: string } } | undefined)?.placement ?? {};
}

/** The extra rules a row states that no renderer implies — where a stage may stand. */
/** Does the stage's sub-pipeline run over another collection's documents? */
/** On a stream of documents, does this method pick ONE — `.find`? The stream row it runs as, or null. */
export function picksOneOf(name: string): string | null {
  return (row(name) as { picksOne?: string } | undefined)?.picksOne ?? null;
}

/** Does this method UNION documents into the stream — `push` as a statement, `concat` as a link? */
export function unionsOf(name: string): boolean {
  return (row(name) as { unions?: true } | undefined)?.unions === true;
}

/** Does this method WRITE documents into a collection — `$$$.<coll>.concat(…);` — a `$merge`? */
export function mergesIntoOf(name: string): boolean {
  return (row(name) as { mergesInto?: true } | undefined)?.mergesInto === true;
}

/** Does the stream cell fold the stream into ONE document — always, or only when the argument is a field name? */
export function collapsesOf(name: string): true | "unlessRawBody" | null {
  return (row(name) as { collapses?: true | "unlessRawBody" } | undefined)?.collapses ?? null;
}

/** Does the row's stream cell take a callback whose body must BE a document — `.map`? */
export function streamBodyOf(name: string): "document" | null {
  return (row(name) as { streamBody?: "document" } | undefined)?.streamBody ?? null;
}

export function pipelineOverOf(name: string): "foreign" | null {
  return (row(name) as { pipelineOver?: "foreign" } | undefined)?.pipelineOver ?? null;
}

/** Every `mongo` row: the names that ARE MongoDB operators and stages, not JavaScript spellings. Read by the drift audits. */
export function everyMongoName(): readonly string[] {
  return mongoNames();
}

function mongoNames(): readonly string[] {
  return Object.keys(NAMES).filter((n) => (NAMES as Record<string, { kind?: string }>)[n]?.kind === "mongo");
}

/** Every MongoDB STAGE the registry states — a name legal where a pipeline stage stands. */
export function everyStageName(): readonly string[] {
  return mongoNames().filter((n) => {
    const positions = (row(n) as { where?: readonly string[] } | undefined)?.where ?? [];
    return positions.includes("stream") || positions.includes("statement");
  });
}

/**
 * Every MongoDB OPERATOR the registry states — a name callable at the top level of a
 * position that evaluates one. A name `onlyInside` confines to another operator's body
 * in EVERY position it is legal in (`$box`, `$case`, `$each`) is not one: it cannot
 * stand alone, so nothing should offer it as though it could.
 */
export function everyOperatorName(): readonly string[] {
  return mongoNames().filter((n) => {
    const r = row(n) as { where?: readonly string[]; onlyInside?: Record<string, unknown> } | undefined;
    if (r === undefined) return false;
    const positions = r.where ?? [];
    const evaluates = positions.some((p) => p === "value" || p === "group" || p === "window" || p === "filter");
    return evaluates && positions.some((p) => (r.onlyInside ?? {})[p] === undefined);
  });
}

/** The category an operator row states, or undefined for a row that states none. Read by the drift audits. */
export function categoryOf(name: string): string | undefined {
  return (row(name) as { category?: string } | undefined)?.category;
}

/**
 * The row's one-sentence description. `$count` is a stage AND an accumulator and states
 * one per meaning, so the caller says which half it is describing.
 */
export function describes(name: string, half: "operator" | "stage"): string {
  const doc = (row(name) as { doc?: string | Record<string, string> } | undefined)?.doc;
  if (typeof doc === "string") return doc;
  return doc?.[half] ?? "";
}

/**
 * The stage's diagnostic tier — the sigil scope its sugar spelling is reached
 * through, and whether it takes an options document — or undefined for an
 * ordinary stage that reads the stream.
 */
export function diagnosticOf(
  name: string,
): { scope: "collection" | "database" | "cluster"; options: boolean } | undefined {
  return (row(name) as { diagnostic?: { scope: "collection" | "database" | "cluster"; options: boolean } } | undefined)
    ?.diagnostic;
}

/** Does the stage leave the stream's COUNT and its documents' FIELDS both untouched? */
export function preservesCountOf(name: string): boolean {
  return (row(name) as { preservesCount?: true } | undefined)?.preservesCount === true;
}

export function replacesDocumentOf(name: string): true | "inclusion" | false {
  return (row(name) as { replacesDocument?: true | "inclusion" } | undefined)?.replacesDocument ?? false;
}

export function onlyOf(name: string): readonly string[] {
  return (row(name) as { only?: readonly string[] } | undefined)?.only ?? [];
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

/**
 * Does a value cell of this name read its arguments as ONE list — `args.spread`
 * stated on some rule of its `expr` cell? The desugar pass then packs a spread
 * call's arguments into one array literal, and the cell reads that.
 */
export function packsSpreadOf(name: string): boolean {
  const states = (v: unknown): boolean => {
    if (v === null || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    if (o.spread === true && typeof o.sig === "string") return true;
    return Object.values(o).some(states);
  };
  return states((row(name) as { expr?: unknown } | undefined)?.expr);
}

/** A mutator's write form by argument count — `.pop()` → `_r.slice(0, -1)` — or undefined when the row states none. */
export function mutatorFormOf(name: string): MutatorForm | undefined {
  return (row(name) as { mutatorForm?: MutatorForm } | undefined)?.mutatorForm;
}

/** The operators this name is a FRAGMENT of at `position` — `$case` inside `$switch`, `$box` inside `$geoWithin` — or undefined when it stands on its own. */
export function onlyInsideOf(name: string, position: Position): readonly string[] | undefined {
  return (row(name) as { onlyInside?: Partial<Record<Position, readonly string[]>> } | undefined)?.onlyInside?.[
    position
  ];
}

// ── the vocabulary the globals generator reads ──────────────────────────────
//
// `scripts/generate-globals.mjs` types the ambient `$$` / `$$$` chains and the
// value methods from these, so the generated `src/globals.ts` cannot drift from
// the registry: what a row states here is what the editor completes.

/** Is this cell a RULE — something that lowers — rather than a refusal or an in-code marker? */
function isRuleCell(cell: unknown): boolean {
  if (cell === null || typeof cell !== "object") return false;
  const c = cell as Record<string, unknown>;
  if ("unsupported" in c || "inCode" in c || "because" in c) return false;
  if ("perFamily" in c) return Object.values(c.perFamily as Record<string, unknown>).some(isRuleCell);
  if ("byArgs" in c) return Object.values(c.byArgs as Record<string, unknown>).some(isRuleCell);
  return "emit" in c || "uncertain" in c;
}

/** The JavaScript-named method rows: callable, on a receiver family, neither a global nor a MongoDB operator. */
const VALUE_FAMILIES: ReadonlySet<string> = new Set(["array", "string", "number", "object", "date", "regexp", "set"]);

function methodRows(): string[] {
  return Object.keys(ROWS).filter((n) => {
    if (n.startsWith("$") || !isCallable(n) || isGlobalName(n)) return false;
    const on = families(row(n)?.on);
    // a method on a VALUE — not a namespace static (`Math.abs`) and not a stage on the stream alone
    return on === "any" || (on !== undefined && on.some((f) => VALUE_FAMILIES.has(f)));
  });
}

/** Every JavaScript-named method row, whatever it lives on — a value or the stream alone. */
function everyMethodRow(): string[] {
  return Object.keys(ROWS).filter(
    (n) => !n.startsWith("$") && isCallable(n) && !isGlobalName(n) && row(n)?.on !== undefined,
  );
}

/** The methods that chain on a stream (`$.filter(…)`, `$.take(3)`): a stream RULE on the row. */
export function streamMethodNames(): string[] {
  // a union link (`.concat(…)` → `$unionWith`) chains too, though the union road lowers it rather than a stream cell
  return everyMethodRow().filter(
    (n) => lists(n, "stream") && (isRuleCell((row(n) as { stream?: unknown }).stream) || unionsOf(n)),
  );
}

/** The methods that END a `$$$.<coll>` chain with a value: an array value rule and no stream rule. */
export function valueTerminalMethodNames(): string[] {
  return methodRows().filter((n) => {
    const on = families(row(n)?.on);
    if (on === undefined || on === "any" || !on.includes("array")) return false;
    const r = row(n) as { expr?: unknown; stream?: unknown };
    return isRuleCell(r.expr) && !isRuleCell(r.stream);
  });
}

/** Every method the rows know in value position — a rule or a refusal that names the alternative; the editor completes both. */
export function valueMethodNames(): string[] {
  return methodRows().filter((n) => lists(n, "value") || (row(n) as { expr?: unknown }).expr !== undefined);
}

/** The kind each value method states it returns — a Kind, or "unknown" when it depends on the receiver. */
export function valueMethodReturns(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of valueMethodNames()) {
    const r = returnsOf(n);
    out[n] = typeof r === "string" ? r : "unknown";
  }
  return out;
}

/** Does the method run on ANY receiver — the one way a row escapes the receiver check? Read by the drift audits. */
export function acceptsAnyReceiver(name: string): boolean {
  return row(name)?.on === "any";
}

/** The one receiver family a method needs, or null when it lives on several or on any. */
export function requiredReceiverFamily(name: string): Family | null {
  const on = families(row(name)?.on);
  if (on === undefined || on === "any" || on.length !== 1) return null;
  return on[0];
}

/** The `Date.prototype` methods jsmql lowers — the ones TypeScript already types. */
export function nativeDateMethodNames(): string[] {
  return methodRows().filter((n) => {
    const on = families(row(n)?.on);
    return (
      on !== undefined &&
      on !== "any" &&
      on.includes("date") &&
      typeof (Date.prototype as unknown as Record<string, unknown>)[n] === "function"
    );
  });
}
