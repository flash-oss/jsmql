import { describe, expect, it } from "vitest";
import { Chain, Env, injectedPlacement, type Site } from "../src/compiler/emit/env.ts";
import { parse } from "../src/compiler/parse/parser.ts";
import type { Position } from "../src/registry/vocabulary.ts";

const program = parse("$.items.map(x => x * 2)");

describe("compiler/emit/env — a transition changes one thing and keeps the rest", () => {
  it("a lambda body sees the envelope, the boundaries and the same chain as its surroundings", () => {
    const chain = new Chain();
    const outer = Env.root(program, "statement", chain)
      .enter({ stage: "$lookup", path: ["pipeline"] }, chain)
      .literal()
      .at({ at: "value" });
    const body = outer.param("x", "unknown", 3).env;
    expect(body.site.envelope).toBe("$literal");
    expect(body.site.boundaries).toEqual([{ stage: "$lookup", path: ["pipeline"], outer: chain }]);
    expect(body.site.where).toEqual({ at: "value" });
    expect(body.site.root).toBe("statement");
    expect(body.chain).toBe(chain);
    expect(body.lookup("x", 0).ref).toEqual({ kind: "var", ref: "$$x" });
  });

  it("a binding made for a body is not visible outside it", () => {
    const root = Env.root(program, "value");
    root.param("y", "unknown", 0);
    expect(() => root.lookup("y", 9)).toThrow(/Unknown identifier 'y'/);
  });

  it("reserves every name the program introduces before any mint", () => {
    const root = Env.root(parse("$.a.map(jsmqlArr => jsmqlArr)"), "value");
    expect(root.fresh("arr").as).toBe("jsmqlArr2");
  });

  it("a sub-pipeline entry puts the body in statement position under a new chain", () => {
    const outer = new Chain();
    const inner = new Chain();
    const env = Env.root(program, "statement", outer)
      .at({ at: "value" })
      .enter({ stage: "$facet", path: ["*"] }, inner);
    expect(env.site.where).toEqual({ at: "statement" });
    expect(env.chain).toBe(inner);
  });
});

describe("compiler/emit/env — the HR1 gate is one function", () => {
  const site = (where: Site["where"], root: Position, envelope: Site["envelope"]): Site => ({
    where,
    root,
    envelope,
    boundaries: [],
  });

  it("places an injected `$…` by the slot: $literal where the server evaluates, as written where nothing is read, refused elsewhere", () => {
    expect(injectedPlacement(site({ at: "value" }, "value", "none"))).toBe("literal");
    expect(injectedPlacement(site({ at: "value" }, "filter", "none"))).toBe("literal");
    expect(injectedPlacement(site({ at: "value" }, "statement", "none"))).toBe("literal");
    expect(injectedPlacement(site({ at: "value" }, "updateDoc", "none"))).toBe("asWritten");
    expect(injectedPlacement(site({ at: "value" }, "value", "$literal"))).toBe("asWritten");
    expect(injectedPlacement(site({ at: "value", written: { stage: "$unwind", path: [] } }, "statement", "none"))).toBe(
      "refused",
    );
    expect(injectedPlacement(site({ at: "filter" }, "filter", "none"))).toBe("asWritten");
    expect(injectedPlacement(site({ at: "group" }, "statement", "none"))).toBe("refused");
    expect(injectedPlacement(site({ at: "window" }, "statement", "none"))).toBe("refused");
    expect(injectedPlacement(site({ at: "target" }, "value", "none"))).toBe("refused");
  });
});

describe("compiler/emit/env — a chain closes in one order", () => {
  it("drains hoisted stages ahead of the stage that needed them, then cleanup, then the terminal stage", () => {
    const c = new Chain();
    c.emitted.push({ $match: { a: 1 } });
    const ref = c.hoist([{ $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } }], "__jsmql.length");
    expect(ref).toBe("$__jsmql.length");
    c.flush();
    c.emitted.push({ $set: { n: ref } });
    c.terminal = { stage: { $out: "archive" }, spelled: "$$$.archive = …" };
    expect(c.close()).toEqual([
      { $match: { a: 1 } },
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { n: "$__jsmql.length" } },
      { $unset: "__jsmql" },
      { $out: "archive" },
    ]);
  });

  it("hands the hoisted stages back so a road can place them between two of its own", () => {
    const c = new Chain();
    c.emitted.push({ $sortByCount: "$tag" });
    c.hoist([{ $lookup: { from: "o", localField: "_id", foreignField: "tag", as: "__jsmql.tmp.0" } }], "__jsmql.tmp.0");
    expect(c.ahead()).toEqual([
      { $lookup: { from: "o", localField: "_id", foreignField: "tag", as: "__jsmql.tmp.0" } },
    ]);
    expect(c.ahead()).toEqual([]);
  });

  it("emits no cleanup when nothing was written under __jsmql", () => {
    const c = new Chain();
    c.emitted.push({ $match: { a: 1 } });
    expect(c.close()).toEqual([{ $match: { a: 1 } }]);
  });

  it("hands out distinct scratch slots and marks the chain dirty", () => {
    const c = new Chain();
    expect(c.dirty).toBe(false);
    expect(c.slot().path).toBe("__jsmql.tmp.0");
    expect(c.slot().path).toBe("__jsmql.tmp.1");
    expect(c.dirty).toBe(true);
  });
});
