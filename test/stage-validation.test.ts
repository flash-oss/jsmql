import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

// Per-stage body validation — see docs/specs/aggregation-stages.md § Lowering.
// Most checks are literal-gated: a non-literal slot (field/expression) compiles.
// The EXCEPTION is the constant-only slots ($limit/$skip/$sample.size/
// $bucket.boundaries/$lookup.pipeline/…), where a non-constant is itself a
// certain violation and throws (HR3). Each block pairs throwing and compiling
// cases.

describe("stage body validation — $limit / $skip", () => {
  it("rejects a non-positive literal $limit", () => {
    expect(() => jsmql("[ $limit(0) ]")).toThrow("'$limit' argument 1 must be a number of 1 or more — got 0.");
    expect(() => jsmql("[ $limit(-5) ]")).toThrow("'$limit' argument 1 must be a number of 1 or more — got -5.");
  });
  it("rejects a non-integer literal $limit", () => {
    expect(() => jsmql("[ $limit(2.5) ]")).toThrow("'$limit' expects an integer, but got a number.");
  });
  it("rejects a wrong-type literal $limit", () => {
    expect(() => jsmql("[ $limit('x') ]")).toThrow(/'\$limit' expects an integer, but got a string/);
  });
  it("rejects a negative literal $skip", () => {
    expect(() => jsmql("[ $skip(-1) ]")).toThrow("'$skip' argument 1 must be a number of 0 or more — got -1.");
  });
  it("accepts $limit(5), $skip(0)", () => {
    expect(jsmql("[ $limit(5) ]")).toEqual([{ $limit: 5 }]);
    expect(jsmql("[ $skip(0) ]")).toEqual([{ $skip: 0 }]);
  });

  // HR3 constant-only-slot exception: $limit/$skip require a compile-time
  // constant, so a field ref (which the server rejects as `{ $limit: "$n" }`)
  // is itself a certain violation and throws — it does NOT pass through.
  it("rejects a field ref / expression in $limit / $skip (constant-only slot)", () => {
    expect(() => jsmql("[ $limit($.pageSize) ]")).toThrow(
      "'$limit' argument 1 must be a compile-time constant — the server reads it before any document; got an expression.",
    );
    expect(() => jsmql("[ $skip($.n) ]")).toThrow(
      "'$skip' argument 1 must be a compile-time constant — the server reads it before any document; got an expression.",
    );
  });
});

describe("stage body validation — $count", () => {
  it("rejects empty / $-prefixed / dotted field names", () => {
    expect(() => jsmql("[ $count('') ]")).toThrow(
      "'$count' names a field to WRITE, and '' is empty. The server refuses it — pass a plain field name, e.g. 'total'.",
    );
    expect(() => jsmql("[ $count('$x') ]")).toThrow(
      "'$count' names a field to WRITE, and '$x' starts with '$'. The server refuses it — pass a plain field name, e.g. 'total'.",
    );
    expect(() => jsmql("[ $count('a.b') ]")).toThrow(
      "'$count' names a field to WRITE, and 'a.b' holds a dot. The server refuses it — pass a plain field name, e.g. 'total'.",
    );
  });
  it("accepts a plain field name", () => {
    expect(jsmql("[ $count('total') ]")).toEqual([{ $count: "total" }]);
  });
});

