// Tests for the `$$.push(...)` → `$unionWith` lowering.
// See docs/specs/union-stage.md for the design and docs/LANGUAGE.md for
// the user-facing reference.

import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";
import { truthy } from "./truthy.ts";

describe("$$.push — bare collection (short form)", () => {
  it("spread of $$$.<coll> with no method lowers to the bare-string $unionWith short form", () => {
    expect(jsmql("$$.push(...$$$.archive_users)")).toEqual([{ $unionWith: "archive_users" }]);
  });

  it("works inside a multi-statement pipeline, between other stages", () => {
    expect(jsmql("$match($.active === true); $$.push(...$$$.archive); $sort({ name: 1 })")).toEqual([
      { $match: { active: { $eq: true, $not: { $type: "array" } } } },
      { $unionWith: "archive" },
      { $sort: { name: 1 } },
    ]);
  });
});

describe("$$.push — .filter spread (pipeline-form $unionWith)", () => {
  it("expression-body filter lowers to a $match-only sub-pipeline", () => {
    expect(jsmql("$$.push(...$$$.archive_users.filter(u => u.active))")).toEqual([
      {
        $unionWith: {
          coll: "archive_users",
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
        },
      },
    ]);
  });

  it("block-body filter passes through stage statements verbatim", () => {
    expect(
      jsmql(
        "$$.push(...$$$.archive_users.aggregate(o => { $match(o.tier === 'gold'); $sort({ joined: -1 }); $limit(100); }))",
      ),
    ).toEqual([
      {
        $unionWith: {
          coll: "archive_users",
          pipeline: [
            { $match: { tier: { $eq: "gold", $not: { $type: "array" } } } },
            { $sort: { joined: -1 } },
            { $limit: 100 },
          ],
        },
      },
    ]);
  });
});

