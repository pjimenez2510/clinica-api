import { randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import {
  AI_RUN_STORE,
  type AiRunStore,
} from '../../src/modules/assistant/application/ai-run.store';
import { ASSISTANT_DEMO } from '../../src/modules/assistant/application/diagnosis-proposal.service';
import { LLM_CLIENT } from '../../src/modules/assistant/application/llm-client.port';
import {
  MissingPseudonymizer,
  PSEUDONYMIZER,
  type Pseudonymizer,
} from '../../src/modules/assistant/application/pseudonymizer.port';
import { ASSISTANT_ENABLED } from '../../src/modules/assistant/assistant-diagnosis.controller';
import { buildLlmClient } from '../../src/modules/assistant/assistant.module';
import { DemoPseudonymizer } from '../../src/modules/assistant/infrastructure/demo/demo.pseudonymizer';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import type { Env } from '../../src/shared/config/env.schema';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createEncounter, createPatient, createSite } from './setup/fixtures';
import { expectPublicTariffCacheable } from './setup/no-store';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * AS-025 to AS-040 by HTTP, with real sessions and the seed's roles: the
 * permission, the site scope, the owner of the attention, the barrier of the
 * catalogue and what `ai_suggestion` and `ai_run` keep. The chain is the
 * demonstration script (AS-029), the only one that runs with no network.
 */
const PASSWORD = 'el caballo come alfalfa';
const NOTE = {
  motivoConsulta: 'Dolor de garganta',
  enfermedadActual:
    'Ana refiere odinofagia de tres días y fiebre de 38,5 °C. Tensión 150/95 en dos tomas.',
};

/** The demonstration mode's configuration, as `validateEnv` would give it. */
const demoConfig = {
  get: (key: keyof Env) =>
    ({
      ASSISTANT_FAKE_PROVIDER: true,
      ASSISTANT_ALLOW_REMOTE: false,
      ASSISTANT_PROVIDER_TIMEOUT_MS: 60_000,
      ASSISTANT_EXCHANGE_LOG: false,
    })[key as string],
} as unknown as ConfigService<Env, true>;

/** Lets a test take the pseudonymizer away, as production has it until A5. */
const pseudonymizer: Pseudonymizer & { current: Pseudonymizer } = {
  current: new DemoPseudonymizer(),
  pseudonymize: (input, signal) => pseudonymizer.current.pseudonymize(input, signal), // prettier-ignore
};

