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

const allInert = (...lists: readonly unknown[][]): boolean => lists.every((l) => l.every(inert));

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

const keysOf = (xs: readonly unknown[]): Set<string> => new Set(xs.map(keyOf));

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

function elementName(parts: Record<string, unknown>): string | null {
  const name = "as" in parts ? parts.as : "this";
  return isVariableName(name) ? name : null;
}

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
    if (l.value !== null) {
      if (!isInt32(l.value) || l.value < 1) return NO;
      limit = l.value;
    }
  }
  if (input.value === null) return ok(null);
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

function readPath(doc: unknown, path: string): unknown {
  let cursor: unknown = doc;
  for (const segment of path.split(".")) {
    if (!isPlain(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

const SORTABLE = new Set(["number", "string", "boolean"]);

const oneSortableKind = (keys: readonly unknown[]): boolean =>
  keys.every((k) => SORTABLE.has(kindOf(k)) && kindOf(k) === kindOf(keys[0])) &&
  keys.every((k) => typeof k !== "string" || isWellFormed(k));

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
