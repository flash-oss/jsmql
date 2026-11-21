#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import {
  argCountOf,
  constructorGlobals,
  nativeDateMethodNames,
  requiredReceiverFamily,
  streamMethodNames,
  valueMethodNames,
  valueMethodReturns,
  valueTerminalMethodNames,
  describes,
  diagnosticOf,
  everyOperatorName,
  everyStageName,
  operandShapeOf,
  positionalKeysOf,
} from "../src/compiler/rows.ts";
import { TIME_UNIT } from "../src/registry/names.ts";

const STAGES = Object.fromEntries(
  everyStageName().map((name) => [name, { description: describes(name, "stage"), diagnostic: diagnosticOf(name) }]),
);

const OPERATORS = Object.fromEntries(
  everyOperatorName().map((name) => {
    const kind = operandShapeOf(name);
    return [
      name,
      {
        description: describes(name, "operator"),
        shape: kind === "object" ? { kind, keys: positionalKeysOf(name) } : { kind },
      },
    ];
  }),
);

const VALUE_TERMINAL_METHODS = valueTerminalMethodNames();
const NATIVE_DATE_METHODS = nativeDateMethodNames();

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SPEC_ROOT = resolve(ROOT, "vendor", "mql-specifications", "definitions");
const OUT_PATH = resolve(ROOT, "src", "globals.ts");

const TIME_UNIT_LITERAL = TIME_UNIT.map((u) => `"${u}"`).join(" | ");

const DIAGNOSTIC_OPTION_SHAPES = {
  $collStats:
    "{ latencyStats?: { histograms?: boolean }; storageStats?: { scale?: number }; count?: Record<string, never>; queryExecStats?: Record<string, never> }",
  $listSearchIndexes: "{ id?: string; name?: string }",
  $currentOp:
    "{ allUsers?: boolean; idleConnections?: boolean; idleCursors?: boolean; idleSessions?: boolean; localOps?: boolean; targetAllNodes?: boolean }",
  $listSessions: "{ users?: { user: string; db: string }[]; allUsers?: boolean }",
  $listLocalSessions: "{ users?: { user: string; db: string }[]; allUsers?: boolean }",
  $listSampledQueries: "{ namespace?: string }",
};

