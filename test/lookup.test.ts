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
    expect(() => jsmql("$.orders = $$$.orders.filter(o => o.userId == $._id);")).toThrow(
      /'=='\s*is only allowed against null in JSMQL\. Use '==='/,
    );
  });
});

describe("$$$.coll.find/filter — a richer predicate: the pair, with the rest beside it", () => {
  it("a compound && predicate takes the pair from its equality and needs no `let`", () => {
    const out = jsmql("$.user = $$$.users.find(u => u._id === $.userId && u.active);");
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
    expect(jsmql('$.x = $$$.orders.filter(o => o.ref === $.meta["sub-id"] && o.qty > 0);')).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0_meta: "$meta" },
          pipeline: [
            {
              $match: {
                qty: { $gt: 0 },
                $expr: {
                  $eq: ["$ref", { $getField: { field: "sub-id", input: { $ifNull: ["$$jsmql_f0_meta", {}] } } }],
                },
              },
            },
          ],
          as: "x",
        },
      },
    ]);
  });

  it("two distinct fields that sanitize to the same var base stay distinct (`_2` suffix)", () => {
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
                    { $eq: ["$a", { $getField: { field: "sub-id", input: { $ifNull: ["$$jsmql_f0_meta", {}] } } }] },
                    { $eq: ["$b", { $getField: { field: "sub_id", input: { $ifNull: ["$$jsmql_f0_meta", {}] } } }] },
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

describe("$$$.coll.filter — block-body 3rd 'stream' param (sub-stream size)", () => {
  it("refuses <coll>.size() in a body that filters — the stamp is taken before the filter", () => {
    expect(() =>
      jsmql(`
        $.orders = $$$.orders.aggregate((o, i, ordersColl) => {
          $match(o.userId === $._id);
          assert(ordersColl.size() > 0, "User without orders is impossible");
        });
      `),
    ).toThrow(/'ordersColl' is the body's own stream\. This body runs '\$match'/);
  });

  it("a root `$.<field>` read inside a nested block-body lookup threads to the outermost let", () => {
    expect(
      jsmql(`
        $.a = $$$.A.aggregate(a => {
          a.c = $$$.C.aggregate(c => {
            $match(c.aId === a._id);
            assert(c.region === $.region, "region mismatch");
          });
        });
      `),
    ).toEqual([
      {
        $lookup: {
          from: "A",
          let: { jsmql_f0_region: "$region" },
          pipeline: [
            {
              $lookup: {
                from: "C",
                localField: "_id",
                foreignField: "aId",
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $convert: {
                          input: true,
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

  it("refuses a write to the outer document from inside a nested body", () => {
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
      "The outer document cannot be written from inside a body over another collection — only read. Write the body's own document through its callback parameter ('o.x = …', 'delete o.x', 'o = { … }'), or as a stage ('$set({ x: … })'). Write the outer field after the join.",
    );
  });

  it("rejects a USED index param in the block", () => {
    expect(() =>
      jsmql(`$.x = $$$.orders.aggregate((o, i, c) => { $match(o.userId === $._id); assert(i > 0, "x"); });`),
    ).toThrow(/has no value inside/);
  });

  it("rejects a use of the stream handle other than `.size()` in the block", () => {
    expect(() => jsmql(`$.x = $$$.orders.aggregate((o, i, c) => { o.first = c[0]; });`)).toThrow(
      "'c' is the body's own stream, the callback's third parameter: read its count ('c.size()') or chain on it ('c.filter(…)'). It is not a document or a value on its own.",
    );
  });

  it("counts an ancestor sub-stream on its OWN pipeline, and the body's own on this one", () => {
    expect(
      jsmql(`$.o = $$$.orders.aggregate((o, i, ordersColl) => {
        o.items = $$$.items.aggregate((t, k, itemsColl) => {
          t = { here: itemsColl.size(), up: ordersColl.size() };
        });
      });`),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [
            { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
            {
              $lookup: {
                from: "items",
                let: { jsmql_s1_size: "$__jsmql.size" },
                pipeline: [
                  { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
                  { $replaceWith: { here: "$__jsmql.size", up: "$$jsmql_s1_size" } },
                ],
                as: "items",
              },
            },
            { $unset: "__jsmql" },
          ],
          as: "o",
        },
      },
    ]);
  });

  it("keeps the ROOT count on the top-most pipeline, beside a handle's own", () => {
    expect(jsmql("$ = { peers: $$.filter(u => u.n === $$.size()) };")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $facet: { peers: [{ $match: { $expr: { $eq: ["$n", "$__jsmql.size"] } } }] } },
    ]);
    expect(jsmql("$$.aggregate((o, i, coll) => { $ = { a: $$.filter(x => x.n === coll.size()) }; });")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $facet: { a: [{ $match: { $expr: { $eq: ["$n", "$__jsmql.size"] } } }] } },
    ]);
  });

  it("a 3-param `.filter` predicate reads the stream count through its 3rd param", () => {
    expect(jsmql(`$.x = $$$.orders.filter((o, i, c) => c.size() > 0);`)).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [
            { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
            { $match: { $expr: { $gt: ["$__jsmql.size", 0] } } },
            { $unset: "__jsmql" },
          ],
          as: "x",
        },
      },
    ]);
  });
});

describe("$$$.coll.find/filter — chained terminals", () => {
  it("chained .size() on .filter produces $size + slot writeback", () => {
    const out = jsmql("let n = $$$.orders.filter(o => o.userId === $._id).size();");
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
    ).toThrow("'.reduce()' is not available on an 'object' — it is defined on 'array'.");
  });

  it("chained .size() is refused when the lookup is .find (one document has no .size())", () => {
    expect(() => jsmql("let n = $$$.users.find(u => u._id === $._id).size();")).toThrow(
      "'.size()' is not available on an 'object' — it is defined on 'array', 'stream'. For the number of fields, write '.keys().size()'.",
    );
  });

  it("member access on a .find result lowers through the materialised scalar slot", () => {
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
      let nOrders = $$$.orders.filter(o => o.userId === $._id).size();
      let nTx = $$$.tx.filter(t => t.userId === $._id).size();
    `);
    expect(out).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
      { $set: { "__jsmql.var.nOrders": { $size: "$__jsmql.tmp.0" } } },
      { $lookup: { from: "tx", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.1" } },
      { $set: { "__jsmql.var.nTx": { $size: "$__jsmql.tmp.1" } } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("$$$.coll.find/filter — error cases", () => {
  it("bare $$$ outside a chain points at the lookup and $out shapes", () => {
    expect(() => jsmql.expr("$$$.myColl")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`). It received a bare expression that would lower to a Filter (`$.age > 18`) instead. Use jsmql.filter() for a Filter, or wrap the predicate as `$match(…)` for a Pipeline.",
    );
  });

  it("wrong method on $$$.<coll> suggests .find / .filter / .aggregate through closestNameTo", () => {
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
    expect(() => jsmql("$.x = $$$.users.find(true);")).toThrow(
      "'.find()' takes a predicate here — an arrow ('d => …'), a field name ('\"status\"'), an index ('0'), a matcher object ('{ status: \"paid\" }'), or a '[field, value]' pair ('[\"status\", \"paid\"]'). Got a boolean.",
    );
  });

  it("`(element, index, array)` params are accepted unused, rejected when read", () => {
    expect(jsmql("$.x = $$$.users.find((u, i) => u._id === $.userId);")).toEqual([
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", pipeline: [{ $limit: 1 }], as: "x" } },
      { $set: { x: { $first: "$x" } } },
    ]);
    expect(() => jsmql("$.x = $$$.users.find((u, i) => i === 0);")).toThrow(
      "`i` has no value inside `.filter()` — a stream has no per-document index; leave the parameter unused.",
    );
    expect(() => jsmql("$.x = $$$.users.find((u, i, c, d) => u.a);")).toThrow(
      "'.find()' callbacks take at most 3 parameters (element, index, array); got 4.",
    );
  });

  it("Filter-mode rejection names Pipeline mode as the fix", () => {
    expect(() => jsmql.filter("$.x = $$$.users.find(u => u._id === $._id)")).toThrow(
      "jsmql.filter() expects a Filter (the document `db.coll.find(filter)` takes). It received a write (`$.x = …`, `delete $.x`) instead. Use jsmql.update() for an update document, or jsmql.pipeline() for a `$set` / `$unset` pipeline.",
    );
  });

  it("jsmql.update() pre-rejects lookup with a stage-whitelist hint", () => {
    expect(() => jsmql.update("$.x = $$$.users.find(u => u._id === $._id);")).toThrow(
      "A document-form update takes constants: the server reads '$_id' there as the string, not the field. To compute from the document, use the pipeline form ('jsmql.pipeline(\"$.a = $.b + 1;\")'). 'updateOne' also accepts this form.",
    );
  });

  it("jsmql.expr() rejects lookup syntax", () => {
    expect(() => jsmql.expr("$$$.users.find(u => u._id === $._id)")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`). It received a top-level 'find' stage call instead. Use jsmql.pipeline().",
    );
  });

  it("bare expression in jsmql() (no `;`) rejects with the requires-Pipeline message", () => {
    expect(() => jsmql("$$$.users.find(u => u._id === $._id)")).toThrow(
      "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = $$$.<coll>.…'), bind it ('let x = $$$.<coll>.…'), or make it the stream ('$$ = $$$.<coll>.…').",
    );
  });

  describe("a stream-method-headed chain is lookup syntax at every mode gate", () => {
    const streamHead = "$.x = $$$.users.toSorted({ createdAt: -1 }).take(5)";
    const findHead = "$.x = $$$.users.find(u => u._id === $._id)";

    it("jsmql.filter() rejects it the same way it rejects a `.find` head", () => {
      expect(() => jsmql.filter(streamHead)).toThrow(
        "jsmql.filter() expects a Filter (the document `db.coll.find(filter)` takes). It received a write (`$.x = …`, `delete $.x`) instead. Use jsmql.update() for an update document, or jsmql.pipeline() for a `$set` / `$unset` pipeline.",
      );
      expect(() => jsmql.filter(findHead)).toThrow(
        "jsmql.filter() expects a Filter (the document `db.coll.find(filter)` takes). It received a write (`$.x = …`, `delete $.x`) instead. Use jsmql.update() for an update document, or jsmql.pipeline() for a `$set` / `$unset` pipeline.",
      );
    });

    it("jsmql.expr() rejects it, and does not emit a $lookup pipeline", () => {
      expect(() => jsmql.expr(streamHead)).toThrow(
        "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`). It received a write (`$.x = …`, `delete $.x`) instead. Use jsmql.update() for an update document, or jsmql.pipeline() for a `$set` / `$unset` pipeline.",
      );
    });

    it("jsmql.update() rejects it pre-codegen, naming jsmql.pipeline()", () => {
      expect(() => jsmql.update(`${streamHead};`)).toThrow(
        "'$$$.<coll>' (a read of another collection) needs Pipeline mode — it materialises a '$lookup' stage. Use it inside a pipeline — for example, `({ $ }) => { $.n = $$$.<coll>.filter(…).size(); }`. It has no meaning in a Filter or in 'jsmql.expr'.",
      );
    });

    it("jsmql() lowers it identically with and without the trailing `;`", () => {
      expect(jsmql(streamHead)).toEqual([
        { $lookup: { from: "users", pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 5 }], as: "x" } },
      ]);
      const pivot = "$$ = $$$.users.toSorted({ createdAt: -1 }).take(5)";
      expect(jsmql(pivot)).toEqual([
        { $match: { $expr: false } },
        { $unionWith: { coll: "users", pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 5 }] } },
      ]);
    });
  });

  it("a bare foreign param (`o` alone) as a predicate is the whole foreign document, which is always truthy", () => {
    expect(jsmql("$.users = $$$.users.filter(o => o);")).toEqual([
      { $lookup: { from: "users", pipeline: [{ $match: { $expr: true } }], as: "users" } },
    ]);
  });

  it("a bare `$` (whole outer document) as a correlation value hoists `$$ROOT` into `let`", () => {
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
    expect(r.errors[0].pos).toBe(19);
  });
});

