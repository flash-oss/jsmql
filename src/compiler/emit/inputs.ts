import { bsonConstant, bsonNullary, regexValue } from "../../bson.ts";
import { constantOf, settled } from "../passes/evaluate.ts";
import type { Expr, ExprIn, FilterIn, QueryDoc, Stage, StageIn, Truth, Type } from "../../registry/vocabulary.ts";
import { queryOrMissing, queryOwnValue } from "../../registry/vocabulary.ts";
import type { Pipeline } from "../../registry/ast.ts";
import { orderBySpec, sortSpecOf, streamSortAsk, type SortAsk } from "./sort-spec.ts";
import { constantIn, literalIn, pathOfIn } from "./filter.ts";
import { internalError } from "../../errors.ts";
import {
  badMatchesPropertyPair,
  blockWhereValueExpected,
  CodegenError,
  emptyMatcherObject,
  indexNotHeld,
  pluralNounOfKinds,
  mapMustReturnDocument,
  nounOfKinds,
  needsPipeline,
  notAnArrowCallback,
  objIterateeShape,
  tooManyCallbackParams,
  notAFieldOfTheDocument,
  notAnArrow,
  nullCallback,
  unfilledParam,
  valueWhereBlockExpected,
  reducerShape,
  elementsShape,
  needsFieldPath,
  needsLiteral,
  elementNeedsQuery,
  needsPrecedingSort,
  streamHandleAfterReplace,
  unreadableField,
} from "./errors.ts";
import { preservesCountOf, slotFormsOf } from "../rows.ts";
import { chainHasOptional, isPresent, kindOf, typeOf } from "./prove.ts";
import { ANY, DOCUMENT, cannotBe, flattenOnce, isNothing, isOnly, maybeAbsent, of, unreadableAt } from "./type.ts";
import type { Chain, Env } from "./env.ts";
import { reduceVar } from "./names.ts";
import { truthOf } from "./mode.ts";
import { indexedPairs, mongoRegexOptions, sizeOf } from "../../registry/mql.ts";
import { edge } from "../passes/position.ts";

function readableSort<A extends SortAsk>(ask: A, t: Type, holder: string, pos: number): A {
  if (ask.kind !== "keys") return ask;
  for (const key of Object.keys(ask.spec)) {
    const bad = unreadableAt(t, key, true);
    if (bad === null) continue;
    const segments = key.split(".");
    const prefix = segments.slice(0, bad.index).join(".");
    throw unreadableField(segments[bad.index], bad.why, key, prefix === "" ? holder : `'${prefix}'`, pos);
  }
  return ask;
}

export type Reader = { value: (node: Expr, env: Env) => unknown; truth: (node: Expr, env: Env) => Truth };

export const childEnv = (env: Env, node: object, key: string): Env => {
  const at = env.at(edge(node, key, env.site.where));
  const n = node as { type?: string; name?: string };
  if (n.type === "OperatorCall" && key === "args") return at.inside(n.name ?? null);
  if (n.type === "ObjectLiteral" || n.type === "KeyValueEntry" || n.type === "ArrayLiteral") return at;
  return at.inside(null);
};

export function checkIndexHeld(node: Extract<Expr, { type: "IndexAccess" }>, elements: readonly Type[]): void {
  if (node.iteratee === undefined) return;
  const { method, slot } = node.iteratee;
  const i = (node.index as { value: number }).value;
  for (const element of elements) {
    if (cannotBe(element, "array") && cannotBe(element, "object") && !isNothing(element)) {
      throw indexNotHeld(method, slot, `the elements are ${pluralNounOfKinds(element)}`, node.pos);
    }
    if (isOnly(element, "array") && element.items !== undefined && element.items.length <= i) {
      const n = element.items.length;
      throw indexNotHeld(method, slot, `an element holds ${n} item${n === 1 ? "" : "s"}`, node.pos);
    }
  }
}

const elementsOf = (recv: Type): readonly Type[] => recv.items ?? [flattenOnce(recv)];

