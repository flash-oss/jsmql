import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import yaml from "js-yaml";
import { OPERATORS, OPERATOR_CATEGORIES } from "../src/operators.ts";
import { streamMethodNames } from "../src/stream-methods.ts";
import { STAGES } from "../src/stages.ts";
import { generateGlobalsSource } from "../scripts/generate-globals.mjs";

// ---------------------------------------------------------------------------
// Drift-protection test: keep OPERATORS in sync with mongodb/mql-specifications.
//
// Reads YAML definitions from vendor/mql-specifications and asserts the
// registry covers every expression + accumulator operator the official spec
// defines. Failure messages name the specific drift so a contributor can act
// without spelunking.
//
// The spec is vendored on `npm install` via vendor/fetch-mql-specs.mjs at a
// pinned commit. The vendor directory is gitignored — re-fetch with
// `node vendor/fetch-mql-specs.mjs` if missing.
// ---------------------------------------------------------------------------

const SPEC_ROOT = resolve(import.meta.dirname, "..", "vendor", "mql-specifications", "definitions");

// Folders whose operators may appear inside an jsmql expression. The spec also
// has pipeline/, query/, search/, stage/, types/, update/ — those are tracked
// via separate spec stubs (see docs/specs/) and not yet implemented in the
// expression-level operator registry.
const IN_SCOPE_FOLDERS = ["expression", "accumulator"];

// Sub-constructs that appear in the spec as standalone files but are not
// top-level expression operators (e.g. $case is part of $switch.branches[]).
const SUB_CONSTRUCTS = new Set(["$case"]);

// Operators present in MongoDB's documentation (and in jsmql's registry) but
// not yet in the official YAML spec. Acceptable; document each addition here
// so the gap is visible.
const REGISTRY_ONLY = new Set([
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
  // Query predicate exposed as an expression for jsmql ergonomics. The spec
  // tracks it in definitions/query/sampleRate.yaml; once jsmql implements
  // query-predicate support (see docs/specs/query-predicates.md), this entry
  // should move out of OPERATORS and into the query layer.
  "$sampleRate",
]);

type SpecArg = { name: string; optional?: boolean; variadic?: string };
type SpecOp = { name: string; description?: string; encode?: string; arguments?: SpecArg[] };

function loadSpec(): Map<string, SpecOp> {
  const out = new Map<string, SpecOp>();
  for (const folder of IN_SCOPE_FOLDERS) {
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

const spec = loadSpec();

describe("operator registry coverage vs mongodb/mql-specifications", () => {
  it("loads at least 150 operators from the spec", () => {
    expect(spec.size).toBeGreaterThan(150);
  });

  it("registry covers every spec operator (no missing operators)", () => {
    const missing: string[] = [];
    for (const name of spec.keys()) {
      if (SUB_CONSTRUCTS.has(name)) continue;
      if (!(name in OPERATORS)) missing.push(name);
    }
    if (missing.length > 0) {
      throw new Error(
        `Operators present in mongodb/mql-specifications but missing from src/operators.ts:\n` +
          missing.map((n) => `  - ${n}`).join("\n") +
          `\n\nAdd each to OPERATORS, or to SUB_CONSTRUCTS in this test if it is a sub-construct of another operator (like $case for $switch).`,
      );
    }
  });

  it("registry has no operators outside the spec (except documented exceptions)", () => {
    const extras: string[] = [];
    for (const name of Object.keys(OPERATORS)) {
      if (spec.has(name)) continue;
      if (REGISTRY_ONLY.has(name)) continue;
      extras.push(name);
    }
    if (extras.length > 0) {
      throw new Error(
        `Operators in src/operators.ts that the official spec does not define:\n` +
          extras.map((n) => `  - ${n}`).join("\n") +
          `\n\nIf the operator is real but post-dates the pinned spec commit, add it to REGISTRY_ONLY in this test with a comment linking to its MongoDB docs.`,
      );
    }
  });

  it("every registry entry has a non-empty description", () => {
    const blanks: string[] = [];
    for (const [name, def] of Object.entries(OPERATORS)) {
      if (!def.description || def.description.trim() === "") blanks.push(name);
    }
    expect(blanks).toEqual([]);
  });

  it("every registry entry uses a known category", () => {
    const known = new Set<string>(OPERATOR_CATEGORIES);
    const bad: Array<[string, string]> = [];
    for (const [name, def] of Object.entries(OPERATORS)) {
      if (!known.has(def.category)) bad.push([name, def.category]);
    }
    expect(bad).toEqual([]);
  });

  it("accumulatorOnly is a boolean when present", () => {
    // Codegen gates accumulator-only operators on this flag (the single source
    // of truth, replacing the former hand-maintained ACCUMULATOR_ONLY_OPERATORS
    // set). A stray truthy non-boolean would silently widen the gate.
    const bad: Array<[string, unknown]> = [];
    for (const [name, def] of Object.entries(OPERATORS)) {
      if (def.accumulatorOnly !== undefined && typeof def.accumulatorOnly !== "boolean") {
        bad.push([name, def.accumulatorOnly]);
      }
    }
    expect(bad).toEqual([]);
  });

  it("src/globals.ts is byte-equal to the generator output", () => {
    // The committed src/globals.ts is the artifact that ships in the npm package.
    // The generator runs as part of `prebuild` and `pretest`, but a contributor
    // who edits OPERATORS/STAGES without re-running the generator (or who edits
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
    // `$$$` indexes to the foreign ref — that's what gives a foreign chain
    // completion. `$$$$`'s second level is a database, so it keeps a plain tail.
    expect(src).toContain("const $$$: { [collection: string]: JsmqlForeignRef };");
    expect(src).toContain("const $$$$: {");
    // Diagnostic methods derived from STAGES[…].diagnostic, with annotated args.
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
      for (const [stage, def] of Object.entries(STAGES)) {
        if (def.diagnostic === undefined) expect(block).toContain(`${stage}(body: any): ${ref};`);
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

  it("object-shape registry entries use keys that exist in the spec", () => {
    // jsmql's positional key order may legitimately differ from the spec's
    // (changing it would be a breaking API change for callers using the
    // positional form). What we DO require is set membership: every key the
    // registry exposes for positional invocation must be a name the spec
    // recognises for that operator.
    const violations: string[] = [];
    for (const [name, def] of Object.entries(OPERATORS)) {
      if (def.shape.kind !== "object") continue;
      const specOp = spec.get(name);
      if (!specOp || !specOp.arguments) continue; // covered by REGISTRY_ONLY check
      const specNames = new Set(specOp.arguments.map((a) => a.name));
      for (const key of def.shape.keys) {
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
