import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

// Mirror of the codegen-side `jsBool()` helper. JS truthy/falsy: false, null
// (or missing), "", and 0 are falsy; everything else is truthy. Used in
// expected outputs for `&&`, `||`, `!`, `?:`, `Boolean()`, and predicate-
// method bodies wherever the operand is not provably boolean.
const truthy = (v: unknown) => ({
  $and: [{ $ne: [v, null] }, { $ne: [v, false] }, { $ne: [v, ""] }, { $ne: [v, 0] }],
});

describe("basic literals", () => {
  it("passes number through", () => {
    expect(jsmql("$abs(42)")).toEqual({ $abs: 42 });
  });

  it("passes string through", () => {
    expect(jsmql('$toLower("Hello")')).toEqual({ $toLower: "Hello" });
  });

  it("handles boolean", () => {
    expect(jsmql("$not(true)")).toEqual({ $not: true });
  });

  it("handles null", () => {
    expect(jsmql("$not(null)")).toEqual({ $not: null });
  });
});

describe("field refs", () => {
  it("simple field", () => {
    expect(jsmql("$abs($.delta)")).toEqual({ $abs: "$delta" });
  });

  it("nested field", () => {
    expect(jsmql("$year($.createdAt)")).toEqual({ $year: "$createdAt" });
  });

  it("deep nested field", () => {
    expect(jsmql("$abs($.address.city)")).toEqual({ $abs: "$address.city" });
  });
});

describe("single-shape operators", () => {
  it("$not", () => {
    expect(jsmql("$not($.active)")).toEqual({ $not: "$active" });
  });

  it("$size", () => {
    expect(jsmql("$size($.items)")).toEqual({ $size: "$items" });
  });

  it("$toLower", () => {
    expect(jsmql("$toLower($.name)")).toEqual({ $toLower: "$name" });
  });
});

describe("array-shape operators", () => {
  it("$eq two args", () => {
    expect(jsmql("$eq($.age, 18)")).toEqual({ $eq: ["$age", 18] });
  });

  it("$gt comparison", () => {
    expect(jsmql("$gt($.age, 18)")).toEqual({ $gt: ["$age", 18] });
  });

  it("$add multiple args", () => {
    expect(jsmql("$add($.a, $.b, $.c)")).toEqual({ $add: ["$a", "$b", "$c"] });
  });

  it("$and logical", () => {
    expect(jsmql('$and($gt($.age, 18), $eq($.status, "active"))')).toEqual({
      $and: [{ $gt: ["$age", 18] }, { $eq: ["$status", "active"] }],
    });
  });

  it("$or logical", () => {
    expect(jsmql("$or($eq($.a, 1), $eq($.b, 2))")).toEqual({
      $or: [{ $eq: ["$a", 1] }, { $eq: ["$b", 2] }],
    });
  });

  it("$in with array literal", () => {
    expect(jsmql('$in($.status, ["active", "pending"])')).toEqual({
      $in: ["$status", ["active", "pending"]],
    });
  });

  it("$ifNull varargs", () => {
    expect(jsmql('$ifNull($.nickname, $.firstName, "Unknown")')).toEqual({
      $ifNull: ["$nickname", "$firstName", "Unknown"],
    });
  });
});

describe("nested operators", () => {
  it("operator as argument", () => {
    expect(jsmql("$multiply($add($.a, $.b), 2)")).toEqual({
      $multiply: [{ $add: ["$a", "$b"] }, 2],
    });
  });
});

describe("object-style operators (object arg)", () => {
  it("$trim with named args", () => {
    expect(jsmql("$trim({ input: $.name, chars: ' ' })")).toEqual({
      $trim: { input: "$name", chars: " " },
    });
  });

  it("$replaceOne named", () => {
    expect(jsmql('$replaceOne({ input: $.text, find: "old", replacement: "new" })')).toEqual({
      $replaceOne: { input: "$text", find: "old", replacement: "new" },
    });
  });

  it("$dateAdd named", () => {
    expect(jsmql('$dateAdd({ startDate: $.date, unit: "day", amount: 7 })')).toEqual({
      $dateAdd: { startDate: "$date", unit: "day", amount: 7 },
    });
  });
});

describe("object-shape operators (positional → object mapping)", () => {
  it("$trim positional", () => {
    expect(jsmql("$trim($.name, ' ')")).toEqual({
      $trim: { input: "$name", chars: " " },
    });
  });

  it("$trim positional single arg", () => {
    expect(jsmql("$trim($.name)")).toEqual({
      $trim: { input: "$name" },
    });
  });

  it("$replaceOne positional", () => {
    expect(jsmql('$replaceOne($.text, "old", "new")')).toEqual({
      $replaceOne: { input: "$text", find: "old", replacement: "new" },
    });
  });

  it("$getField positional", () => {
    expect(jsmql('$getField("fieldName", $.doc)')).toEqual({
      $getField: { field: "fieldName", input: "$doc" },
    });
  });

  it("$switch object-style with branches/default", () => {
    expect(
      jsmql(
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
    expect(jsmql('$dateTrunc($.createdAt, "day")')).toEqual({
      $dateTrunc: { date: "$createdAt", unit: "day" },
    });
  });

  it("$dateFromString single-arg positional", () => {
    expect(jsmql("$dateFromString($.dateString)")).toEqual({
      $dateFromString: { dateString: "$dateString" },
    });
  });
});

describe("escape-hatch operators (single-arg, expression-shaped)", () => {
  it("$sampleRate(0.1) → { $sampleRate: 0.1 }", () => {
    expect(jsmql("$sampleRate(0.1)")).toEqual({ $sampleRate: 0.1 });
  });
});

describe("regex literal in standalone position", () => {
  it("rejects /pattern/ as a binary operand with a clear error", () => {
    expect(() => jsmql("$.x == /foo/")).toThrow(
      /Regex literals are only valid as arguments to \.match\(\)/,
    );
  });
});

describe("zero-arg operators", () => {
  it("$rand", () => {
    expect(jsmql("$rand()")).toEqual({ $rand: {} });
  });
});

describe("unknown operators (fallthrough)", () => {
  it("zero args → {}", () => {
    expect(jsmql("$someNewOp()")).toEqual({ $someNewOp: {} });
  });

  it("single non-object arg → bare value", () => {
    expect(jsmql("$someOp($.a)")).toEqual({ $someOp: "$a" });
  });

  it("single object arg → pass object", () => {
    expect(jsmql('$someOp({ key: "val" })')).toEqual({ $someOp: { key: "val" } });
  });

  it("multiple args → array", () => {
    expect(jsmql("$someNewOp($.a, $.b)")).toEqual({ $someNewOp: ["$a", "$b"] });
  });
});

describe("array literals", () => {
  it("simple array", () => {
    expect(jsmql("$in($.x, [1, 2, 3])")).toEqual({ $in: ["$x", [1, 2, 3]] });
  });

  it("nested array", () => {
    expect(jsmql("$abs([1, 2])")).toEqual({ $abs: [1, 2] });
  });
});

describe("array spread", () => {
  it("single spread becomes the spread argument directly (no redundant $concatArrays)", () => {
    expect(jsmql("$foo([...$.arr])")).toEqual({ $foo: "$arr" });
  });

  it("two spreads emit $concatArrays", () => {
    expect(jsmql("$foo([...$.a, ...$.b])")).toEqual({
      $foo: { $concatArrays: ["$a", "$b"] },
    });
  });

  it("statics before a spread group into one operand", () => {
    expect(jsmql("$foo([1, 2, ...$.rest])")).toEqual({
      $foo: { $concatArrays: [[1, 2], "$rest"] },
    });
  });

  it("statics after a spread group into one operand", () => {
    expect(jsmql("$foo([...$.base, 1, 2])")).toEqual({
      $foo: { $concatArrays: ["$base", [1, 2]] },
    });
  });

  it("statics around a spread split into two grouped operands (left-to-right)", () => {
    expect(jsmql("$foo([1, ...$.mid, 2])")).toEqual({
      $foo: { $concatArrays: [[1], "$mid", [2]] },
    });
  });

  it("multiple spreads with statics interleaved", () => {
    expect(jsmql("$foo([1, ...$.a, 2, ...$.b, 3])")).toEqual({
      $foo: { $concatArrays: [[1], "$a", [2], "$b", [3]] },
    });
  });

  it("spread of a literal array produces $concatArrays of literal-array operands", () => {
    expect(jsmql("$foo([...[1, 2], 3])")).toEqual({
      $foo: { $concatArrays: [[1, 2], [3]] },
    });
  });

  it("spread inside .map lambda body remaps the lambda param", () => {
    expect(jsmql("$.xs.map(x => [...$.prefix, x])")).toEqual({
      $map: {
        input: "$xs",
        as: "x",
        in: { $concatArrays: ["$prefix", ["$$x"]] },
      },
    });
  });

  it("empty array still works (no spread, fast path)", () => {
    expect(jsmql("$foo([])")).toEqual({ $foo: [] });
  });

  it("plain non-spread arrays unchanged (regression)", () => {
    expect(jsmql("$foo([1, 2, 3])")).toEqual({ $foo: [1, 2, 3] });
  });

  it("nested array literal with spread inside", () => {
    expect(jsmql("$foo([[...$.a]])")).toEqual({ $foo: ["$a"] });
  });
});

describe("object literals as args", () => {
  it("object as second positional arg for unknown op", () => {
    expect(jsmql("$foo({ a: 1 }, $.b)")).toEqual({ $foo: [{ a: 1 }, "$b"] });
  });
});

describe("object spread", () => {
  it("single spread becomes the spread argument directly (no redundant $mergeObjects)", () => {
    expect(jsmql("$foo({ ...$.base })")).toEqual({ $foo: "$base" });
  });

  it("two spreads emit $mergeObjects", () => {
    expect(jsmql("$foo({ ...$.a, ...$.b })")).toEqual({
      $foo: { $mergeObjects: ["$a", "$b"] },
    });
  });

  it("static keys before a spread group into one operand", () => {
    expect(jsmql("$foo({ x: 1, y: 2, ...$.rest })")).toEqual({
      $foo: { $mergeObjects: [{ x: 1, y: 2 }, "$rest"] },
    });
  });

  it("static keys after a spread group into one operand", () => {
    expect(jsmql("$foo({ ...$.base, x: 1 })")).toEqual({
      $foo: { $mergeObjects: ["$base", { x: 1 }] },
    });
  });

  it("statics around a spread split into separate operands (left-to-right)", () => {
    expect(jsmql("$foo({ x: 1, ...$.mid, y: 2 })")).toEqual({
      $foo: { $mergeObjects: [{ x: 1 }, "$mid", { y: 2 }] },
    });
  });

  it("computed key inside a static block uses $arrayToObject for that block only", () => {
    expect(jsmql("$foo({ ...$.base, [$.k]: $.v })")).toEqual({
      $foo: {
        $mergeObjects: ["$base", { $arrayToObject: [["$k", "$v"]] }],
      },
    });
  });

  it("works inside .reduce — the README $accumulator replacement", () => {
    expect(
      jsmql("$.statuses.reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {})"),
    ).toEqual({
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
    });
  });

  it("rejects spread inside operator-arg objects (key shape is wire format)", () => {
    expect(() => jsmql("$replaceOne({ ...$.opts, input: $.s })")).toThrow(/Spread/);
  });
});

describe("$cond", () => {
  it("positional 3-arg cond (object-shape, maps to if/then/else)", () => {
    expect(jsmql('$cond($.age, "adult", "minor")')).toEqual({
      $cond: { if: "$age", then: "adult", else: "minor" },
    });
  });

  it("object-style cond", () => {
    expect(jsmql('$cond({ if: $.active, then: "yes", else: "no" })')).toEqual({
      $cond: { if: "$active", then: "yes", else: "no" },
    });
  });
});

describe("jsmql template-tag form", () => {
  it("interpolates number", () => {
    const age = 21;
    expect(jsmql`$gt($.age, ${age})`).toEqual({ $gt: ["$age", 21] });
  });

  it("interpolates array", () => {
    const statuses = ["active", "pending"];
    expect(jsmql`$in($.status, ${statuses})`).toEqual({
      $in: ["$status", ["active", "pending"]],
    });
  });

  it("interpolates string", () => {
    const prefix = "admin";
    expect(jsmql`$eq($.role, ${prefix})`).toEqual({ $eq: ["$role", "admin"] });
  });

  it("works with no interpolations (template-tag detection survives empty values)", () => {
    expect(jsmql`$.age > 18`).toEqual({ $gt: ["$age", 18] });
  });
});

describe("jsmql() input-shape guard", () => {
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
    const r = (jsmql.validate as (x: unknown) => { valid: boolean; errors: { code: string }[] })(
      42,
    );
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
    expect(jsmql("$abs(-5)")).toEqual({ $abs: -5 });
  });
});

