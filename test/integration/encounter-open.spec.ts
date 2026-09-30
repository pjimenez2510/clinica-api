import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaEncounterRepository } from '../../src/modules/encounter/infrastructure/prisma-encounter.repository';
import {
  AppointmentNotAttendableError,
  EncounterAppointmentMismatchError,
} from '../../src/modules/encounter/domain/encounter.errors';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
  hourSlot,
} from './setup/fixtures';

/**
 * Opening an attention, against a real PostgreSQL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT ONLY A REAL DATABASE CAN SETTLE HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  - EN-008: the frozen age is written by `trg_encounter_freeze_age`, which
 *    resolves the clinical date in `America/Guayaquil`. A double would hand
 *    back whatever we told it to, and the defect this closes — a 21:00
 *    consultation falling into the next day and moving a neonate's `age_days`
 *    — is arithmetic PostgreSQL does, not TypeScript.
 *  - EN-005: the race between annulling a cita and attending it. The
 *    assertion is WHO WINS, never «at least one fails»: two winners is the
 *    defect being hunted, and only a real transaction can produce it.
 *  - EN-006: «tantas atenciones como consultas», which is a NEGATIVE about a
 *    constraint that must not exist. Only the database can be asked whether it
 *    refuses the second row.
 *  - EN-015: after a merge, the history read from the survivor includes the
 *    absorbed chart's attentions. That depends on the link being walked in the
 *    query, which is precisely what a fake cannot demonstrate.
 */
const db = useDatabase();

/** The adapter under test, over the container's client. */
const repositoryOf = (prisma: PrismaClient) =>
  new PrismaEncounterRepository(prisma as unknown as PrismaService);

async function clinic(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  return { site, practitioner, patient };
}

/** An appointment for one patient, in one site, at a fixed hour. */
async function anAppointment(
  prisma: PrismaClient,
  ids: { siteId: string; practitionerId: string; patientId: string },
  hour = 9,
) {
  return prisma.agendaEntry.create({
    data: {
      kind: 'APPOINTMENT',
      bookingChannel: 'PHONE',
      siteId: ids.siteId,
      practitionerId: ids.practitionerId,
      patientId: ids.patientId,
      ...hourSlot(hour),
    },
  });
}

const opening = (ids: {
  siteId: string;
  practitionerId: string;
  patientId: string;
}) => ({
  ...ids,
  startedAt: new Date('2026-09-14T14:00:00Z'),
  careModality: 'MORBIDITY' as const,
  careSetting: 'INTRAMURAL' as const,
  visitSequence: 'FIRST_TIME' as const,
});

