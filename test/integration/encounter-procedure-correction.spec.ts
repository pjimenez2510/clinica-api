import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { aTariffConcept } from './orders-fixtures';
import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * EN-244 to EN-246 against a real PostgreSQL, through raw SQL: what is proved
 * is the DATABASE, so that an import or a `psql` cannot edit a procedure
 * without a stamp nor remove it without a trace. Every refusal has its
 * positive control beside it.
 */
const db = useDatabase();

async function anEncounterWithAProcedure(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  const concept = await aTariffConcept(prisma);
  const procedure = await prisma.encounterProcedure.create({
    data: {
      encounterId: encounter.id,
      conceptId: concept.id,
      procedureCode: concept.code,
      procedureDisplay: concept.display,
      quantity: 2,
      performedAt: encounter.startedAt,
    },
  });
  const user = await createUser(prisma);
  return { encounter, concept, procedure, user };
}

/** Archives the procedure exactly as it is, with who removed it and why. */
function archive(
  prisma: PrismaClient,
  procedureId: string,
  removerId: string,
  reason = 'Registrado por error',
) {
  return prisma.$executeRaw`
    INSERT INTO encounter_procedure_retraction
      (id, encounter_id, concept_id, procedure_code, procedure_display,
       quantity, performed_at, note, edited_by_id, edited_at,
       retracted_at, retracted_by_id, reason)
    SELECT id, encounter_id, concept_id, procedure_code, procedure_display,
           quantity, performed_at, note, edited_by_id, edited_at,
           ${new Date()}, ${removerId}::uuid, ${reason}
      FROM encounter_procedure WHERE id = ${procedureId}::uuid`;
}

function remove(prisma: PrismaClient, procedureId: string) {
  return prisma.$executeRaw`DELETE FROM encounter_procedure WHERE id = ${procedureId}::uuid`;
}

