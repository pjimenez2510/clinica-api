import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { chartScope } from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  AllergyAlreadyRefutedError,
  ConceptWrongCatalogueError,
} from '../domain/encounter.errors';
import type {
  AllergyAbsenceAssertion,
  AllergyView,
  NewAllergy,
  NewAllergyAbsence,
  PatientAllergyRepository,
  RefuteAllergy,
} from '../domain/patient-allergy.repository';

/**
 * Rows in, domain shapes out — the same contract as every other adapter here.
 *
 * ⚠️ EVERY READ IN THIS FILE GOES THROUGH `chartScope`, WITHOUT EXCEPTION.
 * `patient_allergy` is the table `patient-chart-scope.ts` opens its own
 * documentation with: admissions merges two charts correctly, the absorbed one
 * held the penicillin allergy, the doctor opens the survivor, sees nothing and
 * prescribes. A merge re-points nothing (D-031), so a read by the bare
 * `patient_id` returns half a clinical history AND NEITHER FAILS NOR WARNS.
 * `patient-chart-scope.spec.ts` walks this file and breaks the build over it.
 */

/**
 * The CNMB — Cuadro Nacional de Medicamentos Básicos — as `catalog_system`
 * names it.
 *
 * A CONSTANT AND NOT A LITERAL AT THE CALL SITE, like `CIE10` and `TARIFF` in
 * the coding adapter: it appears in the query and in the refusal, and the two
 * have to be the same string.
 */
const CNMB = 'CNMB';

const ALLERGY_SELECT = {
  id: true,
  patientId: true,
  substanceConceptId: true,
  substanceText: true,
  reaction: true,
  criticality: true,
  recordedAt: true,
  refutedAt: true,
  refutedNotes: true,
} satisfies Prisma.PatientAllergySelect;

type AllergyRow = Prisma.PatientAllergyGetPayload<{
  select: typeof ALLERGY_SELECT;
}>;

/**
 * EN-087. The assertion and the NAME of whoever made it, in one statement.
 *
 * ⚠️ THE NAME AND NOTHING ELSE OF THE ACCOUNT. Not the email, not the cedula,
 * not the ACESS registration: what the band prints is «Sin alergias conocidas
 * (Ana Villacís, 14-03-2026)», and a field that is never loaded cannot end up
 * in a log or in a payload somebody later decides to widen.
 */
