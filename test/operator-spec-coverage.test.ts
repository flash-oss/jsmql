import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import yaml from "js-yaml";
import {
  categoryOf,
  describes,
  diagnosticOf,
  everyMongoName,
  everyOperatorName,
  everyStageName,
  isKnownName,
  operandShapeOf,
  positionalKeysOf,
  streamMethodNames,
} from "../src/compiler/rows.ts";
import { OPERATOR_CATEGORIES } from "../src/registry/vocabulary.ts";
import { generateGlobalsSource } from "../scripts/generate-globals.mjs";

// ---------------------------------------------------------------------------
// Drift-protection test: keep the registry in sync with mongodb/mql-specifications.
//
// Reads YAML definitions from vendor/mql-specifications and asserts the registry
// states a row for every operator the official spec defines. Each failure message
// names the specific drift, so a contributor can act without a manual search.
//
// The spec is vendored on `npm install` through vendor/fetch-mql-specs.mjs at a
// pinned commit. The vendor directory is gitignored — re-fetch with
// `node vendor/fetch-mql-specs.mjs` if missing.
// ---------------------------------------------------------------------------

const SPEC_ROOT = resolve(import.meta.dirname, "..", "vendor", "mql-specifications", "definitions");

// The folders that hold the operators the registry states rows for. The spec's
// remaining folders (stage/, types/) describe the pipeline stages and the BSON
// type names, which the registry states as their own kinds of row.
const IN_SCOPE_FOLDERS = ["expression", "accumulator", "query"];

// Operators present in MongoDB's documentation (and in jsmql's registry) but
// not in the official YAML spec at the pinned commit. Acceptable; document each
// addition here so the gap is visible.
const REGISTRY_ONLY = new Set([
  // Update-document operators. The pinned spec commit has no update/ folder, so
  // every operator an `updateOne` document takes lives here. See
  // https://www.mongodb.com/docs/manual/reference/operator/update/
  "$bit",
  "$currentDate",
  "$each",
  "$inc",
  "$mul",
  "$pop",
  "$position",
  "$pull",
  "$pullAll",
  "$rename",
  "$setOnInsert",
  // Queryable Encryption — not in spec as of pinned commit; shapes inferred from
  // https://www.mongodb.com/docs/manual/reference/operator/aggregation/encStrContains/ etc.
  "$encStrContains",
  "$encStrEndsWith",
  "$encStrNormalizedEq",
  "$encStrStartsWith",
  // BSON type converters added after pinned spec commit.
  "$toUUID",
  "$toObject",
  "$toArray",
]);

type SpecArg = { name: string; optional?: boolean; variadic?: string };
type SpecOp = { name: string; description?: string; encode?: string; arguments?: SpecArg[] };

function loadSpec(folders: readonly string[]): Map<string, SpecOp> {
  const out = new Map<string, SpecOp>();
  for (const folder of folders) {
    const dir = resolve(SPEC_ROOT, folder);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".yaml")) continue;
      let txt = readFileSync(resolve(dir, file), "utf8");
      // Strip the tests: block; it contains custom BSON tags (!bson_int64,
      // !bson_utcdatetime, etc.) that js-yaml's default schema rejects. We
      // only need the metadata above tests: anyway.
      const i = txt.indexOf("\ntests:");
      if (i >= 0) txt = txt.slice(0, i);
      const doc = yaml.load(txt) as SpecOp;
      if (doc?.name) out.set(doc.name, doc);
    }
  }
  return out;
}

const spec = loadSpec(IN_SCOPE_FOLDERS);
const stageSpec = loadSpec(["stage"]);

// The operator rows: every MongoDB name the registry states that is not a stage.
// A row exists for each — including the ones the registry confines to another
// operator's body (`$case`, `$box`) and the ones it refuses outright (`$where`),
// because the question this file asks is coverage, not callability.
const stageNames = new Set(everyStageName());
const operatorRows = everyMongoName().filter((name) => !stageNames.has(name));

