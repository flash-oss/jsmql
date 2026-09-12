// Phase 5 — EMIT. A sort argument, as written, to the `{ field: 1 | -1 }`
// document a `$sort` stage and a `$sortArray` operand both take.
//
// A reader, not a lowering: a sort key has to be a compile-time field name,
// because MongoDB sorts by names and never by expressions, so every function
// here reads a SOURCE node and answers a plain document — or refuses with the
// spelling that would work. Five spellings, one meaning each:
//
//   "age"                      one key, ascending
//   ["age", "name"]            several keys, all ascending
//   { age: -1, name: "asc" }   keys with directions — 1 / -1 / "asc" / "desc"
//   x => x.age   x => -x.age   a key function; the minus is the direction
//   (a, b) => a.age - b.age    a comparator; `b.k - a.k` is descending, and
//                              `||` joins keys in order of precedence
//   (a, b) => a - b            no field at all: the ELEMENTS are the key, which
//                              `$sortArray` takes as a bare 1 / -1 and a `$sort`
//                              stage cannot take at all
//
// See docs/specs/stream-methods.md.

import type { Expr } from "../../registry/vocabulary.ts";
import { CodegenError } from "../../errors.ts";

export type SortSpec = Record<string, 1 | -1>;

/**
 * What a sort argument asks for: keys by NAME, a key COMPUTED from the document
 * — `d => d.cat.toLowerCase()` — which MongoDB cannot sort by directly, so the
 * caller writes it to a scratch field and sorts by that, or the WHOLE element,
 * which carries a direction and no name.
 */
export type SortAsk =
  | { readonly kind: "keys"; readonly spec: SortSpec }
  | { readonly kind: "computed"; readonly key: Extract<Expr, { type: "Lambda" }>; readonly dir: 1 | -1 }
  | { readonly kind: "whole"; readonly dir: 1 | -1; readonly params: readonly [string, string]; readonly pos: number };

/** A sort ask a `$sort` STAGE can carry: never the whole element, which has no field name. */
export type StageSortAsk = Exclude<SortAsk, { kind: "whole" }>;

/** 1 or -1 from `1`, `-1`, `"asc"` or `"desc"`; null for anything else. */
export function sortDirection(e: Expr): 1 | -1 | null {
  if (e.type === "NumberLiteral") return e.value === 1 ? 1 : e.value === -1 ? -1 : null;
  if (e.type === "UnaryExpr" && e.op === "-" && e.argument.type === "NumberLiteral" && e.argument.value === 1)
    return -1;
  if (e.type === "StringLiteral") return e.value === "asc" ? 1 : e.value === "desc" ? -1 : null;
  return null;
}

/** The dotted path a member chain on `param` spells — `x.user.name` → "user.name" — or null. */
function paramPath(e: Expr, param: string): string | null {
  if (e.type === "MemberAccess") {
    if (e.object.type === "Ident" && e.object.name === param) return e.name;
    const base = paramPath(e.object, param);
    return base === null ? null : `${base}.${e.name}`;
  }
  return null;
}

const fieldName = (e: Expr, method: string): string => {
  if (e.type !== "StringLiteral" || e.value === "" || e.value.startsWith("$")) {
    throw new CodegenError(
      `.${method}() sorts by a field NAME — a plain string like "age", with no leading '$'.`,
      e.pos,
    );
  }
  return e.value;
};

/** `"k"`, `["k", "j"]` or `{ k: dir }` as a spec. `objects` says whether the third is welcome. */
export function keySortSpec(arg: Expr, method: string, objects = true): SortSpec {
  if (arg.type === "StringLiteral") return { [fieldName(arg, method)]: 1 };
  if (arg.type === "ArrayLiteral") {
    if (arg.elements.length === 0)
      throw new CodegenError(`.${method}([fields]) needs at least one field name.`, arg.pos);
    const spec: SortSpec = {};
    for (const el of arg.elements) {
      if (el.type === "SpreadElement")
        throw new CodegenError(`.${method}([fields]) lists its field names; '...' cannot spread them in.`, el.pos);
      spec[fieldName(el as Expr, method)] = 1;
    }
    return spec;
  }
  if (arg.type === "ObjectLiteral") {
    if (!objects) {
      throw new CodegenError(
        `.${method}({ … }) reads an object as a lodash matcher, not as directions — lodash's sortBy takes iteratees and sorts ascending. For directions write '.orderBy({ field: -1 })' or '.toSorted({ field: -1 })', which take an order in every position.`,
        arg.pos,
      );
    }
    if (arg.entries.length === 0) throw new CodegenError(`.${method}({ … }) needs at least one field.`, arg.pos);
    const spec: SortSpec = {};
    for (const entry of arg.entries) {
      if (entry.type === "SpreadElement")
        throw new CodegenError(`.${method}({ … }) names its fields; '...' cannot spread them in.`, entry.pos);
      if (entry.key.kind !== "static")
        throw new CodegenError(`.${method}({ … }) keys are field names, written plainly.`, entry.pos);
      const dir = sortDirection(entry.value);
      if (dir === null) {
        throw new CodegenError(
          `.${method}({ ${entry.key.name}: … }) takes a direction: 1, -1, "asc" or "desc".`,
          entry.value.pos,
        );
      }
      spec[entry.key.name] = dir;
    }
    return spec;
  }
  throw new CodegenError(
    `.${method}() takes a field name ("age"), a list of them (["age", "name"]), or directions ({ age: -1 }).`,
    arg.pos,
  );
}

