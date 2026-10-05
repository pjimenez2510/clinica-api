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
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { contentHashOf } from '../../src/modules/encounter/domain/clinical-note';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite, hourSlot } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * The attention as the browser consumes it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ADDS OVER THE REPOSITORY SUITES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything BETWEEN the browser and the database: the permission, the site
 * scope, the shape of a refusal under RFC 9457, and the exact `code` a client
 * branches on — plus the two things the specification insists cannot be shown
 * with a double:
 *
 *  - EN-141, EN-142, EN-066: WITH A REAL SESSION. «El defecto de AG-111 fue
 *    exactamente confiar en un doble con los permisos puestos a mano.» So the
 *    nurse below signs in, gets a token, and the roles are the ones the seed
 *    ships.
 *  - EN-017, EN-122, EN-123: COUNTING ROWS of `access_audit`. Opening leaves
 *    one, listing leaves zero, a 404 leaves none.
 */
const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

interface EncounterBody {
  id: string;
  status: string;
  ageYears: number | null;
  ageDays: number | null;
  dischargeCondition: string | null;
  closedById: string | null;
  closedBySubstituteReason: string | null;
}

interface NoteBody {
  id: string;
  status: string;
  version: number;
  chainId: string;
  contentHash: string | null;
  supersedesId: string | null;
}

const COMPLETE_002 = {
  motivoConsulta: 'Dolor abdominal de dos días',
  antecedentes: 'Sin antecedentes patológicos de importancia',
  enfermedadActual: 'Dolor en epigastrio, sin irradiación',
  revisionOrganosSistemas: 'Resto de sistemas sin particularidades',
  examenFisico: 'Abdomen blando, doloroso a la palpación',
  planTratamiento: 'Dieta blanda y control en 72 horas',
};

/**
 * The same form MINUS one section, without a destructuring the linter reads as
 * a dead variable. Built by omission rather than by listing the survivors so
 * adding a mandatory section to the 002 does not silently make this a
 * different test.
 */
function without(section: keyof typeof COMPLETE_002) {
  return Object.fromEntries(
    Object.entries(COMPLETE_002).filter(([name]) => name !== section),
  );
}

