// The shared vocabulary the four registries are written in.
//
// The registries are split by COMPILER PHASE, so each has one key space and one
// job:
//
//   tokens.ts       lexical    what the lexer emits            keys: the spelling,
//                                                              or a class name for
//                                                              a token with none
//   keywords.ts     lexical    identifiers the lexer reserves  keys: the word
//   productions.ts  syntactic  how tokens combine              keys: descriptive
//   names.ts        semantic   everything resolved by name     keys: the name typed
//
// Two rules the split enforces, both checked by the type system inside the file
// that owns the referencing side:
//
//   * tokens.ts and keywords.ts hold NO MQL. The lexer is their only reader and
//     it cannot use a renderer, so a renderer there would be a fact in the wrong
//     phase. Everything that emits MQL lives in productions.ts or names.ts.
//   * every name one registry mentions must be a key of the registry it points
//     at — a production's tokens, a sugar form's precedence, a stage's forbidden
//     containers.
//
// The tree lives in ./ast.ts, which imports nothing, so `NodeName` below is
// DERIVED from the real shapes rather than written a second time by hand.
import type { Expr as AstExpr, Node as AstNode } from "./ast.ts";

export type Expr = AstExpr;
export type Node = AstNode;
export type QueryDoc = Record<string, unknown>;

/**
 * The one flat scratch field a `$group` may write. An accumulator's output key
 * cannot hold a dot, so scratch produced INSIDE a group cannot live under the
 * `__jsmql` object like every other temporary; it takes this reserved name and
 * the very next stage consumes it. The twin of `GROUP_TMP` in `src/namespace.ts`
 * — the registry imports nothing outside itself, and a test holds the two equal.
 */
export const GROUP_SLOT = "__jsmqlTmp";

/**
 * A JavaScript SPELLING compares the field's OWN value.
 *
 * MongoDB's query language satisfies a field comparison when ANY ELEMENT of an
 * array value satisfies it: `{ a: 1 }` selects `a: [1, 2]`, and `{ a: { $type:
 * "number" } }` selects an array holding a number. It also TRAVERSES an array in
 * the middle of a path: `{ "a.b": 1 }` selects `a: [{ b: 1 }]`. JavaScript does
 * neither — `[1, 2] === 1` is false, and reading `a.b` there gives `undefined`.
 * Containment already has its own JavaScript spelling (`.includes(x)`), and an
 * element test has `.some(e => …)`, so the query form of a JavaScript spelling
 * gives up nothing by reading one value.
 *
 * Raw MongoDB reached through the escape hatch — a `$op(…)` call, a raw `{ … }`
 * filter document — keeps MongoDB's own behaviour. There the developer writes
 * MQL, and MQL means what MQL means.
 *
 * Measured: the exclusion costs no index. `{ a: { $eq: 1, $not: { $type:
 * "array" } } }` plans an IXSCAN over the bounds `[1, 1]`, the same as `{ a: 1 }`.
 */
const NOT_AN_ARRAY = { $not: { $type: "array" } } as const;

/**
 * What a cell's answer is where JavaScript has no field value to compare. Two
 * facts, because a path reaches two kinds of nothing: an ABSENT field, which is
 * also what an array at a path PREFIX reads as, and a value that IS an array.
 * A cell states them about its own meaning; this file turns them into MQL.
 */
export type ValueReading = {
  /** Does the answer hold when the field is ABSENT? `$.a !== 1` holds. `$.a === 1` does not. */
  whenAbsent: boolean;
  /** Does the answer hold when the value IS an array? `!==` holds — no array is `===` a scalar. */
  whenArray: boolean;
  /**
   * The test asks about the FIELD, not about an element: `$exists` answers
   * whether the field is there, and `$elemMatch` asks whether it is an array
   * with a matching element. Neither takes a leaf exclusion, because neither can
   * be satisfied by an element the way `$eq` can. A PREFIX array is excluded all
   * the same — JavaScript reads that as absent.
   */
  ofTheField?: true;
};

/** Both readings false: the ordinary positive comparison. */
export const OWN_VALUE: ValueReading = { whenAbsent: false, whenArray: false };
/** Both true: the ordinary negated comparison, which every absent field and every array satisfies. */
export const NOT_OWN_VALUE: ValueReading = { whenAbsent: true, whenArray: true };
/** A test about the field itself — `$elemMatch`, `$exists` — which holds for neither nothing nor an array of its own accord. */
export const FIELD_VALUE: ValueReading = { whenAbsent: false, whenArray: false, ofTheField: true };

/** Every proper prefix of a dotted path — the segments MongoDB would traverse. */
const prefixesOf = (path: string): readonly string[] => {
  const seg = path.split(".");
  return seg.slice(0, -1).map((_, i) => seg.slice(0, i + 1).join("."));
};

/** A literal needle as a regular expression that matches it verbatim. */
export const escapeForRegex = (needle: string): string => needle.replace(/[.*+?^${}()|[\]\\]/g, (m) => "\\" + m);

/**
 * `test` — a query operator document the server evaluates element-wise — read as
 * JavaScript reads it: of the field's own value, at the end of a path that walks
 * through no array.
 *
 * An array VALUE is excluded at the leaf, or added back as an alternative when
 * the cell says it satisfies. An array at a PREFIX is the absent case: excluded
 * when the answer does not hold for an absent field, and offered as an
 * alternative when it does.
 */
export function queryOwnValue(path: string, test: Readonly<Record<string, unknown>>, reading: ValueReading): QueryDoc {
  const prefixes = prefixesOf(path);
  const elementWise = reading.ofTheField !== true;
  // A test that carries its own `$not` cannot take a second one in the same
  // document, so there the exclusion becomes a sibling clause — and none at all
  // when the test already IS the exclusion.
  const excludes = JSON.stringify(test) === JSON.stringify(NOT_AN_ARRAY);
  const leaf: QueryDoc =
    reading.whenArray || !elementWise || excludes
      ? { [path]: test }
      : "$not" in test
        ? { $and: [{ [path]: test }, { [path]: { ...NOT_AN_ARRAY } }] }
        : { [path]: { ...test, ...NOT_AN_ARRAY } };
  const alternatives: QueryDoc[] = [leaf];
  if (reading.whenArray && elementWise) alternatives.push({ [path]: { $type: "array" } });
  if (reading.whenAbsent) for (const p of prefixes) alternatives.push({ [p]: { $type: "array" } });
  // Every alternative built here holds a `$type` or an `$exists`, so a JSON
  // spelling separates them; nothing with a regex or a date reaches this list.
  const spelled = new Set<string>();
  const distinct = alternatives.filter((a) => {
    const k = JSON.stringify(a);
    return spelled.has(k) ? false : (spelled.add(k), true);
  });
  const one = distinct.length === 1 ? distinct[0] : { $or: distinct };
  if (reading.whenAbsent || prefixes.length === 0) return one;
  return { ...one, ...Object.fromEntries(prefixes.map((p) => [p, { ...NOT_AN_ARRAY }])) };
}
export type Stage = Record<string, unknown>;
/** OPERATOR_CATEGORIES from src/operators.ts, verbatim. */
export type OperatorCategory =
  | "arithmetic"
  | "array"
  | "bitwise"
  | "boolean"
  | "comparison"
  | "conditional"
  | "custom-aggregation"
  | "data-size"
  | "date"
  | "encrypted-string"
  | "literal"
  | "miscellaneous"
  | "object"
  | "set"
  | "string"
  | "text"
  | "timestamp"
  | "trigonometry"
  | "type"
  | "variable"
  | "window";
