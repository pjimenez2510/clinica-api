import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const HISTORY_KIND = z.enum(['PERSONAL', 'FAMILY']);

/**
 * EN-085. One entry of the patient's history.
 *
 * THE RELATIVE IS REQUIRED FOR `FAMILY` AND REFUSED FOR `PERSONAL`, here for
 * the sentence and in the database for the guarantee
 * (`patient_history_family_names_relative`): the mother's diabetes and a
 * cousin's do not weigh the same.
 */
export const recordHistorySchema = z
  .object({
    kind: HISTORY_KIND,
    description: z
      .string()
      .trim()
      .min(1, 'Describa el antecedente')
      .max(500, 'El antecedente no puede superar 500 caracteres'),
    relative: z
      .string()
      .trim()
      .max(80, 'El parentesco no puede superar 80 caracteres')
      .transform((value) => (value === '' ? undefined : value))
      .optional(),
  })
  .superRefine((body, context) => {
    if (body.kind === 'FAMILY' && body.relative === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['relative'],
        message: 'Indique de qué familiar es el antecedente',
      });
    }
    if (body.kind === 'PERSONAL' && body.relative !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['relative'],
        message: 'Un antecedente personal no lleva parentesco',
      });
    }
  });
/** Body of POST /patients/:patientId/history. */
export class RecordHistoryDto extends createZodDto(recordHistorySchema) {}

export const refuteHistorySchema = z.object({
  notes: z
    .string()
    .trim()
    .min(1, 'Escriba por qué se descarta el antecedente')
    .max(2000, 'El motivo no puede superar 2000 caracteres'),
});
/** Body of POST /patients/:patientId/history/:historyId/refute. */
export class RefuteHistoryDto extends createZodDto(refuteHistorySchema) {}

const AUTHOR = z.object({ id: z.uuid(), name: z.string() });

export const historySchema = z.object({
  id: z.uuid(),
  /** The chart it was WRITTEN ON; after a merge it may be an absorbed one. */
  patientId: z.uuid(),
  kind: HISTORY_KIND,
  description: z.string(),
  relative: z.string().nullable(),
  recordedAt: z.iso.datetime(),
  /** EN-086. Who recorded it: a history entry is always somebody's word. */
  recordedBy: AUTHOR,
  refutedAt: z.iso.datetime().nullable(),
  refutedNotes: z.string().nullable(),
  refutedBy: AUTHOR.nullable(),
});
/** Response of recording and of refuting a history entry. */
export class HistoryDto extends createZodDto(historySchema) {}

export const historyListSchema = z.object({ items: z.array(historySchema) });
/** Response of GET /patients/:patientId/history. */
export class HistoryListDto extends createZodDto(historyListSchema) {}

export type HistoryResponse = z.infer<typeof historySchema>;
export type HistoryListResponse = z.infer<typeof historyListSchema>;
