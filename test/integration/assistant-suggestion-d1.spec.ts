import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { SuggestionService } from '../../src/modules/assistant/application/suggestion.service';
import { AssistantEncounterClosedError } from '../../src/modules/assistant/domain/assistant.errors';
import { GEMINI_MODELS } from '../../src/modules/assistant/infrastructure/model-routing';
import { PrismaSuggestionStore } from '../../src/modules/assistant/infrastructure/prisma-suggestion.store';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createDiagnosis,
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * What D1 asked of `ai_suggestion` (A1's table), against PostgreSQL: one
 * diagnosis answers one proposal (AS-037, D-245 §6), and nothing is proposed
 * on an attention that no longer takes new clinical content (AS-039), checked
 * under the attention's lock. Each refusal with its positive control.
 */
const db = useDatabase();

async function anAttention(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  const run = await prisma.aiRun.create({
    data: {
      requestId: randomUUID(),
      attempt: 1,
      provider: 'gemini',
      model: GEMINI_MODELS.quality,
      tier: 'quality',
      purpose: 'cie10-problems',
      promptVersion: 'v1',
      outcome: 'ok',
      worstCaseUsd: 0.01,
      priceValidFrom: new Date(),
      latencyMs: 30,
      startedAt: new Date(),
      encounterId: encounter.id,
    },
  });
  return { encounter, run };
}

const serviceOf = (prisma: PrismaClient) =>
  new SuggestionService(
    new PrismaSuggestionStore(prisma as unknown as PrismaService),
    () => new Date(),
  );

const proposal = (code: string) => ({
  problem: 'FARINGITIS AGUDA',
  quote: 'Refiere odinofagia de tres días.',
  section: 'enfermedadActual',
  codes: [code],
  candidates: [],
  demo: false,
});

describe('ai_suggestion for D1', () => {
  it('AS-037 a diagnosis answers one proposal: a second one linked to it is refused, a different one is not', async () => {
    const prisma = db();
    const { encounter, run } = await anAttention(prisma);
    const user = await createUser(prisma);
    const service = serviceOf(prisma);
    const as = { userId: user.id, sites: 'all' as const };
    const [first, second, third] = await service.propose(
      ['J02.9', 'J02.9', 'J03.9'].map((code) => ({
        encounterId: encounter.id,
        aiRunId: run.id,
        kind: 'diagnosis' as const,
        proposal: proposal(code),
        sources: [],
      })),
      as,
    );
    await createDiagnosis(prisma, encounter.id, 'J02.9');
    await createDiagnosis(prisma, encounter.id, 'J03.9');
    const [pharyngitis, tonsillitis] = await prisma.encounterDiagnosis.findMany({ where: { encounterId: encounter.id }, orderBy: { rank: 'asc' } }); // prettier-ignore

    await service.accept({ suggestionId: first!.id, recordId: pharyngitis!.id }, as); // prettier-ignore

    await expect(
      service.accept({ suggestionId: second!.id, recordId: pharyngitis!.id }, as), // prettier-ignore
    ).rejects.toThrow(/ai_suggestion_one_per_diagnosis|Unique constraint/);
    // Control: another diagnosis answers another proposal.
    await expect(
      service.accept({ suggestionId: third!.id, recordId: tonsillitis!.id }, as), // prettier-ignore
    ).resolves.toMatchObject({ status: 'ACCEPTED' });
  });

  it('AS-039 nothing is proposed on an attention that no longer takes new content, and on a live one it is', async () => {
    const prisma = db();
    const { encounter, run } = await anAttention(prisma);
    const user = await createUser(prisma);
    const service = serviceOf(prisma);
    const as = { userId: user.id, sites: 'all' as const };
    const one = () => [{ encounterId: encounter.id, aiRunId: run.id, kind: 'diagnosis' as const, proposal: proposal('J02.9'), sources: [] }]; // prettier-ignore

    // Control: live, it is kept.
    await expect(service.propose(one(), as)).resolves.toHaveLength(1);

    await prisma.$executeRaw`UPDATE encounter SET status = 'DISCHARGED', ended_at = ${new Date()}, "dischargeCondition" = 'ALIVE' WHERE id = ${encounter.id}::uuid`; // prettier-ignore
    await expect(service.propose(one(), as)).rejects.toBeInstanceOf(
      AssistantEncounterClosedError,
    );
    expect(await prisma.aiSuggestion.count({ where: { encounterId: encounter.id } })).toBe(1); // prettier-ignore
  });
});
