import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import { ServiceOrderService } from '../../src/modules/orders/application/service-order.service';
import { PrismaAccessAuditRecorder } from '../../src/shared/infrastructure/audit/prisma-access-audit.recorder';
import { PrismaPatientRepository } from '../../src/modules/patients/infrastructure/prisma-patient.repository';
import { addDays, clinicalDateOf } from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { placeIssued, aScene, aTariffConcept } from './orders-fixtures';
import { attemptWhileAnnulled } from './setup/encounter-race';
import { useDatabase } from './setup/database';
import { createPatient, createSite, createUser } from './setup/fixtures';

/**
 * The order against a real PostgreSQL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT ONLY THE DATABASE CAN DEMONSTRATE HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  - `trg_service_order_item_pending` keeping `pending_items` in step with the
 *    lines. That counter exists ONLY so the worklist can be a partial index —
 *    index predicates cannot contain subqueries — so if it drifts, the whole
 *    worklist silently stops listing orders that are pending. A double
 *    returning what we asked it for proves nothing about it.
 *  - The tariff concept's validity resolved with `daterange @>` in
 *    `America/Guayaquil`. Prisma models `valid_period` as `Unsupported`, so
 *    this cannot even be expressed through the client.
 *  - `chartScope` following a merge: an order placed on the chart that a merge
 *    later absorbed is STILL that person's, and the link only exists in the
 *    database.
 *
 * ⚠️ THE CEDULAS CARRY A COMPUTED CHECK DIGIT. `is_valid_cedula()` refuses made
 * up ones, so a random number would fail for the wrong reason.
 */
const db = useDatabase();

const CEDULA = '1710034065';
const OTHER_CEDULA = '1713175071';

/** A `date` column for a clinical date: midnight UTC is that calendar day. */
const dateColumn = (day: string) => new Date(day);

const ordersOf = (prisma: PrismaClient) =>
  new PrismaServiceOrderRepository(prisma as unknown as PrismaService);

const catalogueOf = (prisma: PrismaClient) =>
  new PrismaExamCatalogueRepository(prisma as unknown as PrismaService);

