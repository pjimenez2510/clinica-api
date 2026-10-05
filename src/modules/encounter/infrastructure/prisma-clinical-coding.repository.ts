import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  ConceptWrongCatalogueError,
  DiagnosisCitedByIssuedDocumentError,
  DiagnosisConceptNotInForceError,
  DiagnosisNotFoundError,
  DiagnosisPrimaryTakenError,
  DiagnosisRetractionReasonRequiredError,
  DiagnosisLastAfterDischargeError,
  DiagnosisPrimaryAfterDischargeError,
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
} from '../domain/encounter.errors';
import type { CareModality, EncounterStatus } from '../domain/encounter';
import {
  acceptsDiagnosisCorrection,
  acceptsNewClinicalContent,
  hasDischarge,
} from '../domain/encounter-state';
import {
  careModalityOfCie10,
  isPrimary,
  nextRankAfter,
} from '../domain/diagnosis';
import type {
  ClinicalCodingRepository,
  CodingQuery,
  DiagnosisRetraction,
  DiagnosisView,
  NewDiagnosis,
  PrimaryChange,
  RetractedDiagnosisView,
  NewProcedure,
  ProcedureView,
} from '../domain/clinical-coding.repository';
import type { SiteScopeFilter } from '../domain/encounter.repository';

/**
 * Block K's rows in, domain shapes out.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY EVERY CHECK IS INSIDE THE TRANSACTION THAT WRITES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three things can change between a read and a write here: a catalogue release
 * lands and retires the code, another practitioner codes the principal
 * diagnosis, the attention gets discharged. A caller who could ask any of them
 * first and act later is the race AG-045 was left open by, and the one `open`
 * closes with `FOR UPDATE`.
 *
 * ⚠️ AND THE ADAPTER IS NOT THE GUARANTEE FOR TWO OF THEM. The validity on the
 * clinical date is `trg_diagnosis_concept_in_force` and the single principal
 * is `encounter_diagnosis_one_primary`; both also stop an import, a `psql` and
 * a use case somebody writes in two years. What this file adds is the
 * SENTENCE, because a trigger that raises `integrity_constraint_violation`
 * from PL/pgSQL emits no constraint name for the error mapping to read, and
 * `INTEGRITY_RULE_FAILED` tells a doctor nothing about which code to pick.
 * The order is the one `NOTE_ALREADY_SIGNED` set: database first as the rule,
 * application second as the explanation.
 *
 * ⚠️ NOTHING HERE TOUCHES `encounter_procedure.tariff_amount` (EN-051, D-049).
 * Money frozen inside a clinical table is the separation `billing` is built
 * on; the charge is `charge_item`, resolved from the price list of the payer
 * on the service date. The column is left where it is and not propagated.
 */

/** The catalogue a diagnosis has to come from (EN-040). */
const CIE10 = 'CIE10';

/**
 * The catalogue a procedure has to come from (EN-050).
 *
 * The Tarifario de Prestaciones del Sistema Nacional de Salud supplies the
 * NOMENCLATURE and the code — not what the clinic charges, whose scope A.M.
 * 0046-2017 narrowed to dealings inside the public network.
 */
const TARIFF = 'TARIFF';

const DIAGNOSIS_SELECT = {
  id: true,
  encounterId: true,
  conceptId: true,
  // EN-041. Written by `trg_diagnosis_snapshot` and kept in step with the
  // concept by it: the copy is what the record still says in fifteen years.
  cie10Code: true,
  cie10Display: true,
  certainty: true,
  occurrence: true,
  rank: true,
  notifiable: true,
  note: true,
  recordedAt: true,
} satisfies Prisma.EncounterDiagnosisSelect;

/** The row `DIAGNOSIS_SELECT` yields, derived from it so the two cannot drift. */
type DiagnosisRow = Prisma.EncounterDiagnosisGetPayload<{
  select: typeof DIAGNOSIS_SELECT;
}>;

/**
 * ⚠️ `tariffAmount` IS NOT SELECTED, AND THAT IS THE REQUIREMENT (EN-051). A
 * value that is never loaded cannot leak into a response, a screen or an
 * invoice raised from the wrong side of the boundary.
 */
