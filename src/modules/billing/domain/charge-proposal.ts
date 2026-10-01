import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import type { EncounterActs, VisitSequence } from './clinical-acts.port';
import { Quantity } from './money';

/**
 * FROM THE CLINICAL ACT TO THE CHARGE — and it PROPOSES, it does not impose.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A PROPOSAL AND NOT A BILL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A system that invoices only what it deduced, with nobody looking, overcharges
 * the day the catalogue is wrong — and the person it overcharges is a patient
 * who has no way of knowing. So what comes out of here is a list of LINES
 * SOMEBODY STILL HAS TO CONFIRM (BI-152): the cashier reviews them, removes
 * what is not charged for, and adds what is missing.
 *
 * The three sources, and each one is a different question:
 *
 *   · THE CONSULTATION — «what kind of visit was this, and of which
 *     specialty». It has no clinical row of its own: the act IS the encounter.
 *   · THE PROCEDURES  — `encounter_procedure`, tied to a service through the
 *     catalogue concept both sides already name.
 *   · THE EXAMS       — `service_order_item`, tied through the code of the
 *     `exam_definition`, which is where `billable_service_id` already lives.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ THIS FILE IS PURE, AND THAT IS WHAT MAKES IT TESTABLE AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It reads no database, resolves no price and writes nothing. It receives the
 * acts, the mapping and WHAT IS ALREADY CHARGED, and returns two lists. Every
 * awkward case — a procedure nobody mapped, an exam whose service was
 * deactivated, a visit with no specialty — becomes a row in the second list
 * with its reason, never an exception: BI-155, one unmappable act must not
 * cost the clinic the other six lines of the visit.
 */

/** `charge_item_origin_is_known`. Where a line came from. */
export const CHARGE_ORIGINS = [
  'MANUAL',
  'CONSULTATION',
  'PROCEDURE',
  'EXAM',
] as const;
/** One of `CHARGE_ORIGINS`, as `charge_item.origin` stores it. */
export type ChargeOrigin = (typeof CHARGE_ORIGINS)[number];

/** The three a proposal can produce. `MANUAL` is what a person types. */
export type DerivedOrigin = Exclude<ChargeOrigin, 'MANUAL'>;

/**
 * Why an act produced no proposed line.
 *
 * ⚠️ CODES AND NOT SENTENCES, and no service name among them (BI-007): this
 * list is served to a screen and reaches logs on the way. The screen turns the
 * code into Spanish; the identifier is what lets somebody act on it.
 */
export const PROPOSAL_SKIP_REASONS = [
  /** The act already has a charge — including one somebody voided (BI-157). */
  'ALREADY_CHARGED',
  /** Nothing in the catalogue says what this act costs. */
  'NO_BILLABLE_SERVICE',
  /** It does, and the service was deactivated (BI-015). */
  'SERVICE_INACTIVE',
  /** The order line was cancelled: nobody did it. */
  'ACT_CANCELLED',
  /** Mapped and active, and no price in force on the service date (BI-047). */
  'NO_PRICE_FOR_DATE',
] as const;
/** One of `PROPOSAL_SKIP_REASONS`. */
export type ProposalSkipReason = (typeof PROPOSAL_SKIP_REASONS)[number];

/** A line the proposal offers. Nothing here is an amount: the price is resolved
 * and frozen when the charge is written, in the same transaction (BI-050). */
export interface ProposedCharge {
  origin: DerivedOrigin;
  billableServiceId: string;
  serviceDate: ClinicalDate;
  quantity: Quantity;
  encounterProcedureId: string | null;
  serviceOrderItemId: string | null;
}

/** An act that produced no line, and why. */
export interface SkippedAct {
  origin: DerivedOrigin;
  encounterProcedureId: string | null;
  serviceOrderItemId: string | null;
  reason: ProposalSkipReason;
}

/**
 * BI-152, BI-155. What the cashier reviews: the lines offered and the acts that
 * produced none, each with its reason, so nothing the visit did disappears
 * silently.
 */
export interface ChargeProposal {
  proposed: ProposedCharge[];
  skipped: SkippedAct[];
}

/** The catalogue's answer for one act: which service, and whether it is alive. */
export interface ServiceMatch {
  billableServiceId: string;
  active: boolean;
}

/**
 * Everything the derivation needs from the catalogue, ALREADY READ.
 *
 * Maps and not lookups on purpose: a pure function that could ask a question
 * would be one `await` away from asking it inside a loop, which is the shape
 * of the query-per-row that makes a cashier screen slow with twelve lines.
 */
export interface ChargeMapping {
  /** BI-158. The service that IS the consultation, or `null` if none is set. */
  consultation: ServiceMatch | null;
  /** `catalog_concept.id` → the service that charges for that procedure. */
  byProcedureConcept: ReadonlyMap<string, ServiceMatch>;
  /** `exam_definition.code` → the service the definition points at. */
  byExamCode: ReadonlyMap<string, ServiceMatch>;
}

/**
 * The acts a charge already names, so a second press proposes nothing again.
 *
 * ⚠️ THIS IS THE COMFORTABLE HALF OF THE IDEMPOTENCE, NOT THE GUARANTEE.
 * The guarantee is in the database — three partial unique indexes (BI-154) —
 * because two simultaneous presses both read «nothing charged yet» and both
 * insert. What this does is turn the second press into a clean answer instead
 * of a rejected write.
 */
export interface AlreadyCharged {
  /** Whether the consultation of this encounter is already on the account. */
  consultation: boolean;
  encounterProcedureIds: ReadonlySet<string>;
  serviceOrderItemIds: ReadonlySet<string>;
}

