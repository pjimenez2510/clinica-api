import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/**
 * What each constraint of the prescription means to the person who hit it.
 *
 * Lives HERE, beside the repository, so adding one is a change inside the
 * module that owns it — never an edit to a shared file. Imported for its side
 * effect by `prescription.module.ts`.
 *
 * ⚠️ THE NAME OF A CONSTRAINT IS PART OF THE PUBLISHED CONTRACT. It travels to
 * the client through the PostgreSQL error mapping, so a rename here is a rename
 * of the contract.
 *
 * These codes are deliberately NOT in `error-catalogue.ts`: they are produced
 * by PostgreSQL constraints, and this registration is their enumeration.
 */
registerConstraintMeanings({
  /**
   * PR-009. `prescription_item_off_formulary`: `concept_id IS NOT NULL OR
   * off_formulary_justification IS NOT NULL`.
   *
   * THE SERVICE GETS THERE FIRST in the ordinary case, with
   * `OFF_FORMULARY_JUSTIFICATION_REQUIRED` and the box named — which is what a
   * form can act on. This entry is the same rule for the writer that did not
   * come through the service: an import, a `psql`, a use case somebody writes
   * in two years. Prescribing outside the CNMB is allowed; not saying why is
   * not.
   */
  prescription_item_off_formulary: {
    code: 'OFF_FORMULARY_JUSTIFICATION_REQUIRED',
    field: 'offFormularyJustification',
    message: 'Puede recetar fuera del CNMB, pero tiene que escribir por qué', // prettier-ignore
  },
  /**
   * PR-003. `prescription_issued_coherence`: `(status = 'DRAFT') = (issued_at
   * IS NULL)`.
   *
   * NOBODY SHOULD EVER SEE THIS THROUGH THE API: the service composes the pair
   * — the issue sets `ACTIVE` and the instant together — so every write from
   * this module already satisfies it. It is registered because the `CHECK` also
   * guards an import and a `psql`, and for those the honest answer is a
   * sentence rather than a constraint name.
   *
   * The failure it prevents is a prescription that says it is issued and cannot
   * say when, which makes the validity of art. 18 uncomputable for ever.
   */
  prescription_issued_coherence: {
    code: 'PRESCRIPTION_STATE_INCONSISTENT',
    field: 'issuedAt',
    message: 'El estado de la receta no concuerda con su instante de emisión: un borrador no puede tener hora de emisión, y una receta emitida no puede quedarse sin ella', // prettier-ignore
  },
  /**
   * PR-011, PR-107. `prescription_discard_states_who_and_when`: a `DISCARDED`
   * prescription carries `discarded_at` AND `discarded_by_id`, or it is not
   * `DISCARDED`.
   *
   * THE SERVICE WRITES THE TWO TOGETHER, from the session and the clock, so
   * nobody should reach this through the API. It is registered because the
   * `CHECK` also guards an import and a `psql`, and for those the honest
   * answer is a sentence.
   *
   * ⚠️ THE REASON IS NO LONGER PART OF IT (D-126). It replaced
   * `prescription_discard_states_who_when_and_why`: a draft never left the
   * room, so nothing is asked; who and when are what the system keeps alone.
   */
  prescription_discard_states_who_and_when: {
    code: 'PRESCRIPTION_DISCARD_INCOMPLETE',
    field: 'status',
    message: 'Un borrador descartado tiene que decir quién lo descartó y cuándo', // prettier-ignore
  },
  /**
   * PR-010, PR-011. `prescription_discard_only_from_draft`: `discarded_at IS
   * NULL OR status = 'DISCARDED'`.
   *
   * It is the schema saying that the two acts are not interchangeable. A
   * prescription that was EMITTED is annulled — art. 70, and there is paper in
   * somebody's hand; a draft is discarded. Marking an issued prescription as
   * discarded would leave «esta receta se anuló» unable to say which of the two
   * happened, which is the whole reason `DISCARDED` exists as a state of its
   * own instead of reusing `CANCELLED`.
   */
  prescription_discard_only_from_draft: {
    code: 'PRESCRIPTION_DISCARD_NOT_FROM_DRAFT',
    field: 'status',
    message: 'Sólo un borrador se descarta: una receta ya emitida se anula, que es otro acto', // prettier-ignore
  },
});
