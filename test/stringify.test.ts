/**
 * `jsmql.stringify` — a compiled document as the JavaScript that rebuilds it.
 *
 * Two assertions run over almost every case. The first is the TEXT, which is what a
 * reader sees. The second is the ROUND TRIP: the text is evaluated with the driver's
 * BSON classes in scope — the way a developer uses it, by pasting it where those
 * classes live — and the rebuilt value is serialised to BSON and compared byte for
 * byte with the original. Equal bytes are what "the text rebuilds the document"
 * means; a printer that wrote a plausible but different value fails there.
 *
 * See docs/specs/mql-stringify.md.
 */
import { describe, it, expect } from "vitest";
import * as mongodb from "mongodb";
import { jsmql } from "../src/index.ts";

const { stringify } = jsmql;

/** The classes a driver script has in scope, and which mongosh exposes as globals. */
const BSON_GLOBALS: Record<string, unknown> = {
  ObjectId: mongodb.ObjectId,
  Decimal128: mongodb.Decimal128,
  Long: mongodb.Long,
  Int32: mongodb.Int32,
  Double: mongodb.Double,
  Binary: mongodb.Binary,
  UUID: mongodb.UUID,
  Timestamp: mongodb.Timestamp,
  MinKey: mongodb.MinKey,
  MaxKey: mongodb.MaxKey,
  Code: mongodb.Code,
  DBRef: mongodb.DBRef,
  BSONSymbol: mongodb.BSONSymbol,
  BSONRegExp: mongodb.BSONRegExp,
};

/** The text read the way a developer reads it: pasted where the BSON classes live. */
const asPasted = (text: string): unknown =>
  new Function(...Object.keys(BSON_GLOBALS), `return (${text})`)(...Object.values(BSON_GLOBALS));

/** The document's own bytes, which is what the server actually receives. */
const bytes = (doc: Record<string, unknown>): string => Buffer.from(mongodb.BSON.serialize(doc)).toString("base64");

/** Print `value` under the key `v`, assert the text, then assert the bytes survive a paste. */
function rebuilds(value: unknown, expected: string): void {
  const text = stringify({ v: value });
  expect(text).toBe(`{ v: ${expected} }`);
  expect(bytes(asPasted(text) as Record<string, unknown>)).toBe(bytes({ v: value }));
}

