import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  SCENE_TEXTS,
  assistantQualityScene,
} from '../../prisma/seed-assistant-quality.mts';
import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { ASSISTANT_ENABLED } from '../../src/modules/assistant/assistant-diagnosis.controller';
import {
  weekBounds,
  weekOf,
} from '../../src/modules/assistant/domain/assistant-quality';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { addDays, clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createEncounter, createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * E19 (AS-345 to AS-353) — «Calidad del asistente» against a real
 * PostgreSQL 18 and real sessions.
 *
 * THE ORACLE IS THE TABLE. Every figure the board answers is recomputed here
 * from `ai_run` and `ai_suggestion` read with Prisma —sums, medians and
 * counts in TypeScript— and compared: «cifras iguales a `ai_run`» (E2).
 *
 * THE SCENE. This week, at the doctor's site: one attention with the shared
 * scene (six attempts, fourteen proposals in the four states, three in amber,
 * four reviews) and one without the assistant. At another site: one attention
 * with the scene, of another doctor. CONTROL POSITIVO in every exclusion: the
 * administrator granted at clinic level sees the other site's through the
 * same route.
 */
const PASSWORD = 'el caballo come alfalfa';
const MINUTE = 60_000;

/** The clock of the test: every instant derives from it. */
const NOW = new Date();
const { weekStart } = weekOf(clinicalDateOf(NOW));
const { startsAt } = weekBounds(weekStart);
/** Inside this week and in the past, whatever day and hour the test runs. */
const IN_WEEK = new Date(
  Math.max(startsAt.getTime() + MINUTE, NOW.getTime() - 3 * MINUTE),
);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

describe('la calidad del asistente por HTTP (E19)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let otherSiteId: string;
  let doctor: { token: string; practitionerId: string; userId: string };
  let otherDoctor: { token: string; practitionerId: string; userId: string };
  let siteAdmin: string;
  let clinicAdmin: string;
  let reception: string;
  let assisted: string;
  let foreign: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();
    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // E19: the board reads what was registered; the switch does not apply.
        .overrideProvider(ASSISTANT_ENABLED)
        .useValue(false)
        .overrideProvider(ThrottlerStorage)
        .useValue({
          increment: () =>
            Promise.resolve({ totalHits: 1, timeToExpire: 1, isBlocked: false, timeToBlockExpire: 0 }), // prettier-ignore
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
    siteId = (await createSite(prisma)).id;
    otherSiteId = (await createSite(prisma, 'Sede Sur')).id;

    doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065', siteId);
    otherDoctor = await signIn('MEDICO', 'medica@clinica.ec', '0926687856', otherSiteId); // prettier-ignore
    siteAdmin = (await signIn('ADMIN', 'admin@clinica.ec', '1713175071', siteId)).token; // prettier-ignore
    clinicAdmin = (await signIn('ADMIN', 'direccion@clinica.ec', '0102030400', null)).token; // prettier-ignore
    reception = (await signIn('RECEPCION', 'recepcion@clinica.ec', '1104680135', siteId)).token; // prettier-ignore

    const attention = async (site: string, practitionerId: string) =>
      (
        await createEncounter(prisma, {
          siteId: site,
          practitionerId,
          patientId: (await createPatient(prisma)).id,
          startedAt: IN_WEEK,
        })
      ).id;
    assisted = await attention(siteId, doctor.practitionerId);
    await attention(siteId, doctor.practitionerId); // without the assistant
    foreign = await attention(otherSiteId, otherDoctor.practitionerId);
    for (const [encounterId, who] of [
      [assisted, doctor],
      [foreign, otherDoctor],
    ] as const) {
      await assistantQualityScene(prisma, {
        encounterId,
        practitionerId: who.practitionerId,
        deciderUserId: who.userId,
        startedAt: IN_WEEK,
      });
    }
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(
    roleCode: string,
    email: string,
    cedula: string,
    grantSiteId: string | null,
  ) {
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
    const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } }); // prettier-ignore
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId: grantSiteId },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      token: (response.body as { accessToken: string }).accessToken,
      practitionerId: practitioner.id,
      userId: user.id,
    };
  }

  const get = (path: string, token: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/assistant-quality${path}`)
      .set('Authorization', `Bearer ${token}`);

  /** The oracle: one attention's attempts and proposals, summed here. */
  async function expectedOf(encounterIds: string[]) {
    const runs = await prisma.aiRun.findMany({ where: { encounterId: { in: encounterIds } } }); // prettier-ignore
    const suggestions = await prisma.aiSuggestion.findMany({
      where: { encounterId: { in: encounterIds } },
      include: { review: true },
    });
    const sum = (pick: (run: (typeof runs)[number]) => number | null) =>
      runs.reduce((total, run) => total + (pick(run) ?? 0), 0);
    const status = (value: string) => suggestions.filter((row) => row.status === value).length; // prettier-ignore
    const amber = suggestions.filter((row) => {
      const proposal = row.proposal as { phrases?: { unsaid: boolean }[]; unsaid?: string[] }; // prettier-ignore
      if (row.kind === 'note-section') return proposal.phrases?.some((phrase) => phrase.unsaid) ?? false; // prettier-ignore
      if (row.kind === 'prescription-item') return (proposal.unsaid?.length ?? 0) > 0; // prettier-ignore
      return false;
    }).length;
    const distances = suggestions.flatMap((row) => (row.review ? [Number(row.review.distance)] : [])); // prettier-ignore
    return {
      runs,
      suggestions,
      attempts: runs.length,
      answered: runs.filter((run) => run.outcome === 'ok').length,
      inputTokens: sum((run) => run.inputTokens),
      outputTokens: sum((run) => run.outputTokens),
      cacheReadTokens: sum((run) => run.cacheReadTokens),
      cacheWriteTokens: sum((run) => run.cacheWriteTokens),
      cost: sum((run) => (run.costUsd === null ? null : Number(run.costUsd))),
      withoutCost: runs.filter((run) => run.costUsd === null).length,
      medianLatency: median(runs.map((run) => run.latencyMs)),
      proposals: suggestions.length,
      accepted: status('ACCEPTED'),
      edited: status('ACCEPTED_WITH_CHANGES'),
      discarded: status('DISCARDED'),
      untouched: status('PROPOSED'),
      amber,
      reviewed: distances.length,
      medianDistance: median(distances),
    };
  }

  it('AS-345 AS-346 AS-347 the breakdown of an attention is what ai_run and ai_suggestion hold', async () => {
    const expected = await expectedOf([assisted]);
    // The scene is not trivial: every state, amber and a cost nobody reported.
    expect(expected.amber).toBe(3);
    expect(expected.withoutCost).toBe(1);

    const response = await get(`/encounters/${assisted}`, doctor.token).expect(200); // prettier-ignore
    const body = response.body as {
      tasks: { purpose: string; attempts: number; answered: number; inputTokens: number; cacheReadTokens: number; costUsd: string; attemptsWithoutCost: number; medianLatencyMs: number | null; maxLatencyMs: number | null }[]; // prettier-ignore
      proposals: { kind: string; section: string | null; proposals: number; accepted: number; edited: number; discarded: number; untouched: number; amber: number; reviewed: number; medianDistance: number | null }[]; // prettier-ignore
      totals: { attempts: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: string; cacheRate: number | null; proposals: number }; // prettier-ignore
    };

    // AS-345. By task, each figure from its own rows.
    const purposes = [
      ...new Set(expected.runs.map((run) => run.purpose)),
    ].sort();
    expect(body.tasks.map((task) => task.purpose)).toEqual(purposes);
    for (const task of body.tasks) {
      const rows = expected.runs.filter((run) => run.purpose === task.purpose);
      expect(task.attempts).toBe(rows.length);
      expect(task.answered).toBe(
        rows.filter((run) => run.outcome === 'ok').length,
      );
      expect(task.inputTokens).toBe(rows.reduce((total, run) => total + (run.inputTokens ?? 0), 0)); // prettier-ignore
      expect(task.cacheReadTokens).toBe(rows.reduce((total, run) => total + (run.cacheReadTokens ?? 0), 0)); // prettier-ignore
      expect(Number(task.costUsd)).toBeCloseTo(rows.reduce((total, run) => total + Number(run.costUsd ?? 0), 0), 8); // prettier-ignore
      expect(task.attemptsWithoutCost).toBe(rows.filter((run) => run.costUsd === null).length); // prettier-ignore
      expect(task.medianLatencyMs).toBe(
        median(rows.map((run) => run.latencyMs)),
      );
      expect(task.maxLatencyMs).toBe(
        Math.max(...rows.map((run) => run.latencyMs)),
      );
    }
    expect(body.totals.attempts).toBe(expected.attempts);
    expect(body.totals.inputTokens).toBe(expected.inputTokens);
    expect(body.totals.outputTokens).toBe(expected.outputTokens);
    expect(body.totals.cacheReadTokens).toBe(expected.cacheReadTokens);
    expect(body.totals.cacheWriteTokens).toBe(expected.cacheWriteTokens);
    expect(Number(body.totals.costUsd)).toBeCloseTo(expected.cost, 8);
    expect(body.totals.cacheRate).toBe(
      Math.round((expected.cacheReadTokens / (expected.inputTokens + expected.cacheReadTokens + expected.cacheWriteTokens)) * 10_000) / 10_000, // prettier-ignore
    );

    // AS-346, AS-347. By class and section, summed back to the table.
    const total = (pick: (row: (typeof body.proposals)[number]) => number) =>
      body.proposals.reduce((sum, row) => sum + pick(row), 0);
    expect(total((row) => row.proposals)).toBe(expected.proposals);
    expect(total((row) => row.accepted)).toBe(expected.accepted);
    expect(total((row) => row.edited)).toBe(expected.edited);
    expect(total((row) => row.discarded)).toBe(expected.discarded);
    expect(total((row) => row.untouched)).toBe(expected.untouched);
    expect(total((row) => row.amber)).toBe(expected.amber);
    expect(total((row) => row.reviewed)).toBe(expected.reviewed);
    const sectionRows = body.proposals.filter(
      (row) => row.kind === 'note-section',
    );
    expect(sectionRows.map((row) => row.section).sort()).toEqual([
      'enfermedadActual',
      'examenFisico',
      'motivoConsulta',
      'planTratamiento',
    ]);
    // AS-347. A prescription line with an empty `unsaid` is not amber (control).
    const lines = body.proposals.find(
      (row) => row.kind === 'prescription-item',
    )!;
    expect([lines.proposals, lines.amber]).toEqual([2, 1]);
    expect(body.proposals.find((row) => row.kind === 'diagnosis')!.amber).toBe(
      0,
    );
  });

  it('AS-348 the week of a site is the sum of its attentions, with the adoption over all of them', async () => {
    const expected = await expectedOf([assisted]);
    const response = await get(`/week?date=${addDays(weekStart, 3)}&siteId=${siteId}`, siteAdmin).expect(200); // prettier-ignore
    const body = response.body as {
      weekStart: string;
      weekEnd: string;
      total: Record<string, number | string | null>;
      bySite: { siteId: string }[];
      encounters: {
        encounterId: string;
        attempts: number;
        proposals: number;
      }[];
    };
    expect([body.weekStart, body.weekEnd]).toEqual([weekStart, addDays(weekStart, 6)]); // prettier-ignore
    expect(body.bySite.map((row) => row.siteId)).toEqual([siteId]);
    expect(body.total).toMatchObject({
      encounters: 2,
      assisted: 1,
      adoption: 0.5,
      attempts: expected.attempts,
      answered: expected.answered,
      inputTokens: expected.inputTokens,
      cacheReadTokens: expected.cacheReadTokens,
      attemptsWithoutCost: expected.withoutCost,
      medianLatencyMs: expected.medianLatency,
      proposals: expected.proposals,
      accepted: expected.accepted,
      edited: expected.edited,
      discarded: expected.discarded,
      untouched: expected.untouched,
      amber: expected.amber,
      reviewed: expected.reviewed,
      medianDistance: expected.medianDistance,
      acceptance: Math.round(((expected.accepted + expected.edited) / expected.proposals) * 10_000) / 10_000, // prettier-ignore
    });
    expect(Number(body.total.costUsd)).toBeCloseTo(expected.cost, 8);
    expect(Number(body.total.costPerAssisted)).toBeCloseTo(expected.cost, 8);
    expect(
      body.encounters.map((row) => [
        row.encounterId,
        row.attempts,
        row.proposals,
      ]),
    ).toEqual([[assisted, expected.attempts, expected.proposals]]);
  });

  it('AS-350 AS-351 a site administrator sees only their sites; the clinic administrator sees both (control)', async () => {
    const own = await get(`/week?date=${weekStart}`, siteAdmin).expect(200);
    expect((own.body as { bySite: { siteId: string }[] }).bySite.map((row) => row.siteId)).toEqual([siteId]); // prettier-ignore
    const elsewhere = await get(`/week?date=${weekStart}&siteId=${otherSiteId}`, siteAdmin).expect(200); // prettier-ignore
    expect((elsewhere.body as { total: { encounters: number; adoption: number | null } }).total).toMatchObject({ encounters: 0, adoption: null }); // prettier-ignore
    await get(`/encounters/${foreign}`, siteAdmin).expect(404);

    const clinic = await get(`/week?date=${weekStart}`, clinicAdmin).expect(
      200,
    );
    const both = clinic.body as { total: { encounters: number; attempts: number }; bySite: { siteId: string }[] }; // prettier-ignore
    expect(both.bySite.map((row) => row.siteId).sort()).toEqual([siteId, otherSiteId].sort()); // prettier-ignore
    const expected = await expectedOf([assisted, foreign]);
    expect(both.total).toMatchObject({
      encounters: 3,
      attempts: expected.attempts,
    });
    await get(`/encounters/${foreign}`, clinicAdmin).expect(200);
  });

  it('AS-350 a doctor sees only the attentions they attended, the same 404 as one that does not exist', async () => {
    await get(`/encounters/${assisted}`, doctor.token).expect(200);
    const outside = await get(`/encounters/${foreign}`, doctor.token).expect(
      404,
    );
    expect((outside.body as { code: string }).code).toBe('ASSISTANT_ENCOUNTER_NOT_FOUND'); // prettier-ignore
    const missing = await get(`/encounters/${crypto.randomUUID()}`, doctor.token).expect(404); // prettier-ignore
    const same = (body: unknown) => {
      const { code, title, status } = body as Record<string, unknown>;
      return { code, title, status };
    };
    expect(same(missing.body)).toEqual(same(outside.body));
    // The other doctor sees theirs (control) and not this one.
    await get(`/encounters/${foreign}`, otherDoctor.token).expect(200);
    await get(`/encounters/${assisted}`, otherDoctor.token).expect(404);

    const week = await get(`/week?date=${weekStart}`, otherDoctor.token).expect(
      200,
    );
    const mine = week.body as { total: { encounters: number }; encounters: { encounterId: string }[] }; // prettier-ignore
    expect(mine.total.encounters).toBe(1);
    expect(mine.encounters.map((row) => row.encounterId)).toEqual([foreign]);
    // Without either permission, nothing (closed by default).
    await get(`/week?date=${weekStart}`, reception).expect(403);
  });

  it('AS-349 no answer of the board carries the text of a proposal, a note or the patient', async () => {
    const patient = await prisma.encounter.findUniqueOrThrow({ where: { id: assisted }, include: { patient: true } }); // prettier-ignore
    const answers = [
      await get(`/encounters/${assisted}`, doctor.token).expect(200),
      await get(`/week?date=${weekStart}`, siteAdmin).expect(200),
      await get(
        `/weeks.csv?from=${weekStart}&to=${weekStart}`,
        siteAdmin,
      ).expect(200),
    ].map((response) => response.text);
    // Control: the text IS in the table the board reads.
    const stored = JSON.stringify((await expectedOf([assisted])).suggestions.map((row) => row.proposal)); // prettier-ignore
    for (const text of SCENE_TEXTS) expect(stored).toContain(text);
    for (const answer of answers) {
      for (const text of SCENE_TEXTS) expect(answer).not.toContain(text);
      expect(answer).not.toContain(patient.patient.givenName);
      expect(answer).not.toContain(patient.patientId);
    }
  });

  it('AS-352 the CSV has one line per week and site, and only audit:read downloads it', async () => {
    const response = await get(`/weeks.csv?from=${addDays(weekStart, -7)}&to=${weekStart}`, clinicAdmin).expect(200); // prettier-ignore
    expect(response.headers['content-type']).toMatch(
      /^text\/csv; charset=utf-8/,
    );
    expect(response.headers['content-disposition']).toContain('attachment;');
    const lines = response.text.trimEnd().split('\r\n');
    expect(lines[0]!.startsWith('semana,sede,atenciones,con_asistente,adopcion')).toBe(true); // prettier-ignore
    // Last week had no attentions: no line; this week, one per site.
    expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual([weekStart, weekStart]); // prettier-ignore
    await get(`/weeks.csv?from=${weekStart}&to=${weekStart}`, doctor.token).expect(403); // prettier-ignore
  });

  it('AS-353 a malformed day or a backwards or too long range is refused naming the field', async () => {
    await get(`/week?date=${weekStart}`, siteAdmin).expect(200); // control
    const day = await get('/week?date=ayer', siteAdmin).expect(422);
    expect(JSON.stringify(day.body)).toContain('date');
    const backwards = await get(`/weeks.csv?from=${weekStart}&to=${addDays(weekStart, -1)}`, siteAdmin).expect(422); // prettier-ignore
    expect(JSON.stringify(backwards.body)).toContain('to');
    await get(`/weeks.csv?from=${addDays(weekStart, -52 * 7)}&to=${weekStart}`, siteAdmin).expect(200); // prettier-ignore
    await get(`/weeks.csv?from=${addDays(weekStart, -53 * 7)}&to=${weekStart}`, siteAdmin).expect(422); // prettier-ignore
  });
});
