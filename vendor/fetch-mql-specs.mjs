#!/usr/bin/env node
// Clone the official MongoDB MQL specifications repo into vendor/mql-specifications/
// at a pinned commit. The upstream repo has no package.json, so it cannot be
// installed as a normal npm devDependency — vendoring is the cleaner alternative.
//
// Spec is used by:
//   - test/operator-spec-coverage.test.ts (drift detection)
//   - manual reference when adding operators to src/operators.ts
//
// Idempotent: if the target directory exists at the pinned SHA, exits quickly.
// The vendored directory is gitignored; this script repopulates it on demand.
//
// Uses partial-clone (`--filter=blob:none`) + sparse-checkout to fetch only
// the three definition folders we actually consume — `expression`,
// `accumulator`, `stage`. Cuts the on-disk + clone-time footprint by ~80%
// vs. a full clone.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_SHA = "671c69579f9852c12ff89834ac73239f27005f81";
const REPO_URL = "https://github.com/mongodb/mql-specifications.git";
const SPARSE_PATHS = ["definitions/expression", "definitions/accumulator", "definitions/stage"];

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "mql-specifications");
const sentinel = resolve(target, ".pinned-sha");

function readSentinel() {
  if (!existsSync(sentinel)) return null;
  try {
    return readFileSync(sentinel, "utf8").trim();
  } catch {
    return null;
  }
}

if (readSentinel() === PINNED_SHA) {
  process.exit(0);
}

if (existsSync(target)) {
  rmSync(target, { recursive: true, force: true });
}

mkdirSync(dirname(target), { recursive: true });

try {
  execSync(`git clone --quiet --no-checkout --filter=blob:none ${REPO_URL} "${target}"`, { stdio: "inherit" });
  execSync(`git -C "${target}" sparse-checkout init --cone`, { stdio: "inherit" });
  execSync(`git -C "${target}" sparse-checkout set ${SPARSE_PATHS.join(" ")}`, { stdio: "inherit" });
  execSync(`git -C "${target}" checkout --quiet ${PINNED_SHA}`, { stdio: "inherit" });
  writeFileSync(sentinel, `${PINNED_SHA}\n`);
} catch (err) {
  console.error(
    `\nfetch-mql-specs: failed to clone ${REPO_URL} at ${PINNED_SHA}.\n` +
      `The MongoDB MQL specifications are required for the operator-coverage test.\n` +
      `If you are offline, the test will fail until you can reach github.com.\n`,
  );
  process.exit(1);
}
