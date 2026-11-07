// Type-level regression test for `@koresar/jsmql/globals` code completion.
//
// Compiled (noEmit, strict) by test/types/tsconfig.json, which test/smoke.test.ts
// drives through `tsc`. This file NEVER runs — every reference is type-only. Its
// job is to lock in the completion surface: the positive lines must type-check,
// and every `@ts-expect-error` line asserts that a member is REALLY typed (a typo
// or wrong-type call errors). This proves the surface is not silently `any`. If a
// future edit drops a member or widens it to `any`, an @ts-expect-error stops
// firing and `tsc` fails the build.
//
// See docs/specs/globals-generation.md § Value-method augmentations.
import "../../src/globals.ts";
import { jsmql } from "../../src/index.ts";

// ── `jsmql()` narrows its return type for a block-bodied arrow ───────────────
// A statement block is always a Pipeline, and its arrow returns `void` — the one
// shape TypeScript can read off the input, so the one that narrows to `object[]`.
const _pipeline: object[] = jsmql(({ $ }) => {
  $match($.age > 18);
  $limit(5);
});
// Everything else keeps the full union, because nothing else settles the shape.
// An expression arrow may be either (`$.age > 18` is a Filter, `$$.filter(…)` is
// a Pipeline), and a string is opaque.
const _either: object | object[] = jsmql(({ $ }) => $.age > 18);
const _fromString: object | object[] = jsmql("$.age > 18");
void [_pipeline, _either, _fromString];

// ── Stream methods on the `$$` collection ref ────────────────────────────────
// `$$` is an ambient `var $$: JsmqlStreamRef`; every method returns the ref,
// so a chain stays completable. `.reject` is the special-cased complement of
// `.filter` (it bypasses the STREAM_METHODS registry) — guard it explicitly.
const _stream = $$.filter((d) => d.active)
  .reject((d) => d.hidden)
  .sortBy("createdAt")
  .take(3)
  .map("userId")
  .uniqBy("x");
void _stream;
// Note: a *typo* on a stream method (`$$.rejct(...)`) does NOT error here.
// The ref interfaces end in a `[key: string]: any` permissive tail. They carry more
// syntax than their named members — `$$ = …`, `$out` writes, member access on a
// materialised result (see globals-generation.md). So unknown members resolve to
// `any`. The parser of jsmql catches the typo at compile time instead. The value-method
// interfaces below have no such tail, so their typo negatives DO fire.

// ── Chained stage calls ──────────────────────────────────────────────────────
// Every non-diagnostic stage is a chain member returning the ref, so stage links
// and stream methods interleave and the chain stays completable throughout.
const _staged = $$.filter((d) => d.active)
  .$sort({ score: -1 })
  .$limit(10)
  .map((d) => d.userId);
void _staged;
$$.$sort({ score: -1 }).$out("archive");

// ── A `$` call never errors ──────────────────────────────────────────────────
// A `$op(…)` or `$stage(…)` call is your own MQL (HR2), so the compiler takes it with
// any arguments. Each name carries a catch-all overload after its documented
// signatures. The positional form of an object-form operator, a string stage body,
// and a count that the server refuses all type-check.
declare const input: any;
$trim(input, " ");
$trim({ input, chars: " " });
$unwind("$items");
$size(1, 2);

// The document root is NOT an ambient global — it reaches the body through the
// arrow's toolbox destructure (`({ $ }) => …`), typed `any` there. Stand in for
// that here so the correlated forms below read the way real source does.
declare const $: any;

// ── A stream is also an array where it genuinely is one ──────────────────────
// `$$.length` is the stream's document count, and a foreign chain in value
// position materialises into a real array, so its value terminals carry types.
const _count: number = $$.length;
const _orderCount: number = $$$.orders.filter((o) => o.userId === $._id).length;
const _revenue: number = $$$.orders.filter((o) => o.ok).sum();
const _newest = $$$.orders.filter((o) => o.userId === $._id).head();
void [_count, _orderCount, _revenue, _newest];

