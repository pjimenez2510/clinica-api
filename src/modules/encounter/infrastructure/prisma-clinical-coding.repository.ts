import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  ConceptWrongCatalogueError,
  DiagnosisConceptNotInForceError,
  DiagnosisNotFoundError,
  DiagnosisPrimaryTakenError,
  DiagnosisPrincipalUseInvalidError,
  DiagnosisRetractionReasonRequiredError,
  DiagnosisLastAfterDischargeError,
  DiagnosisPrimaryRequiredAfterDischargeError,
  DiagnosisCorrectionRequiresSignatureError,
  DiagnosisNotRestorableError,
  DiagnosisEditReasonRequiredError,
  DiagnosisSupportsMaternityRestError,
  EncounterAlreadyClosedError,
  EncounterAlreadyReportedError,
  ProcedureCorrectionRequiresSignatureError,
  ProcedurePerformedAtRequiredError,
  ProcedurePerformedOutsideEncounterError,
  EncounterNotFoundError,
  PractitionerNotLicensedError,
  PractitionerProfileRequiredError,
  ProcedureNotFoundError,
  ProcedureNotRestorableError,
  ConsentRequiredError,
} from '../domain/encounter.errors';
import type {
  CareModality,
  CarePlace,
  EncounterStatus,
  VisitSequence,
} from '../domain/encounter';
import {
  acceptsDiagnosisCorrection,
  acceptsNewClinicalContent,
  hasDischarge,
} from '../domain/encounter-state';
import {
  type Cie10Use,
  careModalityOfCie10,
  cie10UseOf,
  isPrimary,
  mayBePrincipal,
  nextRankAfter,
  rankOnRestore,
} from '../domain/diagnosis';
import type {
  AfterDischargeRefusal,
  ClinicalCodingRepository,
  CodingQuery,
  CorrectionAuthority,
  DiagnosisEdit,
  DiagnosisQuery,
  DiagnosisRestoration,
  DiagnosisRetraction,
  DiagnosisVersionView,
  DiagnosisView,
  EncounterCodingCorrection,
  EncounterCodingView,
  NewDiagnosis,
  PrimaryChange,
  RetractedDiagnosisView,
  NewProcedure,
  ProcedureEdit,
  ProcedureQuery,
  ProcedureRestoration,
  ProcedureRetraction,
  ProcedureVersionView,
  ProcedureView,
  RecordedProcedureView,
  RetractedProcedureView,
} from '../domain/clinical-coding.repository';
import type { SiteScopeFilter } from '../domain/encounter.repository';
import type { RefusalView } from '../domain/procedure-consent';
import {
  consentsByProcedure,
  insertProcedureConsent,
  refusalsOf as refusalsOfEncounter,
  requiresWrittenConsent,
  writtenConsentCovers,
} from './procedure-consent.records';

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
  editedAt: true,
} satisfies Prisma.EncounterDiagnosisSelect;

/** The row `DIAGNOSIS_SELECT` yields, derived from it so the two cannot drift. */
type DiagnosisRow = Prisma.EncounterDiagnosisGetPayload<{
  select: typeof DIAGNOSIS_SELECT;
}>;

/**
 * EN-235. `DIAGNOSIS_SELECT` with the concept's attributes, which say whether
 * it may be the principal. What every read of a live diagnosis selects.
 */
const DIAGNOSIS_WITH_USE_SELECT = {
  ...DIAGNOSIS_SELECT,
  concept: { select: { attributes: true } },
} satisfies Prisma.EncounterDiagnosisSelect;

