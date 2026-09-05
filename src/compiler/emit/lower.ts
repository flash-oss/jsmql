// Phase 5 — EMIT. An expression to its MQL.
//
// One function per reading — `lowerValue` and `lowerTruth` — over every node
// type the tree has, held exhaustive by the `switch` on `node.type`. Each case
// does one of three things: builds a document a single node determines (a
// literal, a path), consults the registry for a NAME and runs the rule select.ts
// chooses, or reads its neighbours where a row cannot — the operand types of
// `+`, the truth of the left side of `&&`, the receiver's shape under `x[0]`.
// Those neighbour-reading cases are the ones whose production row says
// `inCode`, and this file is the file it names.

import type { Expr, Position, Truth } from "../../registry/vocabulary.ts";
import type { ArrayElement, ObjectEntry, CallArg } from "../../registry/ast.ts";
import { internalError } from "../../errors.ts";
import { didYouMean } from "../../levenshtein.ts";
import { ObjectId } from "../../objectid.ts";
import { objectIdTypo } from "../objectid-guard.ts";
import { BSON_TYPE_ALIASES, TYPE_GROUPS, typeAliasOf } from "../../registry/vocabulary.ts";
import { namedRow, staticKey } from "../passes/naming.ts";
import { evaluate } from "../passes/evaluate.ts";
import {
  bindsOf,
  callbackParamsOf,
  flattensChain,
  isCallable,
  isGlobalName,
  isStageName,
  namespaceNames,
  newKeywordOf,
  positionalKeysOf,
  productionForNode,
  productionForOperator,
  rowForNodeType,
} from "../rows.ts";
import { consult, everyName, familiesFor } from "./consult.ts";
import { checkBody, checkSlots } from "./check.ts";
import { operandShapeOf, bodyRuleOf } from "../rows.ts";
import type { Env } from "./env.ts";
import * as E from "./errors.ts";
import { readsAnotherCollection } from "./join.ts";
import { onOwnStream, childEnv, exprInputs, type Reader } from "./inputs.ts";
import { and, asValue, jsTruthy, not, or, truthOf } from "./mode.ts";
import { cond, letOne, switchOn } from "./mql.ts";
import { positionOf } from "./consult.ts";
import { select, shapeOf, type Receiver, type Selected } from "./select.ts";
import { familyOfKind, kindOf, sourceFamily } from "./types.ts";
import { mongoVarName, type Located, type MongoVar } from "./names.ts";

const NAMESPACES = namespaceNames();
const READ: Reader = { value: lowerValue, truth: lowerTruth };

/** The position the Env stands in, or `value` when phase 4 named a waypoint (a raw `{ $op: … }` in a value slot is a document). */
const positionIn = (env: Env): Position => positionOf(env.site.where) ?? "value";

/** The element and argument types that are NOT expressions, held against the tree's own names. */
const NOT_EXPR: ReadonlySet<Exclude<CallArg | ArrayElement, Expr>["type"]> = new Set([
  "SpreadElement",
  "LetDecl",
  "FuncDecl",
  "AssignExpr",
  "DeleteStmt",
  "UpdateFilter",
] as const);
const isExpr = (a: CallArg | ArrayElement): a is Expr => !(NOT_EXPR as ReadonlySet<string>).has(a.type);

// ── the value reading ────────────────────────────────────────────────────────

/**
 * The node types whose VALUE is not their document: a BigInt spells `$toLong`,
 * `undefined` and a regex have no value position, a lambda is not a value, and a
 * string literal is itself already. Each has its own case below.
 */
const OWN_CASE: ReadonlySet<Expr["type"]> = new Set<Expr["type"]>([
  "StringLiteral",
  "BigIntLiteral",
  "UndefinedLiteral",
  "RegexLiteral",
  "Lambda",
  // A literal's own case lowers its parts and holds the list-operand rule for a
  // raw `{ $op: … }`; settling the whole literal would skip both.
  "ObjectLiteral",
  "ArrayLiteral",
]);
const hasOwnCase = (type: Expr["type"]): boolean => OWN_CASE.has(type);

/** A settled value holding a JavaScript bigint anywhere — the driver has no BSON for one; `$toLong` spells it. */
function holdsBigInt(v: unknown): boolean {
  if (typeof v === "bigint") return true;
  if (Array.isArray(v)) return v.some(holdsBigInt);
  if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype)
    return Object.values(v).some(holdsBigInt);
  return false;
}

/**
 * The join road, lent by statement.ts at load: a chain on another collection in a
 * value position hoists its `$lookup` ahead of the statement. Registered rather
 * than imported, because the road needs the statement target's link walker and
 * the statement target imports this file.
 */
let joinRoad: ((node: Expr, env: Env) => unknown) | null = null;
export function provideJoin(road: (node: Expr, env: Env) => unknown): void {
  joinRoad = road;
}

