import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  type ClinicalDate,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import { MAX_CSV_WEEKS, weeksSpanned } from '../domain/assistant-quality';

/**
 * E19 (AS-345 to AS-353). The contract of «Calidad del asistente».
 *
 * ⚠️ NO FIELD HERE CARRIES TEXT OF THE RECORD (AS-349): ids of the attention,
 * task, class and section codes, counts, rates, costs and times. The names
 * are the site's and the practitioner's, never the patient's. A field added
 * here that carries a proposal, a source or a note is the leak AS-349 forbids,
 * and the integration test that looks for the seeded text fails.
 */

/** AS-353. A `YYYY-MM-DD` that exists on the calendar. */
const clinicalDate = (message: string) =>
  z.iso.date(message).transform((value, ctx): ClinicalDate => {
    try {
      return parseClinicalDate(value);
    } catch {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    }
  });

/** AS-348, AS-353. The week that contains `date`, optionally at one site. */
export const qualityWeekQuerySchema = z.object({
  date: clinicalDate('Indique un día de la semana en formato AAAA-MM-DD'),
  siteId: z.uuid('Elija una sede de la lista').optional(),
});
export class QualityWeekQueryDto extends createZodDto(qualityWeekQuerySchema) {}

/** AS-352, AS-353. From the week of `from` to the week of `to`, both included. */
export const qualityCsvQuerySchema = z
  .object({
    from: clinicalDate('Indique la fecha inicial en formato AAAA-MM-DD'),
    to: clinicalDate('Indique la fecha final en formato AAAA-MM-DD'),
  })
  .refine((query) => query.from <= query.to, {
    error: 'La fecha final no puede ser anterior a la inicial',
    path: ['to'],
  })
  .refine((query) => weeksSpanned(query.from, query.to) <= MAX_CSV_WEEKS, {
    error: `El rango no puede pasar de ${MAX_CSV_WEEKS} semanas`,
    path: ['to'],
  });
export class QualityCsvQueryDto extends createZodDto(qualityCsvQuerySchema) {}

const count = z.number().int().nonnegative();
/** A share in [0, 1], empty when there is nothing to divide by (AS-348). */
const share = z.number().min(0).max(1).nullable();
/** Dollars as the database's decimal text: no float rounding on the way. */
const usd = z.string().regex(/^\d+\.\d{8}$/);

const proposalCounts = {
  proposals: count,
  accepted: count,
  edited: count,
  discarded: count,
  untouched: count,
  superseded: count,
  amber: count,
  reviewed: count,
  medianDistance: share,
};

const taskSchema = z.object({
  purpose: z.string(),
  attempts: count,
  answered: count,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  costUsd: usd,
  attemptsWithoutCost: count,
  medianLatencyMs: z.number().nonnegative().nullable(),
  maxLatencyMs: z.number().nonnegative().nullable(),
});

const proposalSchema = z.object({
  kind: z.string(),
  section: z.string().nullable(),
  ...proposalCounts,
  acceptance: share,
});

const siteWeekSchema = z.object({
  week: z.iso.date(),
  siteId: z.uuid().nullable(),
  siteName: z.string().nullable(),
  encounters: count,
  assisted: count,
  adoption: share,
  attempts: count,
  answered: count,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  costUsd: usd,
  attemptsWithoutCost: count,
  costPerAssisted: usd.nullable(),
  cacheRate: share,
  medianLatencyMs: z.number().nonnegative().nullable(),
  ...proposalCounts,
  acceptance: share,
});

const encounterFields = {
  encounterId: z.uuid(),
  startedAt: z.iso.datetime({ offset: true }),
  siteId: z.uuid(),
  siteName: z.string(),
  practitionerName: z.string(),
  status: z.string(),
};

export const qualityWeekSchema = z.object({
  weekStart: z.iso.date(),
  weekEnd: z.iso.date(),
  siteId: z.uuid().nullable(),
  sites: z.array(z.object({ id: z.uuid(), name: z.string() })),
  total: siteWeekSchema,
  bySite: z.array(siteWeekSchema),
  tasks: z.array(taskSchema),
  proposals: z.array(proposalSchema),
  encounters: z.array(
    z.object({
      ...encounterFields,
      attempts: count,
      costUsd: usd,
      proposals: count,
      accepted: count,
      edited: count,
    }),
  ),
});
export class QualityWeekDto extends createZodDto(qualityWeekSchema) {}
export type QualityWeekResponse = z.infer<typeof qualityWeekSchema>;

export const encounterQualitySchema = z.object({
  ...encounterFields,
  tasks: z.array(taskSchema),
  proposals: z.array(proposalSchema),
  totals: z.object({
    attempts: count,
    inputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
    costUsd: usd,
    cacheRate: share,
    proposals: count,
    acceptance: share,
  }),
});
export class EncounterQualityDto extends createZodDto(encounterQualitySchema) {}
export type EncounterQualityResponse = z.infer<typeof encounterQualitySchema>;
