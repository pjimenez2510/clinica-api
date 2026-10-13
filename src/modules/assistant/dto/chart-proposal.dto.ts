import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * AS-263 to AS-265. The contract of the proposals of the chart in
 * Antecedentes. Responses are schemas so `clinica-web` types them from
 * OpenAPI; every kind carries every field, null where it does not apply.
 */
const chartProposalSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['chart-no-allergy', 'chart-allergy', 'chart-history']),
  /** What would be recorded, as one line: «Hipertensión arterial · Madre». */
  text: z.string(),
  /** AS-263 (P2). Its line of the conversation, and the stretch of it. */
  quote: z.string(),
  fromMs: z.number().int(),
  toMs: z.number().int(),
  /** `chart-allergy`: what `POST /patients/:id/allergies` receives. */
  substance: z.string().nullable(),
  /** EN-084. The CNMB medicine the substance is, when it is one. */
  substanceConceptId: z.uuid().nullable(),
  reaction: z.string().nullable(),
  /** `chart-history`: what `POST /patients/:id/history` receives. */
  history: z.enum(['PERSONAL', 'FAMILY']).nullable(),
  description: z.string().nullable(),
  relative: z.string().nullable(),
  /** AS-264. «Sin alergias» with an active allergy on the chart: not recorded as is. */
  conflict: z.enum(['active-allergy']).nullable(),
  /** AS-029. Written by the demonstration script, not by a model. */
  demo: z.boolean(),
});

export const chartOverviewSchema = z.object({
  proposals: z.array(chartProposalSchema),
  /** AS-029. The demonstration mode is on: nothing here came from a model. */
  demo: z.boolean(),
});
/** Response of GET and of accepting or discarding a proposal of the chart. */
export class ChartOverviewDto extends createZodDto(chartOverviewSchema) {}

/** AS-265. Body of accepting: the record just made by the chart's own route. */
export const acceptChartProposalSchema = z
  .object({
    recordId: z.uuid({ message: 'Indique el registro de la ficha' }),
  })
  .strict();
export class AcceptChartProposalDto extends createZodDto(
  acceptChartProposalSchema,
) {}
