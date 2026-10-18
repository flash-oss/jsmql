// HR7: a value that is PROVEN to have another kind than its slot takes is refused, even
// where the server accepts the MQL. A value of unknown kind passes. The `$op(…)` escape
// hatch passes every value as written. See docs/LANG_RULES.md and docs/specs/types.md.

import { describe, expect, it } from "vitest";
import { MinKey, ObjectId, Timestamp } from "mongodb";
import { consult } from "../src/compiler/emit/consult.ts";
import { select, UNPROVEN } from "../src/compiler/emit/select.ts";
import { CodegenError } from "../src/errors.ts";
import { jsmql } from "../src/index.ts";

/** The error a source raises, or fails the test. */
function refusal(run: () => unknown): CodegenError {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(CodegenError);
    return e as CodegenError;
  }
  throw new Error("the source compiled, and a refusal was expected");
}

describe("kinds — an operator refuses operands of proven kinds that never combine", () => {
  it('"a" + 1 is refused, and the message names the operands', () => {
    expect(() => jsmql.expr('"a" + 1')).toThrow(/'\+' takes operands of one kind, but got a string and a number\./);
  });

  it("a field of unknown kind passes, and the server decides", () => {
    expect(jsmql.expr("$.str + 1")).toEqual({ $add: ["$str", 1] });
  });

  it("a method that gives a string proves it", () => {
    expect(() => jsmql.expr("$.str.trim() + 1")).toThrow(/'\+' takes operands of one kind/);
  });

  it("a binding carries its proof into a later statement", () => {
    expect(() => jsmql.pipeline("let s = $.str.trim(); $.x = s + 1;")).toThrow(/'\+' takes operands of one kind/);
  });

  it("a stage carries its proof into a later statement", () => {
    expect(() => jsmql.pipeline('$.a = "x"; $.b = $.a + 1;')).toThrow(/'\+' takes operands of one kind/);
  });

  it("the position is the operand that breaks the rule", () => {
    const source = "$.str.trim() + 1";
    expect(refusal(() => jsmql.expr(source)).pos).toBe(source.indexOf("1"));
  });

  it("=== between constants of two kinds is refused, not folded", () => {
    expect(() => jsmql.expr('1 === "a"')).toThrow(/'===' takes operands of one kind, but got a number and a string\./);
  });

  it("an ordering between two kinds is refused", () => {
    expect(() => jsmql.expr('"a" < 1')).toThrow(/'<' takes operands of one kind/);
  });

  it("a null is no number: -null is refused", () => {
    expect(() => jsmql.expr("-null")).toThrow(/'-' argument 1 takes a number, but got null\./);
  });

  it("a bitwise operator takes an integer, as the server does", () => {
    expect(() => jsmql.expr("$.n | 1.5")).toThrow(/'\|' argument 2 takes an integer, but got a fraction\./);
    expect(() => jsmql.expr("$.n & $.m & 2.5")).toThrow(/'&' argument 3 takes an integer, but got a fraction\./);
    expect(() => jsmql.expr("~1.5")).toThrow(/'~' argument 1 takes an integer, but got a fraction\./);
    expect(jsmql.expr("$.n | 1")).toEqual({ $bitOr: ["$n", 1] });
  });

  it("a pattern slot names each kind it takes once", () => {
    expect(() => jsmql.expr("$.s.match(5)")).toThrow(
      "'.match()' argument 1 takes a regular expression or a string, but got a number.",
    );
    expect(jsmql.expr('$.s.matchAll("a.")')).toEqual({
      $cond: [{ $lte: ["$s", null] }, null, { $regexFindAll: { input: "$s", regex: "a." } }],
    });
  });

  it("x[i] takes a key of every kind but null", () => {
    expect(() => jsmql.expr("$.a[null]")).toThrow("'[…]' key takes a value, but got null.");
    expect(() => jsmql.expr("$.a?.[null]")).toThrow("'[…]' key takes a value, but got null.");
    expect(() => jsmql("$.o = { b: null }; $.r = $.a[$.o.b];")).toThrow("'[…]' key takes a value, but got null.");
    expect(jsmql.expr('$.o["k"]')).toEqual({ $getField: { field: "k", input: { $ifNull: ["$o", {}] } } });
  });

  it("an option key and a list element refuse null, written or proven", () => {
    expect(() => jsmql.expr("$.d.set({ year: null })")).toThrow("'.set()' year takes an integer, but got null.");
    expect(() => jsmql.expr('$.d.startOf("week", { startOfWeek: null })')).toThrow(
      "'.startOf()' startOfWeek takes a string, but got null.",
    );
    const pickNull =
      "'.pick()' element 1 takes a field NAME to write: a plain string with no '$' and no dot, but got null.";
    expect(() => jsmql.expr("$.o.pick([null])")).toThrow(pickNull);
    expect(() => jsmql("$.o = { b: null }; $.r = $.o.pick([$.o.b]);")).toThrow(pickNull);
    // A string that the server refuses as a name keeps its own refusal.
    expect(() => jsmql.expr('$.o.pick(["a.b"])')).toThrow(/'\.pick\(\)' element 1 names a field to WRITE/);
    expect(() => jsmql('$.o = { b: null }; $.r = $.d.startOf("week", { timezone: $.o.b });')).toThrow(
      "'.startOf()' timezone takes a string, but got null.",
    );
    // A read of a field that no stage wrote keeps its own refusal.
    expect(() => jsmql('$.o = {}; $.r = $.d.startOf("week", { timezone: $.o.b });')).toThrow(
      /reads a field that '\$\.o' does not have/,
    );
  });

  it("a callback slot and a document slot of the stream refuse null as a wrong kind", () => {
    expect(() => jsmql.expr("$.a.map(null)")).toThrow("'.map()' argument 1 takes a callback, but got null.");
    expect(() => jsmql.expr("$.a.filter(null)")).toThrow("'.filter()' argument 1 takes a callback, but got null.");
    expect(() => jsmql.expr("$.a.reduce(null, 0)")).toThrow("'.reduce()' argument 1 takes a callback, but got null.");
    expect(() => jsmql.expr("$.o.mapValues(null)")).toThrow(
      "'.mapValues()' argument 1 takes a callback, but got null.",
    );
    expect(() => jsmql.expr("$.a.groupBy(null)")).toThrow("'.groupBy()' argument 1 takes a key, but got null.");
    expect(() => jsmql.expr("$.a.differenceBy($.b, null)")).toThrow(
      "'.differenceBy()' argument 2 takes a key, but got null.",
    );
    expect(() => jsmql("$$.filter(null);")).toThrow("'.filter()' argument 1 takes a predicate, but got null.");
    // A value of another kind keeps the message that names each spelling the slot takes.
    expect(() => jsmql.expr("$.a.groupBy(1)")).toThrow(/takes a key here — an arrow/);
    expect(() => jsmql("$$.push($.a, null);")).toThrow(
      "'$$.push()' argument 2 takes a document, but got null. Push a document ('$$.push({ … })'), a written list of them ('$$.push(...[{ … }])'), or another collection ('$$.push(...$$$.<coll>)').",
    );
    expect(() => jsmql("$$.concat(null);")).toThrow(/^'\$\$\.concat\(\)' argument 1 takes a document, but got null\./);
    expect(() => jsmql("$$$.c.push(null);")).toThrow(
      /^'\$\$\$\.<coll>\.push\(\)' argument 1 takes a document, but got null\./,
    );
  });

  it("a conversion and the condition of assert() take every kind but null", () => {
    expect(() => jsmql.expr("Number(null)")).toThrow("'Number()' argument 1 takes a value, but got null.");
    expect(() => jsmql.expr("String(null)")).toThrow("'String()' argument 1 takes a value, but got null.");
    expect(() => jsmql.expr("Boolean(null)")).toThrow("'Boolean()' argument 1 takes a value, but got null.");
    expect(() => jsmql("assert(null);")).toThrow("'assert()' argument 1 takes a value, but got null.");
    expect(jsmql.expr("String($.n)")).toEqual({ $toString: "$n" });
  });

  it("a null that the call passes in, or that the proof shows, is refused too", () => {
    expect(() => jsmql.expr`-${null}`).toThrow(/'-' argument 1 takes a number, but got null\./);
    expect(() => jsmql("$.o = { b: null }; $.r = $.a.slice($.o?.b);")).toThrow(
      "'.slice()' argument 1 takes an integer, but got null.",
    );
    // A read of a field that no stage wrote keeps its own refusal, which names the field.
    expect(() => jsmql("$.o = {}; $.r = $.a.slice($.o?.b);")).toThrow(/reads a field that '\$\.o' does not have/);
  });

  it("x === null stays the test of a missing value", () => {
    expect(jsmql.expr("$.s.trim() === null")).toEqual({ $eq: [{ $trim: { input: "$s" } }, null] });
  });

  it("a number slot refuses a proven boolean", () => {
    expect(() => jsmql.expr("($.a > 1) * 2")).toThrow(/'\*' argument 1 takes a number, but got a boolean\./);
  });

  it("a ternary and a logical operator take every kind", () => {
    expect(() => jsmql.expr('$.a ? "x" : 1')).not.toThrow();
    expect(() => jsmql.expr('"a" || 1')).not.toThrow();
  });

  it("x in [ … ] takes an element of the list", () => {
    expect(() => jsmql.expr('1 in ["a", "b"]')).toThrow(
      /'in' argument 1 takes an element of the array, but got a number, and the array holds strings\./,
    );
    expect(jsmql.expr("$.x in [1, 2]")).toEqual({ $in: ["$x", [1, 2]] });
  });

  it("a null element is an element of the list, so a null needle fits it", () => {
    expect(jsmql.expr("[1, null].has(null)")).toBe(true);
    expect(jsmql.expr("null in [1, null]")).toBe(true);
    expect(jsmql.expr("[1, null].without(null)")).toEqual([1]);
    expect(jsmql.expr("[1, null].lastIndexOf(null)")).toBe(1);
    expect(jsmql.expr("null in [1, $.x]")).toEqual({ $in: [null, [1, "$x"]] });
    expect(jsmql("$.a = [1, null]; $.r = $.a.has(null);")).toEqual([
      { $set: { a: [1, null] } },
      { $set: { r: { $in: [null, "$a"] } } },
    ]);
    expect(jsmql("$.a = [1, null]; $.r = $.a.indexOf(null);")).toEqual([
      { $set: { a: [1, null] } },
      { $set: { r: { $indexOfArray: ["$a", null] } } },
    ]);
    // A read that the proof shows is null is a null element too.
    expect(jsmql("$.o = { b: null }; $.r = [1, $.o.b].has(null);")).toEqual([
      { $set: { o: { $mergeObjects: [{ b: null }] } } },
      { $set: { r: { $in: [null, [1, "$o.b"]] } } },
    ]);
  });

  it("a null needle is refused where no element is null, and the message names a held null", () => {
    expect(() => jsmql.expr("[1, 2].has(null)")).toThrow(
      "'.has()' argument 1 takes an element of the array, but got null, and the array holds numbers.",
    );
    expect(() => jsmql.expr("[1, 2].without(null)")).toThrow(/'\.without\(\)' argument 1 takes an element/);
    expect(() => jsmql("$.a = [1, 2]; $.r = $.a.has(null);")).toThrow(/'\.has\(\)' argument 1 takes an element/);
    expect(() => jsmql.expr('[1, null].has("a")')).toThrow(
      "'.has()' argument 1 takes an element of the array, but got a string, and the array holds numbers or null.",
    );
  });

  it("an element of unknown kind makes the elements unknown, as a field path does", () => {
    // A regular expression and a Timestamp have no kind that the registry names.
    for (const v of [/a/, new Timestamp({ t: 1, i: 1 })]) {
      expect(jsmql.expr`[1, ${v}].has("x")`).toEqual({ $in: ["x", [1, v]] });
      expect(jsmql.expr`"x" in [1, ${v}]`).toEqual({ $in: ["x", [1, v]] });
      expect(jsmql.expr`[1, ${v}].indexOf("x")`).toEqual({ $indexOfArray: [[1, v], "x"] });
      expect(jsmql.expr`[1, ${v}].without("x")`).toEqual({
        $filter: { input: [1, v], as: "jsmqlItem", cond: { $not: [{ $in: ["$$jsmqlItem", ["x"]] }] } },
      });
      expect(jsmql`$.a = [1, ${v}]; $.r = $.a.has("x");`).toEqual([
        { $set: { a: [1, v] } },
        { $set: { r: { $in: ["x", "$a"] } } },
      ]);
      const build = jsmql.compile(({ e }: { e: unknown }, { $ }: { $: any }) => [1, e].has("x"));
      expect(build({ e: v })).toEqual({ $expr: { $in: ["x", [1, v]] } });
    }
    // The compiler still judges an element of a kind that the registry names.
    expect(() => jsmql.expr`[1, ${new MinKey()}].has("x")`).toThrow(/'\.has\(\)' argument 1 takes an element/);
  });

  it("a call that the program passes in is judged by its kind as a literal is", () => {
    const build = jsmql.compile(({ n }: { n: unknown }, { $ }: { $: any }) => $.s.trim() + n);
    expect(() => build({ n: 1 })).toThrow(/'\+' takes operands of one kind/);
  });

  it("validate() keeps its placeholders out of the check", () => {
    expect(jsmql.validate(({ n }: { n: unknown }, { $ }: { $: any }) => $.age > n)).toEqual({
      valid: true,
      errors: [],
    });
  });
});

