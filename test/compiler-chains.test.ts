// Every read chain against the rules that HR5 states, on a live mongod.
//
// A read chain is a path and then reads: `.b`, `?.b`, `[$.kb]`, `?.[$.kb]`, with at most
// one method at the end, under a dot or a `?.`. This suite writes each chain from a small
// grammar. It runs each chain over documents that hold each kind of value at each level.
// It compares each answer with an oracle that states the rules in plain JavaScript:
//
//   - A field read `.b` reads as a field path: the field of an object, or the field of
//     each element of an array. Anything else gives missing.
//   - An index read `[k]` reads the field `k` of an object, the element of an array for a
//     number key, and missing for anything else. A missing key reads no field.
//   - A method under a dot on a null or missing value runs on its empty value: `.uniq()`
//     answers `[]`, and a string method answers null.
//   - A `?.` with a method after it stops the chain where the value before the LAST `?.`
//     is null or missing. The chain then answers null.
//   - A `?.` read with no method after it answers null where the value is missing.
//
// The oracle never calls the compiler, so each answer that it gives can fail. A chain
// whose method meets a value of the wrong kind is left to the server, as the language
// says, and the oracle skips that document. See docs/LANG_RULES.md HR5 and
// docs/LANGUAGE.md § Optional Chaining.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Collection, MongoClient } from "mongodb";
import { jsmql } from "../src/index.ts";
import { liveClient } from "./fixtures/live.ts";

const up = await liveClient();
await up?.close();

// ── the grammar ──────────────────────────────────────────────────────────────

type Read = { readonly name: "b" | "c" | "d"; readonly optional: boolean; readonly computed: boolean };
type Method = { readonly name: "trim" | "uniq"; readonly optional: boolean };
type Chain = { readonly src: string; readonly reads: readonly Read[]; readonly method: Method | null };

const readsFor = (name: Read["name"], withComputedOptional: boolean): Read[] => [
  { name, optional: false, computed: false },
  { name, optional: true, computed: false },
  { name, optional: false, computed: true },
  ...(withComputedOptional ? [{ name, optional: true, computed: true }] : []),
];
const spell = (r: Read): string =>
  r.computed ? `${r.optional ? "?." : ""}[$.k${r.name}]` : `${r.optional ? "?." : "."}${r.name}`;
const METHODS: (Method | null)[] = [
  null,
  { name: "trim", optional: false },
  { name: "trim", optional: true },
  { name: "uniq", optional: false },
  { name: "uniq", optional: true },
];

const CHAINS: Chain[] = [];
for (const b of readsFor("b", true)) {
  const tails: Read[][] = [[]];
  for (const c of readsFor("c", true)) {
    tails.push([c]);
    for (const d of readsFor("d", false)) tails.push([c, d]);
  }
  for (const tail of tails) {
    const reads = [b, ...tail];
    for (const method of METHODS) {
      const call = method === null ? "" : `${method.optional ? "?." : "."}${method.name}()`;
      CHAINS.push({ src: `$.a${reads.map(spell).join("")}${call}`, reads, method });
    }
  }
}

// ── the documents ────────────────────────────────────────────────────────────

// Each level holds each kind of value: missing, null, a string, an array, and an object
// that holds the next level. An array of objects checks the field path through an array.
const D = [undefined, null, " w ", [3, 3]];
const C = [undefined, null, " x ", [2, 2], ...D.map((d) => (d === undefined ? {} : { d }))];
const B = [
  undefined,
  null,
  " y ",
  [1, 1],
  [{ c: " x " }, { c: " y " }],
  ...C.map((c) => (c === undefined ? {} : { c })),
];
const A = [undefined, null, "s", 5, [1, 1], ...B.map((b) => (b === undefined ? {} : { b }))];
const KEYS = { kb: "b", kc: "c", kd: "d" };
const DOCS: Record<string, unknown>[] = [
  ...A.map((a, i) => ({ _id: i, ...KEYS, ...(a === undefined ? {} : { a }) })),
  // a number key reads an element of an array, and a missing key reads no field
  { _id: 100, a: [" p ", " q "], kb: 1, kc: "c", kd: "d" },
  { _id: 101, a: { b: { c: " x " } } },
];

// ── the oracle ───────────────────────────────────────────────────────────────

const MISSING = Symbol("missing");
const SKIP = Symbol("skip");
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A field read as a field path reads it: the field of an object, of each element of an array. */
function fieldOf(v: unknown, name: string): unknown {
  if (isObject(v)) return name in v ? v[name] : MISSING;
  if (Array.isArray(v))
    return v
      .filter(isObject)
      .filter((e) => name in e)
      .map((e) => e[name]);
  return MISSING;
}

