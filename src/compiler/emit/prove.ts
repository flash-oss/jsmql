import type { Expr, Kind, Type } from "../../registry/vocabulary.ts";
import type { FieldFamily } from "../../registry/vocabulary.ts";
import type { CallArg } from "../../registry/ast.ts";
import { isFieldPathString } from "../../registry/ast.ts";
import type { Env } from "./env.ts";
import { namedRow } from "../passes/naming.ts";
import {
  callbackParamsOf,
  documentOf,
  familiesOf,
  isCallable,
  namespaceNames,
  neverNullAlwaysOf,
  neverNullOf,
  productionForOperator,
  returnsOf,
  soleFieldFamilyOf,
  emptyValueOf,
} from "../rows.ts";
import { bsonTagOf, BSON_KIND, isDate, isPlainObject, isRegExp } from "../../bson.ts";
import { FIELD_FAMILY_TYPES } from "../../registry/vocabulary.ts";
import { isMqlShaped } from "../passes/inject.ts";
import {
  ANY,
  DOCUMENT,
  NOTHING,
  anyItemOf,
  arrayOf,
  at,
  elementOf,
  evaluate,
  flattenOnce,
  isNothing,
  isOnly,
  itemOf,
  join,
  joinAll,
  maybeAbsent,
  objectOf,
  of,
  present,
  propOf,
  removed,
  single,
  tupleOf,
  written,
  elementProofOf,
  itemProofsOf,
  proofOf,
} from "./type.ts";
import type { Site } from "./type.ts";
import type { Proof, Proofs } from "../kinds.ts";
import { kindOfValue } from "../kinds.ts";
import { staticKey } from "../passes/naming.ts";

export type Known = Kind | "unknown";

const NAMESPACES = namespaceNames();

export const isPresent = (node: Expr, env: Env): boolean => !typeOf(node, env).absent;

function statedPresence(node: Expr, env: Env): boolean | null {
  switch (node.type) {
    case "NumberLiteral":
    case "BigIntLiteral":
    case "StringLiteral":
    case "TemplateLiteral":
    case "BooleanLiteral":
    case "ObjectIdLiteral":
    case "RegexLiteral":
    case "ArrayLiteral":
      return true;
    case "ObjectLiteral":
      return namedRow(node) === null;
    case "Injected":
      return node.value !== null && node.value !== undefined && !isMqlShaped(node.value);
    case "MethodCall": {
      const name = namedRow(node) ?? node.name;
      if (!neverNullOf(name)) return false;
      const family = receiverFamilyOf(node.object, env) ?? soleFieldFamilyOf(name);
      const wrapped = !spineHasOptional(node) && emptyValueOf(name, family) !== null;
      const receiver =
        node.object.type === "Ident" && !env.scope.has(node.object.name) && NAMESPACES.has(node.object.name)
          ? true
          : wrapped || isPresent(node.object, env);
      return receiver && argsThere(name, node.args, env);
    }
    case "OperatorCall":
      return (
        neverNullOf(node.name) &&
        (neverNullAlwaysOf(node.name) ||
          node.args.every((a) => !(a.type === "ObjectLiteral" && namedRow(a) === null) && argPresent(a, env)))
      );
    case "CallExpression":
      if (node.callee.type === "Ident" && !env.scope.has(node.callee.name)) {
        return neverNullOf(node.callee.name) && argsThere(node.callee.name, node.args, env);
      }
      return null;
    case "NewExpression":
      return node.callee.type === "Ident" && !env.scope.has(node.callee.name)
        ? neverNullOf(node.callee.name) && argsThere(node.callee.name, node.args, env)
        : false;
    case "UnaryExpr": {
      const key = productionForOperator("UnaryExpr", node.op);
      return key !== undefined && neverNullOf(key) && isPresent(node.argument, env);
    }
    case "BinaryExpr": {
      if (node.op === "&&" || node.op === "||" || node.op === "??") return null;
      const key = productionForOperator("BinaryExpr", node.op);
      return key !== undefined && neverNullOf(key) && isPresent(node.left, env) && isPresent(node.right, env);
    }
    case "MemberAccess":
      if (!isCallable(node.name) || sourceFamily(node.object) !== null) {
        return neverNullOf(node.name) && (sourceFamily(node.object) !== null || isPresent(node.object, env));
      }
      return null;
    case "FieldRef":
    case "Ident":
    case "StreamRef":
    case "IndexAccess":
    case "TernaryExpr":
    case "ExprBlock":
    case "NullLiteral":
    case "UndefinedLiteral":
      return null;
    default:
      return false;
  }
}

