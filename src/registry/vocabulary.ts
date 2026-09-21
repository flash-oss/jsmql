// The shared vocabulary of the four registries.
//
// The registries divide by COMPILER PHASE, so each one has one key space and one
// job:
//
//   tokens.ts       lexical    what the lexer emits            keys: the spelling,
//                                                              or a class name for
//                                                              a token with none
//   keywords.ts     lexical    identifiers the lexer reserves  keys: the word
//   productions.ts  syntactic  how tokens combine              keys: descriptive
//   names.ts        semantic   everything resolved by name     keys: the name typed
//
// The division holds two rules. The type system tests both, inside the file that
// owns the side which refers:
//
//   * tokens.ts and keywords.ts hold NO MQL. The lexer is their only reader, and
//     it cannot use a renderer. A renderer there is thus a fact in the wrong
//     phase. Everything that emits MQL lives in productions.ts or names.ts.
//   * every name that one registry mentions must be a key of the registry it
//     points at — the tokens of a production, the precedence of a sugar form,
//     the forbidden containers of a stage.
//
// The tree lives in ./ast.ts, which imports nothing. So `NodeName` below comes
// DIRECTLY from the real shapes, and no one writes it a second time by hand.
import type { Expr as AstExpr, Node as AstNode } from "./ast.ts";

export type Expr = AstExpr;
export type Node = AstNode;
export type QueryDoc = Record<string, unknown>;

/**
 * The one flat scratch field that a `$group` can write. The output key of an
 * accumulator cannot hold a dot. So scratch that a group makes INSIDE itself
 * cannot live under the `__jsmql` object like every other temporary. It takes
 * this reserved name, and the next stage consumes it. This is the twin of
 * `GROUP_TMP` in `src/namespace.ts`. The registry imports nothing outside
 * itself, and `test/registry-agrees.test.ts` holds the two equal.
 */
export const GROUP_SLOT = "__jsmqlTmp";

/**
 * The reserved field that holds the document count of the stream. A reader gets
 * it back as `"$" + LENGTH_SLOT`. It is reserved, so it cannot collide with a
 * binding of the user (`let length` takes `__jsmql.var.length`). The twin of
 * `LENGTH_SLOT` in
 * `src/namespace.ts`, held equal by the same test as `GROUP_SLOT` (`test/registry-agrees.test.ts`).
 * See docs/specs/stream-length.md.
 */
export const LENGTH_SLOT = "__jsmql.length";

/**
 * A query document writes `{ $eq: v }` as `v` — the spelling that every MongoDB
 * developer reads and writes. It does not do this where a reader takes `v` as
 * something else. An operator document (`{ $gt: 1 }`) and a regular expression
 * both mean a test at that position, not a value.
 */
const shorthand = (test: Readonly<Record<string, unknown>>): unknown => {
  const keys = Object.keys(test);
  if (keys.length !== 1 || keys[0] !== "$eq") return test;
  const v = test.$eq;
  if (isRegExp(v)) return test;
  const operatorDoc =
    typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).some((k) => k.startsWith("$"));
  return operatorDoc ? test : v;
};

/** A literal needle as a regular expression that matches it verbatim. */
export const escapeForRegex = (needle: string): string => needle.replace(/[.*+?^${}()|[\]\\]/g, (m) => "\\" + m);

/**
 * `test` — a query operator document — at `path`, as a query document.
 *
 * The MongoDB query language satisfies a field comparison when any ELEMENT of an
 * array value satisfies it. It also goes through an array in the middle of a path.
 * jsmql emits the query that a MongoDB developer writes by hand, and the rules of
 * the server then apply. `$.age > 18` is `{ age: { $gt: 18 } }`, the document that
 * every index plan and every code review speaks about. A comparison that must read
 * one value, and not an element, has its own JavaScript spelling: `.includes(x)`
 * for containment, and `.some(e => …)` for a test on an element.
 */
export function queryOwnValue(path: string, test: Readonly<Record<string, unknown>>): QueryDoc {
  return { [path]: shorthand(test) };
}
export type Stage = Record<string, unknown>;
/**
 * The categories that an operator row states. This is a value, not a union that
 * someone writes by hand. The type comes from the value, so a new category needs
 * one edit.
 */
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
/**
 * An argument type the compiler can check. `int-or-long` and `number-or-date` are
 * single checks, not unions of two. A merge of each pair states a rule narrower
 * than the rule the compiler applies.
 */
export type ArgType =
  | "number"
  | "string"
  /**
   * A field NAME the stage writes into, not a path it reads. The server refuses an
   * empty name, a name with a `$` prefix, and a name with a dot in it. MEASURED:
   * `{ $count: "$n" }` answers "the count field cannot be a $-prefixed path", and
   * `{ $count: "a.b" }` answers "the count field cannot contain '.'". A plain
   * `string` cannot say this, and every stage that names an output field needs it.
   */
  | "fieldName"
  /**
   * The mirror of `fieldName`: a field PATH the stage READS. The server demands
   * its own `$` on it. MEASURED: `{ $unwind: "items" }` answers "path option to
   * $unwind stage should be prefixed with a '$'". The `path` key of the object
   * form answers the same.
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
 * Every node a construct can make, DERIVED from ./ast.ts. A list that someone
 * writes by hand drifts: it can name MathCall, ObjectCall, TypeCastRef and more
 * that the name-blind tree does not have, and nothing tests it.
 */
export type NodeName = AstNode["type"];

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE VOCABULARY
// ═════════════════════════════════════════════════════════════════════════════

/**
 * What can carry a name. The first group holds the JavaScript value types.
 * `stream` is the `$$` document stream, and `set` is a `new Set(...)` receiver.
 * The second group holds the namespace receivers. The parser folds
 * `Math.max(a, b)` into one node whose name is `max` and whose receiver is
 * `Math`, the same shape as `$.rows.max()`. There is no `Set` namespace, because
 * `Set.union(...)` is not valid jsmql. The set operations are names on a value.
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
   * The cluster, which `$$$$` reaches. It is a receiver family like the rest,
   * because the diagnostic source stages divide by SCOPE, and the wrong prefix is
   * an error:
   *   $$.indexStats();    → [{ "$indexStats": {} }]
   *   $$$$.indexStats();  → "'indexStats' is a collection-scoped system stage"
   *   $$$$.currentOp();   → [{ "$currentOp": {} }]
   *   $$.currentOp();     → "'currentOp' is a cluster-scoped system stage"
   */
  | "cluster";

/** What can sit on either side of a binder. It is less exact than `Family`, on purpose. */
export type OperandClass = "value" | "namespace" | "name" | "collection" | "database" | "cluster";

/**
 * Where the parser reads a construct. One lexeme can form different constructs in
 * different contexts. A `{` opens an object literal in an expression, and a
 * parameter binding in a params slot. So a `forms` row names its context.
 */
export type Context = "expression" | "params" | "callArgs" | "statement" | "objectBody";

/**
 * The shape of the ARGUMENTS of a call. This is a third dispatch axis, beside
 * position (`where`) and receiver (`on`). `ObjectId()` mints one, `ObjectId("<hex>")`
 * is a live BSON value, and `ObjectId($.id)` is `$toObjectId`. Same name, same
 * receiver, same position, and three different MQL. The arguments decide.
 *
 * This is a PARTITION. Every argument list falls in exactly one class. The compiler
 * decides in this order, so no two classes can claim the same call:
 *   "none"      ObjectId()
 *   "multiple"  new Date($.y, $.m, $.d)    MORE THAN ONE argument, of any
 *                                          types. It is a count, not a type:
 *                                            new Date($.ms)           → { $toDate: "$ms" }
 *                                            new Date($.y, $.m, $.d)  → { $dateFromParts: … }
 *   "object"    $dateAdd({ startDate: …, … })  one object literal
 *   "constant"  ObjectId("507f…")          one argument the fold can evaluate
 *   "dynamic"   ObjectId($.id)             one argument the fold cannot evaluate
 * These are the keys of `ByArgs`. A row states one answer per class.
 */
type ArgShape = "none" | "multiple" | "object" | "constant" | "dynamic";

