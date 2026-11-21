import type { Answer, Rule, Walk } from "./values.ts";
import { NO, isPlain } from "./values.ts";

export const argsOf = (operand: unknown): readonly unknown[] => (Array.isArray(operand) ? operand : [operand]);

export function evalAll(walk: Walk, nodes: readonly unknown[], anyOrder = false): Answer {
  const values: unknown[] = [];
  for (const node of nodes) {
    const a = anyOrder ? walk.raw(node) : walk.at(node);
    if (!a.ok) return a;
    values.push(a.value);
  }
  return { ok: true, value: values };
}

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

export const isVariableName = (name: unknown): name is string =>
  typeof name === "string" && /^[a-z][A-Za-z0-9_]*$/.test(name);
