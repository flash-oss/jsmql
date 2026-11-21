import type { Expr, FieldFamily, Position, Truth, Type } from "../../registry/vocabulary.ts";
import type { ArrayElement, ObjectEntry, CallArg } from "../../registry/ast.ts";
import { internalError } from "../../errors.ts";
import { bigIntToLong, isPlainObject, ObjectId, regexValue } from "../../bson.ts";
import { isNotNullish, isNullish, mongoRegexOptions, propertyKeyExpr, setKey } from "../../registry/mql.ts";
import { BSON_TYPE_ALIASES, typeAliasOf } from "../../registry/vocabulary.ts";
import { chainBase, namedRow, staticKey } from "../passes/naming.ts";
import { constantOf, provideLowering } from "../passes/evaluate.ts";
import {
  bindsOf,
  callbackParamsOf,
  flattensChain,
  isCallable,
  isGlobalName,
  namespaceNames,
  positionalKeysOf,
  productionForNode,
  productionForOperator,
  rowForNodeType,
  elementsOf,
  soleFieldFamilyOf,
  hasStreamValueCell,
  emptyValueOf,
  bareCallableNames,
  constructibleNames,
  positionsOf,
  readsNullAsEmptyOf,
  lowersOn,
  productionPassesNullOf,
  passesNullOf,
  takesNoReceiver,
} from "../rows.ts";
import { consult, everyMethodName, everyName, familiesFor, refusalSentence } from "./consult.ts";
import { checkBodyKeys, checkSlots, type SlotProof } from "./check.ts";
import { neverNullAlwaysOf, operandShapeOf, productionBuilding, productionSpelling, returnsOf } from "../rows.ts";
import { Env } from "./env.ts";
import * as E from "./errors.ts";
import { readsAnotherCollection } from "./join.ts";
import { onOwnStream, checkIndexHeld, childEnv, exprInputs, type Reader } from "./inputs.ts";
import { and, asValue, boolTruth, not, or, truthOf } from "./mode.ts";
import { cond, letOne, readsRef, switchOn } from "./mql.ts";
import { positionOf } from "./consult.ts";
import { select, shapeOf, UNPROVEN, type Receiver, type Selected } from "./select.ts";
import { chainHasOptional, familyOfKind, isPresent, kindOf, proofsFor, sourceFamily, typeOf } from "./prove.ts";
import { ANY, cannotBe, isNothing, isOnly, kindsOf, maybeAbsent, unreadable, unreadableAt } from "./type.ts";
import { mongoVarName, type Located, type MongoVar } from "./names.ts";
import { injectedPlacement } from "./env.ts";
import { isMqlShaped } from "../passes/inject.ts";

const NAMESPACES = namespaceNames();
const READ: Reader = { value: lowerValue, truth: lowerTruth };

const positionIn = (env: Env): Position => positionOf(env.site.where) ?? "value";

const NOT_EXPR: ReadonlySet<Exclude<CallArg | ArrayElement, Expr>["type"]> = new Set([
  "SpreadElement",
  "FuncDecl",
  "AssignExpr",
  "DeleteStmt",
  "UpdateFilter",
] as const);
const isExpr = (a: CallArg | ArrayElement): a is Expr => !(NOT_EXPR as ReadonlySet<string>).has(a.type);

let joinRoad: ((node: Expr, env: Env) => unknown) | null = null;
export function provideJoin(road: (node: Expr, env: Env) => unknown): void {
  joinRoad = road;
}

