import type { Interval } from '../stats.ts';

import type { DictatedField } from './cases.ts';
import {
  type Cell,
  groupBy,
  SC095_MIN_CORRECT,
  tally,
  type Tally,
  type Verdict,
} from './score.ts';

export interface DictationRunMeta {
  label: string;
  set: string;
  startedAt: string;
  commit: string;
  casesSha256: string;
  heardSha256: string;
  voices: readonly string[];
  cases: number;
}

const LABELS: Readonly<Record<DictatedField, string>> = {
  systolicBp: 'Sistólica',
  diastolicBp: 'Diastólica',
  heartRate: 'Frecuencia cardiaca',
  respiratoryRate: 'Frecuencia respiratoria',
  temperatureC: 'Temperatura',
  oxygenSaturation: 'Saturación',
  weightKg: 'Peso',
  heightCm: 'Talla',
};

const percent = (value: number) =>
  `${(value * 100).toFixed(1).replace('.', ',')} %`;
const interval = (range: Interval) =>
  Number.isNaN(range.low)
    ? '—'
    : `${percent(range.low)} – ${percent(range.high)}`;

function row(name: string, t: Tally): string {
  const rate = t.expected === 0 ? '—' : percent(t.correct / t.expected);
  return `| ${name} | ${t.expected} | ${t.correct} | ${rate} | ${interval(t.correctRate)} | ${t.wrong} | ${t.empty} | ${t.invented} de ${t.unsaid} | **${t.serious}** |`; // prettier-ignore
}

const HEAD =
  '| | esperados | correctos | % | IC 95 % (Wilson) | mal | vacíos | inventados | graves |\n|---|---|---|---|---|---|---|---|---|';

function table<K extends 'arm' | 'voice' | 'field' | 'category'>(
  cells: readonly Cell[],
  key: K,
  name: (value: Cell[K]) => string = String,
): string {
  const rows = [...groupBy(cells, key)].map(([value, group]) => row(name(value), tally(group))); // prettier-ignore
  return `${HEAD}\n${rows.join('\n')}`;
}

/** AS-188. The report: the two arms, then the heard one by voice, field and phrase type, then every serious cell. */
export function renderDictationReport(
  meta: DictationRunMeta,
  cells: readonly Cell[],
  verdict: Verdict,
): string {
  const text = cells.filter((cell) => cell.arm === 'texto');
  const heard = cells.filter((cell) => cell.arm === 'oido');
  const serious = cells.filter((cell) => cell.outcome === 'wrong' || cell.outcome === 'invented'); // prettier-ignore
  const yes = (ok: boolean) => (ok ? '✅ cumple' : '❌ no cumple');
  return `# Signos dictados — ${meta.label}

- **Fecha:** ${meta.startedAt} (America/Guayaquil) · **Commit:** \`${meta.commit}\`
- **Set:** ${meta.set}
- **Casos:** ${meta.cases} frases inventadas (\`${meta.set === 'reservado' ? 'signos-dictados-reservado.json' : 'signos-dictados.json'}\`, SHA-256 \`${meta.casesSha256.slice(0, 16)}…\`)
- **Lo oído:** (SHA-256 \`${meta.heardSha256.slice(0, 16)}…\`), voces sintéticas de macOS (${meta.voices.join(', ')}), a su velocidad y a 220 palabras por minuto, sin ruido, transcritas por \`clinica-ai\` (whisper + VAD) en esta máquina.
- **Lectura medida:** \`readDictatedVitals\`, de \`src/modules/assistant/domain/dictated-vitals.ts\`, la misma de la ruta. Ningún proveedor de modelo.

## Criterios (escritos antes de medir)

- **SC-095** — oído sin ruido: ≥ ${percent(SC095_MIN_CORRECT)} de los valores esperados correctos → ${yes(verdict.sc095)}
- **SC-096** — 0 graves (valor distinto del dicho o inventado) en los dos brazos → ${yes(verdict.sc096)}

## Por brazo

${table(cells, 'arm', (arm) => (arm === 'texto' ? 'Texto escrito' : 'Oído (sin ruido)'))}

## Oído, por voz

${table(heard, 'voice')}

## Oído, por signo

${table(heard, 'field', (field) => LABELS[field])}

## Oído, por tipo de frase

${table(heard, 'category')}

## Texto escrito, por tipo de frase

${table(text, 'category')}

## Graves

${serious.length === 0 ? 'Ninguno.' : serious.map((cell) => `- **${cell.id}** · ${cell.arm} · ${cell.voice} · ${LABELS[cell.field]}: esperado ${cell.expected ?? '(no dicho)'}, leído ${cell.got} — «${cell.text}»`).join('\n')}

## Lo que no mide

Voz sintética, sin micrófono, sin la cancelación de eco del navegador y sin ruido de sala (E-055: con ruido rosa de 10 dB aparecieron graves). No mide cuánto tarda ni cuántas veces se corrige lo dictado (D-255 §5).
`;
}
