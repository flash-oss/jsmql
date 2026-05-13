import { describe, it, expect } from "vitest";
import { jsmql, JsmqlInterpolationError } from "../src/index.ts";

describe("jsmql template-tag interpolation guards", () => {
  it("rejects undefined with a slot-pointing error", () => {
    expect(() => jsmql`$.x == ${undefined}`).toThrow(JsmqlInterpolationError);
    expect(() => jsmql`$.x == ${undefined}`).toThrow(/slot 1.*undefined/);
  });

  it("rejects function values", () => {
    const fn = () => 1;
    expect(() => jsmql`$.x == ${fn}`).toThrow(JsmqlInterpolationError);
  });

  it("rejects Symbol values", () => {
    expect(() => jsmql`$.x == ${Symbol("x")}`).toThrow(JsmqlInterpolationError);
  });

  it("rejects NaN, Infinity, -Infinity", () => {
    expect(() => jsmql`$.x == ${NaN}`).toThrow(JsmqlInterpolationError);
    expect(() => jsmql`$.x == ${Infinity}`).toThrow(JsmqlInterpolationError);
    expect(() => jsmql`$.x == ${-Infinity}`).toThrow(JsmqlInterpolationError);
  });

  it("rejects BigInt with a serialisation error", () => {
    expect(() => jsmql`$.x == ${BigInt(1)}`).toThrow(JsmqlInterpolationError);
  });

  it("rejects circular objects", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => jsmql`$.x == ${cyc}`).toThrow(JsmqlInterpolationError);
  });

  it("reports the correct slot index", () => {
    expect(() => jsmql`$.a == ${1} && $.b == ${undefined}`).toThrow(/slot 2/);
  });
});

describe("jsmql template-tag interpolation cannot inject syntax", () => {
  it("breakout-attempt strings round-trip as literal values", () => {
    const evil = '"); $where: 1; (';
    expect(jsmql`$eq($.field, ${evil})`).toEqual({ $eq: ["$field", evil] });
  });

  it("backticks and template-style payloads stay literal", () => {
    const evil = "`${$.password}`";
    expect(jsmql`$eq($.field, ${evil})`).toEqual({ $eq: ["$field", evil] });
  });

  it("an object whose keys look like operators is emitted as data, not invoked", () => {
    const payload = { $function: { body: "function(){return 1}", args: [], lang: "js" } };
    // Interpolating the object lands inside a value position, so codegen treats
    // it as a plain object literal — keys become output keys, NOT operator dispatch.
    // (Operator dispatch is triggered by `$name(...)` call syntax in the source.)
    const result = jsmql`$eq($.field, ${payload})` as { $eq: [string, unknown] };
    expect(result.$eq[0]).toEqual("$field");
    expect(result.$eq[1]).toEqual(payload);
  });
});

describe("recursion depth limits", () => {
  it("jsmql.validate() catches deeply nested input as SYNTAX_ERROR (no uncaught RangeError)", () => {
    const src = "(".repeat(2000) + "1" + ")".repeat(2000);
    const result = jsmql.validate(src);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("SYNTAX_ERROR");
    expect(result.errors[0].message).toMatch(/nests too deeply/);
  });

  it("jsmql() throws ParseError with the depth message on deeply nested parens", () => {
    const src = "(".repeat(2000) + "1" + ")".repeat(2000);
    expect(() => jsmql(src)).toThrow(/nests too deeply/);
  });

  it("rejects deeply nested operator-call arguments", () => {
    // 600 levels of $not($not(...$not(true))) — survives lexing and parsing
    // until the depth counter trips (200 is the cap, but the throw happens
    // when we recurse past it).
    let src = "true";
    for (let i = 0; i < 600; i++) src = `$not(${src})`;
    expect(() => jsmql(src)).toThrow(/nests too deeply/);
  });

  it("typical-depth expressions still compile", () => {
    let src = "true";
    for (let i = 0; i < 50; i++) src = `$not(${src})`;
    // 50 levels nests inside MAX_RECURSION_DEPTH; should compile fine.
    expect(() => jsmql(src)).not.toThrow();
  });
});

describe("jsmql.validate() error contract", () => {
  it("never throws on BigInt-via-template-tag interpolation; returns structured error", () => {
    // Now that `jsmql.validate` is itself polymorphic, the workaround the previous
    // test had to dance around is gone — `jsmql.validate` accepts the template-tag
    // form directly and turns the JsmqlInterpolationError into a structured
    // SYNTAX_ERROR, never throwing.
    const result = jsmql.validate`$.x == ${BigInt(1)}`;
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("SYNTAX_ERROR");
    expect(result.errors[0].message).toMatch(/slot 1/);
  });

  it("turns RangeError into a structured SYNTAX_ERROR via the depth-limit path", () => {
    // Already covered by the depth-limit test, but assert the contract shape
    // here: jsmql.validate() returns, never throws, regardless of input.
    const src = "(".repeat(2000) + "1" + ")".repeat(2000);
    expect(() => jsmql.validate(src)).not.toThrow();
  });
});

describe("function-body cache is bounded", () => {
  it("compiles 300 distinct arrow bodies correctly (smoke-tests LRU eviction)", () => {
    // eval is used to produce arrow functions with distinct body text, which
    // is the only path that hits the function-body cache. With the LRU cap at
    // 256, this loop forces ~44 evictions; the assertion is that all 300
    // compilations still produce the correct output, i.e. neither the cache
    // helpers nor the eviction path corrupt anything.
    for (let i = 0; i < 300; i++) {
      // eslint-disable-next-line no-eval
      const fn = eval(`($) => $.field${i} > ${i}`) as ($: unknown) => unknown;
      const result = jsmql(fn) as { $gt: [string, number] };
      expect(result).toEqual({ $gt: [`$field${i}`, i] });
    }
  });
});
