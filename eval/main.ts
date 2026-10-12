import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { Logger } from '@nestjs/common';

import {
  priceAt,
  worstCaseOf,
} from '../src/modules/assistant/domain/pricing.ts';
import { spendingMonthStart } from '../src/modules/assistant/domain/spending.ts';
import { DEFAULT_MAX_TOKENS } from '../src/modules/assistant/application/llm-client.port.ts';
import { LLM_PRICES } from '../src/modules/assistant/infrastructure/llm-pricing.ts';

import {
  CASES_DIR,
  loadInventedCases,
  readCodiEsp,
  verifyCodiEsp,
} from './cases.ts';
import { loadCatalogues } from './catalogue.ts';
import { FakeWorld } from './fake-world.ts';
import { FileAiRunStore, ledgerDirFrom } from './ledger.ts';
import {
  ceilingFrom,
  clientFor,
  EVAL_CEILING_CAP_USD,
  FAKE_PRICES,
  realProviders,
} from './providers.ts';
import { type RunMetadata, writeResult } from './report.ts';
import {
  type AnyTask,
  type MeasuredProvider,
  runEvaluation,
  TaggingStore,
  type TaskRun,
} from './runner.ts';
import type { EvalCase } from './task.ts';
import { cie10Task, codiEspCases, inventedCie10Cases } from './tasks/cie10.ts';
import { cie10ByProblemTask } from './tasks/cie10-by-problem.ts';
import { JUDGE_PROMPT_VERSION, noteTask } from './tasks/note.ts';
import { prescriptionTask } from './tasks/prescription.ts';
import { draftTask } from './tasks/draft.ts';
import { EVAL_PROVIDER_CAP_USD, ProviderCapStore } from './ledger.ts';
import { prescriptionFromNoteTask } from './tasks/prescription-from-note.ts';

export const USAGE = `Arnés de evaluación del asistente (PLAN-ASISTENTE-IA §5, D-239 §5)

  pnpm eval -- --falso                       corrida completa con el proveedor falso, sin red
  pnpm eval -- --codiesp <carpeta train_dev> corrida real con las claves del .env

Opciones:
  --tareas cie10,receta,nota   qué tareas (por defecto, las tres); cie10-problema mide D1 (AS-042), receta-nota mide D2 (AS-079), borrador mide C2 (AS-098)
  --codiesp <carpeta>          CodiEsp train_dev (CC BY 4.0, Zenodo 3837305); sin ella, la CIE-10 usa sólo el set propio
  --muestra <n>                frases de CodiEsp (por defecto 200)
  --casos <n>                  como mucho n casos de cada set propio (por defecto, todos)
  --proveedores <a,b>          filtra gemini, anthropic, openai
  --juez <proveedor>           quién juzga las notas (por defecto anthropic)
  --intentos <n>               peticiones por caso si el proveedor no está disponible (por defecto 3)
  --etiqueta <texto>           nombre de la carpeta del resultado
  --semilla <n>                semilla de la muestra y del bootstrap (por defecto 42)
  --salida <carpeta>           por defecto eval/resultados
  --estimar                    sólo dice cuántas llamadas y el peor caso de gasto, sin llamar
  --tope-proveedor <usd>       lo más que cada proveedor puede llevar gastado en el registro, contando el intento (D-241)
`;

type Env = Record<string, string | undefined>;
type TaskKey =
  'cie10' | 'cie10-problema' | 'receta' | 'receta-nota' | 'nota' | 'borrador';

export interface Dependencies {
  env: Env;
  now: () => Date;
  /** What the author reads in the terminal: counts, figures and paths, never case text. */
  print: (line: string) => void;
  /** Where the ledger lives: the shared one, or a test's own. */
  ledgerDir?: string;
  fetcher?: typeof fetch;
}

function gitCommit(): string {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const dirty = execFileSync(
      'git',
      ['status', '--porcelain', '--', 'eval', 'src/modules/assistant'],
      {
        encoding: 'utf8',
      },
    ).trim();
    return dirty ? `${head}+cambios` : head;
  } catch {
    return 'desconocido';
  }
}

/** The instant in America/Guayaquil, `2026-10-11 21:50:00`. */
const clinicStamp = (at: Date) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Guayaquil',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(at);

