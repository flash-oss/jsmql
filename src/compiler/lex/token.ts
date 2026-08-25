// What the lexer produces. One record per token, with the source span so every
// later phase can point a caret at the exact characters.

import type { TokenName } from "../../registry/vocabulary.ts";

export type Token = {
  type: TokenName;
  /** The source text this token covers. For a literal, the raw spelling. */
  text: string;
  /** Offset of the first character. */
  pos: number;
  /** Offset just past the last character, so `src.slice(pos, end)` is the token. */
  end: number;
  /** A regex literal's flags, exactly as written. Absent on every other token. */
  flags?: string;
};

export const token = (type: TokenName, text: string, pos: number): Token => ({
  type,
  text,
  pos,
  end: pos + text.length,
});

/**
 * A token whose text is not its source span — a string literal's `text` is the
 * decoded value, so the span has to be given.
 */
export const spanned = (type: TokenName, text: string, pos: number, end: number): Token => ({ type, text, pos, end });
