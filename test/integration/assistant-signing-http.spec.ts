import { randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import {
  AI_RUN_STORE,
  type AiRunStore,
} from '../../src/modules/assistant/application/ai-run.store';
import { ASSISTANT_DEMO } from '../../src/modules/assistant/application/diagnosis-proposal.service';
import { ListeningService } from '../../src/modules/assistant/application/listening.service';
import { LLM_CLIENT } from '../../src/modules/assistant/application/llm-client.port';
import { NoteDraftService } from '../../src/modules/assistant/application/note-draft.service';
import {
  PSEUDONYMIZER,
  type Pseudonymizer,
} from '../../src/modules/assistant/application/pseudonymizer.port';
import { SigningReviewService } from '../../src/modules/assistant/application/signing-review.service';
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
  answerScreening,
  createDiagnosis,
  createEncounter,
  createPatient,
  createSite,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';
import { withReadRevision } from './setup/read-revision';

/**
 * E1 (AS-140 to AS-147) by HTTP against PostgreSQL, with real sessions and
 * the seed's roles: signing is refused while the assistant drafts or listens,
 * «Dejar de esperar» cancels the draft, and the signature stops the listening
 * and leaves each section the physician had in front of them reviewed against
 * the signed note. The chain is the demonstration script: no network.
 */
const PASSWORD = 'el caballo come alfalfa';
const SAID = [
  { startMs: 0, endMs: 12_048, text: 'Buenos días, cuénteme qué le pasa. Desde hace tres días me duele la garganta y tengo fiebre.' }, // prettier-ignore
  { startMs: 12_049, endMs: 16_254, text: 'solo para acetamol de 500 miligramos cada 8 horas.' }, // prettier-ignore
  { startMs: 16_254, endMs: 24_018, text: 'Vamos a revisarle la garganta y tomarle la temperatura. Le indico control en 15 días.' }, // prettier-ignore
];
/** EN-020. What the doctor wrote, every section the 002 demands at the signature. */
const WRITTEN = {
  motivoConsulta: 'Dolor de garganta.',
  antecedentes: 'Sin antecedentes patológicos de importancia.',
  enfermedadActual: 'Odinofagia y fiebre de tres días.',
  revisionOrganosSistemas: 'Resto de sistemas sin particularidades.',
  examenFisico: 'Faringe eritematosa.',
  planTratamiento: 'Paracetamol 500 mg cada 8 horas.',
};

const demoConfig = {
  get: (key: keyof Env) =>
    ({
      ASSISTANT_FAKE_PROVIDER: true,
      ASSISTANT_ALLOW_REMOTE: false,
      ASSISTANT_PROVIDER_TIMEOUT_MS: 60_000,
      ASSISTANT_EXCHANGE_LOG: false,
    })[key as string],
} as unknown as ConfigService<Env, true>;

/** The demonstration's pseudonymizer, or one held until a test lets it go. */
const pseudonymizer: Pseudonymizer & { current: Pseudonymizer } = {
  current: new DemoPseudonymizer(),
  pseudonymize: (input, signal) => pseudonymizer.current.pseudonymize(input, signal), // prettier-ignore
};

function heldPseudonymizer(): { held: Pseudonymizer; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const demo = new DemoPseudonymizer();
  return {
    release,
    held: {
      pseudonymize: (input, signal) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
          void gate.then(() => resolve(demo.pseudonymize(input, signal)));
        }),
    },
  };
}

interface Problem {
  code: string;
}
interface Overview {
  draft: { status: string; failureCode: string | null } | null;
  sections: { id: string; section: string; text: string; status: string }[];
}

