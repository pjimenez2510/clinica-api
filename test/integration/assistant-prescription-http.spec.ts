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
import {
  SURVIVING_CHART_ALLERGY_READER,
  type SurvivingChartAllergyReader,
} from '../../src/shared/clinical/patient-allergy.port';
import type { Env } from '../../src/shared/config/env.schema';
import { PrismaActiveAllergyReader } from '../../src/shared/infrastructure/clinical/prisma-active-allergy.reader';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createDiagnosis,
  createEncounter,
  createPatient,
  createSite,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';
import { withReadRevision } from './setup/read-revision';

/**
 * AS-063 to AS-077 by HTTP, against PostgreSQL, with real sessions and the
 * seed's roles: what the assistant proposes from the note, the allergy check
 * that fails closed, «Confirmar» that writes nothing, the draft written by
 * the receta's own route, and the link that reads the saved line. The chain
 * is the demonstration script (AS-029), the only one with no network.
 */
const PASSWORD = 'el caballo come alfalfa';
const NOTE = {
  motivoConsulta: 'Dolor de garganta',
  planTratamiento:
    'Ana: amoxicilina 500 mg, una tableta cada 8 horas por 7 días. Jarabe de miel con limón cada noche.',
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

/** Lets a test make the allergy reader fail, as a lost connection would. */
const allergyReader: SurvivingChartAllergyReader & {
  current: SurvivingChartAllergyReader | null;
  down: boolean;
} = {
  current: null,
  down: false,
  activeForSurvivorOf: (chartId) =>
    allergyReader.down
      ? Promise.reject(new Error('connection lost'))
      : allergyReader.current!.activeForSurvivorOf(chartId),
};

describe('la receta propuesta por HTTP (AS-063 a AS-077)', () => {
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
  let amoxicillinId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();
    allergyReader.down = false;

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
        .overrideProvider(SURVIVING_CHART_ALLERGY_READER)
        .useValue(allergyReader)
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
    // The real reader, on this test's database: the override only adds the switch.
    allergyReader.current = new PrismaActiveAllergyReader(prisma as unknown as PrismaService); // prettier-ignore

    await syncAuthorisation(prisma);
    registry.invalidate();
    siteId = (await siteWithCity()).id;
    patientId = (await createPatient(prisma)).id;
    amoxicillinId = (
      await cnmb(
        'J01CA04',
        'Amoxicilina',
        ['dci:amoxicilina'],
        [
          { form: 'POWDER_FOR_ORAL_SUSPENSION', concentration: '250 mg/5 mL', label: 'Sólido oral (polvo)' }, // prettier-ignore
          { form: 'TABLET', forms: ['TABLET', 'CAPSULE'], concentration: '500 mg', label: 'Sólido oral', route: 'O - Oral' }, // prettier-ignore
        ],
      )
    ).id;
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

  async function cnmb(
    code: string,
    display: string,
    substances: string[],
    presentations: object[] = [],
  ) {
    const system = await prisma.catalogSystem.upsert({
      where: { code: 'CNMB' },
      create: { code: 'CNMB', name: 'CNMB', hierarchical: false },
      update: {},
    });
    return prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code,
        display,
        attributes: { substances, presentations },
        validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
      },
    });
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
    // PR-095. The receta prints the CIE diagnosis.
    await createDiagnosis(prisma, encounter.id, 'J02.9');
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

  const url = (id: string, path = '') => `/api/v1/encounters/${id}/assistant/prescription${path}`; // prettier-ignore
  const get = (id: string, token: string) =>
    request(app.getHttpServer()).get(url(id)).set('Authorization', `Bearer ${token}`); // prettier-ignore
  const post = (id: string, path: string, token: string, body: object = {}) =>
    request(app.getHttpServer()).post(url(id, path)).set('Authorization', `Bearer ${token}`).send(body); // prettier-ignore

  interface Line {
    id: string;
    quote: string;
    medicine: { conceptId: string; code: string; display: string } | null;
    fields: Record<string, unknown>;
    unsaid: string[];
    allergy: string | null;
    block: string | null;
    status: string;
    prescriptionId: string | null;
    demo: boolean;
  }
  interface Problem {
    code: string;
    errors?: { field: string }[];
  }

  async function readLines(): Promise<Line[]> {
    const response = await post(encounterId, '/read', doctor.token).expect(200);
    return (response.body as { lines: Line[] }).lines;
  }

  async function allergyTo(conceptId: string) {
    return prisma.patientAllergy.create({
      data: { patientId, substanceConceptId: conceptId, substanceText: 'Amoxicilina', criticality: 'HIGH', recordedById: doctor.userId }, // prettier-ignore
    });
  }

  it('AS-076 asks for assistant:use, which the doctor carries and the nurse does not', async () => {
    await request(app.getHttpServer()).get(url(encounterId)).expect(401);
    await get(encounterId, nurseToken).expect(403);
    // Control: the doctor of the seed gets in by the same route.
    await get(encounterId, doctor.token).expect(200);
  });

  it('AS-063 AS-064 AS-065 AS-067 AS-072 reads the note: the cuadro’s amoxicillin, 21 tablets marked, and a line outside the cuadro with its sentence only', async () => {
    const lines = await readLines();

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      quote: 'Ana: amoxicilina 500 mg, una tableta cada 8 horas por 7 días.',
      medicine: { conceptId: amoxicillinId, code: 'J01CA04', display: 'Amoxicilina' }, // prettier-ignore
      fields: { form: 'TABLET', concentration: '500 mg', route: 'ORAL', doseAmount: 1, doseUnit: 'TABLET', frequency: 'EVERY_8_HOURS', durationDays: 7, quantity: 21 }, // prettier-ignore
      unsaid: ['route', 'quantity'],
      allergy: 'none',
      block: null,
      status: 'PROPOSED',
      demo: true,
    });
    expect(lines[1]).toMatchObject({ medicine: null, block: 'not-in-cnmb' });
    expect(JSON.stringify(lines[1])).not.toMatch(
      /jarabe de miel con lim[oó]n"/i,
    ); // no name of the model's, only the sentence
    // AS-072. Kept with the attempt that read them, in this attention.
    const kept = await prisma.aiSuggestion.findMany({ where: { encounterId }, include: { aiRun: true } }); // prettier-ignore
    expect(
      kept.map((each) => [
        each.kind,
        each.status,
        each.aiRun.purpose,
        each.aiRun.provider,
      ]),
    ).toEqual([
      // prettier-ignore
      ['prescription-item', 'PROPOSED', 'prescription-lines', 'fake'],
      ['prescription-item', 'PROPOSED', 'prescription-lines', 'fake'],
    ]);
    // AS-078. The note left for a provider: its EXPORT is in the trail.
    expect(await prisma.accessAudit.count({ where: { resourceType: 'assistant_prescription_reading', resourceId: encounterId, action: 'EXPORT' } })).toBe(1); // prettier-ignore
  });

  it('AS-070 with the allergies unreadable it proposes nothing and calls no model, and the same reading works once they are', async () => {
    allergyReader.down = true;
    const refused = await post(encounterId, '/read', doctor.token).expect(503);

    expect((refused.body as Problem).code).toBe(
      'ASSISTANT_ALLERGY_CHECK_FAILED',
    );
    expect(await prisma.aiRun.count()).toBe(0);
    expect(await prisma.aiSuggestion.count()).toBe(0);

    // Control: the reader back, the same request proposes.
    allergyReader.down = false;
    expect(await readLines()).toHaveLength(2);
  });

  it('AS-069 AS-070 AS-071 shown with an exact allergy recorded after the reading, the line says so; unreadable, it says «failed», never «none»', async () => {
    const [line] = await readLines();
    const allergy = await allergyTo(amoxicillinId);

    const shown = (await get(encounterId, doctor.token).expect(200)).body as { lines: Line[]; allergies: { checked: boolean } }; // prettier-ignore
    expect(shown.lines[0]).toMatchObject({ id: line!.id, allergy: 'exact', block: 'allergy-exact' }); // prettier-ignore

    allergyReader.down = true;
    const blind = (await get(encounterId, doctor.token).expect(200)).body as { lines: Line[]; allergies: { checked: boolean } }; // prettier-ignore
    expect(blind.allergies.checked).toBe(false);
    expect(blind.lines[0]).toMatchObject({ allergy: 'failed', block: 'allergy-check-failed' }); // prettier-ignore

    // Control: the allergy refuted (PR-063) and the reader back, the line goes.
    allergyReader.down = false;
    await prisma.patientAllergy.update({ where: { id: allergy.id }, data: { refutedAt: new Date(), refutedById: doctor.userId, changedById: doctor.userId, changedAt: new Date() } }); // prettier-ignore
    const clear = (await get(encounterId, doctor.token).expect(200)).body as { lines: Line[] }; // prettier-ignore
    expect(clear.lines[0]).toMatchObject({ allergy: 'none', block: null });
  });

  it('AS-073 «Confirmar» refuses an exact allergy (409) and an unreadable chart (503) by line, and writes nothing either way', async () => {
    const [line, outside] = await readLines();
    const allergy = await allergyTo(amoxicillinId);

    const allergic = await post(encounterId, '/confirm', doctor.token, { suggestionIds: [line!.id] }).expect(409); // prettier-ignore
    expect((allergic.body as Problem).code).toBe(
      'ASSISTANT_ALLERGY_CONTRAINDICATION',
    );
    expect((allergic.body as Problem).errors?.map((each) => each.field)).toEqual([`suggestions.${line!.id}`]); // prettier-ignore
    expect(JSON.stringify(allergic.body)).not.toMatch(/amoxicilina/i);

    allergyReader.down = true;
    const blind = await post(encounterId, '/confirm', doctor.token, { suggestionIds: [line!.id] }).expect(503); // prettier-ignore
    expect((blind.body as Problem).code).toBe('ASSISTANT_ALLERGY_CHECK_FAILED');
    allergyReader.down = false;

    const notReady = await post(encounterId, '/confirm', doctor.token, { suggestionIds: [outside!.id] }).expect(422); // prettier-ignore
    expect((notReady.body as Problem).code).toBe(
      'ASSISTANT_PRESCRIPTION_LINE_NOT_READY',
    );

    // Control: refuted, the same line is confirmed — and still nothing is written.
    await prisma.patientAllergy.update({ where: { id: allergy.id }, data: { refutedAt: new Date(), refutedById: doctor.userId, changedById: doctor.userId, changedAt: new Date() } }); // prettier-ignore
    const confirmed = await post(encounterId, '/confirm', doctor.token, { suggestionIds: [line!.id] }).expect(200); // prettier-ignore
    expect((confirmed.body as { items: object[] }).items).toEqual([
      expect.objectContaining({ suggestionId: line!.id, conceptId: amoxicillinId, dosageForm: 'TABLET', routeCode: 'ORAL', quantity: 21 }), // prettier-ignore
    ]);
    expect(await prisma.prescription.count()).toBe(0);
    expect(await prisma.aiSuggestion.count({ where: { status: 'PROPOSED' } })).toBe(2); // prettier-ignore
  });

  it('AS-073 AS-074 the screen writes the draft by its own route and links it: the same line is «tal cual», a changed one «con cambios»; nothing is issued', async () => {
    const [line] = await readLines();
    const [item] = ((await post(encounterId, '/confirm', doctor.token, { suggestionIds: [line!.id] }).expect(200)).body as { items: Record<string, unknown>[] }).items; // prettier-ignore
    // What the screen sends: the codes, without the proposal's id nor the
    // empty texts the receta's schema refuses.
    const codes = Object.fromEntries(
      Object.entries(item!).filter(
        ([key, value]) => key !== 'suggestionId' && value !== null,
      ),
    );

    // PR-001. The receta's own route, as the screen does it.
    const composed = await request(app.getHttpServer())
      .post(`/api/v1/encounters/${encounterId}/prescriptions`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ items: [codes, { ...codes, doseAmount: 2, quantity: 42 }] })
      .expect(201);
    const prescriptionId = (composed.body as { prescription: { id: string } }).prescription.id; // prettier-ignore

    const linked = await post(encounterId, '/link', doctor.token, { prescriptionId, lines: [{ suggestionId: line!.id, line: 1 }] }).expect(200); // prettier-ignore
    expect((linked.body as { lines: Line[] }).lines[0]).toMatchObject({ status: 'ACCEPTED', prescriptionId }); // prettier-ignore
    const kept = await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: line!.id } }); // prettier-ignore
    expect([kept.status, Number(kept.distance), kept.prescriptionId]).toEqual(['ACCEPTED', 0, prescriptionId]); // prettier-ignore
    expect((await prisma.prescription.findUniqueOrThrow({ where: { id: prescriptionId } })).status).toBe('DRAFT'); // prettier-ignore

    // A second reading, linked to the changed line: «con cambios», distance > 0.
    const [again] = await readLines();
    await prisma.prescription.update({ where: { id: prescriptionId }, data: { status: 'DISCARDED', discardedAt: new Date(), discardedById: doctor.userId } }); // prettier-ignore
    const other = await request(app.getHttpServer())
      .post(`/api/v1/encounters/${encounterId}/prescriptions`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ items: [{ ...codes, doseAmount: 2, quantity: 42 }] })
      .expect(201);
    const otherId = (other.body as { prescription: { id: string } }).prescription.id; // prettier-ignore
    await post(encounterId, '/link', doctor.token, { prescriptionId: otherId, lines: [{ suggestionId: again!.id, line: 1 }] }).expect(200); // prettier-ignore
    const changed = await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: again!.id } }); // prettier-ignore
    expect(changed.status).toBe('ACCEPTED_WITH_CHANGES');
    expect(Number(changed.distance)).toBeGreaterThan(0);
  });

  it('AS-074 a receta of another attention, or a line it does not have, is not linked', async () => {
    const [line] = await readLines();
    const otherEncounter = await attentionWithNote(doctor.practitionerId);
    const foreign = await prisma.prescription.create({
      data: { encounterId: otherEncounter.id, siteId, prescriberId: doctor.practitionerId }, // prettier-ignore
    });

    const refused = await post(encounterId, '/link', doctor.token, { prescriptionId: foreign.id, lines: [{ suggestionId: line!.id, line: 1 }] }).expect(422); // prettier-ignore
    expect((refused.body as Problem).code).toBe(
      'SUGGESTION_PRESCRIPTION_MISMATCH',
    );
    expect((await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: line!.id } })).status).toBe('PROPOSED'); // prettier-ignore
  });

  it('AS-071 PR-060 a draft written by hand with the allergic medicine is still refused at the issue', async () => {
    await allergyTo(amoxicillinId);
    const composed = await request(app.getHttpServer())
      .post(`/api/v1/encounters/${encounterId}/prescriptions`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({
        warningSigns: 'Fiebre que no cede',
        nonPharmacologicalAdvice: 'Líquidos abundantes',
        items: [{ conceptId: amoxicillinId, dosageForm: 'TABLET', concentration: '500 mg', routeCode: 'ORAL', quantity: 21, doseAmount: 1, doseUnit: 'TABLET', frequency: 'EVERY_8_HOURS', durationDays: 7 }], // prettier-ignore
      })
      .expect(201);
    const prescriptionId = (composed.body as { prescription: { id: string } }).prescription.id; // prettier-ignore
    const issuePath = `/prescriptions/${prescriptionId}/issue`;

    const refused = await withReadRevision(prisma, issuePath, request(app.getHttpServer()).post(`/api/v1${issuePath}`).set('Authorization', `Bearer ${doctor.token}`).send({})).expect(409); // prettier-ignore
    expect((refused.body as Problem).code).toBe('ALLERGY_CONTRAINDICATION');
    expect((await prisma.prescription.findUniqueOrThrow({ where: { id: prescriptionId } })).status).toBe('DRAFT'); // prettier-ignore
  });

  it('AS-075 AS-076 only the attention’s own doctor reads, confirms or discards; the discarded line is not shown again', async () => {
    const [line] = await readLines();

    const other = await post(encounterId, '/read', secondDoctor.token).expect(403); // prettier-ignore
    expect((other.body as Problem).code).toBe('ASSISTANT_NOT_ENCOUNTER_OWNER');
    await post(encounterId, `/${line!.id}/discard`, secondDoctor.token).expect(403); // prettier-ignore

    const after = await post(encounterId, `/${line!.id}/discard`, doctor.token).expect(200); // prettier-ignore
    expect((after.body as { lines: Line[] }).lines.map((each) => each.id)).not.toContain(line!.id); // prettier-ignore
    expect((await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: line!.id } })).status).toBe('DISCARDED'); // prettier-ignore
  });

  it('AS-063 an empty note is refused with nothing called', async () => {
    const empty = await attentionWithNote(doctor.practitionerId, {});
    const refused = await post(empty.id, '/read', doctor.token).expect(422);

    expect((refused.body as Problem).code).toBe('ASSISTANT_NOTE_EMPTY');
    expect(await prisma.aiRun.count()).toBe(0);
  });

  it('AS-076 an attention of another site is one that does not exist, and a closed one admits nothing new', async () => {
    const elsewhere = (await createSite(prisma, 'Sede Sur')).id;
    const other = await createEncounter(prisma, { siteId: elsewhere, practitionerId: doctor.practitionerId, patientId }); // prettier-ignore
    const absent = await post(other.id, '/read', doctor.token).expect(404);
    expect((absent.body as Problem).code).toBe('ASSISTANT_ENCOUNTER_NOT_FOUND');
    await get(other.id, doctor.token).expect(404);

    // Control: in its own site the same request reads.
    const [line] = await readLines();
    await prisma.$executeRaw`UPDATE encounter SET status = 'DISCHARGED', ended_at = ${new Date()}, "dischargeCondition" = 'ALIVE' WHERE id = ${encounterId}::uuid`; // prettier-ignore
    for (const [path, body] of [
      ['/read', {}],
      ['/confirm', { suggestionIds: [line!.id] }],
      [`/${line!.id}/discard`, {}],
    ] as const) {
      // prettier-ignore
      const closed = await post(encounterId, path, doctor.token, body).expect(409);
      expect((closed.body as Problem).code).toBe('ASSISTANT_ENCOUNTER_CLOSED');
    }
    expect(await prisma.aiSuggestion.count({ where: { status: 'PROPOSED' } })).toBe(2); // prettier-ignore
  });

  it('AS-076 another doctor neither confirms nor links, and nothing is decided', async () => {
    const [line] = await readLines();
    const draft = await prisma.prescription.create({ data: { encounterId, siteId, prescriberId: doctor.practitionerId } }); // prettier-ignore

    const confirm = await post(encounterId, '/confirm', secondDoctor.token, { suggestionIds: [line!.id] }).expect(403); // prettier-ignore
    expect((confirm.body as Problem).code).toBe(
      'ASSISTANT_NOT_ENCOUNTER_OWNER',
    );
    await post(encounterId, '/link', secondDoctor.token, { prescriptionId: draft.id, lines: [{ suggestionId: line!.id, line: 1 }] }).expect(403); // prettier-ignore
    expect((await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: line!.id } })).status).toBe('PROPOSED'); // prettier-ignore
  });

  it('AS-065 PR-070 a controlled medicine is proposed with its reason and cannot be confirmed', async () => {
    await prisma.catalogConcept.update({ where: { id: amoxicillinId }, data: { attributes: { substances: ['dci:amoxicilina'], controlled: true, presentations: [{ form: 'TABLET', forms: ['TABLET'], concentration: '500 mg', label: 'Sólido oral', route: 'O - Oral' }] } } }); // prettier-ignore
    const [line] = await readLines();

    expect(line).toMatchObject({ block: 'controlled' });
    const refused = await post(encounterId, '/confirm', doctor.token, { suggestionIds: [line!.id] }).expect(422); // prettier-ignore
    expect((refused.body as Problem).code).toBe(
      'ASSISTANT_PRESCRIPTION_LINE_NOT_READY',
    );
  });

  it('AS-074 a link that cannot be made leaves none made: a repeated line, or a line of another medicine', async () => {
    const [line] = await readLines();
    const paracetamol = await cnmb('N02BE01', 'Paracetamol', [
      'dci:paracetamol',
    ]);
    const draft = await prisma.prescription.create({
      data: {
        encounterId,
        siteId,
        prescriberId: doctor.practitionerId,
        items: { create: [{ conceptId: amoxicillinId, genericName: 'Amoxicilina', presentation: 'Tableta', concentration: '500 mg', dosageFormCode: 'TABLET', doseAmount: 1, doseUnitCode: 'TABLET', doseText: '1 tableta', routeCode: 'ORAL', frequencyCode: 'EVERY_8_HOURS', frequencyText: 'Cada 8 horas', durationDays: 7, quantity: 21 }, { conceptId: paracetamol.id, genericName: 'Paracetamol', presentation: 'Tableta', concentration: '500 mg', dosageFormCode: 'TABLET', doseAmount: 1, doseUnitCode: 'TABLET', doseText: '1 tableta', routeCode: 'ORAL', frequencyCode: 'EVERY_8_HOURS', frequencyText: 'Cada 8 horas', durationDays: 3, quantity: 9 }] }, // prettier-ignore
      },
    });

    const repeated = await post(encounterId, '/link', doctor.token, { prescriptionId: draft.id, lines: [{ suggestionId: line!.id, line: 1 }, { suggestionId: line!.id, line: 2 }] }).expect(422); // prettier-ignore
    expect((repeated.body as Problem).code).toBe('SUGGESTION_INVALID');
    const other = await post(encounterId, '/link', doctor.token, { prescriptionId: draft.id, lines: [{ suggestionId: line!.id, line: 2 }] }).expect(422); // prettier-ignore
    expect((other.body as Problem).code).toBe(
      'SUGGESTION_PRESCRIPTION_MISMATCH',
    );
    expect((await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: line!.id } })).status).toBe('PROPOSED'); // prettier-ignore

    // Control: its own medicine's line links.
    await post(encounterId, '/link', doctor.token, { prescriptionId: draft.id, lines: [{ suggestionId: line!.id, line: 1 }] }).expect(200); // prettier-ignore
  });
});
