import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  EncounterHasOthersDraftsError,
  EncounterNotFoundError,
  InvalidEncounterTransitionError,
} from '../domain/encounter.errors';
import type { EncounterStatus } from '../domain/encounter';
import type {
  AnnulmentPlan,
  InterruptionPlan,
} from '../domain/encounter-state';
import type {
  DraftSigning,
  EncounterExitRepository,
  InterruptionOutcome,
  Substitution,
} from '../domain/encounter-exit.repository';
import { hasWrittenContent } from '../domain/encounter-exit';
import { hasClinicalAct } from '../../../shared/infrastructure/prisma/clinical-acts';
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
    changedById: string,
  ): Promise<EncounterView> {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockAndRead(tx, query);
      const plan = decide(current);

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
       * rejected. Until the author decides that case (D-083), the
       * interruption is refused and says why.
       */
      const othersDrafts = await tx.clinicalNote.count({
        where: {
          encounterId: current.id,
          status: 'DRAFT',
          authorId: { not: drafts.authorId },
        },
      });
      if (othersDrafts > 0) throw new EncounterHasOthersDraftsError();

      // D-085 §3: attended means any clinical act, asked BEFORE the state
      // changes and under the lock.
      const attended = await hasClinicalAct(tx, current.id);

      await moveConditionally(tx, query, current.status, plan.to, {
        status: plan.to,
        endedAt: plan.endedAt,
        discontinuedReason: plan.reason,
        discontinuedOrigin: plan.origin,
        discontinuedById: changedById,
        discontinuedAt: plan.at,
        exitSubstituteReason: plan.substituteReason,
      });

      /**
       * D-082. «Con lo hecho»: each draft is signed as it stands, with no
       * completeness demanded and no discharge — the attention is already
       * `DISCONTINUED`, and the signature is what gives a responsible author
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
      for (const draft of own) {
        // D-085 §5: an empty draft is not signed; it stays, frozen and empty.
        if (!hasWrittenContent(draft.content)) continue;
        const signature = drafts.sign({ content: draft.content });
        const signed = await tx.clinicalNote.updateMany({
          where: { id: draft.id, status: 'DRAFT' },
          data: {
            status: 'SIGNED',
            signedById: signature.signedById,
            signedAt: signature.signedAt,
            contentHash: signature.contentHash,
          },
        });
        if (signed.count === 1) signedNoteIds.push(draft.id);
      }

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
      };
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
