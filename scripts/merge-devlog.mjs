#!/usr/bin/env node
/**
 * Auto-resolve a `docs/DEVLOG.md` merge conflict.
 *
 * DEVLOG entries are append-only and separated by `\n\n---\n\n`. When two
 * branches each add a new entry at the top, git cannot pick a correct answer and asks
 * for a manual conflict resolution. This script does the structural merge instead:
 * split each side into entries, take the union (deduplicated by the `## YYYY-MM-DD — Title`
 * heading), and sort newest-first.
 *
 * Run it after a merge stops on `docs/DEVLOG.md`:
 *
 *     ./scripts/merge-devlog.mjs
 *
 * The script reads the three index stages (base, ours, theirs) that git preserves during
 * an unresolved conflict, writes the merged file, and runs `git add` on it. Continue
 * the merge with `git merge --continue` or `git commit` afterwards. If the merge is not
 * auto-resolvable (header diverged, a past entry edited differently on both sides),
 * the script exits non-zero and leaves the conflicted file unchanged.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEP = "\n\n---\n\n";
const TARGET = "docs/DEVLOG.md";

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

function readStage(stage) {
  // The DEVLOG is append-only and already more than one megabyte. `spawnSync` has its own
  // default maximum buffer size. Without a bigger one, the read fails with ENOBUFS and reports
  // itself as "not conflicted", which is the opposite of what actually happened.
  const r = spawnSync("git", ["show", `:${stage}:${TARGET}`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error !== undefined) {
    process.stderr.write(`merge-devlog: could not run git to read stage ${stage} of ${TARGET}: ${r.error.message}\n`);
    process.exit(2);
  }
  if (r.status !== 0) {
    process.stderr.write(
      `merge-devlog: cannot read stage ${stage} of ${TARGET}. ` +
        `Is ${TARGET} actually conflicted? (run during an unresolved merge)\n${r.stderr}`,
    );
    process.exit(2);
  }
  return r.stdout;
}

function main() {
  // Confirm we're inside a git work tree at its root.
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (root.status !== 0) {
    process.stderr.write("merge-devlog: not in a git repository.\n");
    process.exit(2);
  }
  process.chdir(root.stdout.trim());

  const result = mergeDevlog(readStage(1), readStage(2), readStage(3));
  if (!result.ok) {
    process.stderr.write(
      `merge-devlog: cannot auto-merge — ${result.reason}.\n` +
        `Resolve ${TARGET} by hand, then \`git add ${TARGET}\`.\n`,
    );
    process.exit(1);
  }

  writeFileSync(TARGET, result.result);
  const add = spawnSync("git", ["add", TARGET], { stdio: "inherit" });
  if (add.status !== 0) process.exit(add.status ?? 1);

  process.stdout.write(
    `merge-devlog: ${TARGET} merged and staged. ` + `Continue with \`git merge --continue\` or \`git commit\`.\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
