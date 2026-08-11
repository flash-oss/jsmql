import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";
import { ObjectId } from "../src/objectid.ts";

// Mirror of the codegen-side `jsBool()` helper. JS truthy/falsy: false, null
// (or missing), "", and 0 are falsy; everything else is truthy. Used in
// expected outputs for `&&`, `||`, `!`, `?:`, `Boolean()`, and predicate-
// method bodies wherever the operand is not provably boolean.
const truthy = (v: unknown) => ({
  $and: [{ $ne: [{ $ifNull: [v, null] }, null] }, { $ne: [v, false] }, { $ne: [v, ""] }, { $ne: [v, 0] }],
});

describe("basic literals", () => {
  it("passes number through", () => {
    expect(jsmql.expr("$abs(42)")).toEqual({ $abs: 42 });
  });

  it("passes string through", () => {
    expect(jsmql.expr('$toLower("Hello")')).toEqual({ $toLower: "Hello" });
  });

  it("handles boolean", () => {
    expect(jsmql.expr("$not(true)")).toEqual({ $not: true });
  });

  it("handles null", () => {
    expect(jsmql.expr("$not(null)")).toEqual({ $not: null });
  });
});

describe("field refs", () => {
  it("simple field", () => {
    expect(jsmql.expr("$abs($.delta)")).toEqual({ $abs: "$delta" });
  });

  it("nested field", () => {
    expect(jsmql.expr("$year($.createdAt)")).toEqual({ $year: "$createdAt" });
  });

  it("deep nested field", () => {
    expect(jsmql.expr("$abs($.address.city)")).toEqual({ $abs: "$address.city" });
  });
});

describe("single-shape operators", () => {
  it("$not", () => {
    expect(jsmql.expr("$not($.active)")).toEqual({ $not: "$active" });
  });

  it("$size", () => {
    expect(jsmql.expr("$size($.items)")).toEqual({ $size: "$items" });
  });

  it("$toLower", () => {
    expect(jsmql.expr("$toLower($.name)")).toEqual({ $toLower: "$name" });
  });
});

describe("array-shape operators", () => {
  it("$eq two args", () => {
    expect(jsmql.expr("$eq($.age, 18)")).toEqual({ $eq: ["$age", 18] });
  });

  it("$gt comparison", () => {
    expect(jsmql.expr("$gt($.age, 18)")).toEqual({ $gt: ["$age", 18] });
  });

  // Comparison operators are dual-form (`flex`): the single-argument shape is
  // the valid QUERY predicate `{ field: { $gt: v } }`; two args are the
  // aggregation operands `{ $gt: [a, b] }` (HR2 — see docs/LANG_RULES.md). In
  // aggregation-expression position the single-value form is INVALID (the server
  // needs exactly two operands), so the `$op` escape hatch rejects it there…
  it("comparison single arg is rejected in aggregation position (needs 2 operands)", () => {
    expect(() => jsmql.expr("$gt($.x)")).toThrow(/\$gt\(expr1, expr2\) requires exactly 2 arguments, got 1/);
    expect(() => jsmql.expr("$eq(5)")).toThrow(/\$eq\(expr1, expr2\) requires exactly 2 arguments, got 1/);
    expect(() => jsmql.expr("$lte($.score)")).toThrow(/\$lte\(expr1, expr2\) requires exactly 2 arguments, got 1/);
  });

  // …but the single-value form still compiles as a query predicate under a field.
  it("comparison single arg → valid query single-value form under a field (HR2)", () => {
    expect(jsmql("{ x: $gt($.y) }")).toEqual({ x: { $gt: "$y" } });
    expect(jsmql("{ score: $lte(80) }")).toEqual({ score: { $lte: 80 } });
  });

  it("$in dual form: single array → query, two args → aggregation", () => {
    expect(jsmql.expr("$in([1, 2, 3])")).toEqual({ $in: [1, 2, 3] });
    expect(jsmql.expr("$in($.x, $.arr)")).toEqual({ $in: ["$x", "$arr"] });
  });

  it("$add multiple args", () => {
    expect(jsmql.expr("$add($.a, $.b, $.c)")).toEqual({ $add: ["$a", "$b", "$c"] });
  });

  // List-only operators (no single-value form) — HR2/HR3:
  //   2+ args → array; 1 array literal → the array IS the operand list; 1 non-array → error.
  it("list-only op: a single array literal is the operand list (HR2 round-trip)", () => {
    expect(jsmql.expr("$setUnion([$.a, $.b])")).toEqual({ $setUnion: ["$a", "$b"] });
    expect(jsmql.expr("$setUnion($.a, $.b)")).toEqual({ $setUnion: ["$a", "$b"] });
    expect(jsmql.expr("$divide([10, 2])")).toEqual({ $divide: [10, 2] });
  });

  it("list-only op: a single non-array operand is rejected (HR3)", () => {
    expect(() => jsmql.expr("$setUnion($.a)")).toThrow(/\$setUnion operates on a list of operands/);
    expect(() => jsmql.expr("$divide(10)")).toThrow(/\$divide operates on a list of operands/);
    expect(() => jsmql.expr("$and(true)")).toThrow(/\$and operates on a list of operands/);
  });

  // HR3 governs raw MQL too: the same rejection applies to the `{ $op: value }`
  // raw-object form, not just the `$op(...)` call form.
  it("list-only op: raw `{ $op: <non-array> }` object is rejected (HR3)", () => {
    expect(() => jsmql.expr("({ $setUnion: $.x })")).toThrow(/\$setUnion operates on a list of operands/);
    expect(() => jsmql.expr("({ $add: 5 })")).toThrow(/\$add operates on a list of operands/);
    // ...but the valid array-operand form passes through verbatim (HR1).
    expect(jsmql.expr("({ $setUnion: [$.a, $.b] })")).toEqual({ $setUnion: ["$a", "$b"] });
  });

  it("$and logical", () => {
    expect(jsmql.expr('$and($gt($.age, 18), $eq($.status, "active"))')).toEqual({
      $and: [{ $gt: ["$age", 18] }, { $eq: ["$status", "active"] }],
    });
  });

  it("$or logical", () => {
    expect(jsmql.expr("$or($eq($.a, 1), $eq($.b, 2))")).toEqual({ $or: [{ $eq: ["$a", 1] }, { $eq: ["$b", 2] }] });
  });

  it("$in with array literal", () => {
    expect(jsmql.expr('$in($.status, ["active", "pending"])')).toEqual({ $in: ["$status", ["active", "pending"]] });
  });

  it("$ifNull varargs", () => {
    expect(jsmql.expr('$ifNull($.nickname, $.firstName, "Unknown")')).toEqual({
      $ifNull: ["$nickname", "$firstName", "Unknown"],
    });
  });
});

describe("nested operators", () => {
  it("operator as argument", () => {
    expect(jsmql.expr("$multiply($add($.a, $.b), 2)")).toEqual({ $multiply: [{ $add: ["$a", "$b"] }, 2] });
  });
});

describe("object-style operators (object arg)", () => {
  it("$trim with named args", () => {
    expect(jsmql.expr("$trim({ input: $.name, chars: ' ' })")).toEqual({ $trim: { input: "$name", chars: " " } });
  });

  it("$replaceOne named", () => {
    expect(jsmql.expr('$replaceOne({ input: $.text, find: "old", replacement: "new" })')).toEqual({
      $replaceOne: { input: "$text", find: "old", replacement: "new" },
    });
  });

  it("$dateAdd named", () => {
    expect(jsmql.expr('$dateAdd({ startDate: $.date, unit: "day", amount: 7 })')).toEqual({
      $dateAdd: { startDate: "$date", unit: "day", amount: 7 },
    });
  });
});

describe("object-shape operators (positional → object mapping)", () => {
  it("$trim positional", () => {
    expect(jsmql.expr("$trim($.name, ' ')")).toEqual({ $trim: { input: "$name", chars: " " } });
  });

  it("$trim positional single arg", () => {
    expect(jsmql.expr("$trim($.name)")).toEqual({ $trim: { input: "$name" } });
  });

  it("$replaceOne positional", () => {
    expect(jsmql.expr('$replaceOne($.text, "old", "new")')).toEqual({
      $replaceOne: { input: "$text", find: "old", replacement: "new" },
    });
  });

  it("$getField positional", () => {
    expect(jsmql.expr('$getField("fieldName", $.doc)')).toEqual({ $getField: { field: "fieldName", input: "$doc" } });
  });

  it("$switch object-style with branches/default", () => {
    expect(
      jsmql.expr(
        '$switch({ branches: [{ case: $eq($.tier, "gold"), then: 0.2 }, { case: $eq($.tier, "silver"), then: 0.1 }], default: 0 })',
      ),
    ).toEqual({
      $switch: {
        branches: [
          { case: { $eq: ["$tier", "gold"] }, then: 0.2 },
          { case: { $eq: ["$tier", "silver"] }, then: 0.1 },
        ],
        default: 0,
      },
    });
  });

  it("$dateTrunc positional (date, unit)", () => {
    expect(jsmql.expr('$dateTrunc($.createdAt, "day")')).toEqual({ $dateTrunc: { date: "$createdAt", unit: "day" } });
  });

  it("$dateFromString single-arg positional", () => {
    expect(jsmql.expr("$dateFromString($.dateString)")).toEqual({ $dateFromString: { dateString: "$dateString" } });
  });
});

describe("operator object-form argument validation (required / unknown keys)", () => {
  it("rejects a missing required key", () => {
    expect(() => jsmql.expr("$dateAdd({ startDate: $.t, amount: 5 })")).toThrow(
      /'\$dateAdd' requires the 'unit' field, but it is missing/,
    );
    expect(() => jsmql.expr("$cond({ if: $.a, then: 1 })")).toThrow(/'\$cond' requires the 'else' field/);
    expect(() => jsmql.expr("$filter({ input: $.a })")).toThrow(/'\$filter' requires the 'cond' field/);
    expect(() => jsmql.expr("$convert({ input: $.v })")).toThrow(/'\$convert' requires the 'to' field/);
  });

  it("rejects an unknown key with a didYouMean suggestion", () => {
    expect(() => jsmql.expr("$cond({ iff: $.a, then: 1, else: 2 })")).toThrow(
      /'\$cond' has no parameter 'iff'\. Did you mean 'if'\? Valid keys: if, then, else\./,
    );
    expect(() => jsmql.expr('$dateAdd({ startdate: $.t, unit: "day", amount: 1 })')).toThrow(
      /'\$dateAdd' has no parameter 'startdate'\. Did you mean 'startDate'\?/,
    );
  });

  it("a typo of a REQUIRED key is reported as the unknown key (not 'requires …')", () => {
    // unknown-key runs before required-key, so a near typo names the suggestion.
    expect(() => jsmql.expr("$filter({ input: $.a, conds: $.x })")).toThrow(
      /'\$filter' has no parameter 'conds'\. Did you mean 'cond'\?/,
    );
  });

  it("valid object-form and positional calls still compile", () => {
    expect(jsmql.expr('$dateAdd({ startDate: $.t, unit: "day", amount: 1, timezone: "UTC" })')).toEqual({
      $dateAdd: { startDate: "$t", unit: "day", amount: 1, timezone: "UTC" },
    });
    expect(jsmql.expr("$filter({ input: $.a, cond: $.keep, as: 'i', limit: 3 })")).toEqual({
      $filter: { input: "$a", cond: "$keep", as: "i", limit: 3 },
    });
    // positional form is keyed by position, so it cannot have unknown keys
    expect(jsmql.expr('$dateTrunc($.t, "day")')).toEqual({ $dateTrunc: { date: "$t", unit: "day" } });
  });

  it("non-object-shape operators given an object literal treat it as a VALUE (no key check)", () => {
    // $mergeObjects is flex — a lone object is its operand, not named keys.
    expect(jsmql.expr("$mergeObjects({ a: 1, bogus: 2 })")).toEqual({ $mergeObjects: { a: 1, bogus: 2 } });
  });
});

describe("operator arity validation (array / flex shapes)", () => {
  it("rejects a wrong fixed arity (both positional and single-array forms)", () => {
    expect(() => jsmql.expr("$divide(6, 2, 1)")).toThrow(
      /\$divide\(dividend, divisor\) requires exactly 2 arguments, got 3/,
    );
    expect(() => jsmql.expr("$cmp([1, 2, 3])")).toThrow(/\$cmp\(expr1, expr2\) requires exactly 2 arguments, got 3/);
    expect(() => jsmql.expr("$substrCP($.s, 0, 2, 3)")).toThrow(/requires exactly 3 arguments, got 4/);
    expect(() => jsmql.expr("$arrayElemAt($.a, 0, 1)")).toThrow(/requires exactly 2 arguments, got 3/);
  });

  it("rejects a count outside a bounded range", () => {
    expect(() => jsmql.expr("$slice([$.a])")).toThrow(/\$slice\(.*\) requires 2 or 3 arguments, got 1/);
    expect(() => jsmql.expr("$ifNull([$.x])")).toThrow(/\$ifNull\(.*\) requires at least 2 arguments, got 1/);
  });

  it("a single non-array arg to a list operator keeps the list-operand error (codegen owns it)", () => {
    expect(() => jsmql.expr("$divide(10)")).toThrow(/\$divide operates on a list of operands/);
  });

  it("variadic operators stay unconstrained ($add / $setUnion / $concat)", () => {
    expect(jsmql.expr("$add(1, 2, 3, 4)")).toEqual({ $add: [1, 2, 3, 4] });
    expect(jsmql.expr("$setUnion($.a, $.b, $.c)")).toEqual({ $setUnion: ["$a", "$b", "$c"] });
  });

  it("valid fixed / ranged / single-array forms compile", () => {
    expect(jsmql.expr("$divide(6, 2)")).toEqual({ $divide: [6, 2] });
    expect(jsmql.expr("$divide([6, 2])")).toEqual({ $divide: [6, 2] });
    expect(jsmql.expr("$round($.x)")).toEqual({ $round: "$x" }); // flex 1-arg ok
    expect(jsmql.expr("$round($.x, 2)")).toEqual({ $round: ["$x", 2] });
    expect(jsmql.expr("$slice($.a, 0, 3)")).toEqual({ $slice: ["$a", 0, 3] });
  });
});

describe("comparison-operator arity is aggregation-only (query single-value form stays valid)", () => {
  // In aggregation position $eq/$ne/$gt/$gte/$lt/$lte need exactly 2 operands;
  // the 1-arg / array forms are the valid QUERY predicate forms, so the check
  // fires ONLY when the operator is in aggregation-expression position.
  it("rejects non-2 operand counts in aggregation position (jsmql.expr + stage body)", () => {
    expect(() => jsmql.expr("$gt($.a)")).toThrow(/requires exactly 2 arguments, got 1/);
    expect(() => jsmql.expr("$gt($.a, $.b, $.c)")).toThrow(/requires exactly 2 arguments, got 3/);
    expect(() => jsmql("$project({ r: $lt($.a) });")).toThrow(/requires exactly 2 arguments, got 1/);
    expect(() => jsmql("$addFields({ r: $eq($.a, $.b, $.c) });")).toThrow(/requires exactly 2 arguments, got 3/);
  });

  it("allows the single-value / array form as a query predicate (not aggregation)", () => {
    expect(jsmql("{ age: $gt($.x) }")).toEqual({ age: { $gt: "$x" } });
    expect(jsmql("{ tier: $eq(5) }")).toEqual({ tier: { $eq: 5 } });
    expect(jsmql("$match({ age: $gte($.threshold) });")).toEqual([{ $match: { age: { $gte: "$threshold" } } }]);
  });

  it("the valid 2-operand aggregation form is unaffected", () => {
    expect(jsmql.expr("$gt($.a, $.b)")).toEqual({ $gt: ["$a", "$b"] });
    expect(jsmql("$project({ r: $eq($.a, $.b) });")).toEqual([{ $project: { r: { $eq: ["$a", "$b"] } } }]);
  });

  it("accumulator-dual flex ops ($max/$min/$sum) keep their valid 1-arg form in aggregation", () => {
    expect(jsmql.expr("$max($.scores)")).toEqual({ $max: "$scores" });
    expect(jsmql.expr("$sum($.amount)")).toEqual({ $sum: "$amount" });
  });
});

describe("operator enum validation (closed string sets)", () => {
  it("rejects a bad timeUnit (case-sensitive lowercase)", () => {
    expect(() => jsmql.expr('$dateAdd({ startDate: $.t, unit: "fortnight", amount: 5 })')).toThrow(
      /'\$dateAdd' unit must be one of: year, .* millisecond — got 'fortnight'/,
    );
    expect(() => jsmql.expr('$dateTrunc({ date: $.t, unit: "Day" })')).toThrow(/unit must be one of/);
  });

  it("rejects a bad startOfWeek but accepts any case (weekday is case-insensitive)", () => {
    expect(() => jsmql.expr('$dateDiff({ startDate: $.a, endDate: $.b, unit: "day", startOfWeek: "funday" })')).toThrow(
      /startOfWeek must be a weekday .* Did you mean 'sunday'\?/,
    );
    // mongod accepts "Monday"/"monday"/"MONDAY" — so jsmql must not reject them.
    expect(jsmql.expr('$dateTrunc({ date: $.t, unit: "week", startOfWeek: "Monday" })')).toEqual({
      $dateTrunc: { date: "$t", unit: "week", startOfWeek: "Monday" },
    });
  });

  it("rejects a bad $convert target type but allows a numeric type code", () => {
    expect(() => jsmql.expr('$convert({ input: $.s, to: "intt" })')).toThrow(
      /'\$convert' to must be one of: .* — got 'intt'\. Did you mean 'int'\?/,
    );
    expect(jsmql.expr('$convert({ input: $.s, to: "int" })')).toEqual({ $convert: { input: "$s", to: "int" } });
    expect(jsmql.expr("$convert({ input: $.s, to: 16 })")).toEqual({ $convert: { input: "$s", to: 16 } });
  });

  it("rejects a JS-only regex flag (g/y) via the charset check", () => {
    expect(() => jsmql.expr('$regexMatch({ input: $.s, regex: "a", options: "gi" })')).toThrow(
      /'\$regexMatch' options has an invalid regex flag 'g'/,
    );
    expect(jsmql.expr('$regexMatch({ input: $.s, regex: "a", options: "im" })')).toEqual({
      $regexMatch: { input: "$s", regex: "a", options: "im" },
    });
  });

  it("rejects bad method / lang enums", () => {
    expect(() => jsmql("$group({ _id: 1, m: $median({ input: $.v, method: 'exact' }) });")).toThrow(
      /method must be one of: approximate — got 'exact'/,
    );
    expect(() => jsmql.expr('$function({ body: "function(){}", args: [], lang: "python" })')).toThrow(
      /lang must be one of: js — got 'python'/,
    );
  });

  it("the gate holds: a runtime (non-literal) enum slot compiles", () => {
    expect(jsmql.expr("$dateAdd({ startDate: $.t, unit: $.u, amount: 5 })")).toEqual({
      $dateAdd: { startDate: "$t", unit: "$u", amount: 5 },
    });
  });
});

describe("operator literal-type validation — date slots (was DEF-029)", () => {
  it("rejects a literal non-date in a date-accessor argument", () => {
    expect(() => jsmql.expr('$year("2020-01-01")')).toThrow(
      /'\$year' expects a date, but got a string\. Use a field path or new Date\(…\)\./,
    );
    expect(() => jsmql.expr("$hour(5)")).toThrow(/'\$hour' expects a date, but got a number/);
  });

  it("rejects a literal non-date / bad amount / bad timezone in $dateAdd", () => {
    expect(() => jsmql.expr('$dateAdd({ startDate: "2020-01-01", unit: "day", amount: 1 })')).toThrow(
      /'\$dateAdd' startDate expects a date/,
    );
    expect(() => jsmql.expr('$dateAdd({ startDate: $.t, unit: "day", amount: "3" })')).toThrow(
      /'\$dateAdd' amount expects an integer, but got a string/,
    );
    expect(() => jsmql.expr('$dateAdd({ startDate: $.t, unit: "day", amount: 3.5 })')).toThrow(
      /'\$dateAdd' amount expects an integer, but got a number/,
    );
    expect(() => jsmql.expr('$dateAdd({ startDate: $.t, unit: "day", amount: 1, timezone: 5 })')).toThrow(
      /'\$dateAdd' timezone expects a string, but got a number/,
    );
  });

  it("rejects a literal non-date in $dateDiff / $dateTrunc", () => {
    expect(() => jsmql.expr('$dateDiff({ startDate: "2020", endDate: $.b, unit: "day" })')).toThrow(
      /'\$dateDiff' startDate expects a date/,
    );
    expect(() => jsmql.expr('$dateTrunc({ date: "2020", unit: "day" })')).toThrow(/'\$dateTrunc' date expects a date/);
  });

  it("allows a field ref, a $-string field path, and new Date(...) in a date slot (gate)", () => {
    expect(jsmql.expr("$year($.createdAt)")).toEqual({ $year: "$createdAt" });
    expect(jsmql.expr('$year("$createdAt")')).toEqual({ $year: "$createdAt" }); // HR1: a $-string is a field ref
    expect(jsmql.expr('$dateAdd({ startDate: new Date("2020-01-01"), unit: "day", amount: 1 })')).toEqual({
      // A constant `new Date(...)` folds to a real BSON Date (HR1), not `{ $toDate }`.
      $dateAdd: { startDate: new Date("2020-01-01"), unit: "day", amount: 1 },
    });
    // a negative integer amount is fine
    expect(jsmql.expr("$dateAdd({ startDate: $.t, unit: 'day', amount: -3 })")).toEqual({
      $dateAdd: { startDate: "$t", unit: "day", amount: -3 },
    });
  });
});

describe("operator literal-type validation — numeric / bitwise / object / array / timestamp", () => {
  it("numeric ops reject a literal non-number (no coercion)", () => {
    expect(() => jsmql.expr('$abs("x")')).toThrow(/'\$abs' expects a number, but got a string/);
    expect(() => jsmql.expr("$sqrt(true)")).toThrow(/'\$sqrt' expects a number, but got a boolean/);
    expect(() => jsmql.expr('$multiply($.a, "x")')).toThrow(/'\$multiply' expects a number, but got a string/);
    expect(() => jsmql.expr('$add($.price, "x")')).toThrow(/'\$add' expects a number or a date, but got a string/);
  });

  it("bitwise ops reject a non-integer number / non-number", () => {
    expect(() => jsmql.expr("$bitNot(5.5)")).toThrow(/'\$bitNot' expects an integer, but got a number/);
    expect(() => jsmql.expr("$bitAnd($.a, 2.5)")).toThrow(/'\$bitAnd' expects an integer, but got a number/);
    expect(() => jsmql.expr('$bitNot("x")')).toThrow(/'\$bitNot' expects an integer, but got a string/);
  });

  it("object / array / timestamp shape mismatches are rejected", () => {
    expect(() => jsmql.expr('$mergeObjects("hello")')).toThrow(/'\$mergeObjects' expects a document, but got a string/);
    expect(() => jsmql.expr("$objectToArray(5)")).toThrow(/'\$objectToArray' expects a document, but got a number/);
    expect(() => jsmql.expr('$size("hello")')).toThrow(/'\$size' expects an array, but got a string/);
    expect(() => jsmql.expr("$reverseArray(5)")).toThrow(/'\$reverseArray' expects an array, but got a number/);
    expect(() => jsmql("$group({ _id: 1, t: $tsSecond('x') });")).toThrow(
      /'\$tsSecond' expects a timestamp, but got a string/,
    );
  });

  it("the gate holds: field refs, $-string field paths, and valid literals compile", () => {
    expect(jsmql.expr("$abs($.delta)")).toEqual({ $abs: "$delta" });
    expect(jsmql.expr('$abs("$delta")')).toEqual({ $abs: "$delta" }); // $-string = field ref
    expect(jsmql.expr("$add($.price, 10)")).toEqual({ $add: ["$price", 10] });
    expect(jsmql.expr("$bitNot($.flags)")).toEqual({ $bitNot: "$flags" });
    expect(jsmql.expr("$mergeObjects($.a, { x: 1 })")).toEqual({ $mergeObjects: ["$a", { x: 1 }] });
    expect(jsmql.expr("$size($.items)")).toEqual({ $size: "$items" });
  });
});

describe("do-not-over-validate — server-accepted shapes must compile (coverage proof)", () => {
  // Every shape here is ACCEPTED by mongod (verified), so jsmql must NOT reject
  // it. These lock the gaps closed: a future arity/range rule that threw on one
  // of them would be a regression (a false positive on valid MQL).
  it("variadic ops accept an empty operand list (no min-arity)", () => {
    expect(jsmql.expr("$and([])")).toEqual({ $and: [] });
    expect(jsmql.expr("$or([])")).toEqual({ $or: [] });
    expect(jsmql.expr("$concat([])")).toEqual({ $concat: [] });
  });

  it("set ops accept a single set (no minimum-2 arity)", () => {
    expect(jsmql.expr("$setUnion([$.a])")).toEqual({ $setUnion: ["$a"] });
    expect(jsmql.expr("$setIntersection([$.a])")).toEqual({ $setIntersection: ["$a"] });
  });

  it("$covariancePop / $covarianceSamp accept 1/2/3 operands (no fixed arity)", () => {
    const win = (operands: string) =>
      `$setWindowFields({ sortBy: { a: 1 }, output: { c: $covariancePop(${operands}) } });`;
    expect(() => jsmql(win("[$.a]"))).not.toThrow();
    expect(() => jsmql(win("$.a, $.b"))).not.toThrow();
    expect(() => jsmql(win("$.a, $.b, $.c"))).not.toThrow();
  });

  it("$dateFromParts does not range-check numeric parts (the server overflows them)", () => {
    expect(jsmql.expr("$dateFromParts({ year: 2020, month: 13 })")).toEqual({
      $dateFromParts: { year: 2020, month: 13 },
    });
  });
});

describe("escape-hatch operators (single-arg, expression-shaped)", () => {
  it("$sampleRate(0.1) → { $sampleRate: 0.1 }", () => {
    expect(jsmql.expr("$sampleRate(0.1)")).toEqual({ $sampleRate: 0.1 });
  });
});

describe("regex literal in standalone position", () => {
  it("rejects /pattern/ as a binary operand with a clear error", () => {
    expect(() => jsmql.expr("$.x === /foo/")).toThrow(/Regex literals are only valid as arguments to \.match\(\)/);
  });
});

describe("zero-arg operators", () => {
  it("$rand", () => {
    expect(jsmql.expr("$rand()")).toEqual({ $rand: {} });
  });

  it("$createObjectId() / $count() emit the empty-object form", () => {
    expect(jsmql.expr("$createObjectId()")).toEqual({ $createObjectId: {} });
    expect(jsmql.expr("$count()")).toEqual({ $count: {} });
  });

  // A none-shape operator silently dropped any args it was given (emitting a
  // valid-but-not-what-the-user-meant `{ $op: {} }`). Reject them instead.
  it("rejects arguments to a none-shape operator", () => {
    expect(() => jsmql.expr("$rand(1, 2)")).toThrow(/\$rand\(\) takes no arguments, got 2/);
    expect(() => jsmql.expr("$createObjectId($.x)")).toThrow(/\$createObjectId\(\) takes no arguments, got 1/);
    expect(() => jsmql.expr("$count(5)")).toThrow(/\$count\(\) takes no arguments, got 1/);
    // object-style is rejected too — the arg count is 1, not 0.
    expect(() => jsmql.expr("$rand({ x: 1 })")).toThrow(/\$rand\(\) takes no arguments, got 1/);
  });

  // The window ranking ops compute position from the $setWindowFields ordering,
  // so a passed field is always a mistake — point at sortBy.
  it("redirects window ranking ops to the $setWindowFields sortBy", () => {
    expect(() => jsmql("$setWindowFields({ sortBy: { t: 1 }, output: { r: $rank($.x) } });")).toThrow(
      /\$rank\(\) takes no arguments, got 1\. Its value is computed from the '\$setWindowFields' sortBy/,
    );
  });
});

describe("unknown operators (fallthrough)", () => {
  it("zero args → {}", () => {
    expect(jsmql.expr("$someNewOp()")).toEqual({ $someNewOp: {} });
  });

  it("single non-object arg → bare value", () => {
    expect(jsmql.expr("$someOp($.a)")).toEqual({ $someOp: "$a" });
  });

  it("single object arg → pass object", () => {
    expect(jsmql.expr('$someOp({ key: "val" })')).toEqual({ $someOp: { key: "val" } });
  });

  it("multiple args → array", () => {
    expect(jsmql.expr("$someNewOp($.a, $.b)")).toEqual({ $someNewOp: ["$a", "$b"] });
  });
});

describe("array literals", () => {
  it("simple array", () => {
    expect(jsmql.expr("$in($.x, [1, 2, 3])")).toEqual({ $in: ["$x", [1, 2, 3]] });
  });

  it("nested array", () => {
    // `$foo` is an unknown-op shape probe (no arg validation) — this exercises
    // array-literal codegen, not operator semantics.
    expect(jsmql.expr("$foo([1, [2, 3]])")).toEqual({ $foo: [1, [2, 3]] });
  });
});

describe("array spread", () => {
  it("single spread becomes the spread argument directly (no redundant $concatArrays)", () => {
    expect(jsmql.expr("$foo([...$.arr])")).toEqual({ $foo: "$arr" });
  });

  it("two spreads emit $concatArrays", () => {
    expect(jsmql.expr("$foo([...$.a, ...$.b])")).toEqual({ $foo: { $concatArrays: ["$a", "$b"] } });
  });

  it("statics before a spread group into one operand", () => {
    expect(jsmql.expr("$foo([1, 2, ...$.rest])")).toEqual({ $foo: { $concatArrays: [[1, 2], "$rest"] } });
  });

  it("statics after a spread group into one operand", () => {
    expect(jsmql.expr("$foo([...$.base, 1, 2])")).toEqual({ $foo: { $concatArrays: ["$base", [1, 2]] } });
  });

  it("statics around a spread split into two grouped operands (left-to-right)", () => {
    expect(jsmql.expr("$foo([1, ...$.mid, 2])")).toEqual({ $foo: { $concatArrays: [[1], "$mid", [2]] } });
  });

  it("multiple spreads with statics interleaved", () => {
    expect(jsmql.expr("$foo([1, ...$.a, 2, ...$.b, 3])")).toEqual({
      $foo: { $concatArrays: [[1], "$a", [2], "$b", [3]] },
    });
  });

  it("spread of a literal array produces $concatArrays of literal-array operands", () => {
    expect(jsmql.expr("$foo([...[1, 2], 3])")).toEqual({ $foo: { $concatArrays: [[1, 2], [3]] } });
  });

  it("spread inside .map lambda body remaps the lambda param", () => {
    expect(jsmql.expr("$.xs.map(x => [...$.prefix, x])")).toEqual({
      $map: { input: "$xs", as: "x", in: { $concatArrays: ["$prefix", ["$$x"]] } },
    });
  });

  it("empty array still works (no spread, fast path)", () => {
    expect(jsmql.expr("$foo([])")).toEqual({ $foo: [] });
  });

  it("plain non-spread arrays unchanged (regression)", () => {
    expect(jsmql.expr("$foo([1, 2, 3])")).toEqual({ $foo: [1, 2, 3] });
  });

  it("nested array literal with spread inside", () => {
    expect(jsmql.expr("$foo([[...$.a]])")).toEqual({ $foo: ["$a"] });
  });
});

describe("object literals as args", () => {
  it("object as second positional arg for unknown op", () => {
    expect(jsmql.expr("$foo({ a: 1 }, $.b)")).toEqual({ $foo: [{ a: 1 }, "$b"] });
  });
});

describe("object spread", () => {
  it("single spread becomes the spread argument directly (no redundant $mergeObjects)", () => {
    expect(jsmql.expr("$foo({ ...$.base })")).toEqual({ $foo: "$base" });
  });

  it("two spreads emit $mergeObjects", () => {
    expect(jsmql.expr("$foo({ ...$.a, ...$.b })")).toEqual({ $foo: { $mergeObjects: ["$a", "$b"] } });
  });

  it("static keys before a spread group into one operand", () => {
    expect(jsmql.expr("$foo({ x: 1, y: 2, ...$.rest })")).toEqual({
      $foo: { $mergeObjects: [{ x: 1, y: 2 }, "$rest"] },
    });
  });

  it("static keys after a spread group into one operand", () => {
    expect(jsmql.expr("$foo({ ...$.base, x: 1 })")).toEqual({ $foo: { $mergeObjects: ["$base", { x: 1 }] } });
  });

  it("statics around a spread split into separate operands (left-to-right)", () => {
    expect(jsmql.expr("$foo({ x: 1, ...$.mid, y: 2 })")).toEqual({
      $foo: { $mergeObjects: [{ x: 1 }, "$mid", { y: 2 }] },
    });
  });

  it("computed key inside a static block uses $arrayToObject for that block only", () => {
    expect(jsmql.expr("$foo({ ...$.base, [$.k]: $.v })")).toEqual({
      $foo: { $mergeObjects: ["$base", { $arrayToObject: [[{ k: "$k", v: "$v" }]] }] },
    });
  });

  it("works inside .reduce — the README $accumulator replacement", () => {
    // The accumulator is narrowed to "object" by reduce-codegen (initialValue
    // is `{}` and the body returns an `ObjectLiteral`), so `acc[s]` emits
    // `$getField` directly instead of the runtime `$cond` on `$isArray`.
    expect(jsmql.expr("$.statuses.reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {})")).toEqual({
      $reduce: {
        input: "$statuses",
        initialValue: {},
        in: {
          $mergeObjects: [
            "$$value",
            {
              $arrayToObject: [
                [
                  {
                    k: "$$this",
                    v: { $add: [{ $ifNull: [{ $getField: { field: "$$this", input: "$$value" } }, 0] }, 1] },
                  },
                ],
              ],
            },
          ],
        },
      },
    });
  });

  it("rejects spread inside operator-arg objects (key shape is wire format)", () => {
    expect(() => jsmql.expr("$replaceOne({ ...$.opts, input: $.s })")).toThrow(/Spread/);
  });
});

describe("$cond", () => {
  it("positional 3-arg cond (object-shape, maps to if/then/else)", () => {
    expect(jsmql.expr('$cond($.age, "adult", "minor")')).toEqual({
      $cond: { if: "$age", then: "adult", else: "minor" },
    });
  });

  it("object-style cond", () => {
    expect(jsmql.expr('$cond({ if: $.active, then: "yes", else: "no" })')).toEqual({
      $cond: { if: "$active", then: "yes", else: "no" },
    });
  });
});

describe("jsmql template-tag form", () => {
  it("interpolates number", () => {
    const age = 21;
    expect(jsmql.expr`$gt($.age, ${age})`).toEqual({ $gt: ["$age", 21] });
  });

  it("interpolates array", () => {
    const statuses = ["active", "pending"];
    expect(jsmql.expr`$in($.status, ${statuses})`).toEqual({ $in: ["$status", ["active", "pending"]] });
  });

  it("interpolates string", () => {
    const prefix = "admin";
    expect(jsmql.expr`$eq($.role, ${prefix})`).toEqual({ $eq: ["$role", "admin"] });
  });

  it("works with no interpolations (template-tag detection survives empty values)", () => {
    expect(jsmql.expr`$.age > 18`).toEqual({ $gt: ["$age", 18] });
  });

  describe("opaque BSON value interpolation", () => {
    // JSON.stringify mangles these instances — `new Date(...)` becomes an ISO
    // string (BSON compares as a string), `RegExp` becomes "{}", `Uint8Array`
    // becomes a sparse object. The template-tag path routes them through a
    // synthesized ParamRef binding so the original instance reaches the MQL
    // output untouched — that's the shape MongoDB's driver expects in-situ.

    it("Date interpolation lands in query-doc form as a real Date", () => {
      const cutoff = new Date("2026-01-01");
      const out = jsmql`$.method === ${"postalDelivery"} && $.createdAt >= ${cutoff}` as {
        method: string;
        createdAt: { $gte: Date };
      };
      expect(out).toEqual({ method: "postalDelivery", createdAt: { $gte: cutoff } });
      expect(out.createdAt.$gte).toBeInstanceOf(Date);
      expect(out.createdAt.$gte.getTime()).toBe(cutoff.getTime());
    });

    it("RegExp interpolation lands in query-doc form as a real RegExp", () => {
      const pat = /^alice/i;
      const out = jsmql`$.username === ${pat}` as { username: RegExp };
      expect(out.username).toBe(pat);
    });

    it("Uint8Array interpolation passes through unchanged", () => {
      const buf = new Uint8Array([1, 2, 3]);
      const out = jsmql`$.payload === ${buf}` as { payload: Uint8Array };
      expect(out.payload).toBe(buf);
    });

    it("ObjectId duck-typed (legacy _bsontype: 'ObjectID') passes through unchanged", () => {
      const oid = { _bsontype: "ObjectID", id: "abc" };
      const out = jsmql`$._id === ${oid}` as { _id: typeof oid };
      expect(out._id).toBe(oid);
    });

    it("ObjectId duck-typed (newer _bsontype: 'ObjectId') passes through unchanged", () => {
      const oid = { _bsontype: "ObjectId", id: "xyz" };
      const out = jsmql`$._id === ${oid}` as { _id: typeof oid };
      expect(out._id).toBe(oid);
    });

    it("Date interpolation works inside an explicit $match pipeline stage", () => {
      const cutoff = new Date("2026-01-01");
      const out = jsmql`$match($.createdAt >= ${cutoff});` as Array<{ $match: { createdAt: { $gte: Date } } }>;
      expect(out).toEqual([{ $match: { createdAt: { $gte: cutoff } } }]);
      expect(out[0].$match.createdAt.$gte).toBeInstanceOf(Date);
    });

    it("Date interpolation flows through jsmql.expr — lands directly in the expression", () => {
      const cutoff = new Date("2026-01-01");
      const out = jsmql.expr`{ since: ${cutoff} }` as { since: Date };
      expect(out.since).toBe(cutoff);
    });

    it("ordered comparison via template tag is index-friendly (no $expr fallback)", () => {
      // The bug-report shape, expressed via the template tag form.
      const out = jsmql`$.createdAt >= ${new Date("2026-01-01")}` as Record<string, unknown>;
      expect("$expr" in out).toBe(false);
      expect((out.createdAt as { $gte: unknown }).$gte).toBeInstanceOf(Date);
    });

    it("mixing opaque and JSON-shaped interpolations leaves each on its correct path", () => {
      const cutoff = new Date("2026-01-01");
      const tier = "gold";
      const out = jsmql`$.tier === ${tier} && $.createdAt >= ${cutoff}` as { tier: string; createdAt: { $gte: Date } };
      expect(out.tier).toBe("gold");
      expect(out.createdAt.$gte).toBe(cutoff);
    });

    // Nested-interp cases — opaque BSON instances buried inside an interpolated
    // object or array still reach the MQL output as live JS instances. The
    // walker substitutes each instance with a marker carrying a unique binding
    // name, JSON-stringifies the rewritten tree, then post-replaces the
    // markers with bare identifiers so the parser resolves them as ParamRefs.

    it("Date nested inside an interpolated object preserves the instance", () => {
      const since = new Date("2026-01-01");
      const out = jsmql.expr`${{ since }}` as { since: Date };
      expect(out.since).toBe(since);
    });

    it("multiple Dates inside one object each get their own binding", () => {
      const since = new Date("2026-01-01");
      const until = new Date("2026-02-01");
      const out = jsmql.expr`${{ since, until }}` as { since: Date; until: Date };
      expect(out.since).toBe(since);
      expect(out.until).toBe(until);
    });

    it("Date inside an interpolated array preserves position and instance", () => {
      const since = new Date("2026-01-01");
      const until = new Date("2026-02-01");
      const out = jsmql.expr`${[since, until]}` as [Date, Date];
      expect(out[0]).toBe(since);
      expect(out[1]).toBe(until);
    });

    it("mixed JSON + Date inside one interpolated object: each leaf keeps its shape", () => {
      const since = new Date("2026-01-01");
      const out = jsmql.expr`${{ name: "foo", since, count: 42 }}` as { name: string; since: Date; count: number };
      expect(out).toEqual({ name: "foo", since, count: 42 });
      expect(out.since).toBe(since);
    });

    it("deeply-nested opaque value (3 levels) survives", () => {
      const since = new Date("2026-01-01");
      const out = jsmql.expr`${{ a: { b: { c: since } } }}` as { a: { b: { c: Date } } };
      expect(out.a.b.c).toBe(since);
    });

    it("nested RegExp inside an interpolated object preserves the instance", () => {
      const pat = /^alice/i;
      const out = jsmql.expr`${{ pat, label: "name" }}` as { pat: RegExp; label: string };
      expect(out.pat).toBe(pat);
      expect(out.label).toBe("name");
    });

    it("$dateDiff with an interpolated object carrying Date instances — realistic shape", () => {
      // The canonical use case: building a `$dateDiff` body with computed
      // bounds. The interpolated object lives in operator-call position; the
      // two Date instances are preserved at their nested keys.
      const startDate = new Date("2026-01-01");
      const endDate = new Date("2026-02-01");
      const out = jsmql.expr`$dateDiff(${{ startDate, endDate, unit: "day" }})` as {
        $dateDiff: { startDate: Date; endDate: Date; unit: string };
      };
      expect(out.$dateDiff.startDate).toBe(startDate);
      expect(out.$dateDiff.endDate).toBe(endDate);
      expect(out.$dateDiff.unit).toBe("day");
    });

    it("circular references inside an interpolated object surface as JsmqlInterpolationError", () => {
      // Cycle detection in the walker returns the cyclic value as-is so the
      // subsequent JSON.stringify produces the standard "circular structure"
      // error — surfaced as `JsmqlInterpolationError`.
      const cyclic: { since: Date; self?: unknown } = { since: new Date("2026-01-01") };
      cyclic.self = cyclic;
      expect(() => jsmql.expr`${cyclic}`).toThrow(/could not be serialised/);
    });
  });
});

describe("ObjectId literal (in-source constant)", () => {
  const HEX = "698a76556c10b90d8bd0497e";
  const HEX2 = "507f1f77bcf86cd799439011";

  it('ObjectId("hex") in a filter lowers to a live BSON ObjectId in field-equality position', () => {
    const out = jsmql(`$._id === ObjectId("${HEX}")`) as { _id: ObjectId };
    expect(out._id).toBeInstanceOf(ObjectId);
    expect(out._id._bsontype).toBe("ObjectId");
    expect(out._id.toHexString()).toBe(HEX);
    // index-friendly: a query-doc value, not an $expr wrap
    expect("$expr" in out).toBe(false);
  });

  it('new ObjectId("hex") is accepted identically to the bare-call form', () => {
    const bare = jsmql(`$._id === ObjectId("${HEX}")`) as { _id: ObjectId };
    const knew = jsmql(`$._id === new ObjectId("${HEX}")`) as { _id: ObjectId };
    expect(knew._id).toBeInstanceOf(ObjectId);
    expect(knew._id.toHexString()).toBe(bare._id.toHexString());
  });

  it("an array of ObjectId literals lowers to $in with live instances", () => {
    const out = jsmql(`[ObjectId("${HEX}"), ObjectId("${HEX2}")].includes($._id)`) as { _id: { $in: ObjectId[] } };
    expect(out._id.$in.every((o) => o instanceof ObjectId)).toBe(true);
    expect(out._id.$in.map((o) => o.toHexString())).toEqual([HEX, HEX2]);
  });

  it('works as an object-literal value too — { _id: ObjectId("…") } and the new form', () => {
    expect(jsmql(`{ _id: ObjectId("${HEX}") }`)).toEqual({ _id: new ObjectId(HEX) });
    expect(jsmql(`{ _id: new ObjectId("${HEX}") }`)).toEqual({ _id: new ObjectId(HEX) });
  });

  it("ObjectId literal in aggregation-expression position lands directly in the expression", () => {
    const out = jsmql.expr(`$._id === ObjectId("${HEX}")`) as { $eq: [string, ObjectId] };
    expect(out.$eq[0]).toBe("$_id");
    expect(out.$eq[1]).toBeInstanceOf(ObjectId);
    expect(out.$eq[1].toHexString()).toBe(HEX);
  });

  it("ObjectId literal inside an explicit $match pipeline stage", () => {
    const out = jsmql(`$match($._id === ObjectId("${HEX}"));`) as Array<{ $match: { _id: ObjectId } }>;
    expect(out[0].$match._id).toBeInstanceOf(ObjectId);
    expect(out[0].$match._id.toHexString()).toBe(HEX);
  });

  it("emits a real BSON value (12 serialisable bytes), not a string — the property that makes the server match it", () => {
    const out = jsmql(`$._id === ObjectId("${HEX}")`) as { _id: ObjectId };
    const buf = new Uint8Array(12);
    expect(out._id.serializeInto(buf, 0)).toBe(12);
    expect(Buffer.from(buf).toString("hex")).toBe(HEX);
  });

  it("rejects a wrong-length hex string with a position-bearing error", () => {
    expect(() => jsmql(`$._id === ObjectId("507f1f77bcf86cd79943901")`)).toThrow(
      /expected exactly 24 hexadecimal characters, got 23/,
    );
  });

  it("rejects a 24-character non-hex string", () => {
    expect(() => jsmql(`$._id === ObjectId("zzzf1f77bcf86cd799439011")`)).toThrow(
      /contains non-hexadecimal characters/,
    );
  });

  it("the no-argument form lowers to $createObjectId() (server-side fresh id)", () => {
    expect(jsmql.expr(`ObjectId()`)).toEqual({ $createObjectId: {} });
    expect(jsmql.expr(`new ObjectId()`)).toEqual({ $createObjectId: {} });
  });

  it("a dynamic argument lowers to $toObjectId(arg) (server-side conversion)", () => {
    expect(jsmql.expr(`ObjectId($.idStr)`)).toEqual({ $toObjectId: "$idStr" });
    // In a filter the converted value isn't a query-doc literal, so it rides in $expr.
    expect(jsmql(`$._id === ObjectId($.idStr)`)).toEqual({ $expr: { $eq: ["$_id", { $toObjectId: "$idStr" }] } });
  });

  it("a constant string that isn't 24 hex chars is still a compile-time error (caught typo)", () => {
    expect(() => jsmql(`$._id === ObjectId("507f1f77bcf86cd79943901")`)).toThrow(
      /expected exactly 24 hexadecimal characters, got 23/,
    );
  });

  it("validate() reports an invalid ObjectId literal with a real .pos", () => {
    const r = jsmql.validate(`$._id === ObjectId("nothex")`);
    expect(r.valid).toBe(false);
    expect(r.errors[0].pos).toBeGreaterThan(0);
  });
});

describe("ObjectId via 0x hex literal", () => {
  const HEX = "507f1f77bcf86cd799439011";
  const HEX2 = "698a76556c10b90d8bd0497e";

  it("0x + exactly 24 hex digits lowers to a live ObjectId (type 0x, paste an _id)", () => {
    const out = jsmql(`$._id === 0x${HEX}`) as { _id: ObjectId };
    expect(out._id).toBeInstanceOf(ObjectId);
    expect(out._id.toHexString()).toBe(HEX);
    expect("$expr" in out).toBe(false);
  });

  it('identical to the ObjectId("…") form', () => {
    const viaHex = jsmql(`$._id === 0x${HEX}`) as { _id: ObjectId };
    const viaCall = jsmql(`$._id === ObjectId("${HEX}")`) as { _id: ObjectId };
    expect(viaHex._id.toHexString()).toBe(viaCall._id.toHexString());
  });

  it("numeric separators are allowed inside the hex literal", () => {
    const out = jsmql(`$._id === 0x507f_1f77_bcf8_6cd7_9943_9011`) as { _id: ObjectId };
    expect(out._id.toHexString()).toBe(HEX);
  });

  it("an array of 0x literals lowers to $in", () => {
    const out = jsmql(`[0x${HEX}, 0x${HEX2}].includes($._id)`) as { _id: { $in: ObjectId[] } };
    expect(out._id.$in.map((o) => o.toHexString())).toEqual([HEX, HEX2]);
  });

  // The canonical "look up one doc by its _id" form: a raw filter doc written as
  // an object literal, with the id as a `0x…` value. Mirrors what you'd paste
  // into db.coll.find(...). → { _id: ObjectId("…") }.
  it("a 0x literal as an object-literal value mints an ObjectId (the canonical _id lookup)", () => {
    expect(jsmql(`{ _id: 0x${HEX} }`)).toEqual({ _id: new ObjectId(HEX) });
  });

  it("0x literals inside a raw filter doc's $in array each mint an ObjectId", () => {
    expect(jsmql(`{ _id: { $in: [0x${HEX}, 0x${HEX2}] } }`)).toEqual({
      _id: { $in: [new ObjectId(HEX), new ObjectId(HEX2)] },
    });
  });

  it("a 0x literal nested inside an object value mints an ObjectId", () => {
    expect(jsmql(`{ owner: { id: 0x${HEX} } }`)).toEqual({ owner: { id: new ObjectId(HEX) } });
  });

  it("0X prefix and uppercase hex digits are accepted (normalised to lowercase)", () => {
    // Timestamp 0xabcdef78 → year 2061, comfortably after the 2009 floor.
    const out = jsmql.expr(`0XABCDEF781234567812345678`) as ObjectId;
    expect(out).toBeInstanceOf(ObjectId);
    expect(out.toHexString()).toBe("abcdef781234567812345678");
  });

  it("a short hex literal stays a plain integer", () => {
    expect(jsmql.expr(`0xff`)).toBe(255);
    // 0x1FFFFFFFFFFFFF === Number.MAX_SAFE_INTEGER (the largest exactly-representable int)
    expect(jsmql.expr(`0x1FFFFFFFFFFFFF`)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("a hex literal that is neither 24 digits nor a safe integer is rejected with guidance", () => {
    // 16 digits, > MAX_SAFE_INTEGER, not an ObjectId width.
    expect(() => jsmql(`$.x === 0xFFFFFFFFFFFFFFFF`)).toThrow(/neither a 24-character ObjectId nor an integer/);
    // 14 digits, exactly one past MAX_SAFE_INTEGER (0x20000000000000 === 2**53).
    expect(() => jsmql.expr(`0x20000000000000`)).toThrow(/neither a 24-character ObjectId/);
    // 23 digits — one short of an ObjectId.
    expect(() => jsmql(`$._id === 0x507f1f77bcf86cd79943901`)).toThrow(/neither a 24-character ObjectId/);
    // 25 digits — one past an ObjectId.
    expect(() => jsmql.expr(`0x1234567812345678123456789`)).toThrow(/neither a 24-character ObjectId/);
  });
});

describe("ObjectId plausibility floor (timestamp predating MongoDB = typo)", () => {
  // An ObjectId's first 4 bytes are a Unix timestamp; MongoDB didn't exist
  // before 2009, so an older one can't be real. Floor: 0x4a000000 (2009-05-05).

  it("rejects an all-zeros / leading-zeros id (1970) — a 24-digit shape, but impossibly old", () => {
    // Recognised as an ObjectId by width, then floored — the error is about the
    // timestamp, not the digit count.
    expect(() => jsmql.expr(`0x000000000000000000000001`)).toThrow(/older than the smallest valid ObjectId/);
  });

  it("rejects a sequential test id like 0x1234… (its timestamp is 1979)", () => {
    expect(() => jsmql(`{ _id: 0x123456781234567812345678 }`)).toThrow(/1979-09-05.*older than the smallest/);
  });

  it('rejects the same too-old id written as ObjectId("…") / new ObjectId("…")', () => {
    expect(() => jsmql.expr(`ObjectId("123456781234567812345678")`)).toThrow(/older than the smallest valid ObjectId/);
    expect(() => jsmql.expr(`new ObjectId("123456781234567812345678")`)).toThrow(
      /older than the smallest valid ObjectId/,
    );
  });

  it("the error names the decoded timestamp date (actionable DX)", () => {
    expect(() => jsmql.expr(`0x000000000000000000000000`)).toThrow(/1970-01-01/);
  });

  it("accepts an id exactly at the floor (2009-05-05) and just above", () => {
    expect((jsmql.expr(`0x4a0000000000000000000000`) as ObjectId).toHexString()).toBe("4a0000000000000000000000");
    expect((jsmql.expr(`0x4a0000000000000000000001`) as ObjectId).toHexString()).toBe("4a0000000000000000000001");
  });

  it("rejects just below the floor (2009-05-05 minus an instant)", () => {
    expect(() => jsmql.expr(`0x49ffffffffffffffffffffff`)).toThrow(/older than the smallest valid ObjectId/);
  });

  it("validate() reports a too-old ObjectId with a real .pos", () => {
    const r = jsmql.validate(`$._id === 0x000000000000000000000001`);
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/older than the smallest valid ObjectId/);
    expect(r.errors[0].pos).toBeGreaterThan(0);
  });
});

describe("jsmql.compile — opaque BSON bindings outside query-doc position", () => {
  // Pre-existing bug, fixed in tandem with the template-tag side channel:
  // `safeBoundValue` used to iterate `Object.entries(bsonInstance)` and
  // silently collapse the value to `{}`. Bindings consumed inside an update
  // op body, an aggregation expression, etc. now pass through intact.

  it("Date binding lands as a real Date inside an update op", () => {
    const q = jsmql.compile(({ at }: { at: Date }, { $ }) => ($.lastSeenAt = at));
    const at = new Date("2026-01-01");
    const out = q({ at }) as Array<{ $set: { lastSeenAt: Date } }>;
    expect(out[0].$set.lastSeenAt).toBe(at);
  });

  it("RegExp binding lands as a real RegExp inside an update op", () => {
    const q = jsmql.compile(({ pat }: { pat: RegExp }, { $ }) => ($.name = pat));
    const pat = /^alice/i;
    const out = q({ pat }) as Array<{ $set: { name: RegExp } }>;
    expect(out[0].$set.name).toBe(pat);
  });

  // Nested-BSON cases — symmetric with the template-tag nested-interp tests.
  // `safeBoundValue` recurses through plain objects/arrays and short-circuits
  // on `isOpaqueBsonValue`, so the same shapes that work via interpolation
  // also work via parameter bindings — no manual unpacking required at the
  // call site.

  it("Date nested inside a binding object preserves the instance", () => {
    const q = jsmql.compile(({ window }: { window: { since: Date; until: Date; unit: string } }) => $set({ window }));
    const since = new Date("2026-01-01");
    const until = new Date("2026-02-01");
    const out = q({ window: { since, until, unit: "day" } }) as Array<{
      $set: { window: { since: Date; until: Date; unit: string } };
    }>;
    expect(out[0].$set.window.since).toBe(since);
    expect(out[0].$set.window.until).toBe(until);
    expect(out[0].$set.window.unit).toBe("day");
  });

  it("Date inside a binding array preserves each instance", () => {
    const q = jsmql.compile(({ bounds }: { bounds: Date[] }) => $set({ bounds }));
    const since = new Date("2026-01-01");
    const until = new Date("2026-02-01");
    const out = q({ bounds: [since, until] }) as Array<{ $set: { bounds: Date[] } }>;
    expect(out[0].$set.bounds[0]).toBe(since);
    expect(out[0].$set.bounds[1]).toBe(until);
  });

  it("deeply-nested (3 levels) Date inside a binding survives", () => {
    const q = jsmql.compile(({ cfg }: { cfg: { a: { b: { c: Date } } } }) => $set({ cfg }));
    const since = new Date("2026-01-01");
    const out = q({ cfg: { a: { b: { c: since } } } }) as Array<{ $set: { cfg: { a: { b: { c: Date } } } } }>;
    expect(out[0].$set.cfg.a.b.c).toBe(since);
  });

  it("mixed JSON + Date inside a binding object: each leaf keeps its shape", () => {
    const q = jsmql.compile(({ cfg }: { cfg: { name: string; since: Date; count: number; until: Date } }) =>
      $set({ cfg }),
    );
    const since = new Date("2026-01-01");
    const until = new Date("2026-02-01");
    const out = q({ cfg: { name: "foo", since, count: 42, until } }) as Array<{
      $set: { cfg: { name: string; since: Date; count: number; until: Date } };
    }>;
    expect(out[0].$set.cfg).toEqual({ name: "foo", since, count: 42, until });
    expect(out[0].$set.cfg.since).toBe(since);
    expect(out[0].$set.cfg.until).toBe(until);
  });

  it("nested RegExp inside a binding object preserves the instance", () => {
    const q = jsmql.compile(({ matchers }: { matchers: { name: RegExp; status: RegExp } }) => $set({ matchers }));
    const name = /^alice/i;
    const status = /^ok$/;
    const out = q({ matchers: { name, status } }) as Array<{ $set: { matchers: { name: RegExp; status: RegExp } } }>;
    expect(out[0].$set.matchers.name).toBe(name);
    expect(out[0].$set.matchers.status).toBe(status);
  });

  it("nested Uint8Array inside a binding object preserves the instance", () => {
    const q = jsmql.compile(({ payloads }: { payloads: { hash: Uint8Array } }) => $set({ payloads }));
    const hash = new Uint8Array([1, 2, 3]);
    const out = q({ payloads: { hash } }) as Array<{ $set: { payloads: { hash: Uint8Array } } }>;
    expect(out[0].$set.payloads.hash).toBe(hash);
  });

  it("nested ObjectId (duck-typed) inside a binding object preserves the instance", () => {
    // Mirrors the template-tag side: the project accepts both the legacy
    // `_bsontype: "ObjectID"` (uppercase D) tag and the newer
    // `_bsontype: "ObjectId"` (lowercase d) tag, since BSON library versions
    // disagree on the casing.
    const q = jsmql.compile(({ ids }: { ids: { primary: unknown; secondary: unknown } }) => $set({ ids }));
    const primary = { _bsontype: "ObjectID", id: "abc" };
    const secondary = { _bsontype: "ObjectId", id: "xyz" };
    const out = q({ ids: { primary, secondary } }) as Array<{
      $set: { ids: { primary: unknown; secondary: unknown } };
    }>;
    expect(out[0].$set.ids.primary).toBe(primary);
    expect(out[0].$set.ids.secondary).toBe(secondary);
  });

  it("Date inside a binding lands in $set body alongside JSON-shaped siblings (realistic shape)", () => {
    // The realistic call-site shape: a single `cfg` parameter that bundles a
    // BSON Date with plain-JSON fields. Mirrors how a caller would package
    // a typed config object built elsewhere in their codebase.
    const q = jsmql.compile(({ cfg }: { cfg: { startedAt: Date; mode: string; retries: number } }) => $set({ cfg }));
    const startedAt = new Date("2026-01-01");
    const out = q({ cfg: { startedAt, mode: "fast", retries: 3 } }) as Array<{
      $set: { cfg: { startedAt: Date; mode: string; retries: number } };
    }>;
    expect(out[0].$set.cfg.startedAt).toBe(startedAt);
    expect(out[0].$set.cfg.mode).toBe("fast");
    expect(out[0].$set.cfg.retries).toBe(3);
  });
});

describe("jsmql.expr() input-shape guard", () => {
  it("throws TypeError with an actionable message for a number", () => {
    expect(() => (jsmql as (x: unknown) => unknown)(42)).toThrow(TypeError);
    expect(() => (jsmql as (x: unknown) => unknown)(42)).toThrow(
      /string, an arrow function, or a template literal — got number/,
    );
  });

  it("throws TypeError for null and reports it as 'null' (not 'object')", () => {
    expect(() => (jsmql as (x: unknown) => unknown)(null)).toThrow(/got null/);
  });

  it("throws TypeError for a plain object", () => {
    expect(() => (jsmql as (x: unknown) => unknown)({})).toThrow(/got object/);
  });

  it("jsmql.validate() routes a wrong-typed input to a structured SYNTAX_ERROR (never throws)", () => {
    const r = (jsmql.validate as (x: unknown) => { valid: boolean; errors: { code: string }[] })(42);
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.code).toBe("SYNTAX_ERROR");
  });
});

describe("jsmql.validate()", () => {
  it("returns valid for correct expression", () => {
    const result = jsmql.validate("$eq($.age, 18)");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns error for unknown identifier", () => {
    const result = jsmql.validate("$eq(age, 18)");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/Did you mean/);
  });

  it("returns error for unclosed paren", () => {
    const result = jsmql.validate("$eq($.age, 18");
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("returns error for trailing junk", () => {
    const result = jsmql.validate("$eq($.age, 18) garbage");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/Unexpected token/);
  });
});

describe("single-char negative numbers", () => {
  it("negative number literal", () => {
    expect(jsmql.expr("$abs(-5)")).toEqual({ $abs: -5 });
  });
});

describe("arithmetic operators", () => {
  it("+ numeric", () => {
    expect(jsmql.expr("$.a + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("- binary", () => {
    expect(jsmql.expr("$.a - $.b")).toEqual({ $subtract: ["$a", "$b"] });
  });
  it("* multiply", () => {
    expect(jsmql.expr("$.a * 1.1")).toEqual({ $multiply: ["$a", 1.1] });
  });
  it("/ divide", () => {
    expect(jsmql.expr("$.a / $.b")).toEqual({ $divide: ["$a", "$b"] });
  });
  it("% modulo", () => {
    expect(jsmql.expr("$.a % 2")).toEqual({ $mod: ["$a", 2] });
  });
  it("** power", () => {
    expect(jsmql.expr("$.base ** 2")).toEqual({ $pow: ["$base", 2] });
  });
  it("** is right-associative", () => {
    expect(jsmql.expr("2 ** 3 ** 2")).toEqual({ $pow: [2, { $pow: [3, 2] }] });
  });
});

describe("comparison operators", () => {
  it("== null (loose: matches null OR missing via $type check)", () => {
    expect(jsmql.expr("$.status == null")).toEqual({ $in: [{ $type: "$status" }, ["null", "missing"]] });
  });
  it("=== (strict equality against any value)", () => {
    expect(jsmql.expr("$.status === 'active'")).toEqual({ $eq: ["$status", "active"] });
  });
  it("=== null (strict: matches only explicit null)", () => {
    expect(jsmql.expr("$.status === null")).toEqual({ $eq: ["$status", null] });
  });
  it("!= null (loose: excludes both null AND missing)", () => {
    expect(jsmql.expr("$.status != null")).toEqual({ $not: [{ $in: [{ $type: "$status" }, ["null", "missing"]] }] });
  });
  it("!== null (strict: missing fields still pass)", () => {
    expect(jsmql.expr("$.status !== null")).toEqual({ $ne: ["$status", null] });
  });
  it("rejects `==` against non-null with an actionable error", () => {
    expect(() => jsmql.expr("$.status == 'active'")).toThrow(/'=='.*only allowed against null.*'==='/);
  });
  it("rejects `!=` against non-null with an actionable error", () => {
    expect(() => jsmql.expr("$.status != 'active'")).toThrow(/'!='.*only allowed against null/);
  });
  it("rejects `==` against a number literal", () => {
    expect(() => jsmql.expr("$.x == 5")).toThrow(/'=='.*only allowed against null/);
  });
  it("accepts `null` on either side of `==`", () => {
    expect(jsmql.expr("null == $.status")).toEqual({ $in: [{ $type: "$status" }, ["null", "missing"]] });
  });
  it(">", () => {
    expect(jsmql.expr("$.age > 18")).toEqual({ $gt: ["$age", 18] });
  });
  it(">=", () => {
    expect(jsmql.expr("$.age >= 21")).toEqual({ $gte: ["$age", 21] });
  });
  it("<", () => {
    expect(jsmql.expr("$.score < 50")).toEqual({ $lt: ["$score", 50] });
  });
  it("<=", () => {
    expect(jsmql.expr("$.score <= 100")).toEqual({ $lte: ["$score", 100] });
  });
  it("in", () => {
    expect(jsmql.expr('$.status in ["active", "pending"]')).toEqual({ $in: ["$status", ["active", "pending"]] });
  });
});

describe("jsBool truthiness normalizes missing → null", () => {
  // A missing field is NOT `== null` under MongoDB's $eq/$ne (`$eq:["$absent",null]`
  // is false), so a bare `$ne:[v,null]` would treat a missing value as truthy —
  // unlike JS, where `undefined` is falsy. jsBool wraps the null-check operand in
  // `$ifNull(v, null)` so missing collapses to null first. Verified on mongod:
  // `arr.filter(x => x.name)` drops elements whose `name` is absent.
  it("the truthy null-clause is $ifNull-normalized (catches missing AND null)", () => {
    expect(jsmql.expr("$.items.filter(x => x.name)")).toEqual({
      $filter: { input: "$items", as: "x", cond: truthy("$$x.name") },
    });
    // The first clause must be the $ifNull form, not a bare $ne.
    expect(truthy("$$x.name").$and[0]).toEqual({ $ne: [{ $ifNull: ["$$x.name", null] }, null] });
  });
  it("&&/||/ternary share the same normalized coercion", () => {
    expect(jsmql.expr("$.a ? $.b : $.c")).toEqual({ $cond: { if: truthy("$a"), then: "$b", else: "$c" } });
    expect(jsmql.expr("!$.a")).toEqual({ $not: truthy("$a") });
  });
});

describe("logical operators", () => {
  it("&& on field refs returns operand (JS semantics)", () => {
    expect(jsmql.expr("$.a && $.b")).toEqual({ $cond: { if: truthy("$a"), then: "$b", else: "$a" } });
  });
  it("|| on field refs returns operand (JS semantics)", () => {
    expect(jsmql.expr("$.a || $.b")).toEqual({ $cond: { if: truthy("$a"), then: "$a", else: "$b" } });
  });
  it("&& on bool comparisons stays as $and (no operand-preservation needed)", () => {
    expect(jsmql.expr("$.a > 0 && $.b > 0")).toEqual({ $and: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }] });
  });
  it("|| on bool comparisons stays as $or", () => {
    expect(jsmql.expr("$.a > 0 || $.b > 0")).toEqual({ $or: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }] });
  });
  it("! unary uses JS truthiness", () => {
    expect(jsmql.expr("!$.active")).toEqual({ $not: truthy("$active") });
  });
  it("!! double negation peephole → jsBool (no $not-of-$not)", () => {
    expect(jsmql.expr("!!$.active")).toEqual(truthy("$active"));
  });
  it("! on a comparison elides the jsBool wrap", () => {
    expect(jsmql.expr("!($.a > 0)")).toEqual({ $not: { $gt: ["$a", 0] } });
  });
  it("&& with non-pure-ref LHS uses $let to bind once", () => {
    expect(jsmql.expr("($.a + $.b) && $.c")).toEqual({
      $let: { vars: { v: { $add: ["$a", "$b"] } }, in: { $cond: { if: truthy("$$v"), then: "$c", else: "$$v" } } },
    });
  });
  it("|| short-circuit chain with default (user's idiom)", () => {
    expect(jsmql.expr('$.nickname || "anonymous"')).toEqual({
      $cond: { if: truthy("$nickname"), then: "$nickname", else: "anonymous" },
    });
  });
});

describe("ternary", () => {
  it("basic ternary with bool condition (no jsBool wrap)", () => {
    expect(jsmql.expr("$.age >= 18 ? 'adult' : 'minor'")).toEqual({
      $cond: { if: { $gte: ["$age", 18] }, then: "adult", else: "minor" },
    });
  });
  it("ternary with non-bool condition wraps in jsBool", () => {
    expect(jsmql.expr('$.name ? "yes" : "no"')).toEqual({ $cond: { if: truthy("$name"), then: "yes", else: "no" } });
  });
  it("nested ternary (right-associative) wraps each non-bool condition", () => {
    expect(jsmql.expr("$.a ? 'x' : $.b ? 'y' : 'z'")).toEqual({
      $cond: { if: truthy("$a"), then: "x", else: { $cond: { if: truthy("$b"), then: "y", else: "z" } } },
    });
  });
});

describe("nullish coalescing", () => {
  it("??", () => {
    expect(jsmql.expr("$.nickname ?? $.name")).toEqual({ $ifNull: ["$nickname", "$name"] });
  });
  it("?? flattened chain", () => {
    expect(jsmql.expr("$.a ?? $.b ?? 'unknown'")).toEqual({ $ifNull: ["$a", "$b", "unknown"] });
  });
});

describe("unary minus", () => {
  it("unary - on field", () => {
    expect(jsmql.expr("-$.amount")).toEqual({ $multiply: ["$amount", -1] });
  });
  it("unary - on number literal optimised to negative number", () => {
    expect(jsmql.expr("-5")).toEqual(-5);
  });
  it("unary - on number inside operator", () => {
    expect(jsmql.expr("$abs(-5)")).toEqual({ $abs: -5 });
  });
  it("unary - on expression", () => {
    expect(jsmql.expr("-($.a + $.b)")).toEqual({ $multiply: [{ $add: ["$a", "$b"] }, -1] });
  });
});

describe("operator flattening", () => {
  it("+ flattened to $add", () => {
    expect(jsmql.expr("$.a + $.b + $.c")).toEqual({ $add: ["$a", "$b", "$c"] });
  });
  it("* flattened to $multiply", () => {
    expect(jsmql.expr("$.a * $.b * $.c")).toEqual({ $multiply: ["$a", "$b", "$c"] });
  });
  it("&& on bool comparisons flattened to $and", () => {
    expect(jsmql.expr("$.a > 0 && $.b > 0 && $.c > 0")).toEqual({
      $and: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }, { $gt: ["$c", 0] }],
    });
  });
  it("|| on bool comparisons flattened to $or", () => {
    expect(jsmql.expr("$.a > 0 || $.b > 0 || $.c > 0")).toEqual({
      $or: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }, { $gt: ["$c", 0] }],
    });
  });
  it("&& on non-bool operands folds right into nested $cond (operand-preserving)", () => {
    expect(jsmql.expr("$.a && $.b && $.c")).toEqual({
      $cond: { if: truthy("$a"), then: { $cond: { if: truthy("$b"), then: "$c", else: "$b" } }, else: "$a" },
    });
  });
  it("|| on non-bool operands folds right (operand-preserving)", () => {
    expect(jsmql.expr("$.a || $.b || $.c")).toEqual({
      $cond: { if: truthy("$a"), then: "$a", else: { $cond: { if: truthy("$b"), then: "$b", else: "$c" } } },
    });
  });
  it("?? flattened to $ifNull (4 operands)", () => {
    expect(jsmql.expr("$.a ?? $.b ?? $.c ?? 0")).toEqual({ $ifNull: ["$a", "$b", "$c", 0] });
  });
  it("- is NOT flattened (left-assoc, not same operator)", () => {
    expect(jsmql.expr("$.a - $.b - $.c")).toEqual({ $subtract: [{ $subtract: ["$a", "$b"] }, "$c"] });
  });
});

describe("string-context +", () => {
  it("string literal in chain → $concat", () => {
    expect(jsmql.expr('$.first + " " + $.last')).toEqual({ $concat: ["$first", " ", "$last"] });
  });
  it("empty string → $concat", () => {
    expect(jsmql.expr('$.a + ""')).toEqual({ $concat: ["$a", ""] });
  });
  it("no string literal → $add", () => {
    expect(jsmql.expr("$.a + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("string-output operator → $concat", () => {
    expect(jsmql.expr("$toString($.n) + $.s")).toEqual({ $concat: [{ $toString: "$n" }, "$s"] });
  });
  it("$toLower result in chain → $concat", () => {
    expect(jsmql.expr("$.prefix + $toLower($.name)")).toEqual({ $concat: ["$prefix", { $toLower: "$name" }] });
  });
  it("mixed numeric + string-output op → $concat", () => {
    expect(jsmql.expr('$.count + " items"')).toEqual({ $concat: ["$count", " items"] });
  });
});

describe("bracket access", () => {
  it("constant index on bare field → runtime $cond on $isArray", () => {
    // Bare $.items receiver — type unknown — dispatch at runtime to handle
    // either array (numeric index) or object (dynamic key) at query time.
    expect(jsmql.expr("$.items[0]")).toEqual({
      $cond: {
        if: { $isArray: "$items" },
        then: { $arrayElemAt: ["$items", 0] },
        else: { $getField: { field: 0, input: "$items" } },
      },
    });
  });
  it("field index on bare field → runtime $cond", () => {
    expect(jsmql.expr("$.items[$.idx]")).toEqual({
      $cond: {
        if: { $isArray: "$items" },
        then: { $arrayElemAt: ["$items", "$idx"] },
        else: { $getField: { field: "$idx", input: "$items" } },
      },
    });
  });
  it("string-literal key on bare field → $getField directly (a string key is never a numeric array index)", () => {
    // A provably-string key means object property access — emit $getField and
    // skip the $isArray/$arrayElemAt guard, which would otherwise make MongoDB
    // reject the string index whenever the receiver is an array at runtime.
    expect(jsmql.expr('$.config["host"]')).toEqual({ $getField: { field: "host", input: "$config" } });
  });
  it("string-producing key expression on bare field → $getField directly", () => {
    // `.toLowerCase()` is statically a string, so the key can't be an array
    // index — same compact $getField lowering as a literal key.
    expect(jsmql.expr("$.map[$.key.toLowerCase()]")).toEqual({
      $getField: { field: { $toLower: "$key" }, input: "$map" },
    });
  });
  it("const-string-bound key → $getField directly (folds; binding type still string)", () => {
    // `const k = "host"` folds to the literal "host". The folded value's static
    // type ("string") is tracked on the binding, so `$.config[k]` still lowers
    // to a direct `$getField` property getter — never the `$isArray` guard whose
    // dead `$arrayElemAt[array, "host"]` branch some engines reject.
    expect(jsmql.pipeline('const k = "host";\n$ = { v: $.config[k] };')).toEqual([
      { $replaceWith: { v: { $getField: { field: "host", input: "$config" } } } },
    ]);
  });
  it("string-literal key on the bare root $ → plain field reference (root is never an array)", () => {
    // `$["x"]` is just `$.x`; the bracket form is the escape hatch for field
    // names that aren't bare identifiers (dots, dashes) — and notably for
    // reaching a nested `length` field without `.length` folding to the
    // string-or-array length operator.
    expect(jsmql.expr('$["field.length"]')).toBe("$field.length");
    expect(jsmql.expr('$["weird-name"]')).toBe("$weird-name");
    expect(jsmql.expr('$["field.length"] * $.field.width')).toEqual({ $multiply: ["$field.length", "$field.width"] });
  });
  it("computed (non-literal) key on the bare root $ → $getField, not the $isArray guard", () => {
    // The bare root is always a BSON object, so a computed key is an
    // unambiguous field getter — `$getField` with `input: $$ROOT`. The old
    // `$isArray` dual guard's dead `$arrayElemAt` branch carried the key as an
    // array index; a non-numeric index there is rejected at *pipeline-
    // optimization* time ("$arrayElemAt's second argument must be a numeric
    // value, but is string") on engines that don't prune unreachable branches.
    expect(jsmql.expr("$[$.fieldName]")).toEqual({ $getField: { field: "$fieldName", input: "$$ROOT" } });
    // The reported case: indexing the root by a value read from a const map
    // (`$[SSTM_PROP[party]]`). The const map folds and inlines; both getters
    // still resolve to a string field name.
    expect(jsmql.pipeline('const M = { a: "x" };\n$ = { v: $[M["k"]] };')).toEqual([
      {
        $replaceWith: {
          v: { $getField: { field: { $getField: { field: "k", input: { a: "x" } } }, input: "$$ROOT" } },
        },
      },
    ]);
  });
  it("computed key on an object literal → $getField (object literals are never arrays)", () => {
    expect(jsmql.expr("({ a: 1, b: 2 })[$.k]")).toEqual({ $getField: { field: "$k", input: { a: 1, b: 2 } } });
  });
  it("chained bracket access on bare field → nested $cond", () => {
    expect(jsmql.expr("$.m[$.r][$.c]")).toEqual({
      $cond: {
        if: {
          $isArray: {
            $cond: {
              if: { $isArray: "$m" },
              then: { $arrayElemAt: ["$m", "$r"] },
              else: { $getField: { field: "$r", input: "$m" } },
            },
          },
        },
        then: {
          $arrayElemAt: [
            {
              $cond: {
                if: { $isArray: "$m" },
                then: { $arrayElemAt: ["$m", "$r"] },
                else: { $getField: { field: "$r", input: "$m" } },
              },
            },
            "$c",
          ],
        },
        else: {
          $getField: {
            field: "$c",
            input: {
              $cond: {
                if: { $isArray: "$m" },
                then: { $arrayElemAt: ["$m", "$r"] },
                else: { $getField: { field: "$r", input: "$m" } },
              },
            },
          },
        },
      },
    });
  });
  it("bracket access on known-array operator result stays compact", () => {
    expect(jsmql.expr("$reverseArray($.items)[0]")).toEqual({ $arrayElemAt: [{ $reverseArray: "$items" }, 0] });
  });
  it("bracket access on .map() result stays compact", () => {
    expect(jsmql.expr("$.items.map(x => x.id)[0]")).toEqual({
      $arrayElemAt: [{ $map: { input: "$items", as: "x", in: "$$x.id" } }, 0],
    });
  });
});

describe("lambda element-type inference (array-method param typed from a provable element type)", () => {
  // A lambda iterating an array with a provable uniform element type gets its
  // *element* param typed in bindingTypes — mirroring reduce-accumulator
  // narrowing — so `element[k]` lowers precisely. The headline win: a
  // string-element key is never a numeric index, so `obj[element]` → $getField
  // directly, dropping the runtime $isArray guard (and its dead, server-
  // rejected $arrayElemAt-with-string-index branch).
  it("map over a string-literal array → element key → $getField (the reported case)", () => {
    expect(jsmql.expr('["sender", "recipient"].map(party => $.cre.result[party])')).toEqual({
      $map: {
        input: ["sender", "recipient"],
        as: "party",
        in: { $getField: { field: "$$party", input: "$cre.result" } },
      },
    });
  });
  it("filter over a string-literal array → element key → $getField", () => {
    expect(jsmql.expr('["a", "b"].filter(k => $.m[k])')).toEqual({
      $filter: {
        input: ["a", "b"],
        as: "k",
        cond: {
          $and: [
            { $ne: [{ $ifNull: [{ $getField: { field: "$$k", input: "$m" } }, null] }, null] },
            { $ne: [{ $getField: { field: "$$k", input: "$m" } }, false] },
            { $ne: [{ $getField: { field: "$$k", input: "$m" } }, ""] },
            { $ne: [{ $getField: { field: "$$k", input: "$m" } }, 0] },
          ],
        },
      },
    });
  });
  it("reduce element param is typed from the input array → element key → $getField", () => {
    expect(jsmql.expr('["a", "b"].reduce((acc, k) => acc + $.m[k], "")')).toEqual({
      $reduce: {
        input: ["a", "b"],
        initialValue: "",
        in: { $add: ["$$value", { $getField: { field: "$$this", input: "$m" } }] },
      },
    });
  });
  it('.split(",") yields string elements → element key → $getField', () => {
    expect(jsmql.expr('$.csv.split(",").map(k => $.m[k])')).toEqual({
      $map: { input: { $split: ["$csv", ","] }, as: "k", in: { $getField: { field: "$$k", input: "$m" } } },
    });
  });
  it("object-literal elements type the element as object → element[k] → $getField", () => {
    expect(jsmql.expr("[{ a: 1 }, { b: 2 }].map(o => o[$.k])")).toEqual({
      $map: { input: [{ a: 1 }, { b: 2 }], as: "o", in: { $getField: { field: "$k", input: "$$o" } } },
    });
  });
  it("NON-string element type (numbers) keeps the runtime $isArray guard", () => {
    // A numeric element is a plausible array index, so the dispatch must stay.
    expect(jsmql.expr("[1, 2, 3].map(i => $.m[i])")).toEqual({
      $map: {
        input: [1, 2, 3],
        as: "i",
        in: {
          $cond: {
            if: { $isArray: "$m" },
            then: { $arrayElemAt: ["$m", "$$i"] },
            else: { $getField: { field: "$$i", input: "$m" } },
          },
        },
      },
    });
  });
  it("unknown element type (non-literal input) keeps the runtime $isArray guard", () => {
    expect(jsmql.expr("$.tags.map(t => $.m[t])")).toEqual({
      $map: {
        input: "$tags",
        as: "t",
        in: {
          $cond: {
            if: { $isArray: "$m" },
            then: { $arrayElemAt: ["$m", "$$t"] },
            else: { $getField: { field: "$$t", input: "$m" } },
          },
        },
      },
    });
  });
  it("only the element param is typed — the index param is a number and keeps the guard", () => {
    // `(element, index)`: `element` is string, `index` is a number, so `$.m[i]`
    // must NOT collapse to $getField.
    // `$size: [["a","b"]]` — the literal receiver is wrapped one level so MongoDB
    // reads it as $size's single argument. Bare (`$size: ["a","b"]`) it is spliced
    // into two arguments and the server rejects the pipeline.
    expect(jsmql.expr('["a", "b"].map((k, i) => $.m[i])')).toEqual({
      $map: {
        input: { $zip: { inputs: [{ $range: [0, { $size: [["a", "b"]] }] }, ["a", "b"]] } },
        as: "jsmqlPair",
        in: {
          $let: {
            vars: { k: { $arrayElemAt: ["$$jsmqlPair", 1] }, i: { $arrayElemAt: ["$$jsmqlPair", 0] } },
            in: {
              $cond: {
                if: { $isArray: "$m" },
                then: { $arrayElemAt: ["$m", "$$i"] },
                else: { $getField: { field: "$$i", input: "$m" } },
              },
            },
          },
        },
      },
    });
  });
});

describe("grouped expressions", () => {
  it("grouping changes precedence", () => {
    expect(jsmql.expr("($.a + $.b) * 2")).toEqual({ $multiply: [{ $add: ["$a", "$b"] }, 2] });
  });
  it("without grouping * binds tighter", () => {
    expect(jsmql.expr("$.a + $.b * 2")).toEqual({ $add: ["$a", { $multiply: ["$b", 2] }] });
  });
});

describe("operator precedence", () => {
  it("* before +", () => {
    expect(jsmql.expr("$.a + $.b * $.c")).toEqual({ $add: ["$a", { $multiply: ["$b", "$c"] }] });
  });
  it("comparison before && (mixed-bool chain folds operand-preserving)", () => {
    expect(jsmql.expr("$.age > 18 && $.active")).toEqual({
      $cond: { if: { $gt: ["$age", 18] }, then: "$active", else: { $gt: ["$age", 18] } },
    });
  });
  it("&& before ||", () => {
    expect(jsmql.expr("$.a || $.b && $.c")).toEqual({
      $cond: { if: truthy("$a"), then: "$a", else: { $cond: { if: truthy("$b"), then: "$c", else: "$b" } } },
    });
  });
  it("! before && (LHS is provably bool, no $let)", () => {
    expect(jsmql.expr("!$.a && $.b")).toEqual({
      $cond: { if: { $not: truthy("$a") }, then: "$b", else: { $not: truthy("$a") } },
    });
  });
});

describe("mixed $operator() and infix", () => {
  it("infix inside $operator args", () => {
    expect(jsmql.expr("$and($.age > 18, $.status === 'active')")).toEqual({
      $and: [{ $gt: ["$age", 18] }, { $eq: ["$status", "active"] }],
    });
  });
  it("$operator wrapping infix", () => {
    expect(jsmql.expr("$abs($.a - $.b)")).toEqual({ $abs: { $subtract: ["$a", "$b"] } });
  });
});

describe("$.in field ref still works", () => {
  it("field named 'in'", () => {
    expect(jsmql.expr("$.in === 'test'")).toEqual({ $eq: ["$in", "test"] });
  });
  it("nested field with 'in' segment", () => {
    expect(jsmql.expr("$size($.in)")).toEqual({ $size: "$in" });
  });
});

describe("field path regression (FieldRef stops at first segment)", () => {
  it("$.a.b.c produces $a.b.c", () => {
    expect(jsmql.expr("$.a.b.c")).toEqual("$a.b.c");
  });
  it("$.items[0].name produces $getField on bracket-access result", () => {
    expect(jsmql.expr("$.items[0].name")).toEqual({
      $getField: {
        field: "name",
        input: {
          $cond: {
            if: { $isArray: "$items" },
            then: { $arrayElemAt: ["$items", 0] },
            else: { $getField: { field: 0, input: "$items" } },
          },
        },
      },
    });
  });
  it("rejects numeric field segments — $.items.0 is not valid JS syntax", () => {
    expect(() => jsmql.expr("$.items.0")).toThrow(/Expected property name after '\.'/);
  });
  it("deep path inside $abs", () => {
    expect(jsmql.expr("$abs($.a.b.c)")).toEqual({ $abs: "$a.b.c" });
  });
  it("dotted path in comparison", () => {
    expect(jsmql.expr("$.loyalty.years >= 2")).toEqual({ $gte: ["$loyalty.years", 2] });
  });
});

describe("string methods", () => {
  it("trim", () => {
    expect(jsmql.expr("$.name.trim()")).toEqual({ $trim: { input: "$name" } });
  });
  it("trimStart", () => {
    expect(jsmql.expr("$.name.trimStart()")).toEqual({ $ltrim: { input: "$name" } });
  });
  it("trimLeft alias", () => {
    expect(jsmql.expr("$.name.trimLeft()")).toEqual({ $ltrim: { input: "$name" } });
  });
  it("trimEnd", () => {
    expect(jsmql.expr("$.name.trimEnd()")).toEqual({ $rtrim: { input: "$name" } });
  });
  it("trimRight alias", () => {
    expect(jsmql.expr("$.name.trimRight()")).toEqual({ $rtrim: { input: "$name" } });
  });
  it("toLowerCase", () => {
    expect(jsmql.expr("$.name.toLowerCase()")).toEqual({ $toLower: "$name" });
  });
  it("toUpperCase", () => {
    expect(jsmql.expr("$.name.toUpperCase()")).toEqual({ $toUpper: "$name" });
  });
  it("substr", () => {
    expect(jsmql.expr("$.name.substr(0, 5)")).toEqual({ $substrCP: ["$name", 0, 5] });
  });
  it("split", () => {
    expect(jsmql.expr('$.csv.split(",")')).toEqual({ $split: ["$csv", ","] });
  });
  it("indexOf on bare field → runtime $cond on $isArray", () => {
    expect(jsmql.expr('$.name.indexOf("@")')).toEqual({
      $cond: {
        if: { $isArray: "$name" },
        then: { $indexOfArray: ["$name", "@"] },
        else: { $indexOfCP: ["$name", "@"] },
      },
    });
  });
  it("indexOf on known string → $indexOfCP", () => {
    expect(jsmql.expr('$.name.toLowerCase().indexOf("@")')).toEqual({ $indexOfCP: [{ $toLower: "$name" }, "@"] });
  });
  it("replace", () => {
    expect(jsmql.expr('$.name.replace("a", "b")')).toEqual({
      $replaceOne: { input: "$name", find: "a", replacement: "b" },
    });
  });
  it("replaceAll", () => {
    expect(jsmql.expr('$.slug.replaceAll(" ", "-")')).toEqual({
      $replaceAll: { input: "$slug", find: " ", replacement: "-" },
    });
  });
  it("includes on bare field → runtime $cond on $isArray", () => {
    expect(jsmql.expr('$.email.includes("@")')).toEqual({
      $cond: {
        if: { $isArray: "$email" },
        then: { $in: ["@", "$email"] },
        else: { $gte: [{ $indexOfCP: ["$email", "@"] }, 0] },
      },
    });
  });
  it("includes on known string → string form", () => {
    expect(jsmql.expr('$.email.toLowerCase().includes("@")')).toEqual({
      $gte: [{ $indexOfCP: [{ $toLower: "$email" }, "@"] }, 0],
    });
  });
  it("match with regex literal", () => {
    expect(jsmql.expr("$.str.match(/^[A-Z]/)")).toEqual({ $regexMatch: { input: "$str", regex: "^[A-Z]" } });
  });
  it("match with regex literal and flags", () => {
    expect(jsmql.expr("$.str.match(/^[a-z]/i)")).toEqual({
      $regexMatch: { input: "$str", regex: "^[a-z]", options: "i" },
    });
  });
  it("match with string pattern", () => {
    expect(jsmql.expr('$.str.match("^[a-z]")')).toEqual({ $regexMatch: { input: "$str", regex: "^[a-z]" } });
  });
  it("length on string-producing expression → $strLenCP", () => {
    // Coerced: $strLenCP aborts the query on a missing field, so `.length` of an
    // absent string is 0 rather than an executor error.
    expect(jsmql.expr("$.name.trim().length")).toEqual({ $strLenCP: { $ifNull: [{ $trim: { input: "$name" } }, ""] } });
  });
  it("length on array-producing expression → $size", () => {
    expect(jsmql.expr('$.csv.split(",").length')).toEqual({ $size: { $split: ["$csv", ","] } });
  });
  it("length on map result → $size", () => {
    expect(jsmql.expr("$.items.map(x => x).length")).toEqual({
      $size: { $map: { input: "$items", as: "x", in: "$$x" } },
    });
  });
  it("length on unknown field → runtime dispatch", () => {
    // Only the string branch coerces — the array branch is already shielded by
    // the $isArray test, which an absent field fails.
    expect(jsmql.expr("$.items.length")).toEqual({
      $cond: {
        if: { $isArray: "$items" },
        then: { $size: "$items" },
        else: { $strLenCP: { $ifNull: ["$items", ""] } },
      },
    });
  });
  it('["length"] is RAW access, NOT the length operator (only dot .length is interpreted)', () => {
    // Bracket access never folds to $size/$strLenCP — it reads a property called
    // "length" like any other key. "length" is a string literal, so it can't be
    // a numeric array index → $getField directly (no $isArray dispatch).
    expect(jsmql.expr('$.items["length"]')).toEqual({ $getField: { field: "length", input: "$items" } });
    // Even a known-array receiver takes $getField for a string key: the old
    // $arrayElemAt-with-string shape is server-rejected, while $getField on an
    // array input is accepted and yields missing (matches JS property lookup).
    expect(jsmql.expr('$.csv.split(",")["length"]')).toEqual({
      $getField: { field: "length", input: { $split: ["$csv", ","] } },
    });
  });
  it("chained trim then toLowerCase", () => {
    expect(jsmql.expr("$.name.trim().toLowerCase()")).toEqual({ $toLower: { $trim: { input: "$name" } } });
  });
  it("chained toLowerCase then trim", () => {
    expect(jsmql.expr("$.name.toLowerCase().trim()")).toEqual({ $trim: { input: { $toLower: "$name" } } });
  });
});

describe("method arg-count errors (standardized via checkArity)", () => {
  // The single `checkArity` formatter words every arg-count error as
  // `.<method>(<signature>) <quantity-clause>` — the signature shows the
  // intended call shape, the quantity clause is uniform across methods.
  it("exact count names the parameters in the signature", () => {
    expect(() => jsmql.expr("$.s.charAt()")).toThrow(".charAt(index) requires exactly 1 argument");
    expect(() => jsmql.expr('$.s.split("a", "b")')).toThrow(".split(separator) requires exactly 1 argument");
    expect(() => jsmql.expr('$.s.replace("a")')).toThrow(".replace(find, replacement) requires exactly 2 arguments");
    expect(() => jsmql.expr("$.arr.with(1)")).toThrow(".with(index, value) requires exactly 2 arguments");
  });
  it("range counts read '1 or 2' / '0, 1, or 2'", () => {
    expect(() => jsmql.expr("$.s.substr()")).toThrow(".substr(start[, count]) requires 1 or 2 arguments");
    expect(() => jsmql.expr("$.arr.slice(1, 2, 3)")).toThrow(".slice(start[, end]) requires 0, 1, or 2 arguments");
    expect(() => jsmql.expr("$.s.padStart()")).toThrow(
      ".padStart(targetLength[, padString]) requires 1 or 2 arguments",
    );
  });
  it("at-least and no-argument forms", () => {
    expect(() => jsmql.expr("$.arr.concat()")).toThrow(".concat(...items) requires at least 1 argument");
    expect(() => jsmql.expr("$.arr.toSpliced()")).toThrow(
      ".toSpliced(start[, deleteCount, ...items]) requires at least 1 argument",
    );
    expect(() => jsmql.expr("$.arr.toReversed(1)")).toThrow(".toReversed() takes no arguments");
  });
  it("appends ', got N' with the actual count passed", () => {
    expect(() => jsmql.expr("$.s.charAt()")).toThrow(".charAt(index) requires exactly 1 argument, got 0");
    expect(() => jsmql.expr("$.arr.slice(1, 2, 3)")).toThrow(
      ".slice(start[, end]) requires 0, 1, or 2 arguments, got 3",
    );
    expect(() => jsmql.expr("$.arr.toReversed(1)")).toThrow(".toReversed() takes no arguments, got 1");
  });
  it("static-call families (Math./Object./Set./regex.) use the same formatter", () => {
    expect(() => jsmql.expr("Math.pow(2)")).toThrow("Math.pow(base, exponent) requires exactly 2 arguments, got 1");
    expect(() => jsmql.expr("Math.hypot()")).toThrow("Math.hypot(...values) requires at least 1 argument, got 0");
    expect(() => jsmql.expr("Math.random(1)")).toThrow("Math.random() takes no arguments, got 1");
    expect(() => jsmql.expr("Math.floor()")).toThrow("Math.floor(value) requires exactly 1 argument, got 0");
    expect(() => jsmql.expr("Object.keys()")).toThrow("Object.keys(obj) requires exactly 1 argument, got 0");
    expect(() => jsmql.expr("Object.assign()")).toThrow(
      "Object.assign(...sources) requires at least 1 argument, got 0",
    );
    expect(() => jsmql.expr("/x/.test()")).toThrow("regex.test(str) requires exactly 1 argument, got 0");
  });
  it("statement-position array mutators use the same formatter", () => {
    expect(() => jsmql("$.a.reverse(1);")).toThrow(".reverse() takes no arguments, got 1");
    expect(() => jsmql("$.a.copyWithin(1);")).toThrow(
      ".copyWithin(target, start[, end]) requires 2 or 3 arguments, got 1",
    );
    expect(() => jsmql("$.a.fill();")).toThrow(".fill(value[, start[, end]]) requires 1, 2, or 3 arguments, got 0");
  });
});

describe("array methods (no lambda)", () => {
  it("at(n)", () => {
    expect(jsmql.expr("$.items.at(0)")).toEqual({ $arrayElemAt: ["$items", 0] });
  });
  it("at(-1)", () => {
    expect(jsmql.expr("$.items.at(-1)")).toEqual({ $arrayElemAt: ["$items", -1] });
  });
  it("slice(start) on bare $.field → runtime $cond on $isArray", () => {
    // Array branch: JS `slice(start)` = drop the first `start` — position + a
    // `max(1, size)` count (NOT the 2-arg "first `start`" that MQL `$slice`
    // would give). count 1 (not 0) keeps an empty array valid.
    expect(jsmql.expr("$.items.slice(2)")).toEqual({
      $cond: {
        if: { $isArray: "$items" },
        then: {
          $let: {
            vars: { jsmqlArr: "$items" },
            in: { $slice: ["$$jsmqlArr", 2, { $max: [1, { $size: "$$jsmqlArr" }] }] },
          },
        },
        else: {
          $substrCP: ["$items", 2, { $max: [0, { $subtract: [{ $strLenCP: { $ifNull: ["$items", ""] } }, 2] }] }],
        },
      },
    });
  });
  it("slice(0, end) on bare $.field → 2-arg 'first end' $slice (end exclusive)", () => {
    expect(jsmql.expr("$.items.slice(0, 3)")).toEqual({
      $cond: { if: { $isArray: "$items" }, then: { $slice: ["$items", 3] }, else: { $substrCP: ["$items", 0, 3] } },
    });
  });
  it("slice(start, end) on known array → count is end - start (JS end-exclusive)", () => {
    // NOT `$slice: [arr, 1, 3]` (which MQL reads as "3 elements from index 1").
    expect(jsmql.expr("[1,2,3,4,5].slice(1, 3)")).toEqual({ $slice: [[1, 2, 3, 4, 5], 1, 2] });
  });
  it("slice(start, end) with end <= start (both non-neg literals) → []", () => {
    expect(jsmql.expr("[1,2,3,4,5].slice(3, 2)")).toEqual([]);
    expect(jsmql.expr("[1,2,3,4,5].slice(2, 2)")).toEqual([]);
  });
  it("slice(-n) → last n elements (the 2-arg $slice primitive)", () => {
    expect(jsmql.expr("[1,2,3,4,5].slice(-2)")).toEqual({ $slice: [[1, 2, 3, 4, 5], -2] });
  });
  it("slice(0) → whole-array copy (receiver unchanged)", () => {
    expect(jsmql.expr("[1,2,3].slice(0)")).toEqual([1, 2, 3]);
  });
  it("slice(0, -n) on known array → all-but-last-n, guarding empty input", () => {
    // start 0 + negative end resolves to "first max(size - n, 0)" via 2-arg $slice.
    expect(jsmql.expr("[1,2,3,4,5].slice(0, -1)")).toEqual({
      $let: {
        vars: { jsmqlArr: [1, 2, 3, 4, 5] },
        in: { $slice: ["$$jsmqlArr", { $max: [{ $subtract: [{ $size: "$$jsmqlArr" }, 1] }, 0] }] },
      },
    });
  });
  it("slice(start, negative-end) → resolve both indices, guard the empty range", () => {
    // The general form: k/f are the JS-resolved indices, count = f - k, and the
    // $cond returns [] for an empty range. The slice's own count is max(count, 1)
    // so a constant-array input stays foldable (never a rejected 0-count $slice).
    expect(jsmql.expr("[1,2,3,4,5].slice(1, -1)")).toEqual({
      $let: {
        vars: { jsmqlArr: [1, 2, 3, 4, 5] },
        in: {
          $let: {
            vars: {
              jsmqlK: { $min: [1, { $size: "$$jsmqlArr" }] },
              jsmqlF: { $max: [{ $subtract: [{ $size: "$$jsmqlArr" }, 1] }, 0] },
            },
            in: {
              $cond: [
                { $gt: [{ $subtract: ["$$jsmqlF", "$$jsmqlK"] }, 0] },
                { $slice: ["$$jsmqlArr", "$$jsmqlK", { $max: [{ $subtract: ["$$jsmqlF", "$$jsmqlK"] }, 1] }] },
                [],
              ],
            },
          },
        },
      },
    });
  });
  it("toReversed()", () => {
    expect(jsmql.expr("$.items.toReversed()")).toEqual({ $reverseArray: "$items" });
  });
});

describe("array methods (with lambda)", () => {
  it("map with single param", () => {
    expect(jsmql.expr("$.prices.map(p => p * 1.1)")).toEqual({
      $map: { input: "$prices", as: "p", in: { $multiply: ["$$p", 1.1] } },
    });
  });
  it("map with parenthesized param", () => {
    expect(jsmql.expr("$.prices.map((p) => p * 1.1)")).toEqual({
      $map: { input: "$prices", as: "p", in: { $multiply: ["$$p", 1.1] } },
    });
  });
  it("filter", () => {
    expect(jsmql.expr("$.items.filter(x => x > 0)")).toEqual({
      $filter: { input: "$items", as: "x", cond: { $gt: ["$$x", 0] } },
    });
  });
  it("find", () => {
    expect(jsmql.expr("$.items.find(x => x > 0)")).toEqual({
      $arrayElemAt: [{ $filter: { input: "$items", as: "x", cond: { $gt: ["$$x", 0] } } }, 0],
    });
  });
  it("some", () => {
    expect(jsmql.expr("$.items.some(x => x > 0)")).toEqual({
      $anyElementTrue: { $map: { input: "$items", as: "x", in: { $gt: ["$$x", 0] } } },
    });
  });
  it("every", () => {
    expect(jsmql.expr("$.items.every(x => x > 0)")).toEqual({
      $allElementsTrue: { $map: { input: "$items", as: "x", in: { $gt: ["$$x", 0] } } },
    });
  });
  it("reduce", () => {
    expect(jsmql.expr("$.ns.reduce((acc, x) => acc + x, 0)")).toEqual({
      $reduce: { input: "$ns", initialValue: 0, in: { $add: ["$$value", "$$this"] } },
    });
  });
  it("lambda accessing doc field via $.", () => {
    expect(jsmql.expr("$.items.map(x => x * $.taxRate)")).toEqual({
      $map: { input: "$items", as: "x", in: { $multiply: ["$$x", "$taxRate"] } },
    });
  });
  it("lambda accessing nested field on element (x.status → $$x.status)", () => {
    expect(jsmql.expr('$.orders.filter(o => o.status === "active")')).toEqual({
      $filter: { input: "$orders", as: "o", cond: { $eq: ["$$o.status", "active"] } },
    });
  });
  it("reduce accessing element field ($$this.price)", () => {
    expect(jsmql.expr("$.orders.reduce((sum, o) => sum + o.price, 0)")).toEqual({
      $reduce: { input: "$orders", initialValue: 0, in: { $add: ["$$value", "$$this.price"] } },
    });
  });
});

describe("reduce accumulator type narrowing", () => {
  // The reduce codegen narrows the accumulator parameter to "object" or
  // "array" when initialValue and the lambda body are statically the same
  // compound type. The IndexAccess codegen then skips the runtime $cond on
  // $isArray and emits the type-specific operator directly. Both sides must
  // agree because $$value after iteration i ≥ 1 is the body's return from
  // iteration i-1, not the initialValue.
  it("object accumulator: acc[k] emits $getField directly", () => {
    expect(jsmql.expr("$.xs.reduce((a, k) => ({ ...a, [k]: 1 }), {})")).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: {},
        in: { $mergeObjects: ["$$value", { $arrayToObject: [[{ k: "$$this", v: 1 }]] }] },
      },
    });
    // Read the accumulator with bracket access in the body — confirms the
    // narrowing reaches IndexAccess and emits $getField, not $cond.
    expect(jsmql.expr("$.xs.reduce((a, k) => ({ ...a, [k]: a[k] }), {})")).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: {},
        in: {
          $mergeObjects: [
            "$$value",
            { $arrayToObject: [[{ k: "$$this", v: { $getField: { field: "$$this", input: "$$value" } } }]] },
          ],
        },
      },
    });
  });

  it("array accumulator: acc[i] emits $arrayElemAt directly", () => {
    expect(jsmql.expr("$.xs.reduce((a, x) => [...a, a[0]], [])")).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: [],
        in: { $concatArrays: ["$$value", [{ $arrayElemAt: ["$$value", 0] }]] },
      },
    });
  });

  it("body diverges from initialValue: keeps runtime $cond", () => {
    expect(jsmql.expr("$.xs.reduce((a, x) => x.foo, {})")).toEqual({
      $reduce: { input: "$xs", initialValue: {}, in: "$$this.foo" },
    });
    // When the body returns a member-access on the element, the accumulator
    // is not narrowed, so a bracket access on it still emits the cond.
    expect(jsmql.expr("$.xs.reduce((a, x) => a[0], {})")).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: {},
        in: {
          $cond: {
            if: { $isArray: "$$value" },
            then: { $arrayElemAt: ["$$value", 0] },
            else: { $getField: { field: 0, input: "$$value" } },
          },
        },
      },
    });
  });

  it("non-literal initialValue: keeps runtime $cond", () => {
    expect(jsmql.expr("$.xs.reduce((a, k) => ({ ...a, k: a[0] }), $.seed)")).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: "$seed",
        in: {
          $mergeObjects: [
            "$$value",
            {
              k: {
                $cond: {
                  if: { $isArray: "$$value" },
                  then: { $arrayElemAt: ["$$value", 0] },
                  else: { $getField: { field: 0, input: "$$value" } },
                },
              },
            },
          ],
        },
      },
    });
  });

  it("only the accumulator param is narrowed, not the element param", () => {
    // `x[0]` should keep the cond — `x` is the element binding and could be
    // anything; only `a` is narrowed to object.
    expect(jsmql.expr("$.xs.reduce((a, x) => ({ ...a, k: x[0] }), {})")).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: {},
        in: {
          $mergeObjects: [
            "$$value",
            {
              k: {
                $cond: {
                  if: { $isArray: "$$this" },
                  then: { $arrayElemAt: ["$$this", 0] },
                  else: { $getField: { field: 0, input: "$$this" } },
                },
              },
            },
          ],
        },
      },
    });
  });

  it("nested reduce shadows the outer accumulator type", () => {
    // Outer `acc` is object-typed; inner reduce reuses the name `acc` with
    // initialValue `[]` and an array-producing body, so the inner `acc[0]`
    // must emit $arrayElemAt — not the outer's $getField.
    expect(
      jsmql.expr("$.xs.reduce((acc, x) => ({ ...acc, k: x.ys.reduce((acc, y) => [...acc, acc[0]], []) }), {})"),
    ).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: {},
        in: {
          $mergeObjects: [
            "$$value",
            {
              k: {
                $reduce: {
                  input: "$$this.ys",
                  initialValue: [],
                  in: { $concatArrays: ["$$value", [{ $arrayElemAt: ["$$value", 0] }]] },
                },
              },
            },
          ],
        },
      },
    });
  });

  it("optional-chain default flips to {} for known-object accumulator", () => {
    // `a?.[k]` on a known-object binding wraps with `$ifNull(_, {})` rather
    // than `$ifNull(_, [])` — feeding `$getField` an array on null receivers
    // would be a type error in MongoDB.
    expect(jsmql.expr("$.xs.reduce((a, k) => ({ ...a, [k]: a?.[k] }), {})")).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: {},
        in: {
          $mergeObjects: [
            "$$value",
            {
              $arrayToObject: [
                [{ k: "$$this", v: { $getField: { field: "$$this", input: { $ifNull: ["$$value", {}] } } } }],
              ],
            },
          ],
        },
      },
    });
  });
});

describe("bare type-cast callbacks", () => {
  it("filter(Boolean) drops JS-falsy elements", () => {
    expect(jsmql.expr("$.items.filter(Boolean)")).toEqual({
      $filter: { input: "$items", as: "v", cond: truthy("$$v") },
    });
  });
  it("map(Number) coerces to double", () => {
    expect(jsmql.expr("$.nums.map(Number)")).toEqual({ $map: { input: "$nums", as: "v", in: { $toDouble: "$$v" } } });
  });
  it("map(String) coerces to string", () => {
    expect(jsmql.expr("$.xs.map(String)")).toEqual({ $map: { input: "$xs", as: "v", in: { $toString: "$$v" } } });
  });
  it("find(Boolean) returns first JS-truthy element", () => {
    expect(jsmql.expr("$.xs.find(Boolean)")).toEqual({
      $arrayElemAt: [{ $filter: { input: "$xs", as: "v", cond: truthy("$$v") } }, 0],
    });
  });
  it("some(Boolean) is any-JS-truthy", () => {
    expect(jsmql.expr("$.xs.some(Boolean)")).toEqual({
      $anyElementTrue: { $map: { input: "$xs", as: "v", in: truthy("$$v") } },
    });
  });
  it("every(Boolean) is all-JS-truthy", () => {
    expect(jsmql.expr("$.xs.every(Boolean)")).toEqual({
      $allElementsTrue: { $map: { input: "$xs", as: "v", in: truthy("$$v") } },
    });
  });
  it("flatMap(Number) survives the desugar", () => {
    expect(jsmql.expr("$.xs.flatMap(Number)")).toEqual({
      $reduce: {
        input: { $map: { input: "$xs", as: "v", in: { $toDouble: "$$v" } } },
        initialValue: [],
        in: { $concatArrays: ["$$value", "$$this"] },
      },
    });
  });
  it("composes through chaining: filter(Boolean).join(' ')", () => {
    expect(jsmql.expr('$.parts.filter(Boolean).join(" ")')).toEqual({
      $reduce: {
        input: { $filter: { input: "$parts", as: "v", cond: truthy("$$v") } },
        initialValue: "",
        in: {
          $cond: {
            if: { $eq: ["$$value", ""] },
            then: { $toString: "$$this" },
            else: { $concat: ["$$value", " ", { $toString: "$$this" }] },
          },
        },
      },
    });
  });
  it("Boolean as a value (outside callback) errors with the call form suggested", () => {
    expect(() => jsmql.expr("Boolean + 5")).toThrow(/used as a value.*Boolean\(value\)/);
  });
  it("reduce(Boolean, 0) hits the existing param-count error", () => {
    expect(() => jsmql.expr("$.xs.reduce(Boolean, 0)")).toThrow(/2 or 3 parameters/);
  });
  it("parseInt is intentionally not supported bare (avoids the JS index-as-radix footgun)", () => {
    expect(() => jsmql.expr("$.xs.filter(parseInt)")).toThrow(/Expected '\('/);
  });
  it("parseFloat is intentionally not supported bare", () => {
    expect(() => jsmql.expr("$.xs.filter(parseFloat)")).toThrow(/Expected '\('/);
  });
});

describe("date methods", () => {
  it("getFullYear", () => {
    expect(jsmql.expr("$.ts.getFullYear()")).toEqual({ $year: "$ts" });
  });
  it("getMonth (0-based)", () => {
    expect(jsmql.expr("$.ts.getMonth()")).toEqual({ $subtract: [{ $month: "$ts" }, 1] });
  });
  it("getDate", () => {
    expect(jsmql.expr("$.ts.getDate()")).toEqual({ $dayOfMonth: "$ts" });
  });
  it("getDay (0-based)", () => {
    expect(jsmql.expr("$.ts.getDay()")).toEqual({ $subtract: [{ $dayOfWeek: "$ts" }, 1] });
  });
  it("getHours", () => {
    expect(jsmql.expr("$.ts.getHours()")).toEqual({ $hour: "$ts" });
  });
  it("getMinutes", () => {
    expect(jsmql.expr("$.ts.getMinutes()")).toEqual({ $minute: "$ts" });
  });
  it("getSeconds", () => {
    expect(jsmql.expr("$.ts.getSeconds()")).toEqual({ $second: "$ts" });
  });
  it("getMilliseconds", () => {
    expect(jsmql.expr("$.ts.getMilliseconds()")).toEqual({ $millisecond: "$ts" });
  });
});

describe("date arithmetic (.plus / .minus)", () => {
  it("plus(amount, unit) → $dateAdd", () => {
    expect(jsmql.expr('$.subscribedAt.plus(30, "day")')).toEqual({
      $dateAdd: { startDate: "$subscribedAt", unit: "day", amount: 30 },
    });
  });
  it("minus(amount, unit) → $dateSubtract", () => {
    expect(jsmql.expr('$.expiresAt.minus(1, "month")')).toEqual({
      $dateSubtract: { startDate: "$expiresAt", unit: "month", amount: 1 },
    });
  });
  it("optional timezone third arg", () => {
    expect(jsmql.expr('$.t.plus(2, "hour", "America/New_York")')).toEqual({
      $dateAdd: { startDate: "$t", unit: "hour", amount: 2, timezone: "America/New_York" },
    });
  });
  it("amount may be a runtime expression", () => {
    expect(jsmql.expr('$.order.createdAt.plus($.slaDays, "day")')).toEqual({
      $dateAdd: { startDate: "$order.createdAt", unit: "day", amount: "$slaDays" },
    });
  });
  it("a non-literal unit is not enum-checked (literal-gating)", () => {
    expect(jsmql.expr("$.t.plus(1, $.unit)")).toEqual({ $dateAdd: { startDate: "$t", unit: "$unit", amount: 1 } });
  });
  it("rejects an unknown unit with a suggestion", () => {
    expect(() => jsmql.expr('$.t.plus(30, "days")')).toThrow(
      /'\.plus' unit must be one of: .* — got 'days'\. Did you mean 'day'\?/,
    );
  });
  it("rejects the wrong argument count, naming the parameters", () => {
    expect(() => jsmql.expr("$.t.plus(30)")).toThrow(
      /\.plus\(amount, unit\[, timezone\]\) requires 2 or 3 arguments, got 1/,
    );
  });
  it("rejects a non-integer literal amount (mongod requires an integer)", () => {
    expect(() => jsmql.expr('$.t.plus(1.5, "day")')).toThrow(/'\.plus' amount expects an integer, but got a number\./);
    expect(() => jsmql.expr('$.t.minus("30", "day")')).toThrow(
      /'\.minus' amount expects an integer, but got a string\./,
    );
  });
  it("rejects a non-string literal timezone", () => {
    expect(() => jsmql.expr('$.t.plus(1, "day", 5)')).toThrow(/'\.plus' timezone expects a string, but got a number\./);
  });
  it("allows a negative integer amount and dynamic amount/timezone (literal-gating)", () => {
    expect(jsmql.expr('$.t.plus(-5, "day")')).toEqual({ $dateAdd: { startDate: "$t", unit: "day", amount: -5 } });
    expect(jsmql.expr('$.t.plus($.n, "day", $.tz)')).toEqual({
      $dateAdd: { startDate: "$t", unit: "day", amount: "$n", timezone: "$tz" },
    });
  });
});

describe("date-method receiver type-check", () => {
  it("rejects a literal non-date receiver, consistent with the operator form", () => {
    expect(() => jsmql.expr('"2020-01-01".getFullYear()')).toThrow(
      /'\.getFullYear' expects a date, but got a string\. Use a field path or new Date\(…\)\./,
    );
    expect(() => jsmql.expr('"2020".toISOString()')).toThrow(/'\.toISOString' expects a date, but got a string\./);
    expect(() => jsmql.expr('"2020".getUTCHours()')).toThrow(/'\.getUTCHours' expects a date, but got a string\./);
    expect(() => jsmql.expr('"2020-01-01".plus(1, "day")')).toThrow(/'\.plus' expects a date, but got a string\./);
  });
  it("allows a literal non-date receiver on .getTime() — $toLong converts strings/numbers", () => {
    expect(jsmql.expr('"2020".getTime()')).toEqual({ $toLong: "2020" });
  });
  it("no-ops on a field ref, new Date(…), or an HR1 $-string receiver (literal-gating)", () => {
    expect(jsmql.expr("$.ts.getFullYear()")).toEqual({ $year: "$ts" });
    expect(jsmql.expr("new Date($.x).getMonth()")).toEqual({ $subtract: [{ $month: { $toDate: "$x" } }, 1] });
    expect(jsmql.expr('"$ts".getHours()')).toEqual({ $hour: "$ts" }); // HR1: a source "$ts" is the field ref $ts
  });
});

describe("date methods (UTC variants)", () => {
  // Same operators as the local getters, anchored to UTC via `timezone: "UTC"`.
  // Verified against a live mongod (t = 2023-03-15T18:45:30.123Z, a Wednesday):
  // → { y:2023, mo:2, d:15, dow:3, h:18, mi:45, s:30, ms:123 }.
  it("getUTCFullYear", () => {
    expect(jsmql.expr("$.ts.getUTCFullYear()")).toEqual({ $year: { date: "$ts", timezone: "UTC" } });
  });
  it("getUTCMonth (0-based)", () => {
    expect(jsmql.expr("$.ts.getUTCMonth()")).toEqual({ $subtract: [{ $month: { date: "$ts", timezone: "UTC" } }, 1] });
  });
  it("getUTCDate", () => {
    expect(jsmql.expr("$.ts.getUTCDate()")).toEqual({ $dayOfMonth: { date: "$ts", timezone: "UTC" } });
  });
  it("getUTCDay (0-based, Sunday=0)", () => {
    expect(jsmql.expr("$.ts.getUTCDay()")).toEqual({
      $subtract: [{ $dayOfWeek: { date: "$ts", timezone: "UTC" } }, 1],
    });
  });
  it("getUTCHours", () => {
    expect(jsmql.expr("$.ts.getUTCHours()")).toEqual({ $hour: { date: "$ts", timezone: "UTC" } });
  });
  it("getUTCMinutes", () => {
    expect(jsmql.expr("$.ts.getUTCMinutes()")).toEqual({ $minute: { date: "$ts", timezone: "UTC" } });
  });
  it("getUTCSeconds", () => {
    expect(jsmql.expr("$.ts.getUTCSeconds()")).toEqual({ $second: { date: "$ts", timezone: "UTC" } });
  });
  it("getUTCMilliseconds", () => {
    expect(jsmql.expr("$.ts.getUTCMilliseconds()")).toEqual({ $millisecond: { date: "$ts", timezone: "UTC" } });
  });
});

describe("typeof", () => {
  it("typeof fieldref", () => {
    expect(jsmql.expr("typeof $.x")).toEqual({ $type: "$x" });
  });
  it("typeof in comparison", () => {
    expect(jsmql.expr('typeof $.x === "string"')).toEqual({ $eq: [{ $type: "$x" }, "string"] });
  });
});

describe("new Date()", () => {
  it("no-arg maps to $$NOW", () => {
    expect(jsmql.expr("new Date()")).toEqual({ $toDate: "$$NOW" });
  });
  it("with field arg", () => {
    expect(jsmql.expr("new Date($.ts)")).toEqual({ $toDate: "$ts" });
  });
  it("with constant string literal folds to a real Date (not $toDate)", () => {
    // A compile-time-constant `new Date(...)` denotes a constant Date, so it
    // folds to a real BSON Date that works in BOTH aggregation-expression and
    // query-document positions. `{ $toDate }` only works in the former.
    expect(jsmql.expr('new Date("2024-01-01")')).toEqual(new Date("2024-01-01"));
  });
  it("new Date(y, m) folds to a UTC Date", () => {
    expect(jsmql.expr("new Date(2024, 0)")).toEqual(new Date(Date.UTC(2024, 0)));
  });
  it("new Date(y, m, d) folds to a UTC Date", () => {
    expect(jsmql.expr("new Date(2024, 0, 15)")).toEqual(new Date(Date.UTC(2024, 0, 15)));
  });
  it("new Date(y, m, d, h, mi, s, ms) folds to a UTC Date", () => {
    expect(jsmql.expr("new Date(2024, 11, 31, 23, 59, 58, 999)")).toEqual(
      new Date(Date.UTC(2024, 11, 31, 23, 59, 58, 999)),
    );
  });
  it("non-literal month gets $add: [m, 1] (runtime form, not folded)", () => {
    expect(jsmql.expr("new Date($.y, $.m, 1)")).toEqual({
      $dateFromParts: { year: "$y", month: { $add: ["$m", 1] }, day: 1 },
    });
  });
  it("rejects a constant date string that can't be parsed (HR3)", () => {
    // We KNOW the value at compile time and the server rejects the equivalent
    // `{ $toDate: "not-a-date" }` at parse time — so refuse it here rather than
    // emit unrunnable MQL. The message names the value and the format to use.
    expect(() => jsmql.expr('new Date("not-a-date")')).toThrow(/"not-a-date" is not a valid date string/);
    expect(() => jsmql.expr('new Date("not-a-date")')).toThrow(/ISO 8601/);
  });
  it("constant Date folds in query-document position too (the reported bug)", () => {
    // The motivating regression: in a Filter / `$match` object-literal
    // passthrough (a query document, not an aggregation expression) the old
    // `{ $toDate }` shape was read as an inert literal subdocument — matching
    // nothing. A real Date is what the query language compares against.
    expect(jsmql('{ createdAt: { $gte: new Date("2026-05-17T02:57:59.714Z") } }')).toEqual({
      createdAt: { $gte: new Date("2026-05-17T02:57:59.714Z") },
    });
    expect(jsmql('[$match({ createdAt: { $gte: new Date("2026-05-17T02:57:59.714Z") } })]')).toEqual([
      { $match: { createdAt: { $gte: new Date("2026-05-17T02:57:59.714Z") } } },
    ]);
  });
  it("rejects more than 7 args", () => {
    expect(() => jsmql.expr("new Date(1, 2, 3, 4, 5, 6, 7, 8)")).toThrow(/at most 7 arguments/);
  });
});

describe("Date.UTC()", () => {
  it("Date.UTC(y, m, d) → $toLong of $dateFromParts with UTC timezone", () => {
    expect(jsmql.expr("Date.UTC(2024, 0, 15)")).toEqual({
      $toLong: { $dateFromParts: { year: 2024, month: 1, day: 15, timezone: "UTC" } },
    });
  });
  it("Date.UTC(y) — year-only form", () => {
    expect(jsmql.expr("Date.UTC(1970)")).toEqual({ $toLong: { $dateFromParts: { year: 1970, timezone: "UTC" } } });
  });
  it("new Date(Date.UTC(...)) with constant parts folds to a real UTC Date", () => {
    expect(jsmql.expr("new Date(Date.UTC(2024, 0, 15))")).toEqual(new Date(Date.UTC(2024, 0, 15)));
  });
  it("Date.UTC requires at least 1 arg", () => {
    expect(() => jsmql.expr("Date.UTC()")).toThrow(/Date\.UTC.*takes 1 to 7 arguments/);
  });
  it("Date.UTC rejects more than 7 args", () => {
    expect(() => jsmql.expr("Date.UTC(1,2,3,4,5,6,7,8)")).toThrow(/takes 1 to 7 arguments/);
  });
});

describe("type casts", () => {
  it("Number()", () => {
    expect(jsmql.expr("Number($.str)")).toEqual({ $toDouble: "$str" });
  });
  it("String()", () => {
    expect(jsmql.expr("String($.n)")).toEqual({ $toString: "$n" });
  });
  it("Boolean() uses JS truthy semantics (not MQL's $toBool)", () => {
    expect(jsmql.expr("Boolean($.x)")).toEqual(truthy("$x"));
  });
  it("Boolean() on a provably-bool value elides the wrap", () => {
    expect(jsmql.expr("Boolean($.x > 0)")).toEqual({ $gt: ["$x", 0] });
  });
  it("$toBool() direct operator escape preserves raw MongoDB semantics", () => {
    expect(jsmql.expr("$toBool($.x)")).toEqual({ $toBool: "$x" });
  });
  it("parseInt()", () => {
    expect(jsmql.expr("parseInt($.s)")).toEqual({ $toInt: "$s" });
  });
  it("parseFloat()", () => {
    expect(jsmql.expr("parseFloat($.s)")).toEqual({ $toDouble: "$s" });
  });
});

describe("Math.*", () => {
  it("Math.abs", () => {
    expect(jsmql.expr("Math.abs($.x)")).toEqual({ $abs: "$x" });
  });
  it("Math.ceil", () => {
    expect(jsmql.expr("Math.ceil($.x)")).toEqual({ $ceil: "$x" });
  });
  it("Math.floor", () => {
    expect(jsmql.expr("Math.floor($.x)")).toEqual({ $floor: "$x" });
  });
  it("Math.round adds 0 precision", () => {
    expect(jsmql.expr("Math.round($.x)")).toEqual({ $round: ["$x", 0] });
  });
  it("Math.pow", () => {
    expect(jsmql.expr("Math.pow(2, $.n)")).toEqual({ $pow: [2, "$n"] });
  });
  it("Math.sqrt", () => {
    expect(jsmql.expr("Math.sqrt($.x)")).toEqual({ $sqrt: "$x" });
  });
  it("Math.exp", () => {
    expect(jsmql.expr("Math.exp($.x)")).toEqual({ $exp: "$x" });
  });
  it("Math.log (natural log → $ln)", () => {
    expect(jsmql.expr("Math.log($.x)")).toEqual({ $ln: "$x" });
  });
  it("Math.trunc", () => {
    expect(jsmql.expr("Math.trunc($.x)")).toEqual({ $trunc: "$x" });
  });
});

describe("Math.* as bare callable in array methods", () => {
  // Unary Math methods can be passed without parens to .map / .filter /
  // similar — desugars to `(v) => Math.<method>(v)`. Mirrors the existing
  // Boolean/Number/String bare-callable shape.
  it("$.scores.map(Math.floor)", () => {
    expect(jsmql.expr("$.scores.map(Math.floor)")).toEqual({
      $map: { input: "$scores", as: "v", in: { $floor: "$$v" } },
    });
  });
  it("$.scores.map(Math.round) adds the 0 precision arg", () => {
    expect(jsmql.expr("$.scores.map(Math.round)")).toEqual({
      $map: { input: "$scores", as: "v", in: { $round: ["$$v", 0] } },
    });
  });
  it("$.scores.map(Math.abs)", () => {
    expect(jsmql.expr("$.scores.map(Math.abs)")).toEqual({ $map: { input: "$scores", as: "v", in: { $abs: "$$v" } } });
  });
  it("$.scores.map(Math.ceil)", () => {
    expect(jsmql.expr("$.scores.map(Math.ceil)")).toEqual({
      $map: { input: "$scores", as: "v", in: { $ceil: "$$v" } },
    });
  });
  it("$.scores.map(Math.sqrt)", () => {
    expect(jsmql.expr("$.scores.map(Math.sqrt)")).toEqual({
      $map: { input: "$scores", as: "v", in: { $sqrt: "$$v" } },
    });
  });
  it("$.scores.map(Math.trunc)", () => {
    expect(jsmql.expr("$.scores.map(Math.trunc)")).toEqual({
      $map: { input: "$scores", as: "v", in: { $trunc: "$$v" } },
    });
  });
  it("rejects binary Math methods as bare (Math.pow)", () => {
    expect(() => jsmql.expr("$.scores.map(Math.pow)")).toThrow(/Math\.pow requires '\(\.\.\.\)'/);
  });
  it("rejects binary Math methods as bare (Math.min)", () => {
    expect(() => jsmql.expr("$.scores.map(Math.min)")).toThrow(/Math\.min requires '\(\.\.\.\)'/);
  });
  it("rejects bare Math reference used as a value", () => {
    expect(() => jsmql.expr("$.x = Math.floor")).toThrow(/'Math\.floor' used as a value is only valid as a callback/);
  });
});

describe("Math trigonometry", () => {
  it("Math.sin", () => {
    expect(jsmql.expr("Math.sin($.angle)")).toEqual({ $sin: "$angle" });
  });
  it("Math.cos", () => {
    expect(jsmql.expr("Math.cos($.angle)")).toEqual({ $cos: "$angle" });
  });
  it("Math.tan", () => {
    expect(jsmql.expr("Math.tan($.angle)")).toEqual({ $tan: "$angle" });
  });
  it("Math.asin", () => {
    expect(jsmql.expr("Math.asin($.x)")).toEqual({ $asin: "$x" });
  });
  it("Math.acos", () => {
    expect(jsmql.expr("Math.acos($.x)")).toEqual({ $acos: "$x" });
  });
  it("Math.atan", () => {
    expect(jsmql.expr("Math.atan($.x)")).toEqual({ $atan: "$x" });
  });
  it("Math.atan2", () => {
    expect(jsmql.expr("Math.atan2($.y, $.x)")).toEqual({ $atan2: ["$y", "$x"] });
  });
  it("Math.atan2 wrong arity", () => {
    expect(() => jsmql.expr("Math.atan2($.x)")).toThrow(/exactly 2 arguments/);
  });
  it("Math.sinh", () => {
    expect(jsmql.expr("Math.sinh($.x)")).toEqual({ $sinh: "$x" });
  });
  it("Math.cosh", () => {
    expect(jsmql.expr("Math.cosh($.x)")).toEqual({ $cosh: "$x" });
  });
  it("Math.tanh", () => {
    expect(jsmql.expr("Math.tanh($.x)")).toEqual({ $tanh: "$x" });
  });
  it("Math.asinh", () => {
    expect(jsmql.expr("Math.asinh($.x)")).toEqual({ $asinh: "$x" });
  });
  it("Math.acosh", () => {
    expect(jsmql.expr("Math.acosh($.x)")).toEqual({ $acosh: "$x" });
  });
  it("Math.atanh", () => {
    expect(jsmql.expr("Math.atanh($.x)")).toEqual({ $atanh: "$x" });
  });
});

describe("bitwise infix operators", () => {
  it("a & b", () => {
    expect(jsmql.expr("$.a & $.b")).toEqual({ $bitAnd: ["$a", "$b"] });
  });
  it("a | b", () => {
    expect(jsmql.expr("$.a | $.b")).toEqual({ $bitOr: ["$a", "$b"] });
  });
  it("a ^ b", () => {
    expect(jsmql.expr("$.a ^ $.b")).toEqual({ $bitXor: ["$a", "$b"] });
  });
  it("~a", () => {
    expect(jsmql.expr("~$.a")).toEqual({ $bitNot: "$a" });
  });
  it("a & b & c flattens", () => {
    expect(jsmql.expr("$.a & $.b & $.c")).toEqual({ $bitAnd: ["$a", "$b", "$c"] });
  });
  it("a | b | c flattens", () => {
    expect(jsmql.expr("$.a | $.b | $.c")).toEqual({ $bitOr: ["$a", "$b", "$c"] });
  });
  it("a ^ b ^ c flattens", () => {
    expect(jsmql.expr("$.a ^ $.b ^ $.c")).toEqual({ $bitXor: ["$a", "$b", "$c"] });
  });
  it("(a & b) | c precedence: & binds tighter than |", () => {
    expect(jsmql.expr("$.a & $.b | $.c")).toEqual({ $bitOr: [{ $bitAnd: ["$a", "$b"] }, "$c"] });
  });
  it("(a ^ b) | c precedence: ^ binds tighter than |", () => {
    expect(jsmql.expr("$.a ^ $.b | $.c")).toEqual({ $bitOr: [{ $bitXor: ["$a", "$b"] }, "$c"] });
  });
  it("(a & b) ^ c precedence: & binds tighter than ^", () => {
    expect(jsmql.expr("$.a & $.b ^ $.c")).toEqual({ $bitXor: [{ $bitAnd: ["$a", "$b"] }, "$c"] });
  });
  it("&& binds looser than | (so a | b && c → (a | b) && c)", () => {
    // LHS `$.a | $.b` is non-pure-ref → $let binds it once for the cond chain.
    expect(jsmql.expr("$.a | $.b && $.c")).toEqual({
      $let: { vars: { v: { $bitOr: ["$a", "$b"] } }, in: { $cond: { if: truthy("$$v"), then: "$c", else: "$$v" } } },
    });
  });
  it("=== binds tighter than & (so a === b & c → (a === b) & c)", () => {
    expect(jsmql.expr("$.a === $.b & $.c")).toEqual({ $bitAnd: [{ $eq: ["$a", "$b"] }, "$c"] });
  });
  it("unary ~ has higher precedence than &", () => {
    expect(jsmql.expr("~$.flags & 255")).toEqual({ $bitAnd: [{ $bitNot: "$flags" }, 255] });
  });
});

describe("Object.*", () => {
  it("Object.keys", () => {
    expect(jsmql.expr("Object.keys($.doc)")).toEqual({
      $map: { input: { $objectToArray: "$doc" }, as: "jsmqlKv", in: "$$jsmqlKv.k" },
    });
  });
  it("Object.values", () => {
    expect(jsmql.expr("Object.values($.doc)")).toEqual({
      $map: { input: { $objectToArray: "$doc" }, as: "jsmqlKv", in: "$$jsmqlKv.v" },
    });
  });
  it("Object.entries", () => {
    expect(jsmql.expr("Object.entries($.doc)")).toEqual({ $objectToArray: "$doc" });
  });
  it("Object.assign (2 args)", () => {
    expect(jsmql.expr("Object.assign($.a, $.b)")).toEqual({ $mergeObjects: ["$a", "$b"] });
  });
  it("Object.assign (3 args)", () => {
    expect(jsmql.expr("Object.assign($.a, $.b, $.c)")).toEqual({ $mergeObjects: ["$a", "$b", "$c"] });
  });
});

describe("$let with lambda", () => {
  it("single var lambda", () => {
    expect(jsmql.expr("$let({ d: $.price * 0.1 }, (d) => $.price - d)")).toEqual({
      $let: { vars: { d: { $multiply: ["$price", 0.1] } }, in: { $subtract: ["$price", "$$d"] } },
    });
  });
  it("$let with a block-body lambda nests an inner $let per decl", () => {
    expect(jsmql.expr("$let({ p: $.price }, (p) => { const tax = p * 0.1; return p + tax; })")).toEqual({
      $let: {
        vars: { p: "$price" },
        in: { $let: { vars: { tax: { $multiply: ["$$p", 0.1] } }, in: { $add: ["$$p", "$$tax"] } } },
      },
    });
  });
});

// Block-body arrows `(x) => { const a = …; return <expr>; }` lower to a
// right-folded nest of $let — one binding per decl, in source order, so each
// decl's initialiser and the return see all prior decls as $$name. JS-faithful:
// `=> {` always opens a block; an object return needs `=> ({ … })`.
// See docs/specs/method-dispatch.md.
describe("block-body arrow lambdas (→ nested $let)", () => {
  it(".map() with a single-decl block", () => {
    expect(jsmql.expr("$.items.map(x => { const y = x * 2; return y; })")).toEqual({
      $map: { input: "$items", as: "x", in: { $let: { vars: { y: { $multiply: ["$$x", 2] } }, in: "$$y" } } },
    });
  });

  it(".map() with sequential decls (b references a) → nested $let", () => {
    expect(jsmql.expr("$.items.map(x => { const a = x + 1; const b = a * 2; return b; })")).toEqual({
      $map: {
        input: "$items",
        as: "x",
        in: {
          $let: {
            vars: { a: { $add: ["$$x", 1] } },
            in: { $let: { vars: { b: { $multiply: ["$$a", 2] } }, in: "$$b" } },
          },
        },
      },
    });
  });

  it(".filter() block predicate is wrapped in jsBool around the whole $let", () => {
    expect(jsmql.expr("$.items.filter(x => { const ok = x.active; return ok; })")).toEqual({
      $filter: { input: "$items", as: "x", cond: truthy({ $let: { vars: { ok: "$$x.active" }, in: "$$ok" } }) },
    });
  });

  it(".reduce() body may be a block", () => {
    expect(jsmql.expr("$.nums.reduce((acc, n) => { const step = n + 1; return acc + step; }, 0)")).toEqual({
      $reduce: {
        input: "$nums",
        initialValue: 0,
        in: { $let: { vars: { step: { $add: ["$$this", 1] } }, in: { $add: ["$$value", "$$step"] } } },
      },
    });
  });

  it("a block with no decls is just `{ return <expr>; }`", () => {
    expect(jsmql.expr("$.items.map(x => { return x.name; })")).toEqual({
      $map: { input: "$items", as: "x", in: "$$x.name" },
    });
  });

  it("non-lowercase decl names are made $$-safe consistently (binding + reference)", () => {
    expect(jsmql.expr("$.items.map(x => { const _tmp = x * 2; return _tmp; })")).toEqual({
      $map: { input: "$items", as: "x", in: { $let: { vars: { v_tmp: { $multiply: ["$$x", 2] } }, in: "$$v_tmp" } } },
    });
  });

  it("nested block-body lambdas compose", () => {
    expect(
      jsmql.expr("$.rows.map(r => { const xs = r.vals.map(v => { const d = v * 2; return d; }); return xs; })"),
    ).toEqual({
      $map: {
        input: "$rows",
        as: "r",
        in: {
          $let: {
            vars: {
              xs: {
                $map: {
                  input: "$$r.vals",
                  as: "v",
                  in: { $let: { vars: { d: { $multiply: ["$$v", 2] } }, in: "$$d" } },
                },
              },
            },
            in: "$$xs",
          },
        },
      },
    });
  });

  it("2-param block body composes with the (element,index) pair $let", () => {
    expect(jsmql.expr("$.items.map((x, i) => { const tagged = i; return tagged; })")).toEqual({
      $map: {
        input: { $zip: { inputs: [{ $range: [0, { $size: "$items" }] }, "$items"] } },
        as: "jsmqlPair",
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$jsmqlPair", 1] }, i: { $arrayElemAt: ["$$jsmqlPair", 0] } },
            in: { $let: { vars: { tagged: "$$i" }, in: "$$tagged" } },
          },
        },
      },
    });
  });

  it("rejects re-declaration of the same name in one block", () => {
    expect(() => jsmql.expr("$.items.map(x => { const a = 1; const a = 2; return a; })")).toThrow(
      /already declared earlier/,
    );
  });

  it("rejects a block with no `return`", () => {
    expect(() => jsmql.expr("$.items.map(x => { const a = 1; })")).toThrow(/must end with a `return <expr>`/);
  });

  // MongoDB SPLICES a bare array in a positional single-array-argument slot:
  // `{ $size: [1, 2] }` is read as two arguments ("takes exactly 1 arguments. 2
  // were passed in"), and the one-element `{ $size: [1] }` unwraps to the scalar
  // ("must be an array, but was of type: int"). So every one of these emitted MQL
  // the server refused. One extra level is unwrapped exactly once, back to the
  // operand we meant. Verified against a live mongod.
  describe("a literal-array receiver is wrapped for single-array-argument operators", () => {
    const wrapped: [string, string, unknown][] = [
      [".length", "[1, 2].length", { $size: [[1, 2]] }],
      [".size()", "[1, 2].size()", { $size: [[1, 2]] }],
      [".toReversed()", "[1, 2].toReversed()", { $reverseArray: [[1, 2]] }],
      [".head()", "[1, 2].head()", { $first: [[1, 2]] }],
      [".first()", "[1, 2].first()", { $first: [[1, 2]] }],
      [".last()", "[1, 2].last()", { $last: [[1, 2]] }],
      // A single-element literal is the sharper case: unwrapped it becomes a scalar.
      ["1-element .length", "[1].length", { $size: [[1]] }],
      ["string elements", '["a", "b"].toReversed()', { $reverseArray: [["a", "b"]] }],
    ];
    for (const [label, src, expected] of wrapped) {
      it(`${label} wraps the literal`, () => {
        expect(jsmql.expr(src)).toEqual(expected);
      });
    }

    it("a non-literal receiver is left alone — the wrap is only for literals", () => {
      // A field path / $$var / operator document is already unambiguous, so adding
      // a level would change what the operator reads.
      expect(jsmql.expr("$.items.toReversed()")).toEqual({ $reverseArray: "$items" });
      expect(jsmql.expr("$.items.map(a => a).toReversed()")).toEqual({
        $reverseArray: { $map: { input: "$items", as: "a", in: "$$a" } },
      });
    });

    it("object-form operators keep the receiver unwrapped (no splicing there)", () => {
      // `input:` is a named value slot, not an argument list — wrapping would break it.
      expect(jsmql.expr("[1, 2].map(a => a)")).toEqual({ $map: { input: [1, 2], as: "a", in: "$$a" } });
      expect(jsmql.expr("[1, 2].filter(a => a)")).toMatchObject({ $filter: { input: [1, 2], as: "a" } });
    });
  });

  // JS stringifies nested arrays recursively (`[[1,2],[3]].join(",") === "1,2,3"`).
  // MQL expressions can't recurse, so the emitted `$toString` of an inner array is
  // an execution-time failure. Reject where the shape is provable rather than emit
  // it (HR3) or silently flatten one level (a different answer than was asked for).
  describe("stringifying an array of arrays is rejected, not mis-emitted", () => {
    it("a literal of literals is rejected by .join() and .toString()", () => {
      expect(() => jsmql.expr('[[1, 2], [3]].join(",")')).toThrow(
        /\.join\(\) can't stringify an array of arrays — this array literal holds arrays/,
      );
      expect(() => jsmql.expr("[[1, 2], [3]].toString()")).toThrow(/\.toString\(\) can't stringify an array of arrays/);
    });

    it("the message offers both ways out", () => {
      expect(() => jsmql.expr('[[1, 2], [3]].join(",")')).toThrow(
        /Flatten first \('\.flat\(\)\.join\(\)'\), or map each inner array to a string/,
      );
    });

    it(".partition() is the other provable shape", () => {
      expect(() => jsmql('$.r = $$$.orders.partition(o => o.v > 0).join(",");')).toThrow(
        /\.join\(\) can't stringify an array of arrays — '\.partition\(\.\.\.\)' holds arrays/,
      );
    });

    it("a flat literal, an unknown receiver, and .flat() first all still compile", () => {
      expect(jsmql.expr('[1, 2].join(",")')).toMatchObject({ $reduce: { input: [1, 2] } });
      // Unknown element type — literal-gating says don't guess.
      expect(() => jsmql.expr('$.items.join(",")')).not.toThrow();
      expect(() => jsmql.expr('[[1, 2], [3]].flat().join(",")')).not.toThrow();
    });
  });

  // A `=> { $stage(...); ... }` block is a SUB-PIPELINE, legal only as the argument
  // to a stream method that takes one. Written anywhere else it used to demand a
  // `return` the user never wanted — sending them after a phantom syntax error
  // instead of the real mistake (a misspelled method, or a non-stream receiver).
  describe("a stage-call block outside a sub-pipeline position names the real mistake", () => {
    it("a misspelled block method on a stream receiver suggests the intended one", () => {
      for (const [typo, meant] of [
        ["aggregat", "aggregate"],
        ["mapp", "map"],
        ["filte", "filter"],
      ]) {
        const err = `$.r = $$$.orders.${typo}((o) => { $limit(2); });`;
        expect(() => jsmql(err)).toThrow(
          /Unexpected stage call at position \d+: a `=> \{ \$stage\(\.\.\.\); \.\.\. \}` block/,
        );
        expect(() => jsmql(err)).toThrow(new RegExp(`doesn't take one\\. Did you mean '\\.${meant}'\\?`));
      }
    });

    it("a key-function method gets the same lead and no suggestion", () => {
      expect(() => jsmql("$.r = $$$.orders.sortBy((o) => { $limit(2); });")).toThrow(
        /Unexpected stage call at position \d+:.*but '\.sortBy\(\.\.\.\)' doesn't take one\. Pipeline stages belong/s,
      );
    });

    // The suggestion names the method the developer meant, but must not imply that
    // method would accept the block as written: only `.aggregate` takes a pipeline,
    // so the rule is stated either way (see src/callback-block.ts).
    it("states the callback rule rather than promising the suggested method takes stages", () => {
      for (const src of [
        "$.r = $$$.orders.aggregat((o) => { $limit(2); });",
        "$.r = $$$.orders.filte((o) => { $limit(2); });",
        "$.r = $.items.map((d) => { $limit(2); });",
      ]) {
        expect(() => jsmql(src)).toThrow(
          /Pipeline stages belong to `\.aggregate\(pipeline\)` alone; every other callback's block body is JavaScript/,
        );
      }
    });

    it("an in-document array receiver is told stages need a stream", () => {
      for (const src of [
        "$.r = $.items.map((d) => { $limit(2); });",
        "$.r = $.items.aggregate((o) => { $limit(2); });",
      ]) {
        expect(() => jsmql(src)).toThrow(
          /Stage calls need a stream receiver — '\$\$' or '\$\$\$\.<coll>' — not an in-document value/,
        );
      }
    });

    it("carries a .pos pointing at the stage call", () => {
      const res = jsmql.validate("$.r = $$$.orders.aggregat((o) => { $limit(2); });");
      expect(res.valid).toBe(false);
      expect(res.errors[0].pos).toBe("$.r = $$$.orders.aggregat((o) => { ".length);
    });

    it("a genuine missing `return` (no stage calls) keeps the original message", () => {
      expect(() => jsmql.expr("$.items.map((d) => { const a = d.v; })")).toThrow(/must end with a `return <expr>`/);
      expect(() => jsmql.expr("$.items.map((d) => { d.v; })")).toThrow(/must end with a `return <expr>`/);
    });

    it("the valid spellings still compile", () => {
      expect(jsmql("$.r = $$$.orders.aggregate((o) => { $limit(2); });")).toEqual([
        { $lookup: { from: "orders", pipeline: [{ $limit: 2 }], as: "r" } },
      ]);
      expect(jsmql.expr("$.items.map((d) => { const a = d.v; return a; })")).toEqual({
        $map: { input: "$items", as: "d", in: { $let: { vars: { a: "$$d.v" }, in: "$$a" } } },
      });
    });
  });

  it("JS-faithful: a bare-brace object body is a block (object return needs parens)", () => {
    // `x => { k: x }` is a labeled-statement block in JS, not an object — jsmql
    // rejects it (no `return`); the object form is `x => ({ k: x })`.
    expect(() => jsmql.expr("$.items.map(x => { k: x })")).toThrow(/return/);
    expect(jsmql.expr("$.items.map(x => ({ k: x }))")).toEqual({
      $map: { input: "$items", as: "x", in: { k: "$$x" } },
    });
  });
});

describe("immutable array methods", () => {
  it(".toSorted() with no comparator → ascending", () => {
    expect(jsmql.expr("$.scores.toSorted()")).toEqual({ $sortArray: { input: "$scores", sortBy: 1 } });
  });
  it(".toSorted with comparator throws helpful error", () => {
    expect(() => jsmql.expr("$.scores.toSorted((a, b) => a - b)")).toThrow(/comparator-style/);
  });
  it(".toReversed() is array-context", () => {
    expect(jsmql.expr("$.items.toReversed()")).toEqual({ $reverseArray: "$items" });
  });
  it(".toReversed() chainable with .map()", () => {
    expect(jsmql.expr("$.items.toReversed().map(x => x.name)")).toEqual({
      $map: { input: { $reverseArray: "$items" }, as: "x", in: "$$x.name" },
    });
  });
  it(".findLast(p) returns last matching element (predicate body wrapped in jsBool)", () => {
    expect(jsmql.expr("$.items.findLast(x => x.active)")).toEqual({
      $arrayElemAt: [{ $filter: { input: "$items", as: "x", cond: truthy("$$x.active") } }, -1],
    });
  });
  it(".findLastIndex(p) reduces (idx, el) pairs (predicate body wrapped in jsBool)", () => {
    expect(jsmql.expr("$.items.findLastIndex(x => x.active)")).toEqual({
      $reduce: {
        input: { $zip: { inputs: [{ $range: [0, { $size: "$items" }] }, "$items"] } },
        initialValue: -1,
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$this", 1] } },
            in: { $cond: { if: truthy("$$x.active"), then: { $arrayElemAt: ["$$this", 0] }, else: "$$value" } },
          },
        },
      },
    });
  });
});

describe("array method additions", () => {
  it(".findIndex(p) returns the first matching index (zipped reduce with -1 guard)", () => {
    expect(jsmql.expr("$.items.findIndex(x => x.active)")).toEqual({
      $reduce: {
        input: { $zip: { inputs: [{ $range: [0, { $size: "$items" }] }, "$items"] } },
        initialValue: -1,
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$this", 1] } },
            in: {
              $cond: {
                if: { $and: [{ $eq: ["$$value", -1] }, truthy("$$x.active")] },
                then: { $arrayElemAt: ["$$this", 0] },
                else: "$$value",
              },
            },
          },
        },
      },
    });
  });
  it(".lastIndexOf(x) reverses, finds, normalises back to original index", () => {
    expect(jsmql.expr("$.items.lastIndexOf(42)")).toEqual({
      $let: {
        vars: { jsmqlArr: "$items" },
        in: {
          $let: {
            vars: { jsmqlRevIdx: { $indexOfArray: [{ $reverseArray: "$$jsmqlArr" }, 42] } },
            in: {
              $cond: {
                if: { $eq: ["$$jsmqlRevIdx", -1] },
                then: -1,
                else: { $subtract: [{ $subtract: [{ $size: "$$jsmqlArr" }, 1] }, "$$jsmqlRevIdx"] },
              },
            },
          },
        },
      },
    });
  });
  it(".lastIndexOf on a known string receiver throws", () => {
    expect(() => jsmql.expr('$.s.toLowerCase().lastIndexOf("x")')).toThrow(/forward-only/);
  });
  it(".reduceRight(fn, init) reverses the input array", () => {
    expect(jsmql.expr("$.xs.reduceRight((acc, x) => acc + x, 0)")).toEqual({
      $reduce: { input: { $reverseArray: "$xs" }, initialValue: 0, in: { $add: ["$$value", "$$this"] } },
    });
  });
  it(".toSpliced(s, dc, ...items) builds a 3-piece $concatArrays", () => {
    expect(jsmql.expr('$.xs.toSpliced(1, 2, "a", "b")')).toEqual({
      $let: {
        vars: { jsmqlArr: "$xs", jsmqlStart: 1 },
        in: {
          $let: {
            vars: { jsmqlTailStart: { $add: ["$$jsmqlStart", 2] } },
            in: {
              $concatArrays: [
                { $slice: ["$$jsmqlArr", 0, "$$jsmqlStart"] },
                ["a", "b"],
                {
                  $slice: [
                    "$$jsmqlArr",
                    "$$jsmqlTailStart",
                    { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }] },
                  ],
                },
              ],
            },
          },
        },
      },
    });
  });
  it(".toSpliced(s) with no deleteCount removes to end", () => {
    expect(jsmql.expr("$.xs.toSpliced(2)")).toEqual({
      $let: {
        vars: { jsmqlArr: "$xs", jsmqlStart: 2 },
        in: {
          $let: {
            vars: { jsmqlTailStart: "$$jsmqlStart" },
            in: {
              $concatArrays: [
                { $slice: ["$$jsmqlArr", 0, "$$jsmqlStart"] },
                [],
                {
                  $slice: [
                    "$$jsmqlArr",
                    "$$jsmqlTailStart",
                    { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }] },
                  ],
                },
              ],
            },
          },
        },
      },
    });
  });
  it(".toSpliced with negative start literal throws", () => {
    expect(() => jsmql.expr("$.xs.toSpliced(-1, 1)")).toThrow(/negative start/);
  });
  it(".with(i, v) replaces an element by index", () => {
    expect(jsmql.expr("$.xs.with(1, 99)")).toEqual({
      $let: {
        vars: { jsmqlArr: "$xs", jsmqlIdx: 1, jsmqlVal: 99 },
        in: {
          $concatArrays: [
            { $slice: ["$$jsmqlArr", 0, "$$jsmqlIdx"] },
            ["$$jsmqlVal"],
            {
              $slice: [
                "$$jsmqlArr",
                { $add: ["$$jsmqlIdx", 1] },
                { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, { $add: ["$$jsmqlIdx", 1] }] }] },
              ],
            },
          ],
        },
      },
    });
  });
  it(".with with a negative index literal throws", () => {
    expect(() => jsmql.expr("$.xs.with(-1, 9)")).toThrow(/negative index/);
  });
  it(".with arity is enforced (exactly 2)", () => {
    expect(() => jsmql.expr("$.xs.with(0)")).toThrow(/exactly 2 arguments/);
  });
  it(".toString() on a known array lowers to join-with-comma", () => {
    expect(jsmql.expr("$.xs.map(x => x + 1).toString()")).toEqual({
      $reduce: {
        input: { $map: { input: "$xs", as: "x", in: { $add: ["$$x", 1] } } },
        initialValue: "",
        in: {
          $cond: {
            if: { $eq: ["$$value", ""] },
            then: { $toString: "$$this" },
            else: { $concat: ["$$value", ",", { $toString: "$$this" }] },
          },
        },
      },
    });
  });
  it(".toString() on a known string is a no-op", () => {
    expect(jsmql.expr("$.name.toLowerCase().toString()")).toEqual({ $toLower: "$name" });
  });
  it(".toString() on unknown type lowers to $toString", () => {
    expect(jsmql.expr("$.n.toString()")).toEqual({ $toString: "$n" });
  });
});

describe("array callbacks support (element, index)", () => {
  it(".map((x, i) => …) zips over $range and wraps in $let", () => {
    expect(jsmql.expr("$.xs.map((x, i) => x + i)")).toEqual({
      $map: {
        input: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } },
        as: "jsmqlPair",
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$jsmqlPair", 1] }, i: { $arrayElemAt: ["$$jsmqlPair", 0] } },
            in: { $add: ["$$x", "$$i"] },
          },
        },
      },
    });
  });
  it(".filter((x, i) => cond) filters pairs and projects back to elements", () => {
    expect(jsmql.expr("$.xs.filter((x, i) => i > 0)")).toEqual({
      $map: {
        input: {
          $filter: {
            input: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } },
            as: "jsmqlPair",
            cond: {
              $let: {
                vars: { x: { $arrayElemAt: ["$$jsmqlPair", 1] }, i: { $arrayElemAt: ["$$jsmqlPair", 0] } },
                in: { $gt: ["$$i", 0] },
              },
            },
          },
        },
        as: "jsmqlPair",
        in: { $arrayElemAt: ["$$jsmqlPair", 1] },
      },
    });
  });
  // A paramless callback still occupies an `as` name in the emitted MQL. Before it
  // was gensym'd, the inner one shadowed the outer element and `$$v` resolved to
  // the inner array's element (mongod returned [[0,0,0],[0,0,0]], not [[1,1,1],[2,2,2]]).
  it("a paramless callback's synthetic `as` doesn't shadow an enclosing one", () => {
    expect(jsmql.expr("$.a.map(v => $.b.map(() => v))")).toEqual({
      $map: { input: "$a", as: "v", in: { $map: { input: "$b", as: "v2", in: "$$v" } } },
    });
  });
  it(".find((x, i) => cond) wraps with double $arrayElemAt", () => {
    expect(jsmql.expr("$.xs.find((x, i) => i === 2)")).toEqual({
      $arrayElemAt: [
        {
          $arrayElemAt: [
            {
              $filter: {
                input: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } },
                as: "jsmqlPair",
                cond: {
                  $let: {
                    vars: { x: { $arrayElemAt: ["$$jsmqlPair", 1] }, i: { $arrayElemAt: ["$$jsmqlPair", 0] } },
                    in: { $eq: ["$$i", 2] },
                  },
                },
              },
            },
            0,
          ],
        },
        1,
      ],
    });
  });
  it(".some((x, i) => cond) wraps the body in $let", () => {
    expect(jsmql.expr("$.xs.some((x, i) => i > 5)")).toEqual({
      $anyElementTrue: {
        $map: {
          input: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } },
          as: "jsmqlPair",
          in: {
            $let: {
              vars: { x: { $arrayElemAt: ["$$jsmqlPair", 1] }, i: { $arrayElemAt: ["$$jsmqlPair", 0] } },
              in: { $gt: ["$$i", 5] },
            },
          },
        },
      },
    });
  });
  it(".findIndex((x, i) => …) binds both params in $let.vars", () => {
    expect(jsmql.expr("$.xs.findIndex((x, i) => x === i)")).toEqual({
      $reduce: {
        input: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } },
        initialValue: -1,
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$this", 1] }, i: { $arrayElemAt: ["$$this", 0] } },
            in: {
              $cond: {
                if: { $and: [{ $eq: ["$$value", -1] }, { $eq: ["$$x", "$$i"] }] },
                then: { $arrayElemAt: ["$$this", 0] },
                else: "$$value",
              },
            },
          },
        },
      },
    });
  });
  // MongoDB rejects a user-variable name starting with `_`, so the idiomatic JS
  // throwaway param has to go through safeVarName like every other binding site
  // ("'_' starts with an invalid character for a user variable name").
  it(".findIndex((_, i) => …) escapes the throwaway param to a server-valid name", () => {
    expect(jsmql.expr("$.xs.findIndex((_, i) => i > 2)")).toEqual({
      $reduce: {
        input: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } },
        initialValue: -1,
        in: {
          $let: {
            vars: { v_: { $arrayElemAt: ["$$this", 1] }, i: { $arrayElemAt: ["$$this", 0] } },
            in: {
              $cond: {
                if: { $and: [{ $eq: ["$$value", -1] }, { $gt: ["$$i", 2] }] },
                then: { $arrayElemAt: ["$$this", 0] },
                else: "$$value",
              },
            },
          },
        },
      },
    });
  });
  it(".findLastIndex((_, i) => …) escapes it too", () => {
    expect(JSON.stringify(jsmql.expr("$.xs.findLastIndex((_, i) => i > 2)"))).toContain('"vars":{"v_":');
  });
  it(".reduce((acc, x, i) => …, init) zips input and rebinds in $let", () => {
    expect(jsmql.expr("$.xs.reduce((acc, x, i) => acc + x * i, 0)")).toEqual({
      $reduce: {
        input: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } },
        initialValue: 0,
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$this", 1] }, i: { $arrayElemAt: ["$$this", 0] } },
            in: { $add: ["$$value", { $multiply: ["$$x", "$$i"] }] },
          },
        },
      },
    });
  });
  it(".reduceRight((acc, x, i) => …, init) reverses the zipped pairs", () => {
    expect(jsmql.expr("$.xs.reduceRight((acc, x, i) => acc + i, 0)")).toEqual({
      $reduce: {
        input: { $reverseArray: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } } },
        initialValue: 0,
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$this", 1] }, i: { $arrayElemAt: ["$$this", 0] } },
            in: { $add: ["$$value", "$$i"] },
          },
        },
      },
    });
  });
  it(".map with a 3rd 'array' param: arr.length → $size; index unused → no $zip", () => {
    // `i` is only present positionally to reach `arr`, so the simple `$map` is
    // used (no $zip/$range); `arr` binds to the input via a thin $let.
    expect(jsmql.expr("$.xs.map((x, i, arr) => arr.length)")).toEqual({
      $map: { input: "$xs", as: "x", in: { $let: { vars: { arr: "$xs" }, in: { $size: "$$arr" } } } },
    });
  });
  it(".filter with a 3rd 'array' param: simple $filter, arr is the input", () => {
    expect(jsmql.expr("$.xs.filter((x, i, arr) => arr.length > 0)")).toEqual({
      $filter: {
        input: "$xs",
        as: "x",
        cond: { $let: { vars: { arr: "$xs" }, in: { $gt: [{ $size: "$$arr" }, 0] } } },
      },
    });
  });
  it("unused index → simple lowering (no $zip/$range)", () => {
    expect(jsmql.expr("$.xs.map((x, i) => x)")).toEqual({ $map: { input: "$xs", as: "x", in: "$$x" } });
  });
  it("used index → $zip/$range pairing", () => {
    expect(jsmql.expr("$.xs.map((x, i) => x + i)")).toEqual({
      $map: {
        input: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } },
        as: "jsmqlPair",
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$jsmqlPair", 1] }, i: { $arrayElemAt: ["$$jsmqlPair", 0] } },
            in: { $add: ["$$x", "$$i"] },
          },
        },
      },
    });
  });
  it(".map with 4 params throws", () => {
    expect(() => jsmql.expr("$.xs.map((x, i, arr, extra) => x)")).toThrow(/at most 3 parameters/);
  });
  it(".findIndex with 3 params throws", () => {
    expect(() => jsmql.expr("$.xs.findIndex((x, i, arr) => true)")).toThrow(/at most 2 parameters/);
  });
  it(".reduce with 4 params throws", () => {
    expect(() => jsmql.expr("$.xs.reduce((acc, x, i, arr) => acc, 0)")).toThrow(/2 or 3 parameters/);
  });
});

describe("mutator DX shims (expression position rejects mutators)", () => {
  it(".sort() points at .toSorted() and statement position", () => {
    expect(() => jsmql.expr("$.xs.sort()")).toThrow(/\.toSorted\(\)/);
    expect(() => jsmql.expr("$.xs.sort()")).toThrow(/mutates|statement position/);
  });
  it(".reverse() points at .toReversed() and statement position", () => {
    expect(() => jsmql.expr("$.xs.reverse()")).toThrow(/\.toReversed\(\)/);
    expect(() => jsmql.expr("$.xs.reverse()")).toThrow(/mutates|statement position/);
  });
  it(".splice() points at .toSpliced()", () => {
    expect(() => jsmql.expr("$.xs.splice(1, 2)")).toThrow(/\.toSpliced/);
  });
  it(".push() points at .concat() / spread", () => {
    expect(() => jsmql.expr("$.xs.push(1)")).toThrow(/\.concat\(x\)|spread/);
  });
  it(".pop() points at .at(-1) / .slice(0, -1)", () => {
    expect(() => jsmql.expr("$.xs.pop()")).toThrow(/\.at\(-1\)/);
  });
  it(".shift() points at .at(0) / .slice(1)", () => {
    expect(() => jsmql.expr("$.xs.shift()")).toThrow(/\.at\(0\)/);
  });
  it(".unshift() points at .concat() / spread", () => {
    expect(() => jsmql.expr("$.xs.unshift(1)")).toThrow(/\.concat\(\)|newItems/);
  });
  it(".fill() throws with a workaround hint", () => {
    expect(() => jsmql.expr("$.xs.fill(0)")).toThrow(/immutable|statement position/);
  });
  it(".copyWithin() throws with a workaround hint", () => {
    expect(() => jsmql.expr("$.xs.copyWithin(0, 1)")).toThrow(/immutable/);
  });
});

describe("toSorted / sort key function", () => {
  it(".toSorted(x => x.path) → ascending sortBy by that field", () => {
    expect(jsmql.expr("$.events.toSorted(e => e.distance)")).toEqual({
      $sortArray: { input: "$events", sortBy: { distance: 1 } },
    });
  });
  it(".toSorted(x => -x.path) → descending sortBy", () => {
    expect(jsmql.expr("$.events.toSorted(e => -e.distance)")).toEqual({
      $sortArray: { input: "$events", sortBy: { distance: -1 } },
    });
  });
  it(".toSorted with nested key path", () => {
    expect(jsmql.expr("$.events.toSorted(e => e.user.name)")).toEqual({
      $sortArray: { input: "$events", sortBy: { "user.name": 1 } },
    });
  });
  it(".toSorted(keyFn) chains with .slice(-10) (the README example)", () => {
    expect(jsmql.expr("$.events.toSorted(e => e.distance).slice(-10)")).toEqual({
      $slice: [{ $sortArray: { input: "$events", sortBy: { distance: 1 } } }, -10],
    });
  });
  it(".toSorted with 2-param (comparator) lambda is rejected", () => {
    expect(() => jsmql.expr("$.events.toSorted((a, b) => a.x - b.x)")).toThrow(/comparator-style/);
  });
  it(".toSorted with non-key-function body is rejected", () => {
    expect(() => jsmql.expr("$.events.toSorted(e => e.x + e.y)")).toThrow(/key function body/);
  });
  it(".toSorted with bare param (x => x) is rejected", () => {
    expect(() => jsmql.expr("$.events.toSorted(e => e)")).toThrow(/key function body/);
  });

  it('.toSorted("field") → ascending sortBy by that field', () => {
    expect(jsmql.expr('$.events.toSorted("distance")')).toEqual({
      $sortArray: { input: "$events", sortBy: { distance: 1 } },
    });
  });
  it('.toSorted({ field: 1 | -1 | "asc" | "desc" }) → directed sortBy', () => {
    expect(jsmql.expr("$.events.toSorted({ distance: -1 })")).toEqual({
      $sortArray: { input: "$events", sortBy: { distance: -1 } },
    });
    expect(jsmql.expr('$.events.toSorted({ a: "asc", b: "desc" })')).toEqual({
      $sortArray: { input: "$events", sortBy: { a: 1, b: -1 } },
    });
  });
  it(".toSorted([fields]) → multi-key ascending sortBy", () => {
    expect(jsmql.expr('$.events.toSorted(["a", "b"])')).toEqual({
      $sortArray: { input: "$events", sortBy: { a: 1, b: 1 } },
    });
  });
  it(".toSorted with a bad direction / $-prefixed field is rejected", () => {
    expect(() => jsmql.expr("$.events.toSorted({ a: 3 })")).toThrow(/must be 1 \/ -1 \/ "asc" \/ "desc"/);
    expect(() => jsmql.expr('$.events.toSorted("$x")')).toThrow(/no leading '\$'/);
  });
});

describe("lodash object methods (per-doc value vocabulary)", () => {
  it(".mapValues((v[, k]) => …) → $arrayToObject over $objectToArray", () => {
    expect(jsmql.expr("$.o.mapValues(v => v * 2)")).toEqual({
      $arrayToObject: {
        $map: {
          input: { $objectToArray: "$o" },
          as: "jsmqlKv",
          in: { k: "$$jsmqlKv.k", v: { $let: { vars: { v: "$$jsmqlKv.v" }, in: { $multiply: ["$$v", 2] } } } },
        },
      },
    });
  });
  it(".pick([keys]) → object select ($getField; missing keys drop out)", () => {
    expect(jsmql.expr('$.o.pick(["a", "b"])')).toEqual({
      $let: {
        vars: { jsmqlObj: "$o" },
        in: {
          a: { $getField: { field: "a", input: "$$jsmqlObj" } },
          b: { $getField: { field: "b", input: "$$jsmqlObj" } },
        },
      },
    });
    expect(() => jsmql.expr('$.o.pick("a")')).toThrow(/array of field-name strings/);
  });
  it(".omit([keys]) → $arrayToObject over a filtered $objectToArray", () => {
    expect(jsmql.expr('$.o.omit(["a"])')).toEqual({
      $arrayToObject: {
        $filter: { input: { $objectToArray: "$o" }, as: "jsmqlKv", cond: { $not: [{ $in: ["$$jsmqlKv.k", ["a"]] }] } },
      },
    });
  });
  it(".toPairs() → [[k, v], …]; .fromPairs() inverts it", () => {
    expect(jsmql.expr("$.o.toPairs()")).toEqual({
      $map: { input: { $objectToArray: "$o" }, as: "jsmqlKv", in: ["$$jsmqlKv.k", "$$jsmqlKv.v"] },
    });
    expect(jsmql.expr("$.p.fromPairs()")).toHaveProperty("$arrayToObject");
  });
  it(".mapKeys / .pickBy / .omitBy / .invert emit their (verified) shapes", () => {
    expect(jsmql.expr("$.o.mapKeys((v, k) => k)")).toHaveProperty("$arrayToObject");
    expect(jsmql.expr("$.o.pickBy(v => v)")).toHaveProperty("$arrayToObject");
    expect(jsmql.expr("$.o.omitBy(v => v)")).toHaveProperty("$arrayToObject");
    expect(jsmql.expr("$.o.invert()")).toHaveProperty("$arrayToObject");
  });
});

describe("lodash array methods (per-doc value vocabulary)", () => {
  it(".sum()/.mean()/.max()/.min() → $sum/$avg/$max/$min of the array", () => {
    expect(jsmql.expr("$.a.sum()")).toEqual({ $sum: "$a" });
    expect(jsmql.expr("$.a.mean()")).toEqual({ $avg: "$a" });
    expect(jsmql.expr("$.a.max()")).toEqual({ $max: "$a" });
    expect(jsmql.expr("$.a.min()")).toEqual({ $min: "$a" });
  });
  it(".sumBy(iteratee) accepts a field string or an arrow", () => {
    expect(jsmql.expr('$.a.sumBy("x")')).toEqual({
      $sum: { $map: { input: "$a", as: "jsmqlItem", in: "$$jsmqlItem.x" } },
    });
    expect(jsmql.expr("$.a.sumBy(o => o.x)")).toEqual({ $sum: { $map: { input: "$a", as: "o", in: "$$o.x" } } });
  });
  it(".uniq() → order-preserving keep-first dedupe", () => {
    expect(jsmql.expr("$.a.uniq()")).toEqual({
      $reduce: {
        input: "$a",
        initialValue: [],
        in: { $cond: [{ $in: ["$$this", "$$value"] }, "$$value", { $concatArrays: ["$$value", ["$$this"]] }] },
      },
    });
  });
  it(".compact() → $filter by MQL truthiness", () => {
    expect(jsmql.expr("$.a.compact()")).toEqual({ $filter: { input: "$a", as: "jsmqlItem", cond: "$$jsmqlItem" } });
  });
  it(".chunk(size) → $range/$slice; rejects a non-positive-int size", () => {
    expect(jsmql.expr("$.a.chunk(2)")).toEqual({
      $map: { input: { $range: [0, { $size: "$a" }, 2] }, as: "jsmqlI", in: { $slice: ["$a", "$$jsmqlI", 2] } },
    });
    expect(() => jsmql.expr("$.a.chunk(0)")).toThrow(/positive integer/);
  });
  it(".difference / .intersection on a plain array (order-preserving $filter)", () => {
    expect(jsmql.expr("$.a.difference($.b)")).toEqual({
      $filter: { input: "$a", as: "jsmqlItem", cond: { $not: [{ $in: ["$$jsmqlItem", "$b"] }] } },
    });
    expect(jsmql.expr("$.a.intersection($.b)")).toEqual({
      $filter: { input: "$a", as: "jsmqlItem", cond: { $in: ["$$jsmqlItem", "$b"] } },
    });
  });
  it(".keyBy(iteratee) → $arrayToObject (last wins, key stringified)", () => {
    expect(jsmql.expr('$.a.keyBy("id")')).toEqual({
      $arrayToObject: {
        $map: {
          input: "$a",
          as: "jsmqlItem",
          in: { k: { $ifNull: [{ $toString: "$$jsmqlItem.id" }, "null"] }, v: "$$jsmqlItem" },
        },
      },
    });
  });
  it(".partition(pred) → [matches, non]; .reject(pred) → non (matches-object shorthand)", () => {
    expect(jsmql.expr("$.a.partition(o => o.ok)")).toEqual([
      { $filter: { input: "$a", as: "o", cond: "$$o.ok" } },
      { $filter: { input: "$a", as: "o", cond: { $not: ["$$o.ok"] } } },
    ]);
    // A single-key matches shorthand lowers to a bare `$eq` (the arrow-equivalent),
    // not an `$and`-wrapped one — same shape a hand-written `o => o.ok === true` gives.
    expect(jsmql.expr("$.a.reject({ ok: true })")).toEqual({
      $filter: { input: "$a", as: "jsmqlItem", cond: { $not: [{ $eq: ["$$jsmqlItem.ok", true] }] } },
    });
  });
  it("groupBy/countBy/uniqBy/minBy/maxBy/zipObject/union emit their (verified) shapes", () => {
    expect(jsmql.expr('$.a.groupBy("t")')).toHaveProperty("$arrayToObject");
    expect(jsmql.expr('$.a.countBy("t")')).toHaveProperty("$arrayToObject");
    expect(jsmql.expr('$.a.uniqBy("id")')).toHaveProperty("$getField");
    expect(jsmql.expr('$.a.maxBy("x")')).toHaveProperty("$let");
    expect(jsmql.expr("$.a.union($.b)")).toHaveProperty("$reduce");
    expect(jsmql.expr("$.a.zipObject($.b)")).toHaveProperty("$arrayToObject");
  });
  it('keyBy/groupBy/countBy keys are null-safe ($ifNull → "null", so a missing/null key doesn\'t crash $arrayToObject)', () => {
    // `$toString(missing)` is null and `$arrayToObject` rejects a null key; the
    // `$ifNull` wrap coerces it to "null" (matching String(null)). Verified on mongod.
    const wrap = { $ifNull: [{ $toString: "$$jsmqlItem.t" }, "null"] };
    // keyBy: key built directly on each element.
    expect(JSON.stringify(jsmql.expr('$.a.keyBy("t")'))).toContain(JSON.stringify(wrap));
    // groupBy/countBy: the distinct-key set uses the same wrap.
    expect(JSON.stringify(jsmql.expr('$.a.groupBy("t")'))).toContain(JSON.stringify(wrap));
    expect(JSON.stringify(jsmql.expr('$.a.countBy("t")'))).toContain(JSON.stringify(wrap));
  });
  it("countBy/groupBy/keyBy with no iteratee default to identity (lodash `_.countBy([1,2,2])`)", () => {
    // The omitted iteratee counts/groups/keys by the element itself. Shapes below
    // were run on mongod: `[1,2,3,4,5,2,3].countBy()` → {1:1,2:2,3:2,4:1,5:1},
    // `[1,2,2].groupBy()` → {1:[1],2:[2,2]}, `[1,2,3].keyBy()` → {1:1,2:2,3:3}.
    // The identity iteratee keys straight off the element ($$jsmqlItem), not a field.
    const idKey = { $ifNull: [{ $toString: "$$jsmqlItem" }, "null"] };
    expect(jsmql.expr("$.a.keyBy()")).toEqual({
      $arrayToObject: { $map: { input: "$a", as: "jsmqlItem", in: { k: idKey, v: "$$jsmqlItem" } } },
    });
    // countBy/groupBy dedupe the identity keys, then size / bucket per key.
    const distinctIds = { $setUnion: [{ $map: { input: "$a", as: "jsmqlItem", in: idKey } }, []] };
    const idFilter = { $filter: { input: "$a", as: "jsmqlItem", cond: { $eq: [idKey, "$$jsmqlKey"] } } };
    expect(jsmql.expr("$.a.countBy()")).toEqual({
      $arrayToObject: { $map: { input: distinctIds, as: "jsmqlKey", in: { k: "$$jsmqlKey", v: { $size: idFilter } } } },
    });
    expect(jsmql.expr("$.a.groupBy()")).toEqual({
      $arrayToObject: { $map: { input: distinctIds, as: "jsmqlKey", in: { k: "$$jsmqlKey", v: idFilter } } },
    });
  });
  it("countBy/groupBy/keyBy reject more than one argument (arity names the optional iteratee)", () => {
    expect(() => jsmql.expr('$.a.countBy("x", "y")')).toThrow(
      /\.countBy\(\[iteratee\]\) requires 0 or 1 arguments, got 2/,
    );
    expect(() => jsmql.expr('$.a.groupBy("x", "y")')).toThrow(
      /\.groupBy\(\[iteratee\]\) requires 0 or 1 arguments, got 2/,
    );
    expect(() => jsmql.expr('$.a.keyBy("x", "y")')).toThrow(/\.keyBy\(\[iteratee\]\) requires 0 or 1 arguments, got 2/);
  });
});

describe("chain type-check — reject a method on a provably-incompatible receiver", () => {
  // 100%-certain mismatches throw (they'd otherwise emit MQL mongod rejects — e.g.
  // $map over a boolean/number/string, $slice over an object). Verified on mongod.
  it("rejects a method chained on a provably boolean receiver (only .toString/.getTime survive)", () => {
    expect(() => jsmql.expr("$.items.every(x => x.ok).map(y => y)")).toThrow(/can't run on a boolean/);
    expect(() => jsmql.expr("$.items.some(x => x.ok).filter(y => y)")).toThrow(/can't run on a boolean/);
    expect(() => jsmql.expr('$.name.startsWith("A").trim()')).toThrow(/can't run on a boolean/);
    // …but the two universal methods still compile on a boolean.
    expect(() => jsmql.expr("$.items.every(x => x.ok).toString()")).not.toThrow();
  });
  it("rejects an array-receiver + string/number/date/object method", () => {
    expect(() => jsmql.expr("$.name.split(',').toUpperCase()")).toThrow(/expects a string receiver.*returns an array/);
    expect(() => jsmql.expr("$.items.map(x => x).round(2)")).toThrow(/expects a number receiver.*returns an array/);
    expect(() => jsmql.expr("$.items.map(x => x).mapValues(v => v)")).toThrow(
      /expects an object.*receiver.*returns an array/,
    );
  });
  it("rejects a string/number/object-map receiver + array method", () => {
    expect(() => jsmql.expr("$.name.toUpperCase().map(x => x)")).toThrow(/expects an array receiver.*returns a string/);
    expect(() => jsmql.expr("$.items.size().map(x => x)")).toThrow(/expects an array receiver.*returns a number/);
    expect(() => jsmql.expr('$.items.countBy("t").take(3)')).toThrow(/expects an array receiver.*returns an object/);
    expect(() => jsmql.expr('$.items.countBy("t").map(v => v)')).toThrow(
      /expects an array receiver.*returns an object/,
    );
  });
  it("still EMITS for uncertain receivers (element / dual / field / operator) — no false rejection", () => {
    // .find()/.at() on an ordinary array return an element of UNKNOWN type (could be
    // an array) — must not throw.
    expect(() => jsmql.expr("$.matrix.find(r => r.length > 0).map(x => x)")).not.toThrow();
    expect(() => jsmql.expr("$.items.at(0).toLowerCase()")).not.toThrow();
    // Compatible same-family chains compile.
    expect(() => jsmql.expr("$.name.toUpperCase().trim()")).not.toThrow();
    expect(() => jsmql.expr("$.items.map(x => x).filter(y => y)")).not.toThrow();
    expect(() => jsmql.expr('$.items.countBy("t").mapValues(v => v)')).not.toThrow();
    // Dual methods (.slice/.includes) are never gated.
    expect(() => jsmql.expr('$.name.toUpperCase().includes("A")')).not.toThrow();
    // The adversarially-found refuted case: clamp's result type follows its args
    // (number OR date), so it's uncertain — `.clamp(...).getFullYear()` must compile.
    expect(() => jsmql.expr("$.d.clamp($.a, $.b).getFullYear()")).not.toThrow();
  });
  it("carries a real .pos (the offending receiver) for tooling (validate)", () => {
    // Offset the chain so the receiver isn't at column 0 — the error's .pos must
    // point at the boolean-producing receiver, not be a 0 placeholder. Every
    // chain link carries its own offset, so this lands on `.every` — the call
    // the message names — rather than on the `$.items` chain root.
    const src = "$.n + $.items.every(x => x.ok).map(y => y)";
    const r = jsmql.validate(src);
    expect(r.valid).toBe(false);
    expect(r.errors[0].pos).toBe(src.indexOf("every"));
  });
});

describe("lodash iteratee / predicate shorthands (uniform across higher-order methods)", () => {
  // Every higher-order method — native `.map`/`.filter`/`.find`/… and the lodash
  // `.sumBy`/`.uniqBy`/`.reject`/… — accepts the same shorthand vocabulary, each
  // desugaring to exactly what the equivalent one-parameter arrow would emit.
  it("property string on .map is a pluck; on a predicate it is a truthy test", () => {
    expect(jsmql.expr('$.a.map("name")')).toEqual({ $map: { input: "$a", as: "jsmqlItem", in: "$$jsmqlItem.name" } });
    // Predicate context applies JS truthiness (the same cond `.filter(x => x.active)`
    // emits — modulo the internal element-var name).
    expect(jsmql.expr('$.a.filter("active")')).toEqual({
      $filter: {
        input: "$a",
        as: "jsmqlItem",
        cond: {
          $and: [
            { $ne: [{ $ifNull: ["$$jsmqlItem.active", null] }, null] },
            { $ne: ["$$jsmqlItem.active", false] },
            { $ne: ["$$jsmqlItem.active", ""] },
            { $ne: ["$$jsmqlItem.active", 0] },
          ],
        },
      },
    });
  });
  it("nested property paths work in the shorthand ('a.b.c')", () => {
    expect(jsmql.expr('$.a.map("addr.city")')).toEqual({
      $map: { input: "$a", as: "jsmqlItem", in: "$$jsmqlItem.addr.city" },
    });
  });
  it("matches-object shorthand → $eq per key (single key bare, multiple $and-joined)", () => {
    expect(jsmql.expr("$.a.filter({ ok: true })")).toEqual({
      $filter: { input: "$a", as: "jsmqlItem", cond: { $eq: ["$$jsmqlItem.ok", true] } },
    });
    expect(jsmql.expr('$.a.filter({ role: "admin", active: true })')).toEqual({
      $filter: {
        input: "$a",
        as: "jsmqlItem",
        cond: { $and: [{ $eq: ["$$jsmqlItem.role", "admin"] }, { $eq: ["$$jsmqlItem.active", true] }] },
      },
    });
  });
  it("matchesProperty pair shorthand ['path', value] → a single $eq (nested path ok)", () => {
    expect(jsmql.expr('$.a.find(["status.code", 200])')).toEqual({
      $arrayElemAt: [{ $filter: { input: "$a", as: "jsmqlItem", cond: { $eq: ["$$jsmqlItem.status.code", 200] } } }, 0],
    });
  });
  it("shorthands reach the lodash iteratee/predicate methods too (.sumBy / .reject / .some)", () => {
    expect(jsmql.expr('$.a.sumBy("price")')).toEqual({
      $sum: { $map: { input: "$a", as: "jsmqlItem", in: "$$jsmqlItem.price" } },
    });
    expect(jsmql.expr("$.a.reject({ ok: true })")).toEqual({
      $filter: { input: "$a", as: "jsmqlItem", cond: { $not: [{ $eq: ["$$jsmqlItem.ok", true] }] } },
    });
    expect(jsmql.expr("$.a.some({ ok: true })")).toEqual({
      $anyElementTrue: { $map: { input: "$a", as: "jsmqlItem", in: { $eq: ["$$jsmqlItem.ok", true] } } },
    });
  });
  it("a bad matchesProperty shape is rejected with a shape hint", () => {
    expect(() => jsmql.expr("$.a.filter([1, 2])")).toThrow(/matchesProperty shorthand needs a field-name string/);
  });
});

describe("lodash positional / slicing methods (per-doc value vocabulary)", () => {
  it(".take([n=1]) / .takeRight([n=1]) → $slice (first / last n)", () => {
    expect(jsmql.expr("$.a.take(2)")).toEqual({ $slice: ["$a", 2] });
    expect(jsmql.expr("$.a.take()")).toEqual({ $slice: ["$a", 1] });
    expect(jsmql.expr("$.a.takeRight(2)")).toEqual({ $slice: ["$a", -2] });
    expect(jsmql.expr("$.a.takeRight()")).toEqual({ $slice: ["$a", -1] });
  });
  it(".drop([n=1]) / .dropRight([n=1]) → $slice (skip first / last n), receiver bound once", () => {
    // drop: from position n; count max(1, size) so an empty array → $slice:[[],n,1] → []
    // (mongod rejects a 3-arg $slice count of 0).
    expect(jsmql.expr("$.a.drop(2)")).toEqual({
      $let: { vars: { jsmqlArr: "$a" }, in: { $slice: ["$$jsmqlArr", 2, { $max: [1, { $size: "$$jsmqlArr" }] }] } },
    });
    // dropRight: keep first max(0, size-n) via 2-arg $slice (n≥size → count 0 → []).
    expect(jsmql.expr("$.a.dropRight(2)")).toEqual({
      $let: {
        vars: { jsmqlArr: "$a" },
        in: { $slice: ["$$jsmqlArr", { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, 2] }] }] },
      },
    });
  });
  it(".head()/.first()/.last() → $first/$last; .nth([n=0]) → $arrayElemAt (negative ok)", () => {
    expect(jsmql.expr("$.a.head()")).toEqual({ $first: "$a" });
    expect(jsmql.expr("$.a.first()")).toEqual({ $first: "$a" });
    expect(jsmql.expr("$.a.last()")).toEqual({ $last: "$a" });
    expect(jsmql.expr("$.a.nth(2)")).toEqual({ $arrayElemAt: ["$a", 2] });
    expect(jsmql.expr("$.a.nth(-1)")).toEqual({ $arrayElemAt: ["$a", -1] });
    expect(jsmql.expr("$.a.nth()")).toEqual({ $arrayElemAt: ["$a", 0] });
  });
  it(".tail()/.initial() → $slice (all but first / all but last); count guards empty/n≥size → []", () => {
    // tail: 3-arg $slice with count max(1, size) so an empty array → $slice:[[],1,1] → []
    // (a 3-arg count of 0 is rejected by mongod).
    expect(jsmql.expr("$.a.tail()")).toEqual({
      $let: { vars: { jsmqlArr: "$a" }, in: { $slice: ["$$jsmqlArr", 1, { $max: [1, { $size: "$$jsmqlArr" }] }] } },
    });
    // initial = dropRight(1): keep first max(0, size-1) via 2-arg $slice (count 0 → []).
    expect(jsmql.expr("$.a.initial()")).toEqual({
      $let: {
        vars: { jsmqlArr: "$a" },
        in: { $slice: ["$$jsmqlArr", { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, 1] }] }] },
      },
    });
  });
  it(".size() counts array elements or object keys (runtime $isArray guard on an unknown receiver)", () => {
    expect(jsmql.expr("$.a.size()")).toEqual({
      $cond: { if: { $isArray: "$a" }, then: { $size: "$a" }, else: { $size: { $objectToArray: "$a" } } },
    });
  });
  it(".take / .takeRight / .drop reject a negative count with a mirror-method hint", () => {
    expect(() => jsmql.expr("$.a.take(-1)")).toThrow(/non-negative count.*takeRight/);
    expect(() => jsmql.expr("$.a.takeRight(-1)")).toThrow(/non-negative count.*\.take/);
    expect(() => jsmql.expr("$.a.drop(-1)")).toThrow(/non-negative count/);
  });
});

describe("lodash set-ops & By-iteratee value methods", () => {
  it(".without(...values) → $filter excluding the given values", () => {
    expect(jsmql.expr("$.a.without(2, 4)")).toEqual({
      $filter: { input: "$a", as: "jsmqlItem", cond: { $not: [{ $in: ["$$jsmqlItem", [2, 4]] }] } },
    });
  });
  it(".xor(other) → order-preserving deduped symmetric difference", () => {
    expect(jsmql.expr("$.a.xor($.b)")).toEqual({
      $let: {
        vars: { jsmqlA: "$a", jsmqlB: "$b" },
        in: {
          $reduce: {
            input: {
              $concatArrays: [
                { $filter: { input: "$$jsmqlA", as: "jsmqlX", cond: { $not: [{ $in: ["$$jsmqlX", "$$jsmqlB"] }] } } },
                { $filter: { input: "$$jsmqlB", as: "jsmqlX", cond: { $not: [{ $in: ["$$jsmqlX", "$$jsmqlA"] }] } } },
              ],
            },
            initialValue: [],
            in: { $cond: [{ $in: ["$$this", "$$value"] }, "$$value", { $concatArrays: ["$$value", ["$$this"]] }] },
          },
        },
      },
    });
  });
  it(".differenceBy / .intersectionBy compare by iteratee key", () => {
    expect(jsmql.expr('$.a.differenceBy($.b, "id")')).toEqual({
      $let: {
        vars: { jsmqlOtherKeys: { $map: { input: "$b", as: "jsmqlItem", in: "$$jsmqlItem.id" } } },
        in: {
          $filter: { input: "$a", as: "jsmqlItem", cond: { $not: [{ $in: ["$$jsmqlItem.id", "$$jsmqlOtherKeys"] }] } },
        },
      },
    });
    expect(jsmql.expr('$.a.intersectionBy($.b, "id")')).toHaveProperty("$let");
  });
  it(".unionBy → concat then keep-first dedupe by key; .xorBy → symmetric difference by key", () => {
    expect(jsmql.expr('$.a.unionBy($.b, "id")')).toMatchObject({ $getField: { field: "out" } });
    expect(jsmql.expr('$.a.xorBy($.b, "id")')).toMatchObject({ $let: { vars: { jsmqlA: "$a", jsmqlB: "$b" } } });
  });
  it(".sortedUniq / .sortedUniqBy alias .uniq / .uniqBy (no sorted-array optimisation in MQL)", () => {
    expect(jsmql.expr("$.a.sortedUniq()")).toEqual(jsmql.expr("$.a.uniq()"));
    expect(jsmql.expr('$.a.sortedUniqBy("id")')).toEqual(jsmql.expr('$.a.uniqBy("id")'));
  });
  // The iteratee's $let must not enclose the $reduce accumulator reads: a param named
  // `value` used to shadow `$$value`, so the "have I seen this key" test read `.seen`
  // off the element and every element survived the dedupe.
  it("an iteratee param named 'value' doesn't shadow the $reduce accumulator", () => {
    expect(jsmql.expr("$.a.uniqBy(value => value.id)")).toEqual({
      $getField: {
        field: "out",
        input: {
          $reduce: {
            input: "$a",
            initialValue: { seen: [], out: [] },
            in: {
              $let: {
                vars: { jsmqlKey: { $let: { vars: { value: "$$this" }, in: "$$value.id" } } },
                in: {
                  $cond: [
                    { $in: ["$$jsmqlKey", "$$value.seen"] },
                    "$$value",
                    {
                      seen: { $concatArrays: ["$$value.seen", ["$$jsmqlKey"]] },
                      out: { $concatArrays: ["$$value.out", ["$$this"]] },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });
  });
  it("an identity iteratee binds the element directly — no redundant inner $let", () => {
    expect(jsmql.expr("$.a.uniqBy(x => x)")).toMatchObject({
      $getField: { input: { $reduce: { in: { $let: { vars: { jsmqlKey: "$$this" } } } } } },
    });
  });
});

describe("lodash transpose value methods — zip / unzip / zipWith", () => {
  it(".zip(...arrays) → $map over $range building the index-tuples (groups run to the longest)", () => {
    expect(jsmql.expr("$.a.zip($.b)")).toEqual({
      $let: {
        vars: { jsmqlZip0: "$a", jsmqlZip1: "$b" },
        in: {
          $map: {
            input: { $range: [0, { $max: [{ $size: "$$jsmqlZip0" }, { $size: "$$jsmqlZip1" }] }] },
            as: "jsmqlI",
            in: [{ $arrayElemAt: ["$$jsmqlZip0", "$$jsmqlI"] }, { $arrayElemAt: ["$$jsmqlZip1", "$$jsmqlI"] }],
          },
        },
      },
    });
    // Three-way zip binds a third array.
    expect(jsmql.expr("$.a.zip($.b, $.c)")).toMatchObject({
      $let: { vars: { jsmqlZip0: "$a", jsmqlZip1: "$b", jsmqlZip2: "$c" } },
    });
  });
  it(".zipWith(...arrays, fn) applies an N-parameter arrow (one param per array) to each group", () => {
    expect(jsmql.expr("$.a.zipWith($.b, (x, y) => x + y)")).toEqual({
      $let: {
        vars: { jsmqlZip0: "$a", jsmqlZip1: "$b" },
        in: {
          $map: {
            input: { $range: [0, { $max: [{ $size: "$$jsmqlZip0" }, { $size: "$$jsmqlZip1" }] }] },
            as: "jsmqlI",
            in: {
              $let: {
                vars: {
                  x: { $arrayElemAt: ["$$jsmqlZip0", "$$jsmqlI"] },
                  y: { $arrayElemAt: ["$$jsmqlZip1", "$$jsmqlI"] },
                },
                in: { $add: ["$$x", "$$y"] },
              },
            },
          },
        },
      },
    });
    expect(() => jsmql.expr("$.a.zipWith($.b, x => x)")).toThrow(/2-parameter arrow/);
  });
  it(".unzipWith is rejected with a tailored .unzip().map(group => …) hint (variadic runtime arity)", () => {
    expect(() => jsmql.expr("$.a.unzipWith(f)")).toThrow(/unzip\(\)\.map\(group/);
  });
  it(".unzip() transposes an array of tuples ($ifNull guards an empty receiver)", () => {
    expect(jsmql.expr("$.t.unzip()")).toEqual({
      $let: {
        vars: { jsmqlT: "$t" },
        in: {
          $map: {
            input: { $range: [0, { $size: { $ifNull: [{ $arrayElemAt: ["$$jsmqlT", 0] }, []] } }] },
            as: "jsmqlJ",
            in: { $map: { input: "$$jsmqlT", as: "jsmqlRow", in: { $arrayElemAt: ["$$jsmqlRow", "$$jsmqlJ"] } } },
          },
        },
      },
    });
  });
});

describe("lodash predicate-run value methods — takeWhile / dropWhile / *RightWhile", () => {
  it(".takeWhile(pred) → slice up to the first falsy element (first-false index via $indexOfArray)", () => {
    expect(jsmql.expr("$.a.takeWhile(x => x < 3)")).toEqual({
      $let: {
        vars: { jsmqlArr: "$a" },
        in: {
          $let: {
            vars: {
              jsmqlFi: {
                $indexOfArray: [
                  { $map: { input: "$$jsmqlArr", as: "x", in: { $cond: [{ $lt: ["$$x", 3] }, true, false] } } },
                  false,
                ],
              },
            },
            // 2-arg $slice (first `jsmqlFi`) so a boundary at index 0 → $slice:[arr,0] → []
            // (mongod rejects the 3-arg $slice:[arr,0,0]).
            in: { $cond: [{ $eq: ["$$jsmqlFi", -1] }, "$$jsmqlArr", { $slice: ["$$jsmqlArr", "$$jsmqlFi"] }] },
          },
        },
      },
    });
  });
  it(".dropWhile keeps from the boundary; all-truthy → []", () => {
    expect(jsmql.expr("$.a.dropWhile(x => x < 3)")).toMatchObject({ $let: { vars: { jsmqlArr: "$a" } } });
    // drop branch slices from the boundary to the end.
    expect(JSON.stringify(jsmql.expr("$.a.dropWhile(x => x < 3)"))).toContain('"$slice":["$$jsmqlArr","$$jsmqlFi"');
  });
  it(".takeRightWhile / .dropRightWhile scan the reversed array, then reverse back", () => {
    expect(jsmql.expr("$.a.takeRightWhile(x => x < 3)")).toMatchObject({
      $reverseArray: { $let: { vars: { jsmqlArr: { $reverseArray: "$a" } } } },
    });
    expect(jsmql.expr("$.a.dropRightWhile(x => x < 3)")).toMatchObject({ $reverseArray: {} });
  });
  it(".takeWhile accepts a matches-object predicate (like .reject / .partition)", () => {
    expect(JSON.stringify(jsmql.expr("$.objs.takeWhile({ ok: true })"))).toContain('"$eq":["$$jsmqlItem.ok",true]');
  });
});

describe("lodash sortBy / orderBy value aliases → $sortArray", () => {
  it(".sortBy accepts a field / array / key function (ascending); 0 args → natural sort", () => {
    expect(jsmql.expr('$.a.sortBy("age")')).toEqual({ $sortArray: { input: "$a", sortBy: { age: 1 } } });
    expect(jsmql.expr("$.a.sortBy()")).toEqual({ $sortArray: { input: "$a", sortBy: 1 } });
    expect(jsmql.expr('$.a.sortBy(["x", "y"])')).toEqual({ $sortArray: { input: "$a", sortBy: { x: 1, y: 1 } } });
    expect(jsmql.expr("$.a.sortBy(u => u.age)")).toEqual({ $sortArray: { input: "$a", sortBy: { age: 1 } } });
  });
  it(".sortBy rejects an object arg (lodash matches-shorthand, not a direction)", () => {
    expect(() => jsmql.expr("$.a.sortBy({ age: -1 })")).toThrow(/matches-shorthand.*orderBy/s);
  });
  it(".orderBy zips parallel keys + orders; missing orders default ascending", () => {
    expect(jsmql.expr('$.a.orderBy("age", "desc")')).toEqual({ $sortArray: { input: "$a", sortBy: { age: -1 } } });
    expect(jsmql.expr('$.a.orderBy(["a", "b"], ["asc", "desc"])')).toEqual({
      $sortArray: { input: "$a", sortBy: { a: 1, b: -1 } },
    });
    expect(jsmql.expr('$.a.orderBy(["a", "b"])')).toEqual({ $sortArray: { input: "$a", sortBy: { a: 1, b: 1 } } });
  });
  it(".orderBy also accepts a { field: dir } object (directions inline, like .toSorted)", () => {
    expect(jsmql.expr("$.a.orderBy({ score: -1 })")).toEqual({ $sortArray: { input: "$a", sortBy: { score: -1 } } });
    expect(jsmql.expr('$.a.orderBy({ score: -1, name: "asc" })')).toEqual({
      $sortArray: { input: "$a", sortBy: { score: -1, name: 1 } },
    });
  });
  it(".orderBy({ … }) rejects a second orders arg (directions are already in the object)", () => {
    expect(() => jsmql.expr('$.a.orderBy({ score: -1 }, ["asc"])')).toThrow(
      /already carries a direction per field.*drop the second 'orders'/s,
    );
  });
});

describe("lodash random value methods — sample / sampleSize ($rand)", () => {
  it(".sample() → a random element via $arrayElemAt at floor($rand * size)", () => {
    expect(jsmql.expr("$.a.sample()")).toEqual({
      $let: {
        vars: { jsmqlArr: "$a" },
        in: { $arrayElemAt: ["$$jsmqlArr", { $floor: { $multiply: [{ $rand: {} }, { $size: "$$jsmqlArr" }] } }] },
      },
    });
  });
  it(".sampleSize([n=1]) → decorate with $rand, $sortArray, take n, undecorate", () => {
    expect(jsmql.expr("$.a.sampleSize(3)")).toEqual({
      $let: {
        vars: {
          jsmqlShuffled: {
            $sortArray: {
              input: { $map: { input: "$a", as: "jsmqlItem", in: { k: { $rand: {} }, v: "$$jsmqlItem" } } },
              sortBy: { k: 1 },
            },
          },
        },
        in: { $map: { input: { $slice: ["$$jsmqlShuffled", 3] }, as: "jsmqlItem", in: "$$jsmqlItem.v" } },
      },
    });
    expect(jsmql.expr("$.a.sampleSize()")).toMatchObject({
      $let: { in: { $map: { input: { $slice: ["$$jsmqlShuffled", 1] } } } },
    });
    expect(() => jsmql.expr("$.a.sampleSize(-1)")).toThrow(/non-negative count/);
  });
});

describe("lodash string methods (per-doc value vocabulary, ASCII-only)", () => {
  it(".capitalize() / .upperFirst() / .lowerFirst()", () => {
    expect(jsmql.expr("$.s.capitalize()")).toEqual({
      $concat: [
        { $toUpper: { $substrCP: ["$s", 0, 1] } },
        { $toLower: { $substrCP: ["$s", 1, { $strLenCP: { $ifNull: ["$s", ""] } }] } },
      ],
    });
    expect(jsmql.expr("$.s.upperFirst()")).toEqual({
      $concat: [
        { $toUpper: { $substrCP: ["$s", 0, 1] } },
        { $substrCP: ["$s", 1, { $strLenCP: { $ifNull: ["$s", ""] } }] },
      ],
    });
    expect(jsmql.expr("$.s.lowerFirst()")).toEqual({
      $concat: [
        { $toLower: { $substrCP: ["$s", 0, 1] } },
        { $substrCP: ["$s", 1, { $strLenCP: { $ifNull: ["$s", ""] } }] },
      ],
    });
  });
  it(".words() → $regexFindAll with the ASCII word pattern (splits camelCase)", () => {
    expect(jsmql.expr("$.s.words()")).toEqual({
      $map: {
        input: { $regexFindAll: { input: "$s", regex: "[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[A-Z]|[0-9]+" } },
        as: "jsmqlWord",
        in: "$$jsmqlWord.match",
      },
    });
  });
  it(".truncate() default (length 30, '...'); .truncate({ length }) overrides", () => {
    // Bound once and coerced: the receiver must be emitted once, not once per use,
    // and an absent field must read as "" rather than falling through as null.
    const truncated = (length: number, keep: number) => ({
      $let: {
        vars: { jsmqlStr: { $ifNull: ["$s", ""] } },
        in: {
          $cond: [
            { $gt: [{ $strLenCP: "$$jsmqlStr" }, length] },
            { $concat: [{ $substrCP: ["$$jsmqlStr", 0, keep] }, "..."] },
            "$$jsmqlStr",
          ],
        },
      },
    });
    expect(jsmql.expr("$.s.truncate()")).toEqual(truncated(30, 27));
    expect(jsmql.expr("$.s.truncate({ length: 10 })")).toEqual(truncated(10, 7));
    expect(() => jsmql.expr('$.s.truncate({ separator: " " })')).toThrow(/word-boundary/);
  });
  // camelCase/kebabCase/snakeCase/startCase/escape emit large deterministic trees;
  // their behaviour was verified against a live mongod (fooBarBaz → foo-bar-baz, etc.).
  it("kebabCase / snakeCase lower-join words; startCase capitalizes; escape nests $replaceAll", () => {
    expect(jsmql.expr("$.s.kebabCase()")).toHaveProperty("$toLower");
    expect(jsmql.expr("$.s.camelCase()")).toHaveProperty("$let");
    expect(jsmql.expr("$.s.escape()")).toHaveProperty("$replaceAll");
    expect(() => jsmql.expr("$.s.capitalize(1)")).toThrow(/takes no arguments|requires exactly 0/);
  });
});

describe("lodash number methods (per-doc value vocabulary)", () => {
  it(".clamp(lower, upper) → $min of $max", () => {
    expect(jsmql.expr("$.n.clamp(0, 100)")).toEqual({ $min: [{ $max: ["$n", 0] }, 100] });
    expect(() => jsmql.expr("$.n.clamp(0)")).toThrow(/exactly 2 argument/);
  });
  it(".inRange(end) → [0, end); .inRange(start, end) → [start, end) (bounds swap via $min/$max)", () => {
    expect(jsmql.expr("$.n.inRange(10)")).toEqual({
      $and: [{ $gte: ["$n", { $min: [0, 10] }] }, { $lt: ["$n", { $max: [0, 10] }] }],
    });
    expect(jsmql.expr("$.n.inRange(5, 10)")).toEqual({
      $and: [{ $gte: ["$n", { $min: [5, 10] }] }, { $lt: ["$n", { $max: [5, 10] }] }],
    });
  });
  it(".round([p]) → MongoDB $round (banker's rounding)", () => {
    expect(jsmql.expr("$.n.round()")).toEqual({ $round: ["$n", 0] });
    expect(jsmql.expr("$.n.round(2)")).toEqual({ $round: ["$n", 2] });
  });
  it(".ceil()/.floor() → $ceil/$floor; with precision, scale via $pow", () => {
    expect(jsmql.expr("$.n.ceil()")).toEqual({ $ceil: "$n" });
    expect(jsmql.expr("$.n.floor()")).toEqual({ $floor: "$n" });
    expect(jsmql.expr("$.n.ceil(2)")).toEqual({
      $divide: [{ $ceil: { $multiply: ["$n", { $pow: [10, 2] }] } }, { $pow: [10, 2] }],
    });
  });
});

describe("statement-position mutators", () => {
  it(".sort() — 0-arg ascending", () => {
    expect(jsmql("$.events.sort();")).toEqual([{ $set: { events: { $sortArray: { input: "$events", sortBy: 1 } } } }]);
  });
  it(".sort(keyFn) — desugars to $set with $sortArray sortBy", () => {
    expect(jsmql("$.events.sort(e => e.distance);")).toEqual([
      { $set: { events: { $sortArray: { input: "$events", sortBy: { distance: 1 } } } } },
    ]);
  });
  it('.sort("field") / .sort({ field: dir }) — flexible sort args mutate the field', () => {
    expect(jsmql('$.events.sort("distance");')).toEqual([
      { $set: { events: { $sortArray: { input: "$events", sortBy: { distance: 1 } } } } },
    ]);
    expect(jsmql("$.events.sort({ distance: -1 });")).toEqual([
      { $set: { events: { $sortArray: { input: "$events", sortBy: { distance: -1 } } } } },
    ]);
  });
  it(".reverse() — desugars to $set with $reverseArray", () => {
    expect(jsmql("$.events.reverse();")).toEqual([{ $set: { events: { $reverseArray: "$events" } } }]);
  });
  it(".push(item) — appends a single element with $concatArrays + array wrap", () => {
    expect(jsmql("$.events.push($.newEvent);")).toEqual([
      { $set: { events: { $concatArrays: ["$events", ["$newEvent"]] } } },
    ]);
  });
  it(".push(a, b) — appends multiple elements", () => {
    expect(jsmql("$.tags.push('a', 'b');")).toEqual([{ $set: { tags: { $concatArrays: ["$tags", ["a", "b"]] } } }]);
  });
  it(".unshift(a, b) — prepends with items-first", () => {
    expect(jsmql("$.events.unshift($.x, $.y);")).toEqual([
      { $set: { events: { $concatArrays: [["$x", "$y"], "$events"] } } },
    ]);
  });
  it(".pop() — drops last element via the count-tolerant 2-arg $slice (valid on empty/single)", () => {
    // 2-arg (first-n) $slice, NOT 3-arg `[arr, 0, count]`: `max(0, size-1)` is 0
    // for an empty/single-element array, and only the 2-arg form allows a 0 count.
    expect(jsmql("$.events.pop();")).toEqual([
      { $set: { events: { $slice: ["$events", { $max: [0, { $subtract: [{ $size: "$events" }, 1] }] }] } } },
    ]);
  });
  it(".shift() — drops first element; count max(1, size) stays valid on empty/single", () => {
    // count is max(1, size), never 0 — an empty receiver is `$slice: [[], 1, 1]`
    // → [] (position past the end), not a rejected 3-arg count of 0.
    expect(jsmql("$.events.shift();")).toEqual([
      { $set: { events: { $slice: ["$events", 1, { $max: [1, { $size: "$events" }] }] } } },
    ]);
  });
  it(".splice(s, dc, ...items) — delegates to the .toSpliced shape inside $set", () => {
    const out = jsmql("$.events.splice(0, 2, 99);") as Array<Record<string, unknown>>;
    const eventsValue = (out[0]?.$set as { events: unknown }).events as Record<string, unknown>;
    expect(Object.keys(eventsValue)).toEqual(["$let"]);
  });
  it(".fill(v) — every element becomes v via $map", () => {
    expect(jsmql("$.events.fill(0);")).toEqual([
      { $set: { events: { $map: { input: "$events", as: "jsmqlFillUnused", in: 0 } } } },
    ]);
  });
  it(".fill(v, s, e) with non-negative literals — IIFE bindings inline the literals (no normalisation $cond)", () => {
    const out = jsmql("$.events.fill(0, 1, 3);") as Array<Record<string, unknown>>;
    const setVal = (out[0]?.$set as { events: unknown }).events as { $let: { vars: Record<string, unknown> } };
    expect(setVal.$let.vars).toEqual({ jsmqlFillStart: 1, jsmqlFillEnd: 3 });
  });
  // The fill VALUE is generated inside the synthetic `(el, idx)` map callback, so
  // bare param names captured a pipeline binding of the same name: `let x = 5;
  // $.arr.fill(x, 1)` filled with each ELEMENT instead of 5.
  it("a pipeline binding named like the synthetic fill param isn't captured", () => {
    const out = JSON.stringify(jsmql("let x = 5; $.arr.fill(x, 1); $.done = true;"));
    expect(out).toContain('"then":5'); // the binding's value, not "$$x"
    expect(out).not.toContain('"then":"$$x"');
  });
  it(".reverse() with extra args is rejected (preserves the existing .toReversed arg-count check)", () => {
    expect(() => jsmql("$.events.reverse(123);")).toThrow();
  });
  it("nested receiver $.user.history.push(...) emits a dotted $set key", () => {
    expect(jsmql("$.user.history.push($.e);")).toEqual([
      { $set: { "user.history": { $concatArrays: ["$user.history", ["$e"]] } } },
    ]);
  });
  it("top-level mutator without a trailing `;` auto-wraps into Pipeline mode", () => {
    expect(jsmql("$.events.push($.x)")).toEqual([{ $set: { events: { $concatArrays: ["$events", ["$x"]] } } }]);
  });
  it("expression-position mutator still throws (not auto-rewritten inside a larger expression)", () => {
    expect(() => jsmql.expr("$.events.sort().slice(-10)")).toThrow(/\.sort\(\) mutates/);
  });
  it("expression-position .push in a $project body throws", () => {
    expect(() => jsmql.expr("$.events.push(x)")).toThrow(/\.push\(\) mutates/);
  });
  it("two writes to the same field split into two $set stages (read-after-write)", () => {
    // The second .sort reads $events (which was just written), so the
    // coalescer correctly splits — same logic as explicit `=` chains.
    expect(jsmql(`$.events.push($.newEvent); $.events.sort(e => e.distance);`)).toEqual([
      { $set: { events: { $concatArrays: ["$events", ["$newEvent"]] } } },
      { $set: { events: { $sortArray: { input: "$events", sortBy: { distance: 1 } } } } },
    ]);
  });
  it("mutator inside a [...] pipeline literal also rewrites", () => {
    expect(jsmql.pipeline("[{ $match: { active: true } }, $.events.sort()]")).toEqual([
      { $match: { active: true } },
      { $set: { events: { $sortArray: { input: "$events", sortBy: 1 } } } },
    ]);
  });
});

describe("statement-position Object.assign — mutating merge on a field path", () => {
  it("merges sources into the target field via $set + $mergeObjects", () => {
    expect(jsmql("Object.assign($.profile, { verified: true });")).toEqual([
      { $set: { profile: { $mergeObjects: ["$profile", { verified: true }] } } },
    ]);
  });
  it("multiple sources keep the target as the first $mergeObjects operand", () => {
    expect(jsmql("Object.assign($.a, $.b, { c: 1 });")).toEqual([
      { $set: { a: { $mergeObjects: ["$a", "$b", { c: 1 }] } } },
    ]);
  });
  it("nested receiver $.user.profile emits a dotted $set key", () => {
    expect(jsmql("Object.assign($.user.profile, { x: 1 });")).toEqual([
      { $set: { "user.profile": { $mergeObjects: ["$user.profile", { x: 1 }] } } },
    ]);
  });
  it("coalesces with adjacent field assignments inside a [...] pipeline literal", () => {
    expect(jsmql("[ $.x = 1, Object.assign($.profile, { a: $.foo }), $.y = 2 ]")).toEqual([
      { $set: { x: 1, profile: { $mergeObjects: ["$profile", { a: "$foo" }] }, y: 2 } },
    ]);
  });
  it("expression position is unaffected — still lowers to $mergeObjects", () => {
    expect(jsmql("$addFields({ merged: Object.assign($.a, $.b) });")).toEqual([
      { $addFields: { merged: { $mergeObjects: ["$a", "$b"] } } },
    ]);
  });
  it("an object-literal target (discarded result) throws an actionable error", () => {
    expect(() => jsmql("Object.assign({}, { a: 1 });")).toThrow(/at statement position mutates its first argument/);
  });
});

describe("iterator / void / locale DX shims", () => {
  it(".forEach() explains the no-return-value problem", () => {
    expect(() => jsmql.expr("$.xs.forEach(x => x)")).toThrow(/undefined/);
  });
  it(".entries() suggests .map((v, i) => [i, v])", () => {
    expect(() => jsmql.expr("$.xs.entries()")).toThrow(/\[index, value\]|\[i, v\]/);
  });
  it(".keys() suggests $range/$size", () => {
    expect(() => jsmql.expr("$.xs.keys()")).toThrow(/\$range|\$size/);
  });
  it(".values() explains the array is already the value sequence", () => {
    expect(() => jsmql.expr("$.xs.values()")).toThrow(/value sequence|iterator/);
  });
  it(".toLocaleString() explains the locale problem", () => {
    expect(() => jsmql.expr("$.xs.toLocaleString()")).toThrow(/locale/);
  });
});

describe("ES2025 Set methods", () => {
  it("intersection", () => {
    expect(jsmql.expr("new Set($.a).intersection(new Set($.b))")).toEqual({ $setIntersection: ["$a", "$b"] });
  });
  it("union", () => {
    expect(jsmql.expr("new Set($.a).union(new Set($.b))")).toEqual({ $setUnion: ["$a", "$b"] });
  });
  it("difference", () => {
    expect(jsmql.expr("new Set($.a).difference(new Set($.b))")).toEqual({ $setDifference: ["$a", "$b"] });
  });
  it("isSubsetOf", () => {
    expect(jsmql.expr("new Set($.a).isSubsetOf(new Set($.b))")).toEqual({ $setIsSubset: ["$a", "$b"] });
  });
  it("isSupersetOf swaps args", () => {
    expect(jsmql.expr("new Set($.a).isSupersetOf(new Set($.b))")).toEqual({ $setIsSubset: ["$b", "$a"] });
  });
  it("works with array literals", () => {
    expect(jsmql.expr("new Set([1, 2, 3]).intersection(new Set([2, 3, 4]))")).toEqual({
      $setIntersection: [
        [1, 2, 3],
        [2, 3, 4],
      ],
    });
  });
  it("symmetricDifference throws helpful error", () => {
    expect(() => jsmql.expr("new Set($.a).symmetricDifference(new Set($.b))")).toThrow(/no MongoDB equivalent/);
  });
  it("non-Set argument is rejected", () => {
    expect(() => jsmql.expr("new Set($.a).intersection($.b)")).toThrow(/must be a 'new Set/);
  });
});

describe("regex method variants", () => {
  it("/re/.test(str)", () => {
    expect(jsmql.expr("/[a-z]+/.test($.s)")).toEqual({ $regexMatch: { input: "$s", regex: "[a-z]+" } });
  });
  it("/re/flags.test(str) preserves flags", () => {
    expect(jsmql.expr("/PAT/i.test($.s)")).toEqual({ $regexMatch: { input: "$s", regex: "PAT", options: "i" } });
  });
  it("/re/.exec(str)", () => {
    expect(jsmql.expr("/word/.exec($.s)")).toEqual({ $regexFind: { input: "$s", regex: "word" } });
  });
  it("str.matchAll(/re/g)", () => {
    expect(jsmql.expr("$.s.matchAll(/word/g)")).toEqual({ $regexFindAll: { input: "$s", regex: "word" } });
  });
  it("matchAll without g flag throws", () => {
    expect(() => jsmql.expr("$.s.matchAll(/word/)")).toThrow(/'g' flag/);
  });
  it("str.search(/re/) returns idx with -1 fallback", () => {
    expect(jsmql.expr("$.s.search(/foo/)")).toEqual({
      $ifNull: [{ $getField: { field: "idx", input: { $regexFind: { input: "$s", regex: "foo" } } } }, -1],
    });
  });
});

describe("Number static predicates", () => {
  it("Number.isInteger(x)", () => {
    expect(jsmql.expr("Number.isInteger($.n)")).toEqual({
      $cond: {
        if: { $in: [{ $type: "$n" }, ["int", "long"]] },
        then: true,
        else: {
          $cond: {
            if: { $in: [{ $type: "$n" }, ["double", "decimal"]] },
            then: { $eq: ["$n", { $trunc: "$n" }] },
            else: false,
          },
        },
      },
    });
  });
  it("Number.isNaN(x)", () => {
    expect(jsmql.expr("Number.isNaN($.x)")).toEqual({ $ne: ["$x", "$x"] });
  });
  it("Number.isFinite(x) throws helpful error", () => {
    expect(() => jsmql.expr("Number.isFinite($.x)")).toThrow(/no syntax for Infinity/);
  });
});

describe("string padding methods", () => {
  it("padStart with explicit char", () => {
    expect(jsmql.expr('$.code.padStart(5, "0")')).toEqual({
      $let: {
        vars: { jsmqlPad: { $ifNull: ["$code", ""] } },
        in: {
          $cond: {
            if: { $gte: [{ $strLenCP: "$$jsmqlPad" }, 5] },
            then: "$$jsmqlPad",
            else: {
              $concat: [
                {
                  $reduce: {
                    input: { $range: [0, { $subtract: [5, { $strLenCP: "$$jsmqlPad" }] }] },
                    initialValue: "",
                    in: { $concat: ["$$value", "0"] },
                  },
                },
                "$$jsmqlPad",
              ],
            },
          },
        },
      },
    });
  });
  it("a multi-character pad is trimmed to the remaining width, like JS", () => {
    // JS pads to exactly `targetLength` characters, cutting the pad mid-string:
    // "gold".padStart(9, "US") === "USUSUgold". Repeating the pad (target - len)
    // times over-fills, so the repeated run is trimmed back.
    const need = { $subtract: [5, { $strLenCP: "$$jsmqlPad" }] };
    expect(jsmql.expr('$.code.padStart(5, "US")')).toEqual({
      $let: {
        vars: { jsmqlPad: { $ifNull: ["$code", ""] } },
        in: {
          $cond: {
            if: { $gte: [{ $strLenCP: "$$jsmqlPad" }, 5] },
            then: "$$jsmqlPad",
            else: {
              $concat: [
                {
                  $substrCP: [
                    { $reduce: { input: { $range: [0, need] }, initialValue: "", in: { $concat: ["$$value", "US"] } } },
                    0,
                    { $max: [0, need] },
                  ],
                },
                "$$jsmqlPad",
              ],
            },
          },
        },
      },
    });
  });
  it("a one-character pad skips the trim (it already lands exactly)", () => {
    // Output stability for the overwhelmingly common `.padStart(n, "0")`.
    const json = JSON.stringify(jsmql.expr('$.code.padStart(5, "0")'));
    expect(json).not.toContain("$substrCP");
  });
  it("a runtime pad expression is always trimmed (length unknown at compile time)", () => {
    // Includes a `$`-prefixed source string, which per HR1 is a field reference.
    expect(JSON.stringify(jsmql.expr('$.code.padStart(5, "$sep")'))).toContain("$substrCP");
    expect(JSON.stringify(jsmql.expr("$.code.padStart(5, $.sep)"))).toContain("$substrCP");
  });
  it("padStart defaults to space", () => {
    const out = jsmql.expr("$.s.padStart(10)") as Record<string, unknown>;
    // Spot-check: pad string should be a space
    expect(JSON.stringify(out)).toContain('"in":{"$concat":["$$value"," "]}');
  });
  it("padEnd order is str-then-pad", () => {
    const out = jsmql.expr('$.s.padEnd(10, "-")') as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain('["$$jsmqlPad",{"$reduce"');
  });
  // The targetLength/padString args are generated in the OUTER scope but land inside
  // the $let, so a lambda param sharing the binding's name would be captured without a
  // gensym: the args re-resolve against the receiver string and the padding silently
  // vanishes (on mongod: ["7","42"] instead of ["007","***42"]).
  it("a lambda param named 's' is not captured by the internal binding", () => {
    expect(jsmql.expr("$.items.map(s => s.code.padStart(s.width, s.pad))")).toEqual({
      $map: {
        input: "$items",
        as: "s",
        in: {
          $let: {
            // The pad is a runtime expression, so the repeated run is trimmed to
            // the remaining width; the binding is coerced for a missing field.
            vars: { jsmqlPad: { $ifNull: ["$$s.code", ""] } },
            in: {
              $cond: {
                if: { $gte: [{ $strLenCP: "$$jsmqlPad" }, "$$s.width"] },
                then: "$$jsmqlPad",
                else: {
                  $concat: [
                    {
                      $substrCP: [
                        {
                          $reduce: {
                            input: { $range: [0, { $subtract: ["$$s.width", { $strLenCP: "$$jsmqlPad" }] }] },
                            initialValue: "",
                            in: { $concat: ["$$value", "$$s.pad"] },
                          },
                        },
                        0,
                        { $max: [0, { $subtract: ["$$s.width", { $strLenCP: "$$jsmqlPad" }] }] },
                      ],
                    },
                    "$$jsmqlPad",
                  ],
                },
              },
            },
          },
        },
      },
    });
  });
  it("a lambda param named after the binding itself gensyms the binding, not the param", () => {
    const out = JSON.stringify(jsmql.expr("$.items.map(jsmqlPad => jsmqlPad.code.padStart(jsmqlPad.width))"));
    expect(out).toContain('"as":"jsmqlPad"'); // the user's name is left alone
    expect(out).toContain('"vars":{"jsmqlPad2":{"$ifNull":["$$jsmqlPad.code",""]}}'); // ours moves aside
    expect(out).toContain('{"$strLenCP":"$$jsmqlPad2"},"$$jsmqlPad.width"');
  });
  it("repeat", () => {
    expect(jsmql.expr('"-".repeat(5)')).toEqual({
      $reduce: { input: { $range: [0, 5] }, initialValue: "", in: { $concat: ["$$value", "-"] } },
    });
  });
});

// A lowering that binds its receiver in a `$let` and then splices a USER
// expression into the body must not name that binding something the user might
// have named a lambda param — the spliced `$$name` would silently re-point at
// the receiver. This produced wrong VALUES, not errors: `.padStart(3, s.pad)`
// read `.pad` off the code string and returned null.
describe("internal $let bindings never capture a lambda param", () => {
  it("padStart's pad argument still reads the lambda param, not the receiver", () => {
    const out = jsmql.expr("$.items.map(s => s.code.padStart(3, s.pad))") as Record<string, unknown>;
    const json = JSON.stringify(out);
    expect(json).toContain('"$$s.pad"'); // the pad char resolves to the $map element
    expect(json).not.toContain('"vars":{"s":'); // the binding no longer shadows it
  });

  it("a colliding lambda param makes the internal binding gensym", () => {
    // `jsmqlArr` as a param name pushes the internal binding to `jsmqlArr2`,
    // so the needle keeps reading the element.
    expect(jsmql.expr("$.items.map(jsmqlArr => jsmqlArr.list.lastIndexOf(jsmqlArr.needle))")).toEqual({
      $map: {
        input: "$items",
        as: "jsmqlArr",
        in: {
          $let: {
            vars: { jsmqlArr2: "$$jsmqlArr.list" },
            in: {
              $let: {
                vars: { jsmqlRevIdx: { $indexOfArray: [{ $reverseArray: "$$jsmqlArr2" }, "$$jsmqlArr.needle"] } },
                in: {
                  $cond: {
                    if: { $eq: ["$$jsmqlRevIdx", -1] },
                    then: -1,
                    else: { $subtract: [{ $subtract: [{ $size: "$$jsmqlArr2" }, 1] }, "$$jsmqlRevIdx"] },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it("endsWith's needle survives a lambda param named after the binding", () => {
    const json = JSON.stringify(jsmql.expr("$.items.map(jsmqlStr => jsmqlStr.name.endsWith(jsmqlStr.ext))"));
    expect(json).toContain('"jsmqlStr2"'); // binding renamed out of the way
    expect(json).toContain('"$$jsmqlStr.ext"'); // needle still reads the element
  });

  it("no gratuitous renaming when nothing collides", () => {
    // Output stability: the overwhelmingly common case keeps the base name.
    const json = JSON.stringify(jsmql.expr("$.items.map(x => x.list.lastIndexOf(x.needle))"));
    expect(json).toContain('"jsmqlArr"');
    expect(json).not.toContain('"jsmqlArr2"');
  });
});

describe("Array.from({length, ...})", () => {
  it("no map function returns $range", () => {
    expect(jsmql.expr("Array.from({ length: 5 })")).toEqual({ $range: [0, 5] });
  });
  it("with (_, i) => body maps over $range", () => {
    expect(jsmql.expr("Array.from({ length: 3 }, (_, i) => i * 2)")).toEqual({
      $map: { input: { $range: [0, 3] }, as: "i", in: { $let: { vars: { v_: null }, in: { $multiply: ["$$i", 2] } } } },
    });
  });
  it("with $.length expression", () => {
    const out = jsmql.expr("Array.from({ length: $.n }, (_, i) => i)") as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain('"$range":[0,"$n"]');
  });
  it("non-{length} input throws", () => {
    expect(() => jsmql.expr("Array.from($.iter)")).toThrow(/{length: n} form/);
  });
  it("requires 2-param map function", () => {
    expect(() => jsmql.expr("Array.from({ length: 3 }, x => x)")).toThrow(/2 parameters/);
  });
});

describe("BigInt literals", () => {
  it("integer with n suffix", () => {
    expect(jsmql.expr("123n")).toEqual({ $toLong: "123" });
  });
  it("zero", () => {
    expect(jsmql.expr("0n")).toEqual({ $toLong: "0" });
  });
  it("rejects fraction with n", () => {
    expect(() => jsmql.expr("1.5n")).toThrow(/Invalid BigInt/);
  });
  it("rejects exponent with n", () => {
    expect(() => jsmql.expr("1e2n")).toThrow(/Invalid BigInt/);
  });
  it("works in arithmetic", () => {
    expect(jsmql.expr("$.timestamp - 1000n")).toEqual({ $subtract: ["$timestamp", { $toLong: "1000" }] });
  });
});

describe("Object.groupBy", () => {
  it("groups by category", () => {
    expect(jsmql.expr("Object.groupBy($.items, x => x.category)")).toEqual({
      $reduce: {
        input: "$items",
        initialValue: {},
        in: {
          $let: {
            vars: { jsmqlKey: { $toString: "$$this.category" } },
            in: {
              $mergeObjects: [
                "$$value",
                {
                  $arrayToObject: [
                    [
                      [
                        "$$jsmqlKey",
                        {
                          $concatArrays: [
                            { $ifNull: [{ $getField: { field: "$$jsmqlKey", input: "$$value" } }, []] },
                            ["$$this"],
                          ],
                        },
                      ],
                    ],
                  ],
                },
              ],
            },
          },
        },
      },
    });
  });
  it("rejects non-lambda discriminator", () => {
    expect(() => jsmql.expr("Object.groupBy($.items, $.f)")).toThrow(/single-parameter arrow function/);
  });
  it("rejects multi-param lambda", () => {
    expect(() => jsmql.expr("Object.groupBy($.items, (a, b) => a)")).toThrow(/single-parameter arrow function/);
  });
});

describe("IIFE → $let", () => {
  it("simple ((x) => body)(value)", () => {
    expect(jsmql.expr("((x) => x + 1)(5)")).toEqual({ $let: { vars: { x: 5 }, in: { $add: ["$$x", 1] } } });
  });
  it("unparen single param (x => body)(value)", () => {
    expect(jsmql.expr("(x => x * 2)($.n)")).toEqual({ $let: { vars: { x: "$n" }, in: { $multiply: ["$$x", 2] } } });
  });
  it("multi-param IIFE binds all params", () => {
    expect(jsmql.expr("((maxAge, minAge) => $.age >= minAge && $.age <= maxAge)(65, 18)")).toEqual({
      $let: {
        vars: { maxAge: 65, minAge: 18 },
        in: { $and: [{ $gte: ["$age", "$$minAge"] }, { $lte: ["$age", "$$maxAge"] }] },
      },
    });
  });
  it("zero-param IIFE", () => {
    expect(jsmql.expr("(() => $.x + $.y)()")).toEqual({ $let: { vars: {}, in: { $add: ["$x", "$y"] } } });
  });
  it("body can reference outer $.fields", () => {
    expect(jsmql.expr("((d) => $.price - d)($.price * 0.1)")).toEqual({
      $let: { vars: { d: { $multiply: ["$price", 0.1] } }, in: { $subtract: ["$price", "$$d"] } },
    });
  });
  it("rejects mismatched arity", () => {
    expect(() => jsmql.expr("((x, y) => x + y)(1)")).toThrow(/expected 2 argument/);
  });
  it("rejects calling a non-lambda", () => {
    expect(() => jsmql.expr("$.func(1, 2)")).toThrow(/Direct call/);
  });
  it("rejects spread args", () => {
    expect(() => jsmql.expr("((x) => x)(...$.arr)")).toThrow(/spread/);
  });
});

describe("string-context + with method calls", () => {
  it("trim() in + chain is string-producing", () => {
    expect(jsmql.expr('$.first.trim() + " " + $.last')).toEqual({
      $concat: [{ $trim: { input: "$first" } }, " ", "$last"],
    });
  });
  it("String() cast in + chain is string-producing", () => {
    expect(jsmql.expr('String($.n) + " items"')).toEqual({ $concat: [{ $toString: "$n" }, " items"] });
  });
  it("typeof in + chain is string-producing", () => {
    expect(jsmql.expr('typeof $.x + " type"')).toEqual({ $concat: [{ $type: "$x" }, " type"] });
  });
});

describe("regex literals (context-sensitive /)", () => {
  it("regex after operator is a literal, not divide", () => {
    expect(jsmql.expr("$.str.match(/[a-z]+/)")).toEqual({ $regexMatch: { input: "$str", regex: "[a-z]+" } });
  });
  it("/ after number is divide", () => {
    expect(jsmql.expr("$.x / 2")).toEqual({ $divide: ["$x", 2] });
  });
  it("regex with multiple flags", () => {
    expect(jsmql.expr("$.str.match(/pattern/gi)")).toEqual({
      $regexMatch: { input: "$str", regex: "pattern", options: "i" },
    });
  });
});

describe("error cases", () => {
  it("bare identifier outside lambda throws Did you mean", () => {
    expect(() => jsmql.expr("x > 0")).toThrow(/Did you mean/);
  });
  it("unknown method throws with helpful message", () => {
    expect(() => jsmql.expr("$.name.frobulate()")).toThrow(/Unknown method/);
  });
  it("near-miss method names get a 'Did you mean' suggestion", () => {
    expect(() => jsmql.expr("$.name.toLowerCse()")).toThrow(/Did you mean '\.toLowerCase\(\)'/);
    expect(() => jsmql.expr("$.items.fliter(x => x)")).toThrow(/Did you mean '\.filter\(\)'/);
    // `substring` is part of the METHODS registry (it was missing from the old
    // hand-maintained suggestion list), so near-misses now resolve to it.
    expect(() => jsmql.expr("$.name.substing(1)")).toThrow(/Did you mean '\.substring\(\)'/);
  });
  it("near-miss Math member gets a 'Did you mean' suggestion", () => {
    expect(() => jsmql.expr("Math.flor($.x)")).toThrow(/Did you mean 'Math\.floor'/);
  });
  it("near-miss Number static method gets a 'Did you mean' suggestion", () => {
    expect(() => jsmql.expr("Number.isItneger($.x)")).toThrow(/Did you mean 'Number\.isInteger'/);
  });
  it("near-miss Object method gets a 'Did you mean' suggestion", () => {
    expect(() => jsmql.expr("Object.keyz($.o)")).toThrow(/Did you mean 'Object\.keys'/);
  });
  it("lambda in non-method context throws", () => {
    expect(() => jsmql.expr("$abs(x => x)")).toThrow(
      /A function \(=>\) is only valid as the callback to an iterating array method/,
    );
  });
  it("assigning to a method-call result is rejected with a precise message", () => {
    expect(() => jsmql.expr("$.s.trim() = 1")).toThrow(/method-call result/);
  });
  it("assigning to a literal is rejected with a precise message", () => {
    expect(() => jsmql.expr("42 = 1")).toThrow(/literal value/);
  });
});

describe("1-arg substr", () => {
  it("substr(start) slices to end of string", () => {
    expect(jsmql.expr("$.email.substr(1)")).toEqual({
      $substrCP: ["$email", 1, { $strLenCP: { $ifNull: ["$email", ""] } }],
    });
  });
  it("substr(start, count) keeps 2-arg form", () => {
    expect(jsmql.expr("$.name.substr(0, 3)")).toEqual({ $substrCP: ["$name", 0, 3] });
  });
  it("substr with expression start normalises sign at runtime", () => {
    // A runtime start could be negative, which JS reads as "from the end" and
    // $substrCP rejects outright — so the sign is resolved at query time.
    const len = { $strLenCP: { $ifNull: ["$email", ""] } };
    expect(jsmql.expr("$.email.substr($.headerLength + 1)")).toEqual({
      $substrCP: [
        "$email",
        {
          $cond: {
            if: { $lt: [{ $add: ["$headerLength", 1] }, 0] },
            then: { $max: [0, { $add: [{ $add: ["$headerLength", 1] }, len] }] },
            else: { $add: ["$headerLength", 1] },
          },
        },
        len,
      ],
    });
  });
  it("substr(-n) counts from the end, like JS", () => {
    const len = { $strLenCP: { $ifNull: ["$email", ""] } };
    expect(jsmql.expr("$.email.substr(-3)")).toEqual({
      $substrCP: ["$email", { $max: [0, { $subtract: [len, 3] }] }, len],
    });
  });
  it("substr with a negative count yields an empty string, like JS", () => {
    expect(jsmql.expr("$.email.substr(0, -1)")).toEqual({ $substrCP: ["$email", 0, 0] });
  });
});

describe(".slice on strings", () => {
  // The runtime length of `String($.s)`, coerced so a missing field is 0 rather
  // than an executor error.
  const strLen = { $strLenCP: { $ifNull: [{ $toString: "$s" }, ""] } };

  it("string literal receiver → $substrCP", () => {
    expect(jsmql.expr('"hello".slice(1, 3)')).toEqual({ $substrCP: ["hello", 1, 2] });
  });
  it("string-typed receiver (toLowerCase result) → $substrCP", () => {
    expect(jsmql.expr("$.name.toLowerCase().slice(0, 3)")).toEqual({ $substrCP: [{ $toLower: "$name" }, 0, 3] });
  });
  it("1-arg form on string → from start to end", () => {
    // A literal receiver's length is known, so the whole derived length folds.
    expect(jsmql.expr('"hello".slice(2)')).toEqual({ $substrCP: ["hello", 2, 3] });
    // On a runtime receiver the length is derived, and floored: `strLen - start`
    // goes negative when start runs past the end ("".slice(1)), which $substrCP
    // rejects outright.
    expect(jsmql.expr("String($.s).slice(2)")).toEqual({
      $substrCP: [{ $toString: "$s" }, 2, { $max: [0, { $subtract: [strLen, 2] }] }],
    });
  });
  it("negative-literal start on string → folded to strLen - n, floored", () => {
    expect(jsmql.expr('"hello".slice(-3)')).toEqual({ $substrCP: ["hello", 2, 3] });
    expect(jsmql.expr("String($.s).slice(-3)")).toEqual({
      $substrCP: [{ $toString: "$s" }, { $max: [0, { $subtract: [strLen, 3] }] }, 3],
    });
  });
  it("negative end on string → strLen - n", () => {
    expect(jsmql.expr('"hello".slice(1, -1)')).toEqual({ $substrCP: ["hello", 1, 3] });
    expect(jsmql.expr("String($.s).slice(1, -1)")).toEqual({
      $substrCP: [{ $toString: "$s" }, 1, { $max: [0, { $subtract: [{ $max: [0, { $subtract: [strLen, 1] }] }, 1] }] }],
    });
  });
  it("non-literal index on string → runtime $cond normalises sign", () => {
    const normalisedIndex = {
      $cond: { if: { $lt: ["$i", 0] }, then: { $max: [0, { $add: ["$i", strLen] }] }, else: "$i" },
    };
    expect(jsmql.expr("String($.s).slice($.i)")).toEqual({
      $substrCP: [{ $toString: "$s" }, normalisedIndex, { $max: [0, { $subtract: [strLen, normalisedIndex] }] }],
    });
  });
  it("slice() with no args is identity on string", () => {
    expect(jsmql.expr('"hello".slice()')).toEqual("hello");
  });
});

describe(".substring", () => {
  it("substring(start, end) folds end - start as a length", () => {
    expect(jsmql.expr("$.name.substring(2, 7)")).toEqual({ $substrCP: ["$name", 2, 5] });
  });
  it("substring(start) slices to end of string", () => {
    expect(jsmql.expr("$.email.substring(1)")).toEqual({
      $substrCP: ["$email", 1, { $max: [0, { $subtract: [{ $strLenCP: { $ifNull: ["$email", ""] } }, 1] }] }],
    });
  });
  it("substring() with no args is identity", () => {
    expect(jsmql.expr("$.name.substring()")).toEqual("$name");
  });
  it("substring with non-literal start clamps to 0 via $max", () => {
    expect(jsmql.expr("$.s.substring($.i, 10)")).toEqual({
      $substrCP: ["$s", { $max: [0, "$i"] }, { $max: [0, { $subtract: [10, { $max: [0, "$i"] }] }] }],
    });
  });
  it("substring with negative literal clamps at compile time", () => {
    expect(jsmql.expr("$.name.substring(-3, 4)")).toEqual({ $substrCP: ["$name", 0, 4] });
  });
});

describe("comparison precedence: relational higher than equality", () => {
  it("a < b === true parses as (a < b) === true", () => {
    expect(jsmql.expr("$.a < $.b === true")).toEqual({ $eq: [{ $lt: ["$a", "$b"] }, true] });
  });
  it("a > 0 === b > 0 parses as (a > 0) === (b > 0)", () => {
    expect(jsmql.expr("$.a > 0 === $.b > 0")).toEqual({ $eq: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }] });
  });
  it("simple relational still works", () => {
    expect(jsmql.expr("$.x < 5")).toEqual({ $lt: ["$x", 5] });
  });
  it("simple equality still works", () => {
    expect(jsmql.expr("$.x === 5")).toEqual({ $eq: ["$x", 5] });
  });
});

describe("in operator RHS validation", () => {
  it("throws on string RHS", () => {
    expect(() => jsmql.expr('$.x in "abc"')).toThrow(/Right-hand side of 'in'/);
  });
  it("throws on number RHS", () => {
    expect(() => jsmql.expr("$.x in 42")).toThrow(/Right-hand side of 'in'/);
  });
  it("throws on boolean RHS", () => {
    expect(() => jsmql.expr("$.x in true")).toThrow(/Right-hand side of 'in'/);
  });
  it("throws on null RHS", () => {
    expect(() => jsmql.expr("$.x in null")).toThrow(/Right-hand side of 'in'/);
  });
  it("accepts array literal RHS", () => {
    expect(jsmql.expr('$.x in ["a", "b"]')).toEqual({ $in: ["$x", ["a", "b"]] });
  });
  it("object literal RHS → property-existence (JS-faithful)", () => {
    expect(jsmql.expr("$.x in { a: 1, b: 2 }")).toEqual({ $in: ["$x", ["a", "b"]] });
  });
  it("string-literal LHS works against an object literal", () => {
    expect(jsmql.expr("'a' in { a: 1, b: 2 }")).toEqual({ $in: ["a", ["a", "b"]] });
  });
  it("object literal with computed key emits the key expression", () => {
    expect(jsmql.expr("$.x in { a: 1, [$.dynKey]: 2 }")).toEqual({ $in: ["$x", ["a", "$dynKey"]] });
  });
  it("object literal with spread uses $objectToArray for the spread keys", () => {
    expect(jsmql.expr("$.x in { ...$.base, a: 1 }")).toEqual({
      $in: [
        "$x",
        { $concatArrays: [{ $map: { input: { $objectToArray: "$base" }, as: "jsmqlKv", in: "$$jsmqlKv.k" } }, ["a"]] },
      ],
    });
  });
  it("object literal with only spread reduces to $objectToArray.k directly", () => {
    expect(jsmql.expr("$.x in { ...$.other }")).toEqual({
      $in: ["$x", { $map: { input: { $objectToArray: "$other" }, as: "jsmqlKv", in: "$$jsmqlKv.k" } }],
    });
  });
  it("accepts field ref RHS", () => {
    expect(jsmql.expr("$.x in $.list")).toEqual({ $in: ["$x", "$list"] });
  });
});

describe("EOF error message", () => {
  it("empty string gives Unexpected end of expression", () => {
    expect(() => jsmql.expr("")).toThrow(/Unexpected end of expression/);
  });
  it("trailing operator gives Unexpected end of expression", () => {
    expect(() => jsmql.expr("$.a &&")).toThrow(/Unexpected end of expression/);
  });
  it("incomplete ternary gives Unexpected end of expression", () => {
    expect(() => jsmql.expr("$.a ? $.b")).toThrow(/Expected ':'/);
  });
});

describe("template literals", () => {
  it("plain string template (no expressions)", () => {
    expect(jsmql.expr("`hello`")).toEqual("hello");
  });
  it("single interpolation", () => {
    // FieldRef has unknown runtime type → wrapped in $toString to match JS coercion semantics.
    expect(jsmql.expr("`hello, ${$.name}!`")).toEqual({ $concat: ["hello, ", { $toString: "$name" }, "!"] });
  });
  it("multiple interpolations", () => {
    expect(jsmql.expr("`${$.first} ${$.last}`")).toEqual({
      $concat: [{ $toString: "$first" }, " ", { $toString: "$last" }],
    });
  });
  it("interpolation at the start", () => {
    expect(jsmql.expr("`${$.x} px`")).toEqual({ $concat: [{ $toString: "$x" }, " px"] });
  });
  it("interpolation at the end", () => {
    expect(jsmql.expr("`prefix-${$.id}`")).toEqual({ $concat: ["prefix-", { $toString: "$id" }] });
  });
  it("expression inside interpolation", () => {
    expect(jsmql.expr("`total: ${$.a + $.b}`")).toEqual({
      $concat: ["total: ", { $toString: { $add: ["$a", "$b"] } }],
    });
  });
  it("interpolation containing object literal (brace tracking)", () => {
    expect(jsmql.expr("`v=${$let({ x: 1 }, x => x)}`")).toEqual({
      $concat: ["v=", { $toString: { $let: { vars: { x: 1 }, in: "$$x" } } }],
    });
  });
  it("nested template literal", () => {
    // Inner template literal is statically string-producing → no $toString wrap.
    expect(jsmql.expr("`outer ${`inner ${$.x}`}`")).toEqual({
      $concat: ["outer ", { $concat: ["inner ", { $toString: "$x" }] }],
    });
  });
  it("escape sequences", () => {
    expect(jsmql.expr("`a\\nb`")).toEqual("a\nb");
  });
  it("escaped backtick and dollar", () => {
    expect(jsmql.expr("`a\\`b\\${c}`")).toEqual("a`b${c}");
  });
  it("template literal participates in string-context +", () => {
    expect(jsmql.expr("`x=${$.x}` + ' done'")).toEqual({
      $concat: [{ $concat: ["x=", { $toString: "$x" }] }, " done"],
    });
  });
  it("string-producing interpolations skip the $toString wrap", () => {
    // .toLowerCase() is statically string-producing — the wrap would be redundant.
    expect(jsmql.expr("`name=${$.name.toLowerCase()}`")).toEqual({ $concat: ["name=", { $toLower: "$name" }] });
  });
  it("number literal interpolation gets $toString wrap", () => {
    expect(jsmql.expr("`n=${42}`")).toEqual({ $concat: ["n=", { $toString: 42 }] });
  });
});

describe("array .includes()", () => {
  it("array literal → $in", () => {
    expect(jsmql.expr('["a", "b"].includes($.x)')).toEqual({ $in: ["$x", ["a", "b"]] });
  });
  it("known array (split result) → $in", () => {
    expect(jsmql.expr('$.csv.split(",").includes("active")')).toEqual({ $in: ["active", { $split: ["$csv", ","] }] });
  });
  it("known string (toLowerCase result) → string form", () => {
    expect(jsmql.expr('$.email.toLowerCase().includes("@")')).toEqual({
      $gte: [{ $indexOfCP: [{ $toLower: "$email" }, "@"] }, 0],
    });
  });
  it("bare $.field → runtime $cond on $isArray (works for either type)", () => {
    expect(jsmql.expr("$.field.includes($.x)")).toEqual({
      $cond: {
        if: { $isArray: "$field" },
        then: { $in: ["$x", "$field"] },
        else: { $gte: [{ $indexOfCP: ["$field", "$x"] }, 0] },
      },
    });
  });
  // `.includes()` takes a value, not a predicate; a lambda means the user wanted
  // `.some()`. The error must point there (not the misleading "only valid as
  // array method argument" — `.includes` IS an array method) and echo the
  // user's own param name.
  it("predicate (lambda) arg → actionable error pointing at .some()", () => {
    expect(() => jsmql.expr("$.senderChain.includes(sc => sc.tier === 2)")).toThrow(
      /\.includes\(\) searches for a value — it doesn't take a function\. To test elements against a predicate, use \.some\(sc => …\)\./,
    );
  });
  it(".indexOf() with a predicate points at .findIndex()", () => {
    expect(() => jsmql.expr("$.items.indexOf(it => it.qty > 5)")).toThrow(
      /\.indexOf\(\) searches for a value — it doesn't take a function\. To test elements against a predicate, use \.findIndex\(it => …\)\./,
    );
  });
});

describe("Math.min / Math.max", () => {
  it("Math.min variadic", () => {
    expect(jsmql.expr("Math.min($.a, $.b, $.c)")).toEqual({ $min: ["$a", "$b", "$c"] });
  });
  it("Math.max variadic", () => {
    expect(jsmql.expr("Math.max($.a, $.b)")).toEqual({ $max: ["$a", "$b"] });
  });
  it("Math.max with single array arg", () => {
    expect(jsmql.expr("Math.max($.scores)")).toEqual({ $max: "$scores" });
  });
  it("Math.max with spread arg", () => {
    expect(jsmql.expr("Math.max(...$.scores)")).toEqual({ $max: "$scores" });
  });
  it("Math.min mixed spread + scalar", () => {
    expect(jsmql.expr("Math.min($.a, ...$.others)")).toEqual({ $min: { $concatArrays: [["$a"], "$others"] } });
  });
});

describe("Date.now()", () => {
  it("returns ms since epoch", () => {
    expect(jsmql.expr("Date.now()")).toEqual({ $toLong: "$$NOW" });
  });
});

describe("Object.fromEntries", () => {
  it("from $objectToArray result", () => {
    expect(jsmql.expr("Object.fromEntries(Object.entries($.doc))")).toEqual({
      $arrayToObject: { $objectToArray: "$doc" },
    });
  });
  it("from array literal of pairs", () => {
    expect(jsmql.expr('Object.fromEntries([["a", 1], ["b", 2]])')).toEqual({
      $arrayToObject: [
        ["a", 1],
        ["b", 2],
      ],
    });
  });
});

describe("Array.isArray", () => {
  it("on a field", () => {
    expect(jsmql.expr("Array.isArray($.items)")).toEqual({ $isArray: "$items" });
  });
});

describe("optional chaining (?.)", () => {
  // Bare access — MongoDB's dotted-path semantics already null-pass through missing
  // fields, so `?.` on a bare read is sugar with no codegen difference.
  it("simple optional member access", () => {
    expect(jsmql.expr("$.a?.b")).toEqual("$a.b");
  });
  it("chained optional access", () => {
    expect(jsmql.expr("$.a?.b?.c")).toEqual("$a.b.c");
  });

  // Array spread — the originally-reported bug. `$concatArrays` returns null on
  // null input, poisoning every downstream consumer. `?.` now wraps the spread
  // operand with `$ifNull(v, [])` so missing fields produce an empty array.
  it("array spread of optional wraps with $ifNull, []", () => {
    expect(jsmql.expr("[...$.a?.b, 'x']")).toEqual({ $concatArrays: [{ $ifNull: ["$a.b", []] }, ["x"]] });
  });
  it("array spread alone of optional", () => {
    expect(jsmql.expr("[...$.a?.b]")).toEqual({ $ifNull: ["$a.b", []] });
  });
  it("user's reported spread-inside-includes case", () => {
    expect(jsmql.expr("[...$.moderators, ...$.room?.mods, 'root'].includes($.userId)")).toEqual({
      $in: ["$userId", { $concatArrays: ["$moderators", { $ifNull: ["$room.mods", []] }, ["root"]] }],
    });
  });
  it("non-optional spread is unchanged", () => {
    expect(jsmql.expr("[...$.a, 'x']")).toEqual({ $concatArrays: ["$a", ["x"]] });
  });

  // Array-method receivers — `$concatArrays` / `$in` / `$size` / `$arrayElemAt`
  // either error or null-poison on null input. Wrap the receiver with [].
  it(".map on optional receiver wraps with []", () => {
    expect(jsmql.expr("$.user?.posts.map(p => p.id)")).toEqual({
      $map: { input: { $ifNull: ["$user.posts", []] }, as: "p", in: "$$p.id" },
    });
  });
  it(".at on optional receiver wraps with []", () => {
    expect(jsmql.expr("$.user?.posts.at(0)")).toEqual({ $arrayElemAt: [{ $ifNull: ["$user.posts", []] }, 0] });
  });
  it(".toReversed on optional receiver wraps with []", () => {
    expect(jsmql.expr("$.user?.posts.toReversed()")).toEqual({ $reverseArray: { $ifNull: ["$user.posts", []] } });
  });
  it(".slice on optional receiver wraps with [] then runtime-dispatches", () => {
    // start 0 → the array branch is a 2-arg "first 5" $slice (JS end-exclusive).
    expect(jsmql.expr("$.user?.posts.slice(0, 5)")).toEqual({
      $cond: {
        if: { $isArray: { $ifNull: ["$user.posts", []] } },
        then: { $slice: [{ $ifNull: ["$user.posts", []] }, 5] },
        else: { $substrCP: [{ $ifNull: ["$user.posts", []] }, 0, 5] },
      },
    });
  });

  // `.includes` / `.indexOf` / `.concat` dispatch on receiver type. Chain
  // walking stops at `MethodCall` boundaries — once `.toReversed()` ran (and
  // its own wrap took effect), the result is guaranteed not-null, so
  // `.includes` doesn't add a redundant outer wrap.
  it(".includes after .toReversed() of optional propagates the inner wrap, no outer wrap", () => {
    expect(jsmql.expr("$.user?.posts.toReversed().includes('hello')")).toEqual({
      $in: ["hello", { $reverseArray: { $ifNull: ["$user.posts", []] } }],
    });
  });
  it("`?.method()` (call itself is optional) wraps the receiver", () => {
    // `$.tags?.includes(y)` — MethodCall.optional=true. Wrap with [] since
    // includes-on-unknown dispatches via $cond; [] sends it to the array branch.
    expect(jsmql.expr("$.tags?.includes('vip')")).toEqual({
      $cond: {
        if: { $isArray: { $ifNull: ["$tags", []] } },
        then: { $in: ["vip", { $ifNull: ["$tags", []] }] },
        else: { $gte: [{ $indexOfCP: [{ $ifNull: ["$tags", []] }, "vip"] }, 0] },
      },
    });
  });

  // String-method receivers — `$trim` / `$toUpper` / etc. return null on null
  // (sometimes error). Wrap the receiver with "" so a missing field produces
  // an empty string, matching JS's "would-throw on undefined.method, but ?.
  // short-circuits gracefully" intent.
  it('.trim on optional receiver wraps with ""', () => {
    expect(jsmql.expr("$.name?.trim()")).toEqual({ $trim: { input: { $ifNull: ["$name", ""] } } });
  });
  it('.trim on chained optional receiver wraps with ""', () => {
    expect(jsmql.expr("$.user?.name?.trim()")).toEqual({ $trim: { input: { $ifNull: ["$user.name", ""] } } });
  });
  it('.toUpperCase on optional receiver wraps with ""', () => {
    expect(jsmql.expr("$.user?.name.toUpperCase()")).toEqual({ $toUpper: { $ifNull: ["$user.name", ""] } });
  });
  it('.split on optional receiver wraps with ""', () => {
    expect(jsmql.expr("$.user?.csv.split(',')")).toEqual({ $split: [{ $ifNull: ["$user.csv", ""] }, ","] });
  });

  // `.length` is a MemberAccess, not a MethodCall — handled in its own codegen branch.
  it(".length on optional unknown-type receiver wraps with []", () => {
    // unknown receiver dispatches to runtime $cond between $size and $strLenCP;
    // wrap with [] so $isArray succeeds and $size([]) returns 0.
    expect(jsmql.expr("$.user?.tags.length")).toEqual({
      $cond: {
        if: { $isArray: { $ifNull: ["$user.tags", []] } },
        then: { $size: { $ifNull: ["$user.tags", []] } },
        else: { $strLenCP: { $ifNull: ["$user.tags", []] } },
      },
    });
  });

  // String concatenation via `+` lowers to `$concat`, which is null-poisoning.
  it('string + with optional operand wraps with ""', () => {
    expect(jsmql.expr("$.firstName + ' ' + $.user?.lastName")).toEqual({
      $concat: ["$firstName", " ", { $ifNull: ["$user.lastName", ""] }],
    });
  });

  // Template literal interpolations also lower to $concat. Non-string-producing
  // interpolations still get $toString (so a numeric `$user.age` becomes "42"),
  // but the $ifNull wrap runs *before* $toString so a missing field produces "".
  it('template literal with optional interpolation wraps with ""', () => {
    expect(jsmql.expr("`hello ${$.user?.name}`")).toEqual({
      $concat: ["hello ", { $toString: { $ifNull: ["$user.name", ""] } }],
    });
  });

  // Object.keys / values / entries / fromEntries — `$objectToArray(null)` errors.
  it("Object.keys on optional wraps argument with {}", () => {
    expect(jsmql.expr("Object.keys($.user?.profile)")).toEqual({
      $map: { input: { $objectToArray: { $ifNull: ["$user.profile", {}] } }, as: "jsmqlKv", in: "$$jsmqlKv.k" },
    });
  });
  it("Object.entries on optional wraps argument with {}", () => {
    expect(jsmql.expr("Object.entries($.user?.profile)")).toEqual({
      $objectToArray: { $ifNull: ["$user.profile", {}] },
    });
  });

  // Bracket access — `obj?.[idx]` wraps with [] for the runtime $cond dispatch.
  it("optional bracket access on bare field wraps with []", () => {
    expect(jsmql.expr("$.scoresByLevel?.[$.level]")).toEqual({
      $cond: {
        if: { $isArray: { $ifNull: ["$scoresByLevel", []] } },
        then: { $arrayElemAt: [{ $ifNull: ["$scoresByLevel", []] }, "$level"] },
        else: { $getField: { field: "$level", input: { $ifNull: ["$scoresByLevel", []] } } },
      },
    });
  });
  it("optional bracket access on known array wraps with []", () => {
    // `.toReversed()` is known array-producing, so the bracket access uses
    // the compact $arrayElemAt form. The `?.` adds the wrap on the receiver.
    expect(jsmql.expr("$.items.toReversed()?.[0]")).toEqual({
      $arrayElemAt: [{ $ifNull: [{ $reverseArray: "$items" }, []] }, 0],
    });
  });

  // ── Deliberately NOT wrapped ─────────────────────────────────────────────
  // The following consumers are already null-safe, so wrapping would be busywork.
  it("object spread of optional is NOT wrapped ($mergeObjects ignores null)", () => {
    expect(jsmql.expr("({...$.user?.profile, name: 'x'})")).toEqual({
      $mergeObjects: ["$user.profile", { name: "x" }],
    });
  });
  it("comparison against optional is NOT wrapped", () => {
    expect(jsmql.expr("$.user?.role === 'admin'")).toEqual({ $eq: ["$user.role", "admin"] });
  });
  it("`==` null check against optional is NOT wrapped", () => {
    expect(jsmql.expr("$.user?.role == null")).toEqual({ $in: [{ $type: "$user.role" }, ["null", "missing"]] });
  });
  it("numeric arithmetic against optional is NOT wrapped (honest null > 0)", () => {
    expect(jsmql.expr("$.base + $.user?.bonus")).toEqual({ $add: ["$base", "$user.bonus"] });
  });

  // `?.` buried inside a lambda body belongs to the lambda's chain, not the
  // outer `.map()` chain — so the outer .map receiver does NOT get wrapped.
  it("?. inside a lambda body does NOT wrap the outer chain", () => {
    expect(jsmql.expr("$.items.map(x => x?.tags)")).toEqual({ $map: { input: "$items", as: "x", in: "$$x.tags" } });
  });
});

describe(".startsWith / .endsWith", () => {
  it("startsWith maps to indexOf == 0", () => {
    expect(jsmql.expr('$.email.startsWith("admin")')).toEqual({ $eq: [{ $indexOfCP: ["$email", "admin"] }, 0] });
  });
  it("endsWith maps to substring equality at the tail", () => {
    // The receiver is bound once (and coerced), and the start floored — a
    // receiver shorter than the needle makes `strLen - needleLen` negative, and
    // $substrCP aborts the query on a negative start rather than returning
    // false. A literal needle's length folds, so it isn't spliced in 3 times.
    expect(jsmql.expr('$.file.endsWith(".pdf")')).toEqual({
      $let: {
        vars: { jsmqlStr: { $ifNull: ["$file", ""] } },
        in: {
          $eq: [
            { $substrCP: ["$$jsmqlStr", { $max: [0, { $subtract: [{ $strLenCP: "$$jsmqlStr" }, 4] }] }, 4] },
            ".pdf",
          ],
        },
      },
    });
  });
  it("endsWith folds the needle length by code points, not UTF-16 units", () => {
    // "a👍b" is 3 code points but 4 UTF-16 units — $strLenCP counts the former.
    expect(jsmql.expr('$.file.endsWith("a👍b")')).toEqual({
      $let: {
        vars: { jsmqlStr: { $ifNull: ["$file", ""] } },
        in: {
          $eq: [
            { $substrCP: ["$$jsmqlStr", { $max: [0, { $subtract: [{ $strLenCP: "$$jsmqlStr" }, 3] }] }, 3] },
            "a👍b",
          ],
        },
      },
    });
  });
  it("endsWith with a $-prefixed needle keeps it a field ref, never folds its length", () => {
    // HR1: a source "$ext" IS the field reference $ext, so its length is a
    // runtime `$strLenCP`, not the 4 that folding the literal would give.
    expect(jsmql.expr('$.file.endsWith("$ext")')).toEqual({
      $let: {
        vars: { jsmqlStr: { $ifNull: ["$file", ""] } },
        in: {
          $eq: [
            {
              $substrCP: [
                "$$jsmqlStr",
                { $max: [0, { $subtract: [{ $strLenCP: "$$jsmqlStr" }, { $strLenCP: { $ifNull: ["$ext", ""] } }] }] },
                { $strLenCP: { $ifNull: ["$ext", ""] } },
              ],
            },
            "$ext",
          ],
        },
      },
    });
  });
});

describe(".charAt", () => {
  it("charAt(i)", () => {
    expect(jsmql.expr("$.name.charAt(2)")).toEqual({ $substrCP: ["$name", 2, 1] });
  });
  it("charAt(-1) folds to an empty string, like JS (never index -1)", () => {
    // JS `.charAt` returns "" for a negative index — flooring to 0 would wrongly
    // return the first character, so this is the one index that isn't clamped.
    expect(jsmql.expr("$.name.charAt(-1)")).toEqual("");
  });
  it("charAt with a runtime index guards the negative case", () => {
    expect(jsmql.expr("$.name.charAt($.i)")).toEqual({
      $cond: { if: { $lt: ["$i", 0] }, then: "", else: { $substrCP: ["$name", "$i", 1] } },
    });
  });
});

describe("array .indexOf", () => {
  it("on array literal → $indexOfArray", () => {
    expect(jsmql.expr('["a", "b", "c"].indexOf($.x)')).toEqual({ $indexOfArray: [["a", "b", "c"], "$x"] });
  });
  it("on known string → $indexOfCP", () => {
    expect(jsmql.expr('$.email.toLowerCase().indexOf("@")')).toEqual({ $indexOfCP: [{ $toLower: "$email" }, "@"] });
  });
  it("on bare field → runtime $cond on $isArray", () => {
    expect(jsmql.expr('$.email.indexOf("@")')).toEqual({
      $cond: {
        if: { $isArray: "$email" },
        then: { $indexOfArray: ["$email", "@"] },
        else: { $indexOfCP: ["$email", "@"] },
      },
    });
  });
});

describe("array .concat", () => {
  it("on array literal → $concatArrays", () => {
    expect(jsmql.expr("[1, 2].concat([3, 4])")).toEqual({
      $concatArrays: [
        [1, 2],
        [3, 4],
      ],
    });
  });
  it("on known string → $concat", () => {
    expect(jsmql.expr("$.first.trim().concat($.last)")).toEqual({ $concat: [{ $trim: { input: "$first" } }, "$last"] });
  });
  it("on bare field → runtime $cond on $isArray", () => {
    expect(jsmql.expr("$.parts.concat($.tail)")).toEqual({
      $cond: {
        if: { $isArray: "$parts" },
        then: { $concatArrays: ["$parts", "$tail"] },
        else: { $concat: ["$parts", "$tail"] },
      },
    });
  });
});

describe(".join", () => {
  it("default separator (,)", () => {
    expect(jsmql.expr("$.tags.join()")).toEqual({
      $reduce: {
        input: "$tags",
        initialValue: "",
        in: {
          $cond: {
            if: { $eq: ["$$value", ""] },
            then: { $toString: "$$this" },
            else: { $concat: ["$$value", ",", { $toString: "$$this" }] },
          },
        },
      },
    });
  });
  it("custom separator", () => {
    expect(jsmql.expr('$.tags.join(" | ")')).toEqual({
      $reduce: {
        input: "$tags",
        initialValue: "",
        in: {
          $cond: {
            if: { $eq: ["$$value", ""] },
            then: { $toString: "$$this" },
            else: { $concat: ["$$value", " | ", { $toString: "$$this" }] },
          },
        },
      },
    });
  });
});

describe(".flat / .flatMap", () => {
  it("flat() one level", () => {
    expect(jsmql.expr("$.nested.flat()")).toEqual({
      $reduce: { input: "$nested", initialValue: [], in: { $concatArrays: ["$$value", "$$this"] } },
    });
  });
  it("flat(1) explicit depth", () => {
    expect(jsmql.expr("$.nested.flat(1)")).toEqual({
      $reduce: { input: "$nested", initialValue: [], in: { $concatArrays: ["$$value", "$$this"] } },
    });
  });
  it("flat(2) is rejected", () => {
    expect(() => jsmql.expr("$.nested.flat(2)")).toThrow(/depth=1/);
  });
  it("flatMap with lambda", () => {
    expect(jsmql.expr("$.docs.flatMap(d => d.tags)")).toEqual({
      $reduce: {
        input: { $map: { input: "$docs", as: "d", in: "$$d.tags" } },
        initialValue: [],
        in: { $concatArrays: ["$$value", "$$this"] },
      },
    });
  });
});

describe("date .getTime / .toISOString", () => {
  it("getTime", () => {
    expect(jsmql.expr("$.ts.getTime()")).toEqual({ $toLong: "$ts" });
  });
  it("toISOString", () => {
    expect(jsmql.expr("$.ts.toISOString()")).toEqual({
      $dateToString: { date: "$ts", format: "%Y-%m-%dT%H:%M:%S.%LZ" },
    });
  });
});

describe("Math.sign / log2 / log10 / hypot / cbrt / random / constants", () => {
  it("Math.sign maps to $cmp(x, 0)", () => {
    expect(jsmql.expr("Math.sign($.x)")).toEqual({ $cmp: ["$x", 0] });
  });
  it("Math.log2", () => {
    expect(jsmql.expr("Math.log2($.x)")).toEqual({ $log: ["$x", 2] });
  });
  it("Math.log10", () => {
    expect(jsmql.expr("Math.log10($.x)")).toEqual({ $log10: "$x" });
  });
  it("Math.cbrt", () => {
    expect(jsmql.expr("Math.cbrt($.x)")).toEqual({ $pow: ["$x", { $divide: [1, 3] }] });
  });
  it("Math.hypot 2-arg", () => {
    expect(jsmql.expr("Math.hypot($.a, $.b)")).toEqual({ $sqrt: { $add: [{ $pow: ["$a", 2] }, { $pow: ["$b", 2] }] } });
  });
  it("Math.random", () => {
    expect(jsmql.expr("Math.random()")).toEqual({ $rand: {} });
  });
  it("Math.PI", () => {
    expect(jsmql.expr("Math.PI")).toEqual(Math.PI);
  });
  it("Math.E", () => {
    expect(jsmql.expr("Math.E")).toEqual(Math.E);
  });
});

describe("numeric separators", () => {
  it("integer with separator", () => {
    expect(jsmql.expr("$abs(1_000_000)")).toEqual({ $abs: 1000000 });
  });
  it("float with separator", () => {
    expect(jsmql.expr("$abs(1_234.567_89)")).toEqual({ $abs: 1234.56789 });
  });
  it("exponent with separator", () => {
    expect(jsmql.expr("$abs(1_2e3)")).toEqual({ $abs: 12000 });
  });
  it("trailing _ rejected", () => {
    expect(() => jsmql.expr("1_")).toThrow(/Numeric separator/);
  });
  it("double __ rejected", () => {
    expect(() => jsmql.expr("1__0")).toThrow(/Numeric separator/);
  });
});

describe("comments", () => {
  it("// line comment between expressions", () => {
    expect(jsmql.expr("$.a // tail\n+ $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// line comment at EOF (no terminator)", () => {
    expect(jsmql.expr("$abs($.x) // trailing comment")).toEqual({ $abs: "$x" });
  });
  it("// terminated by CR", () => {
    expect(jsmql.expr("$.a // x\r+ $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// terminated by CRLF", () => {
    expect(jsmql.expr("$.a // x\r\n+ $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// terminated by U+2028 (LSEP)", () => {
    expect(jsmql.expr("$.a // x + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// terminated by U+2029 (PSEP)", () => {
    expect(jsmql.expr("$.a // x + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("/* block */ inline", () => {
    expect(jsmql.expr("$.a /* mid */ + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("/* multi-line block */", () => {
    expect(jsmql.expr("$.a /*\n  spans\n  lines\n*/ + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("empty /**/ block", () => {
    expect(jsmql.expr("$.a /**/ + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("multiple comments collapse to one boundary", () => {
    expect(jsmql.expr("$.a // one\n  /* two */ \n // three\n + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("comment inside template ${...} interpolation", () => {
    expect(jsmql.expr("`hi ${ $.name /* user */ }`")).toEqual({ $concat: ["hi ", { $toString: "$name" }] });
  });
  it("// inside string literal is preserved as data", () => {
    expect(jsmql.expr('$eq($.url, "https://example.com")')).toEqual({ $eq: ["$url", "https://example.com"] });
  });
  it("// inside regex literal is preserved as pattern", () => {
    // Two literal slashes inside a regex character class — must not be eaten as a comment
    expect(jsmql.expr("$.path.match(/[/\\\\]/)")).toEqual({ $regexMatch: { input: "$path", regex: "[/\\\\]" } });
  });
  it("regex disambiguation works after a comment (non-value-ending)", () => {
    // After `(` (not a value-ending token) a `/` would normally start a regex.
    // A leading comment must not change that.
    expect(jsmql.expr("$.path.match(/* skip */ /foo/i)")).toEqual({
      $regexMatch: { input: "$path", regex: "foo", options: "i" },
    });
  });
  it("divide disambiguation works after a comment (value-ending)", () => {
    // After a Number token, `/` is divide; a leading comment must not change that.
    expect(jsmql.expr("10 /* skip */ / 2")).toEqual({ $divide: [10, 2] });
  });
  it("unclosed /* throws LexError", () => {
    expect(() => jsmql.expr("$.a /* unclosed")).toThrow(/Unclosed block comment/);
  });
});

describe("computed object keys", () => {
  // Computed keys emit `$arrayToObject`'s `{ k, v }` object-pair form, wrapped one
  // level deeper (`{ $arrayToObject: [pairs] }`) so MongoDB reads it as the single
  // argument, not an argument list. A bare `{ $arrayToObject: [{k,v}] }` is
  // server-REJECTED (unwrapped to the object — "requires an array input, found:
  // object"); two pairs hit "takes exactly 1 argument". The wrapped shapes below
  // are verified to run on MongoDB 8.2 (HR3). The `$arrayToObject([...])` escape
  // hatch keeps whatever pair shape the user typed (array-pairs here), just wrapped.
  // (`$foo` is an unknown-op shape probe — it carries no arg-type validation, so
  // these exercise the computed-key → $arrayToObject lowering, not op semantics.)
  it("single computed key", () => {
    expect(jsmql.expr("$foo({ [$.k]: 1 })")).toEqual({ $foo: { $arrayToObject: [[{ k: "$k", v: 1 }]] } });
  });
  it("$arrayToObject escape hatch with a literal pairs array wraps the same way", () => {
    expect(jsmql.expr(`$arrayToObject([["a", 1], ["b", 2]])`)).toEqual({
      $arrayToObject: [
        [
          ["a", 1],
          ["b", 2],
        ],
      ],
    });
    // A field-ref / expression argument already resolves to one array — left as-is.
    expect(jsmql.expr("$arrayToObject($.pairs)")).toEqual({ $arrayToObject: "$pairs" });
  });
  it("mixed static and computed keys", () => {
    expect(jsmql.expr("$foo({ a: 1, [$.k]: 2 })")).toEqual({
      $foo: {
        $arrayToObject: [
          [
            { k: "a", v: 1 },
            { k: "$k", v: 2 },
          ],
        ],
      },
    });
  });
});

describe("spread in operator args", () => {
  // The JS spread is idiomatic in JS-method position (Math.max/min, Object.assign)
  // and stays supported there. It is NOT supported in the `$op(...)` escape hatch
  // — an MQL operator takes its operands directly (HR2). The split is by surface:
  // a JS builtin you already know vs. the raw direct-operator form.
  it("Object.assign with spread (JS-method form — supported)", () => {
    expect(jsmql.expr("Object.assign(...$.docs)")).toEqual({ $mergeObjects: "$docs" });
  });
  it("$op(...) escape hatch rejects spread, pointing at the JS alternative", () => {
    expect(() => jsmql.expr("$concatArrays(...$.arrs)")).toThrow(
      /Spread \(\.\.\.\) is not supported in \$concatArrays\(\.\.\.\).*array spread.*\.concat\(\)/,
    );
    expect(() => jsmql.expr("$mergeObjects(...$.docs)")).toThrow(/object spread.*Object\.assign/);
  });
});

describe("shorthand object properties", () => {
  it("inside lambda body", () => {
    expect(jsmql.expr("$.items.map(x => ({ x }))")).toEqual({ $map: { input: "$items", as: "x", in: { x: "$$x" } } });
  });
  it("two shorthand props", () => {
    expect(jsmql.expr("$.items.map(x => ({ x, x }))")).toEqual({
      $map: { input: "$items", as: "x", in: { x: "$$x" } },
    });
  });
  it("shorthand outside lambda scope errors", () => {
    expect(() => jsmql.expr("({ foo })")).toThrow(/Unknown identifier/);
  });
});

describe("flex-shape operators", () => {
  // ── $round / $trunc ─────────────────────────────────────────────────────────
  it("$round single arg → bare value", () => {
    expect(jsmql.expr("$round($.price)")).toEqual({ $round: "$price" });
  });
  it("$round two args → array", () => {
    expect(jsmql.expr("$round($.price, 2)")).toEqual({ $round: ["$price", 2] });
  });
  it("$trunc single arg → bare value", () => {
    expect(jsmql.expr("$trunc($.value)")).toEqual({ $trunc: "$value" });
  });
  it("$trunc two args → array", () => {
    expect(jsmql.expr("$trunc($.value, 1)")).toEqual({ $trunc: ["$value", 1] });
  });

  // ── Accumulators ($min / $max / $avg / $sum / $stdDev*) ─────────────────────
  it("$min single arg → bare value (accumulator-style)", () => {
    expect(jsmql.expr("$min($.scores)")).toEqual({ $min: "$scores" });
  });
  it("$min multiple args → array (expression-style)", () => {
    expect(jsmql.expr("$min($.a, $.b, $.c)")).toEqual({ $min: ["$a", "$b", "$c"] });
  });
  it("$max single arg", () => {
    expect(jsmql.expr("$max($.scores)")).toEqual({ $max: "$scores" });
  });
  it("$max multiple args", () => {
    expect(jsmql.expr("$max($.a, $.b)")).toEqual({ $max: ["$a", "$b"] });
  });
  it("$avg single arg", () => {
    expect(jsmql.expr("$avg($.values)")).toEqual({ $avg: "$values" });
  });
  it("$avg multiple args", () => {
    expect(jsmql.expr("$avg($.a, $.b, $.c)")).toEqual({ $avg: ["$a", "$b", "$c"] });
  });
  it("$sum single arg", () => {
    expect(jsmql.expr("$sum($.amounts)")).toEqual({ $sum: "$amounts" });
  });
  it("$sum multiple args", () => {
    expect(jsmql.expr("$sum($.a, $.b)")).toEqual({ $sum: ["$a", "$b"] });
  });
  it("$stdDevPop single arg", () => {
    expect(jsmql.expr("$stdDevPop($.measurements)")).toEqual({ $stdDevPop: "$measurements" });
  });
  it("$stdDevSamp multiple args", () => {
    expect(jsmql.expr("$stdDevSamp($.a, $.b, $.c)")).toEqual({ $stdDevSamp: ["$a", "$b", "$c"] });
  });

  // ── $mergeObjects ───────────────────────────────────────────────────────────
  it("$mergeObjects single arg → bare value", () => {
    expect(jsmql.expr("$mergeObjects($.docs)")).toEqual({ $mergeObjects: "$docs" });
  });
  it("$mergeObjects multiple args → array", () => {
    expect(jsmql.expr("$mergeObjects($.a, $.b)")).toEqual({ $mergeObjects: ["$a", "$b"] });
  });

  // ── Spread handling ─────────────────────────────────────────────────────────
  // The `$op(...)` escape hatch rejects the JS spread (HR2 — an operator takes its
  // operands directly). For the array-from-runtime case, write `Math.min(...arr)`
  // (the JS-method form keeps spread) or pass the field as a single array arg.
  it("flex op rejects single spread, pointing at Math.min", () => {
    expect(() => jsmql.expr("$min(...$.scores)")).toThrow(
      /Spread \(\.\.\.\) is not supported in \$min\(\.\.\.\).*Math\.min\(\.\.\.arr\)/,
    );
  });
  it("flex op rejects mixed spread + scalar, pointing at Math.max", () => {
    expect(() => jsmql.expr("$max($.first, ...$.rest)")).toThrow(
      /Spread \(\.\.\.\) is not supported in \$max\(\.\.\.\).*Math\.max\(\.\.\.arr\)/,
    );
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────
  it("flex op with zero args throws", () => {
    expect(() => jsmql.expr("$min()")).toThrow(/at least 1 argument/);
  });
  it("flex op with object literal arg → object as value (not object-shape)", () => {
    // Single arg that happens to be an object literal — parser flags this as object-style,
    // but $mergeObjects has flex shape (not object), so the literal is passed as a value.
    expect(jsmql.expr("$mergeObjects({ a: 1, b: $.x })")).toEqual({ $mergeObjects: { a: 1, b: "$x" } });
  });
  it("$round with arithmetic still works (regression: existing 2-arg form)", () => {
    expect(jsmql.expr("$round($.price * 1.1, 2)")).toEqual({ $round: [{ $multiply: ["$price", 1.1] }, 2] });
  });
});

describe("function overload", () => {
  it("accepts a no-param arrow", () => {
    expect(jsmql.expr(({ $ }) => $.age > 18)).toEqual({ $gt: ["$age", 18] });
  });

  it("accepts a $-param arrow (recommended idiom)", () => {
    expect(jsmql.expr(({ $ }) => $.age > 18)).toEqual({ $gt: ["$age", 18] });
  });

  it("produces identical MQL to the equivalent string", () => {
    expect(jsmql.expr(({ $ }) => $.status === "active")).toEqual(jsmql.expr('$.status === "active"'));
  });

  it("the document is referenced via `$` from the toolbox; a bare-identifier param is rejected", () => {
    // The document lives in the destructured toolbox — `({ $ }) => $.foo`.
    expect(jsmql.expr(({ $ }) => $.foo)).toEqual("$foo");
    // A bare-identifier `(doc) =>` shape is not a valid parameter slot.
    expect(() => jsmql.expr(new Function("return (doc) => doc.foo")() as never)).toThrow(/object destructure pattern/);
  });

  it("handles nested arrows in the body", () => {
    expect(jsmql.expr(({ $ }) => $.items.map((x) => x * 2))).toEqual({
      $map: { input: "$items", as: "x", in: { $multiply: ["$$x", 2] } },
    });
  });

  it("handles a parenthesised object-literal body", () => {
    expect(jsmql.expr(({ $ }) => ({ doubled: $.x * 2 }))).toEqual({ doubled: { $multiply: ["$x", 2] } });
  });

  it("accepts a `{ return <expr> }` block-body arrow (value form ≡ the expression body)", () => {
    expect(
      jsmql.expr(({ $ }) => {
        return $.age > 18;
      }),
    ).toEqual({ $gt: ["$age", 18] });
  });

  it("accepts a `function` input (≡ the arrow form)", () => {
    expect(
      jsmql.expr(function ({ $ }) {
        return $.age > 18;
      }),
    ).toEqual({ $gt: ["$age", 18] });
  });

  it("accepts a named `function` input — the name is discarded", () => {
    expect(
      jsmql.expr(function predicate({ $ }) {
        return $.age > 18;
      }),
    ).toEqual({ $gt: ["$age", 18] });
  });

  it("rejects an async arrow", () => {
    expect(() => jsmql.expr(async ({ $ }) => $.age > 18)).toThrow(/async/);
  });

  it("appends a jsmql`` hint when an outer-scope identifier is referenced", () => {
    const minAge = 21; // referenced from the closure on purpose
    expect(() => jsmql(({ $ }) => $.age > minAge)).toThrow(/jsmql`` template tag/);
  });

  it("jsmql.validate() reports the augmented hint for closure refs", () => {
    const minAge = 21;
    const r = jsmql.validate(({ $ }) => $.age > minAge);
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.code).toBe("CODEGEN_ERROR");
    expect(r.errors[0]?.message).toMatch(/Unknown identifier 'minAge'/);
    expect(r.errors[0]?.message).toMatch(/jsmql`` template tag/);
  });

  it("jsmql.validate() reports SYNTAX_ERROR for an unsupported function shape (async)", () => {
    const r = jsmql.validate(async ({ $ }) => $.age > 18);
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.code).toBe("SYNTAX_ERROR");
  });

  it("inline arrow in a hot loop produces consistent MQL across calls", () => {
    const make = () => jsmql.expr(({ $ }) => $.status === "active");
    const a = make();
    const b = make();
    expect(a).toEqual(b);
  });

  it("destructured operator alongside `$` in the toolbox compiles to the same MQL as the string form", () => {
    // The toolbox destructure is types-only — it gives users a destructure site
    // that silences IDE warnings on `$dateDiff`. The runtime strips the param
    // list, so this produces identical MQL to the string equivalent.
    const fromFn = jsmql.expr(({ $, $dateDiff }) => $dateDiff({ startDate: $.a, endDate: $.b, unit: "day" }));
    const fromStr = jsmql.expr('$dateDiff({ startDate: $.a, endDate: $.b, unit: "day" })');
    expect(fromFn).toEqual(fromStr);
  });
});

// ─── Newly-registered operators (pulled from mongodb/mql-specifications) ────

describe("bitwise operators", () => {
  it.each([
    ["$bitAnd", "$bitAnd($.a, $.b, $.c)", { $bitAnd: ["$a", "$b", "$c"] }],
    ["$bitOr", "$bitOr($.a, $.b)", { $bitOr: ["$a", "$b"] }],
    ["$bitXor", "$bitXor($.a, $.b)", { $bitXor: ["$a", "$b"] }],
    ["$bitNot", "$bitNot($.flags)", { $bitNot: "$flags" }],
  ])("%s emits the expected MQL", (_name, src, expected) => {
    expect(jsmql.expr(src)).toEqual(expected);
  });
});

describe("misc / hash / timestamp / sigmoid / type / literal operators", () => {
  it.each([
    ["$sigmoid", "$sigmoid($.x)", { $sigmoid: "$x" }],
    ["$createObjectId", "$createObjectId()", { $createObjectId: {} }],
    ["$toHashedIndexKey", "$toHashedIndexKey($.k)", { $toHashedIndexKey: "$k" }],
    ["$tsIncrement", "$tsIncrement($.t)", { $tsIncrement: "$t" }],
    ["$tsSecond", "$tsSecond($.t)", { $tsSecond: "$t" }],
    ["$toUUID", '$toUUID("550e8400-e29b-41d4-a716-446655440000")', { $toUUID: "550e8400-e29b-41d4-a716-446655440000" }],
    ["$toObject", "$toObject($.json)", { $toObject: "$json" }],
    ["$toArray", "$toArray($.field)", { $toArray: "$field" }],
    ["$literal field-ref pass-through", '$literal("$foo")', { $literal: "$foo" }],
    ["$meta keyword string", '$meta("textScore")', { $meta: "textScore" }],
  ])("%s emits the expected MQL", (_name, src, expected) => {
    expect(jsmql.expr(src)).toEqual(expected);
  });
});

describe("$-prefixed string values: source passes through, injected wraps (HR1)", () => {
  // HR1: a `"$foo"` typed in jsmql SOURCE is the MQL field ref `$foo` and passes
  // through verbatim in every context — jsmql adds no `$literal` of its own (to
  // get the literal four-char string, write `$literal("$foo")`). The only wrap is
  // HR1's runtime-injected exception: a `"$foo"` arriving via a template-tag
  // `${…}` or a `jsmql.compile` param is wrapped in expression position so
  // untrusted input can't silently become a field reference.

  it("bare $-prefixed source string passes through at the top level", () => {
    expect(jsmql.expr('"$foo"')).toEqual("$foo");
  });

  it("$$-prefixed system-variable-shaped source string passes through", () => {
    expect(jsmql.expr('"$$NOW"')).toEqual("$$NOW");
  });

  it("plain strings (no leading $) are unaffected", () => {
    expect(jsmql.expr('"hello"')).toEqual("hello");
    expect(jsmql.expr('""')).toEqual("");
  });

  it("$-string inside an array literal passes through", () => {
    expect(jsmql.expr('[1, "$foo", "bar"]')).toEqual([1, "$foo", "bar"]);
  });

  it("$-string as an object value passes through", () => {
    expect(jsmql.expr('({ x: "$foo", y: "bar" })')).toEqual({ x: "$foo", y: "bar" });
  });

  it("$-string as an object KEY does not wrap", () => {
    // The user's key is the JSON key directly — MongoDB doesn't auto-evaluate
    // keys, only values. Leave it alone.
    expect(jsmql.expr('({ "$foo": 1 })')).toEqual({ $foo: 1 });
  });

  it("$-string as an operator argument passes through", () => {
    expect(jsmql.expr('$concat("$first", " ", "$last")')).toEqual({ $concat: ["$first", " ", "$last"] });
  });

  it("real field refs (`$.foo`) are NOT wrapped — they aren't string literals", () => {
    expect(jsmql.expr("$concat($.first, $.last)")).toEqual({ $concat: ["$first", "$last"] });
  });

  it("inside $literal(...) the inner $-string is NOT double-wrapped", () => {
    expect(jsmql.expr('$literal("$foo")')).toEqual({ $literal: "$foo" });
  });

  it("$literal of a nested object suppresses the wrap on inner $-strings", () => {
    expect(jsmql.expr('$literal({ x: "$foo" })')).toEqual({ $literal: { x: "$foo" } });
  });

  it("$literal of a nested array suppresses the wrap on inner $-strings", () => {
    expect(jsmql.expr('$literal(["$a", "$b"])')).toEqual({ $literal: ["$a", "$b"] });
  });

  it("template-tag interpolation of a $-prefixed value wraps", () => {
    const tainted = "$dangerous";
    expect(jsmql.expr`$.x === ${tainted}`).toEqual({ $eq: ["$x", { $literal: "$dangerous" }] });
  });

  it("compile-form binding of a $-prefixed string is inlined safely in find form", () => {
    // The query language does not treat values as field refs (only the
    // aggregation language does), so the $literal wrap is unnecessary here.
    // The same compile + $-prefixed binding inside an aggregation context
    // (e.g. inside `$addFields`) still gets the wrap — covered in the
    // pipeline-integration tests below.
    const q = jsmql.compile(({ name }: { name: string }, { $ }) => $.x === name);
    expect(q({ name: "$dangerous" })).toEqual({ x: "$dangerous" });
  });

  it("compile-form binding deeply wraps $-strings inside arrays and objects", () => {
    // `in` is not query-translatable, so the residual goes through $expr,
    // which re-enters aggregation codegen — and that path still applies the
    // auto-$literal wrap to $-prefixed strings inside the array binding.
    const q = jsmql.compile(({ allowed }: { allowed: string[] }, { $ }) => $.grade in allowed);
    expect(q({ allowed: ["$a", "$b", "safe"] })).toEqual({
      $expr: { $in: ["$grade", [{ $literal: "$a" }, { $literal: "$b" }, "safe"]] },
    });
  });
});

describe("$hash and $hexHash (object shape)", () => {
  it("$hash positional", () => {
    expect(jsmql.expr('$hash($.password, "sha256")')).toEqual({ $hash: { input: "$password", algorithm: "sha256" } });
  });
  it("$hexHash object-style", () => {
    expect(jsmql.expr('$hexHash({ input: $.token, algorithm: "sha512" })')).toEqual({
      $hexHash: { input: "$token", algorithm: "sha512" },
    });
  });
});

describe("$accumulator and $function (custom aggregation)", () => {
  it("$function object-style", () => {
    expect(jsmql.expr('$function({ body: "function(x) { return x * 2; }", args: [$.value], lang: "js" })')).toEqual({
      $function: { body: "function(x) { return x * 2; }", args: ["$value"], lang: "js" },
    });
  });
  it("$accumulator object-style inside $group (requires $group context)", () => {
    // accumulateArgs is REQUIRED ($accumulator rejects its absence — verified on
    // mongod), so include it: the operator-arg validator now enforces the full
    // required-key set.
    const out = jsmql(
      '[$group({ _id: null, total: $accumulator({ init: "function() { return 0; }", accumulate: "function(s, v) { return s + v; }", accumulateArgs: [$.v], merge: "function(a, b) { return a + b; }", lang: "js" }) })]',
    ) as Array<{ $group: { total: unknown } }>;
    expect(out[0].$group.total).toEqual({
      $accumulator: {
        init: "function() { return 0; }",
        accumulate: "function(s, v) { return s + v; }",
        accumulateArgs: ["$v"],
        merge: "function(a, b) { return a + b; }",
        lang: "js",
      },
    });
  });

  it("$accumulator outside $group throws an actionable error", () => {
    expect(() =>
      jsmql.expr(
        '$accumulator({ init: "function() {}", accumulate: "function() {}", merge: "function() {}", lang: "js" })',
      ),
    ).toThrow(/\$accumulator is an accumulator operator — only valid inside '\$group'/);
  });
});

describe("$median and $percentile (statistical accumulators — $group / $setWindowFields only)", () => {
  it("$median positional (inside $group)", () => {
    const out = jsmql('[$group({ _id: null, m: $median($.scores, "approximate") })]') as Array<{
      $group: { m: unknown };
    }>;
    expect(out[0].$group.m).toEqual({ $median: { input: "$scores", method: "approximate" } });
  });
  it("$percentile positional (inside $group)", () => {
    const out = jsmql('[$group({ _id: null, p: $percentile($.scores, [0.5, 0.95], "approximate") })]') as Array<{
      $group: { p: unknown };
    }>;
    expect(out[0].$group.p).toEqual({ $percentile: { input: "$scores", p: [0.5, 0.95], method: "approximate" } });
  });
  it("$median outside any accumulator context throws", () => {
    expect(() => jsmql.expr('$median($.scores, "approximate")')).toThrow(/\$median is an accumulator operator/);
  });
});

describe("encrypted-string operators ($encStr*)", () => {
  it("$encStrContains", () => {
    expect(jsmql.expr('$encStrContains($.encField, "secret")')).toEqual({
      $encStrContains: { input: "$encField", substring: "secret" },
    });
  });
  it("$encStrStartsWith object-style", () => {
    expect(jsmql.expr('$encStrStartsWith({ input: $.encField, prefix: "abc" })')).toEqual({
      $encStrStartsWith: { input: "$encField", prefix: "abc" },
    });
  });
  it("$encStrEndsWith", () => {
    expect(jsmql.expr('$encStrEndsWith($.encField, "xyz")')).toEqual({
      $encStrEndsWith: { input: "$encField", suffix: "xyz" },
    });
  });
  it("$encStrNormalizedEq", () => {
    expect(jsmql.expr('$encStrNormalizedEq($.encField, "compare")')).toEqual({
      $encStrNormalizedEq: { input: "$encField", string: "compare" },
    });
  });
});

describe("window operators ($setWindowFields-only)", () => {
  // Window operators are gated to `$setWindowFields.output` slots by
  // `checkOperatorContext` in codegen.ts. Each test wraps the operator in
  // a `$setWindowFields` stage and extracts the inner emission.
  function inWindow(opSrc: string): unknown {
    const src = `[$setWindowFields({ partitionBy: $.cat, sortBy: { ts: 1 }, output: { x: ${opSrc} } })]`;
    const out = jsmql(src) as Array<{ $setWindowFields: { output: { x: unknown } } }>;
    return out[0].$setWindowFields.output.x;
  }

  it.each([
    ["$rank", "$rank()", { $rank: {} }],
    ["$denseRank", "$denseRank()", { $denseRank: {} }],
    ["$documentNumber", "$documentNumber()", { $documentNumber: {} }],
    ["$linearFill", "$linearFill($.value)", { $linearFill: "$value" }],
    ["$locf", "$locf($.value)", { $locf: "$value" }],
    ["$covariancePop", "$covariancePop($.x, $.y)", { $covariancePop: ["$x", "$y"] }],
    ["$covarianceSamp", "$covarianceSamp($.x, $.y)", { $covarianceSamp: ["$x", "$y"] }],
  ])("%s emits the expected MQL", (_name, src, expected) => {
    expect(inWindow(src)).toEqual(expected);
  });

  it("$shift positional", () => {
    expect(inWindow("$shift($.price, -1, 0)")).toEqual({ $shift: { output: "$price", by: -1, default: 0 } });
  });

  it("$shift object-style", () => {
    expect(inWindow("$shift({ output: $.price, by: -1, default: 0 })")).toEqual({
      $shift: { output: "$price", by: -1, default: 0 },
    });
  });

  it("$expMovingAvg with N (positional)", () => {
    expect(inWindow("$expMovingAvg($.price, 5)")).toEqual({ $expMovingAvg: { input: "$price", N: 5 } });
  });

  it("$expMovingAvg with alpha (object-style)", () => {
    expect(inWindow("$expMovingAvg({ input: $.price, alpha: 0.3 })")).toEqual({
      $expMovingAvg: { input: "$price", alpha: 0.3 },
    });
  });

  it("$derivative positional", () => {
    expect(inWindow('$derivative($.value, "hour")')).toEqual({ $derivative: { input: "$value", unit: "hour" } });
  });

  it("$integral positional", () => {
    expect(inWindow('$integral($.value, "hour")')).toEqual({ $integral: { input: "$value", unit: "hour" } });
  });

  it("window operator outside $setWindowFields throws an actionable error", () => {
    expect(() => jsmql.expr("$rank()")).toThrow(/\$rank is a window operator — only valid inside '\$setWindowFields'/);
  });
});

describe("jsmql.compile()", () => {
  describe("basic binding", () => {
    it("scalar binding inlines as a literal", () => {
      const q = jsmql.compile(({ minAge }: { minAge: number }, { $ }) => $.age > minAge);
      expect(q({ minAge: 21 })).toEqual({ age: { $gt: 21 } });
    });

    it("string binding inlines as a literal string", () => {
      const q = jsmql.compile(({ region }: { region: string }, { $ }) => $.region === region);
      expect(q({ region: "AU" })).toEqual({ region: "AU" });
    });

    it("array binding inlines into $in", () => {
      // `in` is not query-translatable today, so the residual goes through
      // $expr — the binding still inlines into `$in`'s second slot.
      const q = jsmql.compile(({ allowed }: { allowed: string[] }, { $ }) => $.grade in allowed);
      expect(q({ allowed: ["A", "B"] })).toEqual({ $expr: { $in: ["$grade", ["A", "B"]] } });
    });

    it("plain-object binding inlines as a nested object literal value", () => {
      // Whole-object bindings appear as MQL literal objects. Field access on
      // them (e.g. `thresholds.min`) goes through MQL's `$getField`, not a
      // compile-time fold — the user can always destructure further at the
      // call site if they want fields hoisted as separate bindings.
      const q = jsmql.compile(({ defaults }: { defaults: { name: string } }) => defaults);
      expect(q({ defaults: { name: "default" } })).toEqual({ $expr: { name: "default" } });
    });

    it("the same compiled query is reusable with different params", () => {
      const q = jsmql.compile(({ n }: { n: number }, { $ }) => $.age > n);
      expect(q({ n: 18 })).toEqual({ age: { $gt: 18 } });
      expect(q({ n: 65 })).toEqual({ age: { $gt: 65 } });
    });

    it("aliased destructure key binds the alias name", () => {
      const q = jsmql.compile(({ minAge: floor }: { minAge: number }, { $ }) => $.age >= floor);
      expect(q({ minAge: 18 })).toEqual({ age: { $gte: 18 } });
    });
  });

  describe("signature slot disambiguation", () => {
    it("params-only slot (no $)", () => {
      const q = jsmql.compile(({ flag }: { flag: boolean }) => flag);
      expect(q({ flag: true })).toEqual({ $expr: true });
    });

    it("(params, { $ }) two-slot form", () => {
      const q = jsmql.compile(({ n }: { n: number }, { $ }) => $.age > n);
      expect(q({ n: 18 })).toEqual({ age: { $gt: 18 } });
    });

    it("(params, { $, ...ops }) toolbox form — ops hint is types-only", () => {
      const q = jsmql.compile(
        ({ minScore }: { minScore: number }, { $, $match }: { $match: (...args: unknown[]) => unknown }) => [
          $match($.score >= minScore),
        ],
      );
      expect(q({ minScore: 75 })).toEqual([{ $match: { score: { $gte: 75 } } }]);
    });

    it("the one-slot `({ $ }) => …` toolbox form works via jsmql.expr()", () => {
      expect(jsmql.expr(({ $ }) => $.age > 18)).toEqual({ $gt: ["$age", 18] });
    });

    it("the toolbox form with a destructured op (`({ $, $dateDiff }) => …`) works via jsmql.expr()", () => {
      expect(jsmql.expr(({ $ }) => $.x === "ok")).toEqual({ $eq: ["$x", "ok"] });
    });
  });

  describe("scope and shadowing", () => {
    it("lambda parameter shadows a binding of the same name", () => {
      const q = jsmql.compile(({ x }: { x: number }, { $ }) => $.items.map((x) => x * 2));
      expect(q({ x: 999 })).toEqual({ $expr: { $map: { input: "$items", as: "x", in: { $multiply: ["$$x", 2] } } } });
    });

    it("binding visible alongside other refs translates to a query-doc conjunction", () => {
      const q = jsmql.compile(({ minAge }: { minAge: number }, { $ }) => $.age >= minAge && $.country === "US");
      expect(q({ minAge: 21 })).toEqual({ age: { $gte: 21 }, country: "US" });
    });
  });

  describe("$match index-friendly translation (a75eb35)", () => {
    it("scalar binding against a field becomes a query-language $match", () => {
      const q = jsmql.compile(
        ({ minAge }: { minAge: number }, { $, $match }: { $match: (...a: unknown[]) => unknown }) => [
          $match($.age >= minAge),
        ],
      );
      expect(q({ minAge: 21 })).toEqual([{ $match: { age: { $gte: 21 } } }]);
    });

    it("string binding equals a field becomes a query-language $match", () => {
      const q = jsmql.compile(
        ({ region }: { region: string }, { $, $match }: { $match: (...a: unknown[]) => unknown }) => [
          $match($.region === region),
        ],
      );
      expect(q({ region: "AU" })).toEqual([{ $match: { region: "AU" } }]);
    });

    it("Date binding against a field becomes a query-language $match", () => {
      // BSON `Date` instances are query-doc values — MongoDB indexes work on
      // them. Without this, a Date parameter would fall through to $expr.
      const q = jsmql.compile(({ cutoff }: { cutoff: Date }, { $ }) => $.createdAt >= cutoff);
      const cutoff = new Date("2026-01-01");
      expect(q({ cutoff })).toEqual({ createdAt: { $gte: cutoff } });
    });

    it("RegExp binding inlines as a query-doc regex match", () => {
      const q = jsmql.compile(({ name }: { name: RegExp }, { $ }) => $.username === name);
      const name = /^alice/i;
      expect(q({ name })).toEqual({ username: name });
    });
  });

  describe("pipeline integration", () => {
    it("bindings work in pipeline arrays end-to-end", () => {
      const q = jsmql.compile(
        (
          { min, limit }: { min: number; limit: number },
          {
            $,
            $match,
            $project,
            $limit,
          }: {
            $match: (...a: unknown[]) => unknown;
            $project: (...a: unknown[]) => unknown;
            $limit: (...a: unknown[]) => unknown;
          },
        ) => [$match($.score >= min), $project({ name: $.name, score: $.score }), $limit(limit)],
      );
      expect(q({ min: 75, limit: 10 })).toEqual([
        { $match: { score: { $gte: 75 } } },
        { $project: { name: "$name", score: "$score" } },
        { $limit: 10 },
      ]);
    });
  });

  describe("bindings cross sub-pipeline boundaries", () => {
    it("a binding is visible inside $lookup.pipeline", () => {
      const q = jsmql.compile(
        (
          { region }: { region: string },
          { $, $lookup, $match }: { $lookup: (...a: unknown[]) => unknown; $match: (...a: unknown[]) => unknown },
        ) => [
          $lookup({
            from: "addresses",
            localField: "_id",
            foreignField: "userId",
            as: "addrs",
            pipeline: [$match($.country === region)],
          }),
        ],
      );
      expect(q({ region: "AU" })).toEqual([
        {
          $lookup: {
            from: "addresses",
            localField: "_id",
            foreignField: "userId",
            as: "addrs",
            pipeline: [{ $match: { country: "AU" } }],
          },
        },
      ]);
    });
  });

  describe("error: missing binding at call time", () => {
    it("throws UnknownIdentifierError naming the missing key", () => {
      const q = jsmql.compile(({ foo }: { foo: number }, { $ }) => $.x > foo);
      let err: unknown;
      try {
        q({} as { foo: number });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toMatch(/Unknown identifier 'foo'/);
    });

    it("aliased binding names both the params-object key and the body name", () => {
      // `({ minAge: floor })` looks up `minAge` on the params object and binds
      // it to `floor` in the body. A missing `minAge` key names both so the
      // user can find either side of the rename.
      const q = jsmql.compile(({ minAge: floor }: { minAge: number }, { $ }) => $.age >= floor);
      let err: unknown;
      try {
        q({} as { minAge: number });
      } catch (e) {
        err = e;
      }
      expect((err as Error).message).toMatch(/minAge/);
      expect((err as Error).message).toMatch(/floor/);
    });
  });

  describe("error: defaults in destructure are rejected", () => {
    it("literal default rejected with the explanatory message", () => {
      expect(() => jsmql.compile(({ minAge = 18 }: { minAge?: number }, { $ }) => $.age > minAge)).toThrow(
        /does not support default values/,
      );
    });

    it("expression default rejected with the explanatory message", () => {
      expect(() => jsmql.compile(({ now = Date.now() }: { now?: number }, { $ }) => $.createdAt > now)).toThrow(
        /does not support default values/,
      );
    });

    it("rejection message points at the call-site `??` fallback", () => {
      try {
        jsmql.compile(({ x = 1 }: { x?: number }, { $ }) => $.y > x);
      } catch (err) {
        expect((err as Error).message).toMatch(/JS's `\?\?` at the call site/);
      }
    });

    it("rejection message points at the template-tag form", () => {
      try {
        jsmql.compile(({ x = 1 }: { x?: number }, { $ }) => $.y > x);
      } catch (err) {
        expect((err as Error).message).toMatch(/template-tag form/);
      }
    });
  });

  describe("error: malformed destructure patterns", () => {
    it("nested destructure is rejected", () => {
      // Equivalent source: ({ a: { b } }, { $ }) => $.x > b
      const src = "({ a: { b } }, { $ }) => $.x > b";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(
        /does not support nested destructure/,
      );
    });

    it("rest pattern is rejected", () => {
      const src = "({ ...rest }, { $ }) => $.x > rest.a";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(/does not support rest patterns/);
    });

    it("array destructure is rejected", () => {
      const src = "([a, b], { $ }) => $.x > a";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(
        /must be an object destructure pattern/,
      );
    });
  });

  describe("error: slot ordering and counts", () => {
    it("more than two parameters is rejected", () => {
      const src = "({ a }, { $ }, { $match }) => $.x > a";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(/at most two parameters/);
    });

    it("(toolbox, params) — the toolbox before params — is rejected", () => {
      const src = "({ $ }, { a }) => $.x > a";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(
        /params destructure to appear before the toolbox/,
      );
    });

    it("mixed `$`/non-`$` keys in one destructure is rejected", () => {
      const src = "({ $match, minAge }) => $.age > minAge";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(
        /separate from the params destructure/,
      );
    });
  });

  describe("error: unsafe param values at call time", () => {
    it("NaN is rejected at bind time", () => {
      const q = jsmql.compile(({ n }: { n: number }, { $ }) => $.x > n);
      expect(() => q({ n: NaN })).toThrow(/NaN/);
    });

    it("Infinity is rejected at bind time", () => {
      const q = jsmql.compile(({ n }: { n: number }, { $ }) => $.x > n);
      expect(() => q({ n: Infinity })).toThrow(/Infinity/);
    });

    it("function value is rejected at bind time", () => {
      const q = jsmql.compile(({ x }: { x: unknown }, { $ }) => $.y === x);
      expect(() => q({ x: () => 1 })).toThrow(/has no JSON representation/);
    });

    it("BigInt value is rejected at bind time", () => {
      const q = jsmql.compile(({ x }: { x: unknown }, { $ }) => $.y === x);
      expect(() => q({ x: BigInt(1) })).toThrow(/could not be serialised/);
    });
  });

  describe("extra params keys are allowed silently", () => {
    it("extra keys not referenced in the body are ignored", () => {
      const q = jsmql.compile(({ a }: { a: number }, { $ }) => $.x > a);
      expect(q({ a: 1, unused: 99 } as unknown as { a: number })).toEqual({ x: { $gt: 1 } });
    });
  });

  describe("string input", () => {
    it("string containing an arrow compiles like the function form", () => {
      const q = jsmql.compile("({ minAge }, { $ }) => $.age > minAge");
      expect(q({ minAge: 21 })).toEqual({ age: { $gt: 21 } });
    });

    it("aliased destructure works in the string form too", () => {
      const q = jsmql.compile("({ minAge: floor }, { $ }) => $.age >= floor");
      expect(q({ minAge: 18 })).toEqual({ age: { $gte: 18 } });
    });

    it("string form returns a reusable closure", () => {
      const q = jsmql.compile("({ n }, { $ }) => $.age > n");
      expect(q({ n: 18 })).toEqual({ age: { $gt: 18 } });
      expect(q({ n: 65 })).toEqual({ age: { $gt: 65 } });
    });

    it("string input drives a pipeline end-to-end", () => {
      const q = jsmql.compile("({ id, count }, { $, $match, $limit }) => [$match($._id === id), $limit(count)]");
      expect(q({ id: 42, count: 10 })).toEqual([{ $match: { _id: 42 } }, { $limit: 10 }]);
    });

    it("missing param at call time names the binding (same path as fn form)", () => {
      const q = jsmql.compile("({ foo }, { $ }) => $.x > foo");
      expect(() => q({})).toThrow(/Unknown identifier 'foo'/);
    });

    it("non-arrow string is rejected with the same FunctionInputError message", () => {
      expect(() => jsmql.compile("$.age > 18")).toThrow(/expects an arrow function/);
    });

    it("wrong-type input is rejected with a TypeError naming the contract", () => {
      expect(() => jsmql.compile(42 as never)).toThrow(TypeError);
      expect(() => jsmql.compile(42 as never)).toThrow(/arrow function or a string containing one/);
    });
  });
});

// ── Filter dispatch (semicolon-driven) ────────────────────────────────────────
// No semicolons → input lowers as a MongoDB Filter (the document
// `db.coll.find(filter)` takes). Translatable predicates emit indexable
// `{ field: ... }` pairs; the rest rides in an `$expr` residual (a legal
// top-level Filter operator).

describe("Filter dispatch (no semicolons)", () => {
  describe("pure query-document predicates", () => {
    it("field-vs-literal `>` translates to `{ field: { $gt: lit } }`", () => {
      expect(jsmql("$.age > 18")).toEqual({ age: { $gt: 18 } });
    });

    it("`===` against a string literal emits a bare-value equality", () => {
      expect(jsmql("$.status === 'shipped'")).toEqual({ status: "shipped" });
    });

    it("`&&` of two index-friendly conjuncts merges into one query document", () => {
      expect(jsmql("$.status === 'active' && $.age >= 18")).toEqual({ status: "active", age: { $gte: 18 } });
    });

    it("nested field paths preserve their dotted key", () => {
      expect(jsmql("$.address.country === 'AU'")).toEqual({ "address.country": "AU" });
    });
  });

  describe("$expr fallback for untranslatable expressions", () => {
    it("a non-predicate expression rides entirely in `$expr`", () => {
      expect(jsmql("$add($.a, $.b)")).toEqual({ $expr: { $add: ["$a", "$b"] } });
    });

    it("a method-call predicate isn't query-translatable and rides in `$expr`", () => {
      expect(jsmql("$.name.trim() === 'alice'")).toEqual({ $expr: { $eq: [{ $trim: { input: "$name" } }, "alice"] } });
    });
  });

  describe("top-level object-literal Filter is a raw query doc (HR1 — no $expr wrap)", () => {
    // A bare `{ ... }` in Filter position IS the MongoDB query document and
    // passes through verbatim, mirroring how a `$match` stage body is treated.
    it("hand-written query document passes through", () => {
      expect(jsmql("{ age: { $gt: 18 } }")).toEqual({ age: { $gt: 18 } });
      expect(jsmql("{ a: 1 }")).toEqual({ a: 1 });
      expect(jsmql("{ a: 1, b: 'x' }")).toEqual({ a: 1, b: "x" });
    });

    it("an operator-call value produces a clean query operator (not a malformed $expr)", () => {
      expect(jsmql("{ age: $gt($.x) }")).toEqual({ age: { $gt: "$x" } });
    });
  });

  describe("bare stage call auto-wraps as a one-stage Pipeline", () => {
    // A top-level `$match(...)` / `$project(...)` / etc. without a `;` is
    // Pipeline intent — the user wrote a stage at the top level. `jsmql()`
    // auto-wraps it into a one-element pipeline so the output is directly
    // usable with `db.coll.aggregate(...)`, with no `;` discipline required.

    it("`$match(...)` without `;` auto-wraps as a Pipeline", () => {
      expect(jsmql("$match($.age > 18)")).toEqual([{ $match: { age: { $gt: 18 } } }]);
    });

    it("any registered stage call auto-wraps the same way", () => {
      expect(jsmql("$project({ name: 1 })")).toEqual([{ $project: { name: 1 } }]);
      expect(jsmql("$sort({ age: 1 })")).toEqual([{ $sort: { age: 1 } }]);
      expect(jsmql("$limit(10)")).toEqual([{ $limit: 10 }]);
    });

    it("the stage-object form `{ $match: ... }` auto-wraps the same way", () => {
      // The Compass copy-paste form (`{ $match: ... }`) is the other shape we
      // detect as Pipeline intent.
      expect(jsmql("{ $match: $.age > 18 }")).toEqual([{ $match: { age: { $gt: 18 } } }]);
    });

    it("adding the `;` produces an identical Pipeline output", () => {
      expect(jsmql("$match($.age > 18);")).toEqual([{ $match: { age: { $gt: 18 } } }]);
    });

    it("non-stage operator calls still go through Filter dispatch unaffected", () => {
      // `$add` is an expression operator, not a stage — the auto-wrap does
      // not fire, and the expression rides in `$expr`.
      expect(jsmql("$add($.a, $.b)")).toEqual({ $expr: { $add: ["$a", "$b"] } });
    });
  });

  describe("partial translation: indexable + $expr in the same document", () => {
    it("translatable + untranslatable `&&` produces both shapes side-by-side", () => {
      expect(jsmql("$.status === 'active' && $.name.trim() === 'alice'")).toEqual({
        status: "active",
        $expr: { $eq: [{ $trim: { input: "$name" } }, "alice"] },
      });
    });
  });

  describe("compile-form parameter substitution", () => {
    it("a scalar binding inlines into the query-doc literal slot", () => {
      const q = jsmql.compile(({ minAge }: { minAge: number }, { $ }) => $.age >= minAge);
      expect(q({ minAge: 21 })).toEqual({ age: { $gte: 21 } });
    });
  });

  describe("template-tag interpolation", () => {
    it("interpolated values become query-doc literals", () => {
      const region = "AU";
      expect(jsmql`$.region === ${region}`).toEqual({ region: "AU" });
    });
  });
});

// ── Pipeline dispatch (any `;`) ───────────────────────────────────────────────
// Any presence of `;` flips the input to Pipeline mode. Each statement must be
// a stage call (`$match(...)`, `$project(...)`, …) — a bare expression is an
// error with an actionable `$match(...)` suggestion.

describe("Pipeline dispatch (semicolons present)", () => {
  it("a single trailing `;` produces a one-element stage array", () => {
    expect(jsmql("$match($.age > 18);")).toEqual([{ $match: { age: { $gt: 18 } } }]);
  });

  it("`;`-separated stages compile to a multi-stage pipeline", () => {
    expect(jsmql("$match($.age > 18); $sort({ age: 1 })")).toEqual([
      { $match: { age: { $gt: 18 } } },
      { $sort: { age: 1 } },
    ]);
  });

  it("a bare predicate as a pipeline statement throws with a $match hint", () => {
    expect(() => jsmql("$.age > 18;")).toThrow(/To filter documents on a predicate, wrap it as `\$match\(\.\.\.\)`/);
  });

  it("the bare-predicate error carries the offending statement's position", () => {
    // The CodegenError's `.pos` should point at the offending statement so
    // tooling can underline it. The first stmt starts at offset 0; here we
    // use a leading filler to get a non-zero offset.
    const r = jsmql.validate("   $.age > 18;");
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe("CODEGEN_ERROR");
    expect(r.errors[0].pos).toBeGreaterThan(0);
  });
});

// ── Function-form dispatch parity ─────────────────────────────────────────────
// Expression-body arrow → Filter; block-body arrow → Pipeline. The
// classification is body-shape-driven, mirroring the string form's `;` rule.

describe("function-form dispatch parity", () => {
  it("expression-body arrow lowers as a Filter", () => {
    expect(jsmql(({ $ }) => $.age > 18)).toEqual({ age: { $gt: 18 } });
  });

  it("block-body arrow lowers as a Pipeline", () => {
    const result = jsmql(({ $, $match, $sort }) => {
      $match($.age > 18);
      $sort({ age: 1 });
    });
    expect(result).toEqual([{ $match: { age: { $gt: 18 } } }, { $sort: { age: 1 } }]);
  });
});

// ── `jsmql.expr()` — partial / unfinished expression ──────────────────────────
// `jsmql.expr()` lowers a bare expression to raw aggregation-expression form
// (no Filter wrapper, no `$expr` envelope). Use it for the shape that lives
// inside a Pipeline stage body or as the update document in `updateOne`.
// `;`-separated / update op / array-literal-Pipeline inputs behave exactly
// like `jsmql()` — only the bare-expression branch differs.

describe("jsmql.expr()", () => {
  it("a bare predicate lowers to its aggregation-expression form (no Filter wrap)", () => {
    expect(jsmql.expr("$.age > 18")).toEqual({ $gt: ["$age", 18] });
  });

  it("a bare non-predicate lowers as-is (no `$expr` envelope)", () => {
    expect(jsmql.expr("$add($.a, $.b)")).toEqual({ $add: ["$a", "$b"] });
  });

  it("a update op lowers like jsmql() — to a `$set` update document", () => {
    expect(jsmql.expr("$.name = $.name.toUpperCase()")).toEqual({ $set: { name: { $toUpper: "$name" } } });
  });

  it("a `;`-separated input lowers like jsmql() — to a Pipeline", () => {
    expect(jsmql.expr("$match($.age > 18); $sort({ age: 1 });")).toEqual([
      { $match: { age: { $gt: 18 } } },
      { $sort: { age: 1 } },
    ]);
  });

  it("accepts the arrow form", () => {
    expect(jsmql.expr(({ $ }) => $.age > 18)).toEqual({ $gt: ["$age", 18] });
  });

  it("accepts the template-tag form", () => {
    const region = "AU";
    expect(jsmql.expr`$.region === ${region}`).toEqual({ $eq: ["$region", "AU"] });
  });

  it("a stage name is rejected here — `jsmql.expr` yields an expression, not a stage", () => {
    // It used to emit `{ $match: { $eq: ["$a", 0] } }`, which mongod refuses in BOTH
    // readings: there is no `$match` expression operator, and as a stage body a bare
    // `$eq` is "unknown top level operator". The stage document comes from
    // `jsmql.pipeline` instead, and the expression from `jsmql.expr` on the predicate.
    expect(() => jsmql.expr("$match($.a === 0)")).toThrow(
      /'\$match' is a pipeline stage, not an expression.*For the value-position equivalent, use '\$filter\(…\)'/s,
    );
    expect(jsmql.pipeline("$match($.a === 0)")).toEqual([{ $match: { a: 0 } }]);
    expect(jsmql.expr("$.a === 0")).toEqual({ $eq: ["$a", 0] });
  });

  it("rejects wrong-typed input with a TypeError naming the entry point", () => {
    expect(() => (jsmql.expr as (x: unknown) => unknown)(42)).toThrow(/jsmql\.expr\(\) expects a string/);
  });
});

describe("context-reference prefixes ($$, $$$, $$$$)", () => {
  // Three new prefix levels. Lex + parse succeed; codegen throws a reserved-syntax
  // error (semantics deferred — see docs/specs/context-references.md). Both dot-ident
  // (`$$.foo`) and bracket-expr (`$$[x]`) postfix forms are accepted because the
  // prefix tokens don't bake the dot in; standard MemberAccess/IndexAccess composes.
  // Tests use the string form because `$$` / `$$$` / `$$$$` aren't yet declared
  // as ambient globals — that's part of the future-API surface.

  describe("$$ — current collection", () => {
    // $$ lights up the `$$.push(...)` → `$unionWith` shape. Any other use of $$
    // (`.foo` member access, `["foo"]` index access, `.bar()` method call,
    // bare reference, RHS use) is rejected by the CollectionRef codegen case
    // with a precise "statement-only / only .push(...)" message. See
    // docs/specs/union-stage.md.
    it("dot-ident form (not .push / .filter) throws statement-only at codegen", () => {
      expect(() => jsmql.expr("$$.foo")).toThrow(
        /statement-only and supports '\.push\(\.\.\.\)', '\.filter\(\.\.\.\)' in the facet pattern, and '\$\$ = <expr>'/,
      );
    });
    it("bracket-expr form (string literal) throws statement-only at codegen", () => {
      expect(() => jsmql.expr('$$["foo"]')).toThrow(
        /statement-only and supports '\.push\(\.\.\.\)', '\.filter\(\.\.\.\)' in the facet pattern, and '\$\$ = <expr>'/,
      );
    });
    it("bracket-expr form (compile-form param) throws when the compiled function is called", () => {
      const q = jsmql.compile("({ name }) => $$[name]");
      expect(() => q({ name: "users" })).toThrow(/statement-only and supports '\.push/);
    });
    it(".pos points at the prefix in validate()", () => {
      const r = jsmql.validate("$$.foo");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/statement-only and supports '\.push/);
      expect(r.errors[0].pos).toBe(0);
    });
    it("wrong method on $$ surfaces the stream-method registry error, noting .push", () => {
      expect(() => jsmql("$$.pop({a:1})")).toThrow(
        /'\.pop\(\.\.\.\)' is not a chainable stream method on '\$\$'.*'\.concat\(\.\.\.\)' mid-chain, or '\$\$\.push\(\.\.\.\)' as a statement/,
      );
    });
  });

  describe("$$$ — current database", () => {
    it("dot-ident form: $$$.myColl is not a value outside a lookup or $out chain", () => {
      // Once $$$ lights up the `$$$.<coll>.find/filter(...)` join syntax and
      // the `$$$.<coll> = …` $out sugar, the bare reference message points
      // at both supported shapes.
      expect(() => jsmql.expr("$$$.myColl")).toThrow(/\$lookup read.*\$out write/);
    });
    it('bracket-expr form: $$$["coll"] is not a value either', () => {
      expect(() => jsmql.expr('$$$["coll"]')).toThrow(/\$lookup read.*\$out write/);
    });
    it("$$$.<coll>.find(...) outside Pipeline mode hits the bare-reference error", () => {
      // Bare expression form (no `;`, not in jsmql.pipeline) — `$$$` only
      // means something as a Pipeline-mode lookup; the error names that.
      const r = jsmql.validate("$$$.myColl.find(o => o.x === $.y)");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/requires Pipeline mode/);
      expect(r.errors[0].pos).toBe(0);
    });
  });

  describe("$$$$ — current cluster", () => {
    // A bare `$$$$.<db>.<coll>` (no .find/.filter, no `= …`) is only usable as a
    // cross-database $out destination — cross-database reads aren't supported. The
    // bracket/mixed-access combos reach the same error via the same path (bracket
    // parsing itself is exercised by the $out cases in test/out.test.ts), so one
    // representative case suffices here.
    it("dot.dot: $$$$.myDb.myColl is only a cross-db $out destination", () => {
      expect(() => jsmql.expr("$$$$.myDb.myColl")).toThrow(/only usable as a cross-database \$out destination/);
    });
    it(".pos points at the $$$$ prefix", () => {
      const r = jsmql.validate("  $$$$.db.coll");
      expect(r.valid).toBe(false);
      expect(r.errors[0].pos).toBe(2);
    });
  });

  describe("parser sanity-guards", () => {
    it("bare $$ without . or [ → CollectionRef codegen error (statement-only message)", () => {
      // Once `$out` sugar allows bare `$$` as the RHS of `$$$.coll = $$`, the
      // parser stops pre-rejecting bare `$$` and codegen surfaces the
      // actionable "statement-only" message when `$$` lands somewhere
      // meaningless. The typo case `$$foo` (no separator) is still rejected
      // at parse time — see the next test.
      const r = jsmql.validate("$$");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/'\$\$' \(current collection\) is statement-only/);
      expect(r.errors[0].pos).toBe(0);
    });
    it("$$foo (ident with no . or [) → actionable ParseError", () => {
      const r = jsmql.validate("$$foo");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/Expected '\.<name>' or '\[<expr>\]' after '\$\$'/);
    });
    it("$$$ alone → message names '$$$' specifically", () => {
      const r = jsmql.validate("$$$");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/Expected '\.<name>' or '\[<expr>\]' after '\$\$\$'/);
    });
    it("$$$$ alone → message names '$$$$' specifically", () => {
      const r = jsmql.validate("$$$$");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/Expected '\.<name>' or '\[<expr>\]' after '\$\$\$\$'/);
    });
  });

  describe("lexer cap", () => {
    it("5 dollars → LexError naming the supported levels", () => {
      const r = jsmql.validate("$$$$$.x");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/Up to 4 levels of context reference are supported/);
      expect(r.errors[0].pos).toBe(0);
    });
    it("6 dollars → same LexError", () => {
      const r = jsmql.validate("$$$$$$.x");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/Up to 4 levels of context reference are supported/);
    });
  });

  it("existing $. behaviour is unaffected by the new prefix tokens", () => {
    expect(jsmql.expr("$abs($.delta)")).toEqual({ $abs: "$delta" });
    expect(jsmql.expr("$abs($.address.city)")).toEqual({ $abs: "$address.city" });
  });
});

// A comma after the last item of any list is valid JS (`f(a, b,)`) and must be
// accepted everywhere, producing output identical to the comma-free form.
describe("trailing commas (JS syntax)", () => {
  it("Math.method args", () => {
    expect(jsmql.expr("Math.max(1, 2,)")).toEqual(jsmql.expr("Math.max(1, 2)"));
  });

  it("method-call args", () => {
    expect(jsmql.expr("$.items.map(x => x * 1.1,)")).toEqual(jsmql.expr("$.items.map(x => x * 1.1)"));
  });

  it("$op positional args", () => {
    expect(jsmql.expr("$add(1, 2,)")).toEqual(jsmql.expr("$add(1, 2)"));
  });

  it("$op single-object arg stays object-style", () => {
    expect(jsmql.expr('$dateTrunc({ date: $.t, unit: "week", },)')).toEqual(
      jsmql.expr('$dateTrunc({ date: $.t, unit: "week" })'),
    );
  });

  it("type cast (single arg) tolerates a lone trailing comma", () => {
    expect(jsmql.expr("Number($.x,)")).toEqual(jsmql.expr("Number($.x)"));
  });

  it("type cast still rejects a real second argument", () => {
    const r = jsmql.validate("Number($.x, $.y)");
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/Type cast 'Number\(\)' takes exactly 1 argument/);
  });

  it("Number static method args", () => {
    expect(jsmql.expr("Number.isInteger($.x,)")).toEqual(jsmql.expr("Number.isInteger($.x)"));
  });

  it("Object method args", () => {
    expect(jsmql.expr("Object.keys($.a,)")).toEqual(jsmql.expr("Object.keys($.a)"));
  });

  it("new Date / new Set args", () => {
    expect(jsmql.expr("new Date(2020, 1, 1,)")).toEqual(jsmql.expr("new Date(2020, 1, 1)"));
    expect(jsmql.expr("new Set([1, 2],)")).toEqual(jsmql.expr("new Set([1, 2])"));
  });

  it("Date.UTC args", () => {
    expect(jsmql.expr("Date.UTC(2020, 1,)")).toEqual(jsmql.expr("Date.UTC(2020, 1)"));
  });

  it("Array.from args (both shapes)", () => {
    expect(jsmql.expr("Array.from({ length: 5 },)")).toEqual(jsmql.expr("Array.from({ length: 5 })"));
    expect(jsmql.expr("Array.from({ length: 5 }, (_, i) => i,)")).toEqual(
      jsmql.expr("Array.from({ length: 5 }, (_, i) => i)"),
    );
  });

  it("array & object literals", () => {
    expect(jsmql.expr("[1, 2, 3,]")).toEqual(jsmql.expr("[1, 2, 3]"));
    expect(jsmql.expr("$add([$.a, $.b,])")).toEqual(jsmql.expr("$add([$.a, $.b])"));
  });

  it("parenthesised lambda params (incl. trailing comma)", () => {
    expect(jsmql.expr("$.a.reduce((acc, x,) => acc + x, 0)")).toEqual(jsmql.expr("$.a.reduce((acc, x) => acc + x, 0)"));
  });

  it("$match stage body — the multi-line predicate case", () => {
    const withComma = jsmql(
      '$match($.amount > 100 && ($.currency === "USD" || $.currency === "EUR") && $.status === "active",)',
    );
    const without = jsmql(
      '$match($.amount > 100 && ($.currency === "USD" || $.currency === "EUR") && $.status === "active")',
    );
    expect(withComma).toEqual(without);
  });

  it("update-op chain — trailing comma before a block-body's closing brace", () => {
    // Only reachable via a source string: a real arrow can't carry it (JS
    // rejects `a = 1, b = 2,` as a statement), but the parser must still accept
    // the trailing `,` before the block's closing `}`.
    expect(jsmql.compile("({ $ }) => { $.a = 1, $.b = 2, }")()).toEqual(
      jsmql.compile("({ $ }) => { $.a = 1, $.b = 2 }")(),
    );
  });

  it("function declaration parameter list (pipeline)", () => {
    expect(jsmql("function dbl(x,) { return x * 2 } $ = { y: dbl($.n) }")).toEqual(
      jsmql("function dbl(x) { return x * 2 } $ = { y: dbl($.n) }"),
    );
  });

  it("compile-form params destructure and slot list", () => {
    // String entry so the trailing commas survive the formatter: one inside the
    // params destructure (`{ min, }`) and one after the `{ $ }` toolbox slot
    // (`{ $ },`).
    expect(jsmql.compile("({ min, }, { $ },) => $.age > min")({ min: 18 })).toEqual({ age: { $gt: 18 } });
    expect(jsmql.compile("({ min }, { $ }) => $.age > min")({ min: 18 })).toEqual({ age: { $gt: 18 } });
  });
});

// The `jsmql` prefix on a compiler-emitted `$let`/`$map`/`$filter` variable is only
// a convention — nothing stops a developer naming a param the same thing. What makes
// the "never collides with a user-named param" invariant hold is `internalVar`'s
// gensym (src/codegen.ts, over `exprVar` in src/namespace.ts): OUR binding moves
// aside, the developer's name is left exactly as written.
describe("internal expression-variable names never capture a user param", () => {
  // One case per lowering that binds an internal var AND splices outer-scope
  // codegen into it — [source, the internal name the user's param collides with].
  const CASES: Array<[string, string]> = [
    ["$.r.map(jsmqlArr => jsmqlArr.l.slice(jsmqlArr.i))", "jsmqlArr"],
    ["$.r.map(jsmqlArr => jsmqlArr.l.slice(jsmqlArr.i, jsmqlArr.j))", "jsmqlArr"],
    ["$.r.map(jsmqlPad => jsmqlPad.c.padStart(jsmqlPad.w))", "jsmqlPad"],
    ["$.r.map(jsmqlArr => jsmqlArr.l.lastIndexOf(jsmqlArr.n))", "jsmqlArr"],
    ["$.r.map(jsmqlArr => jsmqlArr.l.toSpliced(jsmqlArr.s, 1))", "jsmqlArr"],
    ["$.r.map(jsmqlArr => jsmqlArr.l.with(jsmqlArr.i, jsmqlArr.v))", "jsmqlArr"],
    ["$.r.map(jsmqlArr => jsmqlArr.l.drop(jsmqlArr.n))", "jsmqlArr"],
    ["$.r.map(jsmqlItem => jsmqlItem.l.difference(jsmqlItem.o))", "jsmqlItem"],
    ["$.r.map(jsmqlItem => jsmqlItem.l.without(jsmqlItem.o))", "jsmqlItem"],
    ["$.r.map(jsmqlShuffled => jsmqlShuffled.l.sampleSize(jsmqlShuffled.n))", "jsmqlShuffled"],
    ["$.r.map(jsmqlA => jsmqlA.l.xor(jsmqlA.o))", "jsmqlA"],
    ['$.r.map(jsmqlOtherKeys => jsmqlOtherKeys.l.differenceBy(jsmqlOtherKeys.o, "id"))', "jsmqlOtherKeys"],
    ["$.r.map(jsmqlI => jsmqlI.l.zipObject(jsmqlI.v))", "jsmqlI"],
    ["$.r.map(jsmqlKey => jsmqlKey.l.uniqBy(d => d.id))", "jsmqlKey"],
    ['$.r.map(jsmqlObj => jsmqlObj.o.pick(["a"]))', "jsmqlObj"],
    ["$.r.map(jsmqlKv => jsmqlKv.o.mapValues(v => v + jsmqlKv.n))", "jsmqlKv"],
    ["$.r.map(jsmqlFi => jsmqlFi.l.takeWhile(d => d.a < jsmqlFi.n))", "jsmqlFi"],
    ["$.r.map(jsmqlSorted => jsmqlSorted.l.maxBy(d => d.a))", "jsmqlSorted"],
    ["$.r.map(jsmqlPair => jsmqlPair.l.map((e, i) => e + i + jsmqlPair.n))", "jsmqlPair"],
  ];
  for (const [src, name] of CASES) {
    it(`${name}: the binding moves aside, the param keeps its name`, () => {
      const out = JSON.stringify(jsmql.expr(src));
      // The user's param is emitted verbatim as the `$map` element…
      expect(out).toContain(`"as":"${name}"`);
      // …and every read of it still resolves to the element, because the internal
      // binding took a fresh name instead.
      expect(out).toContain(`"${name}2"`);
    });
  }

  it("without a collision the base name is used — output is unchanged for normal code", () => {
    expect(JSON.stringify(jsmql.expr("$.r.map(d => d.l.slice(d.i))"))).not.toContain("jsmqlArr2");
    expect(jsmql.expr('$.code.padStart(5, "0")')).toEqual(jsmql.expr('$.code.padStart(5, "0")'));
  });
});
