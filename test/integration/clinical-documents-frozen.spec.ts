import type { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createIssuedPrescription,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * Once issued, a clinical document does not change, and none is deleted —
 * against a real PostgreSQL, because what breaks it is precisely what does not
 * go through the code: a `psql`, an import, a support script.
 *
 * Every refusal stands beside the permitted change going through the same
 * trigger: without it, a trigger that refused EVERY update would pass too.
 */
const db = useDatabase();

interface Scene {
  siteId: string;
  encounterId: string;
  patientId: string;
  practitionerId: string;
  userId: string;
}

async function aScene(prisma: PrismaClient): Promise<Scene> {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  const user = await createUser(prisma);
  return {
    siteId: site.id,
    encounterId: encounter.id,
    patientId: patient.id,
    practitionerId: practitioner.id,
    userId: user.id,
  };
}

let codes = 0;
const nextCode = (): string => `FZ-${String(++codes).padStart(8, '0')}`;

async function aCertificate(
  prisma: PrismaClient,
  scene: Scene,
): Promise<string> {
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO medical_certificate
      (encounter_id, patient_id, issued_by_id, type, verification_code)
    VALUES (${scene.encounterId}::uuid, ${scene.patientId}::uuid,
            ${scene.practitionerId}::uuid, 'ATTENDANCE', ${nextCode()})
    RETURNING id
  `;
  return row!.id;
}

/** A receta with one line, issued (`issued_at` set) or a draft. */
async function aPrescription(
  prisma: PrismaClient,
  scene: Scene,
  issued: boolean,
): Promise<{ id: string; itemId: string }> {
  const create = issued
    ? (data: Prisma.PrescriptionUncheckedCreateInput) =>
        createIssuedPrescription(prisma, data)
    : (data: Prisma.PrescriptionUncheckedCreateInput) =>
        prisma.prescription.create({ data, include: { items: true } });
  const prescription = await create({
    encounterId: scene.encounterId,
    siteId: scene.siteId,
    prescriberId: scene.practitionerId,
    status: issued ? 'ACTIVE' : 'DRAFT',
    issuedAt: issued ? new Date() : null,
    verificationCode: issued ? nextCode() : null,
    warningSigns: 'Fiebre mayor de 39 °C',
    nonPharmacologicalAdvice: 'Reposo relativo',
    items: {
      create: {
        genericName: 'Paracetamol',
        doseText: '1 tableta',
        frequencyText: 'cada 8 horas',
        durationDays: 3,
        offFormularyJustification: 'Fuera del CNMB para esta prueba',
      },
    },
  });
  return { id: prescription.id, itemId: prescription.items[0]!.id };
}

describe('CER-011 el certificado emitido no cambia salvo para anularlo, y no se borra', () => {
  it('CER-011 anularlo pasa; cambiar lo emitido, deshacer la anulación o borrarlo no', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const id = await aCertificate(prisma, scene);

    await expect(
      prisma.$executeRaw`UPDATE medical_certificate SET include_diagnosis = true WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/medical_certificate_frozen/);

    // Control positivo: la anulación pasa por el mismo disparador.
    await expect(
      prisma.$executeRaw`
        UPDATE medical_certificate
           SET revoked_at = now(), revoked_by_id = ${scene.userId}::uuid,
               revocation_reason = 'Emitido a la persona equivocada'
         WHERE id = ${id}::uuid`,
    ).resolves.toBe(1);

    await expect(
      prisma.$executeRaw`
        UPDATE medical_certificate
           SET revoked_at = NULL, revoked_by_id = NULL, revocation_reason = NULL
         WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/medical_certificate_frozen/);
    await expect(
      prisma.$executeRaw`UPDATE medical_certificate SET revocation_reason = 'Otro motivo' WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/medical_certificate_frozen/);
    await expect(
      prisma.$executeRaw`DELETE FROM medical_certificate WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/medical_certificate_frozen/);
  });
});

describe('PR-020 PR-038 la receta emitida sólo cambia de estado, y no se borra', () => {
  it('PR-020 su estado cambia; su contenido y su número no', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const { id } = await aPrescription(prisma, scene, true);

    await expect(
      prisma.$executeRaw`UPDATE prescription SET warning_signs = 'Otra cosa' WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/prescription_frozen/);

    // Control positivo: anularla es cambiar de estado, y pasa.
    await expect(
      prisma.$executeRaw`UPDATE prescription SET status = 'CANCELLED' WHERE id = ${id}::uuid`,
    ).resolves.toBe(1);

    await expect(
      prisma.$executeRaw`DELETE FROM prescription WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/prescription_frozen/);
  });

  it('PR-038 sus líneas no se editan, no se borran y no se añaden después', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const issued = await aPrescription(prisma, scene, true);

    await expect(
      prisma.$executeRaw`UPDATE prescription_item SET dose_text = '2 tabletas' WHERE id = ${issued.itemId}::uuid`,
    ).rejects.toThrow(/prescription_frozen/);
    await expect(
      prisma.$executeRaw`DELETE FROM prescription_item WHERE id = ${issued.itemId}::uuid`,
    ).rejects.toThrow(/prescription_frozen/);
    await expect(
      prisma.$executeRaw`
        INSERT INTO prescription_item (prescription_id, generic_name, dose_text, frequency_text, off_formulary_justification)
        VALUES (${issued.id}::uuid, 'Morfina', '1 ampolla', 'cada 4 horas', 'Prueba')`,
    ).rejects.toThrow(/prescription_frozen/);

    // Control positivo: las de un borrador se editan, se borran y se añaden.
    const draft = await aPrescription(prisma, scene, false);
    await expect(
      prisma.$executeRaw`UPDATE prescription_item SET dose_text = '2 tabletas' WHERE id = ${draft.itemId}::uuid`,
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRaw`
        INSERT INTO prescription_item (prescription_id, generic_name, dose_text, frequency_text, off_formulary_justification)
        VALUES (${draft.id}::uuid, 'Ibuprofeno', '1 tableta', 'cada 8 horas', 'Prueba')`,
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRaw`DELETE FROM prescription_item WHERE id = ${draft.itemId}::uuid`,
    ).resolves.toBe(1);
  });
});

describe('PR-010 PR-038 lo que la segunda revision encontro abierto', () => {
  it('PR-010 una receta anulada no vuelve a estar vigente; completarla y anularla si', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const { id } = await aPrescription(prisma, scene, true);

    // Control positivo: el estado avanza.
    await expect(
      prisma.$executeRaw`UPDATE prescription SET status = 'COMPLETED' WHERE id = ${id}::uuid`,
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRaw`UPDATE prescription SET status = 'CANCELLED' WHERE id = ${id}::uuid`,
    ).resolves.toBe(1);

    await expect(
      prisma.$executeRaw`UPDATE prescription SET status = 'ACTIVE' WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/prescription_frozen/);
  });

  it('PR-038 una linea no sale de una receta emitida llevandola a un borrador', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const issued = await aPrescription(prisma, scene, true);
    const draft = await aPrescription(prisma, scene, false);

    await expect(
      prisma.$executeRaw`UPDATE prescription_item SET prescription_id = ${draft.id}::uuid WHERE id = ${issued.itemId}::uuid`,
    ).rejects.toThrow(/prescription_frozen/);
    // Ni al revés: una línea de borrador no entra en la emitida.
    await expect(
      prisma.$executeRaw`UPDATE prescription_item SET prescription_id = ${issued.id}::uuid WHERE id = ${draft.itemId}::uuid`,
    ).rejects.toThrow(/prescription_frozen/);
  });

  it('PR-038 tocar la receta en la misma transaccion no abre la puerta a añadirle una linea', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const { id } = await aPrescription(prisma, scene, true);

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE prescription SET status = status WHERE id = ${id}::uuid`;
        await tx.$executeRaw`
          INSERT INTO prescription_item (prescription_id, generic_name, dose_text, frequency_text, off_formulary_justification)
          VALUES (${id}::uuid, 'Morfina', '1 ampolla', 'cada 4 horas', 'Prueba')`;
      }),
    ).rejects.toThrow(/prescription_frozen/);
  });

  it('CER-011 PR-020 ORD-006 TRUNCATE tampoco borra lo emitido', async () => {
    const prisma = db();
    // Control positivo: la misma sentencia sobre una tabla sin la guarda pasa.
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE document_counter'),
    ).resolves.toBeDefined();

    for (const table of [
      'prescription_item',
      'prescription',
      'medical_certificate',
      'service_order',
    ]) {
      await expect(
        prisma.$executeRawUnsafe(`TRUNCATE TABLE ${table} CASCADE`),
      ).rejects.toThrow(
        /_frozen: issued clinical documents are never truncated/,
      );
    }
  });
});

describe('ORD-006 la orden numerada no se borra', () => {
  it('ORD-006 borrarla se rechaza; tocar lo que no está congelado pasa', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const [order] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO service_order (encounter_id, site_id, ordered_by_id, category, status, updated_at)
      SELECT e.id, e.site_id, ${scene.practitionerId}::uuid, 'LABORATORY', 'ISSUED', now()
        FROM encounter e WHERE e.id = ${scene.encounterId}::uuid
      RETURNING id
    `;

    // Control positivo: un UPDATE sobre la orden pasa. Su nota clínica ya
    // no, desde ORD-096: una orden emitida no se reescribe.
    await expect(
      prisma.$executeRaw`UPDATE service_order SET updated_at = now() WHERE id = ${order!.id}::uuid`,
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRaw`DELETE FROM service_order WHERE id = ${order!.id}::uuid`,
    ).rejects.toThrow(/service_order_frozen/);
  });
});
