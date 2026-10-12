import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { SuggestionService } from '../../src/modules/assistant/application/suggestion.service';
import {
  SuggestionAlreadyDecidedError,
  SuggestionNotFoundError,
} from '../../src/modules/assistant/domain/assistant.errors';
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
 * AS-020 to AS-024 against PostgreSQL: what `ai_suggestion` admits, what it
 * refuses, and the copy `record_version` keeps when a proposal is decided.
 * Every refusal has its positive control through the same path.
 */
const db = useDatabase();

async function anEncounterWithNote(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  const id = randomUUID();
  const note = await prisma.clinicalNote.create({
    data: {
      id,
      chainId: id,
      encounterId: encounter.id,
      formCode: '002',
      formVersion: '1',
      content: { motivoConsulta: 'Cefalea' },
      authorId: practitioner.id,
    },
  });
  const run = await prisma.aiRun.create({
    data: {
      requestId: randomUUID(),
      attempt: 1,
      provider: 'gemini',
      model: GEMINI_MODELS.quality,
      tier: 'quality',
      purpose: 'draft',
      promptVersion: 'v1',
      outcome: 'ok',
      worstCaseUsd: 0.01,
      priceValidFrom: new Date(),
      latencyMs: 30,
      startedAt: new Date(),
      encounterId: encounter.id,
    },
  });
  return { encounter, note, run };
}

const PROPOSAL = { section: 'motivoConsulta', text: 'Cefalea de tres días' };
const SOURCES = [
  { kind: 'transcript' as const, fromMs: 12_000, toMs: 18_500 },
];

async function propose(
  prisma: PrismaClient,
  ids: { encounterId: string; aiRunId: string },
  overrides: Record<string, unknown> = {},
) {
  return prisma.aiSuggestion.create({
    data: {
      ...ids,
      kind: 'note-section',
      proposal: PROPOSAL,
      sources: SOURCES,
      proposedAt: new Date(),
      ...overrides,
    },
  });
}

