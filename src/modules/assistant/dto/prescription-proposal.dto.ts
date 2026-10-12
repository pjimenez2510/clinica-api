import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  DOSAGE_FORM_CODES,
  DOSE_UNIT_CODES,
  FREQUENCY_CODES,
  MEDICATION_ROUTE_CODES,
} from '../../../shared/clinical/prescription-vocabulary';

/**
 * AS-063 to AS-076. The contract of the receta the assistant proposes.
 * Responses are schemas so `clinica-web` types them from OpenAPI. No
 * medicine name of the model's travels: only the cuadro's (AS-065).
 */

const code = <T extends string>(codes: readonly T[]) =>
  z.enum(codes as [T, ...T[]]).nullable();

const fieldsSchema = z.object({
  form: code(DOSAGE_FORM_CODES),
  concentration: z.string().nullable(),
  route: code(MEDICATION_ROUTE_CODES),
  doseAmount: z.number().nullable(),
  doseUnit: code(DOSE_UNIT_CODES),
  frequency: code(FREQUENCY_CODES),
  frequencyText: z.string().nullable(),
  durationDays: z.number().int().nullable(),
  quantity: z.number().nullable(),
});

const lineSchema = z.object({
  id: z.uuid(),
  /** The note's own sentence (P2). */
  quote: z.string(),
  section: z.string(),
  /** The medicine of the cuadro; null shows only the sentence (AS-065). */
  medicine: z
    .object({ conceptId: z.uuid(), code: z.string(), display: z.string() })
    .nullable(),
  fields: fieldsSchema,
  instructions: z.string().nullable(),
  /** AS-067. The fields nobody wrote: «Nadie lo dijo». */
  unsaid: z.array(z.enum(['presentation', 'route', 'dose', 'quantity'])),
  /** AS-068. The dose was written by weight: nothing was calculated. */
  doseByWeight: z.boolean(),
  /** AS-069. Null without a medicine; `failed` when it could not be checked. */
  allergy: z.enum(['exact', 'class', 'none', 'failed']).nullable(),
  /** AS-065, AS-071, AS-072. Why it cannot go to the receta now. */
  block: z
    .enum([
      'not-in-cnmb',
      'controlled',
      'already-prescribed',
      'allergy-exact',
      'allergy-check-failed',
    ])
    .nullable(),
  status: z.enum([
    'PROPOSED',
    'ACCEPTED',
    'ACCEPTED_WITH_CHANGES',
    'DISCARDED',
  ]),
  prescriptionId: z.uuid().nullable(),
  /** AS-029. Written by the demonstration script, not by a model. */
  demo: z.boolean(),
});

export const prescriptionOverviewSchema = z.object({
  lines: z.array(lineSchema),
  /** AS-069, AS-070. Said once, above the lines. */
  allergies: z.object({
    checked: z.boolean(),
    uncoded: z.boolean(),
    notAsked: z.boolean(),
  }),
  readAt: z.iso.datetime().nullable(),
  demo: z.boolean(),
});
/** Response of GET /encounters/:encounterId/assistant/prescription. */
export class PrescriptionProposalOverviewDto extends createZodDto(
  prescriptionOverviewSchema,
) {}

export const prescriptionReadingSchema = prescriptionOverviewSchema.extend({
  /** AS-081. How many lines this reading proposed: 0 is said on screen. */
  found: z.number().int(),
  /** Lines the model read whose phrase is not in the note: dropped. */
  dropped: z.number().int(),
});
/** Response of POST …/assistant/prescription/read. */
export class PrescriptionProposalReadingDto extends createZodDto(
  prescriptionReadingSchema,
) {}

export const confirmPrescriptionProposalSchema = z.object({
  /** AS-073. The lines the physician accepted. */
  suggestionIds: z
    .array(z.uuid())
    .min(1, 'Acepte al menos un medicamento')
    .max(20, 'Una receta no puede llevar más de 20 medicamentos'),
});
/** Body of POST …/assistant/prescription/confirm. */
export class ConfirmPrescriptionProposalDto extends createZodDto(
  confirmPrescriptionProposalSchema,
) {}

export const confirmedLinesSchema = z.object({
  items: z.array(
    fieldsSchema.omit({ form: true, route: true }).extend({
      suggestionId: z.uuid(),
      conceptId: z.uuid(),
      dosageForm: code(DOSAGE_FORM_CODES),
      routeCode: code(MEDICATION_ROUTE_CODES),
      instructions: z.string().nullable(),
    }),
  ),
});
/** Response of POST …/assistant/prescription/confirm: nothing was written. */
export class ConfirmedPrescriptionLinesDto extends createZodDto(
  confirmedLinesSchema,
) {}

export const linkPrescriptionProposalSchema = z.object({
  /** The receta the draft was saved as (PR-001, PR-100). */
  prescriptionId: z.uuid({ message: 'Indique la receta guardada' }),
  lines: z
    .array(
      z.object({
        suggestionId: z.uuid(),
        /** 1-based, the receta's own order. */
        line: z.number().int().min(1).max(20),
      }),
    )
    .min(1)
    .max(20),
});
/** Body of POST …/assistant/prescription/link. */
export class LinkPrescriptionProposalDto extends createZodDto(
  linkPrescriptionProposalSchema,
) {}
