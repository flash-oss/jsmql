# jsmql

**Write MongoDB aggregation queries in JavaScript.** A strict JS subset that compiles to MQL JSON — like SQL but for MongoDB, using the syntax you already know.

```js
import { jsmql } from "@koresar/jsmql";

// Filter — for db.coll.find(filter). No `;` at top level.
const age = 18;
let filter = jsmql`$.age > ${age} && $.status === "active"`
// → { age: { $gt: 18 }, status: "active" }   ← index-friendly query doc

// Pipeline — for db.coll.aggregate(pipeline). Any `;` flips to stage mode.
// Narrow to one user, assert it's the only match, then pivot to their 5 newest orders.
let pipeline = jsmql`
  $$ = $$.filter({ email: "me@example.com" });
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
//   { $lookup: { from: "orders", let: { jsmql_f0__id: "$_id" }, pipeline: [
//       { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
//       { $sort: { placedAt: -1 } },
//       { $limit: 5 },
//   ], as: "__jsmql.tmp.1" } },
//   { $unwind: "$__jsmql.tmp.1" },
//   { $replaceWith: "$__jsmql.tmp.1" },
// ]

// Raw expression — for inside a stage body, or db.coll.updateOne(filter, update).
let expr = jsmql.expr(({ $ }) => $.items.map((i) => i.price * i.qty).reduce((a, x) => a + x, 0))
// → { $reduce: { input: { $map: { input: "$items", as: "i",
//     in: { $multiply: ["$$i.price", "$$i.qty"] } } },
//   initialValue: 0, in: { $add: ["$$value", "$$this"] } } }
```

**MongoDB 8.0 deprecated server-side JavaScript via `$function`, `$accumulator`, and `$where`.** The JSMQL is the replacement: native MQL, index-friendly, IDE-aware, testable as plain JS.

## Install

```sh
npm install @koresar/jsmql
```

ESM + CJS, runs in browsers, zero dependencies. Works with **Node 14+**, Deno, and Bun.

## Tour

```js
import "@koresar/jsmql/ops";          // ambient $-prefixed globals — autocomplete for 182 MQL ops & every stage
import { jsmql } from "@koresar/jsmql";

// Arrow form — your prettier/oxfmt handles formatting.
// No `;` at top level → query Filter (the doc db.coll.find(filter) takes).
jsmql(({ $ }) => $.email === $.email.trim().toLowerCase().endsWith("@flash-payments.com"))
// → {"$expr":{"$eq":["$email",{"$let":{"vars":{"jsmqlStr":{"$ifNull":[{"$toLower":{"$trim":{"input":"$email"}}},""]}},"in":{"$eq":[{"$substrCP":["$$jsmqlStr",{"$max":[0,{"$subtract":[{"$strLenCP":"$$jsmqlStr"},19]}]},19]},"@flash-payments.com"]}}}]}}

// Pipelines — any `;` flips to stage mode (the array db.coll.aggregate(pipeline) takes).
jsmql(({ $ }) => {
  $match($.age >= 18 && $.region === "AU");      // → query doc, indexes still work
  $group({ _id: $.shopId, total: { $sum: $.amount } });
  $sort({ total: -1 });
});
// → [{ "$match": { "age": { "$gte": 18 }, "region": "AU" } }, { "$group": { "_id": "$shopId", "total": { "$sum": "$amount" } } }, { "$sort": { "total": -1 } }]

// Use `?.` where a field might be null — you get `$ifNull` guards exactly there:
jsmql('[...$.mods, ...$.room?.mods, "root"].includes($.userId)')
//  { "$expr": { "$in": ["$userId", { "$concatArrays": ["$mods", { "$ifNull": ["$room.mods", []] }, ["root"]] }] } }

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
// → { "status": "open", "$expr": { "$in": ["$id", [1, 2, 3]] } }