function callback(
  cb: Expr,
  env: Env,
  read: (body: Expr, e: Env) => unknown,
  refusal: () => CodegenError,
  receiver: () => Type,
): { as: string; ref: string; in: unknown } {
  if (cb.type !== "Lambda" || cb.body === undefined) throw refusal();
  if (cb.params.length !== 1) {
    internalError(`a renderer asked for a one-parameter callback, and the arrow has ${cb.params.length} parameters`);
  }
  if (cb.body.type === "IndexAccess" && cb.body.iteratee !== undefined) checkIndexHeld(cb.body, elementsOf(receiver()));
  const bound = env.param(cb.params[0], ANY, cb.pos);
  return { as: bound.as, ref: bound.ref, in: read(cb.body, childEnv(bound.env, cb, "body")) };
}

function readsParam(node: unknown, name: string): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => readsParam(n, name));
  const n = node as { type?: string; name?: string } & Record<string, unknown>;
  if (n.type === "Ident" && n.name === name) return true;
  return Object.entries(n).some(([k, v]) => k !== "type" && readsParam(v, name));
}

function arrayCallback(
  cb: Expr,
  recv: unknown,
  recvNode: Expr | undefined,
  env: Env,
  read: (body: Expr, e: Env) => unknown,
  name: string,
  present = false,
): { input: unknown; as: string; ref: string; paired: boolean; in: unknown } {
  if (cb.type !== "Lambda" || cb.body === undefined) throw notAnArrowCallback(name, (cb as { pos: number }).pos);
  if (cb.params.length > 3) throw tooManyCallbackParams(name, cb.params.length, cb.pos);
  const [elem, index, arr] = cb.params;
  const recvType = recvNode === undefined ? ANY : typeOf(recvNode, env);
  const element = flattenOnce(recvType);
  if (cb.body.type === "IndexAccess" && cb.body.iteratee !== undefined) checkIndexHeld(cb.body, elementsOf(recvType));
  const usesIndex = index !== undefined && readsParam(cb.body, index);
  if (!usesIndex) {
    const bound = elem === undefined ? env.fresh("unused") : env.param(elem, element, cb.pos);
    let bodyEnv = bound.env;
    const vars: Record<string, unknown> = {};
    if (arr !== undefined) {
      const a = bodyEnv.param(arr, of("array", !present), cb.pos);
      vars[a.as] = recv;
      bodyEnv = a.env;
    }
    const body = read(cb.body, childEnv(bodyEnv, cb, "body"));
    return {
      input: recv,
      as: bound.as,
      ref: bound.ref,
      paired: false,
      in: arr === undefined ? body : { $let: { vars, in: body } },
    };
  }
  const pair = env.fresh("pair");
  let bodyEnv = pair.env;
  const vars: Record<string, unknown> = {};
  const x = bodyEnv.param(elem, element, cb.pos);
  vars[x.as] = { $arrayElemAt: [pair.ref, 1] };
  bodyEnv = x.env;
  const i = bodyEnv.param(index, of("number", true), cb.pos);
  vars[i.as] = { $arrayElemAt: [pair.ref, 0] };
  bodyEnv = i.env;
  if (arr !== undefined) {
    const a = bodyEnv.param(arr, of("array", true), cb.pos);
    vars[a.as] = recv;
    bodyEnv = a.env;
  }
  const size = sizeOf(recv);
  return {
    input: { $zip: { inputs: [{ $range: [0, size] }, recv] } },
    as: pair.as,
    ref: pair.ref,
    paired: true,
    in: { $let: { vars, in: read(cb.body, childEnv(bodyEnv, cb, "body")) } },
  };
}

function callsSomething(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(callsSomething);
  const n = node as { type?: string } & Record<string, unknown>;
  if (n.type === "MethodCall" || n.type === "CallExpression" || n.type === "NewExpression" || n.type === "OperatorCall")
    return true;
  return Object.entries(n).some(([k, v]) => k !== "type" && callsSomething(v));
}

