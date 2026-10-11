import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createExamService,
  createPatient,
  createPractitioner,
  createService,
  createSite,
  createSpecialty,
  createUser,
} from './setup/fixtures';
import { aTariffConcept } from './orders-fixtures';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * UN SOLO CATÁLOGO DE SERVICIOS (ADR-013): LO QUE GARANTIZA LA BASE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cada rechazo se provoca por debajo de la aplicación, con la sentencia que
 * escribiría una semilla o un importe masivo, y lleva al lado su control
 * positivo por el mismo camino: sin él, un rechazo puede venir de otra cosa.
 */

/**
 * A service written by raw SQL, as a seed would: PostgreSQL's own message
 * names the unique index, which Prisma's translation does not.
 */
function insertService(
  prisma: PrismaClient,
  row: { code: string; name: string; kind: string; mspCode?: string },
): Promise<number> {
  return prisma.$executeRaw`
    INSERT INTO service (code, name, kind, msp_code, tax_rate_id, updated_at)
    SELECT ${row.code}, ${row.name}, ${row.kind}, ${row.mspCode ?? null}, id, now()
      FROM tax_rate WHERE sri_code = '0' LIMIT 1`;
}

/** A consultation by raw SQL, so the refusal names the index (BI-298). */
function insertConsultation(
  prisma: PrismaClient,
  row: {
    code: string;
    name: string;
    specialtyId: string;
    visitKind: string | null;
  },
): Promise<number> {
  return prisma.$executeRaw`
    INSERT INTO service (code, name, kind, tax_rate_id, specialty_id, duration_minutes, visit_kind, updated_at)
    SELECT ${row.code}, ${row.name}, 'CONSULTATION', id, ${row.specialtyId}::uuid, 30, ${row.visitKind}, now()
      FROM tax_rate WHERE sri_code = '0' LIMIT 1`;
}