export function lowerValue(node: Expr, env: Env): unknown {
  if (
    (node.type === "MethodCall" || node.type === "MemberAccess" || node.type === "IndexAccess") &&
    readsAnotherCollection(node)
  ) {
    if (joinRoad === null) internalError("statement.ts did not lend the join road before lower.ts read it");
    return joinRoad(node, env);
  }
  const stopped = stoppedChain(node);
  if (stopped !== null && !isPresent(withoutOptional(stopped), env)) {
    const base = withoutOptional(stopped);
    const named = base.type === "Ident" && env.scope.has(base.name);
    const proved = base.type === "FieldRef" ? env.proving(base.path) : named ? env.provingName(base.name) : env;
    if ((base.type === "FieldRef" || named) && passesNullAfter(node)) return lowerValue(withoutOptional(node), proved);
    const gone = boolTruth(isNullish(lowerValue(base, env)));
    return cond(gone, null, lowerValue(withoutOptional(node), proved));
  }
  if (isRead(node) && readsHaveOptional(node)) return ifNull(lowerValue(withoutReadOptional(node), env), null);
  switch (node.type) {
    case "StringLiteral":
      if (node.text === true) return textValue(node.value, node.pos, env);
      return node.value;
    case "NumberLiteral":
    case "BooleanLiteral":
      return node.value;
    case "NullLiteral":
      return null;
    case "BigIntLiteral": {
      const long = bigIntToLong(BigInt(node.value));
      if (long === null) throw E.bigIntTooLarge(node.value, node.pos);
      return long;
    }
    case "UndefinedLiteral":
      throw E.undefinedAsValue(node.pos);
    case "RegexLiteral":
      if (node.injected !== undefined) return node.injected;
      if (env.site.inside !== null) return regexValue(node.pattern, mongoRegexOptions(node.flags));
      throw E.regexAsValue(node.pos);
    case "ObjectIdLiteral":
      return new ObjectId(node.hex);
    case "TemplateLiteral":
      return templateLiteral(node, env);
    case "ArrayLiteral":
      return arrayLiteral(node, node.elements, env);
    case "ObjectLiteral":
      return objectLiteral(node, node.entries, env);
    case "Injected":
      return injectedValue(node, env);
    case "FieldRef": {
      readablePath(node, env);
      const read = env.value(locate(node, env) as Located, node.pos);
      const path = typeof read === "string" ? reachable(read) : read;
      return node.optional === true ? { $ifNull: [path, null] } : path;
    }
    case "StreamRef":
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

export function lowerTruth(node: Expr, env: Env): Truth {
  if (node.type === "BinaryExpr" && (node.op === "&&" || node.op === "||")) {
    const operands = chainOf(node, node.op).map((e) => lowerTruth(e, childEnv(env, node, "left")));
    return node.op === "&&" ? and(...operands) : or(...operands);
  }
  if (node.type === "UnaryExpr" && node.op === "!") {
    const inner = node.argument;
    if (inner.type === "UnaryExpr" && inner.op === "!")
      return lowerTruth(inner.argument, childEnv(env, inner, "argument"));
    return not(lowerTruth(inner, childEnv(env, node, "argument")));
  }
  if (node.type === "TernaryExpr") {
    const test = lowerTruth(node.test, childEnv(env, node, "test"));
    return boolTruth(cond(test, lowerTruth(node.consequent, env), lowerTruth(node.alternate, env)));
  }
  if (node.type === "ExprBlock") return boolTruth(exprBlock(node, env, (ret, e) => lowerTruth(ret, e)));
  return truthOf(lowerValue(nullPassing(node), env), typeOf(node, env));
}

function templateLiteral(node: Extract<Expr, { type: "TemplateLiteral" }>, env: Env): unknown {
  if (node.exprs.length === 0) return node.quasis[0] ?? "";
  const inner = childEnv(env, node, "exprs");
  if (node.exprs.length === 1 && node.quasis.every((q) => q === "")) {
    const e = node.exprs[0];
    const lowered = lowerValue(e, inner);
    const safe = chainHasOptional(e) ? ifNull(lowered, "") : lowered;
    return kindOf(e, inner) === "string" && (chainHasOptional(e) || isPresent(e, inner)) ? safe : { $toString: safe };
  }
  const parts: unknown[] = [];
  node.exprs.forEach((e, i) => {
    if (node.quasis[i] !== "") parts.push(node.quasis[i]);
    const lowered = lowerValue(e, inner);
    const safe = chainHasOptional(e) ? ifNull(lowered, "") : lowered;
    parts.push(kindOf(e, inner) === "string" ? safe : { $toString: safe });
  });
  const tail = node.quasis[node.exprs.length];
  if (tail !== "" && tail !== undefined) parts.push(tail);
  return { $concat: parts };
}

function ifNull(v: unknown, neutral: unknown): unknown {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const keys = Object.keys(v);
    const inner = (v as { $ifNull?: unknown }).$ifNull;
    if (keys.length === 1 && Array.isArray(inner) && inner.length === 2 && inner[1] === null) {
      return { $ifNull: [inner[0], neutral] };
    }
  }
  return { $ifNull: [v, neutral] };
}

function stoppedChain(node: Expr): Expr | null {
  let cursor: Expr = node;
  let called = false;
  while (cursor.type === "MemberAccess" || cursor.type === "IndexAccess" || cursor.type === "MethodCall") {
    if (!isRead(cursor)) called = true;
    if (cursor.optional) return called ? cursor.object : null;
    cursor = cursor.object;
  }
  if (cursor.type !== "FieldRef" || cursor.optional !== true || !called) return null;
  return cursor.optionalAt === undefined ? cursor : { type: "FieldRef", path: cursor.optionalAt, pos: cursor.pos };
}

function passesNullAfter(node: Expr): boolean {
  let cursor: Expr = node;
  while (cursor.type === "MethodCall") {
    if (!passesNullOf(cursor.name)) return false;
    if (cursor.optional) return true;
    cursor = cursor.object;
  }
  return cursor.type === "FieldRef" && cursor.optional === true && cursor.optionalAt === undefined && cursor !== node;
}

function nullPassing(e: Expr): Expr {
  return readsHaveOptional(e) ? withoutReadOptional(e) : e;
}

function isRead(e: Expr): e is Extract<Expr, { type: "MemberAccess" | "IndexAccess" }> {
  return e.type === "IndexAccess" || (e.type === "MemberAccess" && !isPropertyRow(e));
}

function readsHaveOptional(e: Expr): boolean {
  let cursor = e;
  while (isRead(cursor)) {
    if (cursor.optional) return true;
    cursor = cursor.object;
  }
  return cursor.type === "FieldRef" && cursor.optional === true;
}

function withoutReadOptional(e: Expr): Expr {
  if (isRead(e)) return { ...e, optional: false, object: withoutReadOptional(e.object) };
  if (e.type === "FieldRef" && e.optional === true) {
    const { optional: _dropped, optionalAt: _at, ...rest } = e;
    return rest;
  }
  return e;
}

function withoutOptional(e: Expr): Expr {
  if (e.type === "MemberAccess" || e.type === "IndexAccess" || e.type === "MethodCall") {
    return { ...e, optional: false, object: withoutOptional(e.object) };
  }
  if (e.type === "FieldRef" && e.optional === true) {
    const { optional: _dropped, optionalAt: _at, ...rest } = e;
    return rest;
  }
  return e;
}

function arrayLiteral(node: Expr, elements: readonly ArrayElement[], env: Env): unknown {
  const inner = childEnv(env, node, "elements");
  for (const el of elements) {
    if (el.type === "AssignExpr" || el.type === "UpdateFilter" || el.type === "DeleteStmt" || el.type === "FuncDecl")
      internalError(`a '${el.type}' reached a value array`, el.pos);
  }
  if (!elements.some((el) => el.type === "SpreadElement"))
    return elements.filter(isExpr).map((el) => lowerValue(el, inner));
  const operands: unknown[] = [];
  let group: unknown[] = [];
  const flush = () => {
    if (group.length > 0) operands.push(group);
    group = [];
  };
  for (const el of elements) {
    if (el.type === "SpreadElement") {
      flush();
      const t = typeOf(el.argument, inner);
      if (isOnly(t, "string")) throw E.spreadOfString(el.argument.pos);
      if (cannotBe(t, "array")) throw E.spreadNotAnArray(E.nounOfKinds(t), el.argument.pos);
      const packed = (node as { packed?: boolean }).packed === true;
      const v = lowerValue(el.argument, inner);
      operands.push(t.absent && !packed ? ifNull(v, []) : v);
    } else if (isExpr(el)) group.push(lowerValue(el, inner));
  }
  flush();
  return operands.length === 1 ? operands[0] : { $concatArrays: operands };
}

function injectedValue(node: Extract<Expr, { type: "Injected" }>, env: Env): unknown {
  if (!isMqlShaped(node.value)) return node.value;
  switch (injectedPlacement(env.site)) {
    case "literal":
      return { $literal: node.value };
    case "asWritten":
      return node.value;
    case "refused":
      throw E.runTimeValueAsMql(node.value, env.site.where, node.pos);
  }
}

function textValue(value: string, pos: number, env: Env): unknown {
  switch (injectedPlacement(env.site)) {
    case "literal":
      return { $literal: value };
    case "asWritten":
      return value;
    case "refused":
      throw E.runTimeValueAsMql(value, env.site.where, pos, "A string that JSMQL reads as text is never MQL.");
  }
}

function propertyKey(key: Expr, env: Env): unknown {
  const c = constantOf(key);
  if (c.ok && (typeof c.value === "number" || typeof c.value === "boolean")) return String(c.value);
  const k = lowerValue(key, env);
  if (kindOf(key, env) !== "string") return propertyKeyExpr(k);
  return isPresent(key, env) ? k : { $ifNull: [k, ""] };
}

function objectLiteral(node: Expr, entries: readonly ObjectEntry[], env: Env): unknown {
  const inner = childEnv(env, node, "entries");
  const staticEntries = (list: readonly ObjectEntry[]): unknown => {
    if (list.some((e) => e.type === "KeyValueEntry" && e.key.kind === "computed")) {
      const pairs = list.map((e) => {
        if (e.type !== "KeyValueEntry") internalError("a spread reached the computed-key path");
        const k = e.key.kind === "static" ? e.key.name : propertyKey(e.key.expr, inner);
        return { k, v: lowerValue(e.value, childEnv(inner, e, "value")) };
      });
      return { $arrayToObject: [pairs] };
    }
    const out: Record<string, unknown> = {};
    for (const e of list) {
      if (e.type !== "KeyValueEntry" || e.key.kind !== "static")
        internalError("a non-static entry reached the static path");
      if (e.key.name.startsWith("$") && positionIn(inner) === "updateDoc") {
        const doc = lowerValue({ type: "OperatorCall", name: e.key.name, args: [e.value], pos: e.pos }, inner);
        if (doc !== null && typeof doc === "object") Object.assign(out, doc as Record<string, unknown>);
        continue;
      }
      const at = childEnv(inner, e, "value");
      setKey(out, e.key.name, lowerValue(e.value, e.key.name.startsWith("$") ? at.inside(e.key.name) : at));
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
      const t = typeOf(e.argument, inner);
      if (isOnly(t, "string")) throw E.spreadOfString(e.argument.pos);
      if (cannotBe(t, "object")) throw E.spreadNotADocument(E.nounOfKinds(t), e.argument.pos);
      operands.push(lowerValue(e.argument, inner));
    } else group.push(e);
  }
  flush();
  return operands.length === 1 ? operands[0] : { $mergeObjects: operands };
}

function rootAsValue(node: Expr, env: Env): never {
  const name = rowForNodeType(node.type);
  if (name === undefined) internalError(`no root row builds a '${node.type}'`);
  const sel = select(consult(name, positionIn(env)), { kind: "none" }, { kind: "none" }, 0, UNPROVEN);
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
        return env.value(locate(node, env) as Located, node.pos);
      case "constant":
        return b.ref.value;
      case "function":
        throw E.functionAsValue(node.name, node.pos);
      case "streamHandle":
        throw E.streamHandleAsValue(node.name, node.pos);
      case "dropped":
        throw E.droppedBinding(b.ref, node.pos);
    }
  }
  if (NAMESPACES.has(node.name)) {
    const verdict = consult(node.name, positionIn(env));
    if (verdict.kind === "refused") throw new E.CodegenError(refusalSentence(verdict, `'${node.name}'`, ""), node.pos);
  }
  if (isGlobalName(node.name)) {
    const verdict = consult(node.name, positionIn(env));
    if (verdict.kind === "refused") throw new E.CodegenError(refusalSentence(verdict, `'${node.name}'`, ""), node.pos);
    throw E.callableAsValue(node.name, node.pos);
  }
  throw new E.UnknownIdentifierError(node.name, node.pos);
}

