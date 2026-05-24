// Predicate → ($lookup basic-form fields) translator.
//
// Given a single-parameter arrow `(o) => o.foreignPath === $.localPath` (or its
// symmetric mirror), produces `{ localField, foreignField }` for the basic form
// of MongoDB's `$lookup` stage. Anything else — multi-parameter lambdas,
// non-equality bodies, computed values, additional terms — throws an actionable
// CodegenError pointing at the explicit `$lookup({ from, let, pipeline, as })`
// escape hatch.
//
// Basic-form $lookup is intrinsically limited to field-path strings on both
// sides, so this translator deliberately rejects anything it can't shape as
// two static dotted paths. The pipeline form for richer joins is future work.

import type { Expr, Lambda, UpdateOp } from "./ast.ts";
import { CodegenError } from "./codegen.ts";
import { closestNameTo } from "./levenshtein.ts";

const ESCAPE_HINT = "For richer joins, use `$lookup({ from, let, pipeline, as })` in an explicit stage array.";

const LOOKUP_METHODS = ["find", "filter"] as const;

export type LookupFields = { localField: string; foreignField: string };

export type LookupAssign = {
  /** Source collection name (`this.<from>` or `this["<from>"]`). */
  from: string;
  /** The lookup variant — `.find` returns a single doc (adds `$unwind`), `.filter` keeps the array. */
  method: "find" | "filter";
  /** The predicate arrow; pass to `translateLookupEquality` to extract the join keys. */
  lambda: Lambda;
};

/**
 * Recognise an assignment whose RHS is a `this.<coll>.find/filter(arrow)` chain.
 *
 *   - Returns `null` if the op has no `this.*` involvement (caller falls through
 *     to the normal update-op path).
 *   - Returns a validated `LookupAssign` for the happy path.
 *   - Throws an actionable `CodegenError` when the user clearly *meant* a
 *     lookup (`this.<coll>...` at the head of the RHS chain) but got the shape
 *     wrong — wrong method, no arrow, missing collection, etc. We catch these
 *     here so the message names `.find` / `.filter` instead of letting the
 *     generic `ThisRef` codegen error fire.
 */
export function detectLookupAssign(op: UpdateOp): LookupAssign | null {
  if (op.type !== "AssignExpr") return null;
  if (!rhsStartsWithThis(op.value)) return null;

  const rhs = op.value;
  if (rhs.type !== "MethodCall") {
    throw new CodegenError(
      "`this.<collection>` must be followed by `.find(predicate)` or `.filter(predicate)`. " +
        "Example: `$.orders = this.orders.filter(o => o.userId === $._id);`",
      rhs.pos,
    );
  }

  // Method name validation — needs the receiver to be exactly `this.<coll>`,
  // not a longer chain like `this.users.orders.find(...)`.
  const fromInfo = receiverAsCollection(rhs.object);
  if (fromInfo === null) {
    throw new CodegenError(
      "`this.<collection>` must be a direct property access — chained navigation like " +
        "`this.users.orders.find(...)` is not a join. Use `this.<collection>.find(predicate)` " +
        "or `this.<collection>.filter(predicate)`.",
      rhs.object.pos,
    );
  }

  if (rhs.method !== "find" && rhs.method !== "filter") {
    const suggestion = closestNameTo(rhs.method, LOOKUP_METHODS);
    const tail = suggestion ? ` Did you mean '.${suggestion}'?` : "";
    throw new CodegenError(
      `\`this.<collection>\` supports .find(predicate) and .filter(predicate), not .${rhs.method}().${tail}`,
      rhs.pos,
    );
  }

  if (rhs.args.length === 0) {
    throw new CodegenError(
      `.${rhs.method}(predicate) requires a predicate, e.g. .${rhs.method}(o => o._id === $.userId).`,
      rhs.pos,
    );
  }
  if (rhs.args.length > 1) {
    throw new CodegenError(
      `.${rhs.method}(predicate) takes a single arrow predicate, got ${rhs.args.length} arguments.`,
      rhs.pos,
    );
  }
  const arg = rhs.args[0];
  if (arg.type === "SpreadElement") {
    throw new CodegenError(`.${rhs.method}(predicate) takes a single arrow predicate, not a spread.`, arg.pos);
  }
  if (arg.type !== "Lambda") {
    throw new CodegenError(
      `.${rhs.method}(predicate) requires an arrow predicate, e.g. .${rhs.method}(o => o._id === $.userId).`,
      arg.pos,
    );
  }

  return { from: fromInfo.name, method: rhs.method, lambda: arg };
}

