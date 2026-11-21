import { introducedNames } from "./naming.ts";

type Slot = unknown;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function namesIn(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const el of node) namesIn(el, out);
    return out;
  }
  if (!isObj(node)) return out;
  if (node.type === "Ident" && typeof node.name === "string") out.add(node.name);
  for (const name of introducedNames(node)) out.add(name);
  for (const v of Object.values(node) as Slot[]) namesIn(v, out);
  return out;
}

export function freshParam(base: string, ...mentions: readonly unknown[]): string {
  const taken = new Set<string>();
  for (const m of mentions) namesIn(m, taken);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = base + String(n);
    if (!taken.has(candidate)) return candidate;
  }
}