// jsmql.compile — parse once, bind many. Output stays index-friendly.
const eligible = jsmql.compile(({ minAge, region }, { $ }) => {
  $match($.age >= minAge && $.region === region);
  $project({ age: 1, email: 1, address: 1 });
});
eligible({ minAge: 21, region: "AU" });
// → [{"$match":{"age":{"$gte":21},"region":"AU"}},{"$project":{"age":1,"email":1,"address":1}}]

// JS-natural `=`, `+=`, `delete` compile to coalesced $set / $unset
jsmql(({ $ }) => {
  $.score += 1;
  delete $.tempToken;
  $.status = "done";
});
// → [{ "$set": { "score": { "$add": ["$score", 1] } } }, { "$unset": "tempToken" }, { "$set": { "status": "done" } }]

// Assigning to bare `$` replaces the whole document — lowers to $replaceWith
jsmql(`$match($.profile != null); $ = $.profile; $ = { ...$, score: $.points * 1.1 }`);
// → [
//     { "$match": { "profile": { "$ne": null } } },
//     { "$replaceWith": "$profile" },
//     { "$replaceWith": { "$mergeObjects": ["$$ROOT", { "score": { "$multiply": ["$points", 1.1] } }] } }
//   ]

// Multi-facet aggregation — every value a `$$` chain lowers to one $facet stage
jsmql(`$ = {
  topByScore: $$.toSorted({ score: -1 }).take(10),
  recent:     $$.filter(o => o.createdAt >= "2026-01-01"),
  byStatus:   $$.$group({ _id: $.status, n: $sum(1) })
}`);
// → [{ "$facet": {
//       "topByScore": [{ "$sort": { "score": -1 } }, { "$limit": 10 }],
//       "recent":     [{ "$match": { "createdAt": { "$gte": "2026-01-01" } } }],
//       "byStatus":   [{ "$group": { "_id": "$status", "n": { "$sum": 1 } } }]
//   } }]

// Top 10 users by revenue: $group the orders, then sort descending and take the first 10.
// The `$$ = $$.toSorted(...).take(...)` chain lowers to $sort + $limit.
jsmql(`
$group({ _id: $.userId, revenue: $sum($.total), orders: $sum(1) });
$$ = $$.toSorted({ revenue: -1 }).take(10);
`);
// [
//     { "$group": { "_id": "$userId", "revenue": { "$sum": "$total" }, "orders": { "$sum": 1 } } },
//     { "$sort": { "revenue": -1 } },
//     { "$limit": 10 }
// ]

// `jsmql()` returns an UpdateFilter as a pipeline, to avoid common footgun of wiping out the whole collection.
db.users.updateMany({}, jsmql(({ $ }) => $.name = $.name.toUpperCase()))
// → [{ "$set": { "name": { "$toUpper": "$name" } } }] -> will upper-case all names in the collection

// `jsmql.expr()` returns a partial MQL JSON. Won't protect from the same footgun.
db.users.updateMany({}, jsmql.expr(({ $ }) => $.name = $.name.toUpperCase()))
// → { "$set": { "name": { "$toUpper": "$name" } } } -> will WIPE OUT all names in the collection

// Strict-shape entry points — throw if the input would produce the wrong shape.
// Use these when the call site demands a specific shape and a silent
// mis-dispatch would be a footgun.
db.users.find(jsmql.filter("$.age > 18"));            // throws on Pipeline-shaped input
db.users.aggregate(jsmql.pipeline("$match($.age > 18); $sort({ age: 1 })")); // throws on bare expressions
db.users.updateOne({ _id: 1 }, jsmql.update("$.name = $.name.toUpperCase()"));
// update() additionally rejects any stage outside MongoDB's update-pipeline
// whitelist ($addFields, $project, $replaceRoot, $replaceWith, $set, $unset),
// so a misplaced `$match` is caught at compile time instead of at the server.

// Raw expression — for embedding inside a hand-written stage body
const stage = { $addFields: { discount: jsmql.expr(({ $ }) => $.price * (1 - $.loyalty.multiplier)) } }
// → { $addFields: { discount: { $multiply: ["$price", { $subtract: [1, "$loyalty.multiplier"] }] } } }

