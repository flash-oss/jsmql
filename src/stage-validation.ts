// Per-stage body validation.
//
// Catches stage-body violations the MongoDB server always rejects, regardless
// of data or deployment — wrong literal types, out-of-range literal numbers,
// bad enum values, missing required keys, mutually-exclusive keys, malformed
// literal arrays, illegal field-name formats. The structural *placement* rules
// (must-be-first / must-be-last / forbidden-in-sub-pipeline) live in
// pipeline.ts; this module owns the *shape* of a single stage body.
//
// THE LITERAL-GATING INVARIANT: every check inspects only fully-static literal
// shapes. The moment the checked slot holds a field reference, an expression, an
// operator call, a template literal, a computed key, or a spread, the check is a
// no-op and the MQL is emitted unchanged. We never throw on a value we cannot
// statically pin down — a *probable* violation must still compile (rule #2).
// This is how comprehensive coverage coexists with "only 100%-certain throws".
//
// THE CONSTANT-ONLY-SLOT EXCEPTION (HR3): a handful of slots MUST hold a
// compile-time constant — `$limit`/`$skip`/`$sample.size`/`$bucketAuto.buckets`/
// `$graphLookup.maxDepth` (a constant integer) and `$bucket.boundaries`/
// `$lookup.pipeline` (a constant array). There, a field reference / runtime
// expression is itself a 100%-certain violation (the server rejects `{ $limit:
// "$n" }`, `{ $lookup: { pipeline: "$x" } }`, …), so the gate is INVERTED: a
// non-constant throws. A compile-bound param (`ParamRef`) is allowed — it inlines
// to a literal value at codegen, so it may well be a valid constant.
//
// Validators see only USER-written stage bodies: sugar-generated stages
// ($lookup from `$$$.coll.find`, $unionWith from `$$.push`, …) build their
// objects directly and never pass through `generateStageBody`.
//
// See docs/specs/pipeline-validation.md.

import type { Expr } from "./ast.ts";
import { CodegenError } from "./codegen.ts";
import { closestNameTo } from "./levenshtein.ts";

// ── Literal-inspection helpers (the gate) ───────────────────────────────────────

/** The numeric value of `e` IF it is a literal number (incl. a unary `-` on one), else null. */
function litNumber(e: Expr): number | null {
  if (e.type === "NumberLiteral") return e.value;
  if (e.type === "UnaryExpr" && e.op === "-" && e.operand.type === "NumberLiteral") return -e.operand.value;
  return null;
}

/** The string value of `e` IF it is a literal string, else null. */
function litString(e: Expr): string | null {
  return e.type === "StringLiteral" ? e.value : null;
}

/** The boolean value of `e` IF it is a literal boolean, else null. */
function litBool(e: Expr): boolean | null {
  return e.type === "BooleanLiteral" ? e.value : null;
}

/**
 * A human description IF `e` is a fully-static literal (scalar / array / object /
 * regex), else null — null means "a non-literal expression we can't judge".
 * Note: a negative number literal is a `UnaryExpr`, so it is NOT described here;
 * use `litNumber` for numeric slots.
 */
function describeLiteral(e: Expr): string | null {
  switch (e.type) {
    case "NumberLiteral":
      return "a number";
    case "BigIntLiteral":
      return "a bigint";
    case "StringLiteral":
      return "a string";
    case "BooleanLiteral":
      return "a boolean";
    case "NullLiteral":
      return "null";
    case "ArrayLiteral":
      return "an array";
    case "ObjectLiteral":
      return "an object";
    case "RegexLiteral":
      return "a regular expression";
    default:
      return null;
  }
}

type ObjectInfo = { byKey: Map<string, Expr>; hasSpread: boolean };

/**
 * Static view of an object-literal body: its static keys → value, plus whether
 * a spread is present. Returns null when `e` is not an object literal OR has a
 * computed key — in both cases we can't reason statically, so callers no-op.
 */
