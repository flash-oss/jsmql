// Where the filter target agrees with JAVASCRIPT, and where it does not.
//
// A query document is the one a MongoDB developer writes by hand, so MongoDB's own
// rules apply to it: a field comparison is satisfied by any ELEMENT of an array
// value, and a path TRAVERSES an array in the middle. JavaScript does neither.
// This suite is the oracle for the whole boundary. Each source is EVALUATED as
// JavaScript over the fixture — the source with `$.` read as the document — and the
// ids that come back are compared with the ids the emitted query selects on a live
// mongod.
//
// The sources JavaScript answers differently sit in a table with a reason each, and
// are asserted to STILL differ, so a change cannot land silently: it moves the row.
// Three reasons cover them. MongoDB reads an ARRAY element-wise where JavaScript
// reads one value. JavaScript COERCES under a relational operator (`[2] > 1` is
// true). And JavaScript THROWS when a path walks through a missing intermediate.
//
// This suite self-skips (green) when no mongod is reachable, with an all-or-nothing guard.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Collection } from "mongodb";
import { filter } from "../src/compiler/index.ts";
import { liveClient } from "./fixtures/live.ts";

/** One document per shape a field can take: a scalar, every kind of array, absent, null, the wrong type. */
const DOCS = [
  { _id: 1, a: 1, s: "abyz", tags: ["vip", "x"], n: { v: 1 }, g: [{ r: { s: 1 } }], h: { g: [{ r: { s: 1 } }] } },
  { _id: 2, a: 2, s: "zz", tags: "vip", n: { v: 2 }, g: [{ r: [{ s: 1 }] }], h: [{ g: [{ r: { s: 1 } }] }] },
  { _id: 3, a: [1, 2], s: ["abyz"], tags: "a vip user", n: [{ v: 1 }], g: [{ r: { s: [1] } }] },
  { _id: 4, a: [1], s: 5, tags: [], n: [{ v: [1] }], g: [{ r: { s: 2 } }, { r: { s: 1 } }] },
  { _id: 5, a: [], s: null, tags: ["VIP"], n: { v: [1] }, g: [] },
  { _id: 6, a: null, tags: [["vip"]], n: { v: null }, g: { r: { s: 1 } } },
  { _id: 7, a: [null], s: "AB", tags: ["a", "b"], n: {} },
  { _id: 8, a: "1", s: "ab", tags: "ab", n: { v: "1" } },
  { _id: 9, a: true, s: "", tags: 5, n: 5 },
  { _id: 10, a: [[1]], s: ["zz", "abyz"], n: { v: { w: 1 } } },
  { _id: 11, a: 1.5, tags: null },
  { _id: 12 },
  { _id: 13, a: { k: 1 }, s: { k: 1 } },
  { _id: 14, a: 4, s: "yz", tags: ["vip"], n: { v: 4 } },
];

/** Sources whose query form must select exactly what JavaScript selects. */
const AGREE: readonly string[] = [
  '$.a === "1"',
  "$.a === true",
  "$.a === undefined",
  "$.a !== undefined",
  'typeof $.a === "string"',
  "$.n.v > 1",
  "$.n.v === null",
  // a path INSIDE an element body takes the rule again, PREFIX and all
  // a `.some` receiver is a path too: an array at its prefix is absent, where `.some` throws
  // `!p` is the COMPLEMENT of p's clause, so a tautology stays one
  "$.a > 1 || !($.a > 1)",
  // `.includes(x)` is a substring test, and the regex reads an array element-wise as JavaScript's
  // `.includes` reads the array: both select the string that holds the needle and the array that holds it
  '$.tags.includes("vip")',
  '$.tags.includes("a") && $.tags.includes("b")',
];

/**
 * The rule that moved most of this table: a JavaScript spelling emits the query a MongoDB
 * developer writes by hand, and MongoDB's own array semantics then apply.
 */
