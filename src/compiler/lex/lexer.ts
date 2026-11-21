import { ENDS_A_VALUE, TOKENS } from "../../registry/tokens.ts";
import { KEYWORDS } from "../../registry/keywords.ts";
import type { TokenName } from "../../registry/vocabulary.ts";
import { type Token, token } from "./token.ts";
import {
  decodeEscape,
  isIdentStart,
  LexError,
  type RegexScan,
  scanIdent,
  scanNumber,
  scanRegex,
  scanString,
  skipTrivia,
} from "./scanners.ts";

const TEMPLATE_DELIMITER = "`";
const TEMPLATE_EXPR_OPEN = "${";

type Punct = {
  spelling: string;
  type: TokenName | null;
  chooseBy: { afterValue: TokenName; otherwise: TokenName } | null;
  tracksDepth: boolean;
  resumesTemplateAtDepth: boolean;
};

const PUNCTUATORS: readonly Punct[] = Object.entries(TOKENS)
  .filter(([, row]) => row.variable !== true)
  .map(([spelling, row]) => {
    const punct: Punct = {
      spelling,
      type: Array.isArray(row.token) ? null : (row.token as TokenName),
      chooseBy: "chooseBy" in row && row.chooseBy !== undefined ? row.chooseBy : null,
      tracksDepth: "tracksDepth" in row && row.tracksDepth === true,
      resumesTemplateAtDepth: "resumesTemplateAtDepth" in row && row.resumesTemplateAtDepth === true,
    };
    if (punct.type === null && punct.chooseBy === null && spelling !== TEMPLATE_DELIMITER) {
      throw new Error(`tokens.ts: '${spelling}' names two token types and no chooseBy rule to pick one`);
    }
    return punct;
  })
  .sort((a, b) => b.spelling.length - a.spelling.length);

const OTHERWISE_SCANNERS: Readonly<Partial<Record<TokenName, (src: string, i: number) => RegexScan>>> = {
  RegexLiteral: scanRegex,
};

const INTRODUCES_NAME: ReadonlySet<TokenName> = new Set(
  Object.values(TOKENS)
    .filter((row) => "introducesName" in row && row.introducesName === true)
    .flatMap((row) => (Array.isArray(row.token) ? row.token : [row.token]) as TokenName[]),
);

const MAX_RUN: ReadonlyMap<string, { limit: number; tooLong: string }> = new Map(
  Object.entries(TOKENS)
    .filter(([key, row]) => "maxRun" in row && row.maxRun !== undefined && /^(.)\1*$/.test(key))
    .map(([key, row]) => [key[0], (row as { maxRun: { limit: number; tooLong: string } }).maxRun]),
);

const RESERVED: ReadonlyMap<string, TokenName> = new Map(
  Object.entries(KEYWORDS).map(([word, row]) => [word, row.token]),
);

const VALUE_END: ReadonlySet<TokenName> = new Set(ENDS_A_VALUE);

export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let braceDepth = 0;
  const templateDepths: number[] = [];
  let last: TokenName | null = null;

  const push = (t: Token): void => {
    out.push(t);
    last = t.type;
  };

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
        const esc = decodeEscape(src, j);
        text += esc.text;
        j = esc.next;
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

    if (isIdentStart(ch)) {
      const scan = scanIdent(src, i);
      const asName = last !== null && INTRODUCES_NAME.has(last);
      const reserved = asName ? undefined : RESERVED.get(scan.token.text);
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

    const cap = MAX_RUN.get(ch);
    if (cap !== undefined) {
      let run = 0;
      while (src[start + run] === ch) run++;
      if (run > cap.limit) throw new LexError(cap.tooLong, start);
    }

    const hit = PUNCTUATORS.find((p) => src.startsWith(p.spelling, i));
    if (hit === undefined) throw new LexError(`Unexpected character '${ch}'`, start);

    if (hit.chooseBy !== null) {
      const afterValue = last !== null && VALUE_END.has(last);
      if (!afterValue) {
        const scanner = OTHERWISE_SCANNERS[hit.chooseBy.otherwise];
        if (scanner === undefined) {
          throw new LexError(`'${hit.spelling}' chooses '${hit.chooseBy.otherwise}', which has no scanner`, start);
        }
        const scan = scanner(src, i);
        push({ ...scan.token, flags: scan.flags });
        i = scan.next;
        continue;
      }
      push(token(hit.chooseBy.afterValue, hit.spelling, i));
      i += hit.spelling.length;
      continue;
    }

    if (
      hit.resumesTemplateAtDepth &&
      templateDepths.length > 0 &&
      templateDepths[templateDepths.length - 1] === braceDepth
    ) {
      templateDepths.pop();
      i = templateChunk(i + hit.spelling.length);
      continue;
    }

    if (hit.type === null) throw new LexError(`'${hit.spelling}' has no single token type`, start);
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
