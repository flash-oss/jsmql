// How a rule reads the operand of its operator.
//
// MongoDB gives an operator one of two operand shapes. A POSITIONAL operator
// takes a list of expressions: `{ $abs: x }` and `{ $abs: [x] }` are one call.
// A KEYED operator takes a document of named parts, such as `{ input, in }`.
// These two helpers read each shape once, so no rule repeats the reading.

import type { Answer, Rule, Walk } from "./values.ts";
import { NO, isPlain } from "./values.ts";

/** The expressions of a positional operand. A list is the argument list, and any other value is one argument. */
export const argsOf = (operand: unknown): readonly unknown[] => (Array.isArray(operand) ? operand : [operand]);

/**
 * Every expression, left to right. The first one with no value stops the walk. A value that
 * holds a set answer stops it too, unless the rule reads nothing of the order (`anyOrder`).
 */
export function evalAll(walk: Walk, nodes: readonly unknown[], anyOrder = false): Answer {
  const values: unknown[] = [];
  for (const node of nodes) {
    const a = anyOrder ? walk.raw(node) : walk.at(node);
    if (!a.ok) return a;
    values.push(a.value);
  }
  return { ok: true, value: values };
}

/**
 * A rule over the VALUES of a positional operand. The operator takes between `min`
 * and `max` arguments, and every argument is evaluated before the rule runs.
 * The rule also receives the arguments as written, for a fact that no value holds.
 * A rule that reads nothing of the order of an array sets `anyOrder`. See `Walk`.
 */
export function positional(
  min: number,
  max: number,
  run: (values: unknown[], written: readonly unknown[], walk: Walk) => Answer,
  anyOrder = false,
): Rule {
  return (operand, walk) => {
    const nodes = argsOf(operand);
    if (nodes.length < min || nodes.length > max) return NO;
    const all = evalAll(walk, nodes, anyOrder);
    return all.ok ? run(all.value as unknown[], nodes, walk) : all;
  };
}

/**
 * A rule over a keyed operand. Each key must be in `required` or in `optional`,
 * and every required key must be there. The rule receives the parts as written,
 * because a part such as `in` or `cond` is evaluated once for each element.
 */
export function keyed(
  required: readonly string[],
  optional: readonly string[],
  run: (parts: Record<string, unknown>, walk: Walk) => Answer,
): Rule {
  return (operand, walk) => {
    if (!isPlain(operand)) return NO;
    const keys = Object.keys(operand);
    if (!keys.every((k) => required.includes(k) || optional.includes(k))) return NO;
    if (!required.every((k) => keys.includes(k))) return NO;
    return run(operand, walk);
  };
}

/** The name of a user variable: the server accepts a lower-case letter first, then letters, digits and underscores. */
export const isVariableName = (name: unknown): name is string =>
  typeof name === "string" && /^[a-z][A-Za-z0-9_]*$/.test(name);
