# jsmql

**Write MongoDB aggregation queries in JavaScript.** A strict JS subset that compiles to MQL JSON — like SQL but for MongoDB, using the syntax you already know.

```js
import { jsmql } from "@koresar/jsmql";

// Filter — for db.coll.find(filter). No `;` at top level.
const age = 18;
let filter = jsmql`$.age > ${age} && $.status === "active"`
// → { age: { $gt: 18 }, status: "active" }
//   ← the plain, index-friendly query doc every MongoDB developer reads and writes

// Pipeline — for db.coll.aggregate(pipeline). Any `;` flips to stage mode.
// Narrow to one user, assert it's the only match, then pivot to their 5 newest orders.
let pipeline = jsmql`
  $$.filter({ email: "me@example.com" });
  assert($$.length === 1, "More than one user with such email found");
  $$ = $$$.orders
    .filter({ userId: $._id })
    .toSorted({ placedAt: -1 })
    .take(5);
`;
// → [
//   { $match: { email: "me@example.com" } },
//   { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
//   { $match: { $expr: { $convert: { input: true, to: { $cond: [
//       { $eq: ["$__jsmql.length", 1] }, "bool",
//       "jsmql assertion failed: More than one user with such email found" ] } } } } },
//   { $lookup: { from: "orders", localField: "_id", foreignField: "userId",
//       pipeline: [{ $sort: { placedAt: -1 } }, { $limit: 5 }], as: "__jsmql.tmp.0" } },
//   { $unwind: "$__jsmql.tmp.0" },
//   { $replaceWith: "$__jsmql.tmp.0" },
// ]

// Raw expression — for inside a stage body.
let expr = jsmql.expr(({ $ }) => $.items.map((i) => i.price * i.qty).reduce((a, x) => a + x, 0))
// → { $reduce: { input: { $map: { input: "$items", as: "i",
//     in: { $multiply: ["$$i.price", "$$i.qty"] } } },
//   initialValue: 0, in: { $add: ["$$value", "$$this"] } } }
```

**MongoDB 8.0 deprecated server-side JavaScript via `$function`, `$accumulator`, and `$where`.** JSMQL is the replacement: native MQL, index-friendly, IDE-aware, testable as plain JS.

## Install

```sh
npm install @koresar/jsmql bson
```

ESM + CJS, runs in browsers. Works with **Node 16.20.1+**, Deno, and Bun.

`bson` is a **peer** dependency (`^6.10.0 || ^7.0.0`), and npm installs it for you. It is the
package the MongoDB driver and mongoose already carry, so jsmql shares their copy: every BSON
value jsmql emits is built by your own `bson`, carries its version, and hands to any other
module unchanged. jsmql also re-exports the nine types it can spell (`import { ObjectId } from
"@koresar/jsmql"`), so you can reach the same copy without a second import.

## Tour

