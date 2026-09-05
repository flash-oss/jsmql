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
import type { LetDecl, Pipeline, PipelineStmt, Program, UpdateFilter, UpdateOp } from "../../registry/ast.ts";
import type { BodyPath } from "../rows.ts";
import { internalError } from "../../errors.ts";
import { chainBase, namedRow, staticKey } from "../passes/naming.ts";
import { forbiddenInOf, isStageName, onlyOf, replacesDocumentOf, stageBodyRuleOf, pipelineOverOf } from "../rows.ts";
import { consult, everyName, listedIn } from "./consult.ts";
import { checkBody, checkSlots } from "./check.ts";
import { Chain, Env } from "./env.ts";
import { fieldSlot, type Binding } from "./names.ts";
import { bindingSlot } from "../../namespace.ts";
import * as E from "./errors.ts";
import { childEnv, stageInputs } from "./inputs.ts";
import { lowerFilter } from "./filter.ts";
import { lowerValue } from "./lower.ts";
import { kindOf } from "./types.ts";
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
  const out: Stage[] = [];
  let scope = childEnv(env, node, "elements").block();
  for (const el of node.elements) {
    if (el.type === "SpreadElement") throw E.spreadInStageList(el.pos);
    if (env.chain.terminal !== null) throw E.afterTerminalStage(Object.keys(env.chain.terminal)[0], el.pos);
    const step = statementStages(el as PipelineStmt, scope, out.length === 0);
    out.push(...step.stages);
    scope = step.env;
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
  /** Total: a predicate with no native query form arrives as `{ $expr: … }`. */
  predicate: (body: Expr, env: Env): QueryDoc => lowerFilter(body, env.at(FILTER)),
  reshape: lowerValue,
  /** The statements of a stage block, each as its stages, under the parameter's env. */
  block: (stages: Pipeline, env: Env): Stage[] => {
    // The block was opened where its parameters were bound.
    let scope = childEnv(env, stages, "stmts");
    const out: Stage[] = [];
    for (const stmt of stages.stmts) {
      const step = statementStages(stmt, scope, out.length === 0);
      out.push(...step.stages);
      scope = step.env;
    }
    return out;
  },
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
  // The scope THREADS: a `let` declared in one statement is a name the next one
  // reads, and a stage that replaced the document takes it away again.
  let scope = program.type === "Pipeline" ? childEnv(env, program, "stmts") : env;
  for (const stmt of stmts) {
    // The stage that writes the output is FILED rather than emitted, so the
    // `__jsmql` cleanup precedes it — but it still has to be written last.
    if (env.chain.terminal !== null) {
      throw E.afterTerminalStage(Object.keys(env.chain.terminal)[0], (stmt as { pos: number }).pos);
    }
    const first = env.chain.emitted.length === 0 && env.chain.hoisted.length === 0;
    const step = statementStages(stmt, scope, first);
    // A value that needed a stage of its own placed it ahead of this statement.
    env.chain.flush();
    env.chain.emitted.push(...step.stages);
    scope = step.env;
  }
  return env.chain.close();
}

/** A statement's stages, and the Env the NEXT statement is lowered under. */
type Step = { stages: Stage[]; env: Env };

/** One statement's stages. `first` says whether nothing stands ahead of it here. */
function statementStages(stmt: PipelineStmt, env: Env, first: boolean): Step {
  if (stmt.type === "UpdateFilter") return writeStages(stmt as UpdateFilter, env, first);
  if (stmt.type === "LetDecl") return letStages(stmt as LetDecl, env);
  if (stmt.type === "FuncDecl") throw E.pendingStatement("a function declaration", stmt.pos);
  const stages = stageStatement(stmt, env, first);
  return { stages, env: afterStages(stages, env) };
}

/**
 * `let x = <expr>;` — a value carried between stages in a field of the document,
 * `__jsmql.var.x`, which the chain's trailing cleanup drops. A constant `let`
 * never reaches here: the fold has inlined it. The binding is `mutable` for
 * `let` and not for `const`, and its type is what the registry can prove of the
 * value, so a later read is checked as the value would be.
 */
