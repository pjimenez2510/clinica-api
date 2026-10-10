import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  BACTERIURIA_RESULTS,
  GESTATIONAL_AGE_METHODS,
  GESTATIONAL_WEEKS,
  OBSTETRIC_RISKS,
  PARTNER_TREATMENTS,
  SYPHILIS_RESULTS,
  VACCINE_DOSES,
  VACCINE_RISK_GROUPS,
} from '../domain/program-blocks';

/**
 * EN-090 to EN-093, EN-249. Blocks G, H and I of the RDACAA form.
 *
 * Here, only the shape and the closed lists of the instructivo. Who may have
 * each block, the last menstrual period against the clinical date, whether a
 * code is a vaccine in force and whether the risk group fits the vaccines are
 * the database's (`encounter_*_applies`, `encounter_vaccination_valid`), which
 * answers naming the field.
 */

const yesNo = (label: string) =>
  z.boolean({ error: `Indique sí o no: ${label}` });

// ── G ───────────────────────────────────────────────────────────────────────

export const recordObstetricSchema = z
  .object({
    /** Column 39. */
    risk: z.enum(OBSTETRIC_RISKS, {
      error: 'Elija la categoría del riesgo obstétrico',
    }),
    /** Columns 40 to 42. */
    birthPlan: yesNo('plan de parto'),
    transportPlan: yesNo('plan de transporte'),
    plannedPregnancy: yesNo('embarazo planificado'),
    /** Column 43. With LMP the date is required (the database). */
    gestationalAgeMethod: z.enum(GESTATIONAL_AGE_METHODS, {
      error: 'Elija cómo se determinaron las semanas de gestación',
    }),
    /** Column 44, `YYYY-MM-DD`. */
    lastMenstrualPeriod: z.iso
      .date({ error: 'Escriba la fecha de la última menstruación' })
      .nullable()
      .default(null),
    /** Column 45. */
    gestationalWeeks: z
      .number({ error: 'Indique las semanas de gestación' })
      .int('Indique las semanas de gestación como número entero')
      .min(GESTATIONAL_WEEKS.min, 'Las semanas de gestación van de 1 a 42')
      .max(GESTATIONAL_WEEKS.max, 'Las semanas de gestación van de 1 a 42'),
    /** Columns 46 to 50, optional. */
    nonTreponemalTest: z.enum(SYPHILIS_RESULTS).nullable().default(null),
    treponemalTest: z.enum(SYPHILIS_RESULTS).nullable().default(null),
    syphilisTreatment: z.enum(SYPHILIS_RESULTS).nullable().default(null),
    partnerTreatment: z.enum(PARTNER_TREATMENTS).nullable().default(null),
    bacteriuria: z.enum(BACTERIURIA_RESULTS).nullable().default(null),
  })
  .strict();
/** Body of PUT /encounters/:encounterId/programs/obstetric. */
export class RecordObstetricDto extends createZodDto(recordObstetricSchema) {}

// ── H ───────────────────────────────────────────────────────────────────────

export const recordNutritionSchema = z
  .object({
    /** Column 52: the infant's mother, or the woman herself (EN-260). */
    motherBreastfeeding: yesNo('período de lactancia'),
    /** Column 53, from 0 to 5 months; `null` otherwise. */
    exclusiveBreastfeeding: z.boolean().nullable().default(null),
    /** Column 54, from 6 to 8 months; `null` otherwise. */
    complementaryFeeding: z.boolean().nullable().default(null),
  })
  .strict();
/** Body of PUT /encounters/:encounterId/programs/nutrition. */
export class RecordNutritionDto extends createZodDto(recordNutritionSchema) {}

// ── I ───────────────────────────────────────────────────────────────────────

const doseGivenSchema = z
  .object({
    /** The `VACCINE` catalogue code: the column of the form. */
    code: z
      .string({ error: 'Elija la vacuna' })
      .regex(/^\d{1,3}$/, 'Elija la vacuna de la lista'),
    dose: z.enum(VACCINE_DOSES, { error: 'Elija la dosis' }),
    /**
     * Column 74, of THIS dose (D-195.8); `null` when its vaccine asks for
     * none. Without the second key, an adult HB already recorded is sent back
     * with `null` and keeps its group (EN-261).
     */
    riskGroup: z.enum(VACCINE_RISK_GROUPS).nullable().default(null),
  })
  .strict();

export const recordVaccinationSchema = z
  .object({
    /** Empty: corrected to «none given». */
    doses: z.array(doseGivenSchema).max(40),
  })
  .strict();
/** Body of PUT /encounters/:encounterId/programs/vaccination. */
export class RecordVaccinationDto extends createZodDto(
  recordVaccinationSchema,
) {}

