#!/usr/bin/env node
// Clone the official MongoDB MQL specifications repository to vendor/mql-specifications/
// at a pinned commit. The upstream repository has no package.json, so you cannot install it
// as a normal npm devDependency. Vendoring is the cleaner choice.
//
// The spec is used by:
//   - test/operator-spec-coverage.test.ts (drift detection)
//   - manual reference when you add an operator row to src/registry/names.ts
//
// This script is idempotent: if the target directory exists at the pinned SHA, it exits quickly.
// The vendored directory is gitignored. This script repopulates it on demand.
//
// It uses partial-clone (`--filter=blob:none`) and sparse-checkout to fetch only the three
// definition folders you use: `expression`, `accumulator`, and `stage`. This cuts the on-disk
// and clone-time footprint by about 80 percent compared to a full clone.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_SHA = "671c69579f9852c12ff89834ac73239f27005f81";
const REPO_URL = "https://github.com/mongodb/mql-specifications.git";
// `types` carries the enum members named by `arguments[].type` (for example, every valid
// `timeUnit`). The registry otherwise holds these as hand-written lists (`TIME_UNIT` in
// src/registry/names.ts) with nothing to check them against. `query` describes the MQL
// query language: the surface Filter mode and `$match` lower into it. It is the only part of
// MQL jsmql produces that has no spec to reconcile against. See docs/specs/filter-mode.md.
const SPARSE_PATHS = [
  "definitions/expression",
  "definitions/accumulator",
  "definitions/stage",
  "definitions/types",
  "definitions/query",
];

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
