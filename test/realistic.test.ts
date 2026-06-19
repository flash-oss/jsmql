/**
 * Realistic integration tests, organised by language feature.
 *
 * Each `describe()` is one playground example. Its second argument is a
 * `{ features: [...] }` metadata object that drives the playground's
 * sidebar grouping. Each `it()`'s second argument carries `{ kind, usage }`
 * — `kind` selects which entry point is used (`jsmql` for Filter / Pipeline,
 * `jsmql.expr` for raw aggregation expressions), and `usage` is the literal
 * `db.<collection>.<method>(...)` invocation shown in the playground.
 *
 * This file is referenced from README.md as a usage showcase.
 */

import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";
import { ObjectId } from "../src/objectid.ts";
import "../src/ops.ts";

// Teach TS about the playground-metadata keys (`kind`, `usage`, `features`)
// we pass as the 2nd arg to describe()/it(). Vitest already ignores unknown
// options at runtime — this declaration just stops editors from flagging.
// prettier-ignore
declare module "@vitest/runner" { interface TestOptions { kind?: string; usage?: string; features?: string[] } }

// JS-truthiness coercion jsmql emits for `&&`/`||`/ternary conditions.
const truthy = (v: unknown) => ({
  $and: [{ $ne: [{ $ifNull: [v, null] }, null] }, { $ne: [v, false] }, { $ne: [v, ""] }, { $ne: [v, 0] }],
});

describe("snapshot one user, then pivot to their 5 most-recent orders", { features: ["Pipelines"] }, () => {
  it(
    "narrow + `let` snapshot + correlated source-switch — three lines that would be ~30 of MQL",
    { kind: "pipeline", usage: "db.users.aggregate(jsmql(...))" },
    () => {
      // The "look up the logged-in user, then fetch their recent orders"
      // shape that shows up in every web app. Three jsmql statements compose:
      //   1) narrow the users stream to one matching doc ($match + $limit:1)
      //   2) snapshot their _id into a name that survives the source-switch
      //   3) pivot the stream onto that user's orders, newest-first, top 5
      // The outer `let userId` becomes a $lookup.let var on the next stage —
      // the only MQL shape that can carry outer-doc context across a source
      // switch ($unionWith has no `let:` slot). Every line is JavaScript a
      // Node developer already knows; the lowering does the MQL bookkeeping.
      expect(
        jsmql`
$$ = $$.filter(u => u.email === "me@example.com").slice(0, 1);
let userId = $._id;
$$ = $$$$.archive.orders
  .filter(o => o.userId === userId)
  .toSorted((a, b) => a.placedAt - b.placedAt)
  .toReversed()
  .slice(0, 5);
          `,
      ).toEqual([
        { $match: { email: "me@example.com" } },
        { $limit: 1 },
        { $set: { "__jsmql.var.userId": "$_id" } },
        {
          $lookup: {
            from: { db: "archive", coll: "orders" },
            let: { v0_userId: "$__jsmql.var.userId" },
            pipeline: [
              { $match: { $expr: { $eq: ["$userId", "$$v0_userId"] } } },
              { $sort: { placedAt: -1 } },
              { $limit: 5 },
            ],
            as: "__jsmql.tmp.1",
          },
        },
        { $unwind: "$__jsmql.tmp.1" },
        { $replaceWith: "$__jsmql.tmp.1" },
      ]);
    },
  );
});

describe("top-orders report by department", { features: ["Pipelines"] }, () => {
  it("compiles to the expected MQL", { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" }, () => {
    expect(
      jsmql`
$match($.status === "shipped" && $.placedAt >= new Date("2026-01-01"));
$lookup({ from: "users", localField: "userId", foreignField: "_id", as: "buyer" });
$unwind($.buyer);
$group({ _id: $.buyer.department, revenue: $sum($.total), orders: $sum(1) });
$set({ avgOrder: $.revenue / $.orders });
$sort({ revenue: -1 });
$limit(3);
      `,
    ).toEqual([
      { $match: { status: "shipped", placedAt: { $gte: new Date("2026-01-01") } } },
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "buyer" } },
      { $unwind: "$buyer" },
      { $group: { _id: "$buyer.department", revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
      { $set: { avgOrder: { $divide: ["$revenue", "$orders"] } } },
      { $sort: { revenue: -1 } },
      { $limit: 3 },
    ]);
  });
});

