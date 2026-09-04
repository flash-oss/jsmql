// The registry's TYPE contracts, each one made to fail.
//
// A type-level audit that has never failed proves nothing: a conditional that
// matches no row passes forever. So every rule the vocabulary states as a type
// stands here twice — once as a value that must compile, once under a
// `@ts-expect-error` that must NOT. tsc refuses an unused `@ts-expect-error`
// (TS2578), so a rule that stops firing fails this file in either direction.
// test/registry-contracts.test.ts runs it.

import type { Cell, ExprIn, Family, FilterIn, FilterOut, OutOf, Truth } from "../../src/registry/vocabulary.ts";
import { pending, unsupported } from "../../src/registry/vocabulary.ts";

const A = { sig: "", none: true } as const;
const R = { args: A, emit: () => 1 };

type Value<F extends Family> = Cell<true, F, ExprIn, OutOf["value"]>;

// ── `uncertain`: required with two field families, refused with one ──────────

export const twoFamilies: Value<"array" | "string"> = { perFamily: { array: R, string: R }, uncertain: () => 1 };
// @ts-expect-error — two field families and no `uncertain`: the unprovable receiver is undecided
export const twoFamiliesUndecided: Value<"array" | "string"> = { perFamily: { array: R, string: R } };

export const oneFamily: Value<"array" | "Math"> = { perFamily: { array: R, Math: R } };
// @ts-expect-error — one field family: the receiver IS that family by the row's own claim
export const oneFamilyOverstated: Value<"array" | "Math"> = { perFamily: { array: R, Math: R }, uncertain: () => 1 };

// A refusal and a pending are decisions too.
export const uncertainRefused: Value<"array" | "string"> = {
  perFamily: { array: R, string: R },
  uncertain: unsupported("cannot tell"),
};
export const uncertainPending: Value<"array" | "string"> = {
  perFamily: { array: R, string: R },
  uncertain: pending("src/x.ts"),
};

// ── `byArgs`: keyed, `constant` never a rule, the leftover stated ─────────────

export const keyed: Value<"array"> = {
  byArgs: { dynamic: R, constant: unsupported("did not fold"), otherwise: unsupported("no") },
};
// @ts-expect-error — a constant that reached a row did not fold; the row refuses, never lowers
export const constantLowered: Value<"array"> = { byArgs: { constant: R, otherwise: unsupported("no") } };
// @ts-expect-error — the leftover class is stated, so a hole is a decision
export const noLeftover: Value<"array"> = { byArgs: { dynamic: R } };
// @ts-expect-error — an ordered list is not a partition
export const ordered: Value<"array"> = { byArgs: [{ when: "dynamic", ...R }], otherwise: unsupported("no") };

// ── filter: null only where a value form exists to fall back on ──────────────

type Filter<HasValue extends boolean> = Cell<true, "string", FilterIn, FilterOut<HasValue>>;

export const withValueForm: Filter<true> = { args: A, emit: () => null };
export const filterOnly: Filter<false> = { args: A, emit: ({ name }) => ({ [name]: 1 }) };
// @ts-expect-error — a filter-only row has no value form; its renderer is total
export const filterOnlyNull: Filter<false> = { args: A, emit: () => null };

// ── Truth is minted by `truth()`, never written ──────────────────────────────

// @ts-expect-error — a document is not a Truth until the mode module has read it
export const notATruth: Truth = { $gt: ["$a", 1] };
export const readTruth = (input: ExprIn): Truth => input.truth(input.args[0]);

// ── the old renderer surface is gone ─────────────────────────────────────────

// @ts-expect-error — `gen` is the `value` service
export const oldGen: Value<"array"> = { args: A, emit: ({ gen }) => gen };
// @ts-expect-error — `hoists` is the `hoist` service a renderer calls
export const oldHoists: Value<"array"> = { args: A, hoists: () => [], emit: () => 1 };
