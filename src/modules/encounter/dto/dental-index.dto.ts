import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * EN-052. The CEO-D / CPO-D of an attention.
 *
 * Here each count is a whole number from 0 to 32, the teeth a mouth can have.
 * The 20 primary teeth of the CEO-D and the bound on the sum are the
 * database's (`encounter_dental_index_*`), which answers naming the count.
 */
const DENTAL_INDEX = z.enum(['CEO_D', 'CPO_D']);
const count = (label: string) =>
  z
    .number({ error: `Indique los dientes ${label}` })
    .int(`Indique los dientes ${label} como número entero`)
    .min(0, `Los dientes ${label} no pueden ser negativos`)
    .max(32, `Los dientes ${label} son 32 como mucho`);

export const recordDentalIndexSchema = z
  .object({
    /** Which index the screen is filling: the one `GET` said applies. */
    index: DENTAL_INDEX,
    /** Column 101. */
    decayed: count('cariados'),
    /** Column 103. */
    filled: count('obturados'),
    /** Column 102. CEO-D only. */
    extracted: count('extraídos').optional(),
    /** Column 104. CPO-D only. */
    missing: count('perdidos').optional(),
  })
  .strict()
  .superRefine((body, context) => {
    if (body.index === 'CEO_D' && body.extracted === undefined) {
      context.addIssue({ code: 'custom', path: ['extracted'], message: 'Indique los dientes extraídos' }); // prettier-ignore
    }
    if (body.index === 'CPO_D' && body.missing === undefined) {
      context.addIssue({ code: 'custom', path: ['missing'], message: 'Indique los dientes perdidos' }); // prettier-ignore
    }
  });
/** Body of PUT /encounters/:encounterId/dental-index. */
export class RecordDentalIndexDto extends createZodDto(
  recordDentalIndexSchema,
) {}

export const dentalIndexSchema = z.object({
  /**
   * EN-052, D-160. Which index the attention takes: `null` when it is not
   * odontology or its frozen age is in neither band (11 years, 6 months or
   * less, unknown). The screen shows the card only when it is not `null`.
   */
  index: DENTAL_INDEX.nullable(),
  /** What was recorded, or `null` if nothing yet. */
  reading: z
    .object({
      decayed: z.number().int().nullable(),
      extracted: z.number().int().nullable(),
      filled: z.number().int().nullable(),
      missing: z.number().int().nullable(),
      recordedAt: z.iso.datetime(),
      /** EN-210. When it was last corrected; the previous is versioned. */
      editedAt: z.iso.datetime().nullable(),
    })
    .nullable(),
});
/** Response of GET and PUT /encounters/:encounterId/dental-index. */
export class DentalIndexDto extends createZodDto(dentalIndexSchema) {}

export type DentalIndexResponse = z.infer<typeof dentalIndexSchema>;