```js
import "@koresar/jsmql/globals";          // ambient globals — autocomplete for every MQL op, stage, pipeline chain & value method
import { jsmql } from "@koresar/jsmql";

// Arrow form — your prettier/oxfmt handles formatting.
// No `;` at top level → query Filter (the doc db.coll.find(filter) takes).
jsmql(({ $ }) => $.email.trim().toLowerCase().endsWith("@flash-payments.com"))
// → { $expr: { $let: { vars: { jsmqlStr: { $ifNull: [{ $toLower: { $trim: { input: "$email" } } }, ""] } },
//                in: { $eq: [{ $substrCP: ["$$jsmqlStr", { $max: [0, { $subtract: [{ $strLenCP: "$$jsmqlStr" }, 19] }] }, 19] }, "@flash-payments.com"] } } } }

// Pipelines — any `;` flips to stage mode (the array db.coll.aggregate(pipeline) takes).
jsmql(({ $ }) => {
  $match($.age >= 18 && $.region === "AU");      // → query doc, indexes still work
  $group({ _id: $.shopId, total: { $sum: $.amount } });
  $sort({ total: -1 });
});
// → [{ $match: { age: { $gte: 18 }, region: "AU" } },
//    { $group: { _id: "$shopId", total: { $sum: "$amount" } } }, { $sort: { total: -1 } }]

// Use `?.` where a field might be null — you get `$ifNull` guards exactly there:
jsmql('[...$.mods, ...$.room?.mods, "root"].includes($.userId)')
// → { $expr: { $in: ["$userId", { $concatArrays: ["$mods", { $ifNull: ["$room.mods", []] }, ["root"]] }] } }

// `new Date(...)` with literal args folds to a real JS Date — index-friendly query doc:
jsmql(`$.method === "postalDelivery" && $.createdAt >= new Date("2026-01-01")`)
// → { method: "postalDelivery", createdAt: { $gte: <Date 2026-01-01> } }
// `new Date()` and `new Date($.field)` still need server-time evaluation and ride in $expr.

// `ObjectId("…")` / `new ObjectId("…")` mints a live BSON ObjectId — query by _id the obvious way:
jsmql(`$._id === ObjectId("507f1f77bcf86cd799439011")`)
// → { _id: <ObjectId 507f1f77bcf86cd799439011> }

// Template-tag — interpolate runtime literals from outer scope
const ids = [1, 2, 3];
jsmql`$.status === "open" && $.id in ${ids}`
// → { status: "open", id: { $in: [1, 2, 3] } }

// jsmql.compile — parse once, bind many. Output stays index-friendly.
const eligible = jsmql.compile(({ minAge, region }, { $ }) => {
  $match($.age >= minAge && $.region === region);
  $project({ age: 1, email: 1, address: 1 });
});
eligible({ minAge: 21, region: "AU" });
// → [{ $match: { age: { $gte: 21 }, region: "AU" } },
//    { $project: { age: 1, email: 1, address: 1 } }]

// JS-natural `=`, `+=`, `delete` compile to `$set` / `$unset` stages
jsmql(({ $ }) => {
  $.score += 1;
  delete $.tempToken;
  $.status = "done";
});
// → [{ $set: { score: { $add: ["$score", 1] } } }, { $unset: "tempToken" }, { $set: { status: "done" } }]

// Assigning to bare `$` replaces the whole document — lowers to $replaceWith
jsmql(`$match($.profile != null); $ = $.profile; $ = { ...$, score: $.points * 1.1 }`);
// → [
//     { $match: { profile: { $ne: null } } },
//     { $replaceWith: "$profile" },
//     { $replaceWith: { $mergeObjects: ["$$ROOT", { score: { $multiply: ["$points", 1.1] } }] } }
//   ]

// Multi-facet aggregation — every value a `$$` chain lowers to one $facet stage
jsmql(`$ = {
  topByScore: $$.toSorted({ score: -1 }).take(10),
  recent:     $$.filter(o => o.createdAt >= new Date("2026-01-01")),
  byStatus:   $$.$group({ _id: $.status, n: $sum(1) })
}`);
// → [{ $facet: {
//       topByScore: [{ $sort: { score: -1 } }, { $limit: 10 }],
//       recent:     [{ $match: { createdAt: { $gte: new Date("2026-01-01T00:00:00.000Z") } } }],
//       byStatus:   [{ $group: { _id: "$status", n: { $sum: 1 } } }]
//   } }]

// Top 10 users by revenue: $group the orders, then sort descending and take the first 10.
// The `$$.toSorted(...).take(...)` chain lowers to $sort + $limit.
jsmql(`
$group({ _id: $.userId, revenue: $sum($.total), orders: $sum(1) });
$$.toSorted({ revenue: -1 }).take(10);
`);
// → [
//     { $group: { _id: "$userId", revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
//     { $sort: { revenue: -1 } },
//     { $limit: 10 }
// ]

// A write compiles to the PIPELINE form of an update — the form that can compute from the document.
db.users.updateMany({}, jsmql(({ $ }) => $.name = $.name.toUpperCase()))
// → [{ $set: { name: { $toUpper: "$name" } } }]

// `jsmql.update()` is the update DOCUMENT — constants only, every write its own operator.
db.users.updateMany({}, jsmql.update(({ $ }) => { $.score += 1; $.tags.push("seen"); delete $.tmp; }))
// → { $inc: { score: 1 }, $push: { tags: "seen" }, $unset: { tmp: "" } }
// A value computed from the document ("$.name.toUpperCase()") is refused there, naming the pipeline form:
// in a document-form update the server would store the literal object, not the result.

// Strict-shape entry points — throw if the input would produce the wrong shape.
// Use these when the call site demands a specific shape and a silent
// mis-dispatch would be a footgun.
db.users.find(jsmql.filter("$.age > 18"));            // throws on Pipeline-shaped input
db.users.aggregate(jsmql.pipeline("$match($.age > 18); $sort({ age: 1 })")); // throws on bare expressions
db.users.updateOne({ _id: 1 }, jsmql.update("$.score += 1"));   // throws on a value read from the document

// Raw expression — for embedding inside a hand-written stage body
const stage = { $addFields: { discount: jsmql.expr(({ $ }) => $.price * (1 - $.loyalty.multiplier)) } }
// → { $addFields: { discount: { $multiply: ["$price", { $subtract: [1, "$loyalty.multiplier"] }] } } }

// Escape hatch — call any MongoDB operator as a function - $dateTrunc in this case
jsmql(({ $ }) => { $set({ createdAtWeek: $dateTrunc({ date: $.createdAt, unit: "week" }) }); })
// → [{ $set: { createdAtWeek: { $dateTrunc: { date: "$createdAt", unit: "week" } } } }]

jsmql(({ $ }) => $.age = 18); // a pipeline — the form updateOne(), updateMany() take when the value may be computed
// → [{ $set: { age: 18 } }]
jsmql.update(({ $ }) => $.age = 18); // the update document — constants only
// → { $set: { age: 18 } }

// Validate without throwing — every error carries { message, pos, code }
jsmql.validate(({ $ }) => $.age > 18)
// → { valid: true, errors: [] }
```

