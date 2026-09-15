// test/fixtures/config.ts — connection + process constants for the mongod this
// project uses.
//
// HARD RULE: every MongoDB connection this project makes goes to THIS instance,
// on port 27018. The default port is the developer's own instance and holds
// their real work, so the project never connects to it — not to read, not to
// probe, not to measure. `test/no-default-port.test.ts` holds that line.
//
// The instance is auth-enabled, which is safe precisely because it is not the
// developer's. It carries two identities: a read-only one for the integration
// dataset, and a read-write one for the scratch databases every other suite
// seeds and rewrites. The lifecycle commands live in test/fixtures/CLAUDE.md.

import { homedir } from "node:os";
import { join } from "node:path";

export const FIXTURE_HOST = "127.0.0.1";
export const FIXTURE_PORT = 27018; // the ONLY port this project connects to
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
export const SCRATCH_ROLE = "jsmqlScratch"; // the custom role that names exactly what a suite needs
export const SCRATCH_USER = "jsmql_scratch"; // holds SCRATCH_ROLE, and nothing else
export const SCRATCH_PASS = "jsmql-fixture-scratch";

/**
 * The scratch databases — one per suite that seeds its own documents, plus the one
 * `test/probe` uses. A suite writes documents and reads them back, so it cannot use
 * the read-only identity, and it must not share a database with another suite: two
 * of them name a collection `orders`, and vitest runs suites in parallel.
 *
 * This list IS the grant. `SCRATCH_USER` gets `readWrite` on these names and on no
 * others, so the integration dataset stays unwritable even to a suite with a bug in
 * it. A new live suite therefore adds its database name HERE and re-runs
 * `npm run fixture:up` — `test/no-default-port.test.ts` fails when it forgets.
 */
export const SCRATCH_DBS = [
  "jsmql_accumulator_agrees",
  "jsmql_compiler_bson",
  "jsmql_compiler_join",
  "jsmql_compiler_js_agreement",
  "jsmql_compiler_methods",
  "jsmql_compiler_query_expr_agreement",
  "jsmql_compiler_statement",
  "jsmql_compiler_sugars",
  "jsmql_compiler_update",
  "jsmql_fold_agrees",
  "jsmql_fold_check",
  "jsmql_mode",
  "jsmql_names",
  "jsmql_parity",
  "jsmql_permutations",
  "jsmql_probe",
  "jsmql_query_expr_agreement",
  "jsmql_returns_agrees",
  "jsmql_select",
] as const;

const uri = (user: string, pass: string) =>
  `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${FIXTURE_HOST}:${FIXTURE_PORT}` +
  `/?authSource=admin&serverSelectionTimeoutMS=1500`;

export const ADMIN_URI = uri(ADMIN_USER, ADMIN_PASS); // read-write everywhere: seeding only
export const READONLY_URI = uri(READONLY_USER, READONLY_PASS); // read-only: integration tests
export const SCRATCH_URI = uri(SCRATCH_USER, SCRATCH_PASS); // read-write on SCRATCH_DBS: every other live suite

// No-credentials connection. Only usable via MongoDB's "localhost exception",
// which is active until the first user exists — that's how the seeder bootstraps
// the admin user on a fresh instance.
export const BOOTSTRAP_URI = `mongodb://${FIXTURE_HOST}:${FIXTURE_PORT}/?serverSelectionTimeoutMS=1500`;

// Collections seeded into FIXTURE_DB, plus the metadata collection that records
// which dataset version is currently injected (drives idempotent re-seeding).
export const COLLECTIONS = ["users", "products", "orders", "shipments", "reviews"] as const;
export const META_COLLECTION = "__fixture_meta";
