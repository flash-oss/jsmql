// Phase 5 of src/compiler/ — what a row says about one name in one position.
//
// The value of asking the registry is that the answer covers EVERY name and
// EVERY position at once, so the tests here are over the whole table rather than
// over examples. An example test proves one row; a table test proves the rule.

import { describe, expect, it } from "vitest";
import { consult, everyName, listedIn, positionOf, refusalSentence } from "../src/compiler/emit/consult.ts";
import type { Arity, Position } from "../src/registry/vocabulary.ts";
import { NAMES } from "../src/registry/names.ts";
import { accumulated } from "../src/registry/vocabulary.ts";
import { OPERATOR_RETURNS } from "../src/operators.ts";
import { PRODUCTIONS } from "../src/registry/productions.ts";

const POSITIONS: readonly Position[] = ["value", "filter", "stream", "statement", "group", "window", "updateDoc"];
const EVERY_ROW: readonly string[] = [...Object.keys(NAMES), ...Object.keys(PRODUCTIONS)];

/** Every (row, position) pair, which is the whole surface being asserted over. */
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
        const kind = consult(n, p).kind;
        return kind === "lower" || kind === "pending";
      })
      .map(([n, p]) => `${n} @ ${p}`);
    expect(wrong).toEqual([]);
  });
});

describe("compiler/emit/consult — every refusal is usable", () => {
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

  it("either names the construct itself or says the caller supplies it", () => {
    // The alternative to the flag is reading the first letter of the message and
    // guessing whether a subject is missing — a coupling nothing declares.
    //
    // NAMES only. A production is keyed descriptively — `remainder`, never `"%"`
    // — so its key is not what a user typed and naming it would be the bug, not
    // the fix. The rule for those is the next test.
    const silent = Object.keys(NAMES)
      .flatMap((n) => POSITIONS.map((p) => [n, p, consult(n, p)] as const))
      .filter(([n, , v]) => v.kind === "refused" && !v.needsSubject && !v.message.includes(n))
      .map(([n, p]) => `${n} @ ${p}`);
    expect(silent).toEqual([]);
  });

  it("builds one sentence from the row's reason and the caller's spelling", () => {
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
    // A production has four cells and a name has six, and both are right. Only a
    // MongoDB operator is ever specific to an update document, and a CONSTRUCT is
    // never an accumulator: `$cond` inside `$group` sits in an accumulator's
    // ARGUMENT, which is value position, not the accumulator slot itself.
    const allowed: Readonly<Record<string, readonly Position[]>> = {
      production: ["group", "window", "updateDoc"],
      name: ["updateDoc"],
    };
    const odd = pairs()
      .filter(([n, p]) => consult(n, p).kind === "noCell")
      .filter(([n, p]) => {
        const kind = n in PRODUCTIONS ? "production" : "name";
        const mongo = (NAMES as Record<string, { kind?: string }>)[n]?.kind === "mongo";
        return mongo || !allowed[kind].includes(p);
      })
      .map(([n, p]) => `${n} @ ${p}`);
    expect(odd).toEqual([]);
  });

  it("resolves a per-family cell when the family is known, and reports the branches when it is not", () => {
    // `.length` is the worked case: two families merely scan, the third does not
    // compile at all, and one answer for all three claimed the wrong thing.
    expect(consult("length", "filter", "array").kind).toBe("fallback");
    expect(consult("length", "filter", "string").kind).toBe("fallback");
    expect(consult("length", "filter", "stream").kind).toBe("refused");
    expect(consult("length", "filter").kind).toBe("perFamily");
  });

  it("reads a construct as well as a name", () => {
    // `%` alone has no query form; `$.a % 2 === 0` does, and the fold belongs to
    // the equality row. Both facts come from the same lookup.
    const v = consult("remainder", "filter");
    expect(v.kind).toBe("composedOnly");
    if (v.kind === "composedOnly") expect(v.owners).toContain("strictEquality");
  });

  it("says unknown for a name no row holds", () => {
    expect(consult("noSuchThing", "value")).toEqual({ kind: "unknown", name: "noSuchThing" });
    expect(everyName()).toContain("toSorted");
    // A construct is not something a user misspells, so it is not a suggestion.
    expect(everyName()).not.toContain("remainder");
  });
});

