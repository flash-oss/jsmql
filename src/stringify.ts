/** How to lay the document out. */
export type StringifyOptions = {
  /** Spaces per level, or the literal string to indent with. Default 2. */
  indent?: number | string;
  /** Break a document across lines once its one-line form passes this. Default 80. */
  width?: number;
};

const tagOf = (v: unknown): string | undefined =>
  typeof v === "object" && v !== null ? ((v as { _bsontype?: string })._bsontype ?? undefined) : undefined;

const kindOf = (v: unknown): string => Object.prototype.toString.call(v);
const getterOf = (proto: object, key: PropertyKey): ((this: unknown) => unknown) =>
  Object.getOwnPropertyDescriptor(proto, key)!.get!;
const TYPED_ARRAY = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayName = getterOf(TYPED_ARRAY, Symbol.toStringTag);
const typedArrayLength = getterOf(TYPED_ARRAY, "length");
const regexSource = getterOf(RegExp.prototype, "source");
const regexFlags = getterOf(RegExp.prototype, "flags");

function dateTime(v: unknown): number | null {
  if (kindOf(v) !== "[object Date]") return null;
  try {
    return Date.prototype.getTime.call(v);
  } catch {
    return null;
  }
}

function regexLiteral(v: unknown): string | null {
  if (kindOf(v) !== "[object RegExp]") return null;
  try {
    return `/${String(regexSource.call(v))}/${String(regexFlags.call(v))}`;
  } catch {
    return null;
  }
}

function byteValues(v: unknown): number[] | null {
  if (typedArrayName.call(v) !== "Uint8Array") return null;
  const bytes = v as Uint8Array;
  return Array.from({ length: Number(typedArrayLength.call(v)) }, (_, i) => bytes[i]);
}

function keySource(key: string): string {
  if (key === "__proto__") return `[${JSON.stringify(key)}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

const str = (s: string): string => JSON.stringify(s);

const num = (n: number): string => (Object.is(n, -0) ? "-0" : String(n));

function bsonSource(tag: string, v: unknown, render: (x: unknown) => string): string | null {
  const o = v as Record<string, unknown>;
  const own = (name: string): ((...args: unknown[]) => unknown) | null => {
    const f = o[name];
    const everyObject = (Object.prototype as unknown as Record<string, unknown>)[name];
    return typeof f === "function" && f !== everyObject ? (f as (...args: unknown[]) => unknown) : null;
  };
  const text = (): string | null => {
    const f = own("toString");
    return f === null ? null : String(f.call(v));
  };
  switch (tag) {
    case "ObjectID":
    case "ObjectId": {
      const hex = own("toHexString");
      return hex === null ? null : `new ObjectId(${str(String(hex.call(v)))})`;
    }
    case "Decimal128": {
      const s = text();
      return s === null ? null : `new Decimal128(${str(s)})`;
    }
    case "Long": {
      const s = text();
      return s === null ? null : `new Long(${str(s)})`;
    }
    case "Int32":
      return typeof o.value === "number" ? `new Int32(${num(o.value)})` : null;
    case "Double":
      return typeof o.value === "number" ? `new Double(${num(o.value)})` : null;
    case "Binary": {
      const bytes = own("toString");
      if (bytes === null) return null;
      const sub = Number(o.sub_type ?? 0);
      const base64 = String(bytes.call(v, "base64"));
      const uuid = own("toUUID");
      if (sub === 4 && uuid !== null && /^[A-Za-z0-9+/]{22}==$/.test(base64))
        return `new UUID(${str(String(uuid.call(v)))})`;
      return `Binary.createFromBase64(${str(base64)}, ${sub})`;
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
    case "DBRef": {
      if (typeof o.collection !== "string") return null;
      const hasDb = o.db !== undefined && o.db !== null;
      const fields = typeof o.fields === "object" && o.fields !== null ? o.fields : {};
      const args = [str(o.collection), render(o.oid)];
      if (Object.keys(fields).length > 0) args.push(hasDb ? str(String(o.db)) : "undefined", render(fields));
      else if (hasDb) args.push(str(String(o.db)));
      return `new DBRef(${args.join(", ")})`;
    }
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
 * This function writes a document on ONE line when it fits inside `width`, and
 * breaks it one entry per line once it does not — MQL nests deeply and narrowly, so
 * a brace per line would bury the shape it is meant to show.
 */
export function stringify(value: unknown, options?: StringifyOptions): string {
  const indent = options?.indent ?? 2;
  const width = options?.width ?? 80;
  const pad = typeof indent === "string" ? indent : " ".repeat(indent);
  const seen = new Set<unknown>();

  const leaf = (v: unknown): string | null => {
    if (v === null) return "null";
    const time = dateTime(v);
    if (time !== null) {
      if (Number.isNaN(time)) throw new TypeError("jsmql.stringify(): an Invalid Date has no BSON value to write.");
      return `new Date(${str(new Date(time).toISOString())})`;
    }
    const regex = regexLiteral(v);
    if (regex !== null) return regex;
    const bytes = byteValues(v);
    if (bytes !== null) return `new Uint8Array([${bytes.join(", ")}])`;
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
