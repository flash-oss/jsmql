// SUBSTITUTION: every free reference to a name that holds a constant becomes the value
// itself. The fold uses it for the declarations it settled, and the constant engine
// (evaluate.ts) uses it for the constants it was lent.
//
// Two things it must never do. It must not cross a binder of the same name — a lambda
// parameter or a declaration in a nested scope is a DIFFERENT variable. It must also not
// touch an identifier that NAMES something rather than values it: `a.p = 9` names a place,
// and `g(1)` names a function. Replacing either with its value produces `1 = 9` or `3(1)`,
// and neither is a program.

import { bindsFor, namesSomething } from "./naming.ts";
import { nodeOf } from "./literal.ts";
import { mapTreeIn } from "./walk.ts";

type Any = { type: string } & Record<string, unknown>;

/** What travels down the tree while substituting. */
type Scope = { shadowed: ReadonlySet<string>; naming: boolean };

/**
 * `root` with every free reference to a name of `values` replaced by the node that holds
 * the value. The same reference comes back when nothing was replaced.
 */
export function substitute<T extends object>(root: T, values: ReadonlyMap<string, unknown>): T {
  const start: Scope = { shadowed: new Set(), naming: false };

  // An identifier that NAMES something is never substituted — the same test
  // position.ts uses to keep those slots out of value position. See naming.ts.
  const step = (node: object, key: string, here: Scope): Scope => {
    const naming = namesSomething(node, key);
    const names = bindsFor(node, key);
    if (names.length === 0) {
      return naming === here.naming ? here : { shadowed: here.shadowed, naming };
    }
    const shadowed = new Set(here.shadowed);
    for (const name of names) shadowed.add(name);
    return { shadowed, naming: naming || here.naming };
  };

  return mapTreeIn(root, start, step, (node, scope) => {
    const n = node as Any;
    if (n.type !== "Ident" || typeof n.name !== "string") return node;
    if (scope.naming || scope.shadowed.has(n.name)) return node;
    if (!values.has(n.name)) return node;
    // A constant is a whole value that JSMQL owns, so its strings are text (HR6).
    return nodeOf(values.get(n.name), n.pos as number, true) as object;
  });
}
