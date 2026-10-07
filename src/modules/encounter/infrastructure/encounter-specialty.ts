import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * EN-203. The specialty an attention is of: its appointment's service type,
 * or — without an appointment, or with one of no type — the practitioner's
 * primary specialty. `null` when neither says.
 *
 * ONE STATEMENT OF THE RULE for every reader of this module: the note's
 * template (EN-203) and the dental index (EN-052) must agree on what an
 * attention is of, and two copies are two answers the day one changes.
 */
export async function encounterSpecialty(
  db: PrismaClient | Prisma.TransactionClient,
  encounterId: string,
): Promise<{ id: string; code: string } | null> {
  const encounter = await db.encounter.findUnique({
    where: { id: encounterId },
    select: {
      agendaEntry: {
        select: {
          serviceType: {
            select: { specialty: { select: { id: true, code: true } } },
          },
        },
      },
      practitioner: {
        select: {
          specialties: {
            where: { isPrimary: true },
            select: { specialty: { select: { id: true, code: true } } },
            take: 1,
          },
        },
      },
    },
  });
  if (!encounter) return null;
  return (
    encounter.agendaEntry?.serviceType?.specialty ??
    encounter.practitioner.specialties[0]?.specialty ??
    null
  );
}
