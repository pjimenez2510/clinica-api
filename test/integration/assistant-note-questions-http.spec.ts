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
import {
  createEncounter,
  createPatient,
  createSite,
  enableAssistant,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';
import { withReadRevision } from './setup/read-revision';

/**
 * AS-119 to AS-125 by HTTP against PostgreSQL, with real sessions and the
 * seed's roles: who may ask, what `note_question_check` and `ai_suggestion`
 * keep, that writing the answer in the note takes its question away on the
 * next review, that nothing new to read costs no call, «No hace falta», the
 * failure with its code and the trail. The chain is the demonstration
 * script (AS-029, AS-127): no network.
 */
const PASSWORD = 'el caballo come alfalfa';
const SAID = [
  { startMs: 0, endMs: 12_048, text: 'Buenos días, cuénteme qué le pasa. Desde hace tres días me duele la garganta y tengo fiebre.' }, // prettier-ignore
  { startMs: 12_049, endMs: 16_254, text: 'solo para acetamol de 500 miligramos cada 8 horas.' }, // prettier-ignore
  { startMs: 16_254, endMs: 24_018, text: 'Vamos a revisarle la garganta y tomarle la temperatura. Le indico control en 15 días.' }, // prettier-ignore
];

const demoConfig = {
  get: (key: keyof Env) =>
    ({
      ASSISTANT_FAKE_PROVIDER: true,
      ASSISTANT_ALLOW_REMOTE: false,
      ASSISTANT_PROVIDER_TIMEOUT_MS: 60_000,
      ASSISTANT_EXCHANGE_LOG: false,
    })[key as string],
} as unknown as ConfigService<Env, true>;

const pseudonymizer: Pseudonymizer & { current: Pseudonymizer } = {
  current: new DemoPseudonymizer(),
  pseudonymize: (input, signal) => pseudonymizer.current.pseudonymize(input, signal), // prettier-ignore
};

interface Overview {
  questions: { id: string; text: string; section: string | null; fromMs: number; toMs: number; quote: string; demo: boolean }[]; // prettier-ignore
  checkedAt: string | null;
  transcriptUpToMs: number;
  demo: boolean;
}

describe('las preguntas para completar la nota por HTTP (AS-119 a AS-125)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let doctor: { token: string; userId: string; practitionerId: string };
  let secondDoctor: { token: string };
  let nurseToken: string;
  let patientId: string;
  let encounterId: string;
  let noteId: string;

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
    siteId = (await createSite(prisma)).id;
    await enableAssistant(prisma, siteId);
    patientId = (await createPatient(prisma)).id;
    doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    secondDoctor = await signIn('MEDICO', 'medico2@clinica.ec', '0602910945');
    nurseToken = (await signIn('ENFERMERIA', 'enfermeria@clinica.ec', '1104637283')).token; // prettier-ignore
    ({ encounterId, noteId } = await attentionHeard(doctor.practitionerId));
    // AS-092. The CNMB the lexicon corrects towards.
    const cnmb = await prisma.catalogSystem.upsert({
      where: { code: 'CNMB' },
      create: { code: 'CNMB', name: 'CNMB' },
      update: {},
    });
    await prisma.catalogConcept.create({
      data: {
        systemId: cnmb.id,
        code: 'N02BE01',
        display: 'Paracetamol',
        validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
      }, // fecha-fija: vigente desde siempre
    });
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function attentionHeard(
    practitionerId: string,
    atSite = siteId,
    withNote = true,
  ) {
    const encounter = await createEncounter(prisma, { siteId: atSite, practitionerId, patientId }); // prettier-ignore
    const id = randomUUID();
    if (withNote)
      await prisma.clinicalNote.create({
        data: {
          id,
          chainId: id,
          encounterId: encounter.id,
          formCode: '002',
          formVersion: '1',
          content: { motivoConsulta: 'Dolor de garganta.' },
          authorId: practitionerId,
        },
      });
    await prisma.transcriptSegment.createMany({
      data: SAID.map((line) => ({ ...line, encounterId: encounter.id, createdAt: new Date() })), // prettier-ignore
    });
    return { encounterId: encounter.id, noteId: id };
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

  const url = (id: string, path = '') => `/api/v1/encounters/${id}/assistant/note-questions${path}`; // prettier-ignore
  const get = (id: string, token: string) =>
    request(app.getHttpServer()).get(url(id)).set('Authorization', `Bearer ${token}`); // prettier-ignore
  const post = (id: string, path: string, token: string) =>
    request(app.getHttpServer()).post(url(id, path)).set('Authorization', `Bearer ${token}`).send({}); // prettier-ignore
  const codeOf = (response: { body: unknown }) => (response.body as { code: string }).code; // prettier-ignore

  /** What the screen does as the physician writes: save the section with If-Match (EN-281). */
  async function saveSection(key: string, text: string) {
    const path = `/encounters/${encounterId}/notes/${noteId}`;
    const note = await prisma.clinicalNote.findUniqueOrThrow({ where: { id: noteId } }); // prettier-ignore
    await withReadRevision(
      prisma,
      path,
      request(app.getHttpServer())
        .patch(`/api/v1${path}`)
        .set('Authorization', `Bearer ${doctor.token}`)
        .send({ content: { ...(note.content as object), [key]: text } }),
    ).expect(200);
  }

  it('AS-119 AS-121 AS-127 reviews now and keeps the review and each question with its stretch, its line read again and never kept', async () => {
    const response = await post(encounterId, '', doctor.token).expect(200);
    const reviewed = response.body as Overview;
    // Its lines are the consultation: no cache on the way keeps them.
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await get(encounterId, doctor.token).expect(200)).headers['cache-control']).toBe('no-store'); // prettier-ignore

    expect(reviewed.questions.map((each) => each.text)).toEqual([
      '¿Hasta qué temperatura llegó la fiebre?',
      '¿Tiene tos o le cuesta tragar?',
      '¿Toma algún otro medicamento?',
    ]);
    expect(reviewed.questions[2]).toMatchObject({ fromMs: 12_049, toMs: 16_254, quote: SAID[1]!.text, demo: true }); // prettier-ignore
    expect(reviewed.transcriptUpToMs).toBe(24_018);
    const check = await prisma.noteQuestionCheck.findFirstOrThrow({ where: { encounterId } }); // prettier-ignore
    expect(check).toMatchObject({ upToMs: 24_018, asked: 3, dropped: 1, requestedBy: doctor.userId }); // prettier-ignore
    const kept = await prisma.aiSuggestion.findMany({ where: { encounterId } });
    expect(kept).toHaveLength(3);
    expect(kept.every((each) => each.kind === 'note-question' && each.aiRunId === check.aiRunId)).toBe(true); // prettier-ignore
    expect(JSON.stringify(kept)).not.toMatch(/acetamol|cuénteme/);
    expect((await prisma.aiRun.findUniqueOrThrow({ where: { id: check.aiRunId } })).purpose).toBe('note-questions'); // prettier-ignore
  });

  it('AS-123 nothing new to read costs no call; the answer written in the note takes its question away on the next review', async () => {
    await post(encounterId, '', doctor.token).expect(200);
    await post(encounterId, '', doctor.token).expect(200);
    expect(await prisma.aiRun.count({ where: { encounterId } })).toBe(1);

    await saveSection('enfermedadActual', 'Fiebre de hasta 38,5 °C.');
    const after = (await post(encounterId, '', doctor.token).expect(200)).body as Overview; // prettier-ignore

    expect(await prisma.aiRun.count({ where: { encounterId } })).toBe(2);
    expect(after.questions.map((each) => each.text)).toEqual([
      '¿Tiene tos o le cuesta tragar?',
      '¿Toma algún otro medicamento?',
    ]);
    expect(((await get(encounterId, doctor.token).expect(200)).body as Overview).questions).toHaveLength(2); // prettier-ignore
  });

  it('AS-125 «No hace falta» takes it off, it does not come back, and one not on screen is refused', async () => {
    const { questions } = (await post(encounterId, '', doctor.token).expect(200)).body as Overview; // prettier-ignore
    const tos = questions.find((each) => /tos/.test(each.text))!;

    const after = (await post(encounterId, `/${tos.id}/discard`, doctor.token).expect(200)).body as Overview; // prettier-ignore
    expect(after.questions.map((each) => each.id)).not.toContain(tos.id);
    expect(await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: tos.id } })).toMatchObject({ status: 'DISCARDED', decidedBy: doctor.userId }); // prettier-ignore

    await saveSection('planTratamiento', 'Control en 15 días.');
    const next = (await post(encounterId, '', doctor.token).expect(200)).body as Overview; // prettier-ignore
    expect(next.questions.map((each) => each.text)).not.toContain(tos.text);
    expect(next.questions).toHaveLength(2);
    // Discarded already, and an old one: not on screen.
    expect(codeOf(await post(encounterId, `/${tos.id}/discard`, doctor.token).expect(404))).toBe('SUGGESTION_NOT_FOUND'); // prettier-ignore
  });

  it('AS-119 AS-122 only the professional of the attention asks and reads, where they write, with assistant:use', async () => {
    // Control: the professional gets in by the same routes.
    await get(encounterId, doctor.token).expect(200);
    await get(encounterId, nurseToken).expect(403);
    expect(codeOf(await post(encounterId, '', secondDoctor.token).expect(403))).toBe('ASSISTANT_NOT_ENCOUNTER_OWNER'); // prettier-ignore
    expect(codeOf(await get(encounterId, secondDoctor.token).expect(403))).toBe('ASSISTANT_NOT_ENCOUNTER_OWNER'); // prettier-ignore
    const elsewhere = await createSite(prisma);
    await enableAssistant(prisma, elsewhere.id);
    const far = await attentionHeard(doctor.practitionerId, elsewhere.id);
    expect(codeOf(await post(far.encounterId, '', doctor.token).expect(404))).toBe('ASSISTANT_ENCOUNTER_NOT_FOUND'); // prettier-ignore
    expect(await prisma.aiRun.count()).toBe(0);
  });

  it('AS-119 without transcript, without the note open or with the attention closed, nothing is asked', async () => {
    await prisma.transcriptSegment.deleteMany({ where: { encounterId } });
    expect(codeOf(await post(encounterId, '', doctor.token).expect(422))).toBe('ASSISTANT_TRANSCRIPT_EMPTY'); // prettier-ignore

    const second = await attentionHeard(doctor.practitionerId, siteId, false);
    expect(codeOf(await post(second.encounterId, '', doctor.token).expect(409))).toBe('ASSISTANT_NOTE_NOT_OPEN'); // prettier-ignore

    const third = await attentionHeard(doctor.practitionerId);
    await prisma.$executeRaw`UPDATE encounter SET status = 'DISCHARGED', ended_at = ${new Date()}, "dischargeCondition" = 'ALIVE' WHERE id = ${third.encounterId}::uuid`; // prettier-ignore
    expect(codeOf(await post(third.encounterId, '', doctor.token).expect(409))).toBe('ASSISTANT_ENCOUNTER_CLOSED'); // prettier-ignore
    expect(await prisma.aiRun.count()).toBe(0);
    // Positive control: the first attention, with its transcript back, is reviewed.
    await prisma.transcriptSegment.createMany({ data: SAID.map((line) => ({ ...line, encounterId, createdAt: new Date() })) }); // prettier-ignore
    await post(encounterId, '', doctor.token).expect(200);
  });

  it('AS-124 without pseudonymizer it answers its code and keeps nothing; the earlier review stays', async () => {
    await post(encounterId, '', doctor.token).expect(200);
    await saveSection('enfermedadActual', 'Fiebre.');
    pseudonymizer.current = new MissingPseudonymizer();

    const failed = await post(encounterId, '', doctor.token);

    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(codeOf(failed)).toBe('ASSISTANT_NOT_CONFIGURED');
    expect(await prisma.noteQuestionCheck.count({ where: { encounterId } })).toBe(1); // prettier-ignore
    expect(((await get(encounterId, doctor.token).expect(200)).body as Overview).questions).toHaveLength(3); // prettier-ignore
  });

  it('AS-124 sending leaves its EXPORT and reading its READ, and note_question_check holds no text', async () => {
    await post(encounterId, '', doctor.token).expect(200);

    const trail = await prisma.accessAudit.findMany({ where: { resourceId: encounterId } }); // prettier-ignore
    expect(trail.map((each) => [each.resourceType, each.action])).toEqual(
      expect.arrayContaining([
        ['assistant_note_questions_reading', 'EXPORT'],
        ['assistant_note_questions', 'READ'],
      ]),
    );
    const row = await prisma.noteQuestionCheck.findFirstOrThrow({ where: { encounterId } }); // prettier-ignore
    expect(JSON.stringify(row)).not.toMatch(/garganta|acetamol|fiebre|Dolor/);
  });
});
