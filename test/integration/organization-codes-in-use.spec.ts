import { describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { Quantity } from '../../src/modules/billing/domain/money';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { PrismaOrganizationRepository } from '../../src/modules/organization/infrastructure/prisma-organization.repository';
import { PrismaSiteResourcesRepository } from '../../src/modules/organization/infrastructure/prisma-site-resources.repository';
import { EmissionPointDuplicateError } from '../../src/modules/organization/domain/organization.errors';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * OR-034, OR-035 — «¿ya se usó?» asked of the real tables. Each answer has its
 * positive control: the same question is `false` before the attention, the
 * invoice, and `true` right after.
 */
const db = useDatabase();

const asService = (prisma: unknown) => prisma as PrismaService;

describe('el código MSP de la sede queda fijo con la primera atención (OR-034)', () => {
  it('OR-034 una sede sin atenciones no está usada; con una, sí', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    const repository = new PrismaOrganizationRepository(asService(prisma));

    expect(await repository.siteHasEncounters(site.id)).toBe(false);

    await createEncounter(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    });

    expect(await repository.siteHasEncounters(site.id)).toBe(true);
  });

  it('OR-034 el código corregido se guarda en la sede', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const repository = new PrismaOrganizationRepository(asService(prisma));

    const updated = await repository.updateSite(site.id, {
      mspUnicode: 'MSP-CORREGIDO-1',
    });

    expect(updated?.mspUnicode).toBe('MSP-CORREGIDO-1');
  });
});

describe('el código del punto de emisión queda fijo con el primer comprobante (OR-035)', () => {
  async function aPointThatCanIssue() {
    const prisma = db();
    await seedBilling(prisma);
    const site = await createSite(prisma);
    const patient = await createPatient(prisma);
    const user = await createUser(prisma);
    const payer = await prisma.payer.findUniqueOrThrow({
      where: { code: 'PARTICULAR' },
    });
    const priceList = await prisma.priceList.findFirstOrThrow({
      where: { payerId: payer.id },
    });
    const service = await prisma.billableService.findUniqueOrThrow({
      where: { code: 'CONS-MG-PV' },
    });
    const point = await prisma.emissionPoint.create({
      data: { siteId: site.id, code: '001' },
    });
    const account = await prisma.patientAccount.create({
      data: {
        patientId: patient.id,
        siteId: site.id,
        payerId: payer.id,
        priceListId: priceList.id,
      },
    });
    const accounts = new PrismaBillingAccountRepository(asService(prisma));
    const issue = async () => {
      await accounts.addCharge({
        accountId: account.id,
        billableServiceId: service.id,
        encounterId: null,
        serviceDate: clinicalDateOf(new Date()),
        quantity: Quantity.ONE,
        createdById: user.id,
        origin: 'MANUAL',
        encounterProcedureId: null,
        serviceOrderItemId: null,
        status: 'BILLABLE',
      });
      return accounts.issueInvoice({
        accountId: account.id,
        siteId: site.id,
        emissionPointId: point.id,
        paymentMethod: '01',
        receiver: {
          buyerIdentificationType: '05',
          buyerIdentification: '1710034065',
          buyerName: 'Guamán Andrade, María José',
          buyerEmail: null,
          isFinalConsumer: false,
        },
        issuedById: user.id,
      });
    };
    return {
      prisma,
      point,
      site,
      issue,
      resources: new PrismaSiteResourcesRepository(asService(prisma)),
    };
  }

  it('OR-035 sin comprobantes no está usado; tras la primera factura, sí', async () => {
    const { point, issue, resources } = await aPointThatCanIssue();

    expect(await resources.emissionPointHasVouchers(point.id)).toBe(false);
    await issue();
    expect(await resources.emissionPointHasVouchers(point.id)).toBe(true);
  });

  it('OR-035 el código corregido se guarda, y uno que ya tiene otro punto de la sede se rechaza', async () => {
    const { prisma, point, site, resources } = await aPointThatCanIssue();
    await prisma.emissionPoint.create({
      data: { siteId: site.id, code: '002' },
    });

    // Control: a free code is written.
    const updated = await resources.updateEmissionPoint(point.id, {
      code: '009',
    });
    expect(updated?.code).toBe('009');

    await expect(
      resources.updateEmissionPoint(point.id, { code: '002' }),
    ).rejects.toBeInstanceOf(EmissionPointDuplicateError);
  });
});