describe("compiler/emit/consult — a waypoint is not a position", () => {
  it("names a position for the three that are one, and none for the rest", () => {
    expect(positionOf({ at: "value" })).toBe("value");
    expect(positionOf({ at: "stream" })).toBe("stream");
    expect(positionOf({ at: "statement" })).toBe("statement");
    // Nothing is evaluated on the left of `=`, and a stage body is on the way to
    // a position rather than being one.
    expect(positionOf({ at: "target" })).toBeNull();
    expect(positionOf({ at: "stageBody", stage: "$lookup" })).toBeNull();
  });
});

describe("registry — a production names itself by its SPELLING, never by its key", () => {
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
    // The key exists so two rules cannot collide on a symbol. Nobody types the
    // word "conditional", so a message that quotes it is unusable.
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
  /** Every MongoDB row that is a pipeline stage: the ones listing `stream`. */
  const stageRows = (): [string, { where: readonly Position[]; kind?: string }][] =>
    (Object.entries(NAMES) as [string, { where: readonly Position[]; kind?: string }][]).filter(
      ([, r]) => r.kind === "mongo" && r.where.includes("stream"),
    );

  it("lists both positions on every stage row", () => {
    // `$match(<body>);` and `$$ = $$.$match(<body>)` are the same stage written
    // two ways, and the language accepts both — measured on every one of them.
    // A row that listed only `stream` refused the canonical spelling, which is
    // the one every pipeline program in the docs uses.
    const oneSided = stageRows()
      .filter(([, r]) => !r.where.includes("statement"))
      .map(([n]) => n);
    expect(oneSided).toEqual([]);
  });

  it("renders the same document in both", () => {
    const differ: string[] = [];
    for (const [name] of stageRows()) {
      const stream = consult(name, "stream");
      const statement = consult(name, "statement");
      if (stream.kind !== statement.kind) differ.push(`${name}: ${stream.kind} vs ${statement.kind}`);
      else if (stream.kind === "lower" && statement.kind === "lower") {
        // The same emitter, not merely an equivalent one: one construct, one
        // rendering, so the two cannot drift apart later.
        if (JSON.stringify(stream.cell) !== JSON.stringify(statement.cell)) differ.push(`${name}: cells differ`);
      }
    }
    expect(differ).toEqual([]);
  });
});

