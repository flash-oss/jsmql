#!/usr/bin/env node
/**
 * Generate `src/ops.ts` from the canonical jsmql operator/stage registries
 * (`src/operators.ts`, `src/stages.ts`) and the vendored MongoDB MQL
 * specification YAMLs (`vendor/mql-specifications/definitions/{expression,
 * accumulator,stage}/`).
 *
 * The generated file is a `declare global` ambient module: when imported as
 * `import type "@koresar/jsmql/ops"`, it surfaces every stage and operator as a global
 * function with a precise signature, JSDoc description, version, and link to
 * the MongoDB docs. The runtime path is unchanged — the jsmql parser already
 * recognises bare `$stage(...)` and `$op(...)` calls via the registries; this
 * generator only produces TypeScript types for the user's IDE.
 *
 * Runs as part of `prebuild` and `pretest` (after `vendor/fetch-mql-specs.mjs`)
 * so the emitted file always reflects the pinned spec. The committed
 * `src/ops.ts` is the artifact that ships in the npm package.
 *
 * Drift protection: `test/operator-spec-coverage.test.ts` imports
 * `generateOpsSource()` from this file and asserts the committed `src/ops.ts`
 * is byte-equal to the generator output on every `npm test`.
 *
 * Usage:
 *   node scripts/generate-ops.mjs            # rewrite src/ops.ts and run oxfmt
 *   import { generateOpsSource } from "..."  # for the drift test
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import { OPERATORS } from "../src/operators.ts";
import { STAGES } from "../src/stages.ts";
import { streamMethodNames } from "../src/stream-methods.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SPEC_ROOT = resolve(ROOT, "vendor", "mql-specifications", "definitions");
const OUT_PATH = resolve(ROOT, "src", "ops.ts");

// Sub-constructs that appear in the spec as standalone files but are not
// top-level callable operators (e.g. `$case` is part of `$switch.branches[]`).
// Kept in sync with test/operator-spec-coverage.test.ts.
const SUB_CONSTRUCTS = new Set(["$case"]);

// MQL `timeUnit` enum — used by date operators like $dateAdd, $dateDiff,
// $dateTrunc. Narrowed to a literal union for autocomplete and typo-check.
const TIME_UNIT_LITERAL =
  '"year" | "quarter" | "month" | "week" | "day" | "hour" | "minute" | "second" | "millisecond"';

// Options-object shapes for the diagnostic / system source stages reached via
// the context-ref prefixes (`$$.collStats({...})`, `$$$$.currentOp({...})`, …).
// These field shapes aren't carried by the STAGES registry or the vendored YAML
// in a usable form, and matter only to TS completion, so they live here — keyed
// by stage name. The no-option stages ($indexStats, $planCacheStats,
// $shardedDataDistribution) are absent: they take zero arguments. Field sets
// transcribed from the MongoDB manual (URLs below) — keep in sync when the
// pinned server version changes.
const DIAGNOSTIC_OPTION_SHAPES = {
  // https://www.mongodb.com/docs/manual/reference/operator/aggregation/collStats/
  $collStats:
    "{ latencyStats?: { histograms?: boolean }; storageStats?: { scale?: number }; count?: Record<string, never>; queryExecStats?: Record<string, never> }",
  // https://www.mongodb.com/docs/manual/reference/operator/aggregation/listSearchIndexes/
  $listSearchIndexes: "{ id?: string; name?: string }",
  // https://www.mongodb.com/docs/manual/reference/operator/aggregation/currentOp/
  $currentOp:
    "{ allUsers?: boolean; idleConnections?: boolean; idleCursors?: boolean; idleSessions?: boolean; localOps?: boolean; targetAllNodes?: boolean }",
  // https://www.mongodb.com/docs/manual/reference/operator/aggregation/listSessions/
  $listSessions: "{ users?: { user: string; db: string }[]; allUsers?: boolean }",
  // https://www.mongodb.com/docs/manual/reference/operator/aggregation/listLocalSessions/
  $listLocalSessions: "{ users?: { user: string; db: string }[]; allUsers?: boolean }",
  // https://www.mongodb.com/docs/manual/reference/operator/aggregation/listSampledQueries/
  $listSampledQueries: "{ namespace?: string }",
};

// Context-ref prefixes, in scope order. Each becomes an ambient declaration
// (`var $$` — reassignable via `$$ = …` — plus `const $$$` / `const $$$$`) whose
// named members are the scope's diagnostic stages (derived from the STAGES
// `diagnostic` field) and whose `[key: string]: any` tail keeps the rest of the
// ref's syntax (`$$.push(...)`, `$$$.coll.find(...)`, member access, stream
// methods) type-checking. Trade-off: TS won't flag a typo of a non-diagnostic
// method — the jsmql parser still does. See docs/specs/context-references.md.
const CONTEXT_REFS = {
  collection: {
    name: "$$",
    doc:
      "jsmql current-collection context reference (`$$`, run on `db.coll.aggregate()`). " +
      "Names a collection-scoped diagnostic source stage, or heads collection sugar " +
      "(`$$.push(...)` → `$unionWith`, `$$.filter(...)`, stream methods, `$$ = ...`).",
  },
  database: {
    name: "$$$",
    doc:
      "jsmql current-database context reference (`$$$`, run on `db.aggregate()`). " +
      "Heads cross-collection joins (`$$$.coll.find/filter(...)` → `$lookup`) and " +
      "`$out` writes (`$$$.coll = ...`). Has no diagnostic source stages of its own — " +
      "`$currentOp` & friends run on the admin database, reached via `$$$$`.",
  },
  cluster: {
    name: "$$$$",
    doc:
      "jsmql cluster/server context reference (`$$$$`, run on the admin database). " +
      "Names a cluster-scoped diagnostic source stage, or heads cross-database `$out` writes " +
      "(`$$$$.db.coll = ...`). Cross-database READS aren't supported — MongoDB rejects the " +
      "`{ db, coll }` `$lookup`/`$unionWith` namespace on a regular server; use a same-database " +
      "reference (`$$$.coll`) instead.",
  },
};

// `$$.<method>(...)` completions beyond the diagnostic source stages: the
// chainable / statement-level stream vocabulary on the current collection.
// Names that come from `STREAM_METHODS` (src/stream-methods.ts) are asserted
// against `streamMethodNames()` below so the registry stays the source of truth
// — a new stream method without a signature here is a build-time error.
// `.filter` (special-cased chain head) and `.push` (statement-level `$unionWith`)
// aren't in that registry, so they're listed explicitly. Only the collection
// ref (`$$`) gets these — `$$$` / `$$$$` reach the same methods via member
// access on their permissive `[key: string]: any` tail.
//
// Name of the ambient interface the `$$` collection ref is typed as. Stream
// methods return it (not `any`) so chains keep their completion AND their
// callback params stay contextually typed — `$$.filter(d => …).map(d => …)`
// would otherwise trip `noImplicitAny` on the second lambda once the first call
// collapsed to `any`.
const COLLECTION_REF_TYPE = "JsmqlCollectionRef";

// Each stream method's JSDoc + parameter list. The return type is appended by
// `streamMethodMembers` (always the chainable ref) — kept out of the table so
// the chaining contract lives in one place.
const STREAM_METHOD_SIGNATURES = {
  filter: {
    doc: "Narrow the stream → `$match`. Pass an arrow predicate or a matches-object (`{ field: value }`).",
    params: "(predicate: ((doc: any) => any) | Record<string, any>)",
  },
  map: {
    doc: 'Reshape each document → `$replaceWith`. Pass an arrow or a field name (`"userId"`).',
    params: "(transform: ((doc: any) => any) | string)",
  },
  slice: { doc: "Take a window of the stream → `$skip` / `$limit`.", params: "(start: number, end?: number)" },
  concat: { doc: "Append documents / union collections → `$unionWith`.", params: "(...sources: any[])" },
  toSorted: {
    doc: "Order the stream → `$sort` (equivalent to `.sort` on a stream).",
    params: '(sort: string | string[] | Record<string, 1 | -1 | "asc" | "desc"> | ((a: any, b: any) => number))',
  },
  toReversed: { doc: "Reverse the preceding sort — flips the preceding `$sort`.", params: "()" },
  flatMap: {
    doc: 'Unwind an array field → `$unwind`. Pass an arrow (`d => d.items`) or a field name (`"items"`).',
    params: "(transform: ((doc: any) => any) | string)",
  },
  sample: {
    doc: "One random document → `$sample: { size: 1 }` (lodash `_.sample`; use `.sampleSize(n)` for more).",
    params: "()",
  },
  take: { doc: "First `n` documents → `$limit`.", params: "(n: number)" },
  drop: { doc: "Skip the first `n` documents → `$skip`.", params: "(n: number)" },
  tail: { doc: "All but the first document → `$skip: 1` (lodash `_.tail`).", params: "()" },
  sampleSize: { doc: "`n` random documents → `$sample`.", params: "(n: number)" },
  sort: {
    doc: 'Order the stream → `$sort`. Field name, `[fields]`, `{ field: 1|-1|"asc"|"desc" }`, or a comparator.',
    params: '(sort: string | string[] | Record<string, 1 | -1 | "asc" | "desc"> | ((a: any, b: any) => number))',
  },
  sortBy: { doc: "Ascending sort by a key → `$sort` (lodash `_.sortBy`).", params: "(key: string | string[])" },
  orderBy: {
    doc: "Multi-key sort with per-key directions → `$sort` (lodash `_.orderBy`).",
    params: '(keys: string | string[], orders?: (1 | -1 | "asc" | "desc") | (1 | -1 | "asc" | "desc")[])',
  },
  groupBy: {
    doc: "Group the stream → `$group`. Pass a `$group` body (`{ _id, … }`) or a field name.",
    params: "(spec: string | Record<string, any>)",
  },
  countBy: { doc: "Tally documents per distinct key → `$sortByCount`.", params: "(field: string)" },
  uniqBy: { doc: "One document per distinct key → `$group` + `$replaceWith`.", params: "(field: string)" },
  push: { doc: "Append documents to the stream → `$unionWith`.", params: "(...docs: any[])" },
};

// Emission order for the `$$` stream methods (registry order, then the two
// non-registry entries). Asserts every registered stream method has a signature.
function streamMethodMembers() {
  const registry = streamMethodNames();
  const missing = registry.filter((n) => STREAM_METHOD_SIGNATURES[n] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `generate-ops: stream method(s) ${missing.join(", ")} are in the STREAM_METHODS registry ` +
        `but have no signature in STREAM_METHOD_SIGNATURES. Add one so '$$.<method>()' gets completion.`,
    );
  }
  const order = [...registry, "filter", "push"];
  const members = [];
  for (const name of order) {
    const { doc, params } = STREAM_METHOD_SIGNATURES[name];
    members.push(`/** ${doc} */`);
    members.push(`${name}${params}: ${COLLECTION_REF_TYPE};`);
  }
  return members;
}

// ---------------------------------------------------------------------------
// Spec loading. Mirrors the strategy in test/operator-spec-coverage.test.ts:
// strip the `tests:` block before js-yaml sees it, since the test fixtures
// use custom BSON tags (!bson_int64 etc.) that the default schema rejects.
// ---------------------------------------------------------------------------

const SPEC_FOLDERS = ["expression", "accumulator", "stage"];

/**
 * Loads the vendored YAML specs into per-folder maps. A few names (currently
 * just `$count`) appear in multiple folders with different semantics — stage
 * vs accumulator — so flattening into a single map would lose information.
 *
 * @returns {{ stage: Map<string, any>, expression: Map<string, any>, accumulator: Map<string, any> }}
 */
export function loadSpec() {
  const out = { stage: new Map(), expression: new Map(), accumulator: new Map() };
  if (!existsSync(SPEC_ROOT)) {
    throw new Error(`MQL specs not vendored at ${SPEC_ROOT}. Run: node vendor/fetch-mql-specs.mjs`);
  }
  for (const folder of SPEC_FOLDERS) {
    const dir = resolve(SPEC_ROOT, folder);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".yaml")) continue;
      let txt = readFileSync(resolve(dir, file), "utf8");
      const i = txt.indexOf("\ntests:");
      if (i >= 0) txt = txt.slice(0, i);
      const doc = yaml.load(txt);
      if (doc?.name) out[folder].set(doc.name, doc);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Type mapping. The jsmql body lets users pass `$.field` paths, literals, and
// nested `$op(...)` calls — all `any` from TS's perspective — so most arg
// types stay permissive. We specialise where it adds real DX value: enum-like
// literals (timeUnit, sort direction), pipelines, query objects.
// ---------------------------------------------------------------------------

function mapType(t) {
  if (!t) return "any";
  const types = Array.isArray(t) ? t : [t];
  if (types.includes("timeUnit")) return TIME_UNIT_LITERAL;
  if (types.length === 1) {
    const only = types[0];
    if (only === "string") return "string";
    if (only === "pipeline") return "unknown[]";
    // `query` and `object` could in principle narrow to `Record<string, any>`,
    // but jsmql accepts richer inputs than the MQL spec lets on: `$match`
    // takes a boolean expression that's wrapped in `$expr` at codegen time,
    // not just a query-document literal. Tightening the type would reject
    // the most common usage (`$match($.age >= 18)`). Stay permissive.
    if (only === "query") return "any";
    if (only === "object") return "any";
  }
  return "any";
}

// ---------------------------------------------------------------------------
// JSDoc construction. The description is the value AI tools and IDE hover see,
// so include the full multi-line spec description plus version and doc link.
// ---------------------------------------------------------------------------

function jsdocFor(name, spec, registryDef) {
  const description = (spec?.description ?? registryDef?.description ?? "").trim();
  const lines = [];
  if (description) {
    for (const ln of description.split(/\n/)) {
      lines.push(` * ${ln.trimEnd()}`);
    }
  }
  if (spec?.minVersion) {
    if (lines.length > 0) lines.push(" *");
    lines.push(` * @minVersion ${spec.minVersion}`);
  }
  const link = spec?.link ?? `https://www.mongodb.com/docs/manual/reference/operator/aggregation/${name.slice(1)}/`;
  if (!spec?.minVersion && lines.length > 0) lines.push(" *");
  lines.push(` * @see ${link}`);
  return `/**\n${lines.join("\n")}\n */`;
}

