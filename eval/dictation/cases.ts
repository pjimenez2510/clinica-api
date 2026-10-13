import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { CASES_DIR } from '../cases.ts';

/**
 * AS-188. The dictated phrases and what the recogniser heard of them. Only
 * invented material: the loader stops the run before anything is measured
 * when a file says otherwise (EV-1).
 */
export const DICTATED_FIELDS = [
  'systolicBp',
  'diastolicBp',
  'heartRate',
  'respiratoryRate',
  'temperatureC',
  'oxygenSaturation',
  'weightKg',
  'heightCm',
] as const;
export type DictatedField = (typeof DICTATED_FIELDS)[number];

const expectedSchema = z.partialRecord(z.enum(DICTATED_FIELDS), z.number());

export const dictationCaseSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  text: z.string().min(1),
  expected: expectedSchema,
});
export type DictationCase = z.infer<typeof dictationCaseSchema>;

const casesFileSchema = z.object({
  origin: z.literal('invented'),
  description: z.string(),
  cases: z.array(dictationCaseSchema).min(1),
});

export const heardSchema = z.object({
  id: z.string().min(1),
  voice: z.string().min(1),
  /** Words per minute given to the synthesiser; `null` is its own default. */
  rate: z.number().int().positive().nullable(),
  text: z.string(),
  /** CAI-016, AS-197. Each token with its probability, as clinica-ai gave it. */
  words: z
    .array(
      z.object({ text: z.string(), probability: z.number().min(0).max(1) }),
    )
    .default([]),
});
export type Heard = z.infer<typeof heardSchema>;

const heardFileSchema = z.object({
  origin: z.literal('invented'),
  description: z.string(),
  /** The SHA-256 of the phrases file it was heard from. */
  casesSha256: z.string().regex(/^[0-9a-f]{64}$/),
  heard: z.array(heardSchema),
});
export type HeardFile = z.infer<typeof heardFileSchema>;

/**
 * AS-188, AS-197. Two sets: the one the confidence threshold was chosen on,
 * and a reserved one, written before it was ever measured, that only checks it.
 */
export const DICTATION_SETS = {
  desarrollo: {
    cases: 'signos-dictados.json',
    heard: 'signos-dictados-oido.json',
  },
  reservado: {
    cases: 'signos-dictados-reservado.json',
    heard: 'signos-dictados-reservado-oido.json',
  },
} as const;
export type DictationSet = keyof typeof DICTATION_SETS;
export const DICTATION_CASES = DICTATION_SETS.desarrollo.cases;
export const DICTATION_HEARD = DICTATION_SETS.desarrollo.heard;

export function loadDictationCases(
  dir = CASES_DIR,
  file: string = DICTATION_CASES,
): DictationCase[] {
  const parsed = casesFileSchema.safeParse(readJson(join(dir, file)));
  if (!parsed.success) {
    throw new Error(
      `${file} no es un set inventado válido: la corrida se detiene (EV-1)`,
    );
  }
  const ids = parsed.data.cases.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${file} repite un id`);
  }
  return parsed.data.cases;
}

export function loadHeard(
  dir = CASES_DIR,
  file: string = DICTATION_HEARD,
): HeardFile {
  const parsed = heardFileSchema.safeParse(readJson(join(dir, file)));
  if (!parsed.success) {
    throw new Error(
      `${file} no es lo oído de un set inventado: la corrida se detiene (EV-1)`,
    );
  }
  return parsed.data;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