function objectInfo(e: Expr): ObjectInfo | null {
  if (e.type !== "ObjectLiteral") return null;
  const byKey = new Map<string, Expr>();
  let hasSpread = false;
  for (const entry of e.entries) {
    if (entry.type === "SpreadElement") {
      hasSpread = true;
      continue;
    }
    if (entry.key.kind !== "static") return null;
    byKey.set(entry.key.name, entry.value);
  }
  return { byKey, hasSpread };
}

/** Literal elements of an array literal, or null if `e` isn't an array literal. */
function arrayElements(e: Expr): Expr[] | null {
  if (e.type !== "ArrayLiteral") return null;
  const out: Expr[] = [];
  for (const el of e.elements) {
    // A spread / assignment inside the array → not a plain value list; bail.
    if (el.type === "SpreadElement" || el.type === "AssignExpr" || el.type === "DeleteStmt" || el.type === "LetDecl") {
      return null;
    }
    out.push(el);
  }
  return out;
}

// ── Shared check helpers ────────────────────────────────────────────────────────

/** Require `keys` to be present on an object-literal body (skips if a spread hides them). */
function requireKeys(stage: string, info: ObjectInfo, bodyPos: number, keys: readonly string[]): void {
  if (info.hasSpread) return;
  for (const k of keys) {
    if (!info.byKey.has(k)) {
      throw new CodegenError(`'${stage}' requires the '${k}' field, but it is missing.`, bodyPos);
    }
  }
}

/**
 * Open an object-body validator: return the body's key map, or `null` when the
 * body isn't an inspectable object literal (validation is best-effort — a field
 * path or runtime expression in body position is left for MongoDB to check), in
 * which case the caller `return`s. Any `required` keys are enforced up front.
 * Folds the `objectInfo` + null-gate + `requireKeys` prelude that opens most
 * object-shaped stage validators into one call.
 */
function requireObjectBody(stage: string, body: Expr, required: readonly string[] = []): ObjectInfo | null {
  const info = objectInfo(body);
  if (info === null) return null;
  requireKeys(stage, info, body.pos, required);
  return info;
}

/** Throw if a literal-string slot value is outside the allowed enum (with a "Did you mean"). */
function checkEnum(stage: string, field: string, value: Expr, allowed: readonly string[]): void {
  const s = litString(value);
  if (s === null || allowed.includes(s)) return;
  const near = closestNameTo(s, allowed);
  const hint = near !== null ? ` Did you mean '${near}'?` : "";
  throw new CodegenError(`'${stage}' ${field} must be one of: ${allowed.join(", ")} — got '${s}'.${hint}`, value.pos);
}

/**
 * A compile-bound param (`ParamRef`) inlines to a literal value at codegen, so a
 * constant-only slot can't statically rule it out. Everything else that isn't a
 * literal — a field ref or a runtime expression — is a certain violation.
 */
function nonConstantDesc(e: Expr): string {
  return e.type === "FieldRef" ? "a field reference" : "a runtime expression";
}

/** Reject a non-constant in a slot the server requires to be a constant array (e.g. `$lookup.pipeline`). */
function requireConstantArray(label: string, value: Expr): void {
  if (value.type === "ArrayLiteral" || value.type === "ParamRef") return;
  const desc = describeLiteral(value);
  throw new CodegenError(
    `'${label}' must be a constant array — got ${desc ?? nonConstantDesc(value)}, ` +
      `which the server can't accept here. Use a literal array.`,
    value.pos,
  );
}

