import type { PrismaClient } from '@prisma/client';

/**
 * The race the clinical review of agenda found: reception marks «se fue sin ser
 * atendido», or the doctor annuls the attention, WHILE a prescription or an
 * order is being written on it. Agenda locks the encounter row FOR UPDATE when
 * it annuls; a writer that also locks it before writing is serialised behind
 * that and sees the attention as it ended up.
 *
 * This runs `attempt` WHILE another transaction holds the encounter locked and
 * has already annulled it, and releases that transaction only once `attempt`
 * is provably waiting on the lock (`pg_stat_activity`). No sleep decides the
 * order: the database says who is waiting.
 *
 * Without the writer's `FOR UPDATE`, `attempt` reads the attention as still
 * open (the annulment is not committed yet) and its insert waits only for the
 * foreign-key share lock, then writes into an annulled attention — which is
 * what the tests using this must catch.
 */
export async function attemptWhileAnnulled<T>(
  prisma: PrismaClient,
  encounterId: string,
  attempt: () => Promise<T>,
): Promise<PromiseSettledResult<T>> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const lockTaken = new Promise<void>((resolve) => {
    locked = resolve;
  });

  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM encounter WHERE id = ${encounterId}::uuid FOR UPDATE`;
      await tx.$executeRaw`
        UPDATE encounter
           SET status = 'ENTERED_IN_ERROR', ended_at = now()
         WHERE id = ${encounterId}::uuid
      `;
      locked();
      await gate;
    },
    { timeout: 30_000, maxWait: 30_000 },
  );

  await lockTaken;
  const outcome = Promise.allSettled([attempt()]).then(([result]) => result);

  // Wait until the attempt is blocked on a lock: the database is the clock.
  for (let tries = 0; tries < 500; tries += 1) {
    const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting
        FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database()
    `;
    if (Number(row!.waiting) > 0) break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  release();
  await holder;
  return outcome;
}
