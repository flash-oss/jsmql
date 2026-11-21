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
                { $gt: ["$active", null] },
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
    expect(jsmql("$$$.top10 = $$.aggregate(o => { $sort({ score: -1 }); $limit(10); });")).toEqual([
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
    expect(() => jsmql("$$$.x = $$; $.y = 1;")).toThrow(
      "Nothing can follow '$$$.x = …': it writes the pipeline's output and the server requires it last. Move this statement above it.",
    );
  });

  it("two $out statements in one pipeline throw through the same guard", () => {
    expect(() => jsmql("$$$.a = $$; $$$.b = $$;")).toThrow(
      "Nothing can follow '$$$.a = …': it writes the pipeline's output and the server requires it last. Move this statement above it.",
    );
  });
});

describe("$out — LHS shape errors", () => {
  it("too many segments after $$$ ('$$$.a.b = …') points at the cross-DB form", () => {
    expect(() => jsmql("$$$.a.b = $$;")).toThrow(
      "Too many segments for a collection to write: one name for the current database ('$$$.<coll> = $$'), a database and a name for another ('$$$$.<db>.<coll> = $$').",
    );
  });

  it("only one segment after $$$$ ('$$$$.x = …') points at the missing collection", () => {
    expect(() => jsmql("$$$$.x = $$;")).toThrow(
      "'$$$$.<db>' names a database; write the collection too: '$$$$.<db>.<coll> = $$' — or '$$$.<coll> = $$' for the current database.",
    );
  });

  it("three segments after $$$$ ('$$$$.a.b.c = …') points at the deepest form", () => {
    expect(() => jsmql("$$$$.a.b.c = $$;")).toThrow(
      "Too many segments for a collection to write: one name for the current database ('$$$.<coll> = $$'), a database and a name for another ('$$$$.<db>.<coll> = $$').",
    );
  });

  it("JSMQL refuses a computed bracket, and the hint asks for a literal collection name", () => {
    expect(() => jsmql("$$$[someVar] = $$;")).toThrow(
      "The collection is named when the pipeline is written: '$$$.<coll>' or '$$$[\"<coll>\"]'. To choose it at run time, build the pipeline with 'jsmql.compile' and pass the name in.",
    );
  });
});

describe("$out — RHS shape errors", () => {
  it("a chain method no row states names the workaround", () => {
    expect(() => jsmql("$$$.coll = $$.unknownMethod();")).toThrow(
      "'.unknownMethod()' is not a method of the stream '$$'. A stage is a link too: '$$.$match(…)'.",
    );
  });

  it("suggests a near-miss chain method name", () => {
    expect(() => jsmql("$$$.coll = $$.mpa(d => d.x);")).toThrow(/Did you mean '\.map\(\)'\?/);
    expect(() => jsmql("$$$.coll = $$.fliter({ a: 1 });")).toThrow(/Did you mean '\.filter\(\)'\?/);
    expect(() => jsmql("$$$.coll = $$.wibble();")).toThrow(
      "'.wibble()' is not a method of the stream '$$'. A stage is a link too: '$$.$match(…)'.",
    );
  });

  it("names the stage equivalent for a JS method a stream chain deliberately lacks", () => {
    expect(() => jsmql("$$$.coll = $$.reduce((a, d) => a + d.n, 0);")).toThrow(
      "'.reduce(...)' is not a chain method on '$$' — in JS '.reduce' collapses an array to a single value, but '$$' must stay a stream of documents. To fold the whole stream, write a '$group' statement: '$group({ _id: null, total: $sum($.n) });'. To fold an array a document carries, call it on that array: '$.<field>.reduce((a, b) => a + b, 0)'.",
    );
    expect(() => jsmql("$$$.coll = $$.flat();")).toThrow(
      "'.flat()' isn't available on '$$' — flattens nested ARRAYS, and every element of this stream is a whole document. To split one document's array field into many documents, use '.flatMap(\"<field>\")' — that is '$unwind'; after it, '.flat()' unwinds the element once more.",
    );
  });

  it("RHS not rooted at $$ throws with the supported shapes", () => {
    expect(() => jsmql("$$$.coll = $.someField;")).toThrow(
      "A collection is written from the stream: '$$$.<coll> = $$' replaces it, '$$$.<coll> += $$' adds to it, and either takes more stages first ('… = $$.filter(…)'). To write an ARRAY of documents, name them: '$$$.<coll>.concat(<array>);' or '$$$.<coll>.push(...<array>);'.",
    );
  });

  it("`$.<field>` inside a $$.filter on the RHS reads the same document as the lambda param", () => {
    expect(jsmql("$$$.coll = $$.filter(o => o.x === $.threshold);")).toEqual([
      { $match: { $expr: { $eq: ["$x", "$threshold"] } } },
      { $out: "coll" },
    ]);
  });
});

