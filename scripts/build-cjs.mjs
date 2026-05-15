#!/usr/bin/env node
/**
 * Build a CommonJS bundle of the public entry points so the package works on
 * `require()`-only consumers (Node 14+ CJS apps, older bundlers, mixed
 * codebases). The ESM build under `dist/*.js` remains the primary artifact;
 * this script writes a sibling `dist/cjs/*.cjs` for the `require` condition
 * in `package.json#exports`.
 *
 * Approach: esbuild bundles each entry into a single `.cjs` file targeting
 * `node14`. Bundling — rather than per-file emit — sidesteps the dual-package
 * hazard (two copies of the parser/codegen on disk, distinct singleton state)
 * and keeps the CJS surface a self-contained drop-in.
 *
 * Runs as part of `npm run build` after `tsc` has populated `dist/*.js` and
 * the `.d.ts` declarations. The `.d.cts` siblings under `dist/cjs/` are
 * copied from the ESM declarations so `moduleResolution: nodenext` consumers
 * find a types entry for the `require` condition.
 */
import { build } from "esbuild";
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "dist/cjs");

mkdirSync(OUT_DIR, { recursive: true });

await build({
  entryPoints: {
    index: path.join(ROOT, "src/index.ts"),
    ops: path.join(ROOT, "src/ops.ts"),
  },
  outdir: OUT_DIR,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node14",
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
  logLevel: "info",
});

// Mirror the ESM .d.ts files as .d.cts so TypeScript's `nodenext` resolution
// finds types under the `require` condition. The declaration content is
// identical between ESM and CJS for this package — exports compile the same.
for (const name of ["index", "ops"]) {
  const src = path.join(ROOT, "dist", `${name}.d.ts`);
  const dst = path.join(OUT_DIR, `${name}.d.cts`);
  copyFileSync(src, dst);
}

// `package.json` with `"type": "commonjs"` inside `dist/cjs/` forces Node to
// treat the `.cjs` files (and any `.js` sourcemaps esbuild references) as
// CommonJS regardless of the parent package's `"type": "module"` setting.
writeFileSync(
  path.join(OUT_DIR, "package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
);
