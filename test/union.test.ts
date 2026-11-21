import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";
import { truthy } from "./truthy.ts";

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
      {
        $unionWith: {
          coll: "archive_users",
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

  it("inline batch is split by a collection arg between (order preserved)", () => {
    expect(jsmql("$$.push({a:1}, {a:2}, ...$$$.coll, {b:3})")).toEqual([
      { $unionWith: { pipeline: [{ $documents: [{ a: 1 }, { a: 2 }] }] } },
      { $unionWith: "coll" },
      { $unionWith: { pipeline: [{ $documents: [{ b: 3 }] }] } },
    ]);
  });
});

describe("$$.push / $$ = [ … ] — a written document holds only what the program spells", () => {
  it("refuses an outer-document read, in either spelling", () => {
    const outer = /'\$unionWith' has no 'let': its body cannot read the outer document/;
    expect(() => jsmql("$$.push({ n: $.a });")).toThrow(outer);
    expect(() => jsmql("$$ = [{ n: $.a }];")).toThrow(outer);
    expect(() => jsmql("$$.push({ n: $$.size() });")).toThrow(outer);
    expect(() => jsmql("$$ = [{ n: $$.size() }];")).toThrow(outer);
  });

  it("refuses a value that needs a stage of its own, in either spelling", () => {
    const made = /writes the documents out as the program spells them\. This value needs a '\$lookup' stage of its own/;
    expect(() => jsmql('$$.push({ n: $$$.p.find({ _id: "x" }).n });')).toThrow(made);
    expect(() => jsmql('$$.concat([{ n: $$$.p.find({ _id: "x" }).n }]);')).toThrow(made);
    expect(() => jsmql('$$ = [{ n: $$$.p.find({ _id: "x" }).n }];')).toThrow(made);
    expect(() => jsmql('$$.concat([{ n: $$$.p.find({ _id: "x" }).n }]);')).toThrow(/'\.concat\(\[\{ … \}\]\)'/);
    expect(jsmql('$$.push($$$.p.find({ _id: "x" }));')).toEqual([
      { $unionWith: { coll: "p", pipeline: [{ $match: { _id: "x" } }, { $limit: 1 }] } },
    ]);
  });

  it("keeps a written list the program does spell out", () => {
    expect(jsmql("$$ = [{ n: 1 }, { n: 2 }];")).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { pipeline: [{ $documents: [{ n: 1 }, { n: 2 }] }] } },
    ]);
  });
});

