import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Seed for the SPECIALTIES module (C1): the specialty catalogue of D-008, so
 * the administration screen and the agenda dialog have something real to
 * offer from the first boot.
 *
 * SP-001: the catalogue ships preloaded with the specialties recognised by
 * the MSP (Acuerdo Ministerial de especialidades médicas reconocidas en
 * Ecuador), and the seed is IDEMPOTENT — existing rows are matched by code,
 * case-insensitively, and never overwritten: a clinic that renamed
 * «Pediatría» meant it, and a deploy that put the old name back would be a
 * bug that looks like magic (same rule as `seed-authorisation.mts`).
 *
 * Its consultations («Primera vez» at 30 minutes and «Control» at 20) are
 * SERVICES since ADR-013 (BI-279): `seed-billing.mts` writes them, and the
 * `db:seed:specialties` script runs it right after this one.
 *
 * WHAT IT NO LONGER DOES: assign a primary specialty to the seeded
 * practitioners. `practitioner_specialty` is a table of the STAFF module since
 * the 13-08-2026 move (ST-008), and a seed writing another module's table is
 * the same boundary violation `arch:check` refuses in the source. It lives in
 * `seed-staff.mts` now, together with the `duration_exception` of ST-009 that
 * nobody was writing at all.
 *
 * Chain: run AFTER `pnpm db:seed` (users). The `db:seed:specialties` script
 * runs the billing seed right after this one, so every specialty gets its
 * consultations (BI-232, BI-279); this file does not write billing's tables
 * itself. Then `pnpm db:seed:staff` if you
 * want the seeded practitioners to have a specialty and a duration exception.
 */

/** A specialty as it is seeded: its stable code and its display name. */
interface SeedSpecialty {
  code: string;
  name: string;
}

/**
 * The MSP-recognised specialties (D-008). Codes are kebab-case and STABLE:
 * they are the contract reports hold on to, so they never change even if the
 * display name does.
 *
 * EVERY CODE HERE IS `specialtyCodeFromName(name)` (SP-009), and
 * `src/modules/specialties/domain/specialty-code.spec.ts` reads THIS LIST and
 * fails if one drifts. Adding a specialty here means deriving its code the same
 * way, or the same specialty ends up with two identities depending on whether
 * the seed or the administration screen created it.
 */
const SPECIALTIES: readonly SeedSpecialty[] = [
  { code: 'medicina-general', name: 'Medicina General' },
  { code: 'medicina-familiar', name: 'Medicina Familiar y Comunitaria' },
  { code: 'medicina-interna', name: 'Medicina Interna' },
  { code: 'pediatria', name: 'Pediatría' },
  { code: 'ginecologia-obstetricia', name: 'Ginecología y Obstetricia' },
  { code: 'cirugia-general', name: 'Cirugía General' },
  { code: 'cardiologia', name: 'Cardiología' },
  { code: 'dermatologia', name: 'Dermatología' },
  { code: 'traumatologia-ortopedia', name: 'Traumatología y Ortopedia' },
  { code: 'psiquiatria', name: 'Psiquiatría' },
  { code: 'oftalmologia', name: 'Oftalmología' },
  { code: 'otorrinolaringologia', name: 'Otorrinolaringología' },
  { code: 'urologia', name: 'Urología' },
  { code: 'neurologia', name: 'Neurología' },
  { code: 'endocrinologia', name: 'Endocrinología' },
  { code: 'gastroenterologia', name: 'Gastroenterología' },
  { code: 'neumologia', name: 'Neumología' },
  { code: 'nefrologia', name: 'Nefrología' },
  { code: 'reumatologia', name: 'Reumatología' },
  { code: 'anestesiologia', name: 'Anestesiología' },
  { code: 'medicina-emergencias', name: 'Medicina de Emergencias y Desastres' },
  { code: 'odontologia', name: 'Odontología' },
];

/**
 * Creates each missing specialty (matched by code, case-insensitively); never
 * updates an existing row. Returns how many rows it created.
 */
export async function seedSpecialties(prisma: PrismaClient): Promise<{
  specialtiesCreated: number;
}> {
  let specialtiesCreated = 0;

  for (const specialty of SPECIALTIES) {
    // Matched by lower(code): the unique index `specialty_code_unique` is
    // functional, so Prisma's `upsert` cannot target it — find-then-create,
    // which is safe here because the seed is the only writer at seed time and
    // the index still arbitrates a race.
    const existing = await prisma.specialty.findFirst({
      where: { code: { equals: specialty.code, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!existing) {
      await prisma.specialty.create({ data: specialty });
      specialtiesCreated += 1;
    }
  }

  return { specialtiesCreated };
}

/** Entry point for `pnpm db:seed:specialties`. */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    // The catalogue itself would be legitimate everywhere, but a production
    // clinic gets it through the administration screen or a deliberate
    // migration, not through a script anybody can run by accident.
    throw new Error('This seed is for development only.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const result = await seedSpecialties(prisma);
    console.log(
      `Especialidades: ${result.specialtiesCreated} creadas ` +
        `(${SPECIALTIES.length} en total).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only when invoked directly, so the integration suite can import
// `seedSpecialties` without connecting twice.
if (process.argv[1]?.endsWith('seed-specialties.mts')) {
  await main();
}
