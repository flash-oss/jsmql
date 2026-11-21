import type { Expr as AstExpr, Node as AstNode } from "./ast.ts";

export type Expr = AstExpr;
export type Node = AstNode;
export type QueryDoc = Record<string, unknown>;

export const GROUP_SLOT = "__jsmqlTmp";

export const SIZE_SLOT = "__jsmql.size";

const shorthand = (test: Readonly<Record<string, unknown>>): unknown => {
  const keys = Object.keys(test);
  if (keys.length !== 1 || keys[0] !== "$eq") return test;
  const v = test.$eq;
  if (isRegExp(v)) return test;
  const operatorDoc =
    typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).some((k) => k.startsWith("$"));
  return operatorDoc ? test : v;
};

export const escapeForRegex = (needle: string): string => needle.replace(/[.*+?^${}()|[\]\\]/g, (m) => "\\" + m);

export function queryOwnValue(path: string, test: Readonly<Record<string, unknown>>): QueryDoc {
  if (path === "") return test as QueryDoc;
  return { [path]: shorthand(test) };
}

export function queryAmong(path: string, values: readonly unknown[]): QueryDoc {
  return path !== "" && values.includes(null)
    ? queryOwnValue(path, { $in: values, $exists: true })
    : queryOwnValue(path, { $in: values });
}

export function queryOrMissing(path: string, test: Readonly<Record<string, unknown>>): QueryDoc | null {
  const keys = Object.keys(test);
  if (keys.length === 1 && keys[0] === "$regex") return queryOwnValue(path, { $in: [test.$regex, null] });
  if (path === "") return null;
  return { $or: [queryOwnValue(path, test), { [path]: null }] };
}
export type Stage = Record<string, unknown>;
export const OPERATOR_CATEGORIES = [
  "arithmetic",
  "array",
  "bitwise",
  "boolean",
  "comparison",
  "conditional",
  "custom-aggregation",
  "data-size",
  "date",
  "encrypted-string",
  "geospatial",
  "literal",
  "miscellaneous",
  "object",
  "set",
  "string",
  "text",
  "timestamp",
  "trigonometry",
  "type",
  "variable",
  "window",
] as const;
export type OperatorCategory = (typeof OPERATOR_CATEGORIES)[number];
export type ArgType =
  | "number"
  | "string"
  | "fieldName"
  | "fieldPath"
  | "int"
  | "int-or-long"
  | "number-or-date"
  | "orderable"
  | "date"
  | "timestamp"
  | "bool"
  | "object"
  | "array"
  | "objectId"
  | "binData"
  | "any"
  | "value"
  | "callback"
  | "regex"
  | "element";

export type TokenName =
  | "LParen"
  | "RParen"
  | "LBracket"
  | "RBracket"
  | "LBrace"
  | "RBrace"
  | "Comma"
  | "Semi"
  | "Colon"
  | "Dot"
  | "QuestDot"
  | "DollarDot"
  | "Dollar"
  | "DoubleDollar"
  | "TripleDollar"
  | "QuadDollar"
  | "Spread"
  | "Plus"
  | "Minus"
  | "Star"
  | "StarStar"
  | "Slash"
  | "Percent"
  | "PlusPlus"
  | "MinusMinus"
  | "Eq"
  | "PlusEq"
  | "MinusEq"
  | "StarEq"
  | "SlashEq"
  | "EqEq"
  | "EqEqEq"
  | "BangEq"
  | "BangEqEq"
  | "Gt"
  | "GtEq"
  | "Lt"
  | "LtEq"
  | "AmpAmp"
  | "PipePipe"
  | "Bang"
  | "Amp"
  | "Pipe"
  | "Caret"
  | "Tilde"
  | "QuestQuest"
  | "Quest"
  | "Arrow"
  | "Number"
  | "BigInt"
  | "String"
  | "True"
  | "False"
  | "Null"
  | "Undefined"
  | "RegexLiteral"
  | "TemplateStart"
  | "TemplateChars"
  | "TemplateExprStart"
  | "TemplateEnd"
  | "In"
  | "New"
  | "Typeof"
  | "Delete"
  | "Let"
  | "Const"
  | "Return"
  | "Ident"
  | "EOF";

