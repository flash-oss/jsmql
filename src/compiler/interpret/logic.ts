// The logic operators, the scope operators and `$literal`.
//
// MongoDB truthiness: null, 0 and false are false. Everything else is true,
// and also the empty string and the empty array. A condition that holds a
// value the interpreter does not read (a Long, a Decimal128) is a refusal.
//
// A branch that the answer does not need is never evaluated. So `$cond: [true, 1, { $divide: [1, 0] }]`
// is 1, as in JavaScript. The server folds every constant branch before it runs
// the expression, so it fails on the division in the branch that is not taken. This is
// the one place where the interpreter answers and the server does not.
// See the DIVERGE table in test/compiler-interpret-agrees.test.ts.

import type { Answer, Rule, Walk } from "./values.ts";
import { Failed, NO, isPlain, isValue, ok, spellable, truthOf } from "./values.ts";
import { argsOf, isVariableName, keyed, positional } from "./operand.ts";

/** The truth of one expression, as an answer that holds a boolean, or the reason that it has none. */
function truth(walk: Walk, node: unknown): Answer {
  const a = walk.raw(node);
  if (!a.ok) return a;
  const t = truthOf(a.value);
  return t === null ? NO : ok(t);
}

/** `$and` stops at the first false operand, and `$or` at the first true one. */
const connective =
  (stopOn: boolean): Rule =>
  (operand, walk) => {
    const nodes = argsOf(operand);
    for (const [i, node] of nodes.entries()) {
      const t = truth(walk, node);
      if (!t.ok) return t;
      if (t.value === stopOn) return ok(stopOn);
    }
    return ok(!stopOn);
  };

const IF_THEN_ELSE = ["if", "then", "else"] as const;

/** `$cond` has a list form `[if, then, else]` and a keyed form. */
const cond: Rule = (operand, walk) => {
  let nodes: readonly unknown[];
  if (Array.isArray(operand)) {
    nodes = operand;
  } else if (isPlain(operand)) {
    const keys = Object.keys(operand);
    if (keys.length !== 3 || !IF_THEN_ELSE.every((k) => keys.includes(k))) return NO;
    nodes = IF_THEN_ELSE.map((k) => operand[k]);
  } else {
    return NO;
  }
  if (nodes.length !== 3) return NO;
  const test = truth(walk, nodes[0]);
  if (!test.ok) return test;
  return walk.raw(test.value ? nodes[1] : nodes[2]);
};

/** `$switch` tries each branch in order. With no branch and no default, the server raises an error. */
const switchRule = keyed(["branches"], ["default"], (parts, walk) => {
  const branches = parts.branches;
  if (!Array.isArray(branches) || branches.length === 0) return NO;
  for (const branch of branches) {
    if (!isPlain(branch)) return NO;
    const keys = Object.keys(branch);
    if (keys.length !== 2 || !keys.includes("case") || !keys.includes("then")) return NO;
  }
  const all = branches as Record<string, unknown>[];
  for (const branch of all) {
    const t = truth(walk, branch.case);
    if (!t.ok) return t;
    if (!t.value) continue;
    return walk.raw(branch.then);
  }
  return "default" in parts ? walk.raw(parts.default) : NO;
});

/** `$ifNull` answers the first operand that is not null. The last operand is the answer when all others are null. */
const ifNull: Rule = (operand, walk) => {
  const nodes = argsOf(operand);
  if (nodes.length < 2) return NO;
  for (const node of nodes.slice(0, -1)) {
    const a = walk.raw(node);
    if (!a.ok || a.value !== null) return a;
  }
  return walk.raw(nodes[nodes.length - 1]);
};

/**
 * `$let` evaluates every variable in the OUTER scope, then evaluates `in` with all of them bound.
 * A variable with no value fails only the expression that reads it.
 */
const letRule = keyed(["vars", "in"], [], (parts, walk) => {
  const vars = parts.vars;
  if (!isPlain(vars)) return NO;
  const bound: Record<string, unknown> = Object.create(null);
  for (const [name, node] of Object.entries(vars)) {
    if (!isVariableName(name)) return NO;
    const a = walk.raw(node);
    bound[name] = a.ok ? a.value : new Failed(a);
  }
  return walk.raw(parts.in, bound);
});

export const LOGIC: Record<string, Rule> = {
  $and: connective(false),
  $or: connective(true),
  $not: positional(
    1,
    1,
    ([v]) => {
      const t = truthOf(v);
      return t === null ? NO : ok(!t);
    },
    true,
  ),
  $cond: cond,
  $switch: switchRule,
  $ifNull: ifNull,
  $let: letRule,
  // The value is not an expression: it passes through as written.
  $literal: (operand) => (isValue(operand) ? spellable(operand) : NO),
};
