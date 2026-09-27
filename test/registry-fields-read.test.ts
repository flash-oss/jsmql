// One fact about the registry as a whole that no row can hold.
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The fields a type declares, read from its source in src/registry/vocabulary.ts:
 * every `  name:` or `  name?:` line at the top level of `export type <T> = { … };`.
 * The list is read, not copied, so a new field on the type joins the check.
 */
function fieldsOf(type: string): string[] {
  const voc = readFileSync(join(ROOT, "src/registry/vocabulary.ts"), "utf8");
  const start = voc.indexOf(`export type ${type} = {`);
  expect(start, `type ${type} exists`).toBeGreaterThanOrEqual(0);
  const body = voc.slice(start, voc.indexOf("\n};", start));
  return [...body.matchAll(/^ {2}(?:readonly )?([A-Za-z]+)\??:/gm)].map((m) => m[1]);
}

describe("registry — every stated rule field has a reader in the compiler", () => {
  const ARITY = fieldsOf("Arity");
  const BODY = fieldsOf("BodyRule");

  it("reads the field lists off the two types", () => {
    expect(ARITY.length).toBeGreaterThanOrEqual(15);
    expect(BODY.length).toBeGreaterThanOrEqual(8);
    expect(ARITY).toContain("sig");
    expect(BODY).toContain("required");
  });

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
  // The code alone: a field name in a comment is prose, not a read. The strip is
  // crude — a `//` inside a string also cuts the line — but it can only hide a read,
  // so it can make the gate fail, never pass.
  const compiler = sources("src/compiler")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");

  it.each([...ARITY, ...BODY])("reads %s somewhere in src/compiler", (field) => {
    // A property read: `args.slotType`, `rule?.enums`, `x[0].exact`. The receiver
    // before the dot excludes a spread (`...spread`).
    expect(new RegExp(String.raw`[\w$\])]\??\.${field}\b`).test(compiler)).toBe(true);
  });
});
