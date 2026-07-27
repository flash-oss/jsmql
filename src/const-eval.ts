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

import type { ArrayElement, Expr, ObjectEntry } from "./ast.ts";
import type { GenerateCtx } from "./codegen.ts";
import { CodegenError, foldConstantDate } from "./codegen.ts";
import { ObjectId } from "./objectid.ts";

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
    // Added incrementally under the consistency test (fidelity-sensitive):
    // method calls, Math/Number/Object statics, type casts, bitwise & logical ops.
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