/** The type a result has. Not the same set as `Family`. */
/**
 * The kind a BSON value proves, by its tag.
 *
 * The four numeric types are `number`, because MongoDB holds them as one. Its own
 * `$type: "number"` alias IS int + long + double + decimal, and `$add`, `$gt` and
 * `$sum` take any of them. MEASURED on mongod: `$round` on a Decimal128 answers a
 * Decimal128, and `$max: [Long, Int32]` answers the Long.
 *
 * A `UUID` reports the tag `Binary`. For that reason the tag keys this table, and
 * not the class. From another copy of `bson`, the tag is all that a reader has.
 */
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

/**
 * The BSON type tag that a value carries, or undefined for anything else. Every
 * `bson` class sets one, and a reader of the tag needs no `bson` import. For that
 * reason the fact lives here, where a ROW can read it, and not in `src/bson.ts`
 * (which re-exports this). A value from a SECOND copy of `bson` also carries the
 * tag. That is the point: recognition must not depend on a shared prototype.
 */
export function bsonTagOf(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const tag = (v as { _bsontype?: unknown })._bsontype;
  // bson 1.x spells the tag of ObjectId with an upper-case D, and jsmql reads both.
  return typeof tag === "string" ? (tag === "ObjectID" ? "ObjectId" : tag) : undefined;
}

/**
 * What a value IS, read from its internal slot rather than its prototype.
 *
 * `instanceof Date` is false for a real Date from another realm — a `vm` context,
 * the sandbox of a test runner, a worker — because each realm has its own `Date`. A
 * parameter value can arrive from any of them. A Date that fails the test takes the
 * expression road and loses the index. `Object.prototype.toString` reads the
 * internal slot, and every realm sets that slot the same way. The reason is the same
 * as for `bsonTagOf`: recognition must not depend on a shared prototype.
 * See docs/specs/bson-types.md § Recognition across realms.
 */
const kindOf = (v: unknown): string => Object.prototype.toString.call(v);
export const isDate = (v: unknown): v is Date => kindOf(v) === "[object Date]";
export const isRegExp = (v: unknown): v is RegExp => kindOf(v) === "[object RegExp]";
/** A Uint8Array. A Node Buffer is one. */
export const isBytes = (v: unknown): v is Uint8Array => kindOf(v) === "[object Uint8Array]";
/**
 * A plain object: one that holds nothing but its own properties. It is not an array,
 * and its prototype is null or the root `Object.prototype` of WHICHEVER realm made it
 * (the one prototype whose own prototype is null). A BSON tag on it is a different
 * question, and `bsonTagOf` answers that one.
 */
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
  // MEASURED: { $type: { $hash: { input: "$s", algorithm: "sha256" } } } → "binData",
  // and $toUUID answers the same. No other name makes one.
  | "binData"
  // The two sentinels. They compare against every other type, and they compute with
  // NONE. MEASURED: `$add: [MinKey, 1]` answers "only supports numeric or date types".
  // A kind of their own is what makes that refusal a compile-time refusal.
  | "minKey"
  | "maxKey";

/**
 * A position that can hold a construct. Each one REQUIRES the matching renderer,
 * and each renderer requires the matching position here.
 *
 *   "value"     → `expr`    an aggregation expression
 *   "filter"    → `filter`  a find() predicate or $match body, with a NATIVE
 *                           query rendering. A row that omits it does not forbid
 *                           filter position — see `ViaFallback`. It says only
 *                           that there is no indexable form, so a wrap goes
 *                           around the value form.
 *   "stream"    → `stream`    a link in a `$$ = $$…` chain
 *   "statement" → `statement` a statement that is never a value
 *   "group"     → `group`     inside a $group output slot
 *   "window"    → `window`    inside $setWindowFields.output
 *   "updateDoc" → `updateDoc` inside the update DOCUMENT — the second argument to
 *                             updateOne/updateMany when it is an object, not an
 *                             array. One whole operator family lives only here:
 *                               db.products.updateOne(
 *                                 { sku: "abc123" },
 *                                 { $inc: { quantity: -2, "metrics.orders": 1 } })
 *                             runs, and the SAME document in a pipeline answers
 *                             "Unrecognized pipeline stage name: '$inc'". Six
 *                             positions cannot tell those two apart, and then $inc
 *                             must claim that it is valid nowhere.
 *
 * ONE POSITION, ONE CELL. No two positions share a cell, because each such pair
 * holds opposite answers.
 *
 *   `stream` vs `statement`
 *     `$$.push(...$$$.archive);`     → [{ $unionWith: "archive" }]   a legal statement
 *     `$$ = $$.take(1).push(...);`   → refused, "use '.concat(...)' mid-chain"
 *     One cell must take one of the two answers. If it takes the refusal, the
 *     registry denies the form that the language uses most.
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
 * What a slot of the body of a stage holds. It is one position where every shape
 * reads the same way. It is a pair where a BRACKETED LIST means one thing and any
 * other shape means another. `$merge.whenMatched` takes an update pipeline, or one
 * of four words.
 */
export type SlotPosition = Position | { readonly list: Position; readonly otherwise: Position };

/**
 * An extra rule no renderer implies, so it must be said.
 *
 *   "stageFirst"  must be the pipeline's first stage
 *   "stageLast"   must be its last
 *   "update"      one of the STAGES that an update pipeline accepts — the
 *                 whitelist that `jsmql.update` applies. Without it, $set and
 *                 $sort look alike, and only one of them is legal there. It is
 *                 not the `"updateDoc"` position: that one is the object form of
 *                 the update argument, and this one is the array form.
 *   "afterSort"   a chain link that needs an ORDER that already exists:
 *                   $$ = $$.takeWhile(d => d.x > 1);
 *                     → ".takeWhile(<predicate>) needs a preceding sort"
 *                   $$ = $$.sortBy("x").takeWhile(d => d.x > 1);   works
 *
 * There is no "streamEnd". A link that cannot continue a chain says so in its
 * own `stream` cell. That is the same fact, in the place where a reader looks.
 */
export type Only = "stageFirst" | "stageLast" | "update" | "afterSort";

/**
 * The VARIABLES that a MongoDB operator brings into scope, and the keys in which
 * they are visible. The row states this, so the compiler applies one scope rule to
 * both spellings: the `$let({ vars: { k: 2 } }, …)` of the developer, and the
 * `$let` that a lowering writes. A name that the compiler mints then keeps clear
 * of a variable that the developer declared. MEASURED per key: a read of a
 * variable outside `visibleIn` answers "Use of undefined variable":
 *   { $filter: { input: "$a", cond: { $gt: ["$$this", 1] } } }              → runs
 *   { $filter: { input: "$a", cond: true, limit: { $add: ["$$this", 0] } } } → refused
 *   { $reduce: { input: "$a", initialValue: "$$this", in: "$$value" } }      → refused
 *
 *   keysOf   the keys of the object at this key are the variable names — `$let.vars`, `$lookup.let`
 *   valueAt  the string at this key is the name of the ONE variable. Without it, `default` — `$map.as`
 *   fixed    the operator names its variables itself — the `this` and `value` of `$reduce`
 */
export type Binds =
  | { keysOf: string; visibleIn: readonly string[] }
  | { valueAt: string; default: string; visibleIn: readonly string[] }
  | { fixed: readonly string[]; visibleIn: readonly string[] };

/**
 * What the compiler PROVES about a value: the type tracker's one record.
 * See docs/specs/types.md.
 *
 *   kinds    the kinds the value can have — a closed set, or "any" when nothing is proven
 *   absent   true when the value may be null or missing. One flag for both, because
 *            every guard the compiler writes folds the two with `$ifNull`, and the
 *            truthiness rule reads them alike
 *   element  what ONE element is, when `kinds` holds `array`
 *   items    what each position holds, when the array has a fixed length — a `.entries()` pair
 *   props    the properties the compiler has seen, when `kinds` holds `object`
 *   open     true when the object may hold properties `props` does not name
 *   values   what a property `props` does not name holds, when `open` — a `.groupBy()` record
 *
 * A field the program never wrote is `{ kinds: "any", absent: true, open: true }`.
 * A literal proves itself. A row's `returns` states its result as a `TypeExpr`,
 * and the compiler evaluates it against the receiver and the arguments.
 */
