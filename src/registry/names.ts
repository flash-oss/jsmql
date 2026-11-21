import {
  DATE_PARTS_CALENDAR,
  DATE_PARTS_ISO,
  DATE_PARTS_ISO_MARKERS,
  SORT_KEY_LIMIT,
  capitalizeExpr,
  cbrt,
  clampNonNegative,
  clampNonNegativeIndex,
  coerceStringBinding,
  cond,
  dateFromParts,
  dateOptions,
  distinctKeysExpr,
  escapeHtmlExpr,
  firstCharExpr,
  firstOf,
  foldedSubtract,
  indexedPairs,
  isFiniteNumber,
  isIfNullWrapped,
  iterateeKeys,
  joinWords,
  joinedWith,
  lastOf,
  literalIndexValue,
  negate,
  pairsToObject,
  normaliseSliceIndex,
  regexBody,
  mongoRegexOptions,
  resolveSliceIndex,
  reverseArrayOf,
  setKey,
  singleArrayArg,
  slotAggregate,
  sizeOf,
  sliceArray,
  strLenOf,
  stringKeyExpr,
  substrOperand,
  takeDropWhile,
  type Minted,
  uniqByReduce,
  wordsExpr,
  atPrecision,
  isNullish,
  carriesRoot,
} from "./mql.ts";
import type { CallArg } from "./ast.ts";
import { isFieldPathString } from "./ast.ts";
import type {
  Expr,
  Binds,
  CallbackParams,
  ArgType,
  Arity,
  BodyRule,
  Cell,
  Emit,
  Emitter,
  ExprIn,
  Family,
  IterateeSlots,
  FilterIn,
  FilterOut,
  GroupIn,
  Kind,
  Lists,
  MongoExprIn,
  Of,
  On,
  OutOf,
  OperandClass,
  OperatorCategory,
  Only,
  Position,
  SlotPosition,
  QueryDoc,
  Refusal,
  Type,
  TypeExpr,
  DocumentEffect,
  Rule,
  StageSortAsk,
  Stage,
  StageIn,
  TokenName,
  ViaFallback,
} from "./vocabulary.ts";
import {
  because,
  escapeForRegex,
  GROUP_SLOT,
  isDate,
  isPlainObject,
  SIZE_SLOT,
  objectBody,
  queryAmong,
  queryOwnValue,
  inCode,
  single,
  unsupported,
  viaFallback,
  type MutatorForm,
} from "./vocabulary.ts";

type RootSpec<W extends readonly Position[]> = {
  doc: string;
  token: TokenName;
  provides: OperandClass;
  returns?: TypeExpr;
  where: W;
  filter: Cell<Lists<W, "filter">, Family, FilterIn, FilterOut<Lists<W, "value">>>;
  expr: Cell<Lists<W, "value">, Family, ExprIn, OutOf["value"]>;
  stream: Cell<Lists<W, "stream">, Family, StageIn, OutOf["stream"]>;
  statement: Cell<Lists<W, "statement">, Family, StageIn, OutOf["statement"]>;
  group: Cell<Lists<W, "group">, Family, GroupIn, OutOf["group"]>;
  window: Cell<Lists<W, "window">, Family, GroupIn, OutOf["window"]>;
};

type NameSpec<W extends readonly Position[], O extends On, T extends string = never> = {
  doc: string;
  call: boolean;
  on: O;
  elements?: "scalar" | Kind;
  picksOne?: string;
  streamBody?: "document";
  collapses?: true;
  neverNull?: true | "always";
  readsNullAsEmpty?: true;
  nullReceiverAs?: 0 | 1 | "" | false | Date;
  passesNull?: true;
  sibling?: Readonly<Partial<Record<Family, string>>>;
  renamedTo?: string;
  restoresDocuments?: true;
  elementOnly?: { when: "always" | "bare"; why: string };
  unions?: true;
  mergesInto?: true;
  params?: CallbackParams;
  iterateeSlots?: Readonly<Partial<Record<Family, IterateeSlots>>>;
  immutableTwin?: T;
  asArrayLiteral?: "receiver, then arguments" | "arguments, then receiver";
  mutatorForm?: MutatorForm;
  blockBody?: "javascript" | "stages";
  returns: TypeExpr;
  where: W;
  only?: readonly Only[];
  filter: Cell<Lists<W, "filter">, Of<O>, FilterIn, FilterOut<Lists<W, "value">>>;
  expr: Cell<Lists<W, "value">, Of<O>, ExprIn, OutOf["value"]>;
  stream: Cell<Lists<W, "stream">, Of<O>, StageIn, OutOf["stream"]>;
  statement: Cell<Lists<W, "statement">, Of<O>, StageIn, OutOf["statement"]>;
  group: Cell<Lists<W, "group">, Of<O>, GroupIn, OutOf["group"]>;
  window: Cell<Lists<W, "window">, Of<O>, GroupIn, OutOf["window"]>;
  updateDoc?: Cell<Lists<W, "updateDoc">, Of<O>, ExprIn, OutOf["updateDoc"]>;
};

export type StageFacts =
  | {
      readonly bodyPositions: Readonly<Record<string, SlotPosition>> & { readonly "": SlotPosition };
      readonly document: DocumentEffect;
      readonly evaluates: readonly string[];
    }
  | { readonly bodyPositions?: undefined; readonly document?: undefined; readonly evaluates?: undefined };

type MongoSpec<
  W extends readonly Position[],
  F extends readonly string[] = readonly string[],
  I extends Readonly<Partial<Record<Position, readonly string[]>>> = Readonly<Record<never, never>>,
> = StageFacts & {
  doc: string | { operator: string; stage: string };
  category?: OperatorCategory;
  where: W;
  only?: readonly Only[];
  shape?: "single" | "array" | "none" | "flex" | "verbatim" | "object";
  keys?: readonly string[];
  takesLet?: true;
  valueTwin?: string;
  params?: CallbackParams;
  binds?: Binds;
  spreadAlternative?: string;
  returns?: TypeExpr;
  document?: DocumentEffect;
  neverNull?: true | "always";
  diagnostic?: { scope: "collection" | "database" | "cluster"; options: boolean };
  preservesCount?: true;
  pipelineOver?: "foreign";
  statementBody?: "pipeline" | readonly string[];
  operandPosition?: Position;
  liftsTo?: { op: string; negated?: true };
  forbiddenIn?: F;
  bansNested?: readonly string[];
  placement?: { first?: string; container?: string };
  onlyInside?: I;
  filter?: MongoCell<Lists<W, "filter">, Cell<true, Family, FilterIn, FilterOut<Lists<W, "value">>>, ViaFallback>;
  expr?: MongoCell<Lists<W, "value">, Cell<true, Family, MongoExprIn, OutOf["value"]>>;
  group?: MongoCell<Lists<W, "group">, Cell<true, Family, GroupIn, OutOf["group"]>>;
  window?: MongoCell<Lists<W, "window">, Cell<true, Family, GroupIn, OutOf["window"]>>;
  stream?: MongoCell<Lists<W, "stream">, Cell<true, Family, StageIn, OutOf["stream"]>>;
  statement?: MongoCell<Lists<W, "statement">, Cell<true, Family, StageIn, OutOf["statement"]>>;
  updateDoc?: MongoCell<Lists<W, "updateDoc">, Cell<true, Family, GroupIn, OutOf["updateDoc"]>>;
};

export type MongoRow<W extends readonly Position[]> = MongoSpec<W> & ListedCells<W>;

type MongoCell<Listed extends boolean, Rule, Unlisted = never> = Listed extends true ? Rule : Unlisted;

type CellPosition = {
  filter: "filter";
  expr: "value";
  group: "group";
  window: "window";
  stream: "stream";
  statement: "statement";
  updateDoc: "updateDoc";
};

type ListedCells<W extends readonly Position[]> = {
  [K in keyof CellPosition as Lists<W, CellPosition[K]> extends true ? K : never]-?: unknown;
};

type GlobalSpec<W extends readonly Position[]> = {
  doc: string;
  token: TokenName;
  provides?: Family;
  returns: TypeExpr;
  neverNull?: true | "always";
  where: W;
  only?: readonly Only[];
  filter: Cell<Lists<W, "filter">, Family, FilterIn, FilterOut<Lists<W, "value">>>;
  expr: Cell<Lists<W, "value">, Family, ExprIn, OutOf["value"]>;
  stream: Cell<Lists<W, "stream">, Family, StageIn, OutOf["stream"]>;
  statement: Cell<Lists<W, "statement">, Family, StageIn, OutOf["statement"]>;
  group: Cell<Lists<W, "group">, Family, GroupIn, OutOf["group"]>;
  window: Cell<Lists<W, "window">, Family, GroupIn, OutOf["window"]>;
  updateDoc?: Cell<Lists<W, "updateDoc">, Family, ExprIn, OutOf["updateDoc"]>;
};

export type RootEntry<W extends readonly Position[]> = RootSpec<W> & { kind: "root" };
export type NameEntry<W extends readonly Position[], O extends On, T extends string = never> = NameSpec<W, O, T> & {
  kind: "name";
};
export type MongoEntry<
  W extends readonly Position[],
  F extends readonly string[] = readonly never[],
  I extends Readonly<Partial<Record<Position, readonly string[]>>> = Readonly<Record<never, never>>,
> = MongoSpec<W, F, I> & { kind: "mongo" };
export type GlobalEntry<W extends readonly Position[]> = GlobalSpec<W> & { kind: "global" };

const root = <const W extends readonly Position[]>(e: RootSpec<W>): RootEntry<W> => ({ ...e, kind: "root" });
const name = <const W extends readonly Position[], const O extends On, const T extends string = never>(
  e: NameSpec<W, O, T>,
): NameEntry<W, O, T> => ({ ...e, kind: "name" });
const mongo = <
  const W extends readonly Position[],
  const F extends readonly string[] = readonly never[],
  const I extends Readonly<Partial<Record<Position, readonly string[]>>> = Readonly<Record<never, never>>,
>(
  e: MongoSpec<W, F, I> & ListedCells<W>,
): MongoEntry<W, F, I> => ({ ...e, kind: "mongo" });
const global_ = <const W extends readonly Position[]>(e: GlobalSpec<W>): GlobalEntry<W> => ({ ...e, kind: "global" });

const conversion = (e: { method: string; operator: string; returns: TypeExpr; safe?: 0 | false | Date }) =>
  name({
    doc: `'.${e.method}()' — emits ${e.operator}. See docs/LANGUAGE.md.`,
    call: true,
    on: "any",
    returns: e.returns,
    neverNull: true,
    passesNull: true,
    nullReceiverAs: e.safe,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ [e.operator]: singleArrayArg(recv) }) },
    stream: unsupported(`'.${e.method}()' has no stream form: it produces a value, not a stream of documents.`),
    statement: unsupported(
      `'.${e.method}()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.${e.method}();'`,
    ),
    group: unsupported(`'.${e.method}()' is not an accumulator. Inside '$group' write the MongoDB operator.`),
    window: unsupported(
      `'.${e.method}()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.`,
    ),
  });

const typeTest = (e: { method: string; alias: string; doc: string }) =>
  name({
    doc: `'.${e.method}()' — ${e.doc} See docs/LANGUAGE.md.`,
    call: true,
    on: "any",
    returns: "bool",
    neverNull: true,
    where: ["value", "filter"],
    filter: {
      args: { sig: "", none: true },
      emit: ({ recv, pathOf }) => {
        const path = recv === null ? null : pathOf(recv);
        return path === null ? null : queryOwnValue(path, { $type: e.alias });
      },
    },
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv }) =>
        e.alias === "number"
          ? { $isNumber: singleArrayArg(recv) }
          : { $eq: [{ $type: singleArrayArg(recv) }, e.alias] },
    },
    stream: unsupported(`'.${e.method}()' has no stream form: it produces a value, not a stream of documents.`),
    statement: unsupported(
      `'.${e.method}()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.${e.method}();'`,
    ),
    group: unsupported(`'.${e.method}()' is not an accumulator. Inside '$group' write the MongoDB operator.`),
    window: unsupported(
      `'.${e.method}()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.`,
    ),
  });

const renamed = (e: { from: string; to: string; reason: string; returns: TypeExpr; also?: string }) => {
  const refusal = unsupported(
    `'.${e.from}()' is not part of JSMQL — '.${e.to}()' is ${e.reason}, and one capability gets one spelling. Write '<value>.${e.to}()': '$.x.${e.to}()'.` +
      (e.also ?? ""),
  );
  return name({
    doc: `Parsed, then refused: JSMQL writes '.${e.to}()'.`,
    call: true,
    on: "any",
    returns: e.returns,
    renamedTo: e.to,
    where: [],
    filter: refusal,
    expr: refusal,
    stream: refusal,
    statement: refusal,
    group: refusal,
    window: refusal,
  });
};

const dateRow = (spelling: string) =>
  global_({
    doc: `A date. \`${spelling}()\` is now; a constant is a literal.`,
    token: "Ident",
    provides: "Date",
    returns: "date",
    neverNull: true,
    where: ["value"],
    filter: because(`a date is a value, not a test. Compare it: '$.t > ${spelling}("2024-01-01")'.`),
    updateDoc: unsupported(
      `'${spelling}(…)' is computed on the server, and a document-form update takes constants. As the whole write, '$.<field> = ${spelling}()' is '$currentDate'. Inside a value, write a date constant ('${spelling}("2026-01-01")'), pass a Date from your code (an interpolated '\${new Date()}'), or use the pipeline form ('jsmql.pipeline("$.a = { t: ${spelling}() };")'), which 'updateOne' accepts as well.`,
    ),
    expr: {
      byArgs: {
        none: { args: { sig: "", none: true }, emit: () => "$$NOW" },
        constant: {
          args: { sig: "value", exact: 1, slotType: { 0: ["string", "number", "date"] }, integer: [0] },
          emit: ({ args, construct }) =>
            construct(
              spelling,
              `${spelling}(<constant>) — only an ISO 8601 string or a millisecond count is a date constant, and this one is neither a valid date string nor a number. Write ${spelling}("2026-01-01") or ${spelling}(0).`,
              args[0],
            ),
        },
        dynamic: convertsWith(spelling, "toDate", MILLIS_TO_DATE),
        multiple: {
          args: { sig: "year, month, day, hour, minute, second, ms", allowed: [2, 3, 4, 5, 6, 7], rest: "int" },
          emit: ({ args, value }) => dateFromParts(args.map(value), null),
        },
        otherwise: unsupported(
          `'${spelling}(…)' takes no argument (now), one value to convert, or the calendar parts 'year, month, day[, hour, minute, second, ms]'.`,
        ),
      },
    },
    stream: unsupported(`'${spelling}' produces a value, not a stream of documents.`),
    statement: unsupported(`'${spelling}' produces a value. Use it inside a reshape or a '$set'.`),
    group: unsupported(`'${spelling}' is not an accumulator. Inside '$group' write the MongoDB operator.`),
    window: unsupported(
      `'${spelling}' is not a window function. Inside '$setWindowFields' write the MongoDB operator.`,
    ),
  });

const bsonValue = (e: {
  spelling: string;
  doc: string;
  returns: TypeExpr;
  method: string;
  isA: string;
  compare: string;
  refuseConstant: string;
  takes?: ArgType;
}) =>
  global_({
    doc: e.doc,
    token: "Ident",
    returns: e.returns,
    neverNull: true,
    where: ["value"],
    filter: because(`${e.isA} is a value, not a test. Compare it: '${e.compare}'.`),
    updateDoc: unsupported(
      `'${e.spelling}(<value>)' is computed on the server, and a document-form update takes constants. Write a constant ('${e.compare.split(" ").pop()}'), or use the pipeline form with the value's own method ('jsmql.pipeline("$.<field> = <value>.${e.method}();")'), which 'updateOne' accepts as well.`,
    ),
    expr: {
      byArgs: {
        constant: {
          args: { sig: "value", exact: 1, slotType: { 0: e.takes ?? ["string", "number"] } },
          emit: ({ args, construct }: ExprIn) => construct(e.spelling, e.refuseConstant, args[0]),
        },
        dynamic: convertsWith(e.spelling, e.method),
        otherwise: unsupported(`'${e.spelling}(…)' takes one constant.`),
      },
    },
    stream: unsupported(`'${e.spelling}' produces a value, not a stream of documents.`),
    statement: unsupported(`'${e.spelling}' produces a value. Use it inside a reshape or a '$set'.`),
    group: unsupported(`'${e.spelling}' is not an accumulator. Inside '$group' write the MongoDB operator.`),
    window: unsupported(
      `'${e.spelling}' is not a window function. Inside '$setWindowFields' write the MongoDB operator.`,
    ),
  });

const bsonSentinel = (spelling: string, doc: string, compare: string) =>
  global_({
    doc,
    token: "Ident",
    returns: spelling === "MinKey" ? "minKey" : "maxKey",
    neverNull: true,
    where: ["value"],
    filter: because(`${spelling}() is a value, not a test. Compare it: '${compare}'.`),
    expr: {
      byArgs: {
        none: {
          args: { sig: "", none: true },
          emit: ({ construct }: ExprIn) => construct(spelling, `'${spelling}()' builds the sentinel value.`),
        },
        otherwise: unsupported(`'${spelling}()' takes no argument.`),
      },
    },
    stream: unsupported(`'${spelling}' produces a value, not a stream of documents.`),
    statement: unsupported(`'${spelling}' produces a value. Use it inside a reshape or a '$set'.`),
    group: unsupported(`'${spelling}' is not an accumulator. Inside '$group' write the MongoDB operator.`),
    window: unsupported(
      `'${spelling}' is not a window function. Inside '$setWindowFields' write the MongoDB operator.`,
    ),
  });

export const TIME_UNIT = [
  "year",
  "quarter",
  "month",
  "week",
  "day",
  "hour",
  "minute",
  "second",
  "millisecond",
] as const;

const WINDOW_TIME_UNIT = ["week", "day", "hour", "minute", "second", "millisecond"] as const;

const WEEKDAY = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;

const sortStages = (ask: StageSortAsk, slot: () => string, reshape: (cb: Expr) => unknown): Stage[] => {
  if (ask.kind === "keys") return [{ $sort: ask.spec }];
  const key = slot();
  return [{ $addFields: { [key]: reshape(ask.key) } }, { $sort: { [key]: ask.dir } }];
};

const n = (e: Expr): number => (e.type === "NumberLiteral" ? e.value : 1);

const notOf = (e: Expr): Expr => ({ type: "UnaryExpr", op: "!", argument: e, pos: e.pos });
const callOf = (recv: Expr, name: string, args: readonly Expr[]): Expr => ({
  type: "MethodCall",
  object: recv,
  name,
  args,
  optional: false,
  pos: recv.pos,
});
const identOf = (name: string, pos: number): Expr => ({ type: "Ident", name, pos });
const listOf = (list: Expr): Expr => {
  if (list.type === "ArrayLiteral") return list;
  const empty: Expr = { type: "ArrayLiteral", elements: [], pos: list.pos };
  const orEmpty: Expr = { type: "BinaryExpr", op: "??", left: list, right: empty, pos: list.pos };
  return {
    type: "ArrayLiteral",
    elements: [{ type: "SpreadElement", argument: orEmpty, pos: list.pos }],
    pos: list.pos,
  };
};
const arrowOf = (param: string, body: Expr, pos: number): Expr => ({ type: "Lambda", params: [param], body, pos });

const keepFirstPer = (key: unknown): Stage[] =>
  key === "$$ROOT"
    ? [{ $group: carriesRoot({ _id: "$$ROOT" }) }, { $replaceWith: "$_id" }]
    : [{ $group: { _id: key, [GROUP_SLOT]: carriesRoot({ $first: "$$ROOT" }) } }, { $replaceWith: `$${GROUP_SLOT}` }];

const collapse = (key: unknown, acc: Record<string, unknown>): Stage[] => [
  { $group: { _id: key, [GROUP_SLOT]: acc } },
  {
    $group: {
      _id: null,
      [GROUP_SLOT]: { $push: { k: { $ifNull: [{ $toString: "$_id" }, "null"] }, v: `$${GROUP_SLOT}` } },
    },
  },
  { $replaceWith: { $arrayToObject: `$${GROUP_SLOT}` } },
];

function padded(
  side: "start" | "end" | "both",
  recv: unknown,
  args: readonly Expr[],
  value: (e: Expr) => unknown,
  bind: (hint: string) => Minted,
): unknown {
  const length = value(args[0]) as number;
  const pad = args.length === 2 ? value(args[1]) : " ";
  const v = bind("pad");
  const atStart = { $concat: [pad, "$$value"] };
  const atEnd = { $concat: ["$$value", pad] };
  const step =
    side === "start"
      ? atStart
      : side === "end"
        ? atEnd
        : { $cond: [{ $mod: ["$$this", 2] }, ...(length % 2 === 1 ? [atEnd, atStart] : [atStart, atEnd])] };
  const input = { $range: [length, { $strLenCP: v.ref }, -1] };
  return { $let: { vars: { [v.as]: recv }, in: { $reduce: { input, initialValue: v.ref, in: step } } } };
}

function identity(bind: (hint: string) => Minted): { as: string; ref: string; in: unknown } {
  const x = bind("x");
  return { as: x.as, ref: x.ref, in: x.ref };
}

const fieldClause = ({ name, args, pathOf, literalOf }: FilterIn): QueryDoc | null => {
  const path = pathOf(args[0]);
  const value = literalOf(args[1]);
  return path === null || value === null ? null : { [path]: { [name]: value.value } };
};

const queryOnlyClause = ({ name, args, fieldPath, literal }: FilterIn): QueryDoc => ({
  [fieldPath(args[0])]: { [name]: literal(args[1]) },
});

const logicalList = ({ name, args, query }: FilterIn): QueryDoc | null => {
  const list = args.length === 1 && args[0].type === "ArrayLiteral" ? args[0].elements.filter(isExprNode) : args;
  if (list.length === 0) return null;
  return { [name]: list.map(query) };
};
const isExprNode = (e: { type: string }): e is Expr => e.type !== "SpreadElement";

const arrayOrEmpty = (recv: unknown): unknown => {
  if (Array.isArray(recv)) return recv;
  const inner = isIfNullWrapped(recv) ? (recv as { $ifNull: unknown[] }).$ifNull : null;
  if (inner !== null && inner.length === 2 && inner[1] === null) return { $ifNull: [inner[0], []] };
  return { $ifNull: [recv, []] };
};

const listArgument = (value: ExprIn["value"], type: ExprIn["type"], arg: Expr): unknown => {
  const lowered = value(arg);
  return type(arg).absent ? arrayOrEmpty(lowered) : lowered;
};

const mayBeArray = (t: Type): boolean => t.kinds === "any" || t.kinds.has("array");
const onlyArray = (t: Type): boolean => t.kinds !== "any" && t.kinds.size === 1 && t.kinds.has("array");
const arrayOrOne = (ref: unknown): unknown => ({ $cond: [{ $isArray: ref }, ref, [ref]] });

function concatOperand(v: unknown, t: Type, bind: ExprIn["bind"]): unknown {
  if (!mayBeArray(t)) return [v];
  if (onlyArray(t)) return t.absent ? { $ifNull: [v, [null]] } : v;
  if (typeof v === "string" && v.startsWith("$")) return arrayOrOne(v);
  const item = bind("item");
  return { $let: { vars: { [item.as]: v }, in: arrayOrOne(item.ref) } };
}

function concatSpread(list: unknown, element: Type | undefined): unknown {
  if (element !== undefined && !mayBeArray(element)) return list;
  const each = element !== undefined && onlyArray(element) && !element.absent ? "$$this" : arrayOrOne("$$this");
  return { $reduce: { input: list, initialValue: [], in: { $concatArrays: ["$$value", each] } } };
}

const lastIndexOfArray = ({ recv, args, value, bind }: ExprIn): unknown => {
  const needle = value(args[0]);
  const arr = bind("arr");
  const rev = bind("revIdx");
  const size = sizeOf(arrayOrEmpty(arr.ref));
  return {
    $let: {
      vars: { [arr.as]: recv },
      in: {
        $let: {
          vars: { [rev.as]: { $indexOfArray: [reverseArrayOf(arr.ref), needle] } },
          in: cond({ $eq: [rev.ref, -1] }, -1, { $subtract: [{ $subtract: [size, 1] }, rev.ref] }),
        },
      },
    },
  };
};

const pairsOfObject = (recv: unknown, present: boolean): unknown => ({
  $objectToArray: present ? recv : { $ifNull: [recv, {}] },
});

function merged(recv: unknown, args: readonly Expr[], value: (e: Expr) => unknown): unknown {
  const list = args.length === 1 && args[0].type === "ArrayLiteral" && args[0].packed === true ? args[0] : null;
  const empty = isPlainObject(recv) && Object.keys(recv).length === 0;
  if (list === null) return { $mergeObjects: empty && args.length > 1 ? args.map(value) : [recv, ...args.map(value)] };
  if (empty && list.elements.length === 1 && list.elements[0].type === "SpreadElement") {
    return { $mergeObjects: value(list) };
  }
  const { packed: _packed, ...plain } = list;
  const sources = value(plain);
  if (empty) return { $mergeObjects: sources };
  const parts = isPlainObject(sources) && Object.keys(sources).length === 1 ? sources.$concatArrays : undefined;
  return { $mergeObjects: { $concatArrays: [[recv], ...(Array.isArray(parts) ? parts : [sources])] } };
}

const pairsRead = (obj: unknown, project: (ref: string) => unknown): unknown => ({
  $map: { input: { $objectToArray: obj }, in: project("$$this") },
});

const matchesEmpty = (pattern: string, flags: string): boolean =>
  new RegExp(
    pattern.replace(/\\[AzZG]|\\.|\[(?:\\.|[^\]\\])*\]/g, (m) => (/^\\[AzZG]$/.test(m) ? "(?:)" : m)),
    flags,
  ).test("");

const nullOr = (recv: unknown, present: boolean, bind: ExprIn["bind"], body: (r: unknown) => unknown): unknown => {
  if (present) return body(recv);
  const cheap = typeof recv === "string" && recv.startsWith("$");
  const bound = cheap ? null : bind("recv");
  const ref = bound === null ? recv : bound.ref;
  const doc = cond(isNullish(ref), null, body(ref));
  return bound === null ? doc : { $let: { vars: { [bound.as]: recv }, in: doc } };
};

const spelledKeys = (e: Expr): string[] | null =>
  e.type === "ArrayLiteral" && e.elements.every((el) => el.type === "StringLiteral")
    ? e.elements.map((el) => (el as Extract<Expr, { type: "StringLiteral" }>).value)
    : null;

const safeOfBounds = (kind: ExprIn["kind"], bounds: readonly Expr[]): 0 | Date =>
  bounds.some((b) => kind(b) === "date") ? new Date(0) : 0;

const safeBound = (recv: unknown, present: boolean, safe: 0 | Date, sameAsNull: boolean): unknown =>
  present || sameAsNull ? recv : { $ifNull: [recv, safe] };

const LOGICAL: ReadonlySet<string> = new Set(["$and", "$or", "$nor"]);

const overFields = (q: unknown): boolean =>
  isPlainObject(q) &&
  Object.entries(q).every(
    ([k, v]) => !k.startsWith("$") || (LOGICAL.has(k) && Array.isArray(v) && v.every(overFields)),
  );

const mayHold = (safe: 0 | Date, lo: unknown, hi: unknown): boolean => {
  const bounds = orderedBounds(lo, hi);
  if (bounds === null) return true;
  if (isDate(safe) !== isDate(bounds[0])) return false;
  return (bounds[0] as number) <= (safe as unknown as number) && (safe as unknown as number) < (bounds[1] as number);
};

const orderedBounds = (a: unknown, b: unknown): readonly [unknown, unknown] | null => {
  if (typeof a === "number" && typeof b === "number") return a <= b ? [a, b] : [b, a];
  if (isDate(a) && isDate(b)) return a <= b ? [a, b] : [b, a];
  return null;
};

const norList = (input: FilterIn): QueryDoc => logicalList(input) ?? { $nor: [] };

function groupedByKey(
  input: unknown,
  it: { as: string; ref: string; in: unknown },
  bind: (hint: string) => Minted,
): Record<string, unknown> {
  const key = bind("key");
  const filtered = { $filter: { input, as: it.as, cond: { $eq: [stringKeyExpr(it.in), key.ref] } } };
  return {
    $arrayToObject: { $map: { input: distinctKeysExpr(input, it), as: key.as, in: { k: key.ref, v: filtered } } },
  };
}

function invertedByKey(
  pairs: unknown,
  it: { as: string; ref: string; in: unknown },
  bind: (hint: string) => Minted,
): Record<string, unknown> {
  const kv = bind("kv");
  const entries = bind("entries");
  const key = bind("key");
  const value = `${kv.ref}.v`;
  const path = typeof it.in === "string" && (it.in === it.ref || it.in.startsWith(`${it.ref}.`));
  const keyOf = path
    ? value + (it.in as string).slice(it.ref.length)
    : { $let: { vars: { [it.as]: value }, in: it.in } };
  const keysOf = { $filter: { input: entries.ref, cond: { $eq: ["$$this.k", key.ref] } } };
  return {
    $let: {
      vars: { [entries.as]: { $map: { input: pairs, as: kv.as, in: { k: stringKeyExpr(keyOf), v: `${kv.ref}.k` } } } },
      in: {
        $arrayToObject: {
          $map: {
            input: { $setUnion: [`${entries.ref}.k`, []] },
            as: key.as,
            in: { k: key.ref, v: { $map: { input: keysOf, in: "$$this.v" } } },
          },
        },
      },
    },
  };
}

const orZero = (v: unknown, there: boolean): unknown =>
  v === null ? 0 : typeof v === "number" || there ? v : { $ifNull: [v, 0] };

function randomOf({ recv, args, value, bind, present }: ExprIn): unknown {
  const self = orZero(recv, present);
  const [a, b] = args.length === 0 ? [0, self] : [self, orZero(value(args[0]), false)];
  const from = (lo: unknown, step: unknown): unknown => (lo === 0 ? step : { $add: [lo, step] });
  const whole = (lo: unknown, span: unknown): unknown => from(lo, { $floor: { $multiply: [{ $rand: {} }, span] } });
  const fraction = (lo: unknown, span: unknown): unknown => from(lo, { $multiply: [{ $rand: {} }, span] });
  if (typeof a === "number" && typeof b === "number") {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return Number.isInteger(lo) && Number.isInteger(hi) ? whole(lo, hi - lo + 1) : fraction(lo, hi - lo);
  }
  const lo = bind("lo");
  const hi = bind("hi");
  const span = { $subtract: [hi.ref, lo.ref] };
  const isWhole = (ref: string): unknown => ({ $eq: [ref, { $trunc: ref }] });
  const fixed = [a, b].some((v) => typeof v === "number" && !Number.isInteger(v));
  const body = fixed
    ? fraction(lo.ref, span)
    : {
        $cond: [
          { $and: [isWhole(lo.ref), isWhole(hi.ref)] },
          whole(lo.ref, { $add: [span, 1] }),
          fraction(lo.ref, span),
        ],
      };
  return { $let: { vars: { [lo.as]: { $min: [a, b] }, [hi.as]: { $max: [a, b] } }, in: body } };
}

const ORDER_BY_ARGS: Arity = {
  sig: "keys[, orders] | { field: dir }",
  allowed: [1, 2],
  slotType: { 0: ["string", "array", "object", "callback"], 1: ["string", "number", "array"] },
  slotHint: { 1: ' Write 1, -1, "asc" or "desc", or a list of them.' },
};

const RANGE_ARGS: Arity = {
  sig: "[end[, step]]",
  allowed: [0, 1, 2],
  integer: [-1, 0, 1],
  slotType: { 0: "int", 1: "int" },
  zeroRefused: { 1: "For the start value n times, write 'n.range().map(() => start)'." },
};

function rangeOf({ recv, args, value, bind, present }: ExprIn): unknown {
  const self = orZero(recv, present);
  const [start, end] = args.length === 0 ? [0, self] : [self, orZero(value(args[0]), false)];
  if (args.length === 2) return { $range: [start, end, value(args[1])] };
  if (typeof start === "number" && typeof end === "number") {
    return start > end ? { $range: [start, end, -1] } : { $range: [start, end] };
  }
  const cheap = (v: unknown): boolean => typeof v === "number" || isIfNullWrappedPath(v) || isPath(v);
  const vars: Record<string, unknown> = {};
  const once = (v: unknown, hint: string): unknown => {
    if (cheap(v)) return v;
    const b = bind(hint);
    vars[b.as] = v;
    return b.ref;
  };
  const [s, e] = [once(start, "start"), once(end, "end")];
  const out = { $range: [s, e, { $cond: [{ $lt: [s, e] }, 1, -1] }] };
  return Object.keys(vars).length === 0 ? out : { $let: { vars, in: out } };
}

const isPath = (v: unknown): boolean => typeof v === "string" && v.startsWith("$");
const isIfNullWrappedPath = (v: unknown): boolean => {
  const n = (v as { $ifNull?: unknown } | null)?.$ifNull;
  return Array.isArray(n) && n.length === 2 && isPath(n[0]) && n[1] === 0;
};

const fromIsNotJsmql = unsupported(
  "'Array.from(…)' is not part of jsmql. For a range of indices write 'n.range()'. For a value per index, write 'n.range().map(i => …)'. To build an array from one you already have, call '.map(…)' on that array.",
);

const afterStringMethod = (method: string): string =>
  ` If a string method gives the value, write the '?.' right after the field: '$.x?.trim().${method}()'. A dot reads a missing string as "", and the server cannot convert "".`;

const stringIsNotJsmql = unsupported(
  "'String(x)' is not part of JSMQL — the value's own method says the same thing, and one capability gets one spelling. Write '<value>?.toString()': '$.x?.toString()'. In a callback, write 'x => x.toString()'.",
);
const numberIsNotJsmql = unsupported(
  "'Number(x)' is not part of JSMQL — the value's own method says the same thing, and one capability gets one spelling. Write '<value>?.toDouble()': '$.x?.toDouble()'. In a callback, write 'x => x.toDouble()'." +
    afterStringMethod("toDouble"),
);
const booleanIsNotJsmql = unsupported(
  "'Boolean(x)' is not part of JSMQL — it is the truthiness of JavaScript, which '!!' says too, and one capability gets one spelling. Write '!!<value>': '!!$.x'. In a callback, write 'x => !!x'. For '.filter(Boolean)', write '.compact()'.",
);
const parseIntIsNotJsmql = unsupported(
  "'parseInt()' is not part of JSMQL — '.toDouble()' is its numeric conversion. JavaScript reads a RADIX from parseInt's second argument, so '.map(parseInt)' hands the element index to it and answers [1, NaN, NaN] for [\"1\", \"2\", \"3\"]; and MongoDB's '$toInt' refuses a fractional string outright, so parseInt's truncation has no MQL form either. Write '<value>.toDouble()', or '<value>.toDouble().trunc()' for the whole number." +
    afterStringMethod("toDouble"),
);
const parseFloatIsNotJsmql = unsupported(
  "'parseFloat()' is not part of JSMQL — '.toDouble()' is its numeric conversion. The two differ on a value with trailing text (JavaScript's parseFloat(\"12abc\") is 12, Number(\"12abc\") is NaN), and MEASURED on the server '$toDouble' refuses \"12abc\" outright, so parseFloat's reading has no MQL form. Write '<value>.toDouble()'." +
    afterStringMethod("toDouble"),
);
const convertsWith = (spelling: string, method: string, also = ""): Refusal =>
  unsupported(
    `'${spelling}(x)' converts a value of the document, and the value's own method says the same thing: one capability gets one spelling. Write '<value>.${method}()': '$.x.${method}()'. In a callback, write 'x => x.${method}()'.` +
      afterStringMethod(method) +
      also,
  );

const MILLIS_TO_DATE =
  " For a number of milliseconds, write '$.x.toLong().toDate()': the server cannot convert an int to a date.";

const setIsNotJsmql = unsupported(
  "'new Set(…)' is not part of JSMQL, because MongoDB has no set type. An array method does each set operation: '<array>.uniq()' for the unique values, '.uniq().size()' for their count, '.has(x)', '.union(other)', '.intersection(other)', '.difference(other)' and '.xor(other)'.",
);

const mapIsNotJsmql = unsupported(
  "'new Map(…)' is not part of JSMQL, because MongoDB has no map type. For keys and values write an object ('{ a: 1 }'), or build one from pairs ('<pairs>.fromEntries()').",
);

const regExpIsNotJsmql = unsupported(
  "'RegExp(…)' is not part of JSMQL. Write a regular expression literal ('/^ab/i'). For a pattern built at run time, write '$regexMatch({ input: …, regex: … })'.",
);

const NO_IS_FINITE = unsupported(
  "Number.isFinite($.x) is not supported: jsmql has no syntax for an Infinity or NaN literal to compare against. Three ways round it: check the BSON type with '$type($.x)' and reject the \"double\" values you know to be non-finite at the source; substitute a sentinel with '$op($convert, { input: $.x, to: \"double\", onError: 0 })'; or constrain to a known range ('$.x > -1e300 && $.x < 1e300') where the domain allows it.",
);

