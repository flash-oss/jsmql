import type { Expr, QueryDoc, Stage, Type } from "../../registry/vocabulary.ts";
import type { FuncDecl, LetDecl, Pipeline, PipelineStmt, Program, UpdateFilter, UpdateOp } from "../../registry/ast.ts";
import { isFieldPathString } from "../../registry/ast.ts";
import { readsRef } from "./mql.ts";
import { isRootCarrier, setKey } from "../../registry/mql.ts";
import type { BodyPath } from "../rows.ts";
import type { Family } from "../../registry/vocabulary.ts";
import { internalError } from "../../errors.ts";
import { chainBase, isContextRef, namedRow, staticKey } from "../passes/naming.ts";
import { constantOf } from "../passes/evaluate.ts";
import {
  bansNestedOf,
  diagnosticOf,
  everyStageName,
  forbiddenInOf,
  placementOf,
  isMutator,
  isStageName,
  onlyOf,
  elementOnlyOf,
  receiverFamiliesOf,
  documentOf,
  restoresDocumentsOf,
  pipelineOverOf,
  mergesIntoOf,
  unionsOf,
  hasStreamValueCell,
  bareCallableNames,
  familiesOf,
  namespaceNames,
  streamReceiverNames,
} from "../rows.ts";
import { consult, everyMethodName, everyName, listedIn } from "./consult.ts";
import { checkBodyKeys, checkSlots } from "./check.ts";
import { Chain, Env } from "./env.ts";
import { Capture, fieldSlot, type Declared } from "./names.ts";
import { bindingSlot, JSMQL_NS } from "../../namespace.ts";
import * as E from "./errors.ts";
import { childEnv, onOwnStream, stageInputs } from "./inputs.ts";
import { lowerFilter } from "./filter.ts";
import { locate, lowerValue, provideJoin, lowerTruth, slotProof } from "./lower.ts";
import { joinRoot, joinStream, joinWrite, joinValue, readsAnotherCollection, type JoinServices } from "./join.ts";
import { documentAfter, kindOf, proofsFor, typeOf } from "./prove.ts";
import { ANY, DOCUMENT, arrayOf, cannotBe, elementOf, isOnly, maybeAbsent, of } from "./type.ts";
import { isPlainObject } from "../../bson.ts";
import {
  bodySlotAt,
  lowersOn,
  positionalKeysOf,
  positionsOf,
  statementBodyOf,
  takesLetOf,
  takesNoReceiver,
} from "../rows.ts";
import { select, UNPROVEN, shapeOf, type Receiver, type Selected } from "./select.ts";
import { noStageInDocuments, unionStages } from "./union.ts";
import { holdsStreamReduce, isReduceWrap, reduceWrapStages, arrayReduceParts, isStreamReduce } from "./reduce-wrap.ts";
import { FILTER } from "../passes/position.ts";

export function readIn(node: Expr, env: Env): unknown {
  switch (env.site.where.at) {
    case "filter":
      return lowerFilter(node, env);
    case "statement":
    case "stream":
      return subPipeline(node, env);
    case "stageBody":
      return stageBody(node, env);
    default:
      return lowerValue(node, env);
  }
}

function stageBody(node: Expr, env: Env): unknown {
  if (node.type !== "ObjectLiteral") return lowerValue(node, env);
  const entries = childEnv(env, node, "entries");
  const out: Record<string, unknown> = {};
  const captures: Capture[] = [];
  for (const entry of node.entries) {
    if (entry.type !== "KeyValueEntry") return lowerValue(node, env);
    const key = staticKey(entry);
    if (key === null) return lowerValue(node, env);
    const slot = childEnv(entries, entry, "value");
    const at = slot.site.where.at;
    setKey(
      out,
      key,
      (at === "statement" || at === "stream") && entry.value.type === "ArrayLiteral"
        ? pipelineBody(
            entry.value,
            slot,
            env.site.where.at === "stageBody" ? env.site.where.stage : "",
            [...(env.site.where.at === "stageBody" ? env.site.where.path : []), key],
            captures,
          )
        : at === "statement" || at === "stream"
          ? lowerValue(entry.value, slot)
          : readIn(entry.value, slot),
    );
  }
  const captured = captures.filter((c) => c.any);
  if (captured.length > 0) {
    const own = typeof out.let === "object" && out.let !== null ? (out.let as Record<string, unknown>) : {};
    out.let = Object.assign({}, own, ...captured.map((c) => c.vars));
  }
  return out;
}

function subPipeline(node: Expr, env: Env): Stage[] {
  if (node.type !== "ArrayLiteral") throw E.needsStageList(node.pos);
  const out: Stage[] = [];
  let scope = childEnv(env, node, "elements");
  for (const el of node.elements) {
    if (el.type === "SpreadElement") throw E.spreadInStageList(el.pos);
    if (env.chain.terminal !== null) throw E.afterTerminalStage(env.chain.terminal.spelled, el.pos);
    const step = statementStages(el as PipelineStmt, scope, out.length === 0);
    out.push(...env.chain.ahead(), ...step.stages);
    scope = step.env;
  }
  return out;
}

function pipelineBody(node: Expr, env: Env, stage: string, path: BodyPath, captures: Capture[] = []): Stage[] {
  const capture = pipelineOverOf(stage) === "foreign" ? (hasLet(stage) ? new Capture(env.level) : null) : undefined;
  if (capture) captures.push(capture);
  const body = env.enter({ stage, path, capture }, new Chain());
  body.chain.emitted.push(...subPipeline(node, body));
  return body.chain.close();
}

const hasLet = (stage: string): boolean => takesLetOf(stage);

const READ = {
  value: readIn,
  truth: lowerTruth,
  predicate: (body: Expr, env: Env): QueryDoc => lowerFilter(body, env.at(FILTER), true),
  reshape: lowerValue,
  block: (stages: Pipeline, env: Env): Stage[] => {
    let scope = childEnv(env, stages, "stmts");
    const out: Stage[] = [];
    for (const stmt of stages.stmts) {
      const step = statementStages(stmt, scope, out.length === 0);
      out.push(...env.chain.ahead(), ...step.stages);
      scope = step.env;
    }
    return out;
  },
};

