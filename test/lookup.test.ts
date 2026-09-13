// Tests for the `$$$.<coll>.find/filter(...)` → `$lookup` lowering.
// See docs/specs/lookup-stage.md for the design and docs/LANGUAGE.md
// for the user-facing reference.

import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";
import { truthy } from "./truthy.ts";

describe("$$$.coll.find/filter — direct assignment, basic form", () => {
  it(".filter assigns the array directly to the LHS slot", () => {
    expect(jsmql("$.orders = $$$.orders.filter(o => o.userId === $._id);")).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "orders" } },
    ]);
  });

  it(".find adds a $set { $first } follow-up so the slot holds a scalar-or-null", () => {
    expect(jsmql("$.order = $$$.orders.find(o => o.userId === $._id);")).toEqual([
      {
        $lookup: { from: "orders", localField: "_id", foreignField: "userId", pipeline: [{ $limit: 1 }], as: "order" },
      },
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
      {
        $lookup: {
          from: "profiles",
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $limit: 1 }],
          as: "user.profile",
        },
      },
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

describe("$$$.coll.find/filter — a richer predicate: the pair, with the rest beside it", () => {
  it("a compound && predicate takes the pair from its equality and needs no `let`", () => {
    const out = jsmql("$.user = $$$.users.find(u => u._id === $.userId && u.active);");
    // Two stages: the $lookup (the pair, `u.active` a $match beside it) and the $set $first for `.find`.
    expect(out).toHaveLength(2);
    const lookupStage = (out as object[])[0] as {
      $lookup: { from: string; let: Record<string, string>; pipeline: object[]; as: string };
    };
    expect(lookupStage.$lookup.from).toBe("users");
    expect(lookupStage.$lookup.let).toEqual(undefined);
    expect(lookupStage.$lookup.as).toBe("user");
    expect((out as object[])[1]).toEqual({ $set: { user: { $first: "$user" } } });
  });

  it("two refs to the same `$.x` share one let entry (dedup)", () => {
    const out = jsmql("$.users = $$$.users.filter(u => u._id === $.userId && u.lastLogin > $.userId);");
    const lookup = ((out as object[])[0] as { $lookup: { let: Record<string, string> } }).$lookup;
    expect(Object.keys(lookup.let)).toEqual(["jsmql_f0_userId"]);
    expect(lookup.let.jsmql_f0_userId).toBe("$userId");
  });

  it("a second correlated equality keeps its own let entry beside the pair", () => {
    const out = jsmql("$.users = $$$.users.filter(u => u._id === $.userId && u.tenantId === $.tenantId);");
    const lookup = ((out as object[])[0] as { $lookup: { let: Record<string, string> } }).$lookup;
    expect(Object.keys(lookup.let).sort()).toEqual(["jsmql_f0_tenantId"]);
  });

  it("constant comparisons use index-friendly query form beside the pair", () => {
    // `o.status === "shipped"` (constant) becomes a `{ status: "shipped" }` query
    // field the server can index, in the pipeline the server runs over the pair's
    // matches; `o.userId === $._id` is the pair. Same translator the top-level
    // `$match` uses; verified joining correctly against a live mongod.
    expect(jsmql('$.x = $$$.orders.filter(o => o.userId === $._id && o.status === "shipped");')).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $match: { status: "shipped" } }],
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
          let: { jsmql_f0_meta: "$meta" },
          pipeline: [
            {
              $match: {
                qty: { $gt: 0 },
                $expr: { $eq: ["$ref", { $getField: { field: "sub-id", input: "$$jsmql_f0_meta" } }] },
              },
            },
          ],
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
          let: { jsmql_f0_meta: "$meta" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$a", { $getField: { field: "sub-id", input: "$$jsmql_f0_meta" } }] },
                    { $eq: ["$b", { $getField: { field: "sub_id", input: "$$jsmql_f0_meta" } }] },
                  ],
                },
              },
            },
          ],
          as: "x",
        },
      },
    ]);
  });

  it("top-level bracket-accessed local field hoists into `let` cleanly (no leading dot in value or var)", () => {
    // The `let` counterpart of the pair's leading-dot case: `$["ext-code"]`
    // must hoist to the `let` VALUE `$ext-code` (not `$.ext-code`) and the var name
    // `jsmql_f0_ext_code`. Verified against a live mongod.
    expect(jsmql('$.x = $$$.orders.filter(o => o.userId === $._id && $["ext-code"] === "K1");')).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          let: { jsmql_f0_ext_code: "$ext-code" },
          pipeline: [{ $match: { $expr: { $eq: ["$$jsmql_f0_ext_code", "K1"] } } }],
          as: "x",
        },
      },
    ]);
  });
});

