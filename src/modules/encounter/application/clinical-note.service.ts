import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import { clinicalDateOf } from '../../../shared/domain/clinic-time';
import {
  assertAmendable,
  assertContentComplete,
  assertEditable,
  contentHashOf,
  planAmendment,
  requireForm,
  type NoteContent,
} from '../domain/clinical-note';
import {
  CLINICAL_NOTE_REPOSITORY,
  type ClinicalNoteRepository,
  type ClinicalNoteView,
  type NoteEncounterRead,
} from '../domain/clinical-note.repository';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
} from '../domain/encounter.repository';
import {
  DischargeConditionRequiredError,
  EncounterAlreadyClosedError,
  PractitionerNotLicensedError,
  PractitionerProfileRequiredError,
} from '../domain/encounter.errors';
import { acceptsNewClinicalContent } from '../domain/encounter-state';
import type { DischargeCondition } from '../domain/encounter';
import type { Requester } from './encounter.service';

/**
 * Its own resource type in the trail, and not `'encounter'`.
 *
 * Reading an attention tells you it happened; reading a note tells you what
 * the patient came with, what was found and what was prescribed. «¿Quién abrió
 * la atención?» and «¿quién leyó la nota?» are two questions, and answering
 * the second by filtering the first by hand is how an investigation gets the
 * wrong answer.
 */
const RESOURCE_TYPE = 'clinical_note';

/** EN-020, EN-021. A first version of a form. */
export interface DraftNoteRequest {
  encounterId: string;
  /** EN-021. The MSP number, as data. `002`, `005`. */
  formCode: string;
  formVersion: string;
  content: NoteContent;
}

/** EN-027 to EN-030, EN-130. Signing one version. */
export interface SignNoteRequest {
  encounterId: string;
  noteId: string;
  /**
   * EN-009, EN-130. How the attention ended, asked for at the SIGNATURE.
   *
   * ⚠️ IT IS ASKED FOR HERE AND NOT AT THE CLOSURE, and the database is what
   * forces the order: signing the consultation note discharges the attention
   * (EN-138), and `encounter_discharge_states_a_condition` refuses a
   * `DISCHARGED` row without a condition. So the doctor states the outcome in
   * the same act in which they declare themselves finished — which is also the
   * only moment at which it is a clinical fact rather than a guess. The
   * cashier inherits it at `COMPLETED`; nobody re-states it, and nobody
   * invents it (EN-145).
   *
   * Absent on a form that does not discharge (an evolution note): there is no
   * outcome to declare because nothing ended.
   */
  dischargeCondition?: DischargeCondition;
}

/** EN-025. A new version over a signed one. */
export interface AmendNoteRequest {
  encounterId: string;
  noteId: string;
  content: NoteContent;
  /** EN-025. Free text, obligatory, and never a dropdown. */
  amendmentReason?: string;
}

/**
 * The clinical note and its chain of amendments.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SERVICE OF ITS OWN BECAUSE THE CHAIN IS A SECOND AGGREGATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It has a lifecycle the attention does not have — draft, signature,
 * amendment, retraction — invariants of its own (one current version per
 * chain, versions without repetition) and an immutability that is the whole
 * point of the module. ADR-008 §2 splits on «two groups of methods with no
 * dependencies in common», and these two share exactly one identifier.
 *
 * ⚠️ WHAT THIS SERVICE NEVER DOES: edit a signed note. Not once, by any path.
 * The database refuses it too (`trg_clinical_note_immutable`), and that is the
 * order of the two: the trigger is the guarantee — it is what also stops a
 * `psql`, an import and a use case somebody writes in two years without
 * reading the spec — and this service is what makes the refusal a sentence a
 * doctor can act on instead of `insufficient_privilege`.
 */