describe("operator registry coverage vs mongodb/mql-specifications", () => {
  it("loads at least 150 operators from the spec", () => {
    expect(spec.size).toBeGreaterThan(150);
  });

  it("registry covers every spec operator (no missing operators)", () => {
    const missing = [...spec.keys()].filter((name) => !isKnownName(name));
    if (missing.length > 0) {
      throw new Error(
        `Operators present in mongodb/mql-specifications but with no row in src/registry/names.ts:\n` +
          missing.map((n) => `  - ${n}`).join("\n") +
          `\n\nAdd a row for each. A name jsmql does not support still needs one: state an empty 'where' and a refusal that names the alternative.`,
      );
    }
  });

  it("registry has no operators outside the spec (except documented exceptions)", () => {
    const extras = operatorRows.filter((name) => !spec.has(name) && !REGISTRY_ONLY.has(name));
    if (extras.length > 0) {
      throw new Error(
        `Operator rows in src/registry/names.ts that the official spec does not define:\n` +
          extras.map((n) => `  - ${n}`).join("\n") +
          `\n\nIf the operator is real but post-dates the pinned spec commit, add it to REGISTRY_ONLY in this test with a comment linking to its MongoDB docs.`,
      );
    }
  });

  it("every callable operator has a non-empty description", () => {
    const blanks = everyOperatorName().filter((name) => describes(name, "operator").trim() === "");
    expect(blanks).toEqual([]);
  });

  it("every callable operator uses a known category", () => {
    const known = new Set<string>(OPERATOR_CATEGORIES);
    const bad = everyOperatorName()
      .filter((name) => !known.has(categoryOf(name) ?? ""))
      .map((name) => [name, categoryOf(name)]);
    expect(bad).toEqual([]);
  });

  it("src/globals.ts is byte-equal to the generator output", () => {
    // The committed src/globals.ts is the artifact that ships in the npm package.
    // The generator runs as part of `prebuild` and `pretest`, but a contributor
    // who edits a registry row without re-running the generator (or who edits
    // src/globals.ts by hand) would otherwise ship drifted types. Catch that here.
    //
    // The generator's CLI writes the file through oxfmt before exit, so we
    // mirror that by piping the generated string through oxfmt before
    // comparing — otherwise the test would always fail on whitespace.
    const raw = generateGlobalsSource();
    const root = resolve(import.meta.dirname, "..");
    const oxfmt = resolve(root, "node_modules/.bin/oxfmt");
    const formatted = execSync(`${JSON.stringify(oxfmt)} --stdin-filepath=globals.ts`, {
      input: raw,
      encoding: "utf8",
    });
    const actual = readFileSync(resolve(root, "src/globals.ts"), "utf8");
    if (actual !== formatted) {
      throw new Error(
        "src/globals.ts is out of date relative to its generator. Run `npm run generate:globals` to refresh.",
      );
    }
  });

  it("declares the $$ / $$$ / $$$$ context refs with typed diagnostic methods", () => {
    // The context-ref ambient globals let arrow-form `$$` / `$$$` / `$$$$` code
    // type-check, and surface the collection-/cluster-scoped diagnostic stages
    // with completion. A future generator change must not silently drop them.
    const src = generateGlobalsSource();
    // Two named interfaces, one extending the other. The `extends` is what lets a
    // single `$$$` index type serve both roles the database ref has — read head
    // (`$$$.coll.find(…)`) and `$out` write target (`$$$.coll = $$`) — because
    // TypeScript resolves a target's named members against the source's DECLARED
    // members and never through its index signature. Drop the `extends` and
    // `$$$.coll = $$` stops type-checking.
    expect(src).toContain("interface JsmqlForeignRef {");
    expect(src).toContain("interface JsmqlCollectionRef extends JsmqlForeignRef {");
    // `$$` must be `var`, not `const`: it is reassigned wholesale by the
    // `$$ = …` replace-stream / `$facet` sugar, and `const $$` makes TS reject
    // that valid jsmql (TS2588). `$$$` / `$$$$` stay `const` — they only take
    // property writes (`$$$.coll = …` → `$out`), which `const` permits.
    expect(src).toContain("var $$: JsmqlCollectionRef;");
    expect(src).not.toContain("const $$: JsmqlCollectionRef;");
    // `$$$` indexes to the foreign ref — that is what gives a foreign chain
    // completion. `$$$$`'s second level is a database, so it keeps a plain tail.
    expect(src).toContain("const $$$: { [collection: string]: JsmqlForeignRef };");
    expect(src).toContain("const $$$$: {");
    // Diagnostic methods derived from each stage row's `diagnostic` fact, with annotated args.
    expect(src).toContain("collStats(options?: {");
    expect(src).toContain("indexStats(): any;");
    expect(src).toContain("currentOp(options?: {");
    expect(src).toContain("shardedDataDistribution(): any;");
    // Permissive tail keeps the non-diagnostic ref sugar type-checking.
    expect(src).toContain("[key: string]: any;");
  });

  it("declares the stream vocabulary on both refs, each chaining back to itself", () => {
    // Every registered stream method (plus the non-registry `.filter` / `.reject`,
    // and `.push` on the collection ref alone) surfaces as a typed member, so a
    // chain gets IDE completion instead of falling through the `[key: string]`
    // tail. Each ref re-declares them with ITSELF as the return type: a chain
    // keeps the identity of its root, which is the rule jsmql enforces for
    // `.find` (legal anywhere on a foreign chain, nowhere on a `$$` chain).
    const src = generateGlobalsSource();
    const foreign = src.slice(src.indexOf("interface JsmqlForeignRef {"), src.indexOf("interface JsmqlCollectionRef"));
    const collection = src.slice(src.indexOf("interface JsmqlCollectionRef"), src.indexOf("var $$:"));
    for (const [block, ref] of [
      [foreign, "JsmqlForeignRef"],
      [collection, "JsmqlCollectionRef"],
    ] as const) {
      expect(block).toContain(`filter(predicate: ((doc: any) => any) | Record<string, any>): ${ref};`);
      expect(block).toContain(`map(transform: ((doc: any) => any) | string): ${ref};`);
      expect(block).toContain(`take(n: number): ${ref};`);
      // Chained stage calls — every non-diagnostic stage, body typed `any` so a
      // stage that also accepts a bare string (`.$unwind("$items")`) still fits.
      expect(block).toContain(`$match(body: any): ${ref};`);
      expect(block).toContain(`$unwind(body: any): ${ref};`);
      // Registry is the source of truth: every STREAM_METHODS name must appear.
      for (const name of streamMethodNames()) expect(block).toContain(`${name}(`);
      // …and every stage EXCEPT the diagnostic ones, which keep their own
      // non-`$` spelling (`$$.indexStats()`) and are rejected as `.$indexStats()`.
      for (const stage of everyStageName()) {
        if (diagnosticOf(stage) === undefined) expect(block).toContain(`${stage}(body: any): ${ref};`);
        else expect(block).not.toContain(`${stage}(body: any)`);
      }
    }
    // `.push` is the statement-level `$unionWith` — current stream only.
    expect(collection).toContain("push(...docs: any[]): JsmqlCollectionRef;");
    expect(foreign).not.toContain("push(...docs: any[])");
    // A stream is an array where it genuinely is one: the count, the value
    // terminals, and enough iterability for `$$.push(...$$$.other)` to spread.
    expect(foreign).toContain("readonly length: number;");
    expect(foreign).toContain("size(): number;");
    expect(foreign).toContain("head(): any;");
    expect(foreign).toContain("[Symbol.iterator](): Iterator<any>;");
  });

  it("registry covers every spec STAGE, and states no stage the spec does not define", () => {
    const stages = new Set(everyStageName());
    const missing = [...stageSpec.keys()].filter((name) => !stages.has(name));
    const extras = [...stages].filter((name) => !stageSpec.has(name));
    if (missing.length > 0 || extras.length > 0) {
      throw new Error(
        `The stage rows and vendor/mql-specifications/definitions/stage/ disagree:\n` +
          missing.map((n) => `  - ${n}: in the spec, no stage row states it`).join("\n") +
          extras.map((n) => `  - ${n}: a stage row states it, the spec does not define it`).join("\n") +
          `\n\nAdd the missing row (or list a real post-spec stage here with a comment linking to its MongoDB docs).`,
      );
    }
  });

  it("object-shape registry entries use keys that exist in the spec", () => {
    // jsmql's positional key order may legitimately differ from the spec's
    // (changing it would be a breaking API change for callers using the
    // positional form). What we DO require is set membership: every key the
    // registry exposes for positional invocation must be a name the spec
    // recognises for that operator.
    const violations: string[] = [];
    for (const name of everyOperatorName()) {
      if (operandShapeOf(name) !== "object") continue;
      const specOp = spec.get(name);
      if (!specOp || !specOp.arguments) continue; // covered by REGISTRY_ONLY check
      const specNames = new Set(specOp.arguments.map((a) => a.name));
      for (const key of positionalKeysOf(name)) {
        if (!specNames.has(key)) {
          violations.push(
            `${name}: registry key "${key}" not in spec arguments [${specOp.arguments.map((a) => a.name).join(", ")}]`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
