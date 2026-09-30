/**
 * PR-020 to PR-053. The prescription as art. 5 obliges it to be emitted.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DOCUMENT IS COMPOSED, NEVER STORED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every field here already exists somewhere: the name on the chart, the age
 * frozen on the attention, the diagnosis on `encounter_diagnosis`, the allergy
 * on `patient_allergy`, the city on the site's parish. Copying them onto the
 * prescription would create a second version of each fact that can contradict
 * the first — and the day they disagree, nobody can tell which one the pharmacy
 * was handed. What IS frozen is the medicine (`generic_name`, PR-008), because
 * the CNMB can be reloaded and the archived prescription still has to say what
 * was prescribed.
 *
 * PURE: a shape in, a shape out. The instant of issue and the time zone arrive
 * as parameters, which is the only way PR-050 can be exercised under two zones.
 */

import {
  MEDICATION_ROUTES,
  routeLabel,
  type DispensingContext,
} from './prescription';
import { prescriptionAgeOf, type PrescriptionAge } from './prescription-age';
import { spellQuantity } from './quantity-in-words';
import { validThrough, validityDaysFor } from './prescription-validity';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import type { MedicationRoute } from './prescription';
import type { PrescriptionDocumentSource } from './prescription.repository';

/** PR-028 to PR-031. One line of the printed prescription. */
export interface DocumentItem {
  line: number;
  /** PR-028. Art. 5.c.i — the DCI, «sin siglas ni abreviaturas». */
  genericName: string;
  /** PR-029. Art. 5.c.ii, iii. */
  presentation: string | null;
  concentration: string | null;
  /**
   * PR-029. Art. 5.c.iv, spelled out. «Vía oral» and never «VO»: art. 13
   * forbids abbreviations in an electronic prescription, and `null` when the
   * stored code is not one this system knows — a code it cannot name is a code
   * it must not print.
   */
  route: string | null;
  /** PR-030. Art. 5.c.v — the figure … */
  quantity: number | null;
  /** PR-030. … and the same figure in words, derived from it and never typed. */
  quantityInWords: string | null;
  /** PR-031. Art. 5.c.vi. */
  doseText: string;
  frequencyText: string;
  durationDays: number | null;
  /** PR-037. Art. 5.e.iii — the indications of this line. */
  instructions: string | null;
  /** PR-009. Written when the medicine is outside the CNMB. */
  offFormularyJustification: string | null;
}

/** PR-023, PR-050, PR-053. How long the pharmacy may dispense. */
export interface DocumentValidity {
  days: number;
  /** The LAST calendar day, in Ecuador. */
  through: ClinicalDate;
}

/** The prescription as art. 5 demands it. */
export interface PrescriptionDocument {
  id: string;
  /** PR-020. The pharmacy's check code. NOT the sequential number (⚠️ falta esquema). */
  verificationCode: string | null;
  status: string;
  /** PR-021. Art. 5.a.ii — the instant, which the client renders as DD/MM/AAAA. */
  issuedAt: Date | null;
  /** PR-021. Art. 5.a.ii — the canton of the site's parish. */
  city: string | null;
  /** PR-022. Art. 5.a.iii. */
  establishment: { name: string; mspUnicode: string };
  /** PR-023. `null` while the prescription is a draft: nothing is dispensable. */
  validity: DocumentValidity | null;
  patient: {
    /** PR-024. Art. 5.b.i — «Apellidos y nombres completos». In that order. */
    fullName: string;
    /** PR-025. Art. 5.b.ii — with months under five. `null` if never frozen. */
    age: PrescriptionAge | null;
  };
  /** PR-026. Art. 5.b.iii — the CIE of the attention, principal first. */
  diagnoses: readonly { code: string; display: string }[];
  /** PR-027. Art. 5.b.iv — «Antecedentes de alergias». */
  allergies: readonly string[];
  prescriber: {
    /** PR-033. Art. 5.d.i. */
    fullName: string;
    /** PR-034. Art. 5.d.ii — the ACESS registration, printed. */
    acessRegistration: string | null;
    /**
     * PR-035, PR-036. Art. 5.d.iii. There is no drawn signature and there
     * never will be: «no se aceptarán rúbricas o trazos por firma». What
     * stands for the signature of an electronic prescription is the
     * authenticated prescriber, and the instant it happened is this one.
     *
     * ⚠️ **Falta esquema** for the rest of PR-036: `prescription` carries no
     * signature mode, no certificate serial and no constancia of a signature
     * issued without one. Nothing is asserted here that is not stored — a
     * document claiming a certified signature nobody verified would be worse
     * than one that says only who and when.
     */
    signedAt: Date | null;
  };
  /** PR-028 to PR-031. The medicines, in the order they were written. */
  items: readonly DocumentItem[];
}

