import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  instruction,
  type PseudonymizedText,
} from '../../src/modules/assistant/application/llm-client.port';
import { RoutingLlmClient } from '../../src/modules/assistant/application/routing-llm.client';
import { AssistantSpendingCeilingReachedError } from '../../src/modules/assistant/domain/assistant.errors';
import { spendingMonthStart } from '../../src/modules/assistant/domain/spending';
import { FakeLlmProvider } from '../../src/modules/assistant/infrastructure/fake-llm.provider';
import { LLM_PRICES } from '../../src/modules/assistant/infrastructure/llm-pricing';
import {
  GEMINI_MODELS,
  ANTHROPIC_MODELS,
} from '../../src/modules/assistant/infrastructure/model-routing';
import { PrismaAiRunStore } from '../../src/modules/assistant/infrastructure/prisma-ai-run.store';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * AS-007, AS-011, AS-012, AS-014, AS-015, AS-017 against PostgreSQL: the
 * routing over the real store, the constraints of `ai_run`, the purge of
 * `ai_exchange` and the month's spending. Fake providers only (D-239 §1): no
 * call leaves the machine.
 */
const db = useDatabase();

const SYSTEM = instruction`Redacta la nota`;
const PROMPT = 'Persona_1 refiere disnea de esfuerzo desde hace una semana';
const RAW = '{"summary":"Disnea de esfuerzo"}';
const answer = z.object({ summary: z.string() });
const DAY_MS = 86_400_000;

const storeOf = (prisma: PrismaClient) =>
  new PrismaAiRunStore(prisma as unknown as PrismaService);

function routing(
  prisma: PrismaClient,
  providers: FakeLlmProvider[],
  options: { exchangeLog?: boolean; ceilingUsd?: number } = {},
) {
  return new RoutingLlmClient({
    providers,
    store: storeOf(prisma),
    prices: LLM_PRICES,
    ceilingUsd: options.ceilingUsd ?? 50,
    timeoutMs: 5_000,
    exchangeLog: options.exchangeLog ?? false,
    clock: () => new Date(),
    newRequestId: randomUUID,
  });
}

/** Fakes that carry the real names and models, so the real price table applies. */
const gemini = (reply: ConstructorParameters<typeof FakeLlmProvider>[0]) =>
  new FakeLlmProvider(reply, 'gemini', GEMINI_MODELS);
const anthropic = (reply: ConstructorParameters<typeof FakeLlmProvider>[0]) =>
  new FakeLlmProvider(reply, 'anthropic', ANTHROPIC_MODELS);

const request = (encounterId?: string) => ({
  tier: 'quality' as const,
  purpose: 'draft',
  promptVersion: 'draft-v1',
  system: SYSTEM,
  prompt: PROMPT as PseudonymizedText,
  answer,
  maxTokens: 1_000,
  encounterId,
});

/** A valid row of `ai_run`, to be broken one column at a time. */
const aRun = (overrides: Record<string, unknown> = {}) => ({
  requestId: randomUUID(),
  attempt: 1,
  provider: 'gemini',
  model: GEMINI_MODELS.quality,
  tier: 'quality',
  purpose: 'draft',
  promptVersion: 'v1',
  outcome: 'ok',
  httpStatus: 200,
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.001,
  worstCaseUsd: 0.01,
  priceValidFrom: new Date(),
  latencyMs: 30,
  startedAt: new Date(),
  fallbackFrom: null,
  ...overrides,
});

async function anEncounter(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  return { encounterId: encounter.id, practitionerId: practitioner.id };
}

async function signNote(
  prisma: PrismaClient,
  ids: { encounterId: string; practitionerId: string },
  signedAt: Date,
) {
  const id = randomUUID();
  await prisma.clinicalNote.create({
    data: {
      id,
      chainId: id,
      encounterId: ids.encounterId,
      formCode: '002',
      formVersion: '1',
      content: { motivoConsulta: 'Control' },
      authorId: ids.practitionerId,
      status: 'SIGNED',
      signedAt,
      signedById: ids.practitionerId,
      contentHash: 'a'.repeat(64),
    },
  });
}

