import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ProviderName } from '../src/modules/assistant/domain/llm-outcome.ts';

import type { PrescriptionCase } from './cases.ts';
import type { Attempt, AnyTask, CallResult, RunOutcome } from './runner.ts';
import {
  bootstrapMean,
  type Estimate,
  pairedDifference,
  quantile,
  wilson,
} from './stats.ts';
import type { Arm, EvalCase, Metric } from './task.ts';
import { fieldF1, PRESCRIPTION_FIELDS } from './tasks/prescription.ts';

/** EV-7. What a result says about how it was obtained. */
export interface RunMetadata {
  label: string;
  fake: boolean;
  /** EV-4. The ledger the ceiling was checked against. */
  ledger: string;
  startedAt: string;
  finishedAt: string;
  commit: string;
  seed: number;
  ceilingUsd: number | undefined;
  providers: { name: ProviderName; model: string }[];
  withoutKey: string[];
  judge: { name: ProviderName; model: string; promptVersion: string } | null;
  tasks: { name: string; promptVersions: Partial<Record<Arm, string>> }[];
  catalogues: { file: string; sha256: string }[];
  cases: { task: string; source: string; sha256: string; n: number }[];
  codiesp: {
    sha256: string;
    rows: number;
    withoutEquivalent: number;
    sample: number;
  } | null;
}

const pct = (value: number) =>
  Number.isFinite(value) ? `${(100 * value).toFixed(1)} %` : '—';
const interval = (e: { low: number; high: number }) =>
  `[${pct(e.low)}; ${pct(e.high)}]`;
const usd = (value: number) => `${value.toFixed(4)} USD`;
const seconds = (ms: number) =>
  Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '—';

/** One metric over a set of calls: Wilson for 0/1, a bootstrap of cases for fractions. */
export function estimateOf(
  metric: Metric,
  calls: readonly CallResult[],
  seed: number,
): Estimate {
  const values = calls.flatMap((call) => {
    const value = call.scores?.[metric.key];
    return value === null || value === undefined ? [] : [value];
  });
  if (metric.kind === 'binary') {
    const hits = values.filter((value) => value === 1).length;
    return {
      estimate: values.length === 0 ? Number.NaN : hits / values.length,
      ...wilson(hits, values.length),
      n: values.length,
    };
  }
  return bootstrapMean(values, { seed });
}

/** The same metric, case by case, between two groups of calls (`b − a`). */
export function pairedOf(
  metric: Metric,
  a: readonly CallResult[],
  b: readonly CallResult[],
  seed: number,
): Estimate {
  const byCase = new Map(a.map((call) => [call.caseId, call]));
  const pairs = b.flatMap((call) => {
    const other = byCase.get(call.caseId);
    const x = other?.scores?.[metric.key];
    const y = call.scores?.[metric.key];
    return x === null || x === undefined || y === null || y === undefined
      ? []
      : [{ a: x, b: y }];
  });
  return pairedDifference(pairs, { seed });
}

const verdictOf = (difference: Estimate, metric: Metric) => {
  if (difference.n === 0) return 'sin pares';
  if (difference.low > 0)
    return metric.lowerIsBetter ? 'peor (excluye 0)' : 'mejor (excluye 0)';
  if (difference.high < 0)
    return metric.lowerIsBetter ? 'mejor (excluye 0)' : 'peor (excluye 0)';
  return 'no concluyente (incluye 0)';
};

/**
 * The availability of each provider over the requests that measured it —
 * the judge's own requests are longer and go apart, or a provider that also
 * judges would carry them in its rate (review of 11-10-2026). Each request
 * counts, retries too: failures come in bursts, so the interval of that rate
 * is narrower than it should be, and the share of calls that failed at their
 * first request is beside it.
 */
