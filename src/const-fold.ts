// Compile-time constant folding pre-pass.
//
// `foldProgram(ast, ctx)` runs at the top of every lowering entry in index.ts
// (one-shot AND per-`jsmql.compile`-call). It walks a `;`-separated `Pipeline`,
// evaluates each foldable `const`/`let` RHS via `evalConst`, drops the folded
// declaration (it emits NO stage), and threads the folded values into
// `ctx.bindings` so references inline as literals through the existing
// `ParamRef` → `safeBoundValue` path. If the survivors collapse to a single
// expression, the program is returned as a bare `Expr` so it re-dispatches to a
// Filter (`const userId = 0x…; $.userId === userId` → `{ userId: ObjectId(…) }`).
//
// A declaration is folded only when its name is NOT reassigned, object-mutated,
// multiply-declared, or shadowing a compile-param — every such name falls back
// to the existing runtime `$set` binding path unchanged, which preserves all of
// today's collision/reshape-rebind semantics and error messages. Non-constant
// RHS (reads `$`, `new Date()`, `Math.random()`, …) simply doesn't fold and
// stays a runtime binding too.
//
// See docs/specs/const-folding.md.

import type { Expr, PipelineStmt, Program } from "./ast.ts";
import type { GenerateCtx } from "./codegen.ts";
import { CodegenError, isOpaqueBsonValue, MUTATING_ARRAY_METHODS, withBindings } from "./codegen.ts";
import { evalConst } from "./const-eval.ts";

/**
 * The static compound type of a folded value, for `ctx.bindingTypes` — so
 * type-directed codegen (notably `IndexAccess` on a `ParamRef` key/receiver)
 * keeps emitting the precise shape a runtime `const` of the same type produced.
 * Without this a folded string key `$.x[k]` would lose the `$getField`
 * optimisation and fall back to the `$isArray`-guarded form whose dead
 * `$arrayElemAt[array, "<string>"]` branch some servers reject.
 */
function foldedValueType(v: unknown): "object" | "array" | "string" | undefined {
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  if (v !== null && typeof v === "object" && !isOpaqueBsonValue(v)) return "object";
  return undefined;
}

/** A PipelineStmt that is an expression (not a declaration or update-op chain). */
function isExprStmt(stmt: PipelineStmt): boolean {
  return stmt.type !== "UpdateFilter" && stmt.type !== "LetDecl" && stmt.type !== "FuncDecl";
}

/**
 * Names that must NOT be folded — they keep the runtime binding so existing
 * semantics/errors are preserved:
 *   - reassigned (`x = …`) or object-mutated (`Object.assign(x, …)`, `x.push(…)`)
 *   - declared more than once (redeclaration / reshape-rebind is runtime-only)
 *   - shadowing a compile-time parameter binding (lowerLetDecl reports it)
 */
function collectExcluded(stmts: PipelineStmt[], ctx: GenerateCtx): ReadonlySet<string> {
  const declCounts = new Map<string, number>();
  const excluded = new Set<string>();
  for (const stmt of stmts) {
    if (stmt.type === "LetDecl" || stmt.type === "FuncDecl") {
      declCounts.set(stmt.name, (declCounts.get(stmt.name) ?? 0) + 1);
    } else if (stmt.type === "UpdateFilter") {
      for (const op of stmt.ops) {
        if (op.type === "AssignExpr" && op.target.type === "ParamRef") excluded.add(op.target.name);
      }
    } else if (stmt.type === "ObjectCall" && stmt.method === "assign") {
      const target = stmt.args[0];
      if (target && target.type === "ParamRef") excluded.add(target.name);
    } else if (
      stmt.type === "MethodCall" &&
      MUTATING_ARRAY_METHODS.has(stmt.method) &&
      stmt.object.type === "ParamRef"
    ) {
      excluded.add(stmt.object.name);
    }
  }
  for (const [name, count] of declCounts) {
    if (count > 1) excluded.add(name);
  }
  if (ctx.bindings) {
    for (const name of ctx.bindings.keys()) excluded.add(name);
  }
  return excluded;
}

export function foldProgram(ast: Program, ctx: GenerateCtx): { ast: Program; ctx: GenerateCtx } {
  if (ast.type !== "Pipeline") return { ast, ctx };

  const excluded = collectExcluded(ast.stmts, ctx);
  const folded = new Map<string, unknown>(); // folded const/let name → value
  const survivors: PipelineStmt[] = [];

  for (const stmt of ast.stmts) {
    if (stmt.type === "LetDecl" && !excluded.has(stmt.name)) {
      // `folded` doubles as the ConstEnv so later declarations see earlier
      // folded ones; evalConst also reads ctx.bindings for compile params.
      const r = evalConst(stmt.value, folded, ctx); // may throw a hard HR3 error
      if (r.ok) {
        folded.set(stmt.name, r.value);
        continue; // drop the declaration — it emits no stage
      }
    }
    survivors.push(stmt);
  }

  if (folded.size === 0) return { ast, ctx }; // nothing folded: byte-identical output

  const merged = new Map<string, unknown>(ctx.bindings ?? []);
  const mergedTypes = new Map<string, "object" | "array" | "string">(ctx.bindingTypes ?? []);
  for (const [name, value] of folded) {
    merged.set(name, value);
    const t = foldedValueType(value);
    if (t) mergedTypes.set(name, t);
  }
  let ctx2 = withBindings(ctx, merged);
  if (mergedTypes.size > 0) ctx2 = { ...ctx2, bindingTypes: mergedTypes };

  if (survivors.length === 0) {
    const last = ast.stmts[ast.stmts.length - 1];
    throw new CodegenError(
      "A `const`/`let` declaration on its own produces no query — nothing reads the constant. " +
        "Add a statement that uses it (a predicate, or a stage like `$match(...)`), or remove the declaration.",
      last.pos,
    );
  }
  if (survivors.length === 1 && isExprStmt(survivors[0])) {
    // All declarations folded and one expression remains → collapse to a bare
    // Expr so the entry re-dispatches it (a predicate → Filter, a stage call →
    // one-stage Pipeline) exactly as if written without the preamble.
    return { ast: survivors[0] as Expr, ctx: ctx2 };
  }
  return { ast: { type: "Pipeline", stmts: survivors, pos: ast.pos }, ctx: ctx2 };
}
