// test/fixtures/config.ts — connection + process constants for the dedicated
// "fixture" mongod the integration suite runs against.
//
// This is a SEPARATE mongod from the developer's primary instance (:27017), so
// enabling `--auth` here never forces credentials onto their real services. It
// exists only to host the read-only integration dataset. The full rationale and
// the lifecycle commands live in test/fixtures/CLAUDE.md.

import { homedir } from "node:os";
import { join } from "node:path";

export const FIXTURE_HOST = "127.0.0.1";
export const FIXTURE_PORT = 27018; // deliberately NOT 27017 — keep the primary mongod untouched
export const FIXTURE_DB = "jsmql_fixture";

// The dedicated instance's data lives OUTSIDE the repo/worktree so it survives
// worktree cleanup and is shared across branches. It is throwaway local test
// data — safe to delete and rebuild with `npm run fixture:reset`.
export const FIXTURE_HOME = join(homedir(), ".jsmql-fixture");
export const FIXTURE_DBPATH = join(FIXTURE_HOME, "db");
export const FIXTURE_LOGPATH = join(FIXTURE_HOME, "mongod.log");
export const FIXTURE_PIDPATH = join(FIXTURE_HOME, "mongod.pid");

// Credentials for a LOCAL, THROWAWAY fixture instance — deliberately not secret.
// The whole point of the auth-enabled instance is a server-ENFORCED read-only
// role for the test connection: the read-only user literally cannot write, so
// the dataset can never be mutated by a test run.
export const ADMIN_USER = "jsmql_admin"; // root role — used ONLY by the seeder
export const ADMIN_PASS = "jsmql-fixture-admin";
export const READONLY_USER = "jsmql_ro"; // read-only role on FIXTURE_DB — used by tests
export const READONLY_PASS = "jsmql-fixture-ro";

const uri = (user: string, pass: string) =>
  `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${FIXTURE_HOST}:${FIXTURE_PORT}` +
  `/?authSource=admin&serverSelectionTimeoutMS=1500`;

export const ADMIN_URI = uri(ADMIN_USER, ADMIN_PASS); // read-write: seeding only
export const READONLY_URI = uri(READONLY_USER, READONLY_PASS); // read-only: integration tests

// No-credentials connection. Only usable via MongoDB's "localhost exception",
// which is active until the first user exists — that's how the seeder bootstraps
// the admin user on a fresh instance.
export const BOOTSTRAP_URI = `mongodb://${FIXTURE_HOST}:${FIXTURE_PORT}/?serverSelectionTimeoutMS=1500`;

// Collections seeded into FIXTURE_DB, plus the metadata collection that records
// which dataset version is currently injected (drives idempotent re-seeding).
export const COLLECTIONS = ["users", "products", "orders", "shipments", "reviews"] as const;
export const META_COLLECTION = "__fixture_meta";
