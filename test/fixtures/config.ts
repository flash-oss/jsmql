import { homedir } from "node:os";
import { join } from "node:path";

export const FIXTURE_HOST = "127.0.0.1";
export const FIXTURE_PORT = 27018;
export const FIXTURE_DB = "jsmql_fixture";

export const FIXTURE_HOME = join(homedir(), ".jsmql-fixture");
export const FIXTURE_DBPATH = join(FIXTURE_HOME, "db");
export const FIXTURE_LOGPATH = join(FIXTURE_HOME, "mongod.log");
export const FIXTURE_PIDPATH = join(FIXTURE_HOME, "mongod.pid");

export const ADMIN_USER = "jsmql_admin";
export const ADMIN_PASS = "jsmql-fixture-admin";
export const READONLY_USER = "jsmql_ro";
export const READONLY_PASS = "jsmql-fixture-ro";
export const SCRATCH_ROLE = "jsmqlScratch";
export const SCRATCH_USER = "jsmql_scratch";
export const SCRATCH_PASS = "jsmql-fixture-scratch";

export const SCRATCH_DBS = [
  "jsmql_accumulator_agrees",
  "jsmql_compiler_bson",
  "jsmql_compiler_interpret",
  "jsmql_compiler_join",
  "jsmql_compiler_js_agreement",
  "jsmql_compiler_methods",
  "jsmql_compiler_query_expr_agreement",
  "jsmql_compiler_raw_mql",
  "jsmql_compiler_statement",
  "jsmql_compiler_sugars",
  "jsmql_compiler_types",
  "jsmql_compiler_update",
  "jsmql_fold_agrees",
  "jsmql_fold_check",
  "jsmql_human",
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

export const ADMIN_URI = uri(ADMIN_USER, ADMIN_PASS);
export const READONLY_URI = uri(READONLY_USER, READONLY_PASS);
export const SCRATCH_URI = uri(SCRATCH_USER, SCRATCH_PASS);

export const BOOTSTRAP_URI = `mongodb://${FIXTURE_HOST}:${FIXTURE_PORT}/?serverSelectionTimeoutMS=1500`;

export const COLLECTIONS = ["users", "products", "orders", "shipments", "reviews"] as const;
export const META_COLLECTION = "__fixture_meta";