function spineHasOptional(e: Expr): boolean {
  let cursor: Expr = e;
  while (cursor.type === "MemberAccess" || cursor.type === "IndexAccess" || cursor.type === "MethodCall") {
    if (cursor.optional) return true;
    cursor = cursor.object;
  }
  return cursor.type === "FieldRef" && cursor.optional === true;
}

export function chainHasOptional(e: Expr): boolean {
  let cursor: Expr = e;
  while (cursor.type === "MemberAccess" || cursor.type === "IndexAccess") {
    if (cursor.optional) return true;
    cursor = cursor.object;
  }
  return cursor.type === "FieldRef" && cursor.optional === true;
}

function argsThere(name: string, args: readonly CallArg[], env: Env): boolean {
  return neverNullAlwaysOf(name) || args.every((a) => argPresent(a, env));
}

function argPresent(a: CallArg, env: Env): boolean {
  if (a.type === "SpreadElement") return isPresent(a.argument, env);
  if (a.type === "Lambda") return true;
  return isPresent(a, env);
}

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

export function sourceFamily(node: Expr): FieldFamily | "regexp" | string | null {
  if (node.type === "Ident" && NAMESPACES.has(node.name)) return node.name;
  if (node.type === "RegexLiteral") return "regexp";
  return null;
}

export const kindOf = (node: Expr, env: Env): Known => single(typeOf(node, env));

export const elementKindOf = (node: Expr, env: Env): Known => single(elementOf(typeOf(node, env)));

export function proofsFor(
  args: readonly CallArg[],
  env: Env,
  objectForm: boolean,
  source: { readonly node: Expr; readonly env: Env } | null = null,
  isField?: (a: Expr) => boolean,
): Proofs {
  const proven = (a: CallArg): Proof => {
    if (a.type === "SpreadElement" || (objectForm && a.type === "ObjectLiteral")) return "unknown";
    const t = typeOf(a, env);
    return isNothing(t) ? ["null"] : proofOf(t);
  };
  const sourceType = source === null ? null : typeOf(source.node, source.env);
  const elements = sourceType === null ? "unknown" : elementProofOf(sourceType);
  const items = sourceType === null ? undefined : itemProofsOf(sourceType);
  const list = args.length === 1 && args[0].type === "ArrayLiteral" && args[0].packed === true ? args[0] : null;
  if (list !== null) {
    const own = (e: CallArg): Proof =>
      e.type === "SpreadElement" ? elementProofOf(typeOf(e.argument, env)) : proven(e);
    const packedArgs = list.elements as readonly CallArg[];
    return {
      args: packedArgs.map(own),
      elements,
      ...(items === undefined ? {} : { items }),
      viaElements: packedArgs.map((e) => e.type === "SpreadElement"),
      packed: true,
    };
  }
  const plain = args.map(proven);
  const mayBeArray = (p: Proof): boolean => p !== "unknown" && p.includes("array");
  const via: boolean[] = [];
  const throughElements = (a: CallArg, i: number): Proof => {
    const p = plain[i];
    if (isField === undefined || a.type === "SpreadElement" || !isField(a) || p === "unknown" || !mayBeArray(p))
      return p;
    if (plain.some((other, j) => j !== i && mayBeArray(other))) return p;
    const held = elementProofOf(typeOf(a, env));
    if (held === "unknown") return "unknown";
    via[i] = p.every((k) => k === "array");
    return [...new Set([...p.filter((k) => k !== "array"), ...held])];
  };
  const proofs = args.map(throughElements);
  const tuple = items === undefined ? {} : { items };
  const asElement = args.map((a, i): Proof | undefined => {
    const p = plain[i];
    if (isField === undefined || a.type === "SpreadElement" || !isField(a) || p === "unknown") return undefined;
    if (!p.every((k) => k === "array")) return undefined;
    const held = elementProofOf(typeOf(a, env));
    if (held === "unknown") return "unknown";
    return elements !== "unknown" && elements.includes("array") ? [...new Set([...p, ...held])] : held;
  });
  const views = isField === undefined ? {} : { whole: plain, asElement };
  return via.some(Boolean)
    ? { args: proofs, elements, ...tuple, viaElements: proofs.map((_, i) => via[i] === true), ...views }
    : { args: proofs, elements, ...tuple, ...views };
}

