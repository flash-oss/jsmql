#!/usr/bin/env node
/**
 * Sync `playground.html` so it is self-sufficient — distributable as a single
 * file with no sibling assets except the CodeMirror CDN.
 *
 * Two regions inside `playground.html` are regenerated in place:
 *
 *   1. The jsmql library, bundled from `src/index.ts` via esbuild as an IIFE
 *      that exposes `globalThis.JSMQL`. Lives between the
 *      `<!-- jsmql-bundle:start … -->` / `<!-- jsmql-bundle:end -->` markers.
 *
 *   2. The realistic-examples manifest, extracted by walking every top-level
 *      `describe(title, () => { it(...) })` block in `test/realistic.test.ts`
 *      and pulling the first `jsmql(...)` call or `` jsmql`...` `` tagged
 *      template inside its first `it(...)`. Embedded as a JSON-script tag
 *      between the `<!-- jsmql-examples:start … -->` / `<!-- jsmql-examples:end -->`
 *      markers.
 *
 * Skips the `validate(): realistic error cases` block (queries don't compile)
 * and warns on `describe`s where no string-form query can be extracted.
 *
 * Hook-driven: a PostToolUse hook in `.claude/settings.json` runs this script
 * whenever Claude Code edits `test/realistic.test.ts`, so the embedded
 * examples stay current within a single commit. Also runs as `prebuild`, so
 * `npm run build` always produces a synced `playground.html`. Outside Claude
 * Code, run manually after editing src/ or the test file:
 *
 *   npm run sync:playground
 *
 * Idempotent: if the rewritten HTML is byte-identical to what's on disk, the
 * script exits 0 without writing or staging.
 */

import ts from "typescript";
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_FILE = path.join(ROOT, "test/realistic.test.ts");
const ENTRY = path.join(ROOT, "src/index.ts");
const HTML = path.join(ROOT, "playground.html");

const BUNDLE_START = "<!-- jsmql-bundle:start";
const BUNDLE_END = "<!-- jsmql-bundle:end -->";
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

function findFirstCallOrTag(node, names) {
  let found = null;
  function visit(n) {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      names.includes(n.expression.text)
    ) {
      found = n;
      return;
    }
    if (ts.isTaggedTemplateExpression(n) && ts.isIdentifier(n.tag) && names.includes(n.tag.text)) {
      found = n;
      return;
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

function extractQuery(itBody) {
  const call = findFirstCallOrTag(itBody, ["jsmql"]);
  if (!call) return null;

  if (ts.isTaggedTemplateExpression(call)) {
    return templateText(call.template, itBody);
  }

  const arg = call.arguments[0];
  if (!arg) return null;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) return templateText(arg, itBody);
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

function extractExamples() {
  const src = readFileSync(TEST_FILE, "utf8");
  const sf = ts.createSourceFile(TEST_FILE, src, ts.ScriptTarget.Latest, true);

  const examples = [];
  const usedSlugs = new Set();
  const skipped = [];

  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt)) continue;
    const expr = stmt.expression;
    if (!ts.isCallExpression(expr)) continue;
    if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "describe") continue;

    const titleArg = expr.arguments[0];
    if (!titleArg) continue;
    let title;
    if (ts.isStringLiteral(titleArg) || ts.isNoSubstitutionTemplateLiteral(titleArg)) {
      title = titleArg.text;
    } else continue;
    if (title.startsWith("validate():")) continue;

    const body = expr.arguments[1];
    if (!body || !ts.isArrowFunction(body) || !ts.isBlock(body.body)) {
      skipped.push({ title, why: "describe body is not a block arrow" });
      continue;
    }

    let firstIt = null;
    for (const s of body.body.statements) {
      if (
        ts.isExpressionStatement(s) &&
        ts.isCallExpression(s.expression) &&
        ts.isIdentifier(s.expression.expression) &&
        s.expression.expression.text === "it"
      ) {
        firstIt = s.expression;
        break;
      }
    }
    if (!firstIt) {
      skipped.push({ title, why: "no it() found" });
      continue;
    }
    const itBodyArg = firstIt.arguments[1];
    if (!itBodyArg || !ts.isArrowFunction(itBodyArg) || !ts.isBlock(itBodyArg.body)) {
      skipped.push({ title, why: "it() body is not a block arrow" });
      continue;
    }

    let query = extractQuery(itBodyArg.body);
    if (query == null) {
      skipped.push({ title, why: "couldn't extract a string-form query" });
      continue;
    }
    query = dedent(query);
    if (query.includes("</script")) {
      skipped.push({ title, why: "query contains </script — would break the playground" });
      continue;
    }

    const slug = makeSlug(title, usedSlugs);
    examples.push({ slug, title, query });
  }

  if (examples.length === 0) fail("no examples extracted from test/realistic.test.ts");
  return { examples, skipped };
}

async function bundleJsmql() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "iife",
    globalName: "JSMQL",
    target: "es2022",
    platform: "browser",
    minify: true,
    legalComments: "none",
    write: false,
  });
  const out = result.outputFiles?.[0];
  if (!out) fail("esbuild produced no output");
  return out.text.trimEnd();
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

function buildBundleRegion(bundleSrc) {
  // The IIFE bundle is dropped into a classic <script>; minified payload is
  // safe to embed verbatim (no `</script` substring — guarded by the check
  // below for paranoia).
  if (bundleSrc.includes("</script")) {
    fail("bundle contains a literal </script sequence — refusing to embed");
  }
  return [
    "    <!-- jsmql-bundle:start (generated by scripts/sync-playground.mjs — do not edit) -->",
    "    <script>",
    "      " + bundleSrc,
    "    </script>",
    "    <!-- jsmql-bundle:end -->",
    "",
  ].join("\n");
}

function buildExamplesRegion(examples) {
  // Embed as a JSON island so the browser parses it lazily and we don't have
  // to worry about escaping JS string contents. JSON.stringify produces no
  // </script sequence on its own, but a query could in principle contain one
  // — extractExamples() already drops those.
  const json = JSON.stringify(examples);
  return [
    "    <!-- jsmql-examples:start (generated by scripts/sync-playground.mjs — do not edit) -->",
    `    <script type="application/json" id="examples-data">${json}</script>`,
    "    <!-- jsmql-examples:end -->",
    "",
  ].join("\n");
}

const { examples, skipped } = extractExamples();
if (skipped.length) {
  for (const s of skipped) console.error(`  skipped: ${s.title} — ${s.why}`);
}

const bundleSrc = await bundleJsmql();

let html = readFileSync(HTML, "utf8");
html = replaceRegion(html, BUNDLE_START, BUNDLE_END, buildBundleRegion(bundleSrc));
html = replaceRegion(html, EXAMPLES_START, EXAMPLES_END, buildExamplesRegion(examples));

let existing = null;
try {
  existing = readFileSync(HTML, "utf8");
} catch {
  // First run — `existing` stays null.
}

if (existing === html) {
  console.log(`sync-playground: ${examples.length} examples already in sync (no change)`);
  process.exit(0);
}

writeFileSync(HTML, html);

const inGitRepo =
  spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: ROOT,
    stdio: "ignore",
  }).status === 0;
if (inGitRepo) {
  const add = spawnSync("git", ["add", path.relative(ROOT, HTML)], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (add.status !== 0) fail("git add playground.html failed");
}

console.log(
  `sync-playground: embedded ${examples.length} examples and ${(bundleSrc.length / 1024).toFixed(1)} kB of jsmql bundle → playground.html`,
);
