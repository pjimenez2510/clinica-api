import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaEncounterRepository } from '../../src/modules/encounter/infrastructure/prisma-encounter.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
  hourSlot,
} from './setup/fixtures';

/**
 * EN-208. The attention of one appointment, found by the appointment — the
 * closed ones too, so a seen appointment can be READ (AG-160) — and never the
 * one annulled in error, which is not that appointment's attention (EN-166).
 */
const db = useDatabase();

async function anAppointment(
  prisma: PrismaClient,
  ids: { siteId: string; practitionerId: string; patientId: string },
  hour: number,
) {
  return prisma.agendaEntry.create({
    data: {
      kind: 'APPOINTMENT',
      bookingChannel: 'PHONE',
      ...ids,
      ...hourSlot(hour),
    },
  });
}

describe('la atención de una cita', () => {
  it('EN-208 encuentra la atención cerrada de su cita y no la anulada por error ni la de otra cita', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    const user = await createUser(prisma);
    const ids = {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    };
    const seen = await anAppointment(prisma, ids, 9);
    const other = await anAppointment(prisma, ids, 11);

    const annulled = await createEncounter(prisma, {
      ...ids,
      agendaEntryId: seen.id,
    });
    const endedAt = new Date(annulled.startedAt.getTime() + 10 * 60_000);
    await prisma.encounter.update({
      where: { id: annulled.id },
      data: {
        status: 'ENTERED_IN_ERROR',
        endedAt,
        enteredInErrorReason: 'Se abrió sobre la ficha de otro paciente',
        enteredInErrorById: user.id,
        enteredInErrorAt: endedAt,
      },
    });
    const closed = await createEncounter(prisma, {
      ...ids,
      agendaEntryId: seen.id,
    });
    await prisma.encounter.update({
      where: { id: closed.id },
      data: {
        status: 'DISCONTINUED',
        endedAt,
        discontinuedReason: 'El paciente se retiró a mitad de la consulta',
        discontinuedOrigin: 'PATIENT',
        discontinuedById: user.id,
        discontinuedAt: endedAt,
      },
    });
    await createEncounter(prisma, { ...ids, agendaEntryId: other.id });

    const page = await new PrismaEncounterRepository(
      prisma as unknown as PrismaService,
    ).historyOf({
      patientId: patient.id,
      agendaEntryId: seen.id,
      sites: [site.id],
      page: 1,
      pageSize: 20,
    });

    expect(page.items.map((encounter) => encounter.id)).toEqual([closed.id]);
    expect(page.total).toBe(1);
  });
});
