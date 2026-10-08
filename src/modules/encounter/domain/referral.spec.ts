import { describe, expect, it } from 'vitest';

import { requireForm } from './clinical-note';
import { builtInTemplate } from './note-template';
import {
  ANSWERABLE_DIRECTIONS,
  OUTGOING_DIRECTIONS,
  REFERRAL_DIRECTIONS,
  interconsultationFormContent,
  referralFormContent,
  type ReferralDraft,
} from './referral';

const DRAFT: ReferralDraft = {
  direction: 'REFERRAL',
  destination: { mspUnicode: '05176', name: 'Hospital General de Chone' },
  specialtyId: 'specialty-1',
  priority: 'URGENT',
  reason: 'Dolor torácico atípico',
  summary: 'ECG sin cambios agudos',
  respondsToId: null,
};

const DIAGNOSES = [
  { code: 'I10.X', display: 'Hipertensión esencial', principal: false },
  { code: 'R07.4', display: 'Dolor torácico, no especificado', principal: true }, // prettier-ignore
];

describe('EN-100 las cuatro direcciones', () => {
  it('EN-100 son cuatro, en el orden de la columna 109, y la inversa no es ninguna de las otras', () => {
    expect(REFERRAL_DIRECTIONS).toEqual([
      'REFERRAL',
      'COUNTER_REFERRAL',
      'DERIVATION',
      'REVERSE_REFERRAL',
    ]);
  });

  it('EN-105 el egreso «Referido» lo cumplen las tres que envían al paciente; la contrarreferencia lo devuelve', () => {
    expect(OUTGOING_DIRECTIONS).toEqual([
      'REFERRAL',
      'DERIVATION',
      'REVERSE_REFERRAL',
    ]);
    expect(OUTGOING_DIRECTIONS).not.toContain('COUNTER_REFERRAL');
  });

  it('EN-102 una contrarreferencia responde a una referencia o a una derivación, nunca a otra respuesta', () => {
    expect(ANSWERABLE_DIRECTIONS).toEqual(['REFERRAL', 'DERIVATION']);
  });
});

describe('EN-104 el contenido del formulario 053', () => {
  it('EN-104 EN-101 EN-106 lleva el tipo, el destino con su UNICÓDIGO, el motivo y los diagnósticos con el principal primero', () => {
    const content = referralFormContent(DRAFT, {
      specialtyName: 'Cardiología',
      diagnoses: DIAGNOSES,
      answered: null,
    });

    expect(content).toEqual({
      tipo: 'Referencia',
      establecimientoDestino: 'Hospital General de Chone (UNICÓDIGO 05176)',
      especialidad: 'Cardiología',
      prioridad: 'Urgente',
      motivo: 'Dolor torácico atípico',
      resumen: 'ECG sin cambios agudos',
      diagnosticos:
        'R07.4 Dolor torácico, no especificado (principal); I10.X Hipertensión esencial',
    });
  });

  it('EN-102 la contrarreferencia dice a qué referencia responde y no imprime destino', () => {
    const content = referralFormContent(
      {
        ...DRAFT,
        direction: 'COUNTER_REFERRAL',
        destination: null,
        specialtyId: null,
        summary: null,
        respondsToId: 'referral-1',
      },
      {
        specialtyName: null,
        diagnoses: [],
        answered: {
          issuedOn: '01/10/2026',
          destinationName: 'Hospital General de Chone',
          reason: 'Dolor torácico atípico',
        },
      },
    );

    expect(content).toEqual({
      tipo: 'Contrarreferencia',
      prioridad: 'Urgente',
      motivo: 'Dolor torácico atípico',
      respondeA:
        'Referencia del 01/10/2026 · Hospital General de Chone · Dolor torácico atípico',
    });
  });

  it('EN-104 el 053 y el 007 son formularios del registro, escritos por su acto, con sus secciones en orden', () => {
    for (const code of ['053', '007']) {
      expect(requireForm(code, '1')).toMatchObject({
        writtenByItsAct: true,
        dischargesTheEncounter: false,
      });
    }
    expect(builtInTemplate('053').sections.map((each) => each.title)).toEqual([
      'Tipo',
      'Establecimiento de destino',
      'Especialidad',
      'Prioridad',
      'Motivo',
      'Resumen del cuadro clínico',
      'Diagnósticos',
      'Responde a',
    ]);
    // EN-106. Only the reason is required.
    expect(
      builtInTemplate('053')
        .sections.filter((each) => each.required)
        .map((each) => each.key),
    ).toEqual(['motivo']);
  });
});

describe('EN-104 el contenido del formulario 007', () => {
  it('EN-103 EN-104 la solicitada lleva especialidad, motivo, cuadro clínico y diagnósticos; lo vacío no se imprime', () => {
    expect(
      interconsultationFormContent(
        {
          role: 'REQUESTED',
          specialtyId: 'specialty-1',
          reason: 'Valorar soplo',
          findings: '  ',
        },
        { specialtyName: 'Cardiología', diagnoses: [] },
      ),
    ).toEqual({
      tipo: 'Interconsulta solicitada',
      especialidad: 'Cardiología',
      motivo: 'Valorar soplo',
    });
  });
});