export type NodeName = AstNode["type"];

export type Family =
  | "string"
  | "array"
  | "number"
  | "object"
  | "date"
  | "regexp"
  | "stream"
  | "Math"
  | "Object"
  | "Number"
  | "Date"
  | "Array"
  | "cluster";

export type OperandClass = "value" | "namespace" | "name" | "collection" | "database" | "cluster";

export type Context = "expression" | "params" | "callArgs" | "statement" | "objectBody";

type ArgShape = "none" | "multiple" | "object" | "constant" | "dynamic";

export const BSON_KIND: Readonly<Record<string, Kind>> = {
  ObjectId: "objectId",
  Decimal128: "number",
  Long: "number",
  Int32: "number",
  Double: "number",
  Binary: "binData",
  MinKey: "minKey",
  MaxKey: "maxKey",
};

export function bsonTagOf(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const tag = (v as { _bsontype?: unknown })._bsontype;
  return typeof tag === "string" ? (tag === "ObjectID" ? "ObjectId" : tag) : undefined;
}

const kindOf = (v: unknown): string => Object.prototype.toString.call(v);
const readsSlot = (read: (this: unknown) => unknown, v: unknown): boolean => {
  try {
    read.call(v);
    return true;
  } catch {
    return false;
  }
};
const slotReader = (proto: object, key: PropertyKey): ((this: unknown) => unknown) =>
  Object.getOwnPropertyDescriptor(proto, key)!.get!;
const regexSource = slotReader(RegExp.prototype, "source");
const typedArrayName = slotReader(Object.getPrototypeOf(Uint8Array.prototype) as object, Symbol.toStringTag);
export const isDate = (v: unknown): v is Date => kindOf(v) === "[object Date]" && readsSlot(Date.prototype.getTime, v);
export const isRegExp = (v: unknown): v is RegExp => kindOf(v) === "[object RegExp]" && readsSlot(regexSource, v);
export const isBytes = (v: unknown): v is Uint8Array => typedArrayName.call(v) === "Uint8Array";
const mapSize = slotReader(Map.prototype, "size");
export const isMap = (v: unknown): v is Map<unknown, unknown> => kindOf(v) === "[object Map]" && readsSlot(mapSize, v);
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

export type Kind =
  | "string"
  | "array"
  | "number"
  | "object"
  | "date"
  | "bool"
  | "stream"
  | "objectId"
  | "binData"
  | "minKey"
  | "maxKey";

export type Position = "value" | "filter" | "stream" | "statement" | "group" | "window" | "updateDoc";

export type SlotPosition = Position | { readonly list: Position; readonly otherwise: Position };

export type Only = "stageFirst" | "stageLast" | "update" | "afterSort";

export type Binds =
  | { keysOf: string; visibleIn: readonly string[] }
  | { valueAt: string; default: string; visibleIn: readonly string[] }
  | { fixed: readonly string[]; visibleIn: readonly string[] };

export type Type = {
  readonly kinds: ReadonlySet<Kind> | "any";
  readonly absent: boolean;
  readonly element?: Type;
  readonly items?: readonly Type[];
  readonly props?: ReadonlyMap<string, Type>;
  readonly open: boolean;
  readonly values?: Type;
};

export type TypeExpr =
  | Kind
  | "same"
  | "element"
  | "unknown"
  | "picked"
  | "omitted"
  | { readonly arrayOf: TypeExpr }
  | { readonly elementOf: TypeExpr }
  | { readonly callback: number }
  | { readonly arg: number }
  | { readonly args: number }
  | { readonly merge: readonly TypeExpr[] }
  | { readonly oneOf: readonly TypeExpr[] }
  | { readonly recordOf: TypeExpr }
  | { readonly tuple: readonly TypeExpr[] }
  | { readonly itemOf: readonly [TypeExpr, number] }
  | FamilyMap;

export interface FamilyMap extends Partial<Record<Family, TypeExpr>> {}

