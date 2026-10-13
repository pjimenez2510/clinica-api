import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * AS-180, AS-196. The contract of the dictated vital signs. Responses are
 * schemas so `clinica-web` types them from OpenAPI.
 */
const dictatedField = z.enum([
  'systolicBp',
  'diastolicBp',
  'heartRate',
  'respiratoryRate',
  'temperatureC',
  'oxygenSaturation',
  'weightKg',
  'heightCm',
]);

export const vitalsDictationSchema = z.object({
  /** What `clinica-ai` heard, for the screen to show; never stored (AS-184). */
  heard: z.string(),
  /** AS-180. The readings understood, by the name of the taking's field. */
  signs: z.partialRecord(dictatedField, z.number()),
  /** AS-182. Named aloud but not read with certainty: typed by hand. */
  unclear: z.array(dictatedField),
});

export class VitalsDictationDto extends createZodDto(vitalsDictationSchema) {}

export const vitalsDictationLimitsSchema = z.object({
  /** AS-196. The longest dictation the screen records, in seconds. */
  maxSeconds: z.number().int().positive(),
});

export class VitalsDictationLimitsDto extends createZodDto(
  vitalsDictationLimitsSchema,
) {}
