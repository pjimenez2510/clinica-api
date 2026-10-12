import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { SuggestionService } from '../../src/modules/assistant/application/suggestion.service';
import { SuggestionOrderMismatchError } from '../../src/modules/assistant/domain/assistant.errors';
import { GEMINI_MODELS } from '../../src/modules/assistant/infrastructure/model-routing';
import { PrismaSuggestionStore } from '../../src/modules/assistant/infrastructure/prisma-suggestion.store';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * AS-109 against PostgreSQL: an accepted exam keeps WHICH candidate it was
 * chosen as, exactly on an accepted `order-item`, and one exam of an order
 * answers for one proposal. Every refusal has its positive control.
 */
const db = useDatabase();

async function anAttentionWithAnOrder(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  const order = await prisma.serviceOrder.create({
    data: {
      encounterId: encounter.id,
      siteId: site.id,
      orderedById: practitioner.id,
      category: 'LABORATORY',
      items: {
        create: [
          { testCode: 'LAB-BH', testDisplay: 'Biometría hemática completa' },
          { testCode: 'LAB-GLUCOSA-AYUNAS', testDisplay: 'Glucosa en ayunas' },
        ],
      },
    },
  });
  const run = await prisma.aiRun.create({
    data: {
      requestId: randomUUID(),
      attempt: 1,
      provider: 'gemini',
      model: GEMINI_MODELS.quality,
      tier: 'quality',
      purpose: 'order-exams',
      promptVersion: 'd3-exams-1',
      outcome: 'ok',
      worstCaseUsd: 0.01,
      priceValidFrom: new Date(),
      latencyMs: 30,
      startedAt: new Date(),
      encounterId: encounter.id,
    },
  });
  const user = await createUser(prisma);
  return { encounter, order, run, user };
}

/** Two lines of one sentence, with their candidates in common. */
async function twoProposals(
  prisma: PrismaClient,
  world: Awaited<ReturnType<typeof anAttentionWithAnOrder>>,
) {
  const service = new SuggestionService(
    new PrismaSuggestionStore(prisma as unknown as PrismaService),
    () => new Date(),
  );
  const codes = ['LAB-BH', 'LAB-GLUCOSA-AYUNAS'];
  const proposed = await service.propose(
    [0, 1].map(() => ({
      encounterId: world.encounter.id,
      aiRunId: world.run.id,
      kind: 'order-item' as const,
      proposal: { quote: 'Se pide biometría y glucosa.', codes, candidates: [] }, // prettier-ignore
      sources: [{ kind: 'transcript' as const, fromMs: 0, toMs: 1_000 }],
    })),
    { userId: world.user.id, sites: 'all' },
  );
  return { service, proposed };
}

describe('the exam an accepted proposal was chosen as (AS-109)', () => {
  it('AS-109 accepting keeps the chosen code; the same exam of the same order cannot answer for a second proposal (SUGGESTION_ORDER_MISMATCH), another exam can', async () => {
    const prisma = db();
    const world = await anAttentionWithAnOrder(prisma);
    const { service, proposed } = await twoProposals(prisma, world);
    const who = { userId: world.user.id, sites: 'all' as const };

    const first = await service.accept({ suggestionId: proposed[0]!.id, recordId: world.order.id, saved: 'LAB-BH' }, who); // prettier-ignore
    expect(first).toMatchObject({ status: 'ACCEPTED', distance: 0, acceptedCode: 'LAB-BH' }); // prettier-ignore

    await expect(
      service.accept({ suggestionId: proposed[1]!.id, recordId: world.order.id, saved: 'LAB-BH' }, who), // prettier-ignore
    ).rejects.toBeInstanceOf(SuggestionOrderMismatchError);
    const refused = await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: proposed[1]!.id } }); // prettier-ignore
    expect(refused.status).toBe('PROPOSED');

    // Positive control: the other exam of the same order answers for it.
    const second = await service.accept({ suggestionId: proposed[1]!.id, recordId: world.order.id, saved: 'LAB-GLUCOSA-AYUNAS' }, who); // prettier-ignore
    expect(second).toMatchObject({ status: 'ACCEPTED', acceptedCode: 'LAB-GLUCOSA-AYUNAS' }); // prettier-ignore
  });

  it('AS-109 the database refuses an accepted exam without its code, a code on anything else, and a code that is not a candidate on a live line of that order', async () => {
    const prisma = db();
    const world = await anAttentionWithAnOrder(prisma);
    const { proposed } = await twoProposals(prisma, world);
    const decided = { decidedBy: world.user.id, decidedAt: new Date() };

    await expect(
      prisma.aiSuggestion.update({
        where: { id: proposed[0]!.id },
        data: { status: 'ACCEPTED', distance: 0, serviceOrderId: world.order.id, ...decided }, // prettier-ignore
      }),
    ).rejects.toThrow(/ai_suggestion_accepted_code_of_an_accepted_exam/);
    await expect(
      prisma.aiSuggestion.update({
        where: { id: proposed[0]!.id },
        data: { status: 'DISCARDED', acceptedCode: 'LAB-BH', ...decided },
      }),
    ).rejects.toThrow(/ai_suggestion_accepted_code_of_an_accepted_exam/);

    // An exam that is not a candidate, or not a live line of the order.
    await expect(
      prisma.aiSuggestion.update({
        where: { id: proposed[0]!.id },
        data: { status: 'ACCEPTED', distance: 0, serviceOrderId: world.order.id, acceptedCode: 'LAB-EMO', ...decided }, // prettier-ignore
      }),
    ).rejects.toThrow(/ai_suggestion_accepted_code_of_its_order/);
    const other = await prisma.serviceOrder.create({
      data: { encounterId: world.encounter.id, siteId: world.order.siteId, orderedById: world.order.orderedById, category: 'LABORATORY', items: { create: [{ testCode: 'LAB-GLUCOSA-AYUNAS', testDisplay: 'Glucosa en ayunas' }] } }, // prettier-ignore
    });
    await expect(
      prisma.aiSuggestion.update({
        where: { id: proposed[0]!.id },
        data: { status: 'ACCEPTED', distance: 0, serviceOrderId: other.id, acceptedCode: 'LAB-BH', ...decided }, // prettier-ignore
      }),
    ).rejects.toThrow(/ai_suggestion_accepted_code_of_its_order/);

    // Positive control: the same acceptance with its code goes through.
    const accepted = await prisma.aiSuggestion.update({
      where: { id: proposed[0]!.id },
      data: { status: 'ACCEPTED', distance: 0, serviceOrderId: world.order.id, acceptedCode: 'LAB-BH', ...decided }, // prettier-ignore
    });
    expect(accepted.acceptedCode).toBe('LAB-BH');
  });
});
