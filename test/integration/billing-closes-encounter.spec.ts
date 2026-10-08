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
async function anAttention(discharged: boolean, hour = 9) {
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
      ...hourSlot(hour),
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

  it('BI-236 EN-131 con una orden en borrador la atención sigue de alta al cerrar la cuenta, y se cierra al descartarla, con el instante y el autor de la cuenta', async () => {
    const { encounter, entry } = await anAttention(true);
    const draft = await clinic.prisma.serviceOrder.create({
      data: {
        encounterId: encounter.id,
        siteId: clinic.siteId,
        orderedById: clinic.practitionerId,
        category: 'LABORATORY',
      },
    });
    const account = await anAccount(encounter.id, true);
    const before = await subjectOf(entry.id);
    const closedAt = new Date();

    await settle(account.id, closedAt);

    // D-189: el médico todavía puede emitir el borrador (ORD-115).
    expect((await encounterOf(encounter.id)).status).toBe('DISCHARGED');
    expect(await subjectOf(entry.id)).toEqual(before);

    // Control positivo: el último borrador sale de DRAFT —aquí, descartado,
    // que no trae a nadie de vuelta a caja— y la atención se cierra sola.
    await clinic.prisma.serviceOrder.update({
      where: { id: draft.id },
      data: {
        status: 'DISCARDED',
        discardedAt: new Date(closedAt.getTime() + MINUTE),
        discardedById: clinic.cashierId,
      },
    });
    expect(await encounterOf(encounter.id)).toMatchObject({
      status: 'COMPLETED',
      closedAt,
      closedByUserId: clinic.cashierId,
    });
    expect((await subjectOf(entry.id)).subjectStatus).toBe('DEPARTED');
  });

  it('BI-236 una orden que sale de borrador con una cuenta abierta no cierra la atención: la cierra esa cuenta', async () => {
    const { encounter } = await anAttention(true);
    const draft = await clinic.prisma.serviceOrder.create({
      data: {
        encounterId: encounter.id,
        siteId: clinic.siteId,
        orderedById: clinic.practitionerId,
        category: 'LABORATORY',
      },
    });
    const account = await anAccount(encounter.id, true);

    await clinic.prisma.serviceOrder.update({
      where: { id: draft.id },
      data: { status: 'DISCARDED', discardedAt: new Date(), discardedById: clinic.cashierId }, // prettier-ignore
    });
    expect((await encounterOf(encounter.id)).status).toBe('DISCHARGED');

    // Control positivo: al cerrarse la cuenta, sí.
    await settle(account.id, new Date());
    expect((await encounterOf(encounter.id)).status).toBe('COMPLETED');
  });

  it('BI-236 D-189 una receta en borrador no detiene el cierre: con el alta ya no se emite', async () => {
    const { prisma } = clinic;
    const { encounter } = await anAttention(false);
    await prisma.prescription.create({
      data: {
        encounterId: encounter.id,
        siteId: clinic.siteId,
        prescriberId: clinic.practitionerId,
        status: 'DRAFT',
        warningSigns: 'Fiebre mayor de 39 °C',
      },
    });
    await prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        status: 'DISCHARGED',
        endedAt: new Date(encounter.startedAt.getTime() + 20 * MINUTE),
        dischargeCondition: 'ALIVE',
      },
    });
    const account = await anAccount(encounter.id, true);

    await settle(account.id, new Date());

    expect((await encounterOf(encounter.id)).status).toBe('COMPLETED');
  });

  it('EN-139 EN-140 al paciente que ya consta fuera no se le vuelve a sellar el instante', async () => {
    const { encounter, entry } = await anAttention(true);
    const leftAt = new Date(encounter.startedAt.getTime() + 30 * MINUTE);
    await clinic.prisma.agendaEntry.update({
      where: { id: entry.id },
      data: { subjectStatus: 'DEPARTED', subjectStatusAt: leftAt },
    });
    const account = await anAccount(encounter.id, true);

    await settle(account.id, new Date());

    // La atención sí se cierra (control positivo del mismo camino)…
    expect((await encounterOf(encounter.id)).status).toBe('COMPLETED');
    // …y el paciente conserva el instante en que salió.
    expect(await subjectOf(entry.id)).toEqual({
      subjectStatus: 'DEPARTED',
      subjectStatusAt: leftAt,
    });
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

/**
 * EN-241, D-186. The accounts caja settled BEFORE D-184 left their attention
 * discharged for ever: the trigger only acts on OPEN → SETTLED. The migration
 * closes them once, through `encounter_close_settled_backlog()`, with the
 * same function as caja's closing. The state is reproduced as it happened:
 * the account settled while the attention was still open, the discharge
 * after — so no trigger closed anything.
 */
describe('EN-241 las atenciones de alta con la cuenta liquidada antes de D-184', () => {
  async function discharge(encounterId: string, startedAt: Date) {
    await clinic.prisma.encounter.update({
      where: { id: encounterId },
      data: {
        status: 'DISCHARGED',
        endedAt: new Date(startedAt.getTime() + 20 * MINUTE),
        dischargeCondition: 'ALIVE',
      },
    });
  }

  /** Each attention at its own hour: one practitioner, no overlap. */
  let hour = 7;

  /** Settled with something invoiced, then discharged: closable. */
  async function settledThenDischarged() {
    const { encounter, entry } = await anAttention(false, hour++);
    const account = await anAccount(encounter.id, true);
    const closedAt = new Date(Date.now() - 5 * MINUTE);
    await settle(account.id, closedAt);
    await discharge(encounter.id, encounter.startedAt);
    return { encounter, entry, account, closedAt };
  }

  /** Settled in zero with no reason, as before BI-237 asked for one. */
  async function settledInZeroBeforeBi237() {
    const { encounter, entry } = await anAttention(false, hour++);
    const closedAt = new Date(Date.now() - 5 * MINUTE);
    // An INSERT already settled: BI-237's trigger watches the UPDATE of
    // status, which is how an account settled before it looks today.
    await clinic.prisma.patientAccount.create({
      data: {
        patientId: clinic.patientId,
        siteId: clinic.siteId,
        encounterId: encounter.id,
        payerId: clinic.payerId,
        priceListId: clinic.priceListId,
        status: 'SETTLED',
        closedAt,
        changedById: clinic.cashierId,
        changedAt: closedAt,
      },
    });
    await discharge(encounter.id, encounter.startedAt);
    return { encounter, entry };
  }

  const backlog = async () => {
    const [row] = await clinic.prisma.$queryRaw<{ closed: number }[]>`
      SELECT encounter_close_settled_backlog() AS closed`;
    return row!.closed;
  };

  it('EN-241 cierra la atención de alta con su cuenta facturada y liquidada, con quién y cuándo cerró caja, el paciente fuera y su fila en el historial', async () => {
    const { encounter, entry, closedAt } = await settledThenDischarged();
    expect((await encounterOf(encounter.id)).status).toBe('DISCHARGED');

    expect(await backlog()).toBe(1);

    expect(await encounterOf(encounter.id)).toMatchObject({
      status: 'COMPLETED',
      closedAt,
      closedByUserId: clinic.cashierId,
      closedById: null,
      dischargeCondition: 'ALIVE',
    });
    expect(await subjectOf(entry.id)).toEqual({
      subjectStatus: 'DEPARTED',
      subjectStatusAt: closedAt,
    });
    const [history] = await clinic.prisma.encounterStatusHistory.findMany({
      where: { encounterId: encounter.id, toStatus: 'COMPLETED' },
    });
    expect(history).toMatchObject({
      fact: 'ACCOUNT_CLOSED',
      changedById: clinic.cashierId,
      changedAt: closedAt,
    });

    // Once: called again it finds nothing to close.
    expect(await backlog()).toBe(0);
  });

  it('EN-241 no cierra la de cuenta en cero sin motivo, la que tiene otra cuenta abierta, la de orden en borrador ni la que sigue abierta; cierra la buena a su lado', async () => {
    const zero = await settledInZeroBeforeBi237();

    const stillOpenAccount = await settledThenDischarged();
    await anAccount(stillOpenAccount.encounter.id, false);

    const withDraft = await settledThenDischarged();
    await clinic.prisma.serviceOrder.create({
      data: {
        encounterId: withDraft.encounter.id,
        siteId: clinic.siteId,
        orderedById: clinic.practitionerId,
        category: 'LABORATORY',
      },
    });

    const { encounter: open } = await anAttention(false, hour++);
    const openAccount = await anAccount(open.id, true);
    await settle(openAccount.id, new Date());

    // Positive control: the good one, next to them, does close.
    const good = await settledThenDischarged();

    expect(await backlog()).toBe(1);

    expect((await encounterOf(good.encounter.id)).status).toBe('COMPLETED');
    for (const id of [
      zero.encounter.id,
      stillOpenAccount.encounter.id,
      withDraft.encounter.id,
    ]) {
      expect((await encounterOf(id)).status).toBe('DISCHARGED');
    }
    expect((await encounterOf(open.id)).status).toBe('OPEN');
    expect((await subjectOf(zero.entry.id)).subjectStatus).toBe(
      'RECEIVING_CARE',
    );
  });
});
