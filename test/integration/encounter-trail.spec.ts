import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * What the DATABASE guarantees about an attention's trail, place and keeping
 * (EN-010, EN-012, EN-013, EN-018, EN-133, EN-157).
 *
 * Every refusal goes with its positive control: the permitted case through
 * the same path. A refusal alone would also pass if the check refused
 * everything.
 */
const db = useDatabase();
const MINUTE = 60_000;

async function anAttention(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  return { site, practitioner, patient, encounter };
}

const trailOf = (prisma: PrismaClient, encounterId: string) =>
  prisma.encounterStatusHistory.findMany({
    where: { encounterId },
    orderBy: { id: 'asc' },
  });

describe('EN-018 una atención no se borra', () => {
  it('EN-018 la base rechaza el DELETE de una atención vacía y el TRUNCATE de la tabla', async () => {
    const prisma = db();
    const { encounter } = await anAttention(prisma);

    await expect(
      prisma.$executeRaw`DELETE FROM encounter WHERE id = ${encounter.id}::uuid`,
    ).rejects.toThrow(/encounter_never_deleted/);
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE encounter CASCADE'),
    ).rejects.toThrow(/encounter_never_deleted/);

    // Control positivo: la misma atención se anula, con quién y cuándo, y
    // sigue ahí.
    const annuller = await createUser(prisma);
    const at = new Date(encounter.startedAt.getTime() + 5 * MINUTE);
    await prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        status: 'ENTERED_IN_ERROR',
        endedAt: at,
        enteredInErrorById: annuller.id,
        enteredInErrorAt: at,
      },
    });
    await expect(
      prisma.encounter.count({ where: { id: encounter.id } }),
    ).resolves.toBe(1);
  });
});

describe('EN-010 el cierre no es anterior a la apertura', () => {
  it('EN-010 la base rechaza un ended_at anterior a started_at y admite el mismo instante', async () => {
    const prisma = db();
    const { encounter } = await anAttention(prisma);
    const annuller = await createUser(prisma);
    const before = new Date(encounter.startedAt.getTime() - MINUTE);

    await expect(
      prisma.encounter.update({
        where: { id: encounter.id },
        data: {
          status: 'ENTERED_IN_ERROR',
          endedAt: before,
          enteredInErrorById: annuller.id,
          enteredInErrorAt: before,
        },
      }),
    ).rejects.toThrow(/encounter_time_order/);

    // Control positivo: el mismo instante de la apertura sí.
    await prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        status: 'ENTERED_IN_ERROR',
        endedAt: encounter.startedAt,
        enteredInErrorById: annuller.id,
        enteredInErrorAt: encounter.startedAt,
      },
    });
  });
});

describe('EN-133 el historial de estados lo escribe la base', () => {
  it('EN-127 EN-133 abrir deja una fila OPENED con quien abrió y el instante de la fila', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    const opener = await createUser(prisma);

    const encounter = await prisma.encounter.create({
      data: {
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        startedAt: new Date(Date.now() - 30 * MINUTE),
        careModality: 'MORBIDITY',
        visitSequence: 'FIRST_TIME',
        openedById: opener.id,
      },
    });

    expect(encounter.status).toBe('OPEN');
    expect(await trailOf(prisma, encounter.id)).toEqual([
      expect.objectContaining({
        fromStatus: null,
        toStatus: 'OPEN',
        fact: 'OPENED',
        changedById: opener.id,
        changedAt: encounter.createdAt,
      }),
    ]);
  });

  it('EN-133 interrumpir deja quién y cuándo de su constancia, aunque lo escriba otro módulo', async () => {
    const prisma = db();
    const { encounter } = await anAttention(prisma);
    const receptionist = await createUser(prisma);
    const at = new Date(encounter.startedAt.getTime() + 10 * MINUTE);

    // Lo que hace `agenda` cuando el paciente se va sin ser visto (AG-148):
    // escribe la atención directamente, sin pasar por este módulo.
    await prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        status: 'DISCONTINUED',
        endedAt: at,
        discontinuedReason: 'Se fue sin ser atendido',
        discontinuedOrigin: 'PATIENT',
        discontinuedById: receptionist.id,
        discontinuedAt: at,
      },
    });

    const trail = await trailOf(prisma, encounter.id);
    expect(trail.map((row) => row.fact)).toEqual(['OPENED', 'INTERRUPTED']);
    expect(trail[1]).toMatchObject({
      fromStatus: 'OPEN',
      toStatus: 'DISCONTINUED',
      changedById: receptionist.id,
      changedAt: at,
    });
  });

  it('EN-133 una escritura que no cambia el estado no deja fila', async () => {
    const prisma = db();
    const { encounter } = await anAttention(prisma);
    await prisma.encounter.update({
      where: { id: encounter.id },
      data: { status: 'OPEN' },
    });
    expect(await trailOf(prisma, encounter.id)).toHaveLength(1);
  });

  it('EN-133 la base rechaza editar, borrar y vaciar el historial', async () => {
    const prisma = db();
    const { encounter } = await anAttention(prisma);
    const [row] = await trailOf(prisma, encounter.id);

    await expect(
      prisma.$executeRaw`UPDATE encounter_status_history SET fact = 'ANNULLED' WHERE id = ${row!.id}`,
    ).rejects.toThrow(/encounter_status_history_immutable/);
    await expect(
      prisma.$executeRaw`DELETE FROM encounter_status_history WHERE id = ${row!.id}`,
    ).rejects.toThrow(/encounter_status_history_immutable/);
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE encounter_status_history'),
    ).rejects.toThrow(/encounter_status_history_immutable/);

    // Control positivo: el historial crece, con la misma tabla y sin tocarla.
    const annuller = await createUser(prisma);
    const at = new Date(encounter.startedAt.getTime() + MINUTE);
    await prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        status: 'ENTERED_IN_ERROR',
        endedAt: at,
        enteredInErrorById: annuller.id,
        enteredInErrorAt: at,
      },
    });
    expect((await trailOf(prisma, encounter.id)).map((r) => r.fact)).toEqual([
      'OPENED',
      'ANNULLED',
    ]);
  });

  it('EN-133 sólo la apertura no tiene estado de origen', async () => {
    const prisma = db();
    const { encounter } = await anAttention(prisma);
    await expect(
      prisma.$executeRaw`INSERT INTO encounter_status_history
        (encounter_id, from_status, to_status, fact, changed_at)
        VALUES (${encounter.id}::uuid, NULL, 'DISCHARGED', 'NOTE_SIGNED', ${encounter.createdAt})`,
    ).rejects.toThrow(/encounter_status_history_origin/);
  });
});

