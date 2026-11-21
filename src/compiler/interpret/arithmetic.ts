import type { Answer, Rule } from "./values.ts";
import { NO, isInt32, losesPrecision, ok, reduceToPlaces, spellable, unspellable } from "./values.ts";
import { positional } from "./operand.ts";

const isNumber = (v: unknown): v is number => typeof v === "number";

function numbersOrNull(xs: readonly unknown[]): readonly number[] | null | undefined {
  if (!xs.every((x) => isNumber(x) || x === null)) return undefined;
  return xs.includes(null) ? null : (xs as number[]);
}

function numeric(min: number, max: number, fold: (ns: readonly number[]) => Answer): Rule {
  return positional(min, max, (xs) => {
    const ns = numbersOrNull(xs);
    if (ns === undefined) return NO;
    return ns === null ? ok(null) : fold(ns);
  });
}

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

const divide = numeric(2, 2, ([a, b]) => spellable(a / b));

const mod = numeric(2, 2, ([a, b]) => spellable(a % b));

const pow = numeric(2, 2, ([a, b]) => {
  if (!Number.isSafeInteger(a) || !Number.isInteger(b) || b < 0) return NO;
  if (Math.abs(a) <= 1) return spellable(a ** b);
  const sign = a < 0 && b % 2 === 1 ? "-Infinity" : "Infinity";
  if (b > 2000) return unspellable(sign);
  const exact = BigInt(a) ** BigInt(b);
  const wide = Number(exact);
  if (Number.isSafeInteger(wide)) return ok(wide);
  return Number.isFinite(wide) ? NO : unspellable(sign);
});

const unary = (f: (n: number) => number): Rule => numeric(1, 1, ([n]) => spellable(f(n)));

function rounding(mode: "half-even" | "toward-zero"): Rule {
  return positional(1, 2, ([n, place]) => {
    if (n !== null && !isNumber(n)) return NO;
    if (place !== undefined && !(isInt32(place) && place >= -20 && place <= 100)) return NO;
    if (n === null) return ok(null);
    const result = reduceToPlaces(n, place ?? 0, mode);
    if (isInt32(n) && !isInt32(result)) return NO;
    return spellable(result);
  });
}

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
