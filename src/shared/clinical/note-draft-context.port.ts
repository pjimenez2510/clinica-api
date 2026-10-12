/**
 * AS-086, AS-088, AS-092, AS-094. What the assistant reads to draft the
 * consultation note: the note in draft with the template it was opened with
 * (EN-204), and the vocabulary the lexicon corrects with.
 *
 * A SHARED PORT for the reason `coding-context.port.ts` gives: the note is
 * `encounter`'s, and no module imports another (ADR-011).
 *
 * ⚠️ IT READS AND IT NEVER WRITES. The draft reaches the note only through
 * the note's own route, saved by the physician with `If-Match` (EN-281).
 */

/** A section of the note's template, as the template declares it. */
export interface DraftNoteSection {
  key: string;
  title: string;
  help: string;
  kind: 'TEXT' | 'CHOICE';
}

/** The 002 of an attention while it is a draft. */
export interface DraftNote {
  id: string;
  /** In the template's order. */
  sections: DraftNoteSection[];
}

/**
 * AS-092. The words the lexicon corrects TOWARDS (the CNMB's active
 * principles) and those it never touches (the CIE-10 and the clinic's notes).
 */
export interface ClinicalVocabulary {
  principles: string[];
  protectedWords: string[];
}

export interface NoteDraftContextReader {
  /** The attention's 002 in `DRAFT`, or null when none is open. */
  consultationDraft(encounterId: string): Promise<DraftNote | null>;
  vocabulary(): Promise<ClinicalVocabulary>;
}

export const NOTE_DRAFT_CONTEXT_READER = Symbol('NOTE_DRAFT_CONTEXT_READER');
