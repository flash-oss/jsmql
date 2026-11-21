import { type AssignOp, type BinaryOp, type Expr, type UpdateFilter, ASSIGN_OPS } from "../../registry/ast.ts";
import { ParseError } from "../parse/cursor.ts";
import { parseExpression } from "../parse/parser.ts";
import {
  arrayLiteralOrderOf,
  immutableTwinOf,
  isFieldProperty,
  isCallable,
  isGlobalName,
  iterateeSlotsOf,
  namespaceNames,
  mutatorFormOf,
  packsSpreadOf,
  picksOneOf,
  receiverFamily,
} from "../rows.ts";
import { freshParam } from "./fresh.ts";
import { chainBase, readsAContextRef, writtenField } from "./naming.ts";
import { isSlotLayout } from "../../registry/vocabulary.ts";
import type { Where } from "./position.ts";
import { edge } from "./position.ts";
import { mapTreeIn } from "./walk.ts";

export type Rule = { name: string; apply: (node: object, where: Where) => object };

const COMPOUND: ReadonlyMap<string, BinaryOp> = new Map(
  ASSIGN_OPS.filter((op) => op.length > 1 && op.endsWith("=")).map((op) => [op, op.slice(0, -1) as BinaryOp]),
);

function writesACollection(target: Expr): boolean {
  const base = chainBase(target) as { type: string };
  return base.type === "DatabaseRef" || base.type === "ClusterRef";
}

const compoundAssign: Rule = {
  name: "fieldAssignment",
  apply: (node, where) => {
    if (where.at === "updateDoc") return node;
    const n = node as { type: string; op?: AssignOp; target?: object; value?: Expr; pos?: number };
    if (n.type !== "AssignExpr" || n.op === undefined) return node;
    const binop = COMPOUND.get(n.op);
    if (binop === undefined) return node;
    if (writesACollection(n.target as Expr)) return node;
    return {
      type: "AssignExpr",
      target: { ...(n.target as object) },
      op: "=",
      value: { type: "BinaryExpr", op: binop, left: n.target, right: n.value, pos: n.pos },
      pos: n.pos,
    } as object;
  },
};

const incDec: Rule = {
  name: "increment",
  apply: (node, where) => {
    if (where.at === "updateDoc") return node;
    const n = node as { type: string; op?: AssignOp; target?: object; pos?: number };
    if (n.type !== "AssignExpr") return node;
    if (n.op !== "++" && n.op !== "--") return node;
    return {
      type: "AssignExpr",
      target: { ...(n.target as object) },
      op: "=",
      value: {
        type: "BinaryExpr",
        op: n.op === "++" ? "+" : "-",
        left: n.target,
        right: { type: "NumberLiteral", value: 1, pos: n.pos },
        pos: n.pos,
      },
      pos: n.pos,
    } as object;
  },
};

const bareReturnBlock: Rule = {
  name: "blockReturn",
  apply: (node) => {
    const n = node as { type: string; decls?: readonly unknown[]; ret?: object };
    if (n.type !== "ExprBlock") return node;
    if (n.decls === undefined || n.decls.length > 0) return node;
    return n.ret as object;
  },
};