export type Type = {
  readonly kinds: ReadonlySet<Kind> | "any";
  readonly absent: boolean;
  readonly element?: Type;
  readonly items?: readonly Type[];
  readonly props?: ReadonlyMap<string, Type>;
  readonly open: boolean;
  readonly values?: Type;
};

/**
 * The result type a row STATES, as data. The compiler evaluates it against the
 * receiver's `Type` and the arguments' types (src/compiler/emit/type.ts). It is a
 * closed grammar, so a test can measure every term on mongod, and the globals
 * generator can turn it into a TypeScript signature. A row whose result no term
 * describes states `"unknown"`, and a test lists those rows.
 *
 *   Kind                    a fixed kind — `.trim()` is a string
 *   "same"                  the receiver's type — `.slice()`, `.filter(p)`
 *   "element"               one element of the receiver — `.head()`, `.max()`
 *   "unknown"               follows the operands; nothing is stated
 *   { arrayOf: T }          an array whose elements are T — `.keys()` is `{ arrayOf: "string" }`
 *   { callback: n }         what the n-th callback argument returns — `.map(f)` is `{ arrayOf: { callback: 0 } }`
 *   { arg: n }              the n-th argument's type — `$ifNull(a, b)` reads its operands
 *   { merge: [T, …] }       an object merge; a later term's property wins — `.assign(o)`
 *   { recordOf: T }         an open object whose properties all hold T — `.groupBy(k)`
 *   { tuple: [T, …] }       an array of a fixed length — `.entries()` is `{ arrayOf: { tuple: ["string", "element"] } }`
 *   "picked" / "omitted"    the receiver's props kept / dropped by the first argument's names
 *   per-family map          one term per receiver family — `.filter` on an array is an array, on a stream a stream
 *
 * The per-family map is keyed by `Family`, whose members include `array` and
 * `object`; that is why the element form is spelled `arrayOf` and the record
 * form `recordOf`.
 */
export type TypeExpr =
  | Kind
  | "same"
  | "element"
  | "unknown"
  | "picked"
  | "omitted"
  | { readonly arrayOf: TypeExpr }
  | { readonly callback: number }
  | { readonly arg: number }
  | { readonly merge: readonly TypeExpr[] }
  | { readonly recordOf: TypeExpr }
  | { readonly tuple: readonly TypeExpr[] }
  | FamilyMap;

/** The per-family form of `TypeExpr`. An interface, so the recursion resolves. */
export interface FamilyMap extends Partial<Record<Family, TypeExpr>> {}

/**
 * What a STAGE does to the document `Type` the next stage sees. Every stage row
 * states one. The compiler evaluates it after the stage's own writes.
 * See docs/specs/types.md § The document after a stage.
 *
 *   "keeps"       the input fields survive; the body's writes go through the write rules — `$set`, `$match`, `$sort`
 *   "fields"      the document is exactly the body's keys, each typed by its value, closed — `$group`, `$facet`, `$count`
 *   "value"       the document is the body value's type — `$replaceRoot`, `$replaceWith`
 *   "projection"  inclusion keeps the named paths, closed; exclusion removes them — `$project`
 *   "element"     the named path becomes its element type — `$unwind`
 *   "unknown"     an open object with nothing known — `$unionWith`, `$documents`, a diagnostic stage
 */
export type DocumentEffect = "keeps" | "fields" | "value" | "projection" | "element" | "unknown";

/**
 * What one positional parameter of a callback BINDS.
 *
 * The names come from JavaScript and from lodash, and not from this project.
 * `Array.map` gives `(value, index, collection)`. `Array.reduce` gives
 * `(accumulator, value, index, collection)`. The `mapValues` of lodash gives
 * `(value, key, object)`. A row records the list that its own API defines.
 */
type ParamKind =
  /** The value that reduce carries. It becomes the fixed `$$value` of MongoDB. */
  | "accumulator"
  /** The element, or an object entry's value. Two of them make a comparator. */
  | "value"
  /** The position of the element. A read of it changes what the operator walks. */
  | "index"
  /** An object entry's key. */
  | "key"
  /** The whole collection that the operator walks. */
  | "collection"
  /**
   * A variable DECLARED in a sibling argument, not drawn from a receiver:
   *   $let({ x: 1, y: 2 }, (p, q) => p + q)   p binds x, q binds y
   * Its arity comes from that sibling: one parameter for each binding the call
   * declares. `elementsCallback` counts them there. The name `"value"` here is
   * false in the same way that this field exists to prevent: the parameter is a
   * binding, not an element.
   */
  | "binding";

/**
 * The parameter list of a callback, in order. It is necessary, because one
 * written shape means three different things, and only the NAME says which one:
 *   $.a.map((x, i) => …)          x is the element,     i is the index
 *   $.a.reduce((x, i) => …, 0)    x is the accumulator, i is the element
 *   $.o.mapValues((x, i) => …)    x is the value,       i is the key
 * Without this, a compiler must hold a hard-coded list of names. That is the one
 * thing that the registry exists to remove.
 *
 * PER POSITION where the answer differs. `toSorted` is the measured case: a
 * one-parameter KEY function as a value, a two-parameter COMPARATOR as a stream
 * link.
 *   $.a.toSorted(d => d.x)              → { $sortArray: { sortBy: { x: 1 } } }
 *   $$ = $$.toSorted((a, b) => a.n - b.n) → [{ $sort: { n: 1 } }]
 *   $$ = $$.toSorted(d => d.n)          → "comparator requires two parameters"
 *
 * A list can be SHORTER than the API it names, and 13 of the lists are. That is
 * deliberate, not an omission, and each refusal says which parameter it drops:
 *   $.a.findIndex((v, i, arr) => arr)
 *     → "callbacks take at most 2 parameters (element, index); the third 'array'
 *        argument isn't supported. Reference the receiver directly instead."
 * So a list records what JSMQL accepts, and the API name says where to look for
 * the difference. It shows one difference between two close names: `.filter` takes
 * the index, and `.reject`, its own negation, does not.
 */
export type CallbackParams = readonly ParamKind[] | Readonly<Partial<Record<Position, readonly ParamKind[]>>>;