describe("arithmetic operators", () => {
  it("+ numeric", () => {
    expect(jsmql("$.a + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("- binary", () => {
    expect(jsmql("$.a - $.b")).toEqual({ $subtract: ["$a", "$b"] });
  });
  it("* multiply", () => {
    expect(jsmql("$.a * 1.1")).toEqual({ $multiply: ["$a", 1.1] });
  });
  it("/ divide", () => {
    expect(jsmql("$.a / $.b")).toEqual({ $divide: ["$a", "$b"] });
  });
  it("% modulo", () => {
    expect(jsmql("$.a % 2")).toEqual({ $mod: ["$a", 2] });
  });
  it("** power", () => {
    expect(jsmql("$.base ** 2")).toEqual({ $pow: ["$base", 2] });
  });
  it("** is right-associative", () => {
    expect(jsmql("2 ** 3 ** 2")).toEqual({ $pow: [2, { $pow: [3, 2] }] });
  });
});

describe("comparison operators", () => {
  it("==", () => {
    expect(jsmql("$.status == 'active'")).toEqual({ $eq: ["$status", "active"] });
  });
  it("===", () => {
    expect(jsmql("$.status === 'active'")).toEqual({ $eq: ["$status", "active"] });
  });
  it("!=", () => {
    expect(jsmql("$.status != null")).toEqual({ $ne: ["$status", null] });
  });
  it("!==", () => {
    expect(jsmql("$.status !== null")).toEqual({ $ne: ["$status", null] });
  });
  it(">", () => {
    expect(jsmql("$.age > 18")).toEqual({ $gt: ["$age", 18] });
  });
  it(">=", () => {
    expect(jsmql("$.age >= 21")).toEqual({ $gte: ["$age", 21] });
  });
  it("<", () => {
    expect(jsmql("$.score < 50")).toEqual({ $lt: ["$score", 50] });
  });
  it("<=", () => {
    expect(jsmql("$.score <= 100")).toEqual({ $lte: ["$score", 100] });
  });
  it("in", () => {
    expect(jsmql('$.status in ["active", "pending"]')).toEqual({
      $in: ["$status", ["active", "pending"]],
    });
  });
});

describe("logical operators", () => {
  it("&& on field refs returns operand (JS semantics)", () => {
    expect(jsmql("$.a && $.b")).toEqual({
      $cond: [truthy("$a"), "$b", "$a"],
    });
  });
  it("|| on field refs returns operand (JS semantics)", () => {
    expect(jsmql("$.a || $.b")).toEqual({
      $cond: [truthy("$a"), "$a", "$b"],
    });
  });
  it("&& on bool comparisons stays as $and (no operand-preservation needed)", () => {
    expect(jsmql("$.a > 0 && $.b > 0")).toEqual({
      $and: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }],
    });
  });
  it("|| on bool comparisons stays as $or", () => {
    expect(jsmql("$.a > 0 || $.b > 0")).toEqual({
      $or: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }],
    });
  });
  it("! unary uses JS truthiness", () => {
    expect(jsmql("!$.active")).toEqual({ $not: truthy("$active") });
  });
  it("!! double negation peephole → jsBool (no $not-of-$not)", () => {
    expect(jsmql("!!$.active")).toEqual(truthy("$active"));
  });
  it("! on a comparison elides the jsBool wrap", () => {
    expect(jsmql("!($.a > 0)")).toEqual({ $not: { $gt: ["$a", 0] } });
  });
  it("&& with non-pure-ref LHS uses $let to bind once", () => {
    expect(jsmql("($.a + $.b) && $.c")).toEqual({
      $let: {
        vars: { _v: { $add: ["$a", "$b"] } },
        in: { $cond: [truthy("$$_v"), "$c", "$$_v"] },
      },
    });
  });
  it("|| short-circuit chain with default (user's idiom)", () => {
    expect(jsmql('$.nickname || "anonymous"')).toEqual({
      $cond: [truthy("$nickname"), "$nickname", "anonymous"],
    });
  });
});

describe("ternary", () => {
  it("basic ternary with bool condition (no jsBool wrap)", () => {
    expect(jsmql("$.age >= 18 ? 'adult' : 'minor'")).toEqual({
      $cond: [{ $gte: ["$age", 18] }, "adult", "minor"],
    });
  });
  it("ternary with non-bool condition wraps in jsBool", () => {
    expect(jsmql('$.name ? "yes" : "no"')).toEqual({
      $cond: [truthy("$name"), "yes", "no"],
    });
  });
  it("nested ternary (right-associative) wraps each non-bool condition", () => {
    expect(jsmql("$.a ? 'x' : $.b ? 'y' : 'z'")).toEqual({
      $cond: [truthy("$a"), "x", { $cond: [truthy("$b"), "y", "z"] }],
    });
  });
});

describe("nullish coalescing", () => {
  it("??", () => {
    expect(jsmql("$.nickname ?? $.name")).toEqual({ $ifNull: ["$nickname", "$name"] });
  });
  it("?? flattened chain", () => {
    expect(jsmql("$.a ?? $.b ?? 'unknown'")).toEqual({
      $ifNull: ["$a", "$b", "unknown"],
    });
  });
});

describe("unary minus", () => {
  it("unary - on field", () => {
    expect(jsmql("-$.amount")).toEqual({ $multiply: ["$amount", -1] });
  });
  it("unary - on number literal optimised to negative number", () => {
    expect(jsmql("-5")).toEqual(-5);
  });
  it("unary - on number inside operator", () => {
    expect(jsmql("$abs(-5)")).toEqual({ $abs: -5 });
  });
  it("unary - on expression", () => {
    expect(jsmql("-($.a + $.b)")).toEqual({ $multiply: [{ $add: ["$a", "$b"] }, -1] });
  });
});

describe("operator flattening", () => {
  it("+ flattened to $add", () => {
    expect(jsmql("$.a + $.b + $.c")).toEqual({ $add: ["$a", "$b", "$c"] });
  });
  it("* flattened to $multiply", () => {
    expect(jsmql("$.a * $.b * $.c")).toEqual({ $multiply: ["$a", "$b", "$c"] });
  });
  it("&& on bool comparisons flattened to $and", () => {
    expect(jsmql("$.a > 0 && $.b > 0 && $.c > 0")).toEqual({
      $and: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }, { $gt: ["$c", 0] }],
    });
  });
  it("|| on bool comparisons flattened to $or", () => {
    expect(jsmql("$.a > 0 || $.b > 0 || $.c > 0")).toEqual({
      $or: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }, { $gt: ["$c", 0] }],
    });
  });
  it("&& on non-bool operands folds right into nested $cond (operand-preserving)", () => {
    expect(jsmql("$.a && $.b && $.c")).toEqual({
      $cond: [truthy("$a"), { $cond: [truthy("$b"), "$c", "$b"] }, "$a"],
    });
  });
  it("|| on non-bool operands folds right (operand-preserving)", () => {
    expect(jsmql("$.a || $.b || $.c")).toEqual({
      $cond: [truthy("$a"), "$a", { $cond: [truthy("$b"), "$b", "$c"] }],
    });
  });
  it("?? flattened to $ifNull (4 operands)", () => {
    expect(jsmql("$.a ?? $.b ?? $.c ?? 0")).toEqual({ $ifNull: ["$a", "$b", "$c", 0] });
  });
  it("- is NOT flattened (left-assoc, not same operator)", () => {
    expect(jsmql("$.a - $.b - $.c")).toEqual({
      $subtract: [{ $subtract: ["$a", "$b"] }, "$c"],
    });
  });
});

