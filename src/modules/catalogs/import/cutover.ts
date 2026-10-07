/**
 * EN-233, PR-116, ORD-133. The day a new catalogue edition starts to rule,
 * when an older one is in force: the clinic day after the import.
 *
 * Not today: an attention opened this morning already holds concepts of the
 * old edition, and `trg_diagnosis_concept_in_force` checks them against the
 * attention's clinical date. Retiring them as of today would leave that
 * attention unable to correct its own diagnoses.
 *
 * ⚠️ STANDALONE: imported by the seeds in `prisma/` under strip-types.
 */
const CLINIC_TIME_ZONE = 'America/Guayaquil';

/** The clinic day after `now`, as a date at UTC midnight. */
export function nextClinicDay(now: Date): Date {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: CLINIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1));
}
