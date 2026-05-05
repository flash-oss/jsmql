/**
 * Realistic integration tests.
 *
 * Each test represents a plausible real-world MongoDB aggregation expression.
 * The goal is to exercise as many language features as possible in combination,
 * not to test individual operators in isolation (that's codegen.test.ts).
 *
 * This file is referenced from README.md as a usage showcase.
 */

import { describe, it, expect } from "vitest";
import { mjsql, validate, mql } from "../src/index.js";

describe("e-commerce: order eligibility for free shipping", () => {
  it("combines comparison, $in, $size, string normalisation", () => {
    // Customer qualifies for free shipping if:
    //   cart total ≥ $50, loyalty status is premium/gold/platinum,
    //   cart has < 20 items, and region (trimmed, lowercased) is "us"
    const result = mjsql(`
      $and(
        $gte($.cart.total, 50),
        $in($.customer.status, ["premium", "gold", "platinum"]),
        $lt($size($.cart.items), 20),
        $eq($toLower($trim($.customer.region)), "us")
      )
    `);

    expect(result).toEqual({
      $and: [
        { $gte: ["$cart.total", 50] },
        { $in: ["$customer.status", ["premium", "gold", "platinum"]] },
        { $lt: [{ $size: "$cart.items" }, 20] },
        { $eq: [{ $toLower: { $trim: { input: "$customer.region" } } }, "us"] },
      ],
    });
  });
});