export function lowerProgram(program: Program, env: Env): Stage[] {
  if (program.type === "ArrayLiteral") {
    env.chain.emitted.push(...subPipeline(program, env));
    return env.chain.close();
  }
  const stmts: readonly PipelineStmt[] =
    program.type === "Pipeline" ? (program as Pipeline).stmts : [program as PipelineStmt];
  let scope = program.type === "Pipeline" ? childEnv(env, program, "stmts") : env;
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    if (env.chain.terminal !== null) {
      throw E.afterTerminalStage(env.chain.terminal.spelled, (stmt as { pos: number }).pos);
    }
    const first = env.chain.emitted.length === 0 && env.chain.hoisted.length === 0;
    const run = declRun(stmts, i);
    const taken = run === null ? null : declStages(run, scope);
    const step = taken ?? statementStages(stmt, scope, first);
    if (taken !== null) i += taken.consumed - 1;
    env.chain.flush();
    env.chain.emitted.push(...step.stages);
    scope = step.env;
  }
  return env.chain.close();
}

type Step = { stages: Stage[]; env: Env };

const landed = (stages: Stage[], env: Env): Step => ({ stages, env: afterStages(stages, env) });

function statementStages(stmt: PipelineStmt, env: Env, first: boolean): Step {
  return clearOfNamespace(env, (stmt as { pos: number }).pos, () => statementStagesOnce(stmt, env, first));
}

function clearOfNamespace(env: Env, pos: number, lower: () => Step): Step {
  const chains = [...new Set([env.chain, env.rootChain])];
  const marks = chains.map((c) => c.mark());
  const chain = env.chain;
  const m = marks[0];
  const wroteAhead = (s: Step): boolean =>
    chain.writes > m.writes && (chain.hoisted.length > m.hoisted || s.stages.length > 1);
  let step = lower();
  if (chain.bareReads > m.bareReads && wroteAhead(step)) {
    chains.forEach((c, i) => c.rewind(marks[i]));
    chain.clearRoot = true;
    try {
      step = lower();
    } finally {
      chain.clearRoot = false;
    }
  }
  if (!(m.dirty || wroteAhead(step)) || !step.stages.some(keepsRoot)) return step;
  if (step.stages.some(readsNamespace)) throw E.rawRootReadsNamespace(pos);
  chain.namespaceRemoved();
  if (chain.writes === m.writes) chain.dirty = false;
  return {
    stages: [{ $unset: JSMQL_NS }, ...step.stages],
    env: step.env.clearedSince(env, (js) => E.clearedForRawRoot(js)),
  };
}

function statementStagesOnce(stmt: PipelineStmt, env: Env, first: boolean): Step {
  if (stmt.type === "UpdateFilter") return writeStages(stmt as UpdateFilter, env, first);
  if (stmt.type === "LetDecl") return letStages(stmt as LetDecl, env);
  if (stmt.type === "FuncDecl") {
    const decl = stmt as Extract<PipelineStmt, { type: "FuncDecl" }>;
    const lambda = decl.lambda as Extract<Expr, { type: "Lambda" }>;
    return {
      stages: [],
      env: env.bind(decl.name, {
        ref: { kind: "function", lambda, expanding: lambda.body === undefined },
        type: ANY,
        mutable: false,
        pos: decl.pos,
      }),
    };
  }
  return stageStatement(stmt, env, first);
}

function declRun(stmts: readonly PipelineStmt[], i: number): (LetDecl | FuncDecl)[] | null {
  const head = stmts[i];
  if (head.type !== "LetDecl" && head.type !== "FuncDecl") return null;
  const group = (head as LetDecl | FuncDecl).group;
  const run = [head as LetDecl | FuncDecl];
  while (i + run.length < stmts.length) {
    const next = stmts[i + run.length];
    if (next.type !== "LetDecl" && next.type !== "FuncDecl") break;
    if ((next as LetDecl | FuncDecl).group !== group) break;
    run.push(next as LetDecl | FuncDecl);
  }
  return run.length === 1 ? null : run;
}

function declStages(run: readonly (LetDecl | FuncDecl)[], env: Env): (Step & { consumed: number }) | null {
  const out: Stage[] = [];
  let fields: Record<string, unknown> | null = null;
  let slots: string[] = [];
  let scope = env;
  let consumed = 0;
  const flush = (): void => {
    if (fields !== null) out.push({ $set: fields });
    fields = null;
    slots = [];
  };
  for (const decl of run) {
    const mark = env.chain.mark();
    const rootMark = env.rootChain.mark();
    const step =
      decl.type === "FuncDecl"
        ? statementStages(decl, scope, false)
        : clearOfNamespace(scope, decl.pos, () => letStages(decl, scope));
    const hoisted = env.chain.hoisted.length > mark.hoisted || env.rootChain.hoisted.length > rootMark.hoisted;
    if (consumed > 0 && hoisted) {
      env.chain.rewind(mark);
      env.rootChain.rewind(rootMark);
      break;
    }
    consumed++;
    scope = step.env;
    const only = step.stages.length === 1 ? (step.stages[0] as Record<string, unknown>) : null;
    const set = only !== null && Object.keys(only).length === 1 ? (only.$set as Record<string, unknown>) : undefined;
    if (step.stages.length === 0) continue;
    if (set === undefined) {
      flush();
      out.push(...step.stages);
      continue;
    }
    const slot = Object.keys(set)[0];
    if (slots.some((sl) => readsRef(set[slot], `$${sl}`))) flush();
    fields ??= {};
    fields[slot] = set[slot];
    slots.push(slot);
  }
  if (consumed < 2) return null;
  flush();
  return { stages: out, env: scope, consumed };
}

function letStages(decl: LetDecl, env: Env): Step {
  const innermost = env.site.boundaries[env.site.boundaries.length - 1];
  const ownDocuments = innermost !== undefined && pipelineOverOf(innermost.stage) === "foreign";
  if (!ownDocuments && env.scope.has(decl.name) && env.lookup(decl.name, decl.pos).ref.kind === "field")
    throw E.shadowsOuterBinding(decl.kind, decl.name, decl.pos);
  refuseUnbuiltSugar(decl.value);
  const slot = fieldSlot(bindingSlot(decl.name));
  const bind = (type: Type): Env =>
    env.bind(decl.name, { ref: { kind: "field", slot }, type, mutable: decl.kind === "let", pos: decl.pos });
  if (decl.value.type === "Lambda") {
    return {
      stages: [],
      env: env.bind(decl.name, {
        ref: { kind: "function", lambda: decl.value, expanding: decl.value.body === undefined },
        type: ANY,
        mutable: false,
        pos: decl.pos,
      }),
    };
  }
  if (readsAnotherCollection(decl.value)) {
    const w = joinWrite(decl.value, slot.path, childEnv(env, decl, "value"), JOIN);
    if (w !== null) {
      env.chain.dirty = true;
      return { stages: w.stages, env: bind(w.type) };
    }
  }
  const value = readIn(decl.value, childEnv(env, decl, "value"));
  env.chain.dirty = true;
  return { stages: [{ $set: { [slot.path]: value } }], env: bind(typeOf(decl.value, childEnv(env, decl, "value"))) };
}

