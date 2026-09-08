#!/usr/bin/env node
// Every `<jsmql source>  // → <MQL>` pair in the prose, re-derived from the compiler.
//
//   node scripts/check-doc-claims.mjs [file …]     (default: README + docs/)
//
// A doc example is a promise about what jsmql emits, and prose has no test to
// keep it honest. This reads each fenced `js` block, pairs every `// →` comment
// run with the source above it, compiles that source, and prints the pairs that
// disagree. An AUDIT tool, not a gate: it reads markdown, so it reports false
// positives — a template-tag source it cannot run, a claim that shows one stage of
// a longer pipeline, host code around a jsmql call — and a human decides. Skips a
// claim that elides anything (`…`, `/* … */`, `<…>`): that one is illustrative.
import { readFileSync, readdirSync } from "node:fs";
import { jsmql } from "../src/index.ts";

const FILES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["README.md", "docs/LANGUAGE.md", "docs/LANG_RULES.md", ...readdirSync("docs/specs").map((f) => `docs/specs/${f}`)];

// A claim is illustrative, not exact, when it elides anything: an ellipsis, a
// `/* … */` note, or a `<…>` stand-in for a shape it does not spell out.
const ELIDED = /…|\/\*|\.\.\.|— |\betc\b|<[^>]*>/;
// A block that drives the host — a driver call, a `require`, an arrow entry form
// — is JavaScript around jsmql, not jsmql. Only a bare source is re-derived.
const HOST = /^(const|let|var|db\.|import |require\()|=>|^\w+\(\{/;
// A claim is prose around a shape. Compare the shape only, ignoring quoting,
// whitespace, a trailing sentence, and the `<Date …>` / `<ObjectId …>` stand-ins
// the prose uses for a live BSON value.
const shapes = (s) => {
  const out = [];
  let depth = 0,
    start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{" || c === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
};
const norm = (s) => s.replace(/<(Date|ObjectId)\s+([^>]*)>/g, "$2").replace(/[\s"']/g, "");

let bad = 0,
  checked = 0;

for (const f of FILES) {
  const lines = readFileSync(f, "utf8").split("\n");
  let inBlock = false,
    src = [],
    srcLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      inBlock = /^\s*```(js|javascript)\s*$/.test(l);
      src = [];
      continue;
    }
    if (!inBlock) continue;
    if (/^\s*\/\/\s*→/.test(l)) {
      let j = i;
      while (j + 1 < lines.length && /^\s*\/\//.test(lines[j + 1]) && !/^\s*\/\/\s*→/.test(lines[j + 1])) j++;
      const claim = lines
        .slice(i, j + 1)
        .map((x) => x.replace(/^\s*\/\/\s?/, ""))
        .join(" ")
        .replace(/^→\s*/, "");
      const text = src.join("\n").trim();
      src = [];
      i = j;
      if (text === "" || ELIDED.test(claim) || HOST.test(text)) continue;
      const m = /^jsmql(\.\w+)?\(\s*[`"']([\s\S]*)[`"']\s*\)[;,]?$/.exec(text);
      const source = m ? m[2] : text;
      // The prose does not say which entry point it means, so any of the three
      // agreeing is agreement; only a claim NONE of them produces is drift.
      const entries = m?.[1] === ".expr" ? [jsmql.expr] : m?.[1] === ".update" ? [jsmql.update] : [jsmql, jsmql.expr];
      checked++;
      const answers = entries.map((e) => {
        try {
          return JSON.stringify(e(source));
        } catch (err) {
          return `ERROR ${err.message}`;
        }
      });
      const got = answers[0];
      // A claim may show the one stage a statement makes, not the pipeline holding it.
      // The claim is a shape (or a run of stages) inside prose; compare shapes only.
      const parts = shapes(claim);
      if (parts.length === 0) continue;
      const forms = [norm(parts.join(",")), `[${norm(parts.join(","))}]`];
      const ok = answers.some((a) => forms.includes(norm(a)));
      if (!ok) {
        bad++;
        console.log(
          `\n${f}:${srcLine}\n  src   ${source.replace(/\n/g, " ⏎ ").slice(0, 150)}\n  doc   ${claim.slice(0, 200)}\n  real  ${got.slice(0, 200)}`,
        );
      }
      continue;
    }
    if (/^\s*\/\//.test(l)) continue;
    // A blank line separates one example from the next inside a block.
    if (l.trim() === "") {
      src = [];
      continue;
    }
    if (src.length === 0) srcLine = i + 1;
    src.push(l);
  }
}
console.log(`\n${checked} exact claims checked, ${bad} disagree`);
