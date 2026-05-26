// Tests for the `$$$.<coll>.find/filter(...)` → `$lookup` lowering.
// See docs/specs/lookup-stage.md for the design and docs/LANGUAGE.md
// for the user-facing reference.

import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

describe("$$$.coll.find/filter — direct assignment, basic form", () => {
  it(".filter assigns the array directly to the LHS slot", () => {
    expect(jsmql("$.orders = $$$.orders.filter(o => o.userId === $._id);")).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "orders" } },
    ]);
  });

  it(".find adds a $set { $first } follow-up so the slot holds a scalar-or-null", () => {
    expect(jsmql("$.order = $$$.orders.find(o => o.userId === $._id);")).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "order" } },
      { $set: { order: { $first: "$order" } } },
    ]);
  });

  it("bracket-form collection name: $$$['orders']", () => {
    expect(jsmql(`$.orders = $$$["my-orders"].filter(o => o.userId === $._id);`)).toEqual([
      { $lookup: { from: "my-orders", localField: "_id", foreignField: "userId", as: "orders" } },
    ]);
  });

  it("dotted assignment LHS becomes a dotted `as` (MongoDB accepts that)", () => {
    expect(jsmql("$.user.profile = $$$.profiles.find(p => p.userId === $._id);")).toEqual([
      { $lookup: { from: "profiles", localField: "_id", foreignField: "userId", as: "user.profile" } },
      { $set: { "user.profile": { $first: "$user.profile" } } },
    ]);
  });

  it("== between two field paths is rejected by jsmql's project-wide `==`-against-null-only rule", () => {
    // The lookup surface does NOT carve an exception for `==`: the standard
    // `===` / `==` table in LANGUAGE.md restricts `==` to comparisons against
    // `null`. A user who writes `o.userId == $._id` gets the same actionable
    // error they would anywhere else in jsmql (pointed at `===`).
    expect(() => jsmql("$.orders = $$$.orders.filter(o => o.userId == $._id);")).toThrow(
      /'=='\s*is only allowed against null in jsmql\. Use '==='/,
    );
  });
});

describe("$$$.coll.find/filter — pipeline-form fallback (richer predicate)", () => {
  it("compound && predicate auto-hoists `$.x` refs into `let`", () => {
    const out = jsmql("$.user = $$$.users.find(u => u._id === $.userId && u.active);");
    // Two stages: the $lookup (pipeline form) and the $set $first for `.find`.
    expect(out).toHaveLength(2);
    const lookupStage = (out as object[])[0] as {
      $lookup: { from: string; let: Record<string, string>; pipeline: object[]; as: string };
    };
    expect(lookupStage.$lookup.from).toBe("users");
    expect(lookupStage.$lookup.let).toEqual({ userId: "$userId" });
    expect(lookupStage.$lookup.as).toBe("user");
    expect((out as object[])[1]).toEqual({ $set: { user: { $first: "$user" } } });
  });

  it("two refs to the same `$.x` share one let entry (dedup)", () => {
    const out = jsmql("$.users = $$$.users.filter(u => u._id === $.userId && u.lastLogin > $.userId);");
    const lookup = ((out as object[])[0] as { $lookup: { let: Record<string, string> } }).$lookup;
    expect(Object.keys(lookup.let)).toEqual(["userId"]);
    expect(lookup.let.userId).toBe("$userId");
  });

  it("multiple distinct `$.x` refs land as multiple let entries", () => {
    const out = jsmql("$.users = $$$.users.filter(u => u._id === $.userId && u.tenantId === $.tenantId);");
    const lookup = ((out as object[])[0] as { $lookup: { let: Record<string, string> } }).$lookup;
    expect(Object.keys(lookup.let).sort()).toEqual(["tenantId", "userId"]);
  });
});

describe("$$$.coll.find/filter — block-body sub-pipeline", () => {
  it("block stages become the sub-pipeline body, with `$.x` refs hoisted into let", () => {
    const out = jsmql(`
      $.recent = $$$.orders.filter(o => {
        $match(o.userId === $._id);
        $sort({ createdAt: -1 });
        $limit(10);
      });
    `);
    expect(out).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { _id: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$_id"] } } },
            { $sort: { createdAt: -1 } },
            { $limit: 10 },
          ],
          as: "recent",
        },
      },
    ]);
  });

  it("block body with .find still gets a $set { $first } follow-up", () => {
    const out = jsmql(`
      $.user = $$$.users.find(u => {
        $match(u._id === $._id);
        $project({ name: 1, email: 1 });
      });
    `);
    expect((out as object[]).length).toBe(2);
    expect((out as object[])[1]).toEqual({ $set: { user: { $first: "$user" } } });
  });
});

