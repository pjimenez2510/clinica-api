import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { examAnalyteSchema } from './exam-catalogue.dto';

/**
 * The result's contract — the four columns of form 010B, and the two things
 * this API refuses to be told.
 */

const REPORT_STATUS = z.enum(['PARTIAL', 'FINAL', 'CORRECTED', 'CANCELLED']);
const ABNORMAL_FLAG = z.enum([
  'NORMAL',
  'LOW',
  'HIGH',
  'CRITICAL_LOW',
  'CRITICAL_HIGH',
]);

/**
 * An instant with its offset REQUIRED, the same rule as the agenda's: without
 * one, a time means whatever the reader's clock says.
 */
const instant = (label: string) =>
  z.iso.datetime({
    offset: true,
    error: `${label} debe incluir la fecha, la hora y su zona horaria`,
  });

/**
 * ORD-031 to ORD-038. One transcribed determination.
 *
 * ⚠️ THERE IS NO `unit` FIELD (ORD-034). The unit is a property of the analyte
 * and is copied from the catalogue: accepted from the transcriber, the same
 * haemoglobin arrives once in `g/dL` and once in `g/L`, and nothing downstream
 * can tell which.
 *
 * ⚠️ THERE IS NO `referenceLow`/`referenceHigh` EITHER (ORD-036, ORD-037). The
 * applicable range is resolved by SEX and AGE IN DAYS from the catalogue: a
 * range typed by hand is a range that contradicts the one the next report
 * used, on the same analyte, for the same patient.
 *
 * ⚠️ AND `abnormalFlag` IS ACCEPTED ONLY TO BE REFUSED (ORD-035). It is
 * declared so a client that sends it gets `RESULT_FLAG_IS_DERIVED` instead of
 * having it dropped in silence — which would leave whoever typed it believing
 * their mark is the one on the record, on the datum that decides whether
 * somebody phones the patient tonight.
 */
export const submittedResultSchema = z.object({
  analyteDefinitionId: z.uuid('Seleccione la determinación en el catálogo'),
  valueNumeric: z
    .number()
    .finite('El valor numérico no es un número válido')
    .optional(),
  valueCode: z
    .string()
    .trim()
    .max(64, 'El valor no puede superar 64 caracteres')
    .optional(),
  valueText: z
    .string()
    .trim()
    .max(4000, 'El texto del resultado no puede superar 4000 caracteres')
    .optional(),
  abnormalFlag: ABNORMAL_FLAG.optional(),
});

/**
 * ORD-030 to ORD-042. Registering what came back.
 *
 * ⚠️ THERE IS NO `status` FIELD (ORD-030, ORD-039). Whether the report is
 * `PARTIAL` or `FINAL` is DERIVED from whether every non-reflex determination
 * the order asked for has arrived. A status somebody selects is a status that
 * can contradict the rows beside it, and «FINAL» on a report missing three
 * determinations is exactly how a line leaves the worklist unseen.
 *
 * ⚠️ AND THERE IS NO `performedById` (ORD-070). It is a foreign key to OUR
 * practitioners, and the realistic case is an external laboratory (D-A-012).
 * Putting the transcriber there would claim a professional of this clinic
 * performed the analysis.
 */
export const registerReportSchema = z.object({
  /**
   * ORD-071. The conclusion the laboratory printed, if any.
   *
   * ⚠️ THE PDF IS A VIEW, NOT A SOURCE. IHE considers a report NON-CONFORMANT
   * when it carries an interpretation absent from the structured data, and the
   * rule is adopted here: whatever this text says, the values are what the
   * system compares, plots and alerts on.
   */
  conclusion: z
    .string()
    .trim()
    .max(4000, 'La conclusión no puede superar 4000 caracteres')
    .optional(),
  /** ORD-030. WHEN the laboratory issued it, which is not when it was typed. */
  /**
   * ORD-030. REQUIRED, and with no default anywhere: a «now» nobody touched is
   * the transcription time again, which is what the deadline of a critical
   * value must never run from (revisión clínica, G2).
   */
  issuedAt: instant('La fecha de emisión del informe'),
  results: z
    .array(submittedResultSchema)
    .min(1, 'Registre al menos una determinación')
    .max(200, 'Un informe no puede llevar más de 200 determinaciones'),
});
/** Body of POST /orders/:orderId/reports. */
export class RegisterReportDto extends createZodDto(registerReportSchema) {}

