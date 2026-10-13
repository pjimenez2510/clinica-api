import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** A day of the Ecuadorian calendar, `YYYY-MM-DD`. */
const clinicalDate = z.iso.date();

/**
 * AS-201, AS-202. One result of a current report: the same columns the
 * order's report serves (`GET /orders/:id/reports`), so the figures are the
 * report's (SC-098).
 */
export const historyResultSchema = z.object({
  /** `observation_result.id`, a bigint, as text. */
  id: z.string(),
  orderId: z.uuid(),
  encounterId: z.uuid(),
  /** The determination in the catalogue, when the laboratory named one. */
  analyteConceptId: z.uuid().nullable(),
  analyteDisplay: z.string(),
  valueNumeric: z.number().nullable(),
  valueText: z.string().nullable(),
  valueCode: z.string().nullable(),
  unit: z.string().nullable(),
  referenceLow: z.number().nullable(),
  referenceHigh: z.number().nullable(),
  referenceText: z.string().nullable(),
  criticalLow: z.number().nullable(),
  criticalHigh: z.number().nullable(),
  /** AS-202. As the report stored it; `null` is «sin rango», never normal. */
  abnormalFlag: z
    .enum(['NORMAL', 'LOW', 'HIGH', 'CRITICAL_LOW', 'CRITICAL_HIGH'])
    .nullable(),
  observedAt: z.iso.datetime(),
  /** AS-206. The curve it belongs to; `null` when it is not a number. */
  seriesKey: z.string().nullable(),
  /** EN-275. Recorded on a chart this one absorbed. */
  fromMergedChart: z.boolean(),
});

/** AS-203, AS-204. A medicine, once. */
export const historyMedicationSchema = z.object({
  key: z.string(),
  genericName: z.string(),
  concentration: z.string().nullable(),
  presentation: z.string().nullable(),
  lastDoseText: z.string(),
  lastFrequencyText: z.string(),
  timesPrescribed: z.number().int(),
  firstPrescribedOn: clinicalDate,
  lastPrescribedOn: clinicalDate,
  /** The last day it reaches; `null` when its last prescription states no days. */
  endsOn: clinicalDate.nullable(),
  status: z.enum(['ACTIVE', 'ENDED', 'NO_DURATION']),
  lastPrescriptionId: z.uuid(),
  fromMergedChart: z.boolean(),
});

const diagnosisSchema = z.object({ code: z.string(), display: z.string() });

/** AS-205. One line of a day. */
export const timelineItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('visit'),
    encounterId: z.uuid(),
    /** EN-163, taken in preparation; `null` is written «Consulta». */
    complaint: z.string().nullable(),
    diagnoses: z.array(diagnosisSchema),
    siteName: z.string(),
    fromMergedChart: z.boolean(),
  }),
  z.object({
    kind: z.enum(['medication-started', 'medication-ended']),
    medicationKey: z.string(),
    name: z.string(),
  }),
  z.object({
    kind: z.literal('result'),
    /** The result in `results.items`, where its value and flag are. */
    resultId: z.string(),
    orderId: z.uuid(),
  }),
]);

export const clinicalHistorySchema = z.object({
  /** The chart asked about, always an open one (AS-200). */
  patientId: z.uuid(),
  results: z.object({
    /** AS-201. Newest first, at most 300 (AS-207). */
    items: z.array(historyResultSchema),
    total: z.number().int(),
  }),
  medications: z.object({
    /** AS-203. Active first, then with no days, then ended. */
    items: z.array(historyMedicationSchema),
    /** AS-207. Issued prescriptions in scope; at most 200 are read. */
    prescriptionTotal: z.number().int(),
  }),
  /** AS-207. Attentions in scope; at most 100 are on the timeline. */
  visits: z.object({ total: z.number().int() }),
  /** AS-205. Newest day first. */
  timeline: z.array(
    z.object({ date: clinicalDate, items: z.array(timelineItemSchema) }),
  ),
  /**
   * AS-200. Attentions exist at sites outside the caller's scope: whether,
   * never how many (EN-121, D-214 §5).
   */
  hasEntriesOutsideScope: z.boolean(),
});

/** Response of GET /patients/:patientId/clinical-history. */
export class ClinicalHistoryDto extends createZodDto(clinicalHistorySchema) {}
export type ClinicalHistoryResponse = z.infer<typeof clinicalHistorySchema>;
