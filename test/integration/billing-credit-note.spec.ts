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
import {
  addDays,
  addMonths,
  clinicalDateOf,
} from '../../src/shared/domain/clinic-time';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';
import { composeAccessKey } from '../../src/modules/sri/domain/access-key';
import { authoriseVoucher, TEST_ISSUER_RUC } from './setup/sri-fixtures';

/**
 * billing/B15 by HTTP: «Corregir» an authorised invoice with a credit note,
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
      /** The account of an attention (BI-214: another open account of it). */
      encounterId?: string;
      /** B4: $3.00 off each line, applied by one user and authorised by another. */
      discounted?: boolean;
    } = {},
  ) {
    const own = (options.site ?? 'own') === 'own';
    const site = own ? siteId : otherSiteId;
    const account = await prisma.patientAccount.create({
      data: {
        patientId,
        siteId: site,
        payerId,
        encounterId: options.encounterId ?? null,
        priceListId: (
          await prisma.priceList.findFirstOrThrow({ where: { payerId } })
        ).id,
      },
    });
    const [applier, authoriser] = await prisma.user.findMany({ take: 2 });
    const granted = new Date(Date.now() - 60_000);
    for (let line = 0; line < (options.lines ?? 2); line += 1) {
      await prisma.chargeItem.create({
        data: {
          ...(options.discounted
            ? {
                discountAmount: 3,
                discountReason: 'Convenio',
                discountAppliedById: applier!.id,
                discountAppliedAt: granted,
                discountAuthorisedById: authoriser!.id,
                discountAuthorisedAt: granted,
              }
            : {}),
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
    const discountTotal = options.discounted ? 3 * charges.length : 0;
    const total = 30 * charges.length - discountTotal;
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
        subtotalUntaxed: 30 * charges.length,
        taxTotal: 0,
        discountTotal,
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

  let keys = 0;
  /**
   * As the SRI's answer leaves a credit note: a `04` voucher and the note
   * AUTHORISED with its key. The sites here have no issuer data, so nothing
   * prepares it on its own — and nothing reaches any SRI.
   */
  async function authoriseCreditNote(creditNoteId: string): Promise<void> {
    keys += 1;
    const numericCode = String(70_000_000 + keys);
    const accessKey = composeAccessKey({
      issuedOn: today(),
      documentType: '04',
      ruc: TEST_ISSUER_RUC,
      environment: '1',
      establishmentCode: '001',
      emissionPointCode: '001',
      sequential: String(keys).padStart(9, '0'),
      numericCode,
    });
    await prisma.$executeRaw`
      INSERT INTO "electronic_voucher"
        ("credit_note_id", "site_id", "document_type", "access_key",
         "numeric_code", "environment", "schema_version", "status", "unsigned_xml")
      SELECT "id", "site_id", '04', ${accessKey}, ${numericCode}, '1', '1.1.0',
             'PREPARED', '<notaCredito id="comprobante"/>'
        FROM "credit_note" WHERE "id" = ${creditNoteId}::uuid`;
    await prisma.$executeRaw`
      UPDATE "credit_note" SET "access_key" = ${accessKey}, "status" = 'AUTHORISED'
       WHERE "id" = ${creditNoteId}::uuid`;
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

  it('BI-214 BI-066 corregir una factura con una línea rebajada la vuelve a cobrar con el mismo descuento, quién lo puso y quién lo autorizó', async () => {
    const { invoiceId, accountId, chargeIds } = await anInvoice({
      lines: 1,
      settled: true,
      discounted: true,
    });
    const original = await prisma.chargeItem.findUniqueOrThrow({
      where: { id: chargeIds[0] },
    });

    const response = await correct(invoiceId, { reasonCode: 'RECEIVER_DATA' });
    expect(response.status).toBe(201);

    const copy = await prisma.chargeItem.findFirstOrThrow({
      where: { accountId, origin: 'CORRECTION' },
    });
    expect(copy.discountAmount.toFixed(2)).toBe('3.00');
    expect(copy).toMatchObject({
      discountReason: 'Convenio',
      discountAppliedById: original.discountAppliedById,
      discountAppliedAt: original.discountAppliedAt,
      discountAuthorisedById: original.discountAuthorisedById,
      discountAuthorisedAt: original.discountAuthorisedAt,
    });
  });

  it('BI-208 BI-210 BI-214 BI-215 BI-096 corregir el receptor acredita toda la factura, a nombre del mismo receptor, deja facturados los cargos originales y reabre la cuenta con una copia por facturar', async () => {
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

    // D-152.8: the wrong receiver's e-mail is not copied to the credit note.
    expect(
      (
        await prisma.creditNote.findUniqueOrThrow({
          where: { id: creditNote.id },
        })
      ).buyerEmail,
    ).toBeNull();

    // C1 (D-152.7): what came back is billed again once the SRI authorised
    // the credit note — not before.
    const reissue = () =>
      api()
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
    const early = await reissue();
    expect(early.status).toBe(409);
    expect((early.body as Problem).code).toBe('CORRECTION_AWAITS_CREDIT_NOTE');
    expect(
      await prisma.chargeItem.count({ where: { accountId, origin: 'CORRECTION', status: 'BILLABLE' } }), // prettier-ignore
    ).toBe(2);

    await authoriseCreditNote(creditNote.id);
    const reissued = await reissue();
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

  it('BI-210 dos cajeras corrigen dos facturas del mismo punto a la vez: los secuenciales salen consecutivos y únicos', async () => {
    const first = await anInvoice();
    const second = await anInvoice();

    const [a, b] = await Promise.all([
      correct(first.invoiceId, { reasonCode: 'AMOUNT' }),
      correct(second.invoiceId, { reasonCode: 'AMOUNT' }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(
      [a, b]
        .map((each) => (each.body as IssuedBody).creditNote.sequential)
        .sort(),
    ).toEqual(['000000001', '000000002']);
  });

  it('BI-214 si la atención ya tiene otra cuenta abierta, lo acreditado vuelve a esa', async () => {
    const practitioner = await createPractitioner(prisma);
    const encounter = await createEncounter(prisma, {
      siteId,
      practitionerId: practitioner.id,
      patientId,
    });
    const credited = await anInvoice({
      settled: true,
      encounterId: encounter.id,
    });
    const open = await prisma.patientAccount.create({
      data: {
        patientId,
        siteId,
        payerId,
        encounterId: encounter.id,
        priceListId: (
          await prisma.priceList.findFirstOrThrow({ where: { payerId } })
        ).id,
      },
    });

    const response = await correct(credited.invoiceId, {
      reasonCode: 'AMOUNT',
    });
    expect(response.status).toBe(201);
    expect((response.body as IssuedBody).rebilledAccountId).toBe(open.id);
    expect(
      await prisma.chargeItem.count({
        where: { accountId: open.id, origin: 'CORRECTION' },
      }),
    ).toBe(2);
    // Control: la liquidada sigue liquidada.
    expect(
      (
        await prisma.patientAccount.findUniqueOrThrow({
          where: { id: credited.accountId },
        })
      ).status,
    ).toBe('SETTLED');
  });

  it('BI-214 una cuenta anulada no se reabre: la corrección entera se rechaza y no queda nada escrito', async () => {
    const { invoiceId, accountId } = await anInvoice();
    await prisma.$executeRaw`
      UPDATE "patient_account"
         SET "status" = 'CANCELLED', "closed_at" = CURRENT_TIMESTAMP,
             "changed_by" = (SELECT "id" FROM "app_user" LIMIT 1),
             "changed_at" = CURRENT_TIMESTAMP
       WHERE "id" = ${accountId}::uuid`;

    const response = await correct(invoiceId, { reasonCode: 'AMOUNT' });
    expect(response.status).toBe(409);
    expect((response.body as Problem).code).toBe('ACCOUNT_CLOSED');
    expect(await prisma.creditNote.count()).toBe(0);
    // Control: «Servicio no prestado» no devuelve nada, así que sí se emite.
    expect(
      (await correct(invoiceId, { reasonCode: 'SERVICE_NOT_PROVIDED' })).status,
    ).toBe(201);
  });

  it('BI-071 cerrar la cuenta vuelve a contar sus cargos bajo bloqueo: con lo acreditado de vuelta, no se cierra', async () => {
    const { invoiceId, accountId } = await anInvoice();
    await correct(invoiceId, { reasonCode: 'AMOUNT' }).expect(201);

    const close = await api()
      .post(`/api/v1/billing/sites/${siteId}/accounts/${accountId}/close`)
      .set('Authorization', `Bearer ${cashierToken}`);
    expect(close.status).toBe(409);
    expect((close.body as Problem).code).toBe('ACCOUNT_HAS_OPEN_CHARGES');
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

  /** The ids a list answered, in its order. */
  async function listed(
    path: string,
  ): Promise<{ ids: string[]; total: number }> {
    const response = await api()
      .get(`/api/v1/billing/sites/${siteId}/${path}`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .expect(200);
    const body = response.body as { items: { id: string }[]; total: number };
    return { ids: body.items.map((item) => item.id), total: body.total };
  }

  it('BI-233 las facturas de la sede se buscan por número, por comprador y por fecha, por páginas', async () => {
    const first = await anInvoice({ authorised: false });
    const second = await anInvoice({ authorised: false });
    const finalConsumer = await anInvoice({
      authorised: false,
      finalConsumer: true,
    });
    // The printed number needs the site's SRI code (SRI-008).
    await prisma.site.update({
      where: { id: siteId },
      data: { sriEstablishmentCode: '001' },
    });
    // The first one, issued three days ago.
    await prisma.invoice.update({
      where: { id: first.invoiceId },
      data: { issuedAt: new Date(Date.now() - 3 * 86_400_000) },
    });

    // Control: without filters, all three, the newest number first.
    expect(await listed('invoices')).toEqual({
      ids: [finalConsumer.invoiceId, second.invoiceId, first.invoiceId],
      total: 3,
    });
    expect((await listed('invoices?search=2')).ids).toEqual([second.invoiceId]);
    expect((await listed('invoices?search=001-001-000000003')).ids).toEqual([
      finalConsumer.invoiceId,
    ]);
    expect((await listed('invoices?search=consumidor')).ids).toEqual([
      finalConsumer.invoiceId,
    ]);
    expect((await listed('invoices?search=1710')).ids).toEqual([
      second.invoiceId,
      first.invoiceId,
    ]);
    expect((await listed(`invoices?from=${today()}`)).ids).toEqual([
      finalConsumer.invoiceId,
      second.invoiceId,
    ]);
    expect((await listed(`invoices?to=${addDays(today(), -1)}`)).ids).toEqual([
      first.invoiceId,
    ]);
    expect(await listed('invoices?page=2&pageSize=2')).toEqual({
      ids: [first.invoiceId],
      total: 3,
    });
  });

  it('BI-233 con dos puntos de emisión la más reciente va primero, y el número completo distingue el punto', async () => {
    const a = await anInvoice({ authorised: false });
    const b = await anInvoice({ authorised: false });
    const c = await anInvoice({ authorised: false });
    await prisma.site.update({
      where: { id: siteId },
      data: { sriEstablishmentCode: '001' },
    });
    const second = await prisma.emissionPoint.create({
      data: { siteId, code: '002', description: 'Caja dos' },
    });
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    await prisma.invoice.update({
      where: { id: a.invoiceId },
      data: { issuedAt: daysAgo(1) },
    });
    // Another point's higher sequential, issued earlier than both.
    await prisma.invoice.update({
      where: { id: b.invoiceId },
      data: {
        emissionPointId: second.id,
        sequential: '000000009',
        issuedAt: daysAgo(3),
      },
    });

    expect((await listed('invoices')).ids).toEqual([
      c.invoiceId,
      a.invoiceId,
      b.invoiceId,
    ]);
    expect((await listed('invoices?search=001-002-000000009')).ids).toEqual([
      b.invoiceId,
    ]);
    // Control: the same sequential on the other point is nobody's.
    expect((await listed('invoices?search=001-001-000000009')).ids).toEqual([]);
  });

  it('BI-235 la factura y la nota de crédito llevan su número impreso completo, el de la clave cuando la tienen', async () => {
    const pending = await anInvoice({ authorised: false });
    const authorised = await anInvoice();
    const response = await api()
      .get(`/api/v1/billing/sites/${siteId}/invoices`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .expect(200);
    const numbers = new Map(
      (
        response.body as { items: { id: string; documentNumber: string }[] }
      ).items.map((item) => [item.id, item.documentNumber]),
    );
    // SRI-008: a site without its SRI code never gets an invented `001`.
    expect(numbers.get(pending.invoiceId)).toBe('???-001-000000001');
    expect(numbers.get(authorised.invoiceId)).toMatch(
      /^\d{3}-\d{3}-000000002$/,
    );

    const created = await correct(authorised.invoiceId, {
      reasonCode: 'RECEIVER_DATA',
    }).expect(201);
    expect(
      (created.body as { creditNote: { invoiceDocumentNumber: string; documentNumber: string } }).creditNote, // prettier-ignore
    ).toMatchObject({
      invoiceDocumentNumber: numbers.get(authorised.invoiceId),
      documentNumber: '???-001-000000001',
    });
  });

  it('BI-234 las notas de crédito se buscan con los mismos filtros, sobre la nota', async () => {
    const { invoiceId } = await anInvoice();
    const created = await correct(invoiceId, {
      reasonCode: 'RECEIVER_DATA',
    }).expect(201);
    const noteId = (created.body as { creditNote: { id: string } }).creditNote
      .id;

    expect((await listed('credit-notes?search=guamán')).ids).toEqual([noteId]);
    expect((await listed('credit-notes?search=1')).ids).toEqual([noteId]);
    expect((await listed('credit-notes?search=consumidor')).ids).toEqual([]);
    expect(
      (await listed(`credit-notes?from=${today()}&to=${today()}`)).ids,
    ).toEqual([noteId]);
    expect(
      (await listed(`credit-notes?from=${addDays(today(), 1)}`)).total,
    ).toBe(0);
  });

  /** BI-074. The account as caja reads it. */
  async function statementOf(accountId: string) {
    const response = await api()
      .get(`/api/v1/billing/sites/${siteId}/accounts/${accountId}`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .expect(200);
    return response.body as {
      totals: { total: string };
      charges: {
        id: string;
        origin: string;
        status: string;
        creditNote: {
          id: string;
          documentNumber: string;
          status: string;
        } | null;
      }[];
    };
  }

  it('BI-074 BI-260 tras una nota de crédito que vuelve a facturar, la cuenta suma lo que se debe una vez y cada cargo acreditado dice su nota', async () => {
    const { invoiceId, accountId, chargeIds } = await anInvoice({
      settled: true,
    });
    // Control: before the credit note, the two billed lines are the total.
    expect((await statementOf(accountId)).totals.total).toBe('60.00');

    const created = await correct(invoiceId, {
      reasonCode: 'RECEIVER_DATA',
    }).expect(201);
    const note = (created.body as IssuedBody).creditNote as CreditNoteBody & {
      documentNumber: string;
    };

    const statement = await statementOf(accountId);
    // The originals stay BILLED (BI-096) and their copies are back: $60, not $120.
    expect(statement.charges).toHaveLength(4);
    expect(statement.totals.total).toBe('60.00');
    const credited = statement.charges.filter((charge) =>
      chargeIds.includes(charge.id),
    );
    expect(credited.map((charge) => charge.creditNote)).toEqual([
      { id: note.id, documentNumber: note.documentNumber, status: 'ISSUED' },
      { id: note.id, documentNumber: note.documentNumber, status: 'ISSUED' },
    ]);
    expect(
      statement.charges
        .filter((charge) => charge.origin === 'CORRECTION')
        .map((charge) => charge.creditNote),
    ).toEqual([null, null]);
  });

  it('BI-074 con «Servicio no prestado» lo acreditado sale del total; si el SRI rechaza la nota, vuelve a contar', async () => {
    const { invoiceId, accountId } = await anInvoice({ settled: true });
    const created = await correct(invoiceId, {
      reasonCode: 'SERVICE_NOT_PROVIDED',
    }).expect(201);
    expect((await statementOf(accountId)).totals.total).toBe('0.00');

    // A note the SRI rejected credits nothing (BI-103): the lines count again.
    const noteId = (created.body as IssuedBody).creditNote.id;
    await prisma.$executeRaw`
      UPDATE "credit_note" SET "status" = 'REJECTED' WHERE "id" = ${noteId}::uuid`;
    const statement = await statementOf(accountId);
    expect(statement.totals.total).toBe('60.00');
    expect(statement.charges.map((charge) => charge.creditNote)).toEqual([
      null,
      null,
    ]);
  });

  it('BI-260 la factura acreditada dice su nota de crédito y la factura que vuelve a cobrar lo acreditado', async () => {
    const { invoiceId, accountId } = await anInvoice({ settled: true });
    const created = await correct(invoiceId, {
      reasonCode: 'RECEIVER_DATA',
    }).expect(201);
    const note = (created.body as IssuedBody).creditNote as CreditNoteBody & {
      documentNumber: string;
    };

    type InvoiceRefs = {
      id: string;
      creditNotes: { id: string; documentNumber: string; status: string }[];
      replacedBy: { id: string; accountId: string; documentNumber: string }[];
    };
    const invoicesOf = async () =>
      new Map(
        (
          (
            await api()
              .get(`/api/v1/billing/sites/${siteId}/invoices`)
              .set('Authorization', `Bearer ${cashierToken}`)
              .expect(200)
          ).body as { items: InvoiceRefs[] }
        ).items.map((item) => [item.id, item]),
      );

    // Credited and not billed again yet: the note, and nothing replaces it.
    expect((await invoicesOf()).get(invoiceId)).toMatchObject({
      creditNotes: [
        { id: note.id, documentNumber: note.documentNumber, status: 'ISSUED' },
      ],
      replacedBy: [],
    });

    // The copies are billed once the note is authorised (BI-214).
    await authoriseCreditNote(note.id);
    const copies = await prisma.chargeItem.findMany({
      where: { accountId, origin: 'CORRECTION' },
    });
    const replacement = await prisma.invoice.create({
      data: {
        accountId,
        siteId,
        emissionPointId,
        sequential: '000000002',
        buyerIdentificationType: '05',
        buyerIdentification: '1710034065',
        buyerName: 'Guamán Andrade, María José',
        paymentMethod: '01',
        subtotalTaxed: 0,
        subtotalUntaxed: 60,
        taxTotal: 0,
        discountTotal: 0,
        total: 60,
        status: 'ISSUED',
        issuedAt: new Date(),
        issuedById: copies[0]!.createdById,
      },
    });
    await prisma.chargeItem.updateMany({
      where: { id: { in: copies.map((copy) => copy.id) } },
      data: { status: 'BILLED', invoiceId: replacement.id },
    });

    const invoices = await invoicesOf();
    expect(invoices.get(invoiceId)).toMatchObject({
      creditNotes: [{ id: note.id, status: 'AUTHORISED' }],
      replacedBy: [
        {
          id: replacement.id,
          accountId,
          documentNumber: '???-001-000000002',
        },
      ],
    });
    // The replacement itself is credited by nothing and replaces nothing.
    expect(invoices.get(replacement.id)).toMatchObject({
      creditNotes: [],
      replacedBy: [],
    });
  });
});