describe("$$$.coll.find/filter — nested lookups (expression body and block body, any depth)", () => {
  it("2-level filter/filter with outer-foreign-doc cross-reference", () => {
    expect(jsmql("$.x = $$$.a.filter(a => $$$.b.filter(b => b.x === a.x).size() > 0)")).toEqual([
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
            { $match: { $expr: { $gt: ["$__jsmql.tmp.0", null] } } },
            { $limit: 1 },
            { $unset: "__jsmql" },
          ],
          as: "x",
        },
      },
      { $set: { x: { $first: "$x" } } },
    ]);
  });

  it("outer-outer doc ref ($._id) flows through outer.let and is visible inside the inner by lexical $$ scope", () => {
    expect(
      jsmql(
        "$.posts = $$$.posts.filter(p => p.userId === $._id && $$$.tags.filter(t => t.postId === p._id).size() > 0)",
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
      "$.x = $$$.a.filter(a => $$$.b.filter(b => $$$.c.filter(c => c.x === b.x).size() > 0).size() > 0)",
    );
    expect(out).toEqual([
      {
        $lookup: {
          from: "a",
          pipeline: [
            {
              $lookup: {
                from: "b",
                pipeline: [
                  { $lookup: { from: "c", localField: "x", foreignField: "x", as: "__jsmql.tmp.0" } },
                  { $match: { $expr: { $gt: [{ $size: "$__jsmql.tmp.0" }, 0] } } },
                  { $unset: "__jsmql" },
                ],
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

  it("inner lookup with a compound && predicate takes the pair too, and needs no let", () => {
    expect(jsmql("$.x = $$$.a.filter(a => $$$.b.filter(b => b.x === a.x && b.active === true).size() > 0)")).toEqual([
      {
        $lookup: {
          from: "a",
          pipeline: [
            {
              $lookup: {
                from: "b",
                localField: "x",
                foreignField: "x",
                pipeline: [{ $match: { active: true } }],
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

  it("a bare enclosing foreign param (no member access) hoists `$$ROOT` into the inner `let`", () => {
    expect(jsmql("$.x = $$$.a.filter(a => $$$.b.filter(b => b === a).size() > 0)")).toEqual([
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

  it("nested lookup as a STATEMENT inside a block body (as from the LHS field)", () => {
    expect(
      jsmql("$.x = $$$.a.aggregate(a => { $match(a.active); a.bs = $$$.b.filter(b => b.aId === a._id); });"),
    ).toEqual([
      {
        $lookup: {
          from: "a",
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $gt: ["$active", null] },
                    { $ne: ["$active", false] },
                    { $ne: ["$active", ""] },
                    { $ne: ["$active", 0] },
                  ],
                },
              },
            },
            { $lookup: { from: "b", localField: "_id", foreignField: "aId", as: "bs" } },
          ],
          as: "x",
        },
      },
    ]);
    expect(() =>
      jsmql("$.x = $$$.a.aggregate(a => { $match(a.active); $.bs = $$$.b.filter(b => b.aId === a._id); });"),
    ).toThrow(
      "The outer document cannot be written from inside a body over another collection — only read. Write the body's own document through its callback parameter ('o.x = …', 'delete o.x', 'o = { … }'), or as a stage ('$set({ x: … })'). Write the outer field after the join.",
    );
  });

  it("block-in-block: the inner lookup's lambda also has a block body", () => {
    expect(
      jsmql(
        "$.x = $$$.a.aggregate(a => { a.bs = $$$.b.aggregate(b => { $match(b.aId === a._id); $sort({ _id: 1 }); }); });",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "a",
          pipeline: [
            {
              $lookup: {
                from: "b",
                localField: "_id",
                foreignField: "aId",
                pipeline: [{ $sort: { _id: 1 } }],
                as: "bs",
              },
            },
          ],
          as: "x",
        },
      },
    ]);
    expect(() =>
      jsmql(
        "$.x = $$$.a.aggregate(a => { $.bs = $$$.b.aggregate(b => { $match(b.aId === a._id); $sort({ _id: 1 }); }); });",
      ),
    ).toThrow(
      "The outer document cannot be written from inside a body over another collection — only read. Write the body's own document through its callback parameter ('o.x = …', 'delete o.x', 'o = { … }'), or as a stage ('$set({ x: … })'). Write the outer field after the join.",
    );
  });

  it("nested lookup inside a STAGE-BODY expression of a block (.size() materialises into a slot)", () => {
    expect(
      jsmql(
        "$.x = $$$.users.aggregate(u => { $match($$$.orders.filter(o => o.uid === u._id).size() > 0); $sort({ name: 1 }); });",
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
    expect(r.errors[0].pos).toBe(15);
  });
});

describe("$$$$.<db>.<coll>.find/filter — cross-database reads are rejected", () => {
  it("a .filter lookup is rejected", () => {
    expect(() => jsmql("$.x = $$$$.analytics.orders.filter(o => o.userId === $._id)")).toThrow(
      "A read of another DATABASE is not supported. '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    );
  });

  it("a chained .size() on a cross-DB .filter is rejected", () => {
    expect(() => jsmql("let n = $$$$.analytics.orders.filter(o => o.userId === $._id).size();")).toThrow(
      "A read of another DATABASE is not supported. '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    );
  });
});

describe("$$$.coll.filter(p).<chain> — stream-method chain extends the $lookup.pipeline body", () => {
  it("a terminal .map(...) that returns a document becomes a $replaceWith in the lookup's pipeline", () => {
    expect(jsmql("$.stats = $$$.users.filter(u => u.active).map(u => ({ id: u._id, name: u.name }));")).toEqual([
      {
        $lookup: {
          from: "users",
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $gt: ["$active", null] },
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
    expect(jsmql('$.r = $$$.orders.filter(o => o.userId === $._id).map("productIds").slice(0, 3);')).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
      { $set: { r: { $slice: [{ $map: { input: "$__jsmql.tmp.0", as: "x", in: "$$x.productIds" } }, 3] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a mid-chain .map('field') that feeds value methods (.flatten().uniq()) collapses to a value-mode expression", () => {
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
                    { $gt: ["$active", null] },
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
    expect(
      jsmql(
        '$.n = $$$.orders.filter(o => o.userId === $._id).flatMap("items").filter(i => i.qty > 1).sortBy("price").size();',
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
    expect(jsmql('$.n = $$$.orders.flatMap("items").map(i => i.qty).size();')).toEqual([
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

  it("a chained terminal (.size(), .reduce) takes precedence over the chain extension", () => {
    expect(jsmql("$.count = $$$.users.filter(u => u.active).size();")).toEqual([
      {
        $lookup: {
          from: "users",
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $gt: ["$active", null] },
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

  it("non-registered chain methods (for example .toLower) fall through to the existing expression-form path", () => {
    const out = jsmql("$.firstName = $$$.users.find(u => u._id === $.userId).name;") as object[];
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
                        { $gt: ["$cancelled", null] },
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
      "A read of another DATABASE is not supported. '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    );
  });
});

describe("$$$.coll stream chains — HR3 / consistency guards (from adversarial review)", () => {
  it("a lone shorthand .filter({obj}) head lowers exactly like the equivalent arrow", () => {
    expect(jsmql("$.x = $$$.orders.filter({ uid: 1 });")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { uid: 1 } }], as: "x" } },
    ]);
    expect(jsmql("$.x = $$$.orders.filter(o => o.uid === 1);")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { uid: 1 } }], as: "x" } },
    ]);
  });

  const SPELLINGS: ReadonlyArray<readonly [string, string]> = [
    ["matches-object", `{ userId: $._id }`],
    ["matchesProperty", `["userId", $._id]`],
  ];
  for (const [label, shorthand] of SPELLINGS) {
    it(`a ${label} predicate lowers identically to its arrow — indexed basic form, $size .size()`, () => {
      const arrow = (pred: string) => `let n = $$$.orders.filter(${pred}).size(); $project({ n });`;
      expect(jsmql(arrow(shorthand))).toEqual([
        { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "__jsmql.tmp.0" } },
        { $set: { "__jsmql.var.n": { $size: "$__jsmql.tmp.0" } } },
        { $project: { n: "$__jsmql.var.n" } },
        { $unset: "__jsmql" },
      ]);
      expect(jsmql(arrow(shorthand))).toEqual(jsmql(arrow("o => o.userId === $._id")));
    });

    it(`a ${label} predicate hits the same Filter-mode gate as its arrow`, () => {
      expect(() => jsmql(`$$$.orders.filter(${shorthand}).size() > 0`)).toThrow(/needs Pipeline mode/);
    });
  }

  it("an uncorrelated $lookup omits `let` entirely, whatever assembled it", () => {
    const lookupOf = (src: string) => ((jsmql(src) as object[])[0] as { $lookup: Record<string, unknown> }).$lookup;
    for (const src of [
      "$.x = $$$.orders.filter(o => o.uid === 1);",
      "$.x = $$$.orders.filter({ uid: 1 });",
      "$.x = $$$.orders.filter(o => o.uid === 1).take(2);",
      "$.x = $$$.orders.take(2);",
      "$.x = $$$.orders.aggregate(o => { $limit(2); });",
    ]) {
      expect(Object.keys(lookupOf(src)), src).not.toContain("let");
    }
    expect(jsmql("$.x = $$$.orders.filter(o => o.uid === $._id && o.qty > 0);")).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "uid",
          pipeline: [{ $match: { qty: { $gt: 0 } } }],
          as: "x",
        },
      },
    ]);
  });

  it("a malformed shorthand still reports its own targeted error, not a lookup-shape one", () => {
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
    const asExpr = jsmql("$.x = $$$.orders.map(o => o.total);");
    expect(asExpr).toEqual([
      { $lookup: { from: "orders", pipeline: [], as: "__jsmql.tmp.0" } },
      { $set: { x: { $map: { input: "$__jsmql.tmp.0", as: "o", in: "$$o.total" } } } },
      { $unset: "__jsmql" },
    ]);
    expect(jsmql("$.x = $$$.orders.map(o => { return o.total; });")).toEqual(asExpr);
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
    expect(() => jsmql("$.x = $$$.orders.map(o => { $sort({ x: -1 }); return o.total; });")).toThrow(
      "`$sort(...)` at position 28 is a pipeline stage. The 'return' at position 46 makes this block a value callback. One block cannot be both. Move the stages to '.aggregate((o) => { $sort(...); … })'. It takes a block of stages and no 'return'. Or delete the stage and fold its work into the 'return'. Over the stream a stage is also a chain link: '$$.$sort(…)'.",
    );
    expect(
      jsmql(
        "$.x = $$$.orders.filter(o => o.uid === $._id).aggregate(o => { $sort({ x: -1 }); $replaceWith({ t: o.total }); });",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "uid",
          pipeline: [{ $sort: { x: -1 } }, { $replaceWith: { t: "$total" } }],
          as: "x",
        },
      },
    ]);
    expect(jsmql("$.x = $$$.orders.aggregate(o => { $sort({ x: -1 }); }).map(o => o.total);")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $sort: { x: -1 } }], as: "__jsmql.tmp.0" } },
      { $set: { x: { $map: { input: "$__jsmql.tmp.0", as: "o", in: "$$o.total" } } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("the same rejection on a chained `.find` does not offer the `.map`-only rewrite", () => {
    expect(() => jsmql("$.x = $$$.orders.filter(o => o.uid === $._id).find(o => { $match(o.c); });")).toThrow(
      "`$match(...)` at position 58 is a pipeline stage, not part of a callback. A callback's block holds declarations and a 'return'. Move the stages to '.aggregate((o) => { $match(...); … })'. It is the one method whose block is a list of stages. Over the stream a stage is also a chain link: '$$.$match(…)'.",
    );
    expect(() => jsmql("$.x = $$$.orders.filter(o => o.uid === $._id).find(o => { $match(o.c); });")).not.toThrow(
      /`return` a document/,
    );
  });

  it("a .map after an object-collapsing terminal (.countBy) is rejected, not mis-assembled", () => {
    expect(() => jsmql('$.x = $$$.orders.filter(o => o.uid === $._id).countBy("uid").map(v => v);')).toThrow(
      "'.map()' is not available on an 'object' — it is defined on 'array', 'stream'.",
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

  it("correlated head: $. auto-lets into $lookup.let; foreign through o.<field>", () => {
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

  it("chained after a correlated .filter — aggregate stages extend the $lookup.pipeline", () => {
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

  it("chained .size() counts the aggregate result", () => {
    expect(
      jsmql(
        '$.n = $$$.orders.aggregate((o) => { $match(o.userId === $._id); $group({ _id: "$productId" }); }).size();',
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

  it("refuses <coll>.size() in a body that groups — the stamp is dropped with the fields", () => {
    expect(() =>
      jsmql('$.g = $$$.c.aggregate((o, _i, coll) => { $group({ _id: "$s" }); assert(coll.size() > 0, "empty"); });'),
    ).toThrow(/'coll' is the body's own stream\. This body runs '\$group'/);
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

  it("$$ = source-switch binds the 3rd 'stream' param's .size() (parity with .map)", () => {
    expect(jsmql("$$ = $$$.products.aggregate((o, _i, coll) => { $set({ n: coll.size() }); });")).toEqual([
      { $match: { $expr: false } },
      {
        $unionWith: {
          coll: "products",
          pipeline: [
            { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
            { $set: { n: "$__jsmql.size" } },
            { $unset: "__jsmql" },
          ],
        },
      },
    ]);
  });
});

describe("$$$.coll.<streamMethod>….aggregate(pipeline) — lodash chain into a sub-pipeline", () => {
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

  it("lodash methods AFTER .aggregate extend the same sub-pipeline", () => {
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

  it("a correlated .filter ahead of the lodash chain hoists into $lookup.let", () => {
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

  it("the 3rd 'stream' param binds the sub-stream count after a lodash chain", () => {
    expect(
      jsmql(
        "$.r = $$$.orders.sort({ t: -1 }).take(3).aggregate((o, _i, coll) => { $addFields({ n: coll.size() }); });",
      ),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          pipeline: [
            { $sort: { t: -1 } },
            { $limit: 3 },
            { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
            { $addFields: { n: "$__jsmql.size" } },
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

  it("a chained terminal reads the aggregate result as a value (.size() / .map)", () => {
    expect(jsmql("$.n = $$$.orders.sort({ t: -1 }).aggregate((o) => { $group({ _id: o.status }); }).size();")).toEqual([
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

    it("a second .aggregate appends its stages, and does not report an unknown method", () => {
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
      expect(link).toEqual(head);
    });
  });

  describe("argument errors match the head form's wording", () => {
    const pairs: [string, string, (at: number) => string][] = [
      [
        "expression body",
        "(o) => o.total",
        () =>
          "'.aggregate()' takes an arrow whose body is a block of stages — 'o => { $match(…); $limit(1); }' — or a bracketed list of them.",
      ],
      [
        "trailing return",
        "(o) => { $limit(2); return o.total; }",
        (at) =>
          `\`$limit(...)\` at position ${at + 9} is a pipeline stage. The 'return' at position ${at + 20} makes this block a value callback. One block cannot be both. Move the stages to '.aggregate((o) => { $limit(...); … })'. It takes a block of stages and no 'return'. Or delete the stage and fold its work into the 'return'. Over the stream a stage is also a chain link: '$$.$limit(…)'.`,
      ],
      [
        "4 params",
        "(a, b, c, d) => { $limit(1); }",
        () => "'.aggregate()' callbacks take at most 3 parameters (element, index, array); got 4.",
      ],
      [
        "index param used",
        "(o, i) => { $addFields({ k: i }); }",
        () =>
          "`i` has no value inside `.aggregate()` — a stream has no per-document index; leave the parameter unused.",
      ],
      [
        "coll param beyond .size()",
        "(o, _i, c) => { $addFields({ k: c.total }); }",
        () =>
          "'c' is the body's own stream, the callback's third parameter: read its count ('c.size()') or chain on it ('c.filter(…)'). It is not a document or a value on its own.",
      ],
    ];
    for (const [label, arg, message] of pairs) {
      it(`${label} — rejected at both call positions`, () => {
        const head = "$.r = $$$.orders.aggregate(";
        const link = "$.r = $$$.orders.sort({ t: 1 }).aggregate(";
        expect(() => jsmql(`${head}${arg});`)).toThrow(message(head.length));
        expect(() => jsmql(`${link}${arg});`)).toThrow(message(link.length));
      });
    }

    it("both positions carry a real .pos for tooling", () => {
      for (const [src, pos] of [
        ["$.r = $$$.orders.aggregate((o) => o.total);", 31],
        ["$.r = $$$.orders.sort({ t: 1 }).aggregate((o) => o.total);", 46],
      ] as const) {
        const res = jsmql.validate(src);
        expect(res.valid).toBe(false);
        expect(res.errors[0].pos).toBe(pos);
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

  it("a use other than .size() of the 3rd 'stream' param is rejected", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate((o, _i, coll) => { $match(o.n === coll[0]); });")).toThrow(
      "'coll' is the body's own stream. This body runs '$match', which changes what its count means. The compiler stamps 'coll.size()' into a field ahead of the body. That stage either drops the field or changes the number of documents. Only a stage that leaves both alone keeps the count true. Take the count in a statement ahead of this chain, or drop 'coll' from the parameter list.",
    );
  });

  it("a spread element in the array form is rejected", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate([{ $sort: { a: 1 } }, ...$.more]);")).toThrow(
      "A pipeline is written out stage by stage; '...' cannot spread stages into it. List each stage.",
    );
  });

  it("an empty pipeline is rejected (array form; the arrow form's empty block is a parse error)", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate([]);")).toThrow(
      "'.aggregate()' needs at least one stage. An empty list has none. List the stages — '.aggregate([$match(…), $sort(…)])' — or drop the '.aggregate()' link.",
    );
  });

  it("$$.aggregate (current stream) appends its stages to the chain, in every container", () => {
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

  it("a `$.<field>` read inside `$$.aggregate` reads the stream's own document", () => {
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

  it("a CORRELATED aggregate cannot be unioned — $unionWith has no `let` slot", () => {
    expect(() => jsmql("$$.push(...$$$.c.aggregate((o) => { $match(o.uid === $._id); }));")).toThrow(
      "'$unionWith' has no 'let': its body cannot read the outer document or a binding declared outside it. Filter or reshape the outer stream in a statement before it, or read the other collection through a join ('$.<field> = $$$.<coll>.filter(…)'), whose '$lookup' carries the value.",
    );
  });

  it("cross-database aggregate read is rejected", () => {
    expect(() => jsmql("$.x = $$$$.db.c.aggregate((o) => { $sort({ a: 1 }); });")).toThrow(
      "A read of another DATABASE is not supported. '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    );
  });

  it("aggregate syntax outside Pipeline mode is rejected", () => {
    expect(() => jsmql("$$$.c.aggregate((o) => { $limit(5); })")).toThrow(
      "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = $$$.<coll>.…'), bind it ('let x = $$$.<coll>.…'), or make it the stream ('$$ = $$$.<coll>.…').",
    );
  });

  it("every chain head gets the same no-destination rejection (no method enumeration)", () => {
    for (const src of [
      "$$$.c.find(o => o.a === 1)",
      "$$$.c.filter(o => o.a === 1)",
      "$$$.c.aggregate((o) => { $limit(5); })",
      "$$$.c.toSorted({ a: 1 }).take(5)",
      "$$$.c.$match({ a: 1 })",
    ]) {
      expect(() => jsmql(src), src).toThrow(
        "Reading another collection produces a value, and this statement gives it no destination. Assign it to a field ('$.<field> = $$$.<coll>.…'), bind it ('let x = $$$.<coll>.…'), or make it the stream ('$$ = $$$.<coll>.…').",
      );
    }
  });

  it("a trailing `return` inside an aggregate block is rejected (it's not a per-doc reshape)", () => {
    expect(() => jsmql("$.x = $$$.c.aggregate((o) => { $sort({ a: 1 }); return o.v; });")).toThrow(
      "`$sort(...)` at position 31 is a pipeline stage. The 'return' at position 48 makes this block a value callback. One block cannot be both. Move the stages to '.aggregate((o) => { $sort(...); … })'. It takes a block of stages and no 'return'. Or delete the stage and fold its work into the 'return'. Over the stream a stage is also a chain link: '$$.$sort(…)'.",
    );
  });

  it(".aggregate chained on a .find() result is rejected (scalar, not a collection)", () => {
    expect(() => jsmql("$.x = $$$.c.find(o => o.x === 1).aggregate((o) => { $sort({ a: 1 }); });")).toThrow(
      "'.aggregate()' produces pipeline stages, not a value.",
    );
  });

  describe("on a receiver the chain already collapsed to a value", () => {
    const collapsed = [
      ["head()", ".head()"],
      ["size()", ".size()"],
      ["last()", ".last()"],
      ["nth(1)", ".nth(...)"],
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

    it("a numeric terminal over documents is refused before the chain is read", () => {
      expect(() => jsmql("$.x = $$$.orders.sum().aggregate((o) => { $limit(1); });")).toThrow("'.sum()' takes numbers");
      expect(() => jsmql("$.x = $$$.orders.sum();")).toThrow("'.sum()' takes numbers");
    });

    it("a field read and an index end the chain, so a method after them reads a value", () => {
      expect(() => jsmql("$.x = $$$.orders.filter(o => o.v > 0)[0].aggregate((o) => { $limit(1); });")).toThrow(
        /'\.aggregate\(\)' produces pipeline stages, not a value/,
      );
      expect(() => jsmql("$.x = $$$.orders.find(o => o.v > 0).total.aggregate((o) => { $limit(1); });")).toThrow(
        /'\.aggregate\(\)' produces pipeline stages, not a value/,
      );
      expect(() => jsmql("$.x = $$$.orders.filter(o => o.v > 0).length.aggregate((o) => { $limit(1); });")).toThrow(
        "write '.size()'",
      );
    });

    it("the suggested collection spelling follows a cross-database receiver", () => {
      expect(() => jsmql("$.x = $$$$.dw.orders.head().aggregate((o) => { $limit(1); });")).toThrow(
        "A read of another DATABASE is not supported. '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
      );
    });

    it("a still-a-stream chain is untouched, at any depth", () => {
      expect(jsmql("$.x = $$$.orders.filter(o => o.v > 0).sort({ t: 1 }).aggregate((o) => { $limit(1); });")).toEqual([
        {
          $lookup: {
            from: "orders",
            pipeline: [{ $match: { v: { $gt: 0 } } }, { $sort: { t: 1 } }, { $limit: 1 }],
            as: "x",
          },
        },
      ]);
      expect(jsmql("$.x = $$$.orders.aggregate((o) => { $limit(3); }).head();")).toEqual([
        { $lookup: { from: "orders", pipeline: [{ $limit: 3 }], as: "__jsmql.tmp.0" } },
        { $set: { x: { $first: "$__jsmql.tmp.0" } } },
        { $unset: "__jsmql" },
      ]);
    });

    it("carries a .pos for tooling", () => {
      const res = jsmql.validate("$.x = $$$.orders.head().aggregate((o) => { $limit(1); });");
      expect(res.valid).toBe(false);
      expect(res.errors[0].pos).toBe(23);
    });
  });

  describe("a value terminal over a joined stream gives ONE DOCUMENT, and the array methods are refused on it", () => {
    for (const terminal of [
      "head()",
      "first()",
      "last()",
      "at(0)",
      "nth(1)",
      "findLast(o => o.total > 1)",
      'minBy("total")',
      'maxBy("total")',
    ]) {
      it(`refuses '.map()' after '.${terminal}'`, () => {
        expect(() => jsmql(`$.r = $$$.orders.${terminal}.map(x => x);`)).toThrow(
          /'\.map\(\)' is not available on an 'object'/,
        );
      });
    }

    it("refuses '.map()' after '.size()'", () => {
      expect(() => jsmql("$.r = $$$.orders.size().map(x => x);")).toThrow(/'\.map\(\)' is not available on a 'number'/);
    });
    for (const terminal of ["min()", "max()", "mean()"]) {
      it(`refuses '.${terminal}' over documents`, () => {
        expect(() => jsmql(`$.r = $$$.orders.${terminal};`)).toThrow(/takes numbers, but the array holds a document/);
      });
    }

    for (const [method, spelling] of [
      ["filter", ".filter(x => x.total > 1)"],
      ["some", ".some(x => x.total > 1)"],
      ["join", '.join(",")'],
      ["reduce", ".reduce((a, b) => a + b, 0)"],
      ["flat", ".flat()"],
      ["sum", ".sum()"],
      ["take", ".take(1)"],
      ["has", ".has(1)"],
    ]) {
      it(`refuses '${method}' on the document a terminal gives`, () => {
        expect(() => jsmql(`$.r = $$$.orders.head()${spelling};`)).toThrow(
          new RegExp(`'\\.${method}\\(\\)' is not available on an 'object'`),
        );
      });
    }

    it("names the way out: a field of the document, or no terminal at all", () => {
      expect(() => jsmql("$.r = $$$.orders.head().map(x => x);")).toThrow(
        /A document is not a list\. To count its fields, write '\.keys\(\)\.size\(\)'/,
      );
    });

    it("a field read and a document method on the same terminal still compile", () => {
      expect(jsmql("$.r = $$$.orders.head().total;")).toEqual([
        { $lookup: { from: "orders", pipeline: [], as: "__jsmql.tmp.0" } },
        { $set: { r: { $let: { vars: { jsmqlV: { $first: "$__jsmql.tmp.0" } }, in: "$$jsmqlV.total" } } } },
        { $unset: "__jsmql" },
      ]);
      expect(jsmql("$.r = $$$.orders.head().keys();")).toEqual([
        { $lookup: { from: "orders", pipeline: [], as: "__jsmql.tmp.0" } },
        {
          $set: {
            r: { $map: { input: { $objectToArray: { $ifNull: [{ $first: "$__jsmql.tmp.0" }, {}] } }, in: "$$this.k" } },
          },
        },
        { $unset: "__jsmql" },
      ]);
    });

    it("a link that REPLACES the elements leaves them unproven, so the array methods stay open", () => {
      expect(jsmql("$.r = $$$.orders.map(o => ({ t: o.total })).head().t;")).toEqual([
        { $lookup: { from: "orders", pipeline: [{ $replaceWith: { t: "$total" } }], as: "__jsmql.tmp.0" } },
        { $set: { r: { $let: { vars: { jsmqlV: { $first: "$__jsmql.tmp.0" } }, in: "$$jsmqlV.t" } } } },
        { $unset: "__jsmql" },
      ]);
    });

    it("a field path proves nothing, so an in-document array keeps its methods", () => {
      expect(jsmql("$.r = $.items.head().map(x => x);")).toEqual([
        {
          $set: {
            r: { $map: { input: { $ifNull: [{ $first: { $ifNull: ["$items", []] } }, []] }, as: "x", in: "$$x" } },
          },
        },
      ]);
    });
  });

  it("$$ = source-switch with an outer-doc $. reference pivots through $lookup + $unwind", () => {
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

  it("the chained form (.filter(p).aggregate(bad)) validates through the same rules", () => {
    expect(() => jsmql("$.x = $$$.c.filter(o => o.v > 1).aggregate(o => o.v);")).toThrow(
      "'.aggregate()' takes an arrow whose body is a block of stages — 'o => { $match(…); $limit(1); }' — or a bracketed list of them.",
    );
    expect(() => jsmql("$.x = $$$.c.filter(o => o.v > 1).aggregate((o, i) => { $match(o.n === i); });")).toThrow(
      "`i` has no value inside `.aggregate()` — a stream has no per-document index; leave the parameter unused.",
    );
  });
});

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

  it("is equivalent to the one-statement .aggregate(...) block spelling", () => {
    const chained = jsmql("$.t = $$$.orders.$match({ x: 1 });");
    const block = jsmql("$.t = $$$.orders.aggregate((o) => { $match({ x: 1 }); });");
    expect(chained).toEqual([{ $lookup: { from: "orders", pipeline: [{ $match: { x: 1 } }], as: "t" } }]);
    expect(block).toEqual(chained);
  });

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

  it("re-expresses a correlated query-document $match as a predicate", () => {
    const stageLink = jsmql("$.t = $$$.orders.$match({ userId: $._id });");
    expect(stageLink).toEqual([{ $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "t" } }]);
    expect(jsmql("$.t = $$$.orders.filter({ userId: $._id });")).toEqual(stageLink);
  });

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
    expect(jsmql('$.t = $$$.orders.filter({ userId: $._id, status: "shipped" });')).toEqual(stageLink);
  });

  it("an operator-bearing $match body is NOT converted — it is not a lodash matcher", () => {
    expect(jsmql("$.t = $$$.orders.$match({ qty: { $gt: 5 } });")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { qty: { $gt: 5 } } }], as: "t" } },
    ]);
    expect(() => jsmql("$.t = $$$.orders.filter({ qty: { $gt: 5 } });")).toThrow(
      "'{ $gt: … }' is raw MQL, and raw MQL cannot be an operand of '.filter()'.",
    );
  });

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

  it("leaves an uncorrelated query-document $match verbatim", () => {
    expect(jsmql('$.t = $$$.orders.$match({ status: "shipped" });')).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { status: "shipped" } }], as: "t" } },
    ]);
    expect(jsmql('$.t = $$$.orders.filter({ status: "shipped" });')).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { status: "shipped" } }], as: "t" } },
    ]);
  });

  it("allows an outer-document read inside the $expr escape hatch", () => {
    expect(jsmql('$.t = $$$.orders.$match({ $expr: { $eq: ["$userId", $._id] } });')).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "userId", as: "t" } },
    ]);
  });

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

  it("rejects a stage forbidden inside a $lookup sub-pipeline", () => {
    expect(() => jsmql("$.t = $$$.orders.$out('archive');")).toThrow(
      "'$out' cannot stand inside '$lookup' — the server refuses it in that body. Run it as a stage of the outer pipeline instead.",
    );
    expect(() => jsmql("$.t = $$$.orders.$merge({ into: 'archive' });")).toThrow(
      "'$merge' cannot stand inside '$lookup' — the server refuses it in that body. Run it as a stage of the outer pipeline instead.",
    );
  });

  it("rejects a must-be-first stage that is not first in the chain", () => {
    expect(() => jsmql("$.t = $$$.orders.$match({ a: 1 }).$documents([{ x: 1 }]);")).toThrow(
      "'$documents' cannot stand inside '$lookup' — the server refuses it in that body. Append the documents to the stream instead ('$$.push({ a: 1 });'), or start the stream from them ('$$ = [{ a: 1 }, { a: 2 }];').",
    );
  });

  it("passes an unknown `$` stage in a foreign chain through, and suggests for a JavaScript name", () => {
    expect(jsmql("$.t = $$$.orders.$sortt({ a: 1 });")).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $sortt: { a: 1 } }], as: "t" } },
    ]);
    expect(() => jsmql("$.t = $$$.orders.sortt({ a: 1 });")).toThrow(
      "Unknown method '.sortt()' at position 16. Did you mean '.sort()'?",
    );
  });
});

describe("$$$.coll — where the hoisted $lookup lands", () => {
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

  it("refuses a join whose body reads a variable an enclosing callback binds", () => {
    expect(() => jsmql("$.n = $.items.map(x => $$$.products.find({ _id: x.pid }).name);")).toThrow(
      "'x' is bound by an enclosing callback. A read of another collection is a '$lookup' STAGE: the server runs it over the documents, outside that callback, where 'x' has no value. Make the elements documents first — '$$ = $.<array>;' — then each one is a document the join reads: '$.<field> = $$$.<coll>.find(…)'. Or read the collection OUTSIDE the callback ('let <name> = $$$.<coll>.filter(…);') and use that binding inside it.",
    );
    expect(jsmql("$$ = $.items; $.name = $$$.products.find({ _id: $.pid }).name;")).toEqual([
      { $unwind: "$items" },
      { $replaceWith: "$items" },
      {
        $lookup: {
          from: "products",
          localField: "pid",
          foreignField: "_id",
          pipeline: [{ $limit: 1 }],
          as: "__jsmql.tmp.0",
        },
      },
      { $set: { "__jsmql.tmp.0": { $first: "$__jsmql.tmp.0" } } },
      { $set: { name: "$__jsmql.tmp.0.name" } },
      { $unset: "__jsmql" },
    ]);
    expect(jsmql("let ps = $$$.products.filter(p => p.ok === true); $.n = $.items.map(x => ps.size());")).toEqual([
      { $lookup: { from: "products", pipeline: [{ $match: { ok: true } }], as: "__jsmql.var.ps" } },
      { $set: { n: { $map: { input: { $ifNull: ["$items", []] }, as: "x", in: { $size: "$__jsmql.var.ps" } } } } },
      { $unset: "__jsmql" },
    ]);
  });
});