export function receiverFamilyOf(node: Expr, env: Env): FieldFamily | "regexp" | string | null {
  const src = sourceFamily(node);
  if (src !== null) return src;
  if (node.type === "StreamRef") return "stream";
  return familyOfKind(kindOf(node, env));
}

function namesIn(arg: Expr | undefined): readonly string[] | null {
  if (arg === undefined) return null;
  if (arg.type === "StringLiteral") return [arg.value];
  if (arg.type !== "ArrayLiteral") return null;
  const out: string[] = [];
  for (const el of arg.elements) {
    if (el.type !== "StringLiteral") return null;
    out.push(el.value);
  }
  return out;
}

function siteOf(name: string, receiver: Type, family: string | null, args: readonly CallArg[], env: Env): Site {
  const arg = (n: number): Type => {
    const a = args[n];
    return a === undefined || a.type === "Lambda" || a.type === "SpreadElement" ? ANY : typeOf(a, env);
  };
  return {
    receiver,
    family: family as Site["family"],
    arg,
    argCount: args.length,
    callback: (n) => callbackAnswer(name, receiver, args, n, arg, env),
    names: namesIn(args[0] as Expr | undefined),
  };
}

function callbackAnswer(
  name: string,
  receiver: Type,
  args: readonly CallArg[],
  n: number,
  arg: (n: number) => Type,
  env: Env,
): Type {
  const cb = args[n];
  if (cb === undefined || cb.type !== "Lambda" || cb.body === undefined) return ANY;
  const kinds = callbackParamsOf(name, "value") ?? [];
  let bodyEnv = env;
  cb.params.forEach((p, i) => {
    const kind = kinds[i];
    const t =
      kind === "value"
        ? flattenOnce(receiver)
        : kind === "index"
          ? of("number")
          : kind === "key"
            ? of("string")
            : kind === "receiver"
              ? receiver
              : kind === "accumulator"
                ? arg(n + 1)
                : ANY;
    bodyEnv = bodyEnv.param(p, t, cb.pos).env;
  });
  return typeOf(cb.body, bodyEnv);
}

function callOn(name: string, receiver: Type, family: string | null, args: readonly CallArg[], env: Env): Type {
  return evaluate(returnsOf(name), siteOf(name, receiver, family, args, env));
}

function callOnUnproven(name: string, receiver: Type, args: readonly CallArg[], env: Env): Type {
  const r = returnsOf(name);
  const site = siteOf(name, receiver, null, args, env);
  if (typeof r === "string") return r === "same" || r === "element" ? ANY : evaluate(r, site);
  if (!isFamilyMap(r)) return evaluate(r, site);
  const sole = soleFieldFamilyOf(name);
  if (sole !== null) return evaluate(r, { ...site, receiver: of(sole as Kind), family: sole });
  const fams = familiesOf(name);
  if (fams === null) return ANY;
  const answers: Type[] = [];
  for (const f of fams) {
    if (f === "stream") continue;
    const term = (r as Record<string, unknown>)[f];
    if (term === undefined || term === "same" || term === "element" || term === "unknown") return ANY;
    answers.push(evaluate(term as Parameters<typeof evaluate>[0], site));
  }
  return answers.length === 0 ? ANY : joinAll(answers);
}

const TERMS = ["arrayOf", "elementOf", "callback", "arg", "args", "merge", "oneOf", "recordOf", "tuple", "itemOf"];
const isFamilyMap = (r: unknown): boolean => typeof r === "object" && r !== null && !TERMS.some((k) => k in r);