/** A rule for the count of arguments. It lives per RENDERER, and per FAMILY inside one. */
export type Arity = {
  /** The human signature, for the error message: "start[, end]". */
  sig: string;
  exact?: number;
  allowed?: readonly number[];
  atLeast?: number;
  none?: true;
  /** `concat(...items)` — the compiler splices a spread in, and does not refuse it. */
  spread?: true;
  /** A count that the parser accepts, but which is wrong for a reason the message must give. */
  reject?: Readonly<Record<number, string>>;
  /** Slots that must be compile-time constants HERE. */
  constant?: readonly number[];
  /**
   * Slots whose literal string or array must not be empty, keyed by slot. `noun`
   * names one entry, and `instead` is the alternative at the end of the message.
   * MEASURED on `$unset`: `""` → "FieldPath cannot be constructed with empty
   * string", and `[]` → "must be a string or an array with at least one field".
   */
  nonEmpty?: Readonly<Record<number, { noun: string; instead: string }>>;
  /** The literal type per slot. The compiler tests it only when the slot holds a literal. */
  /**
   * The literal type a slot accepts, or the SET of types where a slot takes more
   * than one shape. `$unionWith` takes a collection NAME or a body document, and
   * the server refuses everything else ("the $unionWith stage specification must
   * be an object or string, but found int"). One type is the common case, and it
   * stays a bare `ArgType`.
   */
  slotType?: Readonly<Record<number, ArgType | readonly ArgType[]>>;
  /**
   * Slots that hold an ARRAY LITERAL in which every element must have one type.
   * `.pick(["name", "email"])` lists field names, and `.pick([1, 2])` projects
   * fields with the names "1" and "2". The compiler tests only a literal array.
   */
  arrayOf?: Readonly<Record<number, ArgType>>;
  /**
   * Slots whose literal must fall in a closed numeric range. `$sampleRate` takes a
   * rate in [0, 1], and the server refuses 2 ("must be in [0, 1]"). The compiler
   * tests only a literal number.
   */
  slotRange?: Readonly<Record<number, readonly [number, number]>>;
  /**
   * Slots that refuse a literal zero, which is to say a divisor. The server refuses
   * `$divide($.a, 0)` and `$.a % 0` ("divisor cannot be 0"), and the NaN answer of
   * JavaScript has no MongoDB value.
   */
  nonZero?: readonly number[];
  /**
   * Slots that refuse a literal `null`. The server raises an error there, and does
   * not answer null. This is a fact per ROW. MEASURED: the server refuses
   * `$size: null` and `$strLenCP: null` ("must be an array" / "requires a string
   * argument"), and `$reverseArray: null`, `$toUpper: null` and `$year: null`
   * answer null or "". The slot index keys it, as it keys `slotType`.
   */
  nullRefused?: readonly number[];
  /**
   * An explicit EMPTY operand list is valid — `$and([])` → `{ $and: [] }` (true),
   * and `$concat([])` → "". This is a different fact from the positional count.
   * `atLeast` still refuses `$and()` with no argument, because the developer wrote
   * nothing. MEASURED per row: the server refuses `$divide([])` and `$ifNull([])`.
   */
  emptyList?: true;
  /**
   * The literal type that EVERY operand must have, for a list operator.
   * `$multiply` takes numbers, and `$add` takes numbers or dates. The compiler
   * tests only a literal operand. So it refuses `$multiply($.a, "x")`, and it
   * accepts `$multiply($.a, $.b)`.
   */
  elementType?: ArgType;
  /**
   * A closed set of values per slot. The compiler tests it only on a literal slot.
   *   $.d.plus(1, "day")   → accepted
   *   $.d.plus(30, "days") → refused, the plural is not a unit
   * The SLOT INDEX keys it. `BodyRule.enums` is the same rule, and the KEY NAME
   * keys that one, for a body in object shape.
   */
  slotEnums?: Readonly<Record<number, readonly string[]>>;
  /** A regex literal in the slot must carry this flag. `.matchAll` needs `g`, as JavaScript needs it. */
  regexFlag?: Readonly<Record<number, string>>;
  /** An options document in the slot obeys this rule — `.truncate({ length, omission })`. */
  body?: Readonly<Record<number, BodyRule>>;
  /** A string literal in the slot is a MongoDB date format. The compiler tests its `%` specifiers. */
  dateFormat?: readonly number[];
  /** The compiler refuses an arrow in the slot with this message. `.includes(x => …)` searches for a VALUE, and the message names the predicate method. */
  noCallback?: Readonly<Record<number, string>>;
};

/**
 * One spelling that stands in for the arrow in an iteratee slot.
 *
 *   propertyPath         $.rows.uniqBy("id")             means `r => r.id`
 *   matchesObject        $.rows.filter({ active: true })  means `r => r.active === true`
 *   matchesPropertyPair  $.rows.filter(["a.b", 1])        means `r => r.a.b === 1`
 *   bareCallable         $.items.map(String)              means `x => String(x)` (a callable global)
 *   omitted              $.rows.countBy()                 identity
 *
 * The list holds no entry for the arrow itself. Every iteratee slot takes an
 * arrow, so an entry for it says nothing. See `NameSpec.iterateeSlots`.
 */
export type SlotForm = "propertyPath" | "matchesObject" | "matchesPropertyPair" | "bareCallable" | "omitted";

/**
 * The slot layout of one receiver: which argument slots take an ITERATEE, and what
 * each slot accepts beside the arrow.
 *
 * The slot index keys it, because the iteratee is not always the first argument.
 * `$.a.differenceBy($.b, "id")` compares against an array first. The RECEIVER
 * decides which index it is, and for that reason the layout is per family.
 * `$.items.groupBy(fn)` and `Object.groupBy($.items, fn)` are one row.
 */
export type IterateeSlots =
  | Readonly<Record<number, readonly SlotForm[]>>
  /**
   * This receiver accepts ONLY an arrow, and this cell says why. The compiler
   * refuses every other spelling. The row states it, and does not leave an empty
   * layout, because an omission and a decision look alike. A rewrite pass must not
   * guess at this half.
   */
  | { arrowOnly: string }
  /**
   * The non-arrow spellings here are a SORT SPECIFICATION, not an iteratee:
   *   $.a.toSorted("k")          means an ORDER, `{ k: 1 }` — not `x => x.k`
   *   $.a.toSorted({ k: -1 })    the same, descending
   *   $.a.toSorted()             the natural order
   * The compiler accepts these, src/compiler/emit/sort-spec.ts reads them, and no
   * pass ever rewrites them to a callback. This is a different fact from
   * `arrowOnly`, which refuses those spellings, and from a layout, where those
   * spellings MEAN an arrow. So it has its own name.
   */
  | { sortSpec: string };

/** Is this a true slot layout? It is the one variant from which a rewrite pass can read slots. */
export const isSlotLayout = (l: IterateeSlots): l is Readonly<Record<number, readonly SlotForm[]>> =>
  !("arrowOnly" in l) && !("sortSpec" in l);

