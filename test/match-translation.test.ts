import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

// `$match` translates expression-form predicates to MongoDB's query language
// when the predicate is index-safe, falling back to $expr for the parts that
// are not. This avoids the silent index-disabling effect of `{ $expr: ... }`.
//
// See `docs/specs/emit-pass.md` § The filter target for the translation rules and
// the documented semantic divergences from the aggregation form.

describe("$match translation — equality", () => {
  it("translates `===` against a string literal", () => {
    expect(jsmql('[$match($.email === "alice@example.com")]')).toEqual([{ $match: { email: "alice@example.com" } }]);
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
    expect(jsmql('[$match($.status !== "archived")]')).toEqual([{ $match: { status: { $ne: "archived" } } }]);
  });

  it("rejects `!=` against a non-null literal in `$match`", () => {
    expect(() => jsmql('[$match($.status != "archived")]')).toThrow(/'!='.*only allowed against null/);
  });

  it("accepts the field on either side (5 < $.age flips to $.age > 5)", () => {
    expect(jsmql('[$match("alice" === $.name)]')).toEqual([{ $match: { name: "alice" } }]);
  });

  it("uses dotted paths for nested field refs", () => {
    expect(jsmql('[$match($.user.role === "admin")]')).toEqual([{ $match: { "user.role": "admin" } }]);
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
    expect(jsmql('[$match($.placedAt >= "2026-01-01")]')).toEqual([{ $match: { placedAt: { $gte: "2026-01-01" } } }]);
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
    expect(jsmql("[$match($.deletedAt === null)]")).toEqual([{ $match: { deletedAt: { $type: "null" } } }]);
  });

  it("translates `!== null` to `{ field: { $not: { $type: 'null' } } }` (strict — missing fields pass)", () => {
    expect(jsmql("[$match($.paidAt !== null)]")).toEqual([{ $match: { paidAt: { $not: { $type: "null" } } } }]);
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
    expect(jsmql("[$match($.age > 18 && $.age < 65)]")).toEqual([{ $match: { age: { $gt: 18, $lt: 65 } } }]);
  });

  it("translates `||` with two translatable branches into $or", () => {
    expect(jsmql('[$match($.role === "admin" || $.role === "owner")]')).toEqual([
      { $match: { $or: [{ role: "admin" }, { role: "owner" }] } },
    ]);
  });

  it("composes nested && / ||", () => {
    expect(jsmql('[$match(($.role === "admin" || $.role === "owner") && $.active === true)]')).toEqual([
      { $match: { $or: [{ role: "admin" }, { role: "owner" }], active: true } },
    ]);
  });
});

describe("$match translation — partial extraction", () => {
  // When part of an `&&` predicate is translatable and part is not, we keep
  // the translatable half in query-language form (so indexes still apply)
  // and wrap the residual in $expr.
  it("keeps index-using clause, wraps residual in $expr", () => {
    expect(jsmql('[$match($.status === "active" && $.score > $.threshold)]')).toEqual([
      { $match: { status: "active", $expr: { $gt: ["$score", "$threshold"] } } },
    ]);
  });

  it("combines multiple residuals under a synthetic $and", () => {
    expect(jsmql('[$match($.status === "active" && $.a > $.b && $.c < $.d)]')).toEqual([
      { $match: { status: "active", $expr: { $and: [{ $gt: ["$a", "$b"] }, { $lt: ["$c", "$d"] }] } } },
    ]);
  });

  it("residual under `||` falls back to wholesale $expr (no index-safe split)", () => {
    // We cannot emit `$or: [<query>, { $expr: ... }]` and preserve the
    // disjunction's index-using guarantee, so if either `||` branch has a
    // residual, the entire expression becomes a residual.
    expect(jsmql('[$match($.status === "active" || $.score > $.threshold)]')).toEqual([
      { $match: { $or: [{ status: "active" }, { $expr: { $gt: ["$score", "$threshold"] } }] } },
    ]);
  });
});

