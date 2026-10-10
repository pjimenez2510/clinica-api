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

import { seedBilling } from '../../prisma/seed-billing.mts';
import { aScene, aTariffConcept, placeIssued } from './orders-fixtures';
import { seedRdacaa } from '../../prisma/seed-rdacaa.mts';
import { useDatabase } from './setup/database';
import {
  createDiagnosis,
  createEncounter,
  createPatient,
  createUser,
} from './setup/fixtures';
import { InProcessLiveEventBus } from '../../src/shared/events/live-event-bus';

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
    // A price (BI-230) is versioned and nobody's: it reaches no chart.
    const ofPatients = Object.entries(VERSIONED_TABLES)
      .filter(([, path]) => !path.reachesNoPatient)
      .map(([table]) => table);
    expect([...reached].sort()).toEqual(ofPatients.sort());
    const ids = found.map((version) => version.resourceId);
    for (const id of theirs.resourceIds) expect(ids).not.toContain(id);
    for (const id of mine.resourceIds) expect(ids).toContain(id);
  });
});

describe('privacy: lo que no sale de las versiones (D-140.2)', () => {
  const db = useDatabase();

  it('PD-048 las versiones de una atención anulada y de lo que cuelga de ella no salen; las de la ficha sí', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const mine = await everyVersionedRowOf(prisma, scene);
    const hanging = [
      'encounter',
      'encounter_vitals',
      'encounter_dental_index',
      'encounter_diagnosis',
      'critical_result_notice',
    ];

    // Control positivo: con la atención viva, sus versiones salen.
    const before = await recordVersionsOfChart(prisma, mine.patientId);
    for (const table of hanging) {
      expect(before.map((version) => version.table)).toContain(table);
    }

    // «Paciente equivocado»: la atención se anula.
    const annuller = await createUser(prisma);
    const endedAt = new Date(scene.encounter.startedAt.getTime() + 20 * 60_000);
    await prisma.encounter.update({
      where: { id: scene.encounter.id },
      data: {
        status: 'ENTERED_IN_ERROR',
        endedAt,
        enteredInErrorById: annuller.id,
        enteredInErrorAt: endedAt,
      },
    });

    const after = await recordVersionsOfChart(prisma, mine.patientId);
    const tables = after.map((version) => version.table);
    for (const table of hanging) expect(tables).not.toContain(table);
    // Lo que es de la persona y no de esa atención sigue saliendo.
    expect(tables).toContain('patient_allergy');
    expect(tables).toContain('patient_history');
  });

  it('EN-093 EN-095 EN-249 las versiones de una vacunación corregida salen sin el grupo de riesgo de ninguna dosis, que puede decir VIH', async () => {
    const prisma = db();
    await seedRdacaa(prisma);
    const scene = await aScene(prisma);
    const author = await createUser(prisma);
    const recordedAt = new Date();
    await prisma.encounterVaccination.create({
      data: {
        encounterId: scene.encounter.id,
        doses: [{ code: '70', dose: 'FIRST', riskGroup: 'LIVING_WITH_HIV' }],
        recordedById: author.id,
        recordedAt,
      },
    });
    // A real correction: the trigger archives the whole previous row.
    await prisma.encounterVaccination.update({
      where: { encounterId: scene.encounter.id },
      data: {
        doses: [{ code: '70', dose: 'SECOND', riskGroup: 'LIVING_WITH_HIV' }],
        editedById: author.id,
        editedAt: new Date(recordedAt.getTime() + 1000),
      },
    });
    const archived = await prisma.recordVersion.findFirstOrThrow({
      where: { resourceType: 'encounter_vaccination', resourceId: scene.encounter.id }, // prettier-ignore
    });
    expect(archived.data).toMatchObject({ doses: [{ code: '70', dose: 'FIRST', riskGroup: 'LIVING_WITH_HIV' }] }); // prettier-ignore

    const exported = (
      await recordVersionsOfChart(prisma, scene.patient.id)
    ).filter((each) => each.table === 'encounter_vaccination');
    expect(exported).toHaveLength(1);
    // Control positivo: las dosis sí salen.
    expect(exported[0]!.data).toMatchObject({ doses: [{ code: '70', dose: 'FIRST' }] }); // prettier-ignore
    expect((exported[0]!.data as { doses: object[] }).doses[0]).not.toHaveProperty('riskGroup'); // prettier-ignore
    expect(JSON.stringify(exported)).not.toContain('LIVING_WITH_HIV');
  });

  it('PD-048 las versiones de un aviso de crítico salen sin el nombre del destinatario ni la nota', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const author = await createUser(prisma);
    const notice = await aCriticalNotice(prisma, scene, author.id);
    await prisma.recordVersion.create({
      data: {
        resourceType: 'critical_result_notice',
        resourceId: notice.id,
        version: 1,
        data: {
          id: notice.id,
          recipient_kind: 'FAMILY',
          recipient_name: 'Rosa, la hermana',
          note: 'Llamar al 0991234567 si no contesta',
          channel: 'PHONE',
          outcome: 'NOTIFIED',
        },
        changedById: author.id,
        changedAt: new Date(),
      },
    });

    const [version] = await recordVersionsOfChart(prisma, scene.patient.id);

    expect(version?.table).toBe('critical_result_notice');
    // Control positivo: lo demás de la versión sí sale.
    expect(version?.data).toMatchObject({
      recipient_kind: 'FAMILY',
      channel: 'PHONE',
      outcome: 'NOTIFIED',
    });
    expect(version?.data).not.toHaveProperty('recipient_name');
    expect(version?.data).not.toHaveProperty('note');
  });

  it('PD-048 BI-217 las versiones de una factura corregida salen sin el receptor, que puede ser otra persona', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const versions = await everyVersionedRowOf(prisma, scene);
    const invoiceId = versions.versioned.invoice!;
    const author = await createUser(prisma);
    await prisma.recordVersion.create({
      data: {
        resourceType: 'invoice',
        resourceId: invoiceId,
        version: 2,
        data: {
          id: invoiceId,
          status: 'REJECTED',
          payment_method: '01',
          buyer_identification_type: '05',
          buyer_identification: '0919176818',
          buyer_name: 'Quien deduce el gasto',
          buyer_email: 'otra.persona@example.com',
        },
        changedById: author.id,
        changedAt: new Date(),
      },
    });

    const exported = (await recordVersionsOfChart(prisma, scene.patient.id))
      .filter((each) => each.table === 'invoice')
      .map((each) => each.data as Record<string, unknown>);
    const corrected = exported.find((data) => data.status === 'REJECTED');

    // Control positivo: la versión de la factura sale, con lo que no es de nadie.
    expect(corrected).toMatchObject({
      status: 'REJECTED',
      payment_method: '01',
    });
    for (const column of [
      'buyer_identification_type',
      'buyer_identification',
      'buyer_name',
      'buyer_email',
    ]) {
      expect(corrected).not.toHaveProperty(column);
    }
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
  // EN-244. A procedure of the attention, corrected in place.
  const concept = await aTariffConcept(prisma);
  const procedure = await prisma.encounterProcedure.create({
    data: {
      encounterId,
      conceptId: concept.id,
      procedureCode: concept.code,
      procedureDisplay: concept.display,
      performedAt: scene.encounter.startedAt,
      recordedAt: new Date(),
      recordedById: author.id,
    },
  });
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
      dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      registeredBy: author.id,
    },
  });

  // AG-051, AG-064: an appointment and a waiting-list call of this patient.
  // One hour per call, so two scenes on the same practitioner never overlap.
  const hour = (await prisma.agendaEntry.count()) * 3_600_000;
  const appointment = await prisma.agendaEntry.create({
    data: {
      kind: 'APPOINTMENT',
      siteId: scene.site.id,
      practitionerId: scene.practitioner.id,
      patientId,
      startsAt: new Date(
        scene.encounter.startedAt.getTime() - 3_600_000 - hour,
      ),
      endsAt: new Date(scene.encounter.startedAt.getTime() - 3_000_000 - hour),
      bookingChannel: 'PHONE',
      createdById: author.id,
    },
  });
  const waiting = await prisma.waitlistEntry.create({
    data: {
      patientId,
      siteId: scene.site.id,
      preferredFrom: new Date(),
      preferredTo: new Date(),
    },
  });
  const call = await prisma.waitlistContactAttempt.create({
    data: {
      waitlistEntryId: waiting.id,
      recordedById: author.id,
      outcome: 'NO_ANSWER',
    },
  });

  // BI-195: a charge on this patient's account.
  await seedBilling(prisma);
  const payer = await prisma.payer.findUniqueOrThrow({
    where: { code: 'PARTICULAR' },
  });
  const account = await prisma.patientAccount.create({
    data: {
      patientId,
      siteId: scene.site.id,
      payerId: payer.id,
      priceListId: (
        await prisma.priceList.findFirstOrThrow({
          where: { payerId: payer.id },
        })
      ).id,
    },
  });
  const service = await prisma.billableService.findUniqueOrThrow({
    where: { code: 'CONS-MG-PV' },
  });
  const charge = await prisma.chargeItem.create({
    data: {
      accountId: account.id,
      billableServiceId: service.id,
      serviceDate: new Date(scene.encounter.startedAt),
      unitAmount: 25,
      serviceDisplay: service.name,
      taxSriCode: '0',
      createdById: author.id,
    },
  });

  // BI-215, BI-217: the account and an invoice of it. The invoice row is
  // written by SQL: issuing goes through the repository, and only its
  // existence matters here.
  const emissionPoint = await prisma.emissionPoint.create({
    data: { siteId: scene.site.id, code: String((await prisma.emissionPoint.count()) + 100).slice(-3), description: 'Caja' }, // prettier-ignore
  });
  const invoice = await prisma.invoice.create({
    data: {
      accountId: account.id,
      siteId: scene.site.id,
      emissionPointId: emissionPoint.id,
      sequential: '000000001',
      buyerIdentificationType: '05',
      buyerIdentification: '1710034065',
      buyerName: 'Receptor',
      subtotalTaxed: 0,
      subtotalUntaxed: 25,
      taxTotal: 0,
      total: 25,
      status: 'ISSUED',
      issuedAt: new Date(),
      issuedById: author.id,
    },
  });

  const versioned: Record<string, string> = {
    encounter: encounterId,
    // Vitals are one row per attention, archived by `encounter_id`.
    encounter_vitals: encounterId,
    // EN-052. The dental index too: one row per attention.
    encounter_dental_index: encounterId,
    // EN-249. The program blocks G, H and I, the same way.
    encounter_obstetric: encounterId,
    encounter_nutrition: encounterId,
    encounter_vaccination: encounterId,
    // EN-096. The supplements, the same way.
    encounter_supplement: encounterId,
    encounter_diagnosis: diagnosis.id,
    encounter_procedure: procedure.id,
    critical_result_notice: notice.id,
    patient_allergy: allergy.id,
    patient_history: history.id,
    patient_priority_group: group.id,
    data_subject_request: request.id,
    agenda_entry: appointment.id,
    charge_item: charge.id,
    patient_account: account.id,
    invoice: invoice.id,
    waitlist_contact_attempt: call.id,
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
    versioned,
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
    new InProcessLiveEventBus(),
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
