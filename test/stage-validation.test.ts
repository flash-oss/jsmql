import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

// Per-stage body validation — see docs/specs/pipeline-validation.md.
// Most checks are literal-gated: a non-literal slot (field/expression) compiles
// (rule #2). The EXCEPTION is the constant-only slots ($limit/$skip/$sample.size/
// $bucket.boundaries/$lookup.pipeline/…), where a non-constant is itself a
// certain violation and throws (HR3). Each block pairs throwing and compiling
// cases.

describe("stage body validation — $limit / $skip", () => {
  it("rejects a non-positive literal $limit", () => {
    expect(() => jsmql("[ $limit(0) ]")).toThrow(/'\$limit' must be a positive integer/);
    expect(() => jsmql("[ $limit(-5) ]")).toThrow(/'\$limit' must be a positive integer/);
  });
  it("rejects a non-integer literal $limit", () => {
    expect(() => jsmql("[ $limit(2.5) ]")).toThrow(/'\$limit' must be an integer/);
  });
  it("rejects a wrong-type literal $limit", () => {
    expect(() => jsmql("[ $limit('x') ]")).toThrow(/'\$limit' expects an integer, but got a string/);
  });
  it("rejects a negative literal $skip", () => {
    expect(() => jsmql("[ $skip(-1) ]")).toThrow(/'\$skip' must be a non-negative integer/);
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
      /'\$limit' must be a positive integer and a compile-time constant/,
    );
    expect(() => jsmql("[ $skip($.n) ]")).toThrow(
      /'\$skip' must be a non-negative integer and a compile-time constant/,
    );
  });
});

describe("stage body validation — $count", () => {
  it("rejects empty / $-prefixed / dotted field names", () => {
    expect(() => jsmql("[ $count('') ]")).toThrow(/non-empty string/);
    expect(() => jsmql("[ $count('$x') ]")).toThrow(/cannot start with '\$'/);
    expect(() => jsmql("[ $count('a.b') ]")).toThrow(/cannot contain '\.'/);
  });
  it("accepts a plain field name", () => {
    expect(jsmql("[ $count('total') ]")).toEqual([{ $count: "total" }]);
  });
});

