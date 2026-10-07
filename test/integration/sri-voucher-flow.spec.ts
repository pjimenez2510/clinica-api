import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
} from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { Quantity } from '../../src/modules/billing/domain/money';
import { DocumentService } from '../../src/modules/documents/application/document.service';
import { PdfKitDocumentRenderer } from '../../src/modules/documents/infrastructure/pdfkit-document.renderer';
import { PrismaDocumentRepository } from '../../src/modules/documents/infrastructure/prisma-document.repository';
import { PrismaDocumentSourceReader } from '../../src/modules/documents/infrastructure/prisma-document-source.reader';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { SigningCertificateService } from '../../src/modules/sri/application/signing-certificate.service';
import { VoucherDispatchService } from '../../src/modules/sri/application/voucher-dispatch.service';
import { VoucherPreparationService } from '../../src/modules/sri/application/voucher-preparation.service';
import type { SriSettings } from '../../src/modules/sri/domain/sri-web-service';
import { AesGcmCertificateCipher } from '../../src/modules/sri/infrastructure/aes-gcm-certificate.cipher';
import { EcSriXadesSigner } from '../../src/modules/sri/infrastructure/ec-sri-xades.signer';
import { ForgePkcs12Inspector } from '../../src/modules/sri/infrastructure/forge-pkcs12.inspector';
import {
  PgBossConnection,
  PgBossVoucherQueue,
  QUEUE_NAMES,
  SriQueueWorker,
} from '../../src/modules/sri/infrastructure/pg-boss-voucher.queue';
import { PrismaElectronicVoucherRepository } from '../../src/modules/sri/infrastructure/prisma-electronic-voucher.repository';
import { PrismaSigningCertificateRepository } from '../../src/modules/sri/infrastructure/prisma-signing-certificate.repository';
import { FetchSriWebService } from '../../src/modules/sri/infrastructure/sri-web-service.client';
import type { Env } from '../../src/shared/config/env.schema';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';
import {
  LONG_FAULT_DETAIL,
  LONG_FAULT_STRING,
  startSriDouble,
  type SriDouble,
} from '../sri-double/sri-double';
import { createTestPkcs12 } from '../support/test-pkcs12';

import { useDatabase } from './setup/database';
import { FakeMailer } from './setup/fake-mailer';
import { createPatient, createSite, createUser } from './setup/fixtures';
import { giveSiteAnIssuer } from './setup/sri-fixtures';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE VOUCHER, END TO END: POSTGRESQL, PG-BOSS AND THE LOCAL DOUBLE OF THE SRI
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * sri/SPEC.md S1–S5. Real database, real queue, real signature with a .p12
 * this test generates, real HTTP against the double. Nothing reaches the SRI.
 *
 * Most cases drive the queue's handlers by hand —`dispatch.run(step, id)` is
 * exactly what a job does— so each SRI answer is asserted deterministically,
 * without waiting the 30 s a retry waits. One case lets the real worker run
 * the whole chain on its own, and one looks inside `pgboss.job` to prove the
 * next step is persisted, singleton per key.
 */
const db = useDatabase();

const silentLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as PinoLogger;

let double: SriDouble;
let prisma: PrismaClient;
let config: ConfigService<Env, true>;
let connection: PgBossConnection;
let preparation: VoucherPreparationService;
let dispatch: VoucherDispatchService;
/** The same dispatcher on another clock: SRI-091 needs «three days later». */
let dispatchAt: (clock: () => Date) => VoucherDispatchService;
let certificates: SigningCertificateService;
let accounts: PrismaBillingAccountRepository;
let mailer: FakeMailer;
let settings: SriSettings;

let siteId: string;
let userId: string;
let patientId: string;
let payerId: string;
let priceListId: string;
let emissionPointId: string;
let serviceId: string;

const NOW = () => new Date();

beforeAll(async () => {
  double = await startSriDouble();
  const values: Record<string, unknown> = {
    DATABASE_URL: inject('databaseUrl'),
    SRI_QUEUE_ENABLED: true,
    SRI_RECEPTION_URL: double.receptionUrl,
    SRI_AUTHORISATION_URL: double.authorisationUrl,
    SRI_REQUEST_TIMEOUT_MS: 3000,
    SRI_CERTIFICATE_MASTER_KEY_FILE:
      process.env.SRI_CERTIFICATE_MASTER_KEY_FILE,
  };
  config = { get: (key: string) => values[key] } as unknown as ConfigService<
    Env,
    true
  >;
  connection = new PgBossConnection(config, silentLogger);
});

afterAll(async () => {
  await connection.onApplicationShutdown();
  await double.close();
});

beforeEach(async () => {
  prisma = db();
  double.reset();
  mailer = new FakeMailer();
  settings = { environment: '1', softwareProviderRuc: null };

  const service = prisma as unknown as PrismaService;
  const vouchers = new PrismaElectronicVoucherRepository(service);
  const certificateRows = new PrismaSigningCertificateRepository(service);
  const cipher = new AesGcmCertificateCipher(config);
  const queue = new PgBossVoucherQueue(connection, silentLogger);
  const web = new FetchSriWebService(config);
  preparation = new VoucherPreparationService(
    vouchers,
    certificateRows,
    cipher,
    new EcSriXadesSigner(),
    queue,
    web,
    settings,
    NOW,
    silentLogger,
  );
  dispatchAt = (clock) =>
    new VoucherDispatchService(
      vouchers,
      web,
      queue,
      {
        issueRide: (invoiceId) =>
          Promise.resolve({
            content: Buffer.from('%PDF-1.4 RIDE de prueba'),
            fileName: `RIDE-${invoiceId}.pdf`,
          }),
        issueCreditNoteRide: (creditNoteId) =>
          Promise.resolve({
            content: Buffer.from('%PDF-1.4 RIDE de nota de crédito de prueba'),
            fileName: `RIDE-NC-${creditNoteId}.pdf`,
          }),
      },
      mailer,
      clock,
      settings,
      preparation,
      silentLogger,
    );
  dispatch = dispatchAt(NOW);
  certificates = new SigningCertificateService(
    certificateRows,
    new ForgePkcs12Inspector(),
    cipher,
    { record: () => Promise.resolve() },
    NOW,
    vouchers,
  );
  accounts = new PrismaBillingAccountRepository(service);

  await seedBilling(prisma);
  const site = await createSite(prisma);
  await giveSiteAnIssuer(prisma, site.id);
  siteId = site.id;
  userId = (await createUser(prisma)).id;
  patientId = (await createPatient(prisma)).id;
  const payer = await prisma.payer.findUniqueOrThrow({
    where: { code: 'PARTICULAR' },
  });
  payerId = payer.id;
  priceListId = (
    await prisma.priceList.findFirstOrThrow({ where: { payerId } })
  ).id;
  emissionPointId = (
    await prisma.emissionPoint.create({ data: { siteId, code: '001' } })
  ).id;
  serviceId = (
    await prisma.billableService.findUniqueOrThrow({
      where: { code: 'CONS-MG-PV' },
    })
  ).id;
});

