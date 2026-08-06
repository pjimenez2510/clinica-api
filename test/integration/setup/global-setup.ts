import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

const run = promisify(execFile);

/**
 * Boots one PostgreSQL 18 container for the whole integration run.
 *
 * WHY A REAL DATABASE: every guarantee these tests cover lives in PostgreSQL,
 * not in TypeScript — EXCLUDE constraints, triggers, generated columns, plpgsql
 * functions. A mocked repository would return whatever we told it to and prove
 * nothing. The appointment non-overlap rule is enforced by a GiST index; the
 * only way to know it works is to ask the database to break it.
 *
 * The version is pinned to the one in docker-compose. Testing against a
 * different major would be testing a database we do not deploy — `uuidv7()` and
 * `WITHOUT OVERLAPS` only exist from 18 on.
 */
const POSTGRES_IMAGE = 'postgres:18-alpine';

/**
 * NOT `postgres`. Testcontainers implements snapshots by dropping and
 * recreating the database from a template, and `DROP DATABASE postgres` is
 * refused by the server.
 */
const DATABASE_NAME = 'clinica_test';

let container: StartedPostgreSqlContainer;

export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(DATABASE_NAME)
    .withUsername('clinica')
    .withPassword('clinica')
    .start();

  const databaseUrl = container.getConnectionUri();

  // The real migrations, not `db push`. Pushing rebuilds the schema from
  // schema.prisma and would silently drop every constraint under test — which
  // is exactly the failure these tests exist to catch.
  await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  // Snapshot AFTER migrating: restoring returns to a migrated-but-empty
  // database, so each test file starts from a known state without paying for
  // the migrations again. Nothing may hold a connection at this point — the
  // Prisma CLI has already exited, so nothing does.
  await container.snapshot();

  project.provide('databaseUrl', databaseUrl);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string;
  }
}
