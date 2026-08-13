import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Seed for the CONFIGURATION module (C3): the holidays of the current year and
 * the operating parameters of every site, so the administration screens have
 * something real to show from the first boot.
 *
 * ⚠️ NOT AN AUTHORITATIVE CALENDAR. These rows are a development fixture. The
 * fixed dates are the ones the Código del Trabajo names, and the movable ones
 * (Carnaval and Viernes Santo) are derived from Easter, which is exact — but
 * **the seed does NOT apply the «ley de traslado de feriados»**, which moves
 * several of them to the nearest Monday or Friday and whose result changes
 * year by year with the corresponding acuerdo ministerial. A real clinic edits
 * this list from the screen every December, which is precisely why CF-060
 * exists. Nothing here should ever be treated as the official calendar.
 *
 * IDEMPOTENT AND ORDER-INDEPENDENT, like `seed-organization.mts`:
 *
 *   - A holiday is matched by DATE and SCOPE, which is the same identity
 *     `holiday_date_scope_unique` enforces (CF-061). Re-running never
 *     duplicates and never renames one the clinic corrected.
 *   - The parameters are NOT written by this seed. The database writes them
 *     when the site is created (`trg_site_parameter_defaults`, CF-062); what
 *     this does is REPORT how many sites have their row, so a database
 *     restored from a dump older than that trigger is visibly missing them
 *     instead of silently answering 404 on the screen.
 *
 * Chain: `pnpm db:seed` (users) → `pnpm db:seed:agenda` (sites) →
 * `pnpm db:seed:organization` → `pnpm db:seed:configuration`. Running it
 * standalone also works.
 */

/** Every holiday applies to EVERY site: `site_id` NULL is the wider scope. */
interface SeedHoliday {
  /** `MM-DD` for the fixed ones; the movable ones are computed. */
  date: string;
  name: string;
}

/**
 * Easter Sunday, Gregorian, as `YYYY-MM-DD` in UTC.
 *
 * The Anonymous Gregorian algorithm (Meeus/Jones/Butcher). It is EXACT — what
 * is approximate about Carnaval and Viernes Santo below is not the arithmetic
 * but whether Ecuador moves the resulting day, which is a ministerial decision
 * and not a calculation.
 */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return new Date(Date.UTC(year, month - 1, day));
}

/** `YYYY-MM-DD` of an instant, read in UTC so no timezone can shift the day. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

export function ecuadorianHolidays(year: number): SeedHoliday[] {
  const easter = easterSunday(year);

  return [
    { date: `${year}-01-01`, name: 'Año Nuevo' },
    // Movable: the Monday and Tuesday before Ash Wednesday, 48 and 47 days
    // before Easter.
    { date: isoDay(daysBefore(easter, 48)), name: 'Carnaval (lunes)' },
    { date: isoDay(daysBefore(easter, 47)), name: 'Carnaval (martes)' },
    { date: isoDay(daysBefore(easter, 2)), name: 'Viernes Santo' },
    { date: `${year}-05-01`, name: 'Día del Trabajo' },
    { date: `${year}-05-24`, name: 'Batalla del Pichincha' },
    { date: `${year}-08-10`, name: 'Primer Grito de Independencia' },
    { date: `${year}-10-09`, name: 'Independencia de Guayaquil' },
    { date: `${year}-11-02`, name: 'Día de los Difuntos' },
    { date: `${year}-11-03`, name: 'Independencia de Cuenca' },
    { date: `${year}-12-25`, name: 'Navidad' },
  ];
}

export async function seedConfiguration(
  prisma: PrismaClient,
  year = new Date().getUTCFullYear(),
): Promise<{
  year: number;
  holidaysCreated: number;
  holidaysAlreadyPresent: number;
  sitesWithParameters: number;
  sitesWithoutParameters: number;
}> {
  let holidaysCreated = 0;
  let holidaysAlreadyPresent = 0;

  for (const holiday of ecuadorianHolidays(year)) {
    const date = new Date(`${holiday.date}T00:00:00.000Z`);

    // Matched by date AND scope, which is the identity CF-061 enforces. A name
    // the clinic corrected stays corrected: this never updates.
    const existing = await prisma.holiday.findFirst({
      where: { date, siteId: null },
      select: { id: true },
    });
    if (existing) {
      holidaysAlreadyPresent += 1;
      continue;
    }

    await prisma.holiday.create({
      data: { date, name: holiday.name, siteId: null },
    });
    holidaysCreated += 1;
  }

  // CF-062: reported, not written. The trigger owns the defaults, and a second
  // writer would mean «what does a site do by default» depends on who inserted
  // it. A non-zero second number is a database older than that trigger.
  const sites = await prisma.site.count();
  const sitesWithParameters = await prisma.siteParameter.count();

  return {
    year,
    holidaysCreated,
    holidaysAlreadyPresent,
    sitesWithParameters,
    sitesWithoutParameters: sites - sitesWithParameters,
  };
}

/** Entry point for `pnpm db:seed:configuration`. */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    // A real clinic's holiday calendar is an operational decision with payroll
    // consequences, and this list does not apply the «ley de traslado». Loading
    // it into production would close the agenda on the wrong days.
    throw new Error('This seed is for development only.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const result = await seedConfiguration(prisma);
    console.log(
      `Configuración ${result.year}: ${result.holidaysCreated} feriados creados, ` +
        `${result.holidaysAlreadyPresent} ya presentes. ` +
        `Parámetros: ${result.sitesWithParameters} sedes con su fila.`,
    );
    console.log(
      '⚠️  Los feriados movibles (Carnaval, Viernes Santo) se derivan de la Pascua y ' +
        'NO aplican la ley de traslado de feriados. Son datos de desarrollo, no el calendario oficial.',
    );
    if (result.sitesWithoutParameters > 0) {
      console.warn(
        `⚠️  ${result.sitesWithoutParameters} sedes sin fila de parámetros. ` +
          'La base las escribe al crear la sede (trg_site_parameter_defaults): ' +
          'una base sin ellas es anterior a esa migración.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Only when invoked directly, so the integration suite can import
// `seedConfiguration` without connecting twice.
if (process.argv[1]?.endsWith('seed-configuration.mts')) {
  await main();
}
