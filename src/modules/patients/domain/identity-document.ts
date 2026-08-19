import type { IdentifierType } from './patient.repository';

/**
 * What counts as a DEFINITIVE identity document (PA-014, PA-015, PA-032).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RULE IS THE DATABASE'S, AND IT IS WRITTEN IN AN INDEX PREDICATE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `patient_identifier_active_unique`
 * (`20260806022956_clinical_core_constraints`) is a PARTIAL unique index, and
 * its predicate excludes `type = 'PROVISIONAL'` outright, along with every
 * `use` that is not `OFFICIAL`. A provisional marker reserves nothing and
 * collides with nothing, because it identifies nobody. The SPEC's vocabulary
 * says the same in words: «provisional» is a chart WITHOUT A DEFINITIVE
 * DOCUMENT.
 *
 * So `PROVISIONAL` is a NOTE, not papers — `SN-001` written on the folder of
 * an unconscious trauma case so the desk can call them something. Counting it
 * as a document declares the chart complete for the RDACAA with no identity
 * document at all, and the monthly report then carries a patient nobody can
 * identify.
 *
 * ONE PREDICATE, THREE CALLERS, and they disagreed before it existed:
 * registration decides `is_provisional` with it, `addIdentifier` decides
 * whether the provisional state ends, and `rdacaaMissingFields` decides
 * whether `identifier` is covered.
 */

/** The marker type the partial unique index leaves out. */
export const PROVISIONAL_IDENTIFIER_TYPE = 'PROVISIONAL';

/**
 * Whether this identifier is a document and not a placeholder.
 *
 * Takes the TYPE only: nothing else about an identifier decides this, and
 * asking for the whole shape would invite a second rule about the value.
 */
export function isDefinitiveDocument(identifier: {
  type: IdentifierType;
}): boolean {
  return identifier.type !== PROVISIONAL_IDENTIFIER_TYPE;
}