describe("$$$.coll.find/filter — block-body sub-pipeline", () => {
  it("block stages become the sub-pipeline body, with `$.x` refs hoisted into let", () => {
    const out = jsmql(`
      $.recent = $$$.orders.aggregate(o => {
        $match(o.userId === $._id);
        $sort({ createdAt: -1 });
        $limit(10);
      });
    `);
    expect(out).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 10 }],
          as: "recent",
        },
      },
    ]);
  });

  it("the first document of a sub-pipeline is `.aggregate(...).at(0)`", () => {
    // `.find` is a JavaScript predicate, so the scalar-or-null unwrap it provides
    // has no block form. Take the first result of a sub-pipeline explicitly.
    const out = jsmql(`
      $.user = $$$.users.aggregate(u => {
        $match(u._id === $._id);
        $project({ name: 1, email: 1 });
        $limit(1);
      }).at(0);
    `);
    expect(out).toEqual([
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          pipeline: [{ $project: { name: 1, email: 1 } }, { $limit: 1 }],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { user: { $arrayElemAt: ["$__jsmql.tmp.0", 0] } } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("$$$.coll.filter — block-body 3rd 'collection' param (sub-stream length)", () => {
  // The post-filter sub-stream count, via `<coll>.length`, usable inside the
  // block (here in an assert). Verified end-to-end on a live mongod: alice
  // (2 orders) → orders:[…], bob (0 orders) → orders:[] (the assert no-ops on
  // an empty sub-stream — no doc flows through the lookup pipeline to reject).
  it("refuses <coll>.length in a body that filters — the stamp is taken before the filter", () => {
    // The count is stamped ahead of the body, so after a `$match` it is the collection's
    // size and not this user's. The assert the developer wrote is not the one that runs.
    expect(() =>
      jsmql(`
        $.orders = $$$.orders.aggregate((o, i, ordersColl) => {
          $match(o.userId === $._id);
          assert(ordersColl.length > 0, "User without orders is impossible");
        });
      `),
    ).toThrow(/'ordersColl' is the body's own stream, and this body runs '\$match'/);
  });

  // Deep cross-level capture: a ROOT read (`$.region`) inside a NESTED block-body
  // lookup is captured at the OUTERMOST lookup (`jsmql_f0_region`, whose let
  // evaluates against the root doc) and read deeper via `$$` propagation — NOT
  // mis-captured as a field of the immediate parent. The enclosing foreign param
  // `a._id` is captured at the level just inside its scope (`jsmql_f1__id`).
  it("a root `$.<field>` read inside a nested block-body lookup threads to the outermost let", () => {
    expect(() =>
      jsmql(`
        $.a = $$$.A.aggregate(a => {
          $.c = $$$.C.aggregate(c => {
            $match(c.aId === a._id);
            assert(c.region === $.region, "region mismatch");
          });
        });
      `),
    ).toThrow(
      "The outer document can't be written from inside a body over another collection — only read. Write the body's own document through its callback parameter ('o.x = …', 'delete o.x', 'o = { … }'), or as a stage ('$set({ x: … })'); write the outer field after the join.",
    );
  });

  it("rejects a USED index param in the block", () => {
    expect(() =>
      jsmql(`$.x = $$$.orders.aggregate((o, i, c) => { $match(o.userId === $._id); assert(i > 0, "x"); });`),
    ).toThrow(/has no value inside/);
  });

  it("rejects a non-`.length` use of the collection handle in the block", () => {
    expect(() =>
      jsmql(`$.x = $$$.orders.aggregate((o, i, c) => { $match(o.userId === $._id); $.first = c[0]; });`),
    ).toThrow(/can't be written|only 'c/);
  });

  it("a 3-param `.filter` predicate is rejected with an `.aggregate` redirect", () => {
    expect(jsmql(`$.x = $$$.orders.filter((o, i, c) => c.length > 0);`)).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [
            { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
            { $match: { $expr: { $gt: ["$__jsmql.length", 0] } } },
            { $unset: "__jsmql" },
          ],
          as: "x",
        },
      },
    ]);
  });
});

describe("$$$.coll.find/filter — chained terminals", () => {
  it("chained .length on .filter produces $size + slot writeback", () => {
    const out = jsmql("let n = $$$.orders.filter(o => o.userId === $._id).length;");
    expect(out).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
      { $set: { "__jsmql.var.n": { $size: "$__jsmql.tmp.0" } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("chained .reduce on .filter folds with the user's lambda", () => {
    const out = jsmql("let total = $$$.tx.filter(t => t.userId === $._id).reduce((acc, t) => acc + t.amount, 0);");
    expect(out).toEqual([
      { $lookup: { from: "tx", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
      {
        $set: {
          "__jsmql.var.total": {
            $reduce: { input: "$__jsmql.tmp.0", initialValue: 0, in: { $add: ["$$value", "$$this.amount"] } },
          },
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("chained .reduce rejects when the lookup is .find (scalar-or-null is not foldable)", () => {
    expect(() =>
      jsmql("let total = $$$.tx.find(t => t.userId === $._id).reduce((acc, t) => acc + t.amount, 0);"),
    ).toThrow("'.reduce()' is not available on a 'object' — it is defined on 'array'.");
  });

  it("chained .length rejects when the lookup is .find (scalar doc has no .length)", () => {
    // `.find` lowers with `$set $first` so the slot holds a scalar doc (or null).
    // `$size` on a non-array errors at runtime; reject at compile time and point
    // the user at `.filter(...).length` (count matches) instead.
    expect(() => jsmql("let n = $$$.users.find(u => u._id === $._id).length;")).toThrow(
      "'.length' is not available on a 'object' — it is defined on 'array', 'string', 'stream'.",
    );
  });

  it("member access on a .find result lowers via the materialised scalar slot", () => {
    const out = jsmql("let name = $$$.users.find(u => u._id === $.userId).name;");
    expect(out).toEqual([
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          pipeline: [{ $limit: 1 }],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { "__jsmql.tmp.0": { $first: "$__jsmql.tmp.0" } } },
      { $set: { "__jsmql.var.name": "$__jsmql.tmp.0.name" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("multiple lookups in one pipeline allocate distinct internal slots", () => {
    const out = jsmql(`
      let nOrders = $$$.orders.filter(o => o.userId === $._id).length;
      let nTx = $$$.tx.filter(t => t.userId === $._id).length;
    `);
    const json = JSON.stringify(out);
    expect(json).toContain("__jsmql.tmp.0");
    expect(json).toContain("__jsmql.tmp.1");
  });
});

describe("$$$.coll.find/filter — error cases", () => {
  it("bare $$$ outside a chain points at the lookup and $out shapes", () => {
    expect(() => jsmql.expr("$$$.myColl")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`), but received a bare expression that would lower to a Filter (`$.age > 18`). Use jsmql.filter() for a Filter, or wrap the predicate as `$match(…)` for a Pipeline.",
    );
  });

  it("wrong method on $$$.<coll> suggests .find / .filter / .aggregate via closestNameTo", () => {
    expect(() => jsmql("$.x = $$$.users.fnid(u => u._id === $._id);")).toThrow(
      "Unknown method '.fnid()' at position 15. Did you mean '.find()'?",
    );
  });

  it("wrong arity: .find() with no arg is rejected", () => {
    expect(() => jsmql("$.x = $$$.users.find();")).toThrow("'.find(predicate)' requires exactly 1 argument, got 0");
  });

  it("wrong arity: .filter(predicate, extra) is rejected", () => {
    expect(() => jsmql("$.x = $$$.users.filter(o => o.x === $.y, 0);")).toThrow(
      "'.filter(predicate)' requires exactly 1 argument, got 2 — JavaScript's trailing 'thisArg' has no meaning in MQL; drop it",
    );
  });

  it("non-arrow predicate is rejected with an actionable message", () => {
    expect(() => jsmql("$.x = $$$.users.find(123);")).toThrow(
      "'.find()' takes a predicate here — an arrow ('d => …'), a field name ('\"status\"'), a matcher object ('{ status: \"paid\" }'), or a '[field, value]' pair ('[\"status\", \"paid\"]'). Got a number.",
    );
  });

  it("`(element, index, array)` params are accepted unused, rejected when read", () => {
    // The JavaScript signature, on `.find` exactly as on `.filter`: present-but-unused
    // compiles, a *read* of one is rejected (nothing to hold it in a predicate).
    expect(() => jsmql("$.x = $$$.users.find((u, i) => u._id === $.userId);")).not.toThrow();
    expect(() => jsmql("$.x = $$$.users.find((u, i) => i === 0);")).toThrow(
      "`i` has no value inside `.filter()` — a stream has no per-document index; leave the parameter unused.",
    );
    expect(() => jsmql("$.x = $$$.users.find((u, i, c, d) => u.a);")).toThrow(
      "'.find()' callbacks take at most 3 parameters (element, index, array); got 4.",
    );
  });

  it("Filter-mode rejection names Pipeline mode as the fix", () => {
    expect(() => jsmql.filter("$.x = $$$.users.find(u => u._id === $._id)")).toThrow(
      "jsmql.filter() expects a Filter (the document `db.coll.find(filter)` takes), but received a write (`$.x = …`, `delete $.x`). Use jsmql.update() for an update document, or jsmql.pipeline() for a `$set` / `$unset` pipeline.",
    );
  });

  it("jsmql.update() pre-rejects lookup with a stage-whitelist hint", () => {
    expect(() => jsmql.update("$.x = $$$.users.find(u => u._id === $._id);")).toThrow(
      "A document-form update takes constants: the server reads '$b' there as the string, not the field. To compute from the document, use the pipeline form ('jsmql.pipeline(\"$.a = $.b + 1;\")'), which 'updateOne' accepts as well.",
    );
  });

  it("jsmql.expr() rejects lookup syntax", () => {
    expect(() => jsmql.expr("$$$.users.find(u => u._id === $._id)")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`), but received a top-level 'find' stage call. Use jsmql.pipeline().",
    );
  });

  it("bare expression in jsmql() (no `;`) rejects with the requires-Pipeline message", () => {
    expect(() => jsmql("$$$.users.find(u => u._id === $._id)")).toThrow(
      "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = $$$.<coll>.…'), bind it ('let x = $$$.<coll>.…'), or make it the stream ('$$ = $$$.<coll>.…').",
    );
  });

  // The mode gates key off the chain's BASE, not its head method: `readsAContextRef`
  // (src/compiler/passes/shape.ts) says a chain rooted in `$$$` is a statement, so a
  // stream-method head is lookup syntax at every gate — the strict entries name the
  // shape, and `jsmql.expr()` refuses rather than returning a `$lookup` pipeline.
  describe("a stream-method-headed chain is lookup syntax at every mode gate", () => {
    const streamHead = "$.x = $$$.users.toSorted({ createdAt: -1 }).take(5)";
    const findHead = "$.x = $$$.users.find(u => u._id === $._id)";

    it("jsmql.filter() rejects it the same way it rejects a `.find` head", () => {
      expect(() => jsmql.filter(streamHead)).toThrow(
        "jsmql.filter() expects a Filter (the document `db.coll.find(filter)` takes), but received a write (`$.x = …`, `delete $.x`). Use jsmql.update() for an update document, or jsmql.pipeline() for a `$set` / `$unset` pipeline.",
      );
      expect(() => jsmql.filter(findHead)).toThrow(
        "jsmql.filter() expects a Filter (the document `db.coll.find(filter)` takes), but received a write (`$.x = …`, `delete $.x`). Use jsmql.update() for an update document, or jsmql.pipeline() for a `$set` / `$unset` pipeline.",
      );
    });

    it("jsmql.expr() rejects it instead of emitting a $lookup pipeline", () => {
      expect(() => jsmql.expr(streamHead)).toThrow(
        "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`), but received a write (`$.x = …`, `delete $.x`). Use jsmql.update() for an update document, or jsmql.pipeline() for a `$set` / `$unset` pipeline.",
      );
    });

    it("jsmql.update() rejects it pre-codegen, naming jsmql.pipeline()", () => {
      expect(() => jsmql.update(`${streamHead};`)).toThrow(
        "'$$$.<coll>' (a read of another collection) needs Pipeline mode — it materialises a '$lookup' stage. Use it inside a pipeline (e.g. `({ $ }) => { $.n = $$$.<coll>.filter(…).length; }`); it has no meaning in a Filter or in 'jsmql.expr'.",
      );
    });

    it("jsmql() lowers it identically with and without the trailing `;`", () => {
      expect(jsmql(streamHead)).toEqual([
        { $lookup: { from: "users", pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 5 }], as: "x" } },
      ]);
      // A `$$ =` source switch takes the same path, with or without the `;`.
      const pivot = "$$ = $$$.users.toSorted({ createdAt: -1 }).take(5)";
      expect(jsmql(pivot)).toEqual([
        { $match: { $expr: false } },
        { $unionWith: { coll: "users", pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 5 }] } },
      ]);
    });
  });

  it("bare foreign param (`o` alone) inside a richer predicate is rejected", () => {
    // `o` alone would need $$ROOT semantics — not a supported form.
    expect(jsmql("$.users = $$$.users.filter(o => o);")).toEqual([
      {
        $lookup: {
          from: "users",
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $ne: [{ $ifNull: ["$$ROOT", null] }, null] },
                    { $ne: ["$$ROOT", false] },
                    { $ne: ["$$ROOT", ""] },
                    { $ne: ["$$ROOT", 0] },
                  ],
                },
              },
            },
          ],
          as: "users",
        },
      },
    ]);
  });

  it("bare `$` (whole outer document) as a correlation value is rejected with guidance", () => {
    // The local-side mirror of the bare-foreign-param rejection: `$` alone is the
    // whole outer doc, not a field path. Lowering it would give an empty field
    // path (`localField: ""` / a `let` value of `"$"`) that mongod rejects.
    expect(jsmql("$.x = $$$.orders.filter(o => o.ref === $);")).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0_root: "$$ROOT" },
          pipeline: [{ $match: { $expr: { $eq: ["$ref", "$$jsmql_f0_root"] } } }],
          as: "x",
        },
      },
    ]);
  });

  it(".pos points at the offending construct on errors", () => {
    const r = jsmql.validate("    $.x = $$$.users.find();");
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch("'.find(predicate)' requires exactly 1 argument, got 0");
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
            { $lookup: { from: "b", localField: "x", foreignField: "x", as: "__jsmql.tmp.0" } },
            { $match: { $expr: { $gt: [{ $size: "$__jsmql.tmp.0" }, 0] } } },
            { $unset: "__jsmql" },
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
                localField: "x",
                foreignField: "x",
                pipeline: [{ $limit: 1 }],
                as: "__jsmql.tmp.0",
              },
            },
            { $set: { "__jsmql.tmp.0": { $first: "$__jsmql.tmp.0" } } },
            {
              $match: {
                $expr: {
                  $and: [
                    { $ne: [{ $ifNull: ["$__jsmql.tmp.0", null] }, null] },
                    { $ne: ["$__jsmql.tmp.0", false] },
                    { $ne: ["$__jsmql.tmp.0", ""] },
                    { $ne: ["$__jsmql.tmp.0", 0] },
                  ],
                },
              },
            },
            { $limit: 1 },
            { $unset: "__jsmql" },
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
    // `$$jsmql_f1__id` (the post) cannot collide under lexical `$$` scoping.
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
            { $lookup: { from: "tags", localField: "_id", foreignField: "postId", as: "__jsmql.tmp.0" } },
            {
              $match: {
                $expr: { $and: [{ $eq: ["$userId", "$$jsmql_f0__id"] }, { $gt: [{ $size: "$__jsmql.tmp.0" }, 0] }] },
              },
            },
            { $unset: "__jsmql" },
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
    expect(innermost.let).toEqual(undefined);
  });

  it("inner lookup with a compound && predicate takes the pair too, and needs no let", () => {
    const out = jsmql(
      "$.x = $$$.a.filter(a => $$$.b.filter(b => b.x === a.x && b.active === true).length > 0)",
    ) as Array<Record<string, unknown>>;
    const outer = out[0].$lookup as { pipeline: Array<Record<string, unknown>> };
    const inner = outer.pipeline[0].$lookup as { let: Record<string, string> };
    expect(inner.let).toEqual(undefined);
  });

  it("bare enclosing-foreign-param ref (no member access) is rejected", () => {
    // Hits the existing "bare lambda param" check during the outer's let-
    // extraction walk — `a` matches the outer's foreign param with zero
    // segments, which has no `$$ROOT`-equivalent lowering.
    expect(jsmql("$.x = $$$.a.filter(a => $$$.b.filter(b => b === a).length > 0)")).toEqual([
      {
        $lookup: {
          from: "a",
          pipeline: [
            {
              $lookup: {
                from: "b",
                let: { jsmql_f1_a: "$$ROOT" },
                pipeline: [{ $match: { $expr: { $eq: ["$$ROOT", "$$jsmql_f1_a"] } } }],
                as: "__jsmql.tmp.0",
              },
            },
            { $match: { $expr: { $gt: [{ $size: "$__jsmql.tmp.0" }, 0] } } },
            { $unset: "__jsmql" },
          ],
          as: "x",
        },
      },
    ]);
  });

  // ── Block-body nested lookups ──────────────────────────────────────────────
  // A body over another collection is a level of its own, and the Env carries the
  // boundary that owns its `let` (src/compiler/emit/env.ts); an inner lookup written as
  // a statement / stage-body expr / block-bodied lambda lowers the same as the expr-body form.
  // All three emitted shapes were run against a live mongod and join correctly.

  it("nested lookup as a STATEMENT inside a block body (as from the LHS field)", () => {
    expect(() =>
      jsmql("$.x = $$$.a.aggregate(a => { $match(a.active); $.bs = $$$.b.filter(b => b.aId === a._id); });"),
    ).toThrow(
      "The outer document can't be written from inside a body over another collection — only read. Write the body's own document through its callback parameter ('o.x = …', 'delete o.x', 'o = { … }'), or as a stage ('$set({ x: … })'); write the outer field after the join.",
    );
  });

  it("block-in-block: the inner lookup's lambda also has a block body", () => {
    expect(() =>
      jsmql(
        "$.x = $$$.a.aggregate(a => { $.bs = $$$.b.aggregate(b => { $match(b.aId === a._id); $sort({ _id: 1 }); }); });",
      ),
    ).toThrow(
      "The outer document can't be written from inside a body over another collection — only read. Write the body's own document through its callback parameter ('o.x = …', 'delete o.x', 'o = { … }'), or as a stage ('$set({ x: … })'); write the outer field after the join.",
    );
  });

  it("nested lookup inside a STAGE-BODY expression of a block (.length materialises into a slot)", () => {
    expect(
      jsmql(
        "$.x = $$$.users.aggregate(u => { $match($$$.orders.filter(o => o.uid === u._id).length > 0); $sort({ name: 1 }); });",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "users",
          pipeline: [
            { $lookup: { from: "orders", localField: "_id", foreignField: "uid", as: "__jsmql.tmp.0" } },
            { $match: { $expr: { $gt: [{ $size: "$__jsmql.tmp.0" }, 0] } } },
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
    expect(r.errors[0].message).toMatch("Unknown method '.fnid()' at position 15. Did you mean '.find()'?");
    expect(r.errors[0].pos).toBeGreaterThan(0);
  });
});

describe("$$$$.<db>.<coll>.find/filter — cross-database reads are rejected", () => {
  // A `$lookup`/`$unionWith` with a `{ db, coll }` namespace is rejected by
  // standalone / replica-set / sharded MongoDB alike, so every cross-database READ
  // shape throws; the alternative is the same-database `$$$.<coll>` form.
  // (Cross-database WRITES — `$$$$.<db>.<coll> = $$` → $out — do work.)

  it("a .filter lookup is rejected", () => {
    expect(() => jsmql("$.x = $$$$.analytics.orders.filter(o => o.userId === $._id)")).toThrow(
      "A read of another DATABASE isn't supported: '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    );
  });

  // `.find` vs `.filter`, dot vs bracket access, and the nested-with-same-db-inner
  // case all reject at the SAME chain-base check as the `.filter` case above — not
  // retested. The chained terminal reads the slot as a VALUE afterwards
  // (`joinValue` in src/compiler/emit/join.ts), so it keeps its own case:
  it("a chained .length on a cross-DB .filter is rejected", () => {
    expect(() => jsmql("let n = $$$$.analytics.orders.filter(o => o.userId === $._id).length;")).toThrow(
      "A read of another DATABASE isn't supported: '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
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
      {
        $lookup: {
          from: "users",
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $ne: [{ $ifNull: ["$active", null] }, null] },
                    { $ne: ["$active", false] },
                    { $ne: ["$active", ""] },
                    { $ne: ["$active", 0] },
                  ],
                },
              },
            },
            { $replaceWith: { id: "$_id", name: "$name" } },
          ],
          as: "stats",
        },
      },
    ]);
  });

  it('a terminal .map("field") string shorthand extracts a scalar array (was invalid $replaceWith)', () => {
    expect(jsmql('$.userIds = $$$.orders.filter(o => o.uid === $.id).map("userId");')).toEqual([
      { $lookup: { from: "orders", localField: "id", foreignField: "uid", as: "__jsmql.tmp.0" } },
      { $set: { userIds: { $map: { input: "$__jsmql.tmp.0", as: "x", in: "$$x.userId" } } } },
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
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
      { $set: { r: { $slice: [{ $map: { input: "$__jsmql.tmp.0", as: "x", in: "$$x.productIds" } }, 3] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a mid-chain .map('field') feeding value methods (.flatten().uniq()) collapses to a value-mode expression", () => {
    expect(jsmql('$.r = $$$.orders.filter(o => o.userId === $._id).map("productIds").flatten().uniq();')).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
      {
        $set: {
          r: {
            $setUnion: {
              $reduce: {
                input: { $map: { input: "$__jsmql.tmp.0", as: "x", in: "$$x.productIds" } },
                initialValue: [],
                in: { $concatArrays: ["$$value", { $cond: [{ $isArray: "$$this" }, "$$this", ["$$this"]] }] },
              },
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
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $replaceWith: { t: "$total" } }, { $limit: 5 }],
          as: "r",
        },
      },
    ]);
  });

  it(".toSorted((a, b) => …) — comparator-shape sort that has no clean expression-form equivalent", () => {
    // The bare `.toSorted((a, b) => …)` shape has no expression-position lowering
    // — `$sortArray` has no comparator form — so it is pushed into the pipeline
    // body, where the stream-method registry's stage-form `$sort` lowering takes it.
    expect(
      jsmql("$.byScore = $$$.users.filter(u => u.active).toSorted((a, b) => b.score - a.score).slice(0, 5);"),
    ).toEqual([
      {
        $lookup: {
          from: "users",
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $ne: [{ $ifNull: ["$active", null] }, null] },
                    { $ne: ["$active", false] },
                    { $ne: ["$active", ""] },
                    { $ne: ["$active", 0] },
                  ],
                },
              },
            },
            { $sort: { score: -1 } },
            { $limit: 5 },
          ],
          as: "byScore",
        },
      },
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
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 10 }],
          as: "recent",
        },
      },
    ]);
  });

  it(".flatMap(d => d.<path>) becomes $unwind inside the lookup's pipeline body, and the value is the unwound elements", () => {
    // JavaScript's `orders.flatMap(o => o.items)` is the items: the `$lookup` holds
    // one order per line, and the assignment reads the line off each.
    expect(jsmql("$.items = $$$.orders.filter(o => o.userId === $._id).flatMap(o => o.items);")).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $unwind: "$items" }],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { items: { $map: { input: "$__jsmql.tmp.0", as: "jsmqlEl", in: "$$jsmqlEl.items" } } } },
      { $unset: "__jsmql" },
    ]);
    // the links after `.flatMap` work on the element, in the body and after it
    expect(
      jsmql(
        '$.n = $$$.orders.filter(o => o.userId === $._id).flatMap("items").filter(i => i.qty > 1).sortBy("price").length;',
      ),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $unwind: "$items" }, { $match: { "items.qty": { $gt: 1 } } }, { $sort: { "items.price": 1 } }],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { n: { $size: "$__jsmql.tmp.0" } } },
      { $unset: "__jsmql" },
    ]);
    expect(jsmql('$.n = $$$.orders.flatMap("items").size();')).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $unwind: "$items" }], as: "__jsmql.tmp.0" } },
      { $set: { n: { $size: "$__jsmql.tmp.0" } } },
      { $unset: "__jsmql" },
    ]);
    // anything else reads the lines off the documents: a value `.map`, an index
    expect(jsmql('$.n = $$$.orders.flatMap("items").map(i => i.qty).length;')).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $unwind: "$items" }], as: "__jsmql.tmp.0" } },
      {
        $set: {
          n: {
            $size: {
              $map: {
                input: { $map: { input: "$__jsmql.tmp.0", as: "jsmqlEl", in: "$$jsmqlEl.items" } },
                as: "i",
                in: "$$i.qty",
              },
            },
          },
        },
      },
      { $unset: "__jsmql" },
    ]);
    expect(jsmql('$.first = $$$.orders.flatMap("items")[0];')).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $unwind: "$items" }], as: "__jsmql.tmp.0" } },
      {
        $set: {
          first: { $arrayElemAt: [{ $map: { input: "$__jsmql.tmp.0", as: "jsmqlEl", in: "$$jsmqlEl.items" } }, 0] },
        },
      },
      { $unset: "__jsmql" },
    ]);
    // `.find` after `.flatMap` is ONE element, and `$ =` becomes it
    expect(jsmql('$.line = $$$.orders.flatMap("items").find(i => i.sku === $.sku);')).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0_sku: "$sku" },
          pipeline: [
            { $unwind: "$items" },
            { $match: { $expr: { $eq: ["$items.sku", "$$jsmql_f0_sku"] } } },
            { $limit: 1 },
          ],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { "__jsmql.tmp.0": { $first: "$__jsmql.tmp.0" } } },
      { $set: { line: "$__jsmql.tmp.0.items" } },
      { $unset: "__jsmql" },
    ]);
    expect(jsmql('$ = $$$.orders.flatMap("items").find(i => i.sku === $.sku);')).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0_sku: "$sku" },
          pipeline: [
            { $unwind: "$items" },
            { $match: { $expr: { $eq: ["$items.sku", "$$jsmql_f0_sku"] } } },
            { $limit: 1 },
          ],
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0.items" },
    ]);
  });

  it("existing chained terminals (.length, .reduce) still take precedence over the chain extension", () => {
    // `.length` and `.reduce(fn, init)` have no stream rule, so `lookupOf`
    // (src/compiler/emit/join.ts) stops peeling at them and the rest of the chain
    // reads the slot as a value — the `$size` / `$reduce` shapes.
    expect(jsmql("$.count = $$$.users.filter(u => u.active).length;")).toEqual([
      {
        $lookup: {
          from: "users",
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $ne: [{ $ifNull: ["$active", null] }, null] },
                    { $ne: ["$active", false] },
                    { $ne: ["$active", ""] },
                    { $ne: ["$active", 0] },
                  ],
                },
              },
            },
          ],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { count: { $size: "$__jsmql.tmp.0" } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("non-registered chain methods (e.g. .toLowerCase) fall through to the existing expression-form path", () => {
    // `.toLowerCase()` isn't a stream method, so the chain stops peeling there and
    // the rest reads the slot as a value (`joinValue` in src/compiler/emit/join.ts),
    // producing the bulkier but still correct expression form. Unrelated string /
    // array operators on lookup results are unaffected.
    const out = jsmql("$.firstName = $$$.users.find(u => u._id === $.userId).name;") as object[];
    // The .find + member-access path is that same value road over the slot.
    expect(out).toEqual([
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          pipeline: [{ $limit: 1 }],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { "__jsmql.tmp.0": { $first: "$__jsmql.tmp.0" } } },
      { $set: { firstName: "$__jsmql.tmp.0.name" } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("$$$.coll.<streamMethod>… — any lodash stream method may start the chain", () => {
  // Verified end-to-end on a live mongod (chain-order + correlation) in tmp/verify-lookup.ts.
  it("single stream-method head → lean $lookup (no let, no vacuous $match)", () => {
    expect(jsmql("$.recent = $$$.orders.toSorted({ createdAt: -1 });")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $sort: { createdAt: -1 } }], as: "recent" } },
    ]);
  });

  it("stream head + chain ending in .filter — chain ORDER preserved ([$sort,$limit,$match], not filter-first)", () => {
    expect(jsmql("$.recent = $$$.orders.toSorted({ createdAt: -1 }).take(200).filter(o => o.qty > 1);")).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 200 }, { $match: { qty: { $gt: 1 } } }],
          as: "recent",
        },
      },
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
          as: "recent",
        },
      },
    ]);
  });

  it("a .filter anywhere in the chain (not just head) becomes a $match — double filter collapses to two $match", () => {
    expect(jsmql('$.paid = $$$.orders.filter(o => o.qty > 1).filter(o => o.status === "paid");')).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [{ $match: { qty: { $gt: 1 } } }, { $match: { status: "paid" } }],
          as: "paid",
        },
      },
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
                $nor: [
                  {
                    $expr: {
                      $and: [
                        { $ne: [{ $ifNull: ["$cancelled", null] }, null] },
                        { $ne: ["$cancelled", false] },
                        { $ne: ["$cancelled", ""] },
                        { $ne: ["$cancelled", 0] },
                      ],
                    },
                  },
                ],
              },
            },
            { $limit: 5 },
          ],
          as: "kept",
        },
      },
    ]);
  });

  it("a single stream-method head still rejects an unknown method with a didYouMean suggestion", () => {
    expect(() => jsmql("$.x = $$$.orders.toSrted({ createdAt: -1 });")).toThrow(
      "Unknown method '.toSrted()' at position 16. Did you mean '.toSorted()'?",
    );
  });

  it("a cross-database stream-method head is still rejected at the chain base", () => {
    expect(() => jsmql("$.x = $$$$.other.orders.toSorted({ x: -1 });")).toThrow(
      "A read of another DATABASE isn't supported: '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    );
  });
});