/** Throw if a numeric slot holds a definitely-wrong literal (non-number, non-integer, or out of bound). */
function checkIntBound(stage: string, body: Expr, opts: { min: number; label: string }): void {
  const n = litNumber(body);
  if (n === null) {
    const desc = describeLiteral(body);
    // A literal of a clearly-wrong type (string/array/object/…) throws.
    if (desc !== null) {
      throw new CodegenError(`'${stage}' expects an integer, but got ${desc}.`, body.pos);
    }
    // HR3 constant-only-slot exception: the server requires a constant integer
    // here, so a field ref / runtime expression is a certain violation. A param
    // inlines to a value, so it's allowed.
    if (body.type !== "ParamRef") {
      throw new CodegenError(
        `'${stage}' must be ${opts.label} and a compile-time constant — got ${nonConstantDesc(body)}, ` +
          `which the server can't accept here. Use a literal value.`,
        body.pos,
      );
    }
    return;
  }
  if (!Number.isInteger(n)) {
    throw new CodegenError(`'${stage}' must be an integer, but got ${n}.`, body.pos);
  }
  if (n < opts.min) {
    throw new CodegenError(`'${stage}' must be ${opts.label}, but got ${n}.`, body.pos);
  }
}

/** Reject a literal-scalar new-root (a document is required). */
function rejectNonDocumentNewRoot(stage: string, value: Expr): void {
  const desc = describeLiteral(value);
  // A literal object is a valid document; everything else literal is not.
  if (desc !== null && value.type !== "ObjectLiteral") {
    // A `$`-prefixed string is a field path (e.g. `$replaceWith("$subdoc")`)
    // that resolves to a document at runtime — allow it, same as the field-ref
    // form `$replaceWith($.subdoc)`. Only non-`$` literals (plain strings,
    // numbers, booleans) can never be a document.
    if (value.type === "StringLiteral" && value.value.startsWith("$")) return;
    throw new CodegenError(
      `'${stage}' must resolve to a document, but got ${desc}. ` + `Wrap it, e.g. '{ value: … }'.`,
      value.pos,
    );
  }
}

// ── $match query-operator placement ─────────────────────────────────────────────
//
// A raw `$match` object body passes through verbatim, so query operators are
// reachable. Some have positional / availability rules the server enforces:
//   - `$text` may only appear in a `$match` that is the pipeline's FIRST stage.
//   - `$near` / `$nearSphere` / `$where` are not allowed in an aggregation
//     `$match` at all (use `$geoNear` / `$geoWithin` / `$expr` instead).
// We walk the (static) match body for these keys, recursing through nested
// field-value objects and `$and`/`$or`/`$nor` arrays.

const MATCH_DISALLOWED: Record<string, string> = {
  $near: "use the '$geoNear' stage (it must be the first stage), or '$geoWithin' with '$center'/'$centerSphere'",
  $nearSphere: "use the '$geoNear' stage (it must be the first stage), or '$geoWithin' with '$centerSphere'",
  $where: "use '$expr' with a query expression (or '$function' for server-side JS)",
};

/** First occurrence of any `names` key in a (static) `$match` body, recursing into objects/arrays. */
function findMatchOperator(body: Expr, names: ReadonlySet<string>): { name: string; pos: number } | null {
  if (body.type === "ObjectLiteral") {
    for (const entry of body.entries) {
      if (entry.type !== "KeyValueEntry") continue;
      if (entry.key.kind === "static" && names.has(entry.key.name)) {
        return { name: entry.key.name, pos: entry.pos };
      }
      const found = findMatchOperator(entry.value, names);
      if (found !== null) return found;
    }
  } else if (body.type === "ArrayLiteral") {
    for (const el of body.elements) {
      if (
        el.type === "SpreadElement" ||
        el.type === "AssignExpr" ||
        el.type === "DeleteStmt" ||
        el.type === "LetDecl"
      ) {
        continue;
      }
      const found = findMatchOperator(el, names);
      if (found !== null) return found;
    }
  }
  return null;
}

const DISALLOWED_SET: ReadonlySet<string> = new Set(Object.keys(MATCH_DISALLOWED));
const TEXT_SET: ReadonlySet<string> = new Set(["$text"]);

