// Every constant fold implements a row, and every row it implements is a call.
//
// fold-methods.ts and fold-dates.ts are switches over method names, one table per
// receiver family. A `case "foo":` for a name the registry does not list on that
// family would ADD a method to the language — `const n = "abc".foo(); $.x === n`
// would fold where the compiler must refuse — and a `case` for a name whose row
// says `call: false` folds a CALL of something that is only ever READ — which is
// how `"abc".length()` would fold to 3. Nothing else links the two files, so this
// reads the case labels out of the source and holds them against the rows.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAMES } from "../src/registry/names.ts";

type Row = { kind?: string; call?: boolean; on?: string | readonly string[] };
const ROWS = NAMES as Record<string, Row | undefined>;

const source = (file: string): string =>
  readFileSync(new URL(`../src/compiler/passes/${file}`, import.meta.url), "utf8");

/** The `case "name":` labels inside one named function of a source file. */
function casesIn(src: string, fn: string): string[] {
  const start = src.indexOf(`function ${fn}(`);
  expect(start, `function ${fn} exists`).toBeGreaterThanOrEqual(0);
  // The function ends at the next top-level declaration.
  const rest = src.slice(start + 1);
  const end = rest.search(/\n(?:export )?(?:function|const) /);
  const body = end === -1 ? rest : rest.slice(0, end);
  return [...body.matchAll(/case "([A-Za-z_]+)":/g)].map((m) => m[1]);
}

const familiesOf = (row: Row): readonly string[] =>
  row.on === undefined || row.on === "any" ? ["any"] : Array.isArray(row.on) ? row.on : [row.on as string];

/** Each fold table, the family it folds on, and the file it lives in. */
const TABLES: readonly [file: string, fn: string, family: string][] = [
  ["fold-methods.ts", "stringMethod", "string"],
  ["fold-methods.ts", "lodashString", "string"],
  ["fold-methods.ts", "numberMethod", "number"],
  ["fold-methods.ts", "objectMethod", "object"],
  ["fold-methods.ts", "arrayMethod", "array"],
  ["fold-dates.ts", "foldDateMethod", "date"],
];

describe("compiler/passes/fold — every case label is a callable row on that family", () => {
  for (const [file, fn, family] of TABLES) {
    it(`${fn} folds only names the registry lists as calls on ${family}`, () => {
      const wrong: string[] = [];
      for (const name of casesIn(source(file), fn)) {
        const row = ROWS[name];
        if (row === undefined) {
          wrong.push(`${name}: no row`);
          continue;
        }
        if (row.call === false) wrong.push(`${name}: the row says it is READ, not CALLED`);
        const fams = familiesOf(row);
        if (!fams.includes("any") && !fams.includes(family))
          wrong.push(`${name}: not on ${family} (${fams.join("/")})`);
      }
      expect(wrong).toEqual([]);
    });
  }

  it("folds a namespace call only on a namespace the registry provides", () => {
    // `Math.max`, `Object.keys` — the switch is keyed by namespace then name.
    const src = source("fold-methods.ts");
    const namespaces = [...casesIn(src, "foldNamespaceCall")];
    const stray = namespaces.filter((n) => {
      const row = ROWS[n];
      // A namespace is a root/global row that `provides`; a method under it is a
      // name row whose `on` lists that namespace.
      const isNamespace = row !== undefined && (row.kind === "root" || row.kind === "global");
      const isMethod = row !== undefined && row.kind === "name" && row.call !== false;
      return !isNamespace && !isMethod;
    });
    expect(stray).toEqual([]);
  });
});
