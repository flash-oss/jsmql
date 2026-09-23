# JSMQL

**Write MongoDB aggregation queries in JavaScript.** JSMQL is a strict JS subset. It compiles to MQL JSON. It works like SQL, but for MongoDB, and it uses the syntax you already know.

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
  assert($$.size() === 1, "More than one user with such email found");
  $$ = $$$.orders
    .filter({ userId: $._id })
    .toSorted({ placedAt: -1 })
    .take(5);
`;
// → [
//   { $match: { email: "me@example.com" } },
//   { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
//   { $match: { $expr: { $convert: { input: true, to: { $cond: [
//       { $eq: ["$__jsmql.size", 1] }, "bool",
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

**MongoDB 8.0 deprecated server-side JavaScript through `$function`, `$accumulator`, and `$where`.** JSMQL replaces it. JSMQL gives you native MQL. It works with indexes. Your IDE understands it. You can test it as plain JS.

## Install

```sh
npm install @koresar/jsmql bson
```

JSMQL ships as ESM and CJS, and runs in browsers. It works with **Node 16.20.1+**, Deno, and Bun.

`bson` is a **peer** dependency (`^6.10.0 || ^7.0.0`). npm installs it for you. The MongoDB
driver and mongoose already carry this package, so JSMQL shares their copy. Your own `bson`
builds every BSON value that JSMQL emits. Each value carries your `bson` version, and it
passes unchanged to any other module. JSMQL also re-exports the nine types it can spell
(`import { ObjectId } from "@koresar/jsmql"`). Use this import to reach the same copy without a
second import.

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
jsmql('[...$.mods, ...$.room?.mods, "root"].has($.userId)')
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
// mis-dispatch would be a pitfall.
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

The **[live playground](https://jsmql.js.org/playground.html)** shows dozens more JSMQL examples.

## Why the arrow form

jsmql() **never runs** the arrow function. It calls `Function.prototype.toString()` on the function, removes the parameter list, and parses the body. This one trick gives you:

- **Free formatting.** Prettier, oxfmt, and every other JS formatter indent and line-break your query like any other JavaScript. You need no JSMQL plugin and no custom config.
- **Free linting.** ESLint, Biome, and your editor's TypeScript service see real JS. They flag typos, unused identifiers, and shape mismatches when you write the code.
- **Code completion.** Add `import "@koresar/jsmql/globals"`. Then your IDE completes every stage name and operator name. It suggests the argument keys from the official MongoDB MQL spec. It shows the operator's description on hover. This import also declares the `$$` / `$$$` / `$$$$` context-ref prefixes, so arrow-form code that uses them type-checks. It gives full completion and annotated option objects for the diagnostic source stages (`$$.collStats({…})`, `$$$$.currentOp({…})`, …). The value methods (`.uniq()`, `.chunk()`, `.groupBy()`, `.capitalize()`, `.clamp()`, `.startOf()`, …) complete and chain on any value with a known type: an annotated document, a typed static call such as `Object.values(o)`, or a method result mid-chain with a known return type. This covers `Date` too. JSMQL's date vocabulary (`.plus()`, `.diff()`, `.format()`, `.set()`, …) has no match in JavaScript's own `Date`. Without the import, TypeScript underlines code that JSMQL compiles without error.
- **AI coding works with no setup.** Copilot, Cursor, and Claude already know JavaScript. They complete JSMQL the JavaScript way, because JSMQL *is* JavaScript. They need to learn no new vocabulary.
- **Pre-compilation.** `jsmql.compile()` parses the query once and runs it many times.

## Highlights

- **JS you already know** — operators, ternaries, template literals, optional chaining, spread, computed keys, numeric separators, trailing commas, `Math.*`, `Date`, `typeof`, comments, the `function` keyword, multi-declarator declarations (`const a = …, b = …;` — `b` reads the `a` beside it, and the `,` shares one `$set`/`$let` the way `$.a = …, $.b = …` does; JSMQL breaks this sharing only where a declarator reads a sibling), and block-body arrows with local `const`s (`x => { const y = …; return … }` → nested `$let`). Every construct JSMQL accepts is valid JavaScript. Paste any expression into a `.js` file, and `node --check` passes.
- **Real BSON values, from your own `bson`** — write `ObjectId("507f…")`, `Decimal128("9.99")`, `Long("9007199254740993")`, `Int32(3)`, `Double(1)`, `UUID("…")`, `MinKey()` or `MaxKey()`, and JSMQL emits a live instance of the class your driver already carries. So it passes `instanceof` in your code. `X(…)` and `new X(…)` both work. mongosh's names (`NumberDecimal`, `NumberLong`, `NumberInt`, `ISODate`) mean the same thing. A runtime value converts on the server instead (`Decimal128($.s)` → `$toDecimal`). JavaScript never folds arithmetic on a decimal: `Decimal128("0.1") + Decimal128("0.2")` goes to the server, and the server answers an exact `0.3`. Where `bson` would silently wrap a value (`new Int32(5000000000)` becomes `705032704` there), JSMQL refuses at the source position and names the type that fits. See [docs/LANGUAGE.md → The other BSON types](docs/LANGUAGE.md#the-other-bson-types).
- **Compile-time constants** — take a `const`/`let` whose right side is a constant: `const userId = 0x507f…`, `const msInDay = 24 * 60 * 60 * 1000`, `new Date("2020-01-01")` and its arithmetic (`start.plus(1, "month")` is a literal date, computed the way `$dateAdd` computes it), or a literal array or object. JSMQL evaluates it once at compile time and inlines it at every use. It emits no `$set` and no cleanup stage. Because the declaration emits nothing, a constant plus a predicate compiles to a clean, indexable **Filter** (`const userId = 0x507f…; $.userId === userId` → `{ userId: new ObjectId("507f…") }`). A binding that reads the document or the clock keeps the runtime `$set` form. See [docs/LANGUAGE.md → Compile-time constants](docs/LANGUAGE.md#compile-time-constants-folding).
- **Reusable functions** — name a function once, then call it across fields, in either spelling: `function money(n) { return Math.round(n * 100) / 100 } $ = { subtotal: money(...), tax: money(...) }` (or the arrow form `const money = (n) => …`). The `function` keyword works everywhere an arrow works: declarations, inline callbacks, and the `jsmql(fn)` input. Each call expands inline as its own `$let` (a named IIFE). The declaration stores nothing in the document, and a function the query never calls adds nothing to the output. A body can close over `$.fields` and can call another function. See [docs/LANGUAGE.md → Reusable functions](docs/LANGUAGE.md#reusable-functions).
- **Dates the way your date library spells them** — `.plus` / `.minus` / `.diff` / `.startOf` / `.endOf` / `.format` / `.set` / `.isSame` / `.isBefore` / `.isAfter`, plus the parts JavaScript's `Date` cannot report (`.week`, `.isoWeek`, `.isoWeekday`, `.dayOfYear`, `.quarter`). `$group({ _id: $.createdAt.startOf("month"), revenue: $sum($.total) })` is the whole time-series rollup. The names come from Moment, Luxon, and Temporal, but the *semantics* stay MongoDB's: `.diff` counts calendar boundaries, and `.format` takes `%Y-%m-%d`. JSMQL refuses a Moment token string such as `"YYYY-MM-DD"` at compile time and names the translation, because MQL would silently render the string as its own literal text. Every method takes one trailing `timezone` argument, or an options object. See [docs/LANGUAGE.md → Date operations](docs/LANGUAGE.md#date-operations).
- **Every operator in the spec** — one registry row (`src/registry/names.ts`) states each aggregation expression, accumulator, and query operator of the official MongoDB MQL spec. An unknown operator passes through, so a new MongoDB release works from day one.
- **Plain MQL passes through.** Drop hand-written MQL JSON inline — `{ $gt: ["$age", 18] }`, a whole stage, a whole pipeline — and JSMQL compiles it to itself. Mix the two forms freely, migrate one expression at a time, or paste an example directly from the MongoDB docs.
- **JSMQL picks Filter or Pipeline for you** — a top-level stage call, update operation, statement, or any input with a top-level `;`, lowers as a `Pipeline`. Everything else lowers as a `Filter`, with index-safe predicates translated to query-document form. See [docs/LANGUAGE.md → Output dispatch](docs/LANGUAGE.md#output-dispatch-filter-vs-pipeline).
- **Joins as JS** — `$$$.<coll>.find(pred)` and `.filter(pred)` lower to `$lookup`. `.find()` returns one document or null. `.filter()` keeps the array. **Any lodash stream method may *start* the chain**, not only `.find` or `.filter`. `$$$.orders.toSorted({ createdAt: -1 }).take(200).filter(o => o.productIds.has($._id))` lowers the whole chain, in source order, into one `$lookup.pipeline` (`[$sort, $limit, $match]` — sort and limit run *before* the filter; a filter-first form cannot express this order). A correlating `.filter` or `.reject` may sit anywhere in the chain. For an arbitrary sub-pipeline — grouping, top-N, reshaping — reach for `.aggregate((o) => { $group(...); $sort(...); })`, named after the driver's own `db.coll.aggregate`. It is a chain link like any other: `$$$.orders.sort({ createdAt: -1 }).take(1000).aggregate((o) => { $group({ _id: o.region, revenue: $sum(o.total) }); }).sort({ revenue: -1 }).take(3)` bounds the scan, groups the results, and ranks the groups in one `$lookup.pipeline`, with no intermediate array. Chained reads (`.size()`, `.reduce`, member access) and `.aggregate` sub-pipelines compose inline. A `{ … }` callback on a JavaScript method (`.find` / `.filter` / `.map`) stays JavaScript, so pipeline stages live in `.aggregate` alone, and you write a reshape as the parameter-replace form `o = <expr>`. You may nest these to any depth: a deep callback can read the root document (`$.x`), an enclosing match (`o.x`), and an ancestor sub-stream count (`outerColl.size()`), all at once, each correctly correlated. A join read inline runs as a `$lookup` placed directly ahead of the stage that reads it, so a callback's parameter always names the document that stage sees. `$$.$sortByCount($.tag).map(g => $$$.orders.filter(o => o.tag === g._id).size())` joins on the group key, not on the source document. A join whose predicate reads a `.map` / `.filter` / `.reduce` *element* is a compile-time error instead, because a stage cannot run once per array element; the message names the two spellings that can. A join in the body of a stage the server requires FIRST (`$geoNear`, `$documents`, `$search`, …) or LAST (`$merge`'s `let`) is also a compile-time error, because the `$lookup` would have nowhere legal to stand; each message names the later-statement or earlier-statement rewrite that works. Reads work within one database only. A cross-database read (`$$$$.<db>.<coll>.find/filter`) is a compile-time error that points you at the same-database `$$$.<coll>` form. See [docs/LANGUAGE.md → Cross-collection lookups](docs/LANGUAGE.md#cross-collection-lookups-collfind--filter).
- **Collection unions as `Array.push`** — `$$.push({...}, ...$$$.<coll>.filter(pred))` lowers to `$unionWith`, with a JS-faithful spread rule: an array spreads, a scalar does not. See [docs/LANGUAGE.md → Collection union](docs/LANGUAGE.md#collection-union-push).
- **Replace root as JS assignment** — `$ = <expr>` lowers to `$replaceWith`. Use it to lift a sub-document (`$ = $.profile`), keep or drop fields (`$ = $.pick(["name", "email"])` is one `$project`), merge fresh fields (`$ = { ...$, score: ... }`), or pivot to a joined document. JSMQL refuses an array on the right side, and the message names the destination that takes one, because the fan-out belongs to the stream. JSMQL refuses a scalar the same way, and the message names the wrap to use. See [docs/LANGUAGE.md → Replace root through `$ = <expr>`](docs/LANGUAGE.md#replace-root-via---expr).
- **Writing a collection** — `$$$.<coll> = $$` (and `$$$$.<db>.<coll> = $$`) REPLACES it: a `$out`. `$$$.<coll> += $$` ADDS to it: a `$merge`, as do `.concat(…)` and `.push(…)`, which take an array of documents as well as the stream. The left side names the destination. The right side names the source, optionally filtered. A compile-time check enforces that this statement comes last. See [docs/LANGUAGE.md → `$out`](docs/LANGUAGE.md#out-write-the-pipeline-to-a-collection).
- **Diagnostics scoped by prefix** — a system source stage is a method call on the context reference with the scope it needs: `$$.indexStats()` and similar calls need the collection; `$$$$.currentOp({…})` and similar calls need the deployment. The wrong scope is a compile-time error that names the right prefix. See [docs/LANGUAGE.md → System / diagnostic stages](docs/LANGUAGE.md#system--diagnostic-stages-indexstats-currentop-).
- **`$facet` as a named object of branches** — when every value of `$ = { … }` is a `$$` chain (a `$$.filter(<predicate>)`, chained stage calls, or a mix of both), the surface lowers to one `$facet` stage, with each entry a named sub-pipeline. See [docs/LANGUAGE.md → $facet through `$ = { key: <$$ chain>, … }`](docs/LANGUAGE.md#facet-via----key--chain--).
- **Replace stream as JS assignment** — `$$ = <expr>` reshapes the whole stream the way `$ = <expr>` reshapes one document. Use it to narrow the stream (`→ $match`), switch the source, pivot onto a correlated collection, or **fan out**: `$$ = <array>` makes the stream from the array's elements, one document per element, through `$unwind`. So a possibly-empty array (`$.items.filter(…)`) can drop documents conditionally. JSMQL picks the lowering from the shape of the expression. See [docs/LANGUAGE.md → Replace stream](docs/LANGUAGE.md#replace-stream-via---expr).
- **Pipeline stages chain too** — any aggregation stage can be a chain link on a stream: `$$.$match({ status: "shipped" }).$sort({ total: -1 }).$limit(5)` compiles to the same pipeline as three `;`-separated statements. This chain interleaves with the JS chain methods (`$$.filter(p => p.score > 0).$sort({ score: -1 }).take(10)`), and it is the only way to reach a stage with **no JavaScript spelling** — `$group`, `$unwind`, `$setWindowFields`, `$bucket`, and others — from a value position. `const byRegion = $$$.orders.$match({…}).$group({ _id: "$region", revenue: $sum("$total") }).$sort({ revenue: -1 }).$limit(5).map(g => …)` builds the whole `$lookup.pipeline` inline. JSMQL accepts only real MongoDB stages, and a stage placed after a value-producing link (`.sum().$limit(5)`) is a compile-time error. See [docs/LANGUAGE.md → Chained form](docs/LANGUAGE.md#chained-form-stage-on-a-stream).
- **Stream methods chain on the right side** — after the `$$` or `$$$.<coll>` receiver, optionally followed by `.filter(p)`, chain JS-array and lodash-style methods. `.map` / `.filter` / `.flatMap` / `.slice` / `.concat` plus a lodash vocabulary (`.sort`, `.take`, `.drop`, `.groupBy`, `.countBy`, `.uniqBy`, `.sample`, `.sampleSize`, and others — the rows with a stream cell in `src/registry/names.ts` give the live list) each append stages. Lodash iteratee shorthands work too: `.map("userId")`, `.filter({ status: "CLOSED" })`, `.groupBy({ _id: "$dept", n: $sum(1) })`, and a key-less `.countBy()` counts the elements themselves. After `.flatMap("items")`, every callback receives the item, as in JavaScript (`.filter(i => i.qty > 1)` compiles to `{ "items.qty": { $gt: 1 } }`). A callback may destructure its parameter: `.sortBy(([id, count]) => -count)`. For a bare `$$` receiver, the `$$ =` head is optional. See [docs/LANGUAGE.md → Stream methods](docs/LANGUAGE.md#stream-methods-chained-after-the-rhs).
- **JS mutators mutate at statement position** — `$.events.sort(e => e.t)`, `.push(x)`, `.reverse()`, `.splice(...)`, and similar calls desugar to a `$set` that reassigns the field. The `.toSorted` / `.toReversed` / `.with` family stays immutable. `Object.assign(target, ...sources)` is the object equivalent. At statement position it merges into its target — a `$.field`, or an in-scope `let`/`const` binding, even a `const` — the same way JS's own mutating `Object.assign` does. A mutator in expression position throws, and the error names the fix. See [docs/LANGUAGE.md → Mutators](docs/LANGUAGE.md#mutators-at-statement-position-they-mutate-the-field).
- **Conditional errors through `assert`** — `assert(condition[, message])` is a pipeline guard clause. When the condition fails, the whole operation aborts with a server error that carries your message (`Unknown type name: jsmql assertion failed: …`). It lowers to a portable `$match` plus `$convert` shape, with no deprecated server-side JS (`$function`), so it works under the Stable API and on every Atlas tier. It works at statement position only; at expression position it throws, with a hint. See [docs/LANGUAGE.md → `assert`](docs/LANGUAGE.md#assert-fail-the-pipeline-when-an-invariant-breaks).
- **Stream count as `$$.size()`** — `$$.size()` gives the current stream's document count. Use it as a value anywhere: `$.n = $$.size()`, `assert($$.size() <= 1, …)`, or in arithmetic. JSMQL materialises a `$setWindowFields` `$count` once, reuses it, and recomputes it after a count-changing stage (`$match`, `$group`, `$unwind`, and others). It works in a pipeline only. See [docs/LANGUAGE.md → `$$.size()`](docs/LANGUAGE.md#size-count-the-current-stream).
- **Three call shapes** — the arrow shape `jsmql(({ $ }) => …)`, the string shape `jsmql("…")`, and the template tag shape `` jsmql`…${val}…` `` for outer-scope values.
- **Polymorphic by default, strict on demand** — `jsmql()` picks Filter or Pipeline from the input. `jsmql.filter()` and `jsmql.pipeline()` lock it to one shape, and throw an actionable error otherwise. `jsmql.update()` gives the update DOCUMENT (`{ $set, $inc, $push, … }`, constants only) that `updateOne(filter, update)` takes. `jsmql.compile(fn)` parses a parameterised query once, for parse-once, bind-many use, and each strict entry has a shape-locked `.compile` (`jsmql.filter.compile`, `jsmql.pipeline.compile`, `jsmql.update.compile`). `jsmql.expr()` returns the raw aggregation expression that drops into a stage body. The three call shapes — string, arrow, and template tag — apply to all of them.
- **The MQL prints as JavaScript** — `jsmql.stringify(document)` writes what the compiler produced as the source that rebuilds it. The CLI, the playground, and the landing page all show this form. A `Date`, an `ObjectId`, a `Decimal128`, a `Binary`, and a regular expression each print as the `new X(…)` call the Node driver needs, and mongosh reads the same text. `JSON.stringify` writes a date as a string, so the server then compares it as a string, and it writes a regular expression as `{}`; the query still runs, but it matches nothing. See [docs/LANGUAGE.md → Printing MQL](docs/LANGUAGE.md#printing-mql-jsmqlstringify).
- **lodash value methods** — for the aggregation-shaped operations native JS has no spelling for, use these as per-document field methods. They cover the lodash Array and Collection vocabulary that maps cleanly to MQL: `$.items.groupBy("type")`, `$.items.take(3)` / `.drop(3)` / `.chunk(3)`, `$.a.without(0)` / `.xor($.b)` / `.differenceBy($.b, "id")`, `$.a.sortBy("age")` / `.orderBy(["age"], ["desc"])`, `$.a.zip($.b)`, `$.a.takeWhile(x => x > 0)`, `$.a.sample()`, `$.nums.sum()`, `$.user.pick(["name", "age"])` (or `$.pick([...])` on the document itself), `$.o.mapValues(v => v * 2)`, `$.n.clamp(0, 100)`, `$.name.capitalize()`, and others. A method that takes an iteratee accepts a `"field"` string or an arrow. String methods work on ASCII text only. See [docs/LANGUAGE.md](docs/LANGUAGE.md).
- **`@koresar/jsmql/globals`** — a pure-types side-effect import. It adds the ambient globals `$match` / `$dateAdd` and others, types the `$$` / `$$$` pipeline chains, and augments `Array` / `String` / `Number` / `Date` with JSMQL's value methods. It costs nothing at runtime, because bundlers tree-shake it to nothing.
- **A written field keeps its type** — the compiler proves a type for every value it touches and carries it forward: after `$.arr = $.tags.uniq()` it knows `arr` is an array, so `$.arr.has("red")` takes the array form with no `$switch`; after `$.bool = $.arr.has("red")` it knows `bool` is a boolean, so `$.bool ? "R" : "OTHER"` is `{ $cond: { if: "$bool", … } }` and not a four-way truthiness check. The proof follows a whole-field write, a dotted write, a `let` and each reassignment, a `const` bound to a `$$$.<coll>` join (the body's `.pick`, `.flatMap` and `.countBy` shape its documents), and a value of several possible kinds dispatches over those kinds alone. A method on a field proven to hold a kind it has no form for fails at compile time, with the message naming what the method takes. See [docs/LANGUAGE.md → Type-aware dispatch](docs/LANGUAGE.md#type-aware-dispatch).
- **Pre-flight validation** — JSMQL rejects, at compile time, the pipeline mistakes the MongoDB server would otherwise reject. This covers: stage placement (`$out`/`$merge` must come last; `$collStats`/`$geoNear`/`$changeStream` and similar stages must come first; a stage is forbidden inside `$facet`/`$lookup`/`$unionWith`); stage-body shape (literal type, range, enum, required-key, and mutual-exclusivity rules, for example `$limit(-5)`, `$count('')`, `$group("externalId")`, a `$project` that mixes include and exclude, `$bucket` boundaries out of order, or a typo in `$merge`'s `whenMatched`); `$match` query placement (`$text` must sit in the first stage, at any depth of the body; `$near` is not allowed; nor is the `$where(…)` call form); operator arguments (operand count, for example `$divide(6, 2, 1)`; required and unknown object keys, for example `$dateAdd({ startdate })` gives "Did you mean 'startDate'?"; enum slots such as `unit`, `$convert.to`, or regex flags; literal types, for example `$year("2020")` or `$abs("x")`); and **a method chain that cannot type-check**, for example `.every(p).map(f)` (a boolean has no methods), `s.toUpperCase().map(f)` (a string is not an array), `a.countBy("t").take(3)` (an object is not an array), or `$$$.orders.find(p).take(5)` (`.find` returns one document). JSMQL throws only on a violation it can prove with full certainty. It still emits MQL for a value it cannot evaluate (`$limit($.n)`, `$year($.d)`), for a receiver whose type is uncertain (`arr.find(p).map(f)` — the element could be an array), or for a rule that depends on the deployment (sharding, memory limits, Atlas tier availability). See [docs/LANGUAGE.md → Mistakes caught at compile time](docs/LANGUAGE.md#mistakes-caught-at-compile-time).
- **Actionable errors** — every error names the construct, suggests the nearest valid name (`Did you mean '…'?`), and carries a real `.pos` value, so an editor can underline the offending region.
- **Strict TypeScript, strippable source** — the source runs as-is on Node 22.18+ / 24.3+, Deno, and Bun, with no flags and no transpile step.
- **`jsmql` on the command line** — put JSMQL on stdin, and get MQL on stdout, written as the JavaScript that rebuilds it, so it pastes straight into mongosh or a driver script. `echo '$.age > 18' | jsmql`. Opt-in flags `--filter` / `--pipeline` / `--expr` / `--update` / `--validate` and `--compact` are available, plus `--arg` / `--argjson` for parameterised arrows. See [Command line](#command-line-jsmql).

## Using JSMQL with mongoose

One registration call patches the `Model` static methods. After this, the standard `find / updateOne / aggregate / …` calls accept JSMQL source directly, alongside the plain MQL-JSON forms you already pass them:

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

**Detection rule.** The plugin treats a patched argument as JSMQL source only when it is a **string** or a **function**. A plain object or array — the regular MQL JSON forms — passes through to mongoose unchanged, so an existing call site needs no change. A template-tag input (`jsmql\`…\``) lowers to an object at your call site, so it also takes the pass-through path.

