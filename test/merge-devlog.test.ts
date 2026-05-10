/**
 * Unit tests for the structural-merge core of `scripts/merge-devlog.mjs`.
 * The CLI side (reading git index stages, calling `git add`) is covered
 * indirectly by the script's smoke usage; here we exercise the pure
 * merge function directly so future regressions in the merge logic
 * surface in `npm test`.
 */

import { describe, it, expect } from "vitest";
import { mergeDevlog, parse } from "../scripts/merge-devlog.mjs";

const SEP = "\n\n---\n\n";
const HEADER = "# DEVLOG\n\nA chronological log of decisions, etc.";
const E_OLD_A = "## 2026-04-01 — Old entry A\n\nbody of A";
const E_OLD_B = "## 2026-03-15 — Old entry B\n\nbody of B";
const BASE = HEADER + SEP + E_OLD_A + SEP + E_OLD_B;

describe("merge-devlog: parse", () => {
  it("splits header from entries on \\n\\n---\\n\\n separators", () => {
    const { header, entries } = parse(BASE);
    expect(header).toBe(HEADER);
    expect(entries).toEqual([E_OLD_A, E_OLD_B]);
  });

  it("trims trailing whitespace, drops empty entries", () => {
    const text = HEADER + SEP + E_OLD_A + "\n\n" + SEP + "" + SEP + E_OLD_B + "\n";
    const { entries } = parse(text);
    expect(entries).toEqual([E_OLD_A, E_OLD_B]);
  });
});

describe("merge-devlog: append-friendly merges", () => {
  it("auto-merges when each side prepended a different new entry", () => {
    const newOurs = "## 2026-05-10 — Smoke checks codified\n\nour body";
    const newTheirs = "## 2026-05-10 — Other thing\n\ntheir body";
    const ours = HEADER + SEP + newOurs + SEP + E_OLD_A + SEP + E_OLD_B;
    const theirs = HEADER + SEP + newTheirs + SEP + E_OLD_A + SEP + E_OLD_B;

    const r = mergeDevlog(BASE, ours, theirs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.result).toContain("Smoke checks codified");
    expect(r.result).toContain("Other thing");
    expect(r.result).toContain("Old entry A");
    expect(r.result).toContain("Old entry B");

    // 2026-05-10 entries appear before 2026-04-01 (newest-first).
    expect(r.result.indexOf("2026-05-10")).toBeLessThan(r.result.indexOf("2026-04-01"));
    // Same-date entries ordered alphabetically by heading: "Other …" < "Smoke …"
    expect(r.result.indexOf("Other thing")).toBeLessThan(r.result.indexOf("Smoke checks codified"));
  });

  it("is a no-op when both sides are identical to base", () => {
    const r = mergeDevlog(BASE, BASE, BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Output is normalised but content-equivalent to BASE.
    expect(parse(r.result)).toEqual(parse(BASE));
  });

  it("collapses identical new entries added on both sides", () => {
    const sameNew = "## 2026-05-10 — Same idea\n\nbody";
    const ours = HEADER + SEP + sameNew + SEP + E_OLD_A + SEP + E_OLD_B;
    const r = mergeDevlog(BASE, ours, ours);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.match(/Same idea/g)?.length).toBe(1);
  });

  it("accepts a one-sided edit of an existing entry (typo fix)", () => {
    const fixed = "## 2026-04-01 — Old entry A\n\nbody of A (fixed typo)";
    const ours = HEADER + SEP + fixed + SEP + E_OLD_B;
    const r = mergeDevlog(BASE, ours, BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toContain("fixed typo");
  });
});

describe("merge-devlog: real conflicts fall back", () => {
  it("rejects diverging edits to the same existing entry", () => {
    const editedOurs = "## 2026-04-01 — Old entry A\n\nbody of A — ours";
    const editedTheirs = "## 2026-04-01 — Old entry A\n\nbody of A — theirs";
    const ours = HEADER + SEP + editedOurs + SEP + E_OLD_B;
    const theirs = HEADER + SEP + editedTheirs + SEP + E_OLD_B;
    const r = mergeDevlog(BASE, ours, theirs);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("edited differently");
  });

  it("rejects diverging new entries that share a heading", () => {
    const oursNew = "## 2026-05-10 — Same heading\n\nour body";
    const theirsNew = "## 2026-05-10 — Same heading\n\ntheir body";
    const ours = HEADER + SEP + oursNew + SEP + E_OLD_A + SEP + E_OLD_B;
    const theirs = HEADER + SEP + theirsNew + SEP + E_OLD_A + SEP + E_OLD_B;
    const r = mergeDevlog(BASE, ours, theirs);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("same heading");
  });

  it("rejects diverging header edits", () => {
    const oursH = "# DEVLOG\n\nOur new prelude.";
    const theirsH = "# DEVLOG\n\nTheir new prelude.";
    const ours = oursH + SEP + E_OLD_A + SEP + E_OLD_B;
    const theirs = theirsH + SEP + E_OLD_A + SEP + E_OLD_B;
    const r = mergeDevlog(BASE, ours, theirs);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("header");
  });

  it("rejects deletion of a base entry on one side", () => {
    const ours = HEADER + SEP + E_OLD_B;
    const r = mergeDevlog(BASE, ours, BASE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("deleted");
  });
});
