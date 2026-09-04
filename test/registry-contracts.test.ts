// The registry's type contracts, run as a test. The fixture holds every rule the
// vocabulary states as a type, twice: a value that must compile and one under
// `@ts-expect-error` that must not — so a rule that stops firing fails here.
// See test/types/registry-contracts.ts.

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
