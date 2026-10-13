import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import type { LlmClient } from '../../src/modules/assistant/application/llm-client.port.ts';
import type { Pseudonymizer } from '../../src/modules/assistant/application/pseudonymizer.port.ts';
import { readPreparation } from '../../src/modules/assistant/application/read-preparation.ts';
import { AssistantSpendingCeilingReachedError } from '../../src/modules/assistant/domain/assistant.errors.ts';
import type { TranscriptLine } from '../../src/modules/assistant/domain/note-draft.ts';
import {
  sentencesOf,
  type PreparationProposal,
} from '../../src/modules/assistant/domain/preparation-reading.ts';
import { dictationTranscriberFor } from '../../src/modules/assistant/infrastructure/clinica-ai.dictation-transcriber.ts';
import {
  DEMO_PRICES,
  DemoLlmProvider,
} from '../../src/modules/assistant/infrastructure/demo/demo-llm.provider.ts';
import { caseText } from '../case-text.ts';
import {
  EVAL_PROVIDER_CAP_USD,
  FileAiRunStore,
  ledgerDirFrom,
  ProviderCapStore,
} from '../ledger.ts';
import { ceilingFrom, clientFor, realProviders } from '../providers.ts';

import {
  loadPreparationCases,
  loadPreparationHeard,
  PREPARATION_HEARD,
  WORDING_CASES,
  reservedDictations,
  reservedDictationsHeard,
  type HeardFile,
  type PreparationCase,
} from './cases.ts';
import { hearPreparations, SPEAKER_VOICES } from './hear.ts';
import { renderPreparationReport } from './report.ts';
import {
  LINE_STRIDE_MS,
  scoreCase,
  summarise,
  verdict,
  type ScoredCase,
} from './score.ts';

export const USAGE = `La preparación escuchada (B3, AS-255): la lectura del producto sobre preparaciones inventadas

  pnpm eval:preparacion -- --falso         sin red: el lector de demostración, para probar el arnés
  pnpm eval:preparacion                    con el proveedor (Gemini), las claves del .env de este worktree
  pnpm eval:preparacion -- --oir           vuelve a decir cada línea con una voz por persona y la transcribe con clinica-ai

Opciones:
  --brazos escrito,oido          qué brazos (por defecto los dos)
  --sets preparaciones,motivo,reservado-b2   qué casos (por defecto los tres; del motivo y del reservado de B2 sólo el texto escrito)
  --casos <n>                    sólo los n primeros de cada set
  --gasto-maximo <usd>           lo más que gasta ESTA corrida en el proveedor (por defecto 0,20; D-241)
  --proveedor gemini             el proveedor medido (por defecto el principal)
  --etiqueta <texto>             nombre de la carpeta de resultados
  --ids P10:oido,B2-V06:escrito  sólo esos casos y brazos

Sólo casos inventados (EV-1), sin seudonimizador (EV-2). Mira el registro compartido antes de cada intento.`;

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

const print = (line: string): void => void process.stdout.write(`${line}\n`);

/** EV-2. The cases are invented: nothing to clear, and the one door says so. */
const invented: Pseudonymizer = {
  pseudonymize: ({ text }) =>
    Promise.resolve({ cleared: caseText(text), replacements: [], dateShiftDays: 0 }), // prettier-ignore
};

/** The lines as the listening keeps them: ten seconds apart, in order. */
const asLines = (texts: readonly string[]): TranscriptLine[] =>
  texts.map((text, at) => ({ startMs: at * LINE_STRIDE_MS, endMs: at * LINE_STRIDE_MS + 9_000, text })); // prettier-ignore

