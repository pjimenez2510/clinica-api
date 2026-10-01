import { describe, expect, it } from 'vitest';

import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';

import {
  issueCertificateSchema,
  revokeCertificateSchema,
} from './certificate.dto';

/** The transport's half of CER-004, CER-007 and CER-011. */
const today = clinicalDateOf(new Date());

describe('el contrato de entrada del certificado', () => {
  it('CER-007 rechaza la peticion que no dice si el diagnostico se incluye, en ese campo', () => {
    const result = issueCertificateSchema.safeParse({ type: 'ATTENDANCE' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'includeDiagnosis',
    ]);
  });

  it('CER-007 admite las dos respuestas explicitas, y ninguna por defecto', () => {
    for (const includeDiagnosis of [true, false]) {
      const result = issueCertificateSchema.parse({
        type: 'ATTENDANCE',
        includeDiagnosis,
      });
      expect(result.includeDiagnosis).toBe(includeDiagnosis);
    }
  });

  it('CER-004 rechaza un identificador de emisor en la peticion', () => {
    const result = issueCertificateSchema.safeParse({
      type: 'ATTENDANCE',
      includeDiagnosis: false,
      issuedById: '0192f0c8-0000-7000-8000-000000000000',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('CER-006 exige que las fechas existan en el calendario, y deja el resto al servicio', () => {
    expect(
      issueCertificateSchema.safeParse({
        type: 'MEDICAL_REST',
        restFrom: today,
        restTo: addDays(today, 2),
        includeDiagnosis: false,
      }).success,
    ).toBe(true);

    const result = issueCertificateSchema.safeParse({
      type: 'MEDICAL_REST',
      restFrom: `${today.slice(0, 4)}-02-30`,
      includeDiagnosis: false,
    });
    expect(result.error?.issues[0]?.path).toEqual(['restFrom']);
  });

  it('CER-005 admite en el transporte todos los tipos del esquema: el servicio rechaza los que no son un 117', () => {
    expect(
      issueCertificateSchema.safeParse({
        type: 'FITNESS',
        includeDiagnosis: false,
      }).success,
    ).toBe(true);
    expect(
      issueCertificateSchema.safeParse({
        type: 'OTRO',
        includeDiagnosis: false,
      }).success,
    ).toBe(false);
  });

  it('CER-034 admite las cuatro contingencias del IESS y ninguna otra', () => {
    const rest = (contingencyType: string) =>
      issueCertificateSchema.safeParse({
        type: 'MEDICAL_REST',
        includeDiagnosis: true,
        contingencyType,
      }).success;
    for (const contingency of [
      'GENERAL_ILLNESS',
      'WORK_ACCIDENT',
      'OCCUPATIONAL_DISEASE',
      'MATERNITY',
    ]) {
      expect(rest(contingency)).toBe(true);
    }
    expect(rest('OTRA')).toBe(false);
  });

  it('CER-011 exige un motivo escrito para anular', () => {
    expect(revokeCertificateSchema.safeParse({}).success).toBe(false);
    expect(revokeCertificateSchema.safeParse({ reason: '   ' }).success).toBe(
      false,
    );
    expect(
      revokeCertificateSchema.parse({ reason: '  Se emitió por error  ' })
        .reason,
    ).toBe('Se emitió por error');
  });
});