// ── The foreign ref: reads complete, and the `$out` write still assigns ──────
// `$$$.<coll>` is both a read head and an `$out` write target. The collection ref
// EXTENDS the foreign ref, which lets one index type serve both. TS
// resolves the named members of a target against the declared members of the source, never
// through its index signature. So the shared base is load-bearing, not cosmetic.
const _user = $$$.users.find((u) => u.id === $._id);
const _email = $$$.users.find((u) => u.id === $._id).email;
// A chain keeps the identity of its ROOT. This is the rule that jsmql enforces.
// `.find` is legal at ANY position of a foreign chain, and at NO position of a
// current-stream chain (the negative for that is at the bottom of this file).
const _biggest = $$$.orders.filter((o) => o.ok).find((o) => o.big);
void _biggest;
const _byRegion = $$$.orders
  .$match({ ok: true })
  .$group({ _id: "$region" })
  .map((g) => g._id);
void [_user, _email, _byRegion];
$$$.archive = $$;
$$$.archive = $$.filter((d) => d.active);
// A stream spreads into `.push`, so the refs are iterable as far as TS is concerned.
$$.push(...$$$.other);

// ── Value methods on concretely-typed receivers → completion + chaining ──────
// This is the whole point: once a value has a real (array/string/number) type,
// jsmql's lodash value-methods complete and their return types keep the chain
// typed. A bare `$.field` is `any` and stays `any` (tested at the bottom).
declare const nums: number[];
const _sum: number = nums.sum();
const _chunks: number[][] = nums.chunk(2);
const _first: number = nums.head(); // element type preserved
const _byParity: Record<string, number[]> = nums.groupBy((x) => x % 2);
const _topNums: number[] = nums.uniq().sortBy().takeRight(3);
// No-iteratee (identity) forms of the object-collapse family type-check too.
const _histogram: Record<string, number> = nums.countBy();
const _byValue: Record<string, number[]> = nums.groupBy();
const _keyed: Record<string, number> = nums.keyBy();
void [_sum, _chunks, _first, _byParity, _topNums, _histogram, _byValue, _keyed];
// The set operations are array methods: an array of values, or a boolean for a relation.
declare const more: number[];
const _union: number[] = nums.union(more);
const _common: number[] = nums.intersection(more).difference([0]);
const _related: boolean = nums.isSubsetOf(more) && nums.isSupersetOf(more) && nums.isDisjointFrom(more);
const _oneSide: number[] = nums.symmetricDifference(more).xor(more);
void [_union, _common, _related, _oneSide];

interface Order {
  total: number;
  sku: string;
}
declare const orders: Order[];
const _skus: string[] = orders
  .sortBy("total")
  .takeRight(3)
  .map((o) => o.sku)
  .uniq();
const _grouped: Record<string, Order[]> = orders.groupBy("sku");
const _best: Order = orders.maxBy("total");
void [_skus, _grouped, _best];

declare const label: string;
const _cased: string = label.capitalize().camelCase();
const _words: string[] = label.words();
void [_cased, _words];

declare const price: number;
const _clamped: number = price.clamp(0, 100).round(2);
const _within: boolean = price.inRange(0, 10);
void [_clamped, _within];

// Typed static seed — no schema annotation needed to start a chain.
declare const byId: Record<string, Order>;
const _seeded: Order[] = Object.values(byId).uniq().take(3);
void _seeded;

// ── Date: jsmql's non-native date vocabulary on a real `Date` receiver ───────
// Without the augmentation of `interface Date`, each of these is a TS2339 false
// positive. jsmql compiles the code, but the editor underlines it.
declare const placedAt: Date;
const _month: string = placedAt.startOf("month").plus(3, "day").format("%Y-%m-%d");
const _hours: number = placedAt.diff(new Date(), "hour");
const _q: number = placedAt.quarter();
const _sameDay: boolean = placedAt.isSame(new Date(), "day");
const _reset: Date = placedAt.set({ year: 2030, month: 1 }).endOf("day");
const _iso: Date = placedAt.set({ isoWeekYear: 2030, isoWeek: 5 });
// `.clamp` and `.inRange` are the dual-receiver methods — a number OR a date;
// `.clamp`'s result follows its receiver.
const _bounded: Date = placedAt.clamp(new Date(), new Date());
const _inYear: boolean = placedAt.startOf("day").inRange(new Date(), new Date());
// Native members still resolve to lib.d.ts's own declarations.
const _epoch: number = placedAt.getTime();
const _isoStr: string = placedAt.toISOString();
void [_month, _hours, _q, _sameDay, _reset, _iso, _bounded, _inYear, _epoch, _isoStr];