function reducerCallback(
  cb: Expr,
  seed: Expr,
  recv: unknown,
  env: Env,
  read: (body: Expr, e: Env) => unknown,
  name: string,
): { input: unknown; in: unknown } {
  if (cb.type !== "Lambda" || cb.body === undefined || cb.params.length < 2 || cb.params.length > 3) {
    throw reducerShape(name, (cb as { pos: number }).pos);
  }
  const [acc, elem, index] = cb.params;
  const accType = maybeAbsent(typeOf(seed, env));
  const direct = !callsSomething(cb.body);
  const vars: Record<string, unknown> = {};
  let bodyEnv = env;
  if (direct) {
    bodyEnv = bodyEnv.bind(acc, {
      ref: { kind: "var", ref: reduceVar("value") },
      type: accType,
      mutable: false,
      pos: cb.pos,
    });
  } else {
    const a = bodyEnv.param(acc, accType, cb.pos);
    vars[a.as] = reduceVar("value");
    bodyEnv = a.env;
  }
  if (index === undefined) {
    if (direct) {
      bodyEnv = bodyEnv.bind(elem, {
        ref: { kind: "var", ref: reduceVar("this") },
        type: ANY,
        mutable: false,
        pos: cb.pos,
      });
      return { input: recv, in: read(cb.body, childEnv(bodyEnv, cb, "body")) };
    }
    const x = bodyEnv.param(elem, ANY, cb.pos);
    vars[x.as] = reduceVar("this");
    bodyEnv = x.env;
    return { input: recv, in: { $let: { vars, in: read(cb.body, childEnv(bodyEnv, cb, "body")) } } };
  }
  const x = bodyEnv.param(elem, ANY, cb.pos);
  vars[x.as] = { $arrayElemAt: [reduceVar("this"), 1] };
  bodyEnv = x.env;
  const i = bodyEnv.param(index, of("number", true), cb.pos);
  vars[i.as] = { $arrayElemAt: [reduceVar("this"), 0] };
  bodyEnv = i.env;
  return { input: indexedPairs(recv), in: { $let: { vars, in: read(cb.body, childEnv(bodyEnv, cb, "body")) } } };
}

function elementsCallback(
  cb: Expr,
  count: number,
  env: Env,
  read: (body: Expr, e: Env) => unknown,
  name: string,
): { as: string; ref: string; in: unknown } {
  if (cb.type !== "Lambda" || cb.body === undefined || cb.params.length !== count) {
    throw elementsShape(name, count, (cb as { pos: number }).pos);
  }
  const pair = env.fresh("pair");
  let bodyEnv = pair.env;
  const vars: Record<string, unknown> = {};
  cb.params.forEach((p, k) => {
    const b = bodyEnv.param(p, ANY, cb.pos);
    vars[b.as] = { $arrayElemAt: [pair.ref, k] };
    bodyEnv = b.env;
  });
  return { as: pair.as, ref: pair.ref, in: { $let: { vars, in: read(cb.body, childEnv(bodyEnv, cb, "body")) } } };
}

