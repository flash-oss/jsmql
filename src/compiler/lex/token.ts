import type { TokenName } from "../../registry/vocabulary.ts";

export type Token = { type: TokenName; text: string; pos: number; end: number; flags?: string };

export const token = (type: TokenName, text: string, pos: number): Token => ({
  type,
  text,
  pos,
  end: pos + text.length,
});

export const spanned = (type: TokenName, text: string, pos: number, end: number): Token => ({ type, text, pos, end });