const PROCEDURE_SELECT = {
  id: true,
  encounterId: true,
  conceptId: true,
  procedureCode: true,
  procedureDisplay: true,
  quantity: true,
  performedAt: true,
  note: true,
} satisfies Prisma.EncounterProcedureSelect;

/** The row `PROCEDURE_SELECT` yields — without `tariffAmount`, because the select omits it. */
type ProcedureRow = Prisma.EncounterProcedureGetPayload<{
  select: typeof PROCEDURE_SELECT;
}>;

/** What one statement can tell us about a concept, in the context of an attention. */
interface ConceptRow {
  system_code: string;
  concept_code: string;
  concept_display: string;
  in_force: boolean;
}

/**
 * Block K over PostgreSQL. Each write checks scope and catalogue inside its
 * own transaction, and `tariff_amount` is never read (EN-051).
 */
@Injectable()
export class PrismaClinicalCodingRepository implements ClinicalCodingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** EN-040 to EN-049. Writes one diagnosis. */
  async addDiagnosis(diagnosis: NewDiagnosis): Promise<DiagnosisView> {
    const row = await this.prisma.$transaction(async (tx) => {
      await requireEncounterInScope(tx, diagnosis.encounterId, diagnosis.sites);

      const concept = await conceptForEncounter(
        tx,
        diagnosis.encounterId,
        diagnosis.conceptId,
      );

      /**
       * EN-040. A concept that does not exist and one from another catalogue
       * answer the SAME refusal, because what the caller does next is
       * identical: pick from the list of diagnoses. The foreign key would
       * refuse the first a moment later with `RELATED_RECORD_MISSING`, which
       * says «falta un registro relacionado» to somebody who typed a code.
       *
       * ⚠️ AND THE CATALOGUE CHECK IS THE HOLE THE FOREIGN KEY LEAVES OPEN:
       * `concept_id` points at `catalog_concept`, which holds every catalogue
       * there is, so nothing in the schema stops a DPA parish from being filed
       * as a disease — and `trg_diagnosis_snapshot` would accept it, since the
       * frozen code matches the concept perfectly well.
       */
      if (concept === undefined || concept.system_code !== CIE10) {
        throw new ConceptWrongCatalogueError(CIE10);
      }

      /**
       * EN-042, REQ-029. The same predicate `trg_diagnosis_concept_in_force`
       * uses, asked here so the refusal is a sentence. The trigger is still
       * the guarantee and this is not a substitute for it.
       */
      if (!concept.in_force) {
        throw new DiagnosisConceptNotInForceError();
      }

      /**
       * EN-043, EN-047. The order. Absent means «detrás del último», so the
       * first diagnosis of an attention becomes the principal and the
       * comorbidities queue behind it.
       */
      const ranksInUse = await tx.encounterDiagnosis.findMany({
        where: { encounterId: diagnosis.encounterId },
        select: { rank: true },
      });
      const rank =
        diagnosis.rank ?? nextRankAfter(ranksInUse.map((row) => row.rank));

      /**
       * EN-043. Read and decide, with `encounter_diagnosis_one_primary` as the
       * arbiter of the two writers who both read «libre» in the same
       * millisecond. The loser gets `DIAGNOSIS_PRIMARY_TAKEN` from the
       * constraint mapping — the same code, from the other path.
       */
      if (isPrimary(rank) && ranksInUse.some((row) => isPrimary(row.rank))) {
        throw new DiagnosisPrimaryTakenError();
      }

      return tx.encounterDiagnosis.create({
        data: {
          encounterId: diagnosis.encounterId,
          conceptId: diagnosis.conceptId,
          /**
           * EN-041. The snapshot, copied from the concept read in THIS
           * transaction. `trg_diagnosis_snapshot` refuses a code that does not
           * match the concept, so this is the only value the insert can carry
           * — which is the redundancy working as designed rather than becoming
           * the way a lie gets in.
           */
          cie10Code: concept.concept_code,
          cie10Display: concept.concept_display,
          certainty: diagnosis.certainty,
          occurrence: diagnosis.occurrence,
          rank,
          notifiable: diagnosis.notifiable ?? false,
          note: diagnosis.note,
        },
        select: DIAGNOSIS_SELECT,
      });
    });

    return toDiagnosisView(row);
  }

  /**
   * EN-047. The diagnoses of one attention, principal first.
   *
   * NARROWED THROUGH THE ATTENTION and not by the diagnosis table, which has
   * no site of its own: reading through the relation is what keeps the
   * diagnoses of another site's attention from answering to a caller who
   * cannot open the attention itself.
   */
  async diagnosesOf(query: CodingQuery): Promise<DiagnosisView[]> {
    const rows = await this.prisma.encounterDiagnosis.findMany({
      where: {
        encounterId: query.encounterId,
        encounter: siteFilter(query.sites),
      },
      // EN-043, EN-047. `rank` IS the priority order and 1 is the principal,
      // so this is the order the export takes its three from.
      orderBy: [{ rank: 'asc' }, { recordedAt: 'asc' }],
      select: DIAGNOSIS_SELECT,
    });
    return rows.map(toDiagnosisView);
  }

  /**
   * EN-189. What the certificates froze (CER-027), revoked ones included: the
   * paper may have circulated before it was annulled.
   */
  async codesPrintedOnCertificates(query: CodingQuery): Promise<string[]> {
    const rows = await this.prisma.medicalCertificate.findMany({
      where: {
        encounterId: query.encounterId,
        encounter: siteFilter(query.sites),
      },
      select: { diagnoses: true },
    });
    return [
      ...new Set(
        rows.flatMap((row) =>
          Array.isArray(row.diagnoses)
            ? row.diagnoses.flatMap((printed) =>
                typeof printed === 'object' &&
                printed !== null &&
                'code' in printed &&
                typeof printed.code === 'string'
                  ? [printed.code]
                  : [],
              )
            : [],
        ),
      ),
    ];
  }

  /**
   * EN-180 to EN-182, EN-188, EN-189. Archive, then delete — the order the
   * database demands.
   *
   * The two refusals are asked here, under the attention's lock, so they are
   * sentences: the triggers raise a class code whose name never travels.
   */
  async retractDiagnosis(retraction: DiagnosisRetraction): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const status = await requireEncounterInScope(
        tx,
        retraction.encounterId,
        retraction.sites,
        acceptsDiagnosisCorrection,
      );
      await requireDiagnosisOf(
        tx,
        retraction.encounterId,
        retraction.diagnosisId,
      );
      await refuseWhenCitedByIssuedDocument(tx, retraction.encounterId);

      // EN-188. A discharged attention keeps one: nothing new can be coded.
      if (hasDischarge(status)) {
        const left = await tx.encounterDiagnosis.count({
          where: { encounterId: retraction.encounterId },
        });
        if (left <= 1) throw new DiagnosisLastAfterDischargeError();
      }

      if (retraction.reason === null) {
        // The same function the archive's trigger calls: a signed note, the
        // discharge, or a certificate that printed the code.
        const [row] = await tx.$queryRaw<{ needs: boolean }[]>`
          SELECT encounter_diagnosis_retraction_needs_reason(
                   d.encounter_id, d.cie10_code) AS needs
            FROM encounter_diagnosis d
           WHERE d.id = ${retraction.diagnosisId}::uuid
        `;
        if (row?.needs) throw new DiagnosisRetractionReasonRequiredError();
      }

      await tx.$executeRaw`
        INSERT INTO "encounter_diagnosis_retraction"
          ("id", "encounter_id", "concept_id", "cie10_code", "cie10_display",
           "certainty", "occurrence", "rank", "notifiable", "note",
           "recorded_at", "retracted_by_id", "reason")
        SELECT "id", "encounter_id", "concept_id", "cie10_code", "cie10_display",
               "certainty", "occurrence", "rank", "notifiable", "note",
               "recorded_at", ${retraction.retractedById}::uuid, ${retraction.reason}
          FROM "encounter_diagnosis"
         WHERE "id" = ${retraction.diagnosisId}::uuid
      `;
      await tx.encounterDiagnosis.delete({
        where: { id: retraction.diagnosisId },
      });
    });
  }

  /**
   * EN-183. The previous principal moves first: with
   * `encounter_diagnosis_one_primary` there can never be two, not even for
   * the length of one statement.
   */
  async makePrimary(change: PrimaryChange): Promise<DiagnosisView[]> {
    await this.prisma.$transaction(async (tx) => {
      const status = await requireEncounterInScope(
        tx,
        change.encounterId,
        change.sites,
        acceptsDiagnosisCorrection,
      );
      const target = await requireDiagnosisOf(
        tx,
        change.encounterId,
        change.diagnosisId,
      );
      if (isPrimary(target.rank)) return;
      await refuseWhenCitedByIssuedDocument(tx, change.encounterId);

      const inUse = await tx.encounterDiagnosis.findMany({
        where: { encounterId: change.encounterId },
        select: { id: true, rank: true },
      });
      const previous = inUse.find((row) => isPrimary(row.rank));
      // EN-188. After the discharge only an EMPTY principal is filled: the
      // wrong one leaves through the archive, with its reason.
      if (previous && hasDischarge(status)) {
        throw new DiagnosisPrimaryAfterDischargeError();
      }
      if (previous) {
        await tx.encounterDiagnosis.update({
          where: { id: previous.id },
          data: { rank: nextRankAfter(inUse.map((row) => row.rank)) },
        });
      }
      await tx.encounterDiagnosis.update({
        where: { id: target.id },
        data: { rank: 1 },
      });
    });

    return this.diagnosesOf({
      encounterId: change.encounterId,
      sites: change.sites,
    });
  }

  /** EN-180. The archive of one attention, narrowed through the attention. */
  async retractedDiagnosesOf(
    query: CodingQuery,
  ): Promise<RetractedDiagnosisView[]> {
    const rows = await this.prisma.encounterDiagnosisRetraction.findMany({
      where: {
        encounterId: query.encounterId,
        encounter: siteFilter(query.sites),
      },
      orderBy: [{ retractedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        cie10Code: true,
        cie10Display: true,
        rank: true,
        retractedAt: true,
        reason: true,
        retractedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      cie10Code: row.cie10Code,
      cie10Display: row.cie10Display,
      rank: row.rank,
      retractedAt: row.retractedAt,
      retractedBy: {
        id: row.retractedBy.id,
        name: `${row.retractedBy.firstName} ${row.retractedBy.lastName}`,
      },
      reason: row.reason,
    }));
  }

  /** EN-187. The modality of a live attention, corrected under its lock. */
  async setCareModality(
    query: CodingQuery,
    careModality: CareModality,
  ): Promise<CareModality> {
    return this.prisma.$transaction(async (tx) => {
      await requireEncounterInScope(tx, query.encounterId, query.sites);
      const updated = await tx.encounter.update({
        where: { id: query.encounterId },
        data: { careModality },
        select: { careModality: true },
      });
      return updated.careModality;
    });
  }

  /** EN-050. Writes one procedure with its quantity. */
  async addProcedure(procedure: NewProcedure): Promise<ProcedureView> {
    const row = await this.prisma.$transaction(async (tx) => {
      await requireEncounterInScope(tx, procedure.encounterId, procedure.sites);

      const concept = await conceptForEncounter(
        tx,
        procedure.encounterId,
        procedure.conceptId,
      );

      // EN-050. Same argument as the diagnosis: the foreign key proves the row
      // exists and nothing about which catalogue it belongs to.
      if (concept === undefined || concept.system_code !== TARIFF) {
        throw new ConceptWrongCatalogueError(TARIFF);
      }

      return tx.encounterProcedure.create({
        data: {
          encounterId: procedure.encounterId,
          conceptId: procedure.conceptId,
          /**
           * EN-050. FROZEN HERE AND NOT BY A TRIGGER, which is the difference
           * from the diagnosis: there is no `trg_procedure_snapshot`, so
           * nothing in the database stops these two from being made to
           * disagree with the concept afterwards. The copy is taken from the
           * row read in this same transaction; the gap is noted on EN-050.
           */
          procedureCode: concept.concept_code,
          procedureDisplay: concept.concept_display,
          quantity: procedure.quantity,
          // EN-034. The instant of the ACT, which is not the instant of the
          // typing. Absent means «ahora», the ordinary case at the chairside.
          performedAt: procedure.performedAt,
          note: procedure.note,
          /**
           * ⚠️ `tariffAmount` IS ABSENT AND STAYS ABSENT (EN-051, D-049). What
           * the procedure costs is a `charge_item` of `billing`, resolved from
           * the price list of the attention's payer on the service date. A
           * clinical row that also carried the money would be two records in
           * one, and the clinical fact does not change because the patient did
           * not pay.
           */
        },
        select: PROCEDURE_SELECT,
      });
    });

    return toProcedureView(row);
  }

  /** EN-050. The procedures of one attention, in the order they happened. */
  async proceduresOf(query: CodingQuery): Promise<ProcedureView[]> {
    const rows = await this.prisma.encounterProcedure.findMany({
      where: {
        encounterId: query.encounterId,
        encounter: siteFilter(query.sites),
      },
      orderBy: [{ performedAt: 'asc' }, { id: 'asc' }],
      select: PROCEDURE_SELECT,
    });
    return rows.map(toProcedureView);
  }
}