/**
 * What a STAGE does to the document `Type` the next stage sees. Every stage row
 * states one. The compiler evaluates it after the stage's own writes.
 * See docs/specs/types.md § The document after a stage.
 *
 *   "keeps"       the input fields survive; the body's writes go through the write rules — `$set`, `$sort`
 *   "narrows"     the input fields survive, and only the documents the body's QUERY selects pass: what the
 *                 query states about a field — present, of a kind — holds after it — `$match`
 *   "fields"      the document is exactly the body's keys, each typed by its value, closed — `$group`, `$facet`;
 *                 a string body names the one number field the stage writes — `$count`
 *   "value"       the document is the body value's type — `$replaceRoot`, `$replaceWith`
 *   "projection"  inclusion keeps the named paths, closed; exclusion removes them — `$project`
 *   "element"     the named path becomes its element type — `$unwind`
 *   "unknown"     an open object with nothing known — `$unionWith`, `$documents`, a diagnostic stage, and a
 *                 stage whose output fields no body layout states yet (`$bucket`, `$sortByCount`) [DEF-038]
 */
export type DocumentEffect = "keeps" | "narrows" | "fields" | "value" | "projection" | "element" | "unknown";

type ParamKind = "accumulator" | "value" | "index" | "key" | "receiver" | "binding";

export type CallbackParams = readonly ParamKind[] | Readonly<Partial<Record<Position, readonly ParamKind[]>>>;

export type Arity = {
  sig: string;
  exact?: number;
  allowed?: readonly number[];
  atLeast?: number;
  none?: true;
  spread?: true;
  reject?: Readonly<Record<number, string>>;
  constant?: readonly number[];
  nonEmpty?: Readonly<Record<number, { noun: string; instead: string }>>;
  slotType?: Readonly<Record<number, ArgType | readonly ArgType[]>>;
  rest?: ArgType | readonly ArgType[];
  slotHint?: Readonly<Record<number, string>>;
  homogeneous?: true;
  arrayOf?: Readonly<Record<number, ArgType>>;
  slotRange?: Readonly<Record<number, readonly [number, number]>>;
  nonZero?: readonly number[];
  zeroRefused?: Readonly<Record<number, string>>;
  oneChar?: readonly number[];
  integer?: readonly number[];
  slotEnums?: Readonly<Record<number, readonly string[]>>;
  regexFlag?: Readonly<Record<number, string>>;
  body?: Readonly<Record<number, BodyRule>>;
  dateFormat?: readonly number[];
  noCallback?: Readonly<Record<number, string>>;
};

export type SlotForm =
  | "propertyPath"
  | "propertyIndex"
  | "matchesObject"
  | "matchesPropertyPair"
  | "bareCallable"
  | "omitted";

export type IterateeSlots =
  | Readonly<Record<number, readonly SlotForm[]>>
  | { arrowOnly: string }
  | { sortSpec: string };

export const isSlotLayout = (l: IterateeSlots): l is Readonly<Record<number, readonly SlotForm[]>> =>
  !("arrowOnly" in l) && !("sortSpec" in l);

export type BodyRule = {
  required: readonly string[];
  optional: readonly string[];
  closed: boolean;
  enums?: Readonly<Record<string, readonly string[]>>;
  caseInsensitiveKeys?: readonly string[];
  keyTypes?: Readonly<Record<string, ArgType>>;
  constantKeys?: readonly string[];
  notTogether?: readonly (readonly (readonly string[])[])[];
};

declare const TRUTH: unique symbol;
export type Truth = { readonly [TRUTH]: "truth" };

export type OutOf = {
  value: unknown;
  filter: QueryDoc;
  stream: Stage[];
  statement: Stage[];
  group: unknown;
  window: unknown;
  updateDoc: unknown;
};

export type FilterOut<HasValue extends boolean> = HasValue extends true ? QueryDoc | null : QueryDoc;