type DiagnosisWithUseRow = Prisma.EncounterDiagnosisGetPayload<{
  select: typeof DIAGNOSIS_WITH_USE_SELECT;
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
  editedAt: true,
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
  /** EN-235. `attributes.use`, as the WHO import wrote it. */
  use: string | null;
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
      // EN-215 (D-117.12). After the discharge too: the right code is added,
      // by whoever may correct then (D-117.13), never once reported (D-117.16).
      const status = await requireEncounterInScope(
        tx,
        diagnosis.encounterId,
        diagnosis.sites,
        acceptsDiagnosisCorrection,
      );
      await refuseCorrection(tx, diagnosis.encounterId, status, diagnosis);

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
      // EN-235. The trigger is the guarantee; this is its sentence.
      if (isPrimary(rank) && !conceptMayBePrincipal(concept)) {
        throw new DiagnosisPrincipalUseInvalidError();
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
        select: DIAGNOSIS_WITH_USE_SELECT,
      });
    });

    return toLiveDiagnosisView(row);
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
      select: DIAGNOSIS_WITH_USE_SELECT,
    });
    return rows.map(toLiveDiagnosisView);
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
    return [...new Set(rows.flatMap((row) => printedCodes(row.diagnoses)))];
  }

  /**
   * EN-214 (D-117.14). What the issued recetas froze (PR-026), annulled ones
   * included: the pharmacy may hold the paper.
   */
  async codesPrintedOnPrescriptions(query: CodingQuery): Promise<string[]> {
    const rows = await this.prisma.prescription.findMany({
      where: {
        encounterId: query.encounterId,
        issuedAt: { not: null },
        encounter: siteFilter(query.sites),
      },
      select: { diagnoses: true },
    });
    return [...new Set(rows.flatMap((row) => printedCodes(row.diagnoses)))];
  }

  /**
   * ORD-121. What the issued orders froze: the laboratory holds the paper.
   */
  async codesPrintedOnOrders(query: CodingQuery): Promise<string[]> {
    const rows = await this.prisma.serviceOrder.findMany({
      where: {
        encounterId: query.encounterId,
        status: 'ISSUED',
        encounter: siteFilter(query.sites),
      },
      select: { diagnoses: true },
    });
    return [...new Set(rows.flatMap((row) => printedCodes(row.diagnoses)))];
  }

  /**
   * EN-180, EN-188, EN-213, EN-214. Archive, then delete — the order the
   * database demands.
   *
   * The refusals are asked here, under the attention's lock, so they are
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
      await refuseCorrection(tx, retraction.encounterId, status, retraction);
      const target = await requireDiagnosisOf(
        tx,
        retraction.encounterId,
        retraction.diagnosisId,
      );

      // D-117.15. No reason makes it acceptable: the rest is annulled first.
      const [maternity] = await tx.$queryRaw<{ refused: boolean }[]>`
        SELECT (cie10_is_obstetric(d.cie10_code)
                AND encounter_diagnosis_supports_maternity_rest(
                      d.encounter_id, d.id)) AS refused
          FROM encounter_diagnosis d
         WHERE d.id = ${retraction.diagnosisId}::uuid
      `;
      if (maternity?.refused) throw new DiagnosisSupportsMaternityRestError();

      // EN-188. A discharged attention keeps one: nothing new can be coded.
      if (hasDischarge(status)) {
        const left = await tx.encounterDiagnosis.count({
          where: { encounterId: retraction.encounterId },
        });
        if (left <= 1) throw new DiagnosisLastAfterDischargeError();
        // EN-183, EN-188. Nor without a principal: another is marked first.
        if (isPrimary(target.rank)) {
          throw new DiagnosisPrimaryRequiredAfterDischargeError();
        }
      }

      if (retraction.reason === null) {
        // The same function the archive's trigger calls: an issued
        // certificate or receta that printed the code (EN-214).
        const [row] = await tx.$queryRaw<{ needs: boolean }[]>`
          SELECT encounter_diagnosis_retraction_needs_reason(
                   d.encounter_id, d.cie10_code) AS needs
            FROM encounter_diagnosis d
           WHERE d.id = ${retraction.diagnosisId}::uuid
        `;
        if (row?.needs) throw new DiagnosisRetractionReasonRequiredError();
      }

      // EN-212. The last edit goes with it — who, when and why — or the
      // reason for recoding what a paper printed is lost with the live row
      // (`encounter_diagnosis_retraction_matches` demands it).
      await tx.$executeRaw`
        INSERT INTO "encounter_diagnosis_retraction"
          ("id", "encounter_id", "concept_id", "cie10_code", "cie10_display",
           "certainty", "occurrence", "rank", "notifiable", "note",
           "recorded_at", "retracted_by_id", "reason",
           "edited_by_id", "edited_at", "edit_reason")
        SELECT "id", "encounter_id", "concept_id", "cie10_code", "cie10_display",
               "certainty", "occurrence", "rank", "notifiable", "note",
               "recorded_at", ${retraction.retractedById}::uuid, ${retraction.reason},
               "edited_by_id", "edited_at", "edit_reason"
          FROM "encounter_diagnosis"
         WHERE "id" = ${retraction.diagnosisId}::uuid
      `;
      await tx.encounterDiagnosis.delete({
        where: { id: retraction.diagnosisId },
      });
    });
  }

  /**
   * EN-183, EN-212. The previous principal moves first: with
   * `encounter_diagnosis_one_primary` there can never be two, not even for
   * the length of one statement. Both moves are edits, stamped, so both
   * previous ranks are versions (D-127). After the discharge too: the
   * principal changes in one click (EN-212 retired EN-188's G2).
   */
  async makePrimary(change: PrimaryChange): Promise<DiagnosisView[]> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const status = await requireEncounterInScope(
        tx,
        change.encounterId,
        change.sites,
        acceptsDiagnosisCorrection,
      );
      await refuseCorrection(tx, change.encounterId, status, change);
      const target = await requireDiagnosisOf(
        tx,
        change.encounterId,
        change.diagnosisId,
      );
      if (isPrimary(target.rank)) return;
      // EN-235. Asked before anything moves: the trigger says it too.
      if (!mayBePrincipal(target.use)) {
        throw new DiagnosisPrincipalUseInvalidError();
      }
      await promote(tx, change.encounterId, target, change, now);
    });

    return this.diagnosesOf({
      encounterId: change.encounterId,
      sites: change.sites,
    });
  }

  /**
   * EN-212. Edits in place under the attention's lock. The refusals the
   * triggers also make are asked here first, in the order a doctor can act
   * on them, so each is a sentence: `trg_encounter_diagnosis_edit_admits`
   * raises a class code whose name a client cannot branch on.
   */
  async editDiagnosis(edit: DiagnosisEdit): Promise<DiagnosisView> {
    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      const status = await requireEncounterInScope(
        tx,
        edit.encounterId,
        edit.sites,
        acceptsDiagnosisCorrection,
      );
      await refuseCorrection(tx, edit.encounterId, status, edit);
      const current = await tx.encounterDiagnosis.findFirst({
        where: { id: edit.diagnosisId, encounterId: edit.encounterId },
        select: DIAGNOSIS_WITH_USE_SELECT,
      });
      if (!current) throw new DiagnosisNotFoundError();
      // EN-235. Whether the code it ends with may be the principal.
      let endsMayBePrincipal = mayBePrincipal(
        cie10UseOf(current.concept.attributes),
      );

      let identity: Prisma.EncounterDiagnosisUncheckedUpdateInput = {};
      if (
        edit.conceptId !== undefined &&
        edit.conceptId !== current.conceptId
      ) {
        const concept = await conceptForEncounter(
          tx,
          edit.encounterId,
          edit.conceptId,
        );
        // EN-040, EN-042: the same two refusals as registering one.
        if (concept === undefined || concept.system_code !== CIE10) {
          throw new ConceptWrongCatalogueError(CIE10);
        }
        if (!concept.in_force) throw new DiagnosisConceptNotInForceError();
        endsMayBePrincipal = conceptMayBePrincipal(concept);

        if (concept.concept_code !== current.cie10Code) {
          const [paper] = await tx.$queryRaw<
            { printed: boolean; maternity: boolean }[]
          >`
            SELECT encounter_diagnosis_code_on_paper(
                     ${edit.encounterId}::uuid, ${current.cie10Code}) AS printed,
                   (cie10_is_obstetric(${current.cie10Code})
                    AND NOT cie10_is_obstetric(${concept.concept_code})
                    AND encounter_diagnosis_supports_maternity_rest(
                          ${edit.encounterId}::uuid, ${current.id}::uuid)) AS maternity
          `;
          // D-117.15 first: no reason makes it acceptable.
          if (paper?.maternity) throw new DiagnosisSupportsMaternityRestError();
          if (paper?.printed && edit.reason === null) {
            throw new DiagnosisEditReasonRequiredError();
          }
        }
        identity = {
          conceptId: edit.conceptId,
          // EN-041. Copied from the concept read in THIS transaction; the
          // display is the database's on an UPDATE in any case.
          cie10Code: concept.concept_code,
          cie10Display: concept.concept_display,
        };
      }

      // EN-235. It becomes the principal, or the principal changes its code,
      // to a code that may not be one. A principal coded before the rule is
      // not judged while neither its rank nor its code changes.
      const becomesPrincipal =
        edit.primary === true && !isPrimary(current.rank);
      const principalRecoded =
        isPrimary(current.rank) &&
        edit.primary !== false &&
        'conceptId' in identity;
      if ((becomesPrincipal || principalRecoded) && !endsMayBePrincipal) {
        throw new DiagnosisPrincipalUseInvalidError();
      }

      let rank: number | undefined;
      if (edit.primary === true && !isPrimary(current.rank)) {
        await promote(tx, edit.encounterId, current, edit, now);
        // `promote` already wrote the rank, stamped; the rest goes below.
      } else if (edit.primary === false && isPrimary(current.rank)) {
        // EN-183, EN-188. After the discharge the attention keeps one: the
        // way out is marking another, which moves this one behind.
        if (hasDischarge(status)) {
          throw new DiagnosisPrimaryRequiredAfterDischargeError();
        }
        const inUse = await tx.encounterDiagnosis.findMany({
          where: { encounterId: edit.encounterId },
          select: { rank: true },
        });
        rank = nextRankAfter(inUse.map((r) => r.rank));
      }

      const changes: Prisma.EncounterDiagnosisUncheckedUpdateInput = {
        ...identity,
        ...(edit.certainty !== undefined && edit.certainty !== current.certainty
          ? { certainty: edit.certainty }
          : {}),
        ...(edit.occurrence !== undefined &&
        edit.occurrence !== current.occurrence
          ? { occurrence: edit.occurrence }
          : {}),
        ...(rank === undefined ? {} : { rank }),
      };
      // Nothing to change is not an edit: no version of an identical row.
      if (Object.keys(changes).length === 0) {
        return tx.encounterDiagnosis.findUniqueOrThrow({
          where: { id: current.id },
          select: DIAGNOSIS_WITH_USE_SELECT,
        });
      }

      const [stamped] = await tx.$queryRaw<{ edited_at: Date | null }[]>`
        SELECT edited_at FROM encounter_diagnosis
         WHERE id = ${current.id}::uuid
         FOR UPDATE`;
      return tx.encounterDiagnosis.update({
        where: { id: current.id },
        data: {
          ...changes,
          // The reason belongs to THIS edit: never carried over.
          editReason: 'cie10Code' in identity ? edit.reason : null,
          editedById: edit.editedById,
          editedAt: stampAfter(stamped?.edited_at ?? null, now),
        },
        select: DIAGNOSIS_WITH_USE_SELECT,
      });
    });

    return toLiveDiagnosisView(row);
  }

  /**
   * EN-212. The versions `record_version_archive` kept, read through the SAME
   * mapping as the current diagnosis. The reason of each replacement is on
   * the row that replaced it: the next version, or the current one — the
   * live row, or its archive once it was removed (the archive keeps the last
   * edit, `encounter_diagnosis_retraction_matches`).
   *
   * EN-213. «Deshacer» brings a diagnosis back as a NEW row (`restored_as_id`
   * on the archive of the old one): the versions of the earlier rows follow,
   * newest first, so undoing a removal does not hide what was corrected
   * before it. Each keeps the `version` number of its own row.
   */
  async diagnosisVersions(
    query: DiagnosisQuery,
  ): Promise<DiagnosisVersionView[]> {
    const where = {
      id: query.diagnosisId,
      encounterId: query.encounterId,
      encounter: siteFilter(query.sites),
    };
    const [live, archived] = await Promise.all([
      this.prisma.encounterDiagnosis.findFirst({
        where,
        select: { editReason: true },
      }),
      this.prisma.encounterDiagnosisRetraction.findFirst({
        where,
        select: { editReason: true },
      }),
    ]);
    if (live === null && archived === null) throw new DiagnosisNotFoundError();

    // The rows this one was restored from, each found by the archive that
    // names it as what it came back as. Bounded: a cycle is impossible (each
    // restoration is a new id) and a lineage this long is not a real one.
    const lineage = [
      {
        id: query.diagnosisId,
        headReason: live?.editReason ?? archived?.editReason ?? null,
      },
    ];
    for (let depth = 0; depth < 50; depth += 1) {
      const earlier = await this.prisma.encounterDiagnosisRetraction.findFirst({
        where: {
          restoredAsId: lineage[lineage.length - 1]!.id,
          encounterId: query.encounterId,
        },
        select: { id: true, editReason: true },
      });
      if (earlier === null) break;
      lineage.push({ id: earlier.id, headReason: earlier.editReason });
    }

    const pending: (Omit<DiagnosisVersionView, 'diagnosis'> & {
      snapshot: DiagnosisSnapshot;
    })[] = [];
    for (const row of lineage) {
      const versions = await this.prisma.recordVersion.findMany({
        where: { resourceType: 'encounter_diagnosis', resourceId: row.id },
        orderBy: { version: 'desc' },
        select: {
          version: true,
          data: true,
          changedAt: true,
          changedBy: { select: { id: true, firstName: true, lastName: true } },
        },
      });
      versions.forEach((version, index) => {
        const replacing =
          index === 0
            ? row.headReason
            : (versions[index - 1]!.data as unknown as DiagnosisSnapshot)
                .edit_reason;
        pending.push({
          version: version.version,
          replacedBy: {
            id: version.changedBy.id,
            name: `${version.changedBy.firstName} ${version.changedBy.lastName}`,
          },
          replacedAt: version.changedAt,
          reason: replacing ?? null,
          snapshot: version.data as unknown as DiagnosisSnapshot,
        });
      });
    }

    // EN-235. The use of every concept the versions name, in one statement.
    const concepts = await this.prisma.catalogConcept.findMany({
      where: {
        id: { in: [...new Set(pending.map((v) => v.snapshot.concept_id))] },
      },
      select: { id: true, attributes: true },
    });
    const useOf = new Map(
      concepts.map((concept) => [concept.id, cie10UseOf(concept.attributes)]),
    );
    return pending.map(({ snapshot, ...version }) => ({
      ...version,
      diagnosis: toDiagnosisView(
        diagnosisRowFromSnapshot(snapshot),
        useOf.get(snapshot.concept_id) ?? null,
      ),
    }));
  }

  /**
   * EN-213. «Deshacer». The diagnosis comes back as a NEW row: the archive's
   * id is the old row's, and a second removal will need it. Everything else
   * as it was, including when it was recorded; the rank, coherent with what
   * happened meanwhile.
   */
  async restoreDiagnosis(
    restoration: DiagnosisRestoration,
  ): Promise<DiagnosisView> {
    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      await requireEncounterInScope(
        tx,
        restoration.encounterId,
        restoration.sites,
      );
      const archived = await tx.encounterDiagnosisRetraction.findFirst({
        where: {
          id: restoration.retractionId,
          encounterId: restoration.encounterId,
        },
      });
      if (!archived) throw new DiagnosisNotFoundError();
      if (archived.restoredAt !== null) throw new DiagnosisNotRestorableError();

      const live = await tx.encounterDiagnosis.findMany({
        where: { encounterId: restoration.encounterId },
        select: { rank: true, cie10Code: true },
      });
      // Recorded again meanwhile: it would be there twice.
      if (live.some((d) => d.cie10Code === archived.cie10Code)) {
        throw new DiagnosisNotRestorableError();
      }
      // A principal comes back as principal only if the place is still free
      // and its code may still be the principal (EN-235): otherwise behind.
      const concept = await tx.catalogConcept.findUnique({
        where: { id: archived.conceptId },
        select: { attributes: true },
      });
      const rank = rankOnRestore(
        archived.rank,
        live.map((d) => d.rank),
        mayBePrincipal(cie10UseOf(concept?.attributes ?? null)),
      );

      const restored = await tx.encounterDiagnosis.create({
        data: {
          encounterId: archived.encounterId,
          conceptId: archived.conceptId,
          cie10Code: archived.cie10Code,
          cie10Display: archived.cie10Display,
          certainty: archived.certainty,
          occurrence: archived.occurrence,
          rank,
          notifiable: archived.notifiable,
          note: archived.note,
          recordedAt: archived.recordedAt,
        },
        select: DIAGNOSIS_WITH_USE_SELECT,
      });
      // `encounter_diagnosis_retraction_frozen` admits this once, and only
      // towards that very diagnosis back on its attention.
      await tx.encounterDiagnosisRetraction.update({
        where: { id: archived.id },
        data: {
          restoredAt: now,
          restoredById: restoration.restoredById,
          restoredAsId: restored.id,
        },
      });
      return restored;
    });

    return toLiveDiagnosisView(row);
  }

  /**
   * EN-180, EN-213. The archive of one attention, narrowed through the
   * attention, without what was brought back: «Deshacer» means it was not
   * removed after all (the archive keeps saying it was, and who undid it).
   */
  async retractedDiagnosesOf(
    query: CodingQuery,
  ): Promise<RetractedDiagnosisView[]> {
    const rows = await this.prisma.encounterDiagnosisRetraction.findMany({
      where: {
        encounterId: query.encounterId,
        restoredAt: null,
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

  /** EN-187, EN-215. The attention's coding, corrected under its lock. */
  async correctEncounterCoding(
    correction: EncounterCodingCorrection,
  ): Promise<EncounterCodingView> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const status = await requireEncounterInScope(
        tx,
        correction.encounterId,
        correction.sites,
        acceptsDiagnosisCorrection,
      );
      await refuseCorrection(tx, correction.encounterId, status, correction);

      const current = await tx.encounter.findUniqueOrThrow({
        where: { id: correction.encounterId },
        select: { ...CODING_SELECT, correctedAt: true },
      });
      const changes = {
        ...(correction.careModality !== undefined &&
        correction.careModality !== current.careModality
          ? { careModality: correction.careModality }
          : {}),
        ...(correction.visitSequence !== undefined &&
        correction.visitSequence !== current.visitSequence
          ? { visitSequence: correction.visitSequence }
          : {}),
        ...(correction.carePlace !== undefined &&
        correction.carePlace !== current.carePlace
          ? { carePlace: correction.carePlace }
          : {}),
        ...(correction.medicoDelBarrio !== undefined &&
        correction.medicoDelBarrio !== current.medicoDelBarrio
          ? { medicoDelBarrio: correction.medicoDelBarrio }
          : {}),
      };
      // Nothing to change is not an edit: no version of an identical row.
      if (Object.keys(changes).length === 0) {
        return toCodingView(current);
      }

      // EN-210. `trg_encounter_record_version` keeps the previous attention
      // and refuses a correction whose stamp did not move.
      return toCodingView(
        await tx.encounter.update({
          where: { id: correction.encounterId },
          data: {
            ...changes,
            correctedById: correction.editedById,
            correctedAt: stampAfter(current.correctedAt, now),
          },
          select: CODING_SELECT,
        }),
      );
    });
  }

  /**
   * EN-050, EN-152. Writes one procedure with its quantity and, when its
   * concept's service demands it, its form 024 — in the same transaction, so
   * `encounter_procedure_consent_required` sees both at the commit.
   */
  async addProcedure(procedure: NewProcedure): Promise<RecordedProcedureView> {
    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      // EN-247 (D-194.1). After the discharge too, by whoever may correct
      // then (D-117.13), never once reported (D-117.16).
      const status = await requireEncounterInScope(
        tx,
        procedure.encounterId,
        procedure.sites,
        acceptsDiagnosisCorrection,
      );
      await refuseCorrection(
        tx,
        procedure.encounterId,
        status,
        procedure,
        'procedure',
      );
      // EN-247 (D-201). After the discharge «ahora» is not when it was done:
      // the hour is stated, within the attention. The trigger
      // `encounter_procedure_performed_within_encounter` is the guarantee.
      if (hasDischarge(status)) {
        if (procedure.performedAt === undefined) {
          throw new ProcedurePerformedAtRequiredError();
        }
        const span = await tx.encounter.findUniqueOrThrow({
          where: { id: procedure.encounterId },
          select: { startedAt: true, endedAt: true },
        });
        if (
          procedure.performedAt < span.startedAt ||
          (span.endedAt !== null && procedure.performedAt > span.endedAt)
        ) {
          throw new ProcedurePerformedOutsideEncounterError();
        }
      }

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
      // EN-152. Asked inside the write: the mark may have changed since the
      // screen asked. EN-151: without the mark nothing is asked.
      if (
        procedure.consent === undefined &&
        (await requiresWrittenConsent(tx, procedure.conceptId))
      ) {
        throw new ConsentRequiredError();
      }

      const created = await tx.encounterProcedure.create({
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
          // typing. Absent means «ahora», the ordinary case at the chairside —
          // the application's clock, which the 024's signature is compared to.
          performedAt: procedure.performedAt ?? now,
          // BI-242. When it was typed, which caja compares to its close.
          recordedAt: now,
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
      if (procedure.consent !== undefined) {
        await insertProcedureConsent(
          tx,
          created,
          procedure.consent.paper,
          procedure.consent.recordedById,
          now,
        );
      }
      return created;
    });

    return this.withConsent(row);
  }

  /** EN-050, EN-152. The procedures of one attention, in the order they happened. */
  async proceduresOf(query: CodingQuery): Promise<RecordedProcedureView[]> {
    const rows = await this.prisma.encounterProcedure.findMany({
      where: {
        encounterId: query.encounterId,
        encounter: siteFilter(query.sites),
      },
      orderBy: [{ performedAt: 'asc' }, { id: 'asc' }],
      select: PROCEDURE_SELECT,
    });
    const consents = await consentsByProcedure(
      this.prisma,
      query.encounterId,
      rows,
    );
    return rows.map((row) => ({
      ...toProcedureView(row),
      consent: consents.get(row.id) ?? null,
    }));
  }

  /** EN-153. The refusals of one attention, inside the caller's scope. */
  async refusalsOf(query: CodingQuery): Promise<RefusalView[]> {
    const inScope = await this.prisma.encounter.count({
      where: { id: query.encounterId, ...siteFilter(query.sites) },
    });
    return inScope === 0 ? [] : refusalsOfEncounter(this.prisma, query.encounterId); // prettier-ignore
  }

  /** One live procedure with the 024 that covers it. */
  private async withConsent(row: ProcedureRow): Promise<RecordedProcedureView> {
    const consents = await consentsByProcedure(this.prisma, row.encounterId, [row]); // prettier-ignore
    return { ...toProcedureView(row), consent: consents.get(row.id) ?? null };
  }

  /**
   * EN-244. A correction in place, under the attention's lock and only while
   * it admits new content (the same rule as recording, EN-009). A new concept
   * is checked against the tariff and its code copied from the row read in
   * this transaction (EN-050). `trg_encounter_procedure_record_version` keeps
   * the previous row and refuses an edit whose stamp did not move.
   */
  async editProcedure(edit: ProcedureEdit): Promise<RecordedProcedureView> {
    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      // EN-247. After the discharge too, asked again under the lock.
      const status = await requireEncounterInScope(
        tx,
        edit.encounterId,
        edit.sites,
        acceptsDiagnosisCorrection,
      );
      await refuseCorrection(tx, edit.encounterId, status, edit, 'procedure');
      const current = await tx.encounterProcedure.findFirst({
        where: { id: edit.procedureId, encounterId: edit.encounterId },
        select: { ...PROCEDURE_SELECT },
      });
      if (!current) throw new ProcedureNotFoundError();

      let identity: Prisma.EncounterProcedureUncheckedUpdateInput = {};
      if (
        edit.conceptId !== undefined &&
        edit.conceptId !== current.conceptId
      ) {
        const concept = await conceptForEncounter(
          tx,
          edit.encounterId,
          edit.conceptId,
        );
        if (concept === undefined || concept.system_code !== TARIFF) {
          throw new ConceptWrongCatalogueError(TARIFF);
        }
        // EN-152. Correcting INTO a concept that demands the 024 needs a
        // consent of that concept already on the procedure.
        if (
          (await requiresWrittenConsent(tx, edit.conceptId)) &&
          !(await writtenConsentCovers(tx, current.id, edit.conceptId))
        ) {
          throw new ConsentRequiredError('correction');
        }
        identity = {
          conceptId: edit.conceptId,
          procedureCode: concept.concept_code,
          procedureDisplay: concept.concept_display,
        };
      }
      const note =
        edit.note === undefined
          ? undefined
          : edit.note === null || edit.note === ''
            ? null
            : edit.note;
      const changes: Prisma.EncounterProcedureUncheckedUpdateInput = {
        ...identity,
        ...(edit.quantity !== undefined && edit.quantity !== current.quantity
          ? { quantity: edit.quantity }
          : {}),
        ...(note !== undefined && note !== current.note ? { note } : {}),
      };
      // Nothing to change is not an edit: no version of an identical row.
      if (Object.keys(changes).length === 0) return current;

      const [stamped] = await tx.$queryRaw<{ edited_at: Date | null }[]>`
        SELECT edited_at FROM encounter_procedure
         WHERE id = ${current.id}::uuid
         FOR UPDATE`;
      return tx.encounterProcedure.update({
        where: { id: current.id },
        data: {
          ...changes,
          editedById: edit.editedById,
          editedAt: stampAfter(stamped?.edited_at ?? null, now),
        },
        select: PROCEDURE_SELECT,
      });
    });
    return this.withConsent(row);
  }

  /**
   * EN-244. The versions `record_version_archive` kept, read through the SAME
   * mapping as the current procedure. A restored procedure is a new row
   * (EN-246): the versions of the row it came back from follow, so undoing a
   * removal does not hide what was corrected before it.
   */
  async procedureVersions(
    query: ProcedureQuery,
  ): Promise<ProcedureVersionView[]> {
    const where = {
      id: query.procedureId,
      encounterId: query.encounterId,
      encounter: siteFilter(query.sites),
    };
    const [live, archived] = await Promise.all([
      this.prisma.encounterProcedure.findFirst({ where, select: { id: true } }),
      this.prisma.encounterProcedureRetraction.findFirst({
        where,
        select: { id: true },
      }),
    ]);
    if (live === null && archived === null) throw new ProcedureNotFoundError();

    const lineage = [query.procedureId];
    for (let depth = 0; depth < 50; depth += 1) {
      const earlier = await this.prisma.encounterProcedureRetraction.findFirst({
        where: {
          restoredAsId: lineage[lineage.length - 1]!,
          encounterId: query.encounterId,
        },
        select: { id: true },
      });
      if (earlier === null) break;
      lineage.push(earlier.id);
    }

    const result: ProcedureVersionView[] = [];
    for (const id of lineage) {
      const versions = await this.prisma.recordVersion.findMany({
        where: { resourceType: 'encounter_procedure', resourceId: id },
        orderBy: { version: 'desc' },
        select: {
          version: true,
          data: true,
          changedAt: true,
          changedBy: { select: { id: true, firstName: true, lastName: true } },
        },
      });
      for (const version of versions) {
        result.push({
          version: version.version,
          replacedBy: {
            id: version.changedBy.id,
            name: `${version.changedBy.firstName} ${version.changedBy.lastName}`,
          },
          replacedAt: version.changedAt,
          procedure: procedureFromSnapshot(
            version.data as unknown as ProcedureSnapshot,
          ),
        });
      }
    }
    return result;
  }

  /**
   * EN-245. Archives the procedure whole — with its last correction, who
   * removed it, when and why — and removes it, in one transaction under the
   * attention's lock. The instant is the application's clock.
   */
  async retractProcedure(retraction: ProcedureRetraction): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // EN-247. After the discharge too, asked again under the lock.
      const status = await requireEncounterInScope(
        tx,
        retraction.encounterId,
        retraction.sites,
        acceptsDiagnosisCorrection,
      );
      await refuseCorrection(
        tx,
        retraction.encounterId,
        status,
        retraction,
        'procedure',
      );
      const target = await tx.encounterProcedure.findFirst({
        where: {
          id: retraction.procedureId,
          encounterId: retraction.encounterId,
        },
        select: { id: true },
      });
      if (!target) throw new ProcedureNotFoundError();

      await tx.$executeRaw`
        INSERT INTO "encounter_procedure_retraction"
          ("id", "encounter_id", "concept_id", "procedure_code",
           "procedure_display", "quantity", "performed_at", "note",
           "tariff_amount", "edited_by_id", "edited_at",
           "retracted_at", "retracted_by_id", "reason")
        SELECT "id", "encounter_id", "concept_id", "procedure_code",
               "procedure_display", "quantity", "performed_at", "note",
               "tariff_amount", "edited_by_id", "edited_at",
               ${now}, ${retraction.retractedById}::uuid, ${retraction.reason}
          FROM "encounter_procedure"
         WHERE "id" = ${retraction.procedureId}::uuid
      `;
      await tx.encounterProcedure.delete({
        where: { id: retraction.procedureId },
      });
    });
  }

  /**
   * EN-246. The procedure comes back as a NEW row, as it was — including when
   * it was performed — and the archive says, once, as which.
   */
  async restoreProcedure(
    restoration: ProcedureRestoration,
  ): Promise<RecordedProcedureView> {
    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      await requireEncounterInScope(
        tx,
        restoration.encounterId,
        restoration.sites,
      );
      const archived = await tx.encounterProcedureRetraction.findFirst({
        where: {
          id: restoration.retractionId,
          encounterId: restoration.encounterId,
        },
      });
      if (!archived) throw new ProcedureNotFoundError();
      if (archived.restoredAt !== null) throw new ProcedureNotRestorableError();
      // EN-152, EN-246. The restored row inherits the 024 of the one it comes
      // back from; one removed before the mark existed has none to inherit.
      if (
        (await requiresWrittenConsent(tx, archived.conceptId)) &&
        !(await writtenConsentCovers(tx, archived.id, archived.conceptId))
      ) {
        throw new ConsentRequiredError('correction');
      }

      const restored = await tx.encounterProcedure.create({
        data: {
          encounterId: archived.encounterId,
          conceptId: archived.conceptId,
          procedureCode: archived.procedureCode,
          procedureDisplay: archived.procedureDisplay,
          quantity: archived.quantity,
          performedAt: archived.performedAt,
          // Restoring is recording again (EN-246): caja sees it as new.
          recordedAt: now,
          note: archived.note,
          // EN-051: carried back untouched, never read nor served.
          tariffAmount: archived.tariffAmount,
        },
        select: PROCEDURE_SELECT,
      });
      // `encounter_procedure_retraction_frozen` admits this once, and only
      // towards that very procedure back on its attention.
      await tx.encounterProcedureRetraction.update({
        where: { id: archived.id },
        data: {
          restoredAt: now,
          restoredById: restoration.restoredById,
          restoredAsId: restored.id,
        },
      });
      return restored;
    });
    return this.withConsent(row);
  }

  /** EN-245. The archive of one attention, without what was restored. */
  async retractedProceduresOf(
    query: CodingQuery,
  ): Promise<RetractedProcedureView[]> {
    const rows = await this.prisma.encounterProcedureRetraction.findMany({
      where: {
        encounterId: query.encounterId,
        restoredAt: null,
        encounter: siteFilter(query.sites),
      },
      orderBy: [{ retractedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        procedureCode: true,
        procedureDisplay: true,
        quantity: true,
        retractedAt: true,
        reason: true,
        retractedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      procedureCode: row.procedureCode,
      procedureDisplay: row.procedureDisplay,
      quantity: row.quantity,
      retractedAt: row.retractedAt,
      retractedBy: {
        id: row.retractedBy.id,
        name: `${row.retractedBy.firstName} ${row.retractedBy.lastName}`,
      },
      reason: row.reason,
    }));
  }
}

