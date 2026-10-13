import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import {
  PREPARATION_FIELDS,
  SPEAKERS,
} from '../../src/modules/assistant/domain/preparation-reading.ts';
import { CASES_DIR } from '../cases.ts';
import {
  DICTATION_SETS,
  loadDictationCases,
  loadHeard,
} from '../dictation/cases.ts';

/**
 * AS-255. The invented preparations and what the recogniser heard of each
 * line. Only invented material: a file that says otherwise stops the run
 * before anything is measured (EV-1).
 */
const expectedSchema = z.partialRecord(z.enum(PREPARATION_FIELDS), z.number());

export const preparationCaseSchema = z.object({
  id: z.string().min(1),
  style: z.string().min(1),
  lines: z
    .array(z.object({ speaker: z.enum(SPEAKERS), text: z.string().min(1) }))
    .min(1),
  expected: expectedSchema,
  heightPosition: z.enum(['STANDING', 'LYING']).nullable(),
  /** The lines of the patient that hold the reason; null: the patient does not say one. */
  complaint: z.array(z.number().int().nonnegative()).min(1).nullable(),
});
export type PreparationCase = z.infer<typeof preparationCaseSchema>;

const casesFileSchema = z.object({
  origin: z.literal('invented'),
  description: z.string(),
  cases: z.array(preparationCaseSchema).min(1),
});

export const heardFileSchema = z.object({
  origin: z.literal('invented'),
  description: z.string(),
  casesSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Each case, each line as `clinica-ai` heard it, in order. */
  heard: z.array(z.object({ id: z.string(), lines: z.array(z.string()) })),
});
export type HeardFile = z.infer<typeof heardFileSchema>;

export const PREPARATION_CASES = join(CASES_DIR, 'preparaciones.json');
export const PREPARATION_HEARD = join(CASES_DIR, 'preparaciones-oido.json');

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

export function loadPreparationCases(file = PREPARATION_CASES) {
  const content = readFileSync(file, 'utf8');
  const { cases } = casesFileSchema.parse(JSON.parse(content));
  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error(`Casos con id repetido en ${file}`);
  }
  for (const item of cases) {
    for (const at of item.complaint ?? []) {
      if (item.lines[at]?.speaker !== 'patient') {
        throw new Error(`${item.id}: el motivo esperado no está en una línea del paciente`); // prettier-ignore
      }
    }
  }
  return { cases, sha256: sha256(content) };
}

/**
 * AS-255. B2's reserved dictations, each one line said by whoever prepares:
 * nothing of them was used to write the preparation's prompt.
 */
export function reservedDictations(): PreparationCase[] {
  return loadDictationCases(CASES_DIR, DICTATION_SETS.reservado.cases).map(
    (item) => ({
      id: `B2-${item.id}`,
      style: `b2-${item.category}`,
      lines: [{ speaker: 'nursing' as const, text: item.text }],
      expected: item.expected,
      heightPosition: null,
      complaint: null,
    }),
  );
}

/** AS-255. What `clinica-ai` heard of B2's reserved dictations, by voice. */
export function reservedDictationsHeard(): {
  id: string;
  voice: string;
  lines: string[];
}[] {
  // prettier-ignore
  return loadHeard(CASES_DIR, DICTATION_SETS.reservado.heard).heard.map((each) => ({
    id: `B2-${each.id}`,
    voice: `${each.voice}${each.rate ? ` · ${each.rate}` : ''}`,
    lines: [each.text],
  }));
}

export function loadPreparationHeard(
  casesSha256: string,
  file = PREPARATION_HEARD,
) {
  const parsed = heardFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (parsed.casesSha256 !== casesSha256) {
    throw new Error(
      'Lo oído es de otra versión de las preparaciones: vuelva a oírlas con --oir',
    );
  }
  return parsed.heard;
}
