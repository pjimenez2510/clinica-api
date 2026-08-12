#!/usr/bin/env node
/**
 * PreToolUse hook for Edit and Write. Freezes migrations once they are shared.
 *
 * THE RULE: a migration file that git already tracks is immutable. An
 * untracked one is still a draft and can be edited freely — which is exactly
 * the workflow this project needs, because every generated migration must be
 * read and corrected BEFORE being applied.
 *
 * Editing an applied migration is the worst kind of change: it works on the
 * machine that already ran it and breaks every environment that has not.
 */

import { execFileSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';

const MIGRATION = /prisma[\\/]migrations[\\/][^\\/]+[\\/].+\.sql$/;

/**
 * A module spec written under any casing other than `SPEC.md`.
 *
 * macOS mounts APFS case-insensitively by default, so `spec.md` and `SPEC.md`
 * are THE SAME FILE. Spec Kit writes `spec.md`; the traceability test reads
 * `SPEC.md`. Pointing Spec Kit at a module directory would therefore overwrite
 * the module specification with a template — silently, with no git conflict and
 * no error. Drafts belong in `.specify/drafts/<module>/` and are merged by hand.
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
      'Los borradores de Spec Kit van a `.specify/drafts/<módulo>/`; el SPEC.md se actualiza ' +
      'fusionando a mano lo que valga la pena.\n',
  );
  process.exit(2);
}

if (!filePath || !MIGRATION.test(filePath)) process.exit(0);

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
