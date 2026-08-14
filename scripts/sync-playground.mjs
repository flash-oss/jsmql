#!/usr/bin/env node
/**
 * Produce the two committed playground artifacts from their sources:
 *
 *   1. `dist/jsmql.js` — the jsmql library bundled from `src/index.ts` via
 *      esbuild as a single unminified **pure ES module** (`export { jsmql, … }`,
 *      no harness/UI code). Git-tracked (the only checked-in file under dist/,
 *      see .gitignore) and published by GitHub Pages (see _config.yml). The
 *      playground imports it with `<script type="module"> import { jsmql } from
 *      "./dist/jsmql.js"`. Because it's an ES module import, the playground must
 *      be served over http(s) — it does not load over `file://`.
 *
 *   2. `playground.html` — generated from `playground_skeleton.html` (the
 *      hand-authored UI source: markup, CSS, behaviour) with one region
 *      injected: the realistic-examples manifest, extracted by enumerating
 *      every top-level `describe()` / first-`it()` pair in
 *      `test/realistic.test.ts` and reading the first `jsmql(...)` or
 *      `jsmql.expr(...)` call inside. Embedded as a JSON-script tag between the
 *      `<!-- jsmql-examples:start … -->` / `<!-- jsmql-examples:end -->` markers.
 *
 * Because this script reads the skeleton and only ever WRITES `playground.html`
 * (never back to the skeleton), changes to `src/` or `test/realistic.test.ts`
 * can never overwrite UI work — UI development edits the skeleton, not the
 * artifact.
 *
 * The example-discovery uses a Node loader hook (`sync-playground-loader.mjs`)
 * to map `import { describe, it } from "vitest"` onto a mock
 * (`sync-playground-vitest-shim.mjs`) that records every call into a tree.
 * We then dynamically `import()` the test file — `describe` bodies run (so
 * the full tree registers), but `it` bodies don't execute; their source is
 * captured via `Function.prototype.toString`. Compared to the prior pure-AST
 * approach this catches every test exactly as vitest sees it, including
 * dynamically generated `describe()` blocks if we ever add them, and stays
 * robust to new entry-point names (`jsmql.expr`, future `jsmql.update`, …).
 *
 * Skips the `validate(): realistic error cases` block (queries don't compile)
 * and warns on `describe`s where no query can be extracted.
 *
 * Hook-driven: a PostToolUse hook in `.claude/settings.json` runs this script
 * whenever Claude Code edits `test/realistic.test.ts` or
 * `playground_skeleton.html`, so both artifacts stay current within a single
 * commit. Also runs as `prebuild`, so `npm run build` always refreshes them.
 * `src/` edits do NOT trigger the hook — run manually after editing src/:
 *
 *   npm run sync:playground
 *
 * Idempotent per file: each artifact is (re)written and staged only when its
 * contents actually change; if neither changed the script exits 0 silently.
 */

import ts from "typescript";
import { build } from "esbuild";
import { register } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_FILE = path.join(ROOT, "test/realistic.test.ts");
const ENTRY = path.join(ROOT, "src/index.ts");
// The hand-authored UI source. Everything in `playground.html` except the two
// injected regions lives here, so editing src/ or realistic.test.ts (which only
// drive those two regions) can never clobber playground UI work. UI development
// edits the skeleton; `playground.html` is a pure build artifact.
const SKELETON = path.join(ROOT, "playground_skeleton.html");
const HTML = path.join(ROOT, "playground.html");
// The committed, git-tracked pure-ESM library bundle the playground imports
// (`<script type="module"> import { jsmql } from "./dist/jsmql.js"`). It's the
// only file under dist/ that's checked in (see .gitignore) and the only build
// output GitHub Pages publishes alongside playground.html (see _config.yml).
const BUNDLE = path.join(ROOT, "dist/jsmql.js");

