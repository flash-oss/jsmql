// Phase 5 — EMIT. This file names every MongoDB variable the compiler writes.
// It also holds the scope that says what a JavaScript name means.
//
// MongoDB variables live in ONE flat scope. The developer's lambda parameters, a
// `$let` the developer wrote, and every variable a lowering binds for itself all
// share this scope. Three problems can happen there. A TYPE here closes each one,
// instead of care at each site:
//
//   * a name the server refuses. MEASURED on mongod, `$let: { vars: { <name>: 7 } }`:
//       x, x_1, xY, jsmqlArr, v_id       accepted
//       _x, X, 1x                        "starts with an invalid character for a user variable name"
//       x-y, x$                          "contains an invalid character for a variable name"
//     so only `mongoVarName` mints a `MongoVar`, and it is total.
//   * two JavaScript names that become one variable. A scheme that only
//     prepended a letter made `_id` and `v_id` the same variable, `v_id`, and a
//     body that read both read one. `mongoVarName` is INJECTIVE: a plain name is
//     itself and never starts with `v_`; every other name is `v_` plus an escape in
//     which `_` only ever opens an escape.
//   * a compiler mint that captures a developer's name. `Scope.bind` mints
//     against every name the PROGRAM introduces, not only the ones in scope at
//     the site. A parameter bound deeper inside the body is exactly the one a
//     mint at the site would shadow.
//
// The spellings themselves — `jsmql<Hint>`, `__jsmql.tmp.<n>` — live in
// src/namespace.ts, the one home for the three namespaces of JSMQL.

import type { Expr, Type } from "../../registry/vocabulary.ts";
// Type-only, so nothing is imported at run time, and env.ts can still import this file.
import type { Chain } from "./env.ts";
import { UnknownIdentifierError, internalError } from "../../errors.ts";
import { exprVar, letBindingVar, letFieldVar, letSysVar, tmpSlot } from "../../namespace.ts";

declare const VAR: unique symbol;
declare const REF: unique symbol;
declare const SLOT: unique symbol;

/** A variable name the server accepts, without its `$$`. Only this file mints it. */
export type MongoVar = string & { readonly [VAR]: true };
/** The read of a variable — `$$name`. Only this file mints it; `lookup` returns only this. */
export type VarRef = string & { readonly [REF]: true };
/** A `__jsmql.…` scratch field: the path to write, and the `$path` that reads it. */
export type FieldSlot = { readonly path: string; readonly ref: string; readonly [SLOT]: true };

/** The names MongoDB itself binds. Read them with `systemRef`. Never rebind them. */
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

/** `$$ROOT`, `$$REMOVE`, … — the read of a system variable. */
export const systemRef = (name: SystemVar): VarRef => ("$$" + name) as VarRef;

/** `$$value` and `$$this` — the two variables a `$reduce` body reads. */
export const reduceVar = (name: "value" | "this"): VarRef => ("$$" + name) as VarRef;

const refOf = (v: MongoVar): VarRef => ("$$" + v) as VarRef;

/** What the server accepts as written. A `v_` lead is reserved for the escape. */
const PLAIN = /^[a-z][A-Za-z0-9_]*$/;
const KEPT = /^[A-Za-z0-9]$/;

/**
 * The variable a JavaScript name becomes. Total and injective.
 *
 *   x       → x            the common case stays untouched, so MQL reads as written
 *   _id     → v__5fid      `_` opens an escape: two hex digits of the code point
 *   $x      → v__24x
 *   X       → v_X          an uppercase lead is legal in the body, so only the prefix is added
 *   v_id    → v_v_5fid     a `v_` lead is itself escaped, so it cannot collide with an escape
 *   é       → v__e9        two hex digits below U+0100; `_u` plus four (漢 → v__u6f22) below
 *                          U+10000; `_U` plus six above (😀 → v__U01f600)
 *
 * The function is injective because a plain result never starts with `v_`, and
 * in an escaped result every `_` opens an escape of fixed width. A reader can
 * decode the result one escape at a time.
 */
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

/**
 * What a JavaScript name STANDS FOR. A closed union. A lowering switches on it
 * exhaustively, so a new way to bind a name is a compile error at every read,
 * until each read says what it does with the name.
 */