const CONTEXT_REFS = {
  collection: {
    name: "$$",
    doc:
      "jsmql root-stream context reference (`$$`, run on `db.coll.aggregate()`). " +
      "Names a diagnostic source stage of the current collection, or heads stream sugar " +
      "(`$$.push(...)` → `$unionWith`, `$$.filter(...)`, stream methods, `$$ = ...`).",
  },
  database: {
    name: "$$$",
    doc:
      "jsmql current-database context reference (`$$$`, run on `db.aggregate()`). " +
      "Heads cross-collection joins (`$$$.coll.find/filter(...)` → `$lookup`) and " +
      "`$out` writes (`$$$.coll = ...`). Has no diagnostic source stages of its own — " +
      "`$currentOp` and the other cluster diagnostics run on the admin database, reached through `$$$$`.",
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

const STREAM_REF_TYPE = "JsmqlStreamRef";

const FOREIGN_REF_TYPE = "JsmqlForeignRef";

const STREAM_METHOD_SIGNATURES = {
  filter: {
    doc: "Narrow the stream → `$match`. Pass an arrow predicate or a matches-object (`{ field: value }`).",
    params: "(predicate: ((doc: any) => any) | Record<string, any>)",
  },
  reject: {
    doc: "Drop matching documents → `$match` (`.filter` negated). Pass an arrow predicate or a matches-object.",
    params: "(predicate: ((doc: any) => any) | Record<string, any>)",
  },
  map: {
    doc: 'Reshape each document → `$replaceWith`. Pass an arrow or a field name (`"userId"`).',
    params: "(transform: ((doc: any) => any) | string)",
  },
  aggregate: {
    doc: "Run a sub-pipeline block against the stream. On a foreign collection it becomes the `$lookup` sub-pipeline; on the current stream its statements are simply the chain's stages.",
    params: "(pipeline: ((doc: any, index?: number, coll?: any) => void) | object[])",
  },
  slice: { doc: "Take a window of the stream → `$skip` / `$limit`.", params: "(start: number, end?: number)" },
  concat: { doc: "Append documents / union collections → `$unionWith`.", params: "(...sources: any[])" },
  toSorted: {
    doc: "Order the stream → `$sort` (equivalent to `.sort` on a stream).",
    params: '(sort: string | string[] | Record<string, 1 | -1 | "asc" | "desc"> | ((a: any, b: any) => number))',
  },
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
  takeWhile: {
    doc: "Keep the leading run where the predicate holds, stopping at the first failure → `$setWindowFields` running flag + `$match` (lodash `_.takeWhile`). Needs a preceding sort.",
    params: "(predicate: ((doc: any) => any) | Record<string, any> | string)",
  },
  dropWhile: {
    doc: "Drop the leading run where the predicate holds, keeping from the first failure on → `$setWindowFields` running flag + `$match` (lodash `_.dropWhile`). Needs a preceding sort.",
    params: "(predicate: ((doc: any) => any) | Record<string, any> | string)",
  },
  shuffle: { doc: "Random document order → `$rand` sort (non-deterministic, lodash `_.shuffle`).", params: "()" },
  sampleSize: { doc: "`n` random documents → `$sample`.", params: "(n: number)" },
  sort: {
    doc: 'Order the stream → `$sort`. Field name, `[fields]`, `{ field: 1|-1|"asc"|"desc" }`, or a comparator.',
    params: '(sort: string | string[] | Record<string, 1 | -1 | "asc" | "desc"> | ((a: any, b: any) => number))',
  },
  sortBy: { doc: "Ascending sort by a key → `$sort` (lodash `_.sortBy`).", params: "(key: string | string[])" },
  orderBy: {
    doc: "Multi-key sort → `$sort` (lodash `_.orderBy`). Parallel `keys` + `orders`, or a `{ field: dir }` object (directions inline).",
    params:
      '(keys: string | string[] | Record<string, 1 | -1 | "asc" | "desc">, orders?: (1 | -1 | "asc" | "desc") | (1 | -1 | "asc" | "desc")[])',
  },
  groupBy: {
    doc: "Group the stream. A field name collapses to the lodash object `{ <key>: [docs] }`; a `$group` body (`{ _id, … }`) lowers to a `$group` stage.",
    params: "(spec: string | Record<string, any>)",
  },
  countBy: {
    doc: "Tally documents per distinct key → the lodash object `{ <key>: <count> }` (for the count-descending stream, use the `$sortByCount` stage).",
    params: "(field: string)",
  },
  keyBy: { doc: "Key documents by a field → the lodash object `{ <key>: <last doc> }`.", params: "(field: string)" },
  uniqBy: { doc: "One document per distinct key → `$group` + `$replaceWith`.", params: "(field: string)" },
  uniq: { doc: "One document per distinct WHOLE document → `$group` + `$replaceWith`.", params: "()" },
  sortedUniq: { doc: "Alias of `.uniq()` — MongoDB's `$group` needs no sorted input.", params: "()" },
  sortedUniqBy: { doc: "Alias of `.uniqBy()` — MongoDB's `$group` needs no sorted input.", params: "(field: string)" },
  difference: {
    doc: "After `.flatMap`: drop the unwound values that are in the list → `$match` (lodash `_.difference`).",
    params: "(list: unknown[])",
  },
  without: {
    doc: "After `.flatMap`: drop the given values → `$match` (lodash `_.without`).",
    params: "(...values: unknown[])",
  },
  intersection: {
    doc: "After `.flatMap`: keep the unwound values that are in the list, one document per distinct value → `$match` + `$group` (lodash `_.intersection`).",
    params: "(list: unknown[])",
  },
  differenceBy: {
    doc: "After `.flatMap`: drop the elements whose key is among the list's keys → `$match` (lodash `_.differenceBy`).",
    params: "(list: unknown[], key: string)",
  },
  intersectionBy: {
    doc: "After `.flatMap`: keep the elements whose key is among the list's keys, one per distinct key → `$match` + `$group` (lodash `_.intersectionBy`).",
    params: "(list: unknown[], key: string)",
  },
  compact: { doc: 'After `.flatMap`: drop the falsy values (null, missing, 0, false, "") → `$match`.', params: "()" },
  flat: { doc: "After `.flatMap` of an array of arrays: unwind the element once more → `$unwind`.", params: "()" },
  pick: {
    doc: "Keep only the named fields on each document → inclusion `$project` (lodash `_.pick`; drops `_id` unless named).",
    params: "(fields: string[])",
  },
  omit: {
    doc: "Drop the named fields from each document → exclusion `$project` (lodash `_.omit`).",
    params: "(fields: string[])",
  },
  push: { doc: "Append documents to the stream → `$unionWith`.", params: "(...docs: any[])" },
};

const NON_REGISTRY_STREAM_METHODS = ["filter", "reject"];
const ROOT_STREAM_ONLY_METHODS = ["push"];

function streamMethodMembers(returnType, names) {
  const registry = streamMethodNames();
  const missing = registry.filter((n) => STREAM_METHOD_SIGNATURES[n] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `generate-globals: stream method(s) ${missing.join(", ")} are in the STREAM_METHODS registry ` +
        `but have no signature in STREAM_METHOD_SIGNATURES. Add one so '$$.<method>()' gets completion.`,
    );
  }
  const known = new Set([...registry, ...NON_REGISTRY_STREAM_METHODS, ...ROOT_STREAM_ONLY_METHODS]);
  const stray = Object.keys(STREAM_METHOD_SIGNATURES).filter((n) => !known.has(n));
  if (stray.length > 0) {
    throw new Error(
      `generate-globals: STREAM_METHOD_SIGNATURES has entries jsmql no longer accepts on a stream: ` +
        `${stray.sort().join(", ")}. Drop them, or add them back to the STREAM_METHODS registry.`,
    );
  }
  const members = [];
  for (const name of names) {
    const { doc, params } = STREAM_METHOD_SIGNATURES[name];
    members.push(`/** ${doc} */`);
    members.push(`${name}${params}: ${returnType};`);
  }
  return members;
}

function stageLinkMembers(spec, returnType) {
  const members = [];
  for (const name of Object.keys(STAGES).sort()) {
    if (STAGES[name].diagnostic !== undefined) continue;
    members.push(jsdocFor(name, spec.stage[name], STAGES[name]));
    members.push(`${name}(body: any): ${returnType};`);
  }
  return members;
}

const VALUE_TERMINAL_RETURNS = { size: "number", sum: "number", mean: "number", sumBy: "number", meanBy: "number" };
function terminalParams(name) {
  return VALUE_TERMINAL_PARAMS[name] ?? (argCountOf(name, "array")?.none === true ? "()" : "(...args: any[])");
}

const VALUE_TERMINAL_PARAMS = {
  nth: "(n?: number)",
  every: "(predicate: ((doc: any) => any) | Record<string, any> | string)",
  some: "(predicate: ((doc: any) => any) | Record<string, any> | string)",
  has: "(value: any)",
  partition: "(predicate: ((doc: any) => any) | Record<string, any> | string)",
  sumBy: "(iteratee: ((doc: any) => any) | string)",
  meanBy: "(iteratee: ((doc: any) => any) | string)",
  minBy: "(iteratee: ((doc: any) => any) | string)",
  maxBy: "(iteratee: ((doc: any) => any) | string)",
};
function valueTerminalMembers() {
  const members = [];
  for (const name of [...VALUE_TERMINAL_METHODS].sort()) {
    members.push(`/** Ends the chain with a value — valid in value position (\`$.f = …\`, \`const x = …\`). */`);
    members.push(`${name}${terminalParams(name)}: ${VALUE_TERMINAL_RETURNS[name] ?? "any"};`);
  }
  return members;
}

const VALUE_METHOD_SKIP = {
  nativeArray: new Set([
    "at",
    "slice",
    "concat",
    "reverse",
    "toReversed",
    "toSorted",
    "toSpliced",
    "with",
    "flat",
    "flatMap",
    "map",
    "filter",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "lastIndexOf",
    "some",
    "every",
    "reduce",
    "reduceRight",
    "join",
    "toString",
    "sort",
    "splice",
    "push",
    "pop",
    "shift",
    "unshift",
    "fill",
    "copyWithin",
    "forEach",
    "entries",
    "keys",
    "values",
    "toLocaleString",
  ]),
  nativeString: new Set([
    "trim",
    "trimStart",
    "trimLeft",
    "trimEnd",
    "trimRight",
    "substr",
    "substring",
    "charAt",
    "split",
    "startsWith",
    "endsWith",
    "replace",
    "replaceAll",
    "match",
    "matchAll",
    "search",
    "padStart",
    "padEnd",
    "repeat",
    "indexOf",
    "includes",
    "length",
  ]),
  dateNative: new Set(NATIVE_DATE_METHODS),
  object: new Set([
    "mapValues",
    "mapKeys",
    "pick",
    "omit",
    "pickBy",
    "omitBy",
    "findKey",
    "invert",
    "invertBy",
    "toPairs",
    "assign",
  ]),
  regex: new Set(["test", "exec"]),
  shimmed: new Set(["toNumber", "toLowerCase", "toUpperCase", "isBoolean", "isUndefined", "unzipWith"]),
};

const ITER = "iteratee: string | number | ((value: T) => any)";
const OPT_ITER = "iteratee?: string | number | ((value: T) => any)";
const PRED = "predicate: string | number | [string, any] | Record<string, any> | ((value: T) => any)";
const CONVERTIBLE = ["String", "Number", "Date", "Boolean"];
const TYPE_TESTED = ["String", "Number", "Date", "Boolean", "Array"];

const VALUE_METHOD_SIGNATURES = {
  toDouble: { recv: CONVERTIBLE, sig: "(): number", doc: "The value as a double — `$toDouble`." },
  toInt: { recv: CONVERTIBLE, sig: "(): number", doc: "The value as a 32-bit integer — `$toInt`." },
  toLong: { recv: CONVERTIBLE, sig: "(): number", doc: "The value as a 64-bit integer — `$toLong`." },
  toDecimal: { recv: CONVERTIBLE, sig: "(): number", doc: "The value as a Decimal128 — `$toDecimal`." },
  toBool: {
    recv: CONVERTIBLE,
    sig: "(): boolean",
    doc: "The value as a boolean — MongoDB's `$toBool`, which reads every string as true.",
  },
  toDate: { recv: ["String", "Number", "Date"], sig: "(): Date", doc: "The value as a date — `$toDate`." },
  toObjectId: { recv: "String", sig: "(): any", doc: "A 24-hex string as an ObjectId — `$toObjectId`." },
  toUUID: { recv: "String", sig: "(): any", doc: "A UUID string as a UUID — `$toUUID`." },
  isString: { recv: TYPE_TESTED, sig: "(): boolean", doc: "Is the value a string? — `$type`." },
  isNumber: { recv: TYPE_TESTED, sig: "(): boolean", doc: "Is the value a number of any BSON type? — `$isNumber`." },
  isDouble: { recv: TYPE_TESTED, sig: "(): boolean", doc: "Is the value a double? — `$type`." },
  isInt: { recv: TYPE_TESTED, sig: "(): boolean", doc: "Is the value a 32-bit integer? — `$type`." },
  isLong: { recv: TYPE_TESTED, sig: "(): boolean", doc: "Is the value a 64-bit integer? — `$type`." },
  isDecimal: { recv: TYPE_TESTED, sig: "(): boolean", doc: "Is the value a Decimal128? — `$type`." },
  isBool: { recv: TYPE_TESTED, sig: "(): boolean", doc: "Is the value a boolean? — `$type`." },
  isDate: { recv: TYPE_TESTED, sig: "(): boolean", doc: "Is the value a date? — `$type`." },
  isObjectId: { recv: TYPE_TESTED, sig: "(): boolean", doc: "Is the value an ObjectId? — `$type`." },
  isArray: { recv: TYPE_TESTED, sig: "(): boolean", doc: "Is the value an array? — `$isArray`." },
  isInteger: { recv: TYPE_TESTED, sig: "(): boolean", doc: "Is the value a number with no fraction?" },
  isNaN: { recv: TYPE_TESTED, sig: "(): boolean", doc: "Is the value the number NaN?" },
  isObject: { recv: TYPE_TESTED, sig: "(): boolean", doc: "Is the value a document? An array is not one. — `$type`." },
  isUUID: { recv: TYPE_TESTED, sig: "(): boolean", doc: "Is the value a UUID (a binData of subtype 4)?" },
  uniq: { recv: "Array", sig: "(): T[]", doc: "Duplicate-free copy — `_.uniq`." },
  uniqBy: { recv: "Array", sig: `(${ITER}): T[]`, doc: "Duplicate-free by iteratee — `_.uniqBy`." },
  sortedUniq: { recv: "Array", sig: "(): T[]", doc: "Duplicate-free copy of a sorted array — `_.sortedUniq`." },
  sortedUniqBy: { recv: "Array", sig: `(${ITER}): T[]`, doc: "`.sortedUniq` with an iteratee — `_.sortedUniqBy`." },
  compact: { recv: "Array", sig: "(): T[]", doc: "Drop falsy elements — `_.compact`." },
  flatten: { recv: "Array", sig: "(): any[]", doc: "Flatten one level deep — `_.flatten`." },
  take: { recv: "Array", sig: "(n?: number): T[]", doc: "First `n` elements — `_.take`." },
  drop: { recv: "Array", sig: "(n?: number): T[]", doc: "All but the first `n` elements — `_.drop`." },
  takeRight: { recv: "Array", sig: "(n?: number): T[]", doc: "Last `n` elements — `_.takeRight`." },
  dropRight: { recv: "Array", sig: "(n?: number): T[]", doc: "All but the last `n` elements — `_.dropRight`." },
  tail: { recv: "Array", sig: "(): T[]", doc: "All but the first element — `_.tail`." },
  initial: { recv: "Array", sig: "(): T[]", doc: "All but the last element — `_.initial`." },
  sampleSize: { recv: "Array", sig: "(n?: number): T[]", doc: "`n` random elements — `_.sampleSize`." },
  without: { recv: "Array", sig: "(...values: T[]): T[]", doc: "Exclude the given values — `_.without`." },
  xor: { recv: "Array", sig: "(...arrays: T[][]): T[]", doc: "Symmetric difference — `_.xor`." },
  symmetricDifference: {
    recv: "Array",
    sig: "(other: T[]): T[]",
    doc: "The values that only one of the two arrays holds — the same answer as `.xor()`.",
  },
  union: { recv: "Array", sig: "(other: T[]): T[]", doc: "The values of both arrays, each once — `_.union`." },
  intersection: {
    recv: "Array",
    sig: "(other: any[]): T[]",
    doc: "The values that both arrays hold, each once — `_.intersection`.",
  },
  difference: { recv: "Array", sig: "(other: any[]): T[]", doc: "The values that `other` does not hold, each once." },
  xorBy: { recv: "Array", sig: "(...args: any[]): T[]", doc: "Symmetric difference by iteratee — `_.xorBy`." },
  differenceBy: { recv: "Array", sig: "(...args: any[]): T[]", doc: "Difference by iteratee — `_.differenceBy`." },
  intersectionBy: {
    recv: "Array",
    sig: "(...args: any[]): T[]",
    doc: "Intersection by iteratee — `_.intersectionBy`.",
  },
  unionBy: { recv: "Array", sig: "(...args: any[]): T[]", doc: "Union by iteratee — `_.unionBy`." },
  sortBy: {
    recv: "Array",
    sig: "(iteratee?: string | string[] | ((value: T) => any)): T[]",
    doc: "Ascending sort by iteratee(s) — `_.sortBy`.",
  },
  orderBy: {
    recv: "Array",
    sig: '(iteratees?: string | string[] | Record<string, 1 | -1 | "asc" | "desc">, orders?: ("asc" | "desc") | ("asc" | "desc")[]): T[]',
    doc: "Multi-key sort — `_.orderBy`. Parallel iteratees + orders, or a `{ field: dir }` object (directions inline).",
  },
  reject: { recv: "Array", sig: `(${PRED}): T[]`, doc: "Elements the predicate rejects — `_.reject`." },
  takeWhile: { recv: "Array", sig: `(${PRED}): T[]`, doc: "Leading run matching the predicate — `_.takeWhile`." },
  dropWhile: { recv: "Array", sig: `(${PRED}): T[]`, doc: "Drop the leading matching run — `_.dropWhile`." },
  takeRightWhile: {
    recv: "Array",
    sig: `(${PRED}): T[]`,
    doc: "Trailing run matching the predicate — `_.takeRightWhile`.",
  },
  dropRightWhile: { recv: "Array", sig: `(${PRED}): T[]`, doc: "Drop the trailing matching run — `_.dropRightWhile`." },
  head: { recv: "Array", sig: "(): T", doc: "First element — `_.head`." },
  first: { recv: "Array", sig: "(): T", doc: "First element — `_.first`." },
  last: { recv: "Array", sig: "(): T", doc: "Last element — `_.last`." },
  nth: { recv: "Array", sig: "(n?: number): T", doc: "Element at index `n` (negative counts from the end) — `_.nth`." },
  sample: { recv: "Array", sig: "(): T", doc: "One random element — `_.sample`." },
  max: { recv: "Array", sig: "(): T", doc: "Maximum element — `_.max`." },
  min: { recv: "Array", sig: "(): T", doc: "Minimum element — `_.min`." },
  maxBy: { recv: "Array", sig: `(${ITER}): T`, doc: "Element with the max iteratee value — `_.maxBy`." },
  minBy: { recv: "Array", sig: `(${ITER}): T`, doc: "Element with the min iteratee value — `_.minBy`." },
  sum: { recv: "Array", sig: "(): number", doc: "Sum of the elements — `_.sum`." },
  mean: { recv: "Array", sig: "(): number", doc: "Arithmetic mean — `_.mean`." },
  sumBy: { recv: "Array", sig: `(${ITER}): number`, doc: "Sum of iteratee values — `_.sumBy`." },
  meanBy: { recv: "Array", sig: `(${ITER}): number`, doc: "Mean of iteratee values — `_.meanBy`." },
  size: { recv: "Array", sig: "(): number", doc: "Element count — `_.size`." },
  has: {
    recv: "Array",
    sig: "(value: any): boolean",
    doc: "Is `value` an element; a string tests a substring with `.includes()`.",
  },
  isSubsetOf: { recv: "Array", sig: "(other: any[]): boolean", doc: "Does `other` hold every element." },
  isSupersetOf: {
    recv: "Array",
    sig: "(other: any[]): boolean",
    doc: "Does this array hold every element of `other`.",
  },
  isDisjointFrom: { recv: "Array", sig: "(other: any[]): boolean", doc: "Do the two arrays share no element." },
  chunk: { recv: "Array", sig: "(size: number): T[][]", doc: "Split into groups of `size` — `_.chunk`." },
  partition: { recv: "Array", sig: `(${PRED}): [T[], T[]]`, doc: "Split into `[matching, rest]` — `_.partition`." },
  zip: { recv: "Array", sig: "(...arrays: any[][]): any[][]", doc: "Group by index across arrays — `_.zip`." },
  unzip: { recv: "Array", sig: "(): any[][]", doc: "Inverse of `.zip` — `_.unzip`." },
  zipWith: { recv: "Array", sig: "(...args: any[]): any[]", doc: "`.zip` then combine each group — `_.zipWith`." },
  zipObject: {
    recv: "Array",
    sig: "(values: any[]): Record<string, any>",
    doc: "Keys (receiver) → values object — `_.zipObject`.",
  },
  fromPairs: { recv: "Array", sig: "(): Record<string, any>", doc: "`[key, value]` pairs → object — `_.fromPairs`." },
  fromEntries: {
    recv: "Array",
    sig: "(): Record<string, any>",
    doc: "`[key, value]` pairs → object — the JavaScript spelling of `.fromPairs()`, same lowering.",
  },
  keyBy: {
    recv: "Array",
    sig: `(${OPT_ITER}): Record<string, T>`,
    doc: "Index elements by iteratee (omit for identity) — `_.keyBy`.",
  },
  groupBy: {
    recv: "Array",
    sig: `(${OPT_ITER}): Record<string, T[]>`,
    doc: "Group elements by iteratee (omit for identity) — `_.groupBy`.",
  },
  countBy: {
    recv: "Array",
    sig: `(${OPT_ITER}): Record<string, number>`,
    doc: "Count elements by iteratee (omit for identity) — `_.countBy`.",
  },
  capitalize: {
    recv: "String",
    sig: "(): string",
    doc: "Upper-case the first char, lower-case the rest — `_.capitalize`.",
  },
  upperFirst: { recv: "String", sig: "(): string", doc: "Upper-case the first char — `_.upperFirst`." },
  lowerFirst: { recv: "String", sig: "(): string", doc: "Lower-case the first char — `_.lowerFirst`." },
  kebabCase: { recv: "String", sig: "(): string", doc: "`kebab-case` the string — `_.kebabCase`." },
  snakeCase: { recv: "String", sig: "(): string", doc: "`snake_case` the string — `_.snakeCase`." },
  toLower: {
    recv: "String",
    sig: "(): string",
    doc: "Lower-case each letter of the string — `_.toLower`, `$toLower`.",
  },
  toUpper: {
    recv: "String",
    sig: "(): string",
    doc: "Upper-case each letter of the string — `_.toUpper`, `$toUpper`.",
  },
  lowerCase: {
    recv: "String",
    sig: "(): string",
    doc: "`lower case` the string: the words, lower-cased and joined by a space — `_.lowerCase`.",
  },
  upperCase: {
    recv: "String",
    sig: "(): string",
    doc: "`UPPER CASE` the string: the words, upper-cased and joined by a space — `_.upperCase`.",
  },
  startCase: { recv: "String", sig: "(): string", doc: "`Start Case` the string — `_.startCase`." },
  camelCase: { recv: "String", sig: "(): string", doc: "`camelCase` the string — `_.camelCase`." },
  escape: { recv: "String", sig: "(): string", doc: "Escape HTML entities — `_.escape`." },
  pad: {
    recv: "String",
    sig: "(length: number, pad?: string): string",
    doc: "Pad both sides to a constant `length` with one ASCII character (default a space); the end takes the odd character — `_.pad`.",
  },
  truncate: {
    recv: "String",
    sig: "(options?: { length?: number; omission?: string; separator?: string | RegExp }): string",
    doc: "Truncate to a length with an omission — `_.truncate`.",
  },
  indexOfSubstring: {
    recv: "String",
    sig: "(searchString: string, position?: number): number",
    doc: "The index of the first `searchString` at or after `position`, in code points, or -1 — `String.prototype.indexOf`.",
  },
  words: {
    recv: "String",
    sig: "(pattern?: string | RegExp): string[]",
    doc: "Split into an array of words — `_.words`.",
  },
  clamp: {
    recv: ["Number", "Date"],
    sig: { Number: "(lower: number, upper: number): number", Date: "(lower: Date, upper: Date): Date" },
    doc: "Clamp within `[lower, upper]` — `_.clamp`.",
  },
  inRange: {
    recv: ["Number", "Date"],
    sig: { Number: "(start: number, end?: number): boolean", Date: "(start: Date, end: Date): boolean" },
    doc: "Whether the value is in the half-open range `[start, end)` — `_.inRange`.",
  },
  round: { recv: "Number", sig: "(precision?: number): number", doc: "Round to `precision` decimals — `_.round`." },
  ceil: { recv: "Number", sig: "(precision?: number): number", doc: "Round up to `precision` decimals — `_.ceil`." },
  floor: {
    recv: "Number",
    sig: "(precision?: number): number",
    doc: "Round down to `precision` decimals — `_.floor`.",
  },
  abs: { recv: "Number", sig: "(): number", doc: "The absolute value — `Math.abs`." },
  sqrt: { recv: "Number", sig: "(): number", doc: "The square root — `Math.sqrt`." },
  cbrt: { recv: "Number", sig: "(): number", doc: "The cube root — `Math.cbrt`." },
  exp: { recv: "Number", sig: "(): number", doc: "e to the power of the value — `Math.exp`." },
  log: {
    recv: "Number",
    sig: "(base?: number): number",
    doc: "The natural logarithm, or the logarithm to `base` — `Math.log`.",
  },
  log2: { recv: "Number", sig: "(): number", doc: "The base-2 logarithm — `Math.log2`." },
  log10: { recv: "Number", sig: "(): number", doc: "The base-10 logarithm — `Math.log10`." },
  sign: { recv: "Number", sig: "(): number", doc: "-1, 0 or 1 — `Math.sign`." },
  trunc: {
    recv: "Number",
    sig: "(precision?: number): number",
    doc: "Drop the digits after `precision` decimals — `Math.trunc`.",
  },
  atan2: { recv: "Number", sig: "(x: number): number", doc: "The angle of the point (x, this) — `Math.atan2`." },
  hypot: {
    recv: "Number",
    sig: "(...values: number[]): number",
    doc: "The square root of the sum of squares — `Math.hypot`.",
  },
  sin: { recv: "Number", sig: "(): number", doc: "The sine, in radians — `Math.sin`." },
  cos: { recv: "Number", sig: "(): number", doc: "The cosine, in radians — `Math.cos`." },
  tan: { recv: "Number", sig: "(): number", doc: "The tangent, in radians — `Math.tan`." },
  asin: { recv: "Number", sig: "(): number", doc: "The arcsine, in radians — `Math.asin`." },
  acos: { recv: "Number", sig: "(): number", doc: "The arccosine, in radians — `Math.acos`." },
  atan: { recv: "Number", sig: "(): number", doc: "The arctangent, in radians — `Math.atan`." },
  sinh: { recv: "Number", sig: "(): number", doc: "The hyperbolic sine, in radians — `Math.sinh`." },
  cosh: { recv: "Number", sig: "(): number", doc: "The hyperbolic cosine, in radians — `Math.cosh`." },
  tanh: { recv: "Number", sig: "(): number", doc: "The hyperbolic tangent, in radians — `Math.tanh`." },
  asinh: { recv: "Number", sig: "(): number", doc: "The inverse hyperbolic sine, in radians — `Math.asinh`." },
  acosh: { recv: "Number", sig: "(): number", doc: "The inverse hyperbolic cosine, in radians — `Math.acosh`." },
  atanh: { recv: "Number", sig: "(): number", doc: "The inverse hyperbolic tangent, in radians — `Math.atanh`." },
  random: {
    recv: "Number",
    sig: "(upper?: number): number",
    doc: "Gives a random number between two bounds, with the API of lodash's `_.random`. Two whole bounds give a whole number.",
  },
  range: {
    recv: "Number",
    sig: "(end?: number, step?: number): number[]",
    doc: "The integers from the start up to, but not including, the end — `_.range`.",
  },
  rangeRight: {
    recv: "Number",
    sig: "(end?: number, step?: number): number[]",
    doc: "The `.range()` array in reverse order — `_.rangeRight`.",
  },
  plus: {
    recv: "Date",
    sig: `(amount: number, unit: ${TIME_UNIT_LITERAL}, timezone?: string): Date`,
    doc: "Add `amount` units — `$dateAdd`.",
  },
  minus: {
    recv: "Date",
    sig: `(amount: number, unit: ${TIME_UNIT_LITERAL}, timezone?: string): Date`,
    doc: "Subtract `amount` units — `$dateSubtract`.",
  },
  diff: {
    recv: "Date",
    sig: `(other: Date, unit: ${TIME_UNIT_LITERAL}, timezone?: string): number`,
    doc: "Whole units from this date to `other` — `$dateDiff`.",
  },
  startOf: {
    recv: "Date",
    sig: `(unit: ${TIME_UNIT_LITERAL}, timezone?: string): Date`,
    doc: "Truncate to the start of `unit` — `$dateTrunc`.",
  },
  endOf: {
    recv: "Date",
    sig: `(unit: ${TIME_UNIT_LITERAL}, timezone?: string): Date`,
    doc: "The last instant of `unit`.",
  },
  format: {
    recv: "Date",
    sig: "(format: string, timezone?: string): string",
    doc: "Render with an MQL format string — `$dateToString`.",
  },
  set: {
    recv: "Date",
    sig:
      "(parts: { year?: number; month?: number; day?: number; hour?: number; minute?: number; second?: number; millisecond?: number } | " +
      "{ isoWeekYear?: number; isoWeek?: number; isoDayOfWeek?: number; hour?: number; minute?: number; second?: number; millisecond?: number }, " +
      "timezone?: string): Date",
    doc: "Override date parts, keeping the rest. Calendar parts and ISO parts can't be mixed.",
  },
  week: { recv: "Date", sig: "(timezone?: string): number", doc: "Week of the year, Sunday-based — `$week`." },
  isoWeek: { recv: "Date", sig: "(timezone?: string): number", doc: "ISO 8601 week of the year — `$isoWeek`." },
  isoWeekYear: { recv: "Date", sig: "(timezone?: string): number", doc: "ISO 8601 year — `$isoWeekYear`." },
  isoWeekday: {
    recv: "Date",
    sig: "(timezone?: string): number",
    doc: "ISO 8601 weekday, Monday = 1 — `$isoDayOfWeek`.",
  },
  dayOfYear: { recv: "Date", sig: "(timezone?: string): number", doc: "Day of the year — `$dayOfYear`." },
  quarter: { recv: "Date", sig: "(timezone?: string): number", doc: "Quarter of the year, 1–4." },
  isSame: {
    recv: "Date",
    sig: `(other: Date, unit: ${TIME_UNIT_LITERAL}, timezone?: string): boolean`,
    doc: "Whether both dates fall in the same `unit`.",
  },
  isBefore: {
    recv: "Date",
    sig: `(other: Date, unit: ${TIME_UNIT_LITERAL}, timezone?: string): boolean`,
    doc: "Whether this date's `unit` precedes `other`'s.",
  },
  isAfter: {
    recv: "Date",
    sig: `(other: Date, unit: ${TIME_UNIT_LITERAL}, timezone?: string): boolean`,
    doc: "Whether this date's `unit` follows `other`'s.",
  },
};

function recvsOf(entry) {
  return Array.isArray(entry.recv) ? entry.recv : [entry.recv];
}

function sigFor(entry, recv) {
  return typeof entry.sig === "string" ? entry.sig : entry.sig[recv];
}

const VALUE_METHOD_INTERFACES = {
  Array: "interface Array<T>",
  String: "interface String",
  Number: "interface Number",
  Date: "interface Date",
  Boolean: "interface Boolean",
};

function valueMethodAugmentationBlock() {
  const skip = new Set([
    ...VALUE_METHOD_SKIP.nativeArray,
    ...VALUE_METHOD_SKIP.nativeString,
    ...VALUE_METHOD_SKIP.dateNative,
    ...VALUE_METHOD_SKIP.object,
    ...VALUE_METHOD_SKIP.regex,
    ...VALUE_METHOD_SKIP.shimmed,
  ]);
  const registry = new Set(valueMethodNames());

  const straySkip = [...skip].filter((n) => !registry.has(n));
  if (straySkip.length > 0) {
    throw new Error(
      `generate-globals: VALUE_METHOD_SKIP names not in the METHODS registry: ${straySkip.sort().join(", ")}`,
    );
  }
  const augmentable = [...registry].filter((n) => !skip.has(n));
  const missing = augmentable.filter((n) => VALUE_METHOD_SIGNATURES[n] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `generate-globals: value method(s) ${missing.sort().join(", ")} are in the METHODS registry but have no ` +
        `VALUE_METHOD_SIGNATURES entry. Add a signature so completion works, or a VALUE_METHOD_SKIP entry ` +
        `(native array/string/date, object-receiver, regex, shimmed) if it should not be augmented.`,
    );
  }
  const stray = Object.keys(VALUE_METHOD_SIGNATURES).filter((n) => !registry.has(n) || skip.has(n));
  if (stray.length > 0) {
    throw new Error(
      `generate-globals: VALUE_METHOD_SIGNATURES has entries that are unknown or skipped: ${stray.sort().join(", ")}`,
    );
  }

  const registryReturns = valueMethodReturns();
  const inCategory = {
    string: (r) => r === "string",
    number: (r) => r === "number",
    bool: (r) => r === "boolean",
    date: (r) => r === "Date",
    object: (r) => r.startsWith("Record<") || r === "object",
    array: (r) => r.endsWith("[]") || (r.startsWith("[") && r.endsWith("]")),
  };
  const familyInterface = { array: "Array", string: "String", number: "Number", date: "Date", object: "Object" };
  const wrongRecv = [];
  for (const name of augmentable) {
    const family = requiredReceiverFamily(name);
    if (family === null) continue;
    const recvs = recvsOf(VALUE_METHOD_SIGNATURES[name]);
    if (!recvs.includes(familyInterface[family])) {
      wrongRecv.push(`.${name}(): registry needs a ${family} receiver but the signature augments ${recvs.join(" + ")}`);
    }
  }
  if (wrongRecv.length > 0) {
    throw new Error(
      `generate-globals: value-method receivers drifted from the METHODS registry:\n  ${wrongRecv.sort().join("\n  ")}`,
    );
  }

  const drift = [];
  for (const name of augmentable) {
    const category = registryReturns[name];
    if (category === undefined || !(category in inCategory)) continue;
    const entry = VALUE_METHOD_SIGNATURES[name];
    for (const recv of recvsOf(entry)) {
      const sig = sigFor(entry, recv);
      const ret = sig.slice(sig.lastIndexOf("): ") + 3).trim();
      if (!inCategory[category] || !inCategory[category](ret)) {
        drift.push(`.${name}() on ${recv}: registry returns "${category}" but the ambient signature returns "${ret}"`);
      }
    }
  }
  if (drift.length > 0) {
    throw new Error(
      `generate-globals: value-method augmentation return types drifted from the METHODS registry:\n  ${drift.sort().join("\n  ")}\n` +
        `Reconcile the VALUE_METHOD_SIGNATURES entry with the registry 'returns' (or vice versa) so completion stays truthful.`,
    );
  }

  const order = Object.keys(VALUE_METHOD_INTERFACES);
  const byRecv = Object.fromEntries(order.map((recv) => [recv, []]));
  for (const name of augmentable.sort()) {
    const entry = VALUE_METHOD_SIGNATURES[name];
    for (const recv of recvsOf(entry)) {
      byRecv[recv].push(`/** ${entry.doc} */`, `${name}${sigFor(entry, recv)};`);
    }
  }
  return order.map((recv) => `${VALUE_METHOD_INTERFACES[recv]} {\n${byRecv[recv].join("\n")}\n}`).join("\n");
}

