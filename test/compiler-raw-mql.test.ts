// HR6 — raw MQL can hold JSMQL, and JSMQL cannot take raw MQL as an operand.
//
// The rule lives in docs/LANG_RULES.md. The check reads the tree as parsed:
// docs/specs/raw-mql-boundary.md.

import type { Collection, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jsmql } from "../src/index.ts";
import { liveClientNow, liveUp } from "./fixtures/live.ts";

const refused = (raw: string, role: string): string => `'${raw}' is raw MQL, and raw MQL cannot be ${role}.`;
const queryDoc = (raw: string, op: string): string =>
  `'${raw}' is a query document (raw MQL), and raw MQL cannot be an operand of '${op}'.`;

describe("HR6 — JSMQL refuses raw MQL as an operand", () => {
  const CASES: [string, string][] = [
    ["$ifNull($.a, 0) && $.b > 1", refused("$ifNull(…)", "an operand of '&&'")],
    ["$.x > $abs($.y)", refused("$abs(…)", "an operand of '>'")],
    ["$abs($.y) + 1", refused("$abs(…)", "an operand of '+'")],
    ["$abs($.y) ?? 0", refused("$abs(…)", "an operand of '??'")],
    ["!$eq($.a, 1)", refused("$eq(…)", "an operand of '!'")],
    ["-$abs($.x)", refused("$abs(…)", "an operand of '-'")],
    ["$.a ? $abs($.y) : 0", refused("$abs(…)", "an operand of '?:'")],
    ["$ifNull($.tags, []).map(t => t)", refused("$ifNull(…)", "the receiver of '.map()'")],
    ["$getField({ field: 'a', input: $.o }).x", refused("$getField(…)", "the receiver of '.x'")],
    ["{ $x: 1 }.y", refused("{ $x: … }", "the receiver of '.y'")],
    ["`${$abs($.y)}`", refused("$abs(…)", "an operand of a template literal")],
    ["[...$ifNull($.a, [])]", refused("$ifNull(…)", "an operand of '...'")],
    ["$.items.concat($ifNull($.extra, []))", refused("$ifNull(…)", "an operand of '.concat()'")],
    ["[$.a, $abs($.b)].max()", refused("$abs(…)", "the receiver of '.max()'")],
    ["new Date($toLong($.t))", refused("$toLong(…)", "an operand of 'new Date()'")],
    ["$.code === $literal('$x')", refused("$literal(…)", "an operand of '==='")],
  ];
  it.each(CASES)("%s", (src, message) => {
    expect(() => jsmql(src)).toThrow(message);
  });

  it("refuses the right side of a compound assignment", () => {
    expect(() => jsmql("$.x += $abs($.y);")).toThrow(refused("$abs(…)", "an operand of '+='"));
  });

  it("holds at every depth: an operand is JSMQL all the way down", () => {
    expect(() => jsmql("$.items.concat([$abs($.x)])")).toThrow(refused("$abs(…)", "an operand of '.concat()'"));
    expect(() => jsmql("[$ifNull($.a, 0)][0] && $.b > 1")).toThrow(refused("$ifNull(…)", "the receiver of '[…]'"));
    expect(() => jsmql.expr("$.o === { a: $abs($.x) }")).toThrow(refused("$abs(…)", "an operand of '==='"));
    // JSMQL inside raw MQL is JSMQL again, so the rule applies there too
    expect(() => jsmql("$abs($ifNull($.a, 0) + 1)")).toThrow(refused("$ifNull(…)", "an operand of '+'"));
    // a matcher object holds JSMQL, so a `$` key in it is raw MQL
    expect(() => jsmql("$$.filter({ qty: { $gt: 5 } });")).toThrow(refused("{ $gt: … }", "an operand of '.filter()'"));
  });

  it("refuses a query document in '&&', '||' or '!' on the query road", () => {
    expect(() => jsmql('{ status: "A" } && $.qty > 5')).toThrow(queryDoc("{ status: … }", "&&"));
    expect(() => jsmql('$.qty > 5 || { status: "A" }')).toThrow(queryDoc("{ status: … }", "||"));
    expect(() => jsmql('!{ status: "A" }')).toThrow(queryDoc("{ status: … }", "!"));
    expect(() => jsmql('$match({ status: "A" } && $.qty > 5);')).toThrow(queryDoc("{ status: … }", "&&"));
    // on the value road the object is a JavaScript object
    expect(jsmql.expr('{ status: "A" } && $.qty > 5')).toEqual({
      $let: { vars: { jsmqlV: { status: "A" } }, in: { $gt: ["$qty", 5] } },
    });
  });

  it("gives the position of the raw node to .validate()", () => {
    const { valid, errors } = jsmql.validate("$.b > 1 && $ifNull($.a, 0)");
    expect(valid).toBe(false);
    expect(errors[0].message).toBe(refused("$ifNull(…)", "an operand of '&&'"));
    expect(errors[0].pos).toBe(11);
  });
});

