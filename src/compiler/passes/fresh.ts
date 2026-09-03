// A lambda parameter that cannot capture.
//
// A rewrite that BUILDS a lambda has to name its parameter, and the name it picks
// lands in the same flat scope as everything around it:
//   $.items.filter({ a: n })   →   $.items.filter(n => n.a === n)
//                                                  ^^^^^^^^^^^^^ `n` now means
// the element, and the binding the developer meant is unreachable. The MQL is
// valid and the answer is wrong, which is the worst shape a bug can take.
//
// Shadowing only matters for names the BODY mentions, and a synthesised body
// mentions exactly what the rewrite splices into it. So the whole question is
// answerable from the arguments in hand — no scope, no gensym counter, no state.

import { introducedNames } from "./naming.ts";

/** A node, a list of them, or a leaf. */
type Slot = unknown;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Every bare name the tree mentions — `Ident`, and a lambda's own parameters.
 *
 * A lambda's parameters count even though they are bound inside it: a
 * synthesised parameter that shadows one would change which binding the inner
 * lambda's body sees.
 */
export function namesIn(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const el of node) namesIn(el, out);
    return out;
  }
  if (!isObj(node)) return out;
  if (node.type === "Ident" && typeof node.name === "string") out.add(node.name);
  // A lambda's parameters, a declaration's name — see `introducedNames`.
  for (const name of introducedNames(node)) out.add(name);
  for (const v of Object.values(node) as Slot[]) namesIn(v, out);
  return out;
}

/**
 * `base`, or `base` with the lowest suffix that nothing in `mentions` uses.
 *
 * The suffix starts at 2 so the common answer is the bare name: a shorthand
 * whose arguments name nothing — `$.items.map("name")` — reads as `x => x.name`
 * and its MQL as `$$x`, not as a mangled compiler name.
 */
export function freshParam(base: string, ...mentions: readonly unknown[]): string {
  const taken = new Set<string>();
  for (const m of mentions) namesIn(m, taken);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = base + String(n);
    if (!taken.has(candidate)) return candidate;
  }
}