describe("$match translation — untranslatable shapes ($expr fallback)", () => {
  it("field-to-field comparison stays in $expr (would be a literal string match)", () => {
    expect(jsmql("[$match($.a === $.b)]")).toEqual([{ $match: { $expr: { $eq: ["$a", "$b"] } } }]);
  });

  it("method call on a field stays in $expr", () => {
    expect(jsmql('[$match($.name.toLowerCase() === "alice")]')).toEqual([
      {
        $match: {
          $expr: {
            $eq: [
              { $cond: { if: { $eq: [{ $ifNull: ["$name", null] }, null] }, then: null, else: { $toLower: "$name" } } },
              "alice",
            ],
          },
        },
      },
    ]);
  });

  it("operator-call result on either side stays in $expr", () => {
    expect(jsmql("[$match($size($.tags) > 0)]")).toEqual([{ $match: { $expr: { $gt: [{ $size: "$tags" }, 0] } } }]);
  });

  it("Math call result stays in $expr", () => {
    expect(jsmql("[$match(Math.abs($.delta) > 5)]")).toEqual([{ $match: { $expr: { $gt: [{ $abs: "$delta" }, 5] } } }]);
  });

  it("array literal as equality target stays in $expr", () => {
    // Translating to `{ tags: [1, 2] }` would silently switch to array-element
    // matching semantics — too surprising. Leave it as $expr.
    expect(jsmql("[$match($.tags === [1, 2])]")).toEqual([{ $match: { $expr: { $eq: ["$tags", [1, 2]] } } }]);
  });
});

describe("$match translation — typeof → $type", () => {
  it('translates `typeof $.x === "string"` to query-doc $type', () => {
    expect(jsmql('[$match(typeof $.email === "string")]')).toEqual([{ $match: { email: { $type: "string" } } }]);
  });
  it("accepts the literal on either side", () => {
    expect(jsmql('[$match("int" === typeof $.count)]')).toEqual([{ $match: { count: { $type: "int" } } }]);
  });
  it("translates `!==` through $not", () => {
    expect(jsmql('[$match(typeof $.x !== "null")]')).toEqual([{ $match: { x: { $not: { $type: "null" } } } }]);
  });
  it("works on nested field paths", () => {
    expect(jsmql('[$match(typeof $.user.role === "string")]')).toEqual([
      { $match: { "user.role": { $type: "string" } } },
    ]);
  });
  it("combines with other translated clauses through $and-merge", () => {
    expect(jsmql('[$match(typeof $.age === "int" && $.age > 18)]')).toEqual([
      { $match: { age: { $type: "int", $gt: 18 } } },
    ]);
  });
  it("falls through to $expr for unknown type aliases", () => {
    expect(() => jsmql('[$match(typeof $.fn === "function")]')).toThrow(
      "'typeof' compares against one of MongoDB's type names, and \"function\" is not one. Did you mean 'javascript'? For absence, write 'x === undefined'.",
    );
  });
  it("falls through to $expr when the operand is not a static field path", () => {
    expect(jsmql('[$match(typeof $.name.toLowerCase() === "string")]')).toEqual([
      {
        $match: {
          $expr: {
            $eq: [
              {
                $type: {
                  $cond: { if: { $eq: [{ $ifNull: ["$name", null] }, null] }, then: null, else: { $toLower: "$name" } },
                },
              },
              "string",
            ],
          },
        },
      },
    ]);
  });
});

describe("$match translation — escape hatch", () => {
  it("object-literal body with $expr passes through unchanged", () => {
    // The existing object-literal passthrough is the explicit opt-out for
    // strict aggregation `$eq` semantics.
    expect(jsmql('[$match({ $expr: $.email === "x" })]')).toEqual([{ $match: { $expr: { $eq: ["$email", "x"] } } }]);
  });

  it("object-literal body with a mix of query and $expr passes through unchanged", () => {
    expect(jsmql('[$match({ status: "active", $expr: $.score > $.threshold })]')).toEqual([
      { $match: { status: "active", $expr: { $gt: ["$score", "$threshold"] } } },
    ]);
  });
});

