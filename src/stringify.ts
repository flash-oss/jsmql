// MQL written out as the JavaScript SOURCE that rebuilds it.
//
// `JSON.stringify` cannot spell what MQL holds. A Date and an ObjectId each carry a
// `toJSON`, so both collapse to strings the server compares as strings; a live RegExp
// becomes `{}`; every other BSON class becomes its internal byte fields. The document
// still runs — and matches nothing, which is the worst failure a query can have.
//
// So every value is written as the expression that MAKES it. The spelling is the one
// the Node driver requires, `new X(…)`, and MEASURED in mongosh 2.9.2 the same text
// runs there and yields the identical value — mongosh exposes the driver's BSON
// classes as globals on top of its own `ISODate` / `NumberDecimal` helpers. There is
// therefore ONE spelling per type rather than one per runtime. The bare-call forms
// (`ObjectId("…")`, `MinKey()`) run only in mongosh, and the helper names
// (`ISODate`, `NumberLong`, `BinData`) only there too, so neither is written.
//
// Pasting into a driver script needs the classes in scope:
//   const { ObjectId, Decimal128, Long, Int32, Double, Binary, UUID, Timestamp,
//           MinKey, MaxKey, Code, DBRef, BSONSymbol, BSONRegExp } = require("mongodb");
// mongosh has them already.
//
// See docs/specs/mql-stringify.md.

/** How to lay the document out. */
export type StringifyOptions = {
  /** Spaces per level, or the literal string to indent with. Default 2. */
  indent?: number | string;
  /** Break a document across lines once its one-line form passes this. Default 80. */
  width?: number;
};

/** A value carrying MongoDB's own type tag — every `bson` class sets one. */
const tagOf = (v: unknown): string | undefined =>
  typeof v === "object" && v !== null ? ((v as { _bsontype?: string })._bsontype ?? undefined) : undefined;

/**
 * A key as JavaScript source.
 *
 * `__proto__` is the one name a quoted key cannot carry: in an object literal
 * `{"__proto__": 1}` sets the prototype and creates no own property, so the field
 * would vanish the moment the printed text was pasted back — MEASURED in mongosh and
 * in Node alike. The computed form is the only spelling that survives.
 */