export function locate(node: Expr, env: Env): Located | null {
  if (node.type === "FieldRef") {
    return { kind: "f", level: 0, path: node.path, hint: node.path === "" ? "root" : lastSegment(node.path) };
  }
  if (node.type === "Ident" && env.scope.has(node.name)) {
    const b = env.lookup(node.name, node.pos);
    if (b.ref.kind === "var") return { kind: "var", level: b.level, ref: b.ref.ref, hint: node.name };
    if (b.ref.kind === "document") return { kind: "f", level: b.level, path: b.ref.path, hint: node.name };
    if (b.ref.kind === "field") return { kind: "v", level: b.level, path: b.ref.slot.path, hint: node.name };
    return null;
  }
  if (node.type === "IndexAccess" && node.index.type === "StringLiteral") {
    const base = locate(node.object, env);
    if (base === null || base.kind === "var" || base.path !== "") return null;
    const name = node.index.value;
    if (name.startsWith("$")) return null;
    return { ...base, path: base.path === "" ? name : `${base.path}.${name}`, hint: name };
  }
  if (node.type === "MemberAccess" && !isPropertyRow(node)) {
    const base = locate(node.object, env);
    if (base === null) return null;
    if (base.kind === "var") return { ...base, ref: `${base.ref}.${node.name}` };
    return { ...base, path: base.path === "" ? node.name : `${base.path}.${node.name}`, hint: node.name };
  }
  return null;
}

