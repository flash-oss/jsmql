import type { Family, Kind, Type, TypeExpr } from "../../registry/vocabulary.ts";
import type { Proof } from "../kinds.ts";

const has = (t: Type, k: Kind): boolean => t.kinds === "any" || t.kinds.has(k);

export const ANY: Type = { kinds: "any", absent: true, open: true };

export const NOTHING: Type = { kinds: new Set(), absent: true, open: false };

export const isNothing = (t: Type): boolean => t.kinds !== "any" && t.kinds.size === 0;

export const DOCUMENT: Type = { kinds: new Set<Kind>(["object"]), absent: false, open: true };

export const of = (k: Kind, absent = false): Type => ({ kinds: new Set([k]), absent, open: k === "object" });

export const arrayOf = (element: Type, absent = false): Type => ({
  kinds: new Set<Kind>(["array"]),
  absent,
  element,
  open: false,
});

export const tupleOf = (items: readonly Type[], absent = false): Type => ({
  kinds: new Set<Kind>(["array"]),
  absent,
  element: joinAll(items),
  items,
  open: false,
});

export const objectOf = (
  props: ReadonlyMap<string, Type>,
  open: boolean,
  values: Type | undefined = undefined,
  absent = false,
): Type => ({ kinds: new Set<Kind>(["object"]), absent, props, open, ...(values === undefined ? {} : { values }) });

export const present = (t: Type): Type => (t.absent ? { ...t, absent: false } : t);

export const maybeAbsent = (t: Type): Type => (t.absent ? t : { ...t, absent: true });

export const mayBe = has;

export const cannotBe = (t: Type, k: Kind): boolean => t.kinds !== "any" && !t.kinds.has(k);

export const isOnly = (t: Type, k: Kind): boolean => t.kinds !== "any" && t.kinds.size === 1 && t.kinds.has(k);

export function single(t: Type): Kind | "unknown" {
  if (t.kinds === "any" || t.kinds.size !== 1) return "unknown";
  return [...t.kinds][0];
}

export const kindsOf = (t: Type): readonly Kind[] | null => (t.kinds === "any" ? null : [...t.kinds]);

export function proofOf(t: Type): Proof {
  if (t.kinds === "any") return "unknown";
  return t.kinds.size === 0 ? ["null"] : [...t.kinds];
}

export function elementProofOf(t: Type): Proof {
  const e = elementOf(t);
  if (e.kinds === "any" || e.kinds.size === 0) return "unknown";
  return t.element?.absent === true ? [...e.kinds, "null"] : [...e.kinds];
}

export function itemProofsOf(t: Type): readonly Proof[] | undefined {
  if (!has(t, "array") || t.items === undefined) return undefined;
  return t.items.map((i): Proof => {
    if (i.kinds === "any") return "unknown";
    return i.absent ? [...i.kinds, "null"] : [...i.kinds];
  });
}

export function elementOf(t: Type): Type {
  if (!has(t, "array")) return NOTHING;
  const element = t.element ?? ANY;
  return t.absent ? maybeAbsent(element) : element;
}

export function itemOf(t: Type, i: number): Type {
  if (t.items !== undefined) return i < t.items.length ? t.items[i] : NOTHING;
  return maybeAbsent(elementOf(t));
}

export function anyItemOf(t: Type): Type {
  if (t.kinds === "any") return ANY;
  if ([...t.kinds].some((k) => k !== "array" && k !== "object")) return ANY;
  const parts: Type[] = [];
  if (t.kinds.has("array")) parts.push(elementOf(t));
  if (t.kinds.has("object")) parts.push(flattenOnce({ ...t, kinds: new Set<Kind>(["object"]), absent: false }));
  return maybeAbsent(joinAll(parts));
}

export function propOf(t: Type, name: string): Type {
  if (t.kinds === "any") return ANY;
  const asObject = t.kinds.has("object") ? ownProp(t, name) : NOTHING;
  const asArray = t.kinds.has("array") ? arrayOf(propOf(elementOf(t), name)) : NOTHING;
  const own = isNothing(asArray) ? asObject : isNothing(asObject) ? asArray : join(asObject, asArray);
  return t.absent ? maybeAbsent(own) : own;
}

export type Unreadable =
  | { readonly kind: "noFields"; readonly kinds: readonly Kind[] }
  | { readonly kind: "closed"; readonly keys: readonly string[]; readonly elements?: true };

