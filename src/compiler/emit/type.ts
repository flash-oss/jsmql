// Phase 5 — EMIT. The `Type` value: what the compiler proves about a value, and
// the operations that combine two proofs. See docs/specs/types.md.
//
// A `Type` is a proof, not a guess. `ANY` says nothing. `of("string")` says the
// value is a string. `join` says "one of these": a `? :` whose branches disagree.
// `merge` says "these objects spread into one": a `{ ...a, ...b }`. `at` and
// `written` walk a document's properties by a dotted path, so a write to `$.a.b`
// and a read of `$.a.b` meet on the same node. Nothing here reads the registry,
// and nothing here reads a node: `prove.ts` does both and calls in here.

import type { Family, Kind, Type, TypeExpr } from "../../registry/vocabulary.ts";

const has = (t: Type, k: Kind): boolean => t.kinds === "any" || t.kinds.has(k);

/** A value nothing is known about: any kind, maybe null or missing, any properties. */
export const ANY: Type = { kinds: "any", absent: true, open: true };

/** A value that is certainly null or missing — a closed object's property nobody wrote, a `null` literal. */
export const NOTHING: Type = { kinds: new Set(), absent: true, open: false };

/** Is this the proof of a value that is certainly null or missing? */
export const isNothing = (t: Type): boolean => t.kinds !== "any" && t.kinds.size === 0;

/** A document nothing is known about, but which IS there: the root, a foreign collection's document. */
export const DOCUMENT: Type = { kinds: new Set<Kind>(["object"]), absent: false, open: true };

/** A value of exactly one kind, present unless said otherwise. */
export const of = (k: Kind, absent = false): Type => ({ kinds: new Set([k]), absent, open: k === "object" });

/** An array whose elements are `element`. */
export const arrayOf = (element: Type, absent = false): Type => ({
  kinds: new Set<Kind>(["array"]),
  absent,
  element,
  open: false,
});

/** An array of a fixed length, one type per position. */
export const tupleOf = (items: readonly Type[], absent = false): Type => ({
  kinds: new Set<Kind>(["array"]),
  absent,
  element: joinAll(items),
  items,
  open: false,
});

/** An object with the named properties; `open` when others may exist, holding `values` when stated. */
export const objectOf = (
  props: ReadonlyMap<string, Type>,
  open: boolean,
  values: Type | undefined = undefined,
  absent = false,
): Type => ({ kinds: new Set<Kind>(["object"]), absent, props, open, ...(values === undefined ? {} : { values }) });

/** The same proof, with the value certainly there. */
export const present = (t: Type): Type => (t.absent ? { ...t, absent: false } : t);

/** The same proof, with the value possibly null or missing. */
export const maybeAbsent = (t: Type): Type => (t.absent ? t : { ...t, absent: true });

/** Can the value be of kind `k`? `ANY` can be anything. */
export const mayBe = has;

/** Can the value NOT be of kind `k` — is every kind it can be another one? `ANY` can be anything. */
export const cannotBe = (t: Type, k: Kind): boolean => t.kinds !== "any" && !t.kinds.has(k);

/** Is the value certainly of kind `k` — one kind, and this one? */
export const isOnly = (t: Type, k: Kind): boolean => t.kinds !== "any" && t.kinds.size === 1 && t.kinds.has(k);

/** The one kind the proof shows, or "unknown" when it shows none or more than one. */
export function single(t: Type): Kind | "unknown" {
  if (t.kinds === "any" || t.kinds.size !== 1) return "unknown";
  return [...t.kinds][0];
}

/** The kinds as a list, or null for `ANY`. */
export const kindsOf = (t: Type): readonly Kind[] | null => (t.kinds === "any" ? null : [...t.kinds]);

/** What ONE element of an array value is. A value that may not be an array proves nothing of its elements. */
export function elementOf(t: Type): Type {
  if (!has(t, "array")) return NOTHING;
  const element = t.element ?? ANY;
  // an element read off a missing array is missing too
  return t.absent ? maybeAbsent(element) : element;
}

/** What position `i` of an array value holds: the tuple's item when stated, else the element. */
export function itemOf(t: Type, i: number): Type {
  if (t.items !== undefined) return i < t.items.length ? t.items[i] : NOTHING;
  return elementOf(t);
}

