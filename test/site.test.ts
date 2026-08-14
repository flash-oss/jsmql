/**
 * Guards for the published site — the landing page `index.html`, the `CNAME`
 * that binds it to jsmql.js.org, and the `_config.yml` that tells GitHub Pages
 * what to publish. See docs/specs/site.md.
 *
 * The landing page never spells out an MQL document. It compiles each example
 * in the reader's browser with the same `dist/jsmql.js` bundle the playground
 * imports, so the page cannot show output the compiler no longer produces.
 * What can still rot is the JSMQL *input*: a syntax change makes an example
 * throw, and the page then shows an error message where a document belongs.
 * These cases compile every example the same way the page does and fail the
 * suite instead.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { jsmql } from "../src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = readFileSync(resolve(ROOT, "index.html"), "utf8");

/** The `data-mode` values the page uses, mapped to the entry point each names. */
const ENTRIES = {
  auto: jsmql,
  filter: jsmql.filter,
  update: jsmql.update,
  expression: jsmql.expr,
  pipeline: jsmql.pipeline,
} as const;

type Mode = keyof typeof ENTRIES;

/** A shape label (the chip above an example) and the output type it promises. */
const CHIP_IS_ARRAY: Record<string, boolean> = { filter: false, expression: false, pipeline: true, update: true };

function decodeEntities(html: string): string {
  // `&amp;` resolves last. In the other order `&amp;gt;` would turn into `>`.
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

/**
 * Pull every example out of the page. The shape this reads — one `<article>`
 * per example, a `data-mode` attribute, a chip class, and the JSMQL source in
 * `pre.src > code` — is the same shape the page's own module script reads, so
 * a markup change that breaks one breaks the other.
 */
function readExamples(): Example[] {
  const out: Example[] = [];
  // `class="example[^"]*"` so a presentational modifier (`class="example tall"`)
  // cannot drop an example out of the extraction — that failure is silent, and
  // silently reviewing fewer examples than the page shows is the one outcome
  // this file exists to prevent. `countMarkupExamples()` is the backstop.
  const article = /<article class="example[^"]*" data-example data-mode="([a-z]+)">([\s\S]*?)<\/article>/g;
  for (const [, mode, body] of INDEX.matchAll(article)) {
    const chip = /<span class="chip ([a-z]+)">/.exec(body);
    const source = /<pre class="src"><code>([\s\S]*?)<\/code><\/pre>/.exec(body);
    if (!chip || !source) throw new Error(`index.html example (mode ${mode}) lost its chip or source`);
    out.push({ mode: mode as Mode, chip: chip[1], source: decodeEntities(source[1]).trim() });
  }
  return out;
}

/** How many examples the markup declares, counted independently of the parse above. */
function countMarkupExamples(): number {
  return (INDEX.match(/<article[^>]*\bdata-example\b/g) ?? []).length;
}

const EXAMPLES = readExamples();

describe("site: landing-page examples", () => {
  it("extracts every example the markup declares", () => {
    // Counted two ways on purpose. A lower bound alone passes while an example
    // slips out of the parse, which leaves the cases below reviewing a page
    // that is not the published one.
    expect(EXAMPLES.length).toBe(countMarkupExamples());
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(7);
  });

  it.each(EXAMPLES.map((e, i) => [i, e.chip, e.source.split("\n")[0]] as const))(
    "example %i (%s): `%s` compiles",
    (i) => {
      const { mode, source } = EXAMPLES[i];
      expect(() => ENTRIES[mode](source)).not.toThrow();
    },
  );

  it.each(EXAMPLES.map((e, i) => [i, e.chip] as const))(
    "example %i output is the shape its %s label promises",
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
    // `auto` is the exception: the polymorphic entry decides the shape itself,
    // so the chip states which shape it lands on rather than which entry runs.
    for (const { mode, chip } of EXAMPLES) {
      if (mode !== "auto") expect(chip).toBe(mode);
    }
  });
});

describe("site: GitHub Pages invariants", () => {
  it("serves the landing page as a static file, not a Jekyll template", () => {
    // Jekyll renders Liquid only in files that carry YAML front matter. The
    // page holds JavaScript and MQL braces, so it must stay a plain copy.
    expect(INDEX.startsWith("---")).toBe(false);
    expect(INDEX).not.toMatch(/\{\{|\{%/);
  });

  it("binds the site to the domain package.json advertises, whenever CNAME is present", () => {
    // GitHub Pages redirects the github.io URL to whatever CNAME names, so the
    // file has to be absent while the domain does not resolve yet — otherwise
    // there is nowhere to review the site. Hold the binding when the file is
    // there, and stay quiet when it is deliberately not.
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
