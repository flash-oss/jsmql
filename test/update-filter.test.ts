import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

describe("update filters: simple assignment (=)", () => {
  // `jsmql()` always returns an aggregation-pipeline array for update-filter
  // inputs so callers can pass the output directly to
  // `db.coll.updateOne(filter, update)` and have RHS expressions actually
  // evaluate. (Bare-doc form treats values as literals; only pipeline form
  // evaluates aggregation expressions.) `jsmql.expr()` keeps the bare shape
  // for building blocks — see the `lex regression checks` block below and the
  // `describe("uppercase a user's name…")` case in realistic.test.ts.
  it("emits a single $set stage for one assignment", () => {
    expect(jsmql("$.a = 1")).toEqual([{ $set: { a: 1 } }]);
  });

  it("works with a string RHS", () => {
    expect(jsmql("$.status = 'active'")).toEqual([{ $set: { status: "active" } }]);
  });

  it("works with a field-ref RHS", () => {
    expect(jsmql("$.copy = $.original")).toEqual([{ $set: { copy: "$original" } }]);
  });

  it("works with a complex expression RHS", () => {
    expect(jsmql("$.total = $.price * $.qty")).toEqual([{ $set: { total: { $multiply: ["$price", "$qty"] } } }]);
  });

  it("supports nested field paths", () => {
    expect(jsmql("$.user.name = 'alice'")).toEqual([{ $set: { "user.name": "alice" } }]);
  });

  it("supports deeply nested field paths", () => {
    expect(jsmql("$.a.b.c.d = 5")).toEqual([{ $set: { "a.b.c.d": 5 } }]);
  });
});

describe("update filters: compound assignment (+=, -=, *=, /=)", () => {
  it("+= with literal", () => {
    expect(jsmql("$.x += 1")).toEqual([{ $set: { x: { $add: ["$x", 1] } } }]);
  });

  it("-= with literal", () => {
    expect(jsmql("$.x -= 3")).toEqual([{ $set: { x: { $subtract: ["$x", 3] } } }]);
  });

  it("*= with literal", () => {
    expect(jsmql("$.x *= 2")).toEqual([{ $set: { x: { $multiply: ["$x", 2] } } }]);
  });

  it("/= with literal", () => {
    expect(jsmql("$.x /= 4")).toEqual([{ $set: { x: { $divide: ["$x", 4] } } }]);
  });

  it("+= with field reference", () => {
    expect(jsmql("$.a += $.b")).toEqual([{ $set: { a: { $add: ["$a", "$b"] } } }]);
  });

  it("+= with string context produces $concat", () => {
    expect(jsmql("$.greeting += '!'")).toEqual([{ $set: { greeting: { $concat: ["$greeting", "!"] } } }]);
  });

  it("compound on nested path", () => {
    expect(jsmql("$.user.score += 10")).toEqual([{ $set: { "user.score": { $add: ["$user.score", 10] } } }]);
  });

  it("RHS can be a complex expression", () => {
    expect(jsmql("$.total += $.items.reduce((acc, x) => acc + x, 0)")).toEqual([
      {
        $set: {
          total: {
            $add: ["$total", { $reduce: { input: "$items", initialValue: 0, in: { $add: ["$$value", "$$this"] } } }],
          },
        },
      },
    ]);
  });
});

