import { describe, it, expect } from "vitest";
import { mjsql, validate } from "../src/index.ts";

describe("mutations: simple assignment (=)", () => {
  it("emits a single $set stage for one assignment", () => {
    expect(mjsql("$.a = 1")).toEqual({ $set: { a: 1 } });
  });

  it("works with a string RHS", () => {
    expect(mjsql("$.status = 'active'")).toEqual({ $set: { status: "active" } });
  });

  it("works with a field-ref RHS", () => {
    expect(mjsql("$.copy = $.original")).toEqual({ $set: { copy: "$original" } });
  });

  it("works with a complex expression RHS", () => {
    expect(mjsql("$.total = $.price * $.qty")).toEqual({
      $set: { total: { $multiply: ["$price", "$qty"] } },
    });
  });

  it("supports nested field paths", () => {
    expect(mjsql("$.user.name = 'alice'")).toEqual({ $set: { "user.name": "alice" } });
  });

  it("supports deeply nested field paths", () => {
    expect(mjsql("$.a.b.c.d = 5")).toEqual({ $set: { "a.b.c.d": 5 } });
  });
});

describe("mutations: compound assignment (+=, -=, *=, /=)", () => {
  it("+= with literal", () => {
    expect(mjsql("$.x += 1")).toEqual({ $set: { x: { $add: ["$x", 1] } } });
  });

  it("-= with literal", () => {
    expect(mjsql("$.x -= 3")).toEqual({ $set: { x: { $subtract: ["$x", 3] } } });
  });

  it("*= with literal", () => {
    expect(mjsql("$.x *= 2")).toEqual({ $set: { x: { $multiply: ["$x", 2] } } });
  });

  it("/= with literal", () => {
    expect(mjsql("$.x /= 4")).toEqual({ $set: { x: { $divide: ["$x", 4] } } });
  });

  it("+= with field reference", () => {
    expect(mjsql("$.a += $.b")).toEqual({ $set: { a: { $add: ["$a", "$b"] } } });
  });

  it("+= with string context produces $concat", () => {
    expect(mjsql("$.greeting += '!'")).toEqual({
      $set: { greeting: { $concat: ["$greeting", "!"] } },
    });
  });

  it("compound on nested path", () => {
    expect(mjsql("$.user.score += 10")).toEqual({
      $set: { "user.score": { $add: ["$user.score", 10] } },
    });
  });

  it("RHS can be a complex expression", () => {
    expect(mjsql("$.total += $.items.reduce((acc, x) => acc + x, 0)")).toEqual({
      $set: {
        total: {
          $add: [
            "$total",
            {
              $reduce: {
                input: "$items",
                initialValue: 0,
                in: { $add: ["$$value", "$$this"] },
              },
            },
          ],
        },
      },
    });
  });
});

