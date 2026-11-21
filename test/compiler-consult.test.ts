import { describe, expect, it } from "vitest";
import { consult, everyName, listedIn, positionOf, refusalSentence } from "../src/compiler/emit/consult.ts";
import type { Arity, Position } from "../src/registry/vocabulary.ts";
import { NAMES } from "../src/registry/names.ts";
import { single } from "../src/registry/vocabulary.ts";
import { PRODUCTIONS } from "../src/registry/productions.ts";

const POSITIONS: readonly Position[] = ["value", "filter", "stream", "statement", "group", "window", "updateDoc"];
const EVERY_ROW: readonly string[] = [...Object.keys(NAMES), ...Object.keys(PRODUCTIONS)];

const pairs = (): [string, Position][] => EVERY_ROW.flatMap((n) => POSITIONS.map((p): [string, Position] => [n, p]));

describe("compiler/emit/consult — `where` and the cells cannot disagree", () => {
  it("never refuses a position the row lists", () => {
    const wrong = pairs()
      .filter(([n, p]) => listedIn(n, p) && consult(n, p).kind === "refused")
      .map(([n, p]) => `${n} @ ${p}`);
    expect(wrong).toEqual([]);
  });

  it("never offers a lowering for a position the row omits", () => {
    const wrong = pairs()
      .filter(([n, p]) => {
        if (listedIn(n, p)) return false;
        return consult(n, p).kind === "lower";
      })
      .map(([n, p]) => `${n} @ ${p}`);
    expect(wrong).toEqual([]);
  });
});

describe("compiler/emit/consult — EVERY refusal is usable", () => {
  const refusals = () =>
    pairs()
      .map(([n, p]) => [n, p, consult(n, p)] as const)
      .filter(
        (r): r is [string, Position, Extract<ReturnType<typeof consult>, { kind: "refused" }>] =>
          r[2].kind === "refused",
      );

  it("carries text", () => {
    const empty = refusals()
      .filter(([, , v]) => v.message.trim() === "")
      .map(([n, p]) => `${n} @ ${p}`);
    expect(empty).toEqual([]);
  });

  it("either names the CONSTRUCT itself or says the caller supplies it", () => {
    const silent = Object.keys(NAMES)
      .flatMap((n) => POSITIONS.map((p) => [n, p, consult(n, p)] as const))
      .filter(([n, , v]) => v.kind === "refused" && !v.needsSubject && !v.message.includes(n))
      .map(([n, p]) => `${n} @ ${p}`);
    expect(silent).toEqual([]);
  });

  it("builds one sentence from the row's reason and the caller's SPELLING", () => {
    const v = consult("toReversed", "stream");
    if (v.kind !== "refused") throw new Error("expected a refusal");
    expect(v.needsSubject).toBe(true);
    expect(refusalSentence(v, "'.toReversed(...)'", "'$$'")).toMatch(
      /^'\.toReversed\(\.\.\.\)' isn't available on '\$\$' — reverses the stream/,
    );
  });

  it("leaves a complete message alone", () => {
    const v = consult("trim", "stream");
    if (v.kind !== "refused") throw new Error("expected a refusal");
    expect(v.needsSubject).toBe(false);
    expect(refusalSentence(v, "IGNORED", "IGNORED")).toBe(v.message);
  });
});

describe("compiler/emit/consult — the other verdicts", () => {
  it("names a real row for every compose-only owner", () => {
    const known = new Set(EVERY_ROW);
    const dangling = pairs()
      .map(([n, p]) => consult(n, p))
      .filter((v) => v.kind === "composedOnly")
      .flatMap((v) => (v.kind === "composedOnly" ? v.owners.filter((o) => !known.has(o)) : []));
    expect(dangling).toEqual([]);
  });

  it("has no cell only where that kind of thing can never stand", () => {
    const allowed: Readonly<Record<string, readonly Position[]>> = {
      production: ["group", "window", "updateDoc"],
      name: ["updateDoc"],
    };
    const odd = pairs()
      .filter(([n, p]) => consult(n, p).kind === "noCell")
      .filter(([n, p]) => {
        const row = (NAMES as Record<string, { kind?: string; where?: readonly string[] }>)[n];
        if (row?.kind === "mongo") return row.where?.includes(p) === true;
        const kind = n in PRODUCTIONS ? "production" : "name";
        return !allowed[kind].includes(p);
      })
      .map(([n, p]) => `${n} @ ${p}`);
    expect(odd).toEqual([]);
  });

  it("resolves a per-family cell when the family is known, and reports the branches when it is not", () => {
    expect(consult("size", "filter", "array").kind).toBe("fallback");
    expect(consult("size", "filter", "stream").kind).toBe("refused");
    expect(consult("size", "filter").kind).toBe("perFamily");
    expect(consult("length", "filter").kind).toBe("fallback");
    expect(consult("length", "filter", "string").kind).toBe("fallback");
  });

  it("reads a CONSTRUCT as well as a name", () => {
    const v = consult("remainder", "filter");
    expect(v.kind).toBe("composedOnly");
    if (v.kind === "composedOnly") expect(v.owners).toContain("strictEquality");
  });

  it("says unknown for a name no row holds", () => {
    expect(consult("noSuchThing", "value")).toEqual({ kind: "unknown", name: "noSuchThing" });
    expect(everyName()).toContain("toSorted");
    expect(everyName()).not.toContain("remainder");
  });
});