describe('la orden de exámenes contra PostgreSQL', () => {
  it('ORD-002 emite una línea por examen y congela su código y su nombre', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    const order = await placeIssued(ordersOf(prisma), {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [
        { examDefinitionId: scene.bh.id },
        { examDefinitionId: scene.glucose.id },
      ],
      sites: 'all',
    });

    expect(order.items).toHaveLength(2);
    expect(order.items.map((item) => item.testCode).sort()).toEqual([
      'EX-BH',
      'EX-GLUCOSA-AYUNAS',
    ]);
    // ORD-001. Firmada por el profesional DE LA ATENCIÓN, no por un id enviado.
    expect(order.orderedById).toBe(scene.practitioner.id);
    expect(order.siteId).toBe(scene.site.id);
  });

  it('ORD-006 la orden emitida vuelve con su número, y la segunda con el siguiente', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const place = () =>
      placeIssued(ordersOf(prisma), {
        encounterId: scene.encounter.id,
        category: 'LABORATORY',
        priority: 'ROUTINE',
        lines: [{ examDefinitionId: scene.bh.id }],
        sites: 'all',
      });

    const first = await place();
    const second = await place();

    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
    expect(
      (await ordersOf(prisma).byId({ orderId: second.id, sites: 'all' }))
        ?.number,
    ).toBe(2);
  });

  it('ORD-005 pedir mientras la atención se anula: la orden no nace en una atención anulada', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const place = () =>
      placeIssued(ordersOf(prisma), {
        encounterId: scene.encounter.id,
        category: 'LABORATORY',
        priority: 'ROUTINE',
        lines: [{ examDefinitionId: scene.bh.id }],
        sites: 'all',
      });

    // Control positivo: sin carrera, el mismo camino emite.
    await expect(place()).resolves.toMatchObject({ number: 1 });

    const outcome = await attemptWhileAnnulled(
      prisma,
      scene.encounter.id,
      place,
    );

    expect(outcome).toMatchObject({
      status: 'rejected',
      reason: { code: 'ORDER_ENCOUNTER_NOT_OPEN' },
    });
    expect(await prisma.serviceOrder.count()).toBe(1);
  });

  it('ORD-002 mantiene `pending_items` en paso con las líneas, por disparador', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    const order = await placeIssued(ordersOf(prisma), {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [
        { examDefinitionId: scene.bh.id },
        { examDefinitionId: scene.glucose.id },
      ],
      sites: 'all',
    });

    // `trg_service_order_item_pending` es lo único que hace posible que la
    // cola sea un índice parcial: si se desfasa, la cola deja de listar
    // órdenes pendientes SIN FALLAR.
    const stored = await prisma.serviceOrder.findFirstOrThrow({
      where: { id: order.id },
      select: { pendingItems: true },
    });
    expect(stored.pendingItems).toBe(2);
  });

  it('ORD-007 anula una línea sin borrarla, y el contador baja solo', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const repository = ordersOf(prisma);

    const order = await placeIssued(repository, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [
        { examDefinitionId: scene.bh.id },
        { examDefinitionId: scene.glucose.id },
      ],
      sites: 'all',
    });
    const [first] = order.items;

    const after = await repository.cancelItem({
      orderId: order.id,
      itemId: first?.id ?? '',
      sites: 'all',
    });

    // La fila SIGUE: borrarla perdería que alguien pidió algo y se arrepintió.
    expect(after.items).toHaveLength(2);
    expect(after.pendingItems).toBe(1);
    expect(after.items.find((item) => item.id === first?.id)).toMatchObject({
      status: 'CANCELLED',
    });
    expect(after.items.find((item) => item.id === first?.id)?.completedAt).not.toBeNull(); // prettier-ignore
  });

  it('ORD-008 rechaza anular dos veces la misma línea', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const repository = ordersOf(prisma);

    const order = await placeIssued(repository, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.bh.id }],
      sites: 'all',
    });
    const itemId = order.items[0]?.id ?? '';

    await repository.cancelItem({ orderId: order.id, itemId, sites: 'all' });

    await expect(
      repository.cancelItem({ orderId: order.id, itemId, sites: 'all' }),
    ).rejects.toMatchObject({ code: 'ORDER_ITEM_NOT_PENDING' });
  });

  it('ORD-003 rechaza la orden ENTERA si un examen está deshabilitado', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    await prisma.examDefinition.update({
      where: { id: scene.glucose.id },
      data: { active: false },
    });

    await expect(
      placeIssued(ordersOf(prisma), {
        encounterId: scene.encounter.id,
        category: 'LABORATORY',
        priority: 'ROUTINE',
        lines: [
          { examDefinitionId: scene.bh.id },
          { examDefinitionId: scene.glucose.id },
        ],
        sites: 'all',
      }),
    ).rejects.toMatchObject({ code: 'EXAM_NOT_ORDERABLE' });

    // Ni la orden ni la línea buena: todo o nada.
    expect(await prisma.serviceOrder.count()).toBe(0);
    expect(await prisma.serviceOrderItem.count()).toBe(0);
  });

  it('ORD-004 la línea toma la prestación del tarifario VIGENTE del examen, sin que el cliente la envíe', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const clinicalDay = clinicalDateOf(scene.encounter.startedAt);
    // Una versión anterior de la misma prestación, retirada antes de la
    // atención: el catálogo se versiona y el examen apunta al CÓDIGO. La
    // vigente empieza después, porque la base no deja que dos versiones de un
    // código se solapen.
    await prisma.catalogConcept.update({
      where: { id: scene.concept.id },
      data: { validFrom: dateColumn(addDays(clinicalDay, -100)) },
    });
    await aTariffConcept(prisma, {
      code: 'EX-BH',
      validFrom: dateColumn(addDays(clinicalDay, -400)),
      validTo: dateColumn(addDays(clinicalDay, -200)),
    });

    const order = await placeIssued(ordersOf(prisma), {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.bh.id }],
      sites: 'all',
    });

    expect(order.items[0]?.conceptId).toBe(scene.concept.id);
  });

  it('ORD-004 rechaza un examen que no tiene prestación en el tarifario', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    await prisma.examDefinition.update({
      where: { id: scene.bh.id },
      data: { tariffCode: null },
    });

    await expect(
      placeIssued(ordersOf(prisma), {
        encounterId: scene.encounter.id,
        category: 'LABORATORY',
        priority: 'ROUTINE',
        lines: [{ examDefinitionId: scene.bh.id }],
        sites: 'all',
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_CONCEPT_NOT_FOUND' });
    expect(await prisma.serviceOrder.count()).toBe(0);
  });

  it('ORD-004 rechaza un examen cuyo código no está en el TARIFARIO aunque exista en otro catálogo', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    await aTariffConcept(prisma, { systemCode: 'CIE10', code: 'J020' });
    await prisma.examDefinition.update({
      where: { id: scene.bh.id },
      data: { tariffCode: 'J020' },
    });

    // La clave foránea apunta a `catalog_concept`, que guarda TODOS los
    // catálogos: sin esta comprobación un código CIE-10 se pide como examen.
    await expect(
      placeIssued(ordersOf(prisma), {
        encounterId: scene.encounter.id,
        category: 'LABORATORY',
        priority: 'ROUTINE',
        lines: [{ examDefinitionId: scene.bh.id }],
        sites: 'all',
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_CONCEPT_NOT_FOUND' });
  });

  it('ORD-004 rechaza la prestación retirada antes del día de la atención', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const clinicalDay = clinicalDateOf(scene.encounter.startedAt);
    await prisma.examDefinition.update({
      where: { id: scene.bh.id },
      data: { tariffCode: 'T-RETIRADO' },
    });
    await aTariffConcept(prisma, {
      code: 'T-RETIRADO',
      validFrom: dateColumn(addDays(clinicalDay, -400)),
      validTo: dateColumn(addDays(clinicalDay, -1)),
    });

    // La vigencia se evalúa con `daterange @>` sobre una columna GENERADA, que
    // Prisma modela como `Unsupported`: no se puede ni expresar por el cliente.
    await expect(
      placeIssued(ordersOf(prisma), {
        encounterId: scene.encounter.id,
        category: 'LABORATORY',
        priority: 'ROUTINE',
        lines: [{ examDefinitionId: scene.bh.id }],
        sites: 'all',
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_CONCEPT_NOT_IN_FORCE' });
  });

  it('ORD-005 rechaza pedir exámenes en una atención ya cerrada', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    await prisma.encounter.update({
      where: { id: scene.encounter.id },
      data: {
        status: 'COMPLETED',
        // Después de `started_at`, que el fixture pone en el 14-09-2026:
        // `encounter_time_order` no admite una atención que termina antes de
        // empezar, y con razón.
        endedAt: new Date('2026-09-14T15:00:00Z'),
        dischargeCondition: 'ALIVE',
      },
    });

    await expect(
      placeIssued(ordersOf(prisma), {
        encounterId: scene.encounter.id,
        category: 'LABORATORY',
        priority: 'ROUTINE',
        lines: [{ examDefinitionId: scene.bh.id }],
        sites: 'all',
      }),
    ).rejects.toMatchObject({ code: 'ORDER_ENCOUNTER_NOT_OPEN' });
  });

  it('ORD-090 responde que la atención no existe cuando es de otra sede', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const otherSite = await createSite(prisma, 'Sede Norte');

    await expect(
      placeIssued(ordersOf(prisma), {
        encounterId: scene.encounter.id,
        category: 'LABORATORY',
        priority: 'ROUTINE',
        lines: [{ examDefinitionId: scene.bh.id }],
        sites: [otherSite.id],
      }),
    ).rejects.toMatchObject({ code: 'ORDER_ENCOUNTER_NOT_FOUND' });
  });

  it('ORD-020 y ORD-021 listan lo pendiente de lo más antiguo a lo más nuevo, con sus días', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const repository = ordersOf(prisma);

    const old = await placeIssued(repository, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.bh.id }],
      sites: 'all',
    });
    const fresh = await placeIssued(repository, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.glucose.id }], // prettier-ignore
      sites: 'all',
    });

    const now = new Date('2026-09-25T18:00:00Z');
    await prisma.serviceOrder.update({
      where: { id: old.id },
      data: { requestedAt: new Date('2026-09-15T18:00:00Z') },
    });
    await prisma.serviceOrder.update({
      where: { id: fresh.id },
      data: { requestedAt: new Date('2026-09-25T14:00:00Z') },
    });

    const worklist = await repository.pending({ sites: 'all', now, limit: 50 });

    expect(worklist.map((entry) => entry.orderId)).toEqual([old.id, fresh.id]);
    expect(worklist[0]?.ageing.waitingDays).toBe(10);
    expect(worklist[1]?.ageing.waitingDays).toBe(0);
    // ORD-022. `EX-BH` promete cuatro horas: diez días después está vencida.
    expect(worklist[0]?.ageing.overdue).toBe(true);
    // Y el examen que no promete plazo contesta «no hay plazo», no «va bien».
    expect(worklist[1]?.ageing.overdue).toBeNull();
    expect(worklist[1]?.ageing.dueAt).toBeNull();
  });

  it('ORD-020 saca de la cola la línea que ya se resolvió, sin tocar la consulta', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const repository = ordersOf(prisma);

    const order = await placeIssued(repository, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.bh.id }],
      sites: 'all',
    });
    await repository.cancelItem({
      orderId: order.id,
      itemId: order.items[0]?.id ?? '',
      sites: 'all',
    });

    // La fila SALE del índice parcial al ponerse `completed_at`: es lo que
    // mantiene la cola pequeña y en memoria por construcción.
    const worklist = await repository.pending({
      sites: 'all',
      now: new Date(),
      limit: 50,
    });
    expect(worklist).toEqual([]);
  });

  it('ORD-025 filtra la cola por examen sin perder el resto de la orden', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const repository = ordersOf(prisma);

    await placeIssued(repository, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [
        { examDefinitionId: scene.bh.id },
        { examDefinitionId: scene.glucose.id },
      ],
      sites: 'all',
    });

    const worklist = await repository.pending({
      sites: 'all',
      examCode: 'EX-BH',
      now: new Date(),
      limit: 50,
    });

    expect(worklist).toHaveLength(1);
    expect(worklist[0]?.testCode).toBe('EX-BH');
  });

  /**
   * D-068 C. El informe del recién nacido llega rotulado «RN de …» con la
   * cédula de la madre; si la madre tiene pendiente el mismo examen, el
   * resultado del bebé cabe en la orden de la madre. Con el nombre en la fila,
   * quien tiene el papel ve a quién corresponde cada orden.
   */
  it('ORD-026 al buscar por cédula enseña sólo las órdenes de esa ficha con su nombre, y la cola sin filtro no lleva ninguno', async () => {
    const prisma = db();
    // Dos personas con una orden pendiente cada una, en la misma sede: la
    // madre con cédula y otra paciente con otra.
    const mother = await aScene(prisma);
    await prisma.patientIdentifier.create({
      data: { patientId: mother.patient.id, type: 'CEDULA', value: CEDULA },
    });
    await prisma.patient.update({
      where: { id: mother.patient.id },
      data: {
        givenName: 'María',
        secondGivenName: 'Elena',
        familyName: 'Guamán',
        secondFamilyName: 'Pilco',
      },
    });
    const other = await createPatient(prisma);
    await prisma.patient.update({
      where: { id: other.id },
      data: { givenName: 'Rosa', familyName: 'Chicaiza' },
    });
    await prisma.patientIdentifier.create({
      data: { patientId: other.id, type: 'CEDULA', value: OTHER_CEDULA },
    });
    const otherEncounter = await prisma.encounter.create({
      data: {
        siteId: mother.site.id,
        practitionerId: mother.practitioner.id,
        patientId: other.id,
        startedAt: new Date(),
        careModality: 'MORBIDITY',
        visitSequence: 'FIRST_TIME',
      },
    });
    const place = (encounterId: string) =>
      placeIssued(ordersOf(prisma), {
        encounterId,
        category: 'LABORATORY',
        priority: 'ROUTINE',
        lines: [{ examDefinitionId: mother.bh.id }],
        sites: 'all',
      });
    const mothers = await place(mother.encounter.id);
    const others = await place(otherEncounter.id);

    const logger = {
      setContext: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    const service = new ServiceOrderService(
      ordersOf(prisma),
      catalogueOf(prisma),
      logger as never,
      new PrismaAccessAuditRecorder(prisma as unknown as PrismaService, logger as never), // prettier-ignore
    );
    // Un usuario de verdad: la bitácora guarda su id, que es un uuid.
    const reader = await createUser(prisma);
    const requester = { userId: reader.id, sites: 'all' as const };
    const now = new Date();

    const byCedula = await service.pending({ cedula: CEDULA, limit: 50 }, requester, now); // prettier-ignore
    expect(byCedula.map((entry) => entry.orderId)).toEqual([mothers.id]);
    // Los dos nombres y los dos apellidos: es lo que separa a dos homónimos.
    expect(byCedula[0]?.patientName).toBe('María Elena Guamán Pilco');

    // ORD-024: sin cédula vuelven las dos, y ninguna dice de quién es.
    const unfiltered = await service.pending({ limit: 50 }, requester, now);
    expect(unfiltered.map((entry) => entry.orderId).sort()).toEqual([mothers.id, others.id].sort()); // prettier-ignore
    expect(unfiltered.every((entry) => entry.patientName === null)).toBe(true);

    // Y la búsqueda por cédula, sólo ella, deja su fila en la bitácora.
    const trail = await prisma.accessAudit.findMany({ where: { resourceType: 'patient' } }); // prettier-ignore
    expect(trail.map((row) => row.resourceId)).toEqual([mother.patient.id]);
  });

  it('ORD-081 encuentra la ficha por su cédula, y ninguna por una que nadie lleva', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    await prisma.patientIdentifier.create({
      data: { patientId: scene.patient.id, type: 'CEDULA', value: CEDULA },
    });

    const repository = ordersOf(prisma);
    expect(await repository.chartByCedula(CEDULA)).toBe(scene.patient.id);
    // ORD-080. No hay contraparte que cree ficha: la respuesta es «no está».
    expect(await repository.chartByCedula(OTHER_CEDULA)).toBeUndefined();
    expect(await prisma.patient.count()).toBe(1);
  });

  /**
   * ⚠️ THE FOREIGN ROW GOES IN FIRST, on purpose. Without `ORDER BY`, a lookup
   * by the bare number returns whichever row the scan meets first, which on a
   * freshly written table is usually the oldest — so this order is the one
   * that exposes it. The reverse order is asserted too, so a pass cannot be
   * physical-order luck.
   */
  it('ORD-081 abre la ficha de la cédula ECU aunque otra ficha lleve el mismo número emitido por COL', async () => {
    const prisma = db();

    for (const foreignFirst of [true, false]) {
      await prisma.patientIdentifier.deleteMany();
      const foreign = await createPatient(prisma);
      const ecuadorian = await createPatient(prisma);
      const rows = [
        { patientId: foreign.id, type: 'CEDULA' as const, issuingCountry: 'COL', value: CEDULA }, // prettier-ignore
        { patientId: ecuadorian.id, type: 'CEDULA' as const, issuingCountry: 'ECU', value: CEDULA }, // prettier-ignore
      ];
      for (const data of foreignFirst ? rows : rows.reverse()) {
        await prisma.patientIdentifier.create({ data });
      }

      // Control positivo: la base deja coexistir las dos (PA-010, PA-013).
      expect(await prisma.patientIdentifier.count({ where: { value: CEDULA } })).toBe(2); // prettier-ignore

      expect(await ordersOf(prisma).chartByCedula(CEDULA)).toBe(ecuadorian.id);
    }
  });

  it('ORD-081 no abre la ficha que lleva el número como cédula extranjera: va a la cola manual', async () => {
    const prisma = db();
    const foreign = await createPatient(prisma);
    await prisma.patientIdentifier.create({
      data: { patientId: foreign.id, type: 'CEDULA', issuingCountry: 'COL', value: CEDULA }, // prettier-ignore
    });

    expect(await prisma.patientIdentifier.count({ where: { value: CEDULA } })).toBe(1); // prettier-ignore
    expect(await ordersOf(prisma).chartByCedula(CEDULA)).toBeUndefined();
  });

  it('ORD-081 abre la ficha de la cédula OFFICIAL y no la de quien la lleva como OLD', async () => {
    const prisma = db();
    const stale = await createPatient(prisma);
    const holder = await createPatient(prisma);
    await prisma.patientIdentifier.create({
      data: { patientId: stale.id, type: 'CEDULA', value: CEDULA, use: 'OLD' },
    });
    await prisma.patientIdentifier.create({
      data: { patientId: holder.id, type: 'CEDULA', value: CEDULA },
    });

    // Control positivo: el índice parcial no alcanza a `OLD` (PA-014).
    expect(await prisma.patientIdentifier.count({ where: { value: CEDULA, issuingCountry: 'ECU' } })).toBe(2); // prettier-ignore

    expect(await ordersOf(prisma).chartByCedula(CEDULA)).toBe(holder.id);
  });

  /**
   * ORD-081 THROUGH THE REAL MERGE, not a hand-written `merged_into_id`: the
   * merge is what re-points the `OFFICIAL` row to the survivor and the trigger
   * is what clears `patient_merged`, and the new filter depends on both. If
   * either stopped, every merged patient would answer RESULT_CHART_UNMATCHED
   * on the paper path.
   */
  it('ORD-081 lleva la cédula de la ficha absorbida a la superviviente, con sus órdenes, y la devuelve al deshacer', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const repository = ordersOf(prisma);
    const patients = new PrismaPatientRepository(prisma as unknown as PrismaService); // prettier-ignore
    const author = await createUser(prisma);
    await prisma.patientIdentifier.create({
      data: { patientId: scene.patient.id, type: 'CEDULA', value: CEDULA },
    });
    await placeIssued(repository, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.bh.id }],
      sites: 'all',
    });
    const survivor = await createPatient(prisma);

    const merged = await patients.merge({
      sourcePatientId: scene.patient.id,
      targetPatientId: survivor.id,
      reason: 'Ficha duplicada',
      performedById: author.id,
    });
    expect(merged.status).toBe('MERGED');

    // Control positivo: la fila oficial está ahora en la superviviente y viva.
    expect(
      await prisma.patientIdentifier.findMany({
        where: { value: CEDULA },
        select: { patientId: true, use: true, patientMerged: true },
      }),
    ).toEqual([{ patientId: survivor.id, use: 'OFFICIAL', patientMerged: false }]); // prettier-ignore

    expect(await repository.chartByCedula(CEDULA)).toBe(survivor.id);
    const worklist = await repository.pending({
      sites: 'all',
      chartId: survivor.id,
      now: new Date(),
      limit: 50,
    });
    expect(worklist.map((row) => row.testCode)).toEqual(['EX-BH']);

    if (merged.status !== 'MERGED') return;
    const undone = await patients.undoMerge({
      sourcePatientId: scene.patient.id,
      mergeId: merged.event.mergeId,
      reason: 'Eran dos personas',
      performedById: author.id,
    });
    expect(undone.status).toBe('UNDONE');
    expect(await repository.chartByCedula(CEDULA)).toBe(scene.patient.id);
  });

  it('ORD-093 sigue el enlace de la fusión: la orden de la ficha absorbida es suya', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const repository = ordersOf(prisma);

    // La orden se emite sobre la ficha que LUEGO absorbe una fusión.
    await placeIssued(repository, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.bh.id }],
      sites: 'all',
    });

    const survivor = await createPatient(prisma, { sex: 'FEMALE' });
    await prisma.patient.update({
      where: { id: scene.patient.id },
      // `patient_merged_at_matches_link` obliga a que el enlace y su instante
      // vayan juntos: media fusión no es un estado que la base admita.
      data: { mergedIntoId: survivor.id, mergedAt: new Date() },
    });

    // Leer por `patient_id` desnudo devolvería media historia SIN FALLAR, que
    // es la peor forma de fallar: la orden simplemente dejaría de aparecer.
    const worklist = await repository.pending({
      sites: 'all',
      chartId: survivor.id,
      now: new Date(),
      limit: 50,
    });

    expect(worklist).toHaveLength(1);
    expect(worklist[0]?.testCode).toBe('EX-BH');
  });

  it('ORD-010 publica el catálogo con su preparación y sus determinaciones en orden', async () => {
    const prisma = db();
    await aScene(prisma);

    const catalogue = await catalogueOf(prisma).active();
    const bh = catalogue.find((exam) => exam.code === 'EX-BH');

    expect(bh).toMatchObject({
      form010Section: 'HEMATOLOGÍA',
      specimenType: 'Sangre total con EDTA',
      patientPreparation: 'No requiere ayuno.',
      turnaroundHours: 4,
      // D-A-012: que el laboratorio sea externo es el caso realista, así que
      // es el valor por defecto y no la excepción.
      performedExternally: true,
    });
    expect(bh?.analytes[0]?.analyte.code).toBe('HB');
    expect(bh?.analytes[0]?.analyte.ranges).toHaveLength(2);
  });
});