describe("$match translation — `new Date(...)` RHS (compile-time fold)", () => {
  // MongoDB's query language does not evaluate aggregation expressions in
  // operator value slots — `{ $gte: { $toDate: "..." } }` would be compared
  // as a literal subdoc, never matching anything. When the `new Date(...)`
  // arguments are themselves compile-time literals we fold to a real Date
  // instance, which BSON compares as a date — index-friendly form.

  it("translates `>=` against `new Date(stringLiteral)` to field-form Date", () => {
    expect(jsmql('[$match($.createdAt >= new Date("2026-01-01"))]')).toEqual([
      { $match: { createdAt: { $gte: new Date("2026-01-01T00:00:00.000Z") } } },
    ]);
  });

  it("translates the bug-report shape in bare Filter mode", () => {
    expect(jsmql('$.method === "postalDelivery" && $.createdAt >= new Date("2026-01-01")')).toEqual({
      method: "postalDelivery",
      createdAt: { $gte: new Date("2026-01-01T00:00:00.000Z") },
    });
  });

  it("translates `>`, `<`, `<=` and equality the same way", () => {
    expect(jsmql('[$match($.createdAt > new Date("2026-01-01"))]')).toEqual([
      { $match: { createdAt: { $gt: new Date("2026-01-01T00:00:00.000Z") } } },
    ]);
    expect(jsmql('[$match($.createdAt < new Date("2026-01-01"))]')).toEqual([
      { $match: { createdAt: { $lt: new Date("2026-01-01T00:00:00.000Z") } } },
    ]);
    expect(jsmql('[$match($.createdAt <= new Date("2026-01-01"))]')).toEqual([
      { $match: { createdAt: { $lte: new Date("2026-01-01T00:00:00.000Z") } } },
    ]);
    expect(jsmql('[$match($.startedAt === new Date("2026-01-01"))]')).toEqual([
      { $match: { startedAt: new Date("2026-01-01T00:00:00.000Z") } },
    ]);
    expect(jsmql('[$match($.startedAt !== new Date("2026-01-01"))]')).toEqual([
      { $match: { startedAt: { $ne: new Date("2026-01-01T00:00:00.000Z") } } },
    ]);
  });

  it("flips the operator when `new Date` is on the left", () => {
    expect(jsmql('[$match(new Date("2026-01-01") <= $.createdAt)]')).toEqual([
      { $match: { createdAt: { $gte: new Date("2026-01-01T00:00:00.000Z") } } },
    ]);
  });

  it("folds the date-from-parts form (all-numeric args) as UTC", () => {
    // Multi-arg `new Date(y, m, d)` is interpreted as UTC — same as the
    // `$dateFromParts` codegen lowering — so the folded value is TZ-independent
    // (the expected uses Date.UTC, NOT the machine-local `new Date(2026,0,1)`).
    expect(jsmql("[$match($.createdAt >= new Date(2026, 1, 1))]")).toEqual([
      { $match: { createdAt: { $gte: new Date("2026-02-01T00:00:00.000Z") } } },
    ]);
  });

  it("folds `new Date(Date.UTC(...))` for UTC-anchored dates", () => {
    expect(jsmql("[$match($.createdAt >= new Date(Date.UTC(2026, 1, 1)))]")).toEqual([
      { $match: { createdAt: { $gte: new Date("2026-02-01T00:00:00.000Z") } } },
    ]);
  });

  it("falls back to $expr for `new Date()` (zero-arg — must evaluate at query time)", () => {
    // `new Date()` lowers to the server-side `"$$NOW"`; a compile-time fold
    // would freeze the timestamp. Must stay in $expr.
    expect(jsmql("[$match($.expiresAt < new Date())]")).toEqual([
      { $match: { $expr: { $lt: ["$expiresAt", "$$NOW"] } } },
    ]);
  });

  it("falls back to $expr when an argument is a field ref", () => {
    expect(jsmql("[$match($.createdAt >= new Date($.cutoffStr))]")).toEqual([
      { $match: { $expr: { $gte: ["$createdAt", { $toDate: "$cutoffStr" }] } } },
    ]);
  });

  it("rejects a constant string that cannot be parsed as a date (HR3)", () => {
    // The constant is unparseable and the server would reject the equivalent
    // `{ $toDate }`, so the comparison drops to the $expr residual and codegen
    // refuses it at compile time rather than emit a bogus filter.
    expect(() => jsmql('[$match($.createdAt >= new Date("not-a-date"))]')).toThrow(
      'new Date(<constant>) — only an ISO 8601 string or a millisecond count is a date constant, and this one is neither a valid date string nor a number. Write new Date("2026-01-01") or new Date(0).',
    );
  });

  it("merges with other clauses under && and uses $and on key collision", () => {
    expect(jsmql('[$match($.createdAt >= new Date("2026-01-01") && $.createdAt < new Date("2026-02-01"))]')).toEqual([
      {
        $match: {
          createdAt: { $gte: new Date("2026-01-01T00:00:00.000Z"), $lt: new Date("2026-02-01T00:00:00.000Z") },
        },
      },
    ]);
  });
});