function keySource(key: string): string {
  if (key === "__proto__") return `[${JSON.stringify(key)}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/** A string as a JavaScript string literal — `JSON.stringify` is exactly that grammar. */
const str = (s: string): string => JSON.stringify(s);

/**
 * The BSON classes, each as the expression that rebuilds it.
 *
 * Keyed by `_bsontype`, which every class sets and which is what the compiler itself
 * tests. A duck check does not work here: a driver `UUID` reports `_bsontype: "Binary"`
 * AND carries `toHexString`, so testing for that method calls a UUID an ObjectId and
 * prints text that throws in both runtimes.
 */
function bsonSource(tag: string, v: unknown, render: (x: unknown) => string): string | null {
  const o = v as Record<string, unknown>;
  switch (tag) {
    case "ObjectId":
      return `new ObjectId(${str((o.toHexString as () => string).call(v))})`;
    case "Decimal128":
      return `new Decimal128(${str(String(v))})`;
    // `Long.fromString` rather than `new Long(low, high)`: the string is the value a
    // reader can check, and the two-word constructor is not.
    case "Long":
      return `Long.fromString(${str(String(v))})`;
    case "Int32":
      return `new Int32(${String(o.value ?? v)})`;
    // A whole-number Double must keep its type: `42` would come back as an int.
    case "Double":
      return `new Double(${String(o.value ?? v)})`;
    case "Binary": {
      const sub = Number(o.sub_type ?? 0);
      const base64 = (o.toString as (e: string) => string).call(v, "base64");
      // subtype 4 IS a UUID, and its own spelling reads as one.
      if (sub === 4 && typeof o.toUUID === "function") return `new UUID(${str(String((o.toUUID as () => unknown)()))})`;
      return `Binary.createFromBase64(${str(base64)}, ${sub})`;
    }
    case "Timestamp":
      return `new Timestamp({ t: ${Number(o.t ?? o.high ?? 0)}, i: ${Number(o.i ?? o.low ?? 0)} })`;
    case "MinKey":
      return "new MinKey()";
    case "MaxKey":
      return "new MaxKey()";
    case "Code":
      return o.scope === undefined || o.scope === null
        ? `new Code(${str(String(o.code))})`
        : `new Code(${str(String(o.code))}, ${render(o.scope)})`;
    case "DBRef":
      return o.db === undefined || o.db === null || o.db === ""
        ? `new DBRef(${str(String(o.collection))}, ${render(o.oid)})`
        : `new DBRef(${str(String(o.collection))}, ${render(o.oid)}, ${str(String(o.db))})`;
    case "BSONSymbol":
      return `new BSONSymbol(${str(String(v))})`;
    case "BSONRegExp":
      return `new BSONRegExp(${str(String(o.pattern))}, ${str(String(o.options ?? ""))})`;
    default:
      return null;
  }
}

/**
 * MQL as pasteable JavaScript source.
 *
 * A document is written on ONE line while it fits inside `width`, and broken one entry
 * per line once it does not — MQL nests deeply and narrowly, so a brace per line buries
 * the shape it is meant to show.
 */
export function stringify(value: unknown, options?: StringifyOptions): string {
  const indent = options?.indent ?? 2;
  const width = options?.width ?? 80;
  const pad = typeof indent === "string" ? indent : " ".repeat(indent);
  const seen = new Set<unknown>();

  const leaf = (v: unknown): string | null => {
    if (v === null) return "null";
    if (v instanceof Date) {
      // An Invalid Date has no BSON form: the driver stores it as epoch 0, so any
      // spelling would print a value the document does not hold.
      if (Number.isNaN(v.getTime()))
        throw new TypeError("jsmql.stringify(): an Invalid Date has no BSON value to write.");
      return `new Date(${str(v.toISOString())})`;
    }
    if (v instanceof RegExp) return String(v);
    const tag = tagOf(v);
    if (tag !== undefined) {
      const spelled = bsonSource(tag, v, (x) => render(x, 0));
      if (spelled !== null) return spelled;
    }
    const t = typeof v;
    if (t === "string") return str(v as string);
    if (t === "boolean") return String(v);
    if (t === "bigint") return `${String(v)}n`;
    if (t === "number") {
      // `-0` prints as `0` through String(), and the two are different BSON doubles.
      if (Object.is(v, -0)) return "-0";
      if (!Number.isFinite(v as number)) return String(v);
      return String(v);
    }
    if (t === "undefined") {
      // The language declares `undefined` an existence TEST, never a value, so it is
      // refused at every entry point and cannot reach a compiled document. Reaching
      // here means a guard was missed, and printing nothing would hide it.
      throw new TypeError("jsmql.stringify(): 'undefined' is not a value MQL can hold.");
    }
    return null;
  };

  const render = (v: unknown, depth: number): string => {
    const simple = leaf(v);
    if (simple !== null) return simple;
    if (seen.has(v)) throw new TypeError("jsmql.stringify(): the document contains a circular reference.");
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (v.length === 0) return "[]";
        const parts = v.map((x) => render(x, depth + 1));
        const flat = `[${parts.join(", ")}]`;
        if (pad === "" || fits(flat, depth)) return flat;
        return `[\n${parts.map((p) => at(depth + 1) + p).join(",\n")}\n${at(depth)}]`;
      }
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) return "{}";
      const parts = entries.map(([k, x]) => `${keySource(k)}: ${render(x, depth + 1)}`);
      const flat = `{ ${parts.join(", ")} }`;
      if (pad === "" || fits(flat, depth)) return flat;
      return `{\n${parts.map((p) => at(depth + 1) + p).join(",\n")}\n${at(depth)}}`;
    } finally {
      seen.delete(v);
    }
  };

  const at = (d: number): string => pad.repeat(d);
  const fits = (text: string, depth: number): boolean =>
    !text.includes("\n") && at(depth).length + text.length <= width;

  return render(value, 0);
}
