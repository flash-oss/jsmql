/**
 * A value from another realm is the value it is.
 *
 * `instanceof Date` is false for a real Date made in another realm — a `vm` context, a
 * test runner's sandbox, a worker — because each realm has its own `Date`, `RegExp`,
 * `Uint8Array` and `Object.prototype`. A parameter value can arrive from any of them,
 * and a value that failed the test would take a road it should not: a Date compared on
 * the `$expr` road loses the index, a `$`-keyed object skips the `$literal` gate. The
 * compiler recognises a value by what it IS, never by which realm made it, so the
 * document it emits is the same one. See docs/specs/bson-types.md § Recognition across
 * realms.
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { jsmql } from "../src/index.ts";

/** The value `src` makes, made in another realm. */
const far = <T>(src: string): T => vm.runInNewContext(src) as T;

/**
 * A document with every Uint8Array written as its bytes. `toEqual` compares a Date or a
 * RegExp from another realm by value, but holds two typed arrays equal only when they
 * share a constructor — which two realms never do. The bytes are what the driver sends.
 */
const bytesAsArrays = (v: unknown): unknown => {
  if (Object.prototype.toString.call(v) === "[object Uint8Array]") return { bytes: Array.from(v as Uint8Array) };
  if (Array.isArray(v)) return v.map(bytesAsArrays);
  if (v !== null && typeof v === "object" && Object.prototype.toString.call(v) === "[object Object]") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bytesAsArrays(x)]));
  }
  return v;
};

/** What a build did — its document, or the message it refused with — so two roads compare whole. */
const outcome = (build: () => unknown): { value: unknown } | { error: string } => {
  try {
    return { value: bytesAsArrays(build()) };
  } catch (e) {
    return { error: (e as Error).message };
  }
};

describe("a value from another realm is the value it is", () => {
  it("a Date parameter keeps the indexable query — the case that surfaced this", () => {
    const build = jsmql.compile(({ lastSyncAt }, { $, $$ }) => {
      $$.filter((pc) => $.updatedAt > lastSyncAt);
      $$.pick(["_id", "updatedAt"]);
    });
    expect(build({ lastSyncAt: far<Date>('new Date("2026-01-01T00:00:00Z")') })).toEqual([
      { $match: { updatedAt: { $gt: new Date("2026-01-01T00:00:00Z") } } },
      { $project: { _id: 1, updatedAt: 1 } },
    ]);
    expect(jsmql`$.updatedAt > ${far<Date>('new Date("2026-01-01T00:00:00Z")')}`).toEqual({
      updatedAt: { $gt: new Date("2026-01-01T00:00:00Z") },
    });
  });

  it("a `$`-keyed object from another realm is still a value, never an operator", () => {
    const payload = far<object>('({ $gt: 0, $where: "this.secret" })');
    expect(jsmql.expr.compile(({ p }) => p)({ p: payload })).toEqual({ $literal: { $gt: 0, $where: "this.secret" } });
    expect(jsmql.compile(({ p }, { $ }) => $.a === p)({ p: payload })).toEqual({
      a: { $eq: { $gt: 0, $where: "this.secret" } },
    });
  });

  it("the fold reads a value from another realm as its kind", () => {
    expect(jsmql.expr.compile(({ d }) => d.getFullYear())({ d: far('new Date("2026-01-01T00:00:00Z")') })).toBe(2026);
    expect(jsmql.expr.compile(({ p }) => Object.keys(p))({ p: far("({ a: 1, b: 2 })") })).toEqual(["a", "b"]);
  });

  /** Each pair: the value made in this realm, and the source that makes it in another. */
  const PAIRS: readonly [label: string, here: unknown, there: string][] = [
    ["a Date", new Date("2026-01-01T00:00:00Z"), 'new Date("2026-01-01T00:00:00Z")'],
    ["a RegExp", /^a/i, "/^a/i"],
    ["a Uint8Array", new Uint8Array([1, 2]), "new Uint8Array([1, 2])"],
    ["a plain object", { x: 1, y: [2, 3] }, "({ x: 1, y: [2, 3] })"],
    [
      "a null-prototype object",
      Object.assign(Object.create(null), { x: 1 }),
      "Object.assign(Object.create(null), { x: 1 })",
    ],
    ["an object holding a Date", { since: new Date(0) }, "({ since: new Date(0) })"],
    ["an object holding a BigInt", { n: 5n }, "({ n: 5n })"],
    ["an array of Dates", [new Date(0), new Date(1)], "[new Date(0), new Date(1)]"],
  ];
  /** The roads a parameter value travels. */
  const ROADS: readonly [label: string, build: (p: unknown) => unknown][] = [
    ["an equality filter", (p) => jsmql.compile(({ p }, { $ }) => $.a === p)({ p })],
    ["an ordered filter", (p) => jsmql.compile(({ p }, { $ }) => $.a > p)({ p })],
    [
      "a `$match` in a pipeline",
      (p) =>
        jsmql.compile(({ p }, { $, $$ }) => {
          $$.filter((d) => $.a === p);
          $$.pick(["_id"]);
        })({ p }),
    ],
    ["a bare value", (p) => jsmql.expr.compile(({ p }) => p)({ p })],
    [
      "a field assignment",
      (p) =>
        jsmql.pipeline.compile(({ p }, { $ }) => {
          $.n = p;
        })({ p }),
    ],
    ["an interpolated slot", (p) => jsmql`$.a === ${p}`],
    ["the printed document", (p) => jsmql.stringify(jsmql.expr.compile(({ p }) => p)({ p }))],
  ];
  for (const [what, here, there] of PAIRS) {
    for (const [road, build] of ROADS) {
      it(`${what} on ${road}`, () => {
        expect(outcome(() => build(far(there)))).toEqual(outcome(() => build(here)));
      });
    }
  }
});

/**
 * The rule is a test, because the next `instanceof Date` reads as the obvious thing to
 * write. The recognisers live in src/registry/vocabulary.ts, and src/stringify.ts holds
 * twins of the slot readers so it stays a leaf — neither tests a class.
 */
describe("the source recognises a value by its kind, never by its realm", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const HOME = "src/registry/vocabulary.ts";
  const banned = /instanceof (Date|RegExp|Uint8Array)\b|[!=]== Object\.prototype(?![.\w])/;
  const files = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) files(full, out);
      else if (name.endsWith(".ts")) out.push(full);
    }
    return out;
  };
  it("no module in src/ tests a value against this realm's classes", () => {
    const offenders: string[] = [];
    for (const file of files(join(ROOT, "src"))) {
      const rel = relative(ROOT, file);
      if (rel === HOME) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (banned.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `These lines test a value against this realm's classes, which a value from another realm fails. ` +
        `Use isDate / isRegExp / isBytes / isPlainObject from src/bson.ts (a registry row: ./vocabulary.ts):\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
