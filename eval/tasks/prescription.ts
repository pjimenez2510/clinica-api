import { z } from 'zod';

import {
  instruction,
  withContext,
} from '../../src/modules/assistant/application/llm-client.port.ts';
import type { CnmbMedicine } from '../../src/modules/catalogs/import/cnmb.ts';
import { caseText } from '../case-text.ts';
import type { Prescribed, PrescriptionCase } from '../cases.ts';
import { type Catalogues, fold, searchCnmb } from '../catalogue.ts';
import type { EvalTask, Scores } from '../task.ts';

export const PRESCRIPTION_PROMPT_VERSIONS = {
  A: 'receta-a-v1',
  D: 'receta-d-v1',
} as const;

/** The fields of the receta compared one by one (PLAN-ASISTENTE-IA §5). */
export const PRESCRIPTION_FIELDS = [
  ['substance', 'Principio activo'],
  ['form', 'Forma'],
  ['concentration', 'Concentración'],
  ['dose', 'Dosis'],
  ['route', 'Vía'],
  ['everyHours', 'Frecuencia'],
  ['days', 'Duración'],
] as const;
type Field = (typeof PRESCRIPTION_FIELDS)[number][0];

const ROUTES = [
  'oral',
  'rectal',
  'topica',
  'vaginal',
  'inhalatoria',
  'ocular',
  'otica',
  'nasal',
  'parenteral',
  'sublingual',
] as const;

const dose = z
  .object({ amount: z.number().positive(), unit: z.string().min(1).max(30) })
  .nullable();
const schedule = {
  dose,
  route: z.enum(ROUTES).nullable(),
  everyHours: z.number().positive().nullable(),
  days: z.number().positive().nullable(),
};

const SYSTEM_A = instruction`Eres un médico que transcribe una receta dictada en una consulta en Ecuador. Del dictado, saca el medicamento con su principio activo (nombre genérico), forma farmacéutica, concentración, dosis por toma (cantidad y unidad, por ejemplo 1 tableta o 5 mL), vía, cada cuántas horas y por cuántos días. Una sola toma es duración de 1 día y sin frecuencia. Lo que el dictado no dice, déjalo en null; no lo inventes. Si no hay ningún medicamento, devuelve medicine en null.`;

const SYSTEM_D = instruction`Eres un médico que transcribe una receta dictada en una consulta en Ecuador. Debajo del dictado va la lista de medicamentos del Cuadro Nacional de Medicamentos Básicos (CNMB) que nombra, con sus presentaciones numeradas. Elige el código del medicamento y el número de la presentación que corresponde a lo dictado (forma y concentración); después, la dosis por toma (cantidad y unidad, por ejemplo 1 tableta o 5 mL), la vía, cada cuántas horas y por cuántos días. Una sola toma es duración de 1 día y sin frecuencia. Lo que el dictado no dice, déjalo en null; no lo inventes. Si el medicamento no está en la lista, devuelve cnmbCode en null.`;

/** How a CNMB route reads in the receta: `O - Oral` → `oral`. */
export function routeOf(cnmbRoute: string): string | null {
  const head = cnmbRoute.split(' - ')[0]?.trim() ?? '';
  const byHead: Record<string, string> = {
    O: 'oral',
    R: 'rectal',
    T: 'topica',
    V: 'vaginal',
    I: 'inhalatoria',
    'I/N': 'inhalatoria',
    Oc: 'ocular',
    P: 'parenteral',
    'P (IV)': 'parenteral',
  };
  return byHead[head] ?? null;
}

const UNIT_SYNONYMS: Readonly<Record<string, string>> = {
  tableta: 'tableta',
  tabletas: 'tableta',
  tab: 'tableta',
  comprimido: 'tableta',
  comprimidos: 'tableta',
  capsula: 'tableta',
  capsulas: 'tableta',
  ml: 'ml',
  mililitro: 'ml',
  mililitros: 'ml',
  cc: 'ml',
  inhalacion: 'inhalacion',
  inhalaciones: 'inhalacion',
  puff: 'inhalacion',
  puffs: 'inhalacion',
  disparo: 'inhalacion',
  disparos: 'inhalacion',
  supositorio: 'supositorio',
  supositorios: 'supositorio',
  aplicacion: 'aplicacion',
  aplicaciones: 'aplicacion',
  gota: 'gota',
  gotas: 'gota',
};

/** EV-6. Values compared without case, accents, spaces or the decimal comma. */
export function normal(field: Field, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text =
    typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : JSON.stringify(value);
  switch (field) {
    case 'dose': {
      const { amount, unit } = value as { amount: number; unit: string };
      const word = fold(unit).trim();
      return `${amount} ${UNIT_SYNONYMS[word] ?? word}`;
    }
    case 'everyHours':
    case 'days':
      return text;
    case 'concentration':
      // 100 mcg is 0,1 mg: the cuadro writes one, a physician says the other.
      return fold(text)
        .replace(/\s+/g, '')
        .replace(/,/g, '.')
        .replace(
          /(\d+(?:\.\d+)?)(?:mcg|µg|ug)/g,
          (_, amount: string) => `${Number(amount) / 1000}mg`,
        );
    default:
      return fold(text).replace(/\s+/g, ' ').trim();
  }
}

/** What arm A or D shows as the receta, in the fields of the case. */
type Shown = { [K in Field]: Prescribed[K] | null } & {
  cnmbCode: string | null;
};

const nothing: Shown = {
  substance: null,
  form: null,
  concentration: null,
  dose: null,
  route: null,
  everyHours: null,
  days: null,
  cnmbCode: null,
};