describe("$$$.coll stream chains — HR3 / consistency guards (from adversarial review)", () => {
  // Each of these emitted invalid or wrong MQL before the generic-head change fixed them;
  // verified against a live mongod. See docs/DEVLOG.md.
  it("a lone shorthand .filter({obj}) head lowers exactly like the equivalent arrow", () => {
    // The shorthand is rewritten to its arrow by the desugar pass, before any road
    // reads it, so it takes the same direct-lookup path — including the
    // `as: "x"` write straight to the destination field (no tmp slot, no trailing
    // `$set`/`$unset`) that the arrow form has always had.
    expect(jsmql("$.x = $$$.orders.filter({ uid: 1 });")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { uid: 1 } }], as: "x" } },
    ]);
    expect(jsmql("$.x = $$$.orders.filter({ uid: 1 });")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { uid: 1 } }], as: "x" } },
    ]);
  });

  // Spelling must never change the emitted MQL. The desugar pass rewrites a shorthand
  // predicate to its arrow before the join road reads it, so `.filter({ userId: $._id })`
  // earns the same indexed `localField`/`foreignField` `$lookup` its arrow twin does, and
  // `.length` on it the same `$size` materialisation. A road that read the two apart would
  // give one of them a strictly worse plan for the same meaning. Verified against a live mongod.
  const SPELLINGS: ReadonlyArray<readonly [string, string]> = [
    ["matches-object", `{ userId: $._id }`],
    ["matchesProperty", `["userId", $._id]`],
  ];
  for (const [label, shorthand] of SPELLINGS) {
    it(`a ${label} predicate lowers identically to its arrow — indexed basic form, $size .length`, () => {
      const arrow = (pred: string) => `let n = $$$.orders.filter(${pred}).length; $project({ n });`;
      expect(jsmql(arrow(shorthand))).toEqual(jsmql(arrow("o => o.userId === $._id")));
    });

    it(`a ${label} predicate hits the same Filter-mode gate as its arrow`, () => {
      // Detection drives the mode gate too: an undetected shorthand falls through
      // to the generic "bare '$$$' reference" error instead of the actionable
      // "requires Pipeline mode" one.
      expect(() => jsmql(`$$$.orders.filter(${shorthand}).length > 0`)).toThrow(/needs Pipeline mode/);
    });
  }

  it("an uncorrelated $lookup omits `let` entirely, whatever assembled it", () => {
    // `let` is optional to the server, so an empty `let: {}` is pure noise. Deciding
    // the rule per emission site would make these four disagree for no semantic
    // reason, so `pipelineLookupBody` is the single decider.
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
    expect(lookupOf("$.x = $$$.orders.filter(o => o.uid === $._id && o.qty > 0);").let).toEqual(undefined);
  });

  it("a malformed shorthand still reports its own targeted error, not a lookup-shape one", () => {
    // `filterArgToLambda` returns null rather than throwing, so `validateLookupShape`
    // (which runs the throwing `shorthandToLambda`) stays the owner of the message.
    expect(() => jsmql("$.x = $$$.orders.filter({});")).toThrow(
      "'.filter({ … })' matches a document by its fields, and '{}' names none. Write the field to match — '.filter({ status: \"paid\" })' — or an arrow — '.filter(d => d.status === \"paid\")'.",
    );
    expect(() => jsmql("$.x = $$$.orders.filter([1, 2]);")).toThrow(
      "'.filter([field, value])' matches one field against one value. It takes exactly two elements, and the first is a field-name string: '.filter([\"status\", \"paid\"])'. An arrow says the same thing: '.filter(d => d.status === \"paid\")'.",
    );
  });

  it(".slice(a, a) (empty window) emits $match:{$expr:false}, never the server-rejected $limit:0", () => {
    expect(jsmql("$.top = $$$.orders.slice(0, 0);")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { $expr: false } }], as: "top" } },
    ]);
  });

  it("a no-statement / const-only block-body .map value-extracts identically to the expression form", () => {
    // `o => { return o.total }` is valid JS, identical to `o => o.total` (and to the same
    // block on an in-document array). On a stream it's PARSED as a stage-less sub-pipeline
    // block, but must lower to the SAME value-mode $map — never a scalar $replaceWith.
    // Verified on a live mongod.
    const asExpr = jsmql("$.x = $$$.orders.map(o => o.total);");
    expect(jsmql("$.x = $$$.orders.map(o => { return o.total; });")).toEqual([
      { $lookup: { from: "orders", pipeline: [], as: "__jsmql.tmp.0" } },
      { $set: { x: { $map: { input: "$__jsmql.tmp.0", as: "o", in: "$$o.total" } } } },
      { $unset: "__jsmql" },
    ]);
    expect(jsmql("$.x = $$$.orders.map(o => { const y = o.total; return y; });")).toEqual([
      { $lookup: { from: "orders", pipeline: [], as: "__jsmql.tmp.0" } },
      {
        $set: {
          x: { $map: { input: "$__jsmql.tmp.0", as: "o", in: { $let: { vars: { y: "$$o.total" }, in: "$$y" } } } },
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("a stage in a value-position `.map` block names the value position, not just the method", () => {
    // The stage rejection is the same rule everywhere, but the rewrite is
    // position-accurate: consumed as a value, the chain lowers to an array operator
    // with nowhere to run stages at all. Both named rewrites compile (asserted below).
    expect(() => jsmql("$.x = $$$.orders.map(o => { $sort({ x: -1 }); return o.total; });")).toThrow(
      "`$sort(...)` at position 28 is a pipeline stage, and the 'return' at position 46 makes this block a value callback. One block cannot be both. Move the stages to '.aggregate((o) => { $sort(...); … })', which takes a block of stages and no 'return'; or delete the stage and fold its work into the 'return'. Over the stream a stage is also a chain link: '$$.$sort(…)'.",
    );
    expect(() => jsmql("$.x = $$$.orders.map(o => { $sort({ x: -1 }); return o.total; });")).toThrow(
      "`$sort(...)` at position 28 is a pipeline stage, and the 'return' at position 46 makes this block a value callback. One block cannot be both. Move the stages to '.aggregate((o) => { $sort(...); … })', which takes a block of stages and no 'return'; or delete the stage and fold its work into the 'return'. Over the stream a stage is also a chain link: '$$.$sort(…)'.",
    );
    // Rewrite 1: stay a sub-pipeline and reshape with a stage — `$` inside the body is the OUTER document, which the body reads and never writes.
    expect(() =>
      jsmql(
        "$.x = $$$.orders.filter(o => o.uid === $._id).aggregate(o => { $sort({ x: -1 }); $replaceWith({ t: o.total }); });",
      ),
    ).not.toThrow();
    // Rewrite 2: move the stages into the heading `.aggregate` block.
    expect(() => jsmql("$.x = $$$.orders.aggregate(o => { $sort({ x: -1 }); }).map(o => o.total);")).not.toThrow();
  });

  it("the same rejection on a chained `.find` doesn't offer the `.map`-only rewrite", () => {
    expect(() => jsmql("$.x = $$$.orders.filter(o => o.uid === $._id).find(o => { $match(o.c); });")).toThrow(
      "`$match(...)` is a pipeline stage, not part of a callback — a callback's block holds declarations and a 'return'. Move the stages to '.aggregate((o) => { $match(...); … })', the one method whose block is a list of stages. Over the stream a stage is also a chain link: '$$.$match(…)'. at position 58",
    );
    expect(() => jsmql("$.x = $$$.orders.filter(o => o.uid === $._id).find(o => { $match(o.c); });")).not.toThrow(
      /`return` a document/,
    );
  });

  it("a .map after an object-collapsing terminal (.countBy) is rejected, not mis-assembled", () => {
    expect(() => jsmql('$.x = $$$.orders.filter(o => o.uid === $._id).countBy("uid").map(v => v);')).toThrow(
      "'.map()' is not available on a 'object' — it is defined on 'array', 'stream'.",
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
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $group: { _id: { $month: "$createdAt" }, total: { $sum: "$amount" } } }, { $sort: { _id: 1 } }],
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
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $sort: { placedAt: -1 } }, { $limit: 5 }],
          as: "recentOrders",
        },
      },
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
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $group: { _id: "$productId" } }],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { n: { $size: "$__jsmql.tmp.0" } } },
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

  it("refuses <coll>.length in a body that groups — the stamp is dropped with the fields", () => {
    // `$group` keeps no field the input carried, so the stamped count is gone and the
    // assertion read a missing value: it fired on every document, empty or not.
    expect(() =>
      jsmql('$.g = $$$.c.aggregate((o, _i, coll) => { $group({ _id: "$s" }); assert(coll.length > 0, "empty"); });'),
    ).toThrow(/'coll' is the body's own stream, and this body runs '\$group'/);
  });

  it("array form correlates: an outer $. ref inside $expr auto-lets into $lookup.let", () => {
    expect(
      jsmql('$.x = $$$.orders.aggregate([{ $match: { $expr: { $eq: ["$userId", $._id] } } }, { $sort: { a: 1 } }]);'),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $sort: { a: 1 } }],
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

describe("$$$.coll.<streamMethod>….aggregate(pipeline) — lodash chain into a sub-pipeline", () => {
  // `.aggregate` is a registered stream method, so it composes with the lodash
  // chain in BOTH directions: lodash stages before it, lodash stages after it,
  // all peeled into the one `$lookup.pipeline` in source order.
  const chainLookup = (pipeline: object[], as = "__jsmql.tmp.0", field = "r") => [
    { $lookup: { from: "orders", pipeline, as } },
    { $set: { [field]: `$${as}` } },
    { $unset: "__jsmql" },
  ];

  it("sort + take then .aggregate — lodash stages lead, aggregate stages follow", () => {
    expect(
      jsmql(
        "$.top = $$$.orders.sort({ createdAt: -1 }).take(1000).aggregate((o) => { $group({ _id: o.status, n: $sum(1) }); });",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 1000 }, { $group: { _id: "$status", n: { $sum: 1 } } }],
          as: "top",
        },
      },
    ]);
  });

  it("comparator .toSorted then .aggregate", () => {
    expect(
      jsmql("$.r = $$$.orders.toSorted((a, b) => a.total - b.total).aggregate((o) => { $group({ _id: o.status }); });"),
    ).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $sort: { total: 1 } }, { $group: { _id: "$status" } }], as: "r" } },
    ]);
  });

  it("the stage-array argument form works after a lodash chain too", () => {
    expect(jsmql('$.r = $$$.orders.sortBy("total").drop(2).aggregate([{ $group: { _id: "$status" } }]);')).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [{ $sort: { total: 1 } }, { $skip: 2 }, { $group: { _id: "$status" } }],
          as: "r",
        },
      },
    ]);
  });

  it("a document-reshaping lodash method (.flatMap → $unwind) then .aggregate", () => {
    expect(
      jsmql("$.r = $$$.orders.flatMap(o => o.items).aggregate((o) => { $group({ _id: null, n: $sum(1) }); });"),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [{ $unwind: "$items" }, { $group: { _id: null, n: { $sum: 1 } } }],
          as: "r",
        },
      },
    ]);
  });

  it("lodash methods AFTER .aggregate keep extending the same sub-pipeline", () => {
    expect(
      jsmql(
        "$.r = $$$.orders.sort({ t: -1 }).aggregate((o) => { $group({ _id: o.status, n: $sum(1) }); }).sort({ n: -1 }).take(3);",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [
            { $sort: { t: -1 } },
            { $group: { _id: "$status", n: { $sum: 1 } } },
            { $sort: { n: -1 } },
            { $limit: 3 },
          ],
          as: "r",
        },
      },
    ]);
  });

  it("a stage-link may head the chain ahead of .aggregate", () => {
    expect(
      jsmql("$.r = $$$.orders.$match({ total: { $gt: 0 } }).aggregate((o) => { $group({ _id: o.status }); });"),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [{ $match: { total: { $gt: 0 } } }, { $group: { _id: "$status" } }],
          as: "r",
        },
      },
    ]);
  });

  it("a correlating .filter ahead of the lodash chain hoists into $lookup.let", () => {
    expect(
      jsmql(
        "$.r = $$$.orders.filter(o => o.userId === $._id).sort({ t: -1 }).take(2).aggregate((o) => { $group({ _id: o.status }); });",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $sort: { t: -1 } }, { $limit: 2 }, { $group: { _id: "$status" } }],
          as: "r",
        },
      },
    ]);
  });

  it("an outer `$.` ref inside the .aggregate block hoists into $lookup.let", () => {
    expect(
      jsmql(
        "$.r = $$$.orders.sort({ t: -1 }).take(5).aggregate((o) => { $match(o.userId === $._id); $group({ _id: o.status }); });",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [
            { $sort: { t: -1 } },
            { $limit: 5 },
            { $match: { $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } },
            { $group: { _id: "$status" } },
          ],
          as: "r",
        },
      },
    ]);
  });

  it("the 3rd 'collection' param binds the sub-stream count after a lodash chain", () => {
    expect(
      jsmql(
        "$.r = $$$.orders.sort({ t: -1 }).take(3).aggregate((o, _i, coll) => { $addFields({ n: coll.length }); });",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [
            { $sort: { t: -1 } },
            { $limit: 3 },
            { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
            { $addFields: { n: "$__jsmql.length" } },
            { $unset: "__jsmql" },
          ],
          as: "r",
        },
      },
    ]);
  });

  it("`$$ =` source-switch: the whole chain becomes the $unionWith sub-pipeline", () => {
    expect(jsmql("$$ = $$$.orders.sort({ t: -1 }).take(3).aggregate((o) => { $group({ _id: o.status }); });")).toEqual([
      { $match: { $expr: false } },
      {
        $unionWith: { coll: "orders", pipeline: [{ $sort: { t: -1 } }, { $limit: 3 }, { $group: { _id: "$status" } }] },
      },
    ]);
  });

  it("a chained terminal reads the aggregate result as a value (.length / .map)", () => {
    expect(jsmql("$.n = $$$.orders.sort({ t: -1 }).aggregate((o) => { $group({ _id: o.status }); }).length;")).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [{ $sort: { t: -1 } }, { $group: { _id: "$status" } }],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { n: { $size: "$__jsmql.tmp.0" } } },
      { $unset: "__jsmql" },
    ]);
    expect(
      jsmql("$.ids = $$$.orders.sort({ t: -1 }).aggregate((o) => { $group({ _id: o.status }); }).map(g => g._id);"),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [{ $sort: { t: -1 } }, { $group: { _id: "$status" } }],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { ids: { $map: { input: "$__jsmql.tmp.0", as: "g", in: "$$g._id" } } } },
      { $unset: "__jsmql" },
    ]);
  });

  // An `.aggregate` HEAD peels its chain exactly like a `.filter` / lodash head.
  // Gating the peel on the head method made the emitted shape depend on which
  // emission site ran: `.pick` read `$getField` off the result ARRAY (returning
  // `{}`), and `.omit`'s `$objectToArray` over an array was rejected outright by
  // mongod — while one preceding `.sort()` lowered both to a clean `$project`.
  describe("an .aggregate head lowers the same as an .aggregate link", () => {
    it(".take peels to $limit in the sub-pipeline, not $slice on the result", () => {
      expect(jsmql("$.r = $$$.orders.aggregate((o) => { $sort({ total: -1 }); }).take(5);")).toEqual([
        { $lookup: { from: "orders", pipeline: [{ $sort: { total: -1 } }, { $limit: 5 }], as: "r" } },
      ]);
    });

    it(".pick / .omit peel to $project (they need a document receiver, not the array)", () => {
      expect(jsmql('$.r = $$$.orders.aggregate((o) => { $sort({ total: -1 }); }).pick(["status"]);')).toEqual([
        {
          $lookup: {
            from: "orders",
            pipeline: [{ $sort: { total: -1 } }, { $project: { status: 1, _id: 0 } }],
            as: "r",
          },
        },
      ]);
      expect(jsmql('$.r = $$$.orders.aggregate((o) => { $sort({ total: -1 }); }).omit(["total"]);')).toEqual([
        { $lookup: { from: "orders", pipeline: [{ $sort: { total: -1 } }, { $project: { total: 0 } }], as: "r" } },
      ]);
    });

    it(".sort after an .aggregate head is a stream sort, not the array-mutating one", () => {
      expect(
        jsmql("$.r = $$$.orders.aggregate((o) => { $group({ _id: o.status, n: $sum(1) }); }).sort({ n: -1 });"),
      ).toEqual([
        {
          $lookup: {
            from: "orders",
            pipeline: [{ $group: { _id: "$status", n: { $sum: 1 } } }, { $sort: { n: -1 } }],
            as: "r",
          },
        },
      ]);
    });

    it("a second .aggregate appends its stages instead of reporting an unknown method", () => {
      expect(
        jsmql("$.r = $$$.orders.aggregate((o) => { $limit(3); }).aggregate((o) => { $group({ _id: o.status }); });"),
      ).toEqual([{ $lookup: { from: "orders", pipeline: [{ $limit: 3 }, { $group: { _id: "$status" } }], as: "r" } }]);
    });

    it("head and link forms agree stage-for-stage on the shared tail", () => {
      const head = jsmql('$.r = $$$.orders.aggregate((o) => { $sort({ total: -1 }); }).take(2).uniqBy("status");');
      const link = jsmql('$.r = $$$.orders.sort({ total: -1 }).aggregate((o) => { $limit(2); }).uniqBy("status");');
      expect(head).toEqual([
        {
          $lookup: {
            from: "orders",
            pipeline: [
              { $sort: { total: -1 } },
              { $limit: 2 },
              { $group: { _id: "$status", __jsmqlTmp: { $first: "$$ROOT" } } },
              { $replaceWith: "$__jsmqlTmp" },
            ],
            as: "r",
          },
        },
      ]);
    });
  });

  // Argument-shape and param errors must read the same whether `.aggregate` sits
  // at the head or after a lodash chain — the two call positions share
  // `validateAggregateArg` / `validateAggregateParams` precisely so they can't drift.
  describe("argument errors match the head form's wording", () => {
    const pairs: [string, string, RegExp][] = [
      ["expression body", "(o) => o.total", /takes an arrow whose body is a block of stages/],
      ["trailing return", "(o) => { $limit(2); return o.total; }", /is a pipeline stage/],
      ["4 params", "(a, b, c, d) => { $limit(1); }", /callbacks take at most 3 parameters/],
      ["index param used", "(o, i) => { $addFields({ k: i }); }", /has no value inside `\.aggregate\(\)`/],
      ["coll param beyond .length", "(o, _i, c) => { $addFields({ k: c.total }); }", /the body's own stream|only 'c/],
    ];
    for (const [label, arg, re] of pairs) {
      it(`${label} — rejected at both call positions`, () => {
        expect(() => jsmql(`$.r = $$$.orders.aggregate(${arg});`)).toThrow(re);
        expect(() => jsmql(`$.r = $$$.orders.sort({ t: 1 }).aggregate(${arg});`)).toThrow(re);
      });
    }

    it("both positions carry a real .pos for tooling", () => {
      for (const src of [
        "$.r = $$$.orders.aggregate((o) => o.total);",
        "$.r = $$$.orders.sort({ t: 1 }).aggregate((o) => o.total);",
      ]) {
        const res = jsmql.validate(src);
        expect(res.valid).toBe(false);
        expect(res.errors[0].pos).toBeGreaterThan(0);
      }
    });
  });
});

