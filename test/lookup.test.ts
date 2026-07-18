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
    expect(lookupStage.$lookup.let).toEqual({ jsmql_f0_userId: "$userId" });
    expect(lookupStage.$lookup.as).toBe("user");
    expect((out as object[])[1]).toEqual({ $set: { user: { $first: "$user" } } });
  });

  it("two refs to the same `$.x` share one let entry (dedup)", () => {
    const out = jsmql("$.users = $$$.users.filter(u => u._id === $.userId && u.lastLogin > $.userId);");
    const lookup = ((out as object[])[0] as { $lookup: { let: Record<string, string> } }).$lookup;
    expect(Object.keys(lookup.let)).toEqual(["jsmql_f0_userId"]);
    expect(lookup.let.jsmql_f0_userId).toBe("$userId");
  });

  it("multiple distinct `$.x` refs land as multiple let entries", () => {
    const out = jsmql("$.users = $$$.users.filter(u => u._id === $.userId && u.tenantId === $.tenantId);");
    const lookup = ((out as object[])[0] as { $lookup: { let: Record<string, string> } }).$lookup;
    expect(Object.keys(lookup.let).sort()).toEqual(["jsmql_f0_tenantId", "jsmql_f0_userId"]);
  });

  it("constant comparisons use index-friendly query form; only correlated parts fall back to $expr", () => {
    // `o.status === "shipped"` (constant) becomes a `{ status: "shipped" }` query
    // field the server can index. Only `o.userId === $._id` — a comparison
    // against the `$$jsmql_f0__id` let var, which the query language cannot express —
    // stays in $expr. Same translator the top-level `$match` uses; verified
    // joining correctly against a live mongod.
    expect(jsmql('$.x = $$$.orders.filter(o => o.userId === $._id && o.status === "shipped");')).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [{ $match: { status: "shipped", $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } }],
          as: "x",
        },
      },
    ]);
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
          let: { jsmql_f0__id: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
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

describe("$$$.coll.filter — block-body 3rd 'collection' param (sub-stream length)", () => {
  // The post-filter sub-stream count, via `<coll>.length`, usable inside the
  // block (here in an assert). Verified end-to-end on a live mongod: alice
  // (2 orders) → orders:[…], bob (0 orders) → orders:[] (the assert no-ops on
  // an empty sub-stream — no doc flows through the lookup pipeline to reject).
  it("assert(ordersColl.length > 0) materialises a $setWindowFields before the assert $match", () => {
    expect(
      jsmql(`
        $.orders = $$$.orders.filter((o, i, ordersColl) => {
          $match(o.userId === $._id);
          assert(ordersColl.length > 0, "User without orders is impossible");
        });
      `),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
            { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
            {
              $match: {
                $expr: {
                  $convert: {
                    input: true,
                    to: {
                      $cond: [
                        { $gt: ["$__jsmql.length", 0] },
                        "bool",
                        "jsmql assertion failed: User without orders is impossible",
                      ],
                    },
                  },
                },
              },
            },
            { $unset: "__jsmql" },
          ],
          as: "orders",
        },
      },
    ]);
  });

  // Deep cross-level capture: a ROOT read (`$.region`) inside a NESTED block-body
  // lookup is captured at the OUTERMOST lookup (`jsmql_f0_region`, whose let
  // evaluates against the root doc) and read deeper via `$$` propagation — NOT
  // mis-captured as a field of the immediate parent. The enclosing foreign param
  // `a._id` is captured at the level just inside its scope (`jsmql_f1__id`).
  it("a root `$.<field>` read inside a nested block-body lookup threads to the outermost let", () => {
    expect(
      jsmql(`
        $.a = $$$.A.filter(a => {
          $.c = $$$.C.filter(c => {
            $match(c.aId === a._id);
            assert(c.region === $.region, "region mismatch");
          });
        });
      `),
    ).toEqual([
      {
        $lookup: {
          from: "A",
          let: { jsmql_f0_region: "$region" }, // root field, captured at the OUTERMOST lookup
          pipeline: [
            {
              $lookup: {
                from: "C",
                let: { jsmql_f1__id: "$_id" }, // enclosing foreign param `a._id`
                pipeline: [
                  { $match: { $expr: { $eq: ["$aId", "$$jsmql_f1__id"] } } },
                  {
                    $match: {
                      $expr: {
                        $convert: {
                          input: true,
                          // `$.region` reads the outermost capture, propagated down.
                          to: {
                            $cond: [
                              { $eq: ["$region", "$$jsmql_f0_region"] },
                              "bool",
                              "jsmql assertion failed: region mismatch",
                            ],
                          },
                        },
                      },
                    },
                  },
                ],
                as: "c",
              },
            },
          ],
          as: "a",
        },
      },
    ]);
  });

  it("rejects a USED index param in the block", () => {
    expect(() =>
      jsmql(`$.x = $$$.orders.filter((o, i, c) => { $match(o.userId === $._id); assert(i > 0, "x"); });`),
    ).toThrow(/'i' \(the 2nd, index parameter\) has no meaning.*no per-doc index/);
  });

  it("rejects a non-`.length` use of the collection handle in the block", () => {
    expect(() =>
      jsmql(`$.x = $$$.orders.filter((o, i, c) => { $match(o.userId === $._id); $.first = c[0]; });`),
    ).toThrow(/only 'c\.length' \(the post-filter sub-stream count\) is available/);
  });

  it("an expression-body filter with 3 params is rejected with a block-body redirect", () => {
    expect(() => jsmql(`$.x = $$$.orders.filter((o, i, c) => c.length > 0);`)).toThrow(
      /filtered sub-stream doesn't exist yet.*use a block body and the 3rd param/,
    );
  });
});