/** A whole number from the command line, or a clear error (`abc` is not 0 cases). */
function positiveInteger(
  name: string,
  value: string,
  { zero = false } = {},
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (zero ? 0 : 1)) {
    throw new Error(`${name}: se esperaba un entero ${zero ? '≥ 0' : '> 0'}`);
  }
  return parsed;
}

/** An amount of dollars from the command line, or a clear error. */
function positiveAmount(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name}: se esperaba un monto en dólares > 0`);
  }
  return parsed;
}

/** EV-7. The prices the costs were computed with. */
function pricingVersion(): { file: string; sha256: string } {
  const file = join(
    process.cwd(),
    'src/modules/assistant/infrastructure/llm-pricing.json',
  );
  return {
    file: 'llm-pricing.json',
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  };
}

/** Runs the harness as `pnpm eval` does; answers the folder of the result, or null. */
export async function runFromArgs(
  argv: readonly string[],
  deps: Dependencies,
): Promise<string | null> {
  const { values } = parseArgs({
    args: argv.filter((argument) => argument !== '--'),
    options: {
      falso: { type: 'boolean', default: false },
      tareas: { type: 'string', default: 'cie10,receta,nota' },
      codiesp: { type: 'string' },
      muestra: { type: 'string', default: '200' },
      casos: { type: 'string' },
      proveedores: { type: 'string' },
      juez: { type: 'string', default: 'anthropic' },
      intentos: { type: 'string', default: '3' },
      etiqueta: { type: 'string' },
      semilla: { type: 'string', default: '42' },
      salida: {
        type: 'string',
        default: join(process.cwd(), 'eval', 'resultados'),
      },
      estimar: { type: 'boolean', default: false },
      'tope-proveedor': { type: 'string' },
      ayuda: { type: 'boolean', default: false },
    },
  });
  if (values.ayuda) {
    deps.print(USAGE);
    return null;
  }
  const seed = positiveInteger('--semilla', values.semilla, { zero: true });
  const tries = positiveInteger('--intentos', values.intentos);
  const sample = positiveInteger('--muestra', values.muestra);
  const label = values.etiqueta ?? (values.falso ? 'falso' : 'real');
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(label)) {
    throw new Error('--etiqueta: sólo minúsculas, cifras y guiones');
  }
  const wanted = values.tareas.split(',').map((t) => t.trim()) as TaskKey[];
  const unknown = wanted.filter(
    (t) =>
      ![
        'cie10',
        'cie10-problema',
        'receta',
        'receta-nota',
        'nota',
        'borrador',
      ].includes(t),
  );
  if (unknown.length > 0)
    throw new Error(`Tarea desconocida: ${unknown.join(', ')}`);
  const limit =
    values.casos === undefined
      ? Infinity
      : positiveInteger('--casos', values.casos);
  const startedAt = deps.now();

  // EV-1. Cases first: a case outside the rules stops the run before a call is built.
  const catalogues = loadCatalogues();
  const invented = loadInventedCases(CASES_DIR);
  // EV-1. CodiEsp by its content, not by its file names.
  const codiesp = values.codiesp
    ? verifyCodiEsp(readCodiEsp(values.codiesp))
    : null;
  const sampled = codiesp
    ? codiEspCases(codiesp.rows, catalogues.cie10, {
        sample,
        seed,
      })
    : null;

  const tasks: TaskRun[] = [];
  const casesMeta: RunMetadata['cases'] = [];
  const casesById = new Map<string, EvalCase>();
  const add = (task: AnyTask, cases: readonly EvalCase[]) => {
    tasks.push({ task, cases });
    for (const item of cases) casesById.set(item.id, item);
  };
  if (wanted.includes('cie10')) {
    const own = inventedCie10Cases(invented.cie10.cases.slice(0, limit));
    add(cie10Task(catalogues), [...own, ...(sampled?.cases ?? [])]);
    casesMeta.push({
      task: 'cie10',
      source: 'cie10-propios.json',
      sha256: invented.cie10.sha256,
      n: own.length,
    });
    if (codiesp && sampled) {
      casesMeta.push({
        task: 'cie10',
        source: 'CodiEsp',
        sha256: codiesp.sha256,
        n: sampled.cases.length,
      });
    }
  }
  // AS-042 (D1). The product's prompt and barrier against the baseline, on
  // the same cases as `cie10`; the baseline counts within each source.
  if (wanted.includes('cie10-problema')) {
    const own = inventedCie10Cases(invented.cie10.cases.slice(0, limit));
    const fromCodiEsp = sampled?.cases ?? [];
    const task = cie10ByProblemTask(
      catalogues,
      [...own, ...fromCodiEsp],
      codiesp?.rows ?? [],
    );
    add(task, [...own, ...fromCodiEsp]);
    casesMeta.push({
      task: 'cie10-problema',
      source: 'cie10-propios.json',
      sha256: invented.cie10.sha256,
      n: own.length,
    });
    if (codiesp && sampled) {
      casesMeta.push({
        task: 'cie10-problema',
        source: 'CodiEsp',
        sha256: codiesp.sha256,
        n: fromCodiEsp.length,
      });
    }
  }
  if (wanted.includes('receta')) {
    const own = invented.prescription.cases.slice(0, limit);
    add(prescriptionTask(catalogues), own);
    casesMeta.push({
      task: 'prescription',
      source: 'receta.json',
      sha256: invented.prescription.sha256,
      n: own.length,
    });
  }
  // AS-079 (D2). The product's two calls, search and barriers, over notes.
  if (wanted.includes('receta-nota')) {
    const own = invented.prescriptionNote.cases.slice(0, limit);
    add(prescriptionFromNoteTask(catalogues), own);
    casesMeta.push({
      task: 'receta-nota',
      source: 'receta-notas.json',
      sha256: invented.prescriptionNote.sha256,
      n: own.length,
    });
  }
  if (wanted.includes('nota')) {
    const own = invented.note.cases.slice(0, limit);
    add(noteTask(), own);
    casesMeta.push({
      task: 'note',
      source: 'nota.json',
      sha256: invented.note.sha256,
      n: own.length,
    });
  }

  // AS-098 (C2). The product's writer on the same invented consultations.
  if (wanted.includes('borrador')) {
    const own = invented.note.cases.slice(0, limit);
    add(draftTask(catalogues), own);
    casesMeta.push({
      task: 'draft',
      source: 'nota.json',
      sha256: invented.note.sha256,
      n: own.length,
    });
  }

  // EV-3. Providers: the fake world, or the real chain behind its switch.
  const world = values.falso
    ? new FakeWorld(catalogues, seed, startedAt)
    : null;
  // The fake spends fake money: in a ledger of its own, never against the real ceiling.
  const ledgerDir = deps.ledgerDir ?? ledgerDirFrom(deps.env);
  const ledger = new FileAiRunStore(world ? join(ledgerDir, 'falso') : ledgerDir); // prettier-ignore
  const store = new TaggingStore(ledger);
  const clock = world?.clock ?? deps.now;
  const ceilingUsd = values.falso
    ? EVAL_CEILING_CAP_USD
    : ceilingFrom(deps.env.ASSISTANT_MONTHLY_SPEND_CEILING_USD);
  const timeoutMs = Number(deps.env.ASSISTANT_PROVIDER_TIMEOUT_MS) || 60_000;
  const filter = values.proveedores?.split(',').map((p) => p.trim());
  const built = world
    ? {
        measured: (['gemini', 'anthropic', 'openai'] as const).map((n) =>
          world.provider(n),
        ),
        withoutKey: [] as string[],
      }
    : realProviders(deps.env, deps.fetcher);
  const measured = built.measured.filter(
    (p) => !filter || filter.includes(p.name),
  );
  if (measured.length === 0) throw new Error('Ningún proveedor que medir');
  // D-241 (author, 12-10-2026): 2 USD per provider IN TOTAL across every
  // delivery, in the shared ledger. A real run always has it; the flag only
  // lowers or raises it on purpose.
  const providerCap =
    values['tope-proveedor'] !== undefined
      ? positiveAmount('--tope-proveedor', values['tope-proveedor'])
      : world
        ? undefined
        : EVAL_PROVIDER_CAP_USD;
  // AS-098, D-241. Each provider's client checks its own total in the
  // shared ledger besides the month's ceiling.
  const optionsFor = (name: string) => ({
    store:
      providerCap === undefined || ceilingUsd === undefined
        ? store
        : new ProviderCapStore(store, ledger, name, providerCap, ceilingUsd),
    ceilingUsd,
    timeoutMs,
    clock,
  });
  const providers: MeasuredProvider[] = measured.map((provider) => ({
    name: provider.name,
    model: provider.modelFor('quality'),
    client: clientFor(provider, optionsFor(provider.name)),
  }));
  const judgeProvider = world
    ? world.judge()
    : built.measured.find((p) => p.name === values.juez);
  if (
    (wanted.includes('nota') || wanted.includes('borrador')) &&
    !judgeProvider
  ) {
    throw new Error(
      `El juez «${values.juez}» no tiene clave: elija otro con --juez`,
    );
  }
  const judge: MeasuredProvider | null = judgeProvider
    ? {
        name: judgeProvider.name,
        model: judgeProvider.modelFor('quality'),
        client: clientFor(judgeProvider, optionsFor(judgeProvider.name)),
      }
    : null;

  // The worst the run can cost, before any call (AS-017 counts each attempt the same way).
  const prices = [...LLM_PRICES, ...FAKE_PRICES];
  let calls = 0;
  let worst = 0;
  for (const { task, cases } of tasks) {
    for (const item of cases) {
      for (const arm of task.arms) {
        const request = task.request(item, arm);
        // The note is judged once per provider that wrote one.
        const judging =
          (task.name === 'note' || task.name === 'draft') && judge
            ? providers.map(() => judge)
            : [];
        // A task that asks the same provider again counts each call.
        const answering = providers.flatMap((p) =>
          Array.from({ length: task.callsPerAnswer ?? 1 }, () => p),
        );
        for (const p of [...answering, ...judging]) {
          const price = priceAt(prices, p.model, clock());
          calls += 1;
          if (price) {
            worst += worstCaseOf(
              {
                system: request.system,
                prompt: request.prompt,
                maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
              },
              price,
            );
          }
        }
      }
    }
  }
  const spent = await store.spentSince(spendingMonthStart(clock()));
  deps.print(
    `${calls} llamadas (sin reintentos); peor caso ${worst.toFixed(2)} USD; techo ${ceilingUsd ?? 'ninguno'} USD al mes; gastado este mes en el registro del arnés: ${spent.toFixed(2)} USD`,
  );
  if (values.estimar) return null;

  const outcome = await runEvaluation({
    tasks,
    providers,
    judge,
    store,
    tries,
    backoffMs: 2_000,
    beforeCall: world?.beforeCall,
    sleep: world?.sleep,
    log: deps.print,
  });

  const meta: RunMetadata = {
    label,
    // A versioned result names no local account: the home folder as «~».
    ledger: world
      ? 'propio de la corrida falsa'
      : ledgerDir.replace(homedir(), '~'),
    fake: world !== null,
    startedAt: clinicStamp(startedAt),
    finishedAt: clinicStamp(deps.now()),
    commit: gitCommit(),
    seed,
    ceilingUsd,
    providers: providers.map(({ name, model }) => ({ name, model })),
    withoutKey: built.withoutKey,
    judge:
      judge && (wanted.includes('nota') || wanted.includes('borrador'))
        ? {
            name: judge.name,
            model: judge.model,
            promptVersion: JUDGE_PROMPT_VERSION,
          }
        : null,
    tasks: tasks.map(({ task }) => ({
      name: task.name,
      promptVersions: { ...task.promptVersions },
    })),
    catalogues: [...catalogues.versions, pricingVersion()],
    cases: casesMeta,
    codiesp:
      codiesp && sampled
        ? {
            sha256: codiesp.sha256,
            rows: sampled.total,
            withoutEquivalent: sampled.withoutEquivalent,
            sample: sampled.cases.length,
          }
        : null,
  };
  const folder = writeResult(
    values.salida,
    meta,
    outcome,
    tasks.map((t) => t.task),
    casesById,
  );
  deps.print(`Resultado en ${folder}`);
  return folder;
}

// Run only as the entry point (`pnpm eval`), not when a test imports it.
if (process.argv[1]?.endsWith(join('eval', 'main.ts'))) {
  // The routing warns on every unavailable attempt; the report counts them all.
  Logger.overrideLogger(['error']);
  runFromArgs(process.argv.slice(2), {
    env: process.env,
    now: () => new Date(),
    print: (line) => process.stdout.write(`${line}\n`),
  }).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
