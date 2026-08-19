import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { specialtyCodeFromName } from './specialty-code';

/**
 * SP-009: nobody types the stable code any more, so the derivation has to be
 * as good as the hand-written one it replaces.
 *
 * The 22 MSP codes are read FROM THE SEED, not copied here: a copy would keep
 * passing the day somebody edits `prisma/seed-specialties.mts`, which is the
 * exact moment this test exists to catch. Same shape as
 * `error-catalogue.spec.ts` and `spec-traceability.spec.ts` — read the source,
 * compare, fail loud.
 */
const SEED_PATH = join(process.cwd(), 'prisma', 'seed-specialties.mts');
const SEED_ENTRY = /\{\s*code:\s*'([^']+)',\s*name:\s*'([^']+)'\s*\}/g;

function seededSpecialties(): { code: string; name: string }[] {
  const source = readFileSync(SEED_PATH, 'utf8');
  const entries: { code: string; name: string }[] = [];
  for (const match of source.matchAll(SEED_ENTRY)) {
    if (match[1] && match[2]) entries.push({ code: match[1], name: match[2] });
  }
  return entries;
}

describe('specialtyCodeFromName', () => {
  const seeded = seededSpecialties();

  it('SP-009 reproduce EXACTAMENTE los 22 códigos del MSP que ya están sembrados', () => {
    // If this list ever shrinks, the check below would silently assert nothing.
    expect(seeded).toHaveLength(22);

    const derived = seeded.map(({ name }) => ({
      name,
      code: specialtyCodeFromName(name),
    }));

    // Compared WHOLE and not one by one: the failure message then names every
    // specialty that drifted, which is what tells you whether the derivation
    // is wrong or the seed changed.
    expect(derived).toEqual(seeded.map(({ code, name }) => ({ name, code })));
  });

  it('SP-009 pasa el nombre a minúsculas, sin tildes y con guiones', () => {
    expect(specialtyCodeFromName('Cirugía Plástica')).toBe('cirugia-plastica');
    expect(specialtyCodeFromName('Ñandú Ávila')).toBe('nandu-avila');
  });

  it('SP-009 no deja pasar ningún carácter que no sea letra, número o guion', () => {
    expect(specialtyCodeFromName('Medicina (interna) #2 · v1')).toMatch(
      /^[a-z0-9-]+$/,
    );
    expect(specialtyCodeFromName('  Salud   Mental  ')).toBe('salud-mental');
  });

  it('SP-009 descarta las palabras de enlace, que no identifican nada', () => {
    expect(specialtyCodeFromName('Ginecología y Obstetricia')).toBe(
      'ginecologia-obstetricia',
    );
    expect(specialtyCodeFromName('Medicina del Trabajo')).toBe(
      'medicina-trabajo',
    );
  });

  it('SP-009 se queda en las dos primeras palabras: un código es un asa, no el nombre', () => {
    expect(specialtyCodeFromName('Medicina de Emergencias y Desastres')).toBe(
      'medicina-emergencias',
    );
  });

  it('SP-009 devuelve vacío cuando el nombre no tiene nada de lo que derivar', () => {
    // The DTO refuses this name before it reaches the service; the function
    // stays total so the refusal has something to ask.
    expect(specialtyCodeFromName('🙂🙂')).toBe('');
    expect(specialtyCodeFromName('中医')).toBe('');
  });

  it('SP-009 usa las palabras de enlace cuando son lo único que hay', () => {
    // «de la» is not a specialty, but returning '' for it would send an
    // unhelpful refusal to somebody whose name IS made of letters.
    expect(specialtyCodeFromName('De La')).toBe('de-la');
  });

  it('SP-009 no supera los 64 caracteres que admite la columna', () => {
    const code = specialtyCodeFromName(`${'a'.repeat(50)} ${'b'.repeat(50)}`);
    expect(code.length).toBeLessThanOrEqual(64);
    expect(code).not.toMatch(/-$/);
  });
});
