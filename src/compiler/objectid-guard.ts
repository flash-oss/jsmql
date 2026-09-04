// An ObjectId the SOURCE spells — `0x…`, `ObjectId("…")` — must be one that
// could exist. The first 4 bytes of an ObjectId are a Unix timestamp in seconds,
// and MongoDB's first public release was 2009: an id whose timestamp is older
// cannot be real and is a typo — a dropped digit, an all-zeros placeholder, a
// sequential test value. A lowercase 24-hex string compares as its 96-bit value,
// so a plain string `<` against the floor is exact. One function, read by the
// parser for the literal and by the emit phase for the call form.

export const OBJECTID_MIN_HEX = "4a0000000000000000000000";

/** The reason `hex` cannot be a real ObjectId, or null when it can. */
export function objectIdTypo(hex: string): string | null {
  const lower = hex.toLowerCase();
  if (lower >= OBJECTID_MIN_HEX) return null;
  const when = new Date(parseInt(lower.slice(0, 8), 16) * 1000).toISOString().slice(0, 10);
  return `ObjectId ${lower} looks like a typo: its embedded timestamp decodes to ${when}, older than the smallest valid ObjectId ${OBJECTID_MIN_HEX} (2009-05-05, around MongoDB's first release).`;
}