export function lowerValue(node: Expr, env: Env): unknown {
  if (
    (node.type === "MethodCall" || node.type === "MemberAccess" || node.type === "IndexAccess") &&
    readsAnotherCollection(node)
  ) {
    if (joinRoad === null) internalError("the join road was read before statement.ts lent it");
    return joinRoad(node, env);
  }
  // A constant is its VALUE, before any row is read. The fold writes back what has
  // a source spelling; a Date, an ObjectId or a Set has none and stays a node, so
  // the evaluator is asked here — with its own exclusions (an operator call is the
  // developer's MQL and is never evaluated).
  if (node.type !== "OperatorCall" && !hasOwnCase(node.type)) {
    const settled = evaluate(node, new Map());
    if (settled.ok && !holdsBigInt(settled.value)) {
      // `ObjectId("…")` settles to a live id: the same plausibility rule the
      // literal has, because the same typo is possible.
      if (settled.value instanceof ObjectId) {
        const typo = objectIdTypo(settled.value.toHexString());
        if (typo !== null) throw new E.CodegenError(typo, node.pos);
      }
      return settled.value;
    }
  }
  switch (node.type) {
    case "NumberLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
      return node.value;
    case "NullLiteral":
      return null;
    case "BigIntLiteral":
      return { $toLong: node.value };
    case "UndefinedLiteral":
      throw E.undefinedAsValue(node.pos);
    case "RegexLiteral":
      throw E.regexAsValue(node.pos);
    case "ObjectIdLiteral":
      return new ObjectId(node.hex);
    case "TemplateLiteral":
      return templateLiteral(node, env);
    case "ArrayLiteral":
      return arrayLiteral(node, node.elements, env);
    case "ObjectLiteral":
      return objectLiteral(node, node.entries, env);
    case "FieldRef":
      return env.render(locate(node, env) as Located, node.pos);
    case "CollectionRef":
    case "DatabaseRef":
    case "ClusterRef":
      return rootAsValue(node, env);
    case "Ident":
      return identifier(node, env);
    case "MemberAccess":
      return memberAccess(node, env);
    case "IndexAccess":
      return indexAccess(node, env);
    case "MethodCall":
      return methodCall(node, env);
    case "CallExpression":
      return callExpression(node, env);
    case "NewExpression":
      return newExpression(node, env);
    case "OperatorCall":
      return operatorCall(node, env);
    case "UnaryExpr":
      return unary(node, env);
    case "BinaryExpr":
      return binary(node, env);
    case "TernaryExpr": {
      const key = productionForNode("TernaryExpr");
      if (key === undefined) internalError("no production builds a TernaryExpr");
      return production(node, key, [node.test, node.consequent, node.alternate], env);
    }
    case "Lambda":
      throw E.lambdaAsValue(node.pos);
    case "ExprBlock":
      return exprBlock(node, env, lowerValue);
  }
}

// ── the truth reading ────────────────────────────────────────────────────────

export function lowerTruth(node: Expr, env: Env): Truth {
  if (node.type === "BinaryExpr" && (node.op === "&&" || node.op === "||")) {
    const operands = chainOf(node, node.op).map((e) => lowerTruth(e, childEnv(env, node, "left")));
    return node.op === "&&" ? and(...operands) : or(...operands);
  }
  if (node.type === "UnaryExpr" && node.op === "!") {
    // `!!x` read for truth IS the truth of x — not a `$not` of a `$not`.
    const inner = node.argument;
    if (inner.type === "UnaryExpr" && inner.op === "!")
      return lowerTruth(inner.argument, childEnv(env, inner, "argument"));
    return not(lowerTruth(inner, childEnv(env, node, "argument")));
  }
  if (node.type === "TernaryExpr") {
    const test = lowerTruth(node.test, childEnv(env, node, "test"));
    return truthOf(cond(test, lowerTruth(node.consequent, env), lowerTruth(node.alternate, env)), true);
  }
  if (node.type === "ExprBlock")
    return truthOf(
      exprBlock(node, env, (ret, e) => lowerTruth(ret, e)),
      true,
    );
  return truthOf(lowerValue(node, env), kindOf(node, env) === "bool");
}

// ── literals with structure ──────────────────────────────────────────────────

function templateLiteral(node: Extract<Expr, { type: "TemplateLiteral" }>, env: Env): unknown {
  if (node.exprs.length === 0) return node.quasis[0] ?? "";
  const parts: unknown[] = [];
  const inner = childEnv(env, node, "exprs");
  node.exprs.forEach((e, i) => {
    if (node.quasis[i] !== "") parts.push(node.quasis[i]);
    const lowered = lowerValue(e, inner);
    const safe = chainHasOptional(e) ? { $ifNull: [lowered, ""] } : lowered;
    parts.push(kindOf(e, inner) === "string" ? safe : { $toString: safe });
  });
  const tail = node.quasis[node.exprs.length];
  if (tail !== "" && tail !== undefined) parts.push(tail);
  return { $concat: parts };
}

/** Does this access chain carry a `?.` anywhere on the way to its base — a folded path included? */
function chainHasOptional(e: Expr): boolean {
  let cursor: Expr = e;
  while (cursor.type === "MemberAccess" || cursor.type === "IndexAccess") {
    if (cursor.optional) return true;
    cursor = cursor.object;
  }
  return cursor.type === "FieldRef" && cursor.optional === true;
}

/** Every stage name the registry has, for the suggestion a mistyped stage gets. */
const STAGE_NAMES = everyName().filter(isStageName);

/**
 * A bracketed STAGE LIST — `[$match(…), $sort(…)]`, `[{ $match: … }]` — is a
 * pipeline. It has no value, and lowering it as an array of operators produces a
 * document the server refuses on every input; the developer is told what it is.
 * The judgement is by the FIRST element: a `$`-named call, or an object whose
 * single key is `$`-led. A mistyped stage gets the stage it meant.
 */
function refuseStageList(node: Expr, elements: readonly ArrayElement[]): void {
  const first = elements[0];
  if (first === undefined) return;
  const stageLike = (el: ArrayElement): { name: string; keys: number } | null => {
    if (el.type === "OperatorCall") return { name: el.name, keys: 1 };
    if (el.type === "ObjectLiteral") {
      const keys = el.entries.map(staticKey);
      if (keys.length > 0 && keys[0] !== null && keys[0].startsWith("$")) return { name: keys[0], keys: keys.length };
    }
    return null;
  };
  const head = stageLike(first);
  if (head === null) return;
  // A known stage, or a name the registry does not know that is NEAR a stage
  // (`$macth`). A known operator (`[$abs($.a), 1]`) or an unknown name near no
  // stage is an array of values — HR2 passes it through.
  const near = consult(head.name, "value").kind === "unknown" && didYouMean(head.name, STAGE_NAMES) !== "";
  if (!isStageName(head.name) && !near) return;
  elements.forEach((el, i) => {
    const s = stageLike(el);
    if (s === null) return;
    if (s.keys !== 1) throw E.multiKeyStage(i, s.keys, el.pos);
    if (!isStageName(s.name)) throw E.unknownStage(i, s.name, STAGE_NAMES, el.pos);
  });
  throw E.stageListAsValue(node.pos);
}

