import { PrismaClient } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import '../../src/modules/billing/infrastructure/billing.constraints';
import { ChargeCorrectionService } from '../../src/modules/billing/application/charge-correction.service';
import { EncounterCheckoutService } from '../../src/modules/billing/application/encounter-checkout.service';
import { PatientAccountService } from '../../src/modules/billing/application/patient-account.service';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { PrismaBillingCatalogueRepository } from '../../src/modules/billing/infrastructure/prisma-billing-catalogue.repository';
import { PrismaClinicalActsRepository } from '../../src/modules/billing/infrastructure/prisma-clinical-acts.repository';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EL PASO DE LA CONSULTA A LA CAJA, CONTRA POSTGRESQL DE VERDAD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo que sólo se puede demostrar aquí, y no con dobles:
 *
 *   · BI-154 — que pulsar dos veces NO PUEDA duplicar un cargo. Esa promesa la
 *     dan tres índices únicos PARCIALES, no una lectura previa: dos cajeras
 *     pulsando a la vez leen las dos «todavía no hay nada» e insertan las dos.
 *     Un doble devolvería lo que le dijéramos y no probaría nada.
 *   · BI-153 — que la base rechace una línea que dice venir de un acto que no
 *     puede señalar (`charge_item_origin_names_its_act`).
 *   · BI-158 — que sólo una prestación pueda ser «la consulta» de una
 *     especialidad, y que las dos columnas viajen juntas.
 *   · BI-151 — que la derivación entera funcione sobre el catálogo REAL que se
 *     instala, y no sobre un fixture inventado. Por eso la siembra es
 *     `prisma/seed-billing.mts`, la de producción.
 */
const db = useDatabase();

const SELF_PAY = 'PARTICULAR';
/** Dermatología primera vez cuesta 50.00 en la lista PARTICULAR desde 2026-01-01. */
const DERMATOLOGY = 'dermatologia';
const CONSULTATION_CODE = 'CONS-DER-PV';
/** `EX-BH` ya apunta a `LAB-BH` en la siembra: es el atajo que ya existía. */
const EXAM_CODE = 'EX-BH';
const PROCEDURE_SERVICE = 'PROC-SUTURA';

/** La visita empieza a las 14:00 UTC, que en Ecuador son las 09:00 del 14-09. */
const VISIT_STARTED_AT = new Date('2026-09-14T14:00:00Z');

interface Context {
  prisma: PrismaClient;
  checkout: EncounterCheckoutService;
  accounts: PrismaBillingAccountRepository;
  siteId: string;
  patientId: string;
  encounterId: string;
  payerId: string;
  accountId: string;
  procedureConceptId: string;
  userId: string;
}

let context: Context;

