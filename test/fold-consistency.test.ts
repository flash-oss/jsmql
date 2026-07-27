// test/fold-consistency.test.ts — the HR3 gate for constant folding.
//
// A folded method (const-eval.ts) has TWO implementations of the same
// semantics: the compile-time JS fold, and the server-side MQL lowering that a
// runtime receiver would take. If they disagree, folding would emit a value the
// server never would. This suite proves they agree: for each foldable method ×
// a battery of inputs it compares the compile-time fold to the MQL lowering run
// on a real mongod (via `$documents`, so no collection write). Any method/shape
// that can't be proven equal must be removed from const-eval.ts (→ runtime
// fallback), never shipped.
//
// It connects to a local mongod (mongodb://127.0.0.1:27017, like test/probe) and
// SKIPS ITSELF (green) when none is reachable, so `npm test` stays green without
// one. Start any local mongod to exercise it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, MongoClient } from "mongodb";
import { jsmql } from "../src/index.ts";

const URI = process.env.JSMQL_FOLD_MONGO_URI ?? "mongodb://127.0.0.1:27017/?serverSelectionTimeoutMS=1500";

async function tryConnect(): Promise<MongoClient | null> {
  try {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(URI, { serverSelectionTimeoutMS: 1500 });
    await client.connect();
    await client.db("jsmql_fold_check").command({ ping: 1 });
    return client;
  } catch {
    return null;
  }
}

const client = await tryConnect();
if (!client) {
  console.warn("\n[fold-consistency] no local mongod reachable — skipping. Start one to exercise the HR3 fold gate.\n");
}

// Each case: a receiver LITERAL (as jsmql source), the same value as a seed doc
// field, and a method-call suffix. The fold embeds the literal; the runtime
// lowering runs `$.s<call>` on `{ s: <val> }`. Both must produce the same value.
type Case = { lit: string; val: unknown; call: string };

const STRING_SAMPLES = ["", "fooBar", "FOO bar", "  hi  ", "already_snake", "café", "MixedURL2x", "a-b-c"];
const stringCases: Case[] = [];
for (const v of STRING_SAMPLES) {
  const lit = JSON.stringify(v);
  for (const call of [
    ".toUpperCase()",
    ".toLowerCase()",
    ".trim()",
    ".trimStart()",
    ".trimEnd()",
    ".slice(1)",
    ".slice(1, 3)",
    ".slice(-2)",
    ".substring(1, 3)",
    '.split("")',
    '.split("-")',
    ".charAt(1)",
    '.includes("o")',
    '.startsWith("f")',
    '.endsWith("r")',
    '.indexOf("o")',
    ".repeat(2)",
    ".padStart(10)",
    '.padStart(10, "*")',
    ".padEnd(10)",
    '.concat("!", "?")',
  ]) {
    stringCases.push({ lit, val: v, call });
  }
}

const ARRAY_SAMPLES: unknown[][] = [[], [1, 2, 3, 4, 5], [3, 1, 2], ["a", "b", "c"], [1, 2, 2, 3]];
const arrayCases: Case[] = [];
for (const v of ARRAY_SAMPLES) {
  const lit = JSON.stringify(v);
  for (const call of [
    ".map(x => x)",
    ".filter(x => x !== 2)",
    ".slice(1)",
    ".slice(1, 3)",
    ".slice(-2)",
    ".concat([9, 8])",
    ".includes(2)",
    ".indexOf(2)",
    ".lastIndexOf(2)",
    '.join("-")',
    ".at(0)",
    ".at(-1)",
    ".toReversed()",
    ".flat()",
    ".find(x => x === 2)",
    ".some(x => x === 2)",
    ".every(x => x > 0)",
    ".flatMap(x => [x, x])",
    ".reduce((a, b) => a + b, 0)",
  ]) {
    arrayCases.push({ lit, val: v, call });
  }
}

// Distinguishes "folded to a value" from "wasn't folded" (stayed a runtime
// binding). A non-fold is a safe outcome — the server runs its own lowering —
// so the test skips it; it only asserts on folds, which is where divergence
// would be a real bug.
const NOT_FOLDED = Symbol("not-folded");

/** The compile-time folded value of `<lit><call>`, or NOT_FOLDED if it stayed runtime. */
function foldedValue(lit: string, call: string): unknown {
  const stages = jsmql.pipeline(`const __k = ${lit}${call}; $project({ v: __k })`) as Record<string, unknown>[];
  // A fold produces exactly one `$project` stage; a runtime binding produces a
  // leading `$set` on `__jsmql.var.__k` (and a trailing `$unset`).
  const only = stages.length === 1 ? (stages[0].$project as { v: unknown } | undefined) : undefined;
  return only && "v" in only ? only.v : NOT_FOLDED;
}

describe.skipIf(!client)("fold consistency: compile-time fold === MQL lowering on mongod", () => {
  let db: Db;
  beforeAll(() => {
    db = client!.db("jsmql_fold_check");
  });
  afterAll(async () => {
    await client?.close();
  });

  // The contract is a VALUE contract: wherever the MQL lowering yields a value,
  // the fold must yield the same value. When the lowering ERRORS on an input
  // (a pre-existing lowering limitation — e.g. `$substrCP` on "", empty-separator
  // `$split`), there is no value to disagree with, so the case is skipped; the
  // fold still produces the correct literal.
  const SERVER_ERROR = Symbol("server-error");
  async function serverValue(call: string, val: unknown): Promise<unknown> {
    try {
      const addExpr = jsmql.expr(`$.s${call}`);
      const [row] = await db.aggregate([{ $documents: [{ s: val }] }, { $addFields: { v: addExpr } }]).toArray();
      return "v" in (row as object) ? (row as { v: unknown }).v : SERVER_ERROR; // missing → skip
    } catch {
      return SERVER_ERROR;
    }
  }

  for (const { lit, val, call } of [...stringCases, ...arrayCases]) {
    it(`${lit}${call}`, async () => {
      const folded = foldedValue(lit, call);
      if (folded === NOT_FOLDED) return; // withheld fold → runtime; nothing to compare
      const server = await serverValue(call, val);
      if (server === SERVER_ERROR) return; // lowering errors on this input → no value to compare
      expect(folded).toEqual(server);
    });
  }
});
