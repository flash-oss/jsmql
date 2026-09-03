// Phase 4 of src/compiler/ — the position pass.
//
// A position is not a property of a node's SHAPE. `$sum($.x, $.y)` is a valid
// two-operand expression and an invalid accumulator, and the only thing that
// separates the two readings is where the call stands. So the test is a census:
// walk a program, record where every node was reached, and assert the answers
// against what mongod does with each slot.

import { describe, expect, it } from "vitest";
import { parse } from "../src/compiler/parse/parser.ts";
import type { Where } from "../src/compiler/passes/position.ts";
import { edge, FILTER, STATEMENT, UPDATE_DOC, VALUE } from "../src/compiler/passes/position.ts";
import { mapTreeIn } from "../src/compiler/passes/walk.ts";
import { bodySlotAt, isStageName } from "../src/compiler/rows.ts";
import type { Position } from "../src/registry/vocabulary.ts";
import { NAMES } from "../src/registry/names.ts";

type Any = { type: string } & Record<string, unknown>;

/** How a node reads in a census line, distinctly enough to assert on. */
function label(n: Any): string {
  if (n.type === "OperatorCall" || n.type === "MethodCall") return `${n.name}(…)`;
  if (n.type === "KeyValueEntry") return `${(n.key as { name?: string })?.name ?? "[computed]"}:`;
  return n.type;
}

/** Every node of `src`, as `"<position> <node>"`, in visit order. */
function census(src: string, root: Where = STATEMENT): string[] {
  const seen: string[] = [];
  mapTreeIn(parse(src) as unknown as object, root, edge, (n, where) => {
    const at = where.at === "stageBody" ? `stageBody[${where.stage}:${where.path.join(".")}]` : where.at;
    seen.push(`${at} ${label(n as Any)}`);
    return n;
  });
  return seen;
}

/** Where `src` puts the node that reads as `node`. Throws if it is not reached once. */
function positionOfNode(src: string, node: string, root: Where = STATEMENT): string {
  const hits = census(src, root).filter((line) => line.endsWith(" " + node));
  expect(hits, `${node} in ${src}`).toHaveLength(1);
  return hits[0].slice(0, hits[0].length - node.length - 1);
}

