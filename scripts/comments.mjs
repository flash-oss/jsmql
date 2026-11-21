#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_PATH = join(ROOT, "test", "comment-baseline.json");

const SOURCE = /\.(ts|mts|cts|js|mjs|cjs)$/;
const OUT_OF_SCOPE = [/^vendor\//, /^dist\//, /^src\/globals\.ts$/, /^test\/human\//];

const DIRECTIVES = [
  /^\/\/\/\s*<reference\b/,
  /^\/\/\s*@ts-expect-error\b/,
  /^\/[/*]\s*[#@]__(PURE|NO_SIDE_EFFECTS)__/,
  /^\/\/\s*oxfmt-ignore\b/,
  /^\/\/\s*@vitest-environment\b/,
];

const TOOLBOX_NAMES = new Set(["$", "$$", "$$$", "$$$$"]);

export function scopeFiles(root = ROOT) {
  return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => SOURCE.test(f) && !OUT_OF_SCOPE.some((re) => re.test(f)) && existsSync(join(root, f)));
}

function kindOf(file) {
  return /\.(ts|mts|cts)$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function destructuresToolbox(param) {
  return (
    param !== undefined &&
    ts.isObjectBindingPattern(param.name) &&
    param.name.elements.some((e) => TOOLBOX_NAMES.has((e.propertyName ?? e.name).getText()))
  );
}

function isJsmqlInput(fn) {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  if (fn.parameters.slice(0, 2).some(destructuresToolbox)) return true;
  const call = fn.parent;
  return ts.isCallExpression(call) && /^jsmql(\.\w+)*$/.test(call.expression.getText());
}

export function scanComments(text, file = "x.ts") {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindOf(file));
  const found = new Map();
  const inputs = [];
  const add = (ranges) => {
    for (const r of ranges ?? []) if (!found.has(r.pos)) found.set(r.pos, r);
  };
  const visit = (node) => {
    if (isJsmqlInput(node)) inputs.push([node.getStart(sf), node.end]);
    const children = node.getChildren(sf);
    if (children.length === 0) {
      add(ts.getLeadingCommentRanges(text, node.pos));
      add(ts.getTrailingCommentRanges(text, node.end));
    }
    children.forEach(visit);
  };
  visit(sf);
  const lineStarts = sf.getLineStarts();
  return [...found.values()]
    .sort((a, b) => a.pos - b.pos)
    .map((r) => {
      const body = text.slice(r.pos, r.end);
      const line = sf.getLineAndCharacterOfPosition(r.pos).line + 1;
      const endLine = sf.getLineAndCharacterOfPosition(r.end).line + 1;
      const lineText = text.slice(lineStarts[line - 1], lineStarts[endLine] ?? text.length);
      const exempt = DIRECTIVES.some((re) => re.test(body))
        ? "directive"
        : inputs.some(([s, e]) => r.pos >= s && r.end <= e)
          ? "jsmql-input"
          : null;
      return {
        pos: r.pos,
        end: r.end,
        line,
        endLine,
        text: body,
        ownLine: lineText.replace(body, "").trim() === "",
        exempt,
      };
    });
}

export function counted(comments) {
  return comments.filter((c) => c.exempt === null);
}

export function commentLines(comments) {
  return new Set(comments.flatMap((c) => Array.from({ length: c.endLine - c.line + 1 }, (_, i) => c.line + i))).size;
}

export function removeComments(text, comments) {
  let out = text;
  for (const c of [...comments].sort((a, b) => b.pos - a.pos)) {
    const lineStart = out.lastIndexOf("\n", c.pos - 1) + 1;
    const nl = out.indexOf("\n", c.end);
    const lineEnd = nl === -1 ? out.length : nl;
    const before = out.slice(lineStart, c.pos);
    const after = out.slice(c.end, lineEnd);
    if (before.trim() === "" && after.trim() === "") {
      out = out.slice(0, lineStart) + out.slice(nl === -1 ? lineEnd : lineEnd + 1);
    } else if (after.trim() === "") {
      out = out.slice(0, lineStart) + before.trimEnd() + out.slice(c.end);
    } else if (before.trim() === "") {
      out = out.slice(0, c.pos) + after.trimStart() + out.slice(lineEnd);
    } else {
      const left = out.slice(0, c.pos).replace(/[ \t]+$/, "");
      const right = out.slice(c.end).replace(/^[ \t]+/, "");
      const join = c.text.includes("\n") ? "\n" : /[([{]$/.test(left) || /^[)\]},;.]/.test(right) ? "" : " ";
      out = left + join + right;
    }
  }
  return out;
}

export function countAll(root = ROOT) {
  const counts = {};
  for (const f of scopeFiles(root)) {
    const n = commentLines(counted(scanComments(readFileSync(join(root, f), "utf8"), f)));
    if (n > 0) counts[f] = n;
  }
  return counts;
}

export function readBaseline() {
  return existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
}

function writeBaseline(counts) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(sorted, null, 2) + "\n");
}

export function commentBlocks(text, file) {
  const blocks = [];
  for (const c of counted(scanComments(text, file))) {
    const last = blocks.at(-1);
    if (last && c.ownLine && last.ownLine && c.line === last.endLine + 1 && !c.text.startsWith("/**")) {
      last.comments.push(c);
      last.endLine = c.endLine;
    } else {
      blocks.push({
        id: `${file}:${c.line}`,
        file,
        line: c.line,
        endLine: c.endLine,
        ownLine: c.ownLine,
        comments: [c],
      });
    }
  }
  return blocks;
}

function blockMarkdown(block, lines) {
  const range = block.endLine > block.line ? `-${block.endLine}` : "";
  const code = block.ownLine
    ? lines.slice(block.endLine, block.endLine + 4).map((l, i) => `${block.endLine + 1 + i}: ${l}`)
    : [`${block.line}: ${lines[block.line - 1]}`];
  const where = block.ownLine ? "" : " (trailing or inline)";
  return `### ${block.file}:${block.line}${range}${where}\n${block.comments.map((c) => c.text).join("\n")}\n--- code:\n${code.join("\n")}\n`;
}

function parseArgs(args) {
  const keep = new Set();
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--keep") keep.add(args[++i]);
    else files.push(args[i]);
  }
  return { keep, files: files.length > 0 ? files : scopeFiles() };
}

function main([cmd, ...args]) {
  const { keep, files } = parseArgs(args);
  if (cmd === "count") {
    const counts = countAll();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    for (const [f, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`${n}\t${f}`);
    console.log(`${total}\ttotal`);
    return;
  }
  if (cmd === "blocks") {
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), "utf8");
      const lines = text.split("\n");
      for (const block of commentBlocks(text, f)) console.log(blockMarkdown(block, lines));
    }
    return;
  }
  if (cmd === "strip") {
    for (const f of files) {
      const path = join(ROOT, f);
      const text = readFileSync(path, "utf8");
      const doomed = commentBlocks(text, f)
        .filter((b) => !keep.has(b.id))
        .flatMap((b) => b.comments);
      writeFileSync(path, removeComments(text, doomed));
    }
    return;
  }
  if (cmd === "init") {
    if (existsSync(BASELINE_PATH)) {
      console.error(`${BASELINE_PATH} exists. Run \`ratchet\` to lower it.`);
      process.exitCode = 1;
      return;
    }
    writeBaseline(countAll());
    return;
  }
  if (cmd === "ratchet") {
    const counts = countAll();
    const baseline = readBaseline();
    const grown = Object.entries(counts).filter(([f, n]) => n > (baseline[f] ?? 0));
    if (grown.length > 0) {
      for (const [f, n] of grown) console.error(`${f}: ${n} comment lines, the baseline allows ${baseline[f] ?? 0}`);
      process.exitCode = 1;
      return;
    }
    writeBaseline(counts);
    return;
  }
  console.error(
    "usage: node scripts/comments.mjs count | blocks [file…] | strip [--keep <file:line>]… [file…] | init | ratchet",
  );
  process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
