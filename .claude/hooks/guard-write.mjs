#!/usr/bin/env node
/**
 * PreToolUse hook for Edit and Write. Freezes migrations once they are shared.
 *
 * THE RULE, AND WHEN IT APPLIES: a migration file that git already tracks is
 * immutable — but only once there IS somewhere else that ran it. That is what
 * `scripts/database-phase.mjs` declares, and while it says `development` this
 * guard stands down: with no production installation, editing the SQL and
 * re-running `pnpm db:reset` is the loop Prisma itself recommends, and the
 * alternative — piling a correction on top of a mistake because the file is
 * frozen — ends in a worse model for no benefit.
 *
 * Editing an applied migration is otherwise the worst kind of change: it works
 * on the machine that already ran it and breaks every environment that has not.
 *
 * ⚠️ This says NOTHING about `prisma migrate dev` or `db push`. Those stay
 * blocked in `guard-bash.mjs` in every phase, because they delete the 20 SQL
 * objects `schema.prisma` cannot describe. Different risk, different guard.
 */

import { execFileSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';

import { MIGRATIONS_ARE_REWRITABLE } from '../../scripts/database-phase.mjs';

const MIGRATION = /prisma[\\/]migrations[\\/][^\\/]+[\\/].+\.sql$/;

/**
 * A module spec written under any casing other than `SPEC.md`.
 *
 * macOS mounts APFS case-insensitively by default, so `spec.md` and `SPEC.md`
 * are THE SAME FILE. The traceability test reads `SPEC.md`; any tool that writes
 * the conventional lowercase `spec.md` into a module directory would overwrite
 * the module specification silently, with no git conflict and no error.
 */
const MODULE_SPEC = /src[\\/]modules[\\/][^\\/]+[\\/]spec\.md$/i;

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let filePath = '';
try {
  filePath = JSON.parse(raw)?.tool_input?.file_path ?? '';
} catch {
  process.exit(0);
}

if (MODULE_SPEC.test(filePath) && !filePath.endsWith('SPEC.md')) {
  process.stderr.write(
    `Bloqueado: en este sistema de archivos \`spec.md\` y \`SPEC.md\` son el mismo archivo, ` +
      'así que escribir ahí destruiría la especificación del módulo sin dejar rastro.\n' +
      'La especificación del módulo se edita en `SPEC.md`, en mayúsculas.\n',
  );
  process.exit(2);
}

if (!filePath || !MIGRATION.test(filePath)) process.exit(0);

// Pre-production: the migration history is still a draft in its entirety.
if (MIGRATIONS_ARE_REWRITABLE) process.exit(0);

const absolute = resolve(filePath);

/** Tracked by git means: it has been committed, so somebody else may have run it. */
function isTracked(path) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', path], {
      cwd: dirname(path),
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

if (isTracked(absolute)) {
  process.stderr.write(
    `Bloqueado: \`${relative(process.cwd(), absolute)}\` es una migración ya versionada, ` +
      'y por tanto posiblemente aplicada en otro entorno. Editarla deja las bases de datos ' +
      'divergentes en silencio.\n' +
      'Crea una migración nueva con `pnpm db:migrate:new`. Si de verdad hay que corregir esta, ' +
      'lo decide el usuario, no el agente.\n',
  );
  process.exit(2);
}

process.exit(0);
