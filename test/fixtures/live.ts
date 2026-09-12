// test/fixtures/live.ts — how a suite reaches the project's mongod.
//
// A live suite may SKIP for exactly ONE reason: the instance is not running, so
// `npm test` stays green for a contributor who has not run `npm run fixture:up`.
//
// It may not skip for any other reason. A suite that swallows a wrong password, a
// missing grant or a refused command keeps running its compile-only half and STILL
// REPORTS GREEN — and the half that catches what a `toEqual` cannot has silently
// stopped running. That is not hypothetical: four suites sat in exactly that state,
// each reporting green, because `readWrite` alone cannot drop a database.
//
// So the rule these helpers enforce is: "could not reach a server at all" → skip;
// everything else → throw, and let the suite go red.
//
// The port is never named here. It comes from config.ts, and `:27018` is the only
// one this project connects to — see test/no-default-port.test.ts.

import { MongoClient } from "mongodb";
import { SCRATCH_URI } from "./config.ts";

/**
 * Did the driver fail to find a server at all?
 *
 * MEASURED against the project's instance: a dead port answers
 * `MongoServerSelectionError` (`connect ECONNREFUSED`), while a wrong password
 * answers `MongoServerError` with code 18 and a missing grant answers
 * `MongoServerError` "not authorized". Only the first is a reason to skip.
 */
export function isUnreachable(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? "";
  return name === "MongoServerSelectionError" || name === "MongoNetworkError";
}

/** The message a suite fails with when the server is there but would not serve it. */
function refused(e: unknown): Error {
  return new Error(
    `The project's mongod answered, but refused this suite: ${(e as Error).message}\n` +
      `This is NOT a reason to skip — a suite that skips here reports GREEN while its\n` +
      `server half never runs. Run \`npm run fixture:up\` to apply the current grants,\n` +
      `and add any new scratch database to SCRATCH_DBS in test/fixtures/config.ts.`,
    { cause: e },
  );
}

/**
 * A connected client for a live suite, or null when the instance is not running.
 *
 * Use it in `beforeAll` and then do the suite's OWN setup outside any try/catch, so a
 * failed drop or insert fails the suite instead of disappearing into a skip:
 *
 *     client = await liveClient();
 *     if (client) {
 *       const db = client.db("jsmql_my_suite");
 *       await db.dropDatabase();
 *       await db.collection("t").insertMany(DOCS);
 *     }
 */
export async function liveClient(timeoutMs = 1500): Promise<MongoClient | null> {
  const client = new MongoClient(SCRATCH_URI, { serverSelectionTimeoutMS: timeoutMs });
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    return client;
  } catch (e) {
    await client.close().catch(() => {});
    if (isUnreachable(e)) return null;
    throw refused(e);
  }
}

/**
 * Is the instance running? For a suite that gates a whole `describe` on it
 * (`describe.skipIf(!up)`), evaluated once at module load.
 *
 * A refusal throws here too, at import time, which fails the file — the point being
 * that it must never quietly turn into `up === false`.
 */
export async function liveUp(timeoutMs = 700): Promise<boolean> {
  const client = await liveClient(timeoutMs);
  await client?.close().catch(() => {});
  return client !== null;
}

/**
 * A connected client where "is it running?" was already settled — inside a
 * `describe.skipIf(!up)` block, or an `it.skipIf(!up)`. It never returns null, so the
 * suite needs no null handling; if the instance disappears between the two, that is a
 * failure worth seeing rather than a silent skip.
 */
export async function liveClientNow(): Promise<MongoClient> {
  const client = await liveClient();
  if (client === null) {
    throw new Error("the project's mongod answered a moment ago and is gone now — start it and re-run");
  }
  return client;
}

/** The one line a suite prints when it skips, so a reader sees which half ran. */
export function announceSkip(suite: string): void {
  console.warn(
    `\n[${suite}] the project's mongod is not running — the server half of this suite is SKIPPED.` +
      `\n[${suite}] Run \`npm run fixture:up\` to exercise it.\n`,
  );
}