describe("stringify: the BSON classes", () => {
  it("writes an ObjectId as the constructor call", () => {
    rebuilds(new mongodb.ObjectId("507f1f77bcf86cd799439011"), 'new ObjectId("507f1f77bcf86cd799439011")');
  });

  it("writes an ObjectId from a foreign bson copy the same way", () => {
    // A second copy of `bson` in the tree shares no prototype with ours, so the
    // printer knows the value only by its tag. It must still spell the constructor.
    const foreign = { _bsontype: "ObjectId", toHexString: () => "507f1f77bcf86cd799439011" };
    expect(stringify({ v: foreign })).toBe('{ v: new ObjectId("507f1f77bcf86cd799439011") }');
  });

  it("writes a Decimal128 as its decimal string, not its bytes", () => {
    rebuilds(new mongodb.Decimal128("1.50"), 'new Decimal128("1.50")');
  });

  it("writes a Long through fromString, which a reader can check", () => {
    rebuilds(mongodb.Long.fromString("9007199254740993"), 'Long.fromString("9007199254740993")');
  });

  it("writes an Int32", () => {
    rebuilds(new mongodb.Int32(7), "new Int32(7)");
  });

  it("keeps a whole-number Double a double — a bare 42 would come back an int", () => {
    rebuilds(new mongodb.Double(42), "new Double(42)");
  });

  it("writes a Binary as base64 with its subtype", () => {
    rebuilds(mongodb.Binary.createFromBase64("AQIDBA==", 0), 'Binary.createFromBase64("AQIDBA==", 0)');
  });

  it("reads a Binary's length from the value, not from its over-allocated buffer", () => {
    // A Binary filled a byte at a time holds 260 bytes for the 1 written.
    const b = new mongodb.Binary(Buffer.alloc(0), 0);
    b.put(7);
    rebuilds(b, 'Binary.createFromBase64("Bw==", 0)');
  });

  it("writes a subtype-4 Binary as the UUID it is", () => {
    rebuilds(
      new mongodb.UUID("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
      'new UUID("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")',
    );
  });

  it("writes a Timestamp as its two parts", () => {
    rebuilds(new mongodb.Timestamp({ t: 1700000000, i: 7 }), "new Timestamp({ t: 1700000000, i: 7 })");
  });

  it("writes MinKey and MaxKey", () => {
    rebuilds(new mongodb.MinKey(), "new MinKey()");
    rebuilds(new mongodb.MaxKey(), "new MaxKey()");
  });

  it("writes a Code, and a Code with a scope", () => {
    rebuilds(new mongodb.Code("function () { return 1; }"), 'new Code("function () { return 1; }")');
    rebuilds(new mongodb.Code("x", { x: 1 }), 'new Code("x", { x: 1 })');
  });

  it("writes a DBRef, and one that names a database", () => {
    const oid = new mongodb.ObjectId("507f1f77bcf86cd799439011");
    rebuilds(new mongodb.DBRef("users", oid), 'new DBRef("users", new ObjectId("507f1f77bcf86cd799439011"))');
    rebuilds(
      new mongodb.DBRef("users", oid, "other"),
      'new DBRef("users", new ObjectId("507f1f77bcf86cd799439011"), "other")',
    );
  });

  it("writes a BSONSymbol", () => {
    rebuilds(new mongodb.BSONSymbol("sym"), 'new BSONSymbol("sym")');
  });

  it("writes a BSONRegExp with its options", () => {
    rebuilds(new mongodb.BSONRegExp("^a", "i"), 'new BSONRegExp("^a", "i")');
  });
});

describe("stringify: the values JavaScript already spells", () => {
  it("writes a Date as the constructor call, never as the string its toJSON gives", () => {
    rebuilds(new Date("2026-01-01T00:00:00.000Z"), 'new Date("2026-01-01T00:00:00.000Z")');
  });

  it("writes a RegExp as a literal, which JSON writes as {}", () => {
    rebuilds(/^a/i, "/^a/i");
  });

  it("writes a Uint8Array as itself — the bytes the document holds", () => {
    rebuilds(new Uint8Array([1, 2, 3]), "new Uint8Array([1, 2, 3])");
  });

  it("writes a Buffer the same way — a Buffer IS a Uint8Array", () => {
    rebuilds(Buffer.from([9, 9]), "new Uint8Array([9, 9])");
  });

  it("keeps -0, which String() writes as 0 and which is a different BSON double", () => {
    expect(stringify({ v: -0 })).toBe("{ v: -0 }");
    expect(Object.is((asPasted("{ v: -0 }") as { v: number }).v, -0)).toBe(true);
  });

  it("writes the plain values", () => {
    expect(stringify({ s: "a", n: 1.5, b: true, z: null, big: 10n })).toBe(
      '{ s: "a", n: 1.5, b: true, z: null, big: 10n }',
    );
  });

  it("writes an empty array and an empty object", () => {
    expect(stringify({ a: [], o: {} })).toBe("{ a: [], o: {} }");
  });

  it("writes a BSON value nested in an array and in an object", () => {
    const oid = new mongodb.ObjectId("507f1f77bcf86cd799439011");
    expect(stringify({ _id: { $in: [oid] } })).toBe('{ _id: { $in: [new ObjectId("507f1f77bcf86cd799439011")] } }');
  });
});

describe("stringify: a tag without the data behind it", () => {
  // The compiler passes a plain object through as the value it is, tag and all.
  it("writes an ObjectId-tagged plain object as the object, and does not throw", () => {
    expect(stringify({ v: { _bsontype: "ObjectId", id: "xyz" } })).toBe('{ v: { _bsontype: "ObjectId", id: "xyz" } }');
  });

  it("reads the legacy uppercase-D tag as an ObjectId, as the compiler does", () => {
    const legacy = { _bsontype: "ObjectID", toHexString: () => "507f1f77bcf86cd799439011" };
    expect(stringify({ v: legacy })).toBe('{ v: new ObjectId("507f1f77bcf86cd799439011") }');
  });

  it("writes an unknown BSON tag as the object it is", () => {
    expect(stringify({ v: { _bsontype: "SomethingNew", a: 1 } })).toBe('{ v: { _bsontype: "SomethingNew", a: 1 } }');
  });
});

describe("stringify: keys", () => {
  it("writes a plain identifier bare and quotes everything else", () => {
    expect(stringify({ age: 1, $gt: 2, "a.b": 3, "": 4, "1x": 5 })).toBe(
      '{ age: 1, $gt: 2, "a.b": 3, "": 4, "1x": 5 }',
    );
  });

  it("writes __proto__ as a computed key, the only spelling that survives a paste", () => {
    // The computed key here is the test's own workaround: a source `{ __proto__: 1 }`
    // sets the prototype and creates no own property, which is the whole hazard.
    const text = stringify({ ["__proto__"]: 1 } as Record<string, unknown>);
    expect(text).toBe('{ ["__proto__"]: 1 }');
    const back = asPasted(text) as Record<string, unknown>;
    expect(Object.hasOwn(back, "__proto__")).toBe(true);
    expect(back.__proto__).toBe(1);
  });

  it("shows what the quoted spelling would have cost — the field vanishes", () => {
    const quoted = asPasted('{ "__proto__": 1 }') as Record<string, unknown>;
    expect(Object.hasOwn(quoted, "__proto__")).toBe(false);
  });
});

describe("stringify: layout", () => {
  const wide = { $group: { _id: "$userId", revenue: { $sum: "$total" }, orders: { $sum: 1 }, first: { $min: "$at" } } };

  it("keeps a document on one line while it fits", () => {
    expect(stringify({ age: { $gt: 18 } })).toBe("{ age: { $gt: 18 } }");
  });

  it("breaks one entry per line once the one-line form passes the width", () => {
    expect(stringify(wide)).toBe(
      [
        "{",
        "  $group: {",
        '    _id: "$userId",',
        '    revenue: { $sum: "$total" },',
        "    orders: { $sum: 1 },",
        '    first: { $min: "$at" }',
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("breaks a pipeline one stage per line", () => {
    const out = stringify(jsmql("$match($.age > 18); $set({ t: $.a * 2 }); $sort({ t: -1 })"));
    expect(out).toBe(
      [
        "[",
        "  { $match: { age: { $gt: 18 } } },",
        '  { $set: { t: { $multiply: ["$a", 2] } } },',
        "  { $sort: { t: -1 } }",
        "]",
      ].join("\n"),
    );
  });

  it("takes the width from the option", () => {
    // 20 columns for the one-line form, 14 for the inner one at its indent: a width
    // of 16 breaks the outer document and keeps the inner one whole.
    expect(stringify({ age: { $gt: 18 } }, { width: 16 })).toBe("{\n  age: { $gt: 18 }\n}");
  });

  it("width Infinity keeps the whole document on one line", () => {
    expect(stringify(wide, { width: Infinity })).toBe(
      '{ $group: { _id: "$userId", revenue: { $sum: "$total" }, orders: { $sum: 1 }, first: { $min: "$at" } } }',
    );
  });

  it("indent 0 does the same — a broken line would read as an unbroken one", () => {
    expect(stringify(wide, { indent: 0 })).toBe(stringify(wide, { width: Infinity }));
  });

  it("takes an indent width in spaces, or the string to indent with", () => {
    expect(stringify(wide, { indent: 4 }).split("\n")[1].startsWith("    $group")).toBe(true);
    expect(stringify(wide, { indent: "\t" }).split("\n")[1].startsWith("\t$group")).toBe(true);
  });

  it("counts the depth, so a nested line breaks against the same width", () => {
    const deep = { a: { b: { c: { d: { e: "0123456789012345678901234567890123456789012345678901234567890" } } } } };
    for (const line of stringify(deep).split("\n")) expect(line.length).toBeLessThanOrEqual(80 + 20);
    expect(stringify(deep).split("\n").length).toBeGreaterThan(1);
  });
});

describe("stringify: what it refuses", () => {
  it("refuses an Invalid Date, which has no BSON value", () => {
    expect(() => stringify({ v: new Date("nonsense") })).toThrow(
      "jsmql.stringify(): an Invalid Date has no BSON value to write.",
    );
  });

  it("refuses undefined, which the language declares a test and never a value", () => {
    expect(() => stringify({ v: undefined })).toThrow("jsmql.stringify(): 'undefined' is not a value MQL can hold.");
  });

  it("refuses a circular structure, which no text rebuilds", () => {
    const doc: Record<string, unknown> = { a: 1 };
    doc.self = doc;
    expect(() => stringify(doc)).toThrow("jsmql.stringify(): the document contains a circular reference.");
  });

  it("accepts the same value twice — a shared value is not a cycle", () => {
    const shared = { a: 1 };
    expect(stringify({ x: shared, y: shared })).toBe("{ x: { a: 1 }, y: { a: 1 } }");
  });
});

describe("stringify: the compiler's own documents", () => {
  it("prints a filter holding every literal kind the language folds", () => {
    const filter = jsmql(
      '$.status === "active" && $._id === 0x507f1f77bcf86cd799439011 && $.at > new Date("2026-01-01")',
    );
    expect(stringify(filter)).toBe(
      [
        "{",
        '  status: "active",',
        '  _id: new ObjectId("507f1f77bcf86cd799439011"),',
        '  at: { $gt: new Date("2026-01-01T00:00:00.000Z") }',
        "}",
      ].join("\n"),
    );
    expect(bytes(asPasted(stringify(filter)) as Record<string, unknown>)).toBe(
      bytes(filter as Record<string, unknown>),
    );
  });

  it("prints a field name JavaScript refuses to store the ordinary way", () => {
    const out = jsmql.update("$.__proto__ = 1");
    expect(stringify(out)).toBe('{ $set: { ["__proto__"]: 1 } }');
    const back = asPasted(stringify(out)) as { $set: Record<string, unknown> };
    expect(Object.hasOwn(back.$set, "__proto__")).toBe(true);
  });
});