describe("mutations: increment/decrement (++x, x++, --x, x--)", () => {
  // In MQL pipeline context the prefix/postfix distinction is irrelevant —
  // there is no "value of expression" for a stage-level mutation, so all four
  // forms compile to the same `$set: { x: { $add|$subtract: ["$x", 1] } }`.

  it("postfix ++ on a top-level field", () => {
    expect(mjsql("$.x++")).toEqual({ $set: { x: { $add: ["$x", 1] } } });
  });

  it("prefix ++ on a top-level field", () => {
    expect(mjsql("++$.x")).toEqual({ $set: { x: { $add: ["$x", 1] } } });
  });

  it("postfix -- on a top-level field", () => {
    expect(mjsql("$.x--")).toEqual({ $set: { x: { $subtract: ["$x", 1] } } });
  });

  it("prefix -- on a top-level field", () => {
    expect(mjsql("--$.x")).toEqual({ $set: { x: { $subtract: ["$x", 1] } } });
  });

  it("postfix ++ on a nested path", () => {
    expect(mjsql("$.user.score++")).toEqual({
      $set: { "user.score": { $add: ["$user.score", 1] } },
    });
  });

  it("prefix -- on a nested path", () => {
    expect(mjsql("--$.cart.itemCount")).toEqual({
      $set: { "cart.itemCount": { $subtract: ["$cart.itemCount", 1] } },
    });
  });

  it("multiple inc/dec coalesce into one $set", () => {
    expect(mjsql("$.a++; $.b--; ++$.c")).toEqual({
      $set: {
        a: { $add: ["$a", 1] },
        b: { $subtract: ["$b", 1] },
        c: { $add: ["$c", 1] },
      },
    });
  });

  it("inc/dec mixed with assignments coalesce into one $set", () => {
    expect(mjsql("$.cnt++, $.label = 'done'")).toEqual({
      $set: { cnt: { $add: ["$cnt", 1] }, label: "done" },
    });
  });

  it("inc/dec inside a pipeline", () => {
    expect(mjsql("[$match($.active), $.views++, $sort({views: -1})]")).toEqual([
      { $match: { $expr: "$active" } },
      { $set: { views: { $add: ["$views", 1] } } },
      { $sort: { views: -1 } },
    ]);
  });

  it("parens around postfix work (formatter-friendly)", () => {
    expect(mjsql("($.x++)")).toEqual({ $set: { x: { $add: ["$x", 1] } } });
  });

  it("parens around prefix work", () => {
    expect(mjsql("(++$.x)")).toEqual({ $set: { x: { $add: ["$x", 1] } } });
  });

  it("parens around inc/dec inside pipeline arrays work", () => {
    expect(mjsql("[$match($.active), ($.views++), (--$.lives)]")).toEqual([
      { $match: { $expr: "$active" } },
      {
        $set: {
          views: { $add: ["$views", 1] },
          lives: { $subtract: ["$lives", 1] },
        },
      },
    ]);
  });

  it("read-after-write splits when a later mutation references an inc'd field", () => {
    expect(mjsql("$.cnt++; $.lastCnt = $.cnt")).toEqual([
      { $set: { cnt: { $add: ["$cnt", 1] } } },
      { $set: { lastCnt: "$cnt" } },
    ]);
  });

  it("rejects inc/dec on a bare identifier", () => {
    const result = validate("x++");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/field path|bare identifier/i);
  });

  it("rejects prefix inc/dec on a bare identifier", () => {
    const result = validate("++x");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/field path|bare identifier/i);
  });

  it("rejects inc/dec on index access", () => {
    const result = validate("$.items[0]++");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/index access|computed/i);
  });

  it("rejects inc/dec used as a value (postfix in expression context)", () => {
    // `1 + $.x++` — $.x++ is a statement, not a value
    const result = validate("1 + $.x++");
    expect(result.valid).toBe(false);
  });

  it("regression: `5 - -3` still parses (whitespace separates the minuses)", () => {
    // Without space, `5--3` lexes as `5 -- 3` (MinusMinus token) and would be
    // rejected as an inc/dec on a non-field-path target. With whitespace, the
    // two minuses lex as separate Minus tokens and the unary minus path runs.
    expect(mjsql("5 - -3")).toEqual({ $subtract: [5, -3] });
  });
});

describe("mutations: sequencing", () => {
  it("two independent assignments coalesce into one $set (semicolon separator)", () => {
    expect(mjsql("$.a = 1; $.b = 2")).toEqual({ $set: { a: 1, b: 2 } });
  });

  it("two independent assignments coalesce into one $set (comma separator)", () => {
    expect(mjsql("$.a = 1, $.b = 2")).toEqual({ $set: { a: 1, b: 2 } });
  });

  it("read-after-write splits into two $set stages", () => {
    expect(mjsql("$.a = 1; $.b = $.a")).toEqual([{ $set: { a: 1 } }, { $set: { b: "$a" } }]);
  });

  it("write-after-write to same path splits", () => {
    expect(mjsql("$.a = 1; $.a = 2")).toEqual([{ $set: { a: 1 } }, { $set: { a: 2 } }]);
  });

  it("parent-child path collision splits", () => {
    expect(mjsql("$.a = 1; $.a.b = 2")).toEqual([{ $set: { a: 1 } }, { $set: { "a.b": 2 } }]);
  });

  it("three-way with middle dependency", () => {
    expect(mjsql("$.a = 1; $.b = $.a; $.c = 3")).toEqual([
      { $set: { a: 1 } },
      { $set: { b: "$a", c: 3 } },
    ]);
  });

  it("trailing semicolon allowed", () => {
    expect(mjsql("$.a = 1;")).toEqual({ $set: { a: 1 } });
  });

  it("trailing comma allowed", () => {
    expect(mjsql("$.a = 1,")).toEqual({ $set: { a: 1 } });
  });

  it("mixed `;` and `,` separators", () => {
    expect(mjsql("$.a = 1; $.b = 2, $.c = 3")).toEqual({
      $set: { a: 1, b: 2, c: 3 },
    });
  });
});

