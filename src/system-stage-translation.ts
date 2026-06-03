// System / diagnostic stage translation: lowers scope-encoding method-call
// sugar into MongoDB's diagnostic source stages.
//
//   $$.indexStats()                          → { $indexStats: {} }
//   $$.collStats({ storageStats: {} })       → { $collStats: { storageStats: {} } }
//   $$$$.currentOp({ allUsers: true })       → { $currentOp: { allUsers: true } }
//   $$$$.shardedDataDistribution()           → { $shardedDataDistribution: {} }
//
// These stages don't transform an incoming stream — they *produce* one (index
// metadata, collection stats, running ops, …) — so each must be the pipeline's
// first stage. They also differ by *where* they legally run, and the
// context-ref prefix encodes exactly that scope. Two tiers are in use:
//
//   $$    current collection   → db.coll.aggregate()  ($indexStats, $collStats, …)
//   $$$$  cluster / server      → admin (or config) DB ($currentOp, $listSessions,
//                                                        $shardedDataDistribution, …)
//
// $$$ (current database) carries NO diagnostics: $currentOp & friends run on the
// admin database, never the current one, so they're cluster-scoped, not
// database-scoped. Because the prefix *is* the scope, a stage used at the wrong
// scope is a compile-time error (`$$.currentOp()` → "write '$$$$.currentOp(...)'").
//
// Disambiguation vs `$lookup` (`$$$.<coll>.find(...)`): a diagnostic call is a
// *direct* MethodCall on a bare ref node (`object` is `DatabaseRef`), whereas a
// lookup's `object` is a `MemberAccess` wrapping the ref. The two shapes never
// collide. On `$$`, the diagnostic method names never clash with the reserved
// `.push` (union) / `.filter` (facet) methods, which are excluded here.
//
// The scope ↔ stage mapping lives entirely in the `diagnostic` field of the
// STAGES registry (src/stages.ts) — the single source of truth. This module
// only derives the callable method name (`stageName` minus the leading `$`)
// and the per-scope suggestion lists from it.
//
// See docs/specs/system-stages.md for the full design and error catalog.

import type { Expr } from "./ast.ts";
import { CodegenError } from "./codegen.ts";
import { closestNameTo, didYouMean } from "./levenshtein.ts";
import { STAGES } from "./stages.ts";

type Scope = "collection" | "database" | "cluster";

// Context-ref node type ↔ scope, and scope ↔ display prefix.
const REF_SCOPE: Record<string, Scope> = {
  CollectionRef: "collection",
  DatabaseRef: "database",
  ClusterRef: "cluster",
};
const SCOPE_PREFIX: Record<Scope, string> = { collection: "$$", database: "$$$", cluster: "$$$$" };
const SCOPE_DRIVER: Record<Scope, string> = {
  collection: "db.coll.aggregate()",
  database: "db.aggregate()",
  cluster: "the admin database",
};

// `$$` methods owned by other sugars — never treated as diagnostics.
const RESERVED_COLLECTION_METHODS = new Set(["push", "filter"]);

type DiagnosticDef = { stageName: string; scope: Scope; options: boolean };

// Derived from STAGES once at module load: method name → diagnostic def, and
// scope → method names (for "did you mean" suggestions).
const DIAGNOSTICS_BY_METHOD: Map<string, DiagnosticDef> = new Map();
const METHODS_BY_SCOPE: Map<Scope, string[]> = new Map([
  ["collection", []],
  ["database", []],
  ["cluster", []],
]);
for (const [stageName, def] of Object.entries(STAGES)) {
  if (def.diagnostic === undefined) continue;
  const method = stageName.slice(1); // drop leading "$"
  const entry: DiagnosticDef = { stageName, scope: def.diagnostic.scope, options: def.diagnostic.options };
  DIAGNOSTICS_BY_METHOD.set(method, entry);
  METHODS_BY_SCOPE.get(def.diagnostic.scope)!.push(method);
}

export type SystemStageCall = {
  stageName: string;
  scope: Scope;
  /** The options-object argument, or null when called with no arguments. */
  optionsExpr: Expr | null;
  /** Position of the `.<method>(...)` call site (for first-stage / arg errors). */
  callPos: number;
};

/**
 * Cheap shape check: is `expr` a *direct* method call on a bare context-ref
 * node that should be handled as a diagnostic source stage? Used by the
 * `index.ts` dispatch auto-wrap to route such a top-level call into Pipeline
 * mode, and by `pipeline.ts` to gate `resolveSystemStageCall`.
 *
 * `$$` shares its method namespace with the union (`.push`) and facet
 * (`.filter`) sugars, so on `CollectionRef` this only claims a method that is
 * an actual diagnostic — at any scope, so `$$.currentOp()` still routes here to
 * get the wrong-scope hint — or a near-typo of one (`$$.indexStat()` → "did you
 * mean indexStats"). Anything else (`$$.pop()`) returns `false` and falls
 * through to the union validator's own `.push` / `.filter` guidance.
 *
 * On `$$$` / `$$$$` a direct call is a diagnostic-only namespace (lookups use a
 * `.coll.find(...)` chain, whose receiver is a `MemberAccess`, not a bare ref),
 * so every direct call routes here — wrong-scope and misspelled methods
 * included — to get a precise error downstream.
 */
