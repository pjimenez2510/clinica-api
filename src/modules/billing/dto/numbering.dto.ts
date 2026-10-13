import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  MAX_SEQUENTIAL,
  VOUCHER_TYPES,
} from '../domain/emission-point-numbering';

/** BI-306 to BI-309 (D-262). The «próximo número» of each emission point. */

const sequentialNumber = (field: string) =>
  z
    .number({ error: `${field}: escriba un número entero` })
    .int(`${field}: escriba un número entero`)
    .min(1, `${field}: desde 1`)
    .max(MAX_SEQUENTIAL, `${field}: hasta 999999999`)
    .nullable();

export const fixNumberingSchema = z.object({
  /** `null` removes the floor: the point goes on from the largest used. */
  nextSequential: sequentialNumber('Próximo número'),
  previousSystemLast: sequentialNumber('Último del sistema anterior'),
  // BI-306. Required, but said by the service with its own code.
  reason: z
    .string()
    .max(300, 'El motivo tiene como máximo 300 caracteres')
    .default(''),
});
/** Body of PUT /billing/sites/:siteId/numbering/:emissionPointId/:documentType. */
export class FixNumberingDto extends createZodDto(fixNumberingSchema) {}

const numberingResponseSchema = z.object({
  emissionPointId: z.uuid(),
  emissionPointCode: z.string(),
  emissionPointActive: z.boolean(),
  documentType: z.enum(VOUCHER_TYPES),
  usedUpTo: z.number().int(),
  nextSequential: z.number().int().nullable(),
  previousSystemLast: z.number().int().nullable(),
  nextToIssue: z.number().int(),
  belowPreviousSystem: z.boolean(),
  lastChange: z
    .object({
      at: z.string(),
      by: z.object({ id: z.uuid(), name: z.string() }),
      reason: z.string(),
    })
    .nullable(),
});
export class NumberingDto extends createZodDto(numberingResponseSchema) {}
export type NumberingResponse = z.infer<typeof numberingResponseSchema>;

const numberingListSchema = z.object({
  items: z.array(numberingResponseSchema),
});
export class NumberingListDto extends createZodDto(numberingListSchema) {}
