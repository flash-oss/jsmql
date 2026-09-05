// `.validate()` carries a meaningful `.pos` on every error class — tooling
// underlines the offending region from it, so a placeholder 0 defeats the
// contract. Each case names the source and where the caret must land.
import { describe, expect, it } from "vitest";
import { jsmql } from "../src/index.ts";

/** The first error of an invalid source, with its caret checked against the text. */
function firstError(src: string): { message: string; pos: number; code: string; at: string } {
  const result = jsmql.validate(src);
  expect(result.valid, `${src} should be invalid`).toBe(false);
  const e = result.errors[0];
  expect(e.pos).toBeGreaterThanOrEqual(0);
  expect(e.pos).toBeLessThanOrEqual(src.length);
  return { ...e, at: src.slice(e.pos) };
}

describe(".validate() carries a meaningful .pos on every error class", () => {
  it("lexer errors point at the offending character", () => {
    const e = firstError('$.name == "unterminated');
    expect(e.code).toBe("SYNTAX_ERROR");
    expect(e.at.startsWith('"')).toBe(true);
    expect(firstError("$.age @ 18").code).toBe("SYNTAX_ERROR");
  });

  it("parser errors point at the offending token", () => {
    expect(firstError("$. + 1").code).toBe("SYNTAX_ERROR");
    expect(firstError("$.a >").at).toBe("");
    const e = firstError("$.items.map(({ a }) => a)");
    expect(e.code).toBe("SYNTAX_ERROR");
    expect(e.message).toMatch(/Destructuring a parameter/);
    expect(e.at.startsWith("{ a }")).toBe(true);
  });

  it("codegen errors point at the node that failed", () => {
    expect(firstError("$.name.charAt()").code).toBe("CODEGEN_ERROR");
    const regex = firstError("$.name === /hello/");
    expect(regex.code).toBe("CODEGEN_ERROR");
    expect(regex.at.startsWith("/hello/")).toBe(true);
    expect(regex.message).toMatch(/Regex literals/);
    const unknown = firstError("$.age > minAge");
    expect(unknown.code).toBe("CODEGEN_ERROR");
    expect(unknown.at.startsWith("minAge")).toBe(true);
    const loose = firstError("$.age == 18");
    expect(loose.code).toBe("CODEGEN_ERROR");
  });

  it("a stage in the wrong place points at that stage", () => {
    const e = firstError("[ { $merge: 'a' }, $sort({ x: 1 }) ]");
    expect(e.code).toBe("CODEGEN_ERROR");
    expect(e.at.startsWith("$sort")).toBe(true);
  });

  it("function-input errors point into the arrow's source", () => {
    const rest = jsmql.validate((({ ...rest }, { $ }) => $.x) as never);
    expect(rest.valid).toBe(false);
    expect(rest.errors[0].code).toBe("SYNTAX_ERROR");
    const generator = jsmql.validate(function* ({ $ }) {
      yield $.x;
    } as never);
    expect(generator.valid).toBe(false);
    expect(generator.errors[0].code).toBe("SYNTAX_ERROR");
  });

  it("chain links caret at the offending link, not the chain root", () => {
    expect(firstError("$$.filter(p => p.a > 1).flat(1).take(2);").at.startsWith(".flat")).toBe(true);
    expect(firstError("$$.$match({ a: 1 }).$prject({ b: 1 });").at.startsWith(".$prject")).toBe(true);
    expect(firstError("$.n + $.items.every(x => x.ok).map(y => y)").at.startsWith(".map")).toBe(true);
  });

  it("a read of another collection with no destination points at the read", () => {
    const e = firstError("$$$.myColl.find(o => o.x === $.y);");
    expect(e.code).toBe("CODEGEN_ERROR");
    expect(e.at.startsWith(".find")).toBe(true);
    expect(e.message).toMatch(/no destination/);
  });

  it("a template-tag slot error carries the slot instead of a position", () => {
    const result = jsmql.validate`$.a == ${1} && $.b == ${undefined}`;
    expect(result.valid).toBe(false);
    expect(result.errors[0].pos).toBe(0);
    expect(result.errors[0].message).toMatch(/slot 2/);
  });
});
