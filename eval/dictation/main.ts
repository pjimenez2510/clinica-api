import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { readDictatedVitals } from '../../src/modules/assistant/domain/dictated-vitals.ts';
import { dictationTranscriberFor } from '../../src/modules/assistant/infrastructure/clinica-ai.dictation-transcriber.ts';
import { CASES_DIR } from '../cases.ts';

import {
  DICTATION_SETS,
  type DictationSet,
  type HeardFile,
  loadDictationCases,
  loadHeard,
} from './cases.ts';
import { hearAll, VOICES } from './hear.ts';
import { renderDictationReport } from './report.ts';
import { type Cell, cellsOf, tally, verdictOf } from './score.ts';

export const USAGE = `Signos dictados (B2, AS-188): la lectura del producto sobre frases inventadas

  pnpm eval:dictado                 puntúa el texto y lo oído ya guardado
  pnpm eval:dictado -- --oir        vuelve a decir cada frase con las voces del sistema y la transcribe con clinica-ai

Opciones:
  --set desarrollo|reservado   qué frases (por defecto desarrollo; el reservado no se usa para ajustar nada)
  --etiqueta <texto>   nombre de la carpeta de resultados (por defecto b2-signos-dictados)
  --ayuda              esta ayuda

Sin proveedor de modelo y sin base. --oir necesita clinica-ai en ASSISTANT_AI_SERVICE_URL con
ASSISTANT_AI_SERVICE_SECRET, say y ffmpeg; cada clip lanza un whisper-cli de ~2 GB (con-turno).`;

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex'); // prettier-ignore

const clinicStamp = (at: Date) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Guayaquil', dateStyle: 'short', timeStyle: 'medium' }).format(at); // prettier-ignore

function gitCommit(): string {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); // prettier-ignore
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'eval'], { encoding: 'utf8' }).trim(); // prettier-ignore
    return dirty ? `${head}+cambios` : head;
  } catch {
    return 'desconocido';
  }
}

const print = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const { values } = parseArgs({
    // `pnpm eval:dictado -- --oir` passes the `--` on.
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      oir: { type: 'boolean', default: false },
      etiqueta: { type: 'string' },
      set: { type: 'string', default: 'desarrollo' },
      ayuda: { type: 'boolean', default: false },
    },
  });
  if (values.ayuda) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (!(values.set in DICTATION_SETS)) {
    throw new Error('--set: desarrollo o reservado');
  }
  const set = values.set as DictationSet;
  const files = DICTATION_SETS[set];
  const label = values.etiqueta ?? `b2-signos-dictados-${set}`;
  const cases = loadDictationCases(CASES_DIR, files.cases);
  const casesPath = join(CASES_DIR, files.cases);
  const heardPath = join(CASES_DIR, files.heard);

  if (values.oir) {
    const transcriber = dictationTranscriberFor({
      url: process.env.ASSISTANT_AI_SERVICE_URL ?? 'http://127.0.0.1:8100',
      secret: process.env.ASSISTANT_AI_SERVICE_SECRET || undefined,
      timeoutMs: 60_000,
    });
    const heard = await hearAll(cases, transcriber, undefined, (done, total) =>
      process.stderr.write(`\r${done}/${total}`),
    );
    process.stderr.write('\n');
    const file: HeardFile = {
      origin: 'invented',
      description: `Lo que clinica-ai oyó de cada frase inventada de ${files.cases} dicha por voces sintéticas de macOS, sin ruido (AS-188). El audio no se guardó.`,
      casesSha256: sha256(casesPath),
      heard,
    };
    writeFileSync(heardPath, `${JSON.stringify(file, null, 2)}\n`);
  }

  const heardFile = loadHeard(CASES_DIR, files.heard);
  if (heardFile.casesSha256 !== sha256(casesPath)) {
    throw new Error(`${files.heard} se oyó de otras frases: vuelva a correr con --oir`); // prettier-ignore
  }

  const byId = new Map(cases.map((item) => [item.id, item]));
  const heardCells = (): Cell[] =>
    heardFile.heard.flatMap((clip) => {
      const item = byId.get(clip.id);
      if (!item) throw new Error(`${files.heard} trae un caso que no existe: ${clip.id}`); // prettier-ignore
      const voice =
        clip.rate === null ? clip.voice : `${clip.voice} · ${clip.rate}`;
      return cellsOf(
        item,
        'oido',
        voice,
        clip.text,
        readDictatedVitals(clip.text),
      );
    });

  const cells: Cell[] = [
    ...cases.flatMap((item) => cellsOf(item, 'texto', '—', item.text, readDictatedVitals(item.text))), // prettier-ignore
    ...heardCells(),
  ];

  const textTally = tally(cells.filter((cell) => cell.arm === 'texto'));
  const heardTally = tally(cells.filter((cell) => cell.arm === 'oido'));
  const verdict = verdictOf(textTally, heardTally);
  const startedAt = clinicStamp(new Date());
  const meta = {
    label,
    set,
    startedAt,
    commit: gitCommit(),
    casesSha256: sha256(casesPath),
    heardSha256: sha256(heardPath),
    voices: VOICES,
    cases: cases.length,
  };

  const base = join(process.cwd(), 'eval', 'resultados', `${startedAt.slice(0, 16).replace(/[: ]/g, '-')}-${meta.label}`); // prettier-ignore
  let folder = base;
  for (let n = 2; existsSync(folder); n += 1) folder = `${base}-${n}`;
  mkdirSync(folder, { recursive: true });
  const serious = cells.filter((cell) => cell.outcome === 'wrong' || cell.outcome === 'invented'); // prettier-ignore
  writeFileSync(
    join(folder, 'resultado.json'),
    `${JSON.stringify({ ...meta, verdict, texto: textTally, oido: heardTally, serious }, null, 2)}\n`, // prettier-ignore
  );
  writeFileSync(join(folder, 'informe.md'), renderDictationReport(meta, cells, verdict)); // prettier-ignore

  const pct = (t: typeof heardTally) =>
    ((t.correct / t.expected) * 100).toFixed(1);
  print(`Texto: ${textTally.correct}/${textTally.expected} (${pct(textTally)} %), graves ${textTally.serious}`); // prettier-ignore
  print(`Oído:  ${heardTally.correct}/${heardTally.expected} (${pct(heardTally)} %), vacíos ${heardTally.empty}, graves ${heardTally.serious}`); // prettier-ignore
  print(`SC-095 ${verdict.sc095 ? 'cumple' : 'NO cumple'} · SC-096 ${verdict.sc096 ? 'cumple' : 'NO cumple'} → ${folder}`); // prettier-ignore
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
