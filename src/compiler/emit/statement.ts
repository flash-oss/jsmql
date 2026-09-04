// Phase 5 — EMIT. The statement target: a program to a pipeline.
//
// A statement becomes zero or more STAGES, and two statements never merge. The
// `;` the developer wrote IS the stage boundary and the `,` IS the merge, so one
// source keeps one output and no rule reads across a boundary the developer drew.
//
// Inside a `,`-joined run the writes group as far as ONE stage can carry them,
// and the run splits exactly where a group would say something else than the
// source does — see `writeStages`.
//
// See docs/specs/emit-pass.md § the statement target.

import type { Expr, QueryDoc, Stage } from "../../registry/vocabulary.ts";
import type { Pipeline, PipelineStmt, Program, UpdateFilter, UpdateOp } from "../../registry/ast.ts";
import type { BodyPath } from "../rows.ts";
import { internalError } from "../../errors.ts";
import { chainBase, namedRow, staticKey } from "../passes/naming.ts";
import { forbiddenInOf, isStageName, onlyOf, stageBodyRuleOf } from "../rows.ts";
import { consult, everyName } from "./consult.ts";
import { checkBody, checkSlots } from "./check.ts";
import { Chain, Env } from "./env.ts";
import * as E from "./errors.ts";
import { childEnv, stageInputs } from "./inputs.ts";
import { lowerFilter, lowerNativeFilter } from "./filter.ts";
import { lowerValue } from "./lower.ts";
import { positionalKeysOf } from "../rows.ts";
import { select } from "./select.ts";
import { FILTER } from "../passes/position.ts";

/**
 * The reading a position asks for, in ONE place. A cell's `value` service lands
 * here, so `$match`'s body — whose row states `filter` — becomes a query
 * document, and a sub-pipeline's elements become stages, without either cell
 * knowing which reading it asked for.
 */
export function readIn(node: Expr, env: Env): unknown {
  switch (env.site.where.at) {
    case "filter":
      return lowerFilter(node, env);
    case "statement":
    case "stream":
      // A bracketed program at the top level; a stage's own body arrives through
      // `pipelineBody`, which has the container to record.
      return subPipeline(node, env);
    case "stageBody":
      return stageBody(node, env);
    default:
      // Every other position is an expression, and `lowerValue` already consults
      // the cell the position names (a `$group` output takes the `group` cell).
      return lowerValue(node, env);
  }
}

/**
 * A stage body whose row states a layout: each key is read in the position the
 * row gives it, which is how `$geoNear`'s `query` becomes a query document and
 * `$lookup`'s `pipeline` becomes stages. The walk is here rather than in
 * `lowerValue` because only these two readings are not values, and a value
 * lowering that could answer a query document would have to know about both.
 */
function stageBody(node: Expr, env: Env): unknown {
  if (node.type !== "ObjectLiteral") return lowerValue(node, env);
  const entries = childEnv(env, node, "entries");
  const out: Record<string, unknown> = {};
  for (const entry of node.entries) {
    if (entry.type !== "KeyValueEntry") return lowerValue(node, env);
    const key = staticKey(entry);
    if (key === null) return lowerValue(node, env);
    const slot = childEnv(entries, entry, "value");
    const at = slot.site.where.at;
    out[key] =
      at === "statement" || at === "stream"
        ? pipelineBody(entry.value, slot, env.site.where.at === "stageBody" ? env.site.where.stage : "", [
            ...(env.site.where.at === "stageBody" ? env.site.where.path : []),
            key,
          ])
        : readIn(entry.value, slot);
  }
  return out;
}

/** A `[ … ]` of statements as a list of stages, under the chain `env` already carries. */
function subPipeline(node: Expr, env: Env): Stage[] {
  if (node.type !== "ArrayLiteral") throw E.needsStageList(node.pos);
  const inner = childEnv(env, node, "elements");
  const out: Stage[] = [];
  for (const el of node.elements) {
    if (el.type === "SpreadElement") throw E.spreadInStageList(el.pos);
    if (env.chain.terminal !== null) throw E.afterTerminalStage(Object.keys(env.chain.terminal)[0], el.pos);
    out.push(...statementStages(el as PipelineStmt, inner, out.length === 0));
  }
  return out;
}

