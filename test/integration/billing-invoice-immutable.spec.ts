import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, inject, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import '../../src/modules/billing/infrastructure/billing.constraints';
import {
  PrismaBillingAccountRepository,
  translateInvoiceRejection,
} from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { Quantity } from '../../src/modules/billing/domain/money';
import { parseClinicalDate } from '../../src/shared/domain/clinic-time';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { authoriseVoucher } from './setup/sri-fixtures';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MOST IMPORTANT TEST OF THIS MODULE: AN AUTHORISED INVOICE DOES NOT MOVE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * D-A-007. The SRI does not allow modifying or deleting an authorised invoice.
 * This system therefore has no «editar factura» — not a screen, not a route,
 * not a service method — and BI-084 demands that the DATABASE refuse the
 * attempt WHEREVER IT COMES FROM.
 *
 * Which is why the attempts below go in by raw SQL, underneath every layer the
 * application has. A test that called a repository method would only prove
 * that the method does not exist, which is BI-090 and a different claim: this
 * one is that the row cannot change even for somebody with a `psql` prompt.
 *
 * The status is moved to AUTHORISED by raw SQL, as the SRI's answer would leave
 * it, so this file does not depend on the queue that talks to the SRI — and
 * the trigger only fires from AUTHORISED or VOIDED, so an ISSUED invoice would
 * prove nothing.
 */
const db = useDatabase();

const SERVICE_CODE = 'CONS-MG-PV';
const SUPPLY_CODE = 'INS-GUANTES-EXAMEN';
const SERVICE_DATE = parseClinicalDate('2026-05-11');

interface Context {
  prisma: PrismaClient;
  accounts: PrismaBillingAccountRepository;
  siteId: string;
  patientId: string;
  payerId: string;
  priceListId: string;
  emissionPointId: string;
  serviceId: string;
  supplyId: string;
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
  await seedBilling(prisma);

  const site = await createSite(prisma);
  const patient = await createPatient(prisma);
  const user = await prisma.user.create({
    data: {
      email: `caja${Date.now()}@clinica.ec`,
      passwordHash: 'not-a-real-hash',
      firstName: 'Rosa',
      lastName: 'Cedeño',
    },
  });

  const payer = await prisma.payer.findUniqueOrThrow({
    where: { code: 'PARTICULAR' },
  });
  const priceList = await prisma.priceList.findFirstOrThrow({
    where: { payerId: payer.id },
  });
  const emissionPoint = await prisma.emissionPoint.create({
    // Three digits, and the leading zero is significant: «001» is not 1.
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
      await prisma.billableService.findUniqueOrThrow({
        where: { code: SERVICE_CODE },
      })
    ).id,
    supplyId: (
      await prisma.billableService.findUniqueOrThrow({
        where: { code: SUPPLY_CODE },
      })
    ).id,
    userId: user.id,
  };
});

/** An account with one 0% consultation and, on request, one 15% supply. */
async function anAccountReadyToInvoice(withSupply = false): Promise<string> {
  const account = await context.prisma.patientAccount.create({
    data: {
      patientId: context.patientId,
      siteId: context.siteId,
      payerId: context.payerId,
      priceListId: context.priceListId,
    },
  });

  const raise = (billableServiceId: string) =>
    context.accounts.addCharge({
      accountId: account.id,
      billableServiceId,
      encounterId: null,
      serviceDate: SERVICE_DATE,
      quantity: Quantity.ONE,
      createdById: context.userId,
      origin: 'MANUAL',
      encounterProcedureId: null,
      serviceOrderItemId: null,
      status: 'BILLABLE',
    });

  await raise(context.serviceId);
  if (withSupply) await raise(context.supplyId);

  return account.id;
}

async function issue(accountId: string) {
  return context.accounts.issueInvoice({
    accountId,
    siteId: context.siteId,
    emissionPointId: context.emissionPointId,
    receiver,
    issuedById: context.userId,
  });
}

