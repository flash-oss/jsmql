// Two facts about the registry as a whole that no row can hold.
//
// The PENDING RATCHET: a cell that says `pending(<file>)` is a lowering still in
// the old compiler. The count may only fall — a rising count means a lowering was
// written as a placeholder instead of a rule, which is the habit the field exists
// to make visible.
//
// EVERY STATED RULE HAS A READER: a field on `Arity` or `BodyRule` that no line of
// the compiler reads is decoration a row author trusts and nothing enforces —
// `Arity.constant` and `BodyRule.constantKeys` were exactly that for a while.
// The check is a source grep over the emit phase and its readers, the same
// discipline fold-rows uses.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NAMES } from "../src/registry/names.ts";
import { PRODUCTIONS } from "../src/registry/productions.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Lower this as lowerings move into rows; never raise it. */
const MAX_PENDING = 377;

describe("registry — the pending ratchet", () => {
  it("holds at most MAX_PENDING pending cells, and the ceiling only falls", () => {
    const text = JSON.stringify(NAMES) + JSON.stringify(PRODUCTIONS);
    const count = (text.match(/"pending":"/g) ?? []).length;
    expect(count).toBeLessThanOrEqual(MAX_PENDING);
    // A ceiling far above the count is no ratchet: lower MAX_PENDING when this fires.
    expect(MAX_PENDING - count).toBeLessThan(10);
  });
});

describe("registry — every stated rule field has a reader in the compiler", () => {
  const ARITY = [
    "sig",
    "exact",
    "allowed",
    "atLeast",
    "none",
    "spread",
    "reject",
    "constant",
    "slotType",
    "slotEnums",
    "elementType",
    "emptyList",
    "nullRefused",
  ];
  const BODY = [
    "required",
    "optional",
    "closed",
    "enums",
    "charSets",
    "caseInsensitiveKeys",
    "keyTypes",
    "constantKeys",
    "exactlyOneOf",
    "positional",
  ];

  const sources = (dir: string): string =>
    readdirSync(join(ROOT, dir), { withFileTypes: true })
      .flatMap((d) =>
        d.isDirectory()
          ? [sources(join(dir, d.name))]
          : d.name.endsWith(".ts")
            ? [readFileSync(join(ROOT, dir, d.name), "utf8")]
            : [],
      )
      .join("\n");
  const compiler = sources("src/compiler");

  it.each([...ARITY, ...BODY])("reads %s somewhere in src/compiler", (field) => {
    // Read as a property (`args.slotType`, `rule.enums`) or destructured — either spelling is a read.
    expect(
      new RegExp(String.raw`[.{,\s]${field}\b(?!\s*:)`).test(compiler) ||
        new RegExp(String.raw`\.${field}\b`).test(compiler),
    ).toBe(true);
  });
});