function availability(
  outcome: RunOutcome,
  providers: readonly ProviderName[],
  judge: ProviderName | null,
) {
  const lines = [
    '| Proveedor | Peticiones | Correctas | Sobrecarga (503/529) | 429 | Otros fallos de disponibilidad | Tasa de error [IC 95 %] | Llamadas que fallaron a la primera |',
    '|---|---|---|---|---|---|---|---|',
  ];
  const row = (
    label: string,
    mine: readonly Attempt[],
    firstFailed: string,
  ) => {
    const unavailable = mine.filter((a) =>
      ['timeout', 'rate-limited', 'provider-error'].includes(a.outcome),
    );
    const overloaded = mine.filter(
      (a) => a.httpStatus === 503 || a.httpStatus === 529,
    ).length;
    const s429 = mine.filter((a) => a.httpStatus === 429).length;
    lines.push(
      `| ${label} | ${mine.length} | ${mine.filter((a) => a.outcome === 'ok').length} | ${overloaded} | ${s429} | ${unavailable.length - overloaded - s429} | ${pct(mine.length === 0 ? Number.NaN : unavailable.length / mine.length)} ${interval(wilson(unavailable.length, mine.length))} | ${firstFailed} |`,
    );
  };
  for (const provider of providers) {
    const calls = outcome.calls.filter((c) => c.provider === provider);
    const first = calls.filter((c) => c.requests > 1 || !c.answered).length;
    row(
      provider,
      // The provider's own calls: the answer and, for a task measured as
      // the product runs it, the follow-up (never the judge's).
      outcome.attempts.filter(
        (a) => a.provider === provider && a.role !== 'judge',
      ),
      `${pct(calls.length === 0 ? Number.NaN : first / calls.length)} ${interval(wilson(first, calls.length))}`,
    );
  }
  const judging = outcome.attempts.filter((a) => a.role === 'judge');
  if (judge !== null && judging.length > 0) {
    row(`juez (${judge})`, judging, '—');
  }
  return lines;
}

function latencyAndCost(
  outcome: RunOutcome,
  tasks: readonly AnyTask[],
  providers: readonly ProviderName[],
) {
  const lines = [
    '| Tarea | Proveedor | Latencia p50 | p90 | Presupuesto p90 | Costo total | Costo por llamada respondida |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const task of tasks) {
    for (const provider of providers) {
      const attempts = outcome.attempts.filter(
        (a) =>
          a.task === task.name && a.provider === provider && a.role !== 'judge',
      );
      if (attempts.length === 0) continue;
      // What the physician waits for: the calls of one case, one after the
      // other, added (a follow-up comes after its answer).
      const byCase = new Map<string, number>();
      for (const a of attempts.filter((each) => each.outcome === 'ok')) {
        const key = `${a.caseId}·${a.arm}`;
        byCase.set(key, (byCase.get(key) ?? 0) + a.latencyMs);
      }
      const latencies = [...byCase.values()];
      const cost = attempts.reduce((total, a) => total + a.costUsd, 0);
      const answered = outcome.calls.filter(
        (c) => c.task === task.name && c.provider === provider && c.answered,
      ).length;
      const p90 = quantile(latencies, 0.9);
      lines.push(
        `| ${task.title} | ${provider} | ${seconds(quantile(latencies, 0.5))} | ${seconds(p90)} | ${seconds(task.latencyBudgetMs)} ${p90 <= task.latencyBudgetMs ? '✓' : '✗'} | ${usd(cost)} | ${answered === 0 ? '—' : usd(cost / answered)} |`,
      );
    }
  }
  const judging = outcome.attempts.filter((a) => a.role === 'judge');
  if (judging.length > 0) {
    lines.push(
      '',
      `Juez: ${judging.length} intentos, ${usd(judging.reduce((t, a) => t + a.costUsd, 0))}.`,
    );
  }
  return lines;
}

