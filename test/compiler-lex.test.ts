// Phase 1 of src/compiler/ — the table-driven lexer.
//
// The suite's own inputs are the specification: every JSMQL source the tests feed
// to `jsmql(...)` must lex to the same token stream as the lexer it replaces. That
// is the guidance, not the target — where the two disagree the new one may be
// right, and any such case is listed explicitly rather than silently allowed.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Lexer, type Token as OldToken } from "../src/lexer.ts";
import { lex, LexError } from "../src/compiler/lex/lexer.ts";
import { TOKENS } from "../src/registry/tokens.ts";
import { KEYWORDS } from "../src/registry/keywords.ts";

/** Every JSMQL source the suite hands to an entry point. */
function harvestInputs(): string[] {
  const found = new Set<string>();
  const dir = new URL(".", import.meta.url).pathname;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".test.ts"))) {
    const src = readFileSync(dir + file, "utf8");
    for (const m of src.matchAll(/jsmql(?:\.\w+)?\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const s = m[2].replace(/\\(['"\\])/g, "$1").replace(/\\n/g, "\n");
      if (s.length > 0 && s.length < 400) found.add(s);
    }
  }
  return [...found];
}

const oldStream = (src: string): [string, string][] => {
  const lx = new Lexer(src);
  const out: [string, string][] = [];
  for (;;) {
    const t: OldToken = lx.next();
    out.push([t.type, String(t.value)]);
    if (t.type === "EOF") break;
  }
  return out;
};
const newStream = (src: string): [string, string][] => lex(src).map((t) => [t.type, t.text]);

describe("compiler/lex — parity with the lexer it replaces", () => {
  const inputs = harvestInputs();

  it("harvests a meaningful number of real inputs", () => {
    expect(inputs.length).toBeGreaterThan(2000);
  });

  /**
   * Where the new lexer is RIGHT and the old one wrong: a reserved word after an
   * introducer is a name. The old lexer emitted the keyword token (`In`, `Let`,
   * `Const`) and left the parser to re-read it; the new one emits `Ident`, and
   * the parser never sees a keyword where a name belongs. `node --check`
   * confirms every one of these is legal JavaScript.
   */
  const KEYWORD_AS_NAME = /(\$|\$\.|\.)(in|let|const|new|typeof|return|delete)\b/;

  it("produces an identical token stream for every input the suite uses", () => {
    const differences: string[] = [];
    for (const src of inputs) {
      if (KEYWORD_AS_NAME.test(src)) continue;
      let a: [string, string][] | null = null;
      let b: [string, string][] | null = null;
      let aThrew = false;
      let bThrew = false;
      try {
        a = oldStream(src);
      } catch {
        aThrew = true;
      }
      try {
        b = newStream(src);
      } catch {
        bThrew = true;
      }
      if (aThrew && bThrew) continue;
      if (aThrew !== bThrew) {
        differences.push(`${JSON.stringify(src)} — only ${aThrew ? "old" : "new"} refused it`);
        continue;
      }
      if (JSON.stringify(a) !== JSON.stringify(b)) differences.push(JSON.stringify(src));
    }
    expect(differences).toEqual([]);
  });
});

describe("compiler/lex — the four rules a longest-match table cannot imply", () => {
  it("maxRun refuses a run longer than its row allows", () => {
    expect(lex("$$$$.db.c").map((t) => t.type)).toContain("QuadDollar");
    expect(() => lex("$$$$$.a")).toThrow(/Up to 4 levels of context reference/);
  });

  it("chooseBy reads a slash as division after a value and a regex otherwise", () => {
    expect(lex("$.a / 2").map((t) => t.type)).toEqual(["DollarDot", "Ident", "Slash", "Number", "EOF"]);
    expect(lex("/ab/i.test($.s)")[0]).toMatchObject({ type: "RegexLiteral", text: "ab", flags: "i" });
  });

  it("tracksDepth lets an interpolation find its own closing brace", () => {
    expect(lex("`${ {a: 1} } px`").map((t) => t.type)).toEqual([
      "TemplateStart",
      "TemplateChars",
      "TemplateExprStart",
      "LBrace",
      "Ident",
      "Colon",
      "Number",
      "RBrace",
      "TemplateChars",
      "TemplateEnd",
      "EOF",
    ]);
  });

  it("resumesTemplateAtDepth emits no token for the brace that ends an interpolation", () => {
    const types = lex("`n=${42}`").map((t) => t.type);
    expect(types).toEqual([
      "TemplateStart",
      "TemplateChars",
      "TemplateExprStart",
      "Number",
      "TemplateChars",
      "TemplateEnd",
      "EOF",
    ]);
    expect(types).not.toContain("RBrace");
  });

  it("handles a template nested inside an interpolation", () => {
    expect(lex("`outer ${`inner ${$.x}`}`").filter((t) => t.type === "TemplateEnd")).toHaveLength(2);
  });
});

describe("compiler/lex — one decoder for every quoted form", () => {
  it("decodes the same escape identically in a string and in a template", () => {
    // The template used to drop the backslash and KEEP the letter, so `\n` read
    // as "n" — valid MQL, wrong string, and nothing reported it.
    for (const [esc, want] of [
      ["n", "\n"],
      ["t", "\t"],
      ["r", "\r"],
      ["\\", "\\"],
      ["x", "x"],
      ["0", "0"],
    ]) {
      const str = lex(`"a\\${esc}b"`)[0];
      const tpl = lex(`\`a\\${esc}b\``)[1];
      expect(str.type).toBe("String");
      expect(tpl.type).toBe("TemplateChars");
      expect(str.text, `\\${esc}`).toBe(`a${want}b`);
      expect(tpl.text, `\\${esc}`).toBe(str.text);
    }
  });
});

describe("compiler/lex — a reserved word after an introducer is a name", () => {
  const types = (src: string): string[] => lex(src).map((t) => t.type);

  it("reads a keyword as Ident after `.`, `?.`, `$.` and `$`", () => {
    // The rows state `introducesName`; the lexer never lists the words.
    expect(types("$.typeof")).toEqual(["DollarDot", "Ident", "EOF"]);
    expect(types("x.delete")).toEqual(["Ident", "Dot", "Ident", "EOF"]);
    expect(types("x?.null")).toEqual(["Ident", "QuestDot", "Ident", "EOF"]);
    expect(types("$in(1)")).toEqual(["Dollar", "Ident", "LParen", "Number", "RParen", "EOF"]);
  });

  it("keeps the same word an operator everywhere else", () => {
    expect(types("a in b")).toEqual(["Ident", "In", "Ident", "EOF"]);
    expect(types("typeof a")).toEqual(["Typeof", "Ident", "EOF"]);
    // A key position is not an introducer: the PARSER accepts the keyword there.
    expect(types("{ in: 1 }")).toEqual(["LBrace", "In", "Colon", "Number", "RBrace", "EOF"]);
  });

  it("lets a field named after a keyword be divided, not read as a regex", () => {
    // `$.typeof / 2` used to mis-lex the `/` as an unterminated regex, because the
    // keyword token was not in ENDS_A_VALUE and could not be — as an OPERATOR it
    // really does not end a value. As a name it is an Ident, and an Ident does.
    expect(types("$.typeof / 2")).toEqual(["DollarDot", "Ident", "Slash", "Number", "EOF"]);
    expect(types("$.a / 2")).toEqual(["DollarDot", "Ident", "Slash", "Number", "EOF"]);
    expect(types("/ab/")).toEqual(["RegexLiteral", "EOF"]);
  });

  it("states introducesName on exactly the four rows the language has", () => {
    const stated = Object.entries(TOKENS)
      .filter(([, row]) => "introducesName" in row && row.introducesName === true)
      .map(([spelling]) => spelling)
      .sort();
    expect(stated).toEqual(["$", "$.", ".", "?."]);
  });
});

describe("compiler/lex — every fact comes from a row", () => {
  it("promotes exactly the words keywords.ts reserves", () => {
    for (const [word, row] of Object.entries(KEYWORDS)) {
      expect(lex(word)[0]).toMatchObject({ type: row.token, text: word });
    }
  });

  it("lexes every fixed spelling in tokens.ts to the type its row names", () => {
    for (const [spelling, row] of Object.entries(TOKENS)) {
      if (row.variable === true) continue;
      // A row naming several types is decided by position, and has its own case above.
      if (Array.isArray(row.token)) continue;
      const first = lex(spelling)[0];
      expect(first.type, `spelling ${JSON.stringify(spelling)}`).toBe(row.token);
    }
  });

  it("carries a position on every refusal", () => {
    try {
      lex("$$$$$");
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(LexError);
      expect((e as LexError).pos).toBe(0);
    }
  });
});