const ARRAY_RULE =
  "MongoDB's query language satisfies a field comparison when ANY ELEMENT of an array value satisfies it, and it TRAVERSES an array in the middle of a path. jsmql emits the query a MongoDB developer writes by hand — `{ a: { $gt: 18 } }` — so the server's own rules apply and the array documents are selected where JavaScript reads one value. Containment has its own spelling (`.has(x)`), an element test has `.some(e => …)`.";

/**
 * `.has(x)` is the Set spelling of membership, and a JavaScript array has no `.has`:
 * JavaScript throws, so it selects nothing. A query document is read through an
 * INDEX, so `.has(x)` emits the indexable form and MongoDB's own reading applies.
 */
const INDEXABLE_HAS =
  "`.has(x)` emits `{ f: x }` \u2014 MongoDB's \"equals, or is an array containing\" \u2014 which selects an array holding the needle and a field equal to it. JavaScript's Array has no `.has`, so JavaScript throws on every document and selects none.";

/** Sources JavaScript answers differently, and why. */
const DIVERGE: readonly { src: string; why: string }[] = [
  { src: '$.tags.has("vip")', why: INDEXABLE_HAS },
  { src: '$.tags.has("a") && $.tags.has("b")', why: INDEXABLE_HAS },
  { src: "$.a === 1", why: ARRAY_RULE },
  { src: "$.a !== 1", why: ARRAY_RULE },
  { src: "$.a === null", why: ARRAY_RULE },
  { src: "$.a !== null", why: ARRAY_RULE },
  { src: "$.a == null", why: ARRAY_RULE },
  { src: "$.a != null", why: ARRAY_RULE },
  { src: "$.a > 1", why: ARRAY_RULE },
  { src: 'typeof $.a === "number"', why: ARRAY_RULE },
  { src: 'typeof $.a !== "number"', why: ARRAY_RULE },
  { src: "$.n.v === 1", why: ARRAY_RULE },
  { src: "$.n.v !== undefined", why: ARRAY_RULE },
  { src: "$.n.v != null", why: ARRAY_RULE },
  { src: '$.s.startsWith("ab")', why: ARRAY_RULE },
  { src: '$.s.endsWith("yz")', why: ARRAY_RULE },
  { src: "$.s.match(/^ab/)", why: ARRAY_RULE },
  { src: "$.s.match(/b/)", why: ARRAY_RULE },
  { src: '$.s.startsWith("a") && $.s.endsWith("z")', why: ARRAY_RULE },
  { src: "$.n.some(i => i.v === 1)", why: ARRAY_RULE },
  { src: "$.g.some(i => i.r.s === 1)", why: ARRAY_RULE },
  { src: "$.g.some(i => i.r.s !== 1)", why: ARRAY_RULE },
  { src: "$.h.g.some(i => i.r.s === 1)", why: ARRAY_RULE },
  { src: "$.a === 1 && $.n.v === 1", why: ARRAY_RULE },
  { src: "$.a === 1 || $.a === 2", why: ARRAY_RULE },
  { src: "!($.a === 1)", why: ARRAY_RULE },
  { src: "!($.a === null)", why: ARRAY_RULE },
  {
    src: 'typeof $.a === "undefined"',
    why: 'By ruling, `typeof` uses MongoDB\'s type names: "undefined" is a MongoDB type, now deprecated in BSON, and selects nothing here, where JavaScript\'s `typeof` says "undefined" for an absent field. Absence is spelled `$.a === undefined`.',
  },
  {
    src: "!($.g.some(i => i.r.s === 1))",
    why: "The THROW family, at its widest. JavaScript THROWS both ways here — `.some` on a document that has no `g`, and `i.r.s` on an element that has no `r` — so it selects nothing at all. This language reads a path as a path: no element has `r.s` equal to 1, so the negation holds. The positive spelling agrees with JavaScript, because neither answer selects those documents.",
  },
  {
    src: '!($.tags.includes("vip"))',
    why: "The THROW family again, and only the negation shows it: JavaScript's `.includes` throws on a number, a null and a missing field, so it selects none of them, where the complement of the positive clause (`{ tags: { $not: /vip/ } }`) selects all three. The positive spelling agrees, because neither reading matches those values.",
  },
  {
    src: "$.a >= 1",
    why: 'JavaScript coerces under a relational operator: `[1] >= 1` is true, `"1" >= 1` is true, `true >= 1` is true. The query language brackets by type instead, and this language does not model the coercion — the same decision that leaves NaN unsupported.',
  },
  {
    src: "$.a < 2",
    why: "Coercion again, and in the other direction: `null < 2`, `[] < 2` and `[null] < 2` are all true in JavaScript, because each coerces to 0.",
  },
  {
    src: "$.a <= 1",
    why: 'Coercion: `[1] <= 1`, `"1" <= 1`, `true <= 1`, `[] <= 1` and `null <= 1` are true in JavaScript.',
  },
  {
    src: "$.a >= 1 && $.a <= 2",
    why: "Coercion, on both clauses. The two clauses merge into one field document, so the array documents JavaScript coerces are excluded once.",
  },
  {
    src: "$.a % 2 === 0",
    why: "Coercion: `null % 2`, `[] % 2` and `[null] % 2` are all 0 in JavaScript. `$mod` compares a number.",
  },
  {
    src: "$.a % 2 !== 0",
    why: "The query `$not` is generous where JavaScript is not: it selects a null, an empty array and a missing field, where JavaScript coerces each to 0 and answers false.",
  },
  {
    src: "$.n.v !== 1",
    why: "JavaScript THROWS when reading `n.v` where `n` is absent, so the document is not selected; a path in this language is a path, and an absent path is absent, which `!==` satisfies.",
  },
  {
    src: "$.n.v === undefined",
    why: "The same THROW: JavaScript cannot read `n.v` where `n` is absent, where this language answers that the field is absent.",
  },
  { src: "$.n.v == null", why: "The same THROW, through the loose spelling." },
];