function taskSection(
  task: AnyTask,
  outcome: RunOutcome,
  providers: readonly ProviderName[],
  seed: number,
  casesById: ReadonlyMap<string, EvalCase>,
) {
  const calls = outcome.calls.filter((c) => c.task === task.name);
  const lines = [`## ${task.title}`, ''];
  const origins = [...new Set(calls.map((c) => c.origin))];
  const of = (provider: ProviderName, arm: Arm) =>
    calls.filter((c) => c.provider === provider && c.arm === arm && c.answered);

  lines.push(
    '| Proveedor | Brazo | Respondidos | ' +
      task.metrics.map((m: Metric) => m.label).join(' | ') +
      ' |',
    '|---|---|---|' + task.metrics.map(() => '---').join('|') + '|',
  );
  for (const provider of providers) {
    for (const arm of task.arms) {
      const all = calls.filter((c) => c.provider === provider && c.arm === arm);
      if (all.length === 0) continue;
      // The invented set and CodiEsp apart as well, when a task mixes them.
      const groups: [string, CallResult[]][] = [['', all]];
      if (origins.length > 1) {
        for (const origin of origins) {
          groups.push([` · ${origin}`, all.filter((c) => c.origin === origin)]);
        }
      }
      for (const [suffix, group] of groups) {
        const answered = group.filter((c) => c.answered);
        lines.push(
          `| ${provider} | ${arm}${suffix} | ${answered.length}/${group.length} | ` +
            task.metrics
              .map((m: Metric) => {
                const e = estimateOf(m, answered, seed);
                return `${pct(e.estimate)} ${interval(e)} n=${e.n}`;
              })
              .join(' | ') +
            ' |',
        );
      }
    }
  }

  const primary = task.metrics.filter((m: Metric) => m.primary);
  if (task.arms.length > 1) {
    lines.push('', `### D − A, caso por caso (mismo proveedor)`, '');
    lines.push(
      '| Proveedor | Métrica | Diferencia [IC 95 %] | Pares | Lectura |',
      '|---|---|---|---|---|',
    );
    for (const provider of providers) {
      for (const metric of primary) {
        const d = pairedOf(metric, of(provider, 'A'), of(provider, 'D'), seed);
        lines.push(
          `| ${provider} | ${metric.label} | ${pct(d.estimate)} ${interval(d)} | ${d.n} | ${verdictOf(d, metric)} |`,
        );
      }
    }
  }

  const reference = providers[0];
  const arm = task.arms.includes('D') ? 'D' : task.arms[0]!;
  if (reference !== undefined && providers.length > 1) {
    lines.push(
      '',
      `### Proveedores contra ${reference}, brazo ${arm}, caso por caso`,
      '',
    );
    lines.push(
      '| Proveedor − ' +
        reference +
        ' | Métrica | Diferencia [IC 95 %] | Pares | Lectura |',
      '|---|---|---|---|---|',
    );
    for (const provider of providers.slice(1)) {
      for (const metric of primary) {
        const d = pairedOf(metric, of(reference, arm), of(provider, arm), seed);
        lines.push(
          `| ${provider} | ${metric.label} | ${pct(d.estimate)} ${interval(d)} | ${d.n} | ${verdictOf(d, metric)} |`,
        );
      }
    }
  }

  if (task.name === 'prescription') {
    lines.push(
      '',
      '### F1 por campo (un campo vacío es abstención: baja el recall, no la precisión)',
      '',
    );
    lines.push(
      '| Proveedor | Brazo | ' +
        PRESCRIPTION_FIELDS.map(([, label]) => label).join(' | ') +
        ' |',
      '|---|---|' + PRESCRIPTION_FIELDS.map(() => '---').join('|') + '|',
    );
    for (const provider of providers) {
      for (const a of task.arms) {
        const rows = of(provider, a).map((call) => ({
          expected: (casesById.get(call.caseId) as PrescriptionCase).expected,
          shown: call.shown as Record<string, unknown>,
        }));
        if (rows.length === 0) continue;
        lines.push(
          `| ${provider} | ${a} | ` +
            PRESCRIPTION_FIELDS.map(([field]) => {
              const f = fieldF1(rows, field);
              return `${pct(f.f1)} (P ${pct(f.precision)}, R ${pct(f.recall)})`;
            }).join(' | ') +
            ' |',
        );
      }
    }
  }

  if (task.arms.length > 1) {
    lines.push(
      '',
      '> **Qué es A y qué es D aquí.** A no tiene catálogo (el modelo escribe de memoria); D recibe candidatos del catálogo y una barrera quita lo que no existe, sin corregir nada. El A del §5 ya buscaba en un catálogo plano: esta diferencia se parece más a «C − A más la barrera» que al D − A del §5. La invención cuenta lo que el modelo escribió, en los dos brazos; en D la barrera no lo muestra.',
    );
  }
  if (task.name === 'note') {
    const judge = outcome.attempts.find((a) => a.role === 'judge')?.provider;
    lines.push(
      '',
      '> **Juez sin validar.** La omisión y la invención las decide un único modelo (el juez de la cabecera) que ningún médico ha contrastado todavía; hasta medir su κ contra una submuestra revisada (PLAN-ASISTENTE-IA §5), esas dos columnas orientan y no deciden. Las secciones fuera de plantilla y las frases sin línea se cuentan sin modelo.',
      ...(judge !== undefined && providers.includes(judge)
        ? [
            '',
            `> **El juez es uno de los proveedores comparados (${judge}).** Un modelo tiende a preferir sus propias respuestas (Panickssery et al., 2024): las cifras del juez a favor de ${judge} valen menos que las demás.`,
          ]
        : []),
    );
  }
  return lines;
}

