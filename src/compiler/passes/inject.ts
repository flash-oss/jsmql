// INJECTION — the values a call supplies: the parameters of `jsmql.compile` and
// the `${…}` slots of the template tag. Each bound name in the tree becomes the
// value itself. It is spelled as a literal node when the source could have
// spelled it, so it folds and compares like anything written. Otherwise it is
// held as an `Injected` node — a Date, a binary, or anything that READS AS MQL
// (a string that starts with `$`, or a document with a `$`-key). HR1: an
// injected value is never an operator or a field reference. The value road
// wraps such a value in `$literal`, and the query road compares it as written.
// See docs/LANG_RULES.md.
import type { Expr, Program } from "../../registry/ast.ts";
import { asLiteral } from "./literal.ts";
import { isPlainObject, isRegExp } from "../../bson.ts";

/** Would the server read this value as MQL: a `$`-string, or a document that holds a `$`-key or such a string? */
export function isMqlShaped(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (typeof value === "string") return value.length > 0 && value.charCodeAt(0) === 36;
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((v) => isMqlShaped(v, seen));
  if (!isPlainObject(value)) return false;
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith("$") || isMqlShaped(v, seen)) return true;
  }
  return false;
}

/** A value as the node that spells it: a literal when the source could have spelled it, an `Injected` node otherwise. */
export function spellValue(value: unknown, pos: number): Expr {
  const literal = isMqlShaped(value) ? null : asLiteral(value, pos);
  // A RegExp the CALL supplies is the developer's own MongoDB regex. A query slot takes it as written,
  // and a value slot passes it through, where one typed in the source is a pattern for the regex methods.
  if (literal !== null && literal.type === "RegexLiteral" && isRegExp(value)) return { ...literal, injected: value };
  return literal ?? { type: "Injected", value, pos };
}

/**
 * The tree that replaces every reference to a bound name with its value. A lambda
 * parameter with the same name shadows the bound name. `inject` spells each value at the
 * position of its reference, so a refusal points at the name in the source.
 */
export function inject<T extends Program | Expr>(root: T, values: ReadonlyMap<string, unknown>): T {
  if (values.size === 0) return root;
  return replaceRefs(root, values, (name, pos) => spellValue(values.get(name), pos));
}

/**
 * The tree that replaces every reference to a name with the node that `nodes` gives for it.
 * A node from the source keeps its own positions. An `Injected` node takes the position of
 * the reference.
 */
export function replaceIdents<T extends object>(root: T, nodes: ReadonlyMap<string, Expr>): T {
  return replaceRefs(root, nodes, (name, pos) => {
    const n = nodes.get(name) as Expr;
    return n.type === "Injected" ? { ...n, pos } : n;
  });
}

/** The tree that replaces every reference to a key of `values` with `spell(name, pos)`. */
function replaceRefs<T extends object>(
  root: T,
  values: ReadonlyMap<string, unknown>,
  spell: (name: string, pos: number) => Expr,
): T {
  if (values.size === 0) return root;
  const walk = (node: unknown, shadow: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, shadow));
    if (node === null || typeof node !== "object") return node;
    const n = node as { type?: string; name?: string; params?: readonly string[]; pos?: number } & Record<
      string,
      unknown
    >;
    if (n.type === "Ident" && typeof n.name === "string" && values.has(n.name) && !shadow.has(n.name)) {
      return spell(n.name, n.pos ?? 0);
    }
    let inner = shadow;
    if (n.type === "Lambda" && Array.isArray(n.params)) {
      inner = new Set([...shadow, ...(n.params as readonly string[])]);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) out[k] = k === "type" || k === "params" ? v : walk(v, inner);
    return out;
  };
  return walk(root, new Set()) as T;
}