const ABSENCE_SELECT = {
  id: true,
  patientId: true,
  assertedById: true,
  assertedAt: true,
  assertedBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.PatientAllergyAbsenceSelect;

type AbsenceRow = Prisma.PatientAllergyAbsenceGetPayload<{
  select: typeof ABSENCE_SELECT;
}>;

@Injectable()
export class PrismaPatientAllergyRepository implements PatientAllergyRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * EN-080, EN-083. Writes one allergy.
   *
   * ⚠️ THE CATALOGUE IS CHECKED INSIDE THE SAME TRANSACTION, and it is the
   * hole the foreign key leaves open. `substance_concept_id` points at
   * `catalog_concept`, which holds EVERY catalogue there is, so nothing in the
   * schema stops a CIE-10 disease or a DPA parish from being recorded as the
   * substance a patient is allergic to. The row would be accepted, look
   * perfectly well formed, and never match anything a prescription checks —
   * which is a safety check that silently passes for the rest of the patient's
   * life. Exactly the argument EN-040 makes for the diagnosis.
   *
   * ⚠️ AND VALIDITY IS *NOT* CHECKED. A diagnosis must use a code in force on
   * the day of the attention (EN-042) because the RDACAA counts it; an allergy
   * to a drug whose CNMB entry was later withdrawn is still an allergy, and
   * refusing to record it would be the system arguing with a fact about a
   * person's immune system.
   */
  async record(allergy: NewAllergy): Promise<AllergyView> {
    const row = await this.prisma.$transaction(async (tx) => {
      if (allergy.substanceConceptId !== undefined) {
        await assertCnmbConcept(tx, allergy.substanceConceptId);
      }

      return tx.patientAllergy.create({
        data: {
          patientId: allergy.patientId,
          substanceConceptId: allergy.substanceConceptId,
          substanceText: allergy.substanceText,
          reaction: allergy.reaction,
          criticality: allergy.criticality,
          // `recorded_at` is left to the column default: the instant of the
          // WRITE is the instant of the record here, unlike `started_at` or
          // `measured_at`, which are facts about the world that happened
          // earlier. Nobody takes an allergy at 08:10 and types it at 08:40 —
          // it is said out loud and typed in the same breath.
        },
        select: ALLERGY_SELECT,
      });
    });

    return toAllergyView(row);
  }

  /**
   * EN-082. Marks one allergy as ruled out. NOTHING IS EVER DELETED.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * WHY IT IS AN `updateMany` WITH THE WHOLE PREDICATE AND NOT A READ-THEN-WRITE
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The `where` carries all three conditions at once — the id, the chart scope
   * and `refuted_at IS NULL` — so two people refuting the same allergy in the
   * same second cannot both succeed: PostgreSQL arbitrates, exactly one
   * `UPDATE` matches a row, and the loser sees a count of zero. A read
   * followed by an update would let both through and the second would
   * overwrite the first one's reason, which is the datum EN-082 exists to
   * keep.
   *
   * ⚠️ THE ZERO IS THEN DISAMBIGUATED, and it has to be: «no existe en esta
   * ficha» and «ya estaba refutada» are two different answers to the caller.
   * The second read runs inside the same transaction, so what it reports is
   * the state that actually refused the update.
   */
  async refute(refutation: RefuteAllergy): Promise<AllergyView | null> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.patientAllergy.updateMany({
        where: {
          id: refutation.allergyId,
          ...chartScope(refutation.patientId),
          refutedAt: null,
        },
        data: {
          refutedAt: refutation.now,
          refutedNotes: refutation.notes,
        },
      });

      if (count === 0) {
        const existing = await tx.patientAllergy.findFirst({
          where: {
            id: refutation.allergyId,
            ...chartScope(refutation.patientId),
          },
          select: ALLERGY_SELECT,
        });
        // Not on this chart nor on any it absorbed: the service turns `null`
        // into the one 404 that covers «no existe» and «es de otra ficha».
        if (existing === null) return null;
        throw new AllergyAlreadyRefutedError();
      }

      const row = await tx.patientAllergy.findFirstOrThrow({
        where: {
          id: refutation.allergyId,
          ...chartScope(refutation.patientId),
        },
        select: ALLERGY_SELECT,
      });
      return toAllergyView(row);
    });
  }

  /**
   * EN-082. Every allergy of the chart, the ruled-out ones included.
   *
   * ACTIVE FIRST, THEN REFUTED, and within each group the newest first. The
   * ordering is done on the column that says it — `refuted_at IS NULL` — via
   * `nulls: 'first'`, so what a screen paints in bold is at the top of the
   * list rather than scattered through it.
   *
   * ⚠️ CRITICALITY IS *NOT* THE FIRST KEY HERE, unlike the active reader.
   * That reader answers «¿qué hay que comprobar ahora?» and this one answers
   * «¿qué se ha escrito sobre este paciente?», which is a chronology. Sorting
   * a history by severity would make it impossible to see that the same
   * substance was recorded twice and ruled out once.
   */
  async listFor(chartId: string): Promise<AllergyView[]> {
    const rows = await this.prisma.patientAllergy.findMany({
      where: { ...chartScope(chartId) },
      select: ALLERGY_SELECT,
      orderBy: [
        { refutedAt: { sort: 'asc', nulls: 'first' } },
        { recordedAt: 'desc' },
        { id: 'desc' },
      ],
    });
    return rows.map(toAllergyView);
  }

  /**
   * EN-087. Writes one «sin alergias conocidas».
   *
   * A PLAIN INSERT, and everything that could go wrong is a trigger's job:
   * `trg_patient_allergy_absence_empty_chart` refuses it over a chart that
   * still has an unrefuted allergy — its own or an absorbed chart's — and
   * `trg_patient_allergy_absence_immutable` refuses every later edit. Nothing
   * is read first here on purpose: a read-then-write would let two
   * simultaneous requests both see an empty chart, and the check that matters
   * has to be in the same statement that writes.
   */
  async assertNoKnownAllergies(
    assertion: NewAllergyAbsence,
  ): Promise<AllergyAbsenceAssertion> {
    const row = await this.prisma.patientAllergyAbsence.create({
      data: {
        patientId: assertion.patientId,
        assertedById: assertion.assertedById,
        // `asserted_at` is left to the column default, like `recorded_at`: the
        // instant of the WRITE is the instant of the assertion. Nobody asks a
        // patient about allergies at 08:10 and asserts it at 08:40 — it is
        // said out loud and typed in the same breath.
      },
      select: ABSENCE_SELECT,
    });

    return toAbsenceAssertion(row);
  }

  /**
   * EN-087. The chart's standing assertion, or `null`.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * TWO READS, AND THE SECOND ONE IS THE REQUIREMENT
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The latest assertion is not automatically the current answer. An allergy
   * recorded AFTER it is the chart's newer word on the subject, and it keeps
   * being the newer word even once that allergy is refuted: asserted in March,
   * penicillin in April, ruled out in May leaves an empty chart that NOBODY HAS
   * ASKED ABOUT SINCE. Serving March's assertion there would be the system
   * asserting «sin alergias conocidas» on its own initiative, which is the one
   * thing HL7's definition forbids by name.
   *
   * ⚠️ BOTH READS GO THROUGH `chartScope`. The assertion may have been written
   * on a chart that was later absorbed, and — more dangerous — the allergy that
   * supersedes it may live on one. A bare `patient_id` on the second read
   * silently keeps a stale «ninguna» alive over the absorbed chart's penicillin
   * allergy, which is PA-009 with a prescription at the end of it.
   *
   * ORDERED BY `asserted_at` AND THEN BY `id`. `uuidv7()` is time-ordered, so
   * the tie-break is still «the last one written» when two assertions share an
   * instant — which two requests in the same millisecond can.
   */
  async standingAbsenceFor(
    chartId: string,
  ): Promise<AllergyAbsenceAssertion | null> {
    const assertion = await this.prisma.patientAllergyAbsence.findFirst({
      where: { ...chartScope(chartId) },
      select: ABSENCE_SELECT,
      orderBy: [{ assertedAt: 'desc' }, { id: 'desc' }],
    });
    if (assertion === null) return null;

    const supersedingAllergies = await this.prisma.patientAllergy.count({
      where: {
        ...chartScope(chartId),
        recordedAt: { gt: assertion.assertedAt },
      },
    });

    return supersedingAllergies > 0 ? null : toAbsenceAssertion(assertion);
  }
}

