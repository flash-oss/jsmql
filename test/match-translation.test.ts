import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

// `$match` translates expression-form predicates to MongoDB's query language
// when the predicate is index-safe, falling back to $expr for the parts that
// aren't. This avoids the silent index-disabling effect of `{ $expr: ... }`.
//
// See `docs/specs/match-query-translation.md` for the translation rules and
// the four documented semantic divergences from aggregation $eq.

describe("$match translation — equality", () => {
  it("translates `===` against a string literal", () => {
    expect(jsmql('[$match($.email === "alice@example.com")]')).toEqual([
      { $match: { email: "alice@example.com" } },
    ]);
  });

  it("translates `===` against a number literal", () => {
    expect(jsmql("[$match($.userId === 42)]")).toEqual([{ $match: { userId: 42 } }]);
  });

  it("translates `===` against a boolean literal", () => {
    expect(jsmql("[$match($.active === true)]")).toEqual([{ $match: { active: true } }]);
  });

  it("rejects `==` against a non-null literal in `$match`", () => {
    expect(() => jsmql("[$match($.userId == 42)]")).toThrow(/'=='.*only allowed against null/);
  });

  it("translates `!==` to query-language $ne", () => {
    expect(jsmql('[$match($.status !== "archived")]')).toEqual([
      { $match: { status: { $ne: "archived" } } },
    ]);
  });

  it("rejects `!=` against a non-null literal in `$match`", () => {
    expect(() => jsmql('[$match($.status != "archived")]')).toThrow(
      /'!='.*only allowed against null/,
    );
  });

  it("accepts the field on either side (5 < $.age flips to $.age > 5)", () => {
    expect(jsmql('[$match("alice" === $.name)]')).toEqual([{ $match: { name: "alice" } }]);
  });

  it("uses dotted paths for nested field refs", () => {
    expect(jsmql('[$match($.user.role === "admin")]')).toEqual([
      { $match: { "user.role": "admin" } },
    ]);
  });
});

describe("$match translation — ordered comparisons", () => {
  it("translates `>` to $gt", () => {
    expect(jsmql("[$match($.age > 18)]")).toEqual([{ $match: { age: { $gt: 18 } } }]);
  });

  it("translates `>=`, `<`, `<=`", () => {
    expect(jsmql("[$match($.score >= 80)]")).toEqual([{ $match: { score: { $gte: 80 } } }]);
    expect(jsmql("[$match($.year < 2020)]")).toEqual([{ $match: { year: { $lt: 2020 } } }]);
    expect(jsmql("[$match($.qty <= 5)]")).toEqual([{ $match: { qty: { $lte: 5 } } }]);
  });

  it("translates string ordered comparison (lexicographic dates etc.)", () => {
    expect(jsmql('[$match($.placedAt >= "2026-01-01")]')).toEqual([
      { $match: { placedAt: { $gte: "2026-01-01" } } },
    ]);
  });

  it("flips operator when literal is on the left (`18 < $.age` → `age > 18`)", () => {
    expect(jsmql("[$match(18 < $.age)]")).toEqual([{ $match: { age: { $gt: 18 } } }]);
    expect(jsmql("[$match(5 >= $.qty)]")).toEqual([{ $match: { qty: { $lte: 5 } } }]);
  });
});

describe("$match translation — null vs missing semantics", () => {
  // `===` / `!==` are strict (JS-like): missing fields are NOT null.
  // `==` / `!=` are loose: missing fields are treated as null.
  // The strict form compiles to `$type: "null"` so MongoDB excludes
  // missing-field docs; the loose form keeps the query-language shape
  // which already matches "null OR missing".

  it("translates `=== null` to `{ field: { $type: 'null' } }` (strict — excludes missing)", () => {
    expect(jsmql("[$match($.deletedAt === null)]")).toEqual([
      { $match: { deletedAt: { $type: "null" } } },
    ]);
  });

  it("translates `!== null` to `{ field: { $not: { $type: 'null' } } }` (strict — missing fields pass)", () => {
    expect(jsmql("[$match($.paidAt !== null)]")).toEqual([
      { $match: { paidAt: { $not: { $type: "null" } } } },
    ]);
  });

  it("translates `== null` to `{ field: null }` (loose — matches null OR missing)", () => {
    expect(jsmql("[$match($.deletedAt == null)]")).toEqual([{ $match: { deletedAt: null } }]);
  });

  it("translates `!= null` to `{ field: { $ne: null } }` (loose — excludes both null AND missing)", () => {
    expect(jsmql("[$match($.paidAt != null)]")).toEqual([{ $match: { paidAt: { $ne: null } } }]);
  });

  it("accepts `null` on the left for the loose form", () => {
    expect(jsmql("[$match(null == $.x)]")).toEqual([{ $match: { x: null } }]);
  });
});

describe("$match translation — boolean combinators", () => {
  it("merges `&&` with disjoint keys into a single doc", () => {
    expect(jsmql('[$match($.status === "active" && $.age > 18)]')).toEqual([
      { $match: { status: "active", age: { $gt: 18 } } },
    ]);
  });

  it("uses $and when `&&` operands collide on the same field", () => {
    expect(jsmql("[$match($.age > 18 && $.age < 65)]")).toEqual([
      { $match: { $and: [{ age: { $gt: 18 } }, { age: { $lt: 65 } }] } },
    ]);
  });

  it("translates `||` with two translatable branches into $or", () => {
    expect(jsmql('[$match($.role === "admin" || $.role === "owner")]')).toEqual([
      { $match: { $or: [{ role: "admin" }, { role: "owner" }] } },
    ]);
  });

  it("composes nested && / ||", () => {
    expect(
      jsmql('[$match(($.role === "admin" || $.role === "owner") && $.active === true)]'),
    ).toEqual([
      {
        $match: {
          $or: [{ role: "admin" }, { role: "owner" }],
          active: true,
        },
      },
    ]);
  });
});

