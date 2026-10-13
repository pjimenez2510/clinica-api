import { describe, expect, it } from 'vitest';

import { groundedWording } from './complaint-wording';

const ROSA =
  'Ay, señorita, tengo un dolor de cabeza muy fuerte desde hace dos días y me siento mareada.';

/** Each pair: what the patient said, and a wording the barrier must not believe. */
const changed = (cases: [string, string][]) =>
  cases.map(([source, wording]) => groundedWording(wording, source));

describe('AS-282 a reason worded only from what the patient said', () => {
  it('AS-282 believes the wording of the nurse when it says all the patient said and nothing else', () => {
    expect(groundedWording('Dolor de cabeza muy fuerte desde hace dos días, con sensación de mareo', ROSA)).toBe(true); // prettier-ignore
    expect(groundedWording('Dolor de cabeza muy fuerte desde hace dos días y se siente mareada.', ROSA)).toBe(true); // prettier-ignore
    expect(groundedWording('Dolor en la espalda y el pecho desde ayer.', 'Me duele la espalda y el pecho desde ayer.')).toBe(true); // prettier-ignore
    expect(groundedWording('Dolores de cabeza', 'Ay, me dan dolores de cabeza.')).toBe(true); // prettier-ignore
  });

  it('AS-282 a «no sé» or a «¿no?» at the end denies nothing', () => {
    expect(groundedWording('Dolor de cabeza', 'No sé, señorita, me duele la cabeza.')).toBe(true); // prettier-ignore
    expect(groundedWording('Dolor de cabeza', 'Me duele la cabeza, ¿no?')).toBe(true); // prettier-ignore
  });

  it('AS-282 a duration, a number or a word the patient did not say is not believed', () => {
    expect(
      changed([
        [ROSA, 'Dolor de cabeza muy fuerte desde hace dos semanas y mareo'],
        [ROSA, 'Dolor de cabeza muy fuerte desde hace 3 días y mareo'],
        [
          ROSA,
          'Dolor de cabeza muy fuerte con fiebre desde hace dos días y mareo',
        ],
        [ROSA, 'Cefalea muy fuerte de dos días y mareo'],
        ['Me duelen los pies desde ayer.', 'Dolor en la piel desde ayer'],
        ['Me duele cuando estoy sentada.', 'Dolor en el seno'],
        ['Tengo diarrea desde ayer.', 'Diarrea desde hace días'],
        ['Me duele la cabeza, pero poco fuerte.', 'Dolor de cabeza muy fuerte'],
        ['El dolor está menos fuerte que ayer.', 'Dolor más fuerte que ayer'],
      ]),
    ).toEqual(Array(9).fill(false));
  });

  it('AS-282 what the patient said and the wording leaves out is not believed', () => {
    expect(
      changed([
        ['Me duele la cabeza y me desmayé esta mañana.', 'Dolor de cabeza'],
        [
          'Estoy embarazada de 8 semanas y tengo sangrado vaginal.',
          'Sangrado vaginal',
        ],
        ['Me duele el pecho y me falta el aire.', 'Dolor de pecho'],
        [ROSA, 'Mareo'],
        [ROSA, 'Dolor de cabeza muy fuerte desde hace días y mareo'],
      ]),
    ).toEqual(Array(5).fill(false));
  });

  it('AS-282 a phrase that denies, names someone else, both sides or more than one duration keeps its own words', () => {
    expect(
      changed([
        [
          'No me duele el pecho, me duele la espalda.',
          'Sin dolor de espalda; dolor de pecho',
        ],
        [
          'No me duele el pecho, me duele la espalda.',
          'Sin dolor de pecho; dolor de espalda',
        ],
        [
          'No sé, señorita, me duele el pecho y tengo fiebre.',
          'Dolor de pecho sin fiebre',
        ],
        [
          'Tengo dos hijos y me duele la cabeza desde hace tres días.',
          'Dolor de cabeza desde hace dos días, dos hijos',
        ],
        [
          'Tengo fiebre desde hace dos días y tos desde hace una semana.',
          'Fiebre desde hace una semana y tos desde hace dos días',
        ],
        [
          'Me duele la cabeza desde hace una semana, y hace un mes me caí.',
          'Dolor de cabeza desde hace un mes, caí hace una semana',
        ],
        [
          'Me duele la rodilla derecha, la izquierda está bien.',
          'Dolor de rodilla izquierda, derecha bien',
        ],
        ['Mi mamá se siente mareada.', 'Paciente se siente mareada'],
        [
          'A mi esposo le duele el pecho, yo vengo por la presión.',
          'Dolor de pecho, presión',
        ],
        ['Mi hija tiene fiebre y yo vengo por la tos.', 'Fiebre y tos'],
      ]),
    ).toEqual(Array(10).fill(false));
  });

  it('AS-282 a wording that moves an attribute from one symptom to another is not believed (second review)', () => {
    expect(
      changed([
        [
          'Me duele la cabeza desde ayer y el estómago desde hoy.',
          'Dolor de estómago desde ayer y de cabeza desde hoy.',
        ],
        [
          'Tengo fiebre desde el lunes y me duele la cabeza desde el martes',
          'Dolor de cabeza desde el lunes, fiebre desde el martes',
        ],
        [
          'Me duele el brazo izquierdo y la pierna',
          'Dolor de pierna izquierda y brazo',
        ],
        [
          'Me duele leve la cabeza y fuerte el estómago',
          'Dolor fuerte de cabeza y leve de estómago',
        ],
        [
          'Se me quitó el dolor de cabeza pero sigo con tos',
          'Sigo con dolor de cabeza, se quitó la tos',
        ],
      ]),
    ).toEqual(Array(5).fill(false));
  });

  it('AS-282 someone else named in other words keeps the patient’s own words', () => {
    expect(
      changed([
        ['Mi señora tiene fiebre y yo tengo tos', 'Fiebre y tos'],
        [
          'Mi señor tiene fiebre y a mí me duele la cabeza',
          'Dolor de cabeza y fiebre',
        ],
        ['Mi hijito tiene tos y yo tengo fiebre', 'Hijito con tos y fiebre'],
        ['Mi guagua tiene fiebre', 'Guagua con fiebre'],
        ['A ella le duele la cabeza', 'Dolor de cabeza'],
        ['El niño tiene fiebre y yo tengo tos', 'Niño con fiebre y tos'],
        ['La guagua tiene fiebre y yo tengo tos', 'Guagua con fiebre y tos'],
        ['Mi ñaño tiene fiebre y yo tengo tos', 'Ñaño con fiebre y tos'],
        [
          'Mi compañero tiene fiebre y yo tengo tos',
          'Compañero con fiebre y tos',
        ],
        [
          'Mi guambra tiene fiebre y yo diarrea',
          'Guambra con fiebre y diarrea',
        ],
        [
          'Mi taita tiene dolor de pecho y yo mareo',
          'Taita con dolor de pecho y mareo',
        ],
        ['Mi ñaño con fiebre y yo con tos', 'Ñaño con fiebre y tos'],
        ['Mi ñaño vomita y yo tengo fiebre', 'Ñaño vomita con fiebre'],
        ['Mi compañero tose y yo tengo fiebre', 'Compañero tose y fiebre'],
        ['Mi guambra tuvo fiebre y yo tengo tos', 'Guambra tuvo fiebre y tos'],
        [
          'Mi taita presenta dolor de pecho y yo mareo',
          'Taita presenta dolor de pecho y mareo',
        ],
        ['Mi ñaño tenia fiebre y yo tengo tos', 'Ñaño tenia fiebre y tos'],
        [
          'Mi ñaño esta con fiebre y yo tengo tos',
          'Ñaño esta con fiebre y tos',
        ],
      ]),
    ).toEqual(Array(18).fill(false));
  });

  it('AS-282 a possessive is someone else’s even without «yo» (fifth review)', () => {
    expect(
      changed([
        ['Mi ñaño vomita y tengo fiebre', 'Ñaño con vómito y fiebre'],
        [
          'Mi ñaño vomita y me duele la cabeza',
          'Ñaño vomita y dolor de cabeza',
        ],
        ['Mi ñaño con fiebre y tengo tos', 'Ñaño con fiebre y tos'],
        [
          'Mi taita con dolor de pecho y estoy con mareo',
          'Taita con dolor de pecho y mareo',
        ],
      ]),
    ).toEqual(Array(4).fill(false));
    expect(groundedWording('Dolor de estómago y diarrea', 'Me duele el estómago y estoy con diarrea')).toBe(true); // prettier-ignore
  });

  it('AS-282 a root, a cause, an amount or a tense the patient did not say is not believed', () => {
    expect(
      changed([
        [
          'Ay, señorita, tengo estrés desde hace días',
          'Estreñimiento desde hace días',
        ],
        ['Ay señorita tengo pesadillas desde ayer', 'Pesadez desde ayer'],
        ['Me duele el pecho y camino', 'Dolor de pecho al caminar'],
        ['Me duele el pecho y tengo tos', 'Dolor de pecho por la tos'],
        [
          'Ay señorita, fiebre desde hace un día',
          'Fiebre desde hace unos días',
        ],
        ['Tos desde hace una semana', 'Tos desde hace unas semanas'],
        ['Tenía fiebre', 'Fiebre'],
        ['Me dolió', 'Dolor'],
        ['Me dolía la cabeza', 'Dolor de cabeza'],
        ['Desde ayer no sé caminar bien', 'Camina bien desde ayer'],
      ]),
    ).toEqual(Array(10).fill(false));
    expect(groundedWording('Fiebre desde hace un día', 'Ay señorita, tengo fiebre desde hace un día')).toBe(true); // prettier-ignore
  });

  it('AS-282 an empty wording, or one longer than the phrase, is not believed', () => {
    expect(groundedWording('', ROSA)).toBe(false);
    expect(groundedWording('   ', ROSA)).toBe(false);
    expect(groundedWording(`${ROSA} ${ROSA}`, ROSA)).toBe(false);
  });
});