function arrayLiteral(node: Expr, elements: readonly ArrayElement[], env: Env): unknown {
  refuseStageList(node, elements);
  const inner = childEnv(env, node, "elements");
  for (const el of elements) {
    if (el.type === "AssignExpr" || el.type === "UpdateFilter") throw E.statementInValue("Assignment", el.pos);
    if (el.type === "DeleteStmt") throw E.statementInValue("delete", el.pos);
    if (el.type === "LetDecl") throw E.statementInValue("`let`", el.pos);
    if (el.type === "FuncDecl") throw E.statementInValue("A function declaration", el.pos);
  }
  if (!elements.some((el) => el.type === "SpreadElement"))
    return elements.filter(isExpr).map((el) => lowerValue(el, inner));
  // Consecutive plain elements group into one literal operand; each spread is its own.
  const operands: unknown[] = [];
  let group: unknown[] = [];
  const flush = () => {
    if (group.length > 0) operands.push(group);
    group = [];
  };
  for (const el of elements) {
    if (el.type === "SpreadElement") {
      flush();
      const v = lowerValue(el.argument, inner);
      operands.push(chainHasOptional(el.argument) ? { $ifNull: [v, []] } : v);
    } else if (isExpr(el)) group.push(lowerValue(el, inner));
  }
  flush();
  return operands.length === 1 ? operands[0] : { $concatArrays: operands };
}

function objectLiteral(node: Expr, entries: readonly ObjectEntry[], env: Env): unknown {
  const inner = childEnv(env, node, "entries");
  const staticEntries = (list: readonly ObjectEntry[]): unknown => {
    if (list.some((e) => e.type === "KeyValueEntry" && e.key.kind === "computed")) {
      // `$arrayToObject` reads a literal array as its argument LIST, so the pairs are wrapped one level deeper.
      const pairs = list.map((e) => {
        if (e.type !== "KeyValueEntry") internalError("a spread reached the computed-key path");
        const k = e.key.kind === "static" ? e.key.name : lowerValue(e.key.expr, inner);
        return { k, v: lowerValue(e.value, inner) };
      });
      return { $arrayToObject: [pairs] };
    }
    const out: Record<string, unknown> = {};
    for (const e of list) {
      if (e.type !== "KeyValueEntry" || e.key.kind !== "static")
        internalError("a non-static entry reached the static path");
      // `{ $setUnion: $.x }` — a list-only operator with a lone non-array operand is the
      // shape the server refuses, on this spelling as on the call.
      if (e.key.name.startsWith("$") && operandShapeOf(e.key.name) === "array" && e.value.type !== "ArrayLiteral") {
        throw E.listOperand(e.key.name, e.value.pos);
      }
      out[e.key.name] = lowerValue(e.value, inner);
    }
    return out;
  };
  if (!entries.some((e) => e.type === "SpreadElement")) return staticEntries(entries);
  const operands: unknown[] = [];
  let group: ObjectEntry[] = [];
  const flush = () => {
    if (group.length > 0) operands.push(staticEntries(group));
    group = [];
  };
  for (const e of entries) {
    if (e.type === "SpreadElement") {
      flush();
      operands.push(lowerValue(e.argument, inner));
    } else group.push(e);
  }
  flush();
  return operands.length === 1 ? operands[0] : { $mergeObjects: operands };
}

// ── references ───────────────────────────────────────────────────────────────

/** `$$`, `$$$`, `$$$$` read as a value: the root's row says why not. */
function rootAsValue(node: Expr, env: Env): never {
  const name = rowForNodeType(node.type);
  if (name === undefined) internalError(`no root row builds a '${node.type}'`);
  const sel = select(consult(name, positionIn(env)), { kind: "none" }, { kind: "none" }, 0);
  throw E.refusalFor(sel, name, "", positionIn(env), node.pos, []);
}

function identifier(node: Extract<Expr, { type: "Ident" }>, env: Env): unknown {
  if (env.scope.has(node.name)) {
    const b = env.lookup(node.name, node.pos);
    switch (b.ref.kind) {
      case "var":
        return b.ref.ref;
      case "document":
      case "field":
        return env.render(locate(node, env) as Located, node.pos);
      case "constant":
        return b.ref.value;
      case "function":
        throw E.functionAsValue(node.name, node.pos);
      case "streamHandle":
        throw E.functionAsValue(node.name, node.pos);
      case "dropped":
        throw E.droppedBinding(b.ref, node.pos);
    }
  }
  // A global read without a call — `Number`, `Math` — is a callable used as a value.
  if (isGlobalName(node.name) || NAMESPACES.has(node.name)) throw E.callableAsValue(node.name, node.pos);
  throw new E.UnknownIdentifierError(node.name, node.pos);
}

/**
 * WHERE an access chain reads: which level of documents, which path on it — or a
 * variable — so the level that reads it can render it (Env.render). `$.x` is the
 * ROOT document at every depth (HR4); a parameter bound as a document is its own
 * level's; a `let` carried in a field lives on the level it was declared at.
 */