describe("$match translation — partial extraction", () => {
  // When part of an `&&` predicate is translatable and part isn't, we keep
  // the translatable half in query-language form (so indexes still apply)
  // and wrap the residual in $expr.
  it("keeps index-using clause, wraps residual in $expr", () => {
    expect(jsmql('[$match($.status === "active" && $.score > $.threshold)]')).toEqual([
      {
        $match: {
          status: "active",
          $expr: { $gt: ["$score", "$threshold"] },
        },
      },
    ]);
  });

  it("combines multiple residuals under a synthetic $and", () => {
    expect(jsmql('[$match($.status === "active" && $.a > $.b && $.c < $.d)]')).toEqual([
      {
        $match: {
          status: "active",
          $expr: { $and: [{ $gt: ["$a", "$b"] }, { $lt: ["$c", "$d"] }] },
        },
      },
    ]);
  });

  it("residual under `||` falls back to wholesale $expr (no index-safe split)", () => {
    // We can't emit `$or: [<query>, { $expr: ... }]` and preserve the
    // disjunction's index-using guarantee, so if either `||` branch has a
    // residual, the entire expression becomes a residual.
    expect(jsmql('[$match($.status === "active" || $.score > $.threshold)]')).toEqual([
      {
        $match: {
          $expr: {
            $or: [{ $eq: ["$status", "active"] }, { $gt: ["$score", "$threshold"] }],
          },
        },
      },
    ]);
  });
});

describe("$match translation — untranslatable shapes ($expr fallback)", () => {
  it("field-to-field comparison stays in $expr (would be a literal string match)", () => {
    expect(jsmql("[$match($.a === $.b)]")).toEqual([{ $match: { $expr: { $eq: ["$a", "$b"] } } }]);
  });

  it("method call on a field stays in $expr", () => {
    expect(jsmql('[$match($.name.toLowerCase() === "alice")]')).toEqual([
      { $match: { $expr: { $eq: [{ $toLower: "$name" }, "alice"] } } },
    ]);
  });

  it("operator-call result on either side stays in $expr", () => {
    expect(jsmql("[$match($size($.tags) > 0)]")).toEqual([
      { $match: { $expr: { $gt: [{ $size: "$tags" }, 0] } } },
    ]);
  });

  it("Math call result stays in $expr", () => {
    expect(jsmql("[$match(Math.abs($.delta) > 5)]")).toEqual([
      { $match: { $expr: { $gt: [{ $abs: "$delta" }, 5] } } },
    ]);
  });

  it("array literal as equality target stays in $expr", () => {
    // Translating to `{ tags: [1, 2] }` would silently switch to array-element
    // matching semantics — too surprising. Leave it as $expr.
    expect(jsmql("[$match($.tags === [1, 2])]")).toEqual([
      { $match: { $expr: { $eq: ["$tags", [1, 2]] } } },
    ]);
  });
});

describe("$match translation — typeof → $type", () => {
  it('translates `typeof $.x === "string"` to query-doc $type', () => {
    expect(jsmql('[$match(typeof $.email === "string")]')).toEqual([
      { $match: { email: { $type: "string" } } },
    ]);
  });
  it("accepts the literal on either side", () => {
    expect(jsmql('[$match("int" === typeof $.count)]')).toEqual([
      { $match: { count: { $type: "int" } } },
    ]);
  });
  it("translates `!==` via $not", () => {
    expect(jsmql('[$match(typeof $.x !== "null")]')).toEqual([
      { $match: { x: { $not: { $type: "null" } } } },
    ]);
  });
  it("works on nested field paths", () => {
    expect(jsmql('[$match(typeof $.user.role === "string")]')).toEqual([
      { $match: { "user.role": { $type: "string" } } },
    ]);
  });
  it("combines with other translated clauses via $and-merge", () => {
    expect(jsmql('[$match(typeof $.age === "int" && $.age > 18)]')).toEqual([
      {
        $match: {
          $and: [{ age: { $type: "int" } }, { age: { $gt: 18 } }],
        },
      },
    ]);
  });
  it("falls through to $expr for unknown type aliases", () => {
    expect(jsmql('[$match(typeof $.fn === "function")]')).toEqual([
      { $match: { $expr: { $eq: [{ $type: "$fn" }, "function"] } } },
    ]);
  });
  it("falls through to $expr when the operand is not a static field path", () => {
    expect(jsmql('[$match(typeof $.name.toLowerCase() === "string")]')).toEqual([
      {
        $match: {
          $expr: { $eq: [{ $type: { $toLower: "$name" } }, "string"] },
        },
      },
    ]);
  });
});

describe("$match translation — escape hatch", () => {
  it("object-literal body with $expr passes through unchanged", () => {
    // The existing object-literal passthrough is the explicit opt-out for
    // strict aggregation `$eq` semantics.
    expect(jsmql('[$match({ $expr: $.email === "x" })]')).toEqual([
      { $match: { $expr: { $eq: ["$email", "x"] } } },
    ]);
  });

  it("object-literal body with a mix of query and $expr passes through unchanged", () => {
    expect(jsmql('[$match({ status: "active", $expr: $.score > $.threshold })]')).toEqual([
      {
        $match: {
          status: "active",
          $expr: { $gt: ["$score", "$threshold"] },
        },
      },
    ]);
  });
});
