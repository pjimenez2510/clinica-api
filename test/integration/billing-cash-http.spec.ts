import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { Quantity } from '../../src/modules/billing/domain/money';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { addDays, clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * B6 — cobros, saldo y cierre diario (BI-101 a BI-105, BI-247 a BI-253), por
 * HTTP contra PostgreSQL 18 de verdad y con SESIONES DE VERDAD de caja: el
 * saldo, la caja cerrada y la foto del cierre los decide la base, y lo que
 * se comprueba aquí es que la ruta llega a ellos y dice lo que significan.
 */
const PASSWORD = 'el caballo come alfalfa';

interface InvoiceBody {
  id: string;
  balance: string;
  paidTotal: string;
  creditedTotal: string;
  totals: { total: string };
}
interface PaymentBody {
  id: string;
  amount: string;
  cashDate: string;
  reference: string | null;
  reversal: { reason: string } | null;
}

describe('B6 cobros, saldo del paciente y cierre diario', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let patientId: string;
  let payerId: string;
  let priceListId: string;
  let serviceId: string;
  let emissionPointId: string;
  let cashId: string;
  let transferId: string;
  let caja: { token: string; userId: string };
  let otraCaja: { token: string; userId: string };

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

    await syncAuthorisation(prisma);
    await seedBilling(prisma);
    // The roles were written again: their ids changed under the cache.
    registry.invalidate();

    caja = await signIn('caja@clinica.ec', 'Rosa');
    otraCaja = await signIn('caja2@clinica.ec', 'Ana');

    const site = await createSite(prisma);
    siteId = site.id;
    patientId = (await createPatient(prisma)).id;
    const payer = await prisma.payer.findUniqueOrThrow({ where: { code: 'PARTICULAR' } }); // prettier-ignore
    payerId = payer.id;
    priceListId = (await prisma.priceList.findFirstOrThrow({ where: { payerId } })).id; // prettier-ignore
    serviceId = (await prisma.billableService.findUniqueOrThrow({ where: { code: 'CONS-MG-PV' } })).id; // prettier-ignore
    emissionPointId = (
      await prisma.emissionPoint.create({
        data: { siteId, code: '001', description: 'Caja principal' },
      })
    ).id;
    cashId = (
      await prisma.paymentMethod.create({
        data: { name: 'Efectivo del cajón', sriCode: '01', displayOrder: 1 },
      })
    ).id;
    transferId = (
      await prisma.paymentMethod.create({
        data: { name: 'Transferencia Pichincha', sriCode: '20', displayOrder: 2 }, // prettier-ignore
      })
    ).id;
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(
    email: string,
    firstName: string,
  ): Promise<{ token: string; userId: string }> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName,
        lastName: 'Cedeño',
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'CAJA' } }); // prettier-ignore
    await prisma.userRoleGrant.create({ data: { userId: user.id, roleId: role.id } }); // prettier-ignore
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      token: (response.body as { accessToken: string }).accessToken,
      userId: user.id,
    };
  }

  /** An account with one confirmed consultation, at the seed's price. */
  async function anAccount(): Promise<string> {
    const account = await prisma.patientAccount.create({
      data: { patientId, siteId, payerId, priceListId },
    });
    await new PrismaBillingAccountRepository(
      prisma as unknown as PrismaService,
    ).addCharge({
      accountId: account.id,
      billableServiceId: serviceId,
      encounterId: null,
      serviceDate: clinicalDateOf(new Date()),
      quantity: Quantity.ONE,
      createdById: caja.userId,
      origin: 'MANUAL',
      encounterProcedureId: null,
      serviceOrderItemId: null,
      status: 'BILLABLE',
    });
    return account.id;
  }

  const api = (token = caja.token) => ({
    post: (path: string, body: object) =>
      request(app.getHttpServer())
        .post(`/api/v1/billing/sites/${siteId}${path}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    get: (path: string) =>
      request(app.getHttpServer())
        .get(`/api/v1/billing/sites/${siteId}${path}`)
        .set('Authorization', `Bearer ${token}`),
  });

  async function issue(
    accountId: string,
    payment?: { paymentMethodId: string },
    paymentMethod = '01',
  ) {
    return api().post('/invoices', {
      accountId,
      emissionPointId,
      paymentMethod,
      receiver: {
        identificationType: '05',
        identification: '1710034065',
        name: 'Guamán Andrade, María José',
      },
      ...(payment ? { payment } : {}),
    });
  }

  it('BI-247 emitir «Cobrado ahora» deja la factura sin saldo, con el cobro en el mismo acto', async () => {
    const response = await issue(await anAccount(), {
      paymentMethodId: cashId,
    });
    expect(response.status).toBe(201);
    const invoice = response.body as InvoiceBody;
    expect(invoice.balance).toBe('0.00');
    expect(invoice.paidTotal).toBe(invoice.totals.total);
    const payments = await prisma.payment.findMany({ where: { invoiceId: invoice.id } }); // prettier-ignore
    expect(payments).toHaveLength(1);
    expect(payments[0]!.receivedById).toBe(caja.userId);
  });

  it('BI-247 sin cobrar, la factura nace con todo su saldo; un medio de otra forma de pago no emite nada', async () => {
    const owed = (await issue(await anAccount())).body as InvoiceBody;
    expect(owed.balance).toBe(owed.totals.total);
    expect(owed.paidTotal).toBe('0.00');

    const accountId = await anAccount();
    const mismatch = await issue(accountId, { paymentMethodId: transferId });
    expect(mismatch.status).toBe(422);
    expect((mismatch.body as { code: string }).code).toBe(
      'PAYMENT_METHOD_MISMATCH',
    );
    expect(await prisma.invoice.count({ where: { accountId } })).toBe(0);
  });

  it('BI-248 BI-249 cobrar en dos abonos con referencia; el saldo del paciente lo dice la cuenta', async () => {
    const accountId = await anAccount();
    const invoice = (await issue(accountId)).body as InvoiceBody;
    const total = Number(invoice.totals.total);
    const half = (total / 2).toFixed(2);

    const statement = await api().get(`/accounts/${accountId}`).expect(200);
    expect((statement.body as { patientBalance: string }).patientBalance).toBe(
      invoice.totals.total,
    );

    const first = await api()
      .post(`/invoices/${invoice.id}/payments`, {
        paymentMethodId: transferId,
        amount: half,
        reference: 'TRF-889',
      })
      .expect(201);
    expect((first.body as PaymentBody).reference).toBe('TRF-889');
    expect((first.body as PaymentBody).cashDate).toBe(
      clinicalDateOf(new Date()),
    );

    // The rest, without an amount: the balance.
    const rest = await api()
      .post(`/invoices/${invoice.id}/payments`, { paymentMethodId: cashId })
      .expect(201);
    expect(Number((rest.body as PaymentBody).amount)).toBeCloseTo(total - Number(half), 2); // prettier-ignore

    const after = await api().get(`/accounts/${accountId}`).expect(200);
    expect((after.body as { patientBalance: string }).patientBalance).toBe(
      '0.00',
    );
  });

  it('BI-101 un cobro mayor que el saldo se rechaza con su código; el saldo exacto entra (control)', async () => {
    const invoice = (await issue(await anAccount())).body as InvoiceBody;
    const over = (Number(invoice.totals.total) + 0.01).toFixed(2);
    const refused = await api()
      .post(`/invoices/${invoice.id}/payments`, {
        paymentMethodId: cashId,
        amount: over,
      }) // prettier-ignore
      .expect(422);
    expect((refused.body as { code: string }).code).toBe(
      'PAYMENT_EXCEEDS_BALANCE',
    );
    await api()
      .post(`/invoices/${invoice.id}/payments`, {
        paymentMethodId: cashId,
        amount: invoice.totals.total,
      })
      .expect(201);
  });

  it('BI-102 BI-251 revertir un cobro propio con motivo; el de otra caja responde como inexistente', async () => {
    const invoice = (await issue(await anAccount(), { paymentMethodId: cashId })).body as InvoiceBody; // prettier-ignore
    const [payment] = await prisma.payment.findMany({ where: { invoiceId: invoice.id } }); // prettier-ignore

    const foreign = await api(otraCaja.token)
      .post(`/payments/${payment!.id}/reversal`, { reason: 'No es mío' })
      .expect(404);
    expect((foreign.body as { code: string }).code).toBe('PAYMENT_NOT_FOUND');

    await api().post(`/payments/${payment!.id}/reversal`, { reason: 'x'.repeat(201) }).expect(422); // prettier-ignore

    const reversed = await api()
      .post(`/payments/${payment!.id}/reversal`, {
        reason: 'Se cobró dos veces',
      })
      .expect(200);
    expect((reversed.body as PaymentBody).reversal?.reason).toBe(
      'Se cobró dos veces',
    );

    const again = await api()
      .post(`/payments/${payment!.id}/reversal`, { reason: 'Otra vez' })
      .expect(409);
    expect((again.body as { code: string }).code).toBe(
      'PAYMENT_ALREADY_REVERSED',
    );

    const reread = await api().get(`/invoices/${invoice.id}`).expect(200);
    expect((reread.body as InvoiceBody).balance).toBe(invoice.totals.total);
  });

  it('BI-251 BI-105 BI-252 BI-104 caja del día, cierre con un dólar de menos, y después nada más de ese día', async () => {
    const paid = (await issue(await anAccount(), { paymentMethodId: cashId })).body as InvoiceBody; // prettier-ignore
    const owed = (await issue(await anAccount())).body as InvoiceBody;
    await api()
      .post(`/invoices/${owed.id}/payments`, {
        paymentMethodId: transferId,
        amount: '5.00',
      }) // prettier-ignore
      .expect(201);
    const today = clinicalDateOf(new Date());

    const day = await api().get('/cash-sessions/day').expect(200);
    const body = day.body as {
      date: string;
      lines: { methodName: string; amount: string }[];
      expectedCash: string;
      pendingCount: number;
      session: unknown;
    };
    expect(body.date).toBe(today);
    expect(body.lines.map((line) => line.methodName)).toEqual([
      'Efectivo del cajón',
      'Transferencia Pichincha',
    ]);
    expect(body.expectedCash).toBe(paid.totals.total);
    expect(body.pendingCount).toBe(1);
    expect(body.session).toBeNull();

    const short = (Number(paid.totals.total) - 1).toFixed(2);
    const closed = await api()
      .post('/cash-sessions/close', { date: today, declaredCash: short })
      .expect(201);
    expect((closed.body as { difference: string }).difference).toBe('-1.00');
    expect((closed.body as { closedByName: string }).closedByName).toBe('Rosa Cedeño'); // prettier-ignore

    const again = await api()
      .post('/cash-sessions/close', { date: today, declaredCash: '0.00' })
      .expect(409);
    expect((again.body as { code: string }).code).toBe(
      'CASH_SESSION_ALREADY_CLOSED',
    );

    const late = await api()
      .post(`/invoices/${owed.id}/payments`, {
        paymentMethodId: cashId,
        amount: '1.00',
      }) // prettier-ignore
      .expect(409);
    expect((late.body as { code: string }).code).toBe('CASH_SESSION_CLOSED');

    // Control: the other cashier's drawer is still open that day.
    await api(otraCaja.token)
      .post(`/invoices/${owed.id}/payments`, {
        paymentMethodId: cashId,
        amount: '1.00',
      }) // prettier-ignore
      .expect(201);

    const future = await api()
      .post('/cash-sessions/close', {
        date: addDays(today, 1),
        declaredCash: '0.00',
      }) // prettier-ignore
      .expect(422);
    expect((future.body as { code: string }).code).toBe(
      'CASH_SESSION_DATE_IN_FUTURE',
    );
  });

  it('BI-247 emitir cobrado con la caja ya cerrada no emite: lo dice y no quema el secuencial', async () => {
    const today = clinicalDateOf(new Date());
    await api().post('/cash-sessions/close', { date: today, declaredCash: '0.00' }).expect(201); // prettier-ignore
    const accountId = await anAccount();
    const refused = await issue(accountId, { paymentMethodId: cashId });
    expect(refused.status).toBe(409);
    expect((refused.body as { code: string }).code).toBe('CASH_SESSION_CLOSED');
    expect(await prisma.invoice.count({ where: { accountId } })).toBe(0);
  });
});