function injectedType(v: unknown): Type {
  const k = kindOfValue(v);
  return k === null ? ANY : of(k);
}

export function typeOf(node: Expr, env: Env): Type {
  const joined = env.chain.proofOf(node);
  if (joined !== undefined) return joined;
  const t = kindsOf(node, env);
  const stated = statedPresence(node, env);
  if (stated === null) return t;
  return stated ? present(t) : maybeAbsent(t);
}

function kindsOf(node: Expr, env: Env): Type {
  switch (node.type) {
    case "NumberLiteral":
    case "BigIntLiteral":
      return of("number");
    case "StringLiteral":
      return isFieldPathString(node) ? ANY : of("string");
    case "TemplateLiteral":
      return of("string");
    case "BooleanLiteral":
      return of("bool");
    case "ObjectIdLiteral":
      return of("objectId");
    case "NullLiteral":
    case "UndefinedLiteral":
      return NOTHING;
    case "Injected":
      return injectedType(node.value);
    case "ArrayLiteral": {
      const elements: Type[] = [];
      let spread = false;
      for (const el of node.elements) {
        if (el.type === "SpreadElement") spread = true;
        else elements.push(typeOf(el as Expr, env));
      }
      return spread ? arrayOf(ANY) : tupleOf(elements);
    }
    case "ObjectLiteral": {
      if (namedRow(node) !== null) return ANY;
      const props = new Map<string, Type>();
      let open = false;
      for (const entry of node.entries) {
        if (entry.type === "SpreadElement") {
          const spread = typeOf(entry.argument, env);
          if (spread.kinds === "any" || spread.open) {
            for (const [k, t] of props) props.set(k, join(t, spread.values ?? ANY));
            open = true;
          }
          for (const [k, t] of spread.props ?? []) props.set(k, spread.absent ? maybeAbsent(t) : t);
          continue;
        }
        const key = staticKey(entry);
        if (key === null) {
          open = true;
          continue;
        }
        props.set(key, typeOf(entry.value, env));
      }
      return objectOf(props, open);
    }
    case "FieldRef":
      return env.typeAt(node.path, 0);
    case "Ident":
      return env.scope.has(node.name) ? env.lookup(node.name, node.pos).type : ANY;
    case "StreamRef":
      return of("stream");
    case "MemberAccess": {
      if (!isCallable(node.name) || sourceFamily(node.object) !== null) {
        return callOn(node.name, typeOf(node.object, env), receiverFamilyOf(node.object, env), [], env);
      }
      return propOf(typeOf(node.object, env), node.name);
    }
    case "IndexAccess": {
      const obj = typeOf(node.object, env);
      if (node.index.type === "NumberLiteral") return itemOf(obj, node.index.value);
      if (node.index.type === "StringLiteral") return propOf(obj, node.index.value);
      return anyItemOf(obj);
    }
    case "MethodCall": {
      const receiver = typeOf(node.object, env);
      const family = receiverFamilyOf(node.object, env);
      if (family !== null) return callOn(node.name, receiver, family, node.args, env);
      return callOnUnproven(node.name, receiver, node.args, env);
    }
    case "OperatorCall":
      return callOn(node.name, ANY, null, node.args, env);
    case "CallExpression":
      if (node.callee.type === "Lambda" && node.callee.body !== undefined) return kindsOf(node.callee.body, env);
      if (node.callee.type === "Ident" && env.scope.has(node.callee.name)) {
        const b = env.lookup(node.callee.name, node.callee.pos);
        if (b.ref.kind === "function" && b.ref.lambda.type === "Lambda" && b.ref.lambda.body !== undefined)
          return kindsOf(b.ref.lambda.body, env);
      }
      return node.callee.type === "Ident" && !env.scope.has(node.callee.name)
        ? callOn(node.callee.name, ANY, null, node.args, env)
        : ANY;
    case "NewExpression":
      return node.callee.type === "Ident" && !env.scope.has(node.callee.name)
        ? callOn(node.callee.name, ANY, null, node.args, env)
        : ANY;
    case "UnaryExpr": {
      const key = productionForOperator("UnaryExpr", node.op);
      return key === undefined ? ANY : callOn(key, ANY, null, [], env);
    }
    case "BinaryExpr": {
      if (node.op === "+") {
        const l = kindOf(node.left, env);
        const r = kindOf(node.right, env);
        if (l === "string" || r === "string") return of("string");
        if (l === "number" && r === "number") return of("number");
      }
      if (node.op === "??") {
        const r = kindsOf(node.right, env);
        return { ...join(kindsOf(node.left, env), r), absent: r.absent };
      }
      if (node.op === "&&" || node.op === "||") return join(kindsOf(node.left, env), kindsOf(node.right, env));
      const key = productionForOperator("BinaryExpr", node.op);
      return key === undefined ? ANY : callOn(key, ANY, null, [], env);
    }
    case "TernaryExpr":
      return join(kindsOf(node.consequent, env), kindsOf(node.alternate, env));
    case "ExprBlock":
      return kindsOf(node.ret, env);
    default:
      return ANY;
  }
}

