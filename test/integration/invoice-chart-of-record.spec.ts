import type { PrismaClient } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { seedSpecialties } from '../../prisma/seed-specialties.mts';
import '../../src/modules/billing/infrastructure/billing.constraints';
import { Quantity } from '../../src/modules/billing/domain/money';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { PrismaDocumentSourceReader } from '../../src/modules/documents/infrastructure/prisma-document-source.reader';
import { PatientMergeService } from '../../src/modules/patients/application/patient-merge.service';
import { PrismaPatientRepository } from '../../src/modules/patients/infrastructure/prisma-patient.repository';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite, createUser } from './setup/fixtures';

/**
 * BI-302 (D-169 §2 l): the invoice fixes, when it is issued, the chart whose
 * identity its RIDE prints — the one in force of its account's chart at that
 * instant — and nothing done to the charts afterwards moves it. The criterion
 * of CER-057 and ORD-161.
 *
 * THE MERGE IS THE REAL ONE (`PatientMergeService`): moving the identifiers to
 * the survivor is what made the RIDE come out without a cédula. Positive
 * control: before merging, the account's own chart.
 */
const db = useDatabase();

const CEDULA = '1710034065';

const client = (prisma: PrismaClient) => prisma as unknown as PrismaService;

interface Scene {
  prisma: PrismaClient;
  accounts: PrismaBillingAccountRepository;
  duplicateId: string;
  survivorId: string;
  survivorMrn: string;
  duplicateMrn: string;
  siteId: string;
  emissionPointId: string;
  payerId: string;
  priceListId: string;
  serviceId: string;
  userId: string;
  merge(): Promise<unknown>;
  undo(): Promise<unknown>;
}

let scene: Scene;

beforeEach(async () => {
  const prisma = db();
  await seedSpecialties(prisma);
  await seedBilling(prisma);
  const site = await createSite(prisma);
  // A duplicate registered in a hurry, without a document, and the real
  // chart of the same person with her cédula, phone and address.
  const duplicate = await prisma.patient.update({
    where: { id: (await createPatient(prisma)).id },
    data: { familyName: 'Pilco', givenName: 'Rosa' },
  });
  const survivor = await prisma.patient.update({
    where: { id: (await createPatient(prisma)).id },
    data: {
      familyName: 'Guamán',
      secondFamilyName: 'Pilco',
      givenName: 'María',
      secondGivenName: 'Rosa',
      phone: '0991234567',
      residenceAddressLine: 'Av. Quitumbe y Lira Ñan',
    },
  });
  await prisma.patientIdentifier.create({
    data: { patientId: survivor.id, type: 'CEDULA', value: CEDULA },
  });
  const payer = await prisma.payer.findUniqueOrThrow({
    where: { code: 'PARTICULAR' },
  });
  const user = await createUser(prisma);
  const desk = { userId: user.id };
  const merges = new PatientMergeService(
    new PrismaPatientRepository(client(prisma)),
    { record: () => Promise.resolve() },
    { setContext: vi.fn(), info: vi.fn() } as unknown as PinoLogger,
  );
  scene = {
    prisma,
    accounts: new PrismaBillingAccountRepository(client(prisma)),
    duplicateId: duplicate.id,
    survivorId: survivor.id,
    duplicateMrn: duplicate.mrn,
    survivorMrn: survivor.mrn,
    siteId: site.id,
    emissionPointId: (
      await prisma.emissionPoint.create({
        data: { siteId: site.id, code: '001' },
      })
    ).id,
    payerId: payer.id,
    priceListId: (
      await prisma.priceList.findFirstOrThrow({ where: { payerId: payer.id } })
    ).id,
    serviceId: (
      await prisma.service.findUniqueOrThrow({ where: { code: 'CONS-MG-PV' } })
    ).id,
    userId: user.id,
    merge: () =>
      merges.merge(
        { sourcePatientId: duplicate.id, targetPatientId: survivor.id },
        desk,
      ),
    undo: () => merges.undo({ sourcePatientId: duplicate.id }, desk),
  };
});

/** An account of the DUPLICATE chart, with one charge, invoiced to `buyer`. */
async function invoiceTheDuplicate(buyer: {
  identification: string;
  name: string;
}): Promise<string> {
  const account = await scene.prisma.patientAccount.create({
    data: {
      patientId: scene.duplicateId,
      siteId: scene.siteId,
      payerId: scene.payerId,
      priceListId: scene.priceListId,
    },
  });
  await scene.accounts.addCharge({
    accountId: account.id,
    serviceId: scene.serviceId,
    encounterId: null,
    serviceDate: clinicalDateOf(new Date()),
    quantity: Quantity.ONE,
    createdById: scene.userId,
    origin: 'MANUAL',
    encounterProcedureId: null,
    serviceOrderItemId: null,
    status: 'BILLABLE',
  });
  const invoice = await scene.accounts.issueInvoice({
    accountId: account.id,
    siteId: scene.siteId,
    emissionPointId: scene.emissionPointId,
    paymentMethod: '01',
    receiver: {
      buyerIdentificationType: '05',
      buyerIdentification: buyer.identification,
      buyerName: buyer.name,
      buyerEmail: null,
      isFinalConsumer: false,
    },
    issuedById: scene.userId,
    trail: { userId: scene.userId },
  });
  return invoice.id;
}