describe("e-commerce: tiered loyalty discount price", () => {
  it("uses nested $cond, arithmetic, and $round", () => {
    // Platinum (≥5 years AND ≥$10k spend): 15% off
    // Gold (≥2 years): 8% off
    // Standard: full price
    // Result rounded to 2 decimal places.
    const result = mjsql(`
      $round(
        $multiply(
          $.price,
          $cond(
            $and($gte($.loyalty.years, 5), $gte($.loyalty.totalSpend, 10000)),
            0.85,
            $cond($gte($.loyalty.years, 2), 0.92, 1)
          )
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
              $cond: {
                if: {
                  $and: [{ $gte: ["$loyalty.years", 5] }, { $gte: ["$loyalty.totalSpend", 10000] }],
                },
                then: 0.85,
                else: { $cond: { if: { $gte: ["$loyalty.years", 2] }, then: 0.92, else: 1 } },
              },
            },
          ],
        },
        2,
      ],
    });
  });
});

describe("user analytics: normalised email domain", () => {
  it("chains $split, $arrayElemAt, $trim, $toLower", () => {
    // Extract and normalise the domain part of an email address.
    const result = mjsql(`
      $toLower($trim($arrayElemAt($split($.email, "@"), 1)))
    `);

    expect(result).toEqual({
      $toLower: {
        $trim: {
          input: { $arrayElemAt: [{ $split: ["$email", "@"] }, 1] },
        },
      },
    });
  });
});

describe("content pipeline: slug generation", () => {
  it("uses $toLower, $trim, $replaceAll positional, $concat", () => {
    // Build a URL slug: "<id>-<normalised-title>"
    const result = mjsql(`
      $concat(
        $toString($.articleId),
        "-",
        $replaceAll($toLower($trim($.title)), " ", "-")
      )
    `);

    expect(result).toEqual({
      $concat: [
        { $toString: "$articleId" },
        "-",
        {
          $replaceAll: {
            input: { $toLower: { $trim: { input: "$title" } } },
            find: " ",
            replacement: "-",
          },
        },
      ],
    });
  });
});

describe("analytics: days since last activity with fallback", () => {
  it("uses $dateDiff object-style, $ifNull, $abs", () => {
    // Days since last login; -1 if never logged in; always non-negative.
    const result = mjsql(`
      $abs($ifNull($dateDiff({ startDate: $.lastLoginAt, endDate: "$$NOW", unit: "day" }), -1))
    `);

    expect(result).toEqual({
      $abs: {
        $ifNull: [{ $dateDiff: { startDate: "$lastLoginAt", endDate: "$$NOW", unit: "day" } }, -1],
      },
    });
  });
});

describe("reporting: formatted date label", () => {
  it("uses $dateToString object-style and $ifNull chain", () => {
    // Display date as "YYYY-MM-DD", falling back through alternatives to "unknown".
    const result = mjsql(`
      $ifNull(
        $dateToString({ date: $.publishedAt, format: "%Y-%m-%d" }),
        $dateToString({ date: $.createdAt, format: "%Y-%m-%d" }),
        "unknown"
      )
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

describe("inventory: stock status label", () => {
  it("uses $cond, $gte, $gt, string literals, field refs", () => {
    // Classify stock level into a label string.
    const result = mjsql(`
      $cond(
        $gte($.stock, $.reorderPoint),
        "ok",
        $cond($gt($.stock, 0), "low", "out-of-stock")
      )
    `);

    expect(result).toEqual({
      $cond: {
        if: { $gte: ["$stock", "$reorderPoint"] },
        then: "ok",
        else: {
          $cond: {
            if: { $gt: ["$stock", 0] },
            then: "low",
            else: "out-of-stock",
          },
        },
      },
    });
  });
});

describe("financial: invoice line total with compound tax", () => {
  it("uses arithmetic operators ($multiply, $add, $round)", () => {
    // lineTotal = round(qty * (unitPrice + unitPrice * taxRate), 2)
    const result = mjsql(`
      $round(
        $multiply(
          $.quantity,
          $add($.unitPrice, $multiply($.unitPrice, $.taxRate))
        ),
        2
      )
    `);

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

describe("mql template tag: parameterised threshold query", () => {
  it("interpolates JS values into a complex expression", () => {
    const minScore = 75;
    const passingGrades = ["A", "B"];
    const result = mql`
      $and(
        $gte($.score, ${minScore}),
        $in($.grade, ${passingGrades}),
        $eq($.submitted, true)
      )
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

describe("e-commerce: v2 infix — discount with eligibility check", () => {
  it("mixes JS infix operators with $operator() calls", () => {
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

describe("user display: v2 infix — full name with null fallback", () => {
  it("uses string-context +, ??, and bracket access", () => {
    // Display "First Last" falling back to email username if name is null
    const result = mjsql(`
      $.firstName ?? $.aliases[0] ?? "anonymous"
    `);

    expect(result).toEqual({
      $ifNull: ["$firstName", { $arrayElemAt: ["$aliases", 0] }, "anonymous"],
    });
  });
});

describe("analytics: v2 infix — score normalisation", () => {
  it("uses arithmetic infix and grouped expressions", () => {
    // Normalise score to 0–100 range: (score - min) / (max - min) * 100
    const result = mjsql(`
      ($.score - $.minScore) / ($.maxScore - $.minScore) * 100
    `);

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

describe("content: v2 infix — full name string concatenation", () => {
  it("uses string-context + infix with field refs and $toLower", () => {
    // Build display name: "FirstName LastName" then lowercase slug
    const result = mjsql(`
      $toLower($.firstName + " " + $.lastName)
    `);

    expect(result).toEqual({
      $toLower: { $concat: ["$firstName", " ", "$lastName"] },
    });
  });
});

describe("inventory: v2 infix — reorder alert with unary and power", () => {
  it("uses unary !, ** power, and comparison infix", () => {
    // Alert if: not discontinued AND stock below reorder threshold (exponential decay model)
    const result = mjsql(`
      !$.discontinued && $.stock < $.baseReorder * 2 ** $.urgencyLevel
    `);

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

describe("validate(): realistic invalid expressions", () => {
  it("rejects bare field name without $. prefix", () => {
    // A common mistake: forgetting the $. prefix
    const result = validate("$eq(age, 18)");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/Unexpected token/);
  });

  it("rejects unterminated operator call", () => {
    const result = validate("$and($gte($.score, 90), $eq($.active, true)");
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("accepts a deeply nested valid expression", () => {
    const result = validate('$and($gte($.a, 1), $lte($.a, 100), $in($.status, ["ok", "pending"]))');
    expect(result.valid).toBe(true);
  });
});
