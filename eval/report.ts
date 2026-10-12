import { mkdirSync, writeFileSync } from 'node:fs';
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

function availability(
  attempts: readonly Attempt[],
  providers: readonly ProviderName[],
) {
  const lines = [
    '| Proveedor | Intentos | Correctos | 503 | 429 | Otros fallos de disponibilidad | Tasa de error [IC 95 %] |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const provider of providers) {
    const mine = attempts.filter((a) => a.provider === provider);
    const unavailable = mine.filter((a) =>
      ['timeout', 'rate-limited', 'provider-error'].includes(a.outcome),
    );
    const s503 = mine.filter((a) => a.httpStatus === 503).length;
    const s429 = mine.filter((a) => a.httpStatus === 429).length;
    const errorRate = wilson(unavailable.length, mine.length);
    lines.push(
      `| ${provider} | ${mine.length} | ${mine.filter((a) => a.outcome === 'ok').length} | ${s503} | ${s429} | ${unavailable.length - s503 - s429} | ${pct(mine.length === 0 ? Number.NaN : unavailable.length / mine.length)} ${interval(errorRate)} |`,
    );
  }
  return lines;
}

function latencyAndCost(
  outcome: RunOutcome,
  tasks: readonly AnyTask[],
  providers: readonly ProviderName[],
) {
  const lines = [
    '| Tarea | Proveedor | Latencia p50 | p90 | Presupuesto p90 | Costo total | Costo por caso respondido |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const task of tasks) {
    for (const provider of providers) {
      const attempts = outcome.attempts.filter(
        (a) =>
          a.task === task.name &&
          a.provider === provider &&
          a.role === 'answer',
      );
      if (attempts.length === 0) continue;
      const latencies = attempts
        .filter((a) => a.outcome === 'ok')
        .map((a) => a.latencyMs);
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

  if (task.name === 'note') {
    lines.push(
      '',
      '> **Juez sin validar.** La omisión y la invención las decide un único modelo (el juez de la cabecera) que ningún médico ha contrastado todavía; hasta medir su κ contra una submuestra revisada (PLAN-ASISTENTE-IA §5), esas dos columnas orientan y no deciden. Las secciones fuera de plantilla y las frases sin línea se cuentan sin modelo.',
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
    `- Techo: ${meta.ceilingUsd === undefined ? 'ninguno' : `${meta.ceilingUsd} USD al mes`} · gastado en esta corrida: ${usd(spent)}`,
    ...(outcome.stopped ? ['', `> **Detenida:** ${outcome.stopped}.`] : []),
    '',
    '**Regla, escrita antes de medir (PLAN-ASISTENTE-IA §5):** una diferencia cuenta sólo si su intervalo de confianza del 95 % excluye el cero, sin empeorar la invención ni pasar el presupuesto de latencia. La calidad se mide sobre los casos respondidos; la disponibilidad, aparte.',
    '',
    '## Disponibilidad (todas las peticiones, también los reintentos y el juez)',
    '',
    ...availability(outcome.attempts, [
      ...new Set([...providers, ...(meta.judge ? [meta.judge.name] : [])]),
    ]),
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
  const folder = join(
    dir,
    `${meta.startedAt.slice(0, 16).replace(/[: T]/g, '-')}-${meta.label}`,
  );
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'resultado.json'),
    `${JSON.stringify(
      {
        ...meta,
        stopped: outcome.stopped,
        // A result keeps the case id and what was shown, never the case
        // text: CodiEsp's phrases are public but not ours to republish.
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