/**
 * What property `name` of a value holds. A closed object without it holds
 * nothing. A path THROUGH an array reads the property of every element, as an
 * array: MEASURED, `"$a.b"` over `a: [{ b: 1 }, { b: 2 }]` is `[1, 2]`. So a
 * value that may be an array holds either its object's property or that list.
 */
export function propOf(t: Type, name: string): Type {
  if (t.kinds === "any") return ANY;
  const asObject = t.kinds.has("object") ? ownProp(t, name) : NOTHING;
  const asArray = t.kinds.has("array") ? arrayOf(propOf(elementOf(t), name)) : NOTHING;
  const own = isNothing(asArray) ? asObject : isNothing(asObject) ? asArray : join(asObject, asArray);
  // a property read off a missing value is missing too
  return t.absent ? maybeAbsent(own) : own;
}

/** The property an OBJECT value holds under `name`. */
function ownProp(t: Type, name: string): Type {
  const known = t.props?.get(name);
  if (known !== undefined) return known;
  if (!t.open) return NOTHING;
  return t.values ?? ANY;
}

/** The value at a dotted path under a document `Type`. `""` is the document itself. */
export function at(t: Type, path: string): Type {
  if (path === "") return t;
  let cur = t;
  for (const seg of path.split(".")) {
    cur = propOf(cur, seg);
    if (isNothing(cur)) return NOTHING;
  }
  return cur;
}

/**
 * The document after `path` is written with `value`. A whole-field write
 * replaces the field's proof. A dotted write keeps the parent's other
 * properties: `$.address.full = s` makes `address` a present object, open when it
 * was not known, with `full` set inside it. MEASURED, `{ $set: { "a.b": 1 } }`:
 * a scalar, null or missing `a` becomes `{ b: 1 }`; an object `a` keeps its
 * other fields; an ARRAY `a` gets `b` written into every element, so
 * `[1, 2]` becomes `[{ b: 1 }, { b: 1 }]`. See docs/specs/types.md § The write rules.
 */
export function written(doc: Type, path: string, value: Type): Type {
  if (path === "") return value;
  const dot = path.indexOf(".");
  const head = dot === -1 ? path : path.slice(0, dot);
  const rest = dot === -1 ? "" : path.slice(dot + 1);
  const parent = asObject(doc);
  if (rest === "") return withProp(parent, head, value);
  return withProp(
    parent,
    head,
    into(propOf(parent, head), (obj) => written(obj, rest, value)),
  );
}

/** The same object proof with one property set. */
function withProp(obj: Type, name: string, value: Type): Type {
  const props = new Map(obj.props ?? []);
  props.set(name, value);
  return { ...obj, props };
}

/**
 * A dotted write lands INSIDE `t`: on the object it is, on every element of
 * the array it is, or on either when the proof cannot tell. A value proven to
 * be neither becomes the object the server makes of it.
 */
function into(t: Type, write: (parent: Type) => Type): Type {
  if (isOnly(t, "array") && !t.absent) return { ...t, element: write(asObject(elementOf(t))) };
  const asObj = write(asObject(t));
  const canBeArray = t.kinds === "any" || (t.kinds.has("array") && !t.absent);
  if (!canBeArray) return asObj;
  const asArr: Type = { ...arrayOf(write(asObject(elementOf(t)))), absent: false };
  return join(asObj, asArr);
}

/** The document after `path` is removed. */
export function removed(doc: Type, path: string): Type {
  const dot = path.indexOf(".");
  const head = dot === -1 ? path : path.slice(0, dot);
  const rest = dot === -1 ? "" : path.slice(dot + 1);
  if (!has(doc, "object")) return doc;
  const props = new Map(doc.props ?? []);
  if (rest === "") {
    if (doc.open) props.set(head, NOTHING);
    else props.delete(head);
  } else {
    const child = propOf(doc, head);
    if (!isNothing(child)) props.set(head, removed(child, rest));
  }
  return { ...doc, props };
}

/** A value read as the object a dotted write makes of it: present, an object, and open when it was not proven closed. */
function asObject(t: Type): Type {
  if (isOnly(t, "object") && !t.absent) return t;
  // A value that may be an object keeps what is known of that object's properties.
  const known = t.kinds !== "any" && t.kinds.has("object");
  return {
    kinds: new Set<Kind>(["object"]),
    absent: false,
    props: known ? t.props : undefined,
    open: known ? t.open : true,
    ...(known && t.values !== undefined ? { values: t.values } : {}),
  };
}

