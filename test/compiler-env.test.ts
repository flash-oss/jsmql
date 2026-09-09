// Phase 5 of src/compiler/ — the environment record.
//
// Three invariants, each the negative of a context bug:
//   a lambda body inherits EVERYTHING from its surroundings — a transition changes one thing
//   the HR1 gate is one predicate with a stated truth table
//   a chain closes in one order: stages, cleanup, terminal — nothing after `$out`
// The type-level half — no optional field, no literal, no spread — is in
// test/types/registry-contracts.ts.

import { describe, expect, it } from "vitest";
import { Chain, Env, injectedNeedsLiteral, type Site } from "../src/compiler/emit/env.ts";
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
    // the boundary remembers the chain it was entered FROM — how `$$` reaches the root stream from inside
    expect(body.site.boundaries).toEqual([{ stage: "$lookup", path: ["pipeline"], outer: chain }]);
    expect(body.site.where).toEqual({ at: "value" });
    expect(body.site.root).toBe("statement");
    expect(body.chain).toBe(chain); // the SAME chain, by reference
    expect(body.lookup("x", 0).ref).toEqual({ kind: "var", ref: "$$x" });
  });

  it("a binding made for a body is not visible outside it", () => {
    const root = Env.root(program, "value");
    root.param("y", "unknown", 0);
    expect(() => root.lookup("y", 9)).toThrow(/Unknown identifier 'y'/);
  });

  it("reserves every name the program introduces before any mint", () => {
    // `x` is a lambda parameter deep in the program; a mint named after it steps aside.
    const root = Env.root(parse("$.a.map(jsmqlArr => jsmqlArr)"), "value");
    expect(root.fresh("arr").as).toBe("jsmqlArr2");
  });

  it("entering a sub-pipeline puts the body in statement position under a new chain", () => {
    const outer = new Chain();
    const inner = new Chain();
    const env = Env.root(program, "statement", outer)
      .at({ at: "value" })
      .enter({ stage: "$facet", path: ["*"] }, inner);
    expect(env.site.where).toEqual({ at: "statement" });
    expect(env.chain).toBe(inner);
  });
});

describe("compiler/emit/env — the HR1 gate is one predicate", () => {
  const site = (where: Site["where"], root: Position, envelope: Site["envelope"]): Site => ({
    where,
    root,
    envelope,
    boundaries: [],
  });

  it("wraps an injected `$…` in every value slot the server evaluates, outside $literal", () => {
    expect(injectedNeedsLiteral(site({ at: "value" }, "value", "none"))).toBe(true);
    expect(injectedNeedsLiteral(site({ at: "value" }, "filter", "none"))).toBe(true);
    // a pipeline's `$set` value and stage bodies are evaluated too
    expect(injectedNeedsLiteral(site({ at: "value" }, "statement", "none"))).toBe(true);
    // an update DOCUMENT stores the string as written
    expect(injectedNeedsLiteral(site({ at: "value" }, "updateDoc", "none"))).toBe(false);
    // a $literal the developer wrote already protects it
    expect(injectedNeedsLiteral(site({ at: "value" }, "value", "$literal"))).toBe(false);
    // a query slot is not an expression: nothing there is read as a field reference
    expect(injectedNeedsLiteral(site({ at: "filter" }, "filter", "none"))).toBe(false);
    expect(injectedNeedsLiteral(site({ at: "target" }, "value", "none"))).toBe(false);
  });
});

describe("compiler/emit/env — a chain closes in one order", () => {
  it("drains hoisted stages ahead of the statement, then cleanup, then the terminal stage", () => {
    const c = new Chain();
    c.emitted.push({ $match: { a: 1 } });
    const ref = c.hoist([{ $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } }], "__jsmql.length");
    expect(ref).toBe("$__jsmql.length");
    c.flush();
    c.emitted.push({ $set: { n: ref } });
    c.terminal = { $out: "archive" };
    expect(c.close()).toEqual([
      { $match: { a: 1 } },
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { n: "$__jsmql.length" } },
      { $unset: "__jsmql" },
      { $out: "archive" },
    ]);
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