/**
 * Moves the invoice to AUTHORISED, which is what arms the trigger. Its key has
 * to be its own voucher's since `invoice_access_key_is_its_vouchers` (SRI-007),
 * so the voucher is written first, as the SRI's answer would leave it.
 */
async function authorise(invoiceId: string): Promise<void> {
  await authoriseVoucher(context.prisma, invoiceId);
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => null).catch((error: unknown) => error);
}

describe('BI-084, BI-090 una factura autorizada no se modifica ni se borra', () => {
  it('BI-084 la base rechaza cambiar el importe de una factura autorizada, por SQL directo', async () => {
    const invoice = await issue(await anAccountReadyToInvoice());
    await authorise(invoice.id);

    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        UPDATE "invoice" SET "total" = '1.00', "updated_at" = CURRENT_TIMESTAMP
         WHERE "id" = ${invoice.id}::uuid`,
    );

    expect(rejection).not.toBeNull();
    expect(String((rejection as Error).message)).toMatch(
      /invoice_authorised_is_immutable/,
    );

    // AND THE ROW DID NOT MOVE. Asserting only that the statement threw would
    // pass even if a later trigger had let a partial write through.
    const stored = await context.prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(stored.total.toFixed(2)).toBe('30.00');
  });

  it('BI-084 la base rechaza cambiar el receptor de una factura autorizada', async () => {
    // The receiver is the half that costs the patient real money: a silent
    // change here would move somebody else's personal-expense rebate.
    const invoice = await issue(await anAccountReadyToInvoice());
    await authorise(invoice.id);

    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        UPDATE "invoice"
           SET "buyer_identification" = '9999999999999',
               "is_final_consumer" = true,
               "updated_at" = CURRENT_TIMESTAMP
         WHERE "id" = ${invoice.id}::uuid`,
    );

    expect(String((rejection as Error).message)).toMatch(
      /invoice_authorised_is_immutable/,
    );
  });

  it('BI-084 la base rechaza el secuencial y el punto de emisión de una factura autorizada', async () => {
    const invoice = await issue(await anAccountReadyToInvoice());
    await authorise(invoice.id);

    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        UPDATE "invoice" SET "sequential" = '000000009', "updated_at" = CURRENT_TIMESTAMP
         WHERE "id" = ${invoice.id}::uuid`,
    );

    expect(String((rejection as Error).message)).toMatch(
      /invoice_authorised_is_immutable/,
    );
  });

  it('BI-084 la base rechaza BORRAR una factura, esté como esté', async () => {
    // `trg_invoice_no_delete` fires on every row, not only the authorised
    // ones: deleting one is never right.
    const invoice = await issue(await anAccountReadyToInvoice());

    const rejection = await rejectionOf(
      context.prisma
        .$executeRaw`DELETE FROM "invoice" WHERE "id" = ${invoice.id}::uuid`,
    );

    expect(String((rejection as Error).message)).toMatch(
      /invoice_is_never_deleted/,
    );
    await expect(
      context.prisma.invoice.findUnique({ where: { id: invoice.id } }),
    ).resolves.not.toBeNull();
  });

  it('BI-084 admite el paso a anulada y no la devuelve de ahí', async () => {
    // The ONE exception to immutability is the transition to VOIDED (BI-092),
    // and nothing else: a voided invoice keeps saying what it said.
    const invoice = await issue(await anAccountReadyToInvoice());
    await authorise(invoice.id);

    await expect(
      context.prisma.$executeRaw`
        UPDATE "invoice" SET "status" = 'VOIDED', "updated_at" = CURRENT_TIMESTAMP
         WHERE "id" = ${invoice.id}::uuid`,
    ).resolves.toBe(1);

    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        UPDATE "invoice" SET "status" = 'ISSUED', "updated_at" = CURRENT_TIMESTAMP
         WHERE "id" = ${invoice.id}::uuid`,
    );

    expect(String((rejection as Error).message)).toMatch(
      /invoice_voided_is_final/,
    );
  });

  it('BI-084 traduce el rechazo del disparador a un 409 que nombra la nota de crédito', async () => {
    // The triggers raise from PL/pgSQL, so no constraint NAME travels and
    // `database-problem.ts` can only offer a generic answer. Reaching the
    // cashier as a 500 would send somebody looking for an «editar factura»
    // button that does not exist and never will.
    const invoice = await issue(await anAccountReadyToInvoice());
    await authorise(invoice.id);

    const rejection = await rejectionOf(
      context.prisma.$executeRaw`
        UPDATE "invoice" SET "total" = '1.00', "updated_at" = CURRENT_TIMESTAMP
         WHERE "id" = ${invoice.id}::uuid`,
    );

    const translated = translateInvoiceRejection(rejection) as {
      code: string;
      userTitle: string;
    };

    expect(translated.code).toBe('INVOICE_IMMUTABLE');
    expect(translated.userTitle).toMatch(/nota de crédito/);
  });
});

