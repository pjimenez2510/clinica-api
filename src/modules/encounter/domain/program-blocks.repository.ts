/**
 * EN-090 to EN-093, EN-249. Where blocks G, H and I of an attention live.
 *
 * A PORT OF ITS OWN and not more methods on the attention's: the blocks have
 * reasons to change the attention does not — the instructivo's catalogues and
 * its populations — and tables of their own, each versioned. Block J (HIV) is
 * NOT here: it has its own port and door (`hiv-test.repository.ts`, EN-095).
 */

import type { EncounterQuery } from './encounter.repository';
import type {
  NutritionAnswer,
  NutritionRecord,
  ObstetricAnswer,
  ObstetricRecord,
  PrescribedMedicine,
  SupplementAnswer,
  SupplementRecord,
  VaccinationAnswer,
  VaccinationRecord,
} from './program-blocks';

/**
 * What the save did, decided under the attention's lock: two first saves at
 * once are a record and a correction, never a duplicate key; the same answer
 * again is no write at all.
 */
export interface ProgramBlockSave<R> {
  record: R;
  outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED';
}

/** One vaccine of the `VACCINE` catalogue in force on the clinical date. */
export interface VaccineOption {
  /** The column of the RDACAA form. */
  code: string;
  display: string;
}

export interface ProgramBlocksRepository {
  /**
   * EN-090. The chart's PREGNANT record in force on the attention's clinical
   * date — the database's own `encounter_is_pregnant`, the rule of EN-063.
   */
  isPregnant(encounterId: string): Promise<boolean>;

  /** EN-093, EN-260. The patient's sex: risk groups, and the woman's lactation. */
  patientSexOf(encounterId: string): Promise<string>;

  /**
   * EN-096, EN-260. The woman of 10 to 49 who answered «yes» to lactation in
   * this attention — the database's own `encounter_is_lactating`.
   */
  isLactating(encounterId: string): Promise<boolean>;
  /**
   * EN-260 (D-202.1). The chart has a PREGNANT record that ended three
   * calendar months or less before the clinical date — the database's own
   * `encounter_is_postpartum`.
   */
  isPostpartum(encounterId: string): Promise<boolean>;

  /**
   * EN-262. The lines of the attention's prescriptions that are not annulled
   * nor discarded — issued or still a draft —, as the proposal reads them.
   */
  prescribedMedicines(encounterId: string): Promise<PrescribedMedicine[]>;

  findSupplement(query: EncounterQuery): Promise<SupplementRecord | null>;

  /** EN-096, EN-249. The supplements, the same way (`encounter_supplement_applies`). */
  saveSupplement(
    query: EncounterQuery,
    answer: SupplementAnswer,
    authorId: string,
  ): Promise<ProgramBlockSave<SupplementRecord>>;

  /** EN-093. The vaccines in force on the attention's clinical date. */
  vaccinesInForce(encounterId: string): Promise<VaccineOption[]>;

  findObstetric(query: EncounterQuery): Promise<ObstetricRecord | null>;
  findNutrition(query: EncounterQuery): Promise<NutritionRecord | null>;
  findVaccination(query: EncounterQuery): Promise<VaccinationRecord | null>;

  /**
   * EN-090, EN-091, EN-249. Records or corrects block G under the attention's
   * lock, while it admits new clinical content (EN-130). Who may have it is
   * the database's (`encounter_obstetric_applies`).
   */
  saveObstetric(
    query: EncounterQuery,
    answer: ObstetricAnswer,
    authorId: string,
  ): Promise<ProgramBlockSave<ObstetricRecord>>;

  /** EN-092, EN-249. Block H, the same way (`encounter_nutrition_applies`). */
  saveNutrition(
    query: EncounterQuery,
    answer: NutritionAnswer,
    authorId: string,
  ): Promise<ProgramBlockSave<NutritionRecord>>;

  /**
   * EN-093, EN-249. Block I, the same way (`encounter_vaccination_valid`).
   * `canWriteProtected` says whether the caller holds the second key: the
   * adapter refuses, under the lock, to replace a protected risk group it
   * does not let them see.
   */
  saveVaccination(
    query: EncounterQuery,
    answer: VaccinationAnswer,
    authorId: string,
    canWriteProtected: boolean,
  ): Promise<ProgramBlockSave<VaccinationRecord>>;
}

/** Injection token. The application never names the adapter. */
export const PROGRAM_BLOCKS_REPOSITORY = Symbol('ProgramBlocksRepository');
