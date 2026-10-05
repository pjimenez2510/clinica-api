import { describe, expect, it } from 'vitest';

import {
  PRIMARY_RANK,
  careModalityOfCie10,
  cie10CategoryOf,
  isPrimary,
  nextRankAfter,
} from './diagnosis';

/**
 * Block K's pure rules.
 *
 * ⚠️ WHAT IS NOT HERE, ON PURPOSE: the frozen snapshot (EN-041), the validity
 * of the concept on the day of care (EN-042) and the single principal
 * diagnosis (EN-043). All three are guarantees of PostgreSQL —
 * `trg_diagnosis_snapshot`, `trg_diagnosis_concept_in_force`,
 * `encounter_diagnosis_one_primary` — and a double returning what we asked it
 * for would prove none of them. They are exercised in
 * `test/integration/encounter-diagnoses.spec.ts` against a real database.
 */
describe('la clasificación de un diagnóstico', () => {
  it('EN-046 clasifica como prevención los códigos Z00 a Z99, que es la regla del instructivo', () => {
    expect(careModalityOfCie10('Z000')).toBe('PREVENTION');
    expect(careModalityOfCie10('Z34')).toBe('PREVENTION');
    // Uno de los dieciséis códigos de planificación familiar de EN-048.
    expect(careModalityOfCie10('Z3001')).toBe('PREVENTION');
    expect(careModalityOfCie10('Z999')).toBe('PREVENTION');
  });

  it('EN-046 clasifica como morbilidad todo lo demás', () => {
    expect(careModalityOfCie10('J02')).toBe('MORBIDITY');
    expect(careModalityOfCie10('E119')).toBe('MORBIDITY');
    expect(careModalityOfCie10('A09')).toBe('MORBIDITY');
  });

  it('EN-046 responde por diagnóstico, así que una misma atención puede ser las dos cosas', () => {
    /**
     * EL CASO QUE HACE IMPOSIBLE LA MARCA EN LA ATENCIÓN. Se controla el
     * embarazo (Z34) y además se trata una faringitis (J02) en la misma
     * consulta: con una sola casilla en `encounter.care_modality` hay que
     * elegir una y mentir en la otra, y las columnas 84 y 85 del reporte
     * piden las dos.
     */
    const modalities = ['Z34', 'J02'].map(careModalityOfCie10);
    expect(modalities).toEqual(['PREVENTION', 'MORBIDITY']);
  });

  it('EN-046 no se deja engañar por espacios ni por minúsculas', () => {
    expect(careModalityOfCie10(' z348 ')).toBe('PREVENTION');
  });

  it('EN-043 llama principal al diagnóstico de rango 1 y a ningún otro', () => {
    expect(PRIMARY_RANK).toBe(1);
    expect(isPrimary(1)).toBe(true);
    expect(isPrimary(2)).toBe(false);
  });

  it('EN-043 hace principal al primer diagnóstico de la atención cuando nadie dice el orden', () => {
    expect(nextRankAfter([])).toBe(PRIMARY_RANK);
  });

  it('EN-047 pone cada diagnóstico siguiente detrás del último, sin límite de tres', () => {
    expect(nextRankAfter([1])).toBe(2);
    expect(nextRankAfter([1, 2])).toBe(3);
    // El cuarto existe: el recorte a tres es de la exportación, no del expediente.
    expect(nextRankAfter([1, 2, 3])).toBe(4);
  });

  it('EN-047 se apoya en el rango más alto en uso y no en el número de filas', () => {
    /**
     * Un recuento repartiría el 2 dos veces en cuanto alguien registrase un
     * diagnóstico con rango explícito 5, y el segundo chocaría con el primero
     * sin que nadie hubiera pedido ese orden.
     */
    expect(nextRankAfter([1, 5])).toBe(6);
  });
});

describe('la categoría CIE-10 (EN-184)', () => {
  it('EN-184 toma los tres primeros caracteres, con o sin punto', () => {
    expect(cie10CategoryOf('E119')).toBe('E11');
    expect(cie10CategoryOf('E11.6')).toBe('E11');
    expect(cie10CategoryOf('z3001')).toBe('Z30');
  });
});

describe('prevención o morbilidad, servida con cada diagnóstico (EN-186)', () => {
  it('EN-186 Z00 a Z99 es prevención y todo lo demás morbilidad, también los cinco caracteres de Ecuador', () => {
    expect(careModalityOfCie10('Z00')).toBe('PREVENTION');
    expect(careModalityOfCie10('Z3001')).toBe('PREVENTION');
    expect(careModalityOfCie10('Z99')).toBe('PREVENTION');
    expect(careModalityOfCie10('J02')).toBe('MORBIDITY');
    expect(careModalityOfCie10('Y98')).toBe('MORBIDITY');
  });
});