describe('el CIE-10 propuesto por HTTP (AS-025 a AS-040)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let doctor: { token: string; userId: string; practitionerId: string };
  let secondDoctor: { token: string; practitionerId: string };
  let nurseToken: string;
  let patientId: string;
  let encounterId: string;
  const concepts: Record<string, string> = {};

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();
    pseudonymizer.current = new DemoPseudonymizer();

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
        .overrideProvider(ASSISTANT_DEMO)
        .useValue(true)
        .overrideProvider(PSEUDONYMIZER)
        .useValue(pseudonymizer)
        .overrideProvider(LLM_CLIENT)
        .useFactory({
          factory: (store: AiRunStore) => buildLlmClient(demoConfig, store),
          inject: [AI_RUN_STORE],
        })
        .compile();
      app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false }); // prettier-ignore
      configureApp(app);
      await listenForTests(app);
      registry = app.get(RolePermissionRegistry);
    }

    await syncAuthorisation(prisma);
    registry.invalidate();
    const site = await createSite(prisma);
    siteId = site.id;
    const patient = await createPatient(prisma);
    patientId = patient.id;
    for (const [code, display] of [
      ['J02.9', 'Faringitis aguda, no especificada'],
      [
        'J02.8',
        'Faringitis aguda debida a otros microorganismos especificados',
      ],
      ['J03.9', 'Amigdalitis aguda, no especificada'],
      ['I10.X', 'Hipertensión esencial (primaria)'],
      ['R03.0', 'Lectura elevada de la presión sanguínea'],
    ]) {
      concepts[code!] = (await whoCode(code!, display!)).id;
    }
    doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    secondDoctor = await signIn('MEDICO', 'medico2@clinica.ec', '0602910945');
    nurseToken = (await signIn('ENFERMERIA', 'enfermeria@clinica.ec', '1104637283')).token; // prettier-ignore
    encounterId = (await attentionWithNote(doctor.practitionerId)).id;
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function whoCode(code: string, display: string) {
    const system = await prisma.catalogSystem.upsert({
      where: { code: 'CIE10' },
      create: { code: 'CIE10', name: 'CIE-10', hierarchical: true },
      update: {},
    });
    return prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code,
        display,
        attributes: { level: 3, use: 'PRINCIPAL' },
        validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
      },
    });
  }

  async function attentionWithNote(
    practitionerId: string,
    content: Record<string, string> = NOTE,
    atSite = siteId,
  ) {
    const encounter = await createEncounter(prisma, { siteId: atSite, practitionerId, patientId }); // prettier-ignore
    const id = randomUUID();
    await prisma.clinicalNote.create({
      data: {
        id,
        chainId: id,
        encounterId: encounter.id,
        formCode: '002',
        formVersion: '1',
        content,
        authorId: practitionerId,
      },
    });
    return encounter;
  }

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
      userId: user.id,
      practitionerId: practitioner.id,
    };
  }

  const url = (id: string, path = '') => `/api/v1/encounters/${id}/assistant/diagnoses${path}`; // prettier-ignore
  const get = (id: string, token: string) =>
    request(app.getHttpServer()).get(url(id)).set('Authorization', `Bearer ${token}`); // prettier-ignore
  const post = (id: string, path: string, token: string, body: object = {}) =>
    request(app.getHttpServer()).post(url(id, path)).set('Authorization', `Bearer ${token}`).send(body); // prettier-ignore

  interface Problem {
    id: string;
    problem: string;
    quote: string;
    status: string;
    diagnosisId: string | null;
    demo: boolean;
    candidates: { code: string; display: string }[];
  }

  it('AS-026 asks for assistant:use, which the doctor carries and the nurse does not', async () => {
    // On: the route exists and asks for a session (control of the 404 off).
    await request(app.getHttpServer()).get(url(encounterId)).expect(401);
    await get(encounterId, nurseToken).expect(403);
    // Control: the doctor of the seed gets in by the same route.
    await get(encounterId, doctor.token).expect(200);
  });

  it('AU-061 AS-027 the reading and what it shows again are the consultation: no cache keeps them', async () => {
    const read = await post(encounterId, '/read', doctor.token).expect(200);
    const shown = await get(encounterId, doctor.token).expect(200);

    // Both carry sentences of the note.
    expect(
      (shown.body as { problems: unknown[] }).problems.length,
    ).toBeGreaterThan(0);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(shown.headers['cache-control']).toBe('no-store');
    await expectPublicTariffCacheable(app.getHttpServer());
  });

  it('AS-027 opens with the patient history and the clinic frequency, and leaves its read in the trail', async () => {
    const earlier = await createEncounter(prisma, { siteId, practitionerId: doctor.practitionerId, patientId }); // prettier-ignore
    await prisma.encounterDiagnosis.create({
      data: { encounterId: earlier.id, conceptId: concepts['I10.X']!, cie10Code: 'I10.X', cie10Display: 'Hipertensión esencial (primaria)', certainty: 'DEFINITIVE', occurrence: 'FIRST_TIME' }, // prettier-ignore
    });

    const response = await get(encounterId, doctor.token).expect(200);

    const body = response.body as { baseline: { code: string; source: string; times: number }[]; problems: unknown[]; demo: boolean }; // prettier-ignore
    expect(body.baseline).toEqual([
      expect.objectContaining({ code: 'I10.X', source: 'history', times: 1 }),
    ]);
    expect(body.problems).toEqual([]);
    expect(body.demo).toBe(true);
    expect(await prisma.aiRun.count()).toBe(0);
    expect(
      await prisma.accessAudit.count({ where: { resourceType: 'assistant_diagnosis', resourceId: encounterId } }), // prettier-ignore
    ).toBe(1);
  });

  it('AS-028 AS-029 AS-035 AS-036 reads the problems with their phrase, shows only codes that exist and keeps them with their attempt', async () => {
    const response = await post(encounterId, '/read', doctor.token).expect(200);

    const problems = (response.body as { problems: Problem[] }).problems;
    expect(problems.map(({ problem, quote }) => [problem, quote])).toEqual([
      // The note's own sentence (D-245 §5), as written.
      ['FARINGITIS AGUDA', 'Ana refiere odinofagia de tres días y fiebre de 38,5 °C.'], // prettier-ignore
      ['HIPERTENSIÓN ARTERIAL SIN DIAGNÓSTICO PREVIO', 'Tensión 150/95 en dos tomas.'], // prettier-ignore
    ]);
    // J02.7, which the script writes on purpose, does not exist: not shown.
    expect(problems[0]!.candidates.map(({ code }) => code)).toEqual(['J02.9', 'J02.8', 'J03.9']); // prettier-ignore
    expect(problems[0]!.candidates[0]!.display).toBe('Faringitis aguda, no especificada'); // prettier-ignore
    expect(problems[1]!.candidates.map(({ code }) => code)).toEqual(['I10.X', 'R03.0']); // prettier-ignore
    expect(problems.every((problem) => problem.demo && problem.status === 'PROPOSED')).toBe(true); // prettier-ignore

    const kept = await prisma.aiSuggestion.findMany({ where: { encounterId }, include: { aiRun: true } }); // prettier-ignore
    expect(kept).toHaveLength(2);
    expect(kept.every((row) => row.kind === 'diagnosis' && row.aiRun.provider === 'fake' && row.aiRun.purpose === 'cie10-problems')).toBe(true); // prettier-ignore
    // One attempt names the problems, one per problem writes its codes.
    expect(await prisma.aiRun.count({ where: { encounterId } })).toBe(3);
  });

  it("AS-039 only the attention's professional asks, and an attention of another site does not exist", async () => {
    const before = await prisma.aiRun.count();
    const refused = await post(encounterId, '/read', secondDoctor.token).expect(
      403,
    );
    expect((refused.body as { code: string }).code).toBe(
      'ASSISTANT_NOT_ENCOUNTER_OWNER',
    );
    const elsewhere = await attentionWithNote(doctor.practitionerId, NOTE, (await createSite(prisma, 'Sede Sur')).id); // prettier-ignore
    const hidden = await post(elsewhere.id, '/read', doctor.token).expect(404);
    expect((hidden.body as { code: string }).code).toBe(
      'ASSISTANT_ENCOUNTER_NOT_FOUND',
    );
    expect(await prisma.aiRun.count()).toBe(before);
  });

  it('AS-037 accepting links the proposal to the diagnosis recorded from it, once', async () => {
    const read = await post(encounterId, '/read', doctor.token).expect(200);
    const [pharyngitis, hypertension] = (read.body as { problems: Problem[] })
      .problems;
    const recorded = await request(app.getHttpServer())
      .post(`/api/v1/encounters/${encounterId}/diagnoses`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({
        conceptId: concepts['J02.9'],
        certainty: 'PRESUMPTIVE',
        occurrence: 'FIRST_TIME',
      }) // prettier-ignore
      .expect(201);
    const diagnosisId = (recorded.body as { id: string }).id;

    const other = await attentionWithNote(doctor.practitionerId);
    const foreign = await prisma.encounterDiagnosis.create({
      data: { encounterId: other.id, conceptId: concepts['J02.9']!, cie10Code: 'J02.9', cie10Display: 'Faringitis aguda, no especificada', certainty: 'DEFINITIVE', occurrence: 'FIRST_TIME' }, // prettier-ignore
    });
    const mismatch = await post(encounterId, `/${pharyngitis!.id}/accept`, doctor.token, { diagnosisId: foreign.id }).expect(422); // prettier-ignore
    expect((mismatch.body as { code: string }).code).toBe(
      'SUGGESTION_DIAGNOSIS_MISMATCH',
    );

    const accepted = await post(encounterId, `/${pharyngitis!.id}/accept`, doctor.token, { diagnosisId }).expect(200); // prettier-ignore

    const shown = (accepted.body as { problems: Problem[] }).problems;
    expect(shown.find((each) => each.id === pharyngitis!.id)).toMatchObject({ status: 'ACCEPTED', diagnosisId }); // prettier-ignore
    const row = await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: pharyngitis!.id } }); // prettier-ignore
    expect(row).toMatchObject({ status: 'ACCEPTED', encounterDiagnosisId: diagnosisId, decidedBy: doctor.userId }); // prettier-ignore
    expect(Number(row.distance)).toBe(0);
    // A decision is final (AS-023).
    await post(encounterId, `/${pharyngitis!.id}/accept`, doctor.token, { diagnosisId }).expect(409); // prettier-ignore
    // The other proposal is untouched.
    expect(shown.find((each) => each.id === hypertension!.id)?.status).toBe('PROPOSED'); // prettier-ignore
  });

  it('AS-038 discarding takes the proposal off the screen and keeps it as discarded', async () => {
    const read = await post(encounterId, '/read', doctor.token).expect(200);
    const [first] = (read.body as { problems: Problem[] }).problems;

    const after = await post(encounterId, `/${first!.id}/discard`, doctor.token).expect(200); // prettier-ignore

    expect((after.body as { problems: Problem[] }).problems.map(({ id }) => id)).not.toContain(first!.id); // prettier-ignore
    const row = await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: first!.id } }); // prettier-ignore
    expect(row.status).toBe('DISCARDED');
  });

  it('AS-025 AS-040 without a pseudonymizer the reading fails closed, and what was there stays', async () => {
    await post(encounterId, '/read', doctor.token).expect(200);
    const runs = await prisma.aiRun.count();
    pseudonymizer.current = new MissingPseudonymizer();

    const failed = await post(encounterId, '/read', doctor.token).expect(502);

    expect((failed.body as { code: string }).code).toBe(
      'ASSISTANT_NOT_CONFIGURED',
    );
    expect(await prisma.aiRun.count()).toBe(runs);
    const overview = await get(encounterId, doctor.token).expect(200);
    expect((overview.body as { problems: Problem[] }).problems).toHaveLength(2);
  });

  it('AS-028 a note with nothing written is refused before anyone is called', async () => {
    const empty = await attentionWithNote(doctor.practitionerId, { motivoConsulta: '  ' }); // prettier-ignore

    const refused = await post(empty.id, '/read', doctor.token).expect(422);

    expect((refused.body as { code: string }).code).toBe(
      'ASSISTANT_NOTE_EMPTY',
    );
    expect(await prisma.aiRun.count()).toBe(0);
  });

  it('EN-122 AS-028 reading the note leaves who sent it in the trail, before anything else', async () => {
    await post(encounterId, '/read', doctor.token).expect(200);

    const rows = await prisma.accessAudit.findMany({
      where: { resourceType: 'assistant_diagnosis_reading', resourceId: encounterId }, // prettier-ignore
    });
    expect(rows).toMatchObject([{ action: 'EXPORT', userId: doctor.userId }]);
  });

  it('AS-039 another doctor neither accepts nor discards, and a closed attention takes no reading', async () => {
    const read = await post(encounterId, '/read', doctor.token).expect(200);
    const [first] = (read.body as { problems: Problem[] }).problems;

    const accept = await post(encounterId, `/${first!.id}/accept`, secondDoctor.token, { diagnosisId: first!.id }).expect(403); // prettier-ignore
    expect((accept.body as { code: string }).code).toBe('ASSISTANT_NOT_ENCOUNTER_OWNER'); // prettier-ignore
    await post(encounterId, `/${first!.id}/discard`, secondDoctor.token).expect(403); // prettier-ignore

    await prisma.$executeRaw`UPDATE encounter SET status = 'DISCHARGED', ended_at = ${new Date()}, "dischargeCondition" = 'ALIVE' WHERE id = ${encounterId}::uuid`; // prettier-ignore
    const closed = await post(encounterId, '/read', doctor.token).expect(409);
    expect((closed.body as { code: string }).code).toBe('ASSISTANT_ENCOUNTER_CLOSED'); // prettier-ignore
  });

  it('AS-022 AS-037 a code the physician chose instead of the proposed ones is «aceptada con cambios», at distance 1', async () => {
    const read = await post(encounterId, '/read', doctor.token).expect(200);
    const pharyngitis = (read.body as { problems: Problem[] }).problems[0]!;
    const recorded = await request(app.getHttpServer())
      .post(`/api/v1/encounters/${encounterId}/diagnoses`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({
        conceptId: concepts['R03.0'],
        certainty: 'PRESUMPTIVE',
        occurrence: 'FIRST_TIME',
      }) // prettier-ignore
      .expect(201);

    await post(encounterId, `/${pharyngitis.id}/accept`, doctor.token, { diagnosisId: (recorded.body as { id: string }).id }).expect(200); // prettier-ignore

    const row = await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: pharyngitis.id } }); // prettier-ignore
    expect(row.status).toBe('ACCEPTED_WITH_CHANGES');
    expect(Number(row.distance)).toBe(1);
  });
});
