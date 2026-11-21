export const OBJECTID_MIN_HEX = "4a0000000000000000000000";

export function objectIdTypo(hex: string): string | null {
  const lower = hex.toLowerCase();
  if (lower >= OBJECTID_MIN_HEX) return null;
  const when = new Date(parseInt(lower.slice(0, 8), 16) * 1000).toISOString().slice(0, 10);
  return `ObjectId ${lower} looks like a typo: its embedded timestamp decodes to ${when}, older than the smallest valid ObjectId ${OBJECTID_MIN_HEX} (2009-05-05, around MongoDB's first release).`;
}