/** What the RIDE says about the patient, and its buyer's address. */
async function printed(invoiceId: string) {
  const subject = await new PrismaDocumentSourceReader(
    client(scene.prisma),
    'http://localhost/verificar',
  ).findSubject({ kind: 'INVOICE_RIDE', subjectId: invoiceId, sites: 'all' });
  if (subject?.kind !== 'INVOICE_RIDE') throw new Error('no RIDE');
  return {
    patient: subject.data.patient,
    buyerAddress: subject.data.buyerAddress,
  };
}

const chartOf = async (invoiceId: string) =>
  (
    await scene.prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: { chartOfRecordId: true },
    })
  ).chartOfRecordId;

describe('BI-302 la factura fija la ficha que nombra al emitirse', () => {
  it('BI-302 emitida antes de unificar nombra la duplicada; emitida después, la vigente con su cédula, teléfono y dirección; deshacer no cambia ninguna', async () => {
    const before = await invoiceTheDuplicate({
      identification: '0102030400',
      name: 'Pilco, Rosa',
    });
    // Positive control: unmerged, the account's own chart.
    expect(await chartOf(before)).toBe(scene.duplicateId);
    const ownChart = await printed(before);
    expect(ownChart.patient).toEqual({
      fullName: 'Pilco Rosa',
      mrn: scene.duplicateMrn,
      phone: null,
    });

    await scene.merge();

    // Issued from the absorbed chart's account: the survivor, whose cédula
    // the buyer gave, so her phone and address are the buyer's to print.
    const after = await invoiceTheDuplicate({
      identification: CEDULA,
      name: 'Guamán Pilco, María Rosa',
    });
    expect(await chartOf(after)).toBe(scene.survivorId);
    expect(await printed(after)).toEqual({
      patient: {
        fullName: 'Guamán Pilco María Rosa',
        mrn: scene.survivorMrn,
        phone: '0991234567',
      },
      buyerAddress: 'Av. Quitumbe y Lira Ñan',
    });
    // The one issued before still names the chart it was issued with.
    expect(await printed(before)).toEqual(ownChart);

    await scene.undo();
    expect(await chartOf(after)).toBe(scene.survivorId);
    expect((await printed(after)).patient?.fullName).toBe(
      'Guamán Pilco María Rosa',
    );
  });

  it('BI-302 la base escribe la ficha ella misma y no deja cambiarla después', async () => {
    const invoiceId = await invoiceTheDuplicate({
      identification: '0102030400',
      name: 'Pilco, Rosa',
    });

    // Positive control: the same UPDATE path takes a column that may move
    // while the invoice is ISSUED.
    await scene.prisma.$executeRaw`
      UPDATE "invoice" SET "updated_at" = CURRENT_TIMESTAMP
       WHERE "id" = ${invoiceId}::uuid`;
    await expect(
      scene.prisma.$executeRaw`
        UPDATE "invoice" SET "chart_of_record_id" = ${scene.survivorId}::uuid
         WHERE "id" = ${invoiceId}::uuid`,
    ).rejects.toThrow(/invoice_chart_of_record_frozen/);
    expect(await chartOf(invoiceId)).toBe(scene.duplicateId);
  });

  it('BI-302 aunque quien emite mande otra ficha, la base escribe la de la cuenta', async () => {
    const issued = await scene.prisma.invoice.findUniqueOrThrow({
      where: { id: await invoiceTheDuplicate({ identification: '0102030400', name: 'Pilco, Rosa' }) }, // prettier-ignore
    });
    // The same row again, but naming the survivor: overwritten on insert.
    const forged = await scene.prisma.invoice.create({
      data: {
        accountId: issued.accountId,
        siteId: issued.siteId,
        emissionPointId: issued.emissionPointId,
        sequential: '000000999',
        buyerIdentificationType: '05',
        buyerIdentification: '0102030400',
        buyerName: 'Pilco, Rosa',
        subtotalTaxed: 0,
        subtotalUntaxed: issued.total,
        taxTotal: 0,
        total: issued.total,
        status: 'ISSUED',
        issuedAt: issued.issuedAt,
        issuedById: issued.issuedById,
        chartOfRecordId: scene.survivorId,
      },
    });
    expect(forged.chartOfRecordId).toBe(scene.duplicateId);
  });
});
