// Phase 5 — EMIT. This module picks which rule of a row runs, and how, once the
// receiver and the arguments are known.
//
// consult.ts reads a row and answers for a NAME in a POSITION. Two axes remain,
// and both need facts a row cannot see: the receiver's FAMILY (a proof the
// lowering of the receiver produced) and the arguments' SHAPE (a partition over
// the call's argument list). This module resolves both and hands back one closed
// answer. Nothing here builds a document. A `dispatch` answer carries the guards
// as functions of the bound receiver, and the caller assembles the `$switch`.
//
// The receiver's family is PROVEN or it is not. A literal proves it. A producing
// row's measured `returns` proves it. A field path proves nothing. An unprovable
// receiver on a row with one field family IS that family — `$.price.ceil()` is a
// number because `.ceil()` is. On a row with two or more families it takes the runtime
// dispatch, with the row's own `uncertain` as the default. A name never decides this.

import type {
  Arity,
  ArgType,
  BsonType,
  Emit,
  Family,
  FieldFamily,
  Kind,
  Refusal,
  Rule,
} from "../../registry/vocabulary.ts";
import { FIELD_FAMILY_TYPES } from "../../registry/vocabulary.ts";
import type { Expr } from "../../registry/vocabulary.ts";
import type { Verdict } from "./consult.ts";
import { familiesFor } from "./consult.ts";
import { isMutator } from "../rows.ts";
import { evaluate, type Constants } from "../passes/evaluate.ts";
import { staticKey } from "../passes/naming.ts";
import { internalError } from "../../errors.ts";

/** A rule as this module reads it. Its `In`/`Out` are the caller's business. */
export type AnyRule = Rule<unknown, unknown>;
export type AnyEmit = Emit<unknown, unknown>;

/** What is known about the receiver. A closed union. The caller proves it, and this module reads it. */
export type Receiver =
  /** A bare call — `Number(x)`, `$abs(x)`, `assert(…)`. */
  | { readonly kind: "none" }
  /** A static namespace — `Math.max(…)`, `Object.keys(…)`. */
  | { readonly kind: "namespace"; readonly name: Family }
  /** The `$$` stream. */
  | { readonly kind: "stream" }
  /** A value whose family is PROVEN, already lowered. */
  | { readonly kind: "value"; readonly family: FieldFamily; readonly lowered: unknown }
  /**
   * A value whose family is not provable — a field path, an unknown-typed binding —
   * or one PROVEN to hold a kind no method family has (`proved`: a boolean, an
   * ObjectId). Every field-family row refuses this receiver.
   *
   * `possible` names the field families the value CAN be, when the proof shows
   * several: `cond ? "a" : [1]` is a string or an array, and the dispatch runs over
   * those two alone. `present` says the value is certainly there, so a dispatch
   * that covers every possible kind needs no default. Absent, the value can be
   * anything, and the dispatch runs over every family the row lists.
   */
  | {
      readonly kind: "opaque";
      readonly lowered: unknown;
      readonly proved?: string;
      readonly possible?: readonly FieldFamily[];
      /** Does `possible` name EVERY kind the value can be? False when a kind no family covers is possible too. */
      readonly exact?: boolean;
      readonly present?: boolean;
    };

/** The class of the argument list. A PARTITION — see `shapeOf` for the order. */
export type Shaped =
  | { readonly kind: "spread" }
  | { readonly kind: "none" }
  | { readonly kind: "multiple" }
  | { readonly kind: "object"; readonly keys: readonly string[] }
  | { readonly kind: "constant"; readonly value: unknown }
  | { readonly kind: "dynamic" };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * The class a call's arguments fall in, decided in one order so no two classes
 * can claim one call: a spread anywhere → none → more than one → one object
 * literal → one constant → one dynamic. `constants` is what the fold left bound
 * (a `jsmql.compile` parameter is a runtime value, so it lands in `dynamic`).
 */
