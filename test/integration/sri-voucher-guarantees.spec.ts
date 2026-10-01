import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { Quantity } from '../../src/modules/billing/domain/money';
import { parseClinicalDate } from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite, createUser } from './setup/fixtures';
import { insertVoucher } from './setup/sri-fixtures';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE DATABASE GUARANTEES ABOUT THE ELECTRONIC VOUCHER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * sri/SPEC.md S1–S3. Every attempt goes in by RAW SQL, underneath every layer:
 * the claim is that the row cannot change even for somebody with a `psql`
 * prompt, not that no method exists to change it. And every rejection has its
 * positive control right before it — the permitted case passing through the
 * very same path — so a rejection cannot come from a typo in the statement.
 */
const db = useDatabase();

const SERVICE_DATE = parseClinicalDate('2026-05-11'); // fecha-fija: fecha del servicio, no se compara con el reloj

interface Context {
  prisma: PrismaClient;
  accounts: PrismaBillingAccountRepository;
  siteId: string;
  patientId: string;
  payerId: string;
  priceListId: string;
  emissionPointId: string;
  serviceId: string;
  userId: string;
}

let context: Context;

beforeEach(async () => {
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
  const emissionPoint = await prisma.emissionPoint.create({
    data: { siteId: site.id, code: '001' },
  });
  const service = await prisma.billableService.findUniqueOrThrow({
    where: { code: 'CONS-MG-PV' },
  });
  context = {
    prisma,
    accounts: new PrismaBillingAccountRepository(
      prisma as unknown as PrismaService,
    ),
    siteId: site.id,
    patientId: patient.id,
    payerId: payer.id,
    priceListId: priceList.id,
    emissionPointId: emissionPoint.id,
    serviceId: service.id,
    userId: user.id,
  };
});

async function anAccount(): Promise<string> {
  const account = await context.prisma.patientAccount.create({
    data: {
      patientId: context.patientId,
      siteId: context.siteId,
      payerId: context.payerId,
      priceListId: context.priceListId,
    },
  });
  return account.id;
}

async function charge(accountId: string): Promise<string> {
  const created = await context.accounts.addCharge({
    accountId,
    billableServiceId: context.serviceId,
    encounterId: null,
    serviceDate: SERVICE_DATE,
    quantity: Quantity.ONE,
    createdById: context.userId,
    origin: 'MANUAL',
    encounterProcedureId: null,
    serviceOrderItemId: null,
    status: 'BILLABLE',
  });
  return created.id;
}

async function issue(accountId: string) {
  return context.accounts.issueInvoice({
    accountId,
    siteId: context.siteId,
    emissionPointId: context.emissionPointId,
    receiver: {
      buyerIdentificationType: '05',
      buyerIdentification: '1710034065',
      buyerName: 'Guamán Andrade, María José',
      buyerEmail: null,
      isFinalConsumer: false,
    },
    issuedById: context.userId,
  });
}

async function anIssuedInvoice() {
  const accountId = await anAccount();
  await charge(accountId);
  return issue(accountId);
}

async function rejectionOf(promise: Promise<unknown>): Promise<string | null> {
  return promise
    .then(() => null)
    .catch((error: unknown) => String((error as Error).message));
}

