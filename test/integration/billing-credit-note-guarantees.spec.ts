import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { Quantity } from '../../src/modules/billing/domain/money';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { composeAccessKey } from '../../src/modules/sri/domain/access-key';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import {
  authoriseVoucher,
  insertVoucher,
  TEST_ISSUER_RUC,
} from './setup/sri-fixtures';

/**
 * billing/B14 and sri/S7: what the DATABASE guarantees about correcting an
 * invoice — the credit note that never changes, the line credited once, the
 * copy billed once, the voucher of one document, the account and the returned
 * invoice that keep their previous version.
 *
 * Every attempt goes in by raw SQL, underneath every layer, and each one has
 * its positive control: the same statement shape with what the guarantee
 * admits goes through. A refusal alone would also pass with a typo.
 */
const db = useDatabase();

const CONSULTATION = 'CONS-MG-PV';

interface Scene {
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

let scene: Scene;

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
  scene = {
    prisma,
    accounts: new PrismaBillingAccountRepository(
      prisma as unknown as PrismaService,
    ),
    siteId: site.id,
    patientId: patient.id,
    payerId: payer.id,
    priceListId: (
      await prisma.priceList.findFirstOrThrow({ where: { payerId: payer.id } })
    ).id,
    emissionPointId: (
      await prisma.emissionPoint.create({
        data: { siteId: site.id, code: '001', description: 'Caja principal' },
      })
    ).id,
    serviceId: (
      await prisma.billableService.findUniqueOrThrow({
        where: { code: CONSULTATION },
      })
    ).id,
    userId: user.id,
  };
});

async function anAccount(): Promise<string> {
  const account = await scene.prisma.patientAccount.create({
    data: {
      patientId: scene.patientId,
      siteId: scene.siteId,
      payerId: scene.payerId,
      priceListId: scene.priceListId,
    },
  });
  return account.id;
}

async function aCharge(accountId: string): Promise<string> {
  const charge = await scene.accounts.addCharge({
    accountId,
    billableServiceId: scene.serviceId,
    encounterId: null,
    // The clinic's today, from the clock: no date is written by hand.
    serviceDate: clinicalDateOf(new Date()),
    quantity: Quantity.ONE,
    createdById: scene.userId,
    origin: 'MANUAL',
    encounterProcedureId: null,
    serviceOrderItemId: null,
    status: 'BILLABLE',
  });
  return charge.id;
}

/** An invoice of two consultations, issued; authorised on request. */
async function anInvoice(
  options: { authorised?: boolean; finalConsumer?: boolean } = {},
) {
  const accountId = await anAccount();
  const charges = [await aCharge(accountId), await aCharge(accountId)];
  const invoice = await scene.accounts.issueInvoice({
    accountId,
    siteId: scene.siteId,
    emissionPointId: scene.emissionPointId,
    paymentMethod: '01',
    receiver: options.finalConsumer
      ? {
          buyerIdentificationType: '07',
          buyerIdentification: '9999999999999',
          buyerName: 'CONSUMIDOR FINAL',
          buyerEmail: null,
          isFinalConsumer: true,
        }
      : {
          buyerIdentificationType: '05',
          buyerIdentification: '1710034065',
          buyerName: 'Guamán Andrade, María José',
          buyerEmail: null,
          isFinalConsumer: false,
        },
    issuedById: scene.userId,
  });
  if (options.authorised !== false) {
    await authoriseVoucher(scene.prisma, invoice.id);
  }
  return { accountId, charges, invoiceId: invoice.id };
}

let sequence = 0;

/**
 * A credit note written by raw SQL, its header and its lines in ONE
 * transaction — the deferred check of BI-095 looks at the end of it. Each line
 * credits a $30.00 consultation at 0 %, which is what the seed prices.
 */
