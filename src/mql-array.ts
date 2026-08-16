// Pure MQL shape-builders for array lowerings, and the resolved-iteratee shape they read.
//
// A LEAF: it imports only AST types. That is what lets `codegen.ts` and the method
// families in `src/methods/` both use it — a family file that reached back into
// `codegen.ts` would make the two mutually dependent, and the registry would then assemble
// before the family initialised, silently dropping every method in it.
//
// A lodash iteratee is resolved by the compiler (it lowers a lambda body against a scope
// that binds the element) and arrives here ALREADY resolved, as `ResolvedIteratee`. That
// is what keeps this file at leaf level: nothing here reaches back for a `GenerateCtx`.
//
// See docs/specs/lowering-grid.md § Where declarations live.

import type { Expr } from "./ast.ts";
import { CodegenError } from "./errors.ts";
import { type Gen, literalIndexValue, resolveSliceIndex } from "./mql-shape.ts";

/**
 * A lodash *iteratee* for the array methods, already resolved: the `$map`/`$filter`
 * element variable and the iteratee expression evaluated against it.
 *
 * `src` is the AST the `value` was generated from — carried so a predicate context can ask
 * whether the JS-truthy wrap can be elided. It is absent for the identity iteratee (an
 * element value is never provably bool).
 */
export type ResolvedIteratee = {
  as: string;
  elem: string;
  value: unknown;
  src?: Expr;
  /**
   * Mint a variable name for a binding READ FROM INSIDE this iteratee's element binding.
   * Gensymmed against `as` as well as the outer scope, because the user's own iteratee
   * parameter is in scope there and a bare name would capture it.
   *
   * The plain `internalVar` is still right for a binding that encloses the iteratee rather
   * than sitting inside it. Carrying the scoped minter on the iteratee itself is what makes
   * the distinction impossible to forget at a call site.
   */
  innerVar: (base: string) => [string, string];
};

/** A resolved lodash *predicate*: the same element binding, read as a JS-truthy condition. */
export type ResolvedPredicate = { as: string; cond: unknown; innerVar: (base: string) => [string, string] };

/**
 * A JavaScript array CALLBACK — `(element[, index[, array]]) => …` — already resolved
 * against the receiver.
 *
 * The bodies are lazy because lowering one mints variable names: producing both eagerly
 * would advance the gensym counter for a body the caller never emits. Each method calls
 * exactly one of them.
 */
export type ResolvedCallback = {
  /** What `$map` / `$filter` iterates: the array, or a `$zip` of index and element. */
  input: unknown;
  as: string;
  /**
   * True when `input` holds (index, element) PAIRS, which happens only when the callback
   * actually references its index parameter. The caller must then project back to elements.
   */
  paired: boolean;
  /** The lowered body, already wrapped for a third `array` parameter if there is one. */
  body: () => unknown;
  /** The same body lowered in BOOLEAN position, for a predicate. */
  boolBody: () => unknown;
};

/**
 * Wrap a *literal array* operand one level deeper for the positional single-array-argument
 * operators (`$size`, `$first`, `$last`, `$reverseArray`) so it can't be read as the
 * argument LIST. MongoDB splices a bare array there: `{ $size: [1, 2] }` is two arguments
 * ("takes exactly 1 arguments. 2 were passed in") and the one-element `{ $size: [1] }`
 * unwraps to the scalar ("must be an array, but was of type: int"). One extra level,
 * `{ $size: [[1, 2]] }`, is unwrapped exactly once back to the intended operand.
 *
 * Every other operand — a field path, a `$$var`, a nested operator document — is already
 * unambiguous and passes through untouched, so the four constructors below are safe at
 * every site. Applies only to jsmql's own lowering; a raw `$op($size, …)` stays a faithful
 * passthrough (HR2).
 */
export function singleArrayArg(operand: unknown): unknown {
  return Array.isArray(operand) ? [operand] : operand;
}

export const sizeOf = (a: unknown): Record<string, unknown> => ({ $size: singleArrayArg(a) });
export const firstOf = (a: unknown): Record<string, unknown> => ({ $first: singleArrayArg(a) });
export const lastOf = (a: unknown): Record<string, unknown> => ({ $last: singleArrayArg(a) });
export const reverseArrayOf = (a: unknown): Record<string, unknown> => ({ $reverseArray: singleArrayArg(a) });

/**
 * Wrap an already-generated MQL expression in a JS-truthy check. True iff `value` is truthy
 * under JS rules (false, null, missing, 0, "" → false; everything else → true; NaN treated
 * as truthy — see the note in docs/specs/method-dispatch.md).
 */
