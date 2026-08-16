import { PrismaClient } from '@prisma/client';
import { describe, expect, inject, it } from 'vitest';

import { createPgAdapter } from '../../src/shared/infrastructure/prisma/pg-adapter';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * The clinical date is the date in Ecuador, not the date on the server.
 *
 * These tests exist because the original suite could not have caught the bug:
 * every fixture used UTC "so the assertion does not depend on the host", and
 * the container also runs in UTC. The two agreed, so nothing ever disagreed.
 *
 * The instant used throughout is 02:00Z, which is 21:00 the previous day in
 * Guayaquil — an ordinary evening consultation, not a contrived edge case.
 */
describe('clinical date is resolved in Ecuador', () => {
  const db = useDatabase();

  /** 21:00 on 13 September in Guayaquil. */
  const EVENING_CONSULTATION = new Date('2026-09-14T02:00:00Z');

  async function encounterFor(birthDate: Date) {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma, { birthDate });

    return prisma.encounter.create({
      data: {
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        startedAt: EVENING_CONSULTATION,
        careModality: 'MORBIDITY',
        visitSequence: 'FIRST_TIME',
      },
    });
  }

  it('freezes a newborn age against the local date, not the UTC one', async () => {
    // Born on the 13th, seen at 21:00 on the 13th: zero days old. Reading the
    // instant as UTC made it the 14th and recorded one day — and `age_days` is
    // what the RDACAA uses to classify neonates.
    const encounter = await encounterFor(new Date('2026-09-13'));

    expect(encounter.ageDays).toBe(0);
    expect(encounter.ageYears).toBe(0);
    expect(encounter.ageMonths).toBe(0);
  });

  it('gives the same age whatever the session time zone', async () => {
    // The real guarantee: the result cannot depend on how the container, the
    // cloud provider or a psql session happens to be configured.
    const prisma = db();
    const first = await encounterFor(new Date('2026-09-13'));

    await prisma.$executeRawUnsafe(`SET TimeZone = 'Asia/Tokyo'`);
    try {
      const second = await encounterFor(new Date('2026-09-13'));
      expect(second.ageDays).toBe(first.ageDays);
    } finally {
      await prisma.$executeRawUnsafe(`SET TimeZone = 'UTC'`);
    }
  });

  it('REFUSES an encounter that precedes the birth, judged locally', async () => {
    // Born on the 14th, consultation at 21:00 on the 13th local time. Under
    // UTC the instant reads as the 14th and this was accepted.
    await expect(encounterFor(new Date('2026-09-14'))).rejects.toThrow(
      /before the patient was born/,
    );
  });

  it('accepts a birth on the same local day as the consultation', async () => {
    // The boundary the guard must NOT reject: a baby born and seen the same
    // evening. This is the common case in an obstetric clinic.
    const encounter = await encounterFor(new Date('2026-09-13'));
    expect(encounter.id).toBeTruthy();
  });

  it('computes a whole age correctly for an adult', async () => {
    // 15 March 1990 to 13 September 2026: 36 years, 5 months, 29 days.
    const encounter = await encounterFor(new Date('1990-03-15'));

    expect(encounter.ageYears).toBe(36);
    expect(encounter.ageMonths).toBe(5);
    expect(encounter.ageDays).toBe(29);
  });

  it('keeps a diagnosis valid on the last local day of a CIE-10 code', async () => {
    // A code in force until 14 September, used at 21:00 on the 13th. Read as
    // UTC the encounter fell on the 14th — outside the half-open range — and a
    // perfectly valid diagnosis was rejected.
    const prisma = db();
    const encounter = await encounterFor(new Date('1990-03-15'));
    const system = await prisma.catalogSystem.create({
      data: { code: 'CIE10', name: 'CIE-10 Ecuador' },
    });
    const concept = await prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code: 'J00',
        display: 'Rinofaringitis aguda',
        validFrom: new Date('2020-01-01'),
        validTo: new Date('2026-09-14'),
      },
    });

    const diagnosis = await prisma.encounterDiagnosis.create({
      data: {
        encounterId: encounter.id,
        conceptId: concept.id,
        cie10Code: 'J00',
        cie10Display: 'Rinofaringitis aguda',
        certainty: 'DEFINITIVE',
        occurrence: 'FIRST_TIME',
      },
    });

    expect(diagnosis.id).toBeTruthy();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EL INSTANTE QUE SE GUARDA NO PUEDE DEPENDER DE CÓMO ESTÉ CONFIGURADO EL
 * SERVIDOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo encontró la prueba de la métrica de inasistencia (E6) preguntando dos
 * veces por el mismo rango bajo dos husos de sesión distintos y recibiendo dos
 * respuestas.
 *
 * LA CAUSA ESTÁ EN EL DRIVER, no en este código: `@prisma/adapter-pg`
 * serializa un `Date` con las partes UTC y SIN sufijo de zona
 * (`'2026-06-30 05:00:00'`), y PostgreSQL resuelve un literal así con el
 * `TimeZone` DE LA SESIÓN. Toda la pila daba por supuesto que la sesión es
 * UTC, y lo era por casualidad —el contenedor y la configuración por defecto
 * lo son—. Un `postgresql.conf` con otra zona, un `ALTER DATABASE … SET
 * TimeZone` o un proveedor gestionado con su propio valor bastan para mover
 * TODOS los instantes clínicos de la base, en silencio y sin error.
 *
 * `createPgAdapter` lo fija en el arranque de cada conexión. Esta prueba pone
 * la base en el peor caso posible y abre una conexión nueva, que es la forma
 * exacta en que el fallo llega a producción.
 */