export function shapeOf(args: readonly Expr[], constants: Constants = new Map()): Shaped {
  if (args.some((a) => (a as { type: string }).type === "SpreadElement")) return { kind: "spread" };
  if (args.length === 0) return { kind: "none" };
  if (args.length > 1) return { kind: "multiple" };
  const only = args[0] as { type: string; entries?: readonly object[] };
  if (only.type === "ObjectLiteral") {
    const keys = (only.entries ?? []).map(staticKey).filter((k): k is string => k !== null);
    return { kind: "object", keys };
  }
  const v = evaluate(args[0], constants);
  return v.ok ? { kind: "constant", value: v.value } : { kind: "dynamic" };
}

/** One runtime branch of a dispatch: the family, its test on the bound receiver, and its rule. */
export type Branch = {
  readonly family: FieldFamily;
  readonly guard: (recv: unknown) => unknown;
  readonly rule: AnyRule;
};

/** The one answer. Every variant is final, except `rule` and `dispatch`, which name what to run. */
export type Selected =
  /** `family` is the FIELD family the rule runs on, when a per-family cell chose it: the receiver's proof, or the one branch left. */
  | { readonly kind: "rule"; readonly name: string; readonly rule: AnyRule; readonly family?: FieldFamily }
  /**
   * Two or more field families could hold the receiver: one `$switch`, with the
   * row's `uncertain` as the default. `complete` says the branches cover every
   * kind the receiver can be, and the value is there — so the default can never
   * fire, and the consumer drops it. See docs/specs/types.md § The dispatch.
   */
  | {
      readonly kind: "dispatch";
      readonly name: string;
      readonly branches: readonly Branch[];
      readonly otherwise: AnyEmit | Refusal;
      readonly complete: boolean;
    }
  | { readonly kind: "refused"; readonly name: string; readonly message: string; readonly needsSubject: boolean }
  | { readonly kind: "fallback"; readonly name: string }
  | { readonly kind: "composedOnly"; readonly name: string; readonly owners: readonly string[] }
  | { readonly kind: "noCell"; readonly name: string }
  | { readonly kind: "unknown"; readonly name: string }
  /** The row lists receivers, and this is not one of them — `$.n.trim()` with `n` proven a number. */
  | {
      readonly kind: "wrongReceiver";
      readonly name: string;
      readonly got: string | null;
      readonly accepts: readonly Family[] | "any";
    }
  /** A spread reached a rule that reads its arguments one by one. */
  | { readonly kind: "spreadRefused"; readonly name: string; readonly sig: string }
  /** The count is not one the rule takes. `args` carries the signature to quote. */
  | { readonly kind: "wrongCount"; readonly name: string; readonly got: number; readonly args: Arity }
  /** The count parses, but the row has a reason to refuse it — `args.reject[n]`. */
  | { readonly kind: "rejectedCount"; readonly name: string; readonly message: string };

// ── the runtime guards: one per field family, held complete by the type ──────

/** The `$type` names each field family covers — the one table of the vocabulary. */
const TYPES: Readonly<Record<FieldFamily, readonly BsonType[]>> = FIELD_FAMILY_TYPES;

/**
 * The runtime test that the bound receiver holds `family`, widened by the
 * rule's own `alsoTypes`. One shape serves every family: `$type` against a list.
 * `$type` answers "missing" for an absent field, so the widening reads
 * as list membership rather than as a second construct per family.
 */
export function guardFor(family: FieldFamily, also: readonly BsonType[] = []): (recv: unknown) => unknown {
  const types = [...TYPES[family], ...also];
  return (recv) => ({ $in: [{ $type: recv }, types] });
}

const FIELD_FAMILIES = Object.keys(TYPES) as readonly FieldFamily[];
const isFieldFamily = (f: string): f is FieldFamily => (FIELD_FAMILIES as readonly string[]).includes(f);

// ── reading a cell's parts ───────────────────────────────────────────────────

const isRefusal = (v: unknown): v is Refusal => isObj(v) && typeof v.unsupported === "string";
const isRule = (v: unknown): v is AnyRule => isObj(v) && typeof v.emit === "function" && isObj(v.args);

