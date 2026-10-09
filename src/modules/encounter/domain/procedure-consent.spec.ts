import { describe, expect, it } from 'vitest';

import {
  consentProblem,
  refusalProblem,
  revocationProblem,
  type ProcedureConsentInput,
} from './procedure-consent';

/** Every instant derives from one clock reading: no date is written by hand. */
const performedAt = new Date();
const minutes = (n: number) => new Date(performedAt.getTime() + n * 60_000);

const byPatient: ProcedureConsentInput = {
  kind: 'SIGNED',
  signer: 'PATIENT',
  representative: null,
};

describe('EN-152 lo que el 024 tiene que decir antes de guardarse', () => {
  it('EN-152 la firma antes o a la vez que el procedimiento vale; después, no', () => {
    expect(consentProblem(byPatient, performedAt, minutes(-15))).toBeNull();
    expect(consentProblem(byPatient, performedAt, performedAt)).toBeNull();
    expect(consentProblem(byPatient, performedAt, minutes(1))).toBe(
      'SIGNED_AFTER_PROCEDURE',
    );
  });

  it('EN-152 el representante firma con su nombre; sin él, se pide', () => {
    expect(
      consentProblem(
        { kind: 'SIGNED', signer: 'REPRESENTATIVE', representative: null },
        performedAt,
        minutes(-5),
      ),
    ).toBe('REPRESENTATIVE_REQUIRED');
    expect(
      consentProblem(
        {
          kind: 'SIGNED',
          signer: 'REPRESENTATIVE',
          representative: { name: 'Rosa Cedeño', relationship: 'MOTHER', document: null }, // prettier-ignore
        },
        performedAt,
        minutes(-5),
      ),
    ).toBeNull();
  });

  it('EN-152 la excepción sin fundamento escrito no es una excepción', () => {
    expect(
      consentProblem(
        { kind: 'EXCEPTION', exceptionKind: 'EMERGENCY', reason: '   ' },
        performedAt,
        performedAt,
      ),
    ).toBe('EXCEPTION_REASON_REQUIRED');
    expect(
      consentProblem(
        {
          kind: 'EXCEPTION',
          exceptionKind: 'UNEXPECTED_DURING_PROCEDURE',
          reason: 'Hallazgo durante la biopsia que exigía ampliar la resección',
        },
        performedAt,
        performedAt,
      ),
    ).toBeNull();
  });
});

describe('EN-153 la negativa dice quién se negó', () => {
  const base = {
    conceptId: 'concept-1',
    representative: null,
    witness: null,
  };

  it('EN-153 si nadie firma, el testigo con nombre y documento es obligatorio', () => {
    expect(refusalProblem({ ...base, signer: 'NONE' })).toBe(
      'WITNESS_REQUIRED',
    );
    expect(
      refusalProblem({ ...base, signer: 'NONE', witness: { name: 'Luis Andrade', document: '' } }), // prettier-ignore
    ).toBe('WITNESS_REQUIRED');
    expect(
      refusalProblem({ ...base, signer: 'NONE', witness: { name: 'Luis Andrade', document: '1710034065' } }), // prettier-ignore
    ).toBeNull();
  });

  it('EN-153 si firma el paciente no hace falta testigo; si firma el representante, su nombre', () => {
    expect(refusalProblem({ ...base, signer: 'PATIENT' })).toBeNull();
    expect(refusalProblem({ ...base, signer: 'REPRESENTATIVE' })).toBe(
      'REPRESENTATIVE_REQUIRED',
    );
  });
});

describe('EN-154 la revocación dice quién la expresó', () => {
  it('EN-154 el paciente revoca sin más; el representante, con su nombre', () => {
    expect(revocationProblem({ signer: 'PATIENT', representative: null })).toBeNull(); // prettier-ignore
    expect(
      revocationProblem({ signer: 'REPRESENTATIVE', representative: null }),
    ).toBe('REPRESENTATIVE_REQUIRED');
  });
});
