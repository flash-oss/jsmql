/**
 * HARD RULE: this project connects to ONE mongod, the instance on port 27018 that
 * `npm run fixture:up` starts. MongoDB's default port belongs to the developer's own
 * instance, which holds their real work — this project never reads it, writes it,
 * probes it or measures against it.
 *
 * A rule written only in prose gets broken by the next person who copies a URI from a
 * tutorial, so it is a test. Two things are checked:
 *
 *   1. No file in the repository names the default port in a connection string.
 *   2. Every database a suite writes to is listed in SCRATCH_DBS, which IS the grant
 *      the scratch user holds. A suite that writes elsewhere gets an authentication
 *      error, and a self-skipping suite would turn that into a silent green.
 *
 * docs/DEVLOG.md is exempt from the first check: it is the historical record, and
 * history says what used to be true.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { SCRATCH_DBS } from "./fixtures/config.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories that hold no source of ours — a hit there says nothing about this project. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "vendor", "tmp", ".idea", "coverage"]);
/**
 * Is this directory a checkout of its own — a nested git worktree?
 *
 * A worktree's root carries `.git` as a FILE pointing at the parent repository.
 * The ones under `.claude/worktrees/` are other branches at other commits, and
 * what they say is true of THEM: a session working on a branch from before this
 * rule existed would fail the rule for every session that ran a suite from here.
 */
const isOwnCheckout = (dir: string): boolean => existsSync(join(dir, ".git"));
/** The historical record states what was once true; every other file states what IS true. */
const EXEMPT = new Set(["docs/DEVLOG.md", "test/no-default-port.test.ts"]);
const READABLE = /\.(ts|tsx|mts|mjs|js|json|md|html|yml|yaml|sh|txt)$/;

function repoFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!isOwnCheckout(full)) repoFiles(full, out);
    } else if (READABLE.test(name) || name === "probe") out.push(full);
  }
  return out;
}

describe("the default mongod port is never used", () => {
  it("no file names it in a connection string", () => {
    // Written in halves so this file's own rule does not trip the search it performs.
    const banned = new RegExp("2" + "7017");
    const offenders: string[] = [];
    for (const file of repoFiles(ROOT)) {
      const rel = relative(ROOT, file);
      if (EXEMPT.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      if (banned.test(text)) {
        const line = text.split("\n").findIndex((l) => banned.test(l)) + 1;
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(
      offenders,
      `These files name MongoDB's default port. This project uses :27018 only — ` +
        `import SCRATCH_URI from test/fixtures/config.ts instead:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every database a suite writes to is one the scratch user may write", () => {
    // `admin` carries no data: a suite names it only to `ping`, which needs no role.
    const allowed = new Set<string>([...SCRATCH_DBS, "admin"]);
    const named = new Map<string, string>();
    for (const file of readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".test.ts"))) {
      const text = readFileSync(join(ROOT, "test", file), "utf8");
      for (const m of text.matchAll(/\.db\("([A-Za-z0-9_]+)"\)/g)) named.set(m[1], file);
    }
    const missing = [...named].filter(([db]) => !allowed.has(db)).map(([db, f]) => `${db} (${f})`);
    expect(
      missing,
      `These databases are not in SCRATCH_DBS, so the scratch user cannot write them and ` +
        `the suite will skip itself green. Add each to test/fixtures/config.ts and re-run ` +
        `\`npm run fixture:up\`:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the connection string the suites share points at the fixture port", async () => {
    const { SCRATCH_URI, FIXTURE_PORT } = await import("./fixtures/config.ts");
    expect(FIXTURE_PORT).toBe(27018);
    expect(SCRATCH_URI).toContain(`:${FIXTURE_PORT}`);
  });
});

/**
 * The scratch identity must hold, on every scratch database, what a live suite needs.
 * A missing grant does not fail that suite — each one wraps its setup in try/catch and
 * reads any error as "no server", so it degrades to compile-only AND STILL REPORTS
 * GREEN. The usual way to reach that state is to add a database to SCRATCH_DBS and
 * forget to re-run `npm run fixture:up`.
 *
 * The check READS the grant rather than exercising it: dropping and rewriting the
 * suites' own databases would fight the suites, which vitest runs in parallel.
 * It skips (green) only when the instance is down, like every other live suite.
 */
describe("the scratch identity holds what a live suite needs", () => {
  it("has readWrite, dbAdmin and indexStats on every scratch database", async () => {
    const { SCRATCH_DBS } = await import("./fixtures/config.ts");
    const { liveClient } = await import("./fixtures/live.ts");
    const client = await liveClient();
    if (client === null) return; // the instance is down — `npm run fixture:up` starts it
    let status: Record<string, unknown>;
    try {
      status = await client.db("admin").command({ connectionStatus: 1, showPrivileges: true });
    } finally {
      await client.close().catch(() => {});
    }
    const info = (status.authInfo ?? {}) as {
      authenticatedUserRoles?: { role: string; db: string }[];
      authenticatedUserPrivileges?: { resource: { db?: string }; actions: string[] }[];
    };
    const held = new Set((info.authenticatedUserRoles ?? []).map((r) => `${r.role}@${r.db}`));
    const indexStats = new Set(
      (info.authenticatedUserPrivileges ?? [])
        .filter((p) => p.actions.includes("indexStats"))
        .map((p) => p.resource.db)
        .filter((db): db is string => typeof db === "string"),
    );
    const missing: string[] = [];
    for (const db of SCRATCH_DBS) {
      for (const role of ["readWrite", "dbAdmin"]) if (!held.has(`${role}@${db}`)) missing.push(`${role} on ${db}`);
      if (!indexStats.has(db)) missing.push(`indexStats on ${db}`);
    }
    expect(
      missing,
      `The scratch identity is missing grants — run \`npm run fixture:up\` to apply the ` +
        `current SCRATCH_DBS, and add the privilege to ensureScratchUser in ` +
        `test/fixtures/instance.ts if it is a new one:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  }, 15_000);
});
