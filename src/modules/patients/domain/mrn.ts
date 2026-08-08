/**
 * The medical record number: the one identifier that never changes.
 *
 * WHY NOT THE CEDULA. A patient may arrive with no document at all — a
 * newborn, an undocumented migrant, an unconscious trauma case — and one who
 * arrives with a passport may hold a cedula two years later. Anchoring the
 * chart to a document means the day the document changes, either the chart
 * splits in two or its history is rewritten. Both are medico-legal failures.
 *
 * FORMAT: `HC` + 10 digits, zero padded. Twelve characters, matching the
 * column. Humans quote it out loud and read it off a wristband, so it is
 * printed in a monospaced face on the interface (`.identifier`).
 *
 * NOT random and NOT a UUID: staff read these to each other over the phone.
 * Sequential is also deliberate — a gap is visible, and two charts created the
 * same morning sort next to each other.
 */
export const MRN_PREFIX = 'HC';
const MRN_DIGITS = 10;

export function formatMrn(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(
      `MRN sequence must be a positive integer: ${sequence}`,
    );
  }
  if (sequence >= 10 ** MRN_DIGITS) {
    // Ten digits is roughly ten billion charts. Hitting this means the
    // sequence is wrong, not that the clinic grew.
    throw new RangeError(`MRN sequence out of range: ${sequence}`);
  }
  return `${MRN_PREFIX}${String(sequence).padStart(MRN_DIGITS, '0')}`;
}

/** Accepts what `formatMrn` produces, and nothing else. */
export function isMrn(value: string): boolean {
  return new RegExp(`^${MRN_PREFIX}\\d{${MRN_DIGITS}}$`).test(value);
}
