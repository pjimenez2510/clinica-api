import { describe, expect, it } from 'vitest';

import { exactAllergyMatches, substanceKeysOf } from './allergy-check';
import type { KnownAllergy } from './allergy-check';

/**
 * PR-060, PR-064 to PR-067. The one allergy check this system is entitled to.
 *
 * ⚠️ HALF OF THIS FILE ASSERTS WHAT DOES **NOT** FIRE, and that is the
 * requirement rather than pedantry: in a study of 158 023 allergy warnings, 81 %
 * were overridden and more than 96 % of those overrides were clinically
 * correct. Every alert this function does not raise is what keeps the one it
 * does raise credible.
 */
const AMOXICILLIN = 'concept-amoxicillin';
const IBUPROFEN = 'concept-ibuprofen';

const allergyTo = (
  conceptId: string | null,
  overrides: Partial<KnownAllergy> = {},
): KnownAllergy => ({
  id: `allergy-${conceptId ?? 'text'}`,
  substanceConceptId: conceptId,
  substanceText: 'Registrada en la ficha',
  ...overrides,
});

describe('la comprobación de alergia', () => {
  it('PR-060 avisa cuando el principio activo recetado es exactamente el de la alergia', () => {
    const alerts = exactAllergyMatches(
      [{ line: 1, conceptId: AMOXICILLIN }],
      [allergyTo(AMOXICILLIN)],
    );

    expect(alerts).toEqual([
      { line: 1, allergyId: 'allergy-concept-amoxicillin', match: 'EXACT' },
    ]);
  });

  it('PR-060 señala la LÍNEA y no el medicamento', () => {
    // La alerta viaja al cliente, y de ahí a registros y capturas de soporte.
    // Un nombre de fármaco es un diagnóstico dicho de otra forma.
    const [alert] = exactAllergyMatches(
      [
        { line: 1, conceptId: IBUPROFEN },
        { line: 2, conceptId: AMOXICILLIN },
      ],
      [allergyTo(AMOXICILLIN)],
    );

    expect(alert?.line).toBe(2);
    expect(JSON.stringify(alert)).not.toContain('Registrada en la ficha');
  });

  it('PR-060 no avisa de un principio activo distinto', () => {
    expect(
      exactAllergyMatches(
        [{ line: 1, conceptId: IBUPROFEN }],
        [allergyTo(AMOXICILLIN)],
      ),
    ).toEqual([]);
  });

  it('PR-064 no avisa cuando la alergia sólo tiene texto libre', () => {
    // Alimentos, látex, picaduras. El nivel 1 compara CLAVES: comparar textos
    // es exactamente cómo se fabrican las alertas falsas —«penicilina» no casa
    // con «amoxicilina», y «polvo» casa con «polvo para suspensión»—.
    expect(
      exactAllergyMatches(
        [{ line: 1, conceptId: AMOXICILLIN }],
        [allergyTo(null, { substanceText: 'Amoxicilina' })],
      ),
    ).toEqual([]);
  });

  it('PR-064 no avisa cuando la línea receta fuera del CNMB', () => {
    // Sin concepto no hay clave que comparar, y adivinar por el nombre es la
    // misma trampa vista desde el otro lado.
    expect(
      exactAllergyMatches([{ line: 1, conceptId: null }], [allergyTo(AMOXICILLIN)]), // prettier-ignore
    ).toEqual([]);
  });

  it('PR-062 avisa una vez por cada alergia que coincide, incluidas las de la ficha absorbida', () => {
    // La misma sustancia registrada en las dos fichas de una fusión da dos
    // avisos: unirlos escondería que la evidencia viene de dos sitios.
    const alerts = exactAllergyMatches(
      [{ line: 1, conceptId: AMOXICILLIN }],
      [
        allergyTo(AMOXICILLIN, { id: 'de-la-viva' }),
        allergyTo(AMOXICILLIN, { id: 'de-la-absorbida' }),
      ],
    );

    expect(alerts.map((alert) => alert.allergyId)).toEqual([
      'de-la-viva',
      'de-la-absorbida',
    ]);
  });

  it('PR-066 no avisa de nada que no sea coincidencia exacta', () => {
    /**
     * Ni clase terapéutica (PR-065, falta el ATC) ni reactividad cruzada
     * (PR-066, base de conocimiento comercial). Esta prueba es la que rompe el
     * día que alguien «mejore» la función con una heurística de nombres, que es
     * exactamente lo que produce la lista de advertencias que nadie audita.
     */
    const alerts = exactAllergyMatches(
      [{ line: 1, conceptId: 'concept-cefalexina' }],
      [allergyTo('concept-penicilina', { substanceText: 'Penicilina' })],
    );

    expect(alerts).toEqual([]);
  });

  it('PR-060 no avisa cuando no hay nada recetado ni nada registrado', () => {
    expect(exactAllergyMatches([], [allergyTo(AMOXICILLIN)])).toEqual([]);
    expect(
      exactAllergyMatches([{ line: 1, conceptId: AMOXICILLIN }], []),
    ).toEqual([]);
  });

  describe('PR-114 a través de las ediciones del CNMB', () => {
    // Cada edición del cuadro crea conceptos nuevos: la amoxicilina de la
    // edición anterior y la de la nueva tienen ids distintos y el mismo código.
    const OLD = 'concept-enalapril-dev';
    const NEW = 'concept-enalapril-2026';
    const keys = new Map([
      [OLD, substanceKeysOf({ code: 'ENALAPRIL', display: 'Enalapril', attributes: null })], // prettier-ignore
      [NEW, substanceKeysOf({ code: 'C09AA02', display: 'Enalapril', attributes: { replaces: ['ENALAPRIL'], substances: ['dci:enalapril'] } })], // prettier-ignore
      [IBUPROFEN, substanceKeysOf({ code: 'M01AE01', display: 'Ibuprofeno', attributes: null })], // prettier-ignore
    ]);

    it('PR-114 avisa al recetar la edición nueva de un medicamento cuya alergia se registró contra la anterior', () => {
      expect(
        exactAllergyMatches(
          [{ line: 1, conceptId: NEW }],
          [allergyTo(OLD)],
          keys,
        ),
      ).toEqual([{ line: 1, allergyId: `allergy-${OLD}`, match: 'EXACT' }]);
    });

    it('PR-114 avisa también en el otro sentido: alergia a la nueva, borrador con la anterior', () => {
      expect(
        exactAllergyMatches(
          [{ line: 1, conceptId: OLD }],
          [allergyTo(NEW)],
          keys,
        ),
      ).toHaveLength(1);
    });

    it('PR-114 no avisa de otro medicamento aunque los dos tengan claves', () => {
      expect(
        exactAllergyMatches(
          [{ line: 1, conceptId: IBUPROFEN }],
          [allergyTo(NEW)],
          keys,
        ),
      ).toEqual([]);
    });

    it('PR-114 las claves son el código, los que sustituye y sus principios activos, sin repetir ni vacíos', () => {
      expect(
        substanceKeysOf({
          code: 'C09AA02',
          display: 'Enalapril',
          attributes: {
            replaces: ['ENALAPRIL', '', 7],
            substances: ['dci:enalapril', 3],
          },
        }),
      ).toEqual(['C09AA02', 'ENALAPRIL', 'dci:enalapril']);
      // Sin principios activos declarados (el cuadro de desarrollo), el nombre.
      expect(
        substanceKeysOf({ code: 'ACIDO-ACETILSALICILICO', display: 'Ácido  Acetilsalicílico', attributes: null }), // prettier-ignore
      ).toEqual(['ACIDO-ACETILSALICILICO', 'dci:acido acetilsalicilico']);
    });

    it('PR-114 el mismo principio activo bajo dos códigos del cuadro es la misma sustancia', () => {
      // El cuadro reparte el ácido acetilsalicílico en B01AC06 (100 mg) y
      // N02BA01 (500 mg): la alergia a uno salta con el otro.
      const aspirin = new Map([
        ['b01ac06', substanceKeysOf({ code: 'B01AC06', display: 'Ácido acetilsalicílico', attributes: { substances: ['dci:acido acetilsalicilico'] } })], // prettier-ignore
        ['n02ba01', substanceKeysOf({ code: 'N02BA01', display: 'Ácido acetilsalicílico', attributes: { substances: ['dci:acido acetilsalicilico'] } })], // prettier-ignore
        ['dev', substanceKeysOf({ code: 'ACIDO-ACETILSALICILICO', display: 'Ácido acetilsalicílico', attributes: null })], // prettier-ignore
      ]);

      expect(
        exactAllergyMatches([{ line: 1, conceptId: 'n02ba01' }], [allergyTo('b01ac06')], aspirin), // prettier-ignore
      ).toHaveLength(1);
      expect(
        exactAllergyMatches([{ line: 1, conceptId: 'n02ba01' }], [allergyTo('dev')], aspirin), // prettier-ignore
      ).toHaveLength(1);
    });
  });
});