export function exprInputs(
  name: string,
  recv: unknown,
  args: readonly Expr[],
  keys: readonly string[],
  env: Env,
  node: object,
  read: Reader,
  overrides: ReadonlyMap<Expr, unknown> = new Map(),
  recvNode?: Expr,
  present = false,
): ExprIn {
  const argEnv = childEnv(env, node, "args");
  const value = (e: Expr): unknown =>
    overrides.has(e) ? overrides.get(e) : read.value(env.site.settling ? e : settled(e), argEnv);
  const recvType = (): Type => (recvNode === undefined ? ANY : typeOf(recvNode, env));
  const elementOfRecv = (): Type => flattenOnce(recvType());
  const notArrow = (cb: Expr, what: string): CodegenError => {
    const slot = Math.max(0, args.indexOf(cb));
    return notAnArrow(name, what, slotFormsOf(name, "array", slot), cb, slot);
  };
  const refuseNull = (cb: Expr): void => {
    if (cb.type === "NullLiteral") throw nullCallback(name, Math.max(0, args.indexOf(cb)), "a callback", cb.pos);
  };
  return {
    name,
    recv,
    args,
    keys,
    value,
    wholeDocument: () => env.chain.wholeDocument(),
    present,
    kind: (e) => kindOf(e, argEnv),
    type: (e) => typeOf(e, argEnv),
    truth: (e) => read.truth(e, argEnv),
    elementTruth: (ref) => truthOf(ref, elementOfRecv()),
    iteratee: (cb) => callback(cb, argEnv, read.value, () => notArrow(cb, "a key"), recvType),
    predicate: (cb) =>
      callback(cb, argEnv, read.truth, () => notArrow(cb, "a predicate"), recvType) as {
        as: string;
        ref: string;
        in: Truth;
      },
    callback: (cb, mode) => {
      refuseNull(cb);
      return arrayCallback(cb, recv, recvNode, argEnv, mode === "value" ? read.value : read.truth, name, present);
    },
    reducer: (cb, seed) => {
      refuseNull(cb);
      return reducerCallback(cb, seed, recv, argEnv, read.value, name);
    },
    elements: (cb, count) => {
      refuseNull(cb);
      return elementsCallback(cb, count, argEnv, read.value, name);
    },
    sortSpec: (e, objects) =>
      readableSort(
        sortSpecOf(e, name, (x) => typeOf(x, argEnv), objects),
        elementOfRecv(),
        "the element",
        e.pos,
      ),
    orderBy: (keys, orders) =>
      readableSort(
        orderBySpec(keys, orders, name, (x) => typeOf(x, argEnv)),
        elementOfRecv(),
        "the element",
        keys.pos,
      ),
    objIteratee: (cb, mode) => {
      refuseNull(cb);
      if (cb.type !== "Lambda" || cb.body === undefined || cb.params.length < 1 || cb.params.length > 2) {
        throw objIterateeShape(name, (cb as { pos: number }).pos);
      }
      const kv = env.fresh("kv");
      let bodyEnv = kv.env;
      const vars: Record<string, unknown> = {};
      const v = bodyEnv.param(cb.params[0], ANY, cb.pos);
      vars[v.as] = `${kv.ref}.v`;
      bodyEnv = v.env;
      if (cb.params.length === 2) {
        const k = bodyEnv.param(cb.params[1], of("string", true), cb.pos);
        vars[k.as] = `${kv.ref}.k`;
        bodyEnv = k.env;
      }
      return {
        as: kv.as,
        ref: kv.ref,
        body: {
          $let: { vars, in: (mode === "value" ? read.value : read.truth)(cb.body, childEnv(bodyEnv, cb, "body")) },
        },
      };
    },
    bind: (hint) => {
      const b = env.fresh(hint);
      return { as: b.as, ref: b.ref };
    },
    hoist: (stages: readonly Stage[], reads: string) => {
      const source = (node as { object?: Expr }).object ?? null;
      const handle = streamHandleOf(source, env);
      const chain = handle === null ? env.rootChain : handle.chain;
      const level = handle === null ? 0 : handle.level;
      if (!chain.isPipeline) throw needsPipeline(name, (node as { pos: number }).pos);
      chain.hoist(stages, reads);
      return env.render(
        { kind: "s", level, path: reads, hint: reads.slice(reads.lastIndexOf(".") + 1) },
        (node as { pos: number }).pos,
      );
    },
    slot: () => env.chain.slot().path,
    construct: (spelling, refusal, arg) => {
      const given = arg === undefined ? null : constantOf(arg);
      const built =
        arg === undefined
          ? bsonNullary(spelling)
          : given !== null && given.ok
            ? bsonConstant(spelling, given.value)
            : null;
      if (built === null) throw new CodegenError(refusal, (node as { pos: number }).pos);
      return built;
    },
  };
}

function staleCountStage(cb: Expr): string | null {
  const stmts = (cb as { stages?: { stmts?: readonly { type: string; name?: string }[] } }).stages?.stmts;
  if (stmts === undefined) return null;
  for (const st of stmts) {
    if (st.type !== "OperatorCall" || typeof st.name !== "string") continue;
    if (!preservesCountOf(st.name)) return st.name;
  }
  return null;
}

function streamHandleOf(recv: Expr | null, env: Env): { chain: Chain; level: number } | null {
  if (recv === null || recv.type !== "Ident" || !env.scope.has(recv.name)) return null;
  const b = env.lookup(recv.name, recv.pos);
  return b.ref.kind === "streamHandle" ? { chain: b.ref.chain, level: b.level } : null;
}

export function onOwnStream(recv: Expr | null, env: Env): boolean {
  return (
    recv !== null &&
    recv.type === "Ident" &&
    env.scope.has(recv.name) &&
    env.lookup(recv.name, recv.pos).ref.kind === "streamHandle"
  );
}

export type QueryReader = {
  lowerValue: (node: Expr, env: Env) => unknown;
  lowerFilter: (node: Expr, env: Env) => QueryDoc;
  lowerNativeFilter: (node: Expr, env: Env) => QueryDoc | null;
};