describe("$out — multi-method RHS chains", () => {
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

describe("$out — .reject is .filter negated", () => {
  const NEGATED = { $match: { $nor: [{ archived: true }] } };
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
      ...(jsmql("$$ = $$.reject({ archived: true });") as unknown[]),
      { $out: "live" },
    ]);
  });

  it("chains with .filter and the rest of the stream methods", () => {
    expect(jsmql("$$$.live = $$.filter(d => d.tier === 'gold').reject({ archived: true }).take(10);")).toEqual([
      { $match: { tier: "gold" } },
      { $match: { $nor: [{ archived: true }] } },
      { $limit: 10 },
      { $out: "live" },
    ]);
  });

  it("accepts the `function` spelling of the predicate", () => {
    expect(jsmql("$$$.live = $$.reject(function (d) { return d.archived === true; });")).toEqual([
      { $match: { $nor: [{ archived: true }] } },
      { $out: "live" },
    ]);
  });
});

describe("$out — ParamRef in bracket-LHS (jsmql.compile binding)", () => {
  it("$$$[boundColl] resolves the bracket through the compile-time binding", () => {
    const fn = jsmql.compile(({ destColl }) => ($$$[destColl] = $$));
    expect(fn({ destColl: "archive" })).toEqual([{ $out: "archive" }]);
  });

  it("$$$$[dbName][collName] resolves both segments", () => {
    const fn = jsmql.compile(({ dbName, collName }) => ($$$$[dbName][collName] = $$));
    expect(fn({ dbName: "warehouse", collName: "users" })).toEqual([{ $out: { db: "warehouse", coll: "users" } }]);
  });

  it("JSMQL rejects a non-string binding, and the message asks for a string", () => {
    const fn = jsmql.compile(({ n }) => ($$$[n] = $$));
    expect(() => fn({ n: 42 })).toThrow("'$$$[…]' key takes a string, but got a number.");
  });
});

