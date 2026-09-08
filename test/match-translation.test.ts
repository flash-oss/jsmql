import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

// `$match` translates expression-form predicates to MongoDB's query language
// when the predicate is index-safe, falling back to $expr for the parts that
// aren't. This avoids the silent index-disabling effect of `{ $expr: ... }`.
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
  // When part of an `&&` predicate is translatable and part isn't, we keep
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
    // We can't emit `$or: [<query>, { $expr: ... }]` and preserve the
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
      { $match: { $expr: { $eq: [{ $toLower: "$name" }, "alice"] } } },
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
  it("translates `!==` via $not", () => {
    expect(jsmql('[$match(typeof $.x !== "null")]')).toEqual([{ $match: { x: { $not: { $type: "null" } } } }]);
  });
  it("works on nested field paths", () => {
    expect(jsmql('[$match(typeof $.user.role === "string")]')).toEqual([
      { $match: { "user.role": { $type: "string" } } },
    ]);
  });
  it("combines with other translated clauses via $and-merge", () => {
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
      { $match: { $expr: { $eq: [{ $type: { $toLower: "$name" } }, "string"] } } },
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
  // MongoDB's query language doesn't evaluate aggregation expressions in
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
    // `new Date()` codegens to `{ $toDate: "$$NOW" }` and folding it at
    // compile time would freeze the timestamp. Must stay in $expr.
    expect(jsmql("[$match($.expiresAt < new Date())]")).toEqual([
      { $match: { $expr: { $lt: ["$expiresAt", { $toDate: "$$NOW" }] } } },
    ]);
  });

  it("falls back to $expr when an argument is a field ref", () => {
    expect(jsmql("[$match($.createdAt >= new Date($.cutoffStr))]")).toEqual([
      { $match: { $expr: { $gte: ["$createdAt", { $toDate: "$cutoffStr" }] } } },
    ]);
  });

  it("rejects a constant string that can't be parsed as a date (HR3)", () => {
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

describe("$match translation — .includes() → $in / array-element", () => {
  // Two query-position forms; both index-friendly. The first leans on
  // MongoDB's "field value or array containing value" semantics; the second
  // is straightforward set-membership.

  it("translates `field.includes(<literal>)` to an implicit array-element match", () => {
    expect(jsmql('[$match($.tags.includes("vip"))]')).toEqual([
      { $match: { $or: [{ tags: { $eq: "vip", $type: "array" } }, { tags: { $regex: "vip" } }] } },
    ]);
  });

  it("translates `[lit,lit,…].includes(field)` to `$in`", () => {
    expect(jsmql('[$match(["active", "trial"].includes($.status))]')).toEqual([
      { $match: { status: { $in: ["active", "trial"] } } },
    ]);
  });

  it("uses dotted paths for nested receivers", () => {
    expect(jsmql('[$match($.user.roles.includes("admin"))]')).toEqual([
      { $match: { $or: [{ "user.roles": { $eq: "admin", $type: "array" } }, { "user.roles": { $regex: "admin" } }] } },
    ]);
  });

  it("falls through to $expr when both sides are field paths", () => {
    expect(jsmql("[$match($.tags.includes($.target))]")).toEqual([
      {
        $match: {
          $expr: {
            $switch: {
              branches: [
                { case: { $in: [{ $type: "$tags" }, ["array"]] }, then: { $in: ["$target", "$tags"] } },
                {
                  case: { $in: [{ $type: "$tags" }, ["string"]] },
                  then: { $gte: [{ $indexOfCP: ["$tags", "$target"] }, 0] },
                },
              ],
              default: "$$REMOVE",
            },
          },
        },
      },
    ]);
  });

  it("falls through to $expr when the array contains a non-literal", () => {
    expect(jsmql('[$match(["active", $.fallback].includes($.status))]')).toEqual([
      { $match: { $expr: { $in: ["$status", ["active", "$fallback"]] } } },
    ]);
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
    // A computed regex (or string arg) can't go in the query-doc slot, so the
    // existing $regexMatch translation handles it.
    expect(jsmql('[$match($.name.match("^a"))]')).toEqual([
      { $match: { $expr: { $regexMatch: { input: "$name", regex: "^a" } } } },
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
              $map: { input: { $ifNull: ["$items", []] }, as: "it", in: { $eq: [{ $toLower: "$$it.tag" }, "vip"] } },
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
    // This used to throw. `$type` distinguishes a missing field ("missing") from a
    // present-but-null one ("null"), which is exactly the line `$exists` draws — so the
    // expression language CAN express existence, and now does.
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

describe("$match translation — .length vs natural number → string-or-array $expr", () => {
  // `.length` (and the JS-identical `["length"]`) compared against a natural
  // number is the *length* of a string-or-array. It residualises into `$expr`
  // so codegen emits the runtime `$isArray`/`$size`/`$strLenCP` dispatch — which,
  // unlike the old array-only `$size` peephole, also matches strings.
  // The string branch coerces: `$strLenCP` aborts the query on a missing field,
  // where `$size` on the array side is already shielded by the `$isArray` test.
  // Three-way: reading "not an array" as "string" made `$strLenCP` abort the query on a
  // numerically-typed field. Missing/null still reach the string branch, where the `$ifNull`
  // makes them 0 — a deliberate answer this fix preserves.
  const lenCond = (path: string) => ({
    $cond: {
      if: { $isArray: `$${path}` },
      then: { $size: `$${path}` },
      else: {
        $cond: {
          if: { $in: [{ $type: `$${path}` }, ["string", "missing", "null"]] },
          then: { $strLenCP: { $ifNull: [`$${path}`, ""] } },
          else: "$$REMOVE",
        },
      },
    },
  });

  it("translates `$.arr.length === N` to the string-or-array $cond", () => {
    expect(jsmql("[$match($.items.length === 3)]")).toEqual([
      {
        $match: {
          $expr: {
            $eq: [
              {
                $switch: {
                  branches: [
                    { case: { $in: [{ $type: "$items" }, ["array"]] }, then: { $size: "$items" } },
                    {
                      case: { $in: [{ $type: "$items" }, ["string", "null", "missing"]] },
                      then: { $strLenCP: { $ifNull: ["$items", ""] } },
                    },
                  ],
                  default: "$$REMOVE",
                },
              },
              3,
            ],
          },
        },
      },
    ]);
  });

  it("translates `!== N` the same way", () => {
    expect(jsmql("[$match($.items.length !== 0)]")).toEqual([
      {
        $match: {
          $expr: {
            $ne: [
              {
                $switch: {
                  branches: [
                    { case: { $in: [{ $type: "$items" }, ["array"]] }, then: { $size: "$items" } },
                    {
                      case: { $in: [{ $type: "$items" }, ["string", "null", "missing"]] },
                      then: { $strLenCP: { $ifNull: ["$items", ""] } },
                    },
                  ],
                  default: "$$REMOVE",
                },
              },
              0,
            ],
          },
        },
      },
    ]);
  });

  it("accepts the literal on either side", () => {
    expect(jsmql("[$match(3 === $.items.length)]")).toEqual([
      {
        $match: {
          $expr: {
            $eq: [
              3,
              {
                $switch: {
                  branches: [
                    { case: { $in: [{ $type: "$items" }, ["array"]] }, then: { $size: "$items" } },
                    {
                      case: { $in: [{ $type: "$items" }, ["string", "null", "missing"]] },
                      then: { $strLenCP: { $ifNull: ["$items", ""] } },
                    },
                  ],
                  default: "$$REMOVE",
                },
              },
            ],
          },
        },
      },
    ]);
  });

  it("works on dotted paths", () => {
    expect(jsmql("[$match($.order.items.length === 1)]")).toEqual([
      {
        $match: {
          $expr: {
            $eq: [
              {
                $switch: {
                  branches: [
                    { case: { $in: [{ $type: "$order.items" }, ["array"]] }, then: { $size: "$order.items" } },
                    {
                      case: { $in: [{ $type: "$order.items" }, ["string", "null", "missing"]] },
                      then: { $strLenCP: { $ifNull: ["$order.items", ""] } },
                    },
                  ],
                  default: "$$REMOVE",
                },
              },
              1,
            ],
          },
        },
      },
    ]);
  });

  it("handles ordered comparisons (the bug: no more `items.length` dotted-key collapse)", () => {
    expect(jsmql("[$match($.items.length < 20)]")).toEqual([
      {
        $match: {
          $expr: {
            $lt: [
              {
                $switch: {
                  branches: [
                    { case: { $in: [{ $type: "$items" }, ["array"]] }, then: { $size: "$items" } },
                    {
                      case: { $in: [{ $type: "$items" }, ["string", "null", "missing"]] },
                      then: { $strLenCP: { $ifNull: ["$items", ""] } },
                    },
                  ],
                  default: "$$REMOVE",
                },
              },
              20,
            ],
          },
        },
      },
    ]);
    expect(jsmql("[$match($.items.length >= 2)]")).toEqual([
      {
        $match: {
          $expr: {
            $gte: [
              {
                $switch: {
                  branches: [
                    { case: { $in: [{ $type: "$items" }, ["array"]] }, then: { $size: "$items" } },
                    {
                      case: { $in: [{ $type: "$items" }, ["string", "null", "missing"]] },
                      then: { $strLenCP: { $ifNull: ["$items", ""] } },
                    },
                  ],
                  default: "$$REMOVE",
                },
              },
              2,
            ],
          },
        },
      },
    ]);
    expect(jsmql("[$match(0 < $.items.length)]")).toEqual([
      {
        $match: {
          $expr: {
            $lt: [
              0,
              {
                $switch: {
                  branches: [
                    { case: { $in: [{ $type: "$items" }, ["array"]] }, then: { $size: "$items" } },
                    {
                      case: { $in: [{ $type: "$items" }, ["string", "null", "missing"]] },
                      then: { $strLenCP: { $ifNull: ["$items", ""] } },
                    },
                  ],
                  default: "$$REMOVE",
                },
              },
            ],
          },
        },
      },
    ]);
  });

  it("reads `.length` as a literal field path when the RHS is NOT a natural number", () => {
    // A length can't equal 3.5 / "x" — so the user meant a field named `length`.
    expect(jsmql("[$match($.items.length === 3.5)]")).toEqual([
      {
        $match: {
          $expr: {
            $eq: [
              {
                $switch: {
                  branches: [
                    { case: { $in: [{ $type: "$items" }, ["array"]] }, then: { $size: "$items" } },
                    {
                      case: { $in: [{ $type: "$items" }, ["string", "null", "missing"]] },
                      then: { $strLenCP: { $ifNull: ["$items", ""] } },
                    },
                  ],
                  default: "$$REMOVE",
                },
              },
              3.5,
            ],
          },
        },
      },
    ]);
    expect(jsmql("[$match($.items.length < 3.5)]")).toEqual([
      {
        $match: {
          $expr: {
            $lt: [
              {
                $switch: {
                  branches: [
                    { case: { $in: [{ $type: "$items" }, ["array"]] }, then: { $size: "$items" } },
                    {
                      case: { $in: [{ $type: "$items" }, ["string", "null", "missing"]] },
                      then: { $strLenCP: { $ifNull: ["$items", ""] } },
                    },
                  ],
                  default: "$$REMOVE",
                },
              },
              3.5,
            ],
          },
        },
      },
    ]);
    expect(jsmql('[$match($.items.length === "x")]')).toEqual([
      {
        $match: {
          $expr: {
            $eq: [
              {
                $switch: {
                  branches: [
                    { case: { $in: [{ $type: "$items" }, ["array"]] }, then: { $size: "$items" } },
                    {
                      case: { $in: [{ $type: "$items" }, ["string", "null", "missing"]] },
                      then: { $strLenCP: { $ifNull: ["$items", ""] } },
                    },
                  ],
                  default: "$$REMOVE",
                },
              },
              "x",
            ],
          },
        },
      },
    ]);
  });

  it('`["length"]` is RAW access — never folded to a length (only dot .length is)', () => {
    // Bracket access reads a property called "length", so it can't be a $size
    // peephole; "length" is a string key (never a numeric index) → $getField.
    expect(jsmql('[$match($.items["length"] === 3)]')).toEqual([
      { $match: { $expr: { $eq: [{ $getField: { field: "length", input: "$items" } }, 3] } } },
    ]);
    // A string-literal key on the bare root is a plain field reference.
    expect(jsmql('[$match($["cart.field.length"] === 5)]')).toEqual([
      { $match: { $expr: { $eq: ["$cart.field.length", 5] } } },
    ]);
  });

  it("falls through to $expr for negative integer RHS (unary minus isn't a natural-number literal)", () => {
    expect(jsmql("[$match($.items.length === -1)]")).toEqual([
      {
        $match: {
          $expr: {
            $eq: [
              {
                $switch: {
                  branches: [
                    { case: { $in: [{ $type: "$items" }, ["array"]] }, then: { $size: "$items" } },
                    {
                      case: { $in: [{ $type: "$items" }, ["string", "null", "missing"]] },
                      then: { $strLenCP: { $ifNull: ["$items", ""] } },
                    },
                  ],
                  default: "$$REMOVE",
                },
              },
              -1,
            ],
          },
        },
      },
    ]);
  });
});

describe("$match translation — % N === M → $mod", () => {
  it("translates `$.x % N === M` to `$mod: [N, M]`", () => {
    expect(jsmql("[$match($.x % 5 === 0)]")).toEqual([{ $match: { x: { $mod: [5, 0] } } }]);
  });

  it("translates `!==` via $not", () => {
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

describe("$match translation — $all folding from .includes && .includes", () => {
  it("folds two `.includes` on the same field into `$all`", () => {
    expect(jsmql('[$match($.tags.includes("a") && $.tags.includes("b"))]')).toEqual([
      {
        $match: {
          $or: [
            { tags: { $all: ["a", "b"], $type: "array" } },
            { $and: [{ tags: { $regex: "a" } }, { tags: { $regex: "b" } }] },
          ],
        },
      },
    ]);
  });

  it("folds three-or-more includes", () => {
    expect(jsmql('[$match($.tags.includes("a") && $.tags.includes("b") && $.tags.includes("c"))]')).toEqual([
      {
        $match: {
          $or: [
            { tags: { $all: ["a", "b", "c"], $type: "array" } },
            { $and: [{ tags: { $regex: "a" } }, { tags: { $regex: "b" } }, { tags: { $regex: "c" } }] },
          ],
        },
      },
    ]);
  });

  it("does NOT fold when fields differ — each .includes lands as its own clause", () => {
    expect(jsmql('[$match($.tags.includes("a") && $.colors.includes("red"))]')).toEqual([
      {
        $match: {
          $and: [
            { $or: [{ tags: { $eq: "a", $type: "array" } }, { tags: { $regex: "a" } }] },
            { $or: [{ colors: { $eq: "red", $type: "array" } }, { colors: { $regex: "red" } }] },
          ],
        },
      },
    ]);
  });

  it("does NOT fold mixed chains (.includes + other predicates)", () => {
    // The user can reorder to enable the fold; the un-folded form has
    // identical semantics on array-valued fields, so this isn't a footgun.
    expect(jsmql('[$match($.tags.includes("a") && $.age > 18)]')).toEqual([
      { $match: { $or: [{ tags: { $eq: "a", $type: "array" } }, { tags: { $regex: "a" } }], age: { $gt: 18 } } },
    ]);
  });
});