const lastSegment = (path: string): string => path.slice(path.lastIndexOf(".") + 1);

function pathOf(node: Expr, env: Env): unknown {
  const loc = locate(node, env);
  return loc === null ? null : reachable(env.render(loc, node.pos));
}

function reachable(path: string): unknown {
  const root = path.startsWith("$$") ? 2 : 1;
  const segments = path.slice(root).split(".");
  const at = segments.findIndex((s, i) => i > 0 && s.startsWith("$"));
  if (at < 0) return path;
  let value: unknown = path.slice(0, root) + segments.slice(0, at).join(".");
  for (const seg of segments.slice(at)) {
    value = { $getField: { field: seg.startsWith("$") ? { $literal: seg } : seg, input: value } };
  }
  return value;
}

function isPropertyRow(node: Extract<Expr, { type: "MemberAccess" }>): boolean {
  return sourceFamily(node.object) !== null || !isCallable(node.name);
}

export function readablePath(node: Extract<Expr, { type: "FieldRef" }>, env: Env, throughArrays = false): void {
  if (node.path === "") return;
  const bad = unreadableAt(env.typeAt("", 0), node.path, throughArrays);
  if (bad === null) return;
  const holder = bad.index === 0 ? "the document" : `'${spelledPath(node, bad.index)}'`;
  throw E.unreadableField(node.path.split(".")[bad.index], bad.why, spelledPath(node, bad.index + 1), holder, node.pos);
}

function spelledPath(node: Extract<Expr, { type: "FieldRef" }>, count: number): string {
  const segments = node.path.split(".").slice(0, count);
  const tested = node.optional !== true ? count : node.optionalAt === undefined ? 0 : node.optionalAt.split(".").length;
  if (tested >= segments.length) return `$.${segments.join(".")}`;
  const tail = segments.slice(tested).join(".");
  return tested === 0 ? `$?.${tail}` : `$.${segments.slice(0, tested).join(".")}?.${tail}`;
}

function spelledRead(e: Expr): string | null {
  if (e.type === "FieldRef") return e.path === "" ? "$" : spelledPath(e, e.path.split(".").length);
  if (e.type === "Ident") return e.minted === true ? null : e.name;
  if (e.type !== "MemberAccess" && e.type !== "IndexAccess") return null;
  const object = spelledRead(e.object);
  if (object === null) return null;
  if (e.type === "MemberAccess") return `${object}${e.optional ? "?." : "."}${e.name}`;
  if (e.index.type !== "NumberLiteral" && e.index.type !== "StringLiteral") return null;
  return `${object}${e.optional ? "?." : ""}[${JSON.stringify(e.index.value)}]`;
}

export function holderOf(e: Expr, env: Env): string | null {
  if (e.type === "FieldRef" && e.path === "") return "the document";
  if (e.type === "Ident" && e.minted === true && env.scope.has(e.name)) {
    const ref = env.lookup(e.name, e.pos).ref;
    if (ref.kind !== "document") return "the element";
    return ref.path === "" ? "the document" : `'$.${ref.path}'`;
  }
  const spelled = spelledRead(e);
  return spelled === null ? null : `'${spelled}'`;
}

function memberAccess(node: Extract<Expr, { type: "MemberAccess" }>, env: Env): unknown {
  if (node.object.type === "Ident" && namespaceNames().has(node.object.name) && isCallable(node.name)) {
    if (!lowersOn(node.name, node.object.name)) {
      return lowerValue(
        { type: "MethodCall", object: node.object, name: node.name, args: [], optional: false, pos: node.pos },
        env,
      );
    }
    throw E.unappliedReference(node.object.name, node.name, node.pos);
  }
  if (isPropertyRow(node)) return dispatchOn(node, node.name, node.object, [], env);
  refuseUnreadable(node, env);
  const path = pathOf(node, env);
  if (path !== null) return path;
  const names = [node.name];
  let base = node.object;
  let baseEnv = childEnv(env, node, "object");
  while (base.type === "MemberAccess" && !isPropertyRow(base) && pathOf(base, env) === null) {
    refuseUnreadable(base, env);
    names.unshift(base.name);
    baseEnv = childEnv(baseEnv, base, "object");
    base = base.object;
  }
  const bound = env.fresh("v");
  return letOne(bound.as, lowerValue(base, baseEnv), `${bound.ref}.${names.join(".")}`);
}

function refuseUnreadable(node: Extract<Expr, { type: "MemberAccess" }>, env: Env): void {
  const why = unreadable(typeOf(node.object, childEnv(env, node, "object")), node.name, false);
  if (why === null) return;
  const read = `${node.optional ? "?." : "."}${node.name}`;
  throw E.unreadableField(node.name, why, read, holderOf(node.object, env), node.pos);
}

