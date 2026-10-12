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
 * AS-063. Words that, right before a medicine, say the note does NOT
 * prescribe it today: it is suspended, the patient already takes it, or is
 * allergic to it (clinical review of 12-10-2026). Folded.
 */
const NOT_PRESCRIBED = new Set([
  'suspende',
  'suspender',
  'suspendido',
  'suspendida',
  'suspenda',
  'retira',
  'retirar',
  'retirado',
  'toma',
  'tomando',
  'habitualmente',
  'previamente',
  'alergia',
  'alergico',
  'alergica',
]);

/** Spanish number words a physician writes for a dose or a length. */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  media: 0.5,
  medio: 0.5,
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  doce: 12,
  catorce: 14,
  quince: 15,
  veinte: 20,
  treinta: 30,
};

/** Every figure a sentence writes, in digits or in words. */
function figuresIn(sentence: string): Set<number> {
  const folded = foldText(sentence);
  const figures = new Set<number>();
  for (const [digits] of folded.matchAll(/\d+(?:[.,]\d+)?/g)) {
    figures.add(Number(digits.replace(',', '.')));
  }
  for (const word of folded.split(/[^\p{L}]+/u)) {
    const value = NUMBER_WORDS[word];
    if (value !== undefined) figures.add(value);
  }
  return figures;
}

/**
 * AS-063 (G2 of the clinical review). What says each frequency of the list,
 * folded. A code the sentence does not back is not a reading: it is empty.
 */
const FREQUENCY_SAID: Readonly<Record<Frequency, RegExp>> = {
  EVERY_4_HOURS: /\b(?:4|cuatro)\s*(?:horas|h)\b/,
  EVERY_6_HOURS: /\b(?:6|seis)\s*(?:horas|h)\b/,
  EVERY_8_HOURS: /\b(?:8|ocho)\s*(?:horas|h)\b/,
  EVERY_12_HOURS: /\b(?:12|doce)\s*(?:horas|h)\b/,
  ONCE_DAILY:
    /\b(?:al dia|diari[oa]s?|cada dia|una vez|cada 24 horas|cada manana|en la manana|en ayunas|cada noche|en la noche|por dia)\b/,
  AT_BEDTIME: /\b(?:dormir|acostarse|noche)\b/,
  ONCE_WEEKLY: /\b(?:por|a la|cada) semana\b|\bsemanal/,
  SINGLE_DOSE: /\b(?:dosis unica|unica dosis|una sola (?:dosis|vez)|stat)\b/,
};

/**
 * Whether the sentence says that frequency. A daily one is never backed by a
 * sentence that speaks of weeks: «una vez por semana» read as «una vez al
 * día» is seven times the dose (methotrexate, clinical review G2).
 */
function frequencySaid(frequency: Frequency | null, sentence: string): boolean {
  if (frequency === null) return false;
  const folded = foldText(sentence);
  // «por semana», «a la semana», «semanal»: a weekly rhythm, not a length.
  if (
    frequency !== 'ONCE_WEEKLY' &&
    /\b(?:por|a la|cada) semana\b|\bsemanal/.test(folded)
  ) {
    return false;
  }
  return FREQUENCY_SAID[frequency].test(folded);
}

/** The longest word of a name: what has to be in the sentence that backs it. */
function headWord(name: string): string {
  return (
    foldText(name)
      .split(/[^\p{L}]+/u)
      .filter((word) => word.length >= 4)
      .sort((a, b) => b.length - a.length)[0] ?? ''
  );
}

const hasWord = (text: string, word: string) =>
  word !== '' && new RegExp(`(^|[^\\p{L}])${word}`, 'u').test(foldText(text));

/**
 * AS-063, AS-066 (G2). A line read by the model, every field checked against
 * the sentence that backs it: the medicine named there, each figure written
 * there, the frequency said there, and free text the note itself writes.
 * What the sentence does not back is emptied — never shown as «said».
 */
export function backedFields(
  line: ReadLine,
  sentence: string,
  note: string,
): ReadLine | null {
  if (!hasWord(sentence, headWord(line.drug))) return null;
  const figures = figuresIn(sentence);
  const backed = (value: number | null) =>
    value !== null && figures.has(value) ? value : null;
  const strengthBacked =
    line.strength !== null &&
    [...foldText(line.strength).matchAll(/\d+(?:[.,]\d+)?/g)].every(([n]) =>
      figures.has(Number(n.replace(',', '.'))),
    ) &&
    /\d/.test(line.strength);
  const weeks = /\b(\d+|una|dos|tres|cuatro)\s+semanas?\b/.exec(foldText(sentence)); // prettier-ignore
  const weeksAsDays = weeks
    ? 7 * (/^\d+$/.test(weeks[1]!) ? Number(weeks[1]) : NUMBER_WORDS[weeks[1]!]!) // prettier-ignore
    : null;
  const inNote = (text: string | null) =>
    text !== null && text.trim() !== '' && foldText(note).includes(foldText(text)) // prettier-ignore
      ? text.trim()
      : null;
  return {
    ...line,
    strength: strengthBacked ? line.strength : null,
    doseAmount: backed(line.doseAmount),
    durationDays:
      line.durationDays !== null && line.durationDays === weeksAsDays
        ? line.durationDays
        : backed(line.durationDays),
    frequency: frequencySaid(line.frequency, sentence) ? line.frequency : null,
    frequencyText: inNote(line.frequencyText),
    instructions: inNote(line.instructions),
  };
}

/**
 * AS-063. Keeps the lines whose phrase is in the cleared text the model read
 * AND, with the placeholders put back, in the note itself as whole words and
 * not denied there — the rule of AS-028, with the receta's own denials
 * («suspende», «ya toma», «alérgico a») — and whose every field the sentence
 * backs (`backedFields`). A line without its phrase, or whose medicine the
 * sentence does not name, is a line nobody wrote: dropped, and counted.
 */
