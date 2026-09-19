// Phase 3 of src/compiler/ — constant folding.
//
// THE INVARIANT: a fold must not change the answer. Whatever it computes must
// equal what the same expression computes on the server when it is left alone,
// or folding stops being an optimisation and becomes a second semantics. The
// live-mongod suite at the foot of this file holds that guarantee; the tests
// above it say what the pass is FOR.

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
    // Folding is not limited to a declaration's value: `$.x === 1 + 2` computes
    // the 3 once here rather than on every document the server reads.
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
    // The fold runs before the shorthand check, so the constant reaches the slot
    // and the shorthand reads as if it had been written literally.
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
    // Folding it away would lose the arity error, so the fold declines it.
    expect(valueOf('"abc".toUpperCase(1)')).toBe("(not constant)");
    expect(valueOf('"hello".charAt()')).toBe("(not constant)");
  });

  it("refuses rather than letting a built-in throw", () => {
    // A raw `RangeError` reaches the user with no position and no guidance.
    expect(valueOf('"hello".repeat(-1)')).toBe("(not constant)");
  });

  it("reads a predicate's answer the way the emitted condition does", () => {
    // The array lowering writes JavaScript's truthiness out as four `$ne`s, so a
    // predicate answering a plain value folds — measured against the server, both ways.
    expect(valueOf("[1, 2].some(x => 1)")).toBe(true);
    expect(valueOf('[1, 2].filter(x => "yes")')).toEqual([1, 2]);
    expect(valueOf('[0, 1, "", "a", null].filter(x => x)')).toEqual([1, "a"]);
  });

  it("rounds in DECIMAL, the way $round does", () => {
    // Scaling by `10 ** places` makes the rounding decision on a perturbed number:
    // `(2.675).round(2)` is 2.68 that way and 2.67 on the server, because 2.675 is
    // really 2.67499999999999982. Each of these is measured against mongod.
    expect(valueOf("(2.675).round(2)")).toBe(2.67);
    expect(valueOf("(1.005).round(2)")).toBe(1);
    expect(valueOf("(8.835).round(2)")).toBe(8.84);
    expect(valueOf("(99.995).round(2)")).toBe(100);
    expect(valueOf("(-2.675).round(2)")).toBe(-2.67);
    expect(valueOf("(12345).round(-2)")).toBe(12300);
    // a half goes to the EVEN neighbour, at any place
    expect(valueOf("(2.5).round()")).toBe(2);
    expect(valueOf("(-2.5).round()")).toBe(-2);
    // and a negative number rounding to zero answers -0, which has no literal spelling
    expect(valueOf("(-0.5).round()")).toBe("(not constant)");
    expect(valueOf("(-0.4).round()")).toBe("(not constant)");
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
    expect(valueOf('1 < "a"')).toBe("(not constant)"); // BSON orders across types
  });

  it("folds `&&` and `||` the way the LOWERING does, which is JavaScript's truthiness", () => {
    // Measured on the server: `0 || 5` is 5 there and `1 && 2` is 2, so the
    // boolean-only rule this once had refused the shape people actually write.
    expect(valueOf("0 || 5")).toBe(5);
    expect(valueOf('"" || "x"')).toBe("x");
    expect(valueOf("1 && 2")).toBe(2);
    expect(valueOf("0 && 5")).toBe(0);
    expect(valueOf("null || 5")).toBe(5);
  });

  it("compares structurally, the way `$eq` and `$in` do", () => {
    // Every literal here is a fresh object, so JavaScript's identity would answer
    // false for every structural comparison there is.
    expect(valueOf("[1, 2] === [1, 2]")).toBe(true);
    expect(valueOf("({ a: 1 }) === ({ a: 1 })")).toBe(true);
    expect(valueOf("[[1]].includes([1])")).toBe(true);
    expect(valueOf("[{ a: 1 }].indexOf({ a: 1 })")).toBe(0);
  });

  it("answers in CODE POINTS, because that is what MongoDB counts and orders by", () => {
    // JavaScript counts UTF-16 units, and the two part company above U+D7FF.
    expect(valueOf('"\u{1f600}a".indexOf("a")')).toBe(1);
    expect(valueOf('"\u{fb01}" < "\u{1f600}"')).toBe(true);
    // Padding by units both pads to the wrong width and can cut a character in
    // half, producing a string with no UTF-8 encoding at all.
    expect(valueOf('"\u{1f600}".padStart(2)')).toBe(" \u{1f600}".normalize());
    expect(valueOf('".".padStart(2, "\u{1f600}\u{1f600}")')).toBe("\u{1f600}.".normalize());
  });

  it("refuses what it cannot compute the way the server would", () => {
    // `-0` is a DOUBLE to the driver where the same arithmetic gives an int `0`.
    expect(valueOf("0 * -7")).toBe("(not constant)");
    // `$toString` of a double and JavaScript's own formatting differ on exponents.
    expect(valueOf("`${1e-7}`")).toBe("(not constant)");
    // An index the server cannot take as a 32-bit integer.
    expect(valueOf('"abc".charAt(1.5)')).toBe("(not constant)");
    expect(valueOf("[1, 2, 3].at(2.5)")).toBe("(not constant)");
    // `$concatArrays` takes arrays; JavaScript's `concat` takes anything.
    expect(valueOf("[1].concat(2)")).toBe("(not constant)");
  });

  it("stops before the stack does, and before the value gets absurd", () => {
    // A `RangeError` with no position is what every rule here takes care not to
    // produce, and half a gigabyte of string has no place in a query.
    const deep = Array.from({ length: 3000 }, () => "1").join("+");
    expect(valueOf(deep)).toBe("(not constant)");
    expect(valueOf('"x".padStart(500000000, "ab")')).toBe("(not constant)");
    expect(valueOf('"x".repeat(10000000)')).toBe("(not constant)");
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

describe("compiler/passes/fold — a constant date, and the named conversions", () => {
  it("answers in UTC and in JavaScript's numbering", () => {
    // A JavaScript spelling gets JavaScript's behaviour: `getMonth()` counts from
    // 0 and `getDay()` says 4 for a Thursday, as the runtime cells do over
    // `$month` and `$dayOfWeek`. The LOCAL-sounding getters read UTC, because
    // `$hour` does — one that read local time would answer differently on every machine.
    const d = 'new Date("2020-03-05T20:30:40.123Z")';
    expect(valueOf(`${d}.getMonth()`)).toBe(2);
    expect(valueOf(`${d}.getDay()`)).toBe(4);
    expect(valueOf(`${d}.getHours()`)).toBe(20);
    expect(valueOf(`${d}.getFullYear()`)).toBe(2020);
    expect(valueOf(`${d}.dayOfYear()`)).toBe(65);
    expect(valueOf(`${d}.quarter()`)).toBe(1);
  });

  it("counts the calendar-parts constructor's months from ZERO, as JavaScript does", () => {
    // `new Date(2020, 1, 1)` is February; `new Date(2024, 12, 1)` rolls over to January 2025.
    expect(valueOf("new Date(2020, 1, 1).getMonth()")).toBe(1);
    expect(valueOf("new Date(2024, 12, 1).getFullYear()")).toBe(2025);
    expect(valueOf("new Date(2024, 0, 15).getMonth()")).toBe(0);
    expect(valueOf("new Date(2020, 1, 1).getFullYear()")).toBe(2020);
  });

  it("never folds a date that reads the clock", () => {
    expect(valueOf("new Date()")).toBe("(not constant)");
    expect(valueOf("Date.now()")).toBe("(not constant)");
    // An unparseable string is an error the language raises with a position;
    // folding it to `Invalid Date` would swallow that.
    expect(valueOf('new Date("nope")')).toBe("(not constant)");
  });

  it("converts only where the server converts", () => {
    // never folded: `$toDouble("42")` is a double on the server; a written 42 is an int
    expect(valueOf('Number("42")')).toBe("(not constant)");
    // `$convert` with no `onError` fails on a string it cannot parse.
    expect(valueOf('Number("nope")')).toBe("(not constant)");
    // `$toString(null)` is null, not the four letters.
    expect(valueOf("String(null)")).toBe(null);
    // An integer below 10^16 is written digit for digit by `$toString` and by
    // JavaScript; from there the server uses an exponent where JavaScript does not,
    // a fraction's threshold differs, and `-0` keeps its sign on the server only.
    expect(valueOf("String(42)")).toBe("42");
    expect(valueOf("String(9999999999999998)")).toBe("9999999999999998");
    expect(valueOf("String(10000000000000000)")).toBe("(not constant)");
    expect(valueOf("String(2.5)")).toBe("(not constant)");
    expect(valueOf("String(-0)")).toBe("(not constant)");
    expect(valueOf("`id-${42}`")).toBe("id-42");
    expect(valueOf("`id-${1e16}`")).toBe("(not constant)");
    expect(valueOf("`id-${0.5}`")).toBe("(not constant)");
  });

  it("reads `new Set([…])` as the array, because that is what the language does", () => {
    // jsmql has no set type: the constructor is a way of writing an array that
    // the set operators then read, and it does NOT de-duplicate.
    expect(valueOf("new Set([1, 2, 2, 3])")).toEqual([1, 2, 2, 3]);
  });
});

describe("compiler/passes/fold — a date's arithmetic is the server's", () => {
  const iso = (src: string): unknown => {
    const v = valueOf(src);
    return v instanceof Date ? v.toISOString() : v;
  };

  it("clamps a calendar step to the target month's last day, as $dateAdd does", () => {
    expect(iso('new Date("2024-01-31T10:00:00Z").plus(1, "month")')).toBe("2024-02-29T10:00:00.000Z");
    expect(iso('new Date("2024-02-29T10:00:00Z").plus(1, "year")')).toBe("2025-02-28T10:00:00.000Z");
    expect(iso('new Date("2024-03-31T10:00:00Z").minus(1, "month")')).toBe("2024-02-29T10:00:00.000Z");
    expect(iso('new Date("2026-09-01T00:00:00Z").plus(36, "hour")')).toBe("2026-09-02T12:00:00.000Z");
  });

  it("starts the week on Sunday, as $dateTrunc does", () => {
    expect(iso('new Date("2026-09-16T13:45:30.123Z").startOf("week")')).toBe("2026-09-13T00:00:00.000Z");
    expect(iso('new Date("2026-11-16T00:00:00Z").startOf("quarter")')).toBe("2026-10-01T00:00:00.000Z");
    expect(iso('new Date("2026-09-16T13:45:30.123Z").endOf("month")')).toBe("2026-09-30T23:59:59.999Z");
  });

  it("counts the boundaries crossed, as $dateDiff does", () => {
    expect(valueOf('new Date("2026-02-01T00:01:00Z").diff(new Date("2026-01-31T23:59:00Z"), "day")')).toBe(1);
    expect(valueOf('new Date("2026-01-31T00:00:00Z").diff(new Date("2026-01-01T00:00:00Z"), "month")')).toBe(0);
    expect(valueOf('new Date("2026-09-13T01:00:00Z").diff(new Date("2026-09-12T23:00:00Z"), "week")')).toBe(1);
    expect(valueOf('new Date("2026-09-15T00:00:00Z").isSame(new Date("2026-09-01T00:00:00Z"), "month")')).toBe(true);
  });

  it("writes $dateToString's specifiers, and leaves one the server refuses", () => {
    expect(
      valueOf('new Date("2026-09-16T13:45:30.123Z").format("%Y-%m-%d %H:%M:%S.%L %j %w %u %U %V %G %z %Z %%")'),
    ).toBe("2026-09-16 13:45:30.123 259 4 3 37 38 2026 +0000 0 %");
    // `%e` is not a specifier the server knows, and `%b` is one the row does not
    // accept: either way the refusal must reach the developer, so neither folds.
    expect(valueOf('new Date("2026-09-16T13:45:30.123Z").format("%e")')).toBe("(not constant)");
    expect(valueOf('new Date("2026-09-16T13:45:30.123Z").format("%b")')).toBe("(not constant)");
    expect(valueOf('new Date("2026-09-16T13:45:30.123Z").format("%Y%")')).toBe("(not constant)");
  });

  it("rolls a part over as $dateFromParts does, and refuses what the server refuses", () => {
    expect(iso('new Date("2026-09-16T13:45:30.123Z").set({ month: 13, day: 0 })')).toBe("2026-12-31T13:45:30.123Z");
    expect(iso('new Date("2026-09-16T13:45:30.123Z").set({ isoWeek: 1, isoDayOfWeek: 1 })')).toBe(
      "2025-12-29T13:45:30.123Z",
    );
    // ISO and calendar parts mixed; a year the server has no date for; an unknown part
    expect(valueOf('new Date("2026-09-16T00:00:00Z").set({ isoWeek: 1, month: 3 })')).toBe("(not constant)");
    expect(valueOf('new Date("2026-09-16T00:00:00Z").set({ year: 10000 })')).toBe("(not constant)");
    expect(valueOf('new Date("2026-09-16T00:00:00Z").set({ week: 1 })')).toBe("(not constant)");
  });

  it("leaves every form that names a timezone or an option to the server", () => {
    const d = 'new Date("2026-09-16T13:45:30.123Z")';
    expect(valueOf(`${d}.plus(1, "month", "Europe/Kyiv")`)).toBe("(not constant)");
    expect(valueOf(`${d}.startOf("week", { startOfWeek: "monday" })`)).toBe("(not constant)");
    expect(valueOf(`${d}.diff(${d}, "day", "UTC")`)).toBe("(not constant)");
    expect(valueOf(`${d}.format("%Y", "UTC")`)).toBe("(not constant)");
    // a non-integer amount and a unit the server has no name for keep the row's refusals
    expect(valueOf(`${d}.plus(1.5, "day")`)).toBe("(not constant)");
    expect(valueOf(`${d}.plus(1, "days")`)).toBe("(not constant)");
  });

  it("reads an ObjectId's hex, and settles a constant computed key", () => {
    expect(valueOf("0x507f1f77bcf86cd799439011.toString()")).toBe("507f1f77bcf86cd799439011");
    expect(shape('const k = "a"; $sort({ [k]: 1 })')).toBe(shape("$sort({ a: 1 })"));
    expect(shape('const k = "a"; $match({ [k + "b"]: 1 })')).toBe(shape("$match({ ab: 1 })"));
  });
});

describe("compiler/passes/fold — a declared function called with constants", () => {
  /** The right-hand side of the trailing comparison, which is the use site. */
  const useSite = (src: string): string => {
    const t = desugar(parse(src)) as { type: string; stmts?: unknown[]; right?: unknown };
    const last = t.type === "Pipeline" ? (t.stmts as { right?: unknown }[])[(t.stmts as unknown[]).length - 1] : t;
    return JSON.stringify(last.right ?? last, (k, v) => (k === "pos" ? 0 : v));
  };
  const folds = (src: string, value: number): void => {
    expect(useSite(src)).toBe(JSON.stringify({ type: "NumberLiteral", value, pos: 0 }));
  };

  it("calls a `function` declaration", () => {
    folds("function f(x) { return x * 2 } const v = f(3); $.x === v", 6);
    folds("function f() { return 42 } $.x === f()", 42);
  });

  it("calls an arrow bound with `const`", () => {
    folds("const f = x => x * 2; $.x === f(3)", 6);
  });

  it("calls a lambda applied where it stands", () => {
    folds("$.x === ((a) => a * 2)(3)", 6);
  });

  it("calls one declared function from inside another", () => {
    folds("function f(x) { return x + 1 } function g(x) { return f(x) * 2 } $.x === g(3)", 8);
  });

  it("leaves a call whose argument is not constant", () => {
    expect(useSite("function f(x) { return x * 2 } $.x === f($.n)")).toContain("CallExpression");
  });

  it("does not substitute into a CALLEE, which names a function rather than valuing one", () => {
    // `const g = 3; g(1)` is a TypeError in JavaScript. Replacing `g` with 3
    // would leave `3(1)` in the tree, which is not a program — the name stays so
    // a later phase can say what is actually wrong.
    expect(useSite("const g = 3; $.x === g(1)")).toContain('"name":"g"');
    expect(useSite("const g = 3; $.x === new g(1)")).toContain('"name":"g"');
  });

  it("does not let a lambda parameter reach the outer function of that name", () => {
    expect(useSite("function f(x) { return x * 2 } $.a = $.items.map(f => f(1));")).toContain("CallExpression");
  });
});

describe("compiler/passes/fold — the folds the server contradicted", () => {
  it("reads one number in Date.UTC as a YEAR, as JavaScript and $dateFromParts do", () => {
    // `Date.UTC(2020)` is 1577836800000: one number is a YEAR, not a millisecond
    // count. `$toLong($dateFromParts{year:2020})` is what mongod answers, and the
    // fold has to match it rather than pass the 2020 through.
    const r = evaluate(parseExpression("Date.UTC(2020)"), new Map());
    expect(r).toEqual({ ok: true, value: Date.UTC(2020, 0) });
  });

  it("refuses to fold a numeric string the server refuses to parse", () => {
    // `$toDouble(" 12 ")` → "Failed to parse number"; `$toInt("0x10")` → "Illegal
    // hexadecimal input". JavaScript accepts both, so the fold must not.
    for (const src of ['Number(" 12 ")', 'Number("0x10")', 'Number("1_000")']) {
      expect(evaluate(parseExpression(src), new Map()).ok, src).toBe(false);
    }
    expect(evaluate(parseExpression('Number("12.5")'), new Map())).toEqual({ ok: false });
  });

  it("keeps a constant that evaluates to -0 as a runtime binding rather than throwing", () => {
    // -0 is a value the server computes (`$ceil: -0.5`), but one the driver would
    // send as a double where the same arithmetic gives an int 0 — so it is not
    // written, and not an error either.
    expect(() => desugar(parse("const x = 0 * -7; $.y === x"))).not.toThrow();
    expect(JSON.stringify(desugar(parse("const x = 0 * -7; $.y === x")))).toContain("LetDecl");
    expect(() => desugar(parse("const x = 1 / 0; $.y === x"))).toThrow(/Infinity/);
  });

  it("does not read a lambda parameter as a use of a later declaration", () => {
    // `k` inside the lambda is the lambda's own; the later `const k` is read only
    // by the second statement, and folds.
    const out = JSON.stringify(desugar(parse("$match($.items.some(k => k > 1)); const k = 5; $match($.y === k);")));
    expect(out).not.toContain("LetDecl");
  });
});