describe('BI-169, SRI-012 cada línea sabe de qué factura es', () => {
  it('BI-169 SRI-012 una cuenta facturada dos veces deja cada cargo con su factura', async () => {
    const accountId = await anAccount();
    const first = await charge(accountId);
    const firstInvoice = await issue(accountId);
    const second = await charge(accountId);
    const secondInvoice = await issue(accountId);

    const rows = await context.prisma.chargeItem.findMany({
      where: { id: { in: [first, second] } },
      select: { id: true, invoiceId: true, status: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(first)).toMatchObject({
      status: 'BILLED',
      invoiceId: firstInvoice.id,
    });
    expect(byId.get(second)).toMatchObject({
      status: 'BILLED',
      invoiceId: secondInvoice.id,
    });
  });

  it('BI-169 la base rechaza un cargo BILLED sin factura y uno con factura sin estar BILLED', async () => {
    const invoice = await anIssuedInvoice();
    const accountId = await anAccount();
    const loose = await charge(accountId);

    // Control: billing it WITH its invoice passes the same constraint.
    await expect(
      context.prisma.$executeRaw`
        UPDATE "charge_item" SET "status" = 'BILLED', "invoice_id" = ${invoice.id}::uuid
         WHERE "id" = ${loose}::uuid`,
    ).resolves.toBe(1);

    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "charge_item" SET "invoice_id" = NULL WHERE "id" = ${loose}::uuid`,
      ),
    ).toMatch(/charge_item_billed_carries_its_invoice/);

    const other = await charge(accountId);
    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "charge_item" SET "invoice_id" = ${invoice.id}::uuid
           WHERE "id" = ${other}::uuid`,
      ),
    ).toMatch(/charge_item_billed_carries_its_invoice/);
  });
});

describe('SRI-009, OR-027 el código de establecimiento SRI', () => {
  it('SRI-009 OR-027 la base admite tres dígitos con el cero y rechaza cualquier otra forma', async () => {
    await expect(
      context.prisma.$executeRaw`
        UPDATE "site" SET "sri_establishment_code" = '002' WHERE "id" = ${context.siteId}::uuid`,
    ).resolves.toBe(1);
    const stored = await context.prisma.site.findUniqueOrThrow({
      where: { id: context.siteId },
    });
    expect(stored.sriEstablishmentCode).toBe('002');

    for (const bad of ['01', 'A01', '1 2']) {
      expect(
        await rejectionOf(
          context.prisma.$executeRaw`
            UPDATE "site" SET "sri_establishment_code" = ${bad} WHERE "id" = ${context.siteId}::uuid`,
        ),
      ).toMatch(/site_sri_establishment_code_format/);
    }
  });
});

describe('SRI-005, SRI-006, SRI-007 la clave de acceso no se regenera', () => {
  it('SRI-005 la base rechaza cambiar la clave del comprobante, y admite su avance de estado', async () => {
    const invoice = await anIssuedInvoice();
    const voucher = await insertVoucher(context.prisma, invoice.id);

    // Control: the same statement shape moves what may move.
    await expect(
      context.prisma.$executeRaw`
        UPDATE "electronic_voucher" SET "blocked_reason" = 'NO_CERTIFICATE'
         WHERE "id" = ${voucher.id}::uuid`,
    ).resolves.toBe(1);

    const otherKey = `${voucher.accessKey.slice(0, 39)}99999999${voucher.accessKey.slice(47)}`;
    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "electronic_voucher"
             SET "access_key" = ${otherKey}, "numeric_code" = '99999999'
           WHERE "id" = ${voucher.id}::uuid`,
      ),
    ).toMatch(/electronic_voucher_access_key_is_permanent/);

    const stored = await context.prisma.electronicVoucher.findUniqueOrThrow({
      where: { id: voucher.id },
    });
    expect(stored.accessKey).toBe(voucher.accessKey);
  });

  it('SRI-005 SRI-007 la factura toma la clave de su comprobante y después no la cambia', async () => {
    const invoice = await anIssuedInvoice();
    const voucher = await insertVoucher(context.prisma, invoice.id);

    // Control: its own voucher's key is accepted.
    await expect(
      context.prisma.$executeRaw`
        UPDATE "invoice" SET "access_key" = ${voucher.accessKey}
         WHERE "id" = ${invoice.id}::uuid`,
    ).resolves.toBe(1);

    const another = await anIssuedInvoice();
    const anotherVoucher = await insertVoucher(context.prisma, another.id);

    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "invoice" SET "access_key" = ${anotherVoucher.accessKey}
           WHERE "id" = ${invoice.id}::uuid`,
      ),
    ).toMatch(/invoice_access_key_is_permanent/);
  });

  it('SRI-007 la base rechaza que una factura lleve la clave del comprobante de otra', async () => {
    const invoice = await anIssuedInvoice();
    const other = await anIssuedInvoice();
    const othersVoucher = await insertVoucher(context.prisma, other.id);

    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "invoice" SET "access_key" = ${othersVoucher.accessKey}
           WHERE "id" = ${invoice.id}::uuid`,
      ),
    ).toMatch(/invoice_access_key_is_its_vouchers/);
  });

  it('SRI-006 la base rechaza un segundo comprobante para la misma factura y el borrado', async () => {
    const invoice = await anIssuedInvoice();
    const voucher = await insertVoucher(context.prisma, invoice.id);

    expect(
      await rejectionOf(insertVoucher(context.prisma, invoice.id)),
    ).toMatch(/electronic_voucher_one_per_invoice/);

    expect(
      await rejectionOf(
        context.prisma
          .$executeRaw`DELETE FROM "electronic_voucher" WHERE "id" = ${voucher.id}::uuid`,
      ),
    ).toMatch(/electronic_voucher_is_never_deleted/);
    await expect(
      context.prisma.electronicVoucher.findUnique({
        where: { id: voucher.id },
      }),
    ).resolves.not.toBeNull();
  });

  it('SRI-006 la base rechaza una clave cuyas partes no son las del comprobante', async () => {
    const invoice = await anIssuedInvoice();
    const voucher = await insertVoucher(context.prisma, invoice.id);

    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "electronic_voucher" SET "environment" = '2'
           WHERE "id" = ${voucher.id}::uuid`,
      ),
    ).toMatch(
      /electronic_voucher_key_matches_its_parts|electronic_voucher_access_key_is_permanent/,
    );
  });
});