describe('ai_suggestion (assistant)', () => {
  it('AS-020 keeps a proposal with its attention, its attempt and its sources, and refuses sources that are not a list', async () => {
    const prisma = db();
    const { encounter, run } = await anEncounterWithNote(prisma);
    const ids = { encounterId: encounter.id, aiRunId: run.id };

    const kept = await propose(prisma, ids);
    expect(kept).toMatchObject({
      status: 'PROPOSED',
      decidedBy: null,
      distance: null,
      sources: SOURCES,
    });

    await expect(
      propose(prisma, ids, { sources: { kind: 'transcript' } }),
    ).rejects.toThrow(/ai_suggestion_sources_are_a_list/);
    await expect(propose(prisma, ids, { proposal: ['x'] })).rejects.toThrow(
      /ai_suggestion_proposal_is_object/,
    );
    await expect(propose(prisma, ids, { kind: 'vaccine' })).rejects.toThrow(
      /ai_suggestion_kind_known/,
    );
  });

  it('AS-021 AS-022 an accepted proposal links the note of its own attention, with who, when and its distance', async () => {
    const prisma = db();
    const { encounter, note, run } = await anEncounterWithNote(prisma);
    const decider = await createUser(prisma);
    const suggestion = await propose(prisma, {
      encounterId: encounter.id,
      aiRunId: run.id,
    });

    const accepted = await prisma.aiSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: 'ACCEPTED_WITH_CHANGES',
        distance: 0.25,
        clinicalNoteId: note.id,
        decidedBy: decider.id,
        decidedAt: new Date(),
      },
    });
    expect(accepted.clinicalNoteId).toBe(note.id);
    expect(Number(accepted.distance)).toBe(0.25);
  });

  it('AS-021 refuses linking a record of another attention, a record of another kind, two records, or none', async () => {
    const prisma = db();
    const own = await anEncounterWithNote(prisma);
    const other = await anEncounterWithNote(prisma);
    const decider = await createUser(prisma);
    const decision = (overrides: Record<string, unknown>) => ({
      status: 'ACCEPTED',
      distance: 0,
      decidedBy: decider.id,
      decidedAt: new Date(),
      ...overrides,
    });
    const fresh = () =>
      propose(prisma, { encounterId: own.encounter.id, aiRunId: own.run.id });

    const toAnother = await fresh();
    await expect(
      prisma.aiSuggestion.update({
        where: { id: toAnother.id },
        data: decision({ clinicalNoteId: other.note.id }),
      }),
    ).rejects.toThrow(/ai_suggestion_record_in_its_encounter/);

    const order = await prisma.serviceOrder.create({
      data: {
        encounterId: own.encounter.id,
        siteId: own.encounter.siteId,
        orderedById: own.encounter.practitionerId,
        category: 'LABORATORY',
      },
    });
    const wrongKind = await fresh();
    await expect(
      prisma.aiSuggestion.update({
        where: { id: wrongKind.id },
        data: decision({ serviceOrderId: order.id }),
      }),
    ).rejects.toThrow(/ai_suggestion_accepted_links_its_record/);

    const two = await fresh();
    await expect(
      prisma.aiSuggestion.update({
        where: { id: two.id },
        data: decision({
          clinicalNoteId: own.note.id,
          serviceOrderId: order.id,
        }),
      }),
    ).rejects.toThrow(/ai_suggestion_accepted_links_its_record/);

    const none = await fresh();
    await expect(
      prisma.aiSuggestion.update({
        where: { id: none.id },
        data: decision({}),
      }),
    ).rejects.toThrow(/ai_suggestion_accepted_links_its_record/);

    // A discarded one links nothing.
    const discarded = await fresh();
    await expect(
      prisma.aiSuggestion.update({
        where: { id: discarded.id },
        data: decision({
          status: 'DISCARDED',
          distance: null,
          clinicalNoteId: own.note.id,
        }),
      }),
    ).rejects.toThrow(/ai_suggestion_accepted_links_its_record/);

    // Control positivo: the same accepted decision on its own note passes.
    const right = await fresh();
    await expect(
      prisma.aiSuggestion.update({
        where: { id: right.id },
        data: decision({ clinicalNoteId: own.note.id }),
      }),
    ).resolves.toMatchObject({ status: 'ACCEPTED' });
  });

  it('AS-021 AS-022 refuses who without when, a distance that does not match the status, and accepts each valid one', async () => {
    const prisma = db();
    const { encounter, note, run } = await anEncounterWithNote(prisma);
    const decider = await createUser(prisma);
    const ids = { encounterId: encounter.id, aiRunId: run.id };

    for (const [data, constraint] of [
      [{ status: 'DISCARDED', decidedBy: decider.id }, 'ai_suggestion_decision_states_who_and_when'], // prettier-ignore
      [{ status: 'PROPOSED', decidedBy: decider.id, decidedAt: new Date() }, 'ai_suggestion_decision_states_who_and_when'], // prettier-ignore
      [{ status: 'ACCEPTED', distance: 0.5, clinicalNoteId: note.id, decidedBy: decider.id, decidedAt: new Date() }, 'ai_suggestion_distance_matches_status'], // prettier-ignore
      [{ status: 'ACCEPTED_WITH_CHANGES', distance: 0, clinicalNoteId: note.id, decidedBy: decider.id, decidedAt: new Date() }, 'ai_suggestion_distance_matches_status'], // prettier-ignore
      [{ status: 'ACCEPTED_WITH_CHANGES', clinicalNoteId: note.id, decidedBy: decider.id, decidedAt: new Date() }, 'ai_suggestion_distance_matches_status'], // prettier-ignore
      [{ status: 'DISCARDED', distance: 0.1, decidedBy: decider.id, decidedAt: new Date() }, 'ai_suggestion_distance_matches_status'], // prettier-ignore
      [{ status: 'MAYBE', decidedBy: decider.id, decidedAt: new Date() }, 'ai_suggestion_status_known'], // prettier-ignore
    ] as const) {
      await expect(
        propose(prisma, ids, data as Record<string, unknown>),
      ).rejects.toThrow(new RegExp(constraint));
    }

    // Control positivo: each status with its right shape is admitted.
    await expect(
      propose(prisma, ids, { status: 'DISCARDED', decidedBy: decider.id, decidedAt: new Date() }), // prettier-ignore
    ).resolves.toMatchObject({ status: 'DISCARDED' });
    await expect(
      propose(prisma, ids, { status: 'ACCEPTED', distance: 0, clinicalNoteId: note.id, decidedBy: decider.id, decidedAt: new Date() }), // prettier-ignore
    ).resolves.toMatchObject({ status: 'ACCEPTED' });
  });

  it('AS-023 a decision is final, what was proposed is not rewritten, and nothing is deleted', async () => {
    const prisma = db();
    const { encounter, run } = await anEncounterWithNote(prisma);
    const decider = await createUser(prisma);
    const suggestion = await propose(prisma, {
      encounterId: encounter.id,
      aiRunId: run.id,
    });
    const stamp = () => ({ decidedBy: decider.id, decidedAt: new Date() });

    // Rewriting the proposal while deciding is refused…
    await expect(
      prisma.aiSuggestion.update({
        where: { id: suggestion.id },
        data: { status: 'DISCARDED', proposal: { text: 'Otra' }, ...stamp() },
      }),
    ).rejects.toThrow(/ai_suggestion_decided_once/);
    // …and deciding alone passes (control positivo).
    await prisma.aiSuggestion.update({
      where: { id: suggestion.id },
      data: { status: 'DISCARDED', ...stamp() },
    });

    // Deciding again, even with a new stamp, is refused.
    await expect(
      prisma.aiSuggestion.update({
        where: { id: suggestion.id },
        data: { status: 'DISCARDED', ...stamp() },
      }),
    ).rejects.toThrow(/ai_suggestion_decided_once/);

    await expect(
      prisma.aiSuggestion.delete({ where: { id: suggestion.id } }),
    ).rejects.toThrow(/ai_suggestion_is_kept/);
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE ai_suggestion'),
    ).rejects.toThrow(/insert-only/);
  });

  it('AS-024 deciding archives the proposed row whole in record_version, with who and when decided', async () => {
    const prisma = db();
    const { encounter, note, run } = await anEncounterWithNote(prisma);
    const decider = await createUser(prisma);
    const suggestion = await propose(prisma, {
      encounterId: encounter.id,
      aiRunId: run.id,
    });

    // A raw UPDATE without the stamp is refused by the shared archive trigger.
    await expect(
      prisma.$executeRaw`UPDATE ai_suggestion SET status = 'DISCARDED' WHERE id = ${suggestion.id}::uuid`,
    ).rejects.toThrow(
      /record_version_change_is_stamped|ai_suggestion_decision_states_who_and_when/,
    );

    const decidedAt = new Date();
    await prisma.$executeRaw`
      UPDATE ai_suggestion
         SET status = 'ACCEPTED', distance = 0, clinical_note_id = ${note.id}::uuid,
             decided_by = ${decider.id}::uuid, decided_at = ${decidedAt}
       WHERE id = ${suggestion.id}::uuid`;

    const versions = await prisma.recordVersion.findMany({
      where: { resourceType: 'ai_suggestion', resourceId: suggestion.id },
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      changedById: decider.id,
      data: expect.objectContaining({
        status: 'PROPOSED',
        proposal: PROPOSAL,
        sources: SOURCES,
        clinical_note_id: null,
      }),
    });
    expect(versions[0]!.changedAt.getTime()).toBe(decidedAt.getTime());
  });
});

