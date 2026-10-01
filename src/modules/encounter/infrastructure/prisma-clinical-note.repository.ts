import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  ClinicalNoteNotFoundError,
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
} from '../domain/encounter.errors';
import { TERMINAL_STATUSES } from '../domain/encounter-state';
import { subjectStatusAfter } from '../domain/patient-flow';
import type { NoteContent } from '../domain/clinical-note';
import type {
  AmendmentDraft,
  ClinicalNoteRepository,
  ClinicalNoteView,
  NewClinicalNote,
  NoteEncounterRead,
  NoteQuery,
  NotesOfEncounterQuery,
  SignaturePlan,
} from '../domain/clinical-note.repository';
import type { DischargeCondition, EncounterStatus } from '../domain/encounter';
import type { SiteScopeFilter } from '../domain/encounter.repository';

/**
 * The note chain, against PostgreSQL.
 *
 * ⚠️ THIS ADAPTER NEVER EDITS A SIGNED NOTE, and the database would refuse it
 * if it tried: `trg_clinical_note_immutable` admits exactly two mutations on a
 * `SIGNED` row — `→ SUPERSEDED` and `→ ENTERED_IN_ERROR`, both with the
 * content, the hash, the signer and the instant untouched — and raises
 * `insufficient_privilege` for everything else. Every write below is one of
 * those two, an insert, or an update of a `DRAFT`.
 */

const NOTE_SELECT = {
  id: true,
  encounterId: true,
  chainId: true,
  version: true,
  formCode: true,
  formVersion: true,
  status: true,
  content: true,
  authorId: true,
  signedById: true,
  signedAt: true,
  contentHash: true,
  supersedesId: true,
  amendmentReason: true,
  createdAt: true,
} satisfies Prisma.ClinicalNoteSelect;

/** The row `NOTE_SELECT` yields, derived from it so the two cannot drift. */
type NoteRow = Prisma.ClinicalNoteGetPayload<{ select: typeof NOTE_SELECT }>;

/** What the note's policy needs of the attention, read inside the transaction. */
const ENCOUNTER_FOR_NOTE = {
  id: true,
  status: true,
  practitionerId: true,
  endedAt: true,
  dischargeCondition: true,
  agendaEntryId: true,
} satisfies Prisma.EncounterSelect;

/**
 * The note chain over PostgreSQL. Every write is an insert, an update of a
 * `DRAFT`, or one of the two moves `trg_clinical_note_immutable` admits on a
 * signed row — see the note at the top of this file.
 */