function letStages(decl: LetDecl, env: Env): Step {
  // JavaScript refuses a second `let x` in one block; so does this language. A
  // binding a stage dropped is still declared: the way back is `x = …`, not `let`.
  if (env.scope.declaredHere(decl.name)) throw E.redeclared(decl.kind, decl.name, decl.pos);
  // A block over the SAME documents shares their fields: a shadowing `let` would
  // write the outer binding's slot, and the outer read after the block would see it.
  // A body over another collection has documents of its own, and shadows freely.
  const innermost = env.site.boundaries[env.site.boundaries.length - 1];
  const ownDocuments = innermost !== undefined && pipelineOverOf(innermost.stage) === "foreign";
  if (!ownDocuments && env.scope.has(decl.name) && env.lookup(decl.name, decl.pos).ref.kind === "field")
    throw E.shadowsOuterBinding(decl.kind, decl.name, decl.pos);
  refuseUnbuiltSugar(decl.value);
  const value = readIn(decl.value, childEnv(env, decl, "value"));
  const slot = fieldSlot(bindingSlot(decl.name));
  env.chain.dirty = true;
  const bound = env.bind(decl.name, {
    ref: { kind: "field", slot },
    type: kindOf(decl.value, env),
    mutable: decl.kind === "let",
    pos: decl.pos,
  });
  return { stages: [{ $set: { [slot.path]: value } }], env: bound };
}

/**
 * The Env after `stages` ran: a stage whose row says it replaces the document
 * takes every field-carried binding with it, and the scratch namespace too, so
 * the cleanup is not owed for what is already gone.
 */
function afterStages(stages: readonly Stage[], env: Env): Env {
  let out = env;
  for (const stage of stages) {
    const name = Object.keys(stage)[0];
    const fact = replacesDocumentOf(name);
    const drops = fact === true || (fact === "inclusion" && isInclusion(stage[name]));
    if (!drops) continue;
    out = out.dropFields(name, E.afterReplace(name));
    env.chain.dirty = false;
  }
  return out;
}

/** A `$project` body that names fields to KEEP: every value is an inclusion, `_id: 0` aside. */
function isInclusion(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const entries = Object.entries(body as Record<string, unknown>).filter(([k]) => k !== "_id");
  return entries.length > 0 && entries.every(([, v]) => v === 1 || v === true);
}

/**
 * `$$ = [{ … }, { … }]` — the stream starts from a literal list of documents:
 * `$documents`, a source stage that must stand first. The empty list is a
 * stream of nothing, which needs no source stage. A list holding a `$$.reduce`
 * is the reducer WRAP, a different road.
 */
function documentsStages(list: Extract<Expr, { type: "ArrayLiteral" }>, env: Env, first: boolean): Stage[] {
  if (holdsStreamReduce(list)) throw E.pendingStatement("the reducer wrap ('$$ = [{ k: $$.reduce(…) }]')", list.pos);
  if (list.elements.length === 0) return [{ $match: { $expr: false } }];
  const call = { type: "OperatorCall", name: "$documents", args: [list], pos: list.pos } as unknown as Expr;
  return stageStatement(call, env, first);
}

