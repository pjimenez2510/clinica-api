/**
 * PR-028 to PR-032. Art. 5 of the Resolución ACESS-2023-0030, as a rule that
 * runs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LIST IS ENUMERATED HERE AND NOT REFERENCED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «El contenido mínimo de la norma» specifies nothing; the list does. It lives
 * in one file so there is one place to read when an inspector asks which fields
 * this system guarantees, and one place to change when the norm moves.
 *
 * ⚠️ AND IT IS DEMANDED AT THE ISSUE, NOT AT THE COMPOSITION. A form that
 * refuses to save until it is complete is a form nobody saves — the doctor
 * writes the prescription with the patient in front of them and fills the
 * duration last. The instant the document becomes a legal document is the
 * instant art. 5 applies, and that is the transition `DRAFT → ACTIVE`.
 *
 * PURE: no clock, no database, no framework.
 */

import {
  OffFormularyJustificationRequiredError,
  PrescriptionEmptyError,
  PrescriptionItemIncompleteError,
  PrescriptionSingleDoseWithDurationError,
} from './prescription.errors';
import type { Frequency } from './prescription-vocabulary';

/** One line of the prescription, as the content rules see it. */
export interface ItemContent {
  /** 1-based. It is the address an error message uses (PR-032, PR-094). */
  line: number;
  /** Art. 5.c.i — DCI, «sin siglas ni abreviaturas». Frozen from the CNMB. */
  genericName: string | null;
  /** Art. 5.c.ii — forma farmacéutica. */
  presentation: string | null;
  /** Art. 5.c.iii — concentración del principio activo. */
  concentration: string | null;
  /** Art. 5.c.iv — vía de administración. A code of `MEDICATION_ROUTES`. */
  routeCode: string | null;
  /** Art. 5.c.v — cantidad. The words are derived from it (PR-030). */
  quantity: number | null;
  /** Art. 5.c.vi — dosis/posología. */
  doseText: string | null;
  /** Art. 5.c.vi — frecuencia de la administración. */
  frequencyText: string | null;
  /** Art. 5.c.vi — duración del tratamiento, in days. */
  durationDays: number | null;
  /**
   * PR-102, PR-105. The frequency's code when it came from the list, so a
   * single dose is not asked for a duration.
   */
  frequencyCode: string | null;
  /** PR-007. The CNMB concept, or `null` when prescribing outside it. */
  conceptId: string | null;
  /** PR-009. Mandatory exactly when `conceptId` is `null`. */
  offFormularyJustification: string | null;
}

/**
 * The fields of art. 5.c, in the order the norm lists them.
 *
 * A LIST AND NOT NINE `if`s, because the error has to be able to name ALL the
 * missing ones at once: a form that reports one missing box per round trip is a
 * form somebody submits five times.
 */
const MANDATORY_ITEM_FIELDS: readonly (keyof ItemContent)[] = [
  'genericName',
  'presentation',
  'concentration',
  'routeCode',
  'quantity',
  'doseText',
  'frequencyText',
  'durationDays',
];

/** PR-105. The frequency code of «Dosis única». */
const SINGLE_DOSE: Frequency = 'SINGLE_DOSE';

/** Blank is missing: `''` in a `varchar` is not a concentration. */
function isMissing(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return !Number.isFinite(value);
  return false;
}

/**
 * PR-009. Prescribing outside the CNMB is allowed; not saying why is not.
 *
 * CHECKED WHEN THE LINE IS WRITTEN and not only at the issue, unlike everything
 * else in this file, and the reason is that `prescription_item_off_formulary`
 * refuses the INSERT: without this the caller would get the constraint's
 * `CHECK_FAILED` instead of a sentence, at composition time, on a form where
 * one box is empty.
 */
export function assertOffFormularyJustified(item: ItemContent): void {
  if (item.conceptId !== null) return;
  if (!isMissing(item.offFormularyJustification)) return;
  throw new OffFormularyJustificationRequiredError(item.line);
}

/**
 * PR-032. Everything art. 5.c demands, on every line, at the moment of issue.
 *
 * ⚠️ IT REPORTS EVERY MISSING FIELD OF EVERY LINE IN ONE ANSWER. The failure
 * mode of the opposite is specific and familiar: the doctor fixes the
 * concentration, submits, is told the route is missing, fixes it, submits, is
 * told the duration is missing — and the third time round somebody types
 * anything into the box to make it stop.
 */
export function assertItemsComplete(items: readonly ItemContent[]): void {
  if (items.length === 0) throw new PrescriptionEmptyError();
  const missing = missingItemFields(items);
  if (missing.length > 0) throw new PrescriptionItemIncompleteError(missing);
  // PR-105. Not printed, and not issued either: a contradiction somebody
  // wrote before the request refused it.
  const contradicted = items
    .filter(
      (item) =>
        item.frequencyCode === SINGLE_DOSE && item.durationDays !== null,
    )
    .map((item) => item.line);
  if (contradicted.length > 0)
    throw new PrescriptionSingleDoseWithDurationError(contradicted);
}

/** Every art. 5.c field missing on every line, in line order. */
function missingItemFields(
  items: readonly ItemContent[],
): { line: number; field: string }[] {
  const missing: { line: number; field: string }[] = [];
  for (const item of items) {
    assertOffFormularyJustified(item);
    for (const field of MANDATORY_ITEM_FIELDS) {
      // PR-105. A single dose does not last: no duration to demand.
      if (field === 'durationDays' && item.frequencyCode === SINGLE_DOSE)
        continue;
      if (isMissing(item[field])) missing.push({ line: item.line, field });
    }
  }
  return missing;
}

/** What art. 5 demands of the prescription as a whole, at the issue. */
export interface PrescriptionContent {
  /** PR-038, art. 5.e.iv — signos de alarma. */
  warningSigns: string | null;
  /** PR-039, art. 5.e.v — recomendaciones no farmacológicas. */
  nonPharmacologicalAdvice: string | null;
  items: readonly ItemContent[];
}

/**
 * The fields of art. 5.e that belong to the PRESCRIPTION and not to a line, in
 * the order the norm lists them.
 */
const MANDATORY_PRESCRIPTION_FIELDS = [
  'warningSigns',
  'nonPharmacologicalAdvice',
] as const;

/**
 * PR-032, PR-038, PR-039. Everything art. 5 demands at the moment of issue:
 * the indications of the prescription and art. 5.c on every line.
 *
 * ONE ANSWER FOR BOTH, prescription first and then the lines, for the reason
 * `assertItemsComplete` gives: a form that reports one missing box per round
 * trip is a form somebody submits five times.
 */
export function assertPrescriptionComplete(content: PrescriptionContent): void {
  if (content.items.length === 0) throw new PrescriptionEmptyError();

  const missing: { line: number | null; field: string }[] = [
    ...MANDATORY_PRESCRIPTION_FIELDS.filter((field) =>
      isMissing(content[field]),
    ).map((field) => ({ line: null, field })),
    ...missingItemFields(content.items),
  ];

  if (missing.length > 0) throw new PrescriptionItemIncompleteError(missing);
}
