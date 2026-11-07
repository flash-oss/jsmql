// The template tag and the compile parameters take VALUES. The compiler never reads anything a caller supplies
// as syntax, as an operator, or as a field reference (HR1).
import { describe, it, expect } from "vitest";
import { jsmql, JsmqlInterpolationError } from "../src/index.ts";
import { Long } from "../src/bson.ts";
import { BSON } from "bson";
import mongoose from "mongoose";

const OWN = (v: unknown) => ({ $eq: v });

describe("jsmql template-tag interpolation guards", () => {
  it("rejects undefined with an error that points at the slot", () => {
    expect(() => jsmql`$.x === ${undefined}`).toThrow(JsmqlInterpolationError);
    expect(() => jsmql`$.x === ${undefined}`).toThrow(/slot 1.*undefined/);
  });
  it("rejects function and Symbol values", () => {
    const fn = () => 1;
    expect(() => jsmql`$.x === ${fn}`).toThrow(JsmqlInterpolationError);
    expect(() => jsmql`$.x === ${Symbol("x")}`).toThrow(JsmqlInterpolationError);
  });
  it("rejects NaN, Infinity, -Infinity", () => {
    for (const v of [NaN, Infinity, -Infinity]) expect(() => jsmql`$.x === ${v}`).toThrow(JsmqlInterpolationError);
  });
  it("rejects circular objects", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => jsmql`$.x === ${cyc}`).toThrow(JsmqlInterpolationError);
  });
  it("reports the correct slot index", () => {
    expect(() => jsmql`$.a === ${1} && $.b === ${undefined}`).toThrow(/slot 2/);
  });
  it("takes a BigInt as a value", () => {
    expect(jsmql`$.x === ${BigInt(1)}`).toEqual({ x: Long.fromString("1") });
  });
});

describe("jsmql template-tag interpolation cannot inject syntax", () => {
  const evil = '"}); db.dropDatabase(); //';
  it("breakout-attempt strings round-trip as literal values", () => {
    expect(jsmql`$.field === ${evil}`).toEqual({ field: '"}); db.dropDatabase(); //' });
    expect(jsmql`$eq($.field, ${evil})`).toEqual({ field: { $eq: '"}); db.dropDatabase(); //' } });
  });
  it("backticks and template-style payloads stay literal", () => {
    const payload = "`${$.password}`";
    expect(jsmql`$.field === ${payload}`).toEqual({ field: "`${$.password}`" });
  });
  it("a string that looks like a field reference stays a string", () => {
    expect(jsmql`$.a === ${"$b"}`).toEqual({ a: "$b" });
    expect(jsmql.expr`$.a + ${"$b"}`).toEqual({ $concat: ["$a", { $literal: "$b" }] });
    expect(jsmql.expr.compile(({ s }, { $ }) => $.a + s)({ s: "$b" })).toEqual({ $concat: ["$a", { $literal: "$b" }] });
    // a pipeline evaluates its values too: a `$set` value, a stage body, a group key
    expect(jsmql.pipeline`$.x = ${"$b"};`).toEqual([{ $set: { x: { $literal: "$b" } } }]);
    expect(
      jsmql.pipeline.compile(({ s }, { $ }) => {
        $.x = s;
      })({ s: "$b" }),
    ).toEqual([{ $set: { x: { $literal: "$b" } } }]);
    expect(jsmql.pipeline`$group({ _id: ${"$b"}, n: $sum(1) })`).toEqual([
      { $group: { _id: { $literal: "$b" }, n: { $sum: 1 } } },
    ]);
    // an update DOCUMENT evaluates nothing: the server stores the string as written
    expect(jsmql.update`$.x = ${"$b"}`).toEqual({ $set: { x: "$b" } });
  });
  it("an object whose keys look like operators is emitted as data, not invoked", () => {
    const payload = { $gt: 0, $where: "this.secret" };
    expect(jsmql`$eq($.field, ${payload})`).toEqual({ field: { $eq: { $gt: 0, $where: "this.secret" } } });
    expect(jsmql.expr`${payload}`).toEqual({ $literal: { $gt: 0, $where: "this.secret" } });
  });
});