/** EN-244. The previous row as `record_version` stored it (`to_jsonb`). */
interface ProcedureSnapshot {
  id: string;
  encounter_id: string;
  concept_id: string;
  procedure_code: string;
  procedure_display: string;
  quantity: number;
  performed_at: string;
  note: string | null;
  edited_at: string | null;
}

function procedureFromSnapshot(snapshot: ProcedureSnapshot): ProcedureView {
  return {
    id: snapshot.id,
    encounterId: snapshot.encounter_id,
    conceptId: snapshot.concept_id,
    procedureCode: snapshot.procedure_code,
    procedureDisplay: snapshot.procedure_display,
    quantity: snapshot.quantity,
    performedAt: new Date(snapshot.performed_at),
    note: snapshot.note,
    editedAt: snapshot.edited_at === null ? null : new Date(snapshot.edited_at),
  };
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
export async function requireEncounterInScope(
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
): Promise<{ id: string; rank: number; use: Cie10Use | null }> {
  const diagnosis = await tx.encounterDiagnosis.findFirst({
    where: { id: diagnosisId, encounterId },
    select: { id: true, rank: true, concept: { select: { attributes: true } } },
  });
  if (!diagnosis) throw new DiagnosisNotFoundError();
  return {
    id: diagnosis.id,
    rank: diagnosis.rank,
    use: cie10UseOf(diagnosis.concept.attributes),
  };
}

/** EN-235. Whether a concept read by `conceptForEncounter` may be the principal. */
function conceptMayBePrincipal(concept: ConceptRow): boolean {
  return mayBePrincipal(cie10UseOf({ use: concept.use }));
}

/**
 * EN-183, EN-212. Makes `target` the principal: the previous principal, if
 * any, moves behind the last rank in use FIRST (never two principals), and
 * both rows are stamped edits.
 */
async function promote(
  tx: Prisma.TransactionClient,
  encounterId: string,
  target: { id: string },
  authority: CorrectionAuthority,
  now: Date,
): Promise<void> {
  const inUse = await tx.$queryRaw<
    { id: string; rank: number; edited_at: Date | null }[]
  >`
    SELECT id::text AS id, rank, edited_at FROM encounter_diagnosis
     WHERE encounter_id = ${encounterId}::uuid
     FOR UPDATE`;
  const previous = inUse.find((row) => isPrimary(row.rank));
  const stampOf = (id: string) =>
    stampAfter(inUse.find((row) => row.id === id)?.edited_at ?? null, now);
  if (previous) {
    await tx.encounterDiagnosis.update({
      where: { id: previous.id },
      data: {
        rank: nextRankAfter(inUse.map((row) => row.rank)),
        editReason: null,
        editedById: authority.editedById,
        editedAt: stampOf(previous.id),
      },
    });
  }
  await tx.encounterDiagnosis.update({
    where: { id: target.id },
    data: {
      rank: 1,
      editReason: null,
      editedById: authority.editedById,
      editedAt: stampOf(target.id),
    },
  });
}

/**
 * EN-210's rule for every versioned row: `record_version_archive` refuses an
 * edit whose stamp did not change, so a second edit in the same millisecond
 * moves past the first instead of failing as «sin sello». The row is locked
 * by the caller.
 */
function stampAfter(previous: Date | null, now: Date): Date {
  return previous && previous >= now ? new Date(previous.getTime() + 1) : now;
}

/**
 * EN-212, D-117.13, D-117.16. Asked under the attention's lock: a discharge
 * that landed after the service's read is refused here to a caller who does
 * not sign, and a report already sent is never corrected.
 */
async function refuseCorrection(
  tx: Prisma.TransactionClient,
  encounterId: string,
  status: EncounterStatus,
  authority: {
    mayCorrectAfterDischarge?: boolean;
    afterDischargeRefusal?: AfterDischargeRefusal;
  },
  // EN-247. The procedures' own sentence for the same rule.
  subject: 'diagnosis' | 'procedure' = 'diagnosis',
): Promise<void> {
  // D-117.13: the same sentence the service gives when it saw the discharge.
  if (hasDischarge(status) && !authority.mayCorrectAfterDischarge) {
    if (authority.afterDischargeRefusal === 'NOT_LICENSED') {
      throw new PractitionerNotLicensedError();
    }
    if (authority.afterDischargeRefusal === 'NO_PRACTITIONER_PROFILE') {
      throw new PractitionerProfileRequiredError();
    }
    throw subject === 'procedure'
      ? new ProcedureCorrectionRequiresSignatureError()
      : new DiagnosisCorrectionRequiresSignatureError();
  }
  const [row] = await tx.$queryRaw<{ reported: boolean }[]>`
    SELECT encounter_is_reported(${encounterId}::uuid) AS reported
  `;
  if (row?.reported) throw new EncounterAlreadyReportedError();
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
export async function conceptForEncounter(
  tx: Prisma.TransactionClient,
  encounterId: string,
  conceptId: string,
): Promise<ConceptRow | undefined> {
  const rows = await tx.$queryRaw<ConceptRow[]>`
    SELECT cs."code"::text                 AS system_code,
           cc."code"::text                 AS concept_code,
           cc."display"::text              AS concept_display,
           cc."attributes"->>'use'         AS use,
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

/**
 * EN-189, EN-214. The codes a frozen `[{code, …}]` printed. Read defensively:
 * a JSON column is only as typed as its CHECK.
 */
function printedCodes(value: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((printed) =>
    typeof printed === 'object' &&
    printed !== null &&
    'code' in printed &&
    typeof printed.code === 'string'
      ? [printed.code]
      : [],
  );
}

/**
 * EN-212. A diagnosis as `record_version` keeps it: `to_jsonb` of the row,
 * with the DATABASE's column names and instants as ISO strings.
 */
interface DiagnosisSnapshot {
  id: string;
  encounter_id: string;
  concept_id: string;
  cie10_code: string;
  cie10_display: string;
  certainty: DiagnosisRow['certainty'];
  occurrence: DiagnosisRow['occurrence'];
  rank: number;
  notifiable: boolean;
  note: string | null;
  recorded_at: string;
  edited_at: string | null;
  edit_reason: string | null;
}

/** A kept version back into the shape of a live row, for one mapping. */
function diagnosisRowFromSnapshot(snapshot: DiagnosisSnapshot): DiagnosisRow {
  return {
    id: snapshot.id,
    encounterId: snapshot.encounter_id,
    conceptId: snapshot.concept_id,
    cie10Code: snapshot.cie10_code,
    cie10Display: snapshot.cie10_display,
    certainty: snapshot.certainty,
    occurrence: snapshot.occurrence,
    rank: snapshot.rank,
    notifiable: snapshot.notifiable,
    note: snapshot.note,
    recordedAt: new Date(snapshot.recorded_at),
    // A snapshot taken before EN-212 has no such key.
    editedAt: snapshot.edited_at ? new Date(snapshot.edited_at) : null,
  };
}

/** EN-235. A live row, with its concept's use read alongside. */
function toLiveDiagnosisView(row: DiagnosisWithUseRow): DiagnosisView {
  const { concept, ...diagnosis } = row;
  return toDiagnosisView(diagnosis, cie10UseOf(concept.attributes));
}

/** An `encounter_diagnosis` row as the domain reads it. */
function toDiagnosisView(
  row: DiagnosisRow,
  use: Cie10Use | null,
): DiagnosisView {
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
    // EN-235. From the concept's use, which is where the WHO list says it.
    mayBePrincipal: mayBePrincipal(use),
    note: row.note,
    recordedAt: row.recordedAt,
    editedAt: row.editedAt,
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
    editedAt: row.editedAt,
  };
}

/** EN-187, EN-215, EN-012, EN-013. The attention's own coding. */
const CODING_SELECT = {
  careModality: true,
  visitSequence: true,
  carePlace: true,
  medicoDelBarrio: true,
} as const;

function toCodingView(row: {
  careModality: CareModality;
  visitSequence: VisitSequence;
  carePlace: number;
  medicoDelBarrio: boolean;
}): EncounterCodingView {
  return {
    careModality: row.careModality,
    visitSequence: row.visitSequence,
    // `encounter_care_place_in_catalogue` holds the column to the union.
    carePlace: row.carePlace as CarePlace,
    medicoDelBarrio: row.medicoDelBarrio,
  };
}