**TypeScript.** The plugin ships a `declare module "mongoose"` augmentation. It adds JSMQL-shaped overloads (`string | JsmqlFn`) to every patched `Model` static, so `User.find("$.age > 18")` and `User.aggregate(({ $ }) => …)` type-check after `import "@koresar/jsmql/mongoose"`, with no cast needed at the call site. Mongoose's own `FilterQuery<T>` / `UpdateQuery<T>` overloads still apply on the MQL-JSON pass-through path.

**Patched methods** (with the slot used): `find` / `findOne` / `findOneAnd{Delete,Replace,Update}` / `countDocuments` / `deleteOne` / `deleteMany` / `replaceOne` / `exists` (filter at slot 0), `updateOne` / `updateMany` / `findOneAndUpdate` / `findByIdAndUpdate` (update at slot 1), `distinct` (filter at slot 1), `aggregate` (pipeline at slot 0). Each slot lowers through the matching strict-shape entry (`jsmql.filter` / `jsmql.update` / `jsmql.pipeline`). So a wrong-shape input — for example a bare expression at an `aggregate` slot — throws the actionable strict-mode error at the patched call site, instead of failing silently on the server. Registering twice on the same `mongoose` object is a no-op.

See [docs/specs/mongoose-plugin.md](docs/specs/mongoose-plugin.md) for the full per-slot table, the methods the plugin deliberately does *not* patch (for example `findOneAndReplace`'s replacement document), and the idempotence and subclass-propagation contracts.

## Command line (`jsmql`)

Installing the package puts a `jsmql` command on your `PATH`. **It reads JSMQL source from stdin and writes MQL to stdout** (a positional argument or `--file <path>` also work as the source).

```sh
echo '$.age > 18' | jsmql
# { age: { $gt: 18 } }

echo '$match($.age > 18); $sort({ age: -1 })' | jsmql --pipeline -c
# [{ $match: { age: { $gt: 18 } } }, { $sort: { age: -1 } }]

jsmql --expr '$.price * (1 - $.discount)'
# { $multiply: ["$price", { $subtract: [1, "$discount"] }] }
```

With no flag, the CLI picks the output shape the same way `jsmql()` picks it (a top-level `;` makes it a Pipeline). The strict flags lock the shape, and they inherit the library's actionable errors:

| Flag | Shape | Library entry |
| --- | --- | --- |
| *(none)* | Filter or Pipeline | `jsmql()` |
| `--filter` | Filter document | `jsmql.filter()` |
| `--pipeline` | stage array | `jsmql.pipeline()` |
| `--expr` | aggregation expression | `jsmql.expr()` |
| `--update` | update document | `jsmql.update()` |
| `--validate` (`--check`) | `{ valid, errors }`; exit 1 if invalid | `jsmql.validate()` |

A document stays on one line while it fits in 80 columns, and breaks to one entry per line once it does not. `-c`/`--compact` keeps it on one line whatever its length. `--tab` indents with tabs, and `--indent N` indents with N spaces. The output is JavaScript, not JSON. Every **live BSON value** — a `Date`, an `ObjectId`, a `Decimal128`, a regular expression — prints as the expression that rebuilds it, because JSON has no spelling for these values, and a stringified date is a string, which the server then compares as a string:

```sh
echo '$.name.match(/^a/i) && $.d >= new Date("2026-01-01")' | jsmql -c
# { name: { $regex: /^a/i }, d: { $gte: new Date("2026-01-01T00:00:00.000Z") } }
```

The printer is public as `jsmql.stringify(document[, { indent, width }])`, so a program can print MQL the way the terminal does.

Use `--arg` / `--argjson` to parameterise a query. The source must then be a parameterised arrow:

```sh
echo '({ minAge }, { $ }) => $.age > minAge' | jsmql --argjson minAge 18
# { age: { $gt: 18 } }
```

`--arg name value` binds a string. `--argjson name value` binds a JSON value. A parameter combines with any shape flag (`--pipeline --argjson minAge 18` binds the parameter and enforces the Pipeline shape) and with `--validate`. An error prints in compiler style, with a caret at the offending position. The exit code is `0` for success, `1` for a compile error or an invalid result, and `2` for a usage error. `jsmql --help` lists every option. Full reference: [docs/specs/cli.md](docs/specs/cli.md).

## Try it & learn more

- **[jsmql.js.org](https://jsmql.js.org)** — the project site. It explains what JSMQL is, how it compiles, and where to go next. Your browser compiles every MQL document on the site, using the same bundle npm ships.
- **[Live playground](https://jsmql.js.org/playground.html)** — write JSMQL, and watch the MQL JSON update live. It comes pre-loaded with real-world recipes: tiered discounts, slug generation, audit logs, pivot tables, parameterised reports, and more.
- **[docs/LANGUAGE.md](docs/LANGUAGE.md)** — the full language reference: every operator, every method, update-filter rules, `$match` query translation, `jsmql.compile` parameter semantics, `jsmql.expr` for raw aggregation expressions, the strict-shape entry points (`jsmql.filter` / `jsmql.pipeline` / `jsmql.update`), `jsmql.stringify` for printing a document, the `@koresar/jsmql/globals` import, the error catalogue, and the server-side-JS migration guide.
- **[docs/DEVLOG.md](docs/DEVLOG.md)** — the running record of language decisions and the reasoning behind each one.

## License

MIT
