// Phase 5 of src/compiler/ — the filter target, end to end.
//
// A JSMQL predicate and the query document the compiler emits. `||` lowers PER
// BRANCH, so a leaf's query form never depends on its sibling.

import { describe, expect, it } from "vitest";
import { filter } from "../src/compiler/index.ts";

const TRUTHY = (v: unknown) => ({
  $and: [{ $ne: [{ $ifNull: [v, null] }, null] }, { $ne: [v, false] }, { $ne: [v, ""] }, { $ne: [v, 0] }],
});

describe("compiler/emit/filter — comparisons", () => {
  // Every comparison reads the field's OWN value: MongoDB would satisfy `{ a: 1 }`
  // with `a: [1, 2]`, and JavaScript's `===` never does. A path of more than one
  // segment excludes an array at each prefix too, because MongoDB traverses it.
  it("lowers a field against a constant to the query language", () => {
    expect(filter("$.a === 1")).toEqual({ a: 1 });
    expect(filter("$.a !== 1")).toEqual({ a: { $ne: 1 } });
    expect(filter("1 === $.a")).toEqual({ a: 1 });
    expect(filter("$.a > 1")).toEqual({ a: { $gt: 1 } });
    expect(filter("1 < $.a")).toEqual({ a: { $gt: 1 } });
    expect(filter("$.a.b.c > 5")).toEqual({ "a.b.c": { $gt: 5 } });
    expect(filter('$.d > new Date("2024-01-01")')).toEqual({ d: { $gt: new Date("2024-01-01") } });
    expect(String((filter("$._id === 0x507f1f77bcf86cd799439011") as { _id: unknown })._id)).toBe(
      "507f1f77bcf86cd799439011",
    );
  });

  it("keeps the null, presence and type tests as the query language spells them", () => {
    expect(filter("$.a == null")).toEqual({ a: null });
    expect(filter("$.a != null")).toEqual({ a: { $ne: null } });
    expect(filter("$.a === null")).toEqual({ a: { $type: "null" } });
    expect(filter("$.a !== null")).toEqual({ a: { $not: { $type: "null" } } });
    expect(filter("$.a === undefined")).toEqual({ a: { $exists: false } });
    // `typeof` uses MongoDB's type names: "undefined" is a MongoDB type, now deprecated
    // in BSON. Absence has its own spelling, `x === undefined`.
    expect(filter('typeof $.a === "undefined"')).toEqual({ a: { $type: "undefined" } });
    expect(filter("$.a !== undefined")).toEqual({ a: { $exists: true } });
    expect(filter('typeof $.a === "string"')).toEqual({ a: { $type: "string" } });
    expect(filter('typeof $.a === "bool"')).toEqual({ a: { $type: "bool" } });
    // A name MongoDB does not know is refused with the nearest one, never lowered
    // to a test that quietly matches nothing.
    expect(() => filter('typeof $.a === "boolean"')).toThrow(/not one\. Did you mean 'bool'\?/);
    expect(() => filter('typeof $.a === "function"')).toThrow(/MongoDB's type names/);
    expect(filter('typeof $.a !== "number"')).toEqual({ a: { $not: { $type: "number" } } });
    // The `array` spelling asks whether the value is an array, so it excludes none.
    expect(filter('typeof $.a === "array"')).toEqual({ a: { $type: "array" } });
    expect(filter('typeof $.a !== "array"')).toEqual({ a: { $not: { $type: "array" } } });
    expect(filter("$.a % 2 === 0")).toEqual({ a: { $mod: [2, 0] } });
    expect(filter("$.a % 2 !== 0")).toEqual({ a: { $not: { $mod: [2, 0] } } });
  });

  it("falls back to $expr where the query language has no form", () => {
    expect(filter("$.a > $.b")).toEqual({ $expr: { $gt: ["$a", "$b"] } });
    expect(filter("$.a + 1 === 2")).toEqual({ $expr: { $eq: [{ $add: ["$a", 1] }, 2] } });
    expect(filter("$abs($.a) === 2")).toEqual({ $expr: { $eq: [{ $abs: "$a" }, 2] } });
    expect(filter("$.a")).toEqual({ $expr: TRUTHY("$a") });
    // a constant list is the native `$in`, which the planner reads; a list that is not a constant falls back
    expect(filter("$.a in [1, 2]")).toEqual({ a: { $in: [1, 2] } });
    // `in` on a value the proof cannot place is the key test, which has no query form for a computed key
    expect(filter("$.a in $.list")).toEqual({
      $expr: {
        $in: [
          { $toString: "$a" },
          { $map: { input: { $objectToArray: { $ifNull: ["$list", {}] } }, as: "jsmqlKv", in: "$$jsmqlKv.k" } },
        ],
      },
    });
    // a literal key on a path is the field's own existence
    expect(filter('"k" in $.o')).toEqual({ "o.k": { $exists: true } });
  });

  it("tests the element itself inside $elemMatch, as one operator document", () => {
    // MEASURED: a body over the element alone is an operator document with no field name
    expect(filter('$.tags.some(t => t === "red")')).toEqual({ tags: { $elemMatch: { $eq: "red" } } });
    expect(filter("$.nums.some(n => n > 2)")).toEqual({ nums: { $elemMatch: { $gt: 2 } } });
    expect(filter("$.nums.some(n => n > 1 && n < 5)")).toEqual({ nums: { $elemMatch: { $gt: 1, $lt: 5 } } });
    expect(filter('$.tags.some(t => t.startsWith("re"))')).toEqual({ tags: { $elemMatch: { $regex: /^re/ } } });
    expect(filter('$.tags.some(t => typeof t === "string")')).toEqual({ tags: { $elemMatch: { $type: "string" } } });
    expect(filter('$.rows.some(r => "k" in r)')).toEqual({ rows: { $elemMatch: { k: { $exists: true } } } });
    // MEASURED: `$and` and `$or` over operator-only clauses are refused inside `$elemMatch`,
    // and so is the same operator twice — those bodies take the expression road
    expect(filter("$.nums.some(n => n > 1 && n > 2)")).toEqual({
      $expr: {
        $anyElementTrue: {
          $map: {
            input: { $ifNull: ["$nums", []] },
            as: "n",
            in: { $and: [{ $gt: ["$$n", 1] }, { $gt: ["$$n", 2] }] },
          },
        },
      },
    });
    expect(filter('$.tags.some(t => t === "a" || t === "b")')).toEqual({
      $expr: {
        $anyElementTrue: {
          $map: {
            input: { $ifNull: ["$tags", []] },
            as: "t",
            in: { $or: [{ $eq: ["$$t", "a"] }, { $eq: ["$$t", "b"] }] },
          },
        },
      },
    });
    // `.size()` counts the elements of an array. The query language has no operator for a
    // count, so the comparison stays under `$expr`; a missing array reads as empty.
    expect(filter("$.arr.size() > 2")).toEqual({ $expr: { $gt: [{ $size: { $ifNull: ["$arr", []] } }, 2] } });
  });
});

describe("compiler/emit/filter — && and ||", () => {
  it("merges conjuncts, colliding keys into one $and, residuals into one $expr", () => {
    expect(filter("$.a > 1 && $.b <= 2")).toEqual({ a: { $gt: 1 }, b: { $lte: 2 } });
    // Two operator documents on one field that agree wherever they overlap are ONE
    // document: the server reads every operator in it as a conjunction.
    expect(filter("$.a >= 1 && $.a <= 9")).toEqual({ a: { $gte: 1, $lte: 9 } });
    // The same operator named twice stays in the `$and`.
    expect(filter("$.a === 1 && $.a === 2 && $.b === 3")).toEqual({ $and: [{ a: 1 }, { a: 2 }], b: 3 });
    expect(filter('$.status === "active" && $.a > $.b && $.c < $.d')).toEqual({
      status: "active",
      $expr: { $and: [{ $gt: ["$a", "$b"] }, { $lt: ["$c", "$d"] }] },
    });
    expect(filter("$.x === 1 && ($.y === 2 || $.z === 3)")).toEqual({ x: 1, $or: [{ y: 2 }, { z: 3 }] });
  });

  // `!p` is the complement of p's own clause. `$expr` orders across BSON types, so
  // `{ $not: { $gt: ["$v", 1] } }` is false for `v: [0, 20]`, where JavaScript says true.
  it("complements a native clause under !, and keeps the truth road otherwise", () => {
    expect(filter("!($.a > 1)")).toEqual({ $nor: [{ a: { $gt: 1 } }] });
    expect(filter("!($.a === 1 && $.b === 2)")).toEqual({ $nor: [{ a: 1, b: 2 }] });
    // no native form inside: the truth road's own `$not` is already JavaScript's answer
    expect(filter("!$.a")).toEqual({ $expr: { $not: TRUTHY("$a") } });
    expect(filter("!($.a > $.b)")).toEqual({ $expr: { $not: { $gt: ["$a", "$b"] } } });
  });

  it("lowers || per branch — a leaf's meaning never depends on its sibling", () => {
    expect(filter("$.a === 1 || $.b === 2")).toEqual({ $or: [{ a: 1 }, { b: 2 }] });
    expect(filter('$.tags === "red" || $.qty * $.price > 100')).toEqual({
      $or: [{ tags: "red" }, { $expr: { $gt: [{ $multiply: ["$qty", "$price"] }, 100] } }],
    });
    expect(filter("$.a === 1 || $.b === 2 || $.c === 3")).toEqual({ $or: [{ a: 1 }, { b: 2 }, { c: 3 }] });
  });

  // Two clauses on one field fold to the one MongoDB reads off the index.
  it("folds a chain of .has on one field into $all", () => {
    expect(filter('$.tags.has("a") && $.tags.has("b")')).toEqual({ tags: { $all: ["a", "b"] } });
    expect(filter('$.tags.has("a") && $.other.has("b")')).toEqual({ tags: "a", other: "b" });
    // A substring test is a regex, and two regexes on one path stay two clauses.
    expect(filter('$.s.includes("a") && $.s.includes("b")')).toEqual({
      $and: [{ s: { $regex: /a/ } }, { s: { $regex: /b/ } }],
    });
  });
});

describe("compiler/emit/filter — a raw query document", () => {
  it("keeps the developer's own MQL, and refuses JavaScript the query language cannot read", () => {
    // Raw MQL passes through, keys as written (HR1) — including a name this build
    // does not list in filter position, because a newer query operator must round-trip.
    expect(filter("{ a: 1 }")).toEqual({ a: 1 });
    expect(filter("{ a: { $gt: 1 } }")).toEqual({ a: { $gt: 1 } });
    expect(filter("{ a: { $size: 2 } }")).toEqual({ a: { $size: 2 } });
    expect(filter("{ a: -1 }")).toEqual({ a: -1 });
    expect(filter("{ a: $gt(1) }")).toEqual({ a: { $gt: 1 } });
    // `$expr`'s row states that its operand is an aggregation EXPRESSION, so the
    // query-value rules do not apply inside it.
    expect(filter("{ $expr: $multiply($.a, 2) }")).toEqual({ $expr: { $multiply: ["$a", 2] } });
    // A computed expression in a value slot is neither a value nor a query operator:
    // it becomes `{ a: { $gt: ["$b", 1] } }`, which the server accepts and matches nothing.
    expect(() => filter("{ a: $.b > 1 }")).toThrow(/computed expression/);
  });
});

describe("compiler/emit/filter — the query operators' call forms", () => {
  it("writes the query clause when the field is a path and the operand a constant, else the expression form", () => {
    expect(filter("$gt($.a, 1)")).toEqual({ a: { $gt: 1 } });
    expect(filter("$in($.a, [1, 2])")).toEqual({ a: { $in: [1, 2] } });
    expect(filter('$type($.a, "string")')).toEqual({ a: { $type: "string" } });
    expect(filter("$mod($.n, [2, 0])")).toEqual({ n: { $mod: [2, 0] } });
    expect(filter("$gt($.a, $.b)")).toEqual({ $expr: { $gt: ["$a", "$b"] } });
    expect(filter("$in($.a, [1, $.b])")).toEqual({ $expr: { $in: ["$a", [1, "$b"]] } });
  });

  it("negates one raw clause with $not, and a JavaScript spelling through the expression form", () => {
    expect(filter("$not($gt($.a, 1))")).toEqual({ a: { $not: { $gt: 1 } } });
    expect(filter("$not($.a > 1)")).toEqual({ a: { $not: { $gt: 1 } } });
  });

  it("lists the predicates of $and / $or / $nor, each a filter of its own", () => {
    expect(filter("$and([{ a: 1 }, $.b < 2])")).toEqual({ $and: [{ a: 1 }, { b: { $lt: 2 } }] });
    expect(filter("$or($.a > 1, $.b < 2)")).toEqual({ $or: [{ a: { $gt: 1 } }, { b: { $lt: 2 } }] });
    expect(filter("$nor([$.a > 1])")).toEqual({ $nor: [{ a: { $gt: 1 } }] });
    expect(filter("{ $and: [{ a: $gt(1) }, $.b < 2] }")).toEqual({ $and: [{ a: { $gt: 1 } }, { b: { $lt: 2 } }] });
  });

  it("lowers the query-only field operators to their clause", () => {
    expect(filter("$exists($.a)")).toEqual({ a: { $exists: true } });
    expect(filter("$exists($.a, false)")).toEqual({ a: { $exists: false } });
    expect(filter('$regex($.s, "x", "i")')).toEqual({ s: { $regex: "x", $options: "i" } });
    expect(filter("$regex($.s, /x/i)")).toEqual({ s: { $regex: /x/i } });
    expect(filter("$nin($.a, [1])")).toEqual({ a: { $nin: [1] } });
    expect(filter('$all($.tags, ["a"])')).toEqual({ tags: { $all: ["a"] } });
    expect(filter("$elemMatch($.items, { q: $gt(1) })")).toEqual({ items: { $elemMatch: { q: { $gt: 1 } } } });
    expect(filter("$elemMatch($.items, x => x.q > 1)")).toEqual({ items: { $elemMatch: { q: { $gt: 1 } } } });
    expect(filter("$bitsAllSet($.a, 5)")).toEqual({ a: { $bitsAllSet: 5 } });
    expect(filter("$geoWithin($.loc, $box([[0, 0], [1, 1]]))")).toEqual({
      loc: {
        $geoWithin: {
          $box: [
            [0, 0],
            [1, 1],
          ],
        },
      },
    });
    expect(filter('$near($.loc, { $geometry: { type: "Point", coordinates: [0, 0] }, $maxDistance: 10 })')).toEqual({
      loc: { $near: { $geometry: { type: "Point", coordinates: [0, 0] }, $maxDistance: 10 } },
    });
  });

  it("lowers the top-level query operators", () => {
    expect(filter("$expr($.a > $.b)")).toEqual({ $expr: { $gt: ["$a", "$b"] } });
    expect(filter('$text("foo")')).toEqual({ $text: { $search: "foo" } });
    expect(filter('$text({ $search: "foo", $language: "en" })')).toEqual({
      $text: { $search: "foo", $language: "en" },
    });
    expect(filter('$comment("c")')).toEqual({ $comment: "c" });
    expect(filter('$jsonSchema({ required: ["a"] })')).toEqual({ $jsonSchema: { required: ["a"] } });
    // `$where` runs JavaScript on the server: the call form is refused with the JSMQL predicate; a raw document passes (HR1)
    expect(() => filter('$where("this.n > 3")')).toThrow(/runs JavaScript on the server/);
    expect(filter('{ $where: "this.n > 3" }')).toEqual({ $where: "this.n > 3" });
  });

  it("refuses a non-field first argument, a run-time operand, and an element predicate with no query form", () => {
    expect(() => filter("$exists(1)")).toThrow(/tests a field: its first argument is a field path/);
    expect(() => filter("$all($.tags, $.other)")).toThrow(/must be a compile-time constant/);
    expect(() => filter("$elemMatch($.items, x => x.q > $.min)")).toThrow(/query test of the element alone/);
    expect(() => filter("$box([[0, 0], [1, 1]])")).toThrow(/\$geoWithin/);
  });
});

describe("compiler/emit/filter — methods and operators", () => {
  it("lowers the boolean methods to their indexable forms", () => {
    // A query document is read through an INDEX. `.has` is membership in an array:
    // MongoDB's own "equals, or is an array containing", and `$in` for a constant list.
    // `.includes` is the substring test of a string, and the query spelling for it is an
    // escaped `$regex`.
    expect(filter('$.tags.has("x")')).toEqual({ tags: "x" });
    expect(filter('["a", "b"].has($.s)')).toEqual({ s: { $in: ["a", "b"] } });
    expect(filter('$.s.includes("x")')).toEqual({ s: { $regex: /x/ } });
    expect(filter('$.s.includes("a.b")')).toEqual({ s: { $regex: /a\.b/ } });
    expect(filter('$.s.startsWith("A")')).toEqual({ s: { $regex: /^A/ } });
    // `\z` is the end of the SUBJECT. PCRE's `$` also matches before a final newline,
    // so it accepted "z.\n" where JavaScript's endsWith does not.
    expect(filter('$.s.endsWith("z.")')).toEqual({ s: { $regex: /z\.\z/ } });
    expect(filter("$.s.match(/^a/i)")).toEqual({ s: { $regex: /^a/i } });
    // The operator form, not the shorter `{ s: /^a/i }`. MEASURED, the two select the
    // same documents at every query site, and the operator form is the one that
    // survives where they differ — both of which jsmql emits into: a sibling on the
    // same field, and `$elemMatch`, which needs an object.
    expect(filter('$.s.match(/^a/i) && $.s !== "zzz"')).toEqual({ s: { $regex: /^a/i, $ne: "zzz" } });
    expect(filter("$.items.some(i => i.s.match(/^a/))")).toEqual({ items: { $elemMatch: { s: { $regex: /^a/ } } } });
    // `.some` IS the element test, so `$elemMatch` is its own reading; the element's
    // own fields take the rule again.
    expect(filter("$.items.some(i => i.q > 2)")).toEqual({ items: { $elemMatch: { q: { $gt: 2 } } } });
    expect(filter("$.items.some(i => i.q > 2 && i.name === 'x')")).toEqual({
      items: { $elemMatch: { q: { $gt: 2 }, name: "x" } },
    });
  });

  it("lowers .inRange() on a field against constant bounds to an indexable range on that field", () => {
    expect(filter("$.age.inRange(18, 65)")).toEqual({ age: { $gte: 18, $lt: 65 } });
    // the bounds order at COMPILE time, so the swapped spelling is the same clause
    expect(filter("$.age.inRange(65, 18)")).toEqual({ age: { $gte: 18, $lt: 65 } });
    expect(filter("$.n.inRange(10)")).toEqual({ n: { $gte: 0, $lt: 10 } });
    expect(filter("$.a.b.inRange(1, 2)")).toEqual({ "a.b": { $gte: 1, $lt: 2 } });
    // a date field takes the same clause
    expect(filter('$.t.inRange(new Date("2024-01-01"), new Date("2025-01-01"))')).toEqual({
      t: { $gte: new Date("2024-01-01T00:00:00.000Z"), $lt: new Date("2025-01-01T00:00:00.000Z") },
    });
    // a bound read at run time cannot order here, and keeps the $min/$max expression
    expect(filter("$.n.inRange($.lo, $.hi)")).toHaveProperty("$expr");
    // a number against a date does not compare, so the pair keeps the expression form too
    expect(filter('$.t.inRange(new Date("2024-01-01"))')).toHaveProperty("$expr");
  });

  it("keeps the expression form where the receiver or the argument is not a path and a constant", () => {
    // The query cell answers null, and the fallback asks the VALUE lowering, which
    // arrives under `$expr`.
    // A receiver PROVEN to be no string is refused before either: `$abs` returns a number.
    expect(() => filter('$abs($.n).startsWith("A")')).toThrow(/not available on a 'number'/);
    expect(filter("$.items.every(i => i.q > 2)")).toHaveProperty("$expr");
    expect(filter("$.items.some(i => i.q > $.min)")).toHaveProperty("$expr");
    // inside $elemMatch the OUTER document has no path: `$.flag` must not become the element's `flag`
    expect(filter("$.items.some(i => i.q > 2 && $.flag === true)")).toHaveProperty("$expr");
    // and an OUTER element's fields are not the inner element's
    expect(filter("$.a.some(i => i.b.some(j => i.c === 1))")).toHaveProperty("$expr");
    expect(filter("$.a.some(i => i.b.some(j => j.c === 1))")).toEqual({
      a: { $elemMatch: { b: { $elemMatch: { c: 1 } } } },
    });
    // a field against a field has no query form: the value cell's shape under `$expr`
    expect(filter("$.s.startsWith($.prefix)")).toEqual({
      $expr: {
        $cond: {
          if: { $eq: [{ $ifNull: ["$s", null] }, null] },
          then: null,
          else: { $eq: [{ $indexOfCP: ["$s", "$prefix"] }, 0] },
        },
      },
    });
  });

  it("lowers a query-only operator to its query form and refuses a non-constant", () => {
    expect(filter("$.a === 1 && $sampleRate(0.5)")).toEqual({ a: 1, $sampleRate: 0.5 });
    expect(() => filter("$sampleRate($.r)")).toThrow(/must be a compile-time constant/);
    expect(() => filter("$sampleRate(2)")).toThrow(/from 0 to 1/);
    expect(() => filter('$sampleRate("0.5")')).toThrow(/expects a number/);
    expect(() => filter("$.items.some(i => $sampleRate(0.5))")).toThrow(/top-level document only/);
    expect(() => filter("$.a % 0 === 1")).toThrow(/divide by zero/);
    expect(() => filter("$divide($.a, 0) > 1")).toThrow(/divide by zero/);
    expect(filter("$log10($.a) > 1")).toEqual({ $expr: { $gt: [{ $log10: "$a" }, 1] } });
  });

  it("passes a raw query document through, values lowered", () => {
    expect(filter('{ status: "active", $expr: $.score > $.threshold }')).toEqual({
      status: "active",
      $expr: { $gt: ["$score", "$threshold"] },
    });
    expect(filter("{ a: { $gt: 1 }, tags: { $all: ['x'] } }")).toEqual({ a: { $gt: 1 }, tags: { $all: ["x"] } });
    // a one-operand $op inside a raw document is the query operator, at any depth
    expect(filter("{ a: $not($gt(1)) }")).toEqual({ a: { $not: { $gt: 1 } } });
    expect(filter("{ a: $size(2) }")).toEqual({ a: { $size: 2 } });
    expect(() => filter("({ $setUnion: $.x })")).toThrow(/operates on a list of operands/);
  });

  it("drops a branch the fold settled, and keeps the rest as written", () => {
    expect(filter("$.a === 1 || false")).toEqual({ a: 1 });
    expect(filter("$.a === 1 && true")).toEqual({ a: 1 });
    expect(filter("$.a === 1 || true")).toEqual({});
    expect(filter("$.a === 1 && false")).toEqual({ $expr: false });
    expect(filter("1 === 1")).toEqual({ $expr: true });
    expect(filter("$.a > -1")).toEqual({ a: { $gt: -1 } });
  });
});

describe("compiler/emit/filter — a read inside a raw query value has no query form", () => {
  // The query language compares a field with a CONSTANT, so `$.b` in a query slot is
  // the two-character string "$b" and the filter matches nothing. The question is
  // asked at every depth: an array, a document, a nesting of both.
  it("lifts the whole comparison when a read sits anywhere inside the value", () => {
    expect(filter("{ a: $.b }")).toEqual({ $expr: { $eq: ["$a", "$b"] } });
    expect(filter("{ a: [1, $.b] }")).toEqual({ $expr: { $eq: ["$a", [1, "$b"]] } });
    expect(filter("{ a: [[1, $.b]] }")).toEqual({ $expr: { $eq: ["$a", [[1, "$b"]]] } });
    expect(filter("{ a: [{ x: $.b }] }")).toEqual({ $expr: { $eq: ["$a", [{ x: "$b" }]] } });
    expect(filter("{ a: { x: { y: $.b } } }")).toEqual({ $expr: { $eq: ["$a", { x: { y: "$b" } }] } });
  });

  it("an operator with a runtime operand takes its expression twin, in either spelling", () => {
    expect(filter("{ a: { $gte: $.since } }")).toEqual({ $expr: { $gte: ["$a", "$since"] } });
    expect(filter("{ a: $gte($.since) }")).toEqual({ $expr: { $gte: ["$a", "$since"] } });
    expect(filter("{ a: { $in: [$.b] } }")).toEqual({ $expr: { $in: ["$a", ["$b"]] } });
  });

  it("`$nin` lifts to `$in` negated — the expression language has no `$nin`", () => {
    expect(filter("{ a: { $nin: [$.b] } }")).toEqual({ $expr: { $not: [{ $in: ["$a", ["$b"]] }] } });
  });

  it("the operators with a constant operand stay native beside the lifted one", () => {
    expect(filter("{ a: { $gte: $.s, $lt: 9 } }")).toEqual({ a: { $lt: 9 }, $expr: { $gte: ["$a", "$s"] } });
  });

  it("each branch of `$and` / `$or` / `$nor` lifts on its own", () => {
    expect(filter("{ $and: [{ a: [1, $.b] }] }")).toEqual({ $and: [{ $expr: { $eq: ["$a", [1, "$b"]] } }] });
    expect(filter("{ $nor: [{ a: [1, $.b] }] }")).toEqual({ $nor: [{ $expr: { $eq: ["$a", [1, "$b"]] } }] });
  });

  it("an operator with no expression twin is refused, and names the rewrite", () => {
    expect(() => filter("{ a: { $all: [$.b] } }")).toThrow(/compares against a constant in a query document/);
    expect(() => filter("{ a: { $elemMatch: { x: $.b } } }")).toThrow(
      /compares against a constant in a query document/,
    );
  });

  it("raw MQL with no read passes through, byte for byte", () => {
    for (const src of [
      "{ a: 1 }",
      "{ a: [1, 2] }",
      "{ a: { $gt: 1 } }",
      "{ a: { $size: 2 } }",
      "{ a: { $exists: true } }",
      "{ a: { $type: 'string' } }",
      "{ a: { $mod: [4, 0] } }",
      "{ a: { $not: 1 } }",
      "{ a: { $all: [1, 2] } }",
      "{ a: { $elemMatch: { x: 2 } } }",
      "{ a: $gt(1) }",
      '{ x: $gt("$y") }',
    ]) {
      expect(() => filter(src)).not.toThrow();
      expect(JSON.stringify(filter(src))).not.toContain("$expr");
    }
  });
});
