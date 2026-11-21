#!/usr/bin/env node

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
const SKELETON = path.join(ROOT, "playground_skeleton.html");
const HTML = path.join(ROOT, "playground.html");
const BUNDLE = path.join(ROOT, "dist/jsmql.js");

const LOADER_URL = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "sync-playground-loader.mjs"),
).href;
register(LOADER_URL);

const SHIM_URL = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "sync-playground-vitest-shim.mjs"),
).href;

const { everyStageName } = await import(pathToFileURL(path.join(ROOT, "src/compiler/rows.ts")).href);
const STAGE_NAMES = new Set(everyStageName());

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

function stripStringsAndComments(src) {
  return src
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\$]|\\.|\$\{[^{}]*\})*`/g, "``");
}

function queryHasStageCall(query) {
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

const USAGE_RE = /\/\/\s*→\s*(db\.[A-Za-z_][\w.]*\([\s\S]*?\))(?:\s*\n|\s*$)/;

function extractUsage(itSource) {
  const m = itSource.match(USAGE_RE);
  if (!m) return null;
  return m[1].replace(/\s+/g, " ").trim();
}

async function extractExamples() {
  await import(pathToFileURL(TEST_FILE).href);
  const { tree } = await import(SHIM_URL);

  const describes = [];
  const usedDescribeSlugs = new Set();
  const usedItSlugs = new Set();
  const skipped = [];

  for (const dnode of tree.children) {
    if (dnode.kind !== "describe") continue;
    if (dnode.title.startsWith("validate():") || dnode.title.startsWith("jsmql.validate():")) {
      continue;
    }

    const features = Array.isArray(dnode.meta?.features) ? dnode.meta.features : [];
    const its = [];

    for (const inode of dnode.children) {
      if (inode.kind !== "it" || !inode.source) continue;

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

function writeAndStage(file, contents) {
  let existing = null;
  try {
    existing = readFileSync(file, "utf8");
  } catch {}
  if (existing === contents) return false;
  writeFileSync(file, contents);
  if (inGitRepo) {
    const add = spawnSync("git", ["add", path.relative(ROOT, file)], { cwd: ROOT, stdio: "inherit" });
    if (add.status !== 0) fail(`git add ${path.relative(ROOT, file)} failed`);
  }
  return true;
}

const bundleSrc = await bundleJsmql();
mkdirSync(path.dirname(BUNDLE), { recursive: true });
const bundleChanged = writeAndStage(BUNDLE, bundleSrc);

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