async function insertCreditNote(
  invoiceId: string,
  chargeIds: readonly string[],
  options: {
    /** The header's total, when it must NOT be the sum of the lines. */
    amount?: string;
    /** What each line says it credits; the header sums them. */
    lineNet?: string;
    reason?: string;
    reasonCode?: string;
  } = {},
): Promise<string> {
  sequence += 1;
  const lineNet = options.lineNet ?? '30.00';
  const net = (Number(lineNet) * chargeIds.length).toFixed(2);
  const amount = options.amount ?? net;
  return scene.prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "credit_note"
        ("invoice_id", "site_id", "emission_point_id", "sequential",
         "reason_code", "reason",
         "buyer_identification_type", "buyer_identification", "buyer_name",
         "subtotal_taxed", "subtotal_untaxed", "discount_total", "tax_total",
         "amount", "status", "issued_by_id", "issued_at", "updated_at")
      VALUES (${invoiceId}::uuid, ${scene.siteId}::uuid,
              ${scene.emissionPointId}::uuid, ${String(sequence).padStart(9, '0')},
              ${options.reasonCode ?? 'RECEIVER_DATA'},
              ${options.reason ?? 'Error en los datos del receptor'},
              '05', '1710034065', 'Guamán Andrade, María José',
              0, ${amount}::numeric, 0, 0, ${amount}::numeric,
              'ISSUED', ${scene.userId}::uuid, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING "id"`;
    for (const chargeId of chargeIds) {
      await tx.$executeRaw`
        INSERT INTO "credit_note_line"
          ("credit_note_id", "charge_item_id", "service_code", "description",
           "quantity", "unit_amount", "discount_amount", "tax_sri_code",
           "tax_percentage", "net_amount", "tax_amount")
        VALUES (${row!.id}::uuid, ${chargeId}::uuid, ${CONSULTATION},
                'Consulta', 1, ${lineNet}::numeric, 0, '0', 0,
                ${lineNet}::numeric, 0)`;
    }
    return row!.id;
  });
}

/**
 * As the SRI's answer leaves a credit note: its voucher (`04`) and the note
 * AUTHORISED with that key. The voucher stays PREPARED: what matters here is
 * the note's status, which is what the guarantees read.
 */
async function authoriseCreditNote(creditNoteId: string): Promise<void> {
  sequence += 1;
  const numericCode = String(80_000_000 + sequence);
  const accessKey = composeAccessKey({
    issuedOn: clinicalDateOf(new Date()),
    documentType: '04',
    ruc: TEST_ISSUER_RUC,
    environment: '1',
    establishmentCode: '001',
    emissionPointCode: '001',
    sequential: String(sequence).padStart(9, '0'),
    numericCode,
  });
  await scene.prisma.$executeRaw`
    INSERT INTO "electronic_voucher"
      ("credit_note_id", "site_id", "document_type", "access_key",
       "numeric_code", "environment", "schema_version", "status", "unsigned_xml")
    VALUES (${creditNoteId}::uuid, ${scene.siteId}::uuid, '04', ${accessKey},
            ${numericCode}, '1', '1.1.0', 'PREPARED', '<notaCredito id="comprobante"/>')`;
  await scene.prisma.$executeRaw`
    UPDATE "credit_note" SET "access_key" = ${accessKey}, "status" = 'AUTHORISED'
     WHERE "id" = ${creditNoteId}::uuid`;
}

async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => '',
    (error: unknown) => String((error as Error).message),
  );
}

describe('BI-209 a BI-213, BI-095 la nota de crédito en la base', () => {
  it('BI-209 la base rechaza un motivo vacío o de más de 300 caracteres, y admite uno de 300', async () => {
    const { invoiceId, charges } = await anInvoice();

    expect(
      await rejectionOf(
        insertCreditNote(invoiceId, [charges[0]!], { reason: '   ' }),
      ),
    ).toMatch(/credit_note_reason_fits_the_voucher/);
    expect(
      await rejectionOf(
        insertCreditNote(invoiceId, [charges[0]!], { reason: 'x'.repeat(301) }),
      ),
    ).toMatch(/credit_note_reason_fits_the_voucher/);
    expect(
      await rejectionOf(
        insertCreditNote(invoiceId, [charges[0]!], { reasonCode: 'WHIM' }),
      ),
    ).toMatch(/credit_note_reason_code_is_known/);

    // Control positivo: 300 caracteres caben en `<motivo>`.
    await insertCreditNote(invoiceId, [charges[0]!], {
      reasonCode: 'OTHER',
      reason: 'x'.repeat(300),
    });
    expect(await scene.prisma.creditNote.count()).toBe(1);
  });

  it('BI-211 la base rechaza acreditar dos veces el mismo cargo, y un cargo de otra factura', async () => {
    const first = await anInvoice();
    const other = await anInvoice();
    await insertCreditNote(first.invoiceId, [first.charges[0]!]);

    expect(
      await rejectionOf(insertCreditNote(first.invoiceId, [first.charges[0]!])),
    ).toMatch(/credit_note_line_one_per_charge/);
    expect(
      await rejectionOf(insertCreditNote(first.invoiceId, [other.charges[0]!])),
    ).toMatch(/credit_note_line_not_in_invoice/);

    // Control positivo: la otra línea de la misma factura sí se acredita.
    await insertCreditNote(first.invoiceId, [first.charges[1]!]);
    expect(
      await scene.prisma.creditNoteLine.count({
        where: { creditNote: { invoiceId: first.invoiceId } },
      }),
    ).toBe(2);
  });

  it('BI-095 la base rechaza acreditar más que el total de la factura, y admite llegar justo al total', async () => {
    const { invoiceId, charges } = await anInvoice();

    // $60.00 de factura: una nota de $60.01 no cabe.
    expect(
      await rejectionOf(
        insertCreditNote(invoiceId, [charges[0]!], { lineNet: '60.01' }),
      ),
    ).toMatch(/credit_note_exceeds_invoice/);
    expect(await scene.prisma.creditNote.count()).toBe(0);

    // Control positivo: dos notas que suman exactamente el total.
    await insertCreditNote(invoiceId, [charges[0]!]);
    await insertCreditNote(invoiceId, [charges[1]!]);
    expect(await scene.prisma.creditNote.count()).toBe(2);
  });

  it('BI-208 BI-213 la base rechaza la nota de crédito de una factura no autorizada o a Consumidor Final', async () => {
    const pending = await anInvoice({ authorised: false });
    expect(
      await rejectionOf(
        insertCreditNote(pending.invoiceId, [pending.charges[0]!]),
      ),
    ).toMatch(/credit_note_invoice_not_authorised/);

    const finalConsumer = await anInvoice({ finalConsumer: true });
    expect(
      await rejectionOf(
        insertCreditNote(finalConsumer.invoiceId, [finalConsumer.charges[0]!]),
      ),
    ).toMatch(/credit_note_final_consumer/);

    // Control positivo: la autorizada a un receptor identificado, sí.
    const authorised = await anInvoice();
    await insertCreditNote(authorised.invoiceId, [authorised.charges[0]!]);
    expect(await scene.prisma.creditNote.count()).toBe(1);
  });

  it('BI-212 la base rechaza cambiar el contenido de una nota de crédito o borrarla, y admite lo que escribe el SRI', async () => {
    const { invoiceId, charges } = await anInvoice();
    const id = await insertCreditNote(invoiceId, [charges[0]!]);

    expect(
      await rejectionOf(
        scene.prisma
          .$executeRaw`UPDATE "credit_note" SET "reason" = 'Otro motivo' WHERE "id" = ${id}::uuid`,
      ),
    ).toMatch(/credit_note_immutable/);
    expect(
      await rejectionOf(
        scene.prisma
          .$executeRaw`UPDATE "credit_note" SET "buyer_name" = 'Otra persona' WHERE "id" = ${id}::uuid`,
      ),
    ).toMatch(/credit_note_immutable/);
    expect(
      await rejectionOf(
        scene.prisma
          .$executeRaw`DELETE FROM "credit_note" WHERE "id" = ${id}::uuid`,
      ),
    ).toMatch(/credit_note_immutable/);
    expect(
      await rejectionOf(
        scene.prisma
          .$executeRaw`UPDATE "credit_note_line" SET "unit_amount" = 1 WHERE "credit_note_id" = ${id}::uuid`,
      ),
    ).toMatch(/credit_note_immutable/);
    expect(
      await rejectionOf(
        scene.prisma
          .$executeRaw`DELETE FROM "credit_note_line" WHERE "credit_note_id" = ${id}::uuid`,
      ),
    ).toMatch(/credit_note_immutable/);

    // Control positivo: lo que dice el SRI —devuelta, y de vuelta a emitida
    // para reenviarla— sí se escribe.
    await scene.prisma
      .$executeRaw`UPDATE "credit_note" SET "status" = 'REJECTED' WHERE "id" = ${id}::uuid`;
    await scene.prisma
      .$executeRaw`UPDATE "credit_note" SET "status" = 'ISSUED' WHERE "id" = ${id}::uuid`;
    const stored = await scene.prisma.creditNote.findUniqueOrThrow({
      where: { id },
    });
    expect(stored).toMatchObject({
      status: 'ISSUED',
      reason: 'Error en los datos del receptor',
    });
  });
});

describe('SRI-086 el comprobante es de una factura o de una nota de crédito', () => {
  async function insertCreditNoteVoucher(
    creditNoteId: string,
    options: { documentType?: string; alsoInvoiceId?: string } = {},
  ): Promise<{ id: string; accessKey: string }> {
    sequence += 1;
    const numericCode = String(90_000_000 + sequence);
    const accessKey = composeAccessKey({
      issuedOn: clinicalDateOf(new Date()),
      documentType: '04',
      ruc: TEST_ISSUER_RUC,
      environment: '1',
      establishmentCode: '001',
      emissionPointCode: '001',
      sequential: String(sequence).padStart(9, '0'),
      numericCode,
    });
    const documentType = options.documentType ?? '04';
    const keyOfItsType =
      documentType === '04'
        ? accessKey
        : composeAccessKey({
            issuedOn: clinicalDateOf(new Date()),
            documentType: '01',
            ruc: TEST_ISSUER_RUC,
            environment: '1',
            establishmentCode: '001',
            emissionPointCode: '001',
            sequential: String(sequence).padStart(9, '0'),
            numericCode,
          });
    const [row] = await scene.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "electronic_voucher"
        ("invoice_id", "credit_note_id", "site_id", "document_type",
         "access_key", "numeric_code", "environment", "schema_version",
         "status", "unsigned_xml")
      VALUES (${options.alsoInvoiceId ?? null}::uuid, ${creditNoteId}::uuid,
              ${scene.siteId}::uuid, ${documentType}, ${keyOfItsType},
              ${numericCode}, '1', '1.1.0', 'PREPARED',
              '<notaCredito id="comprobante"/>')
      RETURNING "id"`;
    return { id: row!.id, accessKey: keyOfItsType };
  }

  it('SRI-086 la base rechaza un comprobante de dos documentos, con el tipo cambiado o dos para la misma nota, y la clave ajena en la nota', async () => {
    const { invoiceId, charges } = await anInvoice();
    const creditNoteId = await insertCreditNote(invoiceId, [charges[0]!]);
    const other = await anInvoice();
    const otherNote = await insertCreditNote(other.invoiceId, [
      other.charges[0]!,
    ]);

    expect(
      await rejectionOf(
        insertCreditNoteVoucher(creditNoteId, {
          alsoInvoiceId: other.invoiceId,
        }),
      ),
    ).toMatch(/electronic_voucher_one_document/);
    expect(
      await rejectionOf(
        insertCreditNoteVoucher(creditNoteId, { documentType: '01' }),
      ),
    ).toMatch(/electronic_voucher_type_matches_its_document/);

    // Control positivo: el suyo, con tipo 04.
    const voucher = await insertCreditNoteVoucher(creditNoteId);
    expect(await rejectionOf(insertCreditNoteVoucher(creditNoteId))).toMatch(
      /electronic_voucher_one_per_credit_note/,
    );

    const othersVoucher = await insertCreditNoteVoucher(otherNote);
    expect(
      await rejectionOf(
        scene.prisma
          .$executeRaw`UPDATE "credit_note" SET "access_key" = ${othersVoucher.accessKey} WHERE "id" = ${creditNoteId}::uuid`,
      ),
    ).toMatch(/credit_note_access_key_is_its_vouchers/);

    // Control positivo: la suya se escribe, y después ya no cambia.
    await scene.prisma
      .$executeRaw`UPDATE "credit_note" SET "access_key" = ${voucher.accessKey} WHERE "id" = ${creditNoteId}::uuid`;
    expect(
      (
        await scene.prisma.creditNote.findUniqueOrThrow({
          where: { id: creditNoteId },
        })
      ).accessKey,
    ).toBe(voucher.accessKey);
    expect(
      await rejectionOf(
        scene.prisma
          .$executeRaw`UPDATE "electronic_voucher" SET "credit_note_id" = ${otherNote}::uuid WHERE "id" = ${voucher.id}::uuid`,
      ),
    ).toMatch(/electronic_voucher_access_key_is_permanent/);
  });
});

