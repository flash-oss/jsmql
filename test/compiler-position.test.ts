import { describe, expect, it } from "vitest";
import { parse } from "../src/compiler/parse/parser.ts";
import type { Where } from "../src/compiler/passes/position.ts";
import { edge, FILTER, STATEMENT, UPDATE_DOC, VALUE } from "../src/compiler/passes/position.ts";
import { mapTreeIn } from "../src/compiler/passes/walk.ts";
import { bodySlotAt, isStageName } from "../src/compiler/rows.ts";
import type { Position } from "../src/registry/vocabulary.ts";
import { NAMES } from "../src/registry/names.ts";

type Any = { type: string } & Record<string, unknown>;

function label(n: Any): string {
  if (n.type === "OperatorCall" || n.type === "MethodCall") return `${n.name}(…)`;
  if (n.type === "KeyValueEntry") return `${(n.key as { name?: string })?.name ?? "[computed]"}:`;
  return n.type;
}

function census(src: string, root: Where = STATEMENT): string[] {
  const seen: string[] = [];
  mapTreeIn(parse(src) as unknown as object, root, edge, (n, where) => {
    const at = where.at === "stageBody" ? `stageBody[${where.stage}:${where.path.join(".")}]` : where.at;
    seen.push(`${at} ${label(n as Any)}`);
    return n;
  });
  return seen;
}

function positionOfNode(src: string, node: string, root: Where = STATEMENT): string {
  const hits = census(src, root).filter((line) => line.endsWith(" " + node));
  expect(hits, `${node} in ${src}`).toHaveLength(1);
  return hits[0].slice(0, hits[0].length - node.length - 1);
}

describe("compiler/passes/position — a stage body is laid out by its own row", () => {
  const SLOTS: [string, string, Position][] = [
    ["$group({_id: null, s: $sum($.x)});", "$sum(…)", "group"],
    ['$geoNear({near: 1, distanceField: "d", query: $.k === "a"});', "BinaryExpr", "filter"],
    ['$graphLookup({from: "t", restrictSearchWithMatch: $.k === "a"});', "BinaryExpr", "filter"],
    ["$setWindowFields({sortBy: {x: 1}, output: {r: $sum($.x)}});", "$sum(…)", "window"],
    ["$bucket({groupBy: $.x, boundaries: [0, 2], output: {s: $sum($.x)}});", "$sum(…)", "group"],
    ["$bucketAuto({groupBy: $.x, buckets: 2, output: {s: $sum($.x)}});", "$sum(…)", "group"],
    ["$match($.a > 1);", "BinaryExpr", "filter"],
  ];

  for (const [src, node, want] of SLOTS) {
    it(`puts ${node} at ${want} in ${src.slice(0, 44)}`, () => {
      expect(positionOfNode(src, node)).toBe(want);
    });
  }

  it("keeps the rest of a mixed body at value", () => {
    const lines = census("$group({_id: $.k, s: $sum($.x)});");
    expect(lines).toContain("stageBody[$group:] _id:");
    expect(lines).toContain("group $sum(…)");
    expect(positionOfNode("$setWindowFields({sortBy: {x: 1}, output: {r: $rank()}});", "x:")).toBe("value");
  });

  it("descends two named levels to reach $rankFusion's user-named pipelines", () => {
    const src = "$rankFusion({input: {pipelines: {a: [$match($.x > 1)]}}});";
    expect(positionOfNode(src, "$match(…)")).toBe("statement");
    expect(positionOfNode(src, "pipelines:")).toBe("stageBody[$rankFusion:input]");
  });

  it("treats every key of a $facet body as a pipeline, and only $facet's", () => {
    expect(positionOfNode("$facet({one: [$match($.a > 1)]});", "$match(…)")).toBe("statement");
    expect(positionOfNode("$project({one: [$.a, $.b]});", "ArrayLiteral")).toBe("value");
  });

  it("lays out a stage body by the NAME the node carries, in every spelling", () => {
    expect(positionOfNode("$$ = $$.$group({_id: null, s: $sum($.x)});", "$sum(…)")).toBe("group");
    expect(positionOfNode("$$ = $$.$match($.a > 1);", "BinaryExpr")).toBe("filter");
    expect(census("{ $match: { a: 1 } };")).toContain("filter ObjectLiteral");
  });

  it("reads the array form of a callee that takes stages as statements", () => {
    expect(positionOfNode("$$.aggregate([$match($.x > 1)]);", "$match(…)")).toBe("statement");
  });

  it("lays out a chained stage link based on where the context chain stands", () => {
    expect(positionOfNode("$.o = $$$.orders.filter(x => x.a).$group({_id: null, s: $sum($.x)});", "$sum(…)")).toBe(
      "group",
    );
    expect(positionOfNode("$ = { a: $$.$group({_id: null, s: $sum($.x)}) };", "$sum(…)")).toBe("group");
    expect(positionOfNode("$.o = $$$.orders.$match($.a > 1);", "BinaryExpr")).toBe("filter");
  });

  it("consults a layout only where a stage may stand", () => {
    expect(positionOfNode("$group({_id: null, n: $count()});", "$count(…)")).toBe("group");
  });

  it("positions a non-object body with the default position, not the layout", () => {
    expect(positionOfNode('$merge("out");', "StringLiteral")).toBe("value");
  });

  it("resolves a computed key through the wildcard alone", () => {
    expect(positionOfNode("let k = 1; $group({_id: null, [k]: $sum($.x)});", "$sum(…)")).toBe("group");
    expect(positionOfNode('let k = 1; $lookup({from: "t", [k]: [$.a]});', "ArrayLiteral")).toBe("value");
  });
});

