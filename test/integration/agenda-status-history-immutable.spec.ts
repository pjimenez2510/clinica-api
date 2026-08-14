import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
  hourSlot,
  linkPractitionerToSite,
} from './setup/fixtures';

/**
 * D-022: the transition log stops being a convention and becomes a guarantee.
 *
 * WHY THIS SUITE EXISTS. The agenda SPEC declares the immutability of the
 * status history among the things that are NOT configurable, and SC-005
 * promises that every cancelled, rescheduled or no-show appointment keeps its
 * whole trail with author and instant. Until this migration the schema held
 * neither half: the module only ever INSERTed — a habit, not a rule — and the
 * foreign key was `ON DELETE CASCADE`, so deleting one appointment erased its
 * entire history without a word.
 *
 * NOTHING BUT A REAL POSTGRESQL CAN PROVE THIS. A double refuses whatever we
 * program it to refuse; the point here is that the refusal survives the
 * application entirely — a hand-typed `UPDATE` in `psql`, a migration script,
 * an ORM that has not read the SPEC.
 */
describe('el historial de estados de la cita es inmutable en la base', () => {
  const db = useDatabase();

  /** An appointment with one history row hanging off it. */
  async function appointmentWithHistory(prisma: PrismaClient) {
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    await linkPractitionerToSite(prisma, practitioner.id, site.id);
    const patient = await createPatient(prisma);

    const entry = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        bookingChannel: 'PHONE',
        ...hourSlot(9),
      },
    });

    const history = await prisma.agendaStatusHistory.create({
      data: {
        agendaEntryId: entry.id,
        fromStatus: 'BOOKED',
        toStatus: 'CANCELLED',
        note: 'el paciente avisó que no puede venir',
      },
    });

    return { entry, history };
  }

  it('AG-005 acepta una fila nueva del historial', async () => {
    const prisma = db();
    const { history } = await appointmentWithHistory(prisma);

    expect(history.id).toBeTruthy();
  });

  it('AG-005 RECHAZA modificar una fila del historial', async () => {
    const prisma = db();
    const { history } = await appointmentWithHistory(prisma);

    // The one that matters: rewriting `note` rewrites the answer to "why did
    // this appointment come out cancelled?".
    await expect(
      prisma.agendaStatusHistory.update({
        where: { id: history.id },
        data: { note: 'otra cosa distinta' },
      }),
    ).rejects.toThrow(/append-only/);
  });

  it('AG-005 RECHAZA borrar una fila del historial', async () => {
    const prisma = db();
    const { history } = await appointmentWithHistory(prisma);

    await expect(
      prisma.agendaStatusHistory.delete({ where: { id: history.id } }),
    ).rejects.toThrow(/append-only/);
  });

  it('AG-005 RECHAZA vaciar la tabla del historial', async () => {
    // TRUNCATE does not fire row-level triggers, so it needs its own. Without
    // it the whole trail of every appointment goes in one statement.
    const prisma = db();
    await appointmentWithHistory(prisma);

    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE agenda_status_history'),
    ).rejects.toThrow(/append-only/);
  });

  it('SC-005 RECHAZA borrar la cita de la que cuelga el historial, en vez de llevárselo por delante', async () => {
    const prisma = db();
    const { entry } = await appointmentWithHistory(prisma);

    // Raw SQL and not `prisma.agendaEntry.delete`: what is on trial is the
    // foreign key, and PostgreSQL's own message names the constraint and the
    // table it protects. A cascade would have succeeded here in silence.
    await expect(
      prisma.$executeRawUnsafe('DELETE FROM agenda_entry WHERE id = $1', entry.id), // prettier-ignore
    ).rejects.toThrow(/agenda_status_history_agenda_entry_id_fkey/);

    const surviving = await prisma.agendaStatusHistory.count({
      where: { agendaEntryId: entry.id },
    });
    expect(surviving).toBe(1);
  });
});
