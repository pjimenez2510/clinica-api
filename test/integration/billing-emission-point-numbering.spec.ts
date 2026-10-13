import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, inject, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { seedSpecialties } from '../../prisma/seed-specialties.mts';
import '../../src/modules/billing/infrastructure/billing.constraints';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { PrismaCreditNoteRepository } from '../../src/modules/billing/infrastructure/prisma-credit-note.repository';
import { Quantity } from '../../src/modules/billing/domain/money';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { authoriseVoucher, insertVoucher } from './setup/sri-fixtures';

/**
 * BI-306 to BI-308, SRI-111. The «próximo número» and the renumbering, AS THE
 * DATABASE KEEPS THEM. Every refusal goes in by raw SQL, underneath the
 * application, and every one has its positive control through the same path.
 */
const db = useDatabase();

const SERVICE_CODE = 'CONS-MG-PV';

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

const receiver = {
  buyerIdentificationType: '05' as const,
  buyerIdentification: '1710034065',
  buyerName: 'Guamán Andrade, María José',
  buyerEmail: null,
  isFinalConsumer: false,
};

beforeEach(async () => {
  const prisma = db();
  await seedSpecialties(prisma);
  await seedBilling(prisma);

  const site = await createSite(prisma);
  const patient = await createPatient(prisma);
  const user = await prisma.user.create({
    data: {
      email: `admin${Date.now()}@clinica.ec`,
      passwordHash: 'not-a-real-hash',
      firstName: 'Lucía',
      lastName: 'Paredes',
    },
  });
  const payer = await prisma.payer.findUniqueOrThrow({
    where: { code: 'PARTICULAR' },
  });
  const priceList = await prisma.priceList.findFirstOrThrow({
    where: { payerId: payer.id },
  });
  const emissionPoint = await prisma.emissionPoint.create({
    data: { siteId: site.id, code: '001', description: 'Caja principal' },
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
    serviceId: (
      await prisma.service.findUniqueOrThrow({ where: { code: SERVICE_CODE } })
    ).id,
    userId: user.id,
  };
});

async function anAccountReadyToInvoice(): Promise<string> {
  const account = await context.prisma.patientAccount.create({
    data: {
      patientId: context.patientId,
      siteId: context.siteId,
      payerId: context.payerId,
      priceListId: context.priceListId,
    },
  });
  await context.accounts.addCharge({
    accountId: account.id,
    serviceId: context.serviceId,
    encounterId: null,
    serviceDate: clinicalDateOf(new Date()),
    quantity: Quantity.ONE,
    createdById: context.userId,
    origin: 'MANUAL',
    encounterProcedureId: null,
    serviceOrderItemId: null,
    status: 'BILLABLE',
  });
  return account.id;
}

function issueWith(
  repository: PrismaBillingAccountRepository,
  accountId: string,
) {
  return repository.issueInvoice({
    accountId,
    siteId: context.siteId,
    emissionPointId: context.emissionPointId,
    paymentMethod: '01',
    receiver,
    issuedById: context.userId,
    trail: { userId: context.userId },
  });
}

async function issue() {
  return issueWith(context.accounts, await anAccountReadyToInvoice());
}

/** BI-306 by raw SQL: what an administrator's save writes. */
function fixNext(next: number | null, documentType = '01') {
  return context.prisma.$executeRaw`
    INSERT INTO "emission_point_numbering"
      ("emission_point_id", "document_type", "next_sequential", "reason",
       "changed_by", "changed_at")
    VALUES (${context.emissionPointId}::uuid, ${documentType}, ${next},
            'Migración desde el sistema anterior', ${context.userId}::uuid,
            CURRENT_TIMESTAMP)
    ON CONFLICT ("emission_point_id", "document_type") DO UPDATE
       SET "next_sequential" = EXCLUDED."next_sequential",
           "reason" = EXCLUDED."reason",
           "changed_by" = EXCLUDED."changed_by",
           "changed_at" = EXCLUDED."changed_at"`;
}

/** An issued invoice the SRI authorised, and the charges it billed. */
async function anAuthorisedInvoice() {
  const invoice = await issue();
  await authoriseVoucher(context.prisma, invoice.id);
  const charges = await context.prisma.chargeItem.findMany({
    where: { invoiceId: invoice.id },
    select: { id: true },
  });
  return { invoiceId: invoice.id, chargeIds: charges.map((c) => c.id) };
}

async function rejectionOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (error: unknown) => String((error as Error).message),
  );
}

