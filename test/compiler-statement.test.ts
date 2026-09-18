// Phase 5 of src/compiler/ — the statement target, end to end.
//
// A JSMQL program and the pipeline the compiler emits. Two statements never merge:
// the `;` the developer wrote is the stage boundary and the `,` is the merge, so one
// source keeps one output.
//
// The second describe runs every pipeline this file asserts against a live
// mongod, because a green `toEqual` proves what the compiler EMITS and never
// that the server accepts it (HR3). It self-skips (green) when no mongod is
// reachable, with an all-or-nothing guard.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Collection } from "mongodb";
import { pipeline } from "../src/compiler/index.ts";
import { liveClient } from "./fixtures/live.ts";
import { statementBodyOf } from "../src/compiler/rows.ts";

/**
 * Sources whose pipeline is valid MQL that THIS deployment cannot run, each with
 * the reason. A sort by text score needs a text index and a `$text` query to
 * produce the score; the shape itself is what the stage's row states.
 */
const NEEDS_MORE_THAN_A_SERVER: Readonly<Record<string, string>> = {
  '$sort({ s: $meta("textScore") });': "a text score exists only under a $text query against a text index",
};

/** Every source the unit cases below assert, so the server sees all of them too. */
const RUNS: string[] = [];
const compiled = (src: string): unknown[] => {
  RUNS.push(src);
  return pipeline(src);
};

describe("compiler/emit/statement — the writes", () => {
  it("makes one $set per `,`-joined run, and one stage per `;`", () => {
    expect(compiled("$.a = 1;")).toEqual([{ $set: { a: 1 } }]);
    expect(compiled("$.a = 1, $.b = 2;")).toEqual([{ $set: { a: 1, b: 2 } }]);
    // The `;` is the developer's own stage boundary; nothing reads across it.
    expect(compiled("$.a = 1; $.b = 2;")).toEqual([{ $set: { a: 1 } }, { $set: { b: 2 } }]);
    expect(compiled("$.total = $.qty * $.price;")).toEqual([{ $set: { total: { $multiply: ["$qty", "$price"] } } }]);
    // A compound assignment is the operator it names.
    expect(compiled("$.a += 1;")).toEqual([{ $set: { a: { $add: ["$a", 1] } } }]);
    expect(compiled("$.a.b = 1, $.a.c = 2;")).toEqual([{ $set: { "a.b": 1, "a.c": 2 } }]);
  });

  it("assigns a document WHOLE, as JavaScript does", () => {
    // `{ $set: { n: { x: 1 } } }` MERGES into `n` on the server, leaving the other
    // sub-fields behind; `$mergeObjects` makes the document a value, so the field
    // takes it whole — and an expression inside it still evaluates. Both measured.
    expect(compiled("$.n = { x: 1 };")).toEqual([{ $set: { n: { $mergeObjects: [{ x: 1 }] } } }]);
    expect(compiled("$.n = { x: $.a };")).toEqual([{ $set: { n: { $mergeObjects: [{ x: "$a" }] } } }]);
    expect(compiled("$.n = {};")).toEqual([{ $set: { n: { $mergeObjects: [{}] } } }]);
    // A spread already IS a `$mergeObjects`, and is not wrapped twice.
    expect(compiled("$.n = { ...$, x: 1 };")).toEqual([{ $set: { n: { $mergeObjects: ["$$ROOT", { x: 1 }] } } }]);
    // Everything that is not a plain document is already a value.
    expect(compiled("$.n = [1, 2];")).toEqual([{ $set: { n: [1, 2] } }]);
    expect(compiled("$.n = $.other;")).toEqual([{ $set: { n: "$other" } }]);
    // The raw stage form is the developer's own MQL and keeps MongoDB's meaning (HR1).
    expect(compiled("$set({ n: { x: 1 } });")).toEqual([{ $set: { n: { x: 1 } } }]);
  });

  it("ends a group where one $set would say something else", () => {
    // A later write that READS what an earlier one wrote must read the NEW value.
    expect(compiled("$.x = 1, $.z = $.x;")).toEqual([{ $set: { x: 1 } }, { $set: { z: "$x" } }]);
    expect(compiled("$.a = 1, $.b = $.a.c;")).toEqual([{ $set: { a: 1 } }, { $set: { b: "$a.c" } }]);
    // Writing what an earlier value READ needs no split: one `$set` evaluates
    // every value against the document it received.
    expect(compiled("$.a = $.b, $.b = 1;")).toEqual([{ $set: { a: "$b", b: 1 } }]);
    // A `"$a"` the developer typed IS a read of `a`, so the group ends there too:
    // one `$set` would have given `b` the value `a` held BEFORE the stage.
    expect(compiled('$.a = 1, $.b = "$a";')).toEqual([{ $set: { a: 1 } }, { $set: { b: "$a" } }]);
    // The same path twice is the source saying two things.
    expect(compiled("$.a = 1, $.a = 2;")).toEqual([{ $set: { a: 1 } }, { $set: { a: 2 } }]);
    // A parent beside its own child is refused by the server outright.
    expect(compiled("$.a = 1, $.a.b = 2;")).toEqual([{ $set: { a: 1 } }, { $set: { "a.b": 2 } }]);
    expect(compiled("$.a.b = 1, $.a = 2;")).toEqual([{ $set: { "a.b": 1 } }, { $set: { a: 2 } }]);
  });

  it("unsets a deletion, and the root replacement stands alone", () => {
    expect(compiled("delete $.a;")).toEqual([{ $unset: "a" }]);
    expect(compiled("delete $.a, delete $.b;")).toEqual([{ $unset: ["a", "b"] }]);
    expect(compiled("$.a = 1, delete $.b;")).toEqual([{ $set: { a: 1 } }, { $unset: "b" }]);
    expect(compiled("delete $.a, $.b = 1;")).toEqual([{ $unset: "a" }, { $set: { b: 1 } }]);
    expect(compiled("$ = { x: $.a };")).toEqual([{ $replaceWith: { x: "$a" } }]);
    expect(compiled("$ = $.sub;")).toEqual([{ $replaceWith: "$sub" }]);
    // A root replacement has to BE a document. The server refuses every other
    // value ("'replacement document' must evaluate to an object"), and a literal
    // — or a name whose measured return type says so — is known at compile time.
    expect(() => pipeline("$ = 5;")).toThrow(/has to BE a document — a number/);
    expect(() => pipeline('$ = "x";')).toThrow(/a string is not one/);
    // `$` is ONE document and `$$` is the stream, so an array names the wrong
    // destination whatever it holds: a list of documents, scalars, or nothing.
    for (const src of ["$ = [{ a: 1 }, { a: 2 }];", "$ = [1, 2];", "$ = [];", "$ = $.items.map(x => ({ v: x }));"]) {
      expect(() => pipeline(src)).toThrow(/replaces ONE document, and this value is an array/);
    }
    expect(() => pipeline("$ = null;")).toThrow(/null is not one/);
    expect(() => pipeline("$ = $abs($.a);")).toThrow(/a number is not one/);
  });

  it("places a stage a value needed ahead of the stage that needed it", () => {
    expect(compiled("$.n = $$.length;")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { n: "$__jsmql.length" } },
      { $unset: "__jsmql" },
    ]);
    // A `,`-joined run that splits into two `$set`s puts it between them: the count
    // is the one the stage that reads it sees.
    expect(compiled("$.k = $.tag, $.n = $$.length + $.k;")).toEqual([
      { $set: { k: "$tag" } },
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { n: { $add: ["$__jsmql.length", "$k"] } } },
      { $unset: "__jsmql" },
    ]);
    // A chain link is a stage too, so the count is the MATCHED stream's — the same
    // answer the two-statement spelling gives.
    expect(compiled("$$.$match({ ok: true }).map(d => ({ _id: d._id, n: $$.length }));")).toEqual([
      { $match: { ok: true } },
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $replaceWith: { _id: "$_id", n: "$__jsmql.length" } },
    ]);
  });
});