describe('corregir y quitar un procedimiento deja rastro (EN-244 a EN-246)', () => {
  it('EN-244 la BASE rechaza editar un procedimiento sin sello; con sello entra y la fila anterior queda en record_version', async () => {
    const prisma = db();
    const { procedure, user } = await anEncounterWithAProcedure(prisma);

    await expect(
      prisma.$executeRaw`UPDATE encounter_procedure SET quantity = 1 WHERE id = ${procedure.id}::uuid`,
    ).rejects.toThrow(/record_version_change_is_stamped/);

    const at = new Date();
    await prisma.$executeRaw`
      UPDATE encounter_procedure
         SET quantity = 1, edited_by_id = ${user.id}::uuid, edited_at = ${at}
       WHERE id = ${procedure.id}::uuid`;

    const versions = await prisma.recordVersion.findMany({
      where: { resourceType: 'encounter_procedure', resourceId: procedure.id },
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, changedById: user.id });
    expect((versions[0]!.data as { quantity: number }).quantity).toBe(2);
    expect(
      (await prisma.encounterProcedure.findUniqueOrThrow({ where: { id: procedure.id } })).quantity, // prettier-ignore
    ).toBe(1);
  });

  it('EN-245 la BASE no borra un procedimiento sin archivarlo; archivado, sí, entero y con su motivo', async () => {
    const prisma = db();
    const { procedure, user } = await anEncounterWithAProcedure(prisma);

    await expect(remove(prisma, procedure.id)).rejects.toThrow(
      /encounter_procedure_archived/,
    );
    expect(await prisma.encounterProcedure.count({ where: { id: procedure.id } })).toBe(1); // prettier-ignore

    await archive(prisma, procedure.id, user.id);
    await remove(prisma, procedure.id);

    expect(await prisma.encounterProcedure.count({ where: { id: procedure.id } })).toBe(0); // prettier-ignore
    const archived =
      await prisma.encounterProcedureRetraction.findUniqueOrThrow({
        where: { id: procedure.id },
      });
    expect(archived).toMatchObject({
      procedureCode: procedure.procedureCode,
      quantity: 2,
      retractedById: user.id,
      reason: 'Registrado por error',
      restoredAt: null,
    });
  });

  it('EN-245 la BASE rechaza archivar una versión arreglada, una nacida restaurada o sin motivo', async () => {
    const prisma = db();
    const { procedure, user } = await anEncounterWithAProcedure(prisma);

    await expect(
      prisma.$executeRaw`
        INSERT INTO encounter_procedure_retraction
          (id, encounter_id, concept_id, procedure_code, procedure_display,
           quantity, performed_at, note, retracted_at, retracted_by_id, reason)
        SELECT id, encounter_id, concept_id, procedure_code, procedure_display,
               1, performed_at, note, ${new Date()}, ${user.id}::uuid, 'x'
          FROM encounter_procedure WHERE id = ${procedure.id}::uuid`,
    ).rejects.toThrow(/encounter_procedure_retraction_matches/);

    await expect(
      prisma.$executeRaw`
        INSERT INTO encounter_procedure_retraction
          (id, encounter_id, concept_id, procedure_code, procedure_display,
           quantity, performed_at, note, retracted_at, retracted_by_id, reason,
           restored_at, restored_by_id, restored_as_id)
        SELECT id, encounter_id, concept_id, procedure_code, procedure_display,
               quantity, performed_at, note, ${new Date()}, ${user.id}::uuid, 'x',
               ${new Date()}, ${user.id}::uuid, id
          FROM encounter_procedure WHERE id = ${procedure.id}::uuid`,
    ).rejects.toThrow(/encounter_procedure_retraction_frozen/);

    await expect(archive(prisma, procedure.id, user.id, '   ')).rejects.toThrow(
      /encounter_procedure_retraction_reason_not_blank/,
    );

    // Positive control: the row as it is, with a reason, goes in.
    await archive(prisma, procedure.id, user.id);
    expect(await prisma.encounterProcedureRetraction.count({ where: { id: procedure.id } })).toBe(1); // prettier-ignore
  });

  it('EN-245 el archivo no se edita, no se borra y no se vacía, ni la tabla viva se vacía', async () => {
    const prisma = db();
    const { procedure, user } = await anEncounterWithAProcedure(prisma);
    await archive(prisma, procedure.id, user.id);
    await remove(prisma, procedure.id);

    await expect(
      prisma.$executeRaw`UPDATE encounter_procedure_retraction SET reason = 'luego' WHERE id = ${procedure.id}::uuid`,
    ).rejects.toThrow(/encounter_procedure_retraction_frozen/);
    await expect(
      prisma.$executeRaw`DELETE FROM encounter_procedure_retraction WHERE id = ${procedure.id}::uuid`,
    ).rejects.toThrow(/encounter_procedure_retraction_frozen/);
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE encounter_procedure_retraction'),
    ).rejects.toThrow(/encounter_procedure_retraction_frozen/);
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE encounter_procedure'),
    ).rejects.toThrow(/encounter_procedure_retraction_frozen/);
    expect(await prisma.encounterProcedureRetraction.count({ where: { id: procedure.id } })).toBe(1); // prettier-ignore
  });

  it('EN-246 el archivo se marca restaurado una vez, hacia ese mismo procedimiento de vuelta, y nada más', async () => {
    const prisma = db();
    const { encounter, concept, procedure, user } =
      await anEncounterWithAProcedure(prisma);
    await archive(prisma, procedure.id, user.id);
    await remove(prisma, procedure.id);

    const other = await aTariffConcept(prisma);
    const wrong = await prisma.encounterProcedure.create({
      data: {
        encounterId: encounter.id,
        conceptId: other.id,
        procedureCode: other.code,
        procedureDisplay: other.display,
        quantity: 2,
        performedAt: encounter.startedAt,
      },
    });
    const mark = (asId: string) => prisma.$executeRaw`
      UPDATE encounter_procedure_retraction
         SET restored_at = ${new Date()}, restored_by_id = ${user.id}::uuid,
             restored_as_id = ${asId}::uuid
       WHERE id = ${procedure.id}::uuid`;

    await expect(mark(wrong.id)).rejects.toThrow(
      /encounter_procedure_retraction_restored_as_itself/,
    );

    const back = await prisma.encounterProcedure.create({
      data: {
        encounterId: encounter.id,
        conceptId: concept.id,
        procedureCode: procedure.procedureCode,
        procedureDisplay: procedure.procedureDisplay,
        quantity: 2,
        performedAt: procedure.performedAt,
      },
    });
    await mark(back.id);
    const archived = await prisma.encounterProcedureRetraction.findUniqueOrThrow({ where: { id: procedure.id } }); // prettier-ignore
    expect(archived.restoredAsId).toBe(back.id);

    // Once: neither marked again nor unmarked.
    await expect(mark(back.id)).rejects.toThrow(
      /encounter_procedure_retraction_frozen/,
    );
    await expect(
      prisma.$executeRaw`
        UPDATE encounter_procedure_retraction
           SET restored_at = NULL, restored_by_id = NULL, restored_as_id = NULL
         WHERE id = ${procedure.id}::uuid`,
    ).rejects.toThrow(/encounter_procedure_retraction_frozen/);
  });
});
