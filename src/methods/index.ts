// The method registry: every family file assembled into one lookup.
//
// One file per family, not one per kind and not one per method. A single file would
// recreate the 7 000-line module this structure replaces, and concurrent work would
// collide in it; a file per method would scatter the family-level facts a family file
// states once.
//
// A family file that nobody imports is silently absent, which is the class of failure the
// grid exists to remove — so `test/methods-grid.test.ts` asserts every file under
// `src/methods/` reaches this assembly.
//
// See docs/specs/lowering-grid.md.

import { DATE_ACCESSOR_METHODS } from "./date-accessors.ts";
import { LODASH_ARRAY_METHODS } from "./lodash-array.ts";
import { LODASH_STRING_METHODS } from "./lodash-string.ts";
import { NUMBER_METHODS } from "./number.ts";
import { OBJECT_METHODS } from "./object.ts";
import { STRING_METHODS } from "./string.ts";
import type { MethodDef } from "./types.ts";

/** Every family, in the order a reader would look for them. */
const FAMILIES: Record<string, Record<string, MethodDef>> = {
  "date-accessors": DATE_ACCESSOR_METHODS,
  "lodash-array": LODASH_ARRAY_METHODS,
  "lodash-string": LODASH_STRING_METHODS,
  number: NUMBER_METHODS,
  object: OBJECT_METHODS,
  string: STRING_METHODS,
};

/** The names each family declares — used by the completeness tests. */
export const METHOD_FAMILIES: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(FAMILIES).map(([family, defs]) => [family, Object.keys(defs)]),
);

// A NULL-prototype object, deliberately. A plain `{}` inherits `toString`, `valueOf`,
// `toLocaleString` and friends, and `METHODS` contains names that collide with them — so
// `lookupMethod("toLocaleString")` would return `Object.prototype.toLocaleString`, a
// truthy function with no `args`, and dispatch would hand it to the arity checker.
const REGISTRY: Record<string, MethodDef> = Object.assign(Object.create(null), ...Object.values(FAMILIES));

/** A method's declaration, or undefined while it still lives in the codegen switch. */
export function lookupMethod(name: string): MethodDef | undefined {
  // The null prototype already makes a bare lookup safe; the explicit guard keeps it
  // safe if this ever becomes a plain object again.
  return Object.prototype.hasOwnProperty.call(REGISTRY, name) ? REGISTRY[name] : undefined;
}

/** Every declared method name. */
export function declaredMethodNames(): readonly string[] {
  return Object.keys(REGISTRY);
}