/**
 * A checkable argument type. Verbatim from what src/operators.ts enforces —
 * `int-or-long` and `number-or-date` are single checks there, not unions of two,
 * and collapsing them would state a narrower rule than the compiler applies.
 */
export type ArgType =
  | "number"
  | "string"
  /**
   * A field NAME the stage writes into — not a path to read. The server refuses
   * an empty one, a `$`-prefixed one and one holding a dot: measured,
   * `{ $count: "$n" }` answers "the count field cannot be a $-prefixed path" and
   * `{ $count: "a.b" }` "the count field cannot contain '.'". A plain `string`
   * cannot say it, and every stage that names an output field needs it.
   */
  | "fieldName"
  /**
   * The mirror of `fieldName`: a field PATH the stage READS, which the server
   * insists carries its own `$`. Measured: `{ $unwind: "items" }` answers "path
   * option to $unwind stage should be prefixed with a '$'", and so does the
   * `path` key of its object form.
   */
  | "fieldPath"
  | "int"
  | "int-or-long"
  | "number-or-date"
  | "date"
  | "timestamp"
  | "bool"
  | "object"
  | "array";

// ═════════════════════════════════════════════════════════════════════════════
// 1. LEXICAL — the tokens the lexer can produce, and the nodes the parser builds
// ═════════════════════════════════════════════════════════════════════════════

/** Every member of the lexer's TokenType. `token` on an entry must name one. */
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

/**
 * Every node a construct can produce, DERIVED from ./ast.ts. Written by hand it
 * drifted: the list still named MathCall, ObjectCall, TypeCastRef and eleven more
 * that the name-blind tree does not have, and nothing checked it.
 */
export type NodeName = AstNode["type"];

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE VOCABULARY
// ═════════════════════════════════════════════════════════════════════════════

/**
 * What a name can be attached to. The first group is JS value types (`stream`
 * is the `$$` document stream; `set` is a `new Set(...)` receiver). The second
 * is the three namespace receivers — the parser folds `Math.max(a, b)` into one
 * node whose name is `max` and whose receiver is `Math`, the same shape as
 * `$.rows.max()`. There is no `Set` namespace: `Set.union(...)` is not valid
 * jsmql; the set operations are names on a value.
 */
export type Family =
  | "string"
  | "array"
  | "number"
  | "object"
  | "date"
  | "regexp"
  | "set"
  | "stream"
  | "Math"
  | "Object"
  | "Number"
  | "Date"
  | "Array"
  /**
   * The cluster, reached through `$$$$`. A receiver family like the rest, because
   * the diagnostic source stages split by SCOPE and the wrong prefix is an error:
   *   $$.indexStats();    → [{ "$indexStats": {} }]
   *   $$$$.indexStats();  → "'indexStats' is a collection-scoped system stage"
   *   $$$$.currentOp();   → [{ "$currentOp": {} }]
   *   $$.currentOp();     → "'currentOp' is a cluster-scoped system stage"
   */
  | "cluster";

/** What may sit on either side of a binder. Coarser than `Family` on purpose. */
export type OperandClass = "value" | "namespace" | "name" | "collection" | "database" | "cluster";

/**
 * Where a construct is being read. One lexeme can form different constructs in
 * different contexts — `{` opens an object literal in an expression and a
 * parameter binding in a params slot — so a `forms` row names its context.
 */
export type Context = "expression" | "params" | "callArgs" | "statement" | "objectBody";

/**
 * How a call's ARGUMENTS are shaped. A third dispatch axis, alongside position
 * (`where`) and receiver (`on`): `ObjectId()` mints one, `ObjectId("<hex>")` is
 * a live BSON value, and `ObjectId($.id)` is `$toObjectId`. Same name, same
 * receiver, same position — three different MQL, chosen by the arguments.
 *
 * A PARTITION: every argument list falls in exactly one class, decided in this
 * order, so no two classes can claim the same call:
 *   "none"      ObjectId()
 *   "multiple"  new Date($.y, $.m, $.d)    MORE THAN ONE argument, whatever their
 *                                          types — a count, not a type:
 *                                            new Date($.ms)           → { $toDate: "$ms" }
 *                                            new Date($.y, $.m, $.d)  → { $dateFromParts: … }
 *   "object"    Array.from({ length: n })  one object literal
 *   "constant"  ObjectId("507f…")          one argument the fold could evaluate
 *   "dynamic"   ObjectId($.id)             one argument it could not
 * These are the keys of `ByArgs`; a row states one answer per class.
 */
export type ArgShape = "none" | "multiple" | "object" | "constant" | "dynamic";

/** The type a result has. Not the same set as `Family`. */
export type Kind =
  | "string"
  | "array"
  | "number"
  | "object"
  | "date"
  | "bool"
  | "stream"
  | "objectId"
  // MEASURED: { $type: { $hash: { input: "$s", algorithm: "sha256" } } } → "binData",
  // and the same for $toUUID. No other name produces one.
  | "binData";

/**
 * A position something can be written in. Each REQUIRES the matching renderer,
 * and each renderer requires the matching position here.
 *
 *   "value"     → `expr`    an aggregation expression
 *   "filter"    → `filter`  a find() predicate or $match body, with a NATIVE
 *                           query rendering. Omitting it does not forbid filter
 *                           position — see `ViaFallback`; it says there is no
 *                           indexable form, so the value form is wrapped.
 *   "stream"    → `stream`    a link in a `$$ = $$…` chain
 *   "statement" → `statement` a statement that is never a value
 *   "group"     → `group`     inside a $group output slot
 *   "window"    → `window`    inside $setWindowFields.output
 *   "updateDoc" → `updateDoc` inside the update DOCUMENT — the second argument to
 *                             updateOne/updateMany when it is an object, not an
 *                             array. A whole operator family lives only here:
 *                               db.products.updateOne(
 *                                 { sku: "abc123" },
 *                                 { $inc: { quantity: -2, "metrics.orders": 1 } })
 *                             is accepted, and the SAME document in a pipeline is
 *                             "Unrecognized pipeline stage name: '$inc'". Six
 *                             positions could not tell those apart, so $inc had to
 *                             claim it was valid nowhere.
 *
 * ONE POSITION, ONE CELL. No two positions share a cell, because every pair that
 * ever shared one turned out to hold opposite answers.
 *
 *   `stream` vs `statement`
 *     `$$.push(...$$$.archive);`     → [{ $unionWith: "archive" }]   a legal statement
 *     `$$ = $$.take(1).push(...);`   → refused, "use '.concat(...)' mid-chain"
 *     One cell had to pick, and picked the refusal — so the registry denied the
 *     form the language is most used for.
 *
 *   `group` vs `window`, proven both ways on mongod:
 *     $rank         in $group → "unknown group operator"  ; in a window → accepted
 *     $mergeObjects in $group → accepted                  ; in a window → "Unrecognized window function"
 *
 *   `group` vs `value` on ONE name — an accumulator is unary in a $group slot and
 *   variadic in a window slot:
 *     {$group:{v:{$avg:"$a"}}}                            → accepted
 *     {$group:{v:{$avg:["$a","$b"]}}}                     → "The $avg accumulator is a unary operator"
 *     {$setWindowFields:{output:{v:{$max:["$a","$b"]}}}}   → accepted
 *   which is why `args` lives on the CELL and never on the entry.
 */
