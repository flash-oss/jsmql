// lodash array methods — the value-mode vocabulary over an array inside a document.
//
// The family splits by what a method does with its argument. Half take a lodash ITERATEE
// (`.sumBy`, `.keyBy`, `.uniqBy`, …) or a PREDICATE (`.partition`, `.takeWhile`, …), which
// arrives already resolved through `LowerInput.iteratee` / `.predicate`; the rest take a
// plain value or nothing at all. Both halves build their MQL from the shared shapes in
// `src/mql-array.ts`.
//
// ORDER is deliberately not preserved where MongoDB's set operators are the smaller answer.
// Nobody writes an ordering when they write `.uniq()`, and SR2 in docs/LANG_RULES.md says a
// guarantee the developer never wrote gives way to MongoDB's behaviour. Each such site says
// so, and `test/parity.test.ts` compares element-wise rather than sequence-wise for exactly
// this reason.
//
// NOT YET HERE: the JavaScript CALLBACK methods (`.map`, `.filter`, `.reduce`, `.some`, …).
// Their callbacks take up to three parameters (element, index, array) and the index form
// iterates a `$zip`, so lowering one needs a body context the compiler builds — a bigger
// service than a resolved iteratee. The ratchet in `test/methods-grid.test.ts` counts them.
//
// See docs/specs/lowering-grid.md.

import {
  distinctKeysExpr,
  iterateeKeys,
  jsBool,
  reverseArrayOf,
  singleArrayArg,
  stringKeyExpr,
  takeDropWhile,
  uniqByReduce,
} from "../mql-array.ts";
import type { MethodDef } from "./types.ts";

/** `.sum()` / `.mean()` / `.max()` / `.min()`: one accumulator each, over the receiver. */
function reducer(operator: string, returns?: "number"): MethodDef {
  return {
    receiver: "array",
    ...(returns === undefined ? {} : { returns }),
    args: { sig: "", none: true },
    value: ({ recv }) => ({ [operator]: recv }),
  };
}

/** `.sumBy(iteratee)` / `.meanBy(iteratee)`: the same accumulator over the mapped keys. */
function reducerBy(operator: "$sum" | "$avg"): MethodDef {
  return {
    receiver: "array",
    returns: "number",
    args: { sig: "iteratee", exact: 1 },
    value: ({ recv, args, iteratee }) => {
      const it = iteratee(args[0]);
      return { [operator]: { $map: { input: recv, as: it.as, in: it.value } } };
    },
  };
}

/**
 * `.minBy(iteratee)` / `.maxBy(iteratee)`.
 *
 * Decorate each element with its key, sort ascending, then take the last (max) or first
 * (min) element back out. Both return the ELEMENT, not the key, so neither declares an
 * invariant `returns`.
 */
function extremumBy(end: -1 | 0): MethodDef {
  return {
    receiver: "array",
    args: { sig: "iteratee", exact: 1 },
    value: ({ recv, args, iteratee, internalVar }) => {
      const it = iteratee(args[0]);
      const [vSorted, sorted] = internalVar("sorted");
      return {
        $let: {
          vars: {
            [vSorted]: {
              $sortArray: {
                input: { $map: { input: recv, as: it.as, in: { k: it.value, v: it.elem } } },
                sortBy: { k: 1 },
              },
            },
          },
          in: { $getField: { field: "v", input: { $arrayElemAt: [sorted, end] } } },
        },
      };
    },
  };
}

/**
 * `.takeWhile` / `.dropWhile` and their from-the-right forms.
 *
 * From the right is the left-side scan run on the reversed array, then reversed back.
 */
function whileSlicer(drop: boolean, fromRight: boolean): MethodDef {
  return {
    receiver: "array",
    returns: "array",
    args: { sig: "predicate", exact: 1 },
    value: ({ recv, args, predicate, internalVar }) => {
      const pred = predicate(args[0]);
      if (!fromRight) return takeDropWhile(recv, pred, drop, internalVar);
      return reverseArrayOf(takeDropWhile(reverseArrayOf(recv), pred, drop, internalVar));
    },
  };
}

/** `.uniqBy(iteratee)` — order-preserving keep-first dedupe by key. */
const uniqBy: MethodDef = {
  receiver: "array",
  returns: "array",
  args: { sig: "iteratee", exact: 1 },
  value: ({ recv, args, iteratee, internalVar }) => uniqByReduce(recv, iteratee(args[0]), internalVar),
};

/** `.uniq()` — `$setUnion` of one array IS dedupe. */
const uniq: MethodDef = {
  receiver: "array",
  returns: "array",
  args: { sig: "", none: true },
  // It does not preserve input order and lodash does, but nobody writes an ordering when
  // they write `.uniq()`, so MongoDB's behaviour wins over a hand-built order-preserving
  // `$reduce` (SR2). Same set, verified on a live mongod; 144 characters become 26.
  value: ({ recv }) => ({ $setUnion: singleArrayArg(recv) }),
};

