/**
 * EN-052. Where the CEO-D / CPO-D of an attention lives.
 *
 * A PORT OF ITS OWN and not more methods on the attention's: the index has a
 * reason to change the attention does not — the instructivo's bands, and
 * which specialties count (D-160) — and its own versioned table.
 */

import type { DentalIndexCounts, DentalIndexReading } from './dental-index';
import type { EncounterQuery } from './encounter.repository';

/**
 * EN-052. What the save did, decided under the attention's lock: two first
 * saves at once are a record and a correction, never a duplicate key; the
 * same counts again are no write at all.
 */
export interface DentalIndexSave {
  reading: DentalIndexReading;
  outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED';
}

export interface DentalIndexRepository {
  /**
   * EN-203, EN-052. The code of the attention's specialty, by the rule the
   * note template uses: its appointment's consultation, else the
   * practitioner's primary specialty. `null` when it has none.
   */
  specialtyCodeOf(encounterId: string): Promise<string | null>;

  /** EN-052. The index of one attention in scope, or `null` if none was recorded. */
  find(query: EncounterQuery): Promise<DentalIndexReading | null>;

  /**
   * EN-052, EN-210. Records or corrects the counts under the attention's
   * lock, while it admits new clinical content (EN-130); a correction is
   * stamped, so the previous index goes to `record_version`. The frozen age
   * and the counts of the other index are refused by the database
   * (`encounter_dental_index_applies`).
   */
  save(
    query: EncounterQuery,
    counts: DentalIndexCounts,
    authorId: string,
  ): Promise<DentalIndexSave>;
}

/** Injection token. The application never names the adapter. */
export const DENTAL_INDEX_REPOSITORY = Symbol('DentalIndexRepository');
