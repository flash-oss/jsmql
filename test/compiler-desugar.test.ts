// Phase 3 of src/compiler/ — the desugar pass.
//
// The test for a rewrite is not "what tree did it build" but "is that the SAME
// tree the explicit form builds". Written that way a rule cannot pass by
// producing something merely plausible, and the table doubles as the
// documentation of what each sugar means.

import { describe, expect, it } from "vitest";
import { parse } from "../src/compiler/parse/parser.ts";
import { desugar, desugarVerbose, RULES } from "../src/compiler/passes/desugar.ts";
import { edge, STATEMENT } from "../src/compiler/passes/position.ts";
import { mapTreeIn } from "../src/compiler/passes/walk.ts";

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
  // a mutator whose row names an immutable twin, arguments forwarded untouched
  ["$.items.sort();", "$.items = $.items.toSorted();"],
  ["$.items.sort(x => x.n);", "$.items = $.items.toSorted(x => x.n);"],
  ["$.items.reverse();", "$.items = $.items.toReversed();"],
  ["$.items.splice(1, 2);", "$.items = $.items.toSpliced(1, 2);"],
  ["$.items.splice(1, 2, 7, 8);", "$.items = $.items.toSpliced(1, 2, 7, 8);"],
  ["$.a.b.sort();", "$.a.b = $.a.b.toSorted();"],
  // a mutator whose immutable spelling is a shape rather than a name
  ["$.items.push(9);", "$.items = [...$.items, 9];"],
  ["$.items.push(9, 10);", "$.items = [...$.items, 9, 10];"],
  ["$.items.unshift(0);", "$.items = [0, ...$.items];"],
  ["$.items.unshift(0, 1);", "$.items = [0, 1, ...$.items];"],
  // the same rewrite reached through the other two statement spellings
  ["$.a = 1; $.items.sort();", "$.a = 1; $.items = $.items.toSorted();"],
  ["[$match($.x > 1), $.items.sort()]", "[$match($.x > 1), $.items = $.items.toSorted()]"],
  // an iteratee shorthand is the shortest sugar there is: a spelling of an arrow
  ['$.items.map("name")', "$.items.map(x => x.name)"],
  ['$.items.map("a.b")', "$.items.map(x => x.a.b)"],
  ["$.items.filter({ active: true })", "$.items.filter(x => x.active === true)"],
  ["$.items.filter({ a: 1, b: 2, c: 3 })", "$.items.filter(x => x.a === 1 && x.b === 2 && x.c === 3)"],
  ['$.items.filter({ "a.b": 1 })', "$.items.filter(x => x.a.b === 1)"],
  ['$.items.filter(["active", true])', "$.items.filter(x => x.active === true)"],
  ['$.items.filter(["a.b", 1])', "$.items.filter(x => x.a.b === 1)"],
  ["$.items.countBy()", "$.items.countBy(x => x)"],
  ['$.items.differenceBy($.other, "id")', "$.items.differenceBy($.other, x => x.id)"],
  ['$$ = $$.filter({ cat: "a" });', '$$ = $$.filter(x => x.cat === "a");'],
  ['$$ = $$.groupBy("k");', "$$ = $$.groupBy(x => x.k);"],
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

describe("compiler/passes/desugar — a field path is ONE node", () => {
  /** The path a source spells, or the node type when it did not become one. */
  const pathOf = (src: string): string => {
    const node = desugar(parse(src)) as { type: string; path?: string };
    return node.type === "FieldRef" ? (node.path as string) : node.type;
  };

  it("folds a dotted read into a single FieldRef", () => {
    expect(pathOf("$.a.b")).toBe("a.b");
    expect(pathOf("$.a.b.c.d")).toBe("a.b.c.d");
    // `?.` and `.` are the same path in MQL: a missing prefix yields missing.
    expect(pathOf("$.a?.b")).toBe("a.b");
    // A method NAME with no call behind it is an ordinary field.
    expect(pathOf("$.a.map")).toBe("a.map");
  });

  it("leaves `.length` alone, because its row is READ and not called", () => {
    expect(pathOf("$.a.length")).toBe("MemberAccess");
    // …but a segment AFTER it makes the whole chain a path again, which is why
    // the rule collects the chain instead of folding one link at a time.
    expect(pathOf("$.a.length.b")).toBe("a.length.b");
  });

  it("folds nothing that is not rooted in the document", () => {
    expect(pathOf("$.a[0].b")).toBe("MemberAccess");
    expect(pathOf("$$.a.b")).toBe("MemberAccess");
    expect(pathOf("$$$.coll.f")).toBe("MemberAccess");
  });
});