describe("compiler/emit/statement — the stage calls", () => {
  it("renders a stage from its own row, in the position the row states for its body", () => {
    // `$match`'s row states `filter` for its body, so the body is a query document.
    expect(compiled("$match($.a > 1);")).toEqual([{ $match: { a: { $gt: 1 } } }]);
    expect(compiled("$sort({ a: -1 });")).toEqual([{ $sort: { a: -1 } }]);
    expect(compiled("$limit(2);")).toEqual([{ $limit: 2 }]);
    expect(compiled('$count("n");')).toEqual([{ $count: "n" }]);
    expect(compiled("$project({ a: 1, _id: 0 });")).toEqual([{ $project: { a: 1, _id: 0 } }]);
    // `$group`'s row states `group` for every key but `_id`, so an accumulator lands there.
    expect(compiled("$group({ _id: null, total: $sum($.qty) });")).toEqual([
      { $group: { _id: null, total: { $sum: "$qty" } } },
    ]);
    expect(compiled("$match($.a > 1); $sort({ a: -1 }); $limit(1);")).toEqual([
      { $match: { a: { $gt: 1 } } },
      { $sort: { a: -1 } },
      { $limit: 1 },
    ]);
  });

  it("reads each body key in the position its row states", () => {
    // `$geoNear`'s row states `filter` for its `query` key, so the predicate there
    // becomes a query document — an aggregation expression is refused by the server.
    expect(compiled('$geoNear({ near: [0, 0], distanceField: "d", query: $.k === "a" });')).toEqual([
      { $geoNear: { near: [0, 0], distanceField: "d", query: { k: "a" } } },
    ]);
  });

  it("places a stage where its row says it may stand", () => {
    // A stage that writes the output is filed last, so the `__jsmql` cleanup precedes it.
    expect(compiled('$.b = 2; $out("o");')).toEqual([{ $set: { b: 2 } }, { $out: "o" }]);
    expect(compiled('$.n = $$.length; $out("o");')).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $set: { n: "$__jsmql.length" } },
      { $unset: "__jsmql" },
      { $out: "o" },
    ]);
    expect(compiled("$documents([{ a: 1 }]); $.b = 2;")).toEqual([{ $documents: [{ a: 1 }] }, { $set: { b: 2 } }]);
    // Each rule exists because the server enforces it.
    expect(() => pipeline('$out("o"); $.b = 2;')).toThrow(/Nothing can follow '\$out'/);
    expect(() => pipeline("$.b = 2; $documents([{ a: 1 }]);")).toThrow(/has to be the FIRST stage/);
    expect(() => pipeline('$out("a"); $merge("b");')).toThrow(/Nothing can follow '\$out'/);
    // and inside a container that forbids it
    expect(() => pipeline('$lookup({ from: "o", pipeline: [$out("x")], as: "r" });')).toThrow(
      /cannot stand inside '\$lookup'/,
    );
  });

  it("passes a raw stage document through, and reads a bracketed program as the pipeline", () => {
    // HR1: raw MQL is the developer's own and keeps MongoDB's reading.
    expect(compiled("{ $match: { a: 2 } };")).toEqual([{ $match: { a: 2 } }]);
    expect(compiled("[$match($.a > 1), $set({ b: 1 })]")).toEqual([{ $match: { a: { $gt: 1 } } }, { $set: { b: 1 } }]);
  });
});

