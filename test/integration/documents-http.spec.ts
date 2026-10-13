import { createHash, randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import sharp from 'sharp';
import request from 'supertest';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { clinicalDateOf } from '../../src/shared/domain/clinic-time';

import { useDatabase } from './setup/database';
import {
  createDiagnosis,
  createExamService,
  createIssuedPrescription,
  createPatient,
  createSite,
  createUser,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * The printable document as the browser consumes it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ADDS OVER `documents-immutable.spec.ts`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That file proves what PostgreSQL guarantees. This one proves everything
 * BETWEEN the browser and the database, and four things in particular that no
 * double can show:
 *
 *   - THE PDF THAT COMES OUT IS A REAL PDF/A (DOC-020), composed end to end
 *     from rows this test wrote.
 *   - REPRINTING SERVES THE STORED BYTES (DOC-006): the same `sha256`, and the
 *     `ETag` to prove the file cannot change.
 *   - THE RIDE IS NOT REACHABLE WITH `record:read` (DOC-090), even with the
 *     right identifier. The permission is on the ROUTE and the kind is in the
 *     ROW, and the accounts below sign in for real with the roles the seed
 *     ships.
 *   - AN SVG IS REFUSED (DOC-051), by its BYTES, whatever it says it is.
 */
const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

interface RenderBody {
  id: string;
  kind: string;
  subjectId: string;
  sha256: string;
  byteSize: number;
  pdfProfile: string;
  templateVersion: number;
  supersedesId: string | null;
  supersedeReason: string | null;
}

describe('los documentos por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let establishmentId: string;
  let practitionerId: string;
  let prescriptionId: string;
  let doctorToken: string;
  let cashierToken: string;
  let adminToken: string;

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

    await seed();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function seed(): Promise<void> {
    await syncAuthorisation(prisma);
    registry.invalidate();

    const establishment = await prisma.establishment.create({
      data: {
        mspUnicode: `E${Date.now()}`,
        typology: 'CENTRO DE ESPECIALIDADES',
        legalName: 'Centro de Especialidades Bahía',
        ruc: '0993123456001',
        keepsAccounting: true,
        rimpeRegime: 'ENTREPRENEUR',
      },
    });
    establishmentId = establishment.id;

    const site = await createSite(prisma);
    await prisma.site.update({
      where: { id: site.id },
      data: { establishmentId: establishment.id },
    });
    siteId = site.id;

    const patient = await createPatient(prisma, {
      // A fourteen-month-old: the case in which art. 5.b.ii demands years AND
      // months on the printed receta.
      birthDate: new Date('2025-07-12'),
    });

    const doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    doctorToken = doctor.token;
    practitionerId = doctor.practitionerId as string;
    cashierToken = (
      await signIn('CAJA', 'caja@clinica.ec', '0926687856', false)
    ).token;
    adminToken = (
      await signIn('ADMIN', 'admin@clinica.ec', '1104637283', false)
    ).token;

    const encounter = await prisma.encounter.create({
      data: {
        siteId,
        practitionerId,
        patientId: patient.id,
        startedAt: new Date('2026-09-14T14:00:00Z'),
        careModality: 'MORBIDITY',
        visitSequence: 'FIRST_TIME',
      },
    });

    const prescription = await createIssuedPrescription(prisma, {
      encounterId: encounter.id,
      siteId: encounter.siteId,
      prescriberId: practitionerId,
      status: 'ACTIVE',
      issuedAt: new Date('2026-08-21T01:00:00Z'), // fecha-fija: la receta de la semilla, emitida antes de cualquier corrida
      items: {
        create: [
          {
            genericName: 'Amoxicilina',
            presentation: 'Cápsula',
            concentration: '500 mg',
            routeCode: 'ORAL',
            quantity: 20,
            doseText: '1 cápsula',
            frequencyText: 'Cada 8 horas',
            durationDays: 7,
            instructions: 'Tomar con alimentos',
            offFormularyJustification: 'Fuera del CNMB para esta prueba',
          },
        ],
      },
    });

    prescriptionId = prescription.id;
  }

  async function signIn(
    roleCode: string,
    email: string,
    cedula: string,
    withPractitioner = true,
  ): Promise<{ token: string; practitionerId?: string }> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Ana',
        lastName: 'Villacís',
        cedula,
        acessRegistration: withPractitioner ? `ACESS-${cedula}` : null,
        acessExpiresOn: withPractitioner ? new Date('2030-01-01') : null,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });

    const practitioner = withPractitioner
      ? await prisma.practitioner.create({ data: { userId: user.id } })
      : undefined;

    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId },
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return {
      token: (response.body as { accessToken: string }).accessToken,
      practitionerId: practitioner?.id,
    };
  }

  const post = (path: string, token: string, body?: object) =>
    request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body ?? {});

  const get = (path: string, token: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`);

  /** DOC-037. Nothing can be emitted until a version exists. */
  async function publishTemplate(kind = 'PRESCRIPTION'): Promise<void> {
    await post('/documents/templates', adminToken, {
      kind,
      accentColour: '#1f6f8b',
      footerText: 'Centro de Especialidades Bahía',
      headerFields: [{ label: 'Permiso ACESS', value: '0000-0000' }],
      showEstablishmentRuc: true,
    }).expect(201);
  }

  describe('DOC-037 sin plantilla no hay documento, y no se inventa una', () => {
    it('DOC-037 rechaza emitir mientras no haya versión publicada', async () => {
      const response = await post('/documents/renders', doctorToken, {
        kind: 'PRESCRIPTION',
        subjectId: prescriptionId,
      }).expect(422);

      expect((response.body as Problem).code).toBe(
        'DOCUMENT_TEMPLATE_NOT_PUBLISHED',
      );
    });

    it('DOC-030 publicar dos veces produce la versión 1 y la 2', async () => {
      await publishTemplate();
      const second = await post('/documents/templates', adminToken, {
        kind: 'PRESCRIPTION',
        accentColour: '#003366',
      }).expect(201);

      expect((second.body as { version: number }).version).toBe(2);
    });

    it('DOC-032 no existe ninguna ruta que edite una versión publicada', async () => {
      await publishTemplate();
      const templates = await get('/documents/templates', adminToken).expect(
        200,
      );
      const first = (templates.body as { id: string }[])[0];

      // There is no PATCH and no PUT: correcting the letterhead is publishing a
      // new version, and the previous one keeps saying what last March's
      // recetas were printed with.
      await request(app.getHttpServer())
        .patch(`/api/v1/documents/templates/${first?.id ?? 'x'}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ accentColour: '#000000' })
        .expect(404);
    });
  });

  describe('DOC-038, DOC-039 vista previa y publicación de la identidad', () => {
    const slots = {
      accentColour: '#7a3b2e',
      footerText: 'Pie de la vista previa',
      headerFields: [],
      showEstablishmentRuc: true,
    };

    it('DOC-038 AU-061 la vista previa devuelve el PDF de muestra con la identidad real y no guarda nada', async () => {
      const response = await post('/documents/templates/preview', adminToken, {
        kind: 'PRESCRIPTION',
        ...slots,
      })
        .buffer()
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(response.headers['content-type']).toContain('application/pdf');
      // AU-061: the handler's own header wins over the no-store default.
      expect(response.headers['cache-control']).toBe('no-store, private');
      const proxy = await getDocumentProxy(
        new Uint8Array(response.body as Buffer),
      );
      const { text } = await extractText(proxy, { mergePages: true });
      expect(text).toContain('Centro de Especialidades Bahía');
      expect(text).toContain('MUESTRA');
      expect(text).toContain('Pie de la vista previa');

      await expect(prisma.documentRender.count()).resolves.toBe(0);
      await expect(prisma.documentTemplate.count()).resolves.toBe(0);
    });

    it('DOC-038 la vista previa rechaza una ranura inválida y nombra el campo', async () => {
      const response = await post('/documents/templates/preview', adminToken, {
        kind: 'PRESCRIPTION',
        ...slots,
        accentColour: 'granate',
      }).expect(422);

      expect(
        (response.body as Problem).errors?.map((error) => error.field),
      ).toContain('accentColour');
    });

    it('DOC-090 la vista previa exige config:read: el médico no la ve', async () => {
      await post('/documents/templates/preview', adminToken, {
        kind: 'PRESCRIPTION',
        ...slots,
      }).expect(200);

      await post('/documents/templates/preview', doctorToken, {
        kind: 'PRESCRIPTION',
        ...slots,
      }).expect(403);
    });

    it('DOC-039 DOC-113 publica la versión siguiente de las cinco clases a la vez', async () => {
      await publishTemplate('PRESCRIPTION');

      const response = await post(
        '/documents/templates/all-kinds',
        adminToken,
        slots,
      ).expect(201);

      const published = response.body as { kind: string; version: number }[];
      expect(
        published.map((one) => `${one.kind}:${one.version}`).sort(),
      ).toEqual([
        'ENCOUNTER_SUMMARY:1',
        'INVOICE_RIDE:1',
        'MEDICAL_CERTIFICATE:1',
        'PRESCRIPTION:2',
        'SERVICE_ORDER:1',
      ]);
      await expect(prisma.documentTemplate.count()).resolves.toBe(6);
    });

    it('DOC-039 si una inserción falla EN LA BASE, no queda publicada ninguna', async () => {
      // Positive control: the same request publishes five.
      await post('/documents/templates/all-kinds', adminToken, slots).expect(
        201,
      );
      await expect(prisma.documentTemplate.count()).resolves.toBe(5);

      // The THIRD insert fails inside PostgreSQL, after the first two went
      // through: only a real transaction leaves none of the three behind.
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION test_refuse_certificate() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'refused by the test'; END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER test_refuse_certificate BEFORE INSERT ON document_template
        FOR EACH ROW WHEN (NEW.kind = 'MEDICAL_CERTIFICATE')
        EXECUTE FUNCTION test_refuse_certificate()`);
      try {
        const refused = await post(
          '/documents/templates/all-kinds',
          adminToken,
          { ...slots, accentColour: '#003366' },
        );
        expect(refused.status).toBeGreaterThanOrEqual(400);
        await expect(prisma.documentTemplate.count()).resolves.toBe(5);
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER test_refuse_certificate ON document_template',
        );
        await prisma.$executeRawUnsafe(
          'DROP FUNCTION test_refuse_certificate()',
        );
      }
    });

    it('DOC-035 DOC-039 una ranura inválida no publica ninguna', async () => {
      await post('/documents/templates/all-kinds', adminToken, {
        ...slots,
        accentColour: '#ZZZZZZ',
      }).expect(422);
      await expect(prisma.documentTemplate.count()).resolves.toBe(0);
    });

    it('DOC-090 publicar las cuatro exige config:manage', async () => {
      await post('/documents/templates/all-kinds', doctorToken, slots).expect(
        403,
      );
      await expect(prisma.documentTemplate.count()).resolves.toBe(0);
    });
  });

  describe('DOC-094 a DOC-096 la verificación pública', () => {
    const verify = (code: string) =>
      request(app.getHttpServer()).get(`/api/v1/documents/verify/${code}`);

    /**
     * A receta issued for this test, with the code it needs. The seeded one is
     * not edited: once issued, a receta only changes its status
     * (`prescription_frozen`).
     */
    async function issuedReceta(
      data: Partial<{ verificationCode: string; issuedAt: Date; status: 'ACTIVE' | 'CANCELLED' }>, // prettier-ignore
    ): Promise<void> {
      const seeded = await prisma.prescription.findUniqueOrThrow({
        where: { id: prescriptionId },
        select: { encounterId: true, siteId: true, prescriberId: true },
      });
      await createIssuedPrescription(prisma, {
        ...seeded,
        status: 'ACTIVE',
        issuedAt: new Date(),
        ...data,
        items: {
          create: {
            genericName: 'Amoxicilina',
            doseText: '1 cápsula',
            frequencyText: 'Cada 8 horas',
            offFormularyJustification: 'Fuera del CNMB para esta prueba',
          },
        },
      });
    }

    it('DOC-094 AU-061 sin sesión dice clase, fecha, establecimiento, sede, profesional y vigencia', async () => {
      const issuedAt = new Date();
      await issuedReceta({ verificationCode: 'ABCD1234EF567890', issuedAt });

      const response = await verify('ABCD1234EF567890').expect(200);

      expect(response.body).toMatchObject({
        kind: 'PRESCRIPTION',
        issuedOn: clinicalDateOf(issuedAt),
        establishmentName: 'Centro de Especialidades Bahía',
        status: 'VALID',
        annulledOn: null,
      });
      // AU-061: public, but its status changes when the receta is annulled;
      // a cache must never answer «vigente» for one that no longer is.
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('DOC-094 una receta pasada su vigencia se dice caducada', async () => {
      // The seeded receta was issued weeks before any run of this suite.
      await issuedReceta({
        verificationCode: 'ABCD1234EF567890',
        issuedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      });

      const response = await verify('ABCD1234EF567890').expect(200);
      expect((response.body as { status: string }).status).toBe('EXPIRED');
    });

    it('DOC-094 el código se acepta escrito en minúsculas', async () => {
      await issuedReceta({
        verificationCode: 'ABCD1234EF567890',
        issuedAt: new Date(),
      });
      await verify('abcd1234ef567890').expect(200);
    });

    it('DOC-096 una receta en borrador con código responde como un código inexistente', async () => {
      const unknown = await verify('ZZZZ9999ZZZZ9999').expect(404);
      await issuedReceta({
        verificationCode: 'ABCD1234EF567890',
        issuedAt: new Date(),
      });
      // Positive control: an issued receta is found by its code.
      await verify('ABCD1234EF567890').expect(200);

      // A draft with a code of its own. An issued receta cannot go back to
      // draft: its number stays (`prescription_number_only_when_issued`).
      const issued = await prisma.prescription.findUniqueOrThrow({
        where: { id: prescriptionId },
        select: { encounterId: true, siteId: true, prescriberId: true },
      });
      await prisma.prescription.create({
        data: {
          ...issued,
          status: 'DRAFT',
          verificationCode: 'DRAF1234DRAF5678',
        },
      });
      const draft = await verify('DRAF1234DRAF5678').expect(404);

      expect((draft.body as Problem).code).toBe((unknown.body as Problem).code);
      expect((draft.body as Problem).title).toBe(
        (unknown.body as Problem).title,
      );
    });

    it('DOC-094 un certificado revocado se dice anulado con su fecha', async () => {
      const encounter = await prisma.encounter.findFirstOrThrow({
        select: { id: true, patientId: true, siteId: true },
      });
      const revokedAt = new Date();
      await prisma.medicalCertificate.create({
        data: {
          encounterId: encounter.id,
          siteId: encounter.siteId,
          patientId: encounter.patientId,
          issuedById: practitionerId,
          type: 'ATTENDANCE',
          verificationCode: 'CERT1234CERT5678',
          revokedAt,
          revokedById: (
            await prisma.practitioner.findUniqueOrThrow({
              where: { id: practitionerId },
              select: { userId: true },
            })
          ).userId,
          revocationReason: 'Emitido por error en la prueba',
        },
      });

      const response = await verify('CERT1234CERT5678').expect(200);
      expect(response.body).toMatchObject({
        kind: 'MEDICAL_CERTIFICATE',
        status: 'ANNULLED',
        annulledOn: clinicalDateOf(revokedAt),
      });
    });

    it('DOC-095 la respuesta no lleva nada del paciente', async () => {
      await issuedReceta({ verificationCode: 'ABCD1234EF567890' });
      const patient = await prisma.patient.findFirstOrThrow({
        select: { familyName: true, givenName: true },
      });

      const response = await verify('ABCD1234EF567890').expect(200);
      const body = JSON.stringify(response.body);

      expect(Object.keys(response.body as object).sort()).toEqual([
        'annulledOn',
        'establishmentName',
        'issuedOn',
        'kind',
        'practitionerName',
        'siteName',
        'status',
      ]);
      expect(body).not.toContain(patient.familyName);
      expect(body).not.toContain(patient.givenName);
      expect(body).not.toContain('Amoxicilina');
    });

    it('DOC-094 una receta anulada se dice anulada', async () => {
      await issuedReceta({
        verificationCode: 'ABCD1234EF567890',
        status: 'CANCELLED',
      });

      const response = await verify('ABCD1234EF567890').expect(200);
      expect((response.body as { status: string }).status).toBe('ANNULLED');
    });

    it('DOC-094 ORD-006 el código impreso en una orden se verifica, y se dice anulada sin exámenes que hacer', async () => {
      const encounter = await prisma.encounter.findFirstOrThrow({
        select: { id: true, siteId: true },
      });
      const system = await prisma.catalogSystem.create({
        data: { code: 'EXAMENES-DOC094', name: 'Exámenes de la prueba' },
      });
      const concept = await prisma.catalogConcept.create({
        data: {
          systemId: system.id,
          code: 'BH',
          display: 'Biometría hemática completa',
          validFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
        select: { id: true },
      });
      const order = await prisma.serviceOrder.create({
        data: {
          encounterId: encounter.id,
          siteId: encounter.siteId,
          orderedById: practitionerId,
          category: 'LABORATORY',
          items: {
            create: {
              conceptId: concept.id,
              testCode: 'BH',
              testDisplay: 'Biometría hemática completa',
            },
          },
        },
        select: { id: true, verificationCode: true, requestedAt: true },
      });
      // ORD-100. Only an issued order is verified: lines in while a draft.
      await prisma.serviceOrder.update({
        where: { id: order.id },
        data: { status: 'ISSUED' },
      });

      // Positive control: the same code, while the exam is still to be done.
      const valid = await verify(order.verificationCode).expect(200);
      expect(valid.body).toMatchObject({
        kind: 'SERVICE_ORDER',
        issuedOn: clinicalDateOf(order.requestedAt),
        status: 'VALID',
        annulledOn: null,
      });
      expect(JSON.stringify(valid.body)).not.toContain('Biometría');

      await prisma.serviceOrderItem.updateMany({
        where: { serviceOrderId: order.id },
        data: {
          status: 'CANCELLED',
          cancelledById: (await createUser(prisma)).id,
        },
      });
      const annulled = await verify(order.verificationCode).expect(200);
      expect((annulled.body as { status: string }).status).toBe('ANNULLED');
    });

    it('DOC-096 un código inventado y uno sin forma dicen exactamente lo mismo', async () => {
      // Positive control: the route exists and answers a real code.
      await issuedReceta({ verificationCode: 'ABCD1234EF567890' });
      await verify('ABCD1234EF567890').expect(200);

      const unknown = await verify('ZZZZ9999ZZZZ9999').expect(404);
      const malformed = await verify('x%20y').expect(404);

      // `instance` and `traceId` differ in every problem+json and say nothing
      // about the document; everything else must match.
      const comparable = (body: unknown) => {
        const problem = body as Record<string, unknown>;
        return [problem.status, problem.code, problem.title, problem.detail];
      };
      expect((unknown.body as Problem).code).toBe(
        'DOCUMENT_VERIFICATION_NOT_FOUND',
      );
      expect(comparable(malformed.body)).toEqual(comparable(unknown.body));
    });
  });

  describe('DOC-001, DOC-002 el borrador y la emisión', () => {
    beforeEach(async () => {
      await publishTemplate();
    });

    it('DOC-001 el borrador devuelve un PDF y no archiva nada', async () => {
      const response = await post('/documents/drafts', doctorToken, {
        kind: 'PRESCRIPTION',
        subjectId: prescriptionId,
      })
        .buffer()
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(response.headers['content-type']).toContain('application/pdf');
      expect((response.body as Buffer).subarray(0, 8).toString()).toBe(
        '%PDF-1.4',
      );
      await expect(prisma.documentRender.count()).resolves.toBe(0);
    });

    it('DOC-091 el borrador deja fila de bitácora aunque no archive', async () => {
      await post('/documents/drafts', doctorToken, {
        kind: 'PRESCRIPTION',
        subjectId: prescriptionId,
      }).expect(200);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'document' },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]?.action).toBe('PRINT');
    });

    it('DOC-002, DOC-020 emite el artefacto, con su huella y su perfil PDF/A', async () => {
      const response = await post('/documents/renders', doctorToken, {
        kind: 'PRESCRIPTION',
        subjectId: prescriptionId,
      }).expect(201);

      const render = response.body as RenderBody;
      expect(render.kind).toBe('PRESCRIPTION');
      expect(render.subjectId).toBe(prescriptionId);
      expect(render.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(render.pdfProfile).toBe('PDF/A-1b');
      expect(render.templateVersion).toBe(1);
      expect(render.byteSize).toBeGreaterThan(1000);
    });

    it('DOC-021 el PDF emitido lleva la fuente incrustada y no nombra Helvetica', async () => {
      // The end-to-end version of the assertion that pays for
      // `embedded-fonts.ts`: this file was composed from real rows, through the
      // real controller, and it still has to be PDF/A.
      const emitted = await post('/documents/renders', doctorToken, {
        kind: 'PRESCRIPTION',
        subjectId: prescriptionId,
      }).expect(201);

      const stored = await prisma.documentRender.findUniqueOrThrow({
        where: { id: (emitted.body as RenderBody).id },
      });
      const raw = Buffer.from(stored.content).toString('latin1');

      expect(raw).toContain('FontFile2');
      expect(raw).toContain('pdfaid');
      expect(raw).not.toContain('Helvetica');
    });

    it('DOC-072 el PDF emitido contiene lo que el art. 5 obliga', async () => {
      // The text is subset-encoded inside the PDF, so what is asserted here is
      // that the LAYOUT the renderer was handed carried the fields — through a
      // second draft whose bytes differ exactly when the content differs.
      const withData = await post('/documents/renders', doctorToken, {
        kind: 'PRESCRIPTION',
        subjectId: prescriptionId,
      }).expect(201);

      // The same receta without its medicine: another one, issued without
      // lines — an issued receta's lines never change (`prescription_frozen`).
      const seeded = await prisma.prescription.findUniqueOrThrow({
        where: { id: prescriptionId },
        select: { encounterId: true, siteId: true, prescriberId: true, issuedAt: true }, // prettier-ignore
      });
      const bare = await prisma.prescription.create({
        data: { ...seeded, status: 'ACTIVE' },
      });

      const withoutData = await post('/documents/renders', doctorToken, {
        kind: 'PRESCRIPTION',
        subjectId: bare.id,
      }).expect(201);

      // Removing the only medicine changes the file. If the composition ignored
      // the lines, the two would be the same size.
      expect((withData.body as RenderBody).byteSize).not.toBe(
        (withoutData.body as RenderBody).byteSize,
      );
    });

    /** The text a reader sees in a PDF served by the API. */
    async function pdfText(path: string, body?: object): Promise<string> {
      const call =
        body === undefined ? get(path, doctorToken) : post(path, doctorToken, body); // prettier-ignore
      const response = await call
        .buffer()
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const proxy = await getDocumentProxy(
        new Uint8Array(response.body as Buffer),
      );
      return (await extractText(proxy, { mergePages: true })).text;
    }

    it('ORD-125 ORD-126 ORD-129 el PDF real de la orden agrupa por sección del 010A, lleva el sexo y nombra el examen de cada indicación', async () => {
      await publishTemplate('SERVICE_ORDER');
      const encounter = await prisma.encounter.findFirstOrThrow({
        select: { id: true, siteId: true, patient: { select: { sex: true } } },
      });
      const system = await prisma.catalogSystem.create({
        data: { code: 'EXAMENES-ORD126', name: 'Exámenes de la prueba' },
      });
      const exams = [
        { code: 'LAB-GLU-126', name: 'Glucosa en ayunas', section: 'BIOQUÍMICA', preparation: 'Ayuno de 8 a 12 horas. Puede beber agua.', fastingHours: 8 }, // prettier-ignore
        { code: 'LAB-BH-126', name: 'Biometría hemática completa', section: 'HEMATOLOGÍA', preparation: 'No requiere ayuno.', fastingHours: null }, // prettier-ignore
      ];
      const items = [];
      for (const exam of exams) {
        // BI-284. The exam is a service; DOC-072 reads its order extension
        // by the code the line froze.
        await createExamService(prisma, {
          code: exam.code,
          name: exam.name,
          exam: {
            form010Section: exam.section,
            patientPreparation: exam.preparation,
            // ORD-129. The fast is the exam's datum, read at print time.
            requiresFasting: exam.fastingHours !== null,
            fastingHours: exam.fastingHours,
          },
        });
        const concept = await prisma.catalogConcept.create({
          data: {
            systemId: system.id,
            code: exam.code,
            display: exam.name,
            validFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
          select: { id: true },
        });
        items.push({ conceptId: concept.id, testCode: exam.code, testDisplay: exam.name }); // prettier-ignore
      }
      const order = await prisma.serviceOrder.create({
        data: {
          encounterId: encounter.id,
          siteId: encounter.siteId,
          orderedById: practitionerId,
          category: 'LABORATORY',
          items: { create: items },
        },
        select: { id: true },
      });
      await prisma.serviceOrder.update({
        where: { id: order.id },
        data: { status: 'ISSUED' },
      });

      const text = await pdfText('/documents/drafts', {
        kind: 'SERVICE_ORDER',
        subjectId: order.id,
      });

      expect(text).toContain('BIOQUÍMICA');
      expect(text).toContain('HEMATOLOGÍA');
      expect(text.indexOf('BIOQUÍMICA')).toBeLessThan(text.indexOf('HEMATOLOGÍA')); // prettier-ignore
      expect(text).toContain('Sexo');
      expect(text).toContain('Venga con 8 horas de ayuno como mínimo (Glucosa en ayunas).'); // prettier-ignore
      expect(text).not.toContain('No requiere ayuno');
      expect(text).not.toContain('Preparación');
    });

    /** The text a reader sees in the draft of this test's receta. */
    async function draftText(): Promise<string> {
      const response = await post('/documents/drafts', doctorToken, {
        kind: 'PRESCRIPTION',
        subjectId: prescriptionId,
      })
        .buffer()
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const proxy = await getDocumentProxy(
        new Uint8Array(response.body as Buffer),
      );
      return (await extractText(proxy, { mergePages: true })).text;
    }

    it('CER-042 el 117 anulado dice «ANULADO el …» en el papel y nunca el motivo', async () => {
      const issued = await prisma.prescription.findUniqueOrThrow({
        where: { id: prescriptionId },
        select: { encounter: { select: { id: true, patientId: true, siteId: true, practitionerId: true } } }, // prettier-ignore
      });
      const doctor = await prisma.practitioner.findUniqueOrThrow({
        where: { id: issued.encounter.practitionerId },
        select: { userId: true },
      });
      const reason = 'Era F32 y no J06, motivo centinela';
      const revokedAt = new Date();
      const certificate = await prisma.medicalCertificate.create({
        data: {
          encounterId: issued.encounter.id,
          siteId: issued.encounter.siteId,
          patientId: issued.encounter.patientId,
          issuedById: issued.encounter.practitionerId,
          type: 'ATTENDANCE',
          verificationCode: 'ANUL1234ANUL5678',
          revokedAt,
          revokedById: doctor.userId,
          revocationReason: reason,
        },
      });

      await publishTemplate('MEDICAL_CERTIFICATE');
      const response = await post('/documents/drafts', doctorToken, {
        kind: 'MEDICAL_CERTIFICATE',
        subjectId: certificate.id,
      })
        .buffer()

        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const { text } = await extractText(
        await getDocumentProxy(new Uint8Array(response.body as Buffer)),
        { mergePages: true },
      );

      const revokedOn = clinicalDateOf(revokedAt)
        .split('-')
        .reverse()
        .join('/');
      expect(text).toContain(`ANULADO el ${revokedOn}`);
      expect(text).not.toContain('centinela');
      expect(text).not.toContain('F32');
    });

    it('DOC-081 con una sola sede activa la cabecera no lleva línea de sede, y con dos sí', async () => {
      const site = await prisma.site.findUniqueOrThrow({
        where: { id: siteId },
      });
      expect(await draftText()).not.toContain('Unicódigo');

      const other = await createSite(prisma);
      await prisma.site.update({
        where: { id: other.id },
        data: { establishmentId },
      });

      expect(await draftText()).toContain(
        `${site.name} · Unicódigo ${site.mspUnicode}`,
      );

      // A deactivated site does not count: nobody walks into it.
      await prisma.site.update({
        where: { id: other.id },
        data: { active: false },
      });
      expect(await draftText()).not.toContain('Unicódigo');
    });

    it('DOC-102 la cabecera nombra la clínica con la razón social del establecimiento, no con la sede', async () => {
      const site = await prisma.site.findUniqueOrThrow({
        where: { id: siteId },
        select: { name: true },
      });
      await prisma.site.update({
        where: { id: siteId },
        data: { name: 'Sucursal Malecón' },
      });

      const text = await draftText();
      expect(text).toContain('Centro de Especialidades Bahía');
      expect(text).not.toContain('Sucursal Malecón');

      await prisma.site.update({ where: { id: siteId }, data: site });
    });

    it('DOC-104 D-078 la receta impresa lleva el número de historia clínica del paciente', async () => {
      const { encounter } = await prisma.prescription.findUniqueOrThrow({
        where: { id: prescriptionId },
        select: { encounter: { select: { patient: { select: { mrn: true } } } } }, // prettier-ignore
      });
      const text = await draftText();
      // Control: the band is there, labelled, and holds THIS chart's number.
      expect(text).toContain('HISTORIA CLÍNICA');
      expect(text).toContain(encounter.patient.mrn);
    });

    it('DOC-080 OR-010 la cabecera imprime el nombre comercial, el correo y el permiso guardados', async () => {
      await prisma.establishment.update({
        where: { id: establishmentId },
        data: {
          tradeName: 'Bahía Especialidades',
          contactEmail: 'contacto@example.com',
          operatingPermit: 'ACESS-2026-0456',
        },
      });

      const text = await draftText();
      expect(text).toContain('Bahía Especialidades');
      expect(text).toContain('contacto@example.com');
      expect(text).toContain('Permiso de funcionamiento ACESS-2026-0456');
    });

    it('DOC-014 se niega a archivar una receta en borrador, pero sí la previsualiza', async () => {
      const issued = await prisma.prescription.findUniqueOrThrow({
        where: { id: prescriptionId },
      });
      const draft = await prisma.prescription.create({
        data: {
          encounterId: issued.encounterId,
          siteId: issued.siteId,
          prescriberId: practitionerId,
          status: 'DRAFT',
        },
      });

      const refused = await post('/documents/renders', doctorToken, {
        kind: 'PRESCRIPTION',
        subjectId: draft.id,
      }).expect(409);
      expect((refused.body as Problem).code).toBe(
        'DOCUMENT_SUBJECT_NOT_ISSUABLE',
      );

      await post('/documents/drafts', doctorToken, {
        kind: 'PRESCRIPTION',
        subjectId: draft.id,
      }).expect(200);
    });

    it('DOC-006 reimprimir sirve los BYTES guardados, con el sha256 como ETag', async () => {
      const emitted = (
        await post('/documents/renders', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
        }).expect(201)
      ).body as RenderBody;

      const download = await get(
        `/documents/renders/${emitted.id}/content`,
        doctorToken,
      )
        .buffer()
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(download.headers.etag).toBe(`"${emitted.sha256}"`);
      expect((download.body as Buffer).byteLength).toBe(emitted.byteSize);
      const { createHash } = await import('node:crypto');
      expect(
        createHash('sha256')
          .update(download.body as Buffer)
          .digest('hex'),
      ).toBe(emitted.sha256);
    });

    it('DOC-091 descargar el artefacto deja fila de bitácora con quién', async () => {
      const emitted = (
        await post('/documents/renders', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
        }).expect(201)
      ).body as RenderBody;

      await get(`/documents/renders/${emitted.id}/content`, doctorToken).expect(
        200,
      );

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'document' },
        orderBy: { occurredAt: 'asc' },
      });
      expect(trail.map((row) => row.action)).toEqual(['CREATE', 'PRINT']);
    });

    it('DOC-092 los metadatos NO dejan fila de bitácora', async () => {
      const emitted = (
        await post('/documents/renders', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
        }).expect(201)
      ).body as RenderBody;

      await get(`/documents/renders/${emitted.id}`, doctorToken).expect(200);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'document' },
      });
      expect(trail.map((row) => row.action)).toEqual(['CREATE']);
    });

    it('DOC-008 un segundo original del mismo documento se rechaza: se corrige el primero', async () => {
      // Control positivo: el primero se archiva.
      await post('/documents/renders', doctorToken, {
        kind: 'PRESCRIPTION',
        subjectId: prescriptionId,
      }).expect(201);

      const second = await post('/documents/renders', doctorToken, {
        kind: 'PRESCRIPTION',
        subjectId: prescriptionId,
      }).expect(409);
      expect((second.body as Problem).code).toBe('DOCUMENT_ALREADY_EMITTED');
      await expect(
        prisma.documentRender.count({ where: { prescriptionId } }),
      ).resolves.toBe(1);
    });

    it('DOC-008 tampoco hay dos originales de una orden ni de un certificado', async () => {
      await publishTemplate('SERVICE_ORDER');
      await publishTemplate('MEDICAL_CERTIFICATE');
      const encounter = await prisma.encounter.findFirstOrThrow({
        select: { id: true, siteId: true, patientId: true },
      });
      const order = await prisma.serviceOrder.create({
        data: {
          encounterId: encounter.id,
          siteId: encounter.siteId,
          orderedById: practitionerId,
          category: 'LABORATORY',
          // ORD-100. Only an issued order is printed.
          status: 'ISSUED',
        },
      });
      const certificate = await prisma.medicalCertificate.create({
        data: {
          encounterId: encounter.id,
          siteId: encounter.siteId,
          patientId: encounter.patientId,
          issuedById: practitionerId,
          type: 'ATTENDANCE',
          verificationCode: 'ORIG1234ORIG5678',
        },
      });

      for (const [kind, subjectId] of [
        ['SERVICE_ORDER', order.id],
        ['MEDICAL_CERTIFICATE', certificate.id],
      ] as const) {
        // Control positivo: el primero se archiva.
        await post('/documents/renders', doctorToken, { kind, subjectId }).expect(201); // prettier-ignore
        const second = await post('/documents/renders', doctorToken, {
          kind,
          subjectId,
        }).expect(409);
        expect((second.body as Problem).code).toBe('DOCUMENT_ALREADY_EMITTED');
      }
    });

    it('DOC-007 corregir emite otro documento que anula al anterior', async () => {
      const first = (
        await post('/documents/renders', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
        }).expect(201)
      ).body as RenderBody;

      const second = (
        await post('/documents/renders/supersede', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
          supersedesId: first.id,
          reason: 'Se corrigió la posología de la primera línea',
        }).expect(201)
      ).body as RenderBody;

      expect(second.supersedesId).toBe(first.id);

      // AND THE FIRST ONE IS STILL SERVED, unchanged.
      const original = (
        await get(`/documents/renders/${first.id}`, doctorToken).expect(200)
      ).body as RenderBody;
      expect(original.sha256).toBe(first.sha256);
      expect(original.supersedesId).toBeNull();
    });

    it('DOC-007 el historial devuelve los dos, el vigente y el anulado', async () => {
      const first = (
        await post('/documents/renders', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
        }).expect(201)
      ).body as RenderBody;
      await post('/documents/renders/supersede', doctorToken, {
        kind: 'PRESCRIPTION',
        subjectId: prescriptionId,
        supersedesId: first.id,
        reason: 'Se corrigió la posología de la primera línea',
      }).expect(201);

      const history = await get(
        `/documents/subjects/PRESCRIPTION/${prescriptionId}/renders`,
        doctorToken,
      ).expect(200);

      expect(history.body as RenderBody[]).toHaveLength(2);
    });

    it('DOC-108 corregir sin motivo: el servidor pone el suyo, y uno escrito se guarda tal cual', async () => {
      const first = (
        await post('/documents/renders', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
        }).expect(201)
      ).body as RenderBody;

      const automatic = (
        await post('/documents/renders/supersede', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
          supersedesId: first.id,
        }).expect(201)
      ).body as RenderBody;
      expect(automatic.supersedesId).toBe(first.id);
      expect(automatic.supersedeReason).toBe('Nueva versión del documento');

      // Control positivo: si llega un motivo, es el que queda.
      const written = (
        await post('/documents/renders/supersede', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
          supersedesId: automatic.id,
          reason: 'Se corrigió la posología de la primera línea',
        }).expect(201)
      ).body as RenderBody;
      expect(written.supersedeReason).toBe(
        'Se corrigió la posología de la primera línea',
      );
    });

    it('DOC-010 un motivo escrito de menos de diez caracteres se rechaza, nombrando el campo', async () => {
      const first = (
        await post('/documents/renders', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
        }).expect(201)
      ).body as RenderBody;

      const refused = await post('/documents/renders/supersede', doctorToken, {
        kind: 'PRESCRIPTION',
        subjectId: prescriptionId,
        supersedesId: first.id,
        reason: 'error',
      }).expect(422);

      expect((refused.body as Problem).code).toBe('VALIDATION_FAILED');
      expect((refused.body as Problem).errors?.[0]?.field).toBe('reason');
      await expect(prisma.documentRender.count()).resolves.toBe(1);
    });

    it('DOC-012 no encuentra el documento de una sede fuera del alcance', async () => {
      const emitted = (
        await post('/documents/renders', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
        }).expect(201)
      ).body as RenderBody;

      // Positive control: inside the scope the SAME identifier is served. Without
      // it a 404 below could come from a mistyped path and prove nothing.
      await get(`/documents/renders/${emitted.id}`, doctorToken).expect(200);

      // The document cannot move — `trg_document_render_immutable` refuses any
      // change to an emitted render — so it is the REQUESTER who moves: the
      // doctor's only grant goes to another site, and a fresh sign-in carries
      // the new scope whether grants travel in the token or are read per call.
      const otherSite = await createSite(prisma, 'Sede Norte');
      const doctor = await prisma.user.findUniqueOrThrow({
        where: { email: 'medico@clinica.ec' },
      });
      await prisma.userRoleGrant.updateMany({
        where: { userId: doctor.id },
        data: { siteId: otherSite.id },
      });
      const outsider = (
        (
          await request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .send({ email: 'medico@clinica.ec', password: PASSWORD })
            .expect(200)
        ).body as { accessToken: string }
      ).accessToken;

      // The real identifier, not a made-up one: this is about scope, and a
      // document that does not exist would answer 404 for another reason.
      const response = await get(
        `/documents/renders/${emitted.id}`,
        outsider,
      ).expect(404);
      // DOC-012: the same answer as a document that does not exist, so probing
      // identifiers one by one confirms nothing about another site.
      expect((response.body as Problem).code).toBe('DOCUMENT_RENDER_NOT_FOUND');
    });
  });

  describe('DOC-109 al anular, el PDF que sustituye al anterior se archiva solo', () => {
    beforeEach(async () => {
      await publishTemplate('PRESCRIPTION');
    });

    /** The text a reader sees in an archived artefact. */
    async function renderText(renderId: string): Promise<string> {
      const response = await get(
        `/documents/renders/${renderId}/content`,
        doctorToken,
      )
        .buffer()
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const proxy = await getDocumentProxy(
        new Uint8Array(response.body as Buffer),
      );
      return (await extractText(proxy, { mergePages: true })).text;
    }

    const historyOf = async (kind: string, subjectId: string) =>
      (
        await get(
          `/documents/subjects/${kind}/${subjectId}/renders`,
          doctorToken,
        ).expect(200)
      ).body as RenderBody[];

    const emitted = async (kind: string, subjectId: string) =>
      (
        await post('/documents/renders', doctorToken, {
          kind,
          subjectId,
        }).expect(201)
      ).body as RenderBody;

    it('DOC-109 PR-108 anular una receta con PDF archiva el que la sustituye, con la marca y «Receta anulada»', async () => {
      const first = await emitted('PRESCRIPTION', prescriptionId);

      const cancelled = await post(
        `/prescriptions/${prescriptionId}/cancel`,
        doctorToken,
        { reason: 'Pérdida' },
      ).expect(200);
      // La pantalla sabe que el PDF con la marca quedó archivado.
      expect(cancelled.body).toMatchObject({
        status: 'CANCELLED',
        documentArchived: true,
      });

      const [latest, original] = await historyOf(
        'PRESCRIPTION',
        prescriptionId,
      );
      expect(original?.id).toBe(first.id);
      expect(latest).toMatchObject({
        supersedesId: first.id,
        supersedeReason: 'Receta anulada',
      });
      expect(await renderText(latest!.id)).toContain('RECETA ANULADA');
      // El anterior sigue archivado, igual.
      expect(original?.sha256).toBe(first.sha256);
    });

    it('DOC-109 una receta sin PDF archivado se anula y no se archiva nada (control positivo)', async () => {
      const cancelled = await post(
        `/prescriptions/${prescriptionId}/cancel`,
        doctorToken,
        { reason: 'Pérdida' },
      ).expect(200);
      // Nada que sustituir: ni éxito ni fallo.
      expect(cancelled.body).toMatchObject({ documentArchived: null });

      await expect(prisma.documentRender.count()).resolves.toBe(0);
    });

    it('DOC-109 si el PDF no se puede archivar, la receta se anula igual', async () => {
      const first = await emitted('PRESCRIPTION', prescriptionId);
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION test_refuse_render_insert()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'test_forced_failure';
        END;
        $$`);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER test_refuse_render_insert
          BEFORE INSERT ON document_render FOR EACH ROW
          EXECUTE FUNCTION test_refuse_render_insert()`);
      try {
        const cancelled = await post(
          `/prescriptions/${prescriptionId}/cancel`,
          doctorToken,
          { reason: 'Robo o hurto' },
        ).expect(200);
        // Había PDF y no se archivó: la pantalla tiene que avisar.
        expect(cancelled.body).toMatchObject({
          status: 'CANCELLED',
          documentArchived: false,
        });
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS test_refuse_render_insert ON document_render',
        );
        await prisma.$executeRawUnsafe(
          'DROP FUNCTION IF EXISTS test_refuse_render_insert()',
        );
      }

      const prescription = await prisma.prescription.findUniqueOrThrow({
        where: { id: prescriptionId },
        select: { status: true, cancelReason: true },
      });
      expect(prescription).toEqual({
        status: 'CANCELLED',
        cancelReason: 'Robo o hurto',
      });
      await expect(prisma.documentRender.count()).resolves.toBe(1);

      // Control positivo: «Corregir…» lo archiva después, con la causa.
      const archived = (
        await post('/documents/renders/supersede', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
          supersedesId: first.id,
        }).expect(201)
      ).body as RenderBody;
      expect(archived.supersedeReason).toBe('Receta anulada');
    });

    it('DOC-109 PR-109 corregir una receta archiva el de la anulada con «Corrección de la receta N.º …»', async () => {
      const first = await emitted('PRESCRIPTION', prescriptionId);
      const { sequenceNumber } = await prisma.prescription.findUniqueOrThrow({
        where: { id: prescriptionId },
        select: { sequenceNumber: true },
      });

      const corrected = await post(
        `/prescriptions/${prescriptionId}/correct`,
        doctorToken,
        { reason: 'Error de prescripción' },
      ).expect(200);
      expect(corrected.body).toMatchObject({ documentArchived: true });

      const [latest] = await historyOf('PRESCRIPTION', prescriptionId);
      expect(latest).toMatchObject({
        supersedesId: first.id,
        supersedeReason: `Corrección de la receta N.º ${sequenceNumber}`,
      });
    });

    it('DOC-109 CER-011 anular un certificado archiva el PDF con su marca y «Certificado anulado»', async () => {
      await publishTemplate('MEDICAL_CERTIFICATE');
      const encounter = await prisma.encounter.findFirstOrThrow({
        select: { id: true, siteId: true, patientId: true },
      });
      const certificate = await prisma.medicalCertificate.create({
        data: {
          encounterId: encounter.id,
          siteId: encounter.siteId,
          patientId: encounter.patientId,
          issuedById: practitionerId,
          type: 'ATTENDANCE',
          verificationCode: 'D109CERT0000ANUL',
        },
      });
      const first = await emitted('MEDICAL_CERTIFICATE', certificate.id);

      const revoked = await post(
        `/certificates/${certificate.id}/revoke`,
        doctorToken,
        { reason: 'Error en las fechas' },
      ).expect(200);
      expect(revoked.body).toMatchObject({ documentArchived: true });

      const [latest] = await historyOf('MEDICAL_CERTIFICATE', certificate.id);
      expect(latest).toMatchObject({
        supersedesId: first.id,
        supersedeReason: 'Certificado anulado',
      });
      const text = await renderText(latest!.id);
      expect(text).toContain('ANULADO el');
      // CER-042: el papel no lleva el motivo de anular.
      expect(text).not.toContain('Error en las fechas');
    });

    it('DOC-109 ORD-007 anular un examen archiva la orden al día, sin él, con «Examen anulado»', async () => {
      await publishTemplate('SERVICE_ORDER');
      const encounter = await prisma.encounter.findFirstOrThrow({
        select: { id: true, siteId: true },
      });
      const system = await prisma.catalogSystem.create({
        data: { code: 'EXAMENES-DOC109', name: 'Exámenes de la prueba' },
      });
      const conceptOf = (code: string, display: string) =>
        prisma.catalogConcept.create({
          data: {
            systemId: system.id,
            code,
            display,
            validFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
          select: { id: true },
        });
      const bh = await conceptOf('BH', 'Biometría hemática completa');
      const glu = await conceptOf('GLU', 'Glucosa en ayunas');
      const order = await prisma.serviceOrder.create({
        data: {
          encounterId: encounter.id,
          siteId: encounter.siteId,
          orderedById: practitionerId,
          category: 'LABORATORY',
          items: {
            create: [
              { conceptId: bh.id, testCode: 'BH', testDisplay: 'Biometría hemática completa' }, // prettier-ignore
              { conceptId: glu.id, testCode: 'GLU', testDisplay: 'Glucosa en ayunas' }, // prettier-ignore
            ],
          },
        },
        select: { id: true, items: { select: { id: true, testCode: true } } },
      });
      await prisma.serviceOrder.update({
        where: { id: order.id },
        data: { status: 'ISSUED' },
      });
      const first = await emitted('SERVICE_ORDER', order.id);
      expect(await renderText(first.id)).toContain('Glucosa en ayunas');

      const glucose = order.items.find((item) => item.testCode === 'GLU')!;
      const cancelled = await post(
        `/orders/${order.id}/items/${glucose.id}/cancel`,
        doctorToken,
      ).expect(200);
      expect(cancelled.body).toMatchObject({ documentArchived: true });

      const [latest] = await historyOf('SERVICE_ORDER', order.id);
      expect(latest).toMatchObject({
        supersedesId: first.id,
        supersedeReason: 'Examen anulado',
      });
      const text = await renderText(latest!.id);
      expect(text).not.toContain('Glucosa en ayunas');
      expect(text).toContain('Biometría hemática completa');

      // ORD-118. «Corregir» la orden archiva otra vez, y lo dice.
      const corrected = await post(
        `/orders/${order.id}/correct`,
        doctorToken,
      ).expect(200);
      expect(corrected.body).toMatchObject({ documentArchived: true });
      const [afterCorrection] = await historyOf('SERVICE_ORDER', order.id);
      expect(afterCorrection?.supersedesId).toBe(latest!.id);
    });
  });

  describe('DOC-090 el RIDE no se sirve con permiso clínico, ni al revés', () => {
    it('DOC-090 quien tiene record:read no alcanza un RIDE ni con su identificador', async () => {
      await publishTemplate('INVOICE_RIDE');

      // An invoice, issued by hand: the dialogue with the SRI is Fase 2 and the
      // RIDE only needs the row to exist and not be a draft.
      const payer = await prisma.payer.create({
        data: { code: 'PARTICULAR', name: 'Particular', kind: 'SELF_PAY' },
      });
      const priceList = await prisma.priceList.create({
        data: { payerId: payer.id, name: 'Vigente' },
      });
      const account = await prisma.patientAccount.create({
        data: {
          patientId: (await prisma.patient.findFirstOrThrow()).id,
          siteId,
          payerId: payer.id,
          priceListId: priceList.id,
        },
      });
      const emissionPoint = await prisma.emissionPoint.create({
        data: { siteId, code: '001', description: 'Caja principal' },
      });
      const invoice = await prisma.invoice.create({
        data: {
          accountId: account.id,
          siteId,
          emissionPointId: emissionPoint.id,
          sequential: '000000001',
          buyerIdentificationType: '05',
          buyerIdentification: '1710034065',
          buyerName: 'Guamán Andrade María José',
          subtotalTaxed: '0.00',
          subtotalUntaxed: '30.00',
          taxTotal: '0.00',
          total: '30.00',
          status: 'ISSUED',
          issuedAt: new Date('2026-08-21T01:00:00Z'),
          issuedById: (
            await prisma.user.findFirstOrThrow({
              where: { email: 'caja@clinica.ec' },
            })
          ).id,
        },
      });

      const ride = (
        await post(
          `/documents/ride/invoices/${invoice.id}`,
          cashierToken,
        ).expect(201)
      ).body as RenderBody;

      // The doctor holds `record:read` and the identifier. The permission is on
      // the ROUTE and the kind is in the ROW: without the kind check, this
      // would hand a tax document to whoever attends.
      const refused = await get(
        `/documents/renders/${ride.id}/content`,
        doctorToken,
      ).expect(404);
      expect((refused.body as Problem).code).toBe('DOCUMENT_RENDER_NOT_FOUND');

      // And the cashier CAN fetch it through its own route.
      await get(`/documents/ride/${ride.id}/content`, cashierToken).expect(200);
    });

    it('DOC-090 quien tiene billing:read no alcanza una receta por la puerta del RIDE', async () => {
      await publishTemplate();
      const receta = (
        await post('/documents/renders', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
        }).expect(201)
      ).body as RenderBody;

      const refused = await get(
        `/documents/ride/${receta.id}/content`,
        cashierToken,
      ).expect(404);
      expect((refused.body as Problem).code).toBe('DOCUMENT_RENDER_NOT_FOUND');
    });

    it('DOC-090 caja no puede emitir un documento clínico', async () => {
      await publishTemplate();
      await post('/documents/renders', cashierToken, {
        kind: 'PRESCRIPTION',
        subjectId: prescriptionId,
      }).expect(403);
    });
  });

  describe('DOC-111 a DOC-113 el resumen de la atención', () => {
    const summaryOf = (encounterId: string, token = doctorToken) =>
      get(`/documents/encounters/${encounterId}/summary`, token);

    /** The seeded attention, with its receta, a diagnosis and a signed 002. */
    async function aSignedAttention(): Promise<string> {
      const { encounterId } = await prisma.prescription.findUniqueOrThrow({
        where: { id: prescriptionId },
        select: { encounterId: true },
      });
      await createDiagnosis(prisma, encounterId, 'J02.9', 'Faringitis aguda, no especificada'); // prettier-ignore
      const chainId = randomUUID();
      await prisma.clinicalNote.create({
        data: {
          id: chainId,
          chainId,
          encounterId,
          formCode: '002',
          formVersion: '1',
          status: 'SIGNED',
          content: {
            motivoConsulta: 'Dolor de garganta de dos días',
            antecedentes: 'Sin antecedentes de importancia',
            enfermedadActual: 'Odinofagia y fiebre',
            revisionOrganosSistemas: 'Sin otros síntomas',
            examenFisico: 'Faringe eritematosa',
            planTratamiento: 'Hidratación y control en 72 horas',
          },
          authorId: practitionerId,
          signedById: practitionerId,
          signedAt: new Date(),
          contentHash: 'a'.repeat(64),
        },
      });
      return encounterId;
    }

    async function summaryText(encounterId: string): Promise<string> {
      const response = await summaryOf(encounterId)
        .buffer()
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(response.headers['content-type']).toContain('application/pdf');
      const proxy = await getDocumentProxy(
        new Uint8Array(response.body as Buffer),
      );
      return (await extractText(proxy, { mergePages: true })).text;
    }

    it('DOC-111 compone al momento el resumen con la nota firmada, el diagnóstico y la receta, y no lo archiva', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const encounterId = await aSignedAttention();

      const text = await summaryText(encounterId);

      expect(text.replace(/\s+/g, ' ')).toContain('RESUMEN DE LA ATENCIÓN');
      expect(text).toContain('Motivo de consulta');
      expect(text).toContain('Dolor de garganta de dos días');
      expect(text).toContain('J02.9');
      expect(text).toContain('Amoxicilina');
      expect(text).toContain('/verificar/');
      await expect(prisma.documentRender.count()).resolves.toBe(0);
    });

    it('DOC-111 cada resumen deja su fila en la bitácora de accesos, con quién y sobre qué atención', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const encounterId = await aSignedAttention();

      await summaryOf(encounterId).expect(200);
      await summaryOf(encounterId).expect(200);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'encounter_summary' },
        select: { resourceId: true, action: true, userId: true },
      });
      expect(trail).toHaveLength(2);
      expect(trail.every((row) => row.resourceId === encounterId)).toBe(true);
      expect(trail.every((row) => row.action === 'PRINT')).toBe(true);
      const { userId: doctorUserId } = await prisma.practitioner.findUniqueOrThrow({ where: { id: practitionerId }, select: { userId: true } }); // prettier-ignore
      expect(trail.every((row) => row.userId === doctorUserId)).toBe(true);
    });

    it('DOC-111 sin nota 002 firmada no hay resumen; con ella sí (control positivo)', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const { encounterId } = await prisma.prescription.findUniqueOrThrow({
        where: { id: prescriptionId },
        select: { encounterId: true },
      });

      const refused = await summaryOf(encounterId).expect(409);
      expect((refused.body as Problem).code).toBe(
        'ENCOUNTER_SUMMARY_NOT_AVAILABLE',
      );
      await expect(
        prisma.accessAudit.count({
          where: { resourceType: 'encounter_summary' },
        }),
      ).resolves.toBe(0);

      // EN-220. La lista de atenciones de la ficha dice cuándo se ofrece.
      const { patientId } = await prisma.encounter.findUniqueOrThrow({
        where: { id: encounterId },
        select: { patientId: true },
      });
      const offered = async () =>
        (
          (
            await get(`/encounters?patientId=${patientId}`, doctorToken).expect(
              200,
            )
          ).body as { items: { id: string; summaryAvailable: boolean }[] }
        ).items.find((item) => item.id === encounterId)?.summaryAvailable;
      expect(await offered()).toBe(false);

      await aSignedAttention();
      await summaryOf(encounterId).expect(200);
      expect(await offered()).toBe(true);
    });

    it('DOC-111 sale sólo lo vigente: la nota enmendada, sin la receta anulada ni el examen anulado (con lo vigente como control)', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const encounterId = await aSignedAttention();
      const now = new Date();
      // La nota se enmienda: la vigente es la versión 2.
      const first = await prisma.clinicalNote.findFirstOrThrow({
        where: { encounterId, formCode: '002' },
        select: { id: true, chainId: true },
      });
      await prisma.clinicalNote.update({ where: { id: first.id }, data: { status: 'SUPERSEDED' } }); // prettier-ignore
      await prisma.clinicalNote.create({
        data: {
          chainId: first.chainId,
          version: 2,
          encounterId,
          formCode: '002',
          formVersion: '1',
          status: 'SIGNED',
          content: { motivoConsulta: 'Tos seca de una semana' },
          authorId: practitionerId,
          signedById: practitionerId,
          signedAt: now,
          contentHash: 'c'.repeat(64),
          supersedesId: first.id,
          amendmentReason: 'Se corrige el motivo',
        },
      });
      // Una receta anulada en la misma atención.
      const seeded = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId }, select: { siteId: true } }); // prettier-ignore
      await createIssuedPrescription(prisma, {
        encounterId,
        siteId: seeded.siteId,
        prescriberId: practitionerId,
        status: 'CANCELLED',
        items: {
          create: [
            { genericName: 'Ibuprofeno', presentation: 'Tableta', concentration: '400 mg', routeCode: 'ORAL', quantity: 10, doseText: '1 tableta', frequencyText: 'Cada 8 horas', durationDays: 3, offFormularyJustification: 'Fuera del CNMB para esta prueba' }, // prettier-ignore
          ],
        },
      });
      // Una orden con un examen vivo y otro anulado.
      const system = await prisma.catalogSystem.create({ data: { code: 'EXAMENES-DOC111', name: 'Exámenes de la prueba' } }); // prettier-ignore
      const concept = await prisma.catalogConcept.create({
        data: { systemId: system.id, code: 'X', display: 'X', validFrom: new Date(now.getTime() - 24 * 60 * 60 * 1000) }, // prettier-ignore
        select: { id: true },
      });
      const order = await prisma.serviceOrder.create({
        data: {
          encounterId,
          siteId: seeded.siteId,
          orderedById: practitionerId,
          category: 'LABORATORY',
          items: {
            create: [
              { conceptId: concept.id, testCode: 'VIVO', testDisplay: 'Proteína C reactiva' }, // prettier-ignore
              { conceptId: concept.id, testCode: 'ANULADO', testDisplay: 'Velocidad de eritrosedimentación' }, // prettier-ignore
            ],
          },
        },
        select: { id: true },
      });
      await prisma.serviceOrder.update({ where: { id: order.id }, data: { status: 'ISSUED' } }); // prettier-ignore
      await prisma.serviceOrderItem.updateMany({
        where: { serviceOrderId: order.id, testCode: 'ANULADO' },
        data: { status: 'CANCELLED', completedAt: now, cancelledById: (await createUser(prisma)).id }, // prettier-ignore
      });

      const text = (await summaryText(encounterId)).replace(/\s+/g, ' ');

      expect(text).toContain('Nota enmendada el');
      expect(text).toContain('Tos seca de una semana');
      expect(text).not.toContain('Dolor de garganta de dos días');
      expect(text).toContain('Amoxicilina');
      expect(text).not.toContain('Ibuprofeno');
      expect(text).toContain('Proteína C reactiva');
      expect(text).not.toContain('Velocidad de eritrosedimentación');
    });

    it('DOC-111 una atención anulada no tiene resumen, y una de otra sede responde como inexistente', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const encounterId = await aSignedAttention();
      const seeded = await prisma.encounter.findUniqueOrThrow({
        where: { id: encounterId },
        select: { patientId: true, practitionerId: true },
      });
      const now = new Date();
      await prisma.encounter.update({
        where: { id: encounterId },
        data: { status: 'ENTERED_IN_ERROR', endedAt: now, enteredInErrorById: (await createUser(prisma)).id, enteredInErrorAt: now }, // prettier-ignore
      });
      const annulled = await summaryOf(encounterId).expect(409);
      expect((annulled.body as Problem).code).toBe(
        'ENCOUNTER_SUMMARY_NOT_AVAILABLE',
      );

      const elsewhere = await createSite(prisma, 'Sede Norte');
      const foreign = await prisma.encounter.create({
        data: { ...seeded, siteId: elsewhere.id, startedAt: now, careModality: 'MORBIDITY', visitSequence: 'SUBSEQUENT' }, // prettier-ignore
        select: { id: true },
      });
      const missing = await summaryOf(foreign.id).expect(404);
      expect((missing.body as Problem).code).toBe('DOCUMENT_SUBJECT_NOT_FOUND');
    });

    it('DOC-090 DOC-111 el resumen exige record:read: caja no lo descarga', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const encounterId = await aSignedAttention();

      await summaryOf(encounterId, cashierToken).expect(403);
    });

    it('DOC-113 sin plantilla publicada para el resumen, lo dice y no inventa una', async () => {
      const encounterId = await aSignedAttention();

      const refused = await summaryOf(encounterId).expect(422);
      expect((refused.body as Problem).code).toBe(
        'DOCUMENT_TEMPLATE_NOT_PUBLISHED',
      );
    });

    it('DOC-112 el código de una atención sin 002 firmada responde como inexistente; con la nota retirada, anulado', async () => {
      const { encounterId } = await prisma.prescription.findUniqueOrThrow({
        where: { id: prescriptionId },
        select: { encounterId: true },
      });
      const { verificationCode } = await prisma.encounter.findUniqueOrThrow({
        where: { id: encounterId },
        select: { verificationCode: true },
      });
      const verifyIt = () =>
        request(app.getHttpServer()).get(`/api/v1/documents/verify/${verificationCode}`); // prettier-ignore

      const unknown = await verifyIt().expect(404);
      expect((unknown.body as Problem).code).toBe(
        'DOCUMENT_VERIFICATION_NOT_FOUND',
      );

      await aSignedAttention();
      expect(((await verifyIt().expect(200)).body as { status: string }).status).toBe('VALID'); // prettier-ignore

      // La nota se retira (EN-026): el papel que salió ya no vale.
      await prisma.clinicalNote.updateMany({
        where: { encounterId, formCode: '002' },
        data: { status: 'ENTERED_IN_ERROR' },
      });
      expect(((await verifyIt().expect(200)).body as { status: string }).status).toBe('ANNULLED'); // prettier-ignore
    });

    it('DOC-112 el código del resumen verifica la atención sin ningún dato del paciente, y la anulada se dice anulada', async () => {
      const encounterId = await aSignedAttention();
      const { verificationCode } = await prisma.encounter.findUniqueOrThrow({
        where: { id: encounterId },
        select: { verificationCode: true },
      });

      const valid = await request(app.getHttpServer())
        .get(`/api/v1/documents/verify/${verificationCode}`)
        .expect(200);
      expect(valid.body).toMatchObject({
        kind: 'ENCOUNTER_SUMMARY',
        status: 'VALID',
      });
      const body = JSON.stringify(valid.body);
      expect(body).not.toContain('J02.9');
      expect(body).not.toContain('1710034065');

      const seeded = await prisma.encounter.findUniqueOrThrow({
        where: { id: encounterId },
        select: { siteId: true, patientId: true, practitionerId: true },
      });
      const now = new Date();
      // Una atención con su 002 firmada, anulada después: el papel que salió
      // de ella tiene que decir que ya no vale.
      const annulled = await prisma.encounter.create({
        data: {
          ...seeded,
          startedAt: new Date(now.getTime() - 60 * 60 * 1000),
          careModality: 'MORBIDITY',
          visitSequence: 'SUBSEQUENT',
        },
        select: { id: true, verificationCode: true },
      });
      const noteId = randomUUID();
      await prisma.clinicalNote.create({
        data: {
          id: noteId,
          chainId: noteId,
          encounterId: annulled.id,
          formCode: '002',
          formVersion: '1',
          status: 'SIGNED',
          content: { motivoConsulta: 'Registrada por error' },
          authorId: practitionerId,
          signedById: practitionerId,
          signedAt: now,
          contentHash: 'b'.repeat(64),
        },
      });
      await prisma.encounter.update({
        where: { id: annulled.id },
        data: {
          status: 'ENTERED_IN_ERROR',
          endedAt: now,
          enteredInErrorById: (await createUser(prisma)).id,
          enteredInErrorAt: now,
        },
      });
      const voided = await request(app.getHttpServer())
        .get(`/api/v1/documents/verify/${annulled.verificationCode}`)
        .expect(200);
      expect((voided.body as { status: string }).status).toBe('ANNULLED');
    });
  });

  describe('DOC-050 a DOC-055 la identidad visual', () => {
    const upload = (path: string, token: string, body: Buffer, type: string) =>
      request(app.getHttpServer())
        .put(`/api/v1${path}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', type)
        .send(body);

    it('DOC-051 rechaza un SVG, aunque venga anunciado como PNG', async () => {
      // THE DEFENCE IS THE BYTES. A `Content-Type` is whatever the client typed.
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/steal")</script></svg>',
      );

      const asSvg = await upload(
        `/documents/identity/establishments/${establishmentId}/logo`,
        adminToken,
        svg,
        'image/svg+xml',
      ).expect(422);
      expect((asSvg.body as Problem).code).toBe(
        'DOCUMENT_IMAGE_FORMAT_NOT_ALLOWED',
      );

      const disguised = await upload(
        `/documents/identity/establishments/${establishmentId}/logo`,
        adminToken,
        svg,
        'image/png',
      ).expect(422);
      expect((disguised.body as Problem).code).toBe(
        'DOCUMENT_IMAGE_FORMAT_NOT_ALLOWED',
      );

      await expect(prisma.documentImage.count()).resolves.toBe(0);
    });

    it('DOC-054, SC-063 guarda el PNG REENCODADO, con otro sha256 y sin metadatos', async () => {
      // Re-encoding is what removes EXIF, odd colour profiles and mixed
      // payloads. A logo whose stored hash equals the uploaded file's hash is a
      // logo nobody examined.
      const uploaded = await sharp({
        create: {
          width: 40,
          height: 20,
          channels: 3,
          background: { r: 20, g: 90, b: 140 },
        },
      })
        .withMetadata({ exif: { IFD0: { Copyright: 'nobody' } } })
        .png()
        .toBuffer();

      const response = await upload(
        `/documents/identity/establishments/${establishmentId}/logo`,
        adminToken,
        uploaded,
        'image/png',
      ).expect(200);

      const stored = response.body as { id: string; sha256: string };
      const { createHash } = await import('node:crypto');
      expect(stored.sha256).not.toBe(
        createHash('sha256').update(uploaded).digest('hex'),
      );

      const row = await prisma.documentImage.findUniqueOrThrow({
        where: { id: stored.id },
      });
      expect(Buffer.from(row.bytes).includes('Copyright')).toBe(false);
    });

    it('DOC-055 aplana el canal alfa, porque PDF/A-1b prohíbe la transparencia', async () => {
      // A logo exported with a transparent background — which is how every
      // designer exports a logo — would otherwise be embedded with a soft mask
      // and make every document of that clinic fail validation.
      const transparent = await sharp({
        create: {
          width: 20,
          height: 20,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer();

      const response = await upload(
        `/documents/identity/establishments/${establishmentId}/logo`,
        adminToken,
        transparent,
        'image/png',
      ).expect(200);

      const row = await prisma.documentImage.findUniqueOrThrow({
        where: { id: (response.body as { id: string }).id },
      });
      const metadata = await sharp(Buffer.from(row.bytes)).metadata();
      expect(metadata.hasAlpha).toBe(false);
    });

    it('DOC-052 rechaza con 413 lo que supera el tope, antes de decodificar', async () => {
      // The cap is applied at the socket by `express.raw({ limit })`: a body
      // larger than 512 KB never reaches Node's heap, let alone a decoder.
      const huge = Buffer.alloc(600 * 1024, 0x41);
      await upload(
        `/documents/identity/establishments/${establishmentId}/logo`,
        adminToken,
        huge,
        'image/png',
      ).expect(413);
    });

    it('DOC-057 el sello va por profesional y exige staff:manage', async () => {
      const seal = await sharp({
        create: {
          width: 30,
          height: 30,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
      })
        .png()
        .toBuffer();

      // The doctor holds `record:read` and not `staff:manage`.
      await upload(
        `/documents/identity/practitioners/${practitionerId}/seal`,
        doctorToken,
        seal,
        'image/png',
      ).expect(403);

      const stored = await upload(
        `/documents/identity/practitioners/${practitionerId}/seal`,
        adminToken,
        seal,
        'image/png',
      ).expect(200);

      const practitioner = await prisma.practitioner.findUniqueOrThrow({
        where: { id: practitionerId },
      });
      expect(practitioner.sealImageId).toBe((stored.body as { id: string }).id);
    });

    it('DOC-061 sirve el logo vigente tal como se guardó, con nosniff, y 404 mientras no hay', async () => {
      const path = `/documents/identity/establishments/${establishmentId}/logo`;
      const missing = await get(path, adminToken).expect(404);
      expect((missing.body as Problem).code).toBe('DOCUMENT_IMAGE_NOT_FOUND');

      const logo = await sharp({
        create: {
          width: 40,
          height: 20,
          channels: 3,
          background: { r: 15, g: 107, b: 92 },
        },
      })
        .png()
        .toBuffer();
      const stored = await upload(path, adminToken, logo, 'image/png').expect(
        200,
      );

      const served = await get(path, adminToken)
        .buffer()
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(served.headers['content-type']).toBe('image/png');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(
        createHash('sha256')
          .update(served.body as Buffer)
          .digest('hex'),
      ).toBe((stored.body as { sha256: string }).sha256);
    });

    it('DOC-061 el sello vigente exige staff:read: el médico no lo ve, administración sí', async () => {
      const path = `/documents/identity/practitioners/${practitionerId}/seal`;
      const seal = await sharp({
        create: { width: 30, height: 30, channels: 3, background: '#000000' },
      })
        .png()
        .toBuffer();
      await upload(path, adminToken, seal, 'image/png').expect(200);

      await get(path, adminToken).expect(200);
      await get(path, doctorToken).expect(403);
      const signature = await get(
        `/documents/identity/practitioners/${practitionerId}/signature`,
        adminToken,
      ).expect(404);
      expect((signature.body as Problem).code).toBe('DOCUMENT_IMAGE_NOT_FOUND');
    });

    it('DOC-057 el logo emitido aparece en el documento', async () => {
      const logo = await sharp({
        create: {
          width: 60,
          height: 30,
          channels: 3,
          background: { r: 20, g: 90, b: 140 },
        },
      })
        .png()
        .toBuffer();

      await publishTemplate();
      const before = (
        await post('/documents/renders', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
        }).expect(201)
      ).body as RenderBody;

      await upload(
        `/documents/identity/establishments/${establishmentId}/logo`,
        adminToken,
        logo,
        'image/png',
      ).expect(200);

      // A second original is refused (DOC-008): the new identity goes into a
      // correction of the first.
      const after = (
        await post('/documents/renders/supersede', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
          supersedesId: before.id,
          reason: 'Se reimprime con el logo de la clínica',
        }).expect(201)
      ).body as RenderBody;

      // DOC-059 both ways: the document was emitted WITHOUT a logo and did not
      // complain, and once there is one it is embedded.
      expect(after.byteSize).toBeGreaterThan(before.byteSize);
    });
  });

  describe('DOC-118 DOC-119 la copia certificada de la historia clínica (D-198 §1)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    /**
     * D-203 §1. Whoever answers the data requests AND holds `record:read` at
     * the seeded site: the one person who registers, authorises and downloads.
     * The shipped ADMIN (`adminToken`) has the first and not the second.
     */
    let custodianToken: string;
    beforeEach(async () => {
      const role = await prisma.role.create({
        data: { code: 'CUSTODIO_HISTORIA', name: 'Archivo de historias' },
      });
      await prisma.rolePermission.createMany({
        data: ['patient:data-requests', 'record:read'].map(
          (permissionCode) => ({ roleId: role.id, permissionCode }),
        ),
      });
      registry.invalidate();
      custodianToken = (
        await signIn(
          'CUSTODIO_HISTORIA',
          'archivo@clinica.ec',
          '1710000009',
          false,
        )
      ).token;
    });
    const copyOf = (requestId: string, token = custodianToken) =>
      get(`/documents/data-requests/${requestId}/clinical-record`, token);

    async function signedNote(encounterId: string, reason: string) {
      const chainId = randomUUID();
      await prisma.clinicalNote.create({
        data: {
          id: chainId,
          chainId,
          encounterId,
          formCode: '002',
          formVersion: '1',
          status: 'SIGNED',
          content: {
            motivoConsulta: reason,
            antecedentes: 'Sin antecedentes de importancia',
            enfermedadActual: 'Cuadro de inicio reciente',
            revisionOrganosSistemas: 'Sin otros síntomas',
            examenFisico: 'Sin hallazgos',
            planTratamiento: 'Control',
          },
          authorId: practitionerId,
          signedById: practitionerId,
          signedAt: new Date(),
          contentHash: 'b'.repeat(64),
        },
      });
    }

    /** The seeded attention signed, an older one on a chart merged into it, and an annulled one. */
    async function aRecordWithHistory() {
      const seeded = await prisma.encounter.findFirstOrThrow({
        select: { id: true, patientId: true, startedAt: true },
      });
      await signedNote(seeded.id, 'Dolor de garganta de dos días');

      const absorbed = await createPatient(prisma);
      const older = await prisma.encounter.create({
        data: {
          siteId,
          practitionerId,
          patientId: absorbed.id,
          startedAt: new Date(seeded.startedAt.getTime() - 30 * DAY),
          careModality: 'MORBIDITY',
          visitSequence: 'FIRST_TIME',
        },
      });
      await signedNote(older.id, 'Control de presión arterial');
      await prisma.patient.update({
        where: { id: absorbed.id },
        data: { mergedIntoId: seeded.patientId, mergedAt: new Date() },
      });

      const wrong = await prisma.encounter.create({
        data: {
          siteId,
          practitionerId,
          patientId: seeded.patientId,
          startedAt: new Date(seeded.startedAt.getTime() - 10 * DAY),
          careModality: 'MORBIDITY',
          visitSequence: 'SUBSEQUENT',
        },
      });
      await signedNote(wrong.id, 'Paciente equivocado');
      const now = new Date();
      await prisma.encounter.update({
        where: { id: wrong.id },
        data: { status: 'ENTERED_IN_ERROR', endedAt: now, enteredInErrorById: (await createUser(prisma)).id, enteredInErrorAt: now }, // prettier-ignore
      });
      return { patientId: seeded.patientId, absorbedId: absorbed.id };
    }

    async function copyRequest(patientId: string, body: object = {}) {
      const response = await post(
        `/privacy/patients/${patientId}/requests`,
        adminToken,
        {
          right: 'ACCESS',
          requestedBy: 'AUTHORITY',
          requesterName: 'Juzgado Primero de lo Civil',
          requesterDocument: 'Oficio 123',
          clinicalRecordCopy: true,
          documentsChecked: true,
          description: 'Copia certificada de la historia clínica',
          ...body,
        },
      ).expect(201);
      return (response.body as { id: string }).id;
    }

    const answer = (
      requestId: string,
      outcome: string,
      path = 'response',
      copyPeriod?: { from: string; to: string },
    ) =>
      post(`/privacy/requests/${requestId}/${path}`, custodianToken, {
        outcome,
        response: 'Respuesta',
        ...(copyPeriod ? { copyPeriod } : {}),
      }).expect(200);

    /** PD-061. The doctor's review, with or without the screening. */
    const review = (requestId: string, includesScreening: boolean) =>
      post(`/privacy/requests/${requestId}/clinical-review`, doctorToken, {
        reviewed: true,
        includesScreening,
      }).expect(200);

    /** The PDF of a copy, as bytes. */
    async function copyBytes(requestId: string): Promise<Buffer> {
      const response = await copyOf(requestId)
        .buffer()
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      return response.body as Buffer;
    }

    async function copyText(requestId: string): Promise<string> {
      const response = await copyOf(requestId)
        .buffer()
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(response.headers['content-type']).toContain('application/pdf');
      expect(response.headers['cache-control']).toContain('no-store');
      const proxy = await getDocumentProxy(
        new Uint8Array(response.body as Buffer),
      );
      return (await extractText(proxy, { mergePages: true })).text.replace(
        /\s+/g,
        ' ',
      );
    }

    it('DOC-118 EN-033 sin respuesta o denegada no sale; atendida, lleva CONFIDENCIAL, quién la pidió y la autorizó, y las atenciones de la ficha y su absorbida, sin la anulada', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const { patientId } = await aRecordWithHistory();
      const requestId = await copyRequest(patientId);

      const unanswered = await copyOf(requestId).expect(409);
      expect((unanswered.body as Problem).code).toBe(
        'CLINICAL_RECORD_COPY_NOT_AVAILABLE',
      );
      await answer(requestId, 'DENIED');
      await copyOf(requestId).expect(409);
      // PD-047. The standing answer is what authorises: a rectification grants it…
      await answer(requestId, 'GRANTED', 'response/correction');
      await copyOf(requestId).expect(200);
      // …and a second one, to «Denegada», takes it back: with a chain of two
      // rectifications only the last stands.
      await answer(requestId, 'DENIED', 'response/correction');
      const revoked = await copyOf(requestId).expect(409);
      expect((revoked.body as Problem).code).toBe(
        'CLINICAL_RECORD_COPY_NOT_AVAILABLE',
      );
      await answer(requestId, 'GRANTED', 'response/correction');

      const text = await copyText(requestId);

      expect(text).toContain('CONFIDENCIAL');
      expect(text).toContain('COPIA CERTIFICADA DE LA HISTORIA CLÍNICA');
      expect(text).toContain('Juzgado Primero de lo Civil');
      expect(text).toContain('Oficio 123');
      expect(text).toContain('custodio de la historia clínica');
      expect(text).toContain('tamizaje de violencia');
      const older = text.indexOf('Control de presión arterial');
      const newer = text.indexOf('Dolor de garganta de dos días');
      expect(older).toBeGreaterThan(-1);
      expect(newer).toBeGreaterThan(older);
      expect(text).not.toContain('Paciente equivocado');
      expect(text).toContain('Amoxicilina');
      await expect(prisma.documentRender.count()).resolves.toBe(0);
    });

    it('DOC-119 cada copia deja una fila EXPORT por ficha cuyas atenciones salen y otra de la solicitud', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const { patientId, absorbedId } = await aRecordWithHistory();
      const requestId = await copyRequest(patientId);
      await answer(requestId, 'GRANTED');

      await copyText(requestId);

      const rows = await prisma.accessAudit.findMany({
        where: { action: 'EXPORT' },
        select: { resourceType: true, resourceId: true },
      });
      expect(rows).toEqual(
        expect.arrayContaining([
          { resourceType: 'patient', resourceId: patientId },
          { resourceType: 'patient', resourceId: absorbedId },
          { resourceType: 'data_subject_request', resourceId: requestId },
        ]),
      );
      expect(rows).toHaveLength(3);
    });

    it('DOC-119 si la bitácora no se puede escribir, no se entrega nada', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const { patientId } = await aRecordWithHistory();
      const requestId = await copyRequest(patientId);
      await answer(requestId, 'GRANTED');
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION test_refuse_export() RETURNS TRIGGER
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.resource_type = 'data_subject_request' AND NEW.action = 'EXPORT' THEN
            RAISE EXCEPTION 'trail unavailable (test)' USING ERRCODE = 'XX000';
          END IF;
          RETURN NEW;
        END; $$`);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER trg_test_refuse_export BEFORE INSERT ON access_audit
        FOR EACH ROW EXECUTE FUNCTION test_refuse_export()`);
      try {
        const refused = await copyOf(requestId);
        expect(refused.status).toBeGreaterThanOrEqual(500);
        expect(refused.headers['content-type']).not.toContain(
          'application/pdf',
        );
        // All or nothing: not even the chart's rows stayed.
        await expect(
          prisma.accessAudit.count({ where: { action: 'EXPORT' } }),
        ).resolves.toBe(0);
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER trg_test_refuse_export ON access_audit',
        );
        await prisma.$executeRawUnsafe('DROP FUNCTION test_refuse_export()');
      }
    });

    it('DOC-118 una solicitud que no es de copia no la da, una inexistente responde 404, y sin patient:data-requests es 403', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const { patientId } = await aRecordWithHistory();
      const access = await copyRequest(patientId, {
        requestedBy: 'HOLDER',
        clinicalRecordCopy: false,
        documentsChecked: false,
      });
      await answer(access, 'GRANTED');
      const notCopy = await copyOf(access).expect(409);
      expect((notCopy.body as Problem).code).toBe(
        'CLINICAL_RECORD_COPY_NOT_AVAILABLE',
      );

      const missing = await copyOf(randomUUID()).expect(404);
      expect((missing.body as Problem).code).toBe('DOCUMENT_SUBJECT_NOT_FOUND');

      const requestId = await copyRequest(patientId);
      await answer(requestId, 'GRANTED');
      await copyOf(requestId, doctorToken).expect(403);
    });
    it('DOC-122 D-203 §2 «Atendida en parte» entrega sólo las atenciones de su periodo, y la portada lo dice', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const { patientId } = await aRecordWithHistory();
      const seeded = await prisma.encounter.findFirstOrThrow({
        where: { patientId, status: { not: 'ENTERED_IN_ERROR' } },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      });
      const requestId = await copyRequest(patientId);
      // From the day of the newest attention: the older one, 30 days before, stays out.
      const from = clinicalDateOf(seeded.startedAt);
      await answer(requestId, 'PARTIALLY_GRANTED', 'response', {
        from,
        to: clinicalDateOf(new Date()),
      });

      const text = await copyText(requestId);
      expect(text).toContain('Dolor de garganta de dos días');
      expect(text).not.toContain('Control de presión arterial');
      expect(text).toContain(
        `Alcance Del ${from.split('-').reverse().join('/')}`,
      );
      expect(text).toContain('las de fuera del periodo autorizado');
      // Control positivo: rectificada a «Atendida», la completa.
      await answer(requestId, 'GRANTED', 'response/correction');
      const whole = await copyText(requestId);
      expect(whole).toContain('Control de presión arterial');
      expect(whole).toContain('Historia clínica completa');
    });

    it('DOC-120 la portada dice fiel copia del original, el responsable con su recuadro, el «Recibí conforme» y el total de páginas, que es el del PDF', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const { patientId } = await aRecordWithHistory();
      const requestId = await copyRequest(patientId);
      await answer(requestId, 'GRANTED');

      const bytes = await copyBytes(requestId);
      const proxy = await getDocumentProxy(new Uint8Array(bytes));
      const text = (await extractText(proxy, { mergePages: true })).text.replace(/\s+/g, ' '); // prettier-ignore
      expect(text).toContain('fiel copia del original');
      expect(text).toContain('RESPONSABLE DE LA ENTREGA');
      expect(text).toContain('Firma y sello');
      expect(text).toContain('RECIBÍ CONFORME');
      expect(text).toContain(
        'responsabilidad del cuidado y manejo de la información',
      );
      expect(text).toContain('Documentos recibidos el oficio de la autoridad');
      expect(text).toContain(`TOTAL DE PÁGINAS ${proxy.numPages}`);
    });

    it('DOC-121 cada atención lleva los resultados que había al autorizar y sus notas de evolución; la corrección posterior sólo se anuncia', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const { patientId } = await aRecordWithHistory();
      const seeded = await prisma.encounter.findFirstOrThrow({
        where: { patientId, status: { not: 'ENTERED_IN_ERROR' } },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      });
      const system = await prisma.catalogSystem.upsert({
        where: { code: 'TARIFARIO' },
        create: { code: 'TARIFARIO', name: 'Tarifario' },
        update: {},
      });
      const concept = await prisma.catalogConcept.create({
        data: { systemId: system.id, code: 'MSP-BH', display: 'Biometría hemática', validFrom: new Date(Date.now() - 400 * DAY) }, // prettier-ignore
      });
      const order = await prisma.serviceOrder.create({
        data: { encounterId: seeded.id, siteId, orderedById: practitionerId, category: 'LABORATORY' }, // prettier-ignore
      });
      await prisma.serviceOrderItem.create({
        data: { serviceOrderId: order.id, conceptId: concept.id, testCode: 'LAB-BH', testDisplay: 'Biometría hemática' }, // prettier-ignore
      });
      await prisma.serviceOrder.update({
        where: { id: order.id },
        data: { status: 'ISSUED', requestedAt: new Date() },
      });
      const report = await prisma.diagnosticReport.create({
        data: {
          serviceOrderId: order.id,
          status: 'FINAL',
          conclusion: 'Anemia leve',
          issuedAt: new Date(),
          results: {
            create: [{ analyteDisplay: 'Hemoglobina', valueNumeric: '10.2', unit: 'g/dL', referenceLow: '12', referenceHigh: '15.5', abnormalFlag: 'LOW' }], // prettier-ignore
          },
        },
      });
      const evolutionChain = randomUUID();
      await prisma.clinicalNote.create({
        data: { id: evolutionChain, chainId: evolutionChain, encounterId: seeded.id, formCode: '005', formVersion: '1', status: 'SIGNED', content: { evolucion: 'Tolera la vía oral' }, authorId: practitionerId, signedById: practitionerId, signedAt: new Date(), contentHash: 'd'.repeat(64) }, // prettier-ignore
      });
      const requestId = await copyRequest(patientId);
      await answer(requestId, 'GRANTED');
      // A correction recorded AFTER the authorisation: not what was authorised.
      await prisma.diagnosticReport.create({
        data: {
          serviceOrderId: order.id,
          status: 'CORRECTED',
          conclusion: 'Valor corregido',
          issuedAt: new Date(),
          supersedesId: report.id,
          results: { create: [{ analyteDisplay: 'Hemoglobina', valueNumeric: '13.1', unit: 'g/dL' }] }, // prettier-ignore
        },
      });

      const text = await copyText(requestId);
      expect(text).toContain('Resultados de exámenes');
      expect(text).toContain('Hemoglobina');
      expect(text).toContain('10.2 g/dL');
      expect(text).toContain('Anemia leve');
      // DOC-122. Frozen at the authorisation: the later correction is not there.
      expect(text).not.toContain('13.1');
      expect(text).not.toContain('Valor corregido');
      expect(text).toContain('Notas de evolución');
      expect(text).toContain('Tolera la vía oral');
    });

    it('DOC-118 D-188 §3 un tamizaje con signos no sale en la copia, ni su acción ni sus tipos', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const { patientId } = await aRecordWithHistory();
      const seeded = await prisma.encounter.findFirstOrThrow({
        where: { patientId, status: { not: 'ENTERED_IN_ERROR' } },
        select: { id: true },
      });
      await prisma.violenceScreening.create({
        data: {
          encounterId: seeded.id,
          result: 'SUSPECTED',
          types: ['PHYSICAL'],
          actionTaken: 'Derivada a trabajo social por agresión de la pareja',
          screenedById: practitionerId,
          screenedAt: new Date(),
        },
      });
      const requestId = await copyRequest(patientId);
      // PD-062. For an authority, with signs in the screening: the doctor first.
      const waiting = await post(
        `/privacy/requests/${requestId}/response`,
        custodianToken,
        { outcome: 'GRANTED', response: 'Se autoriza' },
      ).expect(409);
      expect((waiting.body as Problem).code).toBe(
        'CLINICAL_RECORD_COPY_REVIEW_REQUIRED',
      );
      await review(requestId, false);
      await answer(requestId, 'GRANTED');

      const text = await copyText(requestId);
      // Control positivo: la atención sí está.
      expect(text).toContain('Dolor de garganta de dos días');
      expect(text).not.toContain('Derivada a trabajo social');
      expect(text).not.toContain('agresión');
      expect(text).not.toMatch(/física|PHYSICAL|SUSPECTED|Sospecha/);
      expect(text).toContain('el tamizaje de violencia, que sólo se entrega');
    });

    it('DOC-123 con el visto bueno que lo incluye, la copia lleva el tamizaje de la atención', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const { patientId } = await aRecordWithHistory();
      const seeded = await prisma.encounter.findFirstOrThrow({
        where: { patientId, status: { not: 'ENTERED_IN_ERROR' } },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      });
      await prisma.violenceScreening.create({
        data: {
          encounterId: seeded.id,
          result: 'SUSPECTED',
          types: ['PHYSICAL'],
          actionTaken: 'Derivada a trabajo social',
          screenedById: practitionerId,
          screenedAt: new Date(),
        },
      });
      const requestId = await copyRequest(patientId);
      await review(requestId, true);
      await answer(requestId, 'GRANTED');

      const text = await copyText(requestId);
      expect(text).toContain('Tamizaje de violencia');
      expect(text).toContain('Sospecha');
      expect(text).toContain('física');
      expect(text).toContain('Derivada a trabajo social');
      expect(text).toContain(
        'lo incluye, con el visto bueno de un profesional',
      );
    });

    it('DOC-118 cada descarga lleva lo que se autorizó: una atención posterior a la autorización no sale', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const { patientId } = await aRecordWithHistory();
      const requestId = await copyRequest(patientId);
      await answer(requestId, 'GRANTED');
      const authorisedAt = (
        await prisma.dataSubjectRequest.findUniqueOrThrow({
          where: { id: requestId },
          select: { answeredAt: true },
        })
      ).answeredAt!;
      const later = await prisma.encounter.create({
        data: {
          siteId,
          practitionerId,
          patientId,
          startedAt: new Date(authorisedAt.getTime() + 60_000),
          careModality: 'MORBIDITY',
          visitSequence: 'SUBSEQUENT',
        },
      });
      await signedNote(later.id, 'Consulta posterior a la autorización');

      const text = await copyText(requestId);
      expect(text).toContain('Dolor de garganta de dos días');
      expect(text).not.toContain('Consulta posterior a la autorización');
    });

    it('DOC-122 lo autorizado queda congelado: un diagnóstico añadido y una nota enmendada después no cambian lo que se vuelve a descargar', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const { patientId } = await aRecordWithHistory();
      const seeded = await prisma.encounter.findFirstOrThrow({
        where: { patientId, status: { not: 'ENTERED_IN_ERROR' } },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      });
      const requestId = await copyRequest(patientId, {
        requestedBy: 'HOLDER',
        requesterName: null,
        requesterDocument: null,
      });
      await answer(requestId, 'GRANTED');
      const first = await copyText(requestId);

      // After the authorisation: a diagnosis on an attention that was there,
      // and the 002 amended.
      await createDiagnosis(prisma, seeded.id, 'B20.9', 'Enfermedad por VIH');
      const note = await prisma.clinicalNote.findFirstOrThrow({
        where: { encounterId: seeded.id, formCode: '002', status: 'SIGNED' },
        select: { id: true, chainId: true },
      });
      await prisma.clinicalNote.update({
        where: { id: note.id },
        data: { status: 'SUPERSEDED' },
      });
      await prisma.clinicalNote.create({
        data: {
          chainId: note.chainId,
          version: 2,
          encounterId: seeded.id,
          formCode: '002',
          formVersion: '1',
          status: 'SIGNED',
          content: { motivoConsulta: 'Nota enmendada después' },
          authorId: practitionerId,
          signedById: practitionerId,
          signedAt: new Date(),
          contentHash: 'e'.repeat(64),
          supersedesId: note.id,
          amendmentReason: 'Prueba',
        },
      });

      const again = await copyText(requestId);
      expect(again).not.toContain('B20.9');
      expect(again).not.toContain('Nota enmendada después');
      expect(again).toContain('Dolor de garganta de dos días');
      expect(again.replace(/\d{2}\/\d{2}\/\d{4} · \d{2}:\d{2}/g, '')).toBe(
        first.replace(/\d{2}\/\d{2}\/\d{4} · \d{2}:\d{2}/g, ''),
      );
      // Control positivo: el resumen de la atención, que se compone al
      // momento, sí lo lleva.
      const summary = await get(
        `/documents/encounters/${seeded.id}/summary`,
        doctorToken,
      )
        .buffer()
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const proxy = await getDocumentProxy(
        new Uint8Array(summary.body as Buffer),
      );
      const live = (await extractText(proxy, { mergePages: true })).text;
      expect(live).toContain('B20.9');
    });

    it('DOC-118 la solicitud registrada en una ficha que después se unificó entrega la historia de la persona, con la ficha vigente en la portada', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const seeded = await prisma.encounter.findFirstOrThrow({
        select: { id: true, patientId: true, startedAt: true },
      });
      await signedNote(seeded.id, 'Dolor de garganta de dos días');
      const duplicate = await createPatient(prisma);
      const onDuplicate = await prisma.encounter.create({
        data: {
          siteId,
          practitionerId,
          patientId: duplicate.id,
          startedAt: new Date(seeded.startedAt.getTime() - 20 * DAY),
          careModality: 'MORBIDITY',
          visitSequence: 'FIRST_TIME',
        },
      });
      await signedNote(onDuplicate.id, 'Control de presión arterial');
      const requestId = await copyRequest(duplicate.id);
      await prisma.patient.update({
        where: { id: duplicate.id },
        data: { mergedIntoId: seeded.patientId, mergedAt: new Date() },
      });
      await answer(requestId, 'GRANTED');

      const text = await copyText(requestId);
      const survivor = await prisma.patient.findUniqueOrThrow({
        where: { id: seeded.patientId },
        select: { mrn: true },
      });
      expect(text).toContain(`Historia clínica ${survivor.mrn}`);
      expect(text).toContain('Control de presión arterial');
      expect(text).toContain('Dolor de garganta de dos días');
    });
    it('DOC-118 PD-058 D-203 §1 sin record:read no se autoriza ni se descarga, y la respuesta no dice si la solicitud existe', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const { patientId } = await aRecordWithHistory();
      const requestId = await copyRequest(patientId);

      // ADMIN de fábrica: patient:data-requests sin record:read.
      const unanswered = await post(
        `/privacy/requests/${requestId}/response`,
        adminToken,
        { outcome: 'GRANTED', response: 'Se autoriza' },
      ).expect(404);
      expect((unanswered.body as Problem).code).toBe('DATA_REQUEST_NOT_FOUND');
      await get(`/privacy/requests/${requestId}/answer-proposal`, adminToken).expect(404); // prettier-ignore

      // Control positivo: con la llave, la misma persona la autoriza…
      await answer(requestId, 'GRANTED');
      await copyOf(requestId).expect(200);
      // …y sin ella nadie la rectifica (convertir una denegada en atendida).
      const rectified = await post(
        `/privacy/requests/${requestId}/response/correction`,
        adminToken,
        { outcome: 'GRANTED', response: 'Se autoriza' },
      ).expect(404);
      expect((rectified.body as Problem).code).toBe('DATA_REQUEST_NOT_FOUND');
      // …y sin ella, la descarga responde como a una solicitud que no existe.
      const refused = await copyOf(requestId, adminToken).expect(404);
      const missing = await copyOf(randomUUID(), adminToken).expect(404);
      expect((refused.body as Problem).code).toBe('DOCUMENT_SUBJECT_NOT_FOUND');
      expect((refused.body as Problem).code).toBe(
        (missing.body as Problem).code,
      );
      expect((refused.body as Problem).title).toBe(
        (missing.body as Problem).title,
      );
    });

    it('DOC-118 PD-058 D-203 §1 con record:read en otra sede no hay llave: la persona atendida sólo en otra sede no se autoriza ni se descarga', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const elsewhere = await createSite(prisma, 'Sede Sur');
      const patient = await createPatient(prisma);
      const there = await prisma.encounter.create({
        data: {
          siteId: elsewhere.id,
          practitionerId,
          patientId: patient.id,
          startedAt: new Date(Date.now() - 2 * DAY),
          careModality: 'MORBIDITY',
          visitSequence: 'FIRST_TIME',
        },
      });
      await signedNote(there.id, 'Atendida en la sede sur');
      const requestId = await copyRequest(patient.id);
      const missing = (await copyOf(randomUUID()).expect(404)).body as Problem;

      // Sin responder, la descarga no dice «falta autorizarla»: no existe.
      const unanswered = (await copyOf(requestId).expect(404)).body as Problem;
      expect([unanswered.code, unanswered.title]).toEqual([
        missing.code,
        missing.title,
      ]);
      const refused = await post(
        `/privacy/requests/${requestId}/response`,
        custodianToken,
        { outcome: 'GRANTED', response: 'Se autoriza' },
      ).expect(404);
      expect((refused.body as Problem).code).toBe('DATA_REQUEST_NOT_FOUND');
      // Aunque otra persona con llave la autorizase, ésta no la descarga, y
      // no queda ninguna fila EXPORT.
      await prisma.dataSubjectRequest.update({
        where: { id: requestId },
        data: { outcome: 'GRANTED', response: 'Autorizada', answeredAt: new Date(), answeredBy: (await createUser(prisma)).id, changedBy: (await createUser(prisma)).id, changedAt: new Date() }, // prettier-ignore
      });
      const exportsBefore = await prisma.accessAudit.count({
        where: { action: 'EXPORT' },
      });
      const granted = (await copyOf(requestId).expect(404)).body as Problem;
      expect([granted.code, granted.title]).toEqual([
        missing.code,
        missing.title,
      ]);
      await expect(
        prisma.accessAudit.count({ where: { action: 'EXPORT' } }),
      ).resolves.toBe(exportsBefore);

      // Control positivo: la misma cuenta, con record:read también en la
      // sede sur, la descarga.
      const custodian = await prisma.user.findUniqueOrThrow({
        where: { email: 'archivo@clinica.ec' },
        select: { id: true },
      });
      const role = await prisma.role.findUniqueOrThrow({
        where: { code: 'CUSTODIO_HISTORIA' },
        select: { id: true },
      });
      await prisma.userRoleGrant.create({
        data: { userId: custodian.id, roleId: role.id, siteId: elsewhere.id },
      });
      registry.invalidate();
      // The grants travel with the session: a new one carries the new site.
      custodianToken = (
        (
          await request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .send({ email: 'archivo@clinica.ec', password: PASSWORD })
            .expect(200)
        ).body as { accessToken: string }
      ).accessToken;
      const text = await copyText(requestId);
      expect(text).toContain('Atendida en la sede sur');
    });

    it('DOC-118 D-203 §1 la copia alcanza sólo las sedes de su record:read, y la portada dice que no lleva las de otras sedes', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const { patientId } = await aRecordWithHistory();
      const elsewhere = await createSite(prisma, 'Sede Sur');
      const there = await prisma.encounter.create({
        data: {
          siteId: elsewhere.id,
          practitionerId,
          patientId,
          startedAt: new Date(Date.now() - 3 * DAY),
          careModality: 'MORBIDITY',
          visitSequence: 'SUBSEQUENT',
        },
      });
      await signedNote(there.id, 'Atendida en la sede sur');
      const requestId = await copyRequest(patientId);
      await answer(requestId, 'GRANTED');

      const text = await copyText(requestId);
      // Control positivo: la de su sede, sí.
      expect(text).toContain('Dolor de garganta de dos días');
      expect(text).not.toContain('Atendida en la sede sur');
      expect(text).toContain('las de otras sedes');
    });
    it('DOC-118 DOC-119 PD-058 D-203 §1 la llave se encuentra por una ficha absorbida atendida en la sede, y de la absorbida atendida sólo en otra sede no sale ni su atención ni su fila EXPORT', async () => {
      await publishTemplate('ENCOUNTER_SUMMARY');
      const elsewhere = await createSite(prisma, 'Sede Sur');
      const survivor = await createPatient(prisma);
      const here = await createPatient(prisma);
      const there = await createPatient(prisma);
      for (const [patientId, site, reason] of [
        [here.id, siteId, 'Atendida aquí antes de unificar'],
        [there.id, elsewhere.id, 'Atendida en la sede sur antes de unificar'],
      ] as const) {
        const encounter = await prisma.encounter.create({
          data: {
            siteId: site,
            practitionerId,
            patientId,
            startedAt: new Date(Date.now() - 5 * DAY),
            careModality: 'MORBIDITY',
            visitSequence: 'FIRST_TIME',
          },
        });
        await signedNote(encounter.id, reason);
        await prisma.patient.update({
          where: { id: patientId },
          data: { mergedIntoId: survivor.id, mergedAt: new Date() },
        });
      }
      const requestId = await copyRequest(survivor.id);

      // copyKeyOf: la llave de la sede llega por la absorbida.
      await answer(requestId, 'GRANTED');
      const text = await copyText(requestId);
      expect(text).toContain('Atendida aquí antes de unificar');
      expect(text).not.toContain('Atendida en la sede sur antes de unificar');
      expect(text).toContain('las de otras sedes');

      const rows = await prisma.accessAudit.findMany({
        where: { action: 'EXPORT', resourceType: 'patient' },
        select: { resourceId: true },
      });
      expect(rows.map((row) => row.resourceId).sort()).toEqual(
        [survivor.id, here.id].sort(),
      );
    });
  });
});
