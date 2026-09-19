#!/usr/bin/env node
/**
 * Build a CommonJS bundle of the public entry points. This lets the package work on
 * `require()`-only consumers (Node 14 and later CJS applications, older bundlers,
 * mixed codebases). The ESM build in `dist/*.js` is the primary artefact.
 * This script writes a sibling `dist/cjs/*.cjs` for the `require` condition
 * in `package.json#exports`.
 *
 * Method: esbuild bundles each entry into a single `.cjs` file for `node16`.
 * Bundling (rather than per-file emit) sidesteps the dual-package hazard: two copies
 * of the parser and codegen on disk with distinct singleton state. It keeps the CJS
 * surface a self-contained drop-in.
 *
 * This script runs as part of `npm run build` after `tsc` populates `dist/*.js` and
 * the `.d.ts` declarations. The `.d.cts` files under `dist/cjs/` are copies
 * of the ESM declarations. Consumers with `moduleResolution: nodenext` find a types
 * entry for the `require` condition.
 */
import { build } from "esbuild";
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "dist/cjs");

mkdirSync(OUT_DIR, { recursive: true });

// The CLI bundle (`cli` entry → dist/cjs/cli.cjs) inlines the package version
// through `define`, so the shipped binary reports it and never reads package.json at runtime.
// src/cli.ts guards the identifier with `typeof` so the unbundled `node src/cli.ts` run
// (no define) still works, returning a development fallback.
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
  // `bson` is a PEER dependency and must stay one at runtime. If you inline it here,
  // the package ships its own copy. Two copies coexist with the application's copy, and every
  // value jsmql emits fails the application's `instanceof` and BSON version checks.
  // This is the exact defect that the peer dependency exists to prevent.
  external: ["bson"],
  format: "cjs",
  platform: "node",
  target: "node16",
  outExtension: { ".js": ".cjs" },
  define: { __JSMQL_VERSION__: JSON.stringify(pkgVersion) },
  sourcemap: true,
  logLevel: "info",
});

// The bin must be executable. npm sets the exec bit on `package.json#bin` targets
// at install time. A locally linked or freshly built checkout (`node dist/cjs/cli.cjs`,
// `npm link`) relies on this. esbuild preserves the `#!/usr/bin/env node` shebang from
// the entry, so the file is runnable as is.
chmodSync(path.join(OUT_DIR, "cli.cjs"), 0o755);

// Copy the ESM .d.ts files as .d.cts files. TypeScript's `nodenext` resolution
// finds types under the `require` condition this way. The declaration content is
// identical between ESM and CJS for this package: exports compile the same.
for (const name of ["index", "globals", "mongoose"]) {
  const src = path.join(ROOT, "dist", `${name}.d.ts`);
  const dst = path.join(OUT_DIR, `${name}.d.cts`);
  copyFileSync(src, dst);
}

// `require("@koresar/jsmql/mongoose")(mongoose)` expects the module itself to be
// a function. esbuild's CJS output for a default export normally lands at `module.exports.default`.
// Without this fixup, users would have to write `require(...).default(mongoose)`. This code
// appends a one-liner that promotes the default export to be the module value while keeping
// `.default` set. Both call shapes stay interoperable: ESM/TypeScript `import jsmqlMongoose from "…/mongoose"`
// and CJS `require(...)`. Index and globals have no default export, so you leave them alone.
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

// A `package.json` with `"type": "commonjs"` inside `dist/cjs/` forces Node to treat
// the `.cjs` files (and any `.js` sourcemaps esbuild references) as CommonJS. This is
// regardless of the parent package's `"type": "module"` setting.
writeFileSync(path.join(OUT_DIR, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");