async function loadCertificate() {
  const p12 = createTestPkcs12({ now: NOW() });
  await certificates.upload(p12.pkcs12, p12.password, { userId });
  return p12;
}

async function issueInvoice(
  email: string | null = 'maria@example.com',
  quantity: Quantity = Quantity.ONE,
) {
  const account = await prisma.patientAccount.create({
    data: { patientId, siteId, payerId, priceListId },
  });
  await accounts.addCharge({
    accountId: account.id,
    billableServiceId: serviceId,
    encounterId: null,
    serviceDate: clinicalDateOf(NOW()),
    quantity,
    createdById: userId,
    origin: 'MANUAL',
    encounterProcedureId: null,
    serviceOrderItemId: null,
    status: 'BILLABLE',
  });
  return accounts.issueInvoice({
    accountId: account.id,
    siteId,
    emissionPointId,
    paymentMethod: '01',
    receiver: {
      buyerIdentificationType: '05',
      buyerIdentification: '1710034065',
      buyerName: 'Guamán Andrade, María José',
      buyerEmail: email,
      isFinalConsumer: false,
    },
    issuedById: userId,
  });
}

async function voucherOf(invoiceId: string) {
  return prisma.electronicVoucher.findUniqueOrThrow({ where: { invoiceId } });
}

async function invoiceRow(invoiceId: string) {
  return prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
}

/** A prepared and signed voucher, ready for the SRI. */
async function aSignedVoucher(email?: string | null) {
  await loadCertificate();
  const invoice = await issueInvoice(email);
  const voucher = await preparation.prepareInvoice(invoice.id);
  expect(voucher?.status).toBe('SIGNED');
  return { invoice, voucher: voucher! };
}

describe('SRI-001, SRI-041 preparar al emitir, sin bloquear nunca la factura', () => {
  it('SRI-001 SRI-004 SRI-007 la factura toma la clave de su comprobante, con la fecha de Guayaquil y el ambiente fijado', async () => {
    const { invoice, voucher } = await aSignedVoucher();
    const stored = await invoiceRow(invoice.id);
    const issuedOn = clinicalDateOf(stored.issuedAt!)
      .split('-')
      .reverse()
      .join('');

    expect(stored.accessKey).toBe(voucher.accessKey);
    expect(voucher.accessKey.slice(0, 8)).toBe(issuedOn);
    expect(voucher.accessKey.slice(23, 24)).toBe('1');
    expect(voucher.accessKey.slice(24, 30)).toBe('001001');
  });

  it('SRI-029 SRI-041 sin certificado, la factura queda emitida con su clave y el comprobante espera sin firmar', async () => {
    const invoice = await issueInvoice();
    await preparation.prepare(invoice.id);

    const voucher = await voucherOf(invoice.id);
    expect(voucher.status).toBe('PREPARED');
    expect(voucher.blockedReason).toBe('NO_CERTIFICATE');
    expect((await invoiceRow(invoice.id)).accessKey).toBe(voucher.accessKey);
    expect((await invoiceRow(invoice.id)).status).toBe('ISSUED');
  });

  it('SRI-084 SRI-005 al cargar un certificado se firma lo que esperaba, con la misma clave', async () => {
    const invoice = await issueInvoice();
    await preparation.prepare(invoice.id);
    const waiting = await voucherOf(invoice.id);

    expect(waiting.blockedReason).toBe('NO_CERTIFICATE');

    await loadCertificate();
    // Released, not signed inside the upload: the next sweep signs it.
    expect((await voucherOf(invoice.id)).blockedReason).toBeNull();
    await dispatch.sweep();

    const signed = await voucherOf(invoice.id);
    expect(signed.status).toBe('SIGNED');
    expect(signed.accessKey).toBe(waiting.accessKey);
    expect(signed.signedXml).toContain('ds:SignatureValue');
  });

  it('SRI-017 una factura sin forma de pago (anterior a BI-170) no se firma, y lo dice', async () => {
    await loadCertificate();
    const invoice = await issueInvoice();
    // As an invoice issued before the column existed: lifting the table's
    // triggers for the one statement that empties it.
    await prisma.$executeRaw`ALTER TABLE "invoice" DISABLE TRIGGER USER`;
    await prisma.$executeRaw`UPDATE "invoice" SET "payment_method" = NULL WHERE "id" = ${invoice.id}::uuid`;
    await prisma.$executeRaw`ALTER TABLE "invoice" ENABLE TRIGGER USER`;
    await preparation.prepare(invoice.id);
    expect(await voucherOf(invoice.id)).toMatchObject({
      status: 'PREPARED',
      blockedReason: 'NO_PAYMENT_METHOD',
    });
  });

  it('SRI-008 SRI-056 sin código SRI de la sede no hay comprobante ni clave inventada; el barrido lo prepara cuando aparece', async () => {
    await loadCertificate();
    await prisma.site.update({
      where: { id: siteId },
      data: { sriEstablishmentCode: null },
    });
    const invoice = await issueInvoice();
    await preparation.prepare(invoice.id);

    expect(await prisma.electronicVoucher.count()).toBe(0);
    expect((await invoiceRow(invoice.id)).accessKey).toBeNull();
    expect((await invoiceRow(invoice.id)).status).toBe('ISSUED');

    await prisma.site.update({
      where: { id: siteId },
      data: { sriEstablishmentCode: '001' },
    });
    await dispatch.sweep();
    expect((await voucherOf(invoice.id)).status).toBe('SIGNED');
  });

  it('SRI-008 OR-031 sin las banderas fiscales declaradas no hay comprobante; declaradas, el barrido lo prepara', async () => {
    await loadCertificate();
    const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
    await prisma.establishment.update({
      where: { id: site.establishmentId },
      data: { fiscalProfileDeclaredAt: null },
    });
    const invoice = await issueInvoice();
    await preparation.prepare(invoice.id);
    expect(await prisma.electronicVoucher.count()).toBe(0);
    expect((await invoiceRow(invoice.id)).accessKey).toBeNull();

    await prisma.establishment.update({
      where: { id: site.establishmentId },
      data: { fiscalProfileDeclaredAt: NOW() },
    });
    await dispatch.sweep();
    expect((await voucherOf(invoice.id)).status).toBe('SIGNED');
  });

  it('SRI-013 SRI-014 una factura con media unidad de un insumo tiene su comprobante firmado, con la cantidad exacta', async () => {
    await loadCertificate();
    const invoice = await issueInvoice(
      'maria@example.com',
      Quantity.parse('0.500'),
    );
    const voucher = await preparation.prepareInvoice(invoice.id);
    expect(voucher?.status).toBe('SIGNED');
    expect(voucher?.signedXml).toContain('<cantidad>0.500000</cantidad>');
  });

  it('SRI-006 preparar dos veces la misma factura deja un solo comprobante y una sola clave', async () => {
    await loadCertificate();
    const invoice = await issueInvoice();
    const [first, second] = await Promise.all([
      preparation.prepareInvoice(invoice.id),
      preparation.prepareInvoice(invoice.id),
    ]);
    expect(await prisma.electronicVoucher.count()).toBe(1);
    expect(first?.accessKey).toBe(second?.accessKey);
  });

  it('SRI-023 SRI-026 el certificado se guarda cifrado y cada firma deja su apertura', async () => {
    const p12 = createTestPkcs12({ now: NOW() });
    await certificates.upload(p12.pkcs12, p12.password, { userId });
    const row = await prisma.signingCertificate.findFirstOrThrow();
    expect(
      Buffer.from(row.encryptedPkcs12).includes(p12.pkcs12.subarray(0, 64)),
    ).toBe(false);
    expect(Buffer.from(row.encryptedPassword).toString('utf8')).not.toContain(
      p12.password,
    );

    await preparation.prepareInvoice((await issueInvoice()).id);
    await preparation.prepareInvoice((await issueInvoice()).id);
    expect(await prisma.signingCertificateOpening.count()).toBe(2);
  });
});