@Injectable()
export class PrismaClinicalNoteRepository implements ClinicalNoteRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * EN-020, EN-024, EN-137. A first version, born as a draft, with the board
   * moved in the same transaction.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * WHY THE IDENTIFIER IS ASKED FOR BEFORE THE INSERT
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * EN-024 says the chain identifier is constant across every version and that
   * version 1 sets it to ITS OWN id — which no `INSERT` can state about a
   * value the database is generating in the same statement. The two ways out
   * were to write a placeholder and patch it, which leaves a window in which
   * `clinical_note_one_current_per_chain` guards the wrong chain, or to ask
   * PostgreSQL for the `uuidv7()` first and write both columns with it. The
   * second keeps identifiers coming from the database (CLAUDE.md §5) and the
   * chain coherent from the first statement, at the cost of one round trip
   * inside a transaction that was going to exist anyway.
   */
  async createDraft(draft: NewClinicalNote): Promise<ClinicalNoteView> {
    return this.prisma.$transaction(async (tx) => {
      // AG-146, AG-148. The attention is LOCKED before it is read, so a
      // departure recorded at the counter at this same moment either finishes
      // first —and this read sees the attention it interrupted— or waits for
      // this note. Attention first, appointment second: the order the agenda
      // adapter takes too, so the two cannot deadlock.
      await tx.$queryRaw`
        SELECT 1 FROM "encounter" WHERE "id" = ${draft.encounterId}::uuid FOR UPDATE
      `;
      const encounter = await requireEncounter(
        tx,
        draft.encounterId,
        draft.sites,
      );
      // A note inside an attention that is already over —interrupted, closed,
      // annulled— documents nothing that happened in it.
      if (TERMINAL_STATUSES.includes(encounter.status)) {
        throw new EncounterAlreadyClosedError(encounter.status);
      }

      const [generated] = await tx.$queryRaw<{ id: string }[]>`
        SELECT uuidv7()::text AS id
      `;
      // `uuidv7()` is the default of every identifier in this schema and is
      // installed by the first migration; an empty result would mean the
      // function is gone, which is not a case to paper over.
      const id = generated?.id;
      if (id === undefined) {
        throw new Error('uuidv7() is unavailable in this database');
      }

      const created = await tx.clinicalNote.create({
        data: {
          id,
          // EN-024. Version 1 IS its own chain.
          chainId: id,
          version: 1,
          encounterId: encounter.id,
          formCode: draft.formCode,
          formVersion: draft.formVersion,
          status: 'DRAFT',
          content: draft.content as Prisma.InputJsonObject,
          authorId: draft.authorId,
        },
        select: NOTE_SELECT,
      });

      // EN-137. Opening the note is the documented fact that proves the
      // patient is with the practitioner — and it rides in this transaction,
      // because a board written afterwards can disagree with the record.
      await stampSubjectStatus(tx, encounter.agendaEntryId, 'NOTE_OPENED');
      await startAttendance(tx, encounter.agendaEntryId, draft.authorUserId);

      return toNoteView(created);
    });
  }

  /** EN-122. One version within the caller's scope, or `null`. */
  async findById(query: NoteQuery): Promise<ClinicalNoteView | null> {
    const row = await this.prisma.clinicalNote.findFirst({
      where: whereNote(query),
      select: NOTE_SELECT,
    });
    return row === null ? null : toNoteView(row);
  }

  /**
   * EN-022. Every version of the attention, in the order a history is read.
   *
   * BY CHAIN AND THEN BY VERSION, never by each row's own instant. An
   * amendment written today over a March consultation must appear WHERE THE
   * ORIGINAL IS: sorted by its own date it would surface at the end of the
   * history and a reader would believe there was a consultation today. The
   * chain is a uuidv7, so ordering by it IS ordering by when the first version
   * was written — the time ordering comes for free and no second column is
   * needed to express «where the original is».
   */
  async listOfEncounter(
    query: NotesOfEncounterQuery,
  ): Promise<readonly ClinicalNoteView[]> {
    const rows = await this.prisma.clinicalNote.findMany({
      where: {
        encounterId: query.encounterId,
        encounter: siteFilter(query.sites),
      },
      orderBy: [{ chainId: 'asc' }, { version: 'asc' }],
      select: NOTE_SELECT,
    });
    return rows.map(toNoteView);
  }

  /**
   * EN-023. Replaces the content of a draft.
   *
   * READ, DECIDE, WRITE CONDITIONALLY. The `updateMany` is conditioned on
   * `status: 'DRAFT'`, so a colleague who signed the note between the read and
   * the write leaves this one matching zero rows — and the refusal is
   * `NOTE_ALREADY_SIGNED`, which is what EN-023 asks for, instead of the
   * trigger's `insufficient_privilege` coming out as «no tiene permisos».
   */
  async updateDraft(
    query: NoteQuery,
    content: NoteContent,
    decide: (note: ClinicalNoteView) => void,
  ): Promise<ClinicalNoteView> {
    return this.prisma.$transaction(async (tx) => {
      const note = await requireNote(tx, query);
      decide(note);

      // EN-169 (D-077, D-082). What was written in an attention that is over
      // —interrupted, closed, annulled— is not rewritten. Locked first, as
      // every writer of the attention does, and the database says it again
      // (`trg_clinical_note_frozen_in_terminal_encounter`).
      const [attention] = await tx.$queryRaw<{ status: EncounterStatus }[]>`
        SELECT "status" FROM "encounter" WHERE "id" = ${note.encounterId}::uuid FOR UPDATE
      `;
      if (attention && TERMINAL_STATUSES.includes(attention.status)) {
        throw new EncounterAlreadyClosedError(attention.status);
      }

      const updated = await tx.clinicalNote.updateMany({
        where: { id: note.id, status: 'DRAFT' },
        data: { content: content as Prisma.InputJsonObject },
      });
      if (updated.count === 0) {
        // Somebody signed it under us. Re-read and let the policy speak.
        decide(await requireNote(tx, query));
      }

      return toNoteView(
        await tx.clinicalNote.findUniqueOrThrow({
          where: { id: note.id },
          select: NOTE_SELECT,
        }),
      );
    });
  }

  /**
   * EN-027 to EN-030, EN-130, EN-138. Signs one version — and discharges the
   * attention with it when the form is the consultation note.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ONE TRANSACTION, THREE WRITES, AND NONE OF THEM IS OPTIONAL
   * ═══════════════════════════════════════════════════════════════════════════
   *
   *  1. the note becomes `SIGNED`, carrying signer, instant and hash —
   *     `clinical_note_signature_coherence` refuses any subset of the three;
   *  2. the attention becomes `DISCHARGED` with its `ended_at` and its
   *     discharge condition — `encounter_status_matches_ended_at` and
   *     `encounter_discharge_states_a_condition` refuse any other combination;
   *  3. the board records the clinical discharge (EN-138).
   *
   * A signature that could commit without (2) declares a doctor finished and
   * leaves the attention looking live for ever; a discharge that could commit
   * without (1) declares the act clinically over with nothing signed. That is
   * the whole argument for the closure being handed in rather than the caller
   * making two calls.
   *
   * THE UPDATE IS CONDITIONED ON `DRAFT` for the same reason as `updateDraft`.
   */
  async sign(
    query: NoteQuery,
    decide: (
      note: ClinicalNoteView,
      encounter: NoteEncounterRead,
    ) => SignaturePlan,
  ): Promise<ClinicalNoteView> {
    return this.prisma.$transaction(async (tx) => {
      const note = await requireNote(tx, query);
      const encounter = await requireEncounter(
        tx,
        query.encounterId,
        query.sites,
      );

      const plan = decide(note, toEncounterRead(encounter));

      const signed = await tx.clinicalNote.updateMany({
        where: { id: note.id, status: 'DRAFT' },
        data: {
          status: 'SIGNED',
          signedById: plan.signedById,
          signedAt: plan.signedAt,
          contentHash: plan.contentHash,
        },
      });
      if (signed.count === 0) {
        // Signed by somebody else between the read and the write: re-read and
        // let the policy answer about the row as it now is.
        decide(await requireNote(tx, query), toEncounterRead(encounter));
      }

      if (plan.dischargesTheEncounter) {
        /**
         * EN-130, EN-138. Conditioned on `OPEN`, so a second signature on an
         * attention somebody already discharged does not re-stamp `ended_at`
         * — which would move the instant the RDACAA reports as the end of the
         * consultation.
         */
        await tx.encounter.updateMany({
          where: { id: encounter.id, status: 'OPEN' },
          data: {
            status: 'DISCHARGED',
            endedAt: plan.signedAt,
            dischargeCondition:
              plan.dischargeCondition as DischargeCondition | null,
          },
        });

        await stampSubjectStatus(tx, encounter.agendaEntryId, 'NOTE_SIGNED');
      }

      return toNoteView(
        await tx.clinicalNote.findUniqueOrThrow({
          where: { id: note.id },
          select: NOTE_SELECT,
        }),
      );
    });
  }

  /**
   * EN-025. Supersedes one version and writes its replacement, atomically.
   *
   * ⚠️ THE ORDER IS NOT FREE. The previous version is marked `SUPERSEDED`
   * FIRST and the new one inserted afterwards, because
   * `clinical_note_one_current_per_chain` is a partial unique index over
   * `chain_id WHERE status IN ('DRAFT','SIGNED')`: inserting first would put
   * two current versions in the chain for the length of one statement and be
   * refused by the index, with a constraint name instead of a sentence.
   *
   * THE SUPERSEDING UPDATE IS THE ONE MUTATION `trg_clinical_note_immutable`
   * ADMITS on a signed row, and only because the content, the hash, the signer
   * and the instant are left untouched — which is why `data` names exactly one
   * column.
   *
   * CONDITIONED ON `SIGNED`, so two people amending the same version leave
   * exactly one winner: the loser matches zero rows and the policy refuses it
   * with `NOTE_NOT_AMENDABLE` on re-read, rather than
   * `clinical_note_chain_version_unique` rejecting a duplicate version.
   */
  async amend(
    query: NoteQuery,
    decide: (
      previous: ClinicalNoteView,
      encounter: NoteEncounterRead,
    ) => AmendmentDraft,
  ): Promise<ClinicalNoteView> {
    return this.prisma.$transaction(async (tx) => {
      const previous = await requireNote(tx, query);
      const encounter = await requireEncounter(
        tx,
        query.encounterId,
        query.sites,
      );

      const draft = decide(previous, toEncounterRead(encounter));

      const superseded = await tx.clinicalNote.updateMany({
        where: { id: previous.id, status: 'SIGNED' },
        data: { status: 'SUPERSEDED' },
      });
      if (superseded.count === 0) {
        // Amended or retracted under us: re-read and let the policy speak.
        decide(await requireNote(tx, query), toEncounterRead(encounter));
      }

      const created = await tx.clinicalNote.create({
        data: {
          chainId: draft.chainId,
          version: draft.version,
          encounterId: query.encounterId,
          formCode: draft.formCode,
          formVersion: draft.formVersion,
          // EN-025, EN-027. The amendment is BORN SIGNED: a correction left as
          // a draft would leave the chain with no current SIGNED version at
          // all, which is a history with no valid current note.
          status: 'SIGNED',
          content: draft.content as Prisma.InputJsonObject,
          authorId: draft.authorId,
          signedById: draft.signature.signedById,
          signedAt: draft.signature.signedAt,
          contentHash: draft.signature.contentHash,
          // `supersedes_id` is `@unique`, so one version cannot be amended
          // twice in parallel even if the conditional update above were
          // somehow satisfied twice (EN-025).
          supersedesId: draft.supersedesId,
          amendmentReason: draft.amendmentReason,
        },
        select: NOTE_SELECT,
      });

      return toNoteView(created);
    });
  }

  /**
   * EN-026. Retracts a signed version with NO replacement.
   *
   * The second mutation `trg_clinical_note_immutable` admits: `SIGNED →
   * ENTERED_IN_ERROR` with the content untouched. The row survives with its
   * content, its signer and its instant — nothing is deleted here or anywhere,
   * and the trigger refuses a DELETE while `trg_clinical_note_no_truncate`
   * covers the shortcut a per-row DELETE does not.
   */
  async retract(
    query: NoteQuery,
    decide: (note: ClinicalNoteView) => void,
  ): Promise<ClinicalNoteView> {
    return this.prisma.$transaction(async (tx) => {
      const note = await requireNote(tx, query);
      decide(note);

      const retracted = await tx.clinicalNote.updateMany({
        where: { id: note.id, status: 'SIGNED' },
        data: { status: 'ENTERED_IN_ERROR' },
      });
      if (retracted.count === 0) decide(await requireNote(tx, query));

      return toNoteView(
        await tx.clinicalNote.findUniqueOrThrow({
          where: { id: note.id },
          select: NOTE_SELECT,
        }),
      );
    });
  }
}

