import type { Expr, Type } from "../../registry/vocabulary.ts";
import type { Chain } from "./env.ts";
import { UnknownIdentifierError, internalError } from "../../errors.ts";
import { exprVar, letBindingVar, letFieldVar, letSysVar, tmpSlot } from "../../namespace.ts";

declare const VAR: unique symbol;
declare const REF: unique symbol;
declare const SLOT: unique symbol;

export type MongoVar = string & { readonly [VAR]: true };
export type VarRef = string & { readonly [REF]: true };
export type FieldSlot = { readonly path: string; readonly ref: string; readonly [SLOT]: true };

export const SYSTEM_VARS = [
  "ROOT",
  "CURRENT",
  "REMOVE",
  "NOW",
  "CLUSTER_TIME",
  "DESCEND",
  "PRUNE",
  "KEEP",
  "SEARCH_META",
  "USER_ROLES",
] as const;
export type SystemVar = (typeof SYSTEM_VARS)[number];

export const systemRef = (name: SystemVar): VarRef => ("$$" + name) as VarRef;

export const reduceVar = (name: "value" | "this"): VarRef => ("$$" + name) as VarRef;

const refOf = (v: MongoVar): VarRef => ("$$" + v) as VarRef;

const PLAIN = /^[a-z][A-Za-z0-9_]*$/;
const KEPT = /^[A-Za-z0-9]$/;

export function mongoVarName(js: string): MongoVar {
  if (PLAIN.test(js) && !js.startsWith("v_")) return js as MongoVar;
  let out = "v_";
  for (const ch of js) {
    if (KEPT.test(ch)) {
      out += ch;
      continue;
    }
    const cp = ch.codePointAt(0);
    if (cp === undefined) internalError(`mongoVarName read an empty character in '${js}'`);
    out +=
      cp < 0x100
        ? "_" + cp.toString(16).padStart(2, "0")
        : cp < 0x10000
          ? "_u" + cp.toString(16).padStart(4, "0")
          : "_U" + cp.toString(16).padStart(6, "0");
  }
  return out as MongoVar;
}

export type Ref =
  | { readonly kind: "var"; readonly ref: VarRef }
  | { readonly kind: "document"; readonly path: string }
  | { readonly kind: "field"; readonly slot: FieldSlot }
  | { readonly kind: "constant"; readonly value: unknown }
  | { readonly kind: "function"; readonly lambda: Expr; readonly expanding: boolean }
  | { readonly kind: "streamHandle"; readonly source: Expr; readonly chain: Chain }
  | { readonly kind: "dropped"; readonly message: string; readonly replaced: boolean };

export type Binding = {
  readonly ref: Ref;
  readonly type: Type;
  readonly mutable: boolean;
  readonly pos: number;
  readonly level: number;
};

export type Declared = Omit<Binding, "level">;

export type Located =
  | { readonly kind: "var"; readonly level: number; readonly ref: string; readonly hint: string }
  | { readonly kind: "f" | "v" | "s"; readonly level: number; readonly path: string; readonly hint: string };

export class Capture {
  readonly level: number;
  readonly vars: Record<string, unknown> = {};
  private readonly byValue = new Map<string, MongoVar>();

  constructor(level: number) {
    this.level = level;
  }

  take(kind: "f" | "v" | "s", hint: string, value: unknown): MongoVar {
    const key = JSON.stringify(value);
    const have = this.byValue.get(key);
    if (have !== undefined) return have;
    const base =
      kind === "f"
        ? letFieldVar(hint, this.level)
        : kind === "v"
          ? letBindingVar(hint, this.level)
          : letSysVar(hint, this.level);
    let name = base;
    for (let n = 2; name in this.vars; n++) name = `${base}_${n}`;
    this.byValue.set(key, name as MongoVar);
    this.vars[name] = value;
    return name as MongoVar;
  }

  get any(): boolean {
    return this.byValue.size > 0;
  }
}

export type Binder = { readonly as: MongoVar; readonly ref: VarRef; readonly scope: Scope };

export class Scope {
  private readonly bound: ReadonlyMap<string, Binding>;
  private readonly taken: ReadonlySet<string>;

  private constructor(bound: ReadonlyMap<string, Binding>, taken: ReadonlySet<string>) {
    this.bound = bound;
    this.taken = taken;
  }

  static root(introduced: Iterable<string>): Scope {
    const taken = new Set<string>(SYSTEM_VARS);
    for (const js of introduced) taken.add(mongoVarName(js));
    return new Scope(new Map(), taken);
  }

  has(js: string): boolean {
    return this.bound.has(js);
  }

  functionNames(): readonly string[] {
    return [...this.bound].filter(([, b]) => b.ref.kind === "function").map(([js]) => js);
  }

  lookup(js: string, pos: number): Binding {
    const b = this.bound.get(js);
    if (b === undefined) throw new UnknownIdentifierError(js, pos);
    return b;
  }

  declare(js: string, binding: Binding): Scope {
    const bound = new Map(this.bound);
    bound.set(js, binding);
    return new Scope(bound, this.taken);
  }

  clearedSince(before: Scope, message: (js: string, mutable: boolean) => string): Scope {
    const bound = new Map(this.bound);
    for (const [js, b] of this.bound) {
      if (b.ref.kind === "field" && before.bound.get(js) === b)
        bound.set(js, { ...b, ref: { kind: "dropped", message: message(js, b.mutable), replaced: true } });
    }
    return new Scope(bound, this.taken);
  }

  dropFields(by: string, message: (js: string, mutable: boolean) => string): Scope {
    const bound = new Map(this.bound);
    for (const [js, b] of this.bound) {
      if (b.ref.kind === "field")
        bound.set(js, { ...b, ref: { kind: "dropped", message: message(js, b.mutable), replaced: true } });
    }
    return new Scope(bound, this.taken);
  }

  param(js: string, type: Type, pos: number, level: number): Binder {
    const as = mongoVarName(js);
    const ref = refOf(as);
    const bound = new Map(this.bound);
    bound.set(js, { ref: { kind: "var", ref }, type, mutable: false, pos, level });
    const taken = new Set(this.taken);
    taken.add(as);
    return { as, ref, scope: new Scope(bound, taken) };
  }

  bind(hint: string): Binder {
    const base = exprVar(hint);
    let as = base;
    for (let n = 2; this.taken.has(as); n++) as = base + String(n);
    const taken = new Set(this.taken);
    taken.add(as);
    return { as: as as MongoVar, ref: refOf(as as MongoVar), scope: new Scope(this.bound, taken) };
  }
}

export const scratchSlot = (n: number): FieldSlot => fieldSlot(tmpSlot(n));

export function fieldSlot(path: string): FieldSlot {
  return { path, ref: "$" + path } as FieldSlot;
}
