import { restOverlapNoticeOf } from '../domain/patient-merge';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  MergeIntoSelfError,
  MergeNotFoundError,
  MergeReasonRequiredError,
  MergeUndoConflictError,
  PatientAlreadyMergedError,
  PatientMergedError,
  PatientNotFoundError,
} from '../domain/patient.errors';
import {
  PATIENT_REPOSITORY,
  type PatientMergeEvent,
  type PatientRepository,
} from '../domain/patient.repository';
import type { Requester } from './patients.service';

/**
 * Resolving duplicates: merging two charts of the same person, and undoing it
 * (P4: PA-043 to PA-049, REQ-010).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SERVICE OF ITS OWN, FOR THE SAME REASON THE PERMISSION IS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PatientsService` reads and corrects ONE chart. This one joins two people's
 * clinical records together — the worst incident this module can produce
 * (D-030) — and it is the only place in `patients` that writes to an
 * append-only trail with a snapshot in it. Two different reasons to change,
 * which is one of the three limits ADR-008 §2 sets for splitting, and the
 * split shows in the door: every route of `PatientMergeController` demands
 * `patient:merge`, which no shipped role carries.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS SERVICE DOES *NOT* DO: RE-IMPLEMENT THE DATABASE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Most of P4 is a storage guarantee and stays one. The chain A→B→C is refused
 * by `trg_patient_merge_not_chained`, which also LOCKS the target row so two
 * simultaneous merges cannot build one between them; a chart merged with
 * itself is refused by `patient_merged_into_not_self`; a merge undone twice is
 * refused by `patient_merge_undone_once`; a blank reason by
 * `patient_merge_reason_not_blank`. Repeating any of them in TypeScript would
 * be a second rule to keep in step with the first, and the copy always wins
 * the argument at the wrong moment.
 *
 * What lives here is what the database cannot decide:
 *
 *   - the REASON as a `DEBERÁ` of the domain and not of the transport (PA-044,
 *     PA-047). Same argument as `CANCELLATION_REASON_REQUIRED`: a rule that
 *     only the DTO enforces stops being enforced the day another use case
 *     calls from inside. The CHECK still refuses `'   '` coming through an
 *     import — this is the message that lands on the field.
 *   - PA-045 for the SOURCE, which no constraint covers: merging a chart that
 *     is already merged INTO THE SAME TARGET changes no column, so the trigger
 *     sees nothing and a second `MERGE` row would appear for one merge.
 *   - what each rejection MEANS to whoever is at the desk with two charts of
 *     the same person in front of them.
 */
/**
 * A merge as it answers: the event, and the notice of PA-062 (`null` when the
 * merge joined no overlapping rests).
 */
export interface PatientMergeResult extends PatientMergeEvent {
  restOverlapNotice: string | null;
}

