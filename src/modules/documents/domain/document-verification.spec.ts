import { describe, expect, it } from 'vitest';

import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';
import {
  VERIFICATION_CODE,
  toVerification,
  type VerificationFacts,
} from './document-verification';

/** DOC-094 to DOC-096. The public answer, built from a closed shape. */
describe('toVerification', () => {
  const now = new Date();
  const facts: VerificationFacts = {
    kind: 'PRESCRIPTION',
    issuedAt: now,
    annulled: false,
    annulledAt: null,
    establishmentName: 'Clínica Andina',
    siteName: 'Sede Norte',
    practitionerName: 'Jiménez Pablo',
  };

  it('DOC-094 dice clase, fecha de emisión en Ecuador, establecimiento, sede, profesional y que está vigente', () => {
    expect(toVerification(facts)).toEqual({
      kind: 'PRESCRIPTION',
      issuedOn: clinicalDateOf(now),
      establishmentName: 'Clínica Andina',
      siteName: 'Sede Norte',
      practitionerName: 'Jiménez Pablo',
      status: 'VALID',
      annulledOn: null,
    });
  });

  it('DOC-094 resuelve la fecha en America/Guayaquil, no en UTC', () => {
    // 02:00 UTC is 21:00 of the PREVIOUS day in Ecuador.
    const today = clinicalDateOf(now);
    const lateEvening = new Date(`${addDays(today, 1)}T02:00:00Z`);
    expect(toVerification({ ...facts, issuedAt: lateEvening }).issuedOn).toBe(
      today,
    );
  });

  it('DOC-094 dice anulado, con su fecha cuando consta', () => {
    expect(
      toVerification({ ...facts, annulled: true, annulledAt: now }),
    ).toMatchObject({ status: 'ANNULLED', annulledOn: clinicalDateOf(now) });
    expect(
      toVerification({ ...facts, annulled: true, annulledAt: null }),
    ).toMatchObject({ status: 'ANNULLED', annulledOn: null });
  });

  it('DOC-095 la respuesta no tiene ningún campo del paciente', () => {
    expect(Object.keys(toVerification(facts)).sort()).toEqual([
      'annulledOn',
      'establishmentName',
      'issuedOn',
      'kind',
      'practitionerName',
      'siteName',
      'status',
    ]);
  });

  it('DOC-096 sólo admite códigos con forma de código', () => {
    expect(VERIFICATION_CODE.test('A1B2C3D4E5F60718')).toBe(true);
    expect(VERIFICATION_CODE.test('../etc/passwd')).toBe(false);
    expect(VERIFICATION_CODE.test('x')).toBe(false);
    expect(VERIFICATION_CODE.test('A'.repeat(33))).toBe(false);
  });
});
