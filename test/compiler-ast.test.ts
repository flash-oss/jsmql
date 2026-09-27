// Phase 2 of src/compiler/ — the tree src/compiler/parse/ builds.
//
// The AST lives in the registry and imports nothing, so `NodeName` is DERIVED
// from it. These tests pin its two properties: it is name-blind, and it covers
// exactly what the productions claim to build.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTIONS } from "../src/registry/productions.ts";
import { ASSIGN_OPS, BINARY_OPS, UNARY_OPS } from "../src/registry/ast.ts";
import { EVERY_NODE } from "./support/ast-nodes.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every node name a production says it builds. */
function claimed(): Set<string> {
  const out = new Set<string>();
  for (const row of Object.values(PRODUCTIONS)) {
    const b = row.becomes as unknown;
    if (typeof b === "string") out.add(b);
    else if (Array.isArray(b)) for (const n of b) out.add(n as string);
  }
  return out;
}

describe("registry/ast — the tree and the rules are consistent", () => {
  it("lists every node of ast.ts in EVERY_NODE, and no other (tsc checks test/support/ast-nodes.ts)", () => {
    const tsc = resolve(ROOT, "node_modules/.bin/tsc");
    const r = spawnSync(tsc, ["--noEmit", "-p", resolve(ROOT, "test/types/tsconfig.ast.json")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 60_000);

  it("every node a production claims to build exists in the tree", () => {
    const missing = [...claimed()].filter((n) => !(n in EVERY_NODE));
    expect(missing).toEqual([]);
  });

  it("some production builds every node in the tree", () => {
    const built = claimed();
    // `ObjectIdLiteral` is reached two ways, and both are productions. Everything
    // else must be reachable, or the tree carries a shape that no syntax produces.
    const orphans = Object.keys(EVERY_NODE).filter((n) => !built.has(n));
    expect(orphans).toEqual([]);
  });
});

describe("registry/ast — name-blind", () => {
  it("holds no node type named after a particular JavaScript name", () => {
    const nameAware = Object.keys(EVERY_NODE).filter(
      (n) =>
        /^(Math|Object|Number|Array|Date|Set|TypeCast)/.test(n) &&
        n !== "ObjectLiteral" &&
        n !== "ObjectIdLiteral" &&
        n !== "NumberLiteral" &&
        n !== "ArrayLiteral",
    );
    expect(nameAware).toEqual([]);
  });

  it("spells operators exactly as the source spells them", () => {
    // Each spelling must be a JavaScript operator: JavaScript itself compiles it.
    // An MQL name such as `$and` is a syntax error there. The compound and increment
    // forms survive parsing because desugar reduces them.
    const notJs: string[] = [];
    const compiles = (body: string): boolean => {
      try {
        new Function("a", "b", body);
        return true;
      } catch {
        return false;
      }
    };
    for (const op of BINARY_OPS) if (!compiles(`return a ${op} b;`)) notJs.push(op);
    for (const op of UNARY_OPS) if (!compiles(`return ${op} a;`)) notJs.push(op);
    for (const op of ASSIGN_OPS)
      if (!compiles(op.length === 2 && op[0] === op[1] ? `a${op};` : `a ${op} b;`)) notJs.push(op);
    expect(notJs).toEqual([]);
    expect(BINARY_OPS.length * UNARY_OPS.length * ASSIGN_OPS.length).toBeGreaterThan(0);
  });
});
