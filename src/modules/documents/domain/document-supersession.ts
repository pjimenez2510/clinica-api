import type { DocumentSubject } from './document-source';

/**
 * DOC-108, DOC-109. Why a PDF replaces the archived one, when nobody wrote it:
 * `AUTOMATIC` reads the cause from what the document represents, and
 * `CORRECTION` is the annulment of «Corregir» (PR-109, ORD-118, CER-053).
 */
export type SupersedeCause = 'AUTOMATIC' | 'CORRECTION';

/** DOC-108. When the subject shows no known cause. */
export const NEW_VERSION_REASON = 'Nueva versión del documento';

/**
 * DOC-108, DOC-109. The reason the system writes on a corrected PDF. It names
 * the cause and the document's own number, never a patient datum: the reason
 * is listed beside the file in the chart.
 */
export function supersedeReasonOf(
  subject: DocumentSubject,
  cause: SupersedeCause,
): string {
  if (cause === 'CORRECTION') {
    const corrected = correctionOf(subject);
    if (corrected !== null) return corrected;
  }
  switch (subject.kind) {
    case 'PRESCRIPTION':
      return subject.data.status === 'CANCELLED'
        ? 'Receta anulada'
        : NEW_VERSION_REASON;
    case 'SERVICE_ORDER':
      return subject.data.items.some((item) => item.status === 'CANCELLED')
        ? 'Examen anulado'
        : NEW_VERSION_REASON;
    case 'MEDICAL_CERTIFICATE':
      return subject.data.form.revocation !== null
        ? 'Certificado anulado'
        : NEW_VERSION_REASON;
    case 'INVOICE_RIDE':
    case 'CREDIT_NOTE_RIDE':
    case 'ENCOUNTER_SUMMARY':
    case 'CLINICAL_FORM':
      return NEW_VERSION_REASON;
  }
}

/** DOC-109. «Corrección de la receta N.º 12»; `null` without a number. */
function correctionOf(subject: DocumentSubject): string | null {
  switch (subject.kind) {
    case 'PRESCRIPTION':
      return subject.data.sequenceNumber === null
        ? null
        : `Corrección de la receta N.º ${subject.data.sequenceNumber}`;
    case 'SERVICE_ORDER':
      return `Corrección de la orden N.º ${subject.data.number}`;
    case 'MEDICAL_CERTIFICATE':
      return `Corrección del certificado N.º ${subject.data.form.number}`;
    case 'INVOICE_RIDE':
    case 'CREDIT_NOTE_RIDE':
    case 'ENCOUNTER_SUMMARY':
    case 'CLINICAL_FORM':
      return null;
  }
}