@Injectable()
export class PatientMergeService {
  constructor(
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PatientMergeService.name);
  }

  /**
   * Merges the source chart into the target (PA-043, PA-044, PA-046).
   *
   * THE ABSORBED CHART IS NOT DELETED and keeps its MRN: printed documents and
   * external systems still quote it, and deleting it would turn those papers
   * into references to nothing.
   */
  async merge(
    input: {
      sourcePatientId: string;
      targetPatientId: string;
      reason: string;
    },
    requester: Requester,
  ): Promise<PatientMergeResult> {
    const reason = requireReason(input.reason);

    /**
     * PA-046, first clause. Refused here and not left to the CHECK because
     * `patient_merged_into_not_self` answers a generic 422 with no field, and
     * this one belongs on the chart selector: the desk picked the same person
     * twice.
     */
    if (input.sourcePatientId === input.targetPatientId) {
      throw new MergeIntoSelfError();
    }

    /**
     * PA-045. A chart already absorbed is not merged again — it is un-merged
     * first, and undoing leaves its own row.
     *
     * ⚠️ THIS ONE IS NOT A COURTESY. Re-sending the SAME merge writes the same
     * value into `merged_into_id`, so `trg_patient_merge_not_chained` sees no
     * change and lets it through, leaving two `MERGE` rows for one merge and
     * an undo that only undoes half of it.
     */
    const source = await this.patients.findMergeState(input.sourcePatientId);
    if (!source) throw new PatientNotFoundError();
    if (source.mergedIntoMrn !== null) {
      throw new PatientMergedError(source.mergedIntoMrn);
    }

    /**
     * The target has to exist, and the field says which of the two is missing.
     *
     * Whether it is itself merged is NOT asked here: that is the chain, the
     * trigger arbitrates it under concurrency, and asking first would be the
     * copy of the rule this service does not keep.
     */
    if (!(await this.patients.findMergeState(input.targetPatientId))) {
      throw new PatientNotFoundError('targetPatientId');
    }

    const outcome = await this.patients.merge({
      sourcePatientId: input.sourcePatientId,
      targetPatientId: input.targetPatientId,
      reason,
      // PA-044: the author is whoever is signed in, never a field of the
      // request, or the trail could be written to name somebody else.
      performedById: requester.userId,
    });

    /**
     * PA-045. The source turned out to be merged after all — the double click,
     * whose loser only finds out once it holds the lock.
     *
     * `PATIENT_MERGED` AND NOT `PATIENT_ALREADY_MERGED`, which is what this
     * path used to answer. The `SPEC.md` splits them by what the desk has to
     * do: a merged SOURCE means «open the chart that is current», and that
     * sentence needs the survivor's MRN. `PATIENT_ALREADY_MERGED` belongs to
     * the TARGET — or to a source that already absorbed others — and means
     * «undo the other merge first».
     */
    if (outcome.status === 'SOURCE_MERGED') {
      throw new PatientMergedError(outcome.survivingMrn);
    }

    if (outcome.status === 'WOULD_CHAIN') {
      throw new PatientAlreadyMergedError(
        outcome.chart === 'target' ? 'targetPatientId' : 'patientId',
        outcome.survivingMrn,
      );
    }

    await this.recordMutation(input.sourcePatientId, requester);
    this.logMerge(outcome.event);

    // PA-062. Done, and said: rests the merge joined that overlap.
    return {
      ...outcome.event,
      restOverlapNotice: restOverlapNoticeOf(outcome.restOverlaps),
    };
  }

  /**
   * Undoes a merge (PA-047, PA-048).
   *
   * A NEW ROW, never an edit of the merge one. The trail of the undo is
   * literally «the same» as the merge's — author, instant and reason of its
   * own — and «is this merge undone?» is answered by the link rather than
   * guessed from dates.
   */
  async undo(
    input: { sourcePatientId: string; reason: string },
    requester: Requester,
  ): Promise<PatientMergeEvent> {
    const reason = requireReason(input.reason);

    const source = await this.patients.findMergeState(input.sourcePatientId);
    if (!source) throw new PatientNotFoundError();

    /**
     * ⚠️ THE ONE ROUTE THAT MAY NAME A MERGED CHART, and the only exception to
     * PA-045 in the whole module. Refusing it with `PATIENT_MERGED` would make
     * PA-047 unreachable: the chart to un-merge is, by definition, merged.
     *
     * The opposite is what fails here — a chart that is whole has no merge to
     * undo — and it is `MERGE_NOT_FOUND` and not `PATIENT_NOT_FOUND`, because
     * the patient is on the screen and it is the EVENT that does not exist.
     */
    if (source.mergedIntoMrn === null) throw new MergeNotFoundError();

    const open = await this.patients.findOpenMerge(input.sourcePatientId);
    // The chart carries the link but no standing merge row explains it: an
    // import, or data moved by hand. There is nothing to undo that would leave
    // a coherent trail, and inventing one is worse than refusing.
    if (!open) throw new MergeNotFoundError();

    const outcome = await this.patients.undoMerge({
      sourcePatientId: input.sourcePatientId,
      mergeId: open.mergeId,
      reason,
      performedById: requester.userId,
    });

    /**
     * PA-048. The document came back into
     * `patient_identifier_active_unique` and another live chart holds it.
     *
     * THE TRANSLATION IS HERE AND NOT IN THE CONSTRAINT MAP, because the map
     * cannot see the difference: it is the same index a duplicate registration
     * hits, and it would answer `DUPLICATE_IDENTIFIER` about a document
     * whoever pressed «deshacer» never touched. Only this call knows the
     * operation was an undo.
     */
    /**
     * PA-047. Somebody else undid this very merge first — the double click on
     * «deshacer», whose loser only finds out once it holds the lock.
     *
     * The SAME answer as undoing twice in a row, and that is the point: what
     * does not exist is the EVENT, not the person. Before this, the loser left
     * through the generic unique-violation map as `DUPLICATE_VALUE` 409, a code
     * that is not in this module's table and that names a constraint nobody at
     * the desk has heard of.
     */
    if (outcome.status === 'ALREADY_UNDONE') throw new MergeNotFoundError();

    if (outcome.status === 'IDENTIFIER_CLAIMED') {
      throw new MergeUndoConflictError(
        outcome.identifierType,
        outcome.holderMrn,
      );
    }

    await this.recordMutation(input.sourcePatientId, requester);
    this.logMerge(outcome.event);

    return outcome.event;
  }

  /**
   * The audit entry of the mutation: who and when, and NOTHING ELSE (D-032).
   *
   * ⚠️ NO `before`/`after`, and it is not a style rule.
   * `access_audit_payload_only_for_declared_resources` refuses a row whose
   * `resource_type` is not on the whitelist — today exactly `'configuration'`
   * — and carries a payload. Since recording does not throw, the entry would
   * simply be LOST, in silence. The trail WITH values is `patient_merge`,
   * which is what the snapshot is for, and which is rectifiable in a way an
   * append-only never-purged table is not (REQ-113).
   *
   * ON THE ABSORBED CHART, which is the row that changed. The survivor gains
   * nothing it did not have: with D-031 not a single child row is re-pointed.
   */
  private async recordMutation(
    patientId: string,
    requester: Requester,
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType: 'patient',
      resourceId: patientId,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }

  /**
   * The MRNs are safe to log; nothing else about either patient is.
   *
   * An MRN is an internal number rather than a national identifier, and it is
   * what support needs to trace a merge that should not have happened. No
   * name, no document, and NO INTERPOLATION — the logger prunes by allowlist
   * and interpolating walks straight past it.
   */
  private logMerge(event: PatientMergeEvent): void {
    this.logger.info(
      {
        source_mrn: event.sourceMrn,
        target_mrn: event.targetMrn,
        action: event.event === 'MERGE' ? 'PATIENTS_MERGED' : 'MERGE_UNDONE',
      },
      'duplicate resolution',
    );
  }
}

/**
 * PA-044, PA-047. A reason, or the operation does not happen.
 *
 * TRIMMED, because `'   '` satisfies a `NOT NULL` and explains nothing — «un
 * motivo obligatorio es lo que distingue esto de un clic, y una cadena de
 * espacios es un clic con más teclas». The trimmed value is what gets stored,
 * so the trail never holds padding either.
 */
function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) throw new MergeReasonRequiredError();
  return trimmed;
}
