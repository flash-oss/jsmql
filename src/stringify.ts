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

/** A number as JavaScript source. `-0` prints as `0` through String(), and the two are different BSON doubles. */
const num = (n: number): string => (Object.is(n, -0) ? "-0" : String(n));

/**
 * The BSON classes, each as the expression that rebuilds it — or null when the value
 * wears the tag but does not carry the data behind it.
 *
 * Keyed by `_bsontype`, which every class sets and which is what the compiler itself
 * tests. A duck check does not work here: a driver `UUID` reports `_bsontype: "Binary"`
 * AND carries `toHexString`, so testing for that method calls a UUID an ObjectId and
 * prints text that throws in both runtimes.
 *
 * Every case reads its data defensively. A PLAIN OBJECT may wear the tag — the
 * compiler passes `{ _bsontype: "ObjectId", id: "xyz" }` through as the value it is —
 * and a printer that called the class's methods on it threw, and took the whole
 * document's output down with it. Null here prints the object as what it is.
 */
function bsonSource(tag: string, v: unknown, render: (x: unknown) => string): string | null {
  const o = v as Record<string, unknown>;
  /** A method the value itself provides, never the one every object inherits. */
  const own = (name: string): ((...args: unknown[]) => unknown) | null => {
    const f = o[name];
    const everyObject = (Object.prototype as unknown as Record<string, unknown>)[name];
    return typeof f === "function" && f !== everyObject ? (f as (...args: unknown[]) => unknown) : null;
  };
  /** The value's own `toString()` — every BSON class writes its value there. */
  const text = (): string | null => {
    const f = own("toString");
    return f === null ? null : String(f.call(v));
  };
  switch (tag) {
    // bson 1.x spelled the tag with an uppercase D, and the compiler reads both.
    case "ObjectID":
    case "ObjectId": {
      const hex = own("toHexString");
      return hex === null ? null : `new ObjectId(${str(String(hex.call(v)))})`;
    }
    case "Decimal128": {
      const s = text();
      return s === null ? null : `new Decimal128(${str(s)})`;
    }
    // `Long.fromString` rather than `new Long(low, high)`: the string is the value a
    // reader can check, and the two-word constructor is not.
    case "Long": {
      const s = text();
      return s === null ? null : `Long.fromString(${str(s)})`;
    }
    case "Int32":
      return typeof o.value === "number" ? `new Int32(${num(o.value)})` : null;
    // A whole-number Double must keep its type: `42` would come back as an int.
    case "Double":
      return typeof o.value === "number" ? `new Double(${num(o.value)})` : null;
    case "Binary": {
      const bytes = own("toString");
      if (bytes === null) return null;
      const sub = Number(o.sub_type ?? 0);
      // subtype 4 IS a UUID, and its own spelling reads as one.
      const uuid = own("toUUID");
      if (sub === 4 && uuid !== null) return `new UUID(${str(String(uuid.call(v)))})`;
      // MEASURED: a Binary filled a byte at a time over-allocates its buffer (260 bytes
      // held for 5 written), and only its own `toString` knows where the value ends.
      return `Binary.createFromBase64(${str(String(bytes.call(v, "base64")))}, ${sub})`;
    }
    case "Timestamp": {
      const t = Number(o.t ?? o.high ?? 0);
      const i = Number(o.i ?? o.low ?? 0);
      return Number.isFinite(t) && Number.isFinite(i) ? `new Timestamp({ t: ${t}, i: ${i} })` : null;
    }
    case "MinKey":
      return "new MinKey()";
    case "MaxKey":
      return "new MaxKey()";
    case "Code":
      if (typeof o.code !== "string") return null;
      return o.scope === undefined || o.scope === null
        ? `new Code(${str(o.code)})`
        : `new Code(${str(o.code)}, ${render(o.scope)})`;
    case "DBRef":
      if (typeof o.collection !== "string") return null;
      return o.db === undefined || o.db === null || o.db === ""
        ? `new DBRef(${str(o.collection)}, ${render(o.oid)})`
        : `new DBRef(${str(o.collection)}, ${render(o.oid)}, ${str(String(o.db))})`;
    case "BSONSymbol": {
      const s = text();
      return s === null ? null : `new BSONSymbol(${str(s)})`;
    }
    case "BSONRegExp":
      return typeof o.pattern === "string"
        ? `new BSONRegExp(${str(o.pattern)}, ${str(String(o.options ?? ""))})`
        : null;
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
    // A Uint8Array — a Node Buffer is one — carries bytes, and both runtimes store
    // it as BSON Binary subtype 0. MEASURED: mongosh and the driver each store
    // `new Uint8Array([1, 2, 3])` as Binary/0 and each match that document again with
    // the same text, so the bytes are written as themselves rather than translated to
    // a `Binary.createFromBase64(…)` call: what comes back is the value the document
    // holds, down to its JavaScript class. Without this the object branch below walks
    // the byte indices and prints `{ "0": 1, "1": 2 }`, which matches nothing.
    if (v instanceof Uint8Array) return `new Uint8Array([${Array.from(v).join(", ")}])`;
    const tag = tagOf(v);
    if (tag !== undefined) {
      const spelled = bsonSource(tag, v, (x) => render(x, 0));
      if (spelled !== null) return spelled;
    }
    const t = typeof v;
    if (t === "string") return str(v as string);
    if (t === "boolean") return String(v);
    if (t === "bigint") return `${String(v)}n`;
    if (t === "number") return num(v as number);
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
