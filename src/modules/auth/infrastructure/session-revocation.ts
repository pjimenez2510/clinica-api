import { Prisma } from '@prisma/client';

/** Every session of one account, or one session. */
export type SessionScope = { userId: string } | { familyId: string };

/**
 * Locks the live rows of the scope, oldest first, until the transaction ends.
 * The first half of `revokeLiveSessions`, and what AU-039 takes before it
 * checks anything: see there for why the order matters.
 */
export async function lockLiveSessions(
  tx: Prisma.TransactionClient,
  scope: SessionScope,
): Promise<void> {
  const column =
    'userId' in scope
      ? Prisma.sql`user_id = ${scope.userId}::uuid`
      : Prisma.sql`family_id = ${scope.familyId}::uuid`;

  await tx.$queryRaw`
    SELECT id FROM refresh_token
     WHERE ${column} AND revoked_at IS NULL
     ORDER BY created_at, id
       FOR UPDATE`;
}

/**
 * AU-004, AU-023, AU-036, AU-039. THE ONE WAY sessions are closed: sign-out,
 * deactivation, password change, second-factor reset and credential
 * redemption all go through here, inside their own transaction.
 *
 * LOCK FIRST, WRITE AFTER, in two statements. A single `UPDATE … WHERE
 * revoked_at IS NULL` reads the rows from the snapshot it started with: if a
 * rotation or an AU-039 re-issue was committing a successor meanwhile, the
 * update waited on the presented row and then revoked it — but never saw the
 * successor, which stayed alive, and `isFamilyOpen` kept the session open.
 * Locking the live rows makes this wait for that transaction; the `UPDATE`
 * then starts with a fresh snapshot that includes whatever it committed.
 *
 * `ORDER BY created_at, id` is the order every other locker follows — a token
 * before its successors — so two of them cannot deadlock. A path that kept its
 * own `updateMany` would lock in index order and could.
 *
 * Returns how many rows were still live: 0 means the scope was already closed.
 */
export async function revokeLiveSessions(
  tx: Prisma.TransactionClient,
  scope: SessionScope,
  reason: string,
  at: Date = new Date(),
): Promise<number> {
  await lockLiveSessions(tx, scope);

  const { count } = await tx.refreshToken.updateMany({
    where: { ...scope, revokedAt: null },
    data: { revokedAt: at, revocationReason: reason },
  });
  return count;
}
