import { describe, expect, it } from 'vitest';

import { readCertificate } from './certificate-reading';

const said = (...texts: string[]) =>
  texts.map((text, at) => ({ startMs: at * 10_000, endMs: at * 10_000 + 9_000, text })); // prettier-ignore

describe('AS-299 the certificate said aloud, read by rules', () => {
  it('AS-299 Carmen: a rest for one day, each with its phrase, though a «no» about work comes before', () => {
    const read = readCertificate(
      said(
        'Le receto nitrofurantoína.',
        'doctora me puede dar un certificado hoy no voy a poder ir a trabajar si le hago un certificado de reposo por un día muchas gracias doctora',
      ),
    );

    expect(read).toEqual({
      type: { value: 'MEDICAL_REST', quote: 'certificado de reposo', startMs: 10_000 }, // prettier-ignore
      days: { value: 1, quote: 'por un día', startMs: 10_000 },
    });
  });

  it('AS-299 the days in figures, and an attendance certificate has no days', () => {
    expect(readCertificate(said('Le doy un certificado médico de reposo por 3 días.'))?.days?.value).toBe(3); // prettier-ignore
    expect(
      readCertificate(said('Le hago un certificado de asistencia.')),
    ).toEqual({
      type: { value: 'ATTENDANCE', quote: 'certificado de asistencia', startMs: 0 }, // prettier-ignore
      days: null,
    });
  });

  it('AS-299 a rest whose days were not said proposes the type alone', () => {
    expect(readCertificate(said('Le hago un certificado de reposo.'))?.days).toBeNull(); // prettier-ignore
  });

  it('AS-299 nothing when no certificate was said, when only one was asked for without a type, or when it is denied', () => {
    expect(readCertificate(said('Tome mucha agua.'))).toBeNull();
    expect(readCertificate(said('Doctora, ¿me puede dar un certificado?'))).toBeNull(); // prettier-ignore
    expect(readCertificate(said('No le hago un certificado de reposo, no hace falta.'))).toBeNull(); // prettier-ignore
    // Control: the same sentence without its «no» is read.
    expect(readCertificate(said('Le hago un certificado de reposo, no hace falta más.'))?.type.value).toBe('MEDICAL_REST'); // prettier-ignore
  });

  it('AS-299 the last said wins, and a rest beyond thirty days is left to type', () => {
    const read = readCertificate(said('Le hago un certificado de reposo por dos días.', 'Mejor, un certificado de reposo por 45 días.')); // prettier-ignore
    expect(read?.type.startMs).toBe(10_000);
    expect(read?.days).toBeNull();
  });
});