describe("HR6 — raw MQL stands as a whole value", () => {
  it("holds JSMQL", () => {
    expect(jsmql.expr("$abs($.x + 1)")).toEqual({ $abs: { $add: ["$x", 1] } });
    expect(jsmql("$and($.age > 18, $sampleRate(0.1))")).toEqual({ $and: [{ age: { $gt: 18 } }, { $sampleRate: 0.1 }] });
  });

  it("stands in an entry of a literal, beside JSMQL", () => {
    expect(jsmql.expr("{ a: $abs($.x), b: $.y + 1 }")).toEqual({ a: { $abs: "$x" }, b: { $add: ["$y", 1] } });
    expect(jsmql("$$.$group({ _id: $.tag, n: $sum(1) });")).toEqual([{ $group: { _id: "$tag", n: { $sum: 1 } } }]);
  });

  it("stands on the right side of '=', in a 'let' value and in a callback", () => {
    expect(jsmql("$.x = $abs($.y);")).toEqual([{ $set: { x: { $abs: "$y" } } }]);
    expect(jsmql("$ = $mergeObjects($, { a: 1 });")).toEqual([
      { $replaceWith: { $mergeObjects: ["$$ROOT", { a: 1 }] } },
    ]);
    expect(jsmql.expr("$.tags.map(t => $toUpper(t))")).toEqual({
      $map: { input: { $ifNull: ["$tags", []] }, as: "t", in: { $toUpper: "$$t" } },
    });
    expect(jsmql.expr("$.items.map(i => { const q = $abs(i.q); return q * 2 })")).toEqual({
      $map: {
        input: { $ifNull: ["$items", []] },
        as: "i",
        in: { $let: { vars: { q: { $abs: "$$i.q" } }, in: { $multiply: ["$$q", 2] } } },
      },
    });
  });

  it("reads a name as JSMQL, whatever value it holds", () => {
    expect(jsmql("$.tmp = $ifNull($.a, 0); $.r = $.tmp > 1;")).toEqual([
      { $set: { tmp: { $ifNull: ["$a", 0] } } },
      { $set: { r: { $gt: ["$tmp", 1] } } },
    ]);
    expect(() => jsmql("let a = $ifNull($.a, 0); $.r = a && $.b > 1;")).not.toThrow();
  });

  it("interleaves a stage link with a JSMQL method in one chain", () => {
    expect(jsmql("$$.filter(p => p.score > 0).$sort({ score: -1 }).take(10);")).toEqual([
      { $match: { score: { $gt: 0 } } },
      { $sort: { score: -1 } },
      { $limit: 10 },
    ]);
  });

  it("reads each stage of '.aggregate([…])' as a whole value", () => {
    expect(jsmql("$$.aggregate([{ $match: { s: 1 } }, { $limit: 2 }]);")).toEqual([
      { $match: { s: 1 } },
      { $limit: 2 },
    ]);
  });

  it("does not check a value that the program passes in", () => {
    const base = { tenantId: 7, deleted: false };
    expect(jsmql`${base} && $.qty > 5`).toEqual({ tenantId: 7, deleted: false, qty: { $gt: 5 } });
    expect(jsmql.compile(({ q }: { q: object }, { $ }) => q && $.qty > 5)({ q: base })).toEqual({
      tenantId: 7,
      deleted: false,
      qty: { $gt: 5 },
    });
  });
});

