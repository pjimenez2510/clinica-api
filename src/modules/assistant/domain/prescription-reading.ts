/**
 * AS-063 to AS-072. The rules of «Proponer la receta» that need no model, no
 * database and no clock: whether a line's phrase is in the note, which
 * presentation of the cuadro it may carry, what the system fills in and marks
 * «Nadie lo dijo», the line as one comparable text, and what the allergy rule
 * says of it.
 *
 * Copied and adapted from SigmAI (`modules/prescribing/course-of-treatment.ts`,
 * `per-dose.ts`, `prescribing.service.ts`): there the units were the clinic's
 * own catalogue ids; here they are the receta's vocabulary (PR-101, PR-102)
 * and the medicine is a concept of the CNMB with its presentations (PR-115).
 */
import {
  exactAllergyMatches,
  therapeuticClassMatches,
  type KnownAllergy,
  type SubstanceKeys,
} from '../../../shared/clinical/allergy-match';
import {
  DOSAGE_FORMS,
  DOSE_UNITS,
  FREQUENCIES,
  MEDICATION_ROUTES,
  matchingPresentations,
  type DosageForm,
  type DoseUnit,
  type Frequency,
  type MedicationRoute,
} from '../../../shared/clinical/prescription-vocabulary';

import { foldText, locateQuote } from './problem-coding';

/** AS-063. A line as the model read it, every field as written or null. */
export interface ReadLine {
  /** The medicine's name only, as written: what the cuadro is searched by. */
  drug: string;
  /** As written («500 mg»): it chooses the presentation, it is not a dose. */
  strength: string | null;
  form: DosageForm | null;
  doseAmount: number | null;
  doseUnit: DoseUnit | null;
  route: MedicationRoute | null;
  frequency: Frequency | null;
  frequencyText: string | null;
  durationDays: number | null;
  instructions: string | null;
  quote: string;
}

/** A line as the model answered it: the codes still unchecked text. */
export type AnsweredLine = Omit<
  ReadLine,
  'form' | 'doseUnit' | 'route' | 'frequency'
> & {
  // prettier-ignore
  form: string | null;
  doseUnit: string | null;
  route: string | null;
  frequency: string | null;
};

const isKeyOf = <T extends object>(
  table: T,
  value: string | null,
): value is Extract<keyof T, string> =>
  // prettier-ignore
  value !== null && Object.hasOwn(table, value);

/**
 * AS-063. Every code the model wrote checked against the receta's closed
 * lists (PR-101, PR-102): what is not of the list is empty, never guessed.
 */
export function knownCodes(line: AnsweredLine): ReadLine {
  return {
    ...line,
    form: isKeyOf(DOSAGE_FORMS, line.form) ? line.form : null,
    doseUnit: isKeyOf(DOSE_UNITS, line.doseUnit) ? line.doseUnit : null,
    route: isKeyOf(MEDICATION_ROUTES, line.route) ? line.route : null,
    frequency: isKeyOf(FREQUENCIES, line.frequency) ? line.frequency : null,
  };
}

/** A line whose phrase the note does contain, with the originals put back. */
export interface BackedLine extends ReadLine {
  /** The note's own sentence (P2). */
  quote: string;
  section: string;
}

/**
 * AS-063. Keeps the lines whose phrase is in the cleared text the model read
 * AND, with the placeholders put back, in the note itself as whole words and
 * not denied there — the rule of AS-028. A line without its phrase is a line
 * nobody wrote: dropped, and counted.
 */
export function backedLines(input: {
  read: readonly ReadLine[];
  cleared: string;
  sections: readonly { key: string; text: string }[];
  restore: (text: string) => string;
}): { kept: BackedLine[]; dropped: number } {
  const cleared = foldText(input.cleared);
  const kept: BackedLine[] = [];
  for (const line of input.read) {
    if (!cleared.includes(foldText(line.quote))) continue;
    const drug = input.restore(line.drug).trim();
    if (drug === '') continue;
    const located = locateQuote(input.restore(line.quote).trim(), input.sections); // prettier-ignore
    if (!located) continue;
    kept.push({
      ...line,
      drug,
      instructions:
        line.instructions === null ? null : input.restore(line.instructions),
      frequencyText:
        line.frequencyText === null ? null : input.restore(line.frequencyText),
      quote: located.sentence,
      section: located.section,
    });
  }
  return { kept, dropped: input.read.length - kept.length };
}

/** PR-115. A presentation of the cuadro, as the reader gives it. */
export interface Presentation {
  form: string;
  forms?: readonly string[];
  concentration: string;
  route?: string;
}

/** What the line takes from the presentation chosen, when it may take one. */
export interface ChosenPresentation {
  form: DosageForm;
  /** Null when the cuadro declares a range and the note wrote no figure. */
  concentration: string | null;
  route: string | null;
}

const RANGE = /\d\s*\S*\s+-\s+\d/;

/**
 * AS-066. The presentation the model chose, when it is compatible with what
 * the note wrote — its form among those the presentation admits, its
 * strength the declared one or inside its range (PR-115) — and null when it
 * contradicts the note: a presentation the note denies is the model's error,
 * not a proposal.
 */