function indexAccess(node: Extract<Expr, { type: "IndexAccess" }>, env: Env): unknown {
  const objEnv = childEnv(env, node, "object");
  checkOperandKinds(node, productionBuilding("IndexAccess"), [node.index], childEnv(env, node, "index"), ["key"]);
  if (node.iteratee !== undefined) checkIndexHeld(node, [typeOf(node.object, objEnv)]);
  if (node.index.type === "StringLiteral") {
    const name = node.index.value;
    const why = unreadable(typeOf(node.object, objEnv), name, false);
    if (why !== null) {
      throw E.unreadableField(name, why, `[${JSON.stringify(name)}]`, holderOf(node.object, env), node.pos);
    }
  }
  {
    const loc = locate(node, env);
    if (loc !== null) return env.render(loc, node.pos);
  }
  const raw = lowerValue(node.object, objEnv);
  const idx = lowerValue(node.index, childEnv(env, node, "index"));
  const known =
    node.object.type === "FieldRef" && node.object.path === "" ? "object" : familyOfKind(kindOf(node.object, objEnv));
  const absent = !isPresent(node.object, objEnv);
  const orEmpty = (neutral: unknown) => (absent ? ifNull(raw, neutral) : raw);
  const named = isPresent(node.index, env) ? idx : { $ifNull: [idx, ""] };
  const keyKind = kindOf(node.index, env);
  if (keyKind === "string") return { $getField: { field: named, input: orEmpty({}) } };
  const isString = (o: unknown) => boolTruth({ $eq: [{ $type: o }, "string"] });
  const literal = constantOf(node.index);
  if (literal.ok && typeof literal.value === "number" && Number.isInteger(literal.value)) {
    const i = literal.value;
    if (i < 0) throw E.negativeIndex(i, node.pos);
    const charAt = { $substrCP: [raw, i, 1] };
    const fieldAt = { $getField: { field: String(i), input: orEmpty({}) } };
    if (known === "array") return { $arrayElemAt: [orEmpty([]), i] };
    if (known === "object") return fieldAt;
    if (known === "string") return absent ? switchOn([{ case: isString(raw), then: charAt }], "$$REMOVE") : charAt;
    return switchOn(
      [
        { case: boolTruth({ $isArray: raw }), then: { $arrayElemAt: [raw, i] } },
        { case: isString(raw), then: charAt },
      ],
      fieldAt,
    );
  }
  const fieldAt = { $getField: { field: { $toString: named }, input: orEmpty({}) } };
  if (known === "object") return fieldAt;
  const element = { $arrayElemAt: [orEmpty([]), idx] };
  if (known === "array") {
    return keyKind === "number"
      ? element
      : switchOn([{ case: boolTruth({ $isNumber: idx }), then: element }], "$$REMOVE");
  }
  const onArray = keyKind === "number" ? { $isArray: raw } : { $and: [{ $isArray: raw }, { $isNumber: idx }] };
  return switchOn([{ case: boolTruth(onArray), then: { $arrayElemAt: [raw, idx] } }], fieldAt);
}

function receiverOf(recv: Expr, env: Env): Receiver {
  const src = sourceFamily(recv);
  if (src !== null && NAMESPACES.has(src))
    return { kind: "namespace", name: src as Receiver extends { name: infer N } ? N : never };
  if (recv.type === "StreamRef" || onOwnStream(recv, env)) return { kind: "stream" };
  if (src === "regexp") return { kind: "value", family: "regexp", lowered: recv };
  const lowered = lowerValue(recv, env);
  const t = typeOf(recv, env);
  const kinds = kindsOf(t);
  if (kinds === null) return { kind: "opaque", lowered };
  if (kinds.length === 1) {
    const family = familyOfKind(kinds[0]);
    if (family !== null) return { kind: "value", family, lowered };
    return { kind: "opaque", lowered, proved: kinds[0] };
  }
  const possible = kinds.map(familyOfKind).filter((f): f is FieldFamily => f !== null);
  if (possible.length === 0) return { kind: "opaque", lowered, proved: kinds.join(" or ") };
  return { kind: "opaque", lowered, possible };
}

const spelledMethod = (name: string, recv: Expr): string =>
  recv.type === "Ident" && NAMESPACES.has(recv.name) ? `${recv.name}.${name}` : `.${name}`;

const wroteName = (node: Expr, name: string): string =>
  node.type === "MethodCall" && node.wrote !== undefined ? node.wrote : name;

const JS_NAMES = everyName().filter((n) => !n.startsWith("$"));
const METHOD_NAMES = everyMethodName();

function methodCall(node: Extract<Expr, { type: "MethodCall" }>, env: Env): unknown {
  return dispatchOn(node, node.name, node.object, node.args, env);
}

function dispatchOn(node: Expr, name: string, recvNode: Expr, args: readonly CallArg[], env: Env): unknown {
  const position = positionIn(env);
  const recvEnv = childEnv(env, node, "object");
  const chainOnStream =
    recvNode.type === "MethodCall" && (chainBase(recvNode) as { type?: string }).type === "StreamRef";
  const inAValue = position !== "stream" && position !== "statement";
  if (chainOnStream && inAValue) throw E.streamAsValue(node.pos);
  if (isNothing(typeOf(recvNode, recvEnv))) {
    const call = node.type === "MethodCall" ? `.${wroteName(node, name)}()` : `.${name}`;
    throw E.alwaysAbsent(call, holderOf(recvNode, recvEnv), node.pos);
  }
  const receiver = receiverOf(recvNode, recvEnv);
  if (node.type === "MethodCall" && receiver.kind === "stream" && inAValue && !hasStreamValueCell(name)) {
    throw E.streamAsValue(node.pos);
  }
  if (node.type === "MethodCall" && receiver.kind !== "stream" && takesNoReceiver(name)) {
    throw E.noReceiver(name, node.pos);
  }
  const exprArgs = args.filter(isExpr);
  const argEnv = childEnv(env, node, "args");
  const proofs = proofsFor(args, argEnv, true, { node: recvNode, env: recvEnv });
  const sel = select(consult(name, position), receiver, shapeOf(args as readonly Expr[]), args.length, proofs);
  const spelled = spelledMethod(wroteName(node, name), recvNode);
  const container =
    receiver.kind === "stream" ? "'$$'" : receiver.kind === "namespace" ? `'${receiver.name}'` : "this receiver";
  const recv = receiver.kind === "value" || receiver.kind === "opaque" ? receiver.lowered : null;
  if (sel.kind === "rule") {
    if (elementsOf(name) === "scalar") {
      const holder = arraysHolder(recvNode);
      if (holder !== null) throw E.arrayOfArrays(name, holder, node.pos);
    }
    checkSlots(
      name,
      sel.rule.args,
      exprArgs,
      true,
      recvNode,
      env.site.settling,
      slotProof(childEnv(env, node, "args")),
    );
    const proven = isPresent(recvNode, recvEnv);
    const family = receiver.kind === "value" ? receiver.family : (sel.family ?? soleFieldFamilyOf(name));
    const empty = emptyValueOf(name, family);
    const inExpression = position === "value" || position === "filter";
    const needsEmpty =
      inExpression && !proven && empty !== null && (receiver.kind === "value" || receiver.kind === "opaque");
    const nullIsEmpty = needsEmpty && readsNullAsEmptyOf(name);
    const wrap = needsEmpty && !nullIsEmpty;
    const input = wrap ? ifNull(recv, empty) : recv;
    return sel.rule.emit(
      exprInputs(
        name,
        input,
        exprArgs,
        positionalKeysOf(name),
        env,
        node,
        READ,
        undefined,
        recvNode,
        proven || wrap || nullIsEmpty,
      ),
    );
  }
  const format = receiver.kind === "namespace" ? (c: string) => `${receiver.name}.${c}` : (c: string) => `.${c}()`;
  const near =
    receiver.kind === "namespace"
      ? JS_NAMES.filter((n) => {
          const on = familiesFor(n);
          return on !== undefined && on !== "any" && on.includes(receiver.name) && lowersOn(n, receiver.name);
        })
      : METHOD_NAMES;
  if (sel.kind === "wrongKind") operandsFirst(exprArgs, argEnv);
  throw E.refusalFor(sel, spelled, container, position, node.pos, near, format, {
    receiver: recvNode,
    args: args as readonly Expr[],
  });
}

