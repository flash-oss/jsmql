import type { Arity, ArgType, Emit, Family, FieldFamily, Kind, Refusal, Rule } from "../../registry/vocabulary.ts";
import { FIELD_FAMILY_TYPES } from "../../registry/vocabulary.ts";
import type { Expr } from "../../registry/vocabulary.ts";
import type { Verdict } from "./consult.ts";
import { familiesFor } from "./consult.ts";
import { isMutator } from "../rows.ts";
import { faultOf } from "../kinds.ts";
import type { KindFault, Proofs } from "../kinds.ts";
import { constantOf } from "../passes/evaluate.ts";
import { staticKey } from "../passes/naming.ts";
import { internalError } from "../../errors.ts";

export { kindFits, UNPROVEN } from "../kinds.ts";
export type { KindFault, Proofs } from "../kinds.ts";

export type AnyRule = Rule<unknown, unknown>;
export type AnyEmit = Emit<unknown, unknown>;

export type Receiver =
  | { readonly kind: "none" }
  | { readonly kind: "namespace"; readonly name: Family }
  | { readonly kind: "stream" }
  | { readonly kind: "value"; readonly family: FieldFamily; readonly lowered: unknown }
  | {
      readonly kind: "opaque";
      readonly lowered: unknown;
      readonly proved?: string;
      readonly possible?: readonly FieldFamily[];
    };

export type Shaped =
  | { readonly kind: "spread" }
  | { readonly kind: "none" }
  | { readonly kind: "multiple" }
  | { readonly kind: "object"; readonly keys: readonly string[] }
  | { readonly kind: "constant"; readonly value: unknown }
  | { readonly kind: "dynamic" };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function shapeOf(args: readonly Expr[]): Shaped {
  if (args.some((a) => (a as { type: string }).type === "SpreadElement")) return { kind: "spread" };
  if (args.length === 0) return { kind: "none" };
  if (args.length > 1) return { kind: "multiple" };
  const only = args[0] as { type: string; entries?: readonly object[] };
  if (only.type === "ObjectLiteral") {
    const keys = (only.entries ?? []).map(staticKey).filter((k): k is string => k !== null);
    return { kind: "object", keys };
  }
  const v = constantOf(args[0]);
  return v.ok ? { kind: "constant", value: v.value } : { kind: "dynamic" };
}

export type Selected =
  | { readonly kind: "rule"; readonly name: string; readonly rule: AnyRule; readonly family?: FieldFamily }
  | { readonly kind: "refused"; readonly name: string; readonly message: string; readonly needsSubject: boolean }
  | { readonly kind: "fallback"; readonly name: string }
  | { readonly kind: "composedOnly"; readonly name: string; readonly owners: readonly string[] }
  | { readonly kind: "noCell"; readonly name: string }
  | { readonly kind: "unknown"; readonly name: string }
  | {
      readonly kind: "wrongReceiver";
      readonly name: string;
      readonly got: string | null;
      readonly accepts: readonly Family[] | "any";
    }
  | { readonly kind: "spreadRefused"; readonly name: string; readonly sig: string }
  | { readonly kind: "wrongCount"; readonly name: string; readonly got: number; readonly args: Arity }
  | { readonly kind: "rejectedCount"; readonly name: string; readonly message: string }
  | { readonly kind: "wrongKind"; readonly name: string; readonly fault: KindFault };

const FIELD_FAMILIES = Object.keys(FIELD_FAMILY_TYPES) as readonly FieldFamily[];
const isFieldFamily = (f: string): f is FieldFamily => (FIELD_FAMILIES as readonly string[]).includes(f);

const isRefusal = (v: unknown): v is Refusal => isObj(v) && typeof v.unsupported === "string";
const isRule = (v: unknown): v is AnyRule => isObj(v) && typeof v.emit === "function" && isObj(v.args);

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

function settle(
  name: string,
  branch: unknown,
  shaped: Shaped,
  count: number,
  proofs: Proofs,
  family?: FieldFamily,
): Selected {
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
    kindFault(name, branch.args, proofs) ??
    (family === undefined ? { kind: "rule", name, rule: branch } : { kind: "rule", name, rule: branch, family })
  );
}

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