/** Walk a chain head — returns true if the leftmost atom is `ThisRef`. */
function rhsStartsWithThis(expr: Expr): boolean {
  let node: Expr = expr;
  for (;;) {
    if (node.type === "ThisRef") return true;
    if (node.type === "MemberAccess") {
      node = node.object;
      continue;
    }
    if (node.type === "IndexAccess") {
      node = node.object;
      continue;
    }
    if (node.type === "MethodCall") {
      node = node.object;
      continue;
    }
    if (node.type === "CallExpression") {
      node = node.callee;
      continue;
    }
    return false;
  }
}

/** The method-call receiver in `this.<coll>.find(...)`: either `this.<ident>` or `this["<str>"]`. */
function receiverAsCollection(node: Expr): { name: string } | null {
  if (node.type === "MemberAccess" && node.object.type === "ThisRef") {
    return { name: node.member };
  }
  if (node.type === "IndexAccess" && node.object.type === "ThisRef" && node.index.type === "StringLiteral") {
    return { name: node.index.value };
  }
  return null;
}

/**
 * Translate a `this.<coll>.find/filter(predicate)` predicate into basic-form
 * `$lookup` fields. The `method` is used only to make error messages name the
 * exact call site (`.find` vs `.filter`).
 */
export function translateLookupEquality(lambda: Lambda, method: "find" | "filter"): LookupFields {
  if (lambda.params.length !== 1) {
    throw new CodegenError(
      `.${method}(predicate) takes a single-parameter arrow (the foreign document), got ${lambda.params.length} parameters.`,
      lambda.pos,
    );
  }
  const paramName = lambda.params[0];
  const body = lambda.body;

  if (body.type !== "BinaryExpr" || (body.op !== "===" && body.op !== "==")) {
    throw new CodegenError(
      `.${method}() lookup predicate must be a field-path equality like '${paramName}.foreignField === $.localField'. ${ESCAPE_HINT}`,
      body.pos,
    );
  }

  const leftKind = classifySide(body.left, paramName);
  const rightKind = classifySide(body.right, paramName);

  if (leftKind === "invalid" || rightKind === "invalid") {
    throw new CodegenError(
      `.${method}() lookup predicate sides must be plain field paths ('${paramName}.x' or '$.y'); MongoDB's basic-form $lookup cannot express computed joins. ${ESCAPE_HINT}`,
      body.pos,
    );
  }

  if (leftKind.kind === "foreign" && rightKind.kind === "local") {
    return { foreignField: leftKind.path, localField: rightKind.path };
  }
  if (leftKind.kind === "local" && rightKind.kind === "foreign") {
    return { localField: leftKind.path, foreignField: rightKind.path };
  }

  // Same-side pair — both foreign or both local.
  if (leftKind.kind === "foreign" && rightKind.kind === "foreign") {
    throw new CodegenError(
      `.${method}() predicate compares two foreign paths; at least one side must be a '$.x' local field.`,
      body.pos,
    );
  }
  // Both local.
  throw new CodegenError(
    `.${method}() predicate compares two local paths; at least one side must be a '${paramName}.x' foreign field.`,
    body.pos,
  );
}

type SideKind = { kind: "foreign"; path: string } | { kind: "local"; path: string } | "invalid";

function classifySide(expr: Expr, paramName: string): SideKind {
  // Pure $.path (one or more segments) → local.
  const local = collectFieldRefPath(expr);
  if (local !== null) return { kind: "local", path: local };
  // paramName.path.path… → foreign.
  const foreign = collectParamPath(expr, paramName);
  if (foreign !== null) return { kind: "foreign", path: foreign };
  return "invalid";
}

/** `$.a.b.c` → "a.b.c"; anything else → null. */
function collectFieldRefPath(expr: Expr): string | null {
  if (expr.type === "FieldRef") return expr.path;
  if (expr.type === "MemberAccess") {
    const base = collectFieldRefPath(expr.object);
    if (base !== null) return `${base}.${expr.member}`;
  }
  return null;
}

/** `o.a.b` (root ParamRef named `paramName`) → "a.b"; bare `o` → ""; anything else → null. */
function collectParamPath(expr: Expr, paramName: string): string | null {
  if (expr.type === "ParamRef" && expr.name === paramName) return "";
  if (expr.type === "MemberAccess") {
    const base = collectParamPath(expr.object, paramName);
    if (base !== null) return base === "" ? expr.member : `${base}.${expr.member}`;
  }
  return null;
}
