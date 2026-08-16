// Positional array methods — slicing, sampling, and the zip/pair reshapers.
//
// Three server rejections shape almost everything here, and they are worth stating once
// because the workarounds look arbitrary otherwise:
//
//   1. `$slice`'s 3-argument count must be POSITIVE. A count of 0 is rejected outright
//      ("Third argument to $slice must be positive"), so every lowering that could compute
//      0 uses the 2-argument first-n form instead, or floors the count at 1.
//   2. `$slice` aborts the whole query on a FRACTION. `requireIntCount` catches a literal
//      one at the keyboard; a runtime expression is the server's to judge.
//   3. `$arrayToObject` needs a string `k`, so every key goes through `$toString`.
//
// NOT YET HERE: `.zipWith` and `.join`. `.zipWith` lowers an N-parameter arrow against a
// scope binding one parameter per zipped array — a compiler service, like the iteratee, but
// N-ary. `.join` reads its RECEIVER's shape to reject a nested array. Both stay in the
// switch; the ratchet in `test/methods-grid.test.ts` counts them.
//
// See docs/specs/lowering-grid.md.

import { firstOf, lastOf, sizeOf } from "../mql-array.ts";
import { isNegativeLiteral, negate, requireIntCount } from "../mql-shape.ts";
import type { LowerInput, MethodDef } from "./types.ts";

/** The `[n=1]` count `.take` / `.drop` / `.sampleSize` and friends share. */
function countArg(method: string, { args, gen, err }: LowerInput, mirror?: string): unknown {
  const nArg = args[0];
  if (nArg !== undefined && isNegativeLiteral(nArg)) {
    throw err(
      `.${method}(n) needs a non-negative count${mirror ? ` — use ${mirror} to count from the other end` : ""}.`,
      nArg.pos,
    );
  }
  requireIntCount(method, "n", nArg, 0, err);
  return nArg !== undefined ? gen(nArg) : 1;
}

/**
 * `.take` / `.drop` / `.takeRight` / `.dropRight`.
 *
 * `.take` and `.takeRight` are `$slice` primitives (a negative position counts from the
 * end). The two DROP forms are not, and each dodges rejection (1) differently: `dropRight`
 * keeps the first `max(0, size - n)` with the 2-argument form, and `drop` floors its count
 * at `max(1, size)` so an EMPTY receiver yields `[]` rather than a rejected count of 0.
 */
function slicer(kind: "take" | "drop" | "takeRight" | "dropRight"): MethodDef {
  const mirror = kind === "take" ? ".takeRight(n)" : kind === "takeRight" ? ".take(n)" : undefined;
  return {
    receiver: "array",
    returns: "array",
    args: { sig: "[n=1]", allowed: [0, 1] },
    value: (input) => {
      const n = countArg(kind, input, mirror);
      const { recv, internalVar } = input;
      if (kind === "take") return { $slice: [recv, n] };
      if (kind === "takeRight") return { $slice: [recv, negate(n)] };
      const [vArr, arr] = internalVar("arr");
      if (kind === "dropRight") {
        const keep = { $max: [0, { $subtract: [{ $size: arr }, n] }] };
        return { $let: { vars: { [vArr]: recv }, in: { $slice: [arr, keep] } } };
      }
      return { $let: { vars: { [vArr]: recv }, in: { $slice: [arr, n, { $max: [1, { $size: arr }] }] } } };
    },
  };
}

/** `.tail()` is `.drop(1)`; `.initial()` is `.dropRight(1)`. Same two rejection dodges. */
function fixedSlicer(kind: "tail" | "initial"): MethodDef {
  return {
    receiver: "array",
    returns: "array",
    args: { sig: "", none: true },
    value: ({ recv, internalVar }) => {
      const [vArr, arr] = internalVar("arr");
      const body =
        kind === "initial"
          ? { $slice: [arr, { $max: [0, { $subtract: [{ $size: arr }, 1] }] }] }
          : { $slice: [arr, 1, { $max: [1, { $size: arr }] }] };
      return { $let: { vars: { [vArr]: recv }, in: body } };
    },
  };
}

/** `.head()` / `.first()` / `.last()` — the element, so no invariant `returns`. */
function endElement(pick: typeof firstOf): MethodDef {
  return { receiver: "array", args: { sig: "", none: true }, value: ({ recv }) => pick(recv) };
}