describe("HR6 — a '$…' string in JSMQL is text", () => {
  it("reads it as text in an operand and in a whole value that JSMQL owns", () => {
    expect(jsmql.expr('$.code === "$x"')).toEqual({ $eq: ["$code", { $literal: "$x" }] });
    expect(jsmql.expr('$.tags.concat(["$y"])')).toEqual({
      $concatArrays: [{ $ifNull: ["$tags", []] }, [{ $literal: "$y" }]],
    });
    expect(jsmql.expr('$.o === { a: "$y" }')).toEqual({ $eq: ["$o", { a: { $literal: "$y" } }] });
    expect(jsmql('$.x = "$y";')).toEqual([{ $set: { x: { $literal: "$y" } } }]);
    expect(jsmql('$.x = { a: $abs($.y), b: "$y" };')).toEqual([
      { $set: { x: { $mergeObjects: [{ a: { $abs: "$y" }, b: { $literal: "$y" } }] } } },
    ]);
    expect(jsmql.expr('$.tags.map(t => "$y")')).toEqual({
      $map: { input: { $ifNull: ["$tags", []] }, as: "t", in: { $literal: "$y" } },
    });
    // a `const` value is a whole value that JSMQL owns, and the fold keeps its string text
    expect(jsmql('const s = "$y"; $.x = s;')).toEqual([{ $set: { x: { $literal: "$y" } } }]);
    // the fold computes from JSMQL, so each string it computes is text
    expect(jsmql('$project({ x: "$y" + "!" });')).toEqual([{ $project: { x: { $literal: "$y!" } } }]);
  });

  it("reads it as a field path in raw MQL and at the program root (HR1)", () => {
    expect(jsmql.expr('"$y"')).toBe("$y");
    expect(jsmql.expr('{ a: "$y" }')).toEqual({ a: "$y" });
    expect(jsmql('$project({ x: "$y", o: { a: "$y" } });')).toEqual([{ $project: { x: "$y", o: { a: "$y" } } }]);
    expect(jsmql('$$.$group({ _id: "$tag", n: $sum(1) });')).toEqual([{ $group: { _id: "$tag", n: { $sum: 1 } } }]);
    // the Filter translation of a top-level `$op` keeps the query reading
    expect(jsmql('$eq($.code, "$x")')).toEqual({ code: { $eq: "$x" } });
  });

  it("writes the text as it is where nothing evaluates it", () => {
    // the query language compares a string as written
    expect(jsmql('$.code === "$x"')).toEqual({ code: "$x" });
    expect(jsmql('$.s.startsWith("$")')).toEqual({ s: { $regex: /^\$/ } });
    // an update document stores a string as written
    expect(jsmql.update('$.x = "$y";')).toEqual({ $set: { x: "$y" } });
  });

  it("refuses text where it would become part of the MQL", () => {
    expect(() => jsmql('const p = "$items"; $unwind(p);')).toThrow(
      "A string that JSMQL reads as text is never MQL. '$unwind' reads its body as written",
    );
  });
});

// The server gives JavaScript's answer for each text string.
describe.skipIf(!(await liveUp()))("HR6 — the text string on a live mongod", () => {
  let client: MongoClient;
  let coll: Collection;
  beforeAll(async () => {
    client = await liveClientNow();
    coll = client.db("jsmql_compiler_raw_mql").collection("t");
    await coll.deleteMany({});
    await coll.insertMany([
      { _id: 1, amount: "5", s: "$5", code: "$x", x: "z", file: "a.$ext", pad: "ab" },
      { _id: 2, amount: "7", s: "a$b", code: "z", x: "z", file: "a.ext", pad: "abcdef" },
    ]);
  });
  afterAll(async () => {
    await client?.close();
  });

  const JS: [string, (d: Record<string, string>) => unknown][] = [
    ['"$" + $.amount', (d) => "$" + d.amount],
    ['$.s.split("$")', (d) => d.s.split("$")],
    ['$.s.startsWith("$")', (d) => d.s.startsWith("$")],
    ['$.file.endsWith("$ext")', (d) => d.file.endsWith("$ext")],
    ['$.pad.padStart(5, "$")', (d) => d.pad.padStart(5, "$")],
    ['$.code === "$x"', (d) => d.code === "$x"],
    ['$.s.includes("$")', (d) => d.s.includes("$")],
  ];
  it.each(JS)("%s", async (src, js) => {
    const docs = await coll.aggregate([{ $addFields: { __v: jsmql.expr(src) } }, { $sort: { _id: 1 } }]).toArray();
    expect(docs.map((d) => d.__v)).toEqual(docs.map((d) => js(d as unknown as Record<string, string>)));
  });

  it("selects by the text on the query road", async () => {
    const ids = async (src: string) =>
      (
        await coll
          .find(jsmql(src) as object)
          .sort({ _id: 1 })
          .toArray()
      ).map((d) => d._id);
    expect(await ids('$.s.startsWith("$")')).toEqual([1]);
    expect(await ids('$.code === "$x"')).toEqual([1]);
  });
});