describe("string-context +", () => {
  it("string literal in chain → $concat", () => {
    expect(jsmql('$.first + " " + $.last')).toEqual({
      $concat: ["$first", " ", "$last"],
    });
  });
  it("empty string → $concat", () => {
    expect(jsmql('$.a + ""')).toEqual({ $concat: ["$a", ""] });
  });
  it("no string literal → $add", () => {
    expect(jsmql("$.a + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("string-output operator → $concat", () => {
    expect(jsmql("$toString($.n) + $.s")).toEqual({
      $concat: [{ $toString: "$n" }, "$s"],
    });
  });
  it("$toLower result in chain → $concat", () => {
    expect(jsmql("$.prefix + $toLower($.name)")).toEqual({
      $concat: ["$prefix", { $toLower: "$name" }],
    });
  });
  it("mixed numeric + string-output op → $concat", () => {
    expect(jsmql('$.count + " items"')).toEqual({ $concat: ["$count", " items"] });
  });
});

describe("bracket access", () => {
  it("constant index on bare field → runtime $cond on $isArray", () => {
    // Bare $.items receiver — type unknown — dispatch at runtime to handle
    // either array (numeric index) or object (dynamic key) at query time.
    expect(jsmql("$.items[0]")).toEqual({
      $cond: [
        { $isArray: "$items" },
        { $arrayElemAt: ["$items", 0] },
        { $getField: { field: 0, input: "$items" } },
      ],
    });
  });
  it("field index on bare field → runtime $cond", () => {
    expect(jsmql("$.items[$.idx]")).toEqual({
      $cond: [
        { $isArray: "$items" },
        { $arrayElemAt: ["$items", "$idx"] },
        { $getField: { field: "$idx", input: "$items" } },
      ],
    });
  });
  it("string-literal key on bare field → runtime $cond (the $getField branch is the right one for objects)", () => {
    expect(jsmql('$.config["host"]')).toEqual({
      $cond: [
        { $isArray: "$config" },
        { $arrayElemAt: ["$config", "host"] },
        { $getField: { field: "host", input: "$config" } },
      ],
    });
  });
  it("chained bracket access on bare field → nested $cond", () => {
    expect(jsmql("$.m[$.r][$.c]")).toEqual({
      $cond: [
        {
          $isArray: {
            $cond: [
              { $isArray: "$m" },
              { $arrayElemAt: ["$m", "$r"] },
              { $getField: { field: "$r", input: "$m" } },
            ],
          },
        },
        {
          $arrayElemAt: [
            {
              $cond: [
                { $isArray: "$m" },
                { $arrayElemAt: ["$m", "$r"] },
                { $getField: { field: "$r", input: "$m" } },
              ],
            },
            "$c",
          ],
        },
        {
          $getField: {
            field: "$c",
            input: {
              $cond: [
                { $isArray: "$m" },
                { $arrayElemAt: ["$m", "$r"] },
                { $getField: { field: "$r", input: "$m" } },
              ],
            },
          },
        },
      ],
    });
  });
  it("bracket access on known-array operator result stays compact", () => {
    expect(jsmql("$reverseArray($.items)[0]")).toEqual({
      $arrayElemAt: [{ $reverseArray: "$items" }, 0],
    });
  });
  it("bracket access on .map() result stays compact", () => {
    expect(jsmql("$.items.map(x => x.id)[0]")).toEqual({
      $arrayElemAt: [{ $map: { input: "$items", as: "x", in: "$$x.id" } }, 0],
    });
  });
});

describe("grouped expressions", () => {
  it("grouping changes precedence", () => {
    expect(jsmql("($.a + $.b) * 2")).toEqual({
      $multiply: [{ $add: ["$a", "$b"] }, 2],
    });
  });
  it("without grouping * binds tighter", () => {
    expect(jsmql("$.a + $.b * 2")).toEqual({
      $add: ["$a", { $multiply: ["$b", 2] }],
    });
  });
});

describe("operator precedence", () => {
  it("* before +", () => {
    expect(jsmql("$.a + $.b * $.c")).toEqual({
      $add: ["$a", { $multiply: ["$b", "$c"] }],
    });
  });
  it("comparison before && (mixed-bool chain folds operand-preserving)", () => {
    expect(jsmql("$.age > 18 && $.active")).toEqual({
      $cond: [{ $gt: ["$age", 18] }, "$active", { $gt: ["$age", 18] }],
    });
  });
  it("&& before ||", () => {
    expect(jsmql("$.a || $.b && $.c")).toEqual({
      $cond: [truthy("$a"), "$a", { $cond: [truthy("$b"), "$c", "$b"] }],
    });
  });
  it("! before && (LHS is provably bool, no $let)", () => {
    expect(jsmql("!$.a && $.b")).toEqual({
      $cond: [{ $not: truthy("$a") }, "$b", { $not: truthy("$a") }],
    });
  });
});

describe("mixed $operator() and infix", () => {
  it("infix inside $operator args", () => {
    expect(jsmql("$and($.age > 18, $.status == 'active')")).toEqual({
      $and: [{ $gt: ["$age", 18] }, { $eq: ["$status", "active"] }],
    });
  });
  it("$operator wrapping infix", () => {
    expect(jsmql("$abs($.a - $.b)")).toEqual({
      $abs: { $subtract: ["$a", "$b"] },
    });
  });
});

describe("$.in field ref still works", () => {
  it("field named 'in'", () => {
    expect(jsmql("$.in == 'test'")).toEqual({ $eq: ["$in", "test"] });
  });
  it("nested field with 'in' segment", () => {
    expect(jsmql("$size($.in)")).toEqual({ $size: "$in" });
  });
});

describe("field path regression (FieldRef stops at first segment)", () => {
  it("$.a.b.c produces $a.b.c", () => {
    expect(jsmql("$.a.b.c")).toEqual("$a.b.c");
  });
  it("$.items[0].name produces $getField on bracket-access result", () => {
    expect(jsmql("$.items[0].name")).toEqual({
      $getField: {
        field: "name",
        input: {
          $cond: [
            { $isArray: "$items" },
            { $arrayElemAt: ["$items", 0] },
            { $getField: { field: 0, input: "$items" } },
          ],
        },
      },
    });
  });
  it("rejects numeric field segments — $.items.0 is not valid JS syntax", () => {
    expect(() => jsmql("$.items.0")).toThrow(/Expected property name after '\.'/);
  });
  it("deep path inside $abs", () => {
    expect(jsmql("$abs($.a.b.c)")).toEqual({ $abs: "$a.b.c" });
  });
  it("dotted path in comparison", () => {
    expect(jsmql("$.loyalty.years >= 2")).toEqual({ $gte: ["$loyalty.years", 2] });
  });
});

describe("string methods", () => {
  it("trim", () => {
    expect(jsmql("$.name.trim()")).toEqual({ $trim: { input: "$name" } });
  });
  it("trimStart", () => {
    expect(jsmql("$.name.trimStart()")).toEqual({ $ltrim: { input: "$name" } });
  });
  it("trimLeft alias", () => {
    expect(jsmql("$.name.trimLeft()")).toEqual({ $ltrim: { input: "$name" } });
  });
  it("trimEnd", () => {
    expect(jsmql("$.name.trimEnd()")).toEqual({ $rtrim: { input: "$name" } });
  });
  it("trimRight alias", () => {
    expect(jsmql("$.name.trimRight()")).toEqual({ $rtrim: { input: "$name" } });
  });
  it("toLowerCase", () => {
    expect(jsmql("$.name.toLowerCase()")).toEqual({ $toLower: "$name" });
  });
  it("toUpperCase", () => {
    expect(jsmql("$.name.toUpperCase()")).toEqual({ $toUpper: "$name" });
  });
  it("substr", () => {
    expect(jsmql("$.name.substr(0, 5)")).toEqual({ $substrCP: ["$name", 0, 5] });
  });
  it("split", () => {
    expect(jsmql('$.csv.split(",")')).toEqual({ $split: ["$csv", ","] });
  });
  it("indexOf on bare field → runtime $cond on $isArray", () => {
    expect(jsmql('$.name.indexOf("@")')).toEqual({
      $cond: [
        { $isArray: "$name" },
        { $indexOfArray: ["$name", "@"] },
        { $indexOfCP: ["$name", "@"] },
      ],
    });
  });
  it("indexOf on known string → $indexOfCP", () => {
    expect(jsmql('$.name.toLowerCase().indexOf("@")')).toEqual({
      $indexOfCP: [{ $toLower: "$name" }, "@"],
    });
  });
  it("replace", () => {
    expect(jsmql('$.name.replace("a", "b")')).toEqual({
      $replaceOne: { input: "$name", find: "a", replacement: "b" },
    });
  });
  it("replaceAll", () => {
    expect(jsmql('$.slug.replaceAll(" ", "-")')).toEqual({
      $replaceAll: { input: "$slug", find: " ", replacement: "-" },
    });
  });
  it("includes on bare field → runtime $cond on $isArray", () => {
    expect(jsmql('$.email.includes("@")')).toEqual({
      $cond: [
        { $isArray: "$email" },
        { $in: ["@", "$email"] },
        { $gte: [{ $indexOfCP: ["$email", "@"] }, 0] },
      ],
    });
  });
  it("includes on known string → string form", () => {
    expect(jsmql('$.email.toLowerCase().includes("@")')).toEqual({
      $gte: [{ $indexOfCP: [{ $toLower: "$email" }, "@"] }, 0],
    });
  });
  it("match with regex literal", () => {
    expect(jsmql("$.str.match(/^[A-Z]/)")).toEqual({
      $regexMatch: { input: "$str", regex: "^[A-Z]" },
    });
  });
  it("match with regex literal and flags", () => {
    expect(jsmql("$.str.match(/^[a-z]/i)")).toEqual({
      $regexMatch: { input: "$str", regex: "^[a-z]", options: "i" },
    });
  });
  it("match with string pattern", () => {
    expect(jsmql('$.str.match("^[a-z]")')).toEqual({
      $regexMatch: { input: "$str", regex: "^[a-z]" },
    });
  });
  it("length on string-producing expression → $strLenCP", () => {
    expect(jsmql("$.name.trim().length")).toEqual({ $strLenCP: { $trim: { input: "$name" } } });
  });
  it("length on array-producing expression → $size", () => {
    expect(jsmql('$.csv.split(",").length')).toEqual({ $size: { $split: ["$csv", ","] } });
  });
  it("length on map result → $size", () => {
    expect(jsmql("$.items.map(x => x).length")).toEqual({
      $size: { $map: { input: "$items", as: "x", in: "$$x" } },
    });
  });
  it("length on unknown field → runtime dispatch", () => {
    expect(jsmql("$.items.length")).toEqual({
      $cond: [{ $isArray: "$items" }, { $size: "$items" }, { $strLenCP: "$items" }],
    });
  });
  it("chained trim then toLowerCase", () => {
    expect(jsmql("$.name.trim().toLowerCase()")).toEqual({
      $toLower: { $trim: { input: "$name" } },
    });
  });
  it("chained toLowerCase then trim", () => {
    expect(jsmql("$.name.toLowerCase().trim()")).toEqual({
      $trim: { input: { $toLower: "$name" } },
    });
  });
});

describe("array methods (no lambda)", () => {
  it("at(n)", () => {
    expect(jsmql("$.items.at(0)")).toEqual({ $arrayElemAt: ["$items", 0] });
  });
  it("at(-1)", () => {
    expect(jsmql("$.items.at(-1)")).toEqual({ $arrayElemAt: ["$items", -1] });
  });
  it("slice(start)", () => {
    expect(jsmql("$.items.slice(2)")).toEqual({ $slice: ["$items", 2] });
  });
  it("slice(start, count)", () => {
    expect(jsmql("$.items.slice(0, 3)")).toEqual({ $slice: ["$items", 0, 3] });
  });
  it("reverse()", () => {
    expect(jsmql("$.items.reverse()")).toEqual({ $reverseArray: "$items" });
  });
});

describe("array methods (with lambda)", () => {
  it("map with single param", () => {
    expect(jsmql("$.prices.map(p => p * 1.1)")).toEqual({
      $map: { input: "$prices", as: "p", in: { $multiply: ["$$p", 1.1] } },
    });
  });
  it("map with parenthesized param", () => {
    expect(jsmql("$.prices.map((p) => p * 1.1)")).toEqual({
      $map: { input: "$prices", as: "p", in: { $multiply: ["$$p", 1.1] } },
    });
  });
  it("filter", () => {
    expect(jsmql("$.items.filter(x => x > 0)")).toEqual({
      $filter: { input: "$items", as: "x", cond: { $gt: ["$$x", 0] } },
    });
  });
  it("find", () => {
    expect(jsmql("$.items.find(x => x > 0)")).toEqual({
      $arrayElemAt: [{ $filter: { input: "$items", as: "x", cond: { $gt: ["$$x", 0] } } }, 0],
    });
  });
  it("some", () => {
    expect(jsmql("$.items.some(x => x > 0)")).toEqual({
      $anyElementTrue: { $map: { input: "$items", as: "x", in: { $gt: ["$$x", 0] } } },
    });
  });
  it("every", () => {
    expect(jsmql("$.items.every(x => x > 0)")).toEqual({
      $allElementsTrue: { $map: { input: "$items", as: "x", in: { $gt: ["$$x", 0] } } },
    });
  });
  it("reduce", () => {
    expect(jsmql("$.ns.reduce((acc, x) => acc + x, 0)")).toEqual({
      $reduce: { input: "$ns", initialValue: 0, in: { $add: ["$$value", "$$this"] } },
    });
  });
  it("lambda accessing doc field via $.", () => {
    expect(jsmql("$.items.map(x => x * $.taxRate)")).toEqual({
      $map: { input: "$items", as: "x", in: { $multiply: ["$$x", "$taxRate"] } },
    });
  });
  it("lambda accessing nested field on element (x.status → $$x.status)", () => {
    expect(jsmql('$.orders.filter(o => o.status == "active")')).toEqual({
      $filter: { input: "$orders", as: "o", cond: { $eq: ["$$o.status", "active"] } },
    });
  });
  it("reduce accessing element field ($$this.price)", () => {
    expect(jsmql("$.orders.reduce((sum, o) => sum + o.price, 0)")).toEqual({
      $reduce: {
        input: "$orders",
        initialValue: 0,
        in: { $add: ["$$value", "$$this.price"] },
      },
    });
  });
});

describe("bare type-cast callbacks", () => {
  it("filter(Boolean) drops JS-falsy elements", () => {
    expect(jsmql("$.items.filter(Boolean)")).toEqual({
      $filter: { input: "$items", as: "v", cond: truthy("$$v") },
    });
  });
  it("map(Number) coerces to double", () => {
    expect(jsmql("$.nums.map(Number)")).toEqual({
      $map: { input: "$nums", as: "v", in: { $toDouble: "$$v" } },
    });
  });
  it("map(String) coerces to string", () => {
    expect(jsmql("$.xs.map(String)")).toEqual({
      $map: { input: "$xs", as: "v", in: { $toString: "$$v" } },
    });
  });
  it("find(Boolean) returns first JS-truthy element", () => {
    expect(jsmql("$.xs.find(Boolean)")).toEqual({
      $arrayElemAt: [{ $filter: { input: "$xs", as: "v", cond: truthy("$$v") } }, 0],
    });
  });
  it("some(Boolean) is any-JS-truthy", () => {
    expect(jsmql("$.xs.some(Boolean)")).toEqual({
      $anyElementTrue: { $map: { input: "$xs", as: "v", in: truthy("$$v") } },
    });
  });
  it("every(Boolean) is all-JS-truthy", () => {
    expect(jsmql("$.xs.every(Boolean)")).toEqual({
      $allElementsTrue: { $map: { input: "$xs", as: "v", in: truthy("$$v") } },
    });
  });
  it("flatMap(Number) survives the desugar", () => {
    expect(jsmql("$.xs.flatMap(Number)")).toEqual({
      $reduce: {
        input: { $map: { input: "$xs", as: "v", in: { $toDouble: "$$v" } } },
        initialValue: [],
        in: { $concatArrays: ["$$value", "$$this"] },
      },
    });
  });
  it("composes through chaining: filter(Boolean).join(' ')", () => {
    expect(jsmql('$.parts.filter(Boolean).join(" ")')).toEqual({
      $reduce: {
        input: { $filter: { input: "$parts", as: "v", cond: truthy("$$v") } },
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
  it("Boolean as a value (outside callback) errors with the call form suggested", () => {
    expect(() => jsmql("Boolean + 5")).toThrow(/used as a value.*Boolean\(value\)/);
  });
  it("reduce(Boolean, 0) hits the existing 2-param error", () => {
    expect(() => jsmql("$.xs.reduce(Boolean, 0)")).toThrow(/exactly 2 parameters/);
  });
  it("parseInt is intentionally not supported bare (avoids the JS index-as-radix footgun)", () => {
    expect(() => jsmql("$.xs.filter(parseInt)")).toThrow(/Expected LParen/);
  });
  it("parseFloat is intentionally not supported bare", () => {
    expect(() => jsmql("$.xs.filter(parseFloat)")).toThrow(/Expected LParen/);
  });
});

describe("date methods", () => {
  it("getFullYear", () => {
    expect(jsmql("$.ts.getFullYear()")).toEqual({ $year: "$ts" });
  });
  it("getMonth (0-based)", () => {
    expect(jsmql("$.ts.getMonth()")).toEqual({ $subtract: [{ $month: "$ts" }, 1] });
  });
  it("getDate", () => {
    expect(jsmql("$.ts.getDate()")).toEqual({ $dayOfMonth: "$ts" });
  });
  it("getDay (0-based)", () => {
    expect(jsmql("$.ts.getDay()")).toEqual({ $subtract: [{ $dayOfWeek: "$ts" }, 1] });
  });
  it("getHours", () => {
    expect(jsmql("$.ts.getHours()")).toEqual({ $hour: "$ts" });
  });
  it("getMinutes", () => {
    expect(jsmql("$.ts.getMinutes()")).toEqual({ $minute: "$ts" });
  });
  it("getSeconds", () => {
    expect(jsmql("$.ts.getSeconds()")).toEqual({ $second: "$ts" });
  });
  it("getMilliseconds", () => {
    expect(jsmql("$.ts.getMilliseconds()")).toEqual({ $millisecond: "$ts" });
  });
});

describe("typeof", () => {
  it("typeof fieldref", () => {
    expect(jsmql("typeof $.x")).toEqual({ $type: "$x" });
  });
  it("typeof in comparison", () => {
    expect(jsmql('typeof $.x == "string"')).toEqual({ $eq: [{ $type: "$x" }, "string"] });
  });
});

describe("new Date()", () => {
  it("no-arg maps to $$NOW", () => {
    expect(jsmql("new Date()")).toEqual({ $toDate: "$$NOW" });
  });
  it("with field arg", () => {
    expect(jsmql("new Date($.ts)")).toEqual({ $toDate: "$ts" });
  });
  it("with string literal", () => {
    expect(jsmql('new Date("2024-01-01")')).toEqual({ $toDate: "2024-01-01" });
  });
});

describe("type casts", () => {
  it("Number()", () => {
    expect(jsmql("Number($.str)")).toEqual({ $toDouble: "$str" });
  });
  it("String()", () => {
    expect(jsmql("String($.n)")).toEqual({ $toString: "$n" });
  });
  it("Boolean() uses JS truthy semantics (not MQL's $toBool)", () => {
    expect(jsmql("Boolean($.x)")).toEqual(truthy("$x"));
  });
  it("Boolean() on a provably-bool value elides the wrap", () => {
    expect(jsmql("Boolean($.x > 0)")).toEqual({ $gt: ["$x", 0] });
  });
  it("$toBool() direct operator escape preserves raw MongoDB semantics", () => {
    expect(jsmql("$toBool($.x)")).toEqual({ $toBool: "$x" });
  });
  it("parseInt()", () => {
    expect(jsmql("parseInt($.s)")).toEqual({ $toInt: "$s" });
  });
  it("parseFloat()", () => {
    expect(jsmql("parseFloat($.s)")).toEqual({ $toDouble: "$s" });
  });
});

describe("Math.*", () => {
  it("Math.abs", () => {
    expect(jsmql("Math.abs($.x)")).toEqual({ $abs: "$x" });
  });
  it("Math.ceil", () => {
    expect(jsmql("Math.ceil($.x)")).toEqual({ $ceil: "$x" });
  });
  it("Math.floor", () => {
    expect(jsmql("Math.floor($.x)")).toEqual({ $floor: "$x" });
  });
  it("Math.round adds 0 precision", () => {
    expect(jsmql("Math.round($.x)")).toEqual({ $round: ["$x", 0] });
  });
  it("Math.pow", () => {
    expect(jsmql("Math.pow(2, $.n)")).toEqual({ $pow: [2, "$n"] });
  });
  it("Math.sqrt", () => {
    expect(jsmql("Math.sqrt($.x)")).toEqual({ $sqrt: "$x" });
  });
  it("Math.exp", () => {
    expect(jsmql("Math.exp($.x)")).toEqual({ $exp: "$x" });
  });
  it("Math.log (natural log → $ln)", () => {
    expect(jsmql("Math.log($.x)")).toEqual({ $ln: "$x" });
  });
  it("Math.trunc", () => {
    expect(jsmql("Math.trunc($.x)")).toEqual({ $trunc: "$x" });
  });
});

describe("Math trigonometry", () => {
  it("Math.sin", () => {
    expect(jsmql("Math.sin($.angle)")).toEqual({ $sin: "$angle" });
  });
  it("Math.cos", () => {
    expect(jsmql("Math.cos($.angle)")).toEqual({ $cos: "$angle" });
  });
  it("Math.tan", () => {
    expect(jsmql("Math.tan($.angle)")).toEqual({ $tan: "$angle" });
  });
  it("Math.asin", () => {
    expect(jsmql("Math.asin($.x)")).toEqual({ $asin: "$x" });
  });
  it("Math.acos", () => {
    expect(jsmql("Math.acos($.x)")).toEqual({ $acos: "$x" });
  });
  it("Math.atan", () => {
    expect(jsmql("Math.atan($.x)")).toEqual({ $atan: "$x" });
  });
  it("Math.atan2", () => {
    expect(jsmql("Math.atan2($.y, $.x)")).toEqual({ $atan2: ["$y", "$x"] });
  });
  it("Math.atan2 wrong arity", () => {
    expect(() => jsmql("Math.atan2($.x)")).toThrow(/exactly 2 arguments/);
  });
  it("Math.sinh", () => {
    expect(jsmql("Math.sinh($.x)")).toEqual({ $sinh: "$x" });
  });
  it("Math.cosh", () => {
    expect(jsmql("Math.cosh($.x)")).toEqual({ $cosh: "$x" });
  });
  it("Math.tanh", () => {
    expect(jsmql("Math.tanh($.x)")).toEqual({ $tanh: "$x" });
  });
  it("Math.asinh", () => {
    expect(jsmql("Math.asinh($.x)")).toEqual({ $asinh: "$x" });
  });
  it("Math.acosh", () => {
    expect(jsmql("Math.acosh($.x)")).toEqual({ $acosh: "$x" });
  });
  it("Math.atanh", () => {
    expect(jsmql("Math.atanh($.x)")).toEqual({ $atanh: "$x" });
  });
});

describe("bitwise infix operators", () => {
  it("a & b", () => {
    expect(jsmql("$.a & $.b")).toEqual({ $bitAnd: ["$a", "$b"] });
  });
  it("a | b", () => {
    expect(jsmql("$.a | $.b")).toEqual({ $bitOr: ["$a", "$b"] });
  });
  it("a ^ b", () => {
    expect(jsmql("$.a ^ $.b")).toEqual({ $bitXor: ["$a", "$b"] });
  });
  it("~a", () => {
    expect(jsmql("~$.a")).toEqual({ $bitNot: "$a" });
  });
  it("a & b & c flattens", () => {
    expect(jsmql("$.a & $.b & $.c")).toEqual({ $bitAnd: ["$a", "$b", "$c"] });
  });
  it("a | b | c flattens", () => {
    expect(jsmql("$.a | $.b | $.c")).toEqual({ $bitOr: ["$a", "$b", "$c"] });
  });
  it("a ^ b ^ c flattens", () => {
    expect(jsmql("$.a ^ $.b ^ $.c")).toEqual({ $bitXor: ["$a", "$b", "$c"] });
  });
  it("(a & b) | c precedence: & binds tighter than |", () => {
    expect(jsmql("$.a & $.b | $.c")).toEqual({
      $bitOr: [{ $bitAnd: ["$a", "$b"] }, "$c"],
    });
  });
  it("(a ^ b) | c precedence: ^ binds tighter than |", () => {
    expect(jsmql("$.a ^ $.b | $.c")).toEqual({
      $bitOr: [{ $bitXor: ["$a", "$b"] }, "$c"],
    });
  });
  it("(a & b) ^ c precedence: & binds tighter than ^", () => {
    expect(jsmql("$.a & $.b ^ $.c")).toEqual({
      $bitXor: [{ $bitAnd: ["$a", "$b"] }, "$c"],
    });
  });
  it("&& binds looser than | (so a | b && c → (a | b) && c)", () => {
    // LHS `$.a | $.b` is non-pure-ref → $let binds it once for the cond chain.
    expect(jsmql("$.a | $.b && $.c")).toEqual({
      $let: {
        vars: { _v: { $bitOr: ["$a", "$b"] } },
        in: { $cond: [truthy("$$_v"), "$c", "$$_v"] },
      },
    });
  });
  it("== binds tighter than & (so a == b & c → (a == b) & c)", () => {
    expect(jsmql("$.a == $.b & $.c")).toEqual({
      $bitAnd: [{ $eq: ["$a", "$b"] }, "$c"],
    });
  });
  it("unary ~ has higher precedence than &", () => {
    expect(jsmql("~$.flags & 255")).toEqual({
      $bitAnd: [{ $bitNot: "$flags" }, 255],
    });
  });
});

describe("Object.*", () => {
  it("Object.keys", () => {
    expect(jsmql("Object.keys($.doc)")).toEqual({
      $map: { input: { $objectToArray: "$doc" }, as: "kv", in: "$$kv.k" },
    });
  });
  it("Object.values", () => {
    expect(jsmql("Object.values($.doc)")).toEqual({
      $map: { input: { $objectToArray: "$doc" }, as: "kv", in: "$$kv.v" },
    });
  });
  it("Object.entries", () => {
    expect(jsmql("Object.entries($.doc)")).toEqual({ $objectToArray: "$doc" });
  });
  it("Object.assign (2 args)", () => {
    expect(jsmql("Object.assign($.a, $.b)")).toEqual({ $mergeObjects: ["$a", "$b"] });
  });
  it("Object.assign (3 args)", () => {
    expect(jsmql("Object.assign($.a, $.b, $.c)")).toEqual({ $mergeObjects: ["$a", "$b", "$c"] });
  });
});

describe("$let with lambda", () => {
  it("single var lambda", () => {
    expect(jsmql("$let({ d: $.price * 0.1 }, (d) => $.price - d)")).toEqual({
      $let: {
        vars: { d: { $multiply: ["$price", 0.1] } },
        in: { $subtract: ["$price", "$$d"] },
      },
    });
  });
});

describe("immutable array methods", () => {
  it(".toSorted() with no comparator → ascending", () => {
    expect(jsmql("$.scores.toSorted()")).toEqual({
      $sortArray: { input: "$scores", sortBy: 1 },
    });
  });
  it(".toSorted with comparator throws helpful error", () => {
    expect(() => jsmql("$.scores.toSorted((a, b) => a - b)")).toThrow(
      /comparator is not supported/,
    );
  });
  it(".toReversed() is array-context", () => {
    expect(jsmql("$.items.toReversed()")).toEqual({ $reverseArray: "$items" });
  });
  it(".toReversed() chainable with .map()", () => {
    expect(jsmql("$.items.toReversed().map(x => x.name)")).toEqual({
      $map: {
        input: { $reverseArray: "$items" },
        as: "x",
        in: "$$x.name",
      },
    });
  });
  it(".findLast(p) returns last matching element (predicate body wrapped in jsBool)", () => {
    expect(jsmql("$.items.findLast(x => x.active)")).toEqual({
      $arrayElemAt: [
        {
          $filter: {
            input: "$items",
            as: "x",
            cond: truthy("$$x.active"),
          },
        },
        -1,
      ],
    });
  });
  it(".findLastIndex(p) reduces (idx, el) pairs (predicate body wrapped in jsBool)", () => {
    expect(jsmql("$.items.findLastIndex(x => x.active)")).toEqual({
      $reduce: {
        input: {
          $zip: { inputs: [{ $range: [0, { $size: "$items" }] }, "$items"] },
        },
        initialValue: -1,
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$this", 1] } },
            in: {
              $cond: [truthy("$$x.active"), { $arrayElemAt: ["$$this", 0] }, "$$value"],
            },
          },
        },
      },
    });
  });
});

describe("ES2025 Set methods", () => {
  it("intersection", () => {
    expect(jsmql("new Set($.a).intersection(new Set($.b))")).toEqual({
      $setIntersection: ["$a", "$b"],
    });
  });
  it("union", () => {
    expect(jsmql("new Set($.a).union(new Set($.b))")).toEqual({
      $setUnion: ["$a", "$b"],
    });
  });
  it("difference", () => {
    expect(jsmql("new Set($.a).difference(new Set($.b))")).toEqual({
      $setDifference: ["$a", "$b"],
    });
  });
  it("isSubsetOf", () => {
    expect(jsmql("new Set($.a).isSubsetOf(new Set($.b))")).toEqual({
      $setIsSubset: ["$a", "$b"],
    });
  });
  it("isSupersetOf swaps args", () => {
    expect(jsmql("new Set($.a).isSupersetOf(new Set($.b))")).toEqual({
      $setIsSubset: ["$b", "$a"],
    });
  });
  it("works with array literals", () => {
    expect(jsmql("new Set([1, 2, 3]).intersection(new Set([2, 3, 4]))")).toEqual({
      $setIntersection: [
        [1, 2, 3],
        [2, 3, 4],
      ],
    });
  });
  it("symmetricDifference throws helpful error", () => {
    expect(() => jsmql("new Set($.a).symmetricDifference(new Set($.b))")).toThrow(
      /no MongoDB equivalent/,
    );
  });
  it("non-Set argument is rejected", () => {
    expect(() => jsmql("new Set($.a).intersection($.b)")).toThrow(/must be a 'new Set/);
  });
});

describe("regex method variants", () => {
  it("/re/.test(str)", () => {
    expect(jsmql("/[a-z]+/.test($.s)")).toEqual({
      $regexMatch: { input: "$s", regex: "[a-z]+" },
    });
  });
  it("/re/flags.test(str) preserves flags", () => {
    expect(jsmql("/PAT/i.test($.s)")).toEqual({
      $regexMatch: { input: "$s", regex: "PAT", options: "i" },
    });
  });
  it("/re/.exec(str)", () => {
    expect(jsmql("/word/.exec($.s)")).toEqual({
      $regexFind: { input: "$s", regex: "word" },
    });
  });
  it("str.matchAll(/re/g)", () => {
    expect(jsmql("$.s.matchAll(/word/g)")).toEqual({
      $regexFindAll: { input: "$s", regex: "word", options: "g" },
    });
  });
  it("matchAll without g flag throws", () => {
    expect(() => jsmql("$.s.matchAll(/word/)")).toThrow(/'g' flag/);
  });
  it("str.search(/re/) returns idx with -1 fallback", () => {
    expect(jsmql("$.s.search(/foo/)")).toEqual({
      $ifNull: [
        { $getField: { field: "idx", input: { $regexFind: { input: "$s", regex: "foo" } } } },
        -1,
      ],
    });
  });
});

describe("Number static predicates", () => {
  it("Number.isInteger(x)", () => {
    expect(jsmql("Number.isInteger($.n)")).toEqual({
      $cond: [
        { $in: [{ $type: "$n" }, ["int", "long"]] },
        true,
        {
          $cond: [
            { $in: [{ $type: "$n" }, ["double", "decimal"]] },
            { $eq: ["$n", { $trunc: "$n" }] },
            false,
          ],
        },
      ],
    });
  });
  it("Number.isNaN(x)", () => {
    expect(jsmql("Number.isNaN($.x)")).toEqual({ $ne: ["$x", "$x"] });
  });
  it("Number.isFinite(x) throws helpful error", () => {
    expect(() => jsmql("Number.isFinite($.x)")).toThrow(/no Infinity literal/);
  });
});

describe("string padding methods", () => {
  it("padStart with explicit char", () => {
    expect(jsmql('$.code.padStart(5, "0")')).toEqual({
      $let: {
        vars: { s: "$code" },
        in: {
          $cond: [
            { $gte: [{ $strLenCP: "$$s" }, 5] },
            "$$s",
            {
              $concat: [
                {
                  $reduce: {
                    input: { $range: [0, { $subtract: [5, { $strLenCP: "$$s" }] }] },
                    initialValue: "",
                    in: { $concat: ["$$value", "0"] },
                  },
                },
                "$$s",
              ],
            },
          ],
        },
      },
    });
  });
  it("padStart defaults to space", () => {
    const out = jsmql("$.s.padStart(10)") as Record<string, unknown>;
    // Spot-check: pad string should be a space
    expect(JSON.stringify(out)).toContain('"in":{"$concat":["$$value"," "]}');
  });
  it("padEnd order is str-then-pad", () => {
    const out = jsmql('$.s.padEnd(10, "-")') as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain('["$$s",{"$reduce"');
  });
  it("repeat", () => {
    expect(jsmql('"-".repeat(5)')).toEqual({
      $reduce: {
        input: { $range: [0, 5] },
        initialValue: "",
        in: { $concat: ["$$value", "-"] },
      },
    });
  });
});

describe("Array.from({length, ...})", () => {
  it("no map function returns $range", () => {
    expect(jsmql("Array.from({ length: 5 })")).toEqual({ $range: [0, 5] });
  });
  it("with (_, i) => body maps over $range", () => {
    expect(jsmql("Array.from({ length: 3 }, (_, i) => i * 2)")).toEqual({
      $map: {
        input: { $range: [0, 3] },
        as: "i",
        in: {
          $let: {
            vars: { _: null },
            in: { $multiply: ["$$i", 2] },
          },
        },
      },
    });
  });
  it("with $.length expression", () => {
    const out = jsmql("Array.from({ length: $.n }, (_, i) => i)") as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain('"$range":[0,"$n"]');
  });
  it("non-{length} input throws", () => {
    expect(() => jsmql("Array.from($.iter)")).toThrow(/{length: n} form/);
  });
  it("requires 2-param map function", () => {
    expect(() => jsmql("Array.from({ length: 3 }, x => x)")).toThrow(/2 parameters/);
  });
});

describe("BigInt literals", () => {
  it("integer with n suffix", () => {
    expect(jsmql("123n")).toEqual({ $toLong: "123" });
  });
  it("zero", () => {
    expect(jsmql("0n")).toEqual({ $toLong: "0" });
  });
  it("rejects fraction with n", () => {
    expect(() => jsmql("1.5n")).toThrow(/Invalid BigInt/);
  });
  it("rejects exponent with n", () => {
    expect(() => jsmql("1e2n")).toThrow(/Invalid BigInt/);
  });
  it("works in arithmetic", () => {
    expect(jsmql("$.timestamp - 1000n")).toEqual({
      $subtract: ["$timestamp", { $toLong: "1000" }],
    });
  });
});

describe("Object.groupBy", () => {
  it("groups by category", () => {
    expect(jsmql("Object.groupBy($.items, x => x.category)")).toEqual({
      $reduce: {
        input: "$items",
        initialValue: {},
        in: {
          $let: {
            vars: { key: { $toString: "$$this.category" } },
            in: {
              $mergeObjects: [
                "$$value",
                {
                  $arrayToObject: [
                    [
                      [
                        "$$key",
                        {
                          $concatArrays: [
                            {
                              $ifNull: [{ $getField: { field: "$$key", input: "$$value" } }, []],
                            },
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
    expect(() => jsmql("Object.groupBy($.items, $.f)")).toThrow(/single-parameter arrow function/);
  });
  it("rejects multi-param lambda", () => {
    expect(() => jsmql("Object.groupBy($.items, (a, b) => a)")).toThrow(
      /single-parameter arrow function/,
    );
  });
});

describe("IIFE → $let", () => {
  it("simple ((x) => body)(value)", () => {
    expect(jsmql("((x) => x + 1)(5)")).toEqual({
      $let: { vars: { x: 5 }, in: { $add: ["$$x", 1] } },
    });
  });
  it("unparen single param (x => body)(value)", () => {
    expect(jsmql("(x => x * 2)($.n)")).toEqual({
      $let: { vars: { x: "$n" }, in: { $multiply: ["$$x", 2] } },
    });
  });
  it("multi-param IIFE binds all params", () => {
    expect(jsmql("((maxAge, minAge) => $.age >= minAge && $.age <= maxAge)(65, 18)")).toEqual({
      $let: {
        vars: { maxAge: 65, minAge: 18 },
        in: { $and: [{ $gte: ["$age", "$$minAge"] }, { $lte: ["$age", "$$maxAge"] }] },
      },
    });
  });
  it("zero-param IIFE", () => {
    expect(jsmql("(() => $.x + $.y)()")).toEqual({
      $let: { vars: {}, in: { $add: ["$x", "$y"] } },
    });
  });
  it("body can reference outer $.fields", () => {
    expect(jsmql("((d) => $.price - d)($.price * 0.1)")).toEqual({
      $let: {
        vars: { d: { $multiply: ["$price", 0.1] } },
        in: { $subtract: ["$price", "$$d"] },
      },
    });
  });
  it("rejects mismatched arity", () => {
    expect(() => jsmql("((x, y) => x + y)(1)")).toThrow(/expected 2 argument/);
  });
  it("rejects calling a non-lambda", () => {
    expect(() => jsmql("$.func(1, 2)")).toThrow(/Direct call/);
  });
  it("rejects spread args", () => {
    expect(() => jsmql("((x) => x)(...$.arr)")).toThrow(/spread/);
  });
});

describe("string-context + with method calls", () => {
  it("trim() in + chain is string-producing", () => {
    expect(jsmql('$.first.trim() + " " + $.last')).toEqual({
      $concat: [{ $trim: { input: "$first" } }, " ", "$last"],
    });
  });
  it("String() cast in + chain is string-producing", () => {
    expect(jsmql('String($.n) + " items"')).toEqual({
      $concat: [{ $toString: "$n" }, " items"],
    });
  });
  it("typeof in + chain is string-producing", () => {
    expect(jsmql('typeof $.x + " type"')).toEqual({
      $concat: [{ $type: "$x" }, " type"],
    });
  });
});

describe("regex literals (context-sensitive /)", () => {
  it("regex after operator is a literal, not divide", () => {
    expect(jsmql("$.str.match(/[a-z]+/)")).toEqual({
      $regexMatch: { input: "$str", regex: "[a-z]+" },
    });
  });
  it("/ after number is divide", () => {
    expect(jsmql("$.x / 2")).toEqual({ $divide: ["$x", 2] });
  });
  it("regex with multiple flags", () => {
    expect(jsmql("$.str.match(/pattern/gi)")).toEqual({
      $regexMatch: { input: "$str", regex: "pattern", options: "gi" },
    });
  });
});

describe("error cases", () => {
  it("bare identifier outside lambda throws Did you mean", () => {
    expect(() => jsmql("x > 0")).toThrow(/Did you mean/);
  });
  it("unknown method throws with helpful message", () => {
    expect(() => jsmql("$.name.frobulate()")).toThrow(/Unknown method/);
  });
  it("near-miss method names get a 'Did you mean' suggestion", () => {
    expect(() => jsmql("$.name.toLowerCse()")).toThrow(/Did you mean '\.toLowerCase\(\)'/);
    expect(() => jsmql("$.items.fliter(x => x)")).toThrow(/Did you mean '\.filter\(\)'/);
  });
  it("lambda in non-method context throws", () => {
    expect(() => jsmql("$abs(x => x)")).toThrow(/Lambda expression/);
  });
});

describe("1-arg substr", () => {
  it("substr(start) slices to end of string", () => {
    expect(jsmql("$.email.substr(1)")).toEqual({
      $substrCP: ["$email", 1, { $strLenCP: "$email" }],
    });
  });
  it("substr(start, count) keeps 2-arg form", () => {
    expect(jsmql("$.name.substr(0, 3)")).toEqual({ $substrCP: ["$name", 0, 3] });
  });
  it("substr with expression start", () => {
    expect(jsmql("$.email.substr($.headerLength + 1)")).toEqual({
      $substrCP: ["$email", { $add: ["$headerLength", 1] }, { $strLenCP: "$email" }],
    });
  });
});

describe("comparison precedence: relational higher than equality", () => {
  it("a < b == true parses as (a < b) == true", () => {
    expect(jsmql("$.a < $.b == true")).toEqual({
      $eq: [{ $lt: ["$a", "$b"] }, true],
    });
  });
  it("a > 0 == b > 0 parses as (a > 0) == (b > 0)", () => {
    expect(jsmql("$.a > 0 == $.b > 0")).toEqual({
      $eq: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }],
    });
  });
  it("simple relational still works", () => {
    expect(jsmql("$.x < 5")).toEqual({ $lt: ["$x", 5] });
  });
  it("simple equality still works", () => {
    expect(jsmql("$.x == 5")).toEqual({ $eq: ["$x", 5] });
  });
});

describe("in operator RHS validation", () => {
  it("throws on string RHS", () => {
    expect(() => jsmql('$.x in "abc"')).toThrow(/Right-hand side of 'in'/);
  });
  it("throws on number RHS", () => {
    expect(() => jsmql("$.x in 42")).toThrow(/Right-hand side of 'in'/);
  });
  it("throws on boolean RHS", () => {
    expect(() => jsmql("$.x in true")).toThrow(/Right-hand side of 'in'/);
  });
  it("throws on null RHS", () => {
    expect(() => jsmql("$.x in null")).toThrow(/Right-hand side of 'in'/);
  });
  it("accepts array literal RHS", () => {
    expect(jsmql('$.x in ["a", "b"]')).toEqual({ $in: ["$x", ["a", "b"]] });
  });
  it("object literal RHS → property-existence (JS-faithful)", () => {
    expect(jsmql("$.x in { a: 1, b: 2 }")).toEqual({ $in: ["$x", ["a", "b"]] });
  });
  it("string-literal LHS works against an object literal", () => {
    expect(jsmql("'a' in { a: 1, b: 2 }")).toEqual({ $in: ["a", ["a", "b"]] });
  });
  it("object literal with computed key emits the key expression", () => {
    expect(jsmql("$.x in { a: 1, [$.dynKey]: 2 }")).toEqual({
      $in: ["$x", ["a", "$dynKey"]],
    });
  });
  it("object literal with spread uses $objectToArray for the spread keys", () => {
    expect(jsmql("$.x in { ...$.base, a: 1 }")).toEqual({
      $in: [
        "$x",
        {
          $concatArrays: [
            { $map: { input: { $objectToArray: "$base" }, as: "kv", in: "$$kv.k" } },
            ["a"],
          ],
        },
      ],
    });
  });
  it("object literal with only spread reduces to $objectToArray.k directly", () => {
    expect(jsmql("$.x in { ...$.other }")).toEqual({
      $in: ["$x", { $map: { input: { $objectToArray: "$other" }, as: "kv", in: "$$kv.k" } }],
    });
  });
  it("accepts field ref RHS", () => {
    expect(jsmql("$.x in $.list")).toEqual({ $in: ["$x", "$list"] });
  });
});

describe("EOF error message", () => {
  it("empty string gives Unexpected end of expression", () => {
    expect(() => jsmql("")).toThrow(/Unexpected end of expression/);
  });
  it("trailing operator gives Unexpected end of expression", () => {
    expect(() => jsmql("$.a &&")).toThrow(/Unexpected end of expression/);
  });
  it("incomplete ternary gives Unexpected end of expression", () => {
    expect(() => jsmql("$.a ? $.b")).toThrow(/Expected ':'/);
  });
});

describe("template literals", () => {
  it("plain string template (no expressions)", () => {
    expect(jsmql("`hello`")).toEqual("hello");
  });
  it("single interpolation", () => {
    // FieldRef has unknown runtime type → wrapped in $toString to match JS coercion semantics.
    expect(jsmql("`hello, ${$.name}!`")).toEqual({
      $concat: ["hello, ", { $toString: "$name" }, "!"],
    });
  });
  it("multiple interpolations", () => {
    expect(jsmql("`${$.first} ${$.last}`")).toEqual({
      $concat: [{ $toString: "$first" }, " ", { $toString: "$last" }],
    });
  });
  it("interpolation at the start", () => {
    expect(jsmql("`${$.x} px`")).toEqual({ $concat: [{ $toString: "$x" }, " px"] });
  });
  it("interpolation at the end", () => {
    expect(jsmql("`prefix-${$.id}`")).toEqual({ $concat: ["prefix-", { $toString: "$id" }] });
  });
  it("expression inside interpolation", () => {
    expect(jsmql("`total: ${$.a + $.b}`")).toEqual({
      $concat: ["total: ", { $toString: { $add: ["$a", "$b"] } }],
    });
  });
  it("interpolation containing object literal (brace tracking)", () => {
    expect(jsmql("`v=${$let({ x: 1 }, x => x)}`")).toEqual({
      $concat: ["v=", { $toString: { $let: { vars: { x: 1 }, in: "$$x" } } }],
    });
  });
  it("nested template literal", () => {
    // Inner template literal is statically string-producing → no $toString wrap.
    expect(jsmql("`outer ${`inner ${$.x}`}`")).toEqual({
      $concat: ["outer ", { $concat: ["inner ", { $toString: "$x" }] }],
    });
  });
  it("escape sequences", () => {
    expect(jsmql("`a\\nb`")).toEqual("a\nb");
  });
  it("escaped backtick and dollar", () => {
    expect(jsmql("`a\\`b\\${c}`")).toEqual("a`b${c}");
  });
  it("template literal participates in string-context +", () => {
    expect(jsmql("`x=${$.x}` + ' done'")).toEqual({
      $concat: [{ $concat: ["x=", { $toString: "$x" }] }, " done"],
    });
  });
  it("string-producing interpolations skip the $toString wrap", () => {
    // .toLowerCase() is statically string-producing — the wrap would be redundant.
    expect(jsmql("`name=${$.name.toLowerCase()}`")).toEqual({
      $concat: ["name=", { $toLower: "$name" }],
    });
  });
  it("number literal interpolation gets $toString wrap", () => {
    expect(jsmql("`n=${42}`")).toEqual({
      $concat: ["n=", { $toString: 42 }],
    });
  });
});

describe("array .includes()", () => {
  it("array literal → $in", () => {
    expect(jsmql('["a", "b"].includes($.x)')).toEqual({ $in: ["$x", ["a", "b"]] });
  });
  it("known array (split result) → $in", () => {
    expect(jsmql('$.csv.split(",").includes("active")')).toEqual({
      $in: ["active", { $split: ["$csv", ","] }],
    });
  });
  it("known string (toLowerCase result) → string form", () => {
    expect(jsmql('$.email.toLowerCase().includes("@")')).toEqual({
      $gte: [{ $indexOfCP: [{ $toLower: "$email" }, "@"] }, 0],
    });
  });
  it("bare $.field → runtime $cond on $isArray (works for either type)", () => {
    expect(jsmql("$.field.includes($.x)")).toEqual({
      $cond: [
        { $isArray: "$field" },
        { $in: ["$x", "$field"] },
        { $gte: [{ $indexOfCP: ["$field", "$x"] }, 0] },
      ],
    });
  });
});

describe("Math.min / Math.max", () => {
  it("Math.min variadic", () => {
    expect(jsmql("Math.min($.a, $.b, $.c)")).toEqual({ $min: ["$a", "$b", "$c"] });
  });
  it("Math.max variadic", () => {
    expect(jsmql("Math.max($.a, $.b)")).toEqual({ $max: ["$a", "$b"] });
  });
  it("Math.max with single array arg", () => {
    expect(jsmql("Math.max($.scores)")).toEqual({ $max: "$scores" });
  });
  it("Math.max with spread arg", () => {
    expect(jsmql("Math.max(...$.scores)")).toEqual({ $max: "$scores" });
  });
  it("Math.min mixed spread + scalar", () => {
    expect(jsmql("Math.min($.a, ...$.others)")).toEqual({
      $min: { $concatArrays: [["$a"], "$others"] },
    });
  });
});

describe("Date.now()", () => {
  it("returns ms since epoch", () => {
    expect(jsmql("Date.now()")).toEqual({ $toLong: "$$NOW" });
  });
});

describe("Object.fromEntries", () => {
  it("from $objectToArray result", () => {
    expect(jsmql("Object.fromEntries(Object.entries($.doc))")).toEqual({
      $arrayToObject: { $objectToArray: "$doc" },
    });
  });
  it("from array literal of pairs", () => {
    expect(jsmql('Object.fromEntries([["a", 1], ["b", 2]])')).toEqual({
      $arrayToObject: [
        ["a", 1],
        ["b", 2],
      ],
    });
  });
});

describe("Array.isArray", () => {
  it("on a field", () => {
    expect(jsmql("Array.isArray($.items)")).toEqual({ $isArray: "$items" });
  });
});

describe("optional chaining (?.)", () => {
  it("simple optional member access", () => {
    expect(jsmql("$.a?.b")).toEqual("$a.b");
  });
  it("chained optional access", () => {
    expect(jsmql("$.a?.b?.c")).toEqual("$a.b.c");
  });
  it("optional method call", () => {
    expect(jsmql("$.name?.trim()")).toEqual({ $trim: { input: "$name" } });
  });
  it("optional method call on a chain", () => {
    expect(jsmql("$.user?.name?.trim()")).toEqual({ $trim: { input: "$user.name" } });
  });
  it("optional bracket access on bare field → runtime $cond", () => {
    // ?.[ ] desugars to the same node as [ ]; receiver type unknown → dispatch at runtime.
    expect(jsmql("$.scoresByLevel?.[$.level]")).toEqual({
      $cond: [
        { $isArray: "$scoresByLevel" },
        { $arrayElemAt: ["$scoresByLevel", "$level"] },
        { $getField: { field: "$level", input: "$scoresByLevel" } },
      ],
    });
  });
  it("optional bracket access on known array stays compact", () => {
    expect(jsmql("$.items.reverse()?.[0]")).toEqual({
      $arrayElemAt: [{ $reverseArray: "$items" }, 0],
    });
  });
});

describe(".startsWith / .endsWith", () => {
  it("startsWith maps to indexOf == 0", () => {
    expect(jsmql('$.email.startsWith("admin")')).toEqual({
      $eq: [{ $indexOfCP: ["$email", "admin"] }, 0],
    });
  });
  it("endsWith maps to substring equality at the tail", () => {
    expect(jsmql('$.file.endsWith(".pdf")')).toEqual({
      $eq: [
        {
          $substrCP: [
            "$file",
            { $subtract: [{ $strLenCP: "$file" }, { $strLenCP: ".pdf" }] },
            { $strLenCP: ".pdf" },
          ],
        },
        ".pdf",
      ],
    });
  });
});

describe(".charAt", () => {
  it("charAt(i)", () => {
    expect(jsmql("$.name.charAt(2)")).toEqual({ $substrCP: ["$name", 2, 1] });
  });
});

describe("array .indexOf", () => {
  it("on array literal → $indexOfArray", () => {
    expect(jsmql('["a", "b", "c"].indexOf($.x)')).toEqual({
      $indexOfArray: [["a", "b", "c"], "$x"],
    });
  });
  it("on known string → $indexOfCP", () => {
    expect(jsmql('$.email.toLowerCase().indexOf("@")')).toEqual({
      $indexOfCP: [{ $toLower: "$email" }, "@"],
    });
  });
  it("on bare field → runtime $cond on $isArray", () => {
    expect(jsmql('$.email.indexOf("@")')).toEqual({
      $cond: [
        { $isArray: "$email" },
        { $indexOfArray: ["$email", "@"] },
        { $indexOfCP: ["$email", "@"] },
      ],
    });
  });
});

describe("array .concat", () => {
  it("on array literal → $concatArrays", () => {
    expect(jsmql("[1, 2].concat([3, 4])")).toEqual({
      $concatArrays: [
        [1, 2],
        [3, 4],
      ],
    });
  });
  it("on known string → $concat", () => {
    expect(jsmql("$.first.trim().concat($.last)")).toEqual({
      $concat: [{ $trim: { input: "$first" } }, "$last"],
    });
  });
  it("on bare field → runtime $cond on $isArray", () => {
    expect(jsmql("$.parts.concat($.tail)")).toEqual({
      $cond: [
        { $isArray: "$parts" },
        { $concatArrays: ["$parts", "$tail"] },
        { $concat: ["$parts", "$tail"] },
      ],
    });
  });
});

describe(".join", () => {
  it("default separator (,)", () => {
    expect(jsmql("$.tags.join()")).toEqual({
      $reduce: {
        input: "$tags",
        initialValue: "",
        in: {
          $cond: [
            { $eq: ["$$value", ""] },
            { $toString: "$$this" },
            { $concat: ["$$value", ",", { $toString: "$$this" }] },
          ],
        },
      },
    });
  });
  it("custom separator", () => {
    expect(jsmql('$.tags.join(" | ")')).toEqual({
      $reduce: {
        input: "$tags",
        initialValue: "",
        in: {
          $cond: [
            { $eq: ["$$value", ""] },
            { $toString: "$$this" },
            { $concat: ["$$value", " | ", { $toString: "$$this" }] },
          ],
        },
      },
    });
  });
});

describe(".flat / .flatMap", () => {
  it("flat() one level", () => {
    expect(jsmql("$.nested.flat()")).toEqual({
      $reduce: {
        input: "$nested",
        initialValue: [],
        in: { $concatArrays: ["$$value", "$$this"] },
      },
    });
  });
  it("flat(1) explicit depth", () => {
    expect(jsmql("$.nested.flat(1)")).toEqual({
      $reduce: {
        input: "$nested",
        initialValue: [],
        in: { $concatArrays: ["$$value", "$$this"] },
      },
    });
  });
  it("flat(2) is rejected", () => {
    expect(() => jsmql("$.nested.flat(2)")).toThrow(/depth=1/);
  });
  it("flatMap with lambda", () => {
    expect(jsmql("$.docs.flatMap(d => d.tags)")).toEqual({
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
    expect(jsmql("$.ts.getTime()")).toEqual({ $toLong: "$ts" });
  });
  it("toISOString", () => {
    expect(jsmql("$.ts.toISOString()")).toEqual({
      $dateToString: { date: "$ts", format: "%Y-%m-%dT%H:%M:%S.%LZ" },
    });
  });
});

describe("Math.sign / log2 / log10 / hypot / cbrt / random / constants", () => {
  it("Math.sign maps to $cmp(x, 0)", () => {
    expect(jsmql("Math.sign($.x)")).toEqual({ $cmp: ["$x", 0] });
  });
  it("Math.log2", () => {
    expect(jsmql("Math.log2($.x)")).toEqual({ $log: ["$x", 2] });
  });
  it("Math.log10", () => {
    expect(jsmql("Math.log10($.x)")).toEqual({ $log10: "$x" });
  });
  it("Math.cbrt", () => {
    expect(jsmql("Math.cbrt($.x)")).toEqual({ $pow: ["$x", { $divide: [1, 3] }] });
  });
  it("Math.hypot 2-arg", () => {
    expect(jsmql("Math.hypot($.a, $.b)")).toEqual({
      $sqrt: { $add: [{ $pow: ["$a", 2] }, { $pow: ["$b", 2] }] },
    });
  });
  it("Math.random", () => {
    expect(jsmql("Math.random()")).toEqual({ $rand: {} });
  });
  it("Math.PI", () => {
    expect(jsmql("Math.PI")).toEqual(Math.PI);
  });
  it("Math.E", () => {
    expect(jsmql("Math.E")).toEqual(Math.E);
  });
});

describe("numeric separators", () => {
  it("integer with separator", () => {
    expect(jsmql("$abs(1_000_000)")).toEqual({ $abs: 1000000 });
  });
  it("float with separator", () => {
    expect(jsmql("$abs(1_234.567_89)")).toEqual({ $abs: 1234.56789 });
  });
  it("exponent with separator", () => {
    expect(jsmql("$abs(1_2e3)")).toEqual({ $abs: 12000 });
  });
  it("trailing _ rejected", () => {
    expect(() => jsmql("1_")).toThrow(/Numeric separator/);
  });
  it("double __ rejected", () => {
    expect(() => jsmql("1__0")).toThrow(/Numeric separator/);
  });
});

describe("comments", () => {
  it("// line comment between expressions", () => {
    expect(jsmql("$.a // tail\n+ $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// line comment at EOF (no terminator)", () => {
    expect(jsmql("$abs($.x) // trailing comment")).toEqual({ $abs: "$x" });
  });
  it("// terminated by CR", () => {
    expect(jsmql("$.a // x\r+ $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// terminated by CRLF", () => {
    expect(jsmql("$.a // x\r\n+ $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// terminated by U+2028 (LSEP)", () => {
    expect(jsmql("$.a // x + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// terminated by U+2029 (PSEP)", () => {
    expect(jsmql("$.a // x + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("/* block */ inline", () => {
    expect(jsmql("$.a /* mid */ + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("/* multi-line block */", () => {
    expect(jsmql("$.a /*\n  spans\n  lines\n*/ + $.b")).toEqual({
      $add: ["$a", "$b"],
    });
  });
  it("empty /**/ block", () => {
    expect(jsmql("$.a /**/ + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("multiple comments collapse to one boundary", () => {
    expect(jsmql("$.a // one\n  /* two */ \n // three\n + $.b")).toEqual({
      $add: ["$a", "$b"],
    });
  });
  it("comment inside template ${...} interpolation", () => {
    expect(jsmql("`hi ${ $.name /* user */ }`")).toEqual({
      $concat: ["hi ", { $toString: "$name" }],
    });
  });
  it("// inside string literal is preserved as data", () => {
    expect(jsmql('$eq($.url, "https://example.com")')).toEqual({
      $eq: ["$url", "https://example.com"],
    });
  });
  it("// inside regex literal is preserved as pattern", () => {
    // Two literal slashes inside a regex character class — must not be eaten as a comment
    expect(jsmql("$.path.match(/[/\\\\]/)")).toEqual({
      $regexMatch: { input: "$path", regex: "[/\\\\]" },
    });
  });
  it("regex disambiguation works after a comment (non-value-ending)", () => {
    // After `(` (not a value-ending token) a `/` would normally start a regex.
    // A leading comment must not change that.
    expect(jsmql("$.path.match(/* skip */ /foo/i)")).toEqual({
      $regexMatch: { input: "$path", regex: "foo", options: "i" },
    });
  });
  it("divide disambiguation works after a comment (value-ending)", () => {
    // After a Number token, `/` is divide; a leading comment must not change that.
    expect(jsmql("10 /* skip */ / 2")).toEqual({ $divide: [10, 2] });
  });
  it("unclosed /* throws LexError", () => {
    expect(() => jsmql("$.a /* unclosed")).toThrow(/Unclosed block comment/);
  });
});

describe("computed object keys", () => {
  it("single computed key", () => {
    expect(jsmql("$abs({ [$.k]: 1 })")).toEqual({
      $abs: { $arrayToObject: [["$k", 1]] },
    });
  });
  it("mixed static and computed keys", () => {
    expect(jsmql("$abs({ a: 1, [$.k]: 2 })")).toEqual({
      $abs: {
        $arrayToObject: [
          ["a", 1],
          ["$k", 2],
        ],
      },
    });
  });
});

describe("spread in operator args", () => {
  it("$concatArrays with spread", () => {
    expect(jsmql("$concatArrays(...$.arrs)")).toEqual({ $concatArrays: "$arrs" });
  });
  it("Object.assign with spread", () => {
    expect(jsmql("Object.assign(...$.docs)")).toEqual({ $mergeObjects: "$docs" });
  });
});

describe("shorthand object properties", () => {
  it("inside lambda body", () => {
    expect(jsmql("$.items.map(x => ({ x }))")).toEqual({
      $map: { input: "$items", as: "x", in: { x: "$$x" } },
    });
  });
  it("two shorthand props", () => {
    expect(jsmql("$.items.map(x => ({ x, x }))")).toEqual({
      $map: { input: "$items", as: "x", in: { x: "$$x" } },
    });
  });
  it("shorthand outside lambda scope errors", () => {
    expect(() => jsmql("({ foo })")).toThrow(/Unknown identifier/);
  });
});

describe("flex-shape operators", () => {
  // ── $round / $trunc ─────────────────────────────────────────────────────────
  it("$round single arg → bare value", () => {
    expect(jsmql("$round($.price)")).toEqual({ $round: "$price" });
  });
  it("$round two args → array", () => {
    expect(jsmql("$round($.price, 2)")).toEqual({ $round: ["$price", 2] });
  });
  it("$trunc single arg → bare value", () => {
    expect(jsmql("$trunc($.value)")).toEqual({ $trunc: "$value" });
  });
  it("$trunc two args → array", () => {
    expect(jsmql("$trunc($.value, 1)")).toEqual({ $trunc: ["$value", 1] });
  });

  // ── Accumulators ($min / $max / $avg / $sum / $stdDev*) ─────────────────────
  it("$min single arg → bare value (accumulator-style)", () => {
    expect(jsmql("$min($.scores)")).toEqual({ $min: "$scores" });
  });
  it("$min multiple args → array (expression-style)", () => {
    expect(jsmql("$min($.a, $.b, $.c)")).toEqual({ $min: ["$a", "$b", "$c"] });
  });
  it("$max single arg", () => {
    expect(jsmql("$max($.scores)")).toEqual({ $max: "$scores" });
  });
  it("$max multiple args", () => {
    expect(jsmql("$max($.a, $.b)")).toEqual({ $max: ["$a", "$b"] });
  });
  it("$avg single arg", () => {
    expect(jsmql("$avg($.values)")).toEqual({ $avg: "$values" });
  });
  it("$avg multiple args", () => {
    expect(jsmql("$avg($.a, $.b, $.c)")).toEqual({ $avg: ["$a", "$b", "$c"] });
  });
  it("$sum single arg", () => {
    expect(jsmql("$sum($.amounts)")).toEqual({ $sum: "$amounts" });
  });
  it("$sum multiple args", () => {
    expect(jsmql("$sum($.a, $.b)")).toEqual({ $sum: ["$a", "$b"] });
  });
  it("$stdDevPop single arg", () => {
    expect(jsmql("$stdDevPop($.measurements)")).toEqual({ $stdDevPop: "$measurements" });
  });
  it("$stdDevSamp multiple args", () => {
    expect(jsmql("$stdDevSamp($.a, $.b, $.c)")).toEqual({
      $stdDevSamp: ["$a", "$b", "$c"],
    });
  });

  // ── $mergeObjects ───────────────────────────────────────────────────────────
  it("$mergeObjects single arg → bare value", () => {
    expect(jsmql("$mergeObjects($.docs)")).toEqual({ $mergeObjects: "$docs" });
  });
  it("$mergeObjects multiple args → array", () => {
    expect(jsmql("$mergeObjects($.a, $.b)")).toEqual({ $mergeObjects: ["$a", "$b"] });
  });

  // ── Spread handling ─────────────────────────────────────────────────────────
  it("flex op with single spread → bare array", () => {
    expect(jsmql("$min(...$.scores)")).toEqual({ $min: "$scores" });
  });
  it("flex op with mixed spread + scalar → $concatArrays", () => {
    expect(jsmql("$max($.first, ...$.rest)")).toEqual({
      $max: { $concatArrays: [["$first"], "$rest"] },
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────
  it("flex op with zero args throws", () => {
    expect(() => jsmql("$min()")).toThrow(/at least 1 argument/);
  });
  it("flex op with object literal arg → object as value (not object-shape)", () => {
    // Single arg that happens to be an object literal — parser flags this as object-style,
    // but $mergeObjects has flex shape (not object), so the literal is passed as a value.
    expect(jsmql("$mergeObjects({ a: 1, b: $.x })")).toEqual({
      $mergeObjects: { a: 1, b: "$x" },
    });
  });
  it("$round with arithmetic still works (regression: existing 2-arg form)", () => {
    expect(jsmql("$round($.price * 1.1, 2)")).toEqual({
      $round: [{ $multiply: ["$price", 1.1] }, 2],
    });
  });
});

describe("function overload", () => {
  it("accepts a no-param arrow", () => {
    expect(jsmql(() => $.age > 18)).toEqual({ $gt: ["$age", 18] });
  });

  it("accepts a $-param arrow (recommended idiom)", () => {
    expect(jsmql(($) => $.age > 18)).toEqual({ $gt: ["$age", 18] });
  });

  it("produces identical MQL to the equivalent string", () => {
    expect(jsmql(($) => $.status == "active")).toEqual(jsmql('$.status == "active"'));
  });

  it("the wrapper parameter is not bound inside the body — references resolve via $", () => {
    // `(doc) =>` is a typing/IDE hook only. Inside the body, `doc.foo` is treated as
    // an unknown identifier (and the user gets pointed at `$.doc` and the jsmql tag).
    expect(() => jsmql((doc) => doc.foo)).toThrow(/Unknown identifier 'doc'/);
  });

  it("handles nested arrows in the body", () => {
    expect(jsmql(($) => $.items.map((x) => x * 2))).toEqual({
      $map: { input: "$items", as: "x", in: { $multiply: ["$$x", 2] } },
    });
  });

  it("handles a parenthesised object-literal body", () => {
    expect(jsmql(($) => ({ doubled: $.x * 2 }))).toEqual({ doubled: { $multiply: ["$x", 2] } });
  });

  it("rejects `return` inside a block-body arrow with a clear error", () => {
    expect(() =>
      jsmql(($) => {
        return $.age > 18;
      }),
    ).toThrow(/return/);
  });

  it("rejects a `function` declaration", () => {
    expect(() =>
      jsmql(function () {
        return $.age > 18;
      }),
    ).toThrow(/arrow function/);
  });

  it("rejects an async arrow", () => {
    expect(() => jsmql(async () => $.age > 18)).toThrow(/async/);
  });

  it("appends a jsmql`` hint when an outer-scope identifier is referenced", () => {
    const minAge = 21; // referenced from the closure on purpose
    expect(() => jsmql(($) => $.age > minAge)).toThrow(/jsmql`` template tag/);
  });

  it("jsmql.validate() reports the augmented hint for closure refs", () => {
    const minAge = 21;
    const r = jsmql.validate(($) => $.age > minAge);
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.code).toBe("CODEGEN_ERROR");
    expect(r.errors[0]?.message).toMatch(/Unknown identifier 'minAge'/);
    expect(r.errors[0]?.message).toMatch(/jsmql`` template tag/);
  });

  it("jsmql.validate() reports SYNTAX_ERROR for an unsupported function shape", () => {
    const r = jsmql.validate(($) => {
      return $.age > 18;
    });
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.code).toBe("SYNTAX_ERROR");
  });

  it("inline arrow in a hot loop produces consistent MQL across calls (cache correctness)", () => {
    const make = () => jsmql(($) => $.status == "active");
    const a = make();
    const b = make();
    expect(a).toEqual(b);
  });

  it("destructured operator in the second parameter compiles to the same MQL as the string form", () => {
    // The second arg is types-only — it gives users a destructure site that
    // silences IDE warnings on `$dateDiff`. The runtime strips the param list,
    // so this produces identical MQL to the string equivalent.
    const fromFn = jsmql(($, { $dateDiff }) =>
      $dateDiff({ startDate: $.a, endDate: $.b, unit: "day" }),
    );
    const fromStr = jsmql('$dateDiff({ startDate: $.a, endDate: $.b, unit: "day" })');
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
    expect(jsmql(src)).toEqual(expected);
  });
});

describe("misc / hash / timestamp / sigmoid / type / literal operators", () => {
  it.each([
    ["$sigmoid", "$sigmoid($.x)", { $sigmoid: "$x" }],
    ["$createObjectId", "$createObjectId()", { $createObjectId: {} }],
    ["$toHashedIndexKey", "$toHashedIndexKey($.k)", { $toHashedIndexKey: "$k" }],
    ["$tsIncrement", "$tsIncrement($.t)", { $tsIncrement: "$t" }],
    ["$tsSecond", "$tsSecond($.t)", { $tsSecond: "$t" }],
    [
      "$toUUID",
      '$toUUID("550e8400-e29b-41d4-a716-446655440000")',
      {
        $toUUID: "550e8400-e29b-41d4-a716-446655440000",
      },
    ],
    ["$toObject", "$toObject($.json)", { $toObject: "$json" }],
    ["$toArray", "$toArray($.field)", { $toArray: "$field" }],
    ["$literal field-ref pass-through", '$literal("$foo")', { $literal: "$foo" }],
    ["$meta keyword string", '$meta("textScore")', { $meta: "textScore" }],
  ])("%s emits the expected MQL", (_name, src, expected) => {
    expect(jsmql(src)).toEqual(expected);
  });
});

describe("$hash and $hexHash (object shape)", () => {
  it("$hash positional", () => {
    expect(jsmql('$hash($.password, "sha256")')).toEqual({
      $hash: { input: "$password", algorithm: "sha256" },
    });
  });
  it("$hexHash object-style", () => {
    expect(jsmql('$hexHash({ input: $.token, algorithm: "sha512" })')).toEqual({
      $hexHash: { input: "$token", algorithm: "sha512" },
    });
  });
});

describe("$accumulator and $function (custom aggregation)", () => {
  it("$function object-style", () => {
    expect(
      jsmql('$function({ body: "function(x) { return x * 2; }", args: [$.value], lang: "js" })'),
    ).toEqual({
      $function: {
        body: "function(x) { return x * 2; }",
        args: ["$value"],
        lang: "js",
      },
    });
  });
  it("$accumulator object-style with subset of keys", () => {
    expect(
      jsmql(
        '$accumulator({ init: "function() { return 0; }", accumulate: "function(s, v) { return s + v; }", merge: "function(a, b) { return a + b; }", lang: "js" })',
      ),
    ).toEqual({
      $accumulator: {
        init: "function() { return 0; }",
        accumulate: "function(s, v) { return s + v; }",
        merge: "function(a, b) { return a + b; }",
        lang: "js",
      },
    });
  });
});

describe("$median and $percentile (statistical accumulators)", () => {
  it("$median positional", () => {
    expect(jsmql('$median($.scores, "approximate")')).toEqual({
      $median: { input: "$scores", method: "approximate" },
    });
  });
  it("$percentile positional", () => {
    expect(jsmql('$percentile($.scores, [0.5, 0.95], "approximate")')).toEqual({
      $percentile: {
        input: "$scores",
        p: [0.5, 0.95],
        method: "approximate",
      },
    });
  });
});

describe("encrypted-string operators ($encStr*)", () => {
  it("$encStrContains", () => {
    expect(jsmql('$encStrContains($.encField, "secret")')).toEqual({
      $encStrContains: { input: "$encField", substring: "secret" },
    });
  });
  it("$encStrStartsWith object-style", () => {
    expect(jsmql('$encStrStartsWith({ input: $.encField, prefix: "abc" })')).toEqual({
      $encStrStartsWith: { input: "$encField", prefix: "abc" },
    });
  });
  it("$encStrEndsWith", () => {
    expect(jsmql('$encStrEndsWith($.encField, "xyz")')).toEqual({
      $encStrEndsWith: { input: "$encField", suffix: "xyz" },
    });
  });
  it("$encStrNormalizedEq", () => {
    expect(jsmql('$encStrNormalizedEq($.encField, "compare")')).toEqual({
      $encStrNormalizedEq: { input: "$encField", string: "compare" },
    });
  });
});

describe("window operators ($setWindowFields-only)", () => {
  it.each([
    ["$rank", "$rank()", { $rank: {} }],
    ["$denseRank", "$denseRank()", { $denseRank: {} }],
    ["$documentNumber", "$documentNumber()", { $documentNumber: {} }],
    ["$linearFill", "$linearFill($.value)", { $linearFill: "$value" }],
    ["$locf", "$locf($.value)", { $locf: "$value" }],
    ["$covariancePop", "$covariancePop($.x, $.y)", { $covariancePop: ["$x", "$y"] }],
    ["$covarianceSamp", "$covarianceSamp($.x, $.y)", { $covarianceSamp: ["$x", "$y"] }],
  ])("%s emits the expected MQL", (_name, src, expected) => {
    expect(jsmql(src)).toEqual(expected);
  });

  it("$shift positional", () => {
    expect(jsmql("$shift($.price, -1, 0)")).toEqual({
      $shift: { output: "$price", by: -1, default: 0 },
    });
  });

  it("$shift object-style", () => {
    expect(jsmql("$shift({ output: $.price, by: -1, default: 0 })")).toEqual({
      $shift: { output: "$price", by: -1, default: 0 },
    });
  });

  it("$expMovingAvg with N (positional)", () => {
    expect(jsmql("$expMovingAvg($.price, 5)")).toEqual({
      $expMovingAvg: { input: "$price", N: 5 },
    });
  });

  it("$expMovingAvg with alpha (object-style)", () => {
    expect(jsmql("$expMovingAvg({ input: $.price, alpha: 0.3 })")).toEqual({
      $expMovingAvg: { input: "$price", alpha: 0.3 },
    });
  });

  it("$derivative positional", () => {
    expect(jsmql('$derivative($.value, "hour")')).toEqual({
      $derivative: { input: "$value", unit: "hour" },
    });
  });

  it("$integral positional", () => {
    expect(jsmql('$integral($.value, "hour")')).toEqual({
      $integral: { input: "$value", unit: "hour" },
    });
  });
});

describe("jsmql.compile()", () => {
  describe("basic binding", () => {
    it("scalar binding inlines as a literal", () => {
      const q = jsmql.compile(({ minAge }: { minAge: number }, $) => $.age > minAge);
      expect(q({ minAge: 21 })).toEqual({ $gt: ["$age", 21] });
    });

    it("string binding inlines as a literal string", () => {
      const q = jsmql.compile(({ region }: { region: string }, $) => $.region == region);
      expect(q({ region: "AU" })).toEqual({ $eq: ["$region", "AU"] });
    });

    it("array binding inlines into $in", () => {
      const q = jsmql.compile(({ allowed }: { allowed: string[] }, $) => $.grade in allowed);
      expect(q({ allowed: ["A", "B"] })).toEqual({
        $in: ["$grade", ["A", "B"]],
      });
    });

    it("plain-object binding inlines as a nested object literal value", () => {
      // Whole-object bindings appear as MQL literal objects. Field access on
      // them (e.g. `thresholds.min`) goes through MQL's `$getField`, not a
      // compile-time fold — the user can always destructure further at the
      // call site if they want fields hoisted as separate bindings.
      const q = jsmql.compile(({ defaults }: { defaults: { name: string } }) => defaults);
      expect(q({ defaults: { name: "default" } })).toEqual({ name: "default" });
    });

    it("the same compiled query is reusable with different params", () => {
      const q = jsmql.compile(({ n }: { n: number }, $) => $.age > n);
      expect(q({ n: 18 })).toEqual({ $gt: ["$age", 18] });
      expect(q({ n: 65 })).toEqual({ $gt: ["$age", 65] });
    });

    it("aliased destructure key binds the alias name", () => {
      const q = jsmql.compile(({ minAge: floor }: { minAge: number }, $) => $.age >= floor);
      expect(q({ minAge: 18 })).toEqual({ $gte: ["$age", 18] });
    });
  });

  describe("signature slot disambiguation", () => {
    it("params-only slot (no $)", () => {
      const q = jsmql.compile(({ flag }: { flag: boolean }) => flag);
      expect(q({ flag: true })).toEqual(true);
    });

    it("(params, $) two-slot form", () => {
      const q = jsmql.compile(({ n }: { n: number }, $) => $.age > n);
      expect(q({ n: 18 })).toEqual({ $gt: ["$age", 18] });
    });

    it("(params, $, ops) three-slot form — ops hint is types-only", () => {
      const q = jsmql.compile(
        (
          { minScore }: { minScore: number },
          $,
          { $match }: { $match: (...args: unknown[]) => unknown },
        ) => [$match($.score >= minScore)],
      );
      expect(q({ minScore: 75 })).toEqual([{ $match: { score: { $gte: 75 } } }]);
    });

    it("existing one-arg `($) => …` form still works unchanged via jsmql()", () => {
      expect(jsmql(($) => $.age > 18)).toEqual({ $gt: ["$age", 18] });
    });

    it("existing two-arg `($, { $dateDiff }) => …` form still works unchanged via jsmql()", () => {
      expect(jsmql(($) => $.x == "ok")).toEqual({ $eq: ["$x", "ok"] });
    });
  });

  describe("scope and shadowing", () => {
    it("lambda parameter shadows a binding of the same name", () => {
      const q = jsmql.compile(({ x }: { x: number }, $) => $.items.map((x) => x * 2));
      expect(q({ x: 999 })).toEqual({
        $map: { input: "$items", as: "x", in: { $multiply: ["$$x", 2] } },
      });
    });

    it("binding visible inside a $match expression body alongside other refs", () => {
      const q = jsmql.compile(
        ({ minAge }: { minAge: number }, $) => $.age >= minAge && $.country == "US",
      );
      expect(q({ minAge: 21 })).toEqual({
        $and: [{ $gte: ["$age", 21] }, { $eq: ["$country", "US"] }],
      });
    });
  });

  describe("$match index-friendly translation (a75eb35)", () => {
    it("scalar binding against a field becomes a query-language $match", () => {
      const q = jsmql.compile(
        (
          { minAge }: { minAge: number },
          $,
          { $match }: { $match: (...a: unknown[]) => unknown },
        ) => [$match($.age >= minAge)],
      );
      expect(q({ minAge: 21 })).toEqual([{ $match: { age: { $gte: 21 } } }]);
    });

    it("string binding equals a field becomes a query-language $match", () => {
      const q = jsmql.compile(
        (
          { region }: { region: string },
          $,
          { $match }: { $match: (...a: unknown[]) => unknown },
        ) => [$match($.region == region)],
      );
      expect(q({ region: "AU" })).toEqual([{ $match: { region: "AU" } }]);
    });
  });

  describe("pipeline integration", () => {
    it("bindings work in pipeline arrays end-to-end", () => {
      const q = jsmql.compile(
        (
          { min, limit }: { min: number; limit: number },
          $,
          {
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
          $,
          {
            $lookup,
            $match,
          }: {
            $lookup: (...a: unknown[]) => unknown;
            $match: (...a: unknown[]) => unknown;
          },
        ) => [
          $lookup({
            from: "addresses",
            localField: "_id",
            foreignField: "userId",
            as: "addrs",
            pipeline: [$match($.country == region)],
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
      const q = jsmql.compile(({ foo }: { foo: number }, $) => $.x > foo);
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
      const q = jsmql.compile(({ minAge: floor }: { minAge: number }, $) => $.age >= floor);
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
      expect(() =>
        jsmql.compile(({ minAge = 18 }: { minAge?: number }, $) => $.age > minAge),
      ).toThrow(/does not support default values/);
    });

    it("expression default rejected with the explanatory message", () => {
      expect(() =>
        jsmql.compile(({ now = Date.now() }: { now?: number }, $) => $.createdAt > now),
      ).toThrow(/does not support default values/);
    });

    it("rejection message points at the call-site `??` fallback", () => {
      try {
        jsmql.compile(({ x = 1 }: { x?: number }, $) => $.y > x);
      } catch (err) {
        expect((err as Error).message).toMatch(/JS's `\?\?` at the call site/);
      }
    });

    it("rejection message points at the template-tag form", () => {
      try {
        jsmql.compile(({ x = 1 }: { x?: number }, $) => $.y > x);
      } catch (err) {
        expect((err as Error).message).toMatch(/template-tag form/);
      }
    });
  });

  describe("error: malformed destructure patterns", () => {
    it("nested destructure is rejected", () => {
      // Equivalent source: ({ a: { b } }, $) => $.x > b
      const src = "({ a: { b } }, $) => $.x > b";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(
        /does not support nested destructure/,
      );
    });

    it("rest pattern is rejected", () => {
      const src = "({ ...rest }, $) => $.x > rest.a";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(
        /does not support rest patterns/,
      );
    });

    it("array destructure is rejected", () => {
      const src = "([a, b], $) => $.x > a";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(
        /must be an object destructure pattern/,
      );
    });
  });

  describe("error: slot ordering and counts", () => {
    it("more than three parameters is rejected", () => {
      const src = "({ a }, $, { $match }, extra) => $.x > a";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(
        /at most three parameters/,
      );
    });

    it("(doc, params) — params after doc — is rejected", () => {
      const src = "($, { a }) => $.x > a";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(
        /Reorder to `\(params, \$, opsHint\)`/,
      );
    });

    it("mixed `$`/non-`$` keys in one destructure is rejected", () => {
      const src = "({ $match, minAge }, $) => $.age > minAge";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(
        /separate from the params destructure/,
      );
    });
  });

  describe("error: unsafe param values at call time", () => {
    it("NaN is rejected at bind time", () => {
      const q = jsmql.compile(({ n }: { n: number }, $) => $.x > n);
      expect(() => q({ n: NaN })).toThrow(/NaN/);
    });

    it("Infinity is rejected at bind time", () => {
      const q = jsmql.compile(({ n }: { n: number }, $) => $.x > n);
      expect(() => q({ n: Infinity })).toThrow(/Infinity/);
    });

    it("function value is rejected at bind time", () => {
      const q = jsmql.compile(({ x }: { x: unknown }, $) => $.y == x);
      expect(() => q({ x: () => 1 })).toThrow(/has no JSON representation/);
    });

    it("BigInt value is rejected at bind time", () => {
      const q = jsmql.compile(({ x }: { x: unknown }, $) => $.y == x);
      expect(() => q({ x: BigInt(1) })).toThrow(/could not be serialised/);
    });
  });

  describe("extra params keys are allowed silently", () => {
    it("extra keys not referenced in the body are ignored", () => {
      const q = jsmql.compile(({ a }: { a: number }, $) => $.x > a);
      expect(q({ a: 1, unused: 99 } as unknown as { a: number })).toEqual({ $gt: ["$x", 1] });
    });
  });
});
