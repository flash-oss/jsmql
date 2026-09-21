// The type tracker: what the compiler proves about a written field, a `let`, a
// possible-kinds value — and what the server does with the document it emits.
//
// Each case states the MQL, and the live half runs that MQL on the project's own
// mongod, so the claim "this shape is valid and answers X" is measured, never
// assumed (HR3). The suite skips its live half when no mongod is listening.
// See docs/specs/types.md.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Collection } from "mongodb";
import { jsmql } from "../src/index.ts";
import { DOCUMENT, at, kindsOf, of, written } from "../src/compiler/emit/type.ts";
import { liveClient } from "./fixtures/live.ts";

const up = await liveClient();
await up?.close();

describe("types — a written field carries what its value proved", () => {
  it("an array write, then a boolean write: no `$switch`, and the boolean is its own truth", () => {
    expect(
      jsmql(`
        $.arr = $.tags.uniq();
        $.bool = $.arr.includes("red");
        $.result = $.bool ? "R" : "OTHER";
      `),
    ).toEqual([
      { $set: { arr: { $setUnion: "$tags" } } },
      // `tags` may be missing, so `arr` may be null, and `$in` aborts on null: the guard stays.
      {
        $set: {
          bool: {
            $cond: { if: { $eq: [{ $ifNull: ["$arr", null] }, null] }, then: null, else: { $in: ["red", "$arr"] } },
          },
        },
      },
      // MongoDB reads null and missing as false, so a boolean needs no other test.
      { $set: { result: { $cond: { if: "$bool", then: "R", else: "OTHER" } } } },
    ]);
  });

  it("a string write, then a string method: the method's own form, guarded only while the value may be missing", () => {
    expect(jsmql("$.s = $.a.trim(); $.t = $.s.toUpperCase();")).toEqual([
      { $set: { s: { $trim: { input: "$a" } } } },
      {
        $set: {
          t: { $cond: { if: { $eq: [{ $ifNull: ["$s", null] }, null] }, then: null, else: { $toUpper: "$s" } } },
        },
      },
    ]);
    // A literal is there: no guard at all.
    expect(jsmql('$.s = "abc"; $.t = $.s.toUpperCase();')).toEqual([
      { $set: { s: "abc" } },
      { $set: { t: { $toUpper: "$s" } } },
    ]);
  });

  it("a `let` takes the type of each value it is assigned", () => {
    expect(jsmql("let x = $.n + 1; x = $.s.trim(); $.len = x.length;")).toEqual([
      { $set: { "__jsmql.var.x": { $add: ["$n", 1] } } },
      { $set: { "__jsmql.var.x": { $trim: { input: "$s" } } } },
      {
        $set: {
          len: {
            $cond: {
              if: { $eq: [{ $ifNull: ["$__jsmql.var.x", null] }, null] },
              then: null,
              else: { $strLenCP: "$__jsmql.var.x" },
            },
          },
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("a method on a field proven to hold a kind the method has no form for is refused at compile time", () => {
    expect(() => jsmql('$.b = $.arr.includes("x"); $.t = $.b.trim();')).toThrow(
      "'.trim()' is not available on a 'bool' — it is defined on 'string'.",
    );
  });

  it("a stage that replaces the document forgets every written type", () => {
    expect(jsmql('$.v = $.flag ? "abc" : [1, 2]; $ = { v: $.other }; $.len = $.v.length;')).toEqual([
      {
        $set: {
          v: {
            $cond: {
              if: {
                $and: [
                  { $ne: [{ $ifNull: ["$flag", null] }, null] },
                  { $ne: ["$flag", false] },
                  { $ne: ["$flag", ""] },
                  { $ne: ["$flag", 0] },
                ],
              },
              then: "abc",
              else: [1, 2],
            },
          },
        },
      },
      { $replaceWith: { v: "$other" } },
      {
        $set: {
          len: {
            $switch: {
              branches: [
                { case: { $in: [{ $type: "$v" }, ["array"]] }, then: { $size: "$v" } },
                { case: { $in: [{ $type: "$v" }, ["string"]] }, then: { $strLenCP: "$v" } },
              ],
              default: null,
            },
          },
        },
      },
    ]);
  });
});

describe("types — a value of several possible kinds dispatches over those kinds alone", () => {
  it("two kinds the row covers, present: a `$switch` over the two, with no default", () => {
    expect(jsmql('$.v = $.flag ? "abc" : [1, 2]; $.len = $.v.length;')[1]).toEqual({
      $set: {
        len: {
          $switch: {
            branches: [
              { case: { $in: [{ $type: "$v" }, ["array"]] }, then: { $size: "$v" } },
              { case: { $in: [{ $type: "$v" }, ["string"]] }, then: { $strLenCP: "$v" } },
            ],
          },
        },
      },
    });
  });

  it("a kind the row has no form for keeps the null default", () => {
    expect(jsmql("$.v = $.flag ? 5 : [1, 2]; $.len = $.v.length;")[1]).toEqual({
      $set: {
        len: {
          $switch: {
            branches: [{ case: { $in: [{ $type: "$v" }, ["array"]] }, then: { $size: "$v" } }],
            default: null,
          },
        },
      },
    });
  });
});

describe("types — the write rules", () => {
  it("a whole-field write replaces the field's proof", () => {
    const doc = written(written(DOCUMENT, "a", of("string")), "a", of("number"));
    expect(kindsOf(at(doc, "a"))).toEqual(["number"]);
  });

  it("a dotted write keeps the parent's other properties and makes the parent present", () => {
    // `address` was never written whole, so it may be an array: each property is then
    // the string written, or the list of strings the array form carries (measured below).
    const doc = written(written(DOCUMENT, "address.country", of("string")), "address.full", of("string"));
    expect(kindsOf(at(doc, "address.country"))?.sort()).toEqual(["array", "string"]);
    expect(kindsOf(at(doc, "address.full"))?.sort()).toEqual(["array", "string"]);
    expect(at(doc, "address").absent).toBe(false);
    // A parent written whole as an object first is an object, and its properties are exact.
    const known = written(written(DOCUMENT, "address", of("object")), "address.full", of("string"));
    expect(kindsOf(at(known, "address.full"))).toEqual(["string"]);
  });

  it("a dotted write into an unknown parent may land on an object or into every element of an array", () => {
    // MEASURED below: `{ $set: { "a.b": 1 } }` makes a scalar `a` into `{ b: 1 }` and
    // writes `b` into each element of an array `a`. So `a.b` is a number or a list of them.
    const doc = written(DOCUMENT, "a.b", of("number"));
    expect(kindsOf(at(doc, "a"))?.sort()).toEqual(["array", "object"]);
    expect(kindsOf(at(doc, "a.b"))?.sort()).toEqual(["array", "number"]);
  });
});

describe.skipIf(up === null)("types — the server agrees", () => {
  let client: MongoClient;
  let coll: Collection;
  beforeAll(async () => {
    client = (await liveClient())!;
    coll = client.db("jsmql_compiler_types").collection("t");
  });
  afterAll(async () => {
    await client?.close();
  });

  it("the array-then-boolean program answers as JavaScript would", async () => {
    await coll.deleteMany({});
    await coll.insertMany([{ _id: 1, tags: ["red", "blue", "red"] }, { _id: 2, tags: ["blue"] }, { _id: 3 }]);
    const out = await coll
      .aggregate([
        ...(jsmql(
          '$.arr = $.tags.uniq(); $.bool = $.arr.includes("red"); $.result = $.bool ? "R" : "OTHER";',
        ) as object[]),
        { $sort: { _id: 1 } },
      ])
      .toArray();
    expect(out.map((d) => d.result)).toEqual(["R", "OTHER", "OTHER"]);
    expect(out.map((d) => d.bool)).toEqual([true, false, null]);
  });

  it("a default-less `$switch` over two present kinds runs on both", async () => {
    await coll.deleteMany({});
    await coll.insertMany([
      { _id: 1, flag: true },
      { _id: 2, flag: false },
    ]);
    const out = await coll
      .aggregate([...(jsmql('$.v = $.flag ? "abc" : [1, 2]; $.len = $.v.length;') as object[]), { $sort: { _id: 1 } }])
      .toArray();
    expect(out.map((d) => d.len)).toEqual([3, 2]);
  });

  it("a dotted `$set` lands on a scalar as an object and into every element of an array", async () => {
    await coll.deleteMany({});
    await coll.insertMany([
      { _id: 1, a: 5 },
      { _id: 2, a: { c: 1 } },
      { _id: 3 },
      { _id: 4, a: [1, 2] },
      { _id: 5, a: [{ x: 1 }, { x: 2 }] },
    ]);
    const out = await coll.aggregate([...(jsmql("$.a.b = 1;") as object[]), { $sort: { _id: 1 } }]).toArray();
    expect(out.map((d) => d.a)).toEqual([
      { b: 1 },
      { c: 1, b: 1 },
      { b: 1 },
      [{ b: 1 }, { b: 1 }],
      [
        { x: 1, b: 1 },
        { x: 2, b: 1 },
      ],
    ]);
  });

  it("a `let` assigned again reads as its new value", async () => {
    await coll.deleteMany({});
    await coll.insertMany([
      { _id: 1, n: 1, s: "  ab  " },
      { _id: 2, n: 1 },
    ]);
    const out = await coll
      .aggregate([...(jsmql("let x = $.n + 1; x = $.s.trim(); $.len = x.length;") as object[]), { $sort: { _id: 1 } }])
      .toArray();
    expect(out.map((d) => d.len)).toEqual([2, null]);
  });
});