describe('BI-085 el secuencial por punto de emisión', () => {
  it('BI-085 numera desde 000000001 y sigue consecutivo, con los nueve dígitos', async () => {
    const first = await issue(await anAccountReadyToInvoice());
    const second = await issue(await anAccountReadyToInvoice());

    expect(first.sequential).toBe('000000001');
    expect(second.sequential).toBe('000000002');
  });

  it('BI-085 da secuenciales distintos y consecutivos a dos cajeras que facturan a la vez', async () => {
    // SC-023, and the gap only appears under concurrency. TWO REAL CLIENTS:
    // `max(sequential) + 1` read outside a lock is the same number twice, and
    // the second would die on `invoice_sequential_unique` — a failed invoice,
    // which is worse than waiting a few milliseconds.
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
          new PrismaBillingAccountRepository(
            client as unknown as PrismaService,
          ).issueInvoice({
            accountId: index === 0 ? one : other,
            siteId: context.siteId,
            emissionPointId: context.emissionPointId,
            receiver,
            issuedById: context.userId,
          }),
        ),
      );

      const sequentials = results.map((invoice) => invoice.sequential).sort();
      expect(sequentials).toEqual(['000000001', '000000002']);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it('BI-085 la base rechaza repetir un secuencial en el mismo punto de emisión', async () => {
    const invoice = await issue(await anAccountReadyToInvoice());

    const rejection = await rejectionOf(
      context.prisma.invoice.create({
        data: {
          accountId: invoice.accountId,
          siteId: context.siteId,
          emissionPointId: context.emissionPointId,
          sequential: invoice.sequential,
          buyerIdentificationType: '05',
          buyerIdentification: '1710034065',
          buyerName: 'Otro',
          subtotalTaxed: '0.00',
          subtotalUntaxed: '0.00',
          taxTotal: '0.00',
          total: '0.00',
          issuedById: context.userId,
        },
      }),
    );

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'INVOICE_SEQUENTIAL_TAKEN',
    );
  });
});