/** EN-121. A note of one attention, within the caller's scope. */
function whereNote(query: NoteQuery): Prisma.ClinicalNoteWhereInput {
  return {
    id: query.noteId,
    encounterId: query.encounterId,
    encounter: siteFilter(query.sites),
  };
}

/** EN-121. The note, or `ClinicalNoteNotFoundError` whether it is missing or out of scope. */
async function requireNote(
  tx: Prisma.TransactionClient,
  query: NoteQuery,
): Promise<ClinicalNoteView> {
  const row = await tx.clinicalNote.findFirst({
    where: whereNote(query),
    select: NOTE_SELECT,
  });
  if (!row) throw new ClinicalNoteNotFoundError();
  return toNoteView(row);
}

/**
 * EN-121. The attention, or the one refusal that covers «no existe» and «es de
 * otra sede».
 */
async function requireEncounter(
  tx: Prisma.TransactionClient,
  encounterId: string,
  sites: SiteScopeFilter,
): Promise<Prisma.EncounterGetPayload<{ select: typeof ENCOUNTER_FOR_NOTE }>> {
  const row = await tx.encounter.findFirst({
    where: { id: encounterId, ...siteFilter(sites) },
    select: ENCOUNTER_FOR_NOTE,
  });
  if (!row) throw new EncounterNotFoundError();
  return row;
}

