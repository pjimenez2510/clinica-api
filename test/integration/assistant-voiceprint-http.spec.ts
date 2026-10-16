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
import { VOICEPRINT_ENROLLER } from '../../src/modules/assistant/application/voiceprint.port';
import { ASSISTANT_ENABLED } from '../../src/modules/assistant/assistant-diagnosis.controller';
import { ClinicaAiVoiceprintEnroller } from '../../src/modules/assistant/infrastructure/clinica-ai.voiceprint-enroller';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * AS-310 to AS-313, AS-319 by HTTP, against PostgreSQL, with real sessions
 * and the seed's roles. `clinica-ai` is the real adapter over a `fetch` that
 * answers as the service does; the voice model itself is `clinica-ai`'s
 * (CAI-016, CAI-020).
 */
const PASSWORD = 'el caballo come alfalfa';
/** Stands for the reading: a marker that must not appear anywhere else. */
const MARKER = 'LECTURA-DE-PRUEBA-7f3a';
const RECORDING = Buffer.from(`RIFF\u0000\u0000\u0000\u0000WAVEfmt ${MARKER}`);
const VECTOR = Array.from({ length: 192 }, (_, i) => ((i % 5) - 2) / 10);
const MODEL = 'speechbrain/spkrec-ecapa-voxceleb';

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