export type Position = "value" | "filter" | "stream" | "statement" | "group" | "window" | "updateDoc";

/**
 * An extra rule no renderer implies, so it must be said.
 *
 *   "stageFirst"  must be the pipeline's first stage
 *   "stageLast"   must be its last
 *   "update"      one of the STAGES an update pipeline accepts — the whitelist
 *                 `jsmql.update` enforces. Without it $set and $sort look alike,
 *                 and only one of them is legal there. Not the same as the
 *                 `"updateDoc"` position: that is the object form of the update
 *                 argument, this is the array form.
 *   "afterSort"   a chain link that needs an ORDER already established:
 *                   $$ = $$.takeWhile(d => d.x > 1);
 *                     → ".takeWhile(<predicate>) needs a preceding sort"
 *                   $$ = $$.sortBy("x").takeWhile(d => d.x > 1);   works
 *
 * There is no "streamEnd". A link that may not continue a chain says so in its
 * own `stream` cell, which is the same fact where a reader already looks.
 */
export type Only = "stageFirst" | "stageLast" | "update" | "afterSort";

/**
 * The VARIABLES a MongoDB operator brings into scope, and in which of its keys
 * they are visible. Stated so the compiler applies one scope rule to both
 * spellings — the developer's own `$let({ vars: { k: 2 } }, …)` and the `$let`
 * a lowering writes — and a name the compiler mints steps aside from a variable
 * the developer declared. MEASURED per key: a variable read outside `visibleIn`
 * is "Use of undefined variable":
 *   { $filter: { input: "$a", cond: { $gt: ["$$this", 1] } } }              → runs
 *   { $filter: { input: "$a", cond: true, limit: { $add: ["$$this", 0] } } } → refused
 *   { $reduce: { input: "$a", initialValue: "$$this", in: "$$value" } }      → refused
 *
 *   keysOf   the keys of the object at this key are the variable names — `$let.vars`, `$lookup.let`
 *   valueAt  the string at this key is the ONE variable's name, `default` when absent — `$map.as`
 *   fixed    the operator names its variables itself — `$reduce`'s `this` and `value`
 */
export type Binds =
  | { keysOf: string; visibleIn: readonly string[] }
  | { valueAt: string; default: string; visibleIn: readonly string[] }
  | { fixed: readonly string[]; visibleIn: readonly string[] };

/** The result type. `.filter` on an array is an array; on a stream, a stream. */
export type Returns =
  | Kind
  | "same" //     whatever it attached to  (slice, clamp, filter)
  // An element of the receiver: `["a","b"].max()` is the string "b", not a number.
  // Used by at, nth, find, findLast, head, first, last, min, max, minBy, maxBy, sample.
  | "element"
  | "unknown"
  | Partial<Record<Family, Kind | "element" | "unknown">>;

/**
 * What one positional parameter of a callback BINDS.
 *
 * The names are JavaScript's and lodash's own, not invented here: `Array.map`
 * gives `(value, index, collection)`, `Array.reduce` gives
 * `(accumulator, value, index, collection)`, and lodash's `mapValues` gives
 * `(value, key, object)`. A row records the list its own API defines.
 */
export type ParamKind =
  /** reduce's running value. Becomes MongoDB's fixed `$$value`. */
  | "accumulator"
  /** The element, or an object entry's value. Two of them make a comparator. */
  | "value"
  /** The element's position. Referencing it changes what is iterated. */
  | "index"
  /** An object entry's key. */
  | "key"
  /** The whole collection being walked. */
  | "collection"
  /**
   * A variable DECLARED in a sibling argument, not drawn from a receiver:
   *   $let({ x: 1, y: 2 }, (p, q) => p + q)   p binds x, q binds y
   * Its arity comes from that sibling, so a row using it also sets
   * `paramsRepeat`. Calling this `"value"` would be a lie of the same kind the
   * field exists to remove — the parameter is a binding, not an element.
   */
  | "binding";

/**
 * A callback's parameter list, in order. Needed because one written shape means
 * three different things and only the NAME says which:
 *   $.a.map((x, i) => …)          x is the element,     i is the index
 *   $.a.reduce((x, i) => …, 0)    x is the accumulator, i is the element
 *   $.o.mapValues((x, i) => …)    x is the value,       i is the key
 * Without this a compiler must keep a hardcoded list of names, which is the one
 * thing the registry exists to remove.
 *
 * PER POSITION where the answer differs. `toSorted` is the measured case: a
 * one-parameter KEY function as a value, a two-parameter COMPARATOR as a stream
 * link.
 *   $.a.toSorted(d => d.x)              → { $sortArray: { sortBy: { x: 1 } } }
 *   $$ = $$.toSorted((a, b) => a.n - b.n) → [{ $sort: { n: 1 } }]
 *   $$ = $$.toSorted(d => d.n)          → "comparator requires two parameters"
 *
 * A list may be SHORTER than the API it names, and 13 of them are. That is
 * deliberate, not an omission, and each refusal says which:
 *   $.a.findIndex((v, i, arr) => arr)
 *     → "callbacks take at most 2 parameters (element, index); the third 'array'
 *        argument isn't supported. Reference the receiver directly instead."
 * So a list records what JSMQL accepts, and the API name says where to look for
 * the difference. One asymmetry it exposes: `.filter` takes the index and
 * `.reject`, its own negation, does not.
 */
export type CallbackParams = readonly ParamKind[] | Readonly<Partial<Record<Position, readonly ParamKind[]>>>;

