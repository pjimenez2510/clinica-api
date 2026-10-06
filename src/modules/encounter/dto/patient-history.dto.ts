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
  /** EN-219. Optional: «Registrado por error», «Se descartó» or «Otro». */
  notes: z
    .string()
    .trim()
    .max(2000, 'El motivo no puede superar 2000 caracteres')
    .optional(),
});
export class RefuteHistoryDto extends createZodDto(refuteHistorySchema) {}

/**
 * EN-220. Editing an entry in its row. The relative follows the kind, as when
 * recording one: a change to `FAMILY` brings the relative, one to `PERSONAL`
 * brings none (and the adapter clears the old one). `.strict()`: unknown
 * fields are refused.
 */
export const editHistorySchema = z
  .object({
    kind: HISTORY_KIND.optional(),
    description: z
      .string()
      .trim()
      .min(1, 'Describa el antecedente')
      .max(500, 'El antecedente no puede superar 500 caracteres')
      .optional(),
    relative: z
      .string()
      .trim()
      .max(80, 'El parentesco no puede superar 80 caracteres')
      .nullable()
      .optional()
      .transform((value) => (value === '' ? null : value)),
  })
  .strict()
  .superRefine((body, context) => {
    if (body.kind === 'FAMILY' && !body.relative) {
      context.addIssue({
        code: 'custom',
        path: ['relative'],
        message: 'Indique de qué familiar es el antecedente',
      });
    }
    if (body.kind === 'PERSONAL' && body.relative) {
      context.addIssue({
        code: 'custom',
        path: ['relative'],
        message: 'Un antecedente personal no lleva parentesco',
      });
    }
  });
export class EditHistoryDto extends createZodDto(editHistorySchema) {}

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
  /** EN-220. The last change, or `null`: a date means earlier versions. */
  changedAt: z.iso.datetime().nullable(),
});
/** Response of recording, editing, refuting and reactivating an entry. */
export class HistoryDto extends createZodDto(historySchema) {}

/** EN-220. The versions the changes replaced, newest first. */
export const historyVersionListSchema = z.object({
  items: z.array(
    z.object({
      version: z.number().int(),
      replacedBy: AUTHOR,
      replacedAt: z.iso.datetime(),
      entry: historySchema,
    }),
  ),
});
export class HistoryVersionListDto extends createZodDto(
  historyVersionListSchema,
) {}

export const historyListSchema = z.object({ items: z.array(historySchema) });
/** Response of GET /patients/:patientId/history. */
export class HistoryListDto extends createZodDto(historyListSchema) {}

export type HistoryResponse = z.infer<typeof historySchema>;
export type HistoryListResponse = z.infer<typeof historyListSchema>;
export type HistoryVersionListResponse = z.infer<
  typeof historyVersionListSchema
>;
