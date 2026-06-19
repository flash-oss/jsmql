// test/fixtures/client.ts — read-only access to the fixture instance, for the
// integration suite. Connects as the server-enforced read-only user, so nothing
// reached through here can mutate the dataset.

import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import { COLLECTIONS, FIXTURE_DB, META_COLLECTION, READONLY_URI } from "./config.ts";
import { DATASET_HASH, EXPECTED_COUNTS } from "./dataset.ts";

export async function connectReadOnly(): Promise<{ client: MongoClient; db: Db }> {
  const client = new MongoClient(READONLY_URI);
  await client.connect();
  return { client, db: client.db(FIXTURE_DB) };
}

// True only if the fixture instance is reachable read-only AND seeded with the
// CURRENT dataset version. The integration suite skips itself when this is false,
// so `npm test` stays green for contributors who haven't run `npm run fixture:up`.
export async function fixtureReady(): Promise<boolean> {
  let client: MongoClient | undefined;
  try {
    client = new MongoClient(READONLY_URI);
    await client.connect();
    const meta = await client
      .db(FIXTURE_DB)
      .collection(META_COLLECTION)
      .findOne({ _id: "version" as never });
    return (meta as { hash?: string } | null)?.hash === DATASET_HASH;
  } catch {
    return false;
  } finally {
    await client?.close().catch(() => {});
  }
}

// Defense-in-depth: even though the read-only user cannot write, fail loudly if
// the on-disk dataset doesn't match what the tests expect (e.g. a different
// version was seeded out-of-band). Run once in beforeAll.
export async function assertIntegrity(db: Db): Promise<void> {
  const meta = await db.collection(META_COLLECTION).findOne({ _id: "version" as never });
  const hash = (meta as { hash?: string } | null)?.hash;
  if (hash !== DATASET_HASH) {
    throw new Error(`Fixture is stale: seeded ${hash}, tests expect ${DATASET_HASH}. Run "npm run fixture:reset".`);
  }
  for (const c of COLLECTIONS) {
    const n = await db.collection(c).countDocuments();
    if (n !== EXPECTED_COUNTS[c]) throw new Error(`Fixture "${c}": ${n} docs, expected ${EXPECTED_COUNTS[c]}.`);
  }
}