/** An argument-count rule. Lives per RENDERER, and per FAMILY within one. */
export type Arity = {
  /** The human signature, for the error message: "start[, end]". */
  sig: string;
  exact?: number;
  allowed?: readonly number[];
  atLeast?: number;
  none?: true;
  /** `concat(...items)` — a spread is spliced in rather than refused. */
  spread?: true;
  /** A count that parses but is wrong for a reason worth saying. */
  reject?: Readonly<Record<number, string>>;
  /** Slots that must be compile-time constants HERE. */
  constant?: readonly number[];
  /** Per-slot literal type, checked only when the slot is a literal. */
  /**
   * A slot's accepted literal type, or the SET of them where a slot takes more
   * than one shape: `$unionWith` takes a collection NAME or a body document, and
   * the server refuses everything else ("the $unionWith stage specification must
   * be an object or string, but found int"). One type is the common case and
   * stays a bare `ArgType`.
   */
  slotType?: Readonly<Record<number, ArgType | readonly ArgType[]>>;
  /**
   * Slots holding an ARRAY LITERAL whose every element must be of one type:
   * `.pick(["name", "email"])` lists field names, and `.pick([1, 2])` would
   * project fields called "1" and "2". Checked only on a literal array.
   */
  arrayOf?: Readonly<Record<number, ArgType>>;
  /**
   * Slots whose literal must fall in a closed numeric range — `$sampleRate` takes
   * a rate in [0, 1]; the server refuses 2 ("must be in [0, 1]"). Checked only on
   * a literal number.
   */
  slotRange?: Readonly<Record<number, readonly [number, number]>>;
  /**
   * Slots that refuse a literal zero — a divisor: `$divide($.a, 0)` and
   * `$.a % 0` are refused by the server ("divisor cannot be 0"), and JavaScript's
   * NaN answer has no MongoDB value.
   */
  nonZero?: readonly number[];
  /**
   * Slots that refuse a literal `null` — the server errors rather than answering
   * null. A per-ROW fact, measured: `$size: null` and `$strLenCP: null` are
   * refused ("must be an array" / "requires a string argument"), while
   * `$reverseArray: null`, `$toUpper: null` and `$year: null` answer null or "".
   * Keyed by slot index like `slotType`.
   */
  nullRefused?: readonly number[];
  /**
   * An explicit EMPTY operand list is valid — `$and([])` → `{ $and: [] }` (true),
   * `$concat([])` → "". A separate fact from the positional count: `$and()` with
   * no argument is still refused by `atLeast`, because nothing was written.
   * MEASURED per row; `$divide([])` and `$ifNull([])` are refused by the server.
   */
  emptyList?: true;
  /**
   * The literal type EVERY operand must have, for a list operator — `$multiply`
   * takes numbers, `$add` numbers or dates. Checked only on a literal operand,
   * so `$multiply($.a, "x")` is refused and `$multiply($.a, $.b)` is not.
   */
  elementType?: ArgType;
  /**
   * Per-slot closed value set, checked only when the slot is a literal.
   *   $.d.plus(1, "day")   → accepted
   *   $.d.plus(30, "days") → refused, the plural is not a unit
   * Keyed by SLOT INDEX. `BodyRule.enums` is the same rule keyed by KEY NAME,
   * for an object-shaped body.
   */
  slotEnums?: Readonly<Record<number, readonly string[]>>;
  /** A regex literal in the slot must carry this flag — `.matchAll` needs `g`, as JavaScript does. */
  regexFlag?: Readonly<Record<number, string>>;
  /** An options document in the slot follows this rule — `.truncate({ length, omission })`. */
  body?: Readonly<Record<number, BodyRule>>;
  /** A string literal in the slot is a MongoDB date format — its `%` specifiers are checked. */
  dateFormat?: readonly number[];
  /** An arrow in the slot is refused with this message — `.includes(x => …)` searches a VALUE; the predicate method is named. */
  noCallback?: Readonly<Record<number, string>>;
};

/**
 * One accepted spelling of an argument slot. See `Arity.slotForms`.
 *
 * `bareCallable` is narrower than it looks — only the unary Math methods may be
 * handed over unapplied:
 *   $.items.map(Math.floor)  → accepted
 *   $.items.map(Math.asinh)  → refused, though it is equally unary
 * so a row that lists this form still states its own set beside it.
 */
/**
 * One spelling that stands in for the arrow in an iteratee slot.
 *
 *   propertyPath         $.rows.uniqBy("id")             means `r => r.id`
 *   matchesObject        $.rows.filter({ active: true })  means `r => r.active === true`
 *   matchesPropertyPair  $.rows.filter(["a.b", 1])        means `r => r.a.b === 1`
 *   bareCallable         $.items.map(String)              handed over unapplied
 *   omitted              $.rows.countBy()                 identity
 *
 * The arrow itself is not listed: every iteratee slot takes one, so naming it
 * would say nothing. See `NameSpec.iterateeSlots`.
 */
export type SlotForm = "propertyPath" | "matchesObject" | "matchesPropertyPair" | "bareCallable" | "omitted";

/**
 * One receiver's slot layout: which argument slots take an ITERATEE, and what
 * each accepts besides the arrow.
 *
 * Keyed by slot index, because the iteratee is not always the first argument:
 * `$.a.differenceBy($.b, "id")` compares against an array first — and which
 * index it is depends on the RECEIVER, which is why the layout is stated per
 * family. `$.items.groupBy(fn)` and `Object.groupBy($.items, fn)` are one row.
 */
export type IterateeSlots =
  | Readonly<Record<number, readonly SlotForm[]>>
  /**
   * ONLY an arrow is accepted on this receiver, and why — every other spelling
   * is refused. Spelled out rather than left as an empty layout: an omission and
   * a decision look alike, and this is the half that a rewrite pass must not
   * guess at.
   */
  | { arrowOnly: string }
  /**
   * The non-arrow spellings here are a SORT SPECIFICATION, not an iteratee:
   *   $.a.toSorted("k")          means an ORDER, `{ k: 1 }` — not `x => x.k`
   *   $.a.toSorted({ k: -1 })    the same, descending
   *   $.a.toSorted()             the natural order
   * Accepted, read by mql-sort.ts, and never rewritten to a callback. A different
   * fact from `arrowOnly` (those spellings are refused) and from a layout (those
   * spellings MEAN an arrow), so it has its own name.
   */
  | { sortSpec: string };

/** Is this an actual slot layout — the one variant a rewrite pass may read slots from? */
export const isSlotLayout = (l: IterateeSlots): l is Readonly<Record<number, readonly SlotForm[]>> =>
  !("arrowOnly" in l) && !("sortSpec" in l);

/** An object-shaped body: operators in object style, and every stage. */
export type BodyRule = {
  required: readonly string[];
  optional: readonly string[];
  /** false = extra keys pass through (HR2 passthrough). */
  closed: boolean;
  /** A key whose literal value must be one of a closed list. */
  enums?: Readonly<Record<string, readonly string[]>>;
  /**
   * A key whose literal value is a STRING OF FLAGS, each character of which must
   * be in the given set. Not an `enums` entry: the value is not one of a list,
   * it is any combination of the characters. `$regexMatch`'s `options` accepts
   * "imxs" and refuses a JavaScript "g" or "y".
   */
  charSets?: Readonly<Record<string, string>>;
  /** Keys whose literal value is compared case-insensitively — `startOfWeek`. */
  caseInsensitiveKeys?: readonly string[];
  keyTypes?: Readonly<Record<string, ArgType>>;
  /** Keys whose value must be a compile-time constant. */
  constantKeys?: readonly string[];
  /**
   * Each inner list is a set of keys of which EXACTLY ONE must be present.
   * `required` / `optional` cannot say it, and both cases are real:
   *   {$expMovingAvg:{input:"$a"}} → "either an 'N' field or an 'alpha' field"
   *   {$dateFromParts:{}}          → "requires either 'year' or 'isoWeekYear'"
   */
  exactlyOneOf?: readonly (readonly string[])[];
  /**
   * Each inner list is a set of keys that must be ALL present or ALL absent.
   * `required` cannot say it — every key of the set is optional on its own — and
   * `exactlyOneOf` says the opposite. Measured: `{ $lookup: { from: "o", as: "j",
   * localField: "a" } }` is refused with "$lookup requires both or neither of
   * 'localField' and 'foreignField' to be specified".
   */
  together?: readonly (readonly string[])[];
  /**
   * Each inner list is a set of keys of which AT LEAST ONE must be present —
   * unlike `exactlyOneOf`, more than one is fine. Measured on `$lookup`: it joins
   * by the `localField`/`foreignField` pair, or by a `pipeline`, or by both
   * together, and by none of them it is refused ("requires both or neither of
   * 'localField' and 'foreignField'", and with no `from` at all, "must specify
   * 'pipeline' when 'from' is empty").
   */
  atLeastOneOf?: readonly (readonly string[])[];
  /**
   * Every VALUE of the body must be one of these literals — a rule about the
   * values rather than the keys, because the keys are the developer's own field
   * names. Measured on `$sort`: a direction is 1 or -1 and nothing else
   * ("$sort key ordering must be 1 (for ascending) or -1 (for descending)", and
   * a string answers "Illegal key in $sort specification"). A value that is not a
   * literal passes, as does a document — `{ $meta: "textScore" }` is a real sort key.
   */
  everyValueIn?: readonly (string | number)[];
  /** Key groups that never appear together — the ISO-week and calendar parts of a date. */
  notTogether?: readonly (readonly (readonly string[])[])[];
  /**
   * The key order a POSITIONAL call maps onto, for an object-shaped operator:
   *   $dateTrunc($.t, "day")  → { date: "$t", unit: "day" }
   *   $hash($.s, "sha256")    → { input: "$s", algorithm: "sha256" }
   *
   * This is JSMQL's own order and a public commitment — NOT the vendored YAML's
   * key order. The two differ for $top, $topN, $firstN, $lastN and $map, and
   * taking the YAML's would emit valid MQL that answers a different question:
   *   $top($.score, { score: -1 })
   *     jsmql  → { $top: { output: "$score", sortBy: { score: -1 } } }
   *     YAML   → { $top: { sortBy: "$score", output: { score: -1 } } }
   * Both run. One is the query the user wrote.
   */
  positional?: readonly string[];
};

