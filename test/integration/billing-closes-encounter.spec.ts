import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import '../../src/modules/billing/infrastructure/billing.constraints';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { Quantity } from '../../src/modules/billing/domain/money';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
  hourSlot,
} from './setup/fixtures';

/**
 * D-184, AS THE DATABASE GUARANTEES IT: closing the account in caja closes
 * the attention that already has its discharge, in the same transaction
 * (BI-236, EN-131, EN-139), and an account with nothing invoiced is settled
 * only with the reason it is not charged (BI-237).
 *
 * Every refusal goes with its positive control, and every «it closes» with
 * the account whose attention it must NOT close: a trigger that closed
 * everything would pass the first half alone.
 */
const db = useDatabase();
const MINUTE = 60_000;

interface Clinic {
  prisma: PrismaClient;
  accounts: PrismaBillingAccountRepository;
  siteId: string;
  practitionerId: string;
  patientId: string;
  payerId: string;
  priceListId: string;
  serviceId: string;
  emissionPointId: string;
  cashierId: string;
}

let clinic: Clinic;

beforeEach(async () => {
  const prisma = db();
  await seedBilling(prisma);
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const cashier = await createUser(prisma);
  const payer = await prisma.payer.findUniqueOrThrow({
    where: { code: 'PARTICULAR' },
  });
  const priceList = await prisma.priceList.findFirstOrThrow({
    where: { payerId: payer.id },
  });
  const emissionPoint = await prisma.emissionPoint.create({
    data: { siteId: site.id, code: '001', description: 'Caja principal' },
  });
  clinic = {
    prisma,
    accounts: new PrismaBillingAccountRepository(
      prisma as unknown as PrismaService,
    ),
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
    payerId: payer.id,
    priceListId: priceList.id,
    serviceId: (
      await prisma.billableService.findUniqueOrThrow({
        where: { code: 'CONS-MG-PV' },
      })
    ).id,
    emissionPointId: emissionPoint.id,
    cashierId: cashier.id,
  };
});

/**
 * An attention of an appointment, with the patient in consultation and, when
 * asked, the discharge already given (`DISCHARGED`, condition stated).
 */
async function anAttention(discharged: boolean) {
  const { prisma } = clinic;
  const entry = await prisma.agendaEntry.create({
    data: {
      kind: 'APPOINTMENT',
      bookingChannel: 'WALK_IN',
      siteId: clinic.siteId,
      practitionerId: clinic.practitionerId,
      patientId: clinic.patientId,
      subjectStatus: 'RECEIVING_CARE',
      subjectStatusAt: new Date(),
      ...hourSlot(9),
    },
  });
  const encounter = await createEncounter(prisma, {
    siteId: clinic.siteId,
    practitionerId: clinic.practitionerId,
    patientId: clinic.patientId,
    agendaEntryId: entry.id,
  });
  if (discharged) {
    await prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        status: 'DISCHARGED',
        endedAt: new Date(encounter.startedAt.getTime() + 20 * MINUTE),
        dischargeCondition: 'ALIVE',
      },
    });
  }
  return { encounter, entry };
}

/** The account of that attention, with one consultation ready to invoice. */
async function anAccount(encounterId: string, charged: boolean) {
  const account = await clinic.prisma.patientAccount.create({
    data: {
      patientId: clinic.patientId,
      siteId: clinic.siteId,
      encounterId,
      payerId: clinic.payerId,
      priceListId: clinic.priceListId,
    },
  });
  if (charged) {
    await clinic.accounts.addCharge({
      accountId: account.id,
      billableServiceId: clinic.serviceId,
      encounterId,
      serviceDate: clinicalDateOf(new Date()),
      quantity: Quantity.ONE,
      createdById: clinic.cashierId,
      origin: 'MANUAL',
      encounterProcedureId: null,
      serviceOrderItemId: null,
      status: 'BILLABLE',
    });
    await clinic.accounts.issueInvoice({
      accountId: account.id,
      siteId: clinic.siteId,
      emissionPointId: clinic.emissionPointId,
      paymentMethod: '01',
      receiver: {
        buyerIdentificationType: '05',
        buyerIdentification: '1710034065',
        buyerName: 'Guamán Andrade, María José',
        buyerEmail: null,
        isFinalConsumer: false,
      },
      issuedById: clinic.cashierId,
    });
  }
  return account;
}

/** Settles the account as caja does: the app's clock, the cashier's stamp. */
function settle(accountId: string, closedAt: Date, noChargeReason?: string) {
  return clinic.prisma.patientAccount.update({
    where: { id: accountId },
    data: {
      status: 'SETTLED',
      closedAt,
      changedById: clinic.cashierId,
      changedAt: closedAt,
      noChargeReason,
    },
  });
}

const encounterOf = (id: string) =>
  clinic.prisma.encounter.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      closedAt: true,
      closedByUserId: true,
      closedById: true,
      dischargeCondition: true,
    },
  });

const subjectOf = async (entryId: string) =>
  clinic.prisma.agendaEntry.findUniqueOrThrow({
    where: { id: entryId },
    select: { subjectStatus: true, subjectStatusAt: true },
  });

