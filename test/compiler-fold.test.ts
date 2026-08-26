// Phase 3 of src/compiler/ — constant folding.
//
// THE INVARIANT: a fold must not change the answer. Whatever it computes has to
// equal what the same expression computes on the server when it is left alone,
// or folding stops being an optimisation and becomes a second semantics. The
// live-mongod suite at the foot of this file is what actually holds that; the
// tests above it say what the pass is FOR.

import { describe, expect, it } from "vitest";
import { parse, parseExpression } from "../src/compiler/parse/parser.ts";
import { desugar } from "../src/compiler/passes/desugar.ts";
import { evaluate } from "../src/compiler/passes/evaluate.ts";
import { fold } from "../src/compiler/passes/fold.ts";
import { asLiteral, isSpellable } from "../src/compiler/passes/literal.ts";
import { shapeOf } from "../src/compiler/passes/shape.ts";

const EMPTY = new Map<string, unknown>();

/** The value an expression folds to, or the fact that it does not fold. */
const valueOf = (src: string): unknown => {
  const r = evaluate(parseExpression(src), EMPTY);
  return r.ok ? r.value : "(not constant)";
};

/** The whole program after folding and desugaring, with positions erased. */
const shape = (src: string): string => JSON.stringify(desugar(parse(src)), (k, v) => (k === "pos" ? 0 : v));

describe("compiler/passes/fold — a constant declaration becomes its value", () => {
  it("turns a computed constant into a Filter", () => {
    expect(shape("const msInDay = 24 * 60 * 60 * 1000; $.elapsedMs > msInDay")).toBe(shape("$.elapsedMs > 86400000"));
    expect(shapeOf(desugar(parse("const a = 1; $.x === a")))).toBe("filter");
  });

  it("folds a chain of declarations", () => {
    expect(shape("const base = 10; const doubled = base * 2; $.n < doubled")).toBe(shape("$.n < 20"));
  });

  it("folds a constant subexpression with no declaration in sight", () => {
    // The shipped compiler folds a declaration's value and nothing else, so
    // `$.x === 1 + 2` computes the 3 on every document it reads.
    expect(shape("$.x === 1 + 2")).toBe(shape("$.x === 3"));
    expect(shape("$.x === (1 in [1, 2])")).toBe(shape("$.x === true"));
  });

  it("reads a constant structure rather than reading it at run time", () => {
    // `{"$getField":{"field":"minAge","input":{"minAge":18}}}` cannot use an
    // index; `{"age":{"$gt":18}}` can.
    expect(shape("const CONFIG = { minAge: 18 }; $.age > CONFIG.minAge")).toBe(shape("$.age > 18"));
    expect(shape("const xs = [1, 2, 3]; $.x === xs[1]")).toBe(shape("$.x === 2"));
    expect(shape("const xs = [1, 2, 3]; $.x === xs.length")).toBe(shape("$.x === 3"));
  });

  it("feeds the desugar rules, which feed it back", () => {
    // The shipped compiler refuses this outright: the shorthand check runs
    // before the constant reaches the slot.
    expect(shape('const k = "name"; $.f = $.items.map(k);')).toBe(shape("$.f = $.items.map(x => x.name);"));
    expect(shape("const spec = { active: true }; $.f = $.items.filter(spec);")).toBe(
      shape("$.f = $.items.filter(x => x.active === true);"),
    );
  });
});

describe("compiler/passes/fold — a name that cannot be folded keeps its binding", () => {
  const stillDeclared = (src: string): boolean => {
    const t = fold(parse(src)) as { type: string; stmts?: { type: string }[] };
    return t.type === "Pipeline" && t.stmts?.some((s) => s.type === "LetDecl") === true;
  };

  it("keeps a binding whose value is not constant", () => {
    expect(stillDeclared("let a = $.n; $.x === a")).toBe(true);
  });

  it("keeps a binding that is written to afterwards", () => {
    expect(stillDeclared("let a = 1; a = 2; $.x === a")).toBe(true);
  });

  it("keeps a binding declared twice, so the redeclaration is still reported", () => {
    expect(stillDeclared("const a = 1; const a = 2; $.x === a")).toBe(true);
  });

  it("keeps a binding `Object.assign` mutates in place", () => {
    expect(stillDeclared("const o = { a: 1 }; Object.assign(o, { b: 2 }); $.x === o.a")).toBe(true);
  });

  it("does not substitute where a lambda parameter shadows the name", () => {
    // `x` inside is the ELEMENT. Substituting the constant there would answer
    // with 100 where the source meant each item.
    expect(shape("const x = 100; $.f = $.items.map(x => x + 1);")).toBe(shape("$.f = $.items.map(x => x + 1);"));
    // …but an unshadowed reference in the same position does fold.
    expect(shape("const x = 100; $.f = $.items.map(y => y + x);")).toBe(shape("$.f = $.items.map(y => y + 100);"));
  });
});

