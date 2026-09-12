// THE proof behind every `returns` in the registry: ask mongod.
//
// `returns` is MEASURED data, so only a re-measurement can catch it rotting. A
// `toEqual` cannot, and neither can the vendored spec — its `type:` field says
// `resolvesToString` for `$trunc`, the one operator where the three sources
// disagree, and the reason the process is written down in `MongoSpec.returns`.
//
// The call is built from two things already in the repo: the vendored spec's
// `arguments[].type` (what each operand must resolve to) and the registry's own
// `shape` (how the operands are written). So a new operator is covered the day
// its row lands, and only the calls a generator cannot express are listed here.
//
// It skips itself when no mongod is listening, so `npm test` stays green.

import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { Binary, BSONRegExp, Decimal128, Double, Int32, Long, MongoClient, ObjectId, Timestamp } from "mongodb";
import { NAMES } from "../src/registry/names.ts";
import type { Position } from "../src/registry/vocabulary.ts";
import { SCRATCH_URI } from "./fixtures/config.ts";

const URI = SCRATCH_URI;

async function reachable(): Promise<boolean> {
  const probe = new MongoClient(URI, { serverSelectionTimeoutMS: 700 });
  try {
    await probe.connect();
    await probe.db("admin").command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
}

const up = await reachable();
if (!up) {
  console.warn(
    `\n[returns] no mongod on ${URI} — skipping the returns-agree-with-the-server suite.` +
      "\n[returns] Start one to run it; see CLAUDE.md § Verify MQL against a running MongoDB.\n",
  );
}

// ── the seed document: one field per BSON type the specs can ask for ─────────

const DOC: Record<string, unknown> = {
  str: "abc",
  str2date: "2020-06-15T10:20:30Z",
  jsonObj: '{"a":1}',
  jsonArr: "[1,2]",
  int: new Int32(4),
  dbl: new Double(2.5),
  lng: Long.fromNumber(7),
  dec: Decimal128.fromString("1.5"),
  bool: true,
  arr: [1, 2, 3],
  pairs: [["k", 1]],
  obj: { a: 1, b: 2 },
  date: new Date("2020-06-15T10:20:30.400Z"),
  oid: new ObjectId("65a1b2c3d4e5f60718293a4b"),
  bin: new Binary(Buffer.from("0123456789abcdef", "hex"), 0),
  re: new BSONRegExp("a", "i"),
  ts: new Timestamp({ t: 1600000000, i: 1 }),
  nul: null,
};

/** A vendored operand type → the field that satisfies it. */
const FOR_TYPE: Readonly<Record<string, string>> = {
  resolvesToString: "$str",
  string: "$str",
  resolvesToNumber: "$int",
  resolvesToInt: "$int",
  resolvesToDouble: "$dbl",
  resolvesToLong: "$lng",
  resolvesToDecimal: "$dec",
  int: "$int",
  number: "$int",
  resolvesToBool: "$bool",
  bool: "$bool",
  resolvesToArray: "$arr",
  array: "$arr",
  resolvesToObject: "$obj",
  object: "$obj",
  resolvesToDate: "$date",
  date: "$date",
  resolvesToObjectId: "$oid",
  objectId: "$oid",
  resolvesToBinData: "$bin",
  binData: "$bin",
  resolvesToTimestamp: "$ts",
  timestamp: "$ts",
  regex: "$re",
  resolvesToNull: "$nul",
  resolvesToAny: "$int",
  any: "$int",
};

/** A mongod `$type` string → the coarse kind the registry states. */
const OF_BSON: Readonly<Record<string, string>> = {
  int: "number",
  double: "number",
  long: "number",
  decimal: "number",
  string: "string",
  bool: "bool",
  array: "array",
  date: "date",
  object: "object",
  objectId: "objectId",
  binData: "binData",
  regex: "regex",
  timestamp: "timestamp",
};

// ── the calls a generator cannot express ─────────────────────────────────────

type Slot = "value" | "group" | "window";
type Call = Partial<Record<Slot, unknown>>;

/**
 * Operators whose operands are constrained beyond their declared TYPE — a
 * required enum, an input that must be a JSON string, a domain of [-1,1], a
 * window that needs bounds. Each entry is the call that was measured.
 */
const BY_HAND: Readonly<Record<string, Call>> = {
  $hash: { value: { $hash: { input: "$str", algorithm: "sha256" } } },
  $hexHash: { value: { $hexHash: { input: "$str", algorithm: "sha256" } } },
  $toArray: { value: { $toArray: "$jsonArr" } },
  $toObject: { value: { $toObject: "$jsonObj" } },
  $arrayToObject: { value: { $arrayToObject: ["$pairs"] } },
  $toObjectId: { value: { $toObjectId: "$oid" } },
  $toUUID: { value: { $toUUID: "abcdefab-1234-5678-9abc-def012345678" } },
  $toDate: { value: { $toDate: "$str2date" } },
  $dateFromString: { value: { $dateFromString: { dateString: "2020-06-15T10:20:30Z" } } },
  $dateDiff: { value: { $dateDiff: { startDate: "$date", endDate: "$date", unit: "day" } } },
  $dateFromParts: { value: { $dateFromParts: { year: 2020 } } },
  $getField: { value: { $getField: { field: "a", input: "$obj" } } },
  $setField: { value: { $setField: { field: "a", input: "$obj", value: 1 } } },
  $unsetField: { value: { $unsetField: { field: "a", input: "$obj" } } },
  $regexFind: { value: { $regexFind: { input: "$str", regex: "a" } } },
  $tsIncrement: { value: { $tsIncrement: "$ts" } },
  $tsSecond: { value: { $tsSecond: "$ts" } },
  $asin: { value: { $asin: 0.5 } },
  $acos: { value: { $acos: 0.5 } },
  $atanh: { value: { $atanh: 0.5 } },
  $ifNull: { value: { $ifNull: ["$nul", "$int"] } },
  $arrayElemAt: { value: { $arrayElemAt: ["$arr", 0] } },
  $setEquals: { value: { $setEquals: ["$arr", "$arr"] } },
  $stdDevSamp: { value: { $stdDevSamp: ["$int", "$dbl"] } },
  $stdDevPop: { value: { $stdDevPop: ["$int", "$dbl"] } },
  $median: { value: { $median: { input: "$arr", method: "approximate" } } },
  $percentile: { value: { $percentile: { input: "$arr", p: [0.5], method: "approximate" } } },
  $filter: { value: { $filter: { input: "$arr", as: "x", cond: true } } },
  $map: { value: { $map: { input: "$arr", as: "x", in: "$$x" } } },
  $zip: { value: { $zip: { inputs: ["$arr"] } } },
  $reduce: { value: { $reduce: { input: "$arr", initialValue: 0, in: "$$value" } } },
  $sortArray: { value: { $sortArray: { input: "$arr", sortBy: 1 } } },
  $convert: { value: { $convert: { input: "$int", to: "string" } } },
  $let: { value: { $let: { vars: { v: "$int" }, in: "$$v" } } },
  $switch: { value: { $switch: { branches: [{ case: true, then: "$int" }], default: "$int" } } },
  $literal: { value: { $literal: 5 } },
  $rand: { value: { $rand: {} } },
  $function: { value: { $function: { body: "function(){ return 1 }", args: [], lang: "js" } } },
  $firstN: { group: { $firstN: { input: "$int", n: 1 } } },
  $lastN: { group: { $lastN: { input: "$int", n: 1 } } },
  $maxN: { group: { $maxN: { input: "$int", n: 1 } } },
  $minN: { group: { $minN: { input: "$int", n: 1 } } },
  $top: { group: { $top: { output: "$int", sortBy: { _ord: 1 } } } },
  $bottom: { group: { $bottom: { output: "$int", sortBy: { _ord: 1 } } } },
  $topN: { group: { $topN: { output: "$int", sortBy: { _ord: 1 }, n: 1 } } },
  $bottomN: { group: { $bottomN: { output: "$int", sortBy: { _ord: 1 }, n: 1 } } },
  $accumulator: {
    group: {
      $accumulator: {
        init: "function(){ return 0 }",
        accumulate: "function(s){ return s }",
        accumulateArgs: [],
        merge: "function(a,b){ return a }",
        lang: "js",
      },
    },
  },
  $expMovingAvg: { window: { $expMovingAvg: { input: "$int", N: 2 } } },
  $shift: { window: { $shift: { output: "$int", by: 1 } } },
  $covariancePop: { window: { $covariancePop: ["$int", "$dbl"] } },
  $covarianceSamp: { window: { $covarianceSamp: ["$int", "$dbl"] } },
  $derivative: {
    window: { $derivative: { input: "$int", unit: "second" }, window: { range: [-20, 0], unit: "second" } },
  },
  $integral: { window: { $integral: { input: "$int", unit: "second" }, window: { range: [-20, 0], unit: "second" } } },
};

/**
 * Operators the SERVER cannot be asked about, with the reason. Not a filter — the
 * suite asserts this set is exactly the set it failed to measure, so an operator
 * that silently stops running shows up as a new name here.
 */
const CANNOT_MEASURE: Readonly<Record<string, string>> = {
  $encStrContains:
    "Queryable Encryption: 'ExpressionEncTextSearch expects a constant literal' without encrypted fields",
  $encStrEndsWith: "Queryable Encryption, as above",
  $encStrNormalizedEq: "Queryable Encryption, as above",
  $encStrStartsWith: "Queryable Encryption, as above",
  $meta: "needs $search metadata, which a non-Atlas server does not produce",
  $case: "not an operator on its own — a branch key inside $switch",
};

/**
 * The two differently-typed calls that PROVE a `"unknown"` row is right to say
 * so. A row claiming to vary must be shown to vary, or the claim is a shrug.
 */
const VARIES_BY_OPERAND: Readonly<Record<string, { slot: Slot; a: unknown; b: unknown }>> = {
  $add: { slot: "value", a: { $add: ["$int", 1] }, b: { $add: ["$date", 1000] } },
  $subtract: { slot: "value", a: { $subtract: ["$int", 1] }, b: { $subtract: ["$date", 1000] } },
  $cond: { slot: "value", a: { $cond: [true, "$int", "$int"] }, b: { $cond: [true, "$str", "$str"] } },
  $ifNull: { slot: "value", a: { $ifNull: [null, "$int"] }, b: { $ifNull: [null, "$str"] } },
  $switch: {
    slot: "value",
    a: { $switch: { branches: [{ case: true, then: "$int" }] } },
    b: { $switch: { branches: [{ case: true, then: "$str" }] } },
  },
  $arrayElemAt: { slot: "value", a: { $arrayElemAt: ["$arr", 0] }, b: { $arrayElemAt: [["$str"], 0] } },
  $first: { slot: "value", a: { $first: "$arr" }, b: { $first: [["$str"]] } },
  $last: { slot: "value", a: { $last: "$arr" }, b: { $last: [["$str"]] } },
  $reduce: {
    slot: "value",
    a: { $reduce: { input: "$arr", initialValue: 0, in: "$$value" } },
    b: { $reduce: { input: "$arr", initialValue: "x", in: "$$value" } },
  },
  $getField: {
    slot: "value",
    a: { $getField: { field: "a", input: { a: 1 } } },
    b: { $getField: { field: "a", input: { a: "x" } } },
  },
  $convert: {
    slot: "value",
    a: { $convert: { input: "$int", to: "string" } },
    b: { $convert: { input: "$int", to: "double" } },
  },
  $literal: { slot: "value", a: { $literal: 5 }, b: { $literal: "x" } },
  $let: {
    slot: "value",
    a: { $let: { vars: { v: "$int" }, in: "$$v" } },
    b: { $let: { vars: { v: "$str" }, in: "$$v" } },
  },
  $function: {
    slot: "value",
    a: { $function: { body: "function(){ return 1 }", args: [], lang: "js" } },
    b: { $function: { body: "function(){ return 'x' }", args: [], lang: "js" } },
  },
  $max: { slot: "group", a: { $max: "$int" }, b: { $max: "$str" } },
  $min: { slot: "group", a: { $min: "$int" }, b: { $min: "$str" } },
  $top: {
    slot: "group",
    a: { $top: { output: "$int", sortBy: { _ord: 1 } } },
    b: { $top: { output: "$str", sortBy: { _ord: 1 } } },
  },
  $bottom: {
    slot: "group",
    a: { $bottom: { output: "$int", sortBy: { _ord: 1 } } },
    b: { $bottom: { output: "$str", sortBy: { _ord: 1 } } },
  },
  $accumulator: {
    slot: "group",
    a: {
      $accumulator: {
        init: "function(){ return 0 }",
        accumulate: "function(s){ return s }",
        accumulateArgs: [],
        merge: "function(a,b){ return a }",
        lang: "js",
      },
    },
    b: {
      $accumulator: {
        init: "function(){ return 'x' }",
        accumulate: "function(s){ return s }",
        accumulateArgs: [],
        merge: "function(a,b){ return a }",
        lang: "js",
      },
    },
  },
  $locf: { slot: "window", a: { $locf: "$int" }, b: { $locf: "$str" } },
  $shift: { slot: "window", a: { $shift: { output: "$int", by: 1 } }, b: { $shift: { output: "$str", by: 1 } } },
};

// ── the generated call ───────────────────────────────────────────────────────

type SpecArg = { name: string; type?: unknown; optional?: boolean };
type Spec = { name: string; arguments?: SpecArg[] };

function loadSpecs(): Map<string, Spec> {
  const root = resolve(import.meta.dirname, "../vendor/mql-specifications/definitions");
  const out = new Map<string, Spec>();
  for (const folder of ["expression", "accumulator", "query"]) {
    for (const file of readdirSync(resolve(root, folder))) {
      if (!file.endsWith(".yaml")) continue;
      let txt = readFileSync(resolve(root, folder, file), "utf8");
      // The tests: block carries custom BSON tags js-yaml's schema rejects, and
      // only the metadata above it is read here.
      const i = txt.indexOf("\ntests:");
      if (i >= 0) txt = txt.slice(0, i);
      const doc = yaml.load(txt) as Spec | undefined;
      if (doc?.name !== undefined && !out.has(doc.name)) out.set(doc.name, doc);
    }
  }
  return out;
}

type Shape = "single" | "array" | "none" | "flex" | { object: BodyShape };
type BodyShape = {
  required: readonly string[];
  optional: readonly string[];
  enums?: Record<string, readonly string[]>;
};
type Row = { kind?: string; where?: readonly Position[]; shape?: Shape; returns?: unknown };

function operandFor(arg: SpecArg): string {
  const list = Array.isArray(arg.type) ? arg.type : [arg.type];
  const first = list.map((x) => (typeof x === "string" ? x : (x as { name?: string })?.name))[0];
  return FOR_TYPE[first ?? ""] ?? "$int";
}

/** A well-typed call, from the vendored argument types and the registry shape. */
function buildCall(name: string, row: Row, spec: Spec | undefined): unknown {
  const required = (spec?.arguments ?? []).filter((a) => a.optional !== true);
  const shape = row.shape;
  if (shape === "none") return { [name]: {} };
  if (typeof shape === "object") {
    const keys = shape.object.required.length > 0 ? shape.object.required : shape.object.optional;
    const body: Record<string, unknown> = {};
    for (const k of keys) {
      const enums = shape.object.enums?.[k];
      const arg = (spec?.arguments ?? []).find((a) => a.name === k);
      body[k] = enums !== undefined ? enums[0] : arg !== undefined ? operandFor(arg) : "$int";
    }
    return { [name]: body };
  }
  if (required.length === 0) return { [name]: "$int" };
  if (shape === "single") return { [name]: operandFor(required[0]) };
  return { [name]: required.map(operandFor) };
}

const PRODUCES: readonly Position[] = ["value", "group", "window"];

describe.skipIf(!up)("registry — every `returns` agrees with mongod", () => {
  let coll: ReturnType<ReturnType<MongoClient["db"]>["collection"]>;
  const specs = loadSpecs();

  beforeAll(async () => {
    const client = new MongoClient(URI);
    await client.connect();
    coll = client.db("jsmql_returns_agrees").collection("t");
    await coll.deleteMany({});
    // Two documents with DISTINCT sort keys: a window function refuses a
    // repeated sortBy value, and a sample of one makes $stdDevSamp null.
    await coll.insertMany([
      { ...DOC, _ord: 1 },
      { ...DOC, _ord: 2, int: new Int32(9), str: "bcd", date: new Date("2020-06-15T10:20:40.400Z") },
    ]);
    return async () => {
      await client.close();
    };
  });

  /** The kinds mongod reports for `expr` in `slot`, or why it could not be asked. */
  async function kindsOf(
    expr: unknown,
    slot: Slot,
  ): Promise<{ ok: true; kinds: string[] } | { ok: false; why: string }> {
    const stages: Record<Slot, object[]> = {
      value: [{ $addFields: { __v: expr } }],
      group: [{ $group: { _id: null, __v: expr } }],
      window: [{ $setWindowFields: { sortBy: { date: 1 }, output: { __v: expr } } }],
    };
    try {
      const rows = await coll.aggregate([...stages[slot], { $addFields: { __t: { $type: "$__v" } } }]).toArray();
      const bson = [...new Set(rows.map((r) => r.__t as string))].filter((t) => t !== "missing" && t !== "null");
      if (bson.length === 0) return { ok: false, why: "every result was null or missing" };
      return { ok: true, kinds: [...new Set(bson.map((b) => OF_BSON[b] ?? b))] };
    } catch (e) {
      return {
        ok: false,
        why: String((e as Error).message)
          .replace(/\s+/g, " ")
          .replace(/^.*caused by :: /, ""),
      };
    }
  }

  /** A refusal that is about the SERVER, not about the call. */
  const environmental = (why: string): boolean =>
    why.includes("feature compatibility version") || why.includes("Unrecognized expression");

  it("reports the kind each invariant row states", async () => {
    const wrong: string[] = [];
    const unmeasured: string[] = [];
    const gated: string[] = [];
    let checked = 0;

    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      if (row.kind !== "mongo") continue;
      if (!PRODUCES.some((p) => row.where?.includes(p) === true)) continue;
      if (row.returns === "unknown") continue; // proved to vary, below
      if (CANNOT_MEASURE[name] !== undefined) continue;

      const hand = BY_HAND[name];
      const slots: Slot[] =
        row.where?.includes("value") === true
          ? ["value", "group", "window"]
          : row.where?.includes("group") === true
            ? ["group", "window"]
            : ["window"];
      let answered = false;
      const why: string[] = [];
      for (const slot of slots) {
        const expr = hand !== undefined ? hand[slot] : buildCall(name, row, specs.get(name));
        if (expr === undefined) continue;
        const r = await kindsOf(expr, slot);
        if (!r.ok) {
          why.push(r.why);
          continue;
        }
        answered = true;
        checked++;
        if (r.kinds.length !== 1 || r.kinds[0] !== row.returns) {
          wrong.push(`${name} in ${slot}: registry says ${String(row.returns)}, mongod says ${r.kinds.join("/")}`);
        }
        break;
      }
      if (!answered) (why.some(environmental) ? gated : unmeasured).push(`${name}: ${why[0] ?? "no slot to try"}`);
    }

    expect(wrong).toEqual([]);
    // A suite that quietly stops measuring is worse than none. Anything it could
    // not ask about must be a NAMED environment limitation, never a surprise.
    expect(unmeasured).toEqual([]);
    // 149 of the 159 invariant rows are measurable on a mongod at FCV 8.0; the
    // rest need a newer one. Tightened until it failed, so a real degradation
    // cannot pass as a version difference.
    expect(checked).toBeGreaterThanOrEqual(145);
    if (gated.length > 0) {
      console.warn(
        `[returns] ${gated.length} operator(s) this server cannot run: ${gated.map((g) => g.split(":")[0]).join(", ")}`,
      );
    }
  });

  it("states `unknown` exactly where the kind follows the operands", async () => {
    // Checked from the PAIRS, not from the rows: asking "does every `unknown` row
    // vary" leaves the other direction open, and a row that quietly claims to be
    // invariant is the more dangerous of the two — it makes the type check reject
    // valid code. So each pair decides what its row must say.
    const wrong: string[] = [];
    for (const [name, pair] of Object.entries(VARIES_BY_OPERAND)) {
      const row = (NAMES as Record<string, Row>)[name];
      expect(row, `${name} has a varying-operand pair but no row`).toBeDefined();
      const a = await kindsOf(pair.a, pair.slot);
      const b = await kindsOf(pair.b, pair.slot);
      // An operand the server refuses is itself proof the type is constrained,
      // and says nothing about whether the accepted one varies.
      if (!a.ok || !b.ok) continue;
      const varies = a.kinds.join("/") !== b.kinds.join("/");
      if (varies && row.returns !== "unknown") {
        wrong.push(
          `${name}: answers ${a.kinds.join("/")} and ${b.kinds.join("/")}, but the row says ${String(row.returns)}`,
        );
      }
      if (!varies && row.returns === "unknown") {
        wrong.push(`${name}: both calls answered ${a.kinds.join("/")} — the row should say so, not "unknown"`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("proves or names every `unknown` row", async () => {
    // `"unknown"` is a measured fact, so each row claiming it owes either a pair
    // above that shows it varying, or a named reason the server cannot be asked.
    const unproven: string[] = [];
    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      if (row.kind !== "mongo" || row.returns !== "unknown") continue;
      if (CANNOT_MEASURE[name] !== undefined) continue;
      if (VARIES_BY_OPERAND[name] === undefined) unproven.push(name);
    }
    expect(unproven).toEqual([]);
  });

  it("cannot measure exactly the operators it says it cannot", async () => {
    // The names in CANNOT_MEASURE are claims about the SERVER. If one starts
    // working, the entry is stale and the row should be measured like the rest.
    const nowWorking: string[] = [];
    for (const [name, reason] of Object.entries(CANNOT_MEASURE)) {
      const row = (NAMES as Record<string, Row>)[name];
      expect(row, `${name} is named unmeasurable but has no row`).toBeDefined();
      const hand = BY_HAND[name];
      if (hand === undefined) continue; // no call to try — nothing can start working
      for (const [slot, expr] of Object.entries(hand) as [Slot, unknown][]) {
        const r = await kindsOf(expr, slot);
        if (r.ok) nowWorking.push(`${name} now answers ${r.kinds.join("/")} — drop it (${reason})`);
      }
    }
    expect(nowWorking).toEqual([]);
  });
});