describe("update filters: increment/decrement (++x, x++, --x, x--)", () => {
  // In MQL pipeline context the prefix/postfix distinction is irrelevant —
  // there is no "value of expression" for a stage-level update op, so all four
  // forms compile to the same `$set: { x: { $add|$subtract: ["$x", 1] } }`.

  it("postfix ++ on a top-level field", () => {
    expect(jsmql("$.x++")).toEqual([{ $set: { x: { $add: ["$x", 1] } } }]);
  });

  it("prefix ++ on a top-level field", () => {
    expect(jsmql("++$.x")).toEqual([{ $set: { x: { $add: ["$x", 1] } } }]);
  });

  it("postfix -- on a top-level field", () => {
    expect(jsmql("$.x--")).toEqual([{ $set: { x: { $subtract: ["$x", 1] } } }]);
  });

  it("prefix -- on a top-level field", () => {
    expect(jsmql("--$.x")).toEqual([{ $set: { x: { $subtract: ["$x", 1] } } }]);
  });

  it("postfix ++ on a nested path", () => {
    expect(jsmql("$.user.score++")).toEqual([{ $set: { "user.score": { $add: ["$user.score", 1] } } }]);
  });

  it("prefix -- on a nested path", () => {
    expect(jsmql("--$.cart.itemCount")).toEqual([
      { $set: { "cart.itemCount": { $subtract: ["$cart.itemCount", 1] } } },
    ]);
  });

  it("multiple inc/dec coalesce into one $set", () => {
    expect(jsmql("$.a++, $.b--, ++$.c")).toEqual([
      { $set: { a: { $add: ["$a", 1] }, b: { $subtract: ["$b", 1] }, c: { $add: ["$c", 1] } } },
    ]);
  });

  it("inc/dec mixed with assignments coalesce into one $set", () => {
    expect(jsmql("$.cnt++, $.label = 'done'")).toEqual([{ $set: { cnt: { $add: ["$cnt", 1] }, label: "done" } }]);
  });

  it("inc/dec inside a pipeline", () => {
    expect(jsmql("[$match($.active), $.views++, $sort({views: -1})]")).toEqual([
      { $match: { $expr: "$active" } },
      { $set: { views: { $add: ["$views", 1] } } },
      { $sort: { views: -1 } },
    ]);
  });

  it("parens around postfix work (formatter-friendly)", () => {
    expect(jsmql("($.x++)")).toEqual([{ $set: { x: { $add: ["$x", 1] } } }]);
  });

  it("parens around prefix work", () => {
    expect(jsmql("(++$.x)")).toEqual([{ $set: { x: { $add: ["$x", 1] } } }]);
  });

  it("parens around inc/dec inside pipeline arrays work", () => {
    expect(jsmql("[$match($.active), ($.views++), (--$.lives)]")).toEqual([
      { $match: { $expr: "$active" } },
      { $set: { views: { $add: ["$views", 1] }, lives: { $subtract: ["$lives", 1] } } },
    ]);
  });

  it("read-after-write splits when a later update op references an inc'd field", () => {
    expect(jsmql("$.cnt++; $.lastCnt = $.cnt")).toEqual([
      { $set: { cnt: { $add: ["$cnt", 1] } } },
      { $set: { lastCnt: "$cnt" } },
    ]);
  });

  it("rejects inc/dec on a bare identifier", () => {
    const result = jsmql.validate("x++");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/field path|bare identifier/i);
  });

  it("rejects prefix inc/dec on a bare identifier", () => {
    const result = jsmql.validate("++x");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/field path|bare identifier/i);
  });

  it("rejects inc/dec on index access", () => {
    const result = jsmql.validate("$.items[0]++");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/index access|computed/i);
  });

  it("rejects inc/dec used as a value (postfix in expression context)", () => {
    // `1 + $.x++` — $.x++ is a statement, not a value
    const result = jsmql.validate("1 + $.x++");
    expect(result.valid).toBe(false);
  });

  it("regression: `5 - -3` still parses (whitespace separates the minuses)", () => {
    // Without space, `5--3` lexes as `5 -- 3` (MinusMinus token) and would be
    // rejected as an inc/dec on a non-field-path target. With whitespace, the
    // two minuses lex as separate Minus tokens and the unary minus path runs.
    // `jsmql.expr()` lowers as an aggregation expression so the lex shape is visible
    // without the Filter `$expr` wrap that `jsmql()` would add.
    expect(jsmql.expr("5 - -3")).toEqual({ $subtract: [5, -3] });
  });
});

