// Phase 5 — EMIT. What a node PROVABLY is, from the registry and the Env alone.
//
// This is a proof, not a guess. A literal proves its own kind. A row's `returns`
// proves a call's type, evaluated against the receiver and the arguments. A
// binding carries the proof it was made with. A field path answers what the
// document `Type` on its level records at that path: `ANY` for a field the
// program never wrote, the written value's proof after a write. The dispatch in
// select.ts turns "unknown" into a runtime test. It never turns "unknown" into
// an assumption. So this module must never answer with a kind it cannot show.
// See docs/specs/types.md.
//
// `regexp` and `set` are source-level families with no result kind of
// their own. A receiver can be one of these families (`/x/.test(s)`,
// `new Set(a).union(b)`). So this module also answers the family question,
// beside the type.

import type { Expr, Kind, Type } from "../../registry/vocabulary.ts";
import type { FieldFamily } from "../../registry/vocabulary.ts";
import type { CallArg } from "../../registry/ast.ts";
import type { Env } from "./env.ts";
import { namedRow } from "../passes/naming.ts";
import {
  callbackParamsOf,
  constructedFamilyOf,
  documentOf,
  familiesOf,
  isCallable,
  namespaceNames,
  neverNullOf,
  productionForOperator,
  returnsOf,
  soleFieldFamilyOf,
} from "../rows.ts";
import { bsonTagOf, BSON_KIND, isDate, isPlainObject, isRegExp } from "../../bson.ts";
import { FIELD_FAMILY_TYPES } from "../../registry/vocabulary.ts";
import { isMqlShaped } from "../passes/inject.ts";
import {
  ANY,
  DOCUMENT,
  NOTHING,
  arrayOf,
  at,
  elementOf,
  evaluate,
  flattenOnce,
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
  written,
} from "./type.ts";
import type { Site } from "./type.ts";
import { staticKey } from "../passes/naming.ts";

export type Known = Kind | "unknown";

const NAMESPACES = namespaceNames();

/**
 * Is the value `node` reads certainly THERE — never null, never missing?
 *
 * A literal is. The root document is (`Object.keys($)`). A binding states
 * whether it is (a `$lookup`'s array, a `let` of a present value). A call
 * is, when its row states `neverNull` and its receiver and every value
 * argument are also present — `$map` over an array that is there gives an
 * array that is there. A field path is present only where the document's
 * proof says so: the document may lack it, and every array operator returns
 * null for a missing input. A `? :` is present when both branches are; a
 * property read is present when the object's proof says so.
 * MEASURED: `{ $size: null }` and `{ $in: [x, null] }` abort the command.
 * So a cell guards with `$ifNull` exactly where this function returns false.
 */
export const isPresent = (node: Expr, env: Env): boolean => !typeOf(node, env).absent;

/**
 * What a ROW or the source states about presence, or null where the proof's own
 * `absent` flag is the answer — a `? :` joins its branches, a property read
 * carries the object's proof, a binding carries what its value proved.
 */
