// Phase 5 — EMIT. What type a node PROVABLY has, from the registry alone.
//
// A proof, not a guess: a literal proves its own kind, a row's measured
// `returns` proves a call's, a binding carries the kind it was made with. A
// field path proves nothing — `$.a` is "unknown" and stays so. The dispatch in
// select.ts turns "unknown" into a runtime test, never into an assumption, so
// the one thing this module must never do is answer with a kind it cannot show.
//
// `regexp` and `set` are source-level families with no result kind of their
// own; a receiver can be one (`/x/.test(s)`, `new Set(a).union(b)`), so the
// family question is answered here too, beside the kind.

import type { Expr, Kind, Returns } from "../../registry/vocabulary.ts";
import type { FieldFamily } from "../../registry/vocabulary.ts";
import type { Env } from "./env.ts";
import { namedRow } from "../passes/naming.ts";
import {
  agreedReturnOf,
  constructedFamilyOf,
  isCallable,
  namespaceNames,
  productionForOperator,
  returnsOf,
  soleFieldFamilyOf,
} from "../rows.ts";
import { ObjectId } from "../../objectid.ts";
import { isMqlShaped } from "../passes/inject.ts";

export type Known = Kind | "unknown";

const NAMESPACES = namespaceNames();

/** The field family a kind is, or null for a kind no field family covers (bool, objectId, …). */
export function familyOfKind(k: Known): FieldFamily | null {
  switch (k) {
    case "string":
    case "array":
    case "number":
    case "object":
    case "date":
      return k;
    default:
      return null;
  }
}

/** The kind a `Returns` states for a receiver of `family`. */
function resolveReturns(r: Returns, receiver: Known, family: FieldFamily | "regexp" | "set" | string | null): Known {
  if (typeof r === "string") {
    if (r === "same") return receiver;
    if (r === "element") return "unknown";
    return r;
  }
  const byFamily = family === null ? undefined : (r as Record<string, Kind | "element" | "unknown">)[family];
  if (byFamily === undefined || byFamily === "element") return "unknown";
  return byFamily;
}

/** The receiver family a node names as SOURCE, before any kind: a namespace, a regex, a set — or null. */
export function sourceFamily(node: Expr): FieldFamily | "regexp" | "set" | string | null {
  if (node.type === "Ident" && NAMESPACES.has(node.name)) return node.name;
  if (node.type === "RegexLiteral") return "regexp";
  if (node.type === "NewExpression" && node.callee.type === "Ident")
    return constructedFamilyOf(node.callee.name) ?? null;
  return null;
}

/**
 * The kind `node` provably has under `env`. "unknown" wherever the registry
 * cannot show one.
 */
