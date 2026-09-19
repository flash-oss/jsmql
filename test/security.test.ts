// The template tag and the compile parameters take VALUES: nothing a caller
// supplies is ever read as syntax, as an operator, or as a field reference (HR1).
import { describe, it, expect } from "vitest";
import { jsmql, JsmqlInterpolationError } from "../src/index.ts";
import { Long } from "../src/bson.ts";

const OWN = (v: unknown) => ({ $eq: v });

describe("jsmql template-tag interpolation guards", () => {
  it("rejects undefined with a slot-pointing error", () => {
    expect(() => jsmql`$.x === ${undefined}`).toThrow(JsmqlInterpolationError);
    expect(() => jsmql`$.x === ${undefined}`).toThrow(/slot 1.*undefined/);
  });
  it("rejects function and Symbol values", () => {
    const fn = () => 1;
    expect(() => jsmql`$.x === ${fn}`).toThrow(JsmqlInterpolationError);
    expect(() => jsmql`$.x === ${Symbol("x")}`).toThrow(JsmqlInterpolationError);
  });
  it("rejects NaN, Infinity, -Infinity", () => {
    for (const v of [NaN, Infinity, -Infinity]) expect(() => jsmql`$.x === ${v}`).toThrow(JsmqlInterpolationError);
  });
  it("rejects circular objects", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => jsmql`$.x === ${cyc}`).toThrow(JsmqlInterpolationError);
  });
  it("reports the correct slot index", () => {
    expect(() => jsmql`$.a === ${1} && $.b === ${undefined}`).toThrow(/slot 2/);
  });
  it("takes a BigInt as a value", () => {
    expect(jsmql`$.x === ${BigInt(1)}`).toEqual({ x: Long.fromString("1") });
  });
});

describe("jsmql template-tag interpolation cannot inject syntax", () => {
  const evil = '"}); db.dropDatabase(); //';
  it("breakout-attempt strings round-trip as literal values", () => {
    expect(jsmql`$.field === ${evil}`).toEqual({ field: '"}); db.dropDatabase(); //' });
    expect(jsmql`$eq($.field, ${evil})`).toEqual({ field: { $eq: '"}); db.dropDatabase(); //' } });
  });
  it("backticks and template-style payloads stay literal", () => {
    const payload = "`${$.password}`";
    expect(jsmql`$.field === ${payload}`).toEqual({ field: "`${$.password}`" });
  });
  it("a string that looks like a field reference stays a string", () => {
    expect(jsmql`$.a === ${"$b"}`).toEqual({ a: "$b" });
    expect(jsmql.expr`$.a + ${"$b"}`).toEqual({ $add: ["$a", { $literal: "$b" }] });
    expect(jsmql.expr.compile(({ s }, { $ }) => $.a + s)({ s: "$b" })).toEqual({ $add: ["$a", { $literal: "$b" }] });
    // a pipeline evaluates its values too: a `$set` value, a stage body, a group key
    expect(jsmql.pipeline`$.x = ${"$b"};`).toEqual([{ $set: { x: { $literal: "$b" } } }]);
    expect(
      jsmql.pipeline.compile(({ s }, { $ }) => {
        $.x = s;
      })({ s: "$b" }),
    ).toEqual([{ $set: { x: { $literal: "$b" } } }]);
    expect(jsmql.pipeline`$group({ _id: ${"$b"}, n: $sum(1) })`).toEqual([
      { $group: { _id: { $literal: "$b" }, n: { $sum: 1 } } },
    ]);
    // an update DOCUMENT evaluates nothing: the server stores the string as written
    expect(jsmql.update`$.x = ${"$b"}`).toEqual({ $set: { x: "$b" } });
  });
  it("an object whose keys look like operators is emitted as data, not invoked", () => {
    const payload = { $gt: 0, $where: "this.secret" };
    expect(jsmql`$eq($.field, ${payload})`).toEqual({ field: { $eq: { $gt: 0, $where: "this.secret" } } });
    expect(jsmql.expr`${payload}`).toEqual({ $literal: { $gt: 0, $where: "this.secret" } });
  });
});

