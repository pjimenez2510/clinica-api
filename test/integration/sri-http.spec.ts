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
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';
import { createTestPkcs12 } from '../support/test-pkcs12';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';
import { giveSiteAnIssuer } from './setup/sri-fixtures';

/**
 * SRI-058 to SRI-068, SRI-080 to SRI-083, SRI-060 over HTTP: the permission of
 * every route, the scope by site, and the contract of every error code.
 *
 * The application boots with the queue OFF and NO web-service URL
 * (`test-env.ts`): nothing here reaches any SRI. A signed voucher therefore
 * waits SIGNED — which is SRI-054, and is what the monitor must say.
 */
const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  status: number;
  code: string;
  title: string;
}

describe('el comprobante electrónico por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let cashierToken: string;
  let adminToken: string;
  let receptionToken: string;
  let otherCashierToken: string;
  let siteId: string;
  let patientId: string;
  let payerId: string;
  let serviceId: string;
  let emissionPointId: string;

  const api = () => request(app.getHttpServer());

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

    const site = await createSite(prisma);
    await giveSiteAnIssuer(prisma, site.id);
    const other = await createSite(prisma, 'Sede Sur');
    siteId = site.id;
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
      await prisma.emissionPoint.create({ data: { siteId, code: '001' } })
    ).id;

    cashierToken = await signIn(
      'caja@clinica.ec',
      'CAJA',
      siteId,
      '1710034065',
    );
    adminToken = await signIn('admin@clinica.ec', 'ADMIN', null, '1712345675');
    receptionToken = await signIn(
      'recepcion@clinica.ec',
      'RECEPCION',
      siteId,
      '0102030400',
    );
    otherCashierToken = await signIn(
      'caja.sur@clinica.ec',
      'CAJA',
      other.id,
      '0912345675',
    );
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

  async function uploadCertificate(
    p12 = createTestPkcs12({ now: new Date() }),
    password = p12.password,
  ) {
    return api()
      .post('/api/v1/sri/certificates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ pkcs12Base64: p12.pkcs12.toString('base64'), password });
  }

  async function issueInvoice(paymentMethod = '01'): Promise<{
    id: string;
    accessKey: string | null;
    electronic: { voucherId: string; state: string; accessKey: string } | null;
  }> {
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
        billableServiceId: serviceId,
        serviceDate: clinicalDateOf(new Date()),
      })
      .expect(201);
    const invoice = await api()
      .post(`/api/v1/billing/sites/${siteId}/invoices`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({
        accountId,
        emissionPointId,
        paymentMethod,
        receiver: {
          identificationType: '05',
          identification: '1710034065',
          name: 'Guamán Andrade, María José',
          email: 'maria@example.com',
        },
      })
      .expect(201);
    return invoice.body as Awaited<ReturnType<typeof issueInvoice>>;
  }

  describe('SRI-060 la factura emitida trae su estado electrónico', () => {
    it('SRI-060 SRI-001 al emitir con certificado, la respuesta trae la clave y el comprobante firmado', async () => {
      await uploadCertificate().then((r) => expect(r.status).toBe(201));
      const invoice = await issueInvoice();

      expect(invoice.accessKey).toMatch(/^[0-9]{49}$/);
      expect(invoice.electronic).toMatchObject({
        state: 'SIGNED',
        accessKey: invoice.accessKey,
      });
    });

    it('SRI-041 SRI-060 sin certificado la factura se emite igual (201) y dice por qué espera', async () => {
      const invoice = await issueInvoice();
      expect(invoice.electronic).toMatchObject({
        state: 'PREPARED',
        accessKey: invoice.accessKey,
      });
      const listed = await api()
        .get(`/api/v1/billing/sites/${siteId}/invoices/${invoice.id}`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);
      expect(
        (listed.body as { electronic: { blockedReason: string } }).electronic
          .blockedReason,
      ).toBe('NO_CERTIFICATE');
    });
  });

  describe('BI-170 la forma de pago se declara al emitir', () => {
    it('BI-170 sin forma de pago no se emite (422 sobre paymentMethod) y no se supone ninguna', async () => {
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
          billableServiceId: serviceId,
          serviceDate: clinicalDateOf(new Date()),
        })
        .expect(201);
      const refused = await api()
        .post(`/api/v1/billing/sites/${siteId}/invoices`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          accountId,
          emissionPointId,
          receiver: {
            identificationType: '05',
            identification: '1710034065',
            name: 'Guamán Andrade, María José',
          },
        })
        .expect(422);
      expect(JSON.stringify(refused.body)).toContain('paymentMethod');
      expect(await prisma.invoice.count()).toBe(0);
    });

    it('BI-170 SRI-017 la forma elegida viaja en la factura y en el XML del comprobante', async () => {
      await uploadCertificate();
      const invoice = await issueInvoice('19');
      expect((invoice as { paymentMethod?: string }).paymentMethod).toBe('19');
      const voucher = await prisma.electronicVoucher.findUniqueOrThrow({
        where: { invoiceId: invoice.id },
      });
      expect(voucher.signedXml).toContain('<formaPago>19</formaPago>');
    });
  });

  describe('SRI-061 a SRI-068 el monitor', () => {
    it('SRI-061 SRI-063 SRI-054 SRI-082 caja ve el comprobante firmado que espera, sin URL del SRI, y la vigencia del certificado sin su titular', async () => {
      await uploadCertificate();
      const invoice = await issueInvoice();

      const response = await api()
        .get('/api/v1/sri/vouchers')
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);
      const body = response.body as {
        rows: {
          invoiceId: string;
          status: string;
          needsAPerson: boolean;
          accessKey: string;
        }[];
        certificate: {
          active: Record<string, string> | null;
          aboutToExpire: boolean;
        };
        webServiceConfigured: boolean;
      };
      expect(body.webServiceConfigured).toBe(false);
      // SRI-082. Caja sees until when signing works, not whose certificate.
      expect(Object.keys(body.certificate.active!).sort()).toEqual([
        'notAfter',
        'notBefore',
      ]);
      expect(JSON.stringify(body)).not.toContain('FIRMANTE DE PRUEBA');
      expect(body.rows).toContainEqual(
        expect.objectContaining({
          invoiceId: invoice.id,
          status: 'SIGNED',
          needsAPerson: false,
          accessKey: invoice.accessKey,
        }),
      );
    });

    it('SRI-008 SRI-062 una factura sin comprobante por falta de dato va primero y dice cuál falta', async () => {
      await prisma.site.update({
        where: { id: siteId },
        data: { sriEstablishmentCode: null },
      });
      const invoice = await issueInvoice();
      expect(invoice.electronic).toBeNull();

      const response = await api()
        .get('/api/v1/sri/vouchers')
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);
      const [first] = (
        response.body as {
          rows: {
            invoiceId: string;
            status: string;
            missingData: string[];
            needsAPerson: boolean;
          }[];
        }
      ).rows;
      expect(first).toMatchObject({
        invoiceId: invoice.id,
        status: 'NO_VOUCHER',
        needsAPerson: true,
        missingData: ['SRI_ESTABLISHMENT_CODE'],
      });
    });

    it('SRI-064 recepción no ve el monitor (403) y caja de otra sede no ve los de esta', async () => {
      await uploadCertificate();
      const invoice = await issueInvoice();
      await api()
        .get('/api/v1/sri/vouchers')
        .set('Authorization', `Bearer ${receptionToken}`)
        .expect(403);

      const other = await api()
        .get('/api/v1/sri/vouchers')
        .set('Authorization', `Bearer ${otherCashierToken}`)
        .expect(200);
      expect(
        (other.body as { rows: { invoiceId: string }[] }).rows.map(
          (r) => r.invoiceId,
        ),
      ).not.toContain(invoice.id);
    });

    it('SRI-067 el monitor no trae ningún dato clínico', async () => {
      await uploadCertificate();
      await issueInvoice();
      const response = await api()
        .get('/api/v1/sri/vouchers')
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);
      const keys = new Set(
        Object.keys((response.body as { rows: object[] }).rows[0]!),
      );
      for (const clinical of [
        'diagnosis',
        'reason',
        'chiefComplaint',
        'encounterId',
        'patientId',
      ]) {
        expect(keys.has(clinical)).toBe(false);
      }
    });

    it('SRI-058 SRI-066 caja reintenta un devuelto: vuelve a firmado con la misma clave, la factura a ISSUED, y queda en la bitácora', async () => {
      await uploadCertificate();
      const invoice = await issueInvoice();
      const voucherId = invoice.electronic!.voucherId;
      await prisma.$executeRaw`
        UPDATE "electronic_voucher" SET "status" = 'RETURNED',
               "last_messages" = '[{"identifier":"35","message":"ARCHIVO NO CUMPLE ESTRUCTURA XML","additionalInformation":null,"type":"ERROR"}]'
         WHERE "id" = ${voucherId}::uuid`;
      await prisma.$executeRaw`UPDATE "invoice" SET "status" = 'REJECTED' WHERE "id" = ${invoice.id}::uuid`;

      await api()
        .post(`/api/v1/sri/vouchers/${voucherId}/retry`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(204);

      const voucher = await prisma.electronicVoucher.findUniqueOrThrow({
        where: { id: voucherId },
      });
      expect(voucher.status).toBe('SIGNED');
      expect(voucher.accessKey).toBe(invoice.accessKey);
      expect(
        (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
          .status,
      ).toBe('ISSUED');
      expect(
        await prisma.accessAudit.count({
          where: {
            resourceType: 'electronic_voucher',
            resourceId: voucherId,
            action: 'UPDATE',
          },
        }),
      ).toBe(1);
    });

    it('SRI-058 SRI_VOUCHER_NOT_RETRIABLE (409) para lo que no está devuelto ni rechazado', async () => {
      await uploadCertificate();
      const invoice = await issueInvoice();
      const response = await api()
        .post(`/api/v1/sri/vouchers/${invoice.electronic!.voucherId}/retry`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(409);
      expect((response.body as Problem).code).toBe('SRI_VOUCHER_NOT_RETRIABLE');
      expect((response.body as Problem).title).toMatch(/cola/);
    });

    it('SRI-065 SRI_VOUCHER_NOT_FOUND (404) igual para uno de otra sede que para uno inexistente', async () => {
      await uploadCertificate();
      const invoice = await issueInvoice();
      const foreign = await api()
        .post(`/api/v1/sri/vouchers/${invoice.electronic!.voucherId}/retry`)
        .set('Authorization', `Bearer ${otherCashierToken}`)
        .expect(404);
      const missing = await api()
        .post('/api/v1/sri/vouchers/01900000-0000-7000-8000-000000000000/retry')
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(404);
      expect((foreign.body as Problem).code).toBe('SRI_VOUCHER_NOT_FOUND');
      const { code, title, status } = missing.body as Problem;
      expect(foreign.body).toMatchObject({ code, title, status });
    });

    it('SRI-064 recepción no puede reintentar (403)', async () => {
      await api()
        .post('/api/v1/sri/vouchers/01900000-0000-7000-8000-000000000000/retry')
        .set('Authorization', `Bearer ${receptionToken}`)
        .expect(403);
    });

    it('SRI-068 descarga el XML firmado; el autorizado no existe todavía', async () => {
      await uploadCertificate();
      const invoice = await issueInvoice();
      const voucherId = invoice.electronic!.voucherId;
      const signed = await api()
        .get(`/api/v1/sri/vouchers/${voucherId}/xml/firmado`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);
      expect(signed.headers['content-type']).toContain('application/xml');
      expect(signed.text).toContain('<factura id="comprobante"');
      expect(signed.text).toContain('ds:Signature');

      await api()
        .get(`/api/v1/sri/vouchers/${voucherId}/xml/autorizado`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(404);
    });
  });

  describe('SRI-080 a SRI-083 el certificado desde la administración', () => {
    it('SRI-080 SRI-082 administración lo carga y ve titular, emisor y vigencia, nunca el contenido', async () => {
      const response = await uploadCertificate().then((r) => {
        expect(r.status).toBe(201);
        return r;
      });
      const body = response.body as Record<string, unknown>;
      expect(body.subject).toContain('FIRMANTE DE PRUEBA');
      expect(body.active).toBe(true);
      expect(Object.keys(body)).not.toContain('encryptedPkcs12');
      expect(JSON.stringify(body)).not.toContain('clave-de-prueba');

      const listed = await api()
        .get('/api/v1/sri/certificates')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(listed.body).toHaveLength(1);
      expect(
        await prisma.accessAudit.count({
          where: { resourceType: 'signing_certificate', action: 'CREATE' },
        }),
      ).toBe(1);
    });

    it('SRI-080 cargar otro desactiva el anterior y lo conserva', async () => {
      await uploadCertificate();
      await uploadCertificate();
      const rows = await prisma.signingCertificate.findMany();
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.active)).toHaveLength(1);
    });

    it('SRI-082 caja no ve ni carga certificados (403)', async () => {
      await api()
        .get('/api/v1/sri/certificates')
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(403);
    });

    it('SRI-081 SRI_CERTIFICATE_INVALID (422) con la clave equivocada, sin decir cuál de las dos cosas falló', async () => {
      const response = await uploadCertificate(undefined, 'no-es-la-clave');
      expect(response.status).toBe(422);
      expect((response.body as Problem).code).toBe('SRI_CERTIFICATE_INVALID');
      expect((response.body as Problem).title).toBe(
        'El archivo no es un certificado .p12 válido o la clave no corresponde',
      );
    });

    it('SRI-033 SRI_CERTIFICATE_EXPIRED (422) para un certificado ya caducado', async () => {
      const expired = createTestPkcs12({
        now: new Date(),
        validFromDays: -400,
        validForDays: 365,
      });
      const response = await uploadCertificate(expired);
      expect(response.status).toBe(422);
      expect((response.body as Problem).code).toBe('SRI_CERTIFICATE_EXPIRED');
    });

    it('SRI-083 SRI_CERTIFICATE_TOO_LARGE (422) antes de abrir el fichero', async () => {
      const response = await api()
        .post('/api/v1/sri/certificates')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          pkcs12Base64: Buffer.alloc(64 * 1024 + 1, 7).toString('base64'),
          password: 'x',
        });
      expect(response.status).toBe(422);
      expect((response.body as Problem).code).toBe('SRI_CERTIFICATE_TOO_LARGE');
    });
  });

  describe('OR-027, OR-028 los datos del emisor desde la administración', () => {
    it('OR-027 administración guarda el código SRI de la sede con su cero y rechaza otra forma', async () => {
      const saved = await api()
        .patch(`/api/v1/organization/sites/${siteId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ sriEstablishmentCode: '002' })
        .expect(200);
      expect(
        (saved.body as { sriEstablishmentCode: string }).sriEstablishmentCode,
      ).toBe('002');

      const refused = await api()
        .patch(`/api/v1/organization/sites/${siteId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ sriEstablishmentCode: '2' })
        .expect(422);
      expect(JSON.stringify(refused.body)).toContain('sriEstablishmentCode');
      expect(
        (await prisma.site.findUniqueOrThrow({ where: { id: siteId } }))
          .sriEstablishmentCode,
      ).toBe('002');
    });

    it('OR-030 dos sedes del mismo RUC no comparten el código SRI; con otro código sí se guarda', async () => {
      const own = await prisma.site.findUniqueOrThrow({
        where: { id: siteId },
      });
      const sibling = await createSite(prisma, 'Sede del mismo RUC');
      await prisma.site.update({
        where: { id: sibling.id },
        data: { establishmentId: own.establishmentId },
      });

      const refused = await api()
        .patch(`/api/v1/organization/sites/${sibling.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ sriEstablishmentCode: own.sriEstablishmentCode })
        .expect(409);
      expect((refused.body as Problem).code).toBe(
        'SRI_ESTABLISHMENT_CODE_DUPLICATE',
      );

      // Control: a code nobody else under the RUC has is accepted.
      const free = own.sriEstablishmentCode === '009' ? '008' : '009';
      await api()
        .patch(`/api/v1/organization/sites/${sibling.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ sriEstablishmentCode: free })
        .expect(200);
    });

    it('OR-030 compara el RUC con que la sede factura de verdad: heredado o escrito, es el mismo', async () => {
      const own = await prisma.site.findUniqueOrThrow({
        where: { id: siteId },
        include: { establishment: true },
      });
      const issuerRuc = own.ruc ?? own.establishment.ruc!;
      const sibling = await createSite(prisma, 'Sede con el RUC escrito');
      const rejectionOf = (promise: Promise<unknown>) =>
        promise.then(
          () => null,
          (error: unknown) => String((error as Error).message),
        );

      // The site above inherits the establishment's RUC; this one WRITES it.
      expect(
        await rejectionOf(prisma.$executeRaw`
          UPDATE "site"
             SET "establishment_id" = ${own.establishmentId}::uuid,
                 "ruc" = ${issuerRuc},
                 "sri_establishment_code" = ${own.sriEstablishmentCode}
           WHERE "id" = ${sibling.id}::uuid`),
      ).toMatch(/site_sri_establishment_code_unique_per_ruc/);

      // Control: under ANOTHER RUC the same code is that RUC's own 001.
      const otherRuc = `${issuerRuc.slice(0, 10)}${issuerRuc.slice(10) === '002' ? '003' : '002'}`;
      await expect(prisma.$executeRaw`
        UPDATE "site"
           SET "establishment_id" = ${own.establishmentId}::uuid,
               "ruc" = ${otherRuc},
               "sri_establishment_code" = ${own.sriEstablishmentCode}
         WHERE "id" = ${sibling.id}::uuid`).resolves.toBe(1);

      // And the establishment cannot take that RUC: its inheriting site would
      // then collide with the sibling.
      expect(
        await rejectionOf(prisma.$executeRaw`
          UPDATE "establishment" SET "ruc" = ${otherRuc}
           WHERE "id" = ${own.establishmentId}::uuid`),
      ).toMatch(/site_sri_establishment_code_unique_per_ruc/);
    });

    it('OR-029 administración guarda las banderas fiscales y el comprobante las declara', async () => {
      const establishment = await api()
        .get('/api/v1/organization/establishment')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const current = establishment.body as {
        mspUnicode: string;
        typology: string;
        legalName: string;
      };
      const saved = await api()
        .put('/api/v1/organization/establishment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          ...current,
          keepsAccounting: true,
          specialTaxpayerResolution: '5368',
          rimpeRegime: 'ENTREPRENEUR',
        })
        .expect(200);
      expect(saved.body).toMatchObject({
        keepsAccounting: true,
        specialTaxpayerResolution: '5368',
        rimpeRegime: 'ENTREPRENEUR',
      });

      await uploadCertificate();
      const invoice = await issueInvoice();
      const voucher = await prisma.electronicVoucher.findUniqueOrThrow({
        where: { invoiceId: invoice.id },
      });
      expect(voucher.signedXml).toContain(
        '<obligadoContabilidad>SI</obligadoContabilidad>',
      );
      expect(voucher.signedXml).toContain(
        '<contribuyenteEspecial>5368</contribuyenteEspecial>',
      );
      expect(voucher.signedXml).toContain(
        '<contribuyenteRimpe>CONTRIBUYENTE RÉGIMEN RIMPE</contribuyenteRimpe>',
      );

      await api()
        .put('/api/v1/organization/establishment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...current, specialTaxpayerResolution: '12A' })
        .expect(422);
    });

    it('OR-028 un guardado del establecimiento sin la dirección de la matriz no la borra', async () => {
      const establishment = await api()
        .get('/api/v1/organization/establishment')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const current = establishment.body as {
        mspUnicode: string;
        typology: string;
        legalName: string;
        headOfficeAddress: string;
      };
      expect(current.headOfficeAddress).toBe(
        'Av. Amazonas y Naciones Unidas, Quito',
      );

      await api()
        .put('/api/v1/organization/establishment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mspUnicode: current.mspUnicode,
          typology: current.typology,
          legalName: current.legalName,
        })
        .expect(200);
      const after = await api()
        .put('/api/v1/organization/establishment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mspUnicode: current.mspUnicode,
          typology: current.typology,
          legalName: current.legalName,
          headOfficeAddress: 'Calle Nueva 123, Quito',
        })
        .expect(200);
      expect(
        (after.body as { headOfficeAddress: string }).headOfficeAddress,
      ).toBe('Calle Nueva 123, Quito');
    });
  });
});