The **[live playground](https://jsmql.js.org/playground.html)** is the best place to see dozens of other JSMQL examples.

## Why the arrow form

The arrow function is **never executed** — jsmql() calls `Function.prototype.toString()` on it, strips the parameter list, and parses the body. That single trick gives you:

- **Formatting for free.** Prettier, oxfmt, and every other JS formatter indent and line-break your query like any other JavaScript. No JSMQL plugin, no custom config.
- **Linting for free.** ESLint, Biome, and your editor's TypeScript service see real JS — they flag typos, unused identifiers, and shape mismatches at write time.
- **Code completion.** With `import "@koresar/jsmql/globals"`, your IDE autocompletes every stage and operator name, suggests the argument keys from the official MongoDB MQL spec, and surfaces the operator's description on hover. It also declares the `$$` / `$$$` / `$$$$` context-ref prefixes — so arrow-form code using them type-checks, with full completion and annotated option objects for the diagnostic source stages (`$$.collStats({…})`, `$$$$.currentOp({…})`, …). The value methods (`.uniq()`, `.chunk()`, `.groupBy()`, `.capitalize()`, `.clamp()`, `.startOf()`, …) complete and chain on any concretely-typed value — an annotated document, a typed static like `Object.values(o)`, or a known-return method result mid-chain. That covers `Date`: JSMQL's date vocabulary (`.plus()`, `.diff()`, `.format()`, `.set()`, …) has no counterpart in JavaScript's own `Date`, so the import is what stops TypeScript underlining code jsmql compiles.
- **AI coding works out of the box.** Copilot, Cursor, and Claude already know JavaScript — they autocomplete JSMQL idiomatically because JSMQL *is* JavaScript. There is no new vocabulary for them to learn.
- **Pre-compilation.** jsmql.compile() parses once, executes many times.

## Highlights

- **JS you already know** — operators, ternaries, template literals, optional chaining, spread, computed keys, numeric separators, trailing commas, `Math.*`, `Date`, `typeof`, comments, the `function` keyword, multi-declarator declarations (`const a = …, b = …;` — `b` reads the `a` beside it, and the `,` shares one `$set`/`$let` the way `$.a = …, $.b = …` does, broken only where a declarator reads a sibling), and block-body arrows with local `const`s (`x => { const y = …; return … }` → nested `$let`). Everything JSMQL accepts is valid JavaScript — paste any expression into a `.js` file and `node --check` passes.
- **Real BSON values, from your own `bson`** — write `ObjectId("507f…")`, `Decimal128("9.99")`, `Long("9007199254740993")`, `Int32(3)`, `Double(1)`, `UUID("…")`, `MinKey()` or `MaxKey()` and jsmql emits a live instance of the class your driver already carries, so it passes `instanceof` in your code. `X(…)` and `new X(…)` both work, mongosh's names (`NumberDecimal`, `NumberLong`, `NumberInt`, `ISODate`) mean the same thing, and a runtime value converts on the server instead (`Decimal128($.s)` → `$toDecimal`). Arithmetic on a decimal is never folded in JavaScript — `Decimal128("0.1") + Decimal128("0.2")` goes to the server, which answers an exact `0.3`. And where `bson` would silently wrap (`new Int32(5000000000)` is `705032704` there), jsmql refuses at the source position and names the type that fits. See [docs/LANGUAGE.md → The other BSON types](docs/LANGUAGE.md#the-other-bson-types).
- **Compile-time constants** — a `const`/`let` whose right-hand side is a constant (`const userId = 0x507f…`, `const msInDay = 24 * 60 * 60 * 1000`, `new Date("2020-01-01")` and its arithmetic — `start.plus(1, "month")` is a literal date, computed as `$dateAdd` computes it — a literal array/object) is evaluated once at compile time and inlined at every use — no `$set`, no cleanup stage. Because the declaration emits nothing, a constant plus a predicate compiles to a clean, indexable **Filter** (`const userId = 0x507f…; $.userId === userId` → `{ userId: new ObjectId("507f…") }`). A binding that reads the document or the clock keeps the runtime `$set` form. See [docs/LANGUAGE.md → Compile-time constants](docs/LANGUAGE.md#compile-time-constants-folding).
- **Reusable functions** — name a function once and call it across fields, in either spelling: `function money(n) { return Math.round(n * 100) / 100 } $ = { subtotal: money(...), tax: money(...) }` (or the arrow `const money = (n) => …`). The `function` keyword works everywhere arrows do — declarations, inline callbacks, and the `jsmql(fn)` input. Each call expands inline as its own `$let` (a named IIFE); the declaration stores nothing in the document and an uncalled one adds nothing to the output. Bodies can close over `$.fields` and compose with each other. See [docs/LANGUAGE.md → Reusable functions](docs/LANGUAGE.md#reusable-functions).
- **Dates the way your date library spells them** — `.plus` / `.minus` / `.diff` / `.startOf` / `.endOf` / `.format` / `.set` / `.isSame` / `.isBefore` / `.isAfter`, plus the parts JavaScript's `Date` can't report (`.week`, `.isoWeek`, `.isoWeekday`, `.dayOfYear`, `.quarter`). `$group({ _id: $.createdAt.startOf("month"), revenue: $sum($.total) })` is the whole time-series rollup. The names come from Moment / Luxon / Temporal; the *semantics* stay MongoDB's, so `.diff` counts calendar boundaries and `.format` takes `%Y-%m-%d` — a Moment token string like `"YYYY-MM-DD"` is refused at compile time with the translation, because MQL would silently render it as its own literal text. Every method takes one trailing `timezone` (or an options object) argument. See [docs/LANGUAGE.md → Date operations](docs/LANGUAGE.md#date-operations).
- **Every operator in the spec** — every aggregation expression, accumulator and query operator of the official MongoDB MQL spec, each stated in one registry row (`src/registry/names.ts`). Unknown operators pass through, so new MongoDB releases work day one.
- **Plain MQL passes through.** Drop hand-written MQL JSON inline — `{ $gt: ["$age", 18] }`, a whole stage, a whole pipeline — and jsmql compiles it to itself. Mix the two freely, migrate one expression at a time, or paste verbatim from the MongoDB docs.
- **Filter vs Pipeline picked automatically** — a top-level stage call / update op / statement, or any `;`-separated input, lowers as a `Pipeline`; everything else lowers as a `Filter`, with index-safe predicates translated to query-document form. See [docs/LANGUAGE.md → Output dispatch](docs/LANGUAGE.md#output-dispatch-filter-vs-pipeline).
- **Joins as JS** — `$$$.<coll>.find(pred)` / `.filter(pred)` lower to `$lookup`; `.find()` returns one doc or null, `.filter()` keeps the array. **Any lodash stream method may *start* the chain**, not only `.find`/`.filter` — `$$$.orders.toSorted({ createdAt: -1 }).take(200).filter(o => o.productIds.includes($._id))` lowers the whole chain, in source order, into one `$lookup.pipeline` (`[$sort, $limit, $match]` — sort/limit *before* the filter, which filter-first can't express), and a correlating `.filter`/`.reject` may sit anywhere. For an arbitrary sub-pipeline (grouping, top-N, reshaping) reach for `.aggregate((o) => { $group(...); $sort(...); })` (named after the driver's own `db.coll.aggregate`), which is a chain link like any other — `$$$.orders.sort({ createdAt: -1 }).take(1000).aggregate((o) => { $group({ _id: o.region, revenue: $sum(o.total) }); }).sort({ revenue: -1 }).take(3)` bounds the scan, groups, and ranks the groups in one `$lookup.pipeline`, with no intermediate array. Chained reads (`.length`, `.reduce`, member access) and `.aggregate` sub-pipelines compose inline — a `{ … }` callback on a JavaScript method (`.find` / `.filter` / `.map`) stays JavaScript, so pipeline stages live in `.aggregate` alone, with a reshape written as its parameter-replace `o = <expr>`. Nest them to any depth: a deep callback can read the root doc (`$.x`), an enclosing match (`o.x`), and an ancestor sub-stream count (`outerColl.length`) all at once, each correctly correlated. A join read inline runs as a `$lookup` placed directly ahead of the stage that reads it, so a callback's parameter always names the document that stage sees — `$$.$sortByCount($.tag).map(g => $$$.orders.filter(o => o.tag === g._id).length)` joins on the group key, not on the source document. A join whose predicate reads a `.map`/`.filter`/`.reduce` *element* is a compile-time error instead: a stage can't run once per array element, and the message names the two spellings that can. So is a join in the body of a stage the server requires FIRST (`$geoNear`, `$documents`, `$search`, …) or LAST (`$merge`'s `let`), where the `$lookup` would have nowhere legal to stand — each names the later- or earlier-statement rewrite that does. Reads are same-database only — a cross-database read (`$$$$.<db>.<coll>.find/filter`) is a compile-time error pointing you at the same-db `$$$.<coll>` form. See [docs/LANGUAGE.md → Cross-collection lookups](docs/LANGUAGE.md#cross-collection-lookups-collfind--filter).
- **Collection unions as `Array.push`** — `$$.push({...}, ...$$$.<coll>.filter(pred))` lowers to `$unionWith`, with a JS-faithful spread rule (arrays spread, scalars don't). See [docs/LANGUAGE.md → Collection union](docs/LANGUAGE.md#collection-union-push).
- **Replace root as JS assignment** — `$ = <expr>` lowers to `$replaceWith`: lift a sub-document (`$ = $.profile`), merge fresh fields (`$ = { ...$, score: ... }`), or pivot to a joined doc. An array on the right is refused, and the message names the destination that takes one — the fan-out belongs to the stream. A scalar is refused the same way, with the wrap named. See [docs/LANGUAGE.md → Replace root via `$ = <expr>`](docs/LANGUAGE.md#replace-root-via---expr).
- **Writing a collection** — `$$$.<coll> = $$` (and `$$$$.<db>.<coll> = $$`) REPLACE it, a `$out`; `$$$.<coll> += $$` ADDS to it, a `$merge`, as do `.concat(…)` and `.push(…)`, which take an array of documents as well as the stream. The LHS names the destination, the RHS the optionally-filtered source, and must-be-last is enforced at compile time. See [docs/LANGUAGE.md → `$out`](docs/LANGUAGE.md#out-write-the-pipeline-to-a-collection).
- **Diagnostics scoped by prefix** — system source stages are method calls on the context ref whose scope they need: `$$.indexStats()` / … on the collection, `$$$$.currentOp({…})` / … on the deployment. Wrong scope is a compile-time error naming the right prefix. See [docs/LANGUAGE.md → System / diagnostic stages](docs/LANGUAGE.md#system--diagnostic-stages-indexstats-currentop-).
- **`$facet` as a named object of branches** — when every value of `$ = { … }` is a `$$` chain (a `$$.filter(<predicate>)`, chained stage calls, or a mix), the surface lowers to one `$facet` stage with each entry a named sub-pipeline. See [docs/LANGUAGE.md → $facet via `$ = { key: <$$ chain>, … }`](docs/LANGUAGE.md#facet-via----key--chain--).
- **Replace stream as JS assignment** — `$$ = <expr>` reshapes the whole stream the way `$ = <expr>` reshapes one doc: narrow (`→ $match`), switch source, pivot onto a correlated collection, or **fan out** — `$$ = <array>` makes the stream from the array's elements, one document per element (via `$unwind`), so a possibly-empty array (`$.items.filter(…)`) conditionally drops documents. jsmql picks the lowering from the shape. See [docs/LANGUAGE.md → Replace stream](docs/LANGUAGE.md#replace-stream-via---expr).
- **Pipeline stages chain too** — any aggregation stage can be a chain link on a stream: `$$.$match({ status: "shipped" }).$sort({ total: -1 }).$limit(5)` is the same pipeline as writing those three as `;`-separated statements. It interleaves with the JS chain methods (`$$.filter(p => p.score > 0).$sort({ score: -1 }).take(10)`), and it's the only way to reach the stages with **no JavaScript spelling** — `$group`, `$unwind`, `$setWindowFields`, `$bucket`, … — from a value position: `const byRegion = $$$.orders.$match({…}).$group({ _id: "$region", revenue: $sum("$total") }).$sort({ revenue: -1 }).$limit(5).map(g => …)` builds the whole `$lookup.pipeline` inline. Only real MongoDB stages are accepted; a stage after a value-producing link (`.sum().$limit(5)`) is a compile-time error. See [docs/LANGUAGE.md → Chained form](docs/LANGUAGE.md#chained-form-stage-on-a-stream).
- **Stream methods chain on the RHS** — after the `$$` / `$$$.<coll>` receiver (optionally `.filter(p)`), chain JS-array and lodash-style methods — `.map` / `.filter` / `.flatMap` / `.slice` / `.concat` plus a lodash vocabulary (`.sort`, `.take`, `.drop`, `.groupBy`, `.countBy`, `.uniqBy`, `.sample`, `.sampleSize`, … the rows with a stream cell in `src/registry/names.ts` are the live list) — and each appends stages. Lodash iteratee shorthands work too: `.map("userId")`, `.filter({ status: "CLOSED" })`, `.groupBy({ _id: "$dept", n: $sum(1) })`, and a key-less `.countBy()` counts the elements themselves. After `.flatMap("items")` every callback receives the item, as in JavaScript (`.filter(i => i.qty > 1)` is `{ "items.qty": { $gt: 1 } }`). A callback may destructure its parameter: `.sortBy(([id, count]) => -count)`. For a bare `$$` receiver the `$$ =` head is optional. See [docs/LANGUAGE.md → Stream methods](docs/LANGUAGE.md#stream-methods-chained-after-the-rhs).
- **JS mutators mutate at statement position** — `$.events.sort(e => e.t)`, `.push(x)`, `.reverse()`, `.splice(...)`, … desugar to a `$set` that reassigns the field; the `.toSorted` / `.toReversed` / `.with` family stays immutable. `Object.assign(target, ...sources)` is the object equivalent — at statement position it merges into its target (a `$.field` or an in-scope `let`/`const` binding, even a `const`), mirroring JS's mutating `Object.assign`. Mutators in expression position throw with the fix called out. See [docs/LANGUAGE.md → Mutators](docs/LANGUAGE.md#mutators-at-statement-position-they-mutate-the-field).
- **Conditional errors via `assert`** — `assert(condition[, message])` is a pipeline guard clause: when the condition fails the whole operation aborts with a server error carrying your message (`Unknown type name: jsmql assertion failed: …`). It lowers to a portable `$match`+`$convert` shape — no deprecated server-side JS (`$function`), so it works under the Stable API and on every Atlas tier. Statement-only; expression-position uses throw with a hint. See [docs/LANGUAGE.md → `assert`](docs/LANGUAGE.md#assert-fail-the-pipeline-when-an-invariant-breaks).
- **Stream count as `$$.length`** — `$$.length` is the current stream's document count, usable as a value anywhere (`$.n = $$.length`, `assert($$.length <= 1, …)`, arithmetic). It materialises a `$setWindowFields` `$count` once, reuses it, and recomputes after a count-changing stage (`$match`/`$group`/`$unwind`/…). Pipeline-only. See [docs/LANGUAGE.md → `$$.length`](docs/LANGUAGE.md#length-count-the-current-stream).
- **Three call shapes** — arrow `jsmql(({ $ }) => …)`, string `jsmql("…")`, and template tag `` jsmql`…${val}…` `` for embedding outer-scope values.
- **Polymorphic by default, strict on demand** — `jsmql()` picks Filter or Pipeline from the input; `jsmql.filter()` and `jsmql.pipeline()` lock it to one shape and throw an actionable error otherwise, and `jsmql.update()` is the update DOCUMENT (`{ $set, $inc, $push, … }`, constants only) that `updateOne(filter, update)` takes. `jsmql.compile(fn)` parses once for parameterised parse-once-bind-many — and each strict entry has a shape-locked `.compile` (`jsmql.filter.compile`, `jsmql.pipeline.compile`, `jsmql.update.compile`). `jsmql.expr()` returns the raw aggregation expression that drops into a stage body. The three call shapes (string / arrow / template tag) apply to all of them.
- **The MQL prints as JavaScript** — `jsmql.stringify(document)` writes what the compiler produced as the source that rebuilds it, which is what the CLI, the playground and the landing page all show. A `Date`, an `ObjectId`, a `Decimal128`, a `Binary`, a regular expression: each is the `new X(…)` call the Node driver requires, and mongosh takes the same text. `JSON.stringify` writes a date as a string the server then compares as a string, and a regular expression as `{}` — the query still runs and matches nothing. See [docs/LANGUAGE.md → Printing MQL](docs/LANGUAGE.md#printing-mql-jsmqlstringify).
- **lodash value methods** — the aggregation-shaped ops native JS lacks a spelling for, as per-doc field methods, covering the lodash Array + Collection vocabulary that maps cleanly to MQL: `$.items.groupBy("type")`, `$.items.take(3)` / `.drop(3)` / `.chunk(3)`, `$.a.without(0)` / `.xor($.b)` / `.differenceBy($.b, "id")`, `$.a.sortBy("age")` / `.orderBy(["age"], ["desc"])`, `$.a.zip($.b)`, `$.a.takeWhile(x => x > 0)`, `$.a.sample()`, `$.nums.sum()`, `$.user.pick(["name", "age"])`, `$.o.mapValues(v => v * 2)`, `$.n.clamp(0, 100)`, `$.name.capitalize()`, … (iteratee-taking ones accept a `"field"` string or an arrow). String methods are ASCII-only. See [docs/LANGUAGE.md](docs/LANGUAGE.md).
- **`@koresar/jsmql/globals`** — a pure-types side-effect import that adds the ambient `$match` / `$dateAdd` / … globals, types the `$$` / `$$$` pipeline chains, and augments `Array` / `String` / `Number` / `Date` with JSMQL's value methods. Zero runtime cost; bundlers tree-shake it to nothing.
- **Pre-flight validation** — jsmql rejects the pipeline mistakes the MongoDB server would otherwise reject, at compile time: stage placement (`$out`/`$merge` must be last, `$collStats`/`$geoNear`/`$changeStream` and friends must be first, stages forbidden inside `$facet`/`$lookup`/`$unionWith`), stage-body shape (literal type/range/enum/required-key/mutual-exclusivity rules — `$limit(-5)`, `$count('')`, `$group("externalId")`, `$project` mixing include/exclude, `$bucket` boundaries out of order, a `$merge` `whenMatched` typo), `$match` query placement (`$text` must be in the first stage, at any depth of the body; `$near` isn't allowed; nor is the `$where(…)` call form), operator arguments (operand count — `$divide(6, 2, 1)`; required & unknown object keys — `$dateAdd({ startdate })` → "Did you mean 'startDate'?"; enum slots — `unit`/`$convert.to`/regex flags; literal types — `$year("2020")`, `$abs("x")`), and **method chains that can't type-check** (`.every(p).map(f)` — a boolean has no methods; `s.toUpperCase().map(f)` — a string isn't an array; `a.countBy("t").take(3)` — an object isn't an array; `$$$.orders.find(p).take(5)` — `.find` returns one document). Only 100%-certain violations throw — a value jsmql can't evaluate (`$limit($.n)`, `$year($.d)`), a receiver whose type is uncertain (`arr.find(p).map(f)` — the element could be an array), or a deployment-dependent rule (sharding, memory limits, Atlas availability) still emits MQL. See [docs/LANGUAGE.md → Mistakes caught at compile time](docs/LANGUAGE.md#mistakes-caught-at-compile-time).
- **Actionable errors** — every error names the construct, suggests the nearest valid name (`Did you mean '…'?`), and carries a real `.pos` so editors can underline the offending region.
- **Strict TS, strippable source** — runs as-is on Node 22.18+ / 24.3+, Deno, and Bun (no flags, no transpile).
- **`jsmql` on the command line** — JSMQL on stdin, MQL on stdout, written as the JavaScript that rebuilds it, so it pastes straight into mongosh or a driver script. `echo '$.age > 18' | jsmql`. Opt-in `--filter` / `--pipeline` / `--expr` / `--update` / `--validate`, `--compact`, and `--arg` / `--argjson` for parameterised arrows. See [Command line](#command-line-jsmql).

## Using jsmql with mongoose

A one-shot registration patches the `Model` static methods so the standard `find / updateOne / aggregate / …` calls accept JSMQL source directly, alongside the plain MQL-JSON forms you already pass them:

```js
const mongoose = require("mongoose");
require("@koresar/jsmql/mongoose")(mongoose);
// or, ESM: import jsmqlMongoose from "@koresar/jsmql/mongoose"; jsmqlMongoose(mongoose);

const User = mongoose.model("User", new mongoose.Schema({ name: String, age: Number, score: Number }));

User.find("$.age > 18");                            // → find({ age: { $gt: 18 } })
User.find(({ $ }) => $.age > 18 && $.region === "AU"); // → find({ age: { $gt: 18 }, region: "AU" })

User.updateMany({}, ({ $ }) => $.score += 1);
// → updateMany({}, { $inc: { score: 1 } })         ← the update slot is the update DOCUMENT

User.aggregate(({ $ }) => {
  $match($.status === "active");
  $group({ _id: $.region, total: { $sum: $.amount } });
  $sort({ total: -1 });
});

User.find({ age: { $gt: 18 } });                    // plain MQL JSON still passes through untouched
```

**Detection rule.** A patched argument is treated as JSMQL source only when it's a **string** or a **function**. Plain objects/arrays (the regular MQL JSON forms) pass through to mongoose unchanged, so existing call sites need no migration. Template-tag inputs (`jsmql\`…\``) lower to an object at the user's call site, so they take the pass-through path too.

**TypeScript.** The plugin ships a `declare module "mongoose"` augmentation that adds JSMQL-shaped overloads (`string | JsmqlFn`) to every patched `Model` static, so `User.find("$.age > 18")` and `User.aggregate(({ $ }) => …)` type-check after `import "@koresar/jsmql/mongoose"` — no per-call cast required. Mongoose's own `FilterQuery<T>` / `UpdateQuery<T>` overloads still apply on the MQL-JSON pass-through path.

**Patched methods** (with the slot used): `find` / `findOne` / `findOneAnd{Delete,Replace,Update}` / `countDocuments` / `deleteOne` / `deleteMany` / `replaceOne` / `exists` (filter at 0), `updateOne` / `updateMany` / `findOneAndUpdate` / `findByIdAndUpdate` (update at 1), `distinct` (filter at 1), `aggregate` (pipeline at 0). Each slot lowers through the matching strict-shape entry (`jsmql.filter` / `jsmql.update` / `jsmql.pipeline`), so a wrong-shape input — e.g. a bare expression at an `aggregate` slot — throws with the actionable strict-mode error at the patched call site instead of silently going wrong server-side. Registering twice on the same `mongoose` is a no-op.

See [docs/specs/mongoose-plugin.md](docs/specs/mongoose-plugin.md) for the full per-slot table, the methods that are deliberately *not* patched (e.g. `findOneAndReplace`'s replacement document), and the idempotence / subclass-propagation contracts.

## Command line (`jsmql`)

Installing the package puts a `jsmql` command on your `PATH`: **JSMQL source on stdin, MQL on stdout** (a positional argument or `--file <path>` also work as the source).

```sh
echo '$.age > 18' | jsmql
# { age: { $gt: 18 } }

echo '$match($.age > 18); $sort({ age: -1 })' | jsmql --pipeline -c
# [{ $match: { age: { $gt: 18 } } }, { $sort: { age: -1 } }]

jsmql --expr '$.price * (1 - $.discount)'
# { $multiply: ["$price", { $subtract: [1, "$discount"] }] }
```

With no flag the output shape is picked the same way `jsmql()` picks it (a top-level `;` makes it a Pipeline). The strict flags lock the shape and inherit the library's actionable errors:

| Flag | Shape | Library entry |
| --- | --- | --- |
| *(none)* | Filter or Pipeline | `jsmql()` |
| `--filter` | Filter document | `jsmql.filter()` |
| `--pipeline` | stage array | `jsmql.pipeline()` |
| `--expr` | aggregation expression | `jsmql.expr()` |
| `--update` | update document | `jsmql.update()` |
| `--validate` (`--check`) | `{ valid, errors }`; exit 1 if invalid | `jsmql.validate()` |

A document stays on one line while it fits in 80 columns and breaks one entry per line once it does not; `-c`/`--compact` keeps it on one line whatever its length, `--tab` indents with tabs and `--indent N` with N spaces. The output is JavaScript, not JSON: every **live BSON value** — a `Date`, an `ObjectId`, a `Decimal128`, a regular expression — prints as the expression that rebuilds it, because JSON has no spelling for one and a stringified date is a string the server compares as a string:

```sh
echo '$.name.match(/^a/i) && $.d >= new Date("2026-01-01")' | jsmql -c
# { name: { $regex: /^a/i }, d: { $gte: new Date("2026-01-01T00:00:00.000Z") } }
```

The printer is public as `jsmql.stringify(document[, { indent, width }])`, so a program prints MQL the way the terminal does.

Parameterise a query with `--arg` / `--argjson` — the source must then be a parameterised arrow:

```sh
echo '({ minAge }, { $ }) => $.age > minAge' | jsmql --argjson minAge 18
# { age: { $gt: 18 } }
```

`--arg name value` binds a string; `--argjson name value` binds a JSON value. Params combine with any shape flag (`--pipeline --argjson minAge 18` binds and enforces the Pipeline shape) and with `--validate`. Errors print compiler-style with a caret at the offending position; exit codes are `0` success, `1` compile error / invalid, `2` usage error. `jsmql --help` lists everything. Full reference: [docs/specs/cli.md](docs/specs/cli.md).

## Try it & learn more

- **[jsmql.js.org](https://jsmql.js.org)** — the project site: what JSMQL is, how it compiles, and where to go next. Every MQL document on it is compiled in your browser by the same bundle npm ships.
- **[Live playground](https://jsmql.js.org/playground.html)** — write JSMQL, see the MQL JSON update live. Pre-loaded with real-world recipes: tiered discounts, slug generation, audit logs, pivot tables, parameterised reports, and more.
- **[docs/LANGUAGE.md](docs/LANGUAGE.md)** — the full language reference: every operator, every method, update-filter rules, `$match` query translation, `jsmql.compile` parameter semantics, `jsmql.expr` for raw aggregation expressions, the strict-shape entry points (`jsmql.filter` / `jsmql.pipeline` / `jsmql.update`), `jsmql.stringify` for printing a document, the `@koresar/jsmql/globals` import, error catalogue, server-side-JS migration guide.
- **[docs/DEVLOG.md](docs/DEVLOG.md)** — the running record of language decisions and the reasoning behind them.

## License

MIT