// ── Negatives: completion is real, not `any` ─────────────────────────────────
// @ts-expect-error — typo on a typed array chain must error.
nums.uniq().chunkz(2);
// @ts-expect-error — an array method must not exist on a string result.
label.capitalize().uniq();
// @ts-expect-error — a set relation is a boolean, not an array.
nums.isSubsetOf(more).uniq();
// @ts-expect-error — a string method must not exist on a number result.
price.clamp(0, 1).capitalize();
// @ts-expect-error — a value method must not leak onto an object result.
orders.groupBy("sku").chunk(2);
// @ts-expect-error — a typo on a date method must error.
placedAt.startOff("day");
// @ts-expect-error — `unit` is the closed MQL timeUnit set, not a bare string.
placedAt.startOf("fortnight");
// @ts-expect-error — the zero-argument accessors take nothing (jsmql rejects it too).
placedAt.getFullYear("UTC");
// @ts-expect-error — a date method must not exist on a string result.
placedAt.format("%Y").quarter();
// @ts-expect-error — `.find` is not a stream method; a pipeline is an array.
$$.find((d) => d.a);
// @ts-expect-error — and not at any later position of a `$$` chain either.
$$.filter((d) => d.a).find((d) => d.b);
// @ts-expect-error — an expression arrow must NOT narrow: it may lower to either
// shape, so the union stays and is not assignable to `object[]`. This is the pair
// to the positive above — together they prove the narrowing is real and targeted.
const _notNarrowed: object[] = jsmql(({ $ }) => $.age > 18);
void _notNarrowed;

// ── Permissiveness intact: a bare `any` receiver still type-checks ────────────
// jsmql keeps `$.field` as `any` so operator forms work; value methods on it are
// therefore uncompletable but must NOT error (this line has no @ts-expect-error).
declare const anyVal: any;
const _loose = anyVal.uniq().whatever.clamp(0, 1) > 0;
void _loose;

// ── The documented overload types each argument from the MQL spec ────────────
// Signature help and hover read the FIRST overload, so it carries the type that the
// spec says the argument must resolve to. A field ref and a nested `$op(…)` are `any`,
// so they fit every typed parameter. See globals-generation.md § Type mapping.
$sum($.price);
$sum($multiply($.price, $.qty));
$add($.a, new Date());
$cond({ if: $.qty >= 250, then: 30, else: 20 });
$cond($.qty >= 250, 30, 20);
$dateAdd({ startDate: $.t, unit: "day", amount: 1 });
// A wrong literal still type-checks: the catch-all overload takes it (a `$` call never errors).
$sum("text");

// `Parameters<>` reads the LAST overload, the catch-all. These helpers read the FIRST
// overload. The lines below test the hint, not the catch-all.
type First3<T> = T extends { (...a: infer A): any; (...b: any): any; (...c: any): any } ? A : never;
type First2<T> = T extends { (...a: infer A): any; (...b: any): any } ? A : never;
// Single: `$sum(expression)`.
const _sumHint: First3<typeof $sum> = [1];
// @ts-expect-error — the hint for `$sum` takes a number, not a string.
const _sumHintBad: First3<typeof $sum> = ["text"];
// Variadic: `$add(...expression)`.
const _addHint: First2<typeof $add> = [1, new Date()];
// @ts-expect-error — the hint for `$add` takes a number or a date, not a string.
const _addHintBad: First2<typeof $add> = [1, "text"];
// Positional: `$substrCP(string, start, length)`. Each position carries its own type.
const _substrHint: First2<typeof $substrCP> = ["abc", 0, 1];
// @ts-expect-error — the hint for the `$substrCP` start takes a number, not a boolean.
const _substrHintBad: First2<typeof $substrCP> = ["abc", true, 1];
// Object: `$dateAdd({ startDate, unit, amount, timezone })`.
const _dateAddHint: First2<typeof $dateAdd> = [{ startDate: new Date(), unit: "day", amount: 1 }];
// @ts-expect-error — the hint for the `$dateAdd` amount takes a number, not a string.
const _dateAddHintBad: First2<typeof $dateAdd> = [{ startDate: new Date(), unit: "day", amount: "1" }];
void [_sumHint, _sumHintBad, _addHint, _addHintBad, _substrHint, _substrHintBad, _dateAddHint, _dateAddHintBad];