describe('BI-236 cerrar la cuenta cierra la atención con el alta, en la misma transacción', () => {
  it('BI-236 EN-131 EN-139 la atención de alta pasa a COMPLETED con quien cerró la cuenta y su instante, y el paciente a DEPARTED', async () => {
    const { encounter, entry } = await anAttention(true);
    const account = await anAccount(encounter.id, true);
    const closedAt = new Date();

    await settle(account.id, closedAt);

    expect(await encounterOf(encounter.id)).toEqual({
      status: 'COMPLETED',
      closedAt,
      closedByUserId: clinic.cashierId,
      closedById: null,
      // EN-144: la que declaró el médico al firmar; el cierre no la toca.
      dischargeCondition: 'ALIVE',
    });
    expect(await subjectOf(entry.id)).toEqual({
      subjectStatus: 'DEPARTED',
      subjectStatusAt: closedAt,
    });

    // EN-133: el historial nombra a caja como autora del cierre.
    const last = await clinic.prisma.encounterStatusHistory.findFirstOrThrow({
      where: { encounterId: encounter.id },
      orderBy: { id: 'desc' },
    });
    expect(last).toMatchObject({
      fromStatus: 'DISCHARGED',
      toStatus: 'COMPLETED',
      fact: 'ACCOUNT_CLOSED',
      changedById: clinic.cashierId,
      changedAt: closedAt,
    });
  });

  it('BI-236 la cuenta de una atención sin alta se cierra sin tocar la atención ni al paciente', async () => {
    const { encounter, entry } = await anAttention(false);
    const account = await anAccount(encounter.id, true);
    const before = await subjectOf(entry.id);

    await settle(account.id, new Date());

    expect((await encounterOf(encounter.id)).status).toBe('OPEN');
    expect(await subjectOf(entry.id)).toEqual(before);
  });

  it('BI-236 EN-131 reabrir la cuenta y volver a cerrarla no mueve una atención ya cerrada', async () => {
    const { encounter } = await anAttention(true);
    const account = await anAccount(encounter.id, true);
    const firstClose = new Date();
    await settle(account.id, firstClose);

    const reopenedAt = new Date(firstClose.getTime() + MINUTE);
    await clinic.prisma.patientAccount.update({
      where: { id: account.id },
      data: {
        status: 'OPEN',
        closedAt: null,
        changedById: clinic.cashierId,
        changedAt: reopenedAt,
      },
    });
    await settle(account.id, new Date(reopenedAt.getTime() + MINUTE));

    expect(await encounterOf(encounter.id)).toMatchObject({
      status: 'COMPLETED',
      closedAt: firstClose,
    });
  });

  it('EN-131 la base rechaza una atención COMPLETED sin quién ni cuándo, y la admite con ellos', async () => {
    const { encounter } = await anAttention(true);

    await expect(
      clinic.prisma.encounter.update({
        where: { id: encounter.id },
        data: { status: 'COMPLETED' },
      }),
    ).rejects.toThrow(/encounter_completed_states_who_and_when/);

    // Control positivo.
    const closed = await clinic.prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        status: 'COMPLETED',
        closedAt: new Date(),
        closedByUserId: clinic.cashierId,
      },
    });
    expect(closed.status).toBe('COMPLETED');
  });
});

describe('BI-237 la cuenta sin nada facturado se cierra con el motivo por el que no se cobra', () => {
  it('BI-237 la base rechaza liquidar sin cargo facturado y sin motivo, y lo admite con motivo', async () => {
    const { encounter } = await anAttention(true);
    const account = await anAccount(encounter.id, false);

    await expect(settle(account.id, new Date())).rejects.toThrow(
      /patient_account_settled_states_why_unpaid/,
    );
    await expect(settle(account.id, new Date(), '   ')).rejects.toThrow(
      /patient_account_no_charge_reason_not_blank/,
    );
    // Nada se movió: ni la cuenta ni la atención.
    expect((await encounterOf(encounter.id)).status).toBe('DISCHARGED');

    // Control positivo: con el motivo, se liquida y cierra la atención.
    const settled = await settle(account.id, new Date(), 'Control sin costo');
    expect(settled).toMatchObject({
      status: 'SETTLED',
      noChargeReason: 'Control sin costo',
    });
    expect((await encounterOf(encounter.id)).status).toBe('COMPLETED');
  });

  it('BI-237 con un cargo facturado no hace falta motivo', async () => {
    const { encounter } = await anAttention(true);
    const account = await anAccount(encounter.id, true);

    const settled = await settle(account.id, new Date());

    expect(settled.noChargeReason).toBeNull();
  });

  it('BI-237 al reabrirse la cuenta el motivo se vacía, y el cierre siguiente pide el suyo', async () => {
    const { encounter } = await anAttention(true);
    const account = await anAccount(encounter.id, false);
    const closedAt = new Date();
    await settle(account.id, closedAt, 'Cortesía');

    const reopened = await clinic.prisma.patientAccount.update({
      where: { id: account.id },
      data: {
        status: 'OPEN',
        closedAt: null,
        changedById: clinic.cashierId,
        changedAt: new Date(closedAt.getTime() + MINUTE),
      },
    });

    expect(reopened.noChargeReason).toBeNull();
    await expect(
      settle(account.id, new Date(closedAt.getTime() + 2 * MINUTE)),
    ).rejects.toThrow(/patient_account_settled_states_why_unpaid/);
  });
});