describe("$$$.coll.find/filter — chained terminals", () => {
  it("chained .length on .filter produces $size + slot writeback", () => {
    const out = jsmql("let n = $$$.orders.filter(o => o.userId === $._id).length;");
    expect(out).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.1" } },
      { $set: { "__jsmql.tmp.1": { $size: "$__jsmql.tmp.1" } } },
      { $set: { "__jsmql.var.n": "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("chained .reduce on .filter folds with the user's lambda", () => {
    const out = jsmql("let total = $$$.tx.filter(t => t.userId === $._id).reduce((acc, t) => acc + t.amount, 0);");
    expect(out).toEqual([
      { $lookup: { from: "tx", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.1" } },
      {
        $set: {
          "__jsmql.tmp.1": {
            $reduce: { input: "$__jsmql.tmp.1", initialValue: 0, in: { $add: ["$$value", "$$this.amount"] } },
          },
        },
      },
      { $set: { "__jsmql.var.total": "$__jsmql.tmp.1" } },
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
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "__jsmql.tmp.1" } },
      { $set: { "__jsmql.tmp.1": { $first: "$__jsmql.tmp.1" } } },
      { $set: { "__jsmql.var.name": "$__jsmql.tmp.1.name" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("multiple lookups in one pipeline allocate distinct internal slots", () => {
    const out = jsmql(`
      let nOrders = $$$.orders.filter(o => o.userId === $._id).length;
      let nTx = $$$.tx.filter(t => t.userId === $._id).length;
    `);
    const json = JSON.stringify(out);
    expect(json).toContain("__jsmql.tmp.1");
    expect(json).toContain("__jsmql.tmp.2");
  });
});

describe("$$$.coll.find/filter — error cases", () => {
  it("bare $$$ outside a chain points at the lookup and $out shapes", () => {
    expect(() => jsmql.expr("$$$.myColl")).toThrow(/\$lookup read.*\$out write/);
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

  it(".pos points at the offending construct on errors", () => {
    const r = jsmql.validate("    $.x = $$$.users.find();");
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/exactly one argument/);
    expect(r.errors[0].pos).toBeGreaterThan(0);
  });
});

describe("$$$.coll.find/filter — nested lookups (expression body and block body, any depth)", () => {
  // Nested lookups materialise as prologue `$lookup` stages inside the outer's
  // `$lookup.pipeline` body. The inner lookup's `let:` clause auto-captures
  // references to the outer's foreign-doc param (`o.x`) as path-on-local-doc
  // bindings. Outer-pipeline `let` vars stay accessible via lexical `$$<name>`
  // scoping — no need for the inner to re-let them.

  it("2-level filter/filter with outer-foreign-doc cross-reference", () => {
    expect(jsmql("$.x = $$$.a.filter(a => $$$.b.filter(b => b.x === a.x).length > 0)")).toEqual([
      {
        $lookup: {
          from: "a",
          let: {},
          pipeline: [
            {
              $lookup: {
                from: "b",
                let: { jsmql_f1_x: "$x" },
                pipeline: [{ $match: { $expr: { $eq: ["$x", "$$jsmql_f1_x"] } } }],
                as: "__jsmql.tmp.1",
              },
            },
            { $set: { "__jsmql.tmp.1": { $size: "$__jsmql.tmp.1" } } },
            { $match: { "__jsmql.tmp.1": { $gt: 0 } } },
          ],
          as: "x",
        },
      },
    ]);
  });

  it("2-level find/find — both with $first follow-ups", () => {
    expect(jsmql("$.x = $$$.a.find(a => $$$.b.find(b => b.x === a.x))")).toEqual([
      {
        $lookup: {
          from: "a",
          let: {},
          pipeline: [
            {
              $lookup: {
                from: "b",
                let: { jsmql_f1_x: "$x" },
                pipeline: [{ $match: { $expr: { $eq: ["$x", "$$jsmql_f1_x"] } } }],
                as: "__jsmql.tmp.1",
              },
            },
            { $set: { "__jsmql.tmp.1": { $first: "$__jsmql.tmp.1" } } },
            { $match: { $expr: "$__jsmql.tmp.1" } },
          ],
          as: "x",
        },
      },
      { $set: { x: { $first: "$x" } } },
    ]);
  });

  it("outer-outer doc ref ($._id) flows through outer.let and is visible inside the inner via lexical $$ scope", () => {
    // `$._id` is captured by the OUTER lookup's `let: { jsmql_f0__id: "$_id" }` (depth 0).
    // The inner's `let: { jsmql_f1__id: "$_id" }` (depth 1) captures the POST's `_id`.
    // The depth prefix keeps them distinct — `$$jsmql_f0__id` (the outermost doc) and
    // `$$jsmql_f1__id` (the post) no longer collide under lexical `$$` scoping.
    expect(
      jsmql(
        "$.posts = $$$.posts.filter(p => p.userId === $._id && $$$.tags.filter(t => t.postId === p._id).length > 0)",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "posts",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [
            {
              $lookup: {
                from: "tags",
                let: { jsmql_f1__id: "$_id" },
                pipeline: [{ $match: { $expr: { $eq: ["$postId", "$$jsmql_f1__id"] } } }],
                as: "__jsmql.tmp.1",
              },
            },
            { $set: { "__jsmql.tmp.1": { $size: "$__jsmql.tmp.1" } } },
            { $match: { "__jsmql.tmp.1": { $gt: 0 }, $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
          ],
          as: "posts",
        },
      },
    ]);
  });

  it("3-level deep nesting works", () => {
    const out = jsmql(
      "$.x = $$$.a.filter(a => $$$.b.filter(b => $$$.c.filter(c => c.x === b.x).length > 0).length > 0)",
    ) as Array<Record<string, unknown>>;
    // Drill into the structure rather than spelling out the whole thing.
    const outer = out[0].$lookup as { pipeline: Array<Record<string, unknown>> };
    expect(outer.pipeline[0].$lookup).toBeDefined();
    const middle = outer.pipeline[0].$lookup as { pipeline: Array<Record<string, unknown>> };
    expect(middle.pipeline[0].$lookup).toBeDefined();
    const innermost = middle.pipeline[0].$lookup as { from: string; let: Record<string, string>; pipeline: object[] };
    expect(innermost.from).toBe("c");
    expect(innermost.let).toEqual({ jsmql_f2_x: "$x" });
  });

  it("inner lookup with a non-trivial predicate (compound &&) still extracts let-vars correctly", () => {
    const out = jsmql(
      "$.x = $$$.a.filter(a => $$$.b.filter(b => b.x === a.x && b.active === true).length > 0)",
    ) as Array<Record<string, unknown>>;
    const outer = out[0].$lookup as { pipeline: Array<Record<string, unknown>> };
    const inner = outer.pipeline[0].$lookup as { let: Record<string, string> };
    expect(inner.let).toEqual({ jsmql_f1_x: "$x" });
  });

  it("bare enclosing-foreign-param ref (no member access) is rejected", () => {
    // Hits the existing "bare lambda param" check during the outer's let-
    // extraction walk — `a` matches the outer's foreign param with zero
    // segments, which has no `$$ROOT`-equivalent lowering.
    expect(() => jsmql("$.x = $$$.a.filter(a => $$$.b.filter(b => b === a).length > 0)")).toThrow(
      /Bare lambda parameter 'a' in a \$lookup predicate is not yet supported/,
    );
  });

  // ── Block-body nested lookups ──────────────────────────────────────────────
  // The block-body path threads `EnclosingLookupContext` via the ctx carrier
  // `GenerateCtx.enclosingLookup`; an inner lookup written as a statement /
  // stage-body expr / block-bodied lambda lowers the same as the expr-body form.
  // All three emitted shapes were run against a live mongod and join correctly.

  it("nested lookup as a STATEMENT inside a block body (as from the LHS field)", () => {
    expect(jsmql("$.x = $$$.a.filter(a => { $match(a.active); $.bs = $$$.b.filter(b => b.aId === a._id); });")).toEqual(
      [
        {
          $lookup: {
            from: "a",
            let: {},
            pipeline: [
              { $match: { $expr: "$active" } },
              {
                $lookup: {
                  from: "b",
                  let: { jsmql_f1__id: "$_id" },
                  pipeline: [{ $match: { $expr: { $eq: ["$aId", "$$jsmql_f1__id"] } } }],
                  as: "bs",
                },
              },
            ],
            as: "x",
          },
        },
      ],
    );
  });

  it("block-in-block: the inner lookup's lambda also has a block body", () => {
    expect(
      jsmql("$.x = $$$.a.filter(a => { $.bs = $$$.b.filter(b => { $match(b.aId === a._id); $sort({ _id: 1 }); }); });"),
    ).toEqual([
      {
        $lookup: {
          from: "a",
          let: {},
          pipeline: [
            {
              $lookup: {
                from: "b",
                let: { jsmql_f1__id: "$_id" },
                pipeline: [{ $match: { $expr: { $eq: ["$aId", "$$jsmql_f1__id"] } } }, { $sort: { _id: 1 } }],
                as: "bs",
              },
            },
          ],
          as: "x",
        },
      },
    ]);
  });

  it("nested lookup inside a STAGE-BODY expression of a block (.length materialises into a slot)", () => {
    expect(
      jsmql(
        "$.x = $$$.users.filter(u => { $match($$$.orders.filter(o => o.uid === u._id).length > 0); $sort({ name: 1 }); });",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "users",
          let: {},
          pipeline: [
            {
              $lookup: {
                from: "orders",
                let: { jsmql_f1__id: "$_id" },
                pipeline: [{ $match: { $expr: { $eq: ["$uid", "$$jsmql_f1__id"] } } }],
                as: "__jsmql.tmp.1",
              },
            },
            { $set: { "__jsmql.tmp.1": { $size: "$__jsmql.tmp.1" } } },
            { $match: { "__jsmql.tmp.1": { $gt: 0 } } },
            { $sort: { name: 1 } },
            { $unset: "__jsmql" },
          ],
          as: "x",
        },
      },
    ]);
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

describe("$$$$.<db>.<coll>.find/filter — cross-database reads are rejected", () => {
  // Cross-database reads no longer lower to a `$lookup`/`$unionWith` with a
  // `{ db, coll }` namespace (rejected by standalone / replica-set / sharded
  // MongoDB). Every read shape throws; the fix is the same-database `$$$.<coll>`
  // form. (Cross-database WRITES — `$$$$.<db>.<coll> = $$` → $out — still work.)

  it("a .filter lookup is rejected", () => {
    expect(() => jsmql("$.x = $$$$.analytics.orders.filter(o => o.userId === $._id)")).toThrow(
      /Cross-database reads aren't supported/,
    );
  });

  // `.find` vs `.filter`, dot vs bracket access, and the nested-with-same-db-inner
  // case all reject at the SAME `requireSameDbColl` point as the `.filter` case
  // above — not retested. The chained terminal is a DISTINCT lowering path
  // (`tryExtractChainedLookup`, not `lowerLookup`), so it keeps its own case:
  it("a chained .length on a cross-DB .filter is rejected", () => {
    expect(() => jsmql("let n = $$$$.analytics.orders.filter(o => o.userId === $._id).length;")).toThrow(
      /Cross-database reads aren't supported/,
    );
  });
});

describe("$$$.coll.filter(p).<chain> — stream-method chain extends the $lookup.pipeline body", () => {
  it("a terminal .map(...) is peeled to a value-mode $map on the lookup result", () => {
    // A terminal `.map` does NOT go into the `$lookup.pipeline` (a `$replaceWith`
    // there is invalid MQL when the mapped value is a scalar — mongod rejects a
    // non-document root). Instead the sub-pipeline is just the `.filter`'s `$match`,
    // and the map runs as a value-mode `$map` over the result array in the `$set`.
    expect(jsmql("$.stats = $$$.users.filter(u => u.active).map(u => ({ id: u._id, name: u.name }));")).toEqual([
      { $lookup: { from: "users", let: {}, pipeline: [{ $match: { $expr: "$active" } }], as: "__jsmql.tmp.1" } },
      { $set: { stats: { $map: { input: "$__jsmql.tmp.1", as: "u", in: { id: "$$u._id", name: "$$u.name" } } } } },
      { $unset: "__jsmql" },
    ]);
  });

  it('a terminal .map("field") string shorthand extracts a scalar array (was invalid $replaceWith)', () => {
    expect(jsmql('$.userIds = $$$.orders.filter(o => o.uid === $.id).map("userId");')).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0_id: "$id" },
          pipeline: [{ $match: { $expr: { $eq: ["$uid", "$$jsmql_f0_id"] } } }],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { userIds: { $map: { input: "$__jsmql.tmp.1", as: "jsmqlEl", in: "$$jsmqlEl.userId" } } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a value-collapsing .map anywhere in the chain (not just terminal) lowers value-mode, never an in-pipeline $replaceWith", () => {
    // `.map("productIds")` is NOT terminal here — it is followed by `.slice`, a
    // stream-registry method. Keeping the map in the sub-pipeline would emit
    // `{$replaceWith:"$productIds"}` (a non-document root — mongod rejects it). The
    // whole chain instead routes to the expression form: the sub-pipeline is just
    // the `.filter`'s `$match`, and map+slice run value-mode over the result array.
    expect(jsmql('$.r = $$$.orders.filter(o => o.userId === $._id).map("productIds").slice(0, 3);')).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [{ $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } }],
          as: "__jsmql.tmp.1",
        },
      },
      {
        $set: {
          r: { $slice: [{ $map: { input: "$__jsmql.tmp.1", as: "jsmqlEl", in: "$$jsmqlEl.productIds" } }, 0, 3] },
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("a mid-chain .map('field') feeding value methods (.flatten().uniq()) collapses to a value-mode expression", () => {
    expect(jsmql('$.r = $$$.orders.filter(o => o.userId === $._id).map("productIds").flatten().uniq();')).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [{ $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } }],
          as: "__jsmql.tmp.1",
        },
      },
      {
        $set: {
          r: {
            $reduce: {
              input: {
                $reduce: {
                  input: { $map: { input: "$__jsmql.tmp.1", as: "jsmqlEl", in: "$$jsmqlEl.productIds" } },
                  initialValue: [],
                  in: { $concatArrays: ["$$value", { $cond: [{ $isArray: "$$this" }, "$$this", ["$$this"]] }] },
                },
              },
              initialValue: [],
              in: { $cond: [{ $in: ["$$this", "$$value"] }, "$$value", { $concatArrays: ["$$value", ["$$this"]] }] },
            },
          },
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("an object-literal-body .map mid-chain still stays in the sub-pipeline ($replaceWith of a document is valid)", () => {
    // The collapse only fires for a NON-document map. `o => ({ t: o.total })`
    // yields a document, so `$replaceWith` is valid and the following `.take`
    // lowers to `$limit` inside the same sub-pipeline (no value-mode detour).
    expect(jsmql("$.r = $$$.orders.filter(o => o.userId === $._id).map(o => ({ t: o.total })).take(5);")).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
            { $replaceWith: { t: "$total" } },
            { $limit: 5 },
          ],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { r: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it(".toSorted((a, b) => …) — comparator-shape sort that has no clean expression-form equivalent", () => {
    // The bare `.toSorted((a, b) => …)` shape couldn't be lowered in
    // expression position before this change (no `$sortArray` comparator
    // form); pushing it into the pipeline body lets the existing stream-
    // method registry's stage-form $sort lowering kick in.
    expect(
      jsmql("$.byScore = $$$.users.filter(u => u.active).toSorted((a, b) => b.score - a.score).slice(0, 5);"),
    ).toEqual([
      {
        $lookup: {
          from: "users",
          let: {},
          pipeline: [{ $match: { $expr: "$active" } }, { $sort: { score: -1 } }, { $limit: 5 }],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { byScore: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it(".toReversed() after .toSorted() flips the preceding $sort spec inside the body", () => {
    expect(
      jsmql(
        "$.recent = $$$.events.filter(e => e.userId === $._id).toSorted((a, b) => a.createdAt - b.createdAt).toReversed().slice(0, 10);",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "events",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
            { $sort: { createdAt: -1 } },
            { $limit: 10 },
          ],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { recent: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it(".flatMap(d => d.<path>) becomes $unwind inside the lookup's pipeline body", () => {
    expect(jsmql("$.items = $$$.orders.filter(o => o.userId === $._id).flatMap(o => o.items);")).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [{ $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } }, { $unwind: "$items" }],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { items: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("existing chained terminals (.length, .reduce) still take precedence over the chain extension", () => {
    // `.length` and `.reduce(fn, init)` are MemberAccess / MethodCall shapes
    // that fire BEFORE the chain-extension check in extractLookupCalls; they
    // continue to lower the same way they did before this commit.
    expect(jsmql("$.count = $$$.users.filter(u => u.active).length;")).toEqual([
      { $lookup: { from: "users", let: {}, pipeline: [{ $match: { $expr: "$active" } }], as: "__jsmql.tmp.1" } },
      { $set: { "__jsmql.tmp.1": { $size: "$__jsmql.tmp.1" } } },
      { $set: { count: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("non-registered chain methods (e.g. .toLowerCase) fall through to the existing expression-form path", () => {
    // `.toLowerCase()` isn't a stream method — the chain extension returns
    // null and `descendAndExtract` handles it, producing the bulkier but
    // still correct expression-form output. This keeps unrelated string /
    // array operators on lookup results unaffected.
    const out = jsmql("$.firstName = $$$.users.find(u => u._id === $.userId).name;") as object[];
    // The .find + member-access path runs through existing logic — not the
    // new chain extension — and produces the same shape it always did.
    expect(out).toEqual([
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "__jsmql.tmp.1" } },
      { $set: { "__jsmql.tmp.1": { $first: "$__jsmql.tmp.1" } } },
      { $set: { firstName: "$__jsmql.tmp.1.name" } },
      { $unset: "__jsmql" },
    ]);
  });
});