describe("compiler/emit/consult — a waypoint is not a position", () => {
  it("names a position for the three that are one, and none for the rest", () => {
    expect(positionOf({ at: "value" })).toBe("value");
    expect(positionOf({ at: "stream" })).toBe("stream");
    expect(positionOf({ at: "statement" })).toBe("statement");
    expect(positionOf({ at: "target" })).toBeNull();
    expect(positionOf({ at: "stageBody", stage: "$lookup" })).toBeNull();
  });
});

describe("registry — a production names itself by its spelling, not its key", () => {
  type Row = { spelling: string } & Record<string, { unsupported?: string; subjectFromCaller?: true } | unknown>;
  const productions = (): [string, Row][] => Object.entries(PRODUCTIONS) as [string, Row][];
  const CELLS = ["filter", "expr", "stream", "statement"] as const;

  it("states a spelling on every row", () => {
    const missing = productions()
      .filter(([, r]) => typeof r.spelling !== "string" || r.spelling.length === 0)
      .map(([k]) => k);
    expect(missing).toEqual([]);
  });

  it("never leaks the descriptive key into a message a user reads", () => {
    const leaks: string[] = [];
    for (const [key, row] of productions()) {
      for (const cell of CELLS) {
        const message = (row[cell] as { unsupported?: string } | undefined)?.unsupported;
        if (typeof message === "string" && message.includes(key)) leaks.push(`${key} @ ${cell}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("names the spelling in every refusal that carries its own subject", () => {
    const silent: string[] = [];
    for (const [key, row] of productions()) {
      for (const cell of CELLS) {
        const c = row[cell] as { unsupported?: string; subjectFromCaller?: true } | undefined;
        if (typeof c?.unsupported !== "string" || c.subjectFromCaller === true) continue;
        if (!c.unsupported.includes(row.spelling)) silent.push(`${key} @ ${cell} (${row.spelling})`);
      }
    }
    expect(silent).toEqual([]);
  });

  it("gives a spelling that is not the key it replaces", () => {
    const same = productions()
      .filter(([k, r]) => r.spelling === k)
      .map(([k]) => k);
    expect(same).toEqual([]);
  });
});

describe("registry — a stage is one construct with two spellings", () => {
  const stageRows = (): [string, { where: readonly Position[]; kind?: string }][] =>
    (Object.entries(NAMES) as [string, { where: readonly Position[]; kind?: string }][]).filter(
      ([, r]) => r.kind === "mongo" && r.where.includes("stream"),
    );

  it("lists both positions on every stage row", () => {
    const oneSided = stageRows()
      .filter(([, r]) => !r.where.includes("statement"))
      .map(([n]) => n);
    expect(oneSided).toEqual([]);
  });

  it("renders the same document in both", () => {
    type Emit = (ctx: unknown) => unknown;
    const BODIES = [
      { type: "ObjectLiteral", entries: [], pos: 0 },
      { type: "NumberLiteral", value: 5, pos: 0 },
      { type: "StringLiteral", value: "$x", pos: 0 },
    ];
    const render = (name: string, emit: Emit, body: unknown): string => {
      const ctx = new Proxy(
        {},
        {
          get: (_, p) =>
            p === "name"
              ? name
              : p === "args"
                ? [body]
                : p === "pos"
                  ? 0
                  : (...a: unknown[]) => `<${String(p)}:${JSON.stringify(a)}>`,
        },
      );
      try {
        return JSON.stringify(emit(ctx));
      } catch (e) {
        return `refused: ${(e as Error).message}`;
      }
    };
    const differ: string[] = [];
    let rendered = 0;
    for (const [name] of stageRows()) {
      const stream = consult(name, "stream");
      const statement = consult(name, "statement");
      if (stream.kind !== statement.kind) differ.push(`${name}: ${stream.kind} and ${statement.kind}`);
      else if (stream.kind === "lower" && statement.kind === "lower") {
        const a = BODIES.map((b) => render(name, (stream.cell as { emit: Emit }).emit, b));
        const b = BODIES.map((b) => render(name, (statement.cell as { emit: Emit }).emit, b));
        if (a.some((x) => !x.startsWith("refused:"))) rendered += 1;
        if (JSON.stringify(a) !== JSON.stringify(b)) differ.push(`${name}: ${a[0]} and ${b[0]}`);
      }
    }
    expect(differ).toEqual([]);
    expect(rendered).toBe(stageRows().length);
  });
});

describe("registry — an operator cannot accept more operands than it renders", () => {
  type Shape = "single" | "verbatim" | "array" | "none" | "flex" | { object: unknown };
  type Cell = { args?: Arity; emit?: unknown };
  type Row = { kind?: string; shape?: Shape; keys?: readonly string[] } & Partial<Record<Position, Cell>>;

  const SHAPED: readonly Position[] = ["value", "group", "window", "updateDoc"];
  const arityCells = (row: Row): Cell[] =>
    SHAPED.map((p) => row[p === "value" ? ("expr" as Position) : p]).filter(
      (c): c is Cell => c !== undefined && typeof c === "object" && c.args !== undefined,
    );

  const renders = (row: Row): number => {
    const shape = row.shape as Shape;
    if (shape === "none") return 0;
    if (shape === "single" || shape === "verbatim") return 1;
    if (typeof shape === "object") return row.keys?.length ?? 1;
    return Infinity;
  };

  const accepts = (args: Arity | undefined): number => {
    if (args === undefined) return Infinity;
    if (args.none === true) return 0;
    if (args.exact !== undefined) return args.exact;
    if (args.allowed !== undefined) return Math.max(...args.allowed);
    return Infinity;
  };

  it("never states an arity its shape cannot render", () => {
    const wrong: string[] = [];
    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      if (row.kind !== "mongo" || row.shape === undefined) continue;
      const capacity = renders(row);
      for (const cell of arityCells(row)) {
        if (cell.emit === undefined) continue;
        const ceiling = accepts(cell.args);
        if (ceiling > capacity) wrong.push(`${name}: accepts ${ceiling}, renders ${capacity}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("never lets an accumulator slot state an unbounded operand count", () => {
    const unbounded: string[] = [];
    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      for (const pos of ["group", "window"] as const) {
        const cell = row[pos];
        if (cell === undefined || typeof cell !== "object" || cell.args === undefined) continue;
        if ((cell.args as { atLeast?: number }).atLeast !== undefined) unbounded.push(`${name}.${pos}`);
      }
    }
    expect(unbounded).toEqual([]);
  });

  it("states `exact: 1` wherever an accumulator slot renders through `single`", () => {
    const wrong: string[] = [];
    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      for (const pos of ["group", "window"] as const) {
        const cell = row[pos];
        if (cell === undefined || typeof cell !== "object" || cell.emit !== single) continue;
        if ((cell.args as { exact?: number } | undefined)?.exact !== 1) wrong.push(`${name}.${pos}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("states the key order for every object-shaped operator that takes a positional call", () => {
    const missing: string[] = [];
    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      if (row.kind !== "mongo" || typeof row.shape !== "object") continue;
      const ceiling = Math.max(0, ...arityCells(row).map((c) => accepts(c.args)));
      if (ceiling <= 1) continue;
      if (row.keys === undefined) missing.push(name);
    }
    expect(missing).toEqual([]);
  });
});

describe("registry — exactly the value-producing rows state a return type", () => {
  type Row = { kind?: string; where?: readonly Position[]; returns?: unknown };
  const PRODUCES: readonly Position[] = ["value", "group", "window"];
  const produces = (row: Row): boolean => PRODUCES.some((p) => row.where?.includes(p) === true);

  it("states one on every value-producing row and on no other", () => {
    const wrong: string[] = [];
    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      if (row.kind !== "mongo" && row.kind !== "root") continue;
      const stated = row.returns !== undefined;
      if (produces(row) !== stated) wrong.push(`${name}: produces=${produces(row)} states=${stated}`);
    }
    expect(wrong).toEqual([]);
  });

  it("names a kind the vocabulary has, bare or as the element of an `arrayOf`; an accumulator's element may be its operand", () => {
    const KINDS: readonly string[] = [
      "string",
      "array",
      "number",
      "object",
      "date",
      "bool",
      "stream",
      "objectId",
      "binData",
      "unknown",
    ];
    const wrong: string[] = [];
    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      if (row.kind !== "mongo" && row.kind !== "root") continue;
      if (row.returns === undefined) continue;
      const r = row.returns as string | { arrayOf?: unknown };
      const bare = typeof r === "string" ? r : typeof r === "object" && r !== null ? r.arrayOf : undefined;
      const operand = typeof bare === "object" && bare !== null && "arg" in bare;
      if (!operand && (typeof bare !== "string" || !KINDS.includes(bare))) {
        wrong.push(`${name} = ${JSON.stringify(row.returns)}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