describe("$$$.coll.aggregate — error cases", () => {
  it("expression-body arrow is rejected (needs block or array)", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate(o => o.v);")).toThrow(/takes an arrow whose body is a block of stages/);
  });

  it("a used index (2nd) param is rejected", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate((o, i) => { $match(o.n === i); });")).toThrow(
      "`i` has no value inside `.aggregate()` — a stream has no per-document index; leave the parameter unused.",
    );
  });

  it("non-.length use of the 3rd 'collection' param is rejected", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate((o, _i, coll) => { $match(o.n === coll[0]); });")).toThrow(
      "'coll' is the body's own stream, and this body runs '$match', which changes what its count means — 'coll.length' is stamped into a field ahead of the body, and that stage either drops the field or changes how many documents there are. Only a stage that leaves both alone keeps the count true. Take the count in a statement ahead of this chain, or drop 'coll' from the parameter list.",
    );
  });

  it("a spread element in the array form is rejected", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate([{ $sort: { a: 1 } }, ...$.more]);")).toThrow(
      "A pipeline is written out stage by stage; '...' cannot spread stages into it. List each stage.",
    );
  });

  it("an empty pipeline is rejected (array form; the arrow form's empty block is a parse error)", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate([]);")).toThrow(
      "'.aggregate()' needs at least one stage — an empty list has none. List the stages — '.aggregate([$match(…), $sort(…)])' — or drop the '.aggregate()' link.",
    );
  });

  it("$$.aggregate (current stream) appends its stages to the chain, in every container", () => {
    // On `$$` the block's statements are simply the chain's stages. A `$facet` branch
    // is the container that needs it: a branch IS a sub-pipeline, so there is no
    // "write them directly" spelling to redirect to.
    expect(jsmql("$$.aggregate((o) => { $group({ _id: o.s }); });")).toEqual([{ $group: { _id: "$s" } }]);
    expect(jsmql("$$ = $$.aggregate((o) => { $match(o.a === 1); $limit(3); });")).toEqual([
      { $match: { a: 1 } },
      { $limit: 3 },
    ]);
    expect(jsmql("$ = { byStatus: $$.aggregate((o) => { $group({ _id: o.s, n: $sum(1) }); }) };")).toEqual([
      { $facet: { byStatus: [{ $group: { _id: "$s", n: { $sum: 1 } } }] } },
    ]);
    expect(jsmql("$$$.dest = $$.aggregate((o) => { $match(o.a === 1); });")).toEqual([
      { $match: { a: 1 } },
      { $out: "dest" },
    ]);
  });

  it("a `$.<field>` read inside `$$.aggregate` names `.aggregate`, not `.map`", () => {
    expect(jsmql("$$$.dest = $$.aggregate(o => { $match($.x === 1); });")).toEqual([
      { $match: { x: 1 } },
      { $out: "dest" },
    ]);
  });

  it("$ = replace-root with an aggregate (array) is rejected", () => {
    expect(() => jsmql('$ = $$$.c.aggregate((o) => { $group({ _id: "$s" }); });')).toThrow(
      "The document can only become ONE document, and this chain gives an array. Write '$ = $$$.<coll>.find(pred)' for the first match, or keep the array in a field: '$.<field> = $$$.<coll>.…'.",
    );
  });

  it("an uncorrelated aggregate is unioned into the stream as the $unionWith sub-pipeline", () => {
    expect(jsmql("$$.push(...$$$.c.aggregate((o) => { $group({ _id: o.s }); }));")).toEqual([
      { $unionWith: { coll: "c", pipeline: [{ $group: { _id: "$s" } }] } },
    ]);
  });

  it("a CORRELATED aggregate can't be unioned — $unionWith has no `let` slot", () => {
    expect(() => jsmql("$$.push(...$$$.c.aggregate((o) => { $match(o.uid === $._id); }));")).toThrow(
      "'$unionWith' has no 'let': its body cannot read the outer document or a binding declared outside it. Filter or reshape the outer stream in a statement before it, or read the other collection through a join ('$.<field> = $$$.<coll>.filter(…)'), whose '$lookup' carries the value.",
    );
  });

  it("cross-database aggregate read is rejected", () => {
    expect(() => jsmql("$.x = $$$$.db.c.aggregate((o) => { $sort({ a: 1 }); });")).toThrow(
      "A read of another DATABASE isn't supported: '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    );
  });

  it("aggregate syntax outside Pipeline mode is rejected", () => {
    expect(() => jsmql("$$$.c.aggregate((o) => { $limit(5); })")).toThrow(
      "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = $$$.<coll>.…'), bind it ('let x = $$$.<coll>.…'), or make it the stream ('$$ = $$$.<coll>.…').",
    );
  });

  // The message names the `$$$.<coll>` HEAD, never the methods that may follow
  // it — that set grows (`.find`/`.filter`, `.aggregate`, every lodash stream
  // method, every chained stage call) and an enumeration goes stale on each
  // addition. Every head therefore gets the identical rejection.
  it("every chain head gets the same Pipeline-mode rejection (no method enumeration)", () => {
    for (const src of [
      "$$$.c.find(o => o.a === 1)",
      "$$$.c.filter(o => o.a === 1)",
      "$$$.c.aggregate((o) => { $limit(5); })",
      "$$$.c.toSorted({ a: 1 }).take(5)",
      "$$$.c.$match({ a: 1 })",
    ]) {
      expect(() => jsmql(src), src).toThrow(/needs Pipeline mode|gives it no destination/);
    }
  });

  it("a trailing `return` inside an aggregate block is rejected (it's not a per-doc reshape)", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate((o) => { $sort({ a: 1 }); return o.v; });")).toThrow(
      "`$sort(...)` at position 31 is a pipeline stage, and the 'return' at position 48 makes this block a value callback. One block cannot be both. Move the stages to '.aggregate((o) => { $sort(...); … })', which takes a block of stages and no 'return'; or delete the stage and fold its work into the 'return'. Over the stream a stage is also a chain link: '$$.$sort(…)'.",
    );
  });

  it(".aggregate chained on a .find() result is rejected (scalar, not a collection)", () => {
    expect(() => jsmql("$.x = $$$.c.find(o => o.x === 1).aggregate((o) => { $sort({ a: 1 }); });")).toThrow(
      "'.aggregate()' produces pipeline stages, not a value.",
    );
  });

  // `.aggregate` needs a document STREAM. On a receiver the chain already reduced
  // to a value, the generic value-mode path would answer a bare "Unknown method
  // '.aggregate()'" and leave the user nowhere; the tailored message says what the
  // receiver became, matching the sibling `.find()` case.
  describe("on a receiver the chain already collapsed to a value", () => {
    const collapsed = [
      ["head()", ".head()"],
      ["size()", ".size()"],
      ["last()", ".last()"],
      ["nth(1)", ".nth(...)"],
      ["sum()", ".sum()"],
      ["maxBy('total')", ".maxBy(...)"],
      ["every(o => o.v > 0)", ".every(...)"],
      ["reduce((a, o) => a + o.v, 0)", ".reduce(...)"],
      ["at(0)", ".at(...)"],
    ];
    for (const [link, spelling] of collapsed) {
      it(`.${link} names the offending link and the rewrite`, () => {
        const spelled = spelling.replace(/[.()[\]]/g, "\\$&");
        void spelled;
        expect(() => jsmql(`$.x = $$$.orders.${link}.aggregate((o) => { $limit(1); });`)).toThrow(
          /'\.aggregate\(\)' produces pipeline stages, not a value/,
        );
      });
    }

    it("a field read (.length / .<field>) and an index are named the same way", () => {
      expect(() => jsmql("$.x = $$$.orders.filter(o => o.v > 0).length.aggregate((o) => { $limit(1); });")).toThrow(
        "A read of another collection is a chain on '$$$.<coll>': '.find(pred)', '.filter(pred)', '.aggregate(o => { … })', a stream method or a stage link.",
      );
      expect(() => jsmql("$.x = $$$.orders.filter(o => o.v > 0)[0].aggregate((o) => { $limit(1); });")).toThrow(
        "A read of another collection is a chain on '$$$.<coll>': '.find(pred)', '.filter(pred)', '.aggregate(o => { … })', a stream method or a stage link.",
      );
    });

    it("the suggested collection spelling follows a cross-database receiver", () => {
      expect(() => jsmql("$.x = $$$$.dw.orders.head().aggregate((o) => { $limit(1); });")).toThrow(
        "A read of another DATABASE isn't supported: '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
      );
    });

    it("a still-a-stream chain is untouched, at any depth", () => {
      expect(() =>
        jsmql("$.x = $$$.orders.filter(o => o.v > 0).sort({ t: 1 }).aggregate((o) => { $limit(1); });"),
      ).not.toThrow();
      // A value terminal AFTER the aggregate is the valid direction.
      expect(() => jsmql("$.x = $$$.orders.aggregate((o) => { $limit(3); }).head();")).not.toThrow();
    });

    it("carries a .pos for tooling", () => {
      const res = jsmql.validate("$.x = $$$.orders.head().aggregate((o) => { $limit(1); });");
      expect(res.valid).toBe(false);
      expect(res.errors[0].pos).toBeGreaterThan(0);
    });
  });

  // A `$$$.<coll>` stream is a stream of DOCUMENTS, so an element-returning value
  // terminal on it always yields a document — and `$map` / `$filter` / `$slice` /
  // `$trim` over a document is a shape mongod refuses at execution time. Emitting
  // it would break HR3, so these shapes are refused before they reach the server.

  describe("a value terminal over a joined stream gives ONE DOCUMENT, and the array methods are refused on it", () => {
    // Every terminal whose row answers `returns: "element"`. The slot holds the
    // foreign collection's documents, so the element is a document.
    for (const terminal of [
      "head()",
      "first()",
      "last()",
      "at(0)",
      "nth(1)",
      "findLast(o => o.total > 1)",
      "min()",
      "max()",
      'minBy("total")',
      'maxBy("total")',
    ]) {
      it(`refuses '.map()' after '.${terminal}'`, () => {
        expect(() => jsmql(`$.r = $$$.orders.${terminal}.map(x => x);`)).toThrow(
          /'\.map\(\)' is not available on a 'object'/,
        );
      });
    }

    // Every method family the server refuses over a document, each with its own operator.
    for (const [method, spelling] of [
      ["filter", ".filter(x => x.total > 1)"],
      ["some", ".some(x => x.total > 1)"],
      ["join", '.join(",")'],
      ["reduce", ".reduce((a, b) => a + b, 0)"],
      ["flat", ".flat()"],
      ["sum", ".sum()"],
      ["take", ".take(1)"],
      ["includes", ".includes(1)"],
    ]) {
      it(`refuses '${method}' on the document a terminal gives`, () => {
        expect(() => jsmql(`$.r = $$$.orders.head()${spelling};`)).toThrow(
          new RegExp(`'\\.${method}\\(\\)' is not available on a 'object'`),
        );
      });
    }

    it("names the way out: a field of the document, or no terminal at all", () => {
      expect(() => jsmql("$.r = $$$.orders.head().map(x => x);")).toThrow(
        /A document is not a list: read one of its fields \('\.<field>'\), or drop the terminal/,
      );
    });

    it("a field read and a document method on the same terminal still compile", () => {
      expect(jsmql("$.r = $$$.orders.head().total;")).toEqual([
        { $lookup: { from: "orders", pipeline: [], as: "__jsmql.tmp.0" } },
        { $set: { r: { $getField: { field: "total", input: { $first: "$__jsmql.tmp.0" } } } } },
        { $unset: "__jsmql" },
      ]);
    });

    it("a link that REPLACES the elements leaves them unproven, so the array methods stay open", () => {
      // `.map` peels into the sub-pipeline and the slot still holds documents; the
      // proof belongs to the binding, and only a plain read of it carries one.
      expect(() => jsmql("$.r = $$$.orders.map(o => ({ t: o.total })).head().t;")).not.toThrow();
    });

    it("a field path proves nothing, so an in-document array keeps its methods", () => {
      // SR2: `$.items` has no provable type, so `.head()` over it is not a document.
      expect(() => jsmql("$.r = $.items.head().map(x => x);")).not.toThrow();
    });
  });

  it("$$ = source-switch rejects an outer-doc $. reference (no let slot)", () => {
    expect(jsmql('$$ = $$$.orders.aggregate((o) => { $match(o.userId === $._id); $group({ _id: "$s" }); });')).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $group: { _id: "$s" } }],
          as: "__jsmql.tmp.0",
        },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
  });

  it("the chained form (.filter(p).aggregate(bad)) validates via the same rules", () => {
    // The row's own callback rule answers, whether the chain heads at the collection or peels first.
    expect(() => jsmql("$.x = $$$.c.filter(o => o.v > 1).aggregate(o => o.v);")).toThrow(
      "'.aggregate()' takes an arrow whose body is a block of stages — 'o => { $match(…); $limit(1); }' — or a bracketed list of them.",
    );
    expect(() => jsmql("$.x = $$$.c.filter(o => o.v > 1).aggregate((o, i) => { $match(o.n === i); });")).toThrow(
      "`i` has no value inside `.aggregate()` — a stream has no per-document index; leave the parameter unused.",
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
          as: "__jsmql.var.top",
        },
      },
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
    expect(subPipeline(chained)).toEqual([{ $match: { x: 1 } }]);
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
          as: "t",
        },
      },
    ]);
  });

  // …and in a query-document `$match` body it is re-expressed as a predicate
  // first, because MongoDB doesn't evaluate `$$` vars in the query language —
  // a raw `{ $match: { userId: "$$jsmql_f0__id" } }` is accepted by the server
  // and silently matches nothing (verified live). Whatever `.filter(...)` emits for
  // the same predicate, `.$match` emits too — byte for byte.
  it("re-expresses a correlated query-document $match as a predicate", () => {
    // A lone `.$match(<plain equality map>)` IS `.filter(<matches object>)` — same
    // predicate, so it normalises to `filter` in `detectLookupCall` and earns the
    // same indexed basic form, not a correlated sub-pipeline.
    const stageLink = jsmql("$.t = $$$.orders.$match({ userId: $._id });");
    expect(stageLink).toEqual([{ $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "t" } }]);
    expect(stageLink).toEqual([{ $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "t" } }]);
  });

  // Uncorrelated terms stay in index-friendly query form; only the correlated
  // ones move into `$expr` — again matching `.filter({ … })` exactly.
  it("splits a mixed correlated/plain query-document $match like .filter does", () => {
    const stageLink = jsmql('$.t = $$$.orders.$match({ userId: $._id, status: "shipped" });');
    expect(stageLink).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $match: { status: "shipped" } }],
          as: "t",
        },
      },
    ]);
    expect(stageLink).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $match: { status: "shipped" } }],
          as: "t",
        },
      },
    ]);
  });

  it("an operator-bearing $match body is NOT converted — it isn't a lodash matcher", () => {
    // `{ qty: { $gt: 5 } }` as a QUERY means "greater than 5"; as a lodash
    // matches-object it would mean "equals the object { $gt: 5 }". Different
    // meanings, so `.$match` keeps the query form and `.filter` keeps the equality.
    expect(jsmql("$.t = $$$.orders.$match({ qty: { $gt: 5 } });")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { qty: { $gt: 5 } } }], as: "t" } },
    ]);
    expect(jsmql("$.t = $$$.orders.filter({ qty: { $gt: 5 } });")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { "qty.$gt": 5 } }], as: "t" } },
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
          as: "t",
        },
      },
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
    expect(jsmql('$.t = $$$.orders.$match({ status: "shipped" });')).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { status: "shipped" } }], as: "t" } },
    ]);
  });

  // The `$expr` escape hatch is the supported hand-written correlation, and
  // `$$vars` DO resolve inside it — the guard must not fire there.
  it("allows an outer-document read inside the $expr escape hatch", () => {
    expect(jsmql('$.t = $$$.orders.$match({ $expr: { $eq: ["$userId", $._id] } });')).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "t" } },
    ]);
  });

  // The `.aggregate(...)` block spelling correlates through the same path, so it
  // cannot fall back to the raw query form, which matches nothing in silence.
  it("correlates a query-document $match inside an .aggregate(...) block", () => {
    expect(jsmql("$.orders = $$$.orders.aggregate((o) => { $match({ userId: $._id }); });")).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "orders" } },
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
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { "__jsmql.var.ids": { $map: { input: "$__jsmql.tmp.0", as: "x", in: "$$x.productIds" } } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("lowers stage links into a $unionWith source-switch", () => {
    expect(jsmql("$$ = $$$.orders.$match({ a: 1 }).$limit(2);")).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "orders", pipeline: [{ $match: { a: 1 } }, { $limit: 2 }] } },
    ]);
  });

  // Placement rules are the declarative `forbiddenIn` fact on the stage's row —
  // the same source the statement path reads.
  it("rejects a stage forbidden inside a $lookup sub-pipeline", () => {
    expect(() => jsmql("$.t = $$$.orders.$out('archive');")).toThrow(
      "'$out' cannot stand inside '$lookup' — the server refuses it in that body. Run it as a stage of the outer pipeline instead.",
    );
    expect(() => jsmql("$.t = $$$.orders.$merge({ into: 'archive' });")).toThrow(
      "'$merge' cannot stand inside '$lookup' — the server refuses it in that body. Run it as a stage of the outer pipeline instead.",
    );
  });

  it("rejects a must-be-first stage that isn't first in the chain", () => {
    expect(() => jsmql("$.t = $$$.orders.$match({ a: 1 }).$documents([{ x: 1 }]);")).toThrow(
      "'$documents' cannot stand inside '$lookup' — the server refuses it in that body. Append the documents to the stream instead ('$$.push({ a: 1 });'), or start the stream from them ('$$ = [{ a: 1 }, { a: 2 }];').",
    );
  });

  it("rejects an unknown stage name in a foreign chain with a suggestion", () => {
    expect(() => jsmql("$.t = $$$.orders.$sortt({ a: 1 });")).toThrow(
      "Unknown method '.$sortt()' at position 16. Did you mean '.sort()'?",
    );
  });
});