/** An index read: the element of an array for a number key, the field of an object. */
function indexOf(v: unknown, key: unknown): unknown {
  if (Array.isArray(v)) return typeof key === "number" && key >= 0 && key < v.length ? v[key] : MISSING;
  if (!isObject(v) || key === MISSING || key === null) return MISSING;
  return String(key) in v ? v[String(key)] : MISSING;
}

function readAll(doc: Record<string, unknown>, reads: readonly Read[]): unknown {
  let v: unknown = "a" in doc ? doc.a : MISSING;
  for (const r of reads)
    v = r.computed ? indexOf(v, `k${r.name}` in doc ? doc[`k${r.name}`] : MISSING) : fieldOf(v, r.name);
  return v;
}

const absent = (v: unknown): boolean => v === MISSING || v === null;

/** The method under a dot: a null or missing receiver runs on its empty value. */
function apply(method: Method, v: unknown): unknown {
  if (method.name === "trim") return absent(v) ? null : typeof v === "string" ? v.trim() : SKIP;
  if (absent(v)) return [];
  return Array.isArray(v) ? [...new Set(v.map((e) => JSON.stringify(e)))].map((e) => JSON.parse(e)) : SKIP;
}

function oracle(chain: Chain, doc: Record<string, unknown>): unknown {
  const flags = [...chain.reads.map((r) => r.optional), ...(chain.method === null ? [] : [chain.method.optional])];
  const last = flags.lastIndexOf(true);
  if (chain.method === null) {
    const v = readAll(doc, chain.reads);
    return last >= 0 && v === MISSING ? null : v;
  }
  // The `?.` stops the chain on the value before it.
  if (last >= 0 && absent(readAll(doc, chain.reads.slice(0, last)))) return null;
  return apply(chain.method, readAll(doc, chain.reads));
}

/** An answer in a form that compares: a set union has no order. */
const canonical = (chain: Chain, v: unknown): string =>
  v === MISSING
    ? "missing"
    : JSON.stringify(
        chain.method?.name === "uniq" && Array.isArray(v) ? [...v].map((e) => JSON.stringify(e)).sort() : v,
      );

// ── the suite ────────────────────────────────────────────────────────────────

describe("compiler — every read chain compiles", () => {
  it("covers each shape of the grammar", () => {
    expect(CHAINS.length).toBe(340);
    expect(CHAINS.map((c) => c.src)).toContain("$.a?.b.c.uniq()");
    expect(CHAINS.map((c) => c.src)).toContain("$.a?.[$.kb]?.c");
  });

  it("compiles each chain", () => {
    const refused = CHAINS.flatMap((c) => {
      try {
        jsmql.expr(c.src);
        return [];
      } catch (e) {
        return [`${c.src}: ${(e as Error).message}`];
      }
    });
    expect(refused).toEqual([]);
  });
});

describe.skipIf(up === null)("compiler — every read chain answers as HR5 states, on the server", () => {
  let client: MongoClient;
  let coll: Collection;
  let ran = 0;
  beforeAll(async () => {
    client = (await liveClient())!;
    coll = client.db("jsmql_compiler_methods").collection("chains");
    await coll.deleteMany({});
    await coll.insertMany(DOCS as never[]);
  });
  afterAll(async () => {
    await client?.close();
  });

  it("gives the oracle's answer for each chain over each document", async () => {
    const wrong: string[] = [];
    for (const chain of CHAINS) {
      const expected = new Map<unknown, unknown>();
      for (const doc of DOCS) {
        const v = oracle(chain, doc);
        if (v !== SKIP) expected.set(doc._id, v);
      }
      let out: Record<string, unknown>[];
      try {
        out = await coll
          .aggregate([
            { $match: { _id: { $in: [...expected.keys()] } } },
            { $addFields: { __v: jsmql.expr(chain.src) } },
            { $sort: { _id: 1 } },
          ])
          .toArray();
      } catch (e) {
        // A refusal is an answer too: the rule gives a value for each of these documents.
        wrong.push(`${chain.src}: the server refused it: ${(e as Error).message}`);
        continue;
      } finally {
        ran++;
      }
      for (const doc of out) {
        const got = canonical(chain, "__v" in doc ? doc.__v : MISSING);
        const want = canonical(chain, expected.get(doc._id));
        if (got !== want)
          wrong.push(
            `${chain.src} over ${JSON.stringify(DOCS.find((d) => d._id === doc._id))}: ${got}, the rule gives ${want}`,
          );
      }
    }
    expect(wrong.slice(0, 20), `${wrong.length} answers differ`).toEqual([]);
  });

  it("ran each chain on the server", () => {
    expect(ran).toBe(CHAINS.length);
  });
});
