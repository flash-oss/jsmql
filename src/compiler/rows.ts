import type {
  Arity,
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
import { FIELD_FAMILY_TYPES, isDate, isSlotLayout } from "../registry/vocabulary.ts";
import { NAMES } from "../registry/names.ts";

const ROWS: Readonly<Record<string, unknown>> = Object.assign(Object.create(null), NAMES);

type AnyRow = { kind: string; call?: boolean; on?: On; where: readonly Position[] };

const row = (name: string): AnyRow | undefined => ROWS[name] as AnyRow | undefined;

function families(on: On | undefined): readonly Family[] | "any" | undefined {
  if (on === undefined) return undefined;
  if (on === "any") return "any";
  return Array.isArray(on) ? on : [on as Family];
}

const FIELD_FAMILIES: readonly Family[] = Object.keys(FIELD_FAMILY_TYPES) as FieldFamily[];

export function isFieldProperty(name: string): boolean {
  const r = row(name);
  if (r === undefined || r.call !== false) return false;
  const fams = families(r.on);
  if (fams === undefined) return false;
  if (fams === "any") return true;
  return fams.some((f) => FIELD_FAMILIES.includes(f));
}

function bodyLayoutOf(name: string): Readonly<Record<string, SlotPosition>> | undefined {
  return (row(name) as { bodyPositions?: Readonly<Record<string, SlotPosition>> } | undefined)?.bodyPositions;
}

export function isStageName(name: string): boolean {
  return bodyLayoutOf(name) !== undefined;
}

export type BodySlot = { at: Position; otherwise: Position; deeper: boolean; evaluated: boolean };

export type BodyPath = readonly (string | null)[];

const segmentsOf = (key: string): readonly string[] => (key === "" ? [] : key.split("."));

function covers(key: readonly string[], path: BodyPath): boolean {
  if (key.length > path.length) return false;
  return key.every((seg, i) => seg === "*" || seg === path[i]);
}

const wildcards = (key: readonly string[]): number => key.filter((seg) => seg === "*").length;

export function bodySlotAt(stage: string, path: BodyPath): BodySlot | undefined {
  const layout = bodyLayoutOf(stage);
  if (layout === undefined) return undefined;
  const keys = Object.keys(layout).map((key) => ({ key, seg: segmentsOf(key) }));
  const evaluatedPaths = evaluatesOf(stage).map(segmentsOf);
  const below = (seg: readonly string[]): boolean =>
    seg.length > path.length && covers(seg.slice(0, path.length), path);
  const deeper = keys.some(({ seg }) => below(seg)) || evaluatedPaths.some(below);
  const evaluated = evaluatedPaths.some((seg) => covers(seg, path));
  let best: { key: string; seg: readonly string[] } | undefined;
  for (const cand of keys) {
    if (!covers(cand.seg, path)) continue;
    if (best === undefined || cand.seg.length > best.seg.length) best = cand;
    else if (cand.seg.length === best.seg.length && wildcards(cand.seg) < wildcards(best.seg)) best = cand;
  }
  if (best === undefined) return undefined;
  const stated = layout[best.key];
  return typeof stated === "string"
    ? { at: stated, otherwise: stated, deeper, evaluated }
    : { at: stated.list, otherwise: stated.otherwise, deeper, evaluated };
}

function evaluatesOf(stage: string): readonly string[] {
  return (row(stage) as { evaluates?: readonly string[] } | undefined)?.evaluates ?? [];
}

export function blockBodyOf(name: string): "javascript" | "stages" {
  return (row(name) as { blockBody?: "javascript" | "stages" } | undefined)?.blockBody ?? "javascript";
}

export function isCallable(name: string): boolean {
  return row(name)?.call !== false;
}

export function namespaceNames(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [name, r] of Object.entries(ROWS) as [string, { kind?: string; provides?: unknown }][]) {
    if ((r?.kind === "root" || r?.kind === "global") && r.provides !== undefined) out.add(name);
  }
  return out;
}

export function immutableTwinOf(name: string): string | undefined {
  return (row(name) as { immutableTwin?: string } | undefined)?.immutableTwin;
}

