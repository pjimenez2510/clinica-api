/**
 * PR-101 to PR-103. The closed lists a prescription line is written with, and
 * the sentence each one prints.
 *
 * Art. 13 wants the electronic prescription «sin siglas o abreviaturas»: the
 * CODE is what travels in the API and what is stored beside the text, and the
 * text is what the document carries. A free-text box produces «tab», «comp.»
 * and «tabletas» as three forms, and the abbreviation the norm forbids is the
 * one everybody types.
 *
 * The lists themselves are vocabulary, not clinical policy: what was decided
 * and why is in `DECISIONES-TOMADAS-POR-EL-AGENTE.md` (D-117).
 */

/** A dose unit as the document prints it, «1 tableta» or «2 tabletas». */
interface UnitWords {
  one: string;
  many: string;
}

/** PR-101. The unit a dose is counted in. */
export const DOSE_UNITS = {
  TABLET: { one: 'tableta', many: 'tabletas' },
  CAPSULE: { one: 'cápsula', many: 'cápsulas' },
  MILLILITRE: { one: 'mililitro', many: 'mililitros' },
  DROP: { one: 'gota', many: 'gotas' },
  MILLIGRAM: { one: 'miligramo', many: 'miligramos' },
  GRAM: { one: 'gramo', many: 'gramos' },
  MICROGRAM: { one: 'microgramo', many: 'microgramos' },
  INTERNATIONAL_UNIT: { one: 'unidad internacional', many: 'unidades internacionales' }, // prettier-ignore
  APPLICATION: { one: 'aplicación', many: 'aplicaciones' },
  PUFF: { one: 'inhalación', many: 'inhalaciones' },
  SPRAY: { one: 'pulverización', many: 'pulverizaciones' },
  SUPPOSITORY: { one: 'supositorio', many: 'supositorios' },
  OVULE: { one: 'óvulo', many: 'óvulos' },
  PATCH: { one: 'parche', many: 'parches' },
  SACHET: { one: 'sobre', many: 'sobres' },
  AMPOULE: { one: 'ampolla', many: 'ampollas' },
} as const satisfies Record<string, UnitWords>;

export type DoseUnit = keyof typeof DOSE_UNITS;
export const DOSE_UNIT_CODES = Object.keys(DOSE_UNITS) as DoseUnit[];

/**
 * PR-101, PR-103. The pharmaceutical form and, ONLY where the form implies it
 * without doubt, the unit a dose of it is counted in — the proposal the screen
 * preselects. A tablet is counted in tablets; a suspension may be dosed in
 * millilitres or in milligrams, an injectable in ampoules or in units, and a
 * proposal there is a default somebody fails to change («10 ampollas» of
 * insulin). Clinical review of 04-10-2026 (G3); D-117.7.
 */
export const DOSAGE_FORMS = {
  TABLET: { label: 'Tableta', unit: 'TABLET' },
  COATED_TABLET: { label: 'Tableta recubierta', unit: 'TABLET' },
  // PR-115. Forms the CNMB tells apart and a receta has to say.
  EXTENDED_RELEASE_TABLET: { label: 'Tableta de liberación prolongada', unit: 'TABLET' }, // prettier-ignore
  SUBLINGUAL_TABLET: { label: 'Tableta sublingual', unit: 'TABLET' },
  DISPERSIBLE_TABLET: { label: 'Tableta dispersable', unit: 'TABLET' },
  GASTRORESISTANT_CAPSULE: { label: 'Cápsula gastrorresistente', unit: 'CAPSULE' }, // prettier-ignore
  CHEWABLE_TABLET: { label: 'Tableta masticable', unit: 'TABLET' },
  CAPSULE: { label: 'Cápsula', unit: 'CAPSULE' },
  ORAL_SUSPENSION: { label: 'Suspensión oral', unit: null },
  POWDER_FOR_ORAL_SUSPENSION: { label: 'Polvo para suspensión oral', unit: null }, // prettier-ignore
  SYRUP: { label: 'Jarabe', unit: null },
  ORAL_SOLUTION: { label: 'Solución oral', unit: null },
  ORAL_DROPS: { label: 'Gotas orales', unit: null },
  GRANULES: { label: 'Granulado', unit: 'SACHET' },
  INJECTABLE_SOLUTION: { label: 'Solución inyectable', unit: null },
  POWDER_FOR_INJECTION: { label: 'Polvo para solución inyectable', unit: null }, // prettier-ignore
  LIPID_POWDER_FOR_INJECTION: { label: 'Polvo para solución inyectable, formulación lipídica', unit: null }, // prettier-ignore
  NANOPARTICLE_INJECTION: { label: 'Polvo para suspensión inyectable de nanopartículas', unit: null }, // prettier-ignore
  EXTENDED_RELEASE_INJECTION: { label: 'Polvo para suspensión inyectable de liberación prolongada', unit: null }, // prettier-ignore
  SUBDERMAL_IMPLANT: { label: 'Implante subdérmico', unit: null },
  CREAM: { label: 'Crema', unit: null },
  OINTMENT: { label: 'Ungüento', unit: null },
  GEL: { label: 'Gel', unit: null },
  LOTION: { label: 'Loción', unit: null },
  EYE_DROPS: { label: 'Solución oftálmica', unit: null },
  EYE_OINTMENT: { label: 'Ungüento oftálmico', unit: null },
  EAR_DROPS: { label: 'Gotas óticas', unit: null },
  NASAL_SPRAY: { label: 'Aerosol nasal', unit: null },
  INHALER: { label: 'Aerosol para inhalación', unit: null },
  NEBULISER_SOLUTION: { label: 'Solución para nebulizar', unit: null },
  SUPPOSITORY: { label: 'Supositorio', unit: 'SUPPOSITORY' },
  VAGINAL_OVULE: { label: 'Óvulo vaginal', unit: 'OVULE' },
  VAGINAL_CREAM: { label: 'Crema vaginal', unit: null },
  TRANSDERMAL_PATCH: { label: 'Parche transdérmico', unit: 'PATCH' },
} as const satisfies Record<string, { label: string; unit: DoseUnit | null }>;

