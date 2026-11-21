import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = join(ROOT, "test");

const NOT_SUITES = new Set(["live-suites.test.ts"]);

const suites = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".test.ts") && !NOT_SUITES.has(f))
  .map((f) => ({ name: f, text: readFileSync(join(TEST_DIR, f), "utf8") }));

const live = suites.filter((s) => /liveClient|liveUp|liveClientNow|connectReadOnly|new MongoClient\(/.test(s.text));

describe("every live suite connects through test/fixtures/live.ts", () => {
  it("finds live suites at all — an empty list would pass every rule below", () => {
    expect(live.length).toBeGreaterThan(10);
  });

  it("none of them builds its own MongoClient", () => {
    const offenders = live
      .filter((s) => /new MongoClient\(/.test(s.text))
      .map((s) => `${s.name}: builds its own client instead of calling liveClient()/liveClientNow()`);
    expect(
      offenders,
      `A hand-rolled client decides for itself what counts as "no server". Use the helpers in ` +
        `test/fixtures/live.ts:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("none of them turns a failure into a skip with a null client", () => {
    const nulling = /catch\s*(?:\([^)]*\))?\s*\{[^}]*\b(?:client|coll|db|mainColl)\s*=\s*null/;
    const offenders = live
      .filter((s) => nulling.test(s.text))
      .map((s) => `${s.name}: a catch block nulls its client/collection`);
    expect(
      offenders,
      `That catch swallows a wrong password and a missing grant along with an unreachable ` +
        `server, and the suite then reports green having run nothing. Let liveClient() decide:\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("none of them keeps its own reachability probe", () => {
    const offenders = live
      .filter((s) => /async function (reachable|tryConnect)\b/.test(s.text))
      .map((s) => `${s.name}: has its own reachability probe`);
    expect(
      offenders,
      `One probe, in test/fixtures/live.ts, so "is it down?" is answered the same way ` +
        `everywhere:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});

const FIXTURE_DIR = join(TEST_DIR, "fixtures");
const fixtureText = (f: string) => readFileSync(join(FIXTURE_DIR, f), "utf8");
const importsOf = (text: string, prefix: string) =>
  [...text.matchAll(new RegExp(`from\\s+["']${prefix}([\\w-]+\\.ts)["']`, "g"))].map((m) => m[1]);
const reached = new Set(suites.flatMap((s) => importsOf(s.text, "\\./fixtures/")));
for (const f of [...reached]) for (const g of importsOf(fixtureText(f), "\\./")) reached.add(g);
const fixtureModules = [...reached]
  .filter((f) => f !== "live.ts" && readdirSync(FIXTURE_DIR).includes(f))
  .map((f) => ({ name: `fixtures/${f}`, text: fixtureText(f) }));

const catchBodies = (text: string) =>
  [...text.matchAll(/catch\s*(?:\([^)]*\))?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((m) => m[1]);

describe("every fixture module a suite reaches keeps the skip rule", () => {
  it("finds a fixture module that builds a client — an empty list would pass every rule below", () => {
    expect(fixtureModules.filter((m) => /new MongoClient\(/.test(m.text)).length).toBeGreaterThan(0);
  });

  it("none of them turns a failure into a skip with a null client", () => {
    const nulling = /catch\s*(?:\([^)]*\))?\s*\{[^}]*\b(?:client|coll|db|mainColl)\s*=\s*null/;
    expect(fixtureModules.filter((m) => nulling.test(m.text)).map((m) => m.name)).toEqual([]);
  });

  it("none of them keeps its own reachability probe", () => {
    const probe = /async function (reachable|tryConnect)\b/;
    expect(fixtureModules.filter((m) => probe.test(m.text)).map((m) => m.name)).toEqual([]);
  });

  it("no catch answers 'not running' unless isUnreachable() said so", () => {
    const offenders = fixtureModules
      .filter((m) =>
        catchBodies(m.text).some((body) => /\breturn\s+(?:false|null)\b/.test(body) && !/\bisUnreachable\(/.test(body)),
      )
      .map((m) => `${m.name}: a catch returns a skip answer for every failure`);
    expect(
      offenders,
      `That catch reads a wrong password, a missing user and a stale dataset as "no server", ` +
        `and the suite then skips green. Return false only when isUnreachable(e) is true; throw otherwise:\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
