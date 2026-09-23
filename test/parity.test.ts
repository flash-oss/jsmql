// test/parity.test.ts — the value/stream parity gate.
//
// A method name the value and the stream registries both list carries TWO lowerings: a value form (an array inside a document,
// `$.rows.take(2)`) and a stream form (the pipeline's documents, `$$ = $$.take(2)`).
// The two live in different files and share no code, so nothing structural keeps them
// meaning the same thing. This suite runs both against the same documents on a real
// mongod and compares the results.
//
// What IS contracted: which elements survive, and what shape they come back in. A
// sort also contracts the ORDER, because the order is what the developer wrote.
// What is NOT contracted: the order of any other method's result. Where a JavaScript or lodash runtime carries an
// ordering guarantee the developer never wrote, jsmql takes MongoDB's behaviour and the
// smaller MQL — see SR2 in docs/LANG_RULES.md. `.uniqBy` is the worked example: the value
// form preserves input order through `$reduce`, the stream form uses `$group` and does not.
//
// Connects to a local mongod and SKIPS ITSELF (green) when none is reachable, matching
// fold-consistency.test.ts. A coverage floor below keeps a self-skip from hollowing the
// suite out silently.

import { afterAll, describe, expect, it } from "vitest";
import type { Db, MongoClient } from "mongodb";
import { jsmql } from "../src/index.ts";
import { valueMethodNames } from "../src/compiler/rows.ts";
import { streamMethodNames } from "../src/compiler/rows.ts";
import { announceSkip, liveClient } from "./fixtures/live.ts";

const client = await liveClient();
if (!client) {
  announceSkip("parity");
}
const db: Db | null = client ? client.db("jsmql_parity") : null;

afterAll(async () => {
  await client?.close();
});

const DOCS = [
  { _id: 1, t: "a", n: 3 },
  { _id: 2, t: "b", n: 1 },
  { _id: 3, t: "a", n: 2 },
  { _id: 4, t: "c", n: 5 },
  { _id: 5, t: "b", n: 4 },
];

/** Order-insensitive comparison: parity is contracted on membership, not sequence. */
const bag = (v: unknown): string => JSON.stringify(Array.isArray(v) ? [...v].map((x) => JSON.stringify(x)).sort() : v);

/**
 * Each case runs the SAME call in both positions over the SAME documents. A sort
 * case states the `_id` order JavaScript gives, so a lowering that drops the sort
 * on BOTH sides still fails.
 */
type Case = { method: string; call: string; note?: string; order?: readonly number[] };
const CASES: Case[] = [
  { method: "take", call: "take(2)" },
  { method: "drop", call: "drop(2)" },
  { method: "slice", call: "slice(1,3)" },
  { method: "tail", call: "tail()" },
  { method: "toSorted", call: 'toSorted("n")', order: [2, 3, 1, 5, 4] },
  { method: "sortBy", call: 'sortBy("n")', order: [2, 3, 1, 5, 4] },
  { method: "orderBy", call: 'orderBy(["n"],["desc"])', order: [4, 5, 1, 3, 2] },
  { method: "uniqBy", call: 'uniqBy("t")', note: "order differs by design — $group is unordered" },
  { method: "uniq", call: "uniq()", note: "order differs by design — $group is unordered" },
  { method: "reject", call: "reject(r => r.n > 2)" },
  { method: "filter", call: "filter(r => r.n > 2)" },
];

let ran = 0;

describe("value and stream lowerings agree on membership", () => {
  for (const c of CASES) {
    const claim = c.order === undefined ? "same elements in both positions" : "same elements in the same order";
    it.skipIf(!db)(`${c.method}: ${claim}`, async () => {
      const valueExpr = jsmql.expr(`$.rows.${c.call}`);
      const streamPipe = jsmql(`$$ = $$.${c.call};`) as object[];
      const v = await db!.aggregate([{ $documents: [{ rows: DOCS }] }, { $addFields: { o: valueExpr } }]).toArray();
      const s = await db!.aggregate([{ $documents: DOCS }, ...streamPipe]).toArray();
      ran++;
      if (c.order === undefined) {
        expect(bag(s)).toEqual(bag(v[0].o));
        return;
      }
      expect(s).toEqual(v[0].o);
      expect(s.map((d) => d._id)).toEqual(c.order);
    });
  }
});

describe("parity coverage", () => {
  // A dual-declared method with no case here is a lowering nobody compares. The floor
  // fails when the shared set grows without a case joining it, so the suite cannot be
  // hollowed out by adding methods.
  it("every case names a genuinely dual-declared method", () => {
    const shared = new Set(streamMethodNames().filter((n) => valueMethodNames().includes(n)));
    for (const c of CASES) expect(shared.has(c.method)).toBe(true);
  });

  it("covers at least a third of the dual-declared surface", () => {
    const shared = streamMethodNames().filter((n) => valueMethodNames().includes(n));
    expect(CASES.length).toBeGreaterThanOrEqual(Math.ceil(shared.length / 3));
  });

  it("ran each case against the server, or none when no server is up", () => {
    // A green run with no server proves nothing, so a partial run must fail.
    expect(ran, `ran ${ran} of ${CASES.length}`).toBe(db === null ? 0 : CASES.length);
  });
});
