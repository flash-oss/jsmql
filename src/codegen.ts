import { lookupOperator } from "./operators.ts";
import { closestNameTo } from "./levenshtein.ts";
import type {
  BinaryOp,
  Expr,
  ArrayElement,
  ObjectEntry,
  CallArg,
  SpreadElement,
  KeyValueEntry,
  MathMethod,
  MathConstant,
  ObjectMethod,
  TypeCastOp,
  Mutation,
  MutationProgram,
} from "./ast.ts";

export class CodegenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodegenError";
  }
}

export class UnknownIdentifierError extends CodegenError {
  identifier: string;
  constructor(identifier: string) {
    super(`Unknown identifier '${identifier}'. Did you mean '$.${identifier}'?`);
    this.name = "UnknownIdentifierError";
    this.identifier = identifier;
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

type GenerateCtx = {
  lambdaParams: ReadonlySet<string>;
  reduceRemap?: ReadonlyMap<string, string>;
};

const EMPTY_CTX: GenerateCtx = { lambdaParams: new Set() };

function extendCtx(ctx: GenerateCtx, params: string[]): GenerateCtx {
  return { lambdaParams: new Set([...ctx.lambdaParams, ...params]) };
}

// ── String-producing helpers ──────────────────────────────────────────────────

// Operators whose return type is always a string — used for string-context + inference.
const STRING_OUTPUT_OPS = new Set([
  "$toLower",
  "$toUpper",
  "$trim",
  "$ltrim",
  "$rtrim",
  "$concat",
  "$substrCP",
  "$substrBytes",
  "$substr",
  "$replaceOne",
  "$replaceAll",
  "$dateToString",
  "$type",
  "$strcasecmp",
  "$toString",
]);

// Method names that always return a string
const STRING_RETURNING_METHODS = new Set([
  "trim",
  "trimStart",
  "trimEnd",
  "trimLeft",
  "trimRight",
  "toLowerCase",
  "toUpperCase",
  "substr",
  "replace",
  "replaceAll",
  "charAt",
  "toISOString",
  "join",
  "padStart",
  "padEnd",
  "repeat",
]);

// ── Array-producing helpers ───────────────────────────────────────────────────

// Operators whose return type is always an array
const ARRAY_OUTPUT_OPS = new Set([
  "$split",
  "$range",
  "$reverseArray",
  "$slice",
  "$map",
  "$filter",
  "$concatArrays",
  "$setUnion",
  "$setIntersection",
  "$setDifference",
  "$zip",
  "$objectToArray",
]);

// Method names that always return an array
const ARRAY_RETURNING_METHODS = new Set([
  "split",
  "map",
  "filter",
  "slice",
  "reverse",
  "toReversed",
  "toSorted",
  "flat",
  "flatMap",
]);

function isArrayProducing(expr: Expr): boolean {
  switch (expr.type) {
    case "ArrayLiteral":
      return true;
    case "OperatorCall":
      return ARRAY_OUTPUT_OPS.has(expr.name);
    case "MethodCall":
      return ARRAY_RETURNING_METHODS.has(expr.method);
    case "ObjectCall":
      return expr.method === "entries" || expr.method === "keys" || expr.method === "values";
    default:
      return false;
  }
}

function isStringProducing(expr: Expr): boolean {
  switch (expr.type) {
    case "StringLiteral":
      return true;
    case "TemplateLiteral":
      return true;
    case "OperatorCall":
      return STRING_OUTPUT_OPS.has(expr.name);
    case "MethodCall":
      return STRING_RETURNING_METHODS.has(expr.method);
    case "TypeCast":
      return expr.cast === "String";
    case "TypeofExpr":
      return true;
    case "BinaryExpr":
      if (expr.op === "+") {
        const chain: Expr[] = [];
        collectExprChain("+", expr, chain);
        return chain.some((e) => isStringProducing(e));
      }
      return false;
    default:
      return false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function generate(expr: Expr): unknown {
  return _generate(expr, EMPTY_CTX);
}

// ── Core generator ────────────────────────────────────────────────────────────

function _generate(expr: Expr, ctx: GenerateCtx): unknown {
  return _generateBody(expr, ctx);
}

function _generateBody(expr: Expr, ctx: GenerateCtx): unknown {
  // Defensive: parseGrouped may surface an AssignExpr through this path when
  // it sees `($.x = expr)` — a parenthesized assignment. AssignExpr is not in
  // the Expr union, but the cast in parseGrouped lets it flow here. Reject
  // with a clear message so users debugging `1 + ($.a = 5)` see what's wrong.
  const dynType = (expr as unknown as { type: string }).type;
  if (dynType === "AssignExpr" || dynType === "DeleteStmt") {
    throw new CodegenError(
      `${dynType === "AssignExpr" ? "Assignment" : "delete"} is a statement, not a value. ` +
        `It is only valid at the top level or as a pipeline-array element.`,
    );
  }
  switch (expr.type) {
    case "NumberLiteral":
      return expr.value;
    case "BigIntLiteral":
      return { $toLong: expr.value };
    case "StringLiteral":
      return expr.value;
    case "BooleanLiteral":
      return expr.value;
    case "NullLiteral":
      return null;
    case "FieldRef":
      return `$${expr.path}`;

    case "ArrayLiteral":
      return generateArrayLiteral(expr.elements, ctx);

    case "ObjectLiteral":
      return generateObjectLiteral(expr.entries, ctx);

    case "TemplateLiteral":
      return generateTemplateLiteral(expr.quasis, expr.expressions, ctx);

    case "OperatorCall":
      return generateOperatorCall(expr.name, expr.style, expr.args, ctx);

    case "BinaryExpr":
      return generateBinaryExpr(expr.op, expr.left, expr.right, ctx);

    case "UnaryExpr":
      return generateUnaryExpr(expr.op, expr.operand, ctx);

    case "TernaryExpr":
      return {
        $cond: [
          _generate(expr.condition, ctx),
          _generate(expr.consequent, ctx),
          _generate(expr.alternate, ctx),
        ],
      };

    case "IndexAccess": {
      // `obj[idx]` and `obj?.[idx]` produce the same AST. Type-aware dispatch:
      //   known array → $arrayElemAt (numeric/expression index)
      //   unknown    → runtime $cond between $arrayElemAt (array) and $getField (object)
      const obj = _generate(expr.object, ctx);
      const idx = _generate(expr.index, ctx);
      if (isArrayProducing(expr.object)) {
        return { $arrayElemAt: [obj, idx] };
      }
      return {
        $cond: [
          { $isArray: obj },
          { $arrayElemAt: [obj, idx] },
          { $getField: { field: idx, input: obj } },
        ],
      };
    }

    case "RegexLiteral":
      // Method dispatch (e.g. `.match(/foo/)`, `/foo/.test(s)`) handles regex
      // arguments and receivers directly, reading pattern + flags from the AST
      // node before recursion. If we land here, the regex showed up in some
      // other position (binary operand, ternary branch, $op argument value)
      // where MQL has no concept of a regex value — silently returning the
      // pattern string would lose the flags and surprise the user.
      throw new CodegenError(
        `Regex literals are only valid as arguments to .match(), .test(), .exec(), .matchAll(), and .search(). To pass a regex pattern as a string, use a string literal instead.`,
      );

    case "ParamRef": {
      if (ctx.reduceRemap?.has(expr.name)) {
        return `$$${ctx.reduceRemap.get(expr.name)!}`;
      }
      if (ctx.lambdaParams.has(expr.name)) {
        return `$$${expr.name}`;
      }
      throw new UnknownIdentifierError(expr.name);
    }

    case "MemberAccess": {
      if (expr.member === "length") {
        const obj = _generate(expr.object, ctx);
        if (isStringProducing(expr.object)) return { $strLenCP: obj };
        if (isArrayProducing(expr.object)) return { $size: obj };
        // Type unknown at compile time — dispatch at runtime
        return { $cond: [{ $isArray: obj }, { $size: obj }, { $strLenCP: obj }] };
      }
      const path = asFieldPath(expr, ctx);
      if (path !== null) return path;
      // Receiver isn't a foldable field path (e.g. result of $.items[0], a method call,
      // or a ternary). Use $getField, which works on any expression result.
      return { $getField: { field: expr.member, input: _generate(expr.object, ctx) } };
    }

    case "MethodCall":
      return generateMethodCall(expr.object, expr.method, expr.args, ctx);

    case "CallExpression":
      return generateCallExpression(expr.callee, expr.args, ctx);

    case "Lambda":
      throw new CodegenError(
        "Lambda expression cannot be used here — only valid as array method argument or $let second argument",
      );

    case "TypeofExpr":
      return { $type: _generate(expr.operand, ctx) };

    case "NewDate":
      return { $toDate: expr.arg ? _generate(expr.arg, ctx) : "$$NOW" };

    case "NewSet":
      // `new Set(arr)` is a tag for the value — used as a receiver in set-method calls
      // (intersection/union/etc.). When evaluated as a standalone value, it just unwraps
      // to the underlying array (MQL has no Set type).
      return expr.arg === null ? [] : _generate(expr.arg, ctx);

    case "ArrayFrom":
      return generateArrayFrom(expr.input, expr.mapFn, ctx);

    case "NumberStatic":
      return generateNumberStatic(expr.method, expr.arg, ctx);

    case "DateNow":
      // Date.now() returns ms since epoch — match JS semantics
      return { $toLong: "$$NOW" };

    case "TypeCast":
      return generateTypeCast(expr.cast, expr.arg, ctx);

    case "TypeCastRef":
      // A bare `Boolean` / `Number` / `String` outside callback position.
      // Inside `.filter(Boolean)` etc. this node is desugared away in
      // requireLambda(); reaching this case means the user wrote it as a
      // value (e.g. `Boolean + 5`), which has no MQL counterpart.
      throw new CodegenError(
        `'${expr.cast}' used as a value is only valid as a callback to a higher-order array method (e.g. $.items.filter(${expr.cast})). To coerce a single value, write ${expr.cast}(value).`,
      );

    case "MathCall":
      return generateMathCall(expr.method, expr.args, ctx);

    case "MathConst":
      return generateMathConst(expr.name);

    case "ObjectCall":
      return generateObjectCall(expr.method, expr.args, ctx);
  }
}

// ── Field path reconstruction ─────────────────────────────────────────────────

function asFieldPath(expr: Expr, ctx: GenerateCtx): string | null {
  if (expr.type === "FieldRef") return `$${expr.path}`;
  if (expr.type === "ParamRef") {
    if (ctx.reduceRemap?.has(expr.name)) {
      return `$$${ctx.reduceRemap.get(expr.name)!}`;
    }
    if (ctx.lambdaParams.has(expr.name)) {
      return `$$${expr.name}`;
    }
    return null;
  }
  if (expr.type === "MemberAccess") {
    const base = asFieldPath(expr.object, ctx);
    if (base !== null) return `${base}.${expr.member}`;
  }
  return null;
}

// ── Binary expressions ────────────────────────────────────────────────────────

function generateBinaryExpr(op: BinaryOp, left: Expr, right: Expr, ctx: GenerateCtx): unknown {
  switch (op) {
    case "+":
      return generateAdd(left, right, ctx);
    case "-":
      return { $subtract: [_generate(left, ctx), _generate(right, ctx)] };
    case "*":
      return { $multiply: flattenChain("*", left, right, ctx) };
    case "/":
      return { $divide: [_generate(left, ctx), _generate(right, ctx)] };
    case "%":
      return { $mod: [_generate(left, ctx), _generate(right, ctx)] };
    case "**":
      return { $pow: [_generate(left, ctx), _generate(right, ctx)] };
    case "==":
    case "===":
      return { $eq: [_generate(left, ctx), _generate(right, ctx)] };
    case "!=":
    case "!==":
      return { $ne: [_generate(left, ctx), _generate(right, ctx)] };
    case ">":
      return { $gt: [_generate(left, ctx), _generate(right, ctx)] };
    case ">=":
      return { $gte: [_generate(left, ctx), _generate(right, ctx)] };
    case "<":
      return { $lt: [_generate(left, ctx), _generate(right, ctx)] };
    case "<=":
      return { $lte: [_generate(left, ctx), _generate(right, ctx)] };
    case "&&":
      return { $and: flattenChain("&&", left, right, ctx) };
    case "||":
      return { $or: flattenChain("||", left, right, ctx) };
    case "??":
      return { $ifNull: flattenChain("??", left, right, ctx) };
    case "&":
      return { $bitAnd: flattenChain("&", left, right, ctx) };
    case "|":
      return { $bitOr: flattenChain("|", left, right, ctx) };
    case "^":
      return { $bitXor: flattenChain("^", left, right, ctx) };
    case "in":
      return generateInExpr(left, right, ctx);
  }
}

/**
 * Collect all operands from a left-associative chain of the same operator.
 * e.g. BinaryExpr(*, BinaryExpr(*, a, b), c) → [gen(a), gen(b), gen(c)]
 */
function flattenChain(op: BinaryOp, left: Expr, right: Expr, ctx: GenerateCtx): unknown[] {
  const operands: unknown[] = [];
  collectChain(op, left, operands, ctx);
  operands.push(_generate(right, ctx));
  return operands;
}

function collectChain(op: BinaryOp, expr: Expr, out: unknown[], ctx: GenerateCtx): void {
  if (expr.type === "BinaryExpr" && expr.op === op) {
    collectChain(op, expr.left, out, ctx);
    out.push(_generate(expr.right, ctx));
  } else {
    out.push(_generate(expr, ctx));
  }
}

// ── `in` operator ─────────────────────────────────────────────────────────────

/**
 * `in` straddles two JS semantics depending on the RHS:
 *   - array on the right: value membership (different from JS, which checks
 *     numeric-index existence on arrays — but value-membership is overwhelmingly
 *     what users want for MongoDB queries, so we deliberately diverge here).
 *   - object on the right: property existence — JS-faithful.
 *
 * For an object-literal RHS we extract the keys at compile time and reduce to
 * `{ $in: [LHS, [...keys]] }`. Computed keys are evaluated at runtime; spread
 * entries unwrap to `$objectToArray` over the spread expression so the keys
 * become available without us having to know them at compile time.
 *
 * Scalar literals on the right have no useful interpretation in either
 * direction and stay rejected.
 */
function generateInExpr(left: Expr, right: Expr, ctx: GenerateCtx): unknown {
  if (
    right.type === "StringLiteral" ||
    right.type === "NumberLiteral" ||
    right.type === "BooleanLiteral" ||
    right.type === "NullLiteral"
  ) {
    throw new CodegenError(
      "Right-hand side of 'in' must be an array literal, object literal, or field reference, not a scalar value",
    );
  }
  if (right.type === "ObjectLiteral") {
    return { $in: [_generate(left, ctx), keyArrayForObjectLiteral(right.entries, ctx)] };
  }
  return { $in: [_generate(left, ctx), _generate(right, ctx)] };
}

/**
 * Build the MQL expression representing the *keys* of an object-literal RHS,
 * for the `key in obj` case. Static-only entries collapse to a literal string
 * array. Computed-key entries emit the key expression directly (it should
 * resolve to a string at runtime). Spread entries lower to
 * `$objectToArray(expr).k` so we can splice the runtime keys in.
 *
 * If every chunk is static the result is a plain JS array; if any spread is
 * present we wrap the chunks in `$concatArrays`.
 */
function keyArrayForObjectLiteral(entries: ObjectEntry[], ctx: GenerateCtx): unknown {
  // Fast path: all static keys → a plain literal array of strings.
  if (entries.every((e) => e.type === "KeyValueEntry" && e.key.kind === "static")) {
    return entries.map((e) => ((e as KeyValueEntry).key as { kind: "static"; name: string }).name);
  }

  // Mixed path: build `$concatArrays` of per-chunk operands. Consecutive
  // non-spread entries group into one literal array (mirrors the array-literal
  // spread codegen for compact output).
  const operands: unknown[] = [];
  let currentChunk: unknown[] | null = null;
  const flush = () => {
    if (currentChunk !== null) {
      operands.push(currentChunk);
      currentChunk = null;
    }
  };
  for (const entry of entries) {
    if (entry.type === "SpreadElement") {
      flush();
      operands.push({
        $map: {
          input: { $objectToArray: _generate(entry.argument, ctx) },
          as: "kv",
          in: "$$kv.k",
        },
      });
      continue;
    }
    if (currentChunk === null) currentChunk = [];
    currentChunk.push(
      entry.key.kind === "static" ? entry.key.name : _generate(entry.key.expr, ctx),
    );
  }
  flush();

  if (operands.length === 1) return operands[0];
  return { $concatArrays: operands };
}

// ── String-context + ──────────────────────────────────────────────────────────

function generateAdd(left: Expr, right: Expr, ctx: GenerateCtx): unknown {
  // Collect full operand chain first, then decide $add vs $concat
  const exprs: Expr[] = [];
  collectExprChain("+", left, exprs);
  exprs.push(right);

  const isString = exprs.some((e) => isStringProducing(e));
  const generated = exprs.map((e) => _generate(e, ctx));
  return isString ? { $concat: generated } : { $add: generated };
}

function collectExprChain(op: BinaryOp, expr: Expr, out: Expr[]): void {
  if (expr.type === "BinaryExpr" && expr.op === op) {
    collectExprChain(op, expr.left, out);
    out.push(expr.right);
  } else {
    out.push(expr);
  }
}

// ── Unary expressions ─────────────────────────────────────────────────────────

function generateUnaryExpr(op: "!" | "-" | "~", operand: Expr, ctx: GenerateCtx): unknown {
  if (op === "!") {
    return { $not: _generate(operand, ctx) };
  }
  if (op === "~") {
    return { $bitNot: _generate(operand, ctx) };
  }
  // Unary minus: optimise -<number> to a plain negative number literal
  if (operand.type === "NumberLiteral") {
    return -operand.value;
  }
  return { $multiply: [_generate(operand, ctx), -1] };
}

// ── Array / object literals ───────────────────────────────────────────────────

/**
 * Generate an array literal. Mirrors `generateObjectLiteral`'s spread handling:
 *
 *   - No spread → plain MQL array of generated elements.
 *   - Any spread (`[1, ...a, 2]`) → `$concatArrays` over a list of operands, where
 *     consecutive non-spread elements are grouped into one literal-array operand
 *     and each spread argument is its own operand (presumed to evaluate to an
 *     array at runtime).
 *
 * The single-operand case (`[...a]` on its own) returns the spread argument
 * directly — `{ $concatArrays: [a] }` is semantically equivalent and noisier.
 */
function generateArrayLiteral(elements: ArrayElement[], ctx: GenerateCtx): unknown {
  // Mutations (`$.a = 1`, `delete $.x`) are valid as ArrayElements only when
  // the array is a pipeline (handled in pipeline.ts before reaching here).
  // Reaching here with a mutation means the user wrote a mutation inside a
  // value array — reject with a precise error pointing at the supported forms.
  for (const el of elements) {
    if (el.type === "AssignExpr" || el.type === "DeleteStmt") {
      throw new CodegenError(
        `${el.type === "AssignExpr" ? "Assignment" : "delete"} is a statement, not a value, and is only valid at the top level or as a pipeline-array element. ` +
          `If this array is meant to be a pipeline, ensure its first element is a stage like \`$match(...)\`.`,
      );
    }
  }

  const hasSpread = elements.some((el) => el.type === "SpreadElement");

  if (!hasSpread) {
    return elements.map((el) => _generate(el as Expr, ctx));
  }

  const operands: unknown[] = [];
  let buffer: Expr[] = [];

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    operands.push(buffer.map((el) => _generate(el, ctx)));
    buffer = [];
  };

  for (const el of elements) {
    if (el.type === "SpreadElement") {
      flushBuffer();
      operands.push(_generate(el.argument, ctx));
    } else if (el.type === "AssignExpr" || el.type === "DeleteStmt") {
      // Already rejected above; unreachable.
      continue;
    } else {
      buffer.push(el);
    }
  }
  flushBuffer();

  if (operands.length === 1) return operands[0];
  return { $concatArrays: operands };
}

/**
 * Generate an object literal. The shape it compiles to depends on which features the
 * source used:
 *
 *   - All static keys, no spread        → plain MQL object.
 *   - Any computed key, no spread       → `$arrayToObject` over `[[k, v], ...]`.
 *   - Any spread (`{...a, x: 1, ...b}`) → `$mergeObjects` over a list of operands,
 *                                         where consecutive non-spread entries are
 *                                         grouped into one operand each (using the
 *                                         same static / `$arrayToObject` rules) and
 *                                         each spread argument is its own operand.
 *
 * The single-operand case (`{...a}` on its own) returns the spread argument directly
 * to avoid emitting a redundant `$mergeObjects: [a]` wrapper — they're semantically
 * equivalent in MQL.
 */
function generateObjectLiteral(entries: ObjectEntry[], ctx: GenerateCtx): unknown {
  const hasSpread = entries.some((e) => e.type === "SpreadElement");

  if (!hasSpread) {
    const hasComputed = entries.some(
      (e) => e.type === "KeyValueEntry" && e.key.kind === "computed",
    );
    if (!hasComputed) {
      return generateStaticObjectEntries(entries, ctx);
    }
    return generateComputedKeyObject(entries as KeyValueEntry[], ctx);
  }

  // Spread present: walk entries left-to-right, grouping consecutive non-spread
  // entries into one $mergeObjects operand each, and emitting each spread argument
  // as its own operand. JS spread semantics ("later wins") match $mergeObjects's
  // own ("rightmost value wins on key collision"), so left-to-right order is
  // preserved verbatim.
  const operands: unknown[] = [];
  let staticBuffer: KeyValueEntry[] = [];

  const flushBuffer = () => {
    if (staticBuffer.length === 0) return;
    const hasComputed = staticBuffer.some((e) => e.key.kind === "computed");
    operands.push(
      hasComputed
        ? generateComputedKeyObject(staticBuffer, ctx)
        : generateStaticObjectEntries(staticBuffer, ctx),
    );
    staticBuffer = [];
  };

  for (const entry of entries) {
    if (entry.type === "SpreadElement") {
      flushBuffer();
      operands.push(_generate(entry.argument, ctx));
    } else {
      staticBuffer.push(entry);
    }
  }
  flushBuffer();

  if (operands.length === 1) return operands[0];
  return { $mergeObjects: operands };
}

function generateComputedKeyObject(entries: KeyValueEntry[], ctx: GenerateCtx): unknown {
  const pairs = entries.map((entry) => {
    const key = entry.key.kind === "static" ? entry.key.name : _generate(entry.key.expr, ctx);
    return [key, _generate(entry.value, ctx)];
  });
  return { $arrayToObject: pairs };
}

/**
 * Used for object-style operator args, where the keys must literally appear in MQL output
 * (e.g. `{ input, find, replacement }` for `$replaceOne`). Computed keys are rejected here —
 * MongoDB operator key names are part of the operator's wire format and can't be runtime values.
 */
function generateStaticObjectEntries(
  entries: ObjectEntry[],
  ctx: GenerateCtx,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.type === "SpreadElement") {
      throw new CodegenError("Spread elements in objects are not supported in MQL output");
    }
    if (entry.key.kind === "computed") {
      throw new CodegenError(
        "Computed object keys are not allowed here — operator argument keys must be literal names",
      );
    }
    result[entry.key.name] = _generate(entry.value, ctx);
  }
  return result;
}

// ── Operator calls ────────────────────────────────────────────────────────────

function generateOperatorCall(
  name: string,
  style: "positional" | "object",
  args: CallArg[],
  ctx: GenerateCtx,
): Record<string, unknown> {
  if (style === "object") {
    const objArg = args[0];
    if (!objArg || objArg.type !== "ObjectLiteral") {
      throw new CodegenError(`Object-style call to ${name} must have exactly one object argument`);
    }
    const def = lookupOperator(name);
    // For operators that genuinely expect a named-key object (e.g. $trim, $dateAdd),
    // the keys must be literal names — they are part of the MQL wire format.
    // For any other operator (or unknown), the object is just a value, so computed
    // keys and any other normal object behaviour applies.
    if (def?.shape.kind === "object") {
      return { [name]: generateStaticObjectEntries(objArg.entries, ctx) };
    }
    return { [name]: generateObjectLiteral(objArg.entries, ctx) };
  }

  // Special case: $let(varsObj, lambda) — lambda defines the "in" body
  if (name === "$let" && args.length === 2 && args[1]?.type === "Lambda") {
    const varsExpr = args[0];
    if (!varsExpr || varsExpr.type !== "ObjectLiteral") {
      throw new CodegenError("$let first argument must be an object literal");
    }
    const lambdaExpr = args[1];
    if (lambdaExpr.type !== "Lambda")
      throw new CodegenError("$let second argument must be a lambda");
    const vars = generateStaticObjectEntries(varsExpr.entries, ctx);
    const bodyCtx = extendCtx(ctx, lambdaExpr.params);
    return { $let: { vars, in: _generate(lambdaExpr.body, bodyCtx) } };
  }

  const def = lookupOperator(name);

  if (!def) {
    return generateUnknownOperator(name, args, ctx);
  }

  const { shape } = def;

  switch (shape.kind) {
    case "none": {
      assertNoSpread(args, name);
      return { [name]: {} };
    }

    case "single": {
      assertNoSpread(args, name);
      if (args.length !== 1) {
        throw new CodegenError(`Operator ${name} expects exactly 1 argument, got ${args.length}`);
      }
      return { [name]: _generate(args[0] as Expr, ctx) };
    }

    case "array": {
      if (args.length === 0) {
        throw new CodegenError(`Operator ${name} expects at least 1 argument`);
      }
      return { [name]: generateVariadicArgs(args, ctx) };
    }

    case "flex": {
      // Flex: 1 arg → `{ $op: expr }`, 2+ → `{ $op: [a, b, ...] }`.
      // A single spread (`...arr`) collapses to the single form, passing the array through.
      if (args.length === 0) {
        throw new CodegenError(`Operator ${name} expects at least 1 argument`);
      }
      if (args.length === 1) {
        const only = args[0];
        if (only.type === "SpreadElement") {
          return { [name]: _generate(only.argument, ctx) };
        }
        return { [name]: _generate(only, ctx) };
      }
      return { [name]: generateVariadicArgs(args, ctx) };
    }

    case "object": {
      assertNoSpread(args, name);
      if (args.length === 0) {
        throw new CodegenError(`Operator ${name} expects at least 1 argument`);
      }
      const keys = shape.keys;
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < args.length; i++) {
        const key = keys[i];
        if (!key) {
          throw new CodegenError(
            `Operator ${name} received more positional arguments than expected (max ${keys.length})`,
          );
        }
        obj[key] = _generate(args[i] as Expr, ctx);
      }
      return { [name]: obj };
    }
  }
}