const fieldPath: Rule = {
  name: "memberAccess",
  apply: (node) => {
    const n = node as { type: string; object?: object; name?: string };
    if (n.type !== "MemberAccess" || n.name === undefined) return node;
    if (n.name.startsWith("$") || isFieldProperty(n.name)) return node;
    const members: { name: string; optional: boolean }[] = [
      { name: n.name, optional: (n as { optional?: boolean }).optional === true },
    ];
    let base = n.object as {
      type: string;
      object?: object;
      name?: string;
      path?: string;
      pos?: number;
      optional?: boolean;
      optionalAt?: string;
    };
    while (base.type === "MemberAccess") {
      const name = base.name as string;
      if (name.startsWith("$")) return node;
      members.unshift({ name, optional: base.optional === true });
      base = base.object as typeof base;
    }
    if (base.type !== "FieldRef") return node;
    const head = base.path === "" ? [] : [base.path as string];
    const optional = base.optional === true || members.some((m) => m.optional);
    let optionalAt: string | undefined;
    for (let i = members.length - 1; i >= 0; i--) {
      if (!members[i].optional) continue;
      const before = [...head, ...members.slice(0, i).map((m) => m.name)].join(".");
      if (before !== "") optionalAt = before;
      break;
    }
    if (!members.some((m) => m.optional)) optionalAt = base.optionalAt;
    const folded = { type: "FieldRef", path: [...head, ...members.map((m) => m.name)].join("."), pos: base.pos };
    if (!optional) return folded as object;
    return (
      optionalAt === undefined ? { ...folded, optional: true } : { ...folded, optional: true, optionalAt }
    ) as object;
  },
};

type Node = { type: string; pos: number } & Record<string, unknown>;

const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string";

function writeBack(target: Node, value: object, pos: number): object {
  return {
    type: "UpdateFilter",
    ops: [{ type: "AssignExpr", target: { ...target }, op: "=", value, pos, mutates: true }],
    pos: target.pos,
  };
}

const mutatorTwin: Rule = {
  name: "methodCall",
  apply: (node, where) => {
    if (where.at !== "statement") return node;
    const n = node as Node;
    if (n.type !== "MethodCall" || typeof n.name !== "string") return node;
    const twin = immutableTwinOf(n.name);
    if (twin === undefined) return node;
    const target = writtenField(n);
    if (target === null) return node;
    return writeBack(
      target,
      { type: "MethodCall", object: target, name: twin, wrote: n.name, args: n.args, optional: false, pos: n.pos },
      n.pos,
    );
  },
};

function instantiate(form: string, recv: Node, args: readonly unknown[], pos: number): object {
  const sub = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sub);
    if (!isNode(v)) return v;
    if (v.type === "Ident" && typeof v.name === "string") {
      if (v.name === "_r") return { ...recv };
      const slot = /^_(\d+)$/.exec(v.name);
      if (slot !== null) return args[Number(slot[1])];
    }
    const out: Record<string, unknown> = { type: v.type, pos };
    for (const [k, x] of Object.entries(v)) if (k !== "type" && k !== "pos") out[k] = sub(x);
    return out;
  };
  return sub(parseExpression(form)) as object;
}

const mutatorForm: Rule = {
  name: "mutatorForm",
  apply: (node, where) => {
    if (where.at !== "statement") return node;
    const n = node as Node;
    if (n.type !== "MethodCall" || typeof n.name !== "string") return node;
    const form = mutatorFormOf(n.name);
    if (form === undefined) return node;
    const target = writtenField(n);
    if (target === null) return node;
    const args = n.args as readonly Node[];
    if (args.some((a) => a.type === "SpreadElement")) return node;
    const template = form.by[args.length];
    if (template === undefined) {
      const counts = Object.keys(form.by).map(Number);
      const range = counts.length === 1 ? `exactly ${counts[0]}` : `${Math.min(...counts)} to ${Math.max(...counts)}`;
      throw new ParseError(
        `'.${n.name}(${form.sig})' at position ${n.pos} takes ${range} argument${counts[0] === 1 && counts.length === 1 ? "" : "s"}, got ${args.length}.`,
        n.pos,
      );
    }
    return writeBack(target, instantiate(template, target, args, n.pos), n.pos);
  },
};

const mutatorSpread: Rule = {
  name: "spreadElement",
  apply: (node, where) => {
    if (where.at !== "statement") return node;
    const n = node as Node;
    if (n.type !== "MethodCall" || typeof n.name !== "string") return node;
    const order = arrayLiteralOrderOf(n.name);
    if (order === undefined) return node;
    const target = writtenField(n);
    if (target === null) return node;
    const spread = { type: "SpreadElement", argument: target, pos: target.pos };
    const args = n.args as readonly object[];
    const elements = order === "receiver, then arguments" ? [spread, ...args] : [...args, spread];
    return writeBack(target, { type: "ArrayLiteral", elements, pos: n.pos }, n.pos);
  },
};

