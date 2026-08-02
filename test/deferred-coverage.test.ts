import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

// ---------------------------------------------------------------------------
// Drift-protection test for the deferred-tracking system. See
// docs/DEFERRED.md for the convention.
//
// Three gates, all enforced on every `npm test`:
//
//   1. FORWARD     — every [DEF-NNN] tag in the live surface must have a
//                    matching row in docs/DEFERRED.md.
//   2. REVERSE     — every row in docs/DEFERRED.md must be referenced by at
//                    least one [DEF-NNN] tag in the live surface (unless
//                    the row's Status is "design-only").
//   3. UNTAGGED    — every "not yet supported" / "future work" / "deferred"
//                    phrase in the live surface must be tagged [DEF-NNN]
//                    OR appear in test/deferred-allowlist.txt.
//
// Plus a meta-gate:
//
//   4. STALE-ALLOWLIST — every entry in test/deferred-allowlist.txt must
//                    match at least one phrase in the live surface, so the
//                    allowlist cannot accumulate stale entries.
//
// Live surface = src/**/*.ts (excluding ops.ts), docs/specs/**/*.md,
// docs/LANGUAGE.md, docs/CLAUDE.md, README.md, test/**/*.ts (except this
// file and operator-spec-coverage.test.ts's meta-comment).
//
// Excluded: docs/DEVLOG.md (append-only history), docs/DEFERRED.md itself,
// this test file itself, the allowlist, vendor/, node_modules/, dist/,
// src/ops.ts (generated).
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, "..");
const DEF_TAG_RE = /\[DEF-(\d{3})\]/g;
// Rows live under the `## §A.` section as `### DEF-NNN — title` headings.
const ROW_HEADING_RE = /^### DEF-(\d{3}) — (.+)$/gm;
const STATUS_RE = /^- \*\*Status\.\*\* (.+)$/m;
// Lines within ±TAG_CONTEXT of a phrase line are scanned for [DEF-NNN] tags,
// so a multi-line markdown list item can carry its tag on the bullet's first
// line even when the phrase falls on a continuation line.
const TAG_CONTEXT = 2;

// Phrases that signal a deferral. Case-insensitive substring match against
// each line. Tuned to match what's already in the codebase. Tightening
// these (e.g. dropping "follow-up") would require manual review of every
// false-positive.
const PHRASE_RE =
  /(not yet (supported|implemented)|not supported in this release|is deferred|are deferred|deferred to|future work|out of scope|punt to a follow-up|coming in a follow-up|coming soon|planned but not yet|planned future work)/i;

// File extensions / paths to scan.
const SCAN_EXTS = new Set([".ts", ".md"]);

// Skip these directories entirely.
const SKIP_DIRS = new Set(["node_modules", "dist", "vendor", ".git", ".claude"]);

// Files excluded from gates 1-3 (the meta-files of the system itself, plus
// the append-only history).
const EXCLUDED_FILES = new Set([
  "docs/DEVLOG.md",
  "docs/DEFERRED.md",
  "test/deferred-coverage.test.ts",
  "test/deferred-allowlist.txt",
  "src/ops.ts",
]);

interface FileLine {
  file: string; // relative path from root
  lineNum: number; // 1-based
  text: string;
}

function walkSourceTree(dir: string, acc: FileLine[]): void {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    const rel = relative(ROOT, full);
    if (SKIP_DIRS.has(name)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSourceTree(full, acc);
      continue;
    }
    if (!SCAN_EXTS.has(extOf(name))) continue;
    if (EXCLUDED_FILES.has(rel)) continue;
    const lines = readFileSync(full, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      acc.push({ file: rel, lineNum: i + 1, text: lines[i] });
    }
  }
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.substring(dot);
}

