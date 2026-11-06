// The data loader for test/human/human.test.ts.
//
// Each test has its own data file in this folder, with the test name as the file name:
// `<test name>.ts` gives the documents as its default export. `populateDatabase` loads
// that file into a collection with the same name. Each named export of the file is
// another collection with the name of the export, for example `export const kycs = [...]`.
// A query reaches it with `$$$.kycs`. `queryDatabase` runs a pipeline or a filter
// against the collection that was loaded last.
//
// The connection goes to the project's own mongod on :27018 only (test/fixtures/config.ts).

import { ObjectId, type Db, type Document } from "mongodb";
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

/** Replace the documents of the collection `testName`, and of each named export, with the documents of `./<testName>.ts`. */
export async function populateDatabase(testName: string): Promise<void> {
  const { default: docs, ...others } = (await import(/* @vite-ignore */ `./${testName}.ts`)) as Record<
    string,
    Document[]
  >;
  await withDb(async (db) => {
    for (const [name, list] of [[testName, docs] as const, ...Object.entries(others)]) {
      const coll = db.collection(name);
      await coll.deleteMany({});
      // Copy each document: `insertMany` adds an `_id` to the objects it gets.
      if (list.length > 0) await coll.insertMany(list.map((d) => ({ ...d })));
    }
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

/** Give each ObjectId as its hex string: the CSV generator reads an ObjectId as an object with no fields. */
function hexIds(value: unknown): unknown {
  if (value instanceof ObjectId) return value.toHexString();
  if (Array.isArray(value)) return value.map(hexIds);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hexIds(v)]));
  return value;
}

export function asPrettyTable(docs: Document[]): string {
  const rows = generate(docs.map(hexIds) as Document[])
    .split("\n")
    .map((line) => line.split(","));
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => (row[i] ?? "").length)));
  const lines = rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join(" | "));
  return `\n${lines.join("\n")}\n`;
}