describe("mutations: chained assignment", () => {
  it("two-way chain", () => {
    expect(mjsql("$.a = $.b = 5")).toEqual({ $set: { a: 5, b: 5 } });
  });

  it("three-way chain", () => {
    expect(mjsql("$.a = $.b = $.c = 5")).toEqual({ $set: { a: 5, b: 5, c: 5 } });
  });

  it("chain with complex RHS", () => {
    expect(mjsql("$.x = $.y = $.z + 1")).toEqual({
      $set: { x: { $add: ["$z", 1] }, y: { $add: ["$z", 1] } },
    });
  });
});

describe("mutations: delete", () => {
  it("single delete emits $unset string form", () => {
    expect(mjsql("delete $.tmp")).toEqual({ $unset: "tmp" });
  });

  it("nested delete uses dotted path", () => {
    expect(mjsql("delete $.user.tmp")).toEqual({ $unset: "user.tmp" });
  });

  it("two consecutive deletes coalesce into array form", () => {
    expect(mjsql("delete $.a; delete $.b")).toEqual({ $unset: ["a", "b"] });
  });

  it("three consecutive deletes coalesce", () => {
    expect(mjsql("delete $.a; delete $.b; delete $.c")).toEqual({
      $unset: ["a", "b", "c"],
    });
  });

  it("delete-then-assign breaks (kind change)", () => {
    expect(mjsql("delete $.a; $.b = 1")).toEqual([{ $unset: "a" }, { $set: { b: 1 } }]);
  });

  it("assign-then-delete breaks (kind change)", () => {
    expect(mjsql("$.a = 1; delete $.b")).toEqual([{ $set: { a: 1 } }, { $unset: "b" }]);
  });

  it("delete a path the prior assignment wrote splits", () => {
    expect(mjsql("$.a = 1; delete $.a")).toEqual([{ $set: { a: 1 } }, { $unset: "a" }]);
  });

  it("delete a child of an assigned parent splits", () => {
    expect(mjsql("$.a = 1; delete $.a.b")).toEqual([{ $set: { a: 1 } }, { $unset: "a.b" }]);
  });
});

