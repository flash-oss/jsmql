import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

// Mirror of the codegen-side `jsBool()` helper. JS truthy/falsy: false, null
// (or missing), "", and 0 are falsy; everything else is truthy. Used in
// expected outputs for `&&`, `||`, `!`, `?:`, `Boolean()`, and predicate-
// method bodies wherever the operand is not provably boolean.
const truthy = (v: unknown) => ({ $and: [{ $ne: [v, null] }, { $ne: [v, false] }, { $ne: [v, ""] }, { $ne: [v, 0] }] });

describe("basic literals", () => {
  it("passes number through", () => {
    expect(jsmql.expr("$abs(42)")).toEqual({ $abs: 42 });
  });

  it("passes string through", () => {
    expect(jsmql.expr('$toLower("Hello")')).toEqual({ $toLower: "Hello" });
  });

  it("handles boolean", () => {
    expect(jsmql.expr("$not(true)")).toEqual({ $not: true });
  });

  it("handles null", () => {
    expect(jsmql.expr("$not(null)")).toEqual({ $not: null });
  });
});

describe("field refs", () => {
  it("simple field", () => {
    expect(jsmql.expr("$abs($.delta)")).toEqual({ $abs: "$delta" });
  });

  it("nested field", () => {
    expect(jsmql.expr("$year($.createdAt)")).toEqual({ $year: "$createdAt" });
  });

  it("deep nested field", () => {
    expect(jsmql.expr("$abs($.address.city)")).toEqual({ $abs: "$address.city" });
  });
});

describe("single-shape operators", () => {
  it("$not", () => {
    expect(jsmql.expr("$not($.active)")).toEqual({ $not: "$active" });
  });

  it("$size", () => {
    expect(jsmql.expr("$size($.items)")).toEqual({ $size: "$items" });
  });

  it("$toLower", () => {
    expect(jsmql.expr("$toLower($.name)")).toEqual({ $toLower: "$name" });
  });
});

describe("array-shape operators", () => {
  it("$eq two args", () => {
    expect(jsmql.expr("$eq($.age, 18)")).toEqual({ $eq: ["$age", 18] });
  });

  it("$gt comparison", () => {
    expect(jsmql.expr("$gt($.age, 18)")).toEqual({ $gt: ["$age", 18] });
  });

  it("$add multiple args", () => {
    expect(jsmql.expr("$add($.a, $.b, $.c)")).toEqual({ $add: ["$a", "$b", "$c"] });
  });

  it("$and logical", () => {
    expect(jsmql.expr('$and($gt($.age, 18), $eq($.status, "active"))')).toEqual({
      $and: [{ $gt: ["$age", 18] }, { $eq: ["$status", "active"] }],
    });
  });

  it("$or logical", () => {
    expect(jsmql.expr("$or($eq($.a, 1), $eq($.b, 2))")).toEqual({ $or: [{ $eq: ["$a", 1] }, { $eq: ["$b", 2] }] });
  });

  it("$in with array literal", () => {
    expect(jsmql.expr('$in($.status, ["active", "pending"])')).toEqual({ $in: ["$status", ["active", "pending"]] });
  });

  it("$ifNull varargs", () => {
    expect(jsmql.expr('$ifNull($.nickname, $.firstName, "Unknown")')).toEqual({
      $ifNull: ["$nickname", "$firstName", "Unknown"],
    });
  });
});

describe("nested operators", () => {
  it("operator as argument", () => {
    expect(jsmql.expr("$multiply($add($.a, $.b), 2)")).toEqual({ $multiply: [{ $add: ["$a", "$b"] }, 2] });
  });
});

describe("object-style operators (object arg)", () => {
  it("$trim with named args", () => {
    expect(jsmql.expr("$trim({ input: $.name, chars: ' ' })")).toEqual({ $trim: { input: "$name", chars: " " } });
  });

  it("$replaceOne named", () => {
    expect(jsmql.expr('$replaceOne({ input: $.text, find: "old", replacement: "new" })')).toEqual({
      $replaceOne: { input: "$text", find: "old", replacement: "new" },
    });
  });

  it("$dateAdd named", () => {
    expect(jsmql.expr('$dateAdd({ startDate: $.date, unit: "day", amount: 7 })')).toEqual({
      $dateAdd: { startDate: "$date", unit: "day", amount: 7 },
    });
  });
});

describe("object-shape operators (positional → object mapping)", () => {
  it("$trim positional", () => {
    expect(jsmql.expr("$trim($.name, ' ')")).toEqual({ $trim: { input: "$name", chars: " " } });
  });

  it("$trim positional single arg", () => {
    expect(jsmql.expr("$trim($.name)")).toEqual({ $trim: { input: "$name" } });
  });

  it("$replaceOne positional", () => {
    expect(jsmql.expr('$replaceOne($.text, "old", "new")')).toEqual({
      $replaceOne: { input: "$text", find: "old", replacement: "new" },
    });
  });

  it("$getField positional", () => {
    expect(jsmql.expr('$getField("fieldName", $.doc)')).toEqual({ $getField: { field: "fieldName", input: "$doc" } });
  });

  it("$switch object-style with branches/default", () => {
    expect(
      jsmql.expr(
        '$switch({ branches: [{ case: $eq($.tier, "gold"), then: 0.2 }, { case: $eq($.tier, "silver"), then: 0.1 }], default: 0 })',
      ),
    ).toEqual({
      $switch: {
        branches: [
          { case: { $eq: ["$tier", "gold"] }, then: 0.2 },
          { case: { $eq: ["$tier", "silver"] }, then: 0.1 },
        ],
        default: 0,
      },
    });
  });

  it("$dateTrunc positional (date, unit)", () => {
    expect(jsmql.expr('$dateTrunc($.createdAt, "day")')).toEqual({ $dateTrunc: { date: "$createdAt", unit: "day" } });
  });

  it("$dateFromString single-arg positional", () => {
    expect(jsmql.expr("$dateFromString($.dateString)")).toEqual({ $dateFromString: { dateString: "$dateString" } });
  });
});

describe("escape-hatch operators (single-arg, expression-shaped)", () => {
  it("$sampleRate(0.1) → { $sampleRate: 0.1 }", () => {
    expect(jsmql.expr("$sampleRate(0.1)")).toEqual({ $sampleRate: 0.1 });
  });
});

describe("regex literal in standalone position", () => {
  it("rejects /pattern/ as a binary operand with a clear error", () => {
    expect(() => jsmql.expr("$.x === /foo/")).toThrow(/Regex literals are only valid as arguments to \.match\(\)/);
  });
});

describe("zero-arg operators", () => {
  it("$rand", () => {
    expect(jsmql.expr("$rand()")).toEqual({ $rand: {} });
  });
});

describe("unknown operators (fallthrough)", () => {
  it("zero args → {}", () => {
    expect(jsmql.expr("$someNewOp()")).toEqual({ $someNewOp: {} });
  });

  it("single non-object arg → bare value", () => {
    expect(jsmql.expr("$someOp($.a)")).toEqual({ $someOp: "$a" });
  });

  it("single object arg → pass object", () => {
    expect(jsmql.expr('$someOp({ key: "val" })')).toEqual({ $someOp: { key: "val" } });
  });

  it("multiple args → array", () => {
    expect(jsmql.expr("$someNewOp($.a, $.b)")).toEqual({ $someNewOp: ["$a", "$b"] });
  });
});

describe("array literals", () => {
  it("simple array", () => {
    expect(jsmql.expr("$in($.x, [1, 2, 3])")).toEqual({ $in: ["$x", [1, 2, 3]] });
  });

  it("nested array", () => {
    expect(jsmql.expr("$abs([1, 2])")).toEqual({ $abs: [1, 2] });
  });
});

describe("array spread", () => {
  it("single spread becomes the spread argument directly (no redundant $concatArrays)", () => {
    expect(jsmql.expr("$foo([...$.arr])")).toEqual({ $foo: "$arr" });
  });

  it("two spreads emit $concatArrays", () => {
    expect(jsmql.expr("$foo([...$.a, ...$.b])")).toEqual({ $foo: { $concatArrays: ["$a", "$b"] } });
  });

  it("statics before a spread group into one operand", () => {
    expect(jsmql.expr("$foo([1, 2, ...$.rest])")).toEqual({ $foo: { $concatArrays: [[1, 2], "$rest"] } });
  });

  it("statics after a spread group into one operand", () => {
    expect(jsmql.expr("$foo([...$.base, 1, 2])")).toEqual({ $foo: { $concatArrays: ["$base", [1, 2]] } });
  });

  it("statics around a spread split into two grouped operands (left-to-right)", () => {
    expect(jsmql.expr("$foo([1, ...$.mid, 2])")).toEqual({ $foo: { $concatArrays: [[1], "$mid", [2]] } });
  });

  it("multiple spreads with statics interleaved", () => {
    expect(jsmql.expr("$foo([1, ...$.a, 2, ...$.b, 3])")).toEqual({
      $foo: { $concatArrays: [[1], "$a", [2], "$b", [3]] },
    });
  });

  it("spread of a literal array produces $concatArrays of literal-array operands", () => {
    expect(jsmql.expr("$foo([...[1, 2], 3])")).toEqual({ $foo: { $concatArrays: [[1, 2], [3]] } });
  });

  it("spread inside .map lambda body remaps the lambda param", () => {
    expect(jsmql.expr("$.xs.map(x => [...$.prefix, x])")).toEqual({
      $map: { input: "$xs", as: "x", in: { $concatArrays: ["$prefix", ["$$x"]] } },
    });
  });

  it("empty array still works (no spread, fast path)", () => {
    expect(jsmql.expr("$foo([])")).toEqual({ $foo: [] });
  });

  it("plain non-spread arrays unchanged (regression)", () => {
    expect(jsmql.expr("$foo([1, 2, 3])")).toEqual({ $foo: [1, 2, 3] });
  });

  it("nested array literal with spread inside", () => {
    expect(jsmql.expr("$foo([[...$.a]])")).toEqual({ $foo: ["$a"] });
  });
});

describe("object literals as args", () => {
  it("object as second positional arg for unknown op", () => {
    expect(jsmql.expr("$foo({ a: 1 }, $.b)")).toEqual({ $foo: [{ a: 1 }, "$b"] });
  });
});

describe("object spread", () => {
  it("single spread becomes the spread argument directly (no redundant $mergeObjects)", () => {
    expect(jsmql.expr("$foo({ ...$.base })")).toEqual({ $foo: "$base" });
  });

  it("two spreads emit $mergeObjects", () => {
    expect(jsmql.expr("$foo({ ...$.a, ...$.b })")).toEqual({ $foo: { $mergeObjects: ["$a", "$b"] } });
  });

  it("static keys before a spread group into one operand", () => {
    expect(jsmql.expr("$foo({ x: 1, y: 2, ...$.rest })")).toEqual({
      $foo: { $mergeObjects: [{ x: 1, y: 2 }, "$rest"] },
    });
  });

  it("static keys after a spread group into one operand", () => {
    expect(jsmql.expr("$foo({ ...$.base, x: 1 })")).toEqual({ $foo: { $mergeObjects: ["$base", { x: 1 }] } });
  });

  it("statics around a spread split into separate operands (left-to-right)", () => {
    expect(jsmql.expr("$foo({ x: 1, ...$.mid, y: 2 })")).toEqual({
      $foo: { $mergeObjects: [{ x: 1 }, "$mid", { y: 2 }] },
    });
  });

  it("computed key inside a static block uses $arrayToObject for that block only", () => {
    expect(jsmql.expr("$foo({ ...$.base, [$.k]: $.v })")).toEqual({
      $foo: { $mergeObjects: ["$base", { $arrayToObject: [["$k", "$v"]] }] },
    });
  });

  it("works inside .reduce — the README $accumulator replacement", () => {
    // The accumulator is narrowed to "object" by reduce-codegen (initialValue
    // is `{}` and the body returns an `ObjectLiteral`), so `acc[s]` emits
    // `$getField` directly instead of the runtime `$cond` on `$isArray`.
    expect(jsmql.expr("$.statuses.reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {})")).toEqual({
      $reduce: {
        input: "$statuses",
        initialValue: {},
        in: {
          $mergeObjects: [
            "$$value",
            {
              $arrayToObject: [
                ["$$this", { $add: [{ $ifNull: [{ $getField: { field: "$$this", input: "$$value" } }, 0] }, 1] }],
              ],
            },
          ],
        },
      },
    });
  });

  it("rejects spread inside operator-arg objects (key shape is wire format)", () => {
    expect(() => jsmql.expr("$replaceOne({ ...$.opts, input: $.s })")).toThrow(/Spread/);
  });
});

describe("$cond", () => {
  it("positional 3-arg cond (object-shape, maps to if/then/else)", () => {
    expect(jsmql.expr('$cond($.age, "adult", "minor")')).toEqual({
      $cond: { if: "$age", then: "adult", else: "minor" },
    });
  });

  it("object-style cond", () => {
    expect(jsmql.expr('$cond({ if: $.active, then: "yes", else: "no" })')).toEqual({
      $cond: { if: "$active", then: "yes", else: "no" },
    });
  });
});

describe("jsmql template-tag form", () => {
  it("interpolates number", () => {
    const age = 21;
    expect(jsmql.expr`$gt($.age, ${age})`).toEqual({ $gt: ["$age", 21] });
  });

  it("interpolates array", () => {
    const statuses = ["active", "pending"];
    expect(jsmql.expr`$in($.status, ${statuses})`).toEqual({ $in: ["$status", ["active", "pending"]] });
  });

  it("interpolates string", () => {
    const prefix = "admin";
    expect(jsmql.expr`$eq($.role, ${prefix})`).toEqual({ $eq: ["$role", "admin"] });
  });

  it("works with no interpolations (template-tag detection survives empty values)", () => {
    expect(jsmql.expr`$.age > 18`).toEqual({ $gt: ["$age", 18] });
  });

  describe("opaque BSON value interpolation", () => {
    // JSON.stringify mangles these instances — `new Date(...)` becomes an ISO
    // string (BSON compares as a string), `RegExp` becomes "{}", `Uint8Array`
    // becomes a sparse object. The template-tag path routes them through a
    // synthesized ParamRef binding so the original instance reaches the MQL
    // output untouched — that's the shape MongoDB's driver expects in-situ.

    it("Date interpolation lands in query-doc form as a real Date", () => {
      const cutoff = new Date("2026-01-01");
      const out = jsmql`$.method === ${"postalDelivery"} && $.createdAt >= ${cutoff}` as {
        method: string;
        createdAt: { $gte: Date };
      };
      expect(out).toEqual({ method: "postalDelivery", createdAt: { $gte: cutoff } });
      expect(out.createdAt.$gte).toBeInstanceOf(Date);
      expect(out.createdAt.$gte.getTime()).toBe(cutoff.getTime());
    });

    it("RegExp interpolation lands in query-doc form as a real RegExp", () => {
      const pat = /^alice/i;
      const out = jsmql`$.username === ${pat}` as { username: RegExp };
      expect(out.username).toBe(pat);
    });

    it("Uint8Array interpolation passes through unchanged", () => {
      const buf = new Uint8Array([1, 2, 3]);
      const out = jsmql`$.payload === ${buf}` as { payload: Uint8Array };
      expect(out.payload).toBe(buf);
    });

    it("ObjectId duck-typed (legacy _bsontype: 'ObjectID') passes through unchanged", () => {
      const oid = { _bsontype: "ObjectID", id: "abc" };
      const out = jsmql`$._id === ${oid}` as { _id: typeof oid };
      expect(out._id).toBe(oid);
    });

    it("ObjectId duck-typed (newer _bsontype: 'ObjectId') passes through unchanged", () => {
      const oid = { _bsontype: "ObjectId", id: "xyz" };
      const out = jsmql`$._id === ${oid}` as { _id: typeof oid };
      expect(out._id).toBe(oid);
    });

    it("Date interpolation works inside an explicit $match pipeline stage", () => {
      const cutoff = new Date("2026-01-01");
      const out = jsmql`$match($.createdAt >= ${cutoff});` as Array<{ $match: { createdAt: { $gte: Date } } }>;
      expect(out).toEqual([{ $match: { createdAt: { $gte: cutoff } } }]);
      expect(out[0].$match.createdAt.$gte).toBeInstanceOf(Date);
    });

    it("Date interpolation flows through jsmql.expr — lands directly in the expression", () => {
      const cutoff = new Date("2026-01-01");
      const out = jsmql.expr`{ since: ${cutoff} }` as { since: Date };
      expect(out.since).toBe(cutoff);
    });

    it("ordered comparison via template tag is index-friendly (no $expr fallback)", () => {
      // The bug-report shape, expressed via the template tag form.
      const out = jsmql`$.createdAt >= ${new Date("2026-01-01")}` as Record<string, unknown>;
      expect("$expr" in out).toBe(false);
      expect((out.createdAt as { $gte: unknown }).$gte).toBeInstanceOf(Date);
    });

    it("mixing opaque and JSON-shaped interpolations leaves each on its correct path", () => {
      const cutoff = new Date("2026-01-01");
      const tier = "gold";
      const out = jsmql`$.tier === ${tier} && $.createdAt >= ${cutoff}` as { tier: string; createdAt: { $gte: Date } };
      expect(out.tier).toBe("gold");
      expect(out.createdAt.$gte).toBe(cutoff);
    });

    // Nested-interp cases — opaque BSON instances buried inside an interpolated
    // object or array still reach the MQL output as live JS instances. The
    // walker substitutes each instance with a marker carrying a unique binding
    // name, JSON-stringifies the rewritten tree, then post-replaces the
    // markers with bare identifiers so the parser resolves them as ParamRefs.

    it("Date nested inside an interpolated object preserves the instance", () => {
      const since = new Date("2026-01-01");
      const out = jsmql.expr`${{ since }}` as { since: Date };
      expect(out.since).toBe(since);
    });

    it("multiple Dates inside one object each get their own binding", () => {
      const since = new Date("2026-01-01");
      const until = new Date("2026-02-01");
      const out = jsmql.expr`${{ since, until }}` as { since: Date; until: Date };
      expect(out.since).toBe(since);
      expect(out.until).toBe(until);
    });

    it("Date inside an interpolated array preserves position and instance", () => {
      const since = new Date("2026-01-01");
      const until = new Date("2026-02-01");
      const out = jsmql.expr`${[since, until]}` as [Date, Date];
      expect(out[0]).toBe(since);
      expect(out[1]).toBe(until);
    });

    it("mixed JSON + Date inside one interpolated object: each leaf keeps its shape", () => {
      const since = new Date("2026-01-01");
      const out = jsmql.expr`${{ name: "foo", since, count: 42 }}` as { name: string; since: Date; count: number };
      expect(out).toEqual({ name: "foo", since, count: 42 });
      expect(out.since).toBe(since);
    });

    it("deeply-nested opaque value (3 levels) survives", () => {
      const since = new Date("2026-01-01");
      const out = jsmql.expr`${{ a: { b: { c: since } } }}` as { a: { b: { c: Date } } };
      expect(out.a.b.c).toBe(since);
    });

    it("nested RegExp inside an interpolated object preserves the instance", () => {
      const pat = /^alice/i;
      const out = jsmql.expr`${{ pat, label: "name" }}` as { pat: RegExp; label: string };
      expect(out.pat).toBe(pat);
      expect(out.label).toBe("name");
    });

    it("$dateDiff with an interpolated object carrying Date instances — realistic shape", () => {
      // The canonical use case: building a `$dateDiff` body with computed
      // bounds. The interpolated object lives in operator-call position; the
      // two Date instances are preserved at their nested keys.
      const startDate = new Date("2026-01-01");
      const endDate = new Date("2026-02-01");
      const out = jsmql.expr`$dateDiff(${{ startDate, endDate, unit: "day" }})` as {
        $dateDiff: { startDate: Date; endDate: Date; unit: string };
      };
      expect(out.$dateDiff.startDate).toBe(startDate);
      expect(out.$dateDiff.endDate).toBe(endDate);
      expect(out.$dateDiff.unit).toBe("day");
    });

    it("circular references inside an interpolated object surface as JsmqlInterpolationError", () => {
      // Cycle detection in the walker returns the cyclic value as-is so the
      // subsequent JSON.stringify produces the standard "circular structure"
      // error — surfaced as `JsmqlInterpolationError`.
      const cyclic: { since: Date; self?: unknown } = { since: new Date("2026-01-01") };
      cyclic.self = cyclic;
      expect(() => jsmql.expr`${cyclic}`).toThrow(/could not be serialised/);
    });
  });
});