describe('el instante almacenado es independiente del huso del servidor', () => {
  const db = useDatabase();

  /** 19:30 del 29 de junio en Guayaquil. La tarde, que es donde duele. */
  const EVENING = new Date('2026-06-30T00:30:00Z');

  it('AG-001 guarda y compara el mismo instante con la base en otro huso', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);

    // La URL del contenedor de `global-setup.ts`, y el nombre de la base leído
    // de ella: escribirlo a mano dejaría la prueba en verde contra otra base.
    const databaseUrl = inject('databaseUrl');
    const databaseName = new URL(databaseUrl).pathname.slice(1);

    // El peor caso: la zona por defecto de la BASE, que toda conexión nueva
    // hereda. Un `SET` suelto solo tocaría una conexión del pool.
    await prisma.$executeRawUnsafe(
      `ALTER DATABASE ${databaseName} SET TimeZone = 'Asia/Tokyo'`,
    );

    // Una conexión NUEVA, construida como la construye la aplicación.
    const hostile = new PrismaClient({ adapter: createPgAdapter(databaseUrl) });
    try {
      await hostile.$connect();

      const entry = await hostile.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startsAt: EVENING,
          endsAt: new Date(EVENING.getTime() + 20 * 60_000),
          bookingChannel: 'PHONE',
        },
      });

      // Ida: el instante escrito es el instante que se pidió escribir.
      expect(entry.startsAt.toISOString()).toBe(EVENING.toISOString());

      // Y vuelta: una comparación de rango encuentra la fila donde debe. Sin
      // fijar la zona, la ventana viajaba nueve horas y la cita caía fuera.
      const inside = await hostile.agendaEntry.count({
        where: {
          startsAt: {
            gte: new Date('2026-06-01T05:00:00Z'),
            lt: new Date('2026-06-30T05:00:00Z'),
          },
        },
      });
      expect(inside).toBe(1);

      // Y el texto que la base guarda de verdad, leído sin intermediarios.
      const [stored] = await hostile.$queryRaw<{ utc: string }[]>`
        SELECT (starts_at AT TIME ZONE 'UTC')::text AS utc
        FROM agenda_entry WHERE id = ${entry.id}::uuid`;
      expect(stored?.utc).toBe('2026-06-30 00:30:00');
    } finally {
      await hostile.$disconnect();
      await prisma.$executeRawUnsafe(
        `ALTER DATABASE ${databaseName} RESET TimeZone`,
      );
    }
  });
});