function generateUnknownOperator(
  name: string,
  args: CallArg[],
  ctx: GenerateCtx,
): Record<string, unknown> {
  if (args.length === 0) {
    return { [name]: {} };
  }
  if (args.length === 1) {
    const only = args[0];
    if (only.type === "SpreadElement") {
      // Single ...arr passes the spread argument through directly as the operator value.
      return { [name]: _generate(only.argument, ctx) };
    }
    if (only.type === "ObjectLiteral") {
      return { [name]: generateStaticObjectEntries(only.entries, ctx) };
    }
    return { [name]: _generate(only, ctx) };
  }
  return { [name]: generateVariadicArgs(args, ctx) };
}

/**
 * Generate a variadic argument list, handling spread via concatArrays.
 *
 *   - all-non-spread args → a flat array
 *   - single spread arg → the spread's value (which is presumed to be an array)
 *   - mixed → `{ $concatArrays: [...wrapped] }`, where non-spread args become single-element arrays
 *     and spread args are passed through as their array value.
 */
function generateVariadicArgs(args: CallArg[], ctx: GenerateCtx): unknown {
  const hasSpread = args.some((a) => a.type === "SpreadElement");
  if (!hasSpread) {
    return args.map((a) => _generate(a as Expr, ctx));
  }
  if (args.length === 1) {
    const only = args[0] as SpreadElement;
    return _generate(only.argument, ctx);
  }
  const parts = args.map((a) =>
    a.type === "SpreadElement" ? _generate(a.argument, ctx) : [_generate(a, ctx)],
  );
  return { $concatArrays: parts };
}