/** An object-shaped body: operators in object style, and every stage. */
export type BodyRule = {
  required: readonly string[];
  optional: readonly string[];
  /** false = an extra key passes through (HR2 passthrough). */
  closed: boolean;
  /** A key whose literal value must come from a closed list. */
  enums?: Readonly<Record<string, readonly string[]>>;
  /**
   * A key whose literal value is a STRING OF FLAGS. Every character of it must be
   * in the given set. This is not an `enums` entry, because the value does not
   * come from a list. It is any combination of the characters. The `options` key
   * of `$regexMatch` accepts "imxs", and refuses the JavaScript "g" or "y".
   */
  charSets?: Readonly<Record<string, string>>;
  /** Keys whose literal value the compiler compares without regard to case — `startOfWeek`. */
  caseInsensitiveKeys?: readonly string[];
  keyTypes?: Readonly<Record<string, ArgType>>;
  /** Keys whose value must be a constant at compile time. */
  constantKeys?: readonly string[];
  /**
   * Keys whose string the server reads as ITSELF, and never as a field path. So
   * the closed set also judges a string with a `$` at the start. MEASURED on
   * `$merge`: `{ whenMatched: "$g" }` → "Enumeration value '$g' for field
   * 'whenMatched' is not a valid value". `constantKeys` includes this rule and
   * says more, because those keys also refuse an expression. A key that can hold
   * a sub-pipeline states this rule alone, because a pipeline is not a constant.
   */
  literalKeys?: readonly string[];
  /**
   * Every literal 0/1/false/true value of the body must agree. A projection holds
   * all inclusions or all exclusions, and `_id` is the one exception. MEASURED:
   * `{ $project: { a: 1, b: 0 } }` → "Cannot do exclusion on field b in inclusion
   * projection".
   */
  onePolarity?: true;
  /**
   * A rule for the OBJECT that a key holds — `$setWindowFields.output`. The
   * compiler applies it when the developer writes the value as an object literal.
   */
  nested?: Readonly<Record<string, BodyRule>>;
  /**
   * A rule for EVERY value of the body that is an object literal: each entry of
   * `$fill.output`, and each output of `$setWindowFields.output`.
   */
  eachValue?: BodyRule;
  /**
   * A key that becomes necessary when a value elsewhere in the body holds one of
   * the listed literals. The `sortBy` of `$fill` is an example, when any
   * `output.<k>.method` is "linear". `path` walks the body, and `"*"` stands for
   * any key. MEASURED: "$linearFill must be specified with a top level sortBy
   * expression".
   */
  requiresWhen?: readonly { path: readonly string[]; equals: readonly string[]; requires: string }[];
  /**
   * The body must name at least one key. MEASURED: `{ $project: {} }` →
   * "projection specification must have at least one field".
   */
  nonEmpty?: true;
  /**
   * A key whose literal number must be at least the stated minimum. MEASURED:
   * `$sample.size` 0 → "must be a positive integer", `$bucketAuto.buckets` 0 →
   * "must be greater than 0", `$graphLookup.maxDepth` -1 → "requires a nonnegative argument".
   */
  minimums?: Readonly<Record<string, number>>;
  /**
   * A key whose literal array must hold at least the stated number of constants,
   * in ascending order. MEASURED on `$bucket.boundaries`: `[1]` → "must have at
   * least 2 values", and `[3, 1, 2]` → "must be sorted".
   */
  sortedList?: Readonly<Record<string, number>>;
  /**
   * Each inner list is a set of keys, of which EXACTLY ONE must be present.
   * `required` and `optional` cannot say this, and both cases are real:
   *   {$expMovingAvg:{input:"$a"}} → "either an 'N' field or an 'alpha' field"
   *   {$dateFromParts:{}}          → "requires either 'year' or 'isoWeekYear'"
   */
  exactlyOneOf?: readonly (readonly string[])[];
  /**
   * Each inner list is a set of keys that must be ALL present or ALL absent.
   * `required` cannot say this, because every key of the set is optional on its
   * own, and `exactlyOneOf` says the opposite. MEASURED: the server refuses
   * `{ $lookup: { from: "o", as: "j", localField: "a" } }` with "$lookup requires
   * both or neither of 'localField' and 'foreignField' to be specified".
   */
  together?: readonly (readonly string[])[];
  /**
   * Each inner list is a set of keys, of which AT LEAST ONE must be present.
   * Unlike `exactlyOneOf`, more than one key is correct here. MEASURED on
   * `$lookup`: it joins by the `localField`/`foreignField` pair, or by a
   * `pipeline`, or by both together. With none of them, the server refuses it
   * ("requires both or neither of 'localField' and 'foreignField'", and with no
   * `from` at all, "must specify 'pipeline' when 'from' is empty").
   */
  atLeastOneOf?: readonly (readonly string[])[];
  /**
   * Every VALUE of the body must be one of these literals. This is a rule about
   * the values, and not about the keys, because the keys are the field names of
   * the developer. MEASURED on `$sort`: a direction is 1 or -1 and nothing else
   * ("$sort key ordering must be 1 (for ascending) or -1 (for descending)", and a
   * string answers "Illegal key in $sort specification"). A value that is not a
   * literal passes, and so does a document, because `{ $meta: "textScore" }` is a
   * real sort key.
   */
  everyValueIn?: readonly (string | number)[];
  /** Groups of keys that never come together: the ISO-week parts and the calendar parts of a date. */
  notTogether?: readonly (readonly (readonly string[])[])[];
  /**
   * The order of keys onto which a POSITIONAL call maps, for an operator in object shape:
   *   $dateTrunc($.t, "day")  → { date: "$t", unit: "day" }
   *   $hash($.s, "sha256")    → { input: "$s", algorithm: "sha256" }
   *
   * This is the order of JSMQL itself, and a public commitment. It is NOT the key
   * order of the vendored YAML. The two differ for $top, $topN, $firstN, $lastN
   * and $map. The order of the YAML emits valid MQL that answers a different
   * question:
   *   $top($.score, { score: -1 })
   *     jsmql  → { $top: { output: "$score", sortBy: { score: -1 } } }
   *     YAML   → { $top: { sortBy: "$score", output: { score: -1 } } }
   * Both run. One is the query the user wrote.
   */
  positional?: readonly string[];
};

// ═════════════════════════════════════════════════════════════════════════════
// 3. WHAT EACH RENDERER RECEIVES — different per position, deliberately
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A condition that the compiler ALREADY read for truth: the MQL that `$cond.if`,
 * `$filter.cond` and `$match.$expr` take as it stands. Only the mode module of the
 * compiler mints one, and the type of every slot that reads a boolean takes one.
 * So a VALUE cannot land in a condition slot by mistake, and the type error names
 * the absent `truth()` call. This is a brand, not a wrapper: at run time a Truth
 * IS the document.
 *
 *   $.name ? "has" : "none"        truth($.name) tests missing, null, false, "", 0
 *   $cond($.name, "has", "none")   the escape hatch hands "$name" on as it is
 *   Boolean($.a > 1)               `>` states `returns: "bool"`, so the compiler adds no test
 */
declare const TRUTH: unique symbol;
export type Truth = { readonly [TRUTH]: "truth" };

/**
 * What the renderer of each position MAKES. Position keys it in one place, so the
 * cells and the dispatcher that switches on a position cannot disagree.
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
 * The result of a filter cell. A row that ALSO lists `value` can answer null. Null
 * means: these operands have no native query form, so put an `$expr` wrap around
 * the value form:
 *   $.s.startsWith("A")          → { s: /^A/ }
 *   $.s.trim().startsWith("A")   → null, and becomes { $expr: { $eq: [{ $indexOfCP: … }, 0] } }
 * A filter-only row has no value form behind it, so its emit is total. A null
 * there is a type error, and not a document that the server refuses.
 */
export type FilterOut<HasValue extends boolean> = HasValue extends true ? QueryDoc | null : QueryDoc;

export type FilterIn = {
  /** The key of this entry. A renderer can emit `{ [name]: … }`, and no one
   *  writes the name a second time inside the entry. */
  name: string;
  /** The receiver as SOURCE. A filter renders field paths, not lowered values. Null for no receiver. */
  recv: Expr | null;
  args: readonly Expr[];
  /** The `shape.positional` key order of this entry. It is empty when the entry has none. */
  keys: readonly string[];
  /**
   * The field path that an expression names ("a.b.c"), or null when the expression
   * is not a plain path. An index, a call, `.length` and a computed key are not
   * plain paths. Inside a `.some` callback the element parameter is the root, so
   * `i.q` is the path "q".
   */
  pathOf: (e: Expr) => string | null;
  /**
   * A compile-time value that the QUERY language compares as written: a number, a
   * string, a boolean, null, a Date, an ObjectId. A box holds it, so that a
   * constant `null` does not read as "not constant". The result is null for
   * anything else: an array (the server matches array elements), a regex, a
   * bigint, a document, an expression.
   */
  constant: (e: Expr) => { value: unknown } | null;
  /** A predicate as a query document, with the `$expr` fallback. It always answers. */
  query: (e: Expr) => QueryDoc;
  /** The same, but only when the predicate has a NATIVE (indexable) form. Null in all other cases. */
  nativeQuery: (e: Expr) => QueryDoc | null;
  /**
   * The body of a callback of one parameter, as the query that an `$elemMatch`
   * evaluates against each ELEMENT. The parameter is the root there. The result is
   * null when any part of the body has no native form.
   */
  elementQuery: (cb: Expr) => QueryDoc | null;
  /** The argument as an aggregation expression: the operand of `$expr(e)`. */
  value: (e: Expr) => unknown;
  /** The FIELD that a query operator tests — `$exists($.a)` — or the refusal that names the form. It is a service, so it can throw. */
  fieldPath: (e: Expr) => string;
  /** A compile-time constant that the operator compares against (a regex literal becomes a RegExp), or the refusal. */
  literal: (e: Expr) => unknown;
  /** The same literal in a box, or null when the argument is read at run time. A cell then takes the expression road. */
  literalOf: (e: Expr) => { value: unknown } | null;
  /** A predicate arrow of `$elemMatch`, as the query document over one element, or the refusal when the body has no query form. */
  element: (cb: Expr) => QueryDoc;
};

// ═════════════════════════════════════════════════════════════════════════════
// THE PREDICATE VOCABULARY — the facts the query and the expression cells share
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The BSON type aliases that the `$type` QUERY operator of MongoDB accepts. A
 * `typeof` comparison against any other spelling (`"function"`, `"bigint"`) has no
 * query form and keeps the expression fallback. So jsmql emits no query that the
 * server refuses. `"number"` is here because the query form takes it as the
 * umbrella for int/long/double/decimal. The aggregation `$type` expression never
 * RETURNS it, and `TYPE_GROUPS` is how the expression cell covers that.
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
 * An umbrella alias → the exact types that the aggregation `$type` EXPRESSION can
 * return for it. The query form takes the umbrella. The expression form compares
 * against the answer of `$type`, and that answer is "int" or "double", never
 * "number". A comparison against the umbrella makes `typeof $.a === "number"`
 * false for every document.
 */
