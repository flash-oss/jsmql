import { describe, expect, it } from "vitest";
import { parse } from "../src/compiler/parse/parser.ts";
import { desugar, desugarVerbose } from "../src/compiler/passes/desugar.ts";
import { RULES } from "../src/compiler/passes/desugar-rules.ts";
import "../src/compiler/emit/lower.ts";
import { edge, STATEMENT } from "../src/compiler/passes/position.ts";
import { mapTreeIn } from "../src/compiler/passes/walk.ts";

const shape = (src: string): string =>
  JSON.stringify(desugar(parse(src)), (k, v) =>
    k === "pos" ? 0 : k === "mutates" || k === "wrote" || k === "minted" ? undefined : v,
  );

const EQUIVALENT: [string, string][] = [
  ["$.items.map(String)", "$.items.map(x => String(x))"],
  ["$.items.filter(Boolean)", "$.items.filter(x => Boolean(x))"],
  ["$.items.map(Math.random)", "$.items.map(x => Math.random(x))"],
  ["$.a += 1;", "$.a = $.a + 1;"],
  ["$.a -= 2;", "$.a = $.a - 2;"],
  ["$.a *= 2;", "$.a = $.a * 2;"],
  ["$.a /= 2;", "$.a = $.a / 2;"],
  ["$.u.score += 5;", "$.u.score = $.u.score + 5;"],
  ['$.s += "x";', '$.s = $.s + "x";'],
  ["$.a++;", "$.a = $.a + 1;"],
  ["++$.a;", "$.a = $.a + 1;"],
  ["$.a--;", "$.a = $.a - 1;"],
  ["--$.a;", "$.a = $.a - 1;"],
  ["let x = 1; x += 1;", "let x = 1; x = x + 1;"],
  ["let x = 1; x++;", "let x = 1; x = x + 1;"],
  ["let x = 1; x--;", "let x = 1; x = x - 1;"],
  ["$.items.map(x => { return x * 2 });", "$.items.map(x => x * 2);"],
  ["$.items.filter(x => { return x > 1 });", "$.items.filter(x => x > 1);"],
  ["$.items.sort();", "$.items = $.items.toSorted();"],
  ["$.items.sort(x => x.n);", "$.items = $.items.toSorted(x => x.n);"],
  ["$.items.reverse();", "$.items = $.items.toReversed();"],
  ["$.items.splice(1, 2);", "$.items = $.items.toSpliced(1, 2);"],
  ["$.items.splice(1, 2, 7, 8);", "$.items = $.items.toSpliced(1, 2, 7, 8);"],
  ["$.a.b.sort();", "$.a.b = $.a.b.toSorted();"],
  ["$.items.push(9);", "$.items = [...$.items, 9];"],
  ["$.items.push(9, 10);", "$.items = [...$.items, 9, 10];"],
  ["$.items.unshift(0);", "$.items = [0, ...$.items];"],
  ["$.items.unshift(0, 1);", "$.items = [0, 1, ...$.items];"],
  ["$.a = 1; $.items.sort();", "$.a = 1; $.items = $.items.toSorted();"],
  ["[$match($.x > 1), $.items.sort()]", "[$match($.x > 1), $.items = $.items.toSorted()]"],
  ['$.items.map("name")', "$.items.map(x => x.name)"],
  ['$.items.map("a.b")', "$.items.map(x => x.a.b)"],
  ["$.items.filter({ active: true })", "$.items.filter(x => x.active === true)"],
  ["$.items.filter({ a: 1, b: 2, c: 3 })", "$.items.filter(x => x.a === 1 && x.b === 2 && x.c === 3)"],
  ['$.items.filter({ "a.b": 1 })', "$.items.filter(x => x.a.b === 1)"],
  ["$.items.filter({ a: { b: { c: 3 } }, e: 1 })", "$.items.filter(x => x.a.b.c === 3 && x.e === 1)"],
  ["$.items.filter({ qty: { $gt: 5 } })", "$.items.filter(x => x.qty.$gt === 5)"],
  ['$.items.filter({ tags: ["a", "b"] })', '$.items.filter(x => x.tags.has("a") && x.tags.has("b"))'],
  ["$.items.filter({ a: {} })", "$.items.filter(x => true)"],
  ['$.items.filter(["active", true])', "$.items.filter(x => x.active === true)"],
  ['$.items.filter(["a.b", 1])', "$.items.filter(x => x.a.b === 1)"],
  ["$.items.countBy()", "$.items.countBy(x => x)"],
  ['$.items.differenceBy($.other, "id")', "$.items.differenceBy($.other, x => x.id)"],
  ['$$ = $$.filter({ cat: "a" });', '$$ = $$.filter(x => x.cat === "a");'],
  ['$$ = $$.groupBy("k");', "$$ = $$.groupBy(x => x.k);"],
];

