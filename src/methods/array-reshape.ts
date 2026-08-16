// Array methods that return a RESHAPED copy — the immutable spellings JavaScript added
// beside its mutators, plus the two lodash sorts.
//
// `$slice`'s position argument is non-negative, so `.toSpliced` and `.with` reject a
// negative literal index rather than emitting MQL the server aborts on. That is the same
// rejection the mutators' immutable advice points AT, so it has to be a clear one.
//
// The three sorts differ only in what their argument may be, and `src/mql-sort.ts` owns
// that reading: `$sortArray` takes field NAMES rather than expressions, so a sort key is
// always resolved at compile time and never lowered.
//
// See docs/specs/method-dispatch.md.

import { reverseArrayOf } from "../mql-array.ts";
import { isNegativeLiteral } from "../mql-shape.ts";
import { argToSortBy, orderByDirs, orderByKeyNames } from "../mql-sort.ts";
import type { MethodDef } from "./types.ts";

export const ARRAY_RESHAPE_METHODS: Record<string, MethodDef> = {
  toReversed: {
    receiver: "array",
    returns: "array",
    args: { sig: "", none: true },
    value: ({ recv }) => reverseArrayOf(recv),
  },

  toSorted: {
    receiver: "array",
    returns: "array",
    args: { sig: '"field" | ["a", "b"] | { field: dir } | keyFn', allowed: [0, 1] },
    value: ({ recv, args }) => ({
      $sortArray: { input: recv, sortBy: args.length === 0 ? 1 : argToSortBy(args[0], "toSorted") },
    }),
  },

  sortBy: {
    receiver: "array",
    returns: "array",
    args: { sig: '["field" | keyFn | [fields]]', allowed: [0, 1] },
    // lodash `sortBy` — ascending by an iteratee. Field name / array of field names / key
    // function, like `.toSorted`. An OBJECT argument is REJECTED: in lodash a `{ age: -1 }`
    // here is a matches-shorthand (sort by a boolean), not a direction, so the user is
    // pointed at the two methods that do read it as one before the surprise can bite.
    value: ({ recv, args, err }) => {
      if (args.length === 0) return { $sortArray: { input: recv, sortBy: 1 } };
      if (args[0].type === "ObjectLiteral") {
        throw err(
          `.sortBy({ … }) isn't supported — an object here is a lodash matches-shorthand, not a direction. Use '.orderBy({ field: -1 })' or '.toSorted({ field: -1 })' for directions.`,
          args[0].pos,
        );
      }
      return { $sortArray: { input: recv, sortBy: argToSortBy(args[0], "sortBy") } };
    },
  },

  orderBy: {
    receiver: "array",
    returns: "array",
    args: { sig: "keys[, orders] | { field: dir }", allowed: [1, 2] },
    // lodash `orderBy(keys, orders)` — parallel arrays of sort keys and directions. The
    // object form mirrors `.toSorted({ … })`: the directions live inside the object, so
    // there is no separate `orders` argument to pass.
    value: ({ recv, args, err }) => {
      if (args[0].type === "ObjectLiteral") {
        if (args.length > 1) {
          throw err(
            `.orderBy({ … }) already carries a direction per field — drop the second 'orders' argument.`,
            args[1].pos,
          );
        }
        return { $sortArray: { input: recv, sortBy: argToSortBy(args[0], "orderBy") } };
      }
      const names = orderByKeyNames(args[0], "orderBy");
      const dirs = args[1] !== undefined ? orderByDirs(args[1], "orderBy") : [];
      const spec: Record<string, 1 | -1> = {};
      // Orders shorter than keys ⇒ the remaining keys sort ascending, as in lodash.
      names.forEach((nm, i) => {
        spec[nm] = dirs[i] ?? 1;
      });
      return { $sortArray: { input: recv, sortBy: spec } };
    },
  },

  toSpliced: {
    receiver: "array",
    returns: "array",
    args: { sig: "start[, deleteCount, ...items]", atLeast: 1 },
    value: ({ recv, args, gen, internalVar, err }) => {
      const startArg = args[0];
      if (isNegativeLiteral(startArg)) {
        throw err(
          `.toSpliced() with a negative start index isn't supported — MongoDB $slice's position arg is non-negative.`,
          startArg.pos,
        );
      }
      // deleteCount omitted ⇒ remove to the end, matching JS exactly.
      const hasDeleteCount = args.length >= 2;
      const deleteCountArg = hasDeleteCount ? args[1] : null;
      if (deleteCountArg && isNegativeLiteral(deleteCountArg)) {
        throw err(
          `.toSpliced() with a negative deleteCount isn't supported — MongoDB $slice's length arg is non-negative.`,
          deleteCountArg.pos,
        );
      }
      const start = gen(startArg);
      const items = args.slice(2).map((a) => gen(a));
      // Bind arr/start/tailStart once, so the size and the arithmetic are computed a single
      // time. tailStart = start + deleteCount, or just start when deleteCount is omitted
      // (no removal — a pure insert). tailLen = size − tailStart, floored at 0.
      const [vArr, arr] = internalVar("arr");
      const [vStart, startRef] = internalVar("start");
      const [vTail, tail] = internalVar("tailStart");
      const tailStart = hasDeleteCount ? { $add: [startRef, gen(deleteCountArg!)] } : startRef;
      return {
        $let: {
          vars: { [vArr]: recv, [vStart]: start },
          in: {
            $let: {
              vars: { [vTail]: tailStart },
              in: {
                $concatArrays: [
                  { $slice: [arr, 0, startRef] },
                  items,
                  { $slice: [arr, tail, { $max: [0, { $subtract: [{ $size: arr }, tail] }] }] },
                ],
              },
            },
          },
        },
      };
    },
  },

  with: {
    receiver: "array",
    returns: "array",
    args: { sig: "index, value", exact: 2 },
    // The one-element replacement: everything before the index, the new value, everything
    // after it.
    value: ({ recv, args, gen, internalVar, err }) => {
      const idxArg = args[0];
      if (isNegativeLiteral(idxArg)) {
        throw err(
          `.with() with a negative index isn't supported — MongoDB $slice's position arg is non-negative.`,
          idxArg.pos,
        );
      }
      const [vArr, arr] = internalVar("arr");
      const [vIdx, idxRef] = internalVar("idx");
      const [vVal, valRef] = internalVar("val");
      const after = { $add: [idxRef, 1] };
      return {
        $let: {
          vars: { [vArr]: recv, [vIdx]: gen(idxArg), [vVal]: gen(args[1]) },
          in: {
            $concatArrays: [
              { $slice: [arr, 0, idxRef] },
              [valRef],
              { $slice: [arr, after, { $max: [0, { $subtract: [{ $size: arr }, after] }] }] },
            ],
          },
        },
      };
    },
  },
};