@Injectable()
export class ClinicalNoteService {
  constructor(
    @Inject(CLINICAL_NOTE_REPOSITORY)
    private readonly notes: ClinicalNoteRepository,
    @Inject(ENCOUNTER_REPOSITORY)
    private readonly encounters: EncounterRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ClinicalNoteService.name);
  }

  /**
   * EN-020, EN-021, EN-137. Opens a note: a first version, as a draft.
   *
   * THE CONTENT IS *NOT* CHECKED FOR COMPLETENESS HERE (EN-020), and that is
   * deliberate: a doctor writes the motive at 09:02 and the plan at 09:20, and
   * a form that refused to save until it was complete is a form nobody saves —
   * so the minimum content of art. 6 is demanded at the SIGNATURE, which is
   * the moment the note becomes the record. What IS checked is the form: a
   * code nobody declared would store a note nothing can validate, print or
   * amend (EN-021).
   *
   * EN-137 rides in the same transaction as the insert: opening the note is
   * the documented fact that proves the patient is with the practitioner, and
   * a board written afterwards is a board that can disagree with the record.
   */
  async draft(
    request: DraftNoteRequest,
    requester: Requester,
  ): Promise<ClinicalNoteView> {
    const author = await this.requirePractitioner(requester.userId);
    // EN-021. Refuses an unregistered form before anything is written.
    requireForm(request.formCode, request.formVersion);

    const note = await this.notes.createDraft({
      encounterId: request.encounterId,
      formCode: request.formCode,
      formVersion: request.formVersion,
      content: request.content,
      authorId: author.practitionerId,
      authorUserId: requester.userId,
      sites: requester.sites,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: note.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return note;
  }

  /**
   * EN-022. Every version of every chain of one attention, chronologically.
   *
   * ⚠️ AUDITED, unlike the listing of attentions (EN-123), and the difference
   * is what travels: an attention carries identifiers and a state, a note
   * carries the reason for the visit and the plan of treatment. One entry for
   * the READ of the attention's notes, not one per note — the accountable act
   * is opening the record, and a row per version would bury it exactly as a
   * row per listed appointment would.
   */
  async listOf(
    encounterId: string,
    requester: Requester,
  ): Promise<readonly ClinicalNoteView[]> {
    const notes = await this.notes.listOfEncounter({
      encounterId,
      sites: requester.sites,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: encounterId,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return notes;
  }

  /**
   * EN-023. Replaces the content of a draft.
   *
   * THE REFUSAL IS DECIDED INSIDE THE TRANSACTION. A colleague signing the
   * note between the read and the write is what this closes: the closure sees
   * the row as it is at that instant and throws `NOTE_ALREADY_SIGNED`, so the
   * write never reaches `trg_clinical_note_immutable` — whose
   * `insufficient_privilege` would otherwise come out as a 403 telling the
   * doctor they lack permissions when what happened is that the note is signed.
   */
  async updateDraft(
    request: { encounterId: string; noteId: string; content: NoteContent },
    requester: Requester,
  ): Promise<ClinicalNoteView> {
    const updated = await this.notes.updateDraft(
      {
        encounterId: request.encounterId,
        noteId: request.noteId,
        sites: requester.sites,
      },
      request.content,
      (note) => assertEditable(note.status),
    );

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: updated.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return updated;
  }

  /**
   * EN-027 to EN-030, EN-130, EN-138. Signs the note — and, when it is the
   * consultation note, discharges the attention with it.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ONE TRANSACTION, AND THE TWO HALVES ARE NOT SEPARABLE
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A signature that could commit without its discharge leaves the board
   * showing a patient nobody has finished with; a discharge that could commit
   * without its signature declares the act clinically over with nothing
   * signed. Neither is worth having on its own, so both ride in the closure
   * handed into the adapter.
   *
   * EN-029 IS CHECKED AT THE INSTANT OF SIGNING and never when the
   * practitioner was registered: an ACESS registration that lapses on Tuesday
   * stops enabling on Wednesday without anybody touching a row. The comparison
   * is made on the ECUADORIAN calendar date (`America/Guayaquil`) because the
   * column is a `date` and the clinic's day is Ecuador's — read in UTC, a
   * signature at 20:00 would be judged against tomorrow.
   */
  async sign(
    request: SignNoteRequest,
    requester: Requester,
  ): Promise<ClinicalNoteView> {
    const signer = await this.requirePractitioner(requester.userId);
    this.assertLicensed(signer.acessExpiresOn);
    const now = new Date();

    const signed = await this.notes.sign(
      {
        encounterId: request.encounterId,
        noteId: request.noteId,
        sites: requester.sites,
      },
      (note, encounter) => {
        // EN-023. A note that is not a draft is not signable, and the answer
        // says so instead of naming a trigger.
        assertEditable(note.status);
        this.assertEncounterAcceptsContent(encounter);

        const form = requireForm(note.formCode, note.formVersion);
        // EN-020. The minimum content of art. 6, demanded at the moment the
        // note becomes the record.
        assertContentComplete(form, note.content);

        /**
         * EN-009, EN-130. Signing the consultation note discharges the
         * attention, and `encounter_discharge_states_a_condition` refuses a
         * discharge with no condition. Refused HERE so the doctor gets a
         * per-field sentence naming the four admitted values, instead of the
         * constraint's `CHECK_FAILED` after the note was already written.
         */
        if (form.dischargesTheEncounter && !request.dischargeCondition) {
          throw new DischargeConditionRequiredError();
        }

        return {
          signedById: signer.practitionerId,
          signedAt: now,
          // EN-027. Content, signer and instant, all three inside the digest:
          // hashing the content alone would let a note be re-attributed with
          // the hash still checking out.
          contentHash: contentHashOf({
            content: note.content,
            signedById: signer.practitionerId,
            signedAt: now,
          }),
          dischargesTheEncounter: form.dischargesTheEncounter,
          dischargeCondition: form.dischargesTheEncounter
            ? (request.dischargeCondition ?? null)
            : null,
        };
      },
    );

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: signed.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    // EN-124. The fact only: no patient, no form content, nothing interpolated.
    this.logger.info(
      { action: 'CLINICAL_NOTE_SIGNED' },
      'clinical note signed',
    );

    return signed;
  }

  /**
   * EN-025. Amends a signed note: a NEW version that points back at it.
   *
   * ⚠️ IT IS AN ADDITION AND NEVER AN EDIT, which is the whole of REQ-005. The
   * previous version keeps its content, its signer, its instant and its hash,
   * and stays readable and printable for ever; what changes about it is one
   * column — `status` — which is the only mutation
   * `trg_clinical_note_immutable` admits.
   *
   * THE AMENDMENT IS BORN SIGNED. A correction that sat as a draft would leave
   * the chain with no current signed version between the two, and
   * `clinical_note_one_current_per_chain` would be guarding a chain whose only
   * current row is unsigned — a state in which the history has no valid
   * current note at all.
   *
   * IT IS STILL POSSIBLE AFTER THE DISCHARGE, deliberately (EN-130): EN-025
   * does not expire because the attention moved on. What is refused after the
   * discharge is NEW content, not the correction of what is already written.
   */
  async amend(
    request: AmendNoteRequest,
    requester: Requester,
  ): Promise<ClinicalNoteView> {
    const signer = await this.requirePractitioner(requester.userId);
    this.assertLicensed(signer.acessExpiresOn);
    const now = new Date();

    const amended = await this.notes.amend(
      {
        encounterId: request.encounterId,
        noteId: request.noteId,
        sites: requester.sites,
      },
      (previous) => {
        // EN-025. Refuses a draft, an already superseded version and a
        // retracted one; and demands the written reason in the SERVICE, not
        // only in the DTO.
        const plan = planAmendment({
          previous: {
            id: previous.id,
            chainId: previous.chainId,
            version: previous.version,
            status: previous.status,
          },
          reason: request.amendmentReason,
        });

        const form = requireForm(previous.formCode, previous.formVersion);
        assertContentComplete(form, request.content);

        return {
          chainId: plan.chainId,
          version: plan.version,
          supersedesId: plan.supersedesId,
          amendmentReason: plan.reason,
          formCode: previous.formCode,
          formVersion: previous.formVersion,
          content: request.content,
          authorId: signer.practitionerId,
          signature: {
            signedById: signer.practitionerId,
            signedAt: now,
            contentHash: contentHashOf({
              content: request.content,
              signedById: signer.practitionerId,
              signedAt: now,
            }),
            /**
             * An amendment NEVER discharges. The attention was discharged when
             * the original was signed (EN-138), and re-running that transition
             * would be refused by the state machine anyway — `DISCHARGED →
             * DISCHARGED` is not in the table of EN-132. Stating it as `false`
             * rather than relying on the refusal keeps the correction of a
             * March note from touching the state of a March attention.
             */
            dischargesTheEncounter: false,
            dischargeCondition: null,
          },
        };
      },
    );

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: amended.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return amended;
  }

  /**
   * EN-026. Retracts a signed note WITHOUT a replacement.
   *
   * `ENTERED_IN_ERROR` and not `SUPERSEDED`: «esto lo escribí mal y aquí está
   * lo correcto» and «esto no debió escribirse nunca» — the note filed in the
   * wrong patient's history — are two statements, and collapsing them would
   * force inventing an empty amendment to retract, which tells the reader the
   * act happened.
   *
   * THE ROW SURVIVES AND STAYS IN THE HISTORY. Nothing is deleted here or
   * anywhere: `trg_clinical_note_immutable` refuses every DELETE and
   * `trg_clinical_note_no_truncate` covers the shortcut a per-row DELETE does
   * not.
   */
  async retract(
    request: { encounterId: string; noteId: string },
    requester: Requester,
  ): Promise<ClinicalNoteView> {
    const retracted = await this.notes.retract(
      {
        encounterId: request.encounterId,
        noteId: request.noteId,
        sites: requester.sites,
      },
      /**
       * EN-026. Only a SIGNED version can be retracted, and it is the SAME
       * predicate an amendment uses: a draft is edited rather than retracted,
       * and a superseded or already-retracted version is out of the way.
       * `NOTE_NOT_AMENDABLE` says the right sentence for each of the three.
       */
      (note) => assertAmendable(note.status),
    );

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: retracted.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return retracted;
  }

  /**
   * EN-130. New clinical content only goes into an attention that is live.
   *
   * The AMENDMENT deliberately does not come through here (EN-025): correcting
   * what is already written is not writing something new, and a correction
   * that expired when the patient reached the cashier would leave a signed
   * mistake in the record for ever.
   */
  private assertEncounterAcceptsContent(encounter: NoteEncounterRead): void {
    if (!acceptsNewClinicalContent(encounter.status)) {
      throw new EncounterAlreadyClosedError(encounter.status);
    }
  }

  /**
   * EN-029, REQ-041. The registration has to be in force ON THE DAY OF THE
   * SIGNATURE.
   *
   * The Ecuadorian calendar date and never `Date.now()` compared to a
   * timestamp: `acess_expires_on` is a `date` column — a day, not a moment —
   * and a signature at 20:00 read in UTC would be judged against tomorrow,
   * which is the same arithmetic that misclassifies a neonate's age (REQ-160).
   *
   * NO REGISTRATION ON FILE IS *NOT* REFUSED HERE. Whether a practitioner must
   * have one is `staff`'s question (ST-002, ST-005) and it is asked when they
   * are registered; refusing it again at the signature would make this module
   * the second place that decides who may practise, and the two would drift.
   * What this refuses is the one thing only the signature can see: a
   * registration that HAS a date and whose date has passed.
   */
  private assertLicensed(acessExpiresOn: Date | null): void {
    if (acessExpiresOn === null) return;

    const today = clinicalDateOf(new Date());
    // The column round-trips as UTC midnight, so its ISO prefix IS the
    // calendar day it names — no zone conversion, which is what would move it.
    const expiresOn = acessExpiresOn.toISOString().slice(0, 10);
    if (expiresOn < today) throw new PractitionerNotLicensedError();
  }

  /** EN-011. The caller's clinical identity, or a refusal naming nothing. */
  private async requirePractitioner(userId: string) {
    const identity = await this.encounters.findPractitionerByUser(userId);
    if (!identity) throw new PractitionerProfileRequiredError();
    return identity;
  }
}
