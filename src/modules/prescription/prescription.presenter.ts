import type { PrescriptionDocument } from './domain/prescription-document';
import type { PrescriptionView } from './domain/prescription.repository';
import type {
  PrescriptionDocumentResponse,
  PrescriptionResponse,
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
      signedAt: document.prescriber.signedAt?.toISOString() ?? null,
    },
    items: [...document.items],
  };
}