/**
 * EN-121. The attention has to be inside the caller's scope, checked again
 * INSIDE the transaction that writes.
 *
 * The service already refused an attention out of scope, and this is not
 * ceremony: between that read and this write a grant can be revoked, and the
 * row that lands is the one that matters. It costs one indexed lookup and it
 * is the difference between an authorisation decision and an authorisation
 * hope.
 *
 * ⚠️ AND IT TAKES THE ATTENTION'S ROW `FOR UPDATE`, reading its status again
 * under the lock (EN-009, D-099 §1, §2). Annulling and interrupting lock the
 * same row (`lockAndRead`), so the two serialize: a diagnosis that waited for
 * an interruption sees it closed and is refused, and an interruption that
 * waited for a diagnosis sees the act and does not send the patient away as
 * not seen. The service's own check, taken before the transaction, could not
 * see either.
 */
async function requireEncounterInScope(
  tx: Prisma.TransactionClient,
  encounterId: string,
  sites: SiteScopeFilter,
  // EN-188. Correcting the coding reaches past the discharge; adding to it
  // does not.
  accepts: (status: EncounterStatus) => boolean = acceptsNewClinicalContent,
): Promise<EncounterStatus> {
  const encounter = await tx.encounter.findFirst({
    where: { id: encounterId, ...siteFilter(sites) },
    select: { id: true },
  });
  if (!encounter) throw new EncounterNotFoundError();

  const [locked] = await tx.$queryRaw<{ status: EncounterStatus }[]>`
    SELECT "status"::text AS "status"
      FROM "encounter"
     WHERE "id" = ${encounterId}::uuid
       FOR UPDATE
  `;
  if (!locked) throw new EncounterNotFoundError();
  if (!accepts(locked.status)) {
    throw new EncounterAlreadyClosedError(locked.status);
  }
  return locked.status;
}