describe('BI-083, BI-086, BI-088, BI-089 lo que la factura copia y lo que rechaza', () => {
  it('BI-083, BI-086 compone los totales desde las columnas congeladas, con IVA por ítem', async () => {
    // A 0% consultation and a 15% supply: this invoice HAS NO single rate, and
    // a total computed with one is wrong in both directions.
    const invoice = await issue(await anAccountReadyToInvoice(true));

    const supplyPrice = await context.prisma.price.findFirstOrThrow({
      where: {
        priceListId: context.priceListId,
        billableServiceId: context.supplyId,
      },
    });

    const taxed = supplyPrice.amount;
    expect(invoice.totals.subtotalUntaxed.toString()).toBe('30.00');
    expect(invoice.totals.subtotalTaxed.toString()).toBe(taxed.toFixed(2));
    expect(invoice.totals.taxTotal.isZero()).toBe(false);
  });

  it('BI-086 no vuelve a leer el tarifario: la factura no cambia si el precio sube después', async () => {
    const accountId = await anAccountReadyToInvoice();
    const invoice = await issue(accountId);

    // The tariff is raised UNDERNEATH the application, which is the only way
    // to show that nothing re-reads it.
    await context.prisma.$executeRaw`
      UPDATE "price" SET "amount" = '999.00', "updated_at" = CURRENT_TIMESTAMP
       WHERE "price_list_id" = ${context.priceListId}::uuid
         AND "billable_service_id" = ${context.serviceId}::uuid`;

    const stored = await context.prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });
    expect(stored.total.toFixed(2)).toBe('30.00');
  });

  it('BI-088 marca los cargos como facturados y no los deja caer en una segunda factura', async () => {
    const accountId = await anAccountReadyToInvoice();
    await issue(accountId);

    const charges = await context.prisma.chargeItem.findMany({
      where: { accountId },
    });
    expect(charges.every((charge) => charge.status === 'BILLED')).toBe(true);

    // The same account invoiced twice finds nothing left to bill.
    const rejection = await rejectionOf(issue(accountId));
    expect((rejection as { code: string }).code).toBe('INVOICE_HAS_NO_ITEMS');
  });

  it('BI-089 se niega a emitir una factura sin ninguna línea', async () => {
    const account = await context.prisma.patientAccount.create({
      data: {
        patientId: context.patientId,
        siteId: context.siteId,
        payerId: context.payerId,
        priceListId: context.priceListId,
      },
    });

    const rejection = await rejectionOf(issue(account.id));
    expect((rejection as { code: string }).code).toBe('INVOICE_HAS_NO_ITEMS');

    // AND NO SEQUENTIAL WAS BURNED on a document that never existed.
    await expect(context.prisma.invoice.count()).resolves.toBe(0);
  });

  it('BI-001 cuadra los totales o la base lo rechaza', async () => {
    // `invoice_total_is_consistent`. If the arithmetic ever disagreed with the
    // columns, the right outcome is that NO invoice exists: a document the SRI
    // rejects could never be corrected afterwards.
    const rejection = await rejectionOf(
      context.prisma.invoice.create({
        data: {
          accountId: await anAccountReadyToInvoice(),
          siteId: context.siteId,
          emissionPointId: context.emissionPointId,
          sequential: '000000900',
          buyerIdentificationType: '05',
          buyerIdentification: '1710034065',
          buyerName: 'Guamán Andrade, María José',
          subtotalTaxed: '20.00',
          subtotalUntaxed: '30.00',
          taxTotal: '3.00',
          discountTotal: '0.00',
          // 53.00 is the truth; 52.99 is the cent nobody can explain.
          total: '52.99',
          issuedById: context.userId,
        },
      }),
    );

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'INVOICE_TOTAL_INCONSISTENT',
    );
  });
});

describe('BI-081 «Consumidor Final» lleva la identificación del SRI o no existe', () => {
  it('BI-081 la base rechaza marcarla como Consumidor Final con otra identificación', async () => {
    // `invoice_final_consumer_identification`. The flag and the placeholder
    // travel together, so a row that claims the exception without stating it
    // cannot exist — not even written by an import.
    const rejection = await rejectionOf(
      context.prisma.invoice.create({
        data: {
          accountId: await anAccountReadyToInvoice(),
          siteId: context.siteId,
          emissionPointId: context.emissionPointId,
          sequential: '000000901',
          buyerIdentificationType: '07',
          buyerIdentification: '1710034065',
          buyerName: 'CONSUMIDOR FINAL',
          isFinalConsumer: true,
          subtotalTaxed: '0.00',
          subtotalUntaxed: '30.00',
          taxTotal: '0.00',
          total: '30.00',
          issuedById: context.userId,
        },
      }),
    );

    expect(extractDatabaseProblem(rejection)?.code).toBe(
      'FINAL_CONSUMER_IDENTIFICATION_REQUIRED',
    );
  });

  it('BI-081 emite a Consumidor Final con 9999999999999 cuando alguien lo elige', async () => {
    const invoice = await context.accounts.issueInvoice({
      accountId: await anAccountReadyToInvoice(),
      siteId: context.siteId,
      emissionPointId: context.emissionPointId,
      receiver: {
        buyerIdentificationType: '07',
        buyerIdentification: '9999999999999',
        buyerName: 'CONSUMIDOR FINAL',
        buyerEmail: null,
        isFinalConsumer: true,
      },
      issuedById: context.userId,
    });

    expect(invoice.receiver.isFinalConsumer).toBe(true);
    expect(invoice.receiver.buyerIdentification).toBe('9999999999999');
  });
});