export type Ref =
  /** A MongoDB variable — a lambda parameter, a `$let` var. Read as `$$name`. */
  | { readonly kind: "var"; readonly ref: VarRef }
  /**
   * The stream's ELEMENT — a stream callback's parameter (`$$.filter(d => …)`), the
   * element of an `$elemMatch` body. `path` is where the element lives on the
   * document: `""` when the element IS the document, the unwound field after
   * `.flatMap("items")` — its fields then sit under `items.<field>`.
   */
  | { readonly kind: "document"; readonly path: string }
  /** A value carried between stages in a `__jsmql.var.<name>` field. */
  | { readonly kind: "field"; readonly slot: FieldSlot }
  /** A value the fold settled but could not inline as source — a live Date, an ObjectId. */
  | { readonly kind: "constant"; readonly value: unknown }
  /**
   * A declared function, inlined at each call. `expanding` is true when its body is a
   * block of STAGES that expands in place, rather than a value.
   */
  | { readonly kind: "function"; readonly lambda: Expr; readonly expanding: boolean }
  /**
   * A named stream — a callback's collection parameter, `const s = $$.filter(…)`.
   * `chain` names the (sub-)pipeline whose documents it names. It is kept because a
   * value it materialises — its count — belongs on THAT pipeline and nowhere else. A
   * `$facet` branch and a body over another collection each assemble a chain of
   * their own. A stamp written on the wrong one counts the wrong documents
   * under the same field name.
   */
  | { readonly kind: "streamHandle"; readonly source: Expr; readonly chain: Chain }
  /**
   * A binding a document-replacing stage destroyed. Reading it is the
   * developer's error, and `fix` is the row's own advice:
   *   let t = $.a; $group({ _id: $.k }); $.b = t   → "`t` … can't be read after '$group'"
   */
  /**
   * A name with no value here. Its read says why: a binding a document-replacing
   * stage took away (`replaced`, so a `let` may be assigned again), a callback
   * parameter the stream cannot fill, or a function that would call itself.
   */
  | { readonly kind: "dropped"; readonly message: string; readonly replaced: boolean };

/** Everything a read needs to know about a name. Every field is required. */
export type Binding = {
  readonly ref: Ref;
  /**
   * What the compiler proves about the value: its kinds, whether it may be null
   * or missing, its elements, its properties. `ANY` when it proves nothing. A
   * `$lookup.as` array is a present array of documents; a `let` carries what
   * its value proved. `prove.ts` reads this field. See docs/specs/types.md.
   */
  readonly type: Type;
  /** `let` is mutable. Everything else is not. */
  readonly mutable: boolean;
  /** Where the binding was made, for the message that names it. */
  readonly pos: number;
  /**
   * The LEVEL of documents the binding lives on: 0 for the root pipeline, one
   * more for each sub-pipeline over another collection crossed to reach the
   * declaration. A read from a deeper level cannot see the field. The compiler
   * captures it into that level's `$lookup.let` — see Capture. Env sets this field; a caller never does.
   */
  readonly level: number;
};

/** What a caller states about a name. Env supplies the level. */
export type Declared = Omit<Binding, "level">;

/**
 * A value on one level of documents, as a READ on a possibly deeper level sees
 * it. `var` is a MongoDB variable, lexically scoped: its level is the level it
 * was BOUND on, because an expression that binds one does not cross into the
 * sub-pipeline of a stage hoisted out of it. The rest name a document level and a
 * path on it — "" for the whole document — and the letter that names the variable
 * that carries it across a `$lookup`: `f` a field, `v` a `let` binding, `s` a system value.
 */
export type Located =
  | { readonly kind: "var"; readonly level: number; readonly ref: string; readonly hint: string }
  | { readonly kind: "f" | "v" | "s"; readonly level: number; readonly path: string; readonly hint: string };

/**
 * The `let` of one `$lookup`, filled as its body is lowered. Every read of a
 * value on the level the stage runs over is interned here under a name that
 * carries that level, and the body reads it as `$$<name>`. The name is
 * `jsmql_<f|v|s><level>_<hint>` (single source of truth: src/namespace.ts), sanitised. Two raw
 * values that sanitise alike take `_2`, `_3`. The compiler holds this BY REFERENCE on the boundary,
 * like a Chain, because it lowers the body before it writes the stage.
 */
export class Capture {
  /** The level of documents this stage's `let` evaluates against. */
  readonly level: number;
  /** var name → the value it carries, in first-read order. */
  readonly vars: Record<string, string> = {};
  private readonly byValue = new Map<string, MongoVar>();

  constructor(level: number) {
    this.level = level;
  }

  /** The variable that carries `value` (a `"$path"`). This method mints it on first read. */
  take(kind: "f" | "v" | "s", hint: string, value: string): MongoVar {
    const have = this.byValue.get(value);
    if (have !== undefined) return have;
    const base =
      kind === "f"
        ? letFieldVar(hint, this.level)
        : kind === "v"
          ? letBindingVar(hint, this.level)
          : letSysVar(hint, this.level);
    let name = base;
    for (let n = 2; name in this.vars; n++) name = `${base}_${n}`;
    this.byValue.set(value, name as MongoVar);
    this.vars[name] = value;
    return name as MongoVar;
  }

  /** Did the compiler capture anything? An empty `let` is noise the server does not need. */
  get any(): boolean {
    return this.byValue.size > 0;
  }
}

