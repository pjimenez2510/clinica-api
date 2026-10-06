import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  chartScope,
  chartScopeIds,
} from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  refutationNeedsReason,
  refutedOnlyAlone,
} from '../domain/allergy-refutation';
import {
  AllergyAlreadyRefutedError,
  AllergyNotRefutedError,
  AllergyRefutedAloneError,
  ChartHasAllergiesError,
  ConceptWrongCatalogueError,
  PatientAllergyNotFoundError,
  RefutationReasonRequiredError,
} from '../domain/encounter.errors';
import type {
  AllergyAbsenceAssertion,
  AllergyVersionView,
  AllergyView,
  EditAllergy,
  NewAllergy,
  NewAllergyAbsence,
  PatientAllergyRepository,
  ReactivateAllergy,
  RefuteAllergy,
  RefuteAndAssertNoKnownAllergies,
  RefutedAndAsserted,
  RetractNoKnownAllergies,
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
  changedAt: true,
  recordedBy: { select: { id: true, firstName: true, lastName: true } },
  refutedBy: { select: { id: true, firstName: true, lastName: true } },
  changedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.PatientAllergySelect;

/** The row `ALLERGY_SELECT` yields, derived from it so the two cannot drift. */
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

/** The row `ABSENCE_SELECT` yields, with the asserter's name and nothing else of the account. */
type AbsenceRow = Prisma.PatientAllergyAbsenceGetPayload<{
  select: typeof ABSENCE_SELECT;
}>;

/**
 * EN-080 to EN-083 over PostgreSQL. Every read goes through `chartScope`, as
 * the note at the top of this file explains.
 */
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
          // EN-086. «¿Quién dijo que era alérgico?», answered by the row.
          recordedById: allergy.recordedById,
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
   * THE ROW IS LOCKED FIRST (`lockAllergy`), so two people refuting the same
   * allergy in the same second cannot both succeed: the second waits, finds
   * it refuted and gets `ALLERGY_ALREADY_REFUTED` instead of overwriting who
   * ruled it out. Since EN-224 the refutation is a stamped change, so the
   * allergy as it was while it counted stays in `record_version`.
   *
   * «No existe en esta ficha» (`null`) and «ya estaba refutada» are two
   * different answers, and the lock read tells them apart.
   */
  async refute(refutation: RefuteAllergy): Promise<AllergyView | null> {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockAllergy(
        tx,
        refutation.patientId,
        refutation.allergyId,
      );
      // Not on this chart nor on any it absorbed: the service turns `null`
      // into the one 404 that covers «no existe» and «es de otra ficha».
      if (current === null) return null;
      if (current.refuted_at !== null) throw new AllergyAlreadyRefutedError();
      // D-140.1. Under the lock: the criticality that stands, not the one the
      // screen showed a moment ago.
      if (
        refutation.notes === null &&
        refutationNeedsReason(current.criticality)
      ) {
        throw new RefutationReasonRequiredError();
      }

      const row = await tx.patientAllergy.update({
        where: { id: current.id },
        data: {
          refutedAt: refutation.now,
          refutedNotes: refutation.notes,
          refutedById: refutation.refutedById,
          // EN-224. Refuting is a stamped change too: the allergy as it was
          // while it counted is the version it leaves behind.
          changedById: refutation.refutedById,
          changedAt: stampAfter(current.changed_at, refutation.now),
        },
        select: ALLERGY_SELECT,
      });
      return toAllergyView(row);
    });
  }

  /**
   * EN-225. Edits what one active allergy says. The row is LOCKED first, so
   * two edits in the same instant run one after the other and neither is
   * lost; the second's stamp moves past the first's (`stampAfter`).
   */
  async edit(edit: EditAllergy): Promise<AllergyView | null> {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockAllergy(tx, edit.patientId, edit.allergyId);
      if (current === null) return null;
      if (current.refuted_at !== null) throw new AllergyAlreadyRefutedError();

      const { changes } = edit;
      const data: Prisma.PatientAllergyUncheckedUpdateInput = {};
      if (
        changes.substanceText !== undefined &&
        changes.substanceText !== current.substance_text
      ) {
        data.substanceText = changes.substanceText;
      }
      // EN-225, EN-084. Absent keeps the concept: only an explicit `null`
      // clears it. A typo fixed in the name never stops the check silently.
      if (changes.substanceConceptId !== undefined) {
        const conceptId = changes.substanceConceptId;
        // EN-080. The same catalogue check as recording one.
        if (conceptId !== null) await assertCnmbConcept(tx, conceptId);
        if (conceptId !== current.substance_concept_id) {
          data.substanceConceptId = conceptId;
        }
      }
      if (
        changes.reaction !== undefined &&
        changes.reaction !== current.reaction
      ) {
        data.reaction = changes.reaction;
      }
      if (
        changes.criticality !== undefined &&
        changes.criticality !== current.criticality
      ) {
        data.criticality = changes.criticality;
      }

      // Nothing to change is not an edit: no version of an identical row.
      if (Object.keys(data).length === 0) {
        const row = await tx.patientAllergy.findUniqueOrThrow({
          where: { id: current.id },
          select: ALLERGY_SELECT,
        });
        return toAllergyView(row);
      }

      const row = await tx.patientAllergy.update({
        where: { id: current.id },
        data: {
          ...data,
          changedById: edit.editedById,
          changedAt: stampAfter(current.changed_at, edit.now),
        },
        select: ALLERGY_SELECT,
      });
      return toAllergyView(row);
    });
  }

  /**
   * EN-224. Back to active. The refutation is emptied on the row and kept
   * whole in the version the database archives in the same statement.
   */
  async reactivate(
    reactivation: ReactivateAllergy,
  ): Promise<AllergyView | null> {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockAllergy(
        tx,
        reactivation.patientId,
        reactivation.allergyId,
      );
      if (current === null) return null;
      if (current.refuted_at === null) throw new AllergyNotRefutedError();

      const row = await tx.patientAllergy.update({
        where: { id: current.id },
        data: {
          refutedAt: null,
          refutedNotes: null,
          refutedById: null,
          changedById: reactivation.reactivatedById,
          changedAt: stampAfter(current.changed_at, reactivation.now),
        },
        select: ALLERGY_SELECT,
      });
      return toAllergyView(row);
    });
  }

  /**
   * EN-225. The versions `record_version_archive` kept, newest first, read
   * through the SAME mapping as the current allergy so the two cannot be
   * painted differently.
   */
  async versionsOf(
    chartId: string,
    allergyId: string,
  ): Promise<AllergyVersionView[] | null> {
    const visible = await this.prisma.patientAllergy.count({
      where: { id: allergyId, ...chartScope(chartId) },
    });
    if (visible === 0) return null;

    const versions = await this.prisma.recordVersion.findMany({
      where: { resourceType: 'patient_allergy', resourceId: allergyId },
      orderBy: { version: 'desc' },
      select: {
        version: true,
        data: true,
        changedAt: true,
        changedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    const snapshots = versions.map(
      (version) => version.data as unknown as AllergySnapshot,
    );
    const authors = await this.namesOf(
      snapshots.flatMap((snapshot) => [
        snapshot.recorded_by,
        snapshot.refuted_by,
        snapshot.changed_by ?? null,
      ]),
    );

    return versions.map((version, index) => ({
      version: version.version,
      replacedBy: authorOf(version.changedBy)!,
      replacedAt: version.changedAt,
      allergy: toAllergyView(
        allergyRowFromSnapshot(snapshots[index]!, authors),
      ),
    }));
  }

  /**
   * EN-226. «Descartar estas y afirmar», in ONE transaction: the named
   * allergies are refuted with the step's reason and the assertion is
   * written. Whether any active allergy was left out is decided by
   * `trg_patient_allergy_absence_empty_chart` on the INSERT, which sees this
   * transaction's refutations — and a refusal there rolls them all back.
   *
   * THE LOCKS ARE TAKEN IN ID ORDER. Two steps over the same chart that named
   * the allergies in a different order would otherwise each hold one and wait
   * for the other's, and PostgreSQL would kill one of them as a deadlock.
   *
   * D-140.3. An active allergy of HIGH criticality refuses the whole step
   * (`ALLERGY_REFUTED_ALONE`), decided under its lock.
   */
  async refuteAndAssertNoKnownAllergies(
    request: RefuteAndAssertNoKnownAllergies,
  ): Promise<RefutedAndAsserted> {
    const ordered = [...new Set(request.allergyIds)].sort();
    try {
      const { row, refutedAllergyIds } = await this.prisma.$transaction(
        async (tx) => {
          const refuted: string[] = [];
          for (const allergyId of ordered) {
            const current = await lockAllergy(tx, request.patientId, allergyId);
            if (current === null) throw new PatientAllergyNotFoundError();
            // Already ruled out by somebody else: what the step wants is
            // done, and it is not this step's refutation to report.
            if (current.refuted_at !== null) continue;
            if (refutedOnlyAlone(current.criticality)) {
              throw new AllergyRefutedAloneError();
            }
            await tx.patientAllergy.update({
              where: { id: current.id },
              data: {
                refutedAt: request.now,
                refutedNotes: request.notes,
                refutedById: request.actorId,
                changedById: request.actorId,
                changedAt: stampAfter(current.changed_at, request.now),
              },
            });
            refuted.push(current.id);
          }

          const created = await tx.patientAllergyAbsence.create({
            data: {
              patientId: request.patientId,
              assertedById: request.actorId,
            },
            select: ABSENCE_SELECT,
          });
          return { row: created, refutedAllergyIds: refuted };
        },
      );
      return { assertion: toAbsenceAssertion(row), refutedAllergyIds };
    } catch (error) {
      if (isActiveAllergiesRefusal(error)) throw new ChartHasAllergiesError();
      throw error;
    }
  }

  /**
   * EN-226. Withdraws one assertion, once: the row stays, with who withdrew
   * it and when, and its earlier state goes to `record_version`. The
   * `retracted_at IS NULL` in the same statement arbitrates two people
   * withdrawing it at once: exactly one UPDATE matches.
   */
  async retractNoKnownAllergies(
    request: RetractNoKnownAllergies,
  ): Promise<boolean> {
    const { count } = await this.prisma.patientAllergyAbsence.updateMany({
      where: {
        id: request.assertionId,
        ...chartScope(request.patientId),
        retractedAt: null,
      },
      data: { retractedById: request.retractedById, retractedAt: request.now },
    });
    return count === 1;
  }

  /** EN-086. The names behind the author ids of the versions, in one read. */
  private async namesOf(
    ids: readonly (string | null)[],
  ): Promise<Map<string, AuthorRow>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: wanted } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(users.map((user) => [user.id, user]));
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
      select: { ...ABSENCE_SELECT, retractedAt: true },
      orderBy: [{ assertedAt: 'desc' }, { id: 'desc' }],
    });
    // EN-226. The chart's last word was withdrawn: «no se preguntó», and an
    // older assertion does not come back behind it.
    if (assertion === null || assertion.retractedAt !== null) return null;

    // EN-224. An allergy recorded after it supersedes it — and so does one
    // that is ACTIVE now although recorded before: one reactivated after the
    // assertion, or one that came with a chart merged in later.
    const supersedingAllergies = await this.prisma.patientAllergy.count({
      where: {
        ...chartScope(chartId),
        OR: [{ recordedAt: { gt: assertion.assertedAt } }, { refutedAt: null }],
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

/** An allergy row as the domain reads it, refuted or not. */
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
    changedAt: row.changedAt,
    recordedBy: authorOf(row.recordedBy),
    refutedBy: authorOf(row.refutedBy),
    changedBy: authorOf(row.changedBy),
  };
}

/** An account as the reads load it: the name and nothing else. */
type AuthorRow = { id: string; firstName: string; lastName: string };

/** The columns the row has inside `record_version.data` (`to_jsonb(OLD)`). */
interface AllergySnapshot {
  id: string;
  patient_id: string;
  substance_concept_id: string | null;
  substance_text: string;
  reaction: string | null;
  criticality: AllergyRow['criticality'];
  recorded_at: string;
  recorded_by: string | null;
  refuted_at: string | null;
  refuted_notes: string | null;
  refuted_by: string | null;
  changed_by: string | null;
  changed_at: string | null;
}

/** A version as the row it was, so `toAllergyView` maps it like the current. */
function allergyRowFromSnapshot(
  snapshot: AllergySnapshot,
  authors: Map<string, AuthorRow>,
): AllergyRow {
  const author = (id: string | null) =>
    id === null ? null : (authors.get(id) ?? null);
  return {
    id: snapshot.id,
    patientId: snapshot.patient_id,
    substanceConceptId: snapshot.substance_concept_id,
    substanceText: snapshot.substance_text,
    reaction: snapshot.reaction,
    criticality: snapshot.criticality,
    recordedAt: new Date(snapshot.recorded_at),
    refutedAt:
      snapshot.refuted_at === null ? null : new Date(snapshot.refuted_at),
    refutedNotes: snapshot.refuted_notes,
    changedAt:
      snapshot.changed_at === null ? null : new Date(snapshot.changed_at),
    recordedBy: author(snapshot.recorded_by),
    refutedBy: author(snapshot.refuted_by),
    changedBy: author(snapshot.changed_by ?? null),
  };
}

/** The columns an edit needs to decide, read under the row lock. */
interface LockedAllergy {
  id: string;
  substance_concept_id: string | null;
  substance_text: string;
  reaction: string | null;
  criticality: AllergyRow['criticality'];
  refuted_at: Date | null;
  changed_at: Date | null;
}

/**
 * The allergy, LOCKED, if it is on this chart or one it absorbed; `null`
 * otherwise. Every change goes through here, so two changes of one allergy
 * never interleave.
 */
async function lockAllergy(
  tx: Prisma.TransactionClient,
  chartId: string,
  allergyId: string,
): Promise<LockedAllergy | null> {
  const [row] = await tx.$queryRaw<LockedAllergy[]>`
    SELECT id, substance_concept_id, substance_text, reaction,
           criticality::text AS criticality, refuted_at, changed_at
      FROM patient_allergy
     WHERE id = ${allergyId}::uuid
       AND patient_id IN ${chartScopeIds(chartId)}
       FOR UPDATE`;
  return row ?? null;
}

/**
 * EN-210's rule for every versioned row: `record_version_archive` refuses an
 * edit whose stamp did not change, so a second change in the same
 * millisecond moves past the first instead of failing as «sin sello».
 */
function stampAfter(previous: Date | null, now: Date): Date {
  return previous && previous >= now ? new Date(previous.getTime() + 1) : now;
}

/**
 * EN-226. The refusal of `trg_patient_allergy_absence_empty_chart`: SQLSTATE
 * 23000 with the trigger's own sentence. Read off Prisma's error shape
 * without importing the HTTP mapping, which lives in another layer.
 */
function isActiveAllergiesRefusal(error: unknown): boolean {
  const cause = (error as PrismaErrorLike | null)?.meta?.driverAdapterError
    ?.cause;
  const sqlState = cause?.code ?? cause?.originalCode;
  return (
    sqlState === '23000' &&
    typeof cause?.originalMessage === 'string' &&
    cause.originalMessage.includes('has active allergies')
  );
}

interface PrismaErrorLike {
  meta?: {
    driverAdapterError?: {
      cause?: {
        code?: unknown;
        originalCode?: unknown;
        originalMessage?: unknown;
      };
    };
  };
}

/** EN-086. The account behind a row, by name, or `null` for older rows. */
function authorOf(user: AuthorRow | null): AllergyView['recordedBy'] {
  return user === null
    ? null
    : { id: user.id, name: `${user.firstName} ${user.lastName}` };
}