export type FilterIn = {
  name: string;
  recv: Expr | null;
  args: readonly Expr[];
  keys: readonly string[];
  pathOf: (e: Expr) => string | null;
  constant: (e: Expr) => { value: unknown } | null;
  query: (e: Expr) => QueryDoc;
  nativeQuery: (e: Expr) => QueryDoc | null;
  elementQuery: (cb: Expr) => QueryDoc | null;
  value: (e: Expr) => unknown;
  fieldPath: (e: Expr) => string;
  literal: (e: Expr) => unknown;
  literalOf: (e: Expr) => { value: unknown } | null;
  element: (cb: Expr) => QueryDoc;
  orMissing: (path: string, test: Readonly<Record<string, unknown>>) => QueryDoc | null;
};

export const BSON_TYPE_ALIASES: readonly string[] = [
  "double",
  "string",
  "object",
  "array",
  "binData",
  "objectId",
  "bool",
  "date",
  "null",
  "regex",
  "dbPointer",
  "javascript",
  "symbol",
  "javascriptWithScope",
  "int",
  "timestamp",
  "long",
  "decimal",
  "minKey",
  "maxKey",
];

export function typeAliasOf(spelling: string): string | null {
  return BSON_TYPE_ALIASES.includes(spelling) ? spelling : null;
}

export const TYPEOF_HINTS: Readonly<Record<string, { name: string } | { test: string; write: string }>> = {
  boolean: { name: "bool" },
  bigint: { name: "long" },
  function: { name: "javascript" },
  number: { test: "a number", write: "x.isNumber()" },
  undefined: { test: "absence", write: "x === undefined" },
  missing: { test: "absence", write: "x === undefined" },
};

export type ExprIn = {
  name: string;
  recv: unknown;
  args: readonly Expr[];
  keys: readonly string[];
  value: (e: Expr) => unknown;
  wholeDocument: () => unknown;
  kind: (e: Expr) => Kind | "unknown";
  type: (e: Expr) => Type;
  present: boolean;
  truth: (e: Expr) => Truth;
  elementTruth: (ref: string) => Truth;
  iteratee: (cb: Expr) => { as: string; ref: string; in: unknown };
  callback: (
    cb: Expr,
    mode: "value" | "truth",
  ) => { input: unknown; as: string; ref: string; paired: boolean; in: unknown };
  sortSpec: (e: Expr, objects?: boolean) => SortAsk;
  orderBy: (keys: Expr, orders: Expr | undefined) => SortAsk;
  predicate: (cb: Expr) => { as: string; ref: string; in: Truth };
  objIteratee: (cb: Expr, mode: "value" | "truth") => { as: string; ref: string; body: unknown };
  reducer: (cb: Expr, seed: Expr) => { input: unknown; in: unknown };
  elements: (cb: Expr, count: number) => { as: string; ref: string; in: unknown };
  bind: (hint: string) => { as: string; ref: string };
  hoist: (stages: readonly Stage[], reads: string) => string;
  slot: () => string;
  construct: (spelling: string, refusal: string, arg?: Expr) => unknown;
};

export type MongoExprIn = Pick<ExprIn, "name" | "recv" | "args" | "keys" | "value" | "bind">;

export type SortAsk =
  | { readonly kind: "keys"; readonly spec: Readonly<Record<string, 1 | -1>> }
  | { readonly kind: "computed"; readonly key: Expr; readonly dir: 1 | -1 }
  | { readonly kind: "whole"; readonly dir: 1 | -1; readonly params: readonly [string, string]; readonly pos: number };

export type StageSortAsk = Exclude<SortAsk, { kind: "whole" }>;

export type StageIn = {
  name: string;
  args: readonly Expr[];
  predicate: (cb: Expr) => QueryDoc;
  reshape: (cb: Expr) => unknown;
  document: (cb: Expr) => unknown;
  fieldPath: (cb: Expr) => string;
  block: (cb: Expr) => Stage[];
  value: (e: Expr) => unknown;
  truth: (e: Expr) => Truth;
  condition: (cb: Expr) => Truth;
  sortedBy: () => Readonly<Record<string, unknown>>;
  sortSpec: (e: Expr, objects?: boolean) => StageSortAsk;
  orderBy: (keys: Expr, orders: Expr | undefined) => StageSortAsk;
  slot: () => string;
  bind: (hint: string) => { as: string; ref: string };
  element: () => { readonly path: string; readonly ref: string };
  wholeDocument: () => unknown;
  unwound: (path: string) => void;
};

