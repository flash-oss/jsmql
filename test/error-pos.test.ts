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

    it("non-key expression in object literal points at the offending token and guides to conditional spread", () => {
      // A bare ternary/field-ref as an object entry is invalid JS; the error
      // must name the token, list the valid entry forms, and point at the
      // conditional-spread fix. `.pos` and the in-message position must agree.
      const src = "$set({ ...$.base, $.flag == null ? {} : { x: 1 } })";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("SYNTAX_ERROR");
      // Should point at the `$.` that can't begin an object key.
      expect(src.slice(result.errors[0].pos)).toMatch(/^\$\.flag/);
      expect(result.errors[0].message).toMatch(/An object entry must be/);
      expect(result.errors[0].message).toMatch(/conditionally, spread a ternary/);
      // `.pos` and the position embedded in the message must be the same.
      const inMsg = Number((result.errors[0].message.match(/at position (\d+)/) ?? [])[1]);
      expect(inMsg).toBe(result.errors[0].pos);
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
    it("unsupported function shape (generator) carries a meaningful .pos", () => {
      // Plain `function (…) { return … }` inputs are accepted now (they lower
      // exactly like the arrow form); a generator is still unsupported and must
      // surface a positioned SYNTAX_ERROR.
      const result = jsmql.validate(function* ({ $ }) {
        return $.age > 18;
      } as never);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("SYNTAX_ERROR");
      expect(result.errors[0].pos).toBeGreaterThanOrEqual(0);
    });

    it("malformed params destructure rest pattern", () => {
      const result = jsmql.validate((({ ...rest }, { $ }) => $.x) as never);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("SYNTAX_ERROR");
      expect(result.errors[0].pos).toBeGreaterThanOrEqual(0);
      expect(result.errors[0].message).toMatch(/rest patterns/);
    });
  });

  // Every chain link carries its own source offset, so a chain error carets at
  // the offending call instead of at the chain root.
  describe("chain links caret at the offending call", () => {
    it("an unknown stream method points at that method, not at `$$`", () => {
      const src = "$$.filter(p => p.a > 1).uniq().take(2);";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      assertPosInRange(src, result.errors[0].pos);
      expect(src.slice(result.errors[0].pos)).toMatch(/^uniq/);
    });

    it("a type-incompatible receiver points at the call that produced it", () => {
      const src = "$.n + $.items.every(x => x.ok).map(y => y)";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(src.slice(result.errors[0].pos)).toMatch(/^every/);
    });

    // …but an error about the whole context-ref construct still points at the
    // `$$$` prefix, not at whichever link happens to be outermost.
    it("a context-ref mode error still points at the `$$$` prefix", () => {
      const src = "$$$.myColl.find(o => o.x === $.y)";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toMatch(/requires Pipeline mode/);
      expect(result.errors[0].pos).toBe(0);
    });
  });

  // A stage link carries its OWN source offset (the parser stamps `member.pos`
  // rather than the historical chain-root `left.pos`), so a long chain carets
  // at the offending link instead of at `$$`.
  describe("chained stage call errors", () => {
    it("unknown stage name points at the stage link, not the chain root", () => {
      const src = "$$.$match({ a: 1 }).$prject({ b: 1 });";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("CODEGEN_ERROR");
      assertPosInRange(src, result.errors[0].pos);
      expect(src.slice(result.errors[0].pos)).toMatch(/^\$prject/);
    });

    it("arity error points at the offending link", () => {
      const src = "$$.$sort({ a: 1 }).$limit(5, 6);";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      assertPosInRange(src, result.errors[0].pos);
      expect(src.slice(result.errors[0].pos)).toMatch(/^\$limit/);
    });

    it("bare `.$stage` with no call is a syntax error at the stage", () => {
      const src = "$$.$match";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("SYNTAX_ERROR");
      assertPosInRange(src, result.errors[0].pos);
      expect(src.slice(result.errors[0].pos)).toMatch(/^\$match/);
    });

    it("value-position stage link points at the link", () => {
      const src = "$.out = $.items.$match({ a: 1 });";
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("CODEGEN_ERROR");
      assertPosInRange(src, result.errors[0].pos);
      expect(src.slice(result.errors[0].pos)).toMatch(/^\$match/);
    });

    // A write stage in a sub-pipeline is rejected twice over: the
    // `GenerateCtx.inSubPipeline` guard reports the offending stage's own body,
    // and `assertNoWriteStageInSubPipeline` re-checks the assembled stages but
    // can only name the enclosing pipeline. Pinning the body position here is
    // what makes a lowering path that never sets the flag show up as a failure —
    // the rejection survives on the backstop, the precise position does not.
    it("a write stage in a sub-pipeline points at the offending stage, not the pipeline", () => {
      const src = '$.t = $$$.orders.aggregate(o => { $out("archive"); });';
      const result = jsmql.validate(src);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe("CODEGEN_ERROR");
      expect(result.errors[0].message).toMatch(/not allowed inside a '\$lookup' sub-pipeline/);
      assertPosInRange(src, result.errors[0].pos);
      expect(src.slice(result.errors[0].pos)).toMatch(/^"archive"/);
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