describe("registry — an operator cannot accept more operands than it renders", () => {
  type Shape = "single" | "verbatim" | "array" | "none" | "flex" | { object: { positional?: readonly string[] } };
  type Cell = { args?: Arity; emit?: unknown };
  type Row = { kind?: string; shape?: Shape } & Partial<Record<Position, Cell>>;

  /**
   * The cells whose rendering is governed by the row's `shape` — the ones that
   * put OPERANDS into `{ $name: … }`.
   *
   * `stream` and `statement` are not among them: a stage renders its BODY, and
   * `$count` proves the two are different renderings of one row — `$count("total")`
   * is a stage taking one argument, while `$count()` as an accumulator takes none.
   * `filter` renders a query document, which is not this shape either.
   */
  const SHAPED: readonly Position[] = ["value", "group", "window", "updateDoc"];
  const arityCells = (row: Row): Cell[] =>
    SHAPED.map((p) => row[p === "value" ? ("expr" as Position) : p]).filter(
      (c): c is Cell => c !== undefined && typeof c === "object" && c.args !== undefined,
    );

  /** How many operands the row's SHAPE can actually put into a document. */
  const renders = (shape: Shape): number => {
    if (shape === "none") return 0;
    if (shape === "single" || shape === "verbatim") return 1;
    if (typeof shape === "object") return shape.object.positional?.length ?? 1;
    return Infinity; // "array" and "flex" render the whole list
  };

  /** The most operands the row's ARITY lets through. */
  const accepts = (args: Arity | undefined): number => {
    if (args === undefined) return Infinity;
    if (args.none === true) return 0;
    if (args.exact !== undefined) return args.exact;
    if (args.allowed !== undefined) return Math.max(...args.allowed);
    return Infinity; // `atLeast` states no ceiling
  };

  it("never states an arity its shape cannot render", () => {
    // An operand accepted and then not rendered VANISHES. `$abs($.a, $.b)` used
    // to emit `{"$abs":"$a"}` — valid MQL and the wrong answer — and the three
    // object-shaped date operators emitted a shape mongod refuses outright:
    //   {$dateDiff:"$a"} → "$dateDiff only supports an object as its argument"
    // `BodyRule.positional`'s own doc records this regression once already.
    const wrong: string[] = [];
    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      if (row.kind !== "mongo" || row.shape === undefined) continue;
      const capacity = renders(row.shape);
      for (const cell of arityCells(row)) {
        if (cell.emit === undefined) continue;
        const ceiling = accepts(cell.args);
        if (ceiling > capacity) wrong.push(`${name}: accepts ${ceiling}, renders ${capacity}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("never lets an accumulator slot state an unbounded operand count", () => {
    // A `$group` output slot and a `$setWindowFields.output` slot each take ONE
    // expression, and the two report a second operand differently:
    //   {$group:{_id:null,s:{$sum:["$x","$y"]}}}          → "unary operator"
    //   {$setWindowFields:{…,output:{r:{$sum:["$x","$y"]}}}}  → 0, where "$x" → 4
    // The second is the reason `atLeast` is banned here rather than merely
    // discouraged: nothing reports it, so only the registry can.
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

  it("states `exact: 1` wherever the accumulator emitter renders the operand", () => {
    // `accumulated` reads args[0] and nothing else. Any other count would drop
    // an operand the row said it would accept.
    const wrong: string[] = [];
    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      for (const pos of ["group", "window"] as const) {
        const cell = row[pos];
        if (cell === undefined || typeof cell !== "object" || cell.emit !== accumulated) continue;
        if ((cell.args as { exact?: number } | undefined)?.exact !== 1) wrong.push(`${name}.${pos}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("states the key order for every object-shaped operator that takes a positional call", () => {
    const missing: string[] = [];
    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      if (row.kind !== "mongo" || typeof row.shape !== "object") continue;
      // One argument is the object literal itself and needs no key order.
      const ceiling = Math.max(0, ...arityCells(row).map((c) => accepts(c.args)));
      if (ceiling <= 1) continue;
      if (row.shape.object.positional === undefined) missing.push(name);
    }
    expect(missing).toEqual([]);
  });
});

describe("registry — exactly the value-producing rows state a return type", () => {
  type Row = { kind?: string; where?: readonly Position[]; returns?: unknown };
  /** The positions in which a name produces a VALUE whose type a caller can use. */
  const PRODUCES: readonly Position[] = ["value", "group", "window"];
  const produces = (row: Row): boolean => PRODUCES.some((p) => row.where?.includes(p) === true);

  it("states one on every value-producing row and on no other", () => {
    // A missing `returns` and a `returns: "unknown"` mean the same thing to a
    // type check and different things to a reader: absent is "produces no value
    // at all", `"unknown"` is "a value whose type follows the operands". Tying
    // presence to `where` is what keeps the two from being read as one.
    const wrong: string[] = [];
    for (const [name, row] of Object.entries(NAMES) as [string, Row][]) {
      if (row.kind !== "mongo" && row.kind !== "root") continue;
      const stated = row.returns !== undefined;
      if (produces(row) !== stated) wrong.push(`${name}: produces=${produces(row)} states=${stated}`);
    }
    expect(wrong).toEqual([]);
  });

  it("names a kind the vocabulary has", () => {
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
      if (typeof row.returns !== "string" || !KINDS.includes(row.returns)) {
        wrong.push(`${name} = ${JSON.stringify(row.returns)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("agrees with the shipped table wherever both state one", () => {
    // The shipped `OPERATOR_RETURNS` holds 127 entries, each measured on a
    // mongod when it was written. An independent re-measurement agreed with all
    // 127, so a disagreement here is a regression in one of the two, not a
    // difference of opinion.
    const differ: string[] = [];
    for (const [name, shipped] of Object.entries(OPERATOR_RETURNS)) {
      const row = (NAMES as Record<string, Row>)[name];
      if (row?.returns === undefined || row.returns === "unknown") continue;
      if (row.returns !== shipped) differ.push(`${name}: registry=${String(row.returns)} shipped=${shipped}`);
    }
    expect(differ).toEqual([]);
  });
});
