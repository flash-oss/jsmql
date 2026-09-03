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
//
// Every reserved word is also a legal NAME: JavaScript allows any IdentifierName
// after `.` and before `:` in an object literal, and a MongoDB field may be named
// anything. So `$.delete`, `{ null: 1 }` and `$in(…)` all compile — the lexer
// reads the word as an `Ident` after an introducer (see `introducesName` in
// tokens.ts) and the parser accepts any keyword token where a key is expected.
// The one place a reserved word is NOT a name is the shorthand `{ in }`, which
// JavaScript refuses; only `undefined` is an identifier there.

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
};

export type KeywordEntry = KeywordSpec & { kind: "keyword" };

const keyword = (e: KeywordSpec): KeywordEntry => ({ ...e, kind: "keyword" });

export const KEYWORDS = {
  return: keyword({ doc: "Yields a block's value.", token: "Return" }),

  const: keyword({ doc: "Binds a name that cannot be reassigned.", token: "Const" }),

  let: keyword({ doc: "Binds a name that can be reassigned.", token: "Let" }),

  in: keyword({ doc: "Tests membership of a value in an array.", token: "In" }),

  new: keyword({ doc: "Marks a constructor call.", token: "New" }),

  typeof: keyword({ doc: "Gives the type name of a value.", token: "Typeof" }),

  delete: keyword({ doc: "Removes a field from the document.", token: "Delete" }),

  true: keyword({ doc: "The boolean true.", token: "True" }),

  false: keyword({ doc: "The boolean false.", token: "False" }),

  null: keyword({ doc: "An explicit null. Distinct from a missing field.", token: "Null" }),

  undefined: keyword({ doc: "Absence. Compared with `===` it becomes an existence test.", token: "Undefined" }),
};

export type KeywordKey = keyof typeof KEYWORDS;