describe('abrir la atención', () => {
  it('EN-003 abre una atención espontánea, sin ninguna cita detrás', async () => {
    const prisma = db();
    const { site, practitioner, patient } = await clinic(prisma);

    const encounter = await repositoryOf(prisma).open(
      opening({
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
      }),
    );

    expect(encounter.agendaEntryId).toBeNull();
    expect(encounter.status).toBe('OPEN');
    expect(encounter.endedAt).toBeNull();
  });

  it('EN-006 admite dos atenciones del mismo paciente, el mismo día y con el mismo profesional', async () => {
    /**
     * ⚠️ ES UN REQUISITO NEGATIVO Y POR ESO SE PRUEBA CONTRA LA BASE: lo que
     * hay que demostrar es que NO existe la unicidad «un paciente, un día, una
     * atención» que cualquiera añadiría por instinto. Con ella, la paciente
     * que ve al ginecólogo por la mañana y al pediatra de su hijo por la tarde
     * pierde una de las dos y el reporte mensual cuenta la mitad de la
     * producción.
     */
    const prisma = db();
    const { site, practitioner, patient } = await clinic(prisma);
    const repository = repositoryOf(prisma);
    const ids = {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    };

    const morning = await repository.open({
      ...opening(ids),
      startedAt: new Date('2026-09-14T14:00:00Z'),
    });
    const afternoon = await repository.open({
      ...opening(ids),
      startedAt: new Date('2026-09-14T20:00:00Z'),
      visitSequence: 'SUBSEQUENT',
    });

    expect(morning.id).not.toBe(afternoon.id);
    // LAS DOS EXISTEN, contadas en la base y no en la respuesta.
    await expect(
      prisma.encounter.count({ where: { patientId: patient.id } }),
    ).resolves.toBe(2);
  });

  it('EN-008 congela la edad del paciente resuelta en la fecha clínica de Ecuador', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    // Nace el 1 de septiembre de 2026; se le atiende el 14.
    const baby = await createPatient(prisma, {
      birthDate: new Date('2026-09-01'),
    });

    const encounter = await repositoryOf(prisma).open({
      ...opening({
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: baby.id,
      }),
      // 21:00 en Guayaquil = 02:00Z del día siguiente.
      startedAt: new Date('2026-09-15T02:00:00Z'),
    });

    /**
     * ⚠️ EL DEFECTO QUE ORIGINÓ REQ-160, EN UNA ASERCIÓN. Un `::date` desnudo
     * usa el huso de la SESIÓN: en UTC ese instante es el 15 y la edad saldría
     * 14 días. Resuelto en `America/Guayaquil` es el 14, y son TRECE — que es
     * como el RDACAA clasifica a un neonato.
     */
    expect(encounter.ageDays).toBe(13);
    expect(encounter.ageMonths).toBe(0);
    expect(encounter.ageYears).toBe(0);
  });

  it('EN-008 da la misma edad congelada con la sesión en UTC y en Asia/Tokyo', async () => {
    /**
     * La otra mitad de la garantía: la respuesta no puede depender de cómo
     * esté configurada la conexión. `SET LOCAL TimeZone` mueve el huso de la
     * sesión dentro de la transacción, y el disparador tiene que dar lo mismo.
     */
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const baby = await createPatient(prisma, {
      birthDate: new Date('2026-09-01'),
    });

    const ageUnder = async (timeZone: string): Promise<number> =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TimeZone = '${timeZone}'`);
        const [row] = await tx.$queryRawUnsafe<{ age_days: number }[]>(
          `INSERT INTO encounter
             (site_id, practitioner_id, patient_id, started_at,
              "careModality", "careSetting", "visitSequence", updated_at)
           VALUES ($1, $2, $3, TIMESTAMPTZ '2026-09-15T02:00:00Z',
                   'MORBIDITY', 'INTRAMURAL', 'FIRST_TIME', now())
           RETURNING age_days`,
          site.id,
          practitioner.id,
          baby.id,
        );
        return row!.age_days;
      });

    expect(await ageUnder('UTC')).toBe(13);
    expect(await ageUnder('Asia/Tokyo')).toBe(13);
  });

  it('EN-004 rechaza una atención cuya cita es de otro paciente', async () => {
    const prisma = db();
    const { site, practitioner, patient } = await clinic(prisma);
    const somebodyElse = await createPatient(prisma);
    const appointment = await anAppointment(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: somebodyElse.id,
    });

    /**
     * ⚠️ EL PEOR ERROR POSIBLE DE ESTE SISTEMA: atender al paciente
     * equivocado en el cupo de otro escribe el acto en la historia
     * equivocada. Lo garantiza `trg_encounter_matches_appointment`; el
     * adaptador se adelanta con una frase, y esta prueba comprueba que NADA se
     * escribe por ninguno de los dos caminos.
     */
    await expect(
      repositoryOf(prisma).open({
        ...opening({
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
        }),
        agendaEntryId: appointment.id,
      }),
    ).rejects.toBeInstanceOf(EncounterAppointmentMismatchError);

    await expect(prisma.encounter.count()).resolves.toBe(0);
  });

  it('EN-005 rechaza registrar una atención sobre una cita ya anulada', async () => {
    const prisma = db();
    const { site, practitioner, patient } = await clinic(prisma);
    const ids = {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    };
    const appointment = await anAppointment(prisma, ids);
    await prisma.agendaEntry.update({
      where: { id: appointment.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), releasedAt: new Date() }, // prettier-ignore
    });

    await expect(
      repositoryOf(prisma).open({ ...opening(ids), agendaEntryId: appointment.id }), // prettier-ignore
    ).rejects.toBeInstanceOf(AppointmentNotAttendableError);
  });

  it('EN-005 rechaza atender una cita marcada como inasistencia', async () => {
    const prisma = db();
    const { site, practitioner, patient } = await clinic(prisma);
    const ids = {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    };
    const appointment = await anAppointment(prisma, ids);
    await prisma.agendaEntry.update({
      where: { id: appointment.id },
      data: { status: 'NO_SHOW', noShowAt: new Date(), releasedAt: new Date() },
    });

    await expect(
      repositoryOf(prisma).open({ ...opening(ids), agendaEntryId: appointment.id }), // prettier-ignore
    ).rejects.toBeInstanceOf(AppointmentNotAttendableError);
  });

  it('EN-005 deja exactamente UN ganador cuando anular y atender corren a la vez', async () => {
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * ESTO ES LO QUE CIERRA AG-045, Y LA ASERCIÓN ES QUIÉN GANA
     * ═════════════════════════════════════════════════════════════════════════
     *
     * La revisión adversarial de E2 dejó el resquicio escrito: anular
     * re-arbitra con `encounter IS NULL` dentro de su propio `UPDATE`, así que
     * esa carrera está cerrada hasta el intervalo intra-sentencia — y NADA en
     * la base ataba la CREACIÓN de una atención al estado de la cita. Una
     * atención confirmada justo después de ese `UPDATE` dejaba una cita
     * anulada con atención registrada: dos hechos verdaderos que se
     * contradicen.
     *
     * `SELECT … FOR UPDATE` sobre `agenda_entry` dentro de la misma
     * transacción es lo que lo cierra. Aquí la anulación toma el bloqueo
     * PRIMERO y no lo suelta hasta confirmar, así que la atención espera y
     * encuentra `CANCELLED`. «Al menos una falla» no es la aserción: dos
     * ganadores es el fallo que se busca, y por eso se cuentan las filas.
     */
    const prisma = db();
    const { site, practitioner, patient } = await clinic(prisma);
    const ids = {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    };
    const appointment = await anAppointment(prisma, ids);

    let releaseAnnulment: () => void = () => undefined;
    const annulmentHeld = new Promise<void>((resolve) => {
      releaseAnnulment = resolve;
    });

    const annulment = prisma.$transaction(async (tx) => {
      // El mismo bloqueo que toma el adaptador, tomado antes.
      await tx.$queryRawUnsafe(
        `SELECT id FROM agenda_entry WHERE id = $1 FOR UPDATE`,
        appointment.id,
      );
      await tx.$executeRawUnsafe(
        `UPDATE agenda_entry
            SET status = 'CANCELLED', cancelled_at = now(), released_at = now()
          WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM encounter WHERE agenda_entry_id = $1)`,
        appointment.id,
      );
      await annulmentHeld;
    });

    // La atención arranca con el bloqueo ya tomado: se queda esperando.
    const attention = repositoryOf(prisma)
      .open({ ...opening(ids), agendaEntryId: appointment.id })
      .then(() => 'attended' as const)
      .catch(() => 'refused' as const);

    releaseAnnulment();
    await annulment;

    expect(await attention).toBe('refused');

    // Un solo ganador, contado en las filas y no en las promesas.
    const entry = await prisma.agendaEntry.findUniqueOrThrow({
      where: { id: appointment.id },
      select: { status: true },
    });
    expect(entry.status).toBe('CANCELLED');
    await expect(prisma.encounter.count()).resolves.toBe(0);
  });

  it('EN-005 deja atender la cita cuando la anulación no llegó a ocurrir', async () => {
    // La otra mitad del par: sin la anulación, la atención gana y la cita
    // queda con atención registrada — que es lo que hace que
    // `AGENDA_ENTRY_HAS_ENCOUNTER` tenga a qué agarrarse desde el otro lado.
    const prisma = db();
    const { site, practitioner, patient } = await clinic(prisma);
    const ids = {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    };
    const appointment = await anAppointment(prisma, ids);

    const encounter = await repositoryOf(prisma).open({
      ...opening(ids),
      agendaEntryId: appointment.id,
    });

    expect(encounter.agendaEntryId).toBe(appointment.id);
    await expect(
      prisma.encounter.count({ where: { agendaEntryId: appointment.id } }),
    ).resolves.toBe(1);
  });

  it('EN-015 devuelve la historia de la ficha superviviente INCLUIDAS las atenciones de la absorbida', async () => {
    /**
     * ⚠️ LA FUSIÓN NO REPUNTA NADA (D-031): las atenciones de la ficha
     * absorbida conservan su `patient_id` y sólo se alcanzan por el enlace.
     * Una lectura con el identificador desnudo hace desaparecer media historia
     * el día que admisión arregla un duplicado, y eso no se puede demostrar
     * con un doble: depende de que el enlace se recorra EN LA CONSULTA.
     */
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const surviving = await createPatient(prisma);
    const absorbed = await createPatient(prisma);
    const repository = repositoryOf(prisma);

    await repository.open({
      ...opening({
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: absorbed.id,
      }),
      startedAt: new Date('2026-03-02T14:00:00Z'),
    });
    await repository.open(
      opening({
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: surviving.id,
      }),
    );

    await prisma.patient.update({
      where: { id: absorbed.id },
      data: { mergedIntoId: surviving.id, mergedAt: new Date() },
    });

    const history = await repository.historyOf({
      patientId: surviving.id,
      sites: [site.id],
      page: 1,
      pageSize: 20,
    });

    expect(history.items).toHaveLength(2);
    // Newest first: what a clinician opens is the last attention.
    expect(history.items[0]?.patientId).toBe(surviving.id);
    expect(history.items[1]?.patientId).toBe(absorbed.id);
    // EN-162. Y el total cuenta las dos: si contara sólo por el `patient_id`
    // desnudo, la pantalla diría «1 de 1» sobre una historia de dos.
    expect(history.total).toBe(2);
  });

  it('EN-162 pagina la historia y cuenta el total sobre el MISMO predicado', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA PÁGINA Y EL TOTAL TIENEN QUE MIRAR LO MISMO
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Un total contado sobre otro `WHERE` ofrece páginas de atenciones que la
     * consulta no devuelve: aquí hay una atención de una sede FUERA del
     * alcance de quien pregunta, y ni la página ni el total pueden verla. Un
     * doble no lo demuestra —devuelve lo que se le pida—; hace falta que las
     * dos consultas salgan de verdad contra la base.
     *
     * Y se pide la ÚLTIMA página a propósito: es donde se nota que el orden es
     * total. Sin el desempate por `id`, dos atenciones del mismo instante
     * pueden salir en dos páginas distintas y una no salir nunca.
     */
    const prisma = db();
    const { site, practitioner, patient } = await clinic(prisma);
    const otherSite = await createSite(prisma, 'Sede Norte');
    const repository = repositoryOf(prisma);

    for (let index = 0; index < 7; index += 1) {
      await repository.open({
        ...opening({
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
        }),
        startedAt: new Date(`2026-03-0${String(index + 1)}T14:00:00Z`),
      });
    }
    // Fuera del alcance: no cuenta ni aparece.
    await repository.open(
      opening({
        siteId: otherSite.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
      }),
    );

    const page = (n: number) =>
      repository.historyOf({
        patientId: patient.id,
        sites: [site.id],
        page: n,
        pageSize: 3,
      });

    const first = await page(1);
    const last = await page(3);

    expect(first.items).toHaveLength(3);
    expect(first.total).toBe(7);
    expect(last.items).toHaveLength(1);
    expect(last.total).toBe(7);
    // Sin repeticiones entre páginas: el orden es total.
    const ids = [...first.items, ...(await page(2)).items, ...last.items].map(
      (encounter) => encounter.id,
    );
    expect(new Set(ids).size).toBe(7);
  });

  it('EN-121 no devuelve una atención de una sede fuera del alcance de quien pregunta', async () => {
    const prisma = db();
    const { site, practitioner, patient } = await clinic(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    const repository = repositoryOf(prisma);

    const encounter = await repository.open(
      opening({
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
      }),
    );

    await expect(
      repository.findById({ encounterId: encounter.id, sites: [otherSite.id] }),
    ).resolves.toBeNull();
    await expect(
      repository.findById({ encounterId: encounter.id, sites: [site.id] }),
    ).resolves.toMatchObject({ id: encounter.id });
  });

  it('EN-146 lista sólo lo que sigue abierto, del profesional que se pregunta', async () => {
    const prisma = db();
    const { site, practitioner, patient } = await clinic(prisma);
    const other = await createPractitioner(prisma);
    const repository = repositoryOf(prisma);

    const mine = await repository.open(
      opening({
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
      }),
    );
    const closed = await repository.open(
      opening({
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
      }),
    );
    await repository.open(
      opening({
        siteId: site.id,
        practitionerId: other.id,
        patientId: patient.id,
      }),
    );

    // Una se cierra por completo: sale del índice parcial.
    await prisma.encounter.update({
      where: { id: closed.id },
      data: {
        status: 'COMPLETED',
        // `encounter_time_order` refuses an end before the beginning, and the
        // fixed hour of this file is in the future relative to the clock —
        // which is why the instant is stated rather than taken from `now()`.
        endedAt: new Date('2026-09-14T15:00:00Z'),
        dischargeCondition: 'ALIVE',
        closedById: practitioner.id,
        closedAt: new Date('2026-09-14T15:30:00Z'),
      },
    });

    const open = await repository.listStillOpen({
      practitionerId: practitioner.id,
      sites: [site.id],
    });

    expect(open.map((encounter) => encounter.id)).toEqual([mine.id]);
  });

  it('EN-145 deja abierta una atención de hace cuarenta días, porque nada la cierra sola', async () => {
    /**
     * ⚠️ SE PRUEBA POR OBSERVACIÓN Y ES LO ÚNICO QUE PUEDE PROBARSE: lo que
     * hay que demostrar es la AUSENCIA de un proceso. Se envejece la fila, se
     * vuelve a leer y sigue abierta — si algún día alguien añade un cierre
     * automático, esta prueba es la que lo delata.
     */
    const prisma = db();
    const { site, practitioner, patient } = await clinic(prisma);
    const repository = repositoryOf(prisma);

    const forgotten = await repository.open({
      ...opening({
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
      }),
      startedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });

    const open = await repository.listStillOpen({ sites: [site.id] });

    expect(open.map((encounter) => encounter.id)).toContain(forgotten.id);
    await expect(
      prisma.encounter.findUniqueOrThrow({
        where: { id: forgotten.id },
        select: { status: true, endedAt: true, closedById: true },
      }),
    ).resolves.toEqual({
      status: 'OPEN',
      endedAt: null,
      closedById: null,
    });
  });
});