describe('EN-012, EN-013 el lugar de atención y la estrategia', () => {
  it('EN-012 la base rechaza un lugar fuera del catálogo y admite del 1 al 16 y el 98', async () => {
    const prisma = db();
    const { encounter } = await anAttention(prisma);
    const editor = await createUser(prisma);

    for (const carePlace of [0, 17, 97]) {
      // Con el sello que exige la corrección: lo que se prueba es el catálogo.
      await expect(
        prisma.$executeRaw`UPDATE encounter SET care_place = ${carePlace}::smallint, corrected_by_id = ${editor.id}::uuid, corrected_at = ${new Date()} WHERE id = ${encounter.id}::uuid`,
      ).rejects.toThrow(/encounter_care_place_in_catalogue/);
    }

    // Control positivo: el 98 «Otros», con el sello que exige la corrección.
    await prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        carePlace: 98,
        correctedById: editor.id,
        correctedAt: new Date(),
      },
    });
  });

  it('EN-012 el ámbito intramural o extramural lo deriva la base del lugar, y no se puede contradecir', async () => {
    const prisma = db();
    const { encounter } = await anAttention(prisma);
    expect(encounter).toMatchObject({
      carePlace: 1,
      careSetting: 'INTRAMURAL',
    });

    const editor = await createUser(prisma);
    const home = await prisma.encounter.update({
      where: { id: encounter.id },
      data: { carePlace: 4, correctedById: editor.id, correctedAt: new Date() },
    });
    expect(home.careSetting).toBe('EXTRAMURAL');

    // Escribir el ámbito a mano no lo separa del lugar.
    const forced = await prisma.encounter.update({
      where: { id: encounter.id },
      data: { careSetting: 'INTRAMURAL' },
    });
    expect(forced.careSetting).toBe('EXTRAMURAL');
  });

  it('EN-013 EN-215 corregir Médico del Barrio exige sello y guarda la atención anterior', async () => {
    const prisma = db();
    const { encounter } = await anAttention(prisma);

    await expect(
      prisma.encounter.update({
        where: { id: encounter.id },
        data: { medicoDelBarrio: true },
      }),
    ).rejects.toThrow(/record_version_change_is_stamped/);

    // Control positivo: con sello, pasa y queda la versión anterior.
    const editor = await createUser(prisma);
    await prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        medicoDelBarrio: true,
        correctedById: editor.id,
        correctedAt: new Date(),
      },
    });
    const versions = await prisma.$queryRaw<{ was: boolean }[]>`
      SELECT (data->>'medico_del_barrio')::boolean AS was
        FROM record_version
       WHERE resource_type = 'encounter' AND resource_id = ${encounter.id}::uuid`;
    expect(versions).toEqual([{ was: false }]);
  });
});

describe('EN-157 el plazo de conservación no baja de quince años', () => {
  it('EN-032 EN-157 la base rechaza catorce años y admite quince y veinte', async () => {
    const prisma = db();
    const site = await createSite(prisma);

    await expect(
      prisma.siteParameter.update({
        where: { siteId: site.id },
        data: { recordRetentionYears: 14 },
      }),
    ).rejects.toThrow(/site_parameter_retention_minimum/);

    // Control positivo: el mínimo y uno mayor.
    for (const years of [15, 20]) {
      await prisma.siteParameter.update({
        where: { siteId: site.id },
        data: { recordRetentionYears: years },
      });
    }
  });
});