function parseDeferred(): {
  rows: Map<string, { title: string; status: string; section: string }>;
  /** Every §A id in file order, duplicates INCLUDED — `rows` is a Map, so a repeated
   *  id silently overwrites and both the forward and reverse gates still pass. */
  idsInOrder: string[];
} {
  const text = readFileSync(resolve(ROOT, "docs/DEFERRED.md"), "utf8");
  const rows = new Map<string, { title: string; status: string; section: string }>();
  const idsInOrder: string[] = [];

  // Section §B (Decisions) records won't-implement choices with `### <title>`
  // (no DEF-NNN ID) — pull only §A. Section markers are `## §A.` / `## §B.`.
  const sectionStart = text.indexOf("## §A.");
  const sectionEnd = text.indexOf("## §B.");
  const sectionA = sectionStart >= 0 && sectionEnd >= 0 ? text.substring(sectionStart, sectionEnd) : text;

  for (const m of sectionA.matchAll(ROW_HEADING_RE)) {
    const id = m[1];
    const title = m[2];
    // Find the row's body (up to the next `### DEF-` or end of section).
    const headingEnd = m.index! + m[0].length;
    const nextHeading = sectionA.substring(headingEnd).search(/^### DEF-\d{3} — /m);
    const body =
      nextHeading >= 0 ? sectionA.substring(headingEnd, headingEnd + nextHeading) : sectionA.substring(headingEnd);
    const statusMatch = STATUS_RE.exec(body);
    const status = statusMatch ? statusMatch[1].trim().toLowerCase() : "open";
    rows.set(id, { title, status, section: "A" });
    idsInOrder.push(id);
  }
  return { rows, idsInOrder };
}

/** True if any line within ±TAG_CONTEXT of the given index carries a [DEF-NNN] tag. */
function hasNearbyTag(surface: FileLine[], idx: number): boolean {
  const file = surface[idx].file;
  for (let j = idx - TAG_CONTEXT; j <= idx + TAG_CONTEXT; j++) {
    if (j < 0 || j >= surface.length) continue;
    if (surface[j].file !== file) continue;
    DEF_TAG_RE.lastIndex = 0;
    if (DEF_TAG_RE.test(surface[j].text)) {
      DEF_TAG_RE.lastIndex = 0;
      return true;
    }
  }
  return false;
}

function parseAllowlist(): { file: string; phrase: string }[] {
  const text = readFileSync(resolve(ROOT, "test/deferred-allowlist.txt"), "utf8");
  const entries: { file: string; phrase: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const sep = line.indexOf("::");
    if (sep < 0) {
      throw new Error(`Malformed allowlist line (missing '::'): ${JSON.stringify(line)}`);
    }
    const file = line.substring(0, sep).trim();
    const phrase = line.substring(sep + 2).trim();
    entries.push({ file, phrase });
  }
  return entries;
}

describe("deferred-tracking drift protection", () => {
  // Build the surface once for all gates.
  const surface: FileLine[] = [];
  walkSourceTree(ROOT, surface);

  const { rows } = parseDeferred();
  const allowlist = parseAllowlist();

  function isAllowlisted(file: string, text: string): boolean {
    // Don't short-circuit — multiple allowlist entries may match the same
    // line. The stale-allowlist gate needs to see every entry that matches
    // anything, not just the first.
    for (let i = 0; i < allowlist.length; i++) {
      const a = allowlist[i];
      if (a.file === file && text.includes(a.phrase)) return true;
    }
    return false;
  }

  /** Compute the set of allowlist indices that match at least one phrase line. */
  function computeAllowlistHits(): Set<number> {
    const hits = new Set<number>();
    for (let i = 0; i < surface.length; i++) {
      const line = surface[i];
      // Scan every line, not just phrase-bearing ones. An allowlist entry's
      // phrase might be a substring of a line that doesn't itself carry a
      // canonical deferral phrase but is part of a multi-line context.
      // Tighten: only count hits on lines that ARE phrase-bearing (otherwise
      // a stale phrase wouldn't be detected as stale).
      if (!PHRASE_RE.test(line.text)) continue;
      for (let j = 0; j < allowlist.length; j++) {
        if (hits.has(j)) continue;
        const a = allowlist[j];
        if (a.file === line.file && line.text.includes(a.phrase)) hits.add(j);
      }
    }
    return hits;
  }

  it("UNIQUE-ID GATE: no two §A rows share a DEF-NNN id", () => {
    // Two features under one id makes every `[DEF-NNN]` tag ambiguous — a reader
    // following the tag lands on whichever row happens to come first. It also hides
    // from the other gates: `rows` is a Map, so the duplicate overwrites and both
    // forward and reverse still find a match. DEF-034 was shared by two unrelated
    // items this way until 2026-08-01.
    const { idsInOrder } = parseDeferred();
    const seen = new Set<string>();
    const dupes = idsInOrder.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(dupes, `duplicate DEF ids in docs/DEFERRED.md §A: ${[...new Set(dupes)].join(", ")}`).toEqual([]);
  });

  it("FORWARD GATE: every [DEF-NNN] tag has a row in docs/DEFERRED.md", () => {
    const violations: string[] = [];
    const tagToSites = new Map<string, string[]>();
    for (const line of surface) {
      DEF_TAG_RE.lastIndex = 0;
      for (const m of line.text.matchAll(DEF_TAG_RE)) {
        const id = m[1];
        const site = `${line.file}:${line.lineNum}`;
        if (!tagToSites.has(id)) tagToSites.set(id, []);
        tagToSites.get(id)!.push(site);
      }
    }
    for (const [id, sites] of tagToSites) {
      if (!rows.has(id)) {
        violations.push(
          `[DEF-${id}] is referenced at ${sites[0]}${sites.length > 1 ? ` (and ${sites.length - 1} other site${sites.length > 2 ? "s" : ""})` : ""} but has no '## DEF-${id} — ...' row in docs/DEFERRED.md. Either add the row or remove the tag.`,
        );
      }
    }
    if (violations.length > 0) {
      throw new Error("Forward-gate failures:\n" + violations.map((v) => "  - " + v).join("\n"));
    }
  });

  it("REVERSE GATE: every row in docs/DEFERRED.md is referenced by at least one [DEF-NNN] tag", () => {
    const tagsInSurface = new Set<string>();
    for (const line of surface) {
      DEF_TAG_RE.lastIndex = 0;
      for (const m of line.text.matchAll(DEF_TAG_RE)) {
        tagsInSurface.add(m[1]);
      }
    }
    const violations: string[] = [];
    for (const [id, row] of rows) {
      if (tagsInSurface.has(id)) continue;
      // design-only rows are exempt — they describe future work that hasn't
      // produced a rejection site in code yet.
      if (row.status === "design-only" || row.status.startsWith("design-only")) continue;
      violations.push(
        `DEF-${id} (${row.title}) has a row in docs/DEFERRED.md with status "${row.status}" but no '[DEF-${id}]' tag anywhere in the live surface. Either tag the rejection site, mark the row 'status: design-only', or delete the row if the feature shipped.`,
      );
    }
    if (violations.length > 0) {
      throw new Error("Reverse-gate failures:\n" + violations.map((v) => "  - " + v).join("\n"));
    }
  });

  it("UNTAGGED GATE: every deferral phrase carries a [DEF-NNN] tag or is allowlisted", () => {
    const violations: string[] = [];
    for (let i = 0; i < surface.length; i++) {
      const line = surface[i];
      if (!PHRASE_RE.test(line.text)) continue;
      if (hasNearbyTag(surface, i)) continue;
      if (isAllowlisted(line.file, line.text)) continue;
      violations.push(
        `${line.file}:${line.lineNum} — deferral phrase without [DEF-NNN] tag: ${JSON.stringify(line.text.trim().substring(0, 160))}. Either (a) add a row in docs/DEFERRED.md and tag this line with [DEF-NNN] (within ${TAG_CONTEXT} lines), or (b) add a line to test/deferred-allowlist.txt with a reason.`,
      );
    }
    if (violations.length > 0) {
      throw new Error(
        `Untagged-marker-gate failures (${violations.length}):\n` + violations.map((v) => "  - " + v).join("\n"),
      );
    }
  });

  it("STALE-ALLOWLIST GATE: every entry in test/deferred-allowlist.txt matches at least one live phrase", () => {
    const hits = computeAllowlistHits();
    const stale: string[] = [];
    for (let i = 0; i < allowlist.length; i++) {
      if (!hits.has(i)) {
        stale.push(
          `  - ${allowlist[i].file} :: ${allowlist[i].phrase} — no matching phrase found. The feature may have shipped (delete the entry), the phrase wording changed (update the entry), or another allowlist entry already covers the same line (delete this redundant one).`,
        );
      }
    }
    if (stale.length > 0) {
      throw new Error(
        `Stale-allowlist-gate failures (${stale.length}). The allowlist cannot accumulate dead entries.\n` +
          stale.join("\n"),
      );
    }
  });
});