function operatorKeyOf(v: unknown): string | null {
  if (!isPlainObject(v)) return null;
  const ops = Object.keys(v).filter((k) => k.startsWith("$"));
  return ops.length === 1 ? ops[0] : null;
}

export function typeOfEmitted(value: unknown, doc: Type): Type {
  if (value === null || value === undefined) return NOTHING;
  if (typeof value === "string") {
    if (value.startsWith("$$")) return value === "$$ROOT" || value === "$$CURRENT" ? doc : ANY;
    if (value.startsWith("$")) return at(doc, value.slice(1));
    return of("string");
  }
  if (typeof value === "number" || typeof value === "bigint") return of("number");
  if (typeof value === "boolean") return of("bool");
  if (Array.isArray(value)) return arrayOf(joinAll(value.map((v) => typeOfEmitted(v, doc))));
  const op = operatorKeyOf(value);
  if (op !== null) {
    const raw = (value as Record<string, unknown>)[op];
    if (op === "$literal") return injectedType(raw);
    if (op === "$cond") {
      if (Array.isArray(raw) && raw.length === 3) return join(typeOfEmitted(raw[1], doc), typeOfEmitted(raw[2], doc));
      if (isPlainObject(raw) && "then" in raw && "else" in raw) {
        return join(typeOfEmitted(raw.then, doc), typeOfEmitted(raw.else, doc));
      }
      return ANY;
    }
    if (op === "$switch") {
      if (!isPlainObject(raw) || !Array.isArray(raw.branches)) return ANY;
      const answers = raw.branches.map((b: unknown) => (isPlainObject(b) ? typeOfEmitted(b.then, doc) : ANY));
      if (raw.default !== undefined) answers.push(typeOfEmitted(raw.default, doc));
      return joinAll(answers);
    }
    if (op === "$ifNull") {
      if (!Array.isArray(raw) || raw.length === 0) return ANY;
      const last = typeOfEmitted(raw[raw.length - 1], doc);
      return { ...joinAll(raw.map((v) => typeOfEmitted(v, doc))), absent: last.absent };
    }
    if (op === "$arrayToObject") {
      const pairs = typeOfEmitted(Array.isArray(raw) && raw.length === 1 ? raw[0] : raw, doc);
      const pair = elementOf(pairs);
      const value = pair.items !== undefined ? itemOf(pair, 1) : propOf(pair, "v");
      return objectOf(new Map(), true, value, pairs.absent);
    }
    const args = Array.isArray(raw) ? raw : [raw];
    const site: Site = {
      receiver: ANY,
      family: null,
      arg: (n) => (n < args.length ? typeOfEmitted(args[n], doc) : ANY),
      argCount: args.length,
      callback: () => ANY,
      names: null,
    };
    const result = evaluate(returnsOf(op), site);
    const body = (a: unknown): boolean => isPlainObject(a) && operatorKeyOf(a) === null;
    const isPresent =
      neverNullAlwaysOf(op) || (neverNullOf(op) && args.every((a) => !body(a) && !typeOfEmitted(a, doc).absent));
    return isPresent ? present(result) : maybeAbsent(result);
  }
  if (isPlainObject(value)) {
    const props = new Map<string, Type>();
    for (const [k, v] of Object.entries(value)) props.set(k, typeOfEmitted(v, doc));
    return objectOf(props, false);
  }
  return injectedType(value);
}

