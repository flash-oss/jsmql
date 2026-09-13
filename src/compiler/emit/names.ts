// Phase 5 — EMIT. Every MongoDB variable name the compiler writes, and the scope
// that says what a JavaScript name means.
//
// MongoDB variables live in ONE flat scope: the developer's lambda parameters, a
// `$let` the developer wrote, and every variable a lowering binds for itself all
// share it. Three things go wrong there, and each is closed by a TYPE here rather
// than by care at each site:
//
//   * a name the server refuses. MEASURED on mongod, `$let: { vars: { <name>: 7 } }`:
//       x, x_1, xY, jsmqlArr, v_id       accepted
//       _x, X, 1x                        "starts with an invalid character for a user variable name"
//       x-y, x$                          "contains an invalid character for a variable name"
//     so a `MongoVar` is minted only by `mongoVarName`, which is total.
//   * two JavaScript names that become one variable. A scheme that merely
//     prepended a letter made `_id` and `v_id` the same variable, `v_id`, and a
//     body that read both read one. `mongoVarName` is INJECTIVE: a plain name is
//     itself and never starts with `v_`; every other name is `v_` + an escape in
//     which `_` only ever opens an escape.
//   * a compiler mint that captures a developer's name. `Scope.bind` mints
//     against every name the PROGRAM introduces, not only the ones in scope at
//     the site — a parameter bound deeper inside the body is exactly the one a
//     mint at the site would shadow.
//
// The spellings themselves — `jsmql<Hint>`, `__jsmql.tmp.<n>` — live in
// src/namespace.ts, the one home for jsmql's three namespaces.

import type { Expr, Kind } from "../../registry/vocabulary.ts";
// Type-only, so nothing is imported at run time and env.ts keeps importing this file.
import type { Chain } from "./env.ts";
import { UnknownIdentifierError, internalError } from "../../errors.ts";
import { exprVar, letBindingVar, letFieldVar, letSysVar, tmpSlot } from "../../namespace.ts";

declare const VAR: unique symbol;
declare const REF: unique symbol;
declare const SLOT: unique symbol;

/** A variable name the server accepts, without its `$$`. Minted only here. */
export type MongoVar = string & { readonly [VAR]: true };
/** The read of a variable — `$$name`. Minted only here; the only thing `lookup` returns. */
export type VarRef = string & { readonly [REF]: true };
/** A `__jsmql.…` scratch field: the path to write, and the `$path` that reads it. */
export type FieldSlot = { readonly path: string; readonly ref: string; readonly [SLOT]: true };

/** The names MongoDB itself binds. Read with `systemRef`; never rebound. */
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

/** `$$ROOT`, `$$REMOVE`, … — a system variable's read. */
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
 *   x       → x            the common case is untouched, so MQL reads as written
 *   _id     → v__5fid      `_` opens an escape: two hex digits of the code point
 *   $x      → v__24x
 *   X       → v_X          an uppercase lead is legal in the body, so only the prefix is added
 *   v_id    → v_v_5fid     a `v_` lead is itself escaped, so it cannot collide with an escape
 *   é       → v__e9        two hex digits below U+0100; `_u` + four (漢 → v__u6f22) below
 *                          U+10000; `_U` + six above (😀 → v__U01f600)
 *
 * Injective because a plain result never starts with `v_`, and in an escaped
 * result every `_` opens an escape of fixed width, so the encoding can be read
 * back one escape at a time.
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
 * What a JavaScript name STANDS FOR. A closed union: a lowering switches on it
 * exhaustively, so a new way to bind a name is a compile error at every read
 * until each says what it does with it.
 */
export type Ref =
  /** A MongoDB variable — a lambda parameter, a `$let` var. Read as `$$name`. */
  | { readonly kind: "var"; readonly ref: VarRef }
  /**
   * The stream's ELEMENT — a stream callback's parameter (`$$.filter(d => …)`), the
   * element of an `$elemMatch` body. `path` is where the element lives on the
   * document: `""` when the element IS the document, the unwound field after
   * `.flatMap("items")` — its fields are then `items.<field>`.
   */
  | { readonly kind: "document"; readonly path: string }
  /** A value carried between stages in a `__jsmql.var.<name>` field. */
  | { readonly kind: "field"; readonly slot: FieldSlot }
  /** A value the fold settled but could not inline as source — a live Date, an ObjectId. */
  | { readonly kind: "constant"; readonly value: unknown }
  /**
   * A declared function, inlined at each call. `expanding` when its body is a
   * block of STAGES that expands in place, rather than a value.
   */
  | { readonly kind: "function"; readonly lambda: Expr; readonly expanding: boolean }
  /**
   * A named stream — a callback's collection parameter, `const s = $$.filter(…)`.
   * `chain` is the (sub-)pipeline whose documents it names, kept because a value it
   * materialises — its count — belongs on THAT pipeline and nowhere else: a
   * `$facet` branch and a body over another collection each assemble a chain of
   * their own, and a stamp written on the wrong one counts the wrong documents
   * under the same field name.
   */
  | { readonly kind: "streamHandle"; readonly source: Expr; readonly chain: Chain }
  /**
   * A binding a document-replacing stage destroyed. Reading it is the
   * developer's error, and `fix` is the row's own advice:
   *   let t = $.a; $group({ _id: $.k }); $.b = t   → "`t` … can't be read after '$group'"
   */
  /**
   * A name with no value here, whose read says why: a binding a document-replacing
   * stage took away (`replaced`, so a `let` may be assigned again), a callback
   * parameter the stream cannot fill, a function that would call itself.
   */
  | { readonly kind: "dropped"; readonly message: string; readonly replaced: boolean };

