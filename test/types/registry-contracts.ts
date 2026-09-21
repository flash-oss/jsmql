// The registry's TYPE contracts, each one made to fail.
//
// A type-level audit that has never failed proves nothing: a conditional that
// matches no row passes forever. So every rule the vocabulary states as a type
// stands here twice — once as a value that must compile, once under a
// `@ts-expect-error` that must NOT. tsc refuses an unused `@ts-expect-error`
// (TS2578), so a rule that stops firing fails this file in either direction.
// test/registry-contracts.test.ts runs it.

import type { Cell, ExprIn, Family, FilterIn, FilterOut, OutOf, Truth } from "../../src/registry/vocabulary.ts";
import { unsupported } from "../../src/registry/vocabulary.ts";
import type { FieldSlot, MongoVar, VarRef } from "../../src/compiler/emit/names.ts";
import type { StageFacts } from "../../src/registry/names.ts";
import { Scope, mongoVarName, systemRef } from "../../src/compiler/emit/names.ts";
import { ANY } from "../../src/compiler/emit/type.ts";
import { Chain, Env, type Site } from "../../src/compiler/emit/env.ts";
import { and, jsTruthy, truthOf } from "../../src/compiler/emit/mode.ts";
import { cond, filter, matchExpr } from "../../src/compiler/emit/mql.ts";

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

// A refusal is a decision too.
export const uncertainRefused: Value<"array" | "string"> = {
  perFamily: { array: R, string: R },
  uncertain: unsupported("cannot tell"),
};

// ── `byArgs`: keyed, `constant` never a rule, the leftover stated ─────────────

export const keyed: Value<"array"> = {
  byArgs: { dynamic: R, constant: unsupported("did not fold"), otherwise: unsupported("no") },
};
// a constant may be lowered (`Number("3")` converts on the server, a double) or refused
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

// ── a cell has no renderer surface ───────────────────────────────────────────

// @ts-expect-error — `gen` is the `value` service
export const noGen: Value<"array"> = { args: A, emit: ({ gen }) => gen };
// @ts-expect-error — `hoists` is the `hoist` service a renderer calls
export const noHoists: Value<"array"> = { args: A, hoists: () => [], emit: () => 1 };

// ── the naming brands: a string is not a variable, a read is not a binder ────

// @ts-expect-error — a MongoVar is minted by `mongoVarName`, never written as a string
export const notAVar: MongoVar = "x";
// @ts-expect-error — a `$$name` read cannot be spliced where a bare `as` belongs
export const readAsBinder: MongoVar = systemRef("ROOT");
// @ts-expect-error — a field slot is built by `fieldSlot`, never as a literal
export const notASlot: FieldSlot = { path: "__jsmql.tmp.1", ref: "$__jsmql.tmp.1" };
export const minted: MongoVar = mongoVarName("_id");
export const read: VarRef = Scope.root([]).param("x", ANY, 0, 0).ref;

// ── a stage row states its `document` effect with its `body`, never one alone ──

export const stageRow: StageFacts = { body: { required: [], optional: [], closed: false }, document: "keeps" };
export const valueRow: StageFacts = {};
// @ts-expect-error — a body without the document effect: the scope tracker would have to guess
export const bodyAlone: StageFacts = { body: { required: [], optional: [], closed: false } };
// @ts-expect-error — a document effect on a row that is not a stage
export const effectAlone: StageFacts = { document: "keeps" };

// ── the environment record: nothing optional, no literal, no spread ──────────

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** A Site has no optional field: a literal that omits one cannot type-check. */
export const siteIsTotal: Eq<Site, Required<Site>> = true;

const env = Env.root({ type: "Program", stmts: [] }, "value", new Chain());
// @ts-expect-error — an Env is made from an Env; there is no literal for one
export const literalEnv: Env = { scope: env.scope, site: env.site, chain: env.chain };
// @ts-expect-error — spreading drops the nominal mark; a copy is not an Env
export const spreadEnv: Env = { ...env };
export const derived: Env = env.at({ at: "filter" }).literal();

// ── a condition slot takes a Truth, never a value ────────────────────────────

// @ts-expect-error — a lowered value has not been read for truth
export const condOfValue = cond({ $gt: ["$a", 1] }, 1, 2);
// @ts-expect-error — a field reference is a value, and "" would read as true
export const filterOfValue = filter("$items", mongoVarName("x"), "$$x.ok");
// @ts-expect-error — `$expr` reads its operand for truth
export const exprOfValue = matchExpr("$a");
// @ts-expect-error — `&&` combines truths, not values
export const andOfValues = and("$a", "$b");
export const condOfTruth = cond(jsTruthy("$a"), 1, 2);
export const condOfBool = cond(truthOf({ $gt: ["$a", 1] }, true), 1, 2);