/** Does the tree hold a `.reduce(…)` on the stream anywhere? */
function holdsStreamReduce(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(holdsStreamReduce);
  const n = node as { type?: string; name?: string } & Record<string, unknown>;
  if (
    n.type === "MethodCall" &&
    n.name === "reduce" &&
    (chainBase(n as object) as { type: string }).type === "CollectionRef"
  ) {
    return true;
  }
  return Object.entries(n).some(([k, v]) => k !== "type" && k !== "pos" && holdsStreamReduce(v));
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

/** The destination of `$$ = …`: not a path — the stream itself. */
const STREAM_TARGET = "$$";

/** A write's destination: the field path it names, `""` for the document root. */
function targetPath(op: UpdateOp, env: Env): string {
  const t = op.target;
  if (t.type === "FieldRef") return t.path;
  // `x = …` on a declared binding writes the field that carries it.
  if (t.type === "Ident" && env.scope.has(t.name)) {
    const b = env.lookup(t.name, t.pos);
    if (b.ref.kind === "field" || (b.ref.kind === "dropped" && b.ref.replaced)) {
      // A `let` a stage dropped is written again into its slot — see `revived`.
      if (!b.mutable) throw E.constReassigned(t.name, op.pos);
      return fieldSlot(bindingSlot(t.name)).path;
    }
    if (b.ref.kind === "dropped") throw E.droppedBinding(b.ref, t.pos);
  }
  if (t.type === "CollectionRef") return STREAM_TARGET;
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

/** A provable kind as the noun a message uses for it. */
const KIND_NOUN: Readonly<Record<string, string>> = {
  number: "a number",
  string: "a string",
  bool: "a boolean",
  array: "an array",
  date: "a date",
  null: "null",
};

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
function writeStages(uf: UpdateFilter, env: Env, first: boolean): Step {
  let inner = childEnv(env, uf, "ops");
  // `x = …` on a `let` a stage dropped carries it again: the next statement reads it.
  let revived = env;
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
    const path = targetPath(op, inner);
    // `$$ = <chain>` replaces the STREAM: its stages stand on their own, after
    // whatever the run has grouped so far.
    if (path === STREAM_TARGET) {
      if (op.type === "DeleteStmt") throw E.cannotDeleteRoot(op.pos);
      flush();
      if (op.value.type === "ArrayLiteral") {
        out.push(...documentsStages(op.value, inner, first && out.length === 0));
        continue;
      }
      out.push(...streamStages(op.value, inner, first && out.length === 0));
      continue;
    }
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
      // `null` is not a kind the registry can prove, and the server refuses it here.
      if (op.value.type === "NullLiteral" || op.value.type === "UndefinedLiteral") {
        throw E.rootMustBeDocument(op.value.type === "NullLiteral" ? "null" : "undefined", op.pos);
      }
      const kind = kindOf(op.value, inner);
      if (kind !== "unknown" && kind !== "object") throw E.rootMustBeDocument(KIND_NOUN[kind] ?? `a ${kind}`, op.pos);
      flush();
      out.push({ $replaceWith: value });
      continue;
    }
    sets ??= { paths: [], fields: {} };
    sets.paths.push(path);
    sets.fields[path] = replacesWhole(value) ? { $mergeObjects: [value] } : value;
    if (op.target.type === "Ident" && inner.lookup(op.target.name, op.target.pos).ref.kind === "dropped") {
      const binding: Binding = {
        ref: { kind: "field", slot: fieldSlot(bindingSlot(op.target.name)) },
        type: kindOf(op.value, inner),
        mutable: true,
        pos: op.target.pos,
      };
      inner = inner.bind(op.target.name, binding);
      revived = revived.bind(op.target.name, binding);
      env.chain.dirty = true;
    }
  }
  flush();
  return { stages: out, env: afterStages(out, revived) };
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

// ── the stream road ──────────────────────────────────────────────────────────

/**
 * A chain on the stream, `$$.filter(…).sortBy("k").take(3)`, as the stages it
 * means — one row's `stream` cell per link, base first. A stage is a link too
 * (`$$.$match(…)`), through the same cell its statement form uses. Each link's
 * stages take the placement its row states, exactly as a statement's do.
 */
function streamStages(chain: Expr, env: Env, first: boolean): Stage[] {
  const links: Extract<Expr, { type: "MethodCall" }>[] = [];
  let cur: Expr = chain;
  while (cur.type === "MethodCall") {
    links.unshift(cur);
    cur = cur.object;
  }
  // `$$ = $$$.orders.…` switches the stream to another collection — the join road.
  const root = chainBase(cur) as { type: string };
  if (root.type === "DatabaseRef" || root.type === "ClusterRef") {
    throw E.pendingStatement("a switch of the stream to another collection ('$$ = $$$.<coll>.…')", chain.pos);
  }
  if (cur.type !== "CollectionRef") throw E.notAStreamChain(chain.pos);
  const out: Stage[] = [];
  for (const link of links) {
    // `$$?.filter(…)` — the stream is never null; the `?.` is a misreading of `$$`.
    if (link.optional) throw E.optionalOnStream(link.pos);
    // A link after the stage that writes the output has nowhere to run, exactly
    // as a statement after it has not — measured, the server refuses both.
    if (env.chain.terminal !== null) throw E.afterTerminalStage(Object.keys(env.chain.terminal)[0], link.pos);
    const name = namedRow(link) ?? link.name;
    const verdict = consult(name, "stream", "stream");
    if (verdict.kind === "unknown" || verdict.kind === "noCell") {
      throw E.notAStreamLink(
        link.name,
        everyName().filter((n) => listedIn(n, "stream")),
        link.pos,
      );
    }
    const sel = select(verdict, { kind: "stream" }, { kind: "multiple" }, link.args.length);
    if (sel.kind !== "rule") {
      if (sel.kind === "dispatch") internalError(`stream link '${name}' selected a receiver dispatch`);
      throw E.refusalFor(sel, `'.${link.name}()'`, "'$$'", "stream", link.pos, []);
    }
    const args = link.args as readonly Expr[];
    checkSlots(name, sel.rule.args, args, stageBodyRuleOf(name) !== undefined);
    const stages = sel.rule.emit(stageInputs(name, args, positionalKeysOf(name), env, link, READ)) as Stage[];
    for (const stage of stages) out.push(...place(name, stage, env, first && out.length === 0, link.pos));
  }
  return out;
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
  if (node.type === "MethodCall") {
    // A chain rooted in a context reference is a STREAM of documents, and a
    // statement made of one is the stream road. A chain rooted in a DATABASE is a
    // read from another collection, which is the join road. Neither is built here
    // yet, and without this the chain's last LINK would be found in the registry
    // and emitted as a bare stage — measured: `$$$.orders.$match({ a: 1 });` gave
    // `[{ "$match": { "a": 1 } }]`, a filter on the wrong collection.
    // A bare `$$.<name>(…)` with ONE link asks the row's STATEMENT cell first: the
    // union sugar (`$$.push(…)`) and the source stages (`$$.indexStats()`) are
    // statements that happen to be spelled on the stream, and their rows say so.
    // Everything else is `$$ = $$.<chain>;` — the same chain, the same stages.
    if (base.type === "CollectionRef") {
      if (node.optional) throw E.optionalOnStream(node.pos);
      const says = node.object.type === "CollectionRef" ? consult(namedRow(node) ?? node.name, "statement") : null;
      if (says === null || says.kind === "refused" || says.kind === "noCell" || says.kind === "unknown") {
        return streamStages(node, env, first);
      }
    }
    if (base.type === "DatabaseRef" || base.type === "ClusterRef") {
      throw E.pendingStatement("a read from another collection ('$$$.<coll>.find(…)')", node.pos);
    }
  }
  const name = namedRow(node);
  if (name === null) throw E.notAStatement(node.pos);

  // The raw document form. Its one entry's value is the body, in the position the
  // row states for it — phase 4 has already worked that out. It is the SAME road
  // as the call: the body takes every check the row states, because
  // `{ $unwind: "items" }` is invalid on every deployment and HR1's round-trip
  // promise is not a promise to emit what no server accepts.
  let bodyEnv: Env | null = null;
  let args: readonly Expr[];
  if (node.type === "ObjectLiteral") {
    if (!isStageName(name)) throw E.notAStage(name, everyName().filter(isStageName), node.pos);
    const entries = childEnv(env, node, "entries");
    if (node.entries.length !== 1) throw E.multiKeyStageDocument(name, node.entries.length, node.pos);
    const entry = node.entries[0];
    if (entry.type !== "KeyValueEntry" || staticKey(entry) === null) throw E.notAStatement(node.pos);
    bodyEnv = childEnv(entries, entry, "value");
    args = [entry.value];
  } else {
    args = "args" in node ? (node.args as readonly Expr[]) : [];
  }
  const verdict = consult(name, "statement");
  const sel = select(verdict, { kind: "none" }, { kind: "multiple" }, args.length);
  if (sel.kind !== "rule") {
    if (sel.kind === "dispatch") internalError(`stage '${name}' selected a receiver dispatch`);
    throw E.refusalFor(sel, `'${name}'`, "", "statement", node.pos, []);
  }
  const bodyRule = stageBodyRuleOf(name);
  checkSlots(name, sel.rule.args, args, bodyRule !== undefined);
  // A stage's `body` rule describes an OBJECT body, and several stages take either
  // an object or a string — `$out("c")`, `$unionWith("c")`, `$merge("c")`. The rule
  // runs on the object form alone: on a string body `checkBody` would take its
  // positional branch and demand the object's required keys of a name.
  if (bodyRule !== undefined && args.length === 1 && args[0].type === "ObjectLiteral") {
    checkBody(name, bodyRule, args, positionalKeysOf(name), node.pos);
  }
  const stages =
    bodyEnv === null
      ? (sel.rule.emit(stageInputs(name, args, positionalKeysOf(name), env, node, READ)) as Stage[])
      : [{ [name]: readIn(args[0], bodyEnv) }];
  // A cell answers with the stages its name means; where they may STAND is the
  // row's other fact, and it is applied to each of them.
  return stages.flatMap((st) => place(Object.keys(st)[0] ?? name, st, env, first, node.pos));
}
