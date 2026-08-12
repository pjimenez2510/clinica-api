#!/usr/bin/env node
/**
 * PreToolUse hook for Bash. Blocks commands that can silently destroy work
 * this project depends on.
 *
 * WHY THIS EXISTS. Every rule blocked here is already written in prose in
 * CLAUDE.md or in an ADR, and prose is context, not a guarantee. These four
 * commands share one property: by the time the damage is visible, it is done.
 *
 * Exit 2 blocks the tool call and cannot be overridden by a permission
 * decision. Exit 0 lets the normal permission flow proceed.
 */

const RULES = [
  {
    // `prisma migrate dev` already generated a migration that dropped generated
    // columns, trigram indexes and constraints that exist in SQL and not in
    // schema.prisma. It was caught by reading the diff. Once.
    pattern:
      /(^|[;&|]\s*)(pnpm(\s+(exec|run|dlx))?\s+|npx\s+|yarn\s+)?prisma\s+migrate\s+dev\b/,
    reason:
      'Bloqueado: `prisma migrate dev` genera migraciones destructivas en este esquema ' +
      '(ya borró columnas generadas, índices trigram y constraints escritos a mano). ' +
      'Usa `pnpm db:migrate:new`, lee la migración entera y aplícala con `pnpm db:deploy`.',
  },
  {
    // `db push` diffs the schema against the database and "fixes" it. Every
    // EXCLUDE, trigger and generated column written by hand is a difference.
    pattern:
      /(^|[;&|]\s*)(pnpm(\s+(exec|run|dlx))?\s+|npx\s+|yarn\s+)?prisma\s+db\s+push\b/,
    reason:
      'Bloqueado: `prisma db push` eliminaría todos los objetos SQL que no están en ' +
      'schema.prisma — los dos EXCLUDE de agenda, los triggers de inmutabilidad y las ' +
      'columnas generadas. Este proyecto usa migraciones, nunca push.',
  },
  {
    // Migrations must go through `migrations:check`, which is what `db:reset`
    // runs first.
    pattern:
      /(^|[;&|]\s*)(pnpm(\s+(exec|run|dlx))?\s+|npx\s+|yarn\s+)?prisma\s+migrate\s+reset\b/,
    reason:
      'Bloqueado: usa `pnpm db:reset`, que corre `migrations:check` antes de destruir la base ' +
      'y vuelve a sembrar. Llamar a prisma directamente se salta esa guarda.',
  },
  {
    // The user links and pushes the repositories himself. Decided in August 2026.
    pattern: /(^|[;&|]\s*)git\s+(push|remote\s+add)\b/,
    reason:
      'Bloqueado: el usuario vincula y publica los repositorios él mismo. ' +
      'Deja el trabajo commiteado en local y díselo.',
  },
  {
    // No AI attribution in commits or PRs. Non-negotiable.
    pattern:
      /git\s+commit[\s\S]*?(claude|anthropic|co-authored-by:\s*(?!.*@)|generated\s+with)/i,
    reason:
      'Bloqueado: los commits de este proyecto no mencionan a Claude ni a ninguna IA, ' +
      'ni en el mensaje ni en trailers. Reescribe el mensaje sin atribución.',
  },
];

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let command = '';
try {
  command = JSON.parse(raw)?.tool_input?.command ?? '';
} catch {
  // Unparseable input is not a reason to block a developer's shell.
  process.exit(0);
}

for (const rule of RULES) {
  if (rule.pattern.test(command)) {
    process.stderr.write(`${rule.reason}\n`);
    process.exit(2);
  }
}

process.exit(0);
