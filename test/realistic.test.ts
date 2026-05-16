/**
 * Realistic integration tests, organised by JavaScript-syntax feature.
 *
 * Each `describe` covers one jsmql language feature — `Comparisons and
 * boolean logic`, `Optional chaining`, `Pipelines`, `Mutations`, … — and
 * contains one or more `it()` cases that demonstrate the feature in a
 * plausible MongoDB aggregation scenario. The first `it()` of each
 * describe is the canonical showcase: it's what a developer browses to
 * first, and what `scripts/sync-playground.mjs` extracts into the
 * playground sidebar under the describe's feature name.
 *
 * The category — the bit of the describe title before the colon — drives
 * the playground sidebar's section headings; the sidebar's section order
 * follows the describe order in this file. Keep new describes inside the
 * right feature section so the editorial flow stays coherent.
 *
 * This file is referenced from README.md as a usage showcase.
 */

import { describe, it, expect } from "vitest";
import { jsmql, type JsmqlOps } from "../src/index.ts";
// Side-effect import — pulls in the `declare global` block in src/ops.ts so
// the IDE recognises `$match`, `$project`, `$dateDiff`, … as typed
// identifiers inside the test bodies below. In a user's project this is
// `import "@koresar/jsmql/ops";`. The compiled module is `export {};` —
// bundlers tree-shake it. See the "Compile form" describes below for
// end-to-end usage.
import "../src/ops.ts";

// ── Pipelines ────────────────────────────────────────────────────────────────

