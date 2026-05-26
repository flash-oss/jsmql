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
import "../src/ops.ts";

// Teach TS about the playground-metadata keys (`kind`, `usage`, `features`)
// we pass as the 2nd arg to describe()/it(). Vitest already ignores unknown
// options at runtime — this declaration just stops editors from flagging.
// prettier-ignore
declare module "@vitest/runner" { interface TestOptions { kind?: string; usage?: string; features?: string[] } }

describe("top-orders report by department", { features: ["Pipelines"] }, () => {
  it("compiles to the expected MQL", { kind: "pipeline", usage: "db.orders.aggregate(jsmql(...))" }, () => {
    expect(
      jsmql`
$match($.status === "shipped" && $.placedAt >= "2026-01-01");
$lookup({ from: "users", localField: "userId", foreignField: "_id", as: "buyer" });
$unwind($.buyer);
$group({ _id: $.buyer.department, revenue: $sum($.total), orders: $sum(1) });
$set({ avgOrder: $.revenue / $.orders });
$sort({ revenue: -1 });
$limit(3);
      `,
    ).toEqual([
      { $match: { status: "shipped", placedAt: { $gte: "2026-01-01" } } },
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
                      ["$$this", { $add: [{ $ifNull: [{ $getField: { field: "$$this", input: "$$value" } }, 0] }, 1] }],
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
  recent:     $$.filter(o => o.createdAt >= "2026-01-01"),
  byStatus:   $$.filter(o => { $group({ _id: o.status, n: $sum(1) }); }),
};`),
    ).toEqual([
      { $match: { status: "shipped" } },
      {
        $facet: {
          topByScore: [{ $sort: { score: -1 } }, { $limit: 10 }],
          recent: [{ $match: { createdAt: { $gte: "2026-01-01" } } }],
          byStatus: [{ $group: { _id: "$status", n: { $sum: 1 } } }],
        },
      },
    ]);
  });
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
      { $set: { "__jsmql.subtotal": { $multiply: ["$price", "$qty"] } } },
      { $set: { "__jsmql.withTax": { $multiply: ["$__jsmql.subtotal", 1.2] } } },
      { $set: { "__jsmql.withShip": { $add: ["$__jsmql.withTax", "$shipping"] } } },
      { $project: { sku: 1, subtotal: "$__jsmql.subtotal", withTax: "$__jsmql.withTax", final: "$__jsmql.withShip" } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("active premium subscribers", { features: ["Filters"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.subscribers.find(jsmql(...))" }, () => {
    expect(jsmql(`$.subscription.tier === "premium" && $.status === "active" && $.expiresAt > "2026-05-01"`)).toEqual({
      "subscription.tier": "premium",
      status: "active",
      expiresAt: { $gt: "2026-05-01" },
    });
  });
});

describe("recent shipped orders for a customer", { features: ["Filters"] }, () => {
  it("compiles to the expected MQL", { kind: "filter", usage: "db.orders.find(jsmql(...))" }, () => {
    expect(
      jsmql`
$.customerId === "cust_42" &&
$.placedAt >= "2026-01-01" && $.placedAt < "2026-02-01" &&
$.status === "shipped"
      `,
    ).toEqual({
      customerId: "cust_42",
      $and: [{ placedAt: { $gte: "2026-01-01" } }, { placedAt: { $lt: "2026-02-01" } }],
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
    expect(jsmql(`$.pinned !== true && $.lastModifiedAt < "2025-01-01"`)).toEqual({
      pinned: { $ne: true },
      lastModifiedAt: { $lt: "2025-01-01" },
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
      "cart.items.length": { $lt: 20 },
      $expr: {
        $and: [
          { $in: ["$customer.status", ["premium", "gold", "platinum"]] },
          { $eq: [{ $toLower: { $trim: { input: "$customer.region" } } }, "us"] },
        ],
      },
    });
  });
});

describe("admin permission with operand-preserving &&", { features: ["Comparisons and boolean logic"] }, () => {
  it(
    "compiles to the expected MQL",
    { kind: "expression", usage: "db.users.aggregate([{ $addFields: { value: jsmql.expr(...) } }])" },
    () => {
      expect(jsmql.expr(`$.active && $.role.toLowerCase().includes("admin") && $.name.trim().length > 0`)).toEqual({
        $cond: [
          {
            $and: [
              { $ne: ["$active", null] },
              { $ne: ["$active", false] },
              { $ne: ["$active", ""] },
              { $ne: ["$active", 0] },
            ],
          },
          {
            $and: [
              { $gte: [{ $indexOfCP: [{ $toLower: "$role" }, "admin"] }, 0] },
              { $gt: [{ $strLenCP: { $trim: { input: "$name" } } }, 0] },
            ],
          },
          "$active",
        ],
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
                $cond: [
                  { $and: [{ $gte: ["$loyalty.years", 5] }, { $gte: ["$loyalty.totalSpend", 10000] }] },
                  0.85,
                  { $cond: [{ $gte: ["$loyalty.years", 2] }, 0.92, 1] },
                ],
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
        $cond: [
          { $gte: ["$stock", "$reorderPoint"] },
          "ok",
          { $cond: [{ $gt: ["$stock", 0] }, "low", "out-of-stock"] },
        ],
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
        $cond: [
          {
            $and: [{ $gt: ["$quantity", 1] }, { $gte: ["$price", 10] }, { $in: ["$category", ["sale", "clearance"]] }],
          },
          { $multiply: ["$price", 0.8] },
          "$price",
        ],
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
                { $ne: ["$discontinued", null] },
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
          { $toString: { $cond: [{ $eq: [{ $indexOfCP: ["$invoice.id", "INV-VIP-"] }, 0] }, "VIP ", ""] } },
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
                $and: [{ $ne: ["$$v", null] }, { $ne: ["$$v", false] }, { $ne: ["$$v", ""] }, { $ne: ["$$v", 0] }],
              },
            },
          },
          initialValue: "",
          in: {
            $cond: [
              { $eq: ["$$value", ""] },
              { $toString: "$$this" },
              { $concat: ["$$value", " ", { $toString: "$$this" }] },
            ],
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
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$building", null] },
                        { $ne: ["$building", false] },
                        { $ne: ["$building", ""] },
                        { $ne: ["$building", 0] },
                      ],
                    },
                    { $concat: ["$building", ","] },
                    "$building",
                  ],
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
                $and: [{ $ne: ["$$v", null] }, { $ne: ["$$v", false] }, { $ne: ["$$v", ""] }, { $ne: ["$$v", 0] }],
              },
            },
          },
          initialValue: "",
          in: {
            $cond: [
              { $eq: ["$$value", ""] },
              { $toString: "$$this" },
              { $concat: ["$$value", " ", { $toString: "$$this" }] },
            ],
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
            $cond: [
              { $eq: ["$$value", ""] },
              { $toString: "$$this" },
              { $concat: ["$$value", ", ", { $toString: "$$this" }] },
            ],
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
        $cond: [{ $isArray: "$scores" }, { $subtract: [{ $max: "$scores" }, { $min: "$scores" }] }, 0],
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
              ["$$p.category", "$$p.price"],
              ["p", "$$p"],
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
        $cond: [{ $eq: [{ $type: "$value" }, "string"] }, { $trim: { input: "$value" } }, { $toString: "$value" }],
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
          let: { _id: "$_id" },
          pipeline: [{ $match: { $expr: { $eq: ["$userId", "$$_id"] } } }, { $sort: { createdAt: -1 } }, { $limit: 5 }],
          as: "recentOrders",
        },
      },
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.__lookup1" } },
      { $set: { "__jsmql.__lookup1": { $size: "$__jsmql.__lookup1" } } },
      { $set: { "__jsmql.nOrders": "$__jsmql.__lookup1" } },
      { $project: { name: 1, recentOrders: 1, nOrders: "$__jsmql.nOrders" } },
      { $unset: "__jsmql" },
    ]);
  });
});

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
$match($.active === false && $.lastSeen < "2025-01-01");
$$$$.dw.archive_users = $$;
      `,
      ).toEqual([
        { $match: { active: false, lastSeen: { $lt: "2025-01-01" } } },
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