// ── Vitest loader registration ────────────────────────────────────────────────
// Must happen BEFORE any `import()` that would resolve "vitest" — so before
// we import the test file below. The loader redirects "vitest" to our shim
// (`sync-playground-vitest-shim.mjs`), which records every describe/it call.
const LOADER_URL = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "sync-playground-loader.mjs"),
).href;
register(LOADER_URL);

const SHIM_URL = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "sync-playground-vitest-shim.mjs"),
).href;

// ── Stage detection (for the kind label) ──────────────────────────────────────
// Stage names from the registry — used by the AST-based kind detector to
// distinguish pipelines (any `$stage(...)` call or `{ $stage: ... }` key)
// from filters / expressions. Imported live so the heuristic never drifts
// from the language definition.
const { STAGES } = await import(pathToFileURL(path.join(ROOT, "src/stages.ts")).href);
const STAGE_NAMES = new Set(Object.keys(STAGES));

const EXAMPLES_START = "<!-- jsmql-examples:start";
const EXAMPLES_END = "<!-- jsmql-examples:end -->";

function fail(msg) {
  console.error(`sync-playground: ${msg}`);
  process.exit(1);
}

function makeSlug(title, used) {
  let s = title
    .replace(/^[^:]+:\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s) s = "example";
  let candidate = s;
  let n = 1;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${s}-${n}`;
  }
  used.add(candidate);
  return candidate;
}

// `deriveCategory` was a string-prefix parser ("Filters: …") that the
// metadata-driven shape replaces — categories are now declared explicitly
// via `describe(name, { features: [...] }, fn)`.

// ── Query / kind / usage extraction from an `it()` body source ────────────────

function findFirstJsmqlCall(node) {
  let found = null;
  function visit(n) {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isIdentifier(e) && e.text === "jsmql") {
        found = { kind: "jsmql", node: n };
        return;
      }
      if (
        ts.isPropertyAccessExpression(e) &&
        ts.isIdentifier(e.expression) &&
        e.expression.text === "jsmql" &&
        ts.isIdentifier(e.name) &&
        e.name.text === "expr"
      ) {
        found = { kind: "jsmql.expr", node: n };
        return;
      }
    }
    if (ts.isTaggedTemplateExpression(n)) {
      const t = n.tag;
      if (ts.isIdentifier(t) && t.text === "jsmql") {
        found = { kind: "jsmql", node: n };
        return;
      }
      if (
        ts.isPropertyAccessExpression(t) &&
        ts.isIdentifier(t.expression) &&
        t.expression.text === "jsmql" &&
        ts.isIdentifier(t.name) &&
        t.name.text === "expr"
      ) {
        found = { kind: "jsmql.expr", node: n };
        return;
      }
    }
    n.forEachChild(visit);
  }
  visit(node);
  return found;
}

function collectConstScalarsAndArrays(scope) {
  const map = new Map();
  function visit(n) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = n.initializer;
      const name = n.name.text;
      if (ts.isStringLiteral(init)) {
        map.set(name, JSON.stringify(init.text));
      } else if (ts.isNumericLiteral(init)) {
        map.set(name, init.text);
      } else if (ts.isArrayLiteralExpression(init) || ts.isObjectLiteralExpression(init)) {
        map.set(name, init.getText());
      } else if (
        init.kind === ts.SyntaxKind.TrueKeyword ||
        init.kind === ts.SyntaxKind.FalseKeyword ||
        init.kind === ts.SyntaxKind.NullKeyword
      ) {
        map.set(name, init.getText());
      }
    }
    n.forEachChild(visit);
  }
  visit(scope);
  return map;
}

function templateText(tpl, scope) {
  if (ts.isNoSubstitutionTemplateLiteral(tpl)) return tpl.text;
  const consts = collectConstScalarsAndArrays(scope);
  const parts = [tpl.head.text];
  for (const span of tpl.templateSpans) {
    const exprText = span.expression.getText();
    if (consts.has(exprText)) {
      parts.push(consts.get(exprText));
    } else {
      return null;
    }
    parts.push(span.literal.text);
  }
  return parts.join("");
}

function evalStringConcat(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = evalStringConcat(node.left);
    const r = evalStringConcat(node.right);
    if (l != null && r != null) return l + r;
  }
  return null;
}

function extractFromArrow(arr) {
  if (ts.isBlock(arr.body)) {
    const text = arr.body.getText();
    return text.replace(/^\{\s*/, "").replace(/\s*\}$/, "");
  }
  return arr.body.getText();
}

function extractQueryFromCall(found, scope) {
  const call = found.node;
  if (ts.isTaggedTemplateExpression(call)) {
    return templateText(call.template, scope);
  }
  const arg = call.arguments[0];
  if (!arg) return null;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) return templateText(arg, scope);
  if (ts.isArrowFunction(arg)) return extractFromArrow(arg);
  if (ts.isBinaryExpression(arg)) return evalStringConcat(arg);
  return null;
}

function dedent(text) {
  const trimmed = text.replace(/^\n/, "").replace(/\s+$/, "");
  if (trimmed === "") return "";
  const lines = trimmed.split("\n");
  const measure = (range) => {
    let min = Infinity;
    for (const l of range) {
      if (l.trim() === "") continue;
      const m = l.match(/^( *)/);
      if (m) min = Math.min(min, m[1].length);
    }
    return min;
  };
  const min = measure(lines);
  // Pipeline-style templates like `jsmql\`[\n  $match(...)\n]\`` start with
  // a lone `[` (or `{`, `(`) at column 0, which drags the global minimum
  // down to zero and prevents `dedent` from stripping the body's
  // test-file indent. When that happens, treat the first line as the
  // outer anchor and dedent the body lines against their own minimum so
  // the playground shows a canonical 2-space pipeline shape instead of
  // the raw 6-space test-file indent.
  if ((!Number.isFinite(min) || min === 0) && /^[\[({][ \t]*$/.test(lines[0])) {
    const body = lines.slice(1);
    const bodyMin = measure(body);
    if (Number.isFinite(bodyMin) && bodyMin > 0) {
      return [lines[0], ...body.map((l) => l.slice(bodyMin))].join("\n");
    }
  }
  if (!Number.isFinite(min) || min === 0) return lines.join("\n");
  return lines.map((l) => l.slice(min)).join("\n");
}

// ── Kind detection ────────────────────────────────────────────────────────────
// The playground groups examples by **three types** that match the Node.js
// MongoDB driver: Pipeline / Filter / Expression. An Update Filter (the
// `{ $set: …, $unset: … }` document `db.coll.updateOne(filter, update)`
// takes) is a flavour of Expression — produced by `jsmql.expr(...)` — and
// surfaces through the usage hint, not as its own kind. The rule:
//   - jsmql.expr(...) with no `;` and no stage call  → expression
//   - jsmql.expr(...) with `;` or a stage call       → pipeline
//   - jsmql(...) with `;` or a stage call            → pipeline
//   - jsmql(...) otherwise                           → filter

function stripStringsAndComments(src) {
  return src
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\$]|\\.|\$\{[^{}]*\})*`/g, "``");
}

function queryHasStageCall(query) {
  // Match `$<name>(` or `{ $<name>:` anywhere in the stripped query, then
  // verify <name> is a registered stage.
  const stripped = stripStringsAndComments(query);
  const calls = stripped.matchAll(/\$([a-zA-Z]+)\s*[(:]/g);
  for (const m of calls) {
    if (STAGE_NAMES.has("$" + m[1])) return true;
  }
  return false;
}

function queryHasSemicolon(query) {
  return /;/.test(stripStringsAndComments(query));
}

function detectKind(callKind, query) {
  const isPipelineShape = queryHasSemicolon(query) || queryHasStageCall(query);
  if (isPipelineShape) return "pipeline";
  if (callKind === "jsmql.expr") return "expression";
  return "filter";
}

// ── Usage hint extraction ─────────────────────────────────────────────────────
// Every test in test/realistic.test.ts carries a `// → db.<coll>.<method>(...)`
// comment above the `const result = …` line. Pull it out so the playground
// can render the natural call site alongside the source.

const USAGE_RE = /\/\/\s*→\s*(db\.[A-Za-z_][\w.]*\([\s\S]*?\))(?:\s*\n|\s*$)/;

function extractUsage(itSource) {
  const m = itSource.match(USAGE_RE);
  if (!m) return null;
  // Collapse all whitespace runs (the usage line can wrap in source); the
  // playground prefers the canonical single-line form.
  return m[1].replace(/\s+/g, " ").trim();
}

// ── Walk the recorded tree → manifest ─────────────────────────────────────────
//
// Manifest shape (new, metadata-driven):
//
//   [
//     {
//       slug:    "<describe-slug>",
//       title:   "<describe title>",
//       features: ["Filters", ...],            // from describe.meta.features
//       its: [
//         {
//           slug:  "<it-slug>",
//           title: "<it title>",
//           kind:  "filter" | "pipeline" | "expression",
//           call:  "jsmql" | "jsmql.expr",
//           query: "<source>",
//           usage: "db.<coll>.<method>(...)",
//         },
//         …                                    // every it() is its own example
//       ],
//     },
//     …
//   ]
//
// `it.meta.kind` / `it.meta.usage` take precedence; missing values fall back
// to the AST-based detector and the in-body `// → …` comment heuristic from
// the previous schema.

async function extractExamples() {
  // Importing the test file triggers the loader → vitest shim → tree
  // population. We discard the import result and read the shim's `tree`.
  await import(pathToFileURL(TEST_FILE).href);
  const { tree } = await import(SHIM_URL);

  const describes = [];
  const usedDescribeSlugs = new Set();
  const usedItSlugs = new Set();
  const skipped = [];

  for (const dnode of tree.children) {
    if (dnode.kind !== "describe") continue;
    // Skip the `jsmql.validate()` describe — its body intentionally throws,
    // so there's nothing meaningful to surface in the playground.
    if (dnode.title.startsWith("validate():") || dnode.title.startsWith("jsmql.validate():")) {
      continue;
    }

    const features = Array.isArray(dnode.meta?.features) ? dnode.meta.features : [];
    const its = [];

    for (const inode of dnode.children) {
      if (inode.kind !== "it" || !inode.source) continue;

      // Parse the captured `fn.toString()` so the existing query extractor
      // can walk the AST for the first jsmql / jsmql.expr call.
      const wrapped = `const __it = ${inode.source};`;
      const sf = ts.createSourceFile("_it.ts", wrapped, ts.ScriptTarget.Latest, true);
      const found = findFirstJsmqlCall(sf);
      if (!found) {
        skipped.push({ title: `${dnode.title} › ${inode.title}`, why: "no jsmql(...) or jsmql.expr(...) call found" });
        continue;
      }
      let query = extractQueryFromCall(found, sf);
      if (query == null) {
        skipped.push({ title: `${dnode.title} › ${inode.title}`, why: "couldn't extract a string-form query" });
        continue;
      }
      query = dedent(query);
      if (query.includes("</script")) {
        skipped.push({
          title: `${dnode.title} › ${inode.title}`,
          why: "query contains </script — would break the playground",
        });
        continue;
      }

      // Metadata wins, AST/heuristic fills in any gaps.
      const kind = inode.meta?.kind ?? detectKind(found.kind, query);
      const usage = inode.meta?.usage ?? extractUsage(inode.source);
      const itSlug = makeSlug(`${dnode.title} ${inode.title}`, usedItSlugs);
      its.push({ slug: itSlug, title: inode.title, kind, call: found.kind, query, usage });
    }

    if (its.length === 0) {
      skipped.push({ title: dnode.title, why: "no playground-eligible it()s under this describe" });
      continue;
    }

    describes.push({ slug: makeSlug(dnode.title, usedDescribeSlugs), title: dnode.title, features, its });
  }

  if (describes.length === 0) fail("no examples extracted from test/realistic.test.ts");
  return { describes, skipped };
}

async function bundleJsmql() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    minify: false,
    legalComments: "none",
    write: false,
  });
  const out = result.outputFiles?.[0];
  if (!out) fail("esbuild produced no output");
  return out.text.trimEnd() + "\n";
}

function replaceRegion(html, startMarker, endMarker, replacement) {
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) fail(`could not find marker ${startMarker} in playground.html`);
  const lineStart = html.lastIndexOf("\n", startIdx) + 1;
  const endIdx = html.indexOf(endMarker, startIdx);
  if (endIdx === -1) fail(`could not find marker ${endMarker} in playground.html`);
  const lineEnd = html.indexOf("\n", endIdx);
  if (lineEnd === -1) fail(`marker ${endMarker} must be followed by a newline`);
  return html.slice(0, lineStart) + replacement + html.slice(lineEnd + 1);
}

