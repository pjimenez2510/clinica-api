/**
 * EN-080 to EN-083. What an allergy needs from storage, without naming a
 * database.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE ACTIVE LIST IS *NOT* HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «Las alergias activas de una ficha» is the one question two modules ask, so
 * it lives in `shared/clinical/patient-allergy.port.ts` and is answered by one
 * statement for both (EN-084). Restating it here would create the second copy
 * that port exists to prevent — and the copy that forgets `chartScope` is the
 * one that hides the penicillin allergy of an absorbed chart.
 *
 * What IS here is everything only this module does: writing an allergy,
 * refuting one, and listing a chart's allergies INCLUDING the refuted ones,
 * which is a different question with a different answer (EN-082).
 */

import type { ActiveAllergy } from '../../../shared/clinical/patient-allergy.port';
import type { AllergyCriticality } from '../../../shared/clinical/patient-allergy.port';

/**
 * One allergy as this module serves it: the active view plus the two columns
 * that say it was ruled out.
 *
 * ⚠️ THE REFUTED ROWS TRAVEL IN THE LISTING AND NOT IN THE READER, and the
 * split is EN-082 made into two shapes. «Saber que una alergia se descartó es
 * información clínica por derecho propio» — the patient who was told they were
 * allergic to penicillin and turned out not to be needs that on the record, or
 * in two years somebody writes it again and again withholds the right
 * antibiotic. What a prescription check needs is the opposite: only what is
 * still believed true.
 */
export interface AllergyView extends ActiveAllergy {
  /** EN-082. `null` while the allergy still counts. Never a deletion. */
  refutedAt: Date | null;
  /** EN-082. Why it was ruled out. Mandatory when `refutedAt` is present. */
  refutedNotes: string | null;
}

/** EN-080, EN-083. Everything an allergy is born with. */
export interface NewAllergy {
  patientId: string;
  /**
   * EN-080. The CNMB concept when the allergen is a drug, absent otherwise.
   *
   * OPTIONAL BECAUSE HALF THE ALLERGIES OF A CLINIC ARE NOT DRUGS — foods,
   * latex, insect stings — and forcing a concept would make them unrecordable
   * or, worse, recordable as the wrong concept. The adapter still refuses a
   * concept from another catalogue (`CONCEPT_WRONG_CATALOGUE`).
   */
  substanceConceptId?: string;
  /** EN-080. The label, always: it is what a person reads on the screen. */
  substanceText: string;
  reaction?: string;
  /**
   * EN-083. Asked for and never defaulted by this module.
   *
   * The COLUMN defaults to `UNABLE_TO_ASSESS`, which is the honest value for a
   * row written by an import. What the caller must not be able to do is skip
   * the question and have the system assert `LOW` on their behalf, so the DTO
   * requires it explicitly.
   */
  criticality: AllergyCriticality;
}

/**
 * EN-087. «Sin alergias conocidas», as a clinician asserted it.
 *
 * ⚠️ THE AUTHOR AND THE INSTANT ARE THE SHAPE, not decoration on it. HL7's
 * International Patient Summary defines `nilknown` as «una afirmación positiva
 * por parte de un usuario clínico, **y no una posición por defecto afirmada por
 * un sistema informático a falta de otra información**», and a shape without a
 * name and a date could only ever express the second one.
 *
 * THE NAME TRAVELS BESIDE THE IDENTIFIER, unlike `authorId` on a note. This is
 * read on the permanent band of the consultation — «Sin alergias conocidas
 * (Dra. Villacís, 14-03-2026)» — and a screen that had to resolve the id would
 * either print a UUID or need a second call for one line of text. The
 * identifier travels too, because it is the identifier that a trail joins on.
 */
export interface AllergyAbsenceAssertion {
  id: string;
  /** The chart it was WRITTEN ON, which after a merge may be an absorbed one. */
  patientId: string;
  assertedById: string;
  /** The clinician's name, because it is what a person reads on the band. */
  assertedByName: string;
  assertedAt: Date;
}

/** EN-087. Asserting it: the chart and whoever is asserting. */
export interface NewAllergyAbsence {
  /** The live chart. The service refuses an absorbed one, as `record` does. */
  patientId: string;
  /** The clinician. Never the system, which is the whole of the requirement. */
  assertedById: string;
}

