# jsmql

**Write MongoDB aggregation queries in JavaScript.** A strict JS subset that compiles to MQL JSON — like SQL but for MongoDB, using the syntax you already know.

```js
import { jsmql } from "@koresar/jsmql";

// Filter — for db.coll.find(filter). No `;` at top level.
const age = 18;
let filter = jsmql`$.age > ${age} && $.status === "active"`
// → { age: { $gt: 18 }, status: "active" }   ← index-friendly query doc

// Pipeline — for db.coll.aggregate(pipeline). Any `;` flips to stage mode.
// Snapshot one user, then pivot the stream onto their 5 most-recent orders.
let pipeline = jsmql`
  $$ = $$.filter(u => u.email === "me@example.com").slice(0, 1);
  let userId = $._id;
  $$ = $$$$.archive.orders
    .filter(o => o.userId === userId)
    .toSorted((a, b) => a.placedAt - b.placedAt)
    .toReversed()
    .slice(0, 5);
`;
// → [
//   { $match: { email: "me@example.com" } },
//   { $limit: 1 },
//   { $set: { "__jsmql.userId": "$_id" } },
//   { $lookup: { from: { db: "archive", coll: "orders" }, let: { userId: "$__jsmql.userId" }, pipeline: [
//       { $match: { $expr: { $eq: ["$userId", "$$userId"] } } },
//       { $sort: { placedAt: -1 } },
//       { $limit: 5 },
//   ], as: "__jsmql.__lookup1" } },
//   { $unwind: "$__jsmql.__lookup1" },
//   { $replaceWith: "$__jsmql.__lookup1" },
//   { $unset: "__jsmql" }
// ]

// Raw expression — for inside a stage body, or db.coll.updateOne(filter, update).
let expr = jsmql.expr(($) => $.items.map((i) => i.price * i.qty).reduce((a, x) => a + x, 0))
// → { $reduce: { input: { $map: { input: "$items", as: "i",
//     in: { $multiply: ["$$i.price", "$$i.qty"] } } },
//   initialValue: 0, in: { $add: ["$$value", "$$this"] } } }
```

**MongoDB 8.0 deprecated server-side JavaScript via `$function`, `$accumulator`, and `$where`.** The JSMQL is the replacement: native MQL, no `--noscripting` issues, index-friendly, IDE-aware, testable as plain JS.

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
jsmql(($) => $.email === $.email.trim().toLowerCase().endsWith("@flash-payments.com"))
// → {"$expr":{"$eq":["$email",{"$eq":[{"$substrCP":[{"$toLower":{"$trim":{"input":"$email"}}},{"$subtract":[{"$strLenCP":{"$toLower":{"$trim":{"input":"$email"}}}},{"$strLenCP":"@flash-payments.com"}]},{"$strLenCP":"@flash-payments.com"}]},"@flash-payments.com"]}]}}