// ---------------------------------------------------------------------------
// Signature builders. Stages and ops have slightly different rules:
//
// Stages: jsmql calls them as `$stage(<one arg>)`. The arg shape comes from
//   the spec's `encode` field — object stages get a typed args record,
//   single-arg stages get a typed positional, etc.
//
// Expression ops: jsmql's `OperatorShape` from src/operators.ts is the
//   authoritative call shape (that's what the parser accepts). The spec
//   supplies arg names, optionality, and types.
// ---------------------------------------------------------------------------

function argsObjectForSpec(spec, registryKeys) {
  const specArgs = spec?.arguments ?? [];
  const byName = new Map(specArgs.map((a) => [a.name, a]));
  const keys = registryKeys ?? specArgs.map((a) => a.name);
  if (keys.length === 0) return "Record<string, never>";
  const lines = ["{"];
  for (const k of keys) {
    const specArg = byName.get(k);
    const optional = specArg?.optional ? "?" : "";
    const type = mapType(specArg?.type);
    const desc = specArg?.description?.trim();
    if (desc) {
      // Collapse multi-line descriptions to a single line for the field JSDoc.
      // The full multi-line description still lives on the function-level
      // JSDoc; per-field is for at-a-glance hover info.
      const one = desc
        .split(/\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" ");
      lines.push(`  /** ${one} */`);
    }
    lines.push(`  ${quoteKeyIfNeeded(k)}${optional}: ${type};`);
  }
  lines.push("}");
  return lines.join("\n");
}

