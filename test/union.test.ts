// Tests for the `$$.push(...)` → `$unionWith` lowering.
// See docs/specs/union-stage.md for the design and docs/LANGUAGE.md for
// the user-facing reference.

import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

describe("$$.push — bare collection (short form)", () => {
  it("spread of $$$.<coll> with no method lowers to the bare-string $unionWith short form", () => {
    expect(jsmql("$$.push(...$$$.archive_users)")).toEqual([{ $unionWith: "archive_users" }]);
  });

  it("works inside a multi-statement pipeline, between other stages", () => {
    expect(jsmql("$match($.active === true); $$.push(...$$$.archive); $sort({ name: 1 })")).toEqual([
      { $match: { active: true } },
      { $unionWith: "archive" },
      { $sort: { name: 1 } },
    ]);
  });
});

describe("$$.push — .filter spread (pipeline-form $unionWith)", () => {
  it("expression-body filter lowers to a $match-only sub-pipeline", () => {
    expect(jsmql("$$.push(...$$$.archive_users.filter(u => u.active))")).toEqual([
      { $unionWith: { coll: "archive_users", pipeline: [{ $match: { $expr: "$active" } }] } },
    ]);
  });

  it("block-body filter passes through stage statements verbatim", () => {
    expect(
      jsmql(
        "$$.push(...$$$.archive_users.filter(o => { $match(o.tier === 'gold'); $sort({ joined: -1 }); $limit(100); }))",
      ),
    ).toEqual([
      {
        $unionWith: {
          coll: "archive_users",
          pipeline: [{ $match: { tier: "gold" } }, { $sort: { joined: -1 } }, { $limit: 100 }],
        },
      },
    ]);
  });
});

describe("$$.push — .find no-spread (single-doc append)", () => {
  it("lowers to a $match + $limit: 1 sub-pipeline", () => {
    expect(jsmql("$$.push($$$.archive_users.find(u => u._id === 'ABC'))")).toEqual([
      { $unionWith: { coll: "archive_users", pipeline: [{ $match: { _id: "ABC" } }, { $limit: 1 }] } },
    ]);
  });
});

describe("$$.push — inline document(s)", () => {
  it("a single inline doc lowers to a $documents-form $unionWith", () => {
    expect(jsmql("$$.push({ _id: 1, name: 'Alice' })")).toEqual([
      { $unionWith: { pipeline: [{ $documents: [{ _id: 1, name: "Alice" }] }] } },
    ]);
  });

  it("consecutive inline docs batch into one $documents stage", () => {
    expect(jsmql("$$.push({a:1}, {a:2}, {a:3})")).toEqual([
      { $unionWith: { pipeline: [{ $documents: [{ a: 1 }, { a: 2 }, { a: 3 }] }] } },
    ]);
  });

  it("inline doc followed by collection spread → two stages, source order", () => {
    expect(jsmql("$$.push({a:1}, ...$$$.archive)")).toEqual([
      { $unionWith: { pipeline: [{ $documents: [{ a: 1 }] }] } },
      { $unionWith: "archive" },
    ]);
  });

  it("collection spread followed by inline doc → two stages, source order", () => {
    expect(jsmql("$$.push(...$$$.archive, { a: 1 })")).toEqual([
      { $unionWith: "archive" },
      { $unionWith: { pipeline: [{ $documents: [{ a: 1 }] }] } },
    ]);
  });

  it("inline batch is split by an intervening collection arg (order preserved)", () => {
    expect(jsmql("$$.push({a:1}, {a:2}, ...$$$.coll, {b:3})")).toEqual([
      { $unionWith: { pipeline: [{ $documents: [{ a: 1 }, { a: 2 }] }] } },
      { $unionWith: "coll" },
      { $unionWith: { pipeline: [{ $documents: [{ b: 3 }] }] } },
    ]);
  });
});