const NO_POW = unsupported(
  "'Math.pow(base, exponent)' and '.pow(exponent)' are not part of JSMQL — the operator '**' says the same thing, and one capability gets one spelling. Write 'base ** exponent': '$.n ** 2'.",
);

const MEMBERSHIP_IN_AN_ARRAY = "For membership in an array, write '.has(x)'.";

export const NAMES = {
  $abs: mongo({
    doc: "Returns the absolute value of a number.",
    category: "arithmetic",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $add: mongo({
    doc: "Adds numbers to return the sum, or adds numbers and a date to return a new date.",
    category: "arithmetic",
    returns: "unknown",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "operands", atLeast: 1 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $ceil: mongo({
    doc: "Returns the smallest integer greater than or equal to the specified number.",
    category: "arithmetic",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $divide: mongo({
    doc: "Divides the first number by the second, and returns the result.",
    category: "arithmetic",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: {
      args: { sig: "dividend, divisor", exact: 2 },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
  }),

  $exp: mongo({
    doc: "Raises e to the specified exponent.",
    category: "arithmetic",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $floor: mongo({
    doc: "Returns the largest integer less than or equal to the specified number.",
    category: "arithmetic",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $ln: mongo({
    doc: "Calculates the natural log of a number.",
    category: "arithmetic",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $log: mongo({
    doc: "Calculates the log of a number in the specified base.",
    category: "arithmetic",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "number, base", exact: 2 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $log10: mongo({
    doc: "Calculates the log base 10 of a number.",
    category: "arithmetic",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $mod: mongo({
    doc: "Returns the remainder of the first number divided by the second.",
    category: "arithmetic",
    returns: "number",
    neverNull: true,
    where: ["value", "filter"],
    shape: "array",
    filter: { args: { sig: "field, [divisor, remainder]", exact: 2 }, emit: fieldClause },
    expr: {
      args: { sig: "dividend, divisor", exact: 2 },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
  }),

  $multiply: mongo({
    doc: "Multiplies numbers to return the product.",
    category: "arithmetic",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "operands", atLeast: 1 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $pow: mongo({
    doc: "Raises a number to the specified exponent.",
    category: "arithmetic",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "base, exponent", exact: 2 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $round: mongo({
    doc: "Rounds a number to a whole integer or to a specified decimal place.",
    category: "arithmetic",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "flex",
    filter: viaFallback,
    expr: {
      args: { sig: "number[, place]", allowed: [1, 2] },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
  }),

  $sigmoid: mongo({
    doc: "Returns the sigmoid of a value, defined as 1 / (1 + e^(-x)). The result is between 0 and 1.",
    category: "arithmetic",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $sqrt: mongo({
    doc: "Calculates the square root.",
    category: "arithmetic",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $subtract: mongo({
    doc: "Subtracts the second value from the first, and returns the result.",
    category: "arithmetic",
    returns: "unknown",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: {
      args: { sig: "minuend, subtrahend", exact: 2 },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
  }),

  $trunc: mongo({
    doc: "Truncates a number to a whole integer or to a specified decimal place.",
    category: "arithmetic",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "flex",
    filter: viaFallback,
    expr: {
      args: { sig: "number[, place]", allowed: [1, 2] },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
  }),

  $bitAnd: mongo({
    doc: "Returns the result of a bitwise AND operation on an array of int or long values.",
    category: "bitwise",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "operands", atLeast: 1 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $bitNot: mongo({
    doc: "Returns the result of a bitwise NOT operation on a single int or long value.",
    category: "bitwise",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $bitOr: mongo({
    doc: "Returns the result of a bitwise OR operation on an array of int or long values.",
    category: "bitwise",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "operands", atLeast: 1 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $bitXor: mongo({
    doc: "Returns the result of a bitwise XOR (exclusive or) operation on an array of int and long values.",
    category: "bitwise",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "operands", atLeast: 1 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $sin: mongo({
    doc: "Returns the sine of a value that is measured in radians.",
    category: "trigonometry",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $cos: mongo({
    doc: "Returns the cosine of a value that is measured in radians.",
    category: "trigonometry",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $tan: mongo({
    doc: "Returns the tangent of a value that is measured in radians.",
    category: "trigonometry",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $asin: mongo({
    doc: "Returns the inverse sine (arc sine) of a value in radians.",
    category: "trigonometry",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $acos: mongo({
    doc: "Returns the inverse cosine (arc cosine) of a value in radians.",
    category: "trigonometry",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $atan: mongo({
    doc: "Returns the inverse tangent (arc tangent) of a value in radians.",
    category: "trigonometry",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $atan2: mongo({
    doc: "Returns the inverse tangent of y / x in radians, where y and x are the first and second arguments.",
    category: "trigonometry",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "y, x", exact: 2 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $sinh: mongo({
    doc: "Returns the hyperbolic sine of a value measured in radians.",
    category: "trigonometry",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $cosh: mongo({
    doc: "Returns the hyperbolic cosine of a value measured in radians.",
    category: "trigonometry",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $tanh: mongo({
    doc: "Returns the hyperbolic tangent of a value measured in radians.",
    category: "trigonometry",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $asinh: mongo({
    doc: "Returns the inverse hyperbolic sine of a value in radians.",
    category: "trigonometry",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $acosh: mongo({
    doc: "Returns the inverse hyperbolic cosine of a value in radians.",
    category: "trigonometry",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $atanh: mongo({
    doc: "Returns the inverse hyperbolic tangent of a value in radians.",
    category: "trigonometry",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $degreesToRadians: mongo({
    doc: "Converts a value from degrees to radians.",
    category: "trigonometry",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $radiansToDegrees: mongo({
    doc: "Converts a value from radians to degrees.",
    category: "trigonometry",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $cmp: mongo({
    doc: "Returns 0 if the two values are equivalent, 1 if the first is greater, and -1 if less.",
    category: "comparison",
    returns: "number",
    neverNull: "always",
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "expr1, expr2", exact: 2 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $eq: mongo({
    doc: "Returns true if the values are equivalent.",
    category: "comparison",
    returns: "bool",
    neverNull: "always",
    where: ["value", "filter"],
    liftsTo: { op: "$eq" },
    shape: "flex",
    filter: { args: { sig: "field, value", exact: 2 }, emit: fieldClause },
    expr: {
      args: { sig: "expr1, expr2", exact: 2 },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
  }),

  $ne: mongo({
    doc: "Returns true if the values are not equivalent.",
    category: "comparison",
    returns: "bool",
    neverNull: "always",
    where: ["value", "filter"],
    liftsTo: { op: "$ne" },
    shape: "flex",
    filter: { args: { sig: "field, value", exact: 2 }, emit: fieldClause },
    expr: {
      args: { sig: "expr1, expr2", exact: 2 },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
  }),

  $gt: mongo({
    doc: "Returns true if the first value is greater than the second.",
    category: "comparison",
    returns: "bool",
    neverNull: "always",
    where: ["value", "filter"],
    liftsTo: { op: "$gt" },
    shape: "flex",
    filter: { args: { sig: "field, value", exact: 2 }, emit: fieldClause },
    expr: {
      args: { sig: "expr1, expr2", exact: 2 },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
  }),

  $gte: mongo({
    doc: "Returns true if the first value is greater than or equal to the second.",
    category: "comparison",
    returns: "bool",
    neverNull: "always",
    where: ["value", "filter"],
    liftsTo: { op: "$gte" },
    shape: "flex",
    filter: { args: { sig: "field, value", exact: 2 }, emit: fieldClause },
    expr: {
      args: { sig: "expr1, expr2", exact: 2 },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
  }),

  $lt: mongo({
    doc: "Returns true if the first value is less than the second.",
    category: "comparison",
    returns: "bool",
    neverNull: "always",
    where: ["value", "filter"],
    liftsTo: { op: "$lt" },
    shape: "flex",
    filter: { args: { sig: "field, value", exact: 2 }, emit: fieldClause },
    expr: {
      args: { sig: "expr1, expr2", exact: 2 },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
  }),

  $lte: mongo({
    doc: "Returns true if the first value is less than or equal to the second.",
    category: "comparison",
    returns: "bool",
    neverNull: "always",
    where: ["value", "filter"],
    liftsTo: { op: "$lte" },
    shape: "flex",
    filter: { args: { sig: "field, value", exact: 2 }, emit: fieldClause },
    expr: {
      args: { sig: "expr1, expr2", exact: 2 },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
  }),

  $and: mongo({
    doc: "Returns true only when all its expressions evaluate to true.",
    category: "boolean",
    returns: "bool",
    neverNull: "always",
    where: ["value", "filter"],
    shape: "array",
    filter: { args: { sig: "predicates", atLeast: 1 }, emit: logicalList },
    expr: { args: { sig: "operands", atLeast: 1 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $or: mongo({
    doc: "Returns true when any of its expressions evaluates to true.",
    category: "boolean",
    returns: "bool",
    neverNull: "always",
    where: ["value", "filter"],
    shape: "array",
    filter: { args: { sig: "predicates", atLeast: 1 }, emit: logicalList },
    expr: { args: { sig: "operands", atLeast: 1 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $not: mongo({
    doc: "Returns the boolean value that is the opposite of its argument expression.",
    category: "boolean",
    returns: "bool",
    neverNull: "always",
    where: ["value", "filter"],
    shape: "single",
    filter: {
      args: { sig: "predicate", exact: 1 },
      emit: ({ args, nativeQuery }) => {
        const q = nativeQuery(args[0]);
        if (q === null) return null;
        const keys = Object.keys(q);
        if (keys.length !== 1 || keys[0].startsWith("$")) return null;
        const clause = q[keys[0]];
        if (clause === null || typeof clause !== "object" || Array.isArray(clause)) return null;
        const ops = Object.keys(clause);
        if (ops.length !== 1 || !ops[0].startsWith("$") || ops[0] === "$not") return null;
        return { [keys[0]]: { $not: clause } };
      },
    },
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $cond: mongo({
    doc: "A ternary operator that evaluates one expression and returns one of two other expressions based on the result.",
    category: "conditional",
    returns: "unknown",
    where: ["value"],
    keys: ["if", "then", "else"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "if, then, else", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $ifNull: mongo({
    doc: "Returns either the non-null result of the first expression or the result of the second expression.",
    category: "conditional",
    returns: "unknown",
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: {
      args: { sig: "expr, replacement[, …]", atLeast: 2 },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
  }),

  $switch: mongo({
    doc: "Evaluates a series of case expressions. It executes the expression of the case that matches, and then stops.",
    category: "conditional",
    returns: "unknown",
    where: ["value"],
    keys: ["branches", "default"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "branches, default", allowed: [1, 2] }, emit: objectBody },
  }),

  $concat: mongo({
    doc: "Concatenates any number of strings.",
    category: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "operands", atLeast: 1 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $indexOfBytes: mongo({
    doc: "Searches a string for a substring and returns the UTF-8 byte index of the first occurrence, or -1.",
    category: "string",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: {
      args: { sig: "string, substring[, start[, end]]", allowed: [2, 3, 4] },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
  }),

  $indexOfCP: mongo({
    doc: "Searches a string for a substring and returns the UTF-8 code point index of the first occurrence, or -1.",
    category: "string",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: {
      args: { sig: "string, substring[, start[, end]]", allowed: [2, 3, 4] },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
  }),

  $ltrim: mongo({
    doc: "Removes whitespace or the specified characters from the start of a string.",
    category: "string",
    returns: "string",
    where: ["value"],
    keys: ["input", "chars"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, chars", allowed: [1, 2] }, emit: objectBody },
  }),

  $rtrim: mongo({
    doc: "Removes whitespace or the specified characters from the end of a string.",
    category: "string",
    returns: "string",
    where: ["value"],
    keys: ["input", "chars"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, chars", allowed: [1, 2] }, emit: objectBody },
  }),

  $trim: mongo({
    doc: "Removes whitespace or the specified characters from the start and end of a string.",
    category: "string",
    returns: "string",
    where: ["value"],
    keys: ["input", "chars"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, chars", allowed: [1, 2] }, emit: objectBody },
  }),

  $regexFind: mongo({
    doc: "Applies a regular expression to a string and returns information on the first matched substring.",
    category: "string",
    returns: "object",
    where: ["value"],
    keys: ["input", "regex", "options"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, regex, options", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $regexFindAll: mongo({
    doc: "Applies a regular expression to a string and returns information on all matched substrings.",
    category: "string",
    returns: { arrayOf: "object" },
    neverNull: "always",
    where: ["value"],
    keys: ["input", "regex", "options"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, regex, options", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $regexMatch: mongo({
    doc: "Applies a regular expression to a string, and returns a boolean that tells whether it finds a match.",
    category: "string",
    returns: "bool",
    neverNull: "always",
    where: ["value"],
    keys: ["input", "regex", "options"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, regex, options", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $replaceAll: mongo({
    doc: "Replaces all instances of a search string in an input string with a replacement string.",
    category: "string",
    returns: "string",
    where: ["value"],
    keys: ["input", "find", "replacement"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, find, replacement", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $replaceOne: mongo({
    doc: "Replaces the first instance of a matched string in a given input.",
    category: "string",
    returns: "string",
    where: ["value"],
    keys: ["input", "find", "replacement"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, find, replacement", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $split: mongo({
    doc: "Splits a string into substrings based on a delimiter and returns an array of substrings.",
    category: "string",
    returns: { arrayOf: "string" },
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: {
      args: { sig: "string, delimiter", exact: 2 },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
  }),

  $strLenBytes: mongo({
    doc: "Returns the number of UTF-8 encoded bytes in a string.",
    category: "string",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $strLenCP: mongo({
    doc: "Returns the number of UTF-8 code points in a string.",
    category: "string",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $strcasecmp: mongo({
    doc: "Performs case-insensitive string comparison.",
    category: "string",
    returns: "number",
    neverNull: "always",
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "expr1, expr2", exact: 2 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $substr: mongo({
    doc: "Deprecated. Use $substrBytes or $substrCP.",
    category: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: {
      args: { sig: "string, start, length", exact: 3 },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
  }),

  $substrBytes: mongo({
    doc: "Returns the substring of a string that starts at the specified UTF-8 byte index.",
    category: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: {
      args: { sig: "string, byteIndex, byteCount", exact: 3 },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
  }),

  $substrCP: mongo({
    doc: "Returns the substring of a string that starts at the specified UTF-8 code point index.",
    category: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: {
      args: { sig: "string, cpIndex, cpCount", exact: 3 },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
  }),

  $toLower: mongo({
    doc: "Converts a string to lowercase.",
    category: "string",
    returns: "string",
    neverNull: "always",
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $toUpper: mongo({
    doc: "Converts a string to uppercase.",
    category: "string",
    returns: "string",
    neverNull: "always",
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $encStrContains: mongo({
    doc: "Returns true if a substring exists within the encrypted string.",
    category: "encrypted-string",
    returns: "bool",
    where: ["value"],
    keys: ["input", "substring"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, substring", allowed: [1, 2] }, emit: objectBody },
  }),

  $encStrEndsWith: mongo({
    doc: "Returns true if the encrypted string ends with the specified suffix.",
    category: "encrypted-string",
    returns: "bool",
    where: ["value"],
    keys: ["input", "suffix"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, suffix", allowed: [1, 2] }, emit: objectBody },
  }),

  $encStrNormalizedEq: mongo({
    doc: "Returns true if the normalized encrypted string equals the specified string.",
    category: "encrypted-string",
    returns: "bool",
    where: ["value"],
    keys: ["input", "string"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, string", allowed: [1, 2] }, emit: objectBody },
  }),

  $encStrStartsWith: mongo({
    doc: "Returns true if the encrypted string starts with the specified prefix.",
    category: "encrypted-string",
    returns: "bool",
    where: ["value"],
    keys: ["input", "prefix"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, prefix", allowed: [1, 2] }, emit: objectBody },
  }),

  $arrayElemAt: mongo({
    doc: "Returns the element at the specified array index.",
    category: "array",
    returns: "unknown",
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "array, index", exact: 2 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $arrayToObject: mongo({
    doc: "Converts an array of key-value pairs to a document.",
    category: "array",
    returns: "object",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $concatArrays: mongo({
    doc: "Concatenates arrays to return the concatenated array.",
    category: "array",
    returns: "array",
    neverNull: true,
    where: ["value", "group", "window"],
    spreadAlternative: "use array spread ([...a, ...b]) or .concat()",
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "operands", atLeast: 1 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
    group: { args: { sig: "operand", exact: 1 }, emit: single },
    window: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $filter: mongo({
    doc: "Selects a subset of the array. It returns only the elements that match the filter condition.",
    category: "array",
    binds: { valueAt: "as", default: "this", visibleIn: ["cond"] },
    returns: "array",
    where: ["value"],
    keys: ["input", "as", "cond", "limit"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, as, cond, limit", allowed: [1, 2, 3, 4] }, emit: objectBody },
  }),

  $first: mongo({
    doc: "Returns the result of an expression for the first document in an array.",
    category: "array",
    returns: "unknown",
    where: ["value", "group", "window"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
    group: { args: { sig: "operand", exact: 1 }, emit: single },
    window: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $firstN: mongo({
    doc: "Returns a specified number of elements from the start of an array.",
    category: "array",
    returns: "array",
    where: ["value", "group", "window"],
    keys: ["input", "n"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, n", allowed: [1, 2] }, emit: objectBody },
    group: { args: { sig: "input, n", allowed: [1, 2] }, emit: objectBody },
    window: { args: { sig: "input, n", allowed: [1, 2] }, emit: objectBody },
  }),

  $in: mongo({
    doc: "Returns a boolean that tells whether a specified value is in an array.",
    category: "array",
    returns: "bool",
    neverNull: true,
    where: ["value", "filter"],
    liftsTo: { op: "$in" },
    shape: "flex",
    filter: { args: { sig: "field, value", exact: 2 }, emit: fieldClause },
    expr: {
      args: { sig: "operands", atLeast: 1 },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
  }),

  $indexOfArray: mongo({
    doc: "Searches an array for a value and returns the index of the first occurrence, or -1.",
    category: "array",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: {
      args: { sig: "array, value[, start[, end]]", allowed: [2, 3, 4] },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
  }),

  $isArray: mongo({
    doc: "Determines if the operand is an array.",
    category: "array",
    returns: "bool",
    neverNull: "always",
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $last: mongo({
    doc: "Returns the result of an expression for the last document in an array.",
    category: "array",
    returns: "unknown",
    where: ["value", "group", "window"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
    group: { args: { sig: "operand", exact: 1 }, emit: single },
    window: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $lastN: mongo({
    doc: "Returns a specified number of elements from the end of an array.",
    category: "array",
    returns: "array",
    where: ["value", "group", "window"],
    keys: ["input", "n"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, n", allowed: [1, 2] }, emit: objectBody },
    group: { args: { sig: "input, n", allowed: [1, 2] }, emit: objectBody },
    window: { args: { sig: "input, n", allowed: [1, 2] }, emit: objectBody },
  }),

  $map: mongo({
    doc: "Applies a subexpression to each element of an array, and returns the array of the values it gives.",
    category: "array",
    binds: { valueAt: "as", default: "this", visibleIn: ["in"] },
    returns: "array",
    where: ["value"],
    keys: ["input", "as", "in"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, as, in", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $maxN: mongo({
    doc: "Returns the n largest values in an array.",
    category: "array",
    returns: "array",
    where: ["value", "group", "window"],
    keys: ["input", "n"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, n", allowed: [1, 2] }, emit: objectBody },
    group: { args: { sig: "input, n", allowed: [1, 2] }, emit: objectBody },
    window: { args: { sig: "input, n", allowed: [1, 2] }, emit: objectBody },
  }),

  $minN: mongo({
    doc: "Returns the n smallest values in an array.",
    category: "array",
    returns: "array",
    where: ["value", "group", "window"],
    keys: ["input", "n"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, n", allowed: [1, 2] }, emit: objectBody },
    group: { args: { sig: "input, n", allowed: [1, 2] }, emit: objectBody },
    window: { args: { sig: "input, n", allowed: [1, 2] }, emit: objectBody },
  }),

  $objectToArray: mongo({
    doc: "Converts a document to an array of documents. Each one holds a key-value pair.",
    category: "array",
    returns: { arrayOf: "object" },
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $range: mongo({
    doc: "Outputs an array that holds a sequence of integers, as the inputs specify.",
    category: "array",
    returns: { arrayOf: "number" },
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: {
      args: { sig: "start, end[, step]", allowed: [2, 3] },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
  }),

  $reduce: mongo({
    doc: "Applies an expression to each element in an array and combines them into a single value.",
    category: "array",
    binds: { fixed: ["this", "value"], visibleIn: ["in"] },
    returns: "unknown",
    where: ["value"],
    keys: ["input", "initialValue", "in"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, initialValue, in", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $reverseArray: mongo({
    doc: "Returns an array with the elements in reverse order.",
    category: "array",
    returns: "array",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $size: mongo({
    doc: "Returns the number of elements in the array.",
    category: "array",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $slice: mongo({
    doc: "Returns a subset of an array.",
    category: "array",
    returns: "array",
    neverNull: true,
    where: ["value", "updateDoc"],
    onlyInside: { updateDoc: ["$push"] },
    shape: "array",
    filter: viaFallback,
    expr: {
      args: { sig: "array, [position, ]count", allowed: [2, 3] },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
    updateDoc: { args: { sig: "count", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $sortArray: mongo({
    doc: "Sorts the elements of an array.",
    category: "array",
    returns: "array",
    where: ["value"],
    keys: ["input", "sortBy"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, sortBy", allowed: [1, 2] }, emit: objectBody },
  }),

  $zip: mongo({
    doc: "Merges two or more arrays element-wise into a single array of arrays.",
    category: "array",
    returns: { arrayOf: "array" },
    where: ["value"],
    keys: ["inputs", "useLongestLength", "defaults"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "inputs, useLongestLength, defaults", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $allElementsTrue: mongo({
    doc: "Returns true if no element of a set evaluates to false.",
    category: "set",
    returns: "bool",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $anyElementTrue: mongo({
    doc: "Returns true if any elements of a set evaluate to true.",
    category: "set",
    returns: "bool",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $setDifference: mongo({
    doc: "Returns a set with elements that appear in the first set but not in the second set.",
    category: "set",
    returns: "array",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "set1, set2", exact: 2 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $setEquals: mongo({
    doc: "Returns true if the input sets have the same distinct elements.",
    category: "set",
    returns: "bool",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: {
      args: { sig: "set1, set2[, …]", atLeast: 2 },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
  }),

  $setIntersection: mongo({
    doc: "Returns a set with elements that appear in all of the input sets.",
    category: "set",
    returns: "array",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "operands", atLeast: 1 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $setIsSubset: mongo({
    doc: "Returns true if all elements of the first set appear in the second set.",
    category: "set",
    returns: "bool",
    neverNull: true,
    where: ["value"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "set1, set2", exact: 2 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
  }),

  $setUnion: mongo({
    doc: "Returns a set with elements that appear in any of the input sets.",
    category: "set",
    returns: "array",
    neverNull: true,
    where: ["value", "group", "window"],
    shape: "array",
    filter: viaFallback,
    expr: { args: { sig: "operands", atLeast: 1 }, emit: ({ name, args, value }) => ({ [name]: args.map(value) }) },
    group: { args: { sig: "operand", exact: 1 }, emit: single },
    window: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $getField: mongo({
    doc: "Returns the value of a specified field from a document. This includes a field whose name contains a period or starts with $.",
    category: "object",
    returns: "unknown",
    where: ["value"],
    keys: ["field", "input"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "field, input", allowed: [1, 2] }, emit: objectBody },
  }),

  $mergeObjects: mongo({
    doc: "Combines multiple documents into a single document.",
    category: "object",
    returns: "object",
    neverNull: "always",
    where: ["value", "group"],
    spreadAlternative: "use object spread ({ ...a, ...b }) or ({}).assign(...docs)",
    shape: "flex",
    filter: viaFallback,
    expr: {
      args: { sig: "operands", atLeast: 1 },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
    group: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $setField: mongo({
    doc: "Adds, updates, or removes a specified field in a document.",
    category: "object",
    returns: "object",
    where: ["value"],
    keys: ["field", "input", "value"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "field, input, value", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $unsetField: mongo({
    doc: "Removes a specified field from a document. Alias for $setField with $$REMOVE.",
    category: "object",
    returns: "object",
    where: ["value"],
    keys: ["field", "input"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "field, input", allowed: [1, 2] }, emit: objectBody },
  }),

  $dateAdd: mongo({
    doc: "Adds a number of time units to a date object.",
    category: "date",
    returns: "date",
    where: ["value"],
    keys: ["startDate", "unit", "amount", "timezone"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "startDate, unit, amount, timezone", allowed: [1, 2, 3, 4] }, emit: objectBody },
  }),

  $dateDiff: mongo({
    doc: "Returns the difference between two dates.",
    category: "date",
    returns: "number",
    where: ["value"],
    keys: ["startDate", "endDate", "unit", "startOfWeek", "timezone"],
    shape: "object",
    filter: viaFallback,
    expr: {
      args: { sig: "startDate, endDate, unit, startOfWeek, timezone", allowed: [1, 2, 3, 4, 5] },
      emit: objectBody,
    },
  }),

  $dateFromParts: mongo({
    doc: "Constructs a BSON Date object given the date's constituent parts.",
    category: "date",
    returns: "date",
    where: ["value"],
    keys: ["year", "month", "day", "hour", "minute", "second", "millisecond", "timezone"],
    shape: "object",
    filter: viaFallback,
    expr: {
      args: { sig: "year, month, day, hour, minute, second, millisecond, timezone", allowed: [1, 2, 3, 4, 5, 6, 7, 8] },
      emit: objectBody,
    },
  }),

  $dateFromString: mongo({
    doc: "Converts a date/time string to a date object.",
    category: "date",
    returns: "date",
    where: ["value"],
    keys: ["dateString", "format", "timezone", "onError", "onNull"],
    shape: "object",
    filter: viaFallback,
    expr: {
      args: { sig: "dateString, format, timezone, onError, onNull", allowed: [1, 2, 3, 4, 5] },
      emit: objectBody,
    },
  }),

  $dateSubtract: mongo({
    doc: "Subtracts a number of time units from a date object.",
    category: "date",
    returns: "date",
    where: ["value"],
    keys: ["startDate", "unit", "amount", "timezone"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "startDate, unit, amount, timezone", allowed: [1, 2, 3, 4] }, emit: objectBody },
  }),

  $dateToParts: mongo({
    doc: "Returns a document that holds the constituent parts of a date.",
    category: "date",
    returns: "object",
    where: ["value"],
    keys: ["date", "timezone", "iso8601"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "date, timezone, iso8601", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $dateToString: mongo({
    doc: "Returns the date as a formatted string.",
    category: "date",
    returns: "string",
    where: ["value"],
    keys: ["date", "format", "timezone", "onNull"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "date, format, timezone, onNull", allowed: [1, 2, 3, 4] }, emit: objectBody },
  }),

  $dateTrunc: mongo({
    doc: "Truncates a date.",
    category: "date",
    returns: "date",
    where: ["value"],
    keys: ["date", "unit", "binSize", "timezone", "startOfWeek"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "date, unit, binSize, timezone, startOfWeek", allowed: [1, 2, 3, 4, 5] }, emit: objectBody },
  }),

  $dayOfMonth: mongo({
    doc: "Returns the day of the month for a date as a number between 1 and 31.",
    category: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $dayOfWeek: mongo({
    doc: "Returns the day of the week for a date as a number between 1 (Sunday) and 7 (Saturday).",
    category: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $dayOfYear: mongo({
    doc: "Returns the day of the year for a date as a number between 1 and 366.",
    category: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $hour: mongo({
    doc: "Returns the hour for a date as a number between 0 and 23.",
    category: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $isoDayOfWeek: mongo({
    doc: "Returns the weekday number in ISO 8601 format, from 1 (Monday) to 7 (Sunday).",
    category: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $isoWeek: mongo({
    doc: "Returns the week number in ISO 8601 format, from 1 to 53.",
    category: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $isoWeekYear: mongo({
    doc: "Returns the year number in ISO 8601 format.",
    category: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $millisecond: mongo({
    doc: "Returns the milliseconds of a date as a number between 0 and 999.",
    category: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $minute: mongo({
    doc: "Returns the minute for a date as a number between 0 and 59.",
    category: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $month: mongo({
    doc: "Returns the month for a date as a number between 1 (January) and 12 (December).",
    category: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $second: mongo({
    doc: "Returns the seconds for a date as a number between 0 and 60 (leap seconds).",
    category: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $toDate: mongo({
    doc: "Converts a value to a Date.",
    category: "date",
    returns: "date",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $week: mongo({
    doc: "Returns the week number for a date as a number between 0 and 53.",
    category: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $year: mongo({
    doc: "Returns the year for a date as a number.",
    category: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $tsIncrement: mongo({
    doc: "Returns the increment ordinal from a timestamp as a long.",
    category: "timestamp",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $tsSecond: mongo({
    doc: "Returns the seconds from a timestamp as a long.",
    category: "timestamp",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $convert: mongo({
    doc: "Converts a value to a specified type.",
    category: "type",
    returns: "unknown",
    where: ["value"],
    keys: ["input", "to", "onError", "onNull"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, to, onError, onNull", allowed: [1, 2, 3, 4] }, emit: objectBody },
  }),

  $isNumber: mongo({
    doc: "Returns true if the expression resolves to an integer, decimal, double, or long.",
    category: "type",
    returns: "bool",
    neverNull: "always",
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $toArray: mongo({
    doc: "Converts a value to an array.",
    category: "type",
    returns: "array",
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $toBool: mongo({
    doc: "Converts a value to a boolean.",
    category: "type",
    returns: "bool",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $toDecimal: mongo({
    doc: "Converts a value to a Decimal128.",
    category: "type",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $toDouble: mongo({
    doc: "Converts a value to a double.",
    category: "type",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $toInt: mongo({
    doc: "Converts a value to an integer.",
    category: "type",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $toLong: mongo({
    doc: "Converts a value to a long.",
    category: "type",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $toObject: mongo({
    doc: "Converts a string to an object.",
    category: "type",
    returns: "object",
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $toObjectId: mongo({
    doc: "Converts a value to an ObjectId.",
    category: "type",
    returns: "objectId",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $toString: mongo({
    doc: "Converts a value to a string.",
    category: "type",
    returns: "string",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $toUUID: mongo({
    doc: "Converts a string to a UUID.",
    category: "type",
    returns: "binData",
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $type: mongo({
    doc: "Returns the BSON data type of the field.",
    category: "type",
    returns: "string",
    neverNull: "always",
    where: ["value", "filter"],
    shape: "single",
    filter: { args: { sig: "field, type", exact: 2 }, emit: fieldClause },
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $literal: mongo({
    doc: "Returns a value, and does not parse it. Use it for a value that the pipeline would otherwise interpret as an expression (for example a string that starts with $).",
    category: "literal",
    returns: "unknown",
    where: ["value"],
    shape: "verbatim",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $let: mongo({
    doc: "Defines variables for use within the scope of a subexpression and returns the result.",
    category: "variable",
    params: ["binding"],
    binds: { keysOf: "vars", visibleIn: ["in"] },
    returns: "unknown",
    where: ["value"],
    keys: ["vars", "in"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "vars, in", allowed: [1, 2] }, emit: objectBody },
  }),

  $accumulator: mongo({
    doc: "Defines a custom accumulator function. Body fields hold JavaScript source executed by the server.",
    category: "custom-aggregation",
    returns: "unknown",
    where: ["group"],
    keys: ["init", "initArgs", "accumulate", "accumulateArgs", "merge", "finalize", "lang"],
    shape: "object",
    group: {
      args: {
        sig: "init, initArgs, accumulate, accumulateArgs, merge, finalize, lang",
        allowed: [1, 2, 3, 4, 5, 6, 7],
      },
      emit: objectBody,
    },
  }),

  $function: mongo({
    doc: "Defines a custom function. The body field is JavaScript source executed by the server.",
    category: "custom-aggregation",
    returns: "unknown",
    where: ["value"],
    keys: ["body", "args", "lang"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "body, args, lang", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $binarySize: mongo({
    doc: "Returns the size of a string or binary data value's content in bytes.",
    category: "data-size",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $bsonSize: mongo({
    doc: "Returns the size in bytes of a document when encoded as BSON.",
    category: "data-size",
    returns: "number",
    neverNull: true,
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $meta: mongo({
    doc: 'Accesses per-document metadata related to the aggregation operation. The argument is a keyword string (for example "textScore"), not an arbitrary expression.',
    category: "text",
    returns: "unknown",
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $createObjectId: mongo({
    doc: "Returns a random ObjectId.",
    category: "miscellaneous",
    returns: "objectId",
    neverNull: "always",
    where: ["value"],
    shape: "none",
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ name }) => ({ [name]: {} }) },
  }),

  $hash: mongo({
    doc: "Generates a binary hash value (BinData) from a UTF-8 string or binary data.",
    category: "miscellaneous",
    returns: "binData",
    where: ["value"],
    keys: ["input", "algorithm"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, algorithm", allowed: [1, 2] }, emit: objectBody },
  }),

  $hexHash: mongo({
    doc: "Generates an uppercase hexadecimal hash string from a UTF-8 string or binary data.",
    category: "miscellaneous",
    returns: "string",
    where: ["value"],
    keys: ["input", "algorithm"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, algorithm", allowed: [1, 2] }, emit: objectBody },
  }),

  $rand: mongo({
    doc: "Returns a random float between 0 and 1.",
    category: "miscellaneous",
    returns: "number",
    neverNull: "always",
    where: ["value"],
    shape: "none",
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ name }) => ({ [name]: {} }) },
  }),

  $sampleRate: mongo({
    doc: "Randomly selects documents at a given rate. Used inside $match.",
    category: "miscellaneous",
    where: ["filter"],
    shape: "single",
    filter: { args: { sig: "rate", exact: 1 }, emit: ({ name, args, literal }) => ({ [name]: literal(args[0]) }) },
  }),

  $toHashedIndexKey: mongo({
    doc: "Computes the hash of the input expression with MongoDB's hashed-index hash function.",
    category: "miscellaneous",
    returns: "number",
    where: ["value"],
    shape: "single",
    filter: viaFallback,
    expr: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $addToSet: mongo({
    doc: "Returns an array of unique expression values for each group.",
    category: "array",
    returns: { arrayOf: { arg: 0 } },
    neverNull: true,
    where: ["group", "window", "updateDoc"],
    shape: "single",
    group: { args: { sig: "operand", exact: 1 }, emit: single },
    window: { args: { sig: "operand", exact: 1 }, emit: single },
    updateDoc: { args: { sig: "fields", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $avg: mongo({
    doc: "Returns the average for the specified expression.",
    category: "arithmetic",
    returns: "number",
    where: ["value", "group", "window"],
    shape: "flex",
    filter: viaFallback,
    expr: {
      args: { sig: "operands", atLeast: 1 },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
    group: { args: { sig: "operand", exact: 1 }, emit: single },
    window: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $count: mongo({
    doc: {
      operator: "Returns the number of documents in the group or window.",
      stage: "Returns a count of the number of documents at this stage of the aggregation pipeline.",
    },
    category: "array",
    returns: "number",
    document: "fields",
    evaluates: [],
    where: ["group", "window", "stream", "statement"],
    shape: "none",
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    group: { args: { sig: "", none: true }, emit: ({ name }) => ({ [name]: {} }) },
    window: { args: { sig: "", none: true }, emit: ({ name }) => ({ [name]: {} }) },
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $max: mongo({
    doc: "Applies an expression, and returns the maximum value of the results.",
    category: "comparison",
    returns: "unknown",
    where: ["value", "group", "window", "updateDoc"],
    spreadAlternative: "use the JS form [...arr].max() or arr.max()",
    shape: "flex",
    filter: viaFallback,
    expr: {
      args: { sig: "operands", atLeast: 1 },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
    group: { args: { sig: "operand", exact: 1 }, emit: single },
    window: { args: { sig: "operand", exact: 1 }, emit: single },
    updateDoc: { args: { sig: "fields", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $median: mongo({
    doc: "Returns an approximation of the median (50th percentile) as a scalar value.",
    category: "arithmetic",
    returns: "number",
    where: ["value", "group", "window"],
    keys: ["input", "method"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, method", allowed: [1, 2] }, emit: objectBody },
    group: { args: { sig: "input, method", allowed: [1, 2] }, emit: objectBody },
    window: { args: { sig: "input, method", allowed: [1, 2] }, emit: objectBody },
  }),

  $min: mongo({
    doc: "Applies an expression, and returns the minimum value of the results.",
    category: "comparison",
    returns: "unknown",
    where: ["value", "group", "window", "updateDoc"],
    spreadAlternative: "use the JS form [...arr].min() or arr.min()",
    shape: "flex",
    filter: viaFallback,
    expr: {
      args: { sig: "operands", atLeast: 1 },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
    group: { args: { sig: "operand", exact: 1 }, emit: single },
    window: { args: { sig: "operand", exact: 1 }, emit: single },
    updateDoc: { args: { sig: "fields", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $percentile: mongo({
    doc: "Returns an array of scalar values that correspond to specified percentile values.",
    category: "arithmetic",
    returns: "array",
    where: ["value", "group", "window"],
    keys: ["input", "p", "method"],
    shape: "object",
    filter: viaFallback,
    expr: { args: { sig: "input, p, method", allowed: [1, 2, 3] }, emit: objectBody },
    group: { args: { sig: "input, p, method", allowed: [1, 2, 3] }, emit: objectBody },
    window: { args: { sig: "input, p, method", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $push: mongo({
    doc: "Applies an expression, and returns an array of the results.",
    category: "array",
    returns: { arrayOf: { arg: 0 } },
    neverNull: true,
    where: ["group", "window", "updateDoc"],
    shape: "single",
    group: { args: { sig: "operand", exact: 1 }, emit: single },
    window: { args: { sig: "operand", exact: 1 }, emit: single },
    updateDoc: { args: { sig: "fields", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $stdDevPop: mongo({
    doc: "Calculates the population standard deviation of the input values.",
    category: "arithmetic",
    returns: "number",
    where: ["value", "group", "window"],
    shape: "flex",
    filter: viaFallback,
    expr: {
      args: { sig: "operands", atLeast: 1 },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
    group: { args: { sig: "operand", exact: 1 }, emit: single },
    window: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $stdDevSamp: mongo({
    doc: "Calculates the sample standard deviation of the input values.",
    category: "arithmetic",
    returns: "number",
    where: ["value", "group", "window"],
    shape: "flex",
    filter: viaFallback,
    expr: {
      args: { sig: "operands", atLeast: 1 },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
    group: { args: { sig: "operand", exact: 1 }, emit: single },
    window: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $sum: mongo({
    doc: "Returns a sum of numerical values. It ignores non-numeric values.",
    category: "arithmetic",
    returns: "number",
    neverNull: "always",
    where: ["value", "group", "window"],
    shape: "flex",
    filter: viaFallback,
    expr: {
      args: { sig: "operands", atLeast: 1 },
      emit: ({ name, args, value }) => ({ [name]: args.length === 1 ? value(args[0]) : args.map(value) }),
    },
    group: { args: { sig: "operand", exact: 1 }, emit: single },
    window: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $bottom: mongo({
    doc: "Returns the bottom element within a group, in the specified sort order.",
    category: "array",
    returns: "unknown",
    where: ["group", "window"],
    keys: ["output", "sortBy"],
    shape: "object",
    group: { args: { sig: "output, sortBy", allowed: [1, 2] }, emit: objectBody },
    window: { args: { sig: "output, sortBy", allowed: [1, 2] }, emit: objectBody },
  }),

  $bottomN: mongo({
    doc: "Returns an aggregation of the bottom n elements within a group, in the specified sort order.",
    category: "array",
    returns: "array",
    where: ["group", "window"],
    keys: ["output", "sortBy", "n"],
    shape: "object",
    group: { args: { sig: "output, sortBy, n", allowed: [1, 2, 3] }, emit: objectBody },
    window: { args: { sig: "output, sortBy, n", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $top: mongo({
    doc: "Returns the top element within a group, in the specified sort order.",
    category: "array",
    returns: "unknown",
    where: ["group", "window"],
    keys: ["output", "sortBy"],
    shape: "object",
    group: { args: { sig: "output, sortBy", allowed: [1, 2] }, emit: objectBody },
    window: { args: { sig: "output, sortBy", allowed: [1, 2] }, emit: objectBody },
  }),

  $topN: mongo({
    doc: "Returns an aggregation of the top n fields within a group, in the specified sort order.",
    category: "array",
    returns: "array",
    where: ["group", "window"],
    keys: ["output", "sortBy", "n"],
    shape: "object",
    group: { args: { sig: "output, sortBy, n", allowed: [1, 2, 3] }, emit: objectBody },
    window: { args: { sig: "output, sortBy, n", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $covariancePop: mongo({
    doc: "Returns the population covariance of two numeric expressions.",
    category: "window",
    returns: "number",
    where: ["window"],
    shape: "array",
    window: {
      args: { sig: "expression1, expression2", allowed: [1, 2, 3] },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
  }),

  $covarianceSamp: mongo({
    doc: "Returns the sample covariance of two numeric expressions.",
    category: "window",
    returns: "number",
    where: ["window"],
    shape: "array",
    window: {
      args: { sig: "expression1, expression2", allowed: [1, 2, 3] },
      emit: ({ name, args, value }) => ({ [name]: args.map(value) }),
    },
  }),

  $denseRank: mongo({
    doc: "Returns the document position (rank) within the partition. There are no gaps; ties receive the same rank.",
    category: "window",
    returns: "number",
    where: ["window"],
    shape: "none",
    window: { args: { sig: "", none: true }, emit: ({ name }) => ({ [name]: {} }) },
  }),

  $derivative: mongo({
    doc: "Returns the average rate of change within the specified window.",
    category: "window",
    returns: "number",
    where: ["window"],
    keys: ["input", "unit"],
    shape: "object",
    window: { args: { sig: "input, unit", allowed: [1, 2] }, emit: objectBody },
  }),

  $documentNumber: mongo({
    doc: "Returns the position of a document in the $setWindowFields partition. Ties produce different adjacent numbers.",
    category: "window",
    returns: "number",
    where: ["window"],
    shape: "none",
    window: { args: { sig: "", none: true }, emit: ({ name }) => ({ [name]: {} }) },
  }),

  $expMovingAvg: mongo({
    doc: "Returns the exponential moving average for the numeric expression.",
    category: "window",
    returns: "number",
    where: ["window"],
    keys: ["input", "N", "alpha"],
    shape: "object",
    window: { args: { sig: "input, N, alpha", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $integral: mongo({
    doc: "Returns the approximation of the area under a curve.",
    category: "window",
    returns: "number",
    where: ["window"],
    keys: ["input", "unit"],
    shape: "object",
    window: { args: { sig: "input, unit", allowed: [1, 2] }, emit: objectBody },
  }),

  $linearFill: mongo({
    doc: "Fills null and missing fields in a window with linear interpolation, from the field values around them.",
    category: "window",
    returns: "number",
    where: ["window"],
    shape: "single",
    window: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $locf: mongo({
    doc: "Last observation carried forward — sets null/missing fields in a window to the last non-null value.",
    category: "window",
    returns: "unknown",
    where: ["window"],
    shape: "single",
    window: { args: { sig: "operand", exact: 1 }, emit: single },
  }),

  $rank: mongo({
    doc: "Returns the document position (rank) within the $setWindowFields partition.",
    category: "window",
    returns: "number",
    where: ["window"],
    shape: "none",
    window: { args: { sig: "", none: true }, emit: ({ name }) => ({ [name]: {} }) },
  }),

  $shift: mongo({
    doc: "Returns the value from an expression applied to a document in a specified position relative to the current document.",
    category: "window",
    returns: "unknown",
    where: ["window"],
    keys: ["output", "by", "default"],
    shape: "object",
    window: { args: { sig: "output, by, default", allowed: [1, 2, 3] }, emit: objectBody },
  }),

  $addFields: mongo({
    doc: "Adds new fields to documents. Outputs documents that contain all the fields from the input documents and the new fields.",
    valueTwin: "$mergeObjects",
    where: ["stream", "statement"],
    preservesCount: true,
    only: ["update"],
    document: "keeps",
    evaluates: ["*"],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $bucket: mongo({
    doc: "Categorizes the input documents into groups, called buckets, from a specified expression and bucket boundaries.",
    where: ["stream", "statement"],
    // The output fields — `_id` and the buckets' `output` keys, or `_id` and `count` — are not
    // the body's keys, so no layout states them yet: the document is unknown after it. [DEF-038]
    document: "unknown",
    evaluates: ["groupBy", "default"],
    bodyPositions: { "": "value", "output.*": "group" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $bucketAuto: mongo({
    doc: "Categorizes the input documents into a specific number of groups, called buckets, from a specified expression. The server sets the bucket boundaries automatically, and tries to put an equal part of the documents into each bucket.",
    where: ["stream", "statement"],
    // The output fields — `_id` and the buckets' `output` keys, or `_id` and `count` — are not
    // the body's keys, so no layout states them yet: the document is unknown after it. [DEF-038]
    document: "unknown",
    evaluates: ["groupBy"],
    bodyPositions: { "": "value", "output.*": "group" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $changeStream: mongo({
    doc: "Returns a Change Stream cursor for the collection or database. This stage can only occur once in an aggregation pipeline and it must occur as the first stage.",
    where: ["stream", "statement"],
    only: ["stageFirst"],
    document: "unknown",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $changeStreamSplitLargeEvent: mongo({
    doc: "Splits large change stream events that exceed 16 MB into smaller fragments returned in a change stream cursor.",
    where: ["stream", "statement"],
    only: ["stageLast"],
    document: "unknown",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: ["$facet", "$lookup", "$unionWith"],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $collStats: mongo({
    doc: "Returns statistics about a collection or view.",
    where: ["stream", "statement"],
    diagnostic: { scope: "collection", options: true },
    only: ["stageFirst"],
    document: "unknown",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: ["$facet"],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $currentOp: mongo({
    doc: "Returns information on active or dormant operations, or both, for the MongoDB deployment.",
    where: ["stream", "statement"],
    diagnostic: { scope: "cluster", options: true },
    only: ["stageFirst"],
    document: "unknown",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $densify: mongo({
    doc: "Creates new documents in a sequence of documents where certain values in a field are missing.",
    where: ["stream", "statement"],
    document: "keeps",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $documents: mongo({
    doc: "Returns literal documents from input values.",
    where: ["stream", "statement"],
    only: ["stageFirst"],
    document: "unknown",
    evaluates: [""],
    bodyPositions: { "": "value" },
    forbiddenIn: ["$facet", "$lookup", "$unionWith"],
    placement: {
      container:
        "Append the documents to the stream instead ('$$.push({ a: 1 });'), or start the stream from them ('$$ = [{ a: 1 }, { a: 2 }];').",
    },
    stream: {
      args: { sig: "body", exact: 1, slotType: { 0: "array" }, arrayOf: { 0: "object" } },
      emit: ({ name, args, value }) => [{ [name]: value(args[0]) }],
    },
    statement: {
      args: { sig: "body", exact: 1, slotType: { 0: "array" }, arrayOf: { 0: "object" } },
      emit: ({ name, args, value }) => [{ [name]: value(args[0]) }],
    },
  }),

  $facet: mongo({
    doc: "Processes more than one aggregation pipeline within a single stage, on the same set of input documents. So one stage can give aggregations of the data across more than one dimension.",
    statementBody: "pipeline",
    where: ["stream", "statement"],
    document: "fields",
    evaluates: [],
    bodyPositions: { "": "value", "*": "statement" },
    forbiddenIn: ["$facet"],
    bansNested: ["$documents"],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $fill: mongo({
    doc: "Populates null and missing field values within documents.",
    where: ["stream", "statement"],
    document: "keeps",
    evaluates: ["partitionBy", "output.*.value"],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $geoNear: mongo({
    doc: "Returns an ordered stream of documents based on the proximity to a geospatial point. Incorporates the functionality of $match, $sort, and $limit for geospatial data.",
    where: ["stream", "statement"],
    only: ["stageFirst"],
    document: "keeps",
    evaluates: ["near"],
    bodyPositions: { "": "value", query: "filter" },
    forbiddenIn: ["$facet"],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $graphLookup: mongo({
    doc: "Performs a recursive search on a collection. Adds a new array field to each output document that contains the traversal results of the recursive search.",
    where: ["stream", "statement"],
    document: "keeps",
    evaluates: ["startWith"],
    bodyPositions: { "": "value", restrictSearchWithMatch: "filter" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $group: mongo({
    doc: "Groups input documents by a specified identifier expression and applies the accumulator expression(s), if specified, to each group.",
    where: ["stream", "statement"],
    document: "fields",
    evaluates: ["_id"],
    bodyPositions: { "": "value", "*": "group", _id: "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $indexStats: mongo({
    doc: "Returns statistics about the use of each index for the collection.",
    where: ["stream", "statement"],
    diagnostic: { scope: "collection", options: false },
    only: ["stageFirst"],
    document: "unknown",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: ["$facet"],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $limit: mongo({
    doc: "Passes the first n documents unmodified to the pipeline where n is the specified limit.",
    valueTwin: "$slice",
    where: ["stream", "statement"],
    document: "keeps",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $listLocalSessions: mongo({
    doc: "Lists all active sessions recently in use on the connected mongos or mongod instance.",
    where: ["stream", "statement"],
    diagnostic: { scope: "cluster", options: true },
    only: ["stageFirst"],
    document: "unknown",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: ["$facet"],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $listSampledQueries: mongo({
    doc: "Lists sampled queries for all collections or a specific collection.",
    where: ["stream", "statement"],
    diagnostic: { scope: "cluster", options: true },
    only: ["stageFirst"],
    document: "unknown",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $listSearchIndexes: mongo({
    doc: "Returns information about the Atlas Search indexes on a specified collection.",
    where: ["stream", "statement"],
    diagnostic: { scope: "collection", options: true },
    only: ["stageFirst"],
    document: "unknown",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $listSessions: mongo({
    doc: "Lists all sessions that were active long enough to propagate to the system.sessions collection.",
    where: ["stream", "statement"],
    diagnostic: { scope: "cluster", options: true },
    only: ["stageFirst"],
    document: "unknown",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $lookup: mongo({
    doc: "Performs a left outer join to another collection in the same database. It brings in documents from the joined collection for the next stages.",
    pipelineOver: "foreign",
    statementBody: "pipeline",
    where: ["stream", "statement"],
    preservesCount: true,
    document: "keeps",
    evaluates: ["let"],
    takesLet: true,
    bodyPositions: { "": "value", pipeline: "statement" },
    binds: { keysOf: "let", visibleIn: ["pipeline"] },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $match: mongo({
    doc: "Filters the document stream. Only the documents that match go unmodified into the next pipeline stage.",
    valueTwin: "$filter",
    where: ["stream", "statement"],
    document: "narrows",
    evaluates: [],
    bodyPositions: { "": "filter" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $merge: mongo({
    doc: "Writes the output documents of the aggregation pipeline to a collection. Must be the last stage in the pipeline.",
    statementBody: ["$addFields", "$set", "$project", "$unset", "$replaceRoot", "$replaceWith", "$fill"],
    where: ["stream", "statement"],
    only: ["stageLast"],
    document: "keeps",
    evaluates: ["let"],
    takesLet: true,
    bodyPositions: { "": "value", whenMatched: { list: "statement", otherwise: "value" } },
    forbiddenIn: ["$facet", "$lookup", "$unionWith"],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $out: mongo({
    doc: "Writes the output documents of the aggregation pipeline to a collection. Must be the last stage in the pipeline.",
    where: ["stream", "statement"],
    only: ["stageLast"],
    document: "keeps",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: ["$facet", "$lookup", "$unionWith"],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $planCacheStats: mongo({
    doc: "Returns plan cache information for a collection.",
    where: ["stream", "statement"],
    diagnostic: { scope: "collection", options: false },
    only: ["stageFirst"],
    document: "unknown",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: ["$facet"],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $project: mongo({
    doc: "Reshapes each document in the stream, for example it adds new fields or removes fields. For each input document, outputs one document.",
    valueTwin: "$getField",
    document: "projection",
    evaluates: ["*"],
    where: ["stream", "statement"],
    only: ["update"],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $rankFusion: mongo({
    doc: "Combines more than one pipeline with rank-based fusion, to create hybrid search results.",
    statementBody: "pipeline",
    where: ["stream", "statement"],
    only: ["stageFirst"],
    document: "unknown",
    evaluates: [],
    bodyPositions: { "": "value", "input.pipelines.*": "statement" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $redact: mongo({
    doc: "Reshapes each document in the stream. It restricts the content of each document from information stored in the documents themselves.",
    valueTwin: "$filter",
    where: ["stream", "statement"],
    document: "keeps",
    evaluates: [""],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $replaceRoot: mongo({
    doc: "Replaces a document with the specified embedded document. The operation replaces all the fields in the input document, and the _id field too.",
    where: ["stream", "statement"],
    document: "value",
    evaluates: ["newRoot"],
    only: ["update"],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $replaceWith: mongo({
    doc: "Replaces a document with the specified embedded document. The operation replaces all the fields in the input document, and the _id field too.",
    where: ["stream", "statement"],
    document: "value",
    evaluates: [""],
    only: ["update"],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $sample: mongo({
    doc: "Randomly selects the specified number of documents from its input.",
    where: ["stream", "statement"],
    document: "keeps",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $scoreFusion: mongo({
    doc: "Combines more than one pipeline with relative score fusion, to create hybrid search results.",
    statementBody: "pipeline",
    where: ["stream", "statement"],
    only: ["stageFirst"],
    document: "unknown",
    evaluates: ["combination.expression"],
    bodyPositions: { "": "value", "input.pipelines.*": "statement" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $search: mongo({
    doc: "Performs a full-text search of the field or fields in an Atlas collection.",
    where: ["stream", "statement"],
    only: ["stageFirst"],
    document: "keeps",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: ["$facet"],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $searchMeta: mongo({
    doc: "Returns different types of metadata result documents for the Atlas Search query against an Atlas collection.",
    where: ["stream", "statement"],
    only: ["stageFirst"],
    document: "unknown",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: ["$facet"],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $set: mongo({
    doc: "Adds new fields to documents. Outputs documents that contain all the fields from the input documents and the new fields.",
    valueTwin: "$mergeObjects",
    where: ["stream", "statement", "updateDoc"],
    preservesCount: true,
    only: ["update"],
    document: "keeps",
    evaluates: ["*"],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    updateDoc: { args: { sig: "fields", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $setWindowFields: mongo({
    doc: "Groups documents into windows and applies one or more operators to the documents in each window.",
    where: ["stream", "statement"],
    preservesCount: true,
    document: "keeps",
    evaluates: ["partitionBy"],
    bodyPositions: { "": "value", "output.*": "window" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $shardedDataDistribution: mongo({
    doc: "Provides data and size distribution information on sharded collections.",
    where: ["stream", "statement"],
    diagnostic: { scope: "cluster", options: false },
    only: ["stageFirst"],
    document: "unknown",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $skip: mongo({
    doc: "Skips the first n documents, where n is the specified skip number. It passes the other documents unmodified to the pipeline.",
    valueTwin: "$slice",
    where: ["stream", "statement"],
    document: "keeps",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $sort: mongo({
    doc: "Reorders the document stream by a specified sort key. Only the order changes; the documents remain unmodified.",
    valueTwin: "$sortArray",
    where: ["stream", "statement", "updateDoc"],
    preservesCount: true,
    onlyInside: { updateDoc: ["$push"] },
    document: "keeps",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    updateDoc: { args: { sig: "spec", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $sortByCount: mongo({
    doc: "Groups the input documents by the value of a specified expression, then computes the count of documents in each distinct group.",
    // The output fields — `_id` and the buckets' `output` keys, or `_id` and `count` — are not
    // the body's keys, so no layout states them yet: the document is unknown after it. [DEF-038]
    document: "unknown",
    evaluates: [""],
    where: ["stream", "statement"],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $unionWith: mongo({
    document: "unknown",
    evaluates: [],
    doc: "Performs a union of two collections; combines pipeline results from two collections into a single result set.",
    valueTwin: "$concatArrays",
    pipelineOver: "foreign",
    statementBody: "pipeline",
    where: ["stream", "statement"],
    bodyPositions: { "": "value", pipeline: "statement" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $unset: mongo({
    doc: "Removes or excludes fields from documents.",
    valueTwin: "$unsetField",
    where: ["stream", "statement", "updateDoc"],
    only: ["update"],
    document: "keeps",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    updateDoc: { args: { sig: "fields", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $unwind: mongo({
    doc: "Deconstructs an array field from the input documents to output a document for each element. Each output document replaces the array with an element value.",
    where: ["stream", "statement"],
    document: "element",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: [],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  $vectorSearch: mongo({
    doc: "Performs an ANN or ENN search on a vector in the specified field.",
    where: ["stream", "statement"],
    only: ["stageFirst"],
    document: "keeps",
    evaluates: [],
    bodyPositions: { "": "value" },
    forbiddenIn: ["$facet"],
    stream: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
    statement: { args: { sig: "body", exact: 1 }, emit: ({ name, args, value }) => [{ [name]: value(args[0]) }] },
  }),

  trim: name({
    doc: "'.trim()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $trim: { input: recv } }) },
    stream: unsupported("'.trim()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.trim()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.trim();'",
    ),
    group: unsupported("'.trim()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.trim()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  trimStart: name({
    doc: "'.trimStart()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $ltrim: { input: recv } }) },
    stream: unsupported("'.trimStart()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.trimStart()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.trimStart();'",
    ),
    group: unsupported("'.trimStart()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.trimStart()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  trimLeft: name({
    doc: "'.trimLeft()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $ltrim: { input: recv } }) },
    stream: unsupported("'.trimLeft()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.trimLeft()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.trimLeft();'",
    ),
    group: unsupported("'.trimLeft()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.trimLeft()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  trimEnd: name({
    doc: "'.trimEnd()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $rtrim: { input: recv } }) },
    stream: unsupported("'.trimEnd()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.trimEnd()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.trimEnd();'",
    ),
    group: unsupported("'.trimEnd()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.trimEnd()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  trimRight: name({
    doc: "'.trimRight()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $rtrim: { input: recv } }) },
    stream: unsupported("'.trimRight()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.trimRight()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.trimRight();'",
    ),
    group: unsupported("'.trimRight()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.trimRight()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  toLower: name({
    doc: "'.toLower()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, present, bind }) => nullOr(recv, present, bind, (r) => ({ $toLower: r })),
    },
    stream: unsupported("'.toLower()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.toLower()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.toLower();'",
    ),
    group: unsupported("'.toLower()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.toLower()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  toLowerCase: renamed({
    from: "toLowerCase",
    to: "toLower",
    reason: "the JSMQL spelling, as in lodash's '_.toLower' and MongoDB's '$toLower'",
    returns: "string",
  }),

  toUpper: name({
    doc: "'.toUpper()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, present, bind }) => nullOr(recv, present, bind, (r) => ({ $toUpper: r })),
    },
    stream: unsupported("'.toUpper()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.toUpper()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.toUpper();'",
    ),
    group: unsupported("'.toUpper()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.toUpper()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  toUpperCase: renamed({
    from: "toUpperCase",
    to: "toUpper",
    reason: "the JSMQL spelling, as in lodash's '_.toUpper' and MongoDB's '$toUpper'",
    returns: "string",
  }),

  substr: name({
    doc: "'.substr()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "start[, count]", allowed: [1, 2], slotType: { 0: "int", 1: "int" } },
      emit: ({ recv, args, value, present, bind }) =>
        nullOr(recv, present, bind, (r) => {
          const start = normaliseSliceIndex(args[0], value(args[0]), r, true);
          const count = args.length === 1 ? strLenOf(r, true) : clampNonNegativeIndex(args[1], value(args[1]));
          return { $substrCP: [substrOperand(r), start, count] };
        }),
    },
    stream: unsupported("'.substr()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.substr()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.substr();'",
    ),
    group: unsupported("'.substr()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.substr()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  substring: name({
    doc: "'.substring()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "start[, end]", allowed: [0, 1, 2], slotType: { 0: "int", 1: "int" } },
      emit: ({ recv, args, value, present, bind }) => {
        if (args.length === 0) return recv;
        return nullOr(recv, present, bind, (r) => {
          const start = clampNonNegativeIndex(args[0], value(args[0]));
          const end = args.length === 1 ? strLenOf(r, true) : clampNonNegativeIndex(args[1], value(args[1]));
          return { $substrCP: [substrOperand(r), start, clampNonNegative(foldedSubtract(end, start))] };
        });
      },
    },
    stream: unsupported("'.substring()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.substring()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.substring();'",
    ),
    group: unsupported("'.substring()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.substring()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  charAt: name({
    doc: "'.charAt()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "index", exact: 1, slotType: { 0: "int" } },
      emit: ({ recv, args, value, present, bind }) => {
        const lit = literalIndexValue(args[0]);
        if (lit !== null && lit < 0) return "";
        return nullOr(recv, present, bind, (r) => {
          if (lit !== null) return { $substrCP: [substrOperand(r), lit, 1] };
          const index = value(args[0]);
          return cond({ $lt: [index, 0] }, "", { $substrCP: [substrOperand(r), index, 1] });
        });
      },
    },
    stream: unsupported("'.charAt()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.charAt()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.charAt();'",
    ),
    group: unsupported("'.charAt()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.charAt()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  split: name({
    doc: "'.split()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "string",
    returns: { arrayOf: "string" },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "separator",
        exact: 1,
        slotType: { 0: "string" },
        nonEmpty: {
          0: {
            noun: "separator character",
            instead:
              "MongoDB cannot split a string into characters. For one character per element, write '$.<field>.length().range().map(i => $.<field>.charAt(i))'.",
          },
        },
      },
      emit: ({ recv, args, value }) => ({ $split: [recv, value(args[0])] }),
    },
    stream: unsupported("'.split()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.split()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.split();'",
    ),
    group: unsupported("'.split()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.split()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  startsWith: name({
    doc: "'.startsWith()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "bool",
    neverNull: true,
    where: ["value", "filter"],
    filter: {
      args: { sig: "searchString", exact: 1, slotType: { 0: "string" } },
      emit: ({ recv, args, pathOf, orMissing }) => {
        const path = recv === null ? null : pathOf(recv);
        const needle = args[0];
        if (path === null || needle.type !== "StringLiteral" || isFieldPathString(needle)) return null;
        const test = { $regex: new RegExp(`^${escapeForRegex(needle.value)}`) };
        return needle.value === "" ? orMissing(path, test) : queryOwnValue(path, test);
      },
    },
    expr: {
      args: { sig: "searchString", exact: 1, slotType: { 0: "string" } },
      emit: ({ recv, args, value, present, bind }) =>
        nullOr(recv, present, bind, (r) => ({ $eq: [{ $indexOfCP: [r, value(args[0])] }, 0] })),
    },
    stream: unsupported("'.startsWith()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.startsWith()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.startsWith();'",
    ),
    group: unsupported("'.startsWith()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.startsWith()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  endsWith: name({
    doc: "'.endsWith()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "bool",
    neverNull: true,
    where: ["value", "filter"],
    filter: {
      args: { sig: "searchString", exact: 1, slotType: { 0: "string" } },
      emit: ({ recv, args, pathOf, orMissing }) => {
        const path = recv === null ? null : pathOf(recv);
        const needle = args[0];
        if (path === null || needle.type !== "StringLiteral" || isFieldPathString(needle)) return null;
        const test = { $regex: new RegExp(`${escapeForRegex(needle.value)}\\z`) };
        return needle.value === "" ? orMissing(path, test) : queryOwnValue(path, test);
      },
    },
    expr: {
      args: { sig: "searchString", exact: 1, slotType: { 0: "string" } },
      emit: ({ recv, args, value, bind, present }) => {
        const needle = value(args[0]);
        const needleLen = strLenOf(needle);
        return nullOr(recv, present, bind, (r) => {
          const s = bind("str");
          return {
            $let: {
              vars: { [s.as]: r },
              in: {
                $eq: [
                  { $substrCP: [s.ref, clampNonNegative(foldedSubtract({ $strLenCP: s.ref }, needleLen)), needleLen] },
                  needle,
                ],
              },
            },
          };
        });
      },
    },
    stream: unsupported("'.endsWith()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.endsWith()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.endsWith();'",
    ),
    group: unsupported("'.endsWith()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.endsWith()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  replace: name({
    doc: "'.replace()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "find, replacement", exact: 2, slotType: { 0: "string", 1: "string" } },
      emit: ({ recv, args, value }) => ({
        $replaceOne: { input: recv, find: value(args[0]), replacement: value(args[1]) },
      }),
    },
    stream: unsupported("'.replace()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.replace()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.replace();'",
    ),
    group: unsupported("'.replace()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.replace()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  replaceAll: name({
    doc: "'.replaceAll()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "find, replacement", exact: 2, slotType: { 0: "string", 1: "string" } },
      emit: ({ recv, args, value }) => ({
        $replaceAll: { input: recv, find: value(args[0]), replacement: value(args[1]) },
      }),
    },
    stream: unsupported("'.replaceAll()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.replaceAll()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.replaceAll();'",
    ),
    group: unsupported("'.replaceAll()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.replaceAll()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  match: name({
    doc: "'.match()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "bool",
    where: ["value", "filter"],
    filter: {
      args: { sig: "regexp", exact: 1, slotType: { 0: "regex" } },
      emit: ({ recv, args, pathOf, literal, orMissing }) => {
        const path = recv === null ? null : pathOf(recv);
        const re = args[0];
        if (path === null || re.type !== "RegexLiteral") return null;
        const test = { $regex: literal(re) };
        return matchesEmpty(re.pattern, re.flags) ? orMissing(path, test) : queryOwnValue(path, test);
      },
    },
    expr: {
      args: { sig: "regex", exact: 1, slotType: { 0: "regex" } },
      emit: ({ recv, args, value, present, bind }) =>
        nullOr(recv, present, bind, (r) => ({ $regexMatch: regexBody(r, args[0], () => value(args[0])) })),
    },
    stream: unsupported("'.match()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.match()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.match();'",
    ),
    group: unsupported("'.match()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.match()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  matchAll: name({
    doc: "'.matchAll()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "unknown",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "regex", exact: 1, regexFlag: { 0: "g" }, slotType: { 0: "regex" } },
      emit: ({ recv, args, value, present, bind }) =>
        nullOr(recv, present, bind, (r) => ({ $regexFindAll: regexBody(r, args[0], () => value(args[0])) })),
    },
    stream: unsupported("'.matchAll()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.matchAll()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.matchAll();'",
    ),
    group: unsupported("'.matchAll()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.matchAll()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  search: name({
    doc: "'.search()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "regex", exact: 1, slotType: { 0: "regex" } },
      emit: ({ recv, args, value, present, bind }) =>
        nullOr(recv, present, bind, (r) => ({
          $ifNull: [
            { $getField: { field: "idx", input: { $regexFind: regexBody(r, args[0], () => value(args[0])) } } },
            -1,
          ],
        })),
    },
    stream: unsupported("'.search()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.search()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.search();'",
    ),
    group: unsupported("'.search()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.search()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  padStart: name({
    doc: "'.padStart()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "targetLength[, padString]",
        allowed: [1, 2],
        constant: [0, 1],
        slotType: { 0: "int", 1: "string" },
        slotRange: { 0: [1, Number.MAX_SAFE_INTEGER] },
        oneChar: [1],
      },
      emit: ({ recv, args, value, bind, present }) =>
        nullOr(recv, present, bind, (r) => padded("start", r, args, value, bind)),
    },
    stream: unsupported("'.padStart()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.padStart()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.padStart();'",
    ),
    group: unsupported("'.padStart()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.padStart()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  padEnd: name({
    doc: "'.padEnd()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "targetLength[, padString]",
        allowed: [1, 2],
        constant: [0, 1],
        slotType: { 0: "int", 1: "string" },
        slotRange: { 0: [1, Number.MAX_SAFE_INTEGER] },
        oneChar: [1],
      },
      emit: ({ recv, args, value, bind, present }) =>
        nullOr(recv, present, bind, (r) => padded("end", r, args, value, bind)),
    },
    stream: unsupported("'.padEnd()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.padEnd()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.padEnd();'",
    ),
    group: unsupported("'.padEnd()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.padEnd()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  pad: name({
    doc: "'.pad()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "length[, pad]",
        allowed: [1, 2],
        constant: [0, 1],
        slotType: { 0: "int", 1: "string" },
        slotRange: { 0: [1, Number.MAX_SAFE_INTEGER] },
        oneChar: [1],
      },
      emit: ({ recv, args, value, bind, present }) =>
        nullOr(recv, present, bind, (r) => padded("both", r, args, value, bind)),
    },
    stream: unsupported("'.pad()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.pad()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.pad();'",
    ),
    group: unsupported("'.pad()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.pad()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  repeat: name({
    doc: "'.repeat()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "count", exact: 1, slotType: { 0: "int" } },
      emit: ({ recv, args, value }) => ({
        $reduce: { input: { $range: [0, value(args[0])] }, initialValue: "", in: { $concat: ["$$value", recv] } },
      }),
    },
    stream: unsupported("'.repeat()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.repeat()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.repeat();'",
    ),
    group: unsupported("'.repeat()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.repeat()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  indexOf: name({
    doc: "'.indexOf()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    sibling: { string: "For the position of a substring, write '.indexOfSubstring(searchString)'." },
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "searchValue",
        exact: 1,
        slotType: { 0: "element" },
        noCallback: {
          0: "'.indexOf()' searches for a VALUE, not by a function. To test elements against a predicate write '.findIndex(x => …)'.",
        },
      },
      emit: ({ recv, args, value }) => ({ $indexOfArray: [recv, value(args[0])] }),
    },
    stream: unsupported("'.indexOf()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.indexOf()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.indexOf();'",
    ),
    group: unsupported("'.indexOf()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.indexOf()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  indexOfSubstring: name({
    doc: "'.indexOfSubstring()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "string",
    sibling: { array: "For the position of a value in an array, write '.indexOf(value)'." },
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "searchString[, position]", allowed: [1, 2], slotType: { 0: "string", 1: "int" } },
      emit: ({ recv, args, value }) => {
        const start = args.length === 2 ? literalIndexValue(args[1]) : 0;
        if (start !== null && start <= 0) return { $indexOfCP: [recv, value(args[0])] };
        return { $indexOfCP: [recv, value(args[0]), start ?? clampNonNegativeIndex(args[1], value(args[1]))] };
      },
    },
    stream: unsupported("'.indexOfSubstring()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.indexOfSubstring()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.indexOfSubstring();'",
    ),
    group: unsupported("'.indexOfSubstring()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.indexOfSubstring()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  includes: name({
    doc: "'.includes()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    sibling: { array: MEMBERSHIP_IN_AN_ARRAY },
    returns: "bool",
    neverNull: true,
    where: ["value", "filter"],
    filter: {
      args: { sig: "searchString", exact: 1, slotType: { 0: "string" }, slotHint: { 0: ` ${MEMBERSHIP_IN_AN_ARRAY}` } },
      emit: ({ recv, args, pathOf, orMissing }) => {
        const path = recv === null ? null : pathOf(recv);
        const needle = args[0];
        if (path === null || needle.type !== "StringLiteral" || isFieldPathString(needle)) return null;
        const test = { $regex: new RegExp(escapeForRegex(needle.value)) };
        return needle.value === "" ? orMissing(path, test) : queryOwnValue(path, test);
      },
    },
    expr: {
      args: {
        sig: "searchString",
        exact: 1,
        slotType: { 0: "string" },
        slotHint: { 0: ` ${MEMBERSHIP_IN_AN_ARRAY}` },
        noCallback: {
          0: "'.includes()' searches for a STRING, not by a function. To test the elements of an array against a predicate write '.some(x => …)'.",
        },
      },
      emit: ({ recv, args, value, present, bind }) =>
        nullOr(recv, present, bind, (r) => ({ $gte: [{ $indexOfCP: [r, value(args[0])] }, 0] })),
    },
    stream: unsupported("'.includes()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.includes()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.includes();'",
    ),
    group: unsupported("'.includes()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.includes()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  has: name({
    doc: "'.has()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    sibling: { string: "For a substring test, write '.includes(x)'." },
    returns: "bool",
    neverNull: "always",
    where: ["value", "filter"],
    filter: {
      args: { sig: "value", exact: 1, slotType: { 0: "element" } },
      emit: ({ recv, args, pathOf, constant }) => {
        if (recv === null) return null;
        const path = pathOf(recv);
        if (path !== null) {
          const c = constant(args[0]);
          if (c === null) return null;
          if (c.value === null) return queryOwnValue(path, { $elemMatch: { $eq: null } });
          return queryOwnValue(path, { $eq: c.value });
        }
        if (recv.type !== "ArrayLiteral") return null;
        const target = pathOf(args[0]);
        if (target === null) return null;
        const values: unknown[] = [];
        for (const el of recv.elements) {
          const c =
            el.type === "SpreadElement" ||
            el.type === "FuncDecl" ||
            el.type === "AssignExpr" ||
            el.type === "DeleteStmt" ||
            el.type === "UpdateFilter"
              ? null
              : constant(el);
          if (c === null) return null;
          values.push(c.value);
        }
        return queryAmong(target, values);
      },
    },
    expr: {
      args: {
        sig: "value",
        exact: 1,
        slotType: { 0: "element" },
        noCallback: {
          0: "'.has()' searches for a VALUE, not by a function. To test elements against a predicate write '.some(x => …)'.",
        },
      },
      emit: ({ recv, args, value, present, bind }) =>
        nullOr(recv, present, bind, (r) => ({ $in: [value(args[0]), r] })),
    },
    stream: unsupported("'.has()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.has()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.has();'",
    ),
    group: unsupported("'.has()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.has()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  at: name({
    doc: "'.at()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    sibling: { string: "For one character, write '.charAt(index)'." },
    returns: "element",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "index", exact: 1, slotType: { 0: "int" } },
      emit: ({ recv, args, value }) => ({ $arrayElemAt: [recv, args[0] === undefined ? 0 : value(args[0])] }),
    },
    stream: unsupported("'.at()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.at()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.at();'",
    ),
    group: unsupported("'.at()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.at()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  slice: name({
    doc: "'.slice()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    sibling: { string: "For a part of a string, write '.substring(start, end)'." },
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      perFamily: {
        stream: unsupported(
          "'.slice()' on '$$' is a chain of stages, not a value: write it as a statement ('$$.slice(…);').",
        ),
        array: {
          args: { sig: "start[, end]", allowed: [0, 1, 2], slotType: { 0: "int", 1: "int" } },
          emit: ({ recv, args, value, bind, present }) =>
            nullOr(recv, present, bind, (r) => sliceArray(r, args, value, bind)),
        },
      },
    },
    stream: {
      args: {
        sig: "start[, end]",
        allowed: [1, 2],
        slotType: { 0: "int", 1: "int" },
        constant: [0, 1],
        slotRange: { 0: [0, Number.MAX_SAFE_INTEGER], 1: [0, Number.MAX_SAFE_INTEGER] },
      },
      emit: ({ args }) => {
        const start = n(args[0]);
        const stages: Stage[] = start === 0 ? [] : [{ $skip: start }];
        if (args.length === 2) {
          const length = n(args[1]) - start;
          stages.push(length <= 0 ? { $match: { $expr: false } } : { $limit: length });
        }
        return stages;
      },
    },
    statement: unsupported(
      "'.slice()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.slice();'",
    ),
    group: unsupported("'.slice()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.slice()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  concat: name({
    unions: true,
    mergesInto: true,
    doc: "'.concat()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    sibling: { string: "To join strings, write '+' between them: 'a + b'." },
    returns: { array: "array", stream: "stream" },
    neverNull: "always",
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      perFamily: {
        stream: unsupported(
          "'.concat()' on '$$' is a chain of stages, not a value: write it as a statement ('$$.concat(…);').",
        ),
        array: {
          args: { sig: "...items", atLeast: 1, spread: true, rest: "any" },
          emit: ({ recv, args, value, type, bind }) => {
            const first = args[0];
            const list: readonly CallArg[] =
              args.length === 1 && first.type === "ArrayLiteral" && first.packed === true
                ? (first.elements as readonly CallArg[])
                : args;
            return {
              $concatArrays: [
                recv,
                ...list.map((a) =>
                  a.type === "SpreadElement"
                    ? concatSpread(value({ type: "ArrayLiteral", elements: [a], pos: a.pos }), type(a.argument).element)
                    : concatOperand(value(a), type(a), bind),
                ),
              ],
            };
          },
        },
      },
    },
    stream: inCode("src/compiler/emit/union.ts"),
    statement: unsupported(
      "'.concat()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.concat();'",
    ),
    group: unsupported("'.concat()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.concat()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  reverse: name({
    doc: "'.reverse()' mutates in JavaScript, so only statement position can express it. See docs/LANGUAGE.md.",
    call: true,
    on: "array",
    immutableTwin: "toReversed",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported(
      "'.reverse()' writes a field; it is not a filter predicate. Call it as a statement in a pipeline: '$.<field>.reverse(…);'.",
    ),
    expr: unsupported(
      ".reverse() mutates the array in JavaScript. In expression position, use '.toReversed()' — or call it at statement position (top-level on a '$.<field>' receiver) to mutate the field.",
    ),
    stream: because(
      "reverses the stream, and a stream has no defined order to reverse until it is sorted. Use '.orderBy({ <field>: -1 })' with the direction you want.",
    ),
    statement: inCode("src/compiler/passes/desugar.ts"),
    group: unsupported("'.reverse()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.reverse()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  toReversed: name({
    doc: "'.toReversed()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "array",
    returns: "array",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => reverseArrayOf(recv) },
    stream: because(
      "reverses the stream, and a stream has no defined order to reverse until it is sorted. Use '.orderBy({ <field>: -1 })' with the direction you want.",
    ),
    statement: unsupported(
      "'.toReversed()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.toReversed();'",
    ),
    group: unsupported("'.toReversed()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.toReversed()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  toSorted: name({
    doc: "'.toSorted()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    elementOnly: {
      when: "bare",
      why: "a stream of documents has no natural order, so a key is required: '.toSorted(\"<field>\")'. After '.flatMap(\"<field>\")' the bare call sorts by the unwound values.",
    },
    on: ["array", "stream"],
    params: { value: ["value"], stream: ["value", "value"] },
    iterateeSlots: {
      array: {
        sortSpec:
          '`"k"` is the order `{ k: 1 }`, `{ k: -1 }` descends, `["k", "j"]` sorts by two keys, `(a, b) => a - b` orders the elements themselves, and no argument is the natural order',
      },
      stream: {
        sortSpec:
          '`"k"` is the order `{ k: 1 }`, `{ k: -1 }` descends, `["k", "j"]` sorts by two keys; a stream has no natural order, so a key is required',
      },
    },
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: {
        sig: '"field" | ["a", "b"] | { field: dir } | keyFn | comparator',
        allowed: [0, 1],
        slotType: { 0: ["string", "array", "object", "callback"] },
      },
      emit: ({ recv, args, sortSpec, callback, bind }) => {
        if (args.length === 0) return { $sortArray: { input: recv, sortBy: 1 } };
        const ask = sortSpec(args[0]);
        if (ask.kind === "keys") return { $sortArray: { input: recv, sortBy: ask.spec } };
        if (ask.kind === "whole") return { $sortArray: { input: recv, sortBy: ask.dir } };
        const cb = callback(ask.key, "value");
        const p = bind("p");
        return {
          $map: {
            input: {
              $sortArray: {
                input: { $map: { input: recv, as: cb.as, in: { k: cb.in, v: cb.ref } } },
                sortBy: { k: ask.dir },
              },
            },
            as: p.as,
            in: `${p.ref}.v`,
          },
        };
      },
    },
    stream: {
      args: {
        sig: '["field" | [fields] | { field: dir } | comparator]',
        allowed: [0, 1],
        slotType: { 0: ["string", "array", "object", "callback"] },
      },
      emit: ({ args, sortSpec, slot, reshape, element }) =>
        args.length === 0 ? [{ $sort: { [element().path]: 1 } }] : sortStages(sortSpec(args[0]), slot, reshape),
    },
    statement: unsupported(
      "'.toSorted()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.toSorted();'",
    ),
    group: unsupported("'.toSorted()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.toSorted()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  sortBy: name({
    doc: "'.sortBy()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    elementOnly: {
      when: "bare",
      why: "a stream of documents has no natural order, so a key is required: '.sortBy(\"<field>\")'. After '.flatMap(\"<field>\")' the bare call sorts by the unwound values.",
    },
    on: ["array", "stream"],
    params: ["value"],
    iterateeSlots: {
      array: {
        sortSpec:
          '`"k"` or `["k", "j"]` names the keys, ascending. JSMQL refuses `{ k: -1 }` here, because an object in this slot is a lodash matcher. No argument gives the natural order',
      },
      stream: {
        sortSpec:
          '`"k"` or `["k", "j"]` names the keys, ascending. JSMQL refuses `{ k: -1 }` here, because an object in this slot is a lodash matcher. A stream has no natural order, so a key is necessary',
      },
    },
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: {
        sig: '["field" | keyFn | [fields]]',
        allowed: [0, 1],
        slotType: { 0: ["string", "array", "object", "callback"] },
      },
      emit: ({ recv, args, sortSpec, callback, bind }) => {
        if (args.length === 0) return { $sortArray: { input: recv, sortBy: 1 } };
        const ask = sortSpec(args[0], false);
        if (ask.kind === "keys") return { $sortArray: { input: recv, sortBy: ask.spec } };
        if (ask.kind === "whole") return { $sortArray: { input: recv, sortBy: ask.dir } };
        const cb = callback(ask.key, "value");
        const p = bind("p");
        return {
          $map: {
            input: {
              $sortArray: {
                input: { $map: { input: recv, as: cb.as, in: { k: cb.in, v: cb.ref } } },
                sortBy: { k: ask.dir },
              },
            },
            as: p.as,
            in: `${p.ref}.v`,
          },
        };
      },
    },
    stream: {
      args: {
        sig: '["field" | [fields] | keyFn]',
        allowed: [0, 1],
        slotType: { 0: ["string", "array", "object", "callback"] },
      },
      emit: ({ args, sortSpec, slot, reshape, element }) =>
        args.length === 0 ? [{ $sort: { [element().path]: 1 } }] : sortStages(sortSpec(args[0], false), slot, reshape),
    },
    statement: unsupported(
      "'.sortBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.sortBy();'",
    ),
    group: unsupported("'.sortBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.sortBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  orderBy: name({
    doc: "'.orderBy()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    params: ["value"],
    iterateeSlots: {
      array: {
        sortSpec:
          '`"k"`, `("k", "desc")`, `(["k"], ["desc"])` or `{ k: -1 }` — keys with directions; at least one key is required',
      },
      stream: {
        sortSpec:
          '`"k"`, `("k", "desc")`, `(["k"], ["desc"])` or `{ k: -1 }` — keys with directions; at least one key is required',
      },
    },
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: ORDER_BY_ARGS,
      emit: ({ recv, args, orderBy, callback, bind }) => {
        const ask = orderBy(args[0], args[1]);
        if (ask.kind === "keys") return { $sortArray: { input: recv, sortBy: ask.spec } };
        if (ask.kind === "whole") return { $sortArray: { input: recv, sortBy: ask.dir } };
        const cb = callback(ask.key, "value");
        const p = bind("p");
        return {
          $map: {
            input: {
              $sortArray: {
                input: { $map: { input: recv, as: cb.as, in: { k: cb.in, v: cb.ref } } },
                sortBy: { k: ask.dir },
              },
            },
            as: p.as,
            in: `${p.ref}.v`,
          },
        };
      },
    },
    stream: {
      args: ORDER_BY_ARGS,
      emit: ({ args, orderBy, slot, reshape }) => sortStages(orderBy(args[0], args[1]), slot, reshape),
    },
    statement: unsupported(
      "'.orderBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.orderBy();'",
    ),
    group: unsupported("'.orderBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.orderBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  toSpliced: name({
    doc: "'.toSpliced()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "array",
    returns: "array",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "start[, deleteCount, ...items]",
        atLeast: 1,
        slotType: { 0: "int", 1: "int" },
        rest: "any",
        slotRange: { 1: [0, Infinity] },
      },
      emit: ({ recv, args, value, bind }) => {
        const arr = bind("arr");
        const start = bind("start");
        const tail = bind("tailStart");
        const items = args.slice(2).map((a) => value(a));
        const size = { $size: arr.ref };
        const tailStart = args.length >= 2 ? { $add: [start.ref, value(args[1])] } : size;
        const rest = { $subtract: [size, tail.ref] };
        return {
          $let: {
            vars: { [arr.as]: recv },
            in: {
              $let: {
                vars: { [start.as]: resolveSliceIndex(args[0], value(args[0]), size) },
                in: {
                  $let: {
                    vars: { [tail.as]: tailStart },
                    in: {
                      $concatArrays: [
                        { $slice: [arr.ref, start.ref] },
                        items,
                        { $cond: [{ $gt: [rest, 0] }, { $slice: [arr.ref, tail.ref, rest] }, []] },
                      ],
                    },
                  },
                },
              },
            },
          },
        };
      },
    },
    stream: because("addresses elements by position. Use '.filter(<pred>)' or '.slice(start, end)'."),
    statement: unsupported(
      "'.toSpliced()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.toSpliced();'",
    ),
    group: unsupported("'.toSpliced()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.toSpliced()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  with: name({
    doc: "'.with()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "array",
    returns: "array",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "index, value", exact: 2, slotType: { 0: "int", 1: "any" }, slotRange: { 0: [0, Infinity] } },
      emit: ({ recv, args, value, bind }) => {
        const arr = bind("arr");
        const idx = bind("idx");
        const val = bind("val");
        const after = { $add: [idx.ref, 1] };
        return {
          $let: {
            vars: { [arr.as]: recv, [idx.as]: value(args[0]), [val.as]: value(args[1]) },
            in: {
              $concatArrays: [
                { $slice: [arr.ref, idx.ref] },
                [val.ref],
                {
                  $cond: [
                    { $gt: [{ $subtract: [{ $size: arr.ref }, after] }, 0] },
                    { $slice: [arr.ref, after, { $subtract: [{ $size: arr.ref }, after] }] },
                    [],
                  ],
                },
              ],
            },
          },
        };
      },
    },
    stream: because("replaces the element at an index. Use '.map(d => …)' with a condition on the document."),
    statement: unsupported(
      "'.with()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.with();'",
    ),
    group: unsupported("'.with()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.with()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  flat: name({
    doc: "'.flat()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    returns: { array: { arrayOf: { elementOf: "element" } }, stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    elementOnly: {
      when: "always",
      why: "flattens nested ARRAYS, and every element of this stream is a whole document. To split one document's array field into many documents, use '.flatMap(\"<field>\")' — that is '$unwind'; after it, '.flat()' unwinds the element once more.",
    },
    filter: viaFallback,
    expr: {
      args: { sig: "depth", allowed: [0, 1], constant: [0], slotType: { 0: "int" }, slotRange: { 0: [1, 1] } },
      emit: ({ recv }) => ({
        $reduce: { input: recv, initialValue: [], in: { $concatArrays: ["$$value", "$$this"] } },
      }),
    },
    stream: { args: { sig: "", none: true }, emit: ({ element }) => [{ $unwind: element().ref }] },
    statement: unsupported(
      "'.flat()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.flat();'",
    ),
    group: unsupported("'.flat()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.flat()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  flatMap: name({
    doc: "'.flatMap()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    params: ["value", "index", "receiver"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
      stream: { 0: ["propertyPath"] },
    },
    returns: { array: { arrayOf: { elementOf: { callback: 0 } } }, stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: { sig: "callback", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ args, callback }) => {
        const cb = callback(args[0], "value");
        return {
          $reduce: {
            input: { $map: { input: cb.input, as: cb.as, in: cb.in } },
            initialValue: [],
            in: { $concatArrays: ["$$value", "$$this"] },
          },
        };
      },
    },
    stream: {
      args: { sig: "callback", exact: 1, slotType: { 0: ["callback", "string"] } },
      emit: ({ args, fieldPath, unwound }) => {
        const path = fieldPath(args[0]);
        unwound(path.slice(1));
        return [{ $unwind: path }];
      },
    },
    statement: unsupported(
      "'.flatMap()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.flatMap();'",
    ),
    group: unsupported("'.flatMap()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.flatMap()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  map: name({
    streamBody: "document",
    doc: "'.map()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    params: ["value", "index", "receiver"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
      stream: { 0: ["propertyPath"] },
    },
    returns: { array: { arrayOf: { callback: 0 } }, stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: { sig: "callback", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ args, callback }) => {
        const cb = callback(args[0], "value");
        return { $map: { input: cb.input, as: cb.as, in: cb.in } };
      },
    },
    stream: {
      args: { sig: "callback", exact: 1, slotType: { 0: ["callback", "string"] } },
      emit: ({ args, document }) => [{ $replaceWith: document(args[0]) }],
    },
    statement: unsupported(
      "'.map()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.map();'",
    ),
    group: unsupported("'.map()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.map()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  filter: name({
    doc: "'.filter()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    params: { value: ["value", "index", "receiver"], stream: ["value"] },
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
      stream: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair"] },
    },
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ args, callback, bind }) => {
        const cb = callback(args[0], "truth");
        const kept = { $filter: { input: cb.input, as: cb.as, cond: cb.in } };
        if (!cb.paired) return kept;
        const p = bind("pair");
        return { $map: { input: kept, as: p.as, in: { $arrayElemAt: [p.ref, 1] } } };
      },
    },
    stream: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ args, predicate }) => [{ $match: predicate(args[0]) }],
    },
    statement: unsupported(
      "'.filter()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.filter();'",
    ),
    group: unsupported("'.filter()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.filter()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  find: name({
    doc: "'.find()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    picksOne: "filter",
    params: ["value", "index", "receiver"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: "element",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ args, callback }) => {
        const cb = callback(args[0], "truth");
        const picked = { $arrayElemAt: [{ $filter: { input: cb.input, as: cb.as, cond: cb.in } }, 0] };
        return cb.paired ? { $arrayElemAt: [picked, 1] } : picked;
      },
    },
    stream: unsupported(
      "'.find(...)' is not allowed in a chain on '$' \u2014 '.find' returns a single element in JS, but pipelines are arrays. Use '$.filter(<predicate>).take(1)' for the first match.",
    ),
    statement: unsupported(
      "'.find()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.find();'",
    ),
    group: unsupported("'.find()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.find()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  findIndex: name({
    doc: "'.findIndex()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    params: ["value", "index"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "callback", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, callback, present, bind }) => {
        const cb = callback(args[0], "truth");
        const hit = { $let: { vars: { [cb.as]: cb.paired ? "$$this" : { $arrayElemAt: ["$$this", 1] } }, in: cb.in } };
        return nullOr(recv, present, bind, (r) => ({
          $reduce: {
            input: indexedPairs(r),
            initialValue: -1,
            in: { $cond: [{ $and: [{ $eq: ["$$value", -1] }, hit] }, { $arrayElemAt: ["$$this", 0] }, "$$value"] },
          },
        }));
      },
    },
    stream: because("returns an index, and a stream has no index."),
    statement: unsupported(
      "'.findIndex()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.findIndex();'",
    ),
    group: unsupported("'.findIndex()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.findIndex()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  findLast: name({
    doc: "'.findLast()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    params: ["value", "index", "receiver"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: "element",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ args, callback }) => {
        const cb = callback(args[0], "truth");
        const picked = { $arrayElemAt: [{ $filter: { input: cb.input, as: cb.as, cond: cb.in } }, -1] };
        return cb.paired ? { $arrayElemAt: [picked, 1] } : picked;
      },
    },
    stream: because(
      "returns ONE element, so the result is a value, not a stream. For a one-document stream use '.sort(<key>)' then '.take(1)'.",
    ),
    statement: unsupported(
      "'.findLast()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.findLast();'",
    ),
    group: unsupported("'.findLast()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.findLast()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  findLastIndex: name({
    doc: "'.findLastIndex()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    params: ["value", "index"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "callback", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, callback, present, bind }) => {
        const cb = callback(args[0], "truth");
        const hit = { $let: { vars: { [cb.as]: cb.paired ? "$$this" : { $arrayElemAt: ["$$this", 1] } }, in: cb.in } };
        return nullOr(recv, present, bind, (r) => ({
          $reduce: {
            input: indexedPairs(r),
            initialValue: -1,
            in: { $cond: [hit, { $arrayElemAt: ["$$this", 0] }, "$$value"] },
          },
        }));
      },
    },
    stream: because("returns an index, and a stream has no index."),
    statement: unsupported(
      "'.findLastIndex()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.findLastIndex();'",
    ),
    group: unsupported("'.findLastIndex()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.findLastIndex()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  lastIndexOf: name({
    doc: "'.lastIndexOf()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    sibling: {
      string: "A string has no search from the end. For the first match, write '.indexOfSubstring(searchString)'.",
    },
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "searchValue", exact: 1, slotType: { 0: "element" } }, emit: lastIndexOfArray },
    stream: unsupported("'.lastIndexOf()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.lastIndexOf()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.lastIndexOf();'",
    ),
    group: unsupported("'.lastIndexOf()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.lastIndexOf()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  some: name({
    doc: "'.some()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    params: ["value", "index", "receiver"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: "bool",
    neverNull: true,
    where: ["value", "filter"],
    filter: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, pathOf, elementQuery }) => {
        const path = recv === null ? null : pathOf(recv);
        if (path === null) return null;
        const q = elementQuery(args[0]);
        if (q === null) return null;
        const keys = Object.keys(q);
        const itself = keys.length > 0 && keys.every((k) => k.startsWith("$") && !LOGICAL.has(k) && k !== "$expr");
        return itself || overFields(q) ? queryOwnValue(path, { $elemMatch: q }) : null;
      },
    },
    expr: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, callback, present, bind }) => {
        const cb = callback(args[0], "truth");
        return nullOr(recv, present, bind, (r) => ({
          $anyElementTrue: { $map: { input: cb.paired ? cb.input : r, as: cb.as, in: cb.in } },
        }));
      },
    },
    stream: unsupported("'.some()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.some()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.some();'",
    ),
    group: unsupported("'.some()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.some()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  every: name({
    doc: "'.every()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    params: ["value", "index", "receiver"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: "bool",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, callback, present, bind }) => {
        const cb = callback(args[0], "truth");
        return nullOr(recv, present, bind, (r) => ({
          $allElementsTrue: { $map: { input: cb.paired ? cb.input : r, as: cb.as, in: cb.in } },
        }));
      },
    },
    stream: unsupported("'.every()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.every()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.every();'",
    ),
    group: unsupported("'.every()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.every()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  reduce: name({
    doc: "'.reduce()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    params: ["accumulator", "value", "index"],
    iterateeSlots: {
      array: { arrowOnly: "the callback takes (accumulator, value[, index]) and a shorthand cannot stand in for it" },
    },
    returns: { oneOf: [{ arg: 1 }, { callback: 0 }] },
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "lambda, initialValue", exact: 2, slotType: { 0: "callback", 1: "any" } },
      emit: ({ recv, args, value, reducer }) => {
        const r = reducer(args[0], args[1]);
        return { $reduce: { input: r.input, initialValue: value(args[1]), in: r.in } };
      },
    },
    stream: unsupported(
      "'.reduce(...)' is not a chain method on '$$' \u2014 in JS '.reduce' collapses an array to a single value, but '$$' must stay a stream of documents. To fold the whole stream, write a '$group' statement: '$group({ _id: null, total: $sum($.n) });'. To fold an array a document carries, call it on that array: '$.<field>.reduce((a, b) => a + b, 0)'.",
    ),
    statement: unsupported(
      "'.reduce()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.reduce();'",
    ),
    group: unsupported("'.reduce()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.reduce()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  reduceRight: name({
    doc: "'.reduceRight()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    params: ["accumulator", "value", "index"],
    iterateeSlots: {
      array: { arrowOnly: "the callback takes (accumulator, value[, index]) and a shorthand cannot stand in for it" },
    },
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "lambda, initialValue", exact: 2, slotType: { 0: "callback", 1: "any" } },
      emit: ({ recv, args, value, reducer }) => {
        const r = reducer(args[0], args[1]);
        return { $reduce: { input: { $reverseArray: r.input }, initialValue: value(args[1]), in: r.in } };
      },
    },
    stream: because(
      "folds from the END, which needs the whole stream buffered, and collapses it to one value. Use the '.reduce' wrap forms — see the '.reduce' error for the three shapes.",
    ),
    statement: unsupported(
      "'.reduceRight()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.reduceRight();'",
    ),
    group: unsupported("'.reduceRight()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.reduceRight()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  join: name({
    doc: "'.join()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    elements: "scalar",
    returns: "string",
    neverNull: true,
    readsNullAsEmpty: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "separator", allowed: [0, 1], slotType: { 0: "string" } },
      emit: ({ recv, args, value, present, bind }) =>
        nullOr(recv, present, bind, (r) => joinedWith(r, args.length === 1 ? value(args[0]) : ",")),
    },
    stream: because(
      "joins elements into ONE string, so the result is a value, not a stream. Valid in a value position: 'const s = $$.map(d => d.name).join(\", \")'.",
    ),
    statement: unsupported(
      "'.join()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.join();'",
    ),
    group: unsupported("'.join()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.join()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  toString: name({
    doc: "'.toString()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "any",
    returns: "unknown",
    neverNull: true,
    nullReceiverAs: "",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv }) => {
        const re = recv as { type?: string; pattern?: string; flags?: string };
        if (re.type === "RegexLiteral")
          return `/${re.pattern}/${[...mongoRegexOptions(re.flags ?? "")].sort().join("")}`;
        return { $toString: singleArrayArg(recv) };
      },
    },
    stream: unsupported("'.toString()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.toString()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.toString();'",
    ),
    group: unsupported("'.toString()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.toString()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  toDouble: conversion({ method: "toDouble", operator: "$toDouble", returns: "number", safe: 0 }),
  toNumber: renamed({
    from: "toNumber",
    to: "toDouble",
    reason: "its numeric conversion",
    returns: "number",
    also: afterStringMethod("toDouble"),
  }),
  toInt: conversion({ method: "toInt", operator: "$toInt", returns: "number", safe: 0 }),
  toLong: conversion({ method: "toLong", operator: "$toLong", returns: "number", safe: 0 }),
  toDecimal: conversion({ method: "toDecimal", operator: "$toDecimal", returns: "number", safe: 0 }),
  toBool: conversion({ method: "toBool", operator: "$toBool", returns: "bool", safe: false }),
  toDate: conversion({ method: "toDate", operator: "$toDate", returns: "date", safe: new Date(0) }),
  toObjectId: conversion({ method: "toObjectId", operator: "$toObjectId", returns: "objectId" }),
  toUUID: conversion({ method: "toUUID", operator: "$toUUID", returns: "binData" }),

  isString: typeTest({ method: "isString", alias: "string", doc: "is the value a string?" }),
  isNumber: typeTest({
    method: "isNumber",
    alias: "number",
    doc: "is the value a number of any BSON type? Emits $isNumber.",
  }),
  isDouble: typeTest({ method: "isDouble", alias: "double", doc: "is the value a double?" }),
  isInt: typeTest({ method: "isInt", alias: "int", doc: "is the value a 32-bit integer?" }),
  isLong: typeTest({ method: "isLong", alias: "long", doc: "is the value a 64-bit integer?" }),
  isDecimal: typeTest({ method: "isDecimal", alias: "decimal", doc: "is the value a Decimal128?" }),
  isBool: typeTest({ method: "isBool", alias: "bool", doc: "is the value a boolean?" }),
  isBoolean: renamed({
    from: "isBoolean",
    to: "isBool",
    reason: "the boolean test, as MongoDB names the type 'bool'",
    returns: "bool",
  }),
  isUndefined: (() => {
    const refusal = unsupported(
      "'.isUndefined()' is not part of JSMQL. A comparison with undefined is the missing-field test, and one capability gets one spelling. Write '<value> === undefined': '$.x === undefined'.",
    );
    return name({
      doc: "Parsed, then refused: JSMQL writes '<value> === undefined'.",
      call: true,
      on: "any",
      returns: "bool",
      where: [],
      filter: refusal,
      expr: refusal,
      stream: refusal,
      statement: refusal,
      group: refusal,
      window: refusal,
    });
  })(),
  isDate: typeTest({ method: "isDate", alias: "date", doc: "is the value a date?" }),
  isObjectId: typeTest({ method: "isObjectId", alias: "objectId", doc: "is the value an ObjectId?" }),
  isObject: typeTest({ method: "isObject", alias: "object", doc: "is the value a document? An array is not one." }),
  isArray: name({
    doc: "'.isArray()' — is the value an array? Emits $isArray. See docs/LANGUAGE.md.",
    call: true,
    on: "any",
    sibling: {
      Array:
        "One capability gets one spelling, and the value's own method is shorter. Write '<value>.isArray()': '$.x.isArray()'. As a callback, write 'x => x.isArray()'.",
    },
    returns: "bool",
    neverNull: true,
    where: ["value", "filter"],
    filter: {
      args: { sig: "", none: true },
      emit: ({ recv, pathOf }) => {
        const path = recv === null ? null : pathOf(recv);
        return path === null ? null : queryOwnValue(path, { $type: "array" });
      },
    },
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $isArray: singleArrayArg(recv) }) },
    stream: unsupported("'.isArray()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.isArray()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.isArray();'",
    ),
    group: unsupported("'.isArray()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.isArray()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  isInteger: name({
    doc: "'.isInteger()' — is the value a number with no fraction? See docs/LANGUAGE.md.",
    call: true,
    on: "any",
    sibling: {
      Number:
        "One capability gets one spelling, and the value's own method is shorter. Write '<value>.isInteger()': '$.x.isInteger()'. As a callback, write 'x => x.isInteger()'.",
    },
    returns: "bool",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, bind }) => {
        const test = (v: unknown) => ({ $and: [isFiniteNumber(v), { $eq: [v, { $trunc: v }] }] });
        if (typeof recv === "string" && recv.startsWith("$")) return test(recv);
        const v = bind("v");
        return { $let: { vars: { [v.as]: recv }, in: test(v.ref) } };
      },
    },
    stream: unsupported("'.isInteger()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.isInteger()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.isInteger();'",
    ),
    group: unsupported("'.isInteger()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.isInteger()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),
  isNaN: name({
    doc: "'.isNaN()' — is the value the number NaN? See docs/LANGUAGE.md.",
    call: true,
    on: "any",
    sibling: {
      Number:
        "One capability gets one spelling, and the value's own method is shorter. Write '<value>.isNaN()': '$.x.isNaN()'. As a callback, write 'x => x.isNaN()'.",
    },
    returns: "bool",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, bind }) => {
        const test = (v: unknown) => ({ $and: [{ $isNumber: v }, { $eq: [{ $toString: v }, "NaN"] }] });
        if (typeof recv === "string" && recv.startsWith("$")) return test(recv);
        const v = bind("v");
        return { $let: { vars: { [v.as]: recv }, in: test(v.ref) } };
      },
    },
    stream: unsupported("'.isNaN()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.isNaN()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.isNaN();'",
    ),
    group: unsupported("'.isNaN()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.isNaN()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),
  isUUID: name({
    doc: "'.isUUID()' — is the value a UUID, a binData of subtype 4? See docs/LANGUAGE.md.",
    call: true,
    on: "any",
    returns: "bool",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, bind }) => {
        const test = (v: unknown) => ({
          $and: [
            { $eq: [{ $type: v }, "binData"] },
            { $ne: [{ $convert: { input: v, to: "string", format: "uuid", onError: null } }, null] },
          ],
        });
        if (typeof recv === "string" && recv.startsWith("$")) return test(recv);
        const v = bind("v");
        return { $let: { vars: { [v.as]: singleArrayArg(recv) }, in: test(v.ref) } };
      },
    },
    stream: unsupported("'.isUUID()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.isUUID()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.isUUID();'",
    ),
    group: unsupported("'.isUUID()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.isUUID()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  sort: name({
    doc: "'.sort()' mutates in JavaScript, so only statement position can express it. See docs/LANGUAGE.md.",
    call: true,
    elementOnly: {
      when: "bare",
      why: "a stream of documents has no natural order, so a key is required: '.sort(\"<field>\")'. After '.flatMap(\"<field>\")' the bare call sorts by the unwound values.",
    },
    on: ["array", "stream"],
    immutableTwin: "toSorted",
    params: { statement: ["value"], stream: ["value", "value"] },
    iterateeSlots: {
      array: {
        sortSpec:
          '`"k"` is the order `{ k: 1 }`, `{ k: -1 }` descends, and no argument is the natural order — as a statement, writing the field back',
      },
      stream: {
        sortSpec:
          '`"k"` is the order `{ k: 1 }`, `{ k: -1 }` descends, `["k", "j"]` sorts by two keys, and `(a, b) => a.k - b.k` is the comparator; a stream has no natural order, so a key is required',
      },
    },
    returns: { array: "unknown", stream: "stream" },
    where: ["stream", "statement"],
    filter: unsupported(
      "'.sort()' writes a field; it is not a filter predicate. Call it as a statement in a pipeline: '$.<field>.sort(…);'.",
    ),
    expr: unsupported(
      ".sort() mutates the array in JavaScript. In expression position, use '.toSorted()' — or call it at statement position (top-level on a '$.<field>' receiver) to mutate the field.",
    ),
    stream: {
      args: {
        sig: '["field" | [fields] | { field: dir } | comparator]',
        allowed: [0, 1],
        slotType: { 0: ["string", "array", "object", "callback"] },
      },
      emit: ({ args, sortSpec, slot, reshape, element }) =>
        args.length === 0 ? [{ $sort: { [element().path]: 1 } }] : sortStages(sortSpec(args[0]), slot, reshape),
    },
    statement: inCode("src/compiler/passes/desugar.ts"),
    group: unsupported("'.sort()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.sort()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  splice: name({
    doc: "'.splice()' mutates in JavaScript, so only statement position can express it. See docs/LANGUAGE.md.",
    call: true,
    on: "array",
    immutableTwin: "toSpliced",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported(
      "'.splice()' writes a field; it is not a filter predicate. Call it as a statement in a pipeline: '$.<field>.splice(…);'.",
    ),
    expr: unsupported(
      ".splice() mutates the array in JavaScript. In expression position, use '.toSpliced(start, deleteCount, ...items)' — or call it at statement position (top-level on a '$.<field>' receiver) to mutate the field.",
    ),
    stream: unsupported("'.splice()' mutates; a chain link must return a stream. Use its immutable form mid-chain."),
    statement: inCode("src/compiler/passes/desugar.ts"),
    group: unsupported("'.splice()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.splice()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  push: name({
    unions: true,
    mergesInto: true,
    doc: "'.push()' mutates in JavaScript, so only statement position can express it. See docs/LANGUAGE.md.",
    call: true,
    on: ["array", "stream"],
    asArrayLiteral: "receiver, then arguments",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported(
      "'.push()' writes a field; it is not a filter predicate. Call it as a statement in a pipeline: '$.<field>.push(…);'.",
    ),
    expr: unsupported(
      ".push() mutates the array in JavaScript. In expression position, use '.concat(x)' or spread '[...arr, x]' — or call it at statement position (top-level on a '$.<field>' receiver) to mutate the field.",
    ),
    stream: because("appends by mutation. Use '.concat(...)' mid-chain, which emits the same '$unionWith'."),
    statement: inCode("src/compiler/emit/union.ts"),
    group: unsupported("'.push()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.push()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  pop: name({
    doc: "'.pop()' mutates in JavaScript, so only statement position can express it. See docs/LANGUAGE.md.",
    call: true,
    on: "array",
    mutatorForm: { sig: "", by: { 0: "[..._r].slice(0, -1)" } },
    returns: "unknown",
    where: ["statement"],
    filter: unsupported(
      "'.pop()' writes a field; it is not a filter predicate. Call it as a statement in a pipeline: '$.<field>.pop(…);'.",
    ),
    expr: unsupported(
      ".pop() mutates the array in JavaScript. In expression position, use '.at(-1)' to read the last element or '.slice(0, -1)' for everything-but-last — or call it at statement position (top-level on a '$.<field>' receiver) to drop the last element.",
    ),
    stream: unsupported("'.pop()' mutates; a chain link must return a stream. Use its immutable form mid-chain."),
    statement: inCode("src/compiler/passes/desugar.ts"),
    group: unsupported("'.pop()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.pop()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  shift: name({
    doc: "'.shift()' mutates in JavaScript, so only statement position can express it. See docs/LANGUAGE.md.",
    call: true,
    on: "array",
    mutatorForm: { sig: "", by: { 0: "[..._r].slice(1)" } },
    returns: "unknown",
    where: ["statement"],
    filter: unsupported(
      "'.shift()' writes a field; it is not a filter predicate. Call it as a statement in a pipeline: '$.<field>.shift(…);'.",
    ),
    expr: unsupported(
      ".shift() mutates the array in JavaScript. In expression position, use '.at(0)' to read the first element or '.slice(1)' for everything-but-first — or call it at statement position (top-level on a '$.<field>' receiver) to drop the first element.",
    ),
    stream: unsupported("'.shift()' mutates; a chain link must return a stream. Use its immutable form mid-chain."),
    statement: inCode("src/compiler/passes/desugar.ts"),
    group: unsupported("'.shift()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.shift()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  unshift: name({
    doc: "'.unshift()' mutates in JavaScript, so only statement position can express it. See docs/LANGUAGE.md.",
    call: true,
    on: "array",
    asArrayLiteral: "arguments, then receiver",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported(
      "'.unshift()' writes a field; it is not a filter predicate. Call it as a statement in a pipeline: '$.<field>.unshift(…);'.",
    ),
    expr: unsupported(
      ".unshift() mutates the array in JavaScript. In expression position, use '.concat()' with the new items first or spread '[...newItems, ...arr]' — or call it at statement position (top-level on a '$.<field>' receiver) to prepend in place.",
    ),
    stream: unsupported("'.unshift()' mutates; a chain link must return a stream. Use its immutable form mid-chain."),
    statement: inCode("src/compiler/passes/desugar.ts"),
    group: unsupported("'.unshift()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.unshift()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  fill: name({
    doc: "'.fill()' mutates in JavaScript, so only statement position can express it. See docs/LANGUAGE.md.",
    call: true,
    on: "array",
    mutatorForm: {
      sig: "value[, start[, end]]",
      by: {
        1: "[..._r].map(() => _0)",
        2: "[...[..._r].slice(0, _1), ...[..._r].slice(_1).map(() => _0)]",
        3: "[...[..._r].slice(0, _1), ...[..._r].slice(_1, _2).map(() => _0), ...[..._r].slice([..._r].slice(0, _1).size() + [..._r].slice(_1, _2).size())]",
      },
    },
    returns: "unknown",
    where: ["statement"],
    filter: unsupported(
      "'.fill()' writes a field; it is not a filter predicate. Call it as a statement in a pipeline: '$.<field>.fill(…);'.",
    ),
    expr: unsupported(
      ".fill() mutates the array in JavaScript. In expression position there is no direct immutable replacement (build from a $range or pass a pre-filled array as a parameter) — or call it at statement position (top-level on a '$.<field>' receiver) to fill the field in place.",
    ),
    stream: unsupported("'.fill()' mutates; a chain link must return a stream. Use its immutable form mid-chain."),
    statement: inCode("src/compiler/passes/desugar.ts"),
    group: unsupported("'.fill()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.fill()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  copyWithin: name({
    doc: "'.copyWithin()' mutates in JavaScript, so only statement position can express it. See docs/LANGUAGE.md.",
    call: true,
    on: "array",
    mutatorForm: {
      sig: "target, start[, end]",
      by: {
        2: "[...[..._r].slice(0, _0), ...[..._r].slice(_1).slice(0, [..._r].size() - [..._r].slice(0, _0).size()), ...[..._r].slice([..._r].slice(0, _0).size() + [..._r].slice(_1).slice(0, [..._r].size() - [..._r].slice(0, _0).size()).size())]",
        3: "[...[..._r].slice(0, _0), ...[..._r].slice(_1, _2).slice(0, [..._r].size() - [..._r].slice(0, _0).size()), ...[..._r].slice([..._r].slice(0, _0).size() + [..._r].slice(_1, _2).slice(0, [..._r].size() - [..._r].slice(0, _0).size()).size())]",
      },
    },
    returns: "unknown",
    where: ["statement"],
    filter: unsupported(
      "'.copyWithin()' writes a field; it is not a filter predicate. Call it as a statement in a pipeline: '$.<field>.copyWithin(…);'.",
    ),
    expr: unsupported(
      ".copyWithin() mutates the array in JavaScript; jsmql expressions are immutable. Call it at statement position (top-level on a '$.<field>' receiver) to copy-within the field in place, or compose '.slice()' calls with '$concatArrays' for an inline expression.",
    ),
    stream: unsupported(
      "'.copyWithin()' mutates; a chain link must return a stream. Use its immutable form mid-chain.",
    ),
    statement: inCode("src/compiler/passes/desugar.ts"),
    group: unsupported("'.copyWithin()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.copyWithin()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  forEach: name({
    doc: "'.forEach()' has no MongoDB form. See its refusal.",
    call: true,
    on: "array",
    returns: "unknown",
    where: [],
    filter: unsupported(
      ".forEach() returns undefined in JavaScript; jsmql expressions must produce a value. Use '.map(...)' to transform, or move side-effecting work outside the query.",
    ),
    expr: unsupported(
      ".forEach() returns undefined in JavaScript; jsmql expressions must produce a value. Use '.map(...)' to transform, or move side-effecting work outside the query.",
    ),
    stream: unsupported(
      ".forEach() returns undefined in JavaScript; jsmql expressions must produce a value. Use '.map(...)' to transform, or move side-effecting work outside the query.",
    ),
    statement: unsupported(
      ".forEach() returns undefined in JavaScript; jsmql expressions must produce a value. Use '.map(...)' to transform, or move side-effecting work outside the query.",
    ),
    group: unsupported(
      ".forEach() returns undefined in JavaScript; jsmql expressions must produce a value. Use '.map(...)' to transform, or move side-effecting work outside the query.",
    ),
    window: unsupported(
      ".forEach() returns undefined in JavaScript; jsmql expressions must produce a value. Use '.map(...)' to transform, or move side-effecting work outside the query.",
    ),
  }),

  entries: name({
    doc: "'.entries()' — the object as [key, value] pairs. The array form is refused.",
    call: true,
    passesNull: true,
    on: ["array", "object", "Object"],
    returns: {
      array: { arrayOf: { tuple: ["number", "element"] } },
      object: { arrayOf: { tuple: ["string", { elementOf: "same" }] } },
    },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        array: unsupported(
          ".entries() returns an iterator in JavaScript and has no MongoDB equivalent. Use '.map((v, i) => [i, v])' if you want [index, value] pairs as an array.",
        ),
        object: { args: { sig: "", none: true }, emit: ({ recv }) => pairsRead(recv, (r) => [`${r}.k`, `${r}.v`]) },
        Object: unsupported(
          "'Object.entries(obj)' is not part of JSMQL — the receiver's own method says the same thing, and one capability gets one spelling. Write '<object>.entries()': '$.doc.entries()'.",
        ),
      },
    },
    stream: unsupported("'.entries()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.entries()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <object>.entries();'",
    ),
    group: unsupported("'.entries()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.entries()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  keys: name({
    doc: "'.keys()' — an array of the object's keys. The array form is refused.",
    call: true,
    passesNull: true,
    on: ["array", "object", "Object"],
    returns: { arrayOf: "string" },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        array: unsupported(
          ".keys() returns an iterator in JavaScript and has no MongoDB equivalent. Use '$op($range, 0, $op($size, arr))' if you want the index array.",
        ),
        object: { args: { sig: "", none: true }, emit: ({ recv }) => pairsRead(recv, (r) => `${r}.k`) },
        Object: unsupported(
          "'Object.keys(obj)' is not part of JSMQL — the receiver's own method says the same thing, and one capability gets one spelling. Write '<object>.keys()': '$.doc.keys()'.",
        ),
      },
    },
    stream: unsupported("'.keys()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.keys()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <object>.keys();'",
    ),
    group: unsupported("'.keys()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.keys()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  values: name({
    doc: "'.values()' — an array of the object's values. The array form is refused.",
    call: true,
    passesNull: true,
    on: ["array", "object", "Object"],
    returns: { array: "same", object: { arrayOf: { elementOf: "same" } } },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        array: unsupported(
          ".values() returns an iterator in JavaScript and has no MongoDB equivalent. The array itself is already the value sequence — use it directly.",
        ),
        object: { args: { sig: "", none: true }, emit: ({ recv }) => pairsRead(recv, (r) => `${r}.v`) },
        Object: unsupported(
          "'Object.values(obj)' is not part of JSMQL — the receiver's own method says the same thing, and one capability gets one spelling. Write '<object>.values()': '$.doc.values()'.",
        ),
      },
    },
    stream: unsupported("'.values()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.values()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <object>.values();'",
    ),
    group: unsupported("'.values()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.values()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  toLocaleString: name({
    doc: "'.toLocaleString()' has no MongoDB form. See its refusal.",
    call: true,
    on: "any",
    returns: "unknown",
    where: [],
    filter: unsupported(
      ".toLocaleString() is locale-dependent and isn't expressible as a MongoDB expression. Use '.join(...)' with explicit formatting, or '$dateToString' for dates.",
    ),
    expr: unsupported(
      ".toLocaleString() is locale-dependent and isn't expressible as a MongoDB expression. Use '.join(...)' with explicit formatting, or '$dateToString' for dates.",
    ),
    stream: unsupported(
      ".toLocaleString() is locale-dependent and isn't expressible as a MongoDB expression. Use '.join(...)' with explicit formatting, or '$dateToString' for dates.",
    ),
    statement: unsupported(
      ".toLocaleString() is locale-dependent and isn't expressible as a MongoDB expression. Use '.join(...)' with explicit formatting, or '$dateToString' for dates.",
    ),
    group: unsupported(
      ".toLocaleString() is locale-dependent and isn't expressible as a MongoDB expression. Use '.join(...)' with explicit formatting, or '$dateToString' for dates.",
    ),
    window: unsupported(
      ".toLocaleString() is locale-dependent and isn't expressible as a MongoDB expression. Use '.join(...)' with explicit formatting, or '$dateToString' for dates.",
    ),
  }),

  getFullYear: name({
    doc: "'.getFullYear()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $year: recv }) },
    stream: unsupported("'.getFullYear()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getFullYear()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getFullYear();'",
    ),
    group: unsupported("'.getFullYear()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.getFullYear()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  getMonth: name({
    doc: "'.getMonth()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $subtract: [{ $month: recv }, 1] }) },
    stream: unsupported("'.getMonth()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getMonth()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getMonth();'",
    ),
    group: unsupported("'.getMonth()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.getMonth()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  getDate: name({
    doc: "'.getDate()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $dayOfMonth: recv }) },
    stream: unsupported("'.getDate()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getDate()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getDate();'",
    ),
    group: unsupported("'.getDate()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.getDate()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  getDay: name({
    doc: "'.getDay()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $subtract: [{ $dayOfWeek: recv }, 1] }) },
    stream: unsupported("'.getDay()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getDay()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getDay();'",
    ),
    group: unsupported("'.getDay()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.getDay()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  getHours: name({
    doc: "'.getHours()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $hour: recv }) },
    stream: unsupported("'.getHours()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getHours()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getHours();'",
    ),
    group: unsupported("'.getHours()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.getHours()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  getMinutes: name({
    doc: "'.getMinutes()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $minute: recv }) },
    stream: unsupported("'.getMinutes()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getMinutes()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getMinutes();'",
    ),
    group: unsupported("'.getMinutes()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.getMinutes()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  getSeconds: name({
    doc: "'.getSeconds()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $second: recv }) },
    stream: unsupported("'.getSeconds()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getSeconds()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getSeconds();'",
    ),
    group: unsupported("'.getSeconds()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.getSeconds()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  getMilliseconds: name({
    doc: "'.getMilliseconds()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $millisecond: recv }) },
    stream: unsupported("'.getMilliseconds()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getMilliseconds()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getMilliseconds();'",
    ),
    group: unsupported("'.getMilliseconds()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.getMilliseconds()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  getUTCFullYear: name({
    doc: "'.getUTCFullYear()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $year: recv }) },
    stream: unsupported("'.getUTCFullYear()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getUTCFullYear()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getUTCFullYear();'",
    ),
    group: unsupported("'.getUTCFullYear()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.getUTCFullYear()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  getUTCMonth: name({
    doc: "'.getUTCMonth()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $subtract: [{ $month: recv }, 1] }) },
    stream: unsupported("'.getUTCMonth()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getUTCMonth()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getUTCMonth();'",
    ),
    group: unsupported("'.getUTCMonth()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.getUTCMonth()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  getUTCDate: name({
    doc: "'.getUTCDate()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $dayOfMonth: recv }) },
    stream: unsupported("'.getUTCDate()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getUTCDate()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getUTCDate();'",
    ),
    group: unsupported("'.getUTCDate()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.getUTCDate()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  getUTCDay: name({
    doc: "'.getUTCDay()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $subtract: [{ $dayOfWeek: recv }, 1] }) },
    stream: unsupported("'.getUTCDay()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getUTCDay()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getUTCDay();'",
    ),
    group: unsupported("'.getUTCDay()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.getUTCDay()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  getUTCHours: name({
    doc: "'.getUTCHours()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $hour: recv }) },
    stream: unsupported("'.getUTCHours()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getUTCHours()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getUTCHours();'",
    ),
    group: unsupported("'.getUTCHours()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.getUTCHours()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  getUTCMinutes: name({
    doc: "'.getUTCMinutes()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $minute: recv }) },
    stream: unsupported("'.getUTCMinutes()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getUTCMinutes()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getUTCMinutes();'",
    ),
    group: unsupported("'.getUTCMinutes()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.getUTCMinutes()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  getUTCSeconds: name({
    doc: "'.getUTCSeconds()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $second: recv }) },
    stream: unsupported("'.getUTCSeconds()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getUTCSeconds()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getUTCSeconds();'",
    ),
    group: unsupported("'.getUTCSeconds()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.getUTCSeconds()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  getUTCMilliseconds: name({
    doc: "'.getUTCMilliseconds()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $millisecond: recv }) },
    stream: unsupported("'.getUTCMilliseconds()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getUTCMilliseconds()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getUTCMilliseconds();'",
    ),
    group: unsupported("'.getUTCMilliseconds()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.getUTCMilliseconds()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  getTime: name({
    doc: "'.getTime()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $toLong: recv }) },
    stream: unsupported("'.getTime()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.getTime()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.getTime();'",
    ),
    group: unsupported("'.getTime()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.getTime()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  toISOString: name({
    doc: "'.toISOString()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $dateToString: { date: recv } }) },
    stream: unsupported("'.toISOString()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.toISOString()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.toISOString();'",
    ),
    group: unsupported("'.toISOString()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.toISOString()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  plus: name({
    doc: "'.plus()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "date",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "amount, unit[, timezone]",
        allowed: [2, 3],
        slotEnums: { 1: TIME_UNIT },
        slotType: { 0: "int-or-long", 1: "string", 2: ["string", "object"] },
        body: {
          2: {
            required: [],
            optional: ["timezone"],
            closed: true,
            keyTypes: { binSize: "number", timezone: "string" },
          },
        },
      },
      emit: ({ recv, args, value }) => ({
        $dateAdd: { startDate: recv, unit: value(args[1]), amount: value(args[0]), ...dateOptions(args[2], value) },
      }),
    },
    stream: unsupported("'.plus()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.plus()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.plus();'",
    ),
    group: unsupported("'.plus()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.plus()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  minus: name({
    doc: "'.minus()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "date",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "amount, unit[, timezone]",
        allowed: [2, 3],
        slotEnums: { 1: TIME_UNIT },
        slotType: { 0: "int-or-long", 1: "string", 2: ["string", "object"] },
        body: {
          2: {
            required: [],
            optional: ["timezone"],
            closed: true,
            keyTypes: { binSize: "number", timezone: "string" },
          },
        },
      },
      emit: ({ recv, args, value }) => ({
        $dateSubtract: {
          startDate: recv,
          unit: value(args[1]),
          amount: value(args[0]),
          ...dateOptions(args[2], value),
        },
      }),
    },
    stream: unsupported("'.minus()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.minus()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.minus();'",
    ),
    group: unsupported("'.minus()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.minus()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  diff: name({
    doc: "'.diff()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "other, unit[, timezone]",
        allowed: [2, 3],
        slotEnums: { 1: TIME_UNIT },
        slotType: { 0: "date", 1: "string", 2: ["string", "object"] },
        body: {
          2: {
            required: [],
            optional: ["timezone", "startOfWeek"],
            closed: true,
            keyTypes: { binSize: "number", timezone: "string", startOfWeek: "string" },
            enums: { startOfWeek: WEEKDAY },
            caseInsensitiveKeys: ["startOfWeek"],
          },
        },
      },
      emit: ({ recv, args, value }) => ({
        $dateDiff: { startDate: value(args[0]), endDate: recv, unit: value(args[1]), ...dateOptions(args[2], value) },
      }),
    },
    stream: unsupported("'.diff()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.diff()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.diff();'",
    ),
    group: unsupported("'.diff()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.diff()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  startOf: name({
    doc: "'.startOf()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "date",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "unit[, timezone]",
        allowed: [1, 2],
        slotEnums: { 0: TIME_UNIT },
        body: {
          1: {
            required: [],
            optional: ["binSize", "timezone", "startOfWeek"],
            closed: true,
            keyTypes: { binSize: "number", timezone: "string", startOfWeek: "string" },
            enums: { startOfWeek: WEEKDAY },
            caseInsensitiveKeys: ["startOfWeek"],
          },
        },
        slotType: { 0: "string", 1: ["string", "object"] },
      },
      emit: ({ recv, args, value }) => ({
        $dateTrunc: { date: recv, unit: value(args[0]), ...dateOptions(args[1], value) },
      }),
    },
    stream: unsupported("'.startOf()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.startOf()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.startOf();'",
    ),
    group: unsupported("'.startOf()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.startOf()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  format: name({
    doc: "'.format()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "format[, timezone]",
        allowed: [1, 2],
        slotType: { 0: "string", 1: ["string", "object"] },
        dateFormat: [0],
        body: {
          1: {
            required: [],
            optional: ["timezone"],
            closed: true,
            keyTypes: { binSize: "number", timezone: "string" },
          },
        },
      },
      emit: ({ recv, args, value }) => ({
        $dateToString: { date: recv, format: value(args[0]), ...dateOptions(args[1], value) },
      }),
    },
    stream: unsupported("'.format()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.format()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.format();'",
    ),
    group: unsupported("'.format()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.format()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  week: name({
    doc: "'.week()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "[timezone]",
        allowed: [0, 1],
        body: {
          0: {
            required: [],
            optional: ["timezone"],
            closed: true,
            keyTypes: { binSize: "number", timezone: "string" },
          },
        },
        slotType: { 0: ["string", "object"] },
      },
      emit: ({ recv, args, value }) => {
        const opts = dateOptions(args[0], value);
        return { $week: opts.timezone === undefined ? recv : { date: recv, ...opts } };
      },
    },
    stream: unsupported("'.week()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.week()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.week();'",
    ),
    group: unsupported("'.week()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.week()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  isoWeek: name({
    doc: "'.isoWeek()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "[timezone]",
        allowed: [0, 1],
        body: {
          0: {
            required: [],
            optional: ["timezone"],
            closed: true,
            keyTypes: { binSize: "number", timezone: "string" },
          },
        },
        slotType: { 0: ["string", "object"] },
      },
      emit: ({ recv, args, value }) => {
        const opts = dateOptions(args[0], value);
        return { $isoWeek: opts.timezone === undefined ? recv : { date: recv, ...opts } };
      },
    },
    stream: unsupported("'.isoWeek()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.isoWeek()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.isoWeek();'",
    ),
    group: unsupported("'.isoWeek()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.isoWeek()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  isoWeekYear: name({
    doc: "'.isoWeekYear()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "[timezone]",
        allowed: [0, 1],
        body: {
          0: {
            required: [],
            optional: ["timezone"],
            closed: true,
            keyTypes: { binSize: "number", timezone: "string" },
          },
        },
        slotType: { 0: ["string", "object"] },
      },
      emit: ({ recv, args, value }) => {
        const opts = dateOptions(args[0], value);
        return { $isoWeekYear: opts.timezone === undefined ? recv : { date: recv, ...opts } };
      },
    },
    stream: unsupported("'.isoWeekYear()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.isoWeekYear()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.isoWeekYear();'",
    ),
    group: unsupported("'.isoWeekYear()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.isoWeekYear()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  isoWeekday: name({
    doc: "'.isoWeekday()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "[timezone]",
        allowed: [0, 1],
        body: {
          0: {
            required: [],
            optional: ["timezone"],
            closed: true,
            keyTypes: { binSize: "number", timezone: "string" },
          },
        },
        slotType: { 0: ["string", "object"] },
      },
      emit: ({ recv, args, value }) => {
        const opts = dateOptions(args[0], value);
        return { $isoDayOfWeek: opts.timezone === undefined ? recv : { date: recv, ...opts } };
      },
    },
    stream: unsupported("'.isoWeekday()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.isoWeekday()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.isoWeekday();'",
    ),
    group: unsupported("'.isoWeekday()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.isoWeekday()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  dayOfYear: name({
    doc: "'.dayOfYear()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "[timezone]",
        allowed: [0, 1],
        body: {
          0: {
            required: [],
            optional: ["timezone"],
            closed: true,
            keyTypes: { binSize: "number", timezone: "string" },
          },
        },
        slotType: { 0: ["string", "object"] },
      },
      emit: ({ recv, args, value }) => {
        const opts = dateOptions(args[0], value);
        return { $dayOfYear: opts.timezone === undefined ? recv : { date: recv, ...opts } };
      },
    },
    stream: unsupported("'.dayOfYear()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.dayOfYear()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.dayOfYear();'",
    ),
    group: unsupported("'.dayOfYear()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.dayOfYear()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  quarter: name({
    doc: "'.quarter()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "[timezone]",
        allowed: [0, 1],
        body: {
          0: {
            required: [],
            optional: ["timezone"],
            closed: true,
            keyTypes: { binSize: "number", timezone: "string" },
          },
        },
        slotType: { 0: ["string", "object"] },
      },
      emit: ({ recv, args, value }) => {
        const opts = dateOptions(args[0], value);
        const operand = opts.timezone === undefined ? recv : { date: recv, ...opts };
        return { $toInt: { $ceil: { $divide: [{ $month: operand }, 3] } } };
      },
    },
    stream: unsupported("'.quarter()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.quarter()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.quarter();'",
    ),
    group: unsupported("'.quarter()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.quarter()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  isSame: name({
    doc: "'.isSame()' — see docs/LANGUAGE.md.",
    call: true,
    on: "date",
    returns: "bool",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "other, unit[, timezone]",
        allowed: [2, 3],
        reject: {
          1: ".isSame(other) without a unit is just '===' — write 'a === b'. Pass a unit to compare at that granularity: .isSame(other, \"day\").",
        },
        slotEnums: { 1: TIME_UNIT },
        slotType: { 0: "date", 1: "string", 2: ["string", "object"] },
        body: {
          2: {
            required: [],
            optional: ["binSize", "timezone", "startOfWeek"],
            closed: true,
            keyTypes: { binSize: "number", timezone: "string", startOfWeek: "string" },
            enums: { startOfWeek: WEEKDAY },
            caseInsensitiveKeys: ["startOfWeek"],
          },
        },
      },
      emit: ({ recv, args, value }) => {
        const bucket = (date: unknown): unknown => ({
          $dateTrunc: { date, unit: value(args[1]), ...dateOptions(args[2], value) },
        });
        return { $eq: [bucket(recv), bucket(value(args[0]))] };
      },
    },
    stream: unsupported("'.isSame()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.isSame()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.isSame();'",
    ),
    group: unsupported("'.isSame()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.isSame()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  isBefore: name({
    doc: "'.isBefore()' — see docs/LANGUAGE.md.",
    call: true,
    on: "date",
    returns: "bool",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "other, unit[, timezone]",
        allowed: [2, 3],
        reject: {
          1: ".isBefore(other) without a unit is just '<' — write 'a < b'. Pass a unit to compare at that granularity: .isBefore(other, \"day\").",
        },
        slotEnums: { 1: TIME_UNIT },
        slotType: { 0: "date", 1: "string", 2: ["string", "object"] },
        body: {
          2: {
            required: [],
            optional: ["binSize", "timezone", "startOfWeek"],
            closed: true,
            keyTypes: { binSize: "number", timezone: "string", startOfWeek: "string" },
            enums: { startOfWeek: WEEKDAY },
            caseInsensitiveKeys: ["startOfWeek"],
          },
        },
      },
      emit: ({ recv, args, value }) => {
        const bucket = (date: unknown): unknown => ({
          $dateTrunc: { date, unit: value(args[1]), ...dateOptions(args[2], value) },
        });
        return { $lt: [bucket(recv), bucket(value(args[0]))] };
      },
    },
    stream: unsupported("'.isBefore()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.isBefore()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.isBefore();'",
    ),
    group: unsupported("'.isBefore()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.isBefore()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  isAfter: name({
    doc: "'.isAfter()' — see docs/LANGUAGE.md.",
    call: true,
    on: "date",
    returns: "bool",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "other, unit[, timezone]",
        allowed: [2, 3],
        reject: {
          1: ".isAfter(other) without a unit is just '>' — write 'a > b'. Pass a unit to compare at that granularity: .isAfter(other, \"day\").",
        },
        slotEnums: { 1: TIME_UNIT },
        slotType: { 0: "date", 1: "string", 2: ["string", "object"] },
        body: {
          2: {
            required: [],
            optional: ["binSize", "timezone", "startOfWeek"],
            closed: true,
            keyTypes: { binSize: "number", timezone: "string", startOfWeek: "string" },
            enums: { startOfWeek: WEEKDAY },
            caseInsensitiveKeys: ["startOfWeek"],
          },
        },
      },
      emit: ({ recv, args, value }) => {
        const bucket = (date: unknown): unknown => ({
          $dateTrunc: { date, unit: value(args[1]), ...dateOptions(args[2], value) },
        });
        return { $gt: [bucket(recv), bucket(value(args[0]))] };
      },
    },
    stream: unsupported("'.isAfter()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.isAfter()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.isAfter();'",
    ),
    group: unsupported("'.isAfter()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.isAfter()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  set: name({
    doc: "'.set()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "date",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "{ parts }[, timezone]",
        allowed: [1, 2],
        constant: [0],
        slotType: { 0: "object", 1: ["string", "object"] },
        body: {
          0: {
            required: [],
            optional: [
              "year",
              "month",
              "day",
              "isoWeekYear",
              "isoWeek",
              "isoDayOfWeek",
              "hour",
              "minute",
              "second",
              "millisecond",
            ],
            closed: true,
            keyTypes: {
              year: "int-or-long",
              month: "int-or-long",
              day: "int-or-long",
              isoWeekYear: "int-or-long",
              isoWeek: "int-or-long",
              isoDayOfWeek: "int-or-long",
              hour: "int-or-long",
              minute: "int-or-long",
              second: "int-or-long",
              millisecond: "int-or-long",
            },
            notTogether: [
              [
                ["year", "month", "day"],
                ["isoWeekYear", "isoWeek", "isoDayOfWeek"],
              ],
            ],
          },
          1: { required: [], optional: ["timezone"], closed: true, keyTypes: { timezone: "string" } },
        },
      },
      emit: ({ recv, args, value, bind }) => {
        const given = new Map<string, Expr>();
        const body = args[0];
        if (body.type === "ObjectLiteral") {
          for (const e of body.entries) {
            if (e.type === "KeyValueEntry" && e.key.kind === "static") given.set(e.key.name, e.value);
          }
        } else if (body.type === "Injected" && typeof body.value === "object" && body.value !== null) {
          for (const [k, v] of Object.entries(body.value)) given.set(k, { type: "Injected", value: v, pos: body.pos });
        }
        const iso = [...given.keys()].some((k) => (DATE_PARTS_ISO_MARKERS as readonly string[]).includes(k));
        const family: readonly string[] = iso ? DATE_PARTS_ISO : DATE_PARTS_CALENDAR;
        const tz = dateOptions(args[1], value);
        const complete = family.every((k) => given.has(k));
        const parts = complete ? null : bind("parts");
        const rebuilt: Record<string, unknown> = {};
        for (const key of family) {
          const v = given.get(key);
          rebuilt[key] = v !== undefined ? value(v) : `${parts!.ref}.${key}`;
        }
        for (const [key, v] of given) if (!family.includes(key)) rebuilt[key] = value(v);
        const fromParts = { $dateFromParts: { ...rebuilt, ...tz } };
        if (parts === null) return fromParts;
        const toParts: Record<string, unknown> = { date: recv, ...tz };
        if (iso) toParts.iso8601 = true;
        return { $let: { vars: { [parts.as]: { $dateToParts: toParts } }, in: fromParts } };
      },
    },
    stream: unsupported("'.set()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.set()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.set();'",
    ),
    group: unsupported("'.set()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.set()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  endOf: name({
    doc: "'.endOf()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "date",
    returns: "date",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "unit[, timezone]",
        allowed: [1, 2],
        slotEnums: { 0: TIME_UNIT },
        body: {
          1: {
            required: [],
            optional: ["binSize", "timezone", "startOfWeek"],
            closed: true,
            keyTypes: { binSize: "number", timezone: "string", startOfWeek: "string" },
            enums: { startOfWeek: WEEKDAY },
            caseInsensitiveKeys: ["startOfWeek"],
          },
        },
        slotType: { 0: "string", 1: ["string", "object"] },
      },
      emit: ({ recv, args, value }) => {
        const opts = dateOptions(args[1], value);
        const step: Record<string, unknown> = {
          startDate: { $dateTrunc: { date: recv, unit: value(args[0]), ...opts } },
          unit: value(args[0]),
          amount: opts.binSize ?? 1,
        };
        if (opts.timezone !== undefined) step.timezone = opts.timezone;
        return { $dateSubtract: { startDate: { $dateAdd: step }, unit: "millisecond", amount: 1 } };
      },
    },
    stream: unsupported("'.endOf()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.endOf()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.endOf();'",
    ),
    group: unsupported("'.endOf()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.endOf()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  sum: name({
    doc: "'.sum()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    elements: "number",
    returns: "number",
    neverNull: true,
    readsNullAsEmpty: true,
    where: ["value", "group", "window"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $sum: recv }) },
    stream: unsupported("'.sum()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.sum()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.sum();'",
    ),
    group: { args: { sig: "", none: true }, emit: ({ recv }) => slotAggregate("$sum", recv, (a) => ({ $sum: a })) },
    window: { args: { sig: "", none: true }, emit: ({ recv }) => slotAggregate("$sum", recv, (a) => ({ $sum: a })) },
  }),

  mean: name({
    doc: "'.mean()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    elements: "number",
    returns: "number",
    readsNullAsEmpty: true,
    where: ["value", "group", "window"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $avg: recv }) },
    stream: unsupported("'.mean()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.mean()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.mean();'",
    ),
    group: { args: { sig: "", none: true }, emit: ({ recv }) => slotAggregate("$avg", recv, (a) => ({ $avg: a })) },
    window: { args: { sig: "", none: true }, emit: ({ recv }) => slotAggregate("$avg", recv, (a) => ({ $avg: a })) },
  }),

  max: name({
    doc: "'.max()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "Math"],
    elements: "number",
    returns: { array: "element" },
    readsNullAsEmpty: true,
    where: ["value", "group", "window"],
    filter: viaFallback,
    expr: {
      perFamily: {
        array: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $max: recv }) },
        Math: unsupported(
          "'Math.max(...values)' is not part of JSMQL — the array's own method says the same thing, and one capability gets one spelling. Write '[a, b].max()' or '<array>.max()': '[$.a, $.b].max()'.",
        ),
      },
    },
    stream: unsupported("'.max()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.max()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.max();'",
    ),
    group: { args: { sig: "", none: true }, emit: ({ recv }) => slotAggregate("$max", recv, (a) => ({ $max: a })) },
    window: { args: { sig: "", none: true }, emit: ({ recv }) => slotAggregate("$max", recv, (a) => ({ $max: a })) },
  }),

  min: name({
    doc: "'.min()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "Math"],
    elements: "number",
    returns: { array: "element" },
    readsNullAsEmpty: true,
    where: ["value", "group", "window"],
    filter: viaFallback,
    expr: {
      perFamily: {
        array: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $min: recv }) },
        Math: unsupported(
          "'Math.min(...values)' is not part of JSMQL — the array's own method says the same thing, and one capability gets one spelling. Write '[a, b].min()' or '<array>.min()': '[$.a, $.b].min()'.",
        ),
      },
    },
    stream: unsupported("'.min()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.min()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.min();'",
    ),
    group: { args: { sig: "", none: true }, emit: ({ recv }) => slotAggregate("$min", recv, (a) => ({ $min: a })) },
    window: { args: { sig: "", none: true }, emit: ({ recv }) => slotAggregate("$min", recv, (a) => ({ $min: a })) },
  }),

  sumBy: name({
    doc: "'.sumBy()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    params: ["value"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: "number",
    neverNull: true,
    readsNullAsEmpty: true,
    where: ["value", "group"],
    filter: viaFallback,
    expr: {
      args: { sig: "iteratee", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, iteratee }) => {
        const it = iteratee(args[0]);
        return { $sum: { $map: { input: recv, as: it.as, in: it.in } } };
      },
    },
    stream: unsupported("'.sumBy()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.sumBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.sumBy();'",
    ),
    group: {
      args: { sig: "iteratee", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, iteratee }) => {
        const it = iteratee(args[0]);
        return { $sum: { $sum: { $map: { input: recv, as: it.as, in: it.in } } } };
      },
    },
    window: unsupported("'.sumBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  meanBy: name({
    doc: "'.meanBy()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    params: ["value"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: "number",
    readsNullAsEmpty: true,
    where: ["value", "group"],
    filter: viaFallback,
    expr: {
      args: { sig: "iteratee", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, iteratee }) => {
        const it = iteratee(args[0]);
        return { $avg: { $map: { input: recv, as: it.as, in: it.in } } };
      },
    },
    stream: unsupported("'.meanBy()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.meanBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.meanBy();'",
    ),
    group: {
      args: { sig: "iteratee", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, iteratee }) => {
        const it = iteratee(args[0]);
        return { $avg: { $avg: { $map: { input: recv, as: it.as, in: it.in } } } };
      },
    },
    window: unsupported("'.meanBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  minBy: name({
    doc: "'.minBy()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    params: ["value"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: "element",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "iteratee", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, iteratee, bind }) => {
        const it = iteratee(args[0]);
        const sorted = bind("sorted");
        return {
          $let: {
            vars: {
              [sorted.as]: {
                $sortArray: {
                  input: { $map: { input: recv, as: it.as, in: { k: it.in, v: it.ref } } },
                  sortBy: { k: 1 },
                },
              },
            },
            in: { $getField: { field: "v", input: { $arrayElemAt: [sorted.ref, 0] } } },
          },
        };
      },
    },
    stream: unsupported("'.minBy()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.minBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.minBy();'",
    ),
    group: unsupported("'.minBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.minBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  maxBy: name({
    doc: "'.maxBy()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    params: ["value"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: "element",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "iteratee", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, iteratee, bind }) => {
        const it = iteratee(args[0]);
        const sorted = bind("sorted");
        return {
          $let: {
            vars: {
              [sorted.as]: {
                $sortArray: {
                  input: { $map: { input: recv, as: it.as, in: { k: it.in, v: it.ref } } },
                  sortBy: { k: -1 },
                },
              },
            },
            in: { $getField: { field: "v", input: { $arrayElemAt: [sorted.ref, 0] } } },
          },
        };
      },
    },
    stream: unsupported("'.maxBy()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.maxBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.maxBy();'",
    ),
    group: unsupported("'.maxBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.maxBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  uniq: name({
    restoresDocuments: true,
    doc: "'.uniq()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $setUnion: singleArrayArg(recv) }) },
    stream: { args: { sig: "", none: true }, emit: ({ element }) => keepFirstPer(element().ref) },
    statement: unsupported(
      "'.uniq()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.uniq();'",
    ),
    group: unsupported("'.uniq()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.uniq()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  uniqBy: name({
    restoresDocuments: true,
    doc: "'.uniqBy()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    params: ["value"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
      stream: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair"] },
    },
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: { sig: "iteratee", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, iteratee, bind }) => uniqByReduce(recv, iteratee(args[0]), bind),
    },
    stream: {
      args: { sig: "iteratee", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ args, reshape }) => keepFirstPer(reshape(args[0])),
    },
    statement: unsupported(
      "'.uniqBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.uniqBy();'",
    ),
    group: unsupported("'.uniqBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.uniqBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  sortedUniq: name({
    restoresDocuments: true,
    doc: "'.sortedUniq()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $setUnion: singleArrayArg(recv) }) },
    stream: { args: { sig: "", none: true }, emit: ({ element }) => keepFirstPer(element().ref) },
    statement: unsupported(
      "'.sortedUniq()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.sortedUniq();'",
    ),
    group: unsupported("'.sortedUniq()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.sortedUniq()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  sortedUniqBy: name({
    restoresDocuments: true,
    doc: "'.sortedUniqBy()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    params: ["value"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
      stream: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair"] },
    },
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: { sig: "iteratee", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, iteratee, bind }) => uniqByReduce(recv, iteratee(args[0]), bind),
    },
    stream: {
      args: { sig: "iteratee", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ args, reshape }) => keepFirstPer(reshape(args[0])),
    },
    statement: unsupported(
      "'.sortedUniqBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.sortedUniqBy();'",
    ),
    group: unsupported("'.sortedUniqBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.sortedUniqBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  without: name({
    doc: "'.without()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    returns: { array: "same", stream: "stream" },
    neverNull: "always",
    where: ["value", "stream"],
    elementOnly: {
      when: "always",
      why: "excludes given VALUES, and every element of this stream is a whole document. Unwind the field first — '.flatMap(\"<field>\").without(<values>)' — or drop documents with '.reject(<pred>)'.",
    },
    filter: viaFallback,
    expr: {
      args: { sig: "...values", atLeast: 1, rest: "element" },
      emit: ({ recv, args, value, bind }) => {
        const values = args.map((a) => value(a));
        const item = bind("item");
        return { $filter: { input: recv, as: item.as, cond: { $not: [{ $in: [item.ref, values] }] } } };
      },
    },
    stream: {
      args: { sig: "...values", atLeast: 1, rest: "element" },
      emit: ({ args, predicate, bind }) => {
        const x = bind("x").as;
        const pos = args[0].pos;
        const values: Expr = { type: "ArrayLiteral", elements: args, pos };
        return [{ $match: predicate(arrowOf(x, notOf(callOf(values, "has", [identOf(x, pos)])), pos)) }];
      },
    },
    statement: unsupported(
      "'.without()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.without();'",
    ),
    group: unsupported("'.without()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.without()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  xor: name({
    doc: "'.xor()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "array",
    returns: "array",
    neverNull: "always",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "other", exact: 1, slotType: { 0: "array" } },
      emit: ({ recv, args, value, type }) => {
        const other = listArgument(value, type, args[0]);
        return { $setUnion: [{ $setDifference: [recv, other] }, { $setDifference: [other, recv] }] };
      },
    },
    stream: because("compares against a second array. Compare against a collection with '$$$.<coll>.find(<pred>)'."),
    statement: unsupported(
      "'.xor()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.xor();'",
    ),
    group: unsupported("'.xor()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.xor()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  differenceBy: name({
    doc: "'.differenceBy()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    params: ["value"],
    iterateeSlots: {
      array: { 1: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
      stream: { 1: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair"] },
    },
    returns: { array: "same", stream: "stream" },
    neverNull: "always",
    where: ["value", "stream"],
    elementOnly: {
      when: "always",
      why: "compares each ELEMENT's key against a second array's, and every element of this stream is a whole document. Unwind the field first — '.flatMap(\"<field>\").differenceBy(<list>, <key>)' — or drop documents with '.reject(<pred>)'.",
    },
    filter: viaFallback,
    expr: {
      args: {
        sig: "other, iteratee",
        exact: 2,
        slotType: { 0: "array", 1: ["callback", "string", "object", "array"] },
      },
      emit: ({ recv, args, value, iteratee, bind, type }) => {
        const it = iteratee(args[1]);
        const keys = bind("otherKeys");
        const inOther = { $in: [it.in, keys.ref] };
        return {
          $let: {
            vars: { [keys.as]: iterateeKeys(listArgument(value, type, args[0]), it) },
            in: { $filter: { input: recv, as: it.as, cond: { $not: [inOther] } } },
          },
        };
      },
    },
    stream: {
      args: {
        sig: "other, iteratee",
        exact: 2,
        slotType: { 0: "array", 1: ["callback", "string", "object", "array"] },
      },
      emit: ({ args, reshape, value }) => {
        const key = reshape(args[1]);
        const keys = value(callOf(listOf(args[0]), "map", [args[1]]));
        return [{ $match: { $expr: { $not: { $in: [key, keys] } } } }];
      },
    },
    statement: unsupported(
      "'.differenceBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.differenceBy();'",
    ),
    group: unsupported("'.differenceBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.differenceBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  intersectionBy: name({
    restoresDocuments: true,
    doc: "'.intersectionBy()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    params: ["value"],
    iterateeSlots: {
      array: { 1: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
      stream: { 1: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair"] },
    },
    returns: { array: "same", stream: "stream" },
    neverNull: "always",
    where: ["value", "stream"],
    elementOnly: {
      when: "always",
      why: "compares each ELEMENT's key against a second array's, and every element of this stream is a whole document. Unwind the field first — '.flatMap(\"<field>\").intersectionBy(<list>, <key>)' — or keep documents with '.filter(<pred>)'.",
    },
    filter: viaFallback,
    expr: {
      args: {
        sig: "other, iteratee",
        exact: 2,
        slotType: { 0: "array", 1: ["callback", "string", "object", "array"] },
      },
      emit: ({ recv, args, value, iteratee, bind, type }) => {
        const it = iteratee(args[1]);
        const keys = bind("otherKeys");
        const inOther = { $in: [it.in, keys.ref] };
        return {
          $let: {
            vars: { [keys.as]: iterateeKeys(listArgument(value, type, args[0]), it) },
            in: { $filter: { input: recv, as: it.as, cond: inOther } },
          },
        };
      },
    },
    stream: {
      args: {
        sig: "other, iteratee",
        exact: 2,
        slotType: { 0: "array", 1: ["callback", "string", "object", "array"] },
      },
      emit: ({ args, reshape, value }) => {
        const key = reshape(args[1]);
        const keys = value(callOf(listOf(args[0]), "map", [args[1]]));
        return [{ $match: { $expr: { $in: [key, keys] } } }, ...keepFirstPer(key)];
      },
    },
    statement: unsupported(
      "'.intersectionBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.intersectionBy();'",
    ),
    group: unsupported("'.intersectionBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.intersectionBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  unionBy: name({
    doc: "'.unionBy()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "array",
    params: ["value"],
    iterateeSlots: {
      array: { 1: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: "array",
    neverNull: "always",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "other, iteratee",
        exact: 2,
        slotType: { 0: "array", 1: ["callback", "string", "object", "array"] },
      },
      emit: ({ recv, args, value, iteratee, bind, type }) =>
        uniqByReduce({ $concatArrays: [recv, listArgument(value, type, args[0])] }, iteratee(args[1]), bind),
    },
    stream: because("merges a second array. Append another source with '.concat(...)' — that is '$unionWith'."),
    statement: unsupported(
      "'.unionBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.unionBy();'",
    ),
    group: unsupported("'.unionBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.unionBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  xorBy: name({
    doc: "'.xorBy()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "array",
    params: ["value"],
    iterateeSlots: {
      array: { 1: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: "array",
    neverNull: "always",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "other, iteratee",
        exact: 2,
        slotType: { 0: "array", 1: ["callback", "string", "object", "array"] },
      },
      emit: ({ recv, args, value, iteratee, bind, type }) => {
        const it = iteratee(args[1]);
        const other = listArgument(value, type, args[0]);
        const a = bind("a");
        const b = bind("b");
        const aKeys = bind("aKeys");
        const bKeys = bind("bKeys");
        const aNotInB = { $filter: { input: a.ref, as: it.as, cond: { $not: [{ $in: [it.in, bKeys.ref] }] } } };
        const bNotInA = { $filter: { input: b.ref, as: it.as, cond: { $not: [{ $in: [it.in, aKeys.ref] }] } } };
        return {
          $let: {
            vars: { [a.as]: recv, [b.as]: other },
            in: {
              $let: {
                vars: { [aKeys.as]: iterateeKeys(a.ref, it), [bKeys.as]: iterateeKeys(b.ref, it) },
                in: uniqByReduce({ $concatArrays: [aNotInB, bNotInA] }, it, bind),
              },
            },
          },
        };
      },
    },
    stream: because("compares against a second array. Compare against a collection with '$$.<coll>.find(<pred>)'."),
    statement: unsupported(
      "'.xorBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.xorBy();'",
    ),
    group: unsupported("'.xorBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.xorBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  compact: name({
    doc: "'.compact()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    elementOnly: {
      when: "always",
      why: "drops falsy elements, and a whole document is never falsy. Unwind the field first — '.flatMap(\"<field>\").compact()' — or drop documents with '.reject(<pred>)'.",
    },
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, bind, elementTruth }) => {
        const item = bind("item");
        return { $filter: { input: recv, as: item.as, cond: elementTruth(item.ref) } };
      },
    },
    stream: {
      args: { sig: "", none: true },
      emit: ({ element }) => [{ $match: { [element().path]: { $nin: [null, 0, false, ""] } } }],
    },
    statement: unsupported(
      "'.compact()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.compact();'",
    ),
    group: unsupported("'.compact()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.compact()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  flatten: name({
    doc: "'.flatten()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "array",
    returns: { arrayOf: { elementOf: "element" } },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv }) => ({
        $reduce: {
          input: recv,
          initialValue: [],
          in: { $concatArrays: ["$$value", { $cond: [{ $isArray: "$$this" }, "$$this", ["$$this"]] }] },
        },
      }),
    },
    stream: because(
      "flattens nested ARRAYS; a stream holds documents. Use '.flatMap(d => d.<field>)' to expand an array field into documents.",
    ),
    statement: unsupported(
      "'.flatten()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.flatten();'",
    ),
    group: unsupported("'.flatten()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.flatten()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  chunk: name({
    doc: "'.chunk()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    returns: { arrayOf: "same" },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "size", exact: 1, constant: [0], slotType: { 0: "int" }, slotRange: { 0: [1, Infinity] } },
      emit: ({ recv, args, value, bind, present }) => {
        const size = value(args[0]);
        const i = bind("i");
        const n = sizeOf(present ? recv : arrayOrEmpty(recv));
        return { $map: { input: { $range: [0, n, size] }, as: i.as, in: { $slice: [recv, i.ref, size] } } };
      },
    },
    stream: because(
      "groups elements into ARRAYS of n, so the result is a stream of arrays, not documents. Collect into one document first: '$$ = [{ all: $$.map(d => d) }];'.",
    ),
    statement: unsupported(
      "'.chunk()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.chunk();'",
    ),
    group: unsupported("'.chunk()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.chunk()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  take: name({
    doc: "'.take()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: { sig: "[n=1]", allowed: [0, 1], slotType: { 0: "int" }, slotRange: { 0: [0, Infinity] } },
      emit: ({ recv, args, value }) => ({ $slice: [recv, args.length === 0 ? 1 : value(args[0])] }),
    },
    stream: {
      args: {
        sig: "[n=1]",
        allowed: [0, 1],
        slotType: { 0: "int" },
        constant: [0],
        slotRange: { 0: [0, Number.MAX_SAFE_INTEGER] },
      },
      emit: ({ args }) => {
        const count = args.length === 0 ? 1 : n(args[0]);
        return count === 0 ? [{ $match: { $expr: false } }] : [{ $limit: count }];
      },
    },
    statement: unsupported(
      "'.take()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.take();'",
    ),
    group: unsupported("'.take()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.take()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  drop: name({
    doc: "'.drop()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: { sig: "[n=1]", allowed: [0, 1], slotType: { 0: "int" }, slotRange: { 0: [0, Infinity] } },
      emit: ({ recv, args, value, bind }) => {
        const n = args.length === 0 ? 1 : value(args[0]);
        const arr = bind("arr");
        return { $let: { vars: { [arr.as]: recv }, in: { $slice: [arr.ref, n, { $max: [1, { $size: arr.ref }] }] } } };
      },
    },
    stream: {
      args: {
        sig: "[n=1]",
        allowed: [0, 1],
        slotType: { 0: "int" },
        constant: [0],
        slotRange: { 0: [0, Number.MAX_SAFE_INTEGER] },
      },
      emit: ({ args }) => {
        const count = args.length === 0 ? 1 : n(args[0]);
        return count === 0 ? [] : [{ $skip: count }];
      },
    },
    statement: unsupported(
      "'.drop()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.drop();'",
    ),
    group: unsupported("'.drop()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.drop()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  takeRight: name({
    doc: "'.takeRight()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "array",
    returns: "array",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "[n=1]", allowed: [0, 1], slotType: { 0: "int" }, slotRange: { 0: [0, Infinity] } },
      emit: ({ recv, args, value }) => ({ $slice: [recv, negate(args.length === 0 ? 1 : value(args[0]))] }),
    },
    stream: because(
      "counts from the END, which needs the whole stream buffered. Sort by the opposite key and use '.take(n)'.",
    ),
    statement: unsupported(
      "'.takeRight()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.takeRight();'",
    ),
    group: unsupported("'.takeRight()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.takeRight()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  dropRight: name({
    doc: "'.dropRight()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    returns: "array",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "[n=1]", allowed: [0, 1], slotType: { 0: "int" }, slotRange: { 0: [0, Infinity] } },
      emit: ({ recv, args, value, bind, present }) => {
        const n = args.length === 0 ? 1 : value(args[0]);
        const arr = bind("arr");
        const keep = { $max: [0, { $subtract: [sizeOf(present ? arr.ref : arrayOrEmpty(arr.ref)), n] }] };
        return { $let: { vars: { [arr.as]: recv }, in: { $slice: [arr.ref, keep] } } };
      },
    },
    stream: because("counts from the END. Sort by the opposite key and use '.drop(n)'."),
    statement: unsupported(
      "'.dropRight()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.dropRight();'",
    ),
    group: unsupported("'.dropRight()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.dropRight()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  tail: name({
    doc: "'.tail()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, bind }) => {
        const arr = bind("arr");
        return { $let: { vars: { [arr.as]: recv }, in: { $slice: [arr.ref, 1, { $max: [1, { $size: arr.ref }] }] } } };
      },
    },
    stream: { args: { sig: "", none: true }, emit: () => [{ $skip: 1 }] },
    statement: unsupported(
      "'.tail()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.tail();'",
    ),
    group: unsupported("'.tail()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.tail()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  initial: name({
    doc: "'.initial()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    returns: "array",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, bind, present }) => {
        const arr = bind("arr");
        const n = sizeOf(present ? arr.ref : arrayOrEmpty(arr.ref));
        return { $let: { vars: { [arr.as]: recv }, in: { $slice: [arr.ref, { $max: [0, { $subtract: [n, 1] }] }] } } };
      },
    },
    stream: because(
      "drops the LAST element, which needs the whole stream buffered. Sort by the opposite key and use '.drop(1)'.",
    ),
    statement: unsupported(
      "'.initial()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.initial();'",
    ),
    group: unsupported("'.initial()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.initial()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  head: name({
    doc: "'.head()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    returns: "element",
    where: ["value", "group", "window"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => firstOf(recv) },
    stream: unsupported("'.head()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.head()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.head();'",
    ),
    group: { args: { sig: "", none: true }, emit: ({ recv }) => slotAggregate("$first", recv, firstOf) },
    window: { args: { sig: "", none: true }, emit: ({ recv }) => slotAggregate("$first", recv, firstOf) },
  }),

  first: name({
    doc: "'.first()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    returns: "element",
    where: ["value", "group", "window"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => firstOf(recv) },
    stream: unsupported("'.first()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.first()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.first();'",
    ),
    group: { args: { sig: "", none: true }, emit: ({ recv }) => slotAggregate("$first", recv, firstOf) },
    window: { args: { sig: "", none: true }, emit: ({ recv }) => slotAggregate("$first", recv, firstOf) },
  }),

  last: name({
    doc: "'.last()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    returns: "element",
    where: ["value", "group", "window"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => lastOf(recv) },
    stream: unsupported("'.last()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.last()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.last();'",
    ),
    group: { args: { sig: "", none: true }, emit: ({ recv }) => slotAggregate("$last", recv, lastOf) },
    window: { args: { sig: "", none: true }, emit: ({ recv }) => slotAggregate("$last", recv, lastOf) },
  }),

  nth: name({
    doc: "'.nth()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    sibling: { string: "For one character, write '.charAt(index)'." },
    returns: "element",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "[n=0]", allowed: [0, 1], slotType: { 0: "int" } },
      emit: ({ recv, args, value }) => ({ $arrayElemAt: [recv, args[0] === undefined ? 0 : value(args[0])] }),
    },
    stream: unsupported("'.nth()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.nth()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.nth();'",
    ),
    group: unsupported("'.nth()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.nth()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  size: name({
    doc: "'.size()' — the number of elements of an array, or the document count of the stream. See docs/LANGUAGE.md.",
    call: true,
    on: ["array", "stream"],
    sibling: {
      string: "For the number of characters, write '.length()'.",
      object: "For the number of fields, write '.keys().size()'.",
    },
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: {
      perFamily: {
        array: viaFallback,
        stream: unsupported(
          "'$$.size()' (the current stream's document count) needs Pipeline mode — it materialises a '$setWindowFields' stage. Use it inside a pipeline (for example `({ $ }) => { $.n = $$.size(); … }`); it has no meaning in a Filter or in 'jsmql.expr'.",
        ),
      },
    },
    expr: {
      perFamily: {
        array: {
          args: { sig: "", none: true },
          emit: ({ recv, present }) => sizeOf(present || Array.isArray(recv) ? recv : arrayOrEmpty(recv)),
        },
        stream: {
          args: { sig: "", none: true },
          emit: ({ hoist }) => hoist([{ $setWindowFields: { output: { [SIZE_SLOT]: { $count: {} } } } }], SIZE_SLOT),
        },
      },
    },
    stream: unsupported("'size' is a value, not a stage. Read it: '$.n = $$.size()'."),
    statement: unsupported(
      "'.size()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.size();'",
    ),
    group: unsupported("'.size()' is not an accumulator. Use '$count' or '$sum' inside '$group'."),
    window: unsupported("'.size()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  takeWhile: name({
    doc: "'.takeWhile()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    params: ["value"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
      stream: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair"] },
    },
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    only: ["afterSort"],
    filter: viaFallback,
    expr: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, predicate, bind }) => {
        const p = predicate(args[0]);
        return takeDropWhile(recv, p, false, bind);
      },
    },
    stream: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ args, condition, sortedBy, slot }) => {
        const flag = slot();
        return [
          {
            $setWindowFields: {
              sortBy: sortedBy(),
              output: {
                [flag]: {
                  $max: { $cond: [condition(args[0]), 0, 1] },
                  window: { documents: ["unbounded", "current"] },
                },
              },
            },
          },
          { $match: { [flag]: 0 } },
        ];
      },
    },
    statement: unsupported(
      "'.takeWhile()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.takeWhile();'",
    ),
    group: unsupported("'.takeWhile()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.takeWhile()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  dropWhile: name({
    doc: "'.dropWhile()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    params: ["value"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
      stream: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair"] },
    },
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    only: ["afterSort"],
    filter: viaFallback,
    expr: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, predicate, bind }) => {
        const p = predicate(args[0]);
        return takeDropWhile(recv, p, true, bind);
      },
    },
    stream: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ args, condition, sortedBy, slot }) => {
        const flag = slot();
        return [
          {
            $setWindowFields: {
              sortBy: sortedBy(),
              output: {
                [flag]: {
                  $max: { $cond: [condition(args[0]), 0, 1] },
                  window: { documents: ["unbounded", "current"] },
                },
              },
            },
          },
          { $match: { [flag]: 1 } },
        ];
      },
    },
    statement: unsupported(
      "'.dropWhile()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.dropWhile();'",
    ),
    group: unsupported("'.dropWhile()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.dropWhile()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  takeRightWhile: name({
    doc: "'.takeRightWhile()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "array",
    params: ["value"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: "array",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, predicate, bind }) => {
        const p = predicate(args[0]);
        return reverseArrayOf(takeDropWhile(reverseArrayOf(recv), p, false, bind));
      },
    },
    stream: because("scans from the END. Sort by the opposite key and use '.takeWhile(<pred>)'."),
    statement: unsupported(
      "'.takeRightWhile()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.takeRightWhile();'",
    ),
    group: unsupported("'.takeRightWhile()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.takeRightWhile()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  dropRightWhile: name({
    doc: "'.dropRightWhile()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "array",
    params: ["value"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: "array",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, predicate, bind }) => {
        const p = predicate(args[0]);
        return reverseArrayOf(takeDropWhile(reverseArrayOf(recv), p, true, bind));
      },
    },
    stream: because("scans from the END. Sort by the opposite key and use '.dropWhile(<pred>)'."),
    statement: unsupported(
      "'.dropRightWhile()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.dropRightWhile();'",
    ),
    group: unsupported("'.dropRightWhile()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.dropRightWhile()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  sample: name({
    doc: "'.sample()' — see docs/LANGUAGE.md.",
    call: true,
    on: ["array", "stream"],
    returns: { array: "element", stream: "stream" },
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "",
        none: true,
        reject: {
          1: "'.sample()' takes no arguments. It returns one random element. For n elements write '.sampleSize(n)'.",
        },
      },
      emit: ({ recv, bind, present }) => {
        const arr = bind("arr");
        const n = sizeOf(present ? arr.ref : arrayOrEmpty(arr.ref));
        return {
          $let: {
            vars: { [arr.as]: recv },
            in: { $arrayElemAt: [arr.ref, { $floor: { $multiply: [{ $rand: {} }, n] } }] },
          },
        };
      },
    },
    stream: {
      args: {
        sig: "",
        none: true,
        reject: {
          1: "'.sample()' takes no arguments. It keeps one random document. For n documents write '.sampleSize(n)'.",
        },
      },
      emit: () => [{ $sample: { size: 1 } }],
    },
    statement: unsupported(
      "'.sample()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.sample();'",
    ),
    group: unsupported("'.sample()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.sample()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  sampleSize: name({
    doc: "'.sampleSize()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: { sig: "[n=1]", allowed: [0, 1], slotType: { 0: "int" }, slotRange: { 0: [0, Infinity] } },
      emit: ({ recv, args, value, bind }) => {
        const n = args.length === 0 ? 1 : value(args[0]);
        const shuf = bind("shuffled");
        const item = bind("item");
        return {
          $let: {
            vars: {
              [shuf.as]: {
                $sortArray: {
                  input: { $map: { input: recv, as: item.as, in: { k: { $rand: {} }, v: item.ref } } },
                  sortBy: { k: 1 },
                },
              },
            },
            in: { $map: { input: { $slice: [shuf.ref, n] }, as: item.as, in: `${item.ref}.v` } },
          },
        };
      },
    },
    stream: {
      args: {
        sig: "[n=1]",
        allowed: [0, 1],
        slotType: { 0: "int" },
        constant: [0],
        slotRange: { 0: [1, Number.MAX_SAFE_INTEGER] },
      },
      emit: ({ args }) => [{ $sample: { size: args.length === 0 ? 1 : n(args[0]) } }],
    },
    statement: unsupported(
      "'.sampleSize()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.sampleSize();'",
    ),
    group: unsupported("'.sampleSize()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.sampleSize()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  zipObject: name({
    doc: "'.zipObject()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    returns: "object",
    neverNull: "always",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "values", exact: 1, slotType: { 0: "array" } },
      emit: ({ recv, args, value, bind, present }) => {
        const values = value(args[0]);
        const i = bind("i");
        return {
          $arrayToObject: {
            $map: {
              input: { $range: [0, sizeOf(present ? recv : arrayOrEmpty(recv))] },
              as: i.as,
              in: { k: { $toString: { $arrayElemAt: [recv, i.ref] } }, v: { $arrayElemAt: [values, i.ref] } },
            },
          },
        };
      },
    },
    stream: because("builds ONE object from keys and values, so the result is a value, not a stream."),
    statement: unsupported(
      "'.zipObject()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.zipObject();'",
    ),
    group: unsupported("'.zipObject()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.zipObject()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  zip: name({
    doc: "'.zip()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "array",
    returns: { arrayOf: "array" },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "...arrays", atLeast: 1, rest: "array" },
      emit: ({ recv, args, value }) => ({
        $zip: { inputs: [recv, ...args.map((a) => value(a))], useLongestLength: true },
      }),
    },
    stream: because(
      "pairs elements positionally across arrays. A stream has no positions to pair on — join on a key instead with '$$$.<coll>.find(<pred>)'.",
    ),
    statement: unsupported(
      "'.zip()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.zip();'",
    ),
    group: unsupported("'.zip()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.zip()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  unzip: name({
    doc: "'.unzip()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    returns: { arrayOf: "array" },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, bind }) => {
        const t = bind("t");
        const j = bind("j");
        const row = bind("row");
        return {
          $let: {
            vars: { [t.as]: recv },
            in: {
              $map: {
                input: { $range: [0, { $size: { $ifNull: [{ $arrayElemAt: [t.ref, 0] }, []] } }] },
                as: j.as,
                in: { $map: { input: t.ref, as: row.as, in: { $arrayElemAt: [row.ref, j.ref] } } },
              },
            },
          },
        };
      },
    },
    stream: because("transposes into ONE array of arrays, so the result is a value, not a stream."),
    statement: unsupported(
      "'.unzip()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.unzip();'",
    ),
    group: unsupported("'.unzip()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.unzip()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  zipWith: name({
    doc: "'.zipWith()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "array",
    params: ["value"],
    iterateeSlots: {
      array: { arrowOnly: "the callback takes one parameter per zipped array and a shorthand cannot stand in for it" },
    },
    returns: { arrayOf: "array" },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "...arrays, iteratee", atLeast: 2, rest: ["array", "callback"] },
      emit: ({ recv, args, value, elements }) => {
        const arrays = [recv, ...args.slice(0, -1).map(value)];
        const cb = elements(args[args.length - 1], arrays.length);
        return { $map: { input: { $zip: { inputs: arrays, useLongestLength: true } }, as: cb.as, in: cb.in } };
      },
    },
    stream: because("pairs elements positionally across arrays. Join on a key with '$$.<coll>.find(<pred>)'."),
    statement: unsupported(
      "'.zipWith()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.zipWith();'",
    ),
    group: unsupported("'.zipWith()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.zipWith()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  unzipWith: name({
    doc: "'.unzipWith()' has no MongoDB form. See its refusal.",
    call: true,
    on: "array",
    returns: "unknown",
    where: [],
    filter: unsupported(
      ".unzipWith(fn) isn't supported — its iteratee's argument count depends on the array's length at runtime. Write '.unzip().map(group => …)' instead, where 'group' is one unzipped column.",
    ),
    expr: unsupported(
      ".unzipWith(fn) isn't supported — its iteratee's argument count depends on the array's length at runtime. Write '.unzip().map(group => …)' instead, where 'group' is one unzipped column.",
    ),
    stream: unsupported(
      ".unzipWith(fn) isn't supported — its iteratee's argument count depends on the array's length at runtime. Write '.unzip().map(group => …)' instead, where 'group' is one unzipped column.",
    ),
    statement: unsupported(
      ".unzipWith(fn) isn't supported — its iteratee's argument count depends on the array's length at runtime. Write '.unzip().map(group => …)' instead, where 'group' is one unzipped column.",
    ),
    group: unsupported(
      ".unzipWith(fn) isn't supported — its iteratee's argument count depends on the array's length at runtime. Write '.unzip().map(group => …)' instead, where 'group' is one unzipped column.",
    ),
    window: unsupported(
      ".unzipWith(fn) isn't supported — its iteratee's argument count depends on the array's length at runtime. Write '.unzip().map(group => …)' instead, where 'group' is one unzipped column.",
    ),
  }),

  keyBy: name({
    collapses: true,
    doc: "'.keyBy()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    params: ["value"],
    iterateeSlots: {
      array: {
        0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable", "omitted"],
      },
      stream: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "omitted"] },
    },
    returns: { array: { recordOf: "element" }, stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: { sig: "[iteratee]", allowed: [0, 1], slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, iteratee, bind }) => {
        const it = args[0] === undefined ? identity(bind) : iteratee(args[0]);
        return { $arrayToObject: { $map: { input: recv, as: it.as, in: { k: stringKeyExpr(it.in), v: it.ref } } } };
      },
    },
    stream: {
      args: { sig: "[iteratee]", allowed: [0, 1], slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ args, reshape, wholeDocument }) => collapse(reshape(args[0]), { $last: wholeDocument() }),
    },
    statement: unsupported(
      "'.keyBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.keyBy();'",
    ),
    group: unsupported("'.keyBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.keyBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  groupBy: name({
    collapses: true,
    doc: "'.groupBy()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream", "Object"],
    params: ["value"],
    iterateeSlots: {
      array: {
        0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable", "omitted"],
      },
      stream: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "omitted"] },
    },
    returns: { array: { recordOf: "same" }, stream: "stream", Object: { recordOf: { arg: 0 } } },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      perFamily: {
        array: {
          args: { sig: "[iteratee]", allowed: [0, 1], slotType: { 0: ["callback", "string", "object", "array"] } },
          emit: ({ recv, args, iteratee, bind }) =>
            groupedByKey(recv, args[0] === undefined ? identity(bind) : iteratee(args[0]), bind),
        },
        stream: unsupported("'.groupBy()' on a stream is a stage, not a value — see its 'stream' cell."),
        Object: unsupported(
          "'Object.groupBy(items, discriminator)' is not part of JSMQL — the array's own method says the same thing, and one capability gets one spelling. Write '<array>.groupBy(<discriminator>)': '$.items.groupBy(d => d.k)' emits the identical MQL.",
        ),
      },
    },
    stream: {
      args: { sig: "[iteratee]", allowed: [0, 1], slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ args, reshape, wholeDocument }) => collapse(reshape(args[0]), { $push: wholeDocument() }),
    },
    statement: unsupported(
      "'.groupBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.groupBy();'",
    ),
    group: unsupported("'.groupBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.groupBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  countBy: name({
    collapses: true,
    doc: "'.countBy()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    params: ["value"],
    iterateeSlots: {
      array: {
        0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable", "omitted"],
      },
      stream: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "omitted"] },
    },
    returns: { array: { recordOf: "number" }, stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: { sig: "[iteratee]", allowed: [0, 1], slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, iteratee, bind }) => {
        const it = args[0] === undefined ? identity(bind) : iteratee(args[0]);
        const key = bind("key");
        const filtered = { $filter: { input: recv, as: it.as, cond: { $eq: [stringKeyExpr(it.in), key.ref] } } };
        return {
          $arrayToObject: {
            $map: { input: distinctKeysExpr(recv, it), as: key.as, in: { k: key.ref, v: { $size: filtered } } },
          },
        };
      },
    },
    stream: {
      args: { sig: "[iteratee]", allowed: [0, 1], slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ args, reshape }) => collapse(reshape(args[0]), { $sum: 1 }),
    },
    statement: unsupported(
      "'.countBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.countBy();'",
    ),
    group: unsupported("'.countBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.countBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  partition: name({
    doc: "'.partition()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    params: ["value"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: { tuple: ["same", "same"] },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, predicate }) => {
        const p = predicate(args[0]);
        return [
          { $filter: { input: recv, as: p.as, cond: p.in } },
          { $filter: { input: recv, as: p.as, cond: { $not: [p.in] } } },
        ];
      },
    },
    stream: unsupported("'.partition()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.partition()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.partition();'",
    ),
    group: unsupported("'.partition()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.partition()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  reject: name({
    doc: "'.reject()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    params: ["value"],
    iterateeSlots: {
      array: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
      stream: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair"] },
    },
    returns: { array: "same", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, predicate }) => {
        const p = predicate(args[0]);
        return { $filter: { input: recv, as: p.as, cond: { $not: [p.in] } } };
      },
    },
    stream: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ args, predicate }) => [{ $match: { $nor: [predicate(args[0])] } }],
    },
    statement: unsupported(
      "'.reject()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.reject();'",
    ),
    group: unsupported("'.reject()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.reject()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  mapValues: name({
    doc: "'.mapValues()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "object",
    params: ["value", "key"],
    iterateeSlots: {
      object: {
        arrowOnly: "the callback takes (value, key) and a shorthand cannot stand in for a two-parameter arrow",
      },
    },
    returns: { recordOf: { callback: 0 } },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "iteratee", exact: 1, slotType: { 0: "callback" } },
      emit: ({ recv, args, objIteratee, present }) => {
        const it = objIteratee(args[0], "value");
        return {
          $arrayToObject: {
            $map: { input: pairsOfObject(recv, present), as: it.as, in: { k: `${it.ref}.k`, v: it.body } },
          },
        };
      },
    },
    stream: unsupported("'.mapValues()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.mapValues()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.mapValues();'",
    ),
    group: unsupported("'.mapValues()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.mapValues()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  mapKeys: name({
    doc: "'.mapKeys()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "object",
    params: ["value", "key"],
    iterateeSlots: {
      object: {
        arrowOnly: "the callback takes (value, key) and a shorthand cannot stand in for a two-parameter arrow",
      },
    },
    returns: { recordOf: { elementOf: "same" } },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "iteratee", exact: 1, slotType: { 0: "callback" } },
      emit: ({ recv, args, objIteratee, present }) => {
        const it = objIteratee(args[0], "value");
        return {
          $arrayToObject: {
            $map: {
              input: pairsOfObject(recv, present),
              as: it.as,
              in: { k: { $toString: it.body }, v: `${it.ref}.v` },
            },
          },
        };
      },
    },
    stream: unsupported("'.mapKeys()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.mapKeys()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.mapKeys();'",
    ),
    group: unsupported("'.mapKeys()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.mapKeys()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  pick: name({
    doc: "'.pick()' — see docs/LANGUAGE.md.",
    call: true,
    on: ["object", "stream"],
    returns: { object: "picked", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: { sig: "[keys]", exact: 1, slotType: { 0: "array" }, arrayOf: { 0: "fieldName" } },
      emit: ({ recv, args, bind, value, present, type }) => {
        const keys = spelledKeys(args[0]);
        if (keys === null) {
          const kv = bind("kv");
          return {
            $arrayToObject: {
              $filter: {
                input: pairsOfObject(recv, present),
                as: kv.as,
                cond: { $in: [`${kv.ref}.k`, listArgument(value, type, args[0])] },
              },
            },
          };
        }
        const obj = bind("obj");
        const out: Record<string, unknown> = {};
        for (const k of keys) setKey(out, k, { $getField: { field: k, input: obj.ref } });
        return { $let: { vars: { [obj.as]: recv }, in: out } };
      },
    },
    stream: {
      args: { sig: "[keys]", exact: 1, slotType: { 0: "array" }, arrayOf: { 0: "fieldName" }, constant: [0] },
      emit: ({ args, value, element }) => {
        const at = element().path;
        const keys = value(args[0]) as string[];
        if (keys.length === 0) {
          const empty =
            at === "" ? {} : at.split(".").reduceRight<Record<string, unknown>>((inner, s) => setKey({}, s, inner), {});
          return [{ $replaceWith: empty }];
        }
        return [
          {
            $project: Object.fromEntries([
              ...keys.map((k) => [at === "" ? k : `${at}.${k}`, 1]),
              ...(keys.includes("_id") ? [] : [["_id", 0]]),
            ]),
          },
        ];
      },
    },
    statement: unsupported(
      "'.pick()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.pick();'",
    ),
    group: unsupported("'.pick()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.pick()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  omit: name({
    doc: "'.omit()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["object", "stream"],
    returns: { object: "omitted", stream: "stream" },
    neverNull: true,
    where: ["value", "stream"],
    filter: viaFallback,
    expr: {
      args: { sig: "[keys]", exact: 1, slotType: { 0: "array" }, arrayOf: { 0: "fieldName" } },
      emit: ({ recv, args, bind, value, present, type }) => {
        const spelled = spelledKeys(args[0]);
        const keys = spelled ?? listArgument(value, type, args[0]);
        const kv = bind("kv");
        return {
          $arrayToObject: {
            $filter: {
              input: pairsOfObject(recv, present),
              as: kv.as,
              cond: { $not: [{ $in: [`${kv.ref}.k`, keys] }] },
            },
          },
        };
      },
    },
    stream: {
      args: { sig: "[keys]", exact: 1, slotType: { 0: "array" }, arrayOf: { 0: "fieldName" }, constant: [0] },
      emit: ({ args, value, element }) => {
        const at = element().path;
        const keys = value(args[0]) as string[];
        if (keys.length === 0) return [];
        return [{ $project: Object.fromEntries(keys.map((k) => [at === "" ? k : `${at}.${k}`, 0])) }];
      },
    },
    statement: unsupported(
      "'.omit()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.omit();'",
    ),
    group: unsupported("'.omit()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.omit()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  pickBy: name({
    doc: "'.pickBy()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "object",
    params: ["value", "key"],
    iterateeSlots: {
      object: {
        arrowOnly: "the callback takes (value, key) and a shorthand cannot stand in for a two-parameter arrow",
      },
    },
    returns: "object",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "predicate", exact: 1, slotType: { 0: "callback" } },
      emit: ({ recv, args, objIteratee, present }) => {
        const it = objIteratee(args[0], "truth");
        return { $arrayToObject: { $filter: { input: pairsOfObject(recv, present), as: it.as, cond: it.body } } };
      },
    },
    stream: unsupported("'.pickBy()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.pickBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.pickBy();'",
    ),
    group: unsupported("'.pickBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.pickBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  omitBy: name({
    doc: "'.omitBy()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "object",
    params: ["value", "key"],
    iterateeSlots: {
      object: {
        arrowOnly: "the callback takes (value, key) and a shorthand cannot stand in for a two-parameter arrow",
      },
    },
    returns: "object",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "predicate", exact: 1, slotType: { 0: "callback" } },
      emit: ({ recv, args, objIteratee, present }) => {
        const it = objIteratee(args[0], "truth");
        return {
          $arrayToObject: { $filter: { input: pairsOfObject(recv, present), as: it.as, cond: { $not: [it.body] } } },
        };
      },
    },
    stream: unsupported("'.omitBy()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.omitBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.omitBy();'",
    ),
    group: unsupported("'.omitBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.omitBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  findKey: name({
    doc: "'.findKey()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "object",
    params: ["value", "key"],
    iterateeSlots: {
      object: { 0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable"] },
    },
    returns: "string",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "predicate", exact: 1, slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, objIteratee, present }) => {
        const it = objIteratee(args[0], "truth");
        const hit = { $first: { $filter: { input: pairsOfObject(recv, present), as: it.as, cond: it.body } } };
        return { $getField: { field: "k", input: hit } };
      },
    },
    stream: unsupported("'.findKey()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.findKey()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.findKey();'",
    ),
    group: unsupported("'.findKey()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.findKey()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  invert: name({
    doc: "'.invert()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "object",
    returns: "object",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, bind, present }) => {
        const kv = bind("kv");
        return {
          $arrayToObject: {
            $map: {
              input: pairsOfObject(recv, present),
              as: kv.as,
              in: { k: { $toString: `${kv.ref}.v` }, v: `${kv.ref}.k` },
            },
          },
        };
      },
    },
    stream: unsupported("'.invert()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.invert()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.invert();'",
    ),
    group: unsupported("'.invert()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.invert()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  invertBy: name({
    doc: "'.invertBy()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "object",
    params: ["value"],
    iterateeSlots: {
      object: {
        0: ["propertyPath", "propertyIndex", "matchesObject", "matchesPropertyPair", "bareCallable", "omitted"],
      },
    },
    returns: { recordOf: { arrayOf: "string" } },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "[iteratee]", allowed: [0, 1], slotType: { 0: ["callback", "string", "object", "array"] } },
      emit: ({ recv, args, iteratee, bind, present }) =>
        invertedByKey(pairsOfObject(recv, present), args[0] === undefined ? identity(bind) : iteratee(args[0]), bind),
    },
    stream: unsupported("'.invertBy()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.invertBy()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.invertBy();'",
    ),
    group: unsupported("'.invertBy()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.invertBy()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  toPairs: name({
    doc: "'.toPairs()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "object",
    returns: { arrayOf: { tuple: ["string", { elementOf: "same" }] } },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, present }) => {
        return { $map: { input: pairsOfObject(recv, present), in: ["$$this.k", "$$this.v"] } };
      },
    },
    stream: unsupported("'.toPairs()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.toPairs()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.toPairs();'",
    ),
    group: unsupported("'.toPairs()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.toPairs()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  fromPairs: name({
    doc: "'.fromPairs()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "array",
    returns: { recordOf: { itemOf: ["element", 1] } },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => pairsToObject(recv) },
    stream: because("builds ONE object from pairs, so the result is a value, not a stream."),
    statement: unsupported(
      "'.fromPairs()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.fromPairs();'",
    ),
    group: unsupported("'.fromPairs()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.fromPairs()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  capitalize: name({
    doc: "'.capitalize()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv, present }) => capitalizeExpr(recv, present) },
    stream: unsupported("'.capitalize()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.capitalize()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.capitalize();'",
    ),
    group: unsupported("'.capitalize()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.capitalize()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  upperFirst: name({
    doc: "'.upperFirst()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv, present }) => firstCharExpr(recv, "$toUpper", present) },
    stream: unsupported("'.upperFirst()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.upperFirst()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.upperFirst();'",
    ),
    group: unsupported("'.upperFirst()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.upperFirst()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  lowerFirst: name({
    doc: "'.lowerFirst()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv, present }) => firstCharExpr(recv, "$toLower", present) },
    stream: unsupported("'.lowerFirst()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.lowerFirst()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.lowerFirst();'",
    ),
    group: unsupported("'.lowerFirst()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.lowerFirst()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  words: name({
    doc: "'.words()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: { arrayOf: "string" },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv, bind }) => wordsExpr(recv, bind) },
    stream: unsupported("'.words()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.words()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.words();'",
    ),
    group: unsupported("'.words()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.words()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  kebabCase: name({
    doc: "'.kebabCase()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, bind }) => ({ $toLower: joinWords(wordsExpr(recv, bind), "-", bind) }),
    },
    stream: unsupported("'.kebabCase()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.kebabCase()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.kebabCase();'",
    ),
    group: unsupported("'.kebabCase()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.kebabCase()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  snakeCase: name({
    doc: "'.snakeCase()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, bind }) => ({ $toLower: joinWords(wordsExpr(recv, bind), "_", bind) }),
    },
    stream: unsupported("'.snakeCase()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.snakeCase()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.snakeCase();'",
    ),
    group: unsupported("'.snakeCase()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.snakeCase()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  lowerCase: name({
    doc: "'.lowerCase()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, bind }) => ({ $toLower: joinWords(wordsExpr(recv, bind), " ", bind) }),
    },
    stream: unsupported("'.lowerCase()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.lowerCase()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.lowerCase();'",
    ),
    group: unsupported("'.lowerCase()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.lowerCase()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  upperCase: name({
    doc: "'.upperCase()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, bind }) => ({ $toUpper: joinWords(wordsExpr(recv, bind), " ", bind) }),
    },
    stream: unsupported("'.upperCase()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.upperCase()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.upperCase();'",
    ),
    group: unsupported("'.upperCase()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.upperCase()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  startCase: name({
    doc: "'.startCase()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, bind }) => joinWords(wordsExpr(recv, bind), " ", bind, capitalizeExpr),
    },
    stream: unsupported("'.startCase()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.startCase()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.startCase();'",
    ),
    group: unsupported("'.startCase()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.startCase()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  camelCase: name({
    doc: "'.camelCase()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, bind }) => {
        const p = bind("pascal");
        return {
          $let: {
            vars: { [p.as]: joinWords(wordsExpr(recv, bind), "", bind, capitalizeExpr) },
            in: firstCharExpr(p.ref, "$toLower"),
          },
        };
      },
    },
    stream: unsupported("'.camelCase()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.camelCase()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.camelCase();'",
    ),
    group: unsupported("'.camelCase()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.camelCase()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  escape: name({
    doc: "'.escape()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ recv }) => escapeHtmlExpr(recv) },
    stream: unsupported("'.escape()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.escape()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.escape();'",
    ),
    group: unsupported("'.escape()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.escape()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  truncate: name({
    doc: "'.truncate()' — see docs/LANGUAGE.md.",
    call: true,
    on: "string",
    returns: "string",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "[{ length, omission }]",
        allowed: [0, 1],
        slotType: { 0: "object" },
        body: {
          0: {
            required: [],
            optional: ["length", "omission"],
            closed: true,
            keyTypes: { length: "number", omission: "string" },
            constantKeys: ["length", "omission"],
          },
        },
      },
      emit: ({ recv, args, bind, present }) => {
        let length = 30;
        let omission = "...";
        if (args[0]?.type === "ObjectLiteral") {
          for (const e of args[0].entries) {
            if (e.type !== "KeyValueEntry" || e.key.kind !== "static") continue;
            if (e.key.name === "length" && e.value.type === "NumberLiteral") length = e.value.value;
            if (e.key.name === "omission" && e.value.type === "StringLiteral") omission = e.value.value;
          }
        }
        const keep = Math.max(0, length - omission.length);
        const s = bind("str");
        return {
          $let: {
            vars: { [s.as]: present ? recv : coerceStringBinding(recv) },
            in: {
              $cond: [
                { $gt: [{ $strLenCP: s.ref }, length] },
                { $concat: [{ $substrCP: [s.ref, 0, keep] }, omission] },
                s.ref,
              ],
            },
          },
        };
      },
    },
    stream: unsupported("'.truncate()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.truncate()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.truncate();'",
    ),
    group: unsupported("'.truncate()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.truncate()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  clamp: name({
    doc: "'.clamp()' — see docs/LANGUAGE.md.",
    call: true,
    on: ["number", "date"],
    returns: "unknown",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "lower, upper", exact: 2, slotType: { 0: "number-or-date", 1: "number-or-date" } },
      emit: ({ recv, args, value, present, kind }) => {
        const lower = value(args[0]);
        const safe = safeOfBounds(kind, args);
        const same = isDate(safe) ? isDate(lower) && lower >= safe : typeof lower === "number" && lower >= 0;
        return { $min: [{ $max: [safeBound(recv, present, safe, same), lower] }, value(args[1])] };
      },
    },
    stream: unsupported("'.clamp()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.clamp()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.clamp();'",
    ),
    group: unsupported("'.clamp()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.clamp()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  inRange: name({
    doc: "'.inRange()' — see docs/LANGUAGE.md.",
    call: true,
    on: ["number", "date"],
    returns: "bool",
    neverNull: true,
    where: ["value", "filter"],
    filter: {
      args: { sig: "[start, ]end", allowed: [1, 2], slotType: { 0: "number-or-date", 1: "number-or-date" } },
      emit: ({ recv, args, pathOf, constant, orMissing }) => {
        const path = recv === null ? null : pathOf(recv);
        if (path === null) return null;
        const given = args.map(constant);
        if (given.some((c) => c === null)) return null;
        const values = given.map((c) => c!.value);
        const bounds = orderedBounds(args.length === 2 ? values[0] : 0, values[values.length - 1]);
        if (bounds === null) return null;
        const test = { $gte: bounds[0], $lt: bounds[1] };
        const safe = isDate(bounds[0]) ? new Date(0) : 0;
        return mayHold(safe, bounds[0], bounds[1]) ? orMissing(path, test) : queryOwnValue(path, test);
      },
    },
    expr: {
      args: { sig: "[start, ]end", allowed: [1, 2], slotType: { 0: "number-or-date", 1: "number-or-date" } },
      emit: ({ recv, args, value, present, kind }) => {
        const lo = args.length === 2 ? value(args[0]) : 0;
        const hi = value(args[args.length === 2 ? 1 : 0]);
        const safe = safeOfBounds(kind, args);
        const r = safeBound(recv, present, safe, !mayHold(safe, lo, hi));
        return { $and: [{ $gte: [r, { $min: [lo, hi] }] }, { $lt: [r, { $max: [lo, hi] }] }] };
      },
    },
    stream: unsupported("'.inRange()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.inRange()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.inRange();'",
    ),
    group: unsupported("'.inRange()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.inRange()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  range: name({
    doc: "'.range()' — see docs/LANGUAGE.md.",
    call: true,
    on: "number",
    returns: { arrayOf: "number" },
    neverNull: "always",
    where: ["value"],
    filter: viaFallback,
    expr: { args: RANGE_ARGS, emit: (input) => rangeOf(input) },
    stream: unsupported("'.range()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.range()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.range();'",
    ),
    group: unsupported("'.range()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.range()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  rangeRight: name({
    doc: "'.rangeRight()' — see docs/LANGUAGE.md.",
    call: true,
    on: "number",
    returns: { arrayOf: "number" },
    neverNull: "always",
    where: ["value"],
    filter: viaFallback,
    expr: { args: RANGE_ARGS, emit: (input) => ({ $reverseArray: rangeOf(input) }) },
    stream: unsupported("'.rangeRight()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.rangeRight()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.rangeRight();'",
    ),
    group: unsupported("'.rangeRight()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.rangeRight()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  round: name({
    doc: "'.round()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: {
          args: { sig: "[precision]", allowed: [0, 1], slotType: { 0: "int" } },
          emit: ({ recv, args, value }) =>
            args[0] === undefined ? { $round: recv } : { $round: [recv, value(args[0])] },
        },
        Math: unsupported(
          "'Math.round(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.round()': '$.n.round()'. In a callback, write 'x => x.round()'.",
        ),
      },
    },
    stream: unsupported("'.round()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.round()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.round();'",
    ),
    group: unsupported("'.round()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.round()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  ceil: name({
    doc: "'.ceil()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: {
          args: { sig: "[precision]", allowed: [0, 1], slotType: { 0: "int" } },
          emit: ({ recv, args, value }) =>
            args.length === 0 ? { $ceil: recv } : atPrecision("$ceil", recv, value(args[0])),
        },
        Math: unsupported(
          "'Math.ceil(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.ceil()': '$.n.ceil()'. In a callback, write 'x => x.ceil()'.",
        ),
      },
    },
    stream: unsupported("'.ceil()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.ceil()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.ceil();'",
    ),
    group: unsupported("'.ceil()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.ceil()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  floor: name({
    doc: "'.floor()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: {
          args: { sig: "[precision]", allowed: [0, 1], slotType: { 0: "int" } },
          emit: ({ recv, args, value }) =>
            args.length === 0 ? { $floor: recv } : atPrecision("$floor", recv, value(args[0])),
        },
        Math: unsupported(
          "'Math.floor(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.floor()': '$.n.floor()'. In a callback, write 'x => x.floor()'.",
        ),
      },
    },
    stream: unsupported("'.floor()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.floor()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.floor();'",
    ),
    group: unsupported("'.floor()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.floor()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  intersection: name({
    restoresDocuments: true,
    doc: "'.intersection()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    returns: { array: "same", stream: "stream" },
    neverNull: "always",
    where: ["value", "stream"],
    elementOnly: {
      when: "always",
      why: "compares each ELEMENT against a second array, and every element of this stream is a whole document. Unwind the field first — '.flatMap(\"<field>\").intersection(<list>)' — or keep documents with '.filter(<pred>)'.",
    },
    filter: viaFallback,
    expr: {
      args: { sig: "other", exact: 1, slotType: { 0: "array" } },
      emit: ({ recv, args, value, type }) => ({ $setIntersection: [recv, listArgument(value, type, args[0])] }),
    },
    stream: {
      args: { sig: "other", exact: 1, slotType: { 0: "array" } },
      emit: ({ args, predicate, bind, element }) => {
        const x = bind("x").as;
        const other = listOf(args[0]);
        return [
          { $match: predicate(arrowOf(x, callOf(other, "has", [identOf(x, other.pos)]), other.pos)) },
          ...keepFirstPer(element().ref),
        ];
      },
    },
    statement: unsupported(
      "'.intersection()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.intersection();'",
    ),
    group: unsupported("'.intersection()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.intersection()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  union: name({
    doc: "'.union()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "array",
    returns: "array",
    neverNull: "always",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "other", exact: 1, slotType: { 0: "array" } },
      emit: ({ recv, args, value, type }) => ({ $setUnion: [recv, listArgument(value, type, args[0])] }),
    },
    stream: because("merges a second array. Append another source with '.concat(...)' — that is '$unionWith'."),
    statement: unsupported(
      "'.union()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.union();'",
    ),
    group: unsupported("'.union()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.union()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  difference: name({
    doc: "'.difference()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["array", "stream"],
    returns: { array: "same", stream: "stream" },
    neverNull: "always",
    where: ["value", "stream"],
    elementOnly: {
      when: "always",
      why: "compares each ELEMENT against a second array, and every element of this stream is a whole document. Unwind the field first — '.flatMap(\"<field>\").difference(<list>)' — or drop documents with '.reject(<pred>)'.",
    },
    filter: viaFallback,
    expr: {
      perFamily: {
        array: {
          args: { sig: "other", exact: 1, slotType: { 0: "array" } },
          emit: ({ recv, args, value, type }) => ({ $setDifference: [recv, listArgument(value, type, args[0])] }),
        },
        stream: unsupported("'.difference()' on a stream is a stage, not a value — see its 'stream' cell."),
      },
    },
    stream: {
      args: { sig: "other", exact: 1, slotType: { 0: "array" } },
      emit: ({ args, predicate, bind }) => {
        const x = bind("x").as;
        const other = listOf(args[0]);
        return [{ $match: predicate(arrowOf(x, notOf(callOf(other, "has", [identOf(x, other.pos)])), other.pos)) }];
      },
    },
    statement: unsupported(
      "'.difference()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.difference();'",
    ),
    group: unsupported("'.difference()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.difference()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  isSubsetOf: name({
    doc: "'.isSubsetOf()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    returns: "bool",
    neverNull: "always",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "other", exact: 1, slotType: { 0: "array" } },
      emit: ({ recv, args, value, present, bind, type }) =>
        nullOr(recv, present, bind, (r) => ({ $setIsSubset: [r, listArgument(value, type, args[0])] })),
    },
    stream: unsupported("'.isSubsetOf()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.isSubsetOf()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.isSubsetOf();'",
    ),
    group: unsupported("'.isSubsetOf()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.isSubsetOf()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  isSupersetOf: name({
    doc: "'.isSupersetOf()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    returns: "bool",
    neverNull: "always",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "other", exact: 1, slotType: { 0: "array" } },
      emit: ({ recv, args, value, present, bind, type }) =>
        nullOr(recv, present, bind, (r) => ({ $setIsSubset: [listArgument(value, type, args[0]), r] })),
    },
    stream: unsupported("'.isSupersetOf()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.isSupersetOf()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.isSupersetOf();'",
    ),
    group: unsupported("'.isSupersetOf()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.isSupersetOf()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  test: name({
    doc: "'.test()' — see docs/LANGUAGE.md.",
    call: true,
    on: "any",
    returns: "bool",
    neverNull: "always",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "str", exact: 1, slotType: { 0: "string" } },
      emit: ({ recv, args, value }) => ({
        $regexMatch: regexBody(value(args[0]), recv as Expr, () => value(recv as Expr)),
      }),
    },
    stream: unsupported("'.test()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.test()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.test();'",
    ),
    group: unsupported("'.test()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.test()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  exec: name({
    doc: "'.exec()' — see docs/LANGUAGE.md.",
    call: true,
    on: "any",
    returns: "unknown",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "str", exact: 1, slotType: { 0: "string" } },
      emit: ({ recv, args, value }) => ({
        $regexFind: regexBody(value(args[0]), recv as Expr, () => value(recv as Expr)),
      }),
    },
    stream: unsupported("'.exec()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.exec()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.exec();'",
    ),
    group: unsupported("'.exec()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.exec()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  $inc: mongo({
    doc: "Increments a field by a number. JSMQL also writes it as JavaScript: '$.views++', '++$.views', '$.views += 2'.",
    where: ["updateDoc"],
    updateDoc: { args: { sig: "fields", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $box: mongo({
    doc: "A rectangle, by its bottom-left and top-right corners.",
    where: ["filter"],
    onlyInside: { filter: ["$geoWithin"] },
    filter: { args: { sig: "shape", exact: 1 }, emit: ({ name, args, literal }) => ({ [name]: literal(args[0]) }) },
  }),

  $center: mongo({
    doc: "A circle on a flat plane, by centre and radius.",
    where: ["filter"],
    onlyInside: { filter: ["$geoWithin"] },
    filter: { args: { sig: "shape", exact: 1 }, emit: ({ name, args, literal }) => ({ [name]: literal(args[0]) }) },
  }),

  $centerSphere: mongo({
    doc: "A circle on a sphere, by centre and radius in radians.",
    where: ["filter"],
    onlyInside: { filter: ["$geoWithin"] },
    filter: { args: { sig: "shape", exact: 1 }, emit: ({ name, args, literal }) => ({ [name]: literal(args[0]) }) },
  }),

  $polygon: mongo({
    doc: "A polygon, by its list of points.",
    where: ["filter"],
    onlyInside: { filter: ["$geoWithin"] },
    filter: { args: { sig: "shape", exact: 1 }, emit: ({ name, args, literal }) => ({ [name]: literal(args[0]) }) },
  }),

  $geometry: mongo({
    doc: "A GeoJSON shape.",
    where: ["filter"],
    onlyInside: { filter: ["$geoWithin", "$geoIntersects", "$near", "$nearSphere"] },
    filter: { args: { sig: "shape", exact: 1 }, emit: ({ name, args, literal }) => ({ [name]: literal(args[0]) }) },
  }),

  $maxDistance: mongo({
    doc: "The furthest a match may be, in metres or radians.",
    where: ["filter"],
    onlyInside: { filter: ["$near", "$nearSphere", "$geoWithin"] },
    filter: { args: { sig: "shape", exact: 1 }, emit: ({ name, args, literal }) => ({ [name]: literal(args[0]) }) },
  }),

  $minDistance: mongo({
    doc: "The nearest a match may be, in metres or radians.",
    where: ["filter"],
    onlyInside: { filter: ["$near", "$nearSphere"] },
    filter: { args: { sig: "shape", exact: 1 }, emit: ({ name, args, literal }) => ({ [name]: literal(args[0]) }) },
  }),

  $each: mongo({
    doc: "Adds more than one value at once, not only one.",
    where: ["updateDoc"],
    onlyInside: { updateDoc: ["$push", "$addToSet"] },
    updateDoc: { args: { sig: "values", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $position: mongo({
    doc: "The index to insert at. Without it, the value goes at the end.",
    where: ["updateDoc"],
    onlyInside: { updateDoc: ["$push"] },
    updateDoc: { args: { sig: "index", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $case: mongo({
    doc: "One branch of a '$switch': its test and its result.",
    returns: "unknown",
    where: ["value"],
    onlyInside: { value: ["$switch"] },
    expr: {
      args: { sig: "condition, result", exact: 2 },
      emit: ({ args, value }) => ({ case: value(args[0]), then: value(args[1]) }),
    },
  }),

  $currentDate: mongo({
    doc: "Sets a field to the current date.",
    where: ["updateDoc"],
    updateDoc: { args: { sig: "fields", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $mul: mongo({
    doc: "Multiplies a field by a number. JSMQL also writes it as JavaScript: '$.price *= 1.1', '$.price /= 2'.",
    where: ["updateDoc"],
    updateDoc: { args: { sig: "fields", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $rename: mongo({
    doc: "Renames a field. JSMQL also writes it as JavaScript: '$.b = $.a; delete $.a;'.",
    where: ["updateDoc"],
    updateDoc: { args: { sig: "fields", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $setOnInsert: mongo({
    doc: "Sets a field only when an upsert inserts a new document.",
    where: ["updateDoc"],
    updateDoc: { args: { sig: "fields", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $pop: mongo({
    doc: "Removes the first or last element of an array. JSMQL also writes it as JavaScript: '$.tags.pop()'.",
    where: ["updateDoc"],
    updateDoc: { args: { sig: "fields", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $pull: mongo({
    doc: "Removes every array element that matches a condition.",
    where: ["updateDoc"],
    updateDoc: { args: { sig: "fields", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $pullAll: mongo({
    doc: "Removes every listed value from an array.",
    where: ["updateDoc"],
    updateDoc: { args: { sig: "fields", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $bit: mongo({
    doc: "Applies a bitwise and / or / xor to an integer field.",
    where: ["updateDoc"],
    updateDoc: { args: { sig: "fields", exact: 1 }, emit: ({ name, args, value }) => ({ [name]: value(args[0]) }) },
  }),

  $all: mongo({
    doc: "Matches arrays that contain all elements specified in the query.",
    category: "array",
    where: ["filter"],
    filter: { args: { sig: "field, values", exact: 2 }, emit: queryOnlyClause },
  }),

  $bitsAllClear: mongo({
    doc: "Matches numeric or binary values in which a set of bit positions all have a value of 0.",
    category: "bitwise",
    where: ["filter"],
    filter: { args: { sig: "field, mask", exact: 2 }, emit: queryOnlyClause },
  }),

  $bitsAllSet: mongo({
    doc: "Matches numeric or binary values in which a set of bit positions all have a value of 1.",
    category: "bitwise",
    where: ["filter"],
    filter: { args: { sig: "field, mask", exact: 2 }, emit: queryOnlyClause },
  }),

  $bitsAnyClear: mongo({
    doc: "Matches numeric or binary values in which any bit from a set of bit positions has a value of 0.",
    category: "bitwise",
    where: ["filter"],
    filter: { args: { sig: "field, mask", exact: 2 }, emit: queryOnlyClause },
  }),

  $bitsAnySet: mongo({
    doc: "Matches numeric or binary values in which any bit from a set of bit positions has a value of 1.",
    category: "bitwise",
    where: ["filter"],
    filter: { args: { sig: "field, mask", exact: 2 }, emit: queryOnlyClause },
  }),

  $comment: mongo({
    doc: "Adds a comment to a query predicate.",
    category: "miscellaneous",
    where: ["filter"],
    filter: { args: { sig: "text", exact: 1 }, emit: ({ name, args, literal }) => ({ [name]: literal(args[0]) }) },
  }),

  $elemMatch: mongo({
    doc: "The $elemMatch operator matches documents that contain an array field with at least one element that matches all the specified query criteria.",
    category: "array",
    where: ["filter"],
    filter: {
      args: { sig: "field, query", exact: 2 },
      emit: ({ args, fieldPath, query, element }) => ({
        [fieldPath(args[0])]: { $elemMatch: args[1].type === "Lambda" ? element(args[1]) : query(args[1]) },
      }),
    },
  }),

  $exists: mongo({
    doc: "Matches documents that have the specified field.",
    category: "type",
    where: ["filter"],
    filter: {
      args: { sig: "field[, exists]", allowed: [1, 2] },
      emit: ({ args, fieldPath, literal }) => ({
        [fieldPath(args[0])]: { $exists: args[1] === undefined ? true : literal(args[1]) },
      }),
    },
  }),

  $expr: mongo({
    doc: "Allows use of aggregation expressions within the query language.",
    category: "miscellaneous",
    where: ["filter"],
    operandPosition: "value",
    filter: { args: { sig: "expression", exact: 1 }, emit: ({ args, value }) => ({ $expr: value(args[0]) }) },
  }),

  $geoIntersects: mongo({
    doc: "Selects geometries that intersect with a GeoJSON geometry. The 2dsphere index supports $geoIntersects.",
    category: "geospatial",
    where: ["filter"],
    filter: {
      args: { sig: "field, geometry", exact: 2 },
      emit: ({ name, args, fieldPath, query }) => ({ [fieldPath(args[0])]: { [name]: query(args[1]) } }),
    },
  }),

  $geoWithin: mongo({
    doc: "Selects geometries within a GeoJSON geometry that bounds them. The 2dsphere and 2d indexes support $geoWithin.",
    category: "geospatial",
    where: ["filter"],
    filter: {
      args: { sig: "field, geometry", exact: 2 },
      emit: ({ name, args, fieldPath, query }) => ({ [fieldPath(args[0])]: { [name]: query(args[1]) } }),
    },
  }),

  $jsonSchema: mongo({
    doc: "Validate documents against the given JSON Schema.",
    category: "miscellaneous",
    where: ["filter"],
    filter: { args: { sig: "schema", exact: 1 }, emit: ({ name, args, literal }) => ({ [name]: literal(args[0]) }) },
  }),

  $near: mongo({
    doc: "Returns geospatial objects in proximity to a point. Requires a geospatial index. The 2dsphere and 2d indexes support $near.",
    category: "geospatial",
    where: ["filter"],
    filter: {
      args: { sig: "field, geometry", exact: 2 },
      emit: ({ name, args, fieldPath, query }) => ({ [fieldPath(args[0])]: { [name]: query(args[1]) } }),
    },
  }),

  $nearSphere: mongo({
    doc: "Returns geospatial objects in proximity to a point on a sphere. Requires a geospatial index. The 2dsphere and 2d indexes support $nearSphere.",
    category: "geospatial",
    where: ["filter"],
    filter: {
      args: { sig: "field, geometry", exact: 2 },
      emit: ({ name, args, fieldPath, query }) => ({ [fieldPath(args[0])]: { [name]: query(args[1]) } }),
    },
  }),

  $nin: mongo({
    doc: "Matches none of the values specified in an array.",
    category: "comparison",
    where: ["filter"],
    liftsTo: { op: "$in", negated: true },
    filter: { args: { sig: "field, values", exact: 2 }, emit: queryOnlyClause },
  }),

  $nor: mongo({
    doc: "Joins query clauses with a logical NOR returns all documents that fail to match both clauses.",
    category: "boolean",
    where: ["filter"],
    filter: { args: { sig: "predicates", atLeast: 1 }, emit: norList },
  }),

  $regex: mongo({
    doc: "Selects documents where values match a specified regular expression.",
    category: "string",
    where: ["filter"],
    filter: {
      args: { sig: "field, pattern[, options]", allowed: [2, 3] },
      emit: ({ args, fieldPath, literal }) => {
        const path = fieldPath(args[0]);
        if (args[1].type === "RegexLiteral") return { [path]: { $regex: literal(args[1]) } };
        const clause: QueryDoc = { $regex: literal(args[1]) };
        if (args[2] !== undefined) clause.$options = literal(args[2]);
        return { [path]: clause };
      },
    },
  }),

  $text: mongo({
    doc: "Performs text search.",
    category: "text",
    where: ["filter"],
    only: ["stageFirst"],
    forbiddenIn: ["$facet"],
    placement: {
      first:
        "'$text' reads the text index, and the server reads that index at the START of a pipeline. Put the '$match' that uses it first and filter further in a later '$match'.",
      container:
        "A branch has no text score to read. Run the '$text' match as the pipeline's first stage, ahead of the branch.",
    },
    filter: {
      args: { sig: "search", exact: 1 },
      emit: ({ args, literal }) => {
        const v = literal(args[0]);
        return { $text: typeof v === "string" ? { $search: v } : v };
      },
    },
  }),

  $where: mongo({
    doc: "Matches documents that satisfy a JavaScript expression.",
    where: [],
    forbiddenIn: ["$match"],
    placement: {
      container:
        "Write the predicate in JSMQL — '$.x > 1', '$.tags.has(\"a\")' — and it runs as a query, in a '$match' or a 'find' filter alike.",
    },
  }),

  collStats: name({
    doc: "'$.collStats()' — the '$collStats' source stage. First stage only, and $-scoped: '$$.collStats()' is refused.",
    call: true,
    on: "stream",
    returns: "stream",
    where: ["statement"],
    only: ["stageFirst"],
    filter: unsupported(
      "'collStats()' is a source stage, not a filter predicate. Run it as the pipeline's first statement: '$$.collStats(…);'.",
    ),
    expr: unsupported("'collStats()' is a source stage, not a value."),
    stream: unsupported("'collStats()' must be the pipeline's first stage, so it cannot be a chain link."),
    statement: {
      args: { sig: "[options]", allowed: [0, 1], slotType: { 0: "object" } },
      emit: ({ name, args, value }) => [{ ["$" + name]: args.length === 0 ? {} : value(args[0]) }],
    },
    group: unsupported("'collStats()' is a source stage, not an accumulator."),
    window: unsupported("'collStats()' is a source stage, not a window function."),
  }),

  indexStats: name({
    doc: "'$.indexStats()' — the '$indexStats' source stage. First stage only, and $-scoped: '$$.indexStats()' is refused.",
    call: true,
    on: "stream",
    returns: "stream",
    where: ["statement"],
    only: ["stageFirst"],
    filter: unsupported(
      "'indexStats()' is a source stage, not a filter predicate. Run it as the pipeline's first statement: '$$.indexStats(…);'.",
    ),
    expr: unsupported("'indexStats()' is a source stage, not a value."),
    stream: unsupported("'indexStats()' must be the pipeline's first stage, so it cannot be a chain link."),
    statement: {
      args: { sig: "[options]", allowed: [0, 1], slotType: { 0: "object" } },
      emit: ({ name, args, value }) => [{ ["$" + name]: args.length === 0 ? {} : value(args[0]) }],
    },
    group: unsupported("'indexStats()' is a source stage, not an accumulator."),
    window: unsupported("'indexStats()' is a source stage, not a window function."),
  }),

  listSearchIndexes: name({
    doc: "'$.listSearchIndexes()' — the '$listSearchIndexes' source stage. First stage only, and $-scoped: '$$.listSearchIndexes()' is refused.",
    call: true,
    on: "stream",
    returns: "stream",
    where: ["statement"],
    only: ["stageFirst"],
    filter: unsupported(
      "'listSearchIndexes()' is a source stage, not a filter predicate. Run it as the pipeline's first statement: '$$.listSearchIndexes(…);'.",
    ),
    expr: unsupported("'listSearchIndexes()' is a source stage, not a value."),
    stream: unsupported("'listSearchIndexes()' must be the pipeline's first stage, so it cannot be a chain link."),
    statement: {
      args: { sig: "[options]", allowed: [0, 1], slotType: { 0: "object" } },
      emit: ({ name, args, value }) => [{ ["$" + name]: args.length === 0 ? {} : value(args[0]) }],
    },
    group: unsupported("'listSearchIndexes()' is a source stage, not an accumulator."),
    window: unsupported("'listSearchIndexes()' is a source stage, not a window function."),
  }),

  planCacheStats: name({
    doc: "'$.planCacheStats()' — the '$planCacheStats' source stage. First stage only, and $-scoped: '$$.planCacheStats()' is refused.",
    call: true,
    on: "stream",
    returns: "stream",
    where: ["statement"],
    only: ["stageFirst"],
    filter: unsupported(
      "'planCacheStats()' is a source stage, not a filter predicate. Run it as the pipeline's first statement: '$$.planCacheStats(…);'.",
    ),
    expr: unsupported("'planCacheStats()' is a source stage, not a value."),
    stream: unsupported("'planCacheStats()' must be the pipeline's first stage, so it cannot be a chain link."),
    statement: {
      args: { sig: "[options]", allowed: [0, 1], slotType: { 0: "object" } },
      emit: ({ name, args, value }) => [{ ["$" + name]: args.length === 0 ? {} : value(args[0]) }],
    },
    group: unsupported("'planCacheStats()' is a source stage, not an accumulator."),
    window: unsupported("'planCacheStats()' is a source stage, not a window function."),
  }),

  currentOp: name({
    doc: "'$$.currentOp()' — the '$currentOp' source stage. First stage only, and $$-scoped: '$.currentOp()' is refused.",
    call: true,
    on: "cluster",
    returns: "stream",
    where: ["statement"],
    only: ["stageFirst"],
    filter: unsupported(
      "'currentOp()' is a source stage, not a filter predicate. Run it as the pipeline's first statement: '$$$$.currentOp(…);'.",
    ),
    expr: unsupported("'currentOp()' is a source stage, not a value."),
    stream: unsupported("'currentOp()' must be the pipeline's first stage, so it cannot be a chain link."),
    statement: {
      args: { sig: "[options]", allowed: [0, 1], slotType: { 0: "object" } },
      emit: ({ name, args, value }) => [{ ["$" + name]: args.length === 0 ? {} : value(args[0]) }],
    },
    group: unsupported("'currentOp()' is a source stage, not an accumulator."),
    window: unsupported("'currentOp()' is a source stage, not a window function."),
  }),

  listLocalSessions: name({
    doc: "'$$.listLocalSessions()' — the '$listLocalSessions' source stage. First stage only, and $$-scoped: '$.listLocalSessions()' is refused.",
    call: true,
    on: "cluster",
    returns: "stream",
    where: ["statement"],
    only: ["stageFirst"],
    filter: unsupported(
      "'listLocalSessions()' is a source stage, not a filter predicate. Run it as the pipeline's first statement: '$$$$.listLocalSessions(…);'.",
    ),
    expr: unsupported("'listLocalSessions()' is a source stage, not a value."),
    stream: unsupported("'listLocalSessions()' must be the pipeline's first stage, so it cannot be a chain link."),
    statement: {
      args: { sig: "[options]", allowed: [0, 1], slotType: { 0: "object" } },
      emit: ({ name, args, value }) => [{ ["$" + name]: args.length === 0 ? {} : value(args[0]) }],
    },
    group: unsupported("'listLocalSessions()' is a source stage, not an accumulator."),
    window: unsupported("'listLocalSessions()' is a source stage, not a window function."),
  }),

  listSampledQueries: name({
    doc: "'$$.listSampledQueries()' — the '$listSampledQueries' source stage. First stage only, and $$-scoped: '$.listSampledQueries()' is refused.",
    call: true,
    on: "cluster",
    returns: "stream",
    where: ["statement"],
    only: ["stageFirst"],
    filter: unsupported(
      "'listSampledQueries()' is a source stage, not a filter predicate. Run it as the pipeline's first statement: '$$$$.listSampledQueries(…);'.",
    ),
    expr: unsupported("'listSampledQueries()' is a source stage, not a value."),
    stream: unsupported("'listSampledQueries()' must be the pipeline's first stage, so it cannot be a chain link."),
    statement: {
      args: { sig: "[options]", allowed: [0, 1], slotType: { 0: "object" } },
      emit: ({ name, args, value }) => [{ ["$" + name]: args.length === 0 ? {} : value(args[0]) }],
    },
    group: unsupported("'listSampledQueries()' is a source stage, not an accumulator."),
    window: unsupported("'listSampledQueries()' is a source stage, not a window function."),
  }),

  listSessions: name({
    doc: "'$$.listSessions()' — the '$listSessions' source stage. First stage only, and $$-scoped: '$.listSessions()' is refused.",
    call: true,
    on: "cluster",
    returns: "stream",
    where: ["statement"],
    only: ["stageFirst"],
    filter: unsupported(
      "'listSessions()' is a source stage, not a filter predicate. Run it as the pipeline's first statement: '$$$$.listSessions(…);'.",
    ),
    expr: unsupported("'listSessions()' is a source stage, not a value."),
    stream: unsupported("'listSessions()' must be the pipeline's first stage, so it cannot be a chain link."),
    statement: {
      args: { sig: "[options]", allowed: [0, 1], slotType: { 0: "object" } },
      emit: ({ name, args, value }) => [{ ["$" + name]: args.length === 0 ? {} : value(args[0]) }],
    },
    group: unsupported("'listSessions()' is a source stage, not an accumulator."),
    window: unsupported("'listSessions()' is a source stage, not a window function."),
  }),

  shardedDataDistribution: name({
    doc: "'$$.shardedDataDistribution()' — the '$shardedDataDistribution' source stage. First stage only, and $$-scoped: '$.shardedDataDistribution()' is refused.",
    call: true,
    on: "cluster",
    returns: "stream",
    where: ["statement"],
    only: ["stageFirst"],
    filter: unsupported(
      "'shardedDataDistribution()' is a source stage, not a filter predicate. Run it as the pipeline's first statement: '$$$$.shardedDataDistribution(…);'.",
    ),
    expr: unsupported("'shardedDataDistribution()' is a source stage, not a value."),
    stream: unsupported(
      "'shardedDataDistribution()' must be the pipeline's first stage, so it cannot be a chain link.",
    ),
    statement: {
      args: { sig: "[options]", allowed: [0, 1], slotType: { 0: "object" } },
      emit: ({ name, args, value }) => [{ ["$" + name]: args.length === 0 ? {} : value(args[0]) }],
    },
    group: unsupported("'shardedDataDistribution()' is a source stage, not an accumulator."),
    window: unsupported("'shardedDataDistribution()' is a source stage, not a window function."),
  }),

  shuffle: name({
    doc: "'.shuffle()' — random order. It stamps a '$rand' field, sorts on it and drops it.",
    call: true,
    on: "stream",
    returns: "stream",
    where: ["stream"],
    filter: unsupported("'.shuffle()' reorders a stream; it is not a filter predicate."),
    // [DEF-039] `.shuffle()` on an ARRAY value is not yet supported; `.sampleSize(n)` covers the sampled read.
    expr: unsupported(
      "'.shuffle()' reorders a stream of documents, which is not a value. To shuffle an array use '.sampleSize(n)'.",
    ),
    stream: {
      args: { sig: "", none: true },
      emit: ({ slot }) => {
        const key = slot();
        return [{ $addFields: { [key]: { $rand: {} } } }, { $sort: { [key]: 1 } }];
      },
    },
    statement: unsupported("'.shuffle()' is a chain link. Write '$ = $.shuffle();'."),
    group: unsupported("'.shuffle()' is not an accumulator."),
    window: unsupported("'.shuffle()' is not a window function."),
  }),

  aggregate: name({
    doc: "'.aggregate(pipeline)' — splices raw stages into the chain. Takes an array or a block body.",
    call: true,
    on: "stream",
    params: ["value", "index", "receiver"],
    iterateeSlots: {
      stream: {
        arrowOnly:
          "a block of pipeline stages, `(o) => { $stage(…); … }`, or a stage-array literal `[{ $stage: … }]`; no shorthand stands in for either",
      },
    },
    returns: "stream",
    where: ["stream"],
    blockBody: "stages",
    filter: unsupported("'.aggregate()' splices stages; it is not a filter predicate."),
    expr: unsupported("'.aggregate()' produces pipeline stages, not a value."),
    stream: {
      args: {
        sig: "stages | (o) => { …stages }",
        exact: 1,
        slotType: { 0: ["callback", "array"] },
        nonEmpty: {
          0: {
            noun: "stage",
            instead: "List the stages — '.aggregate([$match(…), $sort(…)])' — or drop the '.aggregate()' link.",
          },
        },
      },
      emit: ({ args, value, block }) => (args[0].type === "Lambda" ? block(args[0]) : (value(args[0]) as Stage[])),
    },
    statement: unsupported("'.aggregate()' is a chain link. Write '$ = $.aggregate([…]);'."),
    group: unsupported("'.aggregate()' is not an accumulator."),
    window: unsupported("'.aggregate()' is not a window function."),
  }),

  assert: global_({
    doc: "'assert(condition[, message]);' — a guard stage that fails the pipeline when the condition is false. A user-declared function named 'assert' wins over it.",
    token: "Ident",
    returns: "unknown",
    where: ["statement"],
    filter: unsupported("'assert(...)' emits a guard stage; it is not a filter predicate."),
    expr: unsupported(
      "'assert(...)' is a pipeline statement, not a value — it can't appear inside an expression. Use it as its own statement in a pipeline body, for example `({ $ }) => { assert($.qty >= 0, \"qty must be >= 0\"); … }`.",
    ),
    stream: unsupported("'assert(...)' is a statement. Write 'assert($.n > 0);' on its own line."),
    statement: {
      args: { sig: "condition[, message]", allowed: [1, 2], slotType: { 0: "value", 1: "string" } },
      emit: ({ args, truth, value }) => {
        const prefix = "jsmql assertion failed";
        const message =
          args[1] === undefined
            ? prefix
            : args[1].type === "StringLiteral"
              ? `${prefix}: ${args[1].value}`
              : { $concat: [`${prefix}: `, { $toString: value(args[1]) }] };
        return [{ $match: { $expr: { $convert: { input: true, to: { $cond: [truth(args[0]), "bool", message] } } } } }];
      },
    },
    group: unsupported("'assert(...)' is not an accumulator."),
    window: unsupported("'assert(...)' is not a window function."),
  }),

  assign: name({
    doc: "'.assign(...sources)' — emits $mergeObjects. A spread argument is a list of sources; a plain argument is one source.",
    call: true,
    on: ["object", "Object"],
    returns: { object: { merge: ["same", { args: 0 }] } },
    neverNull: "always",
    readsNullAsEmpty: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        object: {
          args: { sig: "...sources", atLeast: 1, spread: true, rest: "object" },
          emit: ({ recv, args, value }) => merged(recv, args, value),
        },
        Object: unsupported(
          "'Object.assign(target, ...sources)' is not part of JSMQL — the receiver's own method says the same thing, and one capability gets one spelling. Write '<object>.assign(...sources)' or the object spread '{ ...a, ...b }'. To merge an array of objects, write '({}).assign(...$.docs)'. To write a field, write '$.f = { ...$.f, ...x };'.",
        ),
      },
    },
    stream: unsupported("'.assign()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.assign()' computes a new object, and a statement writes one. Write the merge back: '$.f = { ...$.f, ...x };', or 'r = { ...r, ...x };' for a 'let' binding.",
    ),
    group: unsupported("'.assign()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.assign()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  fromEntries: name({
    doc: "'.fromEntries()' — emits $arrayToObject. Same lowering as '.fromPairs()'.",
    call: true,
    passesNull: true,
    on: ["array", "Object"],
    returns: { array: { recordOf: { itemOf: ["element", 1] } } },
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        array: { args: { sig: "", none: true }, emit: ({ recv }) => pairsToObject(recv) },
        Object: unsupported(
          "'Object.fromEntries(entries)' is not part of JSMQL — the receiver's own method says the same thing, and one capability gets one spelling. Write '<pairs>.fromEntries()': '$.pairs.fromEntries()'.",
        ),
      },
    },
    stream: unsupported("'.fromEntries()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.fromEntries()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <pairs>.fromEntries();'",
    ),
    group: unsupported("'.fromEntries()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.fromEntries()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  isFinite: name({
    doc: "'Number.isFinite(value)' — parses, then refused: there is no Infinity/NaN literal to compare against.",
    call: true,
    on: "Number",
    returns: "bool",
    where: [],
    // One refusal in every position — the name is legal nowhere. The tracking id
    // stays in this comment and out of the message: a developer who reads the error
    // has no use for it. [DEF-022]
    filter: NO_IS_FINITE,
    expr: NO_IS_FINITE,
    stream: NO_IS_FINITE,
    statement: NO_IS_FINITE,
    group: NO_IS_FINITE,
    window: NO_IS_FINITE,
  }),

  symmetricDifference: name({
    doc: "'.symmetricDifference()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: "array",
    returns: "array",
    neverNull: "always",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "other", exact: 1, slotType: { 0: "array" } },
      emit: ({ recv, args, value, bind, type }) => {
        const a = bind("a");
        const b = bind("b");
        return {
          $let: {
            vars: { [a.as]: recv, [b.as]: listArgument(value, type, args[0]) },
            in: { $setDifference: [{ $setUnion: [a.ref, b.ref] }, { $setIntersection: [a.ref, b.ref] }] },
          },
        };
      },
    },
    stream: because("compares against a second array. Compare against a collection with '$$$.<coll>.find(<pred>)'."),
    statement: unsupported(
      "'.symmetricDifference()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.symmetricDifference();'",
    ),
    group: unsupported("'.symmetricDifference()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.symmetricDifference()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  isDisjointFrom: name({
    doc: "'.isDisjointFrom()' — see docs/LANGUAGE.md.",
    call: true,
    on: "array",
    returns: "bool",
    neverNull: "always",
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "other", exact: 1, slotType: { 0: "array" } },
      emit: ({ recv, args, value, present, bind, type }) =>
        nullOr(recv, present, bind, (r) => ({
          $eq: [sizeOf({ $setIntersection: [r, listArgument(value, type, args[0])] }), 0],
        })),
    },
    stream: unsupported("'.isDisjointFrom()' has no stream form: it produces a value, not a stream of documents."),
    statement: unsupported(
      "'.isDisjointFrom()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.isDisjointFrom();'",
    ),
    group: unsupported("'.isDisjointFrom()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported(
      "'.isDisjointFrom()' is not a window function. Inside '$setWindowFields' write the MongoDB operator.",
    ),
  }),

  Object: root({
    doc: "The JavaScript Object namespace. Each member is refused, and its refusal names the method that says the same thing.",
    token: "Ident",
    provides: "namespace",
    where: [],
    filter: unsupported("'Object' is a namespace, not a test. Call the object's own method: '$.d.keys().size() > 0'."),
    expr: unsupported("'Object' is a namespace, not a value. Call the object's own method: '$.doc.keys()'."),
    stream: unsupported("'Object' is a namespace, not a stage."),
    statement: unsupported("'Object' is a namespace, not a statement."),
    group: unsupported("'Object' is a namespace, not an accumulator."),
    window: unsupported("'Object' is a namespace, not a window function."),
  }),

  String: global_({
    doc: "Parsed, then refused: '<value>.toString()' is JSMQL's conversion to a string.",
    token: "Ident",
    returns: "string",
    where: [],
    filter: stringIsNotJsmql,
    expr: stringIsNotJsmql,
    stream: stringIsNotJsmql,
    statement: stringIsNotJsmql,
    group: stringIsNotJsmql,
    window: stringIsNotJsmql,
  }),

  Boolean: global_({
    doc: "Parsed, then refused: '!!<value>' is the truthiness of JavaScript, and '.compact()' drops the falsy elements.",
    token: "Ident",
    returns: "bool",
    where: [],
    filter: booleanIsNotJsmql,
    expr: booleanIsNotJsmql,
    stream: booleanIsNotJsmql,
    statement: booleanIsNotJsmql,
    group: booleanIsNotJsmql,
    window: booleanIsNotJsmql,
  }),

  parseInt: global_({
    doc: "Parsed, then refused: '.toDouble()' is JSMQL's numeric conversion.",
    token: "Ident",
    returns: "number",
    where: [],
    filter: parseIntIsNotJsmql,
    expr: parseIntIsNotJsmql,
    stream: parseIntIsNotJsmql,
    statement: parseIntIsNotJsmql,
    group: parseIntIsNotJsmql,
    window: parseIntIsNotJsmql,
  }),

  parseFloat: global_({
    doc: "Parsed, then refused: '.toDouble()' is JSMQL's numeric conversion.",
    token: "Ident",
    returns: "number",
    where: [],
    filter: parseFloatIsNotJsmql,
    expr: parseFloatIsNotJsmql,
    stream: parseFloatIsNotJsmql,
    statement: parseFloatIsNotJsmql,
    group: parseFloatIsNotJsmql,
    window: parseFloatIsNotJsmql,
  }),

  abs: name({
    doc: "'.abs()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $abs: recv }) },
        Math: unsupported(
          "'Math.abs(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.abs()': '$.n.abs()'. In a callback, write 'x => x.abs()'.",
        ),
      },
    },
    stream: unsupported("'.abs()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.abs()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.abs();'",
    ),
    group: unsupported("'.abs()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.abs()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  sqrt: name({
    doc: "'.sqrt()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $sqrt: recv }) },
        Math: unsupported(
          "'Math.sqrt(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.sqrt()': '$.n.sqrt()'. In a callback, write 'x => x.sqrt()'.",
        ),
      },
    },
    stream: unsupported("'.sqrt()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.sqrt()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.sqrt();'",
    ),
    group: unsupported("'.sqrt()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.sqrt()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  exp: name({
    doc: "'.exp()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $exp: recv }) },
        Math: unsupported(
          "'Math.exp(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.exp()': '$.n.exp()'. In a callback, write 'x => x.exp()'.",
        ),
      },
    },
    stream: unsupported("'.exp()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.exp()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.exp();'",
    ),
    group: unsupported("'.exp()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.exp()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  log: name({
    doc: "'.log()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    nullReceiverAs: 1,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: {
          args: { sig: "[base]", allowed: [0, 1], slotType: { 0: "number" } },
          emit: ({ recv, args, value }) => {
            const base = args[0];
            if (base === undefined) return { $ln: recv };
            return base.type === "NumberLiteral" && base.value === 10
              ? { $log10: recv }
              : { $log: [recv, value(base)] };
          },
        },
        Math: unsupported(
          "'Math.log(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.log()': '$.n.log()', or '$.n.log(base)' for another base.",
        ),
      },
    },
    stream: unsupported("'.log()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.log()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.log();'",
    ),
    group: unsupported("'.log()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.log()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  log2: name({
    doc: "'.log2()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    nullReceiverAs: 1,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $log: [recv, 2] }) },
        Math: unsupported(
          "'Math.log2(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.log2()': '$.n.log2()'. In a callback, write 'x => x.log2()'.",
        ),
      },
    },
    stream: unsupported("'.log2()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.log2()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.log2();'",
    ),
    group: unsupported("'.log2()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.log2()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  log10: name({
    doc: "'.log10()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    nullReceiverAs: 1,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $log10: recv }) },
        Math: unsupported(
          "'Math.log10(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.log10()': '$.n.log10()'. In a callback, write 'x => x.log10()'.",
        ),
      },
    },
    stream: unsupported("'.log10()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.log10()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.log10();'",
    ),
    group: unsupported("'.log10()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.log10()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  trunc: name({
    doc: "'.trunc()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: {
          args: { sig: "[precision]", allowed: [0, 1], slotType: { 0: "int" } },
          emit: ({ recv, args, value }) =>
            args[0] === undefined ? { $trunc: recv } : { $trunc: [recv, value(args[0])] },
        },
        Math: unsupported(
          "'Math.trunc(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.trunc()': '$.n.trunc()'. In a callback, write 'x => x.trunc()'.",
        ),
      },
    },
    stream: unsupported("'.trunc()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.trunc()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.trunc();'",
    ),
    group: unsupported("'.trunc()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.trunc()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  sign: name({
    doc: "'.sign()' — see docs/LANGUAGE.md.",
    call: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: "always",
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $cmp: [recv, 0] }) },
        Math: unsupported(
          "'Math.sign(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.sign()': '$.n.sign()'. In a callback, write 'x => x.sign()'.",
        ),
      },
    },
    stream: unsupported("'.sign()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.sign()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.sign();'",
    ),
    group: unsupported("'.sign()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.sign()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  cbrt: name({
    doc: "'.cbrt()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => cbrt(recv) },
        Math: unsupported(
          "'Math.cbrt(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.cbrt()': '$.n.cbrt()'. In a callback, write 'x => x.cbrt()'.",
        ),
      },
    },
    stream: unsupported("'.cbrt()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.cbrt()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.cbrt();'",
    ),
    group: unsupported("'.cbrt()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.cbrt()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  sin: name({
    doc: "'.sin()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $sin: recv }) },
        Math: unsupported(
          "'Math.sin(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.sin()': '$.n.sin()'. In a callback, write 'x => x.sin()'.",
        ),
      },
    },
    stream: unsupported("'.sin()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.sin()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.sin();'",
    ),
    group: unsupported("'.sin()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.sin()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  cos: name({
    doc: "'.cos()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $cos: recv }) },
        Math: unsupported(
          "'Math.cos(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.cos()': '$.n.cos()'. In a callback, write 'x => x.cos()'.",
        ),
      },
    },
    stream: unsupported("'.cos()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.cos()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.cos();'",
    ),
    group: unsupported("'.cos()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.cos()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  tan: name({
    doc: "'.tan()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $tan: recv }) },
        Math: unsupported(
          "'Math.tan(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.tan()': '$.n.tan()'. In a callback, write 'x => x.tan()'.",
        ),
      },
    },
    stream: unsupported("'.tan()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.tan()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.tan();'",
    ),
    group: unsupported("'.tan()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.tan()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  asin: name({
    doc: "'.asin()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $asin: recv }) },
        Math: unsupported(
          "'Math.asin(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.asin()': '$.n.asin()'. In a callback, write 'x => x.asin()'.",
        ),
      },
    },
    stream: unsupported("'.asin()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.asin()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.asin();'",
    ),
    group: unsupported("'.asin()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.asin()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  acos: name({
    doc: "'.acos()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $acos: recv }) },
        Math: unsupported(
          "'Math.acos(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.acos()': '$.n.acos()'. In a callback, write 'x => x.acos()'.",
        ),
      },
    },
    stream: unsupported("'.acos()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.acos()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.acos();'",
    ),
    group: unsupported("'.acos()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.acos()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  atan: name({
    doc: "'.atan()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $atan: recv }) },
        Math: unsupported(
          "'Math.atan(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.atan()': '$.n.atan()'. In a callback, write 'x => x.atan()'.",
        ),
      },
    },
    stream: unsupported("'.atan()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.atan()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.atan();'",
    ),
    group: unsupported("'.atan()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.atan()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  sinh: name({
    doc: "'.sinh()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $sinh: recv }) },
        Math: unsupported(
          "'Math.sinh(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.sinh()': '$.n.sinh()'. In a callback, write 'x => x.sinh()'.",
        ),
      },
    },
    stream: unsupported("'.sinh()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.sinh()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.sinh();'",
    ),
    group: unsupported("'.sinh()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.sinh()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  cosh: name({
    doc: "'.cosh()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $cosh: recv }) },
        Math: unsupported(
          "'Math.cosh(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.cosh()': '$.n.cosh()'. In a callback, write 'x => x.cosh()'.",
        ),
      },
    },
    stream: unsupported("'.cosh()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.cosh()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.cosh();'",
    ),
    group: unsupported("'.cosh()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.cosh()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  tanh: name({
    doc: "'.tanh()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $tanh: recv }) },
        Math: unsupported(
          "'Math.tanh(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.tanh()': '$.n.tanh()'. In a callback, write 'x => x.tanh()'.",
        ),
      },
    },
    stream: unsupported("'.tanh()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.tanh()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.tanh();'",
    ),
    group: unsupported("'.tanh()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.tanh()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  asinh: name({
    doc: "'.asinh()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $asinh: recv }) },
        Math: unsupported(
          "'Math.asinh(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.asinh()': '$.n.asinh()'. In a callback, write 'x => x.asinh()'.",
        ),
      },
    },
    stream: unsupported("'.asinh()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.asinh()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.asinh();'",
    ),
    group: unsupported("'.asinh()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.asinh()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  acosh: name({
    doc: "'.acosh()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    nullReceiverAs: 1,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $acosh: recv }) },
        Math: unsupported(
          "'Math.acosh(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.acosh()': '$.n.acosh()'. In a callback, write 'x => x.acosh()'.",
        ),
      },
    },
    stream: unsupported("'.acosh()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.acosh()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.acosh();'",
    ),
    group: unsupported("'.acosh()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.acosh()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  atanh: name({
    doc: "'.atanh()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: { args: { sig: "", none: true }, emit: ({ recv }) => ({ $atanh: recv }) },
        Math: unsupported(
          "'Math.atanh(x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<number>.atanh()': '$.n.atanh()'. In a callback, write 'x => x.atanh()'.",
        ),
      },
    },
    stream: unsupported("'.atanh()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.atanh()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.atanh();'",
    ),
    group: unsupported("'.atanh()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.atanh()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  pow: name({
    doc: "'Math.pow(base, exponent)' and '.pow(exponent)' are not part of JSMQL — '**' says the same thing.",
    call: true,
    on: "Math",
    returns: "number",
    where: [],
    filter: NO_POW,
    expr: NO_POW,
    stream: NO_POW,
    statement: NO_POW,
    group: NO_POW,
    window: NO_POW,
  }),

  atan2: name({
    doc: "'.atan2()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: {
          args: { sig: "x", exact: 1, slotType: { 0: "number" } },
          emit: ({ recv, args, value }) => ({ $atan2: [recv, value(args[0])] }),
        },
        Math: unsupported(
          "'Math.atan2(y, x)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<y>.atan2(<x>)': '$.y.atan2($.x)'.",
        ),
      },
    },
    stream: unsupported("'.atan2()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.atan2()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.atan2();'",
    ),
    group: unsupported("'.atan2()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.atan2()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  hypot: name({
    doc: "'.hypot()' — see docs/LANGUAGE.md.",
    call: true,
    passesNull: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: {
          args: { sig: "...values", atLeast: 1, slotType: { 0: "number" }, rest: "number" },
          emit: ({ recv, args, value }) => ({
            $sqrt: { $add: [recv, ...args.map(value)].map((v) => ({ $pow: [v, 2] })) },
          }),
        },
        Math: unsupported(
          "'Math.hypot(...values)' is not part of JSMQL — the number's own method says the same thing, and one capability gets one spelling. Write '<a>.hypot(<b>, …)': '$.a.hypot($.b)'.",
        ),
      },
    },
    stream: unsupported("'.hypot()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.hypot()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.hypot();'",
    ),
    group: unsupported("'.hypot()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.hypot()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  random: name({
    doc: "'.random([upper])' — lodash's _.random with the receiver as a bound; 'Math.random()' — emits $rand.",
    call: true,
    on: ["number", "Math"],
    returns: "number",
    neverNull: "always",
    where: ["value"],
    filter: viaFallback,
    expr: {
      perFamily: {
        number: {
          args: { sig: "[upper]", allowed: [0, 1], slotType: { 0: "number" } },
          emit: (input) => randomOf(input),
        },
        Math: { args: { sig: "", none: true }, emit: () => ({ $rand: {} }) },
      },
    },
    stream: unsupported("'.random()' produces a value, not a stream of documents."),
    statement: unsupported(
      "'.random()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <number>.random();'",
    ),
    group: unsupported("'.random()' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'.random()' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  PI: name({
    doc: "'Math.PI' — the literal 3.141592653589793. Read, never called.",
    call: false,
    on: "Math",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: () => 3.141592653589793 },
    stream: unsupported("'Math.PI' is a number, not a stream of documents."),
    statement: unsupported("'Math.PI' is a number, not a statement."),
    group: unsupported("'Math.PI' is a constant, not an accumulator."),
    window: unsupported("'Math.PI' is a constant, not a window function."),
  }),

  E: name({
    doc: "'Math.E' — the literal 2.718281828459045. Read, never called.",
    call: false,
    on: "Math",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: () => 2.718281828459045 },
    stream: unsupported("'Math.E' is a number, not a stream of documents."),
    statement: unsupported("'Math.E' is a number, not a statement."),
    group: unsupported("'Math.E' is a constant, not an accumulator."),
    window: unsupported("'Math.E' is a constant, not a window function."),
  }),

  Math: root({
    doc: "The JavaScript Math namespace: 'Math.random()', 'Math.PI' and 'Math.E'. Each other member is refused, and its refusal names the number method.",
    token: "Ident",
    provides: "namespace",
    where: [],
    filter: unsupported("'Math' is a namespace, not a test. Compare a number method: '$.n.abs() > 2'."),
    expr: unsupported(
      "'Math' is a namespace, not a value. Write a member: 'Math.random()', or a number method: '$.n.abs()'.",
    ),
    stream: unsupported("'Math' is a namespace, not a stage."),
    statement: unsupported("'Math' is a namespace, not a statement."),
    group: unsupported("'Math' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'Math' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  $: root({
    doc: "The whole current document.",
    token: "Dollar",
    provides: "value",
    returns: "object",
    where: ["value"],
    filter: viaFallback,
    expr: { args: { sig: "", none: true }, emit: ({ wholeDocument }) => wholeDocument() },
    stream: unsupported("'$' is the document, not a stream. To replace it write '$ = <expr>'."),
    statement: unsupported("'$' on its own is a value. To replace the document write '$ = <expr>'."),
    group: unsupported("'$' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'$' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  $$: root({
    doc: "The root stream: the documents of the pipeline. Every value-position use is refused as statement-only.",
    token: "DoubleDollar",
    provides: "collection",
    where: ["stream", "statement"],
    filter: unsupported("'$$' is a stream of documents, not a test. Filter it: '$$.filter(d => …)'."),
    expr: unsupported(
      "'$$' (the root stream) is statement-only. In a value slot, use a method on it, for example '$$.size()'.",
    ),
    stream: inCode("src/compiler/emit/statement.ts"),
    statement: inCode("src/compiler/emit/statement.ts"),
    group: unsupported("'$$' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'$$' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  $$$: root({
    doc: "Database scope: `$$$.<coll>` names another collection.",
    token: "TripleDollar",
    provides: "database",
    where: ["stream", "statement"],
    filter: unsupported("'$$$.<coll>' names a collection, not a test. Join it: '$.o = $$$.<coll>.find(d => …)'."),
    expr: unsupported("'$$$.<coll>' names a collection. Assign the read to a field: '$.o = $$$.<coll>.find(…)'."),
    stream: inCode("src/compiler/emit/join.ts"),
    statement: inCode("src/compiler/emit/statement.ts"),
    group: unsupported("'$$$' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'$$$' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  $$$$: root({
    doc: "Cluster scope, for the diagnostic source stages: `$$$$.currentOp(...)`.",
    token: "QuadDollar",
    provides: "cluster",
    where: ["statement"],
    filter: unsupported("'$$$$.<db>.<coll>' names a collection, not a test."),
    expr: unsupported("'$$$$.<db>.<coll>' names a collection, not a value."),
    stream: because(
      "cross-database reads aren't supported, so '$$$$' cannot be a stream source. Cross-database WRITES do work: '$$$$.<db>.<coll> = $$' lowers to '$out'.",
    ),
    statement: inCode("src/compiler/emit/statement.ts"),
    group: unsupported("'$$$$' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'$$$$' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  ObjectId: global_({
    doc: "An ObjectId. Empty mints one, and a 24-hex constant is a literal.",
    token: "Ident",
    returns: "objectId",
    neverNull: true,
    where: ["value"],
    filter: because("an ObjectId is a value, not a test. Compare it: '$._id === 0x507f1f77bcf86cd799439011'."),
    updateDoc: unsupported(
      "'ObjectId(…)' is computed on the server, and a document-form update takes constants. Pass an id from your code (a '0x507f1f77bcf86cd799439011' literal, or an interpolated '${new ObjectId()}'), or use the pipeline form ('jsmql.pipeline(\"$.id = ObjectId();\")'), which 'updateOne' accepts as well.",
    ),
    expr: {
      byArgs: {
        none: { args: { sig: "", none: true }, emit: () => ({ $createObjectId: {} }) },
        constant: {
          args: { sig: "value", exact: 1, slotType: { 0: "string" } },
          emit: ({ args, construct }) =>
            construct(
              "ObjectId",
              "'ObjectId(<constant>)' — this constant is not 24 hex characters. Write '0x507f1f77bcf86cd799439011' (or 'ObjectId(\"507f1f77bcf86cd799439011\")').",
              args[0],
            ),
        },
        dynamic: convertsWith("ObjectId", "toObjectId"),
        otherwise: unsupported("'ObjectId(…)' takes no argument (a new id), or one 24-hex constant."),
      },
    },
    stream: unsupported("'ObjectId' produces a value, not a stream of documents."),
    statement: unsupported("'ObjectId' produces a value. Use it inside a reshape or a '$set'."),
    group: unsupported("'ObjectId' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'ObjectId' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  Date: dateRow("Date"),
  ISODate: dateRow("ISODate"),

  Decimal128: bsonValue({
    spelling: "Decimal128",
    doc: "A Decimal128 — exact decimal arithmetic. A constant is a literal.",
    returns: "number",
    method: "toDecimal",
    isA: "a decimal",
    compare: '$.price > Decimal128("9.99")',
    refuseConstant:
      "'Decimal128(<constant>)' — this constant is not a decimal. Write a digit string ('Decimal128(\"9.99\")'), at most 34 significant digits.",
  }),
  Long: bsonValue({
    spelling: "Long",
    doc: "A 64-bit integer. A constant is a literal.",
    returns: "number",
    method: "toLong",
    isA: "a long",
    compare: '$.n === Long("9007199254740993")',
    refuseConstant:
      "'Long(<constant>)' — this constant is not a whole number in the 64-bit range (-9223372036854775808 … 9223372036854775807). Write 'Decimal128(…)' for a bigger or fractional number. A number literal past 2^53 has already lost its digits — spell it as a string ('Long(\"9007199254740993\")') or a BigInt (9007199254740993n).",
  }),
  Int32: bsonValue({
    spelling: "Int32",
    doc: "A 32-bit integer. A constant is a literal.",
    returns: "number",
    method: "toInt",
    isA: "an int",
    compare: "$.count === Int32(3)",
    refuseConstant:
      "'Int32(<constant>)' — this constant is not a whole number in the 32-bit range (-2147483648 … 2147483647). Write 'Long(…)' for a bigger integer, or 'Double(…)' to keep a fraction.",
  }),
  Double: bsonValue({
    spelling: "Double",
    doc: "A double. A constant is a literal. `Double(1)` keeps a whole number a double, where a written `1` is an int.",
    returns: "number",
    method: "toDouble",
    isA: "a double",
    compare: "$.ratio === Double(1)",
    refuseConstant: "'Double(<constant>)' — this constant is not a finite number. Write 'Double(1.5)'.",
  }),
  UUID: bsonValue({
    spelling: "UUID",
    doc: "A UUID. A constant is a literal.",
    returns: "binData",
    method: "toUUID",
    isA: "a UUID",
    compare: '$.id === UUID("6ac24965-7917-4323-8d44-920ad1d69b94")',
    takes: "string",
    refuseConstant:
      "'UUID(<constant>)' — this constant is not a UUID. Write 32 hex digits, or the hyphenated form ('UUID(\"6ac24965-7917-4323-8d44-920ad1d69b94\")').",
  }),
  MinKey: bsonSentinel("MinKey", "The value that compares below every other type.", "$.grade === MinKey()"),
  MaxKey: bsonSentinel("MaxKey", "The value that compares above every other type.", "$.grade === MaxKey()"),

  NumberDecimal: bsonValue({
    spelling: "NumberDecimal",
    doc: "The mongosh spelling of `Decimal128`.",
    returns: "number",
    method: "toDecimal",
    isA: "a decimal",
    compare: '$.price > NumberDecimal("9.99")',
    refuseConstant:
      "'NumberDecimal(<constant>)' — this constant is not a decimal. Write a digit string ('Decimal128(\"9.99\")'), at most 34 significant digits.",
  }),
  NumberLong: bsonValue({
    spelling: "NumberLong",
    doc: "The mongosh spelling of `Long`.",
    returns: "number",
    method: "toLong",
    isA: "a long",
    compare: '$.n === NumberLong("9007199254740993")',
    refuseConstant:
      "'NumberLong(<constant>)' — this constant is not a whole number in the 64-bit range (-9223372036854775808 … 9223372036854775807). Write 'Decimal128(…)' for a bigger or fractional number. A number literal past 2^53 has already lost its digits — spell it as a string ('Long(\"9007199254740993\")') or a BigInt (9007199254740993n).",
  }),
  NumberInt: bsonValue({
    spelling: "NumberInt",
    doc: "The mongosh spelling of `Int32`.",
    returns: "number",
    method: "toInt",
    isA: "an int",
    compare: "$.count === NumberInt(3)",
    refuseConstant:
      "'NumberInt(<constant>)' — this constant is not a whole number in the 32-bit range (-2147483648 … 2147483647). Write 'Long(…)' for a bigger integer, or 'Double(…)' to keep a fraction.",
  }),

  Number: global_({
    doc: "The Number namespace. Nothing on it is JSMQL; see its refusal. A call is refused: '<value>.toDouble()' is JSMQL's numeric conversion.",
    token: "Ident",
    provides: "Number",
    returns: "number",
    where: [],
    filter: numberIsNotJsmql,
    expr: numberIsNotJsmql,
    stream: numberIsNotJsmql,
    statement: numberIsNotJsmql,
    group: numberIsNotJsmql,
    window: numberIsNotJsmql,
  }),

  Array: global_({
    doc: "The Array namespace. Nothing on it is jsmql; see its refusal.",
    token: "Ident",
    provides: "Array",
    returns: "array",
    where: [],
    filter: fromIsNotJsmql,
    expr: fromIsNotJsmql,
    stream: unsupported("'Array' produces a value, not a stream of documents."),
    statement: unsupported("'Array' produces a value. Use it inside a reshape or a '$set'."),
    group: unsupported("'Array' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'Array' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  Set: global_({
    doc: "The JavaScript Set class. MongoDB has no set type; see its refusal.",
    token: "Ident",
    returns: "unknown",
    where: [],
    filter: setIsNotJsmql,
    expr: setIsNotJsmql,
    stream: setIsNotJsmql,
    statement: setIsNotJsmql,
    updateDoc: setIsNotJsmql,
    group: unsupported(
      "'new Set(…)' is not an accumulator. Inside '$group', '$addToSet(<value>)' gathers the unique values.",
    ),
    window: unsupported(
      "'new Set(…)' is not a window function. Inside '$setWindowFields', '$addToSet(<value>)' gathers the unique values.",
    ),
  }),

  Map: global_({
    doc: "The JavaScript Map class. MongoDB has no map type; see its refusal.",
    token: "Ident",
    returns: "object",
    where: [],
    filter: mapIsNotJsmql,
    expr: mapIsNotJsmql,
    stream: unsupported("'Map' produces a value, not a stream of documents."),
    statement: unsupported("'Map' produces a value. Use it inside a reshape or a '$set'."),
    group: unsupported("'Map' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'Map' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  RegExp: global_({
    doc: "The JavaScript RegExp class. A regular expression literal is the JSMQL spelling; see its refusal.",
    token: "Ident",
    returns: "unknown",
    where: [],
    filter: regExpIsNotJsmql,
    expr: regExpIsNotJsmql,
    stream: unsupported("'RegExp' produces a value, not a stream of documents."),
    statement: unsupported("'RegExp' produces a value. Use it inside a reshape or a '$set'."),
    group: unsupported("'RegExp' is not an accumulator. Inside '$group' write the MongoDB operator."),
    window: unsupported("'RegExp' is not a window function. Inside '$setWindowFields' write the MongoDB operator."),
  }),

  length: name({
    doc: "'.length()' — the number of characters of a string. See docs/LANGUAGE.md.",
    call: true,
    on: "string",
    sibling: {
      array: "For the number of elements, write '.size()'.",
      stream: "For the document count, write '$$.size()'.",
    },
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: { sig: "", none: true },
      emit: ({ recv, present, bind }) => nullOr(recv, present, bind, (r) => ({ $strLenCP: r })),
    },
    stream: unsupported("'.length()' is a value, not a stage. Assign it to a field: '$.n = $.<field>.length()'."),
    statement: unsupported(
      "'.length()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.length();'",
    ),
    group: unsupported("'.length()' is not an accumulator. Use '$count' or '$sum' inside '$group'."),
    window: unsupported("'.length()' is not a window function."),
  }),

  now: name({
    doc: "The current time, in milliseconds.",
    call: true,
    on: "Date",
    returns: "unknown",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    updateDoc: unsupported(
      "'Date.now()' reads the server's clock, and a document-form update takes constants. For the time as a Date, '$.<field> = Date()' is '$currentDate'; for milliseconds, use the pipeline form ('jsmql.pipeline(\"$.t = Date.now();\")'), which 'updateOne' accepts as well.",
    ),
    expr: { args: { sig: "", none: true }, emit: () => ({ $toLong: "$$NOW" }) },
    stream: unsupported("'Date.now()' is a value. Use it inside a reshape or a '$set'."),
    statement: unsupported(
      "'.now()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.now();'",
    ),
    group: unsupported("'Date.now()' is not an accumulator."),
    window: unsupported("'Date.now()' is not a window function."),
  }),

  UTC: name({
    doc: "'Date.UTC(year, month, …)' — the millisecond count of a UTC instant from calendar parts; the month counts from 0, as in JavaScript.",
    call: true,
    on: "Date",
    returns: "number",
    neverNull: true,
    where: ["value"],
    filter: viaFallback,
    expr: {
      args: {
        sig: "year[, month, day, hour, minute, second, ms]",
        allowed: [1, 2, 3, 4, 5, 6, 7],
        slotType: { 1: "int" },
        rest: "int",
      },
      emit: ({ args, value }) => ({ $toLong: dateFromParts(args.map(value), "UTC") }),
    },
    stream: unsupported("'Date.UTC()' is a value. Use it inside a reshape or a '$set'."),
    statement: unsupported(
      "'.UTC()' computes a value, and a statement writes one. Assign it to a field: '$.<field> = <value>.UTC();'",
    ),
    group: unsupported("'Date.UTC()' is not an accumulator."),
    window: unsupported("'Date.UTC()' is not a window function."),
  }),

  from: name({
    doc: "'Array.from(…)' is not part of jsmql. See its refusal.",
    call: true,
    on: "Array",
    returns: "unknown",
    where: [],
    filter: fromIsNotJsmql,
    expr: fromIsNotJsmql,
    stream: fromIsNotJsmql,
    statement: fromIsNotJsmql,
    group: fromIsNotJsmql,
    window: fromIsNotJsmql,
  }),
};

export type NameKey = keyof typeof NAMES;

type DollarKey = `$${string}`;

type MisKeyed = {
  [K in NameKey]: (typeof NAMES)[K] extends { kind: "mongo" }
    ? K extends DollarKey
      ? never
      : K
    : (typeof NAMES)[K] extends { kind: "name" | "global" }
      ? K extends DollarKey
        ? K
        : never
      : never;
}[NameKey];

const _everyKeyMatchesItsKind: [MisKeyed] extends [never] ? true : MisKeyed = true;

type FieldOf<K extends NameKey, F extends string> = F extends keyof (typeof NAMES)[K]
  ? NonNullable<(typeof NAMES)[K][F]>
  : never;

type Mentioned<F extends string> = {
  [K in NameKey]: [FieldOf<K, F>] extends [never]
    ? never
    : FieldOf<K, F> extends readonly (infer V)[]
      ? V
      : FieldOf<K, F>;
}[NameKey];

type DanglingForbiddenIn = Exclude<Mentioned<"forbiddenIn">, NameKey>;
const _forbiddenInResolves: [DanglingForbiddenIn] extends [never] ? true : DanglingForbiddenIn = true;

type Inner<K extends NameKey> = FieldOf<K, "onlyInside">[keyof FieldOf<K, "onlyInside">];

type ContainersOf<K extends NameKey> = [FieldOf<K, "onlyInside">] extends [never]
  ? never
  : [Inner<K>] extends [never]
    ? never
    : Inner<K> extends readonly (infer V)[]
      ? V
      : never;

type DanglingOnlyInside = Exclude<{ [K in NameKey]: ContainersOf<K> }[NameKey], NameKey>;
const _onlyInsideResolves: [DanglingOnlyInside] extends [never] ? true : DanglingOnlyInside = true;

type DanglingImmutableTwin = Exclude<Mentioned<"immutableTwin">, NameKey>;
const _immutableTwinResolves: [DanglingImmutableTwin] extends [never] ? true : DanglingImmutableTwin = true;

void _immutableTwinResolves;
void _everyKeyMatchesItsKind;
void _forbiddenInResolves;
void _onlyInsideResolves;
