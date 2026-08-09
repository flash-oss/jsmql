// Tests for the `$$$.<coll> = …` / `$$$$.<db>.<coll> = …` → `$out` lowering.
// See docs/specs/out-stage.md for the design and docs/LANGUAGE.md for the
// user-facing reference.

import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

describe("$out — bare $$ RHS (no transformations)", () => {
  it("same-database write: '$$$.coll = $$' lowers to a single $out stage with a string body", () => {
    expect(jsmql("$$$.warehouse_orders = $$;")).toEqual([{ $out: "warehouse_orders" }]);
  });

  it("cross-database write: '$$$$.db.coll = $$' lowers to a single $out stage with a { db, coll } body", () => {
    expect(jsmql("$$$$.dw.archive = $$;")).toEqual([{ $out: { db: "dw", coll: "archive" } }]);
  });
});

describe("$out — bracket-access LHS (equivalent to dotted)", () => {
  it("bracket form for same-DB produces the same MQL as the dotted form", () => {
    expect(jsmql('$$$["warehouse_orders"] = $$;')).toEqual([{ $out: "warehouse_orders" }]);
  });

  it("bracket form for cross-DB produces the same MQL as the dotted form", () => {
    expect(jsmql('$$$$["dw"]["archive"] = $$;')).toEqual([{ $out: { db: "dw", coll: "archive" } }]);
  });

  it("bracket and dotted segments mix freely", () => {
    expect(jsmql('$$$$["dw"].archive = $$;')).toEqual([{ $out: { db: "dw", coll: "archive" } }]);
    expect(jsmql('$$$$.dw["archive"] = $$;')).toEqual([{ $out: { db: "dw", coll: "archive" } }]);
  });

  it("bracket is required for non-identifier collection names (hyphens, dots, leading digits)", () => {
    expect(jsmql('$$$["my-archive.v2"] = $$;')).toEqual([{ $out: "my-archive.v2" }]);
    expect(jsmql('$$$["123-numeric-prefix"] = $$;')).toEqual([{ $out: "123-numeric-prefix" }]);
  });
});

describe("$out — RHS chain: $$.filter(<predicate>) → $match + $out", () => {
  it("expression-body filter goes through the index-friendly match translator", () => {
    expect(jsmql("$$$.active = $$.filter(u => u.tier === 'gold');")).toEqual([
      { $match: { tier: "gold" } },
      { $out: "active" },
    ]);
  });

  it("cross-DB write with an inline filter (the headline example)", () => {
    expect(jsmql("$$$$.dw.archive = $$.filter(u => !u.active);")).toEqual([
      {
        $match: {
          $expr: {
            $not: {
              $and: [
                { $ne: [{ $ifNull: ["$active", null] }, null] },
                { $ne: ["$active", false] },
                { $ne: ["$active", ""] },
                { $ne: ["$active", 0] },
              ],
            },
          },
        },
      },
      { $out: { db: "dw", coll: "archive" } },
    ]);
  });

  it("block-body filter passes through stage statements verbatim, then appends $out", () => {
    expect(jsmql("$$$.top10 = $$.filter(o => { $sort({ score: -1 }); $limit(10); });")).toEqual([
      { $sort: { score: -1 } },
      { $limit: 10 },
      { $out: "top10" },
    ]);
  });
});

describe("$out — composes with preceding stages", () => {
  it("an update-op stage before the $out flushes to its own $set", () => {
    expect(jsmql("$.tier = 'gold'; $$$.gold_users = $$;")).toEqual([
      { $set: { tier: "gold" } },
      { $out: "gold_users" },
    ]);
  });

  it("multiple preceding stages all sit before the $out", () => {
    expect(jsmql("$match($.active === true); $sort({ joined: 1 }); $$$.snapshot = $$;")).toEqual([
      { $match: { active: true } },
      { $sort: { joined: 1 } },
      { $out: "snapshot" },
    ]);
  });
});

