// Pull the playground's default example VERBATIM out of test/realistic.test.ts.
// Extracted, never retyped, so the slide cannot drift from the real example —
// every character, including comments and inner blank lines, is preserved.
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync(new URL("../test/realistic.test.ts", import.meta.url), "utf8");
// Anchor on a real tagged-template call site: `jsmql` immediately followed by a
// backtick and a newline. A bare indexOf("jsmql`") matches the prose in the
// file's own JSDoc header first.
const m = /(^|[^\w.])jsmql`\n/.exec(src);
if (!m) throw new Error("no jsmql`…` call site found");
const bodyStart = m.index + m[0].length;
const close = src.indexOf("`", bodyStart);
if (close < 0) throw new Error("unterminated template literal");

let body = src.slice(bodyStart, close);
body = body.replace(/\n[ \t]*$/, ""); // drop the indentation-only closing line

writeFileSync(new URL("./examples/wow.jsmql", import.meta.url), body + "\n");
console.log(`extracted ${body.split("\n").length} lines verbatim from test/realistic.test.ts`);