export function documentAfter(stage: Record<string, unknown>, doc: Type): Type {
  const name = Object.keys(stage)[0];
  const body = stage[name];
  switch (documentOf(name)) {
    case "keeps":
      return keptDocument(name, body, doc);
    case "narrows":
      return narrowedBy(body, doc);
    case "fields": {
      if (typeof body === "string") return objectOf(new Map([[body, of("number")]]), false);
      if (!isPlainObject(body)) return DOCUMENT;
      const props = new Map<string, Type>();
      for (const [k, v] of Object.entries(body)) {
        props.set(
          k,
          Array.isArray(v) && v.every((s) => isPlainObject(s))
            ? arrayOf(documentsOf(v, DOCUMENT))
            : accumulated(v, doc),
        );
      }
      return objectOf(props, false);
    }
    case "value": {
      const root = isPlainObject(body) && "newRoot" in body ? body.newRoot : body;
      const t = typeOfEmitted(root, doc);
      return isOnly(t, "object") ? present(t) : DOCUMENT;
    }
    case "projection": {
      if (!isPlainObject(body)) return doc;
      const entries = Object.entries(body);
      const inclusion = entries.filter(([k]) => k !== "_id").some(([, v]) => v === 1 || v === true);
      if (!inclusion) return entries.reduce((d, [k, v]) => (v === 0 || v === false ? removed(d, k) : d), doc);
      let out: Type = objectOf(new Map(), false);
      let keepsId = true;
      for (const [k, v] of entries) {
        if (k === "_id" && (v === 0 || v === false)) {
          keepsId = false;
          continue;
        }
        out = written(out, k, v === 1 || v === true ? at(doc, k) : typeOfEmitted(v, doc));
      }
      if (keepsId && !("_id" in body)) out = written(out, "_id", at(doc, "_id"));
      return out;
    }
    case "element": {
      if (typeof body !== "string" && !isPlainObject(body)) return DOCUMENT;
      const spec =
        typeof body === "string" ? { path: body } : (body as { path?: string; preserveNullAndEmptyArrays?: boolean });
      const path = typeof spec.path === "string" && spec.path.startsWith("$") ? spec.path.slice(1) : null;
      if (path === null) return doc;
      const element = elementOf(at(doc, path));
      return written(doc, path, spec.preserveNullAndEmptyArrays === true ? maybeAbsent(element) : present(element));
    }
    case "unknown":
      return DOCUMENT;
    default:
      return doc;
  }
}

function keptDocument(name: string, body: unknown, doc: Type): Type {
  if (name === "$unset") {
    const paths: unknown[] = typeof body === "string" ? [body] : Array.isArray(body) ? body : [];
    if (!paths.every((p) => typeof p === "string")) return DOCUMENT;
    return paths.reduce<Type>((d, p) => removed(d, p as string), doc);
  }
  if (!isPlainObject(body)) return doc;
  if (name === "$set" || name === "$addFields") {
    return Object.entries(body).reduce((d, [k, v]) => written(d, k, typeOfEmitted(v, doc)), doc);
  }
  if (typeof body.as === "string") {
    const pipeline = Array.isArray(body.pipeline) ? body.pipeline : [];
    return written(doc, body.as, arrayOf(documentsOf(pipeline, DOCUMENT)));
  }
  if (isPlainObject(body.output)) {
    return Object.entries(body.output).reduce((d, [k, v]) => written(d, k, accumulated(v, doc)), doc);
  }
  return doc;
}

export function documentsOf(pipeline: readonly unknown[], doc: Type): Type {
  return pipeline.reduce<Type>((d, s) => (isPlainObject(s) ? documentAfter(s, d) : DOCUMENT), doc);
}

function accumulated(v: unknown, doc: Type): Type {
  const t = typeOfEmitted(v, doc);
  const op = operatorKeyOf(v);
  return op !== null && neverNullOf(op) ? present(t) : t;
}

