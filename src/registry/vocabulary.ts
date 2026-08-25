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
 */
export type ArgShape =
  | "none" //                             ObjectId()
  | "constant" //                         ObjectId("507f…"), new Date("2024-01-01")
  | "dynamic" //                          ObjectId($.id), new Date($.ms)
  | { objectWithKeys: readonly string[] }; // Array.from({ length: n })

/** The type a result has. Not the same set as `Family`. */
export type Kind = "string" | "array" | "number" | "object" | "date" | "bool" | "stream" | "objectId";

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

/** The result type. `.filter` on an array is an array; on a stream, a stream. */
export type Returns =
  | Kind
  | "same" //     whatever it attached to  (slice, clamp, filter)
  // An element of the receiver: `["a","b"].max()` is the string "b", not a number.
  // Used by at, nth, find, findLast, head, first, last, min, max, minBy, maxBy, sample.
  | "element"
  | "unknown"
  | Partial<Record<Family, Kind | "element" | "unknown">>;

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
  slotType?: Readonly<Record<number, ArgType>>;
  /**
   * Per-slot closed value set, checked only when the slot is a literal.
   *   $.d.plus(1, "day")   → accepted
   *   $.d.plus(30, "days") → refused, the plural is not a unit
   * Keyed by SLOT INDEX. `BodyRule.enums` is the same rule keyed by KEY NAME,
   * for an object-shaped body.
   */
  slotEnums?: Readonly<Record<number, readonly string[]>>;
  /**
   * Per-slot accepted SPELLINGS. Absent means a plain value expression only.
   *
   * Every higher-order name takes its iteratee in more than one form, and `sig`
   * alone ("iteratee") cannot say which:
   *   $.rows.uniqBy(r => r.id)         a lambda
   *   $.rows.uniqBy("id")              a property path
   *   $.rows.filter({ active: true })  a matcher object
   *   $.rows.filter(["a.b", 1])        a path/value pair
   *   $.items.map(String)              a bare callable, handed over unapplied
   *   $.rows.sumBy()                   omitted — identity
   */
  slotForms?: Readonly<Record<number, readonly SlotForm[]>>;
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
export type SlotForm =
  | "expression"
  | "lambda"
  | "propertyPath"
  | "matchesObject"
  | "matchesPropertyPair"
  | "bareCallable"
  | "omitted";

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

export type FilterIn = {
  /** This entry's own key. Lets a generated renderer emit `{ [name]: … }`
   *  without the name being written a second time inside the entry. */
  name: string;
  /** The receiver as a field path ("a.b.c"). Present only when it IS one. */
  path: string;
  args: readonly Expr[];
  /** This entry's `shape.positional` key order, empty when it has none. */
  keys: readonly string[];
  /** A callback body as a query document: `d => d.n > 1` → `{ n: { $gt: 1 } }`. */
  predicate: (cb: Expr) => QueryDoc | null;
  /** An argument's compile-time value, or null when it is not constant. */
  constant: (e: Expr) => unknown;
};

export type ExprIn = {
  /** This entry's own key. See FilterIn.name. */
  name: string;
  /** The receiver, ALREADY lowered. Absent for a namespace receiver. */
  recv: unknown;
  args: readonly Expr[];
  /** See FilterIn.keys. */
  keys: readonly string[];
  gen: (e: Expr) => unknown;
  /** A callback as `{ as, in }` with the parameter bound as `$$name`. */
  iteratee: (cb?: Expr) => { as: string; in: unknown };
  /** A collision-free MongoDB variable name. */
  fresh: (hint: string) => [string, string];
};

export type StageIn = {
  /** This entry's own key. See FilterIn.name. */
  name: string;
  args: readonly Expr[];
  /** A callback body as a query document against the stream's own fields. */
  predicate: (cb: Expr) => QueryDoc | null;
  /** A callback body as a document reshape, for $replaceWith / $set. */
  reshape: (cb: Expr) => unknown;
  gen: (e: Expr) => unknown;
  /** What the chain has already emitted — `sort().take(1)` reads this. */
  prevStages: readonly Stage[];
  fresh: (hint: string) => [string, string];
};

export type GroupIn = {
  name: string;
  args: readonly Expr[];
  /** See FilterIn.keys. */
  keys: readonly string[];
  gen: (e: Expr) => unknown;
};

export type SugarIn = {
  /** This entry's own key. See FilterIn.name. */
  name: string;
  captured: Readonly<Record<string, Expr>>;
  gen: (e: Expr) => unknown;
  lowerSub: (stmts: readonly Node[]) => Stage[];
  fresh: (hint: string) => [string, string];
};

// ═════════════════════════════════════════════════════════════════════════════
// 4. A RENDERER — three states, all three of them real
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Produce the MQL — or return null meaning "not expressible for THIS receiver,
 * use the fallback". `$.s.startsWith("A")` renders a query;
 * `$.s.trim().startsWith("A")` returns null and becomes an `$expr`.
 */