function arraysHolder(recv: Expr): string | null {
  if (recv.type === "ArrayLiteral" && recv.elements.some((e) => e.type === "ArrayLiteral")) return "this array literal";
  if (recv.type === "MethodCall" && recv.name === "partition") return "'.partition(...)'";
  return null;
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
      if (b.ref.kind === "dropped") throw E.droppedBinding(b.ref, node.pos);
      throw E.notCallable(node.pos);
    }
    if (isGlobalName(callee.name)) return dispatchBare(node, callee.name, node.args, env);
    throw E.unknownFunction(callee.name, [...env.scope.functionNames(), ...bareCallableNames()], node.pos);
  }
  if (callee.type === "Lambda") return applyLambda(callee, node.args, env, node.pos, "IIFE", null);
  throw E.notCallable(node.pos);
}

function newExpression(node: Extract<Expr, { type: "NewExpression" }>, env: Env): unknown {
  const { callee } = node;
  if (callee.type !== "Ident") throw E.noNewKeyword(null, node.pos);
  const { name } = callee;
  if (env.scope.has(name)) {
    if (env.lookup(name, callee.pos).ref.kind === "function") throw E.noNewKeyword(name, node.pos);
    throw E.unknownClass(name, constructibleNames(), node.pos);
  }
  if (!isGlobalName(name)) throw E.unknownClass(name, constructibleNames(), node.pos);
  if ((positionsOf(name)?.length ?? 0) > 0) throw E.noNewKeyword(name, node.pos);
  return dispatchBare(node, name, node.args, env);
}

function dispatchBare(node: Expr, name: string, args: readonly CallArg[], env: Env): unknown {
  const position = positionIn(env);
  const exprArgs = args.filter(isExpr);
  const proofs = proofsFor(args, childEnv(env, node, "args"), true);
  const sel = select(consult(name, position), { kind: "none" }, shapeOf(args as readonly Expr[]), args.length, proofs);
  if (sel.kind === "rule") {
    const argEnv = childEnv(env, node, "args");
    checkSlots(`${name}()`, sel.rule.args, exprArgs, true, undefined, env.site.settling, slotProof(argEnv));
    return sel.rule.emit(exprInputs(name, null, exprArgs, [], env, node, READ));
  }
  const spelled = node.type === "NewExpression" ? `'new ${name}()'` : name;
  throw E.refusalFor(sel, spelled, "", position, node.pos, [], undefined, { args: args as readonly Expr[] });
}

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
    const bound = bodyEnv.param(lambda.params[i], maybeAbsent(typeOf(a, env)), lambda.pos);
    vars[bound.as] = lowerValue(a, env);
    bodyEnv = bound.env;
  });
  if (fnName !== null) {
    bodyEnv = bodyEnv.bind(fnName, {
      ref: { kind: "dropped", message: E.recursiveFunction(fnName, pos).message, replaced: false },
      type: ANY,
      mutable: false,
      pos,
    });
  }
  const body = lowerValue(lambda.body, childEnv(bodyEnv, lambda, "body"));
  return Object.keys(vars).length === 0 ? body : { $let: { vars, in: body } };
}

function operatorCall(node: Extract<Expr, { type: "OperatorCall" }>, env: Env): unknown {
  const position = positionIn(env);
  const verdict = consult(node.name, position);
  if (verdict.kind !== "lower" && verdict.kind !== "perFamily") return plainOperator(node, env);
  const shape = position === "updateDoc" ? undefined : operandShapeOf(node.name);
  const first = node.args[0];
  const lone = node.args.length === 1 && first.type === "ArrayLiteral" ? first : null;
  let args: readonly CallArg[] = node.args;
  let count = node.args.length;
  const overrides = new Map<Expr, unknown>();
  if (lone !== null && shape === "array") {
    if (lone.elements.some((el) => el.type === "SpreadElement")) return plainOperator(node, env);
    args = lone.elements.filter(isExpr);
    count = args.length;
  }
  const loneOperand = shape === "array" && node.args.length === 1 && first.type !== "SpreadElement" && lone === null;
  const exprArgs = args.filter(isExpr);
  const sel = select(verdict, { kind: "none" }, shapeOf(args as readonly Expr[]), count, UNPROVEN);
  if (sel.kind === "spreadRefused") throw E.refusalFor(sel, node.name, "", position, node.pos, []);
  if (sel.kind !== "rule") return plainOperator(node, env);
  if (exprArgs.length === 1 && positionalKeysOf(node.name).length > 0) checkBodyKeys(exprArgs[0]);
  for (const [k, v] of boundArrowOverrides(node, exprArgs, env)) overrides.set(k, v);
  const inputs = exprInputs(node.name, null, exprArgs, positionalKeysOf(node.name), env, node, READ, overrides);
  const out = sel.rule.emit(inputs);
  return loneOperand ? asWritten(node.name, out) : out;
}