/**
 * A sub-pipeline that is a stage's own body: its OWN chain, and the container
 * stage recorded as a boundary.
 *
 * Both matter. Without the chain, a stage filed as the pipeline's LAST is filed
 * on the OUTER one and silently leaves the body — measured: a `$out` inside a
 * `$lookup` body landed at the end of the outer pipeline and the body came out
 * empty. Without the boundary, the row's own `forbiddenIn` has no container to
 * test, and the server refuses a write stage in a sub-pipeline.
 */
function pipelineBody(node: Expr, env: Env, stage: string, path: BodyPath): Stage[] {
  const body = env.enter({ stage, path }, new Chain());
  body.chain.emitted.push(...subPipeline(node, body));
  return body.chain.close();
}

/** The services a stage cell reads: each reading of an argument this file can give. */
const READ = {
  value: readIn,
  predicate: (cb: Expr, env: Env): QueryDoc | null => lowerNativeFilter(cb, env.at(FILTER)),
  reshape: lowerValue,
};

/** A program to the pipeline it means. */
export function lowerProgram(program: Program, env: Env): Stage[] {
  // `[$match(…), $sort(…)]` — the bracketed spelling of the same program.
  if (program.type === "ArrayLiteral") {
    env.chain.emitted.push(...subPipeline(program, env));
    return env.chain.close();
  }
  const stmts: readonly PipelineStmt[] =
    program.type === "Pipeline" ? (program as Pipeline).stmts : [program as PipelineStmt];
  const inner = program.type === "Pipeline" ? childEnv(env, program, "stmts") : env;
  for (const stmt of stmts) {
    // The stage that writes the output is FILED rather than emitted, so the
    // `__jsmql` cleanup precedes it — but it still has to be written last.
    if (env.chain.terminal !== null) {
      throw E.afterTerminalStage(Object.keys(env.chain.terminal)[0], (stmt as { pos: number }).pos);
    }
    const first = env.chain.emitted.length === 0 && env.chain.hoisted.length === 0;
    const stages = statementStages(stmt, inner, first);
    // A value that needed a stage of its own placed it ahead of this statement.
    env.chain.flush();
    env.chain.emitted.push(...stages);
  }
  return env.chain.close();
}

/** One statement's stages. `first` says whether nothing stands ahead of it here. */
function statementStages(stmt: PipelineStmt, env: Env, first: boolean): Stage[] {
  if (stmt.type === "UpdateFilter") return writeStages(stmt as UpdateFilter, env);
  if (stmt.type === "LetDecl") throw E.pendingStatement("a 'let' binding that is not a constant", stmt.pos);
  if (stmt.type === "FuncDecl") throw E.pendingStatement("a function declaration", stmt.pos);
  return stageStatement(stmt, env, first);
}

/**
 * The placement a row states, applied. Both rules exist because the server
 * enforces them and no renderer implies either: measured, `$out("o"); $.b = 2;`
 * is refused with "$out can only be the final stage in the pipeline", and
 * `$.b = 2; $documents([…]);` with "$documents is only valid as the first stage".
 * A stage that must be LAST is filed on the chain rather than emitted, so nothing
 * can land after it and the `__jsmql` cleanup always precedes it.
 */
function place(name: string, stage: Stage, env: Env, first: boolean, pos: number): Stage[] {
  const only = onlyOf(name);
  for (const boundary of env.site.boundaries) {
    if (forbiddenInOf(name).includes(boundary.stage)) throw E.forbiddenInContainer(name, boundary.stage, pos);
  }
  if (only.includes("stageFirst") && !first) throw E.mustBeFirstStage(name, pos);
  if (only.includes("stageLast")) {
    const already = env.chain.terminal;
    if (already !== null) throw E.twoTerminalStages(name, Object.keys(already)[0], pos);
    env.chain.terminal = stage;
    return [];
  }
  return [stage];
}

// ── the writes ───────────────────────────────────────────────────────────────

/** A write's destination: the field path it names, `""` for the document root. */
function targetPath(op: UpdateOp): string {
  const t = op.target;
  if (t.type === "FieldRef") return t.path;
  if (t.type === "CollectionRef") throw E.pendingStatement("a write to the stream ('$$ = …')", op.pos);
  const base = chainBase(t) as { type: string };
  if (base.type === "DatabaseRef" || base.type === "ClusterRef") {
    throw E.pendingStatement("a write to another collection ('$$$.<coll> = …')", op.pos);
  }
  throw E.notAWriteTarget(op.pos);
}

