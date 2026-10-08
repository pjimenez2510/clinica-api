import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  AppointmentArrivalNotRecordedError,
  EncounterHasLiveActsError,
  type LivePaper,
  EncounterHasOthersDraftsError,
  EncounterNotFoundError,
  InvalidEncounterTransitionError,
} from '../domain/encounter.errors';
import type { EncounterStatus } from '../domain/encounter';
import type {
  AnnulmentPlan,
  HoldPlan,
  InterruptionPlan,
  ResumePlan,
} from '../domain/encounter-state';
import type {
  AnnulmentActor,
  DraftSigning,
  EncounterExitRepository,
  InterruptionOutcome,
  Substitution,
} from '../domain/encounter-exit.repository';
import { hasWrittenContent } from '../domain/encounter-exit';
import {
  STANDING_INTERCONSULTATION_STATUSES,
  STANDING_REFERRAL_STATUSES,
  hasClinicalAct,
} from '../../../shared/infrastructure/prisma/clinical-acts';
import type {
  EncounterQuery,
  EncounterView,
} from '../domain/encounter.repository';
import {
  ENCOUNTER_SELECT,
  siteFilter,
  toEncounterView,
} from './prisma-encounter.repository';

/**
 * EN-166, EN-167, AG-147, AG-149 over PostgreSQL. The attention, its notes and
 * its appointment move in ONE transaction, the attention locked first.
 *
 * THE LOCK ORDER, said as it is. The note (`createDraft`, AG-146), the
 * departure at the counter (AG-148) and these two exits lock the ATTENTION and
 * then write the APPOINTMENT. Opening an attention (`PrismaEncounterRepository
 * .open`) goes the other way —it locks the appointment and then inserts— and
 * can meet an exit of the SAME appointment in the one window where both are
 * running: PostgreSQL detects that cycle and aborts one of them with 40P01,
 * which the client sees as a retryable conflict. It is not silent and it does
 * not leave half a write.
 */