describe("count orders by status per shop ($accumulator replacement)", { features: ["Pipelines"] }, () => {
  it("compiles to the expected MQL", { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" }, () => {
    expect(
      jsmql`
$group({ _id: $.shopId, statuses: $push($.status) });
$project({
  counts: $.statuses.reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {})
});
      `,
    ).toEqual([
      { $group: { _id: "$shopId", statuses: { $push: "$status" } } },
      {
        $project: {
          counts: {
            $reduce: {
              input: "$statuses",
              initialValue: {},
              in: {
                $mergeObjects: [
                  "$$value",
                  {
                    $arrayToObject: [
                      [
                        {
                          k: "$$this",
                          v: { $add: [{ $ifNull: [{ $getField: { field: "$$this", input: "$$value" } }, 0] }, 1] },
                        },
                      ],
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    ]);
  });
});

describe("alternative bracketed array form", { features: ["Pipelines"] }, () => {
  it("compiles to the expected MQL", { kind: "pipeline" }, () => {
    expect(
      jsmql`
[
  $match($.status === 'pending' && $.paidAt != null),
  $.lineTotal = $.qty * $.unitPrice,
  $.invoiceCount += 1,
  delete $.tempToken,
  delete $._processingState,
  $.status = 'complete'
]
      `,
    ).toEqual([
      { $match: { status: "pending", paidAt: { $ne: null } } },
      { $set: { lineTotal: { $multiply: ["$qty", "$unitPrice"] }, invoiceCount: { $add: ["$invoiceCount", 1] } } },
      { $unset: ["tempToken", "_processingState"] },
      { $set: { status: "complete" } },
    ]);
  });
});

describe("orders summary via $facet (`$ = { k: $$.filter(...) }`)", { features: ["Pipelines"] }, () => {
  it("compiles to the expected MQL", { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" }, () => {
    // Three named sub-pipelines run side-by-side against the same input
    // stream. `$$.filter(o => ...)` is the facet entry surface: the lambda
    // param is each input document. Expression bodies lower to `$match`;
    // block bodies lower to their own stage list.
    expect(
      jsmql(`$match($.status === "shipped");
$ = {
  topByScore: $$.filter(o => { $sort({ score: -1 }); $limit(10); }),
  recent:     $$.filter(o => o.createdAt >= new Date("2026-01-01")),
  byStatus:   $$.filter(o => { $group({ _id: o.status, n: $sum(1) }); }),
};`),
    ).toEqual([
      { $match: { status: "shipped" } },
      {
        $facet: {
          topByScore: [{ $sort: { score: -1 } }, { $limit: 10 }],
          recent: [{ $match: { createdAt: { $gte: new Date("2026-01-01") } } }],
          byStatus: [{ $group: { _id: "$status", n: { $sum: 1 } } }],
        },
      },
    ]);
  });
});

describe("switch source to another collection (`$$ = $$$.<coll>.filter(...)`)", { features: ["Pipelines"] }, () => {
  it("compiles to the expected MQL", { kind: "pipeline", usage: "db.clients.aggregate(jsmql(...))" }, () => {
    // Start from `clients` but pivot the pipeline onto `transactions` filtered
    // by date and client id. `$$ = $$$.<coll>.filter(...)` lowers to a
    // `$limit: 0` (drops the current stream) followed by `$unionWith` (brings
    // in matching foreign docs). The result is the same as if the aggregation
    // had been run on `transactions` from the start, but the call site keeps
    // its original collection.
    expect(
      jsmql`$$ = $$$.transactions.filter(t => t.createdAt >= new Date("2026-01-01") && t.client === 156);`,
    ).toEqual([
      { $match: { $expr: false } },
      {
        $unionWith: {
          coll: "transactions",
          pipeline: [{ $match: { createdAt: { $gte: new Date("2026-01-01") }, client: 156 } }],
        },
      },
    ]);
  });
});

describe("narrow the current stream (`$$ = $$.filter(...)`)", { features: ["Pipelines"] }, () => {
  it("compiles to the expected MQL", { kind: "pipeline", usage: "db.transactions.aggregate(jsmql(...))" }, () => {
    // The symmetric form: source stays on `transactions`, the assignment
    // narrows the stream. Equivalent to a bare `$match(...)` — the explicit
    // `$$ = $$.filter(...)` form exists for symmetry with the source-switch
    // case above, so the two can be swapped without changing the surrounding
    // shape of the pipeline.
    expect(jsmql`$$ = $$.filter(t => t.createdAt >= new Date("2026-01-01") && t.client === 156);`).toEqual([
      { $match: { createdAt: { $gte: new Date("2026-01-01") }, client: 156 } },
    ]);
  });
});

describe("paginate + project a leaderboard via a bare stream chain", { features: ["Pipelines"] }, () => {
  it(
    "one `$$.filter(...).slice(...).map(...)` statement → $match + $skip + $limit + $replaceWith",
    { kind: "pipeline", usage: "db.scores.aggregate(jsmql(...))" },
    () => {
      // The bare-statement stream chain (no `$$ =` head): each JS array method
      // appends its stage to the running pipeline, so a single line that reads
      // like ordinary array work lowers to four MQL stages.
      //   .filter(p => …)   → $match    (narrow to this season's real scores)
      //   .slice(40, 60)    → $skip + $limit  (page 3, 20 per page)
      //   .map(p => ({…}))  → $replaceWith     (project a compact card)
      // Splitting the chain across separate `$$.filter(...); $$.slice(...); …`
      // statements — or writing it as `$$ = $$.filter(...)…` — produces the
      // exact same MQL; the chained form is just the most concise spelling.
      expect(
        jsmql`
$$.filter(p => p.season === "2026" && p.score > 0)
  .slice(40, 60)
  .map(p => ({ player: p.name, score: p.score, rank: p.rank }));
      `,
      ).toEqual([
        { $match: { season: "2026", score: { $gt: 0 } } },
        { $skip: 40 },
        { $limit: 20 },
        { $replaceWith: { player: "$name", score: "$score", rank: "$rank" } },
      ]);
    },
  );
});

describe("lift the embedded profile to the top level (`$ = …`)", { features: ["Pipelines"] }, () => {
  it("compiles to the expected MQL", { kind: "pipeline", usage: "db.users.aggregate(jsmql(...))" }, () => {
    // After a $match, replace each user doc with its `profile` sub-doc and then
    // tag on a derived score. `$ = <expr>` lowers to `$replaceWith` — MQL's
    // shorthand for `$replaceRoot: { newRoot: <expr> }`. The bare `$` inside
    // the spread refers to the document being replaced ($$ROOT in MQL).
    expect(
      jsmql`
$match($.profile != null);
$ = $.profile;
$ = { ...$, computedScore: $.points * 1.1 };
      `,
    ).toEqual([
      { $match: { profile: { $ne: null } } },
      { $replaceWith: "$profile" },
      { $replaceWith: { $mergeObjects: ["$$ROOT", { computedScore: { $multiply: ["$points", 1.1] } }] } },
    ]);
  });
});

describe("explode order line-items into per-item documents (`$ = [...]` fan-out)", { features: ["Pipelines"] }, () => {
  it("compiles to the expected MQL", { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" }, () => {
    // Flatten each paid order into one document per line item, carrying the
    // order id and a computed revenue. When the `$ = <expr>` RHS is provably an
    // array (here `.map(...)`), jsmql fans it out: materialise into a slot,
    // `$unwind`, then `$replaceWith` each element as the new root — one input
    // document becomes N output documents.
    expect(
      jsmql`
$match($.status === "paid");
$ = $.lineItems.map(li => ({ orderId: $._id, sku: li.sku, revenue: li.qty * li.price }));
      `,
    ).toEqual([
      { $match: { status: "paid" } },
      {
        $set: {
          "__jsmql.tmp.1": {
            $map: {
              input: "$lineItems",
              as: "li",
              in: { orderId: "$_id", sku: "$$li.sku", revenue: { $multiply: ["$$li.qty", "$$li.price"] } },
            },
          },
        },
      },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });
});

describe("fan out per-party risk bands (block-body arrow → nested `$let`)", { features: ["Pipelines"] }, () => {
  it("compiles to the expected MQL", { kind: "pipeline", usage: "db.transactions.aggregate(jsmql(...))" }, () => {
    // For each transaction leg, derive intermediate values with local `const`s
    // and emit one document per qualifying leg. A block-body arrow
    // `party => { const … ; return … }` lowers to a right-folded nest of `$let`
    // (one binding per `const`, in source order — so `score` can read `leg`).
    // The `? … : null` + `.filter(Boolean)` drops legs with no risk score, and
    // `$ = <array>` fans the survivors out into one document each.
    expect(
      jsmql`
$ = ["sender", "recipient"].map(party => {
  const leg = $.legs?.[party];
  const score = leg?.riskScore;
  return score ? { party, score, band: score > 50 ? "high" : "low" } : null;
}).filter(Boolean);
      `,
    ).toEqual([
      {
        $set: {
          "__jsmql.tmp.1": {
            $filter: {
              input: {
                $map: {
                  input: ["sender", "recipient"],
                  as: "party",
                  in: {
                    $let: {
                      vars: {
                        // `party` iterates a string-literal array, so it's typed
                        // `string`; `$.legs?.[party]` is then an unambiguous object
                        // getter → `$getField` directly (no `$isArray` guard). The
                        // optional-chain fallback is `{}` (the object neutral).
                        leg: { $getField: { field: "$$party", input: { $ifNull: ["$legs", {}] } } },
                      },
                      in: {
                        $let: {
                          vars: { score: "$$leg.riskScore" },
                          in: {
                            $cond: {
                              if: truthy("$$score"),
                              then: {
                                party: "$$party",
                                score: "$$score",
                                band: { $cond: { if: { $gt: ["$$score", 50] }, then: "high", else: "low" } },
                              },
                              else: null,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              as: "v",
              cond: truthy("$$v"),
            },
          },
        },
      },
      { $unwind: "$__jsmql.tmp.1" },
      { $replaceWith: "$__jsmql.tmp.1" },
    ]);
  });
});

describe("invoice finalisation pipeline", { features: ["Update filters"] }, () => {
  it("compiles to the expected MQL", { kind: "pipeline", usage: "db.invoices.aggregate(jsmql(...))" }, () => {
    expect(
      jsmql`
$match($.status === 'pending' && $.paidAt != null);
$.lineTotal = $.qty * $.unitPrice, $.invoiceCount += 1;
delete $.tempToken, delete $._processingState;
$.status = 'complete'
      `,
    ).toEqual([
      { $match: { status: "pending", paidAt: { $ne: null } } },
      { $set: { lineTotal: { $multiply: ["$qty", "$unitPrice"] }, invoiceCount: { $add: ["$invoiceCount", 1] } } },
      { $unset: ["tempToken", "_processingState"] },
      { $set: { status: "complete" } },
    ]);
  });
});

describe("uppercase a user's name via updateOne", { features: ["Update filters"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "pipeline", usage: "db.users.updateOne({ _id: 123 }, jsmql(...))" },
    () => {
      // `jsmql()` wraps the single-stage update filter as a one-element
      // aggregation pipeline. MongoDB only evaluates `$toUpper` (and other
      // aggregation expressions on the RHS) when the second `updateOne` arg
      // is an array; the bare-doc form would store the literal expression
      // object instead. See docs/specs/update-filter.md.
      expect(jsmql(`$.name = $.name.toUpperCase()`)).toEqual([{ $set: { name: { $toUpper: "$name" } } }]);
    },
  );
});

describe("keep the user's last 10 events in chronological order", { features: ["Update filters"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "pipeline", usage: "db.users.updateOne({ _id: 123 }, jsmql(...))" },
    () => {
      // Append a new event, sort the (now-extended) list by timestamp, then
      // truncate to the most recent 10. Each `;`-separated statement reads
      // a field its predecessor just wrote, so the coalescer splits into
      // three $set stages — matching the dataflow the user would write by
      // hand. Demonstrates `.push` / `.sort(keyFn)` mutating the field in
      // place, then a plain `=` reassignment for the final truncate.
      expect(
        jsmql`
$.events.push($.newEvent);
$.events.sort(e => e.timestamp);
$.events = $.events.slice(-10);
      `,
      ).toEqual([
        { $set: { events: { $concatArrays: ["$events", ["$newEvent"]] } } },
        { $set: { events: { $sortArray: { input: "$events", sortBy: { timestamp: 1 } } } } },
        // `.slice(-10)` on an unknown-type receiver dispatches at runtime —
        // the array branch produces the last 10 elements, the string branch
        // produces the last 10 codepoints. Both are correct for their type.
        {
          $set: {
            events: {
              $cond: {
                if: { $isArray: "$events" },
                then: { $slice: ["$events", -10] },
                else: { $substrCP: ["$events", { $subtract: [{ $strLenCP: "$events" }, 10] }, 10] },
              },
            },
          },
        },
      ]);
    },
  );
});

describe("stamp login activity (multi-field update)", { features: ["Update filters"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "pipeline", usage: "db.users.updateOne({ _id: 123 }, jsmql(...))" },
    () => {
      expect(jsmql(`$.loginCount += 1, $.lastSeenAt = new Date()`)).toEqual([
        { $set: { loginCount: { $add: ["$loginCount", 1] }, lastSeenAt: { $toDate: "$$NOW" } } },
      ]);
    },
  );
});

describe("order pricing with derived helpers + commentary", { features: ["Let bindings"] }, () => {
  it("compiles to the expected MQL", { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" }, () => {
    expect(
      jsmql`
let subtotal = $.price * $.qty;       // sub-total before tax/shipping
let withTax  = subtotal * 1.2;        // with tax
let withShip = withTax + $.shipping;  // with tax and shipping
$project({ sku: 1, subtotal, withTax, final: withShip });
      `,
    ).toEqual([
      { $set: { "__jsmql.var.subtotal": { $multiply: ["$price", "$qty"] } } },
      { $set: { "__jsmql.var.withTax": { $multiply: ["$__jsmql.var.subtotal", 1.2] } } },
      { $set: { "__jsmql.var.withShip": { $add: ["$__jsmql.var.withTax", "$shipping"] } } },
      {
        $project: {
          sku: 1,
          subtotal: "$__jsmql.var.subtotal",
          withTax: "$__jsmql.var.withTax",
          final: "$__jsmql.var.withShip",
        },
      },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("derive a price with a reassignable `let` helper", { features: ["Let bindings"] }, () => {
  it("compiles to the expected MQL", { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" }, () => {
    // Snapshot the order's base price into a `let`, then apply a 10% discount by
    // reassigning it — a `let` binding re-`$set`s its slot, just like
    // `let p = …; p = p * 0.9` in JavaScript. Each reassignment is its own
    // `$set` stage (read-after-write needs separate stages).
    expect(
      jsmql(`
let basePrice = $.price * $.qty;
basePrice = basePrice * 0.9;
$project({ total: basePrice });
      `),
    ).toEqual([
      { $set: { "__jsmql.var.basePrice": { $multiply: ["$price", "$qty"] } } },
      { $set: { "__jsmql.var.basePrice": { $multiply: ["$__jsmql.var.basePrice", 0.9] } } },
      { $project: { total: "$__jsmql.var.basePrice" } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("reassigning a `const` binding is rejected at compile time", { features: ["Let bindings"] }, () => {
  it(
    "a `const` snapshot can't be reassigned — the error points at `let`",
    { kind: "err", usage: "db.orders.aggregate(jsmql(...))" },
    () => {
      // `const` is a read-only binding. Snapshot the order's base price as a
      // `const`, then (mistakenly) try to discount it in place. jsmql rejects the
      // reassignment and points at the fix: declare it `let` if it must change.
      expect(() =>
        jsmql(`
const basePrice = $.price * $.qty;
basePrice = basePrice * 0.9;
$project({ total: basePrice });
        `),
      ).toThrow(/Cannot reassign `basePrice` — it is a `const` binding\. Declare it with `let basePrice = …`/);
    },
  );
});

describe("active premium subscribers", { features: ["Filters"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.subscribers.find(jsmql(...))" }, () => {
    expect(
      jsmql(`$.subscription.tier === "premium" && $.status === "active" && $.expiresAt > new Date("2026-05-01")`),
    ).toEqual({ "subscription.tier": "premium", status: "active", expiresAt: { $gt: new Date("2026-05-01") } });
  });
});

describe("recent shipped orders for a customer", { features: ["Filters"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.orders.find(jsmql(...))" }, () => {
    expect(
      jsmql`
$.customerId === "cust_42" &&
$.placedAt >= new Date("2026-01-01") && $.placedAt < new Date("2026-02-01") &&
$.status === "shipped"
      `,
    ).toEqual({
      customerId: "cust_42",
      $and: [{ placedAt: { $gte: new Date("2026-01-01") } }, { placedAt: { $lt: new Date("2026-02-01") } }],
      status: "shipped",
    });
  });
});

describe("posts pinned or by trusted author", { features: ["Filters"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.posts.find(jsmql(...))" }, () => {
    expect(jsmql(`$.pinned === true || $.author === "ada"`)).toEqual({ $or: [{ pinned: true }, { author: "ada" }] });
  });
});

describe("archivable docs (not pinned, untouched since)", { features: ["Filters"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.documents.find(jsmql(...))" }, () => {
    expect(jsmql(`$.pinned !== true && $.lastModifiedAt < new Date("2025-01-01")`)).toEqual({
      pinned: { $ne: true },
      lastModifiedAt: { $lt: new Date("2025-01-01") },
    });
  });
});

describe("in-stock products within a price range", { features: ["Filters"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.products.find(jsmql(...))" }, () => {
    expect(jsmql(`$.inStock === true && $.price >= 50 && $.price <= 200`)).toEqual({
      inStock: true,
      $and: [{ price: { $gte: 50 } }, { price: { $lte: 200 } }],
    });
  });
});

describe("users with a non-null email", { features: ["Filters"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.users.find(jsmql(...))" }, () => {
    expect(jsmql(`$.email != null && $.status === "active"`)).toEqual({ email: { $ne: null }, status: "active" });
  });
});

describe("payments since a cutoff (Date folded into query doc)", { features: ["Filters"] }, () => {
  // `new Date(<literal>)` is folded to a real JS Date at compile time, so the
  // `createdAt` index is still usable — the comparison stays at the top level
  // instead of being trapped inside an `$expr`.
  it("compiles to the expected MQL", { kind: "filter", usage: "db.payments.find(jsmql(...))" }, () => {
    expect(jsmql(`$.method === "postalDelivery" && $.createdAt >= new Date("2026-01-01")`)).toEqual({
      method: "postalDelivery",
      createdAt: { $gte: new Date("2026-01-01") },
    });
  });
});

describe("typeof check for documents with an object profile", { features: ["Filters"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.users.find(jsmql(...))" }, () => {
    expect(jsmql(`typeof $.profile === "object" && $.status === "active"`)).toEqual({
      profile: { $type: "object" },
      status: "active",
    });
  });
});

describe("lookup by `_id` and tenant", { features: ["Filters"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.documents.find(jsmql(...))" }, () => {
    expect(jsmql(`$._id === "doc_42" && $.tenantId === "acme"`)).toEqual({ _id: "doc_42", tenantId: "acme" });
  });
});

describe("fetch a document by its ObjectId", { features: ["Filters"] }, () => {
  // Query by `_id` with a constant ObjectId. The leanest form is the `0x` hex
  // literal — type `0x` and paste the 24-char id, no quotes or `ObjectId(...)`
  // wrapper. `ObjectId("…")` / `new ObjectId("…")` are equivalent. jsmql mints a
  // live BSON ObjectId (not a string, not an Extended-JSON envelope), so the
  // match uses the `_id` index directly.
  it("compiles to the expected MQL", { kind: "filter", usage: "db.documents.find(jsmql(...))" }, () => {
    expect(jsmql(`$._id === 0x507f1f77bcf86cd799439011 && $.tenantId === "acme"`)).toEqual({
      _id: new ObjectId("507f1f77bcf86cd799439011"),
      tenantId: "acme",
    });
  });
});

describe("exclude deleted and archived", { features: ["Filters"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.posts.find(jsmql(...))" }, () => {
    expect(jsmql(`$.deleted !== true && $.archived !== true`)).toEqual({
      deleted: { $ne: true },
      archived: { $ne: true },
    });
  });
});

describe("top-level posts (no parent) that are published", { features: ["Filters"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.comments.find(jsmql(...))" }, () => {
    expect(jsmql(`$.parent === null && $.published === true`)).toEqual({ parent: { $type: "null" }, published: true });
  });
});

describe("parameterised lookup via the template tag", { features: ["Filters"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.users.find(jsmql(...))" }, () => {
    expect(jsmql(`$.tier === "gold" && $.country === "AU"`)).toEqual({ tier: "gold", country: "AU" });
  });
});

describe("order eligibility for free shipping", { features: ["Comparisons and boolean logic"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.carts.find(jsmql(...))" }, () => {
    expect(
      jsmql`
$.cart.total >= 50 &&
$.customer.status in ["premium", "gold", "platinum"] &&
$.cart.items.length < 20 &&
$.customer.region.trim().toLowerCase() === "us"
      `,
    ).toEqual({
      "cart.total": { $gte: 50 },
      $expr: {
        $and: [
          { $in: ["$customer.status", ["premium", "gold", "platinum"]] },
          // `.length < N` against a natural number is a string-or-array length,
          // not a literal `cart.items.length` field — it rides in $expr.
          {
            $lt: [
              {
                $cond: {
                  if: { $isArray: "$cart.items" },
                  then: { $size: "$cart.items" },
                  else: { $strLenCP: "$cart.items" },
                },
              },
              20,
            ],
          },
          { $eq: [{ $toLower: { $trim: { input: "$customer.region" } } }, "us"] },
        ],
      },
    });
  });
});

describe(
  "rectangle area via raw bracket access (brackets = direct property access)",
  { features: ["Property access"] },
  () => {
    it(
      "compiles to the expected MQL",
      { kind: "expression", usage: "db.shapes.aggregate([{ $addFields: { area: jsmql.expr(...) } }])" },
      () => {
        // A doc like `{ cart: { field: { length: 10, width: 5 } } }` — `cart.field.length`
        // is a genuine numeric dimension, NOT an array/string length. Dot `.length`
        // would fold to the length operator, so reach the field with RAW bracket
        // access: jsmql interprets nothing inside the brackets — whatever the user
        // spells is the property they get. `$["cart.field.length"]` on the bare root
        // is a plain field reference (the root is never an array).
        expect(jsmql.expr(`$["cart.field.length"] * $.cart.field.width`)).toEqual({
          $multiply: ["$cart.field.length", "$cart.field.width"],
        });
      },
    );

    it("dynamic bracket key dispatches at runtime, still without interpreting the key", { kind: "expression" }, () => {
      // `$.cart.field[$.mainSide]` — a computed key. jsmql doesn't guess the key;
      // it accesses whatever `$mainSide` names, dispatching array-index vs
      // object-field at query time (a BSON value can be either).
      expect(jsmql.expr(`$.cart.field[$.mainSide]`)).toEqual({
        $cond: {
          if: { $isArray: "$cart.field" },
          then: { $arrayElemAt: ["$cart.field", "$mainSide"] },
          else: { $getField: { field: "$mainSide", input: "$cart.field" } },
        },
      });
    });
  },
);

describe("admin permission with operand-preserving &&", { features: ["Comparisons and boolean logic"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.users.aggregate([{ $addFields: { value: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`$.active && $.role.toLowerCase().includes("admin") && $.name.trim().length > 0`)).toEqual({
        $cond: {
          if: {
            $and: [
              { $ne: [{ $ifNull: ["$active", null] }, null] },
              { $ne: ["$active", false] },
              { $ne: ["$active", ""] },
              { $ne: ["$active", 0] },
            ],
          },
          then: {
            $and: [
              { $gte: [{ $indexOfCP: [{ $toLower: "$role" }, "admin"] }, 0] },
              { $gt: [{ $strLenCP: { $trim: { input: "$name" } } }, 0] },
            ],
          },
          else: "$active",
        },
      });
    },
  );
});

describe("tiered loyalty discount price", { features: ["Ternaries"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.orders.aggregate([{ $addFields: { loyaltyPrice: jsmql.expr(...) } }])" },
    () => {
      expect(
        jsmql.expr`
$round(
  $.price * (
    $.loyalty.years >= 5 && $.loyalty.totalSpend >= 10000 ? 0.85 :
    $.loyalty.years >= 2 ? 0.92 : 1
  ),
  2
)
      `,
      ).toEqual({
        $round: [
          {
            $multiply: [
              "$price",
              {
                $cond: {
                  if: { $and: [{ $gte: ["$loyalty.years", 5] }, { $gte: ["$loyalty.totalSpend", 10000] }] },
                  then: 0.85,
                  else: { $cond: { if: { $gte: ["$loyalty.years", 2] }, then: 0.92, else: 1 } },
                },
              },
            ],
          },
          2,
        ],
      });
    },
  );
});

describe("stock status label", { features: ["Ternaries"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.products.aggregate([{ $addFields: { stockLabel: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`$.stock >= $.reorderPoint ? "ok" : $.stock > 0 ? "low" : "out-of-stock"`)).toEqual({
        $cond: {
          if: { $gte: ["$stock", "$reorderPoint"] },
          then: "ok",
          else: { $cond: { if: { $gt: ["$stock", 0] }, then: "low", else: "out-of-stock" } },
        },
      });
    },
  );
});

describe("seasonal discount with eligibility check", { features: ["Ternaries"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.products.aggregate([{ $addFields: { salePrice: jsmql.expr(...) } }])" },
    () => {
      expect(
        jsmql.expr`
$.quantity > 1 && $.price >= 10 && $.category in ["sale", "clearance"]
  ? $.price * 0.8
  : $.price
      `,
      ).toEqual({
        $cond: {
          if: {
            $and: [{ $gt: ["$quantity", 1] }, { $gte: ["$price", 10] }, { $in: ["$category", ["sale", "clearance"]] }],
          },
          then: { $multiply: ["$price", 0.8] },
          else: "$price",
        },
      });
    },
  );
});

describe("scientific projection (hypot, log2/log10, sign, cbrt, PI, E)", { features: ["Arithmetic and Math"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.measurements.aggregate([{ $addFields: { metrics: jsmql.expr(...) } }])" },
    () => {
      expect(
        jsmql.expr`
{
  distance: Math.hypot($.point.x - $.origin.x, $.point.y - $.origin.y),
  octave: Math.log2($.frequency / 440),
  decibels: Math.log10($.amplitude) * 20,
  fovRad: $.fovDeg * Math.PI / 180,
  growthFactor: Math.E ** $.rate,
  trend: Math.sign($.delta),
  cubeSide: Math.cbrt($.volume)
}
      `,
      ).toEqual({
        distance: {
          $sqrt: {
            $add: [
              { $pow: [{ $subtract: ["$point.x", "$origin.x"] }, 2] },
              { $pow: [{ $subtract: ["$point.y", "$origin.y"] }, 2] },
            ],
          },
        },
        octave: { $log: [{ $divide: ["$frequency", 440] }, 2] },
        decibels: { $multiply: [{ $log10: "$amplitude" }, 20] },
        fovRad: { $divide: [{ $multiply: ["$fovDeg", 3.141592653589793] }, 180] },
        growthFactor: { $pow: [2.718281828459045, "$rate"] },
        trend: { $cmp: ["$delta", 0] },
        cubeSide: { $pow: ["$volume", { $divide: [1, 3] }] },
      });
    },
  );
});

describe("reorder alert with ** and unary !", { features: ["Arithmetic and Math"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.products.find(jsmql(...))" }, () => {
    expect(jsmql(`!$.discontinued && $.stock < $.baseReorder * 2 ** $.urgencyLevel`)).toEqual({
      $expr: {
        $and: [
          {
            $not: {
              $and: [
                { $ne: [{ $ifNull: ["$discontinued", null] }, null] },
                { $ne: ["$discontinued", false] },
                { $ne: ["$discontinued", ""] },
                { $ne: ["$discontinued", 0] },
              ],
            },
          },
          { $lt: ["$stock", { $multiply: ["$baseReorder", { $pow: [2, "$urgencyLevel"] }] }] },
        ],
      },
    });
  });
});

describe("score normalisation with grouping", { features: ["Arithmetic and Math"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.scores.aggregate([{ $addFields: { normalised: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`($.score - $.minScore) / ($.maxScore - $.minScore) * 100`)).toEqual({
        $multiply: [
          { $divide: [{ $subtract: ["$score", "$minScore"] }, { $subtract: ["$maxScore", "$minScore"] }] },
          100,
        ],
      });
    },
  );
});

describe("age decade bucket via Math.floor", { features: ["Arithmetic and Math"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.users.aggregate([{ $addFields: { ageDecade: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`Math.floor($.age / 10) * 10`)).toEqual({
        $multiply: [{ $floor: { $divide: ["$age", 10] } }, 10],
      });
    },
  );
});

describe("invoice line total with compound tax", { features: ["Arithmetic and Math"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.invoices.aggregate([{ $addFields: { lineTotal: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`$round($.quantity * ($.unitPrice + $.unitPrice * $.taxRate), 2)`)).toEqual({
        $round: [{ $multiply: ["$quantity", { $add: ["$unitPrice", { $multiply: ["$unitPrice", "$taxRate"] }] }] }, 2],
      });
    },
  );
});

describe("URL slug via .toLowerCase().trim().replaceAll()", { features: ["String methods"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.articles.aggregate([{ $addFields: { slug: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`String($.articleId) + "-" + $.title.toLowerCase().trim().replaceAll(" ", "-")`)).toEqual({
        $concat: [
          { $toString: "$articleId" },
          "-",
          { $replaceAll: { input: { $trim: { input: { $toLower: "$title" } } }, find: " ", replacement: "-" } },
        ],
      });
    },
  );
});

describe("email domain via .split().at().toLowerCase()", { features: ["String methods"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.users.aggregate([{ $addFields: { domain: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`$.email.split("@").at(1).toLowerCase()`)).toEqual({
        $toLower: { $arrayElemAt: [{ $split: ["$email", "@"] }, 1] },
      });
    },
  );
});

describe("CSV field word count", { features: ["String methods"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.documents.aggregate([{ $addFields: { tagCount: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`$.tags.split(",").length`)).toEqual({ $size: { $split: ["$tags", ","] } });
    },
  );
});

describe("invoice line greeting with ?., ??, and .startsWith", { features: ["Template literals"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.invoices.aggregate([{ $addFields: { greeting: jsmql.expr(...) } }])" },
    () => {
      expect(
        jsmql.expr(
          `\`Hi \${$.customer?.firstName ?? 'there'} — your \${$.invoice.id.startsWith('INV-VIP-') ? 'VIP ' : ''}invoice \${$.invoice.id} is ready\``,
        ),
      ).toEqual({
        $concat: [
          "Hi ",
          { $toString: { $ifNull: ["$customer.firstName", "there"] } },
          " — your ",
          {
            $toString: {
              $cond: { if: { $eq: [{ $indexOfCP: ["$invoice.id", "INV-VIP-"] }, 0] }, then: "VIP ", else: "" },
            },
          },
          "invoice ",
          { $toString: "$invoice.id" },
          " is ready",
        ],
      });
    },
  );
});

describe("audit log line with .toISOString and .charAt(0).toUpperCase", { features: ["Template literals"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.events.aggregate([{ $addFields: { logLine: jsmql.expr(...) } }])" },
    () => {
      expect(
        jsmql.expr(`\`\${$.event.ts.toISOString()} [\${$.event.level.charAt(0).toUpperCase()}] \${$.event.message}\``),
      ).toEqual({
        $concat: [
          { $dateToString: { date: "$event.ts", format: "%Y-%m-%dT%H:%M:%S.%LZ" } },
          " [",
          { $toUpper: { $substrCP: ["$event.level", 0, 1] } },
          "] ",
          { $toString: "$event.message" },
        ],
      });
    },
  );
});

describe("most-recent event timestamp via .flatMap.map.reduce", { features: ["Array methods"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.sessions.aggregate([{ $addFields: { latestEvent: jsmql.expr(...) } }])" },
    () => {
      expect(
        jsmql.expr`
$.sessions
  .flatMap(s => s.events)
  .map(e => e.ts.getTime())
  .reduce((acc, t) => Math.max(acc, t), 0)
      `,
      ).toEqual({
        $reduce: {
          input: {
            $map: {
              input: {
                $reduce: {
                  input: { $map: { input: "$sessions", as: "s", in: "$$s.events" } },
                  initialValue: [],
                  in: { $concatArrays: ["$$value", "$$this"] },
                },
              },
              as: "e",
              in: { $toLong: "$$e.ts" },
            },
          },
          initialValue: 0,
          in: { $max: ["$$value", "$$this"] },
        },
      });
    },
  );
});

describe("cart subtotal via .map.reduce", { features: ["Array methods"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.carts.aggregate([{ $addFields: { subtotal: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`$.items.map(item => item.qty * item.price).reduce((acc, x) => acc + x, 0)`)).toEqual({
        $reduce: {
          input: { $map: { input: "$items", as: "item", in: { $multiply: ["$$item.qty", "$$item.price"] } } },
          initialValue: 0,
          in: { $add: ["$$value", "$$this"] },
        },
      });
    },
  );
});

describe("full display name via .filter(Boolean).join", { features: ["Array methods"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.users.aggregate([{ $addFields: { displayName: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`[$.firstName, $.middleName, $.lastName].filter(Boolean).join(" ")`)).toEqual({
        $reduce: {
          input: {
            $filter: {
              input: ["$firstName", "$middleName", "$lastName"],
              as: "v",
              cond: {
                $and: [
                  { $ne: [{ $ifNull: ["$$v", null] }, null] },
                  { $ne: ["$$v", false] },
                  { $ne: ["$$v", ""] },
                  { $ne: ["$$v", 0] },
                ],
              },
            },
          },
          initialValue: "",
          in: {
            $cond: {
              if: { $eq: ["$$value", ""] },
              then: { $toString: "$$this" },
              else: { $concat: ["$$value", " ", { $toString: "$$this" }] },
            },
          },
        },
      });
    },
  );
});

describe("full address with conditional inclusion + filter + join", { features: ["Array methods"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.addresses.aggregate([{ $addFields: { addressLine: jsmql.expr(...) } }])" },
    () => {
      expect(
        jsmql.expr`
[$.building && $.building + ",", $.streetNo, $.street, $.suburb, $.state, $.country, $.postcode]
  .filter(Boolean)
  .join(" ")
      `,
      ).toEqual({
        $reduce: {
          input: {
            $filter: {
              input: [
                {
                  $cond: {
                    if: {
                      $and: [
                        { $ne: [{ $ifNull: ["$building", null] }, null] },
                        { $ne: ["$building", false] },
                        { $ne: ["$building", ""] },
                        { $ne: ["$building", 0] },
                      ],
                    },
                    then: { $concat: ["$building", ","] },
                    else: "$building",
                  },
                },
                "$streetNo",
                "$street",
                "$suburb",
                "$state",
                "$country",
                "$postcode",
              ],
              as: "v",
              cond: {
                $and: [
                  { $ne: [{ $ifNull: ["$$v", null] }, null] },
                  { $ne: ["$$v", false] },
                  { $ne: ["$$v", ""] },
                  { $ne: ["$$v", 0] },
                ],
              },
            },
          },
          initialValue: "",
          in: {
            $cond: {
              if: { $eq: ["$$value", ""] },
              then: { $toString: "$$this" },
              else: { $concat: ["$$value", " ", { $toString: "$$this" }] },
            },
          },
        },
      });
    },
  );
});

describe("tag aggregation via .map.flat.join", { features: ["Array methods"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.posts.aggregate([{ $addFields: { tagsCSV: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`$.posts.map(p => p.tags).flat().join(", ")`)).toEqual({
        $reduce: {
          input: {
            $reduce: {
              input: { $map: { input: "$posts", as: "p", in: "$$p.tags" } },
              initialValue: [],
              in: { $concatArrays: ["$$value", "$$this"] },
            },
          },
          initialValue: "",
          in: {
            $cond: {
              if: { $eq: ["$$value", ""] },
              then: { $toString: "$$this" },
              else: { $concat: ["$$value", ", ", { $toString: "$$this" }] },
            },
          },
        },
      });
    },
  );
});

describe("immutable replace and indexed map via .with / (x, i)", { features: ["Array methods"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.rosters.aggregate([{ $addFields: { rosterUpdate: jsmql.expr(...) } }])" },
    () => {
      expect(
        jsmql.expr`
{
  lineup: $.roster.with($.swap.slot, $.swap.in),
  labelled: $.roster.map((p, i) => ({ slot: i, name: p.name })),
}
      `,
      ).toEqual({
        lineup: {
          $let: {
            vars: { jsmqlArr: "$roster", jsmqlIdx: "$swap.slot", jsmqlVal: "$swap.in" },
            in: {
              $concatArrays: [
                { $slice: ["$$jsmqlArr", 0, "$$jsmqlIdx"] },
                ["$$jsmqlVal"],
                {
                  $slice: [
                    "$$jsmqlArr",
                    { $add: ["$$jsmqlIdx", 1] },
                    { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, { $add: ["$$jsmqlIdx", 1] }] }] },
                  ],
                },
              ],
            },
          },
        },
        labelled: {
          $map: {
            input: { $zip: { inputs: [{ $range: [0, { $size: "$roster" }] }, "$roster"] } },
            as: "jsmqlPair",
            in: {
              $let: {
                vars: { p: { $arrayElemAt: ["$$jsmqlPair", 1] }, i: { $arrayElemAt: ["$$jsmqlPair", 0] } },
                in: { slot: "$$i", name: "$$p.name" },
              },
            },
          },
        },
      });
    },
  );
});

describe("file upload validation with [literal].includes + .endsWith", { features: ["Array methods"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.uploads.find(jsmql(...))" }, () => {
    expect(
      jsmql`
[".jpg", ".png", ".pdf", ".docx"].includes($.file.ext.toLowerCase()) &&
$.file.name.endsWith($.file.ext) &&
$.file.size <= 25_000_000
      `,
    ).toEqual({
      "file.size": { $lte: 25000000 },
      $expr: {
        $and: [
          { $in: [{ $toLower: "$file.ext" }, [".jpg", ".png", ".pdf", ".docx"]] },
          {
            $eq: [
              {
                $substrCP: [
                  "$file.name",
                  { $subtract: [{ $strLenCP: "$file.name" }, { $strLenCP: "$file.ext" }] },
                  { $strLenCP: "$file.ext" },
                ],
              },
              "$file.ext",
            ],
          },
        ],
      },
    });
  });
});

describe("chat moderation with ?. inside an array spread", { features: ["Optional chaining"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.chatRooms.find(jsmql(...))" }, () => {
    expect(jsmql(`[...$.moderators, ...$.room?.mods, "root"].includes($.userId)`)).toEqual({
      $expr: { $in: ["$userId", { $concatArrays: ["$moderators", { $ifNull: ["$room.mods", []] }, ["root"]] }] },
    });
  });
});

describe("?. inside a template literal", { features: ["Optional chaining"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.users.aggregate([{ $addFields: { label: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`\`\${$.name?.first} \${$.name?.last}\`.trim()`)).toEqual({
        $trim: {
          input: {
            $concat: [
              { $toString: { $ifNull: ["$name.first", ""] } },
              " ",
              { $toString: { $ifNull: ["$name.last", ""] } },
            ],
          },
        },
      });
    },
  );
});

describe("full name with three-step ?? fallback chain", { features: ["Nullish coalescing"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.users.aggregate([{ $addFields: { displayName: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`$.firstName ?? $.aliases.at(0) ?? "anonymous"`)).toEqual({
        $ifNull: ["$firstName", { $arrayElemAt: ["$aliases", 0] }, "anonymous"],
      });
    },
  );
});

describe("formatted date label with ?? chain", { features: ["Nullish coalescing"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.articles.aggregate([{ $addFields: { dateLabel: jsmql.expr(...) } }])" },
    () => {
      expect(
        jsmql.expr`
$dateToString({ date: $.publishedAt, format: "%Y-%m-%d" }) ??
$dateToString({ date: $.createdAt, format: "%Y-%m-%d" }) ??
"unknown"
      `,
      ).toEqual({
        $ifNull: [
          { $dateToString: { date: "$publishedAt", format: "%Y-%m-%d" } },
          { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } },
          "unknown",
        ],
      });
    },
  );
});

describe("moderator membership check via [...a, ...b]", { features: ["Array spread"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.threads.find(jsmql(...))" }, () => {
    expect(jsmql(`[...$.moderators, ...$.room.mods, "root"].includes($.userId)`)).toEqual({
      $expr: { $in: ["$userId", { $concatArrays: ["$moderators", "$room.mods", ["root"]] }] },
    });
  });
});

describe("Math.max(...arr) - Math.min(...arr) with Array.isArray guard", { features: ["Array spread"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.students.aggregate([{ $addFields: { range: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`Array.isArray($.scores) ? Math.max(...$.scores) - Math.min(...$.scores) : 0`)).toEqual({
        $cond: {
          if: { $isArray: "$scores" },
          then: { $subtract: [{ $max: "$scores" }, { $min: "$scores" }] },
          else: 0,
        },
      });
    },
  );
});

describe("dynamic pivot row with computed key + shorthand property", { features: ["Object literals"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.products.aggregate([{ $addFields: { byCategory: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`$.products.map(p => ({ [p.category]: p.price, p }))`)).toEqual({
        $map: {
          input: "$products",
          as: "p",
          in: {
            $arrayToObject: [
              [
                { k: "$$p.category", v: "$$p.price" },
                { k: "p", v: "$$p" },
              ],
            ],
          },
        },
      });
    },
  );
});

describe("pivot table row via Object.fromEntries(.map(...))", { features: ["Object literals"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.metrics.aggregate([{ $addFields: { row: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`Object.fromEntries($.metrics.map(m => [m.name, m.value]))`)).toEqual({
        $arrayToObject: { $map: { input: "$metrics", as: "m", in: ["$$m.name", "$$m.value"] } },
      });
    },
  );
});

describe("shopping cart total with 10_000 cap", { features: ["Numeric separators"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.carts.aggregate([{ $addFields: { total: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`Math.min(10_000, $.lines.reduce((sum, l) => sum + l.qty * l.price, 0))`)).toEqual({
        $min: [
          10000,
          {
            $reduce: {
              input: "$lines",
              initialValue: 0,
              in: { $add: ["$$value", { $multiply: ["$$this.qty", "$$this.price"] }] },
            },
          },
        ],
      });
    },
  );
});

describe("normalise a string-or-number field with typeof", { features: ["Type checks and casts"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.items.aggregate([{ $addFields: { trimmed: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`typeof $.value === "string" ? $.value.trim() : String($.value)`)).toEqual({
        $cond: {
          if: { $eq: [{ $type: "$value" }, "string"] },
          then: { $trim: { input: "$value" } },
          else: { $toString: "$value" },
        },
      });
    },
  );
});

describe("days since last login (Math.abs + $dateDiff + ?? + new Date)", { features: ["Date and time"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.users.aggregate([{ $addFields: { daysSinceLogin: jsmql.expr(...) } }])" },
    () => {
      expect(
        jsmql.expr(`Math.abs($dateDiff({ startDate: $.lastLoginAt, endDate: new Date(), unit: 'day' }) ?? -1)`),
      ).toEqual({
        $abs: {
          $ifNull: [{ $dateDiff: { startDate: "$lastLoginAt", endDate: { $toDate: "$$NOW" }, unit: "day" } }, -1],
        },
      });
    },
  );
});

describe("days since document was created", { features: ["Date and time"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.documents.aggregate([{ $addFields: { daysSinceCreated: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`$dateDiff({ startDate: $.createdAt, endDate: new Date(), unit: "day" })`)).toEqual({
        $dateDiff: { startDate: "$createdAt", endDate: { $toDate: "$$NOW" }, unit: "day" },
      });
    },
  );
});

describe("days since event (Date.now + .getTime + 86_400_000)", { features: ["Date and time"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.events.aggregate([{ $addFields: { daysSinceEvent: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`Math.floor((Date.now() - $.event.ts.getTime()) / 86_400_000)`)).toEqual({
        $floor: { $divide: [{ $subtract: [{ $toLong: "$$NOW" }, { $toLong: "$event.ts" }] }, 86400000] },
      });
    },
  );
});

describe("annotated insurance underwriting rule with // and /* */", { features: ["Comments"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.applicants.find(jsmql(...))" }, () => {
    expect(
      jsmql`
// age window: 25 to 70 inclusive
$.driver.age >= 25 && $.driver.age <= 70 &&

/* annual mileage cap — 30k km/year keeps us out of commercial-fleet pricing */
$.policy.kmPerYear <= 30_000 &&

// hard-list occupations that bump the applicant to the high-risk tier
!($.driver.occupation in ["stunt-double", "test-pilot", "demolition-engineer"])
      `,
    ).toEqual({
      $and: [{ "driver.age": { $gte: 25 } }, { "driver.age": { $lte: 70 } }],
      "policy.kmPerYear": { $lte: 30000 },
      $expr: { $not: { $in: ["$driver.occupation", ["stunt-double", "test-pilot", "demolition-engineer"]] } },
    });
  });
});

describe("discount breakdown — bind once, reuse across fields", { features: ["IIFE"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.orders.aggregate([{ $addFields: { discount: jsmql.expr(...) } }])" },
    () => {
      expect(
        jsmql.expr`
((discount) => ({
  finalPrice: $.price - discount,
  savings: discount,
  savingsPercent: Math.round((discount / $.price) * 100),
}))($.price * (1 - $.loyalty.multiplier))
      `,
      ).toEqual({
        $let: {
          vars: { discount: { $multiply: ["$price", { $subtract: [1, "$loyalty.multiplier"] }] } },
          in: {
            finalPrice: { $subtract: ["$price", "$$discount"] },
            savings: "$$discount",
            savingsPercent: { $round: [{ $multiply: [{ $divide: ["$$discount", "$price"] }, 100] }, 0] },
          },
        },
      });
    },
  );
});

describe("order pricing — declare a helper once, reuse across fields", { features: ["Reusable functions"] }, () => {
  // A reusable `money()` rounding helper, declared at the top of the pipeline
  // and applied to three derived monetary fields. Each call site re-lowers the
  // body inline as its own `$let` — no helper is stored in the document.
  it("compiles to the expected MQL", { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" }, () => {
    expect(
      jsmql(`
const money = (n) => Math.round(n * 100) / 100;
$ = {
  subtotal: money($.price * $.qty),
  tax: money($.price * $.qty * $.taxRate),
  total: money($.price * $.qty * (1 + $.taxRate)),
};
      `),
    ).toEqual([
      {
        $replaceWith: {
          subtotal: {
            $let: {
              vars: { n: { $multiply: ["$price", "$qty"] } },
              in: { $divide: [{ $round: [{ $multiply: ["$$n", 100] }, 0] }, 100] },
            },
          },
          tax: {
            $let: {
              vars: { n: { $multiply: ["$price", "$qty", "$taxRate"] } },
              in: { $divide: [{ $round: [{ $multiply: ["$$n", 100] }, 0] }, 100] },
            },
          },
          total: {
            $let: {
              vars: { n: { $multiply: ["$price", "$qty", { $add: [1, "$taxRate"] }] } },
              in: { $divide: [{ $round: [{ $multiply: ["$$n", 100] }, 0] }, 100] },
            },
          },
        },
      },
    ]);
  });
});

describe(
  "order pricing — same helper, written with the `function` keyword",
  { features: ["Reusable functions"] },
  () => {
    // The `function` keyword is a second spelling of the reusable-function form —
    // paste JS as you'd write it. The declaration is self-terminating (no `;`
    // after the `}`), and it lowers to byte-identical MQL to the arrow form above.
    it("compiles to the expected MQL", { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" }, () => {
      expect(
        jsmql(`
function money(n) { return Math.round(n * 100) / 100 }
$ = {
  subtotal: money($.price * $.qty),
  tax: money($.price * $.qty * $.taxRate),
};
      `),
      ).toEqual([
        {
          $replaceWith: {
            subtotal: {
              $let: {
                vars: { n: { $multiply: ["$price", "$qty"] } },
                in: { $divide: [{ $round: [{ $multiply: ["$$n", 100] }, 0] }, 100] },
              },
            },
            tax: {
              $let: {
                vars: { n: { $multiply: ["$price", "$qty", "$taxRate"] } },
                in: { $divide: [{ $round: [{ $multiply: ["$$n", 100] }, 0] }, 100] },
              },
            },
          },
        },
      ]);
    });
  },
);

describe("$round of $sum as a plain expression", { features: ["Escape hatch"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.invoices.aggregate([{ $addFields: { result: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`$round($sum($.lineTotal), 2)`)).toEqual({ $round: [{ $sum: "$lineTotal" }, 2] });
    },
  );
});

describe("$toLower wrapping a string-context +", { features: ["Escape hatch"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.users.aggregate([{ $addFields: { handle: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`$toLower($.firstName + " " + $.lastName)`)).toEqual({
        $toLower: { $concat: ["$firstName", " ", "$lastName"] },
      });
    },
  );
});

describe("parameterised threshold query", { features: ["Template tag"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.students.find(jsmql(...))" }, () => {
    expect(
      jsmql`
$.score >= 75 &&
$.grade in ["A", "B"] &&
$.submitted === true
      `,
    ).toEqual({ score: { $gte: 75 }, submitted: true, $expr: { $in: ["$grade", ["A", "B"]] } });
  });
});

describe("user-with-orders join via $$$ lookup", { features: ["Pipelines"] }, () => {
  it("compiles to the expected MQL", { kind: "pipeline", usage: "db.users.aggregate(jsmql(...))" }, () => {
    expect(
      jsmql`
$match($.active === true);
$.recentOrders = $$$.orders.filter(o => {
  $match(o.userId === $._id);
  $sort({ createdAt: -1 });
  $limit(5);
});
let nOrders = $$$.orders.filter(o => o.userId === $._id).length;
$project({ name: 1, recentOrders: 1, nOrders });
      `,
    ).toEqual([
      { $match: { active: true } },
      {
        $lookup: {
          from: "orders",
          let: { v0_id: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$v0_id"] } } },
            { $sort: { createdAt: -1 } },
            { $limit: 5 },
          ],
          as: "recentOrders",
        },
      },
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.1" } },
      { $set: { "__jsmql.tmp.1": { $size: "$__jsmql.tmp.1" } } },
      { $set: { "__jsmql.var.nOrders": "$__jsmql.tmp.1" } },
      { $project: { name: 1, recentOrders: 1, nOrders: "$__jsmql.var.nOrders" } },
      { $unset: "__jsmql" },
    ]);
  });
});

// Two-level join from inside a block-body sub-pipeline: each active user gets
// their 5 most-recent orders, and each of THOSE orders is enriched in place
// with its shipments via a nested `$$$.shipments` lookup written as a statement
// inside the outer orders block. The inner predicate correlates against BOTH
// enclosing levels at once — `s.orderId === o._id` (the *order*, the current doc
// of the outer orders sub-pipeline) and `s.userId === $._id` (the outermost
// *user*). The depth-stamped let names keep them distinct: `$$v1_id` is the
// order's `_id`, `$$v0_id` is the user's. (With a single shared `$$v_id` they
// would collide and the user correlation would silently read the order's id.)
// Verified against a live mongod.
describe(
  "user → recent orders → each order's shipments (nested lookup in a block body)",
  { features: ["Pipelines"] },
  () => {
    it("compiles to the expected MQL", { kind: "pipeline", usage: "db.users.aggregate(jsmql(...))" }, () => {
      expect(
        jsmql`
$match($.active === true);
$.recentOrders = $$$.orders.filter(o => {
  $match(o.userId === $._id);
  $sort({ createdAt: -1 });
  $limit(5);
  $.shipments = $$$.shipments.filter(s => s.orderId === o._id && s.userId === $._id);
});
$project({ name: 1, recentOrders: 1 });
      `,
      ).toEqual([
        { $match: { active: true } },
        {
          $lookup: {
            from: "orders",
            let: { v0_id: "$_id" },
            pipeline: [
              { $match: { $expr: { $eq: ["$userId", "$$v0_id"] } } },
              { $sort: { createdAt: -1 } },
              { $limit: 5 },
              {
                $lookup: {
                  from: "shipments",
                  let: { v1_id: "$_id" },
                  pipeline: [
                    {
                      $match: { $expr: { $and: [{ $eq: ["$orderId", "$$v1_id"] }, { $eq: ["$userId", "$$v0_id"] }] } },
                    },
                  ],
                  as: "shipments",
                },
              },
            ],
            as: "recentOrders",
          },
        },
        { $project: { name: 1, recentOrders: 1 } },
      ]);
    });
  },
);

// `$$.push(...)` — merge active users from the live collection with deleted
// users from an archive collection and a couple of synthetic placeholder
// docs, then page the unified result. Demonstrates inline-doc batching,
// `.filter` spread, and source-order preservation across mixed args. Each
// real-world dashboard that paginates across "current + archived" data uses
// the same shape; this is the canonical jsmql idiom.
describe("union live + archive users with placeholders via $$.push", { features: ["Pipelines"] }, () => {
  it(
    "compiles to a series of $unionWith stages with batched $documents",
    { kind: "pipeline", usage: "db.users.aggregate(jsmql(...))" },
    () => {
      expect(
        jsmql`
$match($.active === true);
$$.push(
  { _id: "system", name: "System", role: "synthetic" },
  { _id: "anon",   name: "Anonymous", role: "synthetic" },
  ...$$$.archive_users.filter(u => u.deleted === true)
);
$sort({ name: 1 });
$limit(50);
      `,
      ).toEqual([
        { $match: { active: true } },
        {
          $unionWith: {
            pipeline: [
              {
                $documents: [
                  { _id: "system", name: "System", role: "synthetic" },
                  { _id: "anon", name: "Anonymous", role: "synthetic" },
                ],
              },
            ],
          },
        },
        { $unionWith: { coll: "archive_users", pipeline: [{ $match: { deleted: true } }] } },
        { $sort: { name: 1 } },
        { $limit: 50 },
      ]);
    },
  );
});

// `$$$.<coll> = <RHS>` / `$$$$.<db>.<coll> = <RHS>` — write the current
// pipeline into a destination collection via `$out`. The LHS names *where*
// the documents land, the RHS describes *which* documents land there.
// Two idioms here, side by side so users can see the trade-off:
//
//   1. Multi-stage pipeline with a bare `$$` write at the end. Pick this when
//      you need more than one transformation stage before the write (here:
//      an indexable `$match` on multiple fields).
//   2. Single-statement inline filter. Pick this when one `$$.filter(...)`
//      is the whole transformation — the LHS-says-destination,
//      RHS-says-source shape reads as one English sentence.
describe("archive inactive users to a warehouse via $out (multi-stage)", { features: ["Pipelines"] }, () => {
  it(
    "filters then writes to a cross-database $out destination",
    { kind: "pipeline", usage: "db.users.aggregate(jsmql(...))" },
    () => {
      expect(
        jsmql`
$match($.active === false && $.lastSeen < new Date("2025-01-01"));
$$$$.dw.archive_users = $$;
      `,
      ).toEqual([
        { $match: { active: false, lastSeen: { $lt: new Date("2025-01-01") } } },
        { $out: { db: "dw", coll: "archive_users" } },
      ]);
    },
  );
});

describe("archive expired users via $out (inline filter)", { features: ["Pipelines"] }, () => {
  it(
    "the whole pipeline is one $$$$.<db>.<coll> = $$.filter(...) statement",
    { kind: "pipeline", usage: "db.users.aggregate(jsmql(...))" },
    () => {
      expect(jsmql(`$$$$.dw.archive = $$.filter(u => u.status === "expired");`)).toEqual([
        { $match: { status: "expired" } },
        { $out: { db: "dw", coll: "archive" } },
      ]);
    },
  );
});

// ── Stream-method chains on the RHS of `$$ = …` ──────────────────────────────
//
// Chainable JS array-method vocabulary that extends a `$$ = $$.<chain>;` (or
// `$$ = $$$.<coll>.<chain>;`) RHS into one or more pipeline stages. Each
// chained method appends stages to the surrounding pipeline; the result is
// the same MQL you'd write by hand, expressed as a JS expression you can
// copy-paste.
//
// See [docs/specs/stream-methods.md] for the full registry and
// [docs/LANGUAGE.md#stream-methods-chained-after-the-rhs] for the
// user-facing reference.

describe("paginate shipped orders newest-first (`.toSorted` + `.slice`)", { features: ["Pipelines"] }, () => {
  it(
    "compiles a sort+page chain into $sort + $skip + $limit",
    { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" },
    () => {
      // After narrowing to shipped orders, page-25 (offsets 25..50) sorted
      // newest-first. The descending sort comes from `b.placedAt - a.placedAt`;
      // `.slice(25, 50)` lowers to `$skip: 25` + `$limit: 25` (end - start).
      expect(
        jsmql`
$match($.status === "shipped");
$$ = $$.toSorted((a, b) => b.placedAt - a.placedAt).slice(25, 50);
        `,
      ).toEqual([{ $match: { status: "shipped" } }, { $sort: { placedAt: -1 } }, { $skip: 25 }, { $limit: 25 }]);
    },
  );
});

describe("guard against corrupt data before aggregating (`assert`)", { features: ["Pipelines"] }, () => {
  it(
    "asserts an invariant mid-pipeline, then computes — a bad document aborts the whole aggregate",
    { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" },
    () => {
      // Before rolling up revenue we refuse to silently ingest corrupt rows: a
      // negative quantity should fail the whole aggregate loudly rather than
      // skew the totals. `assert(cond, msg)` lowers to a `$match` whose
      // `$convert` throws `Unknown type name: jsmql assertion failed: <msg>`
      // when the condition fails (no deprecated server-side JS); a holding
      // assertion passes the document through untouched.
      expect(
        jsmql`
$match($.status === "paid");
assert($.qty >= 0, "order qty must be non-negative");
$.revenue = $.qty * $.unitPrice;
        `,
      ).toEqual([
        { $match: { status: "paid" } },
        {
          $match: {
            $expr: {
              $convert: {
                input: true,
                to: {
                  $cond: [{ $gte: ["$qty", 0] }, "bool", "jsmql assertion failed: order qty must be non-negative"],
                },
              },
            },
          },
        },
        { $set: { revenue: { $multiply: ["$qty", "$unitPrice"] } } },
      ]);
    },
  );
});

describe(
  "tag each in-stock product with the category total + size guard (`$$.length` + `assert`)",
  { features: ["Pipelines"] },
  () => {
    it(
      "reuses one stream-count materialisation across two fields and an assert guard",
      { kind: "pipeline", usage: "db.products.aggregate(jsmql(...))" },
      () => {
        // Category page: after narrowing to in-stock products, every doc carries
        // the total in-stock count (a "showing N products" header) and its share
        // of the total, and the whole aggregate aborts if the category is too big
        // to render in one page. `$$.length` materialises ONE `$setWindowFields`
        // `$count`; both `$set`s and the `assert` reuse it (no extra count stages,
        // since `$set` is freshness-preserving). The trailing `$unset` keeps the
        // scratch field out of the result.
        expect(
          jsmql`
$match($.inStock === true);
$.totalInStock = $$.length;
$.sharePct = 100 / $$.length;
assert($$.length <= 1000, "too many in-stock products to render");
        `,
        ).toEqual([
          { $match: { inStock: true } },
          { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
          { $set: { totalInStock: "$__jsmql.length" } },
          { $set: { sharePct: { $divide: [100, "$__jsmql.length"] } } },
          {
            $match: {
              $expr: {
                $convert: {
                  input: true,
                  to: {
                    $cond: [
                      { $lte: ["$__jsmql.length", 1000] },
                      "bool",
                      "jsmql assertion failed: too many in-stock products to render",
                    ],
                  },
                },
              },
            },
          },
          { $unset: "__jsmql" },
        ]);
      },
    );
  },
);

describe("denormalise order line items for analytics (`.map`)", { features: ["Pipelines"] }, () => {
  it(
    "reshapes each shipped order doc into an analytics-friendly summary",
    { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" },
    () => {
      // `.map(o => ({...}))` lowers to `$replaceWith` — the chain-form of the
      // existing `$ = <expr>` statement sugar. The lambda parameter IS the
      // current document, so `o.qty` rewrites to the bare field path `$qty`.
      expect(
        jsmql`
$match($.shipped === true);
$$ = $$.map(o => ({
  orderId:  o._id,
  customer: o.userId,
  total:    o.qty * o.unitPrice,
  shippedAt: o.shippedAt
}));
        `,
      ).toEqual([
        { $match: { shipped: true } },
        {
          $replaceWith: {
            orderId: "$_id",
            customer: "$userId",
            total: { $multiply: ["$qty", "$unitPrice"] },
            shippedAt: "$shippedAt",
          },
        },
      ]);
    },
  );
});

describe("top-10 revenue leaderboard (`.toSorted` + `.slice`)", { features: ["Pipelines"] }, () => {
  it("groups, sorts, and slices into one chain", { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" }, () => {
    // Classic top-N over an aggregated stream. The leaderboard is the
    // canonical `.toSorted(desc).slice(0, N)` shape.
    expect(
      jsmql`
$group({ _id: $.userId, revenue: $sum($.total), orders: $sum(1) });
$$ = $$.toSorted((a, b) => b.revenue - a.revenue).slice(0, 10);
        `,
    ).toEqual([
      { $group: { _id: "$userId", revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
      { $sort: { revenue: -1 } },
      { $limit: 10 },
    ]);
  });
});

describe("most expensive line items across shipped orders (`.flatMap` + `.map`)", { features: ["Pipelines"] }, () => {
  it(
    "flatten order items, project to the item itself, then sort by price",
    { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" },
    () => {
      // `.flatMap(o => o.items)` lowers to `$unwind: "$items"` — MQL-natural,
      // surrounding fields preserved. The follow-up `.map(o => o.items)`
      // replaces each doc with just the item (so the next `$sort` indexes
      // into the item directly).
      expect(
        jsmql`
$$ = $$.filter(o => o.status === "shipped").flatMap(o => o.items).map(o => o.items);
$sort({ price: -1 });
$limit(50);
        `,
      ).toEqual([
        { $match: { status: "shipped" } },
        { $unwind: "$items" },
        { $replaceWith: "$items" },
        { $sort: { price: -1 } },
        { $limit: 50 },
      ]);
    },
  );
});

describe("merge live transactions with the archive stream (`.concat`)", { features: ["Pipelines"] }, () => {
  it(
    "narrow then append a foreign collection in one chain",
    { kind: "pipeline", usage: "db.transactions.aggregate(jsmql(...))" },
    () => {
      // `.concat(...$$$.<coll>)` is the chain-form alias for `$$.push(...)`
      // — same `$unionWith` lowering, expressed where the next chain method
      // would naturally go. Useful when querying a partitioned dataset where
      // recent docs live in one collection and older docs in another.
      expect(
        jsmql`
$match($.region === "AU");
$$ = $$.filter(t => t.amount > 100).concat(...$$$.archive_transactions);
        `,
      ).toEqual([
        { $match: { region: "AU" } },
        { $match: { amount: { $gt: 100 } } },
        { $unionWith: "archive_transactions" },
      ]);
    },
  );
});

describe("daily revenue summary (`$$ = [{ … : $$.reduce(…) }]` scalar wrap)", { features: ["Pipelines"] }, () => {
  it(
    "fold the stream into a single-doc summary via the scalar reduce wrap",
    { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" },
    () => {
      // `.reduce` isn't a chain method on `$$` — in JS it collapses an array
      // to a single value, which would break the "stream is always an array"
      // invariant. Instead, wrap the result(s) in a single-doc array literal.
      // Each entry becomes one `$group` accumulator; the trailing
      // `$replaceWith` drops `_id: null` so the output stream is exactly the
      // named-keys shape the user wrote.
      expect(
        jsmql`
$match($.placedAt >= new Date("2026-05-01") && $.placedAt < new Date("2026-06-01"));
$$ = [{
  orders:    $$.reduce((acc, o) => acc + 1, 0),
  revenue:   $$.reduce((acc, o) => acc + o.total, 0),
  biggest:   $$.reduce((acc, o) => Math.max(acc, o.total), 0),
  smallest:  $$.reduce((acc, o) => Math.min(acc, o.total), 0)
}];
        `,
      ).toEqual([
        {
          $match: {
            $and: [{ placedAt: { $gte: new Date("2026-05-01") } }, { placedAt: { $lt: new Date("2026-06-01") } }],
          },
        },
        {
          $group: {
            _id: null,
            orders: { $sum: 1 },
            revenue: { $sum: "$total" },
            biggest: { $max: "$total" },
            smallest: { $min: "$total" },
          },
        },
        { $replaceWith: { orders: "$orders", revenue: "$revenue", biggest: "$biggest", smallest: "$smallest" } },
      ]);
    },
  );
});

describe(
  "daily revenue summary, inline reducer body (`$$ = [$$.reduce(… => ({…}), {…})]`)",
  { features: ["Pipelines"] },
  () => {
    it(
      "same MQL as the scalar wrap above, expressed as one object-returning reducer",
      { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" },
      () => {
        // The object-returning reducer wrap and the scalar wrap lower to the
        // same `$group` + `$replaceWith` pair — pick whichever reads best at
        // the call site. The reducer body names every accumulator inline;
        // each `acc.<key> + …` / `Math.max(acc.<key>, …)` becomes one
        // accumulator on the `$group`.
        expect(
          jsmql`
$match($.placedAt >= new Date("2026-05-01") && $.placedAt < new Date("2026-06-01"));
$$ = [$$.reduce(
  (acc, o) => ({
    ...acc,
    orders:   acc.orders + 1,
    revenue:  acc.revenue + o.total,
    biggest:  Math.max(acc.biggest, o.total),
    smallest: Math.min(acc.smallest, o.total)
  }),
  { orders: 0, revenue: 0, biggest: 0, smallest: 0 }
)];
        `,
        ).toEqual([
          {
            $match: {
              $and: [{ placedAt: { $gte: new Date("2026-05-01") } }, { placedAt: { $lt: new Date("2026-06-01") } }],
            },
          },
          {
            $group: {
              _id: null,
              orders: { $sum: 1 },
              revenue: { $sum: "$total" },
              biggest: { $max: "$total" },
              smallest: { $min: "$total" },
            },
          },
          { $replaceWith: { orders: "$orders", revenue: "$revenue", biggest: "$biggest", smallest: "$smallest" } },
        ]);
      },
    );
  },
);

describe(
  "export contact details of active users (`$$ = $$.reduce(… => acc.concat(…), [])`)",
  { features: ["Pipelines"] },
  () => {
    it(
      "filter + project as a single array-returning reducer",
      { kind: "pipeline", usage: "db.users.aggregate(jsmql(...))" },
      () => {
        // An array-returning reducer (seed `[]`) is the JS-faithful shape for
        // "build a flat array by conditionally appending one projection per
        // doc". Because it already yields an array — a stream — it's assigned
        // directly to `$$`, no surrounding `[ ]`. Lowers to `$match` (the
        // ternary condition) + `$replaceWith` (the field path concatenated).
        // The condition translates through the same engine `.filter` uses —
        // `d.active && d.contactDetails.email` becomes an `$expr` with the
        // JS-faithful `&&` short-circuit.
        //
        // This is the same shape as `.filter(d => …).map(d => d.contactDetails)`
        // — pick whichever reads better at the call site.
        expect(
          jsmql`
$$ = $$.reduce(
  (acc, d) => (d.active && d.contactDetails.email ? acc.concat(d.contactDetails) : acc),
  []
);
$$$$.exports.email_contacts = $$;
        `,
        ).toEqual([
          {
            $match: {
              $expr: {
                $cond: {
                  if: {
                    $and: [
                      { $ne: [{ $ifNull: ["$active", null] }, null] },
                      { $ne: ["$active", false] },
                      { $ne: ["$active", ""] },
                      { $ne: ["$active", 0] },
                    ],
                  },
                  then: "$contactDetails.email",
                  else: "$active",
                },
              },
            },
          },
          { $replaceWith: "$contactDetails" },
          { $out: { db: "exports", coll: "email_contacts" } },
        ]);
      },
    );
  },
);

// 🌟 The flagship combination: source-switch on a foreign collection, filter,
// and *enrich each surviving doc with a lookup from yet another collection*
// — all in one chain. The outer `$$ = $$$.<coll>.<chain>` lowers to
// `$limit: 0` + `$unionWith` with the chain stages making up the union's
// sub-pipeline. The embedded `$$$.<other>.find(...)` inside `.map`'s body
// materialises as a nested `$lookup` (basic-form `localField` / `foreignField`
// when the predicate is a single `===`) followed by a `$set { $first }` so
// the slot holds the matched doc (or null) rather than an array. The final
// `$replaceWith` projects each user-side doc to the call-site-friendly shape.
//
// One JS expression compiles to a 6-stage pipeline that touches three
// collections and would otherwise require careful by-hand `$lookup` /
// `$unionWith` plumbing.
describe(
  "daily active-user engagement digest (source-switch + filter + map-with-embedded-lookup)",
  { features: ["Pipelines"] },
  () => {
    it(
      "pivots onto users, narrows to active accounts, and enriches each with their most recent order",
      { kind: "pipeline", usage: "db.daily_jobs.aggregate(jsmql(...))" },
      () => {
        // Real-world flow: a nightly job runs `db.daily_jobs.aggregate(...)`
        // and produces one row per active user, enriched with their most
        // recent order. The pipeline starts on `daily_jobs` (an orchestrator
        // collection) and pivots its source onto `users` — same result as
        // running on `users` from the start, but the call site keeps its
        // original collection so the same job runner can host pipelines for
        // multiple downstream collections.
        expect(
          jsmql`
$$ = $$$.users.filter(u => u.active === true).map(u => ({
  user:      u._id,
  name:      u.name,
  email:     u.contactDetails.email,
  signupAt:  u.createdAt,
  lastOrder: $$$.orders.find(o => o.userId === u._id)
}));
          `,
        ).toEqual([
          { $match: { $expr: false } },
          {
            $unionWith: {
              coll: "users",
              pipeline: [
                { $match: { active: true } },
                { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.1" } },
                { $set: { "__jsmql.tmp.1": { $first: "$__jsmql.tmp.1" } } },
                {
                  $replaceWith: {
                    user: "$_id",
                    name: "$name",
                    email: "$contactDetails.email",
                    signupAt: "$createdAt",
                    lastOrder: "$__jsmql.tmp.1",
                  },
                },
              ],
            },
          },
          { $unset: "__jsmql" },
        ]);
      },
    );
  },
);

describe("invalid reduce on $$ — validate() catches the wrap-pattern omission", { features: ["Pipelines"] }, () => {
  it(
    "the bare chain form is rejected at compile time with an actionable wrap-pattern hint",
    { kind: "validate" },
    () => {
      // A user might reach for `$$ = $$.reduce(...)` expecting it to "just
      // work" the way `arr.reduce(...)` does in JS — but assigning the
      // scalar result to `$$` would break the "stream is always an array of
      // docs" invariant. `validate()` surfaces the rejection with a real
      // `.pos` and an actionable message pointing at the three wrap shapes.
      const r = jsmql.validate(`$$ = $$.reduce((acc, o) => acc + o.total, 0);`);
      expect(r.valid).toBe(false);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].code).toBe("CODEGEN_ERROR");
      expect(r.errors[0].pos).toBeGreaterThan(0);
      expect(r.errors[0].message).toMatch(/'\.reduce\(\.\.\.\)' is not a chain method/);
      expect(r.errors[0].message).toMatch(/Scalar reducer.*Object reducer.*Array reducer/s);
    },
  );
});

describe(
  "denormalise a user with their top-5 most recent orders (chain extension inside $lookup)",
  { features: ["Pipelines"] },
  () => {
    it(
      "the chain after $$$.coll.filter(...) becomes the $lookup's pipeline body",
      { kind: "pipeline", usage: "db.users.aggregate(jsmql(...))" },
      () => {
        // `$.<field> = $$$.<coll>.filter(p).<chain>` is a single-statement way
        // to embed a *filtered, sorted, sliced* slice of a foreign collection
        // into each input doc. The chain methods after `.filter` push into
        // the `$lookup.pipeline` body — no temp slot, no expression-form
        // `$sortArray` / `$slice` gymnastics. The reverse-then-slice gets the
        // five most recent orders per user.
        expect(
          jsmql`
$.recentOrders = $$$.orders
  .filter(o => o.userId === $._id)
  .toSorted((a, b) => a.placedAt - b.placedAt)
  .toReversed()
  .slice(0, 5)
  .map(o => ({ id: o._id, total: o.total, placedAt: o.placedAt }));
          `,
        ).toEqual([
          {
            $lookup: {
              from: "orders",
              let: { v0_id: "$_id" },
              pipeline: [
                { $match: { $expr: { $eq: ["$userId", "$$v0_id"] } } },
                { $sort: { placedAt: -1 } },
                { $limit: 5 },
                { $replaceWith: { id: "$_id", total: "$total", placedAt: "$placedAt" } },
              ],
              as: "__jsmql.tmp.1",
            },
          },
          { $set: { recentOrders: "$__jsmql.tmp.1" } },
          { $unset: "__jsmql" },
        ]);
      },
    );
  },
);

// 🌟 The crown jewel of stream-method composition: pivot the stream onto a
// foreign collection *per outer doc*. When the predicate of
// `$$ = $$$.<coll>.filter(<pred>)` references the current document (via
// `$.<field>`), jsmql can't use `$unionWith` — that MongoDB stage has no
// `let:` slot to thread outer-doc context into its sub-pipeline. So jsmql
// auto-rewrites the chain to `$lookup` (basic-form when the predicate is a
// single `===`, pipeline-form otherwise) + `$unwind` + `$replaceWith`.
// Result: a stream of foreign docs *correlated* to each input.
//
// The non-correlated case (no `$.<field>` in the predicate) continues to
// use `$limit:0 + $unionWith` — the flat foreign-collection scan, no
// per-outer-doc correlation. The dispatch happens at the predicate level.
describe(
  "explode the stream into each user's top 5 orders ($lookup-pivot via correlated filter)",
  { features: ["Pipelines"] },
  () => {
    it(
      "one JS chain compiles to $lookup + $unwind + $replaceWith — pivots from users onto their per-user order list",
      { kind: "pipeline", usage: "db.users.aggregate(jsmql(...))" },
      () => {
        // Read this as plain JS: "set the stream to each user's orders,
        // sorted newest-first, take the top 5". The `$.userId` ref inside
        // the filter is what flips the lowering from $unionWith to $lookup
        // — every output row is correlated to the user it came from. The
        // trailing `.toSorted` and `.slice` extend the lookup's pipeline
        // body, so the top-5-most-recent shaping runs *inside* the lookup
        // (no need to sort the unwound flat stream afterward).
        expect(
          jsmql`
$$ = $$$.orders
  .filter(o => o.userId === $._id)
  .toSorted((a, b) => a.placedAt - b.placedAt)
  .toReversed()
  .slice(0, 5);
          `,
        ).toEqual([
          {
            $lookup: {
              from: "orders",
              let: { v0_id: "$_id" },
              pipeline: [
                { $match: { $expr: { $eq: ["$userId", "$$v0_id"] } } },
                { $sort: { placedAt: -1 } },
                { $limit: 5 },
              ],
              as: "__jsmql.tmp.1",
            },
          },
          { $unwind: "$__jsmql.tmp.1" },
          { $replaceWith: "$__jsmql.tmp.1" },
        ]);
      },
    );
  },
);

describe(
  "pre-compute a cutoff via `let`, then pivot with a correlated foreign predicate",
  { features: ["Pipelines"] },
  () => {
    it(
      "outer `let` bindings cross the source-switch boundary as $lookup.let vars",
      { kind: "pipeline", usage: "db.users.aggregate(jsmql(...))" },
      () => {
        // Compute a per-user cutoff once, then pivot the stream onto each
        // user's *big* orders. Both the outer-doc field (`$._id`) and the
        // local `let cutoff` are correlated into the foreign sub-pipeline
        // via `$lookup.let`. MongoDB's `$unionWith` couldn't carry the
        // outer-doc context across the source-switch — only the
        // $lookup-pivot lowering can express this shape in MQL.
        expect(
          jsmql`
let minSpend = $.tier === "gold" ? 500 : 100;
$$ = $$$.orders
  .filter(o => o.userId === $._id && o.total > minSpend)
  .toSorted((a, b) => b.placedAt - a.placedAt)
  .slice(0, 10);
          `,
        ).toEqual([
          { $set: { "__jsmql.var.minSpend": { $cond: { if: { $eq: ["$tier", "gold"] }, then: 500, else: 100 } } } },
          {
            $lookup: {
              from: "orders",
              let: { v0_id: "$_id", v0_minSpend: "$__jsmql.var.minSpend" },
              pipeline: [
                {
                  $match: { $expr: { $and: [{ $eq: ["$userId", "$$v0_id"] }, { $gt: ["$total", "$$v0_minSpend"] }] } },
                },
                { $sort: { placedAt: -1 } },
                { $limit: 10 },
              ],
              as: "__jsmql.tmp.1",
            },
          },
          { $unwind: "$__jsmql.tmp.1" },
          { $replaceWith: "$__jsmql.tmp.1" },
        ]);
      },
    );
  },
);

describe("invalid stage placement — validate() catches a misplaced $merge", { features: ["Pipelines"] }, () => {
  it("a materialised-view pipeline that sorts after $merge is rejected at compile time", { kind: "validate" }, () => {
    // Real-world slip: roll daily orders into a summary, write it to a
    // reporting collection, then "sort the result" — but $merge must be the
    // pipeline's last stage, so MongoDB would reject this at run time.
    // jsmql catches it as you compile, with a real `.pos`.
    const r = jsmql.validate(`
        $group({ _id: $.day, revenue: $sum($.total) });
        $merge({ into: "dailyRevenue" });
        $sort({ revenue: -1 });
      `);
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].code).toBe("CODEGEN_ERROR");
    expect(r.errors[0].pos).toBeGreaterThan(0);
    expect(r.errors[0].message).toMatch(/must be the last stage/);
  });
});

// ---------------------------------------------------------------------------
// Pre-flight guard rails — `kind: "err"` examples. Each shows a frequent
// developer mistake that jsmql rejects at compile time (the pipeline-validation
// layer), so the playground can demonstrate the guard with a red error panel
// instead of letting a broken query reach the server. Written in throwing-call
// form so the test verifies the guard AND exposes an extractable `jsmql(...)`
// call for the playground sync. See docs/specs/pipeline-validation.md.
// ---------------------------------------------------------------------------

describe("$group without _id is rejected at compile time", { features: ["Pipelines"] }, () => {
  it(
    "jsmql catches the missing grouping key before the server does",
    { kind: "err", usage: "db.orders.aggregate(jsmql(...))" },
    () => {
      // Beginner slip: forgetting that every $group needs an _id (use `_id: null`
      // to aggregate the whole collection).
      expect(() => jsmql(`$group({ total: $sum($.amount) });`)).toThrow(/'\$group' requires the '_id' field/);
    },
  );
});

describe("$unwind path must start with $", { features: ["Pipelines"] }, () => {
  it(
    "a bare field name is rejected — $unwind takes a field path",
    { kind: "err", usage: "db.orders.aggregate(jsmql(...))" },
    () => {
      // Easy to forget the `$`: $unwind wants a field PATH ("$items"), not a
      // field name ("items").
      expect(() => jsmql(`$unwind("items");`)).toThrow(/path must be a field path starting with '\$'/);
    },
  );
});

describe("$project cannot mix inclusion and exclusion", { features: ["Pipelines"] }, () => {
  it(
    "1-and-0 in the same $project is rejected (except _id)",
    { kind: "err", usage: "db.users.aggregate(jsmql(...))" },
    () => {
      // Classic mistake: trying to keep `name` and drop `internalNote` in one
      // $project. MongoDB allows only all-include or all-exclude (besides _id).
      expect(() => jsmql(`$project({ name: 1, internalNote: 0 });`)).toThrow(
        /cannot mix field inclusion .* and exclusion/,
      );
    },
  );
});

describe("$sort takes 1 or -1, not a SQL-style direction", { features: ["Pipelines"] }, () => {
  it(`a string direction like "desc" is rejected`, { kind: "err", usage: "db.events.aggregate(jsmql(...))" }, () => {
    // SQL habit: writing `"desc"` instead of `-1`. jsmql names the legal values.
    expect(() => jsmql(`$sort({ createdAt: "desc" });`)).toThrow(
      /direction for 'createdAt' must be 1 .* or -1.* got 'desc'/,
    );
  });
});

describe("$merge must be the last stage", { features: ["Pipelines"] }, () => {
  it(
    "sorting after writing the result is rejected at compile time",
    { kind: "err", usage: "db.metrics.aggregate(jsmql(...))" },
    () => {
      // Materialised-view slip: roll up daily revenue, write it out, then "sort
      // the result" — but nothing can run after $merge.
      expect(() =>
        jsmql(`
$group({ _id: $.day, revenue: $sum($.total) });
$merge({ into: "dailyRevenue" });
$sort({ revenue: -1 });
        `),
      ).toThrow(/'\$merge' must be the last stage/);
    },
  );
});

describe("$near is not allowed inside an aggregation $match", { features: ["Pipelines"] }, () => {
  it(
    "the error points at the $geoNear stage to use instead",
    { kind: "err", usage: "db.places.aggregate(jsmql(...))" },
    () => {
      // Query-language habit: `$near` works in `find()` but not in an
      // aggregation `$match`. jsmql names the replacement stage.
      expect(() => jsmql(`$match({ location: { $near: [-73.9, 40.7] } });`)).toThrow(
        /'\$near' is not allowed inside an aggregation '\$match' — use the '\$geoNear' stage/,
      );
    },
  );
});