/** The BSON type a value carries. `toEqual` holds MinKey equal to MaxKey, so a test reads the tag. */
const tagOf = (v: unknown): unknown => (v as { _bsontype?: unknown })._bsontype;

describe("kinds — the query road obeys HR7 too", () => {
  it("a stage that proves a number refuses a string in a later $match", () => {
    expect(() => jsmql.pipeline('$.n = 1; $match($.n === "x");')).toThrow(
      /'===' takes operands of one kind, but got a number and a string\./,
    );
    expect(() => jsmql.pipeline('$.n = 1; $match($.n < "x");')).toThrow(/'<' takes operands of one kind/);
  });

  it("a null needle fits a list that holds a null, and is refused by a list that holds none", () => {
    expect(jsmql.filter("null in [1, null]")).toEqual({ $expr: true });
    expect(jsmql.filter("null in [1, $.x]")).toEqual({ $expr: { $in: [null, [1, "$x"]] } });
    expect(jsmql.pipeline("$.a = [1, null]; $match($.a.has(null));")).toEqual([
      { $set: { a: [1, null] } },
      { $match: { a: null } },
    ]);
    expect(() => jsmql.filter("null in [1, 2]")).toThrow(
      "'in' argument 1 takes an element of the array, but got null, and the array holds numbers.",
    );
    expect(() => jsmql.pipeline("$.a = [1, 2]; $match($.a.has(null));")).toThrow(
      /'\.has\(\)' argument 1 takes an element of the array, but got null/,
    );
  });

  it("an element of unknown kind makes the elements of a list or a field unknown", () => {
    const re = /a/;
    expect(jsmql.filter`"x" in [1, ${re}]`).toEqual({ $expr: { $in: ["x", [1, re]] } });
    expect(jsmql.filter`[1, ${re}].has("x")`).toEqual({ $expr: { $in: ["x", [1, re]] } });
    expect(jsmql.pipeline`$.a = [1, ${re}]; $match($.a === "x");`).toEqual([
      { $set: { a: [1, re] } },
      { $match: { a: "x" } },
    ]);
  });

  it("a field of unknown kind passes, and the server decides", () => {
    expect(jsmql.pipeline('$match($.n === "x");')).toEqual([{ $match: { n: "x" } }]);
  });

  it("a field that holds an array compares through the kind of its elements (SR2)", () => {
    expect(jsmql.pipeline('$.tags = ["a"]; $match($.tags === "x");')).toEqual([
      { $set: { tags: ["a"] } },
      { $match: { tags: "x" } },
    ]);
    expect(() => jsmql.pipeline('$.tags = [1]; $match($.tags === "x");')).toThrow(/'===' takes operands of one kind/);
  });

  it("an array operand keeps the array as a possible kind of the field", () => {
    expect(jsmql.pipeline('$.tags = ["a"]; $match($.tags === ["a"]);')).toEqual([
      { $set: { tags: ["a"] } },
      { $match: { $expr: { $eq: ["$tags", ["a"]] } } },
    ]);
  });

  // The query cell of an operator states the kinds of its value cell, so the two forms refuse alike.
  for (const op of ["<", ">", "<=", ">="]) {
    it(`'${op}' in a query takes the kinds of its value form`, () => {
      for (const src of [`$.x = null; $.r = $.x ${op} 1;`, `$.x = null; $match($.x ${op} 1);`]) {
        expect(() => jsmql.pipeline(src)).toThrow(
          `'${op}' argument 1 takes a number, a string, a date or an ObjectId, but got null.`,
        );
      }
      expect(() => jsmql.pipeline(`$.o = { a: 1 }; $match($.o ${op} 1);`)).toThrow(
        `'${op}' argument 1 takes a number, a string, a date or an ObjectId, but got a document.`,
      );
    });
  }

  it("'in' in a query takes an element of its list, as its value form does", () => {
    for (const src of ['$.n = 1; $.r = $.n in ["a"];', '$.n = 1; $match($.n in ["a"]);']) {
      expect(() => jsmql.pipeline(src)).toThrow(
        "'in' argument 1 takes an element of the array, but got a number, and the array holds strings.",
      );
    }
    // A query tests each element of an array field against the list (SR2).
    expect(jsmql.pipeline('$.tags = ["a"]; $match($.tags in ["a", "b"]);')).toEqual([
      { $set: { tags: ["a"] } },
      { $match: { tags: { $in: ["a", "b"] } } },
    ]);
    expect(() => jsmql.pipeline('$.tags = [1]; $match($.tags in ["a"]);')).toThrow(
      "'in' argument 1 takes an element of the array, but got an element of 'tags' that is a number, and the array holds strings.",
    );
    // A list that holds an array also tests the whole field.
    expect(jsmql.pipeline('$.tags = ["a"]; $match($.tags in [["a"]]);')).toEqual([
      { $set: { tags: ["a"] } },
      { $match: { tags: { $in: [["a"]] } } },
    ]);
  });

  it("an ObjectId is ordered, in a query and in an expression", () => {
    const id = new ObjectId("64b7f9c2e1a2b3c4d5e6f7a8");
    expect(jsmql.filter('$.id > ObjectId("64b7f9c2e1a2b3c4d5e6f7a8")')).toEqual({ id: { $gt: id } });
    expect(jsmql.expr('$.id > ObjectId("64b7f9c2e1a2b3c4d5e6f7a8")')).toEqual({ $gt: ["$id", id] });
  });

  it("a sentinel compares with every kind, in a query and in an expression", () => {
    expect(jsmql.filter("$.a === MinKey()")).toEqual({ a: new MinKey() });
    const max = (jsmql.filter("$.a < MaxKey()") as { a: { $lt: unknown } }).a.$lt;
    expect(tagOf(max)).toBe("MaxKey");
    expect(jsmql.expr("$.a === MinKey()")).toEqual({ $eq: ["$a", new MinKey()] });
    expect(tagOf((jsmql.expr("$.a < MaxKey()") as { $lt: unknown[] }).$lt[1])).toBe("MaxKey");
    expect(() => jsmql.expr('ObjectId("64b7f9c2e1a2b3c4d5e6f7a8") < MaxKey()')).not.toThrow();
  });

  it("a sentinel never sets the kind of a comparison", () => {
    expect(() => jsmql.pipeline('$.n = 1; $match($.n < MaxKey() && $.n > "x");')).toThrow(
      /'>' takes operands of one kind/,
    );
  });

  it("a sentinel does no arithmetic", () => {
    expect(() => jsmql.expr("$.a + MinKey()")).toThrow(
      /'\+' argument 2 takes a number or a string, but got a MinKey\./,
    );
    expect(() => jsmql.expr("$.a * MaxKey()")).toThrow(/'\*' argument 2 takes a number/);
  });
});

