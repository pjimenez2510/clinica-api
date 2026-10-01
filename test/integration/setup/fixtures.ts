import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Minimum rows needed before anything clinical can exist.
 *
 * Deliberately NOT a full seed: a fixture that creates everything hides which
 * relationship a test actually depends on, and makes a failure ambiguous.
 *
 * Every cedula here has a REAL check digit, computed with the modulus-10
 * algorithm. The database rejects invalid ones via `is_valid_cedula()`, so a
 * made-up number would fail for the wrong reason and send someone chasing a
 * bug that does not exist.
 */

let sequence = 0;
/** Unique per call, without Math.random: a failing test must be reproducible. */
function next(): string {
  sequence += 1;
  return String(sequence).padStart(6, '0');
}

/**
 * OR-032. The establishment every site belongs to: the one already registered
 * in this database, or a new one. One per database, as in a clinic.
 */
export async function establishmentId(prisma: PrismaClient): Promise<string> {
  // The oldest: a test that registers a second one keeps its sites on the
  // first, deterministically.
  const existing = await prisma.establishment.findFirst({
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (existing) return existing.id;
  const created = await prisma.establishment.create({
    data: {
      mspUnicode: `E${next()}`,
      typology: 'Consultorio de especialidad',
      legalName: 'Clínica de Pruebas S.A.',
    },
    select: { id: true },
  });
  return created.id;
}

export async function createSite(prisma: PrismaClient, name = 'Sede Central') {
  return prisma.site.create({
    data: {
      mspUnicode: `U${next()}`,
      name,
      establishmentId: await establishmentId(prisma),
    },
  });
}

/**
 * D-021. Sets what the site dices its day into.
 *
 * A SEPARATE CALL AND NOT A FIELD OF `createSite`, for the same reason
 * `linkPractitionerToSite` is separate: `trg_site_parameter_defaults` writes
 * the row of D-001 on insert (CF-062), so the grid a test operates on is
 * always a deliberate departure from the ten minutes the clinic ships with —
 * and a test that changes it should say so on the line that changes it.
 */
export async function setSlotAtom(
  prisma: PrismaClient,
  siteId: string,
  slotAtomMinutes: number,
) {
  return prisma.siteParameter.update({
    where: { siteId },
    data: { slotAtomMinutes },
  });
}

export async function createRoom(prisma: PrismaClient, siteId: string) {
  return prisma.siteRoom.create({
    data: { siteId, name: `Consultorio ${next()}` },
  });
}

/**
 * An account with no role, for the columns that only need somebody behind a
 * datum (EN-086, EN-143, EN-085): who recorded an allergy, a history entry or
 * a vital sign.
 */
export async function createUser(prisma: PrismaClient) {
  return prisma.user.create({
    data: {
      email: `autor${next()}@clinica.ec`,
      passwordHash: 'not-a-real-hash',
      firstName: 'Carmen',
      lastName: 'Salazar',
    },
  });
}

export async function createPractitioner(prisma: PrismaClient) {
  const user = await prisma.user.create({
    data: {
      email: `medico${next()}@clinica.ec`,
      // Not a real hash: no test here exercises verification, and putting a
      // valid Argon2 hash would suggest otherwise.
      passwordHash: 'not-a-real-hash',
      firstName: 'Ana',
      lastName: 'Villacís',
    },
  });
  return prisma.practitioner.create({ data: { userId: user.id } });
}

export async function createPatient(
  prisma: PrismaClient,
  overrides: { birthDate?: Date; sex?: 'MALE' | 'FEMALE' } = {},
) {
  return prisma.patient.create({
    data: {
      mrn: `HC${next()}`,
      familyName: 'Guamán',
      givenName: 'María',
      sex: overrides.sex ?? 'FEMALE',
      birthDate: overrides.birthDate ?? new Date('1990-03-15'),
    },
  });
}

/**
 * Links a practitioner to a site.
 *
 * AG-014: without the row, no slot of theirs is offered at that site and no
 * appointment is admitted. It is a separate call on purpose — a fixture that
 * created it silently would hide the requirement it exists for.
 */
export async function linkPractitionerToSite(
  prisma: PrismaClient,
  practitionerId: string,
  siteId: string,
) {
  return prisma.practitionerSite.create({ data: { practitionerId, siteId } });
}

/**
 * A weekly schedule rule, in WALL CLOCK time.
 *
 * `start_time` and `end_time` are `time` columns — the one deliberate
 * exception to timestamptz — so they are written as a Date pinned to
 * 1970-01-01 whose UTC parts ARE the wall clock. Writing them with local
 * getters would shift the rule by the host's offset, which is the bug
 * `WallClockTime.fromTimeColumn` exists to avoid on the way back.
 */
export async function createScheduleRule(
  prisma: PrismaClient,
  ids: { practitionerId: string; siteId: string },
  rule: {
    /** ISO-8601: 1 = Monday .. 7 = Sunday. */
    weekday: number;
    startTime: string;
    endTime: string;
    validFrom?: Date;
    validTo?: Date | null;
    active?: boolean;
  },
) {
  return prisma.practitionerScheduleRule.create({
    data: {
      ...ids,
      weekday: rule.weekday,
      startTime: new Date(`1970-01-01T${rule.startTime}:00Z`),
      endTime: new Date(`1970-01-01T${rule.endTime}:00Z`),
      validFrom: rule.validFrom ?? new Date('2026-01-01T00:00:00Z'),
      validTo: rule.validTo ?? null,
      active: rule.active ?? true,
    },
  });
}

export async function createEncounter(
  prisma: PrismaClient,
  ids: {
    siteId: string;
    practitionerId: string;
    patientId: string;
    /** AG-045: set to hang the encounter off an appointment. */
    agendaEntryId?: string;
  },
) {
  return prisma.encounter.create({
    data: {
      ...ids,
      startedAt: new Date('2026-09-14T14:00:00Z'),
      // Both are required, and on purpose: the RDACAA report demands them for
      // every single consultation. Making them optional would let a record be
      // created that the Ministry then rejects, months later.
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    },
  });
}

/** An hour of appointment, in UTC so the assertion does not depend on the host. */
export function hourSlot(hour: number): { startsAt: Date; endsAt: Date } {
  return {
    startsAt: new Date(Date.UTC(2026, 8, 14, hour, 0, 0)),
    endsAt: new Date(Date.UTC(2026, 8, 14, hour + 1, 0, 0)),
  };
}

/**
 * PR-020, PR-038. A receta ALREADY ISSUED, with its lines: born a draft with
 * them and issued afterwards, as the code does it. The lines of an issued
 * receta never change (`prescription_frozen`), not even to be added at birth.
 */
export async function createIssuedPrescription(
  prisma: PrismaClient,
  data: Prisma.PrescriptionUncheckedCreateInput,
) {
  const {
    status = 'ACTIVE',
    issuedAt = new Date(),
    verificationCode = null,
    ...draft
  } = data;
  const created = await prisma.prescription.create({
    data: { ...draft, status: 'DRAFT', issuedAt: null, verificationCode: null },
  });
  return prisma.prescription.update({
    where: { id: created.id },
    data: { status, issuedAt, verificationCode },
    include: { items: true },
  });
}