describe("compiler/passes/position — a stage body is laid out by its own row", () => {
  /**
   * Each case is a slot mongod treats differently from an ordinary expression
   * slot, with the measurement that proves it. Before the row stated its layout
   * every one of these arrived at `value`, and the first three are documents
   * mongod refuses outright — which the shipped compiler emits today.
   */
  const SLOTS: [string, string, Position][] = [
    // {$group:{_id:null,s:{$sum:["$x","$y"]}}} → "The $sum accumulator is a unary operator"
    ["$group({_id: null, s: $sum($.x)});", "$sum(…)", "group"],
    // {$geoNear:{…,query:{$eq:["$k","a"]}}} → "unknown top level operator: $eq"
    ['$geoNear({near: 1, distanceField: "d", query: $.k === "a"});', "BinaryExpr", "filter"],
    // {$graphLookup:{…,restrictSearchWithMatch:{$eq:["$k","a"]}}} → the same refusal
    ['$graphLookup({from: "t", restrictSearchWithMatch: $.k === "a"});', "BinaryExpr", "filter"],
    // {$setWindowFields:{sortBy:{x:1},output:{r:{$sum:["$x","$y"]}}}} → 0, where
    // the unary form answers 4. Accepted and wrong, which nothing reports.
    ["$setWindowFields({sortBy: {x: 1}, output: {r: $sum($.x)}});", "$sum(…)", "window"],
    // {$bucket:{…,output:{s:{$sum:["$x","$y"]}}}} → "unary operator", same as $group
    ["$bucket({groupBy: $.x, boundaries: [0, 2], output: {s: $sum($.x)}});", "$sum(…)", "group"],
    ["$bucketAuto({groupBy: $.x, buckets: 2, output: {s: $sum($.x)}});", "$sum(…)", "group"],
    // A query document, which is not an expression: {$match:{$gt:["$x",1]}}
    //   → "unknown top level operator: $gt"
    ["$match($.a > 1);", "BinaryExpr", "filter"],
  ];

  for (const [src, node, want] of SLOTS) {
    it(`puts ${node} at ${want} in ${src.slice(0, 44)}`, () => {
      expect(positionOfNode(src, node)).toBe(want);
    });
  }

  it("keeps the rest of a mixed body at value", () => {
    // `_id` is the one key of a $group body that is NOT an accumulator, and
    // mongod agrees both ways: {$group:{_id:{$sum:["$x","$y"]}}} is accepted.
    const lines = census("$group({_id: $.k, s: $sum($.x)});");
    expect(lines).toContain("stageBody[$group:] _id:");
    expect(lines).toContain("group $sum(…)");
    // `sortBy` is a key spec, not an expression slot: mongod refuses an
    // expression there with "$meta is the only expression supported by $sort".
    expect(positionOfNode("$setWindowFields({sortBy: {x: 1}, output: {r: $rank()}});", "x:")).toBe("value");
  });

  it("descends two named levels to reach $rankFusion's user-named pipelines", () => {
    const src = "$rankFusion({input: {pipelines: {a: [$match($.x > 1)]}}});";
    expect(positionOfNode(src, "$match(…)")).toBe("statement");
    // A sibling of `pipelines` is an ordinary value, one level up from a pipeline.
    expect(positionOfNode(src, "pipelines:")).toBe("stageBody[$rankFusion:input]");
  });

  it("treats every key of a $facet body as a pipeline, and only $facet's", () => {
    expect(positionOfNode("$facet({one: [$match($.a > 1)]});", "$match(…)")).toBe("statement");
    // The same array one step further in is an array VALUE, not a pipeline.
    expect(positionOfNode("$project({one: [$.a, $.b]});", "ArrayLiteral")).toBe("value");
  });

  it("lays out a stage body by the NAME the node carries, in every spelling", () => {
    // Three spellings of one stage — a call, a chained link, a raw document —
    // name the same row and read the same layout. The chained spelling used to
    // bypass it: `$$.$group({…, s: $sum($.x, $.y)})` was checked as a two-operand
    // expression (legal) and emitted the document mongod refuses.
    expect(positionOfNode("$$ = $$.$group({_id: null, s: $sum($.x)});", "$sum(…)")).toBe("group");
    expect(positionOfNode("$$ = $$.$match($.a > 1);", "BinaryExpr")).toBe("filter");
    // The raw document holds two object literals: the stage document itself, at
    // statement, and its body, at filter.
    expect(census("{ $match: { a: 1 } };")).toContain("filter ObjectLiteral");
  });

  it("reads the array form of a stages-taking callee as statements", () => {
    // `$$.aggregate([$match(…)])` — the row says the callback is a block of
    // stages, and an array of them is the same list.
    expect(positionOfNode("$$.aggregate([$match($.x > 1)]);", "$match(…)")).toBe("statement");
  });

  it("lays out a chained stage link wherever its context-rooted chain stands", () => {
    // The chain's top link is a value to its parent, but `$group` on a stream is a
    // stage: its body must reach the group slot, or `$sum($.x, $.y)` inside it
    // is checked as a two-operand expression and emitted as one.
    expect(positionOfNode("$.o = $$$.orders.filter(x => x.a).$group({_id: null, s: $sum($.x)});", "$sum(…)")).toBe(
      "group",
    );
    expect(positionOfNode("$ = { a: $$.$group({_id: null, s: $sum($.x)}) };", "$sum(…)")).toBe("group");
    expect(positionOfNode("$.o = $$$.orders.$match($.a > 1);", "BinaryExpr")).toBe("filter");
  });

  it("consults a layout only where a stage may stand", () => {
    // `$count` is a stage AND an accumulator. Inside `$group` its arguments are an
    // operator's, and the stage layout must not claim them.
    expect(positionOfNode("$group({_id: null, n: $count()});", "$count(…)")).toBe("group");
  });

  it("positions a body that is not an object, under a layout that names keys", () => {
    // `$merge`'s layout names `whenMatched`, so its body is `deeper` — but a string
    // has nothing to descend into, and takes the body's own position.
    expect(positionOfNode('$merge("out");', "StringLiteral")).toBe("value");
  });

  it("resolves a computed key through the wildcard alone", () => {
    // `{ [k]: … }` cannot be known to be the key a row names, so a literal entry
    // can never claim it — but `$group`'s `"*": "group"` covers any key at all.
    expect(positionOfNode("let k = 1; $group({_id: null, [k]: $sum($.x)});", "$sum(…)")).toBe("group");
    // $lookup names `pipeline` literally, so a computed key falls back to the
    // body's own default rather than being read as a sub-pipeline.
    expect(positionOfNode('let k = 1; $lookup({from: "t", [k]: [$.a]});', "ArrayLiteral")).toBe("value");
  });
});

describe("compiler/passes/position — what is named, and what is a stream", () => {
  it("puts the callee of a call at target, never at value", () => {
    // Folding `f` away in `f(1)` gives `3(1)`; the fold and this pass share the
    // one predicate (naming.ts) that says a callee names rather than values.
    expect(positionOfNode("f($.a);", "Ident")).toBe("target");
  });

  it("reads a chain by its BASE, through an index as well as a member", () => {
    // `$$$["archive"]` and `$$$.archive` are one collection; a reader that walked
    // through `.` but not `[…]` gave the two different documents.
    expect(positionOfNode('$$$["archive"].find(o => o.id === 1);', "IndexAccess")).toBe("stream");
    // The chain's top link stands where its parent put it — an argument of `push`
    // is a value — while the links below it are streams and `$$$` is a scope.
    const lines = census("$$.push($$$.other.filter(x => x.a));");
    expect(lines).toContain("stream MemberAccess");
    expect(lines).toContain("value DatabaseRef");
    expect(lines).toContain("value filter(…)");
  });

  it("puts the top link of `$$ = <chain>` at stream, so a chained stage reads its layout", () => {
    const lines = census("$$ = $$.filter(d => d.x).map(d => d.y);");
    expect(lines.filter((l) => l.startsWith("stream "))).toEqual([
      "stream CollectionRef",
      "stream filter(…)",
      "stream map(…)",
    ]);
  });
});