export function jsBool(value: unknown): unknown {
  return {
    $and: [
      // Catches both `null` and *missing*. A bare `$ne: [value, null]` does NOT catch
      // missing — MongoDB's `$eq`/`$ne` treat a missing value as distinct from null
      // (`$eq: ["$absent", null]` is false), so `arr.filter(x => x.f)` would wrongly keep
      // elements where `f` is absent. `$ifNull` collapses missing → null first, matching JS
      // where `undefined` is falsy. The other three clauses compare the raw value
      // (false/""/0 are never "missing").
      { $ne: [{ $ifNull: [value, null] }, null] },
      { $ne: [value, false] },
      { $ne: [value, ""] },
      { $ne: [value, 0] },
    ],
  };
}

/**
 * A null-safe stringified object key for `$arrayToObject` / `$group`-`_id` entries.
 *
 * lodash coerces a group key to a string; MongoDB's `$toString` yields *null* for a
 * missing/null value, and `$arrayToObject` then rejects it ("the value of 'k' must be of
 * type string"). Coercing that null to the literal "null" (matching `String(null)`) lands a
 * missing/null grouping field under one "null" key instead of erroring on the server. NB
 * `$toString` still errors on an object/array value — a separate, documented footgun.
 * Shared by the value-mode `keyBy`/`groupBy`/`countBy` and their stream-collapse forms so
 * both stay consistent.
 */
export function stringKeyExpr(value: unknown): unknown {
  return { $ifNull: [{ $toString: value }, "null"] };
}

/**
 * Group/count key set of an array: distinct STRINGIFIED iteratee values (lodash coerces
 * group keys to strings). `$setUnion` needs a 2-arg form to be valid.
 */
export function distinctKeysExpr(arr: unknown, it: ResolvedIteratee): unknown {
  return { $setUnion: [{ $map: { input: arr, as: it.as, in: stringKeyExpr(it.value) } }, []] };
}

/**
 * The iteratee-keyed values of an array: `[it(x) for x in arr]` — NOT stringified, used for
 * `$in` membership in the `*By` set operations.
 */
export function iterateeKeys(arr: unknown, it: ResolvedIteratee): unknown {
  return { $map: { input: arr, as: it.as, in: it.value } };
}

/**
 * Order-preserving keep-first dedupe of `input` BY iteratee key (`.uniqBy`, and the
 * `.unionBy`/`.xorBy` tails). Tracks seen keys in a `{ seen, out }` accumulator, then
 * projects `out`.
 */
export function uniqByReduce(
  input: unknown,
  it: ResolvedIteratee,
  internalVar: (base: string) => [string, string],
): unknown {
  // The iteratee is written against the user's own param name, so the $let binding it must
  // NOT enclose the $reduce accumulator reads — an iteratee like `value => value.id` would
  // otherwise shadow `$$value` and read `.seen`/`.out` off the element. A $let var's VALUE
  // is evaluated in the enclosing scope, so computing the key there keeps the user's name
  // scoped to the key expression alone. It also binds the key once instead of re-emitting
  // the iteratee for both the membership test and the accumulator.
  const [k, key] = internalVar("key");
  // An identity iteratee (`x => x`) is just the element — no binding needed.
  const keyExpr = it.value === it.elem ? "$$this" : { $let: { vars: { [it.as]: "$$this" }, in: it.value } };
  return {
    $getField: {
      field: "out",
      input: {
        $reduce: {
          input,
          initialValue: { seen: [], out: [] },
          in: {
            $let: {
              vars: { [k]: keyExpr },
              in: {
                $cond: [
                  { $in: [key, "$$value.seen"] },
                  "$$value",
                  {
                    seen: { $concatArrays: ["$$value.seen", [key]] },
                    out: { $concatArrays: ["$$value.out", ["$$this"]] },
                  },
                ],
              },
            },
          },
        },
      },
    },
  };
}

/**
 * `.takeWhile` / `.dropWhile` from the LEFT: find the first element whose predicate is
 * falsy (`$indexOfArray` on the strict-boolified predicate array → -1 if none), then slice
 * on that boundary. The receiver is bound to an internal var; the caller passes the
 * (possibly reversed) array in. `drop` picks the keep-from-boundary slice; otherwise the
 * take-up-to-boundary slice.
 */
export function takeDropWhile(
  arrExpr: unknown,
  pred: ResolvedPredicate,
  drop: boolean,
  internalVar: (base: string) => [string, string],
): unknown {
  const [vArr, arr] = internalVar("arr");
  const [vFi, fi] = internalVar("fi");
  const preds = { $map: { input: arr, as: pred.as, in: { $cond: [pred.cond, true, false] } } };
  const body = drop
    ? { $cond: [{ $eq: [fi, -1] }, [], { $slice: [arr, fi, { $size: arr }] }] }
    : // take: the first `fi` elements. The 2-arg `$slice` (first-n) — NOT the 3-arg
      // `$slice: [arr, 0, fi]` — so a boundary at index 0 (the first element already fails
      // the predicate) is `$slice: [arr, 0]` → `[]`, instead of the 3-arg
      // `$slice: [arr, 0, 0]` mongod rejects ("count must be positive").
      { $cond: [{ $eq: [fi, -1] }, arr, { $slice: [arr, fi] }] };
  return {
    $let: { vars: { [vArr]: arrExpr }, in: { $let: { vars: { [vFi]: { $indexOfArray: [preds, false] } }, in: body } } },
  };
}

