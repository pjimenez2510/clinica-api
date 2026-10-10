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
import { authoriseVoucher } from './setup/sri-fixtures';

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
  closed: boolean;
}
interface TurnBody {
  previousSession: { id: string; closedAt: string } | null;
  payments: PaymentBody[];
  lines: { methodName: string; amount: string }[];
  collectedTotal: string;
  expectedCash: string;
  pendingCount: number;
}
interface SessionBody {
  id: string;
  previousClosedAt: string | null;
  closedAt: string;
  closedByName: string;
  collectedTotal: string;
  difference: string;
  pendingCount: number;
}

describe('B6 cobros, saldo del paciente y cierre por turno', () => {
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
    // Declared as a transfer: the instalments come in by transfer and the
    // rest by another transfer method (BI-254).
    const invoice = (await issue(accountId, undefined, '20'))
      .body as InvoiceBody;
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
      .post(`/invoices/${invoice.id}/payments`, { paymentMethodId: transferId })
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

  it('BI-251 BI-105 BI-252 BI-104 BI-258 el turno abierto, el cierre con un dólar de menos, y cobrar después abre el turno siguiente', async () => {
    const paid = (await issue(await anAccount(), { paymentMethodId: cashId })).body as InvoiceBody; // prettier-ignore
    const owed = (await issue(await anAccount(), undefined, '20')).body as InvoiceBody; // prettier-ignore
    await api()
      .post(`/invoices/${owed.id}/payments`, {
        paymentMethodId: transferId,
        amount: '5.00',
      }) // prettier-ignore
      .expect(201);

    const turn = await api().get('/cash-sessions/open').expect(200);
    const body = turn.body as TurnBody;
    expect(body.previousSession).toBeNull();
    expect(body.lines.map((line) => line.methodName)).toEqual([
      'Efectivo del cajón',
      'Transferencia Pichincha',
    ]);
    expect(body.expectedCash).toBe(paid.totals.total);
    expect(body.pendingCount).toBe(1);
    expect(body.payments.every((payment) => !payment.closed)).toBe(true);

    const short = (Number(paid.totals.total) - 1).toFixed(2);
    const morning = await api()
      .post('/cash-sessions/close', {
        declaredCash: short,
        previousSessionId: null,
      })
      .expect(201);
    const first = morning.body as SessionBody;
    expect(first.difference).toBe('-1.00');
    expect(first.closedByName).toBe('Rosa Cedeño');
    expect(first.previousClosedAt).toBeNull();
    expect(first.pendingCount).toBe(1);

    // The same turn, closed again from a stale screen: refused, nothing written.
    const again = await api()
      .post('/cash-sessions/close', {
        declaredCash: '0.00',
        previousSessionId: null,
      })
      .expect(409);
    expect((again.body as { code: string }).code).toBe(
      'CASH_SESSION_ALREADY_CLOSED',
    );
    // Nothing collected since: there is no turn to close.
    const empty = await api()
      .post('/cash-sessions/close', {
        declaredCash: '0.00',
        previousSessionId: first.id,
      })
      .expect(422);
    expect((empty.body as { code: string }).code).toBe('CASH_SESSION_EMPTY');

    // A closed payment is not reversed.
    const [closedPayment] = await prisma.payment.findMany({ where: { invoiceId: paid.id } }); // prettier-ignore
    const refused = await api()
      .post(`/payments/${closedPayment!.id}/reversal`, {})
      .expect(409);
    expect((refused.body as { code: string }).code).toBe('CASH_SESSION_CLOSED');

    // Closing does not stop collecting: the payment opens the next turn.
    await api()
      .post(`/invoices/${owed.id}/payments`, {
        paymentMethodId: transferId,
        amount: '1.00',
      }) // prettier-ignore
      .expect(201);
    const afternoon = (await api().get('/cash-sessions/open').expect(200))
      .body as TurnBody;
    expect(afternoon.previousSession?.id).toBe(first.id);
    expect(afternoon.collectedTotal).toBe('1.00');
    expect(afternoon.payments).toHaveLength(1);
    // What it invoiced in the morning is not this turn's pending.
    expect(afternoon.pendingCount).toBe(0);

    const second = (
      await api()
        .post('/cash-sessions/close', {
          declaredCash: '0.00',
          previousSessionId: first.id,
          expectedCash: '0.00',
        })
        .expect(201)
    ).body as SessionBody;
    expect(second.collectedTotal).toBe('1.00');
    expect(second.previousClosedAt).toBe(first.closedAt);

    const list = (await api().get('/cash-sessions').expect(200)).body as {
      date: string;
      sessions: SessionBody[];
    };
    expect(list.date).toBe(clinicalDateOf(new Date()));
    expect(list.sessions.map((session) => session.id)).toEqual([
      first.id,
      second.id,
    ]);
    // Another cashier sees none of them.
    const theirs = (await api(otraCaja.token).get('/cash-sessions').expect(200))
      .body as { sessions: unknown[] };
    expect(theirs.sessions).toHaveLength(0);
    // Yesterday had none.
    const yesterday = (
      await api()
        .get(`/cash-sessions?date=${addDays(clinicalDateOf(new Date()), -1)}`)
        .expect(200)
    ).body as { sessions: unknown[] };
    expect(yesterday.sessions).toHaveLength(0);
  });

  it('BI-247 BI-104 emitir cobrado con la caja ya cerrada emite, y el cobro abre el turno siguiente', async () => {
    await issue(await anAccount(), { paymentMethodId: cashId });
    const first = (
      await api()
        .post('/cash-sessions/close', {
          declaredCash: '0.00',
          previousSessionId: null,
        })
        .expect(201)
    ).body as SessionBody;
    const accountId = await anAccount();
    const issued = await issue(accountId, { paymentMethodId: cashId });
    expect(issued.status).toBe(201);
    const turn = (await api().get('/cash-sessions/open').expect(200))
      .body as TurnBody;
    expect(turn.previousSession?.id).toBe(first.id);
    expect(turn.collectedTotal).toBe((issued.body as InvoiceBody).totals.total);
  });

  it('BI-254 una factura que declara efectivo no se cobra por transferencia, ni se le cambia la forma de pago ya cobrada', async () => {
    const invoice = (await issue(await anAccount())).body as InvoiceBody;
    const refused = await api()
      .post(`/invoices/${invoice.id}/payments`, { paymentMethodId: transferId })
      .expect(422);
    expect((refused.body as { code: string }).code).toBe(
      'PAYMENT_METHOD_MISMATCH',
    );
    // Control: a method of the declared form goes in.
    await api()
      .post(`/invoices/${invoice.id}/payments`, { paymentMethodId: cashId })
      .expect(201);
    // Returned by the SRI and already collected: the form stays.
    await prisma.$executeRaw`UPDATE "invoice" SET "status" = 'REJECTED' WHERE "id" = ${invoice.id}::uuid`;
    const edit = await api()
      .post(`/invoices/${invoice.id}/resubmission`, {
        paymentMethod: '20',
        receiver: { identificationType: '05', identification: '1710034065', name: 'Guamán Andrade, María José' }, // prettier-ignore
      })
      .expect(422);
    expect((edit.body as { code: string }).code).toBe(
      'PAYMENT_METHOD_MISMATCH',
    );
  });

  it('BI-255 el cierre con un efectivo esperado que ya no es el del turno se rechaza; con el de verdad, se cierra', async () => {
    const paid = (await issue(await anAccount(), { paymentMethodId: cashId })).body as InvoiceBody; // prettier-ignore
    const stale = await api()
      .post('/cash-sessions/close', {
        declaredCash: '0.00',
        previousSessionId: null,
        expectedCash: '0.00',
      }) // prettier-ignore
      .expect(409);
    expect((stale.body as { code: string }).code).toBe('CASH_SESSION_CHANGED');
    expect(await prisma.cashSession.count()).toBe(0);
    await api()
      .post('/cash-sessions/close', {
        previousSessionId: null,
        declaredCash: paid.totals.total,
        expectedCash: paid.totals.total,
      }) // prettier-ignore
      .expect(201);
  });

  it('BI-251 BI-135 un cobro de otra sede responde como inexistente (control: en la suya se revierte)', async () => {
    const invoice = (await issue(await anAccount(), { paymentMethodId: cashId })).body as InvoiceBody; // prettier-ignore
    const [payment] = await prisma.payment.findMany({ where: { invoiceId: invoice.id } }); // prettier-ignore
    const other = await createSite(prisma);
    const foreign = await request(app.getHttpServer())
      .post(
        `/api/v1/billing/sites/${other.id}/payments/${payment!.id}/reversal`,
      )
      .set('Authorization', `Bearer ${caja.token}`)
      .send({})
      .expect(404);
    expect((foreign.body as { code: string }).code).toBe('PAYMENT_NOT_FOUND');
    await api().post(`/payments/${payment!.id}/reversal`, {}).expect(200);
  });

  it('BI-259 «con saldo» deja sólo las facturas que se deben, de cualquier día, con los demás filtros y el total ya filtrado', async () => {
    const owed = (await issue(await anAccount())).body as InvoiceBody;
    const paid = (await issue(await anAccount(), { paymentMethodId: cashId })).body as InvoiceBody; // prettier-ignore
    // Half paid by transfer: still owes the other half.
    const partial = (await issue(await anAccount(), undefined, '20')).body as InvoiceBody; // prettier-ignore
    await api()
      .post(`/invoices/${partial.id}/payments`, {
        paymentMethodId: transferId,
        amount: (Number(partial.totals.total) / 2).toFixed(2),
      })
      .expect(201);
    // Paid and then reversed: owes it all again (BI-103).
    const reversed = (await issue(await anAccount(), { paymentMethodId: cashId })).body as InvoiceBody; // prettier-ignore
    const [payment] = await prisma.payment.findMany({ where: { invoiceId: reversed.id } }); // prettier-ignore
    await api().post(`/payments/${payment!.id}/reversal`, {}).expect(200);
    // Voided with its balance whole: nothing to collect.
    const voided = (await issue(await anAccount())).body as InvoiceBody;
    await prisma.$executeRaw`UPDATE "invoice" SET "status" = 'VOIDED' WHERE "id" = ${voided.id}::uuid`;
    // Credited whole: its balance is zero without a single payment.
    const credited = (await issue(await anAccount())).body as InvoiceBody;
    await authoriseVoucher(prisma, credited.id);
    await api()
      .post(`/invoices/${credited.id}/credit-notes`, {
        reasonCode: 'RECEIVER_DATA',
      })
      .expect(201);
    // The owed one, from three days ago: «Con saldo» is not today's list.
    await prisma.invoice.update({
      where: { id: owed.id },
      data: { issuedAt: new Date(Date.now() - 3 * 86_400_000) },
    });

    const listed = async (query: string) => {
      const body = (await api().get(`/invoices${query}`).expect(200)).body as {
        items: { id: string; balance: string }[];
        total: number;
      };
      return {
        ids: body.items.map((item) => item.id).sort(),
        total: body.total,
      };
    };

    // Control: without the filter, all six, and `owed=false` is the same.
    expect((await listed('')).total).toBe(6);
    expect((await listed('?owed=false')).total).toBe(6);

    expect(await listed('?owed=true')).toEqual({
      ids: [owed.id, partial.id, reversed.id].sort(),
      total: 3,
    });
    const yesterday = addDays(clinicalDateOf(new Date()), -1);
    expect(await listed(`?owed=true&to=${yesterday}`)).toEqual({
      ids: [owed.id],
      total: 1,
    });
    // With the search (by number) and with the day of issue.
    const [owedRow] = await prisma.invoice.findMany({
      where: { id: owed.id },
      select: { sequential: true },
    });
    expect(await listed(`?owed=true&search=${owedRow!.sequential}`)).toEqual({
      ids: [owed.id],
      total: 1,
    });
    const today = clinicalDateOf(new Date());
    expect(await listed(`?owed=true&from=${today}`)).toEqual({
      ids: [partial.id, reversed.id].sort(),
      total: 2,
    });
    const page = await listed('?owed=true&page=2&pageSize=2');
    expect(page.total).toBe(3);
    expect(page.ids).toHaveLength(1);
    // The paid, voided and credited ones exist (positive control above).
    expect(
      (await listed('?owed=true')).ids.some((id) =>
        [paid.id, voided.id, credited.id].includes(id),
      ),
    ).toBe(false);
  });
});