function asWritten(name: string, out: unknown): unknown {
  if (out === null || typeof out !== "object" || Array.isArray(out)) return out;
  const keys = Object.keys(out);
  const list = (out as Record<string, unknown>)[name];
  return keys.length === 1 && keys[0] === name && Array.isArray(list) && list.length === 1 ? { [name]: list[0] } : out;
}

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
  const inner = childEnv(env, node, "args");
  const vars: Record<string, unknown> = {};
  for (const e of varsArg.entries) {
    if (e.type !== "KeyValueEntry" || e.key.kind !== "static") return out;
    vars[mongoVarName(e.key.name)] = lowerValue(e.value, inner);
  }
  out.set(varsArg, vars);
  for (const slot of binds.visibleIn) {
    const arg = args[keys.indexOf(slot)];
    if (arg === undefined || arg.type !== "Lambda" || arg.body === undefined) continue;
    if (!arg.params.every((p) => names.includes(p))) throw E.letParamsMustNameVars(arg.params, names, arg.pos);
    let bodyEnv = childEnv(env, node, "args");
    for (const p of arg.params) bodyEnv = bodyEnv.param(p, ANY, arg.pos).env;
    out.set(arg, lowerValue(arg.body, childEnv(bodyEnv, arg, "body")));
  }
  return out;
}

function plainOperator(node: Extract<Expr, { type: "OperatorCall" }>, env: Env): unknown {
  const spread = node.args.find((a) => a.type === "SpreadElement");
  if (spread !== undefined) {
    throw E.refusalFor(
      { kind: "spreadRefused", name: node.name, sig: "…" },
      node.name,
      "",
      positionIn(env),
      spread.pos,
      [],
    );
  }
  const args = node.args.filter(isExpr);
  const inner = childEnv(env, node, "args");
  if (args.length === 0) return { [node.name]: {} };
  if (args.length === 1) return { [node.name]: lowerValue(args[0], inner) };
  return { [node.name]: args.map((a) => lowerValue(a, inner)) };
}

const spelledProduction = (node: Expr, key: string): string =>
  node.type === "BinaryExpr" || node.type === "UnaryExpr"
    ? node.op
    : node.type === "TernaryExpr"
      ? "?:"
      : node.type === "IndexAccess"
        ? productionSpelling(key)
        : key;

function selectProduction(key: string, operands: readonly Expr[], env: Env): Selected {
  const last = operands[operands.length - 1];
  const proofs = proofsFor(operands, env, false, last === undefined ? null : { node: last, env });
  return select(consult(key, positionIn(env)), { kind: "none" }, { kind: "multiple" }, operands.length, proofs);
}

export const slotProof = (env: Env): SlotProof => ({
  isNull: (e) => isNothing(typeOf(e, env)),
  read: (e) => lowerValue(e, env),
});

export function operandsFirst(operands: readonly Expr[], env: Env): void {
  for (const e of operands) if (e.type !== "Lambda") lowerValue(e, env);
}

function checkOperandKinds(
  node: Expr,
  key: string,
  operands: readonly Expr[],
  env: Env,
  slots?: readonly string[],
): void {
  const sel = selectProduction(key, operands, env);
  if (sel.kind === "wrongKind") {
    operandsFirst(operands, env);
    throw E.refusalFor(sel, `'${spelledProduction(node, key)}'`, "", positionIn(env), node.pos, [], undefined, {
      args: operands,
      slots,
    });
  }
}

function production(node: Expr, key: string, operands: readonly Expr[], env: Env): unknown {
  const sel = selectProduction(key, operands, env);
  const spelled = spelledProduction(node, key);
  if (sel.kind !== "rule") {
    if (sel.kind === "wrongKind") operandsFirst(operands, env);
    throw E.refusalFor(sel, `'${spelled}'`, "", positionIn(env), node.pos, [], undefined, { args: operands });
  }
  checkSlots(spelled, sel.rule.args, operands, true, undefined, env.site.settling, slotProof(env));
  const read = productionPassesNullOf(key) ? operands.map(nullPassing) : operands;
  return sel.rule.emit(exprInputs(key, null, read, [], env, node, READ));
}

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

function booleanOf(truth: unknown, type: Type): unknown {
  if (typeof truth === "boolean") return truth;
  if (typeof truth === "number") return truth !== 0;
  if (type.kinds !== "any" && !type.absent && [...type.kinds].every((k) => k === "bool")) return truth;
  const keys = isPlainObject(truth) ? Object.keys(truth) : [];
  if (keys.length === 1 && returnsOf(keys[0]) === "bool" && neverNullAlwaysOf(keys[0])) return truth;
  return { $cond: [truth, true, false] };
}