beforeEach(async () => {
  const prisma = db();

  const site = await createSite(prisma);
  const patient = await createPatient(prisma);
  const practitioner = await createPractitioner(prisma);
  await prisma.practitionerSite.create({
    data: { practitionerId: practitioner.id, siteId: site.id },
  });

  // The specialty and its «Primera vez» EXIST BEFORE the billing seed runs,
  // which is what lets `linkServiceType` tie `CONS-DER-PV` to that type
  // (BI-158, SP-031). That order is the real one: a clinic seeds its
  // specialties before its price list.
  const specialty = await prisma.specialty.create({
    data: { code: DERMATOLOGY, name: 'Dermatología' },
  });
  const serviceType = await prisma.serviceType.create({
    data: {
      specialtyId: specialty.id,
      name: 'Primera vez',
      durationMinutes: 30,
    },
  });

  await seedBilling(prisma);

  // The appointment is what says WHICH SPECIALTY this visit was, and it is the
  // only place that says it: a practitioner registered under two specialties
  // could not answer it without picking one arbitrarily.
  const appointment = await prisma.agendaEntry.create({
    data: {
      kind: 'APPOINTMENT',
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      serviceTypeId: serviceType.id,
      // `agenda_entry_booking_channel_coherence`: an appointment always says
      // how it was booked, and a block never can.
      bookingChannel: 'PHONE',
      startsAt: VISIT_STARTED_AT,
      endsAt: new Date('2026-09-14T14:30:00Z'),
    },
  });

  const encounter = await prisma.encounter.create({
    data: {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      agendaEntryId: appointment.id,
      startedAt: VISIT_STARTED_AT,
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    },
  });

  // A procedure needs a nomenclature concept on both sides: the clinical row
  // names it, and `billable_service.procedure_concept_id` is the tie the
  // schema already carried «so a charge can be raised from the encounter
  // instead of typed at the cashier».
  const system = await prisma.catalogSystem.create({
    data: { code: `PROC${Date.now()}`, name: 'Procedimientos' },
  });
  const concept = await prisma.catalogConcept.create({
    data: {
      systemId: system.id,
      code: 'SUTURA',
      display: 'Sutura simple',
      validFrom: new Date('2020-01-01'),
    },
  });
  await prisma.billableService.update({
    where: { code: PROCEDURE_SERVICE },
    data: { procedureConceptId: concept.id },
  });

  const user = await prisma.user.create({
    data: {
      email: `caja${Date.now()}@clinica.ec`,
      passwordHash: 'not-a-real-hash',
      firstName: 'Rosa',
      lastName: 'Cedeño',
    },
  });

  const payer = await prisma.payer.findUniqueOrThrow({
    where: { code: SELF_PAY },
  });

  const asService = prisma as unknown as PrismaService;
  const accountRepository = new PrismaBillingAccountRepository(asService);
  const catalogueRepository = new PrismaBillingCatalogueRepository(asService);

  context = {
    prisma,
    accounts: accountRepository,
    checkout: new EncounterCheckoutService(
      new PrismaClinicalActsRepository(asService),
      accountRepository,
      catalogueRepository,
      new PatientAccountService(
        accountRepository,
        catalogueRepository,
        { record: () => Promise.resolve() },
        new PrismaClinicalActsRepository(asService),
      ),
    ),
    siteId: site.id,
    patientId: patient.id,
    encounterId: encounter.id,
    payerId: payer.id,
    accountId: '',
    procedureConceptId: concept.id,
    userId: user.id,
  };
});

/** One suture, performed during the visit. */
async function aSutureWasPerformed(
  performedAt = new Date('2026-09-14T15:00:00Z'),
): Promise<string> {
  const procedure = await context.prisma.encounterProcedure.create({
    data: {
      encounterId: context.encounterId,
      conceptId: context.procedureConceptId,
      procedureCode: 'SUTURA',
      procedureDisplay: 'Sutura simple',
      quantity: 1,
      performedAt,
    },
  });
  return procedure.id;
}

/** One blood count, ordered from the visit. */
async function aBloodCountWasOrdered(
  requestedAt = VISIT_STARTED_AT,
): Promise<string> {
  const order = await context.prisma.serviceOrder.create({
    data: {
      encounterId: context.encounterId,
      siteId: context.siteId,
      orderedById: (
        await context.prisma.encounter.findUniqueOrThrow({
          where: { id: context.encounterId },
          select: { practitionerId: true },
        })
      ).practitionerId,
      category: 'LABORATORY',
      requestedAt,
      items: {
        create: {
          conceptId: context.procedureConceptId,
          testCode: EXAM_CODE,
          testDisplay: 'Biometría hemática completa',
        },
      },
    },
    include: { items: true },
  });
  // ORD-098. Lines go in while it is a draft; only an issued one is charged.
  await context.prisma.serviceOrder.update({
    where: { id: order.id },
    data: { status: 'ISSUED' },
  });
  return order.items[0]!.id;
}

function press(): ReturnType<EncounterCheckoutService['sendToCashier']> {
  return context.checkout.sendToCashier({
    siteId: context.siteId,
    encounterId: context.encounterId,
    payerId: context.payerId,
    userId: context.userId,
  });
}