describe("jsmql.compile — opaque BSON bindings outside query-doc position", () => {
  // Pre-existing bug, fixed in tandem with the template-tag side channel:
  // `safeBoundValue` used to iterate `Object.entries(bsonInstance)` and
  // silently collapse the value to `{}`. Bindings consumed inside an update
  // op body, an aggregation expression, etc. now pass through intact.

  it("Date binding lands as a real Date inside an update op", () => {
    const q = jsmql.compile(({ at }: { at: Date }) => ($.lastSeenAt = at));
    const at = new Date("2026-01-01");
    const out = q({ at }) as Array<{ $set: { lastSeenAt: Date } }>;
    expect(out[0].$set.lastSeenAt).toBe(at);
  });

  it("RegExp binding lands as a real RegExp inside an update op", () => {
    const q = jsmql.compile(({ pat }: { pat: RegExp }) => ($.name = pat));
    const pat = /^alice/i;
    const out = q({ pat }) as Array<{ $set: { name: RegExp } }>;
    expect(out[0].$set.name).toBe(pat);
  });

  // Nested-BSON cases — symmetric with the template-tag nested-interp tests.
  // `safeBoundValue` recurses through plain objects/arrays and short-circuits
  // on `isOpaqueBsonValue`, so the same shapes that work via interpolation
  // also work via parameter bindings — no manual unpacking required at the
  // call site.

  it("Date nested inside a binding object preserves the instance", () => {
    const q = jsmql.compile(({ window }: { window: { since: Date; until: Date; unit: string } }) => $set({ window }));
    const since = new Date("2026-01-01");
    const until = new Date("2026-02-01");
    const out = q({ window: { since, until, unit: "day" } }) as Array<{
      $set: { window: { since: Date; until: Date; unit: string } };
    }>;
    expect(out[0].$set.window.since).toBe(since);
    expect(out[0].$set.window.until).toBe(until);
    expect(out[0].$set.window.unit).toBe("day");
  });

  it("Date inside a binding array preserves each instance", () => {
    const q = jsmql.compile(({ bounds }: { bounds: Date[] }) => $set({ bounds }));
    const since = new Date("2026-01-01");
    const until = new Date("2026-02-01");
    const out = q({ bounds: [since, until] }) as Array<{ $set: { bounds: Date[] } }>;
    expect(out[0].$set.bounds[0]).toBe(since);
    expect(out[0].$set.bounds[1]).toBe(until);
  });

  it("deeply-nested (3 levels) Date inside a binding survives", () => {
    const q = jsmql.compile(({ cfg }: { cfg: { a: { b: { c: Date } } } }) => $set({ cfg }));
    const since = new Date("2026-01-01");
    const out = q({ cfg: { a: { b: { c: since } } } }) as Array<{ $set: { cfg: { a: { b: { c: Date } } } } }>;
    expect(out[0].$set.cfg.a.b.c).toBe(since);
  });

  it("mixed JSON + Date inside a binding object: each leaf keeps its shape", () => {
    const q = jsmql.compile(({ cfg }: { cfg: { name: string; since: Date; count: number; until: Date } }) =>
      $set({ cfg }),
    );
    const since = new Date("2026-01-01");
    const until = new Date("2026-02-01");
    const out = q({ cfg: { name: "foo", since, count: 42, until } }) as Array<{
      $set: { cfg: { name: string; since: Date; count: number; until: Date } };
    }>;
    expect(out[0].$set.cfg).toEqual({ name: "foo", since, count: 42, until });
    expect(out[0].$set.cfg.since).toBe(since);
    expect(out[0].$set.cfg.until).toBe(until);
  });

  it("nested RegExp inside a binding object preserves the instance", () => {
    const q = jsmql.compile(({ matchers }: { matchers: { name: RegExp; status: RegExp } }) => $set({ matchers }));
    const name = /^alice/i;
    const status = /^ok$/;
    const out = q({ matchers: { name, status } }) as Array<{ $set: { matchers: { name: RegExp; status: RegExp } } }>;
    expect(out[0].$set.matchers.name).toBe(name);
    expect(out[0].$set.matchers.status).toBe(status);
  });

  it("nested Uint8Array inside a binding object preserves the instance", () => {
    const q = jsmql.compile(({ payloads }: { payloads: { hash: Uint8Array } }) => $set({ payloads }));
    const hash = new Uint8Array([1, 2, 3]);
    const out = q({ payloads: { hash } }) as Array<{ $set: { payloads: { hash: Uint8Array } } }>;
    expect(out[0].$set.payloads.hash).toBe(hash);
  });

  it("nested ObjectId (duck-typed) inside a binding object preserves the instance", () => {
    // Mirrors the template-tag side: the project accepts both the legacy
    // `_bsontype: "ObjectID"` (uppercase D) tag and the newer
    // `_bsontype: "ObjectId"` (lowercase d) tag, since BSON library versions
    // disagree on the casing.
    const q = jsmql.compile(({ ids }: { ids: { primary: unknown; secondary: unknown } }) => $set({ ids }));
    const primary = { _bsontype: "ObjectID", id: "abc" };
    const secondary = { _bsontype: "ObjectId", id: "xyz" };
    const out = q({ ids: { primary, secondary } }) as Array<{
      $set: { ids: { primary: unknown; secondary: unknown } };
    }>;
    expect(out[0].$set.ids.primary).toBe(primary);
    expect(out[0].$set.ids.secondary).toBe(secondary);
  });

  it("Date inside a binding lands in $set body alongside JSON-shaped siblings (realistic shape)", () => {
    // The realistic call-site shape: a single `cfg` parameter that bundles a
    // BSON Date with plain-JSON fields. Mirrors how a caller would package
    // a typed config object built elsewhere in their codebase.
    const q = jsmql.compile(({ cfg }: { cfg: { startedAt: Date; mode: string; retries: number } }) => $set({ cfg }));
    const startedAt = new Date("2026-01-01");
    const out = q({ cfg: { startedAt, mode: "fast", retries: 3 } }) as Array<{
      $set: { cfg: { startedAt: Date; mode: string; retries: number } };
    }>;
    expect(out[0].$set.cfg.startedAt).toBe(startedAt);
    expect(out[0].$set.cfg.mode).toBe("fast");
    expect(out[0].$set.cfg.retries).toBe(3);
  });
});

describe("jsmql.expr() input-shape guard", () => {
  it("throws TypeError with an actionable message for a number", () => {
    expect(() => (jsmql as (x: unknown) => unknown)(42)).toThrow(TypeError);
    expect(() => (jsmql as (x: unknown) => unknown)(42)).toThrow(
      /string, an arrow function, or a template literal — got number/,
    );
  });

  it("throws TypeError for null and reports it as 'null' (not 'object')", () => {
    expect(() => (jsmql as (x: unknown) => unknown)(null)).toThrow(/got null/);
  });

  it("throws TypeError for a plain object", () => {
    expect(() => (jsmql as (x: unknown) => unknown)({})).toThrow(/got object/);
  });

  it("jsmql.validate() routes a wrong-typed input to a structured SYNTAX_ERROR (never throws)", () => {
    const r = (jsmql.validate as (x: unknown) => { valid: boolean; errors: { code: string }[] })(42);
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.code).toBe("SYNTAX_ERROR");
  });
});

describe("jsmql.validate()", () => {
  it("returns valid for correct expression", () => {
    const result = jsmql.validate("$eq($.age, 18)");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns error for unknown identifier", () => {
    const result = jsmql.validate("$eq(age, 18)");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/Did you mean/);
  });

  it("returns error for unclosed paren", () => {
    const result = jsmql.validate("$eq($.age, 18");
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("returns error for trailing junk", () => {
    const result = jsmql.validate("$eq($.age, 18) garbage");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/Unexpected token/);
  });
});

describe("single-char negative numbers", () => {
  it("negative number literal", () => {
    expect(jsmql.expr("$abs(-5)")).toEqual({ $abs: -5 });
  });
});

describe("arithmetic operators", () => {
  it("+ numeric", () => {
    expect(jsmql.expr("$.a + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("- binary", () => {
    expect(jsmql.expr("$.a - $.b")).toEqual({ $subtract: ["$a", "$b"] });
  });
  it("* multiply", () => {
    expect(jsmql.expr("$.a * 1.1")).toEqual({ $multiply: ["$a", 1.1] });
  });
  it("/ divide", () => {
    expect(jsmql.expr("$.a / $.b")).toEqual({ $divide: ["$a", "$b"] });
  });
  it("% modulo", () => {
    expect(jsmql.expr("$.a % 2")).toEqual({ $mod: ["$a", 2] });
  });
  it("** power", () => {
    expect(jsmql.expr("$.base ** 2")).toEqual({ $pow: ["$base", 2] });
  });
  it("** is right-associative", () => {
    expect(jsmql.expr("2 ** 3 ** 2")).toEqual({ $pow: [2, { $pow: [3, 2] }] });
  });
});

describe("comparison operators", () => {
  it("== null (loose: matches null OR missing via $type check)", () => {
    expect(jsmql.expr("$.status == null")).toEqual({ $in: [{ $type: "$status" }, ["null", "missing"]] });
  });
  it("=== (strict equality against any value)", () => {
    expect(jsmql.expr("$.status === 'active'")).toEqual({ $eq: ["$status", "active"] });
  });
  it("=== null (strict: matches only explicit null)", () => {
    expect(jsmql.expr("$.status === null")).toEqual({ $eq: ["$status", null] });
  });
  it("!= null (loose: excludes both null AND missing)", () => {
    expect(jsmql.expr("$.status != null")).toEqual({ $not: [{ $in: [{ $type: "$status" }, ["null", "missing"]] }] });
  });
  it("!== null (strict: missing fields still pass)", () => {
    expect(jsmql.expr("$.status !== null")).toEqual({ $ne: ["$status", null] });
  });
  it("rejects `==` against non-null with an actionable error", () => {
    expect(() => jsmql.expr("$.status == 'active'")).toThrow(/'=='.*only allowed against null.*'==='/);
  });
  it("rejects `!=` against non-null with an actionable error", () => {
    expect(() => jsmql.expr("$.status != 'active'")).toThrow(/'!='.*only allowed against null/);
  });
  it("rejects `==` against a number literal", () => {
    expect(() => jsmql.expr("$.x == 5")).toThrow(/'=='.*only allowed against null/);
  });
  it("accepts `null` on either side of `==`", () => {
    expect(jsmql.expr("null == $.status")).toEqual({ $in: [{ $type: "$status" }, ["null", "missing"]] });
  });
  it(">", () => {
    expect(jsmql.expr("$.age > 18")).toEqual({ $gt: ["$age", 18] });
  });
  it(">=", () => {
    expect(jsmql.expr("$.age >= 21")).toEqual({ $gte: ["$age", 21] });
  });
  it("<", () => {
    expect(jsmql.expr("$.score < 50")).toEqual({ $lt: ["$score", 50] });
  });
  it("<=", () => {
    expect(jsmql.expr("$.score <= 100")).toEqual({ $lte: ["$score", 100] });
  });
  it("in", () => {
    expect(jsmql.expr('$.status in ["active", "pending"]')).toEqual({ $in: ["$status", ["active", "pending"]] });
  });
});

describe("logical operators", () => {
  it("&& on field refs returns operand (JS semantics)", () => {
    expect(jsmql.expr("$.a && $.b")).toEqual({ $cond: [truthy("$a"), "$b", "$a"] });
  });
  it("|| on field refs returns operand (JS semantics)", () => {
    expect(jsmql.expr("$.a || $.b")).toEqual({ $cond: [truthy("$a"), "$a", "$b"] });
  });
  it("&& on bool comparisons stays as $and (no operand-preservation needed)", () => {
    expect(jsmql.expr("$.a > 0 && $.b > 0")).toEqual({ $and: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }] });
  });
  it("|| on bool comparisons stays as $or", () => {
    expect(jsmql.expr("$.a > 0 || $.b > 0")).toEqual({ $or: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }] });
  });
  it("! unary uses JS truthiness", () => {
    expect(jsmql.expr("!$.active")).toEqual({ $not: truthy("$active") });
  });
  it("!! double negation peephole → jsBool (no $not-of-$not)", () => {
    expect(jsmql.expr("!!$.active")).toEqual(truthy("$active"));
  });
  it("! on a comparison elides the jsBool wrap", () => {
    expect(jsmql.expr("!($.a > 0)")).toEqual({ $not: { $gt: ["$a", 0] } });
  });
  it("&& with non-pure-ref LHS uses $let to bind once", () => {
    expect(jsmql.expr("($.a + $.b) && $.c")).toEqual({
      $let: { vars: { _v: { $add: ["$a", "$b"] } }, in: { $cond: [truthy("$$_v"), "$c", "$$_v"] } },
    });
  });
  it("|| short-circuit chain with default (user's idiom)", () => {
    expect(jsmql.expr('$.nickname || "anonymous"')).toEqual({ $cond: [truthy("$nickname"), "$nickname", "anonymous"] });
  });
});

describe("ternary", () => {
  it("basic ternary with bool condition (no jsBool wrap)", () => {
    expect(jsmql.expr("$.age >= 18 ? 'adult' : 'minor'")).toEqual({
      $cond: [{ $gte: ["$age", 18] }, "adult", "minor"],
    });
  });
  it("ternary with non-bool condition wraps in jsBool", () => {
    expect(jsmql.expr('$.name ? "yes" : "no"')).toEqual({ $cond: [truthy("$name"), "yes", "no"] });
  });
  it("nested ternary (right-associative) wraps each non-bool condition", () => {
    expect(jsmql.expr("$.a ? 'x' : $.b ? 'y' : 'z'")).toEqual({
      $cond: [truthy("$a"), "x", { $cond: [truthy("$b"), "y", "z"] }],
    });
  });
});

describe("nullish coalescing", () => {
  it("??", () => {
    expect(jsmql.expr("$.nickname ?? $.name")).toEqual({ $ifNull: ["$nickname", "$name"] });
  });
  it("?? flattened chain", () => {
    expect(jsmql.expr("$.a ?? $.b ?? 'unknown'")).toEqual({ $ifNull: ["$a", "$b", "unknown"] });
  });
});

describe("unary minus", () => {
  it("unary - on field", () => {
    expect(jsmql.expr("-$.amount")).toEqual({ $multiply: ["$amount", -1] });
  });
  it("unary - on number literal optimised to negative number", () => {
    expect(jsmql.expr("-5")).toEqual(-5);
  });
  it("unary - on number inside operator", () => {
    expect(jsmql.expr("$abs(-5)")).toEqual({ $abs: -5 });
  });
  it("unary - on expression", () => {
    expect(jsmql.expr("-($.a + $.b)")).toEqual({ $multiply: [{ $add: ["$a", "$b"] }, -1] });
  });
});

describe("operator flattening", () => {
  it("+ flattened to $add", () => {
    expect(jsmql.expr("$.a + $.b + $.c")).toEqual({ $add: ["$a", "$b", "$c"] });
  });
  it("* flattened to $multiply", () => {
    expect(jsmql.expr("$.a * $.b * $.c")).toEqual({ $multiply: ["$a", "$b", "$c"] });
  });
  it("&& on bool comparisons flattened to $and", () => {
    expect(jsmql.expr("$.a > 0 && $.b > 0 && $.c > 0")).toEqual({
      $and: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }, { $gt: ["$c", 0] }],
    });
  });
  it("|| on bool comparisons flattened to $or", () => {
    expect(jsmql.expr("$.a > 0 || $.b > 0 || $.c > 0")).toEqual({
      $or: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }, { $gt: ["$c", 0] }],
    });
  });
  it("&& on non-bool operands folds right into nested $cond (operand-preserving)", () => {
    expect(jsmql.expr("$.a && $.b && $.c")).toEqual({
      $cond: [truthy("$a"), { $cond: [truthy("$b"), "$c", "$b"] }, "$a"],
    });
  });
  it("|| on non-bool operands folds right (operand-preserving)", () => {
    expect(jsmql.expr("$.a || $.b || $.c")).toEqual({
      $cond: [truthy("$a"), "$a", { $cond: [truthy("$b"), "$b", "$c"] }],
    });
  });
  it("?? flattened to $ifNull (4 operands)", () => {
    expect(jsmql.expr("$.a ?? $.b ?? $.c ?? 0")).toEqual({ $ifNull: ["$a", "$b", "$c", 0] });
  });
  it("- is NOT flattened (left-assoc, not same operator)", () => {
    expect(jsmql.expr("$.a - $.b - $.c")).toEqual({ $subtract: [{ $subtract: ["$a", "$b"] }, "$c"] });
  });
});

