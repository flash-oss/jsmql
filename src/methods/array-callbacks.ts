// The JavaScript array methods that take a `(element[, index[, array]])` CALLBACK.
//
// One service answers all of them. `LowerInput.callback()` resolves the arrow — including
// the lodash shorthand spellings (`"a.b"` / `{ active: true }` / `["a.b", v]`) and the bare
// built-in form (`.filter(Boolean)`) — and hands back what `$map` / `$filter` iterates plus
// the lowered body.
//
// `paired` is the one thing every declaration here has to handle. When the callback
// actually references its index parameter, the input becomes a `$zip` of index and element
// rather than the array, so a method that returns ELEMENTS must project back out of the
// pair. When it does not, the plain form is emitted and there is nothing to undo — which is
// why the index machinery is only built when the index is really used.
//
// NOT YET HERE: `.findIndex` / `.findLastIndex` (they build their own `$zip`-and-`$reduce`
// scan rather than going through the shared resolver) and `.reduce` / `.reduceRight` (whose
// accumulator narrowing reads both the initial value and the lambda's result). The ratchet
// in `test/methods-grid.test.ts` counts them.
//
// See docs/specs/method-dispatch.md.

import { resolverChecksArgs } from "../arity.ts";
import type { LowerInput, MethodDef } from "./types.ts";

/** `.find()` / `.findLast()` — the first or last matching ELEMENT, so no `returns`. */
function finder(end: 0 | -1): MethodDef {
  return {
    receiver: "array",
    args: resolverChecksArgs("predicate"),
    value: ({ callback }) => {
      const cb = callback();
      const matches = { $filter: { input: cb.input, as: cb.as, cond: cb.boolBody() } };
      const picked = { $arrayElemAt: [matches, end] };
      // Paired: the match is an (index, element) pair, so take the element back out.
      return cb.paired ? { $arrayElemAt: [picked, 1] } : picked;
    },
  };
}

/**
 * `.some()` / `.every()` — map the predicate over the elements, then collapse.
 *
 * The input is coerced to `[]` for a missing receiver, and that is a CORRECTNESS fix rather
 * than defensiveness. `$anyElementTrue` aborts the whole command on a non-array — so a single
 * document without the field killed the query — while the same predicate in Filter position
 * lowers to `$elemMatch`, which simply does not match. The two targets answered differently,
 * and one of the answers was "your query is dead". An empty array gives `false` for `.some`
 * and `true` for `.every`, matching both `$elemMatch` and JavaScript's own `[].some` /
 * `[].every`.
 *
 * Only `$ifNull` — a receiver that is present but wrongly typed still aborts, which is the
 * same line the rest of the array surface draws.
 */
function quantifier(operator: "$anyElementTrue" | "$allElementsTrue"): MethodDef {
  return {
    receiver: "array",
    returns: "bool",
    args: resolverChecksArgs("predicate"),
    // No pair projection: the result is a single boolean either way.
    value: ({ callback }) => {
      const cb = callback();
      const input = cb.paired ? cb.input : { $ifNull: [cb.input, []] };
      return { [operator]: { $map: { input, as: cb.as, in: cb.boolBody() } } };
    },
  };
}

/** The `$map` a value-producing callback method builds. */
function mapped(cb: ReturnType<LowerInput["callback"]>): unknown {
  return { $map: { input: cb.input, as: cb.as, in: cb.body() } };
}

export const ARRAY_CALLBACK_METHODS: Record<string, MethodDef> = {
  map: {
    receiver: "array",
    returns: "array",
    args: resolverChecksArgs("callback"),
    // Nothing to project back: the callback's own result is the element, paired or not.
    value: ({ callback }) => mapped(callback()),
  },

  filter: {
    receiver: "array",
    returns: "array",
    args: resolverChecksArgs("predicate"),
    value: ({ callback, internalVar }) => {
      const cb = callback();
      const kept = { $filter: { input: cb.input, as: cb.as, cond: cb.boolBody() } };
      if (!cb.paired) return kept;
      // Paired: filter the (index, element) pairs, then project back to elements.
      const [vPair, pair] = internalVar("pair");
      return { $map: { input: kept, as: vPair, in: { $arrayElemAt: [pair, 1] } } };
    },
  },

  find: finder(0),
  findLast: finder(-1),

  some: quantifier("$anyElementTrue"),
  every: quantifier("$allElementsTrue"),

  flatMap: {
    receiver: "array",
    returns: "array",
    args: resolverChecksArgs("callback"),
    // `.map` then one level of flatten — MongoDB has no `$flatMap`.
    value: ({ callback }) => ({
      $reduce: { input: mapped(callback()), initialValue: [], in: { $concatArrays: ["$$value", "$$this"] } },
    }),
  },
};