/** One of the listed proofs. None at all proves nothing. */
export const joinAll = (list: readonly Type[]): Type =>
  list.length === 0 ? NOTHING : list.reduce((acc, t) => join(acc, t));

/** One of `a` or `b`: the two branches of a `? :`, the operands of `??`. A branch that is nothing makes the other maybe absent. */
export function join(a: Type, b: Type): Type {
  if (isNothing(a)) return maybeAbsent(b);
  if (isNothing(b)) return maybeAbsent(a);
  const kinds = a.kinds === "any" || b.kinds === "any" ? "any" : new Set<Kind>([...a.kinds, ...b.kinds]);
  const out: {
    kinds: ReadonlySet<Kind> | "any";
    absent: boolean;
    element?: Type;
    items?: readonly Type[];
    props?: ReadonlyMap<string, Type>;
    open: boolean;
    values?: Type;
  } = { kinds, absent: a.absent || b.absent, open: a.open || b.open };
  if (a.element !== undefined || b.element !== undefined) out.element = join(a.element ?? ANY, b.element ?? ANY);
  if (a.items !== undefined && b.items !== undefined && a.items.length === b.items.length) {
    out.items = a.items.map((t, i) => join(t, b.items![i]));
  }
  if (a.props !== undefined || b.props !== undefined) {
    const props = new Map<string, Type>();
    for (const k of new Set([...(a.props?.keys() ?? []), ...(b.props?.keys() ?? [])])) {
      props.set(k, join(propOf(a, k), propOf(b, k)));
    }
    out.props = props;
  }
  if (a.values !== undefined || b.values !== undefined) out.values = join(a.values ?? ANY, b.values ?? ANY);
  return out;
}

/**
 * `{ ...a, ...b }`: b's properties win. An open `b` may hold any of a's names, so
 * those become unknown. A `b` that may be absent spreads as `{}`, so its
 * properties may be missing. MEASURED: `$mergeObjects` skips a null operand.
 */
export function merge(a: Type, b: Type): Type {
  const props = new Map<string, Type>();
  const bOpen = b.kinds === "any" || b.open;
  for (const [k, t] of a.props ?? []) props.set(k, bOpen ? join(t, b.values ?? ANY) : t);
  for (const [k, t] of b.props ?? []) {
    const base = props.get(k) ?? propOf(a, k);
    props.set(k, b.absent ? join(base, t) : t);
  }
  const open = a.kinds === "any" || a.open || bOpen;
  const values = open
    ? join(a.values ?? (a.open || a.kinds === "any" ? ANY : NOTHING), b.values ?? (bOpen ? ANY : NOTHING))
    : undefined;
  return objectOf(props, open, open ? values : undefined);
}

/** The families a `Type` names, for a per-family `returns` map — `null` for a kind no family covers. */
export function familyOf(k: Kind): Family | null {
  switch (k) {
    case "string":
    case "array":
    case "number":
    case "object":
    case "date":
    case "stream":
      return k;
    default:
      return null;
  }
}

/** What a `TypeExpr` needs from its call site to evaluate. */
export type Site = {
  /** The receiver's proof. `ANY` for a bare call. */
  readonly receiver: Type;
  /** The receiver's family as SOURCE — a namespace, a regex, a set — when it has no kind of its own. */
  readonly family: Family | null;
  /** The n-th argument's proof. */
  readonly arg: (n: number) => Type;
  /** How many arguments the call has, for `args`. */
  readonly argCount: number;
  /** What the n-th callback argument returns. */
  readonly callback: (n: number) => Type;
  /** The property names the first argument spells, for `picked` / `omitted`, or null when it spells none. */
  readonly names: readonly string[] | null;
};

const isTerm = (e: TypeExpr, key: string): boolean => typeof e === "object" && e !== null && key in e;

/**
 * A row's `returns`, evaluated at one call. Every term answers a present value:
 * whether the CALL is present is the row's `neverNull` fact and the operands',
 * which `prove.ts` settles. So an `absent` here says only "the row could not
 * show the value", as `ANY` does.
 */
