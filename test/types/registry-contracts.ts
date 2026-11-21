import type { Arity, Cell, ExprIn, Family, FilterIn, FilterOut, OutOf, Truth } from "../../src/registry/vocabulary.ts";
import { unsupported } from "../../src/registry/vocabulary.ts";
import type { FieldSlot, MongoVar, VarRef } from "../../src/compiler/emit/names.ts";
import type { MongoRow, StageFacts } from "../../src/registry/names.ts";
import { Scope, mongoVarName, systemRef } from "../../src/compiler/emit/names.ts";
import { ANY } from "../../src/compiler/emit/type.ts";
import { Chain, Env, type Site } from "../../src/compiler/emit/env.ts";
import { and, boolTruth, jsTruthy } from "../../src/compiler/emit/mode.ts";
import { cond, filter, matchExpr } from "../../src/compiler/emit/mql.ts";

const A = { sig: "", none: true } as const;
const R = { args: A, emit: () => 1 };

type Value<F extends Family> = Cell<true, F, ExprIn, OutOf["value"]>;

export const typedSlots: Arity = {
  sig: "a, b[, …]",
  atLeast: 2,
  slotType: { 0: "element", 1: ["array", "object"] },
  rest: ["number", "string"],
  homogeneous: true,
};
// @ts-expect-error — a slot kind that no type names
export const unnamedKind: Arity = { sig: "a", exact: 1, rest: "text" };
// @ts-expect-error — `homogeneous` is a flag that is true or absent
export const homogeneousOff: Arity = { sig: "a, b", exact: 2, homogeneous: false };

export const oneFamily: Value<"array" | "Math"> = { perFamily: { array: R, Math: R } };
// @ts-expect-error — a family that `on` omits cannot appear
export const strayFamily: Value<"array"> = { perFamily: { array: R, string: R } };

export const keyed: Value<"array"> = {
  byArgs: { dynamic: R, constant: unsupported("did not fold"), otherwise: unsupported("no") },
};
export const constantLowered: Value<"array"> = { byArgs: { constant: R, otherwise: unsupported("no") } };
// @ts-expect-error — the leftover class is stated, so a hole is a decision
export const noLeftover: Value<"array"> = { byArgs: { dynamic: R } };
// @ts-expect-error — an ordered list is not a partition
export const ordered: Value<"array"> = { byArgs: [{ when: "dynamic", ...R }], otherwise: unsupported("no") };

type Filter<HasValue extends boolean> = Cell<true, "string", FilterIn, FilterOut<HasValue>>;

export const withValueForm: Filter<true> = { args: A, emit: () => null };
export const filterOnly: Filter<false> = { args: A, emit: ({ name }) => ({ [name]: 1 }) };
// @ts-expect-error — a filter-only row has no value form; its renderer is total
export const filterOnlyNull: Filter<false> = { args: A, emit: () => null };

// @ts-expect-error — a document is not a Truth until the mode module has read it
export const notATruth: Truth = { $gt: ["$a", 1] };
export const readTruth = (input: ExprIn): Truth => input.truth(input.args[0]);

// @ts-expect-error — `gen` is the `value` service
export const noGen: Value<"array"> = { args: A, emit: ({ gen }) => gen };
// @ts-expect-error — `hoists` is the `hoist` service a renderer calls
export const noHoists: Value<"array"> = { args: A, hoists: () => [], emit: () => 1 };

// @ts-expect-error — a MongoVar is minted by `mongoVarName`, never written as a string
export const notAVar: MongoVar = "x";
// @ts-expect-error — a `$$name` read cannot be spliced where a bare `as` belongs
export const readAsBinder: MongoVar = systemRef("ROOT");
// @ts-expect-error — a field slot is built by `fieldSlot`, never as a literal
export const notASlot: FieldSlot = { path: "__jsmql.tmp.1", ref: "$__jsmql.tmp.1" };
export const minted: MongoVar = mongoVarName("_id");
export const read: VarRef = Scope.root([]).param("x", ANY, 0, 0).ref;

export const stageRow: StageFacts = { bodyPositions: { "": "value" }, document: "keeps", evaluates: [] };
export const valueRow: StageFacts = {};
// @ts-expect-error — a layout without the document effect: the scope tracker would have to guess
export const layoutAlone: StageFacts = { bodyPositions: { "": "value" }, evaluates: [] };
// @ts-expect-error — a document effect on a row that is not a stage
export const effectAlone: StageFacts = { document: "keeps" };
// @ts-expect-error — a stage without its evaluated paths: HR1's gate then guesses which slots it may wrap
export const noEvaluates: StageFacts = { bodyPositions: { "": "value" }, document: "keeps" };
// @ts-expect-error — evaluated paths on a row that is not a stage
export const evaluatesAlone: StageFacts = { evaluates: [""] };

const operand = { args: { sig: "operand", exact: 1 }, emit: () => ({}) } as const;
export const mongoRow: MongoRow<readonly ["value"]> = { doc: "d", where: ["value"], expr: operand };
// @ts-expect-error — a listed position without its rule
export const mongoRuleMissing: MongoRow<readonly ["value"]> = { doc: "d", where: ["value"] };
export const mongoRefusal: MongoRow<readonly ["value"]> = {
  doc: "d",
  where: ["value"],
  expr: operand,
  // @ts-expect-error — a refusal on a position that `where` omits
  group: unsupported("x"),
};

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export const siteIsTotal: Eq<Site, Required<Site>> = true;

const env = Env.root({ type: "Program", stmts: [] }, "value", new Chain());
// @ts-expect-error — an Env is made from an Env; there is no literal for one
export const literalEnv: Env = { scope: env.scope, site: env.site, chain: env.chain };
// @ts-expect-error — a spread drops the nominal mark; a copy is not an Env
export const spreadEnv: Env = { ...env };
export const derived: Env = env.at({ at: "filter" }).literal();

// @ts-expect-error — a lowered value has not been read for truth
export const condOfValue = cond({ $gt: ["$a", 1] }, 1, 2);
// @ts-expect-error — a field reference is a value, and "" would read as true
export const filterOfValue = filter("$items", mongoVarName("x"), "$$x.ok");
// @ts-expect-error — `$expr` reads its operand for truth
export const exprOfValue = matchExpr("$a");
// @ts-expect-error — `&&` combines truths, not values
export const andOfValues = and("$a", "$b");
export const condOfTruth = cond(jsTruthy("$a"), 1, 2);
export const condOfBool = cond(boolTruth({ $gt: ["$a", 1] }), 1, 2);

export const valueKind: Arity = { sig: "value", exact: 1, slotType: { 0: "value" } };
// @ts-expect-error — "defined" is no kind; "value" is every kind but null
export const definedKind: Arity = { sig: "value", exact: 1, slotType: { 0: "defined" } };
