/**
 * Who may close an attention, and what the closure has to leave written.
 *
 * D-A-010 in one pure function: *«la cierra quien la abrió»*, and when that
 * person is no longer here, somebody who signs closes it LEAVING THE CONSTANCIA
 * that they were not the author.
 *
 * PURE, AND THE INSTANT ENTERS AS A PARAMETER: the closure stamps `closed_at`,
 * and a clock read inside the domain would make «cerrar dos veces en el mismo
 * segundo» impossible to test.
 */

import {
  EncounterCloserNotAuthorError,
  SubstituteClosureReasonRequiredError,
} from './encounter.errors';
import { planStateChange, type StateChange } from './encounter-state';
import type { DischargeCondition, EncounterStatus } from './encounter';

/** What the policy needs to know about the attention being closed. */
export interface ClosableEncounter {
  status: EncounterStatus;
  /** EN-011. The practitioner who gave the attention — «quien la abrió». */
  practitionerId: string;
  /** EN-010. When the CLINICAL act ended; kept, never re-stamped (EN-131). */
  endedAt: Date | null;
  /** Already stated at the clinical discharge (EN-130). */
  dischargeCondition: DischargeCondition | null;
}

/** Who is closing it, and with what authority. */
export interface Closer {
  /** The practitioner row of the caller, never their account id. */
  practitionerId: string;
  /**
   * EN-147. Whether the caller holds `record:sign`.
   *
   * RESOLVED BY THE SERVICE FROM THE SESSION and handed in as a boolean: the
   * domain must not know what a permission is, and a policy that took a
   * `Principal` could not be exercised without building one.
   */
  canSignRecords: boolean;
  /** EN-147. Why somebody else is closing it. Trimmed by the caller. */
  substituteReason?: string;
}

/** The closure, ready for the adapter to apply. It decides nothing further. */
export interface ClosurePlan extends StateChange {
  closedById: string;
  closedAt: Date;
  /**
   * `null` exactly when the closer IS the attending practitioner.
   *
   * `encounter_substitute_closure_states_reason` guarantees the pairing in the
   * database — «or the closer is the practitioner, or there is a reason» — so
   * a shape that allowed the third combination would be inviting the adapter
   * to write a row the CHECK then rejects by name.
   */
  substituteReason: string | null;
}

/**
 * EN-009, EN-131, EN-144, EN-147. The whole of «cerrar la cuenta».
 *
 * ORDER OF THE REFUSALS, and it is not arbitrary. WHO first, because «esto no
 * le toca a usted» is the answer whatever else is wrong, and telling a
 * receptionist to fill in a reason before telling her she may not close it at
 * all would send her to type something she cannot use. The TRANSITION second,
 * so a `COMPLETED` attention answers «ya está cerrada» rather than «falta el
 * motivo». The discharge condition last, inside `planStateChange`, because by
 * then everything about the person and the state is settled.
 *
 * ⚠️ THERE IS NO CALLER THAT CAN SKIP THIS. EN-145 forbids any automatic
 * closure and this module ships no scheduled process at all — the alternative
 * D-A-010 puts in its place is the list of what is still open
 * (`encounter_still_open_by_practitioner`), which is a READ.
 */
export function planClosure(input: {
  encounter: ClosableEncounter;
  closer: Closer;
  to: EncounterStatus;
  now: Date;
}): ClosurePlan {
  const { encounter, closer } = input;
  const isAuthor = closer.practitionerId === encounter.practitionerId;

  /**
   * EN-144. The default is the author, and the exception is granted to a
   * PERSON — `record:sign` — never inherited by whoever happens to hold
   * `record:write`. Nursing writes its own forms with `nursing:write` and
   * closes nothing; reception opens attentions with `encounter:open` and
   * closes nothing either.
   */
  if (!isAuthor && !closer.canSignRecords) {
    throw new EncounterCloserNotAuthorError();
  }

  /**
   * EN-147. The reason is what stops a substitute closure from reading, twelve
   * months later, as if the attending doctor had done it — the same argument
   * that makes EN-025 demand a reason on an amendment instead of letting a new
   * version pass for the previous one.
   */
  // TRIMMED BEFORE IT IS JUDGED AND BEFORE IT IS STORED: three spaces satisfy
  // «the field is filled» and satisfy nothing a reader needs twelve months
  // later, which is the only moment this text is ever read.
  const substituteReason = isAuthor ? null : (closer.substituteReason?.trim() ?? ''); // prettier-ignore
  if (substituteReason === '') {
    throw new SubstituteClosureReasonRequiredError();
  }

  const change = planStateChange({
    from: encounter.status,
    to: input.to,
    endedAt: encounter.endedAt,
    dischargeCondition: encounter.dischargeCondition,
    now: input.now,
  });

  return {
    ...change,
    closedById: closer.practitionerId,
    /**
     * EN-131. `closed_at` and `ended_at` are the SAME instant here and they
     * are two different facts: `ended_at` is when the clinical act finished —
     * stamped at the discharge and untouched by this — and `closed_at` is when
     * the account was settled. On the ordinary path they are hours apart, and
     * that gap is the whole reason `DISCHARGED` and `COMPLETED` are two states.
     */
    closedAt: input.now,
    substituteReason,
  };
}