describe("compiler/passes/desugar — a mutator is rewritten ONLY as a statement", () => {
  /** What the program became, named closely enough to tell a write from a call. */
  const became = (src: string): string => {
    const t = desugar(parse(src)) as { type: string; ops?: { value: { type: string } }[] };
    return t.type === "UpdateFilter" ? `write(${t.ops?.[0].value.type})` : t.type;
  };

  it("declines a mutator in every position that is not a statement", () => {
    // The row's own refusal has to survive to phase 5 to be seen at all.
    expect(became("$.a = $.items.sort()")).toBe("write(MethodCall)");
    expect(became("$.a = [1, $.items.push(2)]")).toBe("write(ArrayLiteral)");
  });

  it("declines a receiver MQL cannot write back to", () => {
    expect(became("$.items[0].push(1);")).toBe("MethodCall");
    expect(became("$.items.filter(x => x > 1).sort();")).toBe("MethodCall");
  });

  it("declines the stream, whose `$$.push` and `$$.sort` are other stages", () => {
    expect(became("$$.push($$$.other);")).toBe("MethodCall");
    expect(became("$$.sort({ x: 1 });")).toBe("MethodCall");
  });

  it("declines a mutator with no same-argument immutable spelling", () => {
    // `.toSpliced(-1, 1)` computes what `.pop()` does, but from arguments the
    // caller never wrote — so these four are lowered directly instead.
    for (const src of ["$.items.pop();", "$.items.shift();", "$.items.fill(0);", "$.items.copyWithin(0, 3);"]) {
      expect(became(src), src).toBe("MethodCall");
    }
  });
});

describe("compiler/passes/position — the position each node stands in", () => {
  /** Every node, tagged with the position that reached it. */
  const positions = (src: string): string[] => {
    const seen: string[] = [];
    mapTreeIn(parse(src), STATEMENT, edge, (node, where) => {
      const n = node as { type: string; name?: string };
      seen.push(`${where.at}:${n.type}${n.name === undefined ? "" : "." + n.name}`);
      return node;
    });
    return seen;
  };
  const at = (src: string, where: string): string[] =>
    positions(src)
      .filter((s) => s.startsWith(where + ":"))
      .map((s) => s.slice(where.length + 1));

  it("finds a statement in each of the four slots that holds one", () => {
    expect(at("$.items.sort()", "statement")).toContain("MethodCall.sort");
    expect(at("$.a = 1; $.items.sort();", "statement")).toContain("MethodCall.sort");
    expect(at("[$match($.x > 1), $.items.sort()]", "statement")).toContain("MethodCall.sort");
    // The sub-pipeline slot comes from the stage's own `subPipelineFields`.
    expect(at('$lookup({ from: "x", pipeline: [$.items.sort()], as: "y" });', "statement")).toContain(
      "MethodCall.sort",
    );
    expect(at("$facet({ a: [$.items.sort()] });", "statement")).toContain("MethodCall.sort");
  });

  it("finds no statement where the same shape is a value", () => {
    expect(at("$.a = $.items.sort()", "statement")).not.toContain("MethodCall.sort");
    expect(at("$.a = [1, $.items.push(2)]", "statement")).not.toContain("MethodCall.push");
    // A key of a stage body that holds no pipeline stays a value.
    expect(at('$lookup({ from: "x", localField: $.a.sort(), as: "y" });', "statement")).not.toContain(
      "MethodCall.sort",
    );
  });

  it("carries the stream down every link of a `$$ = …` chain, but not into a callback", () => {
    const src = "$$ = $$.filter(d => d.x).map(d => d.y);";
    // Children first — the walk is bottom-up, so the chain reads inside out.
    expect(at(src, "stream")).toEqual(["CollectionRef", "MethodCall.filter", "MethodCall.map"]);
    // The lambda reads one document, so it is an ordinary expression.
    expect(at(src, "value")).toContain("Lambda");
  });

  it("carries the stream through a foreign source, whose `$$$` is not itself one", () => {
    // `$$$` is a scope, not a source: only `$$$.<coll>` names a stream. So the
    // bare `DatabaseRef` is left to its own row to refuse.
    expect(at("$$ = $$$.orders.filter(d => d.x);", "stream")).toEqual(["MemberAccess.orders", "MethodCall.filter"]);
  });

  it("keeps the left of a write out of value position", () => {
    expect(at("$$ = $$.filter(d => d.x);", "target")).toEqual(["CollectionRef"]);
    expect(at("$.a = 1;", "target")).toEqual(["FieldRef"]);
    expect(at("delete $.a;", "target")).toEqual(["FieldRef"]);
    expect(at("$.a = 1;", "value")).toEqual(["NumberLiteral"]);
    // The write itself is a statement, not a value: the run groups writes into
    // one stage, it does not turn them into expressions.
    expect(at("$.a = 1;", "statement")).toEqual(["AssignExpr", "UpdateFilter"]);
    expect(at("delete $.a;", "statement")).toEqual(["DeleteStmt", "UpdateFilter"]);
  });
});

