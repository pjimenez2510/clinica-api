import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { explicitFlag } from '../../../shared/http/query-flag';

import { DATA_REQUEST_TEXT_MAX_LENGTH } from '../application/data-subject-requests.service';
import {
  DATA_REQUEST_PARTIES,
  DATA_REQUEST_RELATIONSHIPS,
} from '../domain/data-request-party';
import { DATA_SUBJECT_RIGHTS } from '../domain/legal-due-date';
import {
  AUTHORIZATION_CHANNELS,
  AUTHORIZATION_PURPOSES,
} from '../domain/patient-authorization';
import { DATA_REQUEST_OUTCOMES } from '../domain/privacy.repository';

// --- Requests -------------------------------------------------------------------

/**
 * PD-004. Only the type is checked here: the blank and the length are the
 * service's rule, with its own code, so the 422 says `PRIVACY_NOTICE_INVALID`
 * and not a generic validation error.
 */
export const publishPrivacyNoticeSchema = z.object({
  body: z.string({ error: 'Escriba el aviso de privacidad' }),
});
export class PublishPrivacyNoticeDto extends createZodDto(
  publishPrivacyNoticeSchema,
) {}

/**
 * PD-068, PD-069. The purpose and, for reminders and marketing, the channel.
 * No instant and no author: those are the server's. `strict` so a client
 * sending `recordedAt` is told, not silently ignored. Whether purpose and
 * channel go together is the domain's rule (PD-070), with its own code.
 */
export const grantAuthorizationSchema = z.strictObject({
  purpose: z.enum(AUTHORIZATION_PURPOSES, {
    error: 'Indique qué autoriza el paciente',
  }),
  channel: z
    .enum(AUTHORIZATION_CHANNELS, { error: 'Indique WhatsApp o correo' })
    .nullable()
    .default(null),
});
export class GrantAuthorizationDto extends createZodDto(
  grantAuthorizationSchema,
) {}

/**
 * PD-030, PD-031, PD-052, PD-053. Who presents it, their name and document,
 * and whether it asks for the copy of the clinical record, only typed here:
 * what the A.M. 5216 admits is the domain's rule (`presentationOf`), with its
 * own codes.
 */
export const registerDataRequestSchema = z.strictObject({
  right: z.enum(DATA_SUBJECT_RIGHTS, {
    error: 'Indique el derecho que ejerce',
  }),
  requestedBy: z.enum(DATA_REQUEST_PARTIES, {
    error: 'Indique quién presenta la solicitud',
  }),
  requesterName: z.string().nullable().optional(),
  requesterDocument: z.string().nullable().optional(),
  /** PD-063. The relative's relationship with the deceased patient. */
  requesterRelationship: z
    .enum(DATA_REQUEST_RELATIONSHIPS, { error: 'Elija el parentesco' })
    .nullable()
    .optional(),
  clinicalRecordCopy: z.boolean().optional(),
  documentsChecked: z.boolean().optional(),
  description: z
    .string({ error: 'Describa lo que pide el titular' })
    .trim()
    .min(1, 'Describa lo que pide el titular')
    .max(
      DATA_REQUEST_TEXT_MAX_LENGTH,
      `La descripción no puede superar ${DATA_REQUEST_TEXT_MAX_LENGTH} caracteres`,
    ),
  receivedAt: z.iso
    .datetime({ offset: true, error: 'Indique cuándo se recibió' })
    .optional(),
});
export class RegisterDataRequestDto extends createZodDto(
  registerDataRequestSchema,
) {}

/**
 * PD-046. What an unanswered request lets edit: the right, what it asks and
 * when it was received. Absent is «lo que ya había». Who presents it and who
 * registered it are not here: they do not change.
 */
