import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * AS-027, AS-036, AS-037. The contract of the CIE-10 the assistant proposes.
 * Responses are schemas so `clinica-web` types them from OpenAPI.
 */

const offeredCodeSchema = z.object({
  conceptId: z.uuid(),
  code: z.string(),
  display: z.string(),
});

const baselineCodeSchema = offeredCodeSchema.extend({
  /** Where it comes from: the patient's own history, or the clinic's frequency. */
  source: z.enum(['history', 'frequency']),
  times: z.number().int(),
  /** `YYYY-MM-DD`, in America/Guayaquil. */
  lastUsedOn: z.string(),
});

const problemSchema = z.object({
  id: z.uuid(),
  problem: z.string(),
  /** The phrase of the note that states it (P2). */
  quote: z.string(),
  /** The key of the note's section the phrase is in. */
  section: z.string(),
  candidates: z.array(
    offeredCodeSchema.extend({
      /** Already recorded in this attention. */
      recorded: z.boolean(),
    }),
  ),
  status: z.enum([
    'PROPOSED',
    'ACCEPTED',
    'ACCEPTED_WITH_CHANGES',
    'DISCARDED',
  ]),
  diagnosisId: z.uuid().nullable(),
  /** AS-029. Written by the demonstration script, not by a model. */
  demo: z.boolean(),
});

export const diagnosisOverviewSchema = z.object({
  baseline: z.array(baselineCodeSchema),
  problems: z.array(problemSchema),
  readAt: z.iso.datetime().nullable(),
  /** AS-029. The demonstration mode is on: nothing here came from a model. */
  demo: z.boolean(),
});
/** Response of GET /encounters/:encounterId/assistant/diagnoses. */
export class DiagnosisOverviewDto extends createZodDto(
  diagnosisOverviewSchema,
) {}

export const diagnosisReadingSchema = diagnosisOverviewSchema.extend({
  /** AS-044. How many problems this reading proposed: 0 is said on screen. */
  found: z.number().int(),
  /** Problems the model named whose phrase is not in the note: dropped. */
  dropped: z.number().int(),
});
/** Response of POST /encounters/:encounterId/assistant/diagnoses/read. */
export class DiagnosisReadingDto extends createZodDto(diagnosisReadingSchema) {}

export const acceptDiagnosisProposalSchema = z.object({
  /** The diagnosis the physician recorded from the proposal (EN-040). */
  diagnosisId: z.uuid({ message: 'Indique el diagnóstico registrado' }),
});
/** Body of POST …/assistant/diagnoses/:suggestionId/accept. */
export class AcceptDiagnosisProposalDto extends createZodDto(
  acceptDiagnosisProposalSchema,
) {}
