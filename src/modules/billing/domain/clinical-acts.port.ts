import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import type { PatientIdentity } from './patient-identity';

/**
 * WHAT WAS DONE, as the money side needs to read it — and nothing more.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS PORT EXISTS INSTEAD OF AN IMPORT FROM `modules/encounter`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No module imports another (ADR-008 §3), and «just for one lookup» is how
 * modules stop being modules. Billing declares here the facts it needs about a
 * visit and ITS OWN adapter answers them, exactly as it already does for the
 * patient's identification (BI-082) and as `agenda` does for the merge state
 * of a chart.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ AND EVERY METHOD HERE IS A READ. THERE IS NO WRITE AND THERE NEVER WILL BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * BI-004: «what was done» and «what is charged» are two records that must
 * never become one. Voiding a charge cannot delete the procedure, and
 * amending a note cannot move money by itself. A port that cannot write
 * cannot break that rule by accident — and a port with no
 * `mayThisEncounterBeClosed` cannot grow into the payment gate that Ley 77
 * art. 9 forbids (BI-003, BI-120, BI-156).
 *
 * ⚠️ NOTHING HERE CARRIES A DIAGNOSIS OR A REASON FOR THE VISIT (BI-007).
 * What travels is what has to appear on an invoice — the name of a service —
 * plus the identifiers needed to tie a charge to the act it came from.
 */

/** `visit_sequence`, the two values the clinical side records. */
export const VISIT_SEQUENCES = ['FIRST_TIME', 'SUBSEQUENT'] as const;
export type VisitSequence = (typeof VISIT_SEQUENCES)[number];

/**
 * A procedure recorded during the visit.
 *
 * `serviceDate` is the date the procedure was PERFORMED, resolved in
 * `America/Guayaquil` by the adapter (BI-002, BI-052) — not the date the
 * cashier is looking at the screen. On almost every day the two coincide,
 * which is exactly why the difference has to be carried explicitly.
 */
export interface PerformedProcedure {
  encounterProcedureId: string;
  /** `catalog_concept` of the procedure; the tie to a service goes through it. */
  conceptId: string;
  serviceDate: ClinicalDate;
  /** `encounter_procedure.quantity`, a whole number of times it was done. */
  quantity: number;
}

/**
 * A test asked for during the visit — ONE LINE of a service order.
 *
 * The tie to what it costs is `exam_definition.billable_service_id`, and the
 * way from this line to that definition is the CODE, which is what
 * `service_order_item.test_code` freezes. Reading it back through the order's
 * catalogue concept would ask a different question.
 */
export interface OrderedExam {
  serviceOrderItemId: string;
  /** `exam_definition.code`, frozen on the order line as `test_code`. */
  testCode: string;
  serviceDate: ClinicalDate;
  /** `CANCELLED` lines are not proposed: nobody did them. */
  cancelled: boolean;
}

/**
 * A visit, seen from the money side: what decides WHAT to propose, and never
 * whether care may proceed.
 *
 * `specialtyId` is `null` more often than it looks — a walk-in with no
 * appointment has no service type to read it from — and that is a proposal
 * with one line missing, never an error: BI-155.
 */
export interface EncounterActs {
  encounterId: string;
  siteId: string;
  patientId: string;
  /** `encounter_status`. Only `ENTERED_IN_ERROR` changes what is proposed. */
  status: string;
  /** The date of the visit itself, in Ecuador. Prices the consultation line. */
  serviceDate: ClinicalDate;
  visitSequence: VisitSequence;
  /** From the appointment's service type. `null` for a walk-in. */
  specialtyId: string | null;
  procedures: PerformedProcedure[];
  exams: OrderedExam[];
  /**
   * BI-180 (D-085 §3, §4). Whether any practitioner documented anything — a
   * note, a diagnosis, a procedure, a prescription or an order. An attention
   * interrupted without one is a patient who left before being seen.
   */
  clinicallyAttended: boolean;
}

/** BI-181. The states of a visit that has ended and can be charged. */
export const ENDED_ENCOUNTER_STATUSES = [
  'DISCHARGED',
  'DISCONTINUED',
  'COMPLETED',
] as const;
export type EndedEncounterStatus = (typeof ENDED_ENCOUNTER_STATUSES)[number];

/** BI-181 to BI-183. One ended visit still owed something, as caja lists it. */
export interface AwaitingCheckout {
  encounterId: string;
  status: EndedEncounterStatus;
  endedAt: Date;
  /** BI-182. `false` is a visit nothing was done in: nothing will be proposed. */
  clinicallyAttended: boolean;
  patient: PatientIdentity;
  /** The visit's open account, or `null` when it never went to caja. */
  account: { id: string; status: 'OPEN' } | null;
}

/**
 * The read port billing's own adapter implements over the clinical tables.
 * Reads only: see the file header for why it can never grow a write.
 */
export interface ClinicalActsRepository {
  /**
   * BI-150. Everything one visit did, in a single question.
   *
   * Scoped by site for the same reason every read in this module is: a visit
   * of another site answers `null`, indistinguishable from one that does not
   * exist (BI-135).
   */
  findEncounterActs(query: {
    encounterId: string;
    siteId: string;
  }): Promise<EncounterActs | null>;

  /**
   * BI-181. The site's visits that ended from `endedFrom` on and have no
   * settled account, most recent first. `ENTERED_IN_ERROR` never: it was not a
   * visit.
   */
  listAwaitingCheckout(query: {
    siteId: string;
    endedFrom: Date;
  }): Promise<AwaitingCheckout[]>;

  /** D-119. The unsettled ended visits older than the window, counted. */
  countAwaitingBefore(query: {
    siteId: string;
    endedBefore: Date;
  }): Promise<number>;
}

export const CLINICAL_ACTS_REPOSITORY = Symbol('ClinicalActsRepository');
