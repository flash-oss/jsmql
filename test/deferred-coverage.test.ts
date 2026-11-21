import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DEF_TAG_RE = /\[DEF-(\d{3})\]/g;
const ROW_HEADING_RE = /^### DEF-(\d{3}) — (.+)$/gm;
const STATUS_RE = /^- \*\*Status\.\*\* (.+)$/m;
const TAG_CONTEXT = 2;

const PHRASE_RE =
  /(not yet (supported|implemented)|not supported in this release|is deferred|are deferred|deferred to|future work|out of scope|punt to a follow-up|coming in a follow-up|coming soon|planned but not yet|planned future work)/i;

const SCAN_EXTS = new Set([".ts", ".md"]);

const SKIP_DIRS = new Set(["node_modules", "dist", "vendor", ".git", ".claude", "tmp", "DEVLOG"]);

const EXCLUDED_FILES = new Set([
  "docs/DEFERRED.md",
  "test/deferred-coverage.test.ts",
  "test/deferred-allowlist.txt",
  "src/globals.ts",
]);

interface FileLine {
  file: string;
  lineNum: number;
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
  idsInOrder: string[];
} {
  const text = readFileSync(resolve(ROOT, "docs/DEFERRED.md"), "utf8");
  const rows = new Map<string, { title: string; status: string; section: string }>();
  const idsInOrder: string[] = [];

  const sectionStart = text.indexOf("## §A.");
  const sectionEnd = text.indexOf("## §B.");
  const sectionA = sectionStart >= 0 && sectionEnd >= 0 ? text.substring(sectionStart, sectionEnd) : text;

  for (const m of sectionA.matchAll(ROW_HEADING_RE)) {
    const id = m[1];
    const title = m[2];
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
  const surface: FileLine[] = [];
  walkSourceTree(ROOT, surface);

  const { rows } = parseDeferred();
  const allowlist = parseAllowlist();

  function isAllowlisted(file: string, text: string): boolean {
    for (let i = 0; i < allowlist.length; i++) {
      const a = allowlist[i];
      if (a.file === file && text.includes(a.phrase)) return true;
    }
    return false;
  }

  function computeAllowlistHits(): Set<number> {
    const hits = new Set<number>();
    for (let i = 0; i < surface.length; i++) {
      const line = surface[i];
      if (!PHRASE_RE.test(line.text)) continue;
      for (let j = 0; j < allowlist.length; j++) {
        if (hits.has(j)) continue;
        const a = allowlist[j];
        if (a.file === line.file && line.text.includes(a.phrase)) hits.add(j);
      }
    }
    return hits;
  }

  it("COUNT GATE: the number of open items and decisions, so no prose has to claim it", () => {
    const { idsInOrder } = parseDeferred();
    const text = readFileSync(resolve(ROOT, "docs/DEFERRED.md"), "utf8");
    const decisions = text.substring(text.indexOf("## §B.")).match(/^### /gm) ?? [];
    expect({ open: idsInOrder.length, decided: decisions.length }).toEqual({ open: 9, decided: 18 });
  });

  it("ID ORDER GATE: §A rows are in ascending id order, as the header states", () => {
    const { idsInOrder } = parseDeferred();
    expect(idsInOrder).toEqual([...idsInOrder].sort());
  });

  it("UNIQUE-ID GATE: no two §A rows share a DEF-NNN id", () => {
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
