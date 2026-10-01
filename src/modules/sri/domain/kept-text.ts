/**
 * SRI-059, SRI-069. How a text kept from the SRI says it was cut: never
 * silently, never in half a character, always with how much was left out.
 *
 * A «carácter» is a Unicode code point, as PostgreSQL's `char_length` and the
 * `electronic_voucher_attempt_response_is_capped` CHECK count them, so the
 * mark written when keeping (SRI-059) and the one written when summarising in
 * the database (SRI-069) count the same thing.
 */
export const cutMark = (leftOut: number) =>
  `… [cortado: ${leftOut} caracteres más]`;

/** Code points in `text`: a surrogate pair is one character. */
function characters(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0xdc00 || code > 0xdfff) count++;
  }
  return count;
}

/**
 * `text` up to `limit` UTF-16 units — never more characters than that, so the
 * CHECK holds — and the mark if anything was left out.
 */
export function capped(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const code = text.charCodeAt(limit - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
  return `${text.slice(0, cut)}${cutMark(characters(text.slice(cut)))}`;
}

/**
 * SRI-069, D-107. The head the database cut (`left(…, n)`) and how many
 * characters it left out (`char_length(…) - n`), as the monitor shows it.
 */
export function summaryOf(head: string | null, leftOut: number): string | null {
  if (head === null) return null;
  return leftOut > 0 ? `${head}${cutMark(leftOut)}` : head;
}