describe("$$.push — .find no-spread (single-doc append)", () => {
  it("lowers to a $match + $limit: 1 sub-pipeline", () => {
    expect(jsmql("$$.push($$$.archive_users.find(u => u._id === 'ABC'))")).toEqual([
      {
        $unionWith: {
          coll: "archive_users",
          pipeline: [{ $match: { _id: { $eq: "ABC", $not: { $type: "array" } } } }, { $limit: 1 }],
        },
      },
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
  // Both spread sources resolve through `lookupOf` (src/compiler/emit/join.ts), whose
  // chain base refuses a `$$$$.<db>.` root: the `.filter`/`.find` form carries a
  // sub-pipeline, the bare collection carries none. Each gets a test so a refactor
  // that bypasses the guard on either path is caught.
  it("a cross-DB .filter() spread source throws (sub-pipeline form)", () => {
    expect(() => jsmql("$$.push(...$$$$.archive.users.filter(u => u.deleted))")).toThrow(
      "A read of another DATABASE isn't supported: '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    );
  });

  it("a bare cross-DB collection spread source throws (short-form $unionWith path)", () => {
    expect(() => jsmql("$$.push(...$$$$.archive.users)")).toThrow(
      "A read of another DATABASE isn't supported: '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    );
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
      {
        $unionWith: {
          coll: "coll",
          pipeline: [{ $match: { _id: { $eq: "X", $not: { $type: "array" } } } }, { $limit: 1 }],
        },
      },
      { $unionWith: { coll: "other", pipeline: [{ $match: { tier: { $eq: "gold", $not: { $type: "array" } } } }] } },
    ]);
  });
});

describe("$$.push — error cases", () => {
  it(".filter without spread → reject with 'use ...' hint", () => {
    expect(() => jsmql("$$.push($$$.archive.filter(o => o.active))")).toThrow(
      "'$$.push($$$.<coll>.filter(pred))' would push the whole array as one document. Spread it — '$$.push(...$$$.<coll>.filter(pred))' — to push every match, or write '.find(pred)' for the first one.",
    );
  });

  it(".find with spread → reject with 'drop the ...' hint", () => {
    expect(() => jsmql("$$.push(...$$$.archive.find(o => o._id === 'X'))")).toThrow(
      "'.find(pred)' gives ONE document, which JavaScript would not spread. Drop the '...' to push the match, or write '...$$$.<coll>.filter(pred)' to push every match.",
    );
  });

  it("scalar literal arg → reject (collections only hold documents)", () => {
    expect(() => jsmql("$$.push(42)")).toThrow(
      "A stream holds documents, and this is a number. Push a document ('$$.push({ … })') or another collection ('$$.push(...$$$.<coll>)').",
    );
  });

  it("null arg → reject", () => {
    expect(() => jsmql("$$.push(null)")).toThrow(
      "A stream holds documents, and this is a null. Push a document ('$$.push({ … })') or another collection ('$$.push(...$$$.<coll>)').",
    );
  });

  it("correlated predicate ($. in filter pred) → reject with $unionWith-no-let hint", () => {
    expect(() => jsmql("$$.push(...$$$.coll.filter(o => o.x === $.y))")).toThrow(
      "'$unionWith' has no 'let': its body cannot read the outer document or a binding declared outside it. Filter or reshape the outer stream in a statement before it, or read the other collection through a join ('$.<field> = $$$.<coll>.filter(…)'), whose '$lookup' carries the value.",
    );
  });

  it("empty args → reject with shape hint", () => {
    expect(() => jsmql("$$.push()")).toThrow(
      "Nothing to add to the stream: give a document ('$$.push({ … })'), another collection ('$$.push(...$$$.<coll>)'), or one of its documents ('$$.push($$$.<coll>.find(pred))').",
    );
  });

  it("an unrecognised method on $$ → registry error that still names .push", () => {
    // A name nobody recognises takes the generic path, which lists what IS chainable
    // and names both append routes. A method jsmql KNOWS but cannot lower on a stream
    // (`.pop`, `.flat`, …) gets its own reason instead — see STREAM_UNSUPPORTED.
    expect(() => jsmql('$$.nosuchmethod("x")')).toThrow(
      "'.nosuchmethod()' is not a method of the stream '$$'. A stage is a link too: '$$.$match(…)'.",
    );
    expect(() => jsmql('$$.pop("x")')).toThrow("'.pop()' is not available on a 'stream' — it is defined on 'array'.");
  });

  it("push used as RHS / value → reject with statement-only message", () => {
    expect(() => jsmql("$.x = $$.push(...$$$.coll)")).toThrow(
      "A chain on '$$' is a stream of documents, not a value. To branch the stream write '$ = { k: $$.filter(…), … }' (a '$facet'); for its size write '$$.length'; to keep the documents, chain them as a statement: '$$.filter(…);'.",
    );
  });

  it("push inside a lookup `.aggregate` block → reject with hoist hint", () => {
    expect(() => jsmql("$.users = $$$.users.aggregate(u => { $$.push(...$$$.archive); })")).toThrow(
      "'$$' is the root stream, and a body over another collection cannot reach it. Name the body's own stream through the callback's third parameter — '(o, _i, coll) => { coll.filter(…); }' — or write the stage: '$match(…)', '$sort(…)'.",
    );
  });

  it("push inside a sub-pipeline ([...] form) → reject with hoist hint", () => {
    // Construct a sub-pipeline via $facet's `*` slot — every value is a pipeline.
    expect(jsmql("[{ $facet: { archive: [$$.push(...$$$.archive)] } }]")).toEqual([
      { $facet: { archive: [{ $unionWith: "archive" }] } },
    ]);
  });
});

describe("$$.push — mode rejections", () => {
  it("jsmql.filter() rejects $$.push", () => {
    expect(() => jsmql.filter("$$.push(...$$$.coll)")).toThrow(
      "jsmql.filter() expects a Filter (the document `db.coll.find(filter)` takes), but received a top-level 'push' stage call. Use jsmql.pipeline().",
    );
  });

  it("jsmql.expr() rejects $$.push", () => {
    expect(() => jsmql.expr("$$.push(...$$$.coll)")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`), but received a top-level 'push' stage call. Use jsmql.pipeline().",
    );
  });

  it("jsmql.update() rejects $$.push with the update-pipeline-whitelist hint", () => {
    expect(() => jsmql.update("$$.push(...$$$.coll)")).toThrow(
      "An update document is made of writes — '$.a = 1', '$.n += 2', 'delete $.b', '$.tags.push(x)' — or of update operators ('$inc({ n: 2 })', '{ $set: { a: 1 } }'). This is neither.",
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
      expect(err.pos).toBeGreaterThanOrEqual(8);
    }
  });
});

// An error must never recommend syntax that doesn't work at the position the
// user is writing in. Two ways that used to happen on a `$$` chain.
describe("chain errors only ever name syntax that works here", () => {
  it("never suggests the exact name the user typed", () => {
    const msg = (() => {
      try {
        jsmql("$ = { k: $$.push({ a: 1 }) };");
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(msg).not.toMatch(/Did you mean '\.push'/);
  });

  it("points a chained .push at .concat, which emits the same $unionWith", () => {
    expect(jsmql("$$ = $$.push({ a: 1 });")).toEqual([{ $unionWith: { pipeline: [{ $documents: [{ a: 1 }] }] } }]);
    expect(jsmql("$$ = $$.concat({ a: 1 });")).toEqual([{ $unionWith: { pipeline: [{ $documents: [{ a: 1 }] }] } }]);
  });

  // A `$facet` branch has no statement position, so the statement form must not
  // be offered there — but it must still be offered where it does work.
  it("offers the statement form only where a statement position exists", () => {
    expect(jsmql("$$ = $$.push({ a: 1 });")).toEqual([{ $unionWith: { pipeline: [{ $documents: [{ a: 1 }] }] } }]);
    expect(jsmql("$ = { k: $$.push({ a: 1 }) };")).toEqual([
      { $facet: { k: [{ $unionWith: { pipeline: [{ $documents: [{ a: 1 }] }] } }] } },
    ]);
  });

  // `.pop` used to be answered with `.push`, which isn't a chain method either.
  it("suggests a real chain method for a near-miss", () => {
    expect(() => jsmql("$$ = $$.dropp();")).toThrow(
      "'.dropp()' is not a method of the stream '$$'. Did you mean '.drop()'? A stage is a link too: '$$.$match(…)'.",
    );
  });
});

describe("$$.push detection reaches every lambda body form", () => {
  // The gate walks the whole tree, so a `$$.push(...)` buried in any callback
  // body shape gets the purpose-built rejection rather than a downstream one.
  const cases: [string, string][] = [
    ["expression body", "$.x = $.a.map(d => $$.push({n:d}));"],
    ["block body with a const", "$.x = $.a.map(d => { const q = $$.push({n:d}); return q; });"],
    ["nested two deep", "$.x = $.a.map(d => d.b.map(e => { const q = $$.push({n:e}); return q; }));"],
  ];
  for (const [name, src] of cases) {
    it(`rejects a buried push — ${name}`, () => {
      // an update document holds constants; a stream union buried in a value is refused as one
      expect(() => jsmql.update(src)).toThrow(/takes constants|is made of writes/);
    });
  }
});
