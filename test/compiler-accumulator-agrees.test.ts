// THE proof that an accumulator cell renders a shape mongod accepts: take the
// document the REGISTRY's own emitter produces and run it.
//
// A `toEqual` cannot establish this, and neither can reading the vendored spec.
// Both group and window slots parse `{ acc: [ … ] }` as an operand LIST rather
// than as an array expression, and the two report a second operand differently:
//   {$group:{_id:null,s:{$sum:["$x","$y"]}}}              → "unary operator"
//   {$setWindowFields:{…,output:{r:{$sum:["$x","$y"]}}}}  → 0, where "$x" → 4
// The second is why this suite exists: nothing reports it. Every rule in
// `accumulated` — one operand, and the `$let` shield over an operand that
// renders as an array — was put there by a refusal measured here.
//
// It skips itself when no mongod is listening, so `npm test` stays green.

import { beforeAll, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { NAMES } from "../src/registry/names.ts";
import { accumulated } from "../src/registry/vocabulary.ts";
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

/** A source node the emitters can be handed, and the `value` service that renders one. */
type Node = { type: "FieldRef"; segments: readonly string[] } | { type: "ArrayLiteral"; elements: readonly Node[] };
const F = (p: string): Node => ({ type: "FieldRef", segments: [p] });
const ARR = (...elements: Node[]): Node => ({ type: "ArrayLiteral", elements });
const value = (x: Node): unknown => (x.type === "FieldRef" ? "$" + x.segments.join(".") : x.elements.map(value));

/**
 * A field whose VALUE suits this operator, and the array form of the same.
 *
 * The type has to suit, or the server's complaint is about the data rather than
 * the shape — which is a different question from the one this suite asks.
 */
const SUITS: Readonly<Record<string, readonly [string, Node]>> = {
  $mergeObjects: ["o", ARR(F("o"), F("o"))],
  $concatArrays: ["a", ARR(F("a"), F("a"))],
  $setUnion: ["a", ARR(F("a"), F("a"))],
};
const suits = (name: string): readonly [string, Node] => SUITS[name] ?? ["n", ARR(F("n"), F("m"))];

const wrap = {
  group: (v: unknown) => ({ $group: { _id: null, r: v } }),
  window: (v: unknown) => ({ $setWindowFields: { sortBy: { n: 1 }, output: { r: v } } }),
} as const;

type Cell = { args?: { exact?: number; none?: true }; emit?: (i: unknown) => unknown };
type Row = { kind?: string } & Partial<Record<"group" | "window", Cell | unknown>>;

/**
 * The operand shapes an accumulator slot can be handed from source, or null when
 * the cell is object-shaped — one argument there is the body object, which needs
 * per-key typed values and is a separate question.
 */
function argumentLists(cell: Cell, name: string): [string, Node[]][] | null {
  const [field, arrayForm] = suits(name);
  if (cell.emit === accumulated) {
    return [
      ["one operand", [F(field)]],
      ["an array-literal operand", [arrayForm]],
    ];
  }
  if (cell.args?.none === true) return [["no operand", []]];
  if (cell.args?.exact === 2) return [["two operands", [F("n"), F("m")]]];
  return null;
}

describe.skipIf(!up)("registry — every accumulator cell renders a shape mongod accepts", () => {
  let coll: ReturnType<ReturnType<MongoClient["db"]>["collection"]>;
  let client: MongoClient;

  beforeAll(async () => {
    client = await liveClientNow();
    coll = client.db("jsmql_accumulator_agrees").collection("t");
    await coll.deleteMany({});
    await coll.insertMany([
      { n: 1, m: 2, o: { a: 1 }, a: [1, 2] },
      { n: 3, m: 4, o: { b: 2 }, a: [3] },
    ]);
    return async () => {
      await client.close();
    };
  });

  it("is refused by the server nowhere", async () => {
    const refused: string[] = [];
    const gated: string[] = [];
    /**
     * Two operand TYPE errors are expected and are not shape errors — mongod
     * gives the same complaint for the bare array, so the shield is not the
     * cause. They are here by name rather than filtered out, so a shape error
     * that hid behind one would still be reported.
     */
    const TYPED_OUT: Readonly<Record<string, string>> = {
      "$mergeObjects.group": "an array of objects is not one object to merge",
      "$linearFill.window": "an array is not a number to interpolate",
    };
    let checked = 0;

    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      if (row.kind !== "mongo") continue;
      for (const pos of ["group", "window"] as const) {
        const cell = row[pos];
        if (cell === null || typeof cell !== "object" || (cell as Cell).emit === undefined) continue;
        const lists = argumentLists(cell as Cell, name);
        if (lists === null) continue;
        for (const [label, args] of lists) {
          const doc = (cell as Cell).emit!({ name, args, value });
          checked++;
          try {
            await coll.aggregate([wrap[pos](doc)]).toArray();
          } catch (e) {
            const msg = String((e as Error).message).replace(/\s+/g, " ");
            const where = `${name}.${pos}`;
            if (msg.includes("feature compatibility version")) gated.push(where);
            else if (TYPED_OUT[where] !== undefined && label === "an array-literal operand") continue;
            else refused.push(`${where} with ${label}: ${JSON.stringify(doc)} → ${msg.slice(0, 110)}`);
          }
        }
      }
    }

    expect(refused).toEqual([]);
    // A suite that quietly stops comparing is worse than none: this floor fails
    // if the operand-shaped accumulator cells shrink away from the harness.
    expect(checked).toBeGreaterThanOrEqual(50);
    expect(gated.length, `FCV-gated on this server: ${[...new Set(gated)].join(", ")}`).toBeLessThan(checked / 4);
  });

  it("answers the same for a shielded array as for a bare one, where the bare one runs", async () => {
    // The shield's whole claim. A window slot accepts a bare array already, so
    // the two forms must agree there — otherwise `accumulated` would be changing
    // the answer to buy a shape, which is the one thing a fix may not do.
    const value = async (doc: unknown): Promise<unknown> => {
      const rows = await coll.aggregate([wrap.window(doc), { $project: { _id: 0, r: 1 } }]).toArray();
      return rows.map((d) => d.r);
    };
    // `$addToSet` is a SET: its element order is unspecified (SR2), so the two
    // forms are compared as sets. Every other accumulator here is ordered.
    const asSet = (v: unknown): unknown =>
      Array.isArray(v) ? v.map((row) => [...(row as unknown[])].map((e) => JSON.stringify(e)).sort()) : v;
    for (const name of ["$sum", "$avg", "$min", "$max", "$first", "$last", "$push", "$addToSet"]) {
      const bare = await value({ [name]: ["$n", "$m"] });
      const shielded = await value({ [name]: { $let: { vars: {}, in: ["$n", "$m"] } } });
      if (name === "$addToSet") expect(asSet(shielded), name).toEqual(asSet(bare));
      else expect(shielded, name).toEqual(bare);
    }
  });
});
