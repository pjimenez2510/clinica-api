import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { SuggestionService } from '../../src/modules/assistant/application/suggestion.service';
import { SuggestionChartMismatchError } from '../../src/modules/assistant/domain/assistant.errors';
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
 * AS-266 against PostgreSQL: a proposal of the chart, once accepted, links
 * exactly one record of its own class, and that record is of the patient of
 * its attention. Each refusal with its positive control.
 */
const db = useDatabase();

async function anAttention(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const other = await createPatient(prisma);
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
      purpose: 'chart-background',
      promptVersion: 'v1',
      outcome: 'ok',
      worstCaseUsd: 0.01,
      priceValidFrom: new Date(),
      latencyMs: 30,
      startedAt: new Date(),
      encounterId: encounter.id,
    },
  });
  const user = await createUser(prisma);
  return { encounter, run, patient, other, user };
}

const serviceOf = (prisma: PrismaClient) =>
  new SuggestionService(
    new PrismaSuggestionStore(prisma as unknown as PrismaService),
    () => new Date(),
  );

describe('ai_suggestion for the chart (AS-266)', () => {
  it('AS-266 an allergy proposal links an allergy of the attention’s patient, never another patient’s', async () => {
    const prisma = db();
    const { encounter, run, patient, other, user } = await anAttention(prisma);
    const service = serviceOf(prisma);
    const as = { userId: user.id, sites: 'all' as const };
    const [mine, theirs] = await service.propose(
      [0, 1].map(() => ({
        encounterId: encounter.id,
        aiRunId: run.id,
        kind: 'chart-allergy' as const,
        proposal: { text: 'Amoxicilina · ronchas', substance: 'Amoxicilina', reaction: 'ronchas' }, // prettier-ignore
        sources: [{ kind: 'transcript' as const, fromMs: 0, toMs: 3_000 }],
      })),
      as,
    );
    const ownAllergy = await prisma.patientAllergy.create({
      data: { patientId: patient.id, substanceText: 'Amoxicilina', reaction: 'ronchas', recordedById: user.id }, // prettier-ignore
    });
    const otherAllergy = await prisma.patientAllergy.create({
      data: { patientId: other.id, substanceText: 'Amoxicilina', reaction: 'ronchas', recordedById: user.id }, // prettier-ignore
    });

    await expect(
      service.accept({ suggestionId: theirs!.id, recordId: otherAllergy.id }, as), // prettier-ignore
    ).rejects.toThrow(/ai_suggestion_record_in_its_encounter/);
    // Control: the same path with the patient's own allergy is accepted, tal cual.
    await expect(
      service.accept({ suggestionId: mine!.id, recordId: ownAllergy.id }, as),
    ).resolves.toMatchObject({ status: 'ACCEPTED', distance: 0 });
    expect(await prisma.aiSuggestion.findUnique({ where: { id: mine!.id }, select: { patientAllergyId: true } })) // prettier-ignore
      .toEqual({ patientAllergyId: ownAllergy.id });
  });

  it('AS-266 «sin alergias» and a history entry link their own tables; an edited one is «con cambios»', async () => {
    const prisma = db();
    const { encounter, run, patient, user } = await anAttention(prisma);
    const service = serviceOf(prisma);
    const as = { userId: user.id, sites: 'all' as const };
    const [none, history] = await service.propose(
      [
        { kind: 'chart-no-allergy' as const, proposal: { text: 'Sin alergias conocidas' } }, // prettier-ignore
        { kind: 'chart-history' as const, proposal: { text: 'Hipertensión arterial · Madre' } }, // prettier-ignore
      ].map((each) => ({ ...each, encounterId: encounter.id, aiRunId: run.id, sources: [] })), // prettier-ignore
      as,
    );
    const absence = await prisma.patientAllergyAbsence.create({
      data: { patientId: patient.id, assertedById: user.id },
    });
    const entry = await prisma.patientHistory.create({
      data: { patientId: patient.id, kind: 'FAMILY', description: 'Hipertensión arterial esencial', relative: 'Madre', recordedById: user.id }, // prettier-ignore
    });

    await expect(service.accept({ suggestionId: none!.id, recordId: absence.id }, as)) // prettier-ignore
      .resolves.toMatchObject({ status: 'ACCEPTED' });
    const linked = await service.accept({ suggestionId: history!.id, recordId: entry.id }, as); // prettier-ignore
    expect(linked.status).toBe('ACCEPTED_WITH_CHANGES');
    expect(linked.distance).toBeGreaterThan(0);
  });

  it('AS-266 the database refuses a chart proposal accepted with a record of another class, or with two', async () => {
    const prisma = db();
    const { encounter, run, patient, user } = await anAttention(prisma);
    const service = serviceOf(prisma);
    const as = { userId: user.id, sites: 'all' as const };
    const [history] = await service.propose(
      [{ encounterId: encounter.id, aiRunId: run.id, kind: 'chart-history' as const, proposal: { text: 'Asma' }, sources: [] }], // prettier-ignore
      as,
    );
    const allergy = await prisma.patientAllergy.create({
      data: { patientId: patient.id, substanceText: 'Látex', recordedById: user.id }, // prettier-ignore
    });
    const entry = await prisma.patientHistory.create({
      data: { patientId: patient.id, kind: 'PERSONAL', description: 'Asma', recordedById: user.id }, // prettier-ignore
    });
    const decide = (columns: string) =>
      prisma.$executeRawUnsafe(
        `UPDATE ai_suggestion SET status = 'ACCEPTED', distance = 0, decided_by = $1::uuid, decided_at = now(), ${columns} WHERE id = $2::uuid`,
        user.id,
        history!.id,
      );

    await expect(decide(`patient_allergy_id = '${allergy.id}'`)).rejects.toThrow(/ai_suggestion_accepted_links_its_record/); // prettier-ignore
    await expect(decide(`patient_history_id = '${entry.id}', patient_allergy_id = '${allergy.id}'`)).rejects.toThrow(/ai_suggestion_accepted_links_its_record/); // prettier-ignore
    // Control: its own class, alone, is admitted.
    await expect(decide(`patient_history_id = '${entry.id}'`)).resolves.toBe(1);
  });

  it('AS-265 AS-266 the base refuses a record of another author or made before the proposal, and one record answering two proposals', async () => {
    const prisma = db();
    const { encounter, run, patient, user } = await anAttention(prisma);
    const colleague = await createUser(prisma);
    const service = serviceOf(prisma);
    const as = { userId: user.id, sites: 'all' as const };
    const before = await prisma.patientAllergy.create({
      data: { patientId: patient.id, substanceText: 'Látex', recordedById: user.id }, // prettier-ignore
    });
    const [first, second, third] = await service.propose(
      [0, 1, 2].map(() => ({ encounterId: encounter.id, aiRunId: run.id, kind: 'chart-allergy' as const, proposal: { text: 'Látex' }, sources: [] })), // prettier-ignore
      as,
    );
    const theirs = await prisma.patientAllergy.create({
      data: { patientId: patient.id, substanceText: 'Látex', recordedById: colleague.id }, // prettier-ignore
    });
    const mine = await prisma.patientAllergy.create({
      data: { patientId: patient.id, substanceText: 'Látex', recordedById: user.id }, // prettier-ignore
    });

    await expect(service.accept({ suggestionId: first!.id, recordId: theirs.id }, as)).rejects.toBeInstanceOf(SuggestionChartMismatchError); // prettier-ignore
    await expect(service.accept({ suggestionId: first!.id, recordId: before.id }, as)).rejects.toBeInstanceOf(SuggestionChartMismatchError); // prettier-ignore
    // Control: the record the one who decides made after the proposal.
    await expect(service.accept({ suggestionId: first!.id, recordId: mine.id }, as)).resolves.toMatchObject({ status: 'ACCEPTED' }); // prettier-ignore
    await expect(service.accept({ suggestionId: second!.id, recordId: mine.id }, as)).rejects.toBeInstanceOf(SuggestionChartMismatchError); // prettier-ignore
    expect(third).toBeDefined();
  });
});
