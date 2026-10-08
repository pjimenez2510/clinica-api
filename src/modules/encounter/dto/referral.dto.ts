import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  INTERCONSULTATION_ROLES,
  REFERRAL_DIRECTIONS,
  REFERRAL_PRIORITIES,
} from '../domain/referral';

/**
 * encounter H8 (EN-100 to EN-107).
 *
 * The cross-field rules repeat, per field and earlier, the CHECKs and the
 * guard of `20261008230100_referral_interconsultation_h8`, which remain the
 * guarantee.
 */
const text = (max: number, message: string) =>
  z
    .string({ error: message })
    .trim()
    .min(1, message)
    .max(max, `Tiene ${max} caracteres como mucho`);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Tiene ${max} caracteres como mucho`)
    .nullish()
    .transform((value) => (value ? value : null));

export const issueReferralSchema = z
  .object({
    /** EN-100. Column 109. */
    direction: z.enum(REFERRAL_DIRECTIONS, {
      error: 'Elija referencia, contrarreferencia, derivación o referencia inversa', // prettier-ignore
    }),
    /** EN-101. Required but in a counter-referral, which goes back. */
    destination: z
      .object({
        mspUnicode: z
          .string({ error: 'Indique el UNICÓDIGO del establecimiento' })
          .trim()
          .regex(/^[0-9]{1,20}$/, 'El UNICÓDIGO del establecimiento lleva sólo números'), // prettier-ignore
        name: text(240, 'Indique el nombre del establecimiento'),
      })
      .strict()
      .nullish(),
    specialtyId: z.uuid({ error: 'Especialidad no válida' }).nullish(),
    priority: z.enum(REFERRAL_PRIORITIES).default('ROUTINE'),
    /** EN-106. */
    reason: text(2000, 'Escriba el motivo'),
    summary: optionalText(4000),
    /** EN-102. The referral a counter-referral answers. */
    respondsToId: z.uuid({ error: 'Referencia no válida' }).nullish(),
  })
  .strict()
  .superRefine((body, context) => {
    const counter = body.direction === 'COUNTER_REFERRAL';
    if (counter && !body.respondsToId) {
      context.addIssue({ code: 'custom', path: ['respondsToId'], message: 'Elija la referencia que esta contrarreferencia responde' }); // prettier-ignore
    }
    if (!counter && body.respondsToId) {
      context.addIssue({ code: 'custom', path: ['respondsToId'], message: 'Sólo una contrarreferencia responde a otra referencia' }); // prettier-ignore
    }
    if (!counter && !body.destination) {
      context.addIssue({ code: 'custom', path: ['destination'], message: 'Indique el UNICÓDIGO y el nombre del establecimiento de destino' }); // prettier-ignore
    }
  });
export class IssueReferralDto extends createZodDto(issueReferralSchema) {}

export const issueInterconsultationSchema = z
  .object({
    /** EN-103. Column 111. */
    role: z.enum(INTERCONSULTATION_ROLES, {
      error: 'Indique si la interconsulta se solicitó o se recibió',
    }),
    /** REQUESTED: the specialty asked. */
    specialtyId: z.uuid({ error: 'Especialidad no válida' }).nullish(),
    /** RECEIVED: who asked, as text. */
    requestedByName: optionalText(240),
    /** EN-106. */
    reason: text(2000, 'Escriba el motivo'),
    /** The clinical picture and the question; or what was found. */
    findings: optionalText(4000),
    /** RECEIVED: the answer written. */
    opinion: optionalText(4000),
  })
  .strict()
  .superRefine((body, context) => {
    if (body.role === 'RECEIVED') {
      if (!body.requestedByName) {
        context.addIssue({ code: 'custom', path: ['requestedByName'], message: 'Indique quién pidió la interconsulta' }); // prettier-ignore
      }
      if (!body.opinion) {
        context.addIssue({ code: 'custom', path: ['opinion'], message: 'Escriba la respuesta a la interconsulta' }); // prettier-ignore
      }
      if (body.specialtyId) {
        context.addIssue({ code: 'custom', path: ['specialtyId'], message: 'La especialidad se indica al solicitarla' }); // prettier-ignore
      }
      return;
    }
    if (body.requestedByName) {
      context.addIssue({ code: 'custom', path: ['requestedByName'], message: 'Quien solicita es usted: no se escribe' }); // prettier-ignore
    }
    if (body.opinion) {
      context.addIssue({ code: 'custom', path: ['opinion'], message: 'La respuesta la escribe quien recibe la interconsulta' }); // prettier-ignore
    }
  });
export class IssueInterconsultationDto extends createZodDto(
  issueInterconsultationSchema,
) {}

/** EN-107. Annulling says why: free text, never a dropdown. */
export const cancelActSchema = z
  .object({ reason: text(500, 'Escriba el motivo de la anulación') })
  .strict();
export class CancelActDto extends createZodDto(cancelActSchema) {}

const cancellationSchema = z
  .object({ at: z.iso.datetime(), byName: z.string(), reason: z.string() })
  .nullable();

export const referralSchema = z.object({
  id: z.uuid(),
  encounterId: z.uuid(),
  direction: z.enum(REFERRAL_DIRECTIONS),
  status: z.enum([
    'ISSUED',
    'ACCEPTED',
    'REJECTED',
    'COMPLETED',
    'EXPIRED',
    'CANCELLED',
  ]),
  destination: z
    .object({ mspUnicode: z.string(), name: z.string() })
    .nullable(),
  specialty: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  priority: z.enum(REFERRAL_PRIORITIES),
  reason: z.string(),
  summary: z.string().nullable(),
  respondsToId: z.uuid().nullable(),
  /** EN-102. The live counter-referral that answers it, if any. */
  answeredById: z.uuid().nullable(),
  /** EN-104, EN-243. Its 053: `/documents/clinical-forms/:noteId`. */
  clinicalNoteId: z.uuid().nullable(),
  issuedByName: z.string(),
  issuedAt: z.iso.datetime(),
  cancellation: cancellationSchema,
});
export class ReferralDto extends createZodDto(referralSchema) {}
export type ReferralResponse = z.infer<typeof referralSchema>;

export const interconsultationSchema = z.object({
  id: z.uuid(),
  encounterId: z.uuid(),
  role: z.enum(INTERCONSULTATION_ROLES),
  status: z.enum(['REQUESTED', 'ANSWERED', 'CANCELLED']),
  specialty: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  requestedByName: z.string().nullable(),
  reason: z.string(),
  findings: z.string().nullable(),
  opinion: z.string().nullable(),
  respondedByName: z.string().nullable(),
  /** EN-104, EN-243. Its 007, for a REQUESTED one. */
  clinicalNoteId: z.uuid().nullable(),
  requestedAt: z.iso.datetime(),
  cancellation: cancellationSchema,
});
export class InterconsultationDto extends createZodDto(
  interconsultationSchema,
) {}
export type InterconsultationResponse = z.infer<typeof interconsultationSchema>;

export const referralSheetSchema = z.object({
  referrals: z.array(referralSchema),
  interconsultations: z.array(interconsultationSchema),
  /** EN-102. The patient's referrals a counter-referral may still answer. */
  answerable: z.array(
    z.object({
      id: z.uuid(),
      direction: z.enum(REFERRAL_DIRECTIONS),
      destinationName: z.string().nullable(),
      reason: z.string(),
      issuedAt: z.iso.datetime(),
    }),
  ),
  /** REQ-149. The clinic's active specialties, to name the destination's. */
  specialties: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export class ReferralSheetDto extends createZodDto(referralSheetSchema) {}
export type ReferralSheetResponse = z.infer<typeof referralSheetSchema>;