function assertNoSpread(args: CallArg[], name: string): void {
  for (const a of args) {
    if (a.type === "SpreadElement") {
      throw new CodegenError(
        `Spread (...) is not supported as an argument to ${name} — only variadic operators accept it`,
      );
    }
  }
}

// ── Template literals ─────────────────────────────────────────────────────────

/**
 * Compile a template literal to `$concat`. Empty quasis and adjacent expressions are
 * still emitted as literal strings to keep the structure faithful — MongoDB will see
 * exactly the chunks the user wrote.
 *
 * `\`hello, ${name}!\`` → `{ $concat: ["hello, ", expr_for_name, "!"] }`
 *
 * Non-string interpolations are wrapped with `$toString` to match JS semantics —
 * `\`count: ${$.n}\`` works whether `$.n` is a number or a string. Expressions that
 * are statically known to produce strings skip the wrap to keep output compact.
 *
 * Special case: a template with no expressions and a single quasi just returns that
 * string (so `\`hi\`` ≡ `"hi"`).
 */
function generateTemplateLiteral(quasis: string[], expressions: Expr[], ctx: GenerateCtx): unknown {
  if (expressions.length === 0) {
    return quasis[0] ?? "";
  }
  const parts: unknown[] = [];
  for (let i = 0; i < expressions.length; i++) {
    if (quasis[i] !== "") parts.push(quasis[i]);
    const gen = _generate(expressions[i], ctx);
    parts.push(isStringProducing(expressions[i]) ? gen : { $toString: gen });
  }
  const tail = quasis[expressions.length];
  if (tail !== "") parts.push(tail);
  return { $concat: parts };
}

