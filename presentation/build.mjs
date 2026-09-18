import { readFileSync, writeFileSync } from "node:fs";
const [, , S, OUT] = process.argv;
const tpl = readFileSync(`${S}/presentation_skeleton.html`, "utf8");
const ex = readFileSync(`${S}/examples.json`, "utf8").replace(/<\//g, "<\\/");
if (!tpl.includes("/*__EXAMPLES__*/")) throw new Error("marker missing");

// MUST use a replacer FUNCTION. With a string replacement, String.replace reads
// `$$` as an escape for a literal `$`, which silently rewrites every jsmql sigil
// in the payload ($$$.orders -> $$.orders, $$.length -> $.length) and every
// "$$var" reference inside the emitted MQL.
const out = tpl.replace("/*__EXAMPLES__*/", () => ex);

// The payload must survive byte-for-byte; a corrupted sigil is invisible on a slide.
if (!out.includes(ex)) throw new Error("examples payload was altered during injection");
writeFileSync(OUT, out);
console.log("wrote", OUT, (readFileSync(OUT).length / 1024).toFixed(1) + " KB");