const SPEC_FOLDERS = ["expression", "accumulator", "stage"];

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

const TYPE_NAME_TO_TS = {
  resolvesToNumber: "number",
  resolvesToInt: "number",
  resolvesToLong: "number",
  resolvesToDouble: "number",
  resolvesToDecimal: "number",
  number: "number",
  int: "number",
  double: "number",
  long: "number",
  decimal: "number",
  resolvesToString: "string",
  string: "string",
  resolvesToBool: "boolean",
  bool: "boolean",
  resolvesToDate: "Date",
  date: "Date",
  resolvesToArray: "unknown[]",
  array: "unknown[]",
  resolvesToObject: "Record<string, any>",
  resolvesToNull: "null",
  null: "null",
  resolvesToRegex: "RegExp",
  regex: "RegExp",
};

function mapType(t) {
  if (!t) return "any";
  const types = Array.isArray(t) ? t : [t];
  if (types.includes("timeUnit")) return TIME_UNIT_LITERAL;
  if (types.length === 1) {
    const only = types[0];
    if (only === "pipeline") return "unknown[]";
    if (only === "query") return "any";
    if (only === "object") return "any";
  }
  const out = [...new Set(types.map((n) => TYPE_NAME_TO_TS[n] ?? "any"))];
  return out.includes("any") ? "any" : out.join(" | ");
}