describe("update filters: sequencing", () => {
  it("two independent assignments coalesce into one $set (comma separator)", () => {
    expect(jsmql("$.a = 1, $.b = 2")).toEqual([{ $set: { a: 1, b: 2 } }]);
  });

  it("read-after-write splits into two $set stages", () => {
    expect(jsmql("$.a = 1, $.b = $.a")).toEqual([{ $set: { a: 1 } }, { $set: { b: "$a" } }]);
  });

  it("write-after-write to same path splits", () => {
    expect(jsmql("$.a = 1, $.a = 2")).toEqual([{ $set: { a: 1 } }, { $set: { a: 2 } }]);
  });

  it("parent-child path collision splits", () => {
    expect(jsmql("$.a = 1, $.a.b = 2")).toEqual([{ $set: { a: 1 } }, { $set: { "a.b": 2 } }]);
  });

  it("three-way with middle dependency", () => {
    expect(jsmql("$.a = 1, $.b = $.a, $.c = 3")).toEqual([{ $set: { a: 1 } }, { $set: { b: "$a", c: 3 } }]);
  });

  it("trailing comma allowed", () => {
    expect(jsmql("$.a = 1,")).toEqual([{ $set: { a: 1 } }]);
  });
});

describe("update filters: chained assignment", () => {
  it("two-way chain", () => {
    expect(jsmql("$.a = $.b = 5")).toEqual([{ $set: { a: 5, b: 5 } }]);
  });

  it("three-way chain", () => {
    expect(jsmql("$.a = $.b = $.c = 5")).toEqual([{ $set: { a: 5, b: 5, c: 5 } }]);
  });

  it("chain with complex RHS", () => {
    expect(jsmql("$.x = $.y = $.z + 1")).toEqual([{ $set: { x: { $add: ["$z", 1] }, y: { $add: ["$z", 1] } } }]);
  });
});

describe("update filters: delete", () => {
  it("single delete emits $unset string form", () => {
    expect(jsmql("delete $.tmp")).toEqual([{ $unset: "tmp" }]);
  });

  it("nested delete uses dotted path", () => {
    expect(jsmql("delete $.user.tmp")).toEqual([{ $unset: "user.tmp" }]);
  });

  it("two consecutive deletes coalesce into array form", () => {
    expect(jsmql("delete $.a, delete $.b")).toEqual([{ $unset: ["a", "b"] }]);
  });

  it("three consecutive deletes coalesce", () => {
    expect(jsmql("delete $.a, delete $.b, delete $.c")).toEqual([{ $unset: ["a", "b", "c"] }]);
  });

  it("delete-then-assign breaks (kind change)", () => {
    expect(jsmql("delete $.a, $.b = 1")).toEqual([{ $unset: "a" }, { $set: { b: 1 } }]);
  });

  it("assign-then-delete breaks (kind change)", () => {
    expect(jsmql("$.a = 1, delete $.b")).toEqual([{ $set: { a: 1 } }, { $unset: "b" }]);
  });

  it("delete a path the prior assignment wrote splits", () => {
    expect(jsmql("$.a = 1, delete $.a")).toEqual([{ $set: { a: 1 } }, { $unset: "a" }]);
  });

  it("delete a child of an assigned parent splits", () => {
    expect(jsmql("$.a = 1, delete $.a.b")).toEqual([{ $set: { a: 1 } }, { $unset: "a.b" }]);
  });
});

describe("update filters: realistic mixed (user-supplied)", () => {
  it("assignment + compound coalesce: total = price*qty, views += 1", () => {
    expect(jsmql("$.total = $.price * $.qty, $.views += 1")).toEqual([
      { $set: { total: { $multiply: ["$price", "$qty"] }, views: { $add: ["$views", 1] } } },
    ]);
  });

  it("two deletes + assignment splits at kind change", () => {
    expect(jsmql("delete $.tempToken, delete $._processingState, $.status = 'complete'")).toEqual([
      { $unset: ["tempToken", "_processingState"] },
      { $set: { status: "complete" } },
    ]);
  });

  it("three-stage coalescing across kind boundaries: $set → $unset → $set", () => {
    // Assignments coalesce into one $set; the kind change at `delete` opens a
    // new $unset stage (two paths → array form); the kind change back to
    // assignment opens the final $set.
    expect(
      jsmql(
        "$.lineTotal = $.qty * $.unitPrice, $.invoiceCount += 1, " +
          "delete $.tempToken, delete $._processingState, " +
          "$.status = 'complete'",
      ),
    ).toEqual([
      { $set: { lineTotal: { $multiply: ["$qty", "$unitPrice"] }, invoiceCount: { $add: ["$invoiceCount", 1] } } },
      { $unset: ["tempToken", "_processingState"] },
      { $set: { status: "complete" } },
    ]);
  });
});