describe('BI-150, BI-151 el costo sale de lo que realmente se hizo', () => {
  it('BI-151 propone la consulta, el procedimiento y el examen con el precio del día', async () => {
    await aSutureWasPerformed();
    await aBloodCountWasOrdered();

    const result = await press();

    // Dermatología primera vez 50.00 + sutura 45.00 + biometría 8.00, los tres
    // resueltos contra la lista PARTICULAR de la siembra REAL.
    expect(
      result.statement.charges.map((line) => [
        line.origin,
        line.unitAmount.toString(),
      ]),
    ).toEqual([
      ['CONSULTATION', '50.00'],
      ['PROCEDURE', '45.00'],
      ['EXAM', '8.00'],
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('BI-150 abre la cuenta la primera vez y la RECUPERA la segunda', async () => {
    const first = await press();
    const second = await press();

    expect(second.statement.account.id).toBe(first.statement.account.id);
    expect(
      await context.prisma.patientAccount.count({
        where: { encounterId: context.encounterId },
      }),
    ).toBe(1);
  });

  it('BI-002, BI-052 congela la fecha del acto EN ECUADOR, no la del huso del servidor', async () => {
    // 2026-09-15T02:30:00Z is still 14 September in Guayaquil (21:30). A
    // `::date` on the timestamptz would say the 15th — and here that does not
    // shift a statistic, it resolves a different price the day a validity
    // starts at that midnight.
    await aSutureWasPerformed(new Date('2026-09-15T02:30:00Z'));

    const result = await press();

    expect(result.statement.charges.map((line) => line.serviceDate)).toEqual([
      '2026-09-14',
      '2026-09-14',
    ]);
  });
});

describe('BI-193 el examen se cobra con la fecha de la atención', () => {
  it('BI-193 un borrador emitido al día siguiente se cobra con la fecha clínica de la atención', async () => {
    // ORD-098: la orden lleva el instante de su EMISIÓN. Emitida un día
    // después de la visita, su fecha no es la del acto que se vendió.
    const nextDay = new Date(VISIT_STARTED_AT.getTime() + 86_400_000);
    await aBloodCountWasOrdered(nextDay);

    const result = await press();
    const exam = result.statement.charges.find((line) => line.origin === 'EXAM'); // prettier-ignore
    const consultation = result.statement.charges.find((line) => line.origin === 'CONSULTATION'); // prettier-ignore

    expect(exam?.serviceDate).toBe(clinicalDateOf(VISIT_STARTED_AT));
    expect(exam?.serviceDate).toBe(consultation?.serviceDate);
    // Control positivo: el día siguiente es otra fecha clínica.
    expect(clinicalDateOf(nextDay)).not.toBe(exam?.serviceDate);
  });
});

describe('BI-152 propone, no impone', () => {
  it('BI-152 deja los cargos derivados como propuesta, fuera de lo facturable', async () => {
    await aSutureWasPerformed();

    const result = await press();

    expect(result.statement.charges.map((line) => line.status)).toEqual([
      'PLANNED',
      'PLANNED',
    ]);
    // El total dice 95.00 y NINGÚN centavo de eso se puede facturar todavía:
    // por eso el extracto los separa, y por eso la pantalla enseña los dos.
    expect(result.statement.totals.total.toString()).toBe('95.00');
    expect(result.statement.proposedTotals.total.toString()).toBe('95.00');
  });
});

describe('BI-154 pulsar dos veces no duplica cargos', () => {
  it('BI-154 no crea ni un cargo más en la segunda pulsación', async () => {
    await aSutureWasPerformed();
    await aBloodCountWasOrdered();

    const first = await press();
    const second = await press();

    expect(first.raisedChargeIds).toHaveLength(3);
    expect(second.raisedChargeIds).toEqual([]);
    expect(
      await context.prisma.chargeItem.count({
        where: { encounterId: context.encounterId },
      }),
    ).toBe(3);
  });

  it('BI-154 la BASE rechaza el segundo cargo del mismo acto, no una comprobación previa', async () => {
    // The guarantee, written UNDERNEATH the application: two cashiers pressing
    // in the same second both read «nothing charged» and both insert. What
    // stops the duplicate is `charge_item_one_per_encounter_procedure`.
    const procedureId = await aSutureWasPerformed();
    const result = await press();
    const derived = result.statement.charges.find(
      (line) => line.encounterProcedureId === procedureId,
    );

    await expect(
      context.prisma.$executeRaw`
        INSERT INTO "charge_item" (
          "account_id", "billable_service_id", "encounter_id",
          "encounter_procedure_id", "origin", "service_date", "quantity",
          "unit_amount", "service_display", "tax_sri_code", "status",
          "created_by_id", "updated_at")
        SELECT "account_id", "billable_service_id", "encounter_id",
               "encounter_procedure_id", 'PROCEDURE', "service_date", 1,
               "unit_amount", "service_display", "tax_sri_code", 'BILLABLE',
               "created_by_id", CURRENT_TIMESTAMP
          FROM "charge_item" WHERE "id" = ${derived!.id}::uuid`,
    ).rejects.toBeDefined();
  });

  it('BI-154 la base admite UNA sola consulta por atención', async () => {
    await press();

    await expect(
      context.prisma.$executeRaw`
        INSERT INTO "charge_item" (
          "account_id", "billable_service_id", "encounter_id", "origin",
          "service_date", "quantity", "unit_amount", "service_display",
          "tax_sri_code", "status", "created_by_id", "updated_at")
        SELECT "account_id", "billable_service_id", "encounter_id",
               'CONSULTATION', "service_date", 1, "unit_amount",
               "service_display", "tax_sri_code", 'BILLABLE', "created_by_id",
               CURRENT_TIMESTAMP
          FROM "charge_item"
         WHERE "encounter_id" = ${context.encounterId}::uuid
         LIMIT 1`,
    ).rejects.toBeDefined();
  });
});

describe('BI-157 lo que caja quitó no vuelve solo', () => {
  it('BI-157 no vuelve a proponer un examen que alguien quitó con motivo', async () => {
    const orderItemId = await aBloodCountWasOrdered();
    const first = await press();
    const exam = first.statement.charges.find(
      (line) => line.serviceOrderItemId === orderItemId,
    );

    await context.accounts.voidCharge({
      chargeId: exam!.id,
      voidedById: context.userId,
      reason: 'La paciente no se realizó el examen',
      now: new Date(),
    });

    const second = await press();

    expect(second.raisedChargeIds).toEqual([]);
    // La fila sigue ahí, anulada y con su motivo: es lo que permite explicar
    // por qué bajó el total (BI-055).
    const rows = await context.prisma.chargeItem.findMany({
      where: { serviceOrderItemId: orderItemId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('CANCELLED');
    expect(rows[0]?.voidReason).toBe('La paciente no se realizó el examen');
  });

  it('BI-004 anular el cargo NO borra el acto clínico', async () => {
    const orderItemId = await aBloodCountWasOrdered();
    const first = await press();
    const exam = first.statement.charges.find(
      (line) => line.serviceOrderItemId === orderItemId,
    );

    await context.accounts.voidCharge({
      chargeId: exam!.id,
      voidedById: context.userId,
      reason: 'Cortesía institucional',
      now: new Date(),
    });

    expect(
      await context.prisma.serviceOrderItem.findUnique({
        where: { id: orderItemId },
      }),
    ).not.toBeNull();
  });
});

describe('BI-153 una línea no puede decir que viene de un acto que no señala', () => {
  it('BI-153 la base rechaza un cargo EXAM sin línea de orden', async () => {
    const result = await press();
    const consultation = result.statement.charges[0]!;

    await expect(
      context.prisma.$executeRaw`
        UPDATE "charge_item" SET "origin" = 'EXAM'
         WHERE "id" = ${consultation.id}::uuid`,
    ).rejects.toBeDefined();
  });

  it('BI-153 la base rechaza un cargo MANUAL que señale un procedimiento', async () => {
    const procedureId = await aSutureWasPerformed();
    const result = await press();
    const derived = result.statement.charges.find(
      (line) => line.encounterProcedureId === procedureId,
    );

    await expect(
      context.prisma.$executeRaw`
        UPDATE "charge_item" SET "origin" = 'MANUAL'
         WHERE "id" = ${derived!.id}::uuid`,
    ).rejects.toBeDefined();
  });
});

describe('BI-158 qué prestación es «la consulta» es un dato, no una regla', () => {
  it('BI-158 la siembra ata la consulta de dermatología a su tipo de atención', async () => {
    const link =
      await context.prisma.serviceTypeBillableService.findFirstOrThrow({
        where: { billableService: { code: CONSULTATION_CODE } },
        select: { position: true, serviceType: { select: { name: true } } },
      });

    expect(link).toEqual({ position: 0, serviceType: { name: 'Primera vez' } });
  });

  it('SP-031 la base admite UNA prestación por posición de un tipo, y varias en posiciones distintas', async () => {
    // «Se coge la primera» tiene que tener una sola respuesta.
    const { serviceTypeId } =
      await context.prisma.serviceTypeBillableService.findFirstOrThrow({
        where: { billableService: { code: CONSULTATION_CODE } },
      });
    const other = await context.prisma.billableService.findUniqueOrThrow({
      where: { code: 'CONS-MG-PV' },
    });

    await expect(
      context.prisma.serviceTypeBillableService.create({
        data: { serviceTypeId, billableServiceId: other.id, position: 0 },
      }),
    ).rejects.toThrow(
      // Prisma 7 names the fields, not the index; `position` is quoted as a keyword.
      /service_type_billable_service_one_per_position|Unique constraint failed on the fields: \(`service_type_id`, `"position"`\)/,
    );
    // Control positivo: en la segunda posición, sí (consulta + procedimiento).
    await expect(
      context.prisma.serviceTypeBillableService.create({
        data: { serviceTypeId, billableServiceId: other.id, position: 1 },
      }),
    ).resolves.toBeDefined();
  });

  it('BI-158, BI-155 sin especialidad no propone consulta, y lo dice', async () => {
    // A walk-in with no appointment. The rest of the visit is still proposed:
    // one line the system cannot resolve must not cost the clinic the others.
    await context.prisma.encounter.update({
      where: { id: context.encounterId },
      data: { agendaEntryId: null },
    });
    await aSutureWasPerformed();

    const result = await press();

    expect(result.statement.charges.map((line) => line.origin)).toEqual([
      'PROCEDURE',
    ]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        origin: 'CONSULTATION',
        reason: 'NO_BILLABLE_SERVICE',
      }),
    ]);
  });
});

describe('BI-203 la consulta sin facturar se vuelve a resolver desde el tipo de la cita', () => {
  function repricer(): ChargeCorrectionService {
    const asService = context.prisma as unknown as PrismaService;
    return new ChargeCorrectionService(
      new PrismaBillingAccountRepository(asService),
      new PrismaBillingCatalogueRepository(asService),
      new PrismaClinicalActsRepository(asService),
      { setContext: () => undefined, warn: () => undefined } as unknown as PinoLogger, // prettier-ignore
    );
  }

  async function correctToSubsequent(): Promise<void> {
    // As EN-215 writes it: stamped, so the encounter keeps its own version.
    await context.prisma.encounter.update({
      where: { id: context.encounterId },
      data: {
        visitSequence: 'SUBSEQUENT',
        correctedById: context.userId,
        correctedAt: new Date(),
      },
    });
  }

  /** SP-031. The appointment's type is now charged with `code`. */
  async function retieTypeTo(code: string): Promise<void> {
    const link =
      await context.prisma.serviceTypeBillableService.findFirstOrThrow({
        where: { billableService: { code: CONSULTATION_CODE } },
      });
    const service = await context.prisma.billableService.findUniqueOrThrow({
      where: { code },
    });
    await context.prisma.serviceTypeBillableService.delete({
      where: {
        serviceTypeId_billableServiceId: {
          serviceTypeId: link.serviceTypeId,
          billableServiceId: link.billableServiceId,
        },
      },
    });
    await context.prisma.serviceTypeBillableService.create({
      data: { serviceTypeId: link.serviceTypeId, billableServiceId: service.id, position: 0 }, // prettier-ignore
    });
  }

  async function consultation() {
    return context.prisma.chargeItem.findFirstOrThrow({
      where: { encounterId: context.encounterId, origin: 'CONSULTATION' },
      include: { billableService: { select: { code: true } } },
    });
  }

  it('BI-158 BI-203 corregir a subsecuente no cambia la consulta: la decide el tipo de la cita', async () => {
    await press();
    const before = await consultation();

    await correctToSubsequent();
    await repricer().repriceConsultation({
      encounterId: context.encounterId,
      siteId: context.siteId,
      changedById: context.userId,
    });

    const after = await consultation();
    expect(after.billableService.code).toBe(CONSULTATION_CODE);
    expect(after.unitAmount.toFixed(2)).toBe(before.unitAmount.toFixed(2));
  });

  it('BI-203 la consulta propuesta pasa a la nueva prestación de su tipo con su precio y deja la versión', async () => {
    await press();
    // Positive control: before the change the line is the type's first service.
    expect((await consultation()).billableService.code).toBe(CONSULTATION_CODE);

    await retieTypeTo('CONS-DER-SUB');
    await repricer().repriceConsultation({
      encounterId: context.encounterId,
      siteId: context.siteId,
      changedById: context.userId,
    });

    const after = await consultation();
    expect(after.billableService.code).toBe('CONS-DER-SUB');
    expect(after.unitAmount.toFixed(2)).toBe('35.00');
    expect(after.status).toBe('PLANNED');
    expect(
      await context.prisma.recordVersion.count({
        where: { resourceType: 'charge_item', resourceId: after.id },
      }),
    ).toBe(1);
  });

  it('BI-203 sin precio para la nueva prestación del tipo deja el cargo, y el extracto lo señala', async () => {
    await press();
    // The type moves to a service with no self-pay price.
    const subsequent = await context.prisma.billableService.findUniqueOrThrow({
      where: { code: 'CONS-DER-SUB' },
    });
    await context.prisma.price.deleteMany({
      where: { billableServiceId: subsequent.id },
    });

    await retieTypeTo('CONS-DER-SUB');
    await repricer().repriceConsultation({
      encounterId: context.encounterId,
      siteId: context.siteId,
      changedById: context.userId,
    });

    const line = await consultation();
    expect(line.billableService.code).toBe(CONSULTATION_CODE);
    const asService = context.prisma as unknown as PrismaService;
    const statement = await new PatientAccountService(
      new PrismaBillingAccountRepository(asService),
      new PrismaBillingCatalogueRepository(asService),
      { record: () => Promise.resolve() },
      new PrismaClinicalActsRepository(asService),
    ).statement({ accountId: line.accountId, siteId: context.siteId });
    expect(statement.consultationOutdated).toEqual({
      chargeId: line.id,
      billed: false,
    });
  });

  it('BI-203 la consulta quitada no se toca', async () => {
    await press();
    const before = await consultation();
    await context.accounts.voidCharge({
      chargeId: before.id,
      voidedById: context.userId,
      reason: null,
      now: new Date(),
    });

    await retieTypeTo('CONS-DER-SUB');
    await repricer().repriceConsultation({
      encounterId: context.encounterId,
      siteId: context.siteId,
      changedById: context.userId,
    });

    expect((await consultation()).billableService.code).toBe(CONSULTATION_CODE);
  });
});