function afterStages(stages: readonly Stage[], env: Env): Env {
  env.chain.advance(stages);
  let out = env;
  for (const stage of stages) {
    const name = Object.keys(stage)[0];
    const after = documentAfter(stage, out.documents[out.level]);
    if (replacesDocument(name, stage)) {
      out = out.dropFields(name, E.afterReplace(name));
      env.chain.placed(true);
      env.chain.dirty = false;
    }
    out = out.document(after);
  }
  return out;
}

function holds(stage: Stage, test: (s: string) => boolean): boolean {
  const name = Object.keys(stage)[0];
  const walk = (v: unknown, path: BodyPath | null): boolean => {
    if (typeof v === "string") return test(v);
    if (Array.isArray(v)) return v.some((x) => walk(x, null));
    if (!isPlainObject(v)) return false;
    const cleared = (v as { $unsetField?: { field?: unknown } }).$unsetField;
    if ((Object.keys(v).length === 1 && cleared?.field === JSMQL_NS) || isRootCarrier(v)) return false;
    return Object.entries(v).some(([k, x]) => {
      const at = path === null ? null : [...path, k];
      const slot = at === null ? undefined : bodySlotAt(name, at)?.at;
      if ((slot === "statement" || slot === "stream") && Array.isArray(x)) return false;
      return walk(x, at);
    });
  };
  return walk(stage[name], []);
}

const keepsRoot = (stage: Stage): boolean => holds(stage, (s) => s === "$$ROOT" || s === "$$CURRENT");

const readsNamespace = (stage: Stage): boolean =>
  holds(stage, (s) => s === "$" + JSMQL_NS || s.startsWith("$" + JSMQL_NS + "."));

function replacesDocument(name: string, stage: Stage): boolean {
  const fact = documentOf(name);
  return (
    fact === "fields" || fact === "value" || fact === "unknown" || (fact === "projection" && isInclusion(stage[name]))
  );
}

function isInclusion(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const entries = Object.entries(body as Record<string, unknown>).filter(([k]) => k !== "_id");
  return entries.length > 0 && entries.every(([, v]) => v === 1 || v === true);
}

const DOCUMENTS = "$documents";

const holdsSpread = (list: Extract<Expr, { type: "ArrayLiteral" }>): boolean =>
  list.elements.some((e) => e.type === "SpreadElement");

function documentsStages(list: Extract<Expr, { type: "ArrayLiteral" }>, env: Env, written = "$$ = [ … ]"): Stage[] {
  if (isReduceWrap(list)) return reduceWrapStages(list, () => env.chain.wholeDocument());
  if (holdsStreamReduce(list)) throw E.reduceWrapMisplaced(list.pos);
  const dropAll: Stage = { $match: { $expr: false } };
  if (list.elements.length === 0) return [dropAll];
  const sel = select(
    consult(DOCUMENTS, "statement"),
    { kind: "none" },
    { kind: "multiple" },
    1,
    proofsFor([list], env, false),
  );
  if (sel.kind !== "rule") internalError(`'${DOCUMENTS}' has no statement rule`);
  checkSlots(written, sel.rule.args, [list], false);
  const body = env.enter({ stage: "$unionWith", path: ["pipeline"], capture: null }, new Chain());
  const documents = lowerValue(list, childEnv(body, list, "elements").at({ at: "value" }));
  noStageInDocuments(body.chain, written, list.pos);
  return [dropAll, { $unionWith: { pipeline: [{ [DOCUMENTS]: documents }] } }];
}

function namesWithin(
  stage: string,
  body: unknown,
  path: BodyPath = [],
  out: Map<string, boolean> = new Map(),
): Map<string, boolean> {
  const nested =
    path.length > 0 && bodySlotAt(stage, path)?.at === "statement" && statementBodyOf(stage) === "pipeline";
  if (Array.isArray(body)) {
    for (const el of body) namesWithin(stage, el, path, out);
  } else if (typeof body === "object" && body !== null) {
    for (const [k, v] of Object.entries(body)) {
      if (k.startsWith("$") && positionsOf(k) !== undefined && !out.has(k)) out.set(k, nested);
      namesWithin(stage, v, [...path, k], out);
    }
  }
  return out;
}

function place(name: string, stage: Stage, env: Env, first: boolean, pos: number, spelled = name): Stage[] {
  const only = onlyOf(name);
  const hoisted = env.chain.hoisted[0];
  const noPlacement = (held: string): never => {
    throw E.firstStageNeedsHoist(held, Object.keys(hoisted as Stage)[0], pos, held === name ? null : name);
  };
  for (const [held, nested] of [[name, false] as const, ...namesWithin(name, stage[name])]) {
    const containers =
      held === name ? env.site.boundaries.map((b) => b.stage) : [name, ...env.site.boundaries.map((b) => b.stage)];
    for (const container of containers) {
      if (forbiddenInOf(held).includes(container) || bansNestedOf(container).includes(held)) {
        throw E.forbiddenInContainer(held, container, pos, placementOf(held).container);
      }
    }
    if (held === name) {
      for (const b of env.site.boundaries) {
        const allows = statementBodyOf(b.stage);
        if (allows === null || allows === "pipeline" || allows.includes(name)) continue;
        if (bodySlotAt(b.stage, b.path)?.at !== "statement") continue;
        throw E.notInUpdateSpec(name, b.stage, allows, pos);
      }
    }
    if (held === name || nested || !onlyOf(held).includes("stageFirst")) continue;
    if (!first) throw E.mustBeFirstStage(held, pos, placementOf(held).first);
    if (hoisted !== undefined) noPlacement(held);
  }
  if (only.includes("stageFirst")) {
    if (!first) throw E.mustBeFirstStage(name, pos, placementOf(name).first);
    if (hoisted !== undefined) noPlacement(name);
  }
  if (only.includes("stageLast")) {
    const already = env.chain.terminal;
    if (already !== null) throw E.twoTerminalStages(spelled, already.spelled, pos);
    if (readsScratch(stage)) throw E.terminalReadsScratch(name, pos);
    env.chain.terminal = { stage, spelled };
    return [];
  }
  return [stage];
}

