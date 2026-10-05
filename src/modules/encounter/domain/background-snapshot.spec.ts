import { describe, expect, it } from 'vitest';

import {
  BACKGROUND_SNAPSHOT_KEY,
  backgroundSnapshotIn,
  backgroundSnapshotOf,
  coversBackgroundSection,
  withBackgroundSnapshot,
} from './background-snapshot';
import { NoteContentIncompleteError } from './encounter.errors';
import { contentHashOf } from './clinical-note';
import { assertNoteComplete, builtInTemplate } from './note-template';
import type { AllergyAbsenceAssertion } from './patient-allergy.repository';
import type { HistoryView } from './patient-history.repository';
import type { ActiveAllergy } from '../../../shared/clinical/patient-allergy.port';

/**
 * EN-206, EN-207. What the signature freezes of the patient's background, and
 * when it is enough to count the «antecedentes» section as written.
 *
 * The instants are taken from the clock and never typed: what matters here is
 * that the snapshot carries them, not which day they are.
 */

const NOW = new Date();
const EARLIER = new Date(NOW.getTime() - 86_400_000);

const PENICILLIN: ActiveAllergy = {
  id: 'allergy-1',
  patientId: 'patient-1',
  substanceConceptId: 'cnmb-1',
  substanceText: 'Penicilina',
  reaction: 'Urticaria',
  criticality: 'HIGH',
  recordedAt: EARLIER,
};

const NONE_KNOWN: AllergyAbsenceAssertion = {
  id: 'absence-1',
  patientId: 'patient-1',
  assertedById: 'user-1',
  assertedByName: 'Dra. Villacís',
  assertedAt: EARLIER,
};

const author = { id: 'user-1', name: 'Dra. Villacís' };

const DIABETES_MOTHER: HistoryView = {
  id: 'history-1',
  patientId: 'patient-1',
  kind: 'FAMILY',
  description: 'Diabetes tipo 2',
  relative: 'Madre',
  recordedAt: EARLIER,
  recordedBy: author,
  refutedAt: null,
  refutedNotes: null,
  refutedBy: null,
};

const ASTHMA: HistoryView = {
  ...DIABETES_MOTHER,
  id: 'history-2',
  kind: 'PERSONAL',
  description: 'Asma en la infancia',
  relative: null,
};

const COMPLETE_002 = {
  motivoConsulta: 'Dolor abdominal',
  antecedentes: 'Apendicectomía a los 12 años',
  enfermedadActual: 'Dolor en epigastrio',
  revisionOrganosSistemas: 'Sin particularidades',
  examenFisico: 'Abdomen blando',
  planTratamiento: 'Dieta blanda',
};

const snapshot = (input: {
  allergies?: ActiveAllergy[];
  noKnownAllergies?: AllergyAbsenceAssertion | null;
  history?: HistoryView[];
}) =>
  backgroundSnapshotOf({
    takenAt: NOW,
    allergies: input.allergies ?? [],
    noKnownAllergies: input.noKnownAllergies ?? null,
    history: input.history ?? [],
  });