describe("string-context +", () => {
  it("string literal in chain → $concat", () => {
    expect(jsmql.expr('$.first + " " + $.last')).toEqual({ $concat: ["$first", " ", "$last"] });
  });
  it("empty string → $concat", () => {
    expect(jsmql.expr('$.a + ""')).toEqual({ $concat: ["$a", ""] });
  });
  it("no string literal → $add", () => {
    expect(jsmql.expr("$.a + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("string-output operator → $concat", () => {
    expect(jsmql.expr("$toString($.n) + $.s")).toEqual({ $concat: [{ $toString: "$n" }, "$s"] });
  });
  it("$toLower result in chain → $concat", () => {
    expect(jsmql.expr("$.prefix + $toLower($.name)")).toEqual({ $concat: ["$prefix", { $toLower: "$name" }] });
  });
  it("mixed numeric + string-output op → $concat", () => {
    expect(jsmql.expr('$.count + " items"')).toEqual({ $concat: ["$count", " items"] });
  });
});

describe("bracket access", () => {
  it("constant index on bare field → runtime $cond on $isArray", () => {
    // Bare $.items receiver — type unknown — dispatch at runtime to handle
    // either array (numeric index) or object (dynamic key) at query time.
    expect(jsmql.expr("$.items[0]")).toEqual({
      $cond: [{ $isArray: "$items" }, { $arrayElemAt: ["$items", 0] }, { $getField: { field: 0, input: "$items" } }],
    });
  });
  it("field index on bare field → runtime $cond", () => {
    expect(jsmql.expr("$.items[$.idx]")).toEqual({
      $cond: [
        { $isArray: "$items" },
        { $arrayElemAt: ["$items", "$idx"] },
        { $getField: { field: "$idx", input: "$items" } },
      ],
    });
  });
  it("string-literal key on bare field → runtime $cond (the $getField branch is the right one for objects)", () => {
    expect(jsmql.expr('$.config["host"]')).toEqual({
      $cond: [
        { $isArray: "$config" },
        { $arrayElemAt: ["$config", "host"] },
        { $getField: { field: "host", input: "$config" } },
      ],
    });
  });
  it("chained bracket access on bare field → nested $cond", () => {
    expect(jsmql.expr("$.m[$.r][$.c]")).toEqual({
      $cond: [
        {
          $isArray: {
            $cond: [{ $isArray: "$m" }, { $arrayElemAt: ["$m", "$r"] }, { $getField: { field: "$r", input: "$m" } }],
          },
        },
        {
          $arrayElemAt: [
            {
              $cond: [{ $isArray: "$m" }, { $arrayElemAt: ["$m", "$r"] }, { $getField: { field: "$r", input: "$m" } }],
            },
            "$c",
          ],
        },
        {
          $getField: {
            field: "$c",
            input: {
              $cond: [{ $isArray: "$m" }, { $arrayElemAt: ["$m", "$r"] }, { $getField: { field: "$r", input: "$m" } }],
            },
          },
        },
      ],
    });
  });
  it("bracket access on known-array operator result stays compact", () => {
    expect(jsmql.expr("$reverseArray($.items)[0]")).toEqual({ $arrayElemAt: [{ $reverseArray: "$items" }, 0] });
  });
  it("bracket access on .map() result stays compact", () => {
    expect(jsmql.expr("$.items.map(x => x.id)[0]")).toEqual({
      $arrayElemAt: [{ $map: { input: "$items", as: "x", in: "$$x.id" } }, 0],
    });
  });
});

describe("grouped expressions", () => {
  it("grouping changes precedence", () => {
    expect(jsmql.expr("($.a + $.b) * 2")).toEqual({ $multiply: [{ $add: ["$a", "$b"] }, 2] });
  });
  it("without grouping * binds tighter", () => {
    expect(jsmql.expr("$.a + $.b * 2")).toEqual({ $add: ["$a", { $multiply: ["$b", 2] }] });
  });
});

describe("operator precedence", () => {
  it("* before +", () => {
    expect(jsmql.expr("$.a + $.b * $.c")).toEqual({ $add: ["$a", { $multiply: ["$b", "$c"] }] });
  });
  it("comparison before && (mixed-bool chain folds operand-preserving)", () => {
    expect(jsmql.expr("$.age > 18 && $.active")).toEqual({
      $cond: [{ $gt: ["$age", 18] }, "$active", { $gt: ["$age", 18] }],
    });
  });
  it("&& before ||", () => {
    expect(jsmql.expr("$.a || $.b && $.c")).toEqual({
      $cond: [truthy("$a"), "$a", { $cond: [truthy("$b"), "$c", "$b"] }],
    });
  });
  it("! before && (LHS is provably bool, no $let)", () => {
    expect(jsmql.expr("!$.a && $.b")).toEqual({ $cond: [{ $not: truthy("$a") }, "$b", { $not: truthy("$a") }] });
  });
});

describe("mixed $operator() and infix", () => {
  it("infix inside $operator args", () => {
    expect(jsmql.expr("$and($.age > 18, $.status === 'active')")).toEqual({
      $and: [{ $gt: ["$age", 18] }, { $eq: ["$status", "active"] }],
    });
  });
  it("$operator wrapping infix", () => {
    expect(jsmql.expr("$abs($.a - $.b)")).toEqual({ $abs: { $subtract: ["$a", "$b"] } });
  });
});

describe("$.in field ref still works", () => {
  it("field named 'in'", () => {
    expect(jsmql.expr("$.in === 'test'")).toEqual({ $eq: ["$in", "test"] });
  });
  it("nested field with 'in' segment", () => {
    expect(jsmql.expr("$size($.in)")).toEqual({ $size: "$in" });
  });
});

describe("field path regression (FieldRef stops at first segment)", () => {
  it("$.a.b.c produces $a.b.c", () => {
    expect(jsmql.expr("$.a.b.c")).toEqual("$a.b.c");
  });
  it("$.items[0].name produces $getField on bracket-access result", () => {
    expect(jsmql.expr("$.items[0].name")).toEqual({
      $getField: {
        field: "name",
        input: {
          $cond: [
            { $isArray: "$items" },
            { $arrayElemAt: ["$items", 0] },
            { $getField: { field: 0, input: "$items" } },
          ],
        },
      },
    });
  });
  it("rejects numeric field segments — $.items.0 is not valid JS syntax", () => {
    expect(() => jsmql.expr("$.items.0")).toThrow(/Expected property name after '\.'/);
  });
  it("deep path inside $abs", () => {
    expect(jsmql.expr("$abs($.a.b.c)")).toEqual({ $abs: "$a.b.c" });
  });
  it("dotted path in comparison", () => {
    expect(jsmql.expr("$.loyalty.years >= 2")).toEqual({ $gte: ["$loyalty.years", 2] });
  });
});

describe("string methods", () => {
  it("trim", () => {
    expect(jsmql.expr("$.name.trim()")).toEqual({ $trim: { input: "$name" } });
  });
  it("trimStart", () => {
    expect(jsmql.expr("$.name.trimStart()")).toEqual({ $ltrim: { input: "$name" } });
  });
  it("trimLeft alias", () => {
    expect(jsmql.expr("$.name.trimLeft()")).toEqual({ $ltrim: { input: "$name" } });
  });
  it("trimEnd", () => {
    expect(jsmql.expr("$.name.trimEnd()")).toEqual({ $rtrim: { input: "$name" } });
  });
  it("trimRight alias", () => {
    expect(jsmql.expr("$.name.trimRight()")).toEqual({ $rtrim: { input: "$name" } });
  });
  it("toLowerCase", () => {
    expect(jsmql.expr("$.name.toLowerCase()")).toEqual({ $toLower: "$name" });
  });
  it("toUpperCase", () => {
    expect(jsmql.expr("$.name.toUpperCase()")).toEqual({ $toUpper: "$name" });
  });
  it("substr", () => {
    expect(jsmql.expr("$.name.substr(0, 5)")).toEqual({ $substrCP: ["$name", 0, 5] });
  });
  it("split", () => {
    expect(jsmql.expr('$.csv.split(",")')).toEqual({ $split: ["$csv", ","] });
  });
  it("indexOf on bare field → runtime $cond on $isArray", () => {
    expect(jsmql.expr('$.name.indexOf("@")')).toEqual({
      $cond: [{ $isArray: "$name" }, { $indexOfArray: ["$name", "@"] }, { $indexOfCP: ["$name", "@"] }],
    });
  });
  it("indexOf on known string → $indexOfCP", () => {
    expect(jsmql.expr('$.name.toLowerCase().indexOf("@")')).toEqual({ $indexOfCP: [{ $toLower: "$name" }, "@"] });
  });
  it("replace", () => {
    expect(jsmql.expr('$.name.replace("a", "b")')).toEqual({
      $replaceOne: { input: "$name", find: "a", replacement: "b" },
    });
  });
  it("replaceAll", () => {
    expect(jsmql.expr('$.slug.replaceAll(" ", "-")')).toEqual({
      $replaceAll: { input: "$slug", find: " ", replacement: "-" },
    });
  });
  it("includes on bare field → runtime $cond on $isArray", () => {
    expect(jsmql.expr('$.email.includes("@")')).toEqual({
      $cond: [{ $isArray: "$email" }, { $in: ["@", "$email"] }, { $gte: [{ $indexOfCP: ["$email", "@"] }, 0] }],
    });
  });
  it("includes on known string → string form", () => {
    expect(jsmql.expr('$.email.toLowerCase().includes("@")')).toEqual({
      $gte: [{ $indexOfCP: [{ $toLower: "$email" }, "@"] }, 0],
    });
  });
  it("match with regex literal", () => {
    expect(jsmql.expr("$.str.match(/^[A-Z]/)")).toEqual({ $regexMatch: { input: "$str", regex: "^[A-Z]" } });
  });
  it("match with regex literal and flags", () => {
    expect(jsmql.expr("$.str.match(/^[a-z]/i)")).toEqual({
      $regexMatch: { input: "$str", regex: "^[a-z]", options: "i" },
    });
  });
  it("match with string pattern", () => {
    expect(jsmql.expr('$.str.match("^[a-z]")')).toEqual({ $regexMatch: { input: "$str", regex: "^[a-z]" } });
  });
  it("length on string-producing expression → $strLenCP", () => {
    expect(jsmql.expr("$.name.trim().length")).toEqual({ $strLenCP: { $trim: { input: "$name" } } });
  });
  it("length on array-producing expression → $size", () => {
    expect(jsmql.expr('$.csv.split(",").length')).toEqual({ $size: { $split: ["$csv", ","] } });
  });
  it("length on map result → $size", () => {
    expect(jsmql.expr("$.items.map(x => x).length")).toEqual({
      $size: { $map: { input: "$items", as: "x", in: "$$x" } },
    });
  });
  it("length on unknown field → runtime dispatch", () => {
    expect(jsmql.expr("$.items.length")).toEqual({
      $cond: [{ $isArray: "$items" }, { $size: "$items" }, { $strLenCP: "$items" }],
    });
  });
  it("chained trim then toLowerCase", () => {
    expect(jsmql.expr("$.name.trim().toLowerCase()")).toEqual({ $toLower: { $trim: { input: "$name" } } });
  });
  it("chained toLowerCase then trim", () => {
    expect(jsmql.expr("$.name.toLowerCase().trim()")).toEqual({ $trim: { input: { $toLower: "$name" } } });
  });
});

describe("array methods (no lambda)", () => {
  it("at(n)", () => {
    expect(jsmql.expr("$.items.at(0)")).toEqual({ $arrayElemAt: ["$items", 0] });
  });
  it("at(-1)", () => {
    expect(jsmql.expr("$.items.at(-1)")).toEqual({ $arrayElemAt: ["$items", -1] });
  });
  it("slice(start) on bare $.field → runtime $cond on $isArray", () => {
    expect(jsmql.expr("$.items.slice(2)")).toEqual({
      $cond: [
        { $isArray: "$items" },
        { $slice: ["$items", 2] },
        { $substrCP: ["$items", 2, { $subtract: [{ $strLenCP: "$items" }, 2] }] },
      ],
    });
  });
  it("slice(start, end) on bare $.field → runtime $cond on $isArray", () => {
    expect(jsmql.expr("$.items.slice(0, 3)")).toEqual({
      $cond: [{ $isArray: "$items" }, { $slice: ["$items", 0, 3] }, { $substrCP: ["$items", 0, 3] }],
    });
  });
  it("slice(start, end) on known array → $slice", () => {
    expect(jsmql.expr("[1,2,3,4,5].slice(1, 3)")).toEqual({ $slice: [[1, 2, 3, 4, 5], 1, 3] });
  });
  it("toReversed()", () => {
    expect(jsmql.expr("$.items.toReversed()")).toEqual({ $reverseArray: "$items" });
  });
});

describe("array methods (with lambda)", () => {
  it("map with single param", () => {
    expect(jsmql.expr("$.prices.map(p => p * 1.1)")).toEqual({
      $map: { input: "$prices", as: "p", in: { $multiply: ["$$p", 1.1] } },
    });
  });
  it("map with parenthesized param", () => {
    expect(jsmql.expr("$.prices.map((p) => p * 1.1)")).toEqual({
      $map: { input: "$prices", as: "p", in: { $multiply: ["$$p", 1.1] } },
    });
  });
  it("filter", () => {
    expect(jsmql.expr("$.items.filter(x => x > 0)")).toEqual({
      $filter: { input: "$items", as: "x", cond: { $gt: ["$$x", 0] } },
    });
  });
  it("find", () => {
    expect(jsmql.expr("$.items.find(x => x > 0)")).toEqual({
      $arrayElemAt: [{ $filter: { input: "$items", as: "x", cond: { $gt: ["$$x", 0] } } }, 0],
    });
  });
  it("some", () => {
    expect(jsmql.expr("$.items.some(x => x > 0)")).toEqual({
      $anyElementTrue: { $map: { input: "$items", as: "x", in: { $gt: ["$$x", 0] } } },
    });
  });
  it("every", () => {
    expect(jsmql.expr("$.items.every(x => x > 0)")).toEqual({
      $allElementsTrue: { $map: { input: "$items", as: "x", in: { $gt: ["$$x", 0] } } },
    });
  });
  it("reduce", () => {
    expect(jsmql.expr("$.ns.reduce((acc, x) => acc + x, 0)")).toEqual({
      $reduce: { input: "$ns", initialValue: 0, in: { $add: ["$$value", "$$this"] } },
    });
  });
  it("lambda accessing doc field via $.", () => {
    expect(jsmql.expr("$.items.map(x => x * $.taxRate)")).toEqual({
      $map: { input: "$items", as: "x", in: { $multiply: ["$$x", "$taxRate"] } },
    });
  });
  it("lambda accessing nested field on element (x.status → $$x.status)", () => {
    expect(jsmql.expr('$.orders.filter(o => o.status === "active")')).toEqual({
      $filter: { input: "$orders", as: "o", cond: { $eq: ["$$o.status", "active"] } },
    });
  });
  it("reduce accessing element field ($$this.price)", () => {
    expect(jsmql.expr("$.orders.reduce((sum, o) => sum + o.price, 0)")).toEqual({
      $reduce: { input: "$orders", initialValue: 0, in: { $add: ["$$value", "$$this.price"] } },
    });
  });
});

describe("reduce accumulator type narrowing", () => {
  // The reduce codegen narrows the accumulator parameter to "object" or
  // "array" when initialValue and the lambda body are statically the same
  // compound type. The IndexAccess codegen then skips the runtime $cond on
  // $isArray and emits the type-specific operator directly. Both sides must
  // agree because $$value after iteration i ≥ 1 is the body's return from
  // iteration i-1, not the initialValue.
  it("object accumulator: acc[k] emits $getField directly", () => {
    expect(jsmql.expr("$.xs.reduce((a, k) => ({ ...a, [k]: 1 }), {})")).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: {},
        in: { $mergeObjects: ["$$value", { $arrayToObject: [["$$this", 1]] }] },
      },
    });
    // Read the accumulator with bracket access in the body — confirms the
    // narrowing reaches IndexAccess and emits $getField, not $cond.
    expect(jsmql.expr("$.xs.reduce((a, k) => ({ ...a, [k]: a[k] }), {})")).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: {},
        in: {
          $mergeObjects: [
            "$$value",
            { $arrayToObject: [["$$this", { $getField: { field: "$$this", input: "$$value" } }]] },
          ],
        },
      },
    });
  });

  it("array accumulator: acc[i] emits $arrayElemAt directly", () => {
    expect(jsmql.expr("$.xs.reduce((a, x) => [...a, a[0]], [])")).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: [],
        in: { $concatArrays: ["$$value", [{ $arrayElemAt: ["$$value", 0] }]] },
      },
    });
  });

  it("body diverges from initialValue: keeps runtime $cond", () => {
    expect(jsmql.expr("$.xs.reduce((a, x) => x.foo, {})")).toEqual({
      $reduce: { input: "$xs", initialValue: {}, in: "$$this.foo" },
    });
    // When the body returns a member-access on the element, the accumulator
    // is not narrowed, so a bracket access on it still emits the cond.
    expect(jsmql.expr("$.xs.reduce((a, x) => a[0], {})")).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: {},
        in: {
          $cond: [
            { $isArray: "$$value" },
            { $arrayElemAt: ["$$value", 0] },
            { $getField: { field: 0, input: "$$value" } },
          ],
        },
      },
    });
  });

  it("non-literal initialValue: keeps runtime $cond", () => {
    expect(jsmql.expr("$.xs.reduce((a, k) => ({ ...a, k: a[0] }), $.seed)")).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: "$seed",
        in: {
          $mergeObjects: [
            "$$value",
            {
              k: {
                $cond: [
                  { $isArray: "$$value" },
                  { $arrayElemAt: ["$$value", 0] },
                  { $getField: { field: 0, input: "$$value" } },
                ],
              },
            },
          ],
        },
      },
    });
  });

  it("only the accumulator param is narrowed, not the element param", () => {
    // `x[0]` should keep the cond — `x` is the element binding and could be
    // anything; only `a` is narrowed to object.
    expect(jsmql.expr("$.xs.reduce((a, x) => ({ ...a, k: x[0] }), {})")).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: {},
        in: {
          $mergeObjects: [
            "$$value",
            {
              k: {
                $cond: [
                  { $isArray: "$$this" },
                  { $arrayElemAt: ["$$this", 0] },
                  { $getField: { field: 0, input: "$$this" } },
                ],
              },
            },
          ],
        },
      },
    });
  });

  it("nested reduce shadows the outer accumulator type", () => {
    // Outer `acc` is object-typed; inner reduce reuses the name `acc` with
    // initialValue `[]` and an array-producing body, so the inner `acc[0]`
    // must emit $arrayElemAt — not the outer's $getField.
    expect(
      jsmql.expr("$.xs.reduce((acc, x) => ({ ...acc, k: x.ys.reduce((acc, y) => [...acc, acc[0]], []) }), {})"),
    ).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: {},
        in: {
          $mergeObjects: [
            "$$value",
            {
              k: {
                $reduce: {
                  input: "$$this.ys",
                  initialValue: [],
                  in: { $concatArrays: ["$$value", [{ $arrayElemAt: ["$$value", 0] }]] },
                },
              },
            },
          ],
        },
      },
    });
  });

  it("optional-chain default flips to {} for known-object accumulator", () => {
    // `a?.[k]` on a known-object binding wraps with `$ifNull(_, {})` rather
    // than `$ifNull(_, [])` — feeding `$getField` an array on null receivers
    // would be a type error in MongoDB.
    expect(jsmql.expr("$.xs.reduce((a, k) => ({ ...a, [k]: a?.[k] }), {})")).toEqual({
      $reduce: {
        input: "$xs",
        initialValue: {},
        in: {
          $mergeObjects: [
            "$$value",
            { $arrayToObject: [["$$this", { $getField: { field: "$$this", input: { $ifNull: ["$$value", {}] } } }]] },
          ],
        },
      },
    });
  });
});

describe("bare type-cast callbacks", () => {
  it("filter(Boolean) drops JS-falsy elements", () => {
    expect(jsmql.expr("$.items.filter(Boolean)")).toEqual({
      $filter: { input: "$items", as: "v", cond: truthy("$$v") },
    });
  });
  it("map(Number) coerces to double", () => {
    expect(jsmql.expr("$.nums.map(Number)")).toEqual({ $map: { input: "$nums", as: "v", in: { $toDouble: "$$v" } } });
  });
  it("map(String) coerces to string", () => {
    expect(jsmql.expr("$.xs.map(String)")).toEqual({ $map: { input: "$xs", as: "v", in: { $toString: "$$v" } } });
  });
  it("find(Boolean) returns first JS-truthy element", () => {
    expect(jsmql.expr("$.xs.find(Boolean)")).toEqual({
      $arrayElemAt: [{ $filter: { input: "$xs", as: "v", cond: truthy("$$v") } }, 0],
    });
  });
  it("some(Boolean) is any-JS-truthy", () => {
    expect(jsmql.expr("$.xs.some(Boolean)")).toEqual({
      $anyElementTrue: { $map: { input: "$xs", as: "v", in: truthy("$$v") } },
    });
  });
  it("every(Boolean) is all-JS-truthy", () => {
    expect(jsmql.expr("$.xs.every(Boolean)")).toEqual({
      $allElementsTrue: { $map: { input: "$xs", as: "v", in: truthy("$$v") } },
    });
  });
  it("flatMap(Number) survives the desugar", () => {
    expect(jsmql.expr("$.xs.flatMap(Number)")).toEqual({
      $reduce: {
        input: { $map: { input: "$xs", as: "v", in: { $toDouble: "$$v" } } },
        initialValue: [],
        in: { $concatArrays: ["$$value", "$$this"] },
      },
    });
  });
  it("composes through chaining: filter(Boolean).join(' ')", () => {
    expect(jsmql.expr('$.parts.filter(Boolean).join(" ")')).toEqual({
      $reduce: {
        input: { $filter: { input: "$parts", as: "v", cond: truthy("$$v") } },
        initialValue: "",
        in: {
          $cond: [
            { $eq: ["$$value", ""] },
            { $toString: "$$this" },
            { $concat: ["$$value", " ", { $toString: "$$this" }] },
          ],
        },
      },
    });
  });
  it("Boolean as a value (outside callback) errors with the call form suggested", () => {
    expect(() => jsmql.expr("Boolean + 5")).toThrow(/used as a value.*Boolean\(value\)/);
  });
  it("reduce(Boolean, 0) hits the existing param-count error", () => {
    expect(() => jsmql.expr("$.xs.reduce(Boolean, 0)")).toThrow(/2 or 3 parameters/);
  });
  it("parseInt is intentionally not supported bare (avoids the JS index-as-radix footgun)", () => {
    expect(() => jsmql.expr("$.xs.filter(parseInt)")).toThrow(/Expected '\('/);
  });
  it("parseFloat is intentionally not supported bare", () => {
    expect(() => jsmql.expr("$.xs.filter(parseFloat)")).toThrow(/Expected '\('/);
  });
});

describe("date methods", () => {
  it("getFullYear", () => {
    expect(jsmql.expr("$.ts.getFullYear()")).toEqual({ $year: "$ts" });
  });
  it("getMonth (0-based)", () => {
    expect(jsmql.expr("$.ts.getMonth()")).toEqual({ $subtract: [{ $month: "$ts" }, 1] });
  });
  it("getDate", () => {
    expect(jsmql.expr("$.ts.getDate()")).toEqual({ $dayOfMonth: "$ts" });
  });
  it("getDay (0-based)", () => {
    expect(jsmql.expr("$.ts.getDay()")).toEqual({ $subtract: [{ $dayOfWeek: "$ts" }, 1] });
  });
  it("getHours", () => {
    expect(jsmql.expr("$.ts.getHours()")).toEqual({ $hour: "$ts" });
  });
  it("getMinutes", () => {
    expect(jsmql.expr("$.ts.getMinutes()")).toEqual({ $minute: "$ts" });
  });
  it("getSeconds", () => {
    expect(jsmql.expr("$.ts.getSeconds()")).toEqual({ $second: "$ts" });
  });
  it("getMilliseconds", () => {
    expect(jsmql.expr("$.ts.getMilliseconds()")).toEqual({ $millisecond: "$ts" });
  });
});

describe("typeof", () => {
  it("typeof fieldref", () => {
    expect(jsmql.expr("typeof $.x")).toEqual({ $type: "$x" });
  });
  it("typeof in comparison", () => {
    expect(jsmql.expr('typeof $.x === "string"')).toEqual({ $eq: [{ $type: "$x" }, "string"] });
  });
});

describe("new Date()", () => {
  it("no-arg maps to $$NOW", () => {
    expect(jsmql.expr("new Date()")).toEqual({ $toDate: "$$NOW" });
  });
  it("with field arg", () => {
    expect(jsmql.expr("new Date($.ts)")).toEqual({ $toDate: "$ts" });
  });
  it("with string literal", () => {
    expect(jsmql.expr('new Date("2024-01-01")')).toEqual({ $toDate: "2024-01-01" });
  });
  it("new Date(y, m) folds month + 1", () => {
    expect(jsmql.expr("new Date(2024, 0)")).toEqual({ $dateFromParts: { year: 2024, month: 1 } });
  });
  it("new Date(y, m, d) sets day", () => {
    expect(jsmql.expr("new Date(2024, 0, 15)")).toEqual({ $dateFromParts: { year: 2024, month: 1, day: 15 } });
  });
  it("new Date(y, m, d, h, mi, s, ms) fills all parts", () => {
    expect(jsmql.expr("new Date(2024, 11, 31, 23, 59, 58, 999)")).toEqual({
      $dateFromParts: { year: 2024, month: 12, day: 31, hour: 23, minute: 59, second: 58, millisecond: 999 },
    });
  });
  it("non-literal month gets $add: [m, 1]", () => {
    expect(jsmql.expr("new Date($.y, $.m, 1)")).toEqual({
      $dateFromParts: { year: "$y", month: { $add: ["$m", 1] }, day: 1 },
    });
  });
  it("rejects more than 7 args", () => {
    expect(() => jsmql.expr("new Date(1, 2, 3, 4, 5, 6, 7, 8)")).toThrow(/at most 7 arguments/);
  });
});

describe("Date.UTC()", () => {
  it("Date.UTC(y, m, d) → $toLong of $dateFromParts with UTC timezone", () => {
    expect(jsmql.expr("Date.UTC(2024, 0, 15)")).toEqual({
      $toLong: { $dateFromParts: { year: 2024, month: 1, day: 15, timezone: "UTC" } },
    });
  });
  it("Date.UTC(y) — year-only form", () => {
    expect(jsmql.expr("Date.UTC(1970)")).toEqual({ $toLong: { $dateFromParts: { year: 1970, timezone: "UTC" } } });
  });
  it("new Date(Date.UTC(...)) peephole: skips $toLong round-trip", () => {
    expect(jsmql.expr("new Date(Date.UTC(2024, 0, 15))")).toEqual({
      $dateFromParts: { year: 2024, month: 1, day: 15, timezone: "UTC" },
    });
  });
  it("Date.UTC requires at least 1 arg", () => {
    expect(() => jsmql.expr("Date.UTC()")).toThrow(/Date\.UTC.*takes 1 to 7 arguments/);
  });
  it("Date.UTC rejects more than 7 args", () => {
    expect(() => jsmql.expr("Date.UTC(1,2,3,4,5,6,7,8)")).toThrow(/takes 1 to 7 arguments/);
  });
});

describe("type casts", () => {
  it("Number()", () => {
    expect(jsmql.expr("Number($.str)")).toEqual({ $toDouble: "$str" });
  });
  it("String()", () => {
    expect(jsmql.expr("String($.n)")).toEqual({ $toString: "$n" });
  });
  it("Boolean() uses JS truthy semantics (not MQL's $toBool)", () => {
    expect(jsmql.expr("Boolean($.x)")).toEqual(truthy("$x"));
  });
  it("Boolean() on a provably-bool value elides the wrap", () => {
    expect(jsmql.expr("Boolean($.x > 0)")).toEqual({ $gt: ["$x", 0] });
  });
  it("$toBool() direct operator escape preserves raw MongoDB semantics", () => {
    expect(jsmql.expr("$toBool($.x)")).toEqual({ $toBool: "$x" });
  });
  it("parseInt()", () => {
    expect(jsmql.expr("parseInt($.s)")).toEqual({ $toInt: "$s" });
  });
  it("parseFloat()", () => {
    expect(jsmql.expr("parseFloat($.s)")).toEqual({ $toDouble: "$s" });
  });
});

describe("Math.*", () => {
  it("Math.abs", () => {
    expect(jsmql.expr("Math.abs($.x)")).toEqual({ $abs: "$x" });
  });
  it("Math.ceil", () => {
    expect(jsmql.expr("Math.ceil($.x)")).toEqual({ $ceil: "$x" });
  });
  it("Math.floor", () => {
    expect(jsmql.expr("Math.floor($.x)")).toEqual({ $floor: "$x" });
  });
  it("Math.round adds 0 precision", () => {
    expect(jsmql.expr("Math.round($.x)")).toEqual({ $round: ["$x", 0] });
  });
  it("Math.pow", () => {
    expect(jsmql.expr("Math.pow(2, $.n)")).toEqual({ $pow: [2, "$n"] });
  });
  it("Math.sqrt", () => {
    expect(jsmql.expr("Math.sqrt($.x)")).toEqual({ $sqrt: "$x" });
  });
  it("Math.exp", () => {
    expect(jsmql.expr("Math.exp($.x)")).toEqual({ $exp: "$x" });
  });
  it("Math.log (natural log → $ln)", () => {
    expect(jsmql.expr("Math.log($.x)")).toEqual({ $ln: "$x" });
  });
  it("Math.trunc", () => {
    expect(jsmql.expr("Math.trunc($.x)")).toEqual({ $trunc: "$x" });
  });
});

describe("Math trigonometry", () => {
  it("Math.sin", () => {
    expect(jsmql.expr("Math.sin($.angle)")).toEqual({ $sin: "$angle" });
  });
  it("Math.cos", () => {
    expect(jsmql.expr("Math.cos($.angle)")).toEqual({ $cos: "$angle" });
  });
  it("Math.tan", () => {
    expect(jsmql.expr("Math.tan($.angle)")).toEqual({ $tan: "$angle" });
  });
  it("Math.asin", () => {
    expect(jsmql.expr("Math.asin($.x)")).toEqual({ $asin: "$x" });
  });
  it("Math.acos", () => {
    expect(jsmql.expr("Math.acos($.x)")).toEqual({ $acos: "$x" });
  });
  it("Math.atan", () => {
    expect(jsmql.expr("Math.atan($.x)")).toEqual({ $atan: "$x" });
  });
  it("Math.atan2", () => {
    expect(jsmql.expr("Math.atan2($.y, $.x)")).toEqual({ $atan2: ["$y", "$x"] });
  });
  it("Math.atan2 wrong arity", () => {
    expect(() => jsmql.expr("Math.atan2($.x)")).toThrow(/exactly 2 arguments/);
  });
  it("Math.sinh", () => {
    expect(jsmql.expr("Math.sinh($.x)")).toEqual({ $sinh: "$x" });
  });
  it("Math.cosh", () => {
    expect(jsmql.expr("Math.cosh($.x)")).toEqual({ $cosh: "$x" });
  });
  it("Math.tanh", () => {
    expect(jsmql.expr("Math.tanh($.x)")).toEqual({ $tanh: "$x" });
  });
  it("Math.asinh", () => {
    expect(jsmql.expr("Math.asinh($.x)")).toEqual({ $asinh: "$x" });
  });
  it("Math.acosh", () => {
    expect(jsmql.expr("Math.acosh($.x)")).toEqual({ $acosh: "$x" });
  });
  it("Math.atanh", () => {
    expect(jsmql.expr("Math.atanh($.x)")).toEqual({ $atanh: "$x" });
  });
});

