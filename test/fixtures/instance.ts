import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { MongoClient } from "mongodb";
import {
  ADMIN_PASS,
  ADMIN_URI,
  ADMIN_USER,
  BOOTSTRAP_URI,
  COLLECTIONS,
  FIXTURE_DB,
  FIXTURE_DBPATH,
  FIXTURE_HOME,
  FIXTURE_LOGPATH,
  FIXTURE_PIDPATH,
  FIXTURE_PORT,
  META_COLLECTION,
  READONLY_PASS,
  READONLY_URI,
  READONLY_USER,
  SCRATCH_DBS,
  SCRATCH_PASS,
  SCRATCH_ROLE,
  SCRATCH_USER,
} from "./config.ts";
import { DATASET, DATASET_HASH, EXPECTED_COUNTS, validateDataset } from "./dataset.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pingNoAuth(): Promise<boolean> {
  const c = new MongoClient(BOOTSTRAP_URI);
  try {
    await c.connect();
    await c.db("admin").command({ hello: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await c.close().catch(() => {});
  }
}

async function adminAuthWorks(): Promise<boolean> {
  const c = new MongoClient(ADMIN_URI);
  try {
    await c.connect();
    await c.db("admin").command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await c.close().catch(() => {});
  }
}

function startMongod(): void {
  mkdirSync(FIXTURE_DBPATH, { recursive: true });
  const child = spawn(
    "mongod",
    [
      "--dbpath",
      FIXTURE_DBPATH,
      "--port",
      String(FIXTURE_PORT),
      "--bind_ip",
      "127.0.0.1",
      "--auth",
      "--logpath",
      FIXTURE_LOGPATH,
      "--pidfilepath",
      FIXTURE_PIDPATH,
      "--wiredTigerCacheSizeGB",
      "0.25",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.on("error", (e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        "`mongod` not found on PATH. Install MongoDB Community first:\n" +
          "  https://www.mongodb.com/docs/manual/administration/install-community/",
      );
      process.exit(1);
    }
    throw e;
  });
  child.unref();
}

async function ensureReadonlyUser(admin: MongoClient): Promise<void> {
  try {
    await admin
      .db("admin")
      .command({ createUser: READONLY_USER, pwd: READONLY_PASS, roles: [{ role: "read", db: FIXTURE_DB }] });
  } catch (e) {
    if (!String((e as Error).message).includes("already exists")) throw e;
  }
}

async function ensureScratchUser(admin: MongoClient): Promise<void> {
  const roles = SCRATCH_DBS.flatMap((db) => [
    { role: "readWrite", db },
    { role: "dbAdmin", db },
  ]);
  const privileges = SCRATCH_DBS.map((db) => ({ resource: { db, collection: "" }, actions: ["indexStats"] }));
  const role = { roles, privileges };
  try {
    await admin.db("admin").command({ createRole: SCRATCH_ROLE, ...role });
  } catch (e) {
    if (!String((e as Error).message).includes("already exists")) throw e;
    await admin.db("admin").command({ updateRole: SCRATCH_ROLE, ...role });
  }
  const grant = [{ role: SCRATCH_ROLE, db: "admin" }];
  try {
    await admin.db("admin").command({ createUser: SCRATCH_USER, pwd: SCRATCH_PASS, roles: grant });
  } catch (e) {
    if (!String((e as Error).message).includes("already exists")) throw e;
    await admin.db("admin").command({ updateUser: SCRATCH_USER, pwd: SCRATCH_PASS, roles: grant });
  }
}

async function bootstrapUsers(): Promise<void> {
  if (await adminAuthWorks()) {
    const admin = new MongoClient(ADMIN_URI);
    await admin.connect();
    try {
      await ensureReadonlyUser(admin);
      await ensureScratchUser(admin);
    } finally {
      await admin.close();
    }
    return;
  }
  const boot = new MongoClient(BOOTSTRAP_URI);
  await boot.connect();
  try {
    await boot.db("admin").command({ createUser: ADMIN_USER, pwd: ADMIN_PASS, roles: [{ role: "root", db: "admin" }] });
  } catch (e) {
    if (!String((e as Error).message).includes("already exists")) throw e;
  } finally {
    await boot.close();
  }
  const admin = new MongoClient(ADMIN_URI);
  await admin.connect();
  try {
    await ensureReadonlyUser(admin);
    await ensureScratchUser(admin);
  } finally {
    await admin.close();
  }
}

function logTail(lines: number): string {
  try {
    const all = readFileSync(FIXTURE_LOGPATH, "utf8").trimEnd().split("\n");
    return all.slice(-lines).join("\n");
  } catch {
    return "(no log yet)";
  }
}

async function ensureUp(): Promise<void> {
  if (!(await pingNoAuth())) {
    startMongod();
    for (let i = 0; i < 40 && !(await pingNoAuth()); i++) await sleep(250);
    if (!(await pingNoAuth())) {
      throw new Error(
        `mongod did not come up on :${FIXTURE_PORT} within 10s.\n` + `Last lines of ${FIXTURE_LOGPATH}:\n${logTail(8)}`,
      );
    }
  }
  await bootstrapUsers();
}

async function readMeta(admin: MongoClient): Promise<{ hash?: string } | null> {
  return (await admin
    .db(FIXTURE_DB)
    .collection(META_COLLECTION)
    .findOne({ _id: "version" as never })) as { hash?: string } | null;
}

async function seed(): Promise<boolean> {
  validateDataset();
  const admin = new MongoClient(ADMIN_URI);
  await admin.connect();
  try {
    const db = admin.db(FIXTURE_DB);
    const meta = await readMeta(admin);
    if (meta?.hash === DATASET_HASH) {
      let allMatch = true;
      for (const c of COLLECTIONS) {
        if ((await db.collection(c).countDocuments()) !== EXPECTED_COUNTS[c]) allMatch = false;
      }
      if (allMatch) {
        console.log(`fixture: already seeded (dataset ${DATASET_HASH}) — nothing to do.`);
        return false;
      }
    }
    for (const c of COLLECTIONS) {
      await db.collection(c).deleteMany({});
      await db.collection(c).insertMany(DATASET[c].map((d) => ({ ...d })));
    }
    await db
      .collection(META_COLLECTION)
      .replaceOne(
        { _id: "version" as never },
        { _id: "version", hash: DATASET_HASH, counts: EXPECTED_COUNTS, seededAt: new Date() } as never,
        { upsert: true },
      );
    const summary = COLLECTIONS.map((c) => `${c}=${EXPECTED_COUNTS[c]}`).join(" ");
    console.log(`fixture: seeded dataset ${DATASET_HASH} into "${FIXTURE_DB}" — ${summary}`);
    return true;
  } finally {
    await admin.close();
  }
}

async function shutdown(): Promise<void> {
  if (!(await pingNoAuth())) {
    console.log("fixture: instance is not running.");
    return;
  }
  const admin = new MongoClient(ADMIN_URI);
  try {
    await admin.connect();
    await admin
      .db("admin")
      .command({ shutdown: 1 })
      .catch(() => {});
  } catch {
  } finally {
    await admin.close().catch(() => {});
  }
  for (let i = 0; i < 20 && (await pingNoAuth()); i++) await sleep(250);
  console.log("fixture: instance stopped.");
}

async function status(): Promise<void> {
  const up = await pingNoAuth();
  console.log(`fixture instance @ 127.0.0.1:${FIXTURE_PORT}`);
  console.log(`  listening: ${up ? "yes" : "no"}`);
  if (!up) {
    console.log(`  (run "npm run fixture:up" to start it)`);
    return;
  }
  console.log(`  admin auth: ${(await adminAuthWorks()) ? "ok" : "NOT bootstrapped"}`);
  const admin = new MongoClient(ADMIN_URI);
  try {
    await admin.connect();
    const db = admin.db(FIXTURE_DB);
    const meta = await readMeta(admin);
    console.log(`  seeded hash: ${meta?.hash ?? "(none)"} (dataset is ${DATASET_HASH})`);
    for (const c of COLLECTIONS) console.log(`    ${c}: ${await db.collection(c).countDocuments()}`);
  } catch {
    console.log("  (could not read fixture db)");
  } finally {
    await admin.close().catch(() => {});
  }
}

async function reset(): Promise<void> {
  await shutdown();
  if (existsSync(FIXTURE_HOME)) rmSync(FIXTURE_HOME, { recursive: true, force: true });
  console.log(`fixture: wiped ${FIXTURE_HOME}`);
  await ensureUp();
  await seed();
}

const cmd = process.argv[2] ?? "up";
switch (cmd) {
  case "up":
    await ensureUp();
    await seed();
    break;
  case "seed":
    await ensureUp();
    await seed();
    break;
  case "down":
    await shutdown();
    break;
  case "reset":
    await reset();
    break;
  case "status":
    await status();
    break;
  default:
    console.error(`Unknown command "${cmd}". Use: up | seed | status | down | reset`);
    process.exit(1);
}
process.exit(0);
