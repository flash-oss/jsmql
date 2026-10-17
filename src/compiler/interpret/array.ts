// The array operators.
//
// A read that finds no element is MISSING on the server, and no literal spells
// missing, so such a read is a refusal. A null array gives a null answer for most
// operators. Where the measured server answer for a null is an error, the rule
// refuses. A set operator gives each value once, at its first position: the
// server does not specify the order of a set, so the interpreter keeps the order of first
// occurrence, and one input then always gives one answer.

import type { Answer, Rule, Walk } from "./values.ts";
import {
  MAX_SIZE,
  NO,
  NumberText,
  compareValues,
  inert,
  isInt32,
  isPlain,
  isWellFormed,
  keyOf,
  kindOf,
  ok,
  sameValue,
  spellable,
  startsLikeNumber,
  truthOf,
} from "./values.ts";
import { evalAll, isVariableName, keyed, positional } from "./operand.ts";

const isArray = (v: unknown): v is unknown[] => Array.isArray(v);

/** Does every value of the list hold nothing opaque? A rule compares only such a value. */
const allInert = (...lists: readonly unknown[][]): boolean => lists.every((l) => l.every(inert));

/** Each value once, in the order of first occurrence. */
function unique(xs: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const key = keyOf(x);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const has = (xs: readonly unknown[], v: unknown): boolean => xs.some((x) => sameValue(x, v));

/** The values of a list, as the strings that make two equal values equal. */
const keysOf = (xs: readonly unknown[]): Set<string> => new Set(xs.map(keyOf));

// ── one element ──────────────────────────────────────────────────────

const size = positional(1, 1, ([xs]) => (isArray(xs) ? ok(xs.length) : NO), true);

const arrayElemAt = positional(2, 2, ([xs, index]) => {
  if (xs !== null && !isArray(xs)) return NO;
  if (index === null || xs === null) return index === null || isInt32(index) ? ok(null) : NO;
  if (!isInt32(index)) return NO;
  const at = index < 0 ? xs.length + index : index;
  return at >= 0 && at < xs.length ? ok(xs[at]) : NO;
});

const end = (which: "first" | "last"): Rule =>
  positional(1, 1, ([xs]) => {
    if (xs === null) return ok(null);
    if (!isArray(xs) || xs.length === 0) return NO;
    return ok(which === "first" ? xs[0] : xs[xs.length - 1]);
  });

/** `$firstN` and `$lastN` take a keyed operand. The count is at least 1. */
const ends = (which: "first" | "last"): Rule =>
  keyed(["n", "input"], [], (parts, walk) => {
    const n = walk.at(parts.n);
    if (!n.ok) return n;
    const input = walk.at(parts.input);
    if (!input.ok) return input;
    if (!isInt32(n.value) || n.value < 1 || !isArray(input.value)) return NO;
    return ok(which === "first" ? input.value.slice(0, n.value) : input.value.slice(-n.value));
  });

const slice = positional(2, 3, ([xs, a, b]) => {
  if (xs !== null && !isArray(xs)) return NO;
  if (!isInt32(a) || (b !== undefined && !(isInt32(b) && b > 0))) return NO;
  if (xs === null) return ok(null);
  if (b === undefined) return ok(a >= 0 ? xs.slice(0, a) : xs.slice(a));
  const start = a < 0 ? Math.max(xs.length + a, 0) : a;
  return ok(xs.slice(start, start + b));
});

// ── a new array ────────────────────────────────────────────────────────

// A list of sets has the unspecified order of each set. So the result is a set answer when every
// operand is one, or is empty. A set beside a list that holds elements is a refusal: the position of
// each element then depends on the set.
const concatArrays = positional(
  0,
  Infinity,
  (xs, _, walk) => {
    if (!xs.every((x) => x === null || isArray(x))) return NO;
    if (xs.includes(null)) return ok(null);
    const lists = xs as unknown[][];
    const marked = lists.some((l) => walk.isSet(l));
    if (marked && !lists.every((l) => l.length === 0 || walk.isSet(l))) return NO;
    const out = lists.flat(1);
    return ok(marked ? walk.markSet(out) : out);
  },
  true,
);

const reverseArray = positional(1, 1, ([xs]) => {
  if (xs === null) return ok(null);
  return isArray(xs) ? ok([...xs].reverse()) : NO;
});

const range = positional(2, 3, ([from, to, step = 1]) => {
  if (![from, to, step].every(isInt32) || step === 0) return NO;
  const f = from as number;
  const t = to as number;
  const s = step as number;
  const count = s > 0 ? Math.ceil((t - f) / s) : Math.ceil((f - t) / -s);
  if (count > MAX_SIZE) return NO;
  return ok(Array.from({ length: Math.max(0, count) }, (_, i) => f + i * s));
});

// ── search ────────────────────────────────────────────────────────────────

// The order of the list does not matter to `$in`, but the order inside each value does.
const inRule = positional(
  2,
  2,
  ([needle, xs], _, walk) => {
    if (needle instanceof NumberText) {
      return isArray(xs) && xs.every((x) => typeof x === "string" && !startsLikeNumber(x)) ? ok(false) : NO;
    }
    if (!isArray(xs) || !allInert(xs) || !inert(needle)) return NO;
    if (walk.holdsSet(needle) || xs.some((x) => walk.holdsSet(x))) return NO;
    return ok(has(xs, needle));
  },
  true,
);

const indexOfArray = positional(2, 4, ([xs, needle, from = 0, to]) => {
  if (xs !== null && !isArray(xs)) return NO;
  if (!isInt32(from) || from < 0 || (to !== undefined && !(isInt32(to) && to >= 0))) return NO;
  if (xs === null) return ok(null);
  if (!allInert(xs) || !inert(needle)) return NO;
  const stop = Math.min(to === undefined ? xs.length : to, xs.length);
  for (let i = from; i < stop; i++) if (sameValue(xs[i], needle)) return ok(i);
  return ok(-1);
});

const isArrayRule = positional(1, 1, ([v]) => ok(isArray(v)), true);

const truthEvery = (every: boolean): Rule =>
  positional(
    1,
    1,
    ([xs]) => {
      if (!isArray(xs)) return NO;
      const truths = xs.map(truthOf);
      if (truths.includes(null)) return NO;
      return ok(every ? truths.every(Boolean) : truths.some(Boolean));
    },
    true,
  );

// ── the callback operators ───────────────────────────────────────────────────

/** The name that `as` gives to the element. The default is `this`. */
function elementName(parts: Record<string, unknown>): string | null {
  const name = "as" in parts ? parts.as : "this";
  return isVariableName(name) ? name : null;
}

/**
 * Evaluate `input`: a null gives a null answer, and an array gives its elements. An operator that
 * reads no position of the array sets `anyOrder`, and may then be given a set answer.
 */
function inputOf(walk: Walk, node: unknown, anyOrder = false): Answer {
  const input = anyOrder ? walk.raw(node) : walk.at(node);
  if (!input.ok) return input;
  return input.value === null || isArray(input.value) ? input : NO;
}

const map = keyed(["input", "in"], ["as"], (parts, walk) => {
  const name = elementName(parts);
  const input = inputOf(walk, parts.input, true);
  if (name === null || !input.ok) return input.ok ? NO : input;
  if (input.value === null) return ok(null);
  const out: unknown[] = [];
  for (const element of input.value as unknown[]) {
    const a = walk.raw(parts.in, { [name]: element });
    if (!a.ok) return a;
    out.push(a.value);
  }
  // Each element maps by itself, so the answer has the order of the input.
  return ok(walk.isSet(input.value) ? walk.markSet(out) : out);
});

const filter = keyed(["input", "cond"], ["as", "limit"], (parts, walk) => {
  const name = elementName(parts);
  const input = inputOf(walk, parts.input, true);
  if (name === null || !input.ok) return input.ok ? NO : input;
  let limit = Infinity;
  if ("limit" in parts) {
    const l = walk.at(parts.limit);
    if (!l.ok) return l;
    // A null limit means no limit. Any other limit is a positive 32-bit integer.
    if (l.value !== null) {
      if (!isInt32(l.value) || l.value < 1) return NO;
      limit = l.value;
    }
  }
  if (input.value === null) return ok(null);
  // A limit keeps the first elements, so it reads the order.
  if (limit !== Infinity && walk.isSet(input.value)) return NO;
  const out: unknown[] = [];
  for (const element of input.value as unknown[]) {
    const a = walk.raw(parts.cond, { [name]: element });
    if (!a.ok) return a;
    const t = truthOf(a.value);
    if (t === null) return NO;
    if (t && out.length < limit) out.push(element);
  }
  return ok(walk.isSet(input.value) ? walk.markSet(out) : out);
});

const reduce = keyed(["input", "initialValue", "in"], [], (parts, walk) => {
  const input = inputOf(walk, parts.input);
  if (!input.ok) return input;
  const start = walk.raw(parts.initialValue);
  if (!start.ok) return start;
  if (input.value === null) return ok(null);
  let value = start.value;
  for (const element of input.value as unknown[]) {
    const a = walk.raw(parts.in, { value, this: element });
    if (!a.ok) return a;
    value = a.value;
  }
  return ok(value);
});

const zip = keyed(["inputs"], ["useLongestLength", "defaults"], (parts, walk) => {
  if (!isArray(parts.inputs) || parts.inputs.length === 0) return NO;
  const longest = "useLongestLength" in parts ? parts.useLongestLength : false;
  if (typeof longest !== "boolean") return NO;
  const defaults = parts.defaults;
  if ("defaults" in parts && (!longest || !isArray(defaults) || defaults.length !== parts.inputs.length)) return NO;
  const lists = evalAll(walk, parts.inputs);
  if (!lists.ok) return lists;
  const filler = isArray(defaults) ? evalAll(walk, defaults) : ok(parts.inputs.map(() => null));
  if (!filler.ok) return filler;
  const columns = lists.value as unknown[];
  if (columns.includes(null)) return ok(null);
  if (!columns.every(isArray)) return NO;
  const arrays = columns as unknown[][];
  const width = longest ? Math.max(...arrays.map((l) => l.length)) : Math.min(...arrays.map((l) => l.length));
  const fill = filler.value as unknown[];
  return spellable(Array.from({ length: width }, (_, i) => arrays.map((l, j) => (i < l.length ? l[i] : fill[j]))));
});

// ── sort order ──────────────────────────────────────────────────────────────────

/** The value at a dotted path, one segment at a time. Nothing is there unless every step is a document. */
function readPath(doc: unknown, path: string): unknown {
  let cursor: unknown = doc;
  for (const segment of path.split(".")) {
    if (!isPlain(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

const SORTABLE = new Set(["number", "string", "boolean"]);

/** Do the keys have one sortable kind, and no string that a surrogate pair puts out of byte order? */
const oneSortableKind = (keys: readonly unknown[]): boolean =>
  keys.every((k) => SORTABLE.has(kindOf(k)) && kindOf(k) === kindOf(keys[0])) &&
  keys.every((k) => typeof k !== "string" || isWellFormed(k));

/** The input in a stable order of its keys. A tie keeps the order of the input, ascending or descending. */
function sortedBy(items: readonly unknown[], columns: readonly (readonly unknown[])[], directions: readonly number[]) {
  const order = items.map((_, i) => i);
  order.sort((i, j) => {
    for (const [c, column] of columns.entries()) {
      const sign = compareValues(column[i], column[j]) as number;
      if (sign !== 0) return sign * directions[c];
    }
    return i - j;
  });
  return order.map((i) => items[i]);
}

// The output order is specified, so the answer is no set answer, even when the input is one. A tie keeps
// the input order, so the input may be a set answer only when each tie holds equal elements.
/** Does each group of elements with one key hold equal elements? Then the order of a tie shows nowhere. */
function tiesAreEqual(items: readonly unknown[], columns: readonly (readonly unknown[])[]): boolean {
  const first = new Map<string, unknown>();
  for (const [i, item] of items.entries()) {
    const key = columns.map((c) => keyOf(c[i])).join("|");
    if (!first.has(key)) first.set(key, item);
    else if (!sameValue(first.get(key), item)) return false;
  }
  return true;
}

const sortArray = keyed(["input", "sortBy"], [], (parts, walk) => {
  const input = inputOf(walk, parts.input, true);
  if (!input.ok) return input;
  if (input.value === null) return ok(null);
  const items = input.value as unknown[];
  const by = parts.sortBy;
  if (by === 1 || by === -1) {
    // A list of scalars: the element is its own key.
    if (items.length > 0 && !oneSortableKind(items)) return NO;
    return ok(sortedBy(items, [items], [by]));
  }
  if (!isPlain(by) || Object.keys(by).length === 0) return NO;
  const fields = Object.entries(by);
  if (!fields.every(([, d]) => d === 1 || d === -1)) return NO;
  const columns = fields.map(([path]) => items.map((item) => readPath(item, path)));
  if (!items.every(isPlain) || !columns.every(oneSortableKind)) return NO;
  if (walk.isSet(items) && !tiesAreEqual(items, columns)) return NO;
  return ok(
    sortedBy(
      items,
      columns,
      fields.map(([, d]) => d as number),
    ),
  );
});

/** `$maxN` and `$minN` skip null, and take the n greatest or the n least of a list of one kind. */
const extremes = (greatest: boolean): Rule =>
  keyed(["input", "n"], [], (parts, walk) => {
    const input = walk.at(parts.input);
    const n = walk.at(parts.n);
    if (!input.ok) return input;
    if (!n.ok) return n;
    if (!isArray(input.value) || !isInt32(n.value) || n.value < 1) return NO;
    const kept = input.value.filter((v) => v !== null);
    if (kept.length > 0 && !oneSortableKind(kept)) return NO;
    const sorted = sortedBy(kept, [kept], [greatest ? -1 : 1]);
    return ok(sorted.slice(0, n.value));
  });

// ── the set operators ────────────────────────────────────────────────────────

/**
 * A set operator over lists: every operand is an array, or one is null and the answer is null.
 * The order of an operand does not matter, but the order inside an element does.
 * An operator that answers a list answers a set, so the answer is recorded as one.
 */
function overSets(
  min: number,
  max: number,
  run: (sets: unknown[][]) => unknown,
  { nullGivesNull = true, answersSet = true } = {},
): Rule {
  return positional(
    min,
    max,
    (xs, _, walk) => {
      if (nullGivesNull && xs.includes(null)) return xs.every((x) => x === null || isArray(x)) ? ok(null) : NO;
      if (!xs.every(isArray) || !allInert(...(xs as unknown[][]))) return NO;
      if ((xs as unknown[][]).some((set) => set.some((x) => walk.holdsSet(x)))) return NO;
      const answer = run(xs as unknown[][]);
      return spellable(answersSet ? walk.markSet(answer as unknown[]) : answer);
    },
    true,
  );
}

const sameSet = (a: readonly unknown[], b: readonly unknown[]): boolean => {
  const left = keysOf(a);
  const right = keysOf(b);
  return left.size === right.size && [...left].every((k) => right.has(k));
};

export const ARRAY: Record<string, Rule> = {
  $size: size,
  $arrayElemAt: arrayElemAt,
  $first: end("first"),
  $last: end("last"),
  $firstN: ends("first"),
  $lastN: ends("last"),
  $slice: slice,
  $concatArrays: concatArrays,
  $reverseArray: reverseArray,
  $range: range,
  $in: inRule,
  $indexOfArray: indexOfArray,
  $isArray: isArrayRule,
  $map: map,
  $filter: filter,
  $reduce: reduce,
  $zip: zip,
  $sortArray: sortArray,
  $maxN: extremes(true),
  $minN: extremes(false),
  $allElementsTrue: truthEvery(true),
  $anyElementTrue: truthEvery(false),
  $setUnion: overSets(0, Infinity, (sets) => unique(sets.flat(1))),
  $setIntersection: overSets(0, Infinity, (sets) => {
    const others = sets.slice(1).map(keysOf);
    return sets.length === 0 ? [] : unique(sets[0]).filter((v) => others.every((s) => s.has(keyOf(v))));
  }),
  $setDifference: overSets(2, 2, ([a, b]) => {
    const drop = keysOf(b);
    return unique(a).filter((v) => !drop.has(keyOf(v)));
  }),
  $setEquals: overSets(2, Infinity, (sets) => sets.slice(1).every((s) => sameSet(sets[0], s)), {
    nullGivesNull: false,
    answersSet: false,
  }),
  $setIsSubset: overSets(
    2,
    2,
    ([a, b]) => {
      const within = keysOf(b);
      return a.every((v) => within.has(keyOf(v)));
    },
    { nullGivesNull: false, answersSet: false },
  ),
};