describe("bitwise infix operators", () => {
  it("a & b", () => {
    expect(jsmql.expr("$.a & $.b")).toEqual({ $bitAnd: ["$a", "$b"] });
  });
  it("a | b", () => {
    expect(jsmql.expr("$.a | $.b")).toEqual({ $bitOr: ["$a", "$b"] });
  });
  it("a ^ b", () => {
    expect(jsmql.expr("$.a ^ $.b")).toEqual({ $bitXor: ["$a", "$b"] });
  });
  it("~a", () => {
    expect(jsmql.expr("~$.a")).toEqual({ $bitNot: "$a" });
  });
  it("a & b & c flattens", () => {
    expect(jsmql.expr("$.a & $.b & $.c")).toEqual({ $bitAnd: ["$a", "$b", "$c"] });
  });
  it("a | b | c flattens", () => {
    expect(jsmql.expr("$.a | $.b | $.c")).toEqual({ $bitOr: ["$a", "$b", "$c"] });
  });
  it("a ^ b ^ c flattens", () => {
    expect(jsmql.expr("$.a ^ $.b ^ $.c")).toEqual({ $bitXor: ["$a", "$b", "$c"] });
  });
  it("(a & b) | c precedence: & binds tighter than |", () => {
    expect(jsmql.expr("$.a & $.b | $.c")).toEqual({ $bitOr: [{ $bitAnd: ["$a", "$b"] }, "$c"] });
  });
  it("(a ^ b) | c precedence: ^ binds tighter than |", () => {
    expect(jsmql.expr("$.a ^ $.b | $.c")).toEqual({ $bitOr: [{ $bitXor: ["$a", "$b"] }, "$c"] });
  });
  it("(a & b) ^ c precedence: & binds tighter than ^", () => {
    expect(jsmql.expr("$.a & $.b ^ $.c")).toEqual({ $bitXor: [{ $bitAnd: ["$a", "$b"] }, "$c"] });
  });
  it("&& binds looser than | (so a | b && c → (a | b) && c)", () => {
    // LHS `$.a | $.b` is non-pure-ref → $let binds it once for the cond chain.
    expect(jsmql.expr("$.a | $.b && $.c")).toEqual({
      $let: { vars: { _v: { $bitOr: ["$a", "$b"] } }, in: { $cond: [truthy("$$_v"), "$c", "$$_v"] } },
    });
  });
  it("=== binds tighter than & (so a === b & c → (a === b) & c)", () => {
    expect(jsmql.expr("$.a === $.b & $.c")).toEqual({ $bitAnd: [{ $eq: ["$a", "$b"] }, "$c"] });
  });
  it("unary ~ has higher precedence than &", () => {
    expect(jsmql.expr("~$.flags & 255")).toEqual({ $bitAnd: [{ $bitNot: "$flags" }, 255] });
  });
});

describe("Object.*", () => {
  it("Object.keys", () => {
    expect(jsmql.expr("Object.keys($.doc)")).toEqual({
      $map: { input: { $objectToArray: "$doc" }, as: "kv", in: "$$kv.k" },
    });
  });
  it("Object.values", () => {
    expect(jsmql.expr("Object.values($.doc)")).toEqual({
      $map: { input: { $objectToArray: "$doc" }, as: "kv", in: "$$kv.v" },
    });
  });
  it("Object.entries", () => {
    expect(jsmql.expr("Object.entries($.doc)")).toEqual({ $objectToArray: "$doc" });
  });
  it("Object.assign (2 args)", () => {
    expect(jsmql.expr("Object.assign($.a, $.b)")).toEqual({ $mergeObjects: ["$a", "$b"] });
  });
  it("Object.assign (3 args)", () => {
    expect(jsmql.expr("Object.assign($.a, $.b, $.c)")).toEqual({ $mergeObjects: ["$a", "$b", "$c"] });
  });
});

describe("$let with lambda", () => {
  it("single var lambda", () => {
    expect(jsmql.expr("$let({ d: $.price * 0.1 }, (d) => $.price - d)")).toEqual({
      $let: { vars: { d: { $multiply: ["$price", 0.1] } }, in: { $subtract: ["$price", "$$d"] } },
    });
  });
});

describe("immutable array methods", () => {
  it(".toSorted() with no comparator → ascending", () => {
    expect(jsmql.expr("$.scores.toSorted()")).toEqual({ $sortArray: { input: "$scores", sortBy: 1 } });
  });
  it(".toSorted with comparator throws helpful error", () => {
    expect(() => jsmql.expr("$.scores.toSorted((a, b) => a - b)")).toThrow(/comparator-style/);
  });
  it(".toReversed() is array-context", () => {
    expect(jsmql.expr("$.items.toReversed()")).toEqual({ $reverseArray: "$items" });
  });
  it(".toReversed() chainable with .map()", () => {
    expect(jsmql.expr("$.items.toReversed().map(x => x.name)")).toEqual({
      $map: { input: { $reverseArray: "$items" }, as: "x", in: "$$x.name" },
    });
  });
  it(".findLast(p) returns last matching element (predicate body wrapped in jsBool)", () => {
    expect(jsmql.expr("$.items.findLast(x => x.active)")).toEqual({
      $arrayElemAt: [{ $filter: { input: "$items", as: "x", cond: truthy("$$x.active") } }, -1],
    });
  });
  it(".findLastIndex(p) reduces (idx, el) pairs (predicate body wrapped in jsBool)", () => {
    expect(jsmql.expr("$.items.findLastIndex(x => x.active)")).toEqual({
      $reduce: {
        input: { $zip: { inputs: [{ $range: [0, { $size: "$items" }] }, "$items"] } },
        initialValue: -1,
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$this", 1] } },
            in: { $cond: [truthy("$$x.active"), { $arrayElemAt: ["$$this", 0] }, "$$value"] },
          },
        },
      },
    });
  });
});

describe("array method additions", () => {
  it(".findIndex(p) returns the first matching index (zipped reduce with -1 guard)", () => {
    expect(jsmql.expr("$.items.findIndex(x => x.active)")).toEqual({
      $reduce: {
        input: { $zip: { inputs: [{ $range: [0, { $size: "$items" }] }, "$items"] } },
        initialValue: -1,
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$this", 1] } },
            in: {
              $cond: [
                { $and: [{ $eq: ["$$value", -1] }, truthy("$$x.active")] },
                { $arrayElemAt: ["$$this", 0] },
                "$$value",
              ],
            },
          },
        },
      },
    });
  });
  it(".lastIndexOf(x) reverses, finds, normalises back to original index", () => {
    expect(jsmql.expr("$.items.lastIndexOf(42)")).toEqual({
      $let: {
        vars: { jsmqlArr: "$items" },
        in: {
          $let: {
            vars: { jsmqlRevIdx: { $indexOfArray: [{ $reverseArray: "$$jsmqlArr" }, 42] } },
            in: {
              $cond: [
                { $eq: ["$$jsmqlRevIdx", -1] },
                -1,
                { $subtract: [{ $subtract: [{ $size: "$$jsmqlArr" }, 1] }, "$$jsmqlRevIdx"] },
              ],
            },
          },
        },
      },
    });
  });
  it(".lastIndexOf on a known string receiver throws", () => {
    expect(() => jsmql.expr('$.s.toLowerCase().lastIndexOf("x")')).toThrow(/forward-only/);
  });
  it(".reduceRight(fn, init) reverses the input array", () => {
    expect(jsmql.expr("$.xs.reduceRight((acc, x) => acc + x, 0)")).toEqual({
      $reduce: { input: { $reverseArray: "$xs" }, initialValue: 0, in: { $add: ["$$value", "$$this"] } },
    });
  });
  it(".toSpliced(s, dc, ...items) builds a 3-piece $concatArrays", () => {
    expect(jsmql.expr('$.xs.toSpliced(1, 2, "a", "b")')).toEqual({
      $let: {
        vars: { jsmqlArr: "$xs", jsmqlStart: 1 },
        in: {
          $let: {
            vars: { jsmqlTailStart: { $add: ["$$jsmqlStart", 2] } },
            in: {
              $concatArrays: [
                { $slice: ["$$jsmqlArr", 0, "$$jsmqlStart"] },
                ["a", "b"],
                {
                  $slice: [
                    "$$jsmqlArr",
                    "$$jsmqlTailStart",
                    { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }] },
                  ],
                },
              ],
            },
          },
        },
      },
    });
  });
  it(".toSpliced(s) with no deleteCount removes to end", () => {
    expect(jsmql.expr("$.xs.toSpliced(2)")).toEqual({
      $let: {
        vars: { jsmqlArr: "$xs", jsmqlStart: 2 },
        in: {
          $let: {
            vars: { jsmqlTailStart: "$$jsmqlStart" },
            in: {
              $concatArrays: [
                { $slice: ["$$jsmqlArr", 0, "$$jsmqlStart"] },
                [],
                {
                  $slice: [
                    "$$jsmqlArr",
                    "$$jsmqlTailStart",
                    { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, "$$jsmqlTailStart"] }] },
                  ],
                },
              ],
            },
          },
        },
      },
    });
  });
  it(".toSpliced with negative start literal throws", () => {
    expect(() => jsmql.expr("$.xs.toSpliced(-1, 1)")).toThrow(/negative start/);
  });
  it(".with(i, v) replaces an element by index", () => {
    expect(jsmql.expr("$.xs.with(1, 99)")).toEqual({
      $let: {
        vars: { jsmqlArr: "$xs", jsmqlIdx: 1, jsmqlVal: 99 },
        in: {
          $concatArrays: [
            { $slice: ["$$jsmqlArr", 0, "$$jsmqlIdx"] },
            ["$$jsmqlVal"],
            {
              $slice: [
                "$$jsmqlArr",
                { $add: ["$$jsmqlIdx", 1] },
                { $max: [0, { $subtract: [{ $size: "$$jsmqlArr" }, { $add: ["$$jsmqlIdx", 1] }] }] },
              ],
            },
          ],
        },
      },
    });
  });
  it(".with with a negative index literal throws", () => {
    expect(() => jsmql.expr("$.xs.with(-1, 9)")).toThrow(/negative index/);
  });
  it(".with arity is enforced (exactly 2)", () => {
    expect(() => jsmql.expr("$.xs.with(0)")).toThrow(/exactly 2 arguments/);
  });
  it(".toString() on a known array lowers to join-with-comma", () => {
    expect(jsmql.expr("$.xs.map(x => x + 1).toString()")).toEqual({
      $reduce: {
        input: { $map: { input: "$xs", as: "x", in: { $add: ["$$x", 1] } } },
        initialValue: "",
        in: {
          $cond: [
            { $eq: ["$$value", ""] },
            { $toString: "$$this" },
            { $concat: ["$$value", ",", { $toString: "$$this" }] },
          ],
        },
      },
    });
  });
  it(".toString() on a known string is a no-op", () => {
    expect(jsmql.expr("$.name.toLowerCase().toString()")).toEqual({ $toLower: "$name" });
  });
  it(".toString() on unknown type lowers to $toString", () => {
    expect(jsmql.expr("$.n.toString()")).toEqual({ $toString: "$n" });
  });
});

describe("array callbacks support (element, index)", () => {
  it(".map((x, i) => …) zips over $range and wraps in $let", () => {
    expect(jsmql.expr("$.xs.map((x, i) => x + i)")).toEqual({
      $map: {
        input: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } },
        as: "jsmqlPair",
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$jsmqlPair", 1] }, i: { $arrayElemAt: ["$$jsmqlPair", 0] } },
            in: { $add: ["$$x", "$$i"] },
          },
        },
      },
    });
  });
  it(".filter((x, i) => cond) filters pairs and projects back to elements", () => {
    expect(jsmql.expr("$.xs.filter((x, i) => i > 0)")).toEqual({
      $map: {
        input: {
          $filter: {
            input: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } },
            as: "jsmqlPair",
            cond: {
              $let: {
                vars: { x: { $arrayElemAt: ["$$jsmqlPair", 1] }, i: { $arrayElemAt: ["$$jsmqlPair", 0] } },
                in: { $gt: ["$$i", 0] },
              },
            },
          },
        },
        as: "jsmqlPair",
        in: { $arrayElemAt: ["$$jsmqlPair", 1] },
      },
    });
  });
  it(".find((x, i) => cond) wraps with double $arrayElemAt", () => {
    expect(jsmql.expr("$.xs.find((x, i) => i === 2)")).toEqual({
      $arrayElemAt: [
        {
          $arrayElemAt: [
            {
              $filter: {
                input: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } },
                as: "jsmqlPair",
                cond: {
                  $let: {
                    vars: { x: { $arrayElemAt: ["$$jsmqlPair", 1] }, i: { $arrayElemAt: ["$$jsmqlPair", 0] } },
                    in: { $eq: ["$$i", 2] },
                  },
                },
              },
            },
            0,
          ],
        },
        1,
      ],
    });
  });
  it(".some((x, i) => cond) wraps the body in $let", () => {
    expect(jsmql.expr("$.xs.some((x, i) => i > 5)")).toEqual({
      $anyElementTrue: {
        $map: {
          input: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } },
          as: "jsmqlPair",
          in: {
            $let: {
              vars: { x: { $arrayElemAt: ["$$jsmqlPair", 1] }, i: { $arrayElemAt: ["$$jsmqlPair", 0] } },
              in: { $gt: ["$$i", 5] },
            },
          },
        },
      },
    });
  });
  it(".findIndex((x, i) => …) binds both params in $let.vars", () => {
    expect(jsmql.expr("$.xs.findIndex((x, i) => x === i)")).toEqual({
      $reduce: {
        input: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } },
        initialValue: -1,
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$this", 1] }, i: { $arrayElemAt: ["$$this", 0] } },
            in: {
              $cond: [
                { $and: [{ $eq: ["$$value", -1] }, { $eq: ["$$x", "$$i"] }] },
                { $arrayElemAt: ["$$this", 0] },
                "$$value",
              ],
            },
          },
        },
      },
    });
  });
  it(".reduce((acc, x, i) => …, init) zips input and rebinds in $let", () => {
    expect(jsmql.expr("$.xs.reduce((acc, x, i) => acc + x * i, 0)")).toEqual({
      $reduce: {
        input: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } },
        initialValue: 0,
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$this", 1] }, i: { $arrayElemAt: ["$$this", 0] } },
            in: { $add: ["$$value", { $multiply: ["$$x", "$$i"] }] },
          },
        },
      },
    });
  });
  it(".reduceRight((acc, x, i) => …, init) reverses the zipped pairs", () => {
    expect(jsmql.expr("$.xs.reduceRight((acc, x, i) => acc + i, 0)")).toEqual({
      $reduce: {
        input: { $reverseArray: { $zip: { inputs: [{ $range: [0, { $size: "$xs" }] }, "$xs"] } } },
        initialValue: 0,
        in: {
          $let: {
            vars: { x: { $arrayElemAt: ["$$this", 1] }, i: { $arrayElemAt: ["$$this", 0] } },
            in: { $add: ["$$value", "$$i"] },
          },
        },
      },
    });
  });
  it(".map with 3 params throws", () => {
    expect(() => jsmql.expr("$.xs.map((x, i, arr) => x)")).toThrow(/at most 2 parameters/);
  });
  it(".filter with 3 params throws", () => {
    expect(() => jsmql.expr("$.xs.filter((x, i, arr) => true)")).toThrow(/at most 2 parameters/);
  });
  it(".findIndex with 3 params throws", () => {
    expect(() => jsmql.expr("$.xs.findIndex((x, i, arr) => true)")).toThrow(/at most 2 parameters/);
  });
  it(".reduce with 4 params throws", () => {
    expect(() => jsmql.expr("$.xs.reduce((acc, x, i, arr) => acc, 0)")).toThrow(/2 or 3 parameters/);
  });
});

describe("mutator DX shims (expression position rejects mutators)", () => {
  it(".sort() points at .toSorted() and statement position", () => {
    expect(() => jsmql.expr("$.xs.sort()")).toThrow(/\.toSorted\(\)/);
    expect(() => jsmql.expr("$.xs.sort()")).toThrow(/mutates|statement position/);
  });
  it(".reverse() points at .toReversed() and statement position", () => {
    expect(() => jsmql.expr("$.xs.reverse()")).toThrow(/\.toReversed\(\)/);
    expect(() => jsmql.expr("$.xs.reverse()")).toThrow(/mutates|statement position/);
  });
  it(".splice() points at .toSpliced()", () => {
    expect(() => jsmql.expr("$.xs.splice(1, 2)")).toThrow(/\.toSpliced/);
  });
  it(".push() points at .concat() / spread", () => {
    expect(() => jsmql.expr("$.xs.push(1)")).toThrow(/\.concat\(x\)|spread/);
  });
  it(".pop() points at .at(-1) / .slice(0, -1)", () => {
    expect(() => jsmql.expr("$.xs.pop()")).toThrow(/\.at\(-1\)/);
  });
  it(".shift() points at .at(0) / .slice(1)", () => {
    expect(() => jsmql.expr("$.xs.shift()")).toThrow(/\.at\(0\)/);
  });
  it(".unshift() points at .concat() / spread", () => {
    expect(() => jsmql.expr("$.xs.unshift(1)")).toThrow(/\.concat\(\)|newItems/);
  });
  it(".fill() throws with a workaround hint", () => {
    expect(() => jsmql.expr("$.xs.fill(0)")).toThrow(/immutable|statement position/);
  });
  it(".copyWithin() throws with a workaround hint", () => {
    expect(() => jsmql.expr("$.xs.copyWithin(0, 1)")).toThrow(/immutable/);
  });
});

describe("toSorted / sort key function", () => {
  it(".toSorted(x => x.path) → ascending sortBy by that field", () => {
    expect(jsmql.expr("$.events.toSorted(e => e.distance)")).toEqual({
      $sortArray: { input: "$events", sortBy: { distance: 1 } },
    });
  });
  it(".toSorted(x => -x.path) → descending sortBy", () => {
    expect(jsmql.expr("$.events.toSorted(e => -e.distance)")).toEqual({
      $sortArray: { input: "$events", sortBy: { distance: -1 } },
    });
  });
  it(".toSorted with nested key path", () => {
    expect(jsmql.expr("$.events.toSorted(e => e.user.name)")).toEqual({
      $sortArray: { input: "$events", sortBy: { "user.name": 1 } },
    });
  });
  it(".toSorted(keyFn) chains with .slice(-10) (the README example)", () => {
    expect(jsmql.expr("$.events.toSorted(e => e.distance).slice(-10)")).toEqual({
      $slice: [{ $sortArray: { input: "$events", sortBy: { distance: 1 } } }, -10],
    });
  });
  it(".toSorted with 2-param (comparator) lambda is rejected", () => {
    expect(() => jsmql.expr("$.events.toSorted((a, b) => a.x - b.x)")).toThrow(/comparator-style/);
  });
  it(".toSorted with non-key-function body is rejected", () => {
    expect(() => jsmql.expr("$.events.toSorted(e => e.x + e.y)")).toThrow(/key function body/);
  });
  it(".toSorted with bare param (x => x) is rejected", () => {
    expect(() => jsmql.expr("$.events.toSorted(e => e)")).toThrow(/key function body/);
  });
});

describe("statement-position mutators", () => {
  it(".sort() — 0-arg ascending", () => {
    expect(jsmql("$.events.sort();")).toEqual([{ $set: { events: { $sortArray: { input: "$events", sortBy: 1 } } } }]);
  });
  it(".sort(keyFn) — desugars to $set with $sortArray sortBy", () => {
    expect(jsmql("$.events.sort(e => e.distance);")).toEqual([
      { $set: { events: { $sortArray: { input: "$events", sortBy: { distance: 1 } } } } },
    ]);
  });
  it(".reverse() — desugars to $set with $reverseArray", () => {
    expect(jsmql("$.events.reverse();")).toEqual([{ $set: { events: { $reverseArray: "$events" } } }]);
  });
  it(".push(item) — appends a single element with $concatArrays + array wrap", () => {
    expect(jsmql("$.events.push($.newEvent);")).toEqual([
      { $set: { events: { $concatArrays: ["$events", ["$newEvent"]] } } },
    ]);
  });
  it(".push(a, b) — appends multiple elements", () => {
    expect(jsmql("$.tags.push('a', 'b');")).toEqual([{ $set: { tags: { $concatArrays: ["$tags", ["a", "b"]] } } }]);
  });
  it(".unshift(a, b) — prepends with items-first", () => {
    expect(jsmql("$.events.unshift($.x, $.y);")).toEqual([
      { $set: { events: { $concatArrays: [["$x", "$y"], "$events"] } } },
    ]);
  });
  it(".pop() — drops last element with $slice and a clamp", () => {
    expect(jsmql("$.events.pop();")).toEqual([
      { $set: { events: { $slice: ["$events", 0, { $max: [0, { $subtract: [{ $size: "$events" }, 1] }] }] } } },
    ]);
  });
  it(".shift() — drops first element with $slice", () => {
    expect(jsmql("$.events.shift();")).toEqual([
      { $set: { events: { $slice: ["$events", 1, { $size: "$events" }] } } },
    ]);
  });
  it(".splice(s, dc, ...items) — delegates to the .toSpliced shape inside $set", () => {
    const out = jsmql("$.events.splice(0, 2, 99);") as Array<Record<string, unknown>>;
    const eventsValue = (out[0]?.$set as { events: unknown }).events as Record<string, unknown>;
    expect(Object.keys(eventsValue)).toEqual(["$let"]);
  });
  it(".fill(v) — every element becomes v via $map", () => {
    expect(jsmql("$.events.fill(0);")).toEqual([
      { $set: { events: { $map: { input: "$events", as: "__jsmql_unused", in: 0 } } } },
    ]);
  });
  it(".fill(v, s, e) with non-negative literals — IIFE bindings inline the literals (no normalisation $cond)", () => {
    const out = jsmql("$.events.fill(0, 1, 3);") as Array<Record<string, unknown>>;
    const setVal = (out[0]?.$set as { events: unknown }).events as { $let: { vars: Record<string, unknown> } };
    expect(setVal.$let.vars).toEqual({ __jsmql_s0: 1, __jsmql_e0: 3 });
  });
  it(".reverse() with extra args is rejected (preserves the existing .toReversed arg-count check)", () => {
    expect(() => jsmql("$.events.reverse(123);")).toThrow();
  });
  it("nested receiver $.user.history.push(...) emits a dotted $set key", () => {
    expect(jsmql("$.user.history.push($.e);")).toEqual([
      { $set: { "user.history": { $concatArrays: ["$user.history", ["$e"]] } } },
    ]);
  });
  it("top-level mutator without a trailing `;` auto-wraps into Pipeline mode", () => {
    expect(jsmql("$.events.push($.x)")).toEqual([{ $set: { events: { $concatArrays: ["$events", ["$x"]] } } }]);
  });
  it("expression-position mutator still throws (not auto-rewritten inside a larger expression)", () => {
    expect(() => jsmql.expr("$.events.sort().slice(-10)")).toThrow(/\.sort\(\) mutates/);
  });
  it("expression-position .push in a $project body throws", () => {
    expect(() => jsmql.expr("$.events.push(x)")).toThrow(/\.push\(\) mutates/);
  });
  it("two writes to the same field split into two $set stages (read-after-write)", () => {
    // The second .sort reads $events (which was just written), so the
    // coalescer correctly splits — same logic as explicit `=` chains.
    expect(jsmql(`$.events.push($.newEvent); $.events.sort(e => e.distance);`)).toEqual([
      { $set: { events: { $concatArrays: ["$events", ["$newEvent"]] } } },
      { $set: { events: { $sortArray: { input: "$events", sortBy: { distance: 1 } } } } },
    ]);
  });
  it("mutator inside a [...] pipeline literal also rewrites", () => {
    expect(jsmql.pipeline("[{ $match: { active: true } }, $.events.sort()]")).toEqual([
      { $match: { active: true } },
      { $set: { events: { $sortArray: { input: "$events", sortBy: 1 } } } },
    ]);
  });
});