// ── Method calls ──────────────────────────────────────────────────────────────

function generateMethodCall(
  object: Expr,
  method: string,
  args: CallArg[],
  ctx: GenerateCtx,
): unknown {
  // ── Set receiver: new Set(arr).intersection / union / difference / ... ─────
  if (object.type === "NewSet") {
    return generateSetMethodCall(object, method, args, ctx);
  }
  // ── Regex receiver: /pat/flags.test(str) / .exec(str) ──────────────────────
  if (object.type === "RegexLiteral") {
    return generateRegexMethodCall(object, method, args, ctx);
  }

  const genObj = _generate(object, ctx);

  switch (method) {
    // ── String methods ──────────────────────────────────────────────────────
    case "trim":
      return { $trim: { input: genObj } };
    case "trimStart":
    case "trimLeft":
      return { $ltrim: { input: genObj } };
    case "trimEnd":
    case "trimRight":
      return { $rtrim: { input: genObj } };
    case "toLowerCase":
      return { $toLower: genObj };
    case "toUpperCase":
      return { $toUpper: genObj };
    case "substr": {
      const exprArgs = exprArgsOnly(args, "substr");
      if (exprArgs.length === 1) {
        return { $substrCP: [genObj, _generate(exprArgs[0], ctx), { $strLenCP: genObj }] };
      }
      if (exprArgs.length === 2) {
        return { $substrCP: [genObj, _generate(exprArgs[0], ctx), _generate(exprArgs[1], ctx)] };
      }
      throw new CodegenError(`.substr() requires 1 or 2 arguments (start[, count])`);
    }
    case "charAt": {
      const exprArgs = exprArgsOnly(args, "charAt");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.charAt() requires exactly 1 argument`);
      }
      return { $substrCP: [genObj, _generate(exprArgs[0], ctx), 1] };
    }
    case "split": {
      const exprArgs = exprArgsOnly(args, "split");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.split() requires exactly 1 argument (separator)`);
      }
      return { $split: [genObj, _generate(exprArgs[0], ctx)] };
    }
    case "startsWith": {
      const exprArgs = exprArgsOnly(args, "startsWith");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.startsWith() requires exactly 1 argument`);
      }
      return { $eq: [{ $indexOfCP: [genObj, _generate(exprArgs[0], ctx)] }, 0] };
    }
    case "endsWith": {
      const exprArgs = exprArgsOnly(args, "endsWith");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.endsWith() requires exactly 1 argument`);
      }
      const needle = _generate(exprArgs[0], ctx);
      // Compares the last N codepoints of the input with the needle, where N is the needle's length.
      return {
        $eq: [
          {
            $substrCP: [
              genObj,
              { $subtract: [{ $strLenCP: genObj }, { $strLenCP: needle }] },
              { $strLenCP: needle },
            ],
          },
          needle,
        ],
      };
    }
    case "indexOf": {
      const exprArgs = exprArgsOnly(args, "indexOf");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.indexOf() requires exactly 1 argument`);
      }
      const needle = _generate(exprArgs[0], ctx);
      // Type-aware dispatch: known array → $indexOfArray; known string → $indexOfCP;
      // unknown → runtime $cond on $isArray so the right form runs at query time.
      if (isArrayProducing(object)) {
        return { $indexOfArray: [genObj, needle] };
      }
      if (isStringProducing(object)) {
        return { $indexOfCP: [genObj, needle] };
      }
      return {
        $cond: [
          { $isArray: genObj },
          { $indexOfArray: [genObj, needle] },
          { $indexOfCP: [genObj, needle] },
        ],
      };
    }
    case "replace": {
      const exprArgs = exprArgsOnly(args, "replace");
      if (exprArgs.length !== 2) {
        throw new CodegenError(`.replace() requires exactly 2 arguments (find, replacement)`);
      }
      return {
        $replaceOne: {
          input: genObj,
          find: _generate(exprArgs[0], ctx),
          replacement: _generate(exprArgs[1], ctx),
        },
      };
    }
    case "replaceAll": {
      const exprArgs = exprArgsOnly(args, "replaceAll");
      if (exprArgs.length !== 2) {
        throw new CodegenError(`.replaceAll() requires exactly 2 arguments (find, replacement)`);
      }
      return {
        $replaceAll: {
          input: genObj,
          find: _generate(exprArgs[0], ctx),
          replacement: _generate(exprArgs[1], ctx),
        },
      };
    }
    case "includes": {
      const exprArgs = exprArgsOnly(args, "includes");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.includes() requires exactly 1 argument`);
      }
      const needle = _generate(exprArgs[0], ctx);
      // Type-aware dispatch: known array → $in; known string → $indexOfCP form;
      // unknown → runtime $cond so a bare $.field works for either type.
      if (isArrayProducing(object)) {
        return { $in: [needle, genObj] };
      }
      if (isStringProducing(object)) {
        return { $gte: [{ $indexOfCP: [genObj, needle] }, 0] };
      }
      return {
        $cond: [
          { $isArray: genObj },
          { $in: [needle, genObj] },
          { $gte: [{ $indexOfCP: [genObj, needle] }, 0] },
        ],
      };
    }
    case "match": {
      const exprArgs = exprArgsOnly(args, "match");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.match() requires exactly 1 argument`);
      }
      const pattern = exprArgs[0];
      if (pattern.type === "RegexLiteral") {
        const result: Record<string, unknown> = { input: genObj, regex: pattern.pattern };
        if (pattern.flags) result["options"] = pattern.flags;
        return { $regexMatch: result };
      }
      return { $regexMatch: { input: genObj, regex: _generate(pattern, ctx) } };
    }
    case "matchAll": {
      const exprArgs = exprArgsOnly(args, "matchAll");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.matchAll() requires exactly 1 argument (regex)`);
      }
      const pattern = exprArgs[0];
      if (pattern.type === "RegexLiteral") {
        if (!pattern.flags.includes("g")) {
          throw new CodegenError(
            `.matchAll() requires a regex with the 'g' flag (matching JS's TypeError on non-global regex)`,
          );
        }
        const result: Record<string, unknown> = { input: genObj, regex: pattern.pattern };
        if (pattern.flags) result["options"] = pattern.flags;
        return { $regexFindAll: result };
      }
      return { $regexFindAll: { input: genObj, regex: _generate(pattern, ctx) } };
    }
    case "search": {
      const exprArgs = exprArgsOnly(args, "search");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.search() requires exactly 1 argument (regex)`);
      }
      const pattern = exprArgs[0];
      // .search returns the index of the first match, or -1. $regexFind returns
      // an object with .idx for matches; null on no match. We surface .idx with
      // an $ifNull fallback to -1 to match JS semantics exactly.
      const findCall =
        pattern.type === "RegexLiteral"
          ? {
              $regexFind: pattern.flags
                ? { input: genObj, regex: pattern.pattern, options: pattern.flags }
                : { input: genObj, regex: pattern.pattern },
            }
          : { $regexFind: { input: genObj, regex: _generate(pattern, ctx) } };
      return { $ifNull: [{ $getField: { field: "idx", input: findCall } }, -1] };
    }
    case "padStart":
    case "padEnd": {
      const exprArgs = exprArgsOnly(args, method);
      if (exprArgs.length < 1 || exprArgs.length > 2) {
        throw new CodegenError(`.${method}() takes 1 or 2 arguments (targetLength[, padString])`);
      }
      const target = _generate(exprArgs[0], ctx);
      const pad = exprArgs.length === 2 ? _generate(exprArgs[1], ctx) : " ";
      // If str length >= target, return str. Otherwise build pad-str of (target - len)
      // chars by reducing $range, then concat str on the appropriate side.
      const padReduce = {
        $reduce: {
          input: { $range: [0, { $subtract: [target, { $strLenCP: "$$s" }] }] },
          initialValue: "",
          in: { $concat: ["$$value", pad] },
        },
      };
      const concatOrder = method === "padStart" ? [padReduce, "$$s"] : ["$$s", padReduce];
      return {
        $let: {
          vars: { s: genObj },
          in: {
            $cond: [{ $gte: [{ $strLenCP: "$$s" }, target] }, "$$s", { $concat: concatOrder }],
          },
        },
      };
    }
    case "repeat": {
      const exprArgs = exprArgsOnly(args, "repeat");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.repeat() requires exactly 1 argument (count)`);
      }
      const count = _generate(exprArgs[0], ctx);
      return {
        $reduce: {
          input: { $range: [0, count] },
          initialValue: "",
          in: { $concat: ["$$value", genObj] },
        },
      };
    }

    // ── Array methods (no lambda) ───────────────────────────────────────────
    case "at": {
      const exprArgs = exprArgsOnly(args, "at");
      if (exprArgs.length !== 1) {
        throw new CodegenError(`.at() requires exactly 1 argument`);
      }
      return { $arrayElemAt: [genObj, _generate(exprArgs[0], ctx)] };
    }
    case "slice": {
      const exprArgs = exprArgsOnly(args, "slice");
      if (exprArgs.length === 1) {
        return { $slice: [genObj, _generate(exprArgs[0], ctx)] };
      }
      if (exprArgs.length === 2) {
        return { $slice: [genObj, _generate(exprArgs[0], ctx), _generate(exprArgs[1], ctx)] };
      }
      throw new CodegenError(`.slice() requires 1 or 2 arguments`);
    }
    case "reverse":
    case "toReversed": {
      if (args.length !== 0) {
        throw new CodegenError(`.${method}() takes no arguments`);
      }
      return { $reverseArray: genObj };
    }
    case "toSorted": {
      if (args.length !== 0) {
        throw new CodegenError(
          `.toSorted() with a comparator is not supported — use $op($sortArray, { input, sortBy }) for custom sort criteria.`,
        );
      }
      return { $sortArray: { input: genObj, sortBy: 1 } };
    }
    case "findLast": {
      const lambda = requireLambda(exprArgsOnly(args, "findLast"), "findLast");
      const bodyCtx = extendCtx(ctx, lambda.params);
      return {
        $arrayElemAt: [
          {
            $filter: {
              input: genObj,
              as: lambda.params[0],
              cond: _generate(lambda.body, bodyCtx),
            },
          },
          -1,
        ],
      };
    }
    case "findLastIndex": {
      const lambda = requireLambda(exprArgsOnly(args, "findLastIndex"), "findLastIndex");
      const bodyCtx = extendCtx(ctx, lambda.params);
      const param = lambda.params[0];
      // Reduce over [(index, element), ...] pairs, keeping the largest index where
      // the predicate matches. $let rebinds the user-named param to $$this[1] so the
      // predicate body's $$<param> references resolve correctly.
      return {
        $reduce: {
          input: {
            $zip: { inputs: [{ $range: [0, { $size: genObj }] }, genObj] },
          },
          initialValue: -1,
          in: {
            $let: {
              vars: { [param]: { $arrayElemAt: ["$$this", 1] } },
              in: {
                $cond: [
                  _generate(lambda.body, bodyCtx),
                  { $arrayElemAt: ["$$this", 0] },
                  "$$value",
                ],
              },
            },
          },
        },
      };
    }
    case "concat": {
      // Type-aware: known array → $concatArrays; known string → $concat;
      // unknown → runtime $cond on $isArray so the right form runs at query time.
      if (args.length === 0) {
        throw new CodegenError(`.concat() requires at least 1 argument`);
      }
      const tail = args.map((a) =>
        a.type === "SpreadElement" ? _generate(a.argument, ctx) : _generate(a, ctx),
      );
      if (isArrayProducing(object)) {
        return { $concatArrays: [genObj, ...tail] };
      }
      if (isStringProducing(object)) {
        return { $concat: [genObj, ...tail] };
      }
      return {
        $cond: [
          { $isArray: genObj },
          { $concatArrays: [genObj, ...tail] },
          { $concat: [genObj, ...tail] },
        ],
      };
    }
    case "join": {
      const exprArgs = exprArgsOnly(args, "join");
      if (exprArgs.length > 1) {
        throw new CodegenError(`.join() takes 0 or 1 arguments`);
      }
      const sep = exprArgs.length === 1 ? _generate(exprArgs[0], ctx) : ",";
      // Reduce: concatenate elements with the separator, omitting it for the first element.
      // The accumulator carries the running string; an empty start lets us detect "first".
      return {
        $reduce: {
          input: genObj,
          initialValue: "",
          in: {
            $cond: [
              { $eq: ["$$value", ""] },
              { $toString: "$$this" },
              { $concat: ["$$value", sep, { $toString: "$$this" }] },
            ],
          },
        },
      };
    }
    case "flat": {
      const exprArgs = exprArgsOnly(args, "flat");
      if (exprArgs.length > 1) {
        throw new CodegenError(`.flat() takes 0 or 1 arguments`);
      }
      // We only support depth=1 (default). MongoDB has no recursive-depth flatten;
      // emulating arbitrary depths would require unbounded $reduce nesting.
      if (exprArgs.length === 1) {
        const arg = exprArgs[0];
        if (arg.type !== "NumberLiteral" || arg.value !== 1) {
          throw new CodegenError(
            `.flat() only supports depth=1 (the default). MongoDB has no recursive flatten primitive.`,
          );
        }
      }
      return {
        $reduce: {
          input: genObj,
          initialValue: [],
          in: { $concatArrays: ["$$value", "$$this"] },
        },
      };
    }
    case "flatMap": {
      const lambda = requireLambda(exprArgsOnly(args, "flatMap"), "flatMap");
      const bodyCtx = extendCtx(ctx, lambda.params);
      return {
        $reduce: {
          input: {
            $map: {
              input: genObj,
              as: lambda.params[0],
              in: _generate(lambda.body, bodyCtx),
            },
          },
          initialValue: [],
          in: { $concatArrays: ["$$value", "$$this"] },
        },
      };
    }

    // ── Array methods (lambda) ──────────────────────────────────────────────
    case "map": {
      const lambda = requireLambda(exprArgsOnly(args, "map"), "map");
      const bodyCtx = extendCtx(ctx, lambda.params);
      return {
        $map: {
          input: genObj,
          as: lambda.params[0],
          in: _generate(lambda.body, bodyCtx),
        },
      };
    }
    case "filter": {
      const lambda = requireLambda(exprArgsOnly(args, "filter"), "filter");
      const bodyCtx = extendCtx(ctx, lambda.params);
      return {
        $filter: {
          input: genObj,
          as: lambda.params[0],
          cond: _generate(lambda.body, bodyCtx),
        },
      };
    }
    case "find": {
      const lambda = requireLambda(exprArgsOnly(args, "find"), "find");
      const bodyCtx = extendCtx(ctx, lambda.params);
      return {
        $arrayElemAt: [
          {
            $filter: {
              input: genObj,
              as: lambda.params[0],
              cond: _generate(lambda.body, bodyCtx),
            },
          },
          0,
        ],
      };
    }
    case "some": {
      const lambda = requireLambda(exprArgsOnly(args, "some"), "some");
      const bodyCtx = extendCtx(ctx, lambda.params);
      return {
        $anyElementTrue: {
          $map: {
            input: genObj,
            as: lambda.params[0],
            in: _generate(lambda.body, bodyCtx),
          },
        },
      };
    }
    case "every": {
      const lambda = requireLambda(exprArgsOnly(args, "every"), "every");
      const bodyCtx = extendCtx(ctx, lambda.params);
      return {
        $allElementsTrue: {
          $map: {
            input: genObj,
            as: lambda.params[0],
            in: _generate(lambda.body, bodyCtx),
          },
        },
      };
    }
    case "reduce": {
      const exprArgs = exprArgsOnly(args, "reduce");
      if (exprArgs.length !== 2) {
        throw new CodegenError(`.reduce() requires exactly 2 arguments (lambda, initialValue)`);
      }
      const lambda = requireLambda(exprArgs, "reduce");
      if (lambda.params.length !== 2) {
        throw new CodegenError(
          `.reduce() lambda must have exactly 2 parameters (accumulator, element)`,
        );
      }
      const reduceCtx: GenerateCtx = {
        lambdaParams: new Set([...ctx.lambdaParams, ...lambda.params]),
        reduceRemap: new Map([
          [lambda.params[0], "value"],
          [lambda.params[1], "this"],
        ]),
      };
      return {
        $reduce: {
          input: genObj,
          initialValue: _generate(exprArgs[1], ctx),
          in: _generate(lambda.body, reduceCtx),
        },
      };
    }

    // ── Date methods ────────────────────────────────────────────────────────
    case "getFullYear":
      return { $year: genObj };
    case "getMonth":
      // 0-based: MongoDB $month is 1-based
      return { $subtract: [{ $month: genObj }, 1] };
    case "getDate":
      return { $dayOfMonth: genObj };
    case "getDay":
      // 0-based: MongoDB $dayOfWeek is 1-based (Sunday=1)
      return { $subtract: [{ $dayOfWeek: genObj }, 1] };
    case "getHours":
      return { $hour: genObj };
    case "getMinutes":
      return { $minute: genObj };
    case "getSeconds":
      return { $second: genObj };
    case "getMilliseconds":
      return { $millisecond: genObj };
    case "getTime":
      // Match JS: ms since epoch
      return { $toLong: genObj };
    case "toISOString":
      return { $dateToString: { date: genObj, format: "%Y-%m-%dT%H:%M:%S.%LZ" } };

    default: {
      const suggestion = closestNameTo(method, KNOWN_METHODS);
      const hint = suggestion ? ` Did you mean '.${suggestion}()'?` : "";
      throw new CodegenError(`Unknown method '.${method}()'.${hint}`);
    }
  }
}