describe("kinds — the escape hatch is the developer's own MQL (HR2)", () => {
  it('$max(1, "a") passes both values as written', () => {
    expect(jsmql.expr('$max(1, "a")')).toEqual({ $max: [1, "a"] });
  });

  it("$add of a string and a number passes as written", () => {
    expect(jsmql.expr('$add("a", 1)')).toEqual({ $add: ["a", 1] });
  });
});

describe("kinds — the dispatcher states each fault by the rule that broke", () => {
  const fake = (rule: object) => ({ kind: "lower", name: "$x", position: "value", cell: rule }) as never;
  const rule = (args: object) => ({ args: { sig: "a", exact: 2, ...args }, emit: () => null });
  const proofs = (...args: (readonly string[] | "unknown")[]) => ({
    args: args as never,
    elements: "unknown" as const,
  });

  it("a slot kind refuses a value whose every possible kind is another", () => {
    const sel = select(
      fake(rule({ slotType: { 0: "number" } })),
      { kind: "none" },
      { kind: "multiple" },
      2,
      proofs(["string", "bool"], "unknown"),
    );
    expect(sel).toMatchObject({ kind: "wrongKind", fault: { rule: "slot", slot: 0 } });
  });

  it("a union proof passes when one possible kind fits", () => {
    const sel = select(
      fake(rule({ slotType: { 0: "number" } })),
      { kind: "none" },
      { kind: "multiple" },
      2,
      proofs(["string", "number"], "unknown"),
    );
    expect(sel.kind).toBe("rule");
  });

  it("rest types every slot that slotType does not name", () => {
    const sel = select(
      fake(rule({ slotType: { 0: "any" }, rest: "string" })),
      { kind: "none" },
      { kind: "multiple" },
      2,
      proofs(["number"], ["number"]),
    );
    expect(sel).toMatchObject({ kind: "wrongKind", fault: { rule: "slot", slot: 1 } });
  });

  it("homogeneous is set by the first operand of one proven kind", () => {
    const args = { rest: "any", homogeneous: true };
    const run = (...p: (readonly string[] | "unknown")[]) =>
      select(fake(rule(args)), { kind: "none" }, { kind: "multiple" }, 2, proofs(...p));
    expect(run("unknown", ["number"]).kind).toBe("rule");
    expect(run(["string", "number"], ["number"]).kind).toBe("rule");
    expect(run(["null"], ["number"]).kind).toBe("rule");
    expect(run(["string"], ["number"])).toMatchObject({
      kind: "wrongKind",
      fault: { rule: "homogeneous", first: 0, slot: 1 },
    });
  });

  it("an element slot compares with the proof of the element source", () => {
    const element = rule({ slotType: { 0: "element" }, rest: "any" });
    const run = (arg: readonly string[], held: readonly string[] | "unknown") =>
      select(fake(element), { kind: "none" }, { kind: "multiple" }, 2, {
        args: [arg as never, "unknown"],
        elements: held as never,
      });
    expect(run(["number"], ["string"])).toMatchObject({ kind: "wrongKind", fault: { rule: "element" } });
    expect(run(["number"], ["string", "number"]).kind).toBe("rule");
    expect(run(["number"], "unknown").kind).toBe("rule");
  });

  it("a null fits only a slot that takes any", () => {
    const run = (type: "number" | "any") =>
      select(
        fake(rule({ slotType: { 0: type } })),
        { kind: "none" },
        { kind: "multiple" },
        2,
        proofs(["null"], "unknown"),
      );
    expect(run("number").kind).toBe("wrongKind");
    expect(run("any").kind).toBe("rule");
  });

  it("an unproven call passes every rule", () => {
    expect(
      select(fake(rule({ slotType: { 0: "number" } })), { kind: "none" }, { kind: "multiple" }, 2, UNPROVEN).kind,
    ).toBe("rule");
  });
});

