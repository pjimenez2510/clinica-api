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
  atWallClock,
  clinicalDateOf,
  WallClockTime,
  type ClinicalDate,
} from '../../src/shared/domain/clinic-time';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createDiagnosis, createPatient, createSite } from './setup/fixtures';
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
  certificate: CertificateBody & {
    contingencyType: string | null;
    birthOn: string | null;
    backdatingReason: string | null;
  };
  iess: { lastValidationDay: string; notice: string } | null;
  restNotices: string[];
}

/** The form 117 as GET /certificates/:id serves it. */
interface Form117Body {
  number: number;
  verificationCode: string;
  revocation: { revokedAt: string; revokedOn: string; reason: string } | null;
  establishment: Record<string, string>;
  patient: Record<string, unknown>;
  attention: Record<string, unknown> & { date: { iso: string } };
  rest: Record<string, unknown> & { periodInWords: string };
  confidential: boolean;
  contingency: string;
  maternity: unknown;
  placeOfIssue: string;
  letterhead: Record<string, unknown>;
  work: Record<string, string> | 'NA';
  diagnoses: { code: string; display: string }[] | 'NA';
  professional: Record<string, unknown>;
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
    await giveParish(siteId);
    // An hour ago, but never before today's midnight in Ecuador: an attention
    // of yesterday would make every rest issued here a late one (CER-030).
    const now = new Date();
    const started = new Date(
      Math.max(
        now.getTime() - 60 * 60 * 1000,
        atWallClock(clinicalDateOf(now), WallClockTime.of(0, 0)).getTime(),
      ),
    );
    today = clinicalDateOf(started);

    patientId = (
      await createPatient(prisma, {
        // Un lactante de unos cuatro meses: 125 días antes de la atención.
        birthDate: new Date(`${addDays(today, -125)}T00:00:00Z`),
      })
    ).id;
    // CER-038, PA-061. Lo que el reposo lee de la ficha.
    await prisma.patient.update({
      where: { id: patientId },
      data: {
        employerName: 'Florícola del Valle',
        jobTitle: 'Supervisora de cultivo',
        residenceAddressLine: 'Calle Sucre 4-12',
        phone: '0991234567',
      },
    });

    doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    nurseToken = (
      await signIn('ENFERMERIA', 'enfermeria@clinica.ec', '1104637283')
    ).token;
    receptionToken = (
      await signIn('RECEPCION', 'recepcion@clinica.ec', '0926687856', false)
    ).token;

