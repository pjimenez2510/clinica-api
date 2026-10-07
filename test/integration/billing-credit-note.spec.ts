import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { seedBilling } from '../../prisma/seed-billing.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { addMonths, clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';
import { authoriseVoucher } from './setup/sri-fixtures';

/**
 * billing/B14 by HTTP: «Corregir» an authorised invoice with a credit note,
 * as caja does it — the permission of its own, the site scope, every refusal
 * with the code the specification names, and the account left ready to bill
 * again. Nothing reaches the SRI: the invoice is authorised by raw SQL, as
 * its answer would leave it, and no web service is configured.
 */
const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  status: number;
  code: string;
  errors?: { field: string; code: string }[];
}

interface CreditNoteBody {
  id: string;
  invoiceId: string;
  sequential: string;
  reasonCode: string;
  reason: string;
  buyerIdentification: string;
  buyerName: string;
  totals: { total: string };
  status: string;
  lines: { chargeItemId: string; netAmount: string }[];
}

interface IssuedBody {
  creditNote: CreditNoteBody;
  rebilledAccountId: string | null;
}

describe('BI-208 a BI-218 corregir una factura por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let cashierToken: string;
  let writerToken: string;
  let siteId: string;
  let otherSiteId: string;
  let patientId: string;
  let payerId: string;
  let serviceId: string;
  let emissionPointId: string;
  let otherEmissionPointId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .overrideProvider(ThrottlerStorage)
        .useValue({
          increment: () =>
            Promise.resolve({
              totalHits: 1,
              timeToExpire: 1,
              isBlocked: false,
              timeToBlockExpire: 0,
            }),
        })
        .compile();
      app = moduleRef.createNestApplication<NestExpressApplication>({
        bodyParser: false,
      });
      configureApp(app);
      await listenForTests(app);
      registry = app.get(RolePermissionRegistry);
    }

    await seedBilling(prisma);
    await syncAuthorisation(prisma);
    registry.invalidate();

    siteId = (await createSite(prisma)).id;
    otherSiteId = (await createSite(prisma, 'Sede Sur')).id;
    patientId = (await createPatient(prisma)).id;
    payerId = (
      await prisma.payer.findUniqueOrThrow({ where: { code: 'PARTICULAR' } })
    ).id;
    serviceId = (
      await prisma.billableService.findUniqueOrThrow({
        where: { code: 'CONS-MG-PV' },
      })
    ).id;
    emissionPointId = (
      await prisma.emissionPoint.create({
        data: { siteId, code: '001', description: 'Caja principal' },
      })
    ).id;
    otherEmissionPointId = (
      await prisma.emissionPoint.create({
        data: { siteId: otherSiteId, code: '001', description: 'Caja Sur' },
      })
    ).id;

    // «Caja» lleva `billing:credit-note` de fábrica, en UNA sede.
    cashierToken = await signIn('caja@clinica.ec', 'CAJA', siteId, '1710034065'); // prettier-ignore
    // Un rol que factura y NO corrige: el permiso es propio (BI-091).
    await prisma.role.create({
      data: {
        code: 'FACTURA',
        name: 'Factura',
        description: 'Emite facturas. No las corrige.',
        permissions: {
          create: [
            { permissionCode: 'billing:read' },
            { permissionCode: 'billing:write' },
          ],
        },
      },
    });
    registry.invalidate();
    writerToken = await signIn('factura@clinica.ec', 'FACTURA', siteId, '0919176818'); // prettier-ignore
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(
    email: string,
    roleCode: string,
    grantedSiteId: string | null,
    cedula: string,
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Rosa',
        lastName: 'Cedeño',
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId: grantedSiteId },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  const api = () => request(app.getHttpServer());
  const today = () => clinicalDateOf(new Date());

  /**
   * An invoice of `lines` consultations, issued by HTTP to a cedula and, on
   * request, authorised and its account closed — the state caja finds it in.
   */
  async function anInvoice(
    options: {
      lines?: number;
      authorised?: boolean;
      finalConsumer?: boolean;
      settled?: boolean;
      site?: 'own' | 'other';
    } = {},
  ) {
    const own = (options.site ?? 'own') === 'own';
    const site = own ? siteId : otherSiteId;
    const account = await prisma.patientAccount.create({
      data: {
        patientId,
        siteId: site,
        payerId,
        priceListId: (
          await prisma.priceList.findFirstOrThrow({ where: { payerId } })
        ).id,
      },
    });
    for (let line = 0; line < (options.lines ?? 2); line += 1) {
      await prisma.chargeItem.create({
        data: {
          accountId: account.id,
          billableServiceId: serviceId,
          serviceDate: new Date(`${today()}T00:00:00Z`),
          unitAmount: 30,
          serviceDisplay: 'Consulta de medicina general',
          taxSriCode: '0',
          taxPercentage: 0,
          status: 'BILLABLE',
          createdById: (await prisma.user.findFirstOrThrow()).id,
        },
      });
    }
    const issued = await prisma.invoice.findMany({ where: { siteId: site } });
    const charges = await prisma.chargeItem.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: 'asc' },
    });
    const total = 30 * charges.length;
    const invoice = await prisma.invoice.create({
      data: {
        accountId: account.id,
        siteId: site,
        emissionPointId: own ? emissionPointId : otherEmissionPointId,
        sequential: String(issued.length + 1).padStart(9, '0'),
        ...(options.finalConsumer
          ? {
              buyerIdentificationType: '07',
              buyerIdentification: '9999999999999',
              buyerName: 'CONSUMIDOR FINAL',
              isFinalConsumer: true,
            }
          : {
              buyerIdentificationType: '05',
              buyerIdentification: '1710034065',
              buyerName: 'Guamán Andrade, María José',
              buyerEmail: 'maria@example.com',
            }),
        paymentMethod: '01',
        subtotalTaxed: 0,
        subtotalUntaxed: total,
        taxTotal: 0,
        total,
        status: 'ISSUED',
        issuedAt: new Date(),
        issuedById: charges[0]!.createdById,
      },
    });
    await prisma.chargeItem.updateMany({
      where: { accountId: account.id },
      data: { status: 'BILLED', invoiceId: invoice.id },
    });
    if (options.authorised !== false) {
      await authoriseVoucher(prisma, invoice.id);
    }
    if (options.settled) {
      await api()
        .post(`/api/v1/billing/sites/${site}/accounts/${account.id}/close`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);
    }
    return {
      invoiceId: invoice.id,
      accountId: account.id,
      chargeIds: charges.map((charge) => charge.id),
    };
  }

  const correct = (
    invoiceId: string,
    body: object,
    token = cashierToken,
    site = siteId,
  ) =>
    api()
      .post(`/api/v1/billing/sites/${site}/invoices/${invoiceId}/credit-notes`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('BI-208 BI-210 BI-214 BI-215 corregir el receptor acredita toda la factura, a nombre del mismo receptor, y deja la cuenta reabierta con las líneas por facturar', async () => {
    const { invoiceId, accountId, chargeIds } = await anInvoice({
      settled: true,
    });

    const response = await correct(invoiceId, { reasonCode: 'RECEIVER_DATA' });
    expect(response.status).toBe(201);
    const { creditNote, rebilledAccountId } = response.body as IssuedBody;

    expect(creditNote).toMatchObject({
      invoiceId,
      sequential: '000000001',
      reasonCode: 'RECEIVER_DATA',
      reason: 'Error en los datos del receptor',
      // D-152.2: the invoice's receiver, even when it was the error.
      buyerIdentification: '1710034065',
      buyerName: 'Guamán Andrade, María José',
      status: 'ISSUED',
      totals: { total: '60.00' },
    });
    expect(creditNote.lines.map((line) => line.chargeItemId)).toEqual(
      chargeIds,
    );

    // BI-214: back in the same account, reopened, one copy per line.
    expect(rebilledAccountId).toBe(accountId);
    const account = await prisma.patientAccount.findUniqueOrThrow({
      where: { id: accountId },
    });
    expect(account.status).toBe('OPEN');
    const copies = await prisma.chargeItem.findMany({
      where: { accountId, origin: 'CORRECTION' },
    });
    expect(copies.map((copy) => copy.correctsChargeItemId).sort()).toEqual(
      [...chargeIds].sort(),
    );
    expect(copies.every((copy) => copy.status === 'BILLABLE')).toBe(true);
    expect(copies.map((copy) => copy.unitAmount.toFixed(2))).toEqual([
      '30.00',
      '30.00',
    ]);
    // BI-096: the originals stay billed.
    expect(
      await prisma.chargeItem.count({
        where: { id: { in: chargeIds }, status: 'BILLED' },
      }),
    ).toBe(2);
    // BI-215: the settled account is in record_version, with who reopened it.
    const versions = await prisma.recordVersion.findMany({
      where: { resourceType: 'patient_account', resourceId: accountId },
      orderBy: { version: 'asc' },
    });
    expect(versions.at(-1)!.data).toMatchObject({ status: 'SETTLED' });

    // BI-132: the trail of who corrected.
    expect(
      await prisma.accessAudit.count({
        where: { resourceType: 'credit_note', resourceId: creditNote.id },
      }),
    ).toBe(1);

    // Control: what came back is billed again, to the right receiver.
    const reissued = await api()
      .post(`/api/v1/billing/sites/${siteId}/invoices`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({
        accountId,
        emissionPointId,
        paymentMethod: '01',
        receiver: {
          identificationType: '05',
          identification: '0919176818',
          name: 'Andrade Guamán, José María',
        },
      });
    expect(reissued.status).toBe(201);
    expect((reissued.body as { totals: { total: string } }).totals.total).toBe(
      '60.00',
    );
  });

  it('BI-209 «Otro» sin texto se rechaza en reasonText; con texto, el texto es el motivo', async () => {
    const { invoiceId } = await anInvoice();

    const missing = await correct(invoiceId, { reasonCode: 'OTHER' });
    expect(missing.status).toBe(422);
    expect((missing.body as Problem).code).toBe('CREDIT_NOTE_REASON_REQUIRED');
    expect((missing.body as Problem).errors?.[0]?.field).toBe('reasonText');
    expect(await prisma.creditNote.count()).toBe(0);

    const written = await correct(invoiceId, {
      reasonCode: 'OTHER',
      reasonText: '  Cobro duplicado de la consulta ',
    });
    expect(written.status).toBe(201);
    expect((written.body as IssuedBody).creditNote.reason).toBe(
      'Cobro duplicado de la consulta',
    );
  });

  it('BI-214 «Servicio no prestado» no devuelve nada a la cuenta', async () => {
    const { invoiceId, accountId } = await anInvoice({ settled: true });

    const response = await correct(invoiceId, {
      reasonCode: 'SERVICE_NOT_PROVIDED',
    });
    expect(response.status).toBe(201);
    expect((response.body as IssuedBody).rebilledAccountId).toBeNull();
    expect(
      await prisma.chargeItem.count({
        where: { accountId, origin: 'CORRECTION' },
      }),
    ).toBe(0);
    expect(
      (
        await prisma.patientAccount.findUniqueOrThrow({
          where: { id: accountId },
        })
      ).status,
    ).toBe('SETTLED');
  });

  it('BI-211 BI-095 una línea se acredita una vez; la de otra factura no; y lo que queda, sí', async () => {
    const first = await anInvoice();
    const other = await anInvoice();

    const one = await correct(first.invoiceId, {
      reasonCode: 'AMOUNT',
      chargeIds: [first.chargeIds[0]],
    });
    expect(one.status).toBe(201);
    expect((one.body as IssuedBody).creditNote.totals.total).toBe('30.00');

    const again = await correct(first.invoiceId, {
      reasonCode: 'AMOUNT',
      chargeIds: [first.chargeIds[0]],
    });
    expect(again.status).toBe(409);
    expect((again.body as Problem).code).toBe(
      'CREDIT_NOTE_LINE_ALREADY_CREDITED',
    );

    const foreign = await correct(first.invoiceId, {
      reasonCode: 'AMOUNT',
      chargeIds: [other.chargeIds[0]],
    });
    expect(foreign.status).toBe(422);
    expect((foreign.body as Problem).code).toBe(
      'CREDIT_NOTE_LINE_NOT_IN_INVOICE',
    );

    // Control: sin elegir, la que falta; y la numeración sigue.
    const rest = await correct(first.invoiceId, { reasonCode: 'AMOUNT' });
    expect(rest.status).toBe(201);
    expect((rest.body as IssuedBody).creditNote).toMatchObject({
      sequential: '000000002',
      totals: { total: '30.00' },
    });
    const nothingLeft = await correct(first.invoiceId, {
      reasonCode: 'AMOUNT',
    });
    expect((nothingLeft.body as Problem).code).toBe(
      'CREDIT_NOTE_LINE_ALREADY_CREDITED',
    );
  });

  it('BI-208 BI-213 BI-097 la factura sin autorizar, a Consumidor Final o anulada no se corrige con nota de crédito', async () => {
    const pending = await anInvoice({ authorised: false });
    const toPending = await correct(pending.invoiceId, {
      reasonCode: 'AMOUNT',
    });
    expect(toPending.status).toBe(409);
    expect((toPending.body as Problem).code).toBe(
      'CREDIT_NOTE_INVOICE_NOT_AUTHORISED',
    );

    const finalConsumer = await anInvoice({ finalConsumer: true });
    const toFinal = await correct(finalConsumer.invoiceId, {
      reasonCode: 'AMOUNT',
    });
    expect(toFinal.status).toBe(409);
    expect((toFinal.body as Problem).code).toBe('CREDIT_NOTE_FINAL_CONSUMER');

    const voided = await anInvoice();
    await prisma.$executeRaw`UPDATE "invoice" SET "status" = 'VOIDED' WHERE "id" = ${voided.invoiceId}::uuid`;
    const toVoided = await correct(voided.invoiceId, { reasonCode: 'AMOUNT' });
    expect(toVoided.status).toBe(409);
    expect((toVoided.body as Problem).code).toBe('CREDIT_NOTE_INVOICE_VOIDED');

    expect(await prisma.creditNote.count()).toBe(0);
  });

  it('BI-094 pasados doce meses desde la emisión ya no admite nota de crédito; el último día, sí', async () => {
    const issuedOn = (months: number, days: number) => {
      const date = addMonths(today(), -months);
      const instant = new Date(`${date}T17:00:00Z`);
      instant.setUTCDate(instant.getUTCDate() - days);
      return instant;
    };
    const old = await anInvoice({ authorised: false });
    const edge = await anInvoice({ authorised: false });
    // Before authorising: the issuance date is frozen from AUTHORISED on.
    await prisma.$executeRaw`UPDATE "invoice" SET "issued_at" = ${issuedOn(12, 1)} WHERE "id" = ${old.invoiceId}::uuid`;
    await prisma.$executeRaw`UPDATE "invoice" SET "issued_at" = ${issuedOn(12, 0)} WHERE "id" = ${edge.invoiceId}::uuid`;
    await authoriseVoucher(prisma, old.invoiceId);
    await authoriseVoucher(prisma, edge.invoiceId);

    const late = await correct(old.invoiceId, { reasonCode: 'AMOUNT' });
    expect(late.status).toBe(409);
    expect((late.body as Problem).code).toBe('CREDIT_NOTE_WINDOW_EXPIRED');

    const inTime = await correct(edge.invoiceId, { reasonCode: 'AMOUNT' });
    expect(inTime.status).toBe(201);
  });

  it('BI-091 sin billing:credit-note se rechaza con 403; otra sede, 403; la factura de otra sede por la propia, 404', async () => {
    const { invoiceId } = await anInvoice();
    const foreign = await anInvoice({ site: 'other' });

    expect(
      (await correct(invoiceId, { reasonCode: 'AMOUNT' }, writerToken)).status,
    ).toBe(403);
    expect(
      (
        await correct(
          foreign.invoiceId,
          { reasonCode: 'AMOUNT' },
          cashierToken,
          otherSiteId,
        )
      ).status,
    ).toBe(403);
    const crossed = await correct(foreign.invoiceId, { reasonCode: 'AMOUNT' });
    expect(crossed.status).toBe(404);
    expect((crossed.body as Problem).code).toBe('INVOICE_NOT_FOUND');

    // Control positivo: la misma petición, con el permiso y en su sede.
    expect((await correct(invoiceId, { reasonCode: 'AMOUNT' })).status).toBe(
      201,
    );
  });

  it('BI-211 dos cajeras corrigen la misma factura a la vez: una gana, la otra recibe el conflicto', async () => {
    const { invoiceId } = await anInvoice();

    const [a, b] = await Promise.all([
      correct(invoiceId, { reasonCode: 'AMOUNT' }),
      correct(invoiceId, { reasonCode: 'AMOUNT' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await prisma.creditNote.count()).toBe(1);
    expect(await prisma.creditNoteLine.count()).toBe(2);
  });

  it('BI-218 la lista de notas de crédito de la sede dice su factura, su motivo y su importe', async () => {
    const { invoiceId } = await anInvoice();
    await correct(invoiceId, { reasonCode: 'RECEIVER_DATA' }).expect(201);

    const list = await api()
      .get(`/api/v1/billing/sites/${siteId}/credit-notes`)
      .set('Authorization', `Bearer ${writerToken}`)
      .expect(200);
    const [item] = (list.body as { items: (CreditNoteBody & { invoiceSequential: string })[] }).items; // prettier-ignore
    expect(item).toMatchObject({
      invoiceId,
      invoiceSequential: '000000001',
      reason: 'Error en los datos del receptor',
      totals: { total: '60.00' },
    });

    // Control: otra sede no ve las de esta.
    const elsewhere = await api()
      .get(`/api/v1/billing/sites/${otherSiteId}/credit-notes`)
      .set('Authorization', `Bearer ${cashierToken}`);
    expect(elsewhere.status).toBe(403);
  });
});