export function arrayLiteralOrderOf(name: string): "receiver, then arguments" | "arguments, then receiver" | undefined {
  return (row(name) as { asArrayLiteral?: "receiver, then arguments" | "arguments, then receiver" } | undefined)
    ?.asArrayLiteral;
}

export function isMutator(name: string): boolean {
  return (
    immutableTwinOf(name) !== undefined || arrayLiteralOrderOf(name) !== undefined || mutatorFormOf(name) !== undefined
  );
}

export function iterateeSlotsOf(name: string, family: Family): IterateeSlots | undefined {
  const decl = (row(name) as { iterateeSlots?: Readonly<Partial<Record<Family, IterateeSlots>>> } | undefined)
    ?.iterateeSlots;
  return decl?.[family];
}

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

export function receiverFamily(receiverName: string | null, onStream: boolean, name: string): Family | undefined {
  if (onStream) return "stream";
  const fams = families(row(name)?.on);
  if (fams === undefined || fams === "any") return undefined;
  if (receiverName !== null && fams.includes(receiverName as Family)) return receiverName as Family;
  const values = fams.filter((f) => FIELD_FAMILIES.includes(f));
  return values.length === 1 ? values[0] : undefined;
}

export function receiverFamiliesOf(name: string): readonly Family[] | "any" | undefined {
  return families(row(name)?.on);
}

type ArgCount = { exact?: number; allowed?: readonly number[]; atLeast?: number; none?: true };

export function elementsOf(name: string): "scalar" | Kind | undefined {
  return (row(name) as { elements?: "scalar" | Kind } | undefined)?.elements;
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
  const byArgs = (cell as { byArgs?: Readonly<Record<string, { args?: ArgCount; unsupported?: string }>> }).byArgs;
  if (byArgs === undefined) return undefined;
  const allowed = new Set<number>();
  let atLeast: number | undefined;
  for (const branch of Object.values(byArgs)) {
    if (branch.unsupported !== undefined) continue;
    const a = branch.args;
    if (a === undefined) return undefined;
    if (a.none === true) allowed.add(0);
    if (a.exact !== undefined) allowed.add(a.exact);
    for (const n of a.allowed ?? []) allowed.add(n);
    if (a.atLeast !== undefined) atLeast = atLeast === undefined ? a.atLeast : Math.min(atLeast, a.atLeast);
  }
  if (atLeast !== undefined) return { atLeast: Math.min(atLeast, ...allowed) };
  return { allowed: [...allowed].sort((x, y) => x - y) };
}

export function acceptsArgumentCount(name: string, count: number, family?: Family): boolean {
  const rule = argCountOf(name, family);
  if (rule === undefined) return true;
  if (rule.none === true) return count === 0;
  if (rule.exact !== undefined) return count === rule.exact;
  if (rule.allowed !== undefined) return rule.allowed.includes(count);
  if (rule.atLeast !== undefined) return count >= rule.atLeast;
  return true;
}

export function positionsOf(name: string): readonly Position[] | undefined {
  return row(name)?.where;
}

export function suggestedAs(name: string): string | undefined {
  const r = row(name) as { where: readonly Position[]; renamedTo?: string } | undefined;
  if (r === undefined) return undefined;
  if (r.renamedTo !== undefined) return r.renamedTo;
  return r.where.length === 0 ? undefined : name;
}

export function lists(name: string, where: Position): boolean {
  return row(name)?.where.includes(where) === true;
}

import type { Binds, DocumentEffect, TypeExpr } from "../registry/vocabulary.ts";
import type { CallbackParams } from "../registry/vocabulary.ts";
import { PRODUCTIONS } from "../registry/productions.ts";
import { internalError } from "../errors.ts";

type EmitRow = {
  returns?: TypeExpr;
  params?: CallbackParams;
  binds?: Binds;
  shape?: "single" | "array" | "none" | "flex" | "verbatim" | "object";
  family?: Family;
  spreadAlternative?: string;
  provides?: unknown;
  token?: string;
};