/** EN-180, EN-183. The diagnosis, on THIS attention, or the one refusal. */
async function requireDiagnosisOf(
  tx: Prisma.TransactionClient,
  encounterId: string,
  diagnosisId: string,
): Promise<{ id: string; rank: number }> {
  const diagnosis = await tx.encounterDiagnosis.findFirst({
    where: { id: diagnosisId, encounterId },
    select: { id: true, rank: true },
  });
  if (!diagnosis) throw new DiagnosisNotFoundError();
  return diagnosis;
}

/**
 * EN-182. The same function the triggers call, so the sentence and the
 * guarantee cannot disagree about which papers read the diagnoses.
 */
async function refuseWhenCitedByIssuedDocument(
  tx: Prisma.TransactionClient,
  encounterId: string,
): Promise<void> {
  const [row] = await tx.$queryRaw<{ cited: boolean }[]>`
    SELECT encounter_has_document_citing_diagnoses(${encounterId}::uuid) AS cited
  `;
  if (row?.cited) throw new DiagnosisCitedByIssuedDocumentError();
}

/**
 * EN-040, EN-042, EN-050. Everything one statement can say about a concept in
 * the context of an attention: which catalogue it is from, what it is called,
 * and whether it was in force on the CLINICAL DATE of the attention.
 *
 * ⚠️ RAW SQL BECAUSE OF ONE COLUMN. `catalog_concept.valid_period` is a
 * `daterange` generated by a manual migration and Prisma models it as
 * `Unsupported`, so `@>` cannot be expressed through the client. Writing the
 * containment here rather than reading `valid_from`/`valid_to` and comparing
 * in TypeScript is deliberate: the trigger uses `@>` on the generated column,
 * and two statements of one predicate is how they end up disagreeing about the
 * last day a code was valid.
 *
 * ⚠️ AND THE DATE IS RESOLVED IN `America/Guayaquil`, exactly as
 * `trg_diagnosis_concept_in_force` does. A bare `::date` over a `timestamptz`
 * uses the SESSION's zone, so a diagnosis recorded at 20:00 on the last day a
 * code was in force would be checked against the following day and refused —
 * which is the defect `20260806040611_clinical_date_in_ecuador_timezone`
 * exists to have fixed.
 */