/** Does `n` satisfy the rule's count? The compiler reads the `reject` map first, because it gives the more specific answer. */
function countOf(name: string, args: Arity, n: number): Selected | null {
  const rejected = args.reject?.[n];
  if (rejected !== undefined) return { kind: "rejectedCount", name, message: rejected };
  const ok =
    args.none === true
      ? n === 0
      : args.exact !== undefined
        ? n === args.exact
        : args.allowed !== undefined
          ? args.allowed.includes(n)
          : args.atLeast !== undefined
            ? n >= args.atLeast
            : true;
  return ok ? null : { kind: "wrongCount", name, got: n, args };
}

/** A resolved branch — a rule or a refusal — checked against the argument list. */
function settle(name: string, branch: unknown, shaped: Shaped, count: number, family?: FieldFamily): Selected {
  if (isRefusal(branch)) {
    return { kind: "refused", name, message: branch.unsupported, needsSubject: branch.subjectFromCaller === true };
  }
  if (!isRule(branch)) internalError(`the row '${name}' holds a cell part that is neither a rule nor a refusal`);
  if (shaped.kind === "spread") {
    if (branch.args.spread === true) {
      internalError(`a spread reached '${name}'. Its rule reads one array argument, and the desugar pass packs it`);
    }
    return { kind: "spreadRefused", name, sig: branch.args.sig };
  }
  return (
    countOf(name, branch.args, count) ??
    (family === undefined ? { kind: "rule", name, rule: branch } : { kind: "rule", name, rule: branch, family })
  );
}

/** The family a receiver names for a per-family cell. Null for a bare call. */
function familyOf(receiver: Receiver): Family | null {
  switch (receiver.kind) {
    case "none":
      return null;
    case "namespace":
      return receiver.name;
    case "stream":
      return "stream";
    case "value":
      return receiver.family;
    case "opaque":
      return null;
  }
}

/** Does the row's `on` admit this receiver? `undefined` (no `on`) and `"any"` admit every receiver. */
function receiverGate(name: string, receiver: Receiver): Selected | null {
  const on = familiesFor(name);
  if (on === undefined || on === "any") return null;
  if (receiver.kind === "opaque") {
    if (receiver.proved !== undefined) return { kind: "wrongReceiver", name, got: receiver.proved, accepts: on };
    // A receiver that can be several families passes when the row takes one of them; one
    // whose every possible family the row refuses is refused, and the message names them all.
    if (receiver.possible !== undefined && !receiver.possible.some((f) => on.includes(f))) {
      return { kind: "wrongReceiver", name, got: receiver.possible.join(" or "), accepts: on };
    }
    return on.some(isFieldFamily) ? null : { kind: "wrongReceiver", name, got: null, accepts: on };
  }
  const family = familyOf(receiver);
  if (family !== null && on.includes(family)) return null;
  return { kind: "wrongReceiver", name, got: family, accepts: on };
}

function fromByArgs(name: string, byArgs: Record<string, unknown>, shaped: Shaped, count: number): Selected {
  const otherwise = byArgs.otherwise;
  if (!isRefusal(otherwise)) internalError(`the row '${name}' states a byArgs cell without its 'otherwise'`);
  const leftover = (): Selected => settle(name, otherwise, shaped, count);
  switch (shaped.kind) {
    case "spread":
      return leftover();
    case "constant":
      return byArgs.constant === undefined ? leftover() : settle(name, byArgs.constant, shaped, count);
    default: {
      const entry = byArgs[shaped.kind];
      return entry === undefined ? leftover() : settle(name, entry, shaped, count);
    }
  }
}

/**
 * Can a value PROVEN to be `kind` fill a slot that takes `expected`? An unproven
 * value can fill any slot, and the server judges it. A `fieldName` or a `fieldPath`
 * slot reads a string, and a date slot takes a date alone.
 */