describe('la revisión al firmar por HTTP (AS-140 a AS-147)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  let drafts: NoteDraftService;
  let listening: ListeningService;

  let siteId: string;
  let doctor: { token: string; userId: string; practitionerId: string };
  let secondDoctor: { token: string };
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
      drafts = app.get(NoteDraftService);
      listening = app.get(ListeningService);
    }

    await syncAuthorisation(prisma);
    registry.invalidate();
    siteId = (await createSite(prisma)).id;
    doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    secondDoctor = await signIn('MEDICO', 'medico2@clinica.ec', '0602910945');
    ({ encounterId, noteId } = await attentionHeard(doctor.practitionerId));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await drafts.settled();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  /** An attention ready to be signed —diagnosis, block F, the 002 written— and heard. */
  async function attentionHeard(practitionerId: string) {
    const patient = await createPatient(prisma);
    const encounter = await createEncounter(prisma, { siteId, practitionerId, patientId: patient.id }); // prettier-ignore
    const id = randomUUID();
    await prisma.clinicalNote.create({
      data: {
        id,
        chainId: id,
        encounterId: encounter.id,
        formCode: '002',
        formVersion: '1',
        content: WRITTEN,
        authorId: practitionerId,
      },
    });
    await createDiagnosis(prisma, encounter.id, 'J02.9');
    await answerScreening(prisma, encounter.id, practitionerId);
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

  const draftUrl = (path = '') => `/api/v1/encounters/${encounterId}/assistant/note-draft${path}`; // prettier-ignore
  const postDraft = (path: string, token = doctor.token, body: object = {}) =>
    request(app.getHttpServer()).post(draftUrl(path)).set('Authorization', `Bearer ${token}`).send(body); // prettier-ignore

  function sign(id = encounterId, note = noteId) {
    const path = `/encounters/${id}/notes/${note}/sign`;
    return withReadRevision(
      prisma,
      path,
      request(app.getHttpServer())
        .post(`/api/v1${path}`)
        .set('Authorization', `Bearer ${doctor.token}`)
        .send({ dischargeCondition: 'ALIVE' }),
    );
  }

  /** What the screen does on «Aceptar»: the section saved with If-Match, then linked. */
  async function accept(
    section: { id: string; section: string },
    text: string,
  ) {
    const path = `/encounters/${encounterId}/notes/${noteId}`;
    const note = await prisma.clinicalNote.findUniqueOrThrow({ where: { id: noteId } }); // prettier-ignore
    await withReadRevision(
      prisma,
      path,
      request(app.getHttpServer())
        .patch(`/api/v1${path}`)
        .set('Authorization', `Bearer ${doctor.token}`)
        .send({
          content: { ...(note.content as object), [section.section]: text },
        }),
    ).expect(200);
    await postDraft(`/sections/${section.id}/accept`, doctor.token, { noteId }).expect(200); // prettier-ignore
  }

  it('AS-141 AS-147 a draft being written refuses the signature; «Dejar de esperar» cancels it and then it signs', async () => {
    const { held, release } = heldPseudonymizer();
    pseudonymizer.current = held;
    await postDraft('').expect(202);

    const refused = await sign().expect(409);
    expect((refused.body as Problem).code).toBe('NOTE_SIGN_WHILE_DRAFTING');
    expect((await prisma.clinicalNote.findUniqueOrThrow({ where: { id: noteId } })).status).toBe('DRAFT'); // prettier-ignore

    // AS-147: only the attention's professional stops waiting for it.
    const other = await postDraft('/cancel', secondDoctor.token).expect(403);
    expect((other.body as Problem).code).toBe('ASSISTANT_NOT_ENCOUNTER_OWNER');
    const cancelled = await postDraft('/cancel').expect(200);
    expect((cancelled.body as Overview).draft).toMatchObject({
      status: 'FAILED',
      failureCode: 'ASSISTANT_DRAFT_CANCELLED',
    });
    release();
    await drafts.settled();
    expect(await prisma.aiSuggestion.count({ where: { encounterId } })).toBe(0);

    // Positive control: nothing in flight, and the same signature goes through.
    await sign().expect(200);
    expect((await prisma.clinicalNote.findUniqueOrThrow({ where: { id: noteId } })).status).toBe('SIGNED'); // prettier-ignore
  });

  it('AS-147 with nothing in flight «Dejar de esperar» changes nothing', async () => {
    await postDraft('').expect(202);
    await drafts.settled();

    const after = await postDraft('/cancel').expect(200);

    expect((after.body as Overview).draft).toMatchObject({ status: 'DONE' });
    expect((await prisma.noteDraft.findFirstOrThrow({ where: { encounterId } })).status).toBe('DONE'); // prettier-ignore
  });

  it('AS-140 the assistant capturing the consultation refuses the signature, and nothing is signed', async () => {
    const capturing = vi.spyOn(listening, 'capturing').mockReturnValue(true);

    const refused = await sign().expect(409);

    expect((refused.body as Problem).code).toBe('NOTE_SIGN_WHILE_LISTENING');
    expect(capturing).toHaveBeenCalledWith(encounterId);
    expect((await prisma.clinicalNote.findUniqueOrThrow({ where: { id: noteId } })).status).toBe('DRAFT'); // prettier-ignore
    // Positive control: stopped, the same signature goes through.
    capturing.mockReturnValue(false);
    await sign().expect(200);
  });

  it('AS-143 AS-144 the signature stops the listening and reviews each section shown against the signed note', async () => {
    await prisma.listeningSession.create({
      data: { encounterId, state: 'PAUSED', offsetMs: 24_018, device: 'computador', startedBy: doctor.userId, startedAt: new Date(), updatedAt: new Date() }, // prettier-ignore
    });
    await postDraft('').expect(202);
    await drafts.settled();
    const shown = ((await request(app.getHttpServer()).get(draftUrl()).set('Authorization', `Bearer ${doctor.token}`).expect(200)).body as Overview).sections; // prettier-ignore
    const plan = shown.find((each) => each.section === 'planTratamiento')!;
    const exam = shown.find((each) => each.section === 'examenFisico')!;
    // Accepted, then retouched by the physician before signing.
    await accept(plan, plan.text);
    const note = await prisma.clinicalNote.findUniqueOrThrow({ where: { id: noteId } }); // prettier-ignore
    await withReadRevision(
      prisma,
      `/encounters/${encounterId}/notes/${noteId}`,
      request(app.getHttpServer())
        .patch(`/api/v1/encounters/${encounterId}/notes/${noteId}`)
        .set('Authorization', `Bearer ${doctor.token}`)
        .send({ content: { ...(note.content as object), planTratamiento: `${plan.text} Control en 15 días.` } }), // prettier-ignore
    ).expect(200);
    await postDraft(`/sections/${exam.id}/discard`).expect(200);

    await sign().expect(200);

    expect((await prisma.listeningSession.findUniqueOrThrow({ where: { encounterId } })).state).toBe('STOPPED'); // prettier-ignore
    const reviews = await prisma.aiSuggestionReview.findMany({
      where: { suggestion: { encounterId } },
      include: { suggestion: { select: { proposal: true } } },
    });
    expect(reviews).toHaveLength(shown.length);
    expect(reviews.every((each) => each.clinicalNoteId === noteId)).toBe(true);
    const ofSection = (key: string) => reviews.find((each) => (each.suggestion.proposal as { section: string }).section === key)!; // prettier-ignore
    expect(ofSection('planTratamiento').statusAtSigning).toBe('ACCEPTED');
    expect(Number(ofSection('planTratamiento').distance)).toBeGreaterThan(0);
    expect(ofSection('examenFisico').statusAtSigning).toBe('DISCARDED');
    expect(ofSection('motivoConsulta').statusAtSigning).toBe('PROPOSED');
  });

  it('AS-144 what a signature could not review, the sweep reviews once', async () => {
    await postDraft('').expect(202);
    await drafts.settled();
    const review = vi
      .spyOn(app.get(SigningReviewService), 'review')
      .mockRejectedValueOnce(new Error('database down'));

    await sign().expect(200);
    expect(await prisma.aiSuggestionReview.count()).toBe(0);
    review.mockRestore();

    const kept = await app.get(SigningReviewService).sweep();

    expect(kept).toBe(
      await prisma.aiSuggestion.count({ where: { encounterId } }),
    );
    expect(kept).toBeGreaterThan(0);
    expect(await app.get(SigningReviewService).sweep()).toBe(0);
  });

  it('AS-142 AS-143 interrupting is not refused while drafting: it signs, cancels the draft and stops the listening', async () => {
    await prisma.listeningSession.create({
      data: { encounterId, state: 'PAUSED', offsetMs: 24_018, device: 'computador', startedBy: doctor.userId, startedAt: new Date(), updatedAt: new Date() }, // prettier-ignore
    });
    const { held, release } = heldPseudonymizer();
    pseudonymizer.current = held;
    await postDraft('').expect(202);

    await request(app.getHttpServer())
      .post(`/api/v1/encounters/${encounterId}/discontinue`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ reason: 'El paciente se retiró', origin: 'PATIENT' })
      .expect(200);
    release();
    await drafts.settled();

    expect((await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } })).status).toBe('DISCONTINUED'); // prettier-ignore
    expect(await prisma.noteDraft.findFirstOrThrow({ where: { encounterId } })).toMatchObject({ status: 'FAILED', failureCode: 'ASSISTANT_DRAFT_CANCELLED' }); // prettier-ignore
    expect((await prisma.listeningSession.findUniqueOrThrow({ where: { encounterId } })).state).toBe('STOPPED'); // prettier-ignore
    expect(await prisma.aiSuggestion.count({ where: { encounterId } })).toBe(0);
  });
});
