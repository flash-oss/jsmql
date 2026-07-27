// Compile-time constant evaluator.
//
// `evalConst(node, env, ctx)` attempts to reduce an expression AST to a single
// JS/BSON value at compile time. It is the engine behind constant folding of
// `const`/`let` declarations (see `src/const-fold.ts` and
// `docs/specs/const-folding.md`): a foldable RHS is evaluated here and the
// resulting value is inlined at every reference through the same
// `ctx.bindings` → `safeBoundValue` path that `jsmql.compile` parameters use.
//
// Two outcomes, mirroring the `foldConstantDate` / `generateNewDate` precedent
// in codegen.ts:
//   - `{ ok: false }`  — not a compile-time constant (reads document/stream/
//     environment state, or a form this evaluator doesn't fold). SILENT: the
//     caller keeps the declaration as a runtime `$set` binding.
//   - throw CodegenError — foldable, but the value can't be a valid MQL literal
//     (a non-finite arithmetic result). HARD error, same spirit as
//     `invalidConstDateError`.
//
// CORRECTNESS RULE: a fold is added here only when its JS result is provably
// identical to what the equivalent MQL lowering computes on the server (HR3).
// Where the two could diverge — MQL vs JS truthiness (`&&`/`||`/`!` on
// non-booleans), banker's rounding (`Math.round` → `$round`), locale/collation
// (string ordering), int-vs-long typing (bitwise) — the fold is withheld
// (`{ ok: false }` → runtime) until a mongod consistency test proves it equal.
// See `test/fold-consistency.test.ts`.

import type { ArrayElement, CallArg, Expr, Lambda, ObjectEntry } from "./ast.ts";
import type { GenerateCtx } from "./codegen.ts";
import { CodegenError, foldConstantDate, isOpaqueBsonValue } from "./codegen.ts";
import * as lodash from "./lodash-fold.ts";
import { ObjectId } from "./objectid.ts";

const isOpaqueBson = isOpaqueBsonValue;

export type ConstEnv = ReadonlyMap<string, unknown>;
export type EvalResult = { ok: true; value: unknown } | { ok: false };

const NO: EvalResult = { ok: false };
function ok(value: unknown): EvalResult {
  return { ok: true, value };
}

function isPrimitive(v: unknown): boolean {
  return v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean";
}

/** Guard an arithmetic result: a non-finite number has no MQL literal (HR3). */
function finiteResult(n: number, node: Expr): EvalResult {
  if (Number.isFinite(n)) return ok(n);
  throw new CodegenError(
    `This constant expression evaluates to ${Number.isNaN(n) ? "NaN" : n > 0 ? "Infinity" : "-Infinity"}, ` +
      `which has no MongoDB literal. Check the arithmetic (e.g. division by zero, or an out-of-range exponent).`,
    node.pos,
  );
}

