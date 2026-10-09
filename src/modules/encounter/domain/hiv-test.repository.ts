import type { EncounterQuery } from './encounter.repository';
import type { HivTestAnswer, HivTestRecord } from './hiv-test';

/**
 * Who is asking, for the trail row the adapter writes INSIDE its own
 * transaction (EN-095, as EN-075). Not the shared recorder: that one logs and
 * carries on when the trail cannot be written, and this read must not happen
 * without it.
 */
export interface HivTestTrail {
  userId: string;
  ip?: string;
  userAgent?: string;
}

export interface HivTestSave {
  record: HivTestRecord;
  outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED';
}

/**
 * Block J of one attention (EN-094, EN-095).
 *
 * ⚠️ THE ONLY PORT THAT READS `encounter_hiv_test`. Every other read of the
 * attention goes without it, and an integration test asserts so on each
 * response (EN-098). A second reader is a second door.
 */
export interface HivTestRepository {
  /**
   * Within the caller's scope; `null` when none was recorded. A record is
   * returned only together with its `READ` row in the trail, in one
   * transaction: if the row cannot be written, nothing is disclosed.
   */
  readWithTrail(
    query: EncounterQuery,
    trail: HivTestTrail,
  ): Promise<HivTestRecord | null>;

  /**
   * Records or corrects it under the attention's lock, only while it admits
   * new content (EN-249), with its trail row in the same transaction:
   * `CREATE`, `UPDATE`, or `READ` when nothing changed.
   */
  save(
    query: EncounterQuery,
    answer: HivTestAnswer,
    authorId: string,
    trail: HivTestTrail,
  ): Promise<HivTestSave>;
}

export const HIV_TEST_REPOSITORY = Symbol('HivTestRepository');
