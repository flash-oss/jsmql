# jsmql

**Write MongoDB aggregation queries in JavaScript.** A strict JS subset that compiles to MQL JSON — like SQL but for MongoDB, using the syntax you already know.

```js
import { jsmql } from "@koresar/jsmql";

const age = 18;
let mqlJson = jsmql`$.age > ${age} && $.status === "active"`
// → { $and: [{ $gt: ["$age", 18] }, { $eq: ["$status", "active"] }] }

mqlJson = 
    jsmql(($) => $.items.map((i) => i.price * i.qty).reduce((a, x) => a + x, 0))
// → { $reduce: { input: { $map: { input: "$items", as: "i",
//     in: { $multiply: ["$$i.price", "$$i.qty"] } } },
//   initialValue: 0, in: { $add: ["$$value", "$$this"] } } }

mqlJson = jsmql(({$}) => {
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

// Arrow form — your formatter handles long expressions
jsmql(($) => $.email.trim().toLowerCase().endsWith("@flash-payments.com"))

// Pipelines — write stages as a sequence, separated by `;`
jsmql(($) => {
  $match($.age >= 18 && $.region === "AU");      // → query doc, indexes still work
  $group({ _id: $.shopId, total: { $sum: $.amount } });
  $sort({ total: -1 });
});

// Optional chaining is a real safety annotation, not a syntactic hint:
jsmql('[...$.mods, ...$.room?.mods, "root"].includes($.userId)')
// compiles with $ifNull wrappers exactly where a null would crash a downstream operator.

// Template-tag — interpolate runtime literals from outer scope
const ids = [1, 2, 3];
jsmql`$.status === "open" && $.id in ${ids}`

// jsmql.compile — parse once, bind many. Output stays index-friendly.
const eligible = jsmql.compile(({ minAge, region }, $) => {
  $match($.age >= minAge && $.region === region);
  $project({ age: 1, email: 1, address: 1 });
});
eligible({ minAge: 21, region: "AU" });
// → [{ $match: { age: { $gte: 21 }, region: "AU" } }]

// Mutations — JS-natural `=`, `+=`, `delete` compile to coalesced $set / $unset
jsmql(($) => {
  $.score += 1;
  delete $.tempToken;
  $.status = "done";
});

// Escape hatch — call any MongoDB operator directly
jsmql(($) => $dateTrunc({ date: $.createdAt, unit: "week" }))

// Validate without throwing — every error carries { message, pos, code }
jsmql.validate(($) => $.age > 18) // → { valid: true, errors: [] }
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
- **Three call shapes** — arrow `jsmql(($) => …)`, string `jsmql("…")`, and template tag `` jsmql`…${val}…` `` for embedding outer-scope values.
- **`jsmql/ops`** — a pure-types side-effect import that adds ambient `$match` / `$dateAdd` / … globals. Zero runtime cost; bundlers tree-shake it to nothing.
- **Actionable errors** — every error names the construct, suggests the nearest valid name (`Did you mean '…'?`), and carries a real `.pos` so editors can underline the offending region.
- **`$match` indexes by default** — index-safe predicates translate to query-document form; only the untranslatable parts fall back to `$expr`.
- **Strict TS, strippable source** — runs as-is on Node 24+, Deno, and Bun (no flags, no transpile).

## Try it & learn more

- **[Live playground](https://flash-oss.github.io/jsmql/playground.html)** — write jsmql, see the MQL JSON update live. Pre-loaded with real-world recipes: tiered discounts, slug generation, audit logs, pivot tables, parameterised reports, and more.
- **[docs/LANGUAGE.md](docs/LANGUAGE.md)** — the full language reference: every operator, every method, mutation rules, `$match` query translation, `jsmql.compile` parameter semantics, the `jsmql/ops` import, error catalogue, server-side-JS migration guide.
- **[docs/DEVLOG.md](docs/DEVLOG.md)** — the running record of language decisions and the reasoning behind them.

## License

MIT