describe("compiler/emit/statement — a stage body is checked from the facts its row states", () => {
  it("takes the key combinations the server takes, and no others", () => {
    // `$lookup` joins by the localField/foreignField PAIR, by a `pipeline`, or by
    // both — and by none of them the server refuses it. Each case measured.
    expect(compiled('$lookup({ from: "o", localField: "a", foreignField: "b", as: "j" });')).toEqual([
      { $lookup: { from: "o", localField: "a", foreignField: "b", as: "j" } },
    ]);
    expect(compiled('$lookup({ from: "o", pipeline: [$limit(1)], as: "j" });')).toEqual([
      { $lookup: { from: "o", pipeline: [{ $limit: 1 }], as: "j" } },
    ]);
    expect(() => pipeline('$lookup({ from: "o", localField: "a", as: "j" });')).toThrow(/together or neither/);
    expect(() => pipeline('$lookup({ from: "o", as: "j" });')).toThrow(/at least one of/);
    expect(() => pipeline('$lookup({ from: "o", localField: "a", foreignField: "b" });')).toThrow(
      /requires the 'as' field/,
    );
  });

  it("takes a body that has two forms, and refuses a third", () => {
    // The collection NAME or the body document, and nothing else: measured, the
    // server answers "must be an object or string, but found int".
    expect(compiled('$unionWith("o");')).toEqual([{ $unionWith: "o" }]);
    expect(compiled('$unionWith({ coll: "o", pipeline: [$limit(1)] });')).toEqual([
      { $unionWith: { coll: "o", pipeline: [{ $limit: 1 }] } },
    ]);
    expect(() => pipeline("$unionWith(5);")).toThrow(/a string or a document/);
    // The collection name is read before any document, so a path there is silently
    // wrong on the server — it looks for a collection literally called "$c".
    expect(() => pipeline("$unionWith($.c);")).toThrow(/compile-time constant/);
  });

  it("refuses a body the server reads before any document, where the source made it a value", () => {
    // Measured, one stage at a time: the server refuses a field path as the body of
    // each of these ("the $sort key specification must be an object", …), and takes
    // one for `$unwind` and `$sortByCount`, whose bodies ARE expressions.
    expect(compiled("$unwind($.p);")).toEqual([{ $unwind: "$p" }]);
    for (const src of [
      "$sort($.spec);",
      "$group($.g);",
      "$project($.p);",
      "$set($.s);",
      "$out($.c);",
      "$lookup($.l);",
      "$sample($.n);",
      "$facet($.f);",
    ]) {
      expect(() => pipeline(src), src).toThrow(/must be a compile-time constant/);
    }
  });

  it("takes the sort directions the server takes, and the path form of an unwind", () => {
    expect(compiled("$sort({ a: 1, b: -1 });")).toEqual([{ $sort: { a: 1, b: -1 } }]);
    expect(compiled('$sort({ s: $meta("textScore") });')).toEqual([{ $sort: { s: { $meta: "textScore" } } }]);
    expect(() => pipeline('$sort({ a: "desc" });')).toThrow(/takes 1 or -1 for every key/);
    expect(() => pipeline("$sort({ a: 0 });")).toThrow(/takes 1 or -1 for every key/);
    // An unwind reads a PATH, and the server insists it carries its own `$`.
    expect(compiled('$unwind("$items");')).toEqual([{ $unwind: "$items" }]);
    expect(() => pipeline('$unwind("items");')).toThrow(/carries its own '\$'/);
    expect(() => pipeline('$unwind({ path: "items" });')).toThrow(/carries its own '\$'/);
  });

  it("checks a key's literal value against the closed set the server keeps", () => {
    expect(compiled("$bucket({ groupBy: $.a, boundaries: [0, 10, 30] });")).toEqual([
      { $bucket: { groupBy: "$a", boundaries: [0, 10, 30] } },
    ]);
    expect(() => pipeline("$bucket({ groupBy: $.a });")).toThrow(/requires the 'boundaries' field/);
    expect(() => pipeline("$bucket({ groupBy: $.a, boundaries: $.b });")).toThrow(/compile-time constant/);
    expect(() => pipeline('$bucketAuto({ groupBy: $.a, buckets: 2, granularity: "nope" });')).toThrow(
      /must be one of: R5, R10/,
    );
  });
});

