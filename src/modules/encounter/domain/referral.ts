import {
  FORM_007_SECTIONS,
  FORM_053_SECTIONS,
} from '../../../shared/clinical/act-forms';
import type { NoteContent } from './clinical-note';

/**
 * Referral, counter-referral, derivation and reverse referral, and the
 * interconsultation (encounter H8, EN-100 to EN-107).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE DATABASE GUARANTEES AND WHAT THIS FILE SAYS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `20261008210100_referral_interconsultation_h8` is the guarantee: where a
 * referral goes, what a counter-referral answers, one live answer at most, a
 * «referred» discharge with its referral, and nothing deleted or rewritten.
 * This file holds the vocabulary and the CONTENT OF THE FORM (053 or 007) the
 * issue writes as a signed note (EN-104): the words printed on the paper.
 *
 * Pure: no framework, no database.
 */

/** EN-100. Column 109 of the RDACAA: 1, 2, 3 and 4. */
export const REFERRAL_DIRECTIONS = [
  'REFERRAL',
  'COUNTER_REFERRAL',
  'DERIVATION',
  'REVERSE_REFERRAL',
] as const;
export type ReferralDirection = (typeof REFERRAL_DIRECTIONS)[number];

export type ReferralStatus =
  'ISSUED' | 'ACCEPTED' | 'REJECTED' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';

/** The urgency, the same three values as an order of exams. */
export const REFERRAL_PRIORITIES = ['ROUTINE', 'URGENT', 'STAT'] as const;
export type ReferralPriority = (typeof REFERRAL_PRIORITIES)[number];

/**
 * EN-105, D-191 §2. The directions that SEND the patient somewhere, and so
 * the ones a «referred» discharge needs: a counter-referral sends them back.
 */
export const OUTGOING_DIRECTIONS: readonly ReferralDirection[] = [
  'REFERRAL',
  'DERIVATION',
  'REVERSE_REFERRAL',
];

/**
 * EN-102, D-191 §5. What a counter-referral may answer: the norm defines it as
 * the return of the user «referido o derivado». `trg_referral_guard` says the
 * same.
 */
export const ANSWERABLE_DIRECTIONS: readonly ReferralDirection[] = [
  'REFERRAL',
  'DERIVATION',
];

/** EN-103. Column 111: 1 requested, 2 received. */
export const INTERCONSULTATION_ROLES = ['REQUESTED', 'RECEIVED'] as const;
export type InterconsultationRole = (typeof INTERCONSULTATION_ROLES)[number];

export type InterconsultationStatus = 'REQUESTED' | 'ANSWERED' | 'CANCELLED';

/** EN-021, EN-104. The forms these acts write, as `clinical_note.form_code`. */
export const REFERRAL_FORM_CODE = '053';
export const INTERCONSULTATION_FORM_CODE = '007';
export const ACT_FORM_VERSION = '1';

/** What the paper calls each direction. Spanish: a person reads it. */
export const DIRECTION_LABEL: Readonly<Record<ReferralDirection, string>> = {
  REFERRAL: 'Referencia',
  COUNTER_REFERRAL: 'Contrarreferencia',
  DERIVATION: 'Derivación',
  REVERSE_REFERRAL: 'Referencia inversa',
};

const PRIORITY_LABEL: Readonly<Record<ReferralPriority, string>> = {
  ROUTINE: 'Rutina',
  URGENT: 'Urgente',
  STAT: 'Inmediata',
};

/** A diagnosis of the attention, as it stood when the paper was issued. */
export interface DiagnosisAtIssue {
  code: string;
  display: string;
  principal: boolean;
}

/** What the doctor issues (EN-100, EN-101, EN-106). */
export interface ReferralDraft {
  direction: ReferralDirection;
  /** EN-101. `null` only in a counter-referral, which goes back. */
  destination: { mspUnicode: string; name: string } | null;
  specialtyId: string | null;
  priority: ReferralPriority;
  reason: string;
  summary: string | null;
  /** EN-102. The referral a counter-referral answers. */
  respondsToId: string | null;
}

/** What a 053 needs that is not in the draft, read under the lock. */
export interface ReferralFormContext {
  specialtyName: string | null;
  diagnoses: readonly DiagnosisAtIssue[];
  /** EN-102. The referral answered, as the paper names it. */
  answered: {
    issuedOn: string;
    destinationName: string | null;
    reason: string;
  } | null;
}

/**
 * EN-104. The sections of the 053, keyed as `clinical_note.content` stores
 * them. Every value is TEXT: what the note prints and what `hasClinicalAct`
 * reads as written. The keys are the form's own words, like the 002's.
 */
export const REFERRAL_FORM_SECTIONS = FORM_053_SECTIONS.map((each) => each.key); // prettier-ignore

export function referralFormContent(
  draft: ReferralDraft,
  context: ReferralFormContext,
): NoteContent {
  return withoutEmpty({
    tipo: DIRECTION_LABEL[draft.direction],
    establecimientoDestino: draft.destination
      ? `${draft.destination.name} (UNICÓDIGO ${draft.destination.mspUnicode})`
      : null,
    especialidad: context.specialtyName,
    prioridad: PRIORITY_LABEL[draft.priority],
    motivo: draft.reason,
    resumen: draft.summary,
    diagnosticos: diagnosesText(context.diagnoses),
    respondeA: context.answered
      ? [
          `Referencia del ${context.answered.issuedOn}`,
          context.answered.destinationName,
          context.answered.reason,
        ]
          .filter(Boolean)
          .join(' · ')
      : null,
  });
}

/** What the doctor records about an interconsultation (EN-103, EN-106). */
export type InterconsultationDraft =
  | {
      role: 'REQUESTED';
      specialtyId: string | null;
      reason: string;
      /** The clinical picture and the question asked. */
      findings: string | null;
    }
  | {
      role: 'RECEIVED';
      /** Who asked, as text: usually another service or establishment. */
      requestedByName: string;
      reason: string;
      findings: string | null;
      /** The answer written by whoever attends this attention. */
      opinion: string;
    };

/** EN-104. The sections of the 007, for a REQUESTED interconsultation. */
export const INTERCONSULTATION_FORM_SECTIONS = FORM_007_SECTIONS.map((each) => each.key); // prettier-ignore

export function interconsultationFormContent(
  draft: Extract<InterconsultationDraft, { role: 'REQUESTED' }>,
  context: Pick<ReferralFormContext, 'specialtyName' | 'diagnoses'>,
): NoteContent {
  return withoutEmpty({
    tipo: 'Interconsulta solicitada',
    especialidad: context.specialtyName,
    motivo: draft.reason,
    cuadroClinico: draft.findings,
    diagnosticos: diagnosesText(context.diagnoses),
  });
}

/** «J02.9 Faringitis aguda (principal); I10.X Hipertensión esencial». */
function diagnosesText(diagnoses: readonly DiagnosisAtIssue[]): string | null {
  if (diagnoses.length === 0) return null;
  return [...diagnoses]
    .sort((a, b) => Number(b.principal) - Number(a.principal))
    .map(
      (each) =>
        `${each.code} ${each.display}${each.principal ? ' (principal)' : ''}`,
    )
    .join('; ');
}

/** A section that says nothing is left out, not printed empty. */
function withoutEmpty(
  sections: Record<string, string | null | undefined>,
): NoteContent {
  return Object.fromEntries(
    Object.entries(sections).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].trim() !== '',
    ),
  );
}
