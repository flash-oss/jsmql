// The methods whose meaning depends on WHAT THEY WERE CALLED ON.
//
// JavaScript put several of these on more than one prototype — `.slice`, `.indexOf`,
// `.includes`, `.concat` and `.at` are on `Array` AND on `String` — and lodash's `.size`
// counts an array's elements or an object's keys. Their MQL differs per family, so each
// declares one cell per family through `byReceiver`, and dispatch picks.
//
// **Declaration order is probe order.** The first family the compiler can PROVE about the
// receiver wins, so the precedence sits visibly in the declaration rather than in an
// if-chain.
//
// **The not-provable case is derived.** Omit `uncertain` and dispatch builds
// `cond($isArray, <array cell>, <other cell>)` from the two cells. Every method here used to
// hand-write that `$cond` itself, and ten copies of one rule are ten chances for two of them
// to disagree about what a bare `$.field` means. Three declarations DO answer it themselves,
// and each says why it must.
//
// See docs/specs/lowering-grid.md § Dual receivers.

import { rejectPredicateOnValueSearch, reverseArrayOf, sizeOf, sliceArray } from "../mql-array.ts";
import { cond, isStringType, requireIntCount } from "../mql-shape.ts";
import { normaliseSliceIndex, sliceString } from "../mql-string.ts";
import type { Expr } from "../ast.ts";
import { byReceiver, type ByReceiver, type MethodDef, unsupported } from "./types.ts";

/** The `,`-joined stringification `Array.prototype.toString` and `.join()` both perform. */
function joinedWith(recv: unknown, separator: unknown): unknown {
  return {
    $reduce: {
      input: recv,
      initialValue: "",
      in: cond(
        { $eq: ["$$value", ""] },
        { $toString: "$$this" },
        { $concat: ["$$value", separator, { $toString: "$$this" }] },
      ),
    },
  };
}

/**
 * The index-from-either-end dispatch `.at()` and lodash's `.nth()` share.
 *
 * Both read array-LIKE receivers, strings included (`_.nth("abc", 1) === "b"`), and both are
 * the only way to spell a negative index — brackets reject one. They differ ONLY in whether
 * the index may be omitted, which is an arity rule, so the cells are shared outright.
 */
function indexFromEitherEnd(): ByReceiver {
  return byReceiver(
    {
      // `$substrCP` refuses a negative start outright ("the starting index must be
      // nonnegative integer"), so the string side resolves the index against the length —
      // the same normalisation `.slice` and `.substr` use.
      string: ({ recv, args, gen }) => ({
        $substrCP: [recv, args[0] === undefined ? 0 : normaliseSliceIndex(args[0], gen, recv), 1],
      }),
      // `$arrayElemAt` takes a negative index natively.
      array: ({ recv, args, gen }) => ({ $arrayElemAt: [recv, args[0] === undefined ? 0 : gen(args[0])] }),
    },
    ({ recv }, cell) =>
      // Test for a STRING explicitly rather than reading "not an array" as "string".
      // `$substrCP` of a missing value is `""`, and `""` is not null — so the loose form
      // poisons an enclosing `??` (`$.aliases.at(0) ?? "anonymous"` yielded `""` instead of
      // the fallback). Anything that is neither is `$$REMOVE`: neither language has this
      // accessor on a number or a document, and missing is how MQL spells an absent result.
      cond({ $isArray: recv }, cell.array!(), cond(isStringType(recv), cell.string!(), "$$REMOVE")),
  );
}

// `toString` and `toLocaleString` collide with `Object.prototype`, and a key that does
// loses its contextual type inside a `Record<string, MethodDef>` literal — the type-level
// twin of the runtime hazard the registry's null prototype guards. Annotating each
// declaration explicitly restores the check that the collision silently removed.
const TO_STRING: MethodDef = {
  // Universal in JavaScript, with two families that mean something specific: an array
  // stringifies as `.join(",")`, and a string already IS its own string. Everything else —
  // numbers, dates, booleans, ObjectId — is what `$toString` is for, which is why the
  // not-provable answer here is a real lowering rather than a runtime dispatch.
  receiver: "any",
  args: { sig: "", none: true },
  value: byReceiver(
    {
      array: ({ recv, requireStringifiableReceiver }) => {
        requireStringifiableReceiver();
        return joinedWith(recv, ",");
      },
      string: ({ recv }) => recv,
    },
    ({ recv }) => ({ $toString: recv }),
  ),
};

const TO_LOCALE_STRING: MethodDef = {
  // Genuinely universal in JavaScript — Number, Date and Array all carry it — so there is
  // no family to declare and no cell to refine.
  receiver: "any",
  args: { sig: "", none: true },
  value: unsupported(
    `.toLocaleString() is locale-dependent and isn't expressible as a MongoDB expression. ` +
      `Use '.join(...)' with explicit formatting, or '$dateToString' for dates.`,
  ),
};