/**
 * ORD-050 to ORD-054. Correcting a report.
 *
 * THE SAME SHAPE AS REGISTERING, and it has to be: a correction that could
 * carry less than the original would produce a «current version» with holes in
 * it. What makes it a correction is the route and the report it names, never a
 * different payload.
 */
export const correctReportSchema = registerReportSchema;
export class CorrectReportDto extends createZodDto(correctReportSchema) {}

/** ORD-062. Who received the notice, and by what means. */
const NOTICE_RECIPIENT = z.enum([
  'ORDERING_PRACTITIONER',
  'OTHER_PRACTITIONER',
  'PATIENT',
  'REPRESENTATIVE',
]);
const NOTICE_CHANNEL = z.enum(['PHONE', 'IN_PERSON', 'VIDEO_CALL']);
/** ORD-067. `NO_ANSWER` is an attempt: recorded, and the value stays queued. */
const NOTICE_OUTCOME = z.enum(['NOTIFIED', 'NO_ANSWER']);

/**
 * ORD-062, ORD-120. One notice of a critical value, as it reads now. Edited in
 * place, never deleted; earlier versions at `…/versions`.
 */
export const criticalNoticeSchema = z.object({
  id: z.uuid(),
  resultId: z.string(),
  recipientKind: NOTICE_RECIPIENT,
  recipientName: z.string(),
  channel: NOTICE_CHANNEL,
  /** When the call happened, which may precede when it was written down. */
  notifiedAt: z.iso.datetime(),
  /** The session's account that gave it, with its name. */
  notifiedBy: z.object({ id: z.uuid(), name: z.string() }),
  note: z.string().nullable(),
  outcome: NOTICE_OUTCOME,
  /** ORD-066. `true` on a notice given, `null` on an unanswered call. */
  readBackConfirmed: z.boolean().nullable(),
  /** ORD-068. Given outside the site's hours. */
  afterHours: z.boolean(),
  /** ORD-062, ORD-147. A notice to oneself: recorded, does not close the worklist. */
  selfNotice: z.boolean(),
  /** ORD-146. The recipient carries the ordering practitioner's name. */
  namesOrderingPractitioner: z.boolean(),
  /** ORD-148. Who made the call, when it was not who recorded it (`notifiedBy`). */
  callerName: z.string().nullable(),
  /** ORD-175. The account that made the call, when it was chosen from the site. */
  callerId: z.uuid().nullable(),
  /** ORD-120. Who edited it last, and when; `null` if nobody did. */
  editedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  editedAt: z.iso.datetime().nullable(),
});
/** Response of POST and PUT /orders/results/:resultId/notices…. */
export class CriticalNoticeDto extends createZodDto(criticalNoticeSchema) {}

/**
 * ORD-120, D-127. The versions of a notice that edits replaced, newest first:
 * the notice exactly as it read, plus who replaced it and when. The database
 * kept them (`record_version`); the client only shows them.
 */
export const criticalNoticeVersionSchema = z.object({
  version: z.number().int().min(1),
  replacedBy: z.object({ id: z.uuid(), name: z.string() }),
  replacedAt: z.iso.datetime(),
  notice: criticalNoticeSchema,
});
export const criticalNoticeVersionListSchema = z.object({
  items: z.array(criticalNoticeVersionSchema),
});
/** Response of GET /orders/results/:resultId/notices/:noticeId/versions. */
export class CriticalNoticeVersionListDto extends createZodDto(
  criticalNoticeVersionListSchema,
) {}