describe('BI-307 el próximo número nunca queda por debajo del usado', () => {
  it('BI-307 la base rechaza un próximo número que no supera el mayor usado, y admite el usado más uno', async () => {
    await issue();
    await issue(); // 000000002 used

    expect(await rejectionOf(fixNext(2))).toMatch(
      /emission_point_numbering_not_below_used/,
    );
    expect(await rejectionOf(fixNext(1))).toMatch(
      /emission_point_numbering_not_below_used/,
    );
    // Positive control, the same statement: one above the largest used.
    expect(await rejectionOf(fixNext(3))).toBeNull();
    const stored = await context.prisma.emissionPointNumbering.findFirstOrThrow(
      {
        where: { emissionPointId: context.emissionPointId, documentType: '01' },
      },
    );
    expect(stored.nextSequential).toBe(3);
  });

  it('BI-307 cuenta lo usado por tipo: las notas de crédito no limitan el número de la factura', async () => {
    await issue();
    // No credit note was issued on this point: 1 is a valid next for `04`.
    expect(await rejectionOf(fixNext(1, '04'))).toBeNull();
    expect(await rejectionOf(fixNext(1, '01'))).toMatch(
      /emission_point_numbering_not_below_used/,
    );
  });

  it('BI-307 un próximo número ya superado no impide cambiar el resto de la fila, y moverlo sí se vuelve a juzgar', async () => {
    await fixNext(2);
    await issue();
    await issue(); // 2 and 3 used: the floor 2 is overtaken

    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "emission_point_numbering"
             SET "previous_system_last" = 150, "reason" = 'Lo del sistema anterior',
                 "changed_at" = ${new Date()}
           WHERE "emission_point_id" = ${context.emissionPointId}::uuid`,
      ),
    ).toBeNull();
    // Control: moving it to another number at or below the used is judged.
    expect(await rejectionOf(fixNext(3))).toMatch(
      /emission_point_numbering_not_below_used/,
    );
  });

  it('BI-085 la base rechaza un secuencial que no tiene sus nueve dígitos', async () => {
    const invoice = await issue();
    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          INSERT INTO "invoice" ("account_id", "site_id", "emission_point_id",
            "sequential", "buyer_identification_type", "buyer_identification",
            "buyer_name", "subtotal_taxed", "subtotal_untaxed", "tax_total",
            "total", "issued_by_id", "updated_at")
          VALUES (${invoice.accountId}::uuid, ${context.siteId}::uuid,
            ${context.emissionPointId}::uuid, '20', '05', '1710034065', 'Otro',
            0, 0, 0, 0, ${context.userId}::uuid, ${new Date()})`,
      ),
    ).toMatch(/invoice_sequential_has_nine_digits/);
  });

  it('BI-306 guarda la fila anterior en record_version al cambiar el próximo número', async () => {
    await fixNext(100);
    await fixNext(200);

    const versions = await context.prisma.$queryRaw<
      { next: number }[]
    >`SELECT ("data" ->> 'next_sequential')::int AS "next"
        FROM "record_version" WHERE "resource_type" = 'emission_point_numbering'`;
    expect(versions.map((row) => row.next)).toEqual([100]);
  });

  it('BI-306 la base no borra una numeración', async () => {
    await fixNext(100);
    expect(
      await rejectionOf(
        context.prisma.$executeRaw`DELETE FROM "emission_point_numbering"`,
      ),
    ).toMatch(/emission_point_numbering_is_kept/);
  });
});

