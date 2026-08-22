// REGISTRY 2 of 4 — the reserved words. LEXICAL phase.
//
// Keyed by the word. A row exists here only if the LEXER promotes that word to
// its own token type rather than leaving it an identifier. That test is what
// makes the boundary with tokens.ts sharp, and it has a surprising answer:
// `function` is NOT reserved — it lexes as an identifier and the parser
// recognises it, so it lives in productions.ts.
//
// Like tokens.ts, this file holds NO MQL. What a keyword MEANS is the production
// it heads, and that lives in productions.ts.

import type { TokenName } from "./vocabulary.ts";

// NO import of productions.ts, deliberately. A keyword pointing at the rules it
// heads, while those rules point back at the keyword they consume, is a type
// cycle TypeScript refuses — and it is the same fact written in two files that
// can disagree. The edge is kept in ONE direction: a rule lists its `tokens`,
// so "which rule does `return` head?" is a search of productions.ts, and there
// is nothing here for it to contradict.

export type KeywordSpec = {
  doc: string;
  /** The token type the lexer promotes this word to. */
  token: TokenName;
  /**
   * Whether the word still works as a field name after `$.`. MEASURED, not
   * assumed, and the answers do not follow a rule:
   *
   *   $.return  $.typeof  $.let  $.const  $.in  $.new   → all compile
   *   $.delete  $.true    $.false  $.null  $.undefined  → all rejected
   *
   * `typeof` works and `delete` does not, which no principle explains — a
   * MongoDB field may be named anything, so the six that work are right and
   * `$.delete` is a bug. Recorded here as fact so the inconsistency is visible
   * rather than discovered.
   */
  usableAsFieldName: boolean;
};

export type KeywordEntry = KeywordSpec & { kind: "keyword" };

const keyword = (e: KeywordSpec): KeywordEntry => ({ ...e, kind: "keyword" });

export const KEYWORDS = {
  return: keyword({ doc: "Yields a block's value.", token: "Return", usableAsFieldName: true }),

  const: keyword({ doc: "Binds a name that cannot be reassigned.", token: "Const", usableAsFieldName: true }),

  let: keyword({ doc: "Binds a name that can be reassigned.", token: "Let", usableAsFieldName: true }),

  in: keyword({ doc: "Tests membership of a value in an array.", token: "In", usableAsFieldName: true }),

  new: keyword({ doc: "Marks a constructor call.", token: "New", usableAsFieldName: true }),

  typeof: keyword({ doc: "Gives the type name of a value.", token: "Typeof", usableAsFieldName: true }),

  delete: keyword({
    doc: "Removes a field from the document.",
    token: "Delete",
    // The odd one out among the six non-literal keywords. See usableAsFieldName.
    usableAsFieldName: false,
  }),

  true: keyword({ doc: "The boolean true.", token: "True", usableAsFieldName: false }),

  false: keyword({ doc: "The boolean false.", token: "False", usableAsFieldName: false }),

  null: keyword({ doc: "An explicit null. Distinct from a missing field.", token: "Null", usableAsFieldName: false }),

  undefined: keyword({
    doc: "Absence. Compared with `===` it becomes an existence test.",
    token: "Undefined",
    usableAsFieldName: false,
  }),
};

export type KeywordKey = keyof typeof KEYWORDS;