/** `x => x.k` / `x => -x.k` as a spec; any other body is a computed key. */
function keyFunctionSpec(arg: Extract<Expr, { type: "Lambda" }>, method: string): SortAsk {
  if (arg.body === undefined) {
    throw new CodegenError(
      `.${method}(x => …) takes an expression body — 'x => x.age', or 'x => -x.age' for descending.`,
      arg.pos,
    );
  }
  let body = arg.body;
  let dir: 1 | -1 = 1;
  if (body.type === "UnaryExpr" && body.op === "-") {
    dir = -1;
    body = body.argument;
  }
  const path = paramPath(body, arg.params[0]);
  // The minus is the DIRECTION and nothing else: the key the caller lowers is the
  // body under it, or `x => -x.k` would negate the key AND sort it descending.
  if (path === null) return { kind: "computed", key: { ...arg, body }, dir };
  return { kind: "keys", spec: { [path]: dir } };
}

/**
 * `a - b` / `b - a` on the BARE parameters — the whole element is the key, which
 * `$sortArray` takes as a direction on its own. Only a bare body qualifies: under a
 * `||` the term falls through to the same-field check, because an element that IS
 * the key admits no tiebreaker.
 */
const wholeElementDir = (body: Expr, a: string, b: string): 1 | -1 | null => {
  if (body.type !== "BinaryExpr" || body.op !== "-") return null;
  const { left, right } = body;
  if (left.type !== "Ident" || right.type !== "Ident") return null;
  if (left.name === a && right.name === b) return 1;
  if (left.name === b && right.name === a) return -1;
  return null;
};

/**
 * `(a, b) => a.k - b.k` as a spec: the parameter that stands FIRST in the
 * subtraction is the ascending one. `||` joins several keys, most significant first.
 * `(a, b) => a - b` names no field, so the elements themselves are the key.
 */
function comparatorSpec(arg: Extract<Expr, { type: "Lambda" }>, method: string): SortAsk {
  const [a, b] = arg.params;
  if (arg.body === undefined) {
    throw new CodegenError(
      `.${method}((a, b) => …) takes an expression body: 'a.age - b.age', or 'b.age - a.age' for descending.`,
      arg.pos,
    );
  }
  const whole = wholeElementDir(arg.body, a, b);
  if (whole !== null) return { kind: "whole", dir: whole, params: [a, b], pos: arg.body.pos };
  const spec: SortSpec = {};
  const terms: Expr[] = [];
  const split = (e: Expr): void => {
    if (e.type === "BinaryExpr" && e.op === "||") {
      split(e.left);
      split(e.right);
    } else terms.push(e);
  };
  split(arg.body);
  // One term is the WHOLE body, so the elements-as-key form is open to it and the
  // refusal names it. Under a `||` it is not: an element that IS the key has no tiebreaker.
  const single = terms.length === 1;
  const orWhole = single ? ` To order the elements themselves, drop the field: '${a} - ${b}'.` : "";
  for (const t of terms) {
    if (t.type !== "BinaryExpr" || t.op !== "-") {
      throw new CodegenError(
        `.${method}((${a}, ${b}) => …) compares one field of each: '${a}.age - ${b}.age', or '${b}.age - ${a}.age' for descending. Join keys with '||'.${orWhole}`,
        t.pos,
      );
    }
    const la = paramPath(t.left, a);
    const rb = paramPath(t.right, b);
    const lb = paramPath(t.left, b);
    const ra = paramPath(t.right, a);
    if (la !== null && rb !== null && la === rb) spec[la] = 1;
    else if (lb !== null && ra !== null && lb === ra) spec[lb] = -1;
    else {
      throw new CodegenError(
        `.${method}((${a}, ${b}) => …) subtracts the SAME field of both parameters: '${a}.age - ${b}.age'.${orWhole}`,
        t.pos,
      );
    }
  }
  return { kind: "keys", spec };
}