// ═════════════════════════════════════════════════════════════════════════════
// 3. WHAT EACH RENDERER IS HANDED — different per position, deliberately
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A condition ALREADY read for truth: the MQL that `$cond.if`, `$filter.cond`
 * and `$match.$expr` take as it stands. Only the compiler's mode module mints
 * one, and every slot that reads a boolean is typed to take one — so a VALUE
 * cannot land in a condition slot by mistake; the type error names the missing
 * `truth()` call. A brand, not a wrapper: at runtime a Truth IS the document.
 *
 *   $.name ? "has" : "none"        truth($.name) checks missing, null, false, "", 0
 *   $cond($.name, "has", "none")   the escape hatch hands "$name" on as it is
 *   Boolean($.a > 1)               `>` states `returns: "bool"`, so no check is added
 */
declare const TRUTH: unique symbol;
export type Truth = { readonly [TRUTH]: "truth" };

/**
 * What each position's renderer PRODUCES. Keyed by Position in one place, so
 * the cells and the dispatcher that switches on a position cannot disagree.
 */
export type OutOf = {
  value: unknown;
  filter: QueryDoc;
  stream: Stage[];
  statement: Stage[];
  group: unknown;
  window: unknown;
  updateDoc: unknown;
};

/**
 * A filter cell's result. A row that ALSO lists `value` may answer null — "no
 * native query form for these operands; wrap my value form in `$expr`":
 *   $.s.startsWith("A")          → { s: /^A/ }
 *   $.s.trim().startsWith("A")   → null, and becomes { $expr: { $eq: [{ $indexOfCP: … }, 0] } }
 * A filter-only row has no value form to fall back on, so its emit is total,
 * and a null there is a type error rather than a document the server refuses.
 */
export type FilterOut<HasValue extends boolean> = HasValue extends true ? QueryDoc | null : QueryDoc;

export type FilterIn = {
  /** This entry's own key. Lets a renderer emit `{ [name]: … }` without the
   *  name being written a second time inside the entry. */
  name: string;
  /** The receiver as SOURCE — a filter renders field paths, not lowered values. Null for none. */
  recv: Expr | null;
  args: readonly Expr[];
  /** This entry's `shape.positional` key order, empty when it has none. */
  keys: readonly string[];
  /**
   * The field path an expression names ("a.b.c"), or null when it is not a plain
   * path — an index, a call, `.length`, a computed key. Inside a `.some` callback
   * the element parameter is the root, so `i.q` is the path "q".
   */
  pathOf: (e: Expr) => string | null;
  /**
   * A compile-time value the QUERY language compares as written: a number, a
   * string, a boolean, null, a Date, an ObjectId. Boxed so that a constant `null`
   * is not "not constant". Null for anything else — an array (the server would
   * match array elements), a regex, a bigint, a document, an expression.
   */
  constant: (e: Expr) => { value: unknown } | null;
  /** A predicate as a query document, `$expr` fallback included. Always answers. */
  query: (e: Expr) => QueryDoc;
  /** The same, only when it has a NATIVE (indexable) form. Null otherwise. */
  nativeQuery: (e: Expr) => QueryDoc | null;
  /**
   * A one-parameter callback's body as the query an `$elemMatch` evaluates
   * against each ELEMENT — the parameter is the root there — or null when any
   * part of it has no native form.
   */
  elementQuery: (cb: Expr) => QueryDoc | null;
};

// ═════════════════════════════════════════════════════════════════════════════
// THE PREDICATE VOCABULARY — the facts the query and the expression cells share
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The BSON type aliases MongoDB's `$type` QUERY operator accepts. A `typeof`
 * comparison against any other spelling (`"function"`, `"bigint"`) has no query
 * form and keeps the expression fallback, so no query the server refuses is
 * emitted. `"number"` is here because the query form takes it as the umbrella
 * for int/long/double/decimal — while the aggregation `$type` expression never
 * RETURNS it; `TYPE_GROUPS` is how the expression cell absorbs that.
 */
export const BSON_TYPE_ALIASES: readonly string[] = [
  "double",
  "string",
  "object",
  "array",
  "binData",
  "undefined",
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
  "number",
];

/**
 * An umbrella alias → the concrete types the aggregation `$type` EXPRESSION can
 * return for it. The query form takes the umbrella; the expression form compares
 * against what `$type` answers, and it answers "int" or "double", never "number".
 * Comparing against the umbrella is how `typeof $.a === "number"` was once false
 * for every document.
 */
export const TYPE_GROUPS: Readonly<Record<string, readonly string[]>> = {
  number: ["double", "int", "long", "decimal"],
};

/**
 * The alias a `typeof x === "<spelling>"` test names, or null when it is not one
 * of MongoDB's type names. The developer's ruling: a `typeof` comparison speaks
 * MongoDB's vocabulary and nothing else — `"bool"`, not `"boolean"`; and
 * `"undefined"` IS a MongoDB type, the deprecated BSON one. Absence has its own
 * spelling, `x === undefined`. A spelling that is not a MongoDB type is refused
 * with the nearest one, never lowered to a test that quietly matches nothing.
 */
export function typeAliasOf(spelling: string): string | null {
  return BSON_TYPE_ALIASES.includes(spelling) ? spelling : null;
}

/**
 * The MongoDB name a JavaScript `typeof` answer points at, for the REFUSAL's
 * hint only — none of these is accepted. "boolean" is too far from "bool" for
 * the generic suggestion to find, and the developer who wrote it meant exactly that.
 */
