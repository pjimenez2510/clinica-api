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
 * C1. What the database guarantees about the listening, against PostgreSQL:
 * a segment once per start (AS-052), never rewritten, and no binary column in
 * any table of the listening (AS-053). Each refusal with its positive control.
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

function segment(
  encounterId: string,
  over: Partial<{ startMs: number; endMs: number; text: string }> = {},
) {
  return {
    encounterId,
    startMs: 0,
    endMs: 4_000,
    text: 'Me duele la garganta desde hace tres días.',
    createdAt: new Date(),
    ...over,
  };
}

describe('transcript_segment (AS-052)', () => {
  it('AS-052: keeps a confirmed segment (positive control)', async () => {
    const prisma = db();
    const { encounter } = await anAttention(prisma);

    await prisma.transcriptSegment.create({ data: segment(encounter.id) });

    expect(
      await prisma.transcriptSegment.count({
        where: { encounterId: encounter.id },
      }),
    ).toBe(1);
  });

  it('AS-052: refuses a second segment of the same attention with the same start', async () => {
    const prisma = db();
    const { encounter } = await anAttention(prisma);
    const other = await anAttention(prisma);
    await prisma.transcriptSegment.create({ data: segment(encounter.id) });

    // Positive control: the same start in ANOTHER attention is fine.
    await prisma.transcriptSegment.create({
      data: segment(other.encounter.id),
    });

    await expect(
      prisma.transcriptSegment.create({
        data: segment(encounter.id, { text: 'Otra frase en el mismo inicio.' }),
      }),
    ).rejects.toThrow(/transcript_segment_once|Unique constraint/);
  });

  it('AS-052: refuses a segment that does not end after it starts', async () => {
    const prisma = db();
    const { encounter } = await anAttention(prisma);

    await expect(
      prisma.transcriptSegment.create({
        data: segment(encounter.id, { startMs: 5_000, endMs: 5_000 }),
      }),
    ).rejects.toThrow(/transcript_segment_ends_after_start/);
  });

  it('AS-052: refuses a segment without text', async () => {
    const prisma = db();
    const { encounter } = await anAttention(prisma);

    await expect(
      prisma.transcriptSegment.create({
        data: segment(encounter.id, { text: '   ' }),
      }),
    ).rejects.toThrow(/transcript_segment_has_text/);
  });

  it('AS-052: refuses to rewrite a stored segment, and lets the purge delete it', async () => {
    const prisma = db();
    const { encounter } = await anAttention(prisma);
    const stored = await prisma.transcriptSegment.create({
      data: segment(encounter.id),
    });

    await expect(
      prisma.transcriptSegment.update({
        where: { id: stored.id },
        data: { text: 'Lo que nadie dijo.' },
      }),
    ).rejects.toThrow(/transcript_segment_is_kept_as_heard/);

    await prisma.transcriptSegment.delete({ where: { id: stored.id } });
    expect(await prisma.transcriptSegment.count()).toBe(0);
  });
});

describe('listening_session (AS-049, AS-051)', () => {
  it('AS-049: keeps the clock of a paused listening with its reason (positive control)', async () => {
    const prisma = db();
    const { encounter, userId } = await anAttention(prisma);
    const now = new Date();

    await prisma.listeningSession.create({
      data: {
        encounterId: encounter.id,
        state: 'PAUSED',
        offsetMs: 22_230,
        reason: 'device-lost',
        device: 'computador',
        startedBy: userId,
        startedAt: now,
        updatedAt: now,
      },
    });

    const kept = await prisma.listeningSession.findUniqueOrThrow({
      where: {
        encounterId_scope: { encounterId: encounter.id, scope: 'CONSULTATION' },
      },
    });
    expect(kept).toMatchObject({ offsetMs: 22_230, reason: 'device-lost' });
  });

  it('AS-051: refuses a reason on a listening that is not paused, an unknown reason and a negative clock', async () => {
    const prisma = db();
    const { encounter, userId } = await anAttention(prisma);
    const now = new Date();
    const base = {
      encounterId: encounter.id,
      device: 'computador',
      startedBy: userId,
      startedAt: now,
      updatedAt: now,
    };

    await expect(
      prisma.listeningSession.create({
        data: { ...base, state: 'LISTENING', reason: 'device-lost' },
      }),
    ).rejects.toThrow(/listening_session_reason_when_paused/);
    await expect(
      prisma.listeningSession.create({
        data: { ...base, state: 'PAUSED', reason: 'se cortó la red' },
      }),
    ).rejects.toThrow(/listening_session_reason_when_paused/);
    await expect(
      prisma.listeningSession.create({
        data: { ...base, state: 'LISTENING', offsetMs: -1 },
      }),
    ).rejects.toThrow(/listening_session_offset_non_negative/);
    await expect(
      prisma.listeningSession.create({ data: { ...base, state: 'RECORDING' } }),
    ).rejects.toThrow(/listening_session_state_known/);
  });
});

