import { describe, expect, it } from 'vitest';

import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';

import {
  authorisesDelivery,
  copyNeedsReview,
  copyPeriodOf,
  isSensitiveDiagnosis,
} from './clinical-record-copy';
import { ClinicalRecordCopyInvalidError } from './privacy.errors';

// The day of the answer, from the clock; every period is counted from it.
const answeredOn = clinicalDateOf(new Date());
const daysAgo = (n: number) => addDays(answeredOn, -n);

describe('copyPeriodOf — el alcance de la copia autorizada', () => {
  it('PD-059 «Atendida» es la copia completa, sin periodo', () => {
    expect(
      copyPeriodOf({
        clinicalRecordCopy: true,
        outcome: 'GRANTED',
        period: undefined,
        answeredOn,
      }),
    ).toBeNull();
  });

  it('PD-059 «Atendida en parte» guarda su periodo, hasta el día de la respuesta', () => {
    const period = { from: daysAgo(200), to: answeredOn };
    expect(
      copyPeriodOf({
        clinicalRecordCopy: true,
        outcome: 'PARTIALLY_GRANTED',
        period,
        answeredOn,
      }),
    ).toEqual(period);
  });

  it('PD-059 sin periodo, al revés o en el futuro se rechaza nombrando copyPeriod', () => {
    for (const period of [
      null,
      { from: daysAgo(1), to: daysAgo(2) },
      { from: daysAgo(3), to: addDays(answeredOn, 1) },
    ]) {
      expect(() =>
        copyPeriodOf({
          clinicalRecordCopy: true,
          outcome: 'PARTIALLY_GRANTED',
          period,
          answeredOn,
        }),
      ).toThrow(ClinicalRecordCopyInvalidError);
    }
  });

  it('PD-059 un periodo con «Atendida», «Denegada» o en otra solicitud se rechaza', () => {
    const period = { from: daysAgo(40), to: daysAgo(10) };
    for (const [clinicalRecordCopy, outcome] of [
      [true, 'GRANTED'],
      [true, 'DENIED'],
      [false, 'PARTIALLY_GRANTED'],
    ] as const) {
      expect(() =>
        copyPeriodOf({ clinicalRecordCopy, outcome, period, answeredOn }),
      ).toThrow(ClinicalRecordCopyInvalidError);
    }
  });

  it('PD-059 «Denegada» no entrega nada; «Atendida» y «Atendida en parte» sí', () => {
    expect(authorisesDelivery('DENIED')).toBe(false);
    expect(authorisesDelivery('GRANTED')).toBe(true);
    expect(authorisesDelivery('PARTIALLY_GRANTED')).toBe(true);
  });
});

describe('lo sensible que espera el visto bueno', () => {
  it('PD-062 los grupos de maltrato, VIH, tuberculosis activa y cáncer', () => {
    for (const code of [
      'Y07.0',
      'T74.1',
      'B20',
      'B24',
      'A15.0',
      'A19.9',
      'C00.0',
      'C50.9',
      'C97',
    ]) {
      expect(isSensitiveDiagnosis(code)).toBe(true);
    }
    for (const code of [
      'J02.9',
      'B25.0',
      'A14',
      'A20',
      'D00.0',
      'C98',
      'Y06',
      'T75',
    ]) {
      expect(isSensitiveDiagnosis(code)).toBe(false);
    }
  });

  it('PD-062 el titular no lo espera; el representante y los terceros sí', () => {
    expect(copyNeedsReview('HOLDER', true)).toBe(false);
    expect(copyNeedsReview('REPRESENTATIVE', true)).toBe(true);
    expect(copyNeedsReview('ATTORNEY', true)).toBe(true);
    expect(copyNeedsReview('ATTORNEY', false)).toBe(false);
  });
});
