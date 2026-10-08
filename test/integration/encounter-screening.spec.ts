import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import '../../src/modules/encounter/infrastructure/encounter.constraints';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * Block F of form 002 against a real PostgreSQL (EN-071, EN-074, EN-076,
 * EN-077): what the screening cannot say at once is refused by the DATABASE,
 * whoever writes — the API, an import, a hand-written UPDATE.
 *
 * Every refusal has its positive control: the same row with the one thing
 * fixed goes in, so a CHECK that refused everything would not pass.
 */
const db = useDatabase();

async function anAttention(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  return { encounterId: encounter.id, screenedById: practitioner.id };
}

type Row = {
  result: 'NOT_APPLIED' | 'NO_SIGNS' | 'SUSPECTED' | 'CONFIRMED';
  types?: string[] | null;
  actionTaken?: string | null;
  reported?: boolean;
  serial?: string | null;
  injury?: string | null;
  identified?: string | null;
  relationship?: string | null;
};

/** A raw INSERT, the way an import writes: no service in between. */
function insert(
  prisma: PrismaClient,
  ids: { encounterId: string; screenedById: string | null },
  row: Row,
) {
  const at = new Date();
  // EN-242. A notified screening says who recorded the notification and when.
  const notifiedBy = row.reported ? ids.screenedById : null;
  const notifiedAt = row.reported ? at : null;
  return prisma.$executeRaw`
    INSERT INTO violence_screening
      (encounter_id, result, types, action_taken, reported_to_authority,
       authority_form_serial, injury, aggressor_identified, aggressor_relationship,
       screened_by_id, screened_at, notified_by_id, notified_at)
    VALUES (${ids.encounterId}::uuid, ${row.result}::violence_screening_result,
            ${row.types ?? null}::violence_type[], ${row.actionTaken ?? null},
            ${row.reported ?? false}, ${row.serial ?? null},
            ${row.injury ?? null}::violence_injury,
            ${row.identified ?? null}::aggressor_identified,
            ${row.relationship ?? null}::aggressor_relationship,
            ${ids.screenedById}::uuid, ${at},
            ${notifiedBy}::uuid, ${notifiedAt})`;
}

async function problemFrom(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    return extractDatabaseProblem(error);
  }
  throw new Error('the operation should have failed');
}

/** A 422 that names the field to fix — and only the field (EN-073). */
const refusedOn = (field: string) => ({
  status: 422,
  errors: [expect.objectContaining({ field })],
});

const POSITIVE: Row = {
  result: 'SUSPECTED',
  types: ['PHYSICAL', 'PSYCHOLOGICAL'],
  actionTaken: 'Derivada a trabajo social',
};

const NOTIFIED: Row = {
  ...POSITIVE,
  reported: true,
  serial: '0012345',
  injury: 'DAMAGE',
  identified: 'YES',
  relationship: 'RELATIVE',
};

describe('EN-071 EN-077 lo que el tamizaje no puede decir a la vez', () => {
  it('EN-071 la BASE rechaza un positivo sin tipos y un «sin signos» con tipos, y acepta cada uno bien dicho', async () => {
    const prisma = db();
    const a = await anAttention(prisma);
    const b = await anAttention(prisma);

    expect(
      await problemFrom(insert(prisma, a, { ...POSITIVE, types: [] })),
    ).toMatchObject(refusedOn('types'));
    expect(
      await problemFrom(
        insert(prisma, b, { result: 'NO_SIGNS', types: ['SEXUAL'] }),
      ),
    ).toMatchObject(refusedOn('types'));

    // Positive control: the same two, each said properly.
    await insert(prisma, a, POSITIVE);
    await insert(prisma, b, { result: 'NO_SIGNS' });
    expect(await prisma.violenceScreening.count()).toBe(2);
  });

  it('EN-077 la BASE exige la acción tomada en un positivo y la rechaza sin signos', async () => {
    const prisma = db();
    const a = await anAttention(prisma);
    const b = await anAttention(prisma);

    expect(
      await problemFrom(insert(prisma, a, { ...POSITIVE, actionTaken: '  ' })),
    ).toMatchObject(refusedOn('actionTaken'));
    expect(
      await problemFrom(
        insert(prisma, b, { result: 'NOT_APPLIED', actionTaken: 'Nada' }),
      ),
    ).toMatchObject(refusedOn('actionTaken'));

    await insert(prisma, a, POSITIVE);
    await insert(prisma, b, { result: 'NOT_APPLIED' });
    expect(await prisma.violenceScreening.count()).toBe(2);
  });
});