    encounterId = (await anEncounter(siteId, started)).id;
  }

  /**
   * CER-036. The place of issue is the CANTON of the site's DPA parish, as
   * PR-021 reads it: without a parish there is no certificate.
   */
  async function giveParish(site: string) {
    const dpa = await prisma.catalogSystem.upsert({
      where: { code: 'DPA' },
      create: { code: 'DPA', name: 'DPA', hierarchical: true },
      update: {},
    });
    const canton = await prisma.catalogConcept.create({
      data: {
        systemId: dpa.id,
        code: `17${site.slice(-4)}`,
        display: 'Quito',
        validFrom: new Date('2010-01-01'), // fecha-fija: vigente desde siempre
      },
    });
    const parish = await prisma.catalogConcept.create({
      data: {
        systemId: dpa.id,
        code: `1701${site.slice(-4)}`,
        display: 'Iñaquito',
        parentId: canton.id,
        validFrom: new Date('2010-01-01'), // fecha-fija: vigente desde siempre
      },
    });
    await prisma.site.update({
      where: { id: site },
      data: {
        parishConceptId: parish.id,
        addressLine: 'Av. Amazonas N24-10',
        phone: '022345678',
      },
    });
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
    // CER-007, CER-034. A rest always carries the diagnosis and its
    // contingency.
    includeDiagnosis: true,
    contingencyType: 'GENERAL_ILLNESS',
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

  async function aDiagnosis(encounter: string, code = 'J00') {
    await createDiagnosis(prisma, encounter, code, code === 'J00' ? 'Rinofaringitis aguda' : undefined); // prettier-ignore
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
    await aDiagnosis(encounterId);
    const issued = await issue(restOf(3));

    expect(issued.certificate.restFrom).toBe(today);
    expect(issued.certificate.restTo).toBe(addDays(today, 2));
    expect(issued.iess?.lastValidationDay).toBe(addDays(today, 10));
    expect(issued.iess?.notice).toContain('Seguro Social Campesino');
    expect(issued.iess?.notice).toContain('menores de edad');
  });

  it('CER-006 rechaza un reposo que termina antes de empezar, nombrando el campo', async () => {
    await aDiagnosis(encounterId);
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

  it('CER-039 otro médico de la sede emite sobre la atención ajena sólo con motivo, y el motivo queda en la fila', async () => {
    const colleague = await signIn('MEDICO', 'colega@clinica.ec', '1712345675');
    const path = `/encounters/${encounterId}/certificates`;

    const refused = await post(path, colleague.token, attendance()).expect(422);
    expect((refused.body as Problem).code).toBe(
      'CERTIFICATE_ISSUER_REASON_REQUIRED',
    );
    expect((refused.body as Problem).errors?.map((e) => e.field)).toEqual([
      'issuedByOtherReason',
    ]);
    expect(await prisma.medicalCertificate.count()).toBe(0);

    const issued = await post(
      path,
      colleague.token,
      attendance({ issuedByOtherReason: 'Cubre el turno de la doctora' }),
    ).expect(201);
    const row = await prisma.medicalCertificate.findUniqueOrThrow({
      where: { id: (issued.body as IssuedBody).certificate.id },
      select: { issuedById: true, issuedByOtherReason: true },
    });
    expect(row).toEqual({
      issuedById: colleague.practitionerId,
      issuedByOtherReason: 'Cubre el turno de la doctora',
    });
  });

  it('CER-044 un reposo que empieza 4 días antes de la atención responde 422 en restFrom, aun con motivo (D-106 §1)', async () => {
    const response = await post(
      `/encounters/${encounterId}/certificates`,
      doctor.token,
      restOf(5, {
        restFrom: addDays(today, -4),
        restTo: today,
        backdatingReason: 'Fiebre desde hace cuatro días',
      }),
    ).expect(422);
    expect((response.body as Problem).code).toBe(
      'CERTIFICATE_REST_START_TOO_EARLY',
    );
    expect((response.body as Problem).errors?.[0]?.field).toBe('restFrom');
    expect(await prisma.medicalCertificate.count()).toBe(0);
  });

  it('CER-045 un reposo sobre una atención de hace nueve días responde 422 en type (D-106 §4)', async () => {
    const nineDaysAgo = atWallClock(addDays(clinicalDateOf(new Date()), -9), WallClockTime.of(12, 0)); // prettier-ignore
    const old = await anEncounter(siteId, nineDaysAgo);

    const response = await post(
      `/encounters/${old.id}/certificates`,
      doctor.token,
      restOf(1, { backdatingReason: 'Volvió nueve días después' }),
    ).expect(422);
    expect((response.body as Problem).code).toBe(
      'CERTIFICATE_REST_ISSUED_TOO_LATE',
    );
    expect((response.body as Problem).errors?.[0]?.field).toBe('type');
  });

  it('CER-041 un reposo que empieza en 90 días se rechaza nombrando restFrom, y uno desde mañana pasa', async () => {
    const far = addDays(clinicalDateOf(new Date()), 90);
    const refused = await post(
      `/encounters/${encounterId}/certificates`,
      doctor.token,
      restOf(3, { restFrom: far, restTo: addDays(far, 2) }),
    ).expect(422);
    expect((refused.body as Problem).code).toBe(
      'CERTIFICATE_REST_START_TOO_LATE',
    );
    expect((refused.body as Problem).errors?.[0]?.field).toBe('restFrom');

    // Control positivo: desde mañana, con el diagnóstico que el reposo lleva.
    await aDiagnosis(encounterId);
    const tomorrow = addDays(clinicalDateOf(new Date()), 1);
    await issue(restOf(1, { restFrom: tomorrow, restTo: tomorrow }));
  });

  it('CER-040 otro médico no anula un certificado ajeno y la fila queda intacta; con el permiso de dirección médica, sí', async () => {
    const issued = await issue(attendance());
    const path = `/certificates/${issued.certificate.id}/revoke`;
    const reason = { reason: 'Emitido a la persona equivocada' };

    const colleague = await signIn('MEDICO', 'colega@clinica.ec', '1712345675');
    const refused = await post(path, colleague.token, reason).expect(403);
    expect((refused.body as Problem).code).toBe('CERTIFICATE_REVOKE_FORBIDDEN');
    expect(
      await prisma.medicalCertificate.findUniqueOrThrow({
        where: { id: issued.certificate.id },
        select: { revokedAt: true, revokedById: true, revocationReason: true },
      }),
    ).toEqual({ revokedAt: null, revokedById: null, revocationReason: null });

    // «Dirección médica» no es un rol de fábrica: la clínica arma uno.
    const direction = await prisma.role.create({
      data: { code: 'DIRECCION_MEDICA', name: 'Dirección médica' },
    });
    await prisma.rolePermission.createMany({
      data: ['record:read', 'record:write', 'certificate:revoke-any'].map(
        (permissionCode) => ({ roleId: direction.id, permissionCode }),
      ),
    });
    registry.invalidate();
    const director = await signIn(
      'DIRECCION_MEDICA',
      'direccion@clinica.ec',
      '0923456784',
    );
    const revoked = await post(path, director.token, reason).expect(200);
    expect((revoked.body as CertificateBody).revocationReason).toBe(
      reason.reason,
    );
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

  it('CER-020 a CER-029 el reposo de tres dias de un lactante de cuatro meses, sobre el formulario 117', async () => {
    // CER-020. La cédula del paciente es su número de historia clínica única.
    // Sintética, con dígito verificador calculado.
    await prisma.patientIdentifier.create({
      data: { patientId, type: 'CEDULA', value: '1712345675' },
    });
    // CER-022. La especialidad principal del profesional.
    const specialty = await prisma.specialty.create({
      data: { code: 'PEDIATRIA', name: 'Pediatría' },
    });
    await prisma.practitionerSpecialty.create({
      data: {
        practitionerId: doctor.practitionerId,
        specialtyId: specialty.id,
        isPrimary: true,
      },
    });
    await aDiagnosis(encounterId);

    const issued = await issue(restOf(3));
    const response = await get(
      `/certificates/${issued.certificate.id}`,
      doctor.token,
    ).expect(200);
    const form = response.body as Form117Body;

    const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
    const patient = await prisma.patient.findUniqueOrThrow({
      where: { id: patientId },
    });
    expect(form.establishment).toEqual({
      institution: 'NA',
      mspUnicode: site.mspUnicode,
      name: site.name,
      clinicalRecordNumber: '1712345675',
      archiveNumber: patient.mrn,
    });
    expect(form.patient).toEqual({
      firstFamilyName: 'Guamán',
      secondFamilyName: 'NA',
      firstGivenName: 'María',
      secondGivenName: 'NA',
      sex: 'Mujer',
      age: { value: '4', condition: 'M' },
    });
    expect(form.attention).toMatchObject({
      service: 'Consulta externa',
      specialty: 'Pediatría',
      admissionDate: 'NA',
      dischargeDate: 'NA',
    });
    expect(form.attention.date.iso).toBe(today);
    expect(form.rest).toMatchObject({
      rest: 'SÍ',
      days: '3',
      daysInWords: 'tres',
    });
    expect(form.rest).not.toHaveProperty('hours');
    expect(form.rest.periodInWords).toMatch(/ambas fechas incluidas$/);
    // CER-033, CER-034, CER-036, CER-037.
    expect(form.confidential).toBe(true);
    expect(form.contingency).toBe('Enfermedad general');
    expect(form.maternity).toBe('NA');
    expect(form.placeOfIssue).toBe('Quito');
    // CER-038. Los datos laborales, leídos de la ficha.
    expect(form.work).toEqual({
      employer: 'Florícola del Valle',
      jobTitle: 'Supervisora de cultivo',
      address: 'Calle Sucre 4-12',
      phone: '0991234567',
    });
    expect(form.letterhead).toEqual({
      address: 'Av. Amazonas N24-10',
      phone: '022345678',
      email: null,
    });
    expect(form.rest.from).toMatchObject({ iso: today });
    expect(form.rest.to).toMatchObject({ iso: addDays(today, 2) });
    expect((form.rest.from as { inWords: string }).inWords).toMatch(
      / de [a-z]+ de dos mil /,
    );
    expect(form.diagnoses).toEqual([
      { code: 'J00', display: 'Rinofaringitis aguda' },
    ]);
    expect(form.professional).toMatchObject({
      givenNames: 'Ana Lucía',
      familyNames: 'Villacís Mora',
      identification: '1710034065',
      hasSeal: false,
      signature: 'CREDENTIAL',
    });
    expect(form).toMatchObject({
      number: 1,
      verificationCode: issued.certificate.verificationCode,
      revocation: null,
    });

    // CER-029. Anulado, el documento lo dice con su fecha.
    await post(`/certificates/${issued.certificate.id}/revoke`, doctor.token, {
      reason: 'Se emitió con el período equivocado',
    }).expect(200);
    const revoked = (
      await get(`/certificates/${issued.certificate.id}`, doctor.token).expect(
        200,
      )
    ).body as Form117Body;
    expect(revoked.revocation).toMatchObject({
      revokedOn: clinicalDateOf(new Date()),
      reason: 'Se emitió con el período equivocado',
    });
  });

  it('CER-027 sin incluir el diagnostico, el bloque D es NA aunque la atencion lo tenga', async () => {
    await aDiagnosis(encounterId);
    const issued = await issue(attendance());

    const form = (
      await get(`/certificates/${issued.certificate.id}`, doctor.token).expect(
        200,
      )
    ).body as Form117Body;
    expect(form.diagnoses).toBe('NA');
    expect(form.rest).toEqual({
      rest: 'NO',
      days: 'NA',
      daysInWords: 'NA',
      from: 'NA',
      to: 'NA',
      periodInWords: 'NA',
    });
    expect(form.confidential).toBe(false);
    expect(form.contingency).toBe('NA');
  });

  /** A refused issue: the code, and the fields the problem names. */
  async function refused(body: object) {
    const response = await post(
      `/encounters/${encounterId}/certificates`,
      doctor.token,
      body,
    ).expect(422);
    const problem = response.body as Problem;
    return {
      code: problem.code,
      fields: problem.errors?.map((error) => error.field) ?? [],
    };
  }

  it('CER-007 un reposo que dice no llevar diagnostico se rechaza en ese campo', async () => {
    await aDiagnosis(encounterId);
    expect(await refused(restOf(3, { includeDiagnosis: false }))).toEqual({
      code: 'CERTIFICATE_REST_PERIOD_INVALID',
      fields: ['includeDiagnosis'],
    });
    // Control positivo: el mismo reposo con diagnóstico.
    expect((await issue(restOf(3))).certificate.includeDiagnosis).toBe(true);
  });

  it('CER-030 un reposo retroactivo sin motivo se rechaza, y con motivo se guarda', async () => {
    await aDiagnosis(encounterId);
    const backdated = restOf(3, {
      restFrom: addDays(today, -2),
      restTo: today,
    });

    expect(await refused(backdated)).toEqual({
      code: 'CERTIFICATE_BACKDATING_REASON_REQUIRED',
      fields: ['backdatingReason'],
    });
    expect(await prisma.medicalCertificate.count()).toBe(0);

    const issued = await issue({
      ...backdated,
      backdatingReason: 'Acudió dos días tarde por la fiebre',
    });
    expect(issued.certificate.backdatingReason).toBe(
      'Acudió dos días tarde por la fiebre',
    );
    const row = await prisma.medicalCertificate.findUniqueOrThrow({
      where: { id: issued.certificate.id },
      select: { restBackdatingReason: true },
    });
    expect(row.restBackdatingReason).toBe(
      'Acudió dos días tarde por la fiebre',
    );
  });

  it('CER-031 rechaza un reposo de 31 dias y admite uno de 30', async () => {
    await aDiagnosis(encounterId);
    expect((await refused(restOf(31))).code).toBe('CERTIFICATE_REST_TOO_LONG');
    expect((await issue(restOf(30))).certificate.restTo).toBe(
      addDays(today, 29),
    );
  });

  it('CER-032 el aviso de reposo largo depende de la especialidad principal del emisor', async () => {
    await aDiagnosis(encounterId);
    // Sin especialidad: umbral de 3 días.
    expect((await issue(restOf(3))).restNotices).toEqual([]);
    expect((await issue(restOf(4))).restNotices).toEqual([
      'Este reposo es de 4 días. El IESS puede pedir una cita de control o una justificación para validar reposos largos; compruebe que el paciente pueda validarlo.',
    ]);

    // Un especialista: umbral de 7 días.
    const specialty = await prisma.specialty.create({
      data: { code: 'pediatria', name: 'Pediatría' },
    });
    await prisma.practitionerSpecialty.create({
      data: {
        practitionerId: doctor.practitionerId,
        specialtyId: specialty.id,
        isPrimary: true,
      },
    });
    expect((await issue(restOf(7))).restNotices).toEqual([]);
    expect((await issue(restOf(8))).restNotices).toEqual([
      expect.stringContaining('Este reposo es de 8 días.'),
    ]);
  });

  it('CER-034 un reposo sin contingencia se rechaza en ese campo', async () => {
    await aDiagnosis(encounterId);
    expect(await refused(restOf(3, { contingencyType: undefined }))).toEqual({
      code: 'CERTIFICATE_REST_PERIOD_INVALID',
      fields: ['contingencyType'],
    });
    expect(
      (await refused(attendance({ contingencyType: 'GENERAL_ILLNESS' })))
        .fields,
    ).toEqual(['contingencyType']);
  });

  it('CER-048 la emision espera a la que tiene el candado de la paciente y, al verla, responde CERTIFICATE_REST_OVERLAPS', async () => {
    // Otra atención de la misma paciente, el mismo día, con su diagnóstico.
    const { startedAt } = await prisma.encounter.findUniqueOrThrow({
      where: { id: encounterId },
    });
    const second = (await anEncounter(siteId, startedAt)).id;
    await aDiagnosis(encounterId, 'O80');
    await aDiagnosis(second, 'O80');
    const admission = addDays(today, -1);
    const discharge = addDays(today, 2);
    const until = addDays(today, 9);

    // Una emisión en curso desde la otra atención: inserta (el disparador toma
    // el candado de la paciente) y NO confirma hasta que se la suelte.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding!: () => void;
    const locked = new Promise<void>((resolve) => (holding = resolve));
    const first = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          INSERT INTO medical_certificate
            (encounter_id, patient_id, issued_by_id, type, rest_from, rest_to,
             include_diagnosis, contingency_type, verification_code, issued_at,
             maternity_admission_on, birth_on, maternity_discharge_on)
          VALUES (${second}::uuid, ${patientId}::uuid, ${doctor.practitionerId}::uuid,
                  'MEDICAL_REST', ${today}::date, ${until}::date, true, 'MATERNITY',
                  'CER048-RACE-0001', ${startedAt},
                  ${admission}::date, ${today}::date, ${discharge}::date)`;
        holding();
        await held;
      },
      { timeout: 20_000 },
    );
    await locked;

    // La emisión por la API sobre la otra atención, a la vez.
    const answer = post(
      `/encounters/${encounterId}/certificates`,
      doctor.token,
      restOf(10, {
        contingencyType: 'MATERNITY',
        maternityAdmissionOn: admission,
        birthOn: today,
        maternityDischargeOn: discharge,
      }),
    ).then((response) => response);
    // Espera el candado: sigue sin respuesta.
    const early = await Promise.race([
      answer.then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 500)),
    ]);
    expect(early).toBe('waiting');
    release();
    await first;

    // El repositorio leyó los reposos TRAS el candado: lo rechaza el dominio,
    // con su código. Sin ese candado los habría leído antes y lo pararía el
    // disparador, con un código genérico.
    const response = await answer;
    expect(response.status).toBe(409);
    expect((response.body as Problem).code).toBe('CERTIFICATE_REST_OVERLAPS');
    expect(
      await prisma.medicalCertificate.count({ where: { patientId } }),
    ).toBe(1);
  });

  it('CER-035 la maternidad sin fecha de parto se rechaza nombrandola, y con las tres se sirve en letras', async () => {
    // CER-049: la maternidad, sobre una atención con diagnóstico obstétrico.
    await aDiagnosis(encounterId, 'O80');
    const maternity = restOf(30, {
      contingencyType: 'MATERNITY',
      maternityAdmissionOn: addDays(today, -1),
      maternityDischargeOn: addDays(today, 2),
    });
    expect((await refused(maternity)).fields).toEqual(['birthOn']);

    const issued = await issue({ ...maternity, birthOn: today });
    expect(issued.certificate.birthOn).toBe(today);
    const form = (
      await get(`/certificates/${issued.certificate.id}`, doctor.token).expect(
        200,
      )
    ).body as Form117Body;
    expect(form.contingency).toBe('Maternidad');
    expect(form.maternity).toMatchObject({
      admission: { iso: addDays(today, -1) },
      birth: { iso: today },
      discharge: { iso: addDays(today, 2) },
    });
  });

  it('CER-038 un reposo con la ficha sin empresa ni telefono se emite con el aviso, y la ficha corregida lo imprime', async () => {
    await aDiagnosis(encounterId);
    await prisma.patient.update({
      where: { id: patientId },
      data: { employerName: null, phone: null },
    });

    // D-101: se emite igual, y el aviso dice qué falta.
    const incomplete = await issue(restOf(3));
    expect(incomplete.restNotices).toEqual([
      'Falta en la ficha la empresa y el teléfono del paciente. El IESS puede devolver el reposo sin estos datos; complételos en la ficha.',
    ]);
    const blank = (
      await get(
        `/certificates/${incomplete.certificate.id}`,
        doctor.token,
      ).expect(200)
    ).body as Form117Body;
    expect(blank.work).toMatchObject({ employer: 'NA' });

    // Control positivo: corregida la ficha, el siguiente reposo los lleva y no avisa.
    await prisma.patient.update({
      where: { id: patientId },
      data: { employerName: 'Florícola del Valle', phone: '0991234567' },
    });
    const issued = await issue(restOf(3));
    expect(issued.restNotices).toEqual([]);
    const form = (
      await get(`/certificates/${issued.certificate.id}`, doctor.token).expect(
        200,
      )
    ).body as Form117Body;
    expect(form.work).toMatchObject({ employer: 'Florícola del Valle' });
  });

  it('CER-027 CER-038 lo emitido no cambia: ni un diagnostico registrado despues ni la ficha corregida llegan al certificado', async () => {
    await aDiagnosis(encounterId);
    const issued = await issue(restOf(3));

    // After the issue: a second diagnosis and a corrected chart.
    const system = await prisma.catalogSystem.findUniqueOrThrow({
      where: { code: 'CIE10' },
    });
    const later = await prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code: 'F32',
        display: 'Episodio depresivo',
        validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
      },
    });
    await prisma.encounterDiagnosis.create({
      data: {
        encounterId,
        conceptId: later.id,
        cie10Code: 'F32',
        cie10Display: 'Episodio depresivo',
        certainty: 'DEFINITIVE',
        occurrence: 'FIRST_TIME',
        rank: 2,
      },
    });
    await prisma.patient.update({
      where: { id: patientId },
      data: { employerName: 'Otra empresa S.A.' },
    });

    const form = (
      await get(`/certificates/${issued.certificate.id}`, doctor.token).expect(
        200,
      )
    ).body as Form117Body;
    // Control positivo: lo que había al emitir sí está.
    expect(form.diagnoses).toEqual([
      { code: 'J00', display: 'Rinofaringitis aguda' },
    ]);
    expect(form.work).toMatchObject({ employer: 'Florícola del Valle' });

    // Y un certificado nuevo sí lee la atención y la ficha de ahora.
    const next = (
      await get(
        `/certificates/${(await issue(restOf(3))).certificate.id}`,
        doctor.token,
      ).expect(200)
    ).body as Form117Body;
    expect(next.diagnoses).toHaveLength(2);
    expect(next.work).toMatchObject({ employer: 'Otra empresa S.A.' });
  });

  it('CER-027 la emisión congela la certeza de cada diagnóstico, y corregirla después no cambia el papel', async () => {
    await aDiagnosis(encounterId);
    const issued = await issue(restOf(3));

    const frozen = async () =>
      (
        await prisma.medicalCertificate.findUniqueOrThrow({
          where: { id: issued.certificate.id },
          select: { diagnoses: true },
        })
      ).diagnoses;
    // Copied at the issue with the attention's certainty (the fixture's DEF).
    expect(await frozen()).toEqual([
      { code: 'J00', display: 'Rinofaringitis aguda', certainty: 'DEFINITIVE' },
    ]);

    // Corrected afterwards on the attention: the issued copy does not move.
    await prisma.encounterDiagnosis.updateMany({
      where: { encounterId, cie10Code: 'J00' },
      data: { certainty: 'PRESUMPTIVE' },
    });
    expect(await frozen()).toEqual([
      { code: 'J00', display: 'Rinofaringitis aguda', certainty: 'DEFINITIVE' },
    ]);

    // Control: a certificate issued now copies the corrected one.
    const next = await issue(restOf(3));
    expect(
      (
        await prisma.medicalCertificate.findUniqueOrThrow({
          where: { id: next.certificate.id },
          select: { diagnoses: true },
        })
      ).diagnoses,
    ).toEqual([
      {
        code: 'J00',
        display: 'Rinofaringitis aguda',
        certainty: 'PRESUMPTIVE',
      },
    ]);

    // The screen's contract is unchanged: code and display (the DTO).
    const form = (
      await get(`/certificates/${issued.certificate.id}`, doctor.token).expect(
        200,
      )
    ).body as Form117Body;
    expect(form.diagnoses).toEqual([
      { code: 'J00', display: 'Rinofaringitis aguda' },
    ]);
  });

  it('CER-036 una sede sin parroquia no emite certificados', async () => {
    // Control positivo: la sede con parroquia emite.
    await issue(attendance());

    await prisma.site.update({
      where: { id: siteId },
      data: { parishConceptId: null },
    });
    expect((await refused(attendance())).code).toBe(
      'CERTIFICATE_ESTABLISHMENT_INCOMPLETE',
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
