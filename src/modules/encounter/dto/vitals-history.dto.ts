import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * EN-269. One taking of block D, as the «Evolución» tab draws it: every
 * figure, the instant it was measured and the age FROZEN on its attention.
 *
 * ⚠️ NO `presentingComplaint` (EN-163): it is the patient's words, not a
 * figure anybody plots, and it is served where it is read — the attention.
 */
export const vitalsTakingSchema = z.object({
  /** The attention it belongs to: the link, opened at `GET /encounters/:id`. */
  encounterId: z.uuid(),
  siteId: z.uuid(),
  measuredAt: z.iso.datetime(),
  /** EN-221, EN-008. The age of that day, never recomputed. */
  ageYears: z.number().int().nullable(),
  ageMonths: z.number().int().nullable(),
  ageDays: z.number().int().nullable(),
  weightKg: z.number().nullable(),
  heightCm: z.number().nullable(),
  heightPosition: z.enum(['STANDING', 'LYING']).nullable(),
  headCircumferenceCm: z.number().nullable(),
  abdominalCircumferenceCm: z.number().nullable(),
  /** EN-061. Written by the database, never derived by a client. */
  bmi: z.number().nullable(),
  systolicBp: z.number().int().nullable(),
  diastolicBp: z.number().int().nullable(),
  heartRate: z.number().int().nullable(),
  respiratoryRate: z.number().int().nullable(),
  temperatureC: z.number().nullable(),
  oxygenSaturation: z.number().int().nullable(),
  hemoglobinGDl: z.number().nullable(),
  hemoglobinCorrectedGDl: z.number().nullable(),
});

export const vitalsHistorySchema = z.object({
  /** The chart asked about, always an open one (EN-271). */
  patientId: z.uuid(),
  /** EN-269. Newest first, at most 100; never an annulled attention's (EN-270). */
  items: z.array(vitalsTakingSchema),
  /** EN-269. How many there are within the caller's scope. */
  total: z.number().int(),
  /**
   * EN-272. The blood-pressure line, in mmHg: the lowest of the sites in the
   * caller's scope. The value is a clinician's to confirm (D-207 §1).
   */
  bloodPressureReference: z
    .object({ systolic: z.number().int(), diastolic: z.number().int() })
    .nullable(),
});
/** Response of GET /patients/:patientId/vitals. */
export class VitalsHistoryDto extends createZodDto(vitalsHistorySchema) {}
export type VitalsHistoryResponse = z.infer<typeof vitalsHistorySchema>;