describe('EN-074 la notificación a la autoridad', () => {
  it('EN-074 la BASE rechaza notificar un tamizaje sin signos', async () => {
    const prisma = db();
    const ids = await anAttention(prisma);

    expect(
      await problemFrom(
        insert(prisma, ids, {
          ...NOTIFIED,
          result: 'NO_SIGNS',
          types: null,
          actionTaken: null,
        }),
      ),
    ).toMatchObject(refusedOn('reportedToAuthority'));

    await insert(prisma, ids, NOTIFIED);
    expect(await prisma.violenceScreening.count()).toBe(1);
  });

  it('EN-074 la BASE exige los cuatro datos del formulario al notificar, y ninguno sin notificar', async () => {
    const prisma = db();
    const ids = await anAttention(prisma);
    const block = refusedOn('notification');

    for (const missing of [
      { serial: null },
      { serial: ' ' },
      { injury: null },
      { identified: null },
      { relationship: null },
    ]) {
      expect(
        await problemFrom(insert(prisma, ids, { ...NOTIFIED, ...missing })),
      ).toMatchObject(block);
    }
    expect(
      await problemFrom(
        insert(prisma, ids, { ...POSITIVE, injury: 'DISABILITY' }),
      ),
    ).toMatchObject(block);

    await insert(prisma, ids, NOTIFIED);
    const saved = await prisma.violenceScreening.findUniqueOrThrow({
      where: { encounterId: ids.encounterId },
    });
    expect(saved).toMatchObject({
      reportedToAuthority: true,
      authorityFormSerial: '0012345',
      injury: 'DAMAGE',
      aggressorIdentified: 'YES',
      aggressorRelationship: 'RELATIVE',
    });
  });
});

describe('EN-076 quién aplicó el tamizaje', () => {
  it('EN-076 la BASE exige el profesional y no deja borrarlo mientras su tamizaje exista', async () => {
    const prisma = db();
    const ids = await anAttention(prisma);

    await expect(
      insert(prisma, { ...ids, screenedById: null }, { result: 'NO_SIGNS' }),
    ).rejects.toThrow(/null value|not-null|23502/i);

    await insert(prisma, ids, { result: 'NO_SIGNS' });
    expect(await prisma.violenceScreening.count()).toBe(1);

    // `RESTRICT`: the practitioner cannot disappear from under the row. The
    // attention points at them too, so it is set aside for this statement
    // with a second practitioner, leaving the screening as the only reference.
    const other = await createPractitioner(prisma);
    await prisma.encounter.update({
      where: { id: ids.encounterId },
      data: { practitionerId: other.id },
    });
    await expect(
      prisma.practitioner.delete({ where: { id: ids.screenedById } }),
    ).rejects.toThrow(/violence_screening_screened_by_id_fkey|foreign key/i);

    // Positive control: a practitioner nothing points at can be deleted.
    const loose = await createPractitioner(prisma);
    await prisma.practitioner.delete({ where: { id: loose.id } });
  });
});