describe("$$.push — cross-database via $$$$ is rejected", () => {
  // Two DISTINCT `requireSameDbColl` call sites in union-translation: the
  // `.filter`/`.find` spread goes through `buildUnionWith`, the bare collection
  // through the short-form `$unionWith` branch. Each gets a test so a refactor
  // that bypasses the guard on either path is caught.
  it("a cross-DB .filter() spread source throws (buildUnionWith path)", () => {
    expect(() => jsmql("$$.push(...$$$$.archive.users.filter(u => u.deleted))")).toThrow(
      /Cross-database reads aren't supported/,
    );
  });

  it("a bare cross-DB collection spread source throws (short-form $unionWith path)", () => {
    expect(() => jsmql("$$.push(...$$$$.archive.users)")).toThrow(/Cross-database reads aren't supported/);
  });
});

describe("$$.push — auto-Pipeline-wrap for single-statement input", () => {
  it("a bare `$$.push(...)` expression (no `;`) auto-wraps to a one-stage pipeline", () => {
    expect(jsmql("$$.push(...$$$.archive)")).toEqual([{ $unionWith: "archive" }]);
  });
});

describe("$$.push — mixed args (real-world chain)", () => {
  it("inline + find + filter all together preserve source order with proper batching", () => {
    expect(
      jsmql("$$.push({ a: 1 }, $$$.coll.find(p => p._id === 'X'), ...$$$.other.filter(o => o.tier === 'gold'))"),
    ).toEqual([
      { $unionWith: { pipeline: [{ $documents: [{ a: 1 }] }] } },
      { $unionWith: { coll: "coll", pipeline: [{ $match: { _id: "X" } }, { $limit: 1 }] } },
      { $unionWith: { coll: "other", pipeline: [{ $match: { tier: "gold" } }] } },
    ]);
  });
});

describe("$$.push — error cases", () => {
  it(".filter without spread → reject with 'use ...' hint", () => {
    expect(() => jsmql("$$.push($$$.archive.filter(o => o.active))")).toThrow(
      /push the whole array as a single document.*Use `\$\$\.push\(\.\.\.\$\$\$/,
    );
  });

  it(".find with spread → reject with 'drop the ...' hint", () => {
    expect(() => jsmql("$$.push(...$$$.archive.find(o => o._id === 'X'))")).toThrow(
      /`\.find` returns a single document.*Drop the `\.\.\.`/,
    );
  });

  it("scalar literal arg → reject (collections only hold documents)", () => {
    expect(() => jsmql("$$.push(42)")).toThrow(/argument must be a document literal.*Got a number literal/);
  });

  it("null arg → reject", () => {
    expect(() => jsmql("$$.push(null)")).toThrow(/argument must be a document literal.*Got `null`/);
  });

  it("correlated predicate ($. in filter pred) → reject with $unionWith-no-let hint", () => {
    expect(() => jsmql("$$.push(...$$$.coll.filter(o => o.x === $.y))")).toThrow(
      /\$unionWith` has no `let` slot.*Move the local-doc filter to a `\$match/,
    );
  });

  it("empty args → reject with shape hint", () => {
    expect(() => jsmql("$$.push()")).toThrow(/requires at least one argument/);
  });

  it("wrong method on $$ → stream-method registry error that still names .push", () => {
    expect(() => jsmql('$$.pop("x")')).toThrow(
      /'\.pop\(\.\.\.\)' is not a chainable stream method on '\$\$'.*'\.push\(\.\.\.\)' appends documents as a statement/,
    );
  });

  it("push used as RHS / value → reject with statement-only message", () => {
    expect(() => jsmql("$.x = $$.push(...$$$.coll)")).toThrow(
      /statement-only.*cannot appear on a RHS or inside another expression/,
    );
  });

  it("push inside a lookup block-body → reject with hoist hint", () => {
    expect(() => jsmql("$.users = $$$.users.filter(u => { $$.push(...$$$.archive); })")).toThrow(
      /'\$\$\.push\(\.\.\.\)' inside a lookup's block-body lambda is not supported/,
    );
  });

  it("push inside a sub-pipeline ([...] form) → reject with hoist hint", () => {
    // Construct a sub-pipeline via $facet's `*` slot — every value is a pipeline.
    expect(() => jsmql("[{ $facet: { archive: [$$.push(...$$$.archive)] } }]")).toThrow(
      /'\$\$\.push\(\.\.\.\)' inside a sub-pipeline/,
    );
  });
});

describe("$$.push — mode rejections", () => {
  it("jsmql.filter() rejects $$.push", () => {
    expect(() => jsmql.filter("$$.push(...$$$.coll)")).toThrow(
      /jsmql\.filter\(\) does not allow '\$\$\.push\(\.\.\.\)'/,
    );
  });

  it("jsmql.expr() rejects $$.push", () => {
    expect(() => jsmql.expr("$$.push(...$$$.coll)")).toThrow(/jsmql\.expr\(\) does not allow '\$\$\.push/);
  });

  it("jsmql.update() rejects $$.push with the update-pipeline-whitelist hint", () => {
    expect(() => jsmql.update("$$.push(...$$$.coll)")).toThrow(
      /jsmql\.update\(\) does not allow '\$\$\.push\(\.\.\.\)'.*MongoDB's aggregation-pipeline update form only accepts/,
    );
  });
});

describe("$$.push — error positions", () => {
  it(".find inside spread reports the position of the inner .find call, not the receiver", () => {
    const src = "$$.push(...$$$.archive.find(o => o._id === 'X'))";
    try {
      jsmql(src);
      throw new Error("expected throw");
    } catch (e) {
      // pos should land on the inner MethodCall, which starts at `$$$.archive.find`
      const err = e as { pos: number };
      expect(typeof err.pos).toBe("number");
      // The .find call's pos is at the start of the `$$$.archive.find(...)` expr
      // (DatabaseRef position). Roughly past the `$$.push(...`. We don't pin
      // the exact byte; just that it points into the arg, not at index 0.
      expect(err.pos).toBeGreaterThan(8);
    }
  });
});
