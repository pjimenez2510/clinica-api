import { HttpStatus } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaEncounterRepository } from '../../src/modules/encounter/infrastructure/prisma-encounter.repository';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';
import '../../src/modules/encounter/infrastructure/encounter.constraints';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
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

  return { site, practitioner, patient, encounter };
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
    const { site, encounter } = await anEncounter(prisma);

    const vitals = await repositoryOf(prisma).saveVitals(
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
    const { encounter } = await anEncounter(prisma);

    await prisma.$executeRawUnsafe(
      `INSERT INTO encounter_vitals (encounter_id, weight_kg, height_cm, bmi)
       VALUES ($1, 68.4, 165, 99.99)`,
      encounter.id,
    );

    const [row] = await prisma.$queryRawUnsafe<{ bmi: string }[]>(
      `SELECT bmi::text AS bmi FROM encounter_vitals WHERE encounter_id = $1`,
      encounter.id,
    );
    expect(Number(row!.bmi)).toBe(25.12);
  });

  it('EN-061 recalcula el IMC cuando se corrige el peso', async () => {
    const prisma = db();
    const { site, encounter } = await anEncounter(prisma);
    const repository = repositoryOf(prisma);
    const query = { encounterId: encounter.id, sites: [site.id] };

    await repository.saveVitals(query, { weightKg: 68.4, heightCm: 165 });
    const corrected = await repository.saveVitals(query, {
      weightKg: 72,
      heightCm: 165,
    });

    expect(corrected.bmi).toBe(26.45);
  });

  it('EN-061 deja el IMC vacío mientras falte el peso o la talla', async () => {
    const prisma = db();
    const { site, encounter } = await anEncounter(prisma);

    const vitals = await repositoryOf(prisma).saveVitals(
      { encounterId: encounter.id, sites: [site.id] },
      { weightKg: 68.4 },
    );

    // `null` is the ROW saying so, not this code deciding it.
    expect(vitals.bmi).toBeNull();
  });

  it('EN-062 rechaza en la BASE un peso de 750 kg, que es el dedo que tecleó 750 en vez de 75', async () => {
    const prisma = db();
    const { site, encounter } = await anEncounter(prisma);

    const problem = await problemFrom(
      repositoryOf(prisma).saveVitals(
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
    const { site, encounter } = await anEncounter(prisma);

    const problem = await problemFrom(
      repositoryOf(prisma).saveVitals(
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
    const { site, encounter } = await anEncounter(prisma);

    const vitals = await repositoryOf(prisma).saveVitals(
      { encounterId: encounter.id, sites: [site.id] },
      { weightKg: 0.8, heightCm: 32 },
    );

    expect(vitals.weightKg).toBe(0.8);
  });

  describe('EN-062 cada medida tiene su rango, y el rechazo señala su casilla (D-058)', () => {
    type Vitals = Parameters<PrismaEncounterRepository['saveVitals']>[1];
    type Measure = Exclude<keyof Vitals, 'measuredAt'>;

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
    ];

    /** Rounded to the step so 45 + 0.1 is 45.1 and not 45.100000000000001. */
    const past = (value: number, step: number) =>
      Number(value.toFixed(String(step).split('.')[1]?.length ?? 0));

    for (const { field, min, max, step, range } of bounds) {
      it(`EN-062 admite ${field} en los dos bordes, ${min} y ${max}`, async () => {
        const prisma = db();
        const { site, encounter } = await anEncounter(prisma);
        const repository = repositoryOf(prisma);
        const query = { encounterId: encounter.id, sites: [site.id] };

        for (const edge of [min, max]) {
          const vitals = await repository.saveVitals(query, { [field]: edge });
          expect(vitals[field]).toBe(edge);
        }
      });

      for (const [side, value] of [
        ['por debajo', past(min - step, step)],
        ['por encima', past(max + step, step)],
      ] as const) {
        it(`EN-062 rechaza ${field} ${side} del rango (${value}) señalando la casilla`, async () => {
          const prisma = db();
          const { site, encounter } = await anEncounter(prisma);

          const problem = await problemFrom(
            repositoryOf(prisma).saveVitals(
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
      const { site, encounter } = await anEncounter(prisma);

      const problem = await problemFrom(
        repositoryOf(prisma).saveVitals(
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
    const { site, encounter } = await anEncounter(prisma);
    const repository = repositoryOf(prisma);
    const query = { encounterId: encounter.id, sites: [site.id] };

    await repository.saveVitals(query, { weightKg: 68.4, heartRate: 72 });
    await repository.saveVitals(query, { weightKg: 68.9 });

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
    const { site, encounter } = await anEncounter(prisma);
    const measuredAt = new Date('2026-08-14T13:10:00Z');

    const vitals = await repositoryOf(prisma).saveVitals(
      { encounterId: encounter.id, sites: [site.id] },
      { weightKg: 68.4, measuredAt },
    );

    expect(vitals.measuredAt).toEqual(measuredAt);
  });

  it('EN-121 no devuelve los signos de una atención de otra sede', async () => {
    const prisma = db();
    const { site, encounter } = await anEncounter(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    const repository = repositoryOf(prisma);

    await repository.saveVitals(
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
});