const emitRow = (name: string): EmitRow | undefined =>
  (ROWS[name] as EmitRow | undefined) ?? ((PRODUCTIONS as Record<string, unknown>)[name] as EmitRow | undefined);

export function soleFieldFamilyOf(name: string): Family | null {
  const fams = families(row(name)?.on);
  if (fams === undefined || fams === "any") return null;
  const fields = fams.filter((f) => FIELD_FAMILIES.includes(f) && !refusesFamily(name, f));
  return fields.length === 1 ? fields[0] : null;
}

function refusesFamily(name: string, family: Family): boolean {
  const cell = (row(name) as { expr?: unknown } | undefined)?.expr as
    | { perFamily?: Record<string, unknown> }
    | undefined;
  const branch = cell?.perFamily?.[family];
  return (
    typeof branch === "object" &&
    branch !== null &&
    typeof (branch as { unsupported?: unknown }).unsupported === "string"
  );
}

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

export function isKnownName(name: string): boolean {
  return row(name) !== undefined;
}

export function returnsOf(name: string): TypeExpr {
  return emitRow(name)?.returns ?? "unknown";
}

export function callbackParamsOf(name: string, position: Position): readonly string[] | undefined {
  const p = emitRow(name)?.params;
  if (p === undefined) return undefined;
  if (Array.isArray(p)) return p as readonly string[];
  return (p as Readonly<Partial<Record<Position, readonly string[]>>>)[position];
}

export function bindsOf(name: string): Binds | undefined {
  return emitRow(name)?.binds;
}

export function positionalKeysOf(name: string): readonly string[] {
  return (emitRow(name) as { keys?: readonly string[] } | undefined)?.keys ?? [];
}

export function takesLetOf(stage: string): boolean {
  return (row(stage) as { takesLet?: true } | undefined)?.takesLet === true;
}

export function operandPositionOf(name: string): Position | undefined {
  return (row(name) as { operandPosition?: Position } | undefined)?.operandPosition;
}

export function liftsToOf(name: string): { op: string; negated?: true } | undefined {
  return (row(name) as { liftsTo?: { op: string; negated?: true } } | undefined)?.liftsTo;
}

export function takesNoReceiver(name: string): boolean {
  const kind = (row(name) as { kind?: string } | undefined)?.kind;
  return name.startsWith("$") || kind === "mongo" || kind === "global";
}

export function valueTwinOf(name: string): string | undefined {
  return (row(name) as { valueTwin?: string } | undefined)?.valueTwin;
}

export function operandShapeOf(name: string): "single" | "array" | "none" | "flex" | "verbatim" | "object" | undefined {
  return emitRow(name)?.shape;
}

export function spreadAlternativeOf(name: string): string | undefined {
  return emitRow(name)?.spreadAlternative;
}

export function productionForNode(nodeType: string): string | undefined {
  for (const [key, p] of Object.entries(PRODUCTIONS) as [string, { becomes: unknown }][]) {
    if (p.becomes === nodeType) return key;
  }
  return undefined;
}

export function forbiddenInOf(name: string): readonly string[] {
  return (row(name) as { forbiddenIn?: readonly string[] } | undefined)?.forbiddenIn ?? [];
}

export function bansNestedOf(name: string): readonly string[] {
  return (row(name) as { bansNested?: readonly string[] } | undefined)?.bansNested ?? [];
}

export function placementOf(name: string): { first?: string; container?: string } {
  return (row(name) as { placement?: { first?: string; container?: string } } | undefined)?.placement ?? {};
}

export function picksOneOf(name: string): string | null {
  return (row(name) as { picksOne?: string } | undefined)?.picksOne ?? null;
}

export function unionsOf(name: string): boolean {
  return (row(name) as { unions?: true } | undefined)?.unions === true;
}

export function mergesIntoOf(name: string): boolean {
  return (row(name) as { mergesInto?: true } | undefined)?.mergesInto === true;
}

export function elementOnlyOf(name: string): { when: "always" | "bare"; why: string } | null {
  return (row(name) as { elementOnly?: { when: "always" | "bare"; why: string } } | undefined)?.elementOnly ?? null;
}