describe("$$$.coll.find/filter — chained terminals", () => {
  it("chained .length on .filter produces $size + slot writeback", () => {
    const out = jsmql("let n = $$$.orders.filter(o => o.userId === $._id).length;");
    expect(out).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.__lookup1" } },
      { $set: { "__jsmql.__lookup1": { $size: "$__jsmql.__lookup1" } } },
      { $set: { "__jsmql.n": "$__jsmql.__lookup1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("chained .reduce on .filter folds with the user's lambda", () => {
    const out = jsmql("let total = $$$.tx.filter(t => t.userId === $._id).reduce((acc, t) => acc + t.amount, 0);");
    expect(out).toEqual([
      { $lookup: { from: "tx", localField: "_id", foreignField: "userId", as: "__jsmql.__lookup1" } },
      {
        $set: {
          "__jsmql.__lookup1": {
            $reduce: { input: "$__jsmql.__lookup1", initialValue: 0, in: { $add: ["$$value", "$$this.amount"] } },
          },
        },
      },
      { $set: { "__jsmql.total": "$__jsmql.__lookup1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("chained .reduce rejects when the lookup is .find (scalar-or-null is not foldable)", () => {
    expect(() =>
      jsmql("let total = $$$.tx.find(t => t.userId === $._id).reduce((acc, t) => acc + t.amount, 0);"),
    ).toThrow(/\.reduce\(\) on a \.find\(\) result is not meaningful/);
  });

  it("chained .length rejects when the lookup is .find (scalar doc has no .length)", () => {
    // `.find` lowers with `$set $first` so the slot holds a scalar doc (or null).
    // `$size` on a non-array errors at runtime; reject at compile time and point
    // the user at `.filter(...).length` (count matches) instead.
    expect(() => jsmql("let n = $$$.users.find(u => u._id === $._id).length;")).toThrow(
      /\.length on a \.find\(\) result is not meaningful/,
    );
  });

  it("member access on a .find result lowers via the materialised scalar slot", () => {
    const out = jsmql("let name = $$$.users.find(u => u._id === $.userId).name;");
    expect(out).toEqual([
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "__jsmql.__lookup1" } },
      { $set: { "__jsmql.__lookup1": { $first: "$__jsmql.__lookup1" } } },
      { $set: { "__jsmql.name": "$__jsmql.__lookup1.name" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("multiple lookups in one pipeline allocate distinct internal slots", () => {
    const out = jsmql(`
      let nOrders = $$$.orders.filter(o => o.userId === $._id).length;
      let nTx = $$$.tx.filter(t => t.userId === $._id).length;
    `);
    const json = JSON.stringify(out);
    expect(json).toContain("__jsmql.__lookup1");
    expect(json).toContain("__jsmql.__lookup2");
  });
});

describe("$$$.coll.find/filter — error cases", () => {
  it("bare $$$ outside a chain points at the lookup shape", () => {
    expect(() => jsmql.expr("$$$.myColl")).toThrow(/must be followed by \.find\(pred\) or \.filter\(pred\)/);
  });

  it("wrong method on $$$.<coll> suggests .find / .filter via closestNameTo", () => {
    expect(() => jsmql("$.x = $$$.users.fnid(u => u._id === $._id);")).toThrow(
      /'\$\$\$\.<coll>' supports \.find\(pred\) and \.filter\(pred\), not \.fnid\(\)\. Did you mean '\.find'\?/,
    );
  });

  it("wrong arity: .find() with no arg is rejected", () => {
    expect(() => jsmql("$.x = $$$.users.find();")).toThrow(/\.find\(predicate\) takes exactly one argument/);
  });

  it("wrong arity: .filter(predicate, extra) is rejected", () => {
    expect(() => jsmql("$.x = $$$.users.filter(o => o.x === $.y, 0);")).toThrow(
      /\.filter\(predicate\) takes exactly one argument/,
    );
  });

  it("non-arrow predicate is rejected with an actionable message", () => {
    expect(() => jsmql("$.x = $$$.users.find(123);")).toThrow(/requires an arrow predicate/);
  });

  it("multi-param lambda is rejected (the foreign-doc is a single param)", () => {
    expect(() => jsmql("$.x = $$$.users.find((u, i) => u._id === $.userId);")).toThrow(
      /takes a single-parameter arrow \(the foreign document\), got 2/,
    );
  });

  it("Filter-mode rejection names Pipeline mode as the fix", () => {
    expect(() => jsmql.filter("$.x = $$$.users.find(u => u._id === $._id)")).toThrow(
      /jsmql\.filter\(\) does not allow lookup syntax.*joins are Pipeline-only/s,
    );
  });

  it("jsmql.update() pre-rejects lookup with a stage-whitelist hint", () => {
    expect(() => jsmql.update("$.x = $$$.users.find(u => u._id === $._id);")).toThrow(
      /jsmql\.update\(\) does not allow lookup syntax.*aggregation-pipeline update form only accepts/s,
    );
  });

  it("jsmql.expr() rejects lookup syntax", () => {
    expect(() => jsmql.expr("$$$.users.find(u => u._id === $._id)")).toThrow(
      /jsmql\.expr\(\) does not allow lookup syntax/,
    );
  });

  it("bare expression in jsmql() (no `;`) rejects with the requires-Pipeline message", () => {
    expect(() => jsmql("$$$.users.find(u => u._id === $._id)")).toThrow(/requires Pipeline mode/);
  });

  it("bare foreign param (`o` alone) inside a richer predicate is rejected", () => {
    // `o` alone would need $$ROOT semantics — out of scope for v1.
    expect(() => jsmql("$.users = $$$.users.filter(o => o);")).toThrow(
      /Bare lambda parameter 'o' in a \$lookup predicate is not yet supported/,
    );
  });

  it("nested lookup inside a block-body predicate is rejected with a clear message", () => {
    expect(() =>
      jsmql(`
        $.usersWithOrders = $$$.users.filter(u => {
          $match(u.active);
          $.orders = $$$.orders.filter(o => o.userId === u._id);
        });
      `),
    ).toThrow(/Nested lookup .* not yet supported in this release/);
  });

  it("nested lookup inside an expression-body predicate (e.g. && side) is rejected", () => {
    // Contrived but possible: an inner lookup expression used as a side of the outer predicate.
    // The outer predicate is hoisted to pipeline-form; the inner lookup is detected during
    // materialisation and rejected.
    expect(() =>
      jsmql(`
        $.x = $$$.users.find(u => u._id === ($$$.profiles.find(p => p.userId === u._id).id));
      `),
    ).toThrow(/Nested lookup/);
  });

  it(".pos points at the offending construct on errors", () => {
    const r = jsmql.validate("    $.x = $$$.users.find();");
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/exactly one argument/);
    expect(r.errors[0].pos).toBeGreaterThan(0);
  });
});

describe("$$$.coll.find/filter — interactions with other features", () => {
  it("intermixes cleanly with regular $set update ops in the same pipeline", () => {
    const out = jsmql(`
      $.a = 1;
      $.orders = $$$.orders.filter(o => o.userId === $._id);
      $.b = 2;
    `);
    expect(out).toEqual([
      { $set: { a: 1 } },
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "orders" } },
      { $set: { b: 2 } },
    ]);
  });

  it("validate() reports the lookup-rejection error with a usable .pos", () => {
    const r = jsmql.validate("$.x = $$$.users.fnid(u => u._id === $._id);");
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/Did you mean '\.find'/);
    expect(r.errors[0].pos).toBeGreaterThan(0);
  });
});

describe("$$$$.<db>.<coll>.find/filter — cross-database lookups", () => {
  // The cross-database surface uses MongoDB's `from: { db, coll }` shape —
  // accepted on Atlas Data Federation, rejected by community MongoDB. The
  // emitted MQL is the same for both; whether it works at runtime depends
  // on the deployment. Same predicate-dispatch and chained-terminal rules
  // as the same-database `$$$.<coll>` surface.

  it("dot.dot form: $$$$.<db>.<coll>.filter emits `from: { db, coll }`", () => {
    expect(jsmql("$.orders = $$$$.analytics.orders.filter(o => o.userId === $._id);")).toEqual([
      {
        $lookup: { from: { db: "analytics", coll: "orders" }, localField: "_id", foreignField: "userId", as: "orders" },
      },
    ]);
  });

  it("dot.dot form: .find adds the $set $first follow-up", () => {
    expect(jsmql("$.user = $$$$.analytics.users.find(u => u._id === $.userId);")).toEqual([
      { $lookup: { from: { db: "analytics", coll: "users" }, localField: "userId", foreignField: "_id", as: "user" } },
      { $set: { user: { $first: "$user" } } },
    ]);
  });

  it("bracket.bracket form: $$$$['db']['coll']", () => {
    expect(jsmql(`$.orders = $$$$["analytics"]["orders"].filter(o => o.userId === $._id);`)).toEqual([
      {
        $lookup: { from: { db: "analytics", coll: "orders" }, localField: "_id", foreignField: "userId", as: "orders" },
      },
    ]);
  });

  it("dot.bracket form: $$$$.db['coll']", () => {
    expect(jsmql(`$.orders = $$$$.analytics["orders"].filter(o => o.userId === $._id);`)).toEqual([
      {
        $lookup: { from: { db: "analytics", coll: "orders" }, localField: "_id", foreignField: "userId", as: "orders" },
      },
    ]);
  });

  it("bracket.dot form: $$$$['db'].coll", () => {
    expect(jsmql(`$.orders = $$$$["analytics"].orders.filter(o => o.userId === $._id);`)).toEqual([
      {
        $lookup: { from: { db: "analytics", coll: "orders" }, localField: "_id", foreignField: "userId", as: "orders" },
      },
    ]);
  });

  it("compound predicate falls through to pipeline form with auto-let extraction", () => {
    const out = jsmql("$.user = $$$$.analytics.users.find(u => u._id === $.userId && u.active);");
    const lookup = ((out as object[])[0] as { $lookup: { from: object; let: object } }).$lookup;
    expect(lookup.from).toEqual({ db: "analytics", coll: "users" });
    expect(lookup.let).toEqual({ userId: "$userId" });
  });

  it("block-body lambdas work the same as `$$$.<coll>`", () => {
    const out = jsmql(`
      $.recent = $$$$.analytics.orders.filter(o => {
        $match(o.userId === $._id);
        $sort({ createdAt: -1 });
        $limit(5);
      });
    `);
    expect(out).toEqual([
      {
        $lookup: {
          from: { db: "analytics", coll: "orders" },
          let: { _id: "$_id" },
          pipeline: [{ $match: { $expr: { $eq: ["$userId", "$$_id"] } } }, { $sort: { createdAt: -1 } }, { $limit: 5 }],
          as: "recent",
        },
      },
    ]);
  });

  it("chained .length on .filter works against a cross-DB lookup", () => {
    const out = jsmql("let n = $$$$.analytics.orders.filter(o => o.userId === $._id).length;");
    expect(out).toEqual([
      {
        $lookup: {
          from: { db: "analytics", coll: "orders" },
          localField: "_id",
          foreignField: "userId",
          as: "__jsmql.__lookup1",
        },
      },
      { $set: { "__jsmql.__lookup1": { $size: "$__jsmql.__lookup1" } } },
      { $set: { "__jsmql.n": "$__jsmql.__lookup1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("chained .reduce on .filter folds over the cross-DB result", () => {
    const out = jsmql(
      "let total = $$$$.bank.tx.filter(t => t.userId === $._id).reduce((acc, t) => acc + t.amount, 0);",
    );
    const lookup = ((out as object[])[0] as { $lookup: { from: object } }).$lookup;
    expect(lookup.from).toEqual({ db: "bank", coll: "tx" });
  });

  it("member access on a cross-DB .find result", () => {
    const out = jsmql("let name = $$$$.analytics.users.find(u => u._id === $.userId).name;");
    expect(out).toEqual([
      {
        $lookup: {
          from: { db: "analytics", coll: "users" },
          localField: "userId",
          foreignField: "_id",
          as: "__jsmql.__lookup1",
        },
      },
      { $set: { "__jsmql.__lookup1": { $first: "$__jsmql.__lookup1" } } },
      { $set: { "__jsmql.name": "$__jsmql.__lookup1.name" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("wrong method on $$$$.<db>.<coll> uses the cluster spelling in the error", () => {
    expect(() => jsmql("$.x = $$$$.analytics.users.fnid(u => u._id === $._id);")).toThrow(
      /'\$\$\$\$\.<db>\.<coll>' supports \.find\(pred\) and \.filter\(pred\), not \.fnid\(\)\. Did you mean '\.find'\?/,
    );
  });

  it(".find().length on a cross-DB lookup is rejected (same rule as $$$)", () => {
    expect(() => jsmql("let n = $$$$.analytics.users.find(u => u._id === $._id).length;")).toThrow(
      /\.length on a \.find\(\) result is not meaningful/,
    );
  });

  it("Filter-mode rejection uses the generic lookup message (covers both $$$ and $$$$)", () => {
    expect(() => jsmql.filter("$.x = $$$$.analytics.users.find(u => u._id === $._id)")).toThrow(
      /jsmql\.filter\(\) does not allow lookup syntax/,
    );
  });

  it("intermixes $$$ and $$$$ lookups in one pipeline", () => {
    const out = jsmql(`
      $.orders = $$$.orders.filter(o => o.userId === $._id);
      $.archivedOrders = $$$$.cold_storage.orders.filter(o => o.userId === $._id);
    `);
    expect(out).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "orders" } },
      {
        $lookup: {
          from: { db: "cold_storage", coll: "orders" },
          localField: "_id",
          foreignField: "userId",
          as: "archivedOrders",
        },
      },
    ]);
  });

  it("dynamic db / coll names (non-static bracket index) are rejected as bare $$$$", () => {
    // `$$$$[someParam].coll` — non-static db name. extractLookupTarget bails,
    // detectLookupCall returns null, codegen reaches the ClusterRef leaf and
    // throws the bare-reference error. Same behaviour as `$$$[someParam]`.
    expect(() =>
      jsmql.compile(({ dbName }, $) => ($.x = $$$$[dbName].users.find((u) => u._id === $._id)))({ dbName: "x" }),
    ).toThrow(/'\$\$\$\$\.<db>\.<coll>'/);
  });
});