describe("compiler/emit/statement — bindings between stages", () => {
  it("carries a `let` in a field of the document, and the cleanup drops it", () => {
    expect(compiled("let x = $.a * 2; $.b = x;")).toEqual([
      { $set: { "__jsmql.var.x": { $multiply: ["$a", 2] } } },
      { $set: { b: "$__jsmql.var.x" } },
      { $unset: "__jsmql" },
    ]);
    // a constant `let` is inlined by the fold and carries nothing
    expect(compiled("let x = 1; $.b = x;")).toEqual([{ $set: { b: 1 } }]);
    expect(compiled("let x = $.a; let y = x + 1; $.c = y;")).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      { $set: { "__jsmql.var.y": { $add: ["$__jsmql.var.x", 1] } } },
      { $set: { c: "$__jsmql.var.y" } },
      { $unset: "__jsmql" },
    ]);
    // a binding read in a predicate is a field, so the comparison is field-to-field
    expect(compiled("let t = $.a; $$.filter(d => d.x > t);")).toEqual([
      { $set: { "__jsmql.var.t": "$a" } },
      { $match: { $expr: { $gt: ["$x", "$__jsmql.var.t"] } } },
      { $unset: "__jsmql" },
    ]);
    // `let` is written again; `const` is not
    expect(compiled("let x = $.a; x = $.b; $.c = x;")).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      { $set: { "__jsmql.var.x": "$b" } },
      { $set: { c: "$__jsmql.var.x" } },
      { $unset: "__jsmql" },
    ]);
    expect(() => pipeline("const x = $.a; x = $.b;")).toThrow(/is a 'const' and cannot be assigned again/);
  });

  it("shares one $set across the declarators a `,` joined, and breaks it at a dependency", () => {
    // The `,` merges and the `;` does not — the rule `$.a = …, $.b = …` follows.
    expect(compiled("let a = $.x, b = $.y; $.o = a + b;")).toEqual([
      { $set: { "__jsmql.var.a": "$x", "__jsmql.var.b": "$y" } },
      { $set: { o: { $add: ["$__jsmql.var.a", "$__jsmql.var.b"] } } },
      { $unset: "__jsmql" },
    ]);
    expect(compiled("let a = $.x; let b = $.y; $.o = a + b;")).toEqual([
      { $set: { "__jsmql.var.a": "$x" } },
      { $set: { "__jsmql.var.b": "$y" } },
      { $set: { o: { $add: ["$__jsmql.var.a", "$__jsmql.var.b"] } } },
      { $unset: "__jsmql" },
    ]);
    // A `$set` evaluates every field against the stage's INPUT document, so a
    // declarator that reads a sibling opens the next stage — and only there.
    expect(compiled("let a = $.x, b = a + 1, c = $.y; $.o = b + c;")).toEqual([
      { $set: { "__jsmql.var.a": "$x" } },
      { $set: { "__jsmql.var.b": { $add: ["$__jsmql.var.a", 1] }, "__jsmql.var.c": "$y" } },
      { $set: { o: { $add: ["$__jsmql.var.b", "$__jsmql.var.c"] } } },
      { $unset: "__jsmql" },
    ]);
    // a foldable declarator emits no stage in a list either
    expect(compiled("const k = 2, n = k * 3; $.c = $.a * n;")).toEqual([{ $set: { c: { $multiply: ["$a", 6] } } }]);
    // an arrow declarator is a reusable function, list or no list
    expect(compiled("const dbl = (v) => v * 2, y = dbl($.a); $.c = dbl(y);")).toEqual([
      { $set: { "__jsmql.var.y": { $let: { vars: { v: "$a" }, in: { $multiply: ["$$v", 2] } } } } },
      { $set: { c: { $let: { vars: { v: "$__jsmql.var.y" }, in: { $multiply: ["$$v", 2] } } } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("keeps a declarator whose value hoists a stage out of the shared $set", () => {
    // A foreign read in a value position hoists its `$lookup` AHEAD of the
    // statement. Shared with the sibling it correlates on, the join would run
    // before the `$set` that binds that sibling and would correlate on a field
    // nothing has written — silently wrong, and a server rejection when two joins
    // chain. So it ends the run and takes its own stage, exactly as the `;`
    // spelling does.
    expect(compiled("let a = $.x, b = $$$.other.filter(o => o.k === a).length; $.o = b;")).toEqual([
      { $set: { "__jsmql.var.a": "$x" } },
      { $lookup: { from: "other", localField: "__jsmql.var.a", foreignField: "k", as: "__jsmql.tmp.0" } },
      { $set: { "__jsmql.var.b": { $size: "$__jsmql.tmp.0" } } },
      { $set: { o: "$__jsmql.var.b" } },
      { $unset: "__jsmql" },
    ]);
    // and the `;` spelling of it is the same document, scratch slots included
    expect(compiled("let a = $.x, b = $$$.other.filter(o => o.k === a).length; $.o = b;")).toEqual(
      compiled("let a = $.x; let b = $$$.other.filter(o => o.k === a).length; $.o = b;"),
    );
  });

  it("loses a binding at a stage that replaces the document, and says so on the next read", () => {
    // `$group` drops every field; the cleanup is not owed for what is gone
    expect(compiled("let x = $.a; $group({ _id: x });")).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      { $group: { _id: "$__jsmql.var.x" } },
    ]);
    expect(compiled("let x = $.a; $ = { y: x };")).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      { $replaceWith: { y: "$__jsmql.var.x" } },
    ]);
    // measured: `$count` and an INCLUSION `$project` drop the field, so a later
    // read of it would resolve against nothing — the compiler refuses instead.
    expect(() => pipeline('let t = $.a; $count("n"); $.b = t;')).toThrow(/can't be read after `\$count`/);
    expect(() => pipeline("let t = $.a; $project({ a: 1 }); $.b = t;")).toThrow(/can't be read after `\$project`/);
    // an EXCLUSION `$project` keeps it
    expect(compiled("let t = $.a; $project({ z: 0 }); $.b = t;")).toEqual([
      { $set: { "__jsmql.var.t": "$a" } },
      { $project: { z: 0 } },
      { $set: { b: "$__jsmql.var.t" } },
      { $unset: "__jsmql" },
    ]);
    // the cleanup precedes the stage that writes the output
    expect(compiled('let x = $.a; $.b = x; $out("o");')).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      { $set: { b: "$__jsmql.var.x" } },
      { $unset: "__jsmql" },
      { $out: "o" },
    ]);
  });

  it("carries a dropped `let` again on assignment, and refuses the spellings JavaScript refuses", () => {
    // `x = …` after the stage writes the slot again — the JavaScript-valid way back
    expect(compiled("let v = $.x; $group({ _id: $.c }); v = $._id; $.w = v;")).toEqual([
      { $set: { "__jsmql.var.v": "$x" } },
      { $group: { _id: "$c" } },
      { $set: { "__jsmql.var.v": "$_id" } },
      { $set: { w: "$__jsmql.var.v" } },
      { $unset: "__jsmql" },
    ]);
    // a dropped `const` has no way back but a field of the new document
    expect(() => pipeline("const v = $.x; $group({ _id: $.c }); $.w = v;")).toThrow(
      /`v` is a `const` binding and can't be read after `\$group`/,
    );
    expect(() => pipeline("const v = $.x; $group({ _id: $.c }); v = 1;")).toThrow(
      /is a 'const' and cannot be assigned again/,
    );
    // a second `let v` in one block is a SyntaxError in JavaScript, dropped or not
    expect(() => pipeline("let v = $.x; let v = $.y;")).toThrow(/already declared earlier in this block/);
    expect(() => pipeline("let v = $.x; $group({ _id: $.c }); let v = $._id;")).toThrow(
      /already declared earlier in this block/,
    );
  });

  it("scopes a `let` to the block that declares it", () => {
    // the outer binding is visible inside a block, and assignable there
    expect(compiled("let x = $.a; $$.aggregate(o => { x = o.b; $.y = x; }); $.z = x;")).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      { $set: { "__jsmql.var.x": "$b" } },
      { $set: { y: "$__jsmql.var.x" } },
      { $set: { z: "$__jsmql.var.x" } },
      { $unset: "__jsmql" },
    ]);
    // a block over the same documents shares their fields: a shadowing `let` is refused
    expect(() => pipeline("let x = $.a; $$.aggregate(o => { let x = o.b; $.y = x; });")).toThrow(
      /`let x` shadows the `x` declared outside this block/,
    );
    // a parameter opens the block: a `let` of its name is the SyntaxError JavaScript raises
    expect(() => pipeline("$$.aggregate(o => { let o = 1; $.y = o; });")).toThrow(/re-declares the parameter `o`/);
    // a name the block declares ends with the block
    expect(() => pipeline("$$.aggregate(o => { let k = o.b; $.y = k; }); $.z = k;")).toThrow(/Unknown identifier 'k'/);
    // a callback's index and collection parameters have no value on a stream, and say so as parameters
    expect(() => pipeline("$$.map((d, i) => ({ n: i }));")).toThrow(/`i` has no value inside `.map\(\)`/);
    // the collection parameter IS the stream the callback runs over: at the top, `$$`
    expect(compiled("$$.map((d, i, c) => ({ n: c.length }));")).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      { $replaceWith: { n: "$__jsmql.length" } },
    ]);
  });

  it("starts the stream from a literal list of documents", () => {
    // MEASURED: `db.coll.aggregate([{ $documents: […] }])` answers "'$documents' can
    // only be run with database or cluster-level aggregation", and jsmql's pipelines
    // go to a collection. So the list arrives the way a source switch arrives — every
    // document dropped, the new ones unioned in — and it reads the same anywhere in
    // the program, not only first.
    const fanOut = (docs: unknown[]) => [
      { $match: { $expr: false } },
      { $unionWith: { pipeline: [{ $documents: docs }] } },
    ];
    expect(compiled("$$ = [{ a: 1 }, { a: 2 }];")).toEqual(fanOut([{ a: 1 }, { a: 2 }]));
    expect(compiled("$$ = [{ a: 1 }]; $.b = 2;")).toEqual([...fanOut([{ a: 1 }]), { $set: { b: 2 } }]);
    // an empty list is a stream of nothing, which needs no source at all
    expect(compiled("$$ = [];")).toEqual([{ $match: { $expr: false } }]);
    expect(compiled("$.b = 1; $$ = [{ a: 1 }];")).toEqual([{ $set: { b: 1 } }, ...fanOut([{ a: 1 }])]);
    // the row's element rule judges the sugar, under the name the source wrote
    expect(() => pipeline("$$ = [{ a: 1 }, 5];")).toThrow(
      /'\$\$ = \[ … \]' element 2 expects a document, but got a number/,
    );
    // the reducer wrap is a different road, not built yet
    // a list holding a fold of the stream is the reducer wrap: one `$group`
    expect(compiled("$$ = [{ n: $$.reduce((acc, d) => acc + 1, 0) }];")).toEqual([
      { $group: { _id: null, n: { $sum: 1 } } },
      { $replaceWith: { n: "$n" } },
    ]);
  });
});

