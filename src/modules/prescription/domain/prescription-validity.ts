/**
 * PR-050 to PR-053. How long a pharmacy may dispense, derived and never typed.
 *
 * Arts. 17, 18 and 19 of the Resolución ACESS-2023-0030. Art. 17 states the
 * consequence — «posterior a lo cual, el servicio de farmacia no está autorizado
 * para dispensar» — and the other two state the numbers.
 *
 * PURE: no clock and no database. The instant of issue comes in as a parameter,
 * which is what lets the time-zone behaviour be exercised at all.
 */

import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import type { DispensingContext } from './prescription';

/**
 * PR-050, PR-051. Art. 18, literally.
 *
 * ⚠️ TWO OF THE THREE ARE UNREACHABLE TODAY (PR-051): nothing in the schema
 * records the modality, and this clinic is outpatient only. They are written
 * because the rule has three values, and because the day an emergency service
 * exists the number changes without anybody being told.
 */
export const VALIDITY_DAYS: Readonly<Record<DispensingContext, number>> = {
  /** Art. 18.b — «Atención ambulatoria o consulta externa: tres (03) días». */
  AMBULATORY: 3,
  /** Art. 18.a — «Área de emergencia: un (01) día». */
  EMERGENCY: 1,
  /** Art. 18.c — «Hospitalización: un (01) día». */
  HOSPITALISATION: 1,
};

/** PR-052. Art. 19 — «tres (03) días contados a partir de su prescripción». */
export const ANTIMICROBIAL_VALIDITY_DAYS = 3;

/**
 * PR-050 to PR-052. The days this prescription is good for.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHEN THE TWO RULES CONCUR, THE SHORTER ONE WINS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Art. 18 sets the validity by where it is dispensed and art. 19 sets it for
 * antimicrobials, and nothing in the norm says which governs an antimicrobial
 * prescribed in an emergency. Taking the SHORTER is the only reading that
 * cannot authorise a dispensing the norm would refuse, and this function is
 * where that choice is written down rather than assumed at four call sites.
 *
 * ⚠️ AND TODAY IT CHANGES NOTHING, which is why PR-052 does not block the
 * delivery: outpatient is three days and antimicrobial is three days, so the
 * missing antimicrobial flag (⚠️ **Falta esquema**, PR-052) cannot make the
 * printed number wrong. It would, immediately, in an emergency.
 */
export function validityDaysFor(
  context: DispensingContext,
  options: { antimicrobial?: boolean } = {},
): number {
  const byContext = VALIDITY_DAYS[context];
  return options.antimicrobial === true
    ? Math.min(byContext, ANTIMICROBIAL_VALIDITY_DAYS)
    : byContext;
}

/**
 * PR-050, PR-053. The LAST calendar day on which the prescription may still be
 * dispensed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DATE IN ECUADOR, NEVER THE INSTANT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «Contados a partir de la fecha de prescripción» counts DATES. A prescription
 * issued at 21:00 in Guayaquil belongs to that day; read in UTC it would belong
 * to the next one, and the pharmacy would refuse it a day early. It is the same
 * arithmetic `20260806040611_clinical_date_in_ecuador_timezone` exists to have
 * fixed for the frozen age of a neonate.
 *
 * ⚠️ **[NECESITA ACLARACIÓN]** (P-1 in the SPEC). Whether the day of issue
 * counts as the first of the three is not stated by the norm. The STRICT
 * reading is implemented — three natural days INCLUDING the day of issue, so
 * `validThrough = fecha + 2` — because of the two it is the one that cannot
 * authorise a late dispensing. A pharmacist has to confirm it; changing it is
 * this one subtraction.
 */
export function validThrough(
  issuedAt: Date,
  days: number,
  timeZone?: string,
): ClinicalDate {
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(`Prescription validity must be at least one day: ${days}`); // prettier-ignore
  }
  return addDays(clinicalDateOf(issuedAt, timeZone), days - 1);
}