describe('EN-071 EN-070 EN-076 lo que la base guarda del tamizaje', () => {
  it('EN-071 la BASE rechaza un tipo repetido, y acepta los mismos sin repetir', async () => {
    const prisma = db();
    const ids = await anAttention(prisma);

    await expect(
      insert(prisma, ids, { ...POSITIVE, types: ['PHYSICAL', 'PHYSICAL'] }),
    ).rejects.toThrow(/violence_screening_types_distinct/);

    await insert(prisma, ids, { ...POSITIVE, types: ['PHYSICAL', 'SEXUAL'] });
    expect(await prisma.violenceScreening.count()).toBe(1);
  });

  it('EN-070 EN-076 la BASE archiva entera la respuesta que una corrección reemplaza, con quién la reemplazó', async () => {
    const prisma = db();
    const ids = await anAttention(prisma);
    await insert(prisma, ids, NOTIFIED);
    expect(await prisma.violenceScreeningVersion.count()).toBe(0);

    const other = await createPractitioner(prisma);
    const at = new Date();
    await prisma.violenceScreening.update({
      where: { encounterId: ids.encounterId },
      data: {
        result: 'NO_SIGNS',
        types: [],
        actionTaken: null,
        reportedToAuthority: false,
        authorityFormSerial: null,
        injury: null,
        aggressorIdentified: null,
        aggressorRelationship: null,
        notifiedById: null,
        notifiedAt: null,
        screenedById: other.id,
        screenedAt: at,
      },
    });

    const [archived] = await prisma.violenceScreeningVersion.findMany({
      where: { encounterId: ids.encounterId },
    });
    expect(archived).toMatchObject({
      version: 1,
      replacedById: other.id,
      replacedAt: at,
      data: expect.objectContaining({
        result: 'SUSPECTED',
        authority_form_serial: '0012345',
        screened_by_id: ids.screenedById,
      }) as unknown,
    });
  });

  it('EN-070 la BASE no deja borrar un tamizaje, ni lo que se archivó de él', async () => {
    const prisma = db();
    const ids = await anAttention(prisma);
    await insert(prisma, ids, { result: 'NO_SIGNS' });

    await expect(
      prisma.violenceScreening.delete({
        where: { encounterId: ids.encounterId },
      }),
    ).rejects.toThrow(/violence_screening_immutable/);
    expect(await prisma.violenceScreening.count()).toBe(1);
  });
});

/**
 * EN-242 (D-188 §5). With the discharge given, block F admits only its
 * notification to the authority — completed or corrected, never removed —
 * and the database says so to whoever writes, not only the adapter.
 */
