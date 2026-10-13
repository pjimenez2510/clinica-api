import type { PreparationCase } from './cases.ts';
import type { ScoredCase, Summary, verdict } from './score.ts';

const pct = (rate: number) => `${(rate * 100).toFixed(1).replace('.', ',')} %`;
const interval = (s: { low: number; high: number }) => `${pct(s.low)} – ${pct(s.high)}`; // prettier-ignore

/** AS-255. The report a person reads: figures, and each serious error with its line (never from B2's reserved set). */
export function renderPreparationReport(input: {
  meta: { label: string; startedAt: string; commit: string; provider: string; stopped: string | null; cases: number; planned: number }; // prettier-ignore
  summaries: Record<string, Summary>;
  verdicts: Record<string, ReturnType<typeof verdict>>;
  scored: readonly ScoredCase[];
  cases: readonly PreparationCase[];
}): string {
  const { meta, summaries, verdicts, scored, cases } = input;
  const byId = new Map(cases.map((item) => [item.id, item]));
  const rows = Object.entries(summaries).map(([name, s]) => {
    const v = verdicts[name]!;
    return `| ${name} | ${s.answered}/${s.cases} | ${s.correct}/${s.expected} (${pct(s.correctRate.rate)}; ${interval(s.correctRate)}) | **${s.serious}** | **${s.notLiteral}** | ${s.complaintRight}/${s.complaintSaid} (${pct(s.complaintRate.rate)}), inventados ${s.complaintInvented} | ${s.speakersRight}/${s.lines} (${pct(s.speakerRate.rate)}) | ${s.p50Ms ?? '—'} / ${s.p90Ms ?? '—'} ms | ${v.sc099 ? '✓' : '✗'} ${v.sc100 ? '✓' : '✗'} ${v.sc101 ? '✓' : '✗'} |`; // prettier-ignore
  });
  const serious = scored.flatMap((each) =>
    each.values
      .filter(
        (value) => value.outcome === 'wrong' || value.outcome === 'invented',
      ) // prettier-ignore
      .map((value) => {
        const reserved = each.id.startsWith('B2-');
        const said = reserved ? '' : ` — «${byId.get(each.id)?.lines.map((line) => line.text).join(' / ') ?? ''}»`; // prettier-ignore
        return `- **${each.id}** · ${each.arm} · ${value.field}: esperado ${value.expected ?? '(no dicho)'}, propuesto ${value.got ?? '—'}${said}`; // prettier-ignore
      }),
  );
  const missed = scored
    .filter(
      (each) =>
        !each.id.startsWith('B2-') &&
        (each.complaint === 'missed' ||
          each.complaint === 'wrong' ||
          each.complaint === 'invented'),
    ) // prettier-ignore
    .map((each) => `- **${each.id}** · ${each.arm}: motivo ${each.complaint}`);
  return `# B3 — La preparación escuchada: medición (${meta.label})

- Corrida: ${meta.startedAt} (America/Guayaquil), commit \`${meta.commit}\`, proveedor **${meta.provider}**.
- Lecturas: ${meta.cases} de ${meta.planned}${meta.stopped ? ` — **detenida por ${meta.stopped}**` : ''}.
- Casos inventados (\`eval/casos/preparaciones.json\`, el reservado de B2 sólo en cifras); sin seudonimizador (EV-2).

| Conjunto | Leídas | Valores correctos (IC 95 %) | Graves | Fuera de su frase (SC-099) | Motivo (SC-101) | Hablante (SC-101) | p50 / p90 | SC-099 SC-100 SC-101 |
|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## Graves (valor distinto del dicho o propuesto sin decirse)

${serious.length ? serious.join('\n') : 'Ninguno.'}

## Motivos no acertados

${missed.length ? missed.join('\n') : 'Ninguno.'}

## Lo que no mide

Voces sintéticas de macOS, una por persona, sin ruido, sin micrófono y con cada línea oída por separado (la escucha real corta por el detector de voz). El set es inventado. Antes del primer paciente real, medir con conversaciones leídas por el personal (D-260 §9).
`;
}
