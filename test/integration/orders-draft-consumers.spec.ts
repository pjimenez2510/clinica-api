import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { DiagnosticReportService } from '../../src/modules/orders/application/diagnostic-report.service';
import type { Requester } from '../../src/modules/orders/application/service-order.service';
import { PrismaDiagnosticReportRepository } from '../../src/modules/orders/infrastructure/prisma-diagnostic-report.repository';
import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import { PrismaClinicalActsRepository } from '../../src/modules/billing/infrastructure/prisma-clinical-acts.repository';
import { PrismaDocumentSourceReader } from '../../src/modules/documents/infrastructure/prisma-document-source.reader';
import type { AccessAuditRecorder } from '../../src/shared/audit/access-audit.port';
import { hasClinicalAct } from '../../src/shared/infrastructure/prisma/clinical-acts';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aScene } from './orders-fixtures';
import { useDatabase } from './setup/database';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LO QUE NO SE EMITIÓ NO EXISTE FUERA DE LA PESTAÑA (ORD-096 a ORD-100),
 * CONTRA POSTGRESQL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Revisión clínica de `fix/atencion-examenes`: los filtros de ORD-100 sólo los
 * cubrían dobles que comprobaban la forma de la consulta. Aquí, cada
 * consumidor contra la base, con el mismo borrador y —como control positivo—
 * la misma orden ya emitida por el mismo camino.
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const db = useDatabase();

const requester: Requester = { userId: 'user-1', sites: 'all' };
const silentAudit: AccessAuditRecorder = { record: () => Promise.resolve() };
const noopLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function adapters(prisma: PrismaClient) {
  const client = prisma as unknown as PrismaService;
  const orders = new PrismaServiceOrderRepository(client);
  return {
    orders,
    reports: new DiagnosticReportService(
      new PrismaDiagnosticReportRepository(client),
      orders,
      new PrismaExamCatalogueRepository(client),
      silentAudit,
      noopLogger as never,
    ),
    acts: new PrismaClinicalActsRepository(client),
    documents: new PrismaDocumentSourceReader(
      client,
      'http://localhost/verificar',
    ),
  };
}

async function aDraft(prisma: PrismaClient) {
  const scene = await aScene(prisma);
  const { orders } = adapters(prisma);
  const draft = await orders.compose({
    encounterId: scene.encounter.id,
    category: 'LABORATORY',
    priority: 'ROUTINE',
    lines: [{ examDefinitionId: scene.bh.id }],
    sites: 'all',
  });
  return { scene, draft };
}

const issue = (prisma: PrismaClient, orderId: string) =>
  adapters(prisma).orders.issue({ orderId, sites: 'all' });

describe('ORD-100 un borrador no existe fuera de la pestaña', () => {
  it('ORD-100 no sale en la cola de pendientes; emitido, sí', async () => {
    const prisma = db();
    const { draft } = await aDraft(prisma);
    const pending = () =>
      adapters(prisma).orders.pending({ sites: 'all', now: new Date(), limit: 50 }); // prettier-ignore

    expect(await pending()).toEqual([]);
    await issue(prisma, draft.id);
    expect((await pending()).map((entry) => entry.orderId)).toEqual([draft.id]);
  });

  it('ORD-100 no propone cargo en caja ni cuenta como acto clínico; emitido, sí', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    const { acts } = adapters(prisma);
    const exams = async () =>
      (await acts.findEncounterActs({ encounterId: scene.encounter.id, siteId: scene.site.id }))!.exams; // prettier-ignore

    expect(await exams()).toEqual([]);
    expect(await hasClinicalAct(prisma, scene.encounter.id)).toBe(false);

    await issue(prisma, draft.id);
    expect((await exams()).map((exam) => exam.testCode)).toEqual(['EX-BH']);
    expect(await hasClinicalAct(prisma, scene.encounter.id)).toBe(true);
  });

  it('ORD-100 no se imprime ni se verifica por su código; emitido, sí', async () => {
    const prisma = db();
    const { draft } = await aDraft(prisma);
    const { documents } = adapters(prisma);
    const { verificationCode } = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: draft.id },
      select: { verificationCode: true },
    });
    const subject = () =>
      documents.findSubject({ kind: 'SERVICE_ORDER', subjectId: draft.id, sites: 'all' }); // prettier-ignore

    expect(await subject()).toBeNull();
    expect(await documents.findForVerification(verificationCode)).toBeNull();

    await issue(prisma, draft.id);
    expect(await subject()).not.toBeNull();
    expect(
      await documents.findForVerification(verificationCode),
    ).not.toBeNull();
  });

  it('ORD-100 no admite informe ni anulación de línea; emitido, sí', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    const { orders, reports } = adapters(prisma);
    const register = () =>
      reports.register(
        {
          orderId: draft.id,
          performedById: null,
          issuedAt: new Date(Date.now() - 3_600_000),
          results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 }],
        },
        requester,
      );

    await expect(register()).rejects.toMatchObject({
      code: 'ORDER_NOT_ISSUED',
    });
    await expect(
      orders.cancelItem({ orderId: draft.id, itemId: draft.items[0]!.id, sites: 'all', cancelledById: requester.userId }), // prettier-ignore
    ).rejects.toMatchObject({ code: 'ORDER_NOT_ISSUED' });

    await issue(prisma, draft.id);
    await expect(register()).resolves.toBeDefined();
  });
});