// Every method name with a dedicated case in generateMethodCall, used to power
// "did you mean?" suggestions on unknown methods. Kept here rather than next to
// the switch so adding a new method is a one-line edit at the call site plus
// one entry here — clearer than scanning a 1000-line function for case labels.
const KNOWN_METHODS: ReadonlySet<string> = new Set([
  // String
  "trim",
  "trimStart",
  "trimLeft",
  "trimEnd",
  "trimRight",
  "toLowerCase",
  "toUpperCase",
  "substr",
  "charAt",
  "split",
  "startsWith",
  "endsWith",
  "indexOf",
  "replace",
  "replaceAll",
  "includes",
  "match",
  "matchAll",
  "search",
  "padStart",
  "padEnd",
  "repeat",
  // Array
  "at",
  "slice",
  "reverse",
  "toReversed",
  "toSorted",
  "concat",
  "join",
  "flat",
  "flatMap",
  "map",
  "filter",
  "find",
  "findLast",
  "findLastIndex",
  "some",
  "every",
  "reduce",
  // Date
  "getFullYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getSeconds",
  "getMilliseconds",
  "getTime",
  "toISOString",
  // Set (intercepted before this dispatcher when receiver is a NewSet, but
  // listed so a typo on a non-NewSet receiver still surfaces a useful suggestion)
  "intersection",
  "union",
  "difference",
  "isSubsetOf",
  "isSupersetOf",
  // Regex (intercepted on RegexLiteral receivers; same rationale)
  "test",
  "exec",
]);

