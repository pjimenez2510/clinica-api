/**
 * D-085 §1 and §2. Who may take an attention out by a door that is not the
 * discharge — annulling it (EN-166) or interrupting it (EN-167) — and from
 * which states.
 *
 * THE SAME RULE AS THE CLOSURE (EN-144, EN-147), by the author's decision:
 * the attending practitioner, or somebody who signs clinical records leaving
 * the reason they act instead. And the SAME error codes, because it is the
 * same rule: a client that already explains «esto lo cierra quien la abrió»
 * explains this too.
 *
 * PURE: no clock, no I/O.
 */

import { isWritten } from '../../../shared/domain/written-text';
import type { Closer } from './encounter-closure';
import {
  EncounterCloserNotAuthorError,
  InvalidEncounterTransitionError,
  SubstituteClosureReasonRequiredError,
} from './encounter.errors';
import type { EncounterStatus } from './encounter';

/**
 * EN-144, EN-147 applied to the exits. Returns the substitute's reason, or
 * `null` when the actor IS the attending practitioner.
 */
export function planExitActor(
  attendingPractitionerId: string,
  actor: Closer,
): string | null {
  const isAuthor = actor.practitionerId === attendingPractitionerId;
  if (isAuthor) return null;
  if (!actor.canSignRecords) throw new EncounterCloserNotAuthorError();

  const reason = actor.substituteReason?.trim() ?? '';
  if (reason === '') throw new SubstituteClosureReasonRequiredError();
  return reason;
}

/**
 * D-085 §1. An attention is annulled only while it is in progress. Once
 * signed, its prescription, orders and diagnoses already stand in the chart
 * and may already be invoiced: «this never existed» is no longer true of it,
 * and what was signed is retracted note by note (EN-026).
 */
export function assertAnnullable(from: EncounterStatus): void {
  if (from !== 'OPEN' && from !== 'ON_HOLD') {
    throw new InvalidEncounterTransitionError(from, 'ENTERED_IN_ERROR');
  }
}

/**
 * D-085 §5. A draft with nothing written is not signed: a signature over an
 * empty note states that a practitioner vouches for nothing. It stays a draft,
 * frozen inside the terminal attention (EN-169), and its emptiness is the
 * record. «Written» is `isWritten`, the rule `hasClinicalAct` asks in SQL.
 */
export function hasWrittenContent(content: unknown): boolean {
  if (content === null || typeof content !== 'object') return false;
  return Object.values(content as Record<string, unknown>).some(
    (value) => typeof value === 'string' && isWritten(value),
  );
}
