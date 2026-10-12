import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * C2. What the database guarantees about each draft asked for (AS-086,
 * AS-093): one per stretch of the transcript, one in flight per attention, a
 * failure always with its code, and no text in the table (AS-095). Each
 * refusal with its positive control.
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
  return { encounter, userId: practitioner.userId };
}

function queued(
  encounterId: string,
  requestedBy: string,
  over: Partial<{ upToMs: number }> = {},
) {
  return {
    encounterId,
    requestedBy,
    upToMs: 60_000,
    status: 'QUEUED',
    requestedAt: new Date(),
    ...over,
  };
}

describe('note_draft (AS-086)', () => {
  it('AS-086: keeps a queued draft, and a second one of a later stretch once the first is done (positive control)', async () => {
    const prisma = db();
    const { encounter, userId } = await anAttention(prisma);
    const first = await prisma.noteDraft.create({
      data: queued(encounter.id, userId),
    });
    await prisma.noteDraft.update({
      where: { id: first.id },
      data: {
        status: 'FAILED',
        failureCode: 'ASSISTANT_PROVIDER_FAILED',
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });

    await prisma.noteDraft.create({
      data: queued(encounter.id, userId, { upToMs: 240_000 }),
    });

    expect(
      await prisma.noteDraft.count({ where: { encounterId: encounter.id } }),
    ).toBe(2);
  });

  it('AS-086: refuses a second draft in flight for the same attention', async () => {
    const prisma = db();
    const { encounter, userId } = await anAttention(prisma);
    const other = await anAttention(prisma);
    await prisma.noteDraft.create({ data: queued(encounter.id, userId) });

    // Positive control: another attention may have one in flight at once.
    await prisma.noteDraft.create({
      data: queued(other.encounter.id, other.userId),
    });

    await expect(
      prisma.noteDraft.create({
        data: queued(encounter.id, userId, { upToMs: 240_000 }),
      }),
    ).rejects.toThrow(/note_draft_one_in_flight|Unique constraint/);
  });

  it('AS-086: refuses two drafts of the same stretch', async () => {
    const prisma = db();
    const { encounter, userId } = await anAttention(prisma);
    const first = await prisma.noteDraft.create({
      data: queued(encounter.id, userId),
    });
    await prisma.noteDraft.update({
      where: { id: first.id },
      data: {
        status: 'FAILED',
        failureCode: 'ASSISTANT_PROVIDER_FAILED',
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });

    await expect(
      prisma.noteDraft.create({ data: queued(encounter.id, userId) }),
    ).rejects.toThrow(/note_draft_once_per_stretch|Unique constraint/);
  });

  it('AS-093: refuses a failed draft without its code, and a code on one that did not fail', async () => {
    const prisma = db();
    const { encounter, userId } = await anAttention(prisma);
    const draft = await prisma.noteDraft.create({
      data: queued(encounter.id, userId),
    });

    await expect(
      prisma.noteDraft.update({
        where: { id: draft.id },
        data: { status: 'FAILED', startedAt: new Date(), finishedAt: new Date() }, // prettier-ignore
      }),
    ).rejects.toThrow(/note_draft_failure_has_code/);
    await expect(
      prisma.noteDraft.update({
        where: { id: draft.id },
        data: { failureCode: 'ASSISTANT_PROVIDER_FAILED' },
      }),
    ).rejects.toThrow(/note_draft_failure_has_code/);
  });

  it('AS-086: refuses a done draft without the attempt that wrote it', async () => {
    const prisma = db();
    const { encounter, userId } = await anAttention(prisma);
    const draft = await prisma.noteDraft.create({
      data: queued(encounter.id, userId),
    });

    await expect(
      prisma.noteDraft.update({
        where: { id: draft.id },
        data: { status: 'DONE', startedAt: new Date(), finishedAt: new Date() },
      }),
    ).rejects.toThrow(/note_draft_timeline_coherent/);
  });

  it('AS-086: refuses an unknown state and a stretch that is not positive', async () => {
    const prisma = db();
    const { encounter, userId } = await anAttention(prisma);

    await expect(
      prisma.noteDraft.create({
        data: { ...queued(encounter.id, userId), status: 'WRITING' },
      }),
    ).rejects.toThrow(/note_draft_status_known/);
    await expect(
      prisma.noteDraft.create({
        data: queued(encounter.id, userId, { upToMs: 0 }),
      }),
    ).rejects.toThrow(/note_draft_stretch_positive/);
  });

  it('AS-095: note_draft has no column that could hold text of the consultation', async () => {
    const prisma = db();
    const columns = await prisma.$queryRaw<
      { column_name: string; data_type: string; length: number | null }[]
    >`
      SELECT column_name, data_type, character_maximum_length AS length
      FROM information_schema.columns
      WHERE table_name = 'note_draft'`;

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
