import { describe, expect, it } from 'vitest';

import {
  admittedRiskGroups,
  lastMenstrualPeriodProblem,
  nutritionBandOf,
  nutritionProblem,
  riskGroupIsProtected,
  sameVaccination,
  vaccinationProblem,
  VACCINE_CODES,
  weeksSinceLastMenstrualPeriod,
} from './program-blocks';

/** A clinical date and another, both derived from one instant, never typed. */
function dayAndDaysBefore(days: number): [string, string] {
  const clinical = new Date();
  const day = clinical.toISOString().slice(0, 10);
  const before = new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return [day, before];
}

const age = (ageYears: number | null, ageMonths: number | null) => ({
  ageYears,
  ageMonths,
  ageDays: 0,
});

describe('EN-090 el bloque obstétrico: la FUM y las semanas', () => {
  it('EN-090 la FUM no puede ser posterior a la atención ni de más de 300 días antes', () => {
    const [day, ten] = dayAndDaysBefore(10);
    const [, future] = dayAndDaysBefore(-1);
    const [, old] = dayAndDaysBefore(301);
    const [, limit] = dayAndDaysBefore(300);

    expect(lastMenstrualPeriodProblem(ten, day)).toBeNull();
    expect(lastMenstrualPeriodProblem(limit, day)).toBeNull();
    expect(lastMenstrualPeriodProblem(future, day)).toBe('AFTER_ATTENTION');
    expect(lastMenstrualPeriodProblem(old, day)).toBe('TOO_OLD');
  });

  it('EN-090 propone las semanas cumplidas desde la FUM, y nada fuera de 1 a 42', () => {
    const [day, sixtyThree] = dayAndDaysBefore(63);
    const [, sixtyNine] = dayAndDaysBefore(69);
    const [, six] = dayAndDaysBefore(6);
    const [, forty3] = dayAndDaysBefore(43 * 7);

    expect(weeksSinceLastMenstrualPeriod(sixtyThree, day)).toBe(9);
    expect(weeksSinceLastMenstrualPeriod(sixtyNine, day)).toBe(9);
    expect(weeksSinceLastMenstrualPeriod(six, day)).toBeNull();
    expect(weeksSinceLastMenstrualPeriod(forty3, day)).toBeNull();
  });
});

describe('EN-092 EN-097 el SIVAN, por la edad congelada en meses cumplidos', () => {
  it('EN-092 de 0 a 5 meses pregunta por la leche materna, de 6 a 8 por el alimento sólido', () => {
    expect(nutritionBandOf(age(0, 0))).toBe('EXCLUSIVE_BREASTFEEDING');
    expect(nutritionBandOf(age(0, 5))).toBe('EXCLUSIVE_BREASTFEEDING');
    expect(nutritionBandOf(age(0, 6))).toBe('COMPLEMENTARY_FEEDING');
    expect(nutritionBandOf(age(0, 8))).toBe('COMPLEMENTARY_FEEDING');
  });

  it('EN-097 a los 9 meses, al año o sin edad congelada no se pide', () => {
    expect(nutritionBandOf(age(0, 9))).toBeNull();
    expect(nutritionBandOf(age(1, 0))).toBeNull();
    expect(nutritionBandOf(age(null, null))).toBeNull();
  });

  it('EN-092 la pregunta del tramo es obligatoria y la del otro tramo no se admite', () => {
    const answer = {
      motherBreastfeeding: true,
      exclusiveBreastfeeding: true,
      complementaryFeeding: null,
    };
    expect(nutritionProblem('EXCLUSIVE_BREASTFEEDING', answer)).toBeNull();
    expect(nutritionProblem('COMPLEMENTARY_FEEDING', answer)).toEqual({
      field: 'exclusiveBreastfeeding',
      kind: 'notApplicable',
    });
    expect(
      nutritionProblem('COMPLEMENTARY_FEEDING', {
        ...answer,
        exclusiveBreastfeeding: null,
      }),
    ).toEqual({ field: 'complementaryFeeding', kind: 'required' });
  });
});

