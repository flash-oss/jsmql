# jsmql

**Write MongoDB aggregation queries in JavaScript.** A strict JS subset that compiles to MQL JSON — like SQL but for MongoDB, using the syntax you already know.

```js
import { jsmql } from "@koresar/jsmql";

// Filter — for db.coll.find(filter). No `;` at top level.
const age = 18;
let filter = jsmql`$.age > ${age} && $.status === "active"`
// → { age: { $gt: 18 }, status: "active" }   ← index-friendly query doc

// Pipeline — for db.coll.aggregate(pipeline). Any `;` flips to stage mode.
let pipeline = jsmql(($) => {
    $match($.status === "active");
    let subtotal = $.price * $.qty; // sub-total before tax/shipping
    let withTax  = subtotal * 1.2; // with tax
    $project({ sku: 1, subtotal, final: withTax });
});
// → [
//     { "$match": { "status": "active" } }
//     { "$set": { "__jsmql.subtotal": { "$multiply": ["$price", "$qty"] } } },
//     { "$set": { "__jsmql.withTax": { "$multiply": ["$__jsmql.subtotal", 1.2] } } },
//     {
//         "$project": {
//             "sku": 1,
//             "subtotal": "$__jsmql.subtotal",
//             "final": "$__jsmql.withTax"
//         }
//     },
//     { "$unset": "__jsmql" }
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

// Optional chaining is a real safety annotation, not a syntactic hint:
jsmql('[...$.mods, ...$.room?.mods, "root"].includes($.userId)')
//  { "$expr": { "$in": ["$userId", { "$concatArrays": ["$mods", { "$ifNull": ["$room.mods", []] }, ["root"]] }] } }
// compiles with $ifNull wrappers exactly where a null would crash a downstream operator.

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
- **Code completion.** With `import "@koresar/jsmql/ops"`, your IDE autocompletes every stage and operator name, suggests the argument keys from the official MongoDB MQL spec, and surfaces the operator's description on hover.
- **AI coding works out of the box.** Copilot, Cursor, and Claude already know JavaScript — they autocomplete jsmql idiomatically because jsmql *is* JavaScript. There is no new vocabulary for them to learn.
- **Pre-compilation.** jsmql.compile() parses once, executes many times.

## Highlights

- **JS you already know** — operators, ternaries, template literals, optional chaining, spread, computed keys, numeric separators, `Math.*`, `Date`, `typeof`, `instanceof`, comments. If `node --check` accepts it, jsmql does too.
- **182 operators, full coverage** — every aggregation expression and accumulator from the official MongoDB MQL spec, including Bitwise and Window categories. Unknown operators pass through, so new MongoDB releases work day one.
- **Plain MQL passes through.** Drop hand-written MQL JSON inline — `{ $gt: ["$age", 18] }`, a whole stage, a whole pipeline — and jsmql compiles it to itself. Mix the two freely, migrate one expression at a time, or paste verbatim from the MongoDB docs.
- **Filter vs Pipeline picked automatically** — a stage call (`$match(...)`, `$project(...)`, …) or an update op (`$.x = …`) at the top level lowers as a `Pipeline` (`db.coll.aggregate(pipeline)` / `db.coll.updateOne(filter, update)`); any `;`-separated input lowers as a multi-stage Pipeline; everything else lowers as a `Filter` (`db.coll.find(filter)`). Index-safe predicates translate to query-document form; only the untranslatable parts ride in a top-level `$expr`. The naming follows the Node.js MongoDB driver's own `Filter<TSchema>` and `pipeline` parameter.
- **Three call shapes** — arrow `jsmql(($) => …)`, string `jsmql("…")`, and template tag `` jsmql`…${val}…` `` for embedding outer-scope values.
- **Polymorphic by default, strict on demand** — `jsmql()` picks Filter or Pipeline from the input; `jsmql.filter()`, `jsmql.pipeline()`, and `jsmql.update()` lock it to one shape and throw an actionable error otherwise (with the offending stage named, for `update()`). `jsmql.compile(fn)` parses once for parameterised parse-once-bind-many. `jsmql.expr()` returns the raw aggregation expression that drops into a stage body. The three call shapes (string / arrow / template tag) apply to all of them.
- **`@koresar/jsmql/ops`** — a pure-types side-effect import that adds ambient `$match` / `$dateAdd` / … globals. Zero runtime cost; bundlers tree-shake it to nothing.
- **Actionable errors** — every error names the construct, suggests the nearest valid name (`Did you mean '…'?`), and carries a real `.pos` so editors can underline the offending region.
- **Strict TS, strippable source** — runs as-is on Node 22.18+ / 24.3+, Deno, and Bun (no flags, no transpile).

## Try it & learn more

- **[Live playground](https://flash-oss.github.io/jsmql/playground.html)** — write jsmql, see the MQL JSON update live. Pre-loaded with real-world recipes: tiered discounts, slug generation, audit logs, pivot tables, parameterised reports, and more.
- **[docs/LANGUAGE.md](docs/LANGUAGE.md)** — the full language reference: every operator, every method, update-filter rules, `$match` query translation, `jsmql.compile` parameter semantics, `jsmql.expr` for raw aggregation expressions, the strict-shape entry points (`jsmql.filter` / `jsmql.pipeline` / `jsmql.update`), the `@koresar/jsmql/ops` import, error catalogue, server-side-JS migration guide.
- **[docs/DEVLOG.md](docs/DEVLOG.md)** — the running record of language decisions and the reasoning behind them.

## License

MIT