describe("iterator / void / locale DX shims", () => {
  it(".forEach() explains the no-return-value problem", () => {
    expect(() => jsmql.expr("$.xs.forEach(x => x)")).toThrow(/undefined/);
  });
  it(".entries() suggests .map((v, i) => [i, v])", () => {
    expect(() => jsmql.expr("$.xs.entries()")).toThrow(/\[index, value\]|\[i, v\]/);
  });
  it(".keys() suggests $range/$size", () => {
    expect(() => jsmql.expr("$.xs.keys()")).toThrow(/\$range|\$size/);
  });
  it(".values() explains the array is already the value sequence", () => {
    expect(() => jsmql.expr("$.xs.values()")).toThrow(/value sequence|iterator/);
  });
  it(".toLocaleString() explains the locale problem", () => {
    expect(() => jsmql.expr("$.xs.toLocaleString()")).toThrow(/locale/);
  });
});

describe("ES2025 Set methods", () => {
  it("intersection", () => {
    expect(jsmql.expr("new Set($.a).intersection(new Set($.b))")).toEqual({ $setIntersection: ["$a", "$b"] });
  });
  it("union", () => {
    expect(jsmql.expr("new Set($.a).union(new Set($.b))")).toEqual({ $setUnion: ["$a", "$b"] });
  });
  it("difference", () => {
    expect(jsmql.expr("new Set($.a).difference(new Set($.b))")).toEqual({ $setDifference: ["$a", "$b"] });
  });
  it("isSubsetOf", () => {
    expect(jsmql.expr("new Set($.a).isSubsetOf(new Set($.b))")).toEqual({ $setIsSubset: ["$a", "$b"] });
  });
  it("isSupersetOf swaps args", () => {
    expect(jsmql.expr("new Set($.a).isSupersetOf(new Set($.b))")).toEqual({ $setIsSubset: ["$b", "$a"] });
  });
  it("works with array literals", () => {
    expect(jsmql.expr("new Set([1, 2, 3]).intersection(new Set([2, 3, 4]))")).toEqual({
      $setIntersection: [
        [1, 2, 3],
        [2, 3, 4],
      ],
    });
  });
  it("symmetricDifference throws helpful error", () => {
    expect(() => jsmql.expr("new Set($.a).symmetricDifference(new Set($.b))")).toThrow(/no MongoDB equivalent/);
  });
  it("non-Set argument is rejected", () => {
    expect(() => jsmql.expr("new Set($.a).intersection($.b)")).toThrow(/must be a 'new Set/);
  });
});

describe("regex method variants", () => {
  it("/re/.test(str)", () => {
    expect(jsmql.expr("/[a-z]+/.test($.s)")).toEqual({ $regexMatch: { input: "$s", regex: "[a-z]+" } });
  });
  it("/re/flags.test(str) preserves flags", () => {
    expect(jsmql.expr("/PAT/i.test($.s)")).toEqual({ $regexMatch: { input: "$s", regex: "PAT", options: "i" } });
  });
  it("/re/.exec(str)", () => {
    expect(jsmql.expr("/word/.exec($.s)")).toEqual({ $regexFind: { input: "$s", regex: "word" } });
  });
  it("str.matchAll(/re/g)", () => {
    expect(jsmql.expr("$.s.matchAll(/word/g)")).toEqual({
      $regexFindAll: { input: "$s", regex: "word", options: "g" },
    });
  });
  it("matchAll without g flag throws", () => {
    expect(() => jsmql.expr("$.s.matchAll(/word/)")).toThrow(/'g' flag/);
  });
  it("str.search(/re/) returns idx with -1 fallback", () => {
    expect(jsmql.expr("$.s.search(/foo/)")).toEqual({
      $ifNull: [{ $getField: { field: "idx", input: { $regexFind: { input: "$s", regex: "foo" } } } }, -1],
    });
  });
});

describe("Number static predicates", () => {
  it("Number.isInteger(x)", () => {
    expect(jsmql.expr("Number.isInteger($.n)")).toEqual({
      $cond: [
        { $in: [{ $type: "$n" }, ["int", "long"]] },
        true,
        { $cond: [{ $in: [{ $type: "$n" }, ["double", "decimal"]] }, { $eq: ["$n", { $trunc: "$n" }] }, false] },
      ],
    });
  });
  it("Number.isNaN(x)", () => {
    expect(jsmql.expr("Number.isNaN($.x)")).toEqual({ $ne: ["$x", "$x"] });
  });
  it("Number.isFinite(x) throws helpful error", () => {
    expect(() => jsmql.expr("Number.isFinite($.x)")).toThrow(/no syntax for Infinity/);
  });
});

describe("string padding methods", () => {
  it("padStart with explicit char", () => {
    expect(jsmql.expr('$.code.padStart(5, "0")')).toEqual({
      $let: {
        vars: { s: "$code" },
        in: {
          $cond: [
            { $gte: [{ $strLenCP: "$$s" }, 5] },
            "$$s",
            {
              $concat: [
                {
                  $reduce: {
                    input: { $range: [0, { $subtract: [5, { $strLenCP: "$$s" }] }] },
                    initialValue: "",
                    in: { $concat: ["$$value", "0"] },
                  },
                },
                "$$s",
              ],
            },
          ],
        },
      },
    });
  });
  it("padStart defaults to space", () => {
    const out = jsmql.expr("$.s.padStart(10)") as Record<string, unknown>;
    // Spot-check: pad string should be a space
    expect(JSON.stringify(out)).toContain('"in":{"$concat":["$$value"," "]}');
  });
  it("padEnd order is str-then-pad", () => {
    const out = jsmql.expr('$.s.padEnd(10, "-")') as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain('["$$s",{"$reduce"');
  });
  it("repeat", () => {
    expect(jsmql.expr('"-".repeat(5)')).toEqual({
      $reduce: { input: { $range: [0, 5] }, initialValue: "", in: { $concat: ["$$value", "-"] } },
    });
  });
});

describe("Array.from({length, ...})", () => {
  it("no map function returns $range", () => {
    expect(jsmql.expr("Array.from({ length: 5 })")).toEqual({ $range: [0, 5] });
  });
  it("with (_, i) => body maps over $range", () => {
    expect(jsmql.expr("Array.from({ length: 3 }, (_, i) => i * 2)")).toEqual({
      $map: { input: { $range: [0, 3] }, as: "i", in: { $let: { vars: { _: null }, in: { $multiply: ["$$i", 2] } } } },
    });
  });
  it("with $.length expression", () => {
    const out = jsmql.expr("Array.from({ length: $.n }, (_, i) => i)") as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain('"$range":[0,"$n"]');
  });
  it("non-{length} input throws", () => {
    expect(() => jsmql.expr("Array.from($.iter)")).toThrow(/{length: n} form/);
  });
  it("requires 2-param map function", () => {
    expect(() => jsmql.expr("Array.from({ length: 3 }, x => x)")).toThrow(/2 parameters/);
  });
});

describe("BigInt literals", () => {
  it("integer with n suffix", () => {
    expect(jsmql.expr("123n")).toEqual({ $toLong: "123" });
  });
  it("zero", () => {
    expect(jsmql.expr("0n")).toEqual({ $toLong: "0" });
  });
  it("rejects fraction with n", () => {
    expect(() => jsmql.expr("1.5n")).toThrow(/Invalid BigInt/);
  });
  it("rejects exponent with n", () => {
    expect(() => jsmql.expr("1e2n")).toThrow(/Invalid BigInt/);
  });
  it("works in arithmetic", () => {
    expect(jsmql.expr("$.timestamp - 1000n")).toEqual({ $subtract: ["$timestamp", { $toLong: "1000" }] });
  });
});

describe("Object.groupBy", () => {
  it("groups by category", () => {
    expect(jsmql.expr("Object.groupBy($.items, x => x.category)")).toEqual({
      $reduce: {
        input: "$items",
        initialValue: {},
        in: {
          $let: {
            vars: { key: { $toString: "$$this.category" } },
            in: {
              $mergeObjects: [
                "$$value",
                {
                  $arrayToObject: [
                    [
                      [
                        "$$key",
                        {
                          $concatArrays: [
                            { $ifNull: [{ $getField: { field: "$$key", input: "$$value" } }, []] },
                            ["$$this"],
                          ],
                        },
                      ],
                    ],
                  ],
                },
              ],
            },
          },
        },
      },
    });
  });
  it("rejects non-lambda discriminator", () => {
    expect(() => jsmql.expr("Object.groupBy($.items, $.f)")).toThrow(/single-parameter arrow function/);
  });
  it("rejects multi-param lambda", () => {
    expect(() => jsmql.expr("Object.groupBy($.items, (a, b) => a)")).toThrow(/single-parameter arrow function/);
  });
});

describe("IIFE → $let", () => {
  it("simple ((x) => body)(value)", () => {
    expect(jsmql.expr("((x) => x + 1)(5)")).toEqual({ $let: { vars: { x: 5 }, in: { $add: ["$$x", 1] } } });
  });
  it("unparen single param (x => body)(value)", () => {
    expect(jsmql.expr("(x => x * 2)($.n)")).toEqual({ $let: { vars: { x: "$n" }, in: { $multiply: ["$$x", 2] } } });
  });
  it("multi-param IIFE binds all params", () => {
    expect(jsmql.expr("((maxAge, minAge) => $.age >= minAge && $.age <= maxAge)(65, 18)")).toEqual({
      $let: {
        vars: { maxAge: 65, minAge: 18 },
        in: { $and: [{ $gte: ["$age", "$$minAge"] }, { $lte: ["$age", "$$maxAge"] }] },
      },
    });
  });
  it("zero-param IIFE", () => {
    expect(jsmql.expr("(() => $.x + $.y)()")).toEqual({ $let: { vars: {}, in: { $add: ["$x", "$y"] } } });
  });
  it("body can reference outer $.fields", () => {
    expect(jsmql.expr("((d) => $.price - d)($.price * 0.1)")).toEqual({
      $let: { vars: { d: { $multiply: ["$price", 0.1] } }, in: { $subtract: ["$price", "$$d"] } },
    });
  });
  it("rejects mismatched arity", () => {
    expect(() => jsmql.expr("((x, y) => x + y)(1)")).toThrow(/expected 2 argument/);
  });
  it("rejects calling a non-lambda", () => {
    expect(() => jsmql.expr("$.func(1, 2)")).toThrow(/Direct call/);
  });
  it("rejects spread args", () => {
    expect(() => jsmql.expr("((x) => x)(...$.arr)")).toThrow(/spread/);
  });
});

describe("string-context + with method calls", () => {
  it("trim() in + chain is string-producing", () => {
    expect(jsmql.expr('$.first.trim() + " " + $.last')).toEqual({
      $concat: [{ $trim: { input: "$first" } }, " ", "$last"],
    });
  });
  it("String() cast in + chain is string-producing", () => {
    expect(jsmql.expr('String($.n) + " items"')).toEqual({ $concat: [{ $toString: "$n" }, " items"] });
  });
  it("typeof in + chain is string-producing", () => {
    expect(jsmql.expr('typeof $.x + " type"')).toEqual({ $concat: [{ $type: "$x" }, " type"] });
  });
});

describe("regex literals (context-sensitive /)", () => {
  it("regex after operator is a literal, not divide", () => {
    expect(jsmql.expr("$.str.match(/[a-z]+/)")).toEqual({ $regexMatch: { input: "$str", regex: "[a-z]+" } });
  });
  it("/ after number is divide", () => {
    expect(jsmql.expr("$.x / 2")).toEqual({ $divide: ["$x", 2] });
  });
  it("regex with multiple flags", () => {
    expect(jsmql.expr("$.str.match(/pattern/gi)")).toEqual({
      $regexMatch: { input: "$str", regex: "pattern", options: "gi" },
    });
  });
});

describe("error cases", () => {
  it("bare identifier outside lambda throws Did you mean", () => {
    expect(() => jsmql.expr("x > 0")).toThrow(/Did you mean/);
  });
  it("unknown method throws with helpful message", () => {
    expect(() => jsmql.expr("$.name.frobulate()")).toThrow(/Unknown method/);
  });
  it("near-miss method names get a 'Did you mean' suggestion", () => {
    expect(() => jsmql.expr("$.name.toLowerCse()")).toThrow(/Did you mean '\.toLowerCase\(\)'/);
    expect(() => jsmql.expr("$.items.fliter(x => x)")).toThrow(/Did you mean '\.filter\(\)'/);
  });
  it("near-miss Math member gets a 'Did you mean' suggestion", () => {
    expect(() => jsmql.expr("Math.flor($.x)")).toThrow(/Did you mean 'Math\.floor'/);
  });
  it("near-miss Number static method gets a 'Did you mean' suggestion", () => {
    expect(() => jsmql.expr("Number.isItneger($.x)")).toThrow(/Did you mean 'Number\.isInteger'/);
  });
  it("near-miss Object method gets a 'Did you mean' suggestion", () => {
    expect(() => jsmql.expr("Object.keyz($.o)")).toThrow(/Did you mean 'Object\.keys'/);
  });
  it("lambda in non-method context throws", () => {
    expect(() => jsmql.expr("$abs(x => x)")).toThrow(/Lambda expression/);
  });
  it("assigning to a method-call result is rejected with a precise message", () => {
    expect(() => jsmql.expr("$.s.trim() = 1")).toThrow(/method-call result/);
  });
  it("assigning to a literal is rejected with a precise message", () => {
    expect(() => jsmql.expr("42 = 1")).toThrow(/literal value/);
  });
});

describe("1-arg substr", () => {
  it("substr(start) slices to end of string", () => {
    expect(jsmql.expr("$.email.substr(1)")).toEqual({ $substrCP: ["$email", 1, { $strLenCP: "$email" }] });
  });
  it("substr(start, count) keeps 2-arg form", () => {
    expect(jsmql.expr("$.name.substr(0, 3)")).toEqual({ $substrCP: ["$name", 0, 3] });
  });
  it("substr with expression start", () => {
    expect(jsmql.expr("$.email.substr($.headerLength + 1)")).toEqual({
      $substrCP: ["$email", { $add: ["$headerLength", 1] }, { $strLenCP: "$email" }],
    });
  });
});

describe(".slice on strings", () => {
  it("string literal receiver → $substrCP", () => {
    expect(jsmql.expr('"hello".slice(1, 3)')).toEqual({ $substrCP: ["hello", 1, 2] });
  });
  it("string-typed receiver (toLowerCase result) → $substrCP", () => {
    expect(jsmql.expr("$.name.toLowerCase().slice(0, 3)")).toEqual({ $substrCP: [{ $toLower: "$name" }, 0, 3] });
  });
  it("1-arg form on string → from start to end", () => {
    expect(jsmql.expr('"hello".slice(2)')).toEqual({
      $substrCP: ["hello", 2, { $subtract: [{ $strLenCP: "hello" }, 2] }],
    });
  });
  it("negative-literal start on string → folded to strLen - n", () => {
    expect(jsmql.expr('"hello".slice(-3)')).toEqual({
      $substrCP: ["hello", { $subtract: [{ $strLenCP: "hello" }, 3] }, 3],
    });
  });
  it("negative end on string → strLen - n", () => {
    expect(jsmql.expr('"hello".slice(1, -1)')).toEqual({
      $substrCP: ["hello", 1, { $max: [0, { $subtract: [{ $subtract: [{ $strLenCP: "hello" }, 1] }, 1] }] }],
    });
  });
  it("non-literal index on string → runtime $cond normalises sign", () => {
    expect(jsmql.expr("String($.s).slice($.i)")).toEqual({
      $substrCP: [
        { $toString: "$s" },
        { $cond: [{ $lt: ["$i", 0] }, { $add: ["$i", { $strLenCP: { $toString: "$s" } }] }, "$i"] },
        {
          $subtract: [
            { $strLenCP: { $toString: "$s" } },
            { $cond: [{ $lt: ["$i", 0] }, { $add: ["$i", { $strLenCP: { $toString: "$s" } }] }, "$i"] },
          ],
        },
      ],
    });
  });
  it("slice() with no args is identity on string", () => {
    expect(jsmql.expr('"hello".slice()')).toEqual("hello");
  });
});

describe(".substring", () => {
  it("substring(start, end) folds end - start as a length", () => {
    expect(jsmql.expr("$.name.substring(2, 7)")).toEqual({ $substrCP: ["$name", 2, 5] });
  });
  it("substring(start) slices to end of string", () => {
    expect(jsmql.expr("$.email.substring(1)")).toEqual({
      $substrCP: ["$email", 1, { $subtract: [{ $strLenCP: "$email" }, 1] }],
    });
  });
  it("substring() with no args is identity", () => {
    expect(jsmql.expr("$.name.substring()")).toEqual("$name");
  });
  it("substring with non-literal start clamps to 0 via $max", () => {
    expect(jsmql.expr("$.s.substring($.i, 10)")).toEqual({
      $substrCP: ["$s", { $max: [0, "$i"] }, { $max: [0, { $subtract: [10, { $max: [0, "$i"] }] }] }],
    });
  });
  it("substring with negative literal clamps at compile time", () => {
    expect(jsmql.expr("$.name.substring(-3, 4)")).toEqual({ $substrCP: ["$name", 0, 4] });
  });
});

describe("comparison precedence: relational higher than equality", () => {
  it("a < b === true parses as (a < b) === true", () => {
    expect(jsmql.expr("$.a < $.b === true")).toEqual({ $eq: [{ $lt: ["$a", "$b"] }, true] });
  });
  it("a > 0 === b > 0 parses as (a > 0) === (b > 0)", () => {
    expect(jsmql.expr("$.a > 0 === $.b > 0")).toEqual({ $eq: [{ $gt: ["$a", 0] }, { $gt: ["$b", 0] }] });
  });
  it("simple relational still works", () => {
    expect(jsmql.expr("$.x < 5")).toEqual({ $lt: ["$x", 5] });
  });
  it("simple equality still works", () => {
    expect(jsmql.expr("$.x === 5")).toEqual({ $eq: ["$x", 5] });
  });
});

describe("in operator RHS validation", () => {
  it("throws on string RHS", () => {
    expect(() => jsmql.expr('$.x in "abc"')).toThrow(/Right-hand side of 'in'/);
  });
  it("throws on number RHS", () => {
    expect(() => jsmql.expr("$.x in 42")).toThrow(/Right-hand side of 'in'/);
  });
  it("throws on boolean RHS", () => {
    expect(() => jsmql.expr("$.x in true")).toThrow(/Right-hand side of 'in'/);
  });
  it("throws on null RHS", () => {
    expect(() => jsmql.expr("$.x in null")).toThrow(/Right-hand side of 'in'/);
  });
  it("accepts array literal RHS", () => {
    expect(jsmql.expr('$.x in ["a", "b"]')).toEqual({ $in: ["$x", ["a", "b"]] });
  });
  it("object literal RHS → property-existence (JS-faithful)", () => {
    expect(jsmql.expr("$.x in { a: 1, b: 2 }")).toEqual({ $in: ["$x", ["a", "b"]] });
  });
  it("string-literal LHS works against an object literal", () => {
    expect(jsmql.expr("'a' in { a: 1, b: 2 }")).toEqual({ $in: ["a", ["a", "b"]] });
  });
  it("object literal with computed key emits the key expression", () => {
    expect(jsmql.expr("$.x in { a: 1, [$.dynKey]: 2 }")).toEqual({ $in: ["$x", ["a", "$dynKey"]] });
  });
  it("object literal with spread uses $objectToArray for the spread keys", () => {
    expect(jsmql.expr("$.x in { ...$.base, a: 1 }")).toEqual({
      $in: ["$x", { $concatArrays: [{ $map: { input: { $objectToArray: "$base" }, as: "kv", in: "$$kv.k" } }, ["a"]] }],
    });
  });
  it("object literal with only spread reduces to $objectToArray.k directly", () => {
    expect(jsmql.expr("$.x in { ...$.other }")).toEqual({
      $in: ["$x", { $map: { input: { $objectToArray: "$other" }, as: "kv", in: "$$kv.k" } }],
    });
  });
  it("accepts field ref RHS", () => {
    expect(jsmql.expr("$.x in $.list")).toEqual({ $in: ["$x", "$list"] });
  });
});

describe("EOF error message", () => {
  it("empty string gives Unexpected end of expression", () => {
    expect(() => jsmql.expr("")).toThrow(/Unexpected end of expression/);
  });
  it("trailing operator gives Unexpected end of expression", () => {
    expect(() => jsmql.expr("$.a &&")).toThrow(/Unexpected end of expression/);
  });
  it("incomplete ternary gives Unexpected end of expression", () => {
    expect(() => jsmql.expr("$.a ? $.b")).toThrow(/Expected ':'/);
  });
});

describe("template literals", () => {
  it("plain string template (no expressions)", () => {
    expect(jsmql.expr("`hello`")).toEqual("hello");
  });
  it("single interpolation", () => {
    // FieldRef has unknown runtime type → wrapped in $toString to match JS coercion semantics.
    expect(jsmql.expr("`hello, ${$.name}!`")).toEqual({ $concat: ["hello, ", { $toString: "$name" }, "!"] });
  });
  it("multiple interpolations", () => {
    expect(jsmql.expr("`${$.first} ${$.last}`")).toEqual({
      $concat: [{ $toString: "$first" }, " ", { $toString: "$last" }],
    });
  });
  it("interpolation at the start", () => {
    expect(jsmql.expr("`${$.x} px`")).toEqual({ $concat: [{ $toString: "$x" }, " px"] });
  });
  it("interpolation at the end", () => {
    expect(jsmql.expr("`prefix-${$.id}`")).toEqual({ $concat: ["prefix-", { $toString: "$id" }] });
  });
  it("expression inside interpolation", () => {
    expect(jsmql.expr("`total: ${$.a + $.b}`")).toEqual({
      $concat: ["total: ", { $toString: { $add: ["$a", "$b"] } }],
    });
  });
  it("interpolation containing object literal (brace tracking)", () => {
    expect(jsmql.expr("`v=${$let({ x: 1 }, x => x)}`")).toEqual({
      $concat: ["v=", { $toString: { $let: { vars: { x: 1 }, in: "$$x" } } }],
    });
  });
  it("nested template literal", () => {
    // Inner template literal is statically string-producing → no $toString wrap.
    expect(jsmql.expr("`outer ${`inner ${$.x}`}`")).toEqual({
      $concat: ["outer ", { $concat: ["inner ", { $toString: "$x" }] }],
    });
  });
  it("escape sequences", () => {
    expect(jsmql.expr("`a\\nb`")).toEqual("a\nb");
  });
  it("escaped backtick and dollar", () => {
    expect(jsmql.expr("`a\\`b\\${c}`")).toEqual("a`b${c}");
  });
  it("template literal participates in string-context +", () => {
    expect(jsmql.expr("`x=${$.x}` + ' done'")).toEqual({
      $concat: [{ $concat: ["x=", { $toString: "$x" }] }, " done"],
    });
  });
  it("string-producing interpolations skip the $toString wrap", () => {
    // .toLowerCase() is statically string-producing — the wrap would be redundant.
    expect(jsmql.expr("`name=${$.name.toLowerCase()}`")).toEqual({ $concat: ["name=", { $toLower: "$name" }] });
  });
  it("number literal interpolation gets $toString wrap", () => {
    expect(jsmql.expr("`n=${42}`")).toEqual({ $concat: ["n=", { $toString: 42 }] });
  });
});

describe("array .includes()", () => {
  it("array literal → $in", () => {
    expect(jsmql.expr('["a", "b"].includes($.x)')).toEqual({ $in: ["$x", ["a", "b"]] });
  });
  it("known array (split result) → $in", () => {
    expect(jsmql.expr('$.csv.split(",").includes("active")')).toEqual({ $in: ["active", { $split: ["$csv", ","] }] });
  });
  it("known string (toLowerCase result) → string form", () => {
    expect(jsmql.expr('$.email.toLowerCase().includes("@")')).toEqual({
      $gte: [{ $indexOfCP: [{ $toLower: "$email" }, "@"] }, 0],
    });
  });
  it("bare $.field → runtime $cond on $isArray (works for either type)", () => {
    expect(jsmql.expr("$.field.includes($.x)")).toEqual({
      $cond: [{ $isArray: "$field" }, { $in: ["$x", "$field"] }, { $gte: [{ $indexOfCP: ["$field", "$x"] }, 0] }],
    });
  });
});

describe("Math.min / Math.max", () => {
  it("Math.min variadic", () => {
    expect(jsmql.expr("Math.min($.a, $.b, $.c)")).toEqual({ $min: ["$a", "$b", "$c"] });
  });
  it("Math.max variadic", () => {
    expect(jsmql.expr("Math.max($.a, $.b)")).toEqual({ $max: ["$a", "$b"] });
  });
  it("Math.max with single array arg", () => {
    expect(jsmql.expr("Math.max($.scores)")).toEqual({ $max: "$scores" });
  });
  it("Math.max with spread arg", () => {
    expect(jsmql.expr("Math.max(...$.scores)")).toEqual({ $max: "$scores" });
  });
  it("Math.min mixed spread + scalar", () => {
    expect(jsmql.expr("Math.min($.a, ...$.others)")).toEqual({ $min: { $concatArrays: [["$a"], "$others"] } });
  });
});

describe("Date.now()", () => {
  it("returns ms since epoch", () => {
    expect(jsmql.expr("Date.now()")).toEqual({ $toLong: "$$NOW" });
  });
});

describe("Object.fromEntries", () => {
  it("from $objectToArray result", () => {
    expect(jsmql.expr("Object.fromEntries(Object.entries($.doc))")).toEqual({
      $arrayToObject: { $objectToArray: "$doc" },
    });
  });
  it("from array literal of pairs", () => {
    expect(jsmql.expr('Object.fromEntries([["a", 1], ["b", 2]])')).toEqual({
      $arrayToObject: [
        ["a", 1],
        ["b", 2],
      ],
    });
  });
});

describe("Array.isArray", () => {
  it("on a field", () => {
    expect(jsmql.expr("Array.isArray($.items)")).toEqual({ $isArray: "$items" });
  });
});

describe("optional chaining (?.)", () => {
  // Bare access — MongoDB's dotted-path semantics already null-pass through missing
  // fields, so `?.` on a bare read is sugar with no codegen difference.
  it("simple optional member access", () => {
    expect(jsmql.expr("$.a?.b")).toEqual("$a.b");
  });
  it("chained optional access", () => {
    expect(jsmql.expr("$.a?.b?.c")).toEqual("$a.b.c");
  });

  // Array spread — the originally-reported bug. `$concatArrays` returns null on
  // null input, poisoning every downstream consumer. `?.` now wraps the spread
  // operand with `$ifNull(v, [])` so missing fields produce an empty array.
  it("array spread of optional wraps with $ifNull, []", () => {
    expect(jsmql.expr("[...$.a?.b, 'x']")).toEqual({ $concatArrays: [{ $ifNull: ["$a.b", []] }, ["x"]] });
  });
  it("array spread alone of optional", () => {
    expect(jsmql.expr("[...$.a?.b]")).toEqual({ $ifNull: ["$a.b", []] });
  });
  it("user's reported spread-inside-includes case", () => {
    expect(jsmql.expr("[...$.moderators, ...$.room?.mods, 'root'].includes($.userId)")).toEqual({
      $in: ["$userId", { $concatArrays: ["$moderators", { $ifNull: ["$room.mods", []] }, ["root"]] }],
    });
  });
  it("non-optional spread is unchanged", () => {
    expect(jsmql.expr("[...$.a, 'x']")).toEqual({ $concatArrays: ["$a", ["x"]] });
  });

  // Array-method receivers — `$concatArrays` / `$in` / `$size` / `$arrayElemAt`
  // either error or null-poison on null input. Wrap the receiver with [].
  it(".map on optional receiver wraps with []", () => {
    expect(jsmql.expr("$.user?.posts.map(p => p.id)")).toEqual({
      $map: { input: { $ifNull: ["$user.posts", []] }, as: "p", in: "$$p.id" },
    });
  });
  it(".at on optional receiver wraps with []", () => {
    expect(jsmql.expr("$.user?.posts.at(0)")).toEqual({ $arrayElemAt: [{ $ifNull: ["$user.posts", []] }, 0] });
  });
  it(".toReversed on optional receiver wraps with []", () => {
    expect(jsmql.expr("$.user?.posts.toReversed()")).toEqual({ $reverseArray: { $ifNull: ["$user.posts", []] } });
  });
  it(".slice on optional receiver wraps with [] then runtime-dispatches", () => {
    expect(jsmql.expr("$.user?.posts.slice(0, 5)")).toEqual({
      $cond: [
        { $isArray: { $ifNull: ["$user.posts", []] } },
        { $slice: [{ $ifNull: ["$user.posts", []] }, 0, 5] },
        { $substrCP: [{ $ifNull: ["$user.posts", []] }, 0, 5] },
      ],
    });
  });

  // `.includes` / `.indexOf` / `.concat` dispatch on receiver type. Chain
  // walking stops at `MethodCall` boundaries — once `.toReversed()` ran (and
  // its own wrap took effect), the result is guaranteed not-null, so
  // `.includes` doesn't add a redundant outer wrap.
  it(".includes after .toReversed() of optional propagates the inner wrap, no outer wrap", () => {
    expect(jsmql.expr("$.user?.posts.toReversed().includes('hello')")).toEqual({
      $in: ["hello", { $reverseArray: { $ifNull: ["$user.posts", []] } }],
    });
  });
  it("`?.method()` (call itself is optional) wraps the receiver", () => {
    // `$.tags?.includes(y)` — MethodCall.optional=true. Wrap with [] since
    // includes-on-unknown dispatches via $cond; [] sends it to the array branch.
    expect(jsmql.expr("$.tags?.includes('vip')")).toEqual({
      $cond: [
        { $isArray: { $ifNull: ["$tags", []] } },
        { $in: ["vip", { $ifNull: ["$tags", []] }] },
        { $gte: [{ $indexOfCP: [{ $ifNull: ["$tags", []] }, "vip"] }, 0] },
      ],
    });
  });

  // String-method receivers — `$trim` / `$toUpper` / etc. return null on null
  // (sometimes error). Wrap the receiver with "" so a missing field produces
  // an empty string, matching JS's "would-throw on undefined.method, but ?.
  // short-circuits gracefully" intent.
  it('.trim on optional receiver wraps with ""', () => {
    expect(jsmql.expr("$.name?.trim()")).toEqual({ $trim: { input: { $ifNull: ["$name", ""] } } });
  });
  it('.trim on chained optional receiver wraps with ""', () => {
    expect(jsmql.expr("$.user?.name?.trim()")).toEqual({ $trim: { input: { $ifNull: ["$user.name", ""] } } });
  });
  it('.toUpperCase on optional receiver wraps with ""', () => {
    expect(jsmql.expr("$.user?.name.toUpperCase()")).toEqual({ $toUpper: { $ifNull: ["$user.name", ""] } });
  });
  it('.split on optional receiver wraps with ""', () => {
    expect(jsmql.expr("$.user?.csv.split(',')")).toEqual({ $split: [{ $ifNull: ["$user.csv", ""] }, ","] });
  });

  // `.length` is a MemberAccess, not a MethodCall — handled in its own codegen branch.
  it(".length on optional unknown-type receiver wraps with []", () => {
    // unknown receiver dispatches to runtime $cond between $size and $strLenCP;
    // wrap with [] so $isArray succeeds and $size([]) returns 0.
    expect(jsmql.expr("$.user?.tags.length")).toEqual({
      $cond: [
        { $isArray: { $ifNull: ["$user.tags", []] } },
        { $size: { $ifNull: ["$user.tags", []] } },
        { $strLenCP: { $ifNull: ["$user.tags", []] } },
      ],
    });
  });

  // String concatenation via `+` lowers to `$concat`, which is null-poisoning.
  it('string + with optional operand wraps with ""', () => {
    expect(jsmql.expr("$.firstName + ' ' + $.user?.lastName")).toEqual({
      $concat: ["$firstName", " ", { $ifNull: ["$user.lastName", ""] }],
    });
  });

  // Template literal interpolations also lower to $concat. Non-string-producing
  // interpolations still get $toString (so a numeric `$user.age` becomes "42"),
  // but the $ifNull wrap runs *before* $toString so a missing field produces "".
  it('template literal with optional interpolation wraps with ""', () => {
    expect(jsmql.expr("`hello ${$.user?.name}`")).toEqual({
      $concat: ["hello ", { $toString: { $ifNull: ["$user.name", ""] } }],
    });
  });

  // Object.keys / values / entries / fromEntries — `$objectToArray(null)` errors.
  it("Object.keys on optional wraps argument with {}", () => {
    expect(jsmql.expr("Object.keys($.user?.profile)")).toEqual({
      $map: { input: { $objectToArray: { $ifNull: ["$user.profile", {}] } }, as: "kv", in: "$$kv.k" },
    });
  });
  it("Object.entries on optional wraps argument with {}", () => {
    expect(jsmql.expr("Object.entries($.user?.profile)")).toEqual({
      $objectToArray: { $ifNull: ["$user.profile", {}] },
    });
  });

  // Bracket access — `obj?.[idx]` wraps with [] for the runtime $cond dispatch.
  it("optional bracket access on bare field wraps with []", () => {
    expect(jsmql.expr("$.scoresByLevel?.[$.level]")).toEqual({
      $cond: [
        { $isArray: { $ifNull: ["$scoresByLevel", []] } },
        { $arrayElemAt: [{ $ifNull: ["$scoresByLevel", []] }, "$level"] },
        { $getField: { field: "$level", input: { $ifNull: ["$scoresByLevel", []] } } },
      ],
    });
  });
  it("optional bracket access on known array wraps with []", () => {
    // `.toReversed()` is known array-producing, so the bracket access uses
    // the compact $arrayElemAt form. The `?.` adds the wrap on the receiver.
    expect(jsmql.expr("$.items.toReversed()?.[0]")).toEqual({
      $arrayElemAt: [{ $ifNull: [{ $reverseArray: "$items" }, []] }, 0],
    });
  });

  // ── Deliberately NOT wrapped ─────────────────────────────────────────────
  // The following consumers are already null-safe, so wrapping would be busywork.
  it("object spread of optional is NOT wrapped ($mergeObjects ignores null)", () => {
    expect(jsmql.expr("({...$.user?.profile, name: 'x'})")).toEqual({
      $mergeObjects: ["$user.profile", { name: "x" }],
    });
  });
  it("comparison against optional is NOT wrapped", () => {
    expect(jsmql.expr("$.user?.role === 'admin'")).toEqual({ $eq: ["$user.role", "admin"] });
  });
  it("`==` null check against optional is NOT wrapped", () => {
    expect(jsmql.expr("$.user?.role == null")).toEqual({ $in: [{ $type: "$user.role" }, ["null", "missing"]] });
  });
  it("numeric arithmetic against optional is NOT wrapped (honest null > 0)", () => {
    expect(jsmql.expr("$.base + $.user?.bonus")).toEqual({ $add: ["$base", "$user.bonus"] });
  });

  // `?.` buried inside a lambda body belongs to the lambda's chain, not the
  // outer `.map()` chain — so the outer .map receiver does NOT get wrapped.
  it("?. inside a lambda body does NOT wrap the outer chain", () => {
    expect(jsmql.expr("$.items.map(x => x?.tags)")).toEqual({ $map: { input: "$items", as: "x", in: "$$x.tags" } });
  });
});

describe(".startsWith / .endsWith", () => {
  it("startsWith maps to indexOf == 0", () => {
    expect(jsmql.expr('$.email.startsWith("admin")')).toEqual({ $eq: [{ $indexOfCP: ["$email", "admin"] }, 0] });
  });
  it("endsWith maps to substring equality at the tail", () => {
    expect(jsmql.expr('$.file.endsWith(".pdf")')).toEqual({
      $eq: [
        { $substrCP: ["$file", { $subtract: [{ $strLenCP: "$file" }, { $strLenCP: ".pdf" }] }, { $strLenCP: ".pdf" }] },
        ".pdf",
      ],
    });
  });
});

describe(".charAt", () => {
  it("charAt(i)", () => {
    expect(jsmql.expr("$.name.charAt(2)")).toEqual({ $substrCP: ["$name", 2, 1] });
  });
});

describe("array .indexOf", () => {
  it("on array literal → $indexOfArray", () => {
    expect(jsmql.expr('["a", "b", "c"].indexOf($.x)')).toEqual({ $indexOfArray: [["a", "b", "c"], "$x"] });
  });
  it("on known string → $indexOfCP", () => {
    expect(jsmql.expr('$.email.toLowerCase().indexOf("@")')).toEqual({ $indexOfCP: [{ $toLower: "$email" }, "@"] });
  });
  it("on bare field → runtime $cond on $isArray", () => {
    expect(jsmql.expr('$.email.indexOf("@")')).toEqual({
      $cond: [{ $isArray: "$email" }, { $indexOfArray: ["$email", "@"] }, { $indexOfCP: ["$email", "@"] }],
    });
  });
});

describe("array .concat", () => {
  it("on array literal → $concatArrays", () => {
    expect(jsmql.expr("[1, 2].concat([3, 4])")).toEqual({
      $concatArrays: [
        [1, 2],
        [3, 4],
      ],
    });
  });
  it("on known string → $concat", () => {
    expect(jsmql.expr("$.first.trim().concat($.last)")).toEqual({ $concat: [{ $trim: { input: "$first" } }, "$last"] });
  });
  it("on bare field → runtime $cond on $isArray", () => {
    expect(jsmql.expr("$.parts.concat($.tail)")).toEqual({
      $cond: [{ $isArray: "$parts" }, { $concatArrays: ["$parts", "$tail"] }, { $concat: ["$parts", "$tail"] }],
    });
  });
});

describe(".join", () => {
  it("default separator (,)", () => {
    expect(jsmql.expr("$.tags.join()")).toEqual({
      $reduce: {
        input: "$tags",
        initialValue: "",
        in: {
          $cond: [
            { $eq: ["$$value", ""] },
            { $toString: "$$this" },
            { $concat: ["$$value", ",", { $toString: "$$this" }] },
          ],
        },
      },
    });
  });
  it("custom separator", () => {
    expect(jsmql.expr('$.tags.join(" | ")')).toEqual({
      $reduce: {
        input: "$tags",
        initialValue: "",
        in: {
          $cond: [
            { $eq: ["$$value", ""] },
            { $toString: "$$this" },
            { $concat: ["$$value", " | ", { $toString: "$$this" }] },
          ],
        },
      },
    });
  });
});

describe(".flat / .flatMap", () => {
  it("flat() one level", () => {
    expect(jsmql.expr("$.nested.flat()")).toEqual({
      $reduce: { input: "$nested", initialValue: [], in: { $concatArrays: ["$$value", "$$this"] } },
    });
  });
  it("flat(1) explicit depth", () => {
    expect(jsmql.expr("$.nested.flat(1)")).toEqual({
      $reduce: { input: "$nested", initialValue: [], in: { $concatArrays: ["$$value", "$$this"] } },
    });
  });
  it("flat(2) is rejected", () => {
    expect(() => jsmql.expr("$.nested.flat(2)")).toThrow(/depth=1/);
  });
  it("flatMap with lambda", () => {
    expect(jsmql.expr("$.docs.flatMap(d => d.tags)")).toEqual({
      $reduce: {
        input: { $map: { input: "$docs", as: "d", in: "$$d.tags" } },
        initialValue: [],
        in: { $concatArrays: ["$$value", "$$this"] },
      },
    });
  });
});

describe("date .getTime / .toISOString", () => {
  it("getTime", () => {
    expect(jsmql.expr("$.ts.getTime()")).toEqual({ $toLong: "$ts" });
  });
  it("toISOString", () => {
    expect(jsmql.expr("$.ts.toISOString()")).toEqual({
      $dateToString: { date: "$ts", format: "%Y-%m-%dT%H:%M:%S.%LZ" },
    });
  });
});

describe("Math.sign / log2 / log10 / hypot / cbrt / random / constants", () => {
  it("Math.sign maps to $cmp(x, 0)", () => {
    expect(jsmql.expr("Math.sign($.x)")).toEqual({ $cmp: ["$x", 0] });
  });
  it("Math.log2", () => {
    expect(jsmql.expr("Math.log2($.x)")).toEqual({ $log: ["$x", 2] });
  });
  it("Math.log10", () => {
    expect(jsmql.expr("Math.log10($.x)")).toEqual({ $log10: "$x" });
  });
  it("Math.cbrt", () => {
    expect(jsmql.expr("Math.cbrt($.x)")).toEqual({ $pow: ["$x", { $divide: [1, 3] }] });
  });
  it("Math.hypot 2-arg", () => {
    expect(jsmql.expr("Math.hypot($.a, $.b)")).toEqual({ $sqrt: { $add: [{ $pow: ["$a", 2] }, { $pow: ["$b", 2] }] } });
  });
  it("Math.random", () => {
    expect(jsmql.expr("Math.random()")).toEqual({ $rand: {} });
  });
  it("Math.PI", () => {
    expect(jsmql.expr("Math.PI")).toEqual(Math.PI);
  });
  it("Math.E", () => {
    expect(jsmql.expr("Math.E")).toEqual(Math.E);
  });
});

describe("numeric separators", () => {
  it("integer with separator", () => {
    expect(jsmql.expr("$abs(1_000_000)")).toEqual({ $abs: 1000000 });
  });
  it("float with separator", () => {
    expect(jsmql.expr("$abs(1_234.567_89)")).toEqual({ $abs: 1234.56789 });
  });
  it("exponent with separator", () => {
    expect(jsmql.expr("$abs(1_2e3)")).toEqual({ $abs: 12000 });
  });
  it("trailing _ rejected", () => {
    expect(() => jsmql.expr("1_")).toThrow(/Numeric separator/);
  });
  it("double __ rejected", () => {
    expect(() => jsmql.expr("1__0")).toThrow(/Numeric separator/);
  });
});

describe("comments", () => {
  it("// line comment between expressions", () => {
    expect(jsmql.expr("$.a // tail\n+ $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// line comment at EOF (no terminator)", () => {
    expect(jsmql.expr("$abs($.x) // trailing comment")).toEqual({ $abs: "$x" });
  });
  it("// terminated by CR", () => {
    expect(jsmql.expr("$.a // x\r+ $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// terminated by CRLF", () => {
    expect(jsmql.expr("$.a // x\r\n+ $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// terminated by U+2028 (LSEP)", () => {
    expect(jsmql.expr("$.a // x + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("// terminated by U+2029 (PSEP)", () => {
    expect(jsmql.expr("$.a // x + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("/* block */ inline", () => {
    expect(jsmql.expr("$.a /* mid */ + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("/* multi-line block */", () => {
    expect(jsmql.expr("$.a /*\n  spans\n  lines\n*/ + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("empty /**/ block", () => {
    expect(jsmql.expr("$.a /**/ + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("multiple comments collapse to one boundary", () => {
    expect(jsmql.expr("$.a // one\n  /* two */ \n // three\n + $.b")).toEqual({ $add: ["$a", "$b"] });
  });
  it("comment inside template ${...} interpolation", () => {
    expect(jsmql.expr("`hi ${ $.name /* user */ }`")).toEqual({ $concat: ["hi ", { $toString: "$name" }] });
  });
  it("// inside string literal is preserved as data", () => {
    expect(jsmql.expr('$eq($.url, "https://example.com")')).toEqual({ $eq: ["$url", "https://example.com"] });
  });
  it("// inside regex literal is preserved as pattern", () => {
    // Two literal slashes inside a regex character class — must not be eaten as a comment
    expect(jsmql.expr("$.path.match(/[/\\\\]/)")).toEqual({ $regexMatch: { input: "$path", regex: "[/\\\\]" } });
  });
  it("regex disambiguation works after a comment (non-value-ending)", () => {
    // After `(` (not a value-ending token) a `/` would normally start a regex.
    // A leading comment must not change that.
    expect(jsmql.expr("$.path.match(/* skip */ /foo/i)")).toEqual({
      $regexMatch: { input: "$path", regex: "foo", options: "i" },
    });
  });
  it("divide disambiguation works after a comment (value-ending)", () => {
    // After a Number token, `/` is divide; a leading comment must not change that.
    expect(jsmql.expr("10 /* skip */ / 2")).toEqual({ $divide: [10, 2] });
  });
  it("unclosed /* throws LexError", () => {
    expect(() => jsmql.expr("$.a /* unclosed")).toThrow(/Unclosed block comment/);
  });
});

describe("computed object keys", () => {
  it("single computed key", () => {
    expect(jsmql.expr("$abs({ [$.k]: 1 })")).toEqual({ $abs: { $arrayToObject: [["$k", 1]] } });
  });
  it("mixed static and computed keys", () => {
    expect(jsmql.expr("$abs({ a: 1, [$.k]: 2 })")).toEqual({
      $abs: {
        $arrayToObject: [
          ["a", 1],
          ["$k", 2],
        ],
      },
    });
  });
});

describe("spread in operator args", () => {
  it("$concatArrays with spread", () => {
    expect(jsmql.expr("$concatArrays(...$.arrs)")).toEqual({ $concatArrays: "$arrs" });
  });
  it("Object.assign with spread", () => {
    expect(jsmql.expr("Object.assign(...$.docs)")).toEqual({ $mergeObjects: "$docs" });
  });
});

describe("shorthand object properties", () => {
  it("inside lambda body", () => {
    expect(jsmql.expr("$.items.map(x => ({ x }))")).toEqual({ $map: { input: "$items", as: "x", in: { x: "$$x" } } });
  });
  it("two shorthand props", () => {
    expect(jsmql.expr("$.items.map(x => ({ x, x }))")).toEqual({
      $map: { input: "$items", as: "x", in: { x: "$$x" } },
    });
  });
  it("shorthand outside lambda scope errors", () => {
    expect(() => jsmql.expr("({ foo })")).toThrow(/Unknown identifier/);
  });
});

describe("flex-shape operators", () => {
  // ── $round / $trunc ─────────────────────────────────────────────────────────
  it("$round single arg → bare value", () => {
    expect(jsmql.expr("$round($.price)")).toEqual({ $round: "$price" });
  });
  it("$round two args → array", () => {
    expect(jsmql.expr("$round($.price, 2)")).toEqual({ $round: ["$price", 2] });
  });
  it("$trunc single arg → bare value", () => {
    expect(jsmql.expr("$trunc($.value)")).toEqual({ $trunc: "$value" });
  });
  it("$trunc two args → array", () => {
    expect(jsmql.expr("$trunc($.value, 1)")).toEqual({ $trunc: ["$value", 1] });
  });

  // ── Accumulators ($min / $max / $avg / $sum / $stdDev*) ─────────────────────
  it("$min single arg → bare value (accumulator-style)", () => {
    expect(jsmql.expr("$min($.scores)")).toEqual({ $min: "$scores" });
  });
  it("$min multiple args → array (expression-style)", () => {
    expect(jsmql.expr("$min($.a, $.b, $.c)")).toEqual({ $min: ["$a", "$b", "$c"] });
  });
  it("$max single arg", () => {
    expect(jsmql.expr("$max($.scores)")).toEqual({ $max: "$scores" });
  });
  it("$max multiple args", () => {
    expect(jsmql.expr("$max($.a, $.b)")).toEqual({ $max: ["$a", "$b"] });
  });
  it("$avg single arg", () => {
    expect(jsmql.expr("$avg($.values)")).toEqual({ $avg: "$values" });
  });
  it("$avg multiple args", () => {
    expect(jsmql.expr("$avg($.a, $.b, $.c)")).toEqual({ $avg: ["$a", "$b", "$c"] });
  });
  it("$sum single arg", () => {
    expect(jsmql.expr("$sum($.amounts)")).toEqual({ $sum: "$amounts" });
  });
  it("$sum multiple args", () => {
    expect(jsmql.expr("$sum($.a, $.b)")).toEqual({ $sum: ["$a", "$b"] });
  });
  it("$stdDevPop single arg", () => {
    expect(jsmql.expr("$stdDevPop($.measurements)")).toEqual({ $stdDevPop: "$measurements" });
  });
  it("$stdDevSamp multiple args", () => {
    expect(jsmql.expr("$stdDevSamp($.a, $.b, $.c)")).toEqual({ $stdDevSamp: ["$a", "$b", "$c"] });
  });

  // ── $mergeObjects ───────────────────────────────────────────────────────────
  it("$mergeObjects single arg → bare value", () => {
    expect(jsmql.expr("$mergeObjects($.docs)")).toEqual({ $mergeObjects: "$docs" });
  });
  it("$mergeObjects multiple args → array", () => {
    expect(jsmql.expr("$mergeObjects($.a, $.b)")).toEqual({ $mergeObjects: ["$a", "$b"] });
  });

  // ── Spread handling ─────────────────────────────────────────────────────────
  it("flex op with single spread → bare array", () => {
    expect(jsmql.expr("$min(...$.scores)")).toEqual({ $min: "$scores" });
  });
  it("flex op with mixed spread + scalar → $concatArrays", () => {
    expect(jsmql.expr("$max($.first, ...$.rest)")).toEqual({ $max: { $concatArrays: [["$first"], "$rest"] } });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────
  it("flex op with zero args throws", () => {
    expect(() => jsmql.expr("$min()")).toThrow(/at least 1 argument/);
  });
  it("flex op with object literal arg → object as value (not object-shape)", () => {
    // Single arg that happens to be an object literal — parser flags this as object-style,
    // but $mergeObjects has flex shape (not object), so the literal is passed as a value.
    expect(jsmql.expr("$mergeObjects({ a: 1, b: $.x })")).toEqual({ $mergeObjects: { a: 1, b: "$x" } });
  });
  it("$round with arithmetic still works (regression: existing 2-arg form)", () => {
    expect(jsmql.expr("$round($.price * 1.1, 2)")).toEqual({ $round: [{ $multiply: ["$price", 1.1] }, 2] });
  });
});

describe("function overload", () => {
  it("accepts a no-param arrow", () => {
    expect(jsmql.expr(($) => $.age > 18)).toEqual({ $gt: ["$age", 18] });
  });

  it("accepts a $-param arrow (recommended idiom)", () => {
    expect(jsmql.expr(($) => $.age > 18)).toEqual({ $gt: ["$age", 18] });
  });

  it("produces identical MQL to the equivalent string", () => {
    expect(jsmql.expr(($) => $.status === "active")).toEqual(jsmql.expr('$.status === "active"'));
  });

  it("the wrapper parameter is not bound inside the body — references resolve via $", () => {
    // `(doc) =>` is a typing/IDE hook only. Inside the body, `doc.foo` is treated as
    // an unknown identifier (and the user gets pointed at `$.doc` and the jsmql tag).
    expect(() => jsmql.expr((doc) => doc.foo)).toThrow(/Unknown identifier 'doc'/);
  });

  it("handles nested arrows in the body", () => {
    expect(jsmql.expr(($) => $.items.map((x) => x * 2))).toEqual({
      $map: { input: "$items", as: "x", in: { $multiply: ["$$x", 2] } },
    });
  });

  it("handles a parenthesised object-literal body", () => {
    expect(jsmql.expr(($) => ({ doubled: $.x * 2 }))).toEqual({ doubled: { $multiply: ["$x", 2] } });
  });

  it("rejects `return` inside a block-body arrow with a clear error", () => {
    expect(() =>
      jsmql.expr(($) => {
        return $.age > 18;
      }),
    ).toThrow(/return/);
  });

  it("rejects a `function` declaration", () => {
    expect(() =>
      jsmql.expr(function ($) {
        return $.age > 18;
      }),
    ).toThrow(/arrow function/);
  });

  it("rejects an async arrow", () => {
    expect(() => jsmql.expr(async ($) => $.age > 18)).toThrow(/async/);
  });

  it("appends a jsmql`` hint when an outer-scope identifier is referenced", () => {
    const minAge = 21; // referenced from the closure on purpose
    expect(() => jsmql(($) => $.age > minAge)).toThrow(/jsmql`` template tag/);
  });

  it("jsmql.validate() reports the augmented hint for closure refs", () => {
    const minAge = 21;
    const r = jsmql.validate(($) => $.age > minAge);
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.code).toBe("CODEGEN_ERROR");
    expect(r.errors[0]?.message).toMatch(/Unknown identifier 'minAge'/);
    expect(r.errors[0]?.message).toMatch(/jsmql`` template tag/);
  });

  it("jsmql.validate() reports SYNTAX_ERROR for an unsupported function shape", () => {
    const r = jsmql.validate(($) => {
      return $.age > 18;
    });
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.code).toBe("SYNTAX_ERROR");
  });

  it("inline arrow in a hot loop produces consistent MQL across calls", () => {
    const make = () => jsmql.expr(($) => $.status === "active");
    const a = make();
    const b = make();
    expect(a).toEqual(b);
  });

  it("destructured operator in the second parameter compiles to the same MQL as the string form", () => {
    // The second arg is types-only — it gives users a destructure site that
    // silences IDE warnings on `$dateDiff`. The runtime strips the param list,
    // so this produces identical MQL to the string equivalent.
    const fromFn = jsmql.expr(($, { $dateDiff }) => $dateDiff({ startDate: $.a, endDate: $.b, unit: "day" }));
    const fromStr = jsmql.expr('$dateDiff({ startDate: $.a, endDate: $.b, unit: "day" })');
    expect(fromFn).toEqual(fromStr);
  });
});

// ─── Newly-registered operators (pulled from mongodb/mql-specifications) ────

describe("bitwise operators", () => {
  it.each([
    ["$bitAnd", "$bitAnd($.a, $.b, $.c)", { $bitAnd: ["$a", "$b", "$c"] }],
    ["$bitOr", "$bitOr($.a, $.b)", { $bitOr: ["$a", "$b"] }],
    ["$bitXor", "$bitXor($.a, $.b)", { $bitXor: ["$a", "$b"] }],
    ["$bitNot", "$bitNot($.flags)", { $bitNot: "$flags" }],
  ])("%s emits the expected MQL", (_name, src, expected) => {
    expect(jsmql.expr(src)).toEqual(expected);
  });
});

describe("misc / hash / timestamp / sigmoid / type / literal operators", () => {
  it.each([
    ["$sigmoid", "$sigmoid($.x)", { $sigmoid: "$x" }],
    ["$createObjectId", "$createObjectId()", { $createObjectId: {} }],
    ["$toHashedIndexKey", "$toHashedIndexKey($.k)", { $toHashedIndexKey: "$k" }],
    ["$tsIncrement", "$tsIncrement($.t)", { $tsIncrement: "$t" }],
    ["$tsSecond", "$tsSecond($.t)", { $tsSecond: "$t" }],
    ["$toUUID", '$toUUID("550e8400-e29b-41d4-a716-446655440000")', { $toUUID: "550e8400-e29b-41d4-a716-446655440000" }],
    ["$toObject", "$toObject($.json)", { $toObject: "$json" }],
    ["$toArray", "$toArray($.field)", { $toArray: "$field" }],
    ["$literal field-ref pass-through", '$literal("$foo")', { $literal: "$foo" }],
    ["$meta keyword string", '$meta("textScore")', { $meta: "textScore" }],
  ])("%s emits the expected MQL", (_name, src, expected) => {
    expect(jsmql.expr(src)).toEqual(expected);
  });
});

describe("auto-$literal wrap for `$`-prefixed string values", () => {
  // MongoDB reads any value-position string that starts with `$` as a field
  // reference (or system variable) at query time. Users who write `"$foo"` as
  // a literal in jsmql source mean the four-character string, not field
  // access (they'd write `$.foo` for that). jsmql wraps these in `$literal`
  // automatically so the runtime sees the intended string.

  it("bare $-prefixed string literal at the top level", () => {
    expect(jsmql.expr('"$foo"')).toEqual({ $literal: "$foo" });
  });

  it("$$-prefixed system-variable-shaped literal also wraps", () => {
    expect(jsmql.expr('"$$NOW"')).toEqual({ $literal: "$$NOW" });
  });

  it("plain strings (no leading $) are unaffected", () => {
    expect(jsmql.expr('"hello"')).toEqual("hello");
    expect(jsmql.expr('""')).toEqual("");
  });

  it("$-string inside an array literal", () => {
    expect(jsmql.expr('[1, "$foo", "bar"]')).toEqual([1, { $literal: "$foo" }, "bar"]);
  });

  it("$-string as an object value (key form unchanged)", () => {
    expect(jsmql.expr('({ x: "$foo", y: "bar" })')).toEqual({ x: { $literal: "$foo" }, y: "bar" });
  });

  it("$-string as an object KEY does not wrap", () => {
    // The user's key is the JSON key directly — MongoDB doesn't auto-evaluate
    // keys, only values. Leave it alone.
    expect(jsmql.expr('({ "$foo": 1 })')).toEqual({ $foo: 1 });
  });

  it("$-string as an operator argument", () => {
    expect(jsmql.expr('$concat("$first", " ", "$last")')).toEqual({
      $concat: [{ $literal: "$first" }, " ", { $literal: "$last" }],
    });
  });

  it("real field refs (`$.foo`) are NOT wrapped — they aren't string literals", () => {
    expect(jsmql.expr("$concat($.first, $.last)")).toEqual({ $concat: ["$first", "$last"] });
  });

  it("inside $literal(...) the inner $-string is NOT double-wrapped", () => {
    expect(jsmql.expr('$literal("$foo")')).toEqual({ $literal: "$foo" });
  });

  it("$literal of a nested object suppresses the wrap on inner $-strings", () => {
    expect(jsmql.expr('$literal({ x: "$foo" })')).toEqual({ $literal: { x: "$foo" } });
  });

  it("$literal of a nested array suppresses the wrap on inner $-strings", () => {
    expect(jsmql.expr('$literal(["$a", "$b"])')).toEqual({ $literal: ["$a", "$b"] });
  });

  it("template-tag interpolation of a $-prefixed value wraps", () => {
    const tainted = "$dangerous";
    expect(jsmql.expr`$.x === ${tainted}`).toEqual({ $eq: ["$x", { $literal: "$dangerous" }] });
  });

  it("compile-form binding of a $-prefixed string is inlined safely in find form", () => {
    // The query language does not treat values as field refs (only the
    // aggregation language does), so the $literal wrap is unnecessary here.
    // The same compile + $-prefixed binding inside an aggregation context
    // (e.g. inside `$addFields`) still gets the wrap — covered in the
    // pipeline-integration tests below.
    const q = jsmql.compile(({ name }: { name: string }, $) => $.x === name);
    expect(q({ name: "$dangerous" })).toEqual({ x: "$dangerous" });
  });

  it("compile-form binding deeply wraps $-strings inside arrays and objects", () => {
    // `in` is not query-translatable, so the residual goes through $expr,
    // which re-enters aggregation codegen — and that path still applies the
    // auto-$literal wrap to $-prefixed strings inside the array binding.
    const q = jsmql.compile(({ allowed }: { allowed: string[] }, $) => $.grade in allowed);
    expect(q({ allowed: ["$a", "$b", "safe"] })).toEqual({
      $expr: { $in: ["$grade", [{ $literal: "$a" }, { $literal: "$b" }, "safe"]] },
    });
  });
});

describe("$hash and $hexHash (object shape)", () => {
  it("$hash positional", () => {
    expect(jsmql.expr('$hash($.password, "sha256")')).toEqual({ $hash: { input: "$password", algorithm: "sha256" } });
  });
  it("$hexHash object-style", () => {
    expect(jsmql.expr('$hexHash({ input: $.token, algorithm: "sha512" })')).toEqual({
      $hexHash: { input: "$token", algorithm: "sha512" },
    });
  });
});

describe("$accumulator and $function (custom aggregation)", () => {
  it("$function object-style", () => {
    expect(jsmql.expr('$function({ body: "function(x) { return x * 2; }", args: [$.value], lang: "js" })')).toEqual({
      $function: { body: "function(x) { return x * 2; }", args: ["$value"], lang: "js" },
    });
  });
  it("$accumulator object-style with subset of keys", () => {
    expect(
      jsmql.expr(
        '$accumulator({ init: "function() { return 0; }", accumulate: "function(s, v) { return s + v; }", merge: "function(a, b) { return a + b; }", lang: "js" })',
      ),
    ).toEqual({
      $accumulator: {
        init: "function() { return 0; }",
        accumulate: "function(s, v) { return s + v; }",
        merge: "function(a, b) { return a + b; }",
        lang: "js",
      },
    });
  });
});

describe("$median and $percentile (statistical accumulators)", () => {
  it("$median positional", () => {
    expect(jsmql.expr('$median($.scores, "approximate")')).toEqual({
      $median: { input: "$scores", method: "approximate" },
    });
  });
  it("$percentile positional", () => {
    expect(jsmql.expr('$percentile($.scores, [0.5, 0.95], "approximate")')).toEqual({
      $percentile: { input: "$scores", p: [0.5, 0.95], method: "approximate" },
    });
  });
});

describe("encrypted-string operators ($encStr*)", () => {
  it("$encStrContains", () => {
    expect(jsmql.expr('$encStrContains($.encField, "secret")')).toEqual({
      $encStrContains: { input: "$encField", substring: "secret" },
    });
  });
  it("$encStrStartsWith object-style", () => {
    expect(jsmql.expr('$encStrStartsWith({ input: $.encField, prefix: "abc" })')).toEqual({
      $encStrStartsWith: { input: "$encField", prefix: "abc" },
    });
  });
  it("$encStrEndsWith", () => {
    expect(jsmql.expr('$encStrEndsWith($.encField, "xyz")')).toEqual({
      $encStrEndsWith: { input: "$encField", suffix: "xyz" },
    });
  });
  it("$encStrNormalizedEq", () => {
    expect(jsmql.expr('$encStrNormalizedEq($.encField, "compare")')).toEqual({
      $encStrNormalizedEq: { input: "$encField", string: "compare" },
    });
  });
});

describe("window operators ($setWindowFields-only)", () => {
  it.each([
    ["$rank", "$rank()", { $rank: {} }],
    ["$denseRank", "$denseRank()", { $denseRank: {} }],
    ["$documentNumber", "$documentNumber()", { $documentNumber: {} }],
    ["$linearFill", "$linearFill($.value)", { $linearFill: "$value" }],
    ["$locf", "$locf($.value)", { $locf: "$value" }],
    ["$covariancePop", "$covariancePop($.x, $.y)", { $covariancePop: ["$x", "$y"] }],
    ["$covarianceSamp", "$covarianceSamp($.x, $.y)", { $covarianceSamp: ["$x", "$y"] }],
  ])("%s emits the expected MQL", (_name, src, expected) => {
    expect(jsmql.expr(src)).toEqual(expected);
  });

  it("$shift positional", () => {
    expect(jsmql.expr("$shift($.price, -1, 0)")).toEqual({ $shift: { output: "$price", by: -1, default: 0 } });
  });

  it("$shift object-style", () => {
    expect(jsmql.expr("$shift({ output: $.price, by: -1, default: 0 })")).toEqual({
      $shift: { output: "$price", by: -1, default: 0 },
    });
  });

  it("$expMovingAvg with N (positional)", () => {
    expect(jsmql.expr("$expMovingAvg($.price, 5)")).toEqual({ $expMovingAvg: { input: "$price", N: 5 } });
  });

  it("$expMovingAvg with alpha (object-style)", () => {
    expect(jsmql.expr("$expMovingAvg({ input: $.price, alpha: 0.3 })")).toEqual({
      $expMovingAvg: { input: "$price", alpha: 0.3 },
    });
  });

  it("$derivative positional", () => {
    expect(jsmql.expr('$derivative($.value, "hour")')).toEqual({ $derivative: { input: "$value", unit: "hour" } });
  });

  it("$integral positional", () => {
    expect(jsmql.expr('$integral($.value, "hour")')).toEqual({ $integral: { input: "$value", unit: "hour" } });
  });
});

describe("jsmql.compile()", () => {
  describe("basic binding", () => {
    it("scalar binding inlines as a literal", () => {
      const q = jsmql.compile(({ minAge }: { minAge: number }, $) => $.age > minAge);
      expect(q({ minAge: 21 })).toEqual({ age: { $gt: 21 } });
    });

    it("string binding inlines as a literal string", () => {
      const q = jsmql.compile(({ region }: { region: string }, $) => $.region === region);
      expect(q({ region: "AU" })).toEqual({ region: "AU" });
    });

    it("array binding inlines into $in", () => {
      // `in` is not query-translatable today, so the residual goes through
      // $expr — the binding still inlines into `$in`'s second slot.
      const q = jsmql.compile(({ allowed }: { allowed: string[] }, $) => $.grade in allowed);
      expect(q({ allowed: ["A", "B"] })).toEqual({ $expr: { $in: ["$grade", ["A", "B"]] } });
    });

    it("plain-object binding inlines as a nested object literal value", () => {
      // Whole-object bindings appear as MQL literal objects. Field access on
      // them (e.g. `thresholds.min`) goes through MQL's `$getField`, not a
      // compile-time fold — the user can always destructure further at the
      // call site if they want fields hoisted as separate bindings.
      const q = jsmql.compile(({ defaults }: { defaults: { name: string } }) => defaults);
      expect(q({ defaults: { name: "default" } })).toEqual({ $expr: { name: "default" } });
    });

    it("the same compiled query is reusable with different params", () => {
      const q = jsmql.compile(({ n }: { n: number }, $) => $.age > n);
      expect(q({ n: 18 })).toEqual({ age: { $gt: 18 } });
      expect(q({ n: 65 })).toEqual({ age: { $gt: 65 } });
    });

    it("aliased destructure key binds the alias name", () => {
      const q = jsmql.compile(({ minAge: floor }: { minAge: number }, $) => $.age >= floor);
      expect(q({ minAge: 18 })).toEqual({ age: { $gte: 18 } });
    });
  });

  describe("signature slot disambiguation", () => {
    it("params-only slot (no $)", () => {
      const q = jsmql.compile(({ flag }: { flag: boolean }) => flag);
      expect(q({ flag: true })).toEqual({ $expr: true });
    });

    it("(params, $) two-slot form", () => {
      const q = jsmql.compile(({ n }: { n: number }, $) => $.age > n);
      expect(q({ n: 18 })).toEqual({ age: { $gt: 18 } });
    });

    it("(params, $, ops) three-slot form — ops hint is types-only", () => {
      const q = jsmql.compile(
        ({ minScore }: { minScore: number }, $, { $match }: { $match: (...args: unknown[]) => unknown }) => [
          $match($.score >= minScore),
        ],
      );
      expect(q({ minScore: 75 })).toEqual([{ $match: { score: { $gte: 75 } } }]);
    });

    it("existing one-arg `($) => …` form still works unchanged via jsmql.expr()", () => {
      expect(jsmql.expr(($) => $.age > 18)).toEqual({ $gt: ["$age", 18] });
    });

    it("existing two-arg `($, { $dateDiff }) => …` form still works unchanged via jsmql.expr()", () => {
      expect(jsmql.expr(($) => $.x === "ok")).toEqual({ $eq: ["$x", "ok"] });
    });
  });

  describe("scope and shadowing", () => {
    it("lambda parameter shadows a binding of the same name", () => {
      const q = jsmql.compile(({ x }: { x: number }, $) => $.items.map((x) => x * 2));
      expect(q({ x: 999 })).toEqual({ $expr: { $map: { input: "$items", as: "x", in: { $multiply: ["$$x", 2] } } } });
    });

    it("binding visible alongside other refs translates to a query-doc conjunction", () => {
      const q = jsmql.compile(({ minAge }: { minAge: number }, $) => $.age >= minAge && $.country === "US");
      expect(q({ minAge: 21 })).toEqual({ age: { $gte: 21 }, country: "US" });
    });
  });

  describe("$match index-friendly translation (a75eb35)", () => {
    it("scalar binding against a field becomes a query-language $match", () => {
      const q = jsmql.compile(
        ({ minAge }: { minAge: number }, $, { $match }: { $match: (...a: unknown[]) => unknown }) => [
          $match($.age >= minAge),
        ],
      );
      expect(q({ minAge: 21 })).toEqual([{ $match: { age: { $gte: 21 } } }]);
    });

    it("string binding equals a field becomes a query-language $match", () => {
      const q = jsmql.compile(
        ({ region }: { region: string }, $, { $match }: { $match: (...a: unknown[]) => unknown }) => [
          $match($.region === region),
        ],
      );
      expect(q({ region: "AU" })).toEqual([{ $match: { region: "AU" } }]);
    });

    it("Date binding against a field becomes a query-language $match", () => {
      // BSON `Date` instances are query-doc values — MongoDB indexes work on
      // them. Without this, a Date parameter would fall through to $expr.
      const q = jsmql.compile(({ cutoff }: { cutoff: Date }, $) => $.createdAt >= cutoff);
      const cutoff = new Date("2026-01-01");
      expect(q({ cutoff })).toEqual({ createdAt: { $gte: cutoff } });
    });

    it("RegExp binding inlines as a query-doc regex match", () => {
      const q = jsmql.compile(({ name }: { name: RegExp }, $) => $.username === name);
      const name = /^alice/i;
      expect(q({ name })).toEqual({ username: name });
    });
  });

  describe("pipeline integration", () => {
    it("bindings work in pipeline arrays end-to-end", () => {
      const q = jsmql.compile(
        (
          { min, limit }: { min: number; limit: number },
          $,
          {
            $match,
            $project,
            $limit,
          }: {
            $match: (...a: unknown[]) => unknown;
            $project: (...a: unknown[]) => unknown;
            $limit: (...a: unknown[]) => unknown;
          },
        ) => [$match($.score >= min), $project({ name: $.name, score: $.score }), $limit(limit)],
      );
      expect(q({ min: 75, limit: 10 })).toEqual([
        { $match: { score: { $gte: 75 } } },
        { $project: { name: "$name", score: "$score" } },
        { $limit: 10 },
      ]);
    });
  });

  describe("bindings cross sub-pipeline boundaries", () => {
    it("a binding is visible inside $lookup.pipeline", () => {
      const q = jsmql.compile(
        (
          { region }: { region: string },
          $,
          { $lookup, $match }: { $lookup: (...a: unknown[]) => unknown; $match: (...a: unknown[]) => unknown },
        ) => [
          $lookup({
            from: "addresses",
            localField: "_id",
            foreignField: "userId",
            as: "addrs",
            pipeline: [$match($.country === region)],
          }),
        ],
      );
      expect(q({ region: "AU" })).toEqual([
        {
          $lookup: {
            from: "addresses",
            localField: "_id",
            foreignField: "userId",
            as: "addrs",
            pipeline: [{ $match: { country: "AU" } }],
          },
        },
      ]);
    });
  });

  describe("error: missing binding at call time", () => {
    it("throws UnknownIdentifierError naming the missing key", () => {
      const q = jsmql.compile(({ foo }: { foo: number }, $) => $.x > foo);
      let err: unknown;
      try {
        q({} as { foo: number });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toMatch(/Unknown identifier 'foo'/);
    });

    it("aliased binding names both the params-object key and the body name", () => {
      // `({ minAge: floor })` looks up `minAge` on the params object and binds
      // it to `floor` in the body. A missing `minAge` key names both so the
      // user can find either side of the rename.
      const q = jsmql.compile(({ minAge: floor }: { minAge: number }, $) => $.age >= floor);
      let err: unknown;
      try {
        q({} as { minAge: number });
      } catch (e) {
        err = e;
      }
      expect((err as Error).message).toMatch(/minAge/);
      expect((err as Error).message).toMatch(/floor/);
    });
  });

  describe("error: defaults in destructure are rejected", () => {
    it("literal default rejected with the explanatory message", () => {
      expect(() => jsmql.compile(({ minAge = 18 }: { minAge?: number }, $) => $.age > minAge)).toThrow(
        /does not support default values/,
      );
    });

    it("expression default rejected with the explanatory message", () => {
      expect(() => jsmql.compile(({ now = Date.now() }: { now?: number }, $) => $.createdAt > now)).toThrow(
        /does not support default values/,
      );
    });

    it("rejection message points at the call-site `??` fallback", () => {
      try {
        jsmql.compile(({ x = 1 }: { x?: number }, $) => $.y > x);
      } catch (err) {
        expect((err as Error).message).toMatch(/JS's `\?\?` at the call site/);
      }
    });

    it("rejection message points at the template-tag form", () => {
      try {
        jsmql.compile(({ x = 1 }: { x?: number }, $) => $.y > x);
      } catch (err) {
        expect((err as Error).message).toMatch(/template-tag form/);
      }
    });
  });

  describe("error: malformed destructure patterns", () => {
    it("nested destructure is rejected", () => {
      // Equivalent source: ({ a: { b } }, $) => $.x > b
      const src = "({ a: { b } }, $) => $.x > b";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(
        /does not support nested destructure/,
      );
    });

    it("rest pattern is rejected", () => {
      const src = "({ ...rest }, $) => $.x > rest.a";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(/does not support rest patterns/);
    });

    it("array destructure is rejected", () => {
      const src = "([a, b], $) => $.x > a";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(
        /must be an object destructure pattern/,
      );
    });
  });

  describe("error: slot ordering and counts", () => {
    it("more than three parameters is rejected", () => {
      const src = "({ a }, $, { $match }, extra) => $.x > a";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(/at most three parameters/);
    });

    it("(doc, params) — params after doc — is rejected", () => {
      const src = "($, { a }) => $.x > a";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(
        /Reorder to `\(params, \$, opsHint\)`/,
      );
    });

    it("mixed `$`/non-`$` keys in one destructure is rejected", () => {
      const src = "({ $match, minAge }, $) => $.age > minAge";
      expect(() => jsmql.compile(new Function("return " + src)() as never)).toThrow(
        /separate from the params destructure/,
      );
    });
  });

  describe("error: unsafe param values at call time", () => {
    it("NaN is rejected at bind time", () => {
      const q = jsmql.compile(({ n }: { n: number }, $) => $.x > n);
      expect(() => q({ n: NaN })).toThrow(/NaN/);
    });

    it("Infinity is rejected at bind time", () => {
      const q = jsmql.compile(({ n }: { n: number }, $) => $.x > n);
      expect(() => q({ n: Infinity })).toThrow(/Infinity/);
    });

    it("function value is rejected at bind time", () => {
      const q = jsmql.compile(({ x }: { x: unknown }, $) => $.y === x);
      expect(() => q({ x: () => 1 })).toThrow(/has no JSON representation/);
    });

    it("BigInt value is rejected at bind time", () => {
      const q = jsmql.compile(({ x }: { x: unknown }, $) => $.y === x);
      expect(() => q({ x: BigInt(1) })).toThrow(/could not be serialised/);
    });
  });

  describe("extra params keys are allowed silently", () => {
    it("extra keys not referenced in the body are ignored", () => {
      const q = jsmql.compile(({ a }: { a: number }, $) => $.x > a);
      expect(q({ a: 1, unused: 99 } as unknown as { a: number })).toEqual({ x: { $gt: 1 } });
    });
  });

  describe("string input", () => {
    it("string containing an arrow compiles like the function form", () => {
      const q = jsmql.compile("({ minAge }, $) => $.age > minAge");
      expect(q({ minAge: 21 })).toEqual({ age: { $gt: 21 } });
    });

    it("aliased destructure works in the string form too", () => {
      const q = jsmql.compile("({ minAge: floor }, $) => $.age >= floor");
      expect(q({ minAge: 18 })).toEqual({ age: { $gte: 18 } });
    });

    it("string form returns a reusable closure", () => {
      const q = jsmql.compile("({ n }, $) => $.age > n");
      expect(q({ n: 18 })).toEqual({ age: { $gt: 18 } });
      expect(q({ n: 65 })).toEqual({ age: { $gt: 65 } });
    });

    it("string input drives a pipeline end-to-end", () => {
      const q = jsmql.compile("({ id, count }, $, { $match, $limit }) => [$match($._id === id), $limit(count)]");
      expect(q({ id: 42, count: 10 })).toEqual([{ $match: { _id: 42 } }, { $limit: 10 }]);
    });

    it("missing param at call time names the binding (same path as fn form)", () => {
      const q = jsmql.compile("({ foo }, $) => $.x > foo");
      expect(() => q({})).toThrow(/Unknown identifier 'foo'/);
    });

    it("non-arrow string is rejected with the same FunctionInputError message", () => {
      expect(() => jsmql.compile("$.age > 18")).toThrow(/expects an arrow function/);
    });

    it("wrong-type input is rejected with a TypeError naming the contract", () => {
      expect(() => jsmql.compile(42 as never)).toThrow(TypeError);
      expect(() => jsmql.compile(42 as never)).toThrow(/arrow function or a string containing one/);
    });
  });
});

// ── Filter dispatch (semicolon-driven) ────────────────────────────────────────
// No semicolons → input lowers as a MongoDB Filter (the document
// `db.coll.find(filter)` takes). Translatable predicates emit indexable
// `{ field: ... }` pairs; the rest rides in an `$expr` residual (a legal
// top-level Filter operator).

describe("Filter dispatch (no semicolons)", () => {
  describe("pure query-document predicates", () => {
    it("field-vs-literal `>` translates to `{ field: { $gt: lit } }`", () => {
      expect(jsmql("$.age > 18")).toEqual({ age: { $gt: 18 } });
    });

    it("`===` against a string literal emits a bare-value equality", () => {
      expect(jsmql("$.status === 'shipped'")).toEqual({ status: "shipped" });
    });

    it("`&&` of two index-friendly conjuncts merges into one query document", () => {
      expect(jsmql("$.status === 'active' && $.age >= 18")).toEqual({ status: "active", age: { $gte: 18 } });
    });

    it("nested field paths preserve their dotted key", () => {
      expect(jsmql("$.address.country === 'AU'")).toEqual({ "address.country": "AU" });
    });
  });

  describe("$expr fallback for untranslatable expressions", () => {
    it("a non-predicate expression rides entirely in `$expr`", () => {
      expect(jsmql("$add($.a, $.b)")).toEqual({ $expr: { $add: ["$a", "$b"] } });
    });

    it("a method-call predicate isn't query-translatable and rides in `$expr`", () => {
      expect(jsmql("$.name.trim() === 'alice'")).toEqual({ $expr: { $eq: [{ $trim: { input: "$name" } }, "alice"] } });
    });
  });

  describe("bare stage call auto-wraps as a one-stage Pipeline", () => {
    // A top-level `$match(...)` / `$project(...)` / etc. without a `;` is
    // Pipeline intent — the user wrote a stage at the top level. `jsmql()`
    // auto-wraps it into a one-element pipeline so the output is directly
    // usable with `db.coll.aggregate(...)`, with no `;` discipline required.

    it("`$match(...)` without `;` auto-wraps as a Pipeline", () => {
      expect(jsmql("$match($.age > 18)")).toEqual([{ $match: { age: { $gt: 18 } } }]);
    });

    it("any registered stage call auto-wraps the same way", () => {
      expect(jsmql("$project({ name: 1 })")).toEqual([{ $project: { name: 1 } }]);
      expect(jsmql("$sort({ age: 1 })")).toEqual([{ $sort: { age: 1 } }]);
      expect(jsmql("$limit(10)")).toEqual([{ $limit: 10 }]);
    });

    it("the stage-object form `{ $match: ... }` auto-wraps the same way", () => {
      // The Compass copy-paste form (`{ $match: ... }`) is the other shape we
      // detect as Pipeline intent.
      expect(jsmql("{ $match: $.age > 18 }")).toEqual([{ $match: { age: { $gt: 18 } } }]);
    });

    it("adding the `;` produces an identical Pipeline output", () => {
      expect(jsmql("$match($.age > 18);")).toEqual([{ $match: { age: { $gt: 18 } } }]);
    });

    it("non-stage operator calls still go through Filter dispatch unaffected", () => {
      // `$add` is an expression operator, not a stage — the auto-wrap does
      // not fire, and the expression rides in `$expr`.
      expect(jsmql("$add($.a, $.b)")).toEqual({ $expr: { $add: ["$a", "$b"] } });
    });
  });

  describe("partial translation: indexable + $expr in the same document", () => {
    it("translatable + untranslatable `&&` produces both shapes side-by-side", () => {
      expect(jsmql("$.status === 'active' && $.name.trim() === 'alice'")).toEqual({
        status: "active",
        $expr: { $eq: [{ $trim: { input: "$name" } }, "alice"] },
      });
    });
  });

  describe("compile-form parameter substitution", () => {
    it("a scalar binding inlines into the query-doc literal slot", () => {
      const q = jsmql.compile(({ minAge }: { minAge: number }, $) => $.age >= minAge);
      expect(q({ minAge: 21 })).toEqual({ age: { $gte: 21 } });
    });
  });

  describe("template-tag interpolation", () => {
    it("interpolated values become query-doc literals", () => {
      const region = "AU";
      expect(jsmql`$.region === ${region}`).toEqual({ region: "AU" });
    });
  });
});

// ── Pipeline dispatch (any `;`) ───────────────────────────────────────────────
// Any presence of `;` flips the input to Pipeline mode. Each statement must be
// a stage call (`$match(...)`, `$project(...)`, …) — a bare expression is an
// error with an actionable `$match(...)` suggestion.

describe("Pipeline dispatch (semicolons present)", () => {
  it("a single trailing `;` produces a one-element stage array", () => {
    expect(jsmql("$match($.age > 18);")).toEqual([{ $match: { age: { $gt: 18 } } }]);
  });

  it("`;`-separated stages compile to a multi-stage pipeline", () => {
    expect(jsmql("$match($.age > 18); $sort({ age: 1 })")).toEqual([
      { $match: { age: { $gt: 18 } } },
      { $sort: { age: 1 } },
    ]);
  });

  it("a bare predicate as a pipeline statement throws with a $match hint", () => {
    expect(() => jsmql("$.age > 18;")).toThrow(/To filter documents on a predicate, wrap it as `\$match\(\.\.\.\)`/);
  });

  it("the bare-predicate error carries the offending statement's position", () => {
    // The CodegenError's `.pos` should point at the offending statement so
    // tooling can underline it. The first stmt starts at offset 0; here we
    // use a leading filler to get a non-zero offset.
    const r = jsmql.validate("   $.age > 18;");
    expect(r.valid).toBe(false);
    expect(r.errors[0].code).toBe("CODEGEN_ERROR");
    expect(r.errors[0].pos).toBeGreaterThan(0);
  });
});

// ── Function-form dispatch parity ─────────────────────────────────────────────
// Expression-body arrow → Filter; block-body arrow → Pipeline. The
// classification is body-shape-driven, mirroring the string form's `;` rule.

describe("function-form dispatch parity", () => {
  it("expression-body arrow lowers as a Filter", () => {
    expect(jsmql(($) => $.age > 18)).toEqual({ age: { $gt: 18 } });
  });

  it("block-body arrow lowers as a Pipeline", () => {
    const result = jsmql(($, { $match, $sort }) => {
      $match($.age > 18);
      $sort({ age: 1 });
    });
    expect(result).toEqual([{ $match: { age: { $gt: 18 } } }, { $sort: { age: 1 } }]);
  });
});

// ── `jsmql.expr()` — partial / unfinished expression ──────────────────────────
// `jsmql.expr()` lowers a bare expression to raw aggregation-expression form
// (no Filter wrapper, no `$expr` envelope). Use it for the shape that lives
// inside a Pipeline stage body or as the update document in `updateOne`.
// `;`-separated / update op / array-literal-Pipeline inputs behave exactly
// like `jsmql()` — only the bare-expression branch differs.

describe("jsmql.expr()", () => {
  it("a bare predicate lowers to its aggregation-expression form (no Filter wrap)", () => {
    expect(jsmql.expr("$.age > 18")).toEqual({ $gt: ["$age", 18] });
  });

  it("a bare non-predicate lowers as-is (no `$expr` envelope)", () => {
    expect(jsmql.expr("$add($.a, $.b)")).toEqual({ $add: ["$a", "$b"] });
  });

  it("a update op lowers like jsmql() — to a `$set` update document", () => {
    expect(jsmql.expr("$.name = $.name.toUpperCase()")).toEqual({ $set: { name: { $toUpper: "$name" } } });
  });

  it("a `;`-separated input lowers like jsmql() — to a Pipeline", () => {
    expect(jsmql.expr("$match($.age > 18); $sort({ age: 1 });")).toEqual([
      { $match: { age: { $gt: 18 } } },
      { $sort: { age: 1 } },
    ]);
  });

  it("accepts the arrow form", () => {
    expect(jsmql.expr(($) => $.age > 18)).toEqual({ $gt: ["$age", 18] });
  });

  it("accepts the template-tag form", () => {
    const region = "AU";
    expect(jsmql.expr`$.region === ${region}`).toEqual({ $eq: ["$region", "AU"] });
  });

  it("a stage call without `;` here does NOT trip the Filter-only guard", () => {
    // The guard lives in `generateFilter`, which `jsmql.expr` doesn't go
    // through — so `$match(...)` in expression mode lowers like any other
    // operator call (useful inside a hand-written sub-pipeline literal).
    expect(jsmql.expr("$match($.a === 0)")).toEqual({ $match: { $eq: ["$a", 0] } });
  });

  it("rejects wrong-typed input with a TypeError naming the entry point", () => {
    expect(() => (jsmql.expr as (x: unknown) => unknown)(42)).toThrow(/jsmql\.expr\(\) expects a string/);
  });
});

describe("context-reference prefixes ($$, $$$, $$$$)", () => {
  // Three new prefix levels. Lex + parse succeed; codegen throws a reserved-syntax
  // error (semantics deferred — see docs/specs/context-references.md). Both dot-ident
  // (`$$.foo`) and bracket-expr (`$$[x]`) postfix forms are accepted because the
  // prefix tokens don't bake the dot in; standard MemberAccess/IndexAccess composes.
  // Tests use the string form because `$$` / `$$$` / `$$$$` aren't yet declared
  // as ambient globals — that's part of the future-API surface.

  describe("$$ — current collection", () => {
    // $$ lights up the `$$.push(...)` → `$unionWith` shape. Any other use of $$
    // (`.foo` member access, `["foo"]` index access, `.bar()` method call,
    // bare reference, RHS use) is rejected by the CollectionRef codegen case
    // with a precise "statement-only / only .push(...)" message. See
    // docs/specs/union-stage.md.
    it("dot-ident form (not .push / .filter) throws statement-only at codegen", () => {
      expect(() => jsmql.expr("$$.foo")).toThrow(
        /statement-only and supports '\.push\(\.\.\.\)', '\.filter\(\.\.\.\)' in the facet pattern, and '\$\$ = <expr>'/,
      );
    });
    it("bracket-expr form (string literal) throws statement-only at codegen", () => {
      expect(() => jsmql.expr('$$["foo"]')).toThrow(
        /statement-only and supports '\.push\(\.\.\.\)', '\.filter\(\.\.\.\)' in the facet pattern, and '\$\$ = <expr>'/,
      );
    });
    it("bracket-expr form (compile-form param) throws when the compiled function is called", () => {
      const q = jsmql.compile("({ name }) => $$[name]");
      expect(() => q({ name: "users" })).toThrow(/statement-only and supports '\.push/);
    });
    it(".pos points at the prefix in validate()", () => {
      const r = jsmql.validate("$$.foo");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/statement-only and supports '\.push/);
      expect(r.errors[0].pos).toBe(0);
    });
    it("wrong method on $$ surfaces a precise 'use .push / .filter' hint", () => {
      expect(() => jsmql("$$.pop({a:1})")).toThrow(
        /'\$\$' \(current collection\) only supports \.push\(\.\.\.\) and \.filter\(\.\.\.\) — \.pop\(\) is not defined/,
      );
    });
  });

  describe("$$$ — current database", () => {
    it("dot-ident form: $$$.myColl is not a value outside a lookup or $out chain", () => {
      // Once $$$ lights up the `$$$.<coll>.find/filter(...)` join syntax and
      // the `$$$.<coll> = …` $out sugar, the bare reference message points
      // at both supported shapes.
      expect(() => jsmql.expr("$$$.myColl")).toThrow(/\$lookup read.*\$out write/);
    });
    it('bracket-expr form: $$$["coll"] is not a value either', () => {
      expect(() => jsmql.expr('$$$["coll"]')).toThrow(/\$lookup read.*\$out write/);
    });
    it("$$$.<coll>.find(...) outside Pipeline mode hits the bare-reference error", () => {
      // Bare expression form (no `;`, not in jsmql.pipeline) — `$$$` only
      // means something as a Pipeline-mode lookup; the error names that.
      const r = jsmql.validate("$$$.myColl.find(o => o.x === $.y)");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/requires Pipeline mode/);
      expect(r.errors[0].pos).toBe(0);
    });
  });

  describe("$$$$ — current cluster", () => {
    // Like $$$, the four bracket combos all reach the same bare-reference
    // error when used outside the supported cross-database lookup or $out
    // sugar shapes. Lookup behaviour: test/lookup.test.ts; $out: test/out.test.ts.
    it("dot.dot: $$$$.myDb.myColl is not a value outside a lookup or $out chain", () => {
      expect(() => jsmql.expr("$$$$.myDb.myColl")).toThrow(/cross-database \$lookup.*cross-database \$out/);
    });
    it('bracket[bracket]: $$$$["db"]["coll"] is not a value either', () => {
      expect(() => jsmql.expr('$$$$["db"]["coll"]')).toThrow(/cross-database \$lookup.*cross-database \$out/);
    });
    it('bracket.dot: $$$$["db"].coll is not a value either', () => {
      expect(() => jsmql.expr('$$$$["db"].coll')).toThrow(/cross-database \$lookup.*cross-database \$out/);
    });
    it('dot.bracket: $$$$.db["coll"] is not a value either', () => {
      expect(() => jsmql.expr('$$$$.db["coll"]')).toThrow(/cross-database \$lookup.*cross-database \$out/);
    });
    it(".pos points at the $$$$ prefix", () => {
      const r = jsmql.validate("  $$$$.db.coll");
      expect(r.valid).toBe(false);
      expect(r.errors[0].pos).toBe(2);
    });
  });

  describe("parser sanity-guards", () => {
    it("bare $$ without . or [ → CollectionRef codegen error (statement-only message)", () => {
      // Once `$out` sugar allows bare `$$` as the RHS of `$$$.coll = $$`, the
      // parser stops pre-rejecting bare `$$` and codegen surfaces the
      // actionable "statement-only" message when `$$` lands somewhere
      // meaningless. The typo case `$$foo` (no separator) is still rejected
      // at parse time — see the next test.
      const r = jsmql.validate("$$");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/'\$\$' \(current collection\) is statement-only/);
      expect(r.errors[0].pos).toBe(0);
    });
    it("$$foo (ident with no . or [) → actionable ParseError", () => {
      const r = jsmql.validate("$$foo");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/Expected '\.<name>' or '\[<expr>\]' after '\$\$'/);
    });
    it("$$$ alone → message names '$$$' specifically", () => {
      const r = jsmql.validate("$$$");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/Expected '\.<name>' or '\[<expr>\]' after '\$\$\$'/);
    });
    it("$$$$ alone → message names '$$$$' specifically", () => {
      const r = jsmql.validate("$$$$");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/Expected '\.<name>' or '\[<expr>\]' after '\$\$\$\$'/);
    });
  });

  describe("lexer cap", () => {
    it("5 dollars → LexError naming the supported levels", () => {
      const r = jsmql.validate("$$$$$.x");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/Up to 4 levels of context reference are supported/);
      expect(r.errors[0].pos).toBe(0);
    });
    it("6 dollars → same LexError", () => {
      const r = jsmql.validate("$$$$$$.x");
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toMatch(/Up to 4 levels of context reference are supported/);
    });
  });

  it("existing $. behaviour is unaffected by the new prefix tokens", () => {
    expect(jsmql.expr("$abs($.delta)")).toEqual({ $abs: "$delta" });
    expect(jsmql.expr("$abs($.address.city)")).toEqual({ $abs: "$address.city" });
  });
});