describe("recursion depth limits", () => {
  const nested = "(".repeat(300) + "1" + ")".repeat(300);
  it("jsmql.validate() reports deep nesting as a SYNTAX_ERROR, never a RangeError", () => {
    const result = jsmql.validate(nested);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("SYNTAX_ERROR");
    expect(result.errors[0].message).toMatch(/nests too deeply/);
  });
  it("jsmql() throws the depth message on deeply nested parens and operator calls", () => {
    expect(() => jsmql(nested)).toThrow(/nests too deeply/);
    expect(() => jsmql("$add(".repeat(300) + "1" + ")".repeat(300))).toThrow(/nests too deeply/);
  });
  it("typical-depth expressions still compile", () => {
    const src = "(".repeat(40) + "$.a > 1" + ")".repeat(40);
    expect(jsmql(src)).toEqual({ a: { $gt: 1 } });
  });
});

describe("jsmql.validate() error contract", () => {
  it("never throws on a template value; it reports or accepts", () => {
    expect(jsmql.validate`$.x === ${BigInt(1)}`).toEqual({ valid: true, errors: [] });
    const result = jsmql.validate`$.x === ${undefined}`;
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("SYNTAX_ERROR");
  });
});

// ── a field name JavaScript refuses to store the ordinary way ────────────────
//
// MongoDB reserves no field names, so `__proto__` is ordinary data — and it is the
// one name `out[name] = value` sends to the PROTOTYPE slot, and creates no own property.
// Three more names read back a method that was never stored (`constructor`,
// `toString`, `valueOf`), and `name in out` answers true for all of them. Each of the
// four goes wrong differently, so each is asserted here, not assumed.
// See the `setKey` header in src/registry/mql.ts.
describe("a developer-authored field name survives to the output", () => {
  const HOSTILE = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"];

  it("every write road keeps the name", () => {
    for (const k of HOSTILE) {
      const q = JSON.stringify(k);
      expect(JSON.stringify(jsmql.pipeline(`$.${k} = 1;`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$ = { ${q}: 1 };`))).toContain(k);
      expect(JSON.stringify(jsmql.expr(`({ ${q}: 1 })`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$sort({ ${q}: 1 });`))).toContain(k);
      expect(JSON.stringify(jsmql.update(`$.${k} = 1`))).toContain(k);
      expect(JSON.stringify(jsmql.update(`delete $.${k}`))).toContain(k);
    }
  });

  it("every folding road that builds an object keeps the name", () => {
    for (const k of HOSTILE) {
      const q = JSON.stringify(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = ({a:1}).mapKeys(v => ${q});`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = [[${q}, 1]].fromPairs();`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = ({a: ${q}}).invert();`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = [${q}].zipObject([1]);`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = [{k: ${q}}].groupBy(x => x.k);`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = [{k: ${q}}].countBy(x => x.k);`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = ({[${q}]: 1}).mapValues(v => v);`))).toContain(k);
      expect(JSON.stringify(jsmql.pipeline(`$.r = $.o.pick([${q}]);`))).toContain(k);
    }
  });

  // `key in branches` answers true for every name on `Object.prototype`, so the
  // duplicate guard must not refuse a program that has no duplicate at all.
  it("a $facet branch may be named after a prototype member, and a real duplicate is still refused", () => {
    expect(jsmql.pipeline("$ = { toString: $$ };")).toEqual([{ $facet: { toString: [] } }]);
    expect(jsmql.pipeline("$ = { valueOf: $$, hasOwnProperty: $$ };")).toEqual([
      { $facet: { valueOf: [], hasOwnProperty: [] } },
    ]);
    expect(() => jsmql.pipeline("$ = { dup: $$, dup: $$ };")).toThrow("names two '$facet' branches");
  });

  // The fold reads its accumulator back, and a plain object answers a FUNCTION for
  // `constructor` — a value the fold never stored.
  it("a fold keyed by a prototype member answers what it stored", () => {
    expect(jsmql.pipeline("$.r = [{ k: 'constructor' }].groupBy(x => x.k);")).toEqual([
      { $set: { r: { $mergeObjects: [{ constructor: [{ k: "constructor" }] }] } } },
    ]);
    expect(jsmql.pipeline("$.r = [{ k: 'constructor' }].countBy(x => x.k);")).toEqual([
      { $set: { r: { $mergeObjects: [{ constructor: 1 }] } } },
    ]);
  });
});

// A run-time value that reads as MQL (a string that starts with `$`, a document with a `$` key) is a value in
// both forms. Where the server evaluates the slot, it takes `$literal`. The query compares it as written. Every
// slot where it becomes part of the MQL refuses it. See docs/LANG_RULES.md (HR1).
describe("a run-time value that reads as MQL is a value, in both forms", () => {
  /** The template tag and a `jsmql.compile` parameter give ONE answer for the same value. */
  const both = (tag: (v: unknown) => unknown, compiled: (p: { v: unknown }) => unknown, v: unknown): unknown => {
    const run = (f: () => unknown): { ok: unknown } | { error: string } => {
      try {
        return { ok: f() };
      } catch (e) {
        return { error: (e as Error).message.replace(/\n  at line [\s\S]*$/, "") };
      }
    };
    const a = run(() => tag(v));
    expect(run(() => compiled({ v }))).toEqual(a);
    if ("error" in a) throw new Error(a.error);
    return a.ok;
  };

  it("takes $literal in a slot that the server evaluates", () => {
    expect(
      both(
        (v) => jsmql`$set({ x: ${v} });`,
        jsmql.compile(({ v }) => {
          $set({ x: v });
        }),
        "$password",
      ),
    ).toEqual([{ $set: { x: { $literal: "$password" } } }]);
    expect(
      both(
        (v) => jsmql`$group({ _id: ${v} });`,
        jsmql.compile(({ v }) => {
          $group({ _id: v });
        }),
        "$k",
      ),
    ).toEqual([{ $group: { _id: { $literal: "$k" } } }]);
    expect(
      both(
        (v) => jsmql`$replaceWith(${v});`,
        jsmql.compile(({ v }) => {
          $replaceWith(v);
        }),
        { a: "$b" },
      ),
    ).toEqual([{ $replaceWith: { $literal: { a: "$b" } } }]);
    expect(
      both(
        (v) => jsmql`$lookup({ from: "o", let: { w: ${v} }, pipeline: [], as: "j" });`,
        jsmql.compile(({ v }) => {
          $lookup({ from: "o", let: { w: v }, pipeline: [], as: "j" });
        }),
        "$x",
      ),
    ).toEqual([{ $lookup: { from: "o", let: { w: { $literal: "$x" } }, pipeline: [], as: "j" } }]);
  });

  it("is the compared value in a query, and the stored value in an update document", () => {
    expect(
      both(
        (v) => jsmql`$match({ a: ${v} });`,
        jsmql.compile(({ v }) => {
          $match({ a: v });
        }),
        { $gt: 1 },
      ),
    ).toEqual([{ $match: { a: { $eq: { $gt: 1 } } } }]);
    expect(
      both(
        (v) => jsmql`({ a: { $in: ${v} } })`,
        jsmql.compile(({ v }) => ({ a: { $in: v } })),
        ["$x"],
      ),
    ).toEqual({ a: { $in: ["$x"] } });
    expect(
      both(
        (v) => jsmql`$.a === ${v}`,
        jsmql.compile(({ v }, { $ }) => $.a === v),
        { $gt: 1 },
      ),
    ).toEqual({ a: { $eq: { $gt: 1 } } });
    expect(
      both(
        (v) => jsmql.update`$.x = ${v}`,
        jsmql.update.compile(({ v }, { $ }) => {
          $.x = v;
        }),
        "$b",
      ),
    ).toEqual({ $set: { x: "$b" } });
  });

  it("is refused where the server reads the slot as written, and the message names the source spelling", () => {
    expect(() =>
      both(
        (v) => jsmql`$unwind(${v});`,
        jsmql.compile(({ v }) => {
          $unwind(v);
        }),
        "$items",
      ),
    ).toThrow(
      `A run-time value is a value, never MQL. '$unwind' reads its body as written, and there the string "$items" becomes part of the MQL. Write it in the source: '$unwind("$items")'.`,
    );
    expect(() =>
      both(
        (v) => jsmql`$unwind({ path: ${v} });`,
        jsmql.compile(({ v }) => {
          $unwind({ path: v });
        }),
        "$items",
      ),
    ).toThrow(
      `'$unwind' reads 'path' as written, and there the string "$items" becomes part of the MQL. Write it in the source: 'path: "$items"'.`,
    );
    expect(() =>
      both(
        (v) => jsmql`$lookup({ from: ${v}, localField: "a", foreignField: "b", as: "j" });`,
        jsmql.compile(({ v }) => {
          $lookup({ from: v, localField: "a", foreignField: "b", as: "j" });
        }),
        "$c",
      ),
    ).toThrow(`'$lookup' reads 'from' as written`);
    expect(() =>
      both(
        (v) => jsmql`$set(${v});`,
        jsmql.compile(({ v }) => {
          $set(v);
        }),
        { a: "$b" },
      ),
    ).toThrow(`Write it in the source, and pass only its values: '$set({ a: … })'.`);
    expect(() =>
      both(
        (v) => jsmql`$sort(${v});`,
        jsmql.compile(({ v }) => {
          $sort(v);
        }),
        { s: { $meta: "textScore" } },
      ),
    ).toThrow(`'$sort({ s: { $meta: … } })'`);
  });

  it("never becomes an accumulator or a window function", () => {
    expect(() =>
      both(
        (v) => jsmql`$group({ _id: null, t: ${v} });`,
        jsmql.compile(({ v }) => {
          $group({ _id: null, t: v });
        }),
        { $sum: "$secret" },
      ),
    ).toThrow(
      "A run-time value is a value, never MQL. This slot takes an accumulator, and there the value becomes part of the MQL. Write an accumulator in the source, and pass only its values: '$sum(…)'.",
    );
    expect(() =>
      both(
        (v) => jsmql`$setWindowFields({ sortBy: { a: 1 }, output: { r: ${v} } });`,
        jsmql.compile(({ v }) => {
          $setWindowFields({ sortBy: { a: 1 }, output: { r: v } });
        }),
        { $rank: {} },
      ),
    ).toThrow("This slot takes a window function");
  });

  it("never becomes a query", () => {
    const query =
      "A run-time document is a value, never a query. Write the query in the source, and pass only its values:";
    expect(() =>
      both(
        (v) => jsmql`$match(${v});`,
        jsmql.compile(({ v }) => {
          $match(v);
        }),
        { a: { $gt: 1 } },
      ),
    ).toThrow(`${query} '{ a: { $gt: … } }'.`);
    expect(() =>
      both(
        (v) => jsmql`${v}`,
        jsmql.compile(({ v }) => v),
        { a: { $gt: 1 } },
      ),
    ).toThrow(query);
    expect(() =>
      both(
        (v) => jsmql`({ $and: ${v} })`,
        jsmql.compile(({ v }) => ({ $and: v })),
        [{ $where: "sleep(100)" }],
      ),
    ).toThrow(`${query} '[{ $where: … }]'.`);
    expect(() =>
      both(
        (v) => jsmql`({ a: { $not: ${v} } })`,
        jsmql.compile(({ v }) => ({ a: { $not: v } })),
        { $gt: 1 },
      ),
    ).toThrow(query);
    expect(() =>
      both(
        (v) => jsmql`({ a: { $elemMatch: ${v} } })`,
        jsmql.compile(({ v }) => ({ a: { $elemMatch: v } })),
        { $gt: 1 },
      ),
    ).toThrow(query);
    // The compiler writes a document with no `$` in it as the source could write it, and it stays the query.
    expect(jsmql`$match(${{ a: 1 }});`).toEqual([{ $match: { a: 1 } }]);
  });

  it("names the problem when it cannot name a collection", () => {
    const join = jsmql.compile(({ c }, { $, $$$ }) => {
      $.j = $$$[c].find((o) => o.x === $.x);
    });
    expect(() => join({ c: "$orders" })).toThrow(
      `The run-time value "$orders" cannot name a collection: the server refuses a name that starts with '$'.`,
    );
    expect(() => join({ c: 5 })).toThrow("'$$$[…]' key takes a string, but got a number.");
  });
});

// The driver converts some values before it sends them: it calls `toBSON()`, and it
// sends a Map as a document of its entries. JSMQL makes the same conversions, so the
// compiled document and its printed text hold the value that the server gets.
// See docs/specs/function-form-params.md § The value the driver sends.
describe("a passed-in value is the value the driver sends", () => {
  /** The value an update document stores for `v`. The update document keeps it as written. */
  const sent = (v: unknown): unknown => (jsmql.update`$.x = ${v}` as { $set: { x: unknown } }).$set.x;
  /** The bytes the driver sends for `{ x: v }`. */
  const wire = (v: unknown): string => Buffer.from(BSON.serialize({ x: v })).toString("base64");

  class Money {
    cents = 500;
    toBSON() {
      return { amount: 5 };
    }
  }
  class Point {
    x = 1;
    y = 2;
  }

  it("calls toBSON(), as the driver does", () => {
    expect(sent(new Money())).toEqual({ amount: 5 });
    expect(sent({ price: new Money() })).toEqual({ price: { amount: 5 } });
    expect(sent([new Money()])).toEqual([{ amount: 5 }]);
  });

  it("reads a Map as a document of its entries", () => {
    expect(sent(new Map([["a", 1]]))).toEqual({ a: 1 });
    expect(sent({ m: new Map([["b", new Map([["c", 2]])]]) })).toEqual({ m: { b: { c: 2 } } });
  });

  it("reads any other object as its own enumerable fields", () => {
    expect(sent(new Point())).toEqual({ x: 1, y: 2 });
  });

  it("gives the bytes that the driver sends for the original value", () => {
    for (const v of [new Money(), new Map([["a", [1, new Money()]]]), new Point(), { deep: new Map([["k", "v"]]) }]) {
      expect(wire(sent(v))).toBe(wire(v));
    }
  });

  it("converts a mongoose document, subdocument, array and Buffer", () => {
    const M = mongoose.model(
      "SecurityDriverValue",
      new mongoose.Schema({ tags: [String], sub: new mongoose.Schema({ a: Number }), buf: Buffer }),
    );
    const doc = new M({ tags: ["a", "b"], sub: { a: 1 }, buf: Buffer.from([1, 2]) });
    for (const v of [doc, doc.tags, doc.sub, doc.buf]) expect(wire(sent(v))).toBe(wire(v));
    expect(sent(doc.tags)).toEqual(["a", "b"]);
  });

  it("puts a Map key that starts with $ through HR1, as any $-key document", () => {
    expect(jsmql`$.x === ${new Map([["$gt", 1]])}`).toEqual({ x: { $eq: { $gt: 1 } } });
    expect(jsmql.expr`${new Map([["$gt", 1]])}`).toEqual({ $literal: { $gt: 1 } });
  });

  it("refuses a Map key that is not a string, which the driver cannot send", () => {
    expect(() => jsmql`$.x === ${new Map([[1, "a"]])}`).toThrow(JsmqlInterpolationError);
    expect(() => jsmql`$.x === ${new Map([[1, "a"]])}`).toThrow(/key 1/);
  });

  it("refuses a built-in object that the driver sends as {} or as index keys", () => {
    expect(() => jsmql`$.x === ${new Set(["a"])}`).toThrow(/\[\.\.\.set\]/);
    for (const v of [new Error("e"), new ArrayBuffer(2), new Int32Array([1]), Object(5), new WeakMap()]) {
      expect(() => jsmql`$.x === ${v}`).toThrow(JsmqlInterpolationError);
    }
    expect(() => jsmql`$.x === ${{ deep: [new Set()] }}`).toThrow(/at \.deep\[0\] is a Set/);
  });

  // `bson` finds a Date, a RegExp and a Map by `Symbol.toStringTag` alone.
  it("refuses an object that only sets a tag the driver reads", () => {
    for (const tag of ["Date", "RegExp", "Map"]) {
      expect(() => jsmql`$.x === ${{ [Symbol.toStringTag]: tag }}`).toThrow(/Symbol\.toStringTag/);
    }
  });

  it("refuses what toBSON() gives when that has no MQL form", () => {
    expect(() => jsmql`$.x === ${{ toBSON: () => undefined }}`).toThrow(/slot 1 is undefined/);
  });

  it("refuses a cycle through a Map", () => {
    const m = new Map<string, unknown>();
    m.set("self", m);
    expect(() => jsmql`$.x === ${m}`).toThrow(/circular structure/);
  });

  it("converts a jsmql.compile parameter the same way", () => {
    const q = jsmql.update.compile(({ v }: { v: unknown }, { $ }) => {
      $.x = v;
    });
    expect(q({ v: new Map([["a", 1]]) })).toEqual({ $set: { x: { a: 1 } } });
    expect(() => q({ v: new Set() })).toThrow(/parameter 'v' is a Set/);
  });

  it("prints the value that the driver sends", () => {
    expect(jsmql.stringify(jsmql`$.p === ${new Money()}`)).toBe('{ $expr: { $eq: ["$p", { amount: 5 }] } }');
    expect(jsmql.stringify(jsmql.update`$.m = ${new Map([["a", 1]])}`)).toBe("{ $set: { m: { a: 1 } } }");
  });
});