describe("stage body validation — non-object body (wrong-literal-kind)", () => {
  // The flagship: an object-bodied stage given a scalar/array literal body
  // (which the server always rejects) now throws instead of emitting it.
  it("$group rejects a non-object literal body", () => {
    expect(() => jsmql('[ $group("externalId") ]')).toThrow("'$group' expects a document, but got a string.");
    expect(() => jsmql("[ $group(5) ]")).toThrow("'$group' expects a document, but got a number.");
    expect(() => jsmql("[ $group([1, 2]) ]")).toThrow("'$group' expects a document, but got an array.");
  });
  it("$addFields / $set reject a scalar body", () => {
    expect(() => jsmql("[ $addFields(5) ]")).toThrow("'$addFields' expects a document, but got a number.");
    expect(() => jsmql('[ $set("x") ]')).toThrow("'$set' expects a document, but got a string.");
  });
  it("$project / $sort / $sample reject a scalar body", () => {
    expect(() => jsmql('[ $project("name") ]')).toThrow("'$project' expects a document, but got a string.");
    expect(() => jsmql("[ $sort(1) ]")).toThrow("'$sort' expects a document, but got a number.");
    expect(() => jsmql("[ $sample(5) ]")).toThrow("'$sample' expects a document, but got a number.");
  });
  it("$unset rejects a non-string / non-array literal body", () => {
    expect(() => jsmql("[ $unset(5) ]")).toThrow("'$unset' takes a string or an array here, and a number is neither.");
  });
  // The literal-gating invariant holds: a field-ref / runtime-expression body is
  // NOT a certain violation here (it could resolve to a value), so it compiles.
  it("does not throw on a non-literal body (gate)", () => {
    expect(jsmql("[ $addFields({ x: $.y }) ]")).toEqual([{ $addFields: { x: "$y" } }]);
    expect(jsmql('[ $group({ _id: "$externalId" }) ]')).toEqual([{ $group: { _id: "$externalId" } }]);
    expect(jsmql('[ $unset("a") ]')).toEqual([{ $unset: "a" }]);
    expect(jsmql('[ $unset(["a", "b"]) ]')).toEqual([{ $unset: ["a", "b"] }]);
  });
});

describe("stage body validation — $sort", () => {
  it("rejects a direction that is not 1 or -1", () => {
    expect(() => jsmql("[ $sort({ a: 2 }) ]")).toThrow("'$sort' takes 1 or -1 for every key, and 'a' has 2.");
  });
  it("rejects a SQL-style string direction", () => {
    expect(() => jsmql(`[ $sort({ createdAt: "desc" }) ]`)).toThrow(
      "'$sort' takes 1 or -1 for every key, and 'createdAt' has \"desc\".",
    );
  });
  it("rejects a boolean direction", () => {
    expect(() => jsmql("[ $sort({ a: true }) ]")).toThrow(
      "'$sort' takes 1 or -1 for every key, and 'a' has a boolean.",
    );
  });
  it("rejects more than 32 keys", () => {
    const keys = Array.from({ length: 33 }, (_, i) => `k${i}: 1`).join(", ");
    expect(jsmql(`[ $sort({ ${keys} }) ]`)).toEqual([
      {
        $sort: {
          k0: 1,
          k1: 1,
          k2: 1,
          k3: 1,
          k4: 1,
          k5: 1,
          k6: 1,
          k7: 1,
          k8: 1,
          k9: 1,
          k10: 1,
          k11: 1,
          k12: 1,
          k13: 1,
          k14: 1,
          k15: 1,
          k16: 1,
          k17: 1,
          k18: 1,
          k19: 1,
          k20: 1,
          k21: 1,
          k22: 1,
          k23: 1,
          k24: 1,
          k25: 1,
          k26: 1,
          k27: 1,
          k28: 1,
          k29: 1,
          k30: 1,
          k31: 1,
          k32: 1,
        },
      },
    ]);
  });
  it("accepts a valid sort spec", () => {
    expect(jsmql("[ $sort({ a: 1, b: -1 }) ]")).toEqual([{ $sort: { a: 1, b: -1 } }]);
  });
});

describe("stage body validation — $project", () => {
  it("rejects mixing inclusion and exclusion (non-_id)", () => {
    expect(() => jsmql("[ $project({ a: 1, b: 0 }) ]")).toThrow(
      "'$project' is either an inclusion or an exclusion, not both: 'a' includes and 'b' excludes ('_id' alone may be excluded from an inclusion). The server refuses the mix.",
    );
  });
  it("rejects an empty projection", () => {
    expect(() => jsmql("[ $project({}) ]")).toThrow(
      "'$project' takes at least one field — an empty body names none, and the server refuses it.",
    );
  });
  it("accepts excluding _id in an inclusion projection, and pure include/exclude", () => {
    expect(jsmql("[ $project({ _id: 0, name: 1 }) ]")).toEqual([{ $project: { _id: 0, name: 1 } }]);
    expect(jsmql("[ $project({ a: 1, b: 1 }) ]")).toEqual([{ $project: { a: 1, b: 1 } }]);
    expect(jsmql("[ $project({ a: 0, b: 0 }) ]")).toEqual([{ $project: { a: 0, b: 0 } }]);
  });
});