export type DosageForm = keyof typeof DOSAGE_FORMS;
export const DOSAGE_FORM_CODES = Object.keys(DOSAGE_FORMS) as DosageForm[];

/**
 * PR-102. The usual frequencies. Not a closed list: a frequency the list does
 * not have is written as text, and the code is then absent.
 */
export const FREQUENCIES = {
  EVERY_4_HOURS: 'Cada 4 horas',
  EVERY_6_HOURS: 'Cada 6 horas',
  EVERY_8_HOURS: 'Cada 8 horas',
  EVERY_12_HOURS: 'Cada 12 horas',
  ONCE_DAILY: 'Una vez al día',
  AT_BEDTIME: 'Una vez al día, antes de dormir',
  ONCE_WEEKLY: 'Una vez por semana',
  SINGLE_DOSE: 'Dosis única',
} as const;

export type Frequency = keyof typeof FREQUENCIES;
export const FREQUENCY_CODES = Object.keys(FREQUENCIES) as Frequency[];

/** PR-101. The form as the document prints it. */
export function dosageFormLabel(form: DosageForm): string {
  return DOSAGE_FORMS[form].label;
}

/**
 * PR-101. The dose as the document prints it: «1 tableta», «2,5 mililitros».
 * The figure takes the Ecuadorian decimal comma, as the quantity in words
 * reads it (PR-030), and «1» is the only amount that takes the singular.
 */
export function doseText(amount: number, unit: DoseUnit): string {
  const words = DOSE_UNITS[unit];
  const figure = String(amount).replace('.', ',');
  return `${figure} ${amount === 1 ? words.one : words.many}`;
}

/** PR-102. The frequency text: the list's sentence, or what was written. */
export function frequencyText(
  code: Frequency | null,
  written: string | null,
): string {
  return code === null ? (written ?? '').trim() : FREQUENCIES[code];
}

/**
 * PR-104. One presentation a CNMB concept declares: a form and a
 * concentration. Compared without regard to case or spacing, so «10 mg» and
 * «10mg» are the same presentation.
 */
export interface DeclaredPresentation {
  /** The form a choice of this presentation proposes. */
  form: string;
  /**
   * PR-115. The DCI of this presentation when the cuadro gives one: it may
   * differ from the medicine's name (`Haloperidol decanoato`), and it is what
   * the receta prints.
   */
  dci?: string;
  concentration: string;
  /**
   * PR-115. Every form of the vocabulary this presentation admits, when the
   * catalogue names a family of them («Sólido oral»: tableta, cápsula…).
   * Absent, only `form` is admitted; empty, none is.
   */
  forms?: readonly string[];
  /** PR-115. The form as the cuadro names it, for the picker. */
  label?: string;
}

/**
 * PR-115. The presentations the line IS: those whose forms admit its form and
 * whose concentration it states. Usually one; it names the DCI to print.
 */