function readsScratch(v: unknown): boolean {
  if (typeof v === "string") return v.startsWith("$" + JSMQL_NS);
  if (Array.isArray(v)) return v.some(readsScratch);
  if (v !== null && typeof v === "object") return Object.values(v).some(readsScratch);
  return false;
}

const STREAM_TARGET = "$$";

function targetPath(op: UpdateOp, env: Env): string {
  const t = op.target;
  if (t.type === "FieldRef") {
    if (env.level > 0) throw E.outerWriteInForeign(op.pos);
    return t.path;
  }
  if (
    t.type === "MemberAccess" ||
    (t.type === "Ident" && env.scope.has(t.name) && env.lookup(t.name, t.pos).ref.kind === "document")
  ) {
    const loc = locate(t, env);
    if (loc !== null && loc.kind === "f") {
      if (loc.level < env.level) throw E.outerWriteInForeign(op.pos);
      return loc.path;
    }
  }
  if (t.type === "Ident" && env.scope.has(t.name)) {
    const b = env.lookup(t.name, t.pos);
    if (b.ref.kind === "field" || (b.ref.kind === "dropped" && b.ref.replaced)) {
      if (!b.mutable && !("mutates" in op && op.mutates === true)) throw E.constReassigned(t.name, op.pos);
      return fieldSlot(bindingSlot(t.name)).path;
    }
    if (b.ref.kind === "dropped") throw E.droppedBinding(b.ref, t.pos);
  }
  if (t.type === "Ident" && onOwnStream(t, env)) throw E.writeToOwnStream(t.name, t.pos);
  if (t.type === "Ident") throw new E.UnknownIdentifierError(t.name, t.pos);
  if (t.type === "StreamRef") return STREAM_TARGET;
  throw E.notAWriteTarget(op.pos);
}

function rootAsWritten(target: Expr): string {
  return target.type === "Ident" ? target.name : "$";
}

function becomeStream(
  value: Expr,
  env: Env,
  valueEnv: Env,
  first: boolean,
  written = "$$ = …",
  lead?: string,
  how?: string,
): Step {
  if (value.type === "ArrayLiteral" && !holdsSpread(value)) return landed(documentsStages(value, env, written), env);
  const chainOn = chainBase(value) as { type: string };
  const streamRoad = chainOn.type === "StreamRef" || readsAnotherCollection(value) || onOwnStream(chainOn as Expr, env);
  const t = typeOf(value, env);
  if (streamRoad || isOnly(t, "stream")) return streamStages(value, env, first);
  if (cannotBe(t, "array")) throw E.notAStreamChain(value.pos, E.nounOfKinds(t), lead, how);
  const element = elementOf(t);
  if (cannotBe(element, "object")) throw E.streamElementsNotDocuments(E.pluralNounOfKinds(element), written, value.pos);
  const arr = lowerValue(value, valueEnv);
  if (isTopLevelPath(arr)) return landed([{ $unwind: arr }, { $replaceWith: arr }], env);
  const slot = env.chain.slot();
  return landed([{ $set: { [slot.path]: arr } }, { $unwind: slot.ref }, { $replaceWith: slot.ref }], env);
}

const isTopLevelPath = (v: unknown): v is string => typeof v === "string" && /^\$[^$.][^.]*$/.test(v);

function outTarget(t: Expr): string | { db: string; coll: string } | null {
  const base = chainBase(t) as { type: string };
  if (base.type !== "DatabaseRef" && base.type !== "ClusterRef") return null;
  const segments: string[] = [];
  let cur: Expr = t;
  while (cur.type === "MemberAccess" || cur.type === "IndexAccess") {
    if (cur.type === "IndexAccess") {
      if (cur.index.type !== "StringLiteral") throw E.collectionNameFrom(cur.index);
      segments.unshift(cur.index.value);
    } else segments.unshift(cur.name);
    cur = cur.object;
  }
  if (cur.type !== "DatabaseRef" && cur.type !== "ClusterRef") throw E.notAWriteTarget(t.pos);
  const need = cur.type === "DatabaseRef" ? 1 : 2;
  if (segments.length < need) throw (need === 1 ? E.collectionMissing : E.outNeedsCollection)(t.pos);
  if (segments.length > need) throw E.outTooManySegments(t.pos);
  for (const s of segments) if (s === "" || s.startsWith("$")) throw E.badOutTarget(s, t.pos);
  return need === 1 ? segments[0] : { db: segments[0], coll: segments[1] };
}

