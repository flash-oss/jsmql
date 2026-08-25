// Phase 1 — LEX. Driven by src/registry/tokens.ts and src/registry/keywords.ts.
//
// The old lexer wrote one `if` per spelling, ordered longest-first by hand, and
// promoted reserved words with a hard-coded switch. Both are table reads here:
// the punctuator order is DERIVED from the key lengths, and the promotion is the
// keywords table. Adding a token becomes a row, never a branch.
//
// Four decisions a longest-match table cannot imply are stated on the rows that
// own them, and read below:
//   maxRun                  `$$$$$` must fail, not match `$$$$` then `$`
//   chooseBy                `/` is division after a value, a regex otherwise
//   tracksDepth             `{` counts depth so a template knows its own `}`
//   resumesTemplateAtDepth  that `}` emits NO token and resumes the template

import { ENDS_A_VALUE, TOKENS } from "../../registry/tokens.ts";
import { KEYWORDS } from "../../registry/keywords.ts";
import type { TokenName } from "../../registry/vocabulary.ts";
import { type Token, token } from "./token.ts";
import {
  isIdentPart,
  isIdentStart,
  LexError,
  scanIdent,
  scanNumber,
  scanRegex,
  scanString,
  skipTrivia,
} from "./scanners.ts";

// ── the tables, built once from the registry ─────────────────────────────────

type Punct = {
  spelling: string;
  /** The single type, when the row names one. */
  type: TokenName | null;
  chooseBy: { afterValue: TokenName; otherwise: TokenName } | null;
  tracksDepth: boolean;
  resumesTemplateAtDepth: boolean;
};

/**
 * Every fixed spelling, LONGEST FIRST. The order is the key length, so `===`
 * cannot be shadowed by `==` and no row has to be placed by hand.
 */
const PUNCTUATORS: readonly Punct[] = Object.entries(TOKENS)
  .filter(([, row]) => row.variable !== true)
  .map(([spelling, row]) => ({
    spelling,
    type: Array.isArray(row.token) ? null : (row.token as TokenName),
    chooseBy: "chooseBy" in row && row.chooseBy !== undefined ? row.chooseBy : null,
    tracksDepth: "tracksDepth" in row && row.tracksDepth === true,
    resumesTemplateAtDepth: "resumesTemplateAtDepth" in row && row.resumesTemplateAtDepth === true,
  }))
  .sort((a, b) => b.spelling.length - a.spelling.length);

/**
 * A cap on a repeated character, from the row that states it. The key IS the
 * longest legal run, so `$$$$` gives the character and the limit together.
 */
const MAX_RUN: ReadonlyMap<string, { limit: number; tooLong: string }> = new Map(
  Object.entries(TOKENS)
    .filter(([key, row]) => "maxRun" in row && row.maxRun !== undefined && /^(.)\1*$/.test(key))
    .map(([key, row]) => [key[0], (row as { maxRun: { limit: number; tooLong: string } }).maxRun]),
);

/** word → the token type the lexer promotes it to. */
const RESERVED: ReadonlyMap<string, TokenName> = new Map(
  Object.entries(KEYWORDS).map(([word, row]) => [word, row.token]),
);

const VALUE_END: ReadonlySet<TokenName> = new Set(ENDS_A_VALUE);

/** The one spelling that opens and closes a template, and its two types. */
const TEMPLATE_DELIMITER = "`";
const TEMPLATE_EXPR_OPEN = "${";

// ── the driver ───────────────────────────────────────────────────────────────

export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let braceDepth = 0;
  /** One entry per open template interpolation, holding the depth it started at. */
  const templateDepths: number[] = [];
  let last: TokenName | null = null;

  const push = (t: Token): void => {
    out.push(t);
    last = t.type;
  };

  /**
   * Read template text up to the next boundary. Always emits the text, then
   * either the closing delimiter or the interpolation opener.
   */
  const templateChunk = (from: number): number => {
    let j = from;
    let text = "";
    for (;;) {
      if (j >= src.length) throw new LexError("Unterminated template literal", from);
      const ch = src[j];
      if (ch === TEMPLATE_DELIMITER) {
        push({ type: "TemplateChars", text, pos: from, end: j });
        push(token("TemplateEnd", TEMPLATE_DELIMITER, j));
        return j + 1;
      }
      if (ch === "$" && src[j + 1] === "{") {
        push({ type: "TemplateChars", text, pos: from, end: j });
        push(token("TemplateExprStart", TEMPLATE_EXPR_OPEN, j));
        templateDepths.push(braceDepth);
        return j + 2;
      }
      if (ch === "\\") {
        text += src[j + 1] ?? "";
        j += 2;
        continue;
      }
      text += ch;
      j++;
    }
  };

  while (i < src.length) {
    i = skipTrivia(src, i);
    if (i >= src.length) break;
    const start = i;
    const ch = src[i];

    // A name, or a reserved word promoted to its own type.
    if (isIdentStart(ch)) {
      const scan = scanIdent(src, i);
      const reserved = RESERVED.get(scan.token.text);
      push(reserved === undefined ? scan.token : token(reserved, scan.token.text, start));
      i = scan.next;
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      const scan = scanNumber(src, i);
      push(scan.token);
      i = scan.next;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const scan = scanString(src, i);
      push(scan.token);
      i = scan.next;
      continue;
    }

    if (ch === TEMPLATE_DELIMITER) {
      push(token("TemplateStart", TEMPLATE_DELIMITER, i));
      i = templateChunk(i + 1);
      continue;
    }

    // A run longer than its row allows. Checked BEFORE the match, because
    // longest-match alone would happily split it into two legal tokens.
    const cap = MAX_RUN.get(ch);
    if (cap !== undefined) {
      let run = 0;
      while (src[start + run] === ch) run++;
      if (run > cap.limit) throw new LexError(cap.tooLong, start);
    }

    const hit = PUNCTUATORS.find((p) => src.startsWith(p.spelling, i));
    if (hit === undefined) throw new LexError(`Unexpected character '${ch}'`, start);

    // One spelling, two types, decided on the PRECEDING token.
    if (hit.chooseBy !== null) {
      const afterValue = last !== null && VALUE_END.has(last);
      if (!afterValue) {
        const scan = scanRegex(src, i);
        push({ ...scan.token, flags: scan.flags });
        i = scan.next;
        continue;
      }
      push(token(hit.chooseBy.afterValue, hit.spelling, i));
      i += hit.spelling.length;
      continue;
    }

    // The one closer that emits nothing: it ends an interpolation instead.
    if (
      hit.resumesTemplateAtDepth &&
      templateDepths.length > 0 &&
      templateDepths[templateDepths.length - 1] === braceDepth
    ) {
      templateDepths.pop();
      i = templateChunk(i + hit.spelling.length);
      continue;
    }

    if (hit.type === null) throw new LexError(`'${hit.spelling}' needs a chooseBy rule to be lexable`, start);
    push(token(hit.type, hit.spelling, i));
    if (hit.tracksDepth) braceDepth++;
    else if (hit.resumesTemplateAtDepth) braceDepth--;
    i += hit.spelling.length;
  }

  if (templateDepths.length > 0) throw new LexError("Unterminated template literal", src.length);
  out.push(token("EOF", "", src.length));
  return out;
}

export { LexError };
export type { Token };