export function hasStreamValueCell(name: string): boolean {
  const expr = (row(name) as { expr?: { perFamily?: Record<string, unknown> } } | undefined)?.expr;
  const cell = expr?.perFamily?.stream;
  return typeof cell === "object" && cell !== null && typeof (cell as { emit?: unknown }).emit === "function";
}

export function neverNullOf(name: string): boolean {
  const stated = (row(name) as { neverNull?: true | "always" } | undefined)?.neverNull;
  return stated === true || stated === "always";
}

export function neverNullAlwaysOf(name: string): boolean {
  return (row(name) as { neverNull?: true | "always" } | undefined)?.neverNull === "always";
}

export function readsNullAsEmptyOf(name: string): boolean {
  return (row(name) as { readsNullAsEmpty?: true } | undefined)?.readsNullAsEmpty === true;
}

export function passesNullOf(name: string): boolean {
  return (row(name) as { passesNull?: true } | undefined)?.passesNull === true;
}

export function productionPassesNullOf(key: string): boolean {
  return ((PRODUCTIONS as Record<string, unknown>)[key] as { passesNull?: true } | undefined)?.passesNull === true;
}

function nullReceiverAsOf(name: string): 0 | 1 | "" | false | Date | undefined {
  return (row(name) as { nullReceiverAs?: 0 | 1 | "" | false | Date } | undefined)?.nullReceiverAs;
}

export function emptyValueOf(
  name: string,
  family: string | null,
): [] | Record<string, never> | "" | 0 | 1 | false | Date | null {
  const stated = nullReceiverAsOf(name);
  if (isDate(stated)) return new Date(stated.getTime());
  if (stated !== undefined) return stated;
  const own = families(row(name)?.on);
  const fams: readonly string[] =
    family !== null
      ? [family]
      : own === undefined || own === "any"
        ? []
        : own.filter((f) => FIELD_FAMILIES.includes(f));
  if (fams.length === 0) return null;
  if (fams.every((f) => f === "array")) return [];
  if (fams.every((f) => f === "object")) return {};
  if (fams.every((f) => f === "string")) return "";
  if (fams.every((f) => f === "number")) return 0;
  if (fams.every((f) => f === "date")) return new Date(0);
  return null;
}

export function siblingOf(name: string, family: string): string | null {
  return (row(name) as { sibling?: Readonly<Record<string, string>> } | undefined)?.sibling?.[family] ?? null;
}

export function restoresDocumentsOf(name: string): boolean {
  return (row(name) as { restoresDocuments?: true } | undefined)?.restoresDocuments === true;
}

export function collapsesOf(name: string): boolean {
  return (row(name) as { collapses?: true } | undefined)?.collapses === true;
}

export function streamBodyOf(name: string): "document" | null {
  return (row(name) as { streamBody?: "document" } | undefined)?.streamBody ?? null;
}

export function pipelineOverOf(name: string): "foreign" | null {
  return (row(name) as { pipelineOver?: "foreign" } | undefined)?.pipelineOver ?? null;
}

export function statementBodyOf(name: string): "pipeline" | readonly string[] | null {
  return (row(name) as { statementBody?: "pipeline" | readonly string[] } | undefined)?.statementBody ?? null;
}

export function everyMongoName(): readonly string[] {
  return mongoNames();
}

function mongoNames(): readonly string[] {
  return Object.keys(NAMES).filter((n) => (NAMES as Record<string, { kind?: string }>)[n]?.kind === "mongo");
}

export function everyStageName(): readonly string[] {
  return mongoNames().filter((n) => {
    const positions = (row(n) as { where?: readonly string[] } | undefined)?.where ?? [];
    return positions.includes("stream") || positions.includes("statement");
  });
}

export function everyOperatorName(): readonly string[] {
  return mongoNames().filter((n) => {
    const r = row(n) as { where?: readonly string[]; onlyInside?: Record<string, unknown> } | undefined;
    if (r === undefined) return false;
    const positions = r.where ?? [];
    const evaluates = positions.some((p) => p === "value" || p === "group" || p === "window" || p === "filter");
    return evaluates && positions.some((p) => (r.onlyInside ?? {})[p] === undefined);
  });
}