describe("update filters: in pipelines", () => {
  it("pipeline with assignment between stages", () => {
    expect(jsmql("[$match($.active), $.score += 1, $sort({score: -1})]")).toEqual([
      { $match: { $expr: "$active" } },
      { $set: { score: { $add: ["$score", 1] } } },
      { $sort: { score: -1 } },
    ]);
  });

  it("consecutive update op elements coalesce inside a pipeline", () => {
    expect(jsmql("[$match($.active), $.a = 1, $.b = 2, $sort({c: 1})]")).toEqual([
      { $match: { $expr: "$active" } },
      { $set: { a: 1, b: 2 } },
      { $sort: { c: 1 } },
    ]);
  });

  it("non-update op stage between update ops breaks coalescing", () => {
    expect(jsmql("[$.a = 1, $sort({a: 1}), $.b = 2]")).toEqual([
      { $set: { a: 1 } },
      { $sort: { a: 1 } },
      { $set: { b: 2 } },
    ]);
  });

  it("delete inside a pipeline", () => {
    expect(jsmql("[$match($.active), delete $.tmp, $sort({a: 1})]")).toEqual([
      { $match: { $expr: "$active" } },
      { $unset: "tmp" },
      { $sort: { a: 1 } },
    ]);
  });

  it("a pipeline whose first element is a update op is still detected as a pipeline", () => {
    expect(jsmql("[$.a = 1, $sort({a: 1})]")).toEqual([{ $set: { a: 1 } }, { $sort: { a: 1 } }]);
  });
});

describe("update filters: parenthesized form (formatter-friendly)", () => {
  // Formatters (oxfmt, prettier) wrap assignment expressions in parens when
  // they appear in array element position. The parser unwraps these so the
  // function-input form `jsmql(($) => [($.a = 1)])` produces the same output
  // as the bare `jsmql("[$.a = 1]")`.

  it("parens around an assignment at the top level work", () => {
    expect(jsmql("($.a = 5)")).toEqual([{ $set: { a: 5 } }]);
  });

  it("parens around a compound assignment work", () => {
    expect(jsmql("($.x += 1)")).toEqual([{ $set: { x: { $add: ["$x", 1] } } }]);
  });

  it("parens around assignments as pipeline elements coalesce normally", () => {
    expect(jsmql("[$match($.active), ($.a = 1), ($.b = 2), $sort({c: 1})]")).toEqual([
      { $match: { $expr: "$active" } },
      { $set: { a: 1, b: 2 } },
      { $sort: { c: 1 } },
    ]);
  });

  it("parens around assignments mixed with bare assignments work", () => {
    expect(jsmql("[$match($.active), ($.a = 1), $.b = 2]")).toEqual([
      { $match: { $expr: "$active" } },
      { $set: { a: 1, b: 2 } },
    ]);
  });

  it("comma-chained parenthesized assignments coalesce into one $set", () => {
    // Formatter output: prettier and oxfmt wrap each assignment in parens and
    // join the chain with `,` when it appears as a statement at the top of a
    // block-body arrow. The two halves must combine into one $set, just like
    // the bare-form `$.a = 1, $.b = 2`.
    expect(jsmql("($.a = 1), ($.b = 2)")).toEqual([{ $set: { a: 1, b: 2 } }]);
  });

  it("comma-chained parenthesized assignments in a block-body arrow", () => {
    expect(
      jsmql(($, { $match }) => {
        $match($.status === "pending");
        (($.lineTotal = $.qty * $.unitPrice), ($.invoiceCount += 1));
        $.status = "complete";
      }),
    ).toEqual([
      { $match: { status: "pending" } },
      { $set: { lineTotal: { $multiply: ["$qty", "$unitPrice"] }, invoiceCount: { $add: ["$invoiceCount", 1] } } },
      { $set: { status: "complete" } },
    ]);
  });

  it("comma-chained parens mixing assignment and postfix inc/dec", () => {
    expect(jsmql("($.a = 1), ($.cnt++)")).toEqual([{ $set: { a: 1, cnt: { $add: ["$cnt", 1] } } }]);
  });
});