export function unreadable(t: Type, name: string, throughArrays: boolean): Unreadable | null {
  if (t.kinds === "any" || t.kinds.has("stream")) return null;
  if (throughArrays && t.kinds.has("array")) {
    if (t.kinds.size > 1) return null;
    const inner = unreadable(t.element ?? ANY, name, true);
    if (inner === null) return null;
    return inner.kind === "closed" ? { ...inner, elements: true } : { kind: "noFields", kinds: ["array"] };
  }
  if (!t.kinds.has("object")) return { kind: "noFields", kinds: [...t.kinds] };
  if (t.kinds.size > 1 || t.open || t.props?.has(name) === true) return null;
  return { kind: "closed", keys: [...(t.props?.keys() ?? [])] };
}

export function unreadableAt(
  t: Type,
  path: string,
  throughArrays: boolean,
): { readonly index: number; readonly why: Unreadable } | null {
  const segments = path.split(".");
  for (let i = 0; i < segments.length; i++) {
    const why = unreadable(at(t, segments.slice(0, i).join(".")), segments[i], throughArrays);
    if (why !== null) return { index: i, why };
  }
  return null;
}

function ownProp(t: Type, name: string): Type {
  const known = t.props?.get(name);
  if (known !== undefined) return known;
  if (!t.open) return NOTHING;
  return t.values === undefined ? ANY : maybeAbsent(t.values);
}

export function at(t: Type, path: string): Type {
  if (path === "") return t;
  let cur = t;
  for (const seg of path.split(".")) {
    cur = propOf(cur, seg);
    if (isNothing(cur)) return NOTHING;
  }
  return cur;
}

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

function withProp(obj: Type, name: string, value: Type): Type {
  const props = new Map(obj.props ?? []);
  props.set(name, value);
  return { ...obj, props };
}

function into(t: Type, write: (parent: Type) => Type): Type {
  if (isOnly(t, "array") && !t.absent) return { ...t, element: write(asObject(elementOf(t))) };
  const asObj = write(asObject(t));
  const canBeArray = t.kinds === "any" || (t.kinds.has("array") && !t.absent);
  if (!canBeArray) return asObj;
  const asArr: Type = { ...arrayOf(write(asObject(elementOf(t)))), absent: false };
  return join(asObj, asArr);
}

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

function asObject(t: Type): Type {
  if (isOnly(t, "object") && !t.absent) return t;
  const known = t.kinds !== "any" && t.kinds.has("object");
  return {
    kinds: new Set<Kind>(["object"]),
    absent: false,
    props: known ? t.props : undefined,
    open: known ? t.open : true,
    ...(known && t.values !== undefined ? { values: t.values } : {}),
  };
}

export const joinAll = (list: readonly Type[]): Type =>
  list.length === 0 ? NOTHING : list.reduce((acc, t) => join(acc, t));

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

export type Site = {
  readonly receiver: Type;
  readonly family: Family | null;
  readonly arg: (n: number) => Type;
  readonly argCount: number;
  readonly callback: (n: number) => Type;
  readonly names: readonly string[] | null;
};

const isTerm = (e: TypeExpr, key: string): boolean => typeof e === "object" && e !== null && key in e;

export function evaluate(e: TypeExpr, site: Site): Type {
  if (typeof e === "string") {
    switch (e) {
      case "same":
        return site.receiver.items === undefined ? site.receiver : { ...site.receiver, items: undefined };
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
  if (isTerm(e, "itemOf")) {
    const [of, n] = (e as { itemOf: readonly [TypeExpr, number] }).itemOf;
    return itemOf(evaluate(of, site), n);
  }
  const map = e as Partial<Record<Family, TypeExpr>>;
  const family = site.family ?? familyOfType(site.receiver);
  if (family !== null) {
    const term = map[family];
    return term === undefined ? ANY : evaluate(term, site);
  }
  return ANY;
}

function expandList(terms: readonly TypeExpr[], site: Site): Type[] {
  return terms.flatMap((t) =>
    isTerm(t, "args") ? expandArgs((t as { args: number }).args, site) : [evaluate(t, site)],
  );
}

function expandArgs(n: number, site: Site): Type[] {
  const out: Type[] = [];
  for (let i = n; i < site.argCount; i++) out.push(site.arg(i));
  return out;
}

export function flattenOnce(t: Type): Type {
  if (t.kinds === "any") return ANY;
  const parts: Type[] = [];
  if (t.kinds.has("array")) parts.push(t.element ?? ANY);
  if (t.kinds.has("object") && !t.kinds.has("array")) {
    const values = [...(t.props?.values() ?? [])];
    if (t.open) values.push(t.values ?? ANY);
    return joinAll(values);
  }
  const rest = [...t.kinds].filter((k) => k !== "array");
  if (rest.length > 0) parts.push({ ...t, kinds: new Set(rest), element: undefined, items: undefined });
  return joinAll(parts);
}

export function familyOfType(t: Type): Family | null {
  const k = single(t);
  return k === "unknown" ? null : familyOf(k);
}

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