/**
 * Enforce `$match` query-operator placement (only meaningful for a raw object
 * body — an expression body can't contain these). `isTopLevel`/`isFirstStage`
 * gate the `$text`-must-be-first rule; the disallowed-operator rule always fires.
 */
export function validateMatchPlacement(body: Expr, opts: { isTopLevel: boolean; isFirstStage: boolean }): void {
  if (body.type !== "ObjectLiteral") return;
  const disallowed = findMatchOperator(body, DISALLOWED_SET);
  if (disallowed !== null) {
    throw new CodegenError(
      `'${disallowed.name}' is not allowed inside an aggregation '$match' — ${MATCH_DISALLOWED[disallowed.name]}.`,
      disallowed.pos,
    );
  }
  if (opts.isTopLevel && !opts.isFirstStage) {
    const text = findMatchOperator(body, TEXT_SET);
    if (text !== null) {
      throw new CodegenError(
        `A '$match' that uses '$text' must be the first stage in a pipeline. Move it to the front.`,
        text.pos,
      );
    }
  }
}

// ── Per-stage validators ────────────────────────────────────────────────────────

const MERGE_WHEN_MATCHED = ["replace", "keepExisting", "merge", "fail"] as const;
const MERGE_WHEN_NOT_MATCHED = ["insert", "discard", "fail"] as const;
const FILL_METHODS = ["linear", "locf"] as const;
const BUCKET_AUTO_GRANULARITY = [
  "R5",
  "R10",
  "R20",
  "R40",
  "R80",
  "1-2-5",
  "E6",
  "E12",
  "E24",
  "E48",
  "E96",
  "E192",
  "POWERSOF2",
] as const;

function validateCount(body: Expr): void {
  const s = litString(body);
  if (s === null) {
    const desc = describeLiteral(body);
    if (desc !== null) throw new CodegenError(`'$count' expects a field-name string, but got ${desc}.`, body.pos);
    return;
  }
  if (s.length === 0) throw new CodegenError(`'$count' field name must be a non-empty string.`, body.pos);
  if (s.startsWith("$")) throw new CodegenError(`'$count' field name cannot start with '$' (got '${s}').`, body.pos);
  if (s.includes(".")) throw new CodegenError(`'$count' field name cannot contain '.' (got '${s}').`, body.pos);
}

function validateSort(body: Expr): void {
  const info = requireObjectBody("$sort", body);
  if (info === null) return;
  if (info.byKey.size > 32 && !info.hasSpread) {
    throw new CodegenError(`'$sort' accepts at most 32 keys, but got ${info.byKey.size}.`, body.pos);
  }
  for (const [key, value] of info.byKey) {
    const n = litNumber(value);
    if (n !== null && n !== 1 && n !== -1) {
      throw new CodegenError(
        `'$sort' direction for '${key}' must be 1 (ascending) or -1 (descending), but got ${n}.`,
        value.pos,
      );
    }
    // SQL habit: `$sort({ createdAt: "desc" })` / `{ x: true }`. A literal
    // string/bool direction is always wrong (the server takes only 1 / -1, or a
    // `{ $meta: … }` object — which is not a literal, so it slips past the gate).
    const str = litString(value);
    const bool = litBool(value);
    if (str !== null || bool !== null) {
      const got = str !== null ? `'${str}'` : String(bool);
      throw new CodegenError(
        `'$sort' direction for '${key}' must be 1 (ascending) or -1 (descending), but got ${got}.`,
        value.pos,
      );
    }
  }
}

function validateProject(body: Expr): void {
  const info = requireObjectBody("$project", body);
  if (info === null) return;
  if (info.byKey.size === 0 && !info.hasSpread) {
    throw new CodegenError(`'$project' specification must name at least one field.`, body.pos);
  }
  let includeKey: string | null = null;
  let excludeKey: string | null = null;
  for (const [key, value] of info.byKey) {
    if (key === "_id") continue; // _id may be excluded in an inclusion projection
    const n = litNumber(value);
    const b = litBool(value);
    if (n === 0 || b === false) excludeKey = key;
    else if (n === 1 || b === true) includeKey = key;
  }
  if (includeKey !== null && excludeKey !== null) {
    throw new CodegenError(
      `'$project' cannot mix field inclusion ('${includeKey}: 1') and exclusion ('${excludeKey}: 0') — ` +
        `only '_id' may be excluded in an inclusion projection. Use one mode: list fields to keep, or fields to drop.`,
      body.pos,
    );
  }
}