/**
 * Most methods can't take spread args — only variadic ones (concat). This helper
 * unwraps a CallArg list to a plain Expr list and rejects spreads with a clear error.
 */
function exprArgsOnly(args: CallArg[], method: string): Expr[] {
  return args.map((a) => {
    if (a.type === "SpreadElement") {
      throw new CodegenError(`Spread (...) is not supported as an argument to .${method}()`);
    }
    return a;
  });
}

function requireLambda(
  args: Expr[],
  method: string,
): { type: "Lambda"; params: string[]; body: Expr } {
  const first = args[0];
  // Bare type-cast callback: `.filter(Boolean)` desugars to `.filter(v => Boolean(v))`.
  if (first?.type === "TypeCastRef") {
    return {
      type: "Lambda",
      params: ["v"],
      body: { type: "TypeCast", cast: first.cast, arg: { type: "ParamRef", name: "v" } },
    };
  }
  if (!first || first.type !== "Lambda") {
    throw new CodegenError(`.${method}() requires a lambda as its first argument, e.g. x => x > 0`);
  }
  return first;
}

// ── Call expressions (IIFE → $let) ────────────────────────────────────────────

/**
 * The only supported call form is an IIFE — a call whose callee is a lambda literal:
 *
 *   ((x, y) => $.a + x * y)(2, 3)
 *   → { $let: { vars: { x: 2, y: 3 }, in: { $add: ["$a", { $multiply: ["$$x", 3] }] } } }
 *
 * Other callees (e.g. a field reference followed by `(...)`) are not callable in MQL —
 * we reject them with an error pointing at the supported forms.
 */
function generateCallExpression(callee: Expr, args: CallArg[], ctx: GenerateCtx): unknown {
  if (callee.type !== "Lambda") {
    throw new CodegenError(
      `Direct call '(...)(args)' is only supported when the callee is an arrow function (IIFE → $let). For named operators use $opName(...); for methods use receiver.method(...).`,
    );
  }
  if (callee.params.length !== args.length) {
    throw new CodegenError(
      `IIFE: expected ${callee.params.length} argument(s) for params (${callee.params.join(", ")}), got ${args.length}`,
    );
  }
  const vars: Record<string, unknown> = {};
  for (let i = 0; i < callee.params.length; i++) {
    const a = args[i];
    if (a.type === "SpreadElement") {
      throw new CodegenError(
        `IIFE: spread arguments are not supported (use $op($let, ...) instead)`,
      );
    }
    vars[callee.params[i]] = _generate(a, ctx);
  }
  const bodyCtx = extendCtx(ctx, callee.params);
  return { $let: { vars, in: _generate(callee.body, bodyCtx) } };
}

// ── Type casts ────────────────────────────────────────────────────────────────

function generateTypeCast(cast: TypeCastOp, arg: Expr, ctx: GenerateCtx): unknown {
  const val = _generate(arg, ctx);
  switch (cast) {
    case "Number":
    case "parseFloat":
      return { $toDouble: val };
    case "String":
      return { $toString: val };
    case "Boolean":
      return { $toBool: val };
    case "parseInt":
      return { $toInt: val };
  }
}

// ── Math ──────────────────────────────────────────────────────────────────────

function generateMathConst(name: MathConstant): number {
  switch (name) {
    case "PI":
      return Math.PI;
    case "E":
      return Math.E;
  }
}

function generateMathCall(method: MathMethod, args: CallArg[], ctx: GenerateCtx): unknown {
  switch (method) {
    case "abs":
      return { $abs: oneArg(method, args, ctx) };
    case "ceil":
      return { $ceil: oneArg(method, args, ctx) };
    case "floor":
      return { $floor: oneArg(method, args, ctx) };
    case "round":
      return { $round: [oneArg(method, args, ctx), 0] };
    case "sqrt":
      return { $sqrt: oneArg(method, args, ctx) };
    case "exp":
      return { $exp: oneArg(method, args, ctx) };
    case "log":
      // Math.log is natural log → $ln
      return { $ln: oneArg(method, args, ctx) };
    case "log2":
      return { $log: [oneArg(method, args, ctx), 2] };
    case "log10":
      return { $log10: oneArg(method, args, ctx) };
    case "trunc":
      return { $trunc: oneArg(method, args, ctx) };
    case "sign":
      // JS returns -1 / 0 / 1 for negative / zero / positive — same as $cmp(x, 0)
      return { $cmp: [oneArg(method, args, ctx), 0] };
    case "cbrt":
      return { $pow: [oneArg(method, args, ctx), { $divide: [1, 3] }] };
    case "pow": {
      const exprArgs = exprArgsOnly(args, "pow");
      if (exprArgs.length !== 2) {
        throw new CodegenError(`Math.pow() requires exactly 2 arguments`);
      }
      return { $pow: [_generate(exprArgs[0], ctx), _generate(exprArgs[1], ctx)] };
    }
    case "min":
    case "max": {
      // Variadic: accept (a, b, c, ...) OR a single array OR ...spread
      if (args.length === 0) {
        throw new CodegenError(`Math.${method}() requires at least 1 argument`);
      }
      const op = method === "min" ? "$min" : "$max";
      // Single non-spread arg → pass through (Mongo $min/$max accept either a value or an array)
      if (args.length === 1 && args[0].type !== "SpreadElement") {
        return { [op]: _generate(args[0], ctx) };
      }
      return { [op]: generateVariadicArgs(args, ctx) };
    }
    case "hypot": {
      const exprArgs = exprArgsOnly(args, "hypot");
      if (exprArgs.length === 0) {
        throw new CodegenError(`Math.hypot() requires at least 1 argument`);
      }
      const squares = exprArgs.map((a) => ({ $pow: [_generate(a, ctx), 2] }));
      return { $sqrt: { $add: squares } };
    }
    case "random":
      if (args.length !== 0) {
        throw new CodegenError(`Math.random() takes no arguments`);
      }
      return { $rand: {} };
    case "sin":
      return { $sin: oneArg(method, args, ctx) };
    case "cos":
      return { $cos: oneArg(method, args, ctx) };
    case "tan":
      return { $tan: oneArg(method, args, ctx) };
    case "asin":
      return { $asin: oneArg(method, args, ctx) };
    case "acos":
      return { $acos: oneArg(method, args, ctx) };
    case "atan":
      return { $atan: oneArg(method, args, ctx) };
    case "atan2": {
      const exprArgs = exprArgsOnly(args, "atan2");
      if (exprArgs.length !== 2) {
        throw new CodegenError(`Math.atan2() requires exactly 2 arguments (y, x)`);
      }
      return { $atan2: [_generate(exprArgs[0], ctx), _generate(exprArgs[1], ctx)] };
    }
    case "sinh":
      return { $sinh: oneArg(method, args, ctx) };
    case "cosh":
      return { $cosh: oneArg(method, args, ctx) };
    case "tanh":
      return { $tanh: oneArg(method, args, ctx) };
    case "asinh":
      return { $asinh: oneArg(method, args, ctx) };
    case "acosh":
      return { $acosh: oneArg(method, args, ctx) };
    case "atanh":
      return { $atanh: oneArg(method, args, ctx) };
  }
}