describe('EN-242 tras el alta sólo se completa la notificación', () => {
  async function discharge(prisma: PrismaClient, encounterId: string) {
    const encounter = await prisma.encounter.findUniqueOrThrow({
      where: { id: encounterId },
    });
    await prisma.encounter.update({
      where: { id: encounterId },
      data: {
        status: 'DISCHARGED',
        endedAt: new Date(encounter.startedAt.getTime() + 20 * 60_000),
        dischargeCondition: 'ALIVE',
      },
    });
  }

  const notification = (notifiedById: string, notifiedAt: Date) => ({
    reportedToAuthority: true,
    authorityFormSerial: '0012345',
    injury: 'DAMAGE' as const,
    aggressorIdentified: 'YES' as const,
    aggressorRelationship: 'RELATIVE' as const,
    notifiedById,
    notifiedAt,
  });

  it('EN-242 la BASE deja completar la notificación de un positivo tras el alta, archiva la anterior con quien la registró, y no toca quién aplicó el tamizaje', async () => {
    const prisma = db();
    const ids = await anAttention(prisma);
    await insert(prisma, ids, POSITIVE);
    await discharge(prisma, ids.encounterId);
    const before = await prisma.violenceScreening.findUniqueOrThrow({
      where: { encounterId: ids.encounterId },
    });

    const notifier = await createPractitioner(prisma);
    const at = new Date(Date.now() + 60_000);
    await prisma.violenceScreening.update({
      where: { encounterId: ids.encounterId },
      data: notification(notifier.id, at),
    });

    const after = await prisma.violenceScreening.findUniqueOrThrow({
      where: { encounterId: ids.encounterId },
    });
    expect(after).toMatchObject({
      reportedToAuthority: true,
      notifiedById: notifier.id,
      notifiedAt: at,
      screenedById: before.screenedById,
      screenedAt: before.screenedAt,
      result: 'SUSPECTED',
    });
    const [archived] = await prisma.violenceScreeningVersion.findMany({
      where: { encounterId: ids.encounterId },
    });
    expect(archived).toMatchObject({
      version: 1,
      replacedById: notifier.id,
      replacedAt: at,
      data: expect.objectContaining({
        reported_to_authority: false,
      }) as unknown,
    });
  });

  it('EN-242 la BASE rechaza tras el alta cambiar el resultado, quitar la notificación, no sellarla o un tamizaje nuevo; con la atención viva, lo mismo entra', async () => {
    const prisma = db();
    const ids = await anAttention(prisma);
    await insert(prisma, ids, NOTIFIED);
    await discharge(prisma, ids.encounterId);
    const where = { encounterId: ids.encounterId };
    const later = new Date(Date.now() + 60_000);

    await expect(
      prisma.violenceScreening.update({
        where,
        data: { result: 'CONFIRMED', notifiedAt: later },
      }),
    ).rejects.toThrow(/violence_screening_after_discharge/);
    await expect(
      prisma.violenceScreening.update({
        where,
        data: {
          reportedToAuthority: false,
          authorityFormSerial: null,
          injury: null,
          aggressorIdentified: null,
          aggressorRelationship: null,
          notifiedById: null,
          notifiedAt: null,
        },
      }),
    ).rejects.toThrow(/violence_screening_after_discharge/);
    // The same notification corrected without its own stamp.
    await expect(
      prisma.violenceScreening.update({
        where,
        data: { authorityFormSerial: '0099999' },
      }),
    ).rejects.toThrow(/violence_screening_after_discharge/);

    const fresh = await anAttention(prisma);
    await discharge(prisma, fresh.encounterId);
    await expect(insert(prisma, fresh, NOTIFIED)).rejects.toThrow(
      /violence_screening_frozen/,
    );
    expect(await prisma.violenceScreeningVersion.count()).toBe(0);

    // Positive control: the correction of the notification with its stamp.
    await prisma.violenceScreening.update({
      where,
      data: { authorityFormSerial: '0099999', notifiedAt: later },
    });
    // And with the attention live, the result changes.
    const live = await anAttention(prisma);
    await insert(prisma, live, NOTIFIED);
    await prisma.violenceScreening.update({
      where: { encounterId: live.encounterId },
      data: { result: 'CONFIRMED', screenedAt: later },
    });
    expect(await prisma.violenceScreeningVersion.count()).toBe(2);
  });

  it('EN-242 la BASE rechaza tras el alta tocar cada columna de la respuesta o de quién la aplicó, aunque la notificación cambie con su sello; con la atención viva, cada cambio entra', async () => {
    const prisma = db();
    const other = await createPractitioner(prisma);
    const later = () => new Date(Date.now() + 60_000);
    const fresh = await anAttention(prisma);
    const changes: Record<string, unknown>[] = [
      { types: ['SEXUAL'] },
      { actionTaken: 'Otra acción' },
      { screeningTool: 'Otro instrumento' },
      { screenedById: other.id },
      { screenedAt: later() },
      { encounterId: fresh.encounterId },
    ];

    for (const change of changes) {
      const ids = await anAttention(prisma);
      await insert(prisma, ids, NOTIFIED);
      await discharge(prisma, ids.encounterId);
      await expect(
        prisma.violenceScreening.update({
          where: { encounterId: ids.encounterId },
          // The notification changes too, properly stamped: the rest still
          // may not.
          data: {
            ...change,
            authorityFormSerial: '0099999',
            notifiedAt: later(),
          },
        }),
        JSON.stringify(Object.keys(change)),
      ).rejects.toThrow(/violence_screening_(after_discharge|moved)/);
    }
    expect(await prisma.violenceScreeningVersion.count()).toBe(0);

    // Positive control: live, each of them goes in (but the attention's).
    for (const change of changes.slice(0, 5)) {
      const ids = await anAttention(prisma);
      await insert(prisma, ids, NOTIFIED);
      await prisma.violenceScreening.update({
        where: { encounterId: ids.encounterId },
        data: { ...change, screenedAt: later() },
      });
    }
    expect(await prisma.violenceScreeningVersion.count()).toBe(5);

    // Never to another attention, live or not.
    const live = await anAttention(prisma);
    await insert(prisma, live, POSITIVE);
    await expect(
      prisma.violenceScreening.update({
        where: { encounterId: live.encounterId },
        data: { encounterId: fresh.encounterId, screenedAt: later() },
      }),
    ).rejects.toThrow(/violence_screening_moved/);
  });

  it('EN-242 la BASE no deja volver a sellar quién notificó y cuándo sobre la misma notificación, ni con un instante anterior; con la notificación corregida y después, sí', async () => {
    const prisma = db();
    const ids = await anAttention(prisma);
    await insert(prisma, ids, NOTIFIED);
    await discharge(prisma, ids.encounterId);
    const where = { encounterId: ids.encounterId };
    const before = await prisma.violenceScreening.findUniqueOrThrow({ where });
    const other = await createPractitioner(prisma);

    await expect(
      prisma.violenceScreening.update({
        where,
        data: {
          notifiedById: other.id,
          notifiedAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow(/violence_screening_after_discharge/);
    await expect(
      prisma.violenceScreening.update({
        where,
        data: {
          authorityFormSerial: '0099999',
          notifiedById: other.id,
          notifiedAt: new Date(before.notifiedAt!.getTime() - 60_000),
        },
      }),
    ).rejects.toThrow(/violence_screening_after_discharge/);

    // Positive control: corrected and stamped after the previous one.
    await prisma.violenceScreening.update({
      where,
      data: {
        authorityFormSerial: '0099999',
        notifiedById: other.id,
        notifiedAt: new Date(before.notifiedAt!.getTime() + 60_000),
      },
    });
    expect(await prisma.violenceScreeningVersion.count()).toBe(1);
  });

  it('EN-242 EN-130 lo que rechaza el guardián se traduce a su código y no a un 403', async () => {
    const prisma = db();
    const ids = await anAttention(prisma);
    await insert(prisma, ids, POSITIVE);
    await discharge(prisma, ids.encounterId);

    expect(
      await problemFrom(
        prisma.violenceScreening.update({
          where: { encounterId: ids.encounterId },
          data: { result: 'CONFIRMED' },
        }),
      ),
    ).toMatchObject({ code: 'SCREENING_LOCKED_AFTER_DISCHARGE' });
    const fresh = await anAttention(prisma);
    await discharge(prisma, fresh.encounterId);
    expect(await problemFrom(insert(prisma, fresh, POSITIVE))).toMatchObject({
      code: 'ENCOUNTER_ALREADY_CLOSED',
    });
  });

  it('EN-242 la BASE exige quién y cuándo en todo tamizaje notificado, y ninguno sin notificar', async () => {
    const prisma = db();
    const a = await anAttention(prisma);
    const b = await anAttention(prisma);

    await expect(
      prisma.$executeRaw`
        INSERT INTO violence_screening
          (encounter_id, result, types, action_taken, reported_to_authority,
           authority_form_serial, injury, aggressor_identified, aggressor_relationship,
           screened_by_id, screened_at)
        VALUES (${a.encounterId}::uuid, 'SUSPECTED', '{PHYSICAL}', 'Derivada',
                true, '0012345', 'DAMAGE', 'YES', 'RELATIVE',
                ${a.screenedById}::uuid, ${new Date()})`,
    ).rejects.toThrow(/violence_screening_notified_who_and_when/);
    await expect(
      prisma.$executeRaw`
        INSERT INTO violence_screening
          (encounter_id, result, screened_by_id, screened_at, notified_by_id, notified_at)
        VALUES (${b.encounterId}::uuid, 'NO_SIGNS', ${b.screenedById}::uuid,
                ${new Date()}, ${b.screenedById}::uuid, ${new Date()})`,
    ).rejects.toThrow(/violence_screening_notified_who_and_when/);

    // Positive control: each said properly.
    await insert(prisma, a, NOTIFIED);
    await insert(prisma, b, { result: 'NO_SIGNS' });
    expect(await prisma.violenceScreening.count()).toBe(2);
  });
});