function validateUnset(body: Expr): void {
  const s = litString(body);
  if (s !== null) {
    if (s.length === 0) throw new CodegenError(`'$unset' field name must be a non-empty string.`, body.pos);
    return;
  }
  const els = arrayElements(body);
  if (els === null) return;
  if (els.length === 0) throw new CodegenError(`'$unset' field-name array must not be empty.`, body.pos);
  for (const el of els) {
    if (litString(el) === null && describeLiteral(el) !== null) {
      throw new CodegenError(`'$unset' field-name array must contain only strings.`, el.pos);
    }
  }
}

function validateUnwind(body: Expr): void {
  const s = litString(body);
  if (s !== null) {
    if (!s.startsWith("$")) {
      throw new CodegenError(`'$unwind' path must be a field path starting with '$' (got '${s}').`, body.pos);
    }
    return;
  }
  const info = requireObjectBody("$unwind", body);
  if (info === null) return;
  const path = info.byKey.get("path");
  if (path !== undefined) {
    const ps = litString(path);
    if (ps !== null && !ps.startsWith("$")) {
      throw new CodegenError(`'$unwind' path must be a field path starting with '$' (got '${ps}').`, path.pos);
    }
  }
  const idx = info.byKey.get("includeArrayIndex");
  if (idx !== undefined) {
    const is = litString(idx);
    if (is !== null && is.startsWith("$")) {
      throw new CodegenError(`'$unwind' includeArrayIndex name cannot start with '$' (got '${is}').`, idx.pos);
    }
  }
  const preserve = info.byKey.get("preserveNullAndEmptyArrays");
  if (preserve !== undefined && litBool(preserve) === null) {
    const desc = describeLiteral(preserve);
    if (desc !== null) {
      throw new CodegenError(`'$unwind' preserveNullAndEmptyArrays must be a boolean, but got ${desc}.`, preserve.pos);
    }
  }
}

function validateSample(body: Expr): void {
  const info = requireObjectBody("$sample", body, ["size"]);
  if (info === null) return;
  const size = info.byKey.get("size");
  if (size !== undefined) checkIntBound("$sample size", size, { min: 0, label: "a non-negative integer" });
}

function validateBucket(body: Expr): void {
  const info = requireObjectBody("$bucket", body, ["groupBy", "boundaries"]);
  if (info === null) return;
  const boundaries = info.byKey.get("boundaries");
  if (boundaries === undefined) return;
  requireConstantArray("$bucket boundaries", boundaries); // HR3: must be a constant array
  const els = arrayElements(boundaries);
  if (els === null) return;
  if (els.length < 2) {
    throw new CodegenError(`'$bucket' boundaries must list at least 2 values, but got ${els.length}.`, boundaries.pos);
  }
  // Strictly-ascending + same-type checks only for an all-literal numeric or string array.
  const nums = els.map(litNumber);
  if (nums.every((n) => n !== null)) {
    for (let i = 1; i < nums.length; i++) {
      if ((nums[i] as number) <= (nums[i - 1] as number)) {
        throw new CodegenError(
          `'$bucket' boundaries must be in strictly ascending order (${nums[i - 1]} is not < ${nums[i]}).`,
          boundaries.pos,
        );
      }
    }
    return;
  }
  const strs = els.map(litString);
  if (strs.every((s) => s !== null)) {
    for (let i = 1; i < strs.length; i++) {
      if ((strs[i] as string) <= (strs[i - 1] as string)) {
        throw new CodegenError(`'$bucket' boundaries must be in strictly ascending order.`, boundaries.pos);
      }
    }
    return;
  }
  // A mix of literal numbers and literal strings is a type error.
  const allLiteral = els.every((e) => describeLiteral(e) !== null);
  if (allLiteral && (nums.some((n) => n !== null) || strs.some((s) => s !== null))) {
    const mixed = nums.some((n) => n !== null) && strs.some((s) => s !== null);
    if (mixed) {
      throw new CodegenError(`'$bucket' boundaries must all be the same type.`, boundaries.pos);
    }
  }
}