export function locate(node: Expr, env: Env): Located | null {
  if (node.type === "FieldRef") {
    return { kind: "f", level: 0, path: node.path, hint: node.path === "" ? "root" : lastSegment(node.path) };
  }
  if (node.type === "Ident" && env.scope.has(node.name)) {
    const b = env.lookup(node.name, node.pos);
    if (b.ref.kind === "var") return { kind: "var", ref: b.ref.ref };
    if (b.ref.kind === "document") return { kind: "f", level: b.level, path: "", hint: node.name };
    if (b.ref.kind === "field") return { kind: "v", level: b.level, path: b.ref.slot.path, hint: node.name };
    return null;
  }
  // `$["ext-code"]`, `o["sub-id"]` — a field whose name is not a bare identifier.
  if (node.type === "IndexAccess" && node.index.type === "StringLiteral") {
    const base = locate(node.object, env);
    // Only on a DOCUMENT (`$`, a parameter): a bracket on a sub-document reads by `$getField`.
    if (base === null || base.kind === "var" || base.path !== "") return null;
    const name = node.index.value;
    return { ...base, path: base.path === "" ? name : `${base.path}.${name}`, hint: name };
  }
  if (node.type === "MemberAccess" && !isPropertyRow(node)) {
    const base = locate(node.object, env);
    if (base === null) return null;
    if (base.kind === "var") return { kind: "var", ref: `${base.ref}.${node.name}` };
    // A field of the DOCUMENT is a root path, spelled as `$.x` spells it: `d.x` in
    // `$$.map(d => d.x)` is "$x", not "$$ROOT.x".
    return { ...base, path: base.path === "" ? node.name : `${base.path}.${node.name}`, hint: node.name };
  }
  return null;
}

const lastSegment = (path: string): string => path.slice(path.lastIndexOf(".") + 1);

/** The `$$x.a.b` / `$a.b` path an access chain on a bound name spells, or null when it is not one. */
function pathOf(node: Expr, env: Env): string | null {
  const loc = locate(node, env);
  return loc === null ? null : env.render(loc, node.pos);
}

/** Is `.name` on this receiver a PROPERTY row — `.length`, `Math.PI` — rather than a field read? */
function isPropertyRow(node: Extract<Expr, { type: "MemberAccess" }>): boolean {
  // A namespace has members, not fields; elsewhere only a row that is READ (`length`) is a property.
  return sourceFamily(node.object) !== null || !isCallable(node.name);
}

function memberAccess(node: Extract<Expr, { type: "MemberAccess" }>, env: Env): unknown {
  if (isPropertyRow(node)) return dispatchOn(node, node.name, node.object, [], env, node.optional);
  const path = pathOf(node, env);
  if (path !== null) return path;
  const raw = lowerValue(node.object, childEnv(env, node, "object"));
  const input = node.optional || chainHasOptional(node.object) ? { $ifNull: [raw, {}] } : raw;
  return { $getField: { field: node.name, input } };
}

function indexAccess(node: Extract<Expr, { type: "IndexAccess" }>, env: Env): unknown {
  const objEnv = childEnv(env, node, "object");
  // `$["a.b"]` — a field whose name is not a bare identifier.
  {
    const loc = locate(node, env);
    if (loc !== null) return env.render(loc, node.pos);
  }
  const raw = lowerValue(node.object, objEnv);
  const idx = lowerValue(node.index, childEnv(env, node, "index"));
  const optional = node.optional || chainHasOptional(node.object);
  const known =
    node.object.type === "FieldRef" && node.object.path === "" ? "object" : familyOfKind(kindOf(node.object, objEnv));
  const wrapped = (neutral: unknown) => (optional ? { $ifNull: [raw, neutral] } : raw);
  if (kindOf(node.index, env) === "string") return { $getField: { field: idx, input: wrapped({}) } };
  const literal = evaluate(node.index, new Map());
  if (literal.ok && typeof literal.value === "number" && Number.isInteger(literal.value)) {
    const i = literal.value;
    if (i < 0) throw E.negativeIndex(i, node.pos);
    const charAt = (o: unknown) => ({ $substrCP: [o, i, 1] });
    const fieldAt = (o: unknown) => ({ $getField: { field: String(i), input: o } });
    if (known === "array") return { $arrayElemAt: [wrapped([]), i] };
    if (known === "string") return charAt(wrapped(""));
    if (known === "object") return fieldAt(wrapped({}));
    const o = wrapped([]);
    return cond(
      truthOf({ $isArray: o }, true),
      { $arrayElemAt: [o, i] },
      cond(truthOf({ $eq: [{ $type: o }, "string"] }, true), charAt(o), fieldAt(o)),
    );
  }
  const key = { $toString: { $ifNull: [idx, ""] } };
  if (known === "object") return { $getField: { field: key, input: wrapped({}) } };
  if (known === "array") return { $arrayElemAt: [wrapped([]), idx] };
  const o = wrapped([]);
  return cond(truthOf({ $isArray: o }, true), { $arrayElemAt: [o, idx] }, { $getField: { field: key, input: o } });
}

// ── calls ────────────────────────────────────────────────────────────────────

/** The receiver's proof for select.ts, and its lowered form. */
function receiverOf(recv: Expr, env: Env): Receiver {
  const src = sourceFamily(recv);
  if (src !== null && NAMESPACES.has(src))
    return { kind: "namespace", name: src as Receiver extends { name: infer N } ? N : never };
  if (recv.type === "CollectionRef" || onOwnStream(recv, env)) return { kind: "stream" };
  // A regex has no value of its own: its row reads the pattern and flags off the
  // source node, so the node itself is handed over.
  if (src === "regexp") return { kind: "value", family: "regexp", lowered: recv };
  const lowered = lowerValue(recv, env);
  if (src === "set") return { kind: "value", family: "set", lowered };
  const family = familyOfKind(kindOf(recv, env));
  return family === null ? { kind: "opaque", lowered } : { kind: "value", family, lowered };
}

const spelledMethod = (name: string, recv: Expr): string =>
  recv.type === "Ident" && NAMESPACES.has(recv.name) ? `${recv.name}.${name}` : `.${name}`;

/** Every JavaScript name, for a suggestion over a real closed set. */
const JS_NAMES = everyName().filter((n) => !n.startsWith("$"));

function methodCall(node: Extract<Expr, { type: "MethodCall" }>, env: Env): unknown {
  return dispatchOn(node, node.name, node.object, node.args, env, node.optional);
}