/** The message of a rejected statement, constraint name included. */
async function refusal(statement: Promise<unknown>): Promise<string> {
  try {
    await statement;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('La sentencia se aceptó');
}

describe('el catálogo único de servicios, en la base (B21)', () => {
  const db = useDatabase();
  let prisma: PrismaClient;
  let specialtyId: string;

  beforeEach(async () => {
    prisma = db();
    specialtyId = (await createSpecialty(prisma)).id;
  });

  const consultation = (
    overrides: Partial<Parameters<typeof createService>[1]> = {},
  ) =>
    createService(prisma, {
      code: 'CONS-CAR-PV',
      name: 'Consulta de cardiología · Primera vez',
      kind: 'CONSULTATION',
      specialtyId,
      durationMinutes: 30,
      visitKind: 'FIRST_VISIT',
      ...overrides,
    });

  describe('BI-278 el tipo', () => {
    it('BI-278 refuses a kind that is not one of the six, and takes a known one', async () => {
      await expect(
        createService(prisma, {
          code: 'INS-GASA',
          name: 'Gasa',
          kind: 'SUPPLY',
        }),
      ).resolves.toMatchObject({ kind: 'SUPPLY' });

      expect(
        await refusal(
          createService(prisma, {
            code: 'LAB-X',
            name: 'Otra cosa',
            kind: 'LABORATORY' as never,
          }),
        ),
      ).toContain('service_kind_is_known');
    });

    it('BI-278 keeps the kind fixed once created, while the name can change', async () => {
      const gauze = await createService(prisma, {
        code: 'INS-GASA',
        name: 'Gasa',
        kind: 'SUPPLY',
      });

      await expect(
        prisma.service.update({
          where: { id: gauze.id },
          data: { name: 'Gasa estéril' },
        }),
      ).resolves.toMatchObject({ name: 'Gasa estéril' });

      expect(
        await refusal(
          prisma.service.update({
            where: { id: gauze.id },
            data: { kind: 'OTHER' },
          }),
        ),
      ).toContain('service_kind_is_fixed');
    });

    it('BI-278 refuses a second active service with the same name ignoring case and accents, but not beside a retired one', async () => {
      await createService(prisma, {
        code: 'INS-GASA',
        name: 'Gasa estéril',
        kind: 'SUPPLY',
        active: false,
      });
      // Control: beside a retired one, the name is free.
      await createService(prisma, {
        code: 'INS-GASA-2',
        name: 'Gasa estéril',
        kind: 'SUPPLY',
      });

      expect(
        await refusal(
          insertService(prisma, {
            code: 'OTR-GASA',
            name: '  GASA ESTERIL ',
            kind: 'OTHER',
          }),
        ),
      ).toContain('service_active_name_unique');
    });
  });

  describe('BI-279 la consulta', () => {
    it('BI-279 demands specialty and duration on a consultation, and takes them', async () => {
      await expect(consultation()).resolves.toMatchObject({
        specialtyId,
        durationMinutes: 30,
        visitKind: 'FIRST_VISIT',
      });

      expect(
        await refusal(
          consultation({
            code: 'CONS-X',
            name: 'Consulta sin especialidad',
            specialtyId: undefined,
          }),
        ),
      ).toContain('service_consultation_shape');
      expect(
        await refusal(
          consultation({
            code: 'CONS-Y',
            name: 'Consulta sin duración',
            durationMinutes: undefined,
          }),
        ),
      ).toContain('service_consultation_shape');
    });

    it('BI-279 refuses agenda data on anything that is not a consultation', async () => {
      expect(
        await refusal(
          createService(prisma, {
            code: 'INS-GASA',
            name: 'Gasa',
            kind: 'SUPPLY',
            specialtyId,
          }),
        ),
      ).toContain('service_consultation_shape');
      expect(
        await refusal(
          createService(prisma, {
            code: 'PROC-ECG',
            name: 'Electrocardiograma',
            kind: 'PROCEDURE',
            visitKind: 'FOLLOW_UP',
          }),
        ),
      ).toContain('service_consultation_shape');
    });

    it('BI-298 refuses a second active consultation of the same specialty and visit, but takes the other visit or one beside a retired twin', async () => {
      await consultation();
      // Control: the other visit of the same specialty is its own consultation.
      await consultation({
        code: 'CONS-CAR-SUB',
        name: 'Consulta de cardiología · Control',
        visitKind: 'FOLLOW_UP',
      });

      expect(
        await refusal(
          insertConsultation(prisma, {
            code: 'CONS-CAR-PV2',
            name: 'Cardiología primera vez bis',
            specialtyId,
            visitKind: 'FIRST_VISIT',
          }),
        ),
      ).toContain('service_one_consultation_per_visit');

      // Control: a retired twin does not count, so its replacement is taken.
      await prisma.service.updateMany({
        where: { code: 'CONS-CAR-PV' },
        data: { active: false },
      });
      await consultation({ code: 'CONS-CAR-PV2', name: 'Cardiología primera vez bis' }); // prettier-ignore
      // And bringing the retired one back would make two: refused.
      expect(
        await refusal(
          prisma.$executeRaw`UPDATE service SET active = true WHERE code = 'CONS-CAR-PV'`,
        ),
      ).toContain('service_one_consultation_per_visit');
    });

    it('BI-298 counts a consultation without visit as its own case', async () => {
      await consultation({ code: 'CONS-CAR-X', name: 'Consulta de cardiología', visitKind: null }); // prettier-ignore
      // Control: beside it, the visits are still free.
      await consultation();

      expect(
        await refusal(
          insertConsultation(prisma, { code: 'CONS-CAR-Y', name: 'Otra de cardiología', specialtyId, visitKind: null }), // prettier-ignore
        ),
      ).toContain('service_one_consultation_per_visit');
    });

    it('BI-279 keeps the duration between 5 and 240 in steps of 5', async () => {
      await expect(
        consultation({ durationMinutes: 240 }),
      ).resolves.toBeTruthy();

      expect(
        await refusal(
          consultation({
            code: 'CONS-Z',
            name: 'Consulta corta',
            durationMinutes: 7,
          }),
        ),
      ).toContain('service_duration_range');
    });

    it('BI-288 refuses deleting a consultation an appointment names, and deletes one nobody names', async () => {
      const spare = await consultation({
        code: 'CONS-SPARE',
        name: 'Consulta libre',
      });
      await prisma.service.delete({ where: { id: spare.id } });

      const booked = await consultation();
      const site = await createSite(prisma);
      const practitioner = await createPractitioner(prisma);
      const patient = await createPatient(prisma);
      const startsAt = new Date(Date.now() + 86_400_000);
      await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 30 * 60_000),
          bookingChannel: 'PHONE',
          serviceId: booked.id,
        },
      });

      expect(
        await refusal(prisma.service.delete({ where: { id: booked.id } })),
      ).toContain('agenda_entry_service_fk');
    });

    it('BI-288 refuses deleting a service an order line names by its code, and deletes one nobody ordered', async () => {
      // Control: nobody ordered it, so it goes.
      const spare = await createExamService(prisma, {
        code: 'LAB-SPARE',
        name: 'Examen libre',
      });
      await prisma.service.delete({ where: { id: spare.id } });

      // The order line names its service by CODE, with no key to it (ORD-002):
      // only the trigger stands between a delete and an orphaned order.
      const ordered = await createExamService(prisma, {
        code: 'LAB-ORDERED',
        name: 'Examen pedido',
      });
      const site = await createSite(prisma);
      const practitioner = await createPractitioner(prisma);
      const patient = await createPatient(prisma);
      const encounter = await createEncounter(prisma, {
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
      });
      const order = await prisma.serviceOrder.create({
        data: { encounterId: encounter.id, siteId: site.id, orderedById: practitioner.id, category: 'LABORATORY' }, // prettier-ignore
      });
      await prisma.serviceOrderItem.create({
        data: { serviceOrderId: order.id, testCode: 'LAB-ORDERED', testDisplay: 'Pedido' }, // prettier-ignore
      });

      expect(
        await refusal(prisma.service.delete({ where: { id: ordered.id } })),
      ).toContain('service_code_in_use');
      expect(await prisma.service.count({ where: { id: ordered.id } })).toBe(1);
    });
  });

  describe('BI-284 la extensión de orden', () => {
    it('BI-284 admits the order extension on an exam, an imaging study and a procedure, and refuses it on a supply or a consultation', async () => {
      await expect(
        createExamService(prisma, { code: 'LAB-BH', name: 'Biometría' }),
      ).resolves.toBeTruthy();
      await expect(
        createExamService(prisma, {
          code: 'IMG-RX',
          name: 'Radiografía de tórax',
          kind: 'IMAGING',
        }),
      ).resolves.toBeTruthy();
      await expect(
        createExamService(prisma, {
          code: 'PROC-ECG',
          name: 'Electrocardiograma',
          kind: 'PROCEDURE',
        }),
      ).resolves.toBeTruthy();

      const gauze = await createService(prisma, {
        code: 'INS-GASA',
        name: 'Gasa',
        kind: 'SUPPLY',
      });
      expect(
        await refusal(
          prisma.serviceExam.create({ data: { serviceId: gauze.id } }),
        ),
      ).toContain('service_exam_kind_admits');

      const visit = await consultation();
      expect(
        await refusal(
          prisma.serviceExam.create({ data: { serviceId: visit.id } }),
        ),
      ).toContain('service_exam_kind_admits');
    });

    it('BI-284 keeps the fasting hours with a fast', async () => {
      await expect(
        createExamService(prisma, {
          code: 'LAB-GLU',
          name: 'Glucosa',
          exam: { requiresFasting: true, fastingHours: 8 },
        }),
      ).resolves.toBeTruthy();

      expect(
        await refusal(
          createExamService(prisma, {
            code: 'LAB-COL',
            name: 'Colesterol',
            exam: { requiresFasting: false, fastingHours: 8 },
          }),
        ),
      ).toContain('service_exam_fasting_hours_needs_fasting');
    });
  });

  describe('BI-286 el procedimiento, por su código', () => {
    it('BI-286 refuses two active procedures with the same code, but not an exam or a retired procedure with it', async () => {
      await createService(prisma, {
        code: 'PROC-SUT',
        name: 'Sutura',
        kind: 'PROCEDURE',
        mspCode: '12001',
      });
      // Controls: the same MSP code on an exam, and on a retired procedure.
      await createService(prisma, {
        code: 'LAB-SUT',
        name: 'Examen con el mismo código',
        kind: 'LAB_EXAM',
        mspCode: '12001',
      });
      await createService(prisma, {
        code: 'PROC-SUT-OLD',
        name: 'Sutura antigua',
        kind: 'PROCEDURE',
        mspCode: '12001',
        active: false,
      });

      expect(
        await refusal(
          insertService(prisma, {
            code: 'PROC-SUT-2',
            name: 'Sutura simple',
            kind: 'PROCEDURE',
            mspCode: '12001',
          }),
        ),
      ).toContain('service_one_procedure_per_code');
    });

    it('BI-256 marks the 024 only on a procedure with its code, and keeps that code while marked', async () => {
      const director = await createUser(prisma);
      const mark = {
        requiresWrittenConsent: true,
        writtenConsentSetAt: new Date(),
        writtenConsentSetById: director.id,
      };
      const suture = await createService(prisma, {
        code: 'PROC-SUT',
        name: 'Sutura',
        kind: 'PROCEDURE',
        mspCode: '12001',
      });
      await prisma.service.update({ where: { id: suture.id }, data: mark });

      const gauze = await createService(prisma, {
        code: 'INS-GASA',
        name: 'Gasa',
        kind: 'SUPPLY',
        mspCode: '12002',
      });
      expect(
        await refusal(
          prisma.service.update({ where: { id: gauze.id }, data: mark }),
        ),
      ).toContain('service_written_consent_needs_a_procedure');

      expect(
        await refusal(
          prisma.service.update({
            where: { id: suture.id },
            data: { mspCode: '12003' },
          }),
        ),
      ).toContain('service_written_consent_code_locked');
    });

    it('EN-152 a tariff procedure demands the 024 when a marked procedure service carries its code, of any edition', async () => {
      const director = await createUser(prisma);
      const edition2014 = await aTariffConcept(prisma, { code: '12001' });
      const other = await aTariffConcept(prisma, { code: '12009' });
      const suture = await createService(prisma, {
        code: 'PROC-SUT',
        name: 'Sutura',
        kind: 'PROCEDURE',
        mspCode: '12001',
      });

      const demands = async (conceptId: string) =>
        (
          await prisma.$queryRaw<{ demands: boolean }[]>`
            SELECT procedure_requires_written_consent(${conceptId}::uuid) AS demands`
        )[0]?.demands;

      // Control: unmarked, nothing is demanded.
      expect(await demands(edition2014.id)).toBe(false);

      await prisma.service.update({
        where: { id: suture.id },
        data: {
          requiresWrittenConsent: true,
          writtenConsentSetAt: new Date(),
          writtenConsentSetById: director.id,
        },
      });
      expect(await demands(edition2014.id)).toBe(true);
      expect(await demands(other.id)).toBe(false);
    });
  });
});
