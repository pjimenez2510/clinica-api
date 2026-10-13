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

  it('AS-282 an empty wording, or one longer than the phrase, is not believed', () => {
    expect(groundedWording('', ROSA)).toBe(false);
    expect(groundedWording('   ', ROSA)).toBe(false);
    expect(groundedWording(`${ROSA} ${ROSA}`, ROSA)).toBe(false);
  });
});
