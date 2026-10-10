import type { PrismaClient } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import '../../src/modules/billing/infrastructure/billing.constraints';
import { EncounterCheckoutService } from '../../src/modules/billing/application/encounter-checkout.service';
import { PatientAccountService } from '../../src/modules/billing/application/patient-account.service';
import { ProcedureChargeFollowService } from '../../src/modules/billing/application/procedure-charge-follow.service';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { PrismaBillingCatalogueRepository } from '../../src/modules/billing/infrastructure/prisma-billing-catalogue.repository';
import { PrismaClinicalActsRepository } from '../../src/modules/billing/infrastructure/prisma-clinical-acts.repository';
import { Quantity } from '../../src/modules/billing/domain/money';
import { PrismaClinicalCodingRepository } from '../../src/modules/encounter/infrastructure/prisma-clinical-coding.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * BI-240 to BI-243 against a real PostgreSQL: the clinical correction is
 * written by `encounter`'s own adapter and announced to `billing`'s follower,
 * exactly as `ClinicalCodingService` does after its transaction. What is
 * proved is what the account says afterwards, read from the database.
 */
const db = useDatabase();

const VISIT_STARTED_AT = new Date('2026-09-14T14:00:00Z'); // fecha-fija: la visita; el precio se resuelve en su fecha

interface Scene {
  prisma: PrismaClient;
  coding: PrismaClinicalCodingRepository;
  follow: ProcedureChargeFollowService;
  checkout: EncounterCheckoutService;
  statement: PatientAccountService;
  siteId: string;
  encounterId: string;
  payerId: string;
  sutureConceptId: string;
  cureConceptId: string;
  doctorId: string;
}

let scene: Scene;

beforeEach(async () => {
  const prisma = db();
  const site = await createSite(prisma);
  const patient = await createPatient(prisma);
  const practitioner = await createPractitioner(prisma);
  await seedBilling(prisma);

  const encounter = await prisma.encounter.create({
    data: {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      startedAt: VISIT_STARTED_AT,
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    },
  });

  const tariff = await prisma.catalogSystem.upsert({
    where: { code: 'TARIFF' },
    create: { code: 'TARIFF', name: 'Tarifario' },
    update: {},
  });
  const conceptOf = (code: string, display: string) =>
    prisma.catalogConcept.create({
      data: {
        systemId: tariff.id,
        code: `${code}-${Math.floor(Math.random() * 1e6)}`,
        display,
        validFrom: new Date('2020-01-01'), // fecha-fija: vigente desde siempre
      },
    });
  const suture = await conceptOf('SUT', 'Sutura simple');
  const cure = await conceptOf('CUR', 'Curación');
  await prisma.billableService.update({
    where: { code: 'PROC-SUTURA' },
    data: { procedureConceptId: suture.id, tariffCode: suture.code },
  });
  await prisma.billableService.update({
    where: { code: 'PROC-CURACION' },
    data: { procedureConceptId: cure.id, tariffCode: cure.code },
  });

  const doctor = await createUser(prisma);
  const payer = await prisma.payer.findUniqueOrThrow({
    where: { code: 'PARTICULAR' },
  });

  const asService = prisma as unknown as PrismaService;
  const accounts = new PrismaBillingAccountRepository(asService);
  const catalogue = new PrismaBillingCatalogueRepository(asService);
  const acts = new PrismaClinicalActsRepository(asService);
  const statement = new PatientAccountService(
    accounts,
    catalogue,
    { record: () => Promise.resolve() },
    acts,
  );
  const checkout = new EncounterCheckoutService(acts, accounts, catalogue, statement); // prettier-ignore
  const logger = { setContext: () => undefined, warn: () => undefined, info: () => undefined }; // prettier-ignore

  scene = {
    prisma,
    coding: new PrismaClinicalCodingRepository(asService),
    follow: new ProcedureChargeFollowService(
      accounts,
      catalogue,
      acts,
      checkout,
      logger as unknown as PinoLogger,
    ),
    checkout,
    statement,
    siteId: site.id,
    encounterId: encounter.id,
    payerId: payer.id,
    sutureConceptId: suture.id,
    cureConceptId: cure.id,
    doctorId: doctor.id,
  };
});

