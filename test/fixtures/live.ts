import { MongoClient } from "mongodb";
import { SCRATCH_URI } from "./config.ts";

export function isUnreachable(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? "";
  return name === "MongoServerSelectionError" || name === "MongoNetworkError";
}

function refused(e: unknown): Error {
  return new Error(
    `The project's mongod answered, but refused this suite: ${(e as Error).message}\n` +
      `This is NOT a reason to skip — a suite that skips here reports GREEN when its\n` +
      `server half never runs. Run \`npm run fixture:up\` to apply the current grants,\n` +
      `and add any new scratch database to SCRATCH_DBS in test/fixtures/config.ts.`,
    { cause: e },
  );
}

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

export async function liveUp(timeoutMs = 700): Promise<boolean> {
  const client = await liveClient(timeoutMs);
  await client?.close().catch(() => {});
  return client !== null;
}

export async function liveClientNow(): Promise<MongoClient> {
  const client = await liveClient();
  if (client === null) {
    throw new Error("the project's mongod answered a moment ago and is gone now — start it and re-run");
  }
  return client;
}

export function announceSkip(suite: string): void {
  console.warn(
    `\n[${suite}] the project's mongod is not running — the server half of this suite is SKIPPED.` +
      `\n[${suite}] Run \`npm run fixture:up\` to exercise it.\n`,
  );
}