describe("stage body validation — non-object body (wrong-literal-kind)", () => {
  // The flagship: an object-bodied stage given a scalar/array literal body
  // (which the server always rejects) now throws instead of emitting it.
  it("$group rejects a non-object literal body", () => {
    expect(() => jsmql('[ $group("externalId") ]')).toThrow(
      /'\$group' expects an object body, but got a string\. Group by a field/,
    );
    expect(() => jsmql("[ $group(5) ]")).toThrow(/'\$group' expects an object body, but got a number/);
    expect(() => jsmql("[ $group([1, 2]) ]")).toThrow(/'\$group' expects an object body, but got an array/);
  });
  it("$addFields / $set reject a scalar body", () => {
    expect(() => jsmql("[ $addFields(5) ]")).toThrow(/'\$addFields' expects an object body, but got a number/);
    expect(() => jsmql('[ $set("x") ]')).toThrow(/'\$set' expects an object body, but got a string/);
  });
  it("$project / $sort / $sample reject a scalar body", () => {
    expect(() => jsmql('[ $project("name") ]')).toThrow(/'\$project' expects an object body/);
    expect(() => jsmql("[ $sort(1) ]")).toThrow(/'\$sort' expects an object body/);
    expect(() => jsmql("[ $sample(5) ]")).toThrow(/'\$sample' expects an object body/);
  });
  it("$unset rejects a non-string / non-array literal body", () => {
    expect(() => jsmql("[ $unset(5) ]")).toThrow(/'\$unset' expects a field-name string or an array of strings/);
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
  it("rejects a direction that isn't 1 or -1", () => {
    expect(() => jsmql("[ $sort({ a: 2 }) ]")).toThrow(/direction for 'a' must be 1 .* or -1/);
  });
  it("rejects a SQL-style string direction", () => {
    expect(() => jsmql(`[ $sort({ createdAt: "desc" }) ]`)).toThrow(
      /direction for 'createdAt' must be 1 .* or -1.* got 'desc'/,
    );
  });
  it("rejects a boolean direction", () => {
    expect(() => jsmql("[ $sort({ a: true }) ]")).toThrow(/direction for 'a' must be 1 .* or -1.* got true/);
  });
  it("rejects more than 32 keys", () => {
    const keys = Array.from({ length: 33 }, (_, i) => `k${i}: 1`).join(", ");
    expect(() => jsmql(`[ $sort({ ${keys} }) ]`)).toThrow(/at most 32 keys/);
  });
  it("accepts a valid sort spec", () => {
    expect(jsmql("[ $sort({ a: 1, b: -1 }) ]")).toEqual([{ $sort: { a: 1, b: -1 } }]);
  });
});

describe("stage body validation — $project", () => {
  it("rejects mixing inclusion and exclusion (non-_id)", () => {
    expect(() => jsmql("[ $project({ a: 1, b: 0 }) ]")).toThrow(/cannot mix field inclusion .* and exclusion/);
  });
  it("rejects an empty projection", () => {
    expect(() => jsmql("[ $project({}) ]")).toThrow(/must name at least one field/);
  });
  it("accepts excluding _id in an inclusion projection, and pure include/exclude", () => {
    expect(jsmql("[ $project({ _id: 0, name: 1 }) ]")).toEqual([{ $project: { _id: 0, name: 1 } }]);
    expect(jsmql("[ $project({ a: 1, b: 1 }) ]")).toEqual([{ $project: { a: 1, b: 1 } }]);
    expect(jsmql("[ $project({ a: 0, b: 0 }) ]")).toEqual([{ $project: { a: 0, b: 0 } }]);
  });
});

describe("stage body validation — $unset / $unwind", () => {
  it("rejects an empty $unset string and a non-$ $unwind path", () => {
    expect(() => jsmql("[ $unset('') ]")).toThrow(/non-empty string/);
    expect(() => jsmql("[ $unwind('items') ]")).toThrow(/must be a field path starting with '\$'/);
  });
  it("accepts a valid $unwind path (field-ref form)", () => {
    expect(jsmql("[ $unwind($.items) ]")).toEqual([{ $unwind: "$items" }]);
  });
});

describe("stage body validation — $sample / $bucket / $bucketAuto", () => {
  it("requires $sample size and rejects a negative one", () => {
    expect(() => jsmql("[ $sample({}) ]")).toThrow(/requires the 'size' field/);
    expect(() => jsmql("[ $sample({ size: -1 }) ]")).toThrow(/must be a non-negative integer/);
  });
  it("validates $bucket boundaries (required, ≥2, ascending)", () => {
    expect(() => jsmql("[ $bucket({ groupBy: $.x }) ]")).toThrow(/requires the 'boundaries' field/);
    expect(() => jsmql("[ $bucket({ groupBy: $.x, boundaries: [1] }) ]")).toThrow(/at least 2 values/);
    expect(() => jsmql("[ $bucket({ groupBy: $.x, boundaries: [3, 1, 2] }) ]")).toThrow(/strictly ascending order/);
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
      /'\$bucket boundaries' must be a constant array/,
    );
  });
  it("validates $bucketAuto buckets and granularity enum", () => {
    expect(() => jsmql("[ $bucketAuto({ groupBy: $.x, buckets: 0 }) ]")).toThrow(/must be a positive integer/);
    expect(() => jsmql("[ $bucketAuto({ groupBy: $.x, buckets: 5, granularity: 'R7' }) ]")).toThrow(
      /granularity must be one of/,
    );
  });
});

describe("stage body validation — $setWindowFields / $fill", () => {
  it("rejects a window with both documents and range", () => {
    expect(() =>
      jsmql("[ $setWindowFields({ output: { n: { $sum: 1, window: { documents: [0, 1], range: [-1, 1] } } } }) ]"),
    ).toThrow(/cannot specify both 'documents' and 'range'/);
  });
  it("rejects a $fill output field with both value and method, and a bad method", () => {
    expect(() => jsmql("[ $fill({ output: { x: { value: 0, method: 'linear' } } }) ]")).toThrow(
      /cannot specify both 'value' and 'method'/,
    );
    expect(() => jsmql("[ $fill({ sortBy: { t: 1 }, output: { x: { method: 'linaer' } } }) ]")).toThrow(
      /method must be one of: linear, locf.*Did you mean 'linear'/,
    );
  });
  it("requires sortBy when a $fill method is linear/locf", () => {
    expect(() => jsmql("[ $fill({ output: { x: { method: 'locf' } } }) ]")).toThrow(/requires 'sortBy'/);
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
      /whenMatched must be one of.*Did you mean 'replace'/,
    );
  });
  it("rejects a $graphLookup negative maxDepth", () => {
    expect(() =>
      jsmql(
        "[ $graphLookup({ from: 'c', startWith: $.x, connectFromField: 'a', connectToField: 'b', as: 'r', maxDepth: -1 }) ]",
      ),
    ).toThrow(/maxDepth.*must be a non-negative integer/);
  });
  it("rejects an empty $unionWith body", () => {
    expect(() => jsmql("[ $unionWith({}) ]")).toThrow(/requires a 'coll' and\/or a 'pipeline'/);
  });
});

describe("stage body validation — $replaceWith / $documents", () => {
  it("rejects a literal-scalar new root and a non-array $documents", () => {
    expect(() => jsmql("[ $replaceWith(5) ]")).toThrow(/must resolve to a document, but got a number/);
    expect(() => jsmql("[ { $documents: 5 } ]")).toThrow(/expects an array of documents/);
  });
  it("accepts an expression new root (rule #2)", () => {
    expect(jsmql("[ $replaceWith($.user) ]")).toEqual([{ $replaceWith: "$user" }]);
  });
});

describe("$match query-operator placement", () => {
  it("requires a $match using $text to be the first stage", () => {
    expect(() => jsmql("$sort({ x: 1 }); $match({ $text: { $search: 'a' } })")).toThrow(
      /'\$match' that uses '\$text' must be the first stage/,
    );
    // also when $text is nested under $and
    expect(() => jsmql("[ $sort({ x: 1 }), $match({ $and: [ { $text: { $search: 'a' } } ] }) ]")).toThrow(
      /must be the first stage/,
    );
  });
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
    expect(() => jsmql("[ $match({ $where: 'this.x > 1' }) ]")).toThrow(/'\$where' is not allowed.*\$expr/);
  });
  it("leaves an ordinary $match (object or expression body) alone", () => {
    expect(jsmql("[ $sort({ x: 1 }), $match({ x: { $gt: 1 } }) ]")).toEqual([
      { $sort: { x: 1 } },
      { $match: { x: { $gt: 1 } } },
    ]);
    expect(jsmql("[ $sort({ x: 1 }), $match($.x > 1) ]")).toEqual([{ $sort: { x: 1 } }, { $match: { x: { $gt: 1 } } }]);
  });
});