const only = (node: unknown): { type: string } & Record<string, unknown> => {
  const n = node as { type: string; stmts?: unknown[] } & Record<string, unknown>;
  return n.type === "Pipeline" && n.stmts?.length === 1 ? (n.stmts[0] as typeof n) : n;
};

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

describe("compiler/passes/desugar — a compound write on a field is its '=' form", () => {
  it("still allows the same operators on a field of the document", () => {
    expect(shape("$.n += 1;")).toBe(shape("$.n = $.n + 1;"));
    expect(shape("$.n++;")).toBe(shape("$.n = $.n + 1;"));
  });
});

describe("compiler/passes/desugar — the driver", () => {
  it("stops as soon as a round changes nothing", () => {
    expect(desugarVerbose(parse("$.a += 1;")).rounds).toBe(2);
    expect(desugarVerbose(parse("$.a = 1;")).rounds).toBe(1);
  });

  it("names every rule after the production it removes", () => {
    for (const rule of RULES) expect(rule.name).toMatch(/^[a-z][A-Za-z]+$/);
  });

  it("reaches a fixpoint on every input in the equivalence table", () => {
    for (const [sugar] of EQUIVALENT) {
      const settled = desugarVerbose(parse(sugar)).program;
      expect(desugarVerbose(settled).rounds, sugar).toBe(1);
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
  const pathOf = (src: string): string => {
    const node = desugar(parse(src)) as { type: string; path?: string };
    return node.type === "FieldRef" ? (node.path as string) : node.type;
  };

  it("folds a dotted read into a single FieldRef", () => {
    expect(pathOf("$.a.b")).toBe("a.b");
    expect(pathOf("$.a.b.c.d")).toBe("a.b.c.d");
    expect(pathOf("$.a?.b")).toBe("a.b");
    expect(pathOf("$.a.map")).toBe("a.map");
  });

  it("folds `.length` as a field, because every computed value is a call", () => {
    expect(pathOf("$.a.length")).toBe("a.length");
    expect(pathOf("$.a.length.b")).toBe("a.length.b");
    expect(pathOf("$.a.length()")).toBe("MethodCall");
  });

  it("folds nothing that is not rooted in the document", () => {
    expect(pathOf("$.a[0].b")).toBe("MemberAccess");
    expect(pathOf("$$.a.b")).toBe("MemberAccess");
    expect(pathOf("$$$.coll.f")).toBe("MemberAccess");
  });
});

describe("compiler/passes/desugar — a mutator is rewritten ONLY as a statement", () => {
  const became = (src: string): string => {
    const t = only(desugar(parse(src))) as { type: string; ops?: { value: { type: string } }[] };
    return t.type === "UpdateFilter" ? `write(${t.ops?.[0].value.type})` : t.type;
  };

  it("declines a mutator in every position that is not a statement", () => {
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

  it("writes a mutator with no same-argument twin through the form its row states", () => {
    expect(became("$.items.pop();")).toBe("write(MethodCall)");
    expect(became("$.items.shift();")).toBe("write(MethodCall)");
    expect(became("$.items.fill(0);")).toBe("write(MethodCall)");
    expect(became("$.items.copyWithin(0, 3);")).toBe("write(ArrayLiteral)");
    expect(() => became("$.items.pop(1);")).toThrow("'.pop()' at position 7 takes exactly 0 arguments, got 1.");
  });
});

describe("compiler/passes/position — the position each node stands in", () => {
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
    expect(at('$lookup({ from: "x", pipeline: [$.items.sort()], as: "y" });', "statement")).toContain(
      "MethodCall.sort",
    );
    expect(at("$facet({ a: [$.items.sort()] });", "statement")).toContain("MethodCall.sort");
  });

  it("finds no statement where the same shape is a value", () => {
    expect(at("$.a = $.items.sort()", "statement")).not.toContain("MethodCall.sort");
    expect(at("$.a = [1, $.items.push(2)]", "statement")).not.toContain("MethodCall.push");
    expect(at('$lookup({ from: "x", localField: $.a.sort(), as: "y" });', "statement")).not.toContain(
      "MethodCall.sort",
    );
  });

  it("carries the stream down every link of a `$$ = …` chain, but not into a callback", () => {
    const src = "$$ = $$.filter(d => d.x).map(d => d.y);";
    expect(at(src, "stream")).toEqual(["StreamRef", "MethodCall.filter", "MethodCall.map"]);
    expect(at(src, "value")).toContain("Lambda");
  });

  it("carries the stream through a foreign source, whose `$$$` is not itself one", () => {
    expect(at("$$ = $$$.orders.filter(d => d.x);", "stream")).toEqual(["MemberAccess.orders", "MethodCall.filter"]);
  });

  it("keeps the left of a write out of value position", () => {
    expect(at("$$ = $$.filter(d => d.x);", "target")).toEqual(["StreamRef"]);
    expect(at("$.a = 1;", "target")).toEqual(["FieldRef"]);
    expect(at("delete $.a;", "target")).toEqual(["FieldRef"]);
    expect(at("$.a = 1;", "value")).toEqual(["NumberLiteral"]);
    expect(at("$.a = 1;", "statement")).toEqual(["AssignExpr", "UpdateFilter", "Pipeline"]);
    expect(at("delete $.a;", "statement")).toEqual(["DeleteStmt", "UpdateFilter", "Pipeline"]);
  });
});

describe("compiler/passes/desugar — a shorthand is rewritten only where a ROW says so", () => {
  const arg = (src: string, slot = 0): string => {
    const t = only(desugar(parse(src))) as {
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
    expect(arg('$.items.toSorted("name")')).toBe("StringLiteral");
    expect(arg("$.items.toSorted({ rank: 1 })")).toBe("ObjectLiteral");
    expect(arg('$.items.toSorted(["a", "b"])')).toBe("ArrayLiteral");
    expect(arg('$.user.pick(["a", "b"])')).toBe("ArrayLiteral");
  });

  it("reads an object in a stream's '.groupBy()' as a matcher, as on an array", () => {
    expect(arg('$$ = $$.groupBy({ status: "A" });')).toBe("Lambda");
    expect(arg('$$ = $$.groupBy("k");')).toBe("Lambda");
  });

  it("leaves a slot the row declares arrow-only alone", () => {
    expect(arg('$.o.mapValues("f")')).toBe("StringLiteral");
    expect(arg("$.items.reduce((a, v) => a + v, 0)")).toBe("Lambda");
    expect(arg('Object.groupBy($.items, ["a", 1])')).toBe("FieldRef");
    expect(arg('Object.groupBy($.items, ["a", 1])', 1)).toBe("ArrayLiteral");
  });

  it("applies a bare callable global, and leaves a binding alone", () => {
    expect(arg("$.items.map(Number)")).toBe("Lambda");
    expect(arg("$.items.map(Math.floor)")).toBe("Lambda");
    expect(arg("$.items.map(Date)")).toBe("Lambda");
    expect(arg("$.items.map(Decimal128)")).toBe("Lambda");
    expect(arg("$.items.map(Set)")).toBe("Lambda");
    expect(arg("$.items.map(f)")).toBe("Ident");
  });

  it("does not capture a name the rewritten value mentions", () => {
    expect(shape("let x = 1; $.items.filter({ a: x });")).toBe(shape("let x = 1; $.items.filter(x2 => x2.a === x);"));
    expect(shape('$.items.filter({ a: "x" });')).toBe(shape('$.items.filter(x => x.a === "x");'));
  });

  it("declines a matcher whose key is not written out", () => {
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