describe("recursion depth limits", () => {
  const nested = "(".repeat(300) + "1" + ")".repeat(300);
  it("jsmql.validate() reports deep nesting as a SYNTAX_ERROR, never a RangeError", () => {
    const result = jsmql.validate(nested);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("SYNTAX_ERROR");
    expect(result.errors[0].message).toMatch(/nests too deeply/);
  });
  it("jsmql() throws the depth message on deeply nested parens and operator calls", () => {
    expect(() => jsmql(nested)).toThrow(/nests too deeply/);
    expect(() => jsmql("$add(".repeat(300) + "1" + ")".repeat(300))).toThrow(/nests too deeply/);
  });
  it("typical-depth expressions still compile", () => {
    const src = "(".repeat(40) + "$.a > 1" + ")".repeat(40);
    expect(() => jsmql(src)).not.toThrow();
  });
});

describe("jsmql.validate() error contract", () => {
  it("never throws on a template value; it reports or accepts", () => {
    expect(jsmql.validate`$.x === ${BigInt(1)}`).toEqual({ valid: true, errors: [] });
    const result = jsmql.validate`$.x === ${undefined}`;
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("SYNTAX_ERROR");
  });
});

// ── a field name JavaScript refuses to store the ordinary way ────────────────
//
// MongoDB reserves no field names, so `__proto__` is ordinary data — and it is the
// one name `out[name] = value` sends to the PROTOTYPE slot, creating no own property.
// Three more names read back a method that was never stored (`constructor`,
// `toString`, `valueOf`), and `name in out` answers true for all of them. Each of the
// four goes wrong differently, so each is asserted here rather than assumed.
// See the `setKey` header in src/registry/mql.ts.
describe("a developer-authored field name survives to the output", () => {
  const HOSTILE = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"];

  it("every write road keeps the name", () => {
    for (const k of HOSTILE) {
      const q = JSON.stringify(k);
      expect(JSON.stringify(jsmql.pipeline(`$.${k} = 1;`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$ = { ${q}: 1 };`))).toContain(k);
      expect(JSON.stringify(jsmql.expr(`({ ${q}: 1 })`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$sort({ ${q}: 1 });`))).toContain(k);
      expect(JSON.stringify(jsmql.update(`$.${k} = 1`))).toContain(k);
      expect(JSON.stringify(jsmql.update(`delete $.${k}`))).toContain(k);
    }
  });

  it("every folding road that builds an object keeps the name", () => {
    for (const k of HOSTILE) {
      const q = JSON.stringify(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = ({a:1}).mapKeys(() => ${q});`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = [[${q}, 1]].fromPairs();`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = ({a: ${q}}).invert();`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = [${q}].zipObject([1]);`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = [{k: ${q}}].groupBy(x => x.k);`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = [{k: ${q}}].countBy(x => x.k);`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = ({[${q}]: 1}).mapValues(v => v);`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = $.o.pick([${q}]);`))).toContain(k);
    }
  });

  // `key in branches` answers true for every name on `Object.prototype`, so the
  // duplicate guard must not refuse a program that has no duplicate at all.
  it("a $facet branch may be named after a prototype member, and a real duplicate is still refused", () => {
    expect(jsmql.pipeline("$ = { toString: $$ };")).toEqual([{ $facet: { toString: [] } }]);
    expect(jsmql.pipeline("$ = { valueOf: $$, hasOwnProperty: $$ };")).toEqual([
      { $facet: { valueOf: [], hasOwnProperty: [] } },
    ]);
    expect(() => jsmql.pipeline("$ = { dup: $$, dup: $$ };")).toThrow("names two '$facet' branches");
  });

  // The fold reads its accumulator back, and a plain object answers a FUNCTION for
  // `constructor` — a value the fold never stored.
  it("a fold keyed by a prototype member answers what it stored", () => {
    expect(jsmql.pipeline("$.r = [{ k: 'constructor' }].groupBy(x => x.k);")).toEqual([
      { $set: { r: { $mergeObjects: [{ constructor: [{ k: "constructor" }] }] } } },
    ]);
    expect(jsmql.pipeline("$.r = [{ k: 'constructor' }].countBy(x => x.k);")).toEqual([
      { $set: { r: { $mergeObjects: [{ constructor: 1 }] } } },
    ]);
  });
});