describe("compiler/emit/statement — the stream road", () => {
  it("lowers a chain on the stream one link at a time, and the bare spelling the same way", () => {
    expect(compiled("$$ = $$.filter(d => d.x > 1);")).toEqual([{ $match: { x: { $gt: 1 } } }]);
    expect(compiled("$$.filter(d => d.x > 1);")).toEqual([{ $match: { x: { $gt: 1 } } }]);
    expect(compiled('$$ = $$.filter(d => d.x > 1).sortBy("k").take(2);')).toEqual([
      { $match: { x: { $gt: 1 } } },
      { $sort: { k: 1 } },
      { $limit: 2 },
    ]);
    // a stage is a link too, through the very cell its statement form uses
    expect(compiled("$$ = $$.$match({ a: 1 }).$limit(1);")).toEqual([{ $match: { a: 1 } }, { $limit: 1 }]);
    // the parameter IS the document: a path in a predicate, a root path in a reshape
    expect(compiled("$$ = $$.map(d => ({ a: d.x, w: d }));")).toEqual([{ $replaceWith: { a: "$x", w: "$$ROOT" } }]);
    // `sub.deep` is a document in EVERY fixture document: the server refuses a
    // reshape to anything else, and the suite's server section runs this one.
    expect(compiled("$$ = $$.map(d => d.sub.deep);")).toEqual([{ $replaceWith: "$sub.deep" }]);
    // `$.x` inside the callback is the same document — HR4 at every depth
    expect(compiled("$$ = $$.filter(d => d.x > $.y);")).toEqual([{ $match: { $expr: { $gt: ["$x", "$y"] } } }]);
    // the lodash shorthands are arrows by the time a cell sees them
    expect(compiled("$$ = $$.filter({ k: 1 });")).toEqual([{ $match: { k: 1 } }]);
    expect(compiled('$$ = $$.map("sub");')).toEqual([{ $replaceWith: "$sub" }]);
  });

  it("reads every sort spelling through one reader", () => {
    expect(compiled('$$ = $$.sortBy("x");')).toEqual([{ $sort: { x: 1 } }]);
    expect(compiled('$$ = $$.sortBy(["x", "y"]);')).toEqual([{ $sort: { x: 1, y: 1 } }]);
    expect(compiled('$$ = $$.sort({ x: -1, y: "asc" });')).toEqual([{ $sort: { x: -1, y: 1 } }]);
    expect(compiled("$$ = $$.toSorted((a, b) => b.x - a.x || a.y - b.y);")).toEqual([{ $sort: { x: -1, y: 1 } }]);
    expect(compiled('$$ = $$.orderBy(["x", "y"], ["asc", "desc"]);')).toEqual([{ $sort: { x: 1, y: -1 } }]);
    expect(compiled("$$ = $$.sortBy(d => -d.age);")).toEqual([{ $sort: { age: -1 } }]);
    // a key MongoDB cannot sort by goes through a scratch field the chain's cleanup drops
    expect(compiled("$$ = $$.sortBy(d => d.a + d.b);")).toEqual([
      { $addFields: { "__jsmql.tmp.0": { $add: ["$a", "$b"] } } },
      { $sort: { "__jsmql.tmp.0": 1 } },
      { $unset: "__jsmql" },
    ]);
    // lodash reads an object here as a matcher, not as directions
    expect(() => pipeline("$$ = $$.sortBy({ k: -1 });")).toThrow(/reads an object as a lodash matcher/);
    expect(() => pipeline("$$ = $$.sort({ a: 2 });")).toThrow(/takes a direction: 1, -1/);
  });

  it("emits each method's own stage, and nothing for an identity", () => {
    expect(compiled("$$ = $$.take(2);")).toEqual([{ $limit: 2 }]);
    // `$limit: 0` is refused by the server; a take of nothing is a stream of nothing
    expect(compiled("$$ = $$.take(0);")).toEqual([{ $match: { $expr: false } }]);
    expect(compiled("$$ = $$.slice(1, 3);")).toEqual([{ $skip: 1 }, { $limit: 2 }]);
    expect(compiled("$$ = $$.tail();")).toEqual([{ $skip: 1 }]);
    expect(compiled("$$ = $$.sampleSize(3);")).toEqual([{ $sample: { size: 3 } }]);
    expect(compiled("$$ = $$.flatMap(d => d.items);")).toEqual([{ $unwind: "$items" }]);
    expect(compiled('$$ = $$.pick(["a", "b"]);')).toEqual([{ $project: { a: 1, b: 1, _id: 0 } }]);
    expect(compiled('$$ = $$.omit(["a"]);')).toEqual([{ $project: { a: 0 } }]);
    expect(compiled('$$ = $$.uniqBy("k");')).toEqual([
      { $group: { _id: "$k", __jsmqlTmp: { $first: "$$ROOT" } } },
      { $replaceWith: "$__jsmqlTmp" },
    ]);
    expect(compiled('$$ = $$.countBy("k");')).toEqual([
      { $group: { _id: "$k", __jsmqlTmp: { $sum: 1 } } },
      {
        $group: {
          _id: null,
          __jsmqlTmp: { $push: { k: { $ifNull: [{ $toString: "$_id" }, "null"] }, v: "$__jsmqlTmp" } },
        },
      },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ]);
    // `.reject` is the complement of the predicate's own clause, as `!p` is
    expect(compiled("$$ = $$.reject(d => d.x > 1);")).toEqual([{ $match: { $nor: [{ x: { $gt: 1 } }] } }]);
    // the block's statements ARE the chain's stages
    expect(compiled("$$.aggregate((o) => { $match(o.a > 1); $limit(2); });")).toEqual([
      { $match: { a: { $gt: 1 } } },
      { $limit: 2 },
    ]);
  });

  it("refuses what the server would, and says what to write", () => {
    // a link after the terminal stage, as a statement after it
    expect(() => pipeline('$$.filter(d => d.a).$out("x").$limit(1);')).toThrow(/Nothing can follow '\$out'/);
    // the stream is never null
    expect(() => pipeline("$$?.$match({ a: 1 });")).toThrow(/never null/);
    // a reshape has to return a document; the server refuses every other root
    expect(() => pipeline("$$ = $$.map(d => 5);")).toThrow(/has to return a document/);
    // an unwind names a field
    expect(() => pipeline("$$ = $$.flatMap(d => 5);")).toThrow(/names the ARRAY FIELD/);
    // a projection lists field names
    expect(() => pipeline("$$.omit([1, 2]);")).toThrow(/names a field to WRITE/);
    // an argument that is neither an arrow nor a shorthand
    expect(() => pipeline("$$ = $$.countBy(String);")).toThrow(/takes a key here/);
    // an unknown link, with the nearest one in the chain's own spelling
    expect(() => pipeline("$$.$prject({ a: 1 });")).toThrow(/Did you mean '\.\$project\(\)'/);
    // a read of the index or collection parameter says what to write instead
    expect(() => pipeline("$$ = $$.map((d, i) => ({ n: i }));")).toThrow(/no per-document index/);
    expect(compiled("$$ = $$.map((d, _i, _coll) => ({ id: d._id }));")).toEqual([{ $replaceWith: { id: "$_id" } }]);
  });
});