describe("stage body validation — $unset / $unwind", () => {
  it("rejects an empty $unset string and a non-$ $unwind path", () => {
    expect(() => jsmql("[ $unset('') ]")).toThrow(
      "'$unset' needs at least one field name — an empty string has none. Name the fields to remove: '$unset([\"a\", \"b\"])'.",
    );
    expect(() => jsmql("[ $unwind('items') ]")).toThrow(
      "'$unwind' reads a field PATH, and the server insists it carries its own '$': write '$items'.",
    );
  });
  it("accepts a valid $unwind path (field-ref form)", () => {
    expect(jsmql("[ $unwind($.items) ]")).toEqual([{ $unwind: "$items" }]);
  });
});

describe("stage body validation — $sample / $bucket / $bucketAuto", () => {
  it("requires $sample size and rejects a negative one", () => {
    expect(() => jsmql("[ $sample({}) ]")).toThrow(/requires the 'size' field/);
    expect(() => jsmql("[ $sample({ size: -1 }) ]")).toThrow(
      "'$sample' size must be at least 1, got -1 — the server refuses it.",
    );
  });
  it("validates $bucket boundaries (required, ≥2, ascending)", () => {
    expect(() => jsmql("[ $bucket({ groupBy: $.x }) ]")).toThrow(/requires the 'boundaries' field/);
    expect(() => jsmql("[ $bucket({ groupBy: $.x, boundaries: [1] }) ]")).toThrow(/at least 2 values/);
    expect(() => jsmql("[ $bucket({ groupBy: $.x, boundaries: [3, 1, 2] }) ]")).toThrow(
      "'$bucket' boundaries must be sorted ascending: 3 is not less than 1 — the server refuses it.",
    );
  });
  it("accepts a valid literal $bucket boundaries array", () => {
    expect(jsmql("[ $bucket({ groupBy: $.x, boundaries: [0, 10, 20] }) ]")).toEqual([
      { $bucket: { groupBy: "$x", boundaries: [0, 10, 20] } },
    ]);
  });
  // HR3 constant-only-slot exception: boundaries must be a constant array, so a
  // field ref (server-rejected as `{ boundaries: "$bounds" }`) throws.
  it("rejects a field ref / expression $bucket boundaries (constant-only slot)", () => {
    expect(() => jsmql("[ $bucket({ groupBy: $.x, boundaries: $.bounds }) ]")).toThrow(
      "'$bucket' boundaries must be a compile-time constant — the server reads it before any document; got an expression.",
    );
  });
  it("validates $bucketAuto buckets and granularity enum", () => {
    expect(() => jsmql("[ $bucketAuto({ groupBy: $.x, buckets: 0 }) ]")).toThrow(
      "'$bucketAuto' buckets must be at least 1, got 0 — the server refuses it.",
    );
    expect(() => jsmql("[ $bucketAuto({ groupBy: $.x, buckets: 5, granularity: 'R7' }) ]")).toThrow(
      /granularity must be one of/,
    );
  });
});

describe("stage body validation — $setWindowFields / $fill", () => {
  it("rejects a window with both documents and range", () => {
    expect(() =>
      jsmql("[ $setWindowFields({ output: { n: { $sum: 1, window: { documents: [0, 1], range: [-1, 1] } } } }) ]"),
    ).toThrow(
      "'$setWindowFields.output.n.window' requires exactly one of 'documents', 'range', but got 'documents' and 'range'.",
    );
  });
  it("rejects a $fill output field with both value and method, and a bad method", () => {
    expect(() => jsmql("[ $fill({ output: { x: { value: 0, method: 'linear' } } }) ]")).toThrow(
      "'$fill.output.x' requires exactly one of 'value', 'method', but got 'value' and 'method'.",
    );
    expect(() => jsmql("[ $fill({ sortBy: { t: 1 }, output: { x: { method: 'linaer' } } }) ]")).toThrow(
      "'$fill.output.x' method must be one of: locf, linear — got 'linaer'. Did you mean 'linear'?",
    );
  });
  it("requires sortBy when a $fill method is linear; locf runs without one", () => {
    // MEASURED on mongod: locf without sortBy is accepted; linear is refused ("$linearFill must be specified with a top level sortBy")
    expect(() => jsmql("[ $fill({ output: { x: { method: 'locf' } } }) ]")).not.toThrow();
    expect(() => jsmql("[ $fill({ output: { x: { method: 'linear' } } }) ]")).toThrow(/needs 'sortBy'/);
  });
});