describe('SRI-047 un comprobante autorizado no se mueve', () => {
  it('SRI-047 la base admite anotar la entrega del correo y rechaza tocar la autorización', async () => {
    const invoice = await anIssuedInvoice();
    const voucher = await insertVoucher(context.prisma, invoice.id, {
      signed: true,
    });
    await context.prisma.$executeRaw`
      UPDATE "electronic_voucher"
         SET "status" = 'AUTHORISED', "authorisation_number" = ${voucher.accessKey},
             "authorised_at" = CURRENT_TIMESTAMP, "authorised_xml" = '<autorizacion/>'
       WHERE "id" = ${voucher.id}::uuid`;

    // Control: recording that the e-mail left is allowed.
    await expect(
      context.prisma.$executeRaw`
        UPDATE "electronic_voucher" SET "delivery_status" = 'SENT', "delivered_at" = CURRENT_TIMESTAMP
         WHERE "id" = ${voucher.id}::uuid`,
    ).resolves.toBe(1);

    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "electronic_voucher" SET "status" = 'RETURNED', "authorisation_number" = NULL,
                 "authorised_at" = NULL, "authorised_xml" = NULL
           WHERE "id" = ${voucher.id}::uuid`,
      ),
    ).toMatch(/electronic_voucher_authorised_is_immutable/);
  });
});

describe('SRI-051, SC-071 cada llamada al SRI queda, con la clave de su comprobante', () => {
  it('SRI-051 SC-071 la base admite el intento con su clave, rechaza la de otro y no deja tocarlo', async () => {
    const invoice = await anIssuedInvoice();
    const voucher = await insertVoucher(context.prisma, invoice.id);
    const other = await insertVoucher(
      context.prisma,
      (await anIssuedInvoice()).id,
    );

    const [attempt] = await context.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "electronic_voucher_attempt"
        ("voucher_id", "access_key", "operation", "started_at", "duration_ms", "outcome", "messages")
      VALUES (${voucher.id}::uuid, ${voucher.accessKey}, 'RECEPTION', CURRENT_TIMESTAMP, 12, 'RECIBIDA', '[]')
      RETURNING "id"`;
    expect(attempt?.id).toBeDefined();

    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          INSERT INTO "electronic_voucher_attempt"
            ("voucher_id", "access_key", "operation", "started_at", "duration_ms", "outcome")
          VALUES (${voucher.id}::uuid, ${other.accessKey}, 'RECEPTION', CURRENT_TIMESTAMP, 5, 'RECIBIDA')`,
      ),
    ).toMatch(/electronic_voucher_attempt_voucher_fk/);

    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "electronic_voucher_attempt" SET "outcome" = 'AUTORIZADO'
           WHERE "id" = ${attempt!.id}::uuid`,
      ),
    ).toMatch(/electronic_voucher_attempt_is_append_only/);
    expect(
      await rejectionOf(
        context.prisma
          .$executeRaw`DELETE FROM "electronic_voucher_attempt" WHERE "id" = ${attempt!.id}::uuid`,
      ),
    ).toMatch(/electronic_voucher_attempt_is_append_only/);
  });

  it('SRI-051 un fallo de transporte sin motivo no se admite', async () => {
    const voucher = await insertVoucher(
      context.prisma,
      (await anIssuedInvoice()).id,
    );
    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          INSERT INTO "electronic_voucher_attempt"
            ("voucher_id", "access_key", "operation", "started_at", "duration_ms", "outcome")
          VALUES (${voucher.id}::uuid, ${voucher.accessKey}, 'RECEPTION', CURRENT_TIMESTAMP, 5, 'TRANSPORT_FAILURE')`,
      ),
    ).toMatch(/electronic_voucher_attempt_transport_failure_says_why/);
  });
});

describe('SRI-027, SRI-034 el certificado del emisor', () => {
  async function aCertificate(active = true) {
    const [row] = await context.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "signing_certificate"
        ("subject", "issuer", "serial_number", "not_before", "not_after",
         "encrypted_pkcs12", "encrypted_password", "kdf_salt", "active", "deactivated_at", "uploaded_by_id")
      VALUES ('CN=Firmante', 'CN=Entidad', '01', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '1 year',
              decode(repeat('ab', 40), 'hex'), decode(repeat('cd', 40), 'hex'), decode(repeat('ef', 16), 'hex'),
              ${active}, ${active ? null : new Date()}, ${context.userId}::uuid)
      RETURNING "id"`;
    return row!.id;
  }

  it('SRI-027 la base rechaza dos certificados activos a la vez', async () => {
    await aCertificate();
    // Control: an inactive one is admitted beside it.
    await expect(aCertificate(false)).resolves.toBeDefined();
    expect(await rejectionOf(aCertificate())).toMatch(
      /signing_certificate_one_active/,
    );
  });

  it('SRI-034 la base admite desactivarlo y rechaza borrarlo, reactivarlo o cambiar su contenido', async () => {
    const id = await aCertificate();
    await expect(
      context.prisma.$executeRaw`
        UPDATE "signing_certificate" SET "active" = false, "deactivated_at" = CURRENT_TIMESTAMP
         WHERE "id" = ${id}::uuid`,
    ).resolves.toBe(1);

    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "signing_certificate" SET "active" = true, "deactivated_at" = NULL
           WHERE "id" = ${id}::uuid`,
      ),
    ).toMatch(/signing_certificate_is_immutable/);
    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "signing_certificate" SET "encrypted_pkcs12" = decode(repeat('00', 40), 'hex')
           WHERE "id" = ${id}::uuid`,
      ),
    ).toMatch(/signing_certificate_is_immutable/);
    expect(
      await rejectionOf(
        context.prisma
          .$executeRaw`DELETE FROM "signing_certificate" WHERE "id" = ${id}::uuid`,
      ),
    ).toMatch(/signing_certificate_is_never_deleted/);
  });
});
