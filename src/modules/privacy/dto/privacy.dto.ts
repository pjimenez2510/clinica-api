import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { DATA_REQUEST_TEXT_MAX_LENGTH } from '../application/data-subject-requests.service';
import { DATA_SUBJECT_RIGHTS } from '../domain/legal-due-date';
import {
  CONSENT_MEDIA,
  DATA_REQUEST_OUTCOMES,
  DATA_SUBJECT_PARTIES,
} from '../domain/privacy.repository';

// --- Requests -------------------------------------------------------------------

/**
 * PD-004. Only the type is checked here: the blank and the length are the
 * service's rule, with its own code, so the 422 says `CONSENT_TEXT_INVALID`
 * and not a generic validation error.
 */
export const publishConsentTextSchema = z.object({
  body: z.string({ error: 'Escriba el texto del consentimiento' }),
});
export class PublishConsentTextDto extends createZodDto(
  publishConsentTextSchema,
) {}

/**
 * PD-010, PD-011. No instant and no author: those are the server's. `strict`
 * so a client sending `recordedAt` is told, not silently ignored.
 */
export const recordConsentSchema = z.strictObject({
  textVersionId: z.uuid('Indique la versión del texto que se mostró'),
  medium: z.enum(CONSENT_MEDIA, {
    error: 'Indique si se firmó en papel o se aceptó en pantalla',
  }),
  grantedBy: z.enum(DATA_SUBJECT_PARTIES, {
    error: 'Indique si lo otorga el titular o su representante',
  }),
});
export class RecordConsentDto extends createZodDto(recordConsentSchema) {}

/**
 * PD-044. «Corregir»: what was recorded wrong, and nothing else. No reason
 * (D-126), no text version (it is the original's) and no instant or author
 * (the server's). Strict, so anything else sent is said.
 */
export const correctConsentSchema = z.strictObject({
  medium: z.enum(CONSENT_MEDIA, {
    error: 'Indique si se firmó en papel o se aceptó en pantalla',
  }),
  grantedBy: z.enum(DATA_SUBJECT_PARTIES, {
    error: 'Indique si lo otorga el titular o su representante',
  }),
});
export class CorrectConsentDto extends createZodDto(correctConsentSchema) {}

/** PD-030, PD-031. */
export const registerDataRequestSchema = z.strictObject({
  right: z.enum(DATA_SUBJECT_RIGHTS, {
    error: 'Indique el derecho que ejerce',
  }),
  requestedBy: z.enum(DATA_SUBJECT_PARTIES, {
    error: 'Indique si la presenta el titular o su representante',
  }),
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
});
export class AnswerDataRequestDto extends createZodDto(
  answerDataRequestSchema,
) {}

// --- Responses ------------------------------------------------------------------

const staffNameSchema = z.object({ id: z.uuid(), fullName: z.string() });

export const consentTextSchema = z.object({
  id: z.uuid(),
  version: z.int(),
  body: z.string(),
  publishedAt: z.iso.datetime(),
  publishedBy: staffNameSchema,
});
export class ConsentTextDto extends createZodDto(consentTextSchema) {}
export type ConsentTextResponse = z.infer<typeof consentTextSchema>;

/** PD-001. `current` is null until the clinic publishes its first text. */
export const currentConsentTextSchema = z.object({
  current: consentTextSchema.nullable(),
});
export class CurrentConsentTextDto extends createZodDto(
  currentConsentTextSchema,
) {}

export const consentTextListSchema = z.object({
  items: z.array(consentTextSchema).readonly(),
  /**
   * PD-045. Charts with a standing consent on the current version: the ones
   * publishing a new text leaves on an older one.
   */
  currentVersionConsents: z.int().nonnegative(),
});
export class ConsentTextListDto extends createZodDto(consentTextListSchema) {}

export const patientConsentSchema = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  textVersion: consentTextSchema,
  isCurrentVersion: z.boolean(),
  medium: z.enum(CONSENT_MEDIA),
  grantedBy: z.enum(DATA_SUBJECT_PARTIES),
  recordedAt: z.iso.datetime(),
  recordedBy: staffNameSchema,
  /** PD-044. The consent this one corrects, if it is a correction. */
  supersedesId: z.uuid().nullable(),
  /** PD-044. Another consent corrects this one: it no longer stands. */
  isSuperseded: z.boolean(),
  /**
   * PD-044. Who took it and when: the original's on a correction, whose
   * `recordedBy`/`recordedAt` say who corrected it and when.
   */
  takenAt: z.iso.datetime(),
  takenBy: staffNameSchema,
});
export class PatientConsentDto extends createZodDto(patientConsentSchema) {}
export type PatientConsentResponse = z.infer<typeof patientConsentSchema>;

export const patientConsentListSchema = z.object({
  items: z.array(patientConsentSchema).readonly(),
});
export class PatientConsentListDto extends createZodDto(
  patientConsentListSchema,
) {}

const answerSchema = z.object({
  outcome: z.enum(DATA_REQUEST_OUTCOMES),
  response: z.string(),
  answeredAt: z.iso.datetime(),
  answeredBy: staffNameSchema,
  /** PD-047. Whether this answer rectifies an earlier one. */
  isCorrection: z.boolean(),
});

export const dataRequestSchema = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  patient: z.object({ mrn: z.string(), fullName: z.string() }),
  right: z.enum(DATA_SUBJECT_RIGHTS),
  requestedBy: z.enum(DATA_SUBJECT_PARTIES),
  /** Null in the clinic-wide list of open requests (PD-035): see the route. */
  description: z.string().nullable(),
  receivedAt: z.iso.datetime(),
  /** Clinical date, `YYYY-MM-DD`. */
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

/** PD-049. The answer proposed for an access or portability request. */
export const answerProposalSchema = z.object({
  response: z.string().max(DATA_REQUEST_TEXT_MAX_LENGTH),
});
export class AnswerProposalDto extends createZodDto(answerProposalSchema) {}
export type AnswerProposalResponse = z.infer<typeof answerProposalSchema>;
