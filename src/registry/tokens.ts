// REGISTRY 1 of 4 — the token table. LEXICAL phase.
//
// Keyed by the SPELLING, except for the 6 tokens that have no spelling —
// number, bigint, string, regex, templateText, identifier. A class name keys
// those, and they carry the mark `variable`.
//
// `token` holds a LIST where one spelling maps to more than one token type, because the
// lexer classifies it by position. A backtick is TemplateStart at the start and
// TemplateEnd at the end. A `/` is Slash or RegexLiteral, and the token before it
// decides. A single `TokenName` cannot state either fact.
//
// This file holds NO MQL. The lexer is its only reader, and a lexer cannot use a
// renderer. A renderer here is thus a fact in the wrong phase. The meaning of each
// token lives in productions.ts. The meaning of each NAME lives in names.ts.
//
// A reserved word has no row here. The lexer promotes each one to its own token
// type, and keywords.ts holds that promotion.
//
// `tmp/gen-tokens.mjs` generates this table from the lexer's TOKEN_DISPLAY, so the
// table cannot drift from the tokeniser it describes.

import type { TokenName } from "./vocabulary.ts";

export type TokenSpec<C extends string = never> = {
  doc: string;
  /**
   * The lexer TokenType this row describes. It holds every possible type when the
   * lexer decides between them by position.
   */
  token: TokenName | readonly TokenName[];
  role:
    | "open"
    | "close"
    /** It opens and closes itself, so it has no separate closer row. */
    | "delimiter"
    | "separator"
    | "binder"
    | "arrow"
    | "spread"
    | "operator"
    | "literal"
    | "name"
    | "reference";
  /** For a closer: the key of its opener. Audited below. */
  closes?: C;
  /** true when the token has no fixed spelling, so the key is a class name. */
  variable?: true;
  /**
   * A cap on how many times this spelling can repeat. A longest-match table
   * cannot state it. `$$$$$` matches `$$$$` and then `$`, which gives two valid
   * tokens and no error. The lexer instead says
   *   "Up to 4 levels of context reference are supported ('$.', '$$', '$$$', '$$$$')"
   */
  maxRun?: { limit: number; tooLong: string };
  /**
   * When one spelling maps to more than one token type, this cell says which type
   * the lexer takes, and from what. A `/` is division after a value, and a regex in
   * all other places. Thus the PRECEDING token decides, not this one.
   */
  chooseBy?: { afterValue: TokenName; otherwise: TokenName };
  /**
   * The lexeme AFTER this one is a name, even when it spells a reserved word.
   *
   * `$.typeof`, `x.delete`, `$in(…)` and `a?.null` are all legal JavaScript, and
   * a MongoDB field can have any name. So after these four the lexer emits
   * `Ident` and never promotes. The introducer holds this cell, because the
   * introducer changes the reading. The same word one token later is the
   * operator again (`$.typeof in xs`).
   */
  introducesName?: true;
  /** This opener adds 1 to the depth counter that a template interpolation reads. */
  tracksDepth?: true;
  /**
   * When the depth of this closer agrees with an open template interpolation, it
   * ends the interpolation and emits no token at all. It is the one closer that
   * makes nothing.
   */
  resumesTemplateAtDepth?: true;
};

export type TokenEntry<C extends string = never> = TokenSpec<C> & { kind: "token" };

// `C` defaults to `never`, never to its constraint. If it did not, a row with no
// `closes` would resolve `C` to `string` and flood the union of the audit. The
// check would then pass, but test nothing.
const token = <const C extends string = never>(e: TokenSpec<C>): TokenEntry<C> => ({ ...e, kind: "token" });