function targetSpelling(target: string | { db: string; coll: string }): string {
  const seg = (s: string): string => (/^[A-Za-z_$][\w$]*$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`);
  return typeof target === "string" ? `$$$${seg(target)}` : `$$$$${seg(target.db)}${seg(target.coll)}`;
}

function outStages(
  op: Extract<UpdateOp, { type: "AssignExpr" }>,
  target: string | { db: string; coll: string },
  env: Env,
  first: boolean,
): Step {
  if (op.op !== "=" && op.op !== "+=") throw E.writeToCollectionOp(op.op, op.pos);
  const name = op.op === "=" ? "$out" : "$merge";
  const rhs = op.value;
  const base = chainBase(rhs) as { type: string };
  if (base.type !== "StreamRef") throw E.outNeedsStream(rhs.pos);
  const chain = rhs.type === "StreamRef" ? { stages: [], env } : streamStages(rhs, childEnv(env, op, "value"), first);
  const spelled = `${targetSpelling(target)} ${op.op} …`;
  const write = place(name, { [name]: target }, env, first && chain.stages.length === 0, op.pos, spelled);
  return { stages: [...chain.stages, ...write], env: chain.env.backAt(env) };
}

function mergeStages(node: Extract<Expr, { type: "MethodCall" }>, env: Env, first: boolean): Step {
  const target = outTarget(node.object);
  if (target === null) internalError("a collection write whose receiver names no collection");
  if (node.args.length === 0) throw E.mergeNeedsArgument(node.name, node.pos);
  if (node.args.length > 1) throw E.mergeOneSource(node.name, node.args.length, node.pos);
  const arg = node.args[0];
  const spread = arg.type === "SpreadElement";
  const source = (spread ? arg.argument : arg) as Expr;
  const inner = childEnv(env, node, "args");
  const spelling = `$$$.<coll>.${node.name}(${spread ? "...<array>" : "<array>"})`;
  const documents =
    node.name === "push" && !spread
      ? landed(oneDocumentStages(source, inner), inner)
      : becomeStream(
          source,
          inner,
          inner.at({ at: "value" }),
          first,
          spelling,
          `'${spelling}' writes MANY documents into the collection`,
          "Name the stream ('$$$.<coll>.concat($$);'), an array whose elements are the documents ('$$$.<coll>.push(...$.items);'), or ONE document ('$$$.<coll>.push({ … });').",
        );
  const spelled = `${targetSpelling(target)}.${node.name}(…)`;
  const write = place("$merge", { $merge: target }, env, false, node.pos, spelled);
  return { stages: [...documents.stages, ...write], env: documents.env.backAt(env) };
}

function oneDocumentStages(value: Expr, env: Env): Stage[] {
  const t = typeOf(value, env);
  if (cannotBe(t, "object")) throw E.mergeNotADocument(E.nounOfKinds(t), value.pos);
  return [{ $replaceWith: lowerValue(value, env.at({ at: "value" })) }];
}

function isFacet(doc: Extract<Expr, { type: "ObjectLiteral" }>): boolean {
  return doc.entries.some((e) => e.type === "KeyValueEntry" && isStreamChain(e.value));
}

const isStreamChain = (e: Expr): boolean =>
  e.type === "StreamRef" || (e.type === "MethodCall" && (chainBase(e) as { type: string }).type === "StreamRef");

function facetStages(doc: Extract<Expr, { type: "ObjectLiteral" }>, env: Env, first: boolean): Stage[] {
  const branches: Record<string, Stage[]> = {};
  const named = new Set<string>();
  const entries = childEnv(env, doc, "entries");
  for (const e of doc.entries) {
    if (e.type !== "KeyValueEntry") throw E.facetSpread(e.pos);
    const key = staticKey(e);
    if (key === null) throw E.facetComputedKey(e.pos);
    if (!isStreamChain(e.value)) throw E.facetMixed(key, e.value.pos);
    if (key === "" || key.includes(".") || key.startsWith("$")) throw E.facetKey(key, e.pos);
    if (named.has(key)) throw E.facetDuplicate(key, e.pos);
    named.add(key);
    const body = childEnv(entries, e, "value").enter({ stage: "$facet", path: [key] }, new Chain());
    if (e.value.type !== "StreamRef") body.chain.emitted.push(...streamStages(e.value, body, true).stages);
    setKey(branches, key, body.chain.close());
  }
  return place("$facet", { $facet: branches }, env, first, doc.pos);
}

function pathsRead(node: unknown, into: Set<string>): Set<string> {
  if (node === null || typeof node !== "object") return into;
  if (Array.isArray(node)) {
    for (const el of node) pathsRead(el, into);
    return into;
  }
  const n = node as { type?: string; path?: string; value?: unknown } & Record<string, unknown>;
  if (n.type === "FieldRef" && typeof n.path === "string") into.add(n.path);
  if (isFieldPathString(n as { type: string }) && typeof n.value === "string") {
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

const replacesWhole = (v: unknown): boolean => isPlainObject(v) && Object.keys(v).every((k) => !k.startsWith("$"));

const touches = (x: string, y: string): boolean =>
  x === y || x === "" || y === "" || x.startsWith(`${y}.`) || y.startsWith(`${x}.`);

function writeStages(uf: UpdateFilter, env: Env, first: boolean): Step {
  let inner = childEnv(env, uf, "ops");
  const prove = (path: string, type: Type | null): void => {
    inner = type === null ? inner.removed(path) : inner.written(path, type);
  };
  const out: Stage[] = [];
  let sets: { paths: string[]; fields: Record<string, unknown> } | null = null;
  let unsets: string[] | null = null;

  const flush = (): void => {
    const group: Stage[] = [];
    if (sets !== null) group.push({ $set: sets.fields });
    if (unsets !== null) group.push({ $unset: unsets.length === 1 ? unsets[0] : unsets });
    env.chain.advance(group);
    out.push(...group);
    sets = null;
    unsets = null;
  };
  const emit = (made: readonly Stage[] | Step = []): void => {
    const hoisted = env.chain.ahead();
    const step = "env" in made ? made : landed([...made], inner);
    out.push(...hoisted, ...step.stages);
    inner = step.env;
  };

  for (const op of uf.ops) {
    const out_ = outTarget(op.target);
    if (out_ !== null) {
      if (op.type === "DeleteStmt") throw E.notAWriteTarget(op.pos);
      flush();
      emit(outStages(op as Extract<UpdateOp, { type: "AssignExpr" }>, out_, inner, first && out.length === 0));
      continue;
    }
    const path = targetPath(op, inner);
    if (
      path === STREAM_TARGET &&
      op.type === "AssignExpr" &&
      op.value.type === "MethodCall" &&
      isStreamReduce(op.value)
    ) {
      flush();
      emit(arrayReduceStages(op.value, inner, first && out.length === 0));
      continue;
    }
    if (path === STREAM_TARGET) {
      if (op.type === "DeleteStmt") throw E.cannotDeleteRoot("$$", op.pos);
      flush();
      if (op.value.type === "ArrayLiteral" && !holdsSpread(op.value)) {
        emit(documentsStages(op.value, inner));
        continue;
      }
      emit(becomeStream(op.value, inner, childEnv(inner, op, "value").at({ at: "value" }), first && out.length === 0));
      continue;
    }
    if (op.type === "DeleteStmt") {
      if (path === "") throw E.cannotDeleteRoot(rootAsWritten(op.target), op.pos);
      if (sets !== null) flush();
      (unsets ??= []).push(path);
      prove(path, null);
      continue;
    }
    if (op.op !== "=") internalError(`an assignment reached the emit phase spelled '${op.op}'`);
    if (path === "" && op.value.type === "ObjectLiteral" && isFacet(op.value)) {
      flush();
      emit(facetStages(op.value, childEnv(inner, op, "value"), first && out.length === 0));
      continue;
    }
    if (path === "") {
      const links = elementWiseOnDocument(op.value, inner);
      if (links !== null) {
        flush();
        emit(documentStages(links, inner, first && out.length === 0));
        continue;
      }
    }
    if (unsets !== null) flush();
    const reads = pathsRead(op.value, new Set());
    if (
      sets !== null &&
      (sets.paths.some((w) => [...reads].some((r) => touches(r, w))) || sets.paths.some((w) => touches(path, w)))
    ) {
      flush();
    }
    refuseUnbuiltSugar(op.value);
    if (readsAnotherCollection(op.value)) {
      const valueEnv = childEnv(inner, op, "value");
      if (path === "") {
        flush();
        emit(joinRoot(op.value, rootAsWritten(op.target), valueEnv, JOIN));
        continue;
      }
      const w = joinWrite(op.value, path, valueEnv, JOIN);
      if (w !== null) {
        flush();
        emit(w.stages);
        prove(path, w.type);
        continue;
      }
    }
    const value = readIn(op.value, childEnv(inner, op, "value"));
    if (path === "") {
      const root = rootAsWritten(op.target);
      if (op.value.type === "NullLiteral" || op.value.type === "UndefinedLiteral") {
        throw E.rootMustBeDocument(root, op.value.type === "NullLiteral" ? "null" : "undefined", op.pos);
      }
      const t = typeOf(op.value, childEnv(inner, op, "value"));
      if (isOnly(t, "array")) throw E.rootIsArray(root, op.pos);
      if (cannotBe(t, "object")) throw E.rootMustBeDocument(root, E.nounOfKinds(t), op.pos);
      flush();
      emit([{ $replaceWith: value }]);
      continue;
    }
    emit();
    sets ??= { paths: [], fields: {} };
    sets.paths.push(path);
    setKey(sets.fields, path, replacesWhole(value) ? { $mergeObjects: [value] } : value);
    const written = typeOf(op.value, childEnv(inner, op, "value"));
    if (op.target.type === "Ident" && inner.scope.has(op.target.name)) {
      const was = inner.lookup(op.target.name, op.target.pos);
      if (was.ref.kind === "dropped") {
        const binding: Declared = {
          ref: { kind: "field", slot: fieldSlot(bindingSlot(op.target.name)) },
          type: maybeAbsent(written),
          mutable: true,
          pos: op.target.pos,
        };
        inner = inner.bind(op.target.name, binding);
        env.chain.dirty = true;
        continue;
      }
      if (was.ref.kind === "field") {
        const binding: Declared = { ref: was.ref, type: written, mutable: was.mutable, pos: was.pos };
        inner = inner.bind(op.target.name, binding);
        continue;
      }
    }
    prove(path, written);
  }
  flush();
  return { stages: out, env: inner.backAt(env) };
}

function refuseUnbuiltSugar(value: Expr): void {
  const base = chainBase(value) as { type: string };
  if (base.type === "StreamRef" && value.type === "MethodCall") {
    const direct = value.object.type === "StreamRef" && hasStreamValueCell(value.name);
    if (!direct) throw E.streamAsValue(value.pos);
  }
}

function elementWiseOnDocument(value: Expr, env: Env): readonly Link[] | null {
  const links: Link[] = [];
  let cur: Expr = value;
  while (cur.type === "MethodCall") {
    links.unshift(cur);
    cur = cur.object;
  }
  if (links.length === 0) return null;
  const base = locate(cur, env);
  if (base === null || base.kind !== "f" || base.path !== "" || base.level !== env.level) return null;
  for (const link of links) {
    const on = receiverFamiliesOf(namedRow(link) ?? link.name);
    if (link.optional || on === undefined || on === "any" || !on.includes("object") || !on.includes("stream"))
      return null;
    if (!link.args.every((a) => a.type !== "SpreadElement" && constantOf(a).ok)) return null;
  }
  return links;
}

function documentStages(links: readonly Link[], env: Env, first: boolean): Step {
  const element = env.chain.element;
  env.chain.element = "";
  const step = linkStages(links, env, first);
  if (!step.stages.some((st) => replacesDocument(Object.keys(st)[0], st))) env.chain.element = element;
  return step;
}

function streamStages(chain: Expr, env: Env, first: boolean): Step {
  const links: Link[] = [];
  let cur: Expr = chain;
  while (cur.type === "MethodCall") {
    links.unshift(cur);
    cur = cur.object;
  }
  if (readsAnotherCollection(cur)) return landed(joinStream(chain, env, first, JOIN), env);
  if (cur.type === "StreamRef" && env.level > 0) throw E.rootStreamInForeign(chain.pos);
  if (cur.type !== "StreamRef" && !onOwnStream(cur, env)) throw E.notAStreamChain(chain.pos);
  return linkStages(links, env, first);
}

type Link = Extract<Expr, { type: "MethodCall" }>;

function linkStages(links: readonly Link[], env: Env, first: boolean): Step {
  const out: Stage[] = [];
  let here = env;
  for (const link of links) {
    if (link.optional) throw E.optionalOnStream(link.pos);
    const stages = streamLink(link, here, first && out.length === 0, undefined, out);
    if (stages === null) {
      throw E.notAStreamLink(link.name, streamReceiverNames(), link.pos);
    }
    const made = [...env.chain.ahead(), ...stages];
    out.push(...made);
    here = afterLink(link, made, here);
  }
  return { stages: out, env: here };
}

function afterLink(link: Link, made: readonly Stage[], env: Env): Env {
  if (!restoresDocumentsOf(namedRow(link) ?? link.name)) return afterStages(made, env);
  env.chain.advance(made);
  return env;
}

function refStatement(node: Extract<Expr, { type: "MethodCall" }>, ref: string, env: Env, first: boolean): Stage[] {
  const name = namedRow(node) ?? node.name;
  if (node.name.startsWith("$") && diagnosticOf(name) !== undefined) {
    throw E.diagnosticIsNotALink(name, node.pos);
  }
  if (ref === "DatabaseRef") throw E.noStageOnDatabase(node.name, node.pos);
  const receiver: Receiver =
    ref === "StreamRef"
      ? { kind: "stream" }
      : ref === "ClusterRef"
        ? { kind: "namespace", name: "cluster" }
        : { kind: "none" };
  const args = node.args as readonly Expr[];
  const escape = node.name.startsWith("$");
  const proofs = escape ? UNPROVEN : proofsFor(args, childEnv(env, node, "args"), false);
  const sel = select(consult(name, "statement"), receiver, { kind: "multiple" }, node.args.length, proofs);
  const spelled = ref === "StreamRef" ? "'$$'" : ref === "DatabaseRef" ? "'$$$'" : "'$$$$'";
  let stages: Stage[];
  if (escape) {
    if (sel.kind === "spreadRefused") throw E.refusalFor(sel, `.${node.name}`, spelled, "statement", node.pos, []);
    if (args.length === 1 && isStageName(name)) checkBodyKeys(args[0]);
    stages =
      sel.kind === "rule"
        ? (sel.rule.emit(stageInputs(name, args, positionalKeysOf(name), env, node, READ)) as Stage[])
        : [plainStage(name, node, args, env)];
  } else {
    if (sel.kind !== "rule") {
      throw E.refusalFor(sel, `.${node.name}`, spelled, "statement", node.pos, [], undefined, { args });
    }
    checkSlots(node.name, sel.rule.args, args, false, undefined, false, slotProof(childEnv(env, node, "args")));
    stages = sel.rule.emit(stageInputs(name, args, positionalKeysOf(name), env, node, READ)) as Stage[];
  }
  const out: Stage[] = [];
  for (const stage of stages)
    out.push(...place(Object.keys(stage)[0], stage, env, first && out.length === 0, node.pos));
  return out;
}

function streamLink(
  link: Extract<Expr, { type: "MethodCall" }>,
  env: Env,
  first: boolean,
  row: string = namedRow(link) ?? link.name,
  soFar: readonly Stage[] = [],
): Stage[] | null {
  if (env.chain.terminal !== null) throw E.afterTerminalStage(env.chain.terminal.spelled, link.pos);
  const name = row;
  if (diagnosticOf(name) !== undefined) throw E.diagnosticIsNotALink(name, link.pos);
  if (unionsOf(name)) return unionStages(link.args, env, link, JOIN);
  const verdict = consult(name, "stream", "stream");
  const escape = link.name.startsWith("$");
  if ((verdict.kind === "unknown" || verdict.kind === "noCell") && !escape) return null;
  const only = elementOnlyOf(name);
  if (only !== null && env.chain.element === "" && (only.when === "always" || link.args.length === 0)) {
    throw E.refusalFor(
      { kind: "refused", name, message: only.why, needsSubject: true },
      `'.${link.name}()'`,
      "'$$'",
      "stream",
      link.pos,
      [],
    );
  }
  const args = link.args as readonly Expr[];
  const proofs = escape ? UNPROVEN : proofsFor(args, childEnv(env, link, "args"), false);
  const sel = select(verdict, { kind: "stream" }, { kind: "multiple" }, link.args.length, proofs);
  let stages: Stage[];
  if (escape) {
    if (sel.kind === "spreadRefused") throw E.refusalFor(sel, `'.${link.name}()'`, "'$$'", "stream", link.pos, []);
    if (args.length === 1 && isStageName(name)) checkBodyKeys(args[0]);
    stages =
      sel.kind === "rule"
        ? (sel.rule.emit(stageInputs(name, args, positionalKeysOf(name), env, link, READ, soFar, link.name)) as Stage[])
        : [plainStage(name, link, args, env)];
  } else {
    if (sel.kind !== "rule") {
      throw E.refusalFor(sel, `'.${link.name}()'`, "'$$'", "stream", link.pos, [], undefined, { args });
    }
    checkSlots(link.name, sel.rule.args, args, false, undefined, false, slotProof(childEnv(env, link, "args")));
    stages = sel.rule.emit(
      stageInputs(name, args, positionalKeysOf(name), env, link, READ, soFar, link.name),
    ) as Stage[];
  }
  const out: Stage[] = [];
  for (const stage of stages) out.push(...place(name, stage, env, first && out.length === 0, link.pos));
  if (!restoresDocumentsOf(name) && out.some((st) => replacesDocument(Object.keys(st)[0], st))) env.chain.placed(true);
  return out;
}

function peels(link: Extract<Expr, { type: "MethodCall" }>, env?: Env): boolean {
  const name = namedRow(link) ?? link.name;
  if (link.name.startsWith("$")) return true;
  const verdict = consult(name, "stream", "stream");
  if (verdict.kind === "unknown" || verdict.kind === "noCell" || verdict.kind === "refused") return false;
  const only = env === undefined ? null : elementOnlyOf(name);
  return only === null || env!.chain.element !== "" || (only.when === "bare" && link.args.length > 0);
}

const JOIN: JoinServices = { link: streamLink, peels };
provideJoin((node, env) => joinValue(node, env, JOIN));

function unknownCall(sel: Extract<Selected, { kind: "unknown" }>, node: Expr, env: Env): Error {
  if (node.type === "CallExpression" && node.callee.type === "Ident") {
    return E.unknownFunction(sel.name, [...env.scope.functionNames(), ...bareCallableNames()], node.pos);
  }
  if (node.type === "MethodCall") {
    const recv = node.object;
    if (recv.type === "Ident" && !env.scope.has(recv.name) && namespaceNames().has(recv.name)) {
      const ns = recv.name;
      const members = everyName().filter((n) => familiesOf(n)?.includes(ns as Family) === true && lowersOn(n, ns));
      return E.refusalFor(sel, `${ns}.${sel.name}`, `'${ns}'`, "statement", node.pos, members, (c) => `${ns}.${c}`);
    }
    return E.refusalFor(sel, `.${sel.name}`, "this receiver", "statement", node.pos, METHOD_NAMES);
  }
  return E.refusalFor(sel, sel.name, "", "statement", node.pos, []);
}

const METHOD_NAMES = everyMethodName();

function stageStatement(node: Expr, env: Env, first: boolean): Step {
  const base = chainBase(node) as { type: string };
  if (node.type === "MethodCall") {
    const ownStream = onOwnStream(base as Expr, env);
    const onRef = ["StreamRef", "DatabaseRef", "ClusterRef"].includes(base.type) || ownStream;
    if (onRef) {
      if (node.optional) throw E.optionalOnStream(node.pos);
      const row = namedRow(node) ?? node.name;
      if (node.object.type === "StreamRef" && isStreamReduce(node))
        return landed(arrayReduceStages(node, env, first), env);
      if (isContextRef(node.object) && unionsOf(row)) {
        if (base.type !== "StreamRef") throw E.rootStreamInForeign(node.pos);
        if (env.level > 0) throw E.rootStreamInForeign(node.pos);
        return landed(unionStages(node.args, env, node, JOIN), env);
      }
      const says = isContextRef(node.object) ? consult(row, "statement") : null;
      const ownedByAPass = says !== null && says.kind === "inCode" && peels(node);
      const asStatement =
        says !== null && says.kind !== "refused" && says.kind !== "noCell" && says.kind !== "unknown" && !ownedByAPass;
      if (!asStatement) {
        if (base.type === "StreamRef" || ownStream) return streamStages(node, env, first);
        if (isContextRef(node.object) && base.type !== "StreamRef") {
          const sigil = base.type === "ClusterRef" ? "$$$$" : "$$$";
          const scope = base.type === "ClusterRef" ? "cluster" : "database";
          const spelledOnIt = everyStageName()
            .filter((s) => diagnosticOf(s)?.scope === scope)
            .map((s) => s.slice(1));
          throw E.notAStageOnRef(node.name, sigil, spelledOnIt, node.pos);
        }
        if ((base.type === "DatabaseRef" || base.type === "ClusterRef") && mergesIntoOf(row)) {
          return mergeStages(node, env, first);
        }
        throw E.noDestination(node.pos);
      }
      return landed(refStatement(node, base.type, env, first), env);
    }
  }
  const name = namedRow(node);
  if (node.type === "StreamRef") throw E.bareContextRef("$$", node.pos);
  if (node.type === "DatabaseRef") throw E.bareContextRef("$$$", node.pos);
  if (node.type === "ClusterRef") throw E.bareContextRef("$$$$", node.pos);
  if (name === null && node.type === "ObjectLiteral" && node.entries.length > 1) {
    const head = staticKey(node.entries[0]);
    if (head !== null && head.startsWith("$")) throw E.multiKeyStageDocument(head, node.entries.length, node.pos);
  }
  if (name === null) throw E.notAStatement(node.pos);

  const escape = name.startsWith("$");
  let bodyEnv: Env | null = null;
  let args: readonly Expr[];
  if (node.type === "ObjectLiteral") {
    if (!escape && !isStageName(name)) throw E.notAStage(name, everyName().filter(isStageName), node.pos);
    const entries = childEnv(env, node, "entries");
    const entry = node.entries[0];
    if (entry.type !== "KeyValueEntry" || staticKey(entry) === null) throw E.notAStatement(node.pos);
    bodyEnv = childEnv(entries, entry, "value");
    args = [entry.value];
  } else {
    args = "args" in node ? (node.args as readonly Expr[]) : [];
  }
  if (node.type === "CallExpression" && node.callee.type === "Ident" && env.scope.has(node.callee.name)) {
    throw E.notAStatement(node.pos);
  }
  if (node.type === "MethodCall" && isMutator(name)) throw E.mutatorNeedsField(name, node.pos);
  if (node.type === "MethodCall" && takesNoReceiver(name)) throw E.noReceiver(name, node.pos);
  const verdict = consult(name, "statement");
  const proofs = escape ? UNPROVEN : proofsFor(args, childEnv(env, node, "args"), false);
  const sel = select(verdict, { kind: "none" }, shapeOf(args), args.length, proofs);
  if (escape) {
    if (sel.kind === "spreadRefused") throw E.refusalFor(sel, name, "", "statement", node.pos, []);
    if (args.length === 1 && isStageName(name)) checkBodyKeys(args[0]);
    const stages: Stage[] =
      bodyEnv !== null
        ? [{ [name]: readIn(args[0], bodyEnv) }]
        : sel.kind === "rule"
          ? (sel.rule.emit(stageInputs(name, args, positionalKeysOf(name), env, node, READ)) as Stage[])
          : [plainStage(name, node, args, env)];
    return landed(
      stages.flatMap((st) => place(Object.keys(st)[0] ?? name, st, env, first, node.pos)),
      env,
    );
  }
  if (sel.kind !== "rule") {
    if (sel.kind === "unknown") throw unknownCall(sel, node, env);
    throw E.refusalFor(sel, name, "", "statement", node.pos, [], (s) => s, { args });
  }
  checkSlots(name, sel.rule.args, args, false, undefined, false, slotProof(childEnv(env, node, "args")));
  const stages = sel.rule.emit(stageInputs(name, args, positionalKeysOf(name), env, node, READ)) as Stage[];
  return landed(
    stages.flatMap((st) => place(Object.keys(st)[0] ?? name, st, env, first, node.pos)),
    env,
  );
}

function plainStage(name: string, node: Expr, args: readonly Expr[], env: Env): Stage {
  const all = "args" in node ? (node.args as readonly { type: string; pos: number }[]) : [];
  const spread = all.find((a) => a.type === "SpreadElement");
  if (spread !== undefined) {
    throw E.refusalFor({ kind: "spreadRefused", name, sig: "…" }, name, "", "statement", spread.pos, []);
  }
  const inner = childEnv(env, node, "args");
  if (args.length === 0) return { [name]: {} };
  if (args.length === 1) return { [name]: readIn(args[0], inner) };
  return { [name]: args.map((a) => readIn(a, inner)) };
}

function arrayReduceStages(call: Extract<Expr, { type: "MethodCall" }>, env: Env, first: boolean): Stage[] {
  const parts = arrayReduceParts(call);
  const inputs = stageInputs("reduce", call.args as readonly Expr[], [], env, call, READ);
  const out: Stage[] = [];
  if (parts.test !== null) {
    const test = inputs.predicate(parts.test);
    const stages = place("$match", { $match: test }, env, first, call.pos);
    out.push(...env.chain.ahead(), ...stages);
  }
  const doc = inputs.document(parts.doc);
  const stages = place("$replaceWith", { $replaceWith: doc }, env, first && out.length === 0, call.pos);
  out.push(...env.chain.ahead(), ...stages);
  return out;
}
