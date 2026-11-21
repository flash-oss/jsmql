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

const SLOTS = {
  group: (acc: string) => `$group({ _id: null, r: ${acc} });`,
  window: (acc: string) => `$setWindowFields({ sortBy: { n: 1 }, output: { r: ${acc} } });`,
} as const;

const RECEIVERS = ["$.n", "$.a", "[$.n, $.m]"];

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
    expect(checked).toBeGreaterThanOrEqual(42);
  });

  it("reduces an array literal on each document first, then accumulates it", async () => {
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
    for (const src of [
      "$group({ _id: null, r: $push([$.n, $.m]) });",
      "$group({ _id: null, r: { $push: [$.n, $.m] } });",
    ]) {
      expect(jsmql.pipeline(src), src).toEqual([{ $group: { _id: null, r: { $push: ["$n", "$m"] } } }]);
    }
    await expect(
      coll
        .aggregate(jsmql.pipeline("$group({ _id: null, r: $push([$.n, $.m]) });") as Record<string, unknown>[])
        .toArray(),
    ).rejects.toThrow(/The \$push accumulator is a unary operator/);
  });
});