// Escape hatch — call any MongoDB operator as a function - $dateTrunc in this case
jsmql.expr(({ $ }) => $set({ createdAtWeek: $dateTrunc({ date: $.createdAt, unit: "week" }) }))
// → { $set: { "createdAtWeek": { "$dateTrunc": { "date": "$createdAt", "unit": "week" } } } }

jsmql(({ $ }) => $.age = 18); // generates a pipeline, to make sure you can use this in updateOne(), updateMany(), etc
// → [{ "$set": { "age": 18 } }]
jsmql.expr(({ $ }) => $.age = 18); // generates an partial expression, to use within OTHER aggregation or filter expressions
// → { "$set": { "age": 18 }

// Validate without throwing — every error carries { message, pos, code }
jsmql.validate(({ $ }) => $.age > 18)
// → { valid: true, errors: [] }
```

The **[live playground](https://jsmql.js.org/playground.html)** is the best place to see dozens of other JSMQL examples.

## Why the arrow form

The arrow function is **never executed** — jsmql() calls `Function.prototype.toString()` on it, strips the parameter list, and parses the body. That single trick gives you:

- **Formatting for free.** Prettier, oxfmt, and every other JS formatter indent and line-break your query like any other JavaScript. No jsmql plugin, no custom config.
- **Linting for free.** ESLint, Biome, and your editor's TypeScript service see real JS — they flag typos, unused identifiers, and shape mismatches at write time.
- **Code completion.** With `import "@koresar/jsmql/ops"`, your IDE autocompletes every stage and operator name, suggests the argument keys from the official MongoDB MQL spec, and surfaces the operator's description on hover. It also declares the `$$` / `$$$` / `$$$$` context-ref prefixes — so arrow-form code using them type-checks, with full completion and annotated option objects for the diagnostic source stages (`$$.collStats({…})`, `$$$$.currentOp({…})`, …). The lodash-flavoured value methods (`.uniq()`, `.chunk()`, `.groupBy()`, `.capitalize()`, `.clamp()`, …) complete and chain on any concretely-typed value — an annotated document, a typed static like `Object.values(o)`, or a known-return method result mid-chain.
- **AI coding works out of the box.** Copilot, Cursor, and Claude already know JavaScript — they autocomplete jsmql idiomatically because jsmql *is* JavaScript. There is no new vocabulary for them to learn.
- **Pre-compilation.** jsmql.compile() parses once, executes many times.

## Highlights

- **JS you already know** — operators, ternaries, template literals, optional chaining, spread, computed keys, numeric separators, trailing commas, `Math.*`, `Date`, `typeof`, `instanceof`, comments, the `function` keyword, and block-body arrows with local `const`s (`x => { const y = …; return … }` → nested `$let`). If `node --check` accepts it, jsmql does too.
- **Compile-time constants** — a `const`/`let` whose right-hand side is a constant (`const userId = 0x507f…`, `const msInDay = 24 * 60 * 60 * 1000`, `new Date("2020-01-01")`, a literal array/object) is evaluated once at compile time and inlined at every use — no `$set`, no cleanup stage. Because the declaration emits nothing, a constant plus a predicate compiles to a clean, indexable **Filter** (`const userId = 0x507f…; $.userId === userId` → `{ userId: ObjectId("507f…") }`). A binding that reads the document or the clock keeps the runtime `$set` form. See [docs/LANGUAGE.md → Compile-time constants](docs/LANGUAGE.md#compile-time-constants-folding).
- **Reusable functions** — name a function once and call it across fields, in either spelling: `function money(n) { return Math.round(n * 100) / 100 } $ = { subtotal: money(...), tax: money(...) }` (or the arrow `const money = (n) => …`). The `function` keyword works everywhere arrows do — declarations, inline callbacks, and the `jsmql(fn)` input. Each call expands inline as its own `$let` (a named IIFE); the declaration stores nothing in the document and an uncalled one adds nothing to the output. Bodies can close over `$.fields` and compose with each other. See [docs/LANGUAGE.md → Reusable functions](docs/LANGUAGE.md#reusable-functions).
- **Dates the way your date library spells them** — `.plus` / `.minus` / `.diff` / `.startOf` / `.endOf` / `.format` / `.set` / `.isSame` / `.isBefore` / `.isAfter`, plus the parts JavaScript's `Date` can't report (`.week`, `.isoWeek`, `.isoWeekday`, `.dayOfYear`, `.quarter`). `$group({ _id: $.createdAt.startOf("month"), revenue: $sum($.total) })` is the whole time-series rollup. The names come from Moment / Luxon / Temporal; the *semantics* stay MongoDB's, so `.diff` counts calendar boundaries and `.format` takes `%Y-%m-%d` — a Moment token string like `"YYYY-MM-DD"` is refused at compile time with the translation, because MQL would silently render it as its own literal text. Every method takes one trailing `timezone` (or an options object) argument. See [docs/LANGUAGE.md → Date operations](docs/LANGUAGE.md#date-operations).
- **182 operators, full coverage** — every aggregation expression and accumulator from the official MongoDB MQL spec, including Bitwise and Window categories. Unknown operators pass through, so new MongoDB releases work day one.
- **Plain MQL passes through.** Drop hand-written MQL JSON inline — `{ $gt: ["$age", 18] }`, a whole stage, a whole pipeline — and jsmql compiles it to itself. Mix the two freely, migrate one expression at a time, or paste verbatim from the MongoDB docs.
- **Filter vs Pipeline picked automatically** — a top-level stage call / update op / statement, or any `;`-separated input, lowers as a `Pipeline`; everything else lowers as a `Filter`, with index-safe predicates translated to query-document form. See [docs/LANGUAGE.md → Output dispatch](docs/LANGUAGE.md#output-dispatch-filter-vs-pipeline).
- **Joins as JS** — `$$$.<coll>.find(pred)` / `.filter(pred)` lower to `$lookup`; `.find()` returns one doc or null, `.filter()` keeps the array. **Any lodash stream method may *start* the chain**, not only `.find`/`.filter` — `$$$.orders.toSorted({ createdAt: -1 }).take(200).filter(o => o.productIds.includes($._id))` lowers the whole chain, in source order, into one `$lookup.pipeline` (`[$sort, $limit, $match]` — sort/limit *before* the filter, which filter-first can't express), and a correlating `.filter`/`.reject` may sit anywhere. For an arbitrary sub-pipeline (grouping, top-N, reshaping) reach for `.aggregate((o) => { $group(...); $sort(...); })` (named after the driver's own `db.coll.aggregate`), which is a chain link like any other — `$$$.orders.sort({ createdAt: -1 }).take(1000).aggregate((o) => { $group({ _id: o.region, revenue: $sum(o.total) }); }).sort({ revenue: -1 }).take(3)` bounds the scan, groups, and ranks the groups in one `$lookup.pipeline`, with no intermediate array. Chained reads (`.length`, `.reduce`, member access) and `.aggregate` sub-pipelines compose inline — a `{ … }` callback on a JavaScript method (`.find` / `.filter` / `.map`) stays JavaScript, so pipeline stages live in `.aggregate` alone, with a reshape written as its root-replace `$ = <expr>`. Nest them to any depth: a deep callback can read the root doc (`$.x`), an enclosing match (`o.x`), and an ancestor sub-stream count (`outerColl.length`) all at once, each correctly correlated. Reads are same-database only — a cross-database read (`$$$$.<db>.<coll>.find/filter`) is a compile-time error pointing you at the same-db `$$$.<coll>` form. See [docs/LANGUAGE.md → Cross-collection lookups](docs/LANGUAGE.md#cross-collection-lookups-coll-find--filter).- **Collection unions as `Array.push`** — `$$.push({...}, ...$$$.<coll>.filter(pred))` lowers to `$unionWith`, with a JS-faithful spread rule (arrays spread, scalars don't). See [docs/LANGUAGE.md → Collection union](docs/LANGUAGE.md#collection-union-push).
- **Replace root as JS assignment** — `$ = <expr>` lowers to `$replaceWith`: lift a sub-document (`$ = $.profile`), merge fresh fields (`$ = { ...$, score: ... }`), or pivot to a joined doc. When the RHS is provably an array (`$ = [{…}, {…}]`, `$ = $.items.map(…)`, `$ = [...$.items]`), it **fans out** — one input document becomes one output document per element (via `$unwind`); fanning out a possibly-empty array (`$.items.filter(…)`) conditionally drops documents. A scalar RHS is a compile-time error pointing at the fix. See [docs/LANGUAGE.md → Replace root via `$ = <expr>`](docs/LANGUAGE.md#replace-root-via--expr).
- **Materialised views via `$out`** — `$$$.<coll> = $$` (and `$$$$.<db>.<coll> = $$`) lower to a `$out` stage; LHS names the destination, RHS the optionally-filtered source. `$out`-must-be-last is enforced at compile time. See [docs/LANGUAGE.md → `$out`](docs/LANGUAGE.md#out-write-the-pipeline-to-a-collection).
- **Diagnostics scoped by prefix** — system source stages are method calls on the context ref whose scope they need: `$$.indexStats()` / … on the collection, `$$$$.currentOp({…})` / … on the deployment. Wrong scope is a compile-time error naming the right prefix. See [docs/LANGUAGE.md → System / diagnostic stages](docs/LANGUAGE.md#system--diagnostic-stages-indexstats-currentop-).
- **`$facet` as a named object of branches** — when every value of `$ = { … }` is a `$$` chain (a `$$.filter(<predicate>)`, chained stage calls, or a mix), the surface lowers to one `$facet` stage with each entry a named sub-pipeline. See [docs/LANGUAGE.md → $facet via `$ = { key: <$$ chain>, … }`](docs/LANGUAGE.md#facet-via---key--chain-).
- **Replace stream as JS assignment** — `$$ = <expr>` reshapes the whole stream the way `$ = <expr>` reshapes one doc: narrow (`→ $match`), switch source, or pivot onto a correlated collection. jsmql picks the lowering from the predicate shape. See [docs/LANGUAGE.md → Replace stream](docs/LANGUAGE.md#replace-stream-via--expr).
- **Pipeline stages chain too** — any aggregation stage can be a chain link on a stream: `$$.$match({ status: "shipped" }).$sort({ total: -1 }).$limit(5)` is the same pipeline as writing those three as `;`-separated statements. It interleaves with the JS chain methods (`$$.filter(p => p.score > 0).$sort({ score: -1 }).take(10)`), and it's the only way to reach the stages with **no JavaScript spelling** — `$group`, `$unwind`, `$setWindowFields`, `$bucket`, … — from a value position: `const byRegion = $$$.orders.$match({…}).$group({ _id: "$region", revenue: $sum("$total") }).$sort({ revenue: -1 }).$limit(5).map(g => …)` builds the whole `$lookup.pipeline` inline. Only real MongoDB stages are accepted; a stage after a value-producing link (`.uniq().$limit(5)`) is a compile-time error. See [docs/LANGUAGE.md → Chained form](docs/LANGUAGE.md#chained-form-stage-on-a-stream).
- **Stream methods chain on the RHS** — after the `$$` / `$$$.<coll>` receiver (optionally `.filter(p)`), chain JS-array and lodash-style methods — `.map` / `.filter` / `.flatMap` / `.slice` / `.concat` plus a lodash vocabulary (`.sort`, `.take`, `.drop`, `.groupBy`, `.countBy`, `.uniqBy`, `.sample`, `.sampleSize`, … the `STREAM_METHODS` registry in `src/stream-methods.ts` is the live list) — and each appends stages. Lodash iteratee shorthands work too: `.map("userId")`, `.filter({ status: "CLOSED" })`, `.groupBy({ _id: "$dept", n: $sum(1) })`. For a bare `$$` receiver the `$$ =` head is optional. See [docs/LANGUAGE.md → Stream methods](docs/LANGUAGE.md#stream-methods-chained-after-the-rhs).
- **JS mutators mutate at statement position** — `$.events.sort(e => e.t)`, `.push(x)`, `.reverse()`, `.splice(...)`, … desugar to a `$set` that reassigns the field; the `.toSorted` / `.toReversed` / `.with` family stays immutable. `Object.assign(target, ...sources)` is the object equivalent — at statement position it merges into its target (a `$.field` or an in-scope `let`/`const` binding, even a `const`), mirroring JS's mutating `Object.assign`. Mutators in expression position throw with the fix called out. See [docs/LANGUAGE.md → Mutators](docs/LANGUAGE.md#mutators-at-statement-position-they-mutate-the-field).
- **Conditional errors via `assert`** — `assert(condition[, message])` is a pipeline guard clause: when the condition fails the whole operation aborts with a server error carrying your message (`Unknown type name: jsmql assertion failed: …`). It lowers to a portable `$match`+`$convert` shape — no deprecated server-side JS (`$function`), so it works under the Stable API and on every Atlas tier. Statement-only; expression-position uses throw with a hint. See [docs/LANGUAGE.md → `assert`](docs/LANGUAGE.md#assert-fail-the-pipeline-when-an-invariant-breaks).
- **Stream count as `$$.length`** — `$$.length` is the current stream's document count, usable as a value anywhere (`$.n = $$.length`, `assert($$.length <= 1, …)`, arithmetic). It materialises a `$setWindowFields` `$count` once, reuses it, and recomputes after a count-changing stage (`$match`/`$group`/`$unwind`/…). Pipeline-only. See [docs/LANGUAGE.md → `$$.length`](docs/LANGUAGE.md#length).
- **Three call shapes** — arrow `jsmql(({ $ }) => …)`, string `jsmql("…")`, and template tag `` jsmql`…${val}…` `` for embedding outer-scope values.
- **Polymorphic by default, strict on demand** — `jsmql()` picks Filter or Pipeline from the input; `jsmql.filter()`, `jsmql.pipeline()`, and `jsmql.update()` lock it to one shape and throw an actionable error otherwise (with the offending stage named, for `update()`). `jsmql.compile(fn)` parses once for parameterised parse-once-bind-many — and each strict entry has a shape-locked `.compile` (`jsmql.filter.compile`, `jsmql.pipeline.compile`, `jsmql.update.compile`). `jsmql.expr()` returns the raw aggregation expression that drops into a stage body. The three call shapes (string / arrow / template tag) apply to all of them.
- **lodash value methods** — the aggregation-shaped ops native JS lacks a spelling for, as per-doc field methods, covering the lodash Array + Collection vocabulary that maps cleanly to MQL: `$.items.groupBy("type")`, `$.items.take(3)` / `.drop(3)` / `.chunk(3)`, `$.a.without(0)` / `.xor($.b)` / `.differenceBy($.b, "id")`, `$.a.sortBy("age")` / `.orderBy(["age"], ["desc"])`, `$.a.zip($.b)`, `$.a.takeWhile(x => x > 0)`, `$.a.sample()`, `$.nums.sum()`, `$.user.pick(["name", "age"])`, `$.o.mapValues(v => v * 2)`, `$.n.clamp(0, 100)`, `$.name.capitalize()`, … (iteratee-taking ones accept a `"field"` string or an arrow). String methods are ASCII-only. See [docs/LANGUAGE.md](docs/LANGUAGE.md).
- **`@koresar/jsmql/ops`** — a pure-types side-effect import that adds ambient `$match` / `$dateAdd` / … globals. Zero runtime cost; bundlers tree-shake it to nothing.
- **Pre-flight validation** — jsmql rejects the pipeline mistakes the MongoDB server would otherwise reject, at compile time: stage placement (`$out`/`$merge` must be last, `$collStats`/`$geoNear`/`$changeStream` and friends must be first, stages forbidden inside `$facet`/`$lookup`/`$unionWith`), stage-body shape (literal type/range/enum/required-key/mutual-exclusivity rules — `$limit(-5)`, `$count('')`, `$group("externalId")`, `$project` mixing include/exclude, `$bucket` boundaries out of order, a `$merge` `whenMatched` typo), `$match` query placement (`$text` must be first; `$near`/`$where` aren't allowed), operator arguments (operand count — `$divide(6, 2, 1)`; required & unknown object keys — `$dateAdd({ startdate })` → "Did you mean 'startDate'?"; enum slots — `unit`/`$convert.to`/regex flags; literal types — `$year("2020")`, `$abs("x")`), and **method chains that can't type-check** (`.every(p).map(f)` — a boolean has no methods; `s.toUpperCase().map(f)` — a string isn't an array; `a.countBy("t").take(3)` — an object isn't an array; `$$$.orders.find(p).take(5)` — `.find` returns one document). Only 100%-certain violations throw — a value jsmql can't evaluate (`$limit($.n)`, `$year($.d)`), a receiver whose type is uncertain (`arr.find(p).map(f)` — the element could be an array), or a deployment-dependent rule (sharding, memory limits, Atlas availability) still emits MQL. See [docs/LANGUAGE.md → Mistakes caught at compile time](docs/LANGUAGE.md#mistakes-caught-at-compile-time).
- **Actionable errors** — every error names the construct, suggests the nearest valid name (`Did you mean '…'?`), and carries a real `.pos` so editors can underline the offending region.
- **Strict TS, strippable source** — runs as-is on Node 22.18+ / 24.3+, Deno, and Bun (no flags, no transpile).
- **`jsmql` on the command line** — a `jq`-style bin: JSMQL on stdin, MQL JSON on stdout. `echo '$.age > 18' | jsmql`. Opt-in `--filter` / `--pipeline` / `--expr` / `--update` / `--validate`, `--compact`, and jq-style `--arg` / `--argjson` for parameterised arrows. See [Command line](#command-line-jsmql).

## Using jsmql with mongoose

A one-shot registration patches the `Model` static methods so the standard `find / updateOne / aggregate / …` calls accept jsmql source directly, alongside the plain MQL-JSON forms you already pass them:

```js
const mongoose = require("mongoose");
require("@koresar/jsmql/mongoose")(mongoose);
// or, ESM: import jsmqlMongoose from "@koresar/jsmql/mongoose"; jsmqlMongoose(mongoose);

