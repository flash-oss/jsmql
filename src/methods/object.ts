// Object methods — the key/value reshapers.
//
// Nearly all of them work the same way: `$objectToArray` turns the document into `{k, v}`
// pairs, the pairs are transformed, and `$arrayToObject` puts it back. `.pick` is the
// exception — a fixed key list needs no round trip, so it field-selects directly.
//
// `.mapValues` / `.mapKeys` / `.pickBy` / `.omitBy` take a `(value[, key])` iteratee whose
// body lowers against a scope binding the pair, so they read it through the `objIteratee`
// service rather than resolving it themselves.
//
// See docs/specs/lowering-grid.md.

import type { Expr } from "../ast.ts";
import type { LowerInput, MethodDef } from "./types.ts";

/**
 * The field names in a `.pick(["a", "b"])` / `.omit([...])` argument.
 *
 * A `$`-prefixed string is an MQL field REFERENCE (HR1), not a name, so it is rejected
 * rather than silently treated as one.
 */
function pickKeys(arg: Expr, method: string, err: LowerInput["err"]): string[] {
  if (arg.type !== "ArrayLiteral") {
    throw err(`.${method}([keys]) takes an array of field-name strings, e.g. '.${method}(["name", "age"])'.`, arg.pos);
  }
  return arg.elements.map((el) => {
    if (el.type !== "StringLiteral" || el.value === "" || el.value.startsWith("$")) {
      throw err(`.${method}([keys]) entries must be plain field-name strings (no leading '$').`, el.pos);
    }
    return el.value;
  });
}

/**
 * `.mapValues(iteratee)` / `.mapKeys(iteratee)` — the round trip with one half replaced.
 *
 * `.mapKeys` stringifies its result because an object key must be a string.
 */
function pairMapper(half: "k" | "v"): MethodDef {
  return {
    receiver: "object",
    returns: "object",
    args: { sig: "iteratee", exact: 1 },
    value: ({ recv, args, objIteratee }) => {
      const { as, body } = objIteratee(args[0]);
      const entry = half === "v" ? { k: `$$${as}.k`, v: body } : { k: { $toString: body }, v: `$$${as}.v` };
      return { $arrayToObject: { $map: { input: { $objectToArray: recv }, as, in: entry } } };
    },
  };
}

/** `.pickBy(predicate)` / `.omitBy(predicate)` — keep or drop the pairs the predicate picks. */
function pairFilter(keep: boolean): MethodDef {
  return {
    receiver: "object",
    returns: "object",
    args: { sig: "predicate", exact: 1 },
    value: ({ recv, args, objIteratee }) => {
      const { as, body } = objIteratee(args[0]);
      return {
        $arrayToObject: { $filter: { input: { $objectToArray: recv }, as, cond: keep ? body : { $not: [body] } } },
      };
    },
  };
}

export const OBJECT_METHODS: Record<string, MethodDef> = {
  mapValues: pairMapper("v"),
  mapKeys: pairMapper("k"),
  pickBy: pairFilter(true),
  omitBy: pairFilter(false),

  invert: {
    receiver: "object",
    returns: "object",
    args: { sig: "", none: true },
    // Swap keys and values. The new keys are stringified because an object key must be a
    // string, and the last duplicate wins — both match lodash.
    value: ({ recv, internalVar }) => {
      const [as, kv] = internalVar("kv");
      return {
        $arrayToObject: {
          $map: { input: { $objectToArray: recv }, as, in: { k: { $toString: `${kv}.v` }, v: `${kv}.k` } },
        },
      };
    },
  },

  toPairs: {
    receiver: "object",
    returns: "array",
    args: { sig: "", none: true },
    value: ({ recv, internalVar }) => {
      const [as, kv] = internalVar("kv");
      return { $map: { input: { $objectToArray: recv }, as, in: [`${kv}.k`, `${kv}.v`] } };
    },
  },

  pick: {
    receiver: "object",
    returns: "object",
    args: { sig: "[keys]", exact: 1 },
    // A fixed key list needs no round trip: select each field into a fresh object. A key
    // the receiver does not have simply drops out, which is lodash's behaviour too.
    value: ({ recv, args, internalVar, err }) => {
      const keys = pickKeys(args[0], "pick", err);
      const [vObj, obj] = internalVar("obj");
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = { $getField: { field: k, input: obj } };
      return { $let: { vars: { [vObj]: recv }, in: out } };
    },
  },

  omit: {
    receiver: "object",
    returns: "object",
    args: { sig: "[keys]", exact: 1 },
    // The complement of `.pick`, and it cannot use the same trick: the keys to KEEP are
    // not known at compile time, so the pairs are filtered instead.
    value: ({ recv, args, internalVar, err }) => {
      const keys = pickKeys(args[0], "omit", err);
      const [as, kv] = internalVar("kv");
      return {
        $arrayToObject: {
          $filter: { input: { $objectToArray: recv }, as, cond: { $not: [{ $in: [`${kv}.k`, keys] }] } },
        },
      };
    },
  },
};
