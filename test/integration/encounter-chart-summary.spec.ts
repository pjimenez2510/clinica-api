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
 * H6 as the browser consumes it: las alergias y la historia durante la
 * consulta.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ADDS OVER THE REPOSITORY SUITE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything between the browser and the database, WITH REAL SESSIONS and the
 * roles the seed ships — «el defecto de AG-111 fue exactamente confiar en un
 * doble con los permisos puestos a mano». Three things can only be shown here:
 *
 *  - EN-081: the allergies arrive WITH the attention, in the same response and
 *    without a second call. A screen cannot forget to ask for what it did not
 *    have to ask for.
 *  - The permission split, WHICH IS DRAWN AT WRITING AND NOT AT LOOKING:
 *    `ENFERMERIA` reads the summary — it holds `record:read` on purpose,
 *    «porque unos signos vitales sin contexto no sirven de nada» — and cannot
 *    record an allergy. `RECEPCION` holds neither and receives nothing
 *    clinical at all.
 *  - EN-161: COUNTING ROWS of `access_audit`. Reading the summary leaves ONE,
 *    not one per listed attention.
 */
const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  code: string;
}

interface AllergyBody {
  id: string;
  substanceText: string;
  criticality: string;
  refutedAt: string | null;
  refutedNotes: string | null;
}

interface AllergyListBody {
  items: AllergyBody[];
  /** EN-087. `null` es «no se preguntó», nunca «no tiene». */
  noKnownAllergies: NoKnownAllergiesBody | null;
}

interface EncounterDetailBody {
  id: string;
  allergies: AllergyBody[];
}

interface NoKnownAllergiesBody {
  assertedById: string;
  assertedByName: string;
  assertedAt: string;
}

interface ChartSummaryBody {
  encounterId: string;
  patientId: string;
  allergies: AllergyBody[];
  /** EN-087. `null` es «no se preguntó», nunca «no tiene». */
  noKnownAllergies: NoKnownAllergiesBody | null;
  previousEncounters: {
    id: string;
    diagnoses: { cie10Code: string }[];
    vitals: { weightKg: number | null } | null;
  }[];
  totalEncounters: number;
}