export function presentationFor(
  presentation: Presentation | undefined,
  said: { form: DosageForm | null; strength: string | null },
): ChosenPresentation | null {
  if (!presentation) return null;
  const admitted = presentation.forms ?? [presentation.form];
  if (said.form !== null && !admitted.includes(said.form)) return null;
  const form = (said.form ?? presentation.form) as DosageForm;
  if (!(form in DOSAGE_FORMS)) return null;
  if (
    said.strength !== null &&
    matchingPresentations([presentation], form, said.strength).length === 0
  ) {
    return null;
  }
  const range = RANGE.test(presentation.concentration);
  return {
    form,
    // PR-115. The cuadro's own figure; a range copied to the line would
    // print «1 mg - 5 mg», so a range takes the figure the note wrote.
    concentration: range ? said.strength : presentation.concentration,
    route: presentation.route ?? null,
  };
}

/**
 * The cuadro's route (`O - Oral`) in the receta's codes. Parenteral says
 * neither vein nor muscle, so it is not guessed.
 */
const ROUTE_OF_CUADRO: Readonly<Record<string, MedicationRoute>> = {
  O: 'ORAL',
  R: 'RECTAL',
  T: 'TOPICAL',
  V: 'VAGINAL',
  I: 'INHALATION',
  'I/N': 'INHALATION',
  Oc: 'OPHTHALMIC',
};

export function routeOfCuadro(route: string | null): MedicationRoute | null {
  if (route === null) return null;
  return ROUTE_OF_CUADRO[route.split(' - ')[0]?.trim() ?? ''] ?? null;
}

/**
 * AS-067. The units that are counted whole: SigmAI E-053 measured the total
 * as dose × doses a day × days for them (91,9 % of daily tablets) and 0 %
 * for a liquid, which goes by the bottle.
 */
const COUNTABLE: ReadonlySet<DoseUnit> = new Set<DoseUnit>([
  'TABLET',
  'CAPSULE',
  'SUPPOSITORY',
  'OVULE',
  'PATCH',
  'SACHET',
]);

/** AS-067. Doses a day of each frequency with a fixed interval. */
const DOSES_A_DAY: Readonly<Partial<Record<Frequency, number>>> = {
  EVERY_4_HOURS: 6,
  EVERY_6_HOURS: 4,
  EVERY_8_HOURS: 3,
  EVERY_12_HOURS: 2,
  ONCE_DAILY: 1,
  AT_BEDTIME: 1,
  ONCE_WEEKLY: 1 / 7,
};

/**
 * AS-068 (D-084 §5). A dose written by weight or body surface: nothing is
 * calculated from it, and the weight is never read for this.
 */
const BY_WEIGHT =
  /\b(?:mg|mcg|ug|g|ml|ui|unidades?)\s*\/\s*(?:kg|m2|m²)\b|\bpor\s+(?:kilo|kg|kilogramo)s?\b|\/\s*kg\b/i;

export function writtenByWeight(...texts: (string | null)[]): boolean {
  return texts.some((text) => text !== null && BY_WEIGHT.test(foldText(text)));
}

/** AS-067. The fields the system filled in and nobody wrote. */
export type UnsaidField = 'presentation' | 'route' | 'dose' | 'quantity';

/** The receta's fields of a proposed line, in its codes. */
export interface ProposedFields {
  form: DosageForm | null;
  concentration: string | null;
  route: MedicationRoute | null;
  doseAmount: number | null;
  doseUnit: DoseUnit | null;
  frequency: Frequency | null;
  frequencyText: string | null;
  durationDays: number | null;
  quantity: number | null;
}

/**
 * AS-066 to AS-068. The fields of a line with a medicine of the cuadro: what
 * the note wrote, then what the presentation gives, then what is counted —
 * each one the system filled marked «Nadie lo dijo». Nothing else is filled.
 */
export function proposedFields(
  line: BackedLine,
  chosen: ChosenPresentation | null,
): { fields: ProposedFields; unsaid: UnsaidField[]; doseByWeight: boolean } {
  const unsaid: UnsaidField[] = [];
  const doseByWeight = writtenByWeight(
    line.quote,
    line.strength,
    line.instructions,
  );

  if (chosen && line.strength === null) unsaid.push('presentation');
  const form = chosen?.form ?? line.form;

  let route = line.route;
  if (route === null && chosen) {
    route = routeOfCuadro(chosen.route);
    if (route !== null) unsaid.push('route');
  }

  let doseAmount = doseByWeight ? null : line.doseAmount;
  let doseUnit = doseByWeight ? null : line.doseUnit;
  // SigmAI `per-dose.ts`: «500 mg» of a 500 mg tablet is one tablet. Exact
  // equality only: 5 mg of a 10 mg tablet is half, and is not guessed.
  const unit = form === null ? null : DOSAGE_FORMS[form].unit;
  if (
    !doseByWeight &&
    doseAmount === null &&
    chosen?.concentration != null &&
    line.strength !== null &&
    unit !== null &&
    sameStrength(line.strength, chosen.concentration)
  ) {
    doseAmount = 1;
    doseUnit = unit;
    unsaid.push('dose');
  }

  const quantity = doseByWeight
    ? null
    : totalOf(doseAmount, doseUnit, line.frequency, line.durationDays);
  if (quantity !== null) unsaid.push('quantity');

  return {
    fields: {
      form,
      concentration: chosen?.concentration ?? null,
      route,
      doseAmount,
      doseUnit,
      frequency: line.frequency,
      // PR-102. A code or a text, never both.
      frequencyText: line.frequency === null ? line.frequencyText : null,
      // PR-105. «Dosis única» does not last.
      durationDays: line.frequency === 'SINGLE_DOSE' ? null : line.durationDays,
      quantity,
    },
    unsaid,
    doseByWeight,
  };
}