describe('SRI-043 a SRI-052 cada respuesta del SRI, contra el doble', () => {
  it('SRI-043 SRI-047 recibida y autorizada: comprobante y factura AUTHORISED, con el XML de autorización', async () => {
    const { invoice, voucher } = await aSignedVoucher();
    await dispatch.run('SEND', voucher.id);
    expect((await voucherOf(invoice.id)).status).toBe('RECEIVED');

    await dispatch.run('AUTHORISE', voucher.id);
    const authorised = await voucherOf(invoice.id);
    expect(authorised.status).toBe('AUTHORISED');
    expect(authorised.authorisationNumber).toBe(voucher.accessKey);
    expect(authorised.authorisedXml).toContain('<estado>AUTORIZADO</estado>');
    expect(authorised.authorisedXml).toContain(voucher.signedXml!);
    const stored = await invoiceRow(invoice.id);
    expect(stored.status).toBe('AUTHORISED');
    expect(stored.authorisedAt).not.toBeNull();
  });

  it('SRI-046 devuelta con 35: RETURNED, factura REJECTED, el mensaje guardado y ningún reintento solo', async () => {
    const { invoice, voucher } = await aSignedVoucher();
    double.setScenario(voucher.accessKey, 'RETURNED_35');
    await dispatch.run('SEND', voucher.id);

    const returned = await voucherOf(invoice.id);
    expect(returned.status).toBe('RETURNED');
    expect(returned.nextAttemptAt).toBeNull();
    expect(returned.lastMessages).toEqual([
      expect.objectContaining({ identifier: '35', type: 'ERROR' }),
    ]);
    expect((await invoiceRow(invoice.id)).status).toBe('REJECTED');

    // Another SEND job (a duplicate, a stale sweep) does nothing.
    await dispatch.run('SEND', voucher.id);
    expect(double.callsFor(voucher.accessKey, 'RECEPTION')).toHaveLength(1);
  });

  it('SRI-044 devuelta con 43: se consulta la autorización con la misma clave y se autoriza', async () => {
    const { invoice, voucher } = await aSignedVoucher();
    double.setScenario(voucher.accessKey, 'ALREADY_REGISTERED_43');
    await dispatch.run('SEND', voucher.id);
    expect((await voucherOf(invoice.id)).status).toBe('RECEIVED');
    expect((await invoiceRow(invoice.id)).status).toBe('ISSUED');

    await dispatch.run('AUTHORISE', voucher.id);
    expect((await voucherOf(invoice.id)).status).toBe('AUTHORISED');
  });

  it('SRI-045 SRI-049 devuelta con 70: se consulta con espera y NUNCA se reenvía, hasta que se autoriza', async () => {
    const { invoice, voucher } = await aSignedVoucher();
    double.setScenario(voucher.accessKey, 'IN_PROCESS_70');
    double.setPendingPolls(2);
    await dispatch.run('SEND', voucher.id);

    for (let poll = 0; poll < 2; poll += 1) {
      await dispatch.run('AUTHORISE', voucher.id);
      const pending = await voucherOf(invoice.id);
      expect(pending.status).toBe('RECEIVED');
      expect(pending.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    }
    await dispatch.run('AUTHORISE', voucher.id);

    expect((await voucherOf(invoice.id)).status).toBe('AUTHORISED');
    expect(double.callsFor(voucher.accessKey, 'RECEPTION')).toHaveLength(1);
    expect(double.callsFor(voucher.accessKey, 'AUTHORISATION')).toHaveLength(3);
  });

  it('SRI-048 no autorizado: NOT_AUTHORISED con su motivo y la factura REJECTED', async () => {
    const { invoice, voucher } = await aSignedVoucher();
    double.setScenario(voucher.accessKey, 'NOT_AUTHORISED');
    await dispatch.run('SEND', voucher.id);
    await dispatch.run('AUTHORISE', voucher.id);

    const refused = await voucherOf(invoice.id);
    expect(refused.status).toBe('NOT_AUTHORISED');
    expect(refused.lastMessages).toEqual([
      expect.objectContaining({ identifier: '39' }),
    ]);
    expect((await invoiceRow(invoice.id)).status).toBe('REJECTED');
  });

  it('SRI-048 SRI-058 reenviado un no autorizado, su rechazo antiguo no vuelve a rechazarlo: espera, y se autoriza', async () => {
    const { invoice, voucher } = await aSignedVoucher();
    double.setScenario(voucher.accessKey, 'NOT_AUTHORISED');
    await dispatch.run('SEND', voucher.id);
    await dispatch.run('AUTHORISE', voucher.id);
    expect((await voucherOf(invoice.id)).status).toBe('NOT_AUTHORISED');

    // A person re-sends it (SRI-058): same key, signed again.
    const repository = new PrismaElectronicVoucherRepository(
      prisma as unknown as PrismaService,
    );
    const record = (await repository.findById(voucher.id))!;
    expect(
      await repository.reopen(
        voucher.id,
        (await preparation.recompose(record))!,
      ),
    ).toBe(true);
    await preparation.sign({ ...record, status: 'PREPARED', signedXml: null });

    // The SRI has not decided the new one yet: it answers with the old
    // refusal only. The voucher keeps waiting; the invoice is not REJECTED.
    double.setScenario(voucher.accessKey, 'PENDING');
    await dispatch.run('SEND', voucher.id);
    await dispatch.run('AUTHORISE', voucher.id);
    expect((await voucherOf(invoice.id)).status).toBe('RECEIVED');
    expect((await invoiceRow(invoice.id)).status).toBe('ISSUED');

    // Then it authorises it, with the old refusal still in the list.
    double.setScenario(voucher.accessKey, 'AUTHORISED');
    await dispatch.run('AUTHORISE', voucher.id);
    expect((await voucherOf(invoice.id)).status).toBe('AUTHORISED');
    expect((await invoiceRow(invoice.id)).status).toBe('AUTHORISED');
  });

  it('SRI-050 SRI-052 SRI caído: el intento queda como fallo, el estado no cambia y se programa con espera; al volver, se recibe', async () => {
    const { invoice, voucher } = await aSignedVoucher();
    double.setDown(true);
    const before = Date.now();
    await dispatch.run('SEND', voucher.id);

    const waiting = await voucherOf(invoice.id);
    expect(waiting.status).toBe('SIGNED');
    expect(waiting.attemptCount).toBe(1);
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(
      before + 29_000,
    );
    const [attempt] = await prisma.electronicVoucherAttempt.findMany({
      where: { voucherId: voucher.id },
    });
    expect(attempt).toMatchObject({
      outcome: 'TRANSPORT_FAILURE',
      operation: 'RECEPTION',
    });
    expect(attempt?.transportError).toMatch(/HTTP 503/);
    expect((await invoiceRow(invoice.id)).status).toBe('ISSUED');

    double.setDown(false);
    await dispatch.run('SEND', voucher.id);
    expect((await voucherOf(invoice.id)).status).toBe('RECEIVED');
  });

  it('SRI-059 SRI-050 SRI-052 un 500 con soap:Fault largo queda entero en el intento; la clave, los bytes y la espera creciente no cambian', async () => {
    const { invoice, voucher } = await aSignedVoucher();
    const signed = await prisma.electronicVoucher.findUniqueOrThrow({
      where: { id: voucher.id },
      select: { signedXml: true },
    });
    double.setScenario(voucher.accessKey, 'FAULT_500');

    const firstAt = Date.now();
    await dispatch.run('SEND', voucher.id);
    const first = await voucherOf(invoice.id);
    const secondAt = Date.now();
    await dispatch.run('SEND', voucher.id);
    const second = await voucherOf(invoice.id);

    const attempts = await prisma.electronicVoucherAttempt.findMany({
      where: { voucherId: voucher.id },
      orderBy: { startedAt: 'asc' },
    });
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(attempt).toMatchObject({
        outcome: 'TRANSPORT_FAILURE',
        accessKey: voucher.accessKey,
        httpStatus: 500,
        faultCode: 'soap:Server',
        faultString: LONG_FAULT_STRING,
        faultDetail: LONG_FAULT_DETAIL,
        transportError: `HTTP 500 · soap:Server: ${LONG_FAULT_STRING}`,
      });
      expect(attempt.responseBody).toContain(LONG_FAULT_STRING);
    }

    // SRI-050. Same key, same bytes; the voucher waits SIGNED, longer each time.
    expect(second.status).toBe('SIGNED');
    expect(second.accessKey).toBe(voucher.accessKey);
    expect(
      (
        await prisma.electronicVoucher.findUniqueOrThrow({
          where: { id: voucher.id },
          select: { signedXml: true },
        })
      ).signedXml,
    ).toBe(signed.signedXml);
    expect(second.nextAttemptAt!.getTime() - secondAt).toBeGreaterThan(
      first.nextAttemptAt!.getTime() - firstAt,
    );
    expect((await invoiceRow(invoice.id)).status).toBe('ISSUED');
  });

  it('SRI-059 SRI-051 un fault con un nulo y fuera de todo tope queda grabado: el intento no se pierde y espera', async () => {
    const { invoice, voucher } = await aSignedVoucher();
    double.setScenario(voucher.accessKey, 'ODD_FAULT');
    const before = Date.now();
    await dispatch.run('SEND', voucher.id);

    const attempts = await prisma.electronicVoucherAttempt.findMany({
      where: { voucherId: voucher.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      outcome: 'TRANSPORT_FAILURE',
      httpStatus: 500,
    });
    const waiting = await voucherOf(invoice.id);
    expect(waiting.attemptCount).toBe(1);
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(
      before + 29_000,
    );
  });

  it('SRI-059 lo guardado del intento nunca lleva la petición firmada, el certificado, su contraseña ni la frase maestra', async () => {
    const p12 = await loadCertificate();
    const invoice = await issueInvoice();
    const voucher = (await preparation.prepareInvoice(invoice.id))!;
    const { signedXml } = await prisma.electronicVoucher.findUniqueOrThrow({
      where: { id: voucher.id },
      select: { signedXml: true },
    });
    const masterKey = readFileSync(
      process.env.SRI_CERTIFICATE_MASTER_KEY_FILE!,
      'utf8',
    );
    const x509 = /<ds:X509Certificate>([^<]+)</.exec(signedXml!)?.[1];
    expect(x509?.length).toBeGreaterThan(100);

    double.setScenario(voucher.accessKey, 'ECHO_FAULT');
    await dispatch.run('SEND', voucher.id);

    // The whole row, every column, as the database holds it.
    const [row] = await prisma.$queryRaw<{ stored: string }[]>`
      SELECT row_to_json(a)::text AS "stored"
        FROM "electronic_voucher_attempt" a
       WHERE "voucher_id" = ${voucher.id}::uuid`;
    const stored = row!.stored;
    // Positive control: the echo came back and was replaced, not lost.
    expect(stored).toContain(
      'No se pudo leer el comprobante [petición omitida]',
    );
    expect(stored.split('[petición omitida]').length).toBeGreaterThan(3);

    for (const secret of [
      Buffer.from(signedXml!, 'utf8').toString('base64'),
      Buffer.from(signedXml!, 'utf8').toString('base64').slice(500, 600),
      signedXml!,
      x509!,
      p12.pkcs12.toString('base64'),
      p12.pkcs12.toString('base64').slice(100, 200),
      p12.password,
      masterKey,
    ]) {
      expect(stored).not.toContain(secret);
    }
  });

  it('SC-083 en todo el recorrido cada intento lleva la clave con que nació el comprobante', async () => {
    const { invoice, voucher } = await aSignedVoucher();
    double.setScenario(voucher.accessKey, 'IN_PROCESS_70');
    await dispatch.run('SEND', voucher.id);
    await dispatch.run('AUTHORISE', voucher.id);
    await dispatch.run('AUTHORISE', voucher.id);
    await dispatch.run('AUTHORISE', voucher.id);

    const attempts = await prisma.electronicVoucherAttempt.findMany({
      where: { voucherId: voucher.id },
    });
    expect(attempts.length).toBe(4);
    expect(new Set(attempts.map((a) => a.accessKey))).toEqual(
      new Set([voucher.accessKey]),
    );
    expect((await invoiceRow(invoice.id)).accessKey).toBe(voucher.accessKey);
  });

  it('SRI-058 reintentar un devuelto recompone con la misma clave, firma y vuelve a la factura a ISSUED', async () => {
    const { invoice, voucher } = await aSignedVoucher();
    double.setScenario(voucher.accessKey, 'RETURNED_35');
    await dispatch.run('SEND', voucher.id);

    const repository = new PrismaElectronicVoucherRepository(
      prisma as unknown as PrismaService,
    );
    const record = (await repository.findById(voucher.id))!;
    const xml = (await preparation.recompose(record))!;
    expect(await repository.reopen(voucher.id, xml)).toBe(true);
    await preparation.sign({ ...record, status: 'PREPARED', signedXml: null });

    const retried = await voucherOf(invoice.id);
    expect(retried.status).toBe('SIGNED');
    expect(retried.accessKey).toBe(voucher.accessKey);
    expect((await invoiceRow(invoice.id)).status).toBe('ISSUED');

    double.setScenario(voucher.accessKey, 'AUTHORISED');
    await dispatch.run('SEND', voucher.id);
    await dispatch.run('AUTHORISE', voucher.id);
    expect((await voucherOf(invoice.id)).status).toBe('AUTHORISED');
  });
});

describe('SRI-056 lo que el barrido mira, contra la base', () => {
  const repository = () =>
    new PrismaElectronicVoucherRepository(prisma as unknown as PrismaService);

  it('SRI-056 en vuelo: lo vencido sí, lo de un intento futuro no, y lo del otro ambiente tampoco', async () => {
    const due = (await aSignedVoucher()).voucher;
    const later = (await aSignedVoucher()).voucher;
    await prisma.electronicVoucher.update({
      where: { id: later.id },
      data: { nextAttemptAt: new Date(NOW().getTime() + 3_600_000) },
    });

    const work = await repository().pendingWork(200, NOW(), '1');
    const ids = work.inFlight.map((v) => v.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(later.id);

    // SRI-055. Configured for production, testing-environment keys stay out.
    const production = await repository().pendingWork(200, NOW(), '2');
    expect(production.inFlight.map((v) => v.id)).not.toContain(due.id);
  });

  it('SRI-056 SRI-084 sin firmar: lo sin motivo sí; lo que solo arregla un certificado, solo pasada una hora; sin forma de pago, nunca', async () => {
    const plain = await issueInvoice();
    await preparation.prepare(plain.id); // no certificate: NO_CERTIFICATE
    const blocked = await voucherOf(plain.id);
    expect(blocked.blockedReason).toBe('NO_CERTIFICATE');

    const freshIds = (
      await repository().pendingWork(200, NOW(), '1')
    ).unsigned.map((v) => v.id);
    expect(freshIds).not.toContain(blocked.id);

    // An hour later the sweep tries it again (a certificate may now be valid).
    const inAnHour = new Date(NOW().getTime() + 3_600_000 + 1_000);
    const hourIds = (
      await repository().pendingWork(200, inAnHour, '1')
    ).unsigned.map((v) => v.id);
    expect(hourIds).toContain(blocked.id);

    // Control and the other side: no reason is swept now; no payment method never.
    await prisma.electronicVoucher.update({
      where: { id: blocked.id },
      data: { blockedReason: null },
    });
    expect(
      (await repository().pendingWork(200, NOW(), '1')).unsigned.map(
        (v) => v.id,
      ),
    ).toContain(blocked.id);
    await prisma.electronicVoucher.update({
      where: { id: blocked.id },
      data: { blockedReason: 'NO_PAYMENT_METHOD' },
    });
    expect(
      (await repository().pendingWork(200, inAnHour, '1')).unsigned.map(
        (v) => v.id,
      ),
    ).not.toContain(blocked.id);
  });

  it('SRI-008 SRI-056 sin comprobante: la factura de una sede sin código no ocupa plaza; con código, sí', async () => {
    await prisma.site.update({
      where: { id: siteId },
      data: { sriEstablishmentCode: null },
    });
    const invoice = await issueInvoice();
    expect(
      (await repository().pendingWork(200, NOW(), '1')).invoicesWithoutVoucher,
    ).not.toContain(invoice.id);

    await prisma.site.update({
      where: { id: siteId },
      data: { sriEstablishmentCode: '001' },
    });
    expect(
      (await repository().pendingWork(200, NOW(), '1')).invoicesWithoutVoucher,
    ).toContain(invoice.id);
  });
});

describe('DOC-076 lo que el RIDE lee de la base', () => {
  it('DOC-076 BI-170 la factura emitida trae forma de pago, paciente con su HC, día de la atención, emisor e impuesto por línea', async () => {
    const invoice = await issueInvoice();
    const reader = new PrismaDocumentSourceReader(
      prisma as unknown as PrismaService,
      'https://clinica.example/verificar',
    );
    const subject = await reader.findSubject({
      kind: 'INVOICE_RIDE',
      subjectId: invoice.id,
      sites: 'all',
    });
    if (subject?.kind !== 'INVOICE_RIDE') throw new Error('no RIDE subject');
    const patient = await prisma.patient.findUniqueOrThrow({
      where: { id: patientId },
    });

    expect(subject.data.paymentMethod).toBe('01');
    expect(subject.data.patient).toMatchObject({ mrn: patient.mrn });
    expect(subject.data.attendedOn).not.toBeNull();
    expect(subject.data.lines[0]).toMatchObject({
      taxSriCode: expect.any(String) as string,
    });

    const context = await reader.contextForSite(siteId);
    expect(context?.establishment.headOfficeAddress).toBe(
      'Av. Amazonas y Naciones Unidas, Quito',
    );
  });
});

describe('SRI-072 a SRI-076 la entrega al cliente', () => {
  async function anAuthorisedVoucher(
    email: string | null = 'maria@example.com',
  ) {
    const { invoice, voucher } = await aSignedVoucher(email);
    await dispatch.run('SEND', voucher.id);
    await dispatch.run('AUTHORISE', voucher.id);
    return { invoice, voucher };
  }

  it('SRI-072 SRI-073 envía el RIDE en PDF y el XML de autorización, y lo anota', async () => {
    const { invoice, voucher } = await anAuthorisedVoucher();
    await dispatch.run('DELIVER', voucher.id);

    const message = mailer.last()!;
    expect(message.to).toBe('maria@example.com');
    expect(message.attachments?.map((a) => a.contentType)).toEqual([
      'application/pdf',
      'application/xml',
    ]);
    const xml = message.attachments![1]!.content.toString('utf8');
    expect(xml).toContain(
      `<numeroAutorizacion>${voucher.accessKey}</numeroAutorizacion>`,
    );
    expect(xml).toContain('<comprobante><![CDATA[');
    expect((await voucherOf(invoice.id)).deliveryStatus).toBe('SENT');
  });

  it('SRI-075 un segundo trabajo de entrega no vuelve a enviar el correo', async () => {
    const { voucher } = await anAuthorisedVoucher();
    await dispatch.run('DELIVER', voucher.id);
    await dispatch.run('DELIVER', voucher.id);
    expect(mailer.sent).toHaveLength(1);
  });

  it('SRI-074 si el correo falla queda FAILED, la autorización no se toca, y el reintento lo envía', async () => {
    const { invoice, voucher } = await anAuthorisedVoucher();
    mailer.failWith = new Error('relay down');
    await dispatch.run('DELIVER', voucher.id);
    expect(await voucherOf(invoice.id)).toMatchObject({
      status: 'AUTHORISED',
      deliveryStatus: 'FAILED',
    });
    expect((await invoiceRow(invoice.id)).status).toBe('AUTHORISED');

    mailer.failWith = null;
    await dispatch.run('DELIVER', voucher.id);
    expect((await voucherOf(invoice.id)).deliveryStatus).toBe('SENT');
  });

  it('SRI-091 el correo que sigue fallando 72 horas después de la autorización queda «no se pudo enviar», y ni la cola ni el barrido lo reintentan', async () => {
    const { invoice, voucher } =
      await anAuthorisedVoucher('rebota@example.com');
    mailer.failWith = new Error('550 mailbox unavailable');
    const { authorisedAt } = await voucherOf(invoice.id);
    if (!authorisedAt) throw new Error('the double did not authorise it');
    const at = (hours: number) => () =>
      new Date(authorisedAt.getTime() + hours * 3_600_000);

    // Control: one hour short of the three days it is still a retry.
    await dispatchAt(at(71)).run('DELIVER', voucher.id);
    expect((await voucherOf(invoice.id)).deliveryStatus).toBe('FAILED');

    await dispatchAt(at(72)).run('DELIVER', voucher.id);
    expect(await voucherOf(invoice.id)).toMatchObject({
      status: 'AUTHORISED',
      deliveryStatus: 'UNDELIVERABLE',
    });
    expect((await invoiceRow(invoice.id)).status).toBe('AUTHORISED');

    // Given up for good: a mail server that came back does not get it.
    mailer.failWith = null;
    const sent = mailer.sent.length;
    await dispatchAt(at(80)).run('DELIVER', voucher.id);
    expect(mailer.sent).toHaveLength(sent);
    const work = await new PrismaElectronicVoucherRepository(
      prisma as unknown as PrismaService,
    ).pendingWork(200, at(80)(), '1');
    expect(work.undelivered.map((one) => one.id)).not.toContain(voucher.id);
  });

  it('SRI-091 la base admite «no se pudo enviar» y sigue rechazando un estado de entrega que no conoce', async () => {
    const { voucher } = await anAuthorisedVoucher();
    await prisma.electronicVoucher.update({
      where: { id: voucher.id },
      data: { deliveryStatus: 'UNDELIVERABLE' },
    });
    // Control positivo: the CHECK still refuses what it does not know.
    await expect(
      prisma.$executeRaw`UPDATE "electronic_voucher" SET "delivery_status" = 'BOUNCED' WHERE "id" = ${voucher.id}::uuid`,
    ).rejects.toThrow(/electronic_voucher_delivery_status_is_known/);
  });

  it('SRI-076 sin correo del receptor no se intenta y queda dicho', async () => {
    const { invoice, voucher } = await anAuthorisedVoucher(null);
    await dispatch.run('DELIVER', voucher.id);
    expect(mailer.sent).toHaveLength(0);
    expect((await voucherOf(invoice.id)).deliveryStatus).toBe('NO_EMAIL');
  });
});

describe('SRI-040, SRI-057 la cola persistente', () => {
  async function jobsFor(queue: string, key: string) {
    return prisma.$queryRawUnsafe<{ state: string }[]>(
      `SELECT state FROM pgboss.job WHERE name = $1 AND singleton_key = $2 ORDER BY created_on`,
      queue,
      key,
    );
  }

  it('SRI-040 SRI-057 firmar deja el envío en pg-boss con la clave como singleton, y repetirlo no lo duplica', async () => {
    const { voucher } = await aSignedVoucher();
    expect(await jobsFor(QUEUE_NAMES.SEND, voucher.accessKey)).toEqual([
      { state: 'created' },
    ]);

    // The sweep re-queues everything in flight: the stately policy drops it.
    await dispatch.sweep();
    expect(await jobsFor(QUEUE_NAMES.SEND, voucher.accessKey)).toHaveLength(1);
  });

  it('SRI-040 SC-084 el worker real lleva el comprobante solo de firmado a autorizado y entregado', async () => {
    const worker = new SriQueueWorker(connection, dispatch, silentLogger);
    await worker.start();
    const { invoice } = await aSignedVoucher();

    const deadline = Date.now() + 25_000;
    let delivered = false;
    while (!delivered && Date.now() < deadline) {
      const current = await voucherOf(invoice.id);
      delivered = current.deliveryStatus === 'SENT';
      if (!delivered) await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const final = await voucherOf(invoice.id);
    if (final.deliveryStatus !== 'SENT') {
      // What the queue did, so a failure here says why instead of «timeout».
      console.log(
        await prisma.$queryRawUnsafe(
          `SELECT name, state, retry_count, output FROM pgboss.job WHERE singleton_key = $1`,
          final.accessKey,
        ),
      );
    }
    expect(final).toMatchObject({
      status: 'AUTHORISED',
      deliveryStatus: 'SENT',
    });
    expect((await invoiceRow(invoice.id)).status).toBe('AUTHORISED');
    await (await connection.instance()).offWork(QUEUE_NAMES.SEND);
    await (await connection.instance()).offWork(QUEUE_NAMES.AUTHORISE);
    await (await connection.instance()).offWork(QUEUE_NAMES.DELIVER);
  }, 40_000);
});

/**
 * sri/S7. The credit note takes the invoice's road: key with type 04, XML
 * `notaCredito` against the official XSD, signature on its own root, the same
 * queue and the same answers. It is written here by raw SQL from an invoice
 * the double authorised —billing's issuance has its own test—, as the
 * credit-note service will leave it.
 */
describe('SRI-085, SRI-087 la nota de crédito por el camino de la factura', () => {
  async function anAuthorisedInvoice() {
    const { invoice, voucher } = await aSignedVoucher();
    await dispatch.run('SEND', voucher.id);
    await dispatch.run('AUTHORISE', voucher.id);
    expect((await invoiceRow(invoice.id)).status).toBe('AUTHORISED');
    return invoice;
  }

  async function aCreditNoteOf(invoiceId: string): Promise<string> {
    const [charge] = await prisma.chargeItem.findMany({ where: { invoiceId } });
    return prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "credit_note"
          ("invoice_id", "site_id", "emission_point_id", "sequential",
           "reason_code", "reason",
           "buyer_identification_type", "buyer_identification", "buyer_name",
           "buyer_email",
           "subtotal_taxed", "subtotal_untaxed", "discount_total", "tax_total",
           "amount", "status", "issued_by_id", "issued_at", "updated_at")
        VALUES (${invoiceId}::uuid, ${siteId}::uuid, ${emissionPointId}::uuid,
                '000000001', 'RECEIVER_DATA', 'Error en los datos del receptor',
                '05', '1710034065', 'Guamán Andrade, María José',
                'maria@example.com', 0, ${charge!.unitAmount}, 0, 0,
                ${charge!.unitAmount}, 'ISSUED', ${userId}::uuid,
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING "id"`;
      await tx.$executeRaw`
        INSERT INTO "credit_note_line"
          ("credit_note_id", "charge_item_id", "service_code", "description",
           "quantity", "unit_amount", "discount_amount", "tax_sri_code",
           "tax_percentage", "net_amount", "tax_amount")
        VALUES (${row!.id}::uuid, ${charge!.id}::uuid, 'CONS-MG-PV',
                ${charge!.serviceDisplay}, 1, ${charge!.unitAmount}, 0,
                ${charge!.taxSriCode}, ${charge!.taxPercentage},
                ${charge!.unitAmount}, 0)`;
      return row!.id;
    });
  }

  const NOTE_XSD_DIR = 'src/modules/sri/infrastructure/xsd';

  it('SRI-085 SRI-087 la nota de crédito toma su clave 04, su XML válido y firmado, y el SRI la autoriza', async () => {
    const invoice = await anAuthorisedInvoice();
    const creditNoteId = await aCreditNoteOf(invoice.id);

    const voucher = await preparation.prepareCreditNoteVoucher(creditNoteId);
    expect(voucher?.status).toBe('SIGNED');
    expect(voucher!.document).toEqual({ kind: 'CREDIT_NOTE', creditNoteId });

    const stored = await prisma.electronicVoucher.findUniqueOrThrow({
      where: { creditNoteId },
    });
    expect(stored.documentType).toBe('04');
    expect(stored.accessKey.slice(8, 10)).toBe('04');
    // Its own series and sequential: the credit note's, not the invoice's.
    expect(stored.accessKey.slice(30, 39)).toBe('000000001');
    expect(
      (
        await prisma.creditNote.findUniqueOrThrow({
          where: { id: creditNoteId },
        })
      ).accessKey,
    ).toBe(stored.accessKey);

    // The XML names the invoice by ITS key, and passes the official XSD.
    const invoiceKey = (await invoiceRow(invoice.id)).accessKey!;
    expect(stored.unsignedXml).toContain(
      `<numDocModificado>001-001-${invoiceKey.slice(30, 39)}</numDocModificado>`,
    );
    const { validateXML } = await import('xmllint-wasm');
    const result = await validateXML({
      xml: [{ fileName: 'nc.xml', contents: stored.signedXml! }],
      schema: [
        {
          fileName: 'NotaCredito_V1.1.0.xsd',
          contents: readFileSync(
            `${NOTE_XSD_DIR}/NotaCredito_V1.1.0.xsd`,
            'utf8',
          ),
        },
      ],
      preload: [
        {
          fileName: 'xmldsig-core-schema.xsd',
          contents: readFileSync(
            `${NOTE_XSD_DIR}/xmldsig-core-schema.xsd`,
            'utf8',
          ),
        },
      ],
    });
    expect(result.errors).toEqual([]);

    await dispatch.run('SEND', stored.id);
    await dispatch.run('AUTHORISE', stored.id);

    const note = await prisma.creditNote.findUniqueOrThrow({
      where: { id: creditNoteId },
    });
    expect(note.status).toBe('AUTHORISED');
    // The invoice it modifies is not touched: it stays authorised (BI-096).
    expect((await invoiceRow(invoice.id)).status).toBe('AUTHORISED');
  });

  it('SRI-087 SRI-058 una nota de crédito devuelta queda REJECTED, y al reenviarla vuelve a ISSUED con la misma clave', async () => {
    const invoice = await anAuthorisedInvoice();
    const creditNoteId = await aCreditNoteOf(invoice.id);
    const voucher = (await preparation.prepareCreditNoteVoucher(creditNoteId))!;

    double.setScenario(voucher.accessKey, 'RETURNED_35');
    await dispatch.run('SEND', voucher.id);
    expect(
      (
        await prisma.creditNote.findUniqueOrThrow({
          where: { id: creditNoteId },
        })
      ).status,
    ).toBe('REJECTED');

    const unsignedXml = await preparation.recompose(voucher);
    expect(unsignedXml).toContain('<notaCredito id="comprobante"');
    await new PrismaElectronicVoucherRepository(
      prisma as unknown as PrismaService,
    ).reopen(voucher.id, unsignedXml!);

    const reopened = await prisma.creditNote.findUniqueOrThrow({
      where: { id: creditNoteId },
    });
    expect(reopened.status).toBe('ISSUED');
    expect(reopened.accessKey).toBe(voucher.accessKey);
  });

  /** The credit note of an authorised invoice, itself authorised by the double. */
  async function anAuthorisedCreditNote() {
    const invoice = await anAuthorisedInvoice();
    const creditNoteId = await aCreditNoteOf(invoice.id);
    const voucher = (await preparation.prepareCreditNoteVoucher(creditNoteId))!;
    await dispatch.run('SEND', voucher.id);
    await dispatch.run('AUTHORISE', voucher.id);
    return { invoice, creditNoteId, voucher };
  }

  it('SRI-089 autorizada, el receptor recibe una vez el RIDE de la nota de crédito y su XML autorizado', async () => {
    const { creditNoteId, voucher } = await anAuthorisedCreditNote();
    const before = mailer.sent.length;

    await dispatch.run('DELIVER', voucher.id);

    expect(mailer.sent).toHaveLength(before + 1);
    const message = mailer.last()!;
    expect(message.to).toBe('maria@example.com');
    expect(message.subject).toMatch(
      /^Nota de crédito electrónica 001-001-000000001 — /,
    );
    expect(message.text).toContain('la nota de crédito electrónica');
    expect(
      message.attachments?.map((a) => [a.fileName, a.contentType]),
    ).toEqual([
      [`RIDE-NC-${creditNoteId}.pdf`, 'application/pdf'],
      [`${voucher.accessKey}.xml`, 'application/xml'],
    ]);
    const xml = message.attachments![1]!.content.toString('utf8');
    expect(xml).toContain(
      `<numeroAutorizacion>${voucher.accessKey}</numeroAutorizacion>`,
    );
    expect(xml).toContain('<notaCredito');
    expect(
      (
        await prisma.electronicVoucher.findUniqueOrThrow({
          where: { creditNoteId },
        })
      ).deliveryStatus,
    ).toBe('SENT');

    // SRI-075. A second job does not send it again, and the sweep no longer
    // has it as undelivered.
    await dispatch.run('DELIVER', voucher.id);
    expect(mailer.sent).toHaveLength(before + 1);
    const work = await new PrismaElectronicVoucherRepository(
      prisma as unknown as PrismaService,
    ).pendingWork(200, NOW(), settings.environment);
    expect(work.undelivered.map((one) => one.id)).not.toContain(voucher.id);
  });

  it('SRI-089 SRI-071 el RIDE archivado de la nota de crédito: su número, la factura que modifica, el motivo y su autorización', async () => {
    const { invoice, creditNoteId, voucher } = await anAuthorisedCreditNote();
    const service = prisma as unknown as PrismaService;
    const reader = new PrismaDocumentSourceReader(
      service,
      'https://clinica.example/verificar',
    );
    const subject = await reader.findSubject({
      kind: 'CREDIT_NOTE_RIDE',
      subjectId: creditNoteId,
      sites: [siteId],
    });
    if (subject?.kind !== 'CREDIT_NOTE_RIDE') throw new Error('no subject');
    const invoiceKey = (await invoiceRow(invoice.id)).accessKey!;
    expect(subject.data).toMatchObject({
      documentNumber: '001-001-000000001',
      accessKey: voucher.accessKey,
      status: 'AUTHORISED',
      reason: 'Error en los datos del receptor',
      modifiedDocument: {
        number: `001-001-${invoiceKey.slice(30, 39)}`,
        issuedAt: (await invoiceRow(invoice.id)).issuedAt,
      },
    });
    expect(subject.data.authorisedAt).not.toBeNull();
    expect(subject.data.lines).toHaveLength(1);

    // DOC-012. Out of the caller's sites, it does not exist.
    await expect(
      reader.findSubject({
        kind: 'CREDIT_NOTE_RIDE',
        subjectId: creditNoteId,
        sites: [(await createSite(prisma)).id],
      }),
    ).resolves.toBeNull();

    // Filed on the INVOICE RIDE's template: there is no other.
    const documents = new PrismaDocumentRepository(service);
    const template = await documents.publishTemplate({
      kind: 'INVOICE_RIDE',
      accentColour: '#0f6b5c',
      footerText: null,
      headerFields: [],
      showEstablishmentRuc: true,
      showEstablishmentAddress: true,
      showEstablishmentPhone: true,
      publishedById: userId,
    });
    const stored = await new DocumentService(
      documents,
      reader,
      new PdfKitDocumentRenderer(),
    ).emit(
      { kind: 'CREDIT_NOTE_RIDE', subjectId: creditNoteId },
      { userId, sites: [siteId] },
    );
    const row = await prisma.documentRender.findUniqueOrThrow({
      where: { id: stored.id },
    });
    expect(row).toMatchObject({
      kind: 'CREDIT_NOTE_RIDE',
      creditNoteId,
      invoiceId: null,
      templateId: template.id,
    });
    expect(Buffer.from(row.content).subarray(0, 5).toString('latin1')).toBe(
      '%PDF-',
    );
  });

  it('SRI-089 DOC-003 la base admite el RIDE de la nota de crédito con su nota de crédito, y lo rechaza con la factura', async () => {
    const invoice = await anAuthorisedInvoice();
    const creditNoteId = await aCreditNoteOf(invoice.id);
    const template = await new PrismaDocumentRepository(
      prisma as unknown as PrismaService,
    ).publishTemplate({
      kind: 'INVOICE_RIDE',
      accentColour: '#0f6b5c',
      footerText: null,
      headerFields: [],
      showEstablishmentRuc: true,
      showEstablishmentAddress: true,
      showEstablishmentPhone: true,
      publishedById: userId,
    });
    const pdf = Buffer.from('%PDF-1.4 prueba');
    const sha = createHash('sha256').update(pdf).digest('hex');
    const insert = (column: 'credit_note_id' | 'invoice_id', id: string) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "document_render"
           ("kind", "template_id", "template_version", "${column}",
            "site_id", "content", "byte_size", "sha256", "issued_by_id")
         VALUES ('CREDIT_NOTE_RIDE', $1::uuid, 1, $2::uuid, $3::uuid,
                 $4::bytea, $5, $6, $7::uuid)`,
        template.id,
        id,
        siteId,
        pdf,
        pdf.byteLength,
        sha,
        userId,
      );

    // Positive control: the same statement, with its own subject, is stored.
    await expect(insert('credit_note_id', creditNoteId)).resolves.toBe(1);

    await expect(insert('invoice_id', invoice.id)).rejects.toThrow(
      /document_render_kind_matches_subject/,
    );
  });

  it('SRI-087 el barrido prepara la nota de crédito que nadie preparó', async () => {
    const invoice = await anAuthorisedInvoice();
    const creditNoteId = await aCreditNoteOf(invoice.id);

    await dispatch.sweep();

    const stored = await prisma.electronicVoucher.findUniqueOrThrow({
      where: { creditNoteId },
    });
    expect(stored.status).toBe('SIGNED');
  });
});
