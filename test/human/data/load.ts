// The data loader for test/human/human.test.ts.
//
// Each test has its own data file in this folder, with the test name as the file name:
// `<test name>.ts` gives the documents as its default export. `populateDatabase` loads
// that file into a collection with the same name. `queryDatabase` runs a pipeline or a
// filter against the collection that was loaded last.
//
// The connection goes to the project's own mongod on :27018 only (test/fixtures/config.ts).

import type { Db, Document } from "mongodb";
import { liveClient } from "../../fixtures/live.ts";
import { generate } from "lil-csv";

const DB = "jsmql_human";

let collection: string | null = null;

async function withDb<T>(run: (db: Db) => Promise<T>): Promise<T> {
  const client = await liveClient();
  if (client === null) throw new Error("The project's mongod on :27018 does not answer. Run `npm run fixture:up`.");
  try {
    return await run(client.db(DB));
  } finally {
    await client.close();
  }
}

/** Replace the documents of the collection `testName` with the documents of `./<testName>.ts`. */
export async function populateDatabase(testName: string): Promise<void> {
  const { default: docs } = (await import(/* @vite-ignore */ `./${testName}.ts`)) as { default: Document[] };
  await withDb(async (db) => {
    const coll = db.collection(testName);
    await coll.deleteMany({});
    // Copy each document: `insertMany` adds an `_id` to the objects it gets.
    if (docs.length > 0) await coll.insertMany(docs.map((d) => ({ ...d })));
  });
  collection = testName;
}

/** Run `mql` against the collection that `populateDatabase` loaded last. An array is a pipeline; an object is a filter. */
export async function queryDatabase(mql: object | object[]): Promise<Document[]> {
  if (collection === null) throw new Error("Call populateDatabase(testName) before queryDatabase(mql).");
  const name = collection;
  return withDb((db) => {
    const coll = db.collection(name);
    return Array.isArray(mql) ? coll.aggregate(mql as Document[]).toArray() : coll.find(mql).toArray();
  });
}

export async function populateAndQueryDatabase(testName: string, mql: object | object[]): Promise<string> {
  await populateDatabase(testName);
  return asPrettyTable(await queryDatabase(mql));
}

export function asPrettyTable(docs: Document[]): string {
  const rows = generate(docs)
    .split("\n")
    .map((line) => line.split(","));
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => (row[i] ?? "").length)));
  const lines = rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join(" | "));
  return `\n${lines.join("\n")}\n`;
}