export const TOKENS = {
  "(": token({ doc: "The `(` token.", token: "LParen", role: "open" }),
  ")": token({ doc: "The `)` token.", token: "RParen", role: "close", closes: "(" }),
  "[": token({ doc: "The `[` token.", token: "LBracket", role: "open" }),
  "]": token({ doc: "The `]` token.", token: "RBracket", role: "close", closes: "[" }),
  "{": token({
    doc: "The `{` token.",
    token: "LBrace",
    role: "open",
    // It counts depth, so a template interpolation can tell its OWN closing brace
    // from the brace of a nested object. `${ {a: 1} }` has two braces, and only
    // the outer one ends the interpolation.
    tracksDepth: true,
  }),
  "}": token({
    doc: "The `}` token.",
    token: "RBrace",
    role: "close",
    closes: "{",
    // When its depth agrees with an open interpolation, this brace emits NO token
    // at all. It ends the interpolation, and template text continues. It is the
    // one closer whose row makes nothing.
    resumesTemplateAtDepth: true,
  }),
  ",": token({ doc: "The `,` token.", token: "Comma", role: "separator" }),
  ";": token({ doc: "The `;` token.", token: "Semi", role: "separator" }),
  ":": token({ doc: "The `:` token.", token: "Colon", role: "separator" }),
  ".": token({ doc: "The `.` token.", token: "Dot", role: "binder", introducesName: true }),
  "?.": token({ doc: "The `?.` token.", token: "QuestDot", role: "binder", introducesName: true }),
  "$.": token({ doc: "The `$.` token.", token: "DollarDot", role: "reference", introducesName: true }),
  $: token({ doc: "The `$` token.", token: "Dollar", role: "reference", introducesName: true }),
  $$: token({ doc: "The `$$` token.", token: "DoubleDollar", role: "reference" }),
  $$$: token({ doc: "The `$$$` token.", token: "TripleDollar", role: "reference" }),
  $$$$: token({
    doc: "The `$$$$` token.",
    token: "QuadDollar",
    role: "reference",
    maxRun: { limit: 4, tooLong: "Up to 4 levels of context reference are supported ('$.', '$$', '$$$', '$$$$')" },
  }),
  "...": token({ doc: "The `...` token.", token: "Spread", role: "spread" }),
  "+": token({ doc: "The `+` token.", token: "Plus", role: "operator" }),
  "-": token({ doc: "The `-` token.", token: "Minus", role: "operator" }),
  "*": token({ doc: "The `*` token.", token: "Star", role: "operator" }),
  "**": token({ doc: "The `**` token.", token: "StarStar", role: "operator" }),
  "/": token({
    doc: "Division, or the start of a regex literal. The lexer chooses on the PRECEDING token: `a / b` is division, a leading `/` begins a regex.",
    token: ["Slash", "RegexLiteral"],
    role: "operator",
    chooseBy: { afterValue: "Slash", otherwise: "RegexLiteral" },
  }),
  "%": token({ doc: "The `%` token.", token: "Percent", role: "operator" }),
  "++": token({ doc: "The `++` token.", token: "PlusPlus", role: "operator" }),
  "--": token({ doc: "The `--` token.", token: "MinusMinus", role: "operator" }),
  "=": token({ doc: "The `=` token.", token: "Eq", role: "operator" }),
  "+=": token({ doc: "The `+=` token.", token: "PlusEq", role: "operator" }),
  "-=": token({ doc: "The `-=` token.", token: "MinusEq", role: "operator" }),
  "*=": token({ doc: "The `*=` token.", token: "StarEq", role: "operator" }),
  "/=": token({
    doc: "Divide-and-assign, or a regex beginning with `=`. Same preceding-token rule as `/`.",
    token: ["SlashEq", "RegexLiteral"],
    role: "operator",
    chooseBy: { afterValue: "SlashEq", otherwise: "RegexLiteral" },
  }),
  "==": token({ doc: "The `==` token.", token: "EqEq", role: "operator" }),
  "===": token({ doc: "The `===` token.", token: "EqEqEq", role: "operator" }),
  "!=": token({ doc: "The `!=` token.", token: "BangEq", role: "operator" }),
  "!==": token({ doc: "The `!==` token.", token: "BangEqEq", role: "operator" }),
  ">": token({ doc: "The `>` token.", token: "Gt", role: "operator" }),
  ">=": token({ doc: "The `>=` token.", token: "GtEq", role: "operator" }),
  "<": token({ doc: "The `<` token.", token: "Lt", role: "operator" }),
  "<=": token({ doc: "The `<=` token.", token: "LtEq", role: "operator" }),
  "&&": token({ doc: "The `&&` token.", token: "AmpAmp", role: "operator" }),
  "||": token({ doc: "The `||` token.", token: "PipePipe", role: "operator" }),
  "!": token({ doc: "The `!` token.", token: "Bang", role: "operator" }),
  "&": token({ doc: "The `&` token.", token: "Amp", role: "operator" }),
  "|": token({ doc: "The `|` token.", token: "Pipe", role: "operator" }),
  "^": token({ doc: "The `^` token.", token: "Caret", role: "operator" }),
  "~": token({ doc: "The `~` token.", token: "Tilde", role: "operator" }),
  "??": token({ doc: "The `??` token.", token: "QuestQuest", role: "operator" }),
  "?": token({ doc: "The `?` token.", token: "Quest", role: "operator" }),
  "=>": token({ doc: "The `=>` token.", token: "Arrow", role: "arrow" }),
  number: token({
    doc: "A numeric literal. `0x` followed by 24 hex digits is re-read as an ObjectId — see productions.ts.",
    token: "Number",
    role: "literal",
    variable: true,
  }),
  bigint: token({ doc: "A BigInt literal.", token: "BigInt", role: "literal", variable: true }),
  string: token({ doc: "A quoted string literal.", token: "String", role: "literal", variable: true }),
  regex: token({ doc: "A regular-expression literal.", token: "RegexLiteral", role: "literal", variable: true }),
  "`": token({
    doc: "Opens and closes a template literal. The lexer classifies it by position — the opening backtick is TemplateStart, the closing one TemplateEnd — so it pairs with itself rather than with a separate closer.",
    token: ["TemplateStart", "TemplateEnd"],
    role: "delimiter",
  }),
  templateText: token({
    doc: "The literal text between a template literal's delimiters. Free text, including the empty string.",
    token: "TemplateChars",
    role: "literal",
    variable: true,
  }),
  "${": token({
    doc: "Opens an interpolation inside a template literal. Nothing closes it: the `}` that ends the interpolation emits no token at all, so this is the one opener with no matching close row.",
    token: "TemplateExprStart",
    role: "open",
  }),
  identifier: token({
    doc: "A bare name. What it means is resolved in names.ts.",
    token: "Ident",
    role: "name",
    variable: true,
  }),
  endOfInput: token({
    doc: "The end of the source. The lexer appends it so the parser can report 'Expected X but got end of input' rather than reading past the last token.",
    token: "EOF",
    role: "delimiter",
    variable: true,
  }),
};

