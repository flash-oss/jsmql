// The template tag and the compile parameters take VALUES: nothing a caller
// supplies is ever read as syntax, as an operator, or as a field reference (HR1).
import { describe, it, expect } from "vitest";
import { jsmql, JsmqlInterpolationError } from "../src/index.ts";

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
    expect(jsmql`$.x === ${BigInt(1)}`).toEqual({ $expr: { $eq: ["$x", { $toLong: "1" }] } });
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
