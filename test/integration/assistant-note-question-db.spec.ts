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
 * C3. What the database guarantees about the questions «Para completar la
 * nota» (AS-121): a question is a proposal that is never accepted into the
 * record, and each review that answered is a row with no text, of an attempt
 * that answered in its own attention, never rewritten. Each refusal with its
 * positive control.
 */
const db = useDatabase();

const DIGEST = 'a'.repeat(64);

async function anAttention(prisma: PrismaClient) {
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
      content: { motivoConsulta: 'Dolor de garganta' },
      authorId: practitioner.id,
    },
  });
  const run = await aRun(prisma, encounter.id);
  return { encounter, note, run, userId: practitioner.userId };
}

const aRun = (
  prisma: PrismaClient,
  encounterId: string,
  outcome = 'ok',
  purpose = 'note-questions',
) =>
  prisma.aiRun.create({
    data: {
      requestId: randomUUID(),
      attempt: 1,
      provider: 'gemini',
      model: GEMINI_MODELS.fast,
      tier: 'fast',
      purpose,
      promptVersion: 'c3-questions-1',
      outcome,
      worstCaseUsd: 0.001,
      priceValidFrom: new Date(),
      latencyMs: 30,
      startedAt: new Date(),
      encounterId,
    },
  });

function aCheck(
  encounterId: string,
  aiRunId: string,
  requestedBy: string,
  over: Partial<{ asked: number; dropped: number; upToMs: number; noteDigest: string }> = {}, // prettier-ignore
) {
  return {
    encounterId,
    aiRunId,
    requestedBy,
    upToMs: 25_000,
    noteDigest: DIGEST,
    asked: 2,
    dropped: 1,
    checkedAt: new Date(),
    ...over,
  };
}

function aQuestion(encounterId: string, aiRunId: string) {
  return {
    encounterId,
    aiRunId,
    kind: 'note-question',
    proposal: { text: '¿Hasta qué temperatura llegó la fiebre?', section: 'enfermedadActual', fromMs: 0, toMs: 12_000 }, // prettier-ignore
    sources: [{ kind: 'transcript', fromMs: 0, toMs: 12_000 }],
    proposedAt: new Date(),
  };
}

describe('note-question in ai_suggestion (AS-121)', () => {
  it('AS-121 AS-125: keeps a question and lets the professional discard it (positive control)', async () => {
    const prisma = db();
    const { encounter, run, userId } = await anAttention(prisma);
    const question = await prisma.aiSuggestion.create({
      data: aQuestion(encounter.id, run.id),
    });

    const discarded = await prisma.aiSuggestion.update({
      where: { id: question.id },
      data: { status: 'DISCARDED', decidedBy: userId, decidedAt: new Date() },
    });

    expect(discarded.status).toBe('DISCARDED');
  });

  it('AS-121: refuses accepting a question into the note: it is not a datum of the record', async () => {
    const prisma = db();
    const { encounter, note, run, userId } = await anAttention(prisma);
    const question = await prisma.aiSuggestion.create({
      data: aQuestion(encounter.id, run.id),
    });
    const section = await prisma.aiSuggestion.create({
      data: { ...aQuestion(encounter.id, run.id), kind: 'note-section', proposal: { section: 'motivoConsulta', text: 'Dolor de garganta.' } }, // prettier-ignore
    });
    const accept = (id: string) =>
      prisma.aiSuggestion.update({
        where: { id },
        data: { status: 'ACCEPTED', distance: 0, clinicalNoteId: note.id, decidedBy: userId, decidedAt: new Date() }, // prettier-ignore
      });

    // Positive control: a section of the draft is accepted by the same road.
    await accept(section.id);
    await expect(accept(question.id)).rejects.toThrow(
      /ai_suggestion_accepted_links_its_record/,
    );
  });
});

