import { HttpStatus } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaChartSummaryRepository } from '../../src/modules/encounter/infrastructure/prisma-chart-summary.repository';
import { PrismaEncounterRepository } from '../../src/modules/encounter/infrastructure/prisma-encounter.repository';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';
import '../../src/modules/encounter/infrastructure/encounter.constraints';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * Block D — form **020** — against a real PostgreSQL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO GUARANTEES THAT ONLY THE DATABASE CAN DEMONSTRATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  - EN-061: the BMI is written by `trg_encounter_vitals_bmi`, on every insert
 *    and update of the weight or the height. A double returning the number we
 *    asked it for would prove nothing at all — and the requirement is that the
 *    figure COMES BACK COMPUTED and that sending one in the request does not
 *    change it.
 *  - EN-062: the physiological ranges are `encounter_vitals_ranges_*`. The
 *    requirement's own example is the finger that typed 750 instead of 75, and
 *    what has to be shown is that the DATABASE refuses it — not the DTO, which
 *    an import or a `psql` walks straight past.
 */
const db = useDatabase();

const repositoryOf = (prisma: PrismaClient) =>
  new PrismaEncounterRepository(prisma as unknown as PrismaService);

type Vitals = Parameters<PrismaEncounterRepository['saveVitals']>[1];

/**
 * EN-064 and EN-143 apply to every taking written since
 * `20260930160703_patient_preparation`: a height goes with its position, and
 * the row names who took it. The tests that are about something else say so
 * once here instead of in every call, and the tests about THOSE two rules call
 * the repository directly.
 */
function recordedBy(
  prisma: PrismaClient,
  authorId: string,
  mayCorrectAfterDischarge = false,
) {
  const repository = repositoryOf(prisma);
  return {
    repository,
    save: (query: { encounterId: string; sites: string[] }, vitals: Vitals) =>
      repository.saveVitals(
        query,
        vitals.heightCm === undefined || vitals.heightPosition !== undefined
          ? vitals
          : { ...vitals, heightPosition: 'STANDING' },
        authorId,
        mayCorrectAfterDischarge,
      ),
  };
}

async function anEncounter(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);

  const encounter = await repositoryOf(prisma).open({
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
    startedAt: new Date('2026-08-14T14:00:00Z'),
    careModality: 'MORBIDITY',
    careSetting: 'INTRAMURAL',
    visitSequence: 'FIRST_TIME',
  });

  return {
    site,
    practitioner,
    patient,
    encounter,
    ...recordedBy(prisma, practitioner.userId),
  };
}

/** Runs an operation expected to fail and maps whatever it threw. */
async function problemFrom(operation: Promise<unknown>) {
  try {
    await operation;
    throw new Error('the operation should have failed');
  } catch (error) {
    return extractDatabaseProblem(error);
  }
}

