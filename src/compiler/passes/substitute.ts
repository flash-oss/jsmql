import { bindsFor, namesSomething } from "./naming.ts";
import { nodeOf } from "./literal.ts";
import { mapTreeIn } from "./walk.ts";

type Any = { type: string } & Record<string, unknown>;

type Scope = { shadowed: ReadonlySet<string>; naming: boolean };

export function substitute<T extends object>(root: T, values: ReadonlyMap<string, unknown>): T {
  const start: Scope = { shadowed: new Set(), naming: false };

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
    return nodeOf(values.get(n.name), n.pos as number, true) as object;
  });
}