const packSpread: Rule = {
  name: "packSpread",
  apply: (node, where) => {
    if (where.at === "statement") return node;
    const n = node as Node & { args?: readonly Node[]; name?: string; callee?: Node };
    if ((n.type !== "MethodCall" && n.type !== "CallExpression") || !Array.isArray(n.args)) return node;
    if (!n.args.some((a) => a.type === "SpreadElement")) return node;
    if (n.type === "MethodCall" && readsAContextRef(n.object as object)) return node;
    const name =
      n.type === "MethodCall"
        ? n.name
        : n.callee?.type === "Ident"
          ? (n.callee as unknown as { name: string }).name
          : undefined;
    if (name === undefined || !packsSpreadOf(name)) return node;
    return { ...n, args: [{ type: "ArrayLiteral", elements: n.args, pos: n.args[0].pos, packed: true }] };
  },
};

function pathOn(param: string, path: string, pos: number): object {
  let out: object = { type: "Ident", name: param, pos, minted: true };
  for (const segment of path.split(".")) {
    out = { type: "MemberAccess", object: out, name: segment, optional: false, pos };
  }
  return out;
}

const strictEq = (left: object, right: object, pos: number): object => ({
  type: "BinaryExpr",
  op: "===",
  left,
  right,
  pos,
});

function writtenKey(entry: object): string | null {
  const e = entry as { type: string; key?: { kind?: string; name?: string } };
  if (e.type !== "KeyValueEntry" || e.key?.kind !== "static") return null;
  return typeof e.key.name === "string" ? e.key.name : null;
}

function asArrow(
  arg: object | undefined,
  forms: readonly string[],
  pos: number,
  iteratee: { readonly method: string; readonly slot: number },
): object | undefined {
  const accepts = (form: string): boolean => forms.includes(form);

  if (arg === undefined) {
    if (!accepts("omitted")) return undefined;
    const param = "x";
    return { type: "Lambda", params: [param], body: { type: "Ident", name: param, pos, minted: true }, pos };
  }

  const a = arg as { type: string; value?: unknown; entries?: readonly object[]; elements?: readonly object[] };
  const param = freshParam("x", arg);

  if (a.type === "StringLiteral" && accepts("propertyPath") && typeof a.value === "string") {
    return { type: "Lambda", params: [param], body: pathOn(param, a.value, pos), pos };
  }

  const n = a.value;
  if (
    a.type === "NumberLiteral" &&
    accepts("propertyIndex") &&
    typeof n === "number" &&
    Number.isInteger(n) &&
    n >= 0
  ) {
    const object = { type: "Ident", name: param, pos, minted: true };
    const body = { type: "IndexAccess", object, index: { ...a }, optional: false, pos, iteratee };
    return { type: "Lambda", params: [param], body, pos };
  }

  if (a.type === "ObjectLiteral" && accepts("matchesObject") && a.entries !== undefined) {
    if (a.entries.length === 0) return undefined;
    const tests = matchTests(param, "", a.entries, pos);
    if (tests === undefined) return undefined;
    if (tests.length === 0)
      return { type: "Lambda", params: [param], body: { type: "BooleanLiteral", value: true, pos }, pos };
    const body = tests.reduce((left, right) => ({ type: "BinaryExpr", op: "&&", left, right, pos }));
    return { type: "Lambda", params: [param], body, pos };
  }

  if (a.type === "ArrayLiteral" && accepts("matchesPropertyPair") && a.elements?.length === 2) {
    const [path, value] = a.elements;
    const p = path as { type: string; value?: unknown };
    if (p.type !== "StringLiteral" || typeof p.value !== "string") return undefined;
    return { type: "Lambda", params: [param], body: strictEq(pathOn(param, p.value, pos), value, pos), pos };
  }

  if (accepts("bareCallable")) {
    const applied = bareCall(a as Node, param, pos);
    if (applied !== undefined) return { type: "Lambda", params: [param], body: applied, pos };
  }

  return undefined;
}