export type TokenKey = keyof typeof TOKENS;

/**
 * The token types after which a `/` is DIVISION rather than the start of a regex.
 *
 * `chooseBy` on the `/` row states the rule: the preceding token decides. It does
 * not say which tokens count as a value, and that list is the other half of the
 * same fact. This is one declaration, not a flag per row, because the backtick row
 * covers two token types and only `TemplateEnd` ends a value.
 *
 *   `$.a / 2`      → Slash        the preceding token is a field reference
 *   `/ab/.test`    → RegexLiteral nothing precedes it
 *   `$.typeof / 2` → Slash        `typeof` after `$.` is an `Ident` (see
 *                                 `introducesName`), and an Ident ends a value
 *
 * The list holds no keyword token. A reserved word in the role of an OPERATOR
 * never ends a value, and one in the role of a NAME is already an `Ident`.
 */
export const ENDS_A_VALUE: readonly TokenName[] = [
  "Number",
  "BigInt",
  "String",
  "True",
  "False",
  "Null",
  "Undefined",
  "Ident",
  "RParen",
  "RBracket",
  "TemplateEnd",
];

// ── audit: every `closes` names a key of this same table ─────────────────────

type FieldOf<K extends TokenKey, F extends string> = F extends keyof (typeof TOKENS)[K]
  ? NonNullable<(typeof TOKENS)[K][F]>
  : never;

type Mentioned<F extends string> = {
  [K in TokenKey]: [FieldOf<K, F>] extends [never]
    ? never
    : FieldOf<K, F> extends readonly (infer V)[]
      ? V
      : FieldOf<K, F>;
}[TokenKey];

type DanglingCloses = Exclude<Mentioned<"closes">, TokenKey>;
const _closesResolves: [DanglingCloses] extends [never] ? true : DanglingCloses = true;
void _closesResolves;
