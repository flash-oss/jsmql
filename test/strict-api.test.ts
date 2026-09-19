// The strict-shape entries: each accepts one shape and refuses the others by
// name, so a source that would silently lower to the wrong document for the
// driver method at hand is a compile-time error instead. See
// docs/specs/strict-shape-entries.md.
import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

describe("jsmql.filter() — strict Filter shape", () => {
  it("returns a Filter document for an indexable predicate", () => {
    expect(jsmql.filter("$.age > 18 && $.status === 'active'")).toEqual({ age: { $gt: 18 }, status: "active" });
  });
  it("takes the expression road where the query language has no clause", () => {
    expect(jsmql.filter("$.name.trim() === 'alice'")).toEqual({
      $expr: { $eq: [{ $trim: { input: "$name" } }, "alice"] },
    });
  });
  it("accepts the arrow form", () => {
    expect(jsmql.filter(({ $ }) => $.age > 18)).toEqual({ age: { $gt: 18 } });
  });
  it("accepts the template-tag form with an interpolated value", () => {
    const minAge = 21;
    expect(jsmql.filter`$.age >= ${minAge}`).toEqual({ age: { $gte: 21 } });
  });
  it("refuses a `;`-separated Pipeline and names jsmql.pipeline()", () => {
    expect(() => jsmql.filter("$match($.x > 0); $sort({ x: 1 })")).toThrow(
      /jsmql\.filter\(\) expects a Filter.*`;`-separated Pipeline.*jsmql\.pipeline\(\)/s,
    );
  });
  it("refuses a write and names both update forms", () => {
    expect(() => jsmql.filter("$.x = 1")).toThrow(
      /jsmql\.filter\(\) expects a Filter.*a write.*jsmql\.update\(\).*jsmql\.pipeline\(\)/s,
    );
  });
  it("refuses a stream-replace `$$ = <expr>` and names the shape", () => {
    for (const src of ["$$ = $$.filter(t => t.a === 1)", "$$ = $$.filter(t => t.a === 1);"]) {
      expect(() => jsmql.filter(src)).toThrow(/jsmql\.filter\(\) expects a Filter/);
    }
    expect(() => jsmql.filter("$$ = $$.filter(t => t.a === 1)")).toThrow(
      /stream-replace `\$\$ = <expr>`.*jsmql\.pipeline\(\).*pass the predicate to jsmql\.filter\(\) directly/s,
    );
  });
  it("refuses a top-level stage call with the offending stage name, and says to drop a `$match`", () => {
    expect(() => jsmql.filter("$match($.age > 18)")).toThrow(
      /top-level '\$match' stage call.*drop the `\$match\(\.\.\.\)` wrapper/s,
    );
    expect(() => jsmql.filter("{ $match: $.x > 0 }")).toThrow(/top-level '\$match' stage call/);
  });
  it("refuses an array-literal Pipeline", () => {
    expect(() => jsmql.filter("[{ $match: $.x > 0 }]")).toThrow(/Pipeline array/);
  });
  it("rejects non-string / non-function / non-template inputs by name", () => {
    expect(() => (jsmql.filter as (n: unknown) => unknown)(42)).toThrow(
      /jsmql\.filter\(\) expects a string, an arrow function, or a template literal — got number/,
    );
  });
});