export const DUAL_RECEIVER_METHODS: Record<string, MethodDef> = {
  indexOf: {
    receiver: ["array", "string"],
    returns: "number",
    args: { sig: "searchValue", exact: 1 },
    value: byReceiver({
      array: ({ recv, args, gen }) => {
        rejectPredicateOnValueSearch(args[0], "indexOf", "findIndex");
        return { $indexOfArray: [recv, gen(args[0])] };
      },
      string: ({ recv, args, gen }) => {
        rejectPredicateOnValueSearch(args[0], "indexOf", "findIndex");
        return { $indexOfCP: [recv, gen(args[0])] };
      },
    }),
  },

  includes: {
    receiver: ["array", "string"],
    returns: "bool",
    args: { sig: "searchValue", exact: 1 },
    value: byReceiver({
      array: ({ recv, args, gen }) => {
        rejectPredicateOnValueSearch(args[0], "includes", "some");
        return { $in: [gen(args[0]), recv] };
      },
      string: ({ recv, args, gen }) => {
        rejectPredicateOnValueSearch(args[0], "includes", "some");
        return { $gte: [{ $indexOfCP: [recv, gen(args[0])] }, 0] };
      },
    }),
  },

  lastIndexOf: {
    // Declared on both families so a provably-string receiver gets the REASON rather than
    // array MQL that reads the wrong way. Only one of the two can be lowered, though, so the
    // not-provable case has nothing to dispatch between and takes the array form — which is
    // why this one answers `uncertain` itself.
    receiver: ["array", "string"],
    returns: "number",
    args: { sig: "searchValue", exact: 1 },
    value: byReceiver(
      {
        // Find the FIRST match in the reversed array, then map the index back. The receiver
        // binds once so it is not evaluated twice.
        array: ({ recv, args, gen, internalVar }) => {
          const needle = gen(args[0]);
          const [vArr, arr] = internalVar("arr");
          const [vRev, rev] = internalVar("revIdx");
          return {
            $let: {
              vars: { [vArr]: recv },
              in: {
                $let: {
                  vars: { [vRev]: { $indexOfArray: [reverseArrayOf(arr), needle] } },
                  in: cond({ $eq: [rev, -1] }, -1, { $subtract: [{ $subtract: [{ $size: arr }, 1] }, rev] }),
                },
              },
            },
          };
        },
        string: unsupported(
          `.lastIndexOf() on strings isn't supported — MongoDB's $indexOfCP is forward-only. ` +
            `Use $op($indexOfCP, str, needle) for first-match indexing.`,
        ),
      },
      (_input, cell) => cell.array!(),
    ),
  },

  at: { receiver: ["string", "array"], args: { sig: "index", exact: 1 }, value: indexFromEitherEnd() },

  nth: {
    // lodash's `_.nth` is `.at` with an optional index. Emitting a bare `$arrayElemAt` for it
    // aborted the query on a string receiver ("first argument must be an array, but is
    // string"), which is exactly what sharing the dispatch prevents.
    receiver: ["string", "array"],
    args: { sig: "[n=0]", allowed: [0, 1] },
    value: indexFromEitherEnd(),
  },

  slice: {
    receiver: ["string", "array"],
    args: { sig: "start[, end]", allowed: [0, 1, 2] },
    value: byReceiver({
      // `$substrCP`, with compile-time or runtime normalisation of a negative index.
      string: ({ recv, args, gen }) => {
        requireSliceIndices(args);
        return sliceString(recv, args, gen);
      },
      // `$slice`, whose position argument supports a negative index natively.
      array: ({ recv, args, gen, internalVar }) => {
        requireSliceIndices(args);
        return sliceArray(recv, args, gen, internalVar);
      },
    }),
  },

  concat: {
    receiver: ["array", "string"],
    // Variadic and forwarding, so a spread argument is spliced rather than rejected.
    args: { sig: "...items", atLeast: 1, spread: true },
    value: byReceiver({
      array: ({ recv, args, gen }) => ({ $concatArrays: [recv, ...args.map((a) => gen(a))] }),
      string: ({ recv, args, gen }) => ({ $concat: [recv, ...args.map((a) => gen(a))] }),
    }),
  },

  size: {
    // lodash `size` counts array elements OR object keys. A string should use `.length`.
    receiver: ["array", "object"],
    returns: "number",
    args: { sig: "", none: true },
    value: byReceiver({ array: ({ recv }) => sizeOf(recv), object: ({ recv }) => sizeOf({ $objectToArray: recv }) }),
  },

  toString: TO_STRING,

  join: {
    receiver: "array",
    returns: "string",
    args: { sig: "separator", allowed: [0, 1] },
    // Concatenate the elements with the separator, omitting it for the first. The
    // accumulator carries the running string, and an empty start is what detects "first".
    value: ({ recv, args, gen, requireStringifiableReceiver }) => {
      requireStringifiableReceiver();
      return joinedWith(recv, args.length === 1 ? gen(args[0]) : ",");
    },
  },

  toLocaleString: TO_LOCALE_STRING,

  clamp: {
    // A number OR a date receiver, and ONE lowering serves both — so this declares a
    // multi-family receiver with a single cell rather than a `byReceiver` map. The result
    // type follows the receiver, hence no invariant `returns`.
    receiver: ["number", "date"],
    args: { sig: "lower, upper", exact: 2 },
    value: ({ recv, args, gen }) => ({ $min: [{ $max: [recv, gen(args[0])] }, gen(args[1])] }),
  },
};

/**
 * A negative `.slice` index is HONOURED — the developer wrote it — but a fraction is not an
 * index in either language, and `$slice` aborts the whole query on one. Both cells check,
 * because either may be the one that runs.
 */
function requireSliceIndices(args: readonly (Expr | undefined)[]): void {
  requireIntCount("slice", "start[, end]", args[0], Number.NEGATIVE_INFINITY);
  requireIntCount("slice", "start[, end]", args[1], Number.NEGATIVE_INFINITY);
}