export function categoryOf(name: string): string | undefined {
  return (row(name) as { category?: string } | undefined)?.category;
}

export function describes(name: string, half: "operator" | "stage"): string {
  const doc = (row(name) as { doc?: string | Record<string, string> } | undefined)?.doc;
  if (typeof doc === "string") return doc;
  return doc?.[half] ?? "";
}

export function diagnosticOf(
  name: string,
): { scope: "collection" | "database" | "cluster"; options: boolean } | undefined {
  return (row(name) as { diagnostic?: { scope: "collection" | "database" | "cluster"; options: boolean } } | undefined)
    ?.diagnostic;
}

export function preservesCountOf(name: string): boolean {
  return (row(name) as { preservesCount?: true } | undefined)?.preservesCount === true;
}

export function documentOf(name: string): DocumentEffect | null {
  return (row(name) as { document?: DocumentEffect } | undefined)?.document ?? null;
}

export function familiesOf(name: string): readonly Family[] | null {
  const fams = families(row(name)?.on);
  return fams === undefined || fams === "any" ? null : fams;
}

export function onlyOf(name: string): readonly string[] {
  return (row(name) as { only?: readonly string[] } | undefined)?.only ?? [];
}

export function constructorGlobals(): readonly { name: string; doc: string }[] {
  const out: { name: string; doc: string }[] = [];
  for (const [name, r] of Object.entries(ROWS) as [
    string,
    { kind?: string; doc?: string; where?: readonly string[] },
  ][]) {
    if (r?.kind !== "global" || !(r.where ?? []).includes("value")) continue;
    out.push({ name, doc: r.doc ?? "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function isGlobalName(name: string): boolean {
  const k = row(name)?.kind;
  return k === "global" || k === "root";
}

export function rowForNodeType(nodeType: string): string | undefined {
  for (const p of Object.values(PRODUCTIONS) as { becomes: unknown; tokens: readonly string[] }[]) {
    const becomes = Array.isArray(p.becomes) ? p.becomes : [p.becomes];
    if (!becomes.includes(nodeType)) continue;
    const spelling = p.tokens[0];
    if (spelling !== undefined && ROWS[spelling] !== undefined) return spelling;
  }
  return undefined;
}

export function productionForOperator(nodeType: "BinaryExpr" | "UnaryExpr", op: string): string | undefined {
  for (const [key, p] of Object.entries(PRODUCTIONS) as [string, { becomes: unknown; tokens: readonly string[] }][]) {
    if (p.becomes === nodeType && p.tokens[0] === op) return key;
  }
  return undefined;
}

export function operandRuleOf(
  nodeType: "BinaryExpr" | "UnaryExpr",
  op: string,
): { key: string; rule: Arity } | undefined {
  const key = productionForOperator(nodeType, op);
  if (key === undefined) return undefined;
  const cell = (PRODUCTIONS as Record<string, { expr?: { args?: Arity } }>)[key]?.expr;
  return cell?.args === undefined ? undefined : { key, rule: cell.args };
}

export function productionBuilding(nodeType: string): string {
  const keys = (Object.entries(PRODUCTIONS) as [string, { becomes: unknown }][])
    .filter(([, p]) => p.becomes === nodeType)
    .map(([k]) => k);
  if (keys.length !== 1) internalError(`${keys.length} productions build a '${nodeType}'`);
  return keys[0];
}

export function productionSpelling(productionKey: string): string {
  return ((PRODUCTIONS as Record<string, unknown>)[productionKey] as { spelling: string }).spelling;
}

export function flattensChain(productionKey: string): boolean {
  return (PRODUCTIONS as Record<string, { flattensChain?: true }>)[productionKey]?.flattensChain === true;
}

export function packsSpreadOf(name: string): boolean {
  const states = (v: unknown): boolean => {
    if (v === null || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    if (o.spread === true && typeof o.sig === "string") return true;
    return Object.values(o).some(states);
  };
  return states((row(name) as { expr?: unknown } | undefined)?.expr);
}

export function lowersOn(name: string, family: string): boolean {
  const cell = (row(name) as { expr?: unknown } | undefined)?.expr;
  if (cell === null || typeof cell !== "object") return false;
  const own = (cell as { perFamily?: Record<string, unknown> }).perFamily;
  return isRuleCell(own === undefined ? cell : own[family]);
}

export function mutatorFormOf(name: string): MutatorForm | undefined {
  return (row(name) as { mutatorForm?: MutatorForm } | undefined)?.mutatorForm;
}

function isRuleCell(cell: unknown): boolean {
  if (cell === null || typeof cell !== "object") return false;
  const c = cell as Record<string, unknown>;
  if ("unsupported" in c || "inCode" in c || "because" in c) return false;
  if ("perFamily" in c) return Object.values(c.perFamily as Record<string, unknown>).some(isRuleCell);
  if ("byArgs" in c) return Object.values(c.byArgs as Record<string, unknown>).some(isRuleCell);
  return "emit" in c;
}

const VALUE_FAMILIES: ReadonlySet<string> = new Set(["array", "string", "number", "object", "date", "regexp", "set"]);

function methodRows(): string[] {
  return Object.keys(ROWS).filter((n) => {
    if (n.startsWith("$") || !isCallable(n) || isGlobalName(n)) return false;
    const on = families(row(n)?.on);
    return on === "any" || (on !== undefined && on.some((f) => VALUE_FAMILIES.has(f)));
  });
}

function everyMethodRow(): string[] {
  return Object.keys(ROWS).filter(
    (n) => !n.startsWith("$") && isCallable(n) && !isGlobalName(n) && row(n)?.on !== undefined,
  );
}

export function streamMethodNames(): string[] {
  return everyMethodRow().filter(
    (n) => lists(n, "stream") && (isRuleCell((row(n) as { stream?: unknown }).stream) || unionsOf(n)),
  );
}

export function streamReceiverNames(): string[] {
  return Object.keys(ROWS).filter((n) => lists(n, "stream") || familiesOf(n)?.includes("stream") === true);
}

export function bareCallableNames(): string[] {
  return Object.keys(ROWS).filter(
    (n) => !n.startsWith("$") && isGlobalName(n) && isCallable(n) && (positionsOf(n)?.length ?? 0) > 0,
  );
}

export function constructibleNames(): string[] {
  return bareCallableNames().filter((n) => isGlobalName(n) && lists(n, "value"));
}

export function valueTerminalMethodNames(): string[] {
  return methodRows().filter((n) => {
    const on = families(row(n)?.on);
    if (on === undefined || on === "any" || !on.includes("array")) return false;
    const r = row(n) as { expr?: unknown; stream?: unknown };
    return isRuleCell(r.expr) && !isRuleCell(r.stream);
  });
}

export function valueMethodNames(): string[] {
  return methodRows().filter((n) => lists(n, "value") || (row(n) as { expr?: unknown }).expr !== undefined);
}

export function topKindOf(r: TypeExpr): Kind | "unknown" {
  if (typeof r === "string")
    return r === "same" || r === "element" || r === "picked" || r === "omitted" ? "unknown" : r;
  if ("arrayOf" in r || "tuple" in r) return "array";
  if ("merge" in r || "recordOf" in r) return "object";
  if ("itemOf" in r) return "unknown";
  if ("oneOf" in r) {
    const kinds = new Set((r as { oneOf: readonly TypeExpr[] }).oneOf.map(topKindOf));
    return kinds.size === 1 ? [...kinds][0] : "unknown";
  }
  return "unknown";
}

export function valueMethodReturns(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of valueMethodNames()) out[n] = topKindOf(returnsOf(n));
  return out;
}

export function acceptsAnyReceiver(name: string): boolean {
  return row(name)?.on === "any";
}

export function requiredReceiverFamily(name: string): Family | null {
  const on = families(row(name)?.on);
  if (on === undefined || on === "any" || on.length !== 1) return null;
  return on[0];
}

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
