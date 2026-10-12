import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { ViolenceScreeningService } from '../../src/modules/encounter/application/violence-screening.service';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { withReadRevision } from './setup/read-revision';
import { createDiagnosis, createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * Block F of form 002 through the HTTP door, with REAL SESSIONS of the seeded
 * roles (EN-070 to EN-077, EN-240).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY SESSIONS AND NOT PERMISSIONS SET BY HAND
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * EN-072, EN-073 and EN-075 are «solo servidor»: a screen that decides not to
 * paint something does not prove it did not travel. AG-111's defect was
 * trusting a double with the permissions put in by hand, so every caller here
 * signs in with a role exactly as `syncAuthorisation` builds it — `MEDICO`
 * carries the second key, `ENFERMERIA` carries `record:read` and not the key.
 * If the seed stopped giving the key to the doctor, or started giving it to
 * nursing, these tests would see it.
 */
const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

const COMPLETE_002 = {
  motivoConsulta: 'Dolor abdominal de dos días',
  antecedentes: 'Sin antecedentes patológicos de importancia',
  enfermedadActual: 'Dolor en epigastrio, sin irradiación',
  revisionOrganosSistemas: 'Resto de sistemas sin particularidades',
  examenFisico: 'Abdomen blando, doloroso a la palpación',
  planTratamiento: 'Dieta blanda y control en 72 horas',
};

/** Words that only a screening would put in a response. */
const ACTION = 'Derivada a la Junta Cantonal de Protección';
const SERIAL = 'SERIE-0098765';
const POSITIVE = {
  result: 'CONFIRMED',
  types: ['PHYSICAL', 'SEXUAL'],
  actionTaken: ACTION,
  notification: {
    formSerial: SERIAL,
    injury: 'DISABILITY',
    aggressorIdentified: 'YES',
    aggressorRelationship: 'RELATIVE',
  },
};
const TELLTALES = [ACTION, SERIAL, 'CONFIRMED', 'PHYSICAL', 'RELATIVE'];

describe('el tamizaje de violencia por HTTP, con sesiones reales (EN-070 a EN-077, EN-240)', () => {
  const db = useDatabase();
  let app: NestExpressApplication | undefined;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let patientId: string;
  let doctorToken: string;
  let doctorPractitionerId: string;
  let secondDoctorToken: string;
  let secondDoctorPractitionerId: string;
  let nurseToken: string;
  let elsewhereDoctorToken: string;
  let otherSiteId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // The STORE and not the guard: `APP_GUARD` also carries the
        // authorisation guard, which is what this file is about.
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

    await syncAuthorisation(prisma);
    registry.invalidate();

    const site = await createSite(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    const patient = await createPatient(prisma);
    siteId = site.id;
    otherSiteId = otherSite.id;
    patientId = patient.id;

    const doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065', siteId); // prettier-ignore
    doctorToken = doctor.token;
    doctorPractitionerId = doctor.practitionerId;
    const second = await signIn('MEDICO', 'medico2@clinica.ec', '0602910945', siteId); // prettier-ignore
    secondDoctorToken = second.token;
    secondDoctorPractitionerId = second.practitionerId;
    nurseToken = (await signIn('ENFERMERIA', 'enfermeria@clinica.ec', '1104637283', siteId)).token; // prettier-ignore
    // A doctor whose key and record:read are at ANOTHER site (EN-121).
    elsewhereDoctorToken = (await signIn('MEDICO', 'medico3@clinica.ec', '0926687856', otherSite.id)).token; // prettier-ignore
  });

  afterAll(async () => {
    await closeApp(app);
  });

  /** One account with one seeded role, granted at one site. */
  async function signIn(
    roleCode: string,
    email: string,
    cedula: string,
    atSite: string,
  ): Promise<{ token: string; practitionerId: string }> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Ana',
        lastName: 'Villacís',
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    const practitioner = await prisma.practitioner.create({
      data: { userId: user.id },
    });
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId: atSite },
    });

    const response = await request(app!.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      token: (response.body as { accessToken: string }).accessToken,
      practitionerId: practitioner.id,
    };
  }

  /**
   * An account whose permissions are split across sites, through roles of the
   * clinic's own (roles are data): what makes the site scope of the second
   * key checkable at all.
   */
  async function signInSplit(
    email: string,
    cedula: string,
    grants: { permissions: string[]; siteId: string }[],
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Luis',
        lastName: 'Andrade',
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    await prisma.practitioner.create({ data: { userId: user.id } });
    for (const [index, grant] of grants.entries()) {
      const role = await prisma.role.create({
        data: {
          code: `PROPIO_${index}_${cedula}`,
          name: `Rol propio ${index}`,
          permissions: {
            create: grant.permissions.map((permissionCode) => ({ permissionCode })), // prettier-ignore
          },
        },
      });
      await prisma.userRoleGrant.create({
        data: { userId: user.id, roleId: role.id, siteId: grant.siteId },
      });
    }
    registry.invalidate();
    const response = await request(app!.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  const send = (
    method: 'get' | 'post' | 'put',
    path: string,
    token: string,
    body?: object,
  ) => {
    const call = request(app!.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`);
    // EN-281. A write on a draft carries the revision just read.
    return withReadRevision(
      prisma,
      path,
      body === undefined ? call : call.send(body),
    );
  };

  async function openEncounter(): Promise<string> {
    const response = await send('post', '/encounters', doctorToken, {
      siteId,
      practitionerId: doctorPractitionerId,
      patientId,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    }).expect(201);
    return (response.body as { id: string }).id;
  }

  const screeningReads = (encounterId: string) =>
    prisma.accessAudit.count({
      where: {
        resourceType: 'encounter_screening',
        resourceId: encounterId,
        action: 'READ',
      },
    });

  describe('EN-072 la segunda llave: omitir al leer, rechazar al escribir', () => {
    it('EN-072 enfermería abre la atención y su tamizaje responde 200 sin el campo, aunque exista; el médico lo ve', async () => {
      const encounterId = await openEncounter();
      await send('put', `/encounters/${encounterId}/screening`, doctorToken, POSITIVE).expect(200); // prettier-ignore

      // ENFERMERIA has record:read: it opens the attention...
      await send('get', `/encounters/${encounterId}`, nurseToken).expect(200);
      // ...and the screening is OMITTED: no 403, no `screening` key at all.
      const omitted = await send('get', `/encounters/${encounterId}/screening`, nurseToken).expect(200); // prettier-ignore
      expect(omitted.body).toEqual({});
      expect(await screeningReads(encounterId)).toBe(0);

      // Positive control: the doctor, through the same route, sees it.
      const seen = await send('get', `/encounters/${encounterId}/screening`, doctorToken).expect(200); // prettier-ignore
      expect(seen.body).toMatchObject({
        screening: { result: 'CONFIRMED', types: ['PHYSICAL', 'SEXUAL'] },
      });
    });

    it('EN-072 sin la llave la omisión es la misma haya o no tamizaje: no hay oráculo', async () => {
      const answered = await openEncounter();
      const unanswered = await openEncounter();
      await send('put', `/encounters/${answered}/screening`, doctorToken, POSITIVE).expect(200); // prettier-ignore

      const a = await send('get', `/encounters/${answered}/screening`, nurseToken).expect(200); // prettier-ignore
      const b = await send('get', `/encounters/${unanswered}/screening`, nurseToken).expect(200); // prettier-ignore
      expect(a.body).toEqual(b.body);

      // Positive control: with the key the two DO differ.
      const c = await send('get', `/encounters/${answered}/screening`, doctorToken).expect(200); // prettier-ignore
      const d = await send('get', `/encounters/${unanswered}/screening`, doctorToken).expect(200); // prettier-ignore
      expect(d.body).toEqual({ screening: null });
      expect(c.body).not.toEqual(d.body);
    });

    it('EN-072 rechaza que enfermería lo registre (403) y deja al médico', async () => {
      const encounterId = await openEncounter();

      const refused = await send('put', `/encounters/${encounterId}/screening`, nurseToken, { result: 'NO_SIGNS' }).expect(403); // prettier-ignore
      // The refusal names neither the data nor the patient: only the path the
      // caller itself typed (`instance`).
      const rest = { ...(refused.body as object), instance: undefined };
      expect(JSON.stringify(rest)).not.toMatch(/violen|tamizaje/i);
      expect(await prisma.violenceScreening.count()).toBe(0);

      await send('put', `/encounters/${encounterId}/screening`, doctorToken, { result: 'NO_SIGNS' }).expect(200); // prettier-ignore
      expect(await prisma.violenceScreening.count()).toBe(1);
    });

    it('EN-072 una atención de otra sede es 404 para leer y para escribir, con llave y todo', async () => {
      const encounterId = await openEncounter();
      await send('put', `/encounters/${encounterId}/screening`, doctorToken, POSITIVE).expect(200); // prettier-ignore

      await send('get', `/encounters/${encounterId}/screening`, elsewhereDoctorToken).expect(404); // prettier-ignore
      await send('put', `/encounters/${encounterId}/screening`, elsewhereDoctorToken, { result: 'NO_SIGNS' }).expect(404); // prettier-ignore

      // Positive control: in scope it reads.
      await send('get', `/encounters/${encounterId}/screening`, doctorToken).expect(200); // prettier-ignore
    });
  });

  describe('EN-072 la llave vale en la sede de la atención', () => {
    it('EN-072 con record:read en la sede y la llave sólo en otra, la respuesta es la omisión', async () => {
      const encounterId = await openEncounter();
      await send('put', `/encounters/${encounterId}/screening`, doctorToken, POSITIVE).expect(200); // prettier-ignore
      const token = await signInSplit('partida1@clinica.ec', '1701234567', [
        { permissions: ['record:read'], siteId },
        { permissions: ['record:protected'], siteId: otherSiteId },
      ]);

      const response = await send('get', `/encounters/${encounterId}/screening`, token).expect(200); // prettier-ignore
      expect(response.body).toEqual({});
      expect(await screeningReads(encounterId)).toBe(0);
    });

    it('EN-072 con la llave en la sede y record:write sólo en otra, registrar es 404; con las dos en la sede, se registra', async () => {
      const encounterId = await openEncounter();
      const split = await signInSplit('partida2@clinica.ec', '0907654321', [
        { permissions: ['record:read', 'record:protected'], siteId },
        { permissions: ['record:write'], siteId: otherSiteId },
      ]);

      await send('put', `/encounters/${encounterId}/screening`, split, { result: 'NO_SIGNS' }).expect(404); // prettier-ignore
      expect(await prisma.violenceScreening.count()).toBe(0);

      // Positive control: the doctor holds both at this site.
      await send('put', `/encounters/${encounterId}/screening`, doctorToken, { result: 'NO_SIGNS' }).expect(200); // prettier-ignore
      expect(await prisma.violenceScreening.count()).toBe(1);
    });
  });

  describe('EN-075 una fila de bitácora por lectura', () => {
    it('EN-075 cada lectura del médico deja una fila READ con la atención, y sin respuesta no deja ninguna', async () => {
      const encounterId = await openEncounter();

      const empty = await send('get', `/encounters/${encounterId}/screening`, doctorToken).expect(200); // prettier-ignore
      expect(empty.body).toEqual({ screening: null });
      expect(await screeningReads(encounterId)).toBe(0);

      await send('put', `/encounters/${encounterId}/screening`, doctorToken, POSITIVE).expect(200); // prettier-ignore
      await send('get', `/encounters/${encounterId}/screening`, doctorToken).expect(200); // prettier-ignore
      expect(await screeningReads(encounterId)).toBe(1);
      await send('get', `/encounters/${encounterId}/screening`, doctorToken).expect(200); // prettier-ignore
      expect(await screeningReads(encounterId)).toBe(2);

      // The row names who and the attention, and carries nothing else.
      const rows = await prisma.accessAudit.findMany({
        where: { resourceType: 'encounter_screening' },
      });
      expect(rows.map((row) => row.action).sort()).toEqual([
        'CREATE',
        'READ',
        'READ',
      ]);
      for (const row of rows) {
        expect(row.resourceId).toBe(encounterId);
        expect(row.before ?? null).toBeNull();
        expect(row.after ?? null).toBeNull();
      }
    });

    it('EN-075 repetir la misma respuesta devuelve quién y cuándo, así que deja su fila READ', async () => {
      const encounterId = await openEncounter();
      await send('put', `/encounters/${encounterId}/screening`, doctorToken, { result: 'NO_SIGNS' }).expect(200); // prettier-ignore
      expect(await screeningReads(encounterId)).toBe(0);

      const again = await send('put', `/encounters/${encounterId}/screening`, secondDoctorToken, { result: 'NO_SIGNS' }).expect(200); // prettier-ignore
      expect((again.body as { screenedById: string }).screenedById).toBe(doctorPractitionerId); // prettier-ignore
      expect(await screeningReads(encounterId)).toBe(1);
    });
  });

  describe('EN-073 no viaja en listados, errores ni logs', () => {
    it('EN-073 ninguna otra respuesta de la atención lo lleva: detalle, historia, abiertas, estados, resumen', async () => {
      const encounterId = await openEncounter();
      await send('put', `/encounters/${encounterId}/screening`, doctorToken, POSITIVE).expect(200); // prettier-ignore

      for (const path of [
        `/encounters/${encounterId}`,
        `/encounters?patientId=${patientId}`,
        '/encounters/open',
        `/encounters/${encounterId}/status-history`,
        `/encounters/${encounterId}/chart-summary`,
      ]) {
        const response = await send('get', path, doctorToken);
        expect(response.status, path).toBe(200);
        const body = JSON.stringify(response.body);
        expect(body, path).not.toMatch(/screening|violen/i);
        for (const telltale of TELLTALES) {
          expect(body, `${path} ${telltale}`).not.toContain(telltale);
        }
      }

      // Positive control: the telltales DO travel through the one route.
      const own = JSON.stringify(
        (await send('get', `/encounters/${encounterId}/screening`, doctorToken)).body, // prettier-ignore
      );
      for (const telltale of TELLTALES) expect(own).toContain(telltale);
    });

    it('EN-073 el 422 nombra el campo y no repite lo enviado', async () => {
      const encounterId = await openEncounter();

      const refused = await send('put', `/encounters/${encounterId}/screening`, doctorToken, {
        result: 'NO_SIGNS',
        types: ['PHYSICAL'],
        actionTaken: ACTION,
        notification: POSITIVE.notification,
      }).expect(422); // prettier-ignore
      const body = JSON.stringify(refused.body);
      for (const telltale of [ACTION, SERIAL]) {
        expect(body).not.toContain(telltale);
      }
      expect(
        (refused.body as Problem).errors?.map((error) => error.field).sort(),
      ).toEqual(['actionTaken', 'notification', 'types']);
    });

    it('EN-073 el log de registrar y leer lleva el hecho y nada del tamizaje', async () => {
      const encounterId = await openEncounter();
      const logger = app!.get(ViolenceScreeningService)['logger'] as {
        info: (...args: unknown[]) => void;
      };
      const info = vi.spyOn(logger, 'info');

      await send('put', `/encounters/${encounterId}/screening`, doctorToken, POSITIVE).expect(200); // prettier-ignore
      await send('get', `/encounters/${encounterId}/screening`, doctorToken).expect(200); // prettier-ignore

      expect(info).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(info.mock.calls);
      for (const telltale of [...TELLTALES, encounterId, patientId]) {
        expect(logged).not.toContain(telltale);
      }
      info.mockRestore();
    });
  });

  describe('EN-070 EN-076 la respuesta, quién y cuándo', () => {
    it('EN-070 distingue «no se aplicó» de «sin signos», y EN-076 guarda quién y cuándo y lo mueve al corregir', async () => {
      const encounterId = await openEncounter();
      const before = Date.now();

      const first = await send('put', `/encounters/${encounterId}/screening`, doctorToken, { result: 'NOT_APPLIED' }).expect(200); // prettier-ignore
      expect(first.body).toMatchObject({
        result: 'NOT_APPLIED',
        types: [],
        actionTaken: null,
        notification: null,
        screenedById: doctorPractitionerId,
      });
      const at = Date.parse((first.body as { screenedAt: string }).screenedAt);
      expect(at).toBeGreaterThanOrEqual(before - 1000);
      expect(at).toBeLessThanOrEqual(Date.now() + 1000);

      const corrected = await send('put', `/encounters/${encounterId}/screening`, secondDoctorToken, { result: 'NO_SIGNS' }).expect(200); // prettier-ignore
      expect(corrected.body).toMatchObject({
        result: 'NO_SIGNS',
        screenedById: secondDoctorPractitionerId,
      });
      const row = await prisma.violenceScreening.findUniqueOrThrow({
        where: { encounterId },
      });
      expect(row).toMatchObject({
        result: 'NO_SIGNS',
        screenedById: secondDoctorPractitionerId,
      });
    });

    it('EN-071 EN-074 EN-077 guarda el positivo con sus tipos, su acción y el bloque de notificación', async () => {
      const encounterId = await openEncounter();
      await send('put', `/encounters/${encounterId}/screening`, doctorToken, POSITIVE).expect(200); // prettier-ignore

      expect(
        await prisma.violenceScreening.findUniqueOrThrow({
          where: { encounterId },
        }),
      ).toMatchObject({
        result: 'CONFIRMED',
        types: ['PHYSICAL', 'SEXUAL'],
        actionTaken: ACTION,
        reportedToAuthority: true,
        authorityFormSerial: SERIAL,
        injury: 'DISABILITY',
        aggressorIdentified: 'YES',
        aggressorRelationship: 'RELATIVE',
      });

      // EN-071, EN-077: positive without types or action is refused per field.
      const refused = await send('put', `/encounters/${encounterId}/screening`, doctorToken, { result: 'SUSPECTED' }).expect(422); // prettier-ignore
      expect(
        (refused.body as Problem).errors?.map((error) => error.field).sort(),
      ).toEqual(['actionTaken', 'types']);
    });
  });

  describe('EN-078 ofrecer el grupo prioritario, nunca escribirlo', () => {
    it('EN-078 un positivo no toca los grupos prioritarios del paciente; el grupo entra sólo por su ruta y con su llave', async () => {
      const encounterId = await openEncounter();
      await send('put', `/encounters/${encounterId}/screening`, doctorToken, POSITIVE).expect(200); // prettier-ignore

      expect(
        await prisma.patientPriorityGroup.count({ where: { patientId } }),
      ).toBe(0);

      // Positive control: the same count sees the group once whoever holds
      // `patient:priority:protected` records it through `patients` (PA-034).
      const clinicToday = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Guayaquil',
      }).format(new Date());
      await send(
        'post',
        `/patients/${patientId}/priority-groups`,
        doctorToken,
        {
          group: 'DOMESTIC_OR_SEXUAL_VIOLENCE_VICTIM',
          startsOn: clinicToday,
          origin: 'SELF_DECLARED',
        },
      ).expect(201);
      expect(
        await prisma.patientPriorityGroup.count({ where: { patientId } }),
      ).toBe(1);
    });
  });

  describe('EN-240 la firma del alta exige el tamizaje respondido', () => {
    it('EN-240 rechaza firmar la 002 sin tamizaje, la firma tras «no se aplicó», y después ya no se puede cambiar', async () => {
      const encounterId = await openEncounter();
      const draft = await send('post', `/encounters/${encounterId}/notes`, doctorToken, { formCode: '002', content: COMPLETE_002 }).expect(201); // prettier-ignore
      const noteId = (draft.body as { id: string }).id;
      await createDiagnosis(prisma, encounterId, 'J00');

      const refused = await send('post', `/encounters/${encounterId}/notes/${noteId}/sign`, doctorToken, { dischargeCondition: 'ALIVE' }).expect(422); // prettier-ignore
      expect((refused.body as Problem).code).toBe('SCREENING_PENDING');

      // Positive control: answered, even «no se aplicó», it signs.
      await send('put', `/encounters/${encounterId}/screening`, doctorToken, { result: 'NOT_APPLIED' }).expect(200); // prettier-ignore
      await send('post', `/encounters/${encounterId}/notes/${noteId}/sign`, doctorToken, { dischargeCondition: 'ALIVE' }).expect(200); // prettier-ignore

      // EN-130, EN-242. After the discharge the answer is no longer changed.
      const closed = await send('put', `/encounters/${encounterId}/screening`, doctorToken, { result: 'NO_SIGNS' }).expect(409); // prettier-ignore
      expect((closed.body as Problem).code).toBe(
        'SCREENING_LOCKED_AFTER_DISCHARGE',
      );

      // And the DATABASE refuses it too, whoever writes. Before the
      // discharge the same row was written (the PUT above): the control.
      await expect(
        prisma.$executeRaw`UPDATE violence_screening SET result = 'NO_SIGNS' WHERE encounter_id = ${encounterId}::uuid`,
      ).rejects.toThrow(/violence_screening_after_discharge/);
    });
  });

  /**
   * EN-242 (D-188 §5). The 094 is often filled once the 002 is signed: with
   * the discharge given, the key holder completes the notification — and
   * only it.
   */
  describe('EN-242 la notificación a la autoridad tras el alta', () => {
    const { notification, ...UNNOTIFIED } = POSITIVE;

    async function discharged(answer: object): Promise<string> {
      const encounterId = await openEncounter();
      const draft = await send('post', `/encounters/${encounterId}/notes`, doctorToken, { formCode: '002', content: COMPLETE_002 }).expect(201); // prettier-ignore
      await createDiagnosis(prisma, encounterId, 'J00');
      await send('put', `/encounters/${encounterId}/screening`, doctorToken, answer).expect(200); // prettier-ignore
      await send('post', `/encounters/${encounterId}/notes/${(draft.body as { id: string }).id}/sign`, doctorToken, { dischargeCondition: 'ALIVE' }).expect(200); // prettier-ignore
      return encounterId;
    }

    it('EN-242 otro médico con la llave completa la notificación tras el alta: queda quién y cuándo, la anterior archivada, y quién aplicó el tamizaje no cambia', async () => {
      const encounterId = await discharged(UNNOTIFIED);
      const before = await prisma.violenceScreening.findUniqueOrThrow({ where: { encounterId } }); // prettier-ignore
      expect(before.notifiedById).toBeNull();

      const saved = await send('put', `/encounters/${encounterId}/screening`, secondDoctorToken, POSITIVE).expect(200); // prettier-ignore

      expect(saved.body).toMatchObject({
        result: 'CONFIRMED',
        notification,
        screenedById: doctorPractitionerId,
        screenedAt: before.screenedAt.toISOString(),
        notifiedById: secondDoctorPractitionerId,
      });
      const after = await prisma.violenceScreening.findUniqueOrThrow({ where: { encounterId } }); // prettier-ignore
      expect(after).toMatchObject({
        reportedToAuthority: true,
        authorityFormSerial: SERIAL,
        screenedById: doctorPractitionerId,
        screenedAt: before.screenedAt,
        notifiedById: secondDoctorPractitionerId,
      });
      expect(after.notifiedAt!.getTime()).toBeGreaterThanOrEqual(before.screenedAt.getTime()); // prettier-ignore
      const versions = await prisma.violenceScreeningVersion.findMany({ where: { encounterId } }); // prettier-ignore
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ replacedById: secondDoctorPractitionerId }); // prettier-ignore
      // EN-075. The write leaves its trail row.
      expect(
        await prisma.accessAudit.count({ where: { resourceType: 'encounter_screening', resourceId: encounterId, action: 'UPDATE' } }), // prettier-ignore
      ).toBe(1);

      // The same notification again changes nothing and archives nothing.
      await send('put', `/encounters/${encounterId}/screening`, secondDoctorToken, POSITIVE).expect(200); // prettier-ignore
      expect(await prisma.violenceScreeningVersion.count({ where: { encounterId } })).toBe(1); // prettier-ignore
    });

    it('EN-242 tras el alta rechaza con SCREENING_LOCKED_AFTER_DISCHARGE cambiar el resultado, los tipos o la acción, quitar la notificación, o notificar un «sin signos»; corregir la notificación sí', async () => {
      const encounterId = await discharged(POSITIVE);
      const put = (body: object) =>
        send('put', `/encounters/${encounterId}/screening`, doctorToken, body);

      for (const body of [
        { ...POSITIVE, result: 'SUSPECTED' },
        { ...POSITIVE, types: ['PHYSICAL'] },
        { ...POSITIVE, actionTaken: 'Otra acción' },
        UNNOTIFIED,
      ]) {
        const refused = await put(body).expect(409);
        expect((refused.body as Problem).code).toBe(
          'SCREENING_LOCKED_AFTER_DISCHARGE',
        );
        // EN-073. The refusal repeats nothing of the screening.
        for (const telltale of TELLTALES) {
          expect(JSON.stringify(refused.body)).not.toContain(telltale);
        }
      }
      expect(await prisma.violenceScreeningVersion.count({ where: { encounterId } })).toBe(0); // prettier-ignore

      // Positive control: the same answer with the notification corrected,
      // the types in another order.
      await put({
        ...POSITIVE,
        types: ['SEXUAL', 'PHYSICAL'],
        notification: { ...notification, formSerial: 'SERIE-0098766' },
      }).expect(200);
      expect(await prisma.violenceScreeningVersion.count({ where: { encounterId } })).toBe(1); // prettier-ignore

      const negative = await discharged({ result: 'NO_SIGNS' });
      const refused = await send('put', `/encounters/${negative}/screening`, doctorToken, { ...POSITIVE }).expect(409); // prettier-ignore
      expect((refused.body as Problem).code).toBe(
        'SCREENING_LOCKED_AFTER_DISCHARGE',
      );
    });

    it('EN-242 EN-072 tras el alta enfermería sigue sin poder escribirlo (403), y una atención de otra sede es 404', async () => {
      const encounterId = await discharged(UNNOTIFIED);

      await send('put', `/encounters/${encounterId}/screening`, nurseToken, POSITIVE).expect(403); // prettier-ignore
      await send('put', `/encounters/${encounterId}/screening`, elsewhereDoctorToken, POSITIVE).expect(404); // prettier-ignore
      const untouched = await prisma.violenceScreening.findUniqueOrThrow({ where: { encounterId } }); // prettier-ignore
      expect(untouched.reportedToAuthority).toBe(false);
    });
  });
});