describe("$match translation — .has() → $in / array-element", () => {
  // Two query-position forms; both index-friendly. The first IS MongoDB's
  // "field value, or array containing value", which is what `.has` asks on an
  // array; the second is set-membership over a constant list. `.includes` is the
  // substring test of a STRING, and the query spelling for it is an escaped `$regex`.

  it("translates `field.has(<literal>)` to an implicit array-element match", () => {
    expect(jsmql('[$match($.tags.has("vip"))]')).toEqual([{ $match: { tags: "vip" } }]);
  });

  it("translates `[lit,lit,…].has(field)` to `$in`", () => {
    expect(jsmql('[$match(["active", "trial"].has($.status))]')).toEqual([
      { $match: { status: { $in: ["active", "trial"] } } },
    ]);
  });

  it("uses dotted paths for nested receivers", () => {
    expect(jsmql('[$match($.user.roles.has("admin"))]')).toEqual([{ $match: { "user.roles": "admin" } }]);
  });

  it("falls through to $expr when both sides are field paths", () => {
    // `$in` needs an array, so a missing `tags` runs the test on the empty array (HR5).
    expect(jsmql("[$match($.tags.has($.target))]")).toEqual([
      { $match: { $expr: { $in: ["$target", { $ifNull: ["$tags", []] }] } } },
    ]);
  });

  it("falls through to $expr when the array contains a non-literal", () => {
    expect(jsmql('[$match(["active", $.fallback].has($.status))]')).toEqual([
      { $match: { $expr: { $in: ["$status", ["active", "$fallback"]] } } },
    ]);
  });

  it("translates `field.includes(<literal>)` on a string to an escaped `$regex`", () => {
    expect(jsmql('[$match($.name.includes("vip"))]')).toEqual([{ $match: { name: { $regex: /vip/ } } }]);
    expect(jsmql('[$match($.name.includes("a.b"))]')).toEqual([{ $match: { name: { $regex: /a\.b/ } } }]);
  });
});

describe("$match translation — .match(regex) → BSON regex", () => {
  it("translates `$.field.match(/regex/)` to a query-doc regex value", () => {
    const out = jsmql("[$match($.name.match(/^a/i))]") as Array<{ $match: { name: RegExp } }>;
    const re = (out[0].$match.name as unknown as { $regex: RegExp }).$regex;
    expect(re).toBeInstanceOf(RegExp);
    expect(re.source).toBe("^a");
    expect(re.flags).toBe("i");
  });

  it("works on dotted paths", () => {
    const out = jsmql("[$match($.user.email.match(/@example\\.com$/))]") as Array<{ $match: Record<string, RegExp> }>;
    expect((out[0].$match["user.email"] as unknown as { $regex: RegExp }).$regex).toBeInstanceOf(RegExp);
  });

  it("falls through to $expr when the argument is non-literal", () => {
    // A computed regex (or string arg) cannot go in the query-doc slot, so the
    // existing $regexMatch translation handles it.
    expect(jsmql('[$match($.name.match("^a"))]')).toEqual([
      {
        $match: {
          $expr: {
            $cond: {
              if: { $eq: [{ $ifNull: ["$name", null] }, null] },
              then: null,
              else: { $regexMatch: { input: "$name", regex: "^a" } },
            },
          },
        },
      },
    ]);
  });
});