function validateBucketAuto(body: Expr): void {
  const info = requireObjectBody("$bucketAuto", body, ["groupBy", "buckets"]);
  if (info === null) return;
  const buckets = info.byKey.get("buckets");
  if (buckets !== undefined) checkIntBound("$bucketAuto buckets", buckets, { min: 1, label: "a positive integer" });
  const granularity = info.byKey.get("granularity");
  if (granularity !== undefined) checkEnum("$bucketAuto", "granularity", granularity, BUCKET_AUTO_GRANULARITY);
}

function validateSetWindowFields(body: Expr): void {
  const info = requireObjectBody("$setWindowFields", body, ["output"]);
  if (info === null) return;
  const output = info.byKey.get("output");
  if (output === undefined) return;
  const outInfo = objectInfo(output);
  if (outInfo === null) return;
  for (const [, fieldSpec] of outInfo.byKey) {
    const specInfo = objectInfo(fieldSpec);
    if (specInfo === null) continue;
    const window = specInfo.byKey.get("window");
    if (window === undefined) continue;
    const winInfo = objectInfo(window);
    if (winInfo === null) continue;
    if (winInfo.byKey.has("documents") && winInfo.byKey.has("range")) {
      throw new CodegenError(
        `'$setWindowFields' window cannot specify both 'documents' and 'range' — they are mutually exclusive.`,
        window.pos,
      );
    }
  }
}

function validateFill(body: Expr): void {
  const info = requireObjectBody("$fill", body, ["output"]);
  if (info === null) return;
  const output = info.byKey.get("output");
  if (output === undefined) return;
  const outInfo = objectInfo(output);
  if (outInfo === null) return;
  let needsSortBy = false;
  for (const [field, fieldSpec] of outInfo.byKey) {
    const specInfo = objectInfo(fieldSpec);
    if (specInfo === null) continue;
    const hasValue = specInfo.byKey.has("value");
    const method = specInfo.byKey.get("method");
    if (hasValue && method !== undefined) {
      throw new CodegenError(
        `'$fill' output field '${field}' cannot specify both 'value' and 'method' — they are mutually exclusive.`,
        fieldSpec.pos,
      );
    }
    if (method !== undefined) {
      checkEnum("$fill", `output field '${field}' method`, method, FILL_METHODS);
      const ms = litString(method);
      if (ms === "linear" || ms === "locf") needsSortBy = true;
    }
  }
  if (needsSortBy && !info.hasSpread && !info.byKey.has("sortBy")) {
    throw new CodegenError(
      `'$fill' requires 'sortBy' when an output field uses the 'linear' or 'locf' method.`,
      body.pos,
    );
  }
}

function validateGraphLookup(body: Expr): void {
  const info = requireObjectBody("$graphLookup", body, [
    "from",
    "startWith",
    "connectFromField",
    "connectToField",
    "as",
  ]);
  if (info === null) return;
  const maxDepth = info.byKey.get("maxDepth");
  if (maxDepth !== undefined)
    checkIntBound("$graphLookup maxDepth", maxDepth, { min: 0, label: "a non-negative integer" });
}

