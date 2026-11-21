import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const tsFiles = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
};

function distProblem(bundles: readonly string[]): string | null {
  if (!existsSync(resolve(ROOT, "dist/index.js"))) return "absent";
  let newest = 0;
  for (const src of tsFiles(resolve(ROOT, "src"))) {
    const rel = relative(resolve(ROOT, "src"), src);
    const out = resolve(ROOT, "dist", rel.replace(/\.ts$/, ".js"));
    if (!existsSync(out)) return `dist/${relative(resolve(ROOT, "dist"), out)} is missing`;
    if (rel === "globals.ts") continue;
    const at = statSync(src).mtimeMs;
    newest = Math.max(newest, at);
    if (statSync(out).mtimeMs < at) return `src/${rel} is newer than its build`;
  }
  for (const b of bundles) {
    if (existsSync(b) && statSync(b).mtimeMs < newest) return `${relative(ROOT, b)} is older than src/`;
  }
  return null;
}

const DIST_PROBLEM = distProblem(
  ["dist/cjs/index.cjs", "dist/cjs/cli.cjs", "dist/cjs/mongoose.cjs"].map((p) => resolve(ROOT, p)),
);
if (DIST_PROBLEM !== null && DIST_PROBLEM !== "absent") {
  console.warn(
    `\n[smoke] dist/ is stale (${DIST_PROBLEM}) — the built-dist cases are SKIPPED.` +
      "\n[smoke] Run `npm run smoke:dist` to build and run them.\n",
  );
}
const DIST_FRESH = DIST_PROBLEM === null;

describe("smoke: strippable-TS invariant", () => {
  it("`node src/index.ts` runs without errors", () => {
    const result = spawnSync(process.execPath, ["src/index.ts"], { cwd: ROOT, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("`node src/mongoose.ts` runs without errors", () => {
    const result = spawnSync(process.execPath, ["src/mongoose.ts"], { cwd: ROOT, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("`node src/cli.ts` (the bin source) strips and runs without errors", () => {
    const result = spawnSync(process.execPath, ["src/cli.ts", "--help"], { cwd: ROOT, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });
});

describe("smoke: built dist", () => {
  const distPath = resolve(ROOT, "dist/index.js");
  const distUrl = "file://" + distPath;

  it.skipIf(!DIST_FRESH || !existsSync(distPath))(
    "dist/index.js loads through an ESM import and produces correct MQL",
    () => {
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
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    },
  );

  const cjsPath = resolve(ROOT, "dist/cjs/index.cjs");

  it.skipIf(!DIST_FRESH || !existsSync(cjsPath))(
    "dist/cjs/index.cjs loads through require() and produces correct MQL",
    () => {
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
    },
  );

  const cliCjs = resolve(ROOT, "dist/cjs/cli.cjs");

  it.skipIf(!DIST_FRESH || !existsSync(cliCjs))(
    "dist/cjs/cli.cjs runs as the jsmql bin (stdin → MQL) and reports its version",
    () => {
      const compiled = spawnSync(process.execPath, [cliCjs], { cwd: ROOT, input: "$.age > 18\n", encoding: "utf8" });
      expect(compiled.status, compiled.stderr).toBe(0);
      expect(compiled.stdout.trim()).toBe("{ age: { $gt: 18 } }");

      const version = spawnSync(process.execPath, [cliCjs, "--version"], { cwd: ROOT, encoding: "utf8" });
      expect(version.status, version.stderr).toBe(0);
      const pkgVersion = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version;
      expect(version.stdout.trim()).toBe(pkgVersion);

      expect(readFileSync(cliCjs, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
    },
  );

  const mongoosePkg = resolve(ROOT, "node_modules/mongoose/package.json");

  it.skipIf(!existsSync(mongoosePkg))(
    "mongoose module augmentation in src/mongoose.ts compiles against real mongoose types",
    () => {
      const result = spawnSync(
        resolve(ROOT, "node_modules/.bin/tsc"),
        ["--noEmit", "-p", resolve(ROOT, "test/types/tsconfig.json")],
        { cwd: ROOT, encoding: "utf8" },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
    60_000,
  );

  const tscBin = resolve(ROOT, "node_modules/.bin/tsc");

  it.skipIf(!existsSync(tscBin))(
    "@koresar/jsmql/globals value-method + stream completion type-checks (test/types/globals-completion.ts)",
    () => {
      const result = spawnSync(tscBin, ["--noEmit", "-p", resolve(ROOT, "test/types/tsconfig.globals.json")], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
    60_000,
  );

  const mongooseEsm = resolve(ROOT, "dist/mongoose.js");

  it.skipIf(!DIST_FRESH || !existsSync(mongooseEsm))(
    "dist/mongoose.js loads through an ESM import and patches Model.find",
    () => {
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
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    },
  );

  const mongooseCjs = resolve(ROOT, "dist/cjs/mongoose.cjs");

  it.skipIf(!DIST_FRESH || !existsSync(mongooseCjs))(
    "dist/cjs/mongoose.cjs is callable as require('…')(mongoose)",
    () => {
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
    },
  );

  const opsJs = resolve(ROOT, "dist/globals.js");
  const opsDts = resolve(ROOT, "dist/globals.d.ts");

  it.skipIf(!DIST_FRESH || !existsSync(distPath))(
    "dist/globals.{js,d.ts} are emitted with stage and operator declarations",
    () => {
      if (!existsSync(opsJs)) {
        throw new Error(`expected dist/globals.js to exist after build; rebuild with \`npm run build\``);
      }
      if (!existsSync(opsDts)) {
        throw new Error(`expected dist/globals.d.ts to exist after build; rebuild with \`npm run build\``);
      }
      const dts = readFileSync(opsDts, "utf8");
      expect(dts).toMatch(/declare global/);
      expect(dts).toMatch(/function \$match\(/);
      expect(dts).toMatch(/function \$dateAdd\(/);
    },
  );
});
