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
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "dist/cjs");

mkdirSync(OUT_DIR, { recursive: true });

// The CLI bundle (`cli` entry → dist/cjs/cli.cjs) inlines the package version
// via `define` so the shipped binary reports it without reading package.json at
// runtime. src/cli.ts guards the identifier with `typeof` so the un-bundled
// `node src/cli.ts` run (no define) still works, returning a dev fallback.
const pkgVersion = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

await build({
  entryPoints: {
    index: path.join(ROOT, "src/index.ts"),
    ops: path.join(ROOT, "src/ops.ts"),
    mongoose: path.join(ROOT, "src/mongoose.ts"),
    cli: path.join(ROOT, "src/cli.ts"),
  },
  outdir: OUT_DIR,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node14",
  outExtension: { ".js": ".cjs" },
  define: { __JSMQL_VERSION__: JSON.stringify(pkgVersion) },
  sourcemap: true,
  logLevel: "info",
});

// The bin must be executable. npm sets the exec bit on `package.json#bin`
// targets at install time, but a locally-linked / freshly-built checkout
// (`node dist/cjs/cli.cjs`, `npm link`) relies on this. esbuild preserves the
// `#!/usr/bin/env node` shebang from the entry, so the file is runnable as-is.
chmodSync(path.join(OUT_DIR, "cli.cjs"), 0o755);

// Mirror the ESM .d.ts files as .d.cts so TypeScript's `nodenext` resolution
// finds types under the `require` condition. The declaration content is
// identical between ESM and CJS for this package — exports compile the same.
for (const name of ["index", "ops", "mongoose"]) {
  const src = path.join(ROOT, "dist", `${name}.d.ts`);
  const dst = path.join(OUT_DIR, `${name}.d.cts`);
  copyFileSync(src, dst);
}

// `require("@koresar/jsmql/mongoose")(mongoose)` expects the module itself to
// be a function. esbuild's CJS output for a default export normally lands at
// `module.exports.default`, so without this fixup the user would have to
// write `require(...).default(mongoose)`. Append a one-liner that promotes
// the default export to be the module value while keeping `.default` set so
// both call shapes — and ESM/TS `import jsmqlMongoose from "…/mongoose"` —
// remain interoperable. Index/ops have no default export, so they're left
// alone.
const mongooseCjs = path.join(OUT_DIR, "mongoose.cjs");
appendFileSync(
  mongooseCjs,
  "\n// jsmql: promote the ESM default export to module.exports so " +
    "`require(...)` returns the plugin function directly.\n" +
    "if (module.exports && typeof module.exports.default === 'function') {\n" +
    "  const _fn = module.exports.default;\n" +
    "  _fn.default = _fn;\n" +
    "  module.exports = _fn;\n" +
    "}\n",
);

// `package.json` with `"type": "commonjs"` inside `dist/cjs/` forces Node to
// treat the `.cjs` files (and any `.js` sourcemaps esbuild references) as
// CommonJS regardless of the parent package's `"type": "module"` setting.
writeFileSync(path.join(OUT_DIR, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");