describe("compiler/passes/fold — what a fold may not produce", () => {
  it("refuses a value with no MongoDB literal", () => {
    expect(isSpellable(Infinity)).toBe(false);
    expect(isSpellable(NaN)).toBe(false);
    // `undefined` is what JavaScript answers for a read that found nothing, and
    // BSON has no such value: an array element becomes null and a key vanishes.
    expect(isSpellable(undefined)).toBe(false);
    expect(asLiteral([1, undefined], 0)).toBeNull();
    expect(asLiteral({ a: undefined }, 0)).toBeNull();
  });

  it("says so when a declaration computes one anyway", () => {
    expect(() => fold(parse("const n = 1 / 0; $.x === n"))).toThrow(/evaluates to Infinity/);
    expect(() => fold(parse("const n = 0 / 0; $.x === n"))).toThrow(/evaluates to NaN/);
  });

  it("leaves a read that found nothing to run at run time", () => {
    // `undefined` and MongoDB's MISSING are not the same thing downstream.
    expect(valueOf("[1, 2, 3].at(9)")).toBe("(not constant)");
    expect(valueOf('"abc".at(9)')).toBe("(not constant)");
    expect(valueOf("({ a: 1 }).missing")).toBe("(not constant)");
    expect(valueOf("[1][9]")).toBe("(not constant)");
    expect(valueOf("[1, 2].find(x => x > 9)")).toBe("(not constant)");
  });

  it("refuses a call whose argument count is wrong, so the error still happens", () => {
    // Folding it away is how the shipped compiler loses the arity error.
    expect(valueOf('"abc".toUpperCase(1)')).toBe("(not constant)");
    expect(valueOf('"hello".charAt()')).toBe("(not constant)");
  });

  it("refuses rather than letting a built-in throw", () => {
    // A raw `RangeError` reaches the user with no position and no guidance.
    expect(valueOf('"hello".repeat(-1)')).toBe("(not constant)");
  });

  it("refuses a predicate that does not answer with a boolean", () => {
    // JavaScript's truthiness and MongoDB's part company on `""` and `0`.
    expect(valueOf("[1, 2].some(x => 1)")).toBe("(not constant)");
    expect(valueOf('[1, 2].filter(x => "yes")')).toBe("(not constant)");
  });

  it("refuses arithmetic JavaScript cannot hold exactly", () => {
    // MongoDB multiplies two integers exactly, in 64 bits; JavaScript rounds.
    expect(valueOf("123456789 * 987654321")).toBe("(not constant)");
    expect(valueOf("9007199254740992 + 1")).toBe("(not constant)");
    // Within range it folds as usual.
    expect(valueOf("123456 * 654321")).toBe(80779853376);
  });

  it("refuses an operator whose two languages disagree", () => {
    expect(valueOf('"a" + 1')).toBe("(not constant)"); // $concat takes strings
    expect(valueOf("1 == 1")).toBe("(not constant)"); // loose equality coerces
    expect(valueOf("typeof 1")).toBe("(not constant)"); // $type has its own names
    expect(valueOf("true && 2")).toBe("(not constant)"); // $and answers a boolean
    expect(valueOf('1 < "a"')).toBe("(not constant)"); // BSON orders across types
  });

  it("leaves the escape hatch alone, so pasted MQL round-trips", () => {
    expect(valueOf("$add(1, 2)")).toBe("(not constant)");
  });
});

describe("compiler/passes/fold — what it computes is the LANGUAGE's answer", () => {
  it("folds case the way `$toUpper` does, which is ASCII only", () => {
    expect(valueOf('"aBc".toUpperCase()')).toBe("ABC");
    expect(valueOf('"Ä é".toUpperCase()')).toBe("Ä é");
    expect(valueOf('"ÀÉÎ".toLowerCase()')).toBe("ÀÉÎ");
  });

  it("rounds a half to the EVEN neighbour, which is what `$round` does", () => {
    expect(valueOf("(2.5).round()")).toBe(2);
    expect(valueOf("(3.5).round()")).toBe(4);
    expect(valueOf("Math.round(0.5)")).toBe(0);
  });

  it("counts a string in code points, which is what `$strLenCP` does", () => {
    expect(valueOf('"😀ab".length')).toBe(3);
    expect(valueOf('"😀ab"[0]')).toBe("😀");
  });

  it("reads `in` as membership, which is what the language means", () => {
    expect(valueOf("1 in [1, 2]")).toBe(true);
    expect(valueOf("3 in [1, 2]")).toBe(false);
  });

  it("folds only the Math functions whose result is exactly specified", () => {
    // IEEE-754 pins down sqrt and the algebraic operations, and leaves every
    // transcendental free. Measured against mongod, eleven of the twenty-nine
    // differ — so those run on the server, where the answer is the server's.
    expect(valueOf("Math.sqrt(16)")).toBe(4);
    expect(valueOf("Math.abs(-5)")).toBe(5);
    expect(valueOf("Math.max(3, 7)")).toBe(7);
    expect(valueOf("Math.PI")).toBe(Math.PI);
    expect(valueOf("Math.atanh(0.25)")).toBe("(not constant)");
    expect(valueOf("Math.cos(0.1)")).toBe("(not constant)");
    expect(valueOf("Math.log2(3)")).toBe("(not constant)");
  });

  it("folds `Object.entries` to the `{k, v}` documents `$objectToArray` gives", () => {
    expect(valueOf("Object.entries({ a: 1 })")).toEqual([{ k: "a", v: 1 }]);
    // `.toPairs()` is the one that answers with JavaScript's two-element arrays.
    expect(valueOf("({ a: 1 }).toPairs()")).toEqual([["a", 1]]);
  });

  it("does not fold a name the language does not have", () => {
    // Folding one would ADD it: `.lastIndexOf()` on a string is refused because
    // `$indexOfCP` only searches forward.
    expect(valueOf('"hello".lastIndexOf("l")')).toBe("(not constant)");
    expect(valueOf("Number.isFinite(4)")).toBe("(not constant)");
  });
});

