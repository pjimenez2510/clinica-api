import type { EncounterQuery } from './encounter.repository';
import type { ScreeningAnswer, ScreeningRecord } from './violence-screening';

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
  /** Within the caller's scope; `null` when not answered yet. */
  find(query: EncounterQuery): Promise<ScreeningRecord | null>;

  /**
   * Answers or corrects it, under the attention's lock and only while the
   * attention accepts new content (EN-130).
   */
  save(
    query: EncounterQuery,
    answer: ScreeningAnswer,
    author: { practitionerId: string; at: Date },
  ): Promise<ScreeningSave>;
}

export const VIOLENCE_SCREENING_REPOSITORY = Symbol(
  'ViolenceScreeningRepository',
);