function receiverGate(name: string, receiver: Receiver): Selected | null {
  const on = familiesFor(name);
  if (on === undefined) return null;
  if (on === "any")
    return receiver.kind === "namespace" ? { kind: "wrongReceiver", name, got: receiver.name, accepts: on } : null;
  if (receiver.kind === "opaque") {
    if (receiver.proved !== undefined) return { kind: "wrongReceiver", name, got: receiver.proved, accepts: on };
    if (receiver.possible !== undefined && !receiver.possible.some((f) => on.includes(f))) {
      return { kind: "wrongReceiver", name, got: receiver.possible.join(" or "), accepts: on };
    }
    return on.some(isFieldFamily) ? null : { kind: "wrongReceiver", name, got: null, accepts: on };
  }
  const family = familyOf(receiver);
  if (family !== null && on.includes(family)) return null;
  return { kind: "wrongReceiver", name, got: family, accepts: on };
}

function fromByArgs(
  name: string,
  byArgs: Record<string, unknown>,
  shaped: Shaped,
  count: number,
  proofs: Proofs,
): Selected {
  const otherwise = byArgs.otherwise;
  if (!isRefusal(otherwise)) internalError(`the row '${name}' states a byArgs cell without its 'otherwise'`);
  const leftover = (): Selected => settle(name, otherwise, shaped, count, proofs);
  switch (shaped.kind) {
    case "spread":
      return leftover();
    case "constant":
      return byArgs.constant === undefined ? leftover() : settle(name, byArgs.constant, shaped, count, proofs);
    default: {
      const entry = byArgs[shaped.kind];
      return entry === undefined ? leftover() : settle(name, entry, shaped, count, proofs);
    }
  }
}

function kindFault(name: string, rule: Arity, proofs: Proofs): Selected | null {
  const fault = faultOf(name, rule, proofs);
  return fault === null ? null : { kind: "wrongKind", name, fault };
}

function fromPerFamily(
  name: string,
  branches: Readonly<Record<string, unknown>>,
  receiver: Receiver,
  shaped: Shaped,
  count: number,
  proofs: Proofs,
): Selected {
  const on = familiesFor(name);
  if (receiver.kind !== "opaque") {
    const family = familyOf(receiver);
    const branch = family === null ? undefined : branches[family];
    if (branch === undefined) return { kind: "wrongReceiver", name, got: family, accepts: on ?? "any" };
    return settle(
      name,
      branch,
      shaped,
      count,
      proofs,
      isFieldFamily(family as string) ? (family as FieldFamily) : undefined,
    );
  }
  const accepted = (
    on === undefined || on === "any" ? FIELD_FAMILIES : on.filter(isFieldFamily)
  ) as readonly FieldFamily[];
  const possible = receiver.possible;
  const listed = possible === undefined ? accepted : accepted.filter((f) => possible.includes(f));
  if (possible !== undefined && listed.length === 0) {
    return { kind: "wrongReceiver", name, got: possible.join(" or "), accepts: on ?? "any" };
  }
  const lowering = listed.filter((f) => !isRefusal(branches[f]));
  const families = lowering.length > 0 ? lowering : listed;
  if (families.length === 0) return { kind: "wrongReceiver", name, got: null, accepts: on ?? "any" };
  if (lowering.length > 1) {
    internalError(`the row '${name}' lowers on ${lowering.join(" and ")}. A row lowers on one field family`);
  }
  return settle(name, branches[families[0]], shaped, count, proofs, families[0]);
}

export function select(verdict: Verdict, receiver: Receiver, shaped: Shaped, count: number, proofs: Proofs): Selected {
  const name = verdict.name;
  switch (verdict.kind) {
    case "unknown":
      return { kind: "unknown", name };
    case "refused": {
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
      const gate = receiverGate(name, receiver);
      if (gate !== null) return gate;
      return (verdict.args === undefined ? null : kindFault(name, verdict.args, proofs)) ?? { kind: "noCell", name };
    }
    case "perFamily":
      return fromPerFamily(name, verdict.branches, receiver, shaped, count, proofs);
    case "lower": {
      const gate = receiverGate(name, receiver);
      if (gate !== null) return gate;
      const cell = verdict.cell;
      if (isObj(cell) && isObj(cell.byArgs)) return fromByArgs(name, cell.byArgs, shaped, count, proofs);
      return settle(name, cell, shaped, count, proofs);
    }
  }
}