export function filterInputs(
  name: string,
  recv: Expr | null,
  args: readonly Expr[],
  keys: readonly string[],
  env: Env,
  node: object,
  read: QueryReader,
): FilterIn {
  const argEnv = childEnv(env, node, "args");
  return {
    name,
    recv,
    args,
    keys,
    pathOf: (e) => pathOfIn(e, env),
    constant: constantIn,
    query: (e) => read.lowerFilter(e, argEnv),
    nativeQuery: (e) => read.lowerNativeFilter(e, argEnv),
    elementQuery: (cb) => {
      if (cb.type !== "Lambda" || cb.body === undefined || cb.params.length !== 1) return null;
      const bodyEnv = argEnv
        .element(cb.params[0])
        .bind(cb.params[0], { ref: { kind: "document", path: "" }, type: ANY, mutable: false, pos: cb.pos });
      return read.lowerNativeFilter(cb.body, childEnv(bodyEnv, cb, "body"));
    },
    value: (e) => read.lowerValue(e, argEnv),
    fieldPath: (e) => {
      const path = pathOfIn(e, env);
      if (path === null) throw needsFieldPath(name, (e as { pos: number }).pos);
      return path;
    },
    literal: (e) => {
      if (e.type === "RegexLiteral") return regexValue(e.pattern, mongoRegexOptions(e.flags));
      const c = literalIn(e);
      if (c === null) throw needsLiteral(name, (e as { pos: number }).pos);
      return c.value;
    },
    literalOf: literalIn,
    element: (cb) => {
      if (cb.type !== "Lambda" || cb.body === undefined || cb.params.length !== 1) {
        throw elementNeedsQuery(name, (cb as { pos: number }).pos);
      }
      const bodyEnv = argEnv
        .element(cb.params[0])
        .bind(cb.params[0], { ref: { kind: "document", path: "" }, type: ANY, mutable: false, pos: cb.pos });
      const q = read.lowerNativeFilter(cb.body, childEnv(bodyEnv, cb, "body"));
      if (q === null) throw elementNeedsQuery(name, cb.pos);
      return q;
    },
    orMissing: (path, test) => {
      const optionalCall = (node as { optional?: boolean }).optional === true;
      if (optionalCall || recv === null || isPresent(recv, env.at({ at: "value" }))) return queryOwnValue(path, test);
      return chainHasOptional(recv) ? null : queryOrMissing(path, test);
    },
  };
}

export type StageReader = {
  value: (node: Expr, env: Env) => unknown;
  truth: (node: Expr, env: Env) => Truth;
  predicate: (body: Expr, env: Env) => QueryDoc;
  reshape: (body: Expr, env: Env) => unknown;
  block: (stages: Pipeline, env: Env) => Stage[];
};