// TypeScript reserved-word object keys (e.g. `default`, `function`) need to be
// quoted in an object type literal even though they're valid property names —
// oxfmt will keep them quoted if we emit them that way. Identifiers stay bare.
const TS_RESERVED_KEYS = new Set([
  "default",
  "function",
  "class",
  "delete",
  "in",
  "if",
  "for",
  "while",
  "do",
  "return",
  "switch",
  "case",
  "break",
  "continue",
  "new",
  "typeof",
  "void",
  "yield",
  "await",
]);
function quoteKeyIfNeeded(k) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)) return JSON.stringify(k);
  // Reserved keys are valid as object-type keys in TS without quoting, but
  // we quote them for clarity and to satisfy stricter parsers.
  if (TS_RESERVED_KEYS.has(k)) return JSON.stringify(k);
  return k;
}

function stageCallableType(spec) {
  const encode = spec?.encode;
  const args = spec?.arguments ?? [];
  if (encode === "none" || args.length === 0) {
    return ["(): any"];
  }
  if (encode === "object") {
    return [`(args: ${argsObjectForSpec(spec, null)}): any`];
  }
  if (encode === "array") {
    const argName = args[0]?.name ?? "items";
    return [`(${argName}: unknown[]): any`];
  }
  // 'single' or no `encode` at all: one positional arg whose type/name we lift
  // from the first spec argument when present.
  const firstArg = args[0];
  const argName = firstArg?.name ?? "arg";
  const argType = mapType(firstArg?.type);
  return [`(${argName}: ${argType}): any`];
}