/** A name on a receiver: consult, select, run. */
function dispatchOn(
  node: Expr,
  name: string,
  recvNode: Expr,
  args: readonly CallArg[],
  env: Env,
  optional: boolean,
): unknown {
  const position = positionIn(env);
  const recvEnv = childEnv(env, node, "object");
  const receiver = receiverOf(recvNode, recvEnv);
  // A METHOD on the stream where a value belongs — `$ = { k: $$.filter(…) }` — is
  // the `$facet` road, not built yet. A stream cell must never run on a value
  // record, which has none of the readings a stream cell asks for; a property of
  // the stream (`$$.length`) is a value of its own and passes.
  if (node.type === "MethodCall" && receiver.kind === "stream" && position !== "stream" && position !== "statement") {
    throw E.pendingStatement("a read of the stream ('$$.filter(…)') as a value", node.pos);
  }
  const exprArgs = args.filter(isExpr);
  const sel = select(consult(name, position), receiver, shapeOf(args as readonly Expr[]), args.length);
  const spelled = spelledMethod(name, recvNode);
  const container =
    receiver.kind === "stream" ? "'$$'" : receiver.kind === "namespace" ? `'${receiver.name}'` : "this receiver";
  if (sel.kind === "rule") {
    checkSlots(name, sel.rule.args, exprArgs);
    const recv =
      receiver.kind === "value" || receiver.kind === "opaque"
        ? withOptional(receiver.lowered, receiver, optional || chainHasOptional(recvNode))
        : null;
    return sel.rule.emit(exprInputs(name, recv, exprArgs, positionalKeysOf(name), env, node, READ));
  }
  if (sel.kind === "dispatch") {
    if (receiver.kind !== "opaque") internalError("a dispatch was selected for a proven receiver");
    return runDispatch(sel, name, receiver.lowered, exprArgs, env, node, spelled, container);
  }
  const format = receiver.kind === "namespace" ? (c: string) => `${receiver.name}.${c}` : (c: string) => `.${c}()`;
  // A namespace's suggestion draws from its own members; a value's from every JavaScript name.
  const near =
    receiver.kind === "namespace"
      ? JS_NAMES.filter((n) => {
          const on = familiesFor(n);
          return on !== undefined && on !== "any" && on.includes(receiver.name);
        })
      : JS_NAMES;
  throw E.refusalFor(sel, spelled, container, position, node.pos, near, format);
}

/** An optional chain's receiver takes the family's empty value, so a missing field reads as empty. */
function withOptional(lowered: unknown, receiver: Receiver, optional: boolean): unknown {
  if (!optional || receiver.kind !== "value") return lowered;
  const neutral =
    receiver.family === "string"
      ? ""
      : receiver.family === "array" || receiver.family === "set"
        ? []
        : receiver.family === "object"
          ? {}
          : null;
  return neutral === null ? lowered : { $ifNull: [lowered, neutral] };
}

/** The runtime dispatch: the receiver bound once, one `$switch`, the row's `uncertain` as default. */
function runDispatch(
  sel: Extract<Selected, { kind: "dispatch" }>,
  name: string,
  lowered: unknown,
  args: readonly Expr[],
  env: Env,
  node: Expr,
  spelled: string,
  container: string,
): unknown {
  const position = positionIn(env);
  // A path or a variable is cheap to repeat; anything else is bound once.
  const isRef = typeof lowered === "string" && lowered.startsWith("$");
  const bound = isRef ? null : env.fresh("recv");
  const ref = bound === null ? lowered : bound.ref;
  const bodyEnv = bound === null ? env : bound.env;
  const run = (rule: Extract<Selected, { kind: "dispatch" }>["branches"][number]["rule"]) => {
    if ("pending" in rule) throw new E.PendingLowering(name, position, rule.pending, node.pos);
    checkSlots(name, rule.args, args);
    return rule.emit(exprInputs(name, ref, args, positionalKeysOf(name), bodyEnv, node, READ));
  };
  const branches = sel.branches.map((b) => ({ case: truthOf(b.guard(ref), true), then: run(b.rule) }));
  const otherwise = sel.otherwise;
  let fallback: unknown;
  if (typeof otherwise === "function")
    fallback = otherwise(exprInputs(name, ref, args, positionalKeysOf(name), bodyEnv, node, READ));
  else if ("pending" in otherwise) throw new E.PendingLowering(name, position, otherwise.pending, node.pos);
  else
    throw E.refusalFor(
      { kind: "refused", name, message: otherwise.unsupported, needsSubject: otherwise.subjectFromCaller === true },
      spelled,
      container,
      position,
      node.pos,
      [],
    );
  const doc = switchOn(branches, fallback);
  return bound === null ? doc : letOne(bound.as, lowered, doc);
}

function callExpression(node: Extract<Expr, { type: "CallExpression" }>, env: Env): unknown {
  const { callee } = node;
  if (callee.type === "Ident") {
    if (env.scope.has(callee.name)) {
      const b = env.lookup(callee.name, callee.pos);
      if (b.ref.kind === "function") {
        if (b.ref.lambda.type !== "Lambda") internalError("a function binding holds a non-lambda");
        return applyLambda(b.ref.lambda, node.args, env, node.pos, `Function '${callee.name}'`, callee.name);
      }
      throw E.notCallable(node.pos);
    }
    if (isGlobalName(callee.name)) {
      // A constructor called without `new`, where the row requires one.
      if (newKeywordOf(callee.name) === "required") throw E.unknownFunction(callee.name, [], node.pos);
      return dispatchBare(node, callee.name, node.args, env);
    }
    throw E.unknownFunction(callee.name, [], node.pos);
  }
  if (callee.type === "Lambda") return applyLambda(callee, node.args, env, node.pos, "IIFE", null);
  throw E.notCallable(node.pos);
}

function newExpression(node: Extract<Expr, { type: "NewExpression" }>, env: Env): unknown {
  const { callee } = node;
  if (callee.type !== "Ident" || !isGlobalName(callee.name) || newKeywordOf(callee.name) === "forbidden") {
    throw E.notCallable(node.pos);
  }
  return dispatchBare(node, callee.name, node.args, env);
}

