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

const SPEC_ROOT = resolve(import.meta.dirname, "..", "vendor", "mql-specifications", "definitions");

const IN_SCOPE_FOLDERS = ["expression", "accumulator", "query"];

const REGISTRY_ONLY = new Set([
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
  "$encStrContains",
  "$encStrEndsWith",
  "$encStrNormalizedEq",
  "$encStrStartsWith",
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

const stageNames = new Set(everyStageName());
const operatorRows = everyMongoName().filter((name) => !stageNames.has(name));

describe("operator registry coverage against mongodb/mql-specifications", () => {
  it("loads at least 150 operators from the spec", () => {
    expect(spec.size).toBeGreaterThan(150);
  });

  it("registry covers every spec operator (no missing operators)", () => {
    const missing = [...spec.keys()].filter((name) => !isKnownName(name));
    if (missing.length > 0) {
      throw new Error(
        `Operators present in mongodb/mql-specifications but with no row in src/registry/names.ts:\n` +
          missing.map((n) => `  - ${n}`).join("\n") +
          `\n\nAdd a row for each. A name jsmql does not support still needs one: state an empty 'where' and a refusal.`,
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
    const src = generateGlobalsSource();
    expect(src).toContain("interface JsmqlForeignRef {");
    expect(src).toContain("interface JsmqlStreamRef extends JsmqlForeignRef {");
    expect(src).toContain("var $$: JsmqlStreamRef;");
    expect(src).not.toContain("const $$: JsmqlStreamRef;");
    expect(src).toContain("const $$$: { [collection: string]: JsmqlForeignRef };");
    expect(src).toContain("const $$$$: {");
    expect(src).toContain("collStats(options?: {");
    expect(src).toContain("indexStats(): any;");
    expect(src).toContain("currentOp(options?: {");
    expect(src).toContain("shardedDataDistribution(): any;");
    expect(src).toContain("[key: string]: any;");
  });

  it("declares the stream vocabulary on both refs, each chaining back to itself", () => {
    const src = generateGlobalsSource();
    const foreign = src.slice(src.indexOf("interface JsmqlForeignRef {"), src.indexOf("interface JsmqlStreamRef"));
    const collection = src.slice(src.indexOf("interface JsmqlStreamRef"), src.indexOf("var $$:"));
    for (const [block, ref] of [
      [foreign, "JsmqlForeignRef"],
      [collection, "JsmqlStreamRef"],
    ] as const) {
      expect(block).toContain(`filter(predicate: ((doc: any) => any) | Record<string, any>): ${ref};`);
      expect(block).toContain(`map(transform: ((doc: any) => any) | string): ${ref};`);
      expect(block).toContain(`take(n: number): ${ref};`);
      expect(block).toContain(`$match(body: any): ${ref};`);
      expect(block).toContain(`$unwind(body: any): ${ref};`);
      for (const name of streamMethodNames()) expect(block).toContain(`${name}(`);
      for (const stage of everyStageName()) {
        if (diagnosticOf(stage) === undefined) expect(block).toContain(`${stage}(body: any): ${ref};`);
        else expect(block).not.toContain(`${stage}(body: any)`);
      }
    }
    expect(collection).toContain("push(...docs: any[]): JsmqlStreamRef;");
    expect(foreign).not.toContain("push(...docs: any[])");
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
    const violations: string[] = [];
    for (const name of everyOperatorName()) {
      if (operandShapeOf(name) !== "object") continue;
      const specOp = spec.get(name);
      if (!specOp || !specOp.arguments) continue;
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
