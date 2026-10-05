import type { PrescriptionDocument } from './domain/prescription-document';
import type { PrescriptionView } from './domain/prescription.repository';
import { MEDICATION_ROUTES } from './domain/prescription';
import {
  DOSAGE_FORMS,
  DOSE_UNITS,
  FREQUENCIES,
  type DeclaredPresentation,
  type DosageForm,
  type DoseUnit,
  type Frequency,
} from './domain/prescription-vocabulary';
import type { WrittenItem } from './domain/written-item';
import type {
  ComposePrescriptionDto,
  PrescriptionDocumentResponse,
  PrescriptionResponse,
  PrescriptionVocabularyResponse,
} from './dto/prescription.dto';

/**
 * Domain shapes out, JSON in. Shared by the two controllers of this module.
 *
 * A FILE OF ITS OWN AND NOT A PRIVATE METHOD, because both controllers serve
 * the same prescription: duplicating the mapping is how the two ends up
 * disagreeing about whether `issuedAt` is an instant or a date. Instants leave
 * as ISO 8601 and the client renders them in Ecuadorian time; the VALIDITY does
 * not, because it is a calendar date and never an instant (PR-050).
 */

/**
 * The prescription as the API serves it, field by field. Instants leave as ISO
 * strings.
 */
export function toPrescriptionResponse(
  prescription: PrescriptionView,
): PrescriptionResponse {
  return {
    id: prescription.id,
    encounterId: prescription.encounterId,
    prescriberId: prescription.prescriberId,
    status: prescription.status,
    issuedAt: prescription.issuedAt?.toISOString() ?? null,
    verificationCode: prescription.verificationCode,
    sequenceNumber: prescription.sequenceNumber,
    warningSigns: prescription.warningSigns,
    nonPharmacologicalAdvice: prescription.nonPharmacologicalAdvice,
    createdAt: prescription.createdAt.toISOString(),
    // PR-011. `null` on every state but `DISCARDED`, which the database keeps
    // true: `prescription_discard_only_from_draft` ties the instant to the
    // state, and the reason to both.
    discardedAt: prescription.discardedAt?.toISOString() ?? null,
    discardReason: prescription.discardReason,
    items: prescription.items.map((item) => ({
      id: item.id,
      line: item.line,
      conceptId: item.conceptId,
      genericName: item.genericName,
      presentation: item.presentation,
      concentration: item.concentration,
      routeCode: item.routeCode,
      quantity: item.quantity,
      doseText: item.doseText,
      frequencyText: item.frequencyText,
      durationDays: item.durationDays,
      instructions: item.instructions,
      offFormularyJustification: item.offFormularyJustification,
      dosageFormCode: item.dosageFormCode,
      doseAmount: item.doseAmount,
      doseUnitCode: item.doseUnitCode,
      frequencyCode: item.frequencyCode,
    })),
  };
}

/** PR-020 to PR-053. The prescription as art. 5 obliges it to be emitted. */
export function toDocumentResponse(
  document: PrescriptionDocument,
): PrescriptionDocumentResponse {
  return {
    id: document.id,
    verificationCode: document.verificationCode,
    sequenceNumber: document.sequenceNumber,
    warningSigns: document.warningSigns,
    nonPharmacologicalAdvice: document.nonPharmacologicalAdvice,
    status: document.status as PrescriptionResponse['status'],
    issuedAt: document.issuedAt?.toISOString() ?? null,
    city: document.city,
    establishment: document.establishment,
    /**
     * PR-050, PR-053. `through` is a CALENDAR DATE in Ecuador and leaves as
     * `YYYY-MM-DD`, never as an instant: an ISO timestamp would be rendered by
     * the browser in its own zone, and «vigente hasta el 23» would read as «el
     * 22» to anybody east of Guayaquil.
     */
    validity: document.validity,
    patient: document.patient,
    diagnoses: [...document.diagnoses],
    allergies: [...document.allergies],
    prescriber: {
      fullName: document.prescriber.fullName,
      acessRegistration: document.prescriber.acessRegistration,
      contactPhone: document.prescriber.contactPhone,
      signedAt: document.prescriber.signedAt?.toISOString() ?? null,
    },
    items: [...document.items],
  };
}

/**
 * PR-100 to PR-102. A line of the request, as the domain writes it: codes in,
 * sentences composed by `writeItem`. Shared by composing and rewriting, so the
 * two routes cannot read the same body differently.
 */
export function toWrittenItem(
  item: ComposePrescriptionDto['items'][number],
): WrittenItem {
  return {
    conceptId: item.conceptId ?? null,
    // PR-008. Only read when there is no concept: with one, the DCI comes from
    // the CNMB row the adapter reads in the write's transaction.
    genericName: item.genericName ?? null,
    dosageForm: item.dosageForm as DosageForm,
    concentration: item.concentration,
    routeCode: item.routeCode,
    quantity: item.quantity,
    doseAmount: item.doseAmount,
    doseUnit: item.doseUnit as DoseUnit,
    frequency: (item.frequency ?? null) as Frequency | null,
    frequencyText: item.frequencyText ?? null,
    durationDays: item.durationDays ?? null,
    instructions: item.instructions ?? null,
    offFormularyJustification: item.offFormularyJustification ?? null,
  };
}

/** PR-103. The vocabulary as the screen reads it, in the domain's order. */
export function toVocabularyResponse(
  presentations: readonly DeclaredPresentation[],
): PrescriptionVocabularyResponse {
  return {
    presentations: presentations.map((presentation) => ({
      form: presentation.form,
      concentration: presentation.concentration,
    })),
    dosageForms: Object.entries(DOSAGE_FORMS).map(([code, form]) => ({
      code,
      label: form.label,
      doseUnit: form.unit,
    })),
    doseUnits: Object.entries(DOSE_UNITS).map(([code, unit]) => ({
      code,
      one: unit.one,
      many: unit.many,
    })),
    routes: Object.entries(MEDICATION_ROUTES).map(([code, label]) => ({
      code,
      label,
    })),
    frequencies: Object.entries(FREQUENCIES).map(([code, label]) => ({
      code,
      label,
    })),
  };
}
