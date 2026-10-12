import { PreconditionFailedError } from './domain-error';

/**
 * EN-281, EN-282, PR-121, ORD-181. The draft was written, signed or issued
 * over a revision that is no longer the current one: another tab — or the
 * assistant, or `psql` — changed it after this caller read it.
 *
 * IN `shared`, like `PatientMergedError`: the note, the receta and the order
 * all refuse with it, no module imports another, and a code is declared by
 * one class only. One sentence for the three, because the screen says the
 * same thing in the three places.
 */
export class RecordChangedError extends PreconditionFailedError {
  readonly code = 'RECORD_CHANGED';
  override readonly userTitle = 'Otra persona cambió esto; recargue';

  constructor() {
    super('The draft changed after it was read');
  }
}

/**
 * The revision the writer read against the one stored. Called inside the
 * transaction, on the row as it is there — never on a read from before it.
 */
export function assertRevision(stored: number, read: number): void {
  if (stored !== read) throw new RecordChangedError();
}
