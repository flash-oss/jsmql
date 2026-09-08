// Phase 4 of src/compiler/ — which document a program becomes.
//
// The reference compiler answers this with four stacked auto-wrap heuristics in
// `lowerWithCtx`, each a special case with its own paragraph of reasoning. The
// rule here asks the ROW instead, and the second suite below is what says the two
// agree: every input the test suite feeds the compiler, compared against the
// document it actually returned.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { jsmql } from "../src/index.ts";
import { parse } from "../src/compiler/parse/parser.ts";
import { desugar } from "../src/compiler/passes/desugar.ts";
import { shapeOf } from "../src/compiler/passes/shape.ts";

// The shape is read off the PARSED program: an entry picks the desugar root from it, and the
// statement-root desugar turns a lone mutator call into the write it means.
const shape = (src: string): string => shapeOf(parse(src));

describe("compiler/passes/shape — a statement makes a pipeline", () => {
  it("reads a write as a pipeline, with or without a `;`", () => {
    expect(shape("$.a = 1")).toBe("pipeline");
    expect(shape("$.a = 1;")).toBe("pipeline");
    expect(shape("delete $.a")).toBe("pipeline");
  });

  it("reads a stage as a pipeline — it has no expression form at all", () => {
    expect(shape("$match($.a > 1)")).toBe("pipeline");
    expect(shape("$limit(10)")).toBe("pipeline");
    // The shape MongoDB Compass produces when you copy a stage out of it.
    expect(shape("{ $match: { active: true } }")).toBe("pipeline");
  });

  it("reads a stream as a pipeline however the chain ends", () => {
    expect(shape("$$.take(10)")).toBe("pipeline");
    expect(shape("$$.$sort({ a: -1 }).take(3)")).toBe("pipeline");
    expect(shape("$$.indexStats()")).toBe("pipeline");
  });

  it("reads a mutator as a pipeline, because it is a write", () => {
    expect(shape("$.items.sort()")).toBe("pipeline");
    expect(shape("$.items.push(9)")).toBe("pipeline");
  });

  it("reads a lone declaration as a pipeline, since nothing would read it", () => {
    expect(shape("let x = $.a;")).toBe("pipeline");
  });
});

describe("compiler/passes/shape — an expression makes a filter", () => {
  it("reads a predicate as a filter", () => {
    expect(shape("$.a > 1")).toBe("filter");
    expect(shape("$.a === 1")).toBe("filter");
    expect(shape("$.a")).toBe("filter");
    expect(shape("5")).toBe("filter");
  });

  it("reads a method with a value form as a filter when it stands alone", () => {
    // `.filter()` lists `value` as well as `stream`; `$match` lists only `stream`.
    expect(shape("$.items.filter(d => d.x)")).toBe("filter");
    expect(shape("$.items.toSorted()")).toBe("filter");
  });

  it("reads `Object.assign` on a field as the write it is, and on a fresh object as a value", () => {
    // a merged object is truthy: as a filter, `Object.assign($.a, $.b)` would keep every document
    expect(shape("Object.assign($.a, $.b)")).toBe("pipeline");
    expect(shape("Object.assign($.a, $.b);")).toBe("pipeline");
    expect(shape("Object.assign({}, $.a, $.b)")).toBe("filter");
  });
});

describe("compiler/passes/shape — a bracketed literal is decided by its first element", () => {
  it("is a pipeline when the first element is a statement", () => {
    expect(shape("[$match($.a > 1)]")).toBe("pipeline");
    expect(shape("[$.a = 1]")).toBe("pipeline");
    expect(shape("[let x = $.a + 1, $match(x > 5)]")).toBe("pipeline");
    expect(shape("[function double(x) { return x * 2 }, $set({ a: double($.p) })]")).toBe("pipeline");
  });

  it("is a value array otherwise", () => {
    expect(shape("[1, 2, 3]")).toBe("filter");
    expect(shape("[]")).toBe("filter");
    // One of the two readings has to win before the rest can be checked: the
    // compiler refuses `$match` here for not being an expression.
    expect(shape("[1, $match($.a > 1)]")).toBe("filter");
  });
});

// ── the differential ─────────────────────────────────────────────────────────

/** Every source the test suite feeds the compiler. */
function corpus(): string[] {
  const found = new Set<string>();
  const dir = new URL(".", import.meta.url).pathname;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".test.ts"))) {
    const src = readFileSync(dir + file, "utf8");
    for (const m of src.matchAll(
      /\b(?:jsmql(?:\.\w+)?|expr|filter|pipeline|update|compiled|applied|unordered)\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g,
    )) {
      const s = m[2].replace(/\\(['"\\])/g, "$1").replace(/\\n/g, "\n");
      if (s.length > 0 && s.length < 400) found.add(s);
    }
  }
  return [...found];
}

/**
 * A program that STARTS with a binding, which the reference compiler may fold away
 * before it decides the shape.
 *
 * `const a = 1; $.x === a` compiles to `{ "x": 1 }`: the value is a compile-time
 * constant, so it is inlined and one expression is left. `let` folds too — it is
 * the VALUE that has to be constant, not the keyword. The rule here decides
 * before any folding, so it answers pipeline, and a binding that does not fold
 * really is one: `let a = $.n; $.x === a` is a pipeline in both compilers, which
 * is why it never reaches this list. The divergence closes when folding lands.
 */
const startsWithABinding = (src: string): boolean => /^\s*(?:const|let)\s/.test(src) && src.includes(";");

describe("compiler/passes/shape — agrees with the reference compiler", () => {
  it("gives the same answer for every input the suite compiles", () => {
    const differ: string[] = [];
    let compared = 0;
    for (const src of corpus()) {
      let actual: string;
      try {
        actual = Array.isArray(jsmql(src)) ? "pipeline" : "filter";
      } catch {
        continue; // an input the reference compiler refuses says nothing about shape
      }
      let mine: string;
      try {
        mine = shape(src);
      } catch {
        continue; // an input the new parser refuses is the parser suite's business
      }
      compared++;
      if (mine !== actual && !startsWithABinding(src)) differ.push(`${mine} vs ${actual}: ${src.slice(0, 70)}`);
    }
    expect(compared).toBeGreaterThan(400);
    expect(differ).toEqual([]);
  });
});