describe("jsmql.pipeline() — strict Pipeline shape", () => {
  it("takes a single top-level stage call (same as jsmql())", () => {
    expect(jsmql.pipeline("$match($.age > 18)")).toEqual([{ $match: { age: { $gt: 18 } } }]);
  });
  it("compiles a `;`-separated multi-stage pipeline", () => {
    expect(jsmql.pipeline("$match($.age > 18); $sort({ age: 1 })")).toEqual([
      { $match: { age: { $gt: 18 } } },
      { $sort: { age: 1 } },
    ]);
  });
  it("compiles writes to a $set / $unset pipeline", () => {
    expect(jsmql.pipeline("$.x = 1; delete $.y")).toEqual([{ $set: { x: 1 } }, { $unset: "y" }]);
  });
  it("accepts an array-literal Pipeline", () => {
    expect(jsmql.pipeline("[{ $match: $.x > 0 }, { $sort: { x: 1 } }]")).toEqual([
      { $match: { x: { $gt: 0 } } },
      { $sort: { x: 1 } },
    ]);
  });
  it("accepts the template-tag form with an interpolated value", () => {
    const cutoff = 100;
    expect(jsmql.pipeline`$match($.score > ${cutoff})`).toEqual([{ $match: { score: { $gt: 100 } } }]);
  });
  it("accepts the block-body arrow form", () => {
    expect(
      jsmql.pipeline(({ $, $match, $sort }) => {
        $match($.age > 18);
        $sort({ age: 1 });
      }),
    ).toEqual([{ $match: { age: { $gt: 18 } } }, { $sort: { age: 1 } }]);
  });
  it("lowers a stream-replace `$$ = <expr>` with or without a trailing `;`, like jsmql()", () => {
    for (const src of ["$$ = $$.filter({ a: 1 })", "$$ = $$.filter({ a: 1 });"]) {
      expect(jsmql.pipeline(src)).toEqual([{ $match: { a: 1 } }]);
      expect(jsmql.pipeline(src)).toEqual(jsmql(src));
    }
  });
  it("refuses a bare predicate that would lower to a Filter", () => {
    expect(() => jsmql.pipeline("$.age > 18")).toThrow(
      /jsmql\.pipeline\(\) expects a Pipeline.*bare expression that would lower to a Filter.*jsmql\.filter\(\).*wrap the predicate as `\$match/s,
    );
    expect(() => jsmql.pipeline("$.a + $.b")).toThrow(/jsmql\.pipeline\(\) expects a Pipeline/);
  });
});

describe("jsmql.update() — the update document", () => {
  it("compiles writes to the document `updateOne(filter, update)` takes", () => {
    expect(jsmql.update("$.x = 1; delete $.y")).toEqual({ $set: { x: 1 }, $unset: { y: "" } });
    expect(jsmql.update("$.score += 5; $.tags.push('a')")).toEqual({ $inc: { score: 5 }, $push: { tags: "a" } });
  });
  it("takes the update operators themselves", () => {
    expect(jsmql.update("$inc({ n: 2 }); $set({ a: 1 })")).toEqual({ $inc: { n: 2 }, $set: { a: 1 } });
    expect(jsmql.update("{ $set: { x: 1 }, $unset: { y: '' } }")).toEqual({ $set: { x: 1 }, $unset: { y: "" } });
  });
  it("refuses a value computed from the document, naming the pipeline form", () => {
    expect(() => jsmql.update("$.name = $.name.toUpperCase()")).toThrow(/takes constants.*pipeline form/s);
  });
  it("refuses a bare predicate", () => {
    expect(() => jsmql.update("$.age > 18")).toThrow(/An update document is made of writes/);
  });
  it("refuses a fragment or a stage where an update operator belongs", () => {
    expect(() => jsmql.update("$set({ x: 1 }); $sort({ x: 1 })")).toThrow(/'\$sort' is a fragment of '\$push'/);
    expect(() => jsmql.update("$match($.x > 0)")).toThrow(/not valid in an update document/);
  });
  it("accepts the template-tag and arrow forms", () => {
    const bump = 5;
    expect(jsmql.update`$.score += ${bump}`).toEqual({ $inc: { score: 5 } });
    expect(jsmql.update(({ $ }) => ($.name = "x"))).toEqual({ $set: { name: "x" } });
  });
});

describe("strict-shape `.compile` builders", () => {
  it("jsmql.filter.compile binds params and returns a Filter", () => {
    const q = jsmql.filter.compile(({ minAge }: { minAge: number }) => $.age > minAge);
    expect(q({ minAge: 18 })).toEqual({ age: { $gt: 18 } });
    expect(q({ minAge: 21 })).toEqual({ age: { $gt: 21 } });
  });
  it("jsmql.filter.compile accepts the arrow as a source string", () => {
    const q = jsmql.filter.compile("({ minAge }, { $ }) => $.age > minAge");
    expect(q({ minAge: 18 })).toEqual({ age: { $gt: 18 } });
  });
  it("jsmql.filter.compile refuses a Pipeline-shaped arrow body", () => {
    const q = jsmql.filter.compile("({ $ }) => { $match($.x > 0); $sort({ x: 1 }) }");
    expect(() => q({})).toThrow(/jsmql\.filter\(\) expects a Filter/);
  });
  it("jsmql.pipeline.compile binds params and returns a stage array", () => {
    const q = jsmql.pipeline.compile(({ minAge }: { minAge: number }) => {
      $match($.age > minAge);
      $sort({ age: -1 });
    });
    expect(q({ minAge: 18 })).toEqual([{ $match: { age: { $gt: 18 } } }, { $sort: { age: -1 } }]);
  });
  it("jsmql.pipeline.compile refuses a bare-expression arrow body", () => {
    const q = jsmql.pipeline.compile("({ minAge }, { $ }) => $.age > minAge");
    expect(() => q({ minAge: 18 })).toThrow(/jsmql\.pipeline\(\) expects a Pipeline.*bare expression/);
  });
  it("jsmql.update.compile binds params into the update document", () => {
    const q = jsmql.update.compile(({ tier }: { tier: number }) => ($.tier = tier));
    expect(q({ tier: 2 })).toEqual({ $set: { tier: 2 } });
  });
  it("jsmql.expr.compile binds params and returns a raw aggregation expression", () => {
    const q = jsmql.expr.compile(({ k }: { k: number }) => $.a + k);
    expect(q({ k: 2 })).toEqual({ $add: ["$a", 2] });
  });
  it("a parameter left out at the call is named", () => {
    const q = jsmql.filter.compile(({ minAge }: { minAge: number }) => $.age > minAge);
    expect(() => q({} as { minAge: number })).toThrow(/'minAge' is a parameter of this query, and it is missing/);
  });
  it("rejects a non-arrow input type with an entry-named TypeError", () => {
    expect(() => jsmql.pipeline.compile(42 as never)).toThrow(/jsmql\.pipeline\.compile\(\) expects an arrow function/);
  });
  it("a string that is not the entry form is refused", () => {
    expect(() => jsmql.compile("$.age > 18")).toThrow(/takes the entry form/);
  });
});