function statedPresence(node: Expr, env: Env): boolean | null {
  switch (node.type) {
    case "NumberLiteral":
    case "BigIntLiteral":
    case "StringLiteral":
    case "TemplateLiteral":
    case "BooleanLiteral":
    case "ObjectIdLiteral":
    case "ArrayLiteral":
      return true;
    case "ObjectLiteral":
      // a raw `{ $op: … }` is the operator's answer, which may be null
      return namedRow(node) === null;
    case "Injected":
      return node.value !== null && node.value !== undefined && !isMqlShaped(node.value);
    case "MethodCall": {
      const name = namedRow(node) ?? node.name;
      if (!neverNullOf(name)) return false;
      // A namespace (`Object.keys(o)`) is not a value; its arguments carry the answer.
      // An optional chain (`$.a?.map(f)`) reads a missing receiver as the family's
      // empty value, which is there — where the row names the one family that has one.
      const receiver =
        node.object.type === "Ident" && !env.scope.has(node.object.name) && NAMESPACES.has(node.object.name)
          ? true
          : (node.optional && soleFieldFamilyOf(name) !== null) || isPresent(node.object, env);
      return receiver && node.args.every((a) => argPresent(a, env));
    }
    case "OperatorCall":
      return neverNullOf(node.name) && node.args.every((a) => argPresent(a, env));
    case "CallExpression":
      if (node.callee.type === "Ident" && !env.scope.has(node.callee.name)) {
        return neverNullOf(node.callee.name) && node.args.every((a) => argPresent(a, env));
      }
      return null;
    case "NewExpression":
      return node.callee.type === "Ident" && !env.scope.has(node.callee.name)
        ? neverNullOf(node.callee.name) && node.args.every((a) => argPresent(a, env))
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
      // A property row (`.length`, `Math.PI`) answers like a call: its row's `neverNull`
      // over a present receiver. A field read carries the object's proof.
      if (!isCallable(node.name) || sourceFamily(node.object) !== null) {
        return neverNullOf(node.name) && (sourceFamily(node.object) !== null || isPresent(node.object, env));
      }
      return null;
    case "FieldRef":
    case "Ident":
    case "CollectionRef":
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

/** Does this access chain carry a `?.` anywhere on the way to its base — a folded path included? */
export function chainHasOptional(e: Expr): boolean {
  let cursor: Expr = e;
  while (cursor.type === "MemberAccess" || cursor.type === "IndexAccess") {
    if (cursor.optional) return true;
    cursor = cursor.object;
  }
  return cursor.type === "FieldRef" && cursor.optional === true;
}

/** An argument as written: a callback is not a value and says nothing; a spread is its list; a value must be present. */
function argPresent(a: CallArg, env: Env): boolean {
  if (a.type === "SpreadElement") return isPresent(a.argument, env);
  if (a.type === "Lambda") return true;
  return isPresent(a, env);
}

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

/** The receiver family a node names as SOURCE, before any kind: a namespace, a regex, a set — or null. */
export function sourceFamily(node: Expr): FieldFamily | "regexp" | "set" | string | null {
  if (node.type === "Ident" && NAMESPACES.has(node.name)) return node.name;
  if (node.type === "RegexLiteral") return "regexp";
  if (node.type === "NewExpression" && node.callee.type === "Ident")
    return constructedFamilyOf(node.callee.name) ?? null;
  return null;
}

/** The one kind `node` provably has under `env`, or "unknown". A reader of `typeOf` for a consumer that asks for one kind. */
export const kindOf = (node: Expr, env: Env): Known => single(typeOf(node, env));

/** The one kind of ONE element of the array `node` reads, or "unknown". */
export const elementKindOf = (node: Expr, env: Env): Known => single(elementOf(typeOf(node, env)));

/** The receiver family a node has, for a row's per-family `returns`: a source family, else its kind's. */
export function receiverFamilyOf(node: Expr, env: Env): FieldFamily | "regexp" | "set" | string | null {
  const src = sourceFamily(node);
  if (src !== null) return src;
  if (node.type === "CollectionRef") return "stream";
  return familyOfKind(kindOf(node, env));
}

/** The property names a list of string literals spells, or null when the list holds anything else. */
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

/** The site a row's `returns` evaluates at: the receiver, its source family, and the arguments. */
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

/**
 * What the n-th callback argument RETURNS, its parameters bound as the row's
 * `params` say: the element (`value`), the index (a number), the key (a string),
 * the whole receiver (`collection`), the seed (`accumulator`). A parameter is
 * never proven present. A callback that is not an arrow with a body proves nothing.
 */
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
  let bodyEnv = env.block();
  cb.params.forEach((p, i) => {
    const kind = kinds[i];
    const t =
      kind === "value"
        ? flattenOnce(receiver)
        : kind === "index"
          ? of("number")
          : kind === "key"
            ? of("string")
            : kind === "collection"
              ? receiver
              : kind === "accumulator"
                ? arg(n + 1)
                : ANY;
    bodyEnv = bodyEnv.param(p, maybeAbsent(t), cb.pos).env;
  });
  return typeOf(cb.body, bodyEnv);
}

/** A call's result when the receiver's family is PROVEN: the row's term for that family. */
function callOn(name: string, receiver: Type, family: string | null, args: readonly CallArg[], env: Env): Type {
  return evaluate(returnsOf(name), siteOf(name, receiver, family, args, env));
}

/**
 * A call on an UNPROVEN receiver. The call is on one of the families the row
 * names, or the server raises an error. So the result is the row's answer over
 * the field families it accepts, joined: `.size()` is a number on an array and
 * on an object, so it is a number. It is the one family's answer when there is
 * only one (`.map`). A receiver that may be several kinds proves several.
 */
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

const TERMS = ["arrayOf", "elementOf", "callback", "arg", "args", "merge", "oneOf", "recordOf", "tuple"];
const isFamilyMap = (r: unknown): boolean => typeof r === "object" && r !== null && !TERMS.some((k) => k in r);

/** A runtime value carried in: its proof, as deep as a plain value can show. */
function injectedType(v: unknown): Type {
  if (typeof v === "number" || typeof v === "bigint") return of("number");
  if (typeof v === "string") return isMqlShaped(v) ? ANY : of("string");
  if (typeof v === "boolean") return of("bool");
  if (isDate(v)) return of("date");
  if (Array.isArray(v)) return isMqlShaped(v) ? ANY : of("array");
  const tag = bsonTagOf(v);
  if (tag !== undefined) {
    const k = BSON_KIND[tag];
    return k === undefined ? ANY : of(k);
  }
  if (isPlainObject(v)) return isMqlShaped(v) ? ANY : of("object");
  return ANY;
}

/**
 * What `node` provably is under `env`. `ANY` wherever the registry and the
 * document's proof cannot show anything. Presence is what the row or the
 * source states, else what the proof itself carries.
 */
export function typeOf(node: Expr, env: Env): Type {
  const t = kindsOf(node, env);
  const stated = statedPresence(node, env);
  if (stated === null) return t;
  return stated ? present(t) : maybeAbsent(t);
}

/** The kinds, elements and properties `node` proves — everything but presence. */
function kindsOf(node: Expr, env: Env): Type {
  switch (node.type) {
    case "NumberLiteral":
    case "BigIntLiteral":
      return of("number");
    case "StringLiteral":
      // `"$x"` typed in source IS the field `x` (HR1): its kind is the field's, unknown.
      return node.value.startsWith("$") ? ANY : of("string");
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
      return arrayOf(spread ? ANY : joinAll(elements));
    }
    case "ObjectLiteral": {
      // A raw `{ $op: … }` is an operator, and its result is the operator's.
      if (namedRow(node) !== null) return ANY;
      // A spread of an object that may be absent spreads as `{}`: its properties may be missing.
      const props = new Map<string, Type>();
      let open = false;
      for (const entry of node.entries) {
        if (entry.type === "SpreadElement") {
          const spread = typeOf(entry.argument, env);
          if (spread.kinds === "any" || spread.open) {
            // an unknown property of the spread may override any name written so far
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
      // `$` is the ROOT document at every depth (HR4): level 0.
      return env.typeAt(node.path, 0);
    case "Ident":
      return env.scope.has(node.name) ? env.lookup(node.name, node.pos).type : ANY;
    case "CollectionRef":
      return of("stream");
    case "MemberAccess": {
      // A property row (`.length`, `Math.PI`) states its result; a field read is the object's property.
      if (!isCallable(node.name) || sourceFamily(node.object) !== null) {
        return callOn(node.name, typeOf(node.object, env), receiverFamilyOf(node.object, env), [], env);
      }
      return propOf(typeOf(node.object, env), node.name);
    }
    case "IndexAccess": {
      const obj = typeOf(node.object, env);
      if (node.index.type === "NumberLiteral") return itemOf(obj, node.index.value);
      if (node.index.type === "StringLiteral") return propOf(obj, node.index.value);
      return ANY;
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
      // An applied arrow `((x) => x > 1)(5)` is its body — the body's kind is provable
      // wherever it does not hang on a parameter.
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
        // The result is `$concat` when either operand is a string, and `$add`
        // otherwise. `$add` of a date returns a date. So only two numbers
        // prove a number.
        const l = kindOf(node.left, env);
        const r = kindOf(node.right, env);
        if (l === "string" || r === "string") return of("string");
        return l === "number" && r === "number" ? of("number") : ANY;
      }
      if (node.op === "??") {
        // `a ?? b` is `b` exactly when `a` is null or missing: the result is there when `b` is.
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

// ── the proof of an EMITTED document ─────────────────────────────────────────

/** Is this MQL value one operator call — `{ $sum: "$x" }`, or `{ $count: {}, window: … }`? Its name, or null. */
function operatorKeyOf(v: unknown): string | null {
  if (!isPlainObject(v)) return null;
  const ops = Object.keys(v).filter((k) => k.startsWith("$"));
  return ops.length === 1 ? ops[0] : null;
}

/**
 * What an emitted MQL VALUE proves, read against the document `doc` it runs
 * over. This is how the compiler learns what a stage made of the document
 * without the stage's source: the emitted body names the output fields and the
 * operators that fill them, whatever road wrote it. A field path reads the
 * input document's proof; an operator answers its row's `returns`; a literal
 * proves itself; a `$$` variable proves nothing. See docs/specs/types.md § The
 * document after a stage.
 */
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
    // A raw `$op(…)` passes through as written (HR2), so a body here can have any
    // shape; the reader answers `ANY` for one it does not recognise.
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
    const isPresent = neverNullOf(op) && args.every((a) => !typeOfEmitted(a, doc).absent);
    return isPresent ? present(result) : maybeAbsent(result);
  }
  if (isPlainObject(value)) {
    const props = new Map<string, Type>();
    for (const [k, v] of Object.entries(value)) props.set(k, typeOfEmitted(v, doc));
    return objectOf(props, false);
  }
  return injectedType(value);
}

/** The document `Type` after one emitted stage ran over `doc` — the row's `document` effect, applied. */
export function documentAfter(stage: Record<string, unknown>, doc: Type): Type {
  const name = Object.keys(stage)[0];
  const body = stage[name];
  switch (documentOf(name)) {
    case "keeps":
      return keptDocument(name, body, doc);
    case "narrows":
      return narrowedBy(body, doc);
    case "fields": {
      // `$group` and `$facet` state the output fields as their body. `$count` names
      // the one number field it writes.
      if (typeof body === "string") return objectOf(new Map([[body, of("number")]]), false);
      if (!isPlainObject(body)) return DOCUMENT;
      const props = new Map<string, Type>();
      for (const [k, v] of Object.entries(body)) {
        // A key whose value is a pipeline (`$facet`) holds that pipeline's documents.
        props.set(k, Array.isArray(v) && v.every((s) => isPlainObject(s)) ? arrayOf(DOCUMENT) : typeOfEmitted(v, doc));
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
      const spec =
        typeof body === "string" ? { path: body } : (body as { path?: string; preserveNullAndEmptyArrays?: boolean });
      const path = spec.path?.startsWith("$") ? spec.path.slice(1) : null;
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

/** A `keeps` stage: its output fields land on the document, its removed fields leave it. */
function keptDocument(name: string, body: unknown, doc: Type): Type {
  if (name === "$unset") {
    const paths = typeof body === "string" ? [body] : Array.isArray(body) ? (body as string[]) : [];
    return paths.reduce((d, p) => removed(d, p), doc);
  }
  if (!isPlainObject(body)) return doc;
  // `$set` / `$addFields`: every key is a written path. `$lookup` / `$graphLookup`
  // write their `as`. `$setWindowFields` writes each `output` key.
  if (name === "$set" || name === "$addFields") {
    return Object.entries(body).reduce((d, [k, v]) => written(d, k, typeOfEmitted(v, doc)), doc);
  }
  if (typeof body.as === "string") return written(doc, body.as, arrayOf(DOCUMENT));
  if (isPlainObject(body.output)) {
    return Object.entries(body.output).reduce((d, [k, v]) => written(d, k, typeOfEmitted(v, doc)), doc);
  }
  return doc;
}

// ── what a QUERY proves about the documents that pass it ─────────────────────

/**
 * The kind a query `$type` name selects. The field families state their BSON
 * type names once (`FIELD_FAMILY_TYPES`); the three kinds no family covers are
 * their own `$type` name. `"number"` is the query language's alias for every
 * numeric type.
 */
const KIND_OF_TYPE_NAME: ReadonlyMap<string, Kind> = new Map<string, Kind>([
  ...(["string", "array", "number", "object", "date"] as const).flatMap((family) =>
    FIELD_FAMILY_TYPES[family].map((t): [string, Kind] => [t, family]),
  ),
  ["number", "number"],
  ["bool", "bool"],
  ["objectId", "objectId"],
  ["binData", "binData"],
]);

/** The kind a query LITERAL is, or null for a literal that proves none (null, a regex). */
function kindOfQueryLiteral(v: unknown): Kind | null {
  if (v === null || v === undefined || isRegExp(v)) return null;
  const t = injectedType(v);
  const k = single(t);
  return k === "unknown" ? null : k;
}

/** What one field's query clause proves of the field, or null when it proves nothing. */
type Proven = { readonly kinds: ReadonlySet<Kind> | "any"; readonly present: boolean };

/** The kinds both proofs allow — `"any"` allows every kind. */
function bothKinds(a: ReadonlySet<Kind> | "any", b: ReadonlySet<Kind> | "any"): ReadonlySet<Kind> | "any" {
  if (a === "any") return b;
  if (b === "any") return a;
  return new Set([...a].filter((k) => b.has(k)));
}

const intersect = (a: Proven, b: Proven): Proven => ({
  kinds: bothKinds(a.kinds, b.kinds),
  present: a.present || b.present,
});

/**
 * A field clause in the QUERY language reads an array field element by element:
 * `{ a: 5 }` and `{ a: { $gt: 5 } }` select `a: 5` and `a: [5, 6]` alike, and
 * `{ a: { $type: "string" } }` selects `a: ["x"]`. So a clause that names a kind
 * proves that kind OR an array, and a clause that excludes null proves presence.
 * MEASURED, the comparison operators compare inside one BSON type bracket, so
 * `{ a: { $gt: 5 } }` never selects a string.
 */
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

/** The document after a `$match`: each top-level field clause, and each `$and` member, narrows its field. `$or`, `$nor`, `$expr` and the rest prove nothing. */
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