describe("compiler/emit/statement — the refusals name the way out", () => {
  it("tells a value what to do instead of standing as a statement", () => {
    expect(() => pipeline("$.a > 1;")).toThrow(/A pipeline statement writes something/);
    expect(() => pipeline("$abs(42);")).toThrow(/computes a value, and a statement writes one/);
    expect(() => pipeline("$.s.trim();")).toThrow(/Assign it to a field/);
    expect(() => pipeline("$not(true);")).toThrow(/'\$not'/);
  });

  it("refuses a destination that is not a field, and the deletion of the document", () => {
    expect(() => pipeline("$.s.trim() = 1;")).toThrow(/A write names a field|only a field/);
    expect(() => pipeline("delete $;")).toThrow(/delete the document itself/);
  });

  it("refuses a body the server refuses, from the fact the row states", () => {
    // Each of these was run against the server first; the message is what the row's
    // stated fact says, not a copy of the server's wording.
    expect(() => pipeline('$count("$n");')).toThrow(/starts with '\$'/);
    expect(() => pipeline('$count("a.b");')).toThrow(/holds a dot/);
    expect(() => pipeline("$count(5);")).toThrow(/a number is not a name/);
    expect(() => pipeline("$count($.name);")).toThrow(/compile-time constant/);
    expect(() => pipeline("$limit(0);")).toThrow(/of 1 or more/);
    expect(() => pipeline("$limit(1.5);")).toThrow(/expects an integer/);
    expect(() => pipeline("$limit($.n);")).toThrow(/compile-time constant/);
    expect(() => pipeline("$skip(-1);")).toThrow(/of 0 or more/);
    // The server ACCEPTS a path here and unions a collection literally named "$c",
    // which is the silent kind of wrong a constant slot exists to catch.
    expect(() => pipeline("$unionWith($.c);")).toThrow(/compile-time constant/);
    // and the valid spellings still compile
    expect(compiled('$count("n");')).toEqual([{ $count: "n" }]);
    expect(compiled("$skip(0);")).toEqual([{ $skip: 0 }]);
    expect(compiled('$unionWith("c");')).toEqual([{ $unionWith: "c" }]);
  });

  it("refuses a value, and a program that would do nothing", () => {
    // A folded constant array is a VALUE, not the empty pipeline: `[1,2].slice(2,2)`
    // settles to `[]`, which read as a program would compile to no stages at all.
    expect(() => pipeline("[1, 2, 3].slice(3, 2)")).toThrow(/A pipeline is one or more statements/);
    expect(() => pipeline("[]")).toThrow(/A pipeline is one or more statements/);
    expect(() => pipeline("const x = 5;")).toThrow(/produces no stages/);
  });

  it("keeps a stage inside the body it was written in", () => {
    // `$.` is the OUTER document at every depth, so a body over another
    // collection can only be stated without it until the join road carries the
    // capture; a raw query document names the foreign field directly.
    expect(compiled('$lookup({ from: "o", pipeline: [$match({ a: { $gt: 1 } }), $limit(2)], as: "r" });')).toEqual([
      { $lookup: { from: "o", pipeline: [{ $match: { a: { $gt: 1 } } }, { $limit: 2 }], as: "r" } },
    ]);
    // `$.` inside a body over another collection is the OUTER document, carried by `let`
    expect(compiled('$lookup({ from: "o", pipeline: [$match($.a > 1)], as: "r" });')).toEqual([
      {
        $lookup: {
          from: "o",
          let: { jsmql_f0_a: "$a" },
          pipeline: [{ $match: { $expr: { $gt: ["$$jsmql_f0_a", 1] } } }],
          as: "r",
        },
      },
    ]);
    expect(compiled("$facet({ a: [$limit(1)] });")).toEqual([{ $facet: { a: [{ $limit: 1 }] } }]);
  });

  it("refuses a body no deployment accepts, in both spellings of a stage", () => {
    // The call and the raw document are ONE road: a shape the server refuses
    // everywhere is not a round-trip, whichever way it was written.
    expect(() => pipeline("$addFields(5);")).toThrow(/expects a document/);
    expect(() => pipeline("$replaceWith(5);")).toThrow(/expects a document/);
    expect(() => pipeline("$replaceRoot({ newRoot: 5 });")).toThrow(/newRoot expects a document/);
    expect(() => pipeline("$replaceRoot({ bogus: 1 });")).toThrow(/has no parameter 'bogus'/);
    expect(() => pipeline('{ $unwind: "items" };')).toThrow(/carries its own '\$'/);
    expect(() => pipeline('{ $sort: { a: "desc" } };')).toThrow(/takes 1 or -1 for every key/);
    // A `$`-led string is a runtime path everywhere but a constant-only slot,
    // where the server reads it as itself.
    expect(() => pipeline('$bucketAuto({ groupBy: $.x, buckets: 2, granularity: "$g" });')).toThrow(
      /must be one of: R5/,
    );
  });

  it("holds the body facts of every stage the server refuses a shape of", () => {
    // each refusal is the server's own (measured on 8.3.7), stated on the row
    expect(() => pipeline('$densify({ field: "t", range: { step: 1, bounds: "full" }, zzz: 1 });')).toThrow(
      /'\$densify' has no parameter 'zzz'/,
    );
    expect(() => pipeline('$densify({ range: { step: 1, bounds: "full" } });')).toThrow(/requires the 'field' field/);
    expect(() =>
      pipeline(
        '$fill({ sortBy: { t: 1 }, partitionBy: "$k", partitionByFields: ["k"], output: { a: { method: "locf" } } });',
      ),
    ).toThrow(/takes 'partitionBy' or 'partitionByFields', not both/);
    expect(() => pipeline('$setWindowFields({ partitionBy: "$k" });')).toThrow(/requires the 'output' field/);
    expect(() => pipeline('$merge({ into: "c", whenMatched: "zzz" });')).toThrow(/whenMatched is one of: replace/);
    expect(() => pipeline("$changeStreamSplitLargeEvent({ zzz: 1 });")).toThrow(/has no parameter 'zzz'/);
    expect(() => pipeline('{ $out: { db: "d", coll: "c", zzz: 1 } };')).toThrow(/has no parameter 'zzz'/);
    expect(() => pipeline('$geoNear({ near: [0, 0], distanceField: "d", zzz: 1 });')).toThrow(/has no parameter 'zzz'/);
    expect(pipeline('$fill({ sortBy: { t: 1 }, output: { a: { method: "locf" } } });')).toEqual([
      { $fill: { sortBy: { t: 1 }, output: { a: { method: "locf" } } } },
    ]);
    expect(pipeline('$densify({ field: "t", range: { step: 1, bounds: "full" } });')).toEqual([
      { $densify: { field: "t", range: { step: 1, bounds: "full" } } },
    ]);
    expect(pipeline('$merge({ into: "c", whenMatched: [{ $set: { a: 1 } }] });')).toEqual([
      { $merge: { into: "c", whenMatched: [{ $set: { a: 1 } }] } },
    ]);
  });

  it("says which forms this compiler has not built yet, so nothing looks supported", () => {
    // A chain's last LINK is a name the registry knows, so without this the join
    // road would emit a bare stage — a filter on the wrong collection.
    // a read of another collection with nowhere to go is refused, not a bare stage on the wrong collection
    expect(() => pipeline("$$$.orders.$match({ a: 1 });")).toThrow(/gives it no destination/);
    expect(compiled("$$$.dest = $$.aggregate((o) => { $match(o.a === 1); });")).toEqual([
      { $match: { a: 1 } },
      { $out: "dest" },
    ]);
  });
});