/** ORD-175. The accounts of a result's site that can be named as the caller. */
export const noticeCallerListSchema = z.object({
  items: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
/** Response of GET /orders/results/:resultId/notice-callers. */
export class NoticeCallerListDto extends createZodDto(noticeCallerListSchema) {}
export type NoticeCallerListResponse = z.infer<typeof noticeCallerListSchema>;

/**
 * ORD-062. What recording a notice asks for.
 *
 * ⚠️ NO `notifiedById`: who gave it is the session, never the body.
 */
const noticeFields = z.object({
  /** ORD-067. Whether the person answered and was told. */
  outcome: NOTICE_OUTCOME,
  /**
   * ORD-066. The recipient repeated the value. Required — and `true` — on a
   * notice given; the domain answers `CRITICAL_READ_BACK_REQUIRED` naming it.
   */
  readBack: z
    .boolean({ error: 'Indique si la persona repitió el valor' })
    .optional(),
  recipientKind: NOTICE_RECIPIENT,
  recipientName: z
    .string()
    .trim()
    .min(1, 'Escriba a quién se avisó')
    .max(200, 'El nombre no puede superar 200 caracteres'),
  channel: NOTICE_CHANNEL,
  notifiedAt: instant('La hora del aviso').optional(),
  note: z
    .string()
    .trim()
    .max(500, 'La nota no puede superar 500 caracteres')
    .optional(),
  /**
   * ORD-148, D-116 e. Who made the call, when it was not the account that
   * records it. Absent or `null`: it was. A name, when given, is required.
   * On an edit the body is the whole notice (`PUT`): absent clears it.
   */
  callerName: z
    .string()
    .trim()
    .min(1, 'Escriba quién hizo la llamada')
    .max(200, 'El nombre no puede superar 200 caracteres')
    .nullable()
    .optional(),
  /**
   * ORD-175 (D-168 §4). The account of the site that made the call, chosen
   * from `GET /orders/results/:resultId/notice-callers`. When given, its name
   * is the caller's and `callerName` is ignored.
   */
  callerUserId: z.uuid('Elija una cuenta de la lista').nullable().optional(),
});

/** ORD-067. Nobody answered, so nobody repeated anything. */
function unansweredHasNoReadBack(
  value: { outcome: string; readBack?: boolean },
  context: z.RefinementCtx,
): void {
  if (value.outcome === 'NO_ANSWER' && value.readBack === true) {
    context.addIssue({
      code: 'custom',
      path: ['readBack'],
      message: 'Una llamada sin respuesta no lleva «repitió el valor»',
    });
  }
}

export const recordNoticeSchema = noticeFields.superRefine(
  unansweredHasNoReadBack,
);
export class RecordNoticeDto extends createZodDto(recordNoticeSchema) {}

/**
 * ORD-120. Editing a notice: the whole notice as it should read — the same
 * shape as recording it, plus the version it was made over. Without
 * `notifiedAt` the call keeps its instant. Who edits is the session, never the
 * body.
 */
export const editNoticeSchema = noticeFields
  .extend({
    /**
     * The version the edit was made over: the notice's `editedAt` as read, or
     * `null` if nobody had edited it. REQUIRED, so a client cannot overwrite
     * an edit it never saw (`CRITICAL_NOTICE_EDITED_CONCURRENTLY`).
     */
    expectedEditedAt: instant('La versión del aviso').nullable(),
  })
  .superRefine(unansweredHasNoReadBack);
export class EditNoticeDto extends createZodDto(editNoticeSchema) {}

/** ORD-143. One notice given of an earlier version, as the worklist shows it. */
const earlierNoticeSchema = z.object({
  recipientKind: NOTICE_RECIPIENT,
  /** `null` on the worklist for a patient or relative: no identity there. */
  recipientName: z.string().nullable(),
  notifiedAt: z.iso.datetime(),
  selfNotice: z.boolean(),
});

/** ORD-143. What a standing value corrects: the value somebody was told. */
const toldValueSchema = z.object({
  valueNumeric: z.number().nullable(),
  valueCode: z.string().nullable(),
  valueText: z.string().nullable(),
  unit: z.string().nullable(),
  abnormalFlag: ABNORMAL_FLAG.nullable(),
  observedAt: z.iso.datetime(),
});

/** ORD-171 (D-168 §2). The patient or their representative; a professional. */
const RECIPIENT_GROUP = z.enum(['PATIENT', 'PRACTITIONER']);

/**
 * ORD-172. Who the notice of the correction is proposed to. On the worklist
 * the name of a patient or relative is `null` (ORD-024): it is read in the
 * order, whose reading is audited.
 */
const proposedRecipientSchema = z.object({
  recipientKind: NOTICE_RECIPIENT,
  recipientName: z.string().nullable(),
});

/** ORD-143. A standing value that corrects one somebody was told about. */
export const notifiedCorrectionSchema = z.object({
  told: toldValueSchema,
  earlierNotices: z.array(earlierNoticeSchema),
  /** When the correction that retracted the told value was recorded. */
  correctedAt: z.iso.datetime(),
  /** No notice of the correction closes it yet (ORD-144). */
  due: z.boolean(),
  /** ORD-153. It has to reach the patient or their representative. */
  patientRequired: z.boolean(),
  /** ORD-171. The kinds of people told the false value still to be told. */
  missingRecipients: z.array(RECIPIENT_GROUP),
  /** ORD-172. Who to tell first: who heard the false value, patient first. */
  proposedRecipient: proposedRecipientSchema.nullable(),
});

/** ORD-031 to ORD-038. One determination as a client reads it. */
export const observationSchema = z.object({
  id: z.string(),
  /** ORD-040. `null` means nobody asked for it: it is in the unmatched list. */
  orderItemId: z.uuid().nullable(),
  /** `DETERMINACIÓN` — frozen at the moment it was registered. */
  analyteDisplay: z.string(),
  /** `RESULTADO`, in whichever of the three the analyte declares. */
  valueNumeric: z.number().nullable(),
  valueText: z.string().nullable(),
  valueCode: z.string().nullable(),
  /** `UNIDAD DE MEDIDA`. */
  unit: z.string().nullable(),
  /** `VALOR DE REFERENCIA`. */
  referenceLow: z.number().nullable(),
  referenceHigh: z.number().nullable(),
  referenceText: z.string().nullable(),
  /** ORD-122. The critical bounds this value was flagged with; `null` on a side without. */
  criticalLow: z.number().nullable(),
  criticalHigh: z.number().nullable(),
  /** ORD-038. `null` is «no había con qué compararlo», NEVER «normal». */
  abnormalFlag: ABNORMAL_FLAG.nullable(),
  observedAt: z.iso.datetime(),
  /** ORD-062. The notices given of this value, oldest first. */
  notices: z.array(criticalNoticeSchema),
  /** ORD-143. On a standing value correcting a notified one; `null` otherwise. */
  correction: notifiedCorrectionSchema.nullable(),
});

/** ORD-030, ORD-051. One report as a client reads it. */
export const diagnosticReportSchema = z.object({
  id: z.uuid(),
  serviceOrderId: z.uuid(),
  status: REPORT_STATUS,
  conclusion: z.string().nullable(),
  issuedAt: z.iso.datetime().nullable(),
  /** ORD-050. The report this one corrects. */
  supersedesId: z.uuid().nullable(),
  /**
   * ORD-051. The correction that replaced THIS one, and when.
   *
   * It is what lets a screen print «corregido el …» beside a number somebody
   * may already have acted on, instead of quietly showing the new one.
   */
  supersededById: z.uuid().nullable(),
  supersededAt: z.iso.datetime().nullable(),
  /** ORD-062. When the correction was recorded: notices after it are refused. */
  supersededRecordedAt: z.iso.datetime().nullable(),
  results: z.array(observationSchema),
});
/** Response of registering, correcting and matching: the report as it stands afterwards. */
export class DiagnosticReportDto extends createZodDto(diagnosticReportSchema) {}

export const diagnosticReportListSchema = z.object({
  items: z.array(diagnosticReportSchema),
  /** ORD-177. The order's site asks for the read-back on a notice given. */
  readBackRequired: z.boolean(),
});
/** Response of GET /orders/:orderId/reports. */
export class DiagnosticReportListDto extends createZodDto(
  diagnosticReportListSchema,
) {}

/** ORD-040, ORD-060. One entry of a safety worklist. */
export const flaggedResultSchema = z.object({
  resultId: z.string(),
  reportId: z.uuid(),
  orderId: z.uuid(),
  siteId: z.uuid(),
  patientId: z.uuid(),
  analyteDisplay: z.string(),
  valueNumeric: z.number().nullable(),
  valueCode: z.string().nullable(),
  unit: z.string().nullable(),
  /** ORD-122. The critical bounds this value was flagged with. */
  criticalLow: z.number().nullable(),
  criticalHigh: z.number().nullable(),
  abnormalFlag: ABNORMAL_FLAG.nullable(),
  observedAt: z.iso.datetime(),
});

/** ORD-060, ORD-065. A critical value waiting for its notice. */
export const criticalResultSchema = flaggedResultSchema.extend({
  waitingMinutes: z.number().int(),
  noticeDueAt: z.iso.datetime(),
  overdue: z.boolean(),
  escalateTo: z.object({ roleId: z.uuid(), name: z.string() }).nullable(),
  /** ORD-065. The chain's first critical version, which the deadline runs from. */
  firstObservedAt: z.iso.datetime(),
  /** ORD-065. Who placed the order: the first to tell, by name. */
  orderedBy: z.object({ id: z.uuid(), name: z.string() }),
  /** ORD-067. Unanswered calls along the chain; the value is still waiting. */
  noAnswerAttempts: z.number().int(),
  /** ORD-065, D-116 b. An earlier version of the chain was already notified. */
  previouslyNotified: z.boolean(),
  /** ORD-146. The practitioner who placed the order already noted it. */
  selfNoticed: z.boolean(),
  /** ORD-068. The site is out of hours now. */
  afterHours: z.boolean(),
  /** ORD-065, ORD-068. Whom the notice is due to now (D-111 §2, §3). */
  noticeTarget: z.enum(['ORDERING_PRACTITIONER', 'ON_CALL_ROLE', 'PATIENT']),
  /** ORD-065. The escalation is due and the site named no on-call role. */
  escalationMissing: z.boolean(),
  /** ORD-167. The notice is due to the account reading the worklist. */
  dueToRequester: z.boolean(),
  /** ORD-177. The site asks for the read-back on a notice given. */
  readBackRequired: z.boolean(),
});
export const criticalResultListSchema = z.object({
  items: z.array(criticalResultSchema),
});
/** Response of GET /orders/results/critical. */
export class CriticalResultListDto extends createZodDto(
  criticalResultListSchema,
) {}

/** ORD-040, ORD-046. A result nobody asked for, with who answers for it. */
export const unmatchedResultSchema = flaggedResultSchema.extend({
  owner: z.object({
    /** `ORDERING_PRACTITIONER` unless the site names a role (D-050 §4). */
    kind: z.enum(['ORDERING_PRACTITIONER', 'ROLE']),
    name: z.string(),
  }),
  dueAt: z.iso.datetime(),
  overdue: z.boolean(),
});
export const unmatchedResultListSchema = z.object({
  items: z.array(unmatchedResultSchema),
});
/** Response of GET /orders/results/unmatched. */
export class UnmatchedResultListDto extends createZodDto(
  unmatchedResultListSchema,
) {}

/** ORD-143. A correction of a notified value waiting for its notice. */
export const correctionResultSchema = z.object({
  resultId: z.string(),
  reportId: z.uuid(),
  orderId: z.uuid(),
  siteId: z.uuid(),
  patientId: z.uuid(),
  analyteDisplay: z.string(),
  valueNumeric: z.number().nullable(),
  valueCode: z.string().nullable(),
  valueText: z.string().nullable(),
  unit: z.string().nullable(),
  abnormalFlag: ABNORMAL_FLAG.nullable(),
  told: toldValueSchema,
  earlierNotices: z.array(earlierNoticeSchema),
  correctedAt: z.iso.datetime(),
  orderedBy: z.object({ id: z.uuid(), name: z.string() }),
  /** ORD-153. An earlier version was told to the patient or their representative. */
  patientRequired: z.boolean(),
  /** ORD-171. The kinds of people told the false value still to be told. */
  missingRecipients: z.array(RECIPIENT_GROUP),
  /** ORD-172. Who to tell first; a patient's or relative's name stays in the order. */
  proposedRecipient: proposedRecipientSchema.nullable(),
  /** ORD-154. Unanswered calls about the corrected value. */
  noAnswerAttempts: z.number().int(),
  /** ORD-173. The site's on-call has to locate the patient; it closes nothing. */
  locateViaOnCall: z.boolean(),
  /** ORD-177. The site asks for the read-back on a notice given. */
  readBackRequired: z.boolean(),
  /** ORD-154 (D-156.2). The site's critical deadline, from `correctedAt`. */
  waitingMinutes: z.number().int(),
  noticeDueAt: z.iso.datetime(),
  overdue: z.boolean(),
  escalateTo: z.object({ roleId: z.uuid(), name: z.string() }).nullable(),
  /** ORD-068. The site is out of hours now. */
  afterHours: z.boolean(),
  /** ORD-153, ORD-154. Whom the notice of the correction is due to now. */
  noticeTarget: z.enum(['ORDERING_PRACTITIONER', 'ON_CALL_ROLE', 'PATIENT']),
  /**
   * ORD-154, ORD-173. The escalation —or locating the patient— is due and the
   * site has nobody on call.
   */
  escalationMissing: z.boolean(),
});
export const correctionResultListSchema = z.object({
  items: z.array(correctionResultSchema),
});
/** Response of GET /orders/results/corrections. */
export class CorrectionResultListDto extends createZodDto(
  correctionResultListSchema,
) {}

/**
 * ORD-149. The determinations a correction of a report admits, with the exam
 * each is of (`null`: the order's exams no longer name it).
 */
export const correctionAnalyteListSchema = z.object({
  items: z.array(examAnalyteSchema.extend({ examName: z.string().nullable() })),
});
/** Response of GET /orders/reports/:reportId/analytes. */
export class CorrectionAnalyteListDto extends createZodDto(
  correctionAnalyteListSchema,
) {}

/**
 * ORD-043. Pairing an orphan result with a line of its own order.
 *
 * ⚠️ THERE IS NO `orderId` FIELD, AND THE ABSENCE IS THE REQUIREMENT. The order
 * is the one the result's report already belongs to, read from the row — the
 * same rule that keeps `orderedById` out of the order (ORD-001). An order id in
 * the request is a result somebody can file against another person's order, and
 * it would be accepted by a schema that could not possibly tell.
 *
 * ⚠️ AND THERE IS NO «DESCARTAR» FIELD (⚠️ **Falta esquema**, ORD-041, ORD-043).
 * `observation_result` has no column saying that a person looked at this value
 * and it belongs to nobody here, nor who decided it. A flag with nowhere to
 * record the author and the motive would empty the queue while destroying the
 * only evidence that it was ever worked.
 */
export const matchResultSchema = z.object({
  orderItemId: z.uuid('Elija la línea de la orden que este resultado responde'),
});
/** Body of POST /orders/results/:resultId/match. */
export class MatchResultDto extends createZodDto(matchResultSchema) {}

/** ORD-040, ORD-060. How much of a safety worklist to bring back. */
export const worklistQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200, 'No se pueden listar más de 200 resultados de una vez')
    .default(100),
});
/** Query of both safety worklists. */
export class WorklistQueryDto extends createZodDto(worklistQuerySchema) {}

/** Response types the controller returns, inferred from the schemas Swagger publishes. */
export type DiagnosticReportResponse = z.infer<typeof diagnosticReportSchema>;
export type DiagnosticReportListResponse = z.infer<
  typeof diagnosticReportListSchema
>;
/** Likewise, for both safety worklists. */
export type CriticalResultListResponse = z.infer<typeof criticalResultListSchema>; // prettier-ignore
export type UnmatchedResultListResponse = z.infer<typeof unmatchedResultListSchema>; // prettier-ignore
export type CriticalNoticeResponse = z.infer<typeof criticalNoticeSchema>;
export type CorrectionResultListResponse = z.infer<typeof correctionResultListSchema>; // prettier-ignore
export type CorrectionAnalyteListResponse = z.infer<typeof correctionAnalyteListSchema>; // prettier-ignore
export type CriticalNoticeVersionListResponse = z.infer<
  typeof criticalNoticeVersionListSchema
>;