export function backedLines(input: {
  read: readonly ReadLine[];
  cleared: string;
  sections: readonly { key: string; text: string }[];
  restore: (text: string) => string;
}): { kept: BackedLine[]; dropped: number } {
  const cleared = foldText(input.cleared);
  const note = input.sections.map((section) => section.text).join('\n');
  const kept: BackedLine[] = [];
  for (const line of input.read) {
    if (!cleared.includes(foldText(line.quote))) continue;
    const drug = input.restore(line.drug).trim();
    if (drug === '') continue;
    const located = locateQuote(input.restore(line.quote).trim(), input.sections, NOT_PRESCRIBED); // prettier-ignore
    if (!located) continue;
    const restored: ReadLine = {
      ...line,
      drug,
      instructions:
        line.instructions === null ? null : input.restore(line.instructions),
      frequencyText:
        line.frequencyText === null ? null : input.restore(line.frequencyText),
    };
    const fields = backedFields(restored, located.sentence, note);
    if (!fields) continue;
    kept.push({ ...fields, quote: located.sentence, section: located.section });
  }
  return { kept, dropped: input.read.length - kept.length };
}

/**
 * AS-064 (m3 of the clinical review). The medicine the model chose is the
 * one the sentence writes: the head word of each component of its name
 * («Amoxicilina + ácido clavulánico» needs «clavulánico» too). A plain
 * «amoxicilina» does not become the combination.
 */
export function chosenIsWritten(display: string, sentence: string): boolean {
  return display
    .split('+')
    .every((component) => hasWord(sentence, headWord(component)));
}

/**
 * AS-064. The name the cuadro is searched by: a combination written «con» or
 * «y» is written «+» in the cuadro («Amoxicilina + ácido clavulánico»), so
 * the search would find nothing (measured 12-10-2026, AS-079).
 */
export function cnmbSearchName(drug: string): string {
  return drug
    .replace(/\s+(?:con|y|más|mas)\s+/gi, ' + ')
    .replace(/\s*\/\s*/g, ' + ')
    .trim();
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
 * AS-066. A combination as it is written in Ecuador, «500/125 mg», as the
 * cuadro writes it, «500 mg + 125 mg» (measured 12-10-2026 with Gemini).
 * Only figures over figures before ONE unit: «250 mg/5 mL» is a strength per
 * volume and stays as it is.
 */
export function cuadroStrength(written: string): string {
  const combined = /^\s*(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)\s*(mg|mcg|g)\s*$/i.exec(written); // prettier-ignore
  if (!combined) return written;
  const [, first, second, unit] = combined;
  return `${first} ${unit!.toLowerCase()} + ${second} ${unit!.toLowerCase()}`;
}

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
  const strength = said.strength === null ? null : cuadroStrength(said.strength); // prettier-ignore
  const admitted = presentation.forms ?? [presentation.form];
  if (said.form !== null && !admitted.includes(said.form)) return null;
  const form = (said.form ?? presentation.form) as DosageForm;
  if (!Object.hasOwn(DOSAGE_FORMS, form)) return null;
  if (
    strength !== null &&
    matchingPresentations([presentation], form, strength).length === 0
  ) {
    return null;
  }
  const range = RANGE.test(presentation.concentration);
  return {
    form,
    // PR-115. The cuadro's own figure; a range copied to the line would
    // print «1 mg - 5 mg», so a range takes the figure the note wrote.
    concentration: range ? strength : presentation.concentration,
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
 * AS-068 (D-084 §5; G1 of the clinical review). A dose written by weight or
 * body surface, in any of the ways it is written: «mg/kg», «mg/kilo»,
 * «mg x kg», «mg/kgr», «mg/k», «por kilo», «mg/m²», «m2sc», «superficie
 * corporal». Read compatibly decomposed so «²» is «2».
 */
const BY_WEIGHT = [
  /(?:mg|mcg|ug|g|ml|ui|u|unidades?|gotas?)\s*(?:\/|x|por|por cada)\s*(?:kg|kgr|kilos?|kilogramos?|k|m2|m 2)(?![a-z])/,
  /(?:\/|\bpor\b|\bx\b)\s*(?:kg|kgr|kilos?|kilogramos?)(?![a-z])/,
  /\bm2\s*(?:sc|s\.c\.)?(?![a-z0-9])/,
  /superficie corporal/,
];

const plain = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');

export function writtenByWeight(...texts: (string | null)[]): boolean {
  return texts.some(
    (text) => text !== null && BY_WEIGHT.some((rule) => rule.test(plain(text))),
  );
}

/** Units in which a dose by weight is written: never taken from a note that doses by weight. */
const MASS_UNITS: ReadonlySet<DoseUnit> = new Set<DoseUnit>([
  'MILLIGRAM',
  'MICROGRAM',
  'GRAM',
  'INTERNATIONAL_UNIT',
  'MILLILITRE',
]);

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
  /** The whole note: a dose by weight written elsewhere still counts (G1). */
  note = '',
): { fields: ProposedFields; unsaid: UnsaidField[]; doseByWeight: boolean } {
  const unsaid: UnsaidField[] = [];
  const doseByWeight =
    writtenByWeight(line.quote, line.strength, line.instructions, line.frequencyText) || // prettier-ignore
    (writtenByWeight(note) &&
      line.doseUnit !== null &&
      MASS_UNITS.has(line.doseUnit));

  // The system chose the presentation or its form: marked (m10).
  if (chosen && (line.strength === null || line.form === null)) {
    unsaid.push('presentation');
  }
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