@Injectable()
export class PrismaEncounterExitRepository implements EncounterExitRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** EN-166, AG-147. See the port. */
  async annul(
    query: EncounterQuery,
    decide: (encounter: EncounterView) => AnnulmentPlan & Substitution,
    actor: AnnulmentActor,
  ): Promise<EncounterView> {
    const changedById = actor.userId;
    return this.prisma.$transaction(async (tx) => {
      const current = await lockAndRead(tx, query);
      const plan = decide(current);

      /**
       * D-085 §2, as for the interruption. A draft of ANOTHER prescriber or
       * signer is theirs to issue or discard (PR-100, D-123.1): discarding it
       * in somebody else's name would make one click of a colleague take away
       * a prescription its author was still writing. The annulment is refused
       * and says why; nothing is discarded.
       */
      if (await hasOthersDrafts(tx, current.id, actor.practitionerId)) {
        throw new EncounterHasOthersDraftsError('annulment');
      }

      /**
       * EN-218 (AT-22). The drafts never left the consultation (D-126.1): the
       * annuller's own prescription or order still in draft is discarded by
       * the annulment itself, in this transaction, with who and when —the
       * same columns their own «Descartar» writes (PR-107, ORD-099)—. If
       * anything below refuses, the transaction rolls back and they are
       * drafts again.
       */
      await discardDrafts(tx, current.id, actor, plan.at);

      /**
       * D-099 §1. What the attention already left in the chart is retracted
       * by its own door —the prescription (PR-010), the order (ORD-007), the
       * signed note (EN-026)— before the attention can say it never existed.
       * Annulled with it, a prescription would stay valid on paper in the
       * wrong patient's name, and an order pending at the laboratory. Each
       * paper is named, with its number (EN-218).
       */
      const papers = await livePapersOf(tx, current.id);
      if (papers.length > 0) throw new EncounterHasLiveActsError(papers);

      await moveConditionally(tx, query, current.status, plan.to, {
        status: plan.to,
        endedAt: plan.endedAt,
        enteredInErrorReason: plan.reason,
        enteredInErrorById: changedById,
        enteredInErrorAt: plan.at,
        exitSubstituteReason: plan.substituteReason,
      });

      /**
       * AG-147. The appointment goes back to the waiting room: the error was
       * opening the attention, not giving the appointment, and the patient
       * may still be there. `ARRIVED` because everything documented about
       * them since the arrival lived in the attention now annulled — which is
       * also why an appointment still `CHECKED_IN` (a note opened before
       * AG-146, or none at all) gets its patient axis back to `ARRIVED`.
       */
      if (current.agendaEntryId !== null) {
        const moved = await moveAppointment(tx, {
          agendaEntryId: current.agendaEntryId,
          from: 'IN_PROGRESS',
          to: 'CHECKED_IN',
          subjectStatus: 'ARRIVED',
          at: plan.at,
          changedById,
          note: 'Atención anulada',
        });
        if (!moved) {
          await tx.agendaEntry.updateMany({
            where: { id: current.agendaEntryId, status: 'CHECKED_IN' },
            data: { subjectStatus: 'ARRIVED', subjectStatusAt: plan.at },
          });
        }
      }

      return readView(tx, query.encounterId);
    });
  }

  /** EN-167, AG-149. See the port. */
  async discontinue(
    query: EncounterQuery,
    decide: (encounter: EncounterView) => InterruptionPlan & Substitution,
    drafts: DraftSigning,
    changedById: string,
  ): Promise<InterruptionOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockAndRead(tx, query);
      const plan = decide(current);

      /**
       * D-082 signs the drafts of WHOEVER INTERRUPTS. A draft of somebody
       * else would be left unsigned inside a terminal attention, where its
       * author can no longer sign it — the «texto sin responsable» D-082
       * rejected; so the interruption is refused and says why (D-085 §2).
       */
      const othersDrafts = await tx.clinicalNote.count({
        where: {
          encounterId: current.id,
          status: 'DRAFT',
          authorId: { not: drafts.authorId },
        },
      });
      if (othersDrafts > 0)
        throw new EncounterHasOthersDraftsError('interruption');

      // D-085 §3: attended means any clinical act, asked BEFORE the state
      // changes and under the lock.
      const attended = await hasClinicalAct(tx, current.id);

      /**
       * D-099 §2. An appointment whose arrival was never recorded cannot be
       * closed with the truth: «atendida» or «se fue sin ser atendido» both
       * presuppose an arrival, and the arrival carries the emergency
       * assessment of Ley 77 art. 10. The arrival is recorded first.
       */
      if (current.agendaEntryId !== null) {
        const appointment = await tx.agendaEntry.findUnique({
          where: { id: current.agendaEntryId },
          select: { status: true },
        });
        if (
          appointment?.status === 'BOOKED' ||
          appointment?.status === 'CONFIRMED'
        ) {
          throw new AppointmentArrivalNotRecordedError();
        }
      }

      /**
       * D-082. «Con lo hecho»: each draft is signed as it stands, with no
       * completeness demanded and no discharge, and the signature is what gives a responsible author
       * to what was written. Conditioned on `DRAFT` like every signature.
       */
      const own = await tx.clinicalNote.findMany({
        where: {
          encounterId: current.id,
          status: 'DRAFT',
          authorId: drafts.authorId,
        },
        select: { id: true, content: true },
      });
      const signedNoteIds: string[] = [];
      const unsignedEmptyNoteIds: string[] = [];
      for (const draft of own) {
        // D-085 §5: an empty draft is not signed; it stays, frozen and empty,
        // and the service leaves the trail of it (D-099 §4).
        if (!hasWrittenContent(draft.content)) {
          unsignedEmptyNoteIds.push(draft.id);
          continue;
        }
        const signature = drafts.sign({ content: draft.content });
        const signed = await tx.clinicalNote.updateMany({
          where: { id: draft.id, status: 'DRAFT' },
          data: {
            status: 'SIGNED',
            content: signature.content as Prisma.InputJsonValue,
            signedById: signature.signedById,
            signedAt: signature.signedAt,
            contentHash: signature.contentHash,
          },
        });
        if (signed.count === 1) signedNoteIds.push(draft.id);
      }

      // EN-206. The state moves AFTER the drafts are signed: signing writes
      // the background snapshot into the content, and
      // `trg_clinical_note_frozen_in_terminal_encounter` refuses touching a
      // draft's content once the attention is `DISCONTINUED`.
      await moveConditionally(tx, query, current.status, plan.to, {
        status: plan.to,
        endedAt: plan.endedAt,
        discontinuedReason: plan.reason,
        discontinuedOrigin: plan.origin,
        discontinuedById: changedById,
        discontinuedAt: plan.at,
        exitSubstituteReason: plan.substituteReason,
      });

      if (current.agendaEntryId !== null) {
        await settleAppointment(tx, {
          agendaEntryId: current.agendaEntryId,
          attended,
          at: plan.at,
          changedById,
          note: 'Atención interrumpida',
        });
      }

      return {
        encounter: await readView(tx, query.encounterId),
        signedNoteIds,
        unsignedEmptyNoteIds,
      };
    });
  }

  /** EN-128. See the port. */
  async hold(
    query: EncounterQuery,
    decide: (encounter: EncounterView) => HoldPlan,
    changedById: string,
  ): Promise<EncounterView> {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockAndRead(tx, query);
      const plan = decide(current);
      await moveConditionally(tx, query, current.status, plan.to, {
        status: plan.to,
        holdReason: plan.reason,
        heldById: changedById,
        heldAt: plan.at,
      });
      // AG-124. The other axis of the same fact: the board shows the patient
      // out of the building, not «en atención» in an empty consulting room.
      await movePatientAxis(tx, current.agendaEntryId, {
        from: ['ARRIVED', 'IN_PREPARATION', 'READY', 'RECEIVING_CARE'],
        to: 'ON_LEAVE',
        at: plan.at,
      });
      return readView(tx, query.encounterId);
    });
  }

  /** EN-128. See the port. */
  async resume(
    query: EncounterQuery,
    decide: (encounter: EncounterView) => ResumePlan,
    changedById: string,
  ): Promise<EncounterView> {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockAndRead(tx, query);
      const plan = decide(current);
      await moveConditionally(tx, query, current.status, plan.to, {
        status: plan.to,
        resumedById: changedById,
        resumedAt: plan.at,
      });
      // AG-124. Back in the building, and back in the attention they left.
      await movePatientAxis(tx, current.agendaEntryId, {
        from: ['ON_LEAVE'],
        to: 'RECEIVING_CARE',
        at: plan.at,
      });
      return readView(tx, query.encounterId);
    });
  }
}

