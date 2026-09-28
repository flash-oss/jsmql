// HR6 — raw MQL can hold JSMQL, and JSMQL cannot take raw MQL as an operand.
//
// The rule lives in docs/LANG_RULES.md. The check reads the tree as parsed:
// docs/specs/raw-mql-boundary.md.

import { describe, expect, it } from "vitest";
import { jsmql } from "../src/index.ts";

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
    ["Math.max($.a, $abs($.b))", refused("$abs(…)", "an operand of 'Math.max()'")],
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
