/**
 * The closed vocabularies of a prescription, in a file with NO imports.
 *
 * Upstream of everything else in this module, for the same reason
 * `encounter/domain/encounter.ts` is: the errors need the status union to label
 * states in Spanish, the port needs it to describe a row, and the content rules
 * need the route list to refuse an abbreviation. A vocabulary that lived in the
 * port would make «error → port → policy → error» a cycle.
 *
 * `PrescriptionStatus` is cited LITERALLY from the `prescription_status` enum
 * created by `20260806022931_clinical_core`. This module does not invent a
 * state.
 */

/**
 * PR-003, PR-005. The life of one prescription.
 *
 * ⚠️ `DRAFT` IS NOT A LEGAL DOCUMENT AND `ACTIVE` IS. The whole of art. 5 of the
 * Resolución ACESS-2023-0030 is demanded at the transition between the two
 * (PR-032), and `prescription_issued_coherence` keeps the pair honest in the
 * database: `(status IN ('DRAFT','DISCARDED')) = (issued_at IS NULL)`.
 */
export type PrescriptionStatus =
  /** Being written. Nothing has been issued and nothing is owed to anybody. */
  | 'DRAFT'
  /**
   * A draft typed by mistake, closed before it ever left the room.
   *
   * ⚠️ IT EXISTS BECAUSE `CANCELLED` COULD NOT SERVE. `prescription_issued_
   * coherence` demanded an issue instant for every status but `DRAFT`, so a
   * wrong draft could be neither issued, nor cancelled, nor deleted — it
   * stayed in the chart forever and the next doctor had no way to tell it from
   * something the patient is actually taking.
   *
   * And the two acts are genuinely different: cancelling an ISSUED
   * prescription has weight — the paper is in someone's hand and a pharmacy may
   * have dispensed against it — while discarding a draft is housekeeping.
   * Sharing one status would leave «esta receta se anuló» unable to say which
   * of the two happened, the same defect `ENTERED_IN_ERROR` avoids in the
   * agenda.
   *
   * `prescription_discard_states_who_when_and_why` demands the three together,
   * and `prescription_discard_only_from_draft` keeps it out of the issued path.
   */
  | 'DISCARDED'
  /** Issued and dispensable while its validity lasts (PR-050). */
  | 'ACTIVE'
  /**
   * Dispensed in full.
   *
   * ⚠️ NOTHING IN THIS MODULE WRITES IT, and the absence is deliberate:
   * dispensing is the pharmacy's act and this clinic has no pharmacy in its
   * portfolio. The value is enumerated because the database has it, so nobody
   * concludes from the union that a dispensed prescription cannot be recorded
   * the day a pharmacy exists.
   */
  | 'COMPLETED'
  /** Annulled (PR-010). Terminal, and the row is never deleted. */
  | 'CANCELLED';

/**
 * PR-029. The route of administration, as the printed prescription names it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A CLOSED LIST, AND THE SPANISH LABEL IS PART OF THE REQUIREMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Art. 13 is literal that an electronic prescription is written «sin siglas o
 * abreviaturas», and «VO», «IM» and «SC» are exactly that. So the code is what
 * travels in the API and the SENTENCE is what the document carries: a free-text
 * field would produce «v.o.», «VO» and «vía oral» as three routes, and the one
 * the norm forbids is the one everybody types.
 *
 * ⚠️ **Falta esquema.** `prescription_item.route_code` is a bare `varchar(32)`
 * with no catalogue behind it, so this list is the only enumeration there is
 * and it lives here — where it can be checked — rather than in a comment. The
 * note is on PR-029.
 */
export const MEDICATION_ROUTES = {
  ORAL: 'Vía oral',
  SUBLINGUAL: 'Vía sublingual',
  INTRAVENOUS: 'Vía intravenosa',
  INTRAMUSCULAR: 'Vía intramuscular',
  SUBCUTANEOUS: 'Vía subcutánea',
  TOPICAL: 'Vía tópica',
  OPHTHALMIC: 'Vía oftálmica',
  OTIC: 'Vía ótica',
  NASAL: 'Vía nasal',
  RECTAL: 'Vía rectal',
  VAGINAL: 'Vía vaginal',
  INHALATION: 'Vía inhalatoria',
} as const;

/** PR-029. One of the codes of `MEDICATION_ROUTES`. */
export type MedicationRoute = keyof typeof MEDICATION_ROUTES;

/** The routes, as a list, for a schema that has to enumerate them. */
export const MEDICATION_ROUTE_CODES = Object.keys(
  MEDICATION_ROUTES,
) as MedicationRoute[];

/** PR-029. The sentence the document prints, never the code. */
export function routeLabel(route: MedicationRoute): string {
  return MEDICATION_ROUTES[route];
}

/**
 * PR-050, PR-051. Where the medicine will be dispensed from, which is what
 * arts. 18 and 19 make the validity depend on.
 *
 * ⚠️ **Falta esquema**, and it is why only one of the three is ever used today.
 * Nothing in the schema says in which modality a prescription was written:
 * `encounter.care_setting` holds `INTRAMURAL`/`EXTRAMURAL`, which answers a
 * different question — inside or outside the walls, not emergency or ward. The
 * three values are enumerated because the rule has three, and this clinic is
 * outpatient only (supuesto 1), so `AMBULATORY` is what it passes. The note is
 * on PR-051.
 */
export type DispensingContext = 'AMBULATORY' | 'EMERGENCY' | 'HOSPITALISATION';

/**
 * PR-002. Whether the attention still admits a prescription: open or on hold.
 * Discharged, completed, discontinued or entered in error, it does not.
 */
export function admitsPrescribing(status: string): boolean {
  return status === 'OPEN' || status === 'ON_HOLD';
}