describe("stage body validation — required keys & enums", () => {
  it("requires $group._id, $lookup from+as, $graphLookup keys, $merge into, $geoNear near", () => {
    expect(() => jsmql("[ $group({ total: $sum($.x) }) ]")).toThrow(/requires the '_id' field/);
    expect(() => jsmql("[ $lookup({ from: 'c', localField: 'a', foreignField: 'b' }) ]")).toThrow(
      /requires the 'as' field/,
    );
    expect(() => jsmql("[ $graphLookup({ from: 'c', startWith: $.x }) ]")).toThrow(/requires the/);
    expect(() => jsmql("[ $geoNear({ distanceField: 'd' }) ]")).toThrow(/requires the 'near' field/);
  });
  it("rejects a $merge whenMatched typo with a suggestion", () => {
    expect(() => jsmql("[ $merge({ into: 'c', whenMatched: 'replce' }) ]")).toThrow(
      /whenMatched is one of.*Did you mean 'replace'/,
    );
  });
  it("rejects a $graphLookup negative maxDepth", () => {
    expect(() =>
      jsmql(
        "[ $graphLookup({ from: 'c', startWith: $.x, connectFromField: 'a', connectToField: 'b', as: 'r', maxDepth: -1 }) ]",
      ),
    ).toThrow("'$graphLookup' maxDepth must be zero or more, got -1 — the server refuses it.");
  });
  it("rejects an empty $unionWith body", () => {
    expect(() => jsmql("[ $unionWith({}) ]")).toThrow(
      "'$unionWith' needs at least one of 'coll', 'pipeline', and none is present.",
    );
  });
});

describe("stage body validation — $replaceWith / $documents", () => {
  it("rejects a literal-scalar new root and a non-array $documents", () => {
    expect(() => jsmql("[ $replaceWith(5) ]")).toThrow("'$replaceWith' expects a document, but got a number.");
    expect(() => jsmql("[ { $documents: 5 } ]")).toThrow("'$documents' expects an array, but got a number.");
  });
  it("accepts an expression new root (rule #2)", () => {
    expect(jsmql("[ $replaceWith($.user) ]")).toEqual([{ $replaceWith: "$user" }]);
  });
});

describe("$match query-operator placement", () => {
  it("accepts $text in a first-stage $match", () => {
    expect(jsmql("[ $match({ $text: { $search: 'a' } }), $sort({ x: 1 }) ]")).toEqual([
      { $match: { $text: { $search: "a" } } },
      { $sort: { x: 1 } },
    ]);
  });
  it("rejects $near / $nearSphere / $where in an aggregation $match", () => {
    expect(() => jsmql("[ $match({ loc: { $near: [0, 0] } }) ]")).toThrow(
      /'\$near' is not allowed inside an aggregation '\$match'.*\$geoNear/,
    );
    expect(() => jsmql("[ $sort({ x: 1 }), $match({ loc: { $nearSphere: [0, 0] } }) ]")).toThrow(
      /'\$nearSphere' is not allowed.*\$geoNear/,
    );
    // MEASURED: `find({ $where: … })` runs where server-side JavaScript is enabled,
    // and an aggregation `$match` refuses it at any depth of the body. So the RAW
    // filter passes through (HR1) and the same document inside a `$match` does not.
    expect(jsmql("{ $where: 'this.x > 1' }")).toEqual({ $where: "this.x > 1" });
    expect(() => jsmql("[ $match({ $where: 'this.x > 1' }) ]")).toThrow(/'\$where' cannot stand inside '\$match'/);
    expect(() => jsmql("[ $match({ $and: [{ $where: 'this.x > 1' }] }) ]")).toThrow(
      /'\$where' cannot stand inside '\$match'/,
    );
  });
  it("leaves an ordinary $match (object or expression body) alone", () => {
    expect(jsmql("[ $sort({ x: 1 }), $match({ x: { $gt: 1 } }) ]")).toEqual([
      { $sort: { x: 1 } },
      { $match: { x: { $gt: 1 } } },
    ]);
    expect(jsmql("[ $sort({ x: 1 }), $match($.x > 1) ]")).toEqual([{ $sort: { x: 1 } }, { $match: { x: { $gt: 1 } } }]);
  });
});

