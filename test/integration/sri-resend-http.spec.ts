import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { seedBilling } from '../../prisma/seed-billing.mts';
import { seedSpecialties } from '../../prisma/seed-specialties.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';
import { MAILER } from '../../src/shared/mail/mail.port';
import { createTestPkcs12 } from '../support/test-pkcs12';

import { FakeMailer } from './setup/fake-mailer';
import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';
import { giveSiteAnIssuer } from './setup/sri-fixtures';

/**
 * SRI-095 and SRI-096 over HTTP (D-205 §4): «Reenviar a otro correo» sends the
 * RIDE and the authorised XML to the address the cashier gives, and nothing
 * the database holds about the voucher or the invoice moves. The real RIDE
 * issuer runs; only the mail relay is in memory (`FakeMailer`).
 */
const PASSWORD = 'el caballo come alfalfa';
const AUTHORISED_XML =
  '<autorizacion><estado>AUTORIZADO</estado></autorizacion>';

interface Problem {
  status: number;
  code: string;
  errors?: { field: string }[];
}

describe('reenviar un comprobante autorizado a otro correo (SRI-095, SRI-096)', () => {
  const db = useDatabase();
  const mailer = new FakeMailer();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let cashierToken: string;
  let otherCashierToken: string;
  let adminToken: string;
  let siteId: string;
  let patientId: string;
  let payerId: string;
  let serviceId: string;
  let emissionPointId: string;

  const api = () => request(app.getHttpServer());

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();
    mailer.reset();
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .overrideProvider(MAILER)
        .useValue(mailer)
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

    // BI-279. `CONS-MG-PV` is a consultation of its specialty: seeded first.

    await seedSpecialties(prisma);

    await seedBilling(prisma);
    await syncAuthorisation(prisma);
    registry.invalidate();

    const site = await createSite(prisma);
    await giveSiteAnIssuer(prisma, site.id);
    const other = await createSite(prisma, 'Sede Sur');
    siteId = site.id;
    patientId = (await createPatient(prisma)).id;
    payerId = (
      await prisma.payer.findUniqueOrThrow({ where: { code: 'PARTICULAR' } })
    ).id;
    serviceId = (
      await prisma.service.findUniqueOrThrow({
        where: { code: 'CONS-MG-PV' },
      })
    ).id;
    emissionPointId = (
      await prisma.emissionPoint.create({ data: { siteId, code: '001' } })
    ).id;

    cashierToken = await signIn('caja@clinica.ec', 'CAJA', siteId, '1710034065'); // prettier-ignore
    otherCashierToken = await signIn('caja.sur@clinica.ec', 'CAJA', other.id, '0912345675'); // prettier-ignore
    adminToken = await signIn('admin@clinica.ec', 'ADMIN', null, '1712345675');
    await uploadCertificate();
    // DOC-037: the RIDE is composed from a published template, as in the clinic.
    await api()
      .post('/api/v1/documents/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        kind: 'INVOICE_RIDE',
        accentColour: '#1f6f8b',
        footerText: 'Centro de Especialidades Bahía',
        headerFields: [],
        showEstablishmentRuc: true,
      })
      .expect(201);
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
    const response = await api()
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  async function uploadCertificate(): Promise<void> {
    const p12 = createTestPkcs12({ now: new Date() });
    await api()
      .post('/api/v1/sri/certificates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        pkcs12Base64: p12.pkcs12.toString('base64'),
        password: p12.password,
      })
      .expect(201);
  }

  /** Issued to the patient WITH an e-mail, signed, waiting for the SRI. */
  async function issueInvoice(): Promise<{ id: string; voucherId: string }> {
    const account = await api()
      .post(`/api/v1/billing/sites/${siteId}/accounts`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ patientId, payerId })
      .expect(201);
    const accountId = (account.body as { id: string }).id;
    await api()
      .post(`/api/v1/billing/sites/${siteId}/accounts/${accountId}/charges`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({
        serviceId,
        serviceDate: clinicalDateOf(new Date()),
      })
      .expect(201);
    const invoice = await api()
      .post(`/api/v1/billing/sites/${siteId}/invoices`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({
        accountId,
        emissionPointId,
        paymentMethod: '01',
        receiver: {
          identificationType: '05',
          identification: '1710034065',
          name: 'Guamán Andrade, María José',
          email: 'maria@example.com',
        },
      })
      .expect(201);
    const body = invoice.body as { id: string; electronic: { voucherId: string } }; // prettier-ignore
    return { id: body.id, voucherId: body.electronic.voucherId };
  }

  /**
   * As the SRI's answer and the first delivery leave it: authorised
   * `hoursAgo` before the database's now, its e-mail `delivery`.
   */
  async function authorise(
    invoice: { id: string; voucherId: string },
    delivery: 'SENT' | 'FAILED' | 'UNDELIVERABLE' = 'SENT',
    hoursAgo = 0,
  ) {
    await prisma.$executeRaw`
      UPDATE "electronic_voucher"
         SET "status" = 'AUTHORISED',
             "authorisation_number" = "access_key",
             "authorised_at" = ${new Date(Date.now() - hoursAgo * 3_600_000)}::timestamptz,
             "authorised_xml" = ${AUTHORISED_XML},
             "delivery_status" = ${delivery}::text,
             "delivered_at" = CASE WHEN ${delivery}::text = 'SENT' THEN CURRENT_TIMESTAMP END
       WHERE "id" = ${invoice.voucherId}::uuid`;
    await prisma.$executeRaw`
      UPDATE "invoice" SET "status" = 'AUTHORISED', "authorised_at" = CURRENT_TIMESTAMP
       WHERE "id" = ${invoice.id}::uuid`;
  }

  const resend = (voucherId: string, body: object, token = cashierToken) =>
    api()
      .post(`/api/v1/sri/vouchers/${voucherId}/resend`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('SRI-095 manda el RIDE y el XML autorizado a la dirección dada, y no cambia el comprobante ni la factura', async () => {
    const invoice = await issueInvoice();
    await authorise(invoice);
    const voucherBefore = await prisma.electronicVoucher.findUniqueOrThrow({
      where: { id: invoice.voucherId },
    });
    const invoiceBefore = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });

    await resend(invoice.voucherId, { email: 'luis.guaman@correo.ec' }).expect(204); // prettier-ignore

    expect(mailer.sent).toHaveLength(1);
    const message = mailer.last()!;
    expect(message.to).toBe('luis.guaman@correo.ec');
    expect(message.attachments?.map((a) => a.contentType)).toEqual([
      'application/pdf',
      'application/xml',
    ]);
    expect(message.attachments?.[1]?.content.toString('utf8')).toBe(
      AUTHORISED_XML,
    );
    expect(
      await prisma.electronicVoucher.findUniqueOrThrow({
        where: { id: invoice.voucherId },
      }),
    ).toEqual(voucherBefore);
    expect(
      await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }),
    ).toEqual(invoiceBefore);
    const trail = await prisma.accessAudit.findMany({
      where: { resourceType: 'electronic_voucher', resourceId: invoice.voucherId }, // prettier-ignore
      select: { action: true, before: true, after: true },
    });
    expect(trail).toEqual([{ action: 'EXPORT', before: null, after: null }]);
  });

  it('SRI-096 lo que el SRI no ha autorizado no se reenvía (409) y no sale ningún correo', async () => {
    const invoice = await issueInvoice();

    const refused = await resend(invoice.voucherId, { email: 'luis@correo.ec' }).expect(409); // prettier-ignore
    expect((refused.body as Problem).code).toBe('SRI_VOUCHER_NOT_AUTHORISED');
    expect(mailer.sent).toHaveLength(0);

    // Positive control: the same voucher, once authorised, goes.
    await authorise(invoice);
    await resend(invoice.voucherId, { email: 'luis@correo.ec' }).expect(204);
    expect(mailer.sent).toHaveLength(1);
  });

  it('SRI-096 caja de otra sede no lo encuentra (404) y una dirección mal escrita se rechaza en su campo', async () => {
    const invoice = await issueInvoice();
    await authorise(invoice);

    const elsewhere = await resend(invoice.voucherId, { email: 'luis@correo.ec' }, otherCashierToken).expect(404); // prettier-ignore
    expect((elsewhere.body as Problem).code).toBe('SRI_VOUCHER_NOT_FOUND');

    const malformed = await resend(invoice.voucherId, { email: 'no-es-correo' }).expect(422); // prettier-ignore
    expect((malformed.body as Problem).errors?.[0]?.field).toBe('email');
    expect(mailer.sent).toHaveLength(0);
  });

  it('SRI-096 si el correo no sale responde SRI_RESEND_FAILED y la entrega registrada no cambia', async () => {
    const invoice = await issueInvoice();
    await authorise(invoice);
    mailer.failWith = new Error('relay refused');

    const failed = await resend(invoice.voucherId, { email: 'luis@correo.ec' }).expect(503); // prettier-ignore
    expect((failed.body as Problem).code).toBe('SRI_RESEND_FAILED');
    const voucher = await prisma.electronicVoucher.findUniqueOrThrow({
      where: { id: invoice.voucherId },
    });
    expect(voucher.deliveryStatus).toBe('SENT');
    expect(mailer.sent).toHaveLength(0);

    // Positive control: the relay back, the same request goes.
    mailer.failWith = null;
    await resend(invoice.voucherId, { email: 'luis@correo.ec' }).expect(204);
    expect(mailer.sent).toHaveLength(1);
  });

  it('SRI-096 el comprobante autorizado de una factura anulada no se reenvía (409)', async () => {
    const invoice = await issueInvoice();
    await authorise(invoice);
    await prisma.$executeRaw`
      UPDATE "invoice" SET "status" = 'VOIDED' WHERE "id" = ${invoice.id}::uuid`;

    const refused = await resend(invoice.voucherId, { email: 'luis@correo.ec' }).expect(409); // prettier-ignore
    expect((refused.body as Problem).code).toBe('SRI_VOUCHER_NOT_AUTHORISED');
    expect(mailer.sent).toHaveLength(0);
  });

  it('SRI-095 el RIDE de la copia queda a nombre de quien la reenvía, no de quien emitió', async () => {
    const invoice = await issueInvoice();
    await authorise(invoice);
    const colleague = await signIn('caja2@clinica.ec', 'CAJA', siteId, '0102030400'); // prettier-ignore
    const colleagueId = (
      await prisma.user.findUniqueOrThrow({
        where: { email: 'caja2@clinica.ec' },
      })
    ).id;

    await resend(invoice.voucherId, { email: 'luis@correo.ec' }, colleague).expect(204); // prettier-ignore

    const renders = await prisma.$queryRaw<{ issued_by_id: string }[]>`
      SELECT issued_by_id::text FROM document_render
       WHERE invoice_id = ${invoice.id}::uuid
       ORDER BY issued_at DESC LIMIT 1`;
    expect(renders).toEqual([{ issued_by_id: colleagueId }]);
  });

  const deliveryOf = async (invoice: { voucherId: string }) =>
    (
      await prisma.electronicVoucher.findUniqueOrThrow({
        where: { id: invoice.voucherId },
      })
    ).deliveryStatus;

  it('SRI-095 SRI-099 reenviado bien a la dirección del comprador, el dado por perdido pasa a SENT', async () => {
    const invoice = await issueInvoice();
    await authorise(invoice, 'UNDELIVERABLE', 80);

    // Control: to another address the buyer's delivery stays as it was.
    await resend(invoice.voucherId, { email: 'contador@empresa.ec' }).expect(204); // prettier-ignore
    expect(await deliveryOf(invoice)).toBe('UNDELIVERABLE');

    // The buyer's own address, typed with other capitals.
    await resend(invoice.voucherId, { email: 'Maria@Example.com' }).expect(204);
    expect(await deliveryOf(invoice)).toBe('SENT');
    expect(mailer.sent.map((m) => m.to)).toEqual([
      'contador@empresa.ec',
      'Maria@Example.com',
    ]);
  });

  it('SRI-099 administración reintenta el correo con billing:voucher-mail, y quien no lo tiene no', async () => {
    const invoice = await issueInvoice();
    await authorise(invoice, 'FAILED');
    const doctor = await signIn('medico@clinica.ec', 'MEDICO', siteId, '0102030418'); // prettier-ignore

    const denied = await resend(invoice.voucherId, { email: 'maria@example.com' }, doctor).expect(403); // prettier-ignore
    expect((denied.body as Problem).code).toBeDefined();
    expect(mailer.sent).toHaveLength(0);

    await resend(invoice.voucherId, { email: 'maria@example.com' }, adminToken).expect(204); // prettier-ignore
    expect(await deliveryOf(invoice)).toBe('SENT');

    // Administration does not issue: once the e-mail went, no more copies.
    const sent = await resend(invoice.voucherId, { email: 'otro@correo.ec' }, adminToken).expect(409); // prettier-ignore
    expect((sent.body as Problem).code).toBe('SRI_RESEND_DELIVERY_NOT_FAILED');
    // Control: caja, who issues, still can.
    await resend(invoice.voucherId, { email: 'otro@correo.ec' }).expect(204);
  });

  it('SRI-100 cada reenvío que sale queda guardado con su dirección; el que falla, no', async () => {
    const invoice = await issueInvoice();
    await authorise(invoice);
    const cashierId = (
      await prisma.user.findUniqueOrThrow({
        where: { email: 'caja@clinica.ec' },
      })
    ).id;

    mailer.failWith = new Error('relay refused');
    await resend(invoice.voucherId, { email: 'luis@correo.ec' }).expect(503);
    mailer.failWith = null;
    await resend(invoice.voucherId, { email: 'luis@correo.ec' }).expect(204);
    await resend(invoice.voucherId, { email: 'maria@example.com' }).expect(204);

    const rows = await prisma.$queryRaw<
      { recipient: string; to_buyer: boolean; sent_by_id: string }[]
    >`SELECT recipient, to_buyer, sent_by_id::text
        FROM electronic_voucher_mailing
       WHERE voucher_id = ${invoice.voucherId}::uuid
       ORDER BY sent_at, id`;
    expect(rows).toEqual([
      { recipient: 'luis@correo.ec', to_buyer: false, sent_by_id: cashierId },
      { recipient: 'maria@example.com', to_buyer: true, sent_by_id: cashierId },
    ]);
  });

  it('SRI-100 la base no deja cambiar ni borrar un envío guardado', async () => {
    const invoice = await issueInvoice();
    await authorise(invoice);
    await resend(invoice.voucherId, { email: 'luis@correo.ec' }).expect(204);

    // Positive control: the table takes an insert by the same path the test
    // then refuses to update.
    await prisma.$executeRaw`
      INSERT INTO electronic_voucher_mailing (voucher_id, sent_by_id, sent_at, recipient, to_buyer)
      SELECT voucher_id, sent_by_id, sent_at, 'otra@correo.ec', false
        FROM electronic_voucher_mailing
       WHERE voucher_id = ${invoice.voucherId}::uuid LIMIT 1`;

    await expect(
      prisma.$executeRaw`
        UPDATE electronic_voucher_mailing SET recipient = 'nadie@correo.ec'
         WHERE voucher_id = ${invoice.voucherId}::uuid`,
    ).rejects.toThrow(/electronic_voucher_mailing_append_only/);
    await expect(
      prisma.$executeRaw`
        DELETE FROM electronic_voucher_mailing
         WHERE voucher_id = ${invoice.voucherId}::uuid`,
    ).rejects.toThrow(/electronic_voucher_mailing_append_only/);
  });

  it('SRI-101 pasado el tope diario de quien reenvía, responde SRI_RESEND_DAILY_LIMIT sin enviar', async () => {
    const invoice = await issueInvoice();
    await authorise(invoice);
    const cashierId = (
      await prisma.user.findUniqueOrThrow({
        where: { email: 'caja@clinica.ec' },
      })
    ).id;
    // 49 already today: the 50th still goes (positive control).
    await prisma.$executeRaw`
      INSERT INTO electronic_voucher_mailing (voucher_id, sent_by_id, sent_at, recipient, to_buyer)
      SELECT ${invoice.voucherId}::uuid, ${cashierId}::uuid, CURRENT_TIMESTAMP, 'luis@correo.ec', false
        FROM generate_series(1, 49)`;
    await resend(invoice.voucherId, { email: 'luis@correo.ec' }).expect(204);

    const refused = await resend(invoice.voucherId, { email: 'luis@correo.ec' }).expect(429); // prettier-ignore
    expect((refused.body as Problem).code).toBe('SRI_RESEND_DAILY_LIMIT');
    expect(mailer.sent).toHaveLength(1);

    // Another person's quota is their own.
    const colleague = await signIn('caja2@clinica.ec', 'CAJA', siteId, '0102030400'); // prettier-ignore
    await resend(invoice.voucherId, { email: 'luis@correo.ec' }, colleague).expect(204); // prettier-ignore
  });

  it('SRI-098 el monitor cuenta los correos que llevan tres días fallando en las sedes de quien mira', async () => {
    const stuck = await issueInvoice();
    await authorise(stuck, 'FAILED', 80);
    // Controls: failing for less than three days, and given up for good.
    const recent = await issueInvoice();
    await authorise(recent, 'FAILED', 70);
    const givenUp = await issueInvoice();
    await authorise(givenUp, 'UNDELIVERABLE', 90);

    const mine = await api()
      .get('/api/v1/sri/vouchers')
      .set('Authorization', `Bearer ${cashierToken}`)
      .expect(200);
    const stalled = (mine.body as { deliveryStalled: { count: number; oldestAuthorisedAt: string | null } }).deliveryStalled; // prettier-ignore
    expect(stalled.count).toBe(1);
    const authorisedAt = (
      await prisma.electronicVoucher.findUniqueOrThrow({
        where: { id: stuck.voucherId },
      })
    ).authorisedAt!;
    expect(stalled.oldestAuthorisedAt).toBe(authorisedAt.toISOString());

    const elsewhere = await api()
      .get('/api/v1/sri/vouchers')
      .set('Authorization', `Bearer ${otherCashierToken}`)
      .expect(200);
    expect(elsewhere.body).toMatchObject({
      deliveryStalled: { count: 0, oldestAuthorisedAt: null },
    });
  });
});
