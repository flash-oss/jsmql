/**
 * Smoke tests run as part of the unit-test suite to lock down two invariants
 * that vitest's own test runtime cannot catch:
 *
 *   1. The `src/` tree stays in TypeScript's strippable subset, so the source
 *      runs as-is on Node 24+ via native type-stripping (no flag, no
 *      transpiler) — required for Deno/Bun parity. Vitest transforms TS
 *      through Vite's loader, which happily compiles `enum`, `namespace`,
 *      parameter properties, decorators, etc. — exactly the constructs the
 *      strippable subset bans. The only honest test is to invoke the real
 *      Node stripper.
 *
 *   2. The built `dist/index.js` actually loads as ESM and produces correct
 *      MQL. Vitest tests resolve `src/index.ts` directly, never the built
 *      output, so a broken `tsconfig` or `exports` field can ship despite a
 *      green `npm test`. Skipped when `dist/` is absent (the default during
 *      local development); active in CI / `npm run smoke:dist` after a build.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("smoke: strippable-TS invariant", () => {
  it("`node src/index.ts` runs without errors", () => {
    const result = spawnSync(process.execPath, ["src/index.ts"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });
});

describe("smoke: built dist", () => {
  const distPath = resolve(ROOT, "dist/index.js");
  const distUrl = "file://" + distPath;

  it.skipIf(!existsSync(distPath))(
    "dist/index.js loads via ESM import and produces correct MQL",
    () => {
      const script = `
        import { jsmql } from ${JSON.stringify(distUrl)};
        const out = jsmql("$.age > 18");
        if (JSON.stringify(out) !== '{"$gt":["$age",18]}') {
          throw new Error("jsmql(string) output mismatch: " + JSON.stringify(out));
        }
        if (!jsmql.validate("$.age > 18").valid) throw new Error("jsmql.validate() failed");
        const tag = jsmql\`$.x > \${5}\`;
        if (JSON.stringify(tag) !== '{"$gt":["$x",5]}') {
          throw new Error("jsmql template-tag mismatch: " + JSON.stringify(tag));
        }
        const fn = jsmql(($) => $.age > 18);
        if (JSON.stringify(fn) !== '{"$gt":["$age",18]}') {
          throw new Error("jsmql(function) output mismatch: " + JSON.stringify(fn));
        }
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    },
  );

  const opsJs = resolve(ROOT, "dist/ops.js");
  const opsDts = resolve(ROOT, "dist/ops.d.ts");

  it.skipIf(!existsSync(distPath))(
    "dist/ops.{js,d.ts} are emitted with stage and operator declarations",
    () => {
      // `@koresar/jsmql/ops` is a pure-types module — the runtime ops.js is essentially
      // empty (`export {};`), but it must exist so accidental non-type imports
      // resolve. The .d.ts is the artifact users actually consume.
      if (!existsSync(opsJs)) {
        throw new Error(
          `expected dist/ops.js to exist after build; rebuild with \`npm run build\``,
        );
      }
      if (!existsSync(opsDts)) {
        throw new Error(
          `expected dist/ops.d.ts to exist after build; rebuild with \`npm run build\``,
        );
      }
      const dts = readFileSync(opsDts, "utf8");
      // Spot-check that the declaration block is intact and includes both a
      // canonical stage and a canonical expression operator. If the generator
      // silently emitted an empty file (e.g. specs not vendored), this fails.
      expect(dts).toMatch(/declare global/);
      expect(dts).toMatch(/function \$match\(/);
      expect(dts).toMatch(/function \$dateAdd\(/);
    },
  );
});
