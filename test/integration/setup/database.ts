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
    // point of the table, and there is a test below proving it. Replica mode
    // is the escape hatch the trigger's own comment describes: a superuser
    // disabling it deliberately. It is scoped to this session and restored
    // immediately, so it can never be in force while a test runs.
    await prisma.$executeRawUnsafe(`SET session_replication_role = 'replica'`);
    try {
      await prisma.$executeRawUnsafe(truncateStatement);
    } finally {
      await prisma.$executeRawUnsafe(`SET session_replication_role = 'origin'`);
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  return () => prisma;
}