function candidatesBlock(medicines: readonly CnmbMedicine[]): string {
  return [
    'Medicamentos del CNMB:',
    ...medicines.flatMap((medicine) => [
      `- ${medicine.code} · ${medicine.display}`,
      ...medicine.presentations.map(
        (p, i) =>
          `  ${i + 1}. ${p.label} · ${p.concentration} · ${p.route} (forma: ${p.form})`,
      ),
    ]),
  ].join('\n');
}

/**
 * Receta (D-239 §5, PLAN-ASISTENTE-IA §5): each field right or wrong against
 * the receta the case means, and whether the medicine is in the CNMB. Arm A
 * writes the fields; arm D chooses a CNMB medicine and presentation and the
 * barrier drops a code that is not in the cuadro (EV-6).
 */
export function prescriptionTask(
  catalogues: Catalogues,
): EvalTask<PrescriptionCase, Record<string, unknown>> {
  const { cnmb } = catalogues;
  const byCode = new Map(cnmb.map((medicine) => [medicine.code, medicine]));
  const names = new Set(
    cnmb.map((medicine) => normal('substance', medicine.display)),
  );
  const forms = [
    ...new Set(
      cnmb.flatMap((m) => m.presentations.map((p) => p.form)).filter(Boolean),
    ),
  ].sort() as [string, ...string[]];

  const answerA = z.object({
    medicine: z
      .object({
        substance: z.string().min(1).max(80),
        form: z.enum(forms).nullable(),
        concentration: z.string().max(60).nullable(),
        ...schedule,
      })
      .nullable(),
  });
  const answerD = z.object({
    cnmbCode: z.string().max(20).nullable(),
    presentation: z.number().int().positive().nullable(),
    ...schedule,
  });

  function shownOf(arm: 'A' | 'D', value: Record<string, unknown>): Shown {
    if (arm === 'A') {
      const medicine = (value as z.infer<typeof answerA>).medicine;
      return medicine === null ? nothing : { ...medicine, cnmbCode: null };
    }
    const chosen = value as z.infer<typeof answerD>;
    const medicine =
      chosen.cnmbCode === null ? undefined : byCode.get(chosen.cnmbCode);
    // EV-6. The barrier: a code the cuadro does not have is not a receta.
    if (medicine === undefined) return nothing;
    const presentation =
      chosen.presentation === null
        ? undefined
        : medicine.presentations[chosen.presentation - 1];
    return {
      cnmbCode: medicine.code,
      substance: medicine.display,
      form: presentation?.form ?? null,
      concentration: presentation?.concentration ?? null,
      // The route the cuadro gives the presentation, else what was dictated.
      route: (presentation && routeOf(presentation.route)) ?? chosen.route,
      dose: chosen.dose,
      everyHours: chosen.everyHours,
      days: chosen.days,
    };
  }

  return {
    name: 'prescription',
    title: 'Receta dictada',
    arms: ['A', 'D'],
    promptVersions: PRESCRIPTION_PROMPT_VERSIONS,
    latencyBudgetMs: 5_000,
    metrics: [
      ...PRESCRIPTION_FIELDS.map(([key, label]) => ({
        key,
        label: `${label} correcta`,
        kind: 'binary' as const,
        primary: key === 'concentration',
      })),
      {
        key: 'all',
        label: 'Receta completa correcta',
        kind: 'binary',
        primary: true,
      },
      {
        key: 'outsideCnmb',
        label: 'Medicamento fuera del CNMB',
        kind: 'binary',
        lowerIsBetter: true,
        primary: true,
      },
      {
        key: 'empty',
        label: 'Sin medicamento',
        kind: 'binary',
        lowerIsBetter: true,
      },
    ],
    request(item, arm) {
      const prompt = caseText(`Dictado: ${item.dictation}`);
      const base = {
        tier: 'quality' as const,
        purpose: 'eval-receta',
        promptVersion: PRESCRIPTION_PROMPT_VERSIONS[arm],
        maxTokens: 600,
      };
      if (arm === 'A')
        return { ...base, system: SYSTEM_A, prompt, answer: answerA };
      return {
        ...base,
        system: SYSTEM_D,
        prompt: withContext(
          prompt,
          candidatesBlock(searchCnmb(item.dictation, cnmb)),
        ),
        answer: answerD,
      };
    },
    evaluate(item, arm, value) {
      const shown = shownOf(arm, value);
      const scores: Scores = {};
      for (const [field] of PRESCRIPTION_FIELDS) {
        scores[field] =
          normal(field, shown[field]) === normal(field, item.expected[field])
            ? 1
            : 0;
      }
      scores.all = PRESCRIPTION_FIELDS.every(([field]) => scores[field] === 1)
        ? 1
        : 0;
      scores.empty = shown.substance === null ? 1 : 0;
      scores.outsideCnmb =
        shown.substance === null
          ? null
          : names.has(normal('substance', shown.substance))
            ? 0
            : 1;
      return Promise.resolve({ shown, scores });
    },
  };
}

/**
 * EV-6. Precision, recall and F1 of one field over a set of answers: a field
 * left empty is an abstention, not an error, and only costs recall.
 */
export function fieldF1(
  rows: readonly { expected: Prescribed; shown: Record<string, unknown> }[],
  field: Field,
): {
  precision: number;
  recall: number;
  f1: number;
  predicted: number;
  expected: number;
} {
  let truePositive = 0;
  let predicted = 0;
  let expected = 0;
  for (const row of rows) {
    const got = normal(field, row.shown[field]);
    const want = normal(field, row.expected[field]);
    if (got !== null) predicted += 1;
    if (want !== null) expected += 1;
    if (got !== null && got === want) truePositive += 1;
  }
  const precision = predicted === 0 ? Number.NaN : truePositive / predicted;
  const recall = expected === 0 ? Number.NaN : truePositive / expected;
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, predicted, expected };
}