function validateMerge(body: Expr): void {
  const info = requireObjectBody("$merge", body, ["into"]); // string form ("coll") returns null → fine
  if (info === null) return;
  const whenMatched = info.byKey.get("whenMatched");
  // whenMatched may be a pipeline (array) — only the string form is enum-checked.
  if (whenMatched !== undefined && litString(whenMatched) !== null) {
    checkEnum("$merge", "whenMatched", whenMatched, MERGE_WHEN_MATCHED);
  }
  const whenNotMatched = info.byKey.get("whenNotMatched");
  if (whenNotMatched !== undefined) checkEnum("$merge", "whenNotMatched", whenNotMatched, MERGE_WHEN_NOT_MATCHED);
}

function validateLookup(body: Expr): void {
  const info = requireObjectBody("$lookup", body, ["from", "as"]);
  if (info === null) return;
  const pipeline = info.byKey.get("pipeline");
  // HR3: a `$lookup` pipeline must be a literal array of stage objects — a field
  // ref / expression (`{ pipeline: "$x" }`) is rejected by the server.
  if (pipeline !== undefined) requireConstantArray("$lookup pipeline", pipeline);
}

function validateUnionWith(body: Expr): void {
  const info = requireObjectBody("$unionWith", body); // string form ("coll") returns null → fine
  if (info === null) return;
  if (info.hasSpread) return;
  if (!info.byKey.has("coll") && !info.byKey.has("pipeline")) {
    throw new CodegenError(`'$unionWith' requires a 'coll' and/or a 'pipeline'.`, body.pos);
  }
}

function validateReplaceRoot(body: Expr): void {
  const info = requireObjectBody("$replaceRoot", body, ["newRoot"]);
  if (info === null) return;
  const newRoot = info.byKey.get("newRoot");
  if (newRoot !== undefined) rejectNonDocumentNewRoot("$replaceRoot newRoot", newRoot);
}

function validateGroup(body: Expr): void {
  requireObjectBody("$group", body, ["_id"]);
}

function validateGeoNear(body: Expr): void {
  requireObjectBody("$geoNear", body, ["near"]);
}

function validateDocuments(body: Expr): void {
  if (body.type === "ArrayLiteral") return;
  const desc = describeLiteral(body);
  if (desc !== null) {
    throw new CodegenError(`'$documents' expects an array of documents, but got ${desc}.`, body.pos);
  }
}

type BodyValidator = (body: Expr) => void;

const STAGE_BODY_VALIDATORS: Record<string, BodyValidator> = {
  $limit: (b) => checkIntBound("$limit", b, { min: 1, label: "a positive integer" }),
  $skip: (b) => checkIntBound("$skip", b, { min: 0, label: "a non-negative integer" }),
  $sample: validateSample,
  $count: validateCount,
  $sort: validateSort,
  $project: validateProject,
  $unset: validateUnset,
  $unwind: validateUnwind,
  $bucket: validateBucket,
  $bucketAuto: validateBucketAuto,
  $setWindowFields: validateSetWindowFields,
  $fill: validateFill,
  $group: validateGroup,
  $lookup: validateLookup,
  $unionWith: validateUnionWith,
  $graphLookup: validateGraphLookup,
  $merge: validateMerge,
  $replaceRoot: validateReplaceRoot,
  $replaceWith: (b) => rejectNonDocumentNewRoot("$replaceWith", b),
  $geoNear: validateGeoNear,
  $documents: validateDocuments,
};

/**
 * Validate a stage's body against the 100%-static-certain shape rules. A no-op
 * for stages with no validator, and (per the literal-gating invariant) a no-op
 * whenever the checked slot isn't a fully-static literal — EXCEPT the
 * constant-only slots (`$limit`/`$skip`/`$sample.size`/`$bucket.boundaries`/
 * `$lookup.pipeline`/…), where a non-constant (field ref / expression) is itself
 * a certain violation and throws (see the constant-only-slot exception above).
 */
export function validateStageBody(stageName: string, body: Expr): void {
  const validator = STAGE_BODY_VALIDATORS[stageName];
  if (validator !== undefined) validator(body);
}