describe("update filters: validation errors", () => {
  it("rejects bare identifier as target", () => {
    const result = jsmql.validate("x = 5");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/field path|bare identifier/i);
  });

  it("rejects bare identifier in delete", () => {
    const result = jsmql.validate("delete x");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/field path|bare identifier/i);
  });

  it("rejects index-access target", () => {
    const result = jsmql.validate("$.items[0] = 5");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/index access|computed/i);
  });

  it("rejects assignment inside lambda body", () => {
    const result = jsmql.validate("$.list.map(x => $.a = x)");
    expect(result.valid).toBe(false);
  });

  it("rejects compound chained assignment", () => {
    const result = jsmql.validate("$.a += $.b += 1");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/chained|chain/i);
  });

  it("rejects missing RHS", () => {
    const result = jsmql.validate("$.a =");
    expect(result.valid).toBe(false);
  });

  it("rejects bare delete with no target", () => {
    const result = jsmql.validate("delete");
    expect(result.valid).toBe(false);
  });

  it("rejects update op inside parenthesized expression context", () => {
    // ($.a = 1) + 2 — assignment used as a value (codegen-level rejection
    // since parseGrouped now accepts the parens-form syntactically)
    const result = jsmql.validate("($.a = 1) + 2");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/statement, not a value/i);
  });

  it("rejects chained assignment inside parens", () => {
    const result = jsmql.validate("($.a = $.b = 5)");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/chained assignment inside parentheses/i);
  });
});

describe("update filters: lex regression checks", () => {
  // Make sure adding `=`, `+=`, etc. didn't break existing operators. The
  // expectations are the aggregation-expression shape that the lexer +
  // expression codegen produce, surfaced via `jsmql.expr()` so the top-level
  // Filter dispatch doesn't add a wrapping layer the lex test doesn't care
  // about.
  it("== null still parses (loose null check)", () => {
    expect(jsmql.expr("$.a == null")).toEqual({ $in: [{ $type: "$a" }, ["null", "missing"]] });
  });

  it("=== still parses as strict equality", () => {
    expect(jsmql.expr("$.a === 1")).toEqual({ $eq: ["$a", 1] });
  });

  it("=> still parses as arrow", () => {
    expect(jsmql.expr("$.list.map(x => x + 1)")).toEqual({
      $map: { input: "$list", as: "x", in: { $add: ["$$x", 1] } },
    });
  });

  it(">= and <= still parse", () => {
    expect(jsmql.expr("$.a >= 1")).toEqual({ $gte: ["$a", 1] });
    expect(jsmql.expr("$.a <= 1")).toEqual({ $lte: ["$a", 1] });
  });

  it("!= null and !== still parse", () => {
    expect(jsmql.expr("$.a != null")).toEqual({ $not: [{ $in: [{ $type: "$a" }, ["null", "missing"]] }] });
    expect(jsmql.expr("$.a !== 1")).toEqual({ $ne: ["$a", 1] });
  });

  it("** (power) still parses (not confused with *=)", () => {
    expect(jsmql.expr("$.a ** 2")).toEqual({ $pow: ["$a", 2] });
  });

  it("regex literals still work (not confused with /=)", () => {
    expect(jsmql.expr("/abc/.test($.s)")).toEqual({ $regexMatch: { input: "$s", regex: "abc" } });
  });
});