describe("$match translation — .some(p) → $elemMatch", () => {
  it("translates `.some(item => item.field === lit)` to $elemMatch", () => {
    expect(jsmql("[$match($.items.some(item => item.tag === 'vip'))]")).toEqual([
      { $match: { items: { $elemMatch: { tag: "vip" } } } },
    ]);
  });

  it("translates compound predicates inside the lambda", () => {
    expect(jsmql("[$match($.items.some(i => i.qty > 5 && i.tag === 'vip'))]")).toEqual([
      { $match: { items: { $elemMatch: { qty: { $gt: 5 }, tag: "vip" } } } },
    ]);
  });

  it("handles nested member paths on the lambda param", () => {
    expect(jsmql("[$match($.line.some(it => it.product.price > 100))]")).toEqual([
      { $match: { line: { $elemMatch: { "product.price": { $gt: 100 } } } } },
    ]);
  });

  it("falls through to $expr when the lambda body is index-unfriendly", () => {
    // A method call inside the body has no clean query-doc form — fall through
    // to the expression-level $anyElementTrue translation.
    expect(jsmql("[$match($.items.some(it => it.tag.toLowerCase() === 'vip'))]")).toEqual([
      {
        $match: {
          $expr: {
            $anyElementTrue: {
              $map: {
                input: { $ifNull: ["$items", []] },
                as: "it",
                in: {
                  $eq: [
                    {
                      $cond: {
                        if: { $eq: [{ $ifNull: ["$$it.tag", null] }, null] },
                        then: null,
                        else: { $toLower: "$$it.tag" },
                      },
                    },
                    "vip",
                  ],
                },
              },
            },
          },
        },
      },
    ]);
  });

  it("falls through to $expr when the body references the bare param (would need $$ROOT)", () => {
    // The bare-param body forces the expression-form `.some`, which wraps in
    // the jsBool truthiness-shim (matches JS, not MQL, semantics).
    expect(jsmql("[$match($.items.some(it => it))]")).toEqual([
      {
        $match: {
          $expr: {
            $anyElementTrue: {
              $map: {
                input: { $ifNull: ["$items", []] },
                as: "it",
                in: {
                  $and: [
                    { $ne: [{ $ifNull: ["$$it", null] }, null] },
                    { $ne: ["$$it", false] },
                    { $ne: ["$$it", ""] },
                    { $ne: ["$$it", 0] },
                  ],
                },
              },
            },
          },
        },
      },
    ]);
  });
});

describe("$match translation — === undefined / !== undefined → $exists", () => {
  // `undefined` in match position lowers to MongoDB's $exists check —
  // matches "field present" vs "field missing", which lines up with JS
  // `=== undefined` semantics (treats missing-property as undefined).

  it("translates `=== undefined` to `$exists: false`", () => {
    expect(jsmql("[$match($.field === undefined)]")).toEqual([{ $match: { field: { $exists: false } } }]);
  });

  it("translates `!== undefined` to `$exists: true`", () => {
    expect(jsmql("[$match($.field !== undefined)]")).toEqual([{ $match: { field: { $exists: true } } }]);
  });

  it("works on dotted paths", () => {
    expect(jsmql("[$match($.user.deletedAt === undefined)]")).toEqual([
      { $match: { "user.deletedAt": { $exists: false } } },
    ]);
  });

  it("accepts undefined on the left side", () => {
    expect(jsmql("[$match(undefined === $.field)]")).toEqual([{ $match: { field: { $exists: false } } }]);
  });

  it("is an existence test in expression position too, not an error", () => {
    // `$type` distinguishes a missing field ("missing") from a present-but-null one
    // ("null"), which is exactly the line `$exists` draws — so the expression language
    // CAN express existence, and does.
    expect(jsmql.expr("$.x === undefined ? 1 : 2")).toEqual({
      $cond: { if: { $eq: [{ $type: "$x" }, "missing"] }, then: 1, else: 2 },
    });
  });

  it("still rejects `undefined` used as a VALUE rather than compared", () => {
    expect(() => jsmql.expr("$.a + undefined")).toThrow(/'undefined' is only meaningful in a comparison/);
  });
});

