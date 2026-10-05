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

    it('EN-181 con la nota firmada pide el motivo, y con él lo guarda', async () => {
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

      const refused = await post(path, doctorToken, { reason: '  ' }).expect(
        422,
      );
      expect((refused.body as Problem).code).toBe(
        'DIAGNOSIS_RETRACTION_REASON_REQUIRED',
      );
      expect((refused.body as Problem).errors?.[0]?.field).toBe('reason');

      await post(path, doctorToken, { reason: 'Era otra faringitis' }).expect(
        204,
      );
      expect((await sheetOf(encounterId)).retracted[0]?.reason).toBe(
        'Era otra faringitis',
      );
    });

    it('EN-182 con exámenes vivos no se quita ni se reordena, y se dice que se anulen; anulados, sí', async () => {
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

      const refused = await post(`${path}/retract`, doctorToken).expect(409);
      expect((refused.body as Problem).code).toBe('DIAGNOSIS_CITED_BY_ISSUED_DOCUMENT'); // prettier-ignore
      expect((refused.body as Problem).title).toContain('Anule primero los exámenes'); // prettier-ignore
      await post(`${path}/primary`, doctorToken).expect(409);

      // The way out the sentence names is real: cancel the exams (ORD-007).
      await prisma.serviceOrderItem.update({
        where: { id: order.items[0]!.id },
        data: { status: 'CANCELLED' },
      });
      await post(`${path}/retract`, doctorToken).expect(204);
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

      await post(`/encounters/${encounterId}/diagnoses/${first.id}/retract`, doctorToken).expect(204); // prettier-ignore

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

    it('EN-188 con el alta se quita con motivo y se marca otro como principal; interrumpida, no', async () => {
      const encounterId = await openEncounter();
      const first = await record(encounterId, 'J020');
      const second = await record(encounterId, 'R509');
      const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } }); // prettier-ignore
      await prisma.encounter.update({
        where: { id: encounterId },
        data: { status: 'DISCHARGED', endedAt: new Date(encounter.startedAt.getTime() + 20 * 60_000), dischargeCondition: 'ALIVE' }, // prettier-ignore
      });
      const path = `/encounters/${encounterId}/diagnoses/${first.id}/retract`;

      const refused = await post(path, doctorToken).expect(422);
      expect((refused.body as Problem).code).toBe(
        'DIAGNOSIS_RETRACTION_REASON_REQUIRED',
      );
      await post(path, doctorToken, { reason: 'Código equivocado' }).expect(204); // prettier-ignore
      await post(`/encounters/${encounterId}/diagnoses/${second.id}/primary`, doctorToken).expect(200); // prettier-ignore

      const sheet = await sheetOf(encounterId);
      expect(sheet.items).toEqual([
        expect.objectContaining({ cie10Code: 'R509', rank: 1 }),
      ]);
      expect(sheet.retracted[0]?.reason).toBe('Código equivocado');

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

    it('EN-187 corrige la modalidad de la atención mientras está viva', async () => {
      const encounterId = await openEncounter();

      const response = await request(app.getHttpServer())
        .put(`/api/v1/encounters/${encounterId}/care-modality`)
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ careModality: 'PREVENTION' })
        .expect(200);

      expect(response.body).toEqual({ careModality: 'PREVENTION' });
      const stored0 = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } }); // prettier-ignore
      expect(stored0.careModality).toBe('PREVENTION');
    });

    it('EN-187 una atención con alta ya no cambia de modalidad', async () => {
      const encounterId = await openEncounter();
      await prisma.encounter.update({
        where: { id: encounterId },
        data: { status: 'DISCHARGED', endedAt: new Date(), dischargeCondition: 'ALIVE' }, // prettier-ignore
      });

      const refused = await request(app.getHttpServer())
        .put(`/api/v1/encounters/${encounterId}/care-modality`)
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ careModality: 'PREVENTION' })
        .expect(409);
      expect((refused.body as Problem).code).toBe('ENCOUNTER_ALREADY_CLOSED');
      const stored = await prisma.encounter.findUniqueOrThrow({
        where: { id: encounterId },
      });
      expect(stored.careModality).toBe('MORBIDITY');
    });
  });
});
