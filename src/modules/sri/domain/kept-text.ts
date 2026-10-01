/**
 * SRI-059, SRI-069. How a text kept from the SRI says it was cut: never
 * silently, never in half a character, always with how much was left out.
 */
export const cutMark = (leftOut: number) =>
  `… [cortado: ${leftOut} caracteres más]`;

/** `text` up to `limit` characters, and the mark if anything was left out. */
export function capped(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const code = text.charCodeAt(limit - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
  return `${text.slice(0, cut)}${cutMark(text.length - cut)}`;
}
