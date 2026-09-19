// This is what the lexer produces. It gives one record to each token. The record
// keeps the source span, so a later phase can point to the exact characters.

import type { TokenName } from "../../registry/vocabulary.ts";

export type Token = {
  type: TokenName;
  /** The source text of this token. For a literal, this is the raw spelling. */
  text: string;
  /** The offset of the first character. */
  pos: number;
  /** The offset just after the last character. `src.slice(pos, end)` gives the token text. */
  end: number;
  /** The flags of a regex literal, exactly as written. This field is absent on every other token. */
  flags?: string;
};

export const token = (type: TokenName, text: string, pos: number): Token => ({
  type,
  text,
  pos,
  end: pos + text.length,
});

/**
 * A token whose text differs from its source span. A string literal's `text`
 * field holds the decoded value, so the caller must give the span.
 */
export const spanned = (type: TokenName, text: string, pos: number, end: number): Token => ({ type, text, pos, end });