describe("compiler/passes/fold — a scope is a scope, and a write is a write", () => {
  /** Does the program still declare anything? If so, nothing was folded away. */
  const keepsABinding = (src: string): boolean => {
    const t = desugar(parse(src)) as { type: string; stmts?: { type: string }[] };
    return JSON.stringify(t).includes('"LetDecl"');
  };

  it("does not push a constant through a nested statement scope", () => {
    // The inner `const a = 2` is a DIFFERENT variable. Reading the outer one
    // there answers 1 and leaves the inner declaration standing, unread.
    const t = JSON.stringify(desugar(parse("const a = 1; $$.aggregate(() => { const a = 2; $match({ b: a }) })")));
    expect(t).toContain('"value":2');
    expect(t).not.toContain('"value":1');
  });

  it("does not push a constant through a bracketed sub-pipeline", () => {
    expect(keepsABinding("const a = 1; [const a = 2, $match({ b: a })]")).toBe(true);
  });

  it("does not let one block declaration shadow another's outer name", () => {
    // `z` must be `x.n + 1`, per document — not the constant 2.
    expect(keepsABinding("const y = 1; $.a = $.items.map(x => { const y = x.n; const z = y + 1; return z })")).toBe(
      true,
    );
  });

  it("sees a write THROUGH a path, and never rewrites the place written to", () => {
    // `a.p = 9` changes `a`. Folding it would answer with the old value, and
    // substituting the target would produce `1 = 9`, which is not a program.
    for (const src of [
      "let a = { p: 1 }; a.p = 9; $.x === a.p",
      "let a = [1, 2]; a[0] = 9; $.x === a",
      "let a = { p: 1 }; delete a.p; $.x === a",
      "const a = { p: { q: 1 } }; Object.assign(a.p, { q: 2 }); $.x === a.p.q",
    ]) {
      expect(keepsABinding(src), src).toBe(true);
    }
  });

  it("sees a mutation that wears no `=`", () => {
    // A call that IS a statement mutates its receiver; nothing reads the result.
    for (const method of ["sort()", "reverse()", "push(9)", "unshift(9)", "splice(1,1)", "pop()", "shift()"]) {
      expect(keepsABinding(`const a = [3, 1, 2]; a.${method}; $.x === a`), method).toBe(true);
    }
  });

  it("does not answer a name read before it is declared", () => {
    // JavaScript throws a ReferenceError; answering with the later value would
    // invent a meaning the language does not have.
    expect(keepsABinding("$.x === a; const a = 1")).toBe(true);
  });

  it("says so when an unspellable value is buried in a structure", () => {
    // The same mistake as `const a = 1/0`, one level down.
    expect(() => desugar(parse("const a = [1 / 0]; $.x === a"))).toThrow(/evaluates to Infinity/);
    expect(() => desugar(parse("const a = { k: [0 / 0] }; $.x === a"))).toThrow(/evaluates to NaN/);
  });

  it("folds a nested scope in its own right", () => {
    const t = JSON.stringify(desugar(parse("$$.aggregate(() => { const n = 2 * 3; $match({ b: n }) })")));
    expect(t).toContain('"value":6');
    expect(t).not.toContain('"LetDecl"');
  });

  it("settles on a chain of any length", () => {
    const links = 40;
    const src =
      Array.from({ length: links }, (_, i) => `const v${i} = ${i === links - 1 ? "1" : `v${i + 1} + 1`};`)
        .reverse()
        .join(" ") + " $.x === v0";
    expect(() => desugar(parse(src))).not.toThrow();
  });

  it("routes a receiver by what the LANGUAGE allows, not by its JavaScript type", () => {
    // A RegExp and a BSON value are objects to JavaScript. Reading one with the
    // object rules answers about the wrong thing: `/ab/.size()` would be
    // `Object.keys(regex).length`, which is 0 and means nothing.
    expect(valueOf("/ab/.size()")).toBe("(not constant)");
    expect(valueOf("/ab/.pick(['source'])")).toBe("(not constant)");
    expect(valueOf("(0x507f1f77bcf86cd799439011).size()")).toBe("(not constant)");
    expect(valueOf("({ a: 1 }).size()")).toBe(1);
  });
});
