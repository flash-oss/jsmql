// A synthesised lambda parameter must not capture a name its body mentions.

import { describe, expect, it } from "vitest";
import { parse, parseExpression } from "../src/compiler/parse/parser.ts";
import { freshParam, namesIn } from "../src/compiler/passes/fresh.ts";

const names = (src: string): string[] => [...namesIn(parseExpression(src))].sort();

describe("compiler/passes/fresh — every name the tree mentions", () => {
  it("collects bare names", () => {
    expect(names("n + m")).toEqual(["m", "n"]);
    // A field path is not a name: `$.n` cannot be shadowed by a parameter.
    expect(names("$.n + $.m")).toEqual([]);
  });

  it("collects a lambda's own parameters, which a new one could shadow", () => {
    expect(names("$.a.map(r => r.x)")).toEqual(["r"]);
    expect(names("$.a.map((v, i) => v + i)")).toEqual(["i", "v"]);
  });

  it("collects a declared binding", () => {
    expect([...namesIn(parse("let cutoff = 1; $match($.a > cutoff)"))].sort()).toEqual(["cutoff"]);
  });
});

describe("compiler/passes/fresh — the parameter it picks", () => {
  it("uses the bare name when nothing claims it", () => {
    expect(freshParam("x", parseExpression("$.a"))).toBe("x");
    expect(freshParam("x", parseExpression("{ a: 1 }"))).toBe("x");
  });

  it("steps aside for a name the argument mentions", () => {
    expect(freshParam("x", parseExpression("{ a: x }"))).toBe("x2");
    expect(freshParam("n", parseExpression("{ a: n }"))).toBe("n2");
  });

  it("keeps stepping until the name is free", () => {
    expect(freshParam("x", parseExpression("[x, x2, x3]"))).toBe("x4");
  });

  it("reads every argument it is given, not just the first", () => {
    expect(freshParam("x", parseExpression("1"), parseExpression("x + 1"))).toBe("x2");
  });

  it("steps aside for an enclosing lambda's parameter", () => {
    // `$.rows.map(x => x.items.filter({ a: x.b }))` — the inner rewrite may not
    // reuse `x`, or `x.b` would read the inner element.
    expect(freshParam("x", parseExpression("{ a: x.b }"))).toBe("x2");
  });
});