describe("$match translation — typeof: 'boolean' → 'bool' mapping", () => {
  it("translates JS-form `typeof === 'boolean'` to BSON `bool`", () => {
    // JS's typeof returns "boolean"; MongoDB's $type uses "bool". The
    // translator accepts either spelling and emits the BSON form.
    expect(() => jsmql("[$match(typeof $.flag === 'boolean')]")).toThrow(
      "'typeof' compares against one of MongoDB's type names, and \"boolean\" is not one. Did you mean 'bool'? For absence, write 'x === undefined'.",
    );
  });

  it("still accepts the raw BSON alias `bool`", () => {
    expect(jsmql("[$match(typeof $.flag === 'bool')]")).toEqual([{ $match: { flag: { $type: "bool" } } }]);
  });
});

describe("$match translation — .size() → a guarded $size under $expr", () => {
  // `.size()` counts the elements of an array. The query language has no operator for a
  // count, so the comparison stays under `$expr`. A missing array runs `.size()` on the
  // empty array (HR5), as lodash's `_.size(undefined)` is 0, so `$size` never aborts.
  // `.length()` is the length of a STRING: on a bare field it takes `$strLenCP` under a
  // null guard, with no test of the receiver's type at run time.

  it("translates `$.arr.size() === N` to a guarded `$size`", () => {
    expect(jsmql("[$match($.items.size() === 3)]")).toEqual([
      { $match: { $expr: { $eq: [{ $size: { $ifNull: ["$items", []] } }, 3] } } },
    ]);
  });

  it("translates `!== N` the same way", () => {
    expect(jsmql("[$match($.items.size() !== 0)]")).toEqual([
      { $match: { $expr: { $ne: [{ $size: { $ifNull: ["$items", []] } }, 0] } } },
    ]);
  });

  it("accepts the literal on either side", () => {
    expect(jsmql("[$match(3 === $.items.size())]")).toEqual([
      { $match: { $expr: { $eq: [3, { $size: { $ifNull: ["$items", []] } }] } } },
    ]);
  });

  it("works on dotted paths", () => {
    expect(jsmql("[$match($.order.items.size() === 1)]")).toEqual([
      { $match: { $expr: { $eq: [{ $size: { $ifNull: ["$order.items", []] } }, 1] } } },
    ]);
  });

  it("handles ordered comparisons", () => {
    expect(jsmql("[$match($.items.size() < 20)]")).toEqual([
      { $match: { $expr: { $lt: [{ $size: { $ifNull: ["$items", []] } }, 20] } } },
    ]);
    expect(jsmql("[$match($.items.size() >= 2)]")).toEqual([
      { $match: { $expr: { $gte: [{ $size: { $ifNull: ["$items", []] } }, 2] } } },
    ]);
    expect(jsmql("[$match(0 < $.items.size())]")).toEqual([
      { $match: { $expr: { $lt: [0, { $size: { $ifNull: ["$items", []] } }] } } },
    ]);
  });

  it("compares the count against any literal, natural or not", () => {
    // A count is a whole number, so `=== 3.5`, `=== "x"` and `=== -1` select nothing; the shape stays the same.
    expect(jsmql("[$match($.items.size() === 3.5)]")).toEqual([
      { $match: { $expr: { $eq: [{ $size: { $ifNull: ["$items", []] } }, 3.5] } } },
    ]);
    expect(jsmql("[$match($.items.size() < 3.5)]")).toEqual([
      { $match: { $expr: { $lt: [{ $size: { $ifNull: ["$items", []] } }, 3.5] } } },
    ]);
    expect(jsmql('[$match($.items.size() === "x")]')).toEqual([
      { $match: { $expr: { $eq: [{ $size: { $ifNull: ["$items", []] } }, "x"] } } },
    ]);
    expect(jsmql("[$match($.items.size() === -1)]")).toEqual([
      { $match: { $expr: { $eq: [{ $size: { $ifNull: ["$items", []] } }, -1] } } },
    ]);
  });

  it("reads `.length()` on a bare field as a string length: `$strLenCP` under a null guard", () => {
    expect(jsmql("[$match($.name.length() === 3)]")).toEqual([
      {
        $match: {
          $expr: {
            $eq: [
              {
                $cond: { if: { $eq: [{ $ifNull: ["$name", null] }, null] }, then: null, else: { $strLenCP: "$name" } },
              },
              3,
            ],
          },
        },
      },
    ]);
  });

  it('`["length"]` is RAW access — a property named "length", never a count', () => {
    // Bracket access reads a property called "length"; "length" is a string key (never a
    // numeric index), so it lowers to $getField.
    expect(jsmql('[$match($.items["length"] === 3)]')).toEqual([
      { $match: { $expr: { $eq: [{ $getField: { field: "length", input: "$items" } }, 3] } } },
    ]);
    // A string-literal key on the bare root is a plain field reference.
    expect(jsmql('[$match($["cart.field.length"] === 5)]')).toEqual([
      { $match: { $expr: { $eq: ["$cart.field.length", 5] } } },
    ]);
  });
});