describe('BI-308 la factura sale con el próximo número', () => {
  it('BI-308 sin número fijado sigue el usado más uno; fijado, sale con él y la siguiente sigue', async () => {
    const first = await issue();
    expect(first.sequential).toBe('000000001');

    await fixNext(100);
    const second = await issue();
    const third = await issue();

    expect(second.sequential).toBe('000000100');
    expect(third.sequential).toBe('000000101');
  });

  it('BI-085 conserva los nueve dígitos y se niega a seguir cuando el punto se agota', async () => {
    await fixNext(999999999);
    expect((await issue()).sequential).toBe('999999999');

    // Truncating silently would collide with the number issued a billion
    // documents ago, and the SRI would receive two vouchers under one key.
    expect(await rejectionOf(issue())).toMatch(
      /emission_point_sequential_exhausted/,
    );
  });

  it('BI-308 dos emisiones a la vez con el número fijado no comparten número', async () => {
    await fixNext(50);
    const one = await anAccountReadyToInvoice();
    const other = await anAccountReadyToInvoice();

    const url = inject('databaseUrl');
    const clients = [
      new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }),
      new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }),
    ];
    try {
      const results = await Promise.all(
        clients.map((client, index) =>
          issueWith(
            new PrismaBillingAccountRepository(
              client as unknown as PrismaService,
            ),
            index === 0 ? one : other,
          ),
        ),
      );
      expect(results.map((invoice) => invoice.sequential).sort()).toEqual([
        '000000050',
        '000000051',
      ]);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it('BI-308 dos notas de crédito a la vez en el mismo punto toman su propia serie, desde el número fijado, sin compartirlo', async () => {
    await issue(); // invoices do not move the credit notes' series
    await fixNext(7, '04');
    const one = await anAuthorisedInvoice();
    const other = await anAuthorisedInvoice();

    const url = inject('databaseUrl');
    const clients = [
      new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }),
      new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }),
    ];
    try {
      const notes = await Promise.all(
        clients.map((client, index) =>
          new PrismaCreditNoteRepository(
            client as unknown as PrismaService,
          ).issue({
            invoiceId: (index === 0 ? one : other).invoiceId,
            siteId: context.siteId,
            chargeIds: (index === 0 ? one : other).chargeIds,
            reasonCode: 'RECEIVER_DATA',
            reason: 'Error en los datos del receptor',
            rebill: false,
            issuedById: context.userId,
            now: new Date(),
            trail: { userId: context.userId },
          }),
        ),
      );
      const sequentials = await context.prisma.creditNote.findMany({
        where: { id: { in: notes.map((note) => note.creditNote.id) } },
        select: { sequential: true },
      });
      expect(sequentials.map((note) => note.sequential).sort()).toEqual([
        '000000007',
        '000000008',
      ]);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });
});

/** An invoice the SRI returned with the 45: its voucher RETURNED, it REJECTED. */
async function aReturnedInvoice() {
  const invoice = await issue();
  const voucher = await insertVoucher(context.prisma, invoice.id, {
    signed: true,
  });
  await context.prisma.$executeRaw`
    UPDATE "electronic_voucher" SET "status" = 'RETURNED'
     WHERE "id" = ${voucher.id}::uuid`;
  await context.prisma.$executeRaw`
    UPDATE "invoice" SET "status" = 'REJECTED', "access_key" = ${voucher.accessKey}
     WHERE "id" = ${invoice.id}::uuid`;
  return { invoice, voucher };
}

function recordRenumbering(
  returned: Awaited<ReturnType<typeof aReturnedInvoice>>,
  newSequential: string,
) {
  return context.prisma.$executeRaw`
    INSERT INTO "voucher_renumbering"
      ("superseded_voucher_id", "previous_access_key", "invoice_id",
       "emission_point_id", "previous_sequential", "new_sequential",
       "sri_message", "renumbered_by", "renumbered_at")
    VALUES (${returned.voucher.id}::uuid, ${returned.voucher.accessKey},
            ${returned.invoice.id}::uuid, ${context.emissionPointId}::uuid,
            ${returned.invoice.sequential}, ${newSequential},
            '45 · ERROR SECUENCIAL REGISTRADO', ${context.userId}::uuid,
            CURRENT_TIMESTAMP)`;
}

function renumberInvoice(invoiceId: string, sequential: string) {
  return context.prisma.$executeRaw`
    UPDATE "invoice"
       SET "sequential" = ${sequential}, "access_key" = NULL, "status" = 'ISSUED'
     WHERE "id" = ${invoiceId}::uuid`;
}

function supersede(voucherId: string) {
  return context.prisma.$executeRaw`
    UPDATE "electronic_voucher"
       SET "status" = 'SUPERSEDED', "invoice_id" = NULL
     WHERE "id" = ${voucherId}::uuid`;
}

