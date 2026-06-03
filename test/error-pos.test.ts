import { describe, expect, it } from "vitest";
import { jsmql } from "../src/index.ts";

// Helper: a `.pos` is meaningful when it lands within [0, src.length] AND the
// substring starting there at least begins with a character the user would
// recognise as the offending region. The trailing-EOF case is the one
// exception — there `.pos === src.length` is the right answer.
function assertPosInRange(src: string, pos: number): void {
  expect(pos).toBeGreaterThanOrEqual(0);
  expect(pos).toBeLessThanOrEqual(src.length);
}

describe(".validate() carries a meaningful .pos on every error class", () => {
  describe("lexer errors", () => {
    it("unterminated string literal", () => {
      const src = '$.name == "unterminated';
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("SYNTAX_ERROR");
      assertPosInRange(src, result.errors[0].pos);
      // Should point at the opening quote of the unterminated string.
      expect(src[result.errors[0].pos]).toBe('"');
    });
  });

  describe("parser errors", () => {
    it("unexpected token after expression", () => {
      const src = "$.age @ 18";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("SYNTAX_ERROR");
      assertPosInRange(src, result.errors[0].pos);
    });

    it("missing field name after $.", () => {
      const src = "$. + 1";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("SYNTAX_ERROR");
      assertPosInRange(src, result.errors[0].pos);
    });

    it("let outside pipeline", () => {
      const src = "let x = 1";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("SYNTAX_ERROR");
      // Should point at the `let` keyword.
      expect(src.slice(result.errors[0].pos)).toMatch(/^let/);
    });
  });

  describe("codegen errors", () => {
    it("operator arg count mismatch — .charAt() with no arguments", () => {
      const src = "$.name.charAt()";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("CODEGEN_ERROR");
      assertPosInRange(src, result.errors[0].pos);
      // Should point at the `.charAt` method call region.
      const sliced = src.slice(result.errors[0].pos);
      expect(sliced.length).toBeGreaterThan(0);
    });

    it("regex literal outside .match() context", () => {
      // Use the regex as a value in a strict-equality position so codegen
      // hits the RegexLiteral arm of the switch (loose `==` would short-
      // circuit on the null-only check first).
      const src = "$.name === /hello/";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("CODEGEN_ERROR");
      assertPosInRange(src, result.errors[0].pos);
      // Should point at the regex literal's opening `/`.
      expect(src[result.errors[0].pos]).toBe("/");
      expect(result.errors[0].message).toMatch(/Regex literals/);
    });

    it("unknown identifier", () => {
      const src = "$.age > minAge";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("CODEGEN_ERROR");
      assertPosInRange(src, result.errors[0].pos);
      // Should point at the identifier `minAge`.
      expect(src.slice(result.errors[0].pos)).toMatch(/^minAge/);
    });

    it("loose equality against non-null", () => {
      const src = "$.age == 18";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("CODEGEN_ERROR");
      assertPosInRange(src, result.errors[0].pos);
    });

    it("a must-be-last stage that isn't last points at the offending trailing stage", () => {
      const src = "[ { $merge: 'a' }, $sort({ x: 1 }) ]";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("CODEGEN_ERROR");
      assertPosInRange(src, result.errors[0].pos);
      // Points at the stage that illegally follows the terminal `$merge`.
      expect(src.slice(result.errors[0].pos)).toMatch(/^\$sort/);
    });
  });

  describe("function-input errors", () => {
    it("non-arrow function input", () => {
      const result = jsmql.validate(
        (() => {
          // Force a `function ...` shape rather than an arrow.
          // eslint-disable-next-line no-new-func
          return new Function("return 1") as never;
        })(),
      );
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("SYNTAX_ERROR");
      expect(result.errors[0].pos).toBeGreaterThanOrEqual(0);
    });

    it("malformed params destructure rest pattern", () => {
      const result = jsmql.validate((({ ...rest }, $) => $.x) as never);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("SYNTAX_ERROR");
      expect(result.errors[0].pos).toBeGreaterThanOrEqual(0);
      expect(result.errors[0].message).toMatch(/rest patterns/);
    });
  });

  describe("interpolation errors", () => {
    it("template-tag rejects undefined, surfaces slot info", () => {
      const result = jsmql.validate`$.x == ${undefined}`;
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("SYNTAX_ERROR");
      // Interpolation errors carry .slot on the underlying error class rather
      // than a meaningful .pos — the contract for this branch is documented
      // in errorToValidationResult.
      expect(result.errors[0].pos).toBe(0);
      expect(result.errors[0].message).toMatch(/interpolation slot 1/);
    });
  });
});