export function evalConst(node: Expr, env: ConstEnv, ctx: GenerateCtx): EvalResult {
  switch (node.type) {
    case "NumberLiteral":
      return ok(node.value);
    case "StringLiteral":
      return ok(node.value);
    case "BooleanLiteral":
      return ok(node.value);
    case "NullLiteral":
      return ok(null);
    case "ObjectIdLiteral":
      // Mint a live BSON ObjectId — same value the `ObjectIdLiteral` codegen
      // case produces; passes through `safeBoundValue` unchanged when inlined.
      return ok(new ObjectId(node.hex));
    case "ArrayLiteral":
      return evalArray(node.elements, env, ctx);
    case "ObjectLiteral":
      return evalObject(node.entries, env, ctx);
    case "TemplateLiteral":
      return evalTemplate(node.quasis, node.expressions, env, ctx);
    case "UnaryExpr":
      return evalUnary(node, env, ctx);
    case "BinaryExpr":
      return evalBinary(node, env, ctx);
    case "TernaryExpr": {
      const c = evalConst(node.condition, env, ctx);
      if (!c.ok) return NO;
      // A ternary condition must be an actual boolean for the branch choice to
      // match MQL's `$cond` (whose `if` uses MQL truthiness). Non-boolean
      // conditions differ (JS vs MQL truthiness), so withhold the fold.
      if (typeof c.value !== "boolean") return NO;
      return evalConst(c.value ? node.consequent : node.alternate, env, ctx);
    }
    case "ParamRef": {
      // A folded const/earlier binding (env), or a compile-time param (bindings).
      // Anything else (document field, runtime let, reusable function, unknown)
      // is not a compile-time constant.
      if (env.has(node.name)) return ok(env.get(node.name));
      if (ctx.bindings?.has(node.name)) return ok(ctx.bindings.get(node.name));
      return NO;
    }
    case "NewDate": {
      // Reuse codegen's constant-date folder. A null result means runtime
      // (`new Date()`) OR an invalid constant date; both fall back here, and the
      // invalid case is rejected downstream by `generateNewDate` (HR3) when the
      // declaration lowers as a runtime binding.
      const d = foldConstantDate(node.args);
      return d !== null ? ok(d) : NO;
    }
    case "DateUTC": {
      // `Date.UTC(...)` returns epoch ms as a number. Fold only when every part
      // is a number literal (reuse the same all-literal gate as new Date).
      const asDate = foldConstantDate([node]);
      return asDate !== null ? ok(asDate.getTime()) : NO;
    }
    case "NewSet":
      // MQL has no Set type; a `new Set(arr)` value unwraps to its array.
      return node.arg === null ? ok([]) : evalConst(node.arg, env, ctx);
    case "IndexAccess":
      return evalIndex(node, env, ctx);
    case "MemberAccess": {
      if (node.member === "length") {
        const recv = evalConst(node.object, env, ctx);
        if (!recv.ok) return NO;
        const v = recv.value;
        if (typeof v === "string" || Array.isArray(v)) return ok(v.length);
        return NO;
      }
      const recv = evalConst(node.object, env, ctx);
      if (!recv.ok) return NO;
      const obj = recv.value;
      if (node.optional && (obj === null || obj === undefined)) return ok(null);
      if (obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, node.member)) {
        return ok((obj as Record<string, unknown>)[node.member]);
      }
      return NO;
    }
    case "MethodCall":
      return evalMethodCall(node.object, node.method, node.args, !!node.optional, env, ctx);
    // Added incrementally under the consistency test (fidelity-sensitive):
    // Math/Number/Object statics, type casts, bitwise & logical ops.
    default:
      return NO;
  }
}

function evalArray(elements: ArrayElement[], env: ConstEnv, ctx: GenerateCtx): EvalResult {
  const out: unknown[] = [];
  for (const el of elements) {
    if (el.type === "SpreadElement") {
      const r = evalConst(el.argument, env, ctx);
      if (!r.ok) return NO;
      if (!Array.isArray(r.value)) return NO;
      for (const v of r.value) out.push(v);
      continue;
    }
    // AssignExpr / DeleteStmt / LetDecl / FuncDecl are pipeline-only array
    // elements, never a value; they aren't compile-time constants.
    if (el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl" || el.type === "FuncDecl") {
      return NO;
    }
    const r = evalConst(el, env, ctx);
    if (!r.ok) return NO;
    out.push(r.value);
  }
  return ok(out);
}

function evalObject(entries: ObjectEntry[], env: ConstEnv, ctx: GenerateCtx): EvalResult {
  const out: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.type === "SpreadElement") {
      const r = evalConst(entry.argument, env, ctx);
      if (!r.ok) return NO;
      const v = r.value;
      if (v === null || typeof v !== "object" || Array.isArray(v)) return NO;
      for (const [k, val] of Object.entries(v)) out[k] = val;
      continue;
    }
    let key: string;
    if (entry.key.kind === "static") {
      key = entry.key.name;
    } else {
      const k = evalConst(entry.key.expr, env, ctx);
      if (!k.ok) return NO;
      if (typeof k.value !== "string" && typeof k.value !== "number") return NO;
      key = String(k.value);
    }
    const val = evalConst(entry.value, env, ctx);
    if (!val.ok) return NO;
    out[key] = val.value;
  }
  return ok(out);
}