describe('los signos vitales de la atención', () => {
  it('EN-061 devuelve el IMC CALCULADO por la base a partir del peso y la talla', async () => {
    const prisma = db();
    const { site, encounter, save } = await anEncounter(prisma);

    const vitals = await save(
      { encounterId: encounter.id, sites: [site.id] },
      { weightKg: 68.4, heightCm: 165 },
    );

    // 68.4 / 1.65² = 25.12…, redondeado a dos decimales por el disparador.
    expect(vitals.bmi).toBe(25.12);
  });

  it('EN-061 ignora por completo un IMC escrito directamente en la fila', async () => {
    /**
     * ⚠️ ESTO ES LO QUE HACE QUE RECHAZARLO EN LA API SEA LA ÚNICA RESPUESTA
     * HONESTA. Aunque alguien escriba la columna por SQL, el disparador la
     * sobrescribe en la misma sentencia: el valor tecleado NUNCA llega a estar
     * en el expediente, así que descartarlo en silencio dejaría a quien lo
     * escribió creyendo lo contrario.
     */
    const prisma = db();
    const { encounter, practitioner } = await anEncounter(prisma);

    await prisma.$executeRawUnsafe(
      `INSERT INTO encounter_vitals
         (encounter_id, weight_kg, height_cm, height_position, recorded_by, bmi)
       VALUES ($1, 68.4, 165, 'STANDING', $2::uuid, 99.99)`,
      encounter.id,
      practitioner.userId,
    );

    const [row] = await prisma.$queryRawUnsafe<{ bmi: string }[]>(
      `SELECT bmi::text AS bmi FROM encounter_vitals WHERE encounter_id = $1`,
      encounter.id,
    );
    expect(Number(row!.bmi)).toBe(25.12);
  });

  it('EN-061 recalcula el IMC cuando se corrige el peso', async () => {
    const prisma = db();
    const { site, encounter, save } = await anEncounter(prisma);
    const query = { encounterId: encounter.id, sites: [site.id] };

    await save(query, { weightKg: 68.4, heightCm: 165 });
    const corrected = await save(query, {
      weightKg: 72,
      heightCm: 165,
    });

    expect(corrected.bmi).toBe(26.45);
  });

  it('EN-061 deja el IMC vacío mientras falte el peso o la talla', async () => {
    const prisma = db();
    const { site, encounter, save } = await anEncounter(prisma);

    const vitals = await save(
      { encounterId: encounter.id, sites: [site.id] },
      { weightKg: 68.4 },
    );

    // `null` is the ROW saying so, not this code deciding it.
    expect(vitals.bmi).toBeNull();
  });

  it('EN-062 rechaza en la BASE un peso de 750 kg, que es el dedo que tecleó 750 en vez de 75', async () => {
    const prisma = db();
    const { site, encounter, save } = await anEncounter(prisma);

    const problem = await problemFrom(
      save(
        { encounterId: encounter.id, sites: [site.id] },
        { weightKg: 750, heightCm: 175 },
      ),
    );

    expect(problem?.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(problem?.code).toBe('VITALS_OUT_OF_RANGE');
  });

  it('EN-062 rechaza una sistólica menor que la diastólica', async () => {
    // Deliberately wide ranges, and this is the one pairing among them: 80/120
    // is not a low blood pressure, it is two boxes filled the wrong way round.
    const prisma = db();
    const { site, encounter, save } = await anEncounter(prisma);

    const problem = await problemFrom(
      save(
        { encounterId: encounter.id, sites: [site.id] },
        { systolicBp: 80, diastolicBp: 120 },
      ),
    );

    expect(problem?.code).toBe('VITALS_OUT_OF_RANGE');
  });

  it('EN-062 admite un valor extremo pero fisiológicamente posible', async () => {
    /**
     * La otra mitad, y es la que evita el `CHECK` demasiado estricto: el
     * comentario de la migración dice que el objetivo es cazar el dedo, «no
     * discutir de fisiología con la clínica». Un prematuro de 800 gramos entra.
     */
    const prisma = db();
    const { site, encounter, save } = await anEncounter(prisma);

    const vitals = await save(
      { encounterId: encounter.id, sites: [site.id] },
      { weightKg: 0.8, heightCm: 32 },
    );

    expect(vitals.weightKg).toBe(0.8);
  });

  describe('EN-062 cada medida tiene su rango, y el rechazo señala su casilla (D-058)', () => {
    type Measure =
      | 'temperatureC'
      | 'heartRate'
      | 'respiratoryRate'
      | 'headCircumferenceCm'
      | 'abdominalCircumferenceCm'
      | 'weightKg'
      | 'heightCm'
      | 'systolicBp'
      | 'diastolicBp'
      | 'oxygenSaturation'
      | 'hemoglobinGDl';

    /**
     * Every bound of `20260930124150_encounter_vitals_ranges_per_measure`,
     * tried on BOTH sides against the real database: the edge is admitted
     * (positive control — a CHECK that refused everything would pass the
     * other half on its own) and the smallest step past it, in the column's
     * own precision, is refused naming the field.
     *
     * The five of D-058 are the reason for this block; the five that already
     * existed are here too because the migration re-created them, and a typo
     * in a re-created bound is exactly what nobody would notice.
     */
    const bounds: {
      field: Measure;
      min: number;
      max: number;
      step: number;
      range: string;
    }[] = [
      { field: 'temperatureC', min: 25, max: 45, step: 0.1, range: 'entre 25 y 45 °C' }, // prettier-ignore
      { field: 'heartRate', min: 20, max: 300, step: 1, range: 'entre 20 y 300 lpm' }, // prettier-ignore
      { field: 'respiratoryRate', min: 4, max: 100, step: 1, range: 'entre 4 y 100 rpm' }, // prettier-ignore
      { field: 'headCircumferenceCm', min: 20, max: 80, step: 0.1, range: 'entre 20 y 80 cm' }, // prettier-ignore
      { field: 'abdominalCircumferenceCm', min: 20, max: 250, step: 0.1, range: 'entre 20 y 250 cm' }, // prettier-ignore
      { field: 'weightKg', min: 0.3, max: 400, step: 0.001, range: 'entre 0.3 y 400 kg' }, // prettier-ignore
      { field: 'heightCm', min: 20, max: 260, step: 0.1, range: 'entre 20 y 260 cm' }, // prettier-ignore
      { field: 'systolicBp', min: 40, max: 300, step: 1, range: 'entre 40 y 300 mmHg' }, // prettier-ignore
      { field: 'diastolicBp', min: 20, max: 200, step: 1, range: 'entre 20 y 200 mmHg' }, // prettier-ignore
      { field: 'oxygenSaturation', min: 30, max: 100, step: 1, range: 'entre 30 y 100 %' }, // prettier-ignore
      // EN-065, con el criterio de D-058.
      { field: 'hemoglobinGDl', min: 1, max: 25, step: 0.1, range: 'entre 1 y 25 g/dl' }, // prettier-ignore
    ];

    /** Rounded to the step so 45 + 0.1 is 45.1 and not 45.100000000000001. */
    const past = (value: number, step: number) =>
      Number(value.toFixed(String(step).split('.')[1]?.length ?? 0));

    for (const { field, min, max, step, range } of bounds) {
      it(`EN-062 admite ${field} en los dos bordes, ${min} y ${max}`, async () => {
        const prisma = db();
        const { site, encounter, save } = await anEncounter(prisma);
        const query = { encounterId: encounter.id, sites: [site.id] };

        for (const edge of [min, max]) {
          const vitals = await save(query, { [field]: edge });
          expect(vitals[field]).toBe(edge);
        }
      });

      for (const [side, value] of [
        ['por debajo', past(min - step, step)],
        ['por encima', past(max + step, step)],
      ] as const) {
        it(`EN-062 rechaza ${field} ${side} del rango (${value}) señalando la casilla`, async () => {
          const prisma = db();
          const { site, encounter, save } = await anEncounter(prisma);

          const problem = await problemFrom(
            save(
              { encounterId: encounter.id, sites: [site.id] },
              { [field]: value },
            ),
          );

          expect(problem?.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
          expect(problem?.code).toBe('VITALS_OUT_OF_RANGE');
          expect(problem?.errors).toEqual([
            {
              field,
              code: 'VITALS_OUT_OF_RANGE',
              message: expect.stringContaining(range) as string,
            },
          ]);
        });
      }
    }

    it('EN-062 señala la sistólica cuando es menor que la diastólica', async () => {
      const prisma = db();
      const { site, encounter, save } = await anEncounter(prisma);

      const problem = await problemFrom(
        save(
          { encounterId: encounter.id, sites: [site.id] },
          { systolicBp: 80, diastolicBp: 120 },
        ),
      );

      expect(problem?.errors?.[0]?.field).toBe('systolicBp');
      expect(problem?.errors?.[0]?.message).toContain(
        'mayor que la diastólica',
      );
    });
  });

  it('EN-067 no crea una segunda toma: la segunda sobreescribe la primera', async () => {
    /**
     * `encounter_vitals.encounter_id` ES la clave primaria, así que la base ya
     * lo garantiza. Se prueba porque tiene una consecuencia que hay que decir
     * en voz alta: NO HAY HISTORIAL de las dos tomas. Para consulta externa es
     * correcto; el día que la clínica monitorice tensión durante una hora hace
     * falta otra tabla.
     */
    const prisma = db();
    const { site, encounter, save, repository } = await anEncounter(prisma);
    const query = { encounterId: encounter.id, sites: [site.id] };

    await save(query, { weightKg: 68.4, heartRate: 72 });
    await save(query, { weightKg: 68.9 });

    await expect(
      prisma.encounterVitals.count({ where: { encounterId: encounter.id } }),
    ).resolves.toBe(1);

    const stored = await repository.findVitals(query);
    expect(stored?.weightKg).toBe(68.9);
    /**
     * ⚠️ Y LA FRECUENCIA CARDIACA DE LA PRIMERA TOMA DESAPARECE, que es lo que
     * un `PUT` significa: la fila describe UNA toma, y conservar el pulso de
     * las 08:10 junto al peso de las 08:40 describiría una medición que nadie
     * hizo.
     */
    expect(stored?.heartRate).toBeUndefined();
  });

  it('EN-060 conserva el instante de la TOMA y no el del tecleo', async () => {
    const prisma = db();
    const { site, encounter, save } = await anEncounter(prisma);
    const measuredAt = new Date('2026-08-14T13:10:00Z');

    const vitals = await save(
      { encounterId: encounter.id, sites: [site.id] },
      { weightKg: 68.4, measuredAt },
    );

    expect(vitals.measuredAt).toEqual(measuredAt);
  });

  it('EN-121 no devuelve los signos de una atención de otra sede', async () => {
    const prisma = db();
    const { site, encounter, save } = await anEncounter(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    const repository = repositoryOf(prisma);

    await save(
      { encounterId: encounter.id, sites: [site.id] },
      { weightKg: 68.4 },
    );

    // Narrowed through the ATTENTION, which is where the site lives: the
    // vitals table has no site of its own.
    await expect(
      repository.findVitals({
        encounterId: encounter.id,
        sites: [otherSite.id],
      }),
    ).resolves.toBeNull();
  });

  it('EN-064 la base rechaza una talla sin su posicion, y acepta la misma talla medida de pie', async () => {
    const prisma = db();
    const { site, encounter, practitioner } = await anEncounter(prisma);
    const repository = repositoryOf(prisma);
    const query = { encounterId: encounter.id, sites: [site.id] };

    // Control positivo: el mismo camino, con la posición, pasa.
    const standing = await repository.saveVitals(
      query,
      { heightCm: 165, heightPosition: 'STANDING' },
      practitioner.userId,
      false,
    );
    expect(standing.heightPosition).toBe('STANDING');

    const problem = await problemFrom(
      repository.saveVitals(
        query,
        { heightCm: 165 },
        practitioner.userId,
        false,
      ),
    );
    expect(problem?.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(problem?.errors?.[0]?.field).toBe('heightPosition');
    expect(problem?.code).toBe('VITALS_HEIGHT_POSITION_REQUIRED');
  });

  it('EN-064 la base rechaza una posicion sin talla: no describe ninguna medida', async () => {
    const prisma = db();
    const { site, encounter, practitioner } = await anEncounter(prisma);

    const problem = await problemFrom(
      repositoryOf(prisma).saveVitals(
        { encounterId: encounter.id, sites: [site.id] },
        { weightKg: 12, heightPosition: 'LYING' },
        practitioner.userId,
        false,
      ),
    );
    expect(problem?.code).toBe('VITALS_HEIGHT_POSITION_REQUIRED');
  });

  it('EN-065 guarda la hemoglobina y la corregida, y la base rechaza la corregida sin la medida', async () => {
    const prisma = db();
    const { site, encounter, save } = await anEncounter(prisma);
    const query = { encounterId: encounter.id, sites: [site.id] };

    const vitals = await save(query, {
      hemoglobinGDl: 12.4,
      hemoglobinCorrectedGDl: 10.9,
    });
    expect(vitals.hemoglobinGDl).toBe(12.4);
    expect(vitals.hemoglobinCorrectedGDl).toBe(10.9);

    const problem = await problemFrom(
      save(query, { hemoglobinCorrectedGDl: 10.9 }),
    );
    expect(problem?.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(problem?.errors?.[0]?.field).toBe('hemoglobinGDl');
  });

  it('EN-165 la base rechaza una corregida mayor que la medida, señalando la corregida, y acepta igual o menor', async () => {
    // D-062, punto 3 B: the WHO adjustment only ever subtracts. A corrected
    // value above the measured one is the two figures typed the wrong way
    // round, which in Quito hides an anaemia.
    const prisma = db();
    const { site, encounter, save } = await anEncounter(prisma);
    const query = { encounterId: encounter.id, sites: [site.id] };

    await expect(
      save(query, { hemoglobinGDl: 12.4, hemoglobinCorrectedGDl: 12.4 }),
    ).resolves.toMatchObject({ hemoglobinCorrectedGDl: 12.4 });
    await expect(
      save(query, { hemoglobinGDl: 12.4, hemoglobinCorrectedGDl: 10.9 }),
    ).resolves.toMatchObject({ hemoglobinCorrectedGDl: 10.9 });

    const problem = await problemFrom(
      save(query, { hemoglobinGDl: 10.9, hemoglobinCorrectedGDl: 12.4 }),
    );
    expect(problem?.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(problem?.code).toBe('VITALS_OUT_OF_RANGE');
    expect(problem?.errors?.[0]?.field).toBe('hemoglobinCorrectedGDl');
    expect(problem?.errors?.[0]?.message).toMatch(/al revés/);

    // Nothing of the refused taking was kept: the accepted one stands.
    const stored = await prisma.encounterVitals.findUniqueOrThrow({
      where: { encounterId: encounter.id },
    });
    expect(stored.hemoglobinGDl?.toString()).toBe('12.4');
    expect(stored.hemoglobinCorrectedGDl?.toString()).toBe('10.9');
  });

  it('EN-065 rechaza en la base una hemoglobina de 115, que es 11.5 sin la coma', async () => {
    const prisma = db();
    const { site, encounter, save } = await anEncounter(prisma);
    const query = { encounterId: encounter.id, sites: [site.id] };

    await expect(save(query, { hemoglobinGDl: 11.5 })).resolves.toMatchObject({
      hemoglobinGDl: 11.5,
    });
    const problem = await problemFrom(save(query, { hemoglobinGDl: 115 }));
    expect(problem?.code).toBe('VITALS_OUT_OF_RANGE');
    expect(problem?.errors?.[0]?.field).toBe('hemoglobinGDl');
  });

  it('EN-143 corregir no es tomar: el autor y la hora de la toma se quedan, y el que corrige va aparte', async () => {
    const prisma = db();
    const { site, encounter, practitioner } = await anEncounter(prisma);
    const nurse = await createUser(prisma);
    const repository = repositoryOf(prisma);
    const query = { encounterId: encounter.id, sites: [site.id] };
    const takenAt = new Date(Date.now() - 3_600_000);

    const taken = await repository.saveVitals(
      query,
      { weightKg: 68, measuredAt: takenAt },
      nurse.id,
      false,
    );
    expect(taken.recordedBy).toEqual({ id: nurse.id, name: 'Carmen Salazar' });
    expect(taken.correctedBy).toBeNull();

    // El médico rehace sólo la temperatura, sin decir una hora nueva.
    const corrected = await repository.saveVitals(
      query,
      { weightKg: 68, temperatureC: 37.2 },
      practitioner.userId,
      false,
    );

    expect(corrected.recordedBy?.id).toBe(nurse.id);
    expect(corrected.measuredAt).toEqual(takenAt);
    expect(corrected.correctedBy?.id).toBe(practitioner.userId);
    expect(corrected.correctedAt).not.toBeNull();
  });

  it('EN-143 la base rechaza cambiar el autor de una toma, y una toma sin autor', async () => {
    const prisma = db();
    const { encounter, practitioner } = await anEncounter(prisma);
    const other = await createUser(prisma);

    // Control positivo: la toma con autor entra, y corregir una cifra también.
    await prisma.$executeRawUnsafe(
      `INSERT INTO encounter_vitals (encounter_id, weight_kg, recorded_by)
       VALUES ($1, 68, $2::uuid)`,
      encounter.id,
      practitioner.userId,
    );
    // EN-210: a correction says who and when (`record_version_archive`).
    await prisma.$executeRawUnsafe(
      `UPDATE encounter_vitals
          SET weight_kg = 69, corrected_by = $2::uuid, corrected_at = $3
        WHERE encounter_id = $1`,
      encounter.id,
      other.id,
      new Date(),
    );

    await expect(
      prisma.$executeRawUnsafe(
        // Stamped, so the only rule left to refuse it is the author's.
        `UPDATE encounter_vitals
            SET recorded_by = $2::uuid, corrected_by = $2::uuid, corrected_at = $3
          WHERE encounter_id = $1`,
        encounter.id,
        other.id,
        new Date(Date.now() + 60_000),
      ),
    ).rejects.toThrow(/cannot change once written/);

    const second = await anEncounter(prisma);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO encounter_vitals (encounter_id, weight_kg) VALUES ($1, 68)`,
        second.encounter.id,
      ),
    ).rejects.toThrow(/encounter_vitals_names_its_author/);
  });

  it('EN-143 una toma anterior a la columna se corrige sin inventarle autor', async () => {
    const prisma = db();
    const { site, encounter, practitioner } = await anEncounter(prisma);
    // Una fila como las de antes de la migración: sin autor. Se recrea el
    // pasado quitando la comprobación un instante, en una transacción.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `SET LOCAL session_replication_role = 'replica'`,
      ),
      prisma.$executeRawUnsafe(
        `ALTER TABLE encounter_vitals DROP CONSTRAINT encounter_vitals_names_its_author`,
      ),
      prisma.$executeRawUnsafe(
        `INSERT INTO encounter_vitals (encounter_id, weight_kg) VALUES ($1::uuid, 68)`,
        encounter.id,
      ),
      prisma.$executeRawUnsafe(
        `ALTER TABLE encounter_vitals ADD CONSTRAINT encounter_vitals_names_its_author
           CHECK (recorded_by IS NOT NULL OR corrected_by IS NOT NULL) NOT VALID`,
      ),
    ]);

    const corrected = await repositoryOf(prisma).saveVitals(
      { encounterId: encounter.id, sites: [site.id] },
      { weightKg: 68.5 },
      practitioner.userId,
      false,
    );

    expect(corrected.recordedBy).toBeNull();
    expect(corrected.correctedBy?.id).toBe(practitioner.userId);
  });

  it('EN-163 la base rechaza un motivo en blanco', async () => {
    const prisma = db();
    const { encounter, practitioner } = await anEncounter(prisma);

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO encounter_vitals (encounter_id, recorded_by, presenting_complaint)
         VALUES ($1::uuid, $2::uuid, '   ')`,
        encounter.id,
        practitioner.userId,
      ),
    ).rejects.toThrow(/encounter_vitals_presenting_complaint_not_blank/);
  });

  it('EN-163 guarda con la toma el motivo en palabras del paciente', async () => {
    const prisma = db();
    const { site, encounter, save } = await anEncounter(prisma);

    const vitals = await save(
      { encounterId: encounter.id, sites: [site.id] },
      {
        weightKg: 68,
        presentingComplaint: 'Me duele la cabeza hace tres días',
      },
    );

    expect(vitals.presentingComplaint).toBe(
      'Me duele la cabeza hace tres días',
    );
  });

  it('EN-068 expone los signos de las atenciones anteriores del paciente, de la mas reciente a la mas antigua, incluidas las de la ficha absorbida', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const survivor = await createPatient(prisma);
    const absorbed = await createPatient(prisma);
    const repository = repositoryOf(prisma);
    const day = 86_400_000;
    const now = Date.now();

    /** An attention `daysAgo` days back, on `patientId`, weighing `weightKg`. */
    const takenOn = async (
      patientId: string,
      daysAgo: number,
      weightKg: number,
    ) => {
      const encounter = await repository.open({
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId,
        startedAt: new Date(now - daysAgo * day),
        careModality: 'MORBIDITY',
        careSetting: 'INTRAMURAL',
        visitSequence: 'SUBSEQUENT',
      });
      await repository.saveVitals(
        { encounterId: encounter.id, sites: [site.id] },
        { weightKg },
        practitioner.userId,
        false,
      );
      return encounter;
    };

    await takenOn(absorbed.id, 60, 72);
    await takenOn(survivor.id, 30, 70);
    const today = await takenOn(survivor.id, 0, 68);
    await prisma.patient.update({
      where: { id: absorbed.id },
      data: { mergedIntoId: survivor.id, mergedAt: new Date(now) },
    });

    const previous = await new PrismaChartSummaryRepository(
      prisma as unknown as PrismaService,
    ).previousEncounters({
      patientId: survivor.id,
      sites: [site.id],
      excludeEncounterId: today.id,
      limit: 5,
    });

    // Cuatro kilos en dos meses: el dato que un peso suelto no dice.
    expect(previous.map((encounter) => encounter.vitals?.weightKg)).toEqual([
      70, 72,
    ]);
  });

  it('EN-211 devuelve las tomas sustituidas, la más reciente primero, con quién y cuándo las sustituyó', async () => {
    const prisma = db();
    const { site, encounter, practitioner, repository, save } =
      await anEncounter(prisma);
    const query = { encounterId: encounter.id, sites: [site.id] };

    // Control positivo: sin correcciones no hay versiones, y la lectura entra.
    await save(query, { weightKg: 68 });
    expect(await repository.findVitalsVersions(query)).toEqual([]);

    await save(query, { weightKg: 69 });
    await save(query, { weightKg: 70, temperatureC: 37.5 });

    const versions = await repository.findVitalsVersions(query);
    expect(versions.map((v) => [v.version, v.taking.weightKg])).toEqual([
      [2, 69],
      [1, 68],
    ]);
    expect(versions[0]!.replacedBy.id).toBe(practitioner.userId);
    expect(versions[0]!.replacedBy.name).not.toBe('');
    expect(versions[0]!.replacedAt.getTime()).toBeGreaterThan(
      versions[1]!.replacedAt.getTime(),
    );
    // The taking replaced keeps its own author and instant (EN-143), and is
    // read through the same mapping as the current one.
    const current = await repository.findVitals(query);
    expect(versions[1]!.taking.recordedBy?.id).toBe(practitioner.userId);
    expect(versions[1]!.taking.measuredAt).toEqual(current!.measuredAt);
    expect(versions[1]!.taking.temperatureC).toBeUndefined();
    expect(versions[1]!.taking.correctedBy).toBeNull();
    expect(versions[0]!.taking.correctedBy?.id).toBe(practitioner.userId);
  });

  it('EN-210 una corrección que cae en el mismo instante que la anterior recibe su propio sello', async () => {
    const prisma = db();
    const { site, encounter, practitioner, repository, save } =
      await anEncounter(prisma);
    const query = { encounterId: encounter.id, sites: [site.id] };
    await save(query, { weightKg: 68 });
    // The previous correction stamped AHEAD of the clock of this save: the
    // case of two saves in the same millisecond, made deterministic.
    const ahead = new Date(Date.now() + 60_000);
    await prisma.$executeRawUnsafe(
      `UPDATE encounter_vitals
          SET corrected_by = $2::uuid, corrected_at = $3
        WHERE encounter_id = $1`,
      encounter.id,
      practitioner.userId,
      ahead,
    );

    const saved = await save(query, { weightKg: 69 });

    expect(saved.weightKg).toBe(69);
    expect(new Date(saved.correctedAt!).getTime()).toBe(ahead.getTime() + 1);
    expect(await repository.findVitalsVersions(query)).toHaveLength(2);
  });

  it('EN-211 no enseña las versiones de una atención de otra sede', async () => {
    const prisma = db();
    const { site, encounter, save, repository } = await anEncounter(prisma);
    await save(
      { encounterId: encounter.id, sites: [site.id] },
      { weightKg: 68 },
    );
    await save(
      { encounterId: encounter.id, sites: [site.id] },
      { weightKg: 69 },
    );
    const elsewhere = await createSite(prisma, 'Sede Norte');

    // Control positivo: desde su sede, la versión está.
    expect(
      await repository.findVitalsVersions({
        encounterId: encounter.id,
        sites: [site.id],
      }),
    ).toHaveLength(1);
    expect(
      await repository.findVitalsVersions({
        encounterId: encounter.id,
        sites: [elsewhere.id],
      }),
    ).toEqual([]);
  });
  /**
   * EN-217, D-134.3. A discharged attention signed its 002 with the mandatory
   * anthropometry (EN-063); a later correction of the taking cannot take it
   * away again. The adapter refuses it under the attention's lock, and the
   * database refuses whatever walks past the adapter.
   */
  describe('EN-217 D-134.3 corregir la toma tras el alta no deja pendiente la antropometría obligatoria', () => {
    async function aDischargedUnderFive(prisma: PrismaClient) {
      const site = await createSite(prisma);
      const practitioner = await createPractitioner(prisma);
      const startedAt = new Date(Date.now() - 2 * 3_600_000);
      const patient = await createPatient(prisma, {
        // Two years before the attention: under five on its clinical date.
        birthDate: new Date(
          Date.UTC(startedAt.getUTCFullYear() - 2, startedAt.getUTCMonth(), 1),
        ),
      });
      const encounter = await repositoryOf(prisma).open({
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        startedAt,
        careModality: 'MORBIDITY',
        careSetting: 'INTRAMURAL',
        visitSequence: 'FIRST_TIME',
      });
      const query = { encounterId: encounter.id, sites: [site.id] };
      // EN-228. The practitioner signs history here: they may correct after.
      const { save } = recordedBy(prisma, practitioner.userId, true);
      await save(query, {
        weightKg: 12.1,
        heightCm: 86,
        headCircumferenceCm: 48,
        temperatureC: 37.8,
      });
      await prisma.encounter.update({
        where: { id: encounter.id },
        data: {
          status: 'DISCHARGED',
          endedAt: new Date(),
          dischargeCondition: 'ALIVE',
        },
      });
      return { encounter, query, practitioner, save };
    }

    it('EN-217 D-134.3 el adaptador corrige la temperatura conservando peso y talla, y rechaza dejar sin peso con ANTHROPOMETRY_PENDING', async () => {
      const prisma = db();
      const { encounter, query, save } = await aDischargedUnderFive(prisma);

      // Positive control: the same path, the measures kept.
      const corrected = await save(query, {
        weightKg: 12.1,
        heightCm: 86,
        headCircumferenceCm: 48,
        temperatureC: 37.1,
      });
      expect(corrected.temperatureC).toBe(37.1);

      await expect(
        save(query, {
          heightCm: 86,
          headCircumferenceCm: 48,
          temperatureC: 37,
        }),
      ).rejects.toMatchObject({
        code: 'ANTHROPOMETRY_PENDING',
        fieldErrors: [expect.objectContaining({ field: 'weightKg' })],
      });
      const stored = await prisma.encounterVitals.findUniqueOrThrow({
        where: { encounterId: encounter.id },
      });
      expect(Number(stored.weightKg)).toBe(12.1);
      expect(Number(stored.temperatureC)).toBe(37.1);
    });

    it('EN-228 el adaptador vuelve a preguntar bajo el candado: tras el alta rechaza a quien no firma historia en la sede, sin tocar la toma', async () => {
      const prisma = db();
      const { encounter, query, practitioner } =
        await aDischargedUnderFive(prisma);
      const nurse = await createUser(prisma);
      const correction = {
        weightKg: 12.1,
        heightCm: 86,
        heightPosition: 'STANDING' as const,
        headCircumferenceCm: 48,
        temperatureC: 36.6,
      };

      await expect(
        repositoryOf(prisma).saveVitals(query, correction, nurse.id, false),
      ).rejects.toMatchObject({ code: 'VITALS_CORRECTION_REQUIRES_SIGNATURE' });
      const untouched = await prisma.encounterVitals.findUniqueOrThrow({
        where: { encounterId: encounter.id },
      });
      expect(Number(untouched.temperatureC)).toBe(37.8);
      expect(untouched.correctedById).toBeNull();

      // Positive control: the same correction by whoever may sign here.
      const corrected = await repositoryOf(prisma).saveVitals(
        query,
        correction,
        practitioner.userId,
        true,
      );
      expect(corrected.temperatureC).toBe(36.6);
    });

    it('EN-217 D-134.3 la BASE rechaza la corrección que deja sin peso a una atención con alta, y no la que conserva las medidas', async () => {
      const prisma = db();
      const { encounter, practitioner } = await aDischargedUnderFive(prisma);
      const correct = (column: 'temperature_c' | 'weight_kg', value: number | null, at: Date) =>
        prisma.$executeRawUnsafe(
          `UPDATE encounter_vitals
              SET ${column} = $2, corrected_by = $3::uuid, corrected_at = $4
            WHERE encounter_id = $1::uuid`,
          encounter.id,
          value,
          practitioner.userId,
          at,
        ); // prettier-ignore

      // Positive control: a stamped correction that keeps the measures.
      await correct('temperature_c', 36.9, new Date(Date.now() + 60_000));

      const problem = await problemFrom(
        correct('weight_kg', null, new Date(Date.now() + 120_000)),
      );
      expect(problem).toMatchObject({ code: 'ANTHROPOMETRY_PENDING' });
      const stored = await prisma.encounterVitals.findUniqueOrThrow({
        where: { encounterId: encounter.id },
      });
      expect(Number(stored.weightKg)).toBe(12.1);
    });
  });
});