/** EN-082. Ruling one out: the instant and the reason, never a deletion. */
export interface RefuteAllergy {
  /**
   * The chart the caller is looking at. The adapter resolves it AND the charts
   * it absorbed: an allergy written on an absorbed chart is refutable from the
   * survivor, because to the doctor it is one person.
   */
  patientId: string;
  allergyId: string;
  /** EN-082. Why it was ruled out. The service refuses an empty one. */
  notes: string;
  /** Taken once by the caller: the domain owns no clock. */
  now: Date;
}

export interface PatientAllergyRepository {
  /**
   * EN-080, EN-083. Writes one allergy.
   *
   * ⚠️ IT REFUSES A CONCEPT FROM ANOTHER CATALOGUE, inside the same statement
   * that writes the row. `substance_concept_id` is a foreign key to
   * `catalog_concept`, which holds EVERY catalogue there is, so nothing in the
   * schema stops a CIE-10 disease or a DPA parish from being filed as the
   * substance somebody is allergic to — and it would then never match anything
   * a prescription checks, which is a check that silently passes.
   */
  record(allergy: NewAllergy): Promise<AllergyView>;

  /**
   * EN-082. Marks one allergy as ruled out. NEVER deletes it.
   *
   * `null` when the allergy is not on this chart or on any chart it absorbed —
   * the service turns that into `PATIENT_ALLERGY_NOT_FOUND`, one answer for
   * «no existe» and for «es de otra ficha», the line `ENCOUNTER_NOT_FOUND`
   * already took.
   *
   * ⚠️ IT REFUSES A SECOND REFUTATION, and that is not pedantry: the second
   * one would overwrite the instant and the reason of the first, and «quién la
   * descartó y por qué» is the information the requirement exists to keep.
   */
  refute(refutation: RefuteAllergy): Promise<AllergyView | null>;

  /**
   * EN-082. Every allergy of the chart, refuted ones included, worst first.
   *
   * THE CHART AND THE CHARTS IT ABSORBED (PA-055). A read by the bare
   * identifier hides half the list the day admissions repairs a duplicate, and
   * `patient-chart-scope.spec.ts` fails the build over it.
   */
  listFor(chartId: string): Promise<AllergyView[]>;

  /**
   * EN-087. Writes one «sin alergias conocidas», with its author and instant.
   *
   * ⚠️ IT IS AN INSERT AND NEVER AN UPDATE, and the table refuses the other
   * one. Asserting it again in June is a SECOND row, not the first one moved:
   * what a court asks is what the doctor who prescribed in March had in front
   * of them, and a row that keeps being overwritten cannot answer that.
   *
   * ⚠️ IT CAN STILL BE REFUSED BY THE DATABASE. `trg_patient_allergy_absence_
   * empty_chart` rejects an assertion over a chart — or a chart it absorbed —
   * that still has an unrefuted allergy. The service asks the same question
   * first so the caller gets a sentence instead of `INTEGRITY_RULE_FAILED`;
   * the trigger is what arbitrates the two simultaneous requests the service
   * cannot see, exactly as `NOTE_ALREADY_SIGNED` is arranged.
   */
  assertNoKnownAllergies(
    assertion: NewAllergyAbsence,
  ): Promise<AllergyAbsenceAssertion>;

  /**
   * EN-087. The chart's STANDING «sin alergias conocidas», or `null`.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * `null` MEANS «NO SE PREGUNTÓ», AND IT IS THE SAFE DIRECTION ON PURPOSE
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * An assertion stops standing the moment an allergy is recorded after it. It
   * was not wrong — it was true until that day — but it is no longer the last
   * word about the chart, and serving it would let a screen say «sin alergias
   * conocidas» about a person somebody has since found an allergy in. The case
   * that makes this concrete: asserted in March, penicillin recorded in April,
   * refuted in May. The chart is empty again and NOBODY HAS ASKED SINCE, so the
   * answer is «no se preguntó» until a clinician says otherwise.
   *
   * Going the other way — keeping March's assertion alive across everything
   * learned since — is precisely «una posición por defecto afirmada por un
   * sistema informático», which is the sentence the requirement exists to obey.
   *
   * THE CHART AND THE CHARTS IT ABSORBED (PA-055), on both halves of that
   * question: the assertion and the allergies that supersede it.
   */
  standingAbsenceFor(chartId: string): Promise<AllergyAbsenceAssertion | null>;
}

/** Injection token. The application never names the adapter. */
export const PATIENT_ALLERGY_REPOSITORY = Symbol('PatientAllergyRepository');