// Pipelines — any `;` flips to stage mode (the array db.coll.aggregate(pipeline) takes).
jsmql(($) => {
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

// Template-tag — interpolate runtime literals from outer scope
const ids = [1, 2, 3];
jsmql`$.status === "open" && $.id in ${ids}`
// → { "status": "open", "$expr": { "$in": ["$id", [1, 2, 3]] } }

// jsmql.compile — parse once, bind many. Output stays index-friendly.
const eligible = jsmql.compile(({ minAge, region }, $) => {
  $match($.age >= minAge && $.region === region);
  $project({ age: 1, email: 1, address: 1 });
});
eligible({ minAge: 21, region: "AU" });
// → [{"$match":{"age":{"$gte":21},"region":"AU"}},{"$project":{"age":1,"email":1,"address":1}}]

// JS-natural `=`, `+=`, `delete` compile to coalesced $set / $unset
jsmql(($) => {
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

// Multi-facet aggregation — every value a `$$.filter(...)` lowers to one $facet stage
jsmql(`$ = {
  topByScore: $$.filter(o => { $sort({ score: -1 }); $limit(10); }),
  recent:     $$.filter(o => o.createdAt >= "2026-01-01"),
  byStatus:   $$.filter(o => { $group({ _id: o.status, n: $sum(1) }); })
}`);
// → [{ "$facet": {
//       "topByScore": [{ "$sort": { "score": -1 } }, { "$limit": 10 }],
//       "recent":     [{ "$match": { "createdAt": { "$gte": "2026-01-01" } } }],
//       "byStatus":   [{ "$group": { "_id": "$status", "n": { "$sum": 1 } } }]
//   } }]

// Top 10 users by revenue: $group the orders, then sort descending and take the first 10.
// The `$$ = $$.toSorted(...).slice(...)` chain lowers to $sort + $limit.
jsmql(`
$group({ _id: $.userId, revenue: $sum($.total), orders: $sum(1) });
$$ = $$.toSorted((a, b) => b.revenue - a.revenue).slice(0, 10);
`);
// [
//     { "$group": { "_id": "$userId", "revenue": { "$sum": "$total" }, "orders": { "$sum": 1 } } },
//     { "$sort": { "revenue": -1 } },
//     { "$limit": 10 }
// ]

// `jsmql()` returns an UpdateFilter as a pipeline, to avoid common footgun of wiping out the whole collection.
db.users.updateMany({}, jsmql(($) => $.name = $.name.toUpperCase()))
// → [{ "$set": { "name": { "$toUpper": "$name" } } }] -> will upper-case all names in the collection

// `jsmql.expr()` returns a partial MQL JSON. Won't protect from the same footgun.
db.users.updateMany({}, jsmql.expr(($) => $.name = $.name.toUpperCase()))
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
const stage = { $addFields: { discount: jsmql.expr(($) => $.price * (1 - $.loyalty.multiplier)) } }
// → { $addFields: { discount: { $multiply: ["$price", { $subtract: [1, "$loyalty.multiplier"] }] } } }

// Escape hatch — call any MongoDB operator as a function - $dateTrunc in this case
jsmql.expr(($) => $set({ createdAtWeek: $dateTrunc({ date: $.createdAt, unit: "week" }) }))
// → { $set: { "createdAtWeek": { "$dateTrunc": { "date": "$createdAt", "unit": "week" } } } }

jsmql(($) => $.age = 18); // generates a pipeline, to make sure you can use this in updateOne(), updateMany(), etc
// → [{ "$set": { "age": 18 } }]
jsmql.expr(($) => $.age = 18); // generates an partial expression, to use within OTHER aggregation or filter expressions
// → { "$set": { "age": 18 }

// Validate without throwing — every error carries { message, pos, code }
jsmql.validate(($) => $.age > 18)
// → { valid: true, errors: [] }
```

The **[live playground](https://flash-oss.github.io/jsmql/playground.html)** is the best place to see dozens of other JSMQL examples.

## Why the arrow form

The arrow function is **never executed** — jsmql() calls `Function.prototype.toString()` on it, strips the parameter list, and parses the body. That single trick gives you:

- **Formatting for free.** Prettier, oxfmt, and every other JS formatter indent and line-break your query like any other JavaScript. No jsmql plugin, no custom config.
- **Linting for free.** ESLint, Biome, and your editor's TypeScript service see real JS — they flag typos, unused identifiers, and shape mismatches at write time.
- **Code completion.** With `import "@koresar/jsmql/ops"`, your IDE autocompletes every stage and operator name, suggests the argument keys from the official MongoDB MQL spec, and surfaces the operator's description on hover. It also declares the `$$` / `$$$` / `$$$$` context-ref prefixes — so arrow-form code using them type-checks, with full completion and annotated option objects for the diagnostic source stages (`$$.collStats({…})`, `$$$$.currentOp({…})`, …).
- **AI coding works out of the box.** Copilot, Cursor, and Claude already know JavaScript — they autocomplete jsmql idiomatically because jsmql *is* JavaScript. There is no new vocabulary for them to learn.
- **Pre-compilation.** jsmql.compile() parses once, executes many times.

## Highlights

- **JS you already know** — operators, ternaries, template literals, optional chaining, spread, computed keys, numeric separators, `Math.*`, `Date`, `typeof`, `instanceof`, comments. If `node --check` accepts it, jsmql does too.
- **182 operators, full coverage** — every aggregation expression and accumulator from the official MongoDB MQL spec, including Bitwise and Window categories. Unknown operators pass through, so new MongoDB releases work day one.
- **Plain MQL passes through.** Drop hand-written MQL JSON inline — `{ $gt: ["$age", 18] }`, a whole stage, a whole pipeline — and jsmql compiles it to itself. Mix the two freely, migrate one expression at a time, or paste verbatim from the MongoDB docs.
- **Filter vs Pipeline picked automatically** — a stage call (`$match(...)`, `$project(...)`, …), an update op (`$.x = …`), or a statement-position array mutator (`$.tags.sort()`, `$.events.reverse()`) at the top level lowers as a `Pipeline` (`db.coll.aggregate(pipeline)` / `db.coll.updateOne(filter, update)`); any `;`-separated input lowers as a multi-stage Pipeline; everything else lowers as a `Filter` (`db.coll.find(filter)`). Index-safe predicates translate to query-document form so existing indexes still get used.
- **Joins as JS** — `$$$.<coll>.find(pred)` / `$$$.<coll>.filter(pred)` lower to `$lookup` stages. `.find()` follows JS semantics — returns one doc or null; `.filter()` keeps the array. Chained `.length`, `.reduce(fn, init)`, and member access compose inline. Block-body lambdas (`o => { $match(...); $sort(...); $limit(N); }`) become the full sub-pipeline body. `$$$$.<db>.<coll>.find/filter(pred)` covers cross-database joins (requires Atlas Data Federation). Indexes still get used when the predicate is a simple field-to-field equality. See [docs/LANGUAGE.md → Cross-collection lookups](docs/LANGUAGE.md#cross-collection-lookups-coll-find--filter).
- **Collection unions as `Array.push`** — `$$.push({...}, ...$$$.<coll>.filter(pred), $$$.<other>.find(pred))` lowers to `$unionWith` stages. The spread (`...`) rule is JS-faithful: `.filter` and bare collections are arrays so they must be spread; `.find` and inline objects are scalars so they must not. `$$$$.<db>.<coll>` works for cross-database union (same Atlas caveat as cross-DB lookups). See [docs/LANGUAGE.md → Collection union](docs/LANGUAGE.md#collection-union-push).
- **Replace root as JS assignment** — `$ = <expr>` lowers to `$replaceWith`: lift a sub-document (`$ = $.profile`), merge fresh fields (`$ = { ...$, score: ... }` — bare `$` is the current document, like MQL's `$$ROOT`), or pivot to a joined doc (`$ = $$$.users.find(pred)`). If the RHS clearly isn't a document (array literal, scalar, `.filter()` lookup), you get a compile-time error pointing at the fix. See [docs/LANGUAGE.md → Replace root via `$ = <expr>`](docs/LANGUAGE.md#replace-root-via--expr).
- **Materialised views via `$out`** — `$$$.<coll> = $$` and `$$$$.<db>.<coll> = $$` lower to a `$out` stage: the LHS names the destination, the RHS names the (optionally filtered) source. An inline `$$.filter(<predicate>)` on the RHS emits a `$match` before the write (`$$$$.dw.archive = $$.filter(u => !u.active)` → `[{ $match: … }, { $out: { db: "dw", coll: "archive" } }]`). Bracket form (`$$$["my-coll.v2"] = $$`) addresses collection names that aren't valid JS identifiers. The compiler enforces "`$out` must be last" at compile time. See [docs/LANGUAGE.md → `$out`](docs/LANGUAGE.md#out-write-the-pipeline-to-a-collection).
- **Diagnostics scoped by prefix** — MongoDB's system source stages are method calls on the context ref whose scope they require: `$$.indexStats()` / `$$.collStats({…})` / `$$.planCacheStats()` / `$$.listSearchIndexes({…})` run on the collection (`db.coll.aggregate()`); `$$$$.currentOp({…})` / `$$$$.listSessions({…})` / `$$$$.listLocalSessions({…})` / `$$$$.listSampledQueries({…})` / `$$$$.shardedDataDistribution()` run on the deployment (admin DB). Each lowers to its `$`-stage as the pipeline's first stage; using one at the wrong scope is a compile-time error that names the right prefix. See [docs/LANGUAGE.md → System / diagnostic stages](docs/LANGUAGE.md#system--diagnostic-stages-indexstats-currentop-).
- **`$facet` as a named object of filters** — when every value of `$ = { … }` is a `$$.filter(<lambda>)`, the same surface lowers to one `$facet` stage with each entry as a named sub-pipeline. Inside each lambda, the param is the input document (use `o.<field>`, not `$.<field>`); use an expression body for a simple predicate or a block body to run a full pipeline of stages. See [docs/LANGUAGE.md → $facet via `$ = { key: $$.filter(p), … }`](docs/LANGUAGE.md#facet-via---key-filterp-).
- **Replace stream as JS assignment** — `$$ = <expr>` reshapes the whole document stream the same way `$ = <expr>` reshapes one document. Narrow it (`$$ = $$.filter(t => t.client === 156)` → `$match`), switch source to another collection (`$$ = $$$.archive.filter(p)` → `$match` + `$unionWith`), or pivot each input doc onto a correlated collection (`$$ = $$$.orders.filter(o => o.userId === $._id)` → `$lookup` + `$unwind` + `$replaceWith`). jsmql picks the lowering from the predicate shape: a predicate that references an outer field auto-selects `$lookup`, the only stage that can thread an outer-doc snapshot into its sub-pipeline (`$unionWith` has no `let:`). Outer `let` bindings hoist into `$lookup.let` automatically. See [docs/LANGUAGE.md → Replace stream](docs/LANGUAGE.md#replace-stream-via--expr).
- **Stream methods chain on the RHS** — after the `$$` / `$$$.<coll>` receiver (optionally `.filter(p)`), chain JS array methods and each appends stages: `.slice(start, end?)` → `$skip` / `$limit`, `.toSorted((a, b) => …)` → `$sort`, `.toReversed()` flips the preceding sort, `.map(d => …)` → `$replaceWith`, `.flatMap(d => d.path)` → `$unwind`, `.concat(...)` → `$unionWith`. A `reduce` whose seed is `[]` already returns a stream, so it assigns directly — `$$ = $$.reduce((acc, d) => acc.concat(d.contactDetails), [])` → `$replaceWith` (fold-to-summary uses the `$$ = [{ total: $$.reduce(…) }]` form → `$group`). For a bare `$$` receiver the `$$ =` head is optional — `$$.filter(o => o.tier === "gold").map(d => ({ id: d._id }));` works as a plain statement, identical to (and splittable into) the assignment form. See [docs/LANGUAGE.md → Stream methods](docs/LANGUAGE.md#stream-methods-chained-after-the-rhs).
- **JS array mutators mutate at statement position** — `$.events.sort(e => e.t)`, `$.events.push(x)`, `$.events.pop()`, `.shift()`, `.unshift(...)`, `.reverse()`, `.splice(...)`, `.fill(...)` desugar to a `$set` stage that reassigns the field. `.toSorted()`, `.toReversed()`, `.toSpliced(...)`, `.with(...)` keep returning a new array. Sort key functions (`.toSorted(e => e.distance)`, `.toSorted(e => -e.distance)`) lower to MongoDB's `sortBy: { path: ±1 }` shape — including nested paths. Mutators in expression position throw with both the immutable variant and the statement-position option called out. See [docs/LANGUAGE.md → Mutators](docs/LANGUAGE.md#mutators-at-statement-position-they-mutate-the-field).
- **Three call shapes** — arrow `jsmql(($) => …)`, string `jsmql("…")`, and template tag `` jsmql`…${val}…` `` for embedding outer-scope values.
- **Polymorphic by default, strict on demand** — `jsmql()` picks Filter or Pipeline from the input; `jsmql.filter()`, `jsmql.pipeline()`, and `jsmql.update()` lock it to one shape and throw an actionable error otherwise (with the offending stage named, for `update()`). `jsmql.compile(fn)` parses once for parameterised parse-once-bind-many. `jsmql.expr()` returns the raw aggregation expression that drops into a stage body. The three call shapes (string / arrow / template tag) apply to all of them.
- **`@koresar/jsmql/ops`** — a pure-types side-effect import that adds ambient `$match` / `$dateAdd` / … globals. Zero runtime cost; bundlers tree-shake it to nothing.
- **Pre-flight validation** — jsmql rejects the pipeline mistakes the MongoDB server would otherwise reject, at compile time: stage placement (`$out`/`$merge` must be last, `$collStats`/`$geoNear`/`$changeStream` and friends must be first, stages forbidden inside `$facet`/`$lookup`/`$unionWith`), stage-body shape (literal type/range/enum/required-key/mutual-exclusivity rules — `$limit(-5)`, `$count('')`, `$project` mixing include/exclude, `$bucket` boundaries out of order, a `$merge` `whenMatched` typo), and `$match` query placement (`$text` must be first; `$near`/`$where` aren't allowed). Only 100%-certain violations throw — a value jsmql can't evaluate (`$limit($.n)`) or a deployment-dependent rule (sharding, memory limits, Atlas availability) still emits MQL. See [docs/LANGUAGE.md → Mistakes caught at compile time](docs/LANGUAGE.md#mistakes-caught-at-compile-time).
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
User.find(($) => $.age > 18 && $.region === "AU"); // → find({ age: { $gt: 18 }, region: "AU" })

User.updateMany({}, ($) => $.score += 1);
// → updateMany({}, [{ $set: { score: { $add: ["$score", 1] } } }])

User.aggregate(($) => {
  $match($.status === "active");
  $group({ _id: $.region, total: { $sum: $.amount } });
  $sort({ total: -1 });
});

User.find({ age: { $gt: 18 } });                    // plain MQL JSON still passes through untouched
```

**Detection rule.** A patched argument is treated as jsmql source only when it's a **string** or a **function**. Plain objects/arrays (the regular MQL JSON forms) pass through to mongoose unchanged, so existing call sites need no migration. Template-tag inputs (`jsmql\`…\``) lower to an object at the user's call site, so they take the pass-through path too.

**TypeScript.** The plugin ships a `declare module "mongoose"` augmentation that adds JSMQL-shaped overloads (`string | JsmqlFn`) to every patched `Model` static, so `User.find("$.age > 18")` and `User.aggregate(($) => …)` type-check after `import "@koresar/jsmql/mongoose"` — no per-call cast required. Mongoose's own `FilterQuery<T>` / `UpdateQuery<T>` overloads still apply on the MQL-JSON pass-through path.

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
echo '({ minAge }, $) => $.age > minAge' | jsmql --argjson minAge 18
# { "age": { "$gt": 18 } }
```

`--arg name value` binds a string; `--argjson name value` binds a JSON value. Errors print compiler-style with a caret at the offending position; exit codes are `0` success, `1` compile error / invalid, `2` usage error. `jsmql --help` lists everything. Full reference: [docs/specs/cli.md](docs/specs/cli.md).

## Try it & learn more

- **[Live playground](https://flash-oss.github.io/jsmql/playground.html)** — write jsmql, see the MQL JSON update live. Pre-loaded with real-world recipes: tiered discounts, slug generation, audit logs, pivot tables, parameterised reports, and more.
- **[docs/LANGUAGE.md](docs/LANGUAGE.md)** — the full language reference: every operator, every method, update-filter rules, `$match` query translation, `jsmql.compile` parameter semantics, `jsmql.expr` for raw aggregation expressions, the strict-shape entry points (`jsmql.filter` / `jsmql.pipeline` / `jsmql.update`), the `@koresar/jsmql/ops` import, error catalogue, server-side-JS migration guide.
- **[docs/DEVLOG.md](docs/DEVLOG.md)** — the running record of language decisions and the reasoning behind them.

## License

MIT
