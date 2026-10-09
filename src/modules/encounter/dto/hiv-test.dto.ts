import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  HIV_TEST_DEVICES,
  HIV_TEST_REASONS,
  HIV_TEST_RESULTS,
  HIV_TRANSMISSION_ROUTES,
} from '../domain/hiv-test';

/**
 * EN-094. Block J. Here, the shape and the closed lists; «the confirmation
 * only after a reactive screening» is the database's
 * (`encounter_hiv_test_confirmation_needs_reactive`), which answers
 * `CONFIRMATORY_TEST_WITHOUT_SCREENING`.
 *
 * ⚠️ No message here names the datum: they read «la prueba», «la sección».
 */
const testSchema = z
  .object({
    device: z.enum(HIV_TEST_DEVICES, {
      error: 'Elija el dispositivo empleado',
    }),
    result: z.enum(HIV_TEST_RESULTS, { error: 'Elija el resultado' }),
  })
  .strict();

const count = (label: string, max: number) =>
  z
    .number({ error: `Escriba ${label} como número` })
    .int(`Escriba ${label} como número entero`)
    .min(0, `${label} no puede ser negativo`)
    .max(max, `Revise ${label}: el valor es demasiado alto`)
    .nullable()
    .default(null);

export const recordHivTestSchema = z
  .object({
    /** Column 75. */
    reason: z.enum(HIV_TEST_REASONS, { error: 'Elija el motivo de la prueba' }),
    /** Columns 76 and 77. */
    screening: testSchema,
    /** Columns 78 and 79, only after a reactive screening. */
    confirmation: testSchema.nullable().default(null),
    /** Column 80. */
    transmissionRoute: z.enum(HIV_TRANSMISSION_ROUTES).nullable().default(null),
    /** Column 81, copies/mL. */
    viralLoad: count('la carga viral', 100_000_000),
    /** Column 82, cells/mm³. */
    cd4: count('el CD4', 5_000),
  })
  .strict();
/** Body of PUT /encounters/:encounterId/programs/restricted. */
export class RecordHivTestDto extends createZodDto(recordHivTestSchema) {}

export const hivTestSchema = recordHivTestSchema.extend({
  confirmation: testSchema.nullable(),
  transmissionRoute: z.enum(HIV_TRANSMISSION_ROUTES).nullable(),
  viralLoad: z.number().int().nullable(),
  cd4: z.number().int().nullable(),
  recordedAt: z.iso.datetime(),
  editedAt: z.iso.datetime().nullable(),
});
export class HivTestDto extends createZodDto(hivTestSchema) {}

/**
 * Response of GET /encounters/:encounterId/programs/restricted. Without the
 * second key at the site: `{}` — the key `test` is ABSENT, not `null`, so an
 * attention with a test and one without read the same.
 */
export const hivTestSheetSchema = z.object({
  test: hivTestSchema.nullable().optional(),
});
export class HivTestSheetDto extends createZodDto(hivTestSheetSchema) {}

export type HivTestResponse = z.infer<typeof hivTestSchema>;
export type HivTestSheetResponse = z.infer<typeof hivTestSheetSchema>;