describe('SuggestionService over PostgreSQL (AS-020 to AS-023)', () => {
  const serviceOf = (prisma: PrismaClient, clock = () => new Date()) =>
    new SuggestionService(
      new PrismaSuggestionStore(prisma as unknown as PrismaService),
      clock,
    );

  it('AS-020 proposes every proposal of one answer at the instant of the app clock, and lists them by kind', async () => {
    const prisma = db();
    const { encounter, run } = await anEncounterWithNote(prisma);
    const at = new Date();
    const service = serviceOf(prisma, () => at);

    const kept = await service.propose([
      { encounterId: encounter.id, aiRunId: run.id, kind: 'note-section', proposal: PROPOSAL, sources: SOURCES }, // prettier-ignore
      { encounterId: encounter.id, aiRunId: run.id, kind: 'diagnosis', proposal: { problem: 'Cefalea', codes: ['R51'] }, sources: [] }, // prettier-ignore
    ]);
    expect(kept.map((each) => each.status)).toEqual(['PROPOSED', 'PROPOSED']);
    expect(kept[0]!.proposedAt.getTime()).toBe(at.getTime());

    const diagnoses = await service.ofEncounter(encounter.id, 'diagnosis');
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0]).toMatchObject({ kind: 'diagnosis', record: null });
    expect(await service.ofEncounter(encounter.id)).toHaveLength(2);
  });

  it('AS-020 one bad proposal leaves none: all or nothing', async () => {
    const prisma = db();
    const { encounter, run } = await anEncounterWithNote(prisma);

    await expect(
      serviceOf(prisma).propose([
        { encounterId: encounter.id, aiRunId: run.id, kind: 'note-section', proposal: PROPOSAL, sources: SOURCES }, // prettier-ignore
        { encounterId: encounter.id, aiRunId: randomUUID(), kind: 'note-section', proposal: PROPOSAL, sources: SOURCES }, // prettier-ignore
      ]),
    ).rejects.toThrow();
    expect(await prisma.aiSuggestion.count()).toBe(0);
  });

  it('AS-021 AS-022 accepting a changed section links the saved note, with its distance, who and when', async () => {
    const prisma = db();
    const { encounter, note, run } = await anEncounterWithNote(prisma);
    const decider = await createUser(prisma);
    const service = serviceOf(prisma);
    const [suggestion] = await service.propose([
      { encounterId: encounter.id, aiRunId: run.id, kind: 'note-section', proposal: PROPOSAL, sources: SOURCES }, // prettier-ignore
    ]);

    const accepted = await service.accept(
      { suggestionId: suggestion!.id, recordId: note.id, saved: 'Cefalea de dos días' }, // prettier-ignore
      decider.id,
    );

    expect(accepted).toMatchObject({
      status: 'ACCEPTED_WITH_CHANGES',
      record: { kind: 'clinical_note', id: note.id },
      decidedBy: decider.id,
    });
    expect(accepted.distance).toBeGreaterThan(0);
    expect(
      await prisma.recordVersion.count({
        where: { resourceId: suggestion!.id },
      }),
    ).toBe(1);
  });

  it('AS-022 a diagnosis accepted with one of its codes is ACCEPTED with distance 0', async () => {
    const prisma = db();
    const { encounter, run } = await anEncounterWithNote(prisma);
    await createDiagnosis(prisma, encounter.id, 'R51');
    const diagnosis = await prisma.encounterDiagnosis.findFirstOrThrow({
      where: { encounterId: encounter.id },
    });
    const decider = await createUser(prisma);
    const service = serviceOf(prisma);
    const [suggestion] = await service.propose([
      { encounterId: encounter.id, aiRunId: run.id, kind: 'diagnosis', proposal: { problem: 'Cefalea', codes: ['R51', 'G44.2'] }, sources: [] }, // prettier-ignore
    ]);

    await expect(
      service.accept(
        { suggestionId: suggestion!.id, recordId: diagnosis.id, saved: 'R51' },
        decider.id,
      ),
    ).resolves.toMatchObject({
      status: 'ACCEPTED',
      distance: 0,
      record: { kind: 'encounter_diagnosis', id: diagnosis.id },
    });
  });

  it('AS-023 of two decisions at once exactly one wins, the other is told it was decided; an unknown one is not found', async () => {
    const prisma = db();
    const { encounter, run } = await anEncounterWithNote(prisma);
    const decider = await createUser(prisma);
    const service = serviceOf(prisma);
    const [suggestion] = await service.propose([
      { encounterId: encounter.id, aiRunId: run.id, kind: 'note-section', proposal: PROPOSAL, sources: SOURCES }, // prettier-ignore
    ]);

    const outcomes = await Promise.allSettled([
      service.discard(suggestion!.id, decider.id),
      service.discard(suggestion!.id, decider.id),
    ]);
    expect(outcomes.filter((each) => each.status === 'fulfilled')).toHaveLength(1); // prettier-ignore
    const lost = outcomes.find((each) => each.status === 'rejected');
    expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(
      SuggestionAlreadyDecidedError,
    );

    await expect(
      service.discard(randomUUID(), decider.id),
    ).rejects.toBeInstanceOf(SuggestionNotFoundError);
  });
});