function oneArg(method: MathMethod, args: CallArg[], ctx: GenerateCtx): unknown {
  const exprArgs = exprArgsOnly(args, method);
  if (exprArgs.length !== 1) {
    throw new CodegenError(`Math.${method}() requires exactly 1 argument`);
  }
  return _generate(exprArgs[0], ctx);
}

// ── Object calls ──────────────────────────────────────────────────────────────

function generateObjectCall(method: ObjectMethod, args: CallArg[], ctx: GenerateCtx): unknown {
  switch (method) {
    case "keys": {
      const exprArgs = exprArgsOnly(args, "Object.keys");
      if (exprArgs.length !== 1)
        throw new CodegenError(`Object.keys() requires exactly 1 argument`);
      return {
        $map: {
          input: { $objectToArray: _generate(exprArgs[0], ctx) },
          as: "kv",
          in: "$$kv.k",
        },
      };
    }
    case "values": {
      const exprArgs = exprArgsOnly(args, "Object.values");
      if (exprArgs.length !== 1)
        throw new CodegenError(`Object.values() requires exactly 1 argument`);
      return {
        $map: {
          input: { $objectToArray: _generate(exprArgs[0], ctx) },
          as: "kv",
          in: "$$kv.v",
        },
      };
    }
    case "entries": {
      const exprArgs = exprArgsOnly(args, "Object.entries");
      if (exprArgs.length !== 1)
        throw new CodegenError(`Object.entries() requires exactly 1 argument`);
      return { $objectToArray: _generate(exprArgs[0], ctx) };
    }
    case "fromEntries": {
      const exprArgs = exprArgsOnly(args, "Object.fromEntries");
      if (exprArgs.length !== 1)
        throw new CodegenError(`Object.fromEntries() requires exactly 1 argument`);
      return { $arrayToObject: _generate(exprArgs[0], ctx) };
    }
    case "assign": {
      if (args.length < 1) throw new CodegenError(`Object.assign() requires at least 1 argument`);
      return { $mergeObjects: generateVariadicArgs(args, ctx) };
    }
    case "groupBy": {
      const exprArgs = exprArgsOnly(args, "Object.groupBy");
      if (exprArgs.length !== 2) {
        throw new CodegenError(`Object.groupBy() requires exactly 2 arguments (items, x => key)`);
      }
      const input = exprArgs[0];
      const lambda = exprArgs[1];
      if (lambda.type !== "Lambda" || lambda.params.length !== 1) {
        throw new CodegenError(
          `Object.groupBy() requires a single-parameter arrow function as the discriminator`,
        );
      }
      // Reduce over the input. For each element, compute the discriminator key with the
      // user's lambda param bound to $$this. Use $let to materialise the key once, then
      // append the current element to the array under that key in the accumulator.
      const keyCtx: GenerateCtx = {
        lambdaParams: new Set([...ctx.lambdaParams, lambda.params[0]]),
        reduceRemap: new Map([[lambda.params[0], "this"]]),
      };
      const keyBody = _generate(lambda.body, keyCtx);
      const keyExpr = isStringProducing(lambda.body) ? keyBody : { $toString: keyBody };
      return {
        $reduce: {
          input: _generate(input, ctx),
          initialValue: {},
          in: {
            $let: {
              vars: { key: keyExpr },
              in: {
                $mergeObjects: [
                  "$$value",
                  {
                    $arrayToObject: [
                      [
                        [
                          "$$key",
                          {
                            $concatArrays: [
                              {
                                $ifNull: [{ $getField: { field: "$$key", input: "$$value" } }, []],
                              },
                              ["$$this"],
                            ],
                          },
                        ],
                      ],
                    ],
                  },
                ],
              },
            },
          },
        },
      };
    }
  }
}

// ── Array.from ────────────────────────────────────────────────────────────────

/**
 * `Array.from({length: n}, (_, i) => f(i))` — the only supported form. Other
 * Array.from invocations are rejected because MQL has no general iterable-to-array
 * primitive. Compiles to `$map($range(0, n), (i) => body)` where the lambda's first
 * (element) parameter is bound to null via $let, matching JS's `Array.from({length}, ...)`
 * semantics where the element is always undefined.
 */
function generateArrayFrom(input: Expr, mapFn: Expr | null, ctx: GenerateCtx): unknown {
  if (input.type !== "ObjectLiteral") {
    throw new CodegenError(
      `Array.from() only supports the {length: n} form: Array.from({length: n}, (_, i) => …). For other inputs use $op($range, …) or .map().`,
    );
  }
  if (input.entries.length !== 1) {
    throw new CodegenError(`Array.from({length: n}) — exactly one 'length' entry is required`);
  }
  const entry = input.entries[0];
  if (
    entry.type !== "KeyValueEntry" ||
    entry.key.kind !== "static" ||
    entry.key.name !== "length"
  ) {
    throw new CodegenError(`Array.from() only supports {length: n}; saw a different object shape`);
  }
  const lengthExpr = _generate(entry.value, ctx);
  if (mapFn === null) {
    return { $range: [0, lengthExpr] };
  }
  if (mapFn.type !== "Lambda") {
    throw new CodegenError(
      `Array.from() second argument must be an arrow function (e.g. (_, i) => i * 2)`,
    );
  }
  if (mapFn.params.length !== 2) {
    throw new CodegenError(
      `Array.from() map function must take 2 parameters (element, index) — element is always null in the {length} form`,
    );
  }
  const [elemParam, idxParam] = mapFn.params;
  const bodyCtx = extendCtx(ctx, mapFn.params);
  return {
    $map: {
      input: { $range: [0, lengthExpr] },
      as: idxParam,
      in: { $let: { vars: { [elemParam]: null }, in: _generate(mapFn.body, bodyCtx) } },
    },
  };
}

// ── Number.* static predicates ────────────────────────────────────────────────

function generateNumberStatic(
  method: "isInteger" | "isNaN" | "isFinite",
  arg: Expr,
  ctx: GenerateCtx,
): unknown {
  const val = _generate(arg, ctx);
  switch (method) {
    case "isInteger":
      // BSON has separate int/long/decimal/double types. Match JS: any numeric
      // value with no fractional part is an integer. Long and int are always
      // integers; double/decimal are integers iff trunc(x) === x.
      return {
        $cond: [
          { $in: [{ $type: val }, ["int", "long"]] },
          true,
          {
            $cond: [
              { $in: [{ $type: val }, ["double", "decimal"]] },
              { $eq: [val, { $trunc: val }] },
              false,
            ],
          },
        ],
      };
    case "isNaN":
      // NaN is the only IEEE 754 value where x !== x.
      return { $ne: [val, val] };
    case "isFinite":
      throw new CodegenError(
        `Number.isFinite() is not supported — MQL has no Infinity literal. Use a domain-specific bound check (e.g. $.x > -1e300 && $.x < 1e300) or $convert with onError to detect non-finite values.`,
      );
  }
}

// ── Set method calls (ES2025) ─────────────────────────────────────────────────

/**
 * `new Set(a).intersection(new Set(b))` → `{ $setIntersection: [a, b] }`. The wrapper
 * is a JS-syntax tag for "this is a set"; codegen unwraps it on both receiver and
 * argument. MQL has no Set type — these compile to set operators on plain arrays.
 */
function generateSetMethodCall(
  receiver: { type: "NewSet"; arg: Expr | null },
  method: string,
  args: CallArg[],
  ctx: GenerateCtx,
): unknown {
  const lhs = receiver.arg ? _generate(receiver.arg, ctx) : [];
  const exprArgs = exprArgsOnly(args, `Set.${method}`);
  const requireSetArg = (): unknown => {
    if (exprArgs.length !== 1) {
      throw new CodegenError(`Set.${method}() requires exactly 1 argument`);
    }
    const arg = exprArgs[0];
    if (arg.type !== "NewSet") {
      throw new CodegenError(
        `Set.${method}()'s argument must be a 'new Set(...)' expression, not a plain value`,
      );
    }
    return arg.arg ? _generate(arg.arg, ctx) : [];
  };
  switch (method) {
    case "intersection":
      return { $setIntersection: [lhs, requireSetArg()] };
    case "union":
      return { $setUnion: [lhs, requireSetArg()] };
    case "difference":
      return { $setDifference: [lhs, requireSetArg()] };
    case "isSubsetOf":
      return { $setIsSubset: [lhs, requireSetArg()] };
    case "isSupersetOf":
      // A is a superset of B ⇔ B is a subset of A
      return { $setIsSubset: [requireSetArg(), lhs] };
    case "symmetricDifference":
    case "isDisjointFrom":
      throw new CodegenError(
        `Set.${method}() has no MongoDB equivalent — compose via $setDifference / $setIntersection / $setUnion as needed`,
      );
    default:
      throw new CodegenError(
        `Unknown Set method '.${method}()'. Supported: intersection, union, difference, isSubsetOf, isSupersetOf`,
      );
  }
}

// ── Regex method calls ────────────────────────────────────────────────────────

/**
 * `/pat/flags.test(str)` → `$regexMatch`; `/pat/flags.exec(str)` → `$regexFind`.
 * The regex literal supplies the pattern and flags; the str is the input.
 */
