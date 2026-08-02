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

  it("top-level bracket-accessed local field yields a clean localField (no leading dot)", () => {
    // `$["ext-code"]` is bracket access on the bare root `$`. The root is an
    // empty-path FieldRef and must contribute NO path segment — otherwise the
    // localField comes out as `.ext-code` (leading dot), which mongod rejects
    // (Location15998). Verified against a live mongod.
    expect(jsmql(`$.x = $$$.orders.filter(o => o.ref === $["ext-code"]);`)).toEqual([
      { $lookup: { from: "orders", localField: "ext-code", foreignField: "ref", as: "x" } },
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

  it("an outer field with a char illegal in a MongoDB var name yields an identifier-safe let var", () => {
    // `meta.sub-id` — the hyphen is legal in a field NAME but illegal in a `$$`
    // VARIABLE name, so the raw segment can't become the let-var name verbatim
    // (mongod: "contains an invalid character for a variable name: '-'"). The
    // last path segment is sanitized to `[A-Za-z0-9_]` for the name only; the
    // value keeps the raw field path. Verified against a live mongod (HR3).
    expect(jsmql('$.x = $$$.orders.filter(o => o.ref === $.meta["sub-id"] && o.qty > 0);')).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0_sub_id: "$meta.sub-id" },
          pipeline: [{ $match: { qty: { $gt: 0 }, $expr: { $eq: ["$ref", "$$jsmql_f0_sub_id"] } } }],
          as: "x",
        },
      },
    ]);
  });

  it("two distinct fields that sanitize to the same var base stay distinct (`_2` suffix)", () => {
    // `sub-id` and `sub_id` are different fields but both sanitize to the base
    // `jsmql_f0_sub_id`. The allocator interns on the RAW path and disambiguates
    // with `_2`, so each field keeps its own correlation var.
    expect(jsmql('$.x = $$$.orders.filter(o => o.a === $.meta["sub-id"] && o.b === $.meta["sub_id"]);')).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0_sub_id: "$meta.sub-id", jsmql_f0_sub_id_2: "$meta.sub_id" },
          pipeline: [
            {
              $match: {
                $expr: { $and: [{ $eq: ["$a", "$$jsmql_f0_sub_id"] }, { $eq: ["$b", "$$jsmql_f0_sub_id_2"] }] },
              },
            },
          ],
          as: "x",
        },
      },
    ]);
  });

  it("top-level bracket-accessed local field hoists into `let` cleanly (no leading dot in value or var)", () => {
    // The pipeline-form counterpart of the basic-form leading-dot case: `$["ext-code"]`
    // must hoist to the `let` VALUE `$ext-code` (not `$.ext-code`) and the var name
    // `jsmql_f0_ext_code`. Verified against a live mongod.
    expect(jsmql('$.x = $$$.orders.filter(o => o.userId === $._id && $["ext-code"] === "K1");')).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id", jsmql_f0_ext_code: "$ext-code" },
          pipeline: [
            {
              $match: {
                $expr: { $and: [{ $eq: ["$userId", "$$jsmql_f0__id"] }, { $eq: ["$$jsmql_f0_ext_code", "K1"] }] },
              },
            },
          ],
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

  it("wrong method on $$$.<coll> suggests .find / .filter / .aggregate via closestNameTo", () => {
    expect(() => jsmql("$.x = $$$.users.fnid(u => u._id === $._id);")).toThrow(
      /'\$\$\$\.<coll>' supports \.find\(pred\), \.filter\(pred\), \.aggregate\(pipeline\), and the lodash stream methods .* not \.fnid\(\)\. Did you mean '\.find'\?/,
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

  it("bare `$` (whole outer document) as a correlation value is rejected with guidance", () => {
    // The local-side mirror of the bare-foreign-param rejection: `$` alone is the
    // whole outer doc, not a field path. Previously it emitted an invalid empty
    // field path (`localField: ""` / a `let` value of `"$"`) that mongod rejects.
    expect(() => jsmql("$.x = $$$.orders.filter(o => o.ref === $);")).toThrow(
      /Bare '\$' \(the whole outer document\) can't be used as a value in a \$lookup predicate/,
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
      { $lookup: { from: "users", pipeline: [{ $match: { $expr: "$active" } }], as: "__jsmql.tmp.1" } },
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
        $set: { r: { $slice: [{ $map: { input: "$__jsmql.tmp.1", as: "jsmqlEl", in: "$$jsmqlEl.productIds" } }, 3] } },
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
          pipeline: [{ $match: { $expr: "$active" } }, { $sort: { score: -1 } }, { $limit: 5 }],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { byScore: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a descending sub-pipeline sort is written directly (no reverse-the-previous-sort form)", () => {
    // `.toReversed()` was removed from streams — the descending comparator is the
    // spelling, and it always produced the same single `$sort` anyway.
    expect(
      jsmql(
        "$.recent = $$$.events.filter(e => e.userId === $._id).toSorted((a, b) => b.createdAt - a.createdAt).slice(0, 10);",
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
      { $lookup: { from: "users", pipeline: [{ $match: { $expr: "$active" } }], as: "__jsmql.tmp.1" } },
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

describe("$$$.coll.<streamMethod>… — any lodash stream method may start the chain", () => {
  // Verified end-to-end on a live mongod (chain-order + correlation) in tmp/verify-lookup.ts.
  it("single stream-method head → lean $lookup (no let, no vacuous $match)", () => {
    expect(jsmql("$.recent = $$$.orders.toSorted({ createdAt: -1 });")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $sort: { createdAt: -1 } }], as: "__jsmql.tmp.1" } },
      { $set: { recent: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("stream head + chain ending in .filter — chain ORDER preserved ([$sort,$limit,$match], not filter-first)", () => {
    expect(jsmql("$.recent = $$$.orders.toSorted({ createdAt: -1 }).take(200).filter(o => o.qty > 1);")).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 200 }, { $match: { qty: { $gt: 1 } } }],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { recent: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("stream head + a CORRELATED trailing .filter hoists $.<field> into $lookup.let", () => {
    expect(
      jsmql(
        "$.recent = $$$.orders.toSorted({ createdAt: -1 }).take(200).filter(o => o.userId === $._id && o.qty > 1);",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [
            { $sort: { createdAt: -1 } },
            { $limit: 200 },
            { $match: { qty: { $gt: 1 }, $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
          ],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { recent: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a .filter anywhere in the chain (not just head) becomes a $match — double filter collapses to two $match", () => {
    expect(jsmql('$.paid = $$$.orders.filter(o => o.qty > 1).filter(o => o.status === "paid");')).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [{ $match: { qty: { $gt: 1 } } }, { $match: { status: "paid" } }],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { paid: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it(".reject head negates the predicate into a sub-pipeline $match", () => {
    expect(jsmql("$.kept = $$$.orders.reject(o => o.cancelled).take(5);")).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [
            {
              $match: {
                $expr: {
                  $not: {
                    $and: [
                      { $ne: [{ $ifNull: ["$cancelled", null] }, null] },
                      { $ne: ["$cancelled", false] },
                      { $ne: ["$cancelled", ""] },
                      { $ne: ["$cancelled", 0] },
                    ],
                  },
                },
              },
            },
            { $limit: 5 },
          ],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { kept: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a single stream-method head still rejects an unknown method with a didYouMean suggestion", () => {
    expect(() => jsmql("$.x = $$$.orders.toSrted({ createdAt: -1 });")).toThrow(
      /not \.toSrted\(\)\. Did you mean '\.toSorted'\?/,
    );
  });

  it("a cross-database stream-method head is still rejected at requireSameDbColl", () => {
    expect(() => jsmql("$.x = $$$$.other.orders.toSorted({ x: -1 });")).toThrow(
      /Cross-database reads aren't supported/,
    );
  });
});

describe("$$$.coll stream chains — HR3 / consistency guards (from adversarial review)", () => {
  // Each of these emitted invalid or wrong MQL before the generic-head change fixed them;
  // verified against a live mongod. See docs/DEVLOG.md.
  it("a lone shorthand .filter({obj}) head lowers exactly like the equivalent arrow", () => {
    // The shorthand is desugared to its arrow at DETECTION (`filterArgToLambda` in
    // detectLookupCall), so it takes the same direct-lookup path — including the
    // `as: "x"` write straight to the destination field (no tmp slot, no trailing
    // `$set`/`$unset`) that the arrow form has always had.
    expect(jsmql("$.x = $$$.orders.filter({ uid: 1 });")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { uid: 1 } }], as: "x" } },
    ]);
    expect(jsmql("$.x = $$$.orders.filter({ uid: 1 });")).toEqual(jsmql("$.x = $$$.orders.filter(o => o.uid === 1);"));
  });

  // Spelling must never change the emitted MQL. Before the detection-time
  // normalisation, a shorthand predicate skipped `detectLookupCall` entirely and
  // fell through to the chain assembler, which ALWAYS builds the correlated
  // pipeline form — so `.filter({ userId: $._id })` silently lost the indexed
  // `localField`/`foreignField` `$lookup` its arrow twin got, and `.length` on it
  // lost the `$size` materialisation for an `$isArray`-guarded `$strLenCP`
  // fallback. Same meaning, strictly worse plan. Verified against a live mongod.
  const SPELLINGS: ReadonlyArray<readonly [string, string]> = [
    ["matches-object", `{ userId: $._id }`],
    ["matchesProperty", `["userId", $._id]`],
  ];
  for (const [label, shorthand] of SPELLINGS) {
    it(`a ${label} predicate lowers identically to its arrow — indexed basic form, $size .length`, () => {
      const arrow = (pred: string) => `let n = $$$.orders.filter(${pred}).length; $project({ n });`;
      expect(jsmql(arrow(shorthand))).toEqual([
        { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.1" } },
        { $set: { "__jsmql.tmp.1": { $size: "$__jsmql.tmp.1" } } },
        { $set: { "__jsmql.var.n": "$__jsmql.tmp.1" } },
        { $project: { n: "$__jsmql.var.n" } },
        { $unset: "__jsmql" },
      ]);
      expect(jsmql(arrow(shorthand))).toEqual(jsmql(arrow("o => o.userId === $._id")));
    });

    it(`a ${label} predicate hits the same Filter-mode gate as its arrow`, () => {
      // Detection drives the mode gate too: an undetected shorthand used to fall
      // through to the generic "bare '$$$' reference" error instead of the
      // actionable "requires Pipeline mode" one.
      expect(() => jsmql(`$$$.orders.filter(${shorthand}).length > 0`)).toThrow(/requires Pipeline mode/);
    });
  }

  it("an uncorrelated $lookup omits `let` entirely, whatever assembled it", () => {
    // `let` is optional to the server, so an empty `let: {}` is pure noise. The
    // rule used to be re-decided per emission site (lean only for `.aggregate`,
    // and only for a non-`.filter`-headed chain), which made these four disagree
    // for no semantic reason. `pipelineLookupBody` is now the single decider.
    // Verified against a live mongod.
    const lookupOf = (src: string) => ((jsmql(src) as object[])[0] as { $lookup: Record<string, unknown> }).$lookup;
    for (const src of [
      "$.x = $$$.orders.filter(o => o.uid === 1);", // direct lookup, filter head
      "$.x = $$$.orders.filter({ uid: 1 });", // …and its shorthand twin
      "$.x = $$$.orders.filter(o => o.uid === 1).take(2);", // chained, filter head
      "$.x = $$$.orders.take(2);", // chained, stream-method head
      "$.x = $$$.orders.aggregate(o => { $limit(2); });", // .aggregate
    ]) {
      expect(Object.keys(lookupOf(src)), src).not.toContain("let");
    }
    // A predicate that DOES correlate still gets its `let` — the shape follows the
    // predicate, never the code path.
    expect(lookupOf("$.x = $$$.orders.filter(o => o.uid === $._id && o.qty > 0);").let).toEqual({
      jsmql_f0__id: "$_id",
    });
  });

  it("a malformed shorthand still reports its own targeted error, not a lookup-shape one", () => {
    // `filterArgToLambda` returns null rather than throwing, so `validateLookupShape`
    // (which runs the throwing `shorthandToLambda`) stays the owner of the message.
    expect(() => jsmql("$.x = $$$.orders.filter({});")).toThrow(/needs at least one field to match/);
    expect(() => jsmql("$.x = $$$.orders.filter([1, 2]);")).toThrow(/matchesProperty shorthand/);
  });

  it(".slice(a, a) (empty window) emits $match:{$expr:false}, never the server-rejected $limit:0", () => {
    expect(jsmql("$.top = $$$.orders.slice(0, 0);")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { $expr: false } }], as: "__jsmql.tmp.1" } },
      { $set: { top: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a no-statement / const-only block-body .map value-extracts identically to the expression form", () => {
    // `o => { return o.total }` is valid JS, identical to `o => o.total` (and to the same
    // block on an in-document array). On a stream it's PARSED as a stage-less sub-pipeline
    // block, but must lower to the SAME value-mode $map — never a scalar $replaceWith.
    // Verified on a live mongod.
    const asExpr = jsmql("$.x = $$$.orders.map(o => o.total);");
    expect(jsmql("$.x = $$$.orders.map(o => { return o.total; });")).toEqual(asExpr);
    expect(jsmql("$.x = $$$.orders.map(o => { const y = o.total; return y; });")).toEqual([
      { $lookup: { from: "orders", pipeline: [], as: "__jsmql.tmp.1" } },
      {
        $set: {
          x: { $map: { input: "$__jsmql.tmp.1", as: "o", in: { $let: { vars: { y: "$$o.total" }, in: "$$y" } } } },
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("a block-body .map with REAL stages + a scalar return is still rejected (can't value-extract through stages)", () => {
    expect(() => jsmql("$.x = $$$.orders.map(o => { $sort({ x: -1 }); return o.total; });")).toThrow(
      /statement-block body/,
    );
  });

  it("a .map after an object-collapsing terminal (.countBy) is rejected, not mis-assembled", () => {
    expect(() => jsmql('$.x = $$$.orders.filter(o => o.uid === $._id).countBy("uid").map(v => v);')).toThrow(
      /'\.map\(\.\.\.\)' can't follow '\.countBy\(\.\.\.\)'/,
    );
  });
});

describe("$$$.coll.aggregate(pipeline) — full sub-pipeline → $lookup", () => {
  it("uncorrelated head (arrow-block): no $. refs → no let", () => {
    expect(jsmql("$.top = $$$.products.aggregate((p) => { $sort({ sales: -1 }); $limit(5); });")).toEqual([
      { $lookup: { from: "products", pipeline: [{ $sort: { sales: -1 } }, { $limit: 5 }], as: "top" } },
    ]);
  });

  it("array form lowers identically to the arrow-block form", () => {
    expect(jsmql("$.top = $$$.products.aggregate([{ $sort: { sales: -1 } }, { $limit: 5 }]);")).toEqual([
      { $lookup: { from: "products", pipeline: [{ $sort: { sales: -1 } }, { $limit: 5 }], as: "top" } },
    ]);
  });

  it("zero-param arrow (bare stage keys) works", () => {
    expect(jsmql("$.top = $$$.products.aggregate(() => { $sort({ sales: -1 }); $limit(3); });")).toEqual([
      { $lookup: { from: "products", pipeline: [{ $sort: { sales: -1 } }, { $limit: 3 }], as: "top" } },
    ]);
  });

  it("correlated head: $. auto-lets into $lookup.let; foreign via o.<field>", () => {
    expect(
      jsmql(
        "$.monthlyTotals = $$$.orders.aggregate((o) => { $match(o.userId === $._id); $group({ _id: { $month: o.createdAt }, total: $sum(o.amount) }); $sort({ _id: 1 }); });",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
            { $group: { _id: { $month: "$createdAt" }, total: { $sum: "$amount" } } },
            { $sort: { _id: 1 } },
          ],
          as: "monthlyTotals",
        },
      },
    ]);
  });

  it("chained after a correlating .filter — aggregate stages extend the $lookup.pipeline", () => {
    expect(
      jsmql(
        "$.recentOrders = $$$.orders.filter(o => o.userId === $._id).aggregate((o) => { $sort({ placedAt: -1 }); $limit(5); });",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
            { $sort: { placedAt: -1 } },
            { $limit: 5 },
          ],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { recentOrders: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("let RHS materialises into __jsmql.var.<name>", () => {
    expect(jsmql("let top = $$$.products.aggregate((o) => { $sort({ sales: -1 }); $limit(5); });")).toEqual([
      { $lookup: { from: "products", pipeline: [{ $sort: { sales: -1 } }, { $limit: 5 }], as: "__jsmql.var.top" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("chained .length counts the aggregate result", () => {
    expect(
      jsmql(
        '$.n = $$$.orders.aggregate((o) => { $match(o.userId === $._id); $group({ _id: "$productId" }); }).length;',
      ),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [{ $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } }, { $group: { _id: "$productId" } }],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { "__jsmql.tmp.1": { $size: "$__jsmql.tmp.1" } } },
      { $set: { n: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("$$ = source-switch: aggregate over a foreign collection → $unionWith.pipeline", () => {
    expect(
      jsmql('$$ = $$$.orders.aggregate((o) => { $group({ _id: "$status", n: $sum(1) }); $sort({ n: -1 }); });'),
    ).toEqual([
      { $match: { $expr: false } },
      {
        $unionWith: {
          coll: "orders",
          pipeline: [{ $group: { _id: "$status", n: { $sum: 1 } } }, { $sort: { n: -1 } }],
        },
      },
    ]);
  });

  it("3rd 'collection' param exposes .length via $setWindowFields", () => {
    expect(
      jsmql('$.g = $$$.c.aggregate((o, _i, coll) => { $group({ _id: "$s" }); assert(coll.length > 0, "empty"); });'),
    ).toEqual([
      {
        $lookup: {
          from: "c",
          pipeline: [
            { $group: { _id: "$s" } },
            { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
            {
              $match: {
                $expr: {
                  $convert: {
                    input: true,
                    to: { $cond: [{ $gt: ["$__jsmql.length", 0] }, "bool", "jsmql assertion failed: empty"] },
                  },
                },
              },
            },
            { $unset: "__jsmql" },
          ],
          as: "g",
        },
      },
    ]);
  });

  it("array form correlates: an outer $. ref inside $expr auto-lets into $lookup.let", () => {
    expect(
      jsmql('$.x = $$$.orders.aggregate([{ $match: { $expr: { $eq: ["$userId", $._id] } } }, { $sort: { a: 1 } }]);'),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [{ $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } }, { $sort: { a: 1 } }],
          as: "x",
        },
      },
    ]);
  });

  it("$$ = source-switch binds the 3rd 'collection' param's .length (parity with .map)", () => {
    expect(jsmql("$$ = $$$.products.aggregate((o, _i, coll) => { $set({ n: coll.length }); });")).toEqual([
      { $match: { $expr: false } },
      {
        $unionWith: {
          coll: "products",
          pipeline: [
            { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
            { $set: { n: "$__jsmql.length" } },
            { $unset: "__jsmql" },
          ],
        },
      },
    ]);
  });
});

describe("$$$.coll.aggregate — error cases", () => {
  it("expression-body arrow is rejected (needs block or array)", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate(o => o.v);")).toThrow(/\.aggregate\(pipeline\) needs a block body/);
  });

  it("a used index (2nd) param is rejected", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate((o, i) => { $match(o.n === i); });")).toThrow(
      /'i' \(the 2nd, index parameter\) has no meaning inside '\.aggregate/,
    );
  });

  it("non-.length use of the 3rd 'collection' param is rejected", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate((o, _i, coll) => { $match(o.n === coll[0]); });")).toThrow(
      /only 'coll\.length' \(the sub-stream count\) is available/,
    );
  });

  it("a spread element in the array form is rejected", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate([{ $sort: { a: 1 } }, ...$.more]);")).toThrow(
      /a spread element isn't a pipeline stage/,
    );
  });

  it("an empty pipeline is rejected (array form; the arrow form's empty block is a parse error)", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate([]);")).toThrow(/an empty pipeline has nothing to run/);
  });

  it("$$.aggregate (current stream) redirects to the foreign form", () => {
    expect(() => jsmql('$$.aggregate((o) => { $group({ _id: "$s" }); });')).toThrow(
      /\.aggregate\(\.\.\.\) runs a sub-pipeline against a FOREIGN collection/,
    );
  });

  it("$ = replace-root with an aggregate (array) is rejected", () => {
    expect(() => jsmql('$ = $$$.c.aggregate((o) => { $group({ _id: "$s" }); });')).toThrow(
      /Cannot replace root with an array — '\.aggregate\(\.\.\.\)' returns an array/,
    );
  });

  it("$$.push union of an aggregate result is deferred [DEF-034]", () => {
    expect(() => jsmql('$$.push(...$$$.c.aggregate((o) => { $group({ _id: "$s" }); }));')).toThrow(
      /can't be unioned into the stream with `\$\$\.push\(\.\.\.\)`/,
    );
  });

  it("cross-database aggregate read is rejected", () => {
    expect(() => jsmql("$.x = $$$$.db.c.aggregate((o) => { $sort({ a: 1 }); });")).toThrow(
      /Cross-database reads aren't supported/,
    );
  });

  it("aggregate syntax outside Pipeline mode is rejected", () => {
    expect(() => jsmql("$$$.c.aggregate((o) => { $limit(5); })")).toThrow(
      /Lookup syntax \('\$\$\$\.<coll>\.find\/filter\/aggregate\(\.\.\.\)'\) requires Pipeline mode/,
    );
  });

  it("a trailing `return` inside an aggregate block is rejected (it's not a per-doc reshape)", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate((o) => { $sort({ a: 1 }); return o.v; });")).toThrow(
      /doesn't take a `return`/,
    );
  });

  it(".aggregate chained on a .find() result is rejected (scalar, not a collection)", () => {
    expect(() => jsmql("$.x = $$$.c.find(o => o.x === 1).aggregate((o) => { $sort({ a: 1 }); });")).toThrow(
      /\.aggregate\(\) on a \.find\(\) result is not meaningful/,
    );
  });

  it("$$ = source-switch rejects an outer-doc $. reference (no let slot)", () => {
    expect(() =>
      jsmql('$$ = $$$.orders.aggregate((o) => { $match(o.userId === $._id); $group({ _id: "$s" }); });'),
    ).toThrow(/correlate with a `\.filter`/);
  });

  it("the chained form (.filter(p).aggregate(bad)) validates via the same rules", () => {
    // Routes through AGGREGATE.validate (stream-methods), not validateAggregateShape.
    expect(() => jsmql("$.x = $$$.c.filter(o => o.v > 1).aggregate(o => o.v);")).toThrow(
      /\.aggregate\(pipeline\) needs a block body/,
    );
    expect(() => jsmql("$.x = $$$.c.filter(o => o.v > 1).aggregate((o, i) => { $match(o.n === i); });")).toThrow(
      /'i' \(the 2nd, index parameter\) has no meaning/,
    );
  });
});

// ── Chained stage calls on a foreign collection ──────────────────────────────
// Stage links peel into `$lookup.pipeline` alongside the lodash chain methods.
// See docs/specs/lookup-stage.md and docs/specs/aggregation-stages.md.
describe("chained stage calls on $$$.<coll>", () => {
  it("peels a run of stage links into $lookup.pipeline", () => {
    expect(jsmql("const top = $$$.orders.$match({ status: 'shipped' }).$sort({ total: -1 }).$limit(3);")).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [{ $match: { status: "shipped" } }, { $sort: { total: -1 } }, { $limit: 3 }],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { "__jsmql.var.top": "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  // THE EQUIVALENCE: in a foreign chain a stage link is lowered as the
  // one-statement `.aggregate((o) => { <stage>; })` block it stands for,
  // through the same engine — so the two spellings can't drift.
  it("is equivalent to the one-statement .aggregate(...) block spelling", () => {
    const chained = jsmql("$.t = $$$.orders.$match({ x: 1 });");
    const block = jsmql("$.t = $$$.orders.aggregate((o) => { $match({ x: 1 }); });");
    // `.aggregate` as the chain HEAD writes `as:` straight into the destination;
    // a chained link materialises through a tmp slot. The sub-pipeline — the part
    // the stage link is responsible for — must match exactly.
    const subPipeline = (mql: unknown) => (mql as { $lookup: { pipeline: unknown } }[])[0].$lookup.pipeline;
    expect(subPipeline(chained)).toEqual(subPipeline(block));
  });

  // `$.` in a foreign sub-pipeline means the OUTER document and hoists into
  // `$lookup.let`. That works in every aggregation-EXPRESSION slot…
  it("hoists an outer-document read into $lookup.let in an expression slot", () => {
    expect(jsmql("$.t = $$$.orders.$set({ owner: $.tag });")).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0_tag: "$tag" },
          pipeline: [{ $set: { owner: "$$jsmql_f0_tag" } }],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { t: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  // …and in a query-document `$match` body it is re-expressed as a predicate
  // first, because MongoDB doesn't evaluate `$$` vars in the query language —
  // a raw `{ $match: { userId: "$$jsmql_f0__id" } }` is accepted by the server
  // and silently matches nothing (verified live). Output is the `$expr` split
  // `.filter(...)` produces, so both spellings agree byte for byte.
  it("re-expresses a correlated query-document $match as a predicate", () => {
    // A lone `.$match(<plain equality map>)` IS `.filter(<matches object>)` — same
    // predicate, so it normalises to `filter` in `detectLookupCall` and earns the
    // same indexed basic form, not a correlated sub-pipeline.
    const stageLink = jsmql("$.t = $$$.orders.$match({ userId: $._id });");
    expect(stageLink).toEqual([{ $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "t" } }]);
    expect(stageLink).toEqual(jsmql("$.t = $$$.orders.filter({ userId: $._id });"));
  });

  // Uncorrelated terms stay in index-friendly query form; only the correlated
  // ones move into `$expr` — again matching `.filter({ … })` exactly.
  it("splits a mixed correlated/plain query-document $match like .filter does", () => {
    const stageLink = jsmql('$.t = $$$.orders.$match({ userId: $._id, status: "shipped" });');
    expect(stageLink).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [{ $match: { status: "shipped", $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } }],
          as: "t",
        },
      },
    ]);
    expect(stageLink).toEqual(jsmql('$.t = $$$.orders.filter({ userId: $._id, status: "shipped" });'));
  });

  it("an operator-bearing $match body is NOT converted — it isn't a lodash matcher", () => {
    // `{ qty: { $gt: 5 } }` as a QUERY means "greater than 5"; as a lodash
    // matches-object it would mean "equals the object { $gt: 5 }". Different
    // meanings, so `.$match` keeps the query form and `.filter` keeps the equality.
    expect(jsmql("$.t = $$$.orders.$match({ qty: { $gt: 5 } });")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { qty: { $gt: 5 } } }], as: "__jsmql.tmp.1" } },
      { $set: { t: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
    expect(jsmql("$.t = $$$.orders.filter({ qty: { $gt: 5 } });")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { $expr: { $eq: ["$qty", { $gt: 5 }] } } }], as: "t" } },
    ]);
  });

  // Comparison-operator form correlates too.
  it("translates a correlated comparison-operator query term", () => {
    expect(jsmql("$.t = $$$.orders.$match({ createdAt: { $gte: $.since } });")).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0_since: "$since" },
          pipeline: [{ $match: { $expr: { $gte: ["$createdAt", "$$jsmql_f0_since"] } } }],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { t: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  // An UNcorrelated query document keeps the verbatim query-form path (HR1).
  it("leaves an uncorrelated query-document $match verbatim", () => {
    // The point is the BODY: an uncorrelated term stays index-friendly query form
    // and is never rewritten into `$expr`. (The lone head also writes straight to
    // `as: "t"` — it normalises to `.filter`, which skips the tmp slot.)
    expect(jsmql('$.t = $$$.orders.$match({ status: "shipped" });')).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { status: "shipped" } }], as: "t" } },
    ]);
    expect(jsmql('$.t = $$$.orders.$match({ status: "shipped" });')).toEqual(
      jsmql('$.t = $$$.orders.filter({ status: "shipped" });'),
    );
  });

  // The `$expr` escape hatch is the supported hand-written correlation, and
  // `$$vars` DO resolve inside it — the guard must not fire there.
  it("allows an outer-document read inside the $expr escape hatch", () => {
    expect(jsmql('$.t = $$$.orders.$match({ $expr: { $eq: ["$userId", $._id] } });')).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [{ $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } }],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { t: "$__jsmql.tmp.1" } },
      { $unset: "__jsmql" },
    ]);
  });

  // The `.aggregate(...)` block spelling correlates through the same path. It
  // had emitted the silently-empty raw query form since it shipped.
  it("correlates a query-document $match inside an .aggregate(...) block", () => {
    expect(jsmql("$.orders = $$$.orders.aggregate((o) => { $match({ userId: $._id }); });")).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [{ $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } }],
          as: "orders",
        },
      },
    ]);
  });

  it("mixes stage links with lodash chain methods and a value-mode tail", () => {
    expect(
      jsmql("const ids = $$$.orders.$match({ userId: 'u1' }).$sort({ createdAt: -1 }).$limit(10).map('productIds');"),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [{ $match: { userId: "u1" } }, { $sort: { createdAt: -1 } }, { $limit: 10 }],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { "__jsmql.var.ids": { $map: { input: "$__jsmql.tmp.1", as: "jsmqlEl", in: "$$jsmqlEl.productIds" } } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("lowers stage links into a $unionWith source-switch", () => {
    expect(jsmql("$$ = $$$.orders.$match({ a: 1 }).$limit(2);")).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "orders", pipeline: [{ $match: { a: 1 } }, { $limit: 2 }] } },
    ]);
  });

  // Placement rules are the declarative `forbiddenIn` set from stages.ts —
  // the same source the statement path reads.
  it("rejects a stage forbidden inside a $lookup sub-pipeline", () => {
    expect(() => jsmql("$.t = $$$.orders.$out('archive');")).toThrow(
      /'\$out' is not allowed inside a '\$lookup' sub-pipeline/,
    );
    expect(() => jsmql("$.t = $$$.orders.$merge({ into: 'archive' });")).toThrow(
      /'\$merge' is not allowed inside a '\$lookup' sub-pipeline/,
    );
  });

  it("rejects a must-be-first stage that isn't first in the chain", () => {
    expect(() => jsmql("$.t = $$$.orders.$match({ a: 1 }).$documents([{ x: 1 }]);")).toThrow(
      /'\$documents' must be the first stage/,
    );
  });

  it("rejects an unknown stage name in a foreign chain with a suggestion", () => {
    expect(() => jsmql("$.t = $$$.orders.$sortt({ a: 1 });")).toThrow(
      /'\$sortt' is not a known aggregation stage\. Did you mean '\$sort'\?/,
    );
  });
});
