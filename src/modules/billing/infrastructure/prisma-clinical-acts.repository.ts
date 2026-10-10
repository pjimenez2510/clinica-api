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
  type DraftOrderNotice,
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
   * ⚠️ THE CONSULTATION COMES FROM THE APPOINTMENT'S SERVICE TYPE and from
   * nowhere else (BI-158, D-179.3): the type is what is charged. The
   * practitioner's specialties would make the price depend on which of them a
   * query returned first, and a walk-in with no appointment has no type at
   * all. `null` here is a proposal with one line missing (BI-155), which the
   * cashier fills in.
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
        agendaEntry: { select: { serviceTypeId: true } },
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
    const restoredFrom = await this.restoredFromOf(row.id);

    return {
      encounterId: row.id,
      siteId: row.siteId,
      patientId: row.patientId,
      status: row.status,
      serviceDate: clinicalDateOf(row.startedAt),
      visitSequence: row.visitSequence,
      serviceTypeId: row.agendaEntry?.serviceTypeId ?? null,
      clinicallyAttended,
      procedures: row.procedures.map((procedure): PerformedProcedure => ({
        encounterProcedureId: procedure.id,
        conceptId: procedure.conceptId,
        // The date it was PERFORMED, which on a visit that spans midnight is
        // not the date of the visit — and prices differently.
        serviceDate: clinicalDateOf(procedure.performedAt),
        quantity: procedure.quantity,
        restoredFrom: restoredFrom(procedure.id),
      })),
      // ⚠️ THE CLINICAL DATE OF THE VISIT (BI-193, D-123.7), not of the
      // result and not of the order. Not the result: most exams here are
      // performed externally and their report may never arrive. Not the
      // order: since ORD-098 `requested_at` is when it was ISSUED, and a
      // draft issued the next day was priced at the next day's tariff while
      // its service (ORD-004) was resolved on the visit's date. What was sold
      // was sold the day of the visit.
      exams: row.serviceOrders.flatMap((order) =>
        order.items.map((item): OrderedExam => ({
          serviceOrderItemId: item.id,
          testCode: item.testCode,
          serviceDate: clinicalDateOf(row.startedAt),
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
    const listed = await this.prisma.$queryRaw<
      { id: string; uncharged_exams: number }[]
    >`
      SELECT e.id,
             ${unchargedExamCount(Prisma.sql`e.id`)} AS uncharged_exams
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
    const uncharged = new Map(listed.map((row) => [row.id, row.uncharged_exams])); // prettier-ignore
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
        unchargedExams: uncharged.get(row.id) ?? 0,
      });
    }
    return visits;
  }

  /** BI-192. Scoped by site, like every read here (BI-135). */
  async draftOrdersOf(query: {
    encounterId: string;
    siteId: string;
  }): Promise<DraftOrderNotice[]> {
    const rows = await this.prisma.serviceOrder.findMany({
      where: {
        encounterId: query.encounterId,
        siteId: query.siteId,
        status: 'DRAFT',
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        createdAt: true,
        orderedBy: {
          select: { user: { select: { firstName: true, lastName: true } } },
        },
      },
    });
    return rows.map((row) => ({
      orderId: row.id,
      orderedByName: `${row.orderedBy.user.firstName} ${row.orderedBy.user.lastName}`,
      savedAt: row.createdAt,
    }));
  }

  /** BI-236. Scoped by site, like every read here (BI-135). */
  async encounterStatusOf(query: {
    encounterId: string;
    siteId: string;
  }): Promise<{ status: string; hasDrafts: boolean } | null> {
    const row = await this.prisma.encounter.findFirst({
      where: { id: query.encounterId, siteId: query.siteId },
      select: {
        status: true,
        _count: {
          select: {
            // D-189: only an order is still issuable with the discharge given.
            serviceOrders: { where: { status: 'DRAFT' } },
          },
        },
      },
    });
    if (!row) return null;
    return {
      status: row.status,
      hasDrafts: row._count.serviceOrders > 0,
    };
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

  /**
   * EN-246, BI-242. For each live procedure of the visit, the removed rows it
   * was restored from, newest first — read from the clinical archive, never
   * written. One query for the visit; the chain is followed in memory.
   */
  private async restoredFromOf(
    encounterId: string,
  ): Promise<(procedureId: string) => string[]> {
    const archived = await this.prisma.encounterProcedureRetraction.findMany({
      where: { encounterId, restoredAsId: { not: null } },
      select: { id: true, restoredAsId: true },
    });
    const formerOf = new Map(
      archived.map((row) => [row.restoredAsId!, row.id] as const),
    );
    return (procedureId) => {
      const chain: string[] = [];
      let current = formerOf.get(procedureId);
      while (current !== undefined && chain.length < 50) {
        chain.push(current);
        current = formerOf.get(current);
      }
      return chain;
    };
  }
}

/**
 * BI-181, BI-194. Ended at the site, and either no account of THIS visit
 * settled, or — settled — still something to charge: an account open again,
 * or an exam issued after the close that nothing charged (D-130.4).
 */
function awaitingCheckout(siteId: string): Prisma.Sql {
  return Prisma.sql`
    e.site_id = ${siteId}::uuid
    AND e.status::text IN (${Prisma.join([...ENDED_ENCOUNTER_STATUSES])})
    AND (
      NOT EXISTS (SELECT 1 FROM patient_account a
                   WHERE a.encounter_id = e.id AND a.status = 'SETTLED')
      OR EXISTS (SELECT 1 FROM patient_account a
                  WHERE a.encounter_id = e.id AND a.status = 'OPEN')
      OR EXISTS (SELECT 1 ${examsIssuedAfterSettlement(Prisma.sql`e.id`)})
      OR EXISTS (SELECT 1 ${proceduresRecordedAfterSettlement(Prisma.sql`e.id`)})
    )`;
}

/**
 * BI-242 (EN-247, D-194.1). The FROM/WHERE of the visit's procedures recorded
 * — or restored — AFTER the last settled account was opened, with an active
 * service tied to their concept and no charge naming them in any status, nor
 * a manual charge of that service in an account of the visit: the rule of
 * the exams (BI-194). Since the discharge no longer closes the coding, the
 * doctor may record the forgotten extraction once caja has settled; without
 * this the visit never came back to caja. `recorded_at` is the application's
 * clock, the same one that opened the account.
 */
function proceduresRecordedAfterSettlement(
  encounterId: Prisma.Sql,
): Prisma.Sql {
  return Prisma.sql`
      FROM encounter_procedure p
      JOIN billable_service s ON s.procedure_concept_id = p.concept_id AND s.active
     WHERE p.encounter_id = ${encounterId}
       AND p.recorded_at > (SELECT max(a.opened_at) FROM patient_account a
                             WHERE a.encounter_id = ${encounterId}
                               AND a.status = 'SETTLED')
       AND NOT EXISTS (SELECT 1 FROM charge_item c
                        WHERE c.encounter_procedure_id = p.id)
       AND NOT EXISTS (SELECT 1
                         FROM charge_item c
                         JOIN patient_account a ON a.id = c.account_id
                        WHERE a.encounter_id = ${encounterId}
                          AND c.origin = 'MANUAL'
                          AND c.status <> 'CANCELLED'
                          AND c.billable_service_id = s.id)`;
}

/** BI-194. How many exams issued after the last settlement nothing charged. */
function unchargedExamCount(encounterId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(SELECT count(*)::int ${examsIssuedAfterSettlement(encounterId)})`;
}

/**
 * BI-194. The FROM/WHERE of the visit's exams caja could still charge after
 * an account of it was settled:
 *
 *   · ISSUED after the last settled account was OPENED (`requested_at` is the
 *     issue instant, ORD-098). What was issued before, caja had in front of it
 *     when it passed the visit — and if it was not raised, it was decided: no
 *     price for the day and charged by hand (BI-155), say. Without this the
 *     visit came back for ever.
 *   · An ISSUED order (ORD-100), a line not cancelled, and an ACTIVE billable
 *     service in the catalogue: the same rule `proposeCharges` follows, or
 *     the visit would come back with nothing «Pasar a caja» could raise.
 *   · No charge naming it, in ANY status (a cancelled one is a decision, as in
 *     `listChargedActs`, BI-151) — NOR a manual charge of that same service
 *     in an account of the visit: the cashier may have charged it by hand
 *     while it was still a draft (BI-192), and proposing it again would
 *     charge it twice (revisión clínica de fix/criticos-d130, I-1; D-138).
 */
function examsIssuedAfterSettlement(encounterId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
      FROM service_order o
      JOIN service_order_item i ON i.service_order_id = o.id
      JOIN exam_definition d ON d.code = i.test_code
      JOIN billable_service s ON s.id = d.billable_service_id AND s.active
     WHERE o.encounter_id = ${encounterId}
       AND o.status = 'ISSUED'
       AND i.status <> 'CANCELLED'
       AND o.requested_at > (SELECT max(a.opened_at) FROM patient_account a
                              WHERE a.encounter_id = ${encounterId}
                                AND a.status = 'SETTLED')
       AND NOT EXISTS (SELECT 1 FROM charge_item c
                        WHERE c.service_order_item_id = i.id)
       AND NOT EXISTS (SELECT 1
                         FROM charge_item c
                         JOIN patient_account a ON a.id = c.account_id
                        WHERE a.encounter_id = ${encounterId}
                          AND c.origin = 'MANUAL'
                          AND c.status <> 'CANCELLED'
                          AND c.billable_service_id = s.id)`;
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