export function matchingPresentations(
  declared: readonly DeclaredPresentation[],
  form: string | null,
  concentration: string | null,
): DeclaredPresentation[] {
  // «62,5» and «62.5», «µg» and «mcg» are the same concentration.
  const normal = (value: string | null) =>
    (value ?? '')
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/,/g, '.')
      .replace(/µg/g, 'mcg');
  return declared.filter((presentation) => {
    const admitsForm = (presentation.forms ?? [presentation.form]).some(
      (admitted) => admitted !== '' && normal(admitted) === normal(form),
    );
    if (!admitsForm) return false;
    const declaredText = presentation.concentration.trim();
    // PR-115. «-»: the cuadro declares no strength, and only the form counts.
    if (declaredText === '-') return true;
    // PR-115. A composition described in prose is not a figure to compare.
    if (declaredText.length > DESCRIBED_COMPOSITION) return true;
    /**
     * PR-115. A range of the cuadro admits the amounts inside it — in its
     * unit or in the aside's («2000 UI - 10.000 UI (20 mg - 100 mg)») — and
     * only those: a line that copies the range would print «1 mg - 5 mg» of
     * warfarin, and is outside.
     */
    const ranges = rangesOf(declaredText);
    if (ranges.length > 0) {
      const amount = amountOf(concentration ?? '');
      return ranges.some(
        (range) =>
          amount !== null &&
          amount.unit === range.unit &&
          amount.value >= range.min &&
          amount.value <= range.max,
      );
    }
    // A range that cannot be read («25 mcg + (50 mcg - 250 mcg)») is never
    // matched by copying it: the receta would print a range.
    if (/\s-\s/.test(declaredText)) return false;
    return normal(declaredText) === normal(concentration);
  });
}

/**
 * PR-104, PR-115. Whether the line is in one of the presentations its concept
 * declares. A concept that declares none admits any.
 */
export function isDeclaredPresentation(
  declared: readonly DeclaredPresentation[],
  form: string | null,
  concentration: string | null,
): boolean {
  return (
    declared.length === 0 ||
    matchingPresentations(declared, form, concentration).length > 0
  );
}

/**
 * PR-115. Longer than this, the cuadro describes a composition («Glucosa
 * 13,5 g/L - 20 g/L Cloruro de Sodio …») rather than stating a strength,
 * and it does not fit the line's concentration (80 characters) either.
 */
export const DESCRIBED_COMPOSITION = 80;

/**
 * An Ecuadorian figure: «1,5», «1.200.000», «2'400.000». A dot followed by
 * three digits groups thousands; a comma is the decimal mark.
 */
function figureOf(text: string): number | null {
  const plain = text.replace(/'/g, '');
  if (!/^\d+([.,]\d+)*$/.test(plain)) return null;
  const grouped = plain.includes(',')
    ? plain.replace(/\./g, '').replace(',', '.')
    : /^\d+(\.\d{3})+$/.test(plain)
      ? plain.replace(/\./g, '')
      : plain;
  const value = Number(grouped);
  return Number.isFinite(value) ? value : null;
}

/** «UI», «Ul» (an erratum of the cuadro for UI) and «µg» written one way. */
const unitOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/µg/g, 'mcg')
    .replace(/^ul/, 'ui');

/** PR-115. «850 mg» → 850 «mg»; anything else, nothing. */
export function amountOf(text: string): { value: number; unit: string } | null {
  const match = /^\s*([\d.,']+)\s*([^\d\s][^-]*?)\s*$/.exec(text);
  const value = match ? figureOf(match[1]!) : null;
  return match && value !== null ? { value, unit: unitOf(match[2]!) } : null;
}

/**
 * PR-115. «500 mg - 1000 mg» → 500 to 1000 «mg». Only a range of one
 * strength with the same unit at both ends; anything else, nothing.
 */
export function rangeOf(
  text: string,
): { min: number; max: number; unit: string } | null {
  // «… (equivalente a hierro elemental)», «(20 mg - 100 mg)»: an aside.
  const [low, high, ...rest] = text
    .replace(/\s*\([^)]*\)\s*$/, '')
    .split(/\s+-\s+/);
  if (!low || !high || rest.length > 0) return null;
  const to = amountOf(high);
  // «25 - 50 mg/5 mL»: a bare figure takes the unit of the other end.
  const bare = figureOf(low.trim());
  const from =
    amountOf(low) ?? (bare !== null && to ? { value: bare, unit: to.unit } : null); // prettier-ignore
  if (!from || !to || from.unit !== to.unit || from.value > to.value)
    return null;
  return { min: from.value, max: to.value, unit: from.unit };
}

/**
 * PR-115. The range a concentration declares and, when it has one, the range
 * of its aside in parentheses — the same strength in another unit.
 */
export function rangesOf(
  text: string,
): { min: number; max: number; unit: string }[] {
  const main = rangeOf(text);
  if (!main) return [];
  const aside = /\(([^)]*)\)\s*$/.exec(text)?.[1];
  const other = aside ? rangeOf(aside) : null;
  return other ? [main, other] : [main];
}