/** Every field path an expression READS, the document root spelled `""`. */
function pathsRead(node: unknown, into: Set<string>): Set<string> {
  if (node === null || typeof node !== "object") return into;
  if (Array.isArray(node)) {
    for (const el of node) pathsRead(el, into);
    return into;
  }
  const n = node as { type?: string; path?: string; value?: unknown } & Record<string, unknown>;
  if (n.type === "FieldRef" && typeof n.path === "string") into.add(n.path);
  // A `"$a"` the developer typed IS the field `a` (HR1), so it reads it — and a
  // merge that missed this computed the STALE value: measured, `$.a = 1, $.b = "$a"`
  // as one `$set` gave `b` the pre-stage `a`.
  if (n.type === "StringLiteral" && typeof n.value === "string" && n.value.startsWith("$")) {
    const spelled = n.value.slice(1);
    if (!spelled.startsWith("$")) into.add(spelled);
    else if (spelled === "$ROOT" || spelled === "$CURRENT") into.add("");
  }
  for (const [k, v] of Object.entries(n)) {
    if (k === "type" || k === "pos") continue;
    pathsRead(v, into);
  }
  return into;
}

/**
 * A JavaScript assignment REPLACES the field, and `$set` handed a plain document
 * MERGES into it: measured, `{ $set: { n: { x: 1 } } }` over `n: { x: 11, y: 22 }`
 * leaves `y` behind, where `$.n = { x: 1 }` says it is gone. Wrapping the document
 * in `$mergeObjects` makes it the value of an expression rather than a nested
 * field spec, so the field takes it whole — and, unlike `$literal`, an expression
 * inside it still evaluates (`$.n = { x: $.a }` keeps reading `a`). Both measured.
 *
 * The raw stage form `$set({ n: { x: 1 } })` is the developer's own MQL and keeps
 * MongoDB's meaning; this is the JavaScript spelling, which does not.
 */
const replacesWhole = (v: unknown): boolean =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype &&
  Object.keys(v).every((k) => !k.startsWith("$"));

/** Is one path the other, or a step inside it? `a` and `a.b` touch; `a` and `ab` do not. */
const touches = (x: string, y: string): boolean =>
  x === y || x === "" || y === "" || x.startsWith(`${y}.`) || y.startsWith(`${x}.`);

/**
 * A `,`-joined run to its stages.
 *
 * One `$set` evaluates every value against the document it received, so writes
 * group freely — until a group would say something else than the source does.
 * Three things end a group, each measured:
 *   - the kind changes. `$set` and `$unset` are two stages.
 *   - the next write READS a path the group WRITES. `$.x = 1, $.z = $.x` must
 *     read the NEW x, and one `$set` would read the old one.
 *   - the next write's path TOUCHES one the group writes. The same path twice is
 *     the source saying two things, and the server refuses a parent beside its
 *     own child outright ("specification contains two conflicting paths").
 * A write to the document ROOT is its own stage: it replaces what the next write
 * would be written into.
 */
function writeStages(uf: UpdateFilter, env: Env): Stage[] {
  const inner = childEnv(env, uf, "ops");
  const out: Stage[] = [];
  let sets: { paths: string[]; fields: Record<string, unknown> } | null = null;
  let unsets: string[] | null = null;

  const flush = (): void => {
    if (sets !== null) out.push({ $set: sets.fields });
    if (unsets !== null) out.push({ $unset: unsets.length === 1 ? unsets[0] : unsets });
    sets = null;
    unsets = null;
  };

  for (const op of uf.ops) {
    const path = targetPath(op);
    if (op.type === "DeleteStmt") {
      if (path === "") throw E.cannotDeleteRoot(op.pos);
      if (sets !== null) flush();
      (unsets ??= []).push(path);
      continue;
    }
    if (op.op !== "=") internalError(`an assignment reached the emit phase spelled '${op.op}'`);
    if (unsets !== null) flush();
    const reads = pathsRead(op.value, new Set());
    if (
      sets !== null &&
      (sets.paths.some((w) => [...reads].some((r) => touches(r, w))) || sets.paths.some((w) => touches(path, w)))
    ) {
      flush();
    }
    refuseUnbuiltSugar(op.value);
    const value = readIn(op.value, childEnv(inner, op, "value"));
    // The root is not a field: replacing it is its own stage, and nothing groups with it.
    if (path === "") {
      flush();
      out.push({ $replaceWith: value });
      continue;
    }
    sets ??= { paths: [], fields: {} };
    sets.paths.push(path);
    sets.fields[path] = replacesWhole(value) ? { $mergeObjects: [value] } : value;
  }
  flush();
  return out;
}

