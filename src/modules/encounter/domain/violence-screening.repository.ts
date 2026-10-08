import type { EncounterQuery } from './encounter.repository';
import type { ScreeningAnswer, ScreeningRecord } from './violence-screening';

/**
 * Who is asking, for the trail row the adapter writes INSIDE its own
 * transaction (EN-075). Not the shared recorder: that one logs and carries on
 * when the trail cannot be written, and this read must not happen without it.
 */
export interface ScreeningTrail {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/** The outcome of a save, so the trail can tell a first answer from a correction. */
export interface ScreeningSave {
  record: ScreeningRecord;
  outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED';
}

/**
 * Block F of one attention (EN-070 to EN-078).
 *
 * ⚠️ THE ONLY PORT THAT READS `violence_screening`. Every other read of the
 * attention goes without it, and an integration test asserts so on each
 * response (EN-073). A second reader is a second door.
 */
export interface ViolenceScreeningRepository {
  /**
   * EN-072, EN-075. Within the caller's scope; `null` when not answered yet.
   * An answer is returned only together with its `READ` row in the trail, in
   * one transaction: if the row cannot be written, nothing is disclosed.
   */
  readWithTrail(
    query: EncounterQuery,
    trail: ScreeningTrail,
  ): Promise<ScreeningRecord | null>;

  /**
   * Answers or corrects it, under the attention's lock and only while the
   * attention accepts new content (EN-130), with its trail row in the same
   * transaction: `CREATE`, `UPDATE`, or `READ` when nothing changed — the
   * answer it returns discloses what was there.
   */
  save(
    query: EncounterQuery,
    answer: ScreeningAnswer,
    author: { practitionerId: string; at: Date },
    trail: ScreeningTrail,
  ): Promise<ScreeningSave>;
}

export const VIOLENCE_SCREENING_REPOSITORY = Symbol(
  'ViolenceScreeningRepository',
);
