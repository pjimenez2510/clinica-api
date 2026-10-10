/**
 * EN-090 to EN-093, EN-097. The program blocks of the RDACAA form that any
 * key holder of the record reads: G (obstetric data and the laboratory of
 * pregnant women), H (SIVAN) and I (vaccines). Block J, the HIV test, has its
 * own file and its own door (`hiv-test.ts`, EN-095).
 *
 * Which block an attention takes is a function of facts the attention already
 * has, and this file holds those rules as pure functions:
 *
 *  - G: the chart's PREGNANT record in force on the clinical date (EN-063's
 *    rule, read live until EN-099 has a catalogue, D-134.3 §2). The adapter
 *    answers it with the database's own `encounter_is_pregnant`.
 *  - H: the FROZEN age (EN-008) in completed months, 8 or less; or a woman
 *    of 10 to 49, who is asked only her own lactation (EN-260).
 *  - I: always — «cuando se administre una vacuna» —, with the coherence of
 *    vaccine and risk group.
 *
 * ⚠️ THE DATABASE IS THE GUARANTEE: `trg_encounter_obstetric_applies`,
 * `trg_encounter_nutrition_applies` and `trg_encounter_vaccination_valid`
 * refuse what these functions refuse, with the same bounds. This copy is what
 * lets the service answer «which block, which question» before anything is
 * written and name the field; the integration tests try both sides of every
 * bound against the real database.
 */

import type { FrozenAge } from './dental-index';

// ═══════════════════════════════════════════════════════════════════════════
// G — DATOS OBSTÉTRICOS Y EXÁMENES DE LABORATORIO (EN-090, EN-091)
// ═══════════════════════════════════════════════════════════════════════════

/** Column 39: 1 bajo riesgo · 2 alto riesgo · 3 riesgo inminente. */
export const OBSTETRIC_RISKS = ['LOW', 'HIGH', 'IMMINENT'] as const;
export type ObstetricRisk = (typeof OBSTETRIC_RISKS)[number];

/** Column 43: 1 FUM · 2 ECO · 3 clínico. */
export const GESTATIONAL_AGE_METHODS = [
  'LMP',
  'ULTRASOUND',
  'CLINICAL',
] as const;
export type GestationalAgeMethod = (typeof GESTATIONAL_AGE_METHODS)[number];

/** Columns 46 to 48: (+) · (−) · SD, sin dato. */
export const SYPHILIS_RESULTS = ['POSITIVE', 'NEGATIVE', 'NO_DATA'] as const;
export type SyphilisResult = (typeof SYPHILIS_RESULTS)[number];

/** Column 49: sí · no · no se hizo. */
export const PARTNER_TREATMENTS = ['YES', 'NO', 'NOT_DONE'] as const;
export type PartnerTreatment = (typeof PARTNER_TREATMENTS)[number];

/** Column 50: normal · anormal · no se hizo. */
export const BACTERIURIA_RESULTS = ['NORMAL', 'ABNORMAL', 'NOT_DONE'] as const;
export type BacteriuriaResult = (typeof BACTERIURIA_RESULTS)[number];

/** «Desde la primera semana hasta las 42 semanas de gestación». */
export const GESTATIONAL_WEEKS = { min: 1, max: 42 } as const;

/** 42 weeks and 6 days: the oldest last menstrual period a pregnancy has. */
export const LMP_MAX_DAYS_BEFORE = 300;

/** EN-090, EN-091. Block G as it is recorded. */
export interface ObstetricAnswer {
  risk: ObstetricRisk;
  birthPlan: boolean;
  transportPlan: boolean;
  plannedPregnancy: boolean;
  gestationalAgeMethod: GestationalAgeMethod;
  /** `YYYY-MM-DD`, a calendar date: never an instant. */
  lastMenstrualPeriod: string | null;
  gestationalWeeks: number;
  nonTreponemalTest: SyphilisResult | null;
  treponemalTest: SyphilisResult | null;
  syphilisTreatment: SyphilisResult | null;
  partnerTreatment: PartnerTreatment | null;
  bacteriuria: BacteriuriaResult | null;
}

/** When a block was recorded, and when it was last corrected (EN-249). */
export interface BlockStamp {
  recordedAt: Date;
  editedAt: Date | null;
}

export type ObstetricRecord = ObstetricAnswer & BlockStamp;

/** Days between two calendar dates `YYYY-MM-DD`, in UTC so no zone moves them. */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

/**
 * EN-090. Where the last menstrual period cannot be, against the clinical
 * date of the attention: after it, or more than 300 days before it. `null`
 * when it can.
 */
export function lastMenstrualPeriodProblem(
  lmp: string,
  clinicalDate: string,
): 'AFTER_ATTENTION' | 'TOO_OLD' | null {
  const days = daysBetween(lmp, clinicalDate);
  if (days < 0) return 'AFTER_ATTENTION';
  if (days > LMP_MAX_DAYS_BEFORE) return 'TOO_OLD';
  return null;
}