/**
 * AS-067. Dose × doses a day × days, rounded up, only for a counted unit and
 * a frequency of the list with a fixed interval; «Dosis única» is one dose.
 */
export function totalOf(
  doseAmount: number | null,
  doseUnit: DoseUnit | null,
  frequency: Frequency | null,
  durationDays: number | null,
): number | null {
  if (doseAmount === null || doseAmount <= 0) return null;
  if (doseUnit === null || !COUNTABLE.has(doseUnit)) return null;
  if (frequency === 'SINGLE_DOSE') return Math.ceil(doseAmount - 1e-9);
  const perDay = frequency === null ? undefined : DOSES_A_DAY[frequency];
  if (perDay === undefined || durationDays === null || durationDays <= 0) {
    return null;
  }
  return Math.ceil(doseAmount * perDay * durationDays - 1e-9);
}

function sameStrength(written: string, declared: string): boolean {
  const normal = (value: string) =>
    foldText(value).replace(/\s+/g, '').replace(/,/g, '.');
  return normal(written) === normal(declared);
}

/**
 * AS-072, AS-074 (D-243 §5). A line as one text: what is proposed and what
 * was saved are compared this way, field by field in a fixed order.
 */
export function canonicalLine(
  conceptId: string | null,
  fields: ProposedFields,
): string {
  const figure = (value: number | null) =>
    value === null ? '' : String(Number(value.toFixed(4)));
  return [
    conceptId ?? '',
    fields.form ?? '',
    (fields.concentration ?? '').trim(),
    fields.route ?? '',
    `${figure(fields.doseAmount)} ${fields.doseUnit ?? ''}`.trim(),
    fields.frequency ?? (fields.frequencyText ?? '').trim(),
    figure(fields.durationDays),
    figure(fields.quantity),
  ].join(' | ');
}

/** AS-069. What the allergy rule says of one line. */
export type AllergyVerdict = 'exact' | 'class' | 'none' | 'failed';

/**
 * AS-069. The SAME rule the issue applies (PR-060, PR-065, PR-114): exact by
 * code, codes replaced and active substance; else the same ATC class.
 */
export function allergyVerdictOf(
  conceptId: string,
  allergies: readonly KnownAllergy[],
  keys: SubstanceKeys,
): Exclude<AllergyVerdict, 'failed'> {
  const lines = [{ line: 1, conceptId }];
  if (exactAllergyMatches(lines, allergies, keys).length > 0) return 'exact';
  if (therapeuticClassMatches(lines, allergies, keys).length > 0) {
    return 'class';
  }
  return 'none';
}

/** AS-065, AS-071, AS-072, AS-073. Why a line cannot go to the receta. */
export type LineBlock =
  | 'not-in-cnmb'
  | 'controlled'
  | 'already-prescribed'
  | 'allergy-exact'
  | 'allergy-check-failed';

/** AS-072. What is kept of a line in `ai_suggestion.proposal`. */
export interface PrescriptionProposal {
  quote: string;
  section: string;
  /** The medicine of the cuadro; null shows only the sentence (AS-065). */
  medicine: { conceptId: string; code: string; display: string } | null;
  controlled: boolean;
  fields: ProposedFields;
  instructions: string | null;
  unsaid: UnsaidField[];
  doseByWeight: boolean;
  /** AS-074. The line as one text, compared with the line saved. */
  text: string;
  /** AS-029. Written by the fake of the demonstration mode. */
  demo: boolean;
}

/**
 * AS-065, AS-071, AS-072, AS-073. Why the line may not go to the receta now,
 * or null. Checked in this order: the one the physician can do least about
 * first.
 */
export function blockOf(
  proposal: PrescriptionProposal,
  now: { prescribed: ReadonlySet<string>; allergy: AllergyVerdict },
): LineBlock | null {
  if (proposal.medicine === null) return 'not-in-cnmb';
  if (proposal.controlled) return 'controlled';
  if (now.allergy === 'failed') return 'allergy-check-failed';
  if (now.allergy === 'exact') return 'allergy-exact';
  if (now.prescribed.has(proposal.medicine.code)) return 'already-prescribed';
  return null;
}
