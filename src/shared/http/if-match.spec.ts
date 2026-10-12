import { describe, expect, it } from 'vitest';

import { RecordChangedError } from '../domain/errors/record-changed.error';
import {
  PreconditionFailedError,
  PreconditionRequiredError,
} from '../domain/errors/domain-error';

import { RevisionRequiredError, revisionFrom } from './if-match';

describe('If-Match (EN-281, PR-121, ORD-181)', () => {
  it('EN-281 reads the revision of a strong entity tag', () => {
    expect(revisionFrom('"1"')).toBe(1);
    expect(revisionFrom('"42"')).toBe(42);
    expect(revisionFrom(' "7" ')).toBe(7);
  });

  it('EN-281 refuses a missing or malformed header with REVISION_REQUIRED, never as a match', () => {
    // A weak tag, «any» and a bare number are not what the screen sends:
    // `*` in particular would let a client write without having read.
    for (const header of [
      undefined,
      '',
      '*',
      'W/"3"',
      '3',
      '"0"',
      '"-1"',
      '"1.5"',
      '"abc"',
      '"1", "2"',
      `"${'9'.repeat(12)}"`,
    ]) {
      expect(() => revisionFrom(header)).toThrow(RevisionRequiredError);
    }
  });

  it('EN-281 REVISION_REQUIRED is a 428 that says what to do', () => {
    const error = new RevisionRequiredError();
    expect(error).toBeInstanceOf(PreconditionRequiredError);
    expect(error.code).toBe('REVISION_REQUIRED');
    expect(error.userTitle).toBe('Recargue la página y vuelva a intentarlo');
  });

  it('EN-281 RECORD_CHANGED is a 412 with the sentence the screen shows', () => {
    const error = new RecordChangedError();
    expect(error).toBeInstanceOf(PreconditionFailedError);
    expect(error.code).toBe('RECORD_CHANGED');
    expect(error.userTitle).toBe(
      'Esto cambió en otra pestaña o lo cambió otra persona. Recargue para ver lo guardado',
    );
  });
});