describe("$out — mode gates", () => {
  it("jsmql.filter() rejects $out sugar with a Pipeline-mode hint", () => {
    expect(() => jsmql.filter("$$$.x = $$")).toThrow(
      "jsmql.filter() expects a Filter (the document `db.coll.find(filter)` takes). It received a write (`$.x = …`, `delete $.x`) instead. Use jsmql.update() for an update document, or jsmql.pipeline() for a `$set` / `$unset` pipeline.",
    );
  });

  it("jsmql.expr() rejects $out sugar with a Pipeline-mode hint", () => {
    expect(() => jsmql.expr("$$$.x = $$")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`). It received a write (`$.x = …`, `delete $.x`) instead. Use jsmql.update() for an update document, or jsmql.pipeline() for a `$set` / `$unset` pipeline.",
    );
  });

  it("jsmql.update() rejects $out through the existing whitelist error", () => {
    expect(() => jsmql.update("$$$.x = $$")).toThrow(
      "A document-form update writes a field of the document: '$.a = …', '$.a.b += 1', 'delete $.a'.",
    );
  });

  it("jsmql.pipeline() accepts $out sugar (no `;` required)", () => {
    expect(jsmql.pipeline("$$$.warehouse_orders = $$")).toEqual([{ $out: "warehouse_orders" }]);
  });
});

describe("$out — validate() carries meaningful positions", () => {
  it("a malformed LHS error has a non-zero position that points at the LHS", () => {
    const v = jsmql.validate("  $$$.a.b = $$;");
    expect(v.valid).toBe(false);
    expect(v.errors).toHaveLength(1);
    expect(v.errors[0].message).toMatch(
      "Too many segments for a collection to write: one name for the current database ('$$$.<coll> = $$'), a database and a name for another ('$$$$.<db>.<coll> = $$').",
    );
    expect(v.errors[0].pos).toBeGreaterThan(0);
  });

  it("trailing-stage error carries the offending statement's position", () => {
    const v = jsmql.validate("$$$.x = $$; $.y = 1;");
    expect(v.valid).toBe(false);
    expect(v.errors[0].message).toMatch(
      "Nothing can follow '$$$.x = …': it writes the pipeline's output and the server requires it last. Move this statement above it.",
    );
    expect(v.errors[0].pos).toBeGreaterThan(0);
  });
});

describe("$out RHS accepts chained stage calls", () => {
  it("lowers a stage link before the write", () => {
    expect(jsmql("$$$.archive = $$.$sort({ a: 1 });")).toEqual([{ $sort: { a: 1 } }, { $out: "archive" }]);
  });

  it("chains more than one stage, and mixes with .filter", () => {
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

  it("is identical to writing the stages as statements before the write", () => {
    const chain = jsmql('$$$.archive = $$.$match({ s: "x" }).$sort({ a: -1 });');
    expect(chain).toEqual([{ $match: { s: "x" } }, { $sort: { a: -1 } }, { $out: "archive" }]);
    expect(chain).toEqual(jsmql('$match({ s: "x" }); $sort({ a: -1 }); $$$.archive = $$;'));
  });

  it("carries the cross-database write destination", () => {
    expect(jsmql("$$$$.otherdb.archive = $$.$sort({ a: 1 });")).toEqual([
      { $sort: { a: 1 } },
      { $out: { db: "otherdb", coll: "archive" } },
    ]);
  });

  describe("placement", () => {
    it("rejects a write stage in the chain", () => {
      expect(() => jsmql('$$$.archive = $$.$out("other");')).toThrow(
        "'$$$.archive = …' writes the pipeline's output and has to be its last stage, and '$out' already is. A pipeline writes to one destination — keep one of them.",
      );
    });
    it("rejects a source stage that is not first", () => {
      expect(() => jsmql('$$$.archive = $$.$match({ s: "x" }).$documents([{ x: 1 }]);')).toThrow(
        "'$documents' produces the pipeline's source documents, so it has to be the FIRST stage. The server refuses it anywhere else. Move it to the top of the program.",
      );
    });
    it("passes an unknown stage name through, as your own MQL", () => {
      expect(jsmql("$$$.archive = $$.$prject({ a: 1 });")).toEqual([{ $prject: { a: 1 } }, { $out: "archive" }]);
    });
  });
});

describe("$merge — add to a collection", () => {
  it("'+=' writes the stream with $merge, where '=' writes it with $out", () => {
    expect(jsmql("$$$.metrics += $$;")).toEqual([{ $merge: "metrics" }]);
    expect(jsmql("$$$.metrics = $$;")).toEqual([{ $out: "metrics" }]);
    expect(jsmql("$$$$.dw.metrics += $$;")).toEqual([{ $merge: { db: "dw", coll: "metrics" } }]);
  });

  it("'+=' takes the same stages before it that '=' does", () => {
    expect(jsmql("$$$.metrics += $$.filter(d => d.active);")).toEqual([
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
      { $merge: "metrics" },
    ]);
  });

  it("'.concat()' and '.push(...)' write the stream the same way", () => {
    expect(jsmql("$$$.metrics.concat($$);")).toEqual([{ $merge: "metrics" }]);
    expect(jsmql("$$$.metrics.push(...$$);")).toEqual([{ $merge: "metrics" }]);
  });

  it("an ARRAY of documents is written element by element", () => {
    const stages = [{ $unwind: "$items" }, { $replaceWith: "$items" }, { $merge: "metrics" }];
    expect(jsmql("$$$.metrics.concat($.items);")).toEqual(stages);
    expect(jsmql("$$$.metrics.push(...$.items);")).toEqual(stages);
  });

  it("'.push()' without a spread writes ONE document", () => {
    expect(jsmql("$$$.metrics.push($.doc);")).toEqual([{ $replaceWith: "$doc" }, { $merge: "metrics" }]);
    expect(jsmql("$$$.metrics.push({ _id: 9, k: 1 });")).toEqual([
      { $replaceWith: { _id: 9, k: 1 } },
      { $merge: "metrics" },
    ]);
  });

  it("a written list of documents keeps the element rule the stream form states", () => {
    expect(() => jsmql("$$$.metrics.push(...[{ a: 1 }, 5]);")).toThrow(
      "'$$$.<coll>.push(...<array>)' element 2 takes a document, but got a number.",
    );
  });

  it("nothing may follow the write, and the message names the stage that is there", () => {
    expect(() => jsmql("$$$.metrics.concat($$); $.a = 1;")).toThrow(
      "Nothing can follow '$$$.metrics.concat(…)': it writes the pipeline's output and the server requires it last. Move this statement above it.",
    );
    expect(() => jsmql("$$$.metrics = $$; $.a = 1;")).toThrow("Nothing can follow '$$$.metrics = …':");
  });

  it("refuses the writes that name no documents, each naming a spelling that works", () => {
    expect(() => jsmql("$$$.metrics *= $$;")).toThrow(
      "A collection takes '=' or '+=', not '*='. '$$$.<coll> = $$' REPLACES what the collection holds (a '$out'). '$$$.<coll> += $$' ADDS to it: the server updates the documents whose '_id' matches (a '$merge').",
    );
    expect(() => jsmql("$$$.metrics.concat();")).toThrow(
      "Nothing to write into the collection: give the stream ('$$$.<coll>.concat($$);'), an array of documents ('$$$.<coll>.concat(<array>);' or '$$$.<coll>.push(...<array>);'), or one document ('$$$.<coll>.push({ … });').",
    );
    expect(() => jsmql("$$$.metrics.concat($$, $$);")).toThrow(
      "'$$$.<coll>.concat()' writes ONE source into the collection, and this names 2. Write them one statement at a time, or join them first ('$$$.<coll>.concat([...a, ...b]);').",
    );
    expect(() => jsmql("$$$.metrics.concat($.s.trim());")).toThrow(
      "'$$$.<coll>.concat(<array>)' writes MANY documents into the collection — a string is one value.",
    );
    expect(() => jsmql("$$$.metrics.push(5);")).toThrow(
      "'$$$.<coll>.push()' argument 1 takes a document, but got a number. The value becomes one document. Spread a list of them ('$$$.<coll>.push(...<array>);'), or put the value under a field ('$$$.<coll>.push({ value: … });').",
    );
    expect(() => jsmql("$$$.metrics.push([{ a: 1 }]);")).toThrow(
      "'$$$.<coll>.push()' argument 1 takes a document, but got an array. The value becomes one document. Spread a list of them ('$$$.<coll>.push(...<array>);'),",
    );
  });
});