function matchTests(param: string, prefix: string, entries: readonly object[], pos: number): object[] | undefined {
  const tests: object[] = [];
  for (const entry of entries) {
    const key = writtenKey(entry);
    if (key === null) return undefined;
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const value = (entry as { value: Node }).value;
    if (value.type === "ObjectLiteral" && Array.isArray(value.entries)) {
      const nested = matchTests(param, path, value.entries as readonly object[], pos);
      if (nested === undefined) return undefined;
      tests.push(...nested);
      continue;
    }
    const elements = value.type === "ArrayLiteral" ? (value.elements as readonly Node[] | undefined) : undefined;
    if (elements !== undefined && elements.every((e) => CONSTANT_LITERALS.has(e.type as string))) {
      for (const e of elements) {
        tests.push({
          type: "MethodCall",
          object: pathOn(param, path, pos),
          name: "has",
          args: [e],
          optional: false,
          pos,
        });
      }
      continue;
    }
    tests.push(strictEq(pathOn(param, path, pos), value as object, pos));
  }
  return tests;
}

const CONSTANT_LITERALS = new Set(["NumberLiteral", "StringLiteral", "BooleanLiteral", "NullLiteral", "BigIntLiteral"]);

function bareCall(callee: Node, param: string, pos: number): object | undefined {
  const arg = { type: "Ident", name: param, pos, minted: true };
  if (callee.type === "Ident" && typeof callee.name === "string") {
    if (!isGlobalName(callee.name) || !isCallable(callee.name)) return undefined;
    return { type: "CallExpression", callee: { ...callee }, args: [arg], pos };
  }
  if (callee.type === "MemberAccess" && isNode(callee.object) && callee.object.type === "Ident") {
    const ns = callee.object.name;
    if (typeof ns !== "string" || !namespaceNames().has(ns) || typeof callee.name !== "string") return undefined;
    return { type: "MethodCall", object: { ...callee.object }, name: callee.name, args: [arg], optional: false, pos };
  }
  return undefined;
}

const iterateeShorthand: Rule = {
  name: "iterateeShorthand",
  apply: (node, where) => {
    const n = node as Node;
    if (n.type !== "MethodCall" || typeof n.name !== "string") return node;

    const recv = n.object as { type?: string; name?: string } | undefined;
    const named = recv?.type === "Ident" && typeof recv.name === "string" ? recv.name : null;
    const family = receiverFamily(named, recv !== undefined && readsAContextRef(recv), n.name);
    if (family === undefined) return node;

    const runsAs = picksOneOf(n.name);
    const layout =
      iterateeSlotsOf(n.name, family) ??
      (runsAs === null ? undefined : iterateeSlotsOf(runsAs, family)) ??
      (family === "stream" ? iterateeSlotsOf(n.name, "array") : undefined);
    if (layout === undefined || !isSlotLayout(layout)) return node;

    const args = n.args as readonly object[];
    const next = [...args];
    let changed = false;
    for (const [key, forms] of Object.entries(layout)) {
      const slot = Number(key);
      if (slot > args.length) continue;
      const arrow = asArrow(args[slot], forms as readonly string[], n.pos, { method: n.name, slot });
      if (arrow === undefined) continue;
      next[slot] = arrow;
      changed = true;
    }
    return changed ? ({ ...n, args: next } as object) : node;
  },
};

export const RULES: readonly Rule[] = [
  compoundAssign,
  incDec,
  bareReturnBlock,
  fieldPath,
  mutatorTwin,
  mutatorSpread,
  mutatorForm,
  packSpread,
  iterateeShorthand,
];

export function applyRules<T extends object>(root: T, where: Where): T {
  let next = root;
  for (const rule of RULES) next = mapTreeIn(next, where, edge, rule.apply);
  return next;
}