const User = mongoose.model("User", new mongoose.Schema({ name: String, age: Number, score: Number }));

User.find("$.age > 18");                            // → find({ age: { $gt: 18 } })
User.find(({ $ }) => $.age > 18 && $.region === "AU"); // → find({ age: { $gt: 18 }, region: "AU" })

User.updateMany({}, ({ $ }) => $.score += 1);
// → updateMany({}, [{ $set: { score: { $add: ["$score", 1] } } }])

User.aggregate(({ $ }) => {
  $match($.status === "active");
  $group({ _id: $.region, total: { $sum: $.amount } });
  $sort({ total: -1 });
});

User.find({ age: { $gt: 18 } });                    // plain MQL JSON still passes through untouched
```

**Detection rule.** A patched argument is treated as jsmql source only when it's a **string** or a **function**. Plain objects/arrays (the regular MQL JSON forms) pass through to mongoose unchanged, so existing call sites need no migration. Template-tag inputs (`jsmql\`…\``) lower to an object at the user's call site, so they take the pass-through path too.

**TypeScript.** The plugin ships a `declare module "mongoose"` augmentation that adds JSMQL-shaped overloads (`string | JsmqlFn`) to every patched `Model` static, so `User.find("$.age > 18")` and `User.aggregate(({ $ }) => …)` type-check after `import "@koresar/jsmql/mongoose"` — no per-call cast required. Mongoose's own `FilterQuery<T>` / `UpdateQuery<T>` overloads still apply on the MQL-JSON pass-through path.

