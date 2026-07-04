// Tests for `assert(condition[, message])` → conditional-error `$match` guard.
// See docs/specs/assert.md for the design and docs/LANGUAGE.md for the
// user-facing reference. The lowering targets a `$convert` whose `to` is a
// `$cond`: a holding assertion converts `true`→bool (no-op), a failing one
// names the message as a bson type, which MongoDB rejects at runtime with
// `Unknown type name: <message>`.

import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

const guard = (cond: unknown, fail: unknown) => ({
  $match: { $expr: { $convert: { input: true, to: { $cond: [cond, "bool", fail] } } } },
});

describe("assert — lowering", () => {
  it("lowers a string-message assert to a $match guard, message prefixed", () => {
    expect(jsmql("assert($.qty >= 0, 'qty must be >= 0')")).toEqual([
      guard({ $gte: ["$qty", 0] }, "jsmql assertion failed: qty must be >= 0"),
    ]);
  });

  it("composes with following stages in a multi-statement pipeline", () => {
    expect(jsmql("assert($.qty >= 0, 'qty bad'); $.fee = $.qty * 0.01")).toEqual([
      guard({ $gte: ["$qty", 0] }, "jsmql assertion failed: qty bad"),
      { $set: { fee: { $multiply: ["$qty", 0.01] } } },
    ]);
  });

  it("defaults the message when omitted", () => {
    // Bare `$.active` is wrapped in JS-truthiness, like every other boolean context.
    expect(jsmql("assert($.active)")).toEqual([
      guard(
        {
          $and: [
            { $ne: [{ $ifNull: ["$active", null] }, null] },
            { $ne: ["$active", false] },
            { $ne: ["$active", ""] },
            { $ne: ["$active", 0] },
          ],
        },
        "jsmql assertion failed",
      ),
    ]);
  });

  it("builds a runtime $concat for a non-literal (template) message", () => {
    expect(jsmql("assert($.qty >= 0, `qty was ${$.qty}`)")).toEqual([
      guard(
        { $gte: ["$qty", 0] },
        { $concat: ["jsmql assertion failed: ", { $toString: { $concat: ["qty was ", { $toString: "$qty" }] } }] },
      ),
    ]);
  });

  it("prefixes a message that is itself a valid type name (correctness, not cosmetic)", () => {
    // Without the prefix, `to: "int"` would make $convert SUCCEED and silently
    // skip the assertion — the prefix guarantees it is never a real type name.
    expect(jsmql("assert($.ok, 'int')")).toEqual([
      guard(
        {
          $and: [
            { $ne: [{ $ifNull: ["$ok", null] }, null] },
            { $ne: ["$ok", false] },
            { $ne: ["$ok", ""] },
            { $ne: ["$ok", 0] },
          ],
        },
        "jsmql assertion failed: int",
      ),
    ]);
  });
});

describe("assert — call forms", () => {
  it("works as a single-statement arrow block (no trailing `;`)", () => {
    expect(
      jsmql(({ $ }) => {
        assert($.qty >= 0, "m");
      }),
    ).toEqual([guard({ $gte: ["$qty", 0] }, "jsmql assertion failed: m")]);
  });

  it("works as a lone string with no `;` (auto-wrapped to a one-stage pipeline)", () => {
    expect(jsmql("assert($.qty >= 0, 'm')")).toEqual([guard({ $gte: ["$qty", 0] }, "jsmql assertion failed: m")]);
  });

  it("works inside a bracketed pipeline array", () => {
    expect(jsmql("[assert($.q >= 0, 'm'), $sort({ q: 1 })]")).toEqual([
      guard({ $gte: ["$q", 0] }, "jsmql assertion failed: m"),
      { $sort: { q: 1 } },
    ]);
  });

  it("is accepted by jsmql.pipeline()", () => {
    expect(jsmql.pipeline("assert($.q >= 0, 'm')")).toEqual([guard({ $gte: ["$q", 0] }, "jsmql assertion failed: m")]);
  });
});

describe("assert — rejections", () => {
  it("rejects expression position (ternary branch) with a statement-form hint", () => {
    expect(() => jsmql.expr("$.x > 0 ? $.x : assert($.x, 'no')")).toThrow(
      /'assert\(\.\.\.\)' is a pipeline statement, not a value/,
    );
  });

  it("rejects expression position (field RHS)", () => {
    expect(() => jsmql("$.y = assert($.x, 'no'); $.z = 1")).toThrow(/pipeline statement, not a value/);
  });

  it("rejects in jsmql.filter()", () => {
    expect(() => jsmql.filter("assert($.x > 0, 'm')")).toThrow(/pipeline statement, not a value/);
  });

  it("rejects in jsmql.expr()", () => {
    expect(() => jsmql.expr("assert($.x > 0, 'm')")).toThrow(/pipeline statement, not a value/);
  });

  it("rejects zero arguments, naming the signature", () => {
    expect(() => jsmql("assert()")).toThrow(/assert\(condition\[, message\]\) requires 1 or 2 arguments, got 0/);
  });

  it("rejects more than two arguments", () => {
    expect(() => jsmql("assert($.a, 'm', 'extra')")).toThrow(
      /assert\(condition\[, message\]\) requires 1 or 2 arguments, got 3/,
    );
  });

  it("rejects a spread argument", () => {
    expect(() => jsmql("assert(...$.flags)")).toThrow(
      /Spread \(\.\.\.\) is not supported as an argument to 'assert\(\.\.\.\)'/,
    );
  });

  it("yields to a user-declared `const assert` (no shadowing surprise)", () => {
    // A reusable function named `assert` takes precedence; calling it as a bare
    // statement isn't a stage, so the generic not-a-stage error fires.
    expect(() => jsmql("const assert = (x) => x; assert($.y)")).toThrow();
  });
});