/**
 * EN-090. The completed weeks since the last menstrual period, as the screen
 * proposes them (Naegele's count: days / 7, rounded down). `null` outside the
 * 1..42 the form admits — the person types them then.
 */
export function weeksSinceLastMenstrualPeriod(
  lmp: string,
  clinicalDate: string,
): number | null {
  const weeks = Math.floor(daysBetween(lmp, clinicalDate) / 7);
  return weeks >= GESTATIONAL_WEEKS.min && weeks <= GESTATIONAL_WEEKS.max
    ? weeks
    : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// H — SIVAN (EN-092)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * EN-092, EN-260. Who takes block H, and with which questions:
 *
 *  - an infant, by the frozen age in completed months: «sólo leche materna»
 *    from 0 to 5, «alimento sólido, semisólido o suave» from 6 to 8, and the
 *    mother's lactation (column 52) always;
 *  - a woman of 10 to 49 (the MSP's childbearing age), only column 52, her own
 *    lactation, optional (D-195.3).
 *
 * Anybody else, or with no frozen age, the block does not apply at all.
 */
export type NutritionBand =
  'EXCLUSIVE_BREASTFEEDING' | 'COMPLEMENTARY_FEEDING' | 'LACTATING_AGE_WOMAN';

/** EN-260. «Mujeres en edad fértil», in completed years. */
export const LACTATING_AGE_YEARS = { min: 10, max: 49 } as const;

export function nutritionBandOf(
  age: FrozenAge,
  sex: string,
): NutritionBand | null {
  const { ageYears: years, ageMonths: months } = age;
  if (years === null || months === null) return null;
  if (
    sex === 'FEMALE' &&
    years >= LACTATING_AGE_YEARS.min &&
    years <= LACTATING_AGE_YEARS.max
  ) {
    return 'LACTATING_AGE_WOMAN';
  }
  if (years > 0) return null;
  if (months <= 5) return 'EXCLUSIVE_BREASTFEEDING';
  if (months <= 8) return 'COMPLEMENTARY_FEEDING';
  return null;
}

/**
 * EN-092. Block H: column 52 always, and only the question of the infant's
 * band (53 or 54); the other one stays blank.
 */
export interface NutritionAnswer {
  motherBreastfeeding: boolean;
  exclusiveBreastfeeding: boolean | null;
  complementaryFeeding: boolean | null;
}

export type NutritionRecord = NutritionAnswer & BlockStamp;

/**
 * EN-092. What is wrong with an answer for this band: the band's question
 * left blank (`required`), or the other band's answered (`notApplicable`).
 */
export function nutritionProblem(
  band: NutritionBand,
  answer: NutritionAnswer,
): { field: keyof NutritionAnswer; kind: 'required' | 'notApplicable' } | null {
  if (band === 'LACTATING_AGE_WOMAN') {
    if (answer.exclusiveBreastfeeding !== null)
      return { field: 'exclusiveBreastfeeding', kind: 'notApplicable' };
    if (answer.complementaryFeeding !== null)
      return { field: 'complementaryFeeding', kind: 'notApplicable' };
    return null;
  }
  const own =
    band === 'EXCLUSIVE_BREASTFEEDING'
      ? 'exclusiveBreastfeeding'
      : 'complementaryFeeding';
  const other =
    band === 'EXCLUSIVE_BREASTFEEDING'
      ? 'complementaryFeeding'
      : 'exclusiveBreastfeeding';
  if (answer[other] !== null) return { field: other, kind: 'notApplicable' };
  if (answer[own] === null) return { field: own, kind: 'required' };
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// I — VACUNAS (EN-093)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Dosis administradas: 1 primera … 6 sexta · 7 dosis única. In the form's
 * order, so the position + 1 is the RDACAA code.
 */
export const VACCINE_DOSES = [
  'FIRST',
  'SECOND',
  'THIRD',
  'FOURTH',
  'FIFTH',
  'SIXTH',
  'SINGLE',
] as const;
export type VaccineDose = (typeof VACCINE_DOSES)[number];

/**
 * Grupo de riesgo de vacunas, 1 to 10 in the form's order, and PREGNANT,
 * which the instructivo's criteria name for dT adulto and influenza and its
 * printed catalogue does not number (D-195.1).
 */
export const VACCINE_RISK_GROUPS = [
  'AGES_AT_RISK',
  'POSTPARTUM',
  'HEALTH_WORKER',
  'CHRONIC_DISEASE',
  'DEPRIVED_OF_LIBERTY',
  'DISABILITY',
  'LIVING_WITH_HIV',
  'SEX_WORKER',
  'TRAVELLER',
  'OTHER',
  'PREGNANT',
] as const;
export type VaccineRiskGroup = (typeof VACCINE_RISK_GROUPS)[number];

/**
 * The vaccine catalogue (`VACCINE`) codes each vaccine by its COLUMN of the
 * form. These five are the ones whose risk group the instructivo constrains.
 */
export const VACCINE_CODES = {
  YELLOW_FEVER: '62',
  ADULT_DT: '67',
  MEASLES_RUBELLA: '69',
  ADULT_HEPATITIS_B: '70',
  INFLUENZA: '73',
} as const;

/**
 * EN-093. «Criterios de registro» (instructivo, pp. 57 and 58 of the PDF):
 * the risk groups each of these vaccines admits. HB is the adult one
 * (D-195.2). Any other vaccine asks for no risk group: in the ministry's own
 * tool the field stays inactive.
 */
export const RISK_GROUPS_BY_VACCINE: Readonly<
  Record<string, readonly VaccineRiskGroup[]>
> = {
  [VACCINE_CODES.ADULT_DT]: ['AGES_AT_RISK', 'PREGNANT'],
  [VACCINE_CODES.INFLUENZA]: [
    'AGES_AT_RISK',
    'PREGNANT',
    'POSTPARTUM',
    'HEALTH_WORKER',
    'CHRONIC_DISEASE',
    'DEPRIVED_OF_LIBERTY',
    'DISABILITY',
  ],
  [VACCINE_CODES.ADULT_HEPATITIS_B]: [
    'HEALTH_WORKER',
    'DEPRIVED_OF_LIBERTY',
    'LIVING_WITH_HIV',
    'SEX_WORKER',
    'OTHER',
  ],
  [VACCINE_CODES.MEASLES_RUBELLA]: ['AGES_AT_RISK', 'TRAVELLER'],
  [VACCINE_CODES.YELLOW_FEVER]: ['AGES_AT_RISK', 'TRAVELLER'],
};

/** A man cannot belong to the pregnancy or postpartum risk groups. */
export const FEMALE_ONLY_RISK_GROUPS: readonly VaccineRiskGroup[] = [
  'PREGNANT',
  'POSTPARTUM',
];

/**
 * ⚠️ THE RISK GROUP OF AN ADULT HEPATITIS B IS PROTECTED DATA (REQ-115): two
 * of its five groups say «lives with HIV» and «sex worker». So whoever lacks
 * the second key reads no risk group of an attention with that vaccine —
 * whatever it is, so the absence tells nothing — and cannot write one.
 */
export function riskGroupIsProtected(codes: readonly string[]): boolean {
  return codes.includes(VACCINE_CODES.ADULT_HEPATITIS_B);
}

/** EN-093. One vaccine given in the attention, by its catalogue code. */
export interface VaccineDoseGiven {
  code: string;
  dose: VaccineDose;
}

export interface VaccinationAnswer {
  doses: VaccineDoseGiven[];
  riskGroup: VaccineRiskGroup | null;
}

export type VaccinationRecord = VaccinationAnswer & BlockStamp;

/**
 * The risk groups this set of vaccines admits together: the intersection of
 * each constrained vaccine's list, or `null` when none of them is
 * constrained (no risk group is asked).
 */
export function admittedRiskGroups(
  codes: readonly string[],
): readonly VaccineRiskGroup[] | null {
  const constrained = codes.filter((code) => code in RISK_GROUPS_BY_VACCINE);
  if (constrained.length === 0) return null;
  return VACCINE_RISK_GROUPS.filter((group) =>
    constrained.every((code) => RISK_GROUPS_BY_VACCINE[code]!.includes(group)),
  );
}

export type VaccinationProblem =
  | 'DUPLICATE_VACCINE'
  | 'RISK_GROUP_REQUIRED'
  | 'RISK_GROUP_NOT_ASKED'
  | 'RISK_GROUP_NOT_ADMITTED'
  | 'RISK_GROUP_SEX';

/**
 * EN-093. What is wrong with a vaccination, in the order the database checks
 * it (`trg_encounter_vaccination_valid`). Whether each code is a vaccine in
 * force on the clinical date is the adapter's and the database's.
 */
export function vaccinationProblem(
  answer: VaccinationAnswer,
  patientSex: string,
): VaccinationProblem | null {
  const codes = answer.doses.map((dose) => dose.code);
  if (new Set(codes).size !== codes.length) return 'DUPLICATE_VACCINE';
  const admitted = admittedRiskGroups(codes);
  if (admitted === null) {
    return answer.riskGroup === null ? null : 'RISK_GROUP_NOT_ASKED';
  }
  if (answer.riskGroup === null) return 'RISK_GROUP_REQUIRED';
  if (!admitted.includes(answer.riskGroup)) return 'RISK_GROUP_NOT_ADMITTED';
  if (
    patientSex === 'MALE' &&
    FEMALE_ONLY_RISK_GROUPS.includes(answer.riskGroup)
  ) {
    return 'RISK_GROUP_SEX';
  }
  return null;
}

/** The same doses and risk group, whatever the order the doses came in. */
export function sameVaccination(
  a: VaccinationAnswer,
  b: VaccinationAnswer,
): boolean {
  const key = (answer: VaccinationAnswer) =>
    [...answer.doses]
      .map((dose) => `${dose.code}:${dose.dose}`)
      .sort()
      .join(',');
  return a.riskGroup === b.riskGroup && key(a) === key(b);
}