describe('BI-210 BI-212 la cabecera cuadra con sus líneas, y lo autorizado no se mueve', () => {
  it('BI-210 la base rechaza una cabecera que no suma sus líneas, una sin líneas y una incoherente consigo misma', async () => {
    const { invoiceId, charges } = await anInvoice();

    expect(
      await rejectionOf(
        insertCreditNote(invoiceId, [charges[0]!], { amount: '45.00' }),
      ),
    ).toMatch(/credit_note_matches_its_lines/);
    expect(
      await rejectionOf(insertCreditNote(invoiceId, [], { amount: '30.00' })),
    ).toMatch(/credit_note_matches_its_lines/);
    expect(
      await rejectionOf(
        scene.prisma.$executeRaw`
          INSERT INTO "credit_note"
            ("invoice_id", "site_id", "emission_point_id", "sequential",
             "reason_code", "reason", "buyer_identification_type",
             "buyer_identification", "buyer_name", "subtotal_taxed",
             "subtotal_untaxed", "discount_total", "tax_total", "amount",
             "status", "issued_by_id", "issued_at", "updated_at")
          VALUES (${invoiceId}::uuid, ${scene.siteId}::uuid,
                  ${scene.emissionPointId}::uuid, '000000900', 'AMOUNT',
                  'Error en el importe', '05', '1710034065', 'Guamán', 0, 30, 0,
                  0, 31, 'ISSUED', ${scene.userId}::uuid, CURRENT_TIMESTAMP,
                  CURRENT_TIMESTAMP)`,
      ),
    ).toMatch(/credit_note_total_is_consistent/);
    expect(await scene.prisma.creditNote.count()).toBe(0);

    // Control positivo: la que suma su línea entra.
    await insertCreditNote(invoiceId, [charges[0]!]);
    expect(await scene.prisma.creditNote.count()).toBe(1);
  });

  it('BI-212 SRI-086 la nota autorizada no cambia de estado y su clave no se reescribe', async () => {
    const { invoiceId, charges } = await anInvoice();
    const id = await insertCreditNote(invoiceId, [charges[0]!]);
    await authoriseCreditNote(id);

    expect(
      await rejectionOf(
        scene.prisma
          .$executeRaw`UPDATE "credit_note" SET "status" = 'REJECTED' WHERE "id" = ${id}::uuid`,
      ),
    ).toMatch(/credit_note_immutable/);
    expect(
      await rejectionOf(
        scene.prisma
          .$executeRaw`UPDATE "credit_note" SET "access_key" = NULL WHERE "id" = ${id}::uuid`,
      ),
    ).toMatch(/credit_note_immutable/);
    // Control: the note is what the SRI left.
    expect(
      (await scene.prisma.creditNote.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe('AUTHORISED');
  });
});

describe('C2 BI-084 una factura autorizada no vuelve atrás', () => {
  it('BI-084 BI-217 la base rechaza pasar una autorizada a devuelta, y admite anularla', async () => {
    const authorised = await anInvoice();

    expect(
      await rejectionOf(
        scene.prisma
          .$executeRaw`UPDATE "invoice" SET "status" = 'REJECTED' WHERE "id" = ${authorised.invoiceId}::uuid`,
      ),
    ).toMatch(/invoice_authorised_is_immutable/);
    // Control positivo: el paso a anulada sigue siendo el único admitido.
    await scene.prisma
      .$executeRaw`UPDATE "invoice" SET "status" = 'VOIDED' WHERE "id" = ${authorised.invoiceId}::uuid`;
    expect(
      (
        await scene.prisma.invoice.findUniqueOrThrow({
          where: { id: authorised.invoiceId },
        })
      ).status,
    ).toBe('VOIDED');
  });
});

describe('BI-214 lo acreditado vuelve a la cuenta una sola vez', () => {
  async function insertCopy(accountId: string, corrects: string) {
    await scene.prisma.$executeRaw`
      INSERT INTO "charge_item"
        ("account_id", "billable_service_id", "service_date", "unit_amount",
         "service_display", "tax_sri_code", "tax_percentage", "status",
         "origin", "corrects_charge_item_id", "created_by_id", "updated_at")
      VALUES (${accountId}::uuid, ${scene.serviceId}::uuid, CURRENT_DATE, 30,
              'Consulta', '0', 0, 'BILLABLE', 'CORRECTION', ${corrects}::uuid,
              ${scene.userId}::uuid, CURRENT_TIMESTAMP)`;
  }

  it('BI-214 la base no devuelve a la cuenta lo acreditado con «Servicio no prestado»', async () => {
    const { accountId, invoiceId, charges } = await anInvoice();
    await insertCreditNote(invoiceId, [charges[0]!], {
      reasonCode: 'SERVICE_NOT_PROVIDED',
      reason: 'Servicio no prestado',
    });
    await insertCreditNote(invoiceId, [charges[1]!]);

    expect(await rejectionOf(insertCopy(accountId, charges[0]!))).toMatch(
      /charge_item_corrects_a_credited_charge/,
    );
    // Control positivo: lo acreditado por un error del receptor, sí vuelve.
    await insertCopy(accountId, charges[1]!);
  });

  it('C1 BI-214 la copia no se factura mientras el SRI no autorice la nota de crédito, y después sí', async () => {
    const { accountId, invoiceId, charges } = await anInvoice();
    const noteId = await insertCreditNote(invoiceId, [charges[0]!]);
    await insertCopy(accountId, charges[0]!);
    const copy = await scene.prisma.chargeItem.findFirstOrThrow({
      where: { correctsChargeItemId: charges[0]! },
    });
    const bill = () =>
      scene.prisma.$executeRaw`
        UPDATE "charge_item" SET "status" = 'BILLED', "invoice_id" = ${invoiceId}::uuid
         WHERE "id" = ${copy.id}::uuid`;

    expect(await rejectionOf(bill())).toMatch(
      /charge_item_correction_awaits_credit_note/,
    );

    // Control positivo: autorizada la nota, lo corregido se factura.
    await authoriseCreditNote(noteId);
    await bill();
    expect(
      (
        await scene.prisma.chargeItem.findUniqueOrThrow({
          where: { id: copy.id },
        })
      ).status,
    ).toBe('BILLED');
  });

  it('BI-214 la base rechaza copiar un cargo no acreditado, y copiar dos veces el mismo', async () => {
    const { accountId, invoiceId, charges } = await anInvoice();
    await insertCreditNote(invoiceId, [charges[0]!]);

    expect(await rejectionOf(insertCopy(accountId, charges[1]!))).toMatch(
      /charge_item_corrects_a_credited_charge/,
    );

    // Control positivo: el acreditado vuelve una vez.
    await insertCopy(accountId, charges[0]!);
    expect(await rejectionOf(insertCopy(accountId, charges[0]!))).toMatch(
      /charge_item_one_correction_per_charge/,
    );
    expect(
      await scene.prisma.chargeItem.count({
        where: { correctsChargeItemId: charges[0]! },
      }),
    ).toBe(1);
  });

  it('BI-214 la base rechaza una corrección que no dice qué corrige, y un cargo manual que lo dice', async () => {
    const { accountId, invoiceId, charges } = await anInvoice();
    await insertCreditNote(invoiceId, [charges[0]!]);

    expect(
      await rejectionOf(
        scene.prisma.$executeRaw`
          INSERT INTO "charge_item"
            ("account_id", "billable_service_id", "service_date", "unit_amount",
             "service_display", "tax_sri_code", "status", "origin",
             "created_by_id", "updated_at")
          VALUES (${accountId}::uuid, ${scene.serviceId}::uuid, CURRENT_DATE, 30,
                  'Consulta', '0', 'BILLABLE', 'CORRECTION',
                  ${scene.userId}::uuid, CURRENT_TIMESTAMP)`,
      ),
    ).toMatch(/charge_item_origin_names_its_act/);
    expect(
      await rejectionOf(
        scene.prisma.$executeRaw`
          INSERT INTO "charge_item"
            ("account_id", "billable_service_id", "service_date", "unit_amount",
             "service_display", "tax_sri_code", "status", "origin",
             "corrects_charge_item_id", "created_by_id", "updated_at")
          VALUES (${accountId}::uuid, ${scene.serviceId}::uuid, CURRENT_DATE, 30,
                  'Consulta', '0', 'BILLABLE', 'MANUAL', ${charges[0]!}::uuid,
                  ${scene.userId}::uuid, CURRENT_TIMESTAMP)`,
      ),
    ).toMatch(/charge_item_origin_names_its_act/);

    // Control positivo: con origen CORRECTION y el cargo que corrige.
    await insertCopy(accountId, charges[0]!);
  });
});

describe('BI-215 la cuenta guarda su versión anterior', () => {
  it('BI-215 cambiar el estado de la cuenta sin sello se rechaza; con sello, la fila anterior queda en record_version', async () => {
    const accountId = await anAccount();

    expect(
      await rejectionOf(
        scene.prisma
          .$executeRaw`UPDATE "patient_account" SET "status" = 'SETTLED', "closed_at" = CURRENT_TIMESTAMP WHERE "id" = ${accountId}::uuid`,
      ),
    ).toMatch(/record_version_change_is_stamped/);
    expect(
      await scene.prisma.recordVersion.count({
        where: { resourceType: 'patient_account', resourceId: accountId },
      }),
    ).toBe(0);

    // Control positivo: cerrarla por el repositorio la sella, y lo anterior
    // —abierta— queda archivado con quién.
    await scene.accounts.closeAccount({
      accountId,
      closedById: scene.userId,
      now: new Date(),
    });
    const versions = await scene.prisma.recordVersion.findMany({
      where: { resourceType: 'patient_account', resourceId: accountId },
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ changedById: scene.userId });
    expect(versions[0]!.data).toMatchObject({ status: 'OPEN' });
  });

  it('BI-215 cambiar el pagador deja el anterior en record_version', async () => {
    const accountId = await anAccount();
    const other = await scene.prisma.payer.findFirstOrThrow({
      where: { id: { not: scene.payerId }, priceLists: { some: {} } },
      include: { priceLists: true },
    });

    await scene.accounts.changeAccountPayer({
      accountId,
      payerId: other.id,
      priceListId: other.priceLists[0]!.id,
      changedById: scene.userId,
      now: new Date(),
    });

    const [version] = await scene.prisma.recordVersion.findMany({
      where: { resourceType: 'patient_account', resourceId: accountId },
    });
    expect(version!.data).toMatchObject({ payer_id: scene.payerId });
  });
});

describe('BI-217 solo la factura devuelta cambia de receptor, y con versión', () => {
  it('BI-217 la base rechaza cambiar el receptor o la forma de pago de una factura emitida o autorizada, y lo admite en la devuelta con su versión', async () => {
    const issued = await anInvoice({ authorised: false });
    const authorised = await anInvoice();
    const correct = (invoiceId: string) =>
      scene.prisma.$executeRaw`
        UPDATE "invoice"
           SET "buyer_name" = 'Andrade Guamán, José María',
               "changed_by" = ${scene.userId}::uuid,
               "changed_at" = CURRENT_TIMESTAMP
         WHERE "id" = ${invoiceId}::uuid`;

    expect(await rejectionOf(correct(issued.invoiceId))).toMatch(
      /invoice_receiver_editable_only_when_rejected/,
    );
    expect(await rejectionOf(correct(authorised.invoiceId))).toMatch(
      /invoice_authorised_is_immutable|invoice_receiver_editable_only_when_rejected/,
    );
    expect(
      await rejectionOf(
        scene.prisma
          .$executeRaw`UPDATE "invoice" SET "payment_method" = '19', "changed_by" = ${scene.userId}::uuid, "changed_at" = CURRENT_TIMESTAMP WHERE "id" = ${issued.invoiceId}::uuid`,
      ),
    ).toMatch(
      /invoice_receiver_editable_only_when_rejected|invoice_payment_method_is_permanent/,
    );

    // Devuelta en la factura pero sin comprobante devuelto: tampoco (C2).
    await scene.prisma
      .$executeRaw`UPDATE "invoice" SET "status" = 'REJECTED' WHERE "id" = ${issued.invoiceId}::uuid`;
    expect(await rejectionOf(correct(issued.invoiceId))).toMatch(
      /invoice_receiver_editable_only_when_rejected/,
    );
    // La devuelta de verdad —su comprobante RETURNED—: sin sello, no; con
    // sello, sí, y la anterior queda.
    const voucher = await insertVoucher(scene.prisma, issued.invoiceId, {
      signed: true,
    });
    await scene.prisma
      .$executeRaw`UPDATE "electronic_voucher" SET "status" = 'RETURNED' WHERE "id" = ${voucher.id}::uuid`;
    await scene.prisma
      .$executeRaw`UPDATE "invoice" SET "access_key" = ${voucher.accessKey} WHERE "id" = ${issued.invoiceId}::uuid`;
    expect(
      await rejectionOf(
        scene.prisma
          .$executeRaw`UPDATE "invoice" SET "buyer_name" = 'Sin sello' WHERE "id" = ${issued.invoiceId}::uuid`,
      ),
    ).toMatch(/record_version_change_is_stamped/);

    await correct(issued.invoiceId);
    await scene.prisma
      .$executeRaw`UPDATE "invoice" SET "payment_method" = '19', "changed_by" = ${scene.userId}::uuid, "changed_at" = CURRENT_TIMESTAMP + interval '1 second' WHERE "id" = ${issued.invoiceId}::uuid`;

    const stored = await scene.prisma.invoice.findUniqueOrThrow({
      where: { id: issued.invoiceId },
    });
    expect(stored).toMatchObject({
      buyerName: 'Andrade Guamán, José María',
      paymentMethod: '19',
    });
    const versions = await scene.prisma.recordVersion.findMany({
      where: { resourceType: 'invoice', resourceId: issued.invoiceId },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((version) => version.data)).toMatchObject([
      { buyer_name: 'Guamán Andrade, María José', payment_method: '01' },
      { buyer_name: 'Andrade Guamán, José María', payment_method: '01' },
    ]);
  });
});
