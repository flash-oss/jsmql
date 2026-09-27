// A `toEqual` cannot establish that an accumulator slot holds a shape mongod
// accepts. Both group and window slots parse `{ acc: [ … ] }` as an operand list
// rather than as an array expression, and the two report a second operand
// differently:
//   {$group:{_id:null,s:{$sum:["$x","$y"]}}}              → "unary operator"
//   {$setWindowFields:{…,output:{r:{$sum:["$x","$y"]}}}}  → 0, where "$x" → 4
// The second is why this suite exists: nothing reports it.
//
// A JavaScript aggregate in an accumulator slot (`$.a.sum()`, `.first()`,
// `.sumBy(fn)`) is the compiler's own lowering, so HR3 applies to it. This suite
// compiles each spelling, runs it on the server, and requires the server to take
// it. A `$op(…)` call in the same slot is the developer's own MQL, and HR3 does
// not apply to it: `$push([$.x, $.y])` stays `{ $push: ["$x", "$y"] }`.
//
// This suite skips itself when no mongod is listening, so `npm test` stays green.

import { beforeAll, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { NAMES } from "../src/registry/names.ts";
import { jsmql } from "../src/index.ts";
import { SCRATCH_URI } from "./fixtures/config.ts";
import { liveClientNow, liveUp } from "./fixtures/live.ts";

const URI = SCRATCH_URI;

const up = await liveUp();
if (!up) {
  console.warn(
    `\n[accumulator] no mongod on ${URI} — skipping the accumulator-slot suite.` +
      "\n[accumulator] Start one to run it; see CLAUDE.md § Verify MQL against a running MongoDB.\n",
  );
}

/** The two accumulator slots, each around one output field `r`. */
const SLOTS = {
  group: (acc: string) => `$group({ _id: null, r: ${acc} });`,
  window: (acc: string) => `$setWindowFields({ sortBy: { n: 1 }, output: { r: ${acc} } });`,
} as const;

/** The receivers each spelling runs on: a number field, an array field, and an array literal. */
const RECEIVERS = ["$.n", "$.a", "[$.n, $.m]"];

/** The call that each row with an accumulator cell takes, from its argument count. */
const callOf = (name: string, cell: { args?: { none?: true } }): string =>
  cell.args?.none === true ? `.${name}()` : `.${name}(i => i)`;

describe.skipIf(!up)("emit every JavaScript accumulator spelling in a shape mongod accepts", () => {
  let coll: ReturnType<ReturnType<MongoClient["db"]>["collection"]>;
  let client: MongoClient;

  beforeAll(async () => {
    client = await liveClientNow();
    coll = client.db("jsmql_accumulator_agrees").collection("t");
    await coll.deleteMany({});
    await coll.insertMany([
      { n: 1, m: 2, a: [1, 2] },
      { n: 3, m: 4, a: [3] },
    ]);
    return async () => {
      await client.close();
    };
  });

  it("the server accepts every accumulator cell of a JavaScript method", async () => {
    const refused: string[] = [];
    /**
     * A `.sumBy(fn)` / `.meanBy(fn)` maps its receiver, and `$map` refuses a number
     * ("input to $map must be an array"). That is the type of the data, not the
     * shape of the slot. The list names each such pair, so it cannot hide a shape error.
     */
    const TYPED_OUT: ReadonlySet<string> = new Set(["sumBy.group $.n", "meanBy.group $.n"]);
    let checked = 0;

    for (const [name, row] of Object.entries(NAMES) as [string, Record<string, unknown>][]) {
      if (row.kind === "mongo") continue;
      for (const pos of ["group", "window"] as const) {
        const cell = row[pos] as { args?: { none?: true }; emit?: unknown } | undefined;
        if (cell === undefined || typeof cell !== "object" || cell.emit === undefined) continue;
        for (const recv of RECEIVERS) {
          const where = `${name}.${pos} ${recv}`;
          const src = SLOTS[pos](`${recv}${callOf(name, cell)}`);
          const mql = jsmql.pipeline(src) as Record<string, unknown>[];
          checked++;
          try {
            await coll.aggregate(mql).toArray();
          } catch (e) {
            if (TYPED_OUT.has(where)) continue;
            const msg = String((e as Error).message).replace(/\s+/g, " ");
            refused.push(`${where}: ${JSON.stringify(mql)} → ${msg.slice(0, 110)}`);
          }
        }
      }
    }

    expect(refused).toEqual([]);
    // A suite that silently stops comparing is worse than none: this check fails
    // if the count of accumulator cells of a JavaScript method decreases.
    expect(checked).toBeGreaterThanOrEqual(42);
  });

  it("reduces an array literal on each document first, then accumulates it", async () => {
    // `[$.n, $.m]` holds one array on each document. The aggregate reads it as
    // JavaScript does on that document, and the slot accumulates the result:
    // over { n: 1, m: 2 } and { n: 3, m: 4 }, `.sum()` is (1 + 2) + (3 + 4).
    const EXPECTED: Readonly<Record<string, number>> = {
      ".sum()": 10,
      ".mean()": 2.5,
      ".max()": 4,
      ".min()": 1,
      ".head()": 1,
      ".first()": 1,
      ".last()": 4,
    };
    for (const [call, want] of Object.entries(EXPECTED)) {
      const mql = jsmql.pipeline(SLOTS.group(`[$.n, $.m]${call}`)) as Record<string, unknown>[];
      const [row] = await coll.aggregate(mql).toArray();
      expect([call, row.r]).toEqual([call, want]);
    }
    expect(jsmql.pipeline(SLOTS.group("[$.n, $.m].sum()"))).toEqual([
      { $group: { _id: null, r: { $sum: { $sum: ["$n", "$m"] } } } },
    ]);
  });

  it("passes an operand list that you write through, in both spellings (HR2)", async () => {
    // The call and the raw document are one MQL document, and the server judges it.
    for (const src of [
      "$group({ _id: null, r: $push([$.n, $.m]) });",
      "$group({ _id: null, r: { $push: [$.n, $.m] } });",
    ]) {
      expect(jsmql.pipeline(src), src).toEqual([{ $group: { _id: null, r: { $push: ["$n", "$m"] } } }]);
    }
    // DELIBERATELY invalid: mongod says "The $push accumulator is a unary operator".
    await expect(
      coll
        .aggregate(jsmql.pipeline("$group({ _id: null, r: $push([$.n, $.m]) });") as Record<string, unknown>[])
        .toArray(),
    ).rejects.toThrow(/The \$push accumulator is a unary operator/);
  });
});
