// Type-level regression test for `@koresar/jsmql/globals` code completion.
//
// Compiled (noEmit, strict) by test/types/tsconfig.json, which test/smoke.test.ts
// drives through `tsc`. This file NEVER runs — every reference is type-only. Its
// job is to lock in the completion surface: the positive lines must type-check,
// and every `@ts-expect-error` line asserts that a member is REALLY typed (a typo
// or wrong-type call errors), proving the surface isn't silently `any`. If a
// future edit drops a member or widens it to `any`, an @ts-expect-error stops
// firing and `tsc` fails the build.
//
// See docs/specs/globals-generation.md § Value-method augmentations.
import "../../src/globals.ts";

// ── Stream methods on the `$$` collection ref ────────────────────────────────
// `$$` is an ambient `var $$: JsmqlCollectionRef`; every method returns the ref,
// so a chain stays completable. `.reject` is the special-cased complement of
// `.filter` (it bypasses the STREAM_METHODS registry) — guard it explicitly.
const _stream = $$.filter((d) => d.active)
  .reject((d) => d.hidden)
  .sortBy("createdAt")
  .take(3)
  .map("userId")
  .uniqBy("x");
void _stream;
// Note: a *typo* on a stream method (`$$.rejct(...)`) does NOT error here — the
// ref interfaces end in a `[key: string]: any` permissive tail (they carry more
// syntax than their named members — `$$ = …`, `$out` writes, member access on a
// materialised result; see globals-generation.md), so unknown members resolve to
// `any`. jsmql's parser catches the typo at compile time instead. Value-method
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
// EXTENDS the foreign ref, which is what lets one index type serve both — TS
// resolves a target's named members against the source's declared members, never
// through its index signature, so the shared base is load-bearing, not cosmetic.
const _user = $$$.users.find((u) => u.id === $._id);
const _email = $$$.users.find((u) => u.id === $._id).email;
// A chain keeps the identity of its ROOT, which is the rule jsmql enforces:
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
// Every one of these was a TS2339 false positive before `interface Date` was
// augmented — the code compiled in jsmql and was underlined in the editor.
declare const placedAt: Date;
const _month: string = placedAt.startOf("month").plus(3, "day").format("%Y-%m-%d");
const _hours: number = placedAt.diff(new Date(), "hour");
const _q: number = placedAt.quarter();
const _sameDay: boolean = placedAt.isSame(new Date(), "day");
const _reset: Date = placedAt.set({ year: 2030, month: 1 }).endOf("day");
const _iso: Date = placedAt.set({ isoWeekYear: 2030, isoWeek: 5 });
// `.clamp` is the one dual-receiver method — a number OR a date, result following
// the receiver.
const _bounded: Date = placedAt.clamp(new Date(), new Date());
// Native members still resolve to lib.d.ts's own declarations.
const _epoch: number = placedAt.getTime();
const _isoStr: string = placedAt.toISOString();
void [_month, _hours, _q, _sameDay, _reset, _iso, _bounded, _epoch, _isoStr];

// ── Negatives: completion is real, not `any` ─────────────────────────────────
// @ts-expect-error — typo on a typed array chain must error.
nums.uniq().chunkz(2);
// @ts-expect-error — an array method must not exist on a string result.
label.capitalize().uniq();
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

// ── Permissiveness intact: a bare `any` receiver still type-checks ────────────
// jsmql keeps `$.field` as `any` so operator forms work; value methods on it are
// therefore uncompletable but must NOT error (this line has no @ts-expect-error).
declare const anyVal: any;
const _loose = anyVal.uniq().whatever.clamp(0, 1) > 0;
void _loose;