describe('BI-159 la base rechaza un RUC o una cédula de receptor que el SRI no acepta', () => {
  /**
   * Straight through the repository, UNDER `resolveReceiver`: what is proved
   * here is what an import or a script that skips the value objects is told.
   * The rule is the whole of `Ruc` and `Cedula`, not only the shape: the
   * cedula check is `is_valid_cedula()`, the one `patient_identifier` uses.
   * Each group of rejections has its controls beside it, through the same
   * insert, so a CHECK that refused every `04` would fail.
   */
  const issueTo = async (
    buyerIdentificationType: '04' | '05' | '06' | '08',
    buyerIdentification: string,
  ) =>
    context.accounts.issueInvoice({
      accountId: await anAccountReadyToInvoice(),
      siteId: context.siteId,
      emissionPointId: context.emissionPointId,
      receiver: { ...receiver, buyerIdentificationType, buyerIdentification },
      issuedById: context.userId,
    });

  it.each([
    ['sin establecimiento (000)', '1790012345000'],
    ['de doce dígitos', '179001234500'],
    ['con letras', '17900123450O1'],
    ['de una provincia que no existe', '2590000000001'],
    ['de tercer dígito 7, que no es de nadie', '1770012345001'],
    ['de persona natural con verificador equivocado', '1710034066001'],
  ])('BI-159 rechaza un RUC %s (invoice_buyer_ruc_valid)', async (_, ruc) => {
    const rejection = await rejectionOf(issueTo('04', ruc));

    expect(extractDatabaseProblem(rejection)).toMatchObject({
      code: 'INVALID_RUC',
    });
    expect(String((rejection as Error).message)).toMatch(
      /invoice_buyer_ruc_valid/,
    );
  });

  it.each([
    ['sociedad privada con la numeración de 2021', '1793189906001'],
    ['entidad del sector público', '1760013210001'],
    ['persona natural', '1710034065001'],
    ['persona inscrita en el exterior (provincia 30)', '3001234560001'],
  ])('BI-159 admite el RUC de una %s (control positivo)', async (_, ruc) => {
    const invoice = await issueTo('04', ruc);
    expect(invoice.receiver.buyerIdentification).toBe(ruc);
  });

  it.each([
    ['de nueve dígitos', '171003406'],
    ['de trece dígitos', '1710034065001'],
    ['con verificador equivocado', '1710034066'],
    ['de tercer dígito 6, que es de un RUC', '1760013210'],
  ])(
    'BI-159 rechaza una cédula %s (invoice_buyer_cedula_valid)',
    async (_, cedula) => {
      const rejection = await rejectionOf(issueTo('05', cedula));

      expect(extractDatabaseProblem(rejection)).toMatchObject({
        code: 'INVALID_CEDULA',
      });
      expect(String((rejection as Error).message)).toMatch(
        /invoice_buyer_cedula_valid/,
      );
    },
  );

  it.each([
    ['de Pichincha', '1710034065'],
    ['de la provincia 30', '3001234560'],
  ])('BI-159 admite la cédula %s (control positivo)', async (_, cedula) => {
    const invoice = await issueTo('05', cedula);
    expect(invoice.receiver.buyerIdentification).toBe(cedula);
  });

  it.each([
    ['06', 'AB123456'],
    ['08', '1710034066'],
  ] as const)(
    'BI-159 no alcanza al documento %s, que emite otro país',
    async (type, identification) => {
      // `08` with a number that is NOT a valid Ecuadorian cedula: a CHECK
      // written against the wrong type would refuse it.
      const invoice = await issueTo(type, identification);
      expect(invoice.receiver.buyerIdentification).toBe(identification);
    },
  );
});
