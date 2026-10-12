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
import { PSEUDONYMIZER } from '../../src/modules/assistant/application/pseudonymizer.port';
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
  createExamService,
  createPatient,
  createSite,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * AS-103 to AS-112 by HTTP, against PostgreSQL, with real sessions and the
 * seed's roles: the exams the assistant proposes from the note and the
 * conversation, only from the clinic's catalogue; the draft written by the
 * order's own route; and the link that reads the saved order. The chain is
 * the demonstration script (AS-029), the only one with no network.
 */
const PASSWORD = 'el caballo come alfalfa';
const NOTE = {
  motivoConsulta: 'Tos y fiebre',
  planTratamiento:
    'Ana: se solicita biometría hemática y radiografía de tórax. Trae EMO previo normal. Perfil tiroideo también.',
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

describe('los exámenes propuestos por HTTP (AS-103 a AS-112)', () => {
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
  let services: Record<string, string>;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

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
        .useValue(new DemoPseudonymizer())
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
    siteId = (await siteWithCity()).id;
    patientId = (await createPatient(prisma)).id;
    services = {};
    for (const [code, name, kind] of [
      ['LAB-BH', 'Biometría hemática completa', 'LAB_EXAM'],
      ['LAB-EMO', 'Elemental y microscópico de orina (EMO)', 'LAB_EXAM'],
      ['IMG-RX-TORAX', 'Radiografía de tórax (PA y lateral)', 'IMAGING'],
      ['IMG-ECO-ABDOMINAL', 'Ecografía abdominal', 'IMAGING'],
      ['PROC-ECG', 'Electrocardiograma', 'PROCEDURE'],
    ] as const) {
      services[code] = (
        await createExamService(prisma, { code, name, kind })
      ).id;
    }
    doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    secondDoctor = await signIn('MEDICO', 'medico2@clinica.ec', '0602910945');
    nurseToken = (await signIn('ENFERMERIA', 'enfermeria@clinica.ec', '1104637283')).token; // prettier-ignore
    encounterId = (await attentionWithNote(doctor.practitionerId)).id;
  });

  afterAll(async () => {
    await closeApp(app);
  });

  /** PR-021. The receta prints the city: the site's parish names its canton. */
  async function siteWithCity() {
    const dpa = await prisma.catalogSystem.upsert({
      where: { code: 'DPA' },
      create: { code: 'DPA', name: 'DPA', hierarchical: true },
      update: {},
    });
    const canton = await prisma.catalogConcept.create({
      data: {
        systemId: dpa.id,
        code: '1701',
        display: 'Quito',
        validFrom: new Date('2010-01-01'), // fecha-fija: vigente desde siempre
      }, // fecha-fija: vigente desde siempre
    });
    const parish = await prisma.catalogConcept.create({
      data: {
        systemId: dpa.id,
        code: '170150',
        display: 'Iñaquito',
        parentId: canton.id,
        validFrom: new Date('2010-01-01'), // fecha-fija: vigente desde siempre
      }, // fecha-fija: vigente desde siempre
    });
    const site = await createSite(prisma);
    return prisma.site.update({ where: { id: site.id }, data: { parishConceptId: parish.id } }); // prettier-ignore
  }

  async function attentionWithNote(
    practitionerId: string,
    content: Record<string, string> = NOTE,
  ) {
    const encounter = await createEncounter(prisma, { siteId, practitionerId, patientId }); // prettier-ignore
    const id = randomUUID();
    await prisma.clinicalNote.create({
      data: { id, chainId: id, encounterId: encounter.id, formCode: '002', formVersion: '1', content, authorId: practitionerId }, // prettier-ignore
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
        // PR-034. The receta prints the ACESS registration.
        acessRegistration: `ACESS-${cedula}`,
        acessExpiresOn: new Date('2030-01-01'), // fecha-fija: vigente durante la prueba
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    const practitioner = await prisma.practitioner.create({
      // PR-040. And a phone beside the warning signs.
      data: { userId: user.id, emergencyContactPhone: '0991234567' },
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
      practitionerId: practitioner.id,
    };
  }

  const url = (id: string, path = '') => `/api/v1/encounters/${id}/assistant/orders${path}`; // prettier-ignore
  const get = (id: string, token: string) =>
    request(app.getHttpServer()).get(url(id)).set('Authorization', `Bearer ${token}`); // prettier-ignore
  const post = (id: string, path: string, token: string, body: object = {}) =>
    request(app.getHttpServer()).post(url(id, path)).set('Authorization', `Bearer ${token}`).send(body); // prettier-ignore

  interface Candidate {
    serviceId: string;
    code: string;
    name: string;
    category: string;
    block: string | null;
  }
  interface Line {
    id: string;
    quote: string;
    origin: { kind: string };
    candidates: Candidate[];
    status: string;
    serviceOrderId: string | null;
    acceptedCode: string | null;
    demo: boolean;
  }
  interface Problem {
    code: string;
  }

  async function readLines(id = encounterId): Promise<Line[]> {
    const response = await post(id, '/read', doctor.token).expect(200);
    return (response.body as { lines: Line[] }).lines;
  }

  /** ORD-095. The order's own route, as the screen does it: a draft. */
  async function draftWith(
    category: 'LABORATORY' | 'IMAGING',
    serviceIds: string[],
    id = encounterId,
  ) {
    // prettier-ignore
    const composed = await request(app.getHttpServer())
      .post(`/api/v1/encounters/${id}/orders`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ category, items: serviceIds.map((serviceId) => ({ serviceId })) })
      .expect(201);
    return (composed.body as { id: string; status: string }).id;
  }

  it('AS-111 asks for assistant:use, which the doctor carries and the nurse does not', async () => {
    await request(app.getHttpServer()).get(url(encounterId)).expect(401);
    await get(encounterId, nurseToken).expect(403);
    // Control: the doctor of the seed gets in by the same route.
    await get(encounterId, doctor.token).expect(200);
  });

  it('AS-103 AS-104 AS-105 AS-107 AS-108 reads the note: each exam asked for with only the catalogue’s candidates; what it brings is not a line; nothing is ordered', async () => {
    const lines = await readLines();

    expect(lines.map((each) => each.candidates.map((c) => c.code))).toEqual([
      ['LAB-BH'], // the 999 of the script was not offered
      ['IMG-RX-TORAX'],
      [], // AS-105. Not in the catalogue: its sentence only
    ]);
    expect(lines[0]).toMatchObject({
      quote: 'Ana: se solicita biometría hemática y radiografía de tórax.',
      origin: { kind: 'note' },
      status: 'PROPOSED',
      demo: true,
    });
    expect(lines[0]!.candidates[0]).toEqual({ serviceId: services['LAB-BH'], code: 'LAB-BH', name: 'Biometría hemática completa', category: 'LABORATORY', block: null }); // prettier-ignore
    expect(lines[2]!.quote).toBe('Perfil tiroideo también.');
    expect(JSON.stringify(lines)).not.toContain('EMO');
    const kept = await prisma.aiSuggestion.findMany({ where: { encounterId }, include: { aiRun: true } }); // prettier-ignore
    expect(
      kept.map((each) => [
        each.kind,
        each.status,
        each.aiRun.purpose,
        each.aiRun.provider,
      ]),
    ).toEqual(
      // prettier-ignore
      Array(3).fill(['order-item', 'PROPOSED', 'order-exams', 'fake']),
    );
    // AS-113. The consultation left for a provider: its EXPORT is in the trail.
    expect(await prisma.accessAudit.count({ where: { resourceType: 'assistant_orders_reading', action: 'EXPORT' } })).toBe(1); // prettier-ignore
    // AS-108. Reading orders nothing.
    expect(await prisma.serviceOrder.count()).toBe(0);
  });

  it('AS-108 AS-109 the screen writes the draft by the order’s route and links it «tal cual» with the exam chosen; the order stays a draft and the exam is then «ya en la orden»', async () => {
    const [bh, rx] = await readLines();
    const orderId = await draftWith('LABORATORY', [services['LAB-BH']!]);

    const linked = await post(encounterId, '/link', doctor.token, { serviceOrderId: orderId, lines: [{ suggestionId: bh!.id, serviceId: services['LAB-BH'] }] }).expect(200); // prettier-ignore
    expect((linked.body as { lines: Line[] }).lines[0]).toMatchObject({ status: 'ACCEPTED', serviceOrderId: orderId, acceptedCode: 'LAB-BH' }); // prettier-ignore
    const kept = await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: bh!.id } }); // prettier-ignore
    expect([kept.status, Number(kept.distance), kept.serviceOrderId, kept.acceptedCode]).toEqual(['ACCEPTED', 0, orderId, 'LAB-BH']); // prettier-ignore
    expect((await prisma.serviceOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('DRAFT'); // prettier-ignore

    // ORD-097. The imaging exam goes to a draft of its own type.
    const imaging = await draftWith('IMAGING', [services['IMG-RX-TORAX']!]);
    await post(encounterId, '/link', doctor.token, { serviceOrderId: imaging, lines: [{ suggestionId: rx!.id, serviceId: services['IMG-RX-TORAX'] }] }).expect(200); // prettier-ignore

    // AS-106. Read again: what is ordered says so and cannot be accepted.
    const again = await readLines();
    expect(again[0]!.candidates[0]).toMatchObject({ code: 'LAB-BH', block: 'in-order' }); // prettier-ignore
    expect(again[1]!.candidates[0]).toMatchObject({ code: 'IMG-RX-TORAX', block: 'in-order' }); // prettier-ignore
  });

  it('AS-109 refuses, linking none: an order of another attention, an exam not on the order, an exam that was not proposed, a repeated line', async () => {
    const [bh] = await readLines();
    const other = await attentionWithNote(doctor.practitionerId);
    const foreign = await draftWith('LABORATORY', [services['LAB-BH']!], other.id); // prettier-ignore
    const own = await draftWith('LABORATORY', [services['LAB-EMO']!]);
    const link = (serviceOrderId: string, lines: object[]) =>
      post(encounterId, '/link', doctor.token, { serviceOrderId, lines });

    for (const [orderId, serviceId] of [
      [foreign, services['LAB-BH']],
      [own, services['LAB-BH']],
      [own, services['LAB-EMO']],
    ] as const) {
      const refused = await link(orderId, [{ suggestionId: bh!.id, serviceId }]).expect(422); // prettier-ignore
      expect((refused.body as Problem).code).toBe('SUGGESTION_ORDER_MISMATCH');
    }
    const repeated = await link(own, [{ suggestionId: bh!.id, serviceId: services['LAB-BH'] }, { suggestionId: bh!.id, serviceId: services['LAB-EMO'] }]).expect(422); // prettier-ignore
    expect((repeated.body as Problem).code).toBe('SUGGESTION_INVALID');
    expect((await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: bh!.id } })).status).toBe('PROPOSED'); // prettier-ignore

    // Control: the right order and exam link by the same route.
    const right = await draftWith('LABORATORY', [services['LAB-BH']!, services['LAB-EMO']!]); // prettier-ignore
    await link(right, [{ suggestionId: bh!.id, serviceId: services['LAB-BH'] }]).expect(200); // prettier-ignore
  });

  it('AS-109 a discarded order, an exam ordered before the reading, or a decided proposal do not link', async () => {
    const before = await draftWith('LABORATORY', [services['LAB-BH']!]);
    const [bh] = await readLines();
    // Ordered by hand before the reading: the physician's, not the proposal's.
    const mine = await post(encounterId, '/link', doctor.token, { serviceOrderId: before, lines: [{ suggestionId: bh!.id, serviceId: services['LAB-BH'] }] }).expect(422); // prettier-ignore
    expect((mine.body as Problem).code).toBe('SUGGESTION_ORDER_MISMATCH');

    const [, rx] = await readLines();
    const imaging = await draftWith('IMAGING', [services['IMG-RX-TORAX']!]);
    await prisma.serviceOrder.update({ where: { id: imaging }, data: { status: 'DISCARDED', discardedAt: new Date(), discardedById: doctor.userId } }); // prettier-ignore
    const discarded = await post(encounterId, '/link', doctor.token, { serviceOrderId: imaging, lines: [{ suggestionId: rx!.id, serviceId: services['IMG-RX-TORAX'] }] }).expect(422); // prettier-ignore
    expect((discarded.body as Problem).code).toBe('SUGGESTION_ORDER_MISMATCH');

    // Control: a live imaging draft links, and then the same proposal is decided.
    const live = await draftWith('IMAGING', [services['IMG-RX-TORAX']!]);
    await post(encounterId, '/link', doctor.token, { serviceOrderId: live, lines: [{ suggestionId: rx!.id, serviceId: services['IMG-RX-TORAX'] }] }).expect(200); // prettier-ignore
    const again = await post(encounterId, '/link', doctor.token, { serviceOrderId: live, lines: [{ suggestionId: rx!.id, serviceId: services['IMG-RX-TORAX'] }] }).expect(409); // prettier-ignore
    expect((again.body as Problem).code).toBe('SUGGESTION_ALREADY_DECIDED');
  });

  it('AS-110 AS-111 only the attention’s own doctor reads, links or discards; the discarded line is not shown again', async () => {
    const [bh] = await readLines();
    const orderId = await draftWith('LABORATORY', [services['LAB-BH']!]);

    const other = await post(encounterId, '/read', secondDoctor.token).expect(403); // prettier-ignore
    expect((other.body as Problem).code).toBe('ASSISTANT_NOT_ENCOUNTER_OWNER');
    await post(encounterId, '/link', secondDoctor.token, { serviceOrderId: orderId, lines: [{ suggestionId: bh!.id, serviceId: services['LAB-BH'] }] }).expect(403); // prettier-ignore
    await post(encounterId, `/${bh!.id}/discard`, secondDoctor.token).expect(403); // prettier-ignore
    expect((await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: bh!.id } })).status).toBe('PROPOSED'); // prettier-ignore

    const after = await post(encounterId, `/${bh!.id}/discard`, doctor.token).expect(200); // prettier-ignore
    expect((after.body as { lines: Line[] }).lines.map((each) => each.id)).not.toContain(bh!.id); // prettier-ignore
    expect((await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: bh!.id } })).status).toBe('DISCARDED'); // prettier-ignore
  });

  it('AS-103 an attention with neither note nor conversation is refused with nothing called', async () => {
    const empty = await attentionWithNote(doctor.practitionerId, {});
    const refused = await post(empty.id, '/read', doctor.token).expect(422);

    expect((refused.body as Problem).code).toBe('ASSISTANT_NOTE_EMPTY');
    expect(await prisma.aiRun.count()).toBe(0);
  });

  it('AS-111 an attention of another site is one that does not exist, and a closed one admits nothing new', async () => {
    const elsewhere = (await createSite(prisma, 'Sede Sur')).id;
    const other = await createEncounter(prisma, { siteId: elsewhere, practitionerId: doctor.practitionerId, patientId }); // prettier-ignore
    const absent = await post(other.id, '/read', doctor.token).expect(404);
    expect((absent.body as Problem).code).toBe('ASSISTANT_ENCOUNTER_NOT_FOUND');
    await get(other.id, doctor.token).expect(404);

    // Control: in its own site the same request reads.
    const [line] = await readLines();
    await prisma.$executeRaw`UPDATE encounter SET status = 'DISCHARGED', ended_at = ${new Date()}, "dischargeCondition" = 'ALIVE' WHERE id = ${encounterId}::uuid`; // prettier-ignore
    for (const path of ['/read', `/${line!.id}/discard`]) {
      const closed = await post(encounterId, path, doctor.token).expect(409);
      expect((closed.body as Problem).code).toBe('ASSISTANT_ENCOUNTER_CLOSED');
    }
    expect(await prisma.aiSuggestion.count({ where: { status: 'PROPOSED' } })).toBe(3); // prettier-ignore
  });

  it('AS-103 AS-106 an exam asked for aloud carries its stretch of the conversation, and only its professional sees it', async () => {
    const quiet = await attentionWithNote(doctor.practitionerId, { motivoConsulta: 'Dolor abdominal' }); // prettier-ignore
    await prisma.transcriptSegment.createMany({
      data: [
        { encounterId: quiet.id, startMs: 0, endMs: 6_000, text: 'Me duele aquí arriba, doctor.', createdAt: new Date() }, // prettier-ignore
        { encounterId: quiet.id, startMs: 6_000, endMs: 11_000, text: 'Le voy a pedir una ecografía abdominal.', createdAt: new Date() }, // prettier-ignore
      ],
    });

    const lines = await readLines(quiet.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      quote: 'Le voy a pedir una ecografía abdominal.',
      origin: { kind: 'transcript', fromMs: 6_000, toMs: 11_000 },
      candidates: [{ code: 'IMG-ECO-ABDOMINAL', category: 'IMAGING' }],
    });
    const kept = await prisma.aiSuggestion.findFirstOrThrow({ where: { encounterId: quiet.id } }); // prettier-ignore
    expect(kept.sources).toEqual([{ kind: 'transcript', fromMs: 6_000, toMs: 11_000 }]); // prettier-ignore
    // AS-058 (review G2). No row outside the transcript holds what was said.
    const said = await prisma.aiSuggestion.findMany();
    expect(JSON.stringify(said)).not.toMatch(/le voy a pedir|me duele/i);

    // AS-056. Another doctor who reads the attention does not see the conversation.
    const theirs = await get(quiet.id, secondDoctor.token).expect(200);
    expect((theirs.body as { lines: Line[] }).lines).toEqual([]);
    const mine = await get(quiet.id, doctor.token).expect(200);
    expect((mine.body as { lines: Line[] }).lines).toHaveLength(1);
  });
});