export type Emit<In, Out> = (input: In) => Out | null;

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

/** A refusal that carries the message the user should read instead. */
export type Refusal = { unsupported: string };

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

/** The families a given `on` covers. */
export type Of<O> = O extends readonly (infer F extends Family)[] ? F : O extends Family ? O : Family;

export type Rule<In, Out> = {
  args: Arity;
  /**
   * Stages this renderer must place BEFORE the stage it lands in, for a value
   * that cannot be computed inline. `$$.length` materialises a
   * `$setWindowFields` count into a scratch field, and `emit` then returns a
   * reference to that field rather than an expression.
   */
  hoists?: (input: In) => Stage[];
  emit: Emit<In, Out>;
};

/**
 * A renderer. Either one rule for every family, or one rule PER family —
 * because the argument count can differ by receiver as well as by position:
 * `Math.max(a, b)` takes arguments, `$.rows.max()` takes none, and both are the
 * `max` entry. Every family `on` lists must appear, with a rule or with a
 * refusal that says why; no family `on` omits may appear. `uncertain` answers a
 * receiver whose family is not provable; leave it out and a runtime `$cond`
 * dispatch is derived from the rules, so it cannot drift from them.
 */
export type Emitter<F extends Family, In, Out> =
  | Rule<In, Out>
  /**
   * A family may be `Pending` here, not only a rule or a refusal. `Object.keys`
   * works and `$.arr.keys()` is refused, and the working half still lives in
   * src/codegen.ts — without `Pending` the row had to invent an emitter for it.
   */
  | { perFamily: Record<F, Rule<In, Out> | Refusal | Pending>; uncertain?: Emit<In, Out> }
  /**
   * Dispatch on the ARGUMENT SHAPE — the third axis, alongside position
   * (`where`) and receiver (`on`). `ObjectId()` mints one, `ObjectId("<hex>")`
   * is a live BSON value, `ObjectId($.id)` is `$toObjectId`: same name, same
   * receiver, same position, three different MQL. Ordered — the first matching
   * row wins — so precedence between `constant` and `dynamic` is visible.
   */
  | { byArgs: readonly ({ when: ArgShape } & Rule<In, Out>)[] };

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
> = Listed extends true ? Emitter<F, In, Out> | Pending : NonEmitter<F, C>;

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
 * A MongoDB operator, written as one line.
 *
 * What it generates is the MQL SHAPE, which for an operator is `{ $name: … }`
 * by definition of `shape` — the same three lines for 75 of the 182, with only
 * the name changing, and the name is already the key. What it does NOT generate
 * is `where`: applicability stays written on every entry, because that is the
 * fact a reader needs and the one a generator must never guess.
 */
/**
 * What `op` returns: the six cells plus the facts it was given. names.ts feeds
 * this straight into `mongo({...})`. Kept structural rather than importing
 * `MongoEntry`, so vocabulary.ts stays a leaf that imports nothing.
 */
export type MongoOpParts<W extends readonly Position[]> = {
  kind: "mongo";
  shape: "single" | "array" | "none" | "flex" | { object: BodyRule };
  category?: OperatorCategory;
  doc: string;
  where: W;
  only?: readonly Only[];
  /**
   * The lowest server version that accepts this name. Stated only where it was
   * MEASURED to matter — the binary may hold a name the running FCV refuses:
   *   {$addFields:{v:{$sigmoid:"$a"}}}
   *     → "not allowed in the current feature compatibility version"
   * Absent means every version jsmql targets accepts it.
   */
  minVersion?: string;
  filter: Emitter<Family, FilterIn, QueryDoc> | NonEmitter<Family> | Pending;
  expr: Emitter<Family, ExprIn, unknown> | NonEmitter<Family> | Pending;
  group: Emitter<Family, GroupIn, unknown> | NonEmitter<Family> | Pending;
  window: Emitter<Family, GroupIn, unknown> | NonEmitter<Family> | Pending;
  stream: Emitter<Family, StageIn, Stage[]> | NonEmitter<Family> | Pending;
  statement: Emitter<Family, StageIn, Stage[]> | NonEmitter<Family> | Pending;
  updateDoc: Emitter<Family, GroupIn, unknown> | NonEmitter<Family> | Pending;
};