describe('«Mi voz» por HTTP (AS-310 a AS-313, AS-319)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  const clinicaAi = vi.fn<typeof fetch>();

  let siteId: string;
  let doctor: { token: string; userId: string };
  let nurse: string;
  let reception: string;

  function answers(url: string) {
    if (url.endsWith('/v1/status')) {
      return Response.json({
        speakerAttribution: { available: true, model: MODEL, reason: null },
      });
    }
    return Response.json({
      model: MODEL,
      dimension: 192,
      phrases: 12,
      seconds: 41.5,
      vector: VECTOR,
    });
  }

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();
    clinicaAi.mockReset();
    clinicaAi.mockImplementation((input) =>
      Promise.resolve(answers(urlOf(input))),
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
        .overrideProvider(VOICEPRINT_ENROLLER)
        .useValue(
          new ClinicaAiVoiceprintEnroller({
            baseUrl: 'http://127.0.0.1:8100',
            secret: 's'.repeat(64),
            timeoutMs: 1000,
            statusTimeoutMs: 1000,
            fetcher: clinicaAi,
          }),
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
    doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    nurse = (await signIn('ENFERMERIA', 'enfermeria@clinica.ec', '1104637283')).token; // prettier-ignore
    reception = (await signIn('RECEPCION', 'recepcion@clinica.ec', '1713175071')).token; // prettier-ignore
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
    const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } }); // prettier-ignore
    await prisma.userRoleGrant.create({ data: { userId: user.id, roleId: role.id, siteId } }); // prettier-ignore
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      token: (response.body as { accessToken: string }).accessToken,
      userId: user.id,
    };
  }

  const URL = '/api/v1/me/voiceprint';
  const register = (token: string, consent = 'true') =>
    request(app.getHttpServer())
      .put(`${URL}?consent=${consent}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'audio/webm')
      .send(RECORDING);
  const view = (token: string) =>
    request(app.getHttpServer()).get(URL).set('Authorization', `Bearer ${token}`); // prettier-ignore
  const attribution = (token: string, on: boolean) =>
    request(app.getHttpServer())
      .put(`${URL}/attribution`)
      .set('Authorization', `Bearer ${token}`)
      .send({ on });
  const remove = (token: string) =>
    request(app.getHttpServer()).delete(URL).set('Authorization', `Bearer ${token}`); // prettier-ignore

  it('AS-310 AS-319 keeps only the vector of the caller, the recording reaches clinica-ai as it came, and no answer carries the vector', async () => {
    const written: string[] = [];
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    let response: request.Response;
    try {
      response = await register(doctor.token).expect(200);
    } finally {
      stdout.mockRestore();
    }

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      registered: { phrases: 12, seconds: 41.5 },
      attribution: false,
      available: true,
      reason: null,
    });
    expect(JSON.stringify(response.body)).not.toContain('vector');
    const [, init] = clinicaAi.mock.calls.find(([u]) => urlOf(u).endsWith('/voiceprint'))!; // prettier-ignore
    expect(Buffer.from(init?.body as Uint8Array).equals(RECORDING)).toBe(true);

    const row = await prisma.professionalVoiceprint.findUniqueOrThrow({
      where: { userId: doctor.userId },
    });
    expect(row.vector).toHaveLength(192);
    expect(written.join('')).not.toContain(MARKER);
    const trail = await prisma.accessAudit.findMany({
      where: { resourceType: 'professional_voiceprint' },
    });
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ action: 'CREATE', resourceId: doctor.userId, userId: doctor.userId }); // prettier-ignore
    expect(JSON.stringify(trail)).not.toContain(MARKER);
    expect(JSON.stringify((await view(doctor.token).expect(200)).body)).not.toContain('vector'); // prettier-ignore
  });

  it('AS-310 without consent answers 422 ASSISTANT_VOICEPRINT_CONSENT_REQUIRED and sends nothing', async () => {
    const refused = await register(doctor.token, 'false').expect(422);

    expect((refused.body as { code: string }).code).toBe(
      'ASSISTANT_VOICEPRINT_CONSENT_REQUIRED',
    );
    expect(clinicaAi).not.toHaveBeenCalled();
    expect(await prisma.professionalVoiceprint.count()).toBe(0);
    // Control: with consent, the same reading is kept.
    await register(doctor.token).expect(200);
    expect(await prisma.professionalVoiceprint.count()).toBe(1);
  });

  it('AS-310 asks for assistant:voiceprint: the doctor and nursing have it, reception does not', async () => {
    await request(app.getHttpServer()).get(URL).expect(401);
    await view(reception).expect(403);
    await register(reception).expect(403);
    expect(clinicaAi).not.toHaveBeenCalled();

    await view(doctor.token).expect(200);
    await view(nurse).expect(200);
  });

  it('AS-311 too little voice answers 422 ASSISTANT_VOICE_NOT_HEARD and leaves the voiceprint there was', async () => {
    await register(doctor.token).expect(200);
    clinicaAi.mockImplementation((input) =>
      Promise.resolve(
        urlOf(input).endsWith('/voiceprint')
          ? Response.json(
              { detail: 'No se oyó voz suficiente…' },
              { status: 422 },
            )
          : answers(urlOf(input)),
      ),
    );

    const refused = await register(doctor.token).expect(422);

    expect(refused.body).toMatchObject({
      code: 'ASSISTANT_VOICE_NOT_HEARD',
      title:
        'No se oyó voz suficiente. Lee el texto completo, a la distancia de una consulta.',
    });
    expect(
      (await prisma.professionalVoiceprint.findUniqueOrThrow({ where: { userId: doctor.userId } })).phrases, // prettier-ignore
    ).toBe(12);
  });

  it('AS-311 without the voice model answers 503 ASSISTANT_VOICE_UNAVAILABLE with the reason, keeping nothing', async () => {
    clinicaAi.mockImplementation(() =>
      Promise.resolve(
        Response.json(
          { detail: 'El registro de voz no está disponible: falta el modelo.' },
          { status: 503 },
        ),
      ),
    );

    const refused = await register(doctor.token).expect(503);

    expect((refused.body as { code: string; title: string }).code).toBe(
      'ASSISTANT_VOICE_UNAVAILABLE',
    );
    expect((refused.body as { title: string }).title).toContain(
      'falta el modelo',
    );
    expect(await prisma.professionalVoiceprint.count()).toBe(0);
  });

  it('AS-312 AS-313 the switch needs a voiceprint, a new reading keeps it, and deleting leaves no row and its trail', async () => {
    const missing = await attribution(doctor.token, true).expect(409);
    expect((missing.body as { code: string }).code).toBe(
      'ASSISTANT_VOICEPRINT_MISSING',
    );

    await register(doctor.token).expect(200);
    expect((await attribution(doctor.token, true).expect(200)).body).toMatchObject({ attribution: true }); // prettier-ignore
    expect((await register(doctor.token).expect(200)).body).toMatchObject({ attribution: true }); // prettier-ignore

    await remove(doctor.token).expect(204);

    expect(await prisma.professionalVoiceprint.count()).toBe(0);
    expect((await view(doctor.token).expect(200)).body).toMatchObject({
      registered: null,
      attribution: false,
    });
    const actions = (
      await prisma.accessAudit.findMany({
        where: { resourceType: 'professional_voiceprint' },
        orderBy: { occurredAt: 'asc' },
      })
    ).map((entry) => entry.action);
    expect(actions).toEqual(['CREATE', 'UPDATE', 'UPDATE', 'DELETE']);
  });

  it("AS-310 one person cannot reach another's voiceprint: each sees and deletes only their own", async () => {
    await register(doctor.token).expect(200);

    await remove(nurse).expect(204);
    expect((await view(nurse).expect(200)).body).toMatchObject({ registered: null }); // prettier-ignore
    expect(await prisma.professionalVoiceprint.count()).toBe(1);
  });
});