describe("kinds — a row can demand one kind of every element of its receiver", () => {
  it("refuses a receiver whose elements are proven to be another kind, and names what it holds", () => {
    const e = refusal(() => jsmql.expr("[{ a: 1 }].max()"));
    expect(e.message).toMatch(/'\.max\(\)' takes numbers, but the array holds a document\./);
    expect(e.pos).toBe(0);
  });

  it("passes an array of the one kind, and an array of unknown elements", () => {
    expect(() => jsmql.expr("[1, 2].max()")).not.toThrow();
    expect(() => jsmql.expr("$.a.max()")).not.toThrow();
  });

  it("the dispatcher reads the row, not a name", () => {
    const sel = select(
      consult("max", "value"),
      { kind: "value", family: "array", lowered: null },
      { kind: "none" },
      0,
      { args: [], elements: ["object"] },
    );
    expect(sel).toMatchObject({ kind: "wrongKind", fault: { rule: "elements", expected: "number" } });
  });
});

describe("kinds — a value of two or more possible kinds is refused only when NO kind fits", () => {
  it("an array whose elements can be a number passes a row that takes numbers", () => {
    // `x + 1` is a number or a date, so the elements are not proven wrong
    expect(jsmql.expr("$.nums.map(x => x + 1).sum()")).toEqual({
      $sum: { $map: { input: { $ifNull: ["$nums", []] }, as: "x", in: { $add: ["$$x", 1] } } },
    });
    expect(jsmql.expr("$.nums.map(x => x + 1).max()")).toEqual({
      $max: { $map: { input: { $ifNull: ["$nums", []] }, as: "x", in: { $add: ["$$x", 1] } } },
    });
  });

  it("an array whose elements are proven documents is refused", () => {
    expect(() => jsmql.expr("$.xs.map(x => ({ v: x })).sum()")).toThrow(
      /'\.sum\(\)' takes numbers, but the array holds a document\./,
    );
  });

  it("the dispatcher passes a union of held kinds that includes the kind the row takes", () => {
    const run = (held: readonly string[]) =>
      select(consult("max", "value"), { kind: "value", family: "array", lowered: null }, { kind: "none" }, 0, {
        args: [],
        elements: held as never,
      });
    expect(run(["number", "date"]).kind).not.toBe("wrongKind");
    expect(run(["string", "date"]).kind).toBe("wrongKind");
  });

  it("two operands of one comparison fit when one possible kind of each is shared", () => {
    expect(() => jsmql.expr('($.a ? "x" : 1) === 1')).not.toThrow();
    expect(() => jsmql.expr('($.a ? "x" : 1) === true')).toThrow(
      /'===' takes operands of one kind, but got a string or a number and a boolean\./,
    );
  });
});