/** `.differenceBy` / `.intersectionBy` — difference/intersection compared by iteratee key. */
function setOpBy(keep: boolean): MethodDef {
  return {
    receiver: "array",
    returns: "array",
    args: { sig: "other, iteratee", exact: 2 },
    value: ({ recv, args, gen, iteratee }) => {
      const it = iteratee(args[1]);
      const otherKeys = iterateeKeys(gen(args[0]), it);
      // The binding is read from inside a `$filter` bound to the USER's iteratee param, so
      // it is gensymmed against that name too — which is what `innerVar` is for.
      const [vKeys, keys] = it.innerVar("otherKeys");
      const inOther = { $in: [it.value, keys] };
      return {
        $let: {
          vars: { [vKeys]: otherKeys },
          in: { $filter: { input: recv, as: it.as, cond: keep ? inOther : { $not: [inOther] } } },
        },
      };
    },
  };
}

/** `.keyBy` / `.groupBy` / `.countBy` — an object keyed by the stringified iteratee value. */
function objectByKey(kind: "keyBy" | "groupBy" | "countBy"): MethodDef {
  return {
    receiver: "array",
    // `.groupBy` means one thing in a stream and another in value position, so it carries no
    // invariant return — matching its `METHODS` entry.
    ...(kind === "groupBy" ? {} : { returns: "object" as const }),
    // The iteratee is optional — omitted means identity, as in lodash `_.countBy([1,2,2])`.
    args: { sig: "[iteratee]", allowed: [0, 1] },
    value: ({ recv, args, iteratee }) => {
      const it = iteratee(args[0]);
      // `$arrayToObject` keeps the LAST entry for a repeated key, which is `.keyBy`'s
      // contract exactly — so it needs no grouping pass.
      if (kind === "keyBy") {
        return { $arrayToObject: { $map: { input: recv, as: it.as, in: { k: stringKeyExpr(it.value), v: it.elem } } } };
      }
      const [vKey, key] = it.innerVar("key");
      const filtered = { $filter: { input: recv, as: it.as, cond: { $eq: [stringKeyExpr(it.value), key] } } };
      return {
        $arrayToObject: {
          $map: {
            input: distinctKeysExpr(recv, it),
            as: vKey,
            in: { k: key, v: kind === "countBy" ? { $size: filtered } : filtered },
          },
        },
      };
    },
  };
}