export function kindFits(kind: Kind | "unknown", expected: ArgType | readonly ArgType[]): boolean {
  if (kind === "unknown") return true;
  if (Array.isArray(expected)) return (expected as readonly ArgType[]).some((t) => kindFits(kind, t));
  switch (expected as ArgType) {
    case "number":
    case "int":
    case "int-or-long":
      return kind === "number";
    case "number-or-date":
      return kind === "number" || kind === "date";
    case "string":
    case "fieldName":
    case "fieldPath":
      return kind === "string";
    case "bool":
    case "array":
    case "object":
    case "date":
      return kind === expected;
    case "timestamp":
      return false;
  }
}

/** Does a proven argument kind rule this branch out — a string slot handed a number? */
const argsFit = (rule: AnyRule, kinds: readonly (Kind | "unknown")[]): boolean =>
  Object.entries(rule.args.slotType ?? {}).every(([i, t]) => {
    const k = kinds[Number(i)];
    return k === undefined || kindFits(k, t);
  });

function fromPerFamily(
  name: string,
  branches: Readonly<Record<string, unknown>>,
  uncertain: unknown,
  receiver: Receiver,
  shaped: Shaped,
  count: number,
  kinds: readonly (Kind | "unknown")[],
): Selected {
  const on = familiesFor(name);
  if (receiver.kind !== "opaque") {
    const family = familyOf(receiver);
    const branch = family === null ? undefined : branches[family];
    if (branch === undefined) return { kind: "wrongReceiver", name, got: family, accepts: on ?? "any" };
    return settle(name, branch, shaped, count, isFieldFamily(family as string) ? (family as FieldFamily) : undefined);
  }
  // An unprovable receiver. With one field family in `on`, the receiver IS that
  // family. With two or more, the compiler runs the runtime dispatch, in the row's
  // own order, over the families that hold a rule, with the row's `uncertain` as the
  // default. A receiver whose proof names its possible families narrows the list to
  // those; one that names none of the row's families is refused.
  const accepted = (
    on === undefined || on === "any" ? FIELD_FAMILIES : on.filter(isFieldFamily)
  ) as readonly FieldFamily[];
  const possible = receiver.possible;
  const listed = possible === undefined ? accepted : accepted.filter((f) => possible.includes(f));
  if (possible !== undefined && listed.length === 0) {
    return { kind: "wrongReceiver", name, got: possible.join(" or "), accepts: on ?? "any" };
  }
  // A `$switch` separates only what `$type` tells apart: `set` and `array` share the
  // one test, so no branch can choose between them. The row's declaration order gives its
  // precedence, so the first family with a given test answers. The family that loses
  // is reached through its PROVEN receiver above (`new Set(…)` is proven at the source).
  // A family the row REFUSES cannot be the family of a receiver in a program that
  // compiles, so `.keys()` on an unproven field is a call on an object. The refused
  // families stay only when nothing else is left, so that the refusal is what answers.
  const lowering = listed.filter((f) => !isRefusal(branches[f]));
  const tests = new Set<string>();
  const fieldFamilies = (lowering.length > 0 ? lowering : listed).filter((family) => {
    const test = TYPES[family].join(",");
    if (tests.has(test)) return false;
    tests.add(test);
    return true;
  });
  if (fieldFamilies.length === 0) return { kind: "wrongReceiver", name, got: null, accepts: on ?? "any" };
  // A branch whose slot cannot take a PROVEN argument kind is not the branch the
  // call means: `.indexOf(1)` searches an array, because `$indexOfCP` takes a string.
  // The receiver's proof, then the argument's, then the runtime test — in that order.
  // One branch left by the argument runs on its own, by the same claim a one-family
  // row makes: the call is on that family, or the server raises an error.
  const fitting = fieldFamilies.filter((f) => {
    const b = branches[f];
    return !isRule(b) || argsFit(b, kinds);
  });
  if (fitting.length === 1 && fieldFamilies.length > 1) {
    const branch = branches[fitting[0]];
    if (branch === undefined) return { kind: "wrongReceiver", name, got: null, accepts: on ?? "any" };
    return settle(name, branch, shaped, count, fitting[0]);
  }
  // Does the row take EVERY kind the value can be? Only then can a lone branch run
  // with no test, and only then can a dispatch drop its default. A possible kind
  // the row has no branch for — a number under `.indexOf` — falls to the default.
  const covered = possible !== undefined && receiver.exact === true && possible.every((f) => listed.includes(f));
  // One family left, and the value can be nothing else: the rule runs directly. So does
  // a row with ONE field family and no `uncertain`: the call is on that family, or the
  // server raises an error — the row's own claim, whatever else the value could be.
  if (fieldFamilies.length === 1 && (possible === undefined || covered || uncertain === undefined)) {
    const branch = branches[fieldFamilies[0]];
    if (branch === undefined) return { kind: "wrongReceiver", name, got: null, accepts: on ?? "any" };
    return settle(name, branch, shaped, count, fieldFamilies[0]);
  }
  if (!(typeof uncertain === "function" || isRefusal(uncertain))) {
    internalError(`the row '${name}' lists ${fieldFamilies.length} field families and states no 'uncertain'`);
  }
  const out: Branch[] = [];
  for (const family of fieldFamilies) {
    const branch = branches[family];
    if (isRefusal(branch) || branch === undefined) continue;
    if (!isRule(branch)) internalError(`the row '${name}' holds an unreadable '${family}' branch`);
    const bad = shaped.kind === "spread" ? settle(name, branch, shaped, count) : countOf(name, branch.args, count);
    if (bad !== null && bad.kind !== "rule") return bad;
    out.push({ family, guard: guardFor(family, branch.alsoTypes ?? []), rule: branch });
  }
  // The default fires for a null or missing value, and for a possible kind no
  // branch takes. Neither can happen when the value is there and every possible
  // family has a branch.
  const complete =
    covered &&
    receiver.present === true &&
    possible.every((f) => out.some((b) => b.family === f || TYPES[b.family].join(",") === TYPES[f].join(",")));
  return { kind: "dispatch", name, branches: out, otherwise: uncertain as AnyEmit | Refusal, complete };
}

