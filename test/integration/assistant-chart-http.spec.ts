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
import { NoteDraftService } from '../../src/modules/assistant/application/note-draft.service';
import {
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
  authorizeRecording,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * AS-260 to AS-265 by HTTP against PostgreSQL, with real sessions and the
 * seed's roles: the libreto's conversation, drafted by the demonstration
 * script (no network), leaves «Sin alergias conocidas» and «Hipertensión
 * arterial · Madre» as proposals of the chart; the physician records them by
 * the chart's own routes and links them, and a record that is not the
 * proposal's is refused.
 */
const PASSWORD = 'el caballo come alfalfa';
const SAID = [
  { startMs: 0, endMs: 6_000, text: 'Doctora, me duele mucho la garganta desde hace tres días, y desde ayer tengo fiebre.' }, // prettier-ignore
  { startMs: 6_500, endMs: 9_000, text: '¿Es alérgica a algún medicamento?' },
  { startMs: 9_500, endMs: 12_000, text: 'No, que yo sepa, a ninguno.' },
  { startMs: 12_500, endMs: 15_000, text: '¿Alguna enfermedad que tenga usted o su familia?' }, // prettier-ignore
  { startMs: 15_500, endMs: 18_000, text: 'Yo no. Mi mamá es hipertensa.' },
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

interface Chart {
  proposals: { id: string; kind: string; text: string; quote: string; fromMs: number; relative: string | null; conflict: string | null; demo: boolean }[]; // prettier-ignore
  demo: boolean;
}

describe('las alergias y los antecedentes dichos, por HTTP (AS-260 a AS-265)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  let drafts: NoteDraftService;

  let siteId: string;
  let doctor: { token: string; userId: string; practitionerId: string };
  let secondDoctor: { token: string };
  let patientId: string;
  let encounterId: string;

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
    }

    await syncAuthorisation(prisma);
    registry.invalidate();
    siteId = (await createSite(prisma)).id;
    await enableAssistant(prisma, siteId);
    patientId = (await createPatient(prisma)).id;
    doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    await authorizeRecording(prisma, patientId, doctor.userId);
    secondDoctor = await signIn('MEDICO', 'medico2@clinica.ec', '0602910945');
    const encounter = await createEncounter(prisma, { siteId, practitionerId: doctor.practitionerId, patientId }); // prettier-ignore
    encounterId = encounter.id;
    const noteId = randomUUID();
    await prisma.clinicalNote.create({
      data: { id: noteId, chainId: noteId, encounterId, formCode: '002', formVersion: '1', content: {}, authorId: doctor.practitionerId }, // prettier-ignore
    });
    await prisma.transcriptSegment.createMany({
      data: SAID.map((line) => ({ ...line, encounterId, createdAt: new Date() })), // prettier-ignore
    });
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(roleCode: string, email: string, cedula: string) {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Ana',
        lastName: 'Torres',
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

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const chart = (token = doctor.token) =>
    request(app.getHttpServer()).get(`/api/v1/encounters/${encounterId}/assistant/chart`).set(as(token)); // prettier-ignore
  const decide = (suggestionId: string, verb: 'accept' | 'discard', body: object = {}, token = doctor.token) =>
    request(app.getHttpServer()).post(`/api/v1/encounters/${encounterId}/assistant/chart/${suggestionId}/${verb}`).set(as(token)).send(body); // prettier-ignore

  async function proposed(): Promise<Chart> {
    await request(app.getHttpServer()).post(`/api/v1/encounters/${encounterId}/assistant/note-draft`).set(as(doctor.token)).expect(202); // prettier-ignore
    await drafts.settled();
    return (await chart().expect(200)).body as Chart;
  }

  it('AS-260 AS-263 the libreto leaves «sin alergias» and the mother’s hypertension, each with its line and minute', async () => {
    const overview = await proposed();

    expect(overview.demo).toBe(true);
    expect(
      overview.proposals.map((each) => [
        each.kind,
        each.text,
        each.quote,
        each.fromMs,
      ]),
    ).toEqual([
      // prettier-ignore
      ['chart-no-allergy', 'Sin alergias conocidas', 'No, que yo sepa, a ninguno.', 9_500], // prettier-ignore
      ['chart-history', 'Hipertensión arterial · Madre', 'Mi mamá es hipertensa.', 15_500], // prettier-ignore
    ]);
    expect(await prisma.aiSuggestion.count({ where: { encounterId, kind: { startsWith: 'chart-' } } })).toBe(2); // prettier-ignore
  });

  it('AS-265 each ✓ records by the chart’s own route and links it; another patient’s record is refused', async () => {
    const { proposals } = await proposed();
    const [none, mother] = proposals;

    // Refused: a record of another patient, even the physician's own.
    const otherPatient = (await createPatient(prisma)).id;
    const foreign = await request(app.getHttpServer()).post(`/api/v1/patients/${otherPatient}/allergies/none-known`).set(as(doctor.token)).expect(201); // prettier-ignore
    const refused = await decide(none!.id, 'accept', { recordId: (foreign.body as { id: string }).id }).expect(422); // prettier-ignore
    expect((refused.body as { code: string }).code).toBe(
      'SUGGESTION_CHART_MISMATCH',
    );

    // Control: the same ✓ over the patient's own chart.
    const asserted = await request(app.getHttpServer()).post(`/api/v1/patients/${patientId}/allergies/none-known`).set(as(doctor.token)).expect(201); // prettier-ignore
    const afterNone = (await decide(none!.id, 'accept', { recordId: (asserted.body as { id: string }).id }).expect(200)).body as Chart; // prettier-ignore
    expect(afterNone.proposals.map((each) => each.id)).toEqual([mother!.id]);

    const recorded = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/history`)
      .set(as(doctor.token))
      .send({
        kind: 'FAMILY',
        description: 'Hipertensión arterial',
        relative: 'Madre',
      }) // prettier-ignore
      .expect(201);
    const afterMother = (await decide(mother!.id, 'accept', { recordId: (recorded.body as { id: string }).id }).expect(200)).body as Chart; // prettier-ignore
    expect(afterMother.proposals).toEqual([]);

    const linked = await prisma.aiSuggestion.findMany({ where: { encounterId, kind: { startsWith: 'chart-' } }, orderBy: { proposedAt: 'asc' }, select: { status: true, patientAllergyAbsenceId: true, patientHistoryId: true } }); // prettier-ignore
    expect(linked).toEqual([
      { status: 'ACCEPTED', patientAllergyAbsenceId: (asserted.body as { id: string }).id, patientHistoryId: null }, // prettier-ignore
      { status: 'ACCEPTED', patientAllergyAbsenceId: null, patientHistoryId: (recorded.body as { id: string }).id }, // prettier-ignore
    ]);
  });

  it('AS-039 AS-265 only the attention’s professional reads or decides them; a discarded one is gone', async () => {
    const { proposals } = await proposed();

    await chart(secondDoctor.token).expect(403);
    await decide(proposals[0]!.id, 'discard', {}, secondDoctor.token).expect(403); // prettier-ignore

    const after = (await decide(proposals[0]!.id, 'discard').expect(200)).body as Chart; // prettier-ignore
    expect(after.proposals.map((each) => each.text)).toEqual(['Hipertensión arterial · Madre']); // prettier-ignore
  });
});
