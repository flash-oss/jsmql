import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT,
  scopeFiles,
  scanComments,
  counted,
  commentLines,
  countAll,
  readBaseline,
  removeComments,
} from "../scripts/comments.mjs";

const FIX =
  "Delete the comment. Record a non-obvious decision in docs/adr/, and file an issue for a shortcut. " +
  "The /delete-comment skill walks through the steps.";

describe("the comment ratchet", () => {
  const counts = countAll();
  const baseline = readBaseline();

  it("no file holds more comment lines than its baseline", () => {
    const grown = Object.entries(counts)
      .filter(([file, n]) => n > (baseline[file] ?? 0))
      .map(([file, n]) => {
        const lines = counted(scanComments(readFileSync(join(ROOT, file), "utf8"), file)).map((c) => c.line);
        const shown = lines.slice(0, 10).join(", ") + (lines.length > 10 ? ", …" : "");
        return `${file}: ${n} comment lines, the baseline allows ${baseline[file] ?? 0} (lines ${shown})`;
      });
    expect(grown, `${grown.join("\n")}\n${FIX}`).toEqual([]);
  });

  it("the baseline is no looser than the code", () => {
    const loose = Object.entries(baseline)
      .filter(([file, n]) => (counts[file] ?? 0) < n)
      .map(([file, n]) => `${file}: the baseline allows ${n}, the file holds ${counts[file] ?? 0}`);
    expect(loose, `${loose.join("\n")}\nRun \`node scripts/comments.mjs ratchet\` to lower the baseline.`).toEqual([]);
  });

  it("the baseline names only files in scope", () => {
    const inScope = new Set(scopeFiles());
    expect(Object.keys(baseline).filter((file) => !inScope.has(file))).toEqual([]);
  });
});

describe("the comment scanner", () => {
  const scan = (text: string) => counted(scanComments(text, "x.ts")).map((c) => c.text);

  it("finds line, block and doc comments", () => {
    expect(scan("// a\nconst x = 1; /* b */\n/** c */\nfunction f() {}")).toEqual(["// a", "/* b */", "/** c */"]);
  });

  it("reads a comment marker inside a string, a template or a regex as code", () => {
    expect(scan('const a = "// no"; const b = `/* no ${a} // no`; const c = /\\/\\/no/;')).toEqual([]);
  });

  it("exempts a tool directive", () => {
    expect(scan('/// <reference types="node" />\n// @ts-expect-error\nconst x: number = "s";')).toEqual([]);
  });

  it("exempts a comment inside a JSMQL arrow input", () => {
    expect(scan("jsmql(({ $ }) => {\n  // the input\n  $.a;\n});")).toEqual([]);
  });

  it("counts each source line once", () => {
    expect(commentLines(counted(scanComments("/* a\n b */ // c\nx;", "x.ts")))).toBe(2);
  });

  it("removes a comment and keeps the code", () => {
    const text = "// own line\nconst x = 1; // trailing\nf(/* inline */ 2);\n";
    expect(removeComments(text, counted(scanComments(text, "x.ts")))).toBe("const x = 1;\nf(2);\n");
  });
});