export const TYPEOF_HINTS: Readonly<Record<string, string>> = {
  boolean: "bool",
  bigint: "long",
  function: "javascript",
};

export type ExprIn = {
  /** This entry's own key. See FilterIn.name. */
  name: string;
  /** The receiver, ALREADY lowered. Null for a namespace receiver, or none. */
  recv: unknown;
  args: readonly Expr[];
  /** See FilterIn.keys. */
  keys: readonly string[];
  /** Lower an expression to the MQL of its VALUE. */
  value: (e: Expr) => unknown;
  /** Lower an expression as a CONDITION, JavaScript truthiness applied. See `Truth`. */
  truth: (e: Expr) => Truth;
  /** A callback whose body is a value: `{ as, ref, in }`, the parameter bound as `$$as` (`ref`). */
  iteratee: (cb: Expr) => { as: string; ref: string; in: unknown };
  /**
   * An ARRAY callback of one to three parameters — `(x[, i[, arr]]) => …` — as
   * the input to iterate, the variable to iterate as, and the body. When the index
   * is read the input is the pairs `[i, x]` (`$zip` with a `$range`) and `paired`
   * says so, so a cell that returns an element unwraps it. `mode` reads the body
   * as a value or as a condition.
   */
  callback: (
    cb: Expr,
    mode: "value" | "truth",
  ) => { input: unknown; as: string; ref: string; paired: boolean; in: unknown };
  /** A sort argument as `{ field: dir }` keys, or a computed key function with its direction. */
  sortSpec: (e: Expr, objects?: boolean) => SortAsk;
  /** lodash's `orderBy(keys, orders)`. */
  orderBy: (keys: Expr, orders: Expr | undefined) => SortAsk;
  /** A callback whose body is a condition. */
  predicate: (cb: Expr) => { as: string; ref: string; in: Truth };
  /**
   * A callback over a document's `{ k, v }` pairs — `(value[, key]) => …` — as
   * the pair variable's name and the body reading `value` and `key` from it:
   * `{ as: "kv", ref: "$$kv", body: { $let: { vars: { v: "$$kv.v", k: "$$kv.k" }, in: … } } }`.
   */
  objIteratee: (cb: Expr) => { as: string; ref: string; body: unknown };
  /**
   * A REDUCER — `(acc, x[, i]) => …` with its seed — as what a `$reduce` takes:
   * the accumulator reads `$value`, the element `$this`; an index makes the
   * input the `[i, x]` pairs and the body a `$let` over them.
   */
  reducer: (cb: Expr, seed: Expr) => { input: unknown; in: unknown };
  /**
   * An arrow of `count` parameters over the elements of one array — `.zipWith`'s —
   * each parameter bound to its position of the element (`pick` chooses another
   * reading: `Array.from`'s `(_, i)` binds the index alone).
   */
  elements: (
    cb: Expr,
    count: number,
    pick?: (element: string, k: number) => unknown,
  ) => { as: string; ref: string; in: unknown };
  /**
   * A collision-free MongoDB variable: the bare name for an `as` / `vars` slot,
   * and the `$$name` that reads it.
   */
  bind: (hint: string) => { as: string; ref: string };
  /**
   * Place stages BEFORE the statement this expression stands in, and read back
   * the field they wrote — for a value that has no inline form:
   *   $.n = $$.length  →  [{ $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
   *                        { $set: { n: "$__jsmql.length" } }]
   */
  hoist: (stages: readonly Stage[], reads: string) => string;
  /** A fresh `__jsmql.tmp.<n>` scratch field path. */
  slot: () => string;
};

/**
 * What a MONGODB row's renderer is handed: no `truth`, no `predicate`. The
 * `$op(...)` escape hatch is the developer's own MQL, and its condition slots
 * keep MongoDB's truthiness ("" is true); the JavaScript spellings are where
 * JavaScript's rules apply.
 */
export type MongoExprIn = Pick<ExprIn, "name" | "recv" | "args" | "keys" | "value" | "bind">;

/**
 * What a sort argument asks for: keys by NAME, or a key COMPUTED from the document
 * (`d => d.cat.toLowerCase()`), which MongoDB cannot sort by directly — the cell
 * writes it to a scratch field and sorts by that.
 */
export type SortAsk =
  | { readonly kind: "keys"; readonly spec: Readonly<Record<string, 1 | -1>> }
  | { readonly kind: "computed"; readonly key: Expr; readonly dir: 1 | -1 };

export type StageIn = {
  /** This entry's own key. See FilterIn.name. */
  name: string;
  args: readonly Expr[];
  /**
   * A callback body as a query document against the stream's own fields —
   * the parameter IS the document. Total: a body with no native query form
   * arrives as `{ $expr: … }`.
   */
  predicate: (cb: Expr) => QueryDoc;
  /** A callback body as a value — a group key, an unwind path. */
  reshape: (cb: Expr) => unknown;
  /**
   * A callback body that must BE a document — the value `$replaceWith` takes.
   * A body the registry can prove is not one (`d => 5`) is refused with the
   * way to write it, because the server refuses every non-document root.
   */
  document: (cb: Expr) => unknown;
  /** A callback body that names a FIELD of the document — `d => d.items` — as its root path, `"$items"`. */
  fieldPath: (cb: Expr) => string;
  /**
   * A callback whose `{ … }` body is a list of STAGES — `.aggregate(o => { … })`
   * — as those stages, the parameter bound as the document.
   */
  block: (cb: Expr) => Stage[];
  value: (e: Expr) => unknown;
  /**
   * A sort argument as the `{ field: 1 | -1 }` document a `$sort` takes: a name,
   * a list of names, a `{ field: dir }` spec, a key function or a comparator.
   * `objects: false` refuses the spec form, where the method reads an object as
   * a lodash matcher (`.sortBy`).
   */
  sortSpec: (e: Expr, objects?: boolean) => SortAsk;
  /** lodash's `orderBy(keys, orders)`, the two arguments as one ask. */
  orderBy: (keys: Expr, orders: Expr | undefined) => SortAsk;
  /** A fresh `__jsmql.tmp.<n>` scratch field path; the chain's cleanup drops it. */
  slot: () => string;
  /** What the chain has already emitted — `sort().take(1)` reads this. */
  prevStages: readonly Stage[];
  bind: (hint: string) => { as: string; ref: string };
};

export type GroupIn = {
  name: string;
  /** The lowered receiver of a JavaScript accumulator alias — `$.amount` in `$.amount.sum()`; null for an operator call. */
  recv: unknown;
  args: readonly Expr[];
  keys: readonly string[];
  value: (e: Expr) => unknown;
  iteratee: (cb: Expr) => { as: string; ref: string; in: unknown };
};

export type SugarIn = {
  /** This entry's own key. See FilterIn.name. */
  name: string;
  captured: Readonly<Record<string, Expr>>;
  value: (e: Expr) => unknown;
  lowerSub: (stmts: readonly Node[]) => Stage[];
  bind: (hint: string) => { as: string; ref: string };
};

