// Phase 5 of src/compiler/ — what a row says about one name in one position.
//
// The value of asking the registry is that the answer covers EVERY name and
// EVERY position at once, so the tests here are over the whole table rather than
// over examples. An example test proves one row; a table test proves the rule.

import { describe, expect, it } from "vitest";
import { consult, everyName, listedIn, positionOf, refusalSentence } from "../src/compiler/emit/consult.ts";
import type { Position } from "../src/registry/vocabulary.ts";
import { NAMES } from "../src/registry/names.ts";
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
