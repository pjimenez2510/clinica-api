import type { ServiceKind } from './billing.repository';
import { MAX_VOUCHER_SERVICE_CODE } from './invoice';

/**
 * BI-280. The code a new service is proposed when the administrator does not
 * type one: the prefix of its kind and its name in capitals, without accents,
 * as the seed writes them (`LAB-GLUCOSA-AYUNAS`, `PROC-SUTURA`). Never longer
 * than the 25 characters the SRI admits as `codigoPrincipal` (BI-171), and
 * never one already taken: the first free `-2`, `-3`… wins.
 *
 * Pure: the codes already taken come from the caller. `service_code_unique`
 * still arbitrates a race between two administrators.
 */
export function proposeServiceCode(
  kind: ServiceKind,
  name: string,
  taken: ReadonlySet<string>,
): string {
  const prefix = CODE_PREFIXES[kind];
  const words = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    // «Consulta de cardiología · Control»: the prefix already says it.
    .replace(/^CONSULTA(-DE(L|-LA)?)?-/, '');
  const base = fit(
    `${prefix}-${words || 'SERVICIO'}`,
    MAX_VOUCHER_SERVICE_CODE,
  );
  if (!taken.has(base)) return base;

  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${fit(base, MAX_VOUCHER_SERVICE_CODE - tail.length)}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The prefix every code of a kind starts with. */
export const CODE_PREFIXES: Readonly<Record<ServiceKind, string>> = {
  CONSULTATION: 'CONS',
  PROCEDURE: 'PROC',
  LAB_EXAM: 'LAB',
  IMAGING: 'IMG',
  SUPPLY: 'INS',
  OTHER: 'OTR',
};

/** Cut at a word boundary when it can, never leaving a trailing dash. */
function fit(code: string, length: number): string {
  if (code.length <= length) return code;
  const cut = code.slice(0, length);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > 4 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}
