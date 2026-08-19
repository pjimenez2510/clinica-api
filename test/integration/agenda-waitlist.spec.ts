import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * What the DATABASE guarantees about the waiting list (E5, AG-060 a AG-067).
 *
 * Migration `20260819125906_agenda_waitlist_contact_trail`. No service, no DTO
 * and no route exist yet: this file is the whole proof that the guarantees the
 * migration claims are real, and it talks to PostgreSQL because nothing else
 * can tell a trigger that exists from one that was meant to.
 *
 * WHAT IS DELIBERATELY NOT HERE. AG-061 (which candidates are proposed and in
 * what order), AG-065 and AG-066 (marking an entry EXPIRED) and the reading
 * half of AG-067 (a listing must filter the closed ones) are acts somebody has
 * to perform, not shapes a row can have. They belong to the tranche that
 * writes the service, and no constraint can stand in for them.
 */
const db = useDatabase();

let sequence = 0;
function next(): string {
  sequence += 1;
  return String(sequence).padStart(6, '0');
}

/** The receptionist who makes the calls. Only her identity matters here. */
async function createUser(prisma: PrismaClient) {
  return prisma.user.create({
    data: {
      email: `recepcion${next()}@clinica.ec`,
      passwordHash: 'not-a-real-hash',
      firstName: 'Lucía',
      lastName: 'Andrade',
    },
  });
}

async function waitingContext() {
  const prisma = db();
  const [site, patient, receptionist] = await Promise.all([
    createSite(prisma),
    createPatient(prisma),
    createUser(prisma),
  ]);
  return { prisma, site, patient, receptionist };
}

/** An entry that waits: the shape AG-060 describes, with nothing optional set. */
async function inscribe(
  prisma: PrismaClient,
  ids: { patientId: string; siteId: string },
) {
  return prisma.waitlistEntry.create({
    data: {
      ...ids,
      preferredFrom: new Date('2026-09-01'),
      preferredTo: new Date('2026-09-30'),
    },
  });
}

/** The freed slot, once it has been given to somebody. */
async function anAppointmentFor(
  prisma: PrismaClient,
  ids: { siteId: string; patientId: string },
) {
  const practitioner = await createPractitioner(prisma);
  return prisma.agendaEntry.create({
    data: {
      kind: 'APPOINTMENT',
      bookingChannel: 'PHONE',
      practitionerId: practitioner.id,
      startsAt: new Date(Date.UTC(2026, 8, 14, 9, 0)),
      endsAt: new Date(Date.UTC(2026, 8, 14, 10, 0)),
      ...ids,
    },
  });
}

async function rejectionOf(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the database was expected to reject this operation');
}

