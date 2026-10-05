/**
 * EN-200 to EN-204. Where the published versions of the note template live.
 */

import type { NoteSection, NoteTemplate } from './note-template';

/** EN-200. The newest version of one template, for the administration list. */
export interface NoteTemplateSummary extends NoteTemplate {
  specialtyName: string | null;
  publishedAt: Date;
  publishedByName: string;
}

export interface PublishNoteTemplate {
  formCode: string;
  specialtyId: string | null;
  sections: readonly NoteSection[];
  publishedById: string;
  publishedAt: Date;
}

export interface NoteTemplateRepository {
  /** EN-203. The newest version for that specialty (`null` = the clinic's). */
  latest(
    formCode: string,
    specialtyId: string | null,
  ): Promise<NoteTemplate | null>;

  /** EN-204. The exact version a note was opened with. */
  findById(id: string): Promise<NoteTemplate | null>;

  /** EN-200. The newest version of every template of the form. */
  listLatest(formCode: string): Promise<NoteTemplateSummary[]>;

  /**
   * EN-200. Inserts the next version. The number is the highest plus one,
   * taken under a lock so two publications cannot both take it —
   * `clinical_note_template_version_unique` is the guarantee behind it.
   */
  publish(input: PublishNoteTemplate): Promise<NoteTemplateSummary>;

  /**
   * EN-203. The specialty the attention is of: its appointment's service
   * type, or without an appointment the practitioner's primary specialty.
   */
  specialtyOfEncounter(encounterId: string): Promise<string | null>;

  /** Whether the specialty exists, so a publication can name a bad one. */
  specialtyExists(specialtyId: string): Promise<boolean>;
}

export const NOTE_TEMPLATE_REPOSITORY = Symbol('NoteTemplateRepository');
