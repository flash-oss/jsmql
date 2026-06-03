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
                { $ne: ["$active", null] },
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
    // `.map` / `.filter` / `.slice` / `.toSorted` / `.toReversed` / `.flatMap` /
    // `.concat` all flow through the stream-methods registry now (Wave 4 #11).
    // Methods OUTSIDE the registry still get the "use a separate stage" hint.
    expect(() => jsmql("$$$.coll = $$.unknownMethod();")).toThrow(/isn't a recognised chain method for a '\$out' RHS/);
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

describe("$out — multi-method RHS chains (Wave 4 #11)", () => {
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

describe("$out — ParamRef in bracket-LHS (Wave 4 #12, jsmql.compile binding)", () => {
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
