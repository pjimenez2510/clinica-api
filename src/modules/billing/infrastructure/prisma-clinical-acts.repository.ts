import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  clinicalActExists,
  hasClinicalAct,
} from '../../../shared/infrastructure/prisma/clinical-acts';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { clinicalDateOf } from '../../../shared/domain/clinic-time';

import {
  type AwaitingCheckout,
  type ClinicalActsRepository,
  ENDED_ENCOUNTER_STATUSES,
  type EncounterActs,
  type EndedEncounterStatus,
  OrderedExam,
  PerformedProcedure,
} from '../domain/clinical-acts.port';

import {
  PATIENT_IDENTITY_SELECT,
  toPatientIdentity,
} from './patient-identity.select';

/**
 * WHAT ONE VISIT DID, read by billing's OWN adapter.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS FILE EXISTS AT ALL INSTEAD OF A CALL INTO `modules/encounter`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No module imports another (ADR-008 §3). `encounter_procedure` and
 * `service_order_item` are TABLES, and the question asked of them here —
 * «what does this visit suggest charging for» — is not a question the clinical
 * module asks or should have to answer. Billing declares the facts it needs in
 * its port and reads them itself, exactly as it already does for the patient's
 * identification (BI-082) and as `agenda` does for the merge state of a chart.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY STATEMENT HERE IS A READ, AND THE FILE HAS NO WRITE PATH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * BI-004. Money never touches the clinical record: voiding a charge cannot
 * delete a procedure, and amending a note cannot move money by itself. That is
 * a property of this file having no `update` and no `create` in it — not of
 * anybody remembering.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY DATE IS RESOLVED IN `America/Guayaquil`. BI-002, BI-052.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not by the host's zone and not by `::date` on a `timestamptz`: a procedure
 * performed at 21:00 in Ecuador falls on the NEXT day in UTC, and here that
 * does not shift a statistic — it resolves a different price, because the
 * validity that started that midnight would apply.
 */
/** D-119. Most visits caja is shown at once. */
const AWAITING_CHECKOUT_LIMIT = 200;

