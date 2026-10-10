import { describe, expect, it } from 'vitest';

import { presentationOf } from './data-request-party';
import {
  ClinicalRecordCopyInvalidError,
  DataRequestPartyNotAllowedError,
} from './privacy.errors';

const copy = {
  right: 'ACCESS' as const,
  clinicalRecordCopy: true,
  documentsChecked: true,
};

describe('presentationOf — quién presenta la solicitud y qué pide', () => {
  it('PD-052 un apoderado pide la copia con su nombre y su cédula, sin espacios de más', () => {
    expect(
      presentationOf({
        ...copy,
        requestedBy: 'ATTORNEY',
        requesterName: '  Ana Pérez ',
        requesterDocument: ' 1710034065 ',
      }),
    ).toEqual({
      ...copy,
      requestedBy: 'ATTORNEY',
      requesterName: 'Ana Pérez',
      requesterDocument: '1710034065',
    });
  });

  it('PD-052 un tercero que no pide la copia se rechaza con DATA_REQUEST_PARTY_NOT_ALLOWED', () => {
    for (const requestedBy of [
      'ATTORNEY',
      'AUTHORIZED_PERSON',
      'AUTHORITY',
      'DECEASED_RELATIVE',
    ] as const) {
      expect(() =>
        presentationOf({
          right: 'ACCESS',
          requestedBy,
          requesterName: 'X',
          requesterDocument: 'Y',
        }),
      ).toThrow(DataRequestPartyNotAllowedError);
    }
  });

  it('PD-052 control positivo: el titular y su representante ejercen cualquier derecho sin copia', () => {
    expect(
      presentationOf({ right: 'ERASURE', requestedBy: 'REPRESENTATIVE' }),
    ).toMatchObject({ clinicalRecordCopy: false, documentsChecked: false });
    expect(
      presentationOf({ right: 'PORTABILITY', requestedBy: 'HOLDER' }),
    ).toMatchObject({ clinicalRecordCopy: false });
  });

  it('PD-052 quien no es el titular y pide la copia, sin nombre o sin documento, se rechaza nombrando el campo', () => {
    const missingName = () =>
      presentationOf({ ...copy, requestedBy: 'AUTHORITY', requesterName: ' ', requesterDocument: 'Oficio 12' }); // prettier-ignore
    expect(missingName).toThrow(ClinicalRecordCopyInvalidError);
    expect(() => missingName()).toThrow(
      expect.objectContaining({ field: 'requesterName' }),
    );
    expect(() =>
      presentationOf({
        ...copy,
        requestedBy: 'REPRESENTATIVE',
        requesterName: 'Luis',
      }),
    ).toThrow(expect.objectContaining({ field: 'requesterDocument' }));
  });

  it('PD-052 el titular no da nombre: es el de la ficha, y lo que llegue no se guarda', () => {
    expect(
      presentationOf({ ...copy, requestedBy: 'HOLDER', requesterName: 'Otro' }),
    ).toMatchObject({ requesterName: null, requesterDocument: null });
  });

  it('PD-053 la copia con otro derecho que no es acceso, o sin la casilla, se rechaza con CLINICAL_RECORD_COPY_INVALID', () => {
    expect(() =>
      presentationOf({ ...copy, right: 'PORTABILITY', requestedBy: 'HOLDER' }),
    ).toThrow(expect.objectContaining({ field: 'clinicalRecordCopy' }));
    expect(() =>
      presentationOf({
        ...copy,
        documentsChecked: false,
        requestedBy: 'HOLDER',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'CLINICAL_RECORD_COPY_INVALID',
        field: 'documentsChecked',
      }),
    );
  });

  it('PD-052 sin copia no se guarda quién la presenta: ni nombre ni documento, como espera la base', () => {
    expect(
      presentationOf({
        right: 'ERASURE',
        requestedBy: 'REPRESENTATIVE',
        requesterName: 'a'.repeat(300),
        requesterDocument: 'x',
      }),
    ).toMatchObject({ requesterName: null, requesterDocument: null });
  });

  it('PD-052 un nombre de más de 200 caracteres se rechaza', () => {
    expect(() =>
      presentationOf({
        ...copy,
        requestedBy: 'ATTORNEY',
        requesterName: 'a'.repeat(201),
        requesterDocument: '1',
      }),
    ).toThrow(expect.objectContaining({ field: 'requesterName' }));
  });
});