describe("$out — last-stage enforcement", () => {
  it("a statement after the $out sugar throws an actionable trailing-stage error", () => {
    expect(() => jsmql("$$$.x = $$; $.y = 1;")).toThrow(/\$out.*must be the last stage/);
  });

  it("two $out statements in one pipeline throw via the same guard", () => {
    expect(() => jsmql("$$$.a = $$; $$$.b = $$;")).toThrow(/\$out.*must be the last stage/);
  });
});

describe("$out — LHS shape errors", () => {
  it("too many segments after $$$ ('$$$.a.b = …') points at the cross-DB form", () => {
    expect(() => jsmql("$$$.a.b = $$;")).toThrow(/too many segments for a same-database/);
  });

  it("only one segment after $$$$ ('$$$$.x = …') points at the missing collection", () => {
    expect(() => jsmql("$$$$.x = $$;")).toThrow(/missing the collection/);
  });

  it("three segments after $$$$ ('$$$$.a.b.c = …') points at the deepest form", () => {
    expect(() => jsmql("$$$$.a.b.c = $$;")).toThrow(/too many segments for a \$out target/);
  });

  it("a computed bracket rejects with the 'literal collection name' hint", () => {
    expect(() => jsmql("$$$[someVar] = $$;")).toThrow(/must be a literal collection name/);
  });
});

