// `.validate()` carries a meaningful `.pos` on every error class — tooling
// underlines the offending region from it, so a placeholder 0 defeats the
// contract. Each case names the source and the text the caret must land on.
import { describe, expect, it } from "vitest";
import { jsmql } from "../src/index.ts";

/**
 * The first error of an invalid source. Its `.pos` must be the offset of `at` in
 * the source (`""` means the end of the source), and never the placeholder 0.
 */
function firstError(src: string, at: string): { message: string; pos: number; code: string } {
  const result = jsmql.validate(src);
  expect(result.valid, `${src} should be invalid`).toBe(false);
  const e = result.errors[0];
  const want = at === "" ? src.length : src.indexOf(at);
  expect(want, `'${at}' occurs in ${src}`).toBeGreaterThan(0);
  expect(e.pos, `${src}: ${e.message}`).toBe(want);
  return e;
}

describe(".validate() carries a meaningful .pos on every error class", () => {
  it("lexer errors point at the offending character", () => {
    expect(firstError('$.name == "unterminated', '"').code).toBe("SYNTAX_ERROR");
    expect(firstError("$.age @ 18", "@").code).toBe("SYNTAX_ERROR");
  });

  it("parser errors point at the offending token", () => {
    expect(firstError("$. + 1", "+").code).toBe("SYNTAX_ERROR");
    expect(firstError("$.a >", "").code).toBe("SYNTAX_ERROR");
    const e = firstError("$.items.map(({ a = 1 }) => a)", "a = 1");
    expect(e.code).toBe("SYNTAX_ERROR");
    expect(e.message).toMatch(/A destructured parameter lists plain names only/);
  });

  it("codegen errors point at the node that failed", () => {
    expect(firstError("$.name.charAt()", ".charAt").code).toBe("CODEGEN_ERROR");
    const regex = firstError("$.name === /hello/", "/hello/");
    expect(regex.code).toBe("CODEGEN_ERROR");
    expect(regex.message).toMatch(/a regex literal is valid only as an argument of/);
    expect(firstError("$.age > minAge", "minAge").code).toBe("CODEGEN_ERROR");
    expect(firstError("$.age == 18", "==").code).toBe("CODEGEN_ERROR");
  });

  it("a stage in the wrong place points at that stage", () => {
    expect(firstError("[ { $merge: 'a' }, $sort({ x: 1 }) ]", "$sort").code).toBe("CODEGEN_ERROR");
  });

  it("function-input errors point into the arrow's source", () => {
    const restFn = ({ ...rest }, { $ }) => $.x;
    const rest = jsmql.validate(restFn as never);
    expect(rest.valid).toBe(false);
    expect(rest.errors[0].code).toBe("SYNTAX_ERROR");
    expect(rest.errors[0].pos).toBe(String(restFn).indexOf("..."));
    const generatorFn = function* ({ $ }) {
      yield $.x;
    };
    const generator = jsmql.validate(generatorFn as never);
    expect(generator.valid).toBe(false);
    expect(generator.errors[0].code).toBe("SYNTAX_ERROR");
    expect(generator.errors[0].pos).toBe(String(generatorFn).indexOf("*"));
  });

  it("chain links caret at the offending link, not the chain root", () => {
    firstError("$$.filter(p => p.a > 1).flat(1).take(2);", ".flat");
    firstError("$$.$match({ a: 1 }).$prject({ b: 1 });", ".$prject");
    firstError("$.n + $.items.every(x => x.ok).map(y => y)", ".map");
  });

  it("a read of another collection with no destination points at the read", () => {
    const e = firstError("$$$.myColl.find(o => o.x === $.y);", ".find");
    expect(e.code).toBe("CODEGEN_ERROR");
    expect(e.message).toMatch(/no destination/);
  });

  it("a template-tag slot error carries the slot instead of a position", () => {
    // The one documented exception to a real `.pos`: a template spans two arrays.
    const result = jsmql.validate`$.a == ${1} && $.b == ${undefined}`;
    expect(result.valid).toBe(false);
    expect(result.errors[0].pos).toBe(0);
    expect(result.errors[0].message).toMatch(/slot 2/);
  });
});
