import { describe, expect, it } from 'vitest';

import { composeDocument } from './prescription-document';
import type { PrescriptionDocumentSource } from './prescription.repository';

/**
 * PR-021 to PR-053. The prescription as art. 5 obliges it to be emitted.
 *
 * WHAT THIS PROVES that the pieces on their own do not: that every field of
 * art. 5 reaches the document, in the shape the norm names it — the surname
 * first, the route spelled out, the quantity twice, the age with months, the
 * validity as a date in Ecuador.
 */
const ISSUED_AT = new Date('2026-09-14T20:00:00Z');

const source = (
  overrides: Partial<PrescriptionDocumentSource> = {},
): PrescriptionDocumentSource => ({
  prescription: {
    id: 'prescription-1',
    encounterId: 'encounter-1',
    prescriberId: 'practitioner-1',
    status: 'ACTIVE',
    issuedAt: ISSUED_AT,
    verificationCode: 'A1B2C3D4E5F60718',
    sequenceNumber: 120,
    warningSigns: 'Fiebre mayor de 39 °C o dificultad para respirar',
    nonPharmacologicalAdvice: 'Abundantes líquidos y reposo relativo',
    createdAt: new Date('2026-09-14T19:50:00Z'),
    // PR-011. `null` on an issued prescription: the discard is a way out of a
    // DRAFT and never of a document that already left the room.
    discardedAt: null,
    discardReason: null,
    items: [
      {
        id: 'item-1',
        line: 1,
        conceptId: 'concept-1',
        genericName: 'Amoxicilina',
        presentation: 'Cápsula',
        concentration: '500 mg',
        routeCode: 'ORAL',
        quantity: 20,
        doseText: '1 cápsula',
        frequencyText: 'Cada 8 horas',
        durationDays: 7,
        instructions: 'Tomar con alimentos',
        offFormularyJustification: null,
        dosageFormCode: 'CAPSULE',
        doseAmount: 1,
        doseUnitCode: 'CAPSULE',
        frequencyCode: 'EVERY_8_HOURS',
      },
    ],
  },
  site: {
    id: 'site-1',
    name: 'Centro de Especialidades Norte',
    mspUnicode: 'U000123',
    city: 'Quito',
  },
  patient: {
    familyName: 'Guamán Tipán',
    givenName: 'María José',
    ageYears: 1,
    ageMonths: 2,
    ageDays: 5,
  },
  diagnoses: [{ code: 'J020', display: 'Faringitis estreptocócica' }],
  allergies: [{ substanceText: 'Penicilina' }],
  prescriber: {
    givenName: 'Ana',
    familyName: 'Villacís',
    acessRegistration: 'ACESS-11223',
    contactPhone: '0991234567',
  },
  ...overrides,
});

