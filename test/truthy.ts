// Hand-written mirror of the codegen-side `jsBool()` helper (src/codegen.ts), for
// expected values in tests. JS truthy/falsy: false, null (or missing), "", and 0 are
// falsy; everything else is truthy.
//
// This is deliberately a SECOND implementation rather than an import of the real one:
// a test that built its expectation from the code under test would pass no matter what
// that code emitted. Kept in one module so a change to the rule is one edit here plus
// the codegen, not a sweep of every suite that asserts a predicate shape.

/** `jsBool(v)` — the wrap every boolean position gets when the value isn't provably bool. */
export const truthy = (v: unknown) => ({
  $and: [{ $ne: [{ $ifNull: [v, null] }, null] }, { $ne: [v, false] }, { $ne: [v, ""] }, { $ne: [v, 0] }],
});

/** `generateBool` of a `&&` chain: `$and` of the boolified operands, spliced flat. */
export const truthyAnd = (...vs: unknown[]) => ({ $and: vs.flatMap((v) => truthy(v).$and) });

/** `generateBool` of a `||` chain: `$or` of the boolified operands (no splice — the
 *  operands are `$and`s, a different connective). */
export const truthyOr = (...vs: unknown[]) => ({ $or: vs.map((v) => truthy(v)) });
