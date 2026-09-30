/**
 * One board for the whole system: first the flows, then backend and interface
 * module by module.
 *
 * WHY. `pnpm estado` in each repository answers "what do I do next here".
 * Neither answers "can the clinic do this yet", which is the only question
 * that matters: a booking endpoint nobody can reach from a screen is not a
 * delivered feature. A deliverable is DONE only when both halves have tests
 * naming its requirements, and a flow is ON SCREEN only when its Playwright
 * walk passed. The computation lives in `board.mts`; this only prints it.
 *
 * Usage: node --experimental-strip-types scripts/estado-proyecto.mts
 */

import {
  computeBoard,
  computeFlows,
  workingTree,
  workspaceOf,
} from './board.mts';

const where = workspaceOf(process.cwd());
const api = workingTree(where.api);
const web = workingTree(where.web);
const board = computeBoard(api, web);
const flows = computeFlows(workingTree(where.docs), web, board);

/** A four-cell progress bar; dots only when there is nothing to count. */
const bar = (done: number, total: number): string =>
  total === 0
    ? '····'
    : '█'.repeat(Math.round((done / total) * 4)).padEnd(4, '·');

console.log(
  '\n  FLUJO                                   EN PANTALLA      ENTREGAS COMPLETAS',
);
console.log('  ' + '─'.repeat(72));
for (const flow of flows) {
  const screen = flow.reachable
    ? `✔ ${flow.result!.date}`
    : !flow.walkExists
      ? '✘ sin recorrido'
      : flow.result
        ? `✘ falló ${flow.result.date}`
        : '✘ sin correr';
  console.log(
    `  ${flow.id} ${flow.title.slice(0, 34).padEnd(35)} ${screen.padEnd(16)} ` +
      `${bar(flow.complete, flow.known)} ${flow.complete}/${flow.known}`,
  );
}

console.log('\n  MÓDULO / ENTREGA            BACKEND      INTERFAZ     ESTADO');
console.log('  ' + '─'.repeat(66));

let total = 0;
let complete = 0;
for (const module of board) {
  console.log(
    `\n  ■ ${module.module}${module.apiExposed ? '' : '   (la API aún no expone endpoints)'}`,
  );
  for (const d of module.deliverables) {
    total += 1;
    if (d.state === 'completo') complete += 1;
    console.log(
      `    ${d.id.padEnd(3)} ${d.title.slice(0, 22).padEnd(23)}` +
        `${bar(d.back, d.total)} ${String(d.back).padStart(2)}/${String(d.total).padEnd(2)}  ` +
        `${bar(d.front, d.frontTotal)} ${String(d.front).padStart(2)}/${String(d.frontTotal).padEnd(2)}  ${d.state}`,
    );
  }
}

console.log('\n  ' + '─'.repeat(66));
console.log(
  `  ${flows.filter((f) => f.reachable).length} de ${flows.length} flujos alcanzables en pantalla · ` +
    `${complete} de ${total} entregas completas de punta a punta.\n` +
    '  En pantalla = su recorrido Playwright pasó. Completa = TODOS sus requisitos con\n' +
    '  prueba en los DOS lados («Solo servidor» declarado en el SPEC.md, aparte).\n',
);