describe('las alergias y la historia de la consulta por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
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
    registry.invalidate();

    const site = await createSite(prisma);
    const patient = await createPatient(prisma);
    siteId = site.id;
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
   * One account with one role, granted AT ONE SITE.
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

  const openEncounter = async (
    startedAt = '2026-08-20T14:00:00Z',
  ): Promise<string> => {
    const response = await post('/encounters', doctorToken, {
      siteId,
      practitionerId: doctorPractitionerId,
      patientId,
      startedAt,
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    }).expect(201);
    return (response.body as { id: string }).id;
  };

  const recordAllergy = (body: object, token = doctorToken) =>
    post(`/patients/${patientId}/allergies`, token, body);

  /** EN-087. Sin cuerpo: el autor es la SESIÓN y no un campo que se pueda poner. */
  const assertNoKnownAllergies = (token = doctorToken) =>
    post(`/patients/${patientId}/allergies/none-known`, token);

  const auditRows = (resourceType: string) =>
    prisma.accessAudit.count({ where: { resourceType } });

  describe('quién puede tocar las alergias', () => {
    it('EN-120 rechaza registrar una alergia sin sesión', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/patients/${patientId}/allergies`)
        .send({ substanceText: 'Penicilina', criticality: 'HIGH' })
        .expect(401);
    });

    it('EN-142 no deja a ENFERMERÍA registrar una alergia: no es tomar un peso', async () => {
      /**
       * ⚠️ LO QUE EL PERMISO NIEGA ES TAN IMPORTANTE COMO LO QUE CONCEDE.
       * `nursing:write` y `vitals:write` no aparecen en ninguna ruta de este
       * fichero: decidir que un paciente es alérgico a algo, con una
       * criticidad puesta, es un juicio clínico que queda en el expediente y
       * gobierna lo que puede recetarse.
       */
      await recordAllergy(
        { substanceText: 'Penicilina', criticality: 'HIGH' },
        nurseToken,
      ).expect(403);
    });

    it('EN-142 no deja a RECEPCIÓN leer las alergias, que son contenido clínico', async () => {
      // Recepción lleva `patient:read` y NO lleva `record:read`: sigue
      // trabajando, y este dato simplemente no forma parte de lo que recibe.
      // Es la misma división que PA-040 y PA-042 hacen con el motivo de un
      // grupo prioritario.
      await get(`/patients/${patientId}/allergies`, receptionToken).expect(403);
    });

    it('EN-087 no deja a ENFERMERÍA afirmar «sin alergias conocidas»', async () => {
      /**
       * Es el mismo juicio clínico visto del otro lado: afirmar que un paciente
       * no tiene alergias conocidas gobierna lo que puede recetarse igual que
       * registrar una. La línea sigue estando en escribir y no en mirar —
       * enfermería lee el resumen y no escribe esto.
       */
      await assertNoKnownAllergies(nurseToken).expect(403);
    });

    it('EN-080 deja al MÉDICO registrar la alergia con `record:write`', async () => {
      const response = await recordAllergy({
        substanceText: 'Penicilina',
        reaction: 'Anafilaxia',
        criticality: 'HIGH',
      }).expect(201);

      expect((response.body as AllergyBody).substanceText).toBe('Penicilina');
      expect((response.body as AllergyBody).refutedAt).toBeNull();
    });
  });

  describe('el contrato de la alergia', () => {
    it('EN-083 rechaza registrar una alergia sin criticidad en vez de suponerla', async () => {
      /**
       * §7 bis midió lo que cuestan los valores clínicos precargados: de 324
       * eventos de seguridad atribuidos a ellos, 128 —el fallo dominante—
       * fueron simplemente no cambiar el valor que venía puesto. El campo no
       * tiene `.default()` a propósito.
       */
      const response = await recordAllergy({
        substanceText: 'Penicilina',
      }).expect(422);

      expect((response.body as Problem).code).toBe('VALIDATION_FAILED');
      expect(await prisma.patientAllergy.count()).toBe(0);
    });

    it('EN-082 exige el motivo al descartar una alergia', async () => {
      const created = await recordAllergy({
        substanceText: 'Penicilina',
        criticality: 'HIGH',
      }).expect(201);
      const id = (created.body as AllergyBody).id;

      await post(`/patients/${patientId}/allergies/${id}/refute`, doctorToken, {
        notes: '',
      }).expect(422);

      const stored = await prisma.patientAllergy.findUniqueOrThrow({
        where: { id },
      });
      expect(stored.refutedAt).toBeNull();
    });

    it('EN-082 descarta la alergia y la fila sigue existiendo, con su motivo', async () => {
      const created = await recordAllergy({
        substanceText: 'Penicilina',
        criticality: 'HIGH',
      }).expect(201);
      const id = (created.body as AllergyBody).id;

      const refuted = await post(
        `/patients/${patientId}/allergies/${id}/refute`,
        doctorToken,
        { notes: 'Prueba cutánea negativa' },
      ).expect(200);

      expect((refuted.body as AllergyBody).refutedNotes).toBe(
        'Prueba cutánea negativa',
      );
      // CONTANDO FILAS: sigue habiendo una.
      expect(await prisma.patientAllergy.count()).toBe(1);

      const listed = await get(
        `/patients/${patientId}/allergies`,
        doctorToken,
      ).expect(200);
      expect((listed.body as { items: AllergyBody[] }).items).toHaveLength(1);
    });

    it('EN-082 responde 409 a la segunda refutación en vez de reescribir la primera', async () => {
      const created = await recordAllergy({
        substanceText: 'Penicilina',
        criticality: 'HIGH',
      }).expect(201);
      const id = (created.body as AllergyBody).id;
      const refute = (notes: string) =>
        post(`/patients/${patientId}/allergies/${id}/refute`, doctorToken, {
          notes,
        });

      await refute('Primera valoración').expect(200);
      const second = await refute('Segunda valoración').expect(409);

      expect((second.body as Problem).code).toBe('ALLERGY_ALREADY_REFUTED');
    });

    it('EN-087 el listado sirve «sin alergias conocidas» con quién y cuándo', async () => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * LA FICHA DEL PACIENTE NO PODÍA DISTINGUIR DOS COSAS DISTINTAS
       * ═══════════════════════════════════════════════════════════════════════
       *
       * «Sin alergias conocidas, afirmado por la Dra. X el 14-03-2026» y «nadie
       * lo preguntó» llegaban las dos como una lista vacía. El estándar es
       * explícito: `nilknown` es «una afirmación positiva por parte de un
       * usuario clínico, y no una posición por defecto afirmada por un sistema
       * informático a falta de otra información», así que sin nombre y sin
       * fecha la afirmación no se puede leer — y sin poder leerla, la columna
       * era decorativa.
       */
      const before = await get(
        `/patients/${patientId}/allergies`,
        doctorToken,
      ).expect(200);
      expect((before.body as AllergyListBody).items).toHaveLength(0);
      expect((before.body as AllergyListBody).noKnownAllergies).toBeNull();

      await assertNoKnownAllergies().expect(201);

      const after = await get(
        `/patients/${patientId}/allergies`,
        doctorToken,
      ).expect(200);
      const body = after.body as AllergyListBody;

      expect(body.items).toHaveLength(0);
      expect(body.noKnownAllergies?.assertedByName).toBe('Ana Villacís');
      expect(body.noKnownAllergies?.assertedAt).toEqual(expect.any(String));
    });

    it('EN-087 el listado y el resumen dicen lo MISMO sobre la afirmación', async () => {
      // Un segundo presentador acabaría discrepando, y en lo que discreparía es
      // en `assertedByName`: la mitad que convierte esto en la afirmación de
      // una persona en vez de en el silencio de una base de datos.
      const encounterId = await openEncounter();
      await assertNoKnownAllergies().expect(201);

      const listed = await get(
        `/patients/${patientId}/allergies`,
        doctorToken,
      ).expect(200);
      const summary = await get(
        `/encounters/${encounterId}/chart-summary`,
        doctorToken,
      ).expect(200);

      expect((listed.body as AllergyListBody).noKnownAllergies).toEqual(
        (summary.body as ChartSummaryBody).noKnownAllergies,
      );
    });

    it('EN-087 registrar una alergia después apaga la afirmación también en el listado', async () => {
      /**
       * Afirmado hoy, penicilina cinco minutos después: la afirmación no era
       * falsa, dejó de ser la última palabra. Mantenerla viva junto a una lista
       * con filas sería la contradicción escrita en la historia — y quien lee
       * la primera frase deja de mirar la lista.
       */
      await assertNoKnownAllergies().expect(201);
      await recordAllergy({
        substanceText: 'Penicilina',
        criticality: 'HIGH',
      }).expect(201);

      const response = await get(
        `/patients/${patientId}/allergies`,
        doctorToken,
      ).expect(200);
      const body = response.body as AllergyListBody;

      expect(body.items).toHaveLength(1);
      expect(body.noKnownAllergies).toBeNull();
    });

    it('EN-087 servir la afirmación no duplica la fila de bitácora del listado', async () => {
      // Es la misma divulgación y el mismo acto: una entrada por LECTURA, no
      // una por mitad de la respuesta (EN-123).
      await assertNoKnownAllergies().expect(201);
      const before = await auditRows('patient_allergy');

      await get(`/patients/${patientId}/allergies`, doctorToken).expect(200);

      expect(await auditRows('patient_allergy')).toBe(before + 1);
    });

    it('EN-082 responde 404 al descartar una alergia que no está en esa ficha', async () => {
      const other = await createPatient(prisma);
      const created = await post(
        `/patients/${other.id}/allergies`,
        doctorToken,
        { substanceText: 'Látex', criticality: 'LOW' },
      ).expect(201);

      const response = await post(
        `/patients/${patientId}/allergies/${(created.body as AllergyBody).id}/refute`,
        doctorToken,
        { notes: 'motivo' },
      ).expect(404);

      expect((response.body as Problem).code).toBe('PATIENT_ALLERGY_NOT_FOUND');
    });
  });

  describe('la historia a la vista durante la consulta', () => {
    it('EN-081 la apertura de la atención trae las alergias activas sin pedirlas aparte', async () => {
      /**
       * Es la mitad literal de REQ-008: «de forma visible de manera permanente
       * durante la consulta». Una alergia que hay que ir a buscar a otra
       * pantalla no es visible de manera permanente, y lo que un médico con
       * prisa no ve, no existe.
       */
      await recordAllergy({
        substanceText: 'Ibuprofeno',
        criticality: 'LOW',
      }).expect(201);
      await recordAllergy({
        substanceText: 'Penicilina',
        criticality: 'HIGH',
      }).expect(201);
      const encounterId = await openEncounter();

      const response = await get(
        `/encounters/${encounterId}`,
        doctorToken,
      ).expect(200);
      const body = response.body as EncounterDetailBody;

      expect(body.allergies).toHaveLength(2);
      // EN-083. La peor primero: es la que cambia lo que se hace ahora.
      expect(body.allergies[0]?.substanceText).toBe('Penicilina');
    });

    it('EN-081 la alergia refutada NO viaja con la apertura de la atención', async () => {
      const created = await recordAllergy({
        substanceText: 'Penicilina',
        criticality: 'HIGH',
      }).expect(201);
      await post(
        `/patients/${patientId}/allergies/${(created.body as AllergyBody).id}/refute`,
        doctorToken,
        { notes: 'Prueba cutánea negativa' },
      ).expect(200);

      const encounterId = await openEncounter();
      const response = await get(
        `/encounters/${encounterId}`,
        doctorToken,
      ).expect(200);

      expect((response.body as EncounterDetailBody).allergies).toHaveLength(0);
    });

    it('EN-124 el LISTADO de atenciones no lleva alergias, aunque la apertura sí', async () => {
      /**
       * El listado lo abre cualquiera con `record:read` sobre la sede y no
       * deja fila de bitácora (EN-123), así que un dato clínico no puede
       * viajar en él. La división es el requisito, no una cuestión de orden.
       */
      await recordAllergy({
        substanceText: 'Penicilina',
        criticality: 'HIGH',
      }).expect(201);
      await openEncounter();

      const response = await get(
        `/encounters?patientId=${patientId}`,
        doctorToken,
      ).expect(200);
      const [first] = (response.body as { items: object[] }).items;

      expect(Object.keys(first ?? {})).not.toContain('allergies');
    });

    it('EN-159 el resumen trae alergias, atenciones anteriores y el total, en una sola respuesta', async () => {
      await recordAllergy({
        substanceText: 'Penicilina',
        criticality: 'HIGH',
      }).expect(201);
      await openEncounter('2026-05-11T14:00:00Z');
      await openEncounter('2026-06-10T14:00:00Z');
      const today = await openEncounter('2026-08-20T14:00:00Z');

      const response = await get(
        `/encounters/${today}/chart-summary`,
        doctorToken,
      ).expect(200);
      const body = response.body as ChartSummaryBody;

      expect(body.patientId).toBe(patientId);
      expect(body.allergies[0]?.substanceText).toBe('Penicilina');
      expect(body.previousEncounters).toHaveLength(2);
      // La de hoy no se lista como su propia historia.
      expect(body.previousEncounters.map((e) => e.id)).not.toContain(today);
      expect(body.totalEncounters).toBe(2);
    });

    it('EN-087 el resumen distingue los TRES estados, y el vacío dice «no se preguntó»', async () => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * ES LA FRASE DEL ESTÁNDAR COMPROBADA SOBRE EL JSON
       * ═══════════════════════════════════════════════════════════════════════
       *
       * «Sin alergias conocidas» es *«una afirmación positiva por parte de un
       * usuario clínico, y no una posición por defecto afirmada por un sistema
       * informático a falta de otra información»*. Sobre el contrato eso son
       * dos aserciones: que una ficha sin nada devuelve `null` —y no algo que
       * una pantalla pueda leer como «ninguna»— y que la afirmación, cuando
       * existe, viaja CON NOMBRE Y FECHA.
       */
      const today = await openEncounter();

      const before = await get(
        `/encounters/${today}/chart-summary`,
        doctorToken,
      ).expect(200);
      const empty = before.body as ChartSummaryBody;
      expect(empty.allergies).toHaveLength(0);
      expect(empty.noKnownAllergies).toBeNull();

      const created = await assertNoKnownAllergies().expect(201);
      expect((created.body as NoKnownAllergiesBody).assertedByName).toBe(
        'Ana Villacís',
      );

      const after = await get(
        `/encounters/${today}/chart-summary`,
        doctorToken,
      ).expect(200);
      const asserted = after.body as ChartSummaryBody;

      expect(asserted.allergies).toHaveLength(0);
      // Con quién y cuándo: sin las dos cosas la banda no puede escribir la
      // frase, y sin la frase el estado vuelve a ser «no lo sabemos».
      expect(asserted.noKnownAllergies?.assertedByName).toBe('Ana Villacís');
      expect(asserted.noKnownAllergies?.assertedAt).toEqual(expect.any(String));
    });

    it('EN-087 registrar una alergia después deja de servir la afirmación', async () => {
      /**
       * Afirmado hoy, penicilina cinco minutos después: la afirmación no era
       * falsa, pero dejó de ser la última palabra sobre esta ficha. Lo que la
       * pantalla pinta entonces es la lista, y el campo que la sostenía se
       * apaga en lugar de contradecirla.
       */
      const today = await openEncounter();
      await assertNoKnownAllergies().expect(201);

      await recordAllergy({
        substanceText: 'Penicilina',
        criticality: 'HIGH',
      }).expect(201);

      const response = await get(
        `/encounters/${today}/chart-summary`,
        doctorToken,
      ).expect(200);
      const body = response.body as ChartSummaryBody;

      expect(body.allergies).toHaveLength(1);
      expect(body.noKnownAllergies).toBeNull();
    });

    it('EN-087 rechaza afirmar «sin alergias conocidas» sobre una ficha con alergias', async () => {
      // Las dos frases a la vez son una contradicción escrita en la historia, y
      // quien lee la primera deja de mirar la lista. La salida es refutarlas
      // una a una con su motivo, que es un juicio clínico por alergia.
      await recordAllergy({
        substanceText: 'Penicilina',
        criticality: 'HIGH',
      }).expect(201);

      const response = await assertNoKnownAllergies().expect(409);

      expect((response.body as Problem).code).toBe('CHART_HAS_ALLERGIES');
    });

    it('EN-160 el resumen no lleva el texto de ninguna nota: enlaza con el identificador', async () => {
      /**
       * De una nota clínica de hoy, el 18% lo escribió su autor; el 46% está
       * copiado y el 36% importado. La regla que §7 bis saca de ahí es la de
       * este requisito: se enlaza o se muestra al lado, nunca se pega.
       */
      const previous = await openEncounter('2026-05-11T14:00:00Z');
      await post(`/encounters/${previous}/notes`, doctorToken, {
        formCode: '002',
        content: {
          motivoConsulta: 'Dolor abdominal de dos días',
          antecedentes: 'Sin antecedentes patológicos de importancia',
          enfermedadActual: 'Dolor en epigastrio, sin irradiación',
          revisionOrganosSistemas: 'Resto de sistemas sin particularidades',
          examenFisico: 'Abdomen blando, doloroso a la palpación',
          planTratamiento: 'Dieta blanda y control en 72 horas',
        },
      }).expect(201);
      const today = await openEncounter('2026-08-20T14:00:00Z');

      const response = await get(
        `/encounters/${today}/chart-summary`,
        doctorToken,
      ).expect(200);
      const serialised = JSON.stringify(response.body);

      expect(serialised).toContain(previous);
      expect(serialised).not.toContain('Dolor abdominal');
      expect(serialised).not.toContain('antecedentes');
    });

    it('EN-161 leer el resumen deja UNA fila de bitácora, no una por atención listada', async () => {
      /**
       * Una vista que lea cuarenta fichas sin dejar rastro es lo que la
       * bitácora existe para impedir; cuarenta filas que no dicen nada es cómo
       * se entierran los accesos que sí importan (EN-123).
       */
      await openEncounter('2026-05-11T14:00:00Z');
      await openEncounter('2026-06-10T14:00:00Z');
      await openEncounter('2026-07-08T14:00:00Z');
      const today = await openEncounter('2026-08-20T14:00:00Z');

      await get(`/encounters/${today}/chart-summary`, doctorToken).expect(200);

      expect(await auditRows('patient_chart_summary')).toBe(1);
    });

    it('EN-161 no deja rastro de una atención que no existe: nada se divulgó', async () => {
      // Una fila por identificador adivinado dejaría llenar el rastro de
      // ruido, que es el criterio que PA-024 ya fijó.
      await get(
        '/encounters/00000000-0000-7000-8000-000000000000/chart-summary',
        doctorToken,
      ).expect(404);

      expect(await auditRows('patient_chart_summary')).toBe(0);
    });

    it('EN-142 ENFERMERÍA SÍ lee el resumen, y sigue sin poder escribir una alergia', async () => {
      /**
       * ⚠️ Y ES DELIBERADO, no un descuido del reparto de permisos.
       * `ENFERMERIA` lleva `record:read` desde el sembrado, con su motivo
       * escrito: «reads the record because vital signs without context are
       * useless». Quien pesa a un niño necesita saber cuánto pesaba en marzo
       * — es exactamente el dato que §7 bis pone primero en la lista de lo
       * que los clínicos echaban en falta.
       *
       * Lo que separa los dos roles es la ESCRITURA, y esta prueba lo afirma
       * en la misma respiración para que la lectura no se lea como un agujero:
       * `record:write` no lo tiene, así que no registra alergias.
       */
      const today = await openEncounter();

      await get(`/encounters/${today}/chart-summary`, nurseToken).expect(200);
      await recordAllergy(
        { substanceText: 'Penicilina', criticality: 'HIGH' },
        nurseToken,
      ).expect(403);
    });
  });
});
