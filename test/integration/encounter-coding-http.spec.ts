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
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { addDays, clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * Block K as the browser consumes it — the RDACAA's diagnoses and procedures.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ADDS OVER `encounter-diagnoses.spec.ts`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That file proves what PostgreSQL guarantees. This one proves everything
 * BETWEEN the browser and the database, and one thing in particular that a
 * double cannot show at all:
 *
 * ⚠️ **NURSING DOES NOT DIAGNOSE (art. 198 de la LOS).** The nurse below signs
 * in for real, with the roles the seed ships, and is refused. «El defecto de
 * AG-111 fue exactamente confiar en un doble con los permisos puestos a mano»,
 * and the separation of functions is the kind of rule that has to be shown
 * against the permissions the clinic actually deploys.
 */
const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

interface DiagnosisBody {
  id: string;
  cie10Code: string;
  cie10Display: string;
  certainty: string;
  occurrence: string;
  rank: number;
  careModality: string;
  notifiable: boolean;
}

interface ProcedureBody {
  id: string;
  procedureCode: string;
  quantity: number;
}

describe('el bloque K por HTTP', () => {
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

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // Sin límite de peticiones aquí, por lo mismo que en `encounter-http`:
        // este archivo hace una veintena seguidas. Se sustituye el ALMACÉN, no
        // el guard, que es precisamente lo que estas pruebas comprueban.
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

  const post = (path: string, token: string, body?: object) =>
    request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body ?? {});

  const get = (path: string, token: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`);

  /** Opens an attention at the site every session is granted on. */
  async function openEncounter(): Promise<string> {
    const response = await post('/encounters', doctorToken, {
      siteId,
      practitionerId: doctorPractitionerId,
      patientId,
      startedAt: '2026-08-14T14:00:00Z',
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    });
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  }

  /**
   * An attention at the site nobody in this file is granted on.
   *
   * WRITTEN DIRECTLY AND NOT THROUGH THE ROUTE, because the route would refuse
   * it for the very reason being tested: the doctor holds `encounter:open` at
   * one site. What has to exist is the row; what is under test is what the
   * read of it answers.
   */
  async function anEncounterElsewhere(): Promise<string> {
    const encounter = await prisma.encounter.create({
      data: {
        siteId: otherSiteId,
        practitionerId: doctorPractitionerId,
        patientId,
        startedAt: new Date('2026-08-14T14:00:00Z'),
        careModality: 'MORBIDITY',
        visitSequence: 'FIRST_TIME',
      },
      select: { id: true },
    });
    return encounter.id;
  }

  /** A concept of a catalogue, versioned as `catalog_concept` holds them. */
  async function aConcept(
    systemCode: string,
    concept: {
      code: string;
      display: string;
      validFrom?: Date;
      validTo?: Date | null;
    },
  ): Promise<string> {
    const system = await prisma.catalogSystem.upsert({
      where: { code: systemCode },
      create: { code: systemCode, name: `Catálogo ${systemCode}` },
      update: {},
    });
    const row = await prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code: concept.code,
        display: concept.display,
        validFrom: concept.validFrom ?? new Date('2019-01-01'),
        validTo: concept.validTo ?? null,
      },
    });
    return row.id;
  }

  const aDiagnosisBody = (
    conceptId: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    conceptId,
    certainty: 'DEFINITIVE',
    occurrence: 'FIRST_TIME',
    ...overrides,
  });

  const auditRows = (resourceType: string) =>
    prisma.accessAudit.count({ where: { resourceType } });

  describe('quién puede diagnosticar', () => {
    it('EN-120 rechaza registrar un diagnóstico sin sesión', async () => {
      const encounterId = await openEncounter();
      const conceptId = await aConcept('CIE10', {
        code: 'J020',
        display: 'Faringitis estreptocócica',
      });

      await request(app.getHttpServer())
        .post(`/api/v1/encounters/${encounterId}/diagnoses`)
        .send(aDiagnosisBody(conceptId))
        .expect(401);
    });

    it('EN-040 deja al MÉDICO registrar el diagnóstico con `record:write`', async () => {
      const encounterId = await openEncounter();
      const conceptId = await aConcept('CIE10', {
        code: 'J020',
        display: 'Faringitis estreptocócica',
      });

      const response = await post(
        `/encounters/${encounterId}/diagnoses`,
        doctorToken,
        aDiagnosisBody(conceptId),
      ).expect(201);

      const body = response.body as DiagnosisBody;
      expect(body.cie10Code).toBe('J020');
      expect(body.cie10Display).toBe('Faringitis estreptocócica');
    });

    it('EN-040 NO deja a ENFERMERÍA diagnosticar, que es el art. 198 de la LOS', async () => {
      /**
       * ⚠️ LA SEPARACIÓN DE FUNCIONES, CONTRA LOS PERMISOS QUE LA CLÍNICA
       * DESPLIEGA DE VERDAD. `ENFERMERIA` lleva `record:read`, `vitals:write`
       * y `nursing:write` —los formularios 020, 120 y 022— y ninguno de ellos
       * aparece en esta ruta. Esa ausencia ES el requisito: enfermería toma el
       * peso y enfermería no diagnostica.
       */
      const encounterId = await openEncounter();
      const conceptId = await aConcept('CIE10', {
        code: 'J020',
        display: 'Faringitis estreptocócica',
      });

      await post(
        `/encounters/${encounterId}/diagnoses`,
        nurseToken,
        aDiagnosisBody(conceptId),
      ).expect(403);
    });

    it('EN-050 NO deja a ENFERMERÍA registrar un procedimiento', async () => {
      const encounterId = await openEncounter();
      const conceptId = await aConcept('TARIFF', {
        code: '23.09',
        display: 'Extracción dental',
      });

      await post(`/encounters/${encounterId}/procedures`, nurseToken, {
        conceptId,
        quantity: 1,
      }).expect(403);
    });

    it('EN-040 NO deja a RECEPCIÓN diagnosticar con `encounter:open`', async () => {
      /**
       * Abrir la atención es un acto administrativo (A.M. 00115-2021 art. 11).
       * Si `encounter:open` alcanzase para diagnosticar sería `record:write`
       * con otro nombre.
       */
      const encounterId = await openEncounter();
      const conceptId = await aConcept('CIE10', {
        code: 'J020',
        display: 'Faringitis estreptocócica',
      });

      await post(
        `/encounters/${encounterId}/diagnoses`,
        receptionToken,
        aDiagnosisBody(conceptId),
      ).expect(403);
    });

    it('EN-121 responde «no existe» a un diagnóstico de una atención de otra sede', async () => {
      /**
       * El mismo código para «no existe» y «es de otra sede»: distinguirlas
       * confirmaría atenciones ajenas a quien adivina identificadores.
       */
      const encounterId = await anEncounterElsewhere();
      const conceptId = await aConcept('CIE10', {
        code: 'J020',
        display: 'Faringitis estreptocócica',
      });

      const response = await post(
        `/encounters/${encounterId}/diagnoses`,
        doctorToken,
        aDiagnosisBody(conceptId),
      ).expect(404);

      expect((response.body as Problem).code).toBe('ENCOUNTER_NOT_FOUND');
    });
  });

  describe('lo que el bloque K registra', () => {
    it('EN-044 registra la condición del diagnóstico, presuntiva o definitiva', async () => {
      const encounterId = await openEncounter();
      const conceptId = await aConcept('CIE10', {
        code: 'J020',
        display: 'Faringitis estreptocócica',
      });

      const response = await post(
        `/encounters/${encounterId}/diagnoses`,
        doctorToken,
        aDiagnosisBody(conceptId, { certainty: 'PRESUMPTIVE' }),
      ).expect(201);

      expect((response.body as DiagnosisBody).certainty).toBe('PRESUMPTIVE');
    });

    it('EN-045 registra primera vez / subsecuente POR DIAGNÓSTICO', async () => {
      /**
       * La atención se abre como FIRST_TIME y el diagnóstico se registra como
       * SUBSEQUENT: son dos preguntas distintas y el esquema ya las separa. El
       * caso del comentario de la migración es el inverso —viene por su
       * hipertensión, subsecuente, y hoy se le diagnostica diabetes, de
       * primera vez— y derivar una de otra deja la incidencia del mes en cero.
       */
      const encounterId = await openEncounter();
      const conceptId = await aConcept('CIE10', {
        code: 'I10X',
        display: 'Hipertensión esencial',
      });

      const response = await post(
        `/encounters/${encounterId}/diagnoses`,
        doctorToken,
        aDiagnosisBody(conceptId, { occurrence: 'SUBSEQUENT' }),
      ).expect(201);

      expect((response.body as DiagnosisBody).occurrence).toBe('SUBSEQUENT');
    });

    it('EN-046 sirve prevención o morbilidad DERIVADA del código, no de la atención', async () => {
      /**
       * La atención se abrió como MORBIDITY y el diagnóstico es Z34: la
       * respuesta dice PREVENTION, porque la regla es del código y no de la
       * casilla que alguien rellenó al abrir.
       */
      const encounterId = await openEncounter();
      const conceptId = await aConcept('CIE10', {
        code: 'Z349',
        display: 'Supervisión de embarazo normal',
      });

      const response = await post(
        `/encounters/${encounterId}/diagnoses`,
        doctorToken,
        aDiagnosisBody(conceptId),
      ).expect(201);

      expect((response.body as DiagnosisBody).careModality).toBe('PREVENTION');
    });

    it('EN-046 ignora una modalidad enviada en el cuerpo: la decide el código', async () => {
      /**
       * No hay campo `careModality` en el contrato y el esquema descarta las
       * claves que no declara, así que enviarla no cambia nada. Una casilla
       * que alguien rellena es una casilla que puede contradecir al código que
       * tiene al lado, y ahí es donde el reporte del mes se equivoca.
       */
      const encounterId = await openEncounter();
      const conceptId = await aConcept('CIE10', {
        code: 'Z349',
        display: 'Supervisión de embarazo normal',
      });

      const response = await post(
        `/encounters/${encounterId}/diagnoses`,
        doctorToken,
        aDiagnosisBody(conceptId, { careModality: 'MORBIDITY' }),
      ).expect(201);

      expect((response.body as DiagnosisBody).careModality).toBe('PREVENTION');
    });

    it('EN-049 expone la marca de notificación obligatoria al registrar', async () => {
      const encounterId = await openEncounter();
      const conceptId = await aConcept('CIE10', {
        code: 'A90X',
        display: 'Dengue clásico',
      });

      const response = await post(
        `/encounters/${encounterId}/diagnoses`,
        doctorToken,
        aDiagnosisBody(conceptId, { notifiable: true }),
      ).expect(201);

      expect((response.body as DiagnosisBody).notifiable).toBe(true);
    });

    it('EN-047 lista los diagnósticos con el principal primero', async () => {
      const encounterId = await openEncounter();

      for (const [code, display] of [
        ['J020', 'Faringitis estreptocócica'],
        ['E119', 'Diabetes mellitus tipo 2'],
      ] as const) {
        const conceptId = await aConcept('CIE10', { code, display });
        await post(
          `/encounters/${encounterId}/diagnoses`,
          doctorToken,
          aDiagnosisBody(conceptId, { occurrence: 'SUBSEQUENT' }),
        ).expect(201);
      }

      const response = await get(
        `/encounters/${encounterId}/diagnoses`,
        doctorToken,
      ).expect(200);

      const { items } = response.body as { items: DiagnosisBody[] };
      expect(items.map((item) => [item.rank, item.cie10Code])).toEqual([
        [1, 'J020'],
        [2, 'E119'],
      ]);
    });

    it('EN-042 responde 422 y nombra el campo cuando el código no regía ese día', async () => {
      const encounterId = await openEncounter();
      const conceptId = await aConcept('CIE10', {
        code: 'J020',
        display: 'Faringitis estreptocócica (edición anterior)',
        // Semiabierto: dejó de regir el 13, y la atención es del 14.
        validTo: new Date('2026-08-14'),
      });

      const response = await post(
        `/encounters/${encounterId}/diagnoses`,
        doctorToken,
        aDiagnosisBody(conceptId),
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('DIAGNOSIS_CONCEPT_NOT_IN_FORCE');
      expect(problem.errors?.[0]?.field).toBe('conceptId');
    });

    it('EN-043 responde 409 al segundo diagnóstico principal', async () => {
      const encounterId = await openEncounter();
      const first = await aConcept('CIE10', {
        code: 'J020',
        display: 'Faringitis estreptocócica',
      });
      const second = await aConcept('CIE10', {
        code: 'E119',
        display: 'Diabetes mellitus tipo 2',
      });

      await post(
        `/encounters/${encounterId}/diagnoses`,
        doctorToken,
        aDiagnosisBody(first, { rank: 1 }),
      ).expect(201);

      const response = await post(
        `/encounters/${encounterId}/diagnoses`,
        doctorToken,
        aDiagnosisBody(second, { rank: 1 }),
      ).expect(409);

      expect((response.body as Problem).code).toBe('DIAGNOSIS_PRIMARY_TAKEN');
    });

    it('EN-050 registra el procedimiento con su cantidad', async () => {
      // Dos exodoncias en la misma atención, el ejemplo del instructivo.
      const encounterId = await openEncounter();
      const conceptId = await aConcept('TARIFF', {
        code: '23.09',
        display: 'Extracción dental',
      });

      const response = await post(
        `/encounters/${encounterId}/procedures`,
        doctorToken,
        { conceptId, quantity: 2 },
      ).expect(201);

      const body = response.body as ProcedureBody;
      expect(body.procedureCode).toBe('23.09');
      expect(body.quantity).toBe(2);
    });

    it('EN-050 rechaza una cantidad que no es una cantidad', async () => {
      const encounterId = await openEncounter();
      const conceptId = await aConcept('TARIFF', {
        code: '23.09',
        display: 'Extracción dental',
      });

      await post(`/encounters/${encounterId}/procedures`, doctorToken, {
        conceptId,
        quantity: 0,
      }).expect(422);
    });

    it('EN-051 no acepta ni devuelve importe alguno en el procedimiento', async () => {
      /**
       * ⚠️ LA AUSENCIA ES EL REQUISITO. El Tarifario aporta la nomenclatura y
       * el código; lo que la clínica cobra sale de la lista de precios del
       * pagador en la fecha del servicio y vive en `charge_item`, que es de
       * `billing`. Un precio aceptado aquí sería una fila clínica decidiendo
       * un hecho económico, y el acto no cambia porque el paciente no pague.
       */
      const encounterId = await openEncounter();
      const conceptId = await aConcept('TARIFF', {
        code: '23.09',
        display: 'Extracción dental',
      });

      const response = await post(
        `/encounters/${encounterId}/procedures`,
        doctorToken,
        { conceptId, quantity: 1, tariffAmount: 42.5, chargedAmount: 42.5 },
      ).expect(201);

      const body = response.body as Record<string, unknown>;
      expect(
        Object.keys(body).filter((key) =>
          /amount|price|precio|importe|tarif/i.test(key),
        ),
      ).toEqual([]);

      const [row] = await prisma.$queryRawUnsafe<
        { tariff_amount: string | null }[]
      >(
        `SELECT tariff_amount::text AS tariff_amount
           FROM encounter_procedure WHERE id = $1::uuid`,
        (body as { id: string }).id,
      );
      expect(row?.tariff_amount).toBeNull();
    });

    it('EN-151 registra el procedimiento de rutina sin pedir consentimiento', async () => {
      /**
       * A.M. 5316 §7.6.d, textual: «no se requiere un consentimiento informado
       * suscrito en las intervenciones de riesgo mínimo», y el propio acuerdo
       * pone el examen de orina entre los ejemplos. Se comprueba como una
       * AUSENCIA porque el fallo es construir de más: una barrera aquí entrena
       * a todo el mundo a hacer clic sin leer.
       */
      const encounterId = await openEncounter();
      const conceptId = await aConcept('TARIFF', {
        code: '90.59',
        display: 'Examen de orina',
      });

      await post(`/encounters/${encounterId}/procedures`, doctorToken, {
        conceptId,
        quantity: 1,
      }).expect(201);
    });
  });

  describe('la bitácora del bloque K', () => {
    it('EN-122 deja una fila por diagnóstico registrado y una por lectura', async () => {
      /**
       * Un diagnóstico es el dato más sensible del sistema, así que se audita
       * también la LECTURA — a diferencia del listado de atenciones (EN-123),
       * que no lleva contenido clínico ninguno.
       */
      const encounterId = await openEncounter();
      const conceptId = await aConcept('CIE10', {
        code: 'J020',
        display: 'Faringitis estreptocócica',
      });

      await post(
        `/encounters/${encounterId}/diagnoses`,
        doctorToken,
        aDiagnosisBody(conceptId),
      ).expect(201);
      await get(`/encounters/${encounterId}/diagnoses`, doctorToken).expect(
        200,
      );

      expect(await auditRows('encounter_diagnosis')).toBe(2);
    });

    it('EN-124 no guarda el código CIE-10 en la bitácora, que es inmutable y no se purga', async () => {
      /**
       * `access_audit_payload_only_for_declared_resources` rechaza una carga
       * fuera de `'configuration'`, y la razón es ésta: la tabla es
       * append-only y no se purga nunca, así que un diagnóstico que cayera ahí
       * no podría corregirse, minimizarse ni suprimirse jamás.
       */
      const encounterId = await openEncounter();
      const conceptId = await aConcept('CIE10', {
        code: 'J020',
        display: 'Faringitis estreptocócica',
      });

      await post(
        `/encounters/${encounterId}/diagnoses`,
        doctorToken,
        aDiagnosisBody(conceptId),
      ).expect(201);

      const rows = await prisma.accessAudit.findMany({
        where: { resourceType: 'encounter_diagnosis' },
        select: { before: true, after: true },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.before).toBeNull();
      expect(rows[0]?.after).toBeNull();
    });

    it('EN-122 no deja rastro de una atención que no existe: nada se divulgó', async () => {
      const before = await auditRows('encounter_diagnosis');

      await get(
        '/encounters/00000000-0000-7000-8000-000000000000/diagnoses',
        doctorToken,
      ).expect(404);

      expect(await auditRows('encounter_diagnosis')).toBe(before);
    });
  });

  describe('corregir y proponer en la atención (EN-180 a EN-187)', () => {
    const DAY = 24 * 60 * 60 * 1000;

    async function record(
      encounterId: string,
      code: string,
      overrides: Record<string, unknown> = {},
    ): Promise<DiagnosisBody> {
      const conceptId = await aConcept('CIE10', {
        code,
        display: `Dx ${code}`,
      });
      const response = await post(
        `/encounters/${encounterId}/diagnoses`,
        doctorToken,
        aDiagnosisBody(conceptId, overrides),
      ).expect(201);
      return response.body as DiagnosisBody;
    }

    interface Sheet {
      items: (DiagnosisBody & { printedOnCertificate: boolean })[];
      retracted: {
        id: string;
        cie10Code: string;
        reason: string | null;
        retractedBy: { name: string };
      }[];
    }

    const sheetOf = async (encounterId: string) =>
      (
        await get(`/encounters/${encounterId}/diagnoses`, doctorToken).expect(
          200,
        )
      ).body as Sheet;

    it('EN-180 quitar un diagnóstico lo saca de la lista y lo deja en el rastro, con quién lo quitó', async () => {
      const encounterId = await openEncounter();
      await record(encounterId, 'J020');
      const wrong = await record(encounterId, 'R509');

      await post(
        `/encounters/${encounterId}/diagnoses/${wrong.id}/retract`,
        doctorToken,
      ).expect(204);

      const sheet = await sheetOf(encounterId);
      expect(sheet.items.map((d) => d.cie10Code)).toEqual(['J020']);
      expect(sheet.retracted).toEqual([
        expect.objectContaining({
          id: wrong.id,
          cie10Code: 'R509',
          reason: null,
        }),
      ]);
      expect(sheet.retracted[0]?.retractedBy.name).toBe('Ana Villacís');
    });

    it('EN-180 un diagnóstico ya quitado o de otra atención responde 404', async () => {
      const encounterId = await openEncounter();
      const other = await openEncounter();
      const diagnosis = await record(other, 'J020');

      const refused = await post(
        `/encounters/${encounterId}/diagnoses/${diagnosis.id}/retract`,
        doctorToken,
      ).expect(404);
      expect((refused.body as Problem).code).toBe('DIAGNOSIS_NOT_FOUND');
    });

    it('EN-180 ENFERMERÍA no quita diagnósticos', async () => {
      const encounterId = await openEncounter();
      const diagnosis = await record(encounterId, 'J020');

      await post(
        `/encounters/${encounterId}/diagnoses/${diagnosis.id}/retract`,
        nurseToken,
      ).expect(403);
    });

    it('EN-181 EN-213 con la nota firmada se quita sin motivo, y un motivo enviado se guarda', async () => {
      const encounterId = await openEncounter();
      const diagnosis = await record(encounterId, 'J020');
      await prisma.clinicalNote.create({
        data: {
          // An evolution note: signing the 002 discharges the attention, and
          // a discharged one admits no correction but an amendment (EN-181).
          chainId: encounterId,
          formCode: '005',
          encounterId,
          authorId: doctorPractitionerId,
          content: { evolucion: 'odinofagia' },
          status: 'SIGNED',
          signedById: doctorPractitionerId,
          signedAt: new Date(),
          contentHash: 'a'.repeat(64),
        },
      });
      const path = `/encounters/${encounterId}/diagnoses/${diagnosis.id}/retract`;

      // D-126.2: the screen confirms once; the API asks nothing more.
      await post(path, doctorToken, { reason: 'Era otra faringitis' }).expect(
        204,
      );
      expect((await sheetOf(encounterId)).retracted[0]?.reason).toBe(
        'Era otra faringitis',
      );
      const second = await record(encounterId, 'R509');
      await post(`/encounters/${encounterId}/diagnoses/${second.id}/retract`, doctorToken).expect(204); // prettier-ignore
    });

    it('EN-182 ORD-121 con exámenes vivos se reordena y se quita: la lista dice qué imprimió la orden y eso pide el motivo', async () => {
      const encounterId = await openEncounter();
      await record(encounterId, 'J020');
      const second = await record(encounterId, 'R509');
      const exam = await aConcept('TARIFF', { code: 'BH', display: 'Biometría hemática' }); // prettier-ignore
      const order = await prisma.serviceOrder.create({
        data: {
          encounterId,
          siteId,
          orderedById: doctorPractitionerId,
          category: 'LABORATORY',
          items: { create: { conceptId: exam, testCode: 'BH', testDisplay: 'Biometría hemática' } }, // prettier-ignore
        },
        include: { items: true },
      });
      // ORD-098. Lines go in while it is a draft; issued, it cites (EN-182).
      await prisma.serviceOrder.update({
        where: { id: order.id },
        data: { status: 'ISSUED' },
      });
      const path = `/encounters/${encounterId}/diagnoses/${second.id}`;

      const sheet = (await get(`/encounters/${encounterId}/diagnoses`, doctorToken).expect(200)).body as { items: { cie10Code: string; printedOnOrder: boolean }[] }; // prettier-ignore
      expect(sheet.items.every((d) => d.printedOnOrder)).toBe(true);

      await post(`${path}/primary`, doctorToken).expect(200);
      const refused = await post(`${path}/retract`, doctorToken).expect(422);
      expect((refused.body as Problem).code).toBe('DIAGNOSIS_RETRACTION_REASON_REQUIRED'); // prettier-ignore
      // With the reason, the exams stay alive (no cancelling first).
      await post(`${path}/retract`, doctorToken, { reason: 'Diagnóstico descartado' }).expect(204); // prettier-ignore
      const item = await prisma.serviceOrderItem.findUniqueOrThrow({ where: { id: order.items[0]!.id } }); // prettier-ignore
      expect(item.status).not.toBe('CANCELLED');
    });

    it('EN-182 PR-026 una receta emitida no impide corregir: el documento sigue diciendo lo que se emitió', async () => {
      const encounterId = await openEncounter();
      const first = await record(encounterId, 'J020');
      const draft = await prisma.prescription.create({
        data: { encounterId, siteId, prescriberId: doctorPractitionerId },
      });
      await prisma.prescription.update({
        where: { id: draft.id },
        data: { status: 'ACTIVE', issuedAt: new Date() },
      });

      // EN-214: the receta printed it, so removing it states why.
      await post(`/encounters/${encounterId}/diagnoses/${first.id}/retract`, doctorToken, { reason: 'Código mal elegido' }).expect(204); // prettier-ignore

      const stored = await prisma.prescription.findUniqueOrThrow({ where: { id: draft.id } }); // prettier-ignore
      expect(stored.diagnoses).toEqual([{ code: 'J020', display: 'Dx J020' }]);
    });

    it('EN-180 un diagnóstico ya quitado responde 404, y quitar deja una fila de bitácora', async () => {
      const encounterId = await openEncounter();
      const diagnosis = await record(encounterId, 'J020');
      const path = `/encounters/${encounterId}/diagnoses/${diagnosis.id}/retract`;
      const before = await prisma.accessAudit.count({
        where: { resourceType: 'encounter_diagnosis', resourceId: diagnosis.id, action: 'UPDATE' }, // prettier-ignore
      });

      await post(path, doctorToken).expect(204);
      const again = await post(path, doctorToken).expect(404);

      expect((again.body as Problem).code).toBe('DIAGNOSIS_NOT_FOUND');
      expect(
        await prisma.accessAudit.count({
          where: { resourceType: 'encounter_diagnosis', resourceId: diagnosis.id, action: 'UPDATE' }, // prettier-ignore
        }),
      ).toBe(before + 1);
    });

    it('EN-183 marcar otro como principal pasa el anterior detrás del último', async () => {
      const encounterId = await openEncounter();
      const first = await record(encounterId, 'J020');
      await record(encounterId, 'R509');
      const third = await record(encounterId, 'R51');

      const response = await post(
        `/encounters/${encounterId}/diagnoses/${third.id}/primary`,
        doctorToken,
      ).expect(200);

      const ranks = Object.fromEntries(
        (response.body as DiagnosisBody[]).map((d) => [d.cie10Code, d.rank]),
      );
      expect(ranks).toEqual({ R51: 1, R509: 2, J020: 4 });
      expect(first.rank).toBe(1);
    });

    it('EN-183 quitar el principal deja la atención sin principal hasta marcar otro', async () => {
      const encounterId = await openEncounter();
      const first = await record(encounterId, 'J020');
      const second = await record(encounterId, 'R509');

      await post(`/encounters/${encounterId}/diagnoses/${first.id}/retract`, doctorToken).expect(204); // prettier-ignore
      expect((await sheetOf(encounterId)).items.some((d) => d.rank === 1)).toBe(
        false,
      );

      await post(`/encounters/${encounterId}/diagnoses/${second.id}/primary`, doctorToken).expect(200); // prettier-ignore
      expect((await sheetOf(encounterId)).items[0]).toMatchObject({
        cie10Code: 'R509',
        rank: 1,
      });
    });

    it('EN-188 EN-213 con el alta se quita sin motivo y se marca otro como principal; interrumpida, no', async () => {
      const encounterId = await openEncounter();
      const first = await record(encounterId, 'J020');
      const second = await record(encounterId, 'R509');
      const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } }); // prettier-ignore
      await prisma.encounter.update({
        where: { id: encounterId },
        data: { status: 'DISCHARGED', endedAt: new Date(encounter.startedAt.getTime() + 20 * 60_000), dischargeCondition: 'ALIVE' }, // prettier-ignore
      });
      const path = `/encounters/${encounterId}/diagnoses/${first.id}/retract`;

      // EN-183: another is marked principal first, then the old one goes.
      await post(`/encounters/${encounterId}/diagnoses/${second.id}/primary`, doctorToken).expect(200); // prettier-ignore
      await post(path, doctorToken).expect(204);

      const sheet = await sheetOf(encounterId);
      expect(sheet.items).toEqual([
        expect.objectContaining({ cie10Code: 'R509', rank: 1 }),
      ]);
      expect(sheet.retracted[0]?.reason).toBeNull();

      // G1: the last one stays — nothing new can be coded after the discharge.
      const last = await post(`/encounters/${encounterId}/diagnoses/${second.id}/retract`, doctorToken, { reason: 'x' }).expect(409); // prettier-ignore
      expect((last.body as Problem).code).toBe(
        'DIAGNOSIS_LAST_AFTER_DISCHARGE',
      );

      const interrupted = await openEncounter();
      const kept = await record(interrupted, 'K210');
      const at = new Date(encounter.startedAt.getTime() + 20 * 60_000);
      const { userId: doctorUserId } = await prisma.practitioner.findUniqueOrThrow({ where: { id: doctorPractitionerId } }); // prettier-ignore
      await prisma.encounter.update({
        where: { id: interrupted },
        data: { status: 'DISCONTINUED', endedAt: at, discontinuedAt: at, discontinuedOrigin: 'PATIENT', discontinuedReason: 'Se fue', discontinuedById: doctorUserId }, // prettier-ignore
      });
      const closed = await post(`/encounters/${interrupted}/diagnoses/${kept.id}/retract`, doctorToken, { reason: 'x' }).expect(409); // prettier-ignore
      expect((closed.body as Problem).code).toBe('ENCOUNTER_ALREADY_CLOSED');
    });

    it('EN-189 la lista dice qué diagnóstico imprimió un certificado, y quitarlo pide el motivo', async () => {
      const encounterId = await openEncounter();
      const printed = await record(encounterId, 'J020');
      await record(encounterId, 'R509');
      const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } }); // prettier-ignore
      await prisma.$executeRaw`
        INSERT INTO medical_certificate
          (encounter_id, patient_id, issued_by_id, type, verification_code,
           include_diagnosis, diagnoses)
        VALUES (${encounterId}::uuid, ${encounter.patientId}::uuid,
                ${doctorPractitionerId}::uuid, 'ATTENDANCE',
                ${`EN189-${encounterId.slice(0, 12)}`}, true,
                ${JSON.stringify([{ code: 'J020', display: 'Dx J020', certainty: 'PRESUMPTIVE' }])}::jsonb)`;

      const sheet = await sheetOf(encounterId);
      expect(
        Object.fromEntries(
          sheet.items.map((d) => [d.cie10Code, d.printedOnCertificate]),
        ),
      ).toEqual({ J020: true, R509: false });

      const path = `/encounters/${encounterId}/diagnoses/${printed.id}/retract`;
      const refused = await post(path, doctorToken).expect(422);
      expect((refused.body as Problem).code).toBe(
        'DIAGNOSIS_RETRACTION_REASON_REQUIRED',
      );
      await post(path, doctorToken, { reason: 'El certificado lo dijo mal' }).expect(204); // prettier-ignore
    });

    const patch = (path: string, token: string, body: object) =>
      request(app.getHttpServer())
        .patch(`/api/v1${path}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    /** EN-130. The 002 was signed: the attention has its discharge. */
    async function dischargeOf(encounterId: string): Promise<void> {
      const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } }); // prettier-ignore
      await prisma.encounter.update({
        where: { id: encounterId },
        data: { status: 'DISCHARGED', endedAt: new Date(encounter.startedAt.getTime() + 20 * 60_000), dischargeCondition: 'ALIVE' }, // prettier-ignore
      });
    }

    interface VersionsBody {
      items: {
        version: number;
        replacedBy: { name: string };
        replacedAt: string;
        reason: string | null;
        diagnosis: { cie10Code: string; certainty: string; rank: number };
      }[];
    }

    it('EN-212 edita en el sitio el código, la condición y la ocurrencia, y la versión anterior se lee aparte', async () => {
      const encounterId = await openEncounter();
      const wrong = await record(encounterId, 'J020');
      const right = await aConcept('CIE10', { code: 'J030', display: 'Amigdalitis estreptocócica' }); // prettier-ignore
      const path = `/encounters/${encounterId}/diagnoses/${wrong.id}`;

      const edited = await patch(path, doctorToken, {
        conceptId: right,
        certainty: 'PRESUMPTIVE',
        occurrence: 'SUBSEQUENT',
      }).expect(200);

      expect(edited.body).toMatchObject({
        id: wrong.id,
        cie10Code: 'J030',
        cie10Display: 'Amigdalitis estreptocócica',
        certainty: 'PRESUMPTIVE',
        occurrence: 'SUBSEQUENT',
        rank: 1,
      });
      expect(
        (edited.body as { editedAt: string | null }).editedAt,
      ).not.toBeNull();

      const versions = (await get(`${path}/versions`, doctorToken).expect(200)).body as VersionsBody; // prettier-ignore
      expect(versions.items).toEqual([
        expect.objectContaining({
          version: 1,
          reason: null,
          diagnosis: expect.objectContaining({ cie10Code: 'J020', certainty: 'DEFINITIVE', rank: 1 }), // prettier-ignore
        }),
      ]);
      expect(versions.items[0]?.replacedBy.name).toBe('Ana Villacís');
      // Nothing was removed: it is the same diagnosis, edited.
      expect((await sheetOf(encounterId)).retracted).toEqual([]);
    });

    it('EN-212 «principal» de un clic: el anterior pasa detrás, también con el alta', async () => {
      const encounterId = await openEncounter();
      const first = await record(encounterId, 'J020');
      const second = await record(encounterId, 'R509');
      await dischargeOf(encounterId);

      const edited = await patch(`/encounters/${encounterId}/diagnoses/${second.id}`, doctorToken, { primary: true }).expect(200); // prettier-ignore
      expect((edited.body as DiagnosisBody).rank).toBe(1);

      const sheet = await sheetOf(encounterId);
      expect(sheet.items.map((d) => [d.cie10Code, d.rank])).toEqual([
        ['R509', 1],
        ['J020', 3],
      ]);
      const versions = (await get(`/encounters/${encounterId}/diagnoses/${first.id}/versions`, doctorToken).expect(200)).body as VersionsBody; // prettier-ignore
      expect(versions.items[0]?.diagnosis.rank).toBe(1);
    });

    it('EN-212 cambiar un código que imprimió un certificado pide el motivo y lo guarda; la condición se cambia sin él', async () => {
      const encounterId = await openEncounter();
      const printed = await record(encounterId, 'J020');
      const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } }); // prettier-ignore
      await prisma.$executeRaw`
        INSERT INTO medical_certificate
          (encounter_id, patient_id, issued_by_id, type, verification_code,
           include_diagnosis, diagnoses)
        VALUES (${encounterId}::uuid, ${encounter.patientId}::uuid,
                ${doctorPractitionerId}::uuid, 'ATTENDANCE',
                ${`EN212-${encounterId.slice(0, 12)}`}, true,
                ${JSON.stringify([{ code: 'J020', display: 'Dx J020', certainty: 'DEFINITIVE' }])}::jsonb)`;
      const other = await aConcept('CIE10', {
        code: 'J030',
        display: 'Dx J030',
      });
      const path = `/encounters/${encounterId}/diagnoses/${printed.id}`;

      // Positive control: what the paper does not depend on.
      await patch(path, doctorToken, { certainty: 'PRESUMPTIVE' }).expect(200);

      const refused = await patch(path, doctorToken, { conceptId: other }).expect(422); // prettier-ignore
      expect((refused.body as Problem).code).toBe(
        'DIAGNOSIS_EDIT_REASON_REQUIRED',
      );
      expect((refused.body as Problem).errors?.[0]?.field).toBe('reason');
      expect((refused.body as Problem).title).toContain('Indique por qué');

      await patch(path, doctorToken, { conceptId: other, reason: 'Código mal elegido' }).expect(200); // prettier-ignore
      const versions = (await get(`${path}/versions`, doctorToken).expect(200)).body as VersionsBody; // prettier-ignore
      expect(versions.items[0]).toMatchObject({ reason: 'Código mal elegido' });
    });

    it('EN-212 EN-213 el motivo de editar un código impreso sigue consultable después de quitar el diagnóstico', async () => {
      const encounterId = await openEncounter();
      const printed = await record(encounterId, 'J00');
      await record(encounterId, 'R509');
      const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } }); // prettier-ignore
      await prisma.$executeRaw`
        INSERT INTO medical_certificate
          (encounter_id, patient_id, issued_by_id, type, verification_code,
           include_diagnosis, diagnoses)
        VALUES (${encounterId}::uuid, ${encounter.patientId}::uuid,
                ${doctorPractitionerId}::uuid, 'ATTENDANCE',
                ${`EN213-${encounterId.slice(0, 12)}`}, true,
                ${JSON.stringify([{ code: 'J00', display: 'Dx J00', certainty: 'DEFINITIVE' }])}::jsonb)`;
      const j06 = await aConcept('CIE10', { code: 'J06', display: 'Dx J06' });
      const path = `/encounters/${encounterId}/diagnoses/${printed.id}`;

      await patch(path, doctorToken, { conceptId: j06, reason: 'Código mal elegido' }).expect(200); // prettier-ignore
      // Positive control: while it is live, the reason is read.
      const live = (await get(`${path}/versions`, doctorToken).expect(200)).body as VersionsBody; // prettier-ignore
      expect(live.items[0]).toMatchObject({ reason: 'Código mal elegido' });

      // J06 printed nothing: removing it needs no reason.
      await post(`${path}/retract`, doctorToken).expect(204);

      const archived = await prisma.encounterDiagnosisRetraction.findUniqueOrThrow({ where: { id: printed.id } }); // prettier-ignore
      expect(archived).toMatchObject({
        cie10Code: 'J06',
        editReason: 'Código mal elegido',
        editedAt: expect.any(Date),
        editedById: expect.any(String),
      });
      const after = (await get(`${path}/versions`, doctorToken).expect(200)).body as VersionsBody; // prettier-ignore
      expect(after.items).toEqual([
        expect.objectContaining({
          reason: 'Código mal elegido',
          diagnosis: expect.objectContaining({ cie10Code: 'J00' }),
        }),
      ]);
    });

    it('EN-212 D-117.13 tras el alta corrige quien firma historia, con su registro ACESS vigente; antes del alta, cualquiera que diagnostica', async () => {
      const encounterId = await openEncounter();
      const diagnosis = await record(encounterId, 'J020');
      const path = `/encounters/${encounterId}/diagnoses/${diagnosis.id}`;

      // A role that writes the history and does not sign it (a resident).
      const role = await prisma.role.create({
        data: {
          code: 'RESIDENTE_PRUEBA',
          name: 'Residente',
          permissions: { create: [{ permissionCode: 'record:read' }, { permissionCode: 'record:write' }] }, // prettier-ignore
        },
      });
      registry.invalidate();
      const resident = await signIn(
        role.code,
        'residente@clinica.ec',
        '0102030400',
      );

      // Positive control: live, the resident codes and corrects.
      await patch(path, resident.token, { certainty: 'PRESUMPTIVE' }).expect(
        200,
      );

      await dischargeOf(encounterId);
      const unsigned = await patch(path, resident.token, { certainty: 'DEFINITIVE' }).expect(403); // prettier-ignore
      expect((unsigned.body as Problem).code).toBe(
        'DIAGNOSIS_CORRECTION_REQUIRES_SIGNATURE',
      );
      const primary = await post(`${path}/primary`, resident.token).expect(403);
      expect((primary.body as Problem).code).toBe(
        'DIAGNOSIS_CORRECTION_REQUIRES_SIGNATURE',
      );

      // The doctor signs; with the registration lapsed, not even the doctor.
      await patch(path, doctorToken, { certainty: 'DEFINITIVE' }).expect(200);
      const doctor = await prisma.practitioner.findUniqueOrThrow({ where: { id: doctorPractitionerId } }); // prettier-ignore
      await prisma.user.update({
        where: { id: doctor.userId },
        data: { acessExpiresOn: new Date(Date.now() - 3 * DAY) },
      });
      const lapsed = await patch(path, doctorToken, { certainty: 'PRESUMPTIVE' }).expect(403); // prettier-ignore
      expect((lapsed.body as Problem).code).toBe('PRACTITIONER_NOT_LICENSED');
    });

    it('EN-212 D-117.16 una atención ya reportada al RDACAA no se corrige', async () => {
      const encounterId = await openEncounter();
      const diagnosis = await record(encounterId, 'J020');
      await dischargeOf(encounterId);
      const path = `/encounters/${encounterId}/diagnoses/${diagnosis.id}`;
      await patch(path, doctorToken, { certainty: 'PRESUMPTIVE' }).expect(200);

      await prisma.encounter.update({ where: { id: encounterId }, data: { reportedAt: new Date() } }); // prettier-ignore

      const refused = await patch(path, doctorToken, { certainty: 'DEFINITIVE' }).expect(409); // prettier-ignore
      expect((refused.body as Problem).code).toBe('ENCOUNTER_ALREADY_REPORTED');
    });

    it('EN-212 D-117.15 el diagnóstico obstétrico de un reposo de maternidad vigente no pasa a otro capítulo', async () => {
      const encounterId = await openEncounter();
      const obstetric = await record(encounterId, 'O800');
      const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } }); // prettier-ignore
      const day = clinicalDateOf(encounter.startedAt);
      await prisma.$executeRaw`
        INSERT INTO medical_certificate
          (encounter_id, patient_id, issued_by_id, type, rest_from, rest_to,
           include_diagnosis, verification_code, contingency_type,
           maternity_admission_on, birth_on, maternity_discharge_on, issued_at)
        VALUES (${encounterId}::uuid, ${encounter.patientId}::uuid,
                ${doctorPractitionerId}::uuid, 'MEDICAL_REST', ${day}::date,
                ${addDays(day, 83)}::date, false,
                ${`EN212M-${encounterId.slice(0, 12)}`}, 'MATERNITY',
                ${addDays(day, -2)}::date, ${addDays(day, -1)}::date,
                ${day}::date, ${encounter.startedAt})`;
      const path = `/encounters/${encounterId}/diagnoses/${obstetric.id}`;
      const outside = await aConcept('CIE10', {
        code: 'J020',
        display: 'Dx J020',
      });
      const inside = await aConcept('CIE10', {
        code: 'O820',
        display: 'Dx O820',
      });

      const refused = await patch(path, doctorToken, { conceptId: outside }).expect(409); // prettier-ignore
      expect((refused.body as Problem).code).toBe(
        'DIAGNOSIS_SUPPORTS_MATERNITY_REST',
      );
      // Positive control: within the chapter the rest stays supported.
      await patch(path, doctorToken, { conceptId: inside }).expect(200);
    });

    it('EN-212 ENFERMERÍA no edita diagnósticos, y uno de otra atención responde 404', async () => {
      const encounterId = await openEncounter();
      const other = await openEncounter();
      const diagnosis = await record(encounterId, 'J020');

      await patch(`/encounters/${encounterId}/diagnoses/${diagnosis.id}`, nurseToken, { certainty: 'PRESUMPTIVE' }).expect(403); // prettier-ignore
      const missing = await patch(`/encounters/${other}/diagnoses/${diagnosis.id}`, doctorToken, { certainty: 'PRESUMPTIVE' }).expect(404); // prettier-ignore
      expect((missing.body as Problem).code).toBe('DIAGNOSIS_NOT_FOUND');
      const empty = await patch(`/encounters/${encounterId}/diagnoses/${diagnosis.id}`, doctorToken, {}).expect(422); // prettier-ignore
      expect((empty.body as Problem).code).toBe('VALIDATION_FAILED');
    });

    it('EN-213 «Deshacer» devuelve el quitado tal como era y deja de figurar entre los quitados; dos veces, no', async () => {
      const encounterId = await openEncounter();
      await record(encounterId, 'J020');
      const wrong = await record(encounterId, 'R509', { certainty: 'PRESUMPTIVE', occurrence: 'SUBSEQUENT' }); // prettier-ignore
      const path = `/encounters/${encounterId}/diagnoses/${wrong.id}`;
      await post(`${path}/retract`, doctorToken).expect(204);

      const restored = await post(`${path}/restore`, doctorToken).expect(200);
      expect(restored.body).toMatchObject({
        cie10Code: 'R509',
        certainty: 'PRESUMPTIVE',
        occurrence: 'SUBSEQUENT',
        rank: 2,
      });
      const sheet = await sheetOf(encounterId);
      expect(sheet.items.map((d) => d.cie10Code)).toEqual(['J020', 'R509']);
      expect(sheet.retracted).toEqual([]);

      const again = await post(`${path}/restore`, doctorToken).expect(409);
      expect((again.body as Problem).code).toBe('DIAGNOSIS_NOT_RESTORABLE');
      // And the one brought back can be removed again.
      await post(`/encounters/${encounterId}/diagnoses/${(restored.body as DiagnosisBody).id}/retract`, doctorToken).expect(204); // prettier-ignore
    });

    it('EN-213 el diagnóstico recuperado con «Deshacer» es una fila nueva, y sus versiones siguen las de la fila quitada', async () => {
      const encounterId = await openEncounter();
      await record(encounterId, 'J020');
      const edited = await record(encounterId, 'R509');
      const path = `/encounters/${encounterId}/diagnoses/${edited.id}`;
      await patch(path, doctorToken, { certainty: 'PRESUMPTIVE' }).expect(200);
      await post(`${path}/retract`, doctorToken).expect(204);

      const restored = (await post(`${path}/restore`, doctorToken).expect(200)).body as DiagnosisBody; // prettier-ignore
      expect(restored.id).not.toBe(edited.id);

      // Positive control: the removed row has its version.
      const before = (await get(`${path}/versions`, doctorToken).expect(200)).body as VersionsBody; // prettier-ignore
      expect(before.items.map((v) => v.diagnosis.certainty)).toEqual(['DEFINITIVE']); // prettier-ignore

      const after = (await get(`/encounters/${encounterId}/diagnoses/${restored.id}/versions`, doctorToken).expect(200)).body as VersionsBody; // prettier-ignore
      expect(after.items).toEqual([
        expect.objectContaining({
          version: 1,
          diagnosis: expect.objectContaining({ cie10Code: 'R509', certainty: 'DEFINITIVE' }), // prettier-ignore
        }),
      ]);
    });

    it('EN-213 si mientras tanto otro quedó como principal, el principal quitado vuelve como secundario', async () => {
      const encounterId = await openEncounter();
      const principal = await record(encounterId, 'J020');
      const other = await record(encounterId, 'R509');
      await post(`/encounters/${encounterId}/diagnoses/${principal.id}/retract`, doctorToken).expect(204); // prettier-ignore
      await post(`/encounters/${encounterId}/diagnoses/${other.id}/primary`, doctorToken).expect(200); // prettier-ignore

      const restored = await post(`/encounters/${encounterId}/diagnoses/${principal.id}/restore`, doctorToken).expect(200); // prettier-ignore
      expect((restored.body as DiagnosisBody).rank).not.toBe(1);
      const sheet = await sheetOf(encounterId);
      expect(sheet.items[0]).toMatchObject({ cie10Code: 'R509', rank: 1 });
    });

    it('EN-213 «Deshacer» sólo en la atención viva, y no si el mismo código ya volvió a registrarse', async () => {
      const encounterId = await openEncounter();
      await record(encounterId, 'J020');
      const wrong = await record(encounterId, 'R509');
      await post(`/encounters/${encounterId}/diagnoses/${wrong.id}/retract`, doctorToken).expect(204); // prettier-ignore
      const conceptId = (await prisma.catalogConcept.findFirstOrThrow({ where: { code: 'R509' } })).id; // prettier-ignore
      await post(`/encounters/${encounterId}/diagnoses`, doctorToken, aDiagnosisBody(conceptId)).expect(201); // prettier-ignore

      const duplicate = await post(`/encounters/${encounterId}/diagnoses/${wrong.id}/restore`, doctorToken).expect(409); // prettier-ignore
      expect((duplicate.body as Problem).code).toBe('DIAGNOSIS_NOT_RESTORABLE');

      const closed = await openEncounter();
      await record(closed, 'K210');
      const gone = await record(closed, 'R51');
      await post(`/encounters/${closed}/diagnoses/${gone.id}/retract`, doctorToken).expect(204); // prettier-ignore
      await dischargeOf(closed);
      const refused = await post(`/encounters/${closed}/diagnoses/${gone.id}/restore`, doctorToken).expect(409); // prettier-ignore
      expect((refused.body as Problem).code).toBe('ENCOUNTER_ALREADY_CLOSED');
      // A diagnosis that was never removed from this attention: 404.
      const missing = await post(`/encounters/${encounterId}/diagnoses/${gone.id}/restore`, doctorToken).expect(404); // prettier-ignore
      expect((missing.body as Problem).code).toBe('DIAGNOSIS_NOT_FOUND');
    });

    it('EN-214 una receta emitida que imprimió el código: la lista lo dice, y quitarlo pide el motivo', async () => {
      const encounterId = await openEncounter();
      const printed = await record(encounterId, 'J020');
      const draft = await prisma.prescription.create({
        data: { encounterId, siteId, prescriberId: doctorPractitionerId },
      });
      await prisma.prescription.update({
        where: { id: draft.id },
        data: { status: 'ACTIVE', issuedAt: new Date() },
      });
      const later = await record(encounterId, 'R509');

      const sheet = (await get(`/encounters/${encounterId}/diagnoses`, doctorToken).expect(200)).body as { items: { cie10Code: string; printedOnPrescription: boolean }[] }; // prettier-ignore
      expect(Object.fromEntries(sheet.items.map((d) => [d.cie10Code, d.printedOnPrescription]))).toEqual({ J020: true, R509: false }); // prettier-ignore

      // Positive control: what the receta did not print.
      await post(`/encounters/${encounterId}/diagnoses/${later.id}/retract`, doctorToken).expect(204); // prettier-ignore
      const path = `/encounters/${encounterId}/diagnoses/${printed.id}/retract`;
      const refused = await post(path, doctorToken).expect(422);
      expect((refused.body as Problem).code).toBe(
        'DIAGNOSIS_RETRACTION_REASON_REQUIRED',
      );
      expect((refused.body as Problem).title).toContain(
        'un certificado, una receta o una orden',
      );
      await post(path, doctorToken, { reason: 'Código mal elegido' }).expect(
        204,
      );
    });

    it('EN-213 D-117.13 D-117.16 tras el alta quita quien firma historia, y nada si ya se reportó', async () => {
      const encounterId = await openEncounter();
      await record(encounterId, 'J020');
      const second = await record(encounterId, 'R509');
      const third = await record(encounterId, 'R51');
      await dischargeOf(encounterId);
      const role = await prisma.role.create({
        data: {
          code: 'RESIDENTE_PRUEBA',
          name: 'Residente',
          permissions: { create: [{ permissionCode: 'record:read' }, { permissionCode: 'record:write' }] }, // prettier-ignore
        },
      });
      registry.invalidate();
      const resident = await signIn(
        role.code,
        'residente@clinica.ec',
        '0102030400',
      );

      const unsigned = await post(`/encounters/${encounterId}/diagnoses/${second.id}/retract`, resident.token).expect(403); // prettier-ignore
      expect((unsigned.body as Problem).code).toBe(
        'DIAGNOSIS_CORRECTION_REQUIRES_SIGNATURE',
      );
      await post(`/encounters/${encounterId}/diagnoses/${second.id}/retract`, doctorToken).expect(204); // prettier-ignore

      await prisma.encounter.update({ where: { id: encounterId }, data: { reportedAt: new Date() } }); // prettier-ignore
      const reported = await post(`/encounters/${encounterId}/diagnoses/${third.id}/retract`, doctorToken).expect(409); // prettier-ignore
      expect((reported.body as Problem).code).toBe(
        'ENCOUNTER_ALREADY_REPORTED',
      );
    });

    it('EN-183 EN-188 con el alta no se desmarca ni se quita el principal sin que otro quede principal: 409 DIAGNOSIS_PRIMARY_REQUIRED_AFTER_DISCHARGE', async () => {
      const encounterId = await openEncounter();
      const principal = await record(encounterId, 'J020');
      const second = await record(encounterId, 'R509');
      await dischargeOf(encounterId);
      const path = `/encounters/${encounterId}/diagnoses/${principal.id}`;

      const unmarked = await patch(path, doctorToken, { primary: false }).expect(409); // prettier-ignore
      expect(unmarked.body).toMatchObject({
        code: 'DIAGNOSIS_PRIMARY_REQUIRED_AFTER_DISCHARGE',
        title:
          'La atención ya tiene el alta y necesita un diagnóstico principal: marque otro como principal antes de quitar o desmarcar éste',
      });
      const removed = await post(`${path}/retract`, doctorToken).expect(409);
      expect((removed.body as Problem).code).toBe(
        'DIAGNOSIS_PRIMARY_REQUIRED_AFTER_DISCHARGE',
      );
      expect((await sheetOf(encounterId)).items.map((d) => [d.cie10Code, d.rank])).toEqual([
        ['J020', 1],
        ['R509', 2],
      ]); // prettier-ignore

      // Positive control (EN-183): another becomes principal, then the old
      // one goes.
      await patch(`/encounters/${encounterId}/diagnoses/${second.id}`, doctorToken, { primary: true }).expect(200); // prettier-ignore
      await post(`${path}/retract`, doctorToken).expect(204);
      expect((await sheetOf(encounterId)).items.map((d) => [d.cie10Code, d.rank])).toEqual([
        ['R509', 1],
      ]); // prettier-ignore
    });

    it('EN-213 D-117.15 no se quita el diagnóstico obstétrico de un reposo de maternidad vigente', async () => {
      const encounterId = await openEncounter();
      const obstetric = await record(encounterId, 'O800');
      await record(encounterId, 'R509');
      const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } }); // prettier-ignore
      const day = clinicalDateOf(encounter.startedAt);
      await prisma.$executeRaw`
        INSERT INTO medical_certificate
          (encounter_id, patient_id, issued_by_id, type, rest_from, rest_to,
           include_diagnosis, verification_code, contingency_type,
           maternity_admission_on, birth_on, maternity_discharge_on, issued_at)
        VALUES (${encounterId}::uuid, ${encounter.patientId}::uuid,
                ${doctorPractitionerId}::uuid, 'MEDICAL_REST', ${day}::date,
                ${addDays(day, 83)}::date, false,
                ${`EN213M-${encounterId.slice(0, 12)}`}, 'MATERNITY',
                ${addDays(day, -2)}::date, ${addDays(day, -1)}::date,
                ${day}::date, ${encounter.startedAt})`;

      const refused = await post(`/encounters/${encounterId}/diagnoses/${obstetric.id}/retract`, doctorToken).expect(409); // prettier-ignore
      expect((refused.body as Problem).code).toBe(
        'DIAGNOSIS_SUPPORTS_MATERNITY_REST',
      );
    });

    it('EN-184 propone «subsecuente» por la misma CATEGORÍA en una atención anterior, y no por una anulada', async () => {
      const encounterId = await openEncounter();
      const today = await prisma.encounter.findUniqueOrThrow({
        where: { id: encounterId },
      });
      const earlier = await prisma.encounter.create({
        data: {
          siteId,
          practitionerId: doctorPractitionerId,
          patientId,
          startedAt: new Date(today.startedAt.getTime() - 30 * DAY),
          careModality: 'MORBIDITY',
          visitSequence: 'FIRST_TIME',
        },
      });
      const annulled = await prisma.encounter.create({
        data: {
          siteId,
          practitionerId: doctorPractitionerId,
          patientId,
          startedAt: new Date(today.startedAt.getTime() - 10 * DAY),
          careModality: 'MORBIDITY',
          visitSequence: 'FIRST_TIME',
        },
      });
      const e119 = await aConcept('CIE10', {
        code: 'E119',
        display: 'Diabetes tipo 2',
      });
      const i10 = await aConcept('CIE10', {
        code: 'I10X',
        display: 'Hipertensión',
      });
      await prisma.encounterDiagnosis.create({
        data: { encounterId: earlier.id, conceptId: e119, cie10Code: 'E119', cie10Display: 'Diabetes tipo 2', certainty: 'DEFINITIVE', occurrence: 'FIRST_TIME' }, // prettier-ignore
      });
      await prisma.encounterDiagnosis.create({
        data: { encounterId: annulled.id, conceptId: i10, cie10Code: 'I10X', cie10Display: 'Hipertensión', certainty: 'DEFINITIVE', occurrence: 'FIRST_TIME' }, // prettier-ignore
      });
      // Annulled behind the triggers: what is tested is the READ of it.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`); // prettier-ignore
        const by = await tx.practitioner.findUniqueOrThrow({ where: { id: doctorPractitionerId } }); // prettier-ignore
        await tx.encounter.update({
          where: { id: annulled.id },
          data: {
            status: 'ENTERED_IN_ERROR',
            enteredInErrorReason: 'Ficha equivocada',
            enteredInErrorById: by.userId,
            enteredInErrorAt: new Date(),
            endedAt: new Date(),
          },
        });
      });
      const e116 = await aConcept('CIE10', { code: 'E116', display: 'Diabetes con complicaciones' }); // prettier-ignore
      const before = await auditRows('patient_chart_summary');

      const subsequent = await get(
        `/encounters/${encounterId}/diagnoses/occurrence-proposal?conceptId=${e116}`,
        doctorToken,
      ).expect(200);
      expect(subsequent.body).toMatchObject({
        proposed: 'SUBSEQUENT',
        basis: {
          cie10Code: 'E119',
          encounterStartedAt: earlier.startedAt.toISOString(),
        },
      });

      const first = await get(
        `/encounters/${encounterId}/diagnoses/occurrence-proposal?conceptId=${i10}`,
        doctorToken,
      ).expect(200);
      expect(first.body).toEqual({ proposed: 'FIRST_TIME', basis: null });
      expect(await auditRows('patient_chart_summary')).toBe(before + 2);
    });

    it('EN-185 propone «primera vez» sólo cuando no hay ninguna atención que pueda ser del servicio', async () => {
      const specialty = await prisma.specialty.create({ data: { code: `PED-${siteId.slice(0, 8)}`, name: `Pediatría ${siteId}` } }); // prettier-ignore
      const other = await prisma.specialty.create({ data: { code: `DER-${siteId.slice(0, 8)}`, name: `Dermatología ${siteId}` } }); // prettier-ignore
      const serviceType = await prisma.serviceType.create({ data: { specialtyId: specialty.id, name: 'Consulta', durationMinutes: 20 } }); // prettier-ignore
      const otherType = await prisma.serviceType.create({ data: { specialtyId: other.id, name: 'Consulta', durationMinutes: 20 } }); // prettier-ignore
      const now = Date.now();
      const anAppointment = (typeId: string, offsetDays: number) =>
        prisma.agendaEntry.create({
          data: {
            kind: 'APPOINTMENT',
            bookingChannel: 'PHONE',
            siteId,
            practitionerId: doctorPractitionerId,
            patientId,
            serviceTypeId: typeId,
            startsAt: new Date(now + offsetDays * DAY),
            endsAt: new Date(now + offsetDays * DAY + 20 * 60 * 1000),
          },
        });
      const today = await anAppointment(serviceType.id, 1);
      const path = `/encounters/visit-sequence-proposal?agendaEntryId=${today.id}`;

      // Earlier only in another, KNOWN specialty: «primera vez» is certain.
      const elsewhere = await anAppointment(otherType.id, -20);
      await prisma.encounter.create({
        data: { siteId, practitionerId: doctorPractitionerId, patientId, agendaEntryId: elsewhere.id, startedAt: elsewhere.startsAt, careModality: 'MORBIDITY', visitSequence: 'FIRST_TIME' }, // prettier-ignore
      });
      expect((await get(path, doctorToken).expect(200)).body).toEqual({
        proposed: 'FIRST_TIME',
        specialtyKnown: true,
        last: null,
        elsewhere: false,
      });

      // One at a site the doctor does not cover takes the certainty away,
      // and nothing of it is told.
      const atOtherSite = await prisma.encounter.create({
        data: { siteId: otherSiteId, practitionerId: doctorPractitionerId, patientId, startedAt: new Date(now - 15 * DAY), careModality: 'MORBIDITY', visitSequence: 'FIRST_TIME' }, // prettier-ignore
      });
      expect((await get(path, doctorToken).expect(200)).body).toEqual({
        proposed: null,
        specialtyKnown: true,
        last: null,
        elsewhere: true,
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`); // prettier-ignore
        await tx.encounter.delete({ where: { id: atOtherSite.id } });
      });

      // A walk-in attention may be of the same service: no proposal.
      await prisma.encounter.create({
        data: { siteId, practitionerId: doctorPractitionerId, patientId, startedAt: new Date(now - 5 * DAY), careModality: 'MORBIDITY', visitSequence: 'FIRST_TIME' }, // prettier-ignore
      });
      const undecided = (await get(path, doctorToken).expect(200)).body as {
        proposed: null;
        last: { sameSpecialty: boolean };
      };
      expect(undecided.proposed).toBeNull();
      expect(undecided.last.sameSpecialty).toBe(false);
    });

    const patchEncounter = (encounterId: string, token: string, body: object) =>
      request(app.getHttpServer())
        .patch(`/api/v1/encounters/${encounterId}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

    /** A role that writes the history and does not sign it (a resident). */
    async function aResident(): Promise<string> {
      const role = await prisma.role.create({
        data: {
          code: 'RESIDENTE_PRUEBA',
          name: 'Residente',
          permissions: { create: [{ permissionCode: 'record:read' }, { permissionCode: 'record:write' }] }, // prettier-ignore
        },
      });
      registry.invalidate();
      return (await signIn(role.code, 'residente@clinica.ec', '0102030400'))
        .token;
    }

    async function interruptOf(encounterId: string): Promise<void> {
      const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } }); // prettier-ignore
      const at = new Date(encounter.startedAt.getTime() + 20 * 60_000);
      const { userId } = await prisma.practitioner.findUniqueOrThrow({ where: { id: doctorPractitionerId } }); // prettier-ignore
      await prisma.encounter.update({
        where: { id: encounterId },
        data: { status: 'DISCONTINUED', endedAt: at, discontinuedAt: at, discontinuedOrigin: 'PATIENT', discontinuedReason: 'Se fue', discontinuedById: userId }, // prettier-ignore
      });
    }

    it('EN-187 EN-215 corrige la modalidad de la atención mientras está viva', async () => {
      const encounterId = await openEncounter();

      const response = await patchEncounter(encounterId, doctorToken, {
        careModality: 'PREVENTION',
      }).expect(200);

      expect(response.body).toMatchObject({
        careModality: 'PREVENTION',
        visitSequence: 'FIRST_TIME',
      });
      const stored0 = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } }); // prettier-ignore
      expect(stored0.careModality).toBe('PREVENTION');
    });

    it('EN-215 tras el alta corrige la modalidad y la primera vez o subsecuente quien firma historia, y guarda cada versión', async () => {
      const encounterId = await openEncounter();
      await record(encounterId, 'J020');
      const resident = await aResident();

      // Positive control: live, the resident corrects it.
      await patchEncounter(encounterId, resident, { careModality: 'PREVENTION' }).expect(200); // prettier-ignore

      await dischargeOf(encounterId);
      const unsigned = await patchEncounter(encounterId, resident, { visitSequence: 'SUBSEQUENT' }).expect(403); // prettier-ignore
      expect((unsigned.body as Problem).code).toBe(
        'DIAGNOSIS_CORRECTION_REQUIRES_SIGNATURE',
      );

      const corrected = await patchEncounter(encounterId, doctorToken, {
        careModality: 'MORBIDITY',
        visitSequence: 'SUBSEQUENT',
      }).expect(200);
      expect(corrected.body).toMatchObject({
        careModality: 'MORBIDITY',
        visitSequence: 'SUBSEQUENT',
      });

      // D-127.2: each correction kept the row it replaced, with who and when.
      const versions = await prisma.recordVersion.findMany({
        where: { resourceType: 'encounter', resourceId: encounterId },
        orderBy: { version: 'asc' },
      });
      expect(
        versions.map((v) => {
          const data = v.data as { careModality: string; visitSequence: string }; // prettier-ignore
          return [v.version, data.careModality, data.visitSequence];
        }),
      ).toEqual([
        [1, 'MORBIDITY', 'FIRST_TIME'],
        [2, 'PREVENTION', 'FIRST_TIME'],
      ]);
      const { userId } = await prisma.practitioner.findUniqueOrThrow({ where: { id: doctorPractitionerId } }); // prettier-ignore
      expect(versions[1]?.changedById).toBe(userId);

      // Nothing to change is not an edit: no version of an identical row.
      await patchEncounter(encounterId, doctorToken, { visitSequence: 'SUBSEQUENT' }).expect(200); // prettier-ignore
      expect(await prisma.recordVersion.count({ where: { resourceType: 'encounter', resourceId: encounterId } })).toBe(2); // prettier-ignore

      await prisma.encounter.update({ where: { id: encounterId }, data: { reportedAt: new Date() } }); // prettier-ignore
      const reported = await patchEncounter(encounterId, doctorToken, { careModality: 'PREVENTION' }).expect(409); // prettier-ignore
      expect((reported.body as Problem).code).toBe(
        'ENCOUNTER_ALREADY_REPORTED',
      );
    });

    it('EN-215 una atención interrumpida no cambia de modalidad, y ENFERMERÍA no la corrige', async () => {
      const encounterId = await openEncounter();
      const nurse = await patchEncounter(encounterId, nurseToken, { careModality: 'PREVENTION' }).expect(403); // prettier-ignore
      expect((nurse.body as Problem).code).not.toBe('ENCOUNTER_ALREADY_CLOSED');

      await interruptOf(encounterId);
      const refused = await patchEncounter(encounterId, doctorToken, { careModality: 'PREVENTION' }).expect(409); // prettier-ignore
      expect((refused.body as Problem).code).toBe('ENCOUNTER_ALREADY_CLOSED');
      const stored = await prisma.encounter.findUniqueOrThrow({
        where: { id: encounterId },
      });
      expect(stored.careModality).toBe('MORBIDITY');
    });

    it('EN-215 D-117.13 D-117.16 tras el alta se registra un diagnóstico nuevo: quien firma historia, con registro vigente, y no si ya se reportó', async () => {
      const encounterId = await openEncounter();
      await record(encounterId, 'J020');
      const resident = await aResident();
      await dischargeOf(encounterId);

      const fever = await aConcept('CIE10', {
        code: 'R509',
        display: 'Fiebre',
      });
      const unsigned = await post(`/encounters/${encounterId}/diagnoses`, resident, aDiagnosisBody(fever)).expect(403); // prettier-ignore
      expect((unsigned.body as Problem).code).toBe(
        'DIAGNOSIS_CORRECTION_REQUIRES_SIGNATURE',
      );

      const added = await post(`/encounters/${encounterId}/diagnoses`, doctorToken, aDiagnosisBody(fever)).expect(201); // prettier-ignore
      expect(added.body).toMatchObject({ cie10Code: 'R509', rank: 2 });
      expect((await sheetOf(encounterId)).items.map((d) => d.cie10Code)).toEqual(['J020', 'R509']); // prettier-ignore

      const doctor = await prisma.practitioner.findUniqueOrThrow({ where: { id: doctorPractitionerId } }); // prettier-ignore
      await prisma.user.update({
        where: { id: doctor.userId },
        data: { acessExpiresOn: new Date(Date.now() - 3 * DAY) },
      });
      const other = await aConcept('CIE10', { code: 'I10', display: 'HTA' });
      const lapsed = await post(`/encounters/${encounterId}/diagnoses`, doctorToken, aDiagnosisBody(other)).expect(403); // prettier-ignore
      expect((lapsed.body as Problem).code).toBe('PRACTITIONER_NOT_LICENSED');
      await prisma.user.update({
        where: { id: doctor.userId },
        data: { acessExpiresOn: null },
      });

      await prisma.encounter.update({ where: { id: encounterId }, data: { reportedAt: new Date() } }); // prettier-ignore
      const reported = await post(`/encounters/${encounterId}/diagnoses`, doctorToken, aDiagnosisBody(other)).expect(409); // prettier-ignore
      expect((reported.body as Problem).code).toBe(
        'ENCOUNTER_ALREADY_REPORTED',
      );
    });

    it('EN-215 una atención interrumpida no admite un diagnóstico nuevo', async () => {
      const encounterId = await openEncounter();
      // Positive control: the same body is accepted while the attention lives.
      await record(encounterId, 'J020');
      await interruptOf(encounterId);
      const fever = await aConcept('CIE10', {
        code: 'R509',
        display: 'Fiebre',
      });
      const refused = await post(`/encounters/${encounterId}/diagnoses`, doctorToken, aDiagnosisBody(fever)).expect(409); // prettier-ignore
      expect((refused.body as Problem).code).toBe('ENCOUNTER_ALREADY_CLOSED');
    });
  });
});