/** A global called by name — `Number(x)`, `new Date(…)`, `assert(…)`. */
function dispatchBare(node: Expr, name: string, args: readonly CallArg[], env: Env): unknown {
  const position = positionIn(env);
  const exprArgs = args.filter(isExpr);
  const sel = select(consult(name, position), { kind: "none" }, shapeOf(args as readonly Expr[]), args.length);
  if (sel.kind === "rule") return sel.rule.emit(exprInputs(name, null, exprArgs, [], env, node, READ));
  if (sel.kind === "dispatch") internalError(`a bare call to '${name}' selected a receiver dispatch`);
  throw E.refusalFor(sel, name, "", position, node.pos, []);
}

/** `((x) => …)(a)` and `f(a)`: each parameter bound once by `$let`, the body lowered under them. */
function applyLambda(
  lambda: Extract<Expr, { type: "Lambda" }>,
  args: readonly CallArg[],
  env: Env,
  pos: number,
  label: string,
  fnName: string | null,
): unknown {
  if (lambda.body === undefined) throw E.lambdaAsValue(lambda.pos);
  if (lambda.params.length !== args.length) throw E.wrongCallCount(label, lambda.params, args.length, pos);
  const vars: Record<string, unknown> = {};
  let bodyEnv = env;
  args.forEach((a, i) => {
    if (a.type === "SpreadElement") throw E.spreadInCall(label, a.pos);
    const bound = bodyEnv.param(lambda.params[i], kindOf(a, env), lambda.pos);
    vars[bound.as] = lowerValue(a, env);
    bodyEnv = bound.env;
  });
  if (fnName !== null) {
    // Recursion is refused: a MongoDB expression cannot call itself. Inside the
    // body the function's own name reads as the refusal.
    bodyEnv = bodyEnv.bind(fnName, {
      ref: { kind: "dropped", message: E.recursiveFunction(fnName, pos).message, replaced: false },
      type: "unknown",
      mutable: false,
      pos,
    });
  }
  return { $let: { vars, in: lowerValue(lambda.body, childEnv(bodyEnv, lambda, "body")) } };
}

function operatorCall(node: Extract<Expr, { type: "OperatorCall" }>, env: Env): unknown {
  const position = positionIn(env);
  const verdict = consult(node.name, position);
  if (verdict.kind === "unknown") return unknownOperator(node, node.args.filter(isExpr), env);
  // The operand LIST of a list-only operator may be written as one array literal:
  // `$setUnion([a, b])` is `$setUnion(a, b)`. A lone scalar there is the shape the
  // server refuses, and is refused here in the same words.
  const shape = operandShapeOf(node.name);
  const first = node.args[0];
  const lone = node.args.length === 1 && first.type === "ArrayLiteral" ? first : null;
  // HR2: one array literal IS the operand list, as written — `$eq([$.n, 4])` is
  // `{ $eq: ["$n", 4] }`, `$size([$.a])` is `{ $size: ["$a"] }`. It is COUNTED and
  // CHECKED by its elements, and emitted as the developer spelled it.
  let args: readonly CallArg[] = node.args;
  let operands: readonly Expr[] = node.args.filter(isExpr);
  let count = node.args.length;
  const overrides = new Map<Expr, unknown>();
  if (
    lone !== null &&
    shape === "single" &&
    !lone.elements.some((el) => el.type === "SpreadElement") &&
    lone.elements.length >= 2
  ) {
    // A 1-operand operator given a two-or-more-element array can only mean the
    // array VALUE — the server would read the literal as two arguments — so it is
    // wrapped once: `$arrayToObject([[k, v], [k, v]])` → `{ $arrayToObject: [[…]] }`.
    overrides.set(lone, [lowerValue(lone, childEnv(env, node, "args"))]);
  } else if (lone !== null && shape !== undefined && shape !== "object" && shape !== "verbatim") {
    if (lone.elements.some((el) => el.type === "SpreadElement")) {
      // A list with a spread is one array-valued expression: the operand list at runtime.
      if (shape === "array") return { [node.name]: lowerValue(lone, childEnv(env, node, "args")) };
    } else {
      operands = lone.elements.filter(isExpr);
      count = operands.length;
      // An EMPTY list is valid only where the row states it: `{ $and: [] }` is
      // true, `{ $divide: [] }` is refused. Nothing was written, so no count
      // applies — the fact is the row's `emptyList`.
      if (count === 0 && shape === "array") {
        if (ruleArgsOf(verdict)?.emptyList === true) return { [node.name]: [] };
      }
      // A list operator renders the elements; a single or flex one renders the array as written.
      if (shape === "array") args = operands;
    }
  } else if (
    shape === "array" &&
    node.args.length === 1 &&
    first.type !== "SpreadElement" &&
    verdict.kind !== "refused"
  ) {
    throw E.listOperand(node.name, first.pos);
  }
  const exprArgs = args.filter(isExpr);
  const sel = select(verdict, { kind: "none" }, shapeOf(args as readonly Expr[]), count);
  if (sel.kind !== "rule") {
    if (sel.kind === "dispatch") internalError(`'${node.name}' selected a receiver dispatch`);
    throw E.refusalFor(sel, node.name, "", position, node.pos, []);
  }
  const body = bodyRuleOf(node.name);
  if (body !== undefined) checkBody(node.name, body, exprArgs, positionalKeysOf(node.name), node.pos);
  checkSlots(node.name, sel.rule.args, operands);
  // An operator that BINDS variables: an arrow in a visible slot is lowered under
  // them, so `$let({ x: 1 }, (x) => x + 1)` reads `x` as `$$x`.
  for (const [k, v] of boundArrowOverrides(node, exprArgs, env)) overrides.set(k, v);
  const inputs = exprInputs(node.name, null, exprArgs, positionalKeysOf(node.name), env, node, READ, overrides);
  return sel.rule.emit(inputs);
}