function expressionOpCallableType(spec, opDef) {
  const shape = opDef.shape.kind;
  const firstArg = spec?.arguments?.[0];

  switch (shape) {
    case "single": {
      const argName = firstArg?.name ?? "expression";
      const argType = mapType(firstArg?.type);
      // YAML may flag a single-shape op as variadic — surface as rest args.
      if (firstArg?.variadic === "array") {
        return [`(...${argName}: ${argType}[]): any`];
      }
      return [`(${argName}: ${argType}): any`];
    }
    case "array": {
      // jsmql 'array' shape means N positional args in jsmql, even though MQL
      // serialises them as an array. From the user's POV inside jsmql, it's
      // `$op(a, b, c)`, not `$op([a, b, c])`.
      const argName = firstArg?.name ?? "expressions";
      const argType = mapType(firstArg?.type);
      return [`(...${argName}: ${argType}[]): any`];
    }
    case "object": {
      const argsObj = argsObjectForSpec(spec, opDef.shape.keys);
      return [`(args: ${argsObj}): any`];
    }
    case "none": {
      return ["(): any"];
    }
    case "flex": {
      // Two call shapes — single expression OR N positional args.
      const argName = firstArg?.name ?? "expression";
      const argType = mapType(firstArg?.type);
      return [`(${argName}: ${argType}): any`, `(...${argName}s: ${argType}[]): any`];
    }
    default: {
      // Defensive — should be unreachable; OperatorShape is a closed union.
      return ["(...args: any[]): any"];
    }
  }
}