describe("compiler/passes/position — what is named, and what is a stream", () => {
  it("puts the callee of a call at target, never at value", () => {
    expect(positionOfNode("f($.a);", "Ident")).toBe("target");
  });

  it("reads a chain by its BASE, through an index as well as a member", () => {
    expect(positionOfNode('$$$["archive"].find(o => o.id === 1);', "IndexAccess")).toBe("stream");
    const lines = census("$$.push($$$.other.filter(x => x.a));");
    expect(lines).toContain("stream MemberAccess");
    expect(lines).toContain("value DatabaseRef");
    expect(lines).toContain("value filter(…)");
  });

  it("puts the top link of `$$ = <chain>` at stream, so a chained stage reads its layout", () => {
    const lines = census("$$ = $$.filter(d => d.x).map(d => d.y);");
    expect(lines.filter((l) => l.startsWith("stream "))).toEqual([
      "stream StreamRef",
      "stream filter(…)",
      "stream map(…)",
    ]);
  });
});

describe("compiler/passes/position — the root position is the caller's fact", () => {
  it("reads one predicate as a filter, a value, or an update document", () => {
    expect(positionOfNode("$.a > 1", "BinaryExpr", FILTER)).toBe("filter");
    expect(positionOfNode("$.a > 1", "BinaryExpr", VALUE)).toBe("value");
    expect(positionOfNode("$.a > 1", "BinaryExpr", UPDATE_DOC)).toBe("updateDoc");
  });

  it("hands a `;`-separated program to statement position whatever the seed", () => {
    expect(positionOfNode("$match($.a > 1);", "$match(…)", FILTER)).toBe("statement");
  });
});

describe("compiler/rows — the body-layout resolver", () => {
  it("says `deeper` until the path is a leaf, and the position at every depth", () => {
    expect(bodySlotAt("$setWindowFields", [])).toEqual({
      at: "value",
      otherwise: "value",
      deeper: true,
      evaluated: false,
    });
    expect(bodySlotAt("$setWindowFields", ["output"])).toEqual({
      at: "value",
      otherwise: "value",
      deeper: true,
      evaluated: false,
    });
    expect(bodySlotAt("$setWindowFields", ["output", "r"])).toEqual({
      at: "window",
      otherwise: "window",
      deeper: false,
      evaluated: false,
    });
    expect(bodySlotAt("$setWindowFields", ["sortBy"])).toEqual({
      at: "value",
      otherwise: "value",
      deeper: false,
      evaluated: false,
    });
    expect(bodySlotAt("$match", [])).toEqual({ at: "filter", otherwise: "filter", deeper: false, evaluated: false });
  });

  it("answers a two-shape slot with a position per shape", () => {
    expect(bodySlotAt("$merge", ["whenMatched"])).toEqual({
      at: "statement",
      otherwise: "value",
      deeper: false,
      evaluated: false,
    });
    expect(bodySlotAt("$merge", ["whenNotMatched"])).toEqual({
      at: "value",
      otherwise: "value",
      deeper: false,
      evaluated: false,
    });
  });

  it("prefers a literal key over a `*` of the same depth", () => {
    expect(bodySlotAt("$group", ["_id"])).toEqual({ at: "value", otherwise: "value", deeper: false, evaluated: true });
    expect(bodySlotAt("$group", ["total"])).toEqual({
      at: "group",
      otherwise: "group",
      deeper: false,
      evaluated: false,
    });
    expect(bodySlotAt("$group", [null])).toEqual({ at: "group", otherwise: "group", deeper: false, evaluated: false });
  });

  it("says whether the server evaluates the value under a path, and descends to reach an evaluated path", () => {
    expect(bodySlotAt("$set", [])).toMatchObject({ at: "value", deeper: true, evaluated: false });
    expect(bodySlotAt("$set", ["x"])).toMatchObject({ at: "value", deeper: false, evaluated: true });
    expect(bodySlotAt("$lookup", ["let", "v"])).toMatchObject({ evaluated: true });
    expect(bodySlotAt("$lookup", ["from"])).toMatchObject({ evaluated: false });
    expect(bodySlotAt("$fill", ["output"])).toMatchObject({ deeper: true, evaluated: false });
    expect(bodySlotAt("$fill", ["output", "z", "value"])).toMatchObject({ deeper: false, evaluated: true });
    expect(bodySlotAt("$fill", ["output", "z", "method"])).toMatchObject({ evaluated: false });
    expect(bodySlotAt("$replaceWith", [])).toMatchObject({ evaluated: true });
    expect(bodySlotAt("$unwind", [])).toMatchObject({ evaluated: false });
  });

  it("answers nothing for a name that is not a stage", () => {
    expect(bodySlotAt("$sum", [])).toBeUndefined();
    expect(isStageName("$sum")).toBe(false);
    expect(isStageName("$group")).toBe(true);
  });
});

describe("registry — exactly the stages state a body layout", () => {
  type SlotPosition = Position | { list: Position; otherwise: Position };
  type Row = { kind?: string; where?: readonly Position[]; bodyPositions?: Readonly<Record<string, SlotPosition>> };
  const positionsIn = (at: SlotPosition): readonly Position[] =>
    typeof at === "string" ? [at] : [at.list, at.otherwise];

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
        for (const one of positionsIn(at)) if (!POSITIONS.includes(one)) wrong.push(`${name}.${path} = ${one}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("reaches all seven positions across the registry and the walk", () => {
    const reached = new Set<string>(["filter", "value", "updateDoc"]);
    for (const row of Object.values(NAMES) as Row[]) {
      for (const at of Object.values(row.bodyPositions ?? {})) for (const one of positionsIn(at)) reached.add(one);
    }
    reached.add("stream");
    expect([...reached].sort()).toEqual(["filter", "group", "statement", "stream", "updateDoc", "value", "window"]);
  });
});