// ═════════════════════════════════════════════════════════════════════════════
// 4. A RENDERER — total. The one null answer is typed on the filter cell alone.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Produce the MQL. Total: every input has an answer. The one place null is an
 * answer is `FilterOut`, and the type says so there rather than here — so a
 * dispatcher never inspects a value renderer's result for a signal.
 */
export type Emit<In, Out> = (input: In) => Out;

/**
 * A declarative fact that has not moved into the registry yet, naming where it
 * still lives. Distinct from `unsupported` — that is a permanent answer, this is
 * a temporary one. A ratchet test counts these and may only let the count fall.
 */
export type Pending = {
  pending: string;
  /** The argument rule, which IS derived and correct even while the lowering is not here. */
  args?: Arity;
};

export const pending = (livesIn: string, args?: Arity): Pending =>
  args === undefined ? { pending: livesIn } : { pending: livesIn, args };

/**
 * The renderer is CODE, by design, and this names the file. Not `Pending`: a
 * pending cell is a fact that has yet to move into a row, and a ratchet counts
 * those down to zero. This cell never moves, because the lowering reads its
 * NEIGHBOURS — the operand types for `+` (`$add` or `$concat`), the truth of
 * the left side for `&&`, the receiver's shape for `x[0]` — and a single row
 * cannot see any of that. A row states that the construct exists and where it
 * is legal; the code says how it is built.
 */
export type InCode = { inCode: string };

export const inCode = (file: string): InCode => ({ inCode: file });

/** A refusal that carries the message the user should read instead. */
export type Refusal = {
  unsupported: string;
  /**
   * true when the message is the REASON only and the caller supplies the subject.
   *
   * One reason has to serve every spelling that can reach it, and the caller is
   * the only one that knows which spelling it is looking at:
   *   $$ = $$.toReversed()  →  "'.toReversed(...)' isn't available on '$$' — reverses
   *                            the stream, and a stream has no defined order …"
   * A row that spelled the subject itself would repeat the name the caller already
   * holds. Stated rather than inferred: the alternative is reading the first letter
   * of the message and guessing, which is a coupling nothing declares.
   */
  subjectFromCaller?: true;
};

/**
 * No NATIVE rendering in this position, but the code still compiles and runs:
 * the value form is wrapped automatically (`$expr` in a filter). Not a refusal —
 * `$.s.trim() === "x"` is legal as a filter, it just cannot use an index.
 *
 * Kept distinct from `Refusal` because they mean opposite things to a user, and
 * because counting these is exactly the list of "works but scans" surface —
 * the class the `.inRange` collection-scan belongs to.
 */
export type ViaFallback = { fallback: "expr" };

/**
 * No native rendering on its own, but this entry FOLDS INTO one when composed with
 * another — and the fold belongs to that other entry, named here.
 *
 *   `$.a % 2`        alone   → no query form
 *   `$.a % 2 === 0`  composed → {"a":{"$mod":[2,0]}}, native and indexable
 *
 * Distinct from `viaFallback`, which means "there is no native form in any
 * composition" — `$.a[0] === 1` really does become `$expr`. Conflating the two hid
 * four native renderings behind a field that said there were none.
 */
export type ComposedInto = { composedInto: readonly string[] };

/**
 * Name every row that folds this one in. A LIST, because the consumer sets are
 * plural and one owner states a true-but-partial fact:
 *   `$.a % 2 === 0` → { a: { $mod: [2, 0] } }            strictEquality
 *   `$.a % 2 !== 0` → { a: { $not: { $mod: [2, 0] } } }  strictInequality
 * so `remainder` is composed into both, and `memberAccess` into six.
 */
export const composedInto = <const O extends readonly string[]>(...owners: O): { composedInto: O } => ({
  composedInto: owners,
});

export const viaFallback: ViaFallback = { fallback: "expr" };

export const unsupported = (why: string): Refusal => ({ unsupported: why });

/** A refusal whose subject the caller supplies. See `subjectFromCaller`. */
export const because = (reason: string): Refusal => ({ unsupported: reason, subjectFromCaller: true });

/** The families a given `on` covers. */
export type Of<O> = O extends readonly (infer F extends Family)[] ? F : O extends Family ? O : Family;

/**
 * A BSON type name, as `$type` reports it and as the type tests (`$isNumber`,
 * `$isArray`, `{ $type: … }` in a query) name it.
 */
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

export type Rule<In, Out> = {
  args: Arity;
  /**
   * BSON types this family's runtime test admits BESIDES the family's own. A
   * per-row fact, stated where it is true and nowhere else:
   *   $.s.length  with s missing → 0,    because `length.string` claims null and missing
   *   $.s.trim()  with s missing → null, because `trim.string` claims nothing more
   * Read by the dispatch a receiver of unprovable family gets. A blanket rule
   * ("a string test admits null") would give `.trim()` a claim its own emit does
   * not honour.
   */
  alsoTypes?: readonly BsonType[];
  emit: Emit<In, Out>;
};

/**
 * The families a DOCUMENT FIELD's value can have, each with the `$type` names it
 * covers — the ONE table the runtime guards, the receiver readers and their
 * tests read. `Math`, `Object`, `Number`, `Date`, `Array` and `cluster` are
 * reached through a bare name, never through a field, and `stream` is `$$` — so
 * a receiver of unprovable family is one of these seven and no other. A `Set`
 * folds to an array, so it is one.
 */
export const FIELD_FAMILY_TYPES = {
  string: ["string"],
  array: ["array"],
  number: ["int", "long", "double", "decimal"],
  object: ["object"],
  date: ["date"],
  regexp: ["regex"],
  set: ["array"],
} as const satisfies Readonly<
  Record<Extract<Family, "string" | "array" | "number" | "object" | "date" | "regexp" | "set">, readonly BsonType[]>
>;
export type FieldFamily = keyof typeof FIELD_FAMILY_TYPES;

type IsUnion<T, U = T> = [T] extends [never] ? false : T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * What a receiver whose family CANNOT BE PROVEN gets — `$.x.length` where `x`
 * is a field of unknown type.
 *
 * REQUIRED when the row lists two or more field families, because then the
 * answer is a decision no rule implies: `length` says `$$REMOVE` (a two-way
 * `$cond` that read "not an array" as "string" aborted the whole command), and
 * `lastIndexOf` says the array form. Refused for a row with ONE field family:
 * there the receiver is that family by the row's own claim, exactly as
 * `$.price.ceil()` is a number because `.ceil()` is, and stating an `uncertain`
 * would be a second answer to a question with one.
 *
 * `Refusal` and `Pending` are answers too — "cannot tell which" is a decision.
 */
export type Uncertain<F extends Family, In, Out> =
  IsUnion<Extract<F, FieldFamily>> extends true
    ? { uncertain: Emit<In, Out> | Refusal | Pending }
    : { uncertain?: never };

/**
 * One answer per ARGUMENT class — see `ArgShape` for the partition. Keyed, not
 * ordered: two rows cannot overlap, and the leftover is STATED.
 */
