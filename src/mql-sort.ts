// Sort-specification readers: a `.toSorted` / `.sortBy` / `.orderBy` argument → the `sortBy`
// value `$sortArray` expects.
//
// A LEAF: it imports only AST types and `errors.ts`. Every function here reads a SOURCE node
// and returns a plain spec — the sort key must be a compile-time field name, because
// `$sortArray` takes names rather than expressions, so nothing here ever lowers anything.
//
// See docs/specs/method-dispatch.md.

import type { ArrayElement, Expr } from "./ast.ts";
import { CodegenError } from "./errors.ts";

// 1 (ascending) or -1 (descending) from a `1` / `-1` number or an "asc" / "desc"
// string. `-1` parses as a UnaryExpr, so that shape is handled too.
export function sortDirLiteral(e: Expr): 1 | -1 | null {
  if (e.type === "NumberLiteral") return e.value === 1 ? 1 : e.value === -1 ? -1 : null;
  if (e.type === "UnaryExpr" && e.op === "-" && e.operand.type === "NumberLiteral" && e.operand.value === 1) return -1;
  if (e.type === "StringLiteral") return e.value === "asc" ? 1 : e.value === "desc" ? -1 : null;
  return null;
}

/**
 * Translate a `.toSorted(...)` / `.sort(...)` argument into the `sortBy` value
 * `$sortArray` expects. Accepts the same flexible forms as the stream sort:
 * a field name ("age"), an array of field names (all ascending), a
 * `{ field: 1 | -1 | "asc" | "desc" }` spec, or the key-function form
 * `x => x.path` / `x => -x.path`.
 */
export function argToSortBy(arg: Expr, method: string): Record<string, 1 | -1> {
  if (arg.type === "StringLiteral") {
    if (arg.value === "" || arg.value.startsWith("$")) {
      throw new CodegenError(
        `.${method}("field") requires a plain field name (no leading '$'), got ${JSON.stringify(arg.value)}.`,
        arg.pos,
      );
    }
    return { [arg.value]: 1 };
  }
  if (arg.type === "ArrayLiteral") {
    if (arg.elements.length === 0)
      throw new CodegenError(`.${method}([fields]) needs at least one field name.`, arg.pos);
    const spec: Record<string, 1 | -1> = {};
    for (const el of arg.elements) {
      if (el.type !== "StringLiteral")
        throw new CodegenError(`.${method}([fields]) entries must be field-name strings.`, el.pos);
      spec[el.value] = 1;
    }
    return spec;
  }
  if (arg.type === "ObjectLiteral") {
    if (arg.entries.length === 0) throw new CodegenError(`.${method}({ … }) needs at least one field.`, arg.pos);
    const spec: Record<string, 1 | -1> = {};
    for (const entry of arg.entries) {
      if (entry.type === "SpreadElement")
        throw new CodegenError(`.${method}({ … }) does not accept spread entries.`, entry.pos);
      if (entry.key.kind !== "static")
        throw new CodegenError(`.${method}({ … }) keys must be plain field names.`, entry.pos);
      const dir = sortDirLiteral(entry.value);
      if (dir === null) {
        throw new CodegenError(
          `.${method}({ ${entry.key.name}: … }) direction must be 1 / -1 / "asc" / "desc".`,
          entry.value.pos,
        );
      }
      spec[entry.key.name] = dir;
    }
    return spec;
  }
  return lambdaToSortBy(arg, method);
}

/**
 * The sort-key field names for `.orderBy(keys, orders)`: a single field name, a
 * key function (`x => x.path`), or an array of either. Directions come from the
 * separate `orders` arg (see `orderByDirs`), so a bare `x => x.path` yields just
 * its path.
 */
