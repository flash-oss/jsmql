// The update-document target: the object form of an update,
// `updateOne(filter, { $set: … })`. Each document is asserted as MQL. When a mongod
// is reachable, the suite applies the update to a fixture with `updateMany` and
// compares the result with what JavaScript would leave behind. This suite self-skips
// (reports green) without a server, with the all-or-nothing guard. See
// docs/specs/emit-pass.md § The update-document target.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Collection } from "mongodb";
import { update } from "../src/compiler/index.ts";
import { liveClient } from "./fixtures/live.ts";

const DOC = {
  _id: 1,
  a: 1,
  b: "x",
  c: 3,
  n: 5,
  m: 7,
  p: 2,
  q: 8,
  r: 0,
  s: 0,
  tags: [1],
  xs: [2],
  ys: [3, 4],
  zs: [5, 6],
};

type Run = { src: string; js: (d: Record<string, unknown>) => void };
const RUNS: Run[] = [];
const applied = (src: string, js: (d: Record<string, unknown>) => void): unknown => {
  RUNS.push({ src, js });
  return update(src);
};

describe("compiler/emit/update — writes become their operators", () => {
  it("sets, unsets, increments, multiplies", () => {
    expect(applied("$.a = 10", (d) => (d.a = 10))).toEqual({ $set: { a: 10 } });
    expect(
      applied('$.a = 10; $.b = "y"; delete $.c;', (d) => {
        d.a = 10;
        d.b = "y";
        delete d.c;
      }),
    ).toEqual({ $set: { a: 10, b: "y" }, $unset: { c: "" } });
    expect(
      applied("$.n += 2; $.m -= 3; $.p *= 2; $.q /= 4; $.r++; $.s--;", (d) => {
        (d.n as number) += 2;
        (d.m as number) -= 3;
        (d.p as number) *= 2;
        (d.q as number) /= 4;
        (d.r as number)++;
        (d.s as number)--;
      }),
    ).toEqual({ $inc: { n: 2, m: -3, r: 1, s: -1 }, $mul: { p: 2, q: 0.25 } });
    expect(applied("$.a = [1, 2]", (d) => (d.a = [1, 2]))).toEqual({ $set: { a: [1, 2] } });
    expect(update('$.d = new Date("2024-01-01")')).toEqual({ $set: { d: new Date("2024-01-01") } });
  });

  it("pushes, pops, bounds, dates and renames", () => {
    expect(applied("$.tags.push(3)", (d) => (d.tags as number[]).push(3))).toEqual({ $push: { tags: 3 } });
    expect(
      applied("$.tags.push(3, 4); $.xs.unshift(0); $.ys.pop(); $.zs.shift();", (d) => {
        (d.tags as number[]).push(3, 4);
        (d.xs as number[]).unshift(0);
        (d.ys as number[]).pop();
        (d.zs as number[]).shift();
      }),
    ).toEqual({ $push: { tags: { $each: [3, 4] }, xs: { $each: [0], $position: 0 } }, $pop: { ys: 1, zs: -1 } });
    expect(
      applied("$.n = Math.min($.n, 3); $.m = Math.max($.m, 9);", (d) => {
        d.n = Math.min(d.n as number, 3);
        d.m = Math.max(d.m as number, 9);
      }),
    ).toEqual({ $min: { n: 3 }, $max: { m: 9 } });
    expect(
      applied("$.c2 = $.c; delete $.c;", (d) => {
        d.c2 = d.c;
        delete d.c;
      }),
    ).toEqual({ $rename: { c: "c2" } });
    expect(update("$.t = new Date()")).toEqual({ $currentDate: { t: true } });
  });

  it("takes the update operators themselves, called or as a raw document", () => {
    expect(applied("$inc({ n: 2 })", (d) => ((d.n as number) += 2))).toEqual({ $inc: { n: 2 } });
    expect(applied("$push({ tags: $each([1, 2]) })", (d) => (d.tags as number[]).push(1, 2))).toEqual({
      $push: { tags: { $each: [1, 2] } },
    });
    expect(update("$push({ tags: { $each: [1, 2], $slice: -3 } })")).toEqual({
      $push: { tags: { $each: [1, 2], $slice: -3 } },
    });
    expect(
      applied("{ $inc: { n: 2 }, $set: { a: 1 } }", (d) => {
        (d.n as number) += 2;
        d.a = 1;
      }),
    ).toEqual({ $inc: { n: 2 }, $set: { a: 1 } });
  });

  it("refuses what a document-form update cannot say, naming the pipeline form", () => {
    expect(() => update("$.a = $.b + 1")).toThrow(/takes constants/);
    expect(() => update("$set({ a: $.b })")).toThrow(/takes constants/);
    expect(() => update("$.a = $.b")).toThrow(/copies a field/);
    expect(() => update("$each([1])")).toThrow(/fragment of '\$push'/);
    expect(() => update("$.a = 1; $.a = 2;")).toThrow(/written twice/);
    expect(() => update("$.tags.sort()")).toThrow(/no document-form update/);
    expect(() => update("{ a: 1 }")).toThrow(/keys are update operators/);
    expect(() => update("$.a")).toThrow(/An update document is made of writes/);
    expect(() => update('$.n += "x"')).toThrow(/takes a number/);
  });

  it("refuses a server-computed value with what to write instead", () => {
    // `new Date()` is `$currentDate` only as the whole write; anywhere else the row says so.
    for (const src of ["$.a = { t: new Date() }", "$.tags.push(new Date())", "$.t = new Date($.x)"])
      expect(() => update(src)).toThrow(/'\$\.<field> = new Date\(\)' is '\$currentDate'.*pipeline form/s);
    expect(() => update("$.id = ObjectId()")).toThrow(/Pass an id from your code.*pipeline form/s);
    expect(() => update("$.t = Date.now()")).toThrow(/'\$currentDate'.*for milliseconds, use the pipeline form/s);
    // A name whose row has no update-document cell gets the position's own sentence.
    expect(() => update("$.t = typeof $.x")).toThrow(
      "'typeof' is computed on the server. A document-form update takes constants only. Use the pipeline form ('jsmql.pipeline(\"$.<field> = typeof…;\")'). 'updateOne' also accepts this form. Or pass the value from your code.",
    );
  });
});

let client: MongoClient | null = null;
let coll: Collection | null = null;
beforeAll(async () => {
  client = await liveClient();
  // Null means the instance is not running, and only that: liveClient throws on any
  // other refusal rather than letting this suite skip itself green.
  if (client === null) return;
  coll = client.db("jsmql_compiler_update").collection("docs");
});
afterAll(async () => {
  await client?.close();
});

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );

describe("compiler/emit/update — the server leaves what JavaScript would", () => {
  it("applied each one, or none", async () => {
    if (coll === null) {
      expect(RUNS.length).toBeGreaterThan(0);
      return;
    }
    const problems: string[] = [];
    for (const { src, js } of RUNS) {
      await coll.deleteMany({});
      await coll.insertOne(structuredClone(DOC));
      let got: unknown;
      try {
        await coll.updateMany({}, update(src) as Record<string, unknown>);
        got = await coll.findOne({});
      } catch (e) {
        problems.push(`${src}\n  ${JSON.stringify(update(src))}\n  ${(e as Error).message}`);
        continue;
      }
      const want: Record<string, unknown> = structuredClone(DOC);
      js(want);
      if (canonical(got) !== canonical(want))
        problems.push(`${src}\n  server ${canonical(got)}\n  js     ${canonical(want)}`);
    }
    expect(problems, `${problems.length} of ${RUNS.length}:\n${problems.join("\n")}`).toEqual([]);
  });
});