export type ByArgs<In, Out> = {
  none?: Rule<In, Out> | Pending;
  multiple?: Rule<In, Out> | Pending;
  /** One object literal, which must carry `keys` — `Array.from({ length: n })`. */
  object?: { keys: readonly string[] } & (Rule<In, Out> | Pending);
  /**
   * A constant that REACHES a row is one the fold did not settle: a value with
   * no source spelling (a Date, an ObjectId — settled by the evaluator at the
   * call), a value the server would refuse (`ObjectId("nothex")` — a refusal,
   * in the developer's terms), or one whose TYPE the server decides
   * (`Number("3")` is a double; a folded `3` would be an int — a rule, so the
   * server converts).
   */
  constant?: Rule<In, Out> | Refusal | Pending;
  dynamic?: Rule<In, Out> | Pending;
  /** Every class no key above claims. Stated, so a leftover is a decision and not a hole. */
  otherwise: Refusal;
};

/**
 * A renderer. Either one rule for every family, or one rule PER family —
 * because the argument count can differ by receiver as well as by position:
 * `Math.max(a, b)` takes arguments, `$.rows.max()` takes none, and both are the
 * `max` entry. Every family `on` lists must appear, with a rule or with a
 * refusal that says why; no family `on` omits may appear. `uncertain` answers a
 * receiver whose family is not provable — see `Uncertain` for when it is required.
 */
export type Emitter<F extends Family, In, Out> =
  | Rule<In, Out>
  /**
   * A family may be `Pending` here, not only a rule or a refusal. `Object.keys`
   * works and `$.arr.keys()` is refused, and the working half still lives in
   * src/codegen.ts — without `Pending` the row had to invent an emitter for it.
   */
  | ({ perFamily: Record<F, Rule<In, Out> | Refusal | Pending> } & Uncertain<F, In, Out>)
  /**
   * Dispatch on the ARGUMENT SHAPE — the third axis, alongside position
   * (`where`) and receiver (`on`). `ObjectId()` mints one, `ObjectId("<hex>")`
   * is a live BSON value, `ObjectId($.id)` is `$toObjectId`: same name, same
   * receiver, same position, three different MQL. A row may be `Pending`
   * instead of a rule: the shape and the arity are registry facts, the lowering
   * is code.
   */
  | { byArgs: ByArgs<In, Out> };

// ═════════════════════════════════════════════════════════════════════════════
// 5. THE AGREEMENT RULE — `where` is written by hand and cannot contradict the
//    renderers beside it. Both directions are compile errors.
// ═════════════════════════════════════════════════════════════════════════════

export type Lists<W extends readonly string[], K extends string> = K extends W[number] ? true : false;

/**
 * Named in `where` ⇒ a real renderer, or `pending(<where it still lives>)`.
 * Absent from `where` ⇒ a refusal, with no escape hatch.
 *
 * The asymmetry is deliberate. `Pending` is allowed only on the half that is
 * about WHERE THE CODE SITS, never on the half that is about WHETHER THE
 * FEATURE APPLIES: a position `where` omits must still say why, so the
 * migration can move lowerings without ever softening an applicability claim.
 * A ratchet test counts the `Pending` cells and may only let the count fall.
 */
export type Cell<
  Listed extends boolean,
  F extends Family,
  In,
  Out,
  /**
   * The owners a `composedInto` cell may name. Threaded through so the literal
   * survives into the stored entry — without it the cell erases to
   * `{ composedInto: readonly string[] }` and an audit over the owners passes
   * while checking nothing, which is how two dangling owners went unnoticed.
   */
  C extends readonly string[] = readonly never[],
> = Listed extends true ? Emitter<F, In, Out> | Pending | InCode : NonEmitter<F, C>;

/**
 * The answer for a position `where` omits. One answer for every family, or one
 * PER family — because the reason a position is unavailable can differ by
 * receiver, and flattening it states a legality one family does not have:
 *
 *   `.length` in filter position
 *     $.tags.length < 5    → {$expr:{$cond:…}}     works, cannot use an index
 *     $.s.length < 5       → {$expr:{$cond:…}}     the same
 *     $$.length > 1        → REFUSED, "'$$.length' … needs Pipeline mode —
 *                            it materialises a '$setWindowFields' stage."
 *   One `viaFallback` for all three promised the stream form would merely scan,
 *   when it does not compile at all.
 */
export type NonEmitter<F extends Family, C extends readonly string[] = readonly never[]> =
  | Refusal
  | ViaFallback
  | { composedInto: C }
  | { perFamily: Record<F, Refusal | ViaFallback | ComposedInto> };

export type On = Family | readonly Family[] | "any";

// ═════════════════════════════════════════════════════════════════════════════

/**
 * The rendering every ACCUMULATOR slot shares — `$group` output and
 * `$setWindowFields.output` both.
 *
 * ONE operand, rendered plainly. Never as a one-element list, which every
 * accumulator refuses:
 *   {$group:{_id:null,r:{$push:["$a"]}}}  → "The $push accumulator is a unary operator"
 *   {$group:{_id:null,r:{$push:"$a"}}}    → accepted
 *
 * An operand that RENDERS as an array needs the shield, because `{acc: [ … ]}`
 * is read as an operand LIST there. Measured for `$push([$.x, $.y])`, whose one
 * argument is an array literal:
 *   {$group:{_id:null,r:{$push:["$x","$y"]}}}                      refused, as above
 *   {$group:{_id:null,r:{$push:{$let:{vars:{},in:["$x","$y"]}}}}}   → [[1,2],[3,4]]
 * The shield is only NEEDED in a $group slot — a window slot evaluates a bare
 * array as an expression and answers the same [[1,2],[3,4]] without it. Both
 * cells use this one emitter anyway, so the rule is stated once and the two
 * slots cannot drift apart.
 */
export const accumulated = (input: { name: string; args: readonly Expr[]; value: (e: Expr) => unknown }): unknown => {
  const operand = input.value(input.args[0]);
  return { [input.name]: Array.isArray(operand) ? { $let: { vars: {}, in: operand } } : operand };
};

/**
 * The rendering every SINGLE-operand operator shares: `{ $op: <operand> }`, the
 * operand as written. HR2 — `$size([$.a])` is the developer's own operand list
 * and round-trips as `{ $size: ["$a"] }`, which the server reads as one operand;
 * no wrap is added here. A JavaScript lowering that hands an ARRAY LITERAL to
 * such an operator (`[$.a, 2].length`) wraps it itself, because there the array
 * is the value and not a list — see the `length` row.
 */
export const single = (input: { name: string; args: readonly Expr[]; value: (e: Expr) => unknown }): unknown => ({
  [input.name]: input.value(input.args[0]),
});

/**
 * The rendering every OBJECT-SHAPED operator shares.
 *
 * One argument is the object-literal call and passes straight through. Two or
 * more is a POSITIONAL call, zipped onto the key order the entry already states
 * in `shape.positional` and handed back through `keys` — so the order is written
 * once per row, not twice:
 *   $dateTrunc({ date: $.t, unit: "day" })  → { $dateTrunc: { date: "$t", unit: "day" } }
 *   $dateTrunc($.t, "day")                  → the same document
 *   $trim($.name)                           → { $trim: { input: "$name" } }
 * One argument is the body only when it IS an object literal; a lone value is the
 * first positional. The previous per-row emitter read `args[0]` alone and dropped "day".
 */
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

// ═════════════════════════════════════════════════════════════════════════════
// 8. THE ENTRIES
// ═════════════════════════════════════════════════════════════════════════════
