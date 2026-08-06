import type { PrismaClient } from '@prisma/client';

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

export async function createSite(prisma: PrismaClient, name = 'Sede Central') {
  return prisma.site.create({
    data: { mspUnicode: `U${next()}`, name },
  });
}

export async function createRoom(prisma: PrismaClient, siteId: string) {
  return prisma.siteRoom.create({
    data: { siteId, name: `Consultorio ${next()}` },
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

export async function createEncounter(
  prisma: PrismaClient,
  ids: { siteId: string; practitionerId: string; patientId: string },
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