describe('note_question_check (AS-121)', () => {
  it('AS-121: keeps a review of an attempt that answered in its own attention (positive control)', async () => {
    const prisma = db();
    const { encounter, run, userId } = await anAttention(prisma);

    const check = await prisma.noteQuestionCheck.create({
      data: aCheck(encounter.id, run.id, userId, { asked: 0, dropped: 0 }),
    });

    expect(check.asked).toBe(0);
  });

  it('AS-121: refuses a review whose attempt is of another attention, did not answer, or answered something else', async () => {
    const prisma = db();
    const { encounter, run, userId } = await anAttention(prisma);
    const other = await anAttention(prisma);
    const failed = await aRun(prisma, encounter.id, 'provider-error');
    const draft = await aRun(prisma, encounter.id, 'ok', 'note-draft');

    await prisma.noteQuestionCheck.create({ data: aCheck(encounter.id, run.id, userId) }); // prettier-ignore
    await expect(
      prisma.noteQuestionCheck.create({ data: aCheck(encounter.id, other.run.id, userId) }), // prettier-ignore
    ).rejects.toThrow(/note_question_check_run_of_its_encounter/);
    await expect(
      prisma.noteQuestionCheck.create({ data: aCheck(encounter.id, failed.id, userId) }), // prettier-ignore
    ).rejects.toThrow(/note_question_check_run_of_its_encounter/);
    await expect(
      prisma.noteQuestionCheck.create({ data: aCheck(encounter.id, draft.id, userId) }), // prettier-ignore
    ).rejects.toThrow(/note_question_check_run_of_its_encounter/);
  });

  it('AS-120 AS-121: refuses more than five questions, negative counts, a stretch below zero and a digest that is not one', async () => {
    const prisma = db();
    const { encounter, run, userId } = await anAttention(prisma);
    const refused = (over: Parameters<typeof aCheck>[3], constraint: string) =>
      expect(
        prisma.noteQuestionCheck.create({ data: aCheck(encounter.id, run.id, userId, over) }), // prettier-ignore
      ).rejects.toThrow(new RegExp(`note_question_check_${constraint}`));

    await prisma.noteQuestionCheck.create({ data: aCheck(encounter.id, run.id, userId, { asked: 5, upToMs: 0 }) }); // prettier-ignore
    await refused({ asked: 6 }, 'asked_at_most_five');
    await refused({ asked: -1 }, 'asked_at_most_five');
    await refused({ dropped: -1 }, 'dropped_counted');
    await refused({ upToMs: -1 }, 'stretch_known');
    await refused({ noteDigest: 'Dolor de garganta' }, 'digest_is_one');
    await refused({ noteDigest: 'A'.repeat(64) }, 'digest_is_one');
  });

  it('AS-121: a review is never rewritten nor deleted', async () => {
    const prisma = db();
    const { encounter, run, userId } = await anAttention(prisma);
    const check = await prisma.noteQuestionCheck.create({
      data: aCheck(encounter.id, run.id, userId),
    });

    await expect(
      prisma.noteQuestionCheck.update({ where: { id: check.id }, data: { asked: 1 } }), // prettier-ignore
    ).rejects.toThrow(/note_question_check_is_kept/);
    await expect(
      prisma.noteQuestionCheck.delete({ where: { id: check.id } }),
    ).rejects.toThrow(/note_question_check_is_kept/);
    expect(
      await prisma.noteQuestionCheck.count({ where: { id: check.id } }),
    ).toBe(1);
  });

  it('AS-124: note_question_check has no column that could hold text of the consultation', async () => {
    const prisma = db();
    const columns = await prisma.$queryRaw<
      { column_name: string; data_type: string; length: number | null }[]
    >`
      SELECT column_name, data_type, character_maximum_length AS length
      FROM information_schema.columns
      WHERE table_name = 'note_question_check'`;

    expect(columns.length).toBeGreaterThan(0);
    const texts = columns.filter(
      (column) =>
        column.data_type === 'text' ||
        column.data_type === 'jsonb' ||
        (column.data_type === 'character varying' && (column.length ?? 0) > 64),
    );
    expect(texts).toEqual([]);
  });
});
