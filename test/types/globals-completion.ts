import "../../src/globals.ts";
import { jsmql } from "../../src/index.ts";

const _pipeline: object[] = jsmql(({ $ }) => {
  $match($.age > 18);
  $limit(5);
});
const _either: object | object[] = jsmql(({ $ }) => $.age > 18);
const _fromString: object | object[] = jsmql("$.age > 18");
void [_pipeline, _either, _fromString];

const _stream = $$.filter((d) => d.active)
  .reject((d) => d.hidden)
  .sortBy("createdAt")
  .take(3)
  .map("userId")
  .uniqBy("x");
void _stream;

const _staged = $$.filter((d) => d.active)
  .$sort({ score: -1 })
  .$limit(10)
  .map((d) => d.userId);
void _staged;
$$.$sort({ score: -1 }).$out("archive");

declare const input: any;
$trim(input, " ");
$trim({ input, chars: " " });
$unwind("$items");
$size(1, 2);

declare const $: any;

const _count: number = $$.length;
const _orderCount: number = $$$.orders.filter((o) => o.userId === $._id).length;
const _revenue: number = $$$.orders.filter((o) => o.ok).sum();
const _newest = $$$.orders.filter((o) => o.userId === $._id).head();
void [_count, _orderCount, _revenue, _newest];

const _user = $$$.users.find((u) => u.id === $._id);
const _email = $$$.users.find((u) => u.id === $._id).email;
const _biggest = $$$.orders.filter((o) => o.ok).find((o) => o.big);
void _biggest;
const _byRegion = $$$.orders
  .$match({ ok: true })
  .$group({ _id: "$region" })
  .map((g) => g._id);
void [_user, _email, _byRegion];
$$$.archive = $$;
$$$.archive = $$.filter((d) => d.active);
$$.push(...$$$.other);

declare const nums: number[];
const _sum: number = nums.sum();
const _chunks: number[][] = nums.chunk(2);
const _first: number = nums.head();
const _byParity: Record<string, number[]> = nums.groupBy((x) => x % 2);
const _topNums: number[] = nums.uniq().sortBy().takeRight(3);
const _histogram: Record<string, number> = nums.countBy();
const _byValue: Record<string, number[]> = nums.groupBy();
const _keyed: Record<string, number> = nums.keyBy();
void [_sum, _chunks, _first, _byParity, _topNums, _histogram, _byValue, _keyed];
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

declare const byId: Record<string, Order>;
const _seeded: Order[] = Object.values(byId).uniq().take(3);
void _seeded;

declare const placedAt: Date;
const _month: string = placedAt.startOf("month").plus(3, "day").format("%Y-%m-%d");
const _hours: number = placedAt.diff(new Date(), "hour");
const _q: number = placedAt.quarter();
const _sameDay: boolean = placedAt.isSame(new Date(), "day");
const _reset: Date = placedAt.set({ year: 2030, month: 1 }).endOf("day");
const _iso: Date = placedAt.set({ isoWeekYear: 2030, isoWeek: 5 });
const _bounded: Date = placedAt.clamp(new Date(), new Date());
const _inYear: boolean = placedAt.startOf("day").inRange(new Date(), new Date());
const _epoch: number = placedAt.getTime();
const _isoStr: string = placedAt.toISOString();
void [_month, _hours, _q, _sameDay, _reset, _iso, _bounded, _inYear, _epoch, _isoStr];

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
const _notNarrowed: object[] = jsmql(({ $ }) => $.age > 18);
void _notNarrowed;

declare const anyVal: any;
const _loose = anyVal.uniq().whatever.clamp(0, 1) > 0;
void _loose;

$sum($.price);
$sum($multiply($.price, $.qty));
$add($.a, new Date());
$cond({ if: $.qty >= 250, then: 30, else: 20 });
$cond($.qty >= 250, 30, 20);
$dateAdd({ startDate: $.t, unit: "day", amount: 1 });
$sum("text");

type First3<T> = T extends { (...a: infer A): any; (...b: any): any; (...c: any): any } ? A : never;
type First2<T> = T extends { (...a: infer A): any; (...b: any): any } ? A : never;
const _sumHint: First3<typeof $sum> = [1];
// @ts-expect-error — the hint for `$sum` takes a number, not a string.
const _sumHintBad: First3<typeof $sum> = ["text"];
const _addHint: First2<typeof $add> = [1, new Date()];
// @ts-expect-error — the hint for `$add` takes a number or a date, not a string.
const _addHintBad: First2<typeof $add> = [1, "text"];
const _substrHint: First2<typeof $substrCP> = ["abc", 0, 1];
// @ts-expect-error — the hint for the `$substrCP` start takes a number, not a boolean.
const _substrHintBad: First2<typeof $substrCP> = ["abc", true, 1];
const _dateAddHint: First2<typeof $dateAdd> = [{ startDate: new Date(), unit: "day", amount: 1 }];
// @ts-expect-error — the hint for the `$dateAdd` amount takes a number, not a string.
const _dateAddHintBad: First2<typeof $dateAdd> = [{ startDate: new Date(), unit: "day", amount: "1" }];
void [_sumHint, _sumHintBad, _addHint, _addHintBad, _substrHint, _substrHintBad, _dateAddHint, _dateAddHintBad];
