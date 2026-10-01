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
import { startSriDouble, type SriDouble } from '../sri-double/sri-double';
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
  settings = {
    environment: '1',
    paymentMethod: '01',
    softwareProviderRuc: null,
  };

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
  dispatch = new VoucherDispatchService(
    vouchers,
    web,
    queue,
    {
      issueRide: (invoiceId) =>
        Promise.resolve({
          content: Buffer.from('%PDF-1.4 RIDE de prueba'),
          fileName: `RIDE-${invoiceId}.pdf`,
        }),
    },
    mailer,
    NOW,
    preparation,
    silentLogger,
  );
  certificates = new SigningCertificateService(
    certificateRows,
    new ForgePkcs12Inspector(),
    cipher,
    { record: () => Promise.resolve() },
    NOW,
    preparation,
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

async function loadCertificate(): Promise<void> {
  const p12 = createTestPkcs12({ now: NOW() });
  await certificates.upload(p12.pkcs12, p12.password, { userId });
}

async function issueInvoice(email: string | null = 'maria@example.com') {
  const account = await prisma.patientAccount.create({
    data: { patientId, siteId, payerId, priceListId },
  });
  await accounts.addCharge({
    accountId: account.id,
    billableServiceId: serviceId,
    encounterId: null,
    serviceDate: clinicalDateOf(NOW()),
    quantity: Quantity.ONE,
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

    await loadCertificate();

    const signed = await voucherOf(invoice.id);
    expect(signed.status).toBe('SIGNED');
    expect(signed.accessKey).toBe(waiting.accessKey);
    expect(signed.signedXml).toContain('ds:SignatureValue');
  });

  it('SRI-017 sin forma de pago declarada no firma, y lo dice', async () => {
    await loadCertificate();
    settings.paymentMethod = null;
    const invoice = await issueInvoice();
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

  it('SC-071 en todo el recorrido cada intento lleva la clave con que nació el comprobante', async () => {
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

  it('SRI-040 SC-072 el worker real lleva el comprobante solo de firmado a autorizado y entregado', async () => {
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
    expect(final).toMatchObject({ status: 'AUTHORISED', deliveryStatus: 'SENT' });
    expect((await invoiceRow(invoice.id)).status).toBe('AUTHORISED');
    await (await connection.instance()).offWork(QUEUE_NAMES.SEND);
    await (await connection.instance()).offWork(QUEUE_NAMES.AUTHORISE);
    await (await connection.instance()).offWork(QUEUE_NAMES.DELIVER);
  }, 40_000);
});
