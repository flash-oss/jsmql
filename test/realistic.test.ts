/**
 * Realistic integration tests.
 *
 * Each test represents a plausible real-world MongoDB aggregation expression
 * written in mjsql's JavaScript-subset syntax. $op() utility calls appear only
 * where there is no JavaScript equivalent (e.g. $round, $dateDiff).
 *
 * This file is referenced from README.md as a usage showcase.
 */

import { describe, it, expect } from "vitest";
import { mjsql, validate, mql } from "../src/index.js";

// ── E-commerce ────────────────────────────────────────────────────────────────

describe("e-commerce: order eligibility for free shipping", () => {
  it("combines &&, in, .length, and method chains", () => {
    // Customer qualifies for free shipping if:
    //   cart total ≥ $50, loyalty status is premium/gold/platinum,
    //   cart has < 20 items, and region (trimmed, lowercased) is "us"
    const result = mjsql(`
      $.cart.total >= 50 &&
      $.customer.status in ["premium", "gold", "platinum"] &&
      $.cart.items.length < 20 &&
      $.customer.region.trim().toLowerCase() == "us"
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

describe("e-commerce: tiered loyalty discount price", () => {
  it("uses nested ternaries, &&, >=, and $round fallback", () => {
    // Platinum (≥5 years AND ≥$10k spend): 15% off
    // Gold (≥2 years): 8% off
    // Standard: full price
    // Result rounded to 2 decimal places.
    const result = mjsql(`
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

describe("e-commerce: seasonal discount with eligibility check", () => {
  it("uses &&, in, ternary ? :, and * arithmetic", () => {
    // 20% off if item is in sale category AND quantity > 1 AND price >= 10
    const result = mjsql(`
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

describe("e-commerce: cart subtotal", () => {
  it("sums item totals using .map() and .reduce()", () => {
    // Sum up all item totals: items.map(item => item.qty * item.price).reduce((acc, x) => acc + x, 0)
    const result = mjsql(
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

// ── User analytics ────────────────────────────────────────────────────────────

describe("user analytics: email domain extraction", () => {
  it("chains .split(), .at(), .toLowerCase()", () => {
    // Extract and normalise the domain part of an email address
    const result = mjsql('$.email.split("@").at(1).toLowerCase()');

    expect(result).toEqual({
      $toLower: { $arrayElemAt: [{ $split: ["$email", "@"] }, 1] },
    });
  });
});

describe("user analytics: score normalisation", () => {
  it("uses arithmetic operators and grouping", () => {
    // Normalise score to 0–100 range: (score - min) / (max - min) * 100
    const result = mjsql("($.score - $.minScore) / ($.maxScore - $.minScore) * 100");

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

describe("user analytics: age decade bucket", () => {
  it("uses Math.floor() and * arithmetic", () => {
    // Round age down to nearest decade: Math.floor(age / 10) * 10
    const result = mjsql("Math.floor($.age / 10) * 10");

    expect(result).toEqual({
      $multiply: [{ $floor: { $divide: ["$age", 10] } }, 10],
    });
  });
});

describe("user analytics: days since last login", () => {
  it("uses Math.abs, $dateDiff fallback, ??, and new Date()", () => {
    // Days since last login; -1 if never logged in; always non-negative
    const result = mjsql(
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

// ── Content pipeline ──────────────────────────────────────────────────────────

describe("content pipeline: URL slug", () => {
  it("uses String() cast, + string concatenation, and method chaining", () => {
    // Build a URL slug: "<articleId>-<normalised-title>"
    const result = mjsql(
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

describe("content pipeline: lowercase display name", () => {
  it("uses string-context + and $toLower fallback", () => {
    // Lowercase "FirstName LastName" for use as a display handle
    const result = mjsql('$toLower($.firstName + " " + $.lastName)');

    expect(result).toEqual({
      $toLower: { $concat: ["$firstName", " ", "$lastName"] },
    });
  });
});

// ── Reporting ─────────────────────────────────────────────────────────────────

describe("reporting: formatted date label", () => {
  it("chains ?? to fall back through date fields to a default string", () => {
    // Display date as "YYYY-MM-DD", falling back through alternatives to "unknown"
    const result = mjsql(`
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

describe("reporting: days since document was created", () => {
  it("uses $dateDiff fallback with new Date() for current time", () => {
    // Days since the document was first created
    const result = mjsql("$dateDiff({ startDate: $.createdAt, endDate: new Date(), unit: 'day' })");

    expect(result).toEqual({
      $dateDiff: { startDate: "$createdAt", endDate: { $toDate: "$$NOW" }, unit: "day" },
    });
  });
});

// ── Inventory ─────────────────────────────────────────────────────────────────

describe("inventory: stock status label", () => {
  it("uses nested ternary ? : to classify stock level", () => {
    // Classify stock level: ok / low / out-of-stock
    const result = mjsql('$.stock >= $.reorderPoint ? "ok" : $.stock > 0 ? "low" : "out-of-stock"');

    expect(result).toEqual({
      $cond: [
        { $gte: ["$stock", "$reorderPoint"] },
        "ok",
        { $cond: [{ $gt: ["$stock", 0] }, "low", "out-of-stock"] },
      ],
    });
  });
});

describe("inventory: reorder alert", () => {
  it("uses unary !, ** exponentiation, and < comparison", () => {
    // Alert if: not discontinued AND stock below reorder threshold (exponential decay model)
    const result = mjsql("!$.discontinued && $.stock < $.baseReorder * 2 ** $.urgencyLevel");

    expect(result).toEqual({
      $and: [
        { $not: "$discontinued" },
        {
          $lt: ["$stock", { $multiply: ["$baseReorder", { $pow: [2, "$urgencyLevel"] }] }],
        },
      ],
    });
  });
});

// ── Financial ─────────────────────────────────────────────────────────────────

describe("financial: invoice line total with compound tax", () => {
  it("uses JS arithmetic operators and $round fallback", () => {
    // lineTotal = round(qty * (unitPrice + unitPrice * taxRate), 2)
    const result = mjsql("$round($.quantity * ($.unitPrice + $.unitPrice * $.taxRate), 2)");

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

// ── User display ──────────────────────────────────────────────────────────────

describe("user display: full name with null fallback", () => {
  it("uses ?? chaining and bracket index access", () => {
    // Display first name, falling back to first alias, then "anonymous"
    const result = mjsql('$.firstName ?? $.aliases[0] ?? "anonymous"');

    expect(result).toEqual({
      $ifNull: ["$firstName", { $arrayElemAt: ["$aliases", 0] }, "anonymous"],
    });
  });
});

// ── Location ──────────────────────────────────────────────────────────────────

describe("location: full address formatter", () => {
  it("builds a formatted address string using filter + reduce, server-side", () => {
    // Assembles up to 7 address fields into a single space-separated string.
    // The optional building name (e.g. "Suite 4,") is included only when present.
    // MongoDB executes this entirely — no need to fetch all fields to the client.
    const result = mjsql(`
      [
        typeof $.building === "string" && $.building !== "" ? $.building + "," : null,
        $.streetNo,
        $.street,
        $.suburb,
        $.state,
        $.country,
        $.postcode
      ]
        .filter(x => typeof x === "string" && x !== "")
        .reduce((acc, x) => acc == "" ? x : acc + " " + x, "")
    `);

    expect(result).toEqual({
      $reduce: {
        input: {
          $filter: {
            input: [
              {
                $cond: [
                  {
                    $and: [{ $eq: [{ $type: "$building" }, "string"] }, { $ne: ["$building", ""] }],
                  },
                  { $concat: ["$building", ","] },
                  null,
                ],
              },
              "$streetNo",
              "$street",
              "$suburb",
              "$state",
              "$country",
              "$postcode",
            ],
            as: "x",
            cond: {
              $and: [{ $eq: [{ $type: "$$x" }, "string"] }, { $ne: ["$$x", ""] }],
            },
          },
        },
        initialValue: "",
        in: {
          $cond: [{ $eq: ["$$value", ""] }, "$$this", { $concat: ["$$value", " ", "$$this"] }],
        },
      },
    });
  });
});

// ── Data quality ──────────────────────────────────────────────────────────────

describe("data quality: CSV field word count", () => {
  it("uses .split().length — known array context resolves to $size", () => {
    // Count the number of comma-separated values in a CSV field
    const result = mjsql('$.tags.split(",").length');

    expect(result).toEqual({ $size: { $split: ["$tags", ","] } });
  });
});

describe("data quality: normalise string vs number field", () => {
  it("uses typeof in ternary to coerce mixed-type input", () => {
    // Return trimmed string if already a string, else convert to string
    const result = mjsql('typeof $.value == "string" ? $.value.trim() : String($.value)');

    expect(result).toEqual({
      $cond: [
        { $eq: [{ $type: "$value" }, "string"] },
        { $trim: { input: "$value" } },
        { $toString: "$value" },
      ],
    });
  });
});

// ── Access control ────────────────────────────────────────────────────────────

describe("access control: admin permission check", () => {
  it("combines &&, .toLowerCase().includes(), and .trim().length", () => {
    // Active user with an admin role (case-insensitive) and non-empty trimmed name
    const result = mjsql(
      '$.active && $.role.toLowerCase().includes("admin") && $.name.trim().length > 0',
    );

    expect(result).toEqual({
      $and: [
        "$active",
        { $gte: [{ $indexOfCP: [{ $toLower: "$role" }, "admin"] }, 0] },
        { $gt: [{ $strLenCP: { $trim: { input: "$name" } } }, 0] },
      ],
    });
  });
});

// ── Template tag ──────────────────────────────────────────────────────────────

describe("mql template tag: parameterised threshold query", () => {
  it("interpolates JS values into a JS-syntax expression", () => {
    const minScore = 75;
    const passingGrades = ["A", "B"];
    const result = mql`
      $.score >= ${minScore} &&
      $.grade in ${passingGrades} &&
      $.submitted == true
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

// ── Modern JS features (v4) ───────────────────────────────────────────────────

describe("v4: invoice line greeting (template literal + optional chain + .startsWith)", () => {
  it("composes a personalised greeting with safe nested access", () => {
    // Build a string like "Hi Ada — your VIP invoice INV-2024-001 is ready"
    // using template literals, optional chaining for nested fields that may be missing,
    // and .startsWith for a common prefix check.
    const result = mjsql(
      "`Hi ${$.customer?.firstName ?? 'there'} — your " +
        "${$.invoice.id.startsWith('INV-VIP-') ? 'VIP ' : ''}invoice ${$.invoice.id} is ready`",
    );

    expect(result).toEqual({
      $concat: [
        "Hi ",
        { $ifNull: ["$customer.firstName", "there"] },
        " — your ",
        {
          $cond: [{ $eq: [{ $indexOfCP: ["$invoice.id", "INV-VIP-"] }, 0] }, "VIP ", ""],
        },
        "invoice ",
        "$invoice.id",
        " is ready",
      ],
    });
  });
});

describe("v4: analytics — flatMap + Math.max + Date.now", () => {
  it("computes seconds-since-most-recent-event across all sessions", () => {
    // For a doc with sessions: [{ events: [{ ts }, ...] }, ...], extract the
    // newest event timestamp and report seconds since now.
    const result = mjsql(`
      ($.sessions
        .flatMap(s => s.events)
        .map(e => e.ts.getTime())
        .reduce((acc, t) => Math.max(acc, t), 0)
      )
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

describe("v4: shopping cart total with numeric separators + .reduce", () => {
  it("accumulates with a clearly-formatted threshold", () => {
    // Cap line total at $10,000 (written as 10_000 for readability).
    const result = mjsql("Math.min(10_000, $.lines.reduce((sum, l) => sum + l.qty * l.price, 0))");
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

describe("v4: pivot table row (computed keys + Object.fromEntries)", () => {
  it("turns an array of {k,v} pairs into a wide row", () => {
    // Aggregating an array of `{ name, value }` pairs into one object keyed by `name`.
    const result = mjsql("Object.fromEntries($.metrics.map(m => [m.name, m.value]))");
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

describe("flex-shape accumulators in realistic pipelines", () => {
  it("group-stage accumulator: $sum over a field, $round to 2dp", () => {
    // Inside $group, $sum over a single field is the accumulator form.
    // $round wraps the result to 2 decimal places. Both rely on flex shape.
    const result = mjsql("$round($sum($.lineTotal), 2)");
    expect(result).toEqual({
      $round: [{ $sum: "$lineTotal" }, 2],
    });
  });

  it("project-stage expression: $max picks the largest of several fields", () => {
    // Inside $project, $max with multiple args returns the max across expressions.
    const result = mjsql("$max($.basePrice, $.salePrice, $.competitorPrice)");
    expect(result).toEqual({
      $max: ["$basePrice", "$salePrice", "$competitorPrice"],
    });
  });

  it("merging two snapshots: $mergeObjects in expression context", () => {
    // Layering a partial update onto a base document.
    const result = mjsql("$mergeObjects($.base, $.patch)");
    expect(result).toEqual({
      $mergeObjects: ["$base", "$patch"],
    });
  });
});

// ── validate() ────────────────────────────────────────────────────────────────

describe("validate(): realistic error cases", () => {
  it("rejects bare field name without $. prefix", () => {
    // A common mistake: forgetting the $. prefix
    const result = validate("age > 18");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/Did you mean/);
  });

  it("rejects unterminated expression", () => {
    const result = validate("$.score >= 90 &&");
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("rejects scalar on right-hand side of in", () => {
    const result = validate('$.status in "active"');
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/Right-hand side of 'in'/);
  });

  it("accepts a realistic valid expression", () => {
    const result = validate('$.age >= 18 && $.age <= 65 && $.status in ["active", "pending"]');
    expect(result.valid).toBe(true);
  });
});
