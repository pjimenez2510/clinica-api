import { Injectable } from '@nestjs/common';

import { hasClinicalAct } from '../../../shared/infrastructure/prisma/clinical-acts';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { clinicalDateOf } from '../../../shared/domain/clinic-time';

import type {
  ClinicalActsRepository,
  EncounterActs,
  OrderedExam,
  PerformedProcedure,
} from '../domain/clinical-acts.port';

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
}
