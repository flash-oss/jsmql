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
// The vendored directory is gitignored; this script repopulates it on demand
// and runs automatically as the package's `prepare` lifecycle hook.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_SHA = "671c69579f9852c12ff89834ac73239f27005f81";
const REPO_URL = "https://github.com/mongodb/mql-specifications.git";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "mql-specifications");
const sentinel = resolve(target, ".pinned-sha");

function readSentinel() {
  if (!existsSync(sentinel)) return null;
  try {
    return execSync(`cat "${sentinel}"`, { encoding: "utf8" }).trim();
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
  execSync(`git clone --quiet ${REPO_URL} "${target}"`, { stdio: "inherit" });
  execSync(`git -C "${target}" checkout --quiet ${PINNED_SHA}`, { stdio: "inherit" });
  execSync(`echo "${PINNED_SHA}" > "${sentinel}"`);
} catch (err) {
  console.error(
    `\nfetch-mql-specs: failed to clone ${REPO_URL} at ${PINNED_SHA}.\n` +
      `The MongoDB MQL specifications are required for the operator-coverage test.\n` +
      `If you are offline, the test will fail until you can reach github.com.\n`,
  );
  process.exit(1);
}
