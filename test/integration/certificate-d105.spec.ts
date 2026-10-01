import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  addDays,
  atWallClock,
  clinicalDateOf,
  WallClockTime,
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
  /** The exact instant of issue, when whole days are not the point. */
  issuedAt?: Date;
  rest?: { from: ClinicalDate; to: ClinicalDate } | null;
  backdatingReason?: string | null;
  otherReason?: string | null;
  /** CER-035. A maternity rest, with its three dates. */
  maternity?: { admissionOn: ClinicalDate; birthOn: ClinicalDate; dischargeOn: ClinicalDate }; // prettier-ignore
}

/** One certificate by raw SQL: no repository, no service. */
function insert(prisma: PrismaClient, scene: Scene, row: Row = {}) {
  const rest = row.rest === undefined ? null : row.rest;
  const issuedAt =
    row.issuedAt ??
    new Date(scene.startedAt.getTime() + (row.issuedDaysLater ?? 0) * DAY_MS);
  const maternity = row.maternity ?? null;
  const contingency =
    rest === null ? null : maternity === null ? 'GENERAL_ILLNESS' : 'MATERNITY';
  return prisma.$executeRaw`
    INSERT INTO medical_certificate
      (encounter_id, patient_id, issued_by_id, type, rest_from, rest_to,
       include_diagnosis, contingency_type, verification_code, issued_at,
       rest_backdating_reason, issued_by_other_reason,
       maternity_admission_on, birth_on, maternity_discharge_on)
    VALUES (${scene.encounterId}::uuid, ${scene.patientId}::uuid,
            ${row.issuedById ?? scene.attendingId}::uuid,
            ${rest === null ? 'ATTENDANCE' : 'MEDICAL_REST'}::certificate_type,
            ${rest?.from ?? null}::date, ${rest?.to ?? null}::date,
            ${rest !== null},
            ${contingency}::certificate_contingency_type,
            ${nextCode()}, ${issuedAt},
            ${row.backdatingReason ?? null}, ${row.otherReason ?? null},
            ${maternity?.admissionOn ?? null}::date,
            ${maternity?.birthOn ?? null}::date,
            ${maternity?.dischargeOn ?? null}::date)
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

  it('CER-039 CER-030 un motivo de menos de diez caracteres tampoco lo admite la base', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    await expect(
      insert(prisma, scene, { issuedById: scene.otherId, otherReason: 'x' }),
    ).rejects.toThrow(/medical_certificate_issuer_reason_not_blank/);
    await expect(
      insert(prisma, scene, {
        rest: { from: scene.day, to: scene.day },
        issuedDaysLater: 1,
        backdatingReason: 'tarde',
      }),
    ).rejects.toThrow(/medical_certificate_backdating_reason_not_blank/);
    // Control positivo: ten characters, the service's own minimum.
    await expect(
      insert(prisma, scene, {
        issuedById: scene.otherId,
        otherReason: 'Diez letra',
      }),
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
        backdatingReason:
          'El paciente volvió por el certificado al día siguiente',
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

    await expect(insert(prisma, scene, { issuedDaysLater: 3 })).resolves.toBe(
      1,
    );
  });
});

describe('CER-030 CER-041 el disparador cuenta los días en America/Guayaquil, no en UTC', () => {
  it('CER-041 CER-030 una atención a las 20:00 de Ecuador (ya el día siguiente en UTC) se juzga por su día ecuatoriano', async () => {
    const prisma = db();
    const base = await aScene(prisma);
    // 20:00 in Ecuador is 01:00 UTC of the following day: a bare `::date`
    // in UTC would move both the attention and the issue one day ahead.
    const evening = atWallClock(base.day, WallClockTime.of(20, 0));
    await prisma.encounter.update({
      where: { id: base.encounterId },
      data: { startedAt: evening },
    });
    const scene = { ...base, startedAt: evening };

    // Control positivo: issued that evening, from that Ecuadorian day, with
    // no reason. In UTC the rest would start «before the attention».
    await expect(
      insert(prisma, scene, { rest: { from: base.day, to: base.day } }),
    ).resolves.toBe(1);
    // And the latest start is the Ecuadorian next day, not the one after.
    await expect(
      insert(prisma, scene, {
        rest: { from: addDays(base.day, 2), to: addDays(base.day, 2) },
      }),
    ).rejects.toThrow(/medical_certificate_rest_starts_by_next_day/);
  });

  it('CER-030 una atención a las 23:00 de Ecuador: emitido a las 05:59 del día siguiente no es tardío, a las 06:00 sí (D-106 §5)', async () => {
    const prisma = db();
    const base = await aScene(prisma);
    const night = atWallClock(base.day, WallClockTime.of(23, 0));
    await prisma.encounter.update({
      where: { id: base.encounterId },
      data: { startedAt: night },
    });
    const scene = { ...base, startedAt: night };
    const nextDay = addDays(base.day, 1);
    const rest = { from: nextDay, to: nextDay };

    // Control positivo: the dawn still counts as the attention's day.
    await expect(
      insert(prisma, scene, {
        rest,
        issuedAt: atWallClock(nextDay, WallClockTime.of(5, 59)),
      }),
    ).resolves.toBe(1);
    // From 06:00 it is a late issue, which needs its reason.
    await expect(
      insert(prisma, scene, {
        rest,
        issuedAt: atWallClock(nextDay, WallClockTime.of(6, 0)),
      }),
    ).rejects.toThrow(/medical_certificate_backdating_reason_required/);
  });
});

describe('D-106 los límites de la ventana del reposo, garantizados por la base', () => {
  const REASON_LATE = 'Volvió por el certificado días después';

  it('CER-044 con motivo, el reposo empieza como mucho 3 días antes de la atención; 4 días antes se rechaza (D-106 §1)', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    // Control positivo: three days before, with its reason.
    await expect(
      insert(prisma, scene, {
        rest: { from: addDays(scene.day, -3), to: scene.day },
        backdatingReason: 'Fiebre desde tres días antes',
      }),
    ).resolves.toBe(1);
    await expect(
      insert(prisma, scene, {
        rest: { from: addDays(scene.day, -4), to: scene.day },
        backdatingReason: 'Fiebre desde cuatro días antes',
      }),
    ).rejects.toThrow(/medical_certificate_rest_starts_at_most_3_days_before/);
  });

  it('CER-045 un reposo se emite hasta el octavo día después de la atención; el noveno se rechaza (D-106 §4)', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const startingThen = (days: number) => ({
      from: addDays(scene.day, days),
      to: addDays(scene.day, days),
    });

    // Control positivo: issued on day 8, starting that day, with its reason.
    await expect(
      insert(prisma, scene, {
        rest: startingThen(8),
        issuedDaysLater: 8,
        backdatingReason: REASON_LATE,
      }),
    ).resolves.toBe(1);
    await expect(
      insert(prisma, scene, {
        rest: startingThen(9),
        issuedDaysLater: 9,
        backdatingReason: REASON_LATE,
      }),
    ).rejects.toThrow(/medical_certificate_rest_issued_within_8_days/);
  });

  it('CER-045 la madrugada del noveno día aún cuenta como el octavo: 05:59 pasa, 06:00 no (D-108 §2)', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const ninth = addDays(scene.day, 9);
    const rest = { from: ninth, to: ninth };

    await expect(
      insert(prisma, scene, {
        rest,
        issuedAt: atWallClock(ninth, WallClockTime.of(5, 59)),
        backdatingReason: REASON_LATE,
      }),
    ).resolves.toBe(1);
    await expect(
      insert(prisma, scene, {
        rest,
        issuedAt: atWallClock(ninth, WallClockTime.of(6, 0)),
        backdatingReason: REASON_LATE,
      }),
    ).rejects.toThrow(/medical_certificate_rest_issued_within_8_days/);
  });

  it('CER-045 la asistencia emitida pasados 8 días no tiene ese tope (D-106 §3)', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    await expect(insert(prisma, scene, { issuedDaysLater: 20 })).resolves.toBe(
      1,
    );
  });
});

describe('D-108 en el reposo de maternidad no rigen los topes de D-106, garantizado por la base', () => {
  /** Ingresó dos días antes del parto y salió dos días después. */
  const maternityFrom = (birth: ClinicalDate) => ({
    admissionOn: addDays(birth, -2),
    birthOn: birth,
    dischargeOn: addDays(birth, 2),
  });
  const REASON_BIRTH = 'Dio a luz en el hospital antes de la atención';
  const TOO_EARLY = /medical_certificate_rest_starts_at_most_3_days_before/;

  it('CER-044 la maternidad empieza el día del parto al 5.º día, o el del ingreso; la enfermedad general igual se rechaza', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const birth = addDays(scene.day, -5);
    const maternity = maternityFrom(birth);
    const from = (day: ClinicalDate) => ({ from: day, to: scene.day });

    // Control positivo: maternity from birth, and from admission.
    await expect(
      insert(prisma, scene, { rest: from(birth), maternity, backdatingReason: REASON_BIRTH }), // prettier-ignore
    ).resolves.toBe(1);
    await expect(
      insert(prisma, scene, { rest: from(maternity.admissionOn), maternity, backdatingReason: REASON_BIRTH }), // prettier-ignore
    ).resolves.toBe(1);
    await expect(
      insert(prisma, scene, { rest: from(birth), backdatingReason: REASON_BIRTH }), // prettier-ignore
    ).rejects.toThrow(TOO_EARLY);
  });

  it('CER-044 un día que no es ni el ingreso ni el parto se rechaza, y la prenatal conserva los 3 días', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const maternity = maternityFrom(addDays(scene.day, -5));

    for (const day of [
      addDays(maternity.admissionOn, 1),
      addDays(maternity.admissionOn, -1),
    ]) {
      await expect(
        insert(prisma, scene, { rest: { from: day, to: scene.day }, maternity, backdatingReason: REASON_BIRTH }), // prettier-ignore
      ).rejects.toThrow(TOO_EARLY);
    }

    const prenatal = maternityFrom(addDays(scene.day, 20));
    const CONTRACTIONS = 'Contracciones desde días antes';
    await expect(
      insert(prisma, scene, { rest: { from: addDays(scene.day, -3), to: scene.day }, maternity: prenatal, backdatingReason: CONTRACTIONS }), // prettier-ignore
    ).resolves.toBe(1);
    await expect(
      insert(prisma, scene, { rest: { from: addDays(scene.day, -4), to: scene.day }, maternity: prenatal, backdatingReason: CONTRACTIONS }), // prettier-ignore
    ).rejects.toThrow(TOO_EARLY);
  });

  it('CER-030 la maternidad desde el parto sigue pidiendo el motivo', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const birth = addDays(scene.day, -5);

    await expect(
      insert(prisma, scene, { rest: { from: birth, to: scene.day }, maternity: maternityFrom(birth) }), // prettier-ignore
    ).rejects.toThrow(/medical_certificate_backdating_reason_required/);
  });

  it('CER-045 un reposo de maternidad se emite pasados 8 días de la atención; el general, no', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const twentieth = addDays(scene.day, 20);
    const rest = { from: twentieth, to: addDays(twentieth, 29) };
    const REASON_CHAIN = 'Segundo certificado de la licencia de maternidad';

    await expect(
      insert(prisma, scene, {
        rest,
        issuedDaysLater: 20,
        maternity: maternityFrom(addDays(scene.day, -1)),
        backdatingReason: REASON_CHAIN,
      }),
    ).resolves.toBe(1);
    await expect(
      insert(prisma, scene, { rest, issuedDaysLater: 20, backdatingReason: REASON_CHAIN }), // prettier-ignore
    ).rejects.toThrow(/medical_certificate_rest_issued_within_8_days/);
  });

  it('CER-035 la base exige ingreso ≤ parto ≤ alta, porque de esas fechas sale el inicio admitido', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const birth = addDays(scene.day, -1);
    const rest = { from: scene.day, to: scene.day };
    const IN_ORDER = /medical_certificate_maternity_dates_in_order/;

    // Control positivo: the three on the same day are in order.
    await expect(
      insert(prisma, scene, { rest, maternity: { admissionOn: birth, birthOn: birth, dischargeOn: birth } }), // prettier-ignore
    ).resolves.toBe(1);
    await expect(
      insert(prisma, scene, { rest, maternity: { admissionOn: addDays(birth, 1), birthOn: birth, dischargeOn: addDays(birth, 1) } }), // prettier-ignore
    ).rejects.toThrow(IN_ORDER);
    await expect(
      insert(prisma, scene, { rest, maternity: { admissionOn: birth, birthOn: birth, dischargeOn: addDays(birth, -1) } }), // prettier-ignore
    ).rejects.toThrow(IN_ORDER);
  });
});