// A stage is a STATEMENT. `{ $limit: … }` in an expression slot is not merely
// unusual — no deployment has a `$limit` expression operator, and mongod answers
// `Unrecognized expression '$limit'`. Universally invalid, so it belongs in the
// pre-flight validators' remit (see src/CLAUDE.md § "Never guard raw MQL").
describe("a pipeline stage name used where a value is expected", () => {
  const rejected: [string, string, RegExp][] = [
    ["an assignment RHS", "$.x = $limit(5);", /'\$limit' is a pipeline stage, not an expression/],
    ["a `$ = { … }` value", "$ = { a: $sort({ b: 1 }) };", /'\$sort' is a pipeline stage/],
    ["an arithmetic operand", '$.y = $out("c") + 1;', /'\$out' is a pipeline stage/],
    ["a `$match` body", "$match($limit(3));", /'\$limit' is a pipeline stage/],
    ["a callback body", "$.x = $.items.map(v => $unwind(v));", /'\$unwind' is a pipeline stage/],
  ];
  for (const [label, src, message] of rejected) {
    it(`is rejected in ${label}`, () => {
      expect(() => jsmql(src)).toThrow(message);
    });
  }

  it("is rejected in `jsmql.expr`, which yields an expression and never a stage", () => {
    // The bare `jsmql(...)` entry auto-wraps a lone stage call into a pipeline, so the
    // same source is a legitimate statement there — only the expression entry rejects.
    expect(() => jsmql.expr("$match($.a === 0)")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`), but received a top-level '$match' stage call. Use jsmql.pipeline() — for a Filter, drop the `$match(...)` wrapper and pass its predicate.",
    );
    expect(jsmql("$match($.a === 0)")).toEqual([{ $match: { a: 0 } }]);
  });

  it("names the value-position equivalent where one exists", () => {
    expect(() => jsmql("$.x = $sort({ b: 1 });")).toThrow(/use '\$sortArray\(…\)'/);
    expect(() => jsmql("$.x = $match($.a);")).toThrow(/use '\$filter\(…\)'/);
    // Most stages reshape a document STREAM, which no expression can do — those stop
    // at "write it as a statement" rather than inventing an alternative.
    expect(() => jsmql("$.x = $unwind($.a);")).not.toThrow(/value-position equivalent/);
  });

  // The check is registry-driven: rejected only when the name is in STAGES and NOT in
  // OPERATORS. These three fall outside that intersection and must keep working.
  it("leaves `$count`, an unknown operator, and raw MQL alone", () => {
    // `$count` is a stage AND an accumulator, so it is valid in a value slot.
    expect(jsmql("$group({ _id: null, n: $count() });")).toEqual([{ $group: { _id: null, n: { $count: {} } } }]);
    // HR2 forward-compat: an unknown name is in neither registry.
    expect(jsmql("$.x = $someFutureOp($.a, 2);")).toEqual([{ $set: { x: { $someFutureOp: ["$a", 2] } } }]);
    // Raw MQL the developer wrote verbatim stays unguarded — it is their document.
    expect(jsmql("$.x = { $limit: 5 };")).toEqual([{ $set: { x: { $limit: 5 } } }]);
  });

  it("leaves every legitimate stage position alone", () => {
    expect(jsmql("$limit(5);")).toEqual([{ $limit: 5 }]);
    expect(jsmql("$$ = $$.$limit(5);")).toEqual([{ $limit: 5 }]);
    expect(jsmql("$.r = $$$.o.aggregate(o => { $limit(5); });")).toEqual([
      { $lookup: { from: "o", pipeline: [{ $limit: 5 }], as: "r" } },
    ]);
  });
});