export function orderByKeyNames(arg: Expr, method: string): string[] {
  const one = (e: ArrayElement): string => {
    if (e.type === "StringLiteral") {
      if (e.value === "" || e.value.startsWith("$"))
        throw new CodegenError(`.${method}("field") requires a plain field name (no leading '$').`, e.pos);
      return e.value;
    }
    // A key function contributes its path (direction is taken from `orders`).
    if (e.type === "Lambda") return Object.keys(lambdaToSortBy(e, method))[0];
    throw new CodegenError(`.${method}(keys) entries must be a field name or a key function 'x => x.path'.`, e.pos);
  };
  if (arg.type === "ArrayLiteral") {
    if (arg.elements.length === 0) throw new CodegenError(`.${method}([keys]) needs at least one key.`, arg.pos);
    return arg.elements.map(one);
  }
  return [one(arg)];
}

/**
 * The sort directions for `.orderBy(keys, orders)`: `1` / `-1` / `"asc"` / `"desc"`,
 * or an array of them (parallel to the keys). Fewer directions than keys ⇒ the
 * remainder default ascending (lodash).
 */
export function orderByDirs(arg: Expr, method: string): (1 | -1)[] {
  const one = (e: ArrayElement): 1 | -1 => {
    const dir =
      e.type === "StringLiteral" || e.type === "NumberLiteral" || e.type === "UnaryExpr" ? sortDirLiteral(e) : null;
    if (dir === null)
      throw new CodegenError(`.${method}(keys, orders) directions must be 1 / -1 / "asc" / "desc".`, e.pos);
    return dir;
  };
  if (arg.type === "ArrayLiteral") return arg.elements.map(one);
  return [one(arg)];
}

/**
 * Translate a `.toSorted(keyFn)` / `.sort(keyFn)` callback into the `sortBy`
 * value MongoDB's `$sortArray` expects.
 *
 * Supported callback shapes (the key-function form):
 *   - `x => x.path` → `{ "path": 1 }`            (ascending, dotted nested paths welcome)
 *   - `x => -x.path` → `{ "path": -1 }`          (descending, unary `-` only)
 *
 * Everything else — comparator-style `(a, b) => …`, arithmetic on the key,
 * computed indices, 0-param or ≥2-param arrows — is rejected with a pointer at
 * the `$op($sortArray, { input, sortBy })` escape hatch.
 */
export function lambdaToSortBy(arg: Expr, method: string): Record<string, 1 | -1> {
  if (arg.type !== "Lambda") {
    throw new CodegenError(
      `.${method}() supports 0 or 1 arguments — an optional key function 'x => x.path' or 'x => -x.path'. For comparator-style sorts use $op($sortArray, { input, sortBy }).`,
      arg.pos,
    );
  }
  if (arg.body === undefined) {
    throw new CodegenError(
      `.${method}() does not accept a block-body arrow — pass an expression-body key function like 'x => x.field'.`,
      arg.pos,
    );
  }
  if (arg.params.length !== 1) {
    throw new CodegenError(
      `.${method}() key function takes exactly 1 parameter ('x => x.field'). For comparator-style sorts use $op($sortArray, { input, sortBy }).`,
      arg.pos,
    );
  }
  const param = arg.params[0];
  let body = arg.body;
  let direction: 1 | -1 = 1;
  if (body.type === "UnaryExpr" && body.op === "-") {
    direction = -1;
    body = body.operand;
  }
  const path = paramKeyPath(body, param);
  if (path === null) {
    throw new CodegenError(
      `.${method}() key function body must be '${param}.<field>' (optionally negated). For more complex sort criteria use $op($sortArray, { input, sortBy }).`,
      arg.body.pos,
    );
  }
  return { [path]: direction };
}

/**
 * If `expr` is a `MemberAccess` chain rooted at `ParamRef(param)`, return the
 * dotted key path (e.g. `MemberAccess(MemberAccess(ParamRef("x"), "user"), "name")`
 * with `param = "x"` → `"user.name"`). Otherwise null.
 */
function paramKeyPath(expr: Expr, param: string): string | null {
  if (expr.type === "ParamRef" && expr.name === param) {
    // `x => x` — sort by self isn't a valid sortBy key (an empty object key).
    return null;
  }
  if (expr.type === "MemberAccess") {
    const base = paramKeyPath(expr.object, param);
    if (expr.object.type === "ParamRef" && expr.object.name === param) {
      return expr.member;
    }
    if (base !== null) return `${base}.${expr.member}`;
  }
  return null;
}