describe('ORD-096 a ORD-099 las transiciones del borrador', () => {
  it('ORD-096 ORD-098 lo emitido no se reescribe ni se vuelve a emitir', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    const { orders } = adapters(prisma);
    const rewrite = () =>
      orders.rewrite({
        orderId: draft.id,
        category: 'LABORATORY',
        priority: 'URGENT',
        lines: [{ examDefinitionId: scene.glucose.id }],
        sites: 'all',
      });

    // Control positivo: en borrador, se reescribe.
    const rewritten = await rewrite();
    expect(rewritten.items.map((item) => item.testCode)).toEqual(['EX-GLUCOSA-AYUNAS']); // prettier-ignore
    await issue(prisma, draft.id);

    await expect(rewrite()).rejects.toMatchObject({ code: 'ORDER_NOT_DRAFT' });
    await expect(issue(prisma, draft.id)).rejects.toMatchObject({ code: 'ORDER_NOT_DRAFT' }); // prettier-ignore
  });

  it('ORD-097 un hemograma no entra en una orden de imagen', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    await expect(
      adapters(prisma).orders.compose({
        encounterId: scene.encounter.id,
        category: 'IMAGING',
        priority: 'ROUTINE',
        lines: [{ examDefinitionId: scene.bh.id }],
        sites: 'all',
      }),
    ).rejects.toMatchObject({ code: 'EXAM_CATEGORY_MISMATCH' });
    expect(await prisma.serviceOrder.count()).toBe(0);
  });

  it('ORD-098 al emitir se vuelve a comprobar el examen: desactivado o de otro tipo, no sale', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);

    await prisma.examDefinition.update({ where: { id: scene.bh.id }, data: { active: false } }); // prettier-ignore
    await expect(issue(prisma, draft.id)).rejects.toMatchObject({ code: 'EXAM_NOT_ORDERABLE' }); // prettier-ignore

    await prisma.examDefinition.update({ where: { id: scene.bh.id }, data: { active: true, category: 'IMAGING' } }); // prettier-ignore
    await expect(issue(prisma, draft.id)).rejects.toMatchObject({ code: 'EXAM_CATEGORY_MISMATCH' }); // prettier-ignore

    // Control positivo: con el examen como estaba, se emite.
    await prisma.examDefinition.update({ where: { id: scene.bh.id }, data: { category: 'LABORATORY' } }); // prettier-ignore
    await expect(issue(prisma, draft.id)).resolves.toMatchObject({ status: 'ISSUED' }); // prettier-ignore
  });

  it('ORD-005 ORD-099 en una atención cerrada no se emite, pero sí se descarta', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    await prisma.encounter.update({
      where: { id: scene.encounter.id },
      data: {
        status: 'COMPLETED',
        // Después de `started_at` (`encounter_time_order`), y con su
        // condición de alta (`encounter_discharge_states_a_condition`).
        endedAt: new Date(scene.encounter.startedAt.getTime() + 3_600_000),
        dischargeCondition: 'ALIVE',
      },
    });

    await expect(issue(prisma, draft.id)).rejects.toMatchObject({ code: 'ORDER_ENCOUNTER_NOT_OPEN' }); // prettier-ignore
    const discarded = await adapters(prisma).orders.discard({
      orderId: draft.id,
      sites: 'all',
      userId: (await prisma.practitioner.findUniqueOrThrow({ where: { id: scene.practitioner.id } })).userId, // prettier-ignore
    });
    expect(discarded.status).toBe('DISCARDED');
    expect(discarded.number).toBeNull();
  });

  it('ORD-116 deshacer el descarte devuelve el mismo borrador con sus líneas, y con la atención cerrada responde ORDER_ENCOUNTER_NOT_OPEN', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    const userId = (await prisma.practitioner.findUniqueOrThrow({ where: { id: scene.practitioner.id } })).userId; // prettier-ignore
    const { orders } = adapters(prisma);
    await orders.discard({ orderId: draft.id, sites: 'all', userId });

    // Positive control: with the attention live it comes back as it was.
    const restored = await orders.restore({ orderId: draft.id, sites: 'all' });
    expect(restored).toMatchObject({
      id: draft.id,
      status: 'DRAFT',
      discardedAt: null,
      number: null,
    });
    expect(restored.items.map((item) => item.id)).toEqual(
      draft.items.map((item) => item.id),
    );

    await orders.discard({ orderId: draft.id, sites: 'all', userId });
    await prisma.encounter.update({
      where: { id: scene.encounter.id },
      data: {
        status: 'COMPLETED',
        endedAt: new Date(scene.encounter.startedAt.getTime() + 3_600_000),
        dischargeCondition: 'ALIVE',
      },
    });

    await expect(
      orders.restore({ orderId: draft.id, sites: 'all' }),
    ).rejects.toMatchObject({ code: 'ORDER_ENCOUNTER_NOT_OPEN' });
    const stored = await prisma.serviceOrder.findUniqueOrThrow({ where: { id: draft.id } }); // prettier-ignore
    expect(stored.status).toBe('DISCARDED');
  });

  it('ORD-116 sólo se restaura lo descartado: un borrador vivo o una emitida responden ORDER_NOT_DISCARDED', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    const userId = (await prisma.practitioner.findUniqueOrThrow({ where: { id: scene.practitioner.id } })).userId; // prettier-ignore
    const { orders } = adapters(prisma);

    await expect(
      orders.restore({ orderId: draft.id, sites: 'all' }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_DISCARDED' });
    await issue(prisma, draft.id);
    await expect(
      orders.restore({ orderId: draft.id, sites: 'all' }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_DISCARDED' });

    // Control positivo: por el mismo camino, lo descartado vuelve.
    const other = await orders.compose({
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.bh.id }],
      sites: 'all',
    });
    await orders.discard({ orderId: other.id, sites: 'all', userId });
    await expect(
      orders.restore({ orderId: other.id, sites: 'all' }),
    ).resolves.toMatchObject({ status: 'DRAFT' });
  });

  it('ORD-116 dos «Deshacer» a la vez del mismo descarte: uno lo recupera y el otro recibe ORDER_NOT_DISCARDED', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    const userId = (await prisma.practitioner.findUniqueOrThrow({ where: { id: scene.practitioner.id } })).userId; // prettier-ignore
    const { orders } = adapters(prisma);
    await orders.discard({ orderId: draft.id, sites: 'all', userId });

    const outcomes = await Promise.allSettled([
      orders.restore({ orderId: draft.id, sites: 'all' }),
      orders.restore({ orderId: draft.id, sites: 'all' }),
    ]);

    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const lost = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(won[0]?.value).toMatchObject({ id: draft.id, status: 'DRAFT' });
    expect(lost).toHaveLength(1);
    expect(lost[0]?.reason).toMatchObject({ code: 'ORDER_NOT_DISCARDED' });
    // Recuperar no crea nada: sigue habiendo una orden, en borrador.
    expect(
      await prisma.serviceOrder.findMany({
        select: { id: true, status: true },
      }),
    ).toEqual([{ id: draft.id, status: 'DRAFT' }]);
  });

  it('ORD-096 la orden descartada tampoco se reescribe, y una línea de borrador no nace hecha', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    const userId = (await prisma.practitioner.findUniqueOrThrow({ where: { id: scene.practitioner.id } })).userId; // prettier-ignore

    await expect(
      prisma.$executeRaw`
        INSERT INTO service_order_item (service_order_id, concept_id, test_code, test_display, status, completed_at)
        VALUES (${draft.id}::uuid, ${scene.concept.id}::uuid, 'EX-BH', 'Biometría', 'COMPLETED', now())`,
    ).rejects.toThrow(/service_order_item_frozen_once_issued/);
    await expect(
      prisma.$executeRaw`UPDATE service_order_item SET status = 'COMPLETED', completed_at = now() WHERE service_order_id = ${draft.id}::uuid`,
    ).rejects.toThrow(/service_order_item_frozen_once_issued/);

    await adapters(prisma).orders.discard({ orderId: draft.id, sites: 'all', userId }); // prettier-ignore
    await expect(
      prisma.$executeRaw`UPDATE service_order SET priority = 'STAT' WHERE id = ${draft.id}::uuid`,
    ).rejects.toThrow(/service_order_frozen_once_issued/);
  });

  it('ORD-098 lo impreso de una orden emitida no se reescribe: ni su fecha ni su código', async () => {
    const prisma = db();
    const { draft } = await aDraft(prisma);
    await issue(prisma, draft.id);

    await expect(
      prisma.$executeRaw`UPDATE service_order SET requested_at = now() - interval '30 days' WHERE id = ${draft.id}::uuid`,
    ).rejects.toThrow(/service_order_frozen_once_issued/);
    await expect(
      prisma.$executeRaw`UPDATE service_order SET verification_code = 'AAAAAAAAAAAAAAAA' WHERE id = ${draft.id}::uuid`,
    ).rejects.toThrow(/service_order_frozen_once_issued/);
    // Control positivo: lo que no está congelado se mueve.
    await expect(
      prisma.$executeRaw`UPDATE service_order SET updated_at = now() WHERE id = ${draft.id}::uuid`,
    ).resolves.toBe(1);
  });
});

