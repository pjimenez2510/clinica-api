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
 * PR-101, PR-103. The pharmaceutical form, with the unit a dose of it is
 * ordinarily counted in — the proposal the screen preselects.
 */
export const DOSAGE_FORMS = {
  TABLET: { label: 'Tableta', unit: 'TABLET' },
  COATED_TABLET: { label: 'Tableta recubierta', unit: 'TABLET' },
  CHEWABLE_TABLET: { label: 'Tableta masticable', unit: 'TABLET' },
  CAPSULE: { label: 'Cápsula', unit: 'CAPSULE' },
  ORAL_SUSPENSION: { label: 'Suspensión oral', unit: 'MILLILITRE' },
  POWDER_FOR_ORAL_SUSPENSION: { label: 'Polvo para suspensión oral', unit: 'MILLILITRE' }, // prettier-ignore
  SYRUP: { label: 'Jarabe', unit: 'MILLILITRE' },
  ORAL_SOLUTION: { label: 'Solución oral', unit: 'MILLILITRE' },
  ORAL_DROPS: { label: 'Gotas orales', unit: 'DROP' },
  GRANULES: { label: 'Granulado', unit: 'SACHET' },
  INJECTABLE_SOLUTION: { label: 'Solución inyectable', unit: 'AMPOULE' },
  POWDER_FOR_INJECTION: { label: 'Polvo para solución inyectable', unit: 'AMPOULE' }, // prettier-ignore
  CREAM: { label: 'Crema', unit: 'APPLICATION' },
  OINTMENT: { label: 'Ungüento', unit: 'APPLICATION' },
  GEL: { label: 'Gel', unit: 'APPLICATION' },
  LOTION: { label: 'Loción', unit: 'APPLICATION' },
  EYE_DROPS: { label: 'Solución oftálmica', unit: 'DROP' },
  EYE_OINTMENT: { label: 'Ungüento oftálmico', unit: 'APPLICATION' },
  EAR_DROPS: { label: 'Gotas óticas', unit: 'DROP' },
  NASAL_SPRAY: { label: 'Aerosol nasal', unit: 'SPRAY' },
  INHALER: { label: 'Aerosol para inhalación', unit: 'PUFF' },
  NEBULISER_SOLUTION: { label: 'Solución para nebulizar', unit: 'MILLILITRE' },
  SUPPOSITORY: { label: 'Supositorio', unit: 'SUPPOSITORY' },
  VAGINAL_OVULE: { label: 'Óvulo vaginal', unit: 'OVULE' },
  VAGINAL_CREAM: { label: 'Crema vaginal', unit: 'APPLICATION' },
  TRANSDERMAL_PATCH: { label: 'Parche transdérmico', unit: 'PATCH' },
} as const satisfies Record<string, { label: string; unit: DoseUnit }>;

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
  form: string;
  concentration: string;
}

/**
 * PR-104. Whether the line is in one of the presentations its concept
 * declares. A concept that declares none admits any — the official CNMB is
 * not loaded yet, and refusing every line would stop prescribing altogether.
 */
export function isDeclaredPresentation(
  declared: readonly DeclaredPresentation[],
  form: string | null,
  concentration: string | null,
): boolean {
  if (declared.length === 0) return true;
  const normal = (value: string | null) =>
    (value ?? '').toLowerCase().replace(/\s+/g, '');
  return declared.some(
    (presentation) =>
      normal(presentation.form) === normal(form) &&
      normal(presentation.concentration) === normal(concentration),
  );
}