// ── every pipeline above, on a real server ───────────────────────────────────

let client: MongoClient | null = null;
let coll: Collection | null = null;

beforeAll(async () => {
  client = await liveClient();
  // Null means the instance is not running, and only that: liveClient throws on any
  // other refusal rather than letting this suite skip itself green.
  if (client === null) return;
  const c = client;
  coll = c.db("jsmql_compiler_statement").collection("t");
  await coll.deleteMany({});
  await coll.insertMany([
    // `a.b` and `k` hold documents: a reshape to a field that is not one is
    // refused by the server, and two asserted reshapes read them.
    { _id: 1, a: 2, b: 4, qty: 3, price: 5, sub: { k: 1, deep: { v: 1 } }, items: [1, 2] },
    { _id: 2, a: 9, b: 1, qty: 1, price: 2, sub: { k: 2, deep: { v: 2 } }, items: [] },
  ]);
});

afterAll(async () => {
  await client?.close();
});

describe("compiler/emit/statement — the server accepts every pipeline this file asserts", () => {
  it("ran each one, or none", async () => {
    if (coll === null) {
      expect(RUNS.length).toBeGreaterThan(0);
      return;
    }
    // A refusal that is about this deployment rather than about the shape: a
    // collection-level aggregate cannot start from `$documents`, and `$geoNear`
    // needs an index the fixture has no reason to carry. See test/CLAUDE.md.
    const environment = /database or cluster-level aggregation|2d or 2dsphere index/;
    const refused: string[] = [];
    for (const src of RUNS) {
      if (src in NEEDS_MORE_THAN_A_SERVER) continue;
      try {
        await coll.aggregate(pipeline(src) as Record<string, unknown>[]).toArray();
      } catch (e) {
        const message = (e as Error).message;
        if (environment.test(message)) continue;
        refused.push(`${src}\n  ${JSON.stringify(pipeline(src))}\n  ${message}`);
      }
    }
    expect(refused, `the server refused ${refused.length} of ${RUNS.length}:\n${refused.join("\n")}`).toEqual([]);
    // The allowance has teeth only while each entry is actually asserted somewhere.
    for (const src of Object.keys(NEEDS_MORE_THAN_A_SERVER)) expect(RUNS, src).toContain(src);
  });
});