function evalTemplate(quasis: string[], expressions: Expr[], env: ConstEnv, ctx: GenerateCtx): EvalResult {
  // jsmql lowers interpolations with `$toString`. To keep the fold identical to
  // that lowering we only fold string interpolations (where `$toString` is the
  // identity); numeric/other interpolations are withheld until a consistency
  // test pins `$toString`'s formatting.
  let out = quasis[0] ?? "";
  for (let i = 0; i < expressions.length; i++) {
    const r = evalConst(expressions[i], env, ctx);
    if (!r.ok) return NO;
    if (typeof r.value !== "string") return NO;
    out += r.value + (quasis[i + 1] ?? "");
  }
  return ok(out);
}

function evalUnary(node: Extract<Expr, { type: "UnaryExpr" }>, env: ConstEnv, ctx: GenerateCtx): EvalResult {
  const r = evalConst(node.operand, env, ctx);
  if (!r.ok) return NO;
  const v = r.value;
  switch (node.op) {
    case "-":
      if (typeof v === "number") return finiteResult(-v, node);
      return NO;
    case "!":
      // Fold only a boolean operand: MQL `$not` truthiness differs from JS for
      // non-booleans (e.g. "" is falsy in JS, truthy in MQL).
      if (typeof v === "boolean") return ok(!v);
      return NO;
    // "~" (bitwise not) is fidelity-sensitive (int vs long); added under test.
    default:
      return NO;
  }
}

function evalBinary(node: Extract<Expr, { type: "BinaryExpr" }>, env: ConstEnv, ctx: GenerateCtx): EvalResult {
  const op = node.op;
  const L = evalConst(node.left, env, ctx);
  if (!L.ok) return NO;
  // `??` short-circuits on the left, mirroring `$ifNull`.
  if (op === "??") {
    return L.value === null || L.value === undefined ? evalConst(node.right, env, ctx) : ok(L.value);
  }
  const R = evalConst(node.right, env, ctx);
  if (!R.ok) return NO;
  const a = L.value;
  const b = R.value;
  switch (op) {
    case "+":
      if (typeof a === "number" && typeof b === "number") return finiteResult(a + b, node);
      if (typeof a === "string" && typeof b === "string") return ok(a + b);
      return NO;
    case "-":
      if (typeof a === "number" && typeof b === "number") return finiteResult(a - b, node);
      return NO;
    case "*":
      if (typeof a === "number" && typeof b === "number") return finiteResult(a * b, node);
      return NO;
    case "/":
      if (typeof a === "number" && typeof b === "number") return finiteResult(a / b, node);
      return NO;
    case "%":
      if (typeof a === "number" && typeof b === "number") return finiteResult(a % b, node);
      return NO;
    case "**":
      if (typeof a === "number" && typeof b === "number") return finiteResult(a ** b, node);
      return NO;
    case "===":
      if (isPrimitive(a) && isPrimitive(b)) return ok(a === b);
      return NO;
    case "!==":
      if (isPrimitive(a) && isPrimitive(b)) return ok(a !== b);
      return NO;
    case "==":
      // jsmql only permits `==`/`!=` against null, so one side is always null.
      if (isPrimitive(a) && isPrimitive(b)) return ok(a === null || b === null ? a === b : a === b);
      return NO;
    case "!=":
      if (isPrimitive(a) && isPrimitive(b)) return ok(a !== b);
      return NO;
    case "<":
      if (typeof a === "number" && typeof b === "number") return ok(a < b);
      return NO;
    case ">":
      if (typeof a === "number" && typeof b === "number") return ok(a > b);
      return NO;
    case "<=":
      if (typeof a === "number" && typeof b === "number") return ok(a <= b);
      return NO;
    case ">=":
      if (typeof a === "number" && typeof b === "number") return ok(a >= b);
      return NO;
    case "in":
      // jsmql `in` is membership (`$in`), NOT the JS `in` index-key test.
      if (Array.isArray(b)) return ok(b.includes(a));
      return NO;
    // "&&" / "||" (operand-return vs MQL boolean) and "&" / "|" / "^" (int vs
    // long typing) are fidelity-sensitive; added under test.
    default:
      return NO;
  }
}

