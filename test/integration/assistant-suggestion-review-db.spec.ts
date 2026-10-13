import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { GEMINI_MODELS } from '../../src/modules/assistant/infrastructure/model-routing';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * E1 (AS-145). What the database guarantees about the review of a section of
 * the draft at the signature: only a section, only against a SIGNED note of
 * its own attention, with the state the proposal really has, a distance in
 * [0, 1], once, and never changed or deleted. Each refusal with its positive
 * control through the same insert.
 */
const db = useDatabase();

/** An attention with its 002 (signed or not) and an answered attempt. */
async function anAttention(prisma: PrismaClient, signed = true) {
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
      content: { motivoConsulta: 'Cefalea de tres días' },
      authorId: practitioner.id,
      ...(signed
        ? {
            status: 'SIGNED' as const,
            signedAt: new Date(),
            signedById: practitioner.id,
            contentHash: 'a'.repeat(64),
          }
        : {}),
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

function aSection(
  prisma: PrismaClient,
  ids: { encounterId: string; aiRunId: string },
  kind = 'note-section',
) {
  return prisma.aiSuggestion.create({
    data: {
      ...ids,
      kind,
      proposal:
        kind === 'note-section'
          ? { section: 'motivoConsulta', text: 'Cefalea de tres días' }
          : { code: 'R51', codes: ['R51'] },
      sources: [{ kind: 'transcript', fromMs: 0, toMs: 4_000 }],
      proposedAt: new Date(),
    },
  });
}

function review(
  prisma: PrismaClient,
  suggestionId: string,
  clinicalNoteId: string,
  over: Partial<{ statusAtSigning: string; distance: number }> = {},
) {
  return prisma.aiSuggestionReview.create({
    data: {
      suggestionId,
      clinicalNoteId,
      statusAtSigning: 'PROPOSED',
      distance: 0.25,
      reviewedAt: new Date(),
      ...over,
    },
  });
}

describe('ai_suggestion_review (AS-145)', () => {
  it('AS-145 keeps the review of a section against the signed note of its attention (positive control)', async () => {
    const prisma = db();
    const { encounter, note, run } = await anAttention(prisma);
    const section = await aSection(prisma, {
      encounterId: encounter.id,
      aiRunId: run.id,
    });

    await review(prisma, section.id, note.id, { distance: 1 });

    const kept = await prisma.aiSuggestionReview.findUniqueOrThrow({
      where: { suggestionId: section.id },
    });
    expect(kept.clinicalNoteId).toBe(note.id);
    expect(kept.statusAtSigning).toBe('PROPOSED');
    expect(Number(kept.distance)).toBe(1);
  });

  it('AS-145 refuses the review of something that is not a section of the note', async () => {
    const prisma = db();
    const { encounter, note, run } = await anAttention(prisma);
    const ids = { encounterId: encounter.id, aiRunId: run.id };
    const section = await aSection(prisma, ids);
    const diagnosis = await aSection(prisma, ids, 'diagnosis');

    await review(prisma, section.id, note.id);
    await expect(review(prisma, diagnosis.id, note.id)).rejects.toThrow(
      /ai_suggestion_review_of_a_section/,
    );
  });

  it('AS-145 refuses a review against a note that is not signed, not the 002, or of another attention', async () => {
    const prisma = db();
    const signed = await anAttention(prisma);
    const unsigned = await anAttention(prisma, false);
    const ofSigned = await aSection(prisma, {
      encounterId: signed.encounter.id,
      aiRunId: signed.run.id,
    });
    const ofUnsigned = await aSection(prisma, {
      encounterId: unsigned.encounter.id,
      aiRunId: unsigned.run.id,
    });

    await expect(
      review(prisma, ofUnsigned.id, unsigned.note.id),
    ).rejects.toThrow(/ai_suggestion_review_of_a_signed_note/);
    await expect(review(prisma, ofUnsigned.id, signed.note.id)).rejects.toThrow(
      /ai_suggestion_review_of_a_signed_note/,
    );
    // An evolution note signed in the same attention is not what the draft wrote into.
    const id = randomUUID();
    const evolution = await prisma.clinicalNote.create({
      data: {
        id,
        chainId: id,
        encounterId: signed.encounter.id,
        formCode: '005',
        formVersion: '1',
        content: { evolucion: 'Curación de la herida.' },
        authorId: signed.note.authorId,
        status: 'SIGNED',
        signedAt: new Date(),
        signedById: signed.note.authorId,
        contentHash: 'b'.repeat(64),
      },
    });
    await expect(review(prisma, ofSigned.id, evolution.id)).rejects.toThrow(
      /ai_suggestion_review_of_a_signed_note/,
    );
    // Positive control: the same insert with its own signed 002.
    await review(prisma, ofSigned.id, signed.note.id);
  });

  it('AS-145 refuses a state at signing that is not the proposal’s', async () => {
    const prisma = db();
    const { encounter, note, run } = await anAttention(prisma);
    const section = await aSection(prisma, {
      encounterId: encounter.id,
      aiRunId: run.id,
    });

    await expect(
      review(prisma, section.id, note.id, { statusAtSigning: 'ACCEPTED' }),
    ).rejects.toThrow(/ai_suggestion_review_states_the_decision/);
    await review(prisma, section.id, note.id, { statusAtSigning: 'PROPOSED' });
  });

  it('AS-145 refuses a distance outside [0, 1]', async () => {
    const prisma = db();
    const { encounter, note, run } = await anAttention(prisma);
    const section = await aSection(prisma, {
      encounterId: encounter.id,
      aiRunId: run.id,
    });

    await expect(
      review(prisma, section.id, note.id, { distance: 1.5 }),
    ).rejects.toThrow(/ai_suggestion_review_distance_in_range/);
    await expect(
      review(prisma, section.id, note.id, { distance: -0.1 }),
    ).rejects.toThrow(/ai_suggestion_review_distance_in_range/);
    await review(prisma, section.id, note.id, { distance: 0 });
  });

  it('AS-145 keeps one review per proposal, never changed nor deleted', async () => {
    const prisma = db();
    const { encounter, note, run } = await anAttention(prisma);
    const section = await aSection(prisma, {
      encounterId: encounter.id,
      aiRunId: run.id,
    });
    await review(prisma, section.id, note.id);

    await expect(review(prisma, section.id, note.id)).rejects.toThrow(
      /ai_suggestion_review_pkey|Unique constraint/,
    );
    await expect(
      prisma.aiSuggestionReview.update({
        where: { suggestionId: section.id },
        data: { distance: 0 },
      }),
    ).rejects.toThrow(/ai_suggestion_review_is_kept/);
    await expect(
      prisma.aiSuggestionReview.delete({ where: { suggestionId: section.id } }),
    ).rejects.toThrow(/ai_suggestion_review_is_kept/);
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE ai_suggestion_review'),
    ).rejects.toThrow(/insert-only/);
    expect(
      await prisma.aiSuggestionReview.count({
        where: { suggestionId: section.id },
      }),
    ).toBe(1);
  });
});
