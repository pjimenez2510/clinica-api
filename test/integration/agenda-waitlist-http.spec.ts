import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { PatientMergeService } from '../../src/modules/patients/application/patient-merge.service';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createScheduleRule,
  createSite,
  linkPractitionerToSite,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * The waiting list end to end (E5, AG-060 to AG-067).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS PROVES THAT THE UNIT SUITES CANNOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `agenda-waitlist.spec.ts` proves what the DATABASE guarantees — the
 * append-only trail, the two triggers, the biconditional. `waitlist.spec.ts`
 * and `waitlist.service.spec.ts` prove the decisions. Between them there was
 * no proof that the two halves meet: that expiring by date actually WRITES the
 * row, that the priority the queue is ordered by is derived from the periods
 * stored on the chart (and on the charts it absorbed), that a conversion with
 * no recorded acceptance comes back as a sentence rather than a 500, and that
 * every route is refused to somebody with no scope over the site.
 *
 * Every appointment is on Monday 14 September 2026 and the times are
 * Ecuadorian: 08:00 there is 13:00Z. The site admits booking in the past for
 * the same reason as `agenda-http.spec.ts` — the pinned Monday stops being
 * future the moment the calendar passes it.
 */
const PASSWORD = 'el caballo come alfalfa';
const EMAIL = 'recepcion.espera@clinica.ec';

const BASE = '/api/v1/agenda/sites';

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

interface WaitlistEntryBody {
  id: string;
  status: string;
  convertedEntryId: string | null;
  contactAttempts: number;
  lastContactedAt: string | null;
  preferredFrom: string;
  preferredTo: string;
  practitionerId: string | null;
  serviceTypeId: string | null;
}

interface CandidateBody {
  entryId: string;
  patientId: string;
  priority: number;
  status: string;
  contactAttempts: number;
}