export function evaluate(e: TypeExpr, site: Site): Type {
  if (typeof e === "string") {
    switch (e) {
      case "same":
        return site.receiver;
      case "element":
        return elementOf(site.receiver);
      case "unknown":
        return ANY;
      case "picked":
        return selectProps(site.receiver, site.names, true);
      case "omitted":
        return selectProps(site.receiver, site.names, false);
      default:
        return of(e as Kind);
    }
  }
  if (isTerm(e, "arrayOf")) return arrayOf(evaluate((e as { arrayOf: TypeExpr }).arrayOf, site));
  if (isTerm(e, "elementOf")) return flattenOnce(evaluate((e as { elementOf: TypeExpr }).elementOf, site));
  if (isTerm(e, "callback")) return site.callback((e as { callback: number }).callback);
  if (isTerm(e, "arg")) return site.arg((e as { arg: number }).arg);
  if (isTerm(e, "args")) return joinAll(expandArgs((e as { args: number }).args, site));
  if (isTerm(e, "merge")) {
    const terms = expandList((e as { merge: readonly TypeExpr[] }).merge, site);
    return terms.reduce((acc, t) => merge(acc, t), objectOf(new Map(), false));
  }
  if (isTerm(e, "oneOf")) return joinAll(expandList((e as { oneOf: readonly TypeExpr[] }).oneOf, site));
  if (isTerm(e, "recordOf")) return objectOf(new Map(), true, evaluate((e as { recordOf: TypeExpr }).recordOf, site));
  if (isTerm(e, "tuple")) return tupleOf((e as { tuple: readonly TypeExpr[] }).tuple.map((t) => evaluate(t, site)));
  // A per-family map: the receiver's own family picks the term.
  const map = e as Partial<Record<Family, TypeExpr>>;
  const family = site.family ?? familyOfType(site.receiver);
  if (family !== null) {
    const term = map[family];
    return term === undefined ? ANY : evaluate(term, site);
  }
  return ANY;
}

/** The terms of a list, with an `{ args: n }` term expanded to one proof per argument. */
function expandList(terms: readonly TypeExpr[], site: Site): Type[] {
  return terms.flatMap((t) =>
    isTerm(t, "args") ? expandArgs((t as { args: number }).args, site) : [evaluate(t, site)],
  );
}

/** Every argument from `n` on. */
function expandArgs(n: number, site: Site): Type[] {
  const out: Type[] = [];
  for (let i = n; i < site.argCount; i++) out.push(site.arg(i));
  return out;
}

/**
 * One level of flattening: an array gives its element, anything else stays —
 * what `.flatMap` keeps of a callback's answer, and what an object's property
 * values are (`elementOf` on an object).
 */
export function flattenOnce(t: Type): Type {
  if (t.kinds === "any") return ANY;
  const parts: Type[] = [];
  if (t.kinds.has("array")) parts.push(t.element ?? ANY);
  if (t.kinds.has("object") && !t.kinds.has("array")) {
    // the values of an object: its unnamed value, joined with every named property
    const values = [...(t.props?.values() ?? [])];
    if (t.open) values.push(t.values ?? ANY);
    return joinAll(values);
  }
  const rest = [...t.kinds].filter((k) => k !== "array");
  if (rest.length > 0) parts.push({ ...t, kinds: new Set(rest), element: undefined, items: undefined });
  return joinAll(parts);
}

/** The one family a `Type` belongs to, or null when it shows none or several. */
export function familyOfType(t: Type): Family | null {
  const k = single(t);
  return k === "unknown" ? null : familyOf(k);
}

/** The receiver's props kept (`keep`) or dropped by `names`. A receiver of unknown shape gives an open object. */
function selectProps(recv: Type, names: readonly string[] | null, keep: boolean): Type {
  if (names === null) return objectOf(new Map(), true);
  const props = new Map<string, Type>();
  if (keep) {
    for (const n of names) props.set(n, propOf(recv, n));
    return objectOf(props, false);
  }
  const open = recv.kinds === "any" || recv.open;
  for (const [k, t] of recv.props ?? []) if (!names.includes(k)) props.set(k, t);
  return objectOf(props, open, open ? recv.values : undefined);
}
