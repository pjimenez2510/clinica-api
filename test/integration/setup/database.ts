import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, inject } from 'vitest';

/**
 * A Prisma client bound to the throwaway container, plus isolation between
 * tests.
 *
 * ISOLATION STRATEGY: truncate every table between tests, in one statement.
 *
 * The alternative — wrapping each test in a transaction and rolling back — is
 * faster and is deliberately NOT used. Code under test opens its own
 * transactions; nesting them turns real COMMITs into savepoints, and the moment
 * that happens deferred constraint violations stop surfacing. In a system that
 * issues tax documents that is the one class of bug we cannot afford to hide.
 *
 * Testcontainers' `restoreSnapshot()` is not reachable from here either: the
 * container object lives in the global-setup process, not in this one.
 *
 * The table list is read from the catalog rather than hardcoded, so a new model
 * is covered the day it is added instead of leaking rows into the next test.
 */
export function useDatabase(): () => PrismaClient {
  let prisma: PrismaClient;
  let truncateStatement: string;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: inject('databaseUrl') }),
    });
    await prisma.$connect();

    const tables = await prisma.$queryRaw<{ name: string }[]>`
      SELECT quote_ident(tablename) AS name
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
    `;
    // CASCADE resolves the foreign-key graph on its own, so no ordering is
    // needed. RESTART IDENTITY keeps sequences from drifting across tests.
    truncateStatement = `TRUNCATE TABLE ${tables
      .map((t) => t.name)
      .join(', ')} RESTART IDENTITY CASCADE`;
  });

  afterEach(async () => {
    // `access_audit` carries a trigger that refuses TRUNCATE — that is the
    // point of the table, and there is a test proving it. Replica mode is the
    // escape hatch the trigger's own comment describes.
    //
    // INSIDE A TRANSACTION, AND `SET LOCAL`. Not decoration:
    // `PrismaPg` is a POOL. Three loose `$executeRawUnsafe` calls are three
    // independent checkouts, so the SET, the TRUNCATE and the restore are not
    // guaranteed to land on the same connection. The first test to issue
    // concurrent queries grows the pool, and then the restore can miss —
    // leaving a connection stuck in replica mode with EVERY user trigger
    // disabled. A later test picking up that connection would find a signed
    // note editable and report the safety property as passing when nothing
    // was actually enforced. A test that passes vacuously is worse than one
    // that fails.
    //
    // `$transaction` pins one connection, and `SET LOCAL` is reverted by the
    // COMMIT or the ROLLBACK — so no failure path can leave replica mode on,
    // and no `finally` is needed. `lock_timeout` stops an open transaction
    // elsewhere from stalling the run for the full three-minute hook timeout.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`); // prettier-ignore
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
      await tx.$executeRawUnsafe(truncateStatement);
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  return () => prisma;
}
