import { randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
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
import {
  AI_RUN_STORE,
  type AiRunStore,
} from '../../src/modules/assistant/application/ai-run.store';
import { ASSISTANT_DEMO } from '../../src/modules/assistant/application/diagnosis-proposal.service';
import { LLM_CLIENT } from '../../src/modules/assistant/application/llm-client.port';
import { NoteDraftService } from '../../src/modules/assistant/application/note-draft.service';
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
import { LiveEventBus } from '../../src/shared/events/live-event-bus';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createEncounter, createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';
import { withReadRevision } from './setup/read-revision';

/**
 * AS-086 to AS-097 by HTTP against PostgreSQL, with real sessions and the
 * seed's roles: who may ask, what `note_draft` and `ai_suggestion` keep, that
 * accepting links the section to the note saved with `If-Match` and never
 * signs it, the failure with its code and «Volver a pedir», and the trail.
 * The chain is the demonstration script (AS-029, AS-099): no network.
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
  draft: { id: string; status: string; upToMs: number; failureCode: string | null } | null; // prettier-ignore
  coveredUpToMs: number;
  transcriptUpToMs: number;
  sections: {
    id: string;
    section: string;
    text: string;
    status: string;
    demo: boolean;
    phrases: { text: string; fromMs: number | null; unsaid: boolean }[];
  }[];
  demo: boolean;
}

describe('el borrador de la nota por HTTP (AS-086 a AS-097)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  let drafts: NoteDraftService;
  let bus: LiveEventBus;

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
      drafts = app.get(NoteDraftService);
      bus = app.get(LiveEventBus);
    }

    await syncAuthorisation(prisma);
    registry.invalidate();
    siteId = (await createSite(prisma)).id;
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

  const url = (id: string, path = '') => `/api/v1/encounters/${id}/assistant/note-draft${path}`; // prettier-ignore
  const get = (id: string, token: string) =>
    request(app.getHttpServer()).get(url(id)).set('Authorization', `Bearer ${token}`); // prettier-ignore
  const post = (id: string, path: string, token: string, body: object = {}) =>
    request(app.getHttpServer()).post(url(id, path)).set('Authorization', `Bearer ${token}`).send(body); // prettier-ignore

  /** What the screen does on «Aceptar»: save the section with If-Match (EN-281). */
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

  async function drafted(): Promise<Overview> {
    await post(encounterId, '', doctor.token).expect(202);
    await drafts.settled();
    return (await get(encounterId, doctor.token).expect(200)).body as Overview;
  }

  it('AS-086 AS-090 AS-099 asks with 202, writes apart and keeps one proposal per section with its attempt and its stretches', async () => {
    const asked = await post(encounterId, '', doctor.token).expect(202);
    expect((asked.body as Overview).draft).toMatchObject({ upToMs: 24_018 });
    await drafts.settled();

    const overview = (await get(encounterId, doctor.token).expect(200)).body as Overview; // prettier-ignore

    expect(overview.draft).toMatchObject({ status: 'DONE', upToMs: 24_018, failureCode: null }); // prettier-ignore
    expect(overview.coveredUpToMs).toBe(24_018);
    expect(overview.demo).toBe(true);
    expect(overview.sections.every((each) => (each as { acceptedBefore?: unknown }).acceptedBefore === null)).toBe(true); // prettier-ignore
    expect(overview.sections.map((each) => each.section)).toEqual([
      'motivoConsulta',
      'enfermedadActual',
      'examenFisico',
      'planTratamiento',
    ]);
    const phrases = overview.sections.flatMap((each) => each.phrases);
    expect(phrases.filter((phrase) => phrase.unsaid)).toHaveLength(1);
    // AS-092: whisper wrote «para acetamol»; the model read «paracetamol».
    expect(phrases.find((phrase) => /paracetamol/i.test(phrase.text))).toMatchObject({ fromMs: 12_049, unsaid: false }); // prettier-ignore

    const row = await prisma.noteDraft.findFirstOrThrow({ where: { encounterId } }); // prettier-ignore
    const kept = await prisma.aiSuggestion.findMany({ where: { encounterId }, orderBy: { proposedAt: 'asc' } }); // prettier-ignore
    expect(row).toMatchObject({ status: 'DONE', requestedBy: doctor.userId });
    expect(kept).toHaveLength(4);
    expect(kept.every((each) => each.kind === 'note-section' && each.aiRunId === row.aiRunId)).toBe(true); // prettier-ignore
    expect((await prisma.aiRun.findUniqueOrThrow({ where: { id: row.aiRunId! } })).provider).toBe('fake'); // prettier-ignore
    expect(kept[1]!.sources).toEqual([
      { kind: 'transcript', fromMs: 0, toMs: 12_048 },
      { kind: 'transcript', fromMs: 12_049, toMs: 16_254 },
    ]);
  });

  it('AS-086 the same stretch is drafted once however many times it is asked for', async () => {
    await drafted();
    await drafted();

    expect(await prisma.noteDraft.count({ where: { encounterId } })).toBe(1);
    expect(await prisma.aiRun.count({ where: { encounterId } })).toBe(1);
  });

  it('AS-086 only the professional of the attention asks and reads, where they write, with assistant:use', async () => {
    // Control: the professional gets in by the same routes.
    await get(encounterId, doctor.token).expect(200);
    await get(encounterId, nurseToken).expect(403);
    const other = await post(encounterId, '', secondDoctor.token).expect(403);
    expect((other.body as { code: string }).code).toBe('ASSISTANT_NOT_ENCOUNTER_OWNER'); // prettier-ignore
    const elsewhere = await createSite(prisma);
    const far = await attentionHeard(doctor.practitionerId, elsewhere.id);
    const missing = await get(far.encounterId, doctor.token).expect(404);
    expect((missing.body as { code: string }).code).toBe('ASSISTANT_ENCOUNTER_NOT_FOUND'); // prettier-ignore
    expect(await prisma.noteDraft.count()).toBe(0);
  });

  it('AS-086 without the note open, without transcript or with the attention closed, nothing is asked for', async () => {
    await prisma.transcriptSegment.deleteMany({ where: { encounterId } });
    const empty = await post(encounterId, '', doctor.token).expect(422);
    expect((empty.body as { code: string }).code).toBe('ASSISTANT_TRANSCRIPT_EMPTY'); // prettier-ignore

    const second = await attentionHeard(doctor.practitionerId, siteId, false);
    const closedNote = await post(second.encounterId, '', doctor.token).expect(
      409,
    );
    expect((closedNote.body as { code: string }).code).toBe('ASSISTANT_NOTE_NOT_OPEN'); // prettier-ignore

    const third = await attentionHeard(doctor.practitionerId);
    await prisma.$executeRaw`UPDATE encounter SET status = 'DISCHARGED', ended_at = ${new Date()}, "dischargeCondition" = 'ALIVE' WHERE id = ${third.encounterId}::uuid`; // prettier-ignore
    const closed = await post(third.encounterId, '', doctor.token).expect(409);
    expect((closed.body as { code: string }).code).toBe('ASSISTANT_ENCOUNTER_CLOSED'); // prettier-ignore
    expect(await prisma.noteDraft.count()).toBe(0);
  });

  it('AS-094 accepting links the section to the note saved with If-Match, at distance 0, and the note stays a draft without signature', async () => {
    const { sections } = await drafted();
    const plan = sections.find((each) => each.section === 'planTratamiento')!;
    await saveSection('planTratamiento', plan.text);

    const after = await post(encounterId, `/sections/${plan.id}/accept`, doctor.token, { noteId }).expect(200); // prettier-ignore

    expect((after.body as Overview).sections.find((each) => each.id === plan.id)).toMatchObject({ status: 'ACCEPTED' }); // prettier-ignore
    const kept = await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: plan.id } }); // prettier-ignore
    expect(kept).toMatchObject({ status: 'ACCEPTED', clinicalNoteId: noteId, decidedBy: doctor.userId }); // prettier-ignore
    expect(Number(kept.distance)).toBe(0);
    const note = await prisma.clinicalNote.findUniqueOrThrow({ where: { id: noteId } }); // prettier-ignore
    expect(note).toMatchObject({ status: 'DRAFT', signedAt: null, signedById: null }); // prettier-ignore
  });

  it('AS-094 what the physician added to the section makes it «con cambios», with its distance', async () => {
    const { sections } = await drafted();
    const reason = sections.find((each) => each.section === 'motivoConsulta')!;
    await saveSection('motivoConsulta', `Dolor de garganta. ${reason.text}`);

    await post(encounterId, `/sections/${reason.id}/accept`, doctor.token, { noteId }).expect(200); // prettier-ignore

    const kept = await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: reason.id } }); // prettier-ignore
    expect(kept.status).toBe('ACCEPTED_WITH_CHANGES');
    expect(Number(kept.distance)).toBeGreaterThan(0);
  });

  it('AS-094 a note that is not the attention’s draft is refused, and discarding takes the section off the screen', async () => {
    const { sections } = await drafted();
    const other = await attentionHeard(doctor.practitionerId);

    const refused = await post(encounterId, `/sections/${sections[0]!.id}/accept`, doctor.token, { noteId: other.noteId }).expect(409); // prettier-ignore
    expect((refused.body as { code: string }).code).toBe('ASSISTANT_NOTE_NOT_OPEN'); // prettier-ignore

    const after = await post(encounterId, `/sections/${sections[0]!.id}/discard`, doctor.token).expect(200); // prettier-ignore
    expect((after.body as Overview).sections.map((each) => each.id)).not.toContain(sections[0]!.id); // prettier-ignore
    expect((await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: sections[0]!.id } })).status).toBe('DISCARDED'); // prettier-ignore
  });

  it('AS-096 no cache on the way keeps the draft: every route of it answers no-store', async () => {
    const asked = await post(encounterId, '', doctor.token).expect(202);
    const cancelled = await post(encounterId, '/cancel', doctor.token).expect(200); // prettier-ignore
    const { sections } = await drafted();
    const plan = sections.find((each) => each.section === 'planTratamiento')!;
    await saveSection('planTratamiento', plan.text);
    const accepted = await post(encounterId, `/sections/${plan.id}/accept`, doctor.token, { noteId }).expect(200); // prettier-ignore
    const discarded = await post(encounterId, `/sections/${sections[0]!.id}/discard`, doctor.token).expect(200); // prettier-ignore
    const read = await get(encounterId, doctor.token).expect(200);

    for (const response of [asked, cancelled, accepted, discarded, read]) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
    // Positive control: the header is the draft's, not one every answer carries.
    const note = await request(app.getHttpServer())
      .get(`/api/v1/encounters/${encounterId}/notes`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .expect(200);
    expect(note.headers['cache-control']).not.toBe('no-store');
  });

  it('AS-093 without pseudonymizer the draft fails with its code and keeps nothing; «Volver a pedir» writes it', async () => {
    pseudonymizer.current = new MissingPseudonymizer();
    const failed = await drafted();

    expect(failed.draft).toMatchObject({ status: 'FAILED', failureCode: 'ASSISTANT_NOT_CONFIGURED' }); // prettier-ignore
    expect(failed.sections).toEqual([]);
    expect(await prisma.aiSuggestion.count({ where: { encounterId } })).toBe(0);

    pseudonymizer.current = new DemoPseudonymizer();
    const again = await drafted();

    expect(again.draft).toMatchObject({ status: 'DONE', failureCode: null });
    expect(await prisma.noteDraft.count({ where: { encounterId } })).toBe(1);
  });

  it('AS-097 tells whoever asked, at the attention’s site, without content', async () => {
    const published = vi.spyOn(bus, 'publish');
    await drafted();

    expect(published).toHaveBeenCalledWith({
      kind: 'assistant-draft',
      siteId,
      userIds: [doctor.userId],
    });
    published.mockRestore();
  });

  it('AS-095 sending the transcript leaves its EXPORT and reading the draft its READ, and note_draft holds no text', async () => {
    await drafted();

    const trail = await prisma.accessAudit.findMany({ where: { resourceId: encounterId } }); // prettier-ignore
    expect(trail.map((each) => [each.resourceType, each.action])).toEqual(
      expect.arrayContaining([
        ['assistant_note_draft_reading', 'EXPORT'],
        ['assistant_note_draft', 'READ'],
      ]),
    );
    const row = await prisma.noteDraft.findFirstOrThrow({ where: { encounterId } }); // prettier-ignore
    expect(JSON.stringify(row)).not.toMatch(/garganta|acetamol|fiebre/);
  });
});
