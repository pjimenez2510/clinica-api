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
});