export function stageInputs(
  name: string,
  args: readonly Expr[],
  keys: readonly string[],
  env: Env,
  node: object,
  read: StageReader,
  soFar: readonly Stage[] = [],
  written: string = name,
): StageIn & { keys: readonly string[] } {
  const argEnv = childEnv(env, node, "args");
  const before: readonly Stage[] = [...env.chain.emitted, ...soFar];
  const readableKeys = <A extends SortAsk>(ask: A, pos: number): A =>
    readableSort(
      ask,
      env.typeAt(env.chain.element),
      env.chain.element === "" ? "the document" : `'$.${env.chain.element}'`,
      pos,
    );
  const bound = (cb: Expr): Env | null => {
    if (cb.type !== "Lambda" || cb.params.length > 3) return null;
    let e = argEnv;
    if (cb.params.length >= 1) {
      e = e.bind(cb.params[0], {
        ref: { kind: "document", path: env.chain.element },
        type: env.typeAt(env.chain.element),
        mutable: false,
        pos: cb.pos,
      });
    }
    if (cb.params.length >= 2) {
      e = e.bind(cb.params[1], {
        ref: {
          kind: "dropped",
          message: unfilledParam(cb.params[1], name, "a stream has no per-document index; leave the parameter unused."),
          replaced: false,
        },
        type: ANY,
        mutable: false,
        pos: cb.pos,
      });
    }
    if (cb.params.length === 3) {
      const replaces = staleCountStage(cb);
      e = e.bind(cb.params[2], {
        ref:
          replaces === null
            ? { kind: "streamHandle", source: cb, chain: e.chain }
            : {
                kind: "dropped",
                message: streamHandleAfterReplace(cb.params[2], replaces, cb.pos).message,
                replaced: false,
              },
        type: of("stream", true),
        mutable: false,
        pos: cb.pos,
      });
    }
    return e;
  };
  const callbackRefusal = (cb: Expr, what: string): CodegenError => {
    if (cb.type === "Lambda") return tooManyCallbackParams(written, cb.params.length, cb.pos);
    const forms = slotFormsOf(written, "stream", args.indexOf(cb));
    if (cb.type === "ObjectLiteral" && forms.includes("matchesObject")) {
      const entries = (cb as { entries?: readonly unknown[] }).entries;
      if (entries !== undefined && entries.length === 0) return emptyMatcherObject(written, cb.pos);
    }
    if (cb.type === "ArrayLiteral" && forms.includes("matchesPropertyPair")) {
      return badMatchesPropertyPair(written, cb.pos);
    }
    return notAnArrow(written, what, forms, cb, Math.max(0, args.indexOf(cb)));
  };
  const body = (cb: Expr, what: string): { body: Expr; env: Env } => {
    const e = bound(cb);
    if (e === null) throw callbackRefusal(cb, what);
    const b = (cb as { body?: Expr }).body;
    if (b === undefined) throw blockWhereValueExpected(written, cb.pos);
    return { body: b, env: childEnv(e, cb, "body") };
  };
  return {
    name,
    args,
    keys,
    value: (e) => read.value(env.site.settling ? e : settled(e), argEnv),
    truth: (e) => read.truth(e, argEnv),
    predicate: (cb) => {
      const b = body(cb, "a predicate");
      return read.predicate(b.body, b.env);
    },
    reshape: (cb) => {
      const b = body(cb, "a key");
      return read.reshape(b.body, b.env);
    },
    condition: (cb) => {
      const b = body(cb, "a predicate");
      return read.truth(b.body, b.env);
    },
    sortedBy: () => {
      for (let k = before.length - 1; k >= 0; k--) {
        const spec = (before[k] as Record<string, unknown>).$sort;
        if (spec !== undefined) return spec as Record<string, unknown>;
      }
      throw needsPrecedingSort(name, (node as { pos: number }).pos);
    },
    document: (cb) => {
      const b = body(cb, "a document");
      const t = typeOf(b.body, b.env);
      if (cannotBe(t, "object")) throw mapMustReturnDocument(name, nounOfKinds(t), b.body.pos);
      return read.reshape(b.body, b.env);
    },
    fieldPath: (cb) => {
      const b = body(cb, "a field");
      const v = read.reshape(b.body, b.env);
      if (typeof v !== "string" || !v.startsWith("$") || v.startsWith("$$")) throw notAFieldOfTheDocument(name, cb.pos);
      return v;
    },
    block: (cb) => {
      const e = bound(cb);
      if (e === null) {
        throw cb.type === "Lambda"
          ? tooManyCallbackParams(written, cb.params.length, cb.pos)
          : valueWhereBlockExpected(written, cb.pos);
      }
      const stages = (cb as { stages?: Pipeline }).stages;
      if (stages === undefined) throw valueWhereBlockExpected(written, cb.pos);
      return read.block(stages, e);
    },
    sortSpec: (e, objects = true) =>
      streamSortAsk(
        readableKeys(
          sortSpecOf(e, name, (x) => typeOf(x, argEnv), objects),
          e.pos,
        ),
        name,
        env.chain.element,
        e.pos,
      ),
    orderBy: (keys, orders) =>
      streamSortAsk(
        readableKeys(
          orderBySpec(keys, orders, name, (x) => typeOf(x, argEnv)),
          keys.pos,
        ),
        name,
        env.chain.element,
        keys.pos,
      ),
    slot: () => env.chain.slot().path,
    bind: (hint) => {
      const b = env.fresh(hint);
      return { as: b.as, ref: b.ref };
    },
    element: () => {
      const path = env.chain.element;
      return { path, ref: path === "" ? "$$ROOT" : "$" + path };
    },
    wholeDocument: () => env.chain.wholeDocument(),
    unwound: (path) => {
      env.chain.element = path;
    },
  };
}
