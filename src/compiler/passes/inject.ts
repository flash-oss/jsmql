// INJECTION — the values a call supplies: the parameters of `jsmql.compile` and
// the `${…}` slots of the template tag. Each bound name in the tree becomes the
// value itself: spelled as a literal node when the source could have spelled it
// (so it folds and compares like anything written), and otherwise held as an
// `Injected` node — a Date, a binary, or anything that READS AS MQL (a string
// starting with `$`, a document with a `$`-key). HR1: an injected value is never
// an operator or a field reference; the value road wraps such a value in
// `$literal`, and the query road compares it as written. See docs/LANG_RULES.md.
import type { Expr, Program } from "../../registry/ast.ts";
import { asLiteral } from "./literal.ts";

/** Would the server read this value as MQL — a `$`-string, or a document holding a `$`-key or such a string? */
export function isMqlShaped(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (typeof value === "string") return value.length > 0 && value.charCodeAt(0) === 36;
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((v) => isMqlShaped(v, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith("$") || isMqlShaped(v, seen)) return true;
  }
  return false;
}

/** A value as the node that spells it: a literal when the source could have, an `Injected` node otherwise. */
export function spellValue(value: unknown, pos: number): Expr {
  const literal = isMqlShaped(value) ? null : asLiteral(value, pos);
  return literal ?? { type: "Injected", value, pos };
}

/** The tree with every reference to a bound name replaced by its value. A lambda parameter of the same name shadows it. */
export function inject<T extends Program | Expr>(root: T, values: ReadonlyMap<string, unknown>): T {
  if (values.size === 0) return root;
  const nodes = new Map<string, Expr>();
  for (const [name, value] of values) nodes.set(name, spellValue(value, 0));
  return replaceIdents(root, nodes);
}

/** The tree with every reference to a name replaced by the node given for it — at the reference's own position. */
export function replaceIdents<T extends Program | Expr>(root: T, nodes: ReadonlyMap<string, Expr>): T {
  if (nodes.size === 0) return root;
  const spell = (name: string, pos: number): Expr => {
    const n = nodes.get(name) as Expr;
    return n.type === "Injected" ? { ...n, pos } : n;
  };
  const values = nodes;
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