describe("$out — RHS shape errors", () => {
  it("unrecognised chain method (not in the stream-methods registry) names the workaround", () => {
    // A chain method resolves through the stream-methods registry (plus `.filter` /
    // `.reject` and the stage-link form). Only a name in NONE of those reaches the
    // "use a separate stage" hint.
    expect(() => jsmql("$$$.coll = $$.unknownMethod();")).toThrow(/isn't a recognised chain method for a '\$out' RHS/);
  });

  it("suggests a near-miss chain method name", () => {
    expect(() => jsmql("$$$.coll = $$.mpa(d => d.x);")).toThrow(/Did you mean '\.map\(\)'\?/);
    expect(() => jsmql("$$$.coll = $$.fliter({ a: 1 });")).toThrow(/Did you mean '\.filter\(\)'\?/);
    // Nothing close enough — no suggestion, just the workaround.
    expect(() => jsmql("$$$.coll = $$.wibble();")).toThrow(/RHS\. Add the equivalent stage call/);
  });

  // `STAGE_EQUIVALENT_HINT` only fires for a method the registry does NOT carry, so a
  // registered one listed there would be dead weight — suggesting a workaround for
  // something that already works. These are the two that genuinely have no chain form.
  it("names the stage equivalent for a JS method a stream chain deliberately lacks", () => {
    expect(() => jsmql("$$$.coll = $$.reduce((a, d) => a + d.n, 0);")).toThrow(
      /Use '\$group\(\{ \.\.\. \}\)' as a separate stage/,
    );
    expect(() => jsmql("$$$.coll = $$.flat();")).toThrow(/Use '\$unwind' as a separate stage/);
  });

  it("RHS not rooted at $$ throws with the supported shapes", () => {
    expect(() => jsmql("$$$.coll = $.someField;")).toThrow(/must start with '\$\$'/);
  });

  it("`$.<field>` inside a $$.filter on the RHS is rejected with a 'use the lambda param' hint", () => {
    expect(() => jsmql("$$$.coll = $$.filter(o => o.x === $.threshold);")).toThrow(
      /lambda's parameter `o` IS the current document/,
    );
  });
});

describe("$out — multi-method RHS chains", () => {
  // Stream-methods registry methods compose freely before the $out: filter,
  // map, slice, toSorted, toReversed, flatMap, concat.
  it(".filter + .slice — $match + $limit + $out", () => {
    expect(jsmql("$$$.archive = $$.filter(d => d.active === false).slice(0, 100);")).toEqual([
      { $match: { active: false } },
      { $limit: 100 },
      { $out: "archive" },
    ]);
  });

  it(".filter + .toSorted + .slice — $match + $sort + $limit + $out", () => {
    expect(
      jsmql("$$$.top = $$.filter(d => d.active === true).toSorted((a, b) => b.score - a.score).slice(0, 10);"),
    ).toEqual([{ $match: { active: true } }, { $sort: { score: -1 } }, { $limit: 10 }, { $out: "top" }]);
  });

  it(".map — $replaceWith + $out", () => {
    expect(jsmql("$$$.report = $$.map(d => ({ id: d._id, total: d.amount * 2 }));")).toEqual([
      { $replaceWith: { id: "$_id", total: { $multiply: ["$amount", 2] } } },
      { $out: "report" },
    ]);
  });

  it(".flatMap — $unwind + $out", () => {
    expect(jsmql("$$$.flat = $$.flatMap(d => d.items);")).toEqual([{ $unwind: "$items" }, { $out: "flat" }]);
  });
});

// `.reject` is `.filter` negated, and the pair stays in lockstep in every container.
// A `$out` chain used to wire up only `.filter`, so the obvious next thing a user
// writes ("archive everything that ISN'T expired") hit the unknown-method error.
describe("$out — .reject is .filter negated", () => {
  // Every predicate spelling, same negated $match — matching what a `$$ =` chain emits.
  const NEGATED = { $match: { $expr: { $not: { $eq: ["$archived", true] } } } };
  for (const [spelling, predicate] of [
    ["arrow", "d => d.archived === true"],
    ["matches-object", "{ archived: true }"],
    ['["field", value] pair', '["archived", true]'],
  ] as const) {
    it(`accepts the ${spelling} spelling`, () => {
      expect(jsmql(`$$$.live = $$.reject(${predicate});`)).toEqual([NEGATED, { $out: "live" }]);
    });
  }

  it("emits exactly what the same .reject emits in a `$$ =` chain", () => {
    expect(jsmql("$$$.live = $$.reject({ archived: true });")).toEqual([
      ...(jsmql("$$ = $$.reject({ archived: true });") as object[]),
      { $out: "live" },
    ]);
  });

  it("chains with .filter and the rest of the stream methods", () => {
    expect(jsmql("$$$.live = $$.filter(d => d.tier === 'gold').reject({ archived: true }).take(10);")).toEqual([
      { $match: { tier: "gold" } },
      NEGATED,
      { $limit: 10 },
      { $out: "live" },
    ]);
  });

  it("accepts the `function` spelling of the predicate", () => {
    expect(jsmql("$$$.live = $$.reject(function (d) { return d.archived === true; });")).toEqual([
      NEGATED,
      { $out: "live" },
    ]);
  });
});

describe("$out — ParamRef in bracket-LHS (jsmql.compile binding)", () => {
  it("$$$[boundColl] resolves the bracket via the compile-time binding", () => {
    const fn = jsmql.compile(({ destColl }) => ($$$[destColl] = $$));
    expect(fn({ destColl: "archive" })).toEqual([{ $out: "archive" }]);
  });

  it("$$$$[dbName][collName] resolves both segments", () => {
    const fn = jsmql.compile(({ dbName, collName }) => ($$$$[dbName][collName] = $$));
    expect(fn({ dbName: "warehouse", collName: "users" })).toEqual([{ $out: { db: "warehouse", coll: "users" } }]);
  });

  it("non-string binding is rejected with a 'must be a string' hint", () => {
    const fn = jsmql.compile(({ n }) => ($$$[n] = $$));
    expect(() => fn({ n: 42 })).toThrow(/the parameter binding must be a string/);
  });
});

describe("$out — mode gates", () => {
  it("jsmql.filter() rejects $out sugar with a Pipeline-mode hint", () => {
    expect(() => jsmql.filter("$$$.x = $$")).toThrow(/jsmql\.filter\(\) does not allow '\$out' sugar/);
  });

  it("jsmql.expr() rejects $out sugar with a Pipeline-mode hint", () => {
    expect(() => jsmql.expr("$$$.x = $$")).toThrow(/jsmql\.expr\(\) does not allow '\$out' sugar/);
  });

  it("jsmql.update() rejects $out via the existing whitelist error", () => {
    expect(() => jsmql.update("$$$.x = $$")).toThrow(/rejected '\$out'/);
  });

  it("jsmql.pipeline() accepts $out sugar (no `;` required)", () => {
    expect(jsmql.pipeline("$$$.warehouse_orders = $$")).toEqual([{ $out: "warehouse_orders" }]);
  });
});

describe("$out — validate() carries meaningful positions", () => {
  it("a malformed LHS error has a non-zero position pointing at the LHS", () => {
    const v = jsmql.validate("  $$$.a.b = $$;");
    expect(v.valid).toBe(false);
    expect(v.errors).toHaveLength(1);
    expect(v.errors[0].message).toMatch(/too many segments/);
    expect(v.errors[0].pos).toBeGreaterThan(0);
  });

  it("trailing-stage error carries the offending statement's position", () => {
    const v = jsmql.validate("$$$.x = $$; $.y = 1;");
    expect(v.valid).toBe(false);
    expect(v.errors[0].message).toMatch(/\$out.*must be the last stage/);
    expect(v.errors[0].pos).toBeGreaterThan(0);
  });
});

// A `$out` RHS chain runs at the OUTER pipeline level, so a stage link there is
// an ordinary top-level stage placed before the write.
describe("$out RHS accepts chained stage calls", () => {
  it("lowers a stage link before the write", () => {
    expect(jsmql("$$$.archive = $$.$sort({ a: 1 });")).toEqual([{ $sort: { a: 1 } }, { $out: "archive" }]);
  });

  it("chains several, and mixes with .filter", () => {
    expect(jsmql('$$$.archive = $$.$match({ s: "x" }).$sort({ a: -1 }).$limit(10);')).toEqual([
      { $match: { s: "x" } },
      { $sort: { a: -1 } },
      { $limit: 10 },
      { $out: "archive" },
    ]);
    expect(jsmql("$$$.archive = $$.filter(d => d.a > 1).$sort({ a: 1 });")).toEqual([
      { $match: { a: { $gt: 1 } } },
      { $sort: { a: 1 } },
      { $out: "archive" },
    ]);
  });

  // Same stages, whichever way they're written.
  it("is identical to writing the stages as statements before the write", () => {
    expect(jsmql('$$$.archive = $$.$match({ s: "x" }).$sort({ a: -1 });')).toEqual(
      jsmql('$match({ s: "x" }); $sort({ a: -1 }); $$$.archive = $$;'),
    );
  });

  it("carries the cross-database write destination", () => {
    expect(jsmql("$$$$.otherdb.archive = $$.$sort({ a: 1 });")).toEqual([
      { $sort: { a: 1 } },
      { $out: { db: "otherdb", coll: "archive" } },
    ]);
  });

  describe("placement", () => {
    // The `$out` always follows, so a second write stage can never be last.
    it("rejects a write stage in the chain", () => {
      expect(() => jsmql('$$$.archive = $$.$out("other");')).toThrow(/'\$out' must be the last stage in a pipeline/);
    });
    it("rejects a source stage that isn't first", () => {
      expect(() => jsmql('$$$.archive = $$.$match({ s: "x" }).$documents([{ x: 1 }]);')).toThrow(
        /'\$documents' must be the first stage/,
      );
    });
    it("rejects an unknown stage name with a suggestion", () => {
      expect(() => jsmql("$$$.archive = $$.$prject({ a: 1 });")).toThrow(
        /'\$prject' is not a known aggregation stage\. Did you mean '\$project'\?/,
      );
    });
  });
});