export const TYPE_GROUPS: Readonly<Record<string, readonly string[]>> = {
  number: ["double", "int", "long", "decimal"],
};

/**
 * The alias that a `typeof x === "<spelling>"` test names, or null when the
 * spelling is not a MongoDB type name. The developer made the rule: a `typeof`
 * comparison speaks the vocabulary of MongoDB and nothing else. It takes `"bool"`,
 * not `"boolean"`. `"undefined"` IS a MongoDB type, the deprecated BSON one.
 * Absence has its own spelling, `x === undefined`. The compiler refuses a spelling
 * that is not a MongoDB type, and names the nearest one. It never lowers the test
 * to one that silently matches nothing.
 */
export function typeAliasOf(spelling: string): string | null {
  return BSON_TYPE_ALIASES.includes(spelling) ? spelling : null;
}

/**
 * The MongoDB name at which an answer of the JavaScript `typeof` points. It
 * serves the hint of the REFUSAL only, because the compiler accepts none of these.
 * "boolean" is too far from "bool" for the generic suggestion, and the developer
 * who writes it means exactly that name.
 */
export const TYPEOF_HINTS: Readonly<Record<string, string>> = {
  boolean: "bool",
  bigint: "long",
  function: "javascript",
};

export type ExprIn = {
  /** The key of this entry. See FilterIn.name. */
  name: string;
  /** The receiver, ALREADY lowered. Null for a namespace receiver, and for no receiver. */
  recv: unknown;
  args: readonly Expr[];
  /** See FilterIn.keys. */
  keys: readonly string[];
  /** Lower an expression to the MQL of its VALUE. */
  value: (e: Expr) => unknown;
  /**
   * The kind that an expression PROVABLY has, or "unknown". It is the same proof
   * that the receiver dispatch reads, and this cell offers it for an ARGUMENT. An
   * operator that takes one BSON type reads it, and then renders an argument of
   * another type as JavaScript renders it. MEASURED: the optimiser of the server
   * folds a run of ADJACENT constant operands inside `$concat` / `$concatArrays`,
   * and it raises an error there when a folded constant has the wrong type. This
   * happens before the server takes any `$switch` branch, so a guard cannot stop
   * it.
   */
  kind: (e: Expr) => Kind | "unknown";
  /**
   * Is the receiver certainly THERE — never null, and never missing? It is true for
   * the array of a `$lookup`, a literal, `$range(…)`, the keys of the root document,
   * a chain of `neverNull` rows over one of those, and a runtime family dispatch
   * whose `$type` test already proved the branch. A cell whose operator stops on
   * null (`$size`, `$in`, the input of `$map`) guards its receiver with `$ifNull`,
   * unless this is true. MEASURED: `{ $size: null }` stops the whole command, and
   * every array operator answers null for a missing field.
   */
  present: boolean;
  /**
   * Does this ARGUMENT carry a `?.` on the way to its base? A `?.` is the developer
   * who says that the value can be absent.
   *
   * The compiler answers that for a RECEIVER on its own. It puts the empty value of
   * the family around the receiver before a cell sees it. A NAMESPACE call has no
   * such receiver: `Object.keys(o)` describes `Object`, and `o` is the value that
   * the call reads. So the row asks, and `Object.keys($.user?.profile)` takes the
   * same neutral value as `$.user?.profile?.keys()`.
   */
  optionalArg: (e: Expr) => boolean;
  /** Lower an expression as a CONDITION, with the JavaScript truth rules. See `Truth`. */
  truth: (e: Expr) => Truth;
  /** A callback whose body is a value: `{ as, ref, in }`. The parameter binds as `$$as` (`ref`). */
  iteratee: (cb: Expr) => { as: string; ref: string; in: unknown };
  /**
   * An ARRAY callback of one to three parameters — `(x[, i[, arr]]) => …` — as the
   * input to walk, the variable to walk with, and the body. When the body reads the
   * index, the input is the pairs `[i, x]` (`$zip` with a `$range`), and `paired`
   * says so. A cell that answers an element then unwraps it. `mode` reads the body
   * as a value or as a condition.
   */
  callback: (
    cb: Expr,
    mode: "value" | "truth",
  ) => { input: unknown; as: string; ref: string; paired: boolean; in: unknown };
  /** A sort argument as `{ field: dir }` keys, or a key function with its direction. */
  sortSpec: (e: Expr, objects?: boolean) => SortAsk;
  /** The `orderBy(keys, orders)` of lodash. */
  orderBy: (keys: Expr, orders: Expr | undefined) => SortAsk;
  /** A callback whose body is a condition. */
  predicate: (cb: Expr) => { as: string; ref: string; in: Truth };
  /**
   * A callback over the `{ k, v }` pairs of a document — `(value[, key]) => …` — as
   * the name of the pair variable, and the body that reads `value` and `key` from
   * it:
   * `{ as: "kv", ref: "$$kv", body: { $let: { vars: { v: "$$kv.v", k: "$$kv.k" }, in: … } } }`.
   */
  objIteratee: (cb: Expr) => { as: string; ref: string; body: unknown };
  /**
   * A REDUCER — `(acc, x[, i]) => …` with its seed — as what a `$reduce` takes.
   * The accumulator reads `$value`, and the element reads `$this`. An index makes
   * the input the `[i, x]` pairs, and the body a `$let` over them.
   */
  reducer: (cb: Expr, seed: Expr) => { input: unknown; in: unknown };
  /**
   * An arrow of `count` parameters over the elements of one array, as `.zipWith`
   * takes. Each parameter binds to its own position of the element.
   */
  elements: (cb: Expr, count: number) => { as: string; ref: string; in: unknown };
  /**
   * A collision-free MongoDB variable: the bare name for an `as` / `vars` slot,
   * and the `$$name` that reads it.
   */
  bind: (hint: string) => { as: string; ref: string };
  /**
   * Put stages BEFORE the statement that holds this expression, and read back the
   * field they wrote. This serves a value that has no inline form:
   *   $.n = $$.length  →  [{ $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
   *                        { $set: { n: "$__jsmql.length" } }]
   */
  hoist: (stages: readonly Stage[], reads: string) => string;
  /** A new `__jsmql.tmp.<n>` scratch field path. */
  slot: () => string;
};

/**
 * What the renderer of a MONGODB row receives: no `truth`, and no `predicate`. The
 * `$op(...)` escape hatch is the MQL of the developer, and its condition slots keep
 * the truth rules of MongoDB ("" is true). The JavaScript rules apply to the
 * JavaScript spellings only.
 */
export type MongoExprIn = Pick<ExprIn, "name" | "recv" | "args" | "keys" | "value" | "bind">;

/**
 * What a sort argument asks for: keys by NAME, or a key that the compiler COMPUTES
 * from the document (`d => d.cat.toLowerCase()`). MongoDB cannot sort by such a key
 * directly, so the cell writes it to a scratch field and sorts by that field.
 */
export type SortAsk =
  | { readonly kind: "keys"; readonly spec: Readonly<Record<string, 1 | -1>> }
  | { readonly kind: "computed"; readonly key: Expr; readonly dir: 1 | -1 }
  | { readonly kind: "whole"; readonly dir: 1 | -1; readonly params: readonly [string, string]; readonly pos: number };

/** A sort ask that a `$sort` STAGE can carry. It is never the whole element, because that has no field name. */
export type StageSortAsk = Exclude<SortAsk, { kind: "whole" }>;