/**
 * The one answer for a verdict, a receiver and an argument list. `count` is the
 * number of arguments as written. The shape says which class applies, and the count says
 * whether the rule takes that many arguments.
 */
export function select(
  verdict: Verdict,
  receiver: Receiver,
  shaped: Shaped,
  count: number,
  /** The PROVEN kind of each positional argument, `"unknown"` where the proof says nothing. */
  kinds: readonly (Kind | "unknown")[] = [],
): Selected {
  const name = verdict.name;
  switch (verdict.kind) {
    case "unknown":
      return { kind: "unknown", name };
    case "refused": {
      // A row's own refusal is the better answer, and it wins — EXCEPT for a mutator,
      // whose refusal is advice about arrays: `.sort()` says to write `.toSorted()`,
      // which is sound for an array and wrong for `$.s.trim()`, a string that has
      // neither. There the receiver answers first, the same as it does for `inCode` below.
      const gate = isMutator(name) ? receiverGate(name, receiver) : null;
      return gate ?? { kind: "refused", name, message: verdict.message, needsSubject: verdict.needsSubject };
    }
    case "fallback":
      return { kind: "fallback", name };
    case "composedOnly":
      return { kind: "composedOnly", name, owners: verdict.owners };
    case "noCell":
      return { kind: "noCell", name };
    case "inCode": {
      // A pass owns this cell, so there is no rule to read. The RECEIVER still
      // answers: '$$.pop()' is a stream where the row states an array, and the
      // reader must hear that fact, not that a pass declined the node.
      const gate = receiverGate(name, receiver);
      return gate ?? { kind: "noCell", name };
    }
    case "perFamily":
      return fromPerFamily(name, verdict.branches, verdict.uncertain, receiver, shaped, count, kinds);
    case "lower": {
      const gate = receiverGate(name, receiver);
      if (gate !== null) return gate;
      const cell = verdict.cell;
      if (isObj(cell) && isObj(cell.byArgs)) return fromByArgs(name, cell.byArgs, shaped, count);
      return settle(name, cell, shaped, count);
    }
  }
}