function generateRegexMethodCall(
  regex: { type: "RegexLiteral"; pattern: string; flags: string },
  method: string,
  args: CallArg[],
  ctx: GenerateCtx,
): unknown {
  const exprArgs = exprArgsOnly(args, `regex.${method}`);
  if (exprArgs.length !== 1) {
    throw new CodegenError(`regex.${method}() requires exactly 1 argument (input string)`);
  }
  const input = _generate(exprArgs[0], ctx);
  const opName = method === "test" ? "$regexMatch" : method === "exec" ? "$regexFind" : null;
  if (!opName) {
    throw new CodegenError(
      `Unknown regex method '.${method}()'. Supported: regex.test(str), regex.exec(str)`,
    );
  }
  const obj: Record<string, unknown> = { input, regex: regex.pattern };
  if (regex.flags) obj["options"] = regex.flags;
  return { [opName]: obj };
}

// ── Mutation codegen ──────────────────────────────────────────────────────────

/**
 * Compile a top-level `MutationProgram` to either a single stage object (if
 * everything coalesces into one $set/$unset) or an array of stage objects.
 *
 * The shape mirrors `mjsql()`'s existing top-level convention: one stage →
 * bare object, multiple stages → array.
 */
export function generateMutationProgram(prog: MutationProgram): object | object[] {
  if (prog.mutations.length === 0) {
    throw new CodegenError("Mutation program must contain at least one assignment or delete");
  }
  const groups = groupMutations(prog.mutations);
  const stages = groups.map((g) => generateMutationGroup(g));
  if (stages.length === 1) return stages[0];
  return stages;
}

/**
 * Coalescer used by both mjsql() top-level mutations and by pipeline.ts when
 * mutations appear as pipeline elements. Returns one or more stage objects.
 *
 * Grouping rule (preserves JS sequential semantics):
 *   - Consecutive same-kind (assign/delete) mutations join one group, UNLESS
 *   - A new mutation's write path collides (equals or is a parent/child) with
 *     any prior write in the group, OR
 *   - For assignments: the new RHS reads any path that was written earlier in
 *     the group. (Delete has no reads.)
 */
export function generateMutationGroups(muts: Mutation[]): object[] {
  const groups = groupMutations(muts);
  return groups.map((g) => generateMutationGroup(g));
}

function groupMutations(muts: Mutation[]): Mutation[][] {
  const groups: Mutation[][] = [];
  let current: Mutation[] = [];
  let writes = new Set<string>();
  let kind: "assign" | "delete" | null = null;

  for (const m of muts) {
    const myKind: "assign" | "delete" = m.type === "AssignExpr" ? "assign" : "delete";
    const writePath = mutationWritePath(m);
    const reads = m.type === "AssignExpr" ? collectMutationReads(m.value) : null;

    let mustBreak = false;
    if (kind !== null && kind !== myKind) {
      mustBreak = true;
    }
    if (!mustBreak) {
      for (const w of writes) {
        if (pathsCollide(w, writePath)) {
          mustBreak = true;
          break;
        }
      }
    }
    if (!mustBreak && reads !== null) {
      for (const r of reads) {
        for (const w of writes) {
          if (pathsCollide(w, r)) {
            mustBreak = true;
            break;
          }
        }
        if (mustBreak) break;
      }
    }

    if (mustBreak && current.length > 0) {
      groups.push(current);
      current = [];
      writes = new Set();
    }
    current.push(m);
    writes.add(writePath);
    kind = myKind;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function generateMutationGroup(group: Mutation[]): object {
  if (group.length === 0) {
    throw new CodegenError("Internal: empty mutation group");
  }
  if (group[0].type === "AssignExpr") {
    const fields: Record<string, unknown> = {};
    for (const m of group) {
      if (m.type !== "AssignExpr") {
        throw new CodegenError("Internal: mixed-kind mutation group");
      }
      const path = mutationWritePath(m);
      if (Object.prototype.hasOwnProperty.call(fields, path)) {
        throw new CodegenError(`Internal: field '${path}' written twice in same group`);
      }
      fields[path] = generate(m.value);
    }
    return { $set: fields };
  }
  // Delete group
  const paths: string[] = [];
  for (const m of group) {
    if (m.type !== "DeleteStmt") {
      throw new CodegenError("Internal: mixed-kind mutation group");
    }
    paths.push(mutationWritePath(m));
  }
  // MongoDB pipeline `$unset` accepts a single string OR an array of strings.
  // Use the more compact string form for size 1 to match handwritten output.
  return paths.length === 1 ? { $unset: paths[0] } : { $unset: paths };
}

/** Reconstruct the dotted write path from a mutation target. */
export function mutationWritePath(m: Mutation): string {
  return targetToPath(m.target);
}

function targetToPath(target: Expr): string {
  if (target.type === "FieldRef") return target.path;
  if (target.type === "MemberAccess") {
    return `${targetToPath(target.object)}.${target.member}`;
  }
  throw new CodegenError(
    "Internal: mutation target is not a field path (parser should have rejected)",
  );
}

/**
 * Collect dotted field-path reads from an expression. Used by the coalescer
 * to detect read-after-write conflicts within a $set group. Lambda-local
 * params are intentionally not recorded — they reference iteration values,
 * not document fields.
 */
function collectMutationReads(expr: Expr): Set<string> {
  const out = new Set<string>();
  collectReadsInto(expr, out);
  return out;
}

function collectReadsInto(expr: Expr, out: Set<string>): void {
  // Foldable field path (`$.a`, `$.a.b.c`) — record as a single dotted entry.
  const path = tryFieldPath(expr);
  if (path !== null) {
    out.add(path);
    return;
  }
  switch (expr.type) {
    case "FieldRef":
      out.add(expr.path);
      return;
    case "NumberLiteral":
    case "BigIntLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
    case "RegexLiteral":
    case "ParamRef":
    case "MathConst":
    case "DateNow":
    case "TypeCastRef":
      return;
    case "ArrayLiteral":
      for (const el of expr.elements) {
        if (el.type === "SpreadElement") collectReadsInto(el.argument, out);
        else if (el.type === "AssignExpr" || el.type === "DeleteStmt") {
          // mutations inside expressions are rejected elsewhere; ignore here
        } else collectReadsInto(el, out);
      }
      return;
    case "ObjectLiteral":
      for (const e of expr.entries) {
        if (e.type === "SpreadElement") {
          collectReadsInto(e.argument, out);
        } else {
          if (e.key.kind === "computed") collectReadsInto(e.key.expr, out);
          collectReadsInto(e.value, out);
        }
      }
      return;
    case "TemplateLiteral":
      for (const e of expr.expressions) collectReadsInto(e, out);
      return;
    case "BinaryExpr":
      collectReadsInto(expr.left, out);
      collectReadsInto(expr.right, out);
      return;
    case "UnaryExpr":
      collectReadsInto(expr.operand, out);
      return;
    case "TernaryExpr":
      collectReadsInto(expr.condition, out);
      collectReadsInto(expr.consequent, out);
      collectReadsInto(expr.alternate, out);
      return;
    case "IndexAccess":
      collectReadsInto(expr.object, out);
      collectReadsInto(expr.index, out);
      return;
    case "MemberAccess":
      collectReadsInto(expr.object, out);
      return;
    case "MethodCall":
      collectReadsInto(expr.object, out);
      collectArgsInto(expr.args, out);
      return;
    case "CallExpression":
      collectReadsInto(expr.callee, out);
      collectArgsInto(expr.args, out);
      return;
    case "Lambda":
      collectReadsInto(expr.body, out);
      return;
    case "TypeofExpr":
      collectReadsInto(expr.operand, out);
      return;
    case "NewDate":
    case "NewSet":
      if (expr.arg) collectReadsInto(expr.arg, out);
      return;
    case "TypeCast":
      collectReadsInto(expr.arg, out);
      return;
    case "MathCall":
    case "ObjectCall":
      collectArgsInto(expr.args, out);
      return;
    case "ArrayFrom":
      collectReadsInto(expr.input, out);
      if (expr.mapFn) collectReadsInto(expr.mapFn, out);
      return;
    case "NumberStatic":
      collectReadsInto(expr.arg, out);
      return;
    case "OperatorCall":
      collectArgsInto(expr.args, out);
      return;
  }
}

function collectArgsInto(args: CallArg[], out: Set<string>): void {
  for (const a of args) {
    if (a.type === "SpreadElement") collectReadsInto(a.argument, out);
    else collectReadsInto(a, out);
  }
}

function tryFieldPath(expr: Expr): string | null {
  if (expr.type === "FieldRef") return expr.path;
  if (expr.type === "MemberAccess") {
    const base = tryFieldPath(expr.object);
    if (base !== null) return `${base}.${expr.member}`;
  }
  return null;
}

/**
 * Two paths "collide" when one is the same as, or a strict ancestor of, the
 * other. `a` and `a` collide; `a` and `a.b` collide; `a` and `b` do not.
 * Used by the mutation coalescer to detect conflicts that force a stage
 * boundary.
 */
function pathsCollide(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < b.length && b.startsWith(a) && b.charCodeAt(a.length) === 0x2e /* . */) {
    return true;
  }
  if (b.length < a.length && a.startsWith(b) && a.charCodeAt(b.length) === 0x2e /* . */) {
    return true;
  }
  return false;
}