export type MutatorForm = { readonly sig: string; readonly by: Readonly<Record<number, string>> };

export type GroupIn = {
  name: string;
  recv: unknown;
  args: readonly Expr[];
  keys: readonly string[];
  value: (e: Expr) => unknown;
  iteratee: (cb: Expr) => { as: string; ref: string; in: unknown };
};

export type Emit<In, Out> = (input: In) => Out;

type InCode = { inCode: string; args?: Arity };

export const inCode = (file: string, args?: Arity): InCode =>
  args === undefined ? { inCode: file } : { inCode: file, args };

export type Refusal = { unsupported: string; subjectFromCaller?: true };

export type ViaFallback = { fallback: "expr" };

type ComposedInto = { composedInto: readonly string[] };

export const composedInto = <const O extends readonly string[]>(...owners: O): { composedInto: O } => ({
  composedInto: owners,
});

export const viaFallback: ViaFallback = { fallback: "expr" };

export const unsupported = (why: string): Refusal => ({ unsupported: why });

export const because = (reason: string): Refusal => ({ unsupported: reason, subjectFromCaller: true });

export type Of<O> = O extends readonly (infer F extends Family)[] ? F : O extends Family ? O : Family;

export type BsonType =
  | "double"
  | "string"
  | "object"
  | "array"
  | "binData"
  | "undefined"
  | "objectId"
  | "bool"
  | "date"
  | "null"
  | "regex"
  | "javascript"
  | "symbol"
  | "int"
  | "timestamp"
  | "long"
  | "decimal"
  | "minKey"
  | "maxKey"
  | "missing";

export type Rule<In, Out> = { args: Arity; emit: Emit<In, Out> };

export const FIELD_FAMILY_TYPES = {
  string: ["string"],
  array: ["array"],
  number: ["int", "long", "double", "decimal"],
  object: ["object"],
  date: ["date"],
  regexp: ["regex"],
} as const satisfies Readonly<
  Record<Extract<Family, "string" | "array" | "number" | "object" | "date" | "regexp">, readonly BsonType[]>
>;
export type FieldFamily = keyof typeof FIELD_FAMILY_TYPES;

type ByArgs<In, Out> = {
  none?: Rule<In, Out>;
  multiple?: Rule<In, Out>;
  constant?: Rule<In, Out> | Refusal;
  dynamic?: Rule<In, Out> | Refusal;
  otherwise: Refusal;
};

export type Emitter<F extends Family, In, Out> =
  | Rule<In, Out>
  | { perFamily: Record<F, Rule<In, Out> | Refusal> }
  | { byArgs: ByArgs<In, Out> };

export type Lists<W extends readonly string[], K extends string> = K extends W[number] ? true : false;

export type Cell<
  Listed extends boolean,
  F extends Family,
  In,
  Out,
  C extends readonly string[] = readonly never[],
> = Listed extends true ? Emitter<F, In, Out> | InCode : NonEmitter<F, C>;

type NonEmitter<F extends Family, C extends readonly string[] = readonly never[]> =
  | Refusal
  | ViaFallback
  | { composedInto: C }
  | { perFamily: Record<F, Refusal | ViaFallback | ComposedInto> };

export type On = Family | readonly Family[] | "any";

export const single = (input: { name: string; args: readonly Expr[]; value: (e: Expr) => unknown }): unknown => ({
  [input.name]: input.value(input.args[0]),
});

export const objectBody = (input: {
  name: string;
  args: readonly Expr[];
  keys: readonly string[];
  value: (e: Expr) => unknown;
}): unknown => {
  const { name, args, keys, value } = input;
  const isBody = args.length === 1 && (args[0] as { type: string }).type === "ObjectLiteral";
  if (isBody || keys.length === 0) return { [name]: value(args[0]) };
  return { [name]: Object.fromEntries(args.map((a, i) => [keys[i], value(a)])) };
};
