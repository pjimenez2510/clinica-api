/**
 * The ORDERABLE half: what the doctor asks for and what the invoice charges.
 *
 * One `exam_definition` is ONE line on the order and ONE line on the invoice,
 * and it yields many `analyte_definition`s. See `analyte.ts` for the other
 * half, and the SPEC's opening section for why the distinction decides the
 * whole design.
 */

/** `service_order_category`. An order is laboratory, imaging or procedure. */
export type ServiceOrderCategory = 'LABORATORY' | 'IMAGING' | 'PROCEDURE';

/** `service_order_status`. ORD-095 to ORD-099. */
export type ServiceOrderStatus = 'DRAFT' | 'ISSUED' | 'DISCARDED';

/** `service_order_priority`. */
export type ServiceOrderPriority = 'ROUTINE' | 'URGENT' | 'STAT';

/** `service_order_item_status`. */
export type ServiceOrderItemStatus =
  'REQUESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

/** `diagnostic_report_status`. */
export type DiagnosticReportStatus =
  'PARTIAL' | 'FINAL' | 'CORRECTED' | 'CANCELLED';

/**
 * `encounter_status`, as this module needs to read it.
 *
 * ⚠️ DECLARED HERE AND NOT IMPORTED FROM `encounter`. No module imports
 * another (`sin-imports-entre-modulos`), and the day that rule is bent «for
 * just one type» the modules stop being modules. The same route `encounter`
 * itself takes for the catalogue concepts it reads.
 */
export type EncounterStatus =
  | 'OPEN'
  | 'ON_HOLD'
  | 'DISCONTINUED'
  | 'DISCHARGED'
  | 'COMPLETED'
  | 'ENTERED_IN_ERROR';

/**
 * ORD-005. Whether an attention in this state still admits an order.
 *
 * THE THREE THAT DO, and each for a reason:
 *
 *  - `OPEN` — the ordinary case.
 *  - `ON_HOLD` — the attention is suspended, not over. The patient stepped out
 *    for the extraction; refusing here would be refusing the very order that
 *    caused the suspension.
 *  - `DISCHARGED` — the clinical act ended and the account has not been
 *    settled. An exam ordered on the way out is a normal consultation, and the
 *    alternative is a doctor opening a second attention to write one line.
 *
 * THE THREE THAT DO NOT are the terminal ones: `COMPLETED`, `DISCONTINUED` and
 * `ENTERED_IN_ERROR`. An order attached to an annulled attention is an order
 * nobody will ever look for, because the attention it hangs off is not on any
 * screen.
 *
 * ⚠️ A FUNCTION AND NOT A `Set` EXPORTED RAW, so that adding a state to the
 * enum is a compile error here rather than a silent «no» somewhere else: the
 * exhaustive record below has no index signature.
 */
const ADMITS_ORDERS: Readonly<Record<EncounterStatus, boolean>> = {
  OPEN: true,
  ON_HOLD: true,
  DISCHARGED: true,
  COMPLETED: false,
  DISCONTINUED: false,
  ENTERED_IN_ERROR: false,
};

/** ORD-005. The lookup into `ADMITS_ORDERS`. */
export function admitsNewOrders(status: EncounterStatus): boolean {
  return ADMITS_ORDERS[status];
}

/**
 * ORD-008. Whether a line is still waiting for its result.
 *
 * The DATABASE says the same thing with `completed_at IS NULL`, which is what
 * the partial index `service_order_item_pending` and the trigger that keeps
 * `pending_items` in step are built on. This is the STATUS side of it, and the
 * two are kept together by ORD-007: cancelling sets both.
 */
export function isPending(status: ServiceOrderItemStatus): boolean {
  return status === 'REQUESTED' || status === 'IN_PROGRESS';
}

/**
 * ORD-053, ORD-119. Whether a report can be superseded by a new version.
 *
 * A `CANCELLED` one asserts nothing. `CORRECTED` is in the list on purpose: a
 * correction can itself be wrong, and the chain has to be able to grow. And
 * since ORD-119 a `PARTIAL` one is completed by EDITING it: the new version
 * brings what it said and what was missing, and the partial stays readable
 * behind it (ORD-050, ORD-051).
 */
export function isCorrectable(status: DiagnosticReportStatus): boolean {
  return status !== 'CANCELLED';
}

/** One value as a report states it, for comparing two versions. */
interface StatedValue {
  analyteDisplay: string;
  valueNumeric: number | null;
  valueCode: string | null;
  valueText: string | null;
}

/**
 * ORD-050, ORD-119. The status of the version that supersedes `previous`.
 *
 * A definitive report superseded is always `CORRECTED`: that is how a screen
 * knows to print «corregido el …» beside a number somebody may have acted on.
 * A PARTIAL one that is only COMPLETED —every value it stated comes back the
 * same— takes the status its contents earn (`completeness`: `FINAL` with every
 * determination in, `PARTIAL` while one is missing), because nothing anybody
 * read has changed. If any value it stated changes, it is a correction, and
 * says so: a value that changes in silence is a safety incident.
 */
export function supersedingStatus(
  previous: { status: DiagnosticReportStatus; results: readonly StatedValue[] },
  brought: readonly StatedValue[],
  completeness: DiagnosticReportStatus,
): DiagnosticReportStatus {
  if (previous.status !== 'PARTIAL') return 'CORRECTED';
  const changed = previous.results.some((was) => {
    const now = brought.find((value) => value.analyteDisplay === was.analyteDisplay); // prettier-ignore
    return (
      now === undefined ||
      now.valueNumeric !== was.valueNumeric ||
      now.valueCode !== was.valueCode ||
      now.valueText !== was.valueText
    );
  });
  return changed ? 'CORRECTED' : completeness;
}

/**
 * ORD-039. Whether every determination the orderable promises has arrived.
 *
 * ⚠️ REFLEX ANALYTES DO NOT COUNT, and that is the requirement rather than an
 * optimisation. A reflex analyte is only produced when another comes back
 * positive — `exam_definition_analyte.is_reflex` — so counting it would leave
 * every complete blood count with a reflex differential permanently pending,
 * and a worklist that is permanently wrong is a worklist people stop reading.
 *
 * ⚠️ THE KEY IS THE FROZEN DISPLAY AND NOT AN IDENTIFIER, AND THAT IS A SCHEMA
 * GAP RATHER THAN A CHOICE (ORD-031). `observation_result` has no
 * `analyte_definition_id`: its only pointer is `analyte_concept_id`, which
 * targets `catalog_concept`, and no ANALYTE catalogue system exists. So the
 * one link a stored result keeps back to the resultable catalogue is
 * `analyte_display` — the very fragility the two-catalogue design exists to
 * remove. Written down on ORD-031, not worked around silently.
 *
 * `expected` is what the exam declares; `reported` is the set of displays the
 * order has actually received so far.
 */
export function isLineComplete(
  expected: readonly { analyteDisplay: string; isReflex: boolean }[],
  reported: ReadonlySet<string>,
): boolean {
  const required = expected.filter((analyte) => !analyte.isReflex);
  /**
   * AN EXAM THAT DECLARES NO ANALYTE IS NEVER COMPLETED BY THIS RULE, and the
   * `false` is deliberate. `exam_definition_analyte` is what makes a result
   * checkable at all; an exam with an empty list is a catalogue row somebody
   * has not finished, and auto-completing its line would take it off the
   * worklist without anybody having seen a value. It stays visible instead —
   * which is exactly what a half-built catalogue row should do.
   */
  if (required.length === 0) return false;
  return required.every((analyte) => reported.has(analyte.analyteDisplay));
}
