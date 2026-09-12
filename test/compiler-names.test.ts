// Phase 5 of src/compiler/ — the variable names the compiler writes.
//
// Five invariants, each one a class of bug a name minter can have:
//   I1  a mint is never a name the program uses, wherever in the program it is bound
//   I2  a read of an unbound name is the developer's error, at its position
//   I3  every name written is one the server accepts — the grammar is measured, not remembered
//   I4  two JavaScript names never become one variable
//   I5  the plain case is untouched, so `$$x` reads as the developer wrote `x`

import { describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { SYSTEM_VARS, Scope, fieldSlot, mongoVarName, scratchSlot, systemRef } from "../src/compiler/emit/names.ts";
import { UnknownIdentifierError } from "../src/errors.ts";
import { liveClientNow, liveUp } from "./fixtures/live.ts";

const up = await liveUp();

/** MEASURED on mongod: a lowercase ASCII lead, then `[A-Za-z0-9_]`. See names.ts. */
const SERVER_GRAMMAR = /^[a-z][A-Za-z0-9_]*$/;

/** A deterministic sample of JavaScript identifiers, legal and hostile alike. */
function identifiers(count: number): string[] {
  const alphabet = ["a", "b", "z", "A", "Z", "_", "$", "0", "9", "é", "ß", "漢", "😀", "v", "i", "d"];
  const out: string[] = [];
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < count; i++) {
    const len = 1 + (next() % 6);
    let s = "";
    for (let j = 0; j < len; j++) s += alphabet[next() % alphabet.length];
    if (/^[0-9]/.test(s)) s = "_" + s; // a JavaScript identifier cannot start with a digit
    out.push(s);
  }
  return out;
}

describe("compiler/emit/names — I5: the plain case is untouched", () => {
  it("keeps a name the server accepts as written", () => {
    for (const js of ["x", "item", "x_1", "xY", "jsmqlArr", "acc", "kv2"]) expect(mongoVarName(js)).toBe(js);
  });

  it("escapes only what the server refuses, readably", () => {
    expect(mongoVarName("_id")).toBe("v__5fid");
    expect(mongoVarName("$x")).toBe("v__24x");
    expect(mongoVarName("X")).toBe("v_X");
    expect(mongoVarName("v_id")).toBe("v_v_5fid");
    expect(mongoVarName("é")).toBe("v__e9");
    expect(mongoVarName("漢")).toBe("v__u6f22");
    expect(mongoVarName("😀")).toBe("v__U01f600");
  });
});

describe("compiler/emit/names — I3: every name written is one the server accepts", () => {
  it("matches the measured grammar for every identifier in the sample", () => {
    const bad = identifiers(3000).filter((js) => !SERVER_GRAMMAR.test(mongoVarName(js)));
    expect(bad).toEqual([]);
  });

  it.skipIf(!up)("is accepted by mongod as a `$let` variable, for the hostile spellings", async () => {
    const client = await liveClientNow();
    try {
      const coll = client.db("jsmql_names").collection("t");
      await coll.deleteMany({});
      await coll.insertOne({ a: 1 });
      for (const js of ["_id", "$x", "X", "v_id", "é", "漢字", "😀", "1x", "x-y", "ROOT", "this"]) {
        const v = mongoVarName(js);
        const rows = await coll
          .aggregate([{ $addFields: { r: { $let: { vars: { [v]: 7 }, in: "$$" + v } } } }])
          .toArray();
        expect(rows[0].r, `${js} → ${v}`).toBe(7);
      }
    } finally {
      await client.close();
    }
  });
});

describe("compiler/emit/names — I4: two JavaScript names never become one variable", () => {
  it("is injective over the sample", () => {
    const sample = [...new Set(identifiers(5000))];
    const images = new Set(sample.map(mongoVarName));
    expect(images.size).toBe(sample.length);
  });

  it("keeps `_id`, `v_id` and `id` apart — the near-collision", () => {
    const three = new Set(["_id", "v_id", "id"].map(mongoVarName));
    expect(three.size).toBe(3);
  });
});

describe("compiler/emit/names — I1: a mint is never a name the program uses", () => {
  it("steps aside from a name bound anywhere in the program, not only in scope here", () => {
    // `jsmqlArr` is a parameter of a lambda DEEPER than the mint site: with only
    // the in-scope names consulted, the mint would be `jsmqlArr` and the inner
    // body would read the wrong binding.
    const root = Scope.root(["x", "jsmqlArr", "jsmqlArr2"]);
    expect(root.bind("arr").as).toBe("jsmqlArr3");
  });

  it("steps aside from its own earlier mint", () => {
    const first = Scope.root([]).bind("arr");
    expect(first.as).toBe("jsmqlArr");
    expect(first.scope.bind("arr").as).toBe("jsmqlArr2");
  });

  it("never renames the developer's own parameter", () => {
    const root = Scope.root(["x"]);
    const b = root.bind("x");
    expect(b.as).toBe("jsmqlX"); // the mint is prefixed; `x` stays `x`
    expect(root.param("x", "unknown", 0).as).toBe("x");
  });

  it("never mints a system variable", () => {
    // `exprVar` capitalises, so no hint can spell ROOT — but the reserved set
    // holds them regardless, so a future spelling change cannot open the hole.
    const taken = Scope.root([]);
    for (const sys of SYSTEM_VARS) expect(taken.bind(sys.toLowerCase()).as).not.toBe(sys);
  });
});

describe("compiler/emit/names — I2: a read resolves in scope or is the developer's error", () => {
  it("reads a bound parameter as `$$name`, encoded, with what the row said it holds", () => {
    const b = Scope.root([]).param("_id", "number", 4);
    expect(b.ref).toBe("$$v__5fid");
    expect(b.scope.lookup("_id", 0)).toEqual({
      ref: { kind: "var", ref: "$$v__5fid" },
      type: "number",
      elements: "unknown",
      mutable: false,
      pos: 4,
    });
    expect(b.scope.has("_id")).toBe(true);
  });

  it("binds a name to what it stands for, not only to a variable", () => {
    const scope = Scope.root([]).declare("$", { ref: { kind: "document" }, type: "object", mutable: false, pos: 0 });
    expect(scope.lookup("$", 0).ref).toEqual({ kind: "document" });
  });

  it("throws the positioned unknown-identifier error for an unbound name", () => {
    const scope = Scope.root([]).param("x", "unknown", 0).scope;
    expect(() => scope.lookup("y", 17)).toThrow(UnknownIdentifierError);
    try {
      scope.lookup("y", 17);
    } catch (e) {
      expect((e as UnknownIdentifierError).pos).toBe(17);
      expect((e as Error).message).toContain("'$.y'");
    }
  });

  it("is immutable: a binding does not reach the scope it was made from", () => {
    const root = Scope.root([]);
    root.param("x", "unknown", 0);
    expect(root.has("x")).toBe(false);
  });

  it("names the system variables as reads", () => {
    expect(systemRef("ROOT")).toBe("$$ROOT");
    expect(systemRef("REMOVE")).toBe("$$REMOVE");
  });
});

describe("compiler/emit/names — a field slot carries both spellings", () => {
  it("pairs the path to write with the reference that reads it", () => {
    expect(scratchSlot(3)).toEqual({ path: "__jsmql.tmp.3", ref: "$__jsmql.tmp.3" });
    expect(fieldSlot("__jsmql.length")).toEqual({ path: "__jsmql.length", ref: "$__jsmql.length" });
  });
});