describe("Pipelines: top-orders report by department", () => {
  // Sales analytics: pick recent shipped orders, attach the buyer document
  // from the users collection, group by department, compute average order
  // size, then keep the top three departments by revenue. Stages are written
  // in the canonical `;`-separated form — one statement per stage — and
  // bodies use plain JS expressions: comparison operators, field refs,
  // arithmetic. The `$match` body is a translatable conjunction of field-
  // vs-literal comparisons, so it emits an index-friendly query document
  // instead of `$expr`.
  it("authors a realistic multi-stage pipeline using JS-expression bodies", () => {
    const result1 = jsmql`
      $match($.status === "shipped" && $.placedAt >= "2026-01-01");
      $lookup({ from: "users", localField: "userId", foreignField: "_id", as: "buyer" });
      $unwind($.buyer);
      $group({ _id: $.buyer.department, revenue: $sum($.total), orders: $sum(1) });
      $set({ avgOrder: $.revenue / $.orders });
      $sort({ revenue: -1 });
      $limit(3);
    `;
    const result2 = jsmql(($, { $match, $lookup, $unwind, $group, $sum, $set, $sort, $limit }) => {
      $match($.status === "shipped" && $.placedAt >= "2026-01-01");
      $lookup({ from: "users", localField: "userId", foreignField: "_id", as: "buyer" });
      $unwind($.buyer);
      $group({ _id: $.buyer.department, revenue: $sum($.total), orders: $sum(1) });
      $set({ avgOrder: $.revenue / $.orders });
      $sort({ revenue: -1 });
      $limit(3);
    });

    expect(result1).toEqual(result2);
    expect(result1).toEqual([
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

describe("Pipelines: count orders by status per shop ($accumulator replacement)", () => {
  // Realistic analytics output: for each shop, a count of orders by status —
  // { pending: 12, paid: 87, refunded: 3 }. The dynamic-keyed object (one
  // key per distinct status value) is the case that pushes people toward
  // $accumulator and server-side JavaScript, since no built-in accumulator
  // builds an object whose keys come from data.
  //
  // jsmql replaces the $accumulator pattern natively: $push the statuses
  // into an array during $group, then $reduce them into an object using
  // object spread and a computed key. The codegen lowers `{ ...acc, [s]: x }`
  // to $mergeObjects + $arrayToObject. The reduce here has `initialValue: {}`
  // and a body that returns an `ObjectLiteral`, so codegen narrows `acc` to
  // object and bracket access on it (`acc[s]`) emits `$getField` directly.
  // Reduce bodies whose type diverges from the initialValue (e.g. a body that
  // returns `x.foo` instead of an object) keep the runtime `$cond` on
  // `$isArray` because the accumulator type is not invariant across iterations.
  it("builds a dynamic-keyed histogram via object spread + computed key in $reduce", () => {
    const result1 = jsmql`
      $group({ _id: $.shopId, statuses: $push($.status) });
      $project({
        counts: $.statuses.reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {})
      });
    `;
    const result2 = jsmql(($, { $group, $project, $push }) => {
      $group({ _id: $.shopId, statuses: $push($.status) });
      $project({
        counts: $.statuses.reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {}),
      });
    });

    expect(result1).toEqual(result2);
    expect(result1).toEqual([
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
                        "$$this",
                        {
                          $add: [
                            {
                              $ifNull: [{ $getField: { field: "$$this", input: "$$value" } }, 0],
                            },
                            1,
                          ],
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

describe("Pipelines: alternative bracketed array form", () => {
  // Same pipeline as the canonical Mutations describe below, written as a
  // bracketed `[ … ]` literal. The two forms compile to the same MQL except
  // for the coalescing rule: adjacent mutation elements inside the array
  // coalesce by kind / read-after-write, while `;` is a hard stage boundary.
  // The bracketed form is offered for cases where you need the pipeline as
  // an array literal value or are pasting verbatim from MongoDB Compass; for
  // new pipelines, prefer the canonical `;` form.
  it("bracketed [...] form compiles to the same pipeline as the canonical form", () => {
    const bracketed = jsmql(`[
      $match($.status === 'pending' && $.paidAt != null),
      $.lineTotal = $.qty * $.unitPrice,
      $.invoiceCount += 1,
      delete $.tempToken,
      delete $._processingState,
      $.status = 'complete'
    ]`);
    const canonical = jsmql(`
      $match($.status === 'pending' && $.paidAt != null);
      $.lineTotal = $.qty * $.unitPrice, $.invoiceCount += 1;
      delete $.tempToken, delete $._processingState;
      $.status = 'complete'
    `);
    expect(bracketed).toEqual(canonical);
  });
});

// ── Mutations ────────────────────────────────────────────────────────────────

describe("Mutations: invoice finalisation pipeline", () => {
  // Read pipeline that selects pending paid invoices, derives a line total and
  // bumps a counter, drops transient processing state, then stamps the final
  // status. Written in the canonical `;`-separated form. Demonstrates mutations
  // interleaved with traditional pipeline stages — the $match boundary flushes
  // any pending mutation buffer, and the run after $match coalesces by kind
  // / read-after-write rules into three stages. Inside one `;`-separated chunk,
  // `,` groups mutations into a single $set; across `;`, mutations stay in
  // separate stages. Exercised in both string and block-body-arrow forms.
  // The function form's parens around the assignment expressions are added by
  // the formatter and are accepted transparently by the parser — see
  // docs/specs/mutations.md.
  it("compiles match → mutate → mutate → mutate to a four-stage pipeline", () => {
    const result1 = jsmql(`
      $match($.status === 'pending' && $.paidAt != null);
      $.lineTotal = $.qty * $.unitPrice, $.invoiceCount += 1;
      delete $.tempToken, delete $._processingState;
      $.status = 'complete'
    `);
    const result2 = jsmql(($, { $match }) => {
      $match($.status === "pending" && $.paidAt != null);
      (($.lineTotal = $.qty * $.unitPrice), ($.invoiceCount += 1));
      (delete $.tempToken, delete $._processingState);
      $.status = "complete";
    });
    expect(result1).toEqual(result2);

    expect(result1).toEqual([
      { $match: { status: "pending", paidAt: { $ne: null } } },
      {
        $set: {
          lineTotal: { $multiply: ["$qty", "$unitPrice"] },
          invoiceCount: { $add: ["$invoiceCount", 1] },
        },
      },
      { $unset: ["tempToken", "_processingState"] },
      { $set: { status: "complete" } },
    ]);
  });
});

// ── Let bindings ─────────────────────────────────────────────────────────────

describe("Let bindings: order pricing with derived helpers + commentary", () => {
  // Realistic order-pricing computation: derive sub-total, tax-inclusive total,
  // and shipping-inclusive total step by step, with each derived value
  // explained by an inline comment. `let` bindings keep the helpers visibly
  // distinct from real document fields and the compiler auto-emits the cleanup
  // $unset at the end of the pipeline.
  it("compiles let-chained derivations into $set/$set/$set + $project + $unset", () => {
    const result = jsmql`
      let subtotal = $.price * $.qty;       // sub-total before tax/shipping
      let withTax  = subtotal * 1.2;        // with tax
      let withShip = withTax + $.shipping;  // with tax and shipping
      $project({ sku: 1, subtotal, withTax, final: withShip });
    `;
    expect(result).toEqual([
      { $set: { "__jsmql.subtotal": { $multiply: ["$price", "$qty"] } } },
      { $set: { "__jsmql.withTax": { $multiply: ["$__jsmql.subtotal", 1.2] } } },
      { $set: { "__jsmql.withShip": { $add: ["$__jsmql.withTax", "$shipping"] } } },
      {
        $project: {
          sku: 1,
          subtotal: "$__jsmql.subtotal",
          withTax: "$__jsmql.withTax",
          final: "$__jsmql.withShip",
        },
      },
      { $unset: "__jsmql" },
    ]);
  });
});

// ── Comparisons and boolean logic ─────────────────────────────────────────────

describe("Comparisons and boolean logic: order eligibility for free shipping", () => {
  it("combines &&, in, .length, and method chains", () => {
    // Customer qualifies for free shipping if:
    //   cart total ≥ $50, loyalty status is premium/gold/platinum,
    //   cart has < 20 items, and region (trimmed, lowercased) is "us"
    const result = jsmql(`
      $.cart.total >= 50 &&
      $.customer.status in ["premium", "gold", "platinum"] &&
      $.cart.items.length < 20 &&
      $.customer.region.trim().toLowerCase() === "us"
    `);

    expect(result).toEqual({
      $and: [
        { $gte: ["$cart.total", 50] },
        { $in: ["$customer.status", ["premium", "gold", "platinum"]] },
        {
          $lt: [
            {
              $cond: [
                { $isArray: "$cart.items" },
                { $size: "$cart.items" },
                { $strLenCP: "$cart.items" },
              ],
            },
            20,
          ],
        },
        { $eq: [{ $toLower: { $trim: { input: "$customer.region" } } }, "us"] },
      ],
    });
  });
});

describe("Comparisons and boolean logic: admin permission with operand-preserving &&", () => {
  it("combines &&, .toLowerCase().includes(), and .trim().length", () => {
    // Active user with an admin role (case-insensitive) and non-empty trimmed name.
    // `$.active` is a non-bool field reference, so `&&` follows JS's
    // operand-preserving rule and folds into a $cond chain. The bool-only
    // tail (`includes && length > 0`) collapses to `$and`.
    const result = jsmql(
      '$.active && $.role.toLowerCase().includes("admin") && $.name.trim().length > 0',
    );

    expect(result).toEqual({
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
  });
});

// ── Ternaries ────────────────────────────────────────────────────────────────

describe("Ternaries: tiered loyalty discount price", () => {
  it("uses nested ternaries, &&, >=, and $round escape hatch", () => {
    // Platinum (≥5 years AND ≥$10k spend): 15% off
    // Gold (≥2 years): 8% off
    // Standard: full price
    // Result rounded to 2 decimal places.
    const result = jsmql(`
      $round(
        $.price * (
          $.loyalty.years >= 5 && $.loyalty.totalSpend >= 10000 ? 0.85 :
          $.loyalty.years >= 2 ? 0.92 : 1
        ),
        2
      )
    `);

    expect(result).toEqual({
      $round: [
        {
          $multiply: [
            "$price",
            {
              $cond: [
                {
                  $and: [{ $gte: ["$loyalty.years", 5] }, { $gte: ["$loyalty.totalSpend", 10000] }],
                },
                0.85,
                { $cond: [{ $gte: ["$loyalty.years", 2] }, 0.92, 1] },
              ],
            },
          ],
        },
        2,
      ],
    });
  });
});

describe("Ternaries: stock status label", () => {
  it("uses nested ternary ? : to classify stock level", () => {
    // Classify stock level: ok / low / out-of-stock
    const result = jsmql('$.stock >= $.reorderPoint ? "ok" : $.stock > 0 ? "low" : "out-of-stock"');

    expect(result).toEqual({
      $cond: [
        { $gte: ["$stock", "$reorderPoint"] },
        "ok",
        { $cond: [{ $gt: ["$stock", 0] }, "low", "out-of-stock"] },
      ],
    });
  });
});

describe("Ternaries: seasonal discount with eligibility check", () => {
  it("uses &&, in, ternary ? :, and * arithmetic", () => {
    // 20% off if item is in sale category AND quantity > 1 AND price >= 10
    const result = jsmql(`
      $.quantity > 1 && $.price >= 10 && $.category in ["sale", "clearance"]
        ? $.price * 0.8
        : $.price
    `);

    expect(result).toEqual({
      $cond: [
        {
          $and: [
            { $gt: ["$quantity", 1] },
            { $gte: ["$price", 10] },
            { $in: ["$category", ["sale", "clearance"]] },
          ],
        },
        { $multiply: ["$price", 0.8] },
        "$price",
      ],
    });
  });
});

// ── Arithmetic and Math ──────────────────────────────────────────────────────

describe("Arithmetic and Math: scientific projection (hypot, log2/log10, sign, cbrt, PI, E)", () => {
  it("derives geometric, audio, and trend metrics in a single $project shape", () => {
    // distance: 2D Euclidean distance from origin
    // octave:   octaves above A4 (440 Hz)
    // decibels: amplitude relative to 1.0 in dB
    // fovRad:   field-of-view degrees converted to radians
    // growthFactor: continuous-compound multiplier for a given rate
    // trend:    -1 / 0 / +1 indicator from period-over-period delta
    // cubeSide: characteristic length from a 3D volume
    const result = jsmql(`
      {
        distance: Math.hypot($.point.x - $.origin.x, $.point.y - $.origin.y),
        octave: Math.log2($.frequency / 440),
        decibels: Math.log10($.amplitude) * 20,
        fovRad: $.fovDeg * Math.PI / 180,
        growthFactor: Math.E ** $.rate,
        trend: Math.sign($.delta),
        cubeSide: Math.cbrt($.volume)
      }
    `);

    expect(result).toEqual({
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
      fovRad: { $divide: [{ $multiply: ["$fovDeg", Math.PI] }, 180] },
      growthFactor: { $pow: [Math.E, "$rate"] },
      trend: { $cmp: ["$delta", 0] },
      cubeSide: { $pow: ["$volume", { $divide: [1, 3] }] },
    });
  });
});

describe("Arithmetic and Math: reorder alert with ** and unary !", () => {
  it("uses unary !, ** exponentiation, and < comparison", () => {
    // Alert if: not discontinued AND stock below reorder threshold (exponential decay model)
    // `!$.discontinued` follows JS truthiness — `discontinued: 0` would be
    // treated as falsy (not discontinued) just like in JS, even though MQL's
    // raw `$not` would coerce 0 differently.
    const result = jsmql("!$.discontinued && $.stock < $.baseReorder * 2 ** $.urgencyLevel");

    expect(result).toEqual({
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
        {
          $lt: ["$stock", { $multiply: ["$baseReorder", { $pow: [2, "$urgencyLevel"] }] }],
        },
      ],
    });
  });
});

describe("Arithmetic and Math: score normalisation with grouping", () => {
  it("uses arithmetic operators and grouping", () => {
    // Normalise score to 0–100 range: (score - min) / (max - min) * 100
    const result = jsmql("($.score - $.minScore) / ($.maxScore - $.minScore) * 100");

    expect(result).toEqual({
      $multiply: [
        {
          $divide: [
            { $subtract: ["$score", "$minScore"] },
            { $subtract: ["$maxScore", "$minScore"] },
          ],
        },
        100,
      ],
    });
  });
});

describe("Arithmetic and Math: age decade bucket via Math.floor", () => {
  it("uses Math.floor() and * arithmetic", () => {
    // Round age down to nearest decade: Math.floor(age / 10) * 10
    const result = jsmql("Math.floor($.age / 10) * 10");

    expect(result).toEqual({
      $multiply: [{ $floor: { $divide: ["$age", 10] } }, 10],
    });
  });
});

describe("Arithmetic and Math: invoice line total with compound tax", () => {
  it("uses JS arithmetic operators and $round escape hatch", () => {
    // lineTotal = round(qty * (unitPrice + unitPrice * taxRate), 2)
    const result = jsmql("$round($.quantity * ($.unitPrice + $.unitPrice * $.taxRate), 2)");

    expect(result).toEqual({
      $round: [
        {
          $multiply: [
            "$quantity",
            { $add: ["$unitPrice", { $multiply: ["$unitPrice", "$taxRate"] }] },
          ],
        },
        2,
      ],
    });
  });
});

// ── String methods ───────────────────────────────────────────────────────────

describe("String methods: URL slug via .toLowerCase().trim().replaceAll()", () => {
  it("uses String() cast, + string concatenation, and method chaining", () => {
    // Build a URL slug: "<articleId>-<normalised-title>"
    const result = jsmql(
      'String($.articleId) + "-" + $.title.toLowerCase().trim().replaceAll(" ", "-")',
    );

    expect(result).toEqual({
      $concat: [
        { $toString: "$articleId" },
        "-",
        {
          $replaceAll: {
            input: { $trim: { input: { $toLower: "$title" } } },
            find: " ",
            replacement: "-",
          },
        },
      ],
    });
  });
});

describe("String methods: email domain via .split().at().toLowerCase()", () => {
  it("chains .split(), .at(), .toLowerCase()", () => {
    // Extract and normalise the domain part of an email address
    const result = jsmql('$.email.split("@").at(1).toLowerCase()');

    expect(result).toEqual({
      $toLower: { $arrayElemAt: [{ $split: ["$email", "@"] }, 1] },
    });
  });
});

describe("String methods: CSV field word count", () => {
  it("uses .split().length — known array context resolves to $size", () => {
    // Count the number of comma-separated values in a CSV field
    const result = jsmql('$.tags.split(",").length');

    expect(result).toEqual({ $size: { $split: ["$tags", ","] } });
  });
});

// ── Template literals ────────────────────────────────────────────────────────

describe("Template literals: invoice line greeting with ?., ??, and .startsWith", () => {
  it("composes a personalised greeting with safe nested access", () => {
    // Build a string like "Hi Ada — your VIP invoice INV-2024-001 is ready"
    // using template literals, optional chaining for nested fields that may be missing,
    // and .startsWith for a common prefix check.
    const result = jsmql(
      "`Hi ${$.customer?.firstName ?? 'there'} — your " +
        "${$.invoice.id.startsWith('INV-VIP-') ? 'VIP ' : ''}invoice ${$.invoice.id} is ready`",
    );

    expect(result).toEqual({
      $concat: [
        "Hi ",
        { $toString: { $ifNull: ["$customer.firstName", "there"] } },
        " — your ",
        {
          $toString: {
            $cond: [{ $eq: [{ $indexOfCP: ["$invoice.id", "INV-VIP-"] }, 0] }, "VIP ", ""],
          },
        },
        "invoice ",
        { $toString: "$invoice.id" },
        " is ready",
      ],
    });
  });
});

describe("Template literals: audit log line with .toISOString and .charAt(0).toUpperCase", () => {
  it("formats an ISO-timestamped log line with a single-letter level prefix", () => {
    // Render lines like "2024-09-01T12:30:00.000Z [E] disk full".
    const result = jsmql(
      "`${$.event.ts.toISOString()} [${$.event.level.charAt(0).toUpperCase()}] ${$.event.message}`",
    );

    expect(result).toEqual({
      $concat: [
        { $dateToString: { date: "$event.ts", format: "%Y-%m-%dT%H:%M:%S.%LZ" } },
        " [",
        { $toUpper: { $substrCP: ["$event.level", 0, 1] } },
        "] ",
        // $.event.message is a FieldRef of unknown type — wrapped to avoid runtime
        // errors if it isn't a string.
        { $toString: "$event.message" },
      ],
    });
  });
});

// ── Array methods ────────────────────────────────────────────────────────────

describe("Array methods: most-recent event timestamp via .flatMap.map.reduce", () => {
  it("computes the most-recent-event timestamp across all sessions", () => {
    // For a doc with sessions: [{ events: [{ ts }, ...] }, ...], extract the
    // newest event timestamp and report seconds since now.
    const result = jsmql(`
      $.sessions
        .flatMap(s => s.events)
        .map(e => e.ts.getTime())
        .reduce((acc, t) => Math.max(acc, t), 0)
    `);

    expect(result).toEqual({
      $reduce: {
        input: {
          $map: {
            input: {
              $reduce: {
                input: {
                  $map: { input: "$sessions", as: "s", in: "$$s.events" },
                },
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
  });
});

describe("Array methods: cart subtotal via .map.reduce", () => {
  it("sums item totals using .map() and .reduce()", () => {
    // Sum up all item totals: items.map(item => item.qty * item.price).reduce((acc, x) => acc + x, 0)
    const result = jsmql(
      "$.items.map(item => item.qty * item.price).reduce((acc, x) => acc + x, 0)",
    );

    expect(result).toEqual({
      $reduce: {
        input: {
          $map: {
            input: "$items",
            as: "item",
            in: { $multiply: ["$$item.qty", "$$item.price"] },
          },
        },
        initialValue: 0,
        in: { $add: ["$$value", "$$this"] },
      },
    });
  });
});

describe("Array methods: full display name via .filter(Boolean).join", () => {
  it("uses bare-Boolean filter callback and .join() to compose a display name", () => {
    // Build "First Middle Last" but drop any missing/empty parts so we don't
    // end up with double spaces. Same pattern as in plain JS:
    //   [first, middle, last].filter(Boolean).join(" ")
    // `Boolean` follows JS truthy/falsy rules — empty strings, null, and
    // missing fields are dropped. See codegen.ts `jsBool()`.
    const result = jsmql('[$.firstName, $.middleName, $.lastName].filter(Boolean).join(" ")');

    expect(result).toEqual({
      $reduce: {
        input: {
          $filter: {
            input: ["$firstName", "$middleName", "$lastName"],
            as: "v",
            cond: {
              $and: [
                { $ne: ["$$v", null] },
                { $ne: ["$$v", false] },
                { $ne: ["$$v", ""] },
                { $ne: ["$$v", 0] },
              ],
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
  });
});

describe("Array methods: full address with conditional inclusion + filter + join", () => {
  it("uses && to conditionally include the building line and Boolean to drop empties", () => {
    // Assembles up to 7 address fields into a single space-separated string.
    // The optional building name (e.g. "Suite 4,") is included only when present.
    // MongoDB executes this entirely — no need to fetch all fields to the client.
    const result = jsmql(`
      [$.building && $.building + ",", $.streetNo, $.street, $.suburb, $.state, $.country, $.postcode]
        .filter(Boolean)
        .join(" ")
    `);

    // `$.building && $.building + ","` follows JS operand-preservation —
    // returns the suffix when truthy, the building value (which is then
    // dropped by the filter) when falsy. `.filter(Boolean)` uses JS truthy/
    // falsy via the jsBool wrapper, so empty/null/missing fields drop out.
    expect(result).toEqual({
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
              $and: [
                { $ne: ["$$v", null] },
                { $ne: ["$$v", false] },
                { $ne: ["$$v", ""] },
                { $ne: ["$$v", 0] },
              ],
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
  });
});

describe("Array methods: tag aggregation via .map.flat.join", () => {
  it("collects all post tags into a single comma-separated string", () => {
    // Posts each carry a tags array; flatten them all into one list and render as CSV.
    const result = jsmql('$.posts.map(p => p.tags).flat().join(", ")');

    expect(result).toEqual({
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
  });
});

describe("Array methods: immutable replace and indexed map via .with / (x, i)", () => {
  it("replaces a roster entry by index and projects (name, position) pairs", () => {
    // A roster sub-document carries a fixed-position lineup. When a player
    // is swapped out we need an immutable replacement at the same slot, and
    // we want to project (name, slot) pairs for the UI. .with() and the new
    // (element, index) callback shape cover both cleanly.
    const result = jsmql(`{
      lineup: $.roster.with($.swap.slot, $.swap.in),
      labelled: $.roster.map((p, i) => ({ slot: i, name: p.name })),
    }`);

    expect(result).toEqual({
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
                  {
                    $max: [
                      0,
                      {
                        $subtract: [{ $size: "$$jsmqlArr" }, { $add: ["$$jsmqlIdx", 1] }],
                      },
                    ],
                  },
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
              vars: {
                p: { $arrayElemAt: ["$$jsmqlPair", 1] },
                i: { $arrayElemAt: ["$$jsmqlPair", 0] },
              },
              in: { slot: "$$i", name: "$$p.name" },
            },
          },
        },
      },
    });
  });
});

describe("Array methods: file upload validation with [literal].includes + .endsWith", () => {
  it("checks extension whitelist, name match, and size cap", () => {
    // Reject upload unless the lowercased extension is in the allowlist,
    // the filename actually ends with that extension, and size is ≤ 25 MB.
    const result = jsmql(`
      [".jpg", ".png", ".pdf", ".docx"].includes($.file.ext.toLowerCase()) &&
      $.file.name.endsWith($.file.ext) &&
      $.file.size <= 25_000_000
    `);

    expect(result).toEqual({
      $and: [
        { $in: [{ $toLower: "$file.ext" }, [".jpg", ".png", ".pdf", ".docx"]] },
        {
          $eq: [
            {
              $substrCP: [
                "$file.name",
                {
                  $subtract: [{ $strLenCP: "$file.name" }, { $strLenCP: "$file.ext" }],
                },
                { $strLenCP: "$file.ext" },
              ],
            },
            "$file.ext",
          ],
        },
        { $lte: ["$file.size", 25000000] },
      ],
    });
  });
});

// ── Optional chaining ────────────────────────────────────────────────────────

describe("Optional chaining: chat moderation with ?. inside an array spread", () => {
  it("uses ?. so a missing nested array doesn't poison the moderator check", () => {
    // Real chat-room ACL check: is the current user a moderator? Authority can
    // come from (a) the workspace-level moderators list, (b) the room's own
    // moderators list (room may not exist for DMs), or (c) the hard-coded root
    // user. Without `?.`, `[...$.room.mods]` against a missing `$.room` would
    // collapse `$concatArrays` to null and crash the surrounding `$in`. `?.`
    // wraps the spread argument so the missing-room branch produces `[]`.
    const result = jsmql(`[...$.moderators, ...$.room?.mods, "root"].includes($.userId)`);

    expect(result).toEqual({
      $in: [
        "$userId",
        {
          $concatArrays: ["$moderators", { $ifNull: ["$room.mods", []] }, ["root"]],
        },
      ],
    });
  });
});

describe("Optional chaining: ?. inside a template literal", () => {
  it("falls back to empty string for missing nested fields in a template", () => {
    // Display label for a user row: prefer "First Last", but some accounts have
    // only one of the two names set, and some legacy rows don't have a `name`
    // sub-document at all. With `?.`, missing fields contribute `""` to the
    // `$concat` instead of poisoning it to `null`.
    const result = jsmql("`${$.name?.first} ${$.name?.last}`.trim()");

    expect(result).toEqual({
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
  });
});

// ── Nullish coalescing ───────────────────────────────────────────────────────

describe("Nullish coalescing: full name with three-step ?? fallback chain", () => {
  it("uses ?? chaining and .at(0) for the first alias", () => {
    // Display first name, falling back to first alias, then "anonymous".
    // .at(0) compiles to a compact $arrayElemAt; $.aliases[0] would emit a
    // runtime $cond on $isArray since the receiver type isn't statically known.
    const result = jsmql('$.firstName ?? $.aliases.at(0) ?? "anonymous"');

    expect(result).toEqual({
      $ifNull: ["$firstName", { $arrayElemAt: ["$aliases", 0] }, "anonymous"],
    });
  });
});

describe("Nullish coalescing: formatted date label with ?? chain", () => {
  it("chains ?? to fall back through date fields to a default string", () => {
    // Display date as "YYYY-MM-DD", falling back through alternatives to "unknown"
    const result = jsmql(`
      $dateToString({ date: $.publishedAt, format: "%Y-%m-%d" }) ??
      $dateToString({ date: $.createdAt, format: "%Y-%m-%d" }) ??
      "unknown"
    `);

    expect(result).toEqual({
      $ifNull: [
        { $dateToString: { date: "$publishedAt", format: "%Y-%m-%d" } },
        { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } },
        "unknown",
      ],
    });
  });
});

// ── Array spread ─────────────────────────────────────────────────────────────

describe("Array spread: moderator membership check via [...a, ...b]", () => {
  it("checks if user is in the combined moderator list for a thread", () => {
    // A thread's effective moderators are: thread-specific mods, room-wide mods,
    // plus a hard-coded root user. Array spread is the natural JS form for
    // building this combined list, then .includes() checks membership.
    const result = jsmql('[...$.moderators, ...$.room.mods, "root"].includes($.userId)');

    expect(result).toEqual({
      $in: ["$userId", { $concatArrays: ["$moderators", "$room.mods", ["root"]] }],
    });
  });
});

describe("Array spread: Math.max(...arr) - Math.min(...arr) with Array.isArray guard", () => {
  it("computes max-min via spread, falling back to 0 when scores is missing", () => {
    // Using ...spread to pass the array as variadic args to Math.max / Math.min.
    // Array.isArray defends against documents where scores isn't an array.
    const result = jsmql(`
      Array.isArray($.scores) ? Math.max(...$.scores) - Math.min(...$.scores) : 0
    `);

    expect(result).toEqual({
      $cond: [
        { $isArray: "$scores" },
        { $subtract: [{ $max: "$scores" }, { $min: "$scores" }] },
        0,
      ],
    });
  });
});

// ── Object literals and computed keys ────────────────────────────────────────

describe("Object literals: dynamic pivot row with computed key + shorthand property", () => {
  it("turns each product into a dict keyed by category, plus the original record", () => {
    // [{category:'A', price:1}] → [{ A: 1, p: { category:'A', price:1 } }]
    // The shorthand `p` is sugar for `p: p`, which resolves to `p: $$p` in lambda scope.
    const result = jsmql("$.products.map(p => ({ [p.category]: p.price, p }))");

    expect(result).toEqual({
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
  });
});

describe("Object literals: pivot table row via Object.fromEntries(.map(...))", () => {
  it("turns an array of {k,v} pairs into a wide row", () => {
    // Aggregating an array of `{ name, value }` pairs into one object keyed by `name`.
    const result = jsmql("Object.fromEntries($.metrics.map(m => [m.name, m.value]))");
    expect(result).toEqual({
      $arrayToObject: {
        $map: {
          input: "$metrics",
          as: "m",
          in: ["$$m.name", "$$m.value"],
        },
      },
    });
  });
});

// ── Numeric separators ───────────────────────────────────────────────────────

describe("Numeric separators: shopping cart total with 10_000 cap", () => {
  it("accumulates with a clearly-formatted threshold", () => {
    // Cap line total at $10,000 (written as 10_000 for readability).
    const result = jsmql("Math.min(10_000, $.lines.reduce((sum, l) => sum + l.qty * l.price, 0))");
    expect(result).toEqual({
      $min: [
        10000,
        {
          $reduce: {
            input: "$lines",
            initialValue: 0,
            in: {
              $add: ["$$value", { $multiply: ["$$this.qty", "$$this.price"] }],
            },
          },
        },
      ],
    });
  });
});

// ── Type checks and casts ────────────────────────────────────────────────────

describe("Type checks and casts: normalise a string-or-number field with typeof", () => {
  it("uses typeof in ternary to coerce mixed-type input", () => {
    // Return trimmed string if already a string, else convert to string
    const result = jsmql('typeof $.value === "string" ? $.value.trim() : String($.value)');

    expect(result).toEqual({
      $cond: [
        { $eq: [{ $type: "$value" }, "string"] },
        { $trim: { input: "$value" } },
        { $toString: "$value" },
      ],
    });
  });
});

// ── Date and time ────────────────────────────────────────────────────────────

describe("Date and time: days since last login (Math.abs + $dateDiff + ?? + new Date)", () => {
  it("uses Math.abs, $dateDiff escape hatch, ??, and new Date()", () => {
    // Days since last login; -1 if never logged in; always non-negative
    const result = jsmql(
      "Math.abs($dateDiff({ startDate: $.lastLoginAt, endDate: new Date(), unit: 'day' }) ?? -1)",
    );

    expect(result).toEqual({
      $abs: {
        $ifNull: [
          { $dateDiff: { startDate: "$lastLoginAt", endDate: { $toDate: "$$NOW" }, unit: "day" } },
          -1,
        ],
      },
    });
  });
});

describe("Date and time: days since document was created", () => {
  it("uses $dateDiff escape hatch with new Date() for current time", () => {
    // Days since the document was first created. Uses the function form with the
    // operator destructured from the second parameter so the IDE doesn't flag
    // `$dateDiff` as an unknown identifier.
    const result = jsmql(($, { $dateDiff }) =>
      $dateDiff({ startDate: $.createdAt, endDate: new Date(), unit: "day" }),
    );

    expect(result).toEqual({
      $dateDiff: { startDate: "$createdAt", endDate: { $toDate: "$$NOW" }, unit: "day" },
    });
  });
});

describe("Date and time: days since event (Date.now + .getTime + 86_400_000)", () => {
  it("computes whole days elapsed since an event timestamp", () => {
    // Date.now() returns ms since epoch — same as JS — and so does .getTime().
    // 86_400_000 = 24 * 60 * 60 * 1000 ms in a day.
    const result = jsmql("Math.floor((Date.now() - $.event.ts.getTime()) / 86_400_000)");

    expect(result).toEqual({
      $floor: {
        $divide: [{ $subtract: [{ $toLong: "$$NOW" }, { $toLong: "$event.ts" }] }, 86400000],
      },
    });
  });
});

// ── Comments ─────────────────────────────────────────────────────────────────

describe("Comments: annotated insurance underwriting rule with // and /* */", () => {
  it("compiles a multi-line rule with inline comments to the same MQL as a comment-free version", () => {
    // Real underwriting check: applicant qualifies for the standard tier if
    // they're the right age, drive a sane number of km/year, and aren't in
    // a high-risk occupation. Comments document the business rules inline.
    const result = jsmql(`
      // age window: 25 to 70 inclusive
      $.driver.age >= 25 && $.driver.age <= 70 &&

      /* annual mileage cap — 30k km/year keeps us out of commercial-fleet pricing */
      $.policy.kmPerYear <= 30_000 &&

      // hard-list occupations that bump the applicant to the high-risk tier
      !($.driver.occupation in ["stunt-double", "test-pilot", "demolition-engineer"])
    `);

    expect(result).toEqual({
      $and: [
        { $gte: ["$driver.age", 25] },
        { $lte: ["$driver.age", 70] },
        { $lte: ["$policy.kmPerYear", 30000] },
        {
          $not: {
            $in: ["$driver.occupation", ["stunt-double", "test-pilot", "demolition-engineer"]],
          },
        },
      ],
    });
  });
});

// ── IIFE ─────────────────────────────────────────────────────────────────────

describe("IIFE: discount breakdown — bind once, reuse across fields", () => {
  it("binds the discount once and reuses it across three projected fields", () => {
    // A $project-style row that needs the same computed value (the discount amount)
    // in three places: the final price, the raw savings, and the savings percentage.
    // Writing this as an IIFE lets `$let` bind the value once instead of repeating
    // `$.price * (1 - $.loyalty.multiplier)` in every field.
    const result1 = jsmql(`
      ((discount) => ({
        finalPrice: $.price - discount,
        savings: discount,
        savingsPercent: Math.round((discount / $.price) * 100),
      }))($.price * (1 - $.loyalty.multiplier))
    `);
    const result2 = jsmql(($) =>
      ((discount) => ({
        finalPrice: $.price - discount,
        savings: discount,
        savingsPercent: Math.round((discount / $.price) * 100),
      }))($.price * (1 - $.loyalty.multiplier)),
    );
    expect(result1).toEqual(result2);

    expect(result1).toEqual({
      $let: {
        vars: {
          discount: {
            $multiply: ["$price", { $subtract: [1, "$loyalty.multiplier"] }],
          },
        },
        in: {
          finalPrice: { $subtract: ["$price", "$$discount"] },
          savings: "$$discount",
          savingsPercent: {
            $round: [{ $multiply: [{ $divide: ["$$discount", "$price"] }, 100] }, 0],
          },
        },
      },
    });
  });
});

// ── Escape hatch (direct $op form) ───────────────────────────────────────────

describe("Escape hatch: $round of $sum as a plain expression", () => {
  it("group-stage accumulator: $sum over a field, $round to 2dp", () => {
    // Inside $group, $sum over a single field is the accumulator form.
    // $round wraps the result to 2 decimal places. Both rely on flex shape.
    const result = jsmql("$round($sum($.lineTotal), 2)");
    expect(result).toEqual({
      $round: [{ $sum: "$lineTotal" }, 2],
    });
  });

  it("project-stage expression: $max picks the largest of several fields", () => {
    // Inside $project, $max with multiple args returns the max across expressions.
    const result = jsmql("$max($.basePrice, $.salePrice, $.competitorPrice)");
    expect(result).toEqual({
      $max: ["$basePrice", "$salePrice", "$competitorPrice"],
    });
  });

  it("merging two snapshots: $mergeObjects in expression context", () => {
    // Layering a partial update onto a base document.
    const result = jsmql("$mergeObjects($.base, $.patch)");
    expect(result).toEqual({
      $mergeObjects: ["$base", "$patch"],
    });
  });
});

describe("Escape hatch: $toLower wrapping a string-context +", () => {
  it("uses string-context + and $toLower escape hatch", () => {
    // Lowercase "FirstName LastName" for use as a display handle
    const result = jsmql('$toLower($.firstName + " " + $.lastName)');

    expect(result).toEqual({
      $toLower: { $concat: ["$firstName", " ", "$lastName"] },
    });
  });
});

// ── Template tag ─────────────────────────────────────────────────────────────

describe("Template tag: parameterised threshold query", () => {
  it("interpolates JS values into a JS-syntax expression", () => {
    const minScore = 75;
    const passingGrades = ["A", "B"];
    const result = jsmql`
      $.score >= ${minScore} &&
      $.grade in ${passingGrades} &&
      $.submitted === true
    `;

    expect(result).toEqual({
      $and: [
        { $gte: ["$score", 75] },
        { $in: ["$grade", ["A", "B"]] },
        { $eq: ["$submitted", true] },
      ],
    });
  });
});

// ── Compile form ─────────────────────────────────────────────────────────────

describe("Compile form: reusable eligible-users query via jsmql.compile", () => {
  // A query that runs many times a day with different filters: today's eligible
  // customers in a specific region above a minimum age. Compile once, bind per
  // request. The output is index-friendly: the $match emits MongoDB
  // query-language form so existing indexes on `age` and `region` keep
  // working, even though the values are dynamic.
  it("compiles once and binds different params per call", () => {
    const eligibleUsersQuery = jsmql.compile(
      (
        { minAge, region }: { minAge: number; region: string },
        $,
        { $match, $project }: JsmqlOps,
      ) => [
        $match($.age >= minAge && $.region === region && $.status === "active"),
        $project({ id: $._id, name: $.name, email: $.email }),
      ],
    );

    expect(eligibleUsersQuery({ minAge: 21, region: "AU" })).toEqual([
      { $match: { age: { $gte: 21 }, region: "AU", status: "active" } },
      { $project: { id: "$_id", name: "$name", email: "$email" } },
    ]);

    // Reuse with a different binding set — no re-parse, just a fresh codegen
    // walk that inlines the new values as literals.
    expect(eligibleUsersQuery({ minAge: 65, region: "US" })).toEqual([
      { $match: { age: { $gte: 65 }, region: "US", status: "active" } },
      { $project: { id: "$_id", name: "$name", email: "$email" } },
    ]);
  });
});

describe('Compile form: ambient ops via `import "@koresar/jsmql/ops"`', () => {
  // Same pipeline as the previous block, but with no per-callsite ops-hint
  // destructure. The user adds a single `import "@koresar/jsmql/ops";` line at
  // the top of the file and `$match`, `$project`, etc. become ambient globals
  // visible across the project — IDE autocomplete and typo-check work
  // without manually listing names. Runtime is identical: the parser strips
  // the function body and recognises bare `$stage(...)` calls via STAGES.
  it("works without an ops-hint destructure", () => {
    const eligibleUsersQuery = jsmql.compile(
      ({ minAge, region }: { minAge: number; region: string }, $) => [
        $match($.age >= minAge && $.region === region && $.status === "active"),
        $project({ id: $._id, name: $.name, email: $.email }),
      ],
    );

    expect(eligibleUsersQuery({ minAge: 21, region: "AU" })).toEqual([
      { $match: { age: { $gte: 21 }, region: "AU", status: "active" } },
      { $project: { id: "$_id", name: "$name", email: "$email" } },
    ]);
  });
});

// ── Validate ─────────────────────────────────────────────────────────────────

describe("jsmql.validate(): realistic error cases", () => {
  it("rejects bare field name without $. prefix", () => {
    // A common mistake: forgetting the $. prefix
    const src = "age > 18";
    const result = jsmql.validate(src);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/Did you mean/);
    expect(result.errors[0].pos).toBeGreaterThanOrEqual(0);
    expect(result.errors[0].pos).toBeLessThan(src.length);
  });

  it("rejects unterminated expression", () => {
    const src = "$.score >= 90 &&";
    const result = jsmql.validate(src);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].pos).toBeGreaterThanOrEqual(0);
    expect(result.errors[0].pos).toBeLessThanOrEqual(src.length);
  });

  it("rejects scalar on right-hand side of in", () => {
    const src = '$.status in "active"';
    const result = jsmql.validate(src);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/Right-hand side of 'in'/);
    expect(result.errors[0].pos).toBeGreaterThanOrEqual(0);
    expect(result.errors[0].pos).toBeLessThan(src.length);
  });

  it("accepts a realistic valid expression", () => {
    const result = jsmql.validate(
      '$.age >= 18 && $.age <= 65 && $.status in ["active", "pending"]',
    );
    expect(result.valid).toBe(true);
  });

  it("accepts an arrow function", () => {
    const result = jsmql.validate(({ age }, $) => {
      age = $dateDiff({ startDate: $.dob, endDate: new Date(), unit: "year" });
      $match(age > age);
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("SYNTAX_ERROR");
    expect(result.errors[0].message).toMatch(/\$\.age/);
  });
});