let client: MongoClient | null = null;
let coll: Collection | null = null;

beforeAll(async () => {
  client = await liveClient();
  // Null means the instance is not running, and only that: liveClient throws on any
  // other refusal rather than letting this suite skip itself green.
  if (client === null) return;
  const c = client;
  coll = c.db("jsmql_compiler_js_agreement").collection("t");
  await coll.deleteMany({});
  await coll.insertMany(DOCS.map((d) => ({ ...d })));
});

afterAll(async () => {
  await client?.close();
});

/**
 * The source as JavaScript over one document: `$.` IS the document. A throw is
 * false — a predicate that throws selects nothing.
 */
function javascriptIds(src: string): number[] {
  const read = new Function("d", `try { return !!(${src.split("$.").join("d.")}) } catch { return false }`) as (
    d: unknown,
  ) => boolean;
  return DOCS.filter((d) => read(d)).map((d) => d._id);
}

const queryIds = async (src: string): Promise<number[]> =>
  (await coll!.find(filter(src)).toArray()).map((d) => d._id as number).sort((x, y) => x - y);

let ran = 0;
let skipped = 0;

describe("compiler — the query road selects what JavaScript selects", () => {
  for (const src of AGREE) {
    it(src, async () => {
      if (coll === null) {
        skipped++;
        return;
      }
      ran++;
      expect(await queryIds(src), `${src}\n  ${JSON.stringify(filter(src))}`).toEqual(javascriptIds(src));
    });
  }
});

describe("compiler — the sources JavaScript answers differently still differ", () => {
  for (const { src, why } of DIVERGE) {
    it(src, async () => {
      if (coll === null) {
        skipped++;
        return;
      }
      ran++;
      expect(await queryIds(src), `${src} now agrees with JavaScript — move it to AGREE.\n  ${why}`).not.toEqual(
        javascriptIds(src),
      );
    });
  }
});

describe("compiler — the JavaScript oracle says whether it ran", () => {
  it("compared every source, or none", () => {
    const total = AGREE.length + DIVERGE.length;
    expect(ran === total || skipped === total, `ran ${ran}, skipped ${skipped}, of ${total}`).toBe(true);
  });
});