describe("mutations: realistic mixed (user-supplied)", () => {
  it("assignment + compound coalesce: total = price*qty, views += 1", () => {
    expect(mjsql("$.total = $.price * $.qty, $.views += 1")).toEqual({
      $set: {
        total: { $multiply: ["$price", "$qty"] },
        views: { $add: ["$views", 1] },
      },
    });
  });

  it("two deletes + assignment splits at kind change", () => {
    expect(mjsql("delete $.tempToken, delete $._processingState, $.status = 'complete'")).toEqual([
      { $unset: ["tempToken", "_processingState"] },
      { $set: { status: "complete" } },
    ]);
  });

  it("three-stage coalescing across kind boundaries: $set → $unset → $set", () => {
    // Assignments coalesce into one $set; the kind change at `delete` opens a
    // new $unset stage (two paths → array form); the kind change back to
    // assignment opens the final $set.
    expect(
      mjsql(
        "$.lineTotal = $.qty * $.unitPrice, $.invoiceCount += 1, " +
          "delete $.tempToken, delete $._processingState, " +
          "$.status = 'complete'",
      ),
    ).toEqual([
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

describe("mutations: in pipelines", () => {
  it("pipeline with assignment between stages", () => {
    expect(mjsql("[$match($.active), $.score += 1, $sort({score: -1})]")).toEqual([
      { $match: { $expr: "$active" } },
      { $set: { score: { $add: ["$score", 1] } } },
      { $sort: { score: -1 } },
    ]);
  });

  it("consecutive mutation elements coalesce inside a pipeline", () => {
    expect(mjsql("[$match($.active), $.a = 1, $.b = 2, $sort({c: 1})]")).toEqual([
      { $match: { $expr: "$active" } },
      { $set: { a: 1, b: 2 } },
      { $sort: { c: 1 } },
    ]);
  });

  it("non-mutation stage between mutations breaks coalescing", () => {
    expect(mjsql("[$.a = 1, $sort({a: 1}), $.b = 2]")).toEqual([
      { $set: { a: 1 } },
      { $sort: { a: 1 } },
      { $set: { b: 2 } },
    ]);
  });

  it("delete inside a pipeline", () => {
    expect(mjsql("[$match($.active), delete $.tmp, $sort({a: 1})]")).toEqual([
      { $match: { $expr: "$active" } },
      { $unset: "tmp" },
      { $sort: { a: 1 } },
    ]);
  });

  it("a pipeline whose first element is a mutation is still detected as a pipeline", () => {
    expect(mjsql("[$.a = 1, $sort({a: 1})]")).toEqual([{ $set: { a: 1 } }, { $sort: { a: 1 } }]);
  });
});

describe("mutations: parenthesized form (formatter-friendly)", () => {
  // Formatters (oxfmt, prettier) wrap assignment expressions in parens when
  // they appear in array element position. The parser unwraps these so the
  // function-input form `mjsql(($) => [($.a = 1)])` produces the same output
  // as the bare `mjsql("[$.a = 1]")`.

  it("parens around an assignment at the top level work", () => {
    expect(mjsql("($.a = 5)")).toEqual({ $set: { a: 5 } });
  });

  it("parens around a compound assignment work", () => {
    expect(mjsql("($.x += 1)")).toEqual({ $set: { x: { $add: ["$x", 1] } } });
  });

  it("parens around assignments as pipeline elements coalesce normally", () => {
    expect(mjsql("[$match($.active), ($.a = 1), ($.b = 2), $sort({c: 1})]")).toEqual([
      { $match: { $expr: "$active" } },
      { $set: { a: 1, b: 2 } },
      { $sort: { c: 1 } },
    ]);
  });

  it("parens around assignments mixed with bare assignments work", () => {
    expect(mjsql("[$match($.active), ($.a = 1), $.b = 2]")).toEqual([
      { $match: { $expr: "$active" } },
      { $set: { a: 1, b: 2 } },
    ]);
  });
});

describe("mutations: validation errors", () => {
  it("rejects bare identifier as target", () => {
    const result = validate("x = 5");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/field path|bare identifier/i);
  });

  it("rejects bare identifier in delete", () => {
    const result = validate("delete x");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/field path|bare identifier/i);
  });

  it("rejects index-access target", () => {
    const result = validate("$.items[0] = 5");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/index access|computed/i);
  });

  it("rejects assignment inside lambda body", () => {
    const result = validate("$.list.map(x => $.a = x)");
    expect(result.valid).toBe(false);
  });

  it("rejects compound chained assignment", () => {
    const result = validate("$.a += $.b += 1");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/chained|chain/i);
  });

  it("rejects missing RHS", () => {
    const result = validate("$.a =");
    expect(result.valid).toBe(false);
  });

  it("rejects bare delete with no target", () => {
    const result = validate("delete");
    expect(result.valid).toBe(false);
  });

  it("rejects mutation inside parenthesized expression context", () => {
    // ($.a = 1) + 2 — assignment used as a value (codegen-level rejection
    // since parseGrouped now accepts the parens-form syntactically)
    const result = validate("($.a = 1) + 2");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/statement, not a value/i);
  });

  it("rejects chained assignment inside parens", () => {
    const result = validate("($.a = $.b = 5)");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/chained assignment inside parentheses/i);
  });
});

describe("mutations: lex regression checks", () => {
  // Make sure adding `=`, `+=`, etc. didn't break existing operators.
  it("== still parses as equality", () => {
    expect(mjsql("$.a == 1")).toEqual({ $eq: ["$a", 1] });
  });

  it("=== still parses as strict equality", () => {
    expect(mjsql("$.a === 1")).toEqual({ $eq: ["$a", 1] });
  });

  it("=> still parses as arrow", () => {
    expect(mjsql("$.list.map(x => x + 1)")).toEqual({
      $map: { input: "$list", as: "x", in: { $add: ["$$x", 1] } },
    });
  });

  it(">= and <= still parse", () => {
    expect(mjsql("$.a >= 1")).toEqual({ $gte: ["$a", 1] });
    expect(mjsql("$.a <= 1")).toEqual({ $lte: ["$a", 1] });
  });

  it("!= and !== still parse", () => {
    expect(mjsql("$.a != 1")).toEqual({ $ne: ["$a", 1] });
    expect(mjsql("$.a !== 1")).toEqual({ $ne: ["$a", 1] });
  });

  it("** (power) still parses (not confused with *=)", () => {
    expect(mjsql("$.a ** 2")).toEqual({ $pow: ["$a", 2] });
  });

  it("regex literals still work (not confused with /=)", () => {
    expect(mjsql("/abc/.test($.s)")).toEqual({ $regexMatch: { input: "$s", regex: "abc" } });
  });
});