/** The attention as the note policy judges it; `agendaEntryId` stays with the adapter, which moves the board. */
function toEncounterRead(
  row: Prisma.EncounterGetPayload<{ select: typeof ENCOUNTER_FOR_NOTE }>,
): NoteEncounterRead {
  return {
    id: row.id,
    status: row.status,
    practitionerId: row.practitionerId,
    endedAt: row.endedAt,
    dischargeCondition: row.dischargeCondition,
  };
}

/**
 * EN-137, EN-138. Moves the board because a note was documented.
 *
 * A COPY OF THE SAME FOUR LINES THE ENCOUNTER ADAPTER HAS, and it is on
 * purpose rather than an oversight: sharing it would mean one adapter
 * importing the other's file, and the shared piece — «which state does this
 * fact prove, and does it move the patient forward» — is already ONE function
 * in the domain (`subjectStatusAfter`), which is where the rule that could
 * drift actually lives. What is duplicated is the two Prisma statements.
 *
 * A WALK-IN WITH NO AGENDA ROW IS A NO-OP: `agenda_entry_id` is nullable
 * (EN-003), and refusing to sign a note because there is nowhere to paint the
 * board would trade the medico-legal record for a tile on a screen.
 */
async function stampSubjectStatus(
  tx: Prisma.TransactionClient,
  agendaEntryId: string | null,
  fact: 'NOTE_OPENED' | 'NOTE_SIGNED',
): Promise<void> {
  if (agendaEntryId === null) return;

  const entry = await tx.agendaEntry.findUnique({
    where: { id: agendaEntryId },
    select: { id: true, subjectStatus: true },
  });
  if (!entry) return;

  const next = subjectStatusAfter(fact, entry.subjectStatus);
  if (next === null) return;

  await tx.agendaEntry.update({
    where: { id: entry.id },
    // EN-140. `agenda_entry_subject_status_carries_its_instant` refuses a
    // state with no instant, so the two are always written together.
    data: { subjectStatus: next, subjectStatusAt: new Date() },
  });
}