const KIND_OF_TYPE_NAME: ReadonlyMap<string, Kind> = new Map<string, Kind>([
  ...(["string", "array", "number", "object", "date"] as const).flatMap((family) =>
    FIELD_FAMILY_TYPES[family].map((t): [string, Kind] => [t, family]),
  ),
  ["number", "number"],
  ["bool", "bool"],
  ["objectId", "objectId"],
  ["binData", "binData"],
]);

function kindOfQueryLiteral(v: unknown): Kind | null {
  if (v === null || v === undefined || isRegExp(v)) return null;
  const t = injectedType(v);
  const k = single(t);
  return k === "unknown" ? null : k;
}

type Proven = { readonly kinds: ReadonlySet<Kind> | "any"; readonly present: boolean };

function bothKinds(a: ReadonlySet<Kind> | "any", b: ReadonlySet<Kind> | "any"): ReadonlySet<Kind> | "any" {
  if (a === "any") return b;
  if (b === "any") return a;
  return new Set([...a].filter((k) => b.has(k)));
}

const intersect = (a: Proven, b: Proven): Proven => ({
  kinds: bothKinds(a.kinds, b.kinds),
  present: a.present || b.present,
});

function provenByClause(clause: unknown): Proven | null {
  const orArray = (k: Kind): Proven => ({ kinds: new Set<Kind>([k, "array"]), present: true });
  if (isPlainObject(clause) && Object.keys(clause).some((k) => k.startsWith("$"))) {
    let out: Proven | null = null;
    for (const [op, arg] of Object.entries(clause)) {
      let one: Proven | null = null;
      switch (op) {
        case "$eq":
        case "$gt":
        case "$gte":
        case "$lt":
        case "$lte": {
          const k = kindOfQueryLiteral(arg);
          one = k === null ? null : orArray(k);
          break;
        }
        case "$in": {
          if (!Array.isArray(arg) || arg.length === 0) break;
          const kinds = arg.map(kindOfQueryLiteral);
          if (kinds.some((k) => k === null)) break;
          one = { kinds: new Set<Kind>([...(kinds as Kind[]), "array"]), present: true };
          break;
        }
        case "$ne":
          if (arg === null) one = { kinds: "any", present: true };
          break;
        case "$type": {
          const names = Array.isArray(arg) ? arg : [arg];
          const kinds = names.map((n) => (typeof n === "string" ? KIND_OF_TYPE_NAME.get(n) : undefined));
          if (kinds.some((k) => k === undefined)) break;
          one = { kinds: new Set<Kind>([...(kinds as Kind[]), "array"]), present: true };
          break;
        }
        case "$size":
        case "$all":
        case "$elemMatch":
          one = { kinds: new Set<Kind>(["array"]), present: true };
          break;
        case "$regex":
          one = orArray("string");
          break;
        default:
          break;
      }
      if (one !== null) out = out === null ? one : intersect(out, one);
    }
    return out;
  }
  if (isRegExp(clause)) return orArray("string");
  if (clause === null || clause === undefined) return null;
  if (Array.isArray(clause)) return { kinds: new Set<Kind>(["array"]), present: true };
  if (isPlainObject(clause)) return { kinds: new Set<Kind>(["object", "array"]), present: true };
  const k = kindOfQueryLiteral(clause);
  return k === null ? null : orArray(k);
}

export function narrowedBy(query: unknown, doc: Type): Type {
  if (!isPlainObject(query)) return doc;
  let out = doc;
  for (const [key, clause] of Object.entries(query)) {
    if (key === "$and" && Array.isArray(clause)) {
      out = clause.reduce<Type>((d, q) => narrowedBy(q, d), out);
      continue;
    }
    if (key.startsWith("$")) continue;
    const proven = provenByClause(clause);
    if (proven === null) continue;
    const was = at(out, key);
    const narrowed: Type = { ...was, kinds: bothKinds(was.kinds, proven.kinds), absent: was.absent && !proven.present };
    out = written(out, key, narrowed);
  }
  return out;
}