async function conceptForEncounter(
  tx: Prisma.TransactionClient,
  encounterId: string,
  conceptId: string,
): Promise<ConceptRow | undefined> {
  const rows = await tx.$queryRaw<ConceptRow[]>`
    SELECT cs."code"::text                 AS system_code,
           cc."code"::text                 AS concept_code,
           cc."display"::text              AS concept_display,
           (cc."valid_period" @> (e."started_at" AT TIME ZONE 'America/Guayaquil')::date)
                                           AS in_force
      FROM "encounter" AS e
      JOIN "catalog_concept" AS cc ON cc."id" = ${conceptId}::uuid
      JOIN "catalog_system"  AS cs ON cs."id" = cc."system_id"
     WHERE e."id" = ${encounterId}::uuid
  `;
  return rows[0];
}

/**
 * EN-121. The caller's resolved scope as a `where` fragment on the attention.
 *
 * `'all'` yields no filter, and an empty list never reaches here: `siteScope`
 * in `shared/authorisation` throws `SITE_SCOPE_DENIED` when the caller holds
 * the permission at no site, precisely so «no filter to apply» can never be
 * spelled as «every site».
 */
function siteFilter(sites: SiteScopeFilter): Prisma.EncounterWhereInput {
  return sites === 'all' ? {} : { siteId: { in: [...sites] } };
}