/**
 * A variable and the scope under which the compiler lowers its body. The compiler
 * can lower a body only under `binder.scope`, so it cannot forget that "the mint must
 * be visible to the body" and "the body's own names must stay clear".
 */
export type Binder = { readonly as: MongoVar; readonly ref: VarRef; readonly scope: Scope };

/**
 * What each JavaScript name means, and which variable names are already taken.
 * Immutable: every binding returns a new scope, so a lambda body's scope is
 * gone once the lambda is gone.
 */
export class Scope {
  private readonly bound: ReadonlyMap<string, Binding>;
  private readonly taken: ReadonlySet<string>;
  /** The names THIS block declared — what a second `let` of the same name collides with. */
  private readonly own: ReadonlySet<string>;

  private constructor(bound: ReadonlyMap<string, Binding>, taken: ReadonlySet<string>, own: ReadonlySet<string>) {
    this.bound = bound;
    this.taken = taken;
    this.own = own;
  }

  /**
   * The root scope. `introduced` is every name the program binds anywhere — the
   * parameters and declarations `namesIn` collects — so a mint made before a
   * deeper lambda binds its parameter still steps aside from that parameter.
   */
  static root(introduced: Iterable<string>): Scope {
    const taken = new Set<string>(SYSTEM_VARS);
    for (const js of introduced) taken.add(mongoVarName(js));
    return new Scope(new Map(), taken, new Set());
  }

  /** A nested block: every outer name is still visible, and none of them are declared HERE. */
  block(): Scope {
    return new Scope(this.bound, this.taken, new Set());
  }

  /** Did this block itself declare the name? JavaScript refuses a second declaration in one block. */
  declaredHere(js: string): boolean {
    return this.own.has(js);
  }

  /** Is this JavaScript name bound here? */
  has(js: string): boolean {
    return this.bound.has(js);
  }

  /** Every name bound to a declared function — the candidates when a call names none of them. */
  functionNames(): readonly string[] {
    return [...this.bound].filter(([, b]) => b.ref.kind === "function").map(([js]) => js);
  }

  /**
   * What a JavaScript name means here — the ONLY way a read learns it. An
   * unbound name is the developer's error, positioned at the read.
   */
  lookup(js: string, pos: number): Binding {
    const b = this.bound.get(js);
    if (b === undefined) throw new UnknownIdentifierError(js, pos);
    return b;
  }

  /** A name bound to something other than a variable — the document, a field slot, a function. */
  declare(js: string, binding: Binding): Scope {
    const bound = new Map(this.bound);
    bound.set(js, binding);
    const own = new Set(this.own);
    own.add(js);
    return new Scope(bound, this.taken, own);
  }

  /**
   * Every binding carried in a document FIELD, turned into a name whose read says
   * what dropped it — the scope after a stage that replaced the document.
   */
  dropFields(by: string, message: (js: string, mutable: boolean) => string): Scope {
    const bound = new Map(this.bound);
    for (const [js, b] of this.bound) {
      if (b.ref.kind === "field")
        bound.set(js, { ...b, ref: { kind: "dropped", message: message(js, b.mutable), replaced: true } });
    }
    return new Scope(bound, this.taken, this.own);
  }

  /**
   * The developer's own variable binder — a lambda parameter, a `$let` var.
   * The compiler encodes it and never renames it. `type` is what the row says the parameter holds.
   */
  param(js: string, type: Type, pos: number, level: number): Binder {
    const as = mongoVarName(js);
    const ref = refOf(as);
    const bound = new Map(this.bound);
    bound.set(js, { ref: { kind: "var", ref }, type, mutable: false, pos, level });
    const taken = new Set(this.taken);
    taken.add(as);
    const own = new Set(this.own);
    own.add(js);
    return { as, ref, scope: new Scope(bound, taken, own) };
  }

  /**
   * A compiler mint — `bind("arr")` is `jsmqlArr`, or `jsmqlArr2`, `jsmqlArr3`
   * … when a name the program uses stands in the way. The compiler never moves
   * the developer's own names.
   */
  bind(hint: string): Binder {
    const base = exprVar(hint);
    let as = base;
    for (let n = 2; this.taken.has(as); n++) as = base + String(n);
    const taken = new Set(this.taken);
    taken.add(as);
    return { as: as as MongoVar, ref: refOf(as as MongoVar), scope: new Scope(this.bound, taken, this.own) };
  }
}

/** The scratch field `__jsmql.tmp.<n>`, with the reference that reads it. */
export const scratchSlot = (n: number): FieldSlot => fieldSlot(tmpSlot(n));

/** A `__jsmql.…` field as a slot: the path to write, and the `$path` to read. */
export function fieldSlot(path: string): FieldSlot {
  return { path, ref: "$" + path } as FieldSlot;
}