describe("kinds — a literal array is judged by each position, a computed array by its set of kinds", () => {
  it("[1, 'a'].max() is refused, because the string can never be a number", () => {
    const e = refusal(() => jsmql.expr('[1, "a"].max()'));
    expect(e.message).toMatch(/'\.max\(\)' takes numbers, but the array holds a number and a string\./);
    expect(() => jsmql.expr('[1, "a"].sum()')).toThrow(/'\.sum\(\)' takes numbers/);
  });

  it("a position of unknown kind passes, and a certain position is still judged", () => {
    expect(jsmql.expr("[$.x, 2].max()")).toEqual({ $max: ["$x", 2] });
    expect(() => jsmql.expr('[$.x, "a"].max()')).toThrow(/'\.max\(\)' takes numbers/);
  });

  it("a null element is no number: it is judged as a null operand is", () => {
    expect(() => jsmql.expr("[1, null].sum()")).toThrow(
      /'\.sum\(\)' takes numbers, but the array holds a number and null\./,
    );
    expect(() => jsmql.expr("[1, null].max()")).toThrow(/'\.max\(\)' takes numbers/);
    expect(() => jsmql.expr("[null].mean()")).toThrow(/'\.mean\(\)' takes numbers, but the array holds null\./);
  });

  it("a null position is judged the same way in a written array and in a read that the proof shows", () => {
    expect(() => jsmql("$.a = [1, null]; $.r = $.a.max();")).toThrow(
      /'\.max\(\)' takes numbers, but the array holds a number and null\./,
    );
    expect(() => jsmql("$.o = { b: null }; $.r = [1, $.o.b].max();")).toThrow(
      /'\.max\(\)' takes numbers, but the array holds a number and null\./,
    );
  });

  it("a position of a kind that the registry does not name fits, as a field path does", () => {
    const ts = new Timestamp({ t: 1, i: 1 });
    expect(jsmql.expr`[1, ${ts}].max()`).toEqual({ $max: [1, ts] });
    expect(jsmql.expr`[1, ${/a/}].max()`).toEqual({ $max: [1, /a/] });
    expect(() => jsmql.expr`["a", ${ts}].max()`).toThrow(/'\.max\(\)' takes numbers/);
  });

  it("a null that the call supplies proves no kind", () => {
    expect(jsmql.validate(({ n }: { n: unknown }, { $ }: { $: any }) => [$.x, n].max())).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("[1, 2].max() is accepted, and the fold gives the answer", () => {
    expect(jsmql.expr("[1, 2].max()")).toBe(2);
  });

  it("a computed array whose elements can be a number or a date is accepted", () => {
    expect(jsmql.expr("$.nums.map(x => x + 1).sum()")).toEqual({
      $sum: { $map: { input: { $ifNull: ["$nums", []] }, as: "x", in: { $add: ["$$x", 1] } } },
    });
  });

  it("the dispatcher refuses a tuple when ANY position has no fitting kind, a set only when NO kind fits", () => {
    const run = (proofs: object) =>
      select(consult("max", "value"), { kind: "value", family: "array", lowered: null }, { kind: "none" }, 0, {
        args: [],
        elements: ["number", "string"],
        ...proofs,
      } as never);
    // a set of kinds: one kind fits, so the array passes
    expect(run({}).kind).not.toBe("wrongKind");
    // the same kinds, as the positions of a tuple: the string position fits nothing
    expect(run({ items: [["number"], ["string"]] })).toMatchObject({
      kind: "wrongKind",
      fault: { rule: "elements", expected: "number", held: ["number", "string"] },
    });
    // a position that can be a number or a string fits
    expect(run({ items: [["number"], ["number", "string"]] }).kind).not.toBe("wrongKind");
    expect(run({ items: [["number"], "unknown"] }).kind).not.toBe("wrongKind");
  });
});

describe("kinds — an iteratee slot that gets no arrow is a refusal, never an internal error", () => {
  it("names the spellings the slot takes", () => {
    for (const method of ["groupBy", "countBy"]) {
      const e = refusal(() => jsmql.expr(`$.a.${method}(5)`));
      expect(e.message).toMatch(new RegExp(`'\\.${method}\\(\\)' takes a key here`));
      expect(e.message).not.toMatch(/internal error/);
    }
  });

  it("covers a predicate slot too", () => {
    expect(() => jsmql.expr("$.a.reject(5)")).toThrow(/'\.reject\(\)' takes a predicate here/);
  });
});

describe("kinds — a spread argument is judged by the kind of its elements", () => {
  it("passes a spread whose elements are unknown", () => {
    expect(jsmql.expr("({}).assign(...$.docs)")).toEqual({ $mergeObjects: "$docs" });
    expect(jsmql.expr("$.o.assign(...$.docs)")).toEqual({
      $mergeObjects: { $concatArrays: [["$o"], { $ifNull: ["$docs", []] }] },
    });
  });

  it("refuses a spread whose elements are proven to be another kind", () => {
    expect(() => jsmql.expr("({}).assign(...[1])")).toThrow(
      /'\.assign\(\)' argument 1 takes a document, but got an element of an array that is a number\./,
    );
  });

  it("refuses a plain argument beside a spread", () => {
    expect(() => jsmql.expr("$.o.assign(...$.docs, 5)")).toThrow(
      /'\.assign\(\)' argument 2 takes a document, but got a number\./,
    );
  });

  it("refuses an array that is not spread, because the server cannot merge it", () => {
    expect(() => jsmql.expr("({}).assign([1])")).toThrow(
      /'\.assign\(\)' argument 1 takes a document, but got an array\./,
    );
  });

  it("the position is the offending element", () => {
    const source = "$.o.assign(...$.docs, 5)";
    expect(refusal(() => jsmql.expr(source)).pos).toBe(source.indexOf("5"));
  });
});

describe("kinds — a cell's own refusal of the shape of an argument comes first", () => {
  it("a callback slot names every spelling that it takes, whatever the kind of the argument", () => {
    expect(() => jsmql.expr("$.a.map(5)")).toThrow(/takes an arrow with an expression body/);
    expect(() => jsmql.expr("$.a.reduce(5, 0)")).toThrow(/takes a two- or three-parameter arrow/);
    expect(() => jsmql.expr("$.a.mapValues(5)")).toThrow(/takes a one- or two-parameter arrow/);
    expect(() => jsmql.pipeline("$$.filter(5);")).toThrow(/an arrow \('d => …'\), a field name/);
    expect(() => jsmql.pipeline("$$.reduce(5, 0);")).toThrow(/takes a two-parameter arrow/);
  });
});

describe("kinds — a precision is an integer", () => {
  it("a number that the program proves passes, and a string is refused", () => {
    expect(jsmql.expr("$.n.round(2)")).toEqual({ $round: ["$n", 2] });
    expect(() => jsmql.expr("$.n.round($.s.trim())")).toThrow(
      /'\.round\(\)' argument 1 takes an integer, but got a string\./,
    );
    expect(() => jsmql.expr("$.n.ceil($.s.trim())")).toThrow(/'\.ceil\(\)' argument 1 takes an integer/);
    expect(() => jsmql.expr("$.n.floor($.s.trim())")).toThrow(/'\.floor\(\)' argument 1 takes an integer/);
    expect(() => jsmql.expr("$.n.trunc($.s.trim())")).toThrow(/'\.trunc\(\)' argument 1 takes an integer/);
  });

  it("a fractional literal is refused, because the server refuses it", () => {
    expect(() => jsmql.expr("$.n.round(1.5)")).toThrow(
      /'\.round\(\)' argument 1 takes an integer, but got a fraction\./,
    );
  });
});

describe("kinds — the BSON constructors take what their $to operator reads", () => {
  it("a value of unknown kind converts, and the server decides", () => {
    expect(jsmql.expr("ObjectId($.s)")).toEqual({ $toObjectId: "$s" });
    expect(jsmql.expr("new Date($.t)")).toEqual({ $toDate: { $cond: [{ $isNumber: "$t" }, { $toLong: "$t" }, "$t"] } });
    expect(jsmql.expr("ISODate($.t)")).toEqual({ $toDate: { $cond: [{ $isNumber: "$t" }, { $toLong: "$t" }, "$t"] } });
    expect(jsmql.expr("UUID($.s)")).toEqual({ $toUUID: "$s" });
    expect(jsmql.expr("Long($.n)")).toEqual({ $toLong: "$n" });
    expect(jsmql.expr("Int32($.s)")).toEqual({ $toInt: "$s" });
    expect(jsmql.expr("NumberDecimal($.s)")).toEqual({ $toDecimal: "$s" });
  });

  it("the calendar parts of a date are integers", () => {
    expect(jsmql.expr("new Date($.y, $.m, $.d)")).toEqual({
      $dateFromParts: { year: "$y", month: { $add: ["$m", 1] }, day: "$d" },
    });
    expect(() => jsmql.expr("new Date($.s.trim(), 1, 1)")).toThrow(
      /'new Date\(\)' argument 1 takes an integer, but got a string\./,
    );
  });

  it("an ObjectId and a UUID convert a string, or a value of their own type", () => {
    expect(() => jsmql.expr("ObjectId($.s.length())")).toThrow(
      /'ObjectId\(\)' argument 1 takes a string or an ObjectId, but got a number\./,
    );
    expect(() => jsmql.expr("UUID($.s.length())")).toThrow(
      /'UUID\(\)' argument 1 takes a string or binary data, but got a number\./,
    );
  });

  it("a date converts a string, a number or a date", () => {
    expect(() => jsmql.expr("new Date($.a === 1)")).toThrow(
      /'new Date\(\)' argument 1 takes a string, a number or a date, but got a boolean\./,
    );
    expect(() => jsmql.expr("new Date(null)")).toThrow(
      "'new Date()' argument 1 takes a string, a number or a date, but got null.",
    );
    expect(() => jsmql.expr("Date(null)")).toThrow(
      "'Date()' argument 1 takes a string, a number or a date, but got null.",
    );
    // A string that no date parser reads keeps the refusal that names the two date constants.
    expect(() => jsmql.expr('new Date("not a date")')).toThrow(/only an ISO 8601 string or a millisecond count/);
  });

  it("a numeric type converts a string or a number", () => {
    for (const name of ["Decimal128", "Long", "Int32", "Double", "NumberDecimal", "NumberLong", "NumberInt"]) {
      expect(() => jsmql.expr(`${name}($.a === 1)`)).toThrow(
        new RegExp(`'${name}\\(\\)' argument 1 takes a string or a number, but got a boolean\\.`),
      );
    }
  });
});

describe("kinds — a query names the elements of an array field", () => {
  it("says that the elements are the kind, not the field", () => {
    expect(() => jsmql.pipeline('$.tags = [1]; $match($.tags === "x");')).toThrow(
      /'===' takes operands of one kind, but got an element of 'tags' that is a number and a string\./,
    );
    expect(() => jsmql.pipeline('$.tags = [1]; $match("x" < $.tags);')).toThrow(
      /'<' takes operands of one kind, but got a string and an element of 'tags' that is a number\./,
    );
  });

  it("a field of a kind that is not an array keeps the plain wording", () => {
    expect(() => jsmql.pipeline('$.n = 1; $match($.n === "x");')).toThrow(/but got a number and a string\./);
  });

  it("an array whose elements can be two or more kinds passes when one of them fits", () => {
    expect(jsmql.pipeline('$.tags = [1, "a"]; $match($.tags === "x");')).toEqual([
      { $set: { tags: [1, "a"] } },
      { $match: { tags: "x" } },
    ]);
  });
});