function positionalSigs(args) {
  const param = (a, required) => `${quoteKeyIfNeeded(a.name)}${a.optional && !required ? "?" : ""}: ${mapType(a.type)}`;
  const sig = (params) => `(${params.join(", ")}): any`;
  const firstOptional = args.findIndex((a) => a.optional);
  const trailingOptionals = firstOptional === -1 || args.slice(firstOptional).every((a) => a.optional);
  if (trailingOptionals) return [sig(args.map((a) => param(a, false)))];
  return [sig(args.filter((a) => !a.optional).map((a) => param(a, true))), sig(args.map((a) => param(a, true)))];
}

function restOf(type) {
  return type.includes(" | ") ? `(${type})[]` : `${type}[]`;
}

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

function argsObjectForSpec(spec, registryKeys) {
  const specArgs = spec?.arguments ?? [];
  const byName = new Map(specArgs.map((a) => [a.name, a]));
  const keys = registryKeys ?? specArgs.map((a) => a.name);
  if (keys.length === 0) return "Record<string, never>";
  const lines = ["{"];
  for (const k of keys) {
    const specArg = byName.get(k);
    const required = specArg !== undefined && !specArg.optional ? "Required. " : "";
    const type = mapType(specArg?.type);
    const desc = specArg?.description?.trim();
    if (desc) {
      const one = desc
        .split(/\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" ");
      lines.push(`  /** ${required}${one} */`);
    } else if (required !== "") lines.push(`  /** Required. */`);
    lines.push(`  ${quoteKeyIfNeeded(k)}?: ${type};`);
  }
  lines.push("}");
  return lines.join("\n");
}

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
      if (firstArg?.variadic === "array") {
        return [`(...${argName}: ${restOf(argType)}): any`];
      }
      return [`(${argName}: ${argType}): any`];
    }
    case "array": {
      const args = spec?.arguments ?? [];
      if (args.length >= 2 && args.every((a) => a.variadic === undefined)) return positionalSigs(args);
      const argName = firstArg?.name ?? "expressions";
      const argType = mapType(firstArg?.type);
      return [`(...${argName}: ${restOf(argType)}): any`];
    }
    case "object": {
      const argsObj = argsObjectForSpec(spec, opDef.shape.keys);
      return [`(args: ${argsObj}): any`];
    }
    case "none": {
      return ["(): any"];
    }
    case "verbatim": {
      const argName = firstArg?.name ?? "value";
      const argType = mapType(firstArg?.type);
      return [`(${argName}: ${argType}): any`];
    }
    case "flex": {
      const argName = firstArg?.name ?? "expression";
      const argType = mapType(firstArg?.type);
      return [`(${argName}: ${argType}): any`, `(...${argName}s: ${restOf(argType)}): any`];
    }
    default: {
      return ["(...args: any[]): any"];
    }
  }
}

