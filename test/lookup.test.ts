import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

// `this.<coll>.find/filter(predicate)` → MongoDB `$lookup` (+ `$unwind` for find).
//
// Happy-path shapes live near the top; the error catalog lives at the bottom,
// one `it` per misuse, each asserting that the message names what's wrong and
// (where appropriate) suggests the correct shape.

describe("lookup — happy path", () => {
  it(".filter() lowers to $lookup with array result", () => {
    expect(jsmql("$.orders = this.orders.filter(o => o.user === $._id);")).toEqual([
      { $lookup: { from: "orders", localField: "_id", foreignField: "user", as: "orders" } },
    ]);
  });

  it(".find() lowers to $lookup + $unwind(preserve) — JS-find returns one or null", () => {
    expect(jsmql("$.user = this.users.find(u => u._id === $.userId);")).toEqual([
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" } },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
    ]);
  });

  it("equality is symmetric — $.x === o.y produces the same MQL as o.y === $.x", () => {
    expect(jsmql("$.user = this.users.find(u => $.userId === u._id);")).toEqual([
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" } },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
    ]);
  });

  it("accepts dotted paths on both sides of the equality", () => {
    expect(jsmql("$.match = this.users.filter(u => u.profile.email === $.contact.email);")).toEqual([
      { $lookup: { from: "users", localField: "contact.email", foreignField: "profile.email", as: "match" } },
    ]);
  });

  it("allows a dotted LHS — MongoDB's $lookup.as accepts dotted output paths", () => {
    expect(jsmql("$.a.b = this.users.find(u => u._id === $.userId);")).toEqual([
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "a.b" } },
      { $unwind: { path: "$a.b", preserveNullAndEmptyArrays: true } },
    ]);
  });

  it("supports bracket access for non-ident collection names", () => {
    expect(jsmql('$.x = this["user-orders"].filter(u => u.id === $._id);')).toEqual([
      { $lookup: { from: "user-orders", localField: "_id", foreignField: "id", as: "x" } },
    ]);
  });

  it("preserves source order across a mix of $set, $lookup, and follow-up $set", () => {
    expect(jsmql("$.a = 1; $.user = this.users.find(u => u._id === $.userId); $.b = 2;")).toEqual([
      { $set: { a: 1 } },
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" } },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      { $set: { b: 2 } },
    ]);
  });

  it("works inside a bracketed pipeline form", () => {
    expect(jsmql("[$.user = this.users.find(u => u._id === $.userId)]")).toEqual([
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" } },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
    ]);
  });
});

describe("lookup — error catalog", () => {
  it("rejects `this.<coll>` outside a `;`-terminated Pipeline statement", () => {
    expect(() => jsmql("$.user = this.users.find(u => u._id === $.userId)")).toThrow(
      /`;`-terminated Pipeline statement/,
    );
  });

  it("rejects bare `this.<coll>` (no .find / .filter)", () => {
    expect(() => jsmql("$.x = this.users; $.y = 1;")).toThrow(
      /must be followed by `\.find\(predicate\)` or `\.filter\(predicate\)`/,
    );
  });

  it("rejects wrong methods and suggests the closest valid one", () => {
    expect(() => jsmql("$.x = this.users.map(u => u._id); $.y = 1;")).toThrow(
      /supports \.find\(predicate\) and \.filter\(predicate\)/,
    );
  });

  it("rejects missing predicate with an example", () => {
    expect(() => jsmql("$.x = this.users.find(); $.y = 1;")).toThrow(/requires a predicate/);
  });

  it("rejects non-arrow predicate", () => {
    expect(() => jsmql("$.x = this.users.find(123); $.y = 1;")).toThrow(/requires an arrow predicate/);
  });

  it("rejects multi-parameter arrow predicate", () => {
    expect(() => jsmql("$.x = this.users.find((u, i) => u._id === $.userId); $.y = 1;")).toThrow(
      /takes a single-parameter arrow/,
    );
  });

  it("rejects non-equality body and points at the $lookup escape hatch", () => {
    expect(() => jsmql("$.x = this.users.find(u => u._id > $.userId); $.y = 1;")).toThrow(
      /field-path equality.*\$lookup\(\{ from, let, pipeline, as \}\)/s,
    );
  });

  it("rejects equality where both sides reference the foreign document", () => {
    expect(() => jsmql("$.x = this.users.find(u => u._id === u.foreign); $.y = 1;")).toThrow(
      /compares two foreign paths/,
    );
  });

  it("rejects equality where both sides reference the local document", () => {
    expect(() => jsmql("$.x = this.users.find(u => $.a === $.b); $.y = 1;")).toThrow(/compares two local paths/);
  });

  it("rejects chained `this.users.orders.find(...)` (not a direct collection)", () => {
    expect(() => jsmql("$.x = this.users.orders.find(o => o.userId === $._id); $.y = 1;")).toThrow(
      /must be a direct property access/,
    );
  });

  it("`jsmql.update()` rejects `$lookup` (with `;`) as a disallowed update stage", () => {
    expect(() => jsmql.update("$.user = this.users.find(u => u._id === $.userId);")).toThrow(
      /jsmql\.update\(\) rejected '\$lookup'/,
    );
  });

  it("`jsmql.filter()` rejects `this.<coll>` usage", () => {
    expect(() => jsmql.filter("this.users.find(u => u._id === $.userId)")).toThrow(/this\.<collection>/);
  });
});