function emitFunctionDecls(name, callableSigs) {
  // Emit one `function` declaration per call signature inside `declare
  // global`. TypeScript merges identically-named function declarations as
  // overloads, so a `flex`-shape op naturally surfaces with both call shapes.
  return callableSigs.map((sig) => `function ${name}${sig.replace(/^\(/, "(")};`).join("\n");
}

// ---------------------------------------------------------------------------
// Top-level generation.
// ---------------------------------------------------------------------------

function emitBlock(name, jsdoc, callableSigs) {
  return `${jsdoc}\n${emitFunctionDecls(name, callableSigs)}`;
}

// Emit the `$$` / `$$$` / `$$$$` ambient declarations (`$$` is `var` — it is
// reassigned by `$$ = …`; the other two are `const`, only their members are
// written). Diagnostic methods are
// derived from the STAGES `diagnostic` field (the single source of truth, also
// read by src/system-stage-translation.ts); each method reuses the same JSDoc
// the stage's own block gets, so descriptions stay consistent.
function contextRefBlock(spec) {
  const methodsByScope = { collection: [], database: [], cluster: [] };
  for (const [stageName, def] of Object.entries(STAGES)) {
    if (def.diagnostic === undefined) continue;
    methodsByScope[def.diagnostic.scope].push(stageName);
  }

  const blocks = [];
  for (const scope of ["collection", "database", "cluster"]) {
    const ref = CONTEXT_REFS[scope];
    const members = [];
    for (const stageName of methodsByScope[scope].sort()) {
      const def = STAGES[stageName];
      const method = stageName.slice(1);
      const sig = def.diagnostic.options
        ? `${method}(options?: ${DIAGNOSTIC_OPTION_SHAPES[stageName]}): any;`
        : `${method}(): any;`;
      members.push(jsdocFor(stageName, spec.stage.get(stageName), def));
      members.push(sig);
    }
    // The collection ref also carries the stream vocabulary (`$$.filter(...)`,
    // `$$.map(...)`, …) as typed members so they get completion; the other scopes
    // reach their methods via member access on the permissive tail.
    if (scope === "collection") {
      members.push(...streamMethodMembers());
    }
    // The permissive tail — keeps every non-diagnostic ref form type-checking.
    members.push("[key: string]: any;");
    const refJsdoc = `/**\n * ${ref.doc}\n *\n * @see https://github.com/koresar/jsmql/blob/master/docs/specs/context-references.md\n */`;
    // The collection ref is emitted as a named interface so its stream methods
    // can return it (chaining), and as `var` (not `const`) because `$$` is
    // reassigned wholesale by the `$$ = …` replace-stream / `$facet` sugar —
    // `declare const $$` would make TS reject that valid jsmql. The other two
    // refs stay inline anonymous `const`s: they only ever take *property* writes
    // (`$$$.coll = …`, `$$$$.db.coll = …` → `$out`), which `const` already
    // permits, while still flagging the invalid `$$$ = …` whole-reassignment.
    if (scope === "collection") {
      blocks.push(
        `interface ${COLLECTION_REF_TYPE} {\n${members.join("\n")}\n}\n${refJsdoc}\nvar ${ref.name}: ${COLLECTION_REF_TYPE};`,
      );
    } else {
      blocks.push(`${refJsdoc}\nconst ${ref.name}: {\n${members.join("\n")}\n};`);
    }
  }
  return blocks.join("\n");
}