/** A suture done twice, and the visit passed to caja: its charge is proposed. */
async function aProposedSuture() {
  const procedure = await scene.coding.addProcedure({
    encounterId: scene.encounterId,
    recordedById: scene.doctorId,
    conceptId: scene.sutureConceptId,
    quantity: 2,
    performedAt: new Date(VISIT_STARTED_AT.getTime() + 30 * 60_000),
    sites: 'all',
  });
  const result = await scene.checkout.sendToCashier({
    siteId: scene.siteId,
    encounterId: scene.encounterId,
    payerId: scene.payerId,
    userId: scene.doctorId,
  });
  const charge = await scene.prisma.chargeItem.findFirstOrThrow({
    where: { encounterProcedureId: procedure.id },
  });
  return { procedure, charge, accountId: result.statement.account.id };
}

const changed = (
  procedureId: string,
  change: 'RECORDED' | 'EDITED' | 'RETRACTED' | 'RESTORED',
) =>
  scene.follow.procedureChanged({
    encounterId: scene.encounterId,
    siteId: scene.siteId,
    changedById: scene.doctorId,
    procedureId,
    change,
  });

describe('el cargo sigue al procedimiento corregido (BI-240 a BI-243)', () => {
  it('BI-240 corregir el procedimiento corrige su cargo propuesto —prestación, precio y cantidad— con su versión', async () => {
    const { procedure, charge } = await aProposedSuture();
    expect(charge).toMatchObject({ status: 'PLANNED' });

    await scene.coding.editProcedure({
      encounterId: scene.encounterId,
      procedureId: procedure.id,
      conceptId: scene.cureConceptId,
      quantity: 1,
      editedById: scene.doctorId,
      sites: 'all',
    });
    await changed(procedure.id, 'EDITED');

    const after = await scene.prisma.chargeItem.findUniqueOrThrow({
      where: { id: charge.id },
      include: { billableService: { select: { code: true } } },
    });
    expect(after.billableService.code).toBe('PROC-CURACION');
    expect(after.quantity.toString()).toBe('1');
    expect(after.status).toBe('PLANNED');
    expect(after.changedById).toBe(scene.doctorId);
    expect(await scene.prisma.recordVersion.count({ where: { resourceType: 'charge_item', resourceId: charge.id } })).toBe(1); // prettier-ignore
  });

  it('BI-241 quitar el procedimiento quita su cargo propuesto, y el siguiente paso a caja no lo vuelve a proponer', async () => {
    const { procedure, charge } = await aProposedSuture();

    await scene.coding.retractProcedure({
      encounterId: scene.encounterId,
      procedureId: procedure.id,
      reason: 'Registrado por error',
      retractedById: scene.doctorId,
      sites: 'all',
    });
    await changed(procedure.id, 'RETRACTED');

    const after = await scene.prisma.chargeItem.findUniqueOrThrow({ where: { id: charge.id } }); // prettier-ignore
    expect(after).toMatchObject({
      status: 'CANCELLED',
      voidedById: scene.doctorId,
      voidReason: 'Procedimiento quitado de la atención',
    });
    const again = await scene.checkout.sendToCashier({
      siteId: scene.siteId,
      encounterId: scene.encounterId,
      userId: scene.doctorId,
    });
    expect(again.raisedChargeIds).toEqual([]);
  });

  it('BI-242 restaurarlo con la cuenta abierta propone el cargo del restaurado, una sola vez', async () => {
    const { procedure, accountId } = await aProposedSuture();
    await scene.coding.retractProcedure({
      encounterId: scene.encounterId,
      procedureId: procedure.id,
      reason: 'Registrado por error',
      retractedById: scene.doctorId,
      sites: 'all',
    });
    await changed(procedure.id, 'RETRACTED');

    const restored = await scene.coding.restoreProcedure({
      encounterId: scene.encounterId,
      retractionId: procedure.id,
      restoredById: scene.doctorId,
      sites: 'all',
    });
    await changed(restored.id, 'RESTORED');
    await changed(restored.id, 'RESTORED');

    const lines = await scene.prisma.chargeItem.findMany({
      where: { accountId, origin: 'PROCEDURE' },
      orderBy: { createdAt: 'asc' },
    });
    expect(
      lines.map((line) => [line.encounterProcedureId, line.status]),
    ).toEqual([
      [procedure.id, 'CANCELLED'],
      [restored.id, 'PLANNED'],
    ]);
  });

  it('BI-242 EN-247 tras el alta, con la cuenta abierta, el procedimiento registrado propone su cargo una vez, y corregirlo lo sigue (D-194.1)', async () => {
    const { accountId } = await aProposedSuture();
    await scene.prisma.encounter.update({
      where: { id: scene.encounterId },
      data: { status: 'DISCHARGED', endedAt: new Date(VISIT_STARTED_AT.getTime() + 40 * 60_000), dischargeCondition: 'ALIVE' }, // prettier-ignore
    });

    const late = await scene.coding.addProcedure({
      encounterId: scene.encounterId,
      recordedById: scene.doctorId,
      conceptId: scene.cureConceptId,
      quantity: 1,
      performedAt: new Date(VISIT_STARTED_AT.getTime() + 35 * 60_000),
      sites: 'all',
      mayCorrectAfterDischarge: true,
    });
    await changed(late.id, 'RECORDED');
    await changed(late.id, 'RECORDED');

    const lines = () =>
      scene.prisma.chargeItem.findMany({
        where: { accountId, encounterProcedureId: late.id },
        select: { status: true, quantity: true },
      });
    expect((await lines()).map((line) => [line.status, line.quantity.toString()])).toEqual([['PLANNED', '1']]); // prettier-ignore

    await scene.coding.editProcedure({
      encounterId: scene.encounterId,
      procedureId: late.id,
      quantity: 3,
      editedById: scene.doctorId,
      sites: 'all',
      mayCorrectAfterDischarge: true,
    });
    await changed(late.id, 'EDITED');
    expect((await lines()).map((line) => [line.status, line.quantity.toString()])).toEqual([['PLANNED', '3']]); // prettier-ignore

    // Control: sin la autoridad tras el alta, el adaptador no escribe.
    await expect(
      scene.coding.editProcedure({
        encounterId: scene.encounterId,
        procedureId: late.id,
        quantity: 2,
        editedById: scene.doctorId,
        sites: 'all',
      }),
    ).rejects.toMatchObject({
      code: 'PROCEDURE_CORRECTION_REQUIRES_SIGNATURE',
    });
  });

  it('BI-243 el cargo confirmado no cambia y el extracto dice que ya no corresponde; el restaurado no se cobra dos veces', async () => {
    const { procedure, charge, accountId } = await aProposedSuture();
    await scene.prisma.chargeItem.update({
      where: { id: charge.id },
      data: { status: 'BILLABLE' },
    });

    await scene.coding.editProcedure({
      encounterId: scene.encounterId,
      procedureId: procedure.id,
      quantity: 1,
      editedById: scene.doctorId,
      sites: 'all',
    });
    await changed(procedure.id, 'EDITED');

    const read = () => scene.statement.statement({ accountId, siteId: scene.siteId }); // prettier-ignore
    expect((await scene.prisma.chargeItem.findUniqueOrThrow({ where: { id: charge.id } })).quantity.toString()).toBe('2'); // prettier-ignore
    expect((await read()).proceduresOutdated).toEqual([
      { chargeId: charge.id, billed: false, reason: 'CHANGED' },
    ]);

    await scene.coding.retractProcedure({
      encounterId: scene.encounterId,
      procedureId: procedure.id,
      reason: 'No se realizó',
      retractedById: scene.doctorId,
      sites: 'all',
    });
    await changed(procedure.id, 'RETRACTED');
    expect((await scene.prisma.chargeItem.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe('BILLABLE'); // prettier-ignore
    expect((await read()).proceduresOutdated).toEqual([
      { chargeId: charge.id, billed: false, reason: 'RETRACTED' },
    ]);

    // Restored: the confirmed line of its former row still charges it.
    const restored = await scene.coding.restoreProcedure({
      encounterId: scene.encounterId,
      retractionId: procedure.id,
      restoredById: scene.doctorId,
      sites: 'all',
    });
    await changed(restored.id, 'RESTORED');
    expect(await scene.prisma.chargeItem.count({ where: { accountId, origin: 'PROCEDURE' } })).toBe(1); // prettier-ignore
    expect((await read()).proceduresOutdated).toEqual([
      { chargeId: charge.id, billed: false, reason: 'CHANGED' },
    ]);
  });

  it('BI-243 una confirmación que llega entre la lectura y la escritura gana: bajo el bloqueo, el cargo confirmado no se anula ni se edita', async () => {
    const { charge } = await aProposedSuture();
    await scene.prisma.chargeItem.update({ where: { id: charge.id }, data: { status: 'BILLABLE' } }); // prettier-ignore
    const accounts = new PrismaBillingAccountRepository(scene.prisma as unknown as PrismaService); // prettier-ignore

    await accounts.voidCharge({ chargeId: charge.id, voidedById: scene.doctorId, reason: 'x', now: new Date(), onlyIfStatus: 'PLANNED' }); // prettier-ignore
    await accounts.editCharge({ chargeId: charge.id, changedById: scene.doctorId, now: new Date(), quantity: Quantity.parse('1'), onlyIfStatus: 'PLANNED' }); // prettier-ignore

    const after = await scene.prisma.chargeItem.findUniqueOrThrow({ where: { id: charge.id } }); // prettier-ignore
    expect(after.status).toBe('BILLABLE');
    expect(after.quantity.toString()).toBe('2');

    // Positive control: still proposed, it is followed.
    await scene.prisma.chargeItem.update({ where: { id: charge.id }, data: { status: 'PLANNED' } }); // prettier-ignore
    await accounts.voidCharge({ chargeId: charge.id, voidedById: scene.doctorId, reason: 'x', now: new Date(), onlyIfStatus: 'PLANNED' }); // prettier-ignore
    expect((await scene.prisma.chargeItem.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe('CANCELLED'); // prettier-ignore
  });

  it('BI-240 BI-243 corregido a un concepto sin prestación, el cargo propuesto se queda y la cuenta lo señala', async () => {
    const { procedure, charge, accountId } = await aProposedSuture();
    const tariff = await scene.prisma.catalogSystem.findUniqueOrThrow({ where: { code: 'TARIFF' } }); // prettier-ignore
    const unpriced = await scene.prisma.catalogConcept.create({
      data: {
        systemId: tariff.id,
        code: `NP-${Math.floor(Math.random() * 1e6)}`,
        display: 'Sin prestación',
        validFrom: new Date('2020-01-01'), // fecha-fija: vigente desde siempre
      },
    });

    await scene.coding.editProcedure({
      encounterId: scene.encounterId,
      procedureId: procedure.id,
      conceptId: unpriced.id,
      editedById: scene.doctorId,
      sites: 'all',
    });
    await changed(procedure.id, 'EDITED');

    expect((await scene.prisma.chargeItem.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe('PLANNED'); // prettier-ignore
    const statement = await scene.statement.statement({ accountId, siteId: scene.siteId }); // prettier-ignore
    expect(statement.proceduresOutdated).toEqual([
      { chargeId: charge.id, billed: false, reason: 'CHANGED' },
    ]);
  });
});
