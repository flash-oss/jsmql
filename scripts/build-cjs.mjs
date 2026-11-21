#!/usr/bin/env node
import { build } from "esbuild";
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "dist/cjs");

mkdirSync(OUT_DIR, { recursive: true });

const pkgVersion = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

await build({
  entryPoints: {
    index: path.join(ROOT, "src/index.ts"),
    globals: path.join(ROOT, "src/globals.ts"),
    mongoose: path.join(ROOT, "src/mongoose.ts"),
    cli: path.join(ROOT, "src/cli.ts"),
  },
  outdir: OUT_DIR,
  bundle: true,
  external: ["bson"],
  format: "cjs",
  platform: "node",
  target: "node16",
  outExtension: { ".js": ".cjs" },
  define: { __JSMQL_VERSION__: JSON.stringify(pkgVersion) },
  sourcemap: true,
  logLevel: "info",
});

chmodSync(path.join(OUT_DIR, "cli.cjs"), 0o755);

for (const name of ["index", "globals", "mongoose"]) {
  const src = path.join(ROOT, "dist", `${name}.d.ts`);
  const dst = path.join(OUT_DIR, `${name}.d.cts`);
  copyFileSync(src, dst);
}

const mongooseCjs = path.join(OUT_DIR, "mongoose.cjs");
appendFileSync(
  mongooseCjs,
  "\n// jsmql: promote the ESM default export to module.exports. " +
    "`require(...)` then returns the plugin function directly.\n" +
    "if (module.exports && typeof module.exports.default === 'function') {\n" +
    "  const _fn = module.exports.default;\n" +
    "  _fn.default = _fn;\n" +
    "  module.exports = _fn;\n" +
    "}\n",
);

writeFileSync(path.join(OUT_DIR, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");
