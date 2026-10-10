import { describe, expect, it } from 'vitest';

import {
  keepProtectedRiskGroup,
  lastMenstrualPeriodProblem,
  nutritionBandOf,
  nutritionProblem,
  proposedSupplements,
  riskGroupIsProtected,
  riskGroupsAdmittedBy,
  sameVaccination,
  supplementOutsidePopulation,
  supplementsThatApply,
  vaccinationProblem,
  VACCINE_CODES,
  weeksSinceLastMenstrualPeriod,
  withholdProtectedRiskGroup,
  type VaccineDose,
  type VaccineRiskGroup,
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
    expect(nutritionBandOf(age(0, 0), 'FEMALE', false)).toBe(
      'EXCLUSIVE_BREASTFEEDING',
    );
    expect(nutritionBandOf(age(0, 5), 'MALE', false)).toBe(
      'EXCLUSIVE_BREASTFEEDING',
    );
    expect(nutritionBandOf(age(0, 6), 'FEMALE', false)).toBe(
      'COMPLEMENTARY_FEEDING',
    );
    expect(nutritionBandOf(age(0, 8), 'MALE', false)).toBe(
      'COMPLEMENTARY_FEEDING',
    );
  });

  it('EN-097 a los 9 meses, al año o sin edad congelada no se pide', () => {
    expect(nutritionBandOf(age(0, 9), 'FEMALE', false)).toBeNull();
    expect(nutritionBandOf(age(1, 0), 'FEMALE', false)).toBeNull();
    expect(nutritionBandOf(age(null, null), 'FEMALE', false)).toBeNull();
  });

  it('EN-260 a la mujer de 10 a 49 años se le pregunta su propia lactancia; a los 9, a los 50 o a un hombre, no', () => {
    expect(nutritionBandOf(age(10, 0), 'FEMALE', false)).toBe(
      'LACTATING_AGE_WOMAN',
    );
    expect(nutritionBandOf(age(49, 11), 'FEMALE', false)).toBe(
      'LACTATING_AGE_WOMAN',
    );
    expect(nutritionBandOf(age(9, 11), 'FEMALE', false)).toBeNull();
    expect(nutritionBandOf(age(50, 0), 'FEMALE', false)).toBeNull();
    expect(nutritionBandOf(age(30, 0), 'MALE', false)).toBeNull();
    expect(nutritionBandOf(age(30, 0), 'INTERSEX', false)).toBeNull();
  });

  it('EN-260 a la puérpera de cualquier edad se le pregunta su propia lactancia; sin el embarazo terminado, fuera de 10 a 49 no', () => {
    expect(nutritionBandOf(age(52, 0), 'FEMALE', true)).toBe('LACTATING_AGE_WOMAN'); // prettier-ignore
    expect(nutritionBandOf(age(9, 6), 'FEMALE', true)).toBe('LACTATING_AGE_WOMAN'); // prettier-ignore
    expect(nutritionBandOf(age(30, 0), 'FEMALE', true)).toBe('LACTATING_AGE_WOMAN'); // prettier-ignore
    expect(nutritionBandOf(age(52, 0), 'FEMALE', false)).toBeNull();
    expect(nutritionBandOf(age(52, 0), 'MALE', true)).toBeNull();
    expect(nutritionBandOf(age(null, null), 'FEMALE', true)).toBeNull();
  });

  it('EN-260 a la mujer no se le hacen las preguntas del lactante', () => {
    const own = { motherBreastfeeding: true, exclusiveBreastfeeding: null, complementaryFeeding: null }; // prettier-ignore
    expect(nutritionProblem('LACTATING_AGE_WOMAN', own)).toBeNull();
    expect(nutritionProblem('LACTATING_AGE_WOMAN', { ...own, exclusiveBreastfeeding: true })).toEqual({ field: 'exclusiveBreastfeeding', kind: 'notApplicable' }); // prettier-ignore
    expect(nutritionProblem('LACTATING_AGE_WOMAN', { ...own, complementaryFeeding: false })).toEqual({ field: 'complementaryFeeding', kind: 'notApplicable' }); // prettier-ignore
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

describe('EN-093 las vacunas y el grupo de riesgo de cada dosis', () => {
  const given = (code: string, riskGroup: VaccineRiskGroup | null = null, dose: VaccineDose = 'FIRST') => ({ code, dose, riskGroup }); // prettier-ignore
  const HB = VACCINE_CODES.ADULT_HEPATITIS_B;

  it('EN-093 cada vacuna con regla admite sus grupos; las demás, ninguno', () => {
    expect(riskGroupsAdmittedBy(VACCINE_CODES.ADULT_DT)).toEqual(['AGES_AT_RISK', 'PREGNANT']); // prettier-ignore
    expect(riskGroupsAdmittedBy(VACCINE_CODES.MEASLES_RUBELLA)).toEqual(['AGES_AT_RISK', 'TRAVELLER']); // prettier-ignore
    // BCG and pentavalente ask for none.
    expect(riskGroupsAdmittedBy('55')).toBeNull();
    expect(riskGroupsAdmittedBy('60')).toBeNull();
  });

  it('EN-093 sin regla la dosis no lleva grupo; con ella, lo exige y de los suyos', () => {
    expect(vaccinationProblem({ doses: [given('55')] }, 'FEMALE')).toBeNull();
    expect(vaccinationProblem({ doses: [given('55', 'OTHER')] }, 'FEMALE')).toBe('RISK_GROUP_NOT_ASKED'); // prettier-ignore
    expect(vaccinationProblem({ doses: [given(VACCINE_CODES.ADULT_DT)] }, 'FEMALE')).toBe('RISK_GROUP_REQUIRED'); // prettier-ignore
    expect(vaccinationProblem({ doses: [given(VACCINE_CODES.ADULT_DT, 'TRAVELLER')] }, 'FEMALE')).toBe('RISK_GROUP_NOT_ADMITTED'); // prettier-ignore
    expect(vaccinationProblem({ doses: [given(VACCINE_CODES.ADULT_DT, 'AGES_AT_RISK')] }, 'FEMALE')).toBeNull(); // prettier-ignore
  });

  it('EN-093 D-195.8 dT adulto y HB adulto juntos, cada uno con su grupo', () => {
    expect(vaccinationProblem({ doses: [given(VACCINE_CODES.ADULT_DT, 'AGES_AT_RISK'), given(HB, 'HEALTH_WORKER')] }, 'FEMALE')).toBeNull(); // prettier-ignore
  });

  it('EN-093 la misma vacuna dos veces no, y un hombre no es embarazada ni puérpera', () => {
    expect(vaccinationProblem({ doses: [given('55'), given('55')] }, 'FEMALE')).toBe('DUPLICATE_VACCINE'); // prettier-ignore
    expect(vaccinationProblem({ doses: [given(VACCINE_CODES.INFLUENZA, 'POSTPARTUM')] }, 'MALE')).toBe('RISK_GROUP_SEX'); // prettier-ignore
    expect(vaccinationProblem({ doses: [given(VACCINE_CODES.INFLUENZA, 'HEALTH_WORKER')] }, 'MALE')).toBeNull(); // prettier-ignore
  });

  it('EN-093 el grupo del HB adulto es dato protegido; el del resto, no', () => {
    expect(riskGroupIsProtected([HB])).toBe(true);
    expect(riskGroupIsProtected([VACCINE_CODES.ADULT_DT, '68'])).toBe(false);
  });

  it('EN-093 sin la llave se retiene sólo el grupo del HB adulto', () => {
    const record = { doses: [given(HB, 'LIVING_WITH_HIV'), given(VACCINE_CODES.ADULT_DT, 'AGES_AT_RISK')] }; // prettier-ignore
    expect(withholdProtectedRiskGroup(record)).toEqual({ doses: [given(HB), given(VACCINE_CODES.ADULT_DT, 'AGES_AT_RISK')] }); // prettier-ignore
  });

  it('EN-249 las mismas dosis en otro orden no son una corrección; otra dosis u otro grupo, sí', () => {
    const a = { doses: [given('55'), given('56')] };
    expect(sameVaccination(a, { doses: [given('56'), given('55')] })).toBe(
      true,
    );
    expect(sameVaccination(a, { doses: [given('55'), given('56', null, 'SECOND')] })).toBe(false); // prettier-ignore
    expect(sameVaccination({ doses: [given(HB, 'OTHER')] }, { doses: [given(HB, 'SEX_WORKER')] })).toBe(false); // prettier-ignore
  });
});

describe('EN-261 sin la llave, el HB adulto ya registrado se conserva o no se toca', () => {
  const given = (code: string, riskGroup: VaccineRiskGroup | null = null, dose: VaccineDose = 'FIRST') => ({ code, dose, riskGroup }); // prettier-ignore
  const HB = VACCINE_CODES.ADULT_HEPATITIS_B;
  const current = { doses: [given(HB, 'LIVING_WITH_HIV')] };

  it('EN-261 reenviado igual y con el grupo vacío, se le devuelve el grupo guardado', () => {
    expect(keepProtectedRiskGroup({ doses: [given(HB), given('73', 'HEALTH_WORKER')] }, current)).toEqual({ doses: [given(HB, 'LIVING_WITH_HIV'), given('73', 'HEALTH_WORKER')] }); // prettier-ignore
  });

  it('EN-261 quitarlo, cambiarle la dosis, ponerle grupo o añadir uno nuevo se rechaza', () => {
    expect(keepProtectedRiskGroup({ doses: [given('73', 'HEALTH_WORKER')] }, current)).toBeNull(); // prettier-ignore
    expect(keepProtectedRiskGroup({ doses: [given(HB, null, 'SECOND')] }, current)).toBeNull(); // prettier-ignore
    expect(keepProtectedRiskGroup({ doses: [given(HB, 'HEALTH_WORKER')] }, current)).toBeNull(); // prettier-ignore
    expect(keepProtectedRiskGroup({ doses: [given(HB)] }, null)).toBeNull();
    expect(keepProtectedRiskGroup({ doses: [given(HB)] }, { doses: [given('55')] })).toBeNull(); // prettier-ignore
  });

  it('EN-261 sin HB adulto en ninguno de los dos, la respuesta pasa tal cual', () => {
    const answer = { doses: [given('55')] };
    expect(keepProtectedRiskGroup(answer, null)).toEqual(answer);
    expect(keepProtectedRiskGroup(answer, { doses: [given('56')] })).toEqual(answer); // prettier-ignore
  });
});

describe('EN-096 EN-262 los suplementos: su población y la propuesta desde la receta', () => {
  const none = { micronutrientPowder: null, vitaminA: null, ironSyrup: null, ironFolicAcid: null }; // prettier-ignore

  it('EN-096 cada casilla, en su edad: chispas de 6 a 24 meses, vitamina A de 6 a 59, hierro en jarabe de 24 a 59', () => {
    expect(supplementsThatApply(age(0, 5), false)).toEqual({ micronutrientPowder: false, vitaminA: false, ironSyrup: false, ironFolicAcid: false }); // prettier-ignore
    expect(supplementsThatApply(age(0, 6), false)).toEqual({ micronutrientPowder: true, vitaminA: true, ironSyrup: false, ironFolicAcid: false }); // prettier-ignore
    expect(supplementsThatApply(age(2, 0), false)).toEqual({ micronutrientPowder: true, vitaminA: true, ironSyrup: true, ironFolicAcid: false }); // prettier-ignore
    expect(supplementsThatApply(age(2, 1), false)).toMatchObject({ micronutrientPowder: false, ironSyrup: true }); // prettier-ignore
    expect(supplementsThatApply(age(4, 11), false)).toMatchObject({ vitaminA: true, ironSyrup: true }); // prettier-ignore
    expect(supplementsThatApply(age(5, 0), false)).toMatchObject({ vitaminA: false, ironSyrup: false }); // prettier-ignore
    expect(supplementsThatApply(age(null, null), false).vitaminA).toBe(false);
  });

  it('EN-096 el hierro con ácido fólico, sólo a la embarazada o lactante', () => {
    expect(supplementsThatApply(age(28, 0), true).ironFolicAcid).toBe(true);
    expect(supplementsThatApply(age(28, 0), false).ironFolicAcid).toBe(false);
    const adult = supplementsThatApply(age(28, 0), false);
    expect(supplementOutsidePopulation(adult, { ...none, ironFolicAcid: false })).toBe('ironFolicAcid'); // prettier-ignore
    expect(supplementOutsidePopulation(adult, none)).toBeNull();
  });

  it('EN-262 propone Sí con el medicamento de la casilla en la receta, No sin él, y nada donde no aplica', () => {
    const toddler = supplementsThatApply(age(3, 0), false);
    expect(proposedSupplements(toddler, [])).toEqual({ micronutrientPowder: null, vitaminA: false, ironSyrup: false, ironFolicAcid: null }); // prettier-ignore
    expect(proposedSupplements(toddler, [{ cnmbCode: 'A11CA01', dosageFormCode: 'CAPSULE' }, { cnmbCode: 'B03AA07', dosageFormCode: 'SYRUP' }])).toEqual({ micronutrientPowder: null, vitaminA: true, ironSyrup: true, ironFolicAcid: null }); // prettier-ignore
  });

  it('EN-262 el sulfato ferroso en tableta no es hierro en jarabe, ni una línea fuera del CNMB cuenta', () => {
    const toddler = supplementsThatApply(age(3, 0), false);
    expect(proposedSupplements(toddler, [{ cnmbCode: 'B03AA07', dosageFormCode: 'TABLET' }]).ironSyrup).toBe(false); // prettier-ignore
    expect(proposedSupplements(toddler, [{ cnmbCode: null, dosageFormCode: 'SYRUP' }]).ironSyrup).toBe(false); // prettier-ignore
    const expecting = supplementsThatApply(age(28, 0), true);
    expect(proposedSupplements(expecting, [{ cnmbCode: 'B03AD', dosageFormCode: 'TABLET' }]).ironFolicAcid).toBe(true); // prettier-ignore
  });
});
