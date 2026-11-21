import type { Expr, Program } from "../../registry/ast.ts";
import { asLiteral } from "./literal.ts";
import { bsonTagOf, isPlainObject, isRegExp } from "../../bson.ts";

export function isMqlShaped(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (typeof value === "string") return value.length > 0 && value.charCodeAt(0) === 36;
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((v) => isMqlShaped(v, seen));
  if (bsonTagOf(value) === "DBRef") return true;
  if (!isPlainObject(value)) return false;
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith("$") || isMqlShaped(v, seen)) return true;
  }
  return false;
}

export function spellValue(value: unknown, pos: number): Expr {
  const literal = isMqlShaped(value) ? null : asLiteral(value, pos);
  if (literal !== null && literal.type === "RegexLiteral" && isRegExp(value)) return { ...literal, injected: value };
  return literal ?? { type: "Injected", value, pos };
}

export function inject<T extends Program | Expr>(root: T, values: ReadonlyMap<string, unknown>): T {
  if (values.size === 0) return root;
  return replaceRefs(root, values, (name, pos) => spellValue(values.get(name), pos));
}

export function replaceIdents<T extends object>(root: T, nodes: ReadonlyMap<string, Expr>): T {
  return replaceRefs(root, nodes, (name, pos) => {
    const n = nodes.get(name) as Expr;
    return n.type === "Injected" ? { ...n, pos } : n;
  });
}

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
