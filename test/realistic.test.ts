/**
 * Realistic integration tests.
 *
 * Each test represents a plausible real-world MongoDB aggregation expression
 * written in mjsql's JavaScript-subset syntax. $op() escape-hatch calls (the
 * direct operator form) appear only where there is no JavaScript equivalent
 * (e.g. $dateDiff, $stdDevPop, $sampleRate).
 *
 * This file is referenced from README.md as a usage showcase.
 */

import { describe, it, expect } from "vitest";
import { mjsql, validate, mql } from "../src/index.ts";

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
  it("uses nested ternaries, &&, >=, and $round escape hatch", () => {
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

describe("e-commerce: discount breakdown via IIFE → $let", () => {
  it("binds the discount once and reuses it across three projected fields", () => {
    // A $project-style row that needs the same computed value (the discount amount)
    // in three places: the final price, the raw savings, and the savings percentage.
    // Writing this as an IIFE lets `$let` bind the value once instead of repeating
    // `$.price * (1 - $.loyalty.multiplier)` in every field.
    const result1 = mjsql(`
      ((discount) => ({
        finalPrice: $.price - discount,
        savings: discount,
        savingsPercent: Math.round((discount / $.price) * 100),
      }))($.price * (1 - $.loyalty.multiplier))
    `);
    const result2 = mjsql(($) =>
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
  it("uses Math.abs, $dateDiff escape hatch, ??, and new Date()", () => {
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
  it("uses string-context + and $toLower escape hatch", () => {
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
  it("uses $dateDiff escape hatch with new Date() for current time", () => {
    // Days since the document was first created. Uses the function form with the
    // operator destructured from the second parameter so the IDE doesn't flag
    // `$dateDiff` as an unknown identifier.
    const result = mjsql(($, { $dateDiff }) =>
      $dateDiff({ startDate: $.createdAt, endDate: new Date(), unit: "day" }),
    );

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
  it("uses JS arithmetic operators and $round escape hatch", () => {
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
  it("uses ?? chaining and .at(0) for the first alias", () => {
    // Display first name, falling back to first alias, then "anonymous".
    // .at(0) compiles to a compact $arrayElemAt; $.aliases[0] would emit a
    // runtime $cond on $isArray since the receiver type isn't statically known.
    const result = mjsql('$.firstName ?? $.aliases.at(0) ?? "anonymous"');

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
        typeof $.building === "string" && $.building.trim() !== "" ? $.building.trim() + "," : null,
        $.streetNo, $.street, $.suburb, $.state, $.country, $.postcode,
      ]
        .filter((x) => typeof x === "string" && x !== "")
        .map((x) => x.trim())
        .join(" ")
    `);

    expect(result).toEqual({
      $reduce: {
        input: {
          $map: {
            input: {
              $filter: {
                input: [
                  {
                    $cond: [
                      {
                        $and: [
                          { $eq: [{ $type: "$building" }, "string"] },
                          { $ne: [{ $trim: { input: "$building" } }, ""] },
                        ],
                      },
                      { $concat: [{ $trim: { input: "$building" } }, ","] },
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
                cond: { $and: [{ $eq: [{ $type: "$$x" }, "string"] }, { $ne: ["$$x", ""] }] },
              },
            },
            as: "x",
            in: { $trim: { input: "$$x" } },
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

// ── Modern JS features ───────────────────────────────────────────────────────

describe("invoice line greeting (template literal + optional chain + .startsWith)", () => {
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

describe("analytics — flatMap + Math.max + .getTime", () => {
  it("computes the most-recent-event timestamp across all sessions", () => {
    // For a doc with sessions: [{ events: [{ ts }, ...] }, ...], extract the
    // newest event timestamp and report seconds since now.
    const result = mjsql(`
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

describe("shopping cart total with numeric separators + .reduce", () => {
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

describe("pivot table row (computed keys + Object.fromEntries)", () => {
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

describe("file upload validation (.includes on array literal + .endsWith + numeric separator)", () => {
  it("checks extension whitelist, name match, and size cap", () => {
    // Reject upload unless the lowercased extension is in the allowlist,
    // the filename actually ends with that extension, and size is ≤ 25 MB.
    const result = mjsql(`
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

describe("score range with spread + Array.isArray guard", () => {
  it("computes max-min via spread, falling back to 0 when scores is missing", () => {
    // Using ...spread to pass the array as variadic args to Math.max / Math.min.
    // Array.isArray defends against documents where scores isn't an array.
    const result = mjsql(`
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

describe("moderator membership check with array spread", () => {
  it("checks if user is in the combined moderator list for a thread", () => {
    // A thread's effective moderators are: thread-specific mods, room-wide mods,
    // plus a hard-coded root user. Array spread is the natural JS form for
    // building this combined list, then .includes() checks membership.
    const result = mjsql('[...$.moderators, ...$.room.mods, "root"].includes($.userId)');

    expect(result).toEqual({
      $in: ["$userId", { $concatArrays: ["$moderators", "$room.mods", ["root"]] }],
    });
  });
});

describe("days since event (Date.now + .getTime + numeric separator)", () => {
  it("computes whole days elapsed since an event timestamp", () => {
    // Date.now() returns ms since epoch — same as JS — and so does .getTime().
    // 86_400_000 = 24 * 60 * 60 * 1000 ms in a day.
    const result = mjsql("Math.floor((Date.now() - $.event.ts.getTime()) / 86_400_000)");

    expect(result).toEqual({
      $floor: {
        $divide: [{ $subtract: [{ $toLong: "$$NOW" }, { $toLong: "$event.ts" }] }, 86400000],
      },
    });
  });
});

describe("audit log line (template literal + .toISOString + .charAt + .toUpperCase)", () => {
  it("formats an ISO-timestamped log line with a single-letter level prefix", () => {
    // Render lines like "2024-09-01T12:30:00.000Z [E] disk full".
    const result = mjsql(
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

describe("tag aggregation (.flat + .join)", () => {
  it("collects all post tags into a single comma-separated string", () => {
    // Posts each carry a tags array; flatten them all into one list and render as CSV.
    const result = mjsql('$.posts.map(p => p.tags).flat().join(", ")');

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

describe("scientific projection (Math.hypot + Math.log2/log10 + Math.sign + Math.cbrt + Math.PI/E)", () => {
  it("derives geometric, audio, and trend metrics in a single $project shape", () => {
    // distance: 2D Euclidean distance from origin
    // octave:   octaves above A4 (440 Hz)
    // decibels: amplitude relative to 1.0 in dB
    // fovRad:   field-of-view degrees converted to radians
    // growthFactor: continuous-compound multiplier for a given rate
    // trend:    -1 / 0 / +1 indicator from period-over-period delta
    // cubeSide: characteristic length from a 3D volume
    const result = mjsql(`
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

describe("dynamic pivot row (computed key in literal + shorthand property)", () => {
  it("turns each product into a dict keyed by category, plus the original record", () => {
    // [{category:'A', price:1}] → [{ A: 1, p: { category:'A', price:1 } }]
    // The shorthand `p` is sugar for `p: p`, which resolves to `p: $$p` in lambda scope.
    const result = mjsql("$.products.map(p => ({ [p.category]: p.price, p }))");

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

describe("annotated insurance underwriting rule (// and /* */ comments)", () => {
  it("compiles a multi-line rule with inline comments to the same MQL as a comment-free version", () => {
    // Real underwriting check: applicant qualifies for the standard tier if
    // they're the right age, drive a sane number of km/year, and aren't in
    // a high-risk occupation. Comments document the business rules inline.
    const result = mjsql(`
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

// ── Pipelines ─────────────────────────────────────────────────────────────────

describe("pipeline: top-orders report by department", () => {
  // Sales analytics: pick recent shipped orders, attach the buyer document
  // from the users collection, group by department, compute average order
  // size, then keep the top three departments by revenue. Stages use the
  // call form ($match(...), $unwind(...), …) and bodies use plain JS
  // expressions — comparison operators, field refs, arithmetic — so the
  // pipeline reads like the JavaScript that built it. $match's body is
  // auto-wrapped in $expr because it isn't an object literal.
  it("authors a realistic multi-stage pipeline using JS-expression bodies", () => {
    const result1 = mql`[
      $match($.status === "shipped" && $.placedAt >= "2026-01-01"),
      $lookup({ from: "users", localField: "userId", foreignField: "_id", as: "buyer" }),
      $unwind($.buyer),
      $group({ _id: $.buyer.department, revenue: $sum($.total), orders: $sum(1) }),
      $set({ avgOrder: $.revenue / $.orders }),
      $sort({ revenue: -1 }),
      $limit(3)
    ]`;
    const result2 = mjsql(($, { $match, $lookup, $unwind, $group, $sum, $set, $sort, $limit }) => [
      $match($.status === "shipped" && $.placedAt >= "2026-01-01"),
      $lookup({ from: "users", localField: "userId", foreignField: "_id", as: "buyer" }),
      $unwind($.buyer),
      $group({ _id: $.buyer.department, revenue: $sum($.total), orders: $sum(1) }),
      $set({ avgOrder: $.revenue / $.orders }),
      $sort({ revenue: -1 }),
      $limit(3),
    ]);

    expect(result1).toEqual(result2);
    expect(result1).toEqual([
      {
        $match: {
          $expr: { $and: [{ $eq: ["$status", "shipped"] }, { $gte: ["$placedAt", "2026-01-01"] }] },
        },
      },
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "buyer" } },
      { $unwind: "$buyer" },
      { $group: { _id: "$buyer.department", revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
      { $set: { avgOrder: { $divide: ["$revenue", "$orders"] } } },
      { $sort: { revenue: -1 } },
      { $limit: 3 },
    ]);
  });
});

describe("pipeline: count orders by status per shop ($accumulator replacement)", () => {
  // Realistic analytics output: for each shop, a count of orders by status —
  // { pending: 12, paid: 87, refunded: 3 }. The dynamic-keyed object (one
  // key per distinct status value) is the case that pushes people toward
  // $accumulator and server-side JavaScript, since no built-in accumulator
  // builds an object whose keys come from data.
  //
  // mjsql replaces the $accumulator pattern natively: $push the statuses
  // into an array during $group, then $reduce them into an object using
  // object spread and a computed key. The codegen lowers `{ ...acc, [s]: x }`
  // to $mergeObjects + $arrayToObject. Bracket access on a lambda parameter
  // (`acc[s]`) compiles to a runtime $cond between $arrayElemAt and
  // $getField — mjsql can't statically infer that `acc` is an object, so it
  // dispatches at evaluation time. The dead $arrayElemAt branch never runs
  // for this particular reducer, but the codegen stays type-agnostic.
  it("builds a dynamic-keyed histogram via object spread + computed key in $reduce", () => {
    const result1 = mql`[
      { $group: { _id: $.shopId, statuses: $push($.status) } },
      { $project: {
          counts: $.statuses.reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {})
      } }
    ]`;
    const result2 = mjsql(($, { $push }) => [
      { $group: { _id: $.shopId, statuses: $push($.status) } },
      {
        $project: {
          counts: $.statuses.reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {}),
        },
      },
    ]);

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
                              $ifNull: [
                                {
                                  $cond: [
                                    { $isArray: "$$value" },
                                    { $arrayElemAt: ["$$value", "$$this"] },
                                    { $getField: { field: "$$this", input: "$$value" } },
                                  ],
                                },
                                0,
                              ],
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

describe("e-commerce: invoice finalisation pipeline (mutations + $match)", () => {
  // Read pipeline that selects pending paid invoices, derives a line total and
  // bumps a counter, drops transient processing state, then stamps the final
  // status. Demonstrates mutations interleaved with traditional pipeline stages
  // — the $match boundary flushes any pending mutation buffer, and the run
  // after $match coalesces by kind / read-after-write rules into three stages.
  // Exercised in both forms: the string body and the function-input adapter
  // must produce identical output. The function form's parens around the
  // assignment expressions are added by the formatter and are accepted
  // transparently by the parser — see docs/specs/mutations.md.
  it("compiles match → mutate → mutate → mutate to a four-stage pipeline", () => {
    const result1 = mjsql(`[
      $match($.status === 'pending' && $.paidAt != null),
      $.lineTotal = $.qty * $.unitPrice,
      $.invoiceCount += 1,
      delete $.tempToken,
      delete $._processingState,
      $.status = 'complete'
    ]`);
    const result2 = mjsql(($, { $match }) => [
      $match($.status === "pending" && $.paidAt != null),
      ($.lineTotal = $.qty * $.unitPrice),
      ($.invoiceCount += 1),
      delete $.tempToken,
      delete $._processingState,
      ($.status = "complete"),
    ]);
    expect(result1).toEqual(result2);

    expect(result1).toEqual([
      {
        $match: {
          $expr: {
            $and: [{ $eq: ["$status", "pending"] }, { $ne: ["$paidAt", null] }],
          },
        },
      },
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

describe("e-commerce: invoice finalisation pipeline (implicit `;` form)", () => {
  // Same intent as the `[…]`-bracketed pipeline above, but written with the
  // implicit `;`-separated form. The two writings should compile to the same
  // MQL, except the implicit form does not coalesce adjacent mutations across
  // `;`. Inside one `;` chunk, `,` still groups mutations into one stage with
  // the usual kind / read-after-write splits.
  it("compiles `;`-separated stages identically to the bracketed form", () => {
    const bracketed = mjsql(`[
      $match($.status === 'pending' && $.paidAt != null),
      $.lineTotal = $.qty * $.unitPrice,
      $.invoiceCount += 1,
      delete $.tempToken,
      delete $._processingState,
      $.status = 'complete'
    ]`);
    const implicit = mjsql(`
      $match($.status === 'pending' && $.paidAt != null);
      $.lineTotal = $.qty * $.unitPrice, $.invoiceCount += 1;
      delete $.tempToken, delete $._processingState;
      $.status = 'complete'
    `);
    expect(implicit).toEqual(bracketed);
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