function evalIndex(node: Extract<Expr, { type: "IndexAccess" }>, env: ConstEnv, ctx: GenerateCtx): EvalResult {
  const objR = evalConst(node.object, env, ctx);
  if (!objR.ok) return NO;
  const idxR = evalConst(node.index, env, ctx);
  if (!idxR.ok) return NO;
  const obj = objR.value;
  const idx = idxR.value;
  if (node.optional && (obj === null || obj === undefined)) return ok(null);
  if (Array.isArray(obj) && typeof idx === "number") {
    // JS negative indices don't wrap on bracket access; `$arrayElemAt` does.
    // Only fold the plain in-range non-negative case where the two agree.
    if (idx >= 0 && Number.isInteger(idx)) return ok(idx < obj.length ? obj[idx] : null);
    return NO;
  }
  if (typeof obj === "string" && typeof idx === "number") {
    if (idx >= 0 && Number.isInteger(idx)) return ok(idx < obj.length ? obj[idx] : null);
    return NO;
  }
  if (obj !== null && typeof obj === "object" && typeof idx === "string") {
    return Object.prototype.hasOwnProperty.call(obj, idx) ? ok((obj as Record<string, unknown>)[idx]) : ok(null);
  }
  return NO;
}

// ── Method folding ──────────────────────────────────────────────────────────
//
// Native string/array methods are evaluated by calling MQL-faithful JS (ASCII
// case, JS-identical structural transforms); higher-order methods interpret
// their arrow callback. Every method here is validated against its MQL lowering
// on a real mongod by test/fold-consistency.test.ts (HR3) — a method/arg-shape
// the test can't prove equal is removed so the declaration stays a runtime
// binding rather than emit a value that disagrees with the server.

// Thrown when a callback body or argument isn't a compile-time constant; caught
// at the method boundary and turned into `{ ok: false }` (runtime fallback).
const NON_FOLDABLE = Symbol("non-foldable");