describe("$$$.coll — where the hoisted $lookup lands", () => {
  // A join in a callback reads the document that callback's STAGE receives, so the
  // `$lookup` stands directly ahead of that stage. Ahead of the whole statement it
  // would read the document the statement STARTED from — a different one as soon as
  // any stage between the two reshapes it. See docs/specs/lookup-stage.md § Where a
  // hoisted stage lands.
  it("lands after a stage that replaces the document with a group key", () => {
    expect(
      jsmql("$$.$sortByCount($.productIds).map(g => ({ _id: g._id, name: $$$.products.find({ _id: g._id }).name }));"),
    ).toEqual([
      { $sortByCount: "$productIds" },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          pipeline: [{ $limit: 1 }],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { "__jsmql.tmp.0": { $first: "$__jsmql.tmp.0" } } },
      { $replaceWith: { _id: "$_id", name: "$__jsmql.tmp.0.name" } },
    ]);
  });

  it("lands after a $replaceWith link, whose fields the join reads", () => {
    expect(
      jsmql('$$.$replaceWith({ k: "$pid" }).map(d => ({ k: d.k, name: $$$.products.find({ _id: d.k }).name }));'),
    ).toEqual([
      { $replaceWith: { k: "$pid" } },
      {
        $lookup: {
          from: "products",
          localField: "k",
          foreignField: "_id",
          pipeline: [{ $limit: 1 }],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { "__jsmql.tmp.0": { $first: "$__jsmql.tmp.0" } } },
      { $replaceWith: { k: "$k", name: "$__jsmql.tmp.0.name" } },
    ]);
  });

  it("lands after the write its key comes from, inside one `,`-joined run", () => {
    expect(jsmql("$.k = $.pid, $.name = $$$.products.find({ _id: $.k }).name;")).toEqual([
      { $set: { k: "$pid" } },
      {
        $lookup: {
          from: "products",
          localField: "k",
          foreignField: "_id",
          pipeline: [{ $limit: 1 }],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { "__jsmql.tmp.0": { $first: "$__jsmql.tmp.0" } } },
      { $set: { name: "$__jsmql.tmp.0.name" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("lands beside its own statement in a bracketed program", () => {
    expect(jsmql('[$group({ _id: "$pid" }), $set({ n: $$$.products.find({ _id: $._id }).name })]')).toEqual([
      { $group: { _id: "$pid" } },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          pipeline: [{ $limit: 1 }],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { "__jsmql.tmp.0": { $first: "$__jsmql.tmp.0" } } },
      { $set: { n: "$__jsmql.tmp.0.name" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("lands beside its own statement inside an .aggregate(...) block", () => {
    expect(
      jsmql(
        "$.o = $$$.orders.aggregate(o => { $set({ k: o.pid }); $set({ n: $$$.products.find({ _id: o.k }).name }); });",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [
            { $set: { k: "$pid" } },
            {
              $lookup: {
                from: "products",
                localField: "k",
                foreignField: "_id",
                pipeline: [{ $limit: 1 }],
                as: "__jsmql.tmp.0",
              },
            },
            { $set: { "__jsmql.tmp.0": { $first: "$__jsmql.tmp.0" } } },
            { $set: { n: "$__jsmql.tmp.0.name" } },
            { $unset: "__jsmql" },
          ],
          as: "o",
        },
      },
    ]);
  });

  // Only a stage can carry a `$lookup`, so a callback that binds its own element
  // has nowhere to put one: the body would read a variable the stage never bound.
  it("refuses a join whose body reads a variable an enclosing callback binds", () => {
    expect(() => jsmql("$.n = $.items.map(x => $$$.products.find({ _id: x.pid }).name);")).toThrow(
      "'x' is bound by an enclosing callback, and a read of another collection is a '$lookup' STAGE: the server runs it over the documents, outside that callback, where 'x' has no value. Make the elements documents first ('$$ = $.<array>;' — then each one is a document the join reads, '$.<field> = $$$.<coll>.find(…)'), or read the collection OUTSIDE the callback ('let <name> = $$$.<coll>.filter(…);') and use that binding inside it.",
    );
    // both spellings the message names do compile
    expect(jsmql("$$ = $.items; $.name = $$$.products.find({ _id: $.pid }).name;")).toEqual([
      { $set: { "__jsmql.tmp.0": "$items" } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
      {
        $lookup: {
          from: "products",
          localField: "pid",
          foreignField: "_id",
          pipeline: [{ $limit: 1 }],
          as: "__jsmql.tmp.1",
        },
      },
      { $set: { "__jsmql.tmp.1": { $first: "$__jsmql.tmp.1" } } },
      { $set: { name: "$__jsmql.tmp.1.name" } },
      { $unset: "__jsmql" },
    ]);
    expect(jsmql("let ps = $$$.products.filter(p => p.ok === true); $.n = $.items.map(x => ps.length);")).toEqual([
      { $lookup: { from: "products", pipeline: [{ $match: { ok: true } }], as: "__jsmql.var.ps" } },
      { $set: { n: { $map: { input: "$items", as: "x", in: { $size: "$__jsmql.var.ps" } } } } },
      { $unset: "__jsmql" },
    ]);
  });
});