/**
 * A route code as stored, resolved to the sentence the document prints.
 *
 * `null` FOR A CODE THIS SYSTEM DOES NOT KNOW, and never the raw code: the
 * column is a bare `varchar(32)` with no catalogue behind it (⚠️ **Falta
 * esquema**, PR-029), so whatever an import wrote could be «VO» — the very
 * abbreviation art. 13 forbids. A field the document leaves blank is visible;
 * an abbreviation printed as if it were a route is not.
 */
function labelOf(routeCode: string | null): string | null {
  if (routeCode === null) return null;
  return Object.hasOwn(MEDICATION_ROUTES, routeCode)
    ? routeLabel(routeCode as MedicationRoute)
    : null;
}

/**
 * PR-020 to PR-053. The document, composed from what storage answered.
 *
 * ⚠️ THE VALIDITY IS `null` ON A DRAFT, and it is not laziness: a draft is not
 * dispensable at all, so printing «vigente hasta el 23» on one would be the
 * document asserting something false about a paper that is not a prescription
 * yet.
 *
 * ⚠️ AND `context` IS ALWAYS `AMBULATORY` TODAY (PR-051, supuesto 1). It is a
 * parameter rather than a constant because arts. 18 and 19 make the number
 * depend on it, and a constant would hide the rule the day an emergency exists.
 */
export function composeDocument(
  source: PrescriptionDocumentSource,
  options: {
    context: DispensingContext;
    antimicrobial?: boolean;
    timeZone?: string;
  },
): PrescriptionDocument {
  const { prescription, site, patient, prescriber } = source;

  const days = validityDaysFor(options.context, {
    antimicrobial: options.antimicrobial,
  });

  return {
    id: prescription.id,
    verificationCode: prescription.verificationCode,
    status: prescription.status,
    issuedAt: prescription.issuedAt,
    city: site.city,
    establishment: { name: site.name, mspUnicode: site.mspUnicode },
    validity:
      prescription.issuedAt === null
        ? null
        : {
            days,
            through: validThrough(
              prescription.issuedAt,
              days,
              options.timeZone,
            ),
          },
    patient: {
      // Art. 5.b.i names them in this order, and it is the order every
      // Ecuadorian official document uses. Reversing it is how a prescription
      // gets filed under the wrong letter.
      fullName: `${patient.familyName} ${patient.givenName}`,
      age: prescriptionAgeOf({
        years: patient.ageYears,
        months: patient.ageMonths,
        days: patient.ageDays,
      }),
    },
    diagnoses: source.diagnoses,
    allergies: source.allergies.map((allergy) => allergy.substanceText),
    prescriber: {
      fullName: `${prescriber.familyName} ${prescriber.givenName}`,
      acessRegistration: prescriber.acessRegistration,
      signedAt: prescription.issuedAt,
    },
    items: prescription.items.map((item) => ({
      line: item.line,
      genericName: item.genericName,
      presentation: item.presentation,
      concentration: item.concentration,
      route: labelOf(item.routeCode),
      quantity: item.quantity,
      quantityInWords:
        item.quantity === null ? null : spellQuantity(item.quantity),
      doseText: item.doseText,
      frequencyText: item.frequencyText,
      durationDays: item.durationDays,
      instructions: item.instructions,
      offFormularyJustification: item.offFormularyJustification,
    })),
  };
}