**Patched methods** (with the slot used): `find` / `findOne` / `findOneAnd{Delete,Replace,Update}` / `countDocuments` / `deleteOne` / `deleteMany` / `replaceOne` / `exists` (filter at 0), `updateOne` / `updateMany` / `findOneAndUpdate` / `findByIdAndUpdate` (update at 1), `distinct` (filter at 1), `aggregate` (pipeline at 0). Each slot lowers through the matching strict-shape entry (`jsmql.filter` / `jsmql.update` / `jsmql.pipeline`), so a wrong-shape input — e.g. a bare expression at an `aggregate` slot — throws with the actionable strict-mode error at the patched call site instead of silently going wrong server-side. Registering twice on the same `mongoose` is a no-op.

See [docs/specs/mongoose-plugin.md](docs/specs/mongoose-plugin.md) for the full per-slot table, the methods that are deliberately *not* patched (e.g. `findOneAndReplace`'s replacement document), and the idempotence / subclass-propagation contracts.

## Command line (`jsmql`)

Installing the package puts a `jsmql` command on your `PATH`. It works like `jq`: **JSMQL source on stdin, MQL JSON on stdout** (a positional argument or `--file <path>` also work as the source).

```sh
echo '$.age > 18' | jsmql
# {
#   "age": { "$gt": 18 }
# }

echo '$match($.age > 18); $sort({ age: -1 })' | jsmql --pipeline -c
# [{"$match":{"age":{"$gt":18}}},{"$sort":{"age":-1}}]

jsmql --expr '$.price * (1 - $.discount)'
# { "$multiply": ["$price", { "$subtract": [1, "$discount"] }] }
```

With no flag the output shape is picked the same way `jsmql()` picks it (a top-level `;` makes it a Pipeline). The strict flags lock the shape and inherit the library's actionable errors:

| Flag | Shape | Library entry |
| --- | --- | --- |
| *(none)* | Filter or Pipeline | `jsmql()` |
| `--filter` | Filter document | `jsmql.filter()` |
| `--pipeline` | stage array | `jsmql.pipeline()` |
| `--expr` | aggregation expression | `jsmql.expr()` |
| `--update` | update pipeline | `jsmql.update()` |
| `--validate` (`--check`) | `{ valid, errors }`; exit 1 if invalid | `jsmql.validate()` |

Formatting is pretty 2-space by default (like `jq`); use `-c`/`--compact`, `--tab`, or `--indent N`. Parameterise a query with jq's own flags — the source must then be a parameterised arrow:

```sh
echo '({ minAge }, { $ }) => $.age > minAge' | jsmql --argjson minAge 18
# { "age": { "$gt": 18 } }
```

`--arg name value` binds a string; `--argjson name value` binds a JSON value. Params combine with any shape flag (`--pipeline --argjson minAge 18` binds and enforces the Pipeline shape) and with `--validate`. Errors print compiler-style with a caret at the offending position; exit codes are `0` success, `1` compile error / invalid, `2` usage error. `jsmql --help` lists everything. Full reference: [docs/specs/cli.md](docs/specs/cli.md).

## Try it & learn more

- **[jsmql.js.org](https://jsmql.js.org)** — the project site: what JSMQL is, how it compiles, and where to go next. Every MQL document on it is compiled in your browser by the same bundle npm ships.
- **[Live playground](https://jsmql.js.org/playground.html)** — write jsmql, see the MQL JSON update live. Pre-loaded with real-world recipes: tiered discounts, slug generation, audit logs, pivot tables, parameterised reports, and more.
- **[docs/LANGUAGE.md](docs/LANGUAGE.md)** — the full language reference: every operator, every method, update-filter rules, `$match` query translation, `jsmql.compile` parameter semantics, `jsmql.expr` for raw aggregation expressions, the strict-shape entry points (`jsmql.filter` / `jsmql.pipeline` / `jsmql.update`), the `@koresar/jsmql/ops` import, error catalogue, server-side-JS migration guide.
- **[docs/DEVLOG.md](docs/DEVLOG.md)** — the running record of language decisions and the reasoning behind them.

## License

MIT
