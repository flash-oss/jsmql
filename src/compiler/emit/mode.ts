import type { Truth, Type } from "../../registry/vocabulary.ts";
import { ANY, isNothing, mayBe } from "./type.ts";
import { isNotNullish } from "../../registry/mql.ts";

const mint = (doc: unknown): Truth => doc as Truth;

export const TRUE: Truth = mint(true);
export const FALSE: Truth = mint(false);

export const constantOf = (t: Truth): boolean | null => (t === TRUE ? true : t === FALSE ? false : null);

export const boolTruth = (doc: unknown): Truth => mint(doc);

export const mongoTruthy = (value: unknown): Truth => mint(value);

export function truthOf(value: unknown, type: Type): Truth {
  if (isNothing(type)) return FALSE;
  const kinds = type.kinds;
  if (kinds !== "any" && [...kinds].every((k) => k === "bool" || k === "number")) return mint(value);
  const tests: unknown[] = [];
  if (type.absent) tests.push(isNotNullish(value));
  if (mayBe(type, "bool")) tests.push({ $ne: [value, false] });
  if (mayBe(type, "string")) tests.push({ $ne: [value, ""] });
  if (mayBe(type, "number")) tests.push({ $ne: [value, 0] });
  if (tests.length === 0) return TRUE;
  if (tests.length === 1) return mint(tests[0]);
  return mint({ $and: tests });
}

export const jsTruthy = (value: unknown): Truth => truthOf(value, ANY);

export const asValue = (t: Truth): unknown => t;

const operandsOf = (op: "$and" | "$or", t: Truth): readonly Truth[] => {
  const doc = t as unknown as Record<string, unknown>;
  const inner = typeof doc === "object" && doc !== null ? doc[op] : undefined;
  return Array.isArray(inner) ? (inner as Truth[]) : [t];
};

export function and(...ts: readonly Truth[]): Truth {
  if (ts.some((t) => t === FALSE)) return FALSE;
  const live = ts.filter((t) => t !== TRUE);
  if (live.length === 0) return TRUE;
  if (live.length === 1) return live[0];
  return mint({ $and: live.flatMap((t) => operandsOf("$and", t)) });
}

export function or(...ts: readonly Truth[]): Truth {
  if (ts.some((t) => t === TRUE)) return TRUE;
  const live = ts.filter((t) => t !== FALSE);
  if (live.length === 0) return FALSE;
  if (live.length === 1) return live[0];
  return mint({ $or: live.flatMap((t) => operandsOf("$or", t)) });
}

export const not = (t: Truth): Truth => (t === TRUE ? FALSE : t === FALSE ? TRUE : mint({ $not: t }));
