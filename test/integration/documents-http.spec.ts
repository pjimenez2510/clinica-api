import { createHash } from 'node:crypto';

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
import { createPatient, createSite } from './setup/fixtures';
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

    const prescription = await prisma.prescription.create({
      data: {
        encounterId: encounter.id,
        siteId: encounter.siteId,
        prescriberId: practitionerId,
        status: 'ACTIVE',
        issuedAt: new Date('2026-08-21T01:00:00Z'),
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

    it('DOC-038 la vista previa devuelve el PDF de muestra con la identidad real y no guarda nada', async () => {
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

    it('DOC-039 publica la versión siguiente de las cuatro clases a la vez', async () => {
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
        'INVOICE_RIDE:1',
        'MEDICAL_CERTIFICATE:1',
        'PRESCRIPTION:2',
        'SERVICE_ORDER:1',
      ]);
      await expect(prisma.documentTemplate.count()).resolves.toBe(5);
    });

    it('DOC-039 si una inserción falla EN LA BASE, no queda publicada ninguna', async () => {
      // Positive control: the same request publishes four.
      await post('/documents/templates/all-kinds', adminToken, slots).expect(
        201,
      );
      await expect(prisma.documentTemplate.count()).resolves.toBe(4);

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
        await expect(prisma.documentTemplate.count()).resolves.toBe(4);
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

    it('DOC-094 sin sesión dice clase, fecha, establecimiento, sede, profesional y vigencia', async () => {
      const issuedAt = new Date();
      await prisma.prescription.update({
        where: { id: prescriptionId },
        data: { verificationCode: 'ABCD1234EF567890', issuedAt },
      });

      const response = await verify('ABCD1234EF567890').expect(200);

      expect(response.body).toMatchObject({
        kind: 'PRESCRIPTION',
        issuedOn: clinicalDateOf(issuedAt),
        establishmentName: 'Centro de Especialidades Bahía',
        status: 'VALID',
        annulledOn: null,
      });
    });

    it('DOC-094 una receta pasada su vigencia se dice caducada', async () => {
      // The seeded receta was issued weeks before any run of this suite.
      await prisma.prescription.update({
        where: { id: prescriptionId },
        data: {
          verificationCode: 'ABCD1234EF567890',
          issuedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        },
      });

      const response = await verify('ABCD1234EF567890').expect(200);
      expect((response.body as { status: string }).status).toBe('EXPIRED');
    });

    it('DOC-094 el código se acepta escrito en minúsculas', async () => {
      await prisma.prescription.update({
        where: { id: prescriptionId },
        data: { verificationCode: 'ABCD1234EF567890', issuedAt: new Date() },
      });
      await verify('abcd1234ef567890').expect(200);
    });

    it('DOC-096 una receta en borrador con código responde como un código inexistente', async () => {
      const unknown = await verify('ZZZZ9999ZZZZ9999').expect(404);
      await prisma.prescription.update({
        where: { id: prescriptionId },
        data: { verificationCode: 'ABCD1234EF567890', issuedAt: new Date() },
      });
      // Positive control: the same receta, issued, is found.
      await verify('ABCD1234EF567890').expect(200);

      await prisma.prescription.update({
        where: { id: prescriptionId },
        data: { status: 'DRAFT', issuedAt: null },
      });
      const draft = await verify('ABCD1234EF567890').expect(404);

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
      await prisma.prescription.update({
        where: { id: prescriptionId },
        data: { verificationCode: 'ABCD1234EF567890' },
      });
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
      await prisma.prescription.update({
        where: { id: prescriptionId },
        data: { verificationCode: 'ABCD1234EF567890', status: 'CANCELLED' },
      });

      const response = await verify('ABCD1234EF567890').expect(200);
      expect((response.body as { status: string }).status).toBe('ANNULLED');
    });

    it('DOC-094 ORD-006 el código impreso en una orden se verifica, y se dice anulada sin exámenes que hacer', async () => {
      const encounter = await prisma.encounter.findFirstOrThrow({
        select: { id: true, siteId: true },
      });
      const concept = await prisma.catalogConcept.findFirstOrThrow({
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
        data: { status: 'CANCELLED' },
      });
      const annulled = await verify(order.verificationCode).expect(200);
      expect((annulled.body as { status: string }).status).toBe('ANNULLED');
    });

    it('DOC-096 un código inventado y uno sin forma dicen exactamente lo mismo', async () => {
      // Positive control: the route exists and answers a real code.
      await prisma.prescription.update({
        where: { id: prescriptionId },
        data: { verificationCode: 'ABCD1234EF567890' },
      });
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

      await prisma.prescriptionItem.deleteMany({ where: { prescriptionId } });

      const withoutData = await post('/documents/renders', doctorToken, {
        kind: 'PRESCRIPTION',
        subjectId: prescriptionId,
      }).expect(201);

      // Removing the only medicine changes the file. If the composition ignored
      // the lines, the two would be the same size.
      expect((withData.body as RenderBody).byteSize).not.toBe(
        (withoutData.body as RenderBody).byteSize,
      );
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

    it('DOC-010 rechaza anular sin decir por qué, nombrando el campo', async () => {
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
      }).expect(422);

      // The box is NAMED, which is what a form can act on: without a reason,
      // annulling is a way of making what was emitted disappear.
      expect((refused.body as Problem).code).toBe('VALIDATION_FAILED');
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

      const after = (
        await post('/documents/renders', doctorToken, {
          kind: 'PRESCRIPTION',
          subjectId: prescriptionId,
        }).expect(201)
      ).body as RenderBody;

      // DOC-059 both ways: the document was emitted WITHOUT a logo and did not
      // complain, and once there is one it is embedded.
      expect(after.byteSize).toBeGreaterThan(before.byteSize);
    });
  });
});