export const LODASH_ARRAY_METHODS: Record<string, MethodDef> = {
  sum: reducer("$sum", "number"),
  mean: reducer("$avg", "number"),
  // `.max` / `.min` return the max/min ELEMENT (of unknown type), never a number.
  max: reducer("$max"),
  min: reducer("$min"),

  sumBy: reducerBy("$sum"),
  meanBy: reducerBy("$avg"),
  maxBy: extremumBy(-1),
  minBy: extremumBy(0),

  uniq,
  // MQL has no sorted-array optimisation, so the sorted forms are aliases.
  sortedUniq: uniq,
  uniqBy,
  sortedUniqBy: uniqBy,

  compact: {
    receiver: "array",
    returns: "array",
    args: { sig: "", none: true },
    // JS truthiness via `jsBool`, so `.compact()` drops exactly what `_.compact` drops and
    // agrees with the equivalent `.filter(x => x)`. Raw MQL truthiness would keep "".
    value: ({ recv, internalVar }) => {
      const [vItem, item] = internalVar("item");
      return { $filter: { input: recv, as: vItem, cond: jsBool(item) } };
    },
  },

  flatten: {
    receiver: "array",
    returns: "array",
    args: { sig: "", none: true },
    // One level; the `$isArray` guard lets a non-array element pass through.
    value: ({ recv }) => ({
      $reduce: {
        input: recv,
        initialValue: [],
        in: { $concatArrays: ["$$value", { $cond: [{ $isArray: "$$this" }, "$$this", ["$$this"]] }] },
      },
    }),
  },

  sample: {
    receiver: "array",
    args: { sig: "", none: true },
    // A random element: `$arrayElemAt` at floor($rand × size). Non-deterministic at runtime
    // (like the stream `.sample` / `$sample`), deterministic to compile.
    value: ({ recv, internalVar }) => {
      const [vArr, arr] = internalVar("arr");
      return {
        $let: {
          vars: { [vArr]: recv },
          in: { $arrayElemAt: [arr, { $floor: { $multiply: [{ $rand: {} }, { $size: arr }] } }] },
        },
      };
    },
  },

  intersection: {
    receiver: "array",
    returns: "array",
    args: { sig: "other", exact: 1 },
    // lodash documents `.intersection` as returning UNIQUE values, which `$setIntersection`
    // is; only the order differs, and order is the unwritten part.
    value: ({ recv, args, gen }) => ({ $setIntersection: [recv, gen(args[0])] }),
  },

  difference: {
    receiver: "array",
    returns: "array",
    args: { sig: "other", exact: 1 },
    // NOT `$setDifference`: lodash's `.difference` keeps duplicates from the receiver
    // (`[3,1,1]`, not `[3,1]`), and dropping them would change the SET, not just the order.
    // The developer wrote `.difference`, whose meaning includes those elements.
    value: ({ recv, args, gen, internalVar }) => {
      const other = gen(args[0]);
      const [vItem, item] = internalVar("item");
      return { $filter: { input: recv, as: vItem, cond: { $not: [{ $in: [item, other] }] } } };
    },
  },

  union: {
    receiver: "array",
    returns: "array",
    args: { sig: "other", exact: 1 },
    // `$setUnion` IS the deduped union. Order is not preserved, and is not something
    // `.union(...)` asks for — see SR2.
    value: ({ recv, args, gen }) => ({ $setUnion: [recv, gen(args[0])] }),
  },

  without: {
    receiver: "array",
    returns: "array",
    args: { sig: "...values", atLeast: 1 },
    // lodash `without(arr, ...values)` — exclude the given values, variadically.
    value: ({ recv, args, gen, internalVar }) => {
      const values = args.map((a) => gen(a));
      const [vItem, item] = internalVar("item");
      return { $filter: { input: recv, as: vItem, cond: { $not: [{ $in: [item, values] }] } } };
    },
  },

  xor: {
    receiver: "array",
    returns: "array",
    args: { sig: "other", exact: 1 },
    // Symmetric difference. lodash documents `.xor` as returning UNIQUE values, so the
    // set-operator composition says exactly what it means: everything in one side and not
    // the other, both ways. Order is not preserved and was never asked for (SR2). Verified
    // same-set on a live mongod across ragged, equal and empty inputs.
    value: ({ recv, args, gen }) => {
      const other = gen(args[0]);
      return { $setUnion: [{ $setDifference: [recv, other] }, { $setDifference: [other, recv] }] };
    },
  },

  differenceBy: setOpBy(false),
  intersectionBy: setOpBy(true),

  unionBy: {
    receiver: "array",
    returns: "array",
    args: { sig: "other, iteratee", exact: 2 },
    // Concatenate, then keep-first dedupe BY iteratee key.
    value: ({ recv, args, gen, iteratee, internalVar }) =>
      uniqByReduce({ $concatArrays: [recv, gen(args[0])] }, iteratee(args[1]), internalVar),
  },

  xorBy: {
    receiver: "array",
    returns: "array",
    args: { sig: "other, iteratee", exact: 2 },
    // Symmetric difference BY iteratee key: uniqBy( A∖B ++ B∖A ) on the keys.
    value: ({ recv, args, gen, iteratee, internalVar }) => {
      const it = iteratee(args[1]);
      const other = gen(args[0]);
      // The key-set bindings are read from inside `$filter`s bound to the USER's iteratee
      // param, so they are minted with `innerVar`.
      const [vA, a] = it.innerVar("a");
      const [vB, b] = it.innerVar("b");
      const [vAKeys, aKeys] = it.innerVar("aKeys");
      const [vBKeys, bKeys] = it.innerVar("bKeys");
      const aNotInB = { $filter: { input: a, as: it.as, cond: { $not: [{ $in: [it.value, bKeys] }] } } };
      const bNotInA = { $filter: { input: b, as: it.as, cond: { $not: [{ $in: [it.value, aKeys] }] } } };
      // The outer `$let` binds the two arrays once; the inner derives their key sets from
      // the bound copies (MongoDB `$let` vars cannot reference their siblings).
      return {
        $let: {
          vars: { [vA]: recv, [vB]: other },
          in: {
            $let: {
              vars: { [vAKeys]: iterateeKeys(a, it), [vBKeys]: iterateeKeys(b, it) },
              in: uniqByReduce({ $concatArrays: [aNotInB, bNotInA] }, it, internalVar),
            },
          },
        },
      };
    },
  },

  keyBy: objectByKey("keyBy"),
  groupBy: objectByKey("groupBy"),
  countBy: objectByKey("countBy"),

  partition: {
    receiver: "array",
    returns: "array",
    args: { sig: "predicate", exact: 1 },
    value: ({ recv, args, predicate }) => {
      const p = predicate(args[0]);
      return [
        { $filter: { input: recv, as: p.as, cond: p.cond } },
        { $filter: { input: recv, as: p.as, cond: { $not: [p.cond] } } },
      ];
    },
  },

  reject: {
    receiver: "array",
    returns: "array",
    args: { sig: "predicate", exact: 1 },
    // The complement of `.filter(p)`. The predicate goes through the JS-truthy wrap for
    // that reason: on raw MQL truthiness an element whose predicate value is `""` would
    // fall out of BOTH halves.
    value: ({ recv, args, predicate }) => {
      const p = predicate(args[0]);
      return { $filter: { input: recv, as: p.as, cond: { $not: [p.cond] } } };
    },
  },

  takeWhile: whileSlicer(false, false),
  dropWhile: whileSlicer(true, false),
  takeRightWhile: whileSlicer(false, true),
  dropRightWhile: whileSlicer(true, true),
};
