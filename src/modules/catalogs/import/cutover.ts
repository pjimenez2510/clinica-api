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

/**
 * EN-233, PR-116, ORD-133. The cut-over a person asked for (`AAAA-MM-DD`), or
 * the one by default, and never one that would break what is registered.
 *
 * With an edition in force, a cut-over before the next clinic day retires
 * concepts that attentions of today and of the days in between still use, and
 * `trg_diagnosis_concept_in_force` would then refuse correcting them. That
 * takes `allowPast` — tests that build the past on purpose, and nobody else.
 * Without an edition in force there is nothing to break: any date stands.
 */
export function cutoverOf(options: {
  requested: string | Date | undefined;
  now: Date;
  editionInForce: boolean;
  firstEditionFrom: Date;
  allowPast?: boolean;
}): Date {
  const { requested, now, editionInForce, firstEditionFrom } = options;
  if (requested === undefined)
    return editionInForce ? nextClinicDay(now) : firstEditionFrom;

  const date = requested instanceof Date ? requested : parseDay(requested);
  if (editionInForce && !options.allowPast && date < nextClinicDay(now))
    throw new Error(
      `El día de corte ${date.toISOString().slice(0, 10)} es anterior a mañana: ` +
        'retiraría conceptos que usan las atenciones de hoy.',
    );
  return date;
}

/** `2026-10-07` → that day at UTC midnight; anything else is refused. */
function parseDay(text: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const date = match
    ? new Date(
        Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
      )
    : null;
  if (!date || date.toISOString().slice(0, 10) !== text)
    throw new Error(`El día de corte «${text}» no es una fecha AAAA-MM-DD`);
  return date;
}
