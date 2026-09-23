// test/fixtures/client.ts — read-only access to the fixture instance, for the
// integration suite. Connects as the server-enforced read-only user, so nothing
// reached through here can mutate the dataset.
//
// The suite may skip for ONE reason only: no server answers on the fixture port.
// `isUnreachable` in live.ts is that rule. A wrong password, a missing user, a
// missing grant or a stale dataset makes the suite FAIL, with the command that
// repairs it. See test/CLAUDE.md § "Suites that connect to a server must report
// whether they connected".

import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import { COLLECTIONS, FIXTURE_DB, META_COLLECTION, READONLY_URI } from "./config.ts";
import { DATASET_HASH, EXPECTED_COUNTS } from "./dataset.ts";
import { isUnreachable } from "./live.ts";

export async function connectReadOnly(): Promise<{ client: MongoClient; db: Db }> {
  const client = new MongoClient(READONLY_URI);
  await client.connect();
  return { client, db: client.db(FIXTURE_DB) };
}

/**
 * Is the fixture instance running? False ONLY when no server answers. When a
 * server answers, this checks the read-only login and the seeded dataset, and
 * throws when either is wrong — at import time, so the file fails and never
 * turns into a green skip.
 */
export async function fixtureReady(): Promise<boolean> {
  const client = new MongoClient(READONLY_URI, { serverSelectionTimeoutMS: 1500 });
  try {
    await client.connect();
  } catch (e) {
    await client.close().catch(() => {});
    if (isUnreachable(e)) return false;
    throw new Error(
      `The fixture mongod answered, but refused the read-only user: ${(e as Error).message}\n` +
        `This is NOT a reason to skip. Run \`npm run fixture:up\` to create the users and apply the grants.`,
      { cause: e },
    );
  }
  try {
    await assertIntegrity(client.db(FIXTURE_DB));
  } finally {
    await client.close().catch(() => {});
  }
  return true;
}

// Fail loudly if the on-disk dataset does not match what the tests expect (for
// example a different version was seeded out of band). The read-only user cannot
// write, so this check is the only guard against a drifted dataset.
export async function assertIntegrity(db: Db): Promise<void> {
  const meta = await db.collection(META_COLLECTION).findOne({ _id: "version" as never });
  const hash = (meta as { hash?: string } | null)?.hash;
  if (hash !== DATASET_HASH) {
    throw new Error(
      `Fixture is stale: seeded ${hash}, tests expect ${DATASET_HASH}. ` +
        `Run "npm run fixture:up" to seed the current dataset, or "npm run fixture:reset" to rebuild the instance.`,
    );
  }
  for (const c of COLLECTIONS) {
    const n = await db.collection(c).countDocuments();
    if (n !== EXPECTED_COUNTS[c]) {
      throw new Error(`Fixture "${c}": ${n} docs, expected ${EXPECTED_COUNTS[c]}. Run "npm run fixture:reset".`);
    }
  }
}