async function columnsOf(
  prisma: PrismaClient,
  table: string,
): Promise<string[]> {
  const columns = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}
     ORDER BY column_name
  `;
  return columns.map((column) => column.column_name);
}

describe('waitlist entry invariants (migration 20260819125906)', () => {
  describe('AG-060 · lo que una inscripción es', () => {
    it('AG-060 admite una entrada con sede, paciente y rango de fechas preferido', async () => {
      const { prisma, site, patient } = await waitingContext();

      const entry = await inscribe(prisma, {
        patientId: patient.id,
        siteId: site.id,
      });

      expect(entry.id).toBeTruthy();
      expect(entry.status).toBe('WAITING');
      // Profesional y tipo de servicio son lo ÚNICO opcional de AG-060.
      expect(entry.practitionerId).toBeNull();
      expect(entry.serviceTypeConceptId).toBeNull();
    });

    /**
     * Por SQL crudo y no por el cliente de Prisma: el tipo generado ya no deja
     * omitir las dos fechas, y lo que hay que demostrar es que la BASE las
     * exige — una importación o un `psql` no pasan por TypeScript.
     *
     * Sin fecha máxima, AG-065 («CUANDO la fecha preferida máxima quede en el
     * pasado, márquela EXPIRED») no se cumple nunca y la entrada compite por
     * cada cupo de la sede para siempre.
     */
    it('AG-060 rechaza una entrada sin rango de fechas preferido', async () => {
      const { prisma, site, patient } = await waitingContext();

      const rejection = await rejectionOf(
        prisma.$executeRaw`
          INSERT INTO waitlist_entry (patient_id, site_id, preferred_from)
          VALUES (${patient.id}::uuid, ${site.id}::uuid, DATE '2026-09-01')
        `,
      );

      expect(rejection.message).toMatch(/preferred_to/);
      expect(rejection.message).toMatch(/null/i);
    });

    it('AG-060 rechaza un rango de fechas preferido invertido', async () => {
      const { prisma, site, patient } = await waitingContext();

      const rejection = await rejectionOf(
        prisma.waitlistEntry.create({
          data: {
            patientId: patient.id,
            siteId: site.id,
            preferredFrom: new Date('2026-09-30'),
            preferredTo: new Date('2026-09-01'),
          },
        }),
      );

      expect(rejection.message).toMatch(/waitlist_entry_preferred_range_valid/);
    });

    it('AG-060 admite un rango de un solo día', async () => {
      const { prisma, site, patient } = await waitingContext();

      // Inclusivo por los dos lados, como `patient_priority_group_period_valid`:
      // «sólo puedo el 3» es un rango legítimo.
      const entry = await prisma.waitlistEntry.create({
        data: {
          patientId: patient.id,
          siteId: site.id,
          preferredFrom: new Date('2026-09-03'),
          preferredTo: new Date('2026-09-03'),
        },
      });

      expect(entry.id).toBeTruthy();
    });
  });

  describe('AG-062 · la prioridad no se congela', () => {
    /**
     * La tabla guardaba `priority smallint DEFAULT 5`, y con eso una mujer que
     * ya dio a luz seguiría siendo prioridad 1 para siempre y el adolescente
     * que cumple 18 también — el defecto que PA-036 existe para evitar,
     * reintroducido en otra tabla y peor, porque aquí el dato caducado no se
     * muestra: ordena una cola.
     *
     * La prueba se hace contra `information_schema` y no contra el modelo de
     * Prisma por lo mismo que la de CF-063: la columna la crea una migración, y
     * una migración puede añadir lo que `schema.prisma` no menciona.
     */
    it('AG-062 no almacena la prioridad: se deriva de los grupos vigentes (PA-041)', async () => {
      const prisma = db();

      expect(await columnsOf(prisma, 'waitlist_entry')).toEqual([
        'converted_entry_id',
        'created_at',
        'id',
        'patient_id',
        'practitioner_id',
        'preferred_from',
        'preferred_to',
        'service_type_concept_id',
        'site_id',
        'status',
        'updated_at',
      ]);
    });
  });

  describe('AG-064 · cada intento, con su instante y su autor', () => {
    it('AG-064 registra cada intento con su instante, su autor y su resultado', async () => {
      const { prisma, site, patient, receptionist } = await waitingContext();
      const entry = await inscribe(prisma, {
        patientId: patient.id,
        siteId: site.id,
      });
      const other = await createUser(prisma);

      await prisma.waitlistContactAttempt.create({
        data: {
          waitlistEntryId: entry.id,
          recordedById: receptionist.id,
          outcome: 'NO_ANSWER',
          attemptedAt: new Date('2026-08-17T14:05:00Z'),
        },
      });
      await prisma.waitlistContactAttempt.create({
        data: {
          waitlistEntryId: entry.id,
          recordedById: other.id,
          outcome: 'DECLINED',
          attemptedAt: new Date('2026-08-18T09:30:00Z'),
        },
      });

      const trail = await prisma.waitlistContactAttempt.findMany({
        where: { waitlistEntryId: entry.id },
        orderBy: { attemptedAt: 'asc' },
      });

      // Lo que el contador no podía contestar: cuándo fue el PRIMERO y quién
      // llamó. Con `contact_attempts = 2` esta aserción no se puede escribir.
      expect(trail).toHaveLength(2);
      expect(trail[0]?.attemptedAt.toISOString()).toBe(
        '2026-08-17T14:05:00.000Z',
      );
      expect(trail[0]?.recordedById).toBe(receptionist.id);
      expect(trail[0]?.outcome).toBe('NO_ANSWER');
      // Y distinguir «no contestó» de «dijo que no», que cierran el cupo de
      // forma distinta (AG-066 frente a la voluntad del paciente).
      expect(trail[1]?.outcome).toBe('DECLINED');
      expect(trail[1]?.recordedById).toBe(other.id);
    });

    it('AG-064 deriva el recuento y el último instante del rastro, y no de una columna', async () => {
      const { prisma, site, patient, receptionist } = await waitingContext();
      const entry = await inscribe(prisma, {
        patientId: patient.id,
        siteId: site.id,
      });

      for (const day of ['2026-08-17', '2026-08-18', '2026-08-19']) {
        await prisma.waitlistContactAttempt.create({
          data: {
            waitlistEntryId: entry.id,
            recordedById: receptionist.id,
            outcome: 'NO_ANSWER',
            attemptedAt: new Date(`${day}T14:00:00Z`),
          },
        });
      }

      // Las dos columnas que decían esto a medias ya no existen: dos verdades
      // sobre el mismo hecho sólo pueden discrepar, y la caché es la que puede
      // quedarse corta sin que nada lo note.
      expect(await columnsOf(prisma, 'waitlist_entry')).not.toContain(
        'contact_attempts',
      );
      expect(await columnsOf(prisma, 'waitlist_entry')).not.toContain(
        'last_contacted_at',
      );

      const derived = await prisma.waitlistContactAttempt.aggregate({
        where: { waitlistEntryId: entry.id },
        _count: { _all: true },
        _max: { attemptedAt: true },
      });

      expect(derived._count._all).toBe(3);
      expect(derived._max.attemptedAt?.toISOString()).toBe(
        '2026-08-19T14:00:00.000Z',
      );
    });

    it('AG-064 no admite un intento sin autor', async () => {
      const { prisma, site, patient } = await waitingContext();
      const entry = await inscribe(prisma, {
        patientId: patient.id,
        siteId: site.id,
      });

      const rejection = await rejectionOf(
        prisma.$executeRaw`
          INSERT INTO waitlist_contact_attempt (waitlist_entry_id, outcome)
          VALUES (${entry.id}::uuid, 'NO_ANSWER')
        `,
      );

      expect(rejection.message).toMatch(/recorded_by/);
    });

    it('AG-064 no deja reescribir ni borrar un intento ya registrado', async () => {
      const { prisma, site, patient, receptionist } = await waitingContext();
      const entry = await inscribe(prisma, {
        patientId: patient.id,
        siteId: site.id,
      });
      const attempt = await prisma.waitlistContactAttempt.create({
        data: {
          waitlistEntryId: entry.id,
          recordedById: receptionist.id,
          outcome: 'NO_ANSWER',
        },
      });

      // Reescribir «no contestó» por «rechazó» DESPUÉS de dar el cupo a otra
      // persona es exactamente lo que un rastro editable no puede impedir.
      const rewritten = await rejectionOf(
        prisma.waitlistContactAttempt.update({
          where: { id: attempt.id },
          data: { outcome: 'DECLINED' },
        }),
      );
      expect(rewritten.message).toMatch(/append-only/);

      const deleted = await rejectionOf(
        prisma.waitlistContactAttempt.delete({ where: { id: attempt.id } }),
      );
      expect(deleted.message).toMatch(/append-only/);

      // Y la sentencia que se lleva el rastro de la clínica entera de una vez:
      // TRUNCATE no dispara los disparadores de fila y necesita el suyo.
      const truncated = await rejectionOf(
        prisma.$executeRawUnsafe('TRUNCATE TABLE waitlist_contact_attempt'),
      );
      expect(truncated.message).toMatch(/append-only/);

      const survivors = await prisma.waitlistContactAttempt.findMany();
      expect(survivors).toHaveLength(1);
      expect(survivors[0]?.outcome).toBe('NO_ANSWER');
    });

    it('AG-064 no deja borrar la entrada de la que cuelga un intento', async () => {
      const { prisma, site, patient, receptionist } = await waitingContext();
      const entry = await inscribe(prisma, {
        patientId: patient.id,
        siteId: site.id,
      });
      await prisma.waitlistContactAttempt.create({
        data: {
          waitlistEntryId: entry.id,
          recordedById: receptionist.id,
          outcome: 'NO_ANSWER',
        },
      });

      const rejection = await rejectionOf(
        prisma.waitlistEntry.delete({ where: { id: entry.id } }),
      );

      // `RESTRICT`, la regla de la casa: en un sistema clínico no se borra en
      // cascada. Borrar la entrada se llevaría por delante la prueba de a quién
      // se llamó.
      expect(rejection.message).toMatch(/waitlist_contact_attempt_entry_fkey/);
    });
  });

  describe('AG-063 · la conversión en cita', () => {
    it('AG-063 marca SCHEDULED y enlaza la cita en el mismo acto', async () => {
      const { prisma, site, patient, receptionist } = await waitingContext();
      const entry = await inscribe(prisma, {
        patientId: patient.id,
        siteId: site.id,
      });
      const appointment = await anAppointmentFor(prisma, {
        siteId: site.id,
        patientId: patient.id,
      });
      await prisma.waitlistContactAttempt.create({
        data: {
          waitlistEntryId: entry.id,
          recordedById: receptionist.id,
          outcome: 'ACCEPTED',
        },
      });

      const converted = await prisma.waitlistEntry.update({
        where: { id: entry.id },
        data: { status: 'SCHEDULED', convertedEntryId: appointment.id },
      });

      expect(converted.status).toBe('SCHEDULED');
      expect(converted.convertedEntryId).toBe(appointment.id);
    });

    it('AG-063 rechaza SCHEDULED sin cita enlazada, y una cita enlazada sin SCHEDULED', async () => {
      const { prisma, site, patient, receptionist } = await waitingContext();
      const entry = await inscribe(prisma, {
        patientId: patient.id,
        siteId: site.id,
      });
      const appointment = await anAppointmentFor(prisma, {
        siteId: site.id,
        patientId: patient.id,
      });
      await prisma.waitlistContactAttempt.create({
        data: {
          waitlistEntryId: entry.id,
          recordedById: receptionist.id,
          outcome: 'ACCEPTED',
        },
      });

      // Cerrada sin decir con qué cupo: la cita queda huérfana de su origen.
      const half = await rejectionOf(
        prisma.waitlistEntry.update({
          where: { id: entry.id },
          data: { status: 'SCHEDULED' },
        }),
      );
      expect(half.message).toMatch(/waitlist_entry_conversion_complete/);

      // Y al revés: ya tiene su cupo y sigue compitiendo por otro.
      const other = await rejectionOf(
        prisma.waitlistEntry.update({
          where: { id: entry.id },
          data: { convertedEntryId: appointment.id },
        }),
      );
      expect(other.message).toMatch(/waitlist_entry_conversion_complete/);
    });

    it('AG-063 no deja que dos entradas se lleven el mismo cupo', async () => {
      const { prisma, site, patient, receptionist } = await waitingContext();
      const appointment = await anAppointmentFor(prisma, {
        siteId: site.id,
        patientId: patient.id,
      });

      // Dos entradas del MISMO paciente —dos motivos distintos, la misma
      // persona— para que lo único que las separe sea el cupo que reclaman.
      const first = await inscribe(prisma, {
        patientId: patient.id,
        siteId: site.id,
      });
      const second = await inscribe(prisma, {
        patientId: patient.id,
        siteId: site.id,
      });
      for (const entry of [first, second]) {
        await prisma.waitlistContactAttempt.create({
          data: {
            waitlistEntryId: entry.id,
            recordedById: receptionist.id,
            outcome: 'ACCEPTED',
          },
        });
      }

      await prisma.waitlistEntry.update({
        where: { id: first.id },
        data: { status: 'SCHEDULED', convertedEntryId: appointment.id },
      });

      const rejection = await rejectionOf(
        prisma.waitlistEntry.update({
          where: { id: second.id },
          data: { status: 'SCHEDULED', convertedEntryId: appointment.id },
        }),
      );

      // Prisma resuelve la violación de unicidad ella misma (P2002) y devuelve
      // la COLUMNA, no el nombre del índice, así que el nombre se comprueba
      // donde sí se puede: en el catálogo. Y con su predicado, que es la mitad
      // que Prisma no puede describir y por la que el índice está en la lista
      // protegida de `check-migrations.mts`.
      expect(rejection.message).toMatch(/converted_entry_id/);

      const [index] = await prisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'waitlist_entry_one_per_converted_entry'
      `;
      expect(index?.indexdef).toMatch(/CREATE UNIQUE INDEX/);
      expect(index?.indexdef).toMatch(
        /WHERE \(converted_entry_id IS NOT NULL\)/,
      );
    });

    it('AG-063 rechaza enlazar la cita de otro paciente', async () => {
      const { prisma, site, patient, receptionist } = await waitingContext();
      const someoneElse = await createPatient(prisma);
      const entry = await inscribe(prisma, {
        patientId: patient.id,
        siteId: site.id,
      });
      const appointment = await anAppointmentFor(prisma, {
        siteId: site.id,
        patientId: someoneElse.id,
      });
      await prisma.waitlistContactAttempt.create({
        data: {
          waitlistEntryId: entry.id,
          recordedById: receptionist.id,
          outcome: 'ACCEPTED',
        },
      });

      const rejection = await rejectionOf(
        prisma.waitlistEntry.update({
          where: { id: entry.id },
          data: { status: 'SCHEDULED', convertedEntryId: appointment.id },
        }),
      );

      // La fila diría que el turno de esta paciente se cumplió, y el cupo se lo
      // llevó otra persona. Es la forma exacta que tiene de verse un reparto
      // torcido, certificado por la única tabla que lo registra.
      expect(rejection.message).toMatch(/appointment of another patient/);
    });

    it('AG-063 rechaza convertir una entrada en un bloqueo de agenda', async () => {
      const { prisma, site, patient, receptionist } = await waitingContext();
      const practitioner = await createPractitioner(prisma);
      const entry = await inscribe(prisma, {
        patientId: patient.id,
        siteId: site.id,
      });
      await prisma.waitlistContactAttempt.create({
        data: {
          waitlistEntryId: entry.id,
          recordedById: receptionist.id,
          outcome: 'ACCEPTED',
        },
      });

      // Un bloqueo no tiene paciente (`agenda_entry_patient_coherence`), así que
      // la comprobación de arriba lo cubre sin nombrarlo aparte.
      const block = await prisma.agendaEntry.create({
        data: {
          kind: 'BLOCK',
          siteId: site.id,
          practitionerId: practitioner.id,
          status: 'BLOCKED',
          startsAt: new Date(Date.UTC(2026, 8, 15, 9, 0)),
          endsAt: new Date(Date.UTC(2026, 8, 15, 10, 0)),
        },
      });

      const rejection = await rejectionOf(
        prisma.waitlistEntry.update({
          where: { id: entry.id },
          data: { status: 'SCHEDULED', convertedEntryId: block.id },
        }),
      );

      expect(rejection.message).toMatch(/appointment of another patient/);
    });
  });

  describe('AG-064 · el cupo no se reasigna sin confirmación', () => {
    it('AG-064 rechaza la conversión mientras no conste una aceptación', async () => {
      const { prisma, site, patient, receptionist } = await waitingContext();
      const entry = await inscribe(prisma, {
        patientId: patient.id,
        siteId: site.id,
      });
      const appointment = await anAppointmentFor(prisma, {
        siteId: site.id,
        patientId: patient.id,
      });

      // Tres llamadas sin respuesta NO son una confirmación, y son justo el
      // caso en que la tentación de «asignarle el cupo igual» es mayor.
      for (const outcome of ['NO_ANSWER', 'NO_ANSWER', 'DECLINED'] as const) {
        await prisma.waitlistContactAttempt.create({
          data: {
            waitlistEntryId: entry.id,
            recordedById: receptionist.id,
            outcome,
          },
        });
      }

      const rejection = await rejectionOf(
        prisma.waitlistEntry.update({
          where: { id: entry.id },
          data: { status: 'SCHEDULED', convertedEntryId: appointment.id },
        }),
      );

      expect(rejection.message).toMatch(/no recorded acceptance/);

      // Y en cuanto la aceptación consta, la misma operación pasa: lo que la
      // base impide no es la aceptación verbal, es la que nadie escribió.
      await prisma.waitlistContactAttempt.create({
        data: {
          waitlistEntryId: entry.id,
          recordedById: receptionist.id,
          outcome: 'ACCEPTED',
        },
      });

      const converted = await prisma.waitlistEntry.update({
        where: { id: entry.id },
        data: { status: 'SCHEDULED', convertedEntryId: appointment.id },
      });
      expect(converted.status).toBe('SCHEDULED');
    });

    it('AG-064 no admite una entrada que nazca ya convertida', async () => {
      const { prisma, site, patient } = await waitingContext();
      const appointment = await anAppointmentFor(prisma, {
        siteId: site.id,
        patientId: patient.id,
      });

      // No puede haber intentos antes de que la entrada exista, así que una
      // inscripción convertida es siempre un cupo dado sin constancia. Y una
      // inscripción que se resuelve en el mismo acto no es una lista de espera:
      // AG-060 empieza «CUANDO NO HAYA cupo disponible».
      const rejection = await rejectionOf(
        prisma.waitlistEntry.create({
          data: {
            patientId: patient.id,
            siteId: site.id,
            preferredFrom: new Date('2026-09-01'),
            preferredTo: new Date('2026-09-30'),
            status: 'SCHEDULED',
            convertedEntryId: appointment.id,
          },
        }),
      );

      expect(rejection.message).toMatch(/no recorded acceptance/);
    });
  });

  describe('AG-067 · lo que se cierra, se cierra', () => {
    it('AG-067 no deja que una entrada caducada o anulada vuelva a competir', async () => {
      const { prisma, site, patient } = await waitingContext();

      for (const closed of ['EXPIRED', 'CANCELLED'] as const) {
        const entry = await prisma.waitlistEntry.create({
          data: {
            patientId: patient.id,
            siteId: site.id,
            preferredFrom: new Date('2026-09-01'),
            preferredTo: new Date('2026-09-30'),
            status: closed,
          },
        });

        const rejection = await rejectionOf(
          prisma.waitlistEntry.update({
            where: { id: entry.id },
            data: { status: 'WAITING' },
          }),
        );

        // Reabrirla la devolvería a la cola CON SU ANTIGÜEDAD ORIGINAL, por
        // delante de todos los que se inscribieron después, sin que ninguna
        // consulta se hubiera equivocado.
        expect(rejection.message).toMatch(/cannot be reopened/);
      }
    });

    it('AG-067 no deja reabrir ni re-apuntar una entrada ya convertida', async () => {
      const { prisma, site, patient, receptionist } = await waitingContext();
      const entry = await inscribe(prisma, {
        patientId: patient.id,
        siteId: site.id,
      });
      const appointment = await anAppointmentFor(prisma, {
        siteId: site.id,
        patientId: patient.id,
      });
      await prisma.waitlistContactAttempt.create({
        data: {
          waitlistEntryId: entry.id,
          recordedById: receptionist.id,
          outcome: 'ACCEPTED',
        },
      });
      await prisma.waitlistEntry.update({
        where: { id: entry.id },
        data: { status: 'SCHEDULED', convertedEntryId: appointment.id },
      });

      const reopened = await rejectionOf(
        prisma.waitlistEntry.update({
          where: { id: entry.id },
          data: { status: 'CANCELLED', convertedEntryId: null },
        }),
      );
      expect(reopened.message).toMatch(/cannot be reopened/);

      // Y cambiar a qué cita apunta es reescribir a posteriori qué cupo se le
      // dio a quién.
      const another = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId: site.id,
          patientId: patient.id,
          practitionerId: (await createPractitioner(prisma)).id,
          startsAt: new Date(Date.UTC(2026, 8, 16, 9, 0)),
          endsAt: new Date(Date.UTC(2026, 8, 16, 10, 0)),
        },
      });

      const repointed = await rejectionOf(
        prisma.waitlistEntry.update({
          where: { id: entry.id },
          data: { convertedEntryId: another.id },
        }),
      );
      expect(repointed.message).toMatch(/cannot be reopened/);
    });

    it('AG-067 sí deja avanzar una entrada abierta', async () => {
      const { prisma, site, patient } = await waitingContext();
      const entry = await inscribe(prisma, {
        patientId: patient.id,
        siteId: site.id,
      });

      // El disparador cierra la puerta de salida de los estados finales, no la
      // de entrada: WAITING → CONTACTED → CANCELLED es el camino normal.
      const contacted = await prisma.waitlistEntry.update({
        where: { id: entry.id },
        data: { status: 'CONTACTED' },
      });
      expect(contacted.status).toBe('CONTACTED');

      const cancelled = await prisma.waitlistEntry.update({
        where: { id: entry.id },
        data: { status: 'CANCELLED' },
      });
      expect(cancelled.status).toBe('CANCELLED');
    });
  });

  describe('AG-094 · el parámetro que faltaba', () => {
    it('AG-094 cada sede nace con un máximo de intentos de contacto y no admite uno imposible', async () => {
      const { prisma, site } = await waitingContext();

      const parameters = await prisma.siteParameter.findUniqueOrThrow({
        where: { siteId: site.id },
      });
      // Lo escribe `trg_site_parameter_defaults` al crear la sede (CF-062), como
      // los otros siete de AG-094.
      expect(parameters.waitlistMaxContactAttempts).toBe(3);

      // En 0 la entrada caducaría antes del primer intento y la lista no
      // llamaría a nadie.
      const rejection = await rejectionOf(
        prisma.siteParameter.update({
          where: { siteId: site.id },
          data: { waitlistMaxContactAttempts: 0 },
        }),
      );
      expect(rejection.message).toMatch(
        /site_parameter_waitlist_max_contact_attempts_range/,
      );
    });
  });
});