/** The `$let(vars, arrow)` form: the arrow's parameters must name the vars, and its body is the `in`. */
function boundArrowOverrides(
  node: Extract<Expr, { type: "OperatorCall" }>,
  args: readonly Expr[],
  env: Env,
): Map<Expr, unknown> {
  const out = new Map<Expr, unknown>();
  const binds = bindsOf(node.name);
  if (binds === undefined || !("keysOf" in binds)) return out;
  const keys = positionalKeysOf(node.name);
  const varsAt = keys.indexOf(binds.keysOf);
  const varsArg = args[varsAt];
  if (varsArg === undefined || varsArg.type !== "ObjectLiteral") return out;
  const names = varsArg.entries.map(staticKey).filter((k): k is string => k !== null);
  // The variables are spelled by the same encoder that spells the parameters
  // reading them — `v_x` becomes `v_v_5fx` on BOTH sides, so the body's `$$v_v_5fx`
  // finds its variable, and a name the server refuses (`ROOT`) becomes one it takes.
  const inner = childEnv(env, node, "args");
  const vars: Record<string, unknown> = {};
  for (const e of varsArg.entries) {
    if (e.type !== "KeyValueEntry" || e.key.kind !== "static") return out; // a spread or computed key: as written
    vars[mongoVarName(e.key.name)] = lowerValue(e.value, inner);
  }
  out.set(varsArg, vars);
  for (const slot of binds.visibleIn) {
    const arg = args[keys.indexOf(slot)];
    if (arg === undefined || arg.type !== "Lambda" || arg.body === undefined) continue;
    if (!arg.params.every((p) => names.includes(p))) throw E.letParamsMustNameVars(arg.params, names, arg.pos);
    let bodyEnv = childEnv(env, node, "args");
    for (const p of arg.params) bodyEnv = bodyEnv.param(p, "unknown", arg.pos).env;
    out.set(arg, lowerValue(arg.body, childEnv(bodyEnv, arg, "body")));
  }
  return out;
}

/** The count rule a `lower` verdict's cell states, or undefined. */
function ruleArgsOf(verdict: ReturnType<typeof consult>): { emptyList?: true } | undefined {
  if (verdict.kind !== "lower") return undefined;
  const cell = verdict.cell as { args?: { emptyList?: true } } | null;
  return cell !== null && typeof cell === "object" ? cell.args : undefined;
}

/** HR2: an operator the registry does not know passes through as written. */
function unknownOperator(node: Extract<Expr, { type: "OperatorCall" }>, args: readonly Expr[], env: Env): unknown {
  const inner = childEnv(env, node, "args");
  if (args.length === 0) return { [node.name]: {} };
  if (args.length === 1) return { [node.name]: lowerValue(args[0], inner) };
  return { [node.name]: args.map((a) => lowerValue(a, inner)) };
}

// ── operators ────────────────────────────────────────────────────────────────

/** A production as the developer wrote it: the operator token, never the registry key. */
const spelledProduction = (node: Expr, key: string): string =>
  node.type === "BinaryExpr" || node.type === "UnaryExpr" ? node.op : node.type === "TernaryExpr" ? "?:" : key;

/** A production's own renderer, run over `operands`. */
function production(node: Expr, key: string, operands: readonly Expr[], env: Env): unknown {
  const sel = select(consult(key, positionIn(env)), { kind: "none" }, { kind: "multiple" }, operands.length);
  const spelled = spelledProduction(node, key);
  if (sel.kind !== "rule") {
    if (sel.kind === "dispatch") internalError(`production '${key}' selected a receiver dispatch`);
    throw E.refusalFor(sel, `'${spelled}'`, "", positionIn(env), node.pos, []);
  }
  checkSlots(spelled, sel.rule.args, operands);
  return sel.rule.emit(exprInputs(key, null, operands, [], env, node, READ));
}

/** Every operand of a left-nested chain of `op`, outermost-left first. */
function chainOf(node: Expr, op: string): Expr[] {
  const out: Expr[] = [];
  const walk = (e: Expr) => {
    if (e.type === "BinaryExpr" && e.op === op) {
      walk(e.left);
      out.push(e.right);
    } else out.push(e);
  };
  walk(node);
  return out;
}

function unary(node: Extract<Expr, { type: "UnaryExpr" }>, env: Env): unknown {
  // `!!x` is `Boolean(x)`: the truth of x, as a value.
  if (node.op === "!" && node.argument.type === "UnaryExpr" && node.argument.op === "!") {
    return asValue(lowerTruth(node.argument.argument, childEnv(env, node, "argument")));
  }
  const key = productionForOperator("UnaryExpr", node.op);
  if (key === undefined) internalError(`no production builds a unary '${node.op}'`);
  return production(node, key, [node.argument], env);
}

function binary(node: Extract<Expr, { type: "BinaryExpr" }>, env: Env): unknown {
  const inner = childEnv(env, node, "left");
  switch (node.op) {
    case "+": {
      const operands = chainOf(node, "+");
      if (operands.some((e) => kindOf(e, inner) === "string")) {
        return {
          $concat: operands.map((e) =>
            chainHasOptional(e) ? { $ifNull: [lowerValue(e, inner), ""] } : lowerValue(e, inner),
          ),
        };
      }
      return { $add: operands.map((e) => lowerValue(e, inner)) };
    }
    case "&&":
    case "||":
      return logicalValue(node, env);
    case "==":
    case "!=": {
      const leftNull = node.left.type === "NullLiteral";
      if (!leftNull && node.right.type !== "NullLiteral") throw E.looseEqualityNotNull(node.op, node.pos);
      const operand = lowerValue(leftNull ? node.right : node.left, inner);
      const test = { $in: [{ $type: operand }, ["null", "missing"]] };
      return node.op === "==" ? test : { $not: [test] };
    }
    case "in":
      return membership(node, inner);
    case "===":
    case "!==": {
      // `x === undefined` is a PRESENCE test: `$type` answers "missing" for an absent field
      // and "null" for a present null, the same line `$exists` draws in a query.
      const operand = orientUndefined(node.left, node.right);
      if (operand !== null)
        return { [node.op === "!==" ? "$ne" : "$eq"]: [{ $type: lowerValue(operand, inner) }, "missing"] };
      const typed = typeofComparison(node, inner);
      if (typed !== null) return typed;
      break;
    }
  }
  const key = productionForOperator("BinaryExpr", node.op);
  if (key === undefined) internalError(`no production builds a binary '${node.op}'`);
  return production(node, key, flattensChain(key) ? chainOf(node, node.op) : [node.left, node.right], env);
}

