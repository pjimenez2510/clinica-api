import type { PrismaClient } from '@prisma/client';
import type { Test } from 'supertest';

/**
 * EN-281, PR-121, ORD-181. Sends `If-Match` as a screen that JUST READ the
 * draft would: with the revision the database holds right before the request.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE SUITES THAT ARE NOT ABOUT CONCURRENCY USE THIS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Editing, signing and issuing a draft need the revision read (428 without
 * it). A hundred tests that write a note, a receta or an order are about the
 * signature, the discharge, the numbering — not about two tabs — and they
 * behave like the one tab that is up to date. The tests ABOUT two tabs set
 * `If-Match` themselves and never go through this.
 *
 * The revision is read when the request is SENT, not when it is built, so a
 * test that changes the draft between building and awaiting still sends the
 * current one.
 */
const DRAFT_PATHS: readonly [
  RegExp,
  'clinical_note' | 'prescription' | 'service_order',
][] = [
  [
    /\/encounters\/[0-9a-f-]{36}\/notes\/([0-9a-f-]{36})(?:\/sign)?$/,
    'clinical_note',
  ],
  [/\/prescriptions\/([0-9a-f-]{36})(?:\/issue)?$/, 'prescription'],
  [/\/orders\/([0-9a-f-]{36})(?:\/issue)?$/, 'service_order'],
];

/** The revision a draft has now: what a screen that just read it holds. */
export async function revisionNow(
  prisma: PrismaClient,
  table: 'clinical_note' | 'prescription' | 'service_order',
  id: string,
): Promise<number> {
  const [row] = await prisma.$queryRawUnsafe<{ revision: number }[]>(
    `SELECT revision FROM "${table}" WHERE id = $1::uuid`,
    id,
  );
  if (!row) throw new Error(`No ${table} ${id}`);
  return row.revision;
}

async function currentRevision(
  prisma: PrismaClient,
  path: string,
): Promise<string | undefined> {
  for (const [pattern, table] of DRAFT_PATHS) {
    const id = pattern.exec(path)?.[1];
    if (!id) continue;
    const [row] = await prisma.$queryRawUnsafe<{ revision: number }[]>(
      `SELECT revision FROM "${table}" WHERE id = $1::uuid`,
      id,
    );
    return row ? `"${row.revision}"` : undefined;
  }
  return undefined;
}

/**
 * Wraps a supertest request so it carries the current revision when it ends.
 * A test that already set `If-Match` keeps its own.
 */
export function withReadRevision(
  prisma: PrismaClient,
  path: string,
  test: Test,
): Test {
  const end = test.end.bind(test);
  test.end = ((callback: Parameters<Test['end']>[0]) => {
    const own = (test as unknown as { header: Record<string, string> }).header[
      'If-Match'
    ];
    const ready = own
      ? Promise.resolve()
      : currentRevision(prisma, path).then((revision) => {
          if (revision) test.set('If-Match', revision);
        });
    void ready.then(
      () => end(callback),
      (error: unknown) => callback?.(error as Error, undefined as never),
    );
    return test;
  }) as Test['end'];
  return test;
}
