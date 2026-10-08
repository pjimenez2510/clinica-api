/**
 * SP-030 (D-179.3). How the service a service type is born with is NAMED and
 * CODED. Pure, so the screen's promise —«Medicina General · Control»— and the
 * row are the same string.
 */

/** «<especialidad> · <tipo>»: what the invoice line and Prestaciones read. */
export function consultationServiceName(
  specialtyName: string,
  typeName: string,
): string {
  return `${specialtyName.trim()} · ${typeName.trim()}`.slice(0, 200);
}

/** BI-171. The SRI's main code of an invoice line takes 25 characters. */
const MAX_CODE = 25;

/**
 * `CONS-` + the initials of the specialty's code + the type's name, upper
 * case and without accents: `medicina-general` · «Primera vez» →
 * `CONS-MG-PRIMERA-VEZ`. A candidate, not a guarantee: the adapter appends
 * `-2`, `-3`… while the code is taken, and `billable_service_code_unique`
 * arbitrates the race.
 */
export function consultationServiceCode(
  specialtyCode: string,
  typeName: string,
  attempt = 1,
): string {
  const initials = specialtyCode
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase())
    .join('');
  const slug = typeName
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = attempt > 1 ? `-${attempt}` : '';
  const base = `CONS-${initials}${slug ? `-${slug}` : ''}`;
  return `${base.slice(0, MAX_CODE - suffix.length).replace(/-+$/, '')}${suffix}`;
}