describe('SRI-111 el número y la clave cambian sólo con su renumeración', () => {
  it('SRI-111 la base rechaza cambiar el secuencial o la clave de una factura sin su fila, y con ella lo admite', async () => {
    const returned = await aReturnedInvoice();

    expect(
      await rejectionOf(renumberInvoice(returned.invoice.id, '000000002')),
    ).toMatch(/invoice_(number|access_key)_is_permanent/);
    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "invoice" SET "access_key" = NULL
           WHERE "id" = ${returned.invoice.id}::uuid`,
      ),
    ).toMatch(/invoice_access_key_is_permanent/);

    // Positive control: the same update, once the renumbering names it.
    await recordRenumbering(returned, '000000002');
    expect(
      await rejectionOf(renumberInvoice(returned.invoice.id, '000000002')),
    ).toBeNull();
    expect(await rejectionOf(supersede(returned.voucher.id))).toBeNull();

    const voucher = await context.prisma.electronicVoucher.findUniqueOrThrow({
      where: { id: returned.voucher.id },
    });
    expect(voucher).toMatchObject({ status: 'SUPERSEDED', invoiceId: null });
  });

  it('SRI-111 la fila no sirve para otro número que el que nombra', async () => {
    const returned = await aReturnedInvoice();
    await recordRenumbering(returned, '000000002');

    expect(
      await rejectionOf(renumberInvoice(returned.invoice.id, '000000003')),
    ).toMatch(/invoice_(number|access_key)_is_permanent/);
  });

  it('SRI-111 la base rechaza reemplazar un comprobante sin renumeración, y uno autorizado aunque la tenga', async () => {
    const returned = await aReturnedInvoice();
    expect(await rejectionOf(supersede(returned.voucher.id))).toMatch(
      /electronic_voucher_superseded_only_renumbered/,
    );

    // A voucher that has an authorisation number never becomes SUPERSEDED.
    await recordRenumbering(returned, '000000002');
    await renumberInvoice(returned.invoice.id, '000000002');
    await context.prisma.$executeRaw`
      UPDATE "electronic_voucher" SET "authorisation_number" = ${returned.voucher.accessKey}
       WHERE "id" = ${returned.voucher.id}::uuid`;
    expect(await rejectionOf(supersede(returned.voucher.id))).toMatch(
      /electronic_voucher_superseded_only_renumbered/,
    );
  });

  it('SRI-111 un comprobante reemplazado no vuelve a cambiar, y la renumeración no se edita ni se borra', async () => {
    const returned = await aReturnedInvoice();
    await recordRenumbering(returned, '000000002');
    await renumberInvoice(returned.invoice.id, '000000002');
    await supersede(returned.voucher.id);

    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "electronic_voucher" SET "status" = 'PREPARED'
           WHERE "id" = ${returned.voucher.id}::uuid`,
      ),
    ).toMatch(/electronic_voucher_superseded_is_final/);
    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "voucher_renumbering" SET "new_sequential" = '000000009'`,
      ),
    ).toMatch(/voucher_renumbering_append_only/);
    expect(
      await rejectionOf(
        context.prisma.$executeRaw`DELETE FROM "voucher_renumbering"`,
      ),
    ).toMatch(/voucher_renumbering_append_only/);
  });

  it('SRI-111 la base no admite una renumeración de un comprobante no devuelto, ni hacia un número por debajo del siguiente libre', async () => {
    const returned = await aReturnedInvoice();
    await fixNext(10);

    // Below the next free number: into a hole the SRI may already hold.
    expect(await rejectionOf(recordRenumbering(returned, '000000005'))).toMatch(
      /voucher_renumbering_is_due/,
    );

    const refused = await aReturnedInvoice();
    await context.prisma.$executeRaw`
      UPDATE "electronic_voucher" SET "status" = 'NOT_AUTHORISED'
       WHERE "id" = ${refused.voucher.id}::uuid`;
    expect(await rejectionOf(recordRenumbering(refused, '000000010'))).toMatch(
      /voucher_renumbering_is_due/,
    );

    // Positive control: the next free number, for the returned one.
    expect(
      await rejectionOf(recordRenumbering(returned, '000000010')),
    ).toBeNull();
  });

  it('SRI-111 un comprobante no nace reemplazado', async () => {
    const invoice = await issue();
    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          INSERT INTO "electronic_voucher" ("site_id", "access_key",
            "numeric_code", "environment", "schema_version", "status",
            "unsigned_xml", "document_type")
          VALUES (${context.siteId}::uuid, ${'1'.repeat(49)}, '00000001', '1',
            '1.1.0', 'SUPERSEDED', '<factura/>', '01')`,
      ),
    ).toMatch(/electronic_voucher_superseded_only_renumbered/);
    // Control: the invoice's own voucher is born as always.
    await insertVoucher(context.prisma, invoice.id);
  });

  it('SRI-111 una factura emitida tampoco cambia de número por SQL', async () => {
    // Before this delivery only an AUTHORISED invoice froze its sequential.
    const invoice = await issue();
    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "invoice" SET "sequential" = '000000042'
           WHERE "id" = ${invoice.id}::uuid`,
      ),
    ).toMatch(/invoice_number_is_permanent/);
    // Positive control: the same row still takes an unrelated change.
    expect(
      await rejectionOf(
        context.prisma.$executeRaw`
          UPDATE "invoice" SET "updated_at" = CURRENT_TIMESTAMP
           WHERE "id" = ${invoice.id}::uuid`,
      ),
    ).toBeNull();
  });
});
