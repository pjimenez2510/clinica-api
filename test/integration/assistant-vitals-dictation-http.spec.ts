import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { DICTATION_TRANSCRIBER } from '../../src/modules/assistant/application/dictation-transcriber.port';
import { ASSISTANT_ENABLED } from '../../src/modules/assistant/assistant-diagnosis.controller';
import { dictationTranscriberFor } from '../../src/modules/assistant/infrastructure/clinica-ai.dictation-transcriber';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createEncounter, createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * AS-180, AS-184 to AS-187, AS-196 by HTTP, against PostgreSQL, with real
 * sessions and the seed's roles: the vital signs said aloud, read into a
 * proposal that writes nothing. `clinica-ai` is the real adapter over a
 * `fetch` that answers as the service does; the recogniser itself is
 * measured by the harness (AS-188), not here.
 */
const PASSWORD = 'el caballo come alfalfa';
const SAID =
  'Presión 120 sobre 80, pulso 72, temperatura 36 y medio, saturación 98, peso 70 kilos, talla 1,65, frecuencia respiratoria trescientos';
/** Stands for a WAV: the adapter forwards the bytes as they came. */
const RECORDING = Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt invented');

describe('los signos dictados por HTTP (AS-180, AS-184 a AS-187, AS-196)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  const clinicaAi = vi.fn<typeof fetch>();

  let siteId: string;
  let otherSiteId: string;
  let nurse: string;
  let doctor: { token: string; practitionerId: string };
  let colleague: string;
  let reception: string;
  let encounterId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();
    clinicaAi.mockReset();
    clinicaAi.mockImplementation(() =>
      Promise.resolve(Response.json({ text: SAID, seconds: 9.4 })),
    );

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .overrideProvider(ThrottlerStorage)
        .useValue({
          increment: () =>
            Promise.resolve({ totalHits: 1, timeToExpire: 1, isBlocked: false, timeToBlockExpire: 0 }), // prettier-ignore
        })
        .overrideProvider(ASSISTANT_ENABLED)
        .useValue(true)
        .overrideProvider(DICTATION_TRANSCRIBER)
        .useValue(
          dictationTranscriberFor(
            {
              url: 'http://127.0.0.1:8100',
              secret: 's'.repeat(64),
              timeoutMs: 1000,
            },
            clinicaAi,
          ),
        )
        .compile();
      app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false }); // prettier-ignore
      configureApp(app);
      await listenForTests(app);
      registry = app.get(RolePermissionRegistry);
    }

    await syncAuthorisation(prisma);
    registry.invalidate();
    siteId = (await createSite(prisma)).id;
    otherSiteId = (await createSite(prisma)).id;
    nurse = (await signIn('ENFERMERIA', 'enfermeria@clinica.ec', '1104637283')).token; // prettier-ignore
    doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    colleague = (await signIn('MEDICO', 'medico2@clinica.ec', '0602910945')).token; // prettier-ignore
    reception = (await signIn('RECEPCION', 'recepcion@clinica.ec', '1713175071')).token; // prettier-ignore
    const patientId = (await createPatient(prisma)).id;
    encounterId =
      (await createEncounter(prisma, { siteId, practitionerId: doctor.practitionerId, patientId })) // prettier-ignore
      .id;
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(roleCode: string, email: string, cedula: string) {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Luis',
        lastName: 'Mora',
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    const practitioner = await prisma.practitioner.create({ data: { userId: user.id } }); // prettier-ignore
    const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } }); // prettier-ignore
    await prisma.userRoleGrant.create({ data: { userId: user.id, roleId: role.id, siteId } }); // prettier-ignore
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      token: (response.body as { accessToken: string }).accessToken,
      practitionerId: practitioner.id,
    };
  }

  const url = (id: string) => `/api/v1/encounters/${id}/assistant/vitals-dictation`; // prettier-ignore
  const dictate = (id: string, token: string, recording: Buffer = RECORDING) =>
    request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'audio/wav')
      .send(recording);
  const limits = (id: string, token: string) =>
    request(app.getHttpServer()).get(url(id)).set('Authorization', `Bearer ${token}`); // prettier-ignore

  interface Problem {
    code: string;
    title: string;
  }

  it('AS-180 AS-184 nursing gets the readings as a proposal, the recording reaches clinica-ai as it came, and no taking is written', async () => {
    const response = await dictate(encounterId, nurse).expect(200);

    expect(response.body).toEqual({
      heard: SAID,
      signs: {
        systolicBp: 120,
        diastolicBp: 80,
        heartRate: 72,
        temperatureC: 36.5,
        oxygenSaturation: 98,
        weightKg: 70,
        heightCm: 165,
      },
      unclear: ['respiratoryRate'],
    });
    expect(response.headers['cache-control']).toBe('no-store');
    const [, init] = clinicaAi.mock.calls[0]!;
    expect(Buffer.from(init?.body as Uint8Array).equals(RECORDING)).toBe(true);
    expect(await prisma.encounterVitals.findUnique({ where: { encounterId } })).toBeNull(); // prettier-ignore

    // Control: the same nurse's «Guardar», by the taking's route, does write.
    await request(app.getHttpServer())
      .put(`/api/v1/encounters/${encounterId}/vitals`)
      .set('Authorization', `Bearer ${nurse}`)
      .send({ heartRate: 72 })
      .expect(200);
    expect(await prisma.encounterVitals.findUnique({ where: { encounterId } })).not.toBeNull(); // prettier-ignore
  });

  it('AS-185 AS-187 asks for assistant:dictate-vitals: nursing and any doctor of the site have it, reception does not', async () => {
    await request(app.getHttpServer()).post(url(encounterId)).expect(401);
    await dictate(encounterId, reception).expect(403);
    await limits(encounterId, reception).expect(403);
    expect(clinicaAi).not.toHaveBeenCalled();

    // Control: the attention's doctor, and a colleague who does not attend it.
    await dictate(encounterId, doctor.token).expect(200);
    await dictate(encounterId, colleague).expect(200);
  });

  it('AS-185 an attention of another site is not found, and nothing reaches clinica-ai', async () => {
    const elsewhere = await createEncounter(prisma, {
      siteId: otherSiteId,
      practitionerId: doctor.practitionerId,
      patientId: (await createPatient(prisma)).id,
    });

    const refused = await dictate(elsewhere.id, nurse).expect(404);
    expect((refused.body as Problem).code).toBe(
      'ASSISTANT_ENCOUNTER_NOT_FOUND',
    );
    await limits(elsewhere.id, nurse).expect(404);
    expect(clinicaAi).not.toHaveBeenCalled();

    // Control: in its own site the same request reads.
    await dictate(encounterId, nurse).expect(200);
  });

  it('AS-185 a discharged attention takes no dictation', async () => {
    // Control first: open, it reads.
    await dictate(encounterId, nurse).expect(200);
    await prisma.$executeRaw`UPDATE encounter SET status = 'DISCHARGED', ended_at = ${new Date()}, "dischargeCondition" = 'ALIVE' WHERE id = ${encounterId}::uuid`; // prettier-ignore

    const closed = await dictate(encounterId, nurse).expect(409);
    expect((closed.body as Problem).code).toBe('ASSISTANT_ENCOUNTER_CLOSED');
    await limits(encounterId, nurse).expect(409);
  });

  it('AS-186 a recording over 8 MB is the parser’s 413, and clinica-ai never sees it', async () => {
    const tooLong = await dictate(encounterId, nurse, Buffer.alloc(8 * 1024 * 1024 + 1)).expect(413); // prettier-ignore
    expect((tooLong.body as Problem).code).toBe('PAYLOAD_TOO_LARGE');
    expect(clinicaAi).not.toHaveBeenCalled();

    // Control: exactly at the cap it goes through.
    await dictate(encounterId, nurse, Buffer.alloc(8 * 1024 * 1024)).expect(
      200,
    );
  });

  it('AS-186 an empty recording, or one with no voice in it, is not heard and says what to do', async () => {
    const empty = await dictate(encounterId, nurse, Buffer.alloc(0)).expect(
      422,
    );
    expect((empty.body as Problem).code).toBe('ASSISTANT_DICTATION_NOT_HEARD');
    expect(clinicaAi).not.toHaveBeenCalled();

    clinicaAi.mockImplementation(() =>
      Promise.resolve(Response.json({ text: ' ', seconds: 6.2 })),
    );
    const silent = await dictate(encounterId, nurse).expect(422);
    expect((silent.body as Problem).code).toBe('ASSISTANT_DICTATION_NOT_HEARD');
    expect((silent.body as Problem).title).toContain('6,2 s');
  });

  it('AS-186 clinica-ai without its recogniser, or down, is a 503 that says to type the readings', async () => {
    clinicaAi.mockImplementation(() =>
      Promise.resolve(Response.json({ detail: 'no' }, { status: 503 })),
    );
    const missing = await dictate(encounterId, nurse).expect(503);
    expect((missing.body as Problem).code).toBe(
      'ASSISTANT_DICTATION_UNAVAILABLE',
    );
    expect((missing.body as Problem).title).toContain('escriba los signos');

    clinicaAi.mockImplementation(() => Promise.reject(new TypeError(SAID)));
    const down = await dictate(encounterId, nurse).expect(503);
    expect(JSON.stringify(down.body)).not.toContain('120');
  });

  it('AS-196 tells the screen how long a dictation may last', async () => {
    const response = await limits(encounterId, nurse).expect(200);

    expect(response.body).toEqual({ maxSeconds: 120 });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(clinicaAi).not.toHaveBeenCalled();
  });

  it('AS-185 dictating needs both permissions AT THE SAME site: one here and the other elsewhere is not found', async () => {
    const role = async (code: string, permissionCode: string) =>
      prisma.role.create({
        data: {
          code,
          name: code,
          permissions: { create: [{ permissionCode }] },
        },
      });
    const dictates = await role('SOLO_DICTA', 'assistant:dictate-vitals');
    const takes = await role('SOLO_TOMA', 'vitals:write');
    const user = await prisma.user.create({
      data: {
        email: 'cruce@clinica.ec',
        firstName: 'Ana',
        lastName: 'Cruz',
        cedula: '1710034057',
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    await prisma.userRoleGrant.create({ data: { userId: user.id, roleId: dictates.id, siteId } }); // prettier-ignore
    await prisma.userRoleGrant.create({ data: { userId: user.id, roleId: takes.id, siteId: otherSiteId } }); // prettier-ignore
    registry.invalidate();
    const login = async () =>
      (
        (await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'cruce@clinica.ec', password: PASSWORD }).expect(200)) // prettier-ignore
        .body as { accessToken: string }
      ).accessToken;

    const refused = await dictate(encounterId, await login()).expect(404);
    expect((refused.body as Problem).code).toBe(
      'ASSISTANT_ENCOUNTER_NOT_FOUND',
    );
    expect(clinicaAi).not.toHaveBeenCalled();

    // Control: the taking's permission at this site too, and the same request reads.
    await prisma.userRoleGrant.create({ data: { userId: user.id, roleId: takes.id, siteId } }); // prettier-ignore
    registry.invalidate();
    await dictate(encounterId, await login()).expect(200);
  });
});