interface Run {
  item: PreparationCase;
  arm: ScoredCase['arm'];
  voice: string;
  texts: string[];
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      falso: { type: 'boolean', default: false },
      oir: { type: 'boolean', default: false },
      brazos: { type: 'string', default: 'escrito,oido' },
      sets: { type: 'string', default: 'preparaciones,motivo,reservado-b2' },
      casos: { type: 'string' },
      'gasto-maximo': { type: 'string', default: '0.20' },
      proveedor: { type: 'string', default: 'gemini' },
      ids: { type: 'string' },
      etiqueta: { type: 'string' },
      ayuda: { type: 'boolean', default: false },
    },
  });
  if (values.ayuda) return print(USAGE);

  const { cases, sha256 } = loadPreparationCases();
  if (values.oir) {
    const transcriber = dictationTranscriberFor({
      url: process.env.ASSISTANT_AI_SERVICE_URL ?? 'http://127.0.0.1:8100',
      secret: process.env.ASSISTANT_AI_SERVICE_SECRET || undefined,
      timeoutMs: 60_000,
    });
    const heard = await hearPreparations(cases, transcriber, (done, total) =>
      process.stderr.write(`\r${done}/${total}`),
    );
    process.stderr.write('\n');
    const file: HeardFile = {
      origin: 'invented',
      description: `Lo que clinica-ai oyó de cada línea de preparaciones.json dicha por una voz sintética de macOS por persona (${Object.entries(SPEAKER_VOICES).map(([who, voice]) => `${who}: ${voice}`).join(', ')}), sin ruido (AS-255). El audio no se guardó.`, // prettier-ignore
      casesSha256: sha256,
      heard,
    };
    writeFileSync(PREPARATION_HEARD, `${JSON.stringify(file, null, 2)}\n`);
    return print(`Oídas ${heard.length} preparaciones → ${PREPARATION_HEARD}`);
  }

  const limit = values.casos ? Number(values.casos) : Infinity;
  const arms = values.brazos.split(',');
  const sets = values.sets.split(',');
  const runs: Run[] = [];
  if (sets.includes('preparaciones')) {
    const own = cases.slice(0, limit);
    if (arms.includes('escrito')) {
      runs.push(...own.map((item) => ({ item, arm: 'escrito' as const, voice: '—', texts: item.lines.map((line) => line.text) }))); // prettier-ignore
    }
    if (arms.includes('oido')) {
      const heard = new Map(loadPreparationHeard(sha256).map((each) => [each.id, each.lines])); // prettier-ignore
      runs.push(...own.map((item) => ({ item, arm: 'oido' as const, voice: 'por persona', texts: heard.get(item.id) ?? [] }))); // prettier-ignore
    }
  }
  // AS-284. Its own set, written text only: nothing of it was heard.
  if (sets.includes('motivo') && arms.includes('escrito')) {
    const own = loadPreparationCases(WORDING_CASES).cases.slice(0, limit);
    runs.push(...own.map((item) => ({ item, arm: 'escrito' as const, voice: '—', texts: item.lines.map((line) => line.text) }))); // prettier-ignore
  }
  if (
    sets.includes('reservado-b2') &&
    arms.includes('oido') &&
    !sets.includes('reservado-b2-oido')
  ) {
    // prettier-ignore
    print('Del reservado de B2 sólo el texto escrito: lo oído, con --sets …,reservado-b2-oido (240 lecturas).'); // prettier-ignore
  }
  if (sets.includes('reservado-b2')) {
    const reserved = reservedDictations().slice(0, limit);
    if (arms.includes('escrito')) {
      runs.push(...reserved.map((item) => ({ item, arm: 'escrito' as const, voice: '—', texts: item.lines.map((line) => line.text) }))); // prettier-ignore
    }
    if (arms.includes('oido') && sets.includes('reservado-b2-oido')) {
      const byId = new Map(reserved.map((item) => [item.id, item]));
      for (const clip of reservedDictationsHeard()) {
        const item = byId.get(clip.id);
        if (item) runs.push({ item, arm: 'oido', voice: clip.voice, texts: clip.lines }); // prettier-ignore
      }
    }
  }

  // Only some cases, to measure again what a scoring fix touched.
  if (values.ids) {
    const ids = new Set(values.ids.split(','));
    runs.splice(0, runs.length, ...runs.filter((run) => ids.has(`${run.item.id}:${run.arm}`))); // prettier-ignore
  }

  // EV-3, D-241. The provider behind its switch, under its cap in the shared
  // ledger: what it had spent when the run started, plus this run's budget.
  const budget = Number(values['gasto-maximo']);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('--gasto-maximo: un importe en USD'); // prettier-ignore
  let llm: LlmClient;
  let provider: string;
  if (values.falso) {
    const ledger = new FileAiRunStore(mkdtempSync(join(tmpdir(), 'preparacion-falso-'))); // prettier-ignore
    llm = clientFor(new DemoLlmProvider(), { store: ledger, ceilingUsd: 1, timeoutMs: 60_000, clock: () => new Date(), prices: DEMO_PRICES }); // prettier-ignore
    provider = 'demostración';
  } else {
    const measured = realProviders(process.env).measured.find((each) => each.name === values.proveedor); // prettier-ignore
    if (!measured) throw new Error(`«${values.proveedor}» no tiene clave en el .env de este worktree`); // prettier-ignore
    const ceilingUsd = ceilingFrom(process.env.ASSISTANT_MONTHLY_SPEND_CEILING_USD); // prettier-ignore
    if (ceilingUsd === undefined) throw new Error('Sin ASSISTANT_MONTHLY_SPEND_CEILING_USD no hay ninguna llamada (AS-017)'); // prettier-ignore
    const ledger = new FileAiRunStore(ledgerDirFrom(process.env));
    const before = new ProviderCapStore(ledger, ledger, measured.name, 0, 0).spentByProvider(); // prettier-ignore
    // D-241: never above the 2 USD a provider may spend in total (revisión I1).
    if (before >= EVAL_PROVIDER_CAP_USD) throw new Error(`${measured.name} ya gastó su tope de ${EVAL_PROVIDER_CAP_USD} USD (D-241)`); // prettier-ignore
    const cap = Math.min(before + budget, EVAL_PROVIDER_CAP_USD);
    const store = new ProviderCapStore(ledger, ledger, measured.name, cap, ceilingUsd); // prettier-ignore
    llm = clientFor(measured, { store, ceilingUsd, timeoutMs: Number(process.env.ASSISTANT_PROVIDER_TIMEOUT_MS) || 60_000, clock: () => new Date() }); // prettier-ignore
    provider = measured.name;
    print(`${measured.name} llevaba ${before.toFixed(3)} USD en el registro; esta corrida, como mucho ${budget.toFixed(2)} USD.`); // prettier-ignore
  }

  const scored: ScoredCase[] = [];
  const failures: Record<string, number> = {};
  let stopped: string | null = null;
  for (const [index, run] of runs.entries()) {
    const lines = asLines(run.texts).filter((line) => line.text.trim() !== '');
    let reading: PreparationProposal | null = null;
    let latencyMs: number | null = null;
    if (lines.length > 0) {
      const started = Date.now();
      try {
        reading = (await readPreparation({ pseudonymizer: invented, llm }, { subject: run.item.id, names: [], staff: [], lines })).proposal; // prettier-ignore
        latencyMs = Date.now() - started;
      } catch (error) {
        if (error instanceof AssistantSpendingCeilingReachedError) {
          stopped = 'el tope de gasto de la corrida';
          break;
        }
        // A code, never a message: a provider's error can quote the input.
        const code = (error as { code?: string }).code ?? (error as Error).name;
        failures[code] = (failures[code] ?? 0) + 1;
      }
    }
    // The sentences the reading answered by (AS-250); a silent line has none.
    scored.push(scoreCase({ item: run.item, arm: run.arm, voice: run.voice, lines: sentencesOf(lines), reading, latencyMs })); // prettier-ignore
    process.stderr.write(`\r${index + 1}/${runs.length}`);
  }
  process.stderr.write('\n');

  const startedAt = clinicStamp(new Date());
  const label =
    values.etiqueta ?? `b3-preparacion${values.falso ? '-falso' : ''}`;
  const groups = {
    escrito: scored.filter((each) => each.arm === 'escrito' && /^P/.test(each.id)), // prettier-ignore
    oido: scored.filter((each) => each.arm === 'oido' && /^P/.test(each.id)), // prettier-ignore
    motivo: scored.filter((each) => each.id.startsWith('M')),
    'reservado-b2': scored.filter((each) => each.id.startsWith('B2-')),
  };
  const summaries = Object.fromEntries(Object.entries(groups).filter(([, each]) => each.length > 0).map(([name, each]) => [name, summarise(each)])); // prettier-ignore
  const verdicts = Object.fromEntries(Object.entries(summaries).map(([name, summary]) => [name, verdict(summary)])); // prettier-ignore
  const meta = {
    label,
    startedAt,
    commit: gitCommit(),
    provider,
    casesSha256: sha256,
    stopped,
    failures,
    cases: scored.length,
    planned: runs.length,
  };
  const base = join(process.cwd(), 'eval', 'resultados', `${startedAt.slice(0, 16).replace(/[: ]/g, '-')}-${label}`); // prettier-ignore
  let folder = base;
  for (let n = 2; existsSync(folder); n += 1) folder = `${base}-${n}`;
  mkdirSync(folder, { recursive: true });
  // B2's reserved set is reported in figures only: its phrases are not copied.
  const serious = scored.flatMap(
    (each) =>
    each.values
      .filter((value) => value.outcome === 'wrong' || value.outcome === 'invented') // prettier-ignore
      .map((value) => ({ id: each.id, arm: each.arm, voice: each.voice, ...value })), // prettier-ignore
  );
  // Revisión (seguridad): B2's reserved set leaves no value in the results,
  // only whether each was right — nothing to tune it on.
  const figuresOnly = <T extends { id: string }>(row: T) =>
    row.id.startsWith('B2-') ? { ...row, values: undefined, expected: undefined, got: undefined } : row; // prettier-ignore
  writeFileSync(join(folder, 'resultado.json'), `${JSON.stringify({ ...meta, summaries, verdicts, serious: serious.map(figuresOnly), scored: scored.map(figuresOnly) }, null, 2)}\n`); // prettier-ignore
  writeFileSync(join(folder, 'informe.md'), renderPreparationReport({ meta, summaries, verdicts, scored, cases: [...cases, ...loadPreparationCases(WORDING_CASES).cases] })); // prettier-ignore

  for (const [name, summary] of Object.entries(summaries)) {
    const v = verdicts[name]!;
    print(`${name}: ${summary.correct}/${summary.expected} (${(summary.correctRate.rate * 100).toFixed(1)} %), graves ${summary.serious}, fuera de su frase ${summary.notLiteral}, motivo ${summary.complaintRight}/${summary.complaintSaid} (inventados ${summary.complaintInvented}, redactados ${summary.complaintWorded}/${summary.complaintProposed}, redactados sin poder ${summary.complaintUnfaithful}), hablante ${summary.speakersRight}/${summary.lines}, p90 ${summary.p90Ms ?? '—'} ms · SC-099 ${v.sc099 ? '✓' : '✗'} SC-100 ${v.sc100 ? '✓' : '✗'} SC-101 ${v.sc101 ? '✓' : '✗'}`); // prettier-ignore
  }
  if (Object.keys(failures).length > 0) {
    print(`Sin respuesta, por código: ${JSON.stringify(failures)}`);
  }
  if (stopped)
    print(`Detenida por ${stopped}: ${scored.length}/${runs.length} lecturas.`);
  print(`→ ${folder}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); // prettier-ignore
  process.exitCode = 1;
});