describe('la atención por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let otherSiteId: string;
  let patientId: string;
  let doctorToken: string;
  let doctorPractitionerId: string;
  let nurseToken: string;
  let receptionToken: string;
  let secondDoctorToken: string;
  let secondDoctorPractitionerId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // Sin límite de peticiones AQUÍ, por lo mismo que en `agenda-http`:
        // este fichero hace una veintena seguidas. Se sustituye el ALMACÉN, no
        // el guard: `APP_GUARD` cubre también el de autorización, que es
        // precisamente lo que estas pruebas comprueban.
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
    }

    await seed();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function seed(): Promise<void> {
    await syncAuthorisation(prisma);
    // La caché de rol→permisos se indexa por id, y al truncar los roles se
    // recrean con ids nuevos: sin esto todas las peticiones responden 403.
    registry.invalidate();

    const site = await createSite(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    const patient = await createPatient(prisma);

    siteId = site.id;
    otherSiteId = otherSite.id;
    patientId = patient.id;

    const doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    doctorToken = doctor.token;
    doctorPractitionerId = doctor.practitionerId as string;

    const second = await signIn('MEDICO', 'medico2@clinica.ec', '0602910945');
    secondDoctorToken = second.token;
    secondDoctorPractitionerId = second.practitionerId as string;

    nurseToken = (
      await signIn('ENFERMERIA', 'enfermeria@clinica.ec', '1104637283')
    ).token;
    receptionToken = (
      await signIn('RECEPCION', 'recepcion@clinica.ec', '0926687856', false)
    ).token;
  }

  /**
   * One account with one role, granted AT ONE SITE — which is what makes
   * EN-121 checkable at all.
   *
   * Las cédulas son sintéticas con dígito verificador calculado, nunca las de
   * una persona real: `app_user_cedula_valid` rechaza cualquier otra cosa.
   */
  async function signIn(
    roleCode: string,
    email: string,
    cedula: string,
    withPractitioner = true,
  ): Promise<{ token: string; practitionerId?: string }> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Ana',
        lastName: 'Villacís',
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });

    const practitioner = withPractitioner
      ? await prisma.practitioner.create({ data: { userId: user.id } })
      : undefined;

    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    // EN UNA SEDE, no en todas: es lo que hace comprobable EN-121.
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId },
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return {
      token: (response.body as { accessToken: string }).accessToken,
      practitionerId: practitioner?.id,
    };
  }

  const openBody = (overrides: Record<string, unknown> = {}) => ({
    siteId,
    practitionerId: doctorPractitionerId,
    patientId,
    startedAt: '2026-08-14T14:00:00Z',
    careModality: 'MORBIDITY',
    visitSequence: 'FIRST_TIME',
    ...overrides,
  });

  const post = (path: string, token: string, body?: object) =>
    request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body ?? {});

  const put = (path: string, token: string, body: object) =>
    request(app.getHttpServer())
      .put(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const get = (path: string, token: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`);

  /** Opens an attention with the doctor's session and returns its id. */
  async function openEncounter(
    token = doctorToken,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await post('/encounters', token, openBody(overrides));
    expect(response.status).toBe(201);
    return (response.body as EncounterBody).id;
  }

  const auditRows = (resourceType?: string) =>
    prisma.accessAudit.count({
      where: resourceType === undefined ? {} : { resourceType },
    });

  describe('quién puede abrir la atención', () => {
    it('EN-120 rechaza abrir una atención sin sesión', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/encounters')
        .send(openBody())
        .expect(401);
    });

    it('EN-141 deja a RECEPCIÓN abrir la atención con `encounter:open`', async () => {
      /**
       * ⚠️ NO ES UNA RELAJACIÓN: el art. 11 del A.M. 00115-2021 pone la
       * apertura de la historia en «personal de Gestión de Admisiones», así
       * que abrir es un acto ADMINISTRATIVO. Con `record:write` —que sólo
       * tiene `MEDICO`— recepción no podía abrir nada.
       */
      const response = await post(
        '/encounters',
        receptionToken,
        openBody(),
      ).expect(201);

      expect((response.body as EncounterBody).status).toBe('OPEN');
    });

    it('EN-141 deja a ENFERMERÍA abrir la atención, que es lo que desbloquea EN-066', async () => {
      await post('/encounters', nurseToken, openBody()).expect(201);
    });

    it('EN-141 no autoriza a escribir en la historia con `encounter:open`', async () => {
      /**
       * ⚠️ LO QUE EL PERMISO NIEGA ES TAN IMPORTANTE COMO LO QUE CONCEDE.
       * Recepción abre la atención y NO puede abrir una nota clínica: si
       * pudiera, `encounter:open` sería `record:write` con otro nombre.
       */
      const encounterId = await openEncounter(receptionToken);

      await post(`/encounters/${encounterId}/notes`, receptionToken, {
        formCode: '002',
        content: COMPLETE_002,
      }).expect(403);
    });

    it('EN-121 rechaza abrir una atención en una sede fuera del alcance', async () => {
      const response = await post(
        '/encounters',
        doctorToken,
        openBody({ siteId: otherSiteId }),
      ).expect(403);

      const problem = response.body as Problem;
      expect(problem.code).toBe('SITE_SCOPE_DENIED');
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
    });

    it('EN-001 rechaza abrir una atención de un paciente sin ficha', async () => {
      const response = await post(
        '/encounters',
        doctorToken,
        openBody({ patientId: '00000000-0000-4000-8000-00000000dead' }),
      ).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('PATIENT_CHART_NOT_OPEN');
      expect(problem.errors?.[0]?.field).toBe('patientId');
    });

    it('EN-005 rechaza atender una cita anulada con el reverso de AGENDA_ENTRY_HAS_ENCOUNTER', async () => {
      const practitioner = await prisma.practitioner.findUniqueOrThrow({
        where: { id: doctorPractitionerId },
      });
      const appointment = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'PHONE',
          siteId,
          practitionerId: practitioner.id,
          patientId,
          status: 'CANCELLED',
          cancelledAt: new Date(),
          releasedAt: new Date(),
          ...hourSlot(9),
        },
      });

      const response = await post(
        '/encounters',
        doctorToken,
        openBody({ agendaEntryId: appointment.id }),
      ).expect(409);

      expect((response.body as Problem).code).toBe(
        'APPOINTMENT_NOT_ATTENDABLE',
      );
    });
  });

  describe('el listado de la historia de una ficha', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * ⚠️ CORTAR EN EL CLIENTE NO ERA PAGINAR
     * ═══════════════════════════════════════════════════════════════════════
     *
     * La ficha del paciente se traía las atenciones enteras y pintaba veinte.
     * Eso reduce lo que el navegador dibuja, NO lo que viaja por la red, y el
     * paciente crónico de diez años es exactamente el caso que lo rompe.
     */
    const history = (query: string) =>
      get(`/encounters?patientId=${patientId}${query}`, doctorToken);

    const openSeven = async (): Promise<void> => {
      for (let index = 0; index < 7; index += 1) {
        await openEncounter(doctorToken, {
          startedAt: `2026-03-0${String(index + 1)}T14:00:00Z`,
        });
      }
    };

    it('EN-162 devuelve sólo la página pedida y el total de la historia', async () => {
      await openSeven();

      const response = await history('&page=1&pageSize=3').expect(200);
      const body = response.body as {
        items: EncounterBody[];
        total: number;
        page: number;
        pageSize: number;
      };

      expect(body.items).toHaveLength(3);
      // El total es lo que permite escribir «3 de 7» sin traerlas todas.
      expect(body.total).toBe(7);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(3);
    });

    it('EN-162 sirve páginas disjuntas: ninguna atención se repite ni se pierde', async () => {
      // El orden es total —instante y luego identificador—, que es lo que
      // impide que dos atenciones del mismo instante salgan en dos páginas
      // distintas mientras una no sale nunca.
      await openSeven();

      const pages = await Promise.all([
        history('&page=1&pageSize=3'),
        history('&page=2&pageSize=3'),
        history('&page=3&pageSize=3'),
      ]);
      const ids = pages.flatMap((page) =>
        (page.body as { items: EncounterBody[] }).items.map((row) => row.id),
      );

      expect(ids).toHaveLength(7);
      expect(new Set(ids).size).toBe(7);
    });

    it('EN-162 no admite pedirlas todas: el tamaño de página tiene tope', async () => {
      // Un tope alto sería volver a ofrecer «tráemelas todas» con otro nombre.
      // La historia de una persona crece sin final, así que el tope es el bajo
      // —el del registro de pacientes— y no el del catálogo.
      const response = await history('&pageSize=500').expect(422);

      expect((response.body as Problem).code).toBe('VALIDATION_FAILED');
    });

    it('EN-162 sin página pedida responde la primera, y no la historia entera', async () => {
      // Un contrato sin defecto obliga a cada cliente a inventarse uno, y el
      // que se inventa el cliente que no lo pensó es «todas».
      await openSeven();

      const body = (await history('').expect(200)).body as {
        items: EncounterBody[];
        page: number;
        pageSize: number;
      };

      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(20);
      expect(body.items).toHaveLength(7);
    });

    it('EN-124 la página no lleva contenido clínico: ni diagnóstico, ni nota, ni signos', async () => {
      /**
       * ⚠️ ES LA CONDICIÓN DE QUE ESTA LECTURA NO SE AUDITE (EN-123). Un
       * listado con contenido clínico convierte cada apertura de la pantalla
       * en la lectura de cuarenta historias sin dejar rastro en la bitácora.
       * Paginar cambia cuántos identificadores viajan y nada más.
       */
      const encounterId = await openEncounter();
      await post(`/encounters/${encounterId}/vitals/start`, doctorToken).expect(
        200,
      );

      const response = await history('').expect(200);
      const [first] = (response.body as { items: object[] }).items;
      const keys = Object.keys(first ?? {});

      expect(keys).not.toContain('allergies');
      expect(keys).not.toContain('diagnoses');
      expect(keys).not.toContain('vitals');
      expect(keys).not.toContain('notes');
    });
  });

  describe('la bitácora de accesos', () => {
    it('EN-017 deja EXACTAMENTE una fila al abrir la atención', async () => {
      await openEncounter();

      await expect(auditRows('encounter')).resolves.toBe(1);
    });

    it('EN-123 no deja NINGUNA fila al listar atenciones', async () => {
      /**
       * SC-017: «El 100 % de las aperturas de atención deja exactamente una
       * fila en la bitácora; listar las atenciones del día deja CERO.»
       * Registrar cada fila de cada listado entierra los accesos que importan.
       */
      const encounterId = await openEncounter();
      const before = await auditRows();

      await get(`/encounters?patientId=${patientId}`, doctorToken).expect(200);
      await get('/encounters/open', doctorToken).expect(200);

      await expect(auditRows()).resolves.toBe(before);
      expect(encounterId).toBeTruthy();
    });

    it('EN-122 deja una fila al ABRIR una atención concreta', async () => {
      const encounterId = await openEncounter();
      const before = await auditRows();

      await get(`/encounters/${encounterId}`, doctorToken).expect(200);

      await expect(auditRows()).resolves.toBe(before + 1);
    });

    it('EN-122 no deja ninguna fila cuando la atención no existe', async () => {
      // No hay titular al que rendir cuentas, y una fila por identificador
      // adivinado dejaría llenar el rastro de ruido (el criterio de PA-024).
      await openEncounter();
      const before = await auditRows();

      await get(
        '/encounters/00000000-0000-4000-8000-00000000beef',
        doctorToken,
      ).expect(404);

      await expect(auditRows()).resolves.toBe(before);
    });
  });

  describe('los signos vitales', () => {
    it('EN-066 deja a ENFERMERÍA registrar los signos sin `record:write` ni nota clínica', async () => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * EL REQUISITO QUE ERA IMPOSIBLE DE CUMPLIR HASTA D-A-003
       * ═══════════════════════════════════════════════════════════════════════
       *
       * `POST /encounters` exigía `record:write`, que sólo tiene `MEDICO`, y
       * `encounter_vitals.encounter_id` es clave primaria: los signos no
       * existen sin una atención abierta. Enfermería no podía abrir la
       * atención donde colgarlos. Aquí abre y escribe, con una sesión real.
       */
      const encounterId = await openEncounter(nurseToken);

      const response = await put(
        `/encounters/${encounterId}/vitals`,
        nurseToken,
        { weightKg: 68.4, heightCm: 165, heightPosition: 'STANDING' },
      ).expect(200);

      expect(response.body).toMatchObject({ weightKg: 68.4, bmi: 25.12 });
    });

    it('EN-061 devuelve el IMC calculado y RECHAZA el que venga en la petición', async () => {
      const encounterId = await openEncounter(nurseToken);

      const response = await put(
        `/encounters/${encounterId}/vitals`,
        nurseToken,
        {
          weightKg: 68.4,
          heightCm: 165,
          heightPosition: 'STANDING',
          bmi: 99.9,
        },
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('BMI_IS_DERIVED');
      expect(problem.errors?.[0]?.field).toBe('bmi');
      // Y no se escribió nada: el rechazo llega antes que la fila.
      await expect(prisma.encounterVitals.count()).resolves.toBe(0);
    });

    it('EN-062 rechaza un peso de 750 kg con el mensaje de la base, no con un 500', async () => {
      const encounterId = await openEncounter(nurseToken);

      const response = await put(
        `/encounters/${encounterId}/vitals`,
        nurseToken,
        { weightKg: 750, heightCm: 175, heightPosition: 'STANDING' },
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('VITALS_OUT_OF_RANGE');
      // «Por campo, señalando cuál»: the nurse is told WHICH box, not «alguno».
      expect(problem.errors?.[0]?.field).toBe('weightKg');
      expect(problem.errors?.[0]?.message).toContain('entre 0.3 y 400 kg');
    });

    it('EN-062 rechaza una temperatura de 370 °C señalando la temperatura (D-058)', async () => {
      const encounterId = await openEncounter(nurseToken);

      const response = await put(
        `/encounters/${encounterId}/vitals`,
        nurseToken,
        { temperatureC: 370 },
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('VITALS_OUT_OF_RANGE');
      expect(problem.errors?.[0]?.field).toBe('temperatureC');
      expect(problem.errors?.[0]?.message).toContain('entre 25 y 45 °C');
      await expect(prisma.encounterVitals.count()).resolves.toBe(0);
    });

    it('EN-142 rechaza que ENFERMERÍA abra o firme una nota de consulta externa', async () => {
      /**
       * ⚠️ LO QUE EL PERMISO NIEGA ES EL REQUISITO. La LOS art. 198 exige
       * «limitar sus acciones al área que el título les asigne», así que
       * `nursing:write` no puede ser un `record:write` con otro nombre:
       * enfermería no diagnostica, no prescribe y no firma la nota del médico.
       */
      const encounterId = await openEncounter(nurseToken);

      await post(`/encounters/${encounterId}/notes`, nurseToken, {
        formCode: '002',
        content: COMPLETE_002,
      }).expect(403);
    });
  });

  describe('la preparación de enfermería (F-03)', () => {
    it('EN-163 enfermeria guarda el motivo con los signos, y la toma la nombra a ella', async () => {
      const encounterId = await openEncounter(nurseToken);

      const response = await put(
        `/encounters/${encounterId}/vitals`,
        nurseToken,
        {
          weightKg: 68.4,
          heightCm: 165,
          heightPosition: 'STANDING',
          hemoglobinGDl: 12.4,
          presentingComplaint: '  Dolor de cabeza desde el lunes  ',
        },
      ).expect(200);

      const body = response.body as {
        presentingComplaint: string;
        heightPosition: string;
        hemoglobinGDl: number;
        recordedBy: { id: string; name: string };
      };
      expect(body.presentingComplaint).toBe('Dolor de cabeza desde el lunes');
      expect(body.heightPosition).toBe('STANDING');
      expect(body.hemoglobinGDl).toBe(12.4);
      const nurse = await prisma.user.findUniqueOrThrow({
        where: { email: 'enfermeria@clinica.ec' },
      });
      expect(body.recordedBy.id).toBe(nurse.id);
    });

    it('EN-063 exige por HTTP el perimetro cefalico a un menor de 5 años, con la edad que congela la base, y no a un adulto', async () => {
      /**
       * The F-03 walk now books its own adult patient, so it no longer meets
       * this rule by chance. This is where the whole chain is shown: the age
       * `trg_encounter_freeze_age` writes when the attention opens, the
       * service, and the 422 per box. Ages derive from the opening instant.
       */
      const opened = new Date(openBody().startedAt);
      const yearsBefore = (years: number) =>
        new Date(
          Date.UTC(
            opened.getUTCFullYear() - years,
            opened.getUTCMonth(),
            opened.getUTCDate(),
          ),
        );
      const taking = {
        weightKg: 12.1,
        heightCm: 86,
        heightPosition: 'STANDING',
      };

      const child = await createPatient(prisma, { birthDate: yearsBefore(2) });
      const childEncounter = await openEncounter(nurseToken, {
        patientId: child.id,
      });
      const refused = await put(
        `/encounters/${childEncounter}/vitals`,
        nurseToken,
        taking,
      ).expect(422);
      const problem = refused.body as Problem;
      expect(problem.code).toBe('VITALS_REQUIRED');
      expect(problem.errors?.map((error) => error.field)).toEqual([
        'headCircumferenceCm',
      ]);
      await expect(
        prisma.encounterVitals.count({
          where: { encounterId: childEncounter },
        }),
      ).resolves.toBe(0);

      // Positive control, same child: with the head circumference it saves.
      await put(`/encounters/${childEncounter}/vitals`, nurseToken, {
        ...taking,
        headCircumferenceCm: 48,
      }).expect(200);

      // And an adult is not asked for it.
      const adult = await createPatient(prisma, { birthDate: yearsBefore(40) });
      const adultEncounter = await openEncounter(nurseToken, {
        patientId: adult.id,
      });
      await put(
        `/encounters/${adultEncounter}/vitals`,
        nurseToken,
        taking,
      ).expect(200);
    });

    it('EN-064 rechaza por HTTP una talla sin posicion, senalando la casilla', async () => {
      const encounterId = await openEncounter(nurseToken);

      const response = await put(
        `/encounters/${encounterId}/vitals`,
        nurseToken,
        {
          heightCm: 165,
        },
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('VITALS_HEIGHT_POSITION_REQUIRED');
      expect(problem.errors?.[0]?.field).toBe('heightPosition');
    });

    it('EN-164 enfermeria registra una alergia y afirma sin alergias conocidas, y no puede descartarlas', async () => {
      const other = await createPatient(prisma);

      const recorded = await post(
        `/patients/${patientId}/allergies`,
        nurseToken,
        {
          substanceText: 'Penicilina',
          criticality: 'HIGH',
        },
      ).expect(201);
      const allergyId = (recorded.body as { id: string }).id;

      await post(`/patients/${other.id}/allergies/none-known`, nurseToken).expect(201); // prettier-ignore

      // Descartar es juicio clínico: sigue con `record:write`. Control
      // positivo: el médico, por la misma ruta, sí.
      await post(
        `/patients/${patientId}/allergies/${allergyId}/refute`,
        nurseToken,
        {
          notes: 'Prueba cutánea negativa',
        },
      ).expect(403);
      await post(
        `/patients/${patientId}/allergies/${allergyId}/refute`,
        doctorToken,
        {
          notes: 'Prueba cutánea negativa',
        },
      ).expect(200);
    });

    it('EN-085 enfermeria registra un antecedente familiar y lo ve en el resumen de la consulta; descartarlo no', async () => {
      const recorded = await post(
        `/patients/${patientId}/history`,
        nurseToken,
        {
          kind: 'FAMILY',
          description: 'Diabetes tipo 2',
          relative: 'Madre',
        },
      ).expect(201);
      const historyId = (recorded.body as { id: string }).id;

      const encounterId = await openEncounter(nurseToken);
      const summary = await get(
        `/encounters/${encounterId}/chart-summary`,
        doctorToken,
      ).expect(200);
      expect(
        (summary.body as { history: { id: string }[] }).history.map(
          (entry) => entry.id,
        ),
      ).toEqual([historyId]);

      await post(
        `/patients/${patientId}/history/${historyId}/refute`,
        nurseToken,
        {
          notes: 'Era la tía',
        },
      ).expect(403);
      await post(
        `/patients/${patientId}/history/${historyId}/refute`,
        doctorToken,
        {
          notes: 'Era la tía',
        },
      ).expect(200);
    });

    it('EN-085 exige el parentesco en un antecedente familiar', async () => {
      const response = await post(
        `/patients/${patientId}/history`,
        nurseToken,
        {
          kind: 'FAMILY',
          description: 'Diabetes tipo 2',
        },
      ).expect(422);

      expect((response.body as Problem).errors?.[0]?.field).toBe('relative');
    });

    it('EN-164 recepcion no registra alergias: el permiso nuevo no se reparte a quien no lo declara', async () => {
      await post(`/patients/${patientId}/allergies`, receptionToken, {
        substanceText: 'Penicilina',
        criticality: 'HIGH',
      }).expect(403);
    });
  });

  describe('la plantilla de la nota de consulta', () => {
    const minimum = () =>
      [
        ['motivoConsulta', 'Motivo'],
        ['antecedentes', 'Antecedentes'],
        ['enfermedadActual', 'Enfermedad actual'],
        ['revisionOrganosSistemas', 'Revisión por sistemas'],
        ['examenFisico', 'Examen físico'],
        ['planTratamiento', 'Plan'],
      ].map(([key, title]) => ({
        key,
        title,
        help: '',
        kind: 'TEXT',
        required: true,
      }));

    it('EN-200 la publica quien administra la configuración, y el médico no', async () => {
      const admin = await signIn('ADMIN', 'admin@clinica.ec', '1710034073', false); // prettier-ignore
      const body = { sections: minimum() };

      await post('/note-templates', doctorToken, body).expect(403);
      const published = await post('/note-templates', admin.token, body).expect(201); // prettier-ignore
      expect(published.body).toMatchObject({ version: 1, specialtyId: null });

      const list = await get('/note-templates', admin.token).expect(200);
      expect(
        (list.body as { items: { version: number }[] }).items[0]?.version,
      ).toBe(1);
    });

    it('EN-201 rechaza publicar sin una sección del mínimo, nombrándola', async () => {
      const admin = await signIn('ADMIN', 'admin@clinica.ec', '1710034073', false); // prettier-ignore

      const refused = await post('/note-templates', admin.token, {
        sections: minimum().filter((section) => section.key !== 'examenFisico'),
      }).expect(422);

      const problem = refused.body as Problem;
      expect(problem.code).toBe('NOTE_TEMPLATE_INVALID');
      expect(problem.errors?.[0]?.message).toContain('Examen físico');
    });

    it('EN-203 a EN-205 la nota se abre con la plantilla publicada y exige su sección propia', async () => {
      const admin = await signIn('ADMIN', 'admin@clinica.ec', '1710034073', false); // prettier-ignore
      await post('/note-templates', admin.token, {
        sections: [
          ...minimum(),
          {
            title: 'Hallazgos odontológicos',
            help: '',
            kind: 'CHOICE',
            options: ['Caries', 'Sin hallazgos'],
            required: true,
          },
        ],
      }).expect(201);

      const encounterId = await openEncounter();
      const draft = await post(
        `/encounters/${encounterId}/notes`,
        doctorToken,
        {
          formCode: '002',
          content: COMPLETE_002,
        },
      ).expect(201);
      const note = draft.body as NoteBody & {
        template: {
          version: number;
          sections: { key: string; title: string }[];
        };
      };
      expect(note.template.version).toBe(1);
      expect(note.template.sections.at(-1)).toMatchObject({
        key: 'extra1',
        title: 'Hallazgos odontológicos',
      });

      const refused = await post(
        `/encounters/${encounterId}/notes/${note.id}/sign`,
        doctorToken,
        { dischargeCondition: 'ALIVE' },
      ).expect(422);
      expect((refused.body as Problem).errors?.[0]?.field).toBe(
        'content.extra1',
      );

      // Control positivo: con una de sus opciones, firma.
      await request(app.getHttpServer())
        .patch(`/api/v1/encounters/${encounterId}/notes/${note.id}`)
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ content: { ...COMPLETE_002, extra1: 'Caries' } })
        .expect(200);
      await post(
        `/encounters/${encounterId}/notes/${note.id}/sign`,
        doctorToken,
        {
          dischargeCondition: 'ALIVE',
        },
      ).expect(200);
    });
  });

  describe('la nota clínica y el alta', () => {
    it('EN-020 a EN-027 abre, firma y da el alta clínica en un solo acto', async () => {
      const encounterId = await openEncounter();

      const draft = await post(
        `/encounters/${encounterId}/notes`,
        doctorToken,
        {
          formCode: '002',
          content: COMPLETE_002,
        },
      ).expect(201);
      const note = draft.body as NoteBody;
      expect(note.status).toBe('DRAFT');
      expect(note.chainId).toBe(note.id);

      const signed = await post(
        `/encounters/${encounterId}/notes/${note.id}/sign`,
        doctorToken,
        { dischargeCondition: 'ALIVE' },
      ).expect(200);
      expect((signed.body as NoteBody).status).toBe('SIGNED');
      expect((signed.body as NoteBody).contentHash).toMatch(/^[0-9a-f]{64}$/);

      // EN-130, EN-138: firmar la nota de consulta externa ES el alta clínica.
      const after = await get(`/encounters/${encounterId}`, doctorToken).expect(200); // prettier-ignore
      expect(after.body).toMatchObject({
        status: 'DISCHARGED',
        dischargeCondition: 'ALIVE',
      });
    });

    it('EN-206 la nota firmada conserva la foto de alergias y antecedentes aunque luego se refuten, y el hash cuadra', async () => {
      const allergy = await post(
        `/patients/${patientId}/allergies`,
        doctorToken,
        {
          substanceText: 'Penicilina',
          criticality: 'HIGH',
        },
      ).expect(201);
      await post(`/patients/${patientId}/history`, doctorToken, {
        kind: 'FAMILY',
        description: 'Diabetes tipo 2',
        relative: 'Madre',
      }).expect(201);

      const encounterId = await openEncounter();
      const draft = await post(
        `/encounters/${encounterId}/notes`,
        doctorToken,
        {
          formCode: '002',
          // EN-207: sin texto en antecedentes, y una foto inventada que el
          // servidor no debe guardar.
          content: {
            ...COMPLETE_002,
            antecedentes: '',
            backgroundSnapshot: 'sin alergias',
          },
        },
      ).expect(201);
      const noteId = (draft.body as NoteBody).id;

      await post(
        `/encounters/${encounterId}/notes/${noteId}/sign`,
        doctorToken,
        {
          dischargeCondition: 'ALIVE',
        },
      ).expect(200);

      await post(
        `/patients/${patientId}/allergies/${(allergy.body as { id: string }).id}/refute`,
        doctorToken,
        { notes: 'Prueba cutánea negativa' },
      ).expect(200);

      const row = await prisma.clinicalNote.findUniqueOrThrow({
        where: { id: noteId },
      });
      const content = row.content as {
        backgroundSnapshot: {
          allergies: { substance: string }[];
          familyHistory: { description: string; relative: string }[];
        };
      };
      expect(content.backgroundSnapshot.allergies).toEqual([
        expect.objectContaining({ substance: 'Penicilina' }),
      ]);
      expect(content.backgroundSnapshot.familyHistory).toEqual([
        expect.objectContaining({
          description: 'Diabetes tipo 2',
          relative: 'Madre',
        }),
      ]);
      expect(row.contentHash).toBe(
        contentHashOf({
          content: row.content as Record<string, unknown>,
          signedById: row.signedById as string,
          signedAt: row.signedAt as Date,
        }),
      );
    });

    it('EN-207 no deja firmar sin texto en antecedentes con solo «sin alergias conocidas»', async () => {
      await post(`/patients/${patientId}/allergies/none-known`, doctorToken).expect(201); // prettier-ignore
      const encounterId = await openEncounter();
      const draft = await post(
        `/encounters/${encounterId}/notes`,
        doctorToken,
        {
          formCode: '002',
          content: { ...COMPLETE_002, antecedentes: '' },
        },
      ).expect(201);

      const refused = await post(
        `/encounters/${encounterId}/notes/${(draft.body as NoteBody).id}/sign`,
        doctorToken,
        { dischargeCondition: 'ALIVE' },
      ).expect(422);
      expect((refused.body as Problem).code).toBe('NOTE_CONTENT_INCOMPLETE');

      // Control positivo: con una línea escrita, la misma nota se firma.
      await request(app.getHttpServer())
        .patch(
          `/api/v1/encounters/${encounterId}/notes/${(draft.body as NoteBody).id}`,
        )
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({
          content: { ...COMPLETE_002, antecedentes: 'Niega antecedentes' },
        })
        .expect(200);
      await post(
        `/encounters/${encounterId}/notes/${(draft.body as NoteBody).id}/sign`,
        doctorToken,
        { dischargeCondition: 'ALIVE' },
      ).expect(200);
    });

    it('EN-009 rechaza firmar la consulta externa sin condición de egreso', async () => {
      const encounterId = await openEncounter();
      const draft = await post(
        `/encounters/${encounterId}/notes`,
        doctorToken,
        {
          formCode: '002',
          content: COMPLETE_002,
        },
      ).expect(201);

      const response = await post(
        `/encounters/${encounterId}/notes/${(draft.body as NoteBody).id}/sign`,
        doctorToken,
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('DISCHARGE_CONDITION_REQUIRED');
      expect(problem.errors?.[0]?.message).toContain('ALIVE');
    });

    it('EN-020 rechaza firmar una nota a la que le falta una sección del artículo 6', async () => {
      const encounterId = await openEncounter();
      const draft = await post(
        `/encounters/${encounterId}/notes`,
        doctorToken,
        {
          formCode: '002',
          content: without('planTratamiento'),
        },
      ).expect(201);

      const response = await post(
        `/encounters/${encounterId}/notes/${(draft.body as NoteBody).id}/sign`,
        doctorToken,
        { dischargeCondition: 'ALIVE' },
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('NOTE_CONTENT_INCOMPLETE');
      expect(problem.errors?.[0]?.field).toBe('content.planTratamiento');
    });

    it('EN-021 rechaza un formulario que esta instalación no sabe validar', async () => {
      const encounterId = await openEncounter();

      const response = await post(
        `/encounters/${encounterId}/notes`,
        doctorToken,
        { formCode: '033', content: COMPLETE_002 },
      ).expect(422);

      expect((response.body as Problem).code).toBe('UNKNOWN_CLINICAL_FORM');
    });

    it('EN-023 rechaza editar una nota firmada diciendo que está firmada', async () => {
      /**
       * ⚠️ 409 Y NO 403. El disparador levanta `insufficient_privilege`, que a
       * secas saldría como un 403 diciéndole al médico que no tiene permisos
       * cuando lo que pasa es que la nota está firmada.
       */
      const encounterId = await openEncounter();
      const draft = await post(
        `/encounters/${encounterId}/notes`,
        doctorToken,
        {
          formCode: '002',
          content: COMPLETE_002,
        },
      ).expect(201);
      const noteId = (draft.body as NoteBody).id;
      await post(
        `/encounters/${encounterId}/notes/${noteId}/sign`,
        doctorToken,
        { dischargeCondition: 'ALIVE' },
      ).expect(200);

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/encounters/${encounterId}/notes/${noteId}`)
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ content: { ...COMPLETE_002, planTratamiento: 'Otro' } })
        .expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('NOTE_ALREADY_SIGNED');
      expect(problem.title).toContain('enmiéndela');
    });

    it('EN-025 enmienda con 201, dejando la versión anterior legible', async () => {
      const encounterId = await openEncounter();
      const draft = await post(
        `/encounters/${encounterId}/notes`,
        doctorToken,
        {
          formCode: '002',
          content: COMPLETE_002,
        },
      ).expect(201);
      const noteId = (draft.body as NoteBody).id;
      await post(
        `/encounters/${encounterId}/notes/${noteId}/sign`,
        doctorToken,
        { dischargeCondition: 'ALIVE' },
      ).expect(200);

      // 201 Y NO 200: lo que queda es una versión NUEVA. Responder 200 diría
      // «la nota que usted conoce cambió», que es lo que REQ-005 prohíbe.
      const amended = await post(
        `/encounters/${encounterId}/notes/${noteId}/amend`,
        doctorToken,
        {
          content: { ...COMPLETE_002, planTratamiento: 'Dieta absoluta' },
          amendmentReason: 'Se anotó el plan de la paciente anterior',
        },
      ).expect(201);

      expect(amended.body).toMatchObject({ version: 2, supersedesId: noteId });

      const listed = await get(
        `/encounters/${encounterId}/notes`,
        doctorToken,
      ).expect(200);
      const versions = (listed.body as { items: NoteBody[] }).items;
      expect(versions.map((version) => version.status)).toEqual([
        'SUPERSEDED',
        'SIGNED',
      ]);
    });

    it('EN-025 rechaza enmendar sin motivo, señalando el campo', async () => {
      const encounterId = await openEncounter();
      const draft = await post(
        `/encounters/${encounterId}/notes`,
        doctorToken,
        {
          formCode: '002',
          content: COMPLETE_002,
        },
      ).expect(201);
      const noteId = (draft.body as NoteBody).id;
      await post(
        `/encounters/${encounterId}/notes/${noteId}/sign`,
        doctorToken,
        { dischargeCondition: 'ALIVE' },
      ).expect(200);

      const response = await post(
        `/encounters/${encounterId}/notes/${noteId}/amend`,
        doctorToken,
        { content: COMPLETE_002 },
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.errors?.[0]?.field).toBe('amendmentReason');
    });

    it('EN-130 rechaza contenido clínico NUEVO tras el alta, pero admite la enmienda', async () => {
      const encounterId = await openEncounter();
      const draft = await post(
        `/encounters/${encounterId}/notes`,
        doctorToken,
        {
          formCode: '002',
          content: COMPLETE_002,
        },
      ).expect(201);
      const noteId = (draft.body as NoteBody).id;
      await post(
        `/encounters/${encounterId}/notes/${noteId}/sign`,
        doctorToken,
        { dischargeCondition: 'ALIVE' },
      ).expect(200);

      // Contenido nuevo: rechazado, y el mensaje dice en qué estado está.
      const refused = await put(
        `/encounters/${encounterId}/vitals`,
        doctorToken,
        { weightKg: 68.4 },
      ).expect(409);
      expect((refused.body as Problem).code).toBe('ENCOUNTER_ALREADY_CLOSED');

      // La enmienda NO caduca porque la atención avance (EN-025).
      await post(
        `/encounters/${encounterId}/notes/${noteId}/amend`,
        doctorToken,
        { content: COMPLETE_002, amendmentReason: 'Se corrigió la dosis' },
      ).expect(201);
    });

    it('EN-026 retracta sin reemplazo y la nota sigue en la historia', async () => {
      const encounterId = await openEncounter();
      const draft = await post(
        `/encounters/${encounterId}/notes`,
        doctorToken,
        {
          formCode: '002',
          content: COMPLETE_002,
        },
      ).expect(201);
      const noteId = (draft.body as NoteBody).id;
      await post(
        `/encounters/${encounterId}/notes/${noteId}/sign`,
        doctorToken,
        { dischargeCondition: 'ALIVE' },
      ).expect(200);

      const retracted = await post(
        `/encounters/${encounterId}/notes/${noteId}/retract`,
        doctorToken,
      ).expect(200);

      expect(retracted.body).toMatchObject({
        status: 'ENTERED_IN_ERROR',
        supersedesId: null,
      });
      await expect(prisma.clinicalNote.count()).resolves.toBe(1);
    });
  });

  describe('anular e interrumpir la atención (EN-166, EN-167)', () => {
    it('EN-166 anula con motivo, responde la atención anulada y deja una fila de bitácora', async () => {
      const encounterId = await openEncounter();
      const before = await auditRows('encounter');

      const annulled = await post(
        `/encounters/${encounterId}/enter-in-error`,
        doctorToken,
        { reason: 'Se abrió a otro paciente' },
      ).expect(200);

      expect(annulled.body).toMatchObject({
        status: 'ENTERED_IN_ERROR',
        annulment: { reason: 'Se abrió a otro paciente' },
      });
      expect(await auditRows('encounter')).toBe(before + 1);
    });

    it('EN-166 sin motivo responde 422 por campo y no anula', async () => {
      const encounterId = await openEncounter();

      const refused = await post(
        `/encounters/${encounterId}/enter-in-error`,
        doctorToken,
        {},
      ).expect(422);

      expect((refused.body as Problem).code).toBe(
        'ENCOUNTER_ANNULMENT_REASON_REQUIRED',
      );
      expect((refused.body as Problem).errors?.[0]?.field).toBe('reason');
    });

    it('EN-166 EN-167 recepción no anula ni interrumpe: no tiene `record:write` ni `record:sign` (D-080 §2)', async () => {
      const encounterId = await openEncounter();

      await post(`/encounters/${encounterId}/enter-in-error`, receptionToken, {
        reason: 'x',
      }).expect(403);
      await post(`/encounters/${encounterId}/discontinue`, receptionToken, {
        reason: 'x',
        origin: 'PATIENT',
      }).expect(403);
    });

    it('EN-167 interrumpe con motivo y origen; sin origen responde 422 por campo', async () => {
      const encounterId = await openEncounter();

      const refused = await post(
        `/encounters/${encounterId}/discontinue`,
        doctorToken,
        { reason: 'Se retiró' },
      ).expect(422);
      expect((refused.body as Problem).code).toBe(
        'ENCOUNTER_INTERRUPTION_REASON_REQUIRED',
      );
      expect((refused.body as Problem).errors?.map((e) => e.field)).toEqual([
        'origin',
      ]);

      const discontinued = await post(
        `/encounters/${encounterId}/discontinue`,
        doctorToken,
        { reason: 'Se retiró', origin: 'PATIENT' },
      ).expect(200);
      expect(discontinued.body).toMatchObject({
        status: 'DISCONTINUED',
        interruption: { reason: 'Se retiró', origin: 'PATIENT' },
      });
    });

    it('EN-167 la atención de otra sede responde 404, como una que no existe', async () => {
      // Written directly: nobody here holds a grant at the other site.
      const { id: encounterId } = await prisma.encounter.create({
        data: {
          siteId: otherSiteId,
          practitionerId: doctorPractitionerId,
          patientId,
          startedAt: new Date(),
          careModality: 'MORBIDITY',
          visitSequence: 'FIRST_TIME',
        },
      });

      await post(`/encounters/${encounterId}/discontinue`, doctorToken, {
        reason: 'x',
        origin: 'PATIENT',
      }).expect(404);
    });
  });

  describe('cerrar la cuenta', () => {
    /** Opens, documents and signs, leaving the attention DISCHARGED. */
    async function discharged(token = doctorToken): Promise<string> {
      const encounterId = await openEncounter(token);
      const draft = await post(`/encounters/${encounterId}/notes`, token, {
        formCode: '002',
        content: COMPLETE_002,
      }).expect(201);
      await post(
        `/encounters/${encounterId}/notes/${(draft.body as NoteBody).id}/sign`,
        token,
        { dischargeCondition: 'ALIVE' },
      ).expect(200);
      return encounterId;
    }

    it('EN-131 cierra la cuenta y registra quién y cuándo', async () => {
      const encounterId = await discharged();

      const closed = await post(
        `/encounters/${encounterId}/close`,
        doctorToken,
      ).expect(200);

      expect(closed.body).toMatchObject({
        status: 'COMPLETED',
        closedById: doctorPractitionerId,
        closedBySubstituteReason: null,
      });
    });

    it('EN-132 rechaza cerrar una atención que todavía no tiene alta clínica', async () => {
      const encounterId = await openEncounter();

      const response = await post(
        `/encounters/${encounterId}/close`,
        doctorToken,
      ).expect(409);

      const problem = response.body as Problem;
      expect(problem.code).toBe('ENCOUNTER_STATE_TRANSITION_INVALID');
      expect(problem.title).toContain('En curso');
    });

    it('EN-132 rechaza cerrar dos veces la misma atención', async () => {
      const encounterId = await discharged();
      await post(`/encounters/${encounterId}/close`, doctorToken).expect(200);

      const response = await post(
        `/encounters/${encounterId}/close`,
        doctorToken,
      ).expect(409);

      expect((response.body as Problem).code).toBe(
        'ENCOUNTER_STATE_TRANSITION_INVALID',
      );
    });

    it('EN-147 deja cerrar a otro médico dejando constancia de la sustitución', async () => {
      const encounterId = await discharged();

      const closed = await post(
        `/encounters/${encounterId}/close`,
        secondDoctorToken,
        { substituteReason: 'La doctora está de vacaciones desde el lunes' },
      ).expect(200);

      expect(closed.body).toMatchObject({
        closedById: secondDoctorPractitionerId,
        closedBySubstituteReason:
          'La doctora está de vacaciones desde el lunes',
      });
    });

    it('EN-147 rechaza el cierre por sustitución sin motivo escrito', async () => {
      const encounterId = await discharged();

      const response = await post(
        `/encounters/${encounterId}/close`,
        secondDoctorToken,
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('SUBSTITUTE_CLOSURE_REASON_REQUIRED');
      expect(problem.errors?.[0]?.field).toBe('substituteReason');
    });

    it('EN-144 rechaza que cierre alguien que no firma historia clínica', async () => {
      const encounterId = await discharged();

      // Enfermería no lleva `record:write`, así que el guard la para antes: el
      // cierre no es una escritura de enfermería en ningún sentido.
      await post(`/encounters/${encounterId}/close`, nurseToken, {
        substituteReason: 'Me lo pidió recepción',
      }).expect(403);
    });
  });

  describe('el avance del paciente se deriva de documentar', () => {
    it('EN-134 a EN-139 recorre la atención entera sin que nadie teclee un estado', async () => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * EL RECORRIDO COMPLETO, Y NINGUNA RUTA ADMITE FIJAR EL ESTADO
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Llega (recepción, a mano, en la cita) · se abre la toma de signos ·
       * se guardan · se abre la nota · se firma · se cierra la cuenta. Cada
       * paso es un acto que iba a ocurrir de todos modos, y el tablero avanza
       * solo — que es D-A-008 entero: «un tablero que se actualiza a mano
       * miente».
       */
      const practitioner = await prisma.practitioner.findUniqueOrThrow({
        where: { id: doctorPractitionerId },
      });
      const appointment = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          bookingChannel: 'WALK_IN',
          siteId,
          practitionerId: practitioner.id,
          patientId,
          // Lo único que se teclea (EN-134): la llegada es un hecho externo.
          subjectStatus: 'ARRIVED',
          subjectStatusAt: new Date(),
          ...hourSlot(9),
        },
      });

      const subjectStatus = async (): Promise<string | null> =>
        (
          await prisma.agendaEntry.findUniqueOrThrow({
            where: { id: appointment.id },
            select: { subjectStatus: true },
          })
        ).subjectStatus;

      const encounterId = await openEncounter(nurseToken, {
        agendaEntryId: appointment.id,
      });
      expect(await subjectStatus()).toBe('ARRIVED');

      // EN-135: se abre la toma de signos.
      await post(`/encounters/${encounterId}/vitals/start`, nurseToken).expect(200); // prettier-ignore
      expect(await subjectStatus()).toBe('IN_PREPARATION');

      // EN-136: se guardan.
      await put(`/encounters/${encounterId}/vitals`, nurseToken, {
        weightKg: 68.4,
        heightCm: 165,
        heightPosition: 'STANDING',
      }).expect(200);
      expect(await subjectStatus()).toBe('READY');

      // EN-137: se abre la nota.
      const draft = await post(
        `/encounters/${encounterId}/notes`,
        doctorToken,
        { formCode: '002', content: COMPLETE_002 },
      ).expect(201);
      expect(await subjectStatus()).toBe('RECEIVING_CARE');

      // EN-138: se firma. La atención pasa a DISCHARGED y el PACIENTE SIGUE
      // AQUÍ — la fila que prueba que hacen falta los dos ejes.
      await post(
        `/encounters/${encounterId}/notes/${(draft.body as NoteBody).id}/sign`,
        doctorToken,
        { dischargeCondition: 'ALIVE' },
      ).expect(200);
      expect(await subjectStatus()).toBe('RECEIVING_CARE');
      const afterSigning = await get(`/encounters/${encounterId}`, doctorToken);
      expect((afterSigning.body as EncounterBody).status).toBe('DISCHARGED');

      // EN-139: se cierra la cuenta.
      await post(`/encounters/${encounterId}/close`, doctorToken).expect(200);
      expect(await subjectStatus()).toBe('DEPARTED');
    });

    it('EN-134 no expone ninguna ruta que fije el estado directamente', async () => {
      // `PATCH /encounters/:id/status` sería exactamente la casilla que el
      // requisito prohíbe. No existe, y esto es lo que lo afirma.
      const encounterId = await openEncounter();

      await request(app.getHttpServer())
        .patch(`/api/v1/encounters/${encounterId}/status`)
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ status: 'COMPLETED' })
        .expect(404);
    });
  });
});
