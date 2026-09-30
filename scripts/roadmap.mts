/**
 * `pnpm roadmap:check` — fails when `clinica-docs/ROADMAP.md` disagrees with
 * the real state of `main`. `pnpm roadmap:write` — rewrites the part that can
 * be computed and the date. Only the principal session runs `:write` (a hook
 * enforces it); the principal's Stop runs `:check`.
 *
 * WHY. The author's main rule is that the ROADMAP is always up to date. On
 * 30-09 it said «18 de agosto» at the top and had screens that existed marked
 * `[ ]`: six weeks of drift nobody could see, because nothing compared it with
 * anything. This compares two things mechanically:
 *
 * 1. The block between `<!-- estado:inicio -->` and `<!-- estado:fin -->`: the
 *    flows (on screen or not, from their Playwright walks) and every
 *    deliverable with its backend and interface coverage, computed by
 *    `board.mts` over `main` of both repositories. Read through git, so the
 *    answer does not depend on which branch a folder has checked out.
 * 2. `**Última actualización:**` must not be older than the last commit on
 *    `main` of `clinica-api` or `clinica-web`: something merged after the
 *    ROADMAP was last looked at.
 *
 * What it cannot check is the prose and the `[x]/[~]/[ ]` marks of each line;
 * those remain the principal's judgement, with this block beside them.
 *
 * Usage: node --experimental-strip-types scripts/roadmap.mts --check | --write
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  computeBoard,
  computeFlows,
  gitSource,
  workingTree,
  workspaceOf,
} from './board.mts';

const MODE = process.argv.includes('--write') ? 'write' : 'check';
const REF = 'main';
const where = workspaceOf(process.cwd());
const ROADMAP = join(where.docs, 'ROADMAP.md');
const START = '<!-- estado:inicio';
const END = '<!-- estado:fin -->';
const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
/** «setiembre» is how Ecuador writes it; both spellings are the ninth month. */
const monthIndex = (name: string): number => {
  const m = name.toLowerCase();
  return m === 'setiembre' ? 8 : MONTHS.indexOf(m);
};
const DATE_LINE =
  /^\*\*Última actualización:\*\*\s*(\d{1,2}) de (\w+) de (\d{4})/m;