export type StageIn = {
  /** This entry's own key. See FilterIn.name. */
  name: string;
  args: readonly Expr[];
  /**
   * The body of a callback, as a query document against the fields of the stream.
   * The parameter IS the document. This service is total: a body with no native
   * query form arrives as `{ $expr: … }`.
   */
  predicate: (cb: Expr) => QueryDoc;
  /** The body of a callback as a value: a group key, or an unwind path. */
  reshape: (cb: Expr) => unknown;
  /**
   * The body of a callback that must BE a document: the value that `$replaceWith`
   * takes. The compiler refuses a body that the registry proves is not a document
   * (`d => 5`), and the message gives the correct way to write it. The server
   * refuses every root that is not a document.
   */
  document: (cb: Expr) => unknown;
  /** The body of a callback that names a FIELD of the document — `d => d.items` — as its root path, `"$items"`. */
  fieldPath: (cb: Expr) => string;
  /**
   * A callback whose `{ … }` body is a list of STAGES — `.aggregate(o => { … })` —
   * as those stages. The parameter binds as the document.
   */
  block: (cb: Expr) => Stage[];
  value: (e: Expr) => unknown;
  truth: (e: Expr) => Truth;
  /** The body of a callback as a TRUTH over the document of the stream: the test of `.takeWhile(o => o.ok)` inside a window expression. */
  condition: (cb: Expr) => Truth;
  /** The sort that the stream carries: the last `$sort` before this link, or the refusal that tells the developer to sort first. */
  sortedBy: () => Readonly<Record<string, unknown>>;
  /**
   * A sort argument as the `{ field: 1 | -1 }` document that a `$sort` takes. It
   * can be a name, a list of names, a `{ field: dir }` spec, a key function or a
   * comparator. `objects: false` refuses the spec form, where the method reads an
   * object as a lodash matcher (`.sortBy`).
   */
  sortSpec: (e: Expr, objects?: boolean) => StageSortAsk;
  /** The `orderBy(keys, orders)` of lodash: the two arguments as one ask. */
  orderBy: (keys: Expr, orders: Expr | undefined) => StageSortAsk;
  /** A new `__jsmql.tmp.<n>` scratch field path. The cleanup of the chain drops it. */
  slot: () => string;
  bind: (hint: string) => { as: string; ref: string };
  /**
   * The ELEMENT of the stream: what the parameter of a callback stands for. It is
   * the document (`path: ""`, read as `$$ROOT`), or, after `.flatMap("items")`, the
   * unwound field (`path: "items"`, read as `"$items"`). A cell that keys on the
   * element itself (`.uniq()`), or that names its fields (`.pick([…])`), reads it
   * here.
   */
  element: () => { readonly path: string; readonly ref: string };
  /**
   * The element now lives in `path`. A cell that unwinds an array field says so,
   * and the callback of every later link reads its parameter there. A stage that
   * replaces the document (`$replaceWith`, `$group`, …) makes the document the
   * element again.
   */
  unwound: (path: string) => void;
};

/**
 * The WRITE FORM of a mutator: the JSMQL expression that its statement means, by
 * the count of arguments. `_r` stands for the receiver, and `_0`, `_1`, … stand
 * for the arguments as the developer wrote them. The desugar pass parses the form
 * and writes it back to the receiver:
 *   $.a.pop();        { 0: "[..._r].slice(0, -1)" }   → $.a = [...$.a].slice(0, -1);
 * The form spreads the receiver into an array literal on purpose. `.pop()` exists
 * on an array alone, so the form states what the spelling proves, and the value
 * cells take the array branch with no runtime type dispatch (`[...$.a]` lowers to
 * `"$a"`, so the proof costs nothing).
 * The row states the form as source, so a reader sees exactly what the statement
 * means, and so the form reaches the same value cells as the spelling that a
 * developer writes.
 */
export type MutatorForm = { readonly sig: string; readonly by: Readonly<Record<number, string>> };

export type GroupIn = {
  name: string;
  /** The lowered receiver of a JavaScript accumulator alias: `$.amount` in `$.amount.sum()`. It is null for an operator call. */
  recv: unknown;
  args: readonly Expr[];
  keys: readonly string[];
  value: (e: Expr) => unknown;
  iteratee: (cb: Expr) => { as: string; ref: string; in: unknown };
};

// ═════════════════════════════════════════════════════════════════════════════
// 4. A RENDERER — total. The one null answer is typed on the filter cell alone.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Make the MQL. It is total, because every input has an answer. The one place
 * where null is an answer is `FilterOut`, and the type says so there, not here. So
 * a dispatcher never reads the result of a value renderer for a signal.
 */
export type Emit<In, Out> = (input: In) => Out;

/**
 * The renderer is CODE, by design, and this cell names the file. The cell never
 * moves into a row, because the lowering reads its NEIGHBOURS: the operand types
 * for `+` (`$add` or `$concat`), the truth of the left side for `&&`, and the
 * shape of the receiver for `x[0]`. A single row cannot see any of that. A row
 * states that the construct exists, and where it is legal. The code says how the
 * compiler builds it.
 */
type InCode = { inCode: string };

export const inCode = (file: string): InCode => ({ inCode: file });

/** A refusal that carries the message for the user to read. */
export type Refusal = {
  unsupported: string;
  /**
   * true when the message gives the REASON only, and the caller gives the subject.
   *
   * One reason must serve every spelling that can reach it, and only the caller
   * knows which spelling it reads:
   *   $$ = $$.toReversed()  →  "'.toReversed(...)' isn't available on '$$' — reverses
   *                            the stream, and a stream has no defined order …"
   * A row that spells the subject itself repeats the name that the caller already
   * holds. The row states this flag, and no pass infers it. The alternative is to
   * read the first letter of the message and to guess, and that is a connection
   * which nothing declares.
   */
  subjectFromCaller?: true;
};

/**
 * There is no NATIVE rendering in this position, but the code still compiles and
 * runs. The compiler puts a wrap around the value form (`$expr` in a filter). This
 * is not a refusal: `$.s.trim() === "x"` is legal as a filter, and it only cannot
 * use an index.
 *
 * It stays separate from `Refusal`, because the two mean opposite things to a
 * user, and because a count of these gives the list of the surface that "works but
 * scans". Every collection scan that stays belongs to that class.
 */
export type ViaFallback = { fallback: "expr" };

/**
 * There is no native rendering for this entry alone. The entry FOLDS INTO one when
 * it composes with another entry. The fold belongs to that other entry, which this
 * cell names.
 *
 *   `$.a % 2`        alone   → no query form
 *   `$.a % 2 === 0`  composed → {"a":{"$mod":[2,0]}}, native and indexable
 *
 * This is not `viaFallback`, which means "there is no native form in any
 * composition". `$.a[0] === 1` truly becomes `$expr`. One field for both facts
 * hides a native rendering behind a claim that there is none.
 */
type ComposedInto = { composedInto: readonly string[] };

/**
 * Name every row that folds this one in. It is a LIST, because a row can have more
 * than one consumer, and one owner states a fact that is true but partial:
 *   `$.a % 2 === 0` → { a: { $mod: [2, 0] } }            strictEquality
 *   `$.a % 2 !== 0` → { a: { $not: { $mod: [2, 0] } } }  strictInequality
 * so `remainder` is composed into both, and `memberAccess` into six.
 */
export const composedInto = <const O extends readonly string[]>(...owners: O): { composedInto: O } => ({
  composedInto: owners,
});

export const viaFallback: ViaFallback = { fallback: "expr" };

export const unsupported = (why: string): Refusal => ({ unsupported: why });

/** A refusal whose subject the caller gives. See `subjectFromCaller`. */
export const because = (reason: string): Refusal => ({ unsupported: reason, subjectFromCaller: true });

/** The families that a given `on` covers. */
export type Of<O> = O extends readonly (infer F extends Family)[] ? F : O extends Family ? O : Family;

/**
 * A BSON type name, as `$type` reports it, and as the type tests name it
 * (`$isNumber`, `$isArray`, `{ $type: … }` in a query).
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
   * The BSON types that the runtime test of this family admits, BESIDES the types
   * of the family itself. This is a fact per row. The row states it where it is
   * true, and nowhere else:
   *   $.s.length  with s missing → 0,    because `length.string` claims null and missing
   *   $.s.trim()  with s missing → null, because `trim.string` claims nothing more
   * The dispatch for a receiver of unprovable family reads it. A general rule
   * ("a string test admits null") gives `.trim()` a claim that its own emit does
   * not keep.
   */
  alsoTypes?: readonly BsonType[];
  emit: Emit<In, Out>;
};

