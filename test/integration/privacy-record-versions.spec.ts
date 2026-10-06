import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaDiagnosticReportRepository } from '../../src/modules/orders/infrastructure/prisma-diagnostic-report.repository';
import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import { DiagnosticReportService } from '../../src/modules/orders/application/diagnostic-report.service';
import {
  VERSIONED_TABLES,
  recordVersionsOfChart,
} from '../../src/modules/privacy/infrastructure/record-version-subjects';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aScene, placeIssued } from './orders-fixtures';
import { useDatabase } from './setup/database';
import {
  createDiagnosis,
  createEncounter,
  createPatient,
  createUser,
} from './setup/fixtures';

/**
 * PD-048 (D-131.1, opción A). `record_version` guarda copias de datos de salud
 * por tabla e identificador, SIN `patient_id`. Para que el titular las reciba
 * en su exportación, cada tabla versionada declara cómo se llega a su
 * paciente — y esta prueba es lo que impide que una tabla versionada NUEVA se
 * quede fuera sin que nadie lo note: compara el registro con los disparadores
 * que la base tiene de verdad.
 */
describe('privacy: las versiones guardadas llegan a su titular', () => {
  const db = useDatabase();

  it('PD-048 toda tabla que record_version archiva declara cómo se llega a su paciente, y ninguna sobra', async () => {
    const prisma = db();
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT DISTINCT c.relname AS table_name
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE p.proname = 'record_version_archive'
         AND NOT t.tgisinternal
       ORDER BY 1`;
    const archived = rows.map((row) => row.table_name);

    // Control positivo: la consulta encuentra disparadores (no compara dos
    // listas vacías).
    expect(archived).toContain('patient_allergy');
    expect(Object.keys(VERSIONED_TABLES).sort()).toEqual(archived);
  });

  it('PD-048 cada camino declarado llega a las versiones del paciente y no a las de otro', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const mine = await everyVersionedRowOf(prisma, scene);
    // Another person, in another attention of the same clinic.
    const stranger = await createPatient(prisma);
    const theirs = await everyVersionedRowOf(prisma, {
      ...scene,
      patient: stranger,
      encounter: await createEncounter(prisma, {
        siteId: scene.site.id,
        practitionerId: scene.practitioner.id,
        patientId: stranger.id,
      }),
    });

    const found = await recordVersionsOfChart(prisma, mine.patientId, {
      includeOmitted: true,
    });

    const reached = new Set(found.map((version) => version.table));
    expect([...reached].sort()).toEqual(Object.keys(VERSIONED_TABLES).sort());
    const ids = found.map((version) => version.resourceId);
    for (const id of theirs.resourceIds) expect(ids).not.toContain(id);
    for (const id of mine.resourceIds) expect(ids).toContain(id);
  });
});

/**
 * One row of every versioned table for a fresh patient, and one archived
 * version of each. The version is inserted as the archive trigger would —
 * `record_version` is insert-only, so this is a legitimate write — because what
 * is under test is the PATH from the table to the patient, not the trigger.
 */
async function everyVersionedRowOf(
  prisma: PrismaClient,
  scene: Awaited<ReturnType<typeof aScene>>,
) {
  const author = await createUser(prisma);
  const patientId = scene.patient.id;
  const encounterId = scene.encounter.id;

  await createDiagnosis(prisma, encounterId, 'J00');
  const diagnosis = await prisma.encounterDiagnosis.findFirstOrThrow({
    where: { encounterId },
  });
  const notice = await aCriticalNotice(prisma, scene, author.id);
  const allergy = await prisma.patientAllergy.create({
    data: { patientId, substanceText: 'Penicilina', recordedById: author.id },
  });
  const history = await prisma.patientHistory.create({
    data: {
      patientId,
      kind: 'PERSONAL',
      description: 'Asma',
      recordedById: author.id,
    },
  });
  const group = await prisma.patientPriorityGroup.create({
    data: {
      patientId,
      groupCode: 'DISABILITY',
      startsOn: new Date(),
      origin: 'SELF_DECLARED',
      recordedById: author.id,
    },
  });
  const request = await prisma.dataSubjectRequest.create({
    data: {
      patientId,
      right: 'ACCESS',
      requestedBy: 'HOLDER',
      description: 'Copia',
      dueOn: new Date(),
      registeredBy: author.id,
    },
  });

  const versioned: Record<string, string> = {
    encounter: encounterId,
    // Vitals are one row per attention, archived by `encounter_id`.
    encounter_vitals: encounterId,
    encounter_diagnosis: diagnosis.id,
    critical_result_notice: notice.id,
    patient_allergy: allergy.id,
    patient_history: history.id,
    patient_priority_group: group.id,
    data_subject_request: request.id,
  };
  for (const [table, resourceId] of Object.entries(versioned)) {
    await prisma.recordVersion.create({
      data: {
        resourceType: table,
        resourceId,
        version: 1,
        data: { simulated: table },
        changedById: author.id,
        changedAt: new Date(),
      },
    });
  }
  // `patient_allergy_absence` refuses a chart with an active allergy, so its
  // row goes on after the allergy is refuted.
  await prisma.patientAllergy.update({
    where: { id: allergy.id },
    data: {
      refutedAt: new Date(),
      refutedById: author.id,
      changedById: author.id,
      changedAt: new Date(Date.now() + 1000),
    },
  });
  const absence = await prisma.patientAllergyAbsence.create({
    data: { patientId, assertedById: author.id },
  });
  await prisma.recordVersion.create({
    data: {
      resourceType: 'patient_allergy_absence',
      resourceId: absence.id,
      version: 1,
      data: { simulated: 'patient_allergy_absence' },
      changedById: author.id,
      changedAt: new Date(),
    },
  });

  return {
    patientId,
    resourceIds: [...Object.values(versioned), absence.id],
  };
}

/** ORD-064. A critical result and the notice of it, the production way. */
async function aCriticalNotice(
  prisma: PrismaClient,
  scene: Awaited<ReturnType<typeof aScene>>,
  notifiedById: string,
) {
  const client = prisma as unknown as PrismaService;
  const orders = new PrismaServiceOrderRepository(client);
  const reports = new DiagnosticReportService(
    new PrismaDiagnosticReportRepository(client),
    orders,
    new PrismaExamCatalogueRepository(client),
    { record: () => Promise.resolve() },
    {
      setContext: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never,
  );
  const order = await placeIssued(orders, {
    encounterId: scene.encounter.id,
    category: 'LABORATORY',
    priority: 'ROUTINE',
    lines: [{ examDefinitionId: scene.glucose.id }],
    sites: 'all',
  });
  const report = await reports.register(
    {
      orderId: order.id,
      performedById: null,
      issuedAt: new Date(Date.now() - 3_600_000),
      results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 25 }],
    },
    { userId: 'user-1', sites: 'all' },
  );
  return prisma.criticalResultNotice.create({
    data: {
      observationResultId: BigInt(report.results[0]!.id),
      recipientKind: 'PATIENT',
      recipientName: 'La paciente',
      channel: 'PHONE',
      notifiedById,
      notifiedAt: new Date(),
      outcome: 'NOTIFIED',
      readBackConfirmed: true,
      afterHours: false,
      selfNotice: false,
    },
  });
}