describe("compiler/passes/desugar — a shorthand is rewritten only where a ROW says so", () => {
  /** What the first (or given) argument became. */
  const arg = (src: string, slot = 0): string => {
    const t = desugar(parse(src)) as {
      type: string;
      args?: { type: string }[];
      ops?: { value: { args: { type: string }[] } }[];
    };
    const call = t.type === "MethodCall" ? t : (t.ops?.[0].value as { args: { type: string }[] });
    return call.args?.[slot]?.type ?? "absent";
  };

  it("rewrites a shorthand in a slot the row declares", () => {
    expect(arg('$.items.map("name")')).toBe("Lambda");
    expect(arg("$.items.filter({ active: true })")).toBe("Lambda");
    expect(arg('$.items.filter(["active", true])')).toBe("Lambda");
    expect(arg('$.items.differenceBy($.other, "id")', 1)).toBe("Lambda");
  });

  it("leaves a sort SPEC alone, which wears the same three spellings", () => {
    // `{f: 1}` is a matcher to `.filter()` and a DIRECTION to `.toSorted()`, and
    // `["a", "b"]` is a path/value pair to one and two sort keys to the other.
    expect(arg('$.items.toSorted("name")')).toBe("StringLiteral");
    expect(arg("$.items.toSorted({ rank: 1 })")).toBe("ObjectLiteral");
    expect(arg('$.items.toSorted(["a", "b"])')).toBe("ArrayLiteral");
    expect(arg('$.user.pick(["a", "b"])')).toBe("ArrayLiteral");
  });

  it("leaves the one spelling that is a stage body alone", () => {
    // `$$.groupBy({ … })` is a raw `$group` document; its other spellings are not.
    expect(arg("$$ = $$.groupBy({ _id: $.k, n: $sum(1) });")).toBe("ObjectLiteral");
    expect(arg('$$ = $$.groupBy("k");')).toBe("Lambda");
  });

  it("leaves a slot the row declares arrow-only alone", () => {
    expect(arg('$.o.mapValues("f")')).toBe("StringLiteral");
    expect(arg("$.items.reduce((a, v) => a + v, 0)")).toBe("Lambda");
    // `Object.groupBy(collection, discriminator)` puts the collection FIRST, so a
    // layout keyed by position rather than by receiver would rewrite the wrong slot.
    expect(arg('Object.groupBy($.items, ["a", 1])')).toBe("FieldRef");
    expect(arg('Object.groupBy($.items, ["a", 1])', 1)).toBe("ArrayLiteral");
  });

  it("leaves a bare callable alone, because rewriting it would WIDEN the language", () => {
    // `$.items.map(Math.asinh)` is refused unapplied and accepted as
    // `x => Math.asinh(x)`. Which callables may be passed bare is the row's call.
    expect(arg("$.items.map(Number)")).toBe("Ident");
    expect(arg("$.items.map(Math.floor)")).toBe("MemberAccess");
  });

  it("does not capture a name the rewritten value mentions", () => {
    expect(shape("let x = 1; $.items.filter({ a: x });")).toBe(shape("let x = 1; $.items.filter(x2 => x2.a === x);"));
    // Nothing claims `x`, so the ordinary case keeps the plain name.
    expect(shape('$.items.filter({ a: "x" });')).toBe(shape('$.items.filter(x => x.a === "x");'));
  });

  it("declines a matcher whose key is not written out", () => {
    // A computed key or a spread is not a matcher: there is no path to compare.
    expect(arg("$.items.filter({ [$.k]: 1 })")).toBe("ObjectLiteral");
    expect(arg("$.items.filter({ ...$.spec })")).toBe("ObjectLiteral");
    expect(arg("$.items.filter({})")).toBe("ObjectLiteral");
  });

  it("declines an array that is not a path/value pair", () => {
    expect(arg("$.items.filter([1, 2])")).toBe("ArrayLiteral");
    expect(arg('$.items.filter(["a", 1, 2])')).toBe("ArrayLiteral");
    expect(arg('$.items.filter(["a"])')).toBe("ArrayLiteral");
  });
});