describe('ai_run and ai_exchange (assistant)', () => {
  it('AS-007 AS-011 with the principal answering 503, the fallback answers and ai_run keeps both attempts without text', async () => {
    const prisma = db();

    const result = await routing(prisma, [
      gemini([{ kind: 'status', status: 503 }]),
      anthropic([{ kind: 'answer', text: RAW }]),
    ]).generate(request());

    expect(result.provider).toBe('anthropic');
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT row_to_json(r)::text AS line, r.attempt, r.provider, r.outcome,
             r.fallback_from, r.http_status, r.request_id::text AS request_id,
             r.cost_usd::text AS cost_usd
      FROM ai_run r ORDER BY r.attempt`;
    expect(rows).toMatchObject([
      { attempt: 1, provider: 'gemini', outcome: 'provider-error', fallback_from: null, http_status: 503 }, // prettier-ignore
      { attempt: 2, provider: 'anthropic', outcome: 'ok', fallback_from: 'provider-error', request_id: result.requestId }, // prettier-ignore
    ]);
    expect(rows[0]!.request_id).toBe(result.requestId);
    // AS-017 (D-241 §9): the rejected attempt is kept at 0; the answered one at its cost.
    expect(Number(rows[0]!.cost_usd)).toBe(0);
    expect(Number(rows[1]!.cost_usd)).toBeGreaterThan(0);
    for (const { line } of rows) {
      for (const text of [PROMPT, SYSTEM, RAW]) {
        expect(line).not.toContain(text);
      }
    }
    // AS-014: with the exchange log off, no text anywhere.
    expect(await prisma.aiExchange.count()).toBe(0);
  });

  it('AS-014 with the exchange log on, keeps the pseudonymized text beside its attempt', async () => {
    const prisma = db();

    await routing(prisma, [gemini([{ kind: 'answer', text: RAW }])], {
      exchangeLog: true,
    }).generate(request());

    const [run] = await prisma.aiRun.findMany({ include: { exchange: true } });
    expect(run?.exchange).toMatchObject({ system: SYSTEM, prompt: PROMPT, raw: RAW }); // prettier-ignore
  });

  it('AS-012 refuses a row of ai_run that breaks its lists or its numbers', async () => {
    const prisma = db();
    // Positive control: the valid row, and a valid fallback, go in.
    await prisma.aiRun.create({ data: aRun() });
    await prisma.aiRun.create({ data: aRun({ attempt: 2, fallbackFrom: 'rate-limited' }) }); // prettier-ignore

    const broken: [string, Record<string, unknown>][] = [
      ['ai_run_outcome_known', { outcome: 'maybe' }],
      ['ai_run_tier_known', { tier: 'slow' }],
      ['ai_run_provider_known', { provider: 'fake' }],
      ['ai_run_attempt_positive', { attempt: 0 }],
      ['ai_run_figures_not_negative', { inputTokens: -1 }],
      ['ai_run_figures_not_negative', { costUsd: -0.01 }],
      ['ai_run_http_status_valid', { httpStatus: 42 }],
      ['ai_run_fallback_matches_attempt', { fallbackFrom: 'timeout' }],
      ['ai_run_fallback_matches_attempt', { attempt: 2 }],
      ['ai_run_fallback_matches_attempt', { attempt: 2, fallbackFrom: 'invalid-answer' }], // prettier-ignore
    ];
    for (const [constraint, overrides] of broken) {
      await expect(
        prisma.aiRun.create({ data: aRun(overrides) }),
        constraint,
      ).rejects.toThrow(constraint);
    }
  });

  it('AS-015 purges the text 45 days after the first signature, after the attempt for later text or no encounter, and at 90 days whatever happens', async () => {
    const prisma = db();
    const now = new Date();
    const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const signedLongAgo = await anEncounter(prisma);
    await signNote(prisma, signedLongAgo, daysAgo(46));
    const amended = await anEncounter(prisma);
    await signNote(prisma, amended, daysAgo(60));
    const signedRecently = await anEncounter(prisma);
    await signNote(prisma, signedRecently, daysAgo(44));
    const unsigned = await anEncounter(prisma);

    const withText = (
      startedAt: Date,
      encounterId: string | null,
      label: string,
    ) =>
      // prettier-ignore
      prisma.aiRun.create({
        data: {
          ...aRun({ startedAt, purpose: label }),
          encounterId,
          exchange: { create: { system: SYSTEM, prompt: PROMPT, raw: RAW } },
        },
      });
    await withText(daysAgo(50), signedLongAgo.encounterId, 'signed-long-ago');
    // The first signature (60 days ago) starts the clock for what came before it…
    await withText(daysAgo(61), amended.encounterId, 'amended-before');
    // …and text written after it (for an amendment) counts from its own attempt.
    await withText(daysAgo(12), amended.encounterId, 'amended-after');
    await withText(daysAgo(50), signedRecently.encounterId, 'signed-recently');
    await withText(daysAgo(46), unsigned.encounterId, 'unsigned-46');
    await withText(daysAgo(91), unsigned.encounterId, 'unsigned-91');
    await withText(daysAgo(46), null, 'no-encounter-46');
    await withText(daysAgo(44), null, 'no-encounter-44');

    const purged = await storeOf(prisma).purgeExchanges(now);

    const kept = await prisma.aiRun.findMany({
      where: { exchange: { isNot: null } },
      select: { purpose: true },
      orderBy: { purpose: 'asc' },
    });
    expect(kept.map((run) => run.purpose)).toEqual([
      'amended-after',
      'no-encounter-44',
      'signed-recently',
      'unsigned-46',
    ]);
    expect(purged).toBe(4);
    // The rows of ai_run stay: only the text goes.
    expect(await prisma.aiRun.count()).toBe(8);
  });

  it('AS-017 counts the month in Guayaquil, an unknown cost at its worst case', async () => {
    const prisma = db();
    const monthStart = spendingMonthStart(new Date());
    await prisma.aiRun.create({ data: aRun({ startedAt: new Date(monthStart.getTime() - 1), costUsd: 7 }) }); // prettier-ignore
    await prisma.aiRun.create({ data: aRun({ startedAt: monthStart, costUsd: 0.25 }) }); // prettier-ignore
    await prisma.aiRun.create({ data: aRun({ startedAt: monthStart, costUsd: null, worstCaseUsd: 0.5, outcome: 'timeout', httpStatus: null }) }); // prettier-ignore

    expect(await storeOf(prisma).spentSince(monthStart)).toBeCloseTo(0.75, 8);
  });

  it('AS-017 the ceiling cuts the call that would pass it, and lets through the one that fits', async () => {
    const prisma = db();
    const monthStart = spendingMonthStart(new Date());
    await prisma.aiRun.create({ data: aRun({ startedAt: monthStart, costUsd: 0.998 }) }); // prettier-ignore
    const provider = gemini([{ kind: 'answer', text: RAW }]);

    // Positive control: with room, the call is made.
    await routing(prisma, [provider], { ceilingUsd: 1.5 }).generate(request());
    await expect(
      routing(prisma, [provider], { ceilingUsd: 1 }).generate(request()),
    ).rejects.toBeInstanceOf(AssistantSpendingCeilingReachedError);
    expect(provider.calls).toHaveLength(1);
  });
});
