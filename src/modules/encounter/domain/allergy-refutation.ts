import type { AllergyCriticality } from '../../../shared/clinical/patient-allergy.port';

/**
 * D-140.1 and D-140.3: what ruling out an allergy demands by its criticality.
 *
 * An allergy of HIGH criticality is the anaphylaxis one. Ruling it out
 * without saying why leaves a row that a future doctor cannot weigh, and the
 * cost of believing it wrongly is the patient's life (D-126.4: a risk to the
 * patient is the exception to «sin motivo obligatorio»). So it needs a
 * reason, and it is never ruled out as a side effect of a bulk step: one by
 * one, each with its reason.
 */
export function refutationNeedsReason(
  criticality: AllergyCriticality,
): boolean {
  return criticality === 'HIGH';
}

/** D-140.3. Never in «descartar estas y afirmar»: ruled out one by one. */
export function refutedOnlyAlone(criticality: AllergyCriticality): boolean {
  return criticality === 'HIGH';
}

/**
 * EN-226, D-140.3. The reason written on every allergy «Descartar estas y
 * afirmar» rules out: whoever reads the refutation later knows it came from
 * the bulk step and not from a test or a judgement about that allergy.
 */
export const BULK_REFUTATION_NOTE =
  'Descartada al afirmar sin alergias conocidas';