describe("$$.push — cross-database through $$$$ is rejected", () => {
  it("a cross-DB .filter() spread source throws (sub-pipeline form)", () => {
    expect(() => jsmql("$$.push(...$$$$.archive.users.filter(u => u.deleted))")).toThrow(
      "A read of another DATABASE is not supported. '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    );
  });

  it("a bare cross-DB collection spread source throws (short-form $unionWith path)", () => {
    expect(() => jsmql("$$.push(...$$$$.archive.users)")).toThrow(
      "A read of another DATABASE is not supported. '$lookup' and '$unionWith' reach the current database only (the '{ db, coll }' form is Atlas Data Federation's). Drop the '$$$$.<db>.' prefix — '$$$.<coll>' — and run the pipeline against that database. Cross-database WRITES work: '$$$$.<db>.<coll> = $$'.",
    );
  });
});

describe("$$.push — auto-Pipeline-wrap for single-statement input", () => {
  it("a bare `$$.push(...)` expression (no `;`) auto-wraps to a one-stage pipeline", () => {
    expect(jsmql("$$.push(...$$$.archive)")).toEqual([{ $unionWith: "archive" }]);
  });
});

describe("$$.push — mixed args (real-world chain)", () => {
  it("inline + find + filter all together preserve source order with proper batches", () => {
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
  it(".filter without spread → reject, and the hint names the spread form", () => {
    expect(() => jsmql("$$.push($$$.archive.filter(o => o.active))")).toThrow(
      "'$$.push($$$.<coll>.filter(pred))' would push the whole array as one document. Spread it — '$$.push(...$$$.<coll>.filter(pred))' — to push every match, or write '.find(pred)' for the first one.",
    );
  });

  it(".find with spread → reject, and the hint names the form with no spread", () => {
    expect(() => jsmql("$$.push(...$$$.archive.find(o => o._id === 'X'))")).toThrow(
      "'.find(pred)' gives ONE document. JavaScript would not spread this. Drop the '...' to push the match, or write '...$$$.<coll>.filter(pred)' to push every match.",
    );
  });

  it("scalar literal arg → reject (collections only hold documents)", () => {
    expect(() => jsmql("$$.push(42)")).toThrow(
      "'$$.push()' argument 1 takes a document, but got a number. Push a document ('$$.push({ … })'), a written list of them ('$$.push(...[{ … }])'), or another collection ('$$.push(...$$$.<coll>)').",
    );
  });

  it("null arg → reject", () => {
    expect(() => jsmql("$$.push(null)")).toThrow(
      "'$$.push()' argument 1 takes a document, but got null. Push a document ('$$.push({ … })'), a written list of them ('$$.push(...[{ … }])'), or another collection ('$$.push(...$$$.<coll>)').",
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
    expect(() => jsmql('$$.nosuchmethod("x")')).toThrow(
      "'.nosuchmethod()' is not a method of the stream '$$'. A stage is a link too: '$$.$match(…)'.",
    );
    expect(() => jsmql('$$.pop("x")')).toThrow("'.pop()' is not available on a 'stream' — it is defined on 'array'.");
  });

  it("push used as RHS / value → reject with statement-only message", () => {
    expect(() => jsmql("$.x = $$.push(...$$$.coll)")).toThrow(
      "A chain on '$$' is a stream of documents, not a value. To branch the stream write '$ = { k: $$.filter(…), … }' (a '$facet'); for its size write '$$.size()'; to keep the documents, chain them as a statement: '$$.filter(…);'.",
    );
  });

  it("push inside a lookup `.aggregate` block → reject with hoist hint", () => {
    expect(() => jsmql("$.users = $$$.users.aggregate(u => { $$.push(...$$$.archive); })")).toThrow(
      "'$$' is the root stream, and a body over another collection cannot reach it. Name the body's own stream through the callback's third parameter — '(o, _i, stream) => { stream.filter(…); }' — or write the stage: '$match(…)', '$sort(…)'.",
    );
  });

  it("push inside a sub-pipeline ([...] form) → a $unionWith stage in that sub-pipeline", () => {
    expect(jsmql("[{ $facet: { archive: [$$.push(...$$$.archive)] } }]")).toEqual([
      { $facet: { archive: [{ $unionWith: "archive" }] } },
    ]);
  });
});

describe("$$.push — mode rejections", () => {
  it("jsmql.filter() rejects $$.push", () => {
    expect(() => jsmql.filter("$$.push(...$$$.coll)")).toThrow(
      "jsmql.filter() expects a Filter (the document `db.coll.find(filter)` takes). It received a top-level 'push' stage call instead. Use jsmql.pipeline().",
    );
  });

  it("jsmql.expr() rejects $$.push", () => {
    expect(() => jsmql.expr("$$.push(...$$$.coll)")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`). It received a top-level 'push' stage call instead. Use jsmql.pipeline().",
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
      const err = e as { pos: number };
      expect(typeof err.pos).toBe("number");
      expect(err.pos).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("chain errors only ever name syntax that works here", () => {
  it("names '.push()' for a near-miss of it on the stream", () => {
    expect(() => jsmql("$$ = $$.pushh({ a: 1 });")).toThrow(
      "'.pushh()' is not a method of the stream '$$'. Did you mean '.push()'? A stage is a link too: '$$.$match(…)'.",
    );
    expect(() => jsmql("$$.pushh({ a: 1 });")).toThrow(
      "'.pushh()' is not a method of the stream '$$'. Did you mean '.push()'? A stage is a link too: '$$.$match(…)'.",
    );
    expect(() => jsmql("$$.filter((d) => d.a).pushh({ a: 1 });")).toThrow(
      "'.pushh()' is not a method of the stream '$$'. Did you mean '.push()'? A stage is a link too: '$$.$match(…)'.",
    );
  });

  it("writes a chained .push as .concat writes it: one $unionWith", () => {
    expect(jsmql("$$ = $$.push({ a: 1 });")).toEqual([{ $unionWith: { pipeline: [{ $documents: [{ a: 1 }] }] } }]);
    expect(jsmql("$$ = $$.concat({ a: 1 });")).toEqual([{ $unionWith: { pipeline: [{ $documents: [{ a: 1 }] }] } }]);
  });

  it("offers the statement form only where a statement position exists", () => {
    expect(() => jsmql("$ = { k: $$.push({ a: 1 }) };")).toThrow(
      "'.push(<document>)' makes a '$documents' stage, and the server refuses that anywhere inside a '$facet' — however deeply it is nested. Append another collection instead ('$$.push(...$$$.<coll>)'), or append the documents outside the branch.",
    );
    expect(jsmql("$ = { k: $$.push(...$$$.archive) };")).toEqual([{ $facet: { k: [{ $unionWith: "archive" }] } }]);
  });

  it("suggests a real chain method for a near-miss", () => {
    expect(() => jsmql("$$ = $$.dropp();")).toThrow(
      "'.dropp()' is not a method of the stream '$$'. Did you mean '.drop()'? A stage is a link too: '$$.$match(…)'.",
    );
  });
});

describe("$$.push detection reaches every lambda body form", () => {
  const cases: [string, string][] = [
    ["expression body", "$.x = $.a.map(d => $$.push({n:d}));"],
    ["block body with a const", "$.x = $.a.map(d => { const q = $$.push({n:d}); return q; });"],
    ["nested two deep", "$.x = $.a.map(d => d.b.map(e => { const q = $$.push({n:e}); return q; }));"],
  ];
  for (const [name, src] of cases) {
    it(`rejects a buried push — ${name}`, () => {
      expect(() => jsmql(src)).toThrow(
        "A chain on '$$' is a stream of documents, not a value. To branch the stream write '$ = { k: $$.filter(…), … }' (a '$facet'); for its size write '$$.size()'; to keep the documents, chain them as a statement: '$$.filter(…);'.",
      );
    });
  }
});
