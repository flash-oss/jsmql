import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { jsmql } from "../src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = readFileSync(resolve(ROOT, "index.html"), "utf8");

const ENTRIES = {
  auto: jsmql,
  filter: jsmql.filter,
  update: jsmql.update,
  expression: jsmql.expr,
  pipeline: jsmql.pipeline,
} as const;

type Mode = keyof typeof ENTRIES;

const CHIP_IS_ARRAY: Record<string, boolean> = { filter: false, expression: false, pipeline: true, update: false };

function decodeEntities(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

interface Example {
  mode: Mode;
  chip: string;
  source: string;
}

function readExamples(): Example[] {
  const out: Example[] = [];
  const article = /<article class="example[^"]*" data-example data-mode="([a-z]+)">([\s\S]*?)<\/article>/g;
  for (const [, mode, body] of INDEX.matchAll(article)) {
    const chip = /<span class="chip ([a-z]+)">/.exec(body);
    const source = /<pre\s+class="src"\s*><code>([\s\S]*?)<\/code><\/pre>/.exec(body);
    if (!chip || !source) throw new Error(`index.html example (mode ${mode}) lost its chip or source`);
    out.push({ mode: mode as Mode, chip: chip[1], source: decodeEntities(source[1]).trim() });
  }
  return out;
}

function countMarkupExamples(): number {
  return (INDEX.match(/<article[^>]*\bdata-example\b/g) ?? []).length;
}

function readVersus(): Example[] {
  const out: Example[] = [];
  const row = /<div class="vs" data-vs data-mode="([a-z]+)">([\s\S]*?)<a class="play"/g;
  for (const [, mode, body] of INDEX.matchAll(row)) {
    const source = /<pre\s+class="src"\s*><code>([\s\S]*?)<\/code><\/pre>/.exec(body);
    if (!source) throw new Error(`index.html SQL-and-JSMQL row (mode ${mode}) lost its JSMQL cell`);
    out.push({ mode: mode as Mode, chip: mode, source: decodeEntities(source[1]).trim() });
  }
  return out;
}

function countMarkupVersus(): number {
  return (INDEX.match(/<div[^>]*\bdata-vs\b/g) ?? []).length;
}

const EXAMPLES = readExamples();
const VERSUS = readVersus();

describe("site: landing-page examples", () => {
  it("extracts every example the markup declares", () => {
    expect(EXAMPLES.length).toBe(countMarkupExamples());
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(6);
  });

  it("extracts every SQL-and-JSMQL row the markup declares", () => {
    expect(VERSUS.length).toBe(countMarkupVersus());
    expect(VERSUS.length).toBeGreaterThanOrEqual(6);
  });

  it.each(VERSUS.map((e, i) => [i, e.source.split("\n")[0]] as const))(
    "SQL-and-JSMQL row %i: `%s` compiles to the shape its mode names",
    (i) => {
      const { mode, source } = VERSUS[i];
      expect(Array.isArray(ENTRIES[mode](source))).toBe(CHIP_IS_ARRAY[mode]);
    },
  );

  it.each(EXAMPLES.map((e, i) => [i, e.chip, e.source.split("\n")[0]] as const))(
    "example %i (%s): `%s` compiles to the shape its label promises",
    (i, chip) => {
      const { mode, source } = EXAMPLES[i];
      expect(CHIP_IS_ARRAY).toHaveProperty(chip);
      expect(Array.isArray(ENTRIES[mode](source))).toBe(CHIP_IS_ARRAY[chip]);
    },
  );

  it("names a known entry point in every data-mode", () => {
    for (const { mode } of EXAMPLES) expect(ENTRIES).toHaveProperty(mode);
  });

  it("labels each example with the entry point that compiles it", () => {
    for (const { mode, chip } of EXAMPLES) {
      if (mode !== "auto") expect(chip).toBe(mode);
    }
  });
});

describe("site: GitHub Pages invariants", () => {
  it("serves the landing page as a static file, not a Jekyll template", () => {
    expect(INDEX.startsWith("---")).toBe(false);
    expect(INDEX).not.toMatch(/\{\{|\{%/);
  });

  it("binds the site to the domain package.json advertises, whenever CNAME is present", () => {
    const cnamePath = resolve(ROOT, "CNAME");
    if (!existsSync(cnamePath)) return;
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    expect(readFileSync(cnamePath, "utf8").trim()).toBe(new URL(pkg.homepage).host);
  });

  it("publishes both pages and the bundle they import", () => {
    const config = readFileSync(resolve(ROOT, "_config.yml"), "utf8");
    expect(config).toMatch(/^\s+- index\.html$/m);
    expect(config).toMatch(/^\s+- playground\.html$/m);
    expect(INDEX).toContain('import("./dist/jsmql.js")');
  });
});