describe('D-123.6 el borrador que nadie emitió no se pierde de vista', () => {
  /** The attention ended in `status`, an hour after it started. */
  const endEncounter = (
    prisma: PrismaClient,
    scene: Awaited<ReturnType<typeof aScene>>,
    status: 'DISCHARGED' | 'COMPLETED',
  ) =>
    prisma.encounter.update({
      where: { id: scene.encounter.id },
      data: {
        status,
        endedAt: new Date(scene.encounter.startedAt.getTime() + 3_600_000),
        dischargeCondition: 'ALIVE',
      },
    });
  /** When the draft was saved, as the row says: the 24 hours run from it. */
  const savedAt = async (prisma: PrismaClient, orderId: string) =>
    (await prisma.serviceOrder.findUniqueOrThrow({ where: { id: orderId } })).createdAt; // prettier-ignore
  const signerOf = async (prisma: PrismaClient, practitionerId: string) =>
    (await prisma.practitioner.findUniqueOrThrow({ where: { id: practitionerId } })).userId; // prettier-ignore

  it('ORD-115 lista los borradores del profesional en atenciones ya no abiertas, con si se pueden emitir', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    const userId = await signerOf(prisma, scene.practitioner.id);
    // Una hora después de guardarlo: reciente.
    const now = new Date((await savedAt(prisma, draft.id)).getTime() + HOUR_MS);
    const stale = () => adapters(prisma).orders.staleDrafts({ userId, sites: 'all', now }); // prettier-ignore

    // Con la atención abierta y reciente no está colgado: se emite desde la pestaña.
    expect(await stale()).toEqual([]);

    await endEncounter(prisma, scene, 'DISCHARGED');
    const [entry] = await stale();
    expect(entry).toMatchObject({
      orderId: draft.id,
      encounterId: scene.encounter.id,
      encounterStatus: 'DISCHARGED',
      canIssue: true,
      items: [{ testCode: 'EX-BH' }],
    });
    expect(entry?.patientName).toContain(scene.patient.familyName);

    // ORD-005: terminada, sólo se descarta.
    await prisma.encounter.update({ where: { id: scene.encounter.id }, data: { status: 'COMPLETED' } }); // prettier-ignore
    expect((await stale())[0]).toMatchObject({ canIssue: false });

    // De otro profesional, no es suyo.
    expect(await adapters(prisma).orders.staleDrafts({ userId: '00000000-0000-4000-8000-000000000002', sites: 'all', now })).toEqual([]); // prettier-ignore
    // Fuera de su alcance de sedes, tampoco.
    expect(await adapters(prisma).orders.staleDrafts({ userId, sites: [], now })).toEqual([]); // prettier-ignore
  });

  it('ORD-115 lo emitido y lo descartado ya no cuelgan', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    const userId = await signerOf(prisma, scene.practitioner.id);
    await endEncounter(prisma, scene, 'DISCHARGED');
    const now = new Date((await savedAt(prisma, draft.id)).getTime() + HOUR_MS);
    const stale = () => adapters(prisma).orders.staleDrafts({ userId, sites: 'all', now }); // prettier-ignore
    expect(await stale()).toHaveLength(1);

    await issue(prisma, draft.id);
    expect(await stale()).toEqual([]);
  });

  it('ORD-115 D-130.3 el borrador de más de 24 horas en una atención abierta o en espera también cuelga, y se puede emitir', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    const userId = await signerOf(prisma, scene.practitioner.id);
    const saved = (await savedAt(prisma, draft.id)).getTime();
    const at = (ms: number) => adapters(prisma).orders.staleDrafts({ userId, sites: 'all', now: new Date(saved + ms) }); // prettier-ignore

    // Control positivo: a las 24 horas justas, todavía no.
    expect(await at(DAY_MS)).toEqual([]);
    const [open] = await at(DAY_MS + 1);
    expect(open).toMatchObject({ orderId: draft.id, encounterStatus: 'OPEN', canIssue: true }); // prettier-ignore

    await prisma.encounter.update({ where: { id: scene.encounter.id }, data: { status: 'ON_HOLD' } }); // prettier-ignore
    expect(await at(DAY_MS - MINUTE_MS)).toEqual([]);
    expect((await at(DAY_MS + MINUTE_MS))[0]).toMatchObject({ orderId: draft.id, encounterStatus: 'ON_HOLD' }); // prettier-ignore
  });

  it('BI-192 D-130.3 la cuenta de una atención aún abierta ve también su borrador viejo', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    await prisma.encounter.update({ where: { id: scene.encounter.id }, data: { status: 'ON_HOLD' } }); // prettier-ignore
    // Guardado hace dos días: el extracto no mira la edad del borrador.
    await prisma.$executeRaw`UPDATE service_order SET created_at = created_at - interval '2 days' WHERE id = ${draft.id}::uuid`; // prettier-ignore

    const notices = await adapters(prisma).acts.draftOrdersOf({ encounterId: scene.encounter.id, siteId: scene.site.id }); // prettier-ignore
    expect(notices.map((notice) => notice.orderId)).toEqual([draft.id]);
  });

  it('BI-192 la cuenta de la atención ve el borrador con quién lo escribió; emitido, ya no', async () => {
    const prisma = db();
    const { scene, draft } = await aDraft(prisma);
    const author = await prisma.user.findUniqueOrThrow({
      where: { id: await signerOf(prisma, scene.practitioner.id) },
    });
    const drafts = () =>
      adapters(prisma).acts.draftOrdersOf({ encounterId: scene.encounter.id, siteId: scene.site.id }); // prettier-ignore

    const [notice] = await drafts();
    expect(notice).toMatchObject({ orderId: draft.id });
    expect(notice?.orderedByName).toContain(author.lastName);
    expect(notice?.savedAt).toBeInstanceOf(Date);
    // De otra sede, nada: la cuenta es de su sede (BI-135).
    expect(await adapters(prisma).acts.draftOrdersOf({ encounterId: scene.encounter.id, siteId: '00000000-0000-4000-8000-000000000001' })).toEqual([]); // prettier-ignore

    await issue(prisma, draft.id);
    expect(await drafts()).toEqual([]);
  });
});