/**
 * EN-080. The concept exists AND belongs to the CNMB.
 *
 * ONE STATEMENT AND NOT TWO: «no existe» and «es de otro catálogo» answer the
 * same refusal because what the caller does next is identical — pick the
 * active principle from the CNMB list. The foreign key would refuse the first
 * a moment later with `RELATED_RECORD_MISSING`, which says «falta un registro
 * relacionado» to somebody who was typing a medicine.
 */
async function assertCnmbConcept(
  tx: Prisma.TransactionClient,
  conceptId: string,
): Promise<void> {
  const concept = await tx.catalogConcept.findUnique({
    where: { id: conceptId },
    select: { system: { select: { code: true } } },
  });

  if (concept === null || concept.system.code !== CNMB) {
    throw new ConceptWrongCatalogueError(CNMB);
  }
}

/**
 * EN-087. The row, with the author's name assembled once.
 *
 * `trim()` because `first_name` and `last_name` are both `NOT NULL` and the
 * join is a single space: what it guards against is not a missing half but the
 * double space that a stray trailing blank in the account would put in the
 * middle of the band's one line.
 */
function toAbsenceAssertion(row: AbsenceRow): AllergyAbsenceAssertion {
  return {
    id: row.id,
    patientId: row.patientId,
    assertedById: row.assertedById,
    assertedByName:
      `${row.assertedBy.firstName} ${row.assertedBy.lastName}`.trim(),
    assertedAt: row.assertedAt,
  };
}

function toAllergyView(row: AllergyRow): AllergyView {
  return {
    id: row.id,
    patientId: row.patientId,
    substanceConceptId: row.substanceConceptId,
    substanceText: row.substanceText,
    reaction: row.reaction,
    criticality: row.criticality,
    recordedAt: row.recordedAt,
    refutedAt: row.refutedAt,
    refutedNotes: row.refutedNotes,
  };
}