/** `YYYY-MM-DD` of an instant, in America/Guayaquil — never the session's zone. */
const guayaquilDay = (instant: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

function lastCommitDay(repo: string): string {
  const iso = execFileSync(
    'git',
    ['-C', repo, 'log', '-1', '--format=%cI', REF],
    {
      encoding: 'utf8',
    },
  ).trim();
  return guayaquilDay(new Date(iso));
}

function renderBlock(): string {
  const api = gitSource(where.api, REF);
  const web = gitSource(where.web, REF);
  const board = computeBoard(api, web);
  const flows = computeFlows(workingTree(where.docs), web, board, (result) => {
    if (!result.commit || result.dirty) return false;
    try {
      execFileSync(
        'git',
        ['-C', where.web, 'merge-base', '--is-ancestor', result.commit, REF],
        {
          stdio: 'ignore',
        },
      );
      return true;
    } catch {
      return false;
    }
  });

  const lines = [
    `${START} — generado por \`pnpm roadmap:write\` en clinica-api sobre \`main\`; no se edita a mano -->`,
    '',
    '### Flujos',
    '',
    '| Flujo | Quién | En pantalla | Entregas completas |',
    '| --- | --- | --- | --- |',
    ...flows.map((f) => {
      const screen = f.reachable
        ? `✔ ${f.result!.date}`
        : !f.walkExists
          ? '✘ sin recorrido'
          : f.result?.passed
            ? `✘ pasó el ${f.result.date}, pero no sobre un commit limpio de main`
            : f.result
              ? `✘ falló el ${f.result.date}`
              : '✘ sin correr';
      return `| ${f.id} ${f.title} | ${f.actor} | ${screen} | ${f.complete}/${f.known} |`;
    }),
    '',
    '### Entregas por módulo',
    '',
    '| Módulo | Entrega | Backend | Interfaz | Estado |',
    '| --- | --- | --- | --- | --- |',
  ];
  let total = 0;
  let complete = 0;
  for (const m of board) {
    for (const d of m.deliverables) {
      total += 1;
      if (d.state === 'completo') complete += 1;
      lines.push(
        `| ${m.module} | ${d.id} ${d.title} | ${d.back}/${d.total} | ${d.front}/${d.frontTotal} | ${d.state} |`,
      );
    }
  }
  lines.push(
    '',
    `**${flows.filter((f) => f.reachable).length} de ${flows.length} flujos en pantalla · ` +
      `${complete} de ${total} entregas completas de punta a punta.** En pantalla = su ` +
      'recorrido Playwright pasó en `main`. Completa = todos sus requisitos con prueba en los ' +
      'dos lados, descontando lo declarado «Solo servidor».',
    '',
    END,
  );
  return lines.join('\n');
}

const roadmap = readFileSync(ROADMAP, 'utf8');
const expected = renderBlock();
const startAt = roadmap.indexOf(START);
const endAt = roadmap.indexOf(END);
const current =
  startAt >= 0 && endAt > startAt
    ? roadmap.slice(startAt, endAt + END.length)
    : null;

const lastMain = [lastCommitDay(where.api), lastCommitDay(where.web)]
  .sort()
  .at(-1)!;
const dateMatch = DATE_LINE.exec(roadmap);
const roadmapDay = dateMatch
  ? `${dateMatch[3]}-${String(monthIndex(dateMatch[2]!) + 1).padStart(2, '0')}-${dateMatch[1]!.padStart(2, '0')}`
  : '';

if (MODE === 'write') {
  const today = new Date();
  const day = guayaquilDay(today);
  const [y, mo, d] = day.split('-');
  const dateText = `**Última actualización:** ${Number(d)} de ${MONTHS[Number(mo) - 1]} de ${y}`;
  let next = dateMatch ? roadmap.replace(DATE_LINE, dateText) : roadmap;
  if (current) next = next.replace(current, expected);
  else {
    // First time: the block goes right after «Estado global».
    const global = next.indexOf('## Estado global');
    const anchor = global >= 0 ? next.indexOf('\n---\n', global) : -1;
    if (anchor < 0) {
      console.error(
        'No encuentro «## Estado global» seguido de `---` para colocar el bloque.',
      );
      process.exit(1);
    }
    next = `${next.slice(0, anchor)}\n\n## Estado calculado\n\n${expected}\n${next.slice(anchor)}`;
  }
  writeFileSync(ROADMAP, next);
  console.log(
    `ROADMAP: bloque de estado regenerado sobre main y fecha puesta a ${day}.`,
  );
  console.log(
    'Ahora ajusta la prosa y las marcas [x]/[~]/[ ] a lo que dice el bloque.',
  );
  process.exit(0);
}

const problems: string[] = [];
if (!current)
  problems.push(
    'no tiene el bloque de estado calculado (`<!-- estado:inicio … -->`).',
  );
else if (current !== expected) {
  const had = new Set(current.split('\n'));
  const want = expected.split('\n').filter((l) => !had.has(l));
  problems.push(
    `el bloque de estado no coincide con main (${want.length} líneas distintas), p. ej.:\n    ` +
      want.slice(0, 5).join('\n    '),
  );
}
if (!dateMatch) problems.push('no tiene la línea `**Última actualización:**`.');
else if (roadmapDay < lastMain)
  problems.push(
    `dice «${dateMatch[0].replace(/\*\*/g, '')}» y main tiene commits del ${lastMain}.`,
  );

if (problems.length > 0) {
  console.error(`✘ El ROADMAP está desfasado:\n  - ${problems.join('\n  - ')}`);
  console.error(
    'Corre `pnpm roadmap:write` (solo la sesión principal) y ajusta la prosa.',
  );
  // 3, not 1: a crash also exits 1, and the Stop hook must not call a crash «desfasado».
  process.exit(3);
}
console.log(`✔ ROADMAP al día con main (último commit ${lastMain}).`);