/**
 * Lower array `.slice(start, end?)` to MQL `$slice`, faithful to
 * `Array.prototype.slice`: `start`/`end` are indices (end **exclusive**) and
 * negatives count from the end. MongoDB's `$slice` is position+**count** based
 * (and its 3-arg count must be > 0), so we translate rather than pass the JS
 * args straight through. See docs/specs/method-dispatch.md.
 */
export function sliceArray(
  genObj: unknown,
  exprArgs: readonly Expr[],
  gen: Gen,
  internalVar: (base: string) => [string, string],
): unknown {
  if (exprArgs.length === 0) return genObj;

  const startNode = exprArgs[0];
  const startLit = literalIndexValue(startNode);

  // --- slice(start): every element from `start` to the end ---
  if (exprArgs.length === 1) {
    // Negative literal → last |start| elements: the 2-arg `$slice` primitive.
    if (startLit !== null && startLit < 0) return { $slice: [genObj, startLit] };
    // slice(0) is a whole-array copy.
    if (startLit === 0) return genObj;
    // Positive literal or runtime start → drop the first `start` (a runtime
    // negative start is resolved from the end by `$slice`'s position arg).
    // count = max(1, size) so an empty array is `$slice: [[], start, 1]` → []
    // rather than a rejected count of 0 (same guard as `.drop(n)`).
    const [vArr, arr] = internalVar("arr");
    return { $let: { vars: { [vArr]: genObj }, in: { $slice: [arr, gen(startNode), { $max: [1, { $size: arr }] }] } } };
  }

  // --- slice(start, end): elements at indices [start, end) ---
  const endNode = exprArgs[1];
  const endLit = literalIndexValue(endNode);

  // Both indices are non-negative literals → pure arithmetic, no `$size` needed.
  if (startLit !== null && startLit >= 0 && endLit !== null && endLit >= 0) {
    // start 0 → "first `end`". The 2-arg `$slice` tolerates a 0 count (→ []),
    // so no guard is needed and a 0-length slice needs no special case.
    if (startLit === 0) return { $slice: [genObj, endLit] };
    if (endLit <= startLit) return []; // empty range
    return { $slice: [genObj, startLit, endLit - startLit] };
  }

  // start 0 (literal), non-literal-or-negative end → "first `end`": resolve the
  // end index and lean on the 2-arg (count-tolerant) `$slice`.
  if (startLit === 0) {
    const [vArr, arr] = internalVar("arr");
    return {
      $let: { vars: { [vArr]: genObj }, in: { $slice: [arr, resolveSliceIndex(endNode, gen, { $size: arr })] } },
    };
  }

  // General case (negative start, or a runtime index): resolve both indices
  // against the length, take `end - start` elements from the resolved start,
  // and guard the empty range (the 3-arg `$slice` count must be > 0). The
  // slice's own count is `max(count, 1)` — never 0 — so that when the array is
  // a compile-time literal, MongoDB's optimizer can fold the (unselected) slice
  // branch instead of rejecting a constant 0-count `$slice`; the outer `$cond`
  // still returns `[]` for the empty range.
  const [vArr, arr] = internalVar("arr");
  const [vK, k] = internalVar("k");
  const [vF, f] = internalVar("f");
  const count = { $subtract: [f, k] };
  return {
    $let: {
      vars: { [vArr]: genObj },
      in: {
        $let: {
          vars: {
            [vK]: resolveSliceIndex(startNode, gen, { $size: arr }),
            [vF]: resolveSliceIndex(endNode, gen, { $size: arr }),
          },
          in: { $cond: [{ $gt: [count, 0] }, { $slice: [arr, k, { $max: [count, 1] }] }, []] },
        },
      },
    },
  };
}

/** Negate a count that's either a compile-time number or a runtime expression. */

/**
 * `.includes(x)` / `.indexOf(x)` search for a *value*; they don't take a
 * predicate (that's JS, not jsmql being strict). When the user passes a lambda
 * they meant the predicate sibling — `.some` (bool) for `.includes`,
 * `.findIndex` (index) for `.indexOf` — so point there. Without this the lambda
 * falls through to the generic "function only valid as a callback to an
 * iterating array method" rejection, which misleads because `.includes`/
 * `.indexOf` ARE array methods.
 */
export function rejectPredicateOnValueSearch(arg: Expr | undefined, method: string, sibling: string): void {
  if (arg?.type !== "Lambda") return;
  const p = arg.params[0] ?? "x";
  throw new CodegenError(
    `.${method}() searches for a value — it doesn't take a function. To test elements against a predicate, use .${sibling}(${p} => …).`,
    arg.pos,
  );
}
