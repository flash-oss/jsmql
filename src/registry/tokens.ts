import type { TokenName } from "./vocabulary.ts";

export type TokenSpec<C extends string = never> = {
  doc: string;
  token: TokenName | readonly TokenName[];
  role:
    | "open"
    | "close"
    | "delimiter"
    | "separator"
    | "binder"
    | "arrow"
    | "spread"
    | "operator"
    | "literal"
    | "name"
    | "reference";
  closes?: C;
  variable?: true;
  maxRun?: { limit: number; tooLong: string };
  chooseBy?: { afterValue: TokenName; otherwise: TokenName };
  introducesName?: true;
  tracksDepth?: true;
  resumesTemplateAtDepth?: true;
};

export type TokenEntry<C extends string = never> = TokenSpec<C> & { kind: "token" };

const token = <const C extends string = never>(e: TokenSpec<C>): TokenEntry<C> => ({ ...e, kind: "token" });

export const TOKENS = {
  "(": token({ doc: "The `(` token.", token: "LParen", role: "open" }),
  ")": token({ doc: "The `)` token.", token: "RParen", role: "close", closes: "(" }),
  "[": token({ doc: "The `[` token.", token: "LBracket", role: "open" }),
  "]": token({ doc: "The `]` token.", token: "RBracket", role: "close", closes: "[" }),
  "{": token({ doc: "The `{` token.", token: "LBrace", role: "open", tracksDepth: true }),
  "}": token({ doc: "The `}` token.", token: "RBrace", role: "close", closes: "{", resumesTemplateAtDepth: true }),
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
    doc: "Opens and closes a template literal. The lexer classifies it by position — the opening backtick is TemplateStart, the closing one TemplateEnd — so it pairs with itself, not with a separate closer.",
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
    doc: "The end of the source. The lexer appends it so the parser can report 'Expected X but got end of input', and does not read past the last token.",
    token: "EOF",
    role: "delimiter",
    variable: true,
  }),
};

export type TokenKey = keyof typeof TOKENS;

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
