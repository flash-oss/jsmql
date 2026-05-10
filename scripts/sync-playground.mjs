#!/usr/bin/env node
/**
 * Sync `playground.html` examples from `test/realistic.test.ts`.
 *
 * Walks every top-level `describe(title, () => { it(...) })` block, extracts
 * the first `jsmql(...)` call or `` mql`...` `` tagged template inside its
 * first `it(...)`, and rewrites the delimited regions in `playground.html`:
 *
 *   <!-- BEGIN GENERATED OPTIONS  --> … <!-- END GENERATED OPTIONS  -->
 *   <!-- BEGIN GENERATED EXAMPLES --> … <!-- END GENERATED EXAMPLES -->
 *
 * Skips the `validate(): realistic error cases` block (queries don't compile)
 * and warns on `describe`s where no string-form query can be extracted.
 *
 * Hook-driven: a PostToolUse hook in `.claude/settings.json` runs this script
 * whenever Claude Code edits `test/realistic.test.ts`, so the playground
 * update is already staged when the next commit happens. Run manually as
 *
 *   npm run sync:playground
 *
 * after editing the test file outside Claude Code.
 *
 * Idempotent: if the rewritten file is byte-identical to what's on disk, the
 * script exits 0 without writing or staging.
 */

import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_FILE = path.join(ROOT, "test/realistic.test.ts");
const PLAYGROUND = path.join(ROOT, "playground.html");

const OPT_BEGIN = "<!-- BEGIN GENERATED OPTIONS -->";
const OPT_END = "<!-- END GENERATED OPTIONS -->";
const EX_BEGIN = "<!-- BEGIN GENERATED EXAMPLES -->";
const EX_END = "<!-- END GENERATED EXAMPLES -->";

function fail(msg) {
  console.error(`sync-playground: ${msg}`);
  process.exit(1);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  const call = findFirstCallOrTag(itBody, ["jsmql", "mql"]);
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
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === "") continue;
    const m = l.match(/^( *)/);
    if (m) min = Math.min(min, m[1].length);
  }
  if (!Number.isFinite(min) || min === 0) return lines.join("\n");
  return lines.map((l) => l.slice(min)).join("\n");
}

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

if (skipped.length) {
  for (const s of skipped) console.error(`  skipped: ${s.title} — ${s.why}`);
}

const html = readFileSync(PLAYGROUND, "utf8");

const optStart = html.indexOf(OPT_BEGIN);
const optEnd = html.indexOf(OPT_END);
const exStart = html.indexOf(EX_BEGIN);
const exEnd = html.indexOf(EX_END);

if (optStart < 0 || optEnd < 0)
  fail(`missing options markers in playground.html — need ${OPT_BEGIN} … ${OPT_END}`);
if (exStart < 0 || exEnd < 0)
  fail(`missing examples markers in playground.html — need ${EX_BEGIN} … ${EX_END}`);
if (optStart > optEnd) fail("OPTIONS markers reversed");
if (exStart > exEnd) fail("EXAMPLES markers reversed");

const prevSelectedMatch = html.slice(optStart, optEnd).match(/<option value="([^"]+)" selected/);
const previouslySelected = prevSelectedMatch ? prevSelectedMatch[1] : null;
const stillExists = previouslySelected && examples.some((e) => e.slug === previouslySelected);
const selectedSlug = stillExists ? previouslySelected : examples[0].slug;

const optBlock = examples
  .map((e) => {
    const sel = e.slug === selectedSlug ? " selected" : "";
    return `              <option value="${escapeHtml(e.slug)}"${sel}>${escapeHtml(e.title)}</option>`;
  })
  .join("\n");

const exBlock = examples
  .map((e) => {
    const indented = e.query
      .split("\n")
      .map((l) => (l === "" ? "" : "      " + l))
      .join("\n");
    return `    <script type="text/plain" data-ex="${escapeHtml(e.slug)}">\n${indented}\n    </script>`;
  })
  .join("\n\n");

const newOpt = `${OPT_BEGIN}\n${optBlock}\n              ${OPT_END}`;
const newEx = `${EX_BEGIN}\n${exBlock}\n    ${EX_END}`;

let out = html.slice(0, optStart) + newOpt + html.slice(optEnd + OPT_END.length);
const exStart2 = out.indexOf(EX_BEGIN);
const exEnd2 = out.indexOf(EX_END);
out = out.slice(0, exStart2) + newEx + out.slice(exEnd2 + EX_END.length);

if (out === html) {
  console.log(`sync-playground: ${examples.length} examples already in sync (no change)`);
  process.exit(0);
}

writeFileSync(PLAYGROUND, out);

const inGitRepo =
  spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: ROOT,
    stdio: "ignore",
  }).status === 0;
if (inGitRepo) {
  const add = spawnSync("git", ["add", path.relative(ROOT, PLAYGROUND)], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (add.status !== 0) fail("git add playground.html failed");
}

console.log(`sync-playground: synced ${examples.length} examples → playground.html`);