/** An `encounter_diagnosis` row as the domain reads it. */
function toDiagnosisView(row: DiagnosisRow): DiagnosisView {
  return {
    id: row.id,
    encounterId: row.encounterId,
    conceptId: row.conceptId,
    cie10Code: row.cie10Code,
    cie10Display: row.cie10Display,
    certainty: row.certainty,
    occurrence: row.occurrence,
    rank: row.rank,
    /**
     * EN-046. DERIVED FROM THE FROZEN CODE, never from
     * `encounter.care_modality`. A consultation that monitors a pregnancy
     * (Z34) and treats a pharyngitis (J02) is prevention AND morbidity at
     * once, and one mark on the attention forces choosing one and lying about
     * the other — which is columns 84 and 85 of the monthly report.
     *
     * Read off the FROZEN code and not off the concept, so a report
     * reprocessed in five years classifies the row exactly as it was
     * classified the day it was written.
     */
    careModality: careModalityOfCie10(row.cie10Code),
    notifiable: row.notifiable,
    note: row.note,
    recordedAt: row.recordedAt,
  };
}

/** An `encounter_procedure` row as the domain reads it. NO AMOUNT (EN-051). */
function toProcedureView(row: ProcedureRow): ProcedureView {
  return {
    id: row.id,
    encounterId: row.encounterId,
    conceptId: row.conceptId,
    procedureCode: row.procedureCode,
    procedureDisplay: row.procedureDisplay,
    quantity: row.quantity,
    performedAt: row.performedAt,
    note: row.note,
  };
}