/**
 * A write whose value reads a COLLECTION lowers to a join, and one that reads the
 * STREAM lowers to a `$facet` or a `$unionWith`. Neither is built here yet, and
 * each would otherwise surface as the value road's refusal of a scope — a true
 * sentence about an expression, and the wrong one about this statement.
 */
function refuseUnbuiltSugar(value: Expr): void {
  const base = chainBase(value) as { type: string };
  if (base.type === "DatabaseRef" || base.type === "ClusterRef") {
    throw E.pendingStatement("a read from another collection ('$$$.<coll>.find(…)')", value.pos);
  }
  // `$$.length` is a VALUE the stream carries and it already lowers; a call on the
  // stream is the pipeline-shaped read that does not.
  if (base.type === "CollectionRef" && value.type === "MethodCall") {
    throw E.pendingStatement("a read of the stream ('$$.filter(…)') as a value", value.pos);
  }
}

// ── the stage calls ──────────────────────────────────────────────────────────

/**
 * A statement that NAMES something: `$match(…)` and its siblings, `assert(…)`,
 * and the raw `{ $match: … }` document HR1 lets the developer paste. The ROW
 * decides whether the name may stand here — a stage is not the only thing that
 * can, and asking `isStageName` instead would refuse `assert` with the wrong
 * word. The row's own cell renders it, so each shape stays one fact in one place.
 */
function stageStatement(node: Expr, env: Env, first: boolean): Stage[] {
  // A chain rooted in a context reference is a STREAM of documents, and a
  // statement made of one is the stream road — not built here yet.
  const base = chainBase(node) as { type: string };
  if (base.type === "CollectionRef" && node.type === "MethodCall") {
    throw E.pendingStatement("a stream chain as a statement ('$$.filter(…);')", node.pos);
  }
  const name = namedRow(node);
  if (name === null) throw E.notAStatement(node.pos);

  // The raw document form. Its one entry's value is the body, in the position
  // the row states for it — phase 4 has already worked that out.
  if (node.type === "ObjectLiteral") {
    if (!isStageName(name)) throw E.notAStage(name, everyName().filter(isStageName), node.pos);
    const entries = childEnv(env, node, "entries");
    if (node.entries.length !== 1) throw E.multiKeyStageDocument(name, node.entries.length, node.pos);
    const entry = node.entries[0];
    if (entry.type !== "KeyValueEntry" || staticKey(entry) === null) throw E.notAStatement(node.pos);
    return place(name, { [name]: readIn(entry.value, childEnv(entries, entry, "value")) }, env, first, node.pos);
  }

  const args = "args" in node ? (node.args as readonly Expr[]) : [];
  const verdict = consult(name, "statement");
  const sel = select(verdict, { kind: "none" }, { kind: "multiple" }, args.length);
  if (sel.kind !== "rule") {
    if (sel.kind === "dispatch") internalError(`stage '${name}' selected a receiver dispatch`);
    throw E.refusalFor(sel, `'${name}'`, "", "statement", node.pos, []);
  }
  checkSlots(name, sel.rule.args, args);
  const bodyRule = stageBodyRuleOf(name);
  if (bodyRule !== undefined) checkBody(name, bodyRule, args, positionalKeysOf(name), node.pos);
  const stages = sel.rule.emit(stageInputs(name, args, positionalKeysOf(name), env, node, READ)) as Stage[];
  // A cell answers with the stages its name means; where they may STAND is the
  // row's other fact, and it is applied to each of them.
  return stages.flatMap((st) => place(Object.keys(st)[0] ?? name, st, env, first, node.pos));
}