export function kindOf(node: Expr, env: Env): Known {
  switch (node.type) {
    case "NumberLiteral":
    case "BigIntLiteral":
      return "number";
    case "StringLiteral":
      // `"$x"` typed in source IS the field `x` (HR1): its kind is the field's, unknown.
      return node.value.startsWith("$") ? "unknown" : "string";
    case "TemplateLiteral":
      return "string";
    case "BooleanLiteral":
      return "bool";
    case "ObjectIdLiteral":
      return "objectId";
    case "Injected": {
      const v = node.value;
      if (typeof v === "number" || typeof v === "bigint") return "number";
      if (typeof v === "string") return isMqlShaped(v) ? "unknown" : "string";
      if (typeof v === "boolean") return "bool";
      if (v instanceof Date) return "date";
      if (Array.isArray(v)) return isMqlShaped(v) ? "unknown" : "array";
      if (v instanceof ObjectId) return "objectId";
      if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
        return isMqlShaped(v) ? "unknown" : "object";
      }
      return "unknown";
    }
    case "ArrayLiteral":
      return "array";
    case "ObjectLiteral":
      // A raw `{ $op: … }` is an operator, and its result is the operator's.
      return namedRow(node) === null ? "object" : "unknown";
    case "FieldRef":
      return node.path === "" ? "object" : "unknown";
    case "Ident":
      return env.scope.has(node.name) ? env.lookup(node.name, node.pos).type : "unknown";
    case "MemberAccess": {
      // A property row (`.length`, `Math.PI`) states its result; a field read proves nothing.
      if (!isCallable(node.name) || sourceFamily(node.object) !== null) {
        return resolveReturns(returnsOf(node.name), kindOf(node.object, env), receiverFamilyOf(node.object, env));
      }
      return "unknown";
    }
    case "MethodCall": {
      const family = receiverFamilyOf(node.object, env);
      if (family !== null) return resolveReturns(returnsOf(node.name), kindOf(node.object, env), family);
      // An unproven receiver: the call is on one of the families the row is spelled
      // on, or a server error — so its result is what the row states when every
      // such family states the same (`.size()` is a number on an array and on an
      // object), and what the one family states when there is one (`.map`).
      const r = returnsOf(node.name);
      if (typeof r === "string" && r !== "same" && r !== "element" && r !== "unknown") return r;
      const sole = soleFieldFamilyOf(node.name);
      if (sole !== null) return resolveReturns(r, sole as Known, sole);
      const agreed = agreedReturnOf(node.name);
      return agreed ?? "unknown";
    }
    case "OperatorCall":
      return resolveReturns(returnsOf(node.name), "unknown", null);
    case "CallExpression":
      // An applied arrow `((x) => x > 1)(5)` is its body — the body's kind is provable
      // wherever it does not hang on a parameter.
      if (node.callee.type === "Lambda" && node.callee.body !== undefined) return kindOf(node.callee.body, env);
      if (node.callee.type === "Ident" && env.scope.has(node.callee.name)) {
        const b = env.lookup(node.callee.name, node.callee.pos);
        if (b.ref.kind === "function" && b.ref.lambda.type === "Lambda" && b.ref.lambda.body !== undefined)
          return kindOf(b.ref.lambda.body, env);
      }
      return node.callee.type === "Ident" && !env.scope.has(node.callee.name)
        ? resolveReturns(returnsOf(node.callee.name), "unknown", null)
        : "unknown";
    case "NewExpression":
      return node.callee.type === "Ident" && !env.scope.has(node.callee.name)
        ? resolveReturns(returnsOf(node.callee.name), "unknown", null)
        : "unknown";
    case "UnaryExpr": {
      const key = productionForOperator("UnaryExpr", node.op);
      return key === undefined ? "unknown" : resolveReturns(returnsOf(key), "unknown", null);
    }
    case "BinaryExpr": {
      if (node.op === "+") {
        // `$concat` when any operand is a string, `$add` otherwise — and `$add`
        // of a date is a date, so only two numbers prove a number.
        const l = kindOf(node.left, env);
        const r = kindOf(node.right, env);
        if (l === "string" || r === "string") return "string";
        return l === "number" && r === "number" ? "number" : "unknown";
      }
      if (node.op === "&&" || node.op === "||") {
        return kindOf(node.left, env) === "bool" && kindOf(node.right, env) === "bool" ? "bool" : "unknown";
      }
      if (node.op === "??") {
        const l = kindOf(node.left, env);
        return l === kindOf(node.right, env) ? l : "unknown";
      }
      const key = productionForOperator("BinaryExpr", node.op);
      return key === undefined ? "unknown" : resolveReturns(returnsOf(key), "unknown", null);
    }
    case "TernaryExpr": {
      const c = kindOf(node.consequent, env);
      return c === kindOf(node.alternate, env) ? c : "unknown";
    }
    case "ExprBlock":
      return kindOf(node.ret, env);
    default:
      return "unknown";
  }
}

/** The family a RECEIVER node has, for a row's per-family `returns`: a source family, else its kind's. */
export function receiverFamilyOf(node: Expr, env: Env): FieldFamily | "regexp" | "set" | string | null {
  const src = sourceFamily(node);
  if (src !== null) return src;
  if (node.type === "CollectionRef") return "stream";
  return familyOfKind(kindOf(node, env));
}