describe('la foto de alergias y antecedentes al firmar', () => {
  it('EN-206 guarda las alergias activas, la afirmación y los antecedentes separados en personales y familiares', () => {
    expect(
      snapshot({ allergies: [PENICILLIN], history: [DIABETES_MOTHER, ASTHMA] }),
    ).toEqual({
      takenAt: NOW.toISOString(),
      allergies: [
        {
          substance: 'Penicilina',
          reaction: 'Urticaria',
          criticality: 'HIGH',
          recordedAt: EARLIER.toISOString(),
        },
      ],
      noKnownAllergies: null,
      personalHistory: [
        {
          description: 'Asma en la infancia',
          recordedAt: EARLIER.toISOString(),
        },
      ],
      familyHistory: [
        {
          description: 'Diabetes tipo 2',
          relative: 'Madre',
          recordedAt: EARLIER.toISOString(),
        },
      ],
    });
  });

  it('EN-206 guarda quién afirmó «sin alergias conocidas» y cuándo', () => {
    expect(snapshot({ noKnownAllergies: NONE_KNOWN }).noKnownAllergies).toEqual(
      {
        assertedByName: 'Dra. Villacís',
        assertedAt: EARLIER.toISOString(),
      },
    );
  });

  it('EN-206 sustituye la foto que mande la pantalla por la del servidor', () => {
    const forged = {
      ...COMPLETE_002,
      [BACKGROUND_SNAPSHOT_KEY]: { allergies: [] },
    };
    const real = snapshot({ allergies: [PENICILLIN] });

    const content = withBackgroundSnapshot(forged, real);

    expect(backgroundSnapshotIn(content)).toEqual(real);
  });

  it('EN-206 quita la foto que mande la pantalla cuando no hay que poner ninguna', () => {
    const forged = {
      ...COMPLETE_002,
      [BACKGROUND_SNAPSHOT_KEY]: { allergies: [] },
    };

    const content = withBackgroundSnapshot(forged, null);

    expect(content).not.toHaveProperty(BACKGROUND_SNAPSHOT_KEY);
    expect(backgroundSnapshotIn(content)).toBeNull();
  });

  it('EN-206 la foto entra en el hash: con otra foto, otro resumen', () => {
    const signedById = 'practitioner-1';
    const withAllergy = withBackgroundSnapshot(
      COMPLETE_002,
      snapshot({ allergies: [PENICILLIN] }),
    );
    const withoutAllergy = withBackgroundSnapshot(COMPLETE_002, snapshot({}));

    expect(
      contentHashOf({ content: withAllergy, signedById, signedAt: NOW }),
    ).not.toBe(
      contentHashOf({ content: withoutAllergy, signedById, signedAt: NOW }),
    );
  });
});

describe('la sección de antecedentes cubierta por lo registrado', () => {
  const form = builtInTemplate('002');
  const noText = { ...COMPLETE_002, antecedentes: '' };

  it('EN-207 da por escrita la sección sin texto si hay una alergia registrada', () => {
    expect(coversBackgroundSection(snapshot({ allergies: [PENICILLIN] }))).toBe(
      true,
    );
    expect(() =>
      assertNoteComplete(
        form,
        withBackgroundSnapshot(noText, snapshot({ allergies: [PENICILLIN] })),
      ),
    ).not.toThrow();
  });

  it('EN-207 da por escrita la sección sin texto si hay un antecedente registrado', () => {
    expect(() =>
      assertNoteComplete(
        form,
        withBackgroundSnapshot(
          noText,
          snapshot({ history: [DIABETES_MOTHER] }),
        ),
      ),
    ).not.toThrow();
  });

  it('EN-207 no la da por escrita solo con «sin alergias conocidas» (D-125)', () => {
    expect(
      coversBackgroundSection(snapshot({ noKnownAllergies: NONE_KNOWN })),
    ).toBe(false);
    expect(() =>
      assertNoteComplete(
        form,
        withBackgroundSnapshot(
          noText,
          snapshot({ noKnownAllergies: NONE_KNOWN }),
        ),
      ),
    ).toThrow(NoteContentIncompleteError);
  });

  it('EN-207 sigue pidiendo texto si no hay nada registrado', () => {
    expect(() =>
      assertNoteComplete(form, withBackgroundSnapshot(noText, snapshot({}))),
    ).toThrow(NoteContentIncompleteError);
  });

  it('EN-207 una foto no cubre ninguna otra sección', () => {
    expect(() =>
      assertNoteComplete(
        form,
        withBackgroundSnapshot(
          { ...COMPLETE_002, examenFisico: '' },
          snapshot({ allergies: [PENICILLIN] }),
        ),
      ),
    ).toThrow(NoteContentIncompleteError);
  });
});
