import { describe, expect, it } from "vitest";
import { NAMES } from "../src/registry/names.ts";
import { PRODUCTIONS } from "../src/registry/productions.ts";
import type { Arity } from "../src/registry/vocabulary.ts";

const CELLS = ["expr", "filter", "stream", "statement", "group", "window", "updateDoc"] as const;

type Found = { where: string; args: Arity };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function rulesIn(cell: unknown, where: string, out: Found[]): void {
  if (!isObj(cell)) return;
  if (isObj(cell.args) && typeof (cell.args as { sig?: unknown }).sig === "string") {
    out.push({ where, args: cell.args as Arity });
  }
  for (const key of ["perFamily", "byArgs"] as const) {
    const branches = cell[key];
    if (!isObj(branches)) continue;
    for (const [name, branch] of Object.entries(branches)) rulesIn(branch, `${where}/${key}.${name}`, out);
  }
}

function admitted(args: Arity): (number | "rest")[] {
  if (args.none === true) return [];
  const upTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
  if (args.exact !== undefined) return upTo(args.exact);
  if (args.allowed !== undefined) return upTo(Math.max(0, ...args.allowed));
  if (args.atLeast !== undefined) return [...upTo(args.atLeast), "rest"];
  return ["rest"];
}

function untyped(): string[] {
  const missing: string[] = [];
  const rows: [string, Record<string, unknown>][] = [
    ...(Object.entries(NAMES) as [string, Record<string, unknown>][]).filter(([n]) => !n.startsWith("$")),
    ...(Object.entries(PRODUCTIONS) as [string, Record<string, unknown>][]),
  ];
  for (const [name, row] of rows) {
    for (const cellName of CELLS) {
      const found: Found[] = [];
      rulesIn(row[cellName], `${name} ${cellName}`, found);
      for (const { where, args } of found) {
        for (const slot of admitted(args)) {
          const stated = slot === "rest" ? args.rest : (args.slotType?.[slot] ?? args.rest);
          if (stated === undefined) missing.push(`${where} slot ${slot === "rest" ? "rest" : slot}`);
        }
      }
    }
  }
  return missing;
}

describe("registry — every admitted slot states its kind (HR7)", () => {
  it("lists no slot without a kind", () => {
    const missing = untyped();
    expect(missing, `${missing.length} slots have no kind:\n${missing.join("\n")}`).toEqual([]);
  });

  it("covers every production that a rule states", () => {
    const states = Object.entries(PRODUCTIONS).filter(([, row]) =>
      CELLS.some((c) => {
        const found: Found[] = [];
        rulesIn((row as Record<string, unknown>)[c], "", found);
        return found.length > 0;
      }),
    );
    expect(states.length).toBeGreaterThan(20);
  });
});