describe("compiler/passes/position — the root position is the caller's fact", () => {
  /**
   * No program can tell the four entry points apart, so the seed is passed in.
   * `$.a > 1` is one predicate as a filter and one boolean as an expression, and
   * both are legal MQL — a wrong seed is a wrong document, not an error.
   */
  it("reads one predicate as a filter, a value, or an update document", () => {
    expect(positionOfNode("$.a > 1", "BinaryExpr", FILTER)).toBe("filter");
    expect(positionOfNode("$.a > 1", "BinaryExpr", VALUE)).toBe("value");
    expect(positionOfNode("$.a > 1", "BinaryExpr", UPDATE_DOC)).toBe("updateDoc");
  });

  it("hands a `;`-separated program to statement position whatever the seed", () => {
    // The `;` makes it a Pipeline, and a Pipeline's elements are statements —
    // the seed cannot override that, because the tree already says so.
    expect(positionOfNode("$match($.a > 1);", "$match(…)", FILTER)).toBe("statement");
  });
});

describe("compiler/rows — the body-layout resolver", () => {
  it("says `deeper` until the path is a leaf, and the position at every depth", () => {
    // Both facts at once: the position a leaf here would hold, and whether an
    // object here must keep descending. `$merge("out")` needs the first with the
    // second true — a string body under a layout that names `whenMatched` has no
    // keys to descend into, and used to stay unpositioned.
    expect(bodySlotAt("$setWindowFields", [])).toEqual({ at: "value", deeper: true });
    expect(bodySlotAt("$setWindowFields", ["output"])).toEqual({ at: "value", deeper: true });
    expect(bodySlotAt("$setWindowFields", ["output", "r"])).toEqual({ at: "window", deeper: false });
    expect(bodySlotAt("$setWindowFields", ["sortBy"])).toEqual({ at: "value", deeper: false });
    // $match names no key, so its body is a leaf at once and everything in the
    // query document below it is query too.
    expect(bodySlotAt("$match", [])).toEqual({ at: "filter", deeper: false });
  });

  it("prefers a literal key over a `*` of the same depth", () => {
    expect(bodySlotAt("$group", ["_id"])).toEqual({ at: "value", deeper: false });
    expect(bodySlotAt("$group", ["total"])).toEqual({ at: "group", deeper: false });
    expect(bodySlotAt("$group", [null])).toEqual({ at: "group", deeper: false });
  });

  it("answers nothing for a name that is not a stage", () => {
    expect(bodySlotAt("$sum", [])).toBeUndefined();
    expect(isStageName("$sum")).toBe(false);
    expect(isStageName("$group")).toBe(true);
  });
});

describe("registry — exactly the stages state a body layout", () => {
  type Row = { kind?: string; where?: readonly Position[]; bodyPositions?: Readonly<Record<string, Position>> };

  /**
   * A stage's ARGUMENT is a body. A row that is not a stage has no body to lay
   * out, so the two facts must agree in both directions — and a stage with no
   * layout sends its whole body to `value`, which is where every slot bug this
   * field fixes came from.
   */
  it("gives a layout to every stage row and to no other row", () => {
    const wrong: string[] = [];
    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      const isStage = row.kind === "mongo" && row.where?.includes("stream") === true;
      const hasLayout = row.bodyPositions !== undefined;
      if (isStage !== hasLayout) wrong.push(`${name}: stage=${isStage} layout=${hasLayout}`);
    }
    expect(wrong).toEqual([]);
  });

  it("states a layout whose every position is one a phase can be at", () => {
    const POSITIONS: readonly string[] = ["value", "filter", "stream", "statement", "group", "window", "updateDoc"];
    const wrong: string[] = [];
    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      for (const [path, at] of Object.entries(row.bodyPositions ?? {})) {
        if (!POSITIONS.includes(at)) wrong.push(`${name}.${path} = ${at}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("reaches all seven positions across the registry and the walk", () => {
    // Three of the seven were unreachable before this pass could resolve a body
    // path, so the count is the finding, not a statistic.
    const reached = new Set<string>(["filter", "value", "updateDoc"]); // by seed
    for (const row of Object.values(NAMES) as Row[]) {
      for (const at of Object.values(row.bodyPositions ?? {})) reached.add(at);
    }
    reached.add("stream"); // `$$ = $$.…`, an edge on the assignment, not a body path
    expect([...reached].sort()).toEqual(["filter", "group", "statement", "stream", "updateDoc", "value", "window"]);
  });
});
