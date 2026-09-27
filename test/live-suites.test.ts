/**
 * A live suite may report green for exactly one reason: the server is not running.
 *
 * Every suite that talks to mongod wraps its setup so that an unreachable instance
 * skips instead of failing — `npm test` has to stay green for a contributor who has
 * not run `npm run fixture:up`. The danger is what else that wrapper swallows. A
 * wrong password, a missing grant, a refused command: each one lands in the same
 * `catch`, the suite runs its compile-only half, and the run reports GREEN while the
 * half that catches what a `toEqual` cannot has stopped running. Four suites sat in
 * exactly that state — `readWrite` alone cannot drop a database, and four of them
 * drop theirs first.
 *
 * So the connection is made in ONE place, `test/fixtures/live.ts`, which skips on
 * "could not reach a server at all" and throws on everything else. This file keeps
 * every suite on that path: a hand-rolled client, or a `catch` that nulls one, is
 * what re-opens the hole.
 *
 * See test/CLAUDE.md § "Suites that connect to a server must report whether they connected".
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = join(ROOT, "test");

/** This file reads the rule; `live.ts` IS the rule; `instance.ts`/`client.ts` build the server. */
const NOT_SUITES = new Set(["live-suites.test.ts"]);

const suites = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".test.ts") && !NOT_SUITES.has(f))
  .map((f) => ({ name: f, text: readFileSync(join(TEST_DIR, f), "utf8") }));

/** A suite that reaches the server — as opposed to one that imports `mongodb` for its BSON classes. */
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

  it("none of them turns a failure into a skip by nulling its client", () => {
    // `catch { client = null }` and friends: the shape that hides a refusal as a skip.
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

// A suite that connects through a fixture module inherits that module's idea of
// "no server". So each fixture module a suite reaches obeys the same rules, plus
// one more: a `catch` may answer "not running" (false or null) only after it asks
// `isUnreachable` from live.ts. `live.ts` holds the rule itself, so it is exempt.
const FIXTURE_DIR = join(TEST_DIR, "fixtures");
const fixtureText = (f: string) => readFileSync(join(FIXTURE_DIR, f), "utf8");
const importsOf = (text: string, prefix: string) =>
  [...text.matchAll(new RegExp(`from\\s+["']${prefix}([\\w-]+\\.ts)["']`, "g"))].map((m) => m[1]);
const reached = new Set(suites.flatMap((s) => importsOf(s.text, "\\./fixtures/")));
for (const f of [...reached]) for (const g of importsOf(fixtureText(f), "\\./")) reached.add(g);
const fixtureModules = [...reached]
  .filter((f) => f !== "live.ts" && readdirSync(FIXTURE_DIR).includes(f))
  .map((f) => ({ name: `fixtures/${f}`, text: fixtureText(f) }));

/** The body of each `catch { … }`, with one level of nested braces. */
const catchBodies = (text: string) =>
  [...text.matchAll(/catch\s*(?:\([^)]*\))?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((m) => m[1]);

describe("every fixture module a suite reaches keeps the skip rule", () => {
  it("finds a fixture module that builds a client — an empty list would pass every rule below", () => {
    expect(fixtureModules.filter((m) => /new MongoClient\(/.test(m.text)).length).toBeGreaterThan(0);
  });

  it("none of them turns a failure into a skip by nulling its client", () => {
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
