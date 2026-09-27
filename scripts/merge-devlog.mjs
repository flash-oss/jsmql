#!/usr/bin/env node
/**
 * Auto-resolve a `docs/DEVLOG/*.md` merge conflict.
 *
 * DEVLOG entries are append-only, one file per month (`docs/DEVLOG/YYYY-MM.md`),
 * separated by `\n\n---\n\n`. When two branches each add a new entry to the same
 * month's file, git cannot pick a correct answer and asks for a manual conflict
 * resolution. This script does the structural merge instead: split each side into
 * entries, take the union (deduplicated by the `## YYYY-MM-DD — Title` heading),
 * and sort newest-first.
 *
 * Run it after a merge stops on one or more files under `docs/DEVLOG/`:
 *
 *     ./scripts/merge-devlog.mjs
 *
 * With no argument, it finds every unmerged `docs/DEVLOG/YYYY-MM.md` path on its
 * own and resolves each one. Pass one or more paths to resolve only those:
 *
 *     ./scripts/merge-devlog.mjs docs/DEVLOG/2026-09.md
 *
 * The script reads the three index stages (base, ours, theirs) that git preserves
 * during an unresolved conflict, writes the merged file, and runs `git add` on it.
 * A file added on both sides (a new month, with no base stage) merges the same
 * way, reading its missing base as empty. Continue the merge with
 * `git merge --continue` or `git commit` afterwards. If a file is not
 * auto-resolvable (header diverged, a past entry edited differently on both
 * sides), the script reports that file, exits non-zero, and leaves it unchanged.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEP = "\n\n---\n\n";
const MONTH_FILE_RE = /^docs\/DEVLOG\/\d{4}-\d{2}\.md$/;

export function parse(text) {
  const chunks = text.split(SEP);
  const header = chunks[0].trim();
  const entries = chunks
    .slice(1)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  return { header, entries };
}

const headingOf = (entry) => entry.split("\n", 1)[0].trim();
const dateOf = (entry) => {
  const m = entry.match(/^##\s+(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
};

export function mergeDevlog(baseText, oursText, theirsText) {
  const base = parse(baseText);
  const ours = parse(oursText);
  const theirs = parse(theirsText);

  // Header: accept any one-sided edit. Reject diverging edits.
  let header;
  if (ours.header === theirs.header) header = ours.header;
  else if (ours.header === base.header) header = theirs.header;
  else if (theirs.header === base.header) header = ours.header;
  else return { ok: false, reason: "DEVLOG header was edited differently on both sides" };

  const baseMap = new Map(base.entries.map((e) => [headingOf(e), e]));
  const oursMap = new Map(ours.entries.map((e) => [headingOf(e), e]));
  const theirsMap = new Map(theirs.entries.map((e) => [headingOf(e), e]));
  const merged = new Map();

  // Step 1: entries that existed in the base. The append-only convention says past
  // entries should not change, but a one-sided edit (for example, a typo fix) is acceptable.
  for (const [k, baseEntry] of baseMap) {
    const o = oursMap.get(k);
    const t = theirsMap.get(k);
    if (o === undefined || t === undefined) {
      return { ok: false, reason: `entry "${k}" was deleted on one side` };
    }
    const oUnchanged = o === baseEntry;
    const tUnchanged = t === baseEntry;
    if (oUnchanged && tUnchanged) merged.set(k, baseEntry);
    else if (oUnchanged) merged.set(k, t);
    else if (tUnchanged) merged.set(k, o);
    else if (o === t) merged.set(k, o);
    else return { ok: false, reason: `entry "${k}" was edited differently on both sides` };
  }

  // Step 2: net-new entries from ours.
  for (const [k, e] of oursMap) {
    if (baseMap.has(k)) continue;
    merged.set(k, e);
  }

  // Step 3: net-new entries from theirs.
  for (const [k, e] of theirsMap) {
    if (baseMap.has(k)) continue;
    if (merged.has(k) && merged.get(k) !== e) {
      return { ok: false, reason: `both sides added different entries with the same heading "${k}"` };
    }
    merged.set(k, e);
  }

  // Newest first. When two entries share a date, use alphabetical order to break the tie.
  const sorted = [...merged.values()].sort((a, b) => {
    const da = dateOf(a);
    const db = dateOf(b);
    if (da !== db) return db.localeCompare(da);
    return headingOf(a).localeCompare(headingOf(b));
  });

  return { ok: true, result: header + SEP + sorted.join(SEP) + "\n" };
}

function git(args) {
  // The DEVLOG grows across a month, and `spawnSync` has its own default maximum
  // buffer size. Without a bigger one, a read fails with ENOBUFS and reports itself
  // as "not conflicted", which is the opposite of what actually happened.
  return spawnSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** Reads one conflict stage of a path. A path absent from a stage (an add/add
 * conflict, where the file is new on one or both sides) reads as empty text —
 * the same as a month's file that does not exist yet. */
function readStageOrEmpty(stage, path) {
  const r = git(["show", `:${stage}:${path}`]);
  if (r.status === 0) return r.stdout;
  return "";
}

function findConflictedDevlogPaths() {
  const r = git(["diff", "--name-only", "--diff-filter=U"]);
  if (r.status !== 0) {
    process.stderr.write(`merge-devlog: could not list unmerged paths: ${r.stderr}`);
    process.exit(2);
  }
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => MONTH_FILE_RE.test(l));
}

function resolveOne(path) {
  const result = mergeDevlog(readStageOrEmpty(1, path), readStageOrEmpty(2, path), readStageOrEmpty(3, path));
  if (!result.ok) {
    process.stderr.write(`merge-devlog: cannot auto-merge ${path} — ${result.reason}.\n`);
    return false;
  }
  writeFileSync(path, result.result);
  const add = git(["add", path]);
  if (add.status !== 0) {
    process.stderr.write(`merge-devlog: could not stage ${path}: ${add.stderr}`);
    return false;
  }
  process.stdout.write(`merge-devlog: ${path} merged and staged.\n`);
  return true;
}

function main() {
  const root = git(["rev-parse", "--show-toplevel"]);
  if (root.status !== 0) {
    process.stderr.write("merge-devlog: not in a git repository.\n");
    process.exit(2);
  }
  process.chdir(root.stdout.trim());

  const argPaths = process.argv.slice(2);
  const paths = argPaths.length > 0 ? argPaths : findConflictedDevlogPaths();
  if (paths.length === 0) {
    process.stderr.write(
      "merge-devlog: no conflicted docs/DEVLOG/YYYY-MM.md file found. " +
        "Run this during an unresolved merge, or name a path directly.\n",
    );
    process.exit(2);
  }

  const failed = paths.filter((p) => !resolveOne(p));
  if (failed.length > 0) {
    process.stderr.write(`merge-devlog: resolve ${failed.join(", ")} by hand, then \`git add\` each.\n`);
    process.exit(1);
  }
  process.stdout.write("Continue with `git merge --continue` or `git commit`.\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