describe("$match translation — % N === M → $mod", () => {
  it("translates `$.x % N === M` to `$mod: [N, M]`", () => {
    expect(jsmql("[$match($.x % 5 === 0)]")).toEqual([{ $match: { x: { $mod: [5, 0] } } }]);
  });

  it("translates `!==` through $not", () => {
    expect(jsmql("[$match($.x % 7 !== 3)]")).toEqual([{ $match: { x: { $not: { $mod: [7, 3] } } } }]);
  });

  it("accepts the literal on either side", () => {
    expect(jsmql("[$match(0 === $.x % 5)]")).toEqual([{ $match: { x: { $mod: [5, 0] } } }]);
  });

  it("works on dotted paths", () => {
    expect(jsmql("[$match($.user.score % 10 === 0)]")).toEqual([{ $match: { "user.score": { $mod: [10, 0] } } }]);
  });

  it("falls through to $expr for non-integer divisor or remainder", () => {
    expect(jsmql("[$match($.x % 1.5 === 0)]")).toEqual([{ $match: { $expr: { $eq: [{ $mod: ["$x", 1.5] }, 0] } } }]);
  });
});

describe("$match translation — $all folding from .has && .has", () => {
  it("folds two `.has` on the same field into `$all`", () => {
    expect(jsmql('[$match($.tags.has("a") && $.tags.has("b"))]')).toEqual([{ $match: { tags: { $all: ["a", "b"] } } }]);
  });

  it("folds three-or-more `.has`", () => {
    expect(jsmql('[$match($.tags.has("a") && $.tags.has("b") && $.tags.has("c"))]')).toEqual([
      { $match: { tags: { $all: ["a", "b", "c"] } } },
    ]);
  });

  it("does NOT fold when fields differ — each .has lands as its own clause", () => {
    expect(jsmql('[$match($.tags.has("a") && $.colors.has("red"))]')).toEqual([
      { $match: { tags: "a", colors: "red" } },
    ]);
  });

  it("does NOT fold mixed chains (.has + other predicates)", () => {
    // The user can reorder to enable the fold; the un-folded form has
    // identical semantics on array-valued fields, so this is not a pitfall.
    expect(jsmql('[$match($.tags.has("a") && $.age > 18)]')).toEqual([{ $match: { tags: "a", age: { $gt: 18 } } }]);
  });
});