export const ARRAY_SLICING_METHODS: Record<string, MethodDef> = {
  take: slicer("take"),
  drop: slicer("drop"),
  takeRight: slicer("takeRight"),
  dropRight: slicer("dropRight"),
  tail: fixedSlicer("tail"),
  initial: fixedSlicer("initial"),
  head: endElement(firstOf),
  first: endElement(firstOf),
  last: endElement(lastOf),

  chunk: {
    receiver: "array",
    returns: "array",
    args: { sig: "size", exact: 1 },
    // The size must be a LITERAL, not merely an integer: it is the `$range` step and the
    // `$slice` count, and both want a compile-time constant.
    value: ({ recv, args, internalVar, err }) => {
      const size = args[0];
      if (size.type !== "NumberLiteral" || !Number.isInteger(size.value) || size.value < 1) {
        throw err(
          `.chunk(size) requires a positive integer literal (got ${size.type === "NumberLiteral" ? size.value : "a non-literal"}).`,
          size.pos,
        );
      }
      const [vI, i] = internalVar("i");
      return {
        $map: { input: { $range: [0, sizeOf(recv), size.value] }, as: vI, in: { $slice: [recv, i, size.value] } },
      };
    },
  },

  sampleSize: {
    receiver: "array",
    returns: "array",
    args: { sig: "[n=1]", allowed: [0, 1] },
    // n random elements without replacement: decorate each with a random key, sort by it,
    // take the first n, undecorate. An n past the length yields the whole shuffle.
    value: (input) => {
      const n = countArg("sampleSize", input, undefined);
      const { recv, internalVar } = input;
      const [vShuf, shuf] = internalVar("shuffled");
      const [vItem, item] = internalVar("item");
      return {
        $let: {
          vars: {
            [vShuf]: {
              $sortArray: {
                input: { $map: { input: recv, as: vItem, in: { k: { $rand: {} }, v: item } } },
                sortBy: { k: 1 },
              },
            },
          },
          in: { $map: { input: { $slice: [shuf, n] }, as: vItem, in: `${item}.v` } },
        },
      };
    },
  },

  flat: {
    receiver: "array",
    returns: "array",
    args: { sig: "depth", allowed: [0, 1] },
    // Depth 1 only (the default). MongoDB has no recursive flatten primitive, and
    // emulating arbitrary depth would need unbounded `$reduce` nesting.
    value: ({ recv, args, pos, err }) => {
      const arg = args[0];
      if (arg !== undefined && (arg.type !== "NumberLiteral" || arg.value !== 1)) {
        throw err(`.flat() only supports depth=1 (the default). MongoDB has no recursive flatten primitive.`, pos);
      }
      return { $reduce: { input: recv, initialValue: [], in: { $concatArrays: ["$$value", "$$this"] } } };
    },
  },

  zip: {
    receiver: "array",
    returns: "array",
    args: { sig: "...arrays", atLeast: 1 },
    // `$zip` IS this operation, and `useLongestLength` IS lodash's padding rule: groups run
    // to the longest input and short ones fill with null.
    value: ({ recv, args, gen }) => ({ $zip: { inputs: [recv, ...args.map((a) => gen(a))], useLongestLength: true } }),
  },

  unzip: {
    receiver: "array",
    returns: "array",
    args: { sig: "", none: true },
    // The inverse of zip: transpose an array of equal-length tuples. The column count is
    // the size of the first tuple; `$ifNull` → [] guards an empty receiver.
    value: ({ recv, internalVar }) => {
      const [vT, t] = internalVar("t");
      const [vJ, j] = internalVar("j");
      const [vRow, row] = internalVar("row");
      return {
        $let: {
          vars: { [vT]: recv },
          in: {
            $map: {
              input: { $range: [0, { $size: { $ifNull: [{ $arrayElemAt: [t, 0] }, []] } }] },
              as: vJ,
              in: { $map: { input: t, as: vRow, in: { $arrayElemAt: [row, j] } } },
            },
          },
        },
      };
    },
  },

  zipObject: {
    receiver: "array",
    returns: "object",
    args: { sig: "values", exact: 1 },
    // Pair keys with values by index (the key array's length decides).
    value: ({ recv, args, gen, internalVar }) => {
      const values = gen(args[0]);
      const [vI, i] = internalVar("i");
      return {
        $arrayToObject: {
          $map: {
            input: { $range: [0, sizeOf(recv)] },
            as: vI,
            in: { k: { $toString: { $arrayElemAt: [recv, i] } }, v: { $arrayElemAt: [values, i] } },
          },
        },
      };
    },
  },

  fromPairs: {
    receiver: "array",
    returns: "object",
    args: { sig: "", none: true },
    // The receiver is a `[[k, v], …]` array.
    value: ({ recv, internalVar }) => {
      const [vP, p] = internalVar("p");
      return {
        $arrayToObject: {
          $map: { input: recv, as: vP, in: [{ $toString: { $arrayElemAt: [p, 0] } }, { $arrayElemAt: [p, 1] }] },
        },
      };
    },
  },
};
