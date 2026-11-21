import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = resolve(ROOT, "node_modules/.bin/tsc");

describe("registry — every type contract holds, and each was made to fail", () => {
  it.skipIf(!existsSync(tsc))(
    "test/types/registry-contracts.ts type-checks with every @ts-expect-error consumed",
    () => {
      const r = spawnSync(tsc, ["--noEmit", "-p", resolve(ROOT, "test/types/tsconfig.registry.json")], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    },
  );
});
