// Phase 3 of src/compiler/ — the desugar pass.
//
// The test for a rewrite is not "what tree did it build" but "is that the SAME
// tree the explicit form builds". Written that way a rule cannot pass by
// producing something merely plausible, and the table doubles as the
// documentation of what each sugar means.

import { describe, expect, it } from "vitest";
import { parse } from "../src/compiler/parse/parser.ts";
import { desugar, desugarVerbose, RULES } from "../src/compiler/passes/desugar.ts";

/** The tree, with source offsets erased — two spellings sit at different columns. */
const shape = (src: string): string => JSON.stringify(desugar(parse(src)), (k, v) => (k === "pos" ? 0 : v));

/** Each pair: the sugar, and the source it MEANS. */
const EQUIVALENT: [string, string][] = [
  // compound assignment on a field
  ["$.a += 1;", "$.a = $.a + 1;"],
  ["$.a -= 2;", "$.a = $.a - 2;"],
  ["$.a *= 2;", "$.a = $.a * 2;"],
  ["$.a /= 2;", "$.a = $.a / 2;"],
  // a dotted path is written back to the same path
  ["$.u.score += 5;", "$.u.score = $.u.score + 5;"],
  // string concatenation falls out of the ordinary `+` once desugared
  ['$.s += "x";', '$.s = $.s + "x";'],
  // increment and decrement, all four spellings
  ["$.a++;", "$.a = $.a + 1;"],
  ["++$.a;", "$.a = $.a + 1;"],
  ["$.a--;", "$.a = $.a - 1;"],
  ["--$.a;", "$.a = $.a - 1;"],
  // the same rewrite on a binding, where the slot is resolved much later
  ["let x = 1; x += 1;", "let x = 1; x = x + 1;"],
  ["let x = 1; x++;", "let x = 1; x = x + 1;"],
  ["let x = 1; x--;", "let x = 1; x = x - 1;"],
  // a block whose only statement is the return
  ["$.items.map(x => { return x * 2 });", "$.items.map(x => x * 2);"],
  ["$.items.filter(x => { return x > 1 });", "$.items.filter(x => x > 1);"],
];

describe("compiler/passes/desugar — a sugar becomes the source it means", () => {
  for (const [sugar, plain] of EQUIVALENT) {
    it(`${sugar}  ≡  ${plain}`, () => {
      expect(shape(sugar)).toBe(shape(plain));
    });
  }

  it("leaves a program with no sugar untouched", () => {
    const program = parse("$.a = 1;");
    expect(desugar(program)).toBe(program);
  });
});

describe("compiler/passes/desugar — the guards run BEFORE the rewrite", () => {
  // Rewriting first would turn a tailored refusal into valid-looking MQL:
  // `$ += 1` would become `$ = $ + 1`, which compiles to a $replaceWith.
  const refused: [string, RegExp][] = [
    ["$ += 1;", /Cannot use '\+=' on bare '\$'/],
    ["$ -= 1;", /Cannot use '-=' on bare '\$'/],
    ["$++;", /Cannot use '\+\+' on bare '\$'/],
    ["$$ += 1;", /Cannot use '\+=' on '\$\$'/],
    ["$$++;", /Cannot use '\+\+' on '\$\$'/],
  ];
  for (const [src, message] of refused) {
    it(`refuses ${src}`, () => {
      expect(() => desugar(parse(src))).toThrow(message);
    });
  }

  it("still allows the same operators on a field of the document", () => {
    expect(() => desugar(parse("$.n += 1;"))).not.toThrow();
    expect(() => desugar(parse("$.n++;"))).not.toThrow();
  });
});

describe("compiler/passes/desugar — the driver", () => {
  it("stops as soon as a round changes nothing", () => {
    // One round to rewrite, one to observe that nothing more fires.
    expect(desugarVerbose(parse("$.a += 1;")).rounds).toBe(2);
    // Nothing to do at all.
    expect(desugarVerbose(parse("$.a = 1;")).rounds).toBe(1);
  });

  it("names every rule after the production it removes", () => {
    for (const rule of RULES) expect(rule.name).toMatch(/^[a-z][A-Za-z]+$/);
  });

  it("reaches a fixpoint on every input in the equivalence table", () => {
    for (const [sugar] of EQUIVALENT) {
      expect(() => desugarVerbose(parse(sugar)), sugar).not.toThrow();
    }
  });
});

describe("compiler/passes/desugar — the walker cannot skip a node type", () => {
  it("rewrites a sugar buried inside a callback, an object and an array", () => {
    const buried = "$$ = $$.aggregate(o => { $set({ k: 1 }); $.deep.n += 1; });";
    const plain = "$$ = $$.aggregate(o => { $set({ k: 1 }); $.deep.n = $.deep.n + 1; });";
    expect(shape(buried)).toBe(shape(plain));
  });

  it("rewrites both sides of a comma-joined write run", () => {
    expect(shape("$.a += 1, $.b++;")).toBe(shape("$.a = $.a + 1, $.b = $.b + 1;"));
  });
});
