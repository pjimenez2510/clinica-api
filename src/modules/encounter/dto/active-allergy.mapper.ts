import type { ActiveAllergy } from '../../../shared/clinical/patient-allergy.port';

import type { AllergyAbsenceAssertion } from '../domain/patient-allergy.repository';

import type {
  ActiveAllergyResponse,
  NoKnownAllergiesResponse,
} from './patient-allergy.dto';

/**
 * EN-081. One active allergy, on its way out.
 *
 * ⚠️ WRITTEN ONCE BECAUSE IT IS SERVED FROM TWO ROUTES — the attention
 * (`GET /encounters/:id`) and the chart summary — and the requirement is
 * precisely that both carry it: «una alergia que hay que ir a buscar a otra
 * pantalla no es visible de manera permanente». Two hand-written mappings
 * would eventually differ in a field, and the field they would differ in is
 * `criticality`, which is the one that says whether it kills.
 *
 * IN `dto/` AND NOT IN A CONTROLLER because that is what it is: the shape of
 * the transport, shared by the two controllers that publish it.
 */
export function toActiveAllergyResponse(
  allergy: ActiveAllergy,
): ActiveAllergyResponse {
  return {
    id: allergy.id,
    /**
     * The chart it was WRITTEN ON, which after a merge may be one the chart
     * asked about absorbed (D-031). It travels so a screen can tell them
     * apart; nothing requires it to match the id in the URL, and a client that
     * filtered on that would re-create the defect the scope exists to fix.
     */
    patientId: allergy.patientId,
    substanceConceptId: allergy.substanceConceptId,
    substanceText: allergy.substanceText,
    reaction: allergy.reaction,
    criticality: allergy.criticality,
    recordedAt: allergy.recordedAt.toISOString(),
  };
}

/**
 * EN-087. The «sin alergias conocidas» assertion, on its way out.
 *
 * HERE FOR THE SAME REASON AS THE ONE ABOVE: it is served from the route that
 * writes it and from the chart summary that reads it, and two hand-written
 * mappings would eventually differ. The field they would differ in is
 * `assertedByName`, which is the half that makes this an assertion by a person
 * rather than a system's silence.
 *
 * ⚠️ WHAT IT DOES NOT CARRY: the row's own `id` and its `patientId`. Nothing on
 * the screen addresses one of these — there is no route to fetch, amend or
 * refute an assertion, because the way it stops standing is that an allergy
 * gets recorded. An identifier served with nothing to do is an identifier a
 * client eventually invents a use for.
 */
export function toNoKnownAllergiesResponse(
  assertion: AllergyAbsenceAssertion,
): NoKnownAllergiesResponse {
  return {
    assertedById: assertion.assertedById,
    assertedByName: assertion.assertedByName,
    assertedAt: assertion.assertedAt.toISOString(),
  };
}