@Injectable()
export class PrismaClinicalActsRepository implements ClinicalActsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * BI-150, BI-151. The visit and its acts, in ONE round trip.
   *
   * ⚠️ THE SPECIALTY COMES FROM THE APPOINTMENT'S SERVICE TYPE and from
   * nowhere else. The alternative — the practitioner's specialties — is wrong
   * in the one case that matters: a doctor registered under two specialties
   * would make the consultation price depend on which of them a query happened
   * to return first, and a walk-in with no appointment would still have no
   * answer. `null` here is a proposal with one line missing (BI-155), which
   * the cashier fills in; a wrong specialty is a wrong price on an invoice
   * nobody can correct afterwards.
   *
   * ⚠️ AND IT IS SCOPED BY SITE, so a visit of another site answers `null` —
   * indistinguishable from one that does not exist (BI-135). A visit confirms
   * that a person was at a clinic.
   */
  async findEncounterActs(query: {
    encounterId: string;
    siteId: string;
  }): Promise<EncounterActs | null> {
    const row = await this.prisma.encounter.findFirst({
      where: { id: query.encounterId, siteId: query.siteId },
      select: {
        id: true,
        siteId: true,
        patientId: true,
        status: true,
        startedAt: true,
        visitSequence: true,
        agendaEntry: {
          select: { serviceType: { select: { specialtyId: true } } },
        },
        procedures: {
          select: {
            id: true,
            conceptId: true,
            performedAt: true,
            quantity: true,
          },
          orderBy: { performedAt: 'asc' },
        },
        serviceOrders: {
          // ORD-100. A draft or a discarded order proposes no charge.
          where: { status: 'ISSUED' },
          select: {
            requestedAt: true,
            items: {
              select: { id: true, testCode: true, status: true },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: { requestedAt: 'asc' },
        },
      },
    });

    if (row === null) return null;
    const clinicallyAttended = await hasClinicalAct(this.prisma, row.id);

    return {
      encounterId: row.id,
      siteId: row.siteId,
      patientId: row.patientId,
      status: row.status,
      serviceDate: clinicalDateOf(row.startedAt),
      visitSequence: row.visitSequence,
      specialtyId: row.agendaEntry?.serviceType?.specialtyId ?? null,
      clinicallyAttended,
      procedures: row.procedures.map((procedure): PerformedProcedure => ({
        encounterProcedureId: procedure.id,
        conceptId: procedure.conceptId,
        // The date it was PERFORMED, which on a visit that spans midnight is
        // not the date of the visit — and prices differently.
        serviceDate: clinicalDateOf(procedure.performedAt),
        quantity: procedure.quantity,
      })),
      // ⚠️ THE DATE OF THE ORDER, not of the result. The clinic sold the
      // request: the patient took the order and the specimen was drawn. Most
      // exams here are performed externally (`performed_externally` defaults
      // to true) and their report may never arrive, so pricing by the result
      // would leave those lines uncharged forever.
      exams: row.serviceOrders.flatMap((order) =>
        order.items.map((item): OrderedExam => ({
          serviceOrderItemId: item.id,
          testCode: item.testCode,
          serviceDate: clinicalDateOf(order.requestedAt),
          cancelled: item.status === 'CANCELLED',
        })),
      ),
    };
  }

  /**
   * BI-181 to BI-183. What caja still has to look at, in one query plus one
   * per visit that was interrupted.
   *
   * «STILL OWED» MEANS NO SETTLED ACCOUNT. A visit with an open account is
   * listed with it — it is half way through the counter — and one whose
   * account was cancelled is listed as never having gone, because nothing was
   * charged for it.
   *
   * BI-182. `hasClinicalAct` is asked ONLY OF THE INTERRUPTED. A discharged or
   * completed visit got there by signing a 002 whose mandatory sections are
   * written text (EN-024, EN-130), so it was attended by construction; asking
   * eight questions per row of the day to learn that would be the N+1 this
   * list must not be.
   */
  async listAwaitingCheckout(query: {
    siteId: string;
    endedFrom: Date;
    neverChargedBefore: Date;
  }): Promise<AwaitingCheckout[]> {
    // BI-190. Which ones, decided in SQL: the never-charged test is per row
    // and the older ones have no ceiling, so it cannot be a filter in memory
    // after a `take`.
    const listed = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT e.id
        FROM encounter e
       WHERE ${awaitingCheckout(query.siteId)}
         AND e.ended_at >= ${query.endedFrom}
         AND NOT (e.ended_at < ${query.neverChargedBefore} AND ${neverCharged})
       ORDER BY e.ended_at DESC
       LIMIT ${AWAITING_CHECKOUT_LIMIT}
    `;
    const rows = await this.prisma.encounter.findMany({
      where: { id: { in: listed.map((row) => row.id) } },
      select: {
        id: true,
        status: true,
        endedAt: true,
        patient: { select: PATIENT_IDENTITY_SELECT },
        accounts: {
          where: { status: 'OPEN' },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { endedAt: 'desc' },
      // A ceiling, not a page: the seven-day list never reaches it, and the
      // older ones (D-119) come newest first — the ones still worth chasing.
      take: AWAITING_CHECKOUT_LIMIT,
    });

    // In sequence and not all at once: each interrupted visit costs eight
    // small questions, and firing them for every row together would take the
    // pool from everybody else at the counter.
    const visits: AwaitingCheckout[] = [];
    for (const row of rows) {
      const status = row.status as EndedEncounterStatus;
      const open = row.accounts[0];
      visits.push({
        encounterId: row.id,
        status,
        // `encounter_status_matches_ended_at`: an ended visit has its instant.
        endedAt: row.endedAt!,
        clinicallyAttended:
          status !== 'DISCONTINUED' ||
          (await hasClinicalAct(this.prisma, row.id)),
        patient: toPatientIdentity(row.patient),
        account: open ? { id: open.id, status: 'OPEN' } : null,
      });
    }
    return visits;
  }

  /**
   * D-119. How many ended visits older than the window are still unsettled,
   * so the screen can say they exist instead of dropping them silently.
   */
  async countAwaitingBefore(query: {
    siteId: string;
    endedBefore: Date;
  }): Promise<number> {
    // BI-190. Not the ones that are never charged: the notice would grow
    // forever with visits nobody is going to chase.
    const [row] = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM encounter e
       WHERE ${awaitingCheckout(query.siteId)}
         AND e.ended_at < ${query.endedBefore}
         AND NOT ${neverCharged}
    `;
    return row?.count ?? 0;
  }
}

/** BI-181. Ended at the site, and no account of THIS visit settled. */
function awaitingCheckout(siteId: string): Prisma.Sql {
  return Prisma.sql`
    e.site_id = ${siteId}::uuid
    AND e.status::text IN (${Prisma.join([...ENDED_ENCOUNTER_STATUSES])})
    AND NOT EXISTS (SELECT 1 FROM patient_account a
                     WHERE a.encounter_id = e.id AND a.status = 'SETTLED')`;
}

/**
 * BI-190 (D-119, ampliada). The visits that will never be charged: an
 * interruption with no clinical act proposes nothing (BI-180), and a
 * cancelled account with no open one is the decision not to charge, taken.
 * Neither counts as «never» once caja has an open account for the visit.
 */
const neverCharged = Prisma.sql`(
  -- An open account means caja began charging it, whatever the act (M2).
  NOT EXISTS (SELECT 1 FROM patient_account a
               WHERE a.encounter_id = e.id AND a.status = 'OPEN')
  AND (
    (e.status = 'DISCONTINUED' AND NOT ${clinicalActExists(Prisma.sql`e.id`)})
    OR EXISTS (SELECT 1 FROM patient_account a
                WHERE a.encounter_id = e.id AND a.status = 'CANCELLED')
  )
)`;
