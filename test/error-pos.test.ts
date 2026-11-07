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

  it("a typeof comparison points at the type name it refuses", () => {
    expect(firstError('typeof $.a === "number"', '"number"').code).toBe("CODEGEN_ERROR");
    expect(firstError('!("boolean" === typeof $.a)', '"boolean"').code).toBe("CODEGEN_ERROR");
    expect(firstError('typeof $.a in ["int", "undefined"]', '"undefined"').code).toBe("CODEGEN_ERROR");
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
    firstError("$$.$match({ a: 1 }).prject({ b: 1 });", ".prject");
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

describe("a thrown error and .validate() agree on .pos", () => {
  it("`.compile(string)` counts from the first character of the string, blank lead included", () => {
    const src = "  ({ x }, { $ }) => $.a.foo(x)";
    let thrown: { pos?: number } = {};
    try {
      jsmql.compile(src)({ x: 1 });
    } catch (e) {
      thrown = e as { pos?: number };
    }
    expect(thrown.pos).toBe(src.indexOf(".foo"));
    expect(jsmql.validate(src).errors[0].pos).toBe(src.indexOf(".foo"));
  });

  it("frames an error once, in the source of the entry that threw it", () => {
    // The parameter's `toBSON()` runs inside the outer entry, and calls an inner one.
    const v = { toBSON: () => jsmql.expr("$.a.foo()") };
    let message = "";
    try {
      jsmql.compile("({ v }, { $ }) => $.x === v")({ v });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.match(/at line \d+, column \d+/g)).toEqual(["at line 1, column 4"]);
    expect(message).toContain("1 | $.a.foo()");
    expect(message).not.toContain("$.x === v");
  });
});