/**
 * AG-146. Opening the note puts the APPOINTMENT in attendance, in the same
 * transaction, with its history row (AG-004).
 *
 * The patient axis already moved here (EN-137) and the appointment axis did
 * not: the board read «En atención» from one and the menu offered «Pasar a
 * atención», «Se fue sin ser atendido» and «Anular…» from the other. Nobody
 * presses «Pasar a atención»; the work marks the state (AG-122).
 *
 * ONLY FROM `CHECKED_IN`, conditioned in the `UPDATE` itself: an appointment
 * whose arrival was never recorded keeps its status, because the arrival
 * carries the emergency assessment of Ley 77 art. 10 (AG-128) and jumping it
 * would lose that record. A second note on the same attention finds the
 * appointment already `IN_PROGRESS` and writes nothing.
 *
 * WRITTEN HERE AND NOT THROUGH `agenda`: no module imports another, and the
 * agenda port answers HTTP transitions in a transaction of its own. These are
 * the same two statements its adapter writes — the conditional update and the
 * history row — so the trail reads the same whichever side moved it.
 */
async function startAttendance(
  tx: Prisma.TransactionClient,
  agendaEntryId: string | null,
  changedById: string,
): Promise<void> {
  if (agendaEntryId === null) return;

  const moved = await tx.agendaEntry.updateMany({
    where: { id: agendaEntryId, status: 'CHECKED_IN' },
    data: { status: 'IN_PROGRESS' },
  });
  if (moved.count === 0) return;

  await tx.agendaStatusHistory.create({
    data: {
      agendaEntryId,
      fromStatus: 'CHECKED_IN',
      toStatus: 'IN_PROGRESS',
      changedById,
    },
  });
}

/** EN-121. The caller's resolved scope as a `where` fragment; `'all'` adds no filter. */
function siteFilter(sites: SiteScopeFilter): Prisma.EncounterWhereInput {
  return sites === 'all' ? {} : { siteId: { in: [...sites] } };
}

/** A `clinical_note` row as the domain reads it. */
function toNoteView(row: NoteRow): ClinicalNoteView {
  return {
    id: row.id,
    encounterId: row.encounterId,
    chainId: row.chainId,
    version: row.version,
    formCode: row.formCode,
    formVersion: row.formVersion,
    status: row.status,
    /**
     * `content` is `JsonB` and Prisma types it as `JsonValue`. The domain
     * declares it as an object of narrative sections, which is what the JSON
     * Schema of `(form_code, form_version)` will validate — the cast records
     * that the column only ever receives an object from this module.
     */
    content: (row.content ?? {}) as NoteContent,
    authorId: row.authorId,
    signedById: row.signedById,
    signedAt: row.signedAt,
    contentHash: row.contentHash,
    supersedesId: row.supersedesId,
    amendmentReason: row.amendmentReason,
    createdAt: row.createdAt,
  };
}
