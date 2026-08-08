import { describe, expect, it } from 'vitest';

import { formatMrn, isMrn, MRN_PREFIX } from './mrn';

describe('the medical record number', () => {
  it('pads to a fixed width so every number reads the same', () => {
    // Fixed width is not cosmetic: these are read aloud over the phone and off
    // a wristband, and a ragged column is where a digit gets dropped.
    expect(formatMrn(1)).toBe('HC0000000001');
    expect(formatMrn(482)).toBe('HC0000000482');
    expect(formatMrn(9_999_999_999)).toBe('HC9999999999');
  });

  it('every number it produces is one it recognises', () => {
    for (const sequence of [1, 7, 42, 1_000, 123_456_789]) {
      expect(isMrn(formatMrn(sequence))).toBe(true);
    }
  });

  it('refuses anything that is not exactly the format', () => {
    expect(isMrn('HC1')).toBe(false); // not padded
    expect(isMrn('hc0000000001')).toBe(false); // lower case
    expect(isMrn('HC00000000012')).toBe(false); // one digit too many
    expect(isMrn('XX0000000001')).toBe(false); // wrong prefix
    expect(isMrn('0000000001')).toBe(false); // no prefix
  });

  it('refuses a sequence that cannot be a real one', () => {
    // A zero or a negative means the sequence was misread, and emitting
    // `HC0000000000` would create a chart nobody can ever quote back.
    expect(() => formatMrn(0)).toThrow(RangeError);
    expect(() => formatMrn(-1)).toThrow(RangeError);
    expect(() => formatMrn(1.5)).toThrow(RangeError);
  });

  it('refuses to silently truncate once the width runs out', () => {
    // Ten billion charts means the sequence is wrong, not that the clinic
    // grew. Truncating would reuse a number already printed on a document.
    expect(() => formatMrn(10_000_000_000)).toThrow(RangeError);
  });

  it('keeps the prefix as a single source', () => {
    expect(formatMrn(1).startsWith(MRN_PREFIX)).toBe(true);
  });
});