/**
 * EN-166, EN-167. Reads the attention within the caller's scope, LOCKS it, and
 * reads it again under the lock.
 *
 * THE SCOPE FIRST: somebody outside the site gets the 404 without ever taking
 * the row lock — a lock is a write, however brief, and it is not theirs to
 * take. The second read is the one the decision is made on.
 */
async function lockAndRead(
  tx: Prisma.TransactionClient,
  query: EncounterQuery,
): Promise<EncounterView> {
  const inScope = await tx.encounter.findFirst({
    where: { id: query.encounterId, ...siteFilter(query.sites) },
    select: { id: true },
  });
  if (!inScope) throw new EncounterNotFoundError();

  await tx.$queryRaw`
    SELECT 1 FROM "encounter" WHERE "id" = ${query.encounterId}::uuid FOR UPDATE
  `;
  return readView(tx, query.encounterId);
}

/**
 * D-099 §1. What the attention left standing in the chart, counted under the
 * attention's lock so a writer that locks it too cannot slip one in between.
 *
 * - a prescription active or still in draft (retracted by PR-010);
 * - an order in draft, or issued with an item the laboratory still sees
 *   (ORD-007, ORD-102);
 * - a signed note (EN-026);
 * - a certificate not revoked — an IESS rest certificate on the wrong
 *   patient is a document someone can still present (3.ª revisión, m5);
 * - a referral `ISSUED` or `ACCEPTED` —another establishment is expecting
 *   the patient— or `COMPLETED` —the patient was seen there, which no
 *   annulment undoes (D-103 §2);
 * - an interconsultation `REQUESTED` —a colleague is about to answer it— or
 *   `ANSWERED` —a colleague wrote an opinion on this patient, which stands
 *   like a signed note (D-103 §1).
 *
 * Only `REJECTED`/`EXPIRED` and `CANCELLED` let it through. An issued referral
 * has no way to be withdrawn yet; `CANCELLED` comes with the delivery that
 * builds referrals (D-103 §3), and until then no route creates one.
 */