// ── Suplementos (EN-096) ────────────────────────────────────────────────────

const supplementBox = z.boolean().nullable().default(null);

export const recordSupplementsSchema = z
  .object({
    /** Column 105, from 6 to 24 months. */
    micronutrientPowder: supplementBox,
    /** Column 106, from 6 to 59 months. */
    vitaminA: supplementBox,
    /** Column 107, from 24 to 59 months. */
    ironSyrup: supplementBox,
    /** Column 108, pregnant or lactating women. */
    ironFolicAcid: supplementBox,
  })
  .strict();
/** Body of PUT /encounters/:encounterId/programs/supplements. */
export class RecordSupplementsDto extends createZodDto(
  recordSupplementsSchema,
) {}

// ── Responses ───────────────────────────────────────────────────────────────

const stamp = {
  recordedAt: z.iso.datetime(),
  /** EN-249. When it was last corrected; the previous is versioned. */
  editedAt: z.iso.datetime().nullable(),
};

export const obstetricRecordSchema = recordObstetricSchema
  .extend({ lastMenstrualPeriod: z.iso.date().nullable(), ...stamp })
  .required();
export class ObstetricRecordDto extends createZodDto(obstetricRecordSchema) {}

export const nutritionRecordSchema = recordNutritionSchema
  .extend(stamp)
  .required();
export class NutritionRecordDto extends createZodDto(nutritionRecordSchema) {}

export const vaccinationRecordSchema = z.object({
  doses: z.array(
    z.object({
      code: z.string(),
      dose: z.enum(VACCINE_DOSES),
      /** `null` too when withheld without the second key (REQ-115). */
      riskGroup: z.enum(VACCINE_RISK_GROUPS).nullable(),
    }),
  ),
  ...stamp,
});
export class VaccinationRecordDto extends createZodDto(
  vaccinationRecordSchema,
) {}

export const supplementRecordSchema = recordSupplementsSchema
  .extend(stamp)
  .required();
export class SupplementRecordDto extends createZodDto(supplementRecordSchema) {}

const supplementFlags = z.object({
  micronutrientPowder: z.boolean(),
  vitaminA: z.boolean(),
  ironSyrup: z.boolean(),
  ironFolicAcid: z.boolean(),
});

export const programsSheetSchema = z.object({
  /** `YYYY-MM-DD`, the attention's clinical date in America/Guayaquil. */
  clinicalDate: z.iso.date(),
  obstetric: z.object({
    /** EN-090. The chart's pregnancy in force that day. */
    applies: z.boolean(),
    record: obstetricRecordSchema.nullable(),
  }),
  nutrition: z.object({
    /**
     * EN-092, EN-260. The infant's band by the frozen age, or
     * `LACTATING_AGE_WOMAN` (only `motherBreastfeeding`, her own) — a woman
     * of 10 to 49, or of any age three months after a pregnancy ended
     * (D-202.1); `null`: not asked.
     */
    band: z
      .enum([
        'EXCLUSIVE_BREASTFEEDING',
        'COMPLEMENTARY_FEEDING',
        'LACTATING_AGE_WOMAN',
      ])
      .nullable(),
    record: nutritionRecordSchema.nullable(),
  }),
  vaccination: z.object({
    vaccines: z.array(z.object({ code: z.string(), display: z.string() })),
    record: vaccinationRecordSchema.nullable(),
    /**
     * REQ-115. The adult HB's risk group, left out without the second key;
     * the other doses keep theirs.
     */
    riskGroupWithheld: z.boolean(),
  }),
  supplements: z.object({
    /** EN-096. Which boxes the attention's population reaches. */
    applies: supplementFlags,
    /**
     * EN-262. What the prescriptions of the attention propose for each box,
     * `null` where it does not apply. A proposal: nothing is saved with it.
     */
    proposed: z.object({
      micronutrientPowder: z.boolean().nullable(),
      vitaminA: z.boolean().nullable(),
      ironSyrup: z.boolean().nullable(),
      ironFolicAcid: z.boolean().nullable(),
    }),
    record: supplementRecordSchema.nullable(),
  }),
});
/** Response of GET /encounters/:encounterId/programs. */
export class ProgramsSheetDto extends createZodDto(programsSheetSchema) {}

export type ProgramsSheetResponse = z.infer<typeof programsSheetSchema>;
export type ObstetricRecordResponse = z.infer<typeof obstetricRecordSchema>;
export type NutritionRecordResponse = z.infer<typeof nutritionRecordSchema>;
export type VaccinationRecordResponse = z.infer<typeof vaccinationRecordSchema>;
export type SupplementRecordResponse = z.infer<typeof supplementRecordSchema>;
