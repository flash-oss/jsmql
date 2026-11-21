import { constructibleNames, isGlobalName, positionsOf } from "../rows.ts";
import { introducedNames } from "./naming.ts";
import { isPlainObject } from "../../bson.ts";
import { noNewKeyword, unknownClass } from "../emit/errors.ts";

type Node = { type: string; pos: number } & Record<string, unknown>;

const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string";

function nodesOf(root: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(root)) {
    for (const v of root) nodesOf(v, out);
    return out;
  }
  if (typeof root !== "object" || root === null) return out;
  if (!isPlainObject(root)) return out;
  if (isNode(root)) out.push(root);
  for (const v of Object.values(root)) nodesOf(v, out);
  return out;
}

export function refuseNew(program: object): void {
  const nodes = nodesOf(program);
  const bound = new Set(nodes.flatMap((n) => introducedNames(n)));
  const refused = nodes
    .filter((n) => n.type === "NewExpression")
    .sort((a, b) => a.pos - b.pos)
    .find((n) => {
      const callee = n.callee as Node;
      if (callee.type !== "Ident") return true;
      const name = callee.name as string;
      return !bound.has(name) && (!isGlobalName(name) || (positionsOf(name)?.length ?? 0) > 0);
    });
  if (refused === undefined) return;
  const callee = refused.callee as Node;
  if (callee.type !== "Ident") throw noNewKeyword(null, refused.pos);
  const name = callee.name as string;
  if (!isGlobalName(name)) throw unknownClass(name, constructibleNames(), refused.pos);
  throw noNewKeyword(name, refused.pos);
}
