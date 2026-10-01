import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  addDays,
  clinicalDateOf,
  type ClinicalDate,
} from '../../src/shared/domain/clinic-time';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * D-105 against a real PostgreSQL: who issues a 117, and the window of its
 * rest (CER-030, CER-039, CER-041).
 *
 * The three rules compare the row with ITS ATTENTION —who attended, which
 * day—, which is why they are a trigger and not a `CHECK`, and why only the
 * database can show that an import or a `psql` is stopped too. Every refusal
 * sits beside the permitted case going through the same raw `INSERT`.
 *
 * Every instant derives from the attention's own `started_at`: the fixture's,
 * never one written here.
 */
const db = useDatabase();

const DAY_MS = 24 * 60 * 60 * 1000;

interface Scene {
  encounterId: string;
  patientId: string;
  /** Who attended. */
  attendingId: string;
  /** A colleague of the same clinic who did not. */
  otherId: string;
  startedAt: Date;
  /** The attention's clinical date, in Ecuador. */
  day: ClinicalDate;
}

async function aScene(prisma: PrismaClient): Promise<Scene> {
  const site = await createSite(prisma);
  const attending = await createPractitioner(prisma);
  const other = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: attending.id,
    patientId: patient.id,
  });
  return {
    encounterId: encounter.id,
    patientId: patient.id,
    attendingId: attending.id,
    otherId: other.id,
    startedAt: encounter.startedAt,
    day: clinicalDateOf(encounter.startedAt),
  };
}

let codes = 0;
const nextCode = (): string => `D105-${String(++codes).padStart(8, '0')}`;

interface Row {
  issuedById?: string;
  /** Whole days after the attention's instant; 0 is the same instant. */
  issuedDaysLater?: number;
  rest?: { from: ClinicalDate; to: ClinicalDate } | null;
  backdatingReason?: string | null;
  otherReason?: string | null;
}

/** One certificate by raw SQL: no repository, no service. */
function insert(prisma: PrismaClient, scene: Scene, row: Row = {}) {
  const rest = row.rest === undefined ? null : row.rest;
  const issuedAt = new Date(
    scene.startedAt.getTime() + (row.issuedDaysLater ?? 0) * DAY_MS,
  );
  return prisma.$executeRaw`
    INSERT INTO medical_certificate
      (encounter_id, patient_id, issued_by_id, type, rest_from, rest_to,
       include_diagnosis, contingency_type, verification_code, issued_at,
       rest_backdating_reason, issued_by_other_reason)
    VALUES (${scene.encounterId}::uuid, ${scene.patientId}::uuid,
            ${row.issuedById ?? scene.attendingId}::uuid,
            ${rest === null ? 'ATTENDANCE' : 'MEDICAL_REST'}::certificate_type,
            ${rest?.from ?? null}::date, ${rest?.to ?? null}::date,
            ${rest !== null},
            ${rest === null ? null : 'GENERAL_ILLNESS'}::certificate_contingency_type,
            ${nextCode()}, ${issuedAt},
            ${row.backdatingReason ?? null}, ${row.otherReason ?? null})
  `;
}

const REASON = 'Cubre el turno de la doctora que atendió';

describe('CER-039 el 117 lo emite el profesional de la atención; un tercero, con motivo', () => {
  it('CER-039 quien atendió lo emite sin motivo (control positivo)', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    await expect(insert(prisma, scene)).resolves.toBe(1);
  });

  it('CER-039 otro profesional sin motivo se rechaza, y con motivo pasa', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    await expect(
      insert(prisma, scene, { issuedById: scene.otherId }),
    ).rejects.toThrow(/medical_certificate_issuer_reason_required/);
    await expect(
      insert(prisma, scene, { issuedById: scene.otherId, otherReason: REASON }),
    ).resolves.toBe(1);
  });

  it('CER-039 quien atendió no guarda motivo de tercero, y el motivo nunca va en blanco', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    await expect(
      insert(prisma, scene, { otherReason: REASON }),
    ).rejects.toThrow(/medical_certificate_issuer_reason_only_for_others/);
    await expect(
      insert(prisma, scene, { issuedById: scene.otherId, otherReason: '   ' }),
    ).rejects.toThrow(/medical_certificate_issuer_reason_not_blank/);
  });
});

describe('CER-041 el reposo empieza, como tarde, el día siguiente a la emisión', () => {
  it('CER-041 un reposo desde mañana pasa, y uno desde pasado mañana se rechaza', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const tomorrow = addDays(scene.day, 1);
    const later = addDays(scene.day, 2);

    await expect(
      insert(prisma, scene, { rest: { from: tomorrow, to: tomorrow } }),
    ).resolves.toBe(1);
    await expect(
      insert(prisma, scene, { rest: { from: later, to: later } }),
    ).rejects.toThrow(/medical_certificate_rest_starts_by_next_day/);
  });

  it('CER-041 un reposo que empieza en 90 días se rechaza (D-105 §3)', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const far = addDays(scene.day, 90);

    await expect(
      insert(prisma, scene, { rest: { from: far, to: far } }),
    ).rejects.toThrow(/medical_certificate_rest_starts_by_next_day/);
  });
});

describe('CER-030 el reposo pide motivo si empieza antes de la atención o se emite después de su día', () => {
  it('CER-030 emitido el día de la atención y desde ese día: sin motivo (control positivo)', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    await expect(
      insert(prisma, scene, { rest: { from: scene.day, to: scene.day } }),
    ).resolves.toBe(1);
  });

  it('CER-030 emitido un día después de la atención: sin motivo se rechaza, con motivo pasa', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const rest = { from: scene.day, to: addDays(scene.day, 2) };

    await expect(
      insert(prisma, scene, { rest, issuedDaysLater: 1 }),
    ).rejects.toThrow(/medical_certificate_backdating_reason_required/);
    await expect(
      insert(prisma, scene, {
        rest,
        issuedDaysLater: 1,
        backdatingReason: 'El paciente volvió por el certificado al día siguiente',
      }),
    ).resolves.toBe(1);
  });

  it('CER-030 un reposo que empieza antes de la atención sin motivo se rechaza', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const yesterday = addDays(scene.day, -1);

    await expect(
      insert(prisma, scene, { rest: { from: yesterday, to: scene.day } }),
    ).rejects.toThrow(/medical_certificate_backdating_reason_required/);
  });

  it('CER-030 un reposo del día, emitido el día, no guarda motivo', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    await expect(
      insert(prisma, scene, {
        rest: { from: scene.day, to: scene.day },
        backdatingReason: 'Un motivo que no hacía falta',
      }),
    ).rejects.toThrow(/medical_certificate_backdating_reason_only_when_late/);
  });

  it('CER-030 la regla sólo mira el reposo: la asistencia emitida días después no pide motivo', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    await expect(
      insert(prisma, scene, { issuedDaysLater: 3 }),
    ).resolves.toBe(1);
  });
});