// The JS-builtin construction forms that aren't `$`-prefixed operators/stages
// and so have no registry entry, but still need an ambient declaration for the
// arrow form to type-check. Emitted as an interface with both a call and a
// construct signature so `ObjectId("…")` and `new ObjectId("…")` both resolve.
function constructionFormsBlock() {
  const jsdoc =
    "/**\n" +
    " * Construct a constant BSON `ObjectId` from a 24-character hex string —\n" +
    ' * e.g. `$._id === ObjectId("507f1f77bcf86cd799439011")`. `new ObjectId(...)`\n' +
    " * is equivalent. jsmql emits a live ObjectId value (the only form the MongoDB\n" +
    " * driver accepts in a query document). For an id known only at runtime,\n" +
    " * interpolate a real ObjectId (template tag or a `jsmql.compile` parameter),\n" +
    " * or convert a string field server-side with `$toObjectId($.idStr)`.\n" +
    " *\n" +
    " * @see https://www.mongodb.com/docs/manual/reference/method/ObjectId/\n" +
    " */";
  return (
    "interface ObjectIdConstructor {\n" +
    "  (hexString: string): any;\n" +
    "  new (hexString: string): any;\n" +
    "}\n" +
    jsdoc +
    "\nvar ObjectId: ObjectIdConstructor;"
  );
}

// The statement-form built-ins that aren't `$`-prefixed operators/stages and so
// have no registry entry, but still need an ambient declaration for the arrow
// form to type-check. `assert(condition[, message])` is a pipeline-statement
// guard with no value (it lowers to a `$match`), so it's typed as returning
// `void` — using it in expression position is a compile error in jsmql too.
// See src/codegen.ts (generateAssertGuardExpr) and docs/specs/assert.md.
function statementFormsBlock() {
  const jsdoc =
    "/**\n" +
    " * Pipeline-statement guard — raises a runtime error from inside an\n" +
    " * aggregation pipeline when `condition` fails (the MongoDB equivalent of a\n" +
    " * guard clause). When `condition` holds the document passes through\n" +
    " * untouched; otherwise the operation aborts and the server returns an error\n" +
    " * whose text carries `message`. Statement-only — it has no value, so it\n" +
    " * can't appear on a RHS, as an operand, or in a Filter / `jsmql.expr`.\n" +
    " * Lowers to a single `$match` stage (a `$convert` to an unknown type name).\n" +
    " *\n" +
    ' * @example assert($.qty >= 0, "qty must be >= 0")\n' +
    " * @see https://github.com/koresar/jsmql/blob/master/docs/specs/assert.md\n" +
    " */";
  return jsdoc + "\nfunction assert(condition: any, message?: any): void;";
}