/** Any of the four spellings, by the argument's shape. */
export function sortSpecOf(arg: Expr, method: string, objects = true): SortAsk {
  if (arg.type === "Lambda") {
    if (arg.params.length === 1) return keyFunctionSpec(arg, method);
    if (arg.params.length === 2) return comparatorSpec(arg, method);
    throw new CodegenError(
      `.${method}() takes a key function ('x => x.age') or a comparator ('(a, b) => a.age - b.age'), and this arrow has ${arg.params.length} parameters.`,
      arg.pos,
    );
  }
  return { kind: "keys", spec: keySortSpec(arg, method, objects) };
}

/**
 * lodash's `orderBy(keys, orders)`: `keys` is a name or a list of names,
 * `orders` a direction or a list of them, parallel to the keys — fewer orders
 * than keys leaves the rest ascending. The one-argument object form is the
 * `{ field: dir }` spec.
 */
export function orderBySpec(keys: Expr, orders: Expr | undefined, method: string): SortAsk {
  // A key function with an optional direction: `.orderBy(d => d.cat.toLowerCase(), -1)`.
  if (keys.type === "Lambda") {
    const ask = sortSpecOf(keys, method);
    if (orders === undefined) return ask;
    const dir = sortDirection(orders);
    if (dir === null)
      throw new CodegenError(`.${method}(keyFn, order) takes 1, -1, "asc" or "desc" as the order.`, orders.pos);
    if (ask.kind !== "keys") return { ...ask, dir };
    return { kind: "keys", spec: Object.fromEntries(Object.keys(ask.spec).map((k) => [k, dir])) };
  }
  if (keys.type === "ObjectLiteral") {
    if (orders !== undefined) {
      throw new CodegenError(
        `.${method}({ field: dir }) carries its directions inline; a second argument has nothing to say.`,
        orders.pos,
      );
    }
    return { kind: "keys", spec: keySortSpec(keys, method) };
  }
  const names =
    keys.type === "ArrayLiteral" ? keys.elements.map((e) => fieldName(e as Expr, method)) : [fieldName(keys, method)];
  const dirs: (1 | -1)[] = [];
  if (orders !== undefined) {
    const list = orders.type === "ArrayLiteral" ? (orders.elements as Expr[]) : [orders];
    for (const o of list) {
      const d = sortDirection(o);
      if (d === null)
        throw new CodegenError(`.${method}(keys, orders) takes 1, -1, "asc" or "desc" for each order.`, o.pos);
      dirs.push(d);
    }
    if (dirs.length > names.length) {
      throw new CodegenError(
        `.${method}(keys, orders) has ${dirs.length} orders for ${names.length} key(s).`,
        orders.pos,
      );
    }
  }
  const spec: SortSpec = {};
  names.forEach((n, i) => {
    spec[n] = dirs[i] ?? 1;
  });
  return { kind: "keys", spec };
}

/**
 * A sort ask narrowed to what a `$sort` STAGE can carry, on a stream whose element
 * lives at `element` (`""` when the element IS the document). MongoDB sorts a stream
 * by field NAME — measured, `{ $sort: 1 }` is "the $sort key specification must be
 * an object" and `{ $sort: { $literal: 1 } }` is "FieldPath field names may not
 * start with '$'" — so an element that IS the document has nowhere to go as a key.
 * An unwound element has a name — `.flatMap("tags").sort((a, b) => a - b)` sorts
 * by `tags` — and its fields sit under it: `.flatMap("items").sortBy("qty")` sorts
 * by `items.qty`.
 */
export function streamSortAsk(ask: SortAsk, method: string, element = ""): StageSortAsk {
  if (ask.kind === "keys") {
    if (element === "") return ask;
    return { kind: "keys", spec: Object.fromEntries(Object.entries(ask.spec).map(([k, d]) => [`${element}.${k}`, d])) };
  }
  if (ask.kind !== "whole") return ask;
  if (element !== "") return { kind: "keys", spec: { [element]: ask.dir } };
  const [a, b] = ask.params;
  const body = ask.dir === 1 ? `${a} - ${b}` : `${b} - ${a}`;
  const named = ask.dir === 1 ? `${a}.age - ${b}.age` : `${b}.age - ${a}.age`;
  const key = ask.dir === 1 ? "d.age" : "-d.age";
  throw new CodegenError(
    `.${method}((${a}, ${b}) => ${body}) sorts by the WHOLE element, and a stream carries documents that MongoDB sorts by field NAME. Name the field: '.${method}((${a}, ${b}) => ${named})', or '.${method}(d => ${key})'.`,
    ask.pos,
  );
}