const CATCH_ALL = "(...args: any[]): any";

function emitFunctionDecls(name, callableSigs) {
  const sigs = callableSigs.includes(CATCH_ALL) ? callableSigs : [...callableSigs, CATCH_ALL];
  return sigs.map((sig) => `function ${name}${sig.replace(/^\(/, "(")};`).join("\n");
}

function emitBlock(name, jsdoc, callableSigs) {
  return `${jsdoc}\n${emitFunctionDecls(name, callableSigs)}`;
}

function contextRefBlock(spec) {
  const methodsByScope = { collection: [], database: [], cluster: [] };
  for (const [stageName, def] of Object.entries(STAGES)) {
    if (def.diagnostic === undefined) continue;
    methodsByScope[def.diagnostic.scope].push(stageName);
  }

  const diagnosticMembers = (scope) => {
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
    return members;
  };
  const refJsdoc = (scope) =>
    `/**\n * ${CONTEXT_REFS[scope].doc}\n *\n * @see https://github.com/koresar/jsmql/blob/master/docs/specs/context-references.md\n */`;

  const chainableMembers = (returnType) => [
    ...streamMethodMembers(returnType, [...streamMethodNames(), ...NON_REGISTRY_STREAM_METHODS]),
    ...stageLinkMembers(spec, returnType),
  ];

  const foreignMembers = [
    "/** Join and take the FIRST match → `$lookup` + `$first`. One document or null, not an array. */",
    "find(predicate: ((doc: any) => any) | Record<string, any> | string): any;",
    ...chainableMembers(FOREIGN_REF_TYPE),
    "/** The stream's document count. Always the ROOT stream, at any nesting depth. */",
    "readonly length: number;",
    ...valueTerminalMembers(),
    "[Symbol.iterator](): Iterator<any>;",
    "[key: string]: any;",
  ];

  const streamRefMembers = [
    ...diagnosticMembers("collection"),
    ...streamMethodMembers(STREAM_REF_TYPE, ROOT_STREAM_ONLY_METHODS),
    ...chainableMembers(STREAM_REF_TYPE),
    "/** @deprecated Not a stream method — a pipeline is an array. Use `.filter(p).slice(0, 1)`. */",
    "find(...args: never[]): never;",
  ];

  const blocks = [
    `interface ${FOREIGN_REF_TYPE} {\n${foreignMembers.join("\n")}\n}`,
    `interface ${STREAM_REF_TYPE} extends ${FOREIGN_REF_TYPE} {\n${streamRefMembers.join("\n")}\n}`,
    `${refJsdoc("collection")}\nvar ${CONTEXT_REFS.collection.name}: ${STREAM_REF_TYPE};`,
    `${refJsdoc("database")}\nconst ${CONTEXT_REFS.database.name}: { [collection: string]: ${FOREIGN_REF_TYPE} };`,
    `${refJsdoc("cluster")}\nconst ${CONTEXT_REFS.cluster.name}: {\n${[...diagnosticMembers("cluster"), "[key: string]: any;"].join("\n")}\n};`,
  ];
  return blocks.join("\n");
}