export function generateOpsSource() {
  const spec = loadSpec();

  // Categorise every name by which registries it appears in. `$count` is the
  // only name today that lives in both `STAGES` and `OPERATORS`; we emit it
  // once with overloaded call signatures spanning both meanings.
  const allNames = new Set([...Object.keys(STAGES), ...Object.keys(OPERATORS)]);

  // For section ordering: a name appears in the Stages section if it's in
  // STAGES, otherwise in the Expression-operators section. Names in BOTH
  // (i.e. `$count`) sit under Stages but include the operator overload too.
  const stageNames = [...allNames].filter((n) => n in STAGES).sort();
  const opOnlyNames = [...allNames].filter((n) => !(n in STAGES) && n in OPERATORS).sort();

  function blockFor(name) {
    if (SUB_CONSTRUCTS.has(name)) return null;
    const stageDef = STAGES[name];
    const opDef = OPERATORS[name];
    const stageSpec = spec.stage.get(name);
    const opSpec = spec.expression.get(name) ?? spec.accumulator.get(name);

    const sigs = [];
    if (stageDef) sigs.push(...stageCallableType(stageSpec));
    if (opDef) sigs.push(...expressionOpCallableType(opSpec, opDef));

    // Dedup identical signatures (e.g. `(): any` from both registries).
    const uniqueSigs = [...new Set(sigs)];

    // JSDoc preference: stage spec wins when present (the stage description is
    // usually the higher-level one users want to see first); otherwise the op
    // spec; otherwise registry. The reverse case (op-only) falls through to
    // the op spec naturally.
    const jsdocSpec = stageSpec ?? opSpec;
    const jsdocDef = stageDef ?? opDef;
    const jsdoc = jsdocFor(name, jsdocSpec, jsdocDef);

    return emitBlock(name, jsdoc, uniqueSigs);
  }

  const stageBlocks = stageNames.map(blockFor).filter((s) => s !== null);
  const opBlocks = opOnlyNames.map(blockFor).filter((s) => s !== null);

  const header = [
    "// AUTO-GENERATED by scripts/generate-ops.mjs from src/operators.ts,",
    "// src/stages.ts, and vendor/mql-specifications. DO NOT EDIT — re-run",
    "// `npm run generate:ops` (or `npm run build`) after pulling new specs.",
    "//",
    "// User-facing import shape:",
    "//",
    '//   import "@koresar/jsmql/ops";',
    "//",
    "// Surfaces every jsmql stage and operator as an ambient global with a",
    "// precise signature, JSDoc description, and link to the MongoDB docs.",
    "// Also declares the `$$` / `$$$` / `$$$$` context references, with",
    "// completion for the collection- and cluster-scoped diagnostic stages.",
    "// The compiled module exports nothing at runtime (`export {};`), so the",
    "// import resolves to an empty module — bundlers tree-shake it away. For",
    '// fully zero-runtime use, add `"@koresar/jsmql/ops"` to tsconfig',
    "// compilerOptions.types instead.",
    "//",
    "// Why globals: named imports of these names break under every common",
    "// bundler (Vite, Webpack, esbuild). The transforms rewrite",
    "// `$match(args)` to `(0, _ops.$match)(args)`, which the jsmql parser",
    "// can't recognise. Ambient globals are the one shape that survives every",
    "// transform — and the collision risk is essentially nil because every",
    "// name starts with `$`.",
    "//",
    "// Drift protection: test/operator-spec-coverage.test.ts asserts this file",
    "// is byte-equal to the generator output on every `npm test`.",
    "",
    "declare global {",
    "  // ── Stages ────────────────────────────────────────────────────────────",
  ];

  const body = [
    ...stageBlocks.map(indent),
    "",
    "  // ── Expression operators (incl. accumulators and window functions) ────",
    ...opBlocks.map(indent),
    "",
    "  // ── Context references ($$, $$$, $$$$) ────────────────────────────────",
    indent(contextRefBlock(spec)),
    "",
    "  // ── JS construction forms (ObjectId) ──────────────────────────────────",
    indent(constructionFormsBlock()),
    "",
    "  // ── Statement-form built-ins (assert) ─────────────────────────────────",
    indent(statementFormsBlock()),
  ];

  const footer = ["}", "", "export {};", ""];

  return [...header, ...body, ...footer].join("\n");
}

function indent(block) {
  return block
    .split("\n")
    .map((ln) => (ln.length > 0 ? `  ${ln}` : ""))
    .join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point. Writes the file and runs oxfmt for final formatting parity
// with the rest of the codebase.
// ---------------------------------------------------------------------------

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const source = generateOpsSource();
  writeFileSync(OUT_PATH, source);
  const oxfmt = resolve(ROOT, "node_modules/.bin/oxfmt");
  if (existsSync(oxfmt)) {
    const r = spawnSync(oxfmt, [OUT_PATH], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`generate-ops: oxfmt exited with ${r.status}`);
      process.exit(r.status ?? 1);
    }
  }
  console.error(`generate-ops: wrote ${OUT_PATH}`);
}
