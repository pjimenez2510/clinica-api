import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  AGGRESSOR_IDENTIFIED,
  AGGRESSOR_RELATIONSHIPS,
  SCREENING_RESULTS,
  VIOLENCE_INJURIES,
  VIOLENCE_TYPES,
} from '../domain/violence-screening';

/**
 * Block F of form 002 (EN-070 to EN-078).
 *
 * ⚠️ NO MESSAGE HERE ECHOES A VALUE (EN-073): each one says which field to
 * fix, never what was sent. The cross-field rules repeat, per field and
 * earlier, the CHECKs of `20261008170000_violence_screening_block_f`, which
 * remain the guarantee.
 */
const RESULT = z.enum(SCREENING_RESULTS, {
  error: 'Indique el resultado del tamizaje',
});
const TYPE = z.enum(VIOLENCE_TYPES, { error: 'Tipo de violencia no válido' });

const notificationSchema = z
  .object({
    /** Column 35. The serial of the PHYSICAL form, as text. */
    formSerial: z
      .string({ error: 'Indique el número de serie del formulario' })
      .trim()
      .min(1, 'Indique el número de serie del formulario')
      .max(40, 'El número de serie tiene 40 caracteres como mucho'),
    /** Column 36. */
    injury: z.enum(VIOLENCE_INJURIES, { error: 'Indique las lesiones' }),
    /** Column 37. */
    aggressorIdentified: z.enum(AGGRESSOR_IDENTIFIED, {
      error: 'Indique si identifica al presunto agresor',
    }),
    /** Column 38. */
    aggressorRelationship: z.enum(AGGRESSOR_RELATIONSHIPS, {
      error: 'Indique el parentesco con el agresor',
    }),
  })
  .strict();

const positive = (result: z.infer<typeof RESULT>) =>
  result === 'SUSPECTED' || result === 'CONFIRMED';

export const recordScreeningSchema = z
  .object({
    result: RESULT,
    /** EN-071. At least one when positive, none otherwise. */
    types: z.array(TYPE).max(VIOLENCE_TYPES.length).default([]),
    /** EN-077. Mandatory when positive. */
    actionTaken: z
      .string()
      .trim()
      .max(2000, 'La acción tomada tiene 2000 caracteres como mucho')
      .nullish(),
    /** The instrument, if the clinic uses one (D-188 §2). */
    screeningTool: z
      .string()
      .trim()
      .max(80, 'El instrumento tiene 80 caracteres como mucho')
      .nullish(),
    /** EN-074. Present only when the case was notified to the authority. */
    notification: notificationSchema.nullish(),
  })
  .strict()
  .superRefine((body, context) => {
    const isPositive = positive(body.result);
    if (isPositive && body.types.length === 0) {
      context.addIssue({ code: 'custom', path: ['types'], message: 'Marque al menos un tipo de violencia' }); // prettier-ignore
    }
    if (!isPositive && body.types.length > 0) {
      context.addIssue({ code: 'custom', path: ['types'], message: 'Sin signos no se marca ningún tipo' }); // prettier-ignore
    }
    if (new Set(body.types).size !== body.types.length) {
      context.addIssue({ code: 'custom', path: ['types'], message: 'Cada tipo se marca una vez' }); // prettier-ignore
    }
    if (isPositive && !body.actionTaken) {
      context.addIssue({ code: 'custom', path: ['actionTaken'], message: 'Escriba la acción tomada' }); // prettier-ignore
    }
    if (!isPositive && body.actionTaken) {
      context.addIssue({ code: 'custom', path: ['actionTaken'], message: 'Sin signos no hay acción tomada que registrar' }); // prettier-ignore
    }
    if (!isPositive && body.notification) {
      context.addIssue({ code: 'custom', path: ['notification'], message: 'Sólo se notifica un tamizaje con signos' }); // prettier-ignore
    }
  });
export class RecordScreeningDto extends createZodDto(recordScreeningSchema) {}

export const screeningSchema = z.object({
  result: RESULT,
  types: z.array(TYPE),
  actionTaken: z.string().nullable(),
  screeningTool: z.string().nullable(),
  notification: notificationSchema.nullable(),
  /** EN-076. Who answered it and when. */
  screenedById: z.uuid(),
  screenedAt: z.iso.datetime(),
});
export class ScreeningDto extends createZodDto(screeningSchema) {}

/**
 * EN-072. `screening` is ABSENT when the caller lacks `record:protected` at
 * the attention's site — the omission, not a refusal —, `null` when it holds
 * the key and nobody has answered yet, and the answer otherwise.
 */
export const screeningSheetSchema = z.object({
  screening: screeningSchema.nullable().optional(),
});
export class ScreeningSheetDto extends createZodDto(screeningSheetSchema) {}

export type ScreeningResponse = z.infer<typeof screeningSchema>;
export type ScreeningSheetResponse = z.infer<typeof screeningSheetSchema>;