export const editDataRequestSchema = z.strictObject({
  right: z
    .enum(DATA_SUBJECT_RIGHTS, { error: 'Indique el derecho que ejerce' })
    .optional(),
  description: z
    .string({ error: 'Describa lo que pide el titular' })
    .trim()
    .min(1, 'Describa lo que pide el titular')
    .max(
      DATA_REQUEST_TEXT_MAX_LENGTH,
      `La descripción no puede superar ${DATA_REQUEST_TEXT_MAX_LENGTH} caracteres`,
    )
    .optional(),
  receivedAt: z.iso
    .datetime({ offset: true, error: 'Indique cuándo se recibió' })
    .optional(),
});
export class EditDataRequestDto extends createZodDto(editDataRequestSchema) {}

const copyPeriodSchema = z.strictObject({
  from: z.iso.date({ error: 'Indique desde qué fecha' }),
  to: z.iso.date({ error: 'Indique hasta qué fecha' }),
});

/** PD-033. */
export const answerDataRequestSchema = z.strictObject({
  outcome: z.enum(DATA_REQUEST_OUTCOMES, {
    error: 'Indique si se atendió, se atendió en parte o se denegó',
  }),
  response: z
    .string({ error: 'Escriba la respuesta' })
    .trim()
    .min(1, 'Escriba la respuesta')
    .max(
      DATA_REQUEST_TEXT_MAX_LENGTH,
      `La respuesta no puede superar ${DATA_REQUEST_TEXT_MAX_LENGTH} caracteres`,
    ),
  /**
   * PD-059. The period a copy answered «Atendida en parte» hands over, as
   * clinical dates; whether it may come is the domain's rule (`copyPeriodOf`).
   */
  copyPeriod: copyPeriodSchema.nullable().optional(),
});
export class AnswerDataRequestDto extends createZodDto(
  answerDataRequestSchema,
) {}

/** PD-061. The professional's review: the casilla, and the screening. */
export const reviewCopySchema = z.strictObject({
  reviewed: z.boolean({ error: 'Marque que revisó la historia' }),
  includesScreening: z.boolean().default(false),
});
export class ReviewCopyDto extends createZodDto(reviewCopySchema) {}

// --- Responses ------------------------------------------------------------------

const staffNameSchema = z.object({ id: z.uuid(), fullName: z.string() });

export const privacyNoticeSchema = z.object({
  id: z.uuid(),
  version: z.int(),
  body: z.string(),
  publishedAt: z.iso.datetime(),
  publishedBy: staffNameSchema,
});
export class PrivacyNoticeDto extends createZodDto(privacyNoticeSchema) {}
export type PrivacyNoticeResponse = z.infer<typeof privacyNoticeSchema>;

/** PD-001. Newest first: the current one leads; empty until the first. */
export const privacyNoticeListSchema = z.object({
  items: z.array(privacyNoticeSchema).readonly(),
});
export class PrivacyNoticeListDto extends createZodDto(
  privacyNoticeListSchema,
) {}

/** PD-073. An optional authorization, with its revocation if it has one. */
export const patientAuthorizationSchema = z.object({
  id: z.uuid(),
  /** The chart it was written against: an absorbed one after a merge. */
  patientId: z.uuid(),
  purpose: z.enum(AUTHORIZATION_PURPOSES),
  channel: z.enum(AUTHORIZATION_CHANNELS).nullable(),
  recordedAt: z.iso.datetime(),
  recordedBy: staffNameSchema,
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: staffNameSchema.nullable(),
});
export class PatientAuthorizationDto extends createZodDto(
  patientAuthorizationSchema,
) {}
export type PatientAuthorizationResponse = z.infer<
  typeof patientAuthorizationSchema
>;

export const patientAuthorizationListSchema = z.object({
  items: z.array(patientAuthorizationSchema).readonly(),
});
export class PatientAuthorizationListDto extends createZodDto(
  patientAuthorizationListSchema,
) {}

