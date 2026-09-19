#!/usr/bin/env node
// Every `<jsmql source>  // → <MQL>` pair in the prose, re-derived from the compiler.
//
//   node scripts/check-doc-claims.mjs [file …]
//     default: README.md, docs/LANGUAGE.md, docs/LANG_RULES.md, docs/specs/*.md
//
// A documentation example is a promise about what jsmql emits. Prose has no test to keep it honest.
// This script reads each fenced `js` block and pairs every `// →` comment with the source above it.
// It compiles that source and prints the pairs that disagree. It is an AUDIT tool, not a gate:
// it reads markdown, so it reports false positives (a template-tag source it cannot run, a claim
// that shows one stage of a longer pipeline, host code around a jsmql call). A human decides what matters.
// It skips a claim that leaves anything out (`…`, `/* … */`, `<…>`): that one is illustrative.
import { readFileSync, readdirSync } from "node:fs";
import { jsmql } from "../src/index.ts";

const FILES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["README.md", "docs/LANGUAGE.md", "docs/LANG_RULES.md", ...readdirSync("docs/specs").map((f) => `docs/specs/${f}`)];

// A claim is illustrative, not exact, when it leaves anything out: an ellipsis, a
// `/* … */` note, or a `<…>` stand-in for a shape it does not spell out fully.
const ELIDED = /…|\/\*|\.\.\.|— |\betc\b|<[^>]*>/;
// A block that drives the host (a driver call, a `require`, an arrow entry form)
// is JavaScript around jsmql, not jsmql itself. Only a bare source is re-derived.
const HOST = /^(const|let|var|db\.|import |require\()|=>|^\w+\(\{/;
// A claim is prose around a shape. Compare the shape only, ignoring quoting,
// whitespace, a trailing sentence, and the `<Date …>` / `<ObjectId …>` stand-ins
// that the prose uses for a live BSON value.
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
const norm = (s) =>
  s
    .replace(/<(Date|ObjectId)\s+([^>]*)>/g, "$2")
    .replace(/[\s"']/g, "")
    .replace(/,([}\]])/g, "$1");
// A claim line may end with a note of its own (`// → { … }   // the truthiness test`).
const unnoted = (l) => l.replace(/^(\s*\/\/\s?)(.*?)(\s+\/\/.*)?$/, "$1$2");
// A source in a quoted string carries the quote's escape sequences. The compiler wants the text.
const unescape = (q, body) => (q === "`" ? body : body.split("\\" + q).join(q));

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
    const inline = /^(\S.*?)\s+\/\/\s*→\s*(.*)$/.exec(l);
    if (inline !== null && !/^\s*\/\//.test(l)) {
      src = [inline[1]];
      srcLine = i + 1;
      lines[i] = "// → " + inline[2];
    }
    if (/^\s*\/\/\s*→/.test(lines[i])) {
      let j = i;
      while (j + 1 < lines.length && /^\s*\/\//.test(lines[j + 1]) && !/^\s*\/\/\s*→/.test(lines[j + 1])) j++;
      const claim = lines
        .slice(i, j + 1)
        .map((x) => unnoted(x).replace(/^\s*\/\/\s?/, ""))
        .join(" ")
        .replace(/^→\s*/, "");
      const text = src.join("\n").trim();
      src = [];
      i = j;
      // A claim that opens on a key (`let: { … }`) or a host call (`find({ … })`) shows
      // a piece of a document, not the whole document: it is illustrative.
      if (text === "" || ELIDED.test(claim) || HOST.test(text) || !/^[[{]/.test(claim)) continue;
      // `jsmql.stringify(<call>)` prints what the call returns. This script prints the same thing anyway,
      // so the claim is held to the inner call.
      const inner = /^jsmql\.stringify\(([\s\S]*)\);?$/.exec(text);
      const call = inner ? inner[1] : text;
      // A template tag that interpolates nothing is the string form. One that does interpolate
      // cannot run without its values and stays illustrative.
      const m =
        /^jsmql(\.\w+)?\(\s*([`"'])([\s\S]*)\2\s*\)[;,]?$/.exec(call) ?? /^jsmql(\.\w+)?(`)([\s\S]*)`;?$/.exec(call);
      if (m !== null && m[2] === "`" && m[3].includes("${")) continue;
      const source = m ? unescape(m[2], m[3]) : call;
      // A block that NAMES its entry point is held to it. `jsmql("…")` returning what
      // `jsmql.expr` returns is exactly the drift this script catches: a Filter shown as an
      // aggregation expression. Only an unlabelled source may answer from both.
      const named = m?.[1];
      const entries =
        named === ".validate"
          ? [jsmql.validate]
          : named === ".expr"
            ? [jsmql.expr]
            : named === ".update"
              ? [jsmql.update]
              : named === ".filter"
                ? [jsmql.filter]
                : named === ".pipeline"
                  ? [jsmql.pipeline]
                  : m !== null
                    ? [jsmql]
                    : [jsmql, jsmql.expr];
      checked++;
      const answers = entries.map((e) => {
        try {
          // The library's own printer. A claim that spells a Date or an ObjectId the way
          // the CLI writes it compares as written. `norm` below drops the quotes and spacing,
          // so a claim in either style matches.
          return jsmql.stringify(e(source), { width: Infinity });
        } catch (err) {
          return `ERROR ${err.message}`;
        }
      });
      const got = answers[0];
      // A claim may show the one stage a statement makes, not the pipeline holding it.
      // The claim is a shape (or a sequence of stages) inside prose. Compare shapes only.
      const parts = shapes(claim);
      if (parts.length === 0) continue;
      const forms = parts.flatMap((_, k) => {
        const lead = norm(parts.slice(0, k + 1).join(","));
        return [lead, `[${lead}]`];
      });
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
    // A blank line separates one example from the next one inside a block.
    if (l.trim() === "") {
      src = [];
      continue;
    }
    if (src.length === 0) srcLine = i + 1;
    src.push(l);
  }
}
console.log(`\n${checked} exact claims checked, ${bad} disagree`);