/** Everything a read needs to know about a name. Every field required. */
export type Binding = {
  readonly ref: Ref;
  /** The provable type, or "unknown" — the chain type-check reads this. */
  readonly type: Kind | "unknown";
  /**
   * What ONE element of this binding is, or "unknown". A method whose row
   * answers `returns: "element"` — `.head()`, `.find(p)`, `.maxBy(k)` — has this
   * kind, so the value that follows it is typed and the wrong method on it is
   * refused. Only a binding that can SHOW its elements states one: a
   * `$lookup.as` array holds the foreign collection's documents.
   */
  readonly elements: Kind | "unknown";
  /**
   * Is the value certainly THERE — never null, never missing? A `$lookup`'s array
   * is (the server always writes one); a `let` bound to a present value is; a
   * field, a parameter, a function are not. `isPresent` (types.ts) reads it.
   */
  readonly present: boolean;
  /** `let` is mutable, everything else is not. */
  readonly mutable: boolean;
  /** Where the binding was made, for the message that names it. */
  readonly pos: number;
  /**
   * The LEVEL of documents the binding lives on: 0 for the root pipeline's, one
   * more for each sub-pipeline over another collection crossed to reach the
   * declaration. A read from a deeper level cannot see the field and is captured
   * into that level's `$lookup.let` — see Capture. Set by Env, never by a caller.
   */
  readonly level: number;
};

/** What a caller states about a name; Env supplies the level. */
export type Declared = Omit<Binding, "level">;

/**
 * A value on one level of documents, as a READ on a possibly deeper level sees
 * it. `var` is a MongoDB variable, lexically scoped: its level is the level it
 * was BOUND on, because an expression that binds one does not cross into the
 * sub-pipeline of a stage hoisted out of it. The rest name a document level and a
 * path on it — "" for the whole document — and how the variable that carries it
 * across a `$lookup` is named: `f` a field, `v` a `let` binding, `s` a system value.
 */
export type Located =
  | { readonly kind: "var"; readonly level: number; readonly ref: string; readonly hint: string }
  | { readonly kind: "f" | "v" | "s"; readonly level: number; readonly path: string; readonly hint: string };

/**
 * The `let` of one `$lookup`, filled as its body is lowered: every read of a
 * value on the level the stage runs over is interned here under a name that
 * carries that level, and the body reads it as `$$<name>`. The name is
 * `jsmql_<f|v|s><level>_<hint>` (SSOT src/namespace.ts), sanitised; two raw
 * values that sanitise alike take `_2`, `_3`. Held BY REFERENCE on the boundary,
 * like a Chain, because the body is lowered before the stage is written.
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

  /** The variable that carries `value` (a `"$path"`), minted on first read. */
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

  /** Has anything been captured? An empty `let` is noise the server does not need. */
  get any(): boolean {
    return this.byValue.size > 0;
  }
}

/**
 * A variable and the scope its body is lowered under. A body can only be
 * lowered under `binder.scope`, so "the mint must be visible to the body" and
 * "the body's own names must be avoided" cannot be forgotten at a site.
 */
export type Binder = { readonly as: MongoVar; readonly ref: VarRef; readonly scope: Scope };

/**
 * What each JavaScript name means, and which variable names are spoken for.
 * Immutable: every binding returns a new scope, so a lambda body's scope is
 * gone when the lambda is.
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
   * deeper lambda binds its parameter still steps aside from it.
   */
  static root(introduced: Iterable<string>): Scope {
    const taken = new Set<string>(SYSTEM_VARS);
    for (const js of introduced) taken.add(mongoVarName(js));
    return new Scope(new Map(), taken, new Set());
  }

  /** A nested block: every outer name still visible, none of them declared HERE. */
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
   * Encoded, never renamed. `type` is what the row says the parameter holds.
   */
  param(js: string, type: Kind | "unknown", pos: number, level: number): Binder {
    const as = mongoVarName(js);
    const ref = refOf(as);
    const bound = new Map(this.bound);
    bound.set(js, { ref: { kind: "var", ref }, type, elements: "unknown", present: false, mutable: false, pos, level });
    const taken = new Set(this.taken);
    taken.add(as);
    const own = new Set(this.own);
    own.add(js);
    return { as, ref, scope: new Scope(bound, taken, own) };
  }

  /**
   * A compiler mint — `bind("arr")` is `jsmqlArr`, or `jsmqlArr2`, `jsmqlArr3`
   * … when a name the program uses stands in the way. The developer's names are
   * never the ones that move.
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

/** A `__jsmql.…` field as a slot: the path to write and the `$path` to read. */
export function fieldSlot(path: string): FieldSlot {
  return { path, ref: "$" + path } as FieldSlot;
}