/** EV-7. The report, in Spanish, for the principal session and the author. */
export function renderReport(
  meta: RunMetadata,
  outcome: RunOutcome,
  tasks: readonly AnyTask[],
  casesById: ReadonlyMap<string, EvalCase>,
): string {
  const providers = meta.providers.map((p) => p.name);
  const spent = outcome.attempts.reduce((total, a) => total + a.costUsd, 0);
  const lines = [
    `# Informe del arnés de evaluación — ${meta.label}`,
    '',
    meta.fake
      ? '> **Proveedor falso.** Respuestas, latencias, errores y costos simulados con semilla: esta corrida prueba el arnés, no mide a ningún proveedor.'
      : '> Corrida real, sólo con casos inventados y de CodiEsp (D-239 §1).',
    '',
    `- Fecha: ${meta.startedAt} → ${meta.finishedAt} · commit \`${meta.commit}\` · semilla ${meta.seed}`,
    `- Proveedores (nivel \`quality\`, cada uno sin respaldo): ${meta.providers.map((p) => `${p.name} \`${p.model}\``).join(', ')}${meta.withoutKey.length > 0 ? ` · sin clave, no medidos: ${meta.withoutKey.join(', ')}` : ''}`,
    `- Juez de la nota: ${meta.judge ? `${meta.judge.name} \`${meta.judge.model}\` (${meta.judge.promptVersion}), sin validar` : 'ninguno'}`,
    `- Prompts: ${meta.tasks
      .map(
        (t) =>
          `${t.name} ${Object.entries(t.promptVersions)
            .map(([arm, v]) => `${arm}=${v}`)
            .join(', ')}`,
      )
      .join(' · ')}`,
    `- Catálogos: ${meta.catalogues.map((c) => `${c.file} \`${c.sha256.slice(0, 12)}\``).join(', ')}`,
    `- Casos: ${meta.cases.map((c) => `${c.task} ${c.n} de ${c.source} \`${c.sha256.slice(0, 12)}\``).join(' · ')}`,
    meta.codiesp
      ? `- CodiEsp (Miranda-Escalada et al., 2020, CC BY 4.0, Zenodo 3837305): ${meta.codiesp.rows} frases de diagnóstico, ${meta.codiesp.withoutEquivalent} sin equivalente en la CIE-10 OMS, muestra de ${meta.codiesp.sample} · \`${meta.codiesp.sha256.slice(0, 12)}\``
      : '- CodiEsp: no se usó en esta corrida',
    `- Techo: ${meta.ceilingUsd === undefined ? 'ninguno' : `${meta.ceilingUsd} USD al mes`}, contra el registro ${meta.ledger} · gastado en esta corrida: ${usd(spent)}`,
    ...(outcome.stopped ? ['', `> **Detenida:** ${outcome.stopped}.`] : []),
    '',
    '**Regla, escrita antes de medir (PLAN-ASISTENTE-IA §5):** una diferencia cuenta sólo si su intervalo de confianza del 95 % excluye el cero, sin empeorar la invención ni pasar el presupuesto de latencia. La calidad se mide sobre los casos respondidos; la disponibilidad, aparte.',
    '',
    '## Disponibilidad (todas las peticiones, también los reintentos y el juez)',
    '',
    ...availability(outcome, providers, meta.judge?.name ?? null),
    '',
    '## Latencia y costo',
    '',
    ...latencyAndCost(outcome, tasks, providers),
    '',
  ];
  for (const task of tasks) {
    lines.push(
      ...taskSection(task, outcome, providers, meta.seed, casesById),
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

/** EV-7. `<dir>/<fecha>-<etiqueta>/resultado.json` and `informe.md`. */
export function writeResult(
  dir: string,
  meta: RunMetadata,
  outcome: RunOutcome,
  tasks: readonly AnyTask[],
  casesById: ReadonlyMap<string, EvalCase>,
): string {
  const base = join(
    dir,
    `${meta.startedAt.slice(0, 16).replace(/[: T]/g, '-')}-${meta.label}`,
  );
  // Two runs in the same minute with the same label never overwrite each other.
  let folder = base;
  for (let n = 2; existsSync(folder); n += 1) folder = `${base}-${n}`;
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'resultado.json'),
    `${JSON.stringify(
      {
        ...meta,
        stopped: outcome.stopped,
        // A call keeps its case id and what was shown, never the case: no
        // CodiEsp phrase is republished. What was shown for a note is the
        // note the model wrote from an invented conversation.
        calls: outcome.calls,
        attempts: outcome.attempts,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(folder, 'informe.md'),
    renderReport(meta, outcome, tasks, casesById),
  );
  return folder;
}