describe("compiler/emit/statement — a root write of a provable array fans out", () => {
  it("an array-returning method on an unproven field is an array, so `$$ = $.items.map(…)` fans out", () => {
    expect(pipeline("$$ = $.items.map(x => ({ v: x }))")).toEqual([
      { $set: { "__jsmql.tmp.0": { $map: { input: "$items", as: "x", in: { v: "$$x" } } } } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
    // a field alone proves nothing: it stays one document
    expect(pipeline("$ = $.items")).toEqual([{ $replaceWith: "$items" }]);
  });
  it("a binding holding an array-returning method's value is typed, so a read dispatches at compile time", () => {
    expect(pipeline('const ids = $.tags.uniq(); $.y = ids.includes("a")')).toEqual([
      { $set: { "__jsmql.var.ids": { $setUnion: "$tags" } } },
      // A reader over a MISSING field answers null, so a value the compiler proved is
      // an array can still be null at run time — and `$in` refuses that rather than
      // answer null (MEASURED: "$in requires an array as a second argument, found:
      // null"). `.includes` is a JavaScript method, so it tests first and answers null.
      {
        $set: {
          y: {
            $cond: {
              if: { $eq: [{ $ifNull: ["$__jsmql.var.ids", null] }, null] },
              then: null,
              else: { $in: ["a", "$__jsmql.var.ids"] },
            },
          },
        },
      },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("compiler/emit/statement — the update spec's closed set, against the server's own answer", () => {
  // `$merge.whenMatched` is an UPDATE, not a pipeline: the server runs a closed set of
  // stages there and refuses the rest outright. jsmql reads that set off the `$merge`
  // row (`statementBody`), and this is the gate that keeps the row honest — it asks
  // the server, one stage per run, and compares the two sets.
  const ALLOWED = statementBodyOf("$merge");

  /** A body each stage accepts, so a rejection is about the UPDATE and not the shape. */
  const BODIES: Readonly<Record<string, unknown>> = {
    $addFields: { z: 1 },
    $set: { z: 1 },
    $project: { z: 1 },
    $unset: "qty",
    $replaceRoot: { newRoot: { $mergeObjects: ["$$ROOT", { z: 1 }] } },
    $replaceWith: { $mergeObjects: ["$$ROOT", { z: 1 }] },
    $fill: { output: { a: { value: 0 } } },
    $match: { a: 2 },
    $limit: 1,
    $skip: 0,
    $sort: { a: 1 },
    $count: "n",
    $group: { _id: "$a" },
    $unwind: "$items",
    $sortByCount: "$a",
    $redact: "$$KEEP",
    $setWindowFields: { output: { w: { $count: {} } } },
    $bucketAuto: { groupBy: "$a", buckets: 1 },
    $sample: { size: 1 },
  };

  it("allows exactly what the server allows", async () => {
    if (coll === null) {
      expect(Array.isArray(ALLOWED) && ALLOWED.length > 0).toBe(true);
      return;
    }
    expect(Array.isArray(ALLOWED)).toBe(true);
    const c = coll;
    const serverAllows: string[] = [];
    for (const [name, body] of Object.entries(BODIES)) {
      try {
        await c.aggregate([{ $merge: { into: "update_spec_probe", whenMatched: [{ [name]: body }] } }]).toArray();
        serverAllows.push(name);
      } catch (e) {
        // Anything BUT the update refusal means the probe body was wrong, not that the
        // stage is banned — a silent miscount is the one failure this gate must not have.
        const m = (e as Error).message;
        expect(m, `'${name}' was refused for a reason other than the update spec`).toMatch(
          /is not allowed to be used within an update/,
        );
      }
    }
    const registryAllows = (ALLOWED as readonly string[]).filter((n) => n in BODIES);
    expect([...serverAllows].sort()).toEqual([...registryAllows].sort());
    // and every name the row states is one this probe actually exercised
    expect((ALLOWED as readonly string[]).filter((n) => !(n in BODIES))).toEqual([]);
  });

  it("refuses at compile time exactly the ones the server refuses", () => {
    for (const name of Object.keys(BODIES)) {
      const src = `$merge({ into: "c", whenMatched: [{ ${name}: ${JSON.stringify(BODIES[name])} }] });`;
      if ((ALLOWED as readonly string[]).includes(name)) {
        expect(() => pipeline(src), name).not.toThrow();
      } else {
        expect(() => pipeline(src), name).toThrow(/cannot stand inside '\$merge': that body is an UPDATE/);
      }
    }
  });
});