function unary(node: Extract<Expr, { type: "UnaryExpr" }>, env: Env): unknown {
  if (node.op === "!" && node.argument.type === "UnaryExpr" && node.argument.op === "!") {
    const x = node.argument.argument;
    const xEnv = childEnv(env, node, "argument");
    return booleanOf(asValue(lowerTruth(x, xEnv)), typeOf(x, xEnv));
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
      checkOperandKinds(node, productionKeyOf(node), operands, inner);
      if (operands.some((e) => kindOf(e, inner) === "string")) {
        return {
          $concat: operands.map((e) => (chainHasOptional(e) ? ifNull(lowerValue(e, inner), "") : lowerValue(e, inner))),
        };
      }
      return { $add: operands.map((e) => lowerValue(productionPassesNullOf("addition") ? nullPassing(e) : e, inner)) };
    }
    case "&&":
    case "||":
      return logicalValue(node, env);
    case "==":
    case "!=": {
      const leftNull = node.left.type === "NullLiteral";
      if (!leftNull && node.right.type !== "NullLiteral") throw E.looseEqualityNotNull(node.op, node.pos);
      const operand = lowerValue(nullPassing(leftNull ? node.right : node.left), inner);
      return node.op === "==" ? isNullish(operand) : isNotNullish(operand);
    }
    case "in":
      return membership(node, inner);
    case "===":
    case "!==": {
      const operand = orientUndefined(node.left, node.right);
      if (operand !== null)
        return { [node.op === "!==" ? "$ne" : "$eq"]: [{ $type: lowerValue(operand, inner) }, "missing"] };
      const typed = typeofComparison(node, inner);
      if (typed !== null) return typed;
      break;
    }
  }
  const key = productionKeyOf(node);
  return production(node, key, flattensChain(key) ? chainOf(node, node.op) : [node.left, node.right], env);
}

function productionKeyOf(node: Extract<Expr, { type: "BinaryExpr" }>): string {
  const key = productionForOperator("BinaryExpr", node.op);
  if (key === undefined) internalError(`no production builds a binary '${node.op}'`);
  return key;
}

function typeofComparison(node: Extract<Expr, { type: "BinaryExpr" }>, env: Env): unknown | null {
  const { left, right } = node;
  const pick = (a: Expr, b: Expr) =>
    a.type === "UnaryExpr" && a.op === "typeof" ? { operand: a.argument, name: b } : null;
  const o = pick(left, right) ?? pick(right, left);
  if (o === null) return null;
  checkTypeNames(o.name);
  if (o.name.type !== "StringLiteral") return null;
  return { [node.op === "!==" ? "$ne" : "$eq"]: [{ $type: lowerValue(o.operand, env) }, o.name.value] };
}

function checkTypeNames(e: Expr): void {
  const check = (v: unknown, pos: number) => {
    if (typeof v === "string" && typeAliasOf(v) === null) throw E.notAMongoType(v, BSON_TYPE_ALIASES, pos);
  };
  if (e.type === "StringLiteral") check(e.value, e.pos);
  if (e.type === "ArrayLiteral") {
    for (const el of e.elements) if (el.type === "StringLiteral") check(el.value, el.pos);
  }
  if (e.type === "Injected") {
    for (const v of Array.isArray(e.value) ? e.value : [e.value]) check(v, e.pos);
  }
}

function orientUndefined(left: Expr, right: Expr): Expr | null {
  if (left.type === "UndefinedLiteral") return right.type === "UndefinedLiteral" ? null : right;
  return right.type === "UndefinedLiteral" ? left : null;
}

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
    const t = typeOf(lhs, e);
    if (pathOf(lhs, e) !== null || kindOf(lhs, e) === "bool") {
      const test = truthOf(lowered, t);
      return op === "&&" ? cond(test, rhs, lowered) : cond(test, lowered, rhs);
    }
    const bound = e.fresh("v");
    const test = truthOf(bound.ref, t);
    return letOne(bound.as, lowered, op === "&&" ? cond(test, rhs, bound.ref) : cond(test, bound.ref, rhs));
  };
  return fold(chain, inner);
}

function membership(node: Extract<Expr, { type: "BinaryExpr" }>, env: Env): unknown {
  const { left, right } = node;
  const passedList = right.type === "Injected" && !cannotBe(typeOf(right, env), "array");
  if (right.type !== "ArrayLiteral" && !passedList) throw E.inNeedsList(node.pos);
  checkOperandKinds(node, productionKeyOf(node), [left, right], env);
  if (left.type === "UnaryExpr" && left.op === "typeof") checkTypeNames(right);
  return { $in: [lowerValue(left, env), lowerValue(right, env)] };
}

function exprBlock(node: Extract<Expr, { type: "ExprBlock" }>, env: Env, ret: (e: Expr, env: Env) => unknown): unknown {
  const step = (i: number, e: Env, carried: { value: unknown } | null): unknown => {
    if (i === node.decls.length) return ret(node.ret, childEnv(e, node, "ret"));
    const vars: Record<string, unknown> = {};
    const refs: string[] = [];
    let scope = e;
    let j = i;
    let carry = carried;
    for (;;) {
      const d = node.decls[j];
      const value = carry !== null ? carry.value : lowerValue(d.value, childEnv(scope, node, "decls"));
      carry = null;
      if (j > i && refs.some((r) => readsRef(value, r))) return { $let: { vars, in: step(j, scope, { value }) } };
      const bound = scope.param(d.name, maybeAbsent(typeOf(d.value, scope)), d.pos);
      vars[bound.as as string] = value;
      refs.push(`$$${bound.as as string}`);
      scope = bound.env;
      j++;
      if (j === node.decls.length || node.decls[j].group !== d.group) break;
    }
    return { $let: { vars, in: step(j, scope, null) } };
  };
  return step(0, env, null);
}

export { callbackParamsOf };

provideLowering((node, functions) => {
  let env = Env.root({ node, functions: [...functions.values()] }, "value", undefined, true);
  for (const [name, lambda] of functions) {
    env = env.bind(name, {
      ref: { kind: "function", lambda, expanding: lambda.body === undefined },
      type: ANY,
      mutable: false,
      pos: lambda.pos,
    });
  }
  return lowerValue(node, env);
});
