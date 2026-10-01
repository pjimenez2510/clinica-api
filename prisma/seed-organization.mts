import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Seed for the ORGANIZATION module (O1 and O2): the establishment, its sites
 * with their consulting rooms, and one point of emission each, so the
 * administration screens have something real to show from the first boot.
 *
 * IDEMPOTENT AND ORDER-INDEPENDENT, which is the whole difficulty here. Sites
 * are created by `seed-agenda.mts`, not by the main seed, so this can run
 * before or after it and must be right either way:
 *
 *   - The establishment is matched by its MSP code and never overwritten — a
 *     clinic that edited its typology meant it (same rule as
 *     `seed-authorisation.mts`).
 *   - EVERY site without an establishment is backfilled, not just the ones
 *     this file knows about. Run it again after `db:seed:agenda` and the two
 *     new sites are adopted too.
 *   - A site is created ONLY when there is none at all, so a fresh database
 *     still has a working screen without inventing a third site next to the
 *     two `seed-agenda.mts` creates.
 *   - Rooms and points of emission are matched by their unique key within the
 *     site, so re-running never duplicates and never renames.
 *
 * Chain: `pnpm db:seed` (users) → `pnpm db:seed:agenda` (sites, practitioners)
 * → `pnpm db:seed:organization`. Running it standalone also works.
 */

/**
 * A development RUC built with the SRI's former private-company check digit
 * (modulo 11) — never a real taxpayer's. Since D-057 no company digit is
 * checked (OR-009); the number is kept as it is. Third digit 9, province
 * 17 (Pichincha), establishment 001.
 */
const DEV_RUC = '1790001563001';

const ESTABLISHMENT = {
  mspUnicode: 'DEV-EST-001',
  // A.M. 00000079 typology. «Centro de Salud Tipo A» is the smallest
  // establishment that reports RDACAA, which is the realistic default.
  typology: 'Centro de Salud Tipo A',
  legalName: 'Clínica de Desarrollo S.A.',
  ruc: DEV_RUC,
  // OR-028. `dirMatriz` of every voucher (sri/SPEC.md SRI-018). Fictitious.
  headOfficeAddress: 'Av. Amazonas y Naciones Unidas, Quito',
  // OR-029. A company («S.A.») always keeps accounts; no RIMPE.
  keepsAccounting: true,
  rimpeRegime: 'NONE',
} as const;

/** The site created ONLY when the database has none at all. */
const FALLBACK_SITE = {
  mspUnicode: 'DEV-SEDE-01',
  name: 'Sede Central',
  addressLine: 'Av. Amazonas y Naciones Unidas, Quito',
  phone: '02 000 0000',
} as const;

/** Every site gets these, unless it already has a room by that name. */
const DEFAULT_ROOMS = ['Consultorio 1', 'Consultorio 2'] as const;

/** OR-023: the first point of emission of the SRI is always «001». */
const DEFAULT_EMISSION_POINT = {
  code: '001',
  description: 'Punto de emisión principal',
} as const;

/**
 * Applies the rules listed at the top of this file and reports what it created
 * or adopted. Demo data — the establishment, its RUC and the fallback site are
 * fictitious; `main` refuses a production `NODE_ENV`.
 */
