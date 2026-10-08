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
  return prisma.$executeRaw`
    INSERT INTO violence_screening
      (encounter_id, result, types, action_taken, reported_to_authority,
       authority_form_serial, injury, aggressor_identified, aggressor_relationship,
       screened_by_id, screened_at)
    VALUES (${ids.encounterId}::uuid, ${row.result}::violence_screening_result,
            ${row.types ?? null}::violence_type[], ${row.actionTaken ?? null},
            ${row.reported ?? false}, ${row.serial ?? null},
            ${row.injury ?? null}::violence_injury,
            ${row.identified ?? null}::aggressor_identified,
            ${row.relationship ?? null}::aggressor_relationship,
            ${ids.screenedById}::uuid, ${new Date()})`;
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