const ONE = Quantity.parse('1');

/**
 * BI-151, BI-152, BI-155. What this visit suggests charging for.
 *
 * ⚠️ AN ENCOUNTER MARKED `ENTERED_IN_ERROR` PROPOSES NOTHING, and neither does
 * one interrupted before any clinical act (BI-180). It is the one
 * encounter status this function branches on, and the reason is not
 * bookkeeping: that status exists precisely so a visit that should never have
 * been recorded does not count as one, and charging for it would be the system
 * asserting the opposite. Every other status — open, on hold, discharged,
 * discontinued — proposes normally: BI-073 and BI-156 say the cashier's step
 * and the clinical closure do not wait for each other in either direction.
 */
export function proposeCharges(
  acts: EncounterActs,
  mapping: ChargeMapping,
  charged: AlreadyCharged,
): ChargeProposal {
  if (acts.status === 'ENTERED_IN_ERROR') return { proposed: [], skipped: [] };
  /**
   * BI-180 (D-085 §4). An attention INTERRUPTED with no clinical act at all is
   * the patient who left before the doctor saw them (D-081 §2): there was no
   * consultation to propose, and proposing it would have the cashier decide,
   * line by line, what the record already says.
   */
  if (acts.status === 'DISCONTINUED' && !acts.clinicallyAttended) {
    return { proposed: [], skipped: [] };
  }

  const proposed: ProposedCharge[] = [];
  const skipped: SkippedAct[] = [];

  /**
   * Routes one act to `proposed` or to `skipped`.
   *
   * The checks run in a fixed order — already charged, cancelled, unmapped,
   * inactive — so an act carries ONE reason, the first that applies: an act
   * charged before is reported as charged even if its service has since been
   * deactivated.
   */
  const take = (
    origin: DerivedOrigin,
    source: { procedureId?: string; orderItemId?: string },
    match: ServiceMatch | null,
    already: boolean,
    serviceDate: ClinicalDate,
    quantity: Quantity,
    cancelled = false,
  ): void => {
    const line: SkippedAct = {
      origin,
      encounterProcedureId: source.procedureId ?? null,
      serviceOrderItemId: source.orderItemId ?? null,
      reason: 'ALREADY_CHARGED',
    };

    if (already) return void skipped.push(line);
    if (cancelled) return void skipped.push({ ...line, reason: 'ACT_CANCELLED' }); // prettier-ignore
    if (match === null) return void skipped.push({ ...line, reason: 'NO_BILLABLE_SERVICE' }); // prettier-ignore
    if (!match.active) return void skipped.push({ ...line, reason: 'SERVICE_INACTIVE' }); // prettier-ignore

    proposed.push({
      origin,
      billableServiceId: match.billableServiceId,
      serviceDate,
      quantity,
      encounterProcedureId: line.encounterProcedureId,
      serviceOrderItemId: line.serviceOrderItemId,
    });
  };

  // ── The consultation ──────────────────────────────────────────────────
  //
  // `specialtyId === null` and «no service mapped» collapse into the same
  // answer, NO_BILLABLE_SERVICE, and deliberately: from the cashier's side
  // both mean «the system cannot tell you what this visit costs, type it», and
  // splitting them would offer a distinction nobody can act on differently.
  take(
    'CONSULTATION',
    {},
    acts.specialtyId === null ? null : mapping.consultation,
    charged.consultation,
    acts.serviceDate,
    ONE,
  );

  // ── The procedures ────────────────────────────────────────────────────
  for (const procedure of acts.procedures) {
    take(
      'PROCEDURE',
      { procedureId: procedure.encounterProcedureId },
      mapping.byProcedureConcept.get(procedure.conceptId) ?? null,
      charged.encounterProcedureIds.has(procedure.encounterProcedureId),
      procedure.serviceDate,
      quantityOf(procedure.quantity),
    );
  }

  // ── The exams ─────────────────────────────────────────────────────────
  //
  // ⚠️ ORDERED, NOT RESULTED. What the clinic sold is the request — the
  // patient took the order and the specimen was drawn — and waiting for the
  // report to charge would leave every external laboratory line uncharged
  // forever (`exam_definition.performed_externally` defaults to true). A test
  // that was never done is CANCELLED on the order, and that is the line this
  // does not propose.
  for (const exam of acts.exams) {
    take(
      'EXAM',
      { orderItemId: exam.serviceOrderItemId },
      mapping.byExamCode.get(exam.testCode) ?? null,
      charged.serviceOrderItemIds.has(exam.serviceOrderItemId),
      exam.serviceDate,
      ONE,
      exam.cancelled,
    );
  }

  return { proposed, skipped };
}

/**
 * `encounter_procedure.quantity` as a charge quantity.
 *
 * A `smallint` the clinical side already keeps positive; anything else would
 * be a row that should not exist, and one is charged rather than refusing the
 * whole proposal — BI-155 again. `charge_item_quantity_is_positive` is the
 * backstop underneath.
 */
function quantityOf(quantity: number): Quantity {
  return Number.isInteger(quantity) && quantity > 0
    ? Quantity.parse(String(quantity))
    : ONE;
}

/** BI-158. Which pair of (specialty, visit sequence) a visit asks the catalogue for. */
export function consultationKeyOf(acts: EncounterActs): {
  specialtyId: string;
  visitSequence: VisitSequence;
} | null {
  if (acts.specialtyId === null) return null;
  return { specialtyId: acts.specialtyId, visitSequence: acts.visitSequence };
}