/** `typeof x === "t"`, either way round, through the predicate vocabulary's alias table. */
function typeofComparison(node: Extract<Expr, { type: "BinaryExpr" }>, env: Env): unknown | null {
  const { left, right } = node;
  const pick = (a: Expr, b: Expr) =>
    a.type === "UnaryExpr" && a.op === "typeof" && b.type === "StringLiteral"
      ? { operand: a.argument, alias: b.value }
      : null;
  const o = pick(left, right) ?? pick(right, left);
  if (o === null) return null;
  const alias = typeAliasOf(o.alias);
  // A name MongoDB does not know would lower to a test that quietly matches nothing.
  if (alias === null) throw E.notAMongoType(o.alias, BSON_TYPE_ALIASES, right.pos);
  const negated = node.op === "!==";
  const actual = { $type: lowerValue(o.operand, env) };
  // The expression `$type` answers a CONCRETE type: an umbrella alias is a membership test.
  const group = TYPE_GROUPS[alias];
  if (group !== undefined) {
    const member = { $in: [actual, group] };
    return negated ? { $not: [member] } : member;
  }
  return { [negated ? "$ne" : "$eq"]: [actual, alias] };
}

/** `x === undefined` either way round: the operand tested for presence, or null when neither side is `undefined`. */
function orientUndefined(left: Expr, right: Expr): Expr | null {
  if (left.type === "UndefinedLiteral") return right.type === "UndefinedLiteral" ? null : right;
  return right.type === "UndefinedLiteral" ? left : null;
}

/**
 * `a && b` / `a || b` as a VALUE keeps JavaScript's operand-preserving rule:
 * `$cond` on the truth of the left, returning the operand. An all-boolean
 * chain is a boolean either way and keeps the flat `$and` / `$or`. A left
 * side that is not a plain reference is bound once, so it is not evaluated twice.
 */
function logicalValue(node: Extract<Expr, { type: "BinaryExpr" }>, env: Env): unknown {
  const op = node.op as "&&" | "||";
  const inner = childEnv(env, node, "left");
  const chain = chainOf(node, op);
  if (chain.every((e) => kindOf(e, inner) === "bool")) return asValue(lowerTruth(node, env));
  const fold = (rest: readonly Expr[], e: Env): unknown => {
    if (rest.length === 1) return lowerValue(rest[0], e);
    const lhs = rest[0];
    const lowered = lowerValue(lhs, e);
    const rhs = fold(rest.slice(1), e);
    const isBool = kindOf(lhs, e) === "bool";
    if (pathOf(lhs, e) !== null || isBool) {
      const test = truthOf(lowered, isBool);
      return op === "&&" ? cond(test, rhs, lowered) : cond(test, lowered, rhs);
    }
    const bound = e.fresh("v");
    const test = jsTruthy(bound.ref);
    return letOne(bound.as, lowered, op === "&&" ? cond(test, rhs, bound.ref) : cond(test, bound.ref, rhs));
  };
  return fold(chain, inner);
}

/** `x in [...]` is membership; `k in { … }` is key presence, with the keys read off the literal. */
function membership(node: Extract<Expr, { type: "BinaryExpr" }>, env: Env): unknown {
  const { left, right } = node;
  if (
    right.type === "StringLiteral" ||
    right.type === "NumberLiteral" ||
    right.type === "BooleanLiteral" ||
    right.type === "NullLiteral"
  ) {
    throw E.scalarInOperand(node.pos);
  }
  if (right.type === "ObjectLiteral") {
    const entries = right.entries;
    if (entries.every((e) => e.type === "KeyValueEntry" && e.key.kind === "static")) {
      return { $in: [lowerValue(left, env), entries.map((e) => staticKey(e))] };
    }
    const operands: unknown[] = [];
    let group: unknown[] = [];
    const flush = () => {
      if (group.length > 0) operands.push(group);
      group = [];
    };
    for (const e of entries) {
      if (e.type === "SpreadElement") {
        flush();
        const kv = env.fresh("kv");
        operands.push({
          $map: { input: { $objectToArray: lowerValue(e.argument, env) }, as: kv.as, in: `${kv.ref}.k` },
        });
      } else group.push(e.key.kind === "static" ? e.key.name : lowerValue(e.key.expr, env));
    }
    flush();
    return { $in: [lowerValue(left, env), operands.length === 1 ? operands[0] : { $concatArrays: operands }] };
  }
  return { $in: [lowerValue(left, env), lowerValue(right, env)] };
}

// ── blocks ───────────────────────────────────────────────────────────────────

/** `{ const y = …; return … }`: one `$let` per declaration the fold could not inline, innermost last. */
function exprBlock(node: Extract<Expr, { type: "ExprBlock" }>, env: Env, ret: (e: Expr, env: Env) => unknown): unknown {
  const seen = new Set<string>();
  const step = (i: number, e: Env): unknown => {
    if (i === node.decls.length) return ret(node.ret, childEnv(e, node, "ret"));
    const d = node.decls[i];
    if (seen.has(d.name)) throw E.redeclared(d.kind, d.name, d.pos);
    seen.add(d.name);
    const value = lowerValue(d.value, childEnv(e, node, "decls"));
    const bound = e.param(d.name, kindOf(d.value, e), d.pos);
    return letOne(bound.as as MongoVar, value, step(i + 1, bound.env));
  };
  return step(0, env);
}

/** The callback parameter kinds a row states, for a caller binding them. Unused parameters bind as "unknown". */
export { callbackParamsOf };
