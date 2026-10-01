import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import {
  addDays,
  clinicalDateOf,
  type ClinicalDate,
} from '../../src/shared/domain/clinic-time';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * The medical certificate as the browser consumes it, against a real
 * PostgreSQL and with the roles the clinic actually deploys.
 *
 * What `certificate-guarantees.spec.ts` proves about the database is assumed
 * here; this file proves everything BETWEEN the browser and it: the contract
 * of each refusal, the permission of each route, the site scope, and the rows
 * the access trail keeps.
 *
 * Every instant derives from the clock at the start of the run.
 */
const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

interface CertificateBody {
  id: string;
  encounterId: string;
  patientId: string;
  issuedById: string;
  type: string;
  number: number;
  verificationCode: string;
  issuedAt: string;
  restFrom: string | null;
  restTo: string | null;
  includeDiagnosis: boolean;
  revokedAt: string | null;
  revocationReason: string | null;
}

interface IssuedBody {
  certificate: CertificateBody;
  iess: { lastValidationDay: string; notice: string } | null;
}

describe('el certificado medico por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let encounterId: string;
  let patientId: string;
  let doctor: { token: string; userId: string; practitionerId: string };
  let nurseToken: string;
  let receptionToken: string;
  /** The clinical date of the attention, in Ecuador. */
  let today: ClinicalDate;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // Sin límite de peticiones: se sustituye el ALMACÉN, no el guard.
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

    siteId = (await createSite(prisma)).id;
    const started = new Date(Date.now() - 60 * 60 * 1000);
    today = clinicalDateOf(started);

    patientId = (
      await createPatient(prisma, {
        // Un lactante de unos cuatro meses: 125 días antes de la atención.
        birthDate: new Date(`${addDays(today, -125)}T00:00:00Z`),
      })
    ).id;

    doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    nurseToken = (
      await signIn('ENFERMERIA', 'enfermeria@clinica.ec', '1104637283')
    ).token;
    receptionToken = (
      await signIn('RECEPCION', 'recepcion@clinica.ec', '0926687856', false)
    ).token;

    encounterId = (await anEncounter(siteId, started)).id;
  }

  function anEncounter(site: string, startedAt: Date) {
    return prisma.encounter.create({
      data: {
        siteId: site,
        practitionerId: doctor.practitionerId,
        patientId,
        startedAt,
        careModality: 'MORBIDITY',
        visitSequence: 'FIRST_TIME',
      },
    });
  }

  /**
   * One account with one role granted AT ONE SITE. Las cédulas son sintéticas
   * con dígito verificador calculado (`app_user_cedula_valid`).
   */
  async function signIn(
    roleCode: string,
    email: string,
    cedula: string,
    withPractitioner = true,
  ): Promise<{ token: string; userId: string; practitionerId: string }> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Ana Lucía',
        lastName: 'Villacís Mora',
        cedula,
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
      userId: user.id,
      practitionerId: practitioner?.id ?? '',
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

  const attendance = (overrides: Record<string, unknown> = {}) => ({
    type: 'ATTENDANCE',
    includeDiagnosis: false,
    ...overrides,
  });

  const restOf = (days: number, overrides: Record<string, unknown> = {}) => ({
    type: 'MEDICAL_REST',
    restFrom: today,
    restTo: addDays(today, days - 1),
    includeDiagnosis: false,
    ...overrides,
  });

  async function issue(body: object, encounter = encounterId) {
    const response = await post(
      `/encounters/${encounter}/certificates`,
      doctor.token,
      body,
    ).expect(201);
    return response.body as IssuedBody;
  }

  async function aDiagnosis(encounter: string) {
    const system = await prisma.catalogSystem.upsert({
      where: { code: 'CIE10' },
      create: { code: 'CIE10', name: 'CIE-10' },
      update: {},
    });
    const concept = await prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code: 'J00',
        display: 'Rinofaringitis aguda',
        validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
      },
    });
    await prisma.encounterDiagnosis.create({
      data: {
        encounterId: encounter,
        conceptId: concept.id,
        cie10Code: 'J00',
        cie10Display: 'Rinofaringitis aguda',
        certainty: 'DEFINITIVE',
        occurrence: 'FIRST_TIME',
        rank: 1,
      },
    });
  }

  it('CER-001 y CER-009 el medico emite certificados numerados 1 y 2 en su sede', async () => {
    const first = await issue(attendance());
    const second = await issue(attendance());

    expect(first.certificate).toMatchObject({
      encounterId,
      patientId,
      issuedById: doctor.practitionerId,
      type: 'ATTENDANCE',
      number: 1,
      restFrom: null,
      restTo: null,
      includeDiagnosis: false,
      revokedAt: null,
    });
    expect(second.certificate.number).toBe(2);
    expect(first.certificate.verificationCode).not.toBe(
      second.certificate.verificationCode,
    );
    expect(first.iess).toBeNull();
  });

  it('CER-013 el reposo responde el ultimo dia de validacion en el IESS y el aviso', async () => {
    const issued = await issue(restOf(3));

    expect(issued.certificate.restFrom).toBe(today);
    expect(issued.certificate.restTo).toBe(addDays(today, 2));
    expect(issued.iess?.lastValidationDay).toBe(addDays(today, 10));
    expect(issued.iess?.notice).toContain('Seguro Social Campesino');
  });

  it('CER-006 rechaza un reposo que termina antes de empezar, nombrando el campo', async () => {
    const response = await post(
      `/encounters/${encounterId}/certificates`,
      doctor.token,
      restOf(1, { restTo: addDays(today, -1) }),
    ).expect(422);

    const problem = response.body as Problem;
    expect(problem.code).toBe('CERTIFICATE_REST_PERIOD_INVALID');
    expect(problem.errors?.map((error) => error.field)).toEqual(['restTo']);
    expect(await prisma.medicalCertificate.count()).toBe(0);

    // Control positivo: un reposo de un día por la misma ruta.
    await issue(restOf(1));
  });

  it('CER-007 rechaza la peticion que no dice si el diagnostico se incluye', async () => {
    const response = await post(
      `/encounters/${encounterId}/certificates`,
      doctor.token,
      { type: 'ATTENDANCE' },
    ).expect(422);

    const problem = response.body as Problem;
    expect(problem.errors?.some((e) => e.field === 'includeDiagnosis')).toBe(
      true,
    );
    expect(await prisma.medicalCertificate.count()).toBe(0);
  });

  it('CER-004 no admite un emisor en la peticion: el emisor es la sesion', async () => {
    const other = await prisma.practitioner.create({
      data: {
        user: {
          create: {
            email: 'otro@clinica.ec',
            passwordHash: 'not-a-real-hash',
            firstName: 'Otro',
            lastName: 'Profesional',
          },
        },
      },
    });

    await post(
      `/encounters/${encounterId}/certificates`,
      doctor.token,
      attendance({ issuedById: other.id }),
    ).expect(422);
    expect(await prisma.medicalCertificate.count()).toBe(0);

    const issued = await issue(attendance());
    expect(issued.certificate.issuedById).toBe(doctor.practitionerId);
  });

  it('CER-005 rechaza un certificado de aptitud con CERTIFICATE_TYPE_NOT_SUPPORTED', async () => {
    const response = await post(
      `/encounters/${encounterId}/certificates`,
      doctor.token,
      attendance({ type: 'FITNESS' }),
    ).expect(422);

    expect((response.body as Problem).code).toBe(
      'CERTIFICATE_TYPE_NOT_SUPPORTED',
    );
  });

  it('CER-008 rechaza incluir un diagnostico que la atencion no tiene, y lo admite cuando lo tiene', async () => {
    const refused = await post(
      `/encounters/${encounterId}/certificates`,
      doctor.token,
      attendance({ includeDiagnosis: true }),
    ).expect(422);
    expect((refused.body as Problem).code).toBe(
      'CERTIFICATE_DIAGNOSIS_REQUIRED',
    );

    await aDiagnosis(encounterId);
    const issued = await issue(attendance({ includeDiagnosis: true }));
    expect(issued.certificate.includeDiagnosis).toBe(true);
  });

  it('CER-003 rechaza emitir en una atencion cerrada', async () => {
    // Control positivo: la misma atención abierta admite el certificado.
    await issue(attendance());

    await prisma.encounter.update({
      where: { id: encounterId },
      data: {
        status: 'COMPLETED',
        endedAt: new Date(),
        dischargeCondition: 'ALIVE',
      },
    });

    const response = await post(
      `/encounters/${encounterId}/certificates`,
      doctor.token,
      attendance(),
    ).expect(409);
    expect((response.body as Problem).code).toBe(
      'CERTIFICATE_ENCOUNTER_NOT_OPEN',
    );
  });

  it('CER-002 y CER-014 una atencion de otra sede responde como si no existiera, sin datos del paciente', async () => {
    const elsewhere = await createSite(prisma, 'Sede Norte');
    const foreign = await anEncounter(elsewhere.id, new Date());

    const response = await post(
      `/encounters/${foreign.id}/certificates`,
      doctor.token,
      attendance(),
    ).expect(404);

    const problem = response.body as Problem;
    expect(problem.code).toBe('CERTIFICATE_ENCOUNTER_NOT_FOUND');
    expect(JSON.stringify(problem)).not.toMatch(/Guamán|María|HC\d+/);

    // Control positivo: la atención de su sede, por la misma ruta.
    await issue(attendance());
  });

  it('CER-010 lee el certificado por su identificador y por su atencion, y no el de otra sede', async () => {
    const issued = await issue(attendance());

    const one = await get(
      `/certificates/${issued.certificate.id}`,
      doctor.token,
    ).expect(200);
    expect((one.body as { number: number }).number).toBe(1);

    const list = await get(
      `/encounters/${encounterId}/certificates`,
      doctor.token,
    ).expect(200);
    expect(
      (list.body as { items: CertificateBody[] }).items.map((c) => c.id),
    ).toEqual([issued.certificate.id]);

    // Un certificado de otra sede: existe, y responde 404.
    const elsewhere = await createSite(prisma, 'Sede Norte');
    const foreign = await anEncounter(elsewhere.id, new Date());
    const hidden = await prisma.medicalCertificate.create({
      data: {
        encounterId: foreign.id,
        siteId: elsewhere.id,
        patientId,
        issuedById: doctor.practitionerId,
        type: 'ATTENDANCE',
        verificationCode: 'FOREIGN-0000001',
      },
    });
    const response = await get(
      `/certificates/${hidden.id}`,
      doctor.token,
    ).expect(404);
    expect((response.body as Problem).code).toBe('CERTIFICATE_NOT_FOUND');
  });

  it('CER-011 y CER-012 anula con motivo sin borrar nada, y no anula dos veces', async () => {
    const issued = await issue(attendance());

    const refused = await post(
      `/certificates/${issued.certificate.id}/revoke`,
      doctor.token,
      {},
    ).expect(422);
    expect(
      (refused.body as Problem).errors?.some((e) => e.field === 'reason'),
    ).toBe(true);

    const revoked = await post(
      `/certificates/${issued.certificate.id}/revoke`,
      doctor.token,
      { reason: 'Se emitió con el tipo equivocado' },
    ).expect(200);
    expect(revoked.body as CertificateBody).toMatchObject({
      id: issued.certificate.id,
      number: 1,
      revocationReason: 'Se emitió con el tipo equivocado',
    });
    expect((revoked.body as CertificateBody).revokedAt).not.toBeNull();

    const row = await prisma.medicalCertificate.findUniqueOrThrow({
      where: { id: issued.certificate.id },
      select: { revokedById: true, revocationReason: true, number: true },
    });
    expect(row).toEqual({
      revokedById: doctor.userId,
      revocationReason: 'Se emitió con el tipo equivocado',
      number: 1,
    });

    const twice = await post(
      `/certificates/${issued.certificate.id}/revoke`,
      doctor.token,
      { reason: 'Otra vez' },
    ).expect(409);
    expect((twice.body as Problem).code).toBe('CERTIFICATE_ALREADY_REVOKED');
  });

  it('CER-015 enfermeria lee pero no emite ni anula; recepcion no lee', async () => {
    const issued = await issue(attendance());

    await post(
      `/encounters/${encounterId}/certificates`,
      nurseToken,
      attendance(),
    ).expect(403);
    await post(`/certificates/${issued.certificate.id}/revoke`, nurseToken, {
      reason: 'No le corresponde',
    }).expect(403);
    // Control positivo: el mismo token lee, que es `record:read`.
    await get(`/certificates/${issued.certificate.id}`, nurseToken).expect(200);

    await get(`/certificates/${issued.certificate.id}`, receptionToken).expect(
      403,
    );
    await get(`/encounters/${encounterId}/certificates`, receptionToken).expect(
      403,
    );
  });

  it('CER-016 emitir, leer, listar y anular dejan su fila en la bitacora de acceso', async () => {
    const issued = await issue(attendance());
    await get(`/certificates/${issued.certificate.id}`, doctor.token).expect(
      200,
    );
    await get(`/encounters/${encounterId}/certificates`, doctor.token).expect(
      200,
    );
    await post(`/certificates/${issued.certificate.id}/revoke`, doctor.token, {
      reason: 'Se emitió con el tipo equivocado',
    }).expect(200);

    const rows = await prisma.accessAudit.findMany({
      where: { resourceType: 'certificate', resourceId: issued.certificate.id },
      orderBy: { id: 'asc' },
      select: { action: true, userId: true },
    });
    expect(rows).toEqual([
      { action: 'CREATE', userId: doctor.userId },
      { action: 'READ', userId: doctor.userId },
      { action: 'READ', userId: doctor.userId },
      { action: 'UPDATE', userId: doctor.userId },
    ]);
  });
});