async function livePapersOf(
  tx: Prisma.TransactionClient,
  encounterId: string,
): Promise<LivePaper[]> {
  const [
    prescriptions,
    orders,
    signedNotes,
    certificates,
    referrals,
    interconsultations,
  ] = await Promise.all([
    // EN-218: the drafts were discarded just before; only the issued stand.
    tx.prescription.findMany({
      where: { encounterId, status: { in: ['DRAFT', 'ACTIVE'] } },
      select: { id: true, sequenceNumber: true },
      orderBy: { createdAt: 'asc' },
    }),
    tx.serviceOrder.findMany({
      where: {
        encounterId,
        OR: [
          { status: 'DRAFT' },
          {
            status: 'ISSUED',
            items: { some: { status: { in: ['REQUESTED', 'IN_PROGRESS'] } } },
          },
        ],
      },
      select: { id: true, number: true },
      orderBy: { createdAt: 'asc' },
    }),
    tx.clinicalNote.findMany({
      where: { encounterId, status: 'SIGNED' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    }),
    tx.medicalCertificate.findMany({
      where: { encounterId, revokedAt: null },
      select: { id: true, number: true },
      orderBy: { number: 'asc' },
    }),
    tx.referral.findMany({
      where: { encounterId, status: { in: [...STANDING_REFERRAL_STATUSES] } },
      select: { id: true },
    }),
    tx.interconsultation.findMany({
      where: {
        encounterId,
        status: { in: [...STANDING_INTERCONSULTATION_STATUSES] },
      },
      select: { id: true },
    }),
  ]);
  return [
    ...prescriptions.map((row) => ({ kind: 'prescriptions' as const, id: row.id, number: row.sequenceNumber })), // prettier-ignore
    ...orders.map((row) => ({ kind: 'orders' as const, id: row.id, number: row.number })), // prettier-ignore
    ...signedNotes.map((row) => ({ kind: 'signedNotes' as const, id: row.id, number: null })), // prettier-ignore
    ...certificates.map((row) => ({ kind: 'certificates' as const, id: row.id, number: row.number })), // prettier-ignore
    ...referrals.map((row) => ({ kind: 'referrals' as const, id: row.id, number: null })), // prettier-ignore
    ...interconsultations.map((row) => ({ kind: 'interconsultations' as const, id: row.id, number: null })), // prettier-ignore
  ];
}

/**
 * EN-218, D-085 §2. Whether a prescription or an order of the attention is
 * still a draft of somebody other than whoever annuls.
 */
async function hasOthersDrafts(
  tx: Prisma.TransactionClient,
  encounterId: string,
  practitionerId: string,
): Promise<boolean> {
  const [prescriptions, orders] = await Promise.all([
    tx.prescription.count({
      where: { encounterId, status: 'DRAFT', prescriberId: { not: practitionerId } }, // prettier-ignore
    }),
    tx.serviceOrder.count({
      where: { encounterId, status: 'DRAFT', orderedById: { not: practitionerId } }, // prettier-ignore
    }),
  ]);
  return prescriptions + orders > 0;
}

/**
 * EN-218 (AT-22). The annuller's own drafts, discarded with the annulment —
 * `hasOthersDrafts` already refused anybody else's. The prescription keeps a
 * fixed reason so its list reads why it went; the order's discard has no
 * reason column.
 */
async function discardDrafts(
  tx: Prisma.TransactionClient,
  encounterId: string,
  actor: AnnulmentActor,
  at: Date,
): Promise<void> {
  await tx.prescription.updateMany({
    where: { encounterId, status: 'DRAFT', prescriberId: actor.practitionerId },
    data: {
      status: 'DISCARDED',
      discardedAt: at,
      discardedById: actor.userId,
      discardReason: 'Atención anulada',
    },
  });
  await tx.serviceOrder.updateMany({
    where: { encounterId, status: 'DRAFT', orderedById: actor.practitionerId },
    data: { status: 'DISCARDED', discardedAt: at, discardedById: actor.userId },
  });
}

/**
 * The write of a state change, conditioned on the status that was read. The
 * row is locked, so a zero count can only be a writer that bypassed the lock;
 * the refusal still names the state THEY left.
 */
async function moveConditionally(
  tx: Prisma.TransactionClient,
  query: EncounterQuery,
  from: EncounterStatus,
  to: EncounterStatus,
  data: Prisma.EncounterUncheckedUpdateManyInput,
): Promise<void> {
  const updated = await tx.encounter.updateMany({
    where: { id: query.encounterId, ...siteFilter(query.sites), status: from },
    data,
  });
  if (updated.count === 0) {
    const now = await tx.encounter.findUniqueOrThrow({
      where: { id: query.encounterId },
      select: { status: true },
    });
    throw new InvalidEncounterTransitionError(now.status, to);
  }
}

/**
 * AG-149, AG-148 (D-076, D-081, D-085 §3). Where the appointment of an
 * interrupted attention ends, decided by the CLINICAL ACTS — the note D-076
 * names, or a diagnosis, a procedure, a prescription, an order:
 *
 *  - with a note there was a consultation: the appointment is ATTENDED
 *    (`FULFILLED`), and the patient has left. From `IN_PROGRESS` directly;
 *    from `CHECKED_IN` —a note opened before AG-146 moved appointments— it
 *    goes through `IN_PROGRESS`, two history rows, because that is the step
 *    the machine has and the one the note should have taken.
 *  - without a note nobody attended them (D-081 §2): `CHECKED_IN` ends as
 *    «se fue sin ser atendido», with its own instant and the slot given back,
 *    exactly what the counter would have written (AG-116).
 *
 * Any other status is left alone: a walk-in has no appointment, and one
 * already closed is not the agenda's to reopen.
 */
async function settleAppointment(
  tx: Prisma.TransactionClient,
  settle: {
    agendaEntryId: string;
    attended: boolean;
    at: Date;
    changedById: string;
    note: string;
  },
): Promise<void> {
  const common = {
    agendaEntryId: settle.agendaEntryId,
    at: settle.at,
    changedById: settle.changedById,
    note: settle.note,
  };

  if (!settle.attended) {
    // D-099 §2: one already in attendance with nothing documented —moved there
    // through the API that AG-120 keeps— goes back to the room first, so the
    // departure is told from where it really happened.
    await moveAppointment(tx, {
      ...common,
      from: 'IN_PROGRESS',
      to: 'CHECKED_IN',
      subjectStatus: 'ARRIVED',
    });
    await moveAppointment(tx, {
      ...common,
      from: 'CHECKED_IN',
      to: 'LEFT_WITHOUT_BEING_SEEN',
      subjectStatus: 'DEPARTED',
      effects: { releasedAt: settle.at, leftWithoutBeingSeenAt: settle.at },
    });
    return;
  }

  // Each step is conditioned on its own `from`, so whichever applies runs.
  await moveAppointment(tx, {
    ...common,
    from: 'CHECKED_IN',
    to: 'IN_PROGRESS',
    subjectStatus: 'RECEIVING_CARE',
  });
  await moveAppointment(tx, {
    ...common,
    from: 'IN_PROGRESS',
    to: 'FULFILLED',
    subjectStatus: 'DEPARTED',
  });
}

/**
 * AG-124, EN-128. Moves ONLY the patient axis of the attention's appointment,
 * from the states named: the appointment's own status does not change —the
 * consultation is still in progress— and so it leaves no row in its history;
 * the fact that moved it is the suspension, in the attention's trail with its
 * reason. Never from `DEPARTED` (AG-125): a passage that ended stays ended.
 */
async function movePatientAxis(
  tx: Prisma.TransactionClient,
  agendaEntryId: string | null,
  move: {
    from: readonly ('ARRIVED' | 'IN_PREPARATION' | 'READY' | 'RECEIVING_CARE' | 'ON_LEAVE')[]; // prettier-ignore
    to: 'ON_LEAVE' | 'RECEIVING_CARE';
    at: Date;
  },
): Promise<void> {
  if (agendaEntryId === null) return;
  await tx.agendaEntry.updateMany({
    where: { id: agendaEntryId, subjectStatus: { in: [...move.from] } },
    data: { subjectStatus: move.to, subjectStatusAt: move.at },
  });
}

/**
 * AG-147, AG-148, AG-149. Moves the appointment of an attention, ONLY from the
 * status named and in the same statement, with its history row (AG-004) and
 * the patient axis. Answers whether it moved.
 *
 * WRITTEN HERE AND NOT THROUGH `agenda`: no module imports another. These are
 * the statements its own adapter writes, so the trail reads the same.
 */
async function moveAppointment(
  tx: Prisma.TransactionClient,
  move: {
    agendaEntryId: string;
    from: 'CHECKED_IN' | 'IN_PROGRESS';
    to: 'CHECKED_IN' | 'IN_PROGRESS' | 'FULFILLED' | 'LEFT_WITHOUT_BEING_SEEN';
    subjectStatus: 'ARRIVED' | 'RECEIVING_CARE' | 'DEPARTED';
    at: Date;
    changedById: string;
    note: string;
    effects?: { releasedAt: Date; leftWithoutBeingSeenAt: Date };
  },
): Promise<boolean> {
  const moved = await tx.agendaEntry.updateMany({
    where: {
      id: move.agendaEntryId,
      status: move.from,
      ...(move.effects ? { releasedAt: null } : {}),
    },
    data: {
      status: move.to,
      subjectStatus: move.subjectStatus,
      subjectStatusAt: move.at,
      ...(move.effects ?? {}),
    },
  });
  if (moved.count === 0) return false;

  await tx.agendaStatusHistory.create({
    data: {
      agendaEntryId: move.agendaEntryId,
      fromStatus: move.from,
      toStatus: move.to,
      changedById: move.changedById,
      changedAt: move.at,
      note: move.note,
    },
  });
  return true;
}

/** The attention as it now stands, after the writes of the transaction. */
async function readView(
  tx: Prisma.TransactionClient,
  encounterId: string,
): Promise<EncounterView> {
  return toEncounterView(
    await tx.encounter.findUniqueOrThrow({
      where: { id: encounterId },
      select: ENCOUNTER_SELECT,
    }),
  );
}