export async function seedOrganization(prisma: PrismaClient): Promise<{
  establishmentCreated: boolean;
  sitesCreated: number;
  sitesBackfilled: number;
  roomsCreated: number;
  emissionPointsCreated: number;
}> {
  let establishment = await prisma.establishment.findUnique({
    where: { mspUnicode: ESTABLISHMENT.mspUnicode },
    select: { id: true },
  });
  const establishmentCreated = establishment === null;
  establishment ??= await prisma.establishment.create({
    data: ESTABLISHMENT,
    select: { id: true },
  });

  // OR-028. A database seeded before the column existed has the
  // establishment without it; only an empty value is filled.
  await prisma.establishment.updateMany({
    where: { mspUnicode: ESTABLISHMENT.mspUnicode, headOfficeAddress: null },
    data: { headOfficeAddress: ESTABLISHMENT.headOfficeAddress },
  });

  // OR-031. The development seed states the fictitious establishment's fiscal
  // flags, as an administrator would; a real installation declares them on
  // the establishment's screen, and until then prepares no voucher.
  await prisma.establishment.updateMany({
    where: {
      mspUnicode: ESTABLISHMENT.mspUnicode,
      fiscalProfileDeclaredAt: null,
    },
    data: {
      keepsAccounting: ESTABLISHMENT.keepsAccounting,
      rimpeRegime: ESTABLISHMENT.rimpeRegime,
      fiscalProfileDeclaredAt: new Date(),
    },
  });

  // --- Sites -----------------------------------------------------------
  let sitesCreated = 0;
  if ((await prisma.site.count()) === 0) {
    await prisma.site.create({
      data: { ...FALLBACK_SITE, establishmentId: establishment.id },
    });
    sitesCreated = 1;
  }

  // OR-004: the backfill the nullable column exists for. `establishmentId`
  // null is the only thing touched, so a site somebody moved to another
  // establishment from the screen stays where they put it.
  const { count: sitesBackfilled } = await prisma.site.updateMany({
    where: { establishmentId: null },
    data: { establishmentId: establishment.id },
  });

  // --- Rooms and points of emission per site ----------------------------
  const sites = await prisma.site.findMany({ select: { id: true } });
  let roomsCreated = 0;
  let emissionPointsCreated = 0;

  for (const site of sites) {
    for (const name of DEFAULT_ROOMS) {
      const existing = await prisma.siteRoom.findUnique({
        where: { siteId_name: { siteId: site.id, name } },
        select: { id: true },
      });
      if (existing) continue;

      await prisma.siteRoom.create({ data: { siteId: site.id, name } });
      roomsCreated += 1;
    }

    const point = await prisma.emissionPoint.findUnique({
      where: {
        siteId_code: { siteId: site.id, code: DEFAULT_EMISSION_POINT.code },
      },
      select: { id: true },
    });
    if (!point) {
      await prisma.emissionPoint.create({
        data: { siteId: site.id, ...DEFAULT_EMISSION_POINT },
      });
      emissionPointsCreated += 1;
    }
  }

  // OR-027. Every site without the SRI's establishment code gets the next free
  // one, in creation order — «001» for the first. Development data: in a real
  // installation the code is the one the SRI assigned, typed from the screen.
  const coded = await prisma.site.findMany({
    where: { sriEstablishmentCode: { not: null } },
    select: { sriEstablishmentCode: true },
  });
  const taken = new Set(coded.map((site) => site.sriEstablishmentCode));
  const uncoded = await prisma.site.findMany({
    where: { sriEstablishmentCode: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  let next = 1;
  for (const site of uncoded) {
    while (taken.has(String(next).padStart(3, '0'))) next += 1;
    const code = String(next).padStart(3, '0');
    taken.add(code);
    await prisma.site.update({
      where: { id: site.id },
      data: { sriEstablishmentCode: code },
    });
  }

  return {
    establishmentCreated,
    sitesCreated,
    sitesBackfilled,
    roomsCreated,
    emissionPointsCreated,
  };
}

/** Entry point for `pnpm db:seed:organization`. */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    // The establishment of a real clinic is its legal identity: its typology,
    // its MSP code and its RUC are filed with the ministry and the SRI. A
    // development placeholder in that table would be reported to the State.
    throw new Error('This seed is for development only.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const result = await seedOrganization(prisma);
    console.log(
      `Organización: establecimiento ${result.establishmentCreated ? 'creado' : 'ya presente'}, ` +
        `${result.sitesCreated} sedes creadas, ${result.sitesBackfilled} sedes enlazadas al establecimiento, ` +
        `${result.roomsCreated} consultorios y ${result.emissionPointsCreated} puntos de emisión creados.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only when invoked directly, so the integration suite can import
// `seedOrganization` without connecting twice.
if (process.argv[1]?.endsWith('seed-organization.mts')) {
  await main();
}
