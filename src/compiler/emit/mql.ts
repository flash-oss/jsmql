import type { QueryDoc, Truth } from "../../registry/vocabulary.ts";
import type { MongoVar } from "./names.ts";
import { constantOf } from "./mode.ts";

export const cond = (test: Truth, then: unknown, otherwise: unknown): unknown => {
  const c = constantOf(test);
  if (c !== null) return c ? then : otherwise;
  return { $cond: [test, then, otherwise] };
};

export const filter = (input: unknown, as: MongoVar, test: Truth, limit?: unknown): unknown => {
  const c = constantOf(test);
  if (c === false) return [];
  if (c === true && limit === undefined) return input;
  return { $filter: limit === undefined ? { input, as, cond: test } : { input, as, cond: test, limit } };
};

const liveBranches = (
  branches: readonly { readonly case: Truth; readonly then: unknown }[],
): { readonly kept: { readonly case: Truth; readonly then: unknown }[]; readonly decided: unknown | undefined } => {
  const kept: { readonly case: Truth; readonly then: unknown }[] = [];
  for (const b of branches) {
    const c = constantOf(b.case);
    if (c === false) continue;
    if (c === true) return { kept, decided: b.then };
    kept.push(b);
  }
  return { kept, decided: undefined };
};

export const switchOn = (
  candidates: readonly { readonly case: Truth; readonly then: unknown }[],
  otherwise: unknown,
): unknown => {
  const { kept: branches, decided } = liveBranches(candidates);
  const fallback = decided === undefined ? otherwise : decided;
  const one = JSON.stringify(fallback);
  if (branches.every((b) => JSON.stringify(b.then) === one)) return fallback;
  return { $switch: { branches: branches.map((b) => ({ case: b.case, then: b.then })), default: fallback } };
};

export const matchExpr = (test: Truth): QueryDoc => ({ $expr: test });

export const letOne = (as: MongoVar, value: unknown, body: unknown): unknown => ({
  $let: { vars: { [as]: value }, in: body },
});

export const readsRef = (mql: unknown, ref: string): boolean => {
  if (typeof mql === "string") return mql === ref || mql.startsWith(`${ref}.`);
  if (Array.isArray(mql)) return mql.some((m) => readsRef(m, ref));
  if (mql !== null && typeof mql === "object") return Object.values(mql).some((m) => readsRef(m, ref));
  return false;
};
