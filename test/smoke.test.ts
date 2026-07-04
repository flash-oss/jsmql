/**
 * Smoke tests run as part of the unit-test suite to lock down invariants
 * that vitest's own test runtime cannot catch:
 *
 *   1. The `src/` tree stays in TypeScript's strippable subset, so the source
 *      runs as-is on Node 22.18+ / 24.3+ via native type-stripping (no flag,
 *      no transpiler — type stripping was unflagged in Node 22.18.0 LTS and
 *      in 24.3.0, and marked stable in 25.2.0) — required for Deno/Bun
 *      parity. Vitest transforms TS through Vite's loader, which happily
 *      compiles `enum`, `namespace`, parameter properties, decorators, etc.
 *      — exactly the constructs the strippable subset bans. The only honest
 *      test is to invoke the real Node stripper.
 *
 *   2. The built `dist/index.js` actually loads as ESM and produces correct
 *      MQL. Vitest tests resolve `src/index.ts` directly, never the built
 *      output, so a broken `tsconfig` or `exports` field can ship despite a
 *      green `npm test`. Skipped when `dist/` is absent (the default during
 *      local development); active in CI / `npm run smoke:dist` after a build.
 *
 *   3. The built `dist/cjs/index.cjs` loads via `require()` and produces the
 *      same MQL across all three call shapes. This is the `require` half of
 *      the dual ESM/CJS package — Node 14+ CJS consumers depend on it, and
 *      the bundling step in `scripts/build-cjs.mjs` is easy to break without
 *      tsc noticing. Same skip rule as the ESM case.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("smoke: strippable-TS invariant", () => {
  it("`node src/index.ts` runs without errors", () => {
    const result = spawnSync(process.execPath, ["src/index.ts"], { cwd: ROOT, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("`node src/mongoose.ts` runs without errors", () => {
    // The mongoose plugin is a separate published entry point, so it gets
    // the same strippable-TS guarantee as src/index.ts. The `import type {}
    // from "mongoose"` anchor and the `declare module "mongoose"` block
    // below it are both type-only constructs that the Node stripper drops
    // — this case proves it.
    const result = spawnSync(process.execPath, ["src/mongoose.ts"], { cwd: ROOT, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("`node src/cli.ts` (the bin source) strips and runs without errors", () => {
    // The CLI is bundled to dist/cjs/cli.cjs for shipping, but the source must
    // also satisfy the strippable-TS invariant so contributors can run it
    // directly. `--help` exercises the full module load + arg parse and exits 0.
    const result = spawnSync(process.execPath, ["src/cli.ts", "--help"], { cwd: ROOT, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });
});

describe("smoke: built dist", () => {
  const distPath = resolve(ROOT, "dist/index.js");
  const distUrl = "file://" + distPath;

  it.skipIf(!existsSync(distPath))("dist/index.js loads via ESM import and produces correct MQL", () => {
    const script = `
        import { jsmql } from ${JSON.stringify(distUrl)};
        const out = jsmql("$.age > 18");
        if (JSON.stringify(out) !== '{"age":{"$gt":18}}') {
          throw new Error("jsmql(string) output mismatch: " + JSON.stringify(out));
        }
        if (!jsmql.validate("$.age > 18").valid) throw new Error("jsmql.validate() failed");
        const tag = jsmql\`$.x > \${5}\`;
        if (JSON.stringify(tag) !== '{"x":{"$gt":5}}') {
          throw new Error("jsmql template-tag mismatch: " + JSON.stringify(tag));
        }
        const fn = jsmql(({ $ }) => $.age > 18);
        if (JSON.stringify(fn) !== '{"age":{"$gt":18}}') {
          throw new Error("jsmql(function) output mismatch: " + JSON.stringify(fn));
        }
      `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  const cjsPath = resolve(ROOT, "dist/cjs/index.cjs");

  it.skipIf(!existsSync(cjsPath))("dist/cjs/index.cjs loads via require() and produces correct MQL", () => {
    // Mirrors the ESM case above but exercises the CommonJS bundle that
    // ships under the `require` condition of `package.json#exports`.
    // Run on `node14` target — keeping the script syntax-conservative
    // (no template literals besides the wrapping one, no optional
    // chaining) so the same script could be executed on the lowest
    // engine we support if needed.
    const script = `
        const { jsmql } = require(${JSON.stringify(cjsPath)});
        const out = jsmql("$.age > 18");
        if (JSON.stringify(out) !== '{"age":{"$gt":18}}') {
          throw new Error("jsmql(string) output mismatch: " + JSON.stringify(out));
        }
        if (!jsmql.validate("$.age > 18").valid) throw new Error("jsmql.validate() failed");
        const tag = jsmql\`$.x > \${5}\`;
        if (JSON.stringify(tag) !== '{"x":{"$gt":5}}') {
          throw new Error("jsmql template-tag mismatch: " + JSON.stringify(tag));
        }
        const fn = jsmql(({ $ }) => $.age > 18);
        if (JSON.stringify(fn) !== '{"age":{"$gt":18}}') {
          throw new Error("jsmql(function) output mismatch: " + JSON.stringify(fn));
        }
      `;
    const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", script], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  const cliCjs = resolve(ROOT, "dist/cjs/cli.cjs");

  it.skipIf(!existsSync(cliCjs))("dist/cjs/cli.cjs runs as the jsmql bin (stdin → MQL) and reports its version", () => {
    // Exercises the built executable end-to-end: the esbuild bundle, the
    // preserved shebang, and the version `define`. spawnSync drives `node
    // dist/cjs/cli.cjs` (rather than the bare path) so the test is independent
    // of the file's exec bit.
    const compiled = spawnSync(process.execPath, [cliCjs], { cwd: ROOT, input: "$.age > 18\n", encoding: "utf8" });
    expect(compiled.status, compiled.stderr).toBe(0);
    expect(JSON.stringify(JSON.parse(compiled.stdout))).toBe('{"age":{"$gt":18}}');

    const version = spawnSync(process.execPath, [cliCjs, "--version"], { cwd: ROOT, encoding: "utf8" });
    expect(version.status, version.stderr).toBe(0);
    const pkgVersion = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version;
    expect(version.stdout.trim()).toBe(pkgVersion);

    // The first bytes must be the shebang so the file is directly runnable.
    expect(readFileSync(cliCjs, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });

  const mongoosePkg = resolve(ROOT, "node_modules/mongoose/package.json");

  it.skipIf(!existsSync(mongoosePkg))(
    "mongoose module augmentation in src/mongoose.ts compiles against real mongoose types",
    () => {
      // Type-only validation: ensure the `declare module "mongoose"` block at
      // the bottom of src/mongoose.ts merges with mongoose's real `Model<...>`
      // interface and accepts a JSMQL string / arrow at every patched slot.
      // mongoose is pinned at `"*"` in devDependencies, so every fresh
      // `npm install` pulls the latest published mongoose and this case
      // catches augmentation drift against new mongoose generics before
      // users hit it. The skip guard stays for degraded environments where
      // node_modules/mongoose isn't there for some reason.
      const result = spawnSync(
        resolve(ROOT, "node_modules/.bin/tsc"),
        ["--noEmit", "-p", resolve(ROOT, "test/types/tsconfig.json")],
        { cwd: ROOT, encoding: "utf8" },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  );

  const mongooseEsm = resolve(ROOT, "dist/mongoose.js");

  it.skipIf(!existsSync(mongooseEsm))("dist/mongoose.js loads via ESM import and patches Model.find", () => {
    const script = `
        import jsmqlMongoose from ${JSON.stringify("file://" + mongooseEsm)};
        let captured;
        class Model { static find(filter) { captured = filter; } }
        jsmqlMongoose({ Model });
        Model.find("$.age > 18");
        if (JSON.stringify(captured) !== '{"age":{"$gt":18}}') {
          throw new Error("mongoose patch (ESM) output mismatch: " + JSON.stringify(captured));
        }
      `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  const mongooseCjs = resolve(ROOT, "dist/cjs/mongoose.cjs");

  it.skipIf(!existsSync(mongooseCjs))("dist/cjs/mongoose.cjs is callable as require('…')(mongoose)", () => {
    // The `require(...)` form is the primary documented call shape, so the
    // CJS bundle must promote esbuild's default-export shape to
    // `module.exports = fn`. Without the post-build fixup in
    // `scripts/build-cjs.mjs`, this test fails with "module.exports is not a
    // function".
    const script = `
        const jsmqlMongoose = require(${JSON.stringify(mongooseCjs)});
        if (typeof jsmqlMongoose !== "function") {
          throw new Error("expected require(mongoose.cjs) to return a function, got " + typeof jsmqlMongoose);
        }
        let captured;
        function Model() {}
        Model.find = function(filter) { captured = filter; };
        jsmqlMongoose({ Model });
        Model.find("$.age > 18");
        if (JSON.stringify(captured) !== '{"age":{"$gt":18}}') {
          throw new Error("mongoose patch (CJS) output mismatch: " + JSON.stringify(captured));
        }
      `;
    const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", script], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  const opsJs = resolve(ROOT, "dist/ops.js");
  const opsDts = resolve(ROOT, "dist/ops.d.ts");

  it.skipIf(!existsSync(distPath))("dist/ops.{js,d.ts} are emitted with stage and operator declarations", () => {
    // `@koresar/jsmql/ops` is a pure-types module — the runtime ops.js is essentially
    // empty (`export {};`), but it must exist so accidental non-type imports
    // resolve. The .d.ts is the artifact users actually consume.
    if (!existsSync(opsJs)) {
      throw new Error(`expected dist/ops.js to exist after build; rebuild with \`npm run build\``);
    }
    if (!existsSync(opsDts)) {
      throw new Error(`expected dist/ops.d.ts to exist after build; rebuild with \`npm run build\``);
    }
    const dts = readFileSync(opsDts, "utf8");
    // Spot-check that the declaration block is intact and includes both a
    // canonical stage and a canonical expression operator. If the generator
    // silently emitted an empty file (e.g. specs not vendored), this fails.
    expect(dts).toMatch(/declare global/);
    expect(dts).toMatch(/function \$match\(/);
    expect(dts).toMatch(/function \$dateAdd\(/);
  });
});
