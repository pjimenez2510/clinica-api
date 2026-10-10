import type { IdentityNames } from './identity-proposal';

/**
 * IL-005. Splitting the single «APELLIDOS NOMBRES» field of the SRI registry.
 *
 * ⚠️ A CONVENTION, NOT A FACT. The Ecuadorian cedula prints surnames first
 * and the registry follows it, but the field is one string: «DE LA TORRE ALBA
 * MARIA JOSE» and «ALBA MARIA JOSE» do not say where the surnames end. The
 * rule below is applied and the proposal is marked «revise el orden» (D-209
 * stays the author's): it saves typing, it does not decide.
 *
 * PURE DOMAIN: no I/O, no clock, no framework.
 */

/**
 * Words that belong to the word after them: «DE LA TORRE» is one surname, and
 * «MARIA DE LOS ANGELES» one name.
 */
const PARTICLES = new Set([
  'DE',
  'DEL',
  'LA',
  'LAS',
  'LOS',
  'SAN',
  'SANTA',
  'Y',
  'DA',
  'DI',
  'VAN',
  'VON',
]);

/** Collapses spaces; the case is the source's, as it wrote it. */
export function normaliseRegistryName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** The words of a name, with each run of particles joined to the next word. */
function units(name: string): string[] {
  const result: string[] = [];
  let pending: string[] = [];
  for (const word of name.split(' ')) {
    if (word === '') continue;
    if (PARTICLES.has(word.toUpperCase())) {
      pending.push(word);
      continue;
    }
    result.push([...pending, word].join(' '));
    pending = [];
  }
  // Particles at the very end («... DE») stay with the last word.
  if (pending.length > 0) {
    if (result.length === 0) result.push(pending.join(' '));
    else result[result.length - 1] = [result[result.length - 1], ...pending].join(' '); // prettier-ignore
  }
  return result;
}

/**
 * IL-005. Surnames first, then names, in the order of the cedula:
 *
 *   one word    → first surname
 *   two         → first surname · first name
 *   three       → both surnames · first name
 *   four or more → both surnames · first name · the rest as the second name
 */
export function splitRegistryName(raw: string): IdentityNames {
  const parts = units(normaliseRegistryName(raw));
  return {
    familyName: parts[0] ?? null,
    secondFamilyName: parts.length >= 3 ? parts[1]! : null,
    givenName:
      parts.length === 2 ? parts[1]! : parts.length >= 3 ? parts[2]! : null,
    secondGivenName: parts.length >= 4 ? parts.slice(3).join(' ') : null,
  };
}

/**
 * IL-005. A source that already separates surnames from names (the provider)
 * still writes both surnames in one string: the first word —with its
 * particles— is the first one, the rest the second.
 */
export function splitPair(
  raw: string | null | undefined,
): [string | null, string | null] {
  const parts = units(normaliseRegistryName(raw ?? ''));
  return [parts[0] ?? null, parts.length > 1 ? parts.slice(1).join(' ') : null];
}