describe('la lista de espera por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  /** PA-060. La fusión de fichas, que es lo que esta cola tiene que sobrevivir. */
  let merges: PatientMergeService;

  let token: string;
  let userId: string;
  let siteId: string;
  let otherSiteId: string;
  let practitionerId: string;
  let patientId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // Sin límite de peticiones: el real son cinco por segundo y este
        // fichero hace una veintena seguidas. Se sustituye el ALMACÉN, no el
        // guard, que es justo lo que estas pruebas comprueban.
        .overrideProvider(ThrottlerStorage)
        .useValue({
          increment: () =>
            Promise.resolve({
              totalHits: 1,
              timeToExpire: 1,
              isBlocked: false,
              timeToBlockExpire: 0,
            }),
        })
        .compile();

      app = moduleRef.createNestApplication<NestExpressApplication>({
        bodyParser: false,
      });
      configureApp(app);
      await listenForTests(app);
      registry = app.get(RolePermissionRegistry);
      merges = app.get(PatientMergeService);
    }

    await seed();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function seed(): Promise<void> {
    const site = await createSite(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);

    siteId = site.id;
    otherSiteId = otherSite.id;
    practitionerId = practitioner.id;
    patientId = patient.id;

    await linkPractitionerToSite(prisma, practitioner.id, site.id);
    await createScheduleRule(
      prisma,
      { practitionerId: practitioner.id, siteId: site.id },
      { weekday: 1, startTime: '08:00', endTime: '12:00' },
    );
    await prisma.siteParameter.update({
      where: { siteId: site.id },
      data: { allowPastBooking: true, slotAtomMinutes: 20 },
    });

    token = await signIn();
  }

  async function signIn(): Promise<string> {
    await syncAuthorisation(prisma);
    registry.invalidate();

    const user = await prisma.user.create({
      data: {
        email: EMAIL,
        firstName: 'Rosa',
        lastName: 'Cedeño',
        // Cédula sintética con dígito verificador calculado.
        cedula: '1710034065',
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    userId = user.id;

    const recepcion = await prisma.role.findUniqueOrThrow({
      where: { code: 'RECEPCION' },
    });
    // EN UNA SEDE, no en todas: es lo que hace comprobable AG-071.
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: recepcion.id, siteId },
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  const auth = () => `Bearer ${token}`;

  /** Enrols through the route, which is what AG-060 is about. */
  async function enrol(
    body: Record<string, unknown> = {},
    patient = patientId,
  ): Promise<WaitlistEntryBody> {
    const response = await request(app.getHttpServer())
      .post(`${BASE}/${siteId}/waitlist`)
      .set('Authorization', auth())
      .send({
        patientId: patient,
        preferredFrom: '2026-09-01',
        preferredTo: '2026-09-30',
        ...body,
      })
      .expect(201);
    return response.body as WaitlistEntryBody;
  }

  /**
   * A type of attention out of the CLINIC's own catalogue (`service_type`,
   * SP-020) — the table `agenda_entry.service_type_id` has named since C4.
   *
   * IT IS THE HALF OF AG-061 THAT COULD NOT BE PROVEN END TO END while
   * `waitlist_entry` still pointed at `catalog_concept`: two different tables
   * can never compare equal, so an enrolment that fixed a type could only be
   * refused by a foreign key.
   */
  let serviceTypes = 0;
  async function createServiceType(name: string) {
    serviceTypes += 1;
    const specialty = await prisma.specialty.create({
      data: { code: `especialidad-${serviceTypes}`, name: `Especialidad ${serviceTypes}` }, // prettier-ignore
    });
    return prisma.serviceType.create({
      data: { specialtyId: specialty.id, name, durationMinutes: 20 },
    });
  }

  /**
   * An appointment that occupied the calendar and has been released.
   *
   * Written directly rather than booked-and-cancelled through HTTP: what is
   * under test here is the waiting list, and `released_at` is the ONLY thing
   * about it that AG-061 reads — the four paths that stamp it (AG-041, AG-042,
   * AG-050, AG-114) have their own tests.
   */
  async function releasedSlot(
    overrides: {
      blocksCalendar?: boolean;
      releasedAt?: Date | null;
      site?: string;
      serviceTypeId?: string;
    } = {},
  ) {
    const other = await createPatient(prisma);
    return prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: overrides.site ?? siteId,
        patientId: other.id,
        practitionerId,
        // 08:00 Ecuador on Monday 14 September 2026.
        startsAt: new Date(Date.UTC(2026, 8, 14, 13, 0)),
        endsAt: new Date(Date.UTC(2026, 8, 14, 13, 20)),
        status: 'CANCELLED',
        blocksCalendar: overrides.blocksCalendar ?? true,
        // AG-035, `agenda_entry_overbooking_coherence`: un sobrecupo lleva
        // siempre motivo y autorizador, y una cita normal no puede llevarlos.
        ...(overrides.blocksCalendar === false
          ? {
              overbookingReason: 'Urgencia atendida el mismo día',
              overbookingAuthorisedById: userId,
            }
          : {}),
        releasedAt:
          overrides.releasedAt === undefined
            ? new Date(Date.UTC(2026, 8, 10, 12, 0))
            : overrides.releasedAt,
        /**
         * EL TIPO DE ATENCIÓN DEL CUPO, cuando la prueba lo fija. Sin él, el
         * cupo no fija ninguno —un bloqueo liberado, típicamente— y una
         * entrada que exige uno simplemente no queda satisfecha.
         */
        serviceTypeId: overrides.serviceTypeId ?? null,
      },
    });
  }

  async function candidatesFor(entryId: string): Promise<CandidateBody[]> {
    const response = await request(app.getHttpServer())
      .get(`${BASE}/${siteId}/waitlist/candidates/${entryId}`)
      .set('Authorization', auth())
      .expect(200);
    return (response.body as { items: CandidateBody[] }).items;
  }

  /** An acceptance on record, which is what AG-064 demands before converting. */
  async function accept(entryId: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`${BASE}/${siteId}/waitlist/${entryId}/contact-attempts`)
      .set('Authorization', auth())
      .send({ outcome: 'ACCEPTED' })
      .expect(200);
  }

  describe('AG-060 · inscribir cuando no hay cupo', () => {
    it('AG-060 enrols with site, chart and preferred range, and leaves the rest open', async () => {
      const entry = await enrol();

      expect(entry.status).toBe('WAITING');
      expect(entry.preferredFrom).toBe('2026-09-01');
      expect(entry.preferredTo).toBe('2026-09-30');
      // Lo ÚNICO opcional de AG-060, y omitirlo significa «cualquiera».
      expect(entry.practitionerId).toBeNull();
      expect(entry.serviceTypeId).toBeNull();
      expect(entry.contactAttempts).toBe(0);
      expect(entry.lastContactedAt).toBeNull();
    });

    it('AG-060 keeps the practitioner when the enrolment fixes one', async () => {
      const entry = await enrol({ practitionerId });

      expect(entry.practitionerId).toBe(practitionerId);
    });

    it('AG-060 keeps the service type when the enrolment fixes one', async () => {
      const type = await createServiceType('Control');

      const entry = await enrol({ serviceTypeId: type.id });

      expect(entry.serviceTypeId).toBe(type.id);
    });

    it('AG-060 refuses an inverted preferred range by field', async () => {
      const response = await request(app.getHttpServer())
        .post(`${BASE}/${siteId}/waitlist`)
        .set('Authorization', auth())
        .send({
          patientId,
          preferredFrom: '2026-09-30',
          preferredTo: '2026-09-01',
        })
        .expect(422);

      const problem = response.body as Problem;
      expect(problem.errors?.[0]?.field).toBe('preferredTo');
    });

    it('AG-060 admits a preferred range of a single day', async () => {
      // «Sólo puedo el 3» es un rango legítimo, inclusivo por los dos lados,
      // igual que `waitlist_entry_preferred_range_valid`.
      const entry = await enrol({
        preferredFrom: '2026-09-03',
        preferredTo: '2026-09-03',
      });

      expect(entry.status).toBe('WAITING');
    });
  });

  describe('AG-061 · proponer sobre un cupo liberado', () => {
    it('AG-061 proposes the compatible entries of the site for the freed slot', async () => {
      const fits = await enrol();
      const wrongDay = await enrol({
        preferredFrom: '2026-10-01',
        preferredTo: '2026-10-31',
      });

      const released = await releasedSlot();
      const proposed = await candidatesFor(released.id);

      expect(proposed.map((c) => c.entryId)).toEqual([fits.id]);
      expect(proposed.map((c) => c.entryId)).not.toContain(wrongDay.id);
    });

    it('AG-061 refuses a slot of another practitioner when the entry fixes one', async () => {
      const another = await createPractitioner(prisma);
      await linkPractitionerToSite(prisma, another.id, siteId);
      const demandsAnother = await enrol({ practitionerId: another.id });
      const demandsThis = await enrol({ practitionerId });

      const released = await releasedSlot();
      const proposed = await candidatesFor(released.id);

      expect(proposed.map((c) => c.entryId)).toEqual([demandsThis.id]);
      expect(proposed.map((c) => c.entryId)).not.toContain(demandsAnother.id);
    });

    /**
     * AG-061, la mitad que compara los TIPOS. Estuvo escrita y probada en
     * `waitlist.spec.ts` desde E5 y no se podía comprobar de extremo a
     * extremo: la inscripción no admitía el campo, porque la columna apuntaba
     * a otra tabla. Ésta es la prueba de que las dos partes hablan de lo
     * mismo.
     */
    it('AG-061 refuses a slot of another service type when the entry fixes one', async () => {
      const control = await createServiceType('Control');
      const primeraVez = await createServiceType('Primera vez');
      const demandsAnother = await enrol({ serviceTypeId: primeraVez.id });
      const demandsThis = await enrol({ serviceTypeId: control.id });

      const released = await releasedSlot({ serviceTypeId: control.id });
      const proposed = await candidatesFor(released.id);

      expect(proposed.map((c) => c.entryId)).toEqual([demandsThis.id]);
      expect(proposed.map((c) => c.entryId)).not.toContain(demandsAnother.id);
    });

    it('AG-061 proposes an entry that fixes no type for a slot that does', async () => {
      const control = await createServiceType('Control');
      // Omitirlo significa «cualquiera», no «ninguno» (AG-060).
      const anyType = await enrol();

      const released = await releasedSlot({ serviceTypeId: control.id });
      const proposed = await candidatesFor(released.id);

      expect(proposed.map((c) => c.entryId)).toEqual([anyType.id]);
    });

    it('AG-061 refuses a released block, which fixes no type, to an entry that demands one', async () => {
      const control = await createServiceType('Control');
      const demandsOne = await enrol({ serviceTypeId: control.id });

      const released = await releasedSlot();
      const proposed = await candidatesFor(released.id);

      expect(proposed.map((c) => c.entryId)).not.toContain(demandsOne.id);
    });

    it('AG-061 refuses to propose over an entry that still occupies the calendar', async () => {
      const standing = await releasedSlot({ releasedAt: null });

      const response = await request(app.getHttpServer())
        .get(`${BASE}/${siteId}/waitlist/candidates/${standing.id}`)
        .set('Authorization', auth())
        .expect(422);

      expect((response.body as Problem).code).toBe('SLOT_NOT_RELEASED');
    });

    it('AG-061 refuses to propose over a released overbooking, which never occupied one', async () => {
      const overbooking = await releasedSlot({ blocksCalendar: false });

      const response = await request(app.getHttpServer())
        .get(`${BASE}/${siteId}/waitlist/candidates/${overbooking.id}`)
        .set('Authorization', auth())
        .expect(422);

      expect((response.body as Problem).code).toBe('SLOT_NOT_RELEASED');
    });
  });

  describe('AG-062 · la prioridad se deriva de la ficha, no de la inscripción', () => {
    it('AG-062 puts a patient with a priority group in force ahead of one enrolled earlier', async () => {
      const first = await enrol();

      const pregnant = await createPatient(prisma);
      await prisma.patientPriorityGroup.create({
        data: {
          patientId: pregnant.id,
          groupCode: 'PREGNANT',
          startsOn: new Date('2026-02-01'),
          // PA-036: un embarazo lleva siempre fecha de fin, y ésta no ha
          // pasado, así que cuenta hoy.
          endsOn: new Date('2099-01-01'),
          origin: 'SELF_DECLARED',
          recordedById: userId,
        },
      });
      const second = await enrol({}, pregnant.id);

      const released = await releasedSlot();
      const proposed = await candidatesFor(released.id);

      expect(proposed.map((c) => c.entryId)).toEqual([second.id, first.id]);
      expect(proposed[0]?.priority).toBe(1);
      expect(proposed[1]?.priority).toBe(2);
    });

    it('AG-062 derives priority 1 from the birth date alone, with no recorded group', async () => {
      const elder = await createPatient(prisma, {
        birthDate: new Date('1950-01-01'),
      });
      const standard = await enrol();
      const prioritised = await enrol({}, elder.id);

      const released = await releasedSlot();
      const proposed = await candidatesFor(released.id);

      expect(proposed.map((c) => c.entryId)).toEqual([
        prioritised.id,
        standard.id,
      ]);
    });

    it('AG-062 counts a priority group recorded on an absorbed chart for the surviving one (PA-055)', async () => {
      /**
       * The defect PA-055 exists to close, reaching the queue: the pregnancy
       * was recorded on the duplicate, admissions merged the two, and the
       * survivor stopped being prioritised — the periods hang off the absorbed
       * chart and a bare `priorityGroups` never sees them.
       */
      const survivor = await createPatient(prisma);
      const duplicate = await createPatient(prisma);
      await prisma.patientPriorityGroup.create({
        data: {
          patientId: duplicate.id,
          groupCode: 'PREGNANT',
          startsOn: new Date('2026-02-01'),
          endsOn: new Date('2099-01-01'),
          origin: 'SELF_DECLARED',
          recordedById: userId,
        },
      });
      await prisma.patient.update({
        where: { id: duplicate.id },
        data: { mergedIntoId: survivor.id, mergedAt: new Date() },
      });

      const ordinary = await enrol();
      const merged = await enrol({}, survivor.id);

      const released = await releasedSlot();
      const proposed = await candidatesFor(released.id);

      expect(proposed.map((c) => c.entryId)).toEqual([merged.id, ordinary.id]);
      expect(proposed[0]?.priority).toBe(1);
    });

    it('PA-060 la persona conserva su puesto en la cola cuando admisión fusiona sus dos fichas', async () => {
      /**
       * ═════════════════════════════════════════════════════════════════════
       * D-041 (B), Y ES EL PROPÓSITO ENTERO DEL REQUISITO
       * ═════════════════════════════════════════════════════════════════════
       *
       * Rosa se inscribe primero, con ficha duplicada. Alguien se inscribe
       * DESPUÉS. Admisión fusiona las dos fichas de Rosa —correctamente— y
       * hasta PA-060 eso la mandaba al final de la cola: su entrada colgaba de
       * la absorbida y `rankWaiting` la descarta (no podría convertirse en
       * cita), así que el único candidato compatible era el que llegó después.
       *
       * La fusión es un acto administrativo; la cola es un reparto. AG-061
       * promete que el turno es del ORDEN DE LLEGADA DE LA PERSONA.
       */
      const duplicate = await createPatient(prisma);
      const survivor = await createPatient(prisma);

      const early = await enrol({}, duplicate.id);
      const later = await enrol({});

      await merges.merge(
        {
          sourcePatientId: duplicate.id,
          targetPatientId: survivor.id,
          reason: 'la misma persona registrada dos veces en admisión',
        },
        { userId },
      );

      const released = await releasedSlot();
      const proposed = await candidatesFor(released.id);

      // La ficha vigente va PRIMERA, con la antigüedad de la inscripción
      // original, y por delante de quien se inscribió después.
      expect(proposed.map((candidate) => candidate.patientId)).toEqual([
        survivor.id,
        patientId,
      ]);
      // Y la entrada de la ficha absorbida NO se propone: reservar sobre ella
      // se rechaza (AG-027), así que ofrecerla sería ofrecer un cupo que nadie
      // puede tomar.
      expect(proposed.map((candidate) => candidate.entryId)).not.toContain(
        early.id,
      );
      expect(proposed[1]?.entryId).toBe(later.id);
    });

    it('AG-062 never returns the reason somebody is prioritised', async () => {
      const pregnant = await createPatient(prisma);
      await prisma.patientPriorityGroup.create({
        data: {
          patientId: pregnant.id,
          groupCode: 'PREGNANT',
          startsOn: new Date('2026-02-01'),
          endsOn: new Date('2099-01-01'),
          origin: 'SELF_DECLARED',
          recordedById: userId,
        },
      });
      await enrol({}, pregnant.id);

      const released = await releasedSlot();
      const response = await request(app.getHttpServer())
        .get(`${BASE}/${siteId}/waitlist/candidates/${released.id}`)
        .set('Authorization', auth())
        .expect(200);

      // PA-042, AG-073: el número sí, el motivo nunca — y tampoco el nombre.
      expect(JSON.stringify(response.body)).not.toMatch(
        /PREGNANT|Guamán|María|groupCode/,
      );
    });
  });

  describe('AG-064 · cada intento, y no reasignar sin confirmación', () => {
    it('AG-064 records the attempt with its instant and its author, and derives the count', async () => {
      const entry = await enrol();

      const first = await request(app.getHttpServer())
        .post(`${BASE}/${siteId}/waitlist/${entry.id}/contact-attempts`)
        .set('Authorization', auth())
        .send({ outcome: 'NO_ANSWER' })
        .expect(200);

      const body = first.body as WaitlistEntryBody;
      expect(body.status).toBe('CONTACTED');
      expect(body.contactAttempts).toBe(1);
      expect(body.lastContactedAt).not.toBeNull();

      // El autor sale de la sesión, nunca del cuerpo.
      const trail = await prisma.waitlistContactAttempt.findMany({
        where: { waitlistEntryId: entry.id },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]?.recordedById).toBe(userId);
      expect(trail[0]?.outcome).toBe('NO_ANSWER');
    });

    it('AG-064 refuses to convert while no acceptance is on record', async () => {
      const entry = await enrol();
      const appointment = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId,
          patientId,
          practitionerId,
          startsAt: new Date(Date.UTC(2026, 8, 21, 13, 0)),
          endsAt: new Date(Date.UTC(2026, 8, 21, 13, 20)),
        },
      });

      // Dos llamadas sin respuesta NO son una confirmación, y son justo el
      // caso en que la tentación de darle el cupo igual es mayor.
      for (const outcome of ['NO_ANSWER', 'DECLINED']) {
        await request(app.getHttpServer())
          .post(`${BASE}/${siteId}/waitlist/${entry.id}/contact-attempts`)
          .set('Authorization', auth())
          .send({ outcome })
          .expect(200);
      }

      const response = await request(app.getHttpServer())
        .post(`${BASE}/${siteId}/waitlist/${entry.id}/conversion`)
        .set('Authorization', auth())
        .send({ appointmentId: appointment.id })
        .expect(422);

      // El disparador llega por SQLSTATE y sin nombre de constraint: sin la
      // traducción del adaptador esto sería un `CHECK_FAILED` genérico.
      expect((response.body as Problem).code).toBe(
        'WAITLIST_ACCEPTANCE_REQUIRED',
      );

      const untouched = await prisma.waitlistEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      expect(untouched.status).toBe('CONTACTED');
      expect(untouched.convertedEntryId).toBeNull();
    });

    it('AG-064 refuses to link an appointment of another chart', async () => {
      const entry = await enrol();
      await accept(entry.id);

      const someoneElse = await createPatient(prisma);
      const theirs = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId,
          patientId: someoneElse.id,
          practitionerId,
          startsAt: new Date(Date.UTC(2026, 8, 21, 14, 0)),
          endsAt: new Date(Date.UTC(2026, 8, 21, 14, 20)),
        },
      });

      const response = await request(app.getHttpServer())
        .post(`${BASE}/${siteId}/waitlist/${entry.id}/conversion`)
        .set('Authorization', auth())
        .send({ appointmentId: theirs.id })
        .expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('WAITLIST_PATIENT_MISMATCH');
      // AG-074, SC-006: ni nombre ni documento del otro paciente.
      expect(JSON.stringify(problem)).not.toMatch(/Guamán|María/);
    });
  });

  describe('AG-063 · convertir en cita', () => {
    it('AG-063 marks the entry SCHEDULED and links the appointment once the acceptance is on record', async () => {
      const entry = await enrol();
      await accept(entry.id);

      const appointment = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId,
          patientId,
          practitionerId,
          startsAt: new Date(Date.UTC(2026, 8, 21, 15, 0)),
          endsAt: new Date(Date.UTC(2026, 8, 21, 15, 20)),
        },
      });

      const response = await request(app.getHttpServer())
        .post(`${BASE}/${siteId}/waitlist/${entry.id}/conversion`)
        .set('Authorization', auth())
        .send({ appointmentId: appointment.id })
        .expect(200);

      const body = response.body as WaitlistEntryBody;
      expect(body.status).toBe('SCHEDULED');
      expect(body.convertedEntryId).toBe(appointment.id);

      // Y las dos columnas van juntas en la fila, que es lo que
      // `waitlist_entry_conversion_complete` exige.
      const stored = await prisma.waitlistEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      expect(stored.status).toBe('SCHEDULED');
      expect(stored.convertedEntryId).toBe(appointment.id);
    });

    it('AG-063 refuses to give one appointment to two entries', async () => {
      const appointment = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId,
          patientId,
          practitionerId,
          startsAt: new Date(Date.UTC(2026, 8, 21, 16, 0)),
          endsAt: new Date(Date.UTC(2026, 8, 21, 16, 20)),
        },
      });

      const first = await enrol();
      const second = await enrol();
      await accept(first.id);
      await accept(second.id);

      await request(app.getHttpServer())
        .post(`${BASE}/${siteId}/waitlist/${first.id}/conversion`)
        .set('Authorization', auth())
        .send({ appointmentId: appointment.id })
        .expect(200);

      const response = await request(app.getHttpServer())
        .post(`${BASE}/${siteId}/waitlist/${second.id}/conversion`)
        .set('Authorization', auth())
        .send({ appointmentId: appointment.id })
        .expect(409);

      expect((response.body as Problem).code).toBe(
        'WAITLIST_SLOT_ALREADY_CLAIMED',
      );
    });
  });

  describe('AG-065 · caducar por fecha', () => {
    it('AG-065 marks EXPIRED the entry whose last preferred day has passed, and writes it', async () => {
      const lapsed = await enrol({
        preferredFrom: '2020-01-01',
        preferredTo: '2020-01-31',
      });
      const live = await enrol();

      // Reading the list is what performs the act: nothing HAPPENS when a date
      // passes, so no constraint can mark the row.
      const response = await request(app.getHttpServer())
        .get(`${BASE}/${siteId}/waitlist`)
        .set('Authorization', auth())
        .expect(200);

      const items = (response.body as { items: CandidateBody[] }).items;
      expect(items.map((entry) => entry.entryId)).toEqual([live.id]);

      const stored = await prisma.waitlistEntry.findUniqueOrThrow({
        where: { id: lapsed.id },
      });
      expect(stored.status).toBe('EXPIRED');
    });

    it('AG-065 does not expire an entry whose last preferred day is still ahead', async () => {
      const live = await enrol({
        preferredFrom: '2020-01-01',
        preferredTo: '2099-12-31',
      });

      await request(app.getHttpServer())
        .get(`${BASE}/${siteId}/waitlist`)
        .set('Authorization', auth())
        .expect(200);

      const stored = await prisma.waitlistEntry.findUniqueOrThrow({
        where: { id: live.id },
      });
      expect(stored.status).toBe('WAITING');
    });
  });

  describe('AG-066 · caducar por agotar los intentos de la sede', () => {
    it('AG-066 expires the entry on the attempt that reaches the cap, and stops proposing it', async () => {
      // Dos, para que la prueba dependa del parámetro de la sede y no del
      // defecto (AG-094, D-040).
      await prisma.siteParameter.update({
        where: { siteId },
        data: { waitlistMaxContactAttempts: 2 },
      });

      const entry = await enrol();

      const first = await request(app.getHttpServer())
        .post(`${BASE}/${siteId}/waitlist/${entry.id}/contact-attempts`)
        .set('Authorization', auth())
        .send({ outcome: 'NO_ANSWER' })
        .expect(200);
      expect((first.body as WaitlistEntryBody).status).toBe('CONTACTED');

      const second = await request(app.getHttpServer())
        .post(`${BASE}/${siteId}/waitlist/${entry.id}/contact-attempts`)
        .set('Authorization', auth())
        .send({ outcome: 'NO_ANSWER' })
        .expect(200);
      expect((second.body as WaitlistEntryBody).status).toBe('EXPIRED');

      const released = await releasedSlot();
      expect(await candidatesFor(released.id)).toEqual([]);
    });

    it('AG-066 obeys the cap of this site and not a number in the code', async () => {
      await prisma.siteParameter.update({
        where: { siteId },
        data: { waitlistMaxContactAttempts: 5 },
      });

      const entry = await enrol();
      for (let call = 0; call < 3; call += 1) {
        await request(app.getHttpServer())
          .post(`${BASE}/${siteId}/waitlist/${entry.id}/contact-attempts`)
          .set('Authorization', auth())
          .send({ outcome: 'NO_ANSWER' })
          .expect(200);
      }

      // Tres llamadas cierran la entrada en una sede de tres y no en una de
      // cinco, con las mismas filas y sin desplegar nada.
      const stored = await prisma.waitlistEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      expect(stored.status).toBe('CONTACTED');
    });
  });

  describe('AG-067 · una entrada cerrada no se propone ni se toca', () => {
    it('AG-067 leaves a converted entry out of the candidates for the next slot', async () => {
      const converted = await enrol();
      const stillWaiting = await enrol();
      await accept(converted.id);

      const appointment = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId,
          patientId,
          practitionerId,
          startsAt: new Date(Date.UTC(2026, 8, 21, 17, 0)),
          endsAt: new Date(Date.UTC(2026, 8, 21, 17, 20)),
        },
      });
      await request(app.getHttpServer())
        .post(`${BASE}/${siteId}/waitlist/${converted.id}/conversion`)
        .set('Authorization', auth())
        .send({ appointmentId: appointment.id })
        .expect(200);

      const released = await releasedSlot();
      const proposed = await candidatesFor(released.id);

      expect(proposed.map((c) => c.entryId)).toEqual([stillWaiting.id]);
    });

    it('AG-067 refuses to record a contact on an entry that already expired', async () => {
      const lapsed = await enrol({
        preferredFrom: '2020-01-01',
        preferredTo: '2020-01-31',
      });

      const response = await request(app.getHttpServer())
        .post(`${BASE}/${siteId}/waitlist/${lapsed.id}/contact-attempts`)
        .set('Authorization', auth())
        .send({ outcome: 'NO_ANSWER' })
        .expect(409);

      expect((response.body as Problem).code).toBe('WAITLIST_ENTRY_CLOSED');

      // Y no ha quedado ninguna llamada registrada sobre una cola en la que ya
      // no está.
      const trail = await prisma.waitlistContactAttempt.findMany({
        where: { waitlistEntryId: lapsed.id },
      });
      expect(trail).toEqual([]);
    });
  });

  describe('AG-070, AG-071 · permiso y alcance por sede', () => {
    it('AG-070 refuses every waiting list route without a token', async () => {
      const entry = await enrol();

      for (const call of [
        request(app.getHttpServer()).get(`${BASE}/${siteId}/waitlist`),
        request(app.getHttpServer()).post(`${BASE}/${siteId}/waitlist`).send({
          patientId,
          preferredFrom: '2026-09-01',
          preferredTo: '2026-09-30',
        }),
        request(app.getHttpServer())
          .post(`${BASE}/${siteId}/waitlist/${entry.id}/contact-attempts`)
          .send({ outcome: 'NO_ANSWER' }),
      ]) {
        await call.expect(401);
      }
    });

    it('AG-071 refuses the waiting list of a site the caller has no scope over', async () => {
      const response = await request(app.getHttpServer())
        .get(`${BASE}/${otherSiteId}/waitlist`)
        .set('Authorization', auth())
        .expect(403);

      expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
    });

    it('AG-071 answers the same for an entry of another site as for one that does not exist', async () => {
      const elsewhere = await prisma.waitlistEntry.create({
        data: {
          siteId: otherSiteId,
          patientId,
          preferredFrom: new Date('2026-09-01'),
          preferredTo: new Date('2026-09-30'),
        },
      });

      const foreign = await request(app.getHttpServer())
        .post(`${BASE}/${siteId}/waitlist/${elsewhere.id}/contact-attempts`)
        .set('Authorization', auth())
        .send({ outcome: 'NO_ANSWER' })
        .expect(404);

      const missing = await request(app.getHttpServer())
        .post(
          `${BASE}/${siteId}/waitlist/00000000-0000-4000-8000-00000000dead/contact-attempts`,
        )
        .set('Authorization', auth())
        .send({ outcome: 'NO_ANSWER' })
        .expect(404);

      // Distinguirlas confirmaría quién espera en sedes ajenas a quien prueba
      // identificadores.
      expect((foreign.body as Problem).code).toBe('WAITLIST_ENTRY_NOT_FOUND');
      expect((missing.body as Problem).code).toBe('WAITLIST_ENTRY_NOT_FOUND');
    });
  });
});