const answerSchema = z.object({
  outcome: z.enum(DATA_REQUEST_OUTCOMES),
  response: z.string(),
  answeredAt: z.iso.datetime(),
  answeredBy: staffNameSchema,
  /** PD-047. Whether this answer rectifies an earlier one. */
  isCorrection: z.boolean(),
  /** PD-059. The period of a copy answered «Atendida en parte». */
  copyPeriod: z.object({ from: z.iso.date(), to: z.iso.date() }).nullable(),
});

const reviewSchema = z.object({
  reviewedAt: z.iso.datetime(),
  reviewedBy: staffNameSchema,
  /** D-203 §6. The violence screening goes in the copy. */
  includesScreening: z.boolean(),
});

export const dataRequestSchema = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  patient: z.object({ mrn: z.string(), fullName: z.string() }),
  right: z.enum(DATA_SUBJECT_RIGHTS),
  requestedBy: z.enum(DATA_REQUEST_PARTIES),
  /** PD-052. Who presents it, when it is not the holder. */
  requesterName: z.string().nullable(),
  requesterDocument: z.string().nullable(),
  /** PD-063. The relative's relationship with the deceased patient. */
  requesterRelationship: z.enum(DATA_REQUEST_RELATIONSHIPS).nullable(),
  /** PD-053. It asks for the copy of the clinical record. */
  clinicalRecordCopy: z.boolean(),
  documentsChecked: z.boolean(),
  /** PD-060. Whoever reads it may authorise it (the key of the record). */
  canAuthorise: z.boolean(),
  /** PD-062. Granting it waits for a professional's review. */
  reviewRequired: z.boolean(),
  /** PD-061. The professional's review, if it has one. */
  review: reviewSchema.nullable(),
  /** Null in the clinic-wide list of open requests (PD-035): see the route. */
  description: z.string().nullable(),
  receivedAt: z.iso.datetime(),
  /** PD-054. The instant it is due: 48 h for the copy, a day's end otherwise. */
  dueAt: z.iso.datetime(),
  /** PD-054. Clinical date of the last day on time, `YYYY-MM-DD`. */
  dueOn: z.iso.date(),
  isOverdue: z.boolean(),
  registeredAt: z.iso.datetime(),
  registeredBy: staffNameSchema,
  /** PD-047. The answer that stands: the last rectification, or the original. */
  answer: answerSchema.nullable(),
  /** PD-047. The answers a rectification replaced, newest first. */
  previousAnswers: z.array(answerSchema).readonly(),
  /** PD-046. Who last edited or answered it, and when. */
  changedBy: staffNameSchema.nullable(),
  changedAt: z.iso.datetime().nullable(),
});
export class DataRequestDto extends createZodDto(dataRequestSchema) {}
export type DataRequestResponse = z.infer<typeof dataRequestSchema>;

export const dataRequestListSchema = z.object({
  items: z.array(dataRequestSchema).readonly(),
});
export class DataRequestListDto extends createZodDto(dataRequestListSchema) {}

/** PD-051. Query of GET /privacy/requests. */
export const openRequestsQuerySchema = z.object({
  right: z.enum(DATA_SUBJECT_RIGHTS).optional(),
  /** Only those already overdue. */
  overdue: explicitFlag,
  page: z.coerce.number().int().min(1).default(1),
  /** ESTANDAR-UI §12.7: 20, 50 or 100. */
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export class OpenRequestsQueryDto extends createZodDto(
  openRequestsQuerySchema,
) {}

/** PD-035, PD-051. Response of GET /privacy/requests: one page and the total. */
export const openRequestsPageSchema = dataRequestListSchema.extend({
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export class OpenRequestsPageDto extends createZodDto(openRequestsPageSchema) {}

/** PD-049. The answer proposed for an access or portability request. */
export const answerProposalSchema = z.object({
  response: z.string().max(DATA_REQUEST_TEXT_MAX_LENGTH),
});
export class AnswerProposalDto extends createZodDto(answerProposalSchema) {}
export type AnswerProposalResponse = z.infer<typeof answerProposalSchema>;