describe('la receta como documento', () => {
  it('PR-021 lleva la ciudad y el instante de prescripción', () => {
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.city).toBe('Quito');
    expect(document.issuedAt).toEqual(ISSUED_AT);
  });

  it('PR-022 lleva el establecimiento con su código único del MSP', () => {
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.establishment).toEqual({
      name: 'Centro de Especialidades Norte',
      mspUnicode: 'U000123',
    });
  });

  it('PR-023 lleva la vigencia en días y como fecha del último día válido', () => {
    // 20:00 UTC del 14 son las 15:00 del 14 en Guayaquil: emitida el 14, vence
    // el 16.
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.validity).toEqual({ days: 3, through: '2026-09-16' });
  });

  it('PR-023 no da vigencia a un borrador, porque no hay nada dispensable', () => {
    const document = composeDocument(
      source({
        prescription: {
          ...source().prescription,
          status: 'DRAFT',
          issuedAt: null,
          verificationCode: null,
        },
      }),
      { context: 'AMBULATORY' },
    );

    expect(document.validity).toBeNull();
    expect(document.prescriber.signedAt).toBeNull();
  });

  it('PR-024 nombra al paciente por apellidos y nombres, en ese orden', () => {
    // Es el orden del art. 5.b.i y el de todo documento oficial ecuatoriano.
    // Invertirlo es cómo una receta se archiva bajo la letra equivocada.
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.patient.fullName).toBe('Guamán Tipán María José');
  });

  it('PR-025 da la edad en años y meses porque el paciente es menor de cinco', () => {
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.patient.age).toEqual({
      years: 1,
      months: 2,
      text: '1 año 2 meses',
    });
  });

  it('PR-026 lleva el diagnóstico CIE de la atención, congelado', () => {
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.diagnoses).toEqual([
      { code: 'J020', display: 'Faringitis estreptocócica' },
    ]);
  });

  it('PR-027 lleva los antecedentes de alergias', () => {
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.allergies).toEqual(['Penicilina']);
  });

  it('PR-029 escribe la vía entera y nunca su sigla', () => {
    // Art. 13: la receta electrónica se emite «sin siglas o abreviaturas».
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.items[0]?.route).toBe('Vía oral');
  });

  it('PR-029 deja la vía en blanco antes que imprimir un código desconocido', () => {
    // La columna es un `varchar` libre: lo que un import escribiera podría ser
    // «VO», que es justo la abreviatura que el art. 13 prohíbe.
    const document = composeDocument(
      source({
        prescription: {
          ...source().prescription,
          items: [{ ...source().prescription.items[0]!, routeCode: 'VO' }],
        },
      }),
      { context: 'AMBULATORY' },
    );

    expect(document.items[0]?.route).toBeNull();
  });

  it('PR-030 lleva la cantidad en números Y en letras', () => {
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.items[0]?.quantity).toBe(20);
    expect(document.items[0]?.quantityInWords).toBe('veinte');
  });

  it('PR-031 lleva dosis, frecuencia y duración', () => {
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.items[0]?.doseText).toBe('1 cápsula');
    expect(document.items[0]?.frequencyText).toBe('Cada 8 horas');
    expect(document.items[0]?.durationDays).toBe(7);
  });

  it('PR-033 nombra al prescriptor por apellidos y nombres, y PR-034 lleva su registro ACESS', () => {
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.prescriber.fullName).toBe('Villacís Ana');
    expect(document.prescriber.acessRegistration).toBe('ACESS-11223');
  });

  it('PR-035 no lleva ningún trazo por firma: sólo quién y cuándo', () => {
    // «No se aceptarán rúbricas o trazos por firma» (art. 5.d.iii), y el art.
    // 3.r define «trazo» expresamente para cerrar esa puerta.
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.prescriber.signedAt).toEqual(ISSUED_AT);
    expect(Object.keys(document.prescriber)).toEqual([
      'fullName',
      'acessRegistration',
      'contactPhone',
      'signedAt',
    ]);
  });

  it('PR-021 deja la ciudad en nulo cuando la sede no tiene parroquia', () => {
    // Emitir en esas condiciones lo impide `PRESCRIPTION_ESTABLISHMENT_INCOMPLETE`;
    // aquí sólo se comprueba que el documento no la invente.
    const document = composeDocument(
      source({ site: { ...source().site, city: null } }), // prettier-ignore
      { context: 'AMBULATORY' },
    );

    expect(document.city).toBeNull();
  });

  it('PR-030 no escribe letras donde no hay cantidad', () => {
    const document = composeDocument(
      source({
        prescription: {
          ...source().prescription,
          items: [{ ...source().prescription.items[0]!, quantity: null }],
        },
      }),
      { context: 'AMBULATORY' },
    );

    expect(document.items[0]?.quantityInWords).toBeNull();
  });

  it('PR-020 lleva el número secuencial de la receta, distinto del código de verificación', () => {
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.sequenceNumber).toBe(120);
    expect(document.verificationCode).toBe('A1B2C3D4E5F60718');
  });

  it('PR-038 PR-039 lleva los signos de alarma y las recomendaciones no farmacológicas', () => {
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.warningSigns).toBe(
      'Fiebre mayor de 39 °C o dificultad para respirar',
    );
    expect(document.nonPharmacologicalAdvice).toBe(
      'Abundantes líquidos y reposo relativo',
    );
  });

  it('PR-028 cada línea lleva la DCI como la congeló el CNMB, entera', () => {
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.items[0]?.genericName).toBe('Amoxicilina');
  });

  it('PR-037 cada línea lleva sus indicaciones en una frase completa: DCI, dosis, frecuencia, vía y duración, sin abreviaturas', () => {
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.items[0]?.indications).toBe(
      'Amoxicilina 500 mg: 1 cápsula, cada 8 horas, por vía oral, durante 7 días. Tomar con alimentos',
    );
  });

  it('PR-037 una vía que el sistema no sabe nombrar no se imprime como sigla en las indicaciones', () => {
    const base = source();
    const document = composeDocument(
      {
        ...base,
        prescription: {
          ...base.prescription,
          items: [
            {
              ...base.prescription.items[0]!,
              routeCode: 'VO',
              instructions: null,
            },
          ],
        },
      },
      { context: 'AMBULATORY' },
    );

    expect(document.items[0]?.indications).toBe(
      'Amoxicilina 500 mg: 1 cápsula, cada 8 horas, durante 7 días',
    );
    expect(document.items[0]?.indications).not.toContain('VO');
  });

  it('PR-040 lleva el teléfono de contacto permanente del prescriptor', () => {
    const document = composeDocument(source(), { context: 'AMBULATORY' });

    expect(document.prescriber.contactPhone).toBe('0991234567');
  });

  it('PR-052 acorta la vigencia cuando la receta lleva un antimicrobiano de emergencia', () => {
    const document = composeDocument(source(), {
      context: 'EMERGENCY',
      antimicrobial: true,
    });

    expect(document.validity).toEqual({ days: 1, through: '2026-09-14' });
  });
});