function constructionFormsBlock() {
  return constructorGlobals()
    .filter(({ name }) => name !== "Date")
    .map(({ name, doc }) => {
      const jsdoc = `/**\n * ${doc}\n *\n * JSMQL emits a live BSON value, which is the only form the MongoDB driver\n * accepts in a query document.\n */`;
      return (
        `interface ${name}Constructor {\n` +
        "  (value?: any): any;\n" +
        "}\n" +
        jsdoc +
        `\nvar ${name}: ${name}Constructor;`
      );
    })
    .join("\n");
}

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

export function generateGlobalsSource() {
  const spec = loadSpec();

  const allNames = new Set([...Object.keys(STAGES), ...Object.keys(OPERATORS)]);

  const stageNames = [...allNames].filter((n) => n in STAGES).sort();
  const opOnlyNames = [...allNames].filter((n) => !(n in STAGES) && n in OPERATORS).sort();

  function blockFor(name) {
    const stageDef = STAGES[name];
    const opDef = OPERATORS[name];
    const stageSpec = spec.stage.get(name);
    const opSpec = spec.expression.get(name) ?? spec.accumulator.get(name);

    const sigs = [];
    if (stageDef) sigs.push(...stageCallableType(stageSpec));
    if (opDef) sigs.push(...expressionOpCallableType(opSpec, opDef));

    const uniqueSigs = [...new Set(sigs)];

    const jsdocSpec = stageSpec ?? opSpec;
    const jsdocDef = stageDef ?? opDef;
    const jsdoc = jsdocFor(name, jsdocSpec, jsdocDef);

    return emitBlock(name, jsdoc, uniqueSigs);
  }

  const stageBlocks = stageNames.map(blockFor).filter((s) => s !== null);
  const opBlocks = opOnlyNames.map(blockFor).filter((s) => s !== null);

  const header = [
    "// AUTO-GENERATED by scripts/generate-globals.mjs from src/registry/names.ts",
    "// and vendor/mql-specifications. DO NOT EDIT — re-run",
    "// `npm run generate:globals` (or `npm run build`) after you pull new specs.",
    "//",
    "// User-facing import shape:",
    "//",
    '//   import "@koresar/jsmql/globals";',
    "//",
    "// Surfaces every jsmql stage and operator as an ambient global with a",
    "// precise signature, JSDoc description, and link to the MongoDB docs.",
    "// Also declares the `$$` / `$$$` / `$$$$` context references, with",
    "// completion for the collection- and cluster-scoped diagnostic stages.",
    "// The compiled module exports nothing at runtime (`export {};`), so the",
    "// import resolves to an empty module — bundlers tree-shake it away. For",
    '// fully zero-runtime use, add `"@koresar/jsmql/globals"` to tsconfig',
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
    "  // ── BSON value constructors (ObjectId, Decimal128, …) ────────────────",
    indent(constructionFormsBlock()),
    "",
    "  // ── Statement-form built-ins (assert) ─────────────────────────────────",
    indent(statementFormsBlock()),
    "",
    "  // ── Value-method augmentations (Array<T> / String / Number) ───────────",
    indent(valueMethodAugmentationBlock()),
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

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const source = generateGlobalsSource();
  writeFileSync(OUT_PATH, source);
  const oxfmt = resolve(ROOT, "node_modules/.bin/oxfmt");
  if (existsSync(oxfmt)) {
    const r = spawnSync(oxfmt, [OUT_PATH], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`generate-globals: oxfmt exited with ${r.status}`);
      process.exit(r.status ?? 1);
    }
  }
  console.error(`generate-globals: wrote ${OUT_PATH}`);
}