export function isSystemStageCall(expr: Expr): boolean {
  if (expr.type !== "MethodCall") return false;
  const scope = REF_SCOPE[expr.object.type];
  if (scope === undefined) return false;
  if (scope !== "collection") return true;
  if (RESERVED_COLLECTION_METHODS.has(expr.method)) return false;
  if (DIAGNOSTICS_BY_METHOD.has(expr.method)) return true;
  return closestNameTo(expr.method, DIAGNOSTICS_BY_METHOD.keys()) !== null;
}

/**
 * Resolve a direct ref method call (one that `isSystemStageCall` accepts) into
 * a validated `SystemStageCall`, or throw an actionable `CodegenError`:
 *
 *   - wrong scope (`$$.currentOp()` — a database stage) → points at the right prefix
 *   - unknown method (`$$.indexStat()`) → `Did you mean 'indexStats'?`
 *   - a no-option stage given an argument (`$$.indexStats({})`)
 *   - an option-bearing stage given >1 arg or a non-object arg
 *
 * Caller must have already checked `isSystemStageCall(expr)`.
 */
export function resolveSystemStageCall(expr: Expr): SystemStageCall {
  if (expr.type !== "MethodCall") {
    throw new CodegenError("jsmql internal error (please report): resolveSystemStageCall on a non-MethodCall.", 0);
  }
  const scope = REF_SCOPE[expr.object.type];
  const prefix = SCOPE_PREFIX[scope];
  const method = expr.method;
  const refPos = expr.object.pos;

  const def = DIAGNOSTICS_BY_METHOD.get(method);
  if (def === undefined) {
    // Suggest across *all* scopes (with the right prefix) so a typo of a
    // wrong-scope stage still lands — and so a scope with no diagnostics of its
    // own (e.g. `$$$`) still gives an actionable pointer.
    const hint = didYouMean(
      method,
      DIAGNOSTICS_BY_METHOD.keys(),
      (s) => `${SCOPE_PREFIX[DIAGNOSTICS_BY_METHOD.get(s)!.scope]}.${s}(...)`,
    );
    const here = METHODS_BY_SCOPE.get(scope)!;
    const base =
      here.length > 0
        ? `'${prefix}' (${scope} reference) supports the ${scope}-scoped system stages: ${formatList(here)}.`
        : `'${prefix}' (${scope} reference) has no diagnostic source stages — collection diagnostics use '$$', server/cluster diagnostics use '$$$$'.`;
    throw new CodegenError(`'${prefix}.${method}(...)' is not a known diagnostic stage. ${base}${hint}`, refPos);
  }
  if (def.scope !== scope) {
    throw new CodegenError(
      `'${method}' is a ${def.scope}-scoped system stage — write '${SCOPE_PREFIX[def.scope]}.${method}(...)' ` +
        `(the '${SCOPE_PREFIX[def.scope]}' ${def.scope} reference, run on ${SCOPE_DRIVER[def.scope]}), not '${prefix}'.`,
      refPos,
    );
  }

  // Argument shape.
  if (expr.args.length > 1) {
    throw new CodegenError(
      `'${prefix}.${method}(...)' takes ${def.options ? "at most one options object" : "no options"}, ` +
        `but got ${expr.args.length} arguments.`,
      expr.pos,
    );
  }
  if (expr.args.length === 0) {
    return { stageName: def.stageName, scope, optionsExpr: null, callPos: expr.pos };
  }
  const arg = expr.args[0];
  if (arg.type === "SpreadElement") {
    throw new CodegenError(`'${prefix}.${method}(...)' does not accept a spread argument.`, arg.argument.pos);
  }
  if (!def.options) {
    throw new CodegenError(`'${prefix}.${method}()' takes no options — call it with no arguments.`, arg.pos);
  }
  if (arg.type !== "ObjectLiteral") {
    throw new CodegenError(
      `'${prefix}.${method}(...)' expects an options object literal (e.g. \`${prefix}.${method}({ ... })\`), ` +
        `not a ${describeArg(arg)}.`,
      arg.pos,
    );
  }
  return { stageName: def.stageName, scope, optionsExpr: arg, callPos: expr.pos };
}

/** Message for a diagnostic source stage used anywhere but the first stage. */
export function notFirstStageMessage(call: SystemStageCall): string {
  const prefix = SCOPE_PREFIX[call.scope];
  const method = call.stageName.slice(1);
  return (
    `'${prefix}.${method}(...)' produces the pipeline's source documents (\`${call.stageName}\`), ` +
    `so it must be the first stage. Move it to the front of the pipeline.`
  );
}

function describeArg(arg: Expr): string {
  if (arg.type === "NumberLiteral" || arg.type === "StringLiteral" || arg.type === "BooleanLiteral") {
    return `${arg.type.replace(/Literal$/, "").toLowerCase()} literal`;
  }
  if (arg.type === "NullLiteral") return "`null`";
  if (arg.type === "ArrayLiteral") return "array";
  return "non-object expression";
}

function formatList(methods: string[]): string {
  return methods.map((m) => `.${m}()`).join(", ");
}