/**
 * The families that the value of a DOCUMENT FIELD can have, each one with the
 * `$type` names it covers. It is the ONE table that the runtime guards, the
 * receiver readers and their tests read. A bare name reaches `Math`, `Object`,
 * `Number`, `Date`, `Array` and `cluster`, and no field reaches them. `stream` is
 * `$$`. So a receiver of unprovable family is one of these seven and no other. A
 * `Set` folds to an array, so it is an array.
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
 * What a receiver whose family the compiler CANNOT PROVE gets — `$.x.length`
 * where `x` is a field of unknown type.
 *
 * It is NECESSARY when the row lists two or more field families. The answer is
 * then a decision that no rule implies. `length` says `$$REMOVE`, because a
 * two-way `$cond` that reads "not an array" as "string" stops the whole command.
 * `lastIndexOf` says the array form. A row with ONE field family refuses it.
 * There the receiver is that family by the claim of the row itself, exactly as
 * `$.price.ceil()` is a number because `.ceil()` is a number. An `uncertain` there
 * is a second answer to a question that has one.
 *
 * A `Refusal` is also an answer: "cannot tell which" is a decision.
 */
type Uncertain<F extends Family, In, Out> =
  IsUnion<Extract<F, FieldFamily>> extends true ? { uncertain: Emit<In, Out> | Refusal } : { uncertain?: never };

/**
 * One answer per ARGUMENT class. See `ArgShape` for the partition. A key holds
 * each answer, and no order applies. So two rows cannot overlap, and the row
 * STATES what stays.
 */
type ByArgs<In, Out> = {
  none?: Rule<In, Out>;
  multiple?: Rule<In, Out>;
  /**
   * A constant that REACHES a row is one that the fold did not settle. It is a
   * value with no source spelling (a Date, an ObjectId, which the evaluator
   * settles at the call), or a value that the server refuses (`ObjectId("nothex")`,
   * which becomes a refusal in the terms of the developer), or one whose TYPE the
   * server decides (`Number("3")` is a double, and a folded `3` is an int, so a
   * rule sends it to the server to convert).
   */
  constant?: Rule<In, Out> | Refusal;
  dynamic?: Rule<In, Out>;
  /** Every class that no key above claims. The row states it, so what stays is a decision and not a hole. */
  otherwise: Refusal;
};

/**
 * A renderer. It holds one rule for every family, or one rule PER family. The
 * count of arguments can differ by receiver as well as by position: `Math.max(a, b)`
 * takes arguments, `$.rows.max()` takes none, and both are the `max` entry. Every
 * family that `on` lists must appear, with a rule or with a refusal that says why.
 * No family that `on` omits can appear. `uncertain` answers a receiver whose family
 * the compiler cannot prove. See `Uncertain` for when a row must state it.
 */
export type Emitter<F extends Family, In, Out> =
  | Rule<In, Out>
  /** One answer per family: a rule where the method applies, and a refusal where it does not. */
  | ({ perFamily: Record<F, Rule<In, Out> | Refusal> } & Uncertain<F, In, Out>)
  /**
   * Dispatch on the ARGUMENT SHAPE, the third axis, beside position (`where`) and
   * receiver (`on`). `ObjectId()` mints one, `ObjectId("<hex>")` is a live BSON
   * value, and `ObjectId($.id)` is `$toObjectId`. Same name, same receiver, same
   * position, and three different MQL.
   */
  | { byArgs: ByArgs<In, Out> };

// ═════════════════════════════════════════════════════════════════════════════
// 5. THE AGREEMENT RULE — `where` is written by hand and cannot contradict the
//    renderers beside it. Both directions are compile errors.
// ═════════════════════════════════════════════════════════════════════════════

export type Lists<W extends readonly string[], K extends string> = K extends W[number] ? true : false;

/**
 * A name in `where` ⇒ a real renderer, or `inCode(<the file that builds it>)`.
 * A name absent from `where` ⇒ a refusal, with no escape hatch. A position that
 * `where` omits must still say WHY, so every claim about applicability is stated.
 */
export type Cell<
  Listed extends boolean,
  F extends Family,
  In,
  Out,
  /**
   * The owners that a `composedInto` cell can name. The type goes through the
   * generic, so the literal stays in the stored entry. Without it, the cell erases
   * to `{ composedInto: readonly string[] }`, and an audit over the owners passes
   * but tests nothing. A dangling owner then stays invisible.
   */
  C extends readonly string[] = readonly never[],
> = Listed extends true ? Emitter<F, In, Out> | InCode : NonEmitter<F, C>;

/**
 * The answer for a position that `where` omits. It holds one answer for every
 * family, or one PER family. The reason that a position is not available can
 * differ by receiver. One flat answer then states a legality that one family does
 * not have:
 *
 *   `.length` in filter position
 *     $.tags.length < 5    → {$expr:{$cond:…}}     works, cannot use an index
 *     $.s.length < 5       → {$expr:{$cond:…}}     the same
 *     $$.length > 1        → REFUSED, "'$$.length' … needs Pipeline mode —
 *                            it materialises a '$setWindowFields' stage."
 *   One `viaFallback` for all three promises that the stream form only scans.
 *   In fact the stream form does not compile at all.
 */
type NonEmitter<F extends Family, C extends readonly string[] = readonly never[]> =
  | Refusal
  | ViaFallback
  | { composedInto: C }
  | { perFamily: Record<F, Refusal | ViaFallback | ComposedInto> };

export type On = Family | readonly Family[] | "any";

// ═════════════════════════════════════════════════════════════════════════════

/**
 * The rendering that every ACCUMULATOR slot shares: the output of `$group` and
 * `$setWindowFields.output`, both.
 *
 * It is ONE plain operand. It is never a list of one element, which every
 * accumulator refuses:
 *   {$group:{_id:null,r:{$push:["$a"]}}}  → "The $push accumulator is a unary operator"
 *   {$group:{_id:null,r:{$push:"$a"}}}    → accepted
 *
 * An operand that RENDERS as an array needs the shield, because a reader takes
 * `{acc: [ … ]}` there as an operand LIST. MEASURED for `$push([$.x, $.y])`, whose
 * one argument is an array literal:
 *   {$group:{_id:null,r:{$push:["$x","$y"]}}}                      refused, as above
 *   {$group:{_id:null,r:{$push:{$let:{vars:{},in:["$x","$y"]}}}}}   → [[1,2],[3,4]]
 * Only a $group slot NEEDS the shield. A window slot evaluates a bare array as an
 * expression, and answers the same [[1,2],[3,4]] without it. Both cells use this
 * one emitter, so the rule stays in one place and the two slots cannot drift
 * apart.
 */
export const accumulated = (input: { name: string; args: readonly Expr[]; value: (e: Expr) => unknown }): unknown => {
  const operand = input.value(input.args[0]);
  return { [input.name]: Array.isArray(operand) ? { $let: { vars: {}, in: operand } } : operand };
};

/**
 * The rendering that every SINGLE-operand operator shares: `{ $op: <operand> }`,
 * with the operand as the developer wrote it. This is HR2. `$size([$.a])` is the
 * operand list of the developer, and it round-trips as `{ $size: ["$a"] }`, which
 * the server reads as one operand. This function adds no wrap. A JavaScript
 * lowering that hands an ARRAY LITERAL to such an operator (`[$.a, 2].length`)
 * adds the wrap itself, because there the array is the value and not a list. See
 * the `length` row.
 */
export const single = (input: { name: string; args: readonly Expr[]; value: (e: Expr) => unknown }): unknown => ({
  [input.name]: input.value(input.args[0]),
});

/**
 * The rendering that every OBJECT-SHAPED operator shares.
 *
 * One argument is the object-literal call, and it passes straight through. Two or
 * more arguments make a POSITIONAL call. The emitter zips them onto the key order
 * that the entry states in `shape.positional`, and `keys` hands that order back.
 * So each row writes the order once, and not twice:
 *   $dateTrunc({ date: $.t, unit: "day" })  → { $dateTrunc: { date: "$t", unit: "day" } }
 *   $dateTrunc($.t, "day")                  → the same document
 *   $trim($.name)                           → { $trim: { input: "$name" } }
 * One argument is the body only when it IS an object literal. A lone value is the
 * first positional argument. An emitter that reads `args[0]` alone drops "day".
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