function buildExamplesRegion(describes) {
  const json = JSON.stringify(describes);
  // Identifies this exact example set. The playground stores it alongside a
  // saved session and drops the session when the two disagree, so a visitor
  // who has been here before still sees a newly shipped example instead of a
  // restored copy of the old one. Derived from the manifest, so it changes
  // when — and only when — an example's slug, title, query or metadata does.
  const stamp = createHash("sha256").update(json).digest("hex").slice(0, 12);
  return [
    "    <!-- jsmql-examples:start (generated by scripts/sync-playground.mjs — do not edit) -->",
    `    <script type="application/json" id="examples-data" data-stamp="${stamp}">${json}</script>`,
    "    <!-- jsmql-examples:end -->",
    "",
  ].join("\n");
}

const { describes, skipped } = await extractExamples();
if (skipped.length) {
  for (const s of skipped) console.error(`  skipped: ${s.title} — ${s.why}`);
}

const itCount = describes.reduce((sum, d) => sum + d.its.length, 0);

const inGitRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, stdio: "ignore" }).status === 0;

// Write `file` only when its contents change (avoids needless mtime churn and
// git-staging), then stage it. Returns true if it was (re)written.
function writeAndStage(file, contents) {
  let existing = null;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    // Not on disk yet (first run) — `existing` stays null so we write.
  }
  if (existing === contents) return false;
  writeFileSync(file, contents);
  if (inGitRepo) {
    const add = spawnSync("git", ["add", path.relative(ROOT, file)], { cwd: ROOT, stdio: "inherit" });
    if (add.status !== 0) fail(`git add ${path.relative(ROOT, file)} failed`);
  }
  return true;
}

// 1. The committed pure-ESM library bundle (dist/jsmql.js).
const bundleSrc = await bundleJsmql();
mkdirSync(path.dirname(BUNDLE), { recursive: true });
const bundleChanged = writeAndStage(BUNDLE, bundleSrc);

// 2. playground.html — skeleton with only the examples region injected.
const html = replaceRegion(
  readFileSync(SKELETON, "utf8"),
  EXAMPLES_START,
  EXAMPLES_END,
  buildExamplesRegion(describes),
);
const htmlChanged = writeAndStage(HTML, html);

if (!bundleChanged && !htmlChanged) {
  console.log(`sync-playground: ${describes.length} describes (${itCount} its) + bundle already in sync (no change)`);
  process.exit(0);
}

console.log(
  `sync-playground: wrote ${(bundleSrc.length / 1024).toFixed(1)} kB → dist/jsmql.js and ${describes.length} describes (${itCount} its) → playground.html`,
);