describe('EN-093 las vacunas y su grupo de riesgo', () => {
  const dose = (code: string) => ({ code, dose: 'FIRST' as const });

  it('EN-093 cada vacuna admite sus grupos, y juntas, los que admiten todas', () => {
    expect(admittedRiskGroups([VACCINE_CODES.ADULT_DT])).toEqual([
      'AGES_AT_RISK',
      'PREGNANT',
    ]);
    expect(
      admittedRiskGroups([VACCINE_CODES.ADULT_DT, VACCINE_CODES.INFLUENZA]),
    ).toEqual(['AGES_AT_RISK', 'PREGNANT']);
    expect(
      admittedRiskGroups([
        VACCINE_CODES.MEASLES_RUBELLA,
        VACCINE_CODES.YELLOW_FEVER,
      ]),
    ).toEqual(['AGES_AT_RISK', 'TRAVELLER']);
    // BCG and pentavalente ask for none.
    expect(admittedRiskGroups(['55', '60'])).toBeNull();
  });

  it('EN-093 sin vacuna que lo pida no lleva grupo; con una, lo exige y de los suyos', () => {
    expect(vaccinationProblem({ doses: [dose('55')], riskGroup: null }, 'FEMALE')).toBeNull(); // prettier-ignore
    expect(vaccinationProblem({ doses: [dose('55')], riskGroup: 'OTHER' }, 'FEMALE')).toBe('RISK_GROUP_NOT_ASKED'); // prettier-ignore
    expect(vaccinationProblem({ doses: [dose(VACCINE_CODES.ADULT_DT)], riskGroup: null }, 'FEMALE')).toBe('RISK_GROUP_REQUIRED'); // prettier-ignore
    expect(vaccinationProblem({ doses: [dose(VACCINE_CODES.ADULT_DT)], riskGroup: 'TRAVELLER' }, 'FEMALE')).toBe('RISK_GROUP_NOT_ADMITTED'); // prettier-ignore
    expect(vaccinationProblem({ doses: [dose(VACCINE_CODES.ADULT_DT)], riskGroup: 'AGES_AT_RISK' }, 'FEMALE')).toBeNull(); // prettier-ignore
  });

  it('EN-093 la misma vacuna dos veces no, y un hombre no es embarazada ni puérpera', () => {
    expect(vaccinationProblem({ doses: [dose('55'), dose('55')], riskGroup: null }, 'FEMALE')).toBe('DUPLICATE_VACCINE'); // prettier-ignore
    expect(vaccinationProblem({ doses: [dose(VACCINE_CODES.INFLUENZA)], riskGroup: 'POSTPARTUM' }, 'MALE')).toBe('RISK_GROUP_SEX'); // prettier-ignore
    expect(vaccinationProblem({ doses: [dose(VACCINE_CODES.INFLUENZA)], riskGroup: 'HEALTH_WORKER' }, 'MALE')).toBeNull(); // prettier-ignore
  });

  it('EN-093 el grupo del HB adulto es dato protegido; el del resto, no', () => {
    expect(riskGroupIsProtected([VACCINE_CODES.ADULT_HEPATITIS_B])).toBe(true);
    expect(riskGroupIsProtected([VACCINE_CODES.ADULT_DT, '68'])).toBe(false);
  });

  it('EN-249 las mismas dosis en otro orden no son una corrección', () => {
    const a = { doses: [dose('55'), dose('56')], riskGroup: null };
    const b = { doses: [dose('56'), dose('55')], riskGroup: null };
    expect(sameVaccination(a, b)).toBe(true);
    expect(
      sameVaccination(a, {
        doses: [dose('55'), { code: '56', dose: 'SECOND' }],
        riskGroup: null,
      }),
    ).toBe(false);
  });
});
