// The arithmetic operators.
//
// The answer of a rule here is the answer of JavaScript's own double arithmetic,
// where MongoDB computes the same result. The two differ in three places, and each
// place is a refusal or a named answer:
//   - An integer result beyond 2^53: MongoDB is exact in 64 bits, a double is not. Refuse.
//   - A `-0`: the server answers an int 0 where a double has `-0`. Refuse.
//   - NaN and an infinity: MongoDB errors, or answers a value with no literal. Unspellable.
// `$add` and `$multiply` fold from left to right, as JavaScript does, with any count of
// fractions: a randomized test on the server gave the same bits. `$sum` and `$avg`
// do not: they use a compensated sum (see accumulate.ts).

import type { Answer, Rule } from "./values.ts";
import { NO, isInt32, losesPrecision, ok, reduceToPlaces, spellable, unspellable } from "./values.ts";
import { positional } from "./operand.ts";

const isNumber = (v: unknown): v is number => typeof v === "number";

/** A null operand makes the answer null. Any other operand that is not a number is a refusal. */
function numbersOrNull(xs: readonly unknown[]): readonly number[] | null | undefined {
  if (!xs.every((x) => isNumber(x) || x === null)) return undefined;
  return xs.includes(null) ? null : (xs as number[]);
}

/**
 * A rule over numeric operands with a null rule: any null gives null, and any other
 * kind is a refusal. `fold` combines the numbers.
 */
function numeric(min: number, max: number, fold: (ns: readonly number[]) => Answer): Rule {
  return positional(min, max, (xs) => {
    const ns = numbersOrNull(xs);
    if (ns === undefined) return NO;
    return ns === null ? ok(null) : fold(ns);
  });
}

/** One operation that folds a list into one value, from left to right. */
function chain(identity: number, step: (acc: number, n: number) => number): Rule {
  return numeric(0, Infinity, (ns) => {
    let acc = identity;
    for (const n of ns) {
      const next = step(acc, n);
      if (losesPrecision(next, acc, n)) return NO;
      acc = next;
    }
    return spellable(acc);
  });
}

const subtract = numeric(2, 2, ([a, b]) => {
  const r = a - b;
  return losesPrecision(r, a, b) ? NO : spellable(r);
});

// `$divide` answers a double, so no integer is there to be exact about. A divisor of
// zero gives an infinity or NaN, which the server refuses and no literal spells.
const divide = numeric(2, 2, ([a, b]) => spellable(a / b));

const mod = numeric(2, 2, ([a, b]) => spellable(a % b));

/** `a ** b` for integers only. A non-integer exponent is a transcendental function, and a negative one is not exact. */
const pow = numeric(2, 2, ([a, b]) => {
  if (!Number.isSafeInteger(a) || !Number.isInteger(b) || b < 0) return NO;
  if (Math.abs(a) <= 1) return spellable(a ** b);
  const sign = a < 0 && b % 2 === 1 ? "-Infinity" : "Infinity";
  // 2 ** 2000 is far above the largest double, so the power need not be computed.
  if (b > 2000) return unspellable(sign);
  const exact = BigInt(a) ** BigInt(b);
  const wide = Number(exact);
  if (Number.isSafeInteger(wide)) return ok(wide);
  return Number.isFinite(wide) ? NO : unspellable(sign);
});

const unary = (f: (n: number) => number): Rule => numeric(1, 1, ([n]) => spellable(f(n)));

/** `$round` and `$trunc` take an optional place count, between -20 and 100. */
function rounding(mode: "half-even" | "toward-zero"): Rule {
  return positional(1, 2, ([n, place]) => {
    if (n !== null && !isNumber(n)) return NO;
    if (place !== undefined && !(isInt32(place) && place >= -20 && place <= 100)) return NO;
    if (n === null) return ok(null);
    const result = reduceToPlaces(n, place ?? 0, mode);
    // A 32-bit integer that rounds past the 32-bit range wraps around on the server.
    if (isInt32(n) && !isInt32(result)) return NO;
    return spellable(result);
  });
}

/** The bitwise operators take integers that a 32-bit integer holds, where JavaScript and MongoDB agree. */
function bitwise(combine: (a: number, b: number) => number): Rule {
  return positional(1, Infinity, (xs) => {
    if (!xs.every(isInt32)) return NO;
    return ok((xs as number[]).reduce(combine));
  });
}

export const ARITHMETIC: Record<string, Rule> = {
  $add: chain(0, (a, b) => a + b),
  $subtract: subtract,
  $multiply: chain(1, (a, b) => a * b),
  $divide: divide,
  $mod: mod,
  $pow: pow,
  $sqrt: unary(Math.sqrt),
  $abs: unary(Math.abs),
  $ceil: unary(Math.ceil),
  $floor: unary(Math.floor),
  $trunc: rounding("toward-zero"),
  $round: rounding("half-even"),
  $bitAnd: bitwise((a, b) => a & b),
  $bitOr: bitwise((a, b) => a | b),
  $bitXor: bitwise((a, b) => a ^ b),
  $bitNot: positional(1, 1, ([n]) => (isInt32(n) ? ok(~n) : NO)),
};