/** ASCII-only upper/lower, matching MongoDB `$toUpper`/`$toLower` (non-ASCII unchanged). */
function asciiUpper(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 97 && c <= 122 ? String.fromCharCode(c - 32) : s[i];
  }
  return out;
}
function asciiLower(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

/** Turn a Lambda AST into a JS function; throws NON_FOLDABLE if its body/args aren't constant. */
function interpretLambda(lambda: Lambda, env: ConstEnv, ctx: GenerateCtx): (...args: unknown[]) => unknown {
  return (...args: unknown[]): unknown => {
    const child = new Map(env);
    lambda.params.forEach((p, i) => child.set(p, args[i]));
    let bodyExpr: Expr;
    if (lambda.exprBlock) {
      for (const decl of lambda.exprBlock.decls) {
        const r = evalConst(decl.value, child, ctx);
        if (!r.ok) throw NON_FOLDABLE;
        child.set(decl.name, r.value);
      }
      bodyExpr = lambda.exprBlock.ret;
    } else if (lambda.body) {
      bodyExpr = lambda.body;
    } else {
      throw NON_FOLDABLE; // statement-block callback — not a value-producing lambda
    }
    const r = evalConst(bodyExpr, child, ctx);
    if (!r.ok) throw NON_FOLDABLE;
    return r.value;
  };
}

/** Evaluate positional (non-callback) args to values, splatting spreads. Throws NON_FOLDABLE. */
function evalArgValues(args: CallArg[], env: ConstEnv, ctx: GenerateCtx): unknown[] {
  const out: unknown[] = [];
  for (const a of args) {
    if (a.type === "SpreadElement") {
      const r = evalConst(a.argument, env, ctx);
      if (!r.ok || !Array.isArray(r.value)) throw NON_FOLDABLE;
      for (const v of r.value) out.push(v);
    } else {
      const r = evalConst(a, env, ctx);
      if (!r.ok) throw NON_FOLDABLE;
      out.push(r.value);
    }
  }
  return out;
}

function requireLambdaArg(args: CallArg[], env: ConstEnv, ctx: GenerateCtx): (...a: unknown[]) => unknown {
  const first = args[0];
  if (!first || first.type !== "Lambda") throw NON_FOLDABLE; // bare-callback forms not folded
  return interpretLambda(first, env, ctx);
}

function evalMethodCall(
  object: Expr,
  method: string,
  args: CallArg[],
  optional: boolean,
  env: ConstEnv,
  ctx: GenerateCtx,
): EvalResult {
  const recvR = evalConst(object, env, ctx);
  if (!recvR.ok) return NO;
  const recv = recvR.value;
  if (optional && (recv === null || recv === undefined)) return ok(null);
  try {
    if (typeof recv === "string") return foldStringMethod(recv, method, args, env, ctx);
    if (typeof recv === "number") return foldNumberMethod(recv, method, args, env, ctx);
    if (Array.isArray(recv)) return foldArrayMethod(recv, method, args, env, ctx);
    if (recv !== null && typeof recv === "object" && !isOpaqueBson(recv)) {
      return foldObjectMethod(recv as Record<string, unknown>, method, args, env, ctx);
    }
    return NO;
  } catch (e) {
    if (e === NON_FOLDABLE) return NO;
    throw e; // real CodegenError (e.g. non-finite inside a callback) propagates
  }
}

function foldStringMethod(s: string, method: string, args: CallArg[], env: ConstEnv, ctx: GenerateCtx): EvalResult {
  switch (method) {
    case "toUpperCase":
      return ok(asciiUpper(s));
    case "toLowerCase":
      return ok(asciiLower(s));
    case "trim":
      return ok(s.trim());
    case "trimStart":
    case "trimLeft":
      return ok(s.trimStart());
    case "trimEnd":
    case "trimRight":
      return ok(s.trimEnd());
    case "startsWith":
    case "endsWith":
    case "includes":
    case "indexOf":
    case "lastIndexOf":
    case "charAt":
    case "slice":
    case "substring":
    case "repeat":
    case "padStart":
    case "padEnd": {
      const a = evalArgValues(args, env, ctx);
      // Regex/non-string args to these are non-constant here; call as JS.
      const fn = (s as unknown as Record<string, (...x: unknown[]) => unknown>)[method];
      return ok(fn.apply(s, a));
    }
    case "split": {
      const a = evalArgValues(args, env, ctx);
      // Regex separator, or the empty separator ($split rejects "" on the server) → runtime.
      if (a.length === 0 || typeof a[0] !== "string" || a[0] === "") throw NON_FOLDABLE;
      return ok(s.split(...(a as [string, number?])));
    }
    // lodash string methods — MQL-faithful JS impls in lodash-fold.ts.
    case "capitalize":
      return ok(lodash.capitalize(s));
    case "upperFirst":
      return ok(lodash.upperFirst(s));
    case "lowerFirst":
      return ok(lodash.lowerFirst(s));
    case "words":
      return ok(lodash.words(s));
    case "kebabCase":
      return ok(lodash.kebabCase(s));
    case "snakeCase":
      return ok(lodash.snakeCase(s));
    case "startCase":
      return ok(lodash.startCase(s));
    case "camelCase":
      return ok(lodash.camelCase(s));
    case "escape":
      return ok(lodash.escape(s));
    case "truncate":
      return foldTruncate(s, args, env, ctx);
    default:
      throw NON_FOLDABLE;
  }
}

/** `.truncate([{ length, omission }])` — mirror the codegen options handling. */
function foldTruncate(s: string, args: CallArg[], env: ConstEnv, ctx: GenerateCtx): EvalResult {
  let length = 30;
  let omission = "...";
  if (args.length > 0) {
    const optsR = evalConst(args[0].type === "SpreadElement" ? args[0].argument : args[0], env, ctx);
    if (!optsR.ok) throw NON_FOLDABLE;
    const opts = optsR.value;
    if (opts === null || typeof opts !== "object" || Array.isArray(opts)) throw NON_FOLDABLE;
    const o = opts as Record<string, unknown>;
    // `separator` (word-boundary) is unsupported in the lowering → let runtime throw.
    if ("separator" in o) throw NON_FOLDABLE;
    if ("length" in o) {
      if (typeof o.length !== "number") throw NON_FOLDABLE;
      length = o.length;
    }
    if ("omission" in o) {
      if (typeof o.omission !== "string") throw NON_FOLDABLE;
      omission = o.omission;
    }
  }
  return ok(lodash.truncate(s, length, omission));
}

function foldArrayMethod(arr: unknown[], method: string, args: CallArg[], env: ConstEnv, ctx: GenerateCtx): EvalResult {
  switch (method) {
    case "map":
      return ok(arr.map((el, i) => requireLambdaArg(args, env, ctx)(el, i)));
    case "filter":
      return ok(arr.filter((el, i) => requireLambdaArg(args, env, ctx)(el, i)));
    case "some":
      return ok(arr.some((el, i) => requireLambdaArg(args, env, ctx)(el, i)));
    case "every":
      return ok(arr.every((el, i) => requireLambdaArg(args, env, ctx)(el, i)));
    case "find": {
      const found = arr.find((el, i) => requireLambdaArg(args, env, ctx)(el, i));
      // Not-found lowers to a MISSING value on the server (not null); withhold so
      // that case takes the runtime path instead of folding to a disagreeing null.
      if (found === undefined) throw NON_FOLDABLE;
      return ok(found);
    }
    case "flatMap":
      return ok(arr.flatMap((el, i) => requireLambdaArg(args, env, ctx)(el, i) as unknown));
    case "reduce": {
      const fn = requireLambdaArg(args, env, ctx);
      const init = evalArgValues(args.slice(1), env, ctx);
      if (init.length === 0) throw NON_FOLDABLE; // jsmql requires an initial value
      return ok(arr.reduce((acc, el, i) => fn(acc, el, i), init[0]));
    }
    // NOTE: `.slice` and `.flat` are deliberately NOT folded — jsmql lowers array
    // `.slice` to `$slice` (take-n / skip-take, not JS start/end semantics), so a
    // JS fold would disagree with the runtime; `.flat` has no faithful lowering
    // for a non-nested array. Both stay runtime. (Verified by fold-consistency.)
    case "concat":
    case "includes":
    case "indexOf":
    case "lastIndexOf":
    case "join":
    case "at":
    case "toReversed": {
      const a = evalArgValues(args, env, ctx);
      const fn = (arr as unknown as Record<string, (...x: unknown[]) => unknown>)[method];
      return ok(fn.apply(arr, a));
    }
    // ── lodash array methods (non-iteratee) ─────────────────────────────────
    case "sum":
      return ok(lodash.sum(arr));
    case "mean":
      return ok(lodash.mean(arr));
    case "min":
    case "max": {
      if (arr.length === 0) return ok(null); // $min/$max of [] → null
      if (!arr.every((x) => typeof x === "number")) throw NON_FOLDABLE; // BSON order for mixed types → runtime
      return ok(method === "min" ? Math.min(...(arr as number[])) : Math.max(...(arr as number[])));
    }
    case "uniq":
    case "sortedUniq":
      return ok(lodash.uniq(arr));
    case "compact":
      return ok(lodash.compact(arr));
    case "flatten":
      return ok(lodash.flatten(arr));
    case "chunk": {
      const [size] = evalArgValues(args, env, ctx);
      if (typeof size !== "number" || !Number.isInteger(size) || size < 1) throw NON_FOLDABLE;
      return ok(lodash.chunk(arr, size));
    }
    case "take":
    case "drop":
    case "takeRight":
    case "dropRight": {
      const a = evalArgValues(args, env, ctx);
      const n = a.length > 0 ? a[0] : 1;
      if (typeof n !== "number" || n < 0) throw NON_FOLDABLE; // negative → runtime error/mirror hint
      return ok(
        method === "take"
          ? lodash.take(arr, n)
          : method === "drop"
            ? lodash.drop(arr, n)
            : method === "takeRight"
              ? lodash.takeRight(arr, n)
              : lodash.dropRight(arr, n),
      );
    }
    case "tail":
      return ok(lodash.drop(arr, 1));
    case "initial":
      return ok(lodash.dropRight(arr, 1));
    case "head":
    case "first":
      if (arr.length === 0) throw NON_FOLDABLE; // $first of [] → missing, not null
      return ok(arr[0]);
    case "last":
      if (arr.length === 0) throw NON_FOLDABLE;
      return ok(arr[arr.length - 1]);
    case "nth": {
      const a = evalArgValues(args, env, ctx);
      const nRaw = a.length > 0 ? a[0] : 0;
      if (typeof nRaw !== "number" || !Number.isInteger(nRaw)) throw NON_FOLDABLE;
      const idx = nRaw < 0 ? arr.length + nRaw : nRaw;
      if (idx < 0 || idx >= arr.length) throw NON_FOLDABLE; // out of range → missing on server
      return ok(arr[idx]);
    }
    case "size":
      return ok(arr.length);
    case "without": {
      const values = evalArgValues(args, env, ctx);
      return ok(lodash.without(arr, values));
    }
    default:
      throw NON_FOLDABLE;
  }
}

function foldNumberMethod(n: number, method: string, args: CallArg[], env: ConstEnv, ctx: GenerateCtx): EvalResult {
  const a = evalArgValues(args, env, ctx);
  switch (method) {
    case "clamp":
      if (a.length !== 2 || typeof a[0] !== "number" || typeof a[1] !== "number") throw NON_FOLDABLE;
      return ok(lodash.clamp(n, a[0], a[1]));
    case "inRange":
      if (a.length < 1 || a.length > 2 || !a.every((x) => typeof x === "number")) throw NON_FOLDABLE;
      return ok(lodash.inRange(n, a[0] as number, a[1] as number | undefined));
    case "round":
    case "ceil":
    case "floor": {
      if (a.length > 1) throw NON_FOLDABLE;
      const p = a.length === 1 ? a[0] : 0;
      if (typeof p !== "number" || !Number.isInteger(p)) throw NON_FOLDABLE;
      const r = method === "round" ? lodash.round(n, p) : method === "ceil" ? lodash.ceilN(n, p) : lodash.floorN(n, p);
      return Number.isFinite(r) ? ok(r) : NO;
    }
    default:
      throw NON_FOLDABLE;
  }
}

function foldObjectMethod(
  obj: Record<string, unknown>,
  method: string,
  args: CallArg[],
  env: ConstEnv,
  ctx: GenerateCtx,
): EvalResult {
  switch (method) {
    case "size":
      return ok(Object.keys(obj).length);
    case "toPairs":
      return ok(Object.entries(obj).map(([k, v]) => [k, v]));
    case "invert": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        const nk = lodash.mqlKeyString(v);
        if (nk === undefined) throw NON_FOLDABLE;
        out[nk] = k;
      }
      return ok(out);
    }
    case "pick":
    case "omit": {
      const keys = pickKeyList(args);
      if (method === "pick") {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
        return ok(out);
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) if (!keys.includes(k)) out[k] = v;
      return ok(out);
    }
    case "mapValues": {
      const fn = requireLambdaArg(args, env, ctx);
      const out: Record<string, unknown> = {};
      // lodash mapValues iteratee is (value, key); jsmql's resolveObjIteratee maps
      // the same. Only the arrow form is folded here.
      for (const [k, v] of Object.entries(obj)) out[k] = fn(v, k);
      return ok(out);
    }
    default:
      throw NON_FOLDABLE;
  }
}

/** The literal key list for `.pick([...])` / `.omit([...])` (array-of-strings arg). */
function pickKeyList(args: CallArg[]): string[] {
  const first = args[0];
  if (!first || first.type !== "ArrayLiteral") throw NON_FOLDABLE;
  const keys: string[] = [];
  for (const el of first.elements) {
    if (el.type !== "StringLiteral") throw NON_FOLDABLE;
    keys.push(el.value);
  }
  return keys;
}