describe('the audio is stored nowhere (AS-053)', () => {
  it('AS-053: no table of the listening has a binary column', async () => {
    const prisma = db();

    const columns = await prisma.$queryRaw<
      { table_name: string; data_type: string }[]
    >`
      SELECT table_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('listening_session', 'transcript_segment')`;

    // Positive control: the query does see both tables.
    expect(new Set(columns.map((c) => c.table_name))).toEqual(
      new Set(['listening_session', 'transcript_segment']),
    );
    expect(columns.filter((c) => c.data_type === 'bytea')).toEqual([]);
  });
});

describe('the scope of a listening (AS-241, B3)', () => {
  function session(encounterId: string, userId: string, scope?: string) {
    const now = new Date();
    return {
      encounterId,
      ...(scope ? { scope } : {}),
      state: 'LISTENING',
      offsetMs: 0,
      device: 'computador',
      startedBy: userId,
      startedAt: now,
      updatedAt: now,
    };
  }

  it('AS-241: keeps the preparation and the consultation of one attention apart, and a listening older than the scope as the consultation', async () => {
    const prisma = db();
    const { encounter, userId } = await anAttention(prisma);

    await prisma.listeningSession.create({
      data: session(encounter.id, userId),
    });
    await prisma.listeningSession.create({
      data: session(encounter.id, userId, 'PREPARATION'),
    });

    const scopes = await prisma.listeningSession.findMany({
      where: { encounterId: encounter.id },
      select: { scope: true },
      orderBy: { scope: 'asc' },
    });
    expect(scopes.map((each) => each.scope)).toEqual([
      'CONSULTATION',
      'PREPARATION',
    ]);
  });

  it('AS-241: refuses a second listening of the same attention in the same scope', async () => {
    const prisma = db();
    const { encounter, userId } = await anAttention(prisma);
    await prisma.listeningSession.create({
      data: session(encounter.id, userId, 'PREPARATION'),
    });

    await expect(
      prisma.listeningSession.create({
        data: session(encounter.id, userId, 'PREPARATION'),
      }),
    ).rejects.toThrow(/listening_session_pkey|Unique constraint/);
  });

  it('AS-241: refuses a scope it does not know, on a listening and on a segment', async () => {
    const prisma = db();
    const { encounter, userId } = await anAttention(prisma);

    await expect(
      prisma.listeningSession.create({
        data: session(encounter.id, userId, 'WAITING_ROOM'),
      }),
    ).rejects.toThrow(/listening_session_scope_known/);
    await expect(
      prisma.transcriptSegment.create({
        data: { ...segment(encounter.id), scope: 'WAITING_ROOM' },
      }),
    ).rejects.toThrow(/transcript_segment_scope_known/);
  });

  it('AS-241: takes the same start in the other scope, and refuses it twice in the same one', async () => {
    const prisma = db();
    const { encounter } = await anAttention(prisma);
    await prisma.transcriptSegment.create({ data: segment(encounter.id) });

    // Positive control: the preparation starts its own clock at zero.
    await prisma.transcriptSegment.create({
      data: { ...segment(encounter.id), scope: 'PREPARATION' },
    });

    await expect(
      prisma.transcriptSegment.create({
        data: {
          ...segment(encounter.id, { text: 'Otra frase en el mismo inicio.' }),
          scope: 'PREPARATION',
        },
      }),
    ).rejects.toThrow(/transcript_segment_once|Unique constraint/);
  });
});