export const op = <const W extends readonly Position[]>(e: {
  where: W;
  shape: "single" | "array" | "none" | "flex" | { object: BodyRule };
  category: OperatorCategory;
  doc: string;
  only?: readonly Only[];
  /** Stated only where the vendored spec constrains the operands. */
  args?: Arity;
  /** See `MongoOpParts.minVersion`. */
  minVersion?: string;
}): MongoOpParts<W> => {
  const arity: Arity = e.args ?? { sig: "operands", atLeast: 0 };
  const body = typeof e.shape === "object" ? e.shape.object : null;
  const shaped = (input: { name: string; args: readonly Expr[]; gen: (x: Expr) => unknown }): unknown => {
    const vals = input.args.map(input.gen);
    if (e.shape === "none") return { [input.name]: {} };
    if (e.shape === "single") return { [input.name]: vals[0] };
    // An object-shaped operator called POSITIONALLY: zip the operands onto the
    // key order the row states. One argument is the object-literal call and
    // passes straight through. See `BodyRule.positional`.
    if (body !== null) {
      if (vals.length <= 1 || body.positional === undefined) return { [input.name]: vals[0] };
      const keys = body.positional;
      return { [input.name]: Object.fromEntries(vals.map((v, i) => [keys[i], v])) };
    }
    return { [input.name]: vals.length === 1 && e.shape === "flex" ? vals[0] : vals };
  };
  /**
   * A $group output slot takes exactly ONE argument, whatever the operator's
   * expression form allows. Measured on mongod:
   *   {$group:{v:{$avg:"$a"}}}        → accepted
   *   {$group:{v:{$avg:["$a","$b"]}}} → "The $avg accumulator is a unary operator"
   * A window slot is variadic-tolerant, so it keeps `arity` unchanged.
   */
  const groupArity: Arity = { sig: "operand", exact: 1 };
  /**
   * A stage takes one body. The SAME rendering serves both stage positions —
   * `$$ = $$.$match(...)` as a chain link and `$match(...);` as a statement —
   * so the two cells share one emitter and differ only in whether `where`
   * lists them.
   */
  const stageArity: Arity = { sig: "body", exact: 1 };
  const asStage = (i: StageIn): Stage[] => [{ [i.name]: i.gen(i.args[0]) }];
  const listed = (pos: Position) => (e.where as readonly Position[]).includes(pos);
  const why = `'${"$"}<op>' is not valid here — see its 'where'.`;
  return {
    kind: "mongo",
    shape: e.shape,
    category: e.category,
    doc: e.doc,
    where: e.where,
    ...(e.only === undefined ? {} : { only: e.only }),
    ...(e.minVersion === undefined ? {} : { minVersion: e.minVersion }),
    filter: listed("filter") ? { args: arity, emit: shaped } : unsupported(why),
    expr: listed("value") ? { args: arity, emit: shaped } : unsupported(why),
    group: listed("group") ? { args: groupArity, emit: shaped } : unsupported(why),
    window: listed("window") ? { args: arity, emit: shaped } : unsupported(why),
    stream: listed("stream") ? { args: stageArity, emit: asStage } : unsupported(why),
    statement: listed("statement") ? { args: stageArity, emit: asStage } : unsupported(why),
    updateDoc: listed("updateDoc") ? { args: arity, emit: shaped } : unsupported(why),
  } as MongoOpParts<W>;
};

/**
 * The rendering every OBJECT-SHAPED operator shares.
 *
 * One argument is the object-literal call and passes straight through. Two or
 * more is a POSITIONAL call, zipped onto the key order the entry already states
 * in `shape.positional` and handed back through `keys` — so the order is written
 * once per row, not twice:
 *   $dateTrunc({ date: $.t, unit: "day" })  → { $dateTrunc: { date: "$t", unit: "day" } }
 *   $dateTrunc($.t, "day")                  → the same document
 * The previous per-row emitter read `args[0]` alone and dropped "day".
 */
export const objectBody = (input: {
  name: string;
  args: readonly Expr[];
  keys: readonly string[];
  gen: (e: Expr) => unknown;
}): unknown => {
  const { name, args, keys, gen } = input;
  if (args.length <= 1 || keys.length === 0) return { [name]: gen(args[0]) };
  return { [name]: Object.fromEntries(args.map((a, i) => [keys[i], gen(a)])) };
};

export type Operand = { path: string } | { lowered: unknown };

/** A range test. Knows its own query spelling and its own expression spelling. */
export const Range = (operand: Operand, lo: unknown, hi: unknown, ends: "both" | "startOnly") => ({
  query: (): QueryDoc | null =>
    "path" in operand ? { [operand.path]: { $gte: lo, [ends === "both" ? "$lte" : "$lt"]: hi } } : null,
  expr: (): unknown => {
    const v = "lowered" in operand ? operand.lowered : null;
    return { $and: [{ $gte: [v, lo] }, { [ends === "both" ? "$lte" : "$lt"]: [v, hi] }] };
  },
});

/** An anchored substring test — an indexable regex as a query, $indexOfCP as an expression. */
export const Anchored = (operand: Operand, needle: string, at: "start" | "end") => ({
  query: (): QueryDoc | null => {
    if (!("path" in operand)) return null;
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, (m) => "\\" + m);
    return { [operand.path]: new RegExp(at === "start" ? `^${esc}` : `${esc}$`) };
  },
  expr: (): unknown => ({ $eq: [{ $indexOfCP: ["lowered" in operand ? operand.lowered : null, needle] }, 0] }),
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. THE ENTRIES
// ═════════════════════════════════════════════════════════════════════════════
