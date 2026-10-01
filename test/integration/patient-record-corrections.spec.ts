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
import { closeApp, listenForTests } from './setup/http-server';

/**
 * La ficha que el RDACAA exige y la ruta de corrección, contra PostgreSQL 18 de
 * verdad (P2: PA-008, PA-009, PA-015, PA-026 a PA-032).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ PRUEBA ESTO QUE LAS UNITARIAS NO PUEDEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. Que los dos `CHECK` que P2 añade EXISTAN y rechacen la fila. Se atacan
 *     por SQL directo además de por la ruta: una importación, una migración de
 *     datos o un `INSERT` por `psql` no pasan por el DTO, y un servicio que
 *     comprueba lo mismo no demuestra que la base lo impida.
 *  2. Que `patient_deceased_after_birth` resuelva el día en
 *     `America/Guayaquil` y NO en el huso de la sesión. Es lo único que
 *     distingue el CHECK escrito de un `::date` desnudo, y la diferencia sólo
 *     se ve moviendo la sesión de huso — que es lo que hace la mitad de esta
 *     suite.
 *  3. Que una corrección deje DOS filas y no una (PA-031): el histórico con el
 *     valor anterior y la bitácora sin él. La segunda mitad importa tanto como
 *     la primera: la lista blanca de
 *     `access_audit_payload_only_for_declared_resources` no incluye
 *     `'patient'`, y como registrar no lanza, una fila con carga útil se habría
 *     perdido en silencio.
 *  4. Que `patient_change_history` NO sea append-only, al contrario que
 *     `access_audit`. Es deliberado, y sin prueba alguien «arregla» la
 *     asimetría añadiéndole un disparador de inmutabilidad.
 */
const PASSWORD = 'el caballo come alfalfa';
const RECEPCION_EMAIL = 'admision@clinica.ec';

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

interface ConceptBody {
  id: string;
  code: string;
  display: string;
}

interface ParishBody extends ConceptBody {
  provinceCode: string | null;
  provinceDisplay: string | null;
  cantonCode: string | null;
  cantonDisplay: string | null;
}

/**
 * PA-053. El país de la ficha: el código guardado y cómo se llama.
 *
 * SIN `id`, a diferencia de `ConceptBody`: la ficha no guarda una fila del
 * catálogo, guarda tres letras — igual que `issuingCountry` de un documento.
 */
interface CountryBody {
  code: string;
  display: string | null;
}

interface PatientBody {
  id: string;
  mrn: string;
  familyName: string;
  givenName: string;
  birthDate: string;
  deceasedAt: string | null;
  age: { years: number; months: number | null; days: number | null };
  rdacaaMissingFields: string[];
  isProvisional: boolean;
  motherPatientId: string | null;
  ethnicity: ConceptBody | null;
  nationality: ConceptBody | null;
  genderIdentity: ConceptBody | null;
  countryOfNationality: CountryBody | null;
  residenceParish: ParishBody | null;
  identifiers: { type: string; issuingCountry: string; value: string }[];
  primaryIdentifier: { value: string } | null;
}

/**
 * Una cédula sintética con el dígito verificador CALCULADO, nunca copiado.
 *
 * Los nueve primeros dígitos se eligen para que la provincia esté entre 01 y 24
 * y el tercer dígito sea menor que 6 — lo que la base exige en
 * `patient_identifier_cedula_valid`—, y el décimo sale del módulo 10. Copiar el
 * número de una persona real está prohibido, y componerlo a ojo produce un
 * rechazo por el motivo equivocado.
 */
function cedulaFor(firstNine: string): string {
  const digits = [...firstNine].map(Number);
  const total = digits.reduce((sum, digit, index) => {
    if (index % 2 !== 0) return sum + digit;
    const doubled = digit * 2;
    return sum + (doubled > 9 ? doubled - 9 : doubled);
  }, 0);
  return `${firstNine}${(10 - (total % 10)) % 10}`;
}

describe('la ficha del RDACAA y su corrección, contra la base', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  /** `RECEPCION`: `patient:read` + `patient:write`, que es quien admite. */
  let recepcion: string;
  let recepcionUserId: string;

  /** Los conceptos sembrados por esta prueba, uno por sistema. */
  let ethnicityId: string;
  /**
   * PA-027. La OTRA etnia, la que no activa el campo de nacionalidad.
   *
   * Hacen falta dos porque la regla tiene dos lados, y el que rechaza es el que
   * no se ve nunca si sólo se siembra la que sirve.
   */
  let mestizoEthnicityId: string;
  let nationalityId: string;
  let genderIdentityId: string;
  let parishId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
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

    await syncAuthorisation(prisma);
    // The role→permission cache is indexed by id and truncation recreates the
    // roles with fresh ids: without this every request answers 403.
    registry.invalidate();

    recepcion = await signIn(RECEPCION_EMAIL, 'RECEPCION');
    await seedCatalogues();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(email: string, roleCode: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Gabriela',
        lastName: 'Mera',
        cedula: cedulaFor('092345678'),
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    recepcionUserId = user.id;

    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id },
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  /**
   * Los cuatro catálogos de los que la ficha ELIGE, sembrados aquí.
   *
   * SE SIEMBRAN EN LA PRUEBA Y NO EN UN FIXTURE COMPARTIDO, porque lo que se
   * comprueba es precisamente que la ficha guarda una REFERENCIA a un concepto
   * y la devuelve con la redacción con la que se registró. Los tres primeros
   * son listas planas —`hierarchical: false`—: el INEC revisa las categorías,
   * pero no forman árbol. El DPA sí, y por eso su concepto es una parroquia de
   * seis dígitos de verdad, con la que se comprueba la derivación de PA-028.
   */
  async function seedCatalogues(): Promise<void> {
    const flat = async (
      code: string,
      name: string,
      concept: { code: string; display: string },
    ): Promise<string> => {
      const system = await prisma.catalogSystem.create({
        data: { code, name, hierarchical: false },
      });
      const row = await prisma.catalogConcept.create({
        data: {
          systemId: system.id,
          code: concept.code,
          display: concept.display,
          validFrom: new Date('2020-01-01'),
        },
      });
      return row.id;
    };

    /**
     * ⚠️ CON EL CÓDIGO DEL INEC, `1`, Y NO UN NOMBRE INVENTADO.
     *
     * Es el único valor con el que el RDACAA activa el campo de nacionalidad
     * (PA-027), y el código —no el texto— es lo que el sistema reconoce:
     * `INDIGENOUS_ETHNICITY_CODE`. Sembrar aquí `MONTUBIO` dejaba la mitad de
     * estas pruebas registrando una ficha que el ministerio no admite.
     */
    const ethnicities = await prisma.catalogSystem.create({
      data: {
        code: 'ETHNICITY',
        name: 'Autoidentificación étnica',
        hierarchical: false,
      },
    });
    const ethnicityRow = async (
      code: string,
      display: string,
    ): Promise<string> =>
      (
        await prisma.catalogConcept.create({
          data: {
            systemId: ethnicities.id,
            code,
            display,
            validFrom: new Date('2020-01-01'),
          },
        })
      ).id;
    ethnicityId = await ethnicityRow('1', 'Indígena');
    mestizoEthnicityId = await ethnicityRow('6', 'Mestizo/a');
    /**
     * ⚠️ `NATIONALITY` ES LA NACIONALIDAD INDÍGENA —COLUMNA 13—, NO EL PAÍS.
     *
     * El instructivo del RDACAA activa esa columna sólo si la
     * autoidentificación étnica es «Indígena», y recoge Achuar, Awa, Kichwa,
     * Shuar… El país de un paciente extranjero es la COLUMNA 11, se llama
     * «Nacionalidad» en singular y tiene columna propia en la ficha (PA-053).
     * Sembrar aquí «Ecuatoriana» era exactamente la confusión contra la que
     * avisa la cabecera de `seed-rdacaa.mts`.
     *
     * El `6` es el código de Kichwa en el instructivo. La lista del INEC que
     * este catálogo tuvo sembrada hasta el 19-08-2026 lo ponía en el `14`, que
     * ahora es Andoa: un código que se lee bajo la lista equivocada es un dato
     * distinto, y por eso la fila de prueba lleva el del ministerio.
     */
    nationalityId = await flat(
      'NATIONALITY',
      'Nacionalidad indígena (RDACAA, columna 13)',
      {
        code: '6',
        display: 'Kichwa',
      },
    );
    /**
     * PA-053. El catálogo del que sale el NOMBRE del país guardado.
     *
     * La ficha guarda `VEN`; este catálogo es de donde la pantalla elige y de
     * dónde sale «Venezuela (República Bolivariana de)». Ninguna columna apunta
     * a esta fila: si lo hiciera, habría dos representaciones del país en la
     * misma base —ésta y `patient_identifier.issuing_country`—.
     */
    const countries = await prisma.catalogSystem.create({
      data: {
        code: 'COUNTRY',
        name: 'Países (ISO 3166-1)',
        hierarchical: false,
      },
    });
    await prisma.catalogConcept.createMany({
      data: [
        { code: 'VEN', display: 'Venezuela (República Bolivariana de)' },
        { code: 'ECU', display: 'Ecuador' },
      ].map((country) => ({
        systemId: countries.id,
        code: country.code,
        display: country.display,
        validFrom: new Date('2020-01-01'),
        attributes: { level: 0 },
      })),
    });
    genderIdentityId = await flat('GENDER_IDENTITY', 'Identidad de género', {
      code: 'FEMENINO',
      display: 'Femenino',
    });

    const dpa = await prisma.catalogSystem.create({
      data: {
        code: 'DPA',
        name: 'División Política Administrativa del INEC',
        hierarchical: true,
      },
    });
    /**
     * LOS TRES NIVELES, porque la ficha ya no devuelve sólo los códigos.
     *
     * «Provincia 17 · Cantón 1701» no le dice nada a quien está en el
     * mostrador, así que el nombre se resuelve del propio catálogo por el
     * código DERIVADO. Sin la provincia y el cantón sembrados no habría de
     * dónde sacarlo, que es exactamente el caso que la última prueba de esta
     * sección cubre.
     */
    const province = await prisma.catalogConcept.create({
      data: {
        systemId: dpa.id,
        code: '17',
        display: 'Pichincha',
        validFrom: new Date('2020-01-01'),
        attributes: { level: 0 },
      },
    });
    const canton = await prisma.catalogConcept.create({
      data: {
        systemId: dpa.id,
        code: '1701',
        display: 'Quito',
        parentId: province.id,
        validFrom: new Date('2020-01-01'),
        attributes: { level: 1 },
      },
    });
    const parish = await prisma.catalogConcept.create({
      data: {
        systemId: dpa.id,
        // Parroquia 50 del cantón 01 de la provincia 17: Quito, Chillogallo.
        code: '170150',
        display: 'Chillogallo',
        parentId: canton.id,
        validFrom: new Date('2020-01-01'),
        attributes: { level: 2 },
      },
    });
    parishId = parish.id;
  }

  // -------------------------------------------------------------------------
  // Atajos de transporte
  // -------------------------------------------------------------------------

  const register = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${recepcion}`)
      .send(body);

  const correct = (id: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(`/api/v1/patients/${id}`)
      .set('Authorization', `Bearer ${recepcion}`)
      .send(body);

  const addIdentifier = (id: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`/api/v1/patients/${id}/identifiers`)
      .set('Authorization', `Bearer ${recepcion}`)
      .send(body);

  const read = (id: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/patients/${id}`)
      .set('Authorization', `Bearer ${recepcion}`);

  /** Una ficha corriente, con lo mínimo que el alta exige. */
  async function registerPatient(
    overrides: Record<string, unknown> = {},
  ): Promise<PatientBody> {
    const response = await register({
      familyName: 'Guaman',
      givenName: 'Maria',
      sex: 'FEMALE',
      birthDate: '1990-03-15',
      ...overrides,
    }).expect(201);
    return response.body as PatientBody;
  }

  /** Hoy en Ecuador, que es contra lo que el servidor resuelve la edad. */
  function today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Guayaquil',
    }).format(new Date());
  }

  function daysFromToday(days: number): string {
    const [year, month, day] = today().split('-').map(Number) as [
      number,
      number,
      number,
    ];
    return new Date(Date.UTC(year, month - 1, day + days))
      .toISOString()
      .slice(0, 10);
  }

  // -------------------------------------------------------------------------
  // El fallecimiento no puede preceder al nacimiento (PA-008)
  // -------------------------------------------------------------------------

  it('PA-008 refuses a death date earlier than the birth date', async () => {
    const patient = await registerPatient();

    /**
     * POR SQL DIRECTO, que es donde está la garantía. Una importación del
     * registro anterior o un `UPDATE` por `psql` no pasan por el DTO, y un
     * año mal tecleado —2016 por 2026— produce una edad negativa en el reporte
     * al ministerio sin que nada falle.
     */
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE patient SET deceased_at = '1989-01-01 10:00:00-05'::timestamptz WHERE id = $1::uuid`,
        patient.id,
      ),
    ).rejects.toThrow(/patient_deceased_after_birth/);

    // Y por la ruta, que es lo que ve quien está en el mostrador: el nombre del
    // constraint viaja hasta un código estable y un mensaje accionable.
    const refused = await correct(patient.id, {
      deceasedAt: '1989-01-01',
    }).expect(422);
    expect((refused.body as Problem).code).toBe('INVALID_DECEASED_DATE');
    expect((refused.body as Problem).errors?.[0]?.field).toBe('deceasedAt');

    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: patient.id },
    });
    expect(row.deceasedAt).toBeNull();
  });

  it('PA-008 refuses a death date later than today, and names the field', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL MISMO ERROR DE TECLEO, EN LA OTRA DIRECCIÓN.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El CHECK de la migración se justifica con «un año mal tecleado —2016 por
     * 2026—», y el argumento es SIMÉTRICO: 2062 por 2026 se aceptaba sin más. Y
     * como la edad se resuelve contra la fecha de fallecimiento cuando la hay
     * (PA-030), la ficha y CADA FILA DEL LISTADO reportaban setenta y dos años
     * para una persona de treinta y seis, congelado para siempre.
     *
     * NO ES UN CHECK y no hay que buscarlo en la base: `now()` no es
     * `IMMUTABLE`, así que PostgreSQL rechaza el CHECK al crearlo. Sale como
     * error de validación por campo, igual que la cédula inválida.
     */
    const patient = await registerPatient();

    const refused = await correct(patient.id, {
      deceasedAt: daysFromToday(1),
    }).expect(422);
    expect((refused.body as Problem).code).toBe('VALIDATION_FAILED');
    expect((refused.body as Problem).errors?.[0]).toMatchObject({
      field: 'deceasedAt',
      message: 'La fecha de fallecimiento no puede ser posterior a hoy',
    });

    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: patient.id },
    });
    expect(row.deceasedAt).toBeNull();

    // Y EL LÍMITE EXACTO: hoy se acepta. Alguien que murió esta mañana se
    // registra esta mañana, y la fecha corre en `America/Guayaquil`.
    const accepted = await correct(patient.id, {
      deceasedAt: today(),
    }).expect(200);
    expect((accepted.body as PatientBody).deceasedAt).not.toBeNull();
  });

  it('PA-006 refuses a birth date later than today, at registration and when corrected', async () => {
    // Misma cota y el mismo motivo, en el otro campo de fecha: una fecha de
    // nacimiento futura da una edad negativa en el reporte al ministerio.
    const refused = await register({
      familyName: 'Guaman',
      givenName: 'Maria',
      sex: 'FEMALE',
      birthDate: daysFromToday(1),
    }).expect(422);
    expect((refused.body as Problem).errors?.[0]).toMatchObject({
      field: 'birthDate',
      message: 'La fecha de nacimiento no puede ser posterior a hoy',
    });
    expect(await prisma.patient.count()).toBe(0);

    // El límite exacto: un recién nacido de veinte minutos SÍ se registra.
    const newborn = await registerPatient({ birthDate: today() });
    expect(newborn.age).toEqual({ years: 0, months: null, days: 0 });

    await correct(newborn.id, { birthDate: daysFromToday(1) }).expect(422);
  });

  it('PA-008 accepts a death at 21:00 in Guayaquil on the very day of birth', async () => {
    /**
     * EL CASO QUE UN `::date` DESNUDO PIERDE.
     *
     * Un neonato que nace y muere el mismo día. A las 21:00 de Guayaquil ya es
     * el día siguiente en UTC, así que la comparación depende enteramente de en
     * qué huso se resuelve el instante. El `AT TIME ZONE 'America/Guayaquil'`
     * del CHECK es lo que hace que la respuesta sea la de Ecuador y no la de
     * quien tenga abierta la sesión.
     */
    const birthDate = '2025-08-16';
    const patient = await registerPatient({ birthDate });

    await prisma.$executeRawUnsafe(
      `UPDATE patient SET deceased_at = '2025-08-16 21:00:00-05'::timestamptz WHERE id = $1::uuid`,
      patient.id,
    );

    const [resolved] = await prisma.$queryRawUnsafe<
      { in_ecuador: Date; in_utc: Date }[]
    >(
      `SELECT (deceased_at AT TIME ZONE 'America/Guayaquil')::date AS in_ecuador,
              (deceased_at AT TIME ZONE 'UTC')::date            AS in_utc
       FROM patient WHERE id = $1::uuid`,
      patient.id,
    );

    // El instante cae en el día del nacimiento EN ECUADOR y en el siguiente en
    // UTC. Ésa es la diferencia que el CHECK tiene que resolver, y por eso la
    // fila se acepta.
    expect(resolved?.in_ecuador.toISOString().slice(0, 10)).toBe(birthDate);
    expect(resolved?.in_utc.toISOString().slice(0, 10)).toBe('2025-08-17');
  });

  it('PA-008 gives the same verdict with the session set to another time zone', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA PRUEBA DE QUE EL HUSO VA ESCRITO EN EL CHECK Y NO SE LEE DE LA SESIÓN.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `SET LOCAL TIME ZONE 'Asia/Tokyo'` —dentro de una transacción, que es lo
     * que garantiza que la sesión vuelva a su sitio aunque la sentencia falle y
     * que el `SET` y el `UPDATE` caigan en la MISMA conexión del pool—.
     *
     * Tokio va nueve horas por delante, así que un `::date` desnudo leería el
     * instante un día más tarde. La segunda mitad de esta prueba es
     * exactamente ese caso: un fallecimiento a las 20:00 de Guayaquil del día
     * ANTERIOR al nacimiento es ya el día del nacimiento en Tokio, y un
     * `::date` desnudo lo habría dejado pasar.
     *
     * FECHAS EN EL PASADO, y ahora es obligatorio: el alta rechaza una fecha de
     * nacimiento posterior a hoy (PA-006), así que un par de fechas fijas
     * alrededor del día en que se escribió la prueba dejaría de poder
     * registrarse. Lo que se comprueba aquí es la diferencia entre dos husos,
     * que no depende de qué día sea.
     */
    const born = await registerPatient({ birthDate: '2025-08-17' });
    const newborn = await registerPatient({ birthDate: '2025-08-16' });

    // Lo válido sigue siendo válido: 21:00 del día del nacimiento, en Ecuador.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Tokyo'`);
      await tx.$executeRawUnsafe(
        `UPDATE patient SET deceased_at = '2025-08-16 21:00:00-05'::timestamptz WHERE id = $1::uuid`,
        newborn.id,
      );
    });
    const stored = await prisma.patient.findUniqueOrThrow({
      where: { id: newborn.id },
    });
    expect(stored.deceasedAt?.toISOString()).toBe('2025-08-17T02:00:00.000Z');

    /**
     * Y ANTES, LA PRUEBA DE QUE ESE CASO DISCRIMINA DE VERDAD: con la sesión en
     * Tokio, un `::date` desnudo sobre ese mismo instante devuelve el DÍA DEL
     * NACIMIENTO y habría dejado pasar la fila. Resuelto en Guayaquil devuelve
     * el día anterior, que es lo que el CHECK rechaza abajo.
     */
    const [naive] = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Tokyo'`);
      return tx.$queryRawUnsafe<{ in_session: Date; in_ecuador: Date }[]>(
        `SELECT ('2025-08-16 20:00:00-05'::timestamptz)::date AS in_session,
                ('2025-08-16 20:00:00-05'::timestamptz AT TIME ZONE 'America/Guayaquil')::date AS in_ecuador`,
      );
    });
    expect(naive?.in_session.toISOString().slice(0, 10)).toBe('2025-08-17');
    expect(naive?.in_ecuador.toISOString().slice(0, 10)).toBe('2025-08-16');

    // Y lo inválido sigue siendo inválido, que es la mitad que el huso de la
    // sesión rompería.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Tokyo'`);
        await tx.$executeRawUnsafe(
          `UPDATE patient SET deceased_at = '2025-08-16 20:00:00-05'::timestamptz WHERE id = $1::uuid`,
          born.id,
        );
      }),
    ).rejects.toThrow(/patient_deceased_after_birth/);
  });

  // -------------------------------------------------------------------------
  // La madre (PA-009)
  // -------------------------------------------------------------------------

  it('PA-009 refuses a chart that is its own mother', async () => {
    const patient = await registerPatient();

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE patient SET mother_patient_id = id WHERE id = $1::uuid`,
        patient.id,
      ),
    ).rejects.toThrow(/patient_mother_not_self/);

    const refused = await correct(patient.id, {
      motherPatientId: patient.id,
    }).expect(422);
    expect((refused.body as Problem).code).toBe('INVALID_MOTHER_LINK');
    expect((refused.body as Problem).errors?.[0]?.field).toBe(
      'motherPatientId',
    );

    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: patient.id },
    });
    expect(row.motherPatientId).toBeNull();
  });

  it('PA-009 finds a newborn through its mother before it has a document of its own', async () => {
    const mother = await registerPatient({
      familyName: 'Chimbo',
      givenName: 'Rosa',
      identifier: { type: 'CEDULA', value: cedulaFor('171234567') },
    });
    const newborn = await registerPatient({
      familyName: 'Chimbo',
      givenName: 'Recién nacido',
      birthDate: daysFromToday(-1),
      motherPatientId: mother.id,
    });

    // SIN DOCUMENTO Y SIN NOMBRE PROPIO TODAVÍA: el vínculo es lo único que hay
    // que teclear, y por eso tiene que bastar para encontrarlo.
    expect(newborn.isProvisional).toBe(true);
    expect(newborn.primaryIdentifier).toBeNull();

    const filtered = await request(app.getHttpServer())
      .get('/api/v1/patients')
      .query({ motherId: mother.id })
      .set('Authorization', `Bearer ${recepcion}`)
      .expect(200);

    const page = filtered.body as { items: PatientBody[]; total: number };
    expect(page.items.map((item) => item.id)).toEqual([newborn.id]);
    expect(page.total).toBe(1);

    // El filtro es lo que hace el trabajo: sin él, las dos fichas están ahí.
    const everyone = await request(app.getHttpServer())
      .get('/api/v1/patients')
      .set('Authorization', `Bearer ${recepcion}`)
      .expect(200);
    expect((everyone.body as { total: number }).total).toBe(2);
  });

  it('PA-009 refuses to link a newborn to a mother chart absorbed by a merge', async () => {
    /**
     * UNA FICHA FUSIONADA EXISTE —no se borra nunca, los documentos impresos
     * siguen citando su MRN— así que preguntar sólo «¿existe?» la acepta. El
     * vínculo quedaría escrito y con aspecto de comprobado, y el recién nacido
     * NO aparecería en `GET /patients?motherId=<superviviente>`, que es lo
     * único que hace útil el vínculo antes de que tenga documento propio.
     *
     * Hoy no hay ruta que fusione (es P4), así que la fusión se provoca por SQL
     * — que es además el camino por el que llegará una importación.
     */
    const survivor = await registerPatient({
      familyName: 'Chimbo',
      givenName: 'Rosa',
    });
    const absorbed = await registerPatient({
      familyName: 'Chimbo',
      givenName: 'Rosa María',
    });
    // `merged_at` junto al enlace: `patient_merged_at_matches_link` los exige
    // juntos, para que deshacer esté completo o no ocurra (PA-047).
    await prisma.$executeRawUnsafe(
      `UPDATE patient SET merged_into_id = $2::uuid, merged_at = now() WHERE id = $1::uuid`,
      absorbed.id,
      survivor.id,
    );

    const refused = await register({
      familyName: 'Chimbo',
      givenName: 'Recién nacido',
      sex: 'FEMALE',
      birthDate: daysFromToday(-1),
      motherPatientId: absorbed.id,
    }).expect(404);
    expect((refused.body as Problem).code).toBe('PATIENT_NOT_FOUND');
    expect((refused.body as Problem).errors?.[0]?.field).toBe(
      'motherPatientId',
    );

    // Y tampoco por corrección, que es la otra puerta al mismo campo.
    const newborn = await registerPatient({ givenName: 'Recién nacida' });
    await correct(newborn.id, { motherPatientId: absorbed.id }).expect(404);

    // La ficha superviviente sigue sirviendo: lo que se rechaza es la absorbida.
    await correct(newborn.id, { motherPatientId: survivor.id }).expect(200);
  });

  // -------------------------------------------------------------------------
  // El documento que aparece después (PA-015)
  // -------------------------------------------------------------------------

  it('PA-015 adds the document later without creating a second chart', async () => {
    const provisional = await registerPatient();
    expect(provisional.isProvisional).toBe(true);
    expect(provisional.rdacaaMissingFields).toContain('identifier');

    const cedula = cedulaFor('171234567');
    const updated = await addIdentifier(provisional.id, {
      type: 'CEDULA',
      value: cedula,
    }).expect(200);

    const body = updated.body as PatientBody;
    // (a) NO se creó una segunda ficha. Es la razón de ser de esta ruta: sin
    // ella, la única forma de que el recién nacido tuviera su cédula era
    // registrarlo otra vez.
    expect(await prisma.patient.count()).toBe(1);
    // (b) deja de ser provisional, (c) el número de historia es el mismo.
    expect(body.isProvisional).toBe(false);
    expect(body.mrn).toBe(provisional.mrn);
    expect(body.rdacaaMissingFields).not.toContain('identifier');

    // (d) el documento queda donde se consulta el registro.
    const stored = await prisma.patientIdentifier.findMany({
      where: { patientId: provisional.id },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.value).toBe(cedula);
    expect(stored[0]?.validTo).toBeNull();

    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: provisional.id },
    });
    expect(row.isProvisional).toBe(false);
    expect(row.mrn).toBe(provisional.mrn);
  });

  it('PA-015 PA-032 does NOT end the provisional state with a PROVISIONAL marker', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * UN MARCADOR PROVISIONAL NO ES UN DOCUMENTO, Y LO DICE LA BASE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `patient_identifier_active_unique` EXCLUYE `type = 'PROVISIONAL'` de la
     * unicidad: un marcador no reserva ningún documento porque no identifica a
     * nadie. El vocabulario del SPEC dice lo mismo con palabras — «provisional»
     * es una ficha SIN DOCUMENTO DEFINITIVO.
     *
     * Contarlo como documento declaraba la ficha completa para el RDACAA sin
     * ningún documento de identidad, y devolvía el `SN-001` como
     * `primaryIdentifier` — el número que una recepcionista copiaría a una
     * factura.
     */
    const provisional = await registerPatient();

    const marked = await addIdentifier(provisional.id, {
      type: 'PROVISIONAL',
      value: 'SN-001',
    }).expect(200);

    const body = marked.body as PatientBody;
    expect(body.isProvisional).toBe(true);
    expect(body.rdacaaMissingFields).toContain('identifier');
    expect(body.primaryIdentifier).toBeNull();
    // El marcador SÍ se guarda: es un dato real de la ficha, y es lo que la
    // carpeta lleva escrito mientras nadie sepa quién es el paciente.
    expect(body.identifiers).toEqual([
      { type: 'PROVISIONAL', issuingCountry: 'ECU', value: 'SN-001' },
    ]);

    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: provisional.id },
    });
    expect(row.isProvisional).toBe(true);

    /**
     * Y LA CÉDULA QUE LLEGA DESPUÉS SÍ LO TERMINA, con el marcador todavía
     * puesto: es el orden real —primero la carpeta, luego el documento— y el
     * que hacía que `take: 1` sobre los activos devolviera el marcador.
     */
    const cedula = cedulaFor('171234567');
    const documented = (
      await addIdentifier(provisional.id, {
        type: 'CEDULA',
        value: cedula,
      }).expect(200)
    ).body as PatientBody;

    expect(documented.isProvisional).toBe(false);
    expect(documented.rdacaaMissingFields).not.toContain('identifier');
    expect(documented.primaryIdentifier?.value).toBe(cedula);
  });

  it('PA-015 PA-032 registers with a PROVISIONAL marker and stays provisional', async () => {
    // El mismo defecto en el ALTA: `isProvisional: !patient.identifier` hacía
    // que dar de alta con un marcador produjera una ficha que dice NO ser
    // provisional sin tener ningún documento.
    const created = await registerPatient({
      identifier: { type: 'PROVISIONAL', value: 'SN-002' },
    });

    expect(created.isProvisional).toBe(true);
    expect(created.rdacaaMissingFields).toContain('identifier');
    expect(created.primaryIdentifier).toBeNull();

    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.isProvisional).toBe(true);

    // Y EN EL LISTADO, que es donde admisión trabaja y donde la consulta lleva
    // `take: 1`: la fila tiene que decir lo mismo que la ficha.
    const page = await request(app.getHttpServer())
      .get('/api/v1/patients')
      .set('Authorization', `Bearer ${recepcion}`)
      .expect(200);
    const listed = (page.body as { items: PatientBody[] }).items[0];
    expect(listed?.primaryIdentifier).toBeNull();
    expect(listed?.rdacaaMissingFields).toContain('identifier');
  });

  it('PA-015 refuses a document another active chart already holds, and writes nothing', async () => {
    const cedula = cedulaFor('171234567');
    await registerPatient({
      familyName: 'Ñaupa',
      identifier: { type: 'CEDULA', value: cedula },
    });
    const provisional = await registerPatient({ givenName: 'Ana' });

    const refused = await addIdentifier(provisional.id, {
      type: 'CEDULA',
      value: cedula,
    }).expect(409);
    expect((refused.body as Problem).code).toBe('PATIENT_IDENTIFIER_TAKEN');

    // NADA ESCRITO: la ficha sigue provisional y el documento sigue teniendo un
    // solo dueño. Una ruta que dejara la fila a medias es la que produce dos
    // fichas activas con la misma cédula.
    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: provisional.id },
    });
    expect(row.isProvisional).toBe(true);
    expect(
      await prisma.patientIdentifier.count({
        where: { patientId: provisional.id },
      }),
    ).toBe(0);
    expect(await prisma.patientIdentifier.count({ where: { value: cedula } })).toBe(1); // prettier-ignore
  });

  // -------------------------------------------------------------------------
  // Los datos que exige el RDACAA (PA-026 a PA-029)
  // -------------------------------------------------------------------------

  it('PA-026 PA-027 PA-029 give back the chosen concept with the wording it was registered with', async () => {
    const created = await registerPatient({
      ethnicityConceptId: ethnicityId,
      nationalityConceptId: nationalityId,
      genderIdentityConceptId: genderIdentityId,
      residenceParishConceptId: parishId,
    });

    // La ficha guarda una REFERENCIA, no el texto: es lo que permite que una
    // ficha de hace tres años siga resolviendo la etnia con la que se registró
    // cuando el INEC reescriba la categoría.
    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.ethnicityConceptId).toBe(ethnicityId);
    expect(row.nationalityConceptId).toBe(nationalityId);
    expect(row.genderIdentityConceptId).toBe(genderIdentityId);
    expect(row.residenceParishConceptId).toBe(parishId);

    const reread = (await read(created.id).expect(200)).body as PatientBody;
    expect(reread.ethnicity).toEqual({
      id: ethnicityId,
      code: '1',
      display: 'Indígena',
    });
    expect(reread.nationality?.display).toBe('Kichwa');
    // PA-029: la identidad de género es un dato DISTINTO del sexo, y ninguno se
    // derivó del otro — la ficha se registró como `FEMALE` y el concepto viajó
    // aparte.
    expect(reread.genderIdentity?.code).toBe('FEMENINO');
    expect(row.sex).toBe('FEMALE');
  });

  it('PA-028 derives the province and the canton from the six-digit code, which are not columns', async () => {
    const created = await registerPatient({
      residenceParishConceptId: parishId,
    });

    const parish = ((await read(created.id).expect(200)).body as PatientBody)
      .residenceParish;
    expect(parish?.code).toBe('170150');
    expect(parish?.provinceCode).toBe('17');
    expect(parish?.cantonCode).toBe('1701');

    /**
     * Y NO EXISTEN COMO COLUMNA, comprobado contra el catálogo de la base y no
     * de memoria. Dos filas del archivo del INEC declaran un cantón que su
     * propio código desmiente: almacenarlo reportaría a esos pacientes en el
     * cantón equivocado sin que nada fallara. Si alguien añadiera la columna,
     * esta consulta lo delataría.
     */
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'patient'
    `;
    const names = columns.map((column) => column.column_name);
    expect(names).toContain('residence_parish_concept_id');
    expect(
      names.filter(
        (name) => name.includes('province') || name.includes('canton'),
      ),
    ).toEqual([]);
  });

  it('PA-028 gives back the NAMES of the province and the canton, not just the numbers', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * «Provincia 17 · Cantón 1701» NO LE DICE NADA A NADIE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El código es lo que se reporta al ministerio; el nombre es lo que lee
     * quien tiene al paciente delante. Devolviendo sólo el número, la pantalla
     * no puede hacer otra cosa que pintarlo tal cual.
     *
     * SIGUE SIENDO DERIVAR, y por eso PA-028 no cambia: no se almacena nada, y
     * lo que se le pregunta al catálogo es «cómo se llama 1701», nunca «a qué
     * cantón pertenece esta parroquia». La columna descriptiva del archivo del
     * INEC —la que en dos filas contradice al propio código— no se lee.
     */
    const created = await registerPatient({
      residenceParishConceptId: parishId,
    });

    const parish = ((await read(created.id).expect(200)).body as PatientBody)
      .residenceParish;

    expect(parish).toMatchObject({
      code: '170150',
      display: 'Chillogallo',
      provinceCode: '17',
      provinceDisplay: 'Pichincha',
      cantonCode: '1701',
      cantonDisplay: 'Quito',
    });
  });

  it('PA-028 keeps the codes when the catalogue cannot name them', async () => {
    /**
     * Una parroquia de una edición vieja cuyo cantón ya no está en el catálogo.
     * El nombre viaja `null` y el CÓDIGO SIGUE VIAJANDO: un nombre que falta es
     * una pantalla peor, un código que falta es un registro peor. Y la ficha no
     * revienta por eso — mismo criterio que `CatalogsService.byId`, que tampoco
     * comprueba vigencia para poner nombre a lo ya guardado.
     */
    const dpa = await prisma.catalogSystem.findUniqueOrThrow({
      where: { code: 'DPA' },
    });
    // Una parroquia cuyo cantón `9901` y cuya provincia `99` no están en el
    // catálogo. NO se borran los conceptos que sí están: `ON DELETE RESTRICT`
    // lo impediría, y en un sistema clínico un catálogo no se borra, se retira.
    const orphan = await prisma.catalogConcept.create({
      data: {
        systemId: dpa.id,
        code: '990101',
        display: 'Parroquia de una edición anterior',
        validFrom: new Date('2020-01-01'),
        attributes: { level: 2 },
      },
    });

    const created = await registerPatient({
      residenceParishConceptId: orphan.id,
    });

    const parish = ((await read(created.id).expect(200)).body as PatientBody)
      .residenceParish;

    expect(parish).toMatchObject({
      code: '990101',
      provinceCode: '99',
      provinceDisplay: null,
      cantonCode: '9901',
      cantonDisplay: null,
    });
  });

  it('PA-026 refuses a concept id that belongs to another catalogue system', async () => {
    // Una parroquia del DPA enviada como etnia. EXISTE, y aceptarla pondría una
    // fila del DPA en la autoidentificación étnica del reporte mensual.
    const refused = await register({
      familyName: 'Guaman',
      givenName: 'Maria',
      sex: 'FEMALE',
      birthDate: '1990-03-15',
      ethnicityConceptId: parishId,
    }).expect(404);

    expect((refused.body as Problem).code).toBe('CATALOG_CONCEPT_NOT_FOUND');
    expect((refused.body as Problem).errors?.[0]?.field).toBe(
      'ethnicityConceptId',
    );
    // Y no queda media ficha: la referencia se resuelve antes de escribir nada.
    expect(await prisma.patient.count()).toBe(0);
  });

  it('PA-027 refuses a nationality on a chart that does not identify as indigenous', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL CONTRATO: 422, `code` estable y el campo señalado.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * No es un `CATALOG_CONCEPT_*`: el concepto existe, es de `NATIONALITY` y
     * está vigente. Lo que no encaja es con el OTRO campo de la ficha, y lo que
     * hay que hacer es distinto —cambiar la etnia o vaciar la nacionalidad—,
     * así que el código es propio y el mensaje dice las dos salidas.
     */
    const refused = await register({
      familyName: 'Guaman',
      givenName: 'Maria',
      sex: 'FEMALE',
      birthDate: '1990-03-15',
      ethnicityConceptId: mestizoEthnicityId,
      nationalityConceptId: nationalityId,
    }).expect(422);

    const problem = refused.body as Problem;
    expect(problem.code).toBe('NATIONALITY_REQUIRES_INDIGENOUS_ETHNICITY');
    expect(problem.errors?.[0]).toMatchObject({
      field: 'nationalityConceptId',
      code: 'NATIONALITY_REQUIRES_INDIGENOUS_ETHNICITY',
    });
    // Y el texto no nombra ningún dato del paciente: ni la etnia enviada, ni el
    // pueblo, ni el nombre. Un mensaje de error acaba en una captura de soporte.
    expect(problem.errors?.[0]?.message).not.toMatch(/Kichwa|Mestizo|Guaman/i);

    // No queda media ficha: se decide antes de escribir nada.
    expect(await prisma.patient.count()).toBe(0);
  });

  it('PA-027 refuses to change the ethnicity of a chart that ALREADY had a nationality, and writes nothing', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL CASO QUE SÓLO SE VE CONTRA LA BASE: LA CONTRADICCIÓN NO VIENE EN EL
     * CUERPO, ESTÁ GUARDADA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * La corrección trae SÓLO la etnia. La nacionalidad ya está en la fila, así
     * que la ficha resultante diría «Mestizo/a» y Kichwa a la vez — la misma
     * contradicción de la prueba anterior, alcanzada en dos peticiones en vez
     * de una. Cuenta el estado resultante, y por eso esto se decide con la fila
     * delante y no con el DTO.
     *
     * Y NO SE BORRA LA NACIONALIDAD EN SILENCIO: eso sería pérdida de un dato
     * que declaró el paciente, disfrazada de actualización y con una fila de
     * histórico que nadie pidió. La salida es vaciarla en la misma petición.
     */
    const patient = await registerPatient({
      ethnicityConceptId: ethnicityId,
      nationalityConceptId: nationalityId,
    });

    const refused = await correct(patient.id, {
      ethnicityConceptId: mestizoEthnicityId,
    }).expect(422);
    expect((refused.body as Problem).code).toBe(
      'NATIONALITY_REQUIRES_INDIGENOUS_ETHNICITY',
    );
    expect((refused.body as Problem).errors?.[0]?.field).toBe(
      'nationalityConceptId',
    );

    // LA FICHA SIGUE COMO ESTABA, y no a medias: ni etnia nueva ni nacionalidad
    // borrada.
    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: patient.id },
    });
    expect(row.ethnicityConceptId).toBe(ethnicityId);
    expect(row.nationalityConceptId).toBe(nationalityId);

    // Y NINGUNA DE LAS DOS FILAS DE PA-031: una corrección rechazada no cambió
    // nada, así que no hay ni histórico ni entrada `UPDATE` en la bitácora.
    expect(
      await prisma.patientChangeHistory.count({
        where: { patientId: patient.id },
      }),
    ).toBe(0);
    expect(
      await prisma.accessAudit.count({
        where: { resourceId: patient.id, action: 'UPDATE' },
      }),
    ).toBe(0);
  });

  it('PA-027 lets the same correction through when the nationality is cleared with it', async () => {
    // La salida del rechazo de arriba, en UN SOLO `PATCH`: quien deja de
    // autoidentificarse como indígena deja de tener ese campo, y las dos filas
    // de histórico dicen desde qué valor (PA-031).
    const patient = await registerPatient({
      ethnicityConceptId: ethnicityId,
      nationalityConceptId: nationalityId,
    });

    const corrected = await correct(patient.id, {
      ethnicityConceptId: mestizoEthnicityId,
      nationalityConceptId: null,
    }).expect(200);

    const body = corrected.body as PatientBody;
    expect(body.ethnicity?.display).toBe('Mestizo/a');
    expect(body.nationality).toBeNull();

    const history = await prisma.patientChangeHistory.findMany({
      where: { patientId: patient.id },
      orderBy: { field: 'asc' },
    });
    expect(history.map((row) => row.field)).toEqual([
      'ethnicityConceptId',
      'nationalityConceptId',
    ]);
    expect(history[1]?.valueBefore).toBe(nationalityId);
    expect(history[1]?.valueAfter).toBeNull();
  });

  // -------------------------------------------------------------------------
  // De qué país es el paciente (PA-053)
  // -------------------------------------------------------------------------

  it('PA-053 records the country of nationality alongside the RDACAA nationality, and they are two data', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA MITAD QUE FALTABA: UNA FICHA NO PODÍA DECIR QUE ALGUIEN ES VENEZOLANO.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `nationality_concept_id` apunta a `NATIONALITY`, que en el RDACAA es la
     * NACIONALIDAD O PUEBLO INDÍGENA —Kichwa, Shuar, Awa— y sólo se activa si
     * la autoidentificación étnica es «Indígena». El país es otro dato, y en
     * Ecuador es una parte grande de la demanda diaria (D-036 opción C).
     *
     * Esta prueba guarda LOS DOS a la vez sobre la misma ficha, que es la única
     * forma de demostrar que no se pisan. La etnia viaja porque la nacionalidad
     * no existe sin ella (PA-027).
     *
     * ⚠️ Y EL PAÍS ES `ECU`, CORREGIDO EL 19-08-2026 (PA-059). Este párrafo
     * decía «alguien indígena puede ser venezolano, que es justo lo que las dos
     * columnas permiten decir», y la ficha se registraba con `VEN` + etnia. Es
     * falso, y lo dice el propio instructivo del ministerio: la columna 12
     * *«aplica para nacionalidad Ecuatoriana»* y la 11 manda dejar en blanco de
     * la 12 a la 14 *«si el usuario NO es ecuatoriano»*. Lo que la prueba
     * demuestra no cambia —son dos columnas y no se pisan—; lo que cambia es
     * que la combinación elegida ahora es una que el RDACAA admite. Que el país
     * extranjero se guarda igual de bien lo comprueba la segunda mitad, sobre
     * una ficha sin etnia, que es exactamente la ficha que el ministerio espera.
     */
    const created = await registerPatient({
      ethnicityConceptId: ethnicityId,
      nationalityConceptId: nationalityId,
      countryOfNationalityCode: 'ECU',
    });

    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.nationalityConceptId).toBe(nationalityId);
    // EL CÓDIGO, no un uuid: es lo mismo que guarda `issuing_country`, y por
    // eso las dos columnas se pueden cruzar.
    expect(row.countryOfNationalityCode).toBe('ECU');

    const reread = (await read(created.id).expect(200)).body as PatientBody;
    expect(reread.nationality?.display).toBe('Kichwa');
    expect(reread.countryOfNationality).toEqual({
      code: 'ECU',
      display: 'Ecuador',
    });

    // Y el país extranjero, en la ficha donde el RDACAA lo espera: sin etnia y
    // sin nacionalidad indígena (PA-059).
    const foreign = await registerPatient({
      familyName: 'Piedra',
      countryOfNationalityCode: 'VEN',
    });
    expect(foreign.countryOfNationality).toEqual({
      code: 'VEN',
      display: 'Venezuela (República Bolivariana de)',
    });
  });

  it('PA-053 refuses by SQL a country that is not three upper-case letters', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * POR SQL DIRECTO, QUE ES DONDE ESTÁ LA GARANTÍA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Una importación del registro anterior, una migración de datos o un
     * `UPDATE` por `psql` no pasan por el DTO. Sin el `CHECK`, un `ec` o un
     * `Ecu` producirían un país que ningún catálogo puede nombrar y que no
     * cruza con `patient_identifier.issuing_country`. Mismo argumento que el
     * dígito verificador de la cédula.
     *
     * LOS DOS EXTREMOS LOS CIERRAN DOS COSAS DISTINTAS, y por eso el `expect`
     * de `ECUADOR` es otro: la columna es `CHAR(3)` —como `issuing_country`—
     * así que un nombre entero ni siquiera cabe y lo rechaza el TIPO. Lo que
     * cabe y no vale —`ec `, `Ecu`, `EC1`— lo rechaza el `CHECK`.
     */
    const patient = await registerPatient();

    const set = (value: string) =>
      prisma.$executeRawUnsafe(
        `UPDATE patient SET country_of_nationality_code = $2 WHERE id = $1::uuid`,
        patient.id,
        value,
      );

    for (const invalid of ['ec', 'ecu', 'Ecu', 'EC1', 'E C']) {
      await expect(set(invalid), invalid).rejects.toThrow(
        /patient_country_of_nationality_format/,
      );
    }

    // El nombre entero no cabe en la columna: lo detiene el tipo, antes que el
    // CHECK, y el resultado para quien importa es el mismo — la fila no entra.
    await expect(set('ECUADOR')).rejects.toThrow(/too long/i);

    // Y lo válido sí entra, que es la mitad sin la cual el CHECK podría estar
    // rechazándolo todo.
    await expect(set('ECU')).resolves.toBe(1);

    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: patient.id },
    });
    expect(row.countryOfNationalityCode).toBe('ECU');
  });

  it('PA-053 refuses an alpha-3 that no country in the catalogue has, naming the field', async () => {
    /**
     * `XXX` tiene tres letras mayúsculas: pasa el DTO y pasa el `CHECK`. Que
     * exista no lo puede decir ninguno de los dos —un `CHECK` no consulta otra
     * tabla—, así que lo decide el servicio contra `COUNTRY`, con el mismo
     * camino por el que ya resuelve la etnia y la parroquia y sin importar de
     * `catalogs`: ningún módulo importa de otro.
     */
    const refused = await register({
      familyName: 'Guaman',
      givenName: 'Maria',
      sex: 'FEMALE',
      birthDate: '1990-03-15',
      countryOfNationalityCode: 'XXX',
    }).expect(404);

    expect((refused.body as Problem).code).toBe('CATALOG_CONCEPT_NOT_FOUND');
    expect((refused.body as Problem).errors?.[0]?.field).toBe(
      'countryOfNationalityCode',
    );
    // Y no queda media ficha: el país se resuelve antes de escribir nada.
    expect(await prisma.patient.count()).toBe(0);
  });

  it('PA-061 corrects the employer and the job title with their trail, and the chart serves them', async () => {
    const patient = await registerPatient();
    // El alta no los pide: la ficha nace sin ellos.
    expect(
      (await read(patient.id).expect(200)).body as Record<string, unknown>,
    ).toMatchObject({ employerName: null, jobTitle: null });

    const corrected = await correct(patient.id, {
      employerName: '  Florícola del Valle  ',
      jobTitle: 'Supervisora de cultivo',
    }).expect(200);
    expect(corrected.body as Record<string, unknown>).toMatchObject({
      employerName: 'Florícola del Valle',
      jobTitle: 'Supervisora de cultivo',
    });

    const history = await prisma.patientChangeHistory.findMany({
      where: { patientId: patient.id, field: { in: ['employerName', 'jobTitle'] } },
      orderBy: { field: 'asc' },
      select: { field: true, valueBefore: true, valueAfter: true, changedById: true },
    }); // prettier-ignore
    expect(history).toEqual([
      { field: 'employerName', valueBefore: null, valueAfter: 'Florícola del Valle', changedById: recepcionUserId }, // prettier-ignore
      { field: 'jobTitle', valueBefore: null, valueAfter: 'Supervisora de cultivo', changedById: recepcionUserId }, // prettier-ignore
    ]);

    // Las columnas existen con su ancho: 160 y 120.
    const columns = await prisma.$queryRaw<
      { column_name: string; character_maximum_length: number }[]
    >`
      SELECT column_name::text AS column_name, character_maximum_length::int AS character_maximum_length
        FROM information_schema.columns
       WHERE table_name = 'patient' AND column_name IN ('employer_name', 'job_title')
       ORDER BY column_name
    `;
    expect(columns).toEqual([
      { column_name: 'employer_name', character_maximum_length: 160 },
      { column_name: 'job_title', character_maximum_length: 120 },
    ]);
  });

  it('PA-061 the database CHECK admits the two new fields in the trail and still refuses an unknown one', async () => {
    const patient = await registerPatient();
    const insert = (field: string) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO patient_change_history (patient_id, field, value_before, value_after, changed_by)
         VALUES ($1::uuid, $2, NULL, 'Valor', $3::uuid)`,
        patient.id,
        field,
        recepcionUserId,
      );

    // Control positivo: los dos campos nuevos pasan por el mismo CHECK.
    await expect(insert('employerName')).resolves.toBe(1);
    await expect(insert('jobTitle')).resolves.toBe(1);
    await expect(insert('employer')).rejects.toThrow(
      /patient_change_history_field_known/,
    );
  });

  it('PA-053 leaves the previous country in the chart history when it is corrected', async () => {
    /**
     * Una nacionalidad mal tecleada en el mostrador es un dato que el paciente
     * puede hacer rectificar (REQ-113), y rectificar sin rastro es reescribir
     * el pasado. La fila va a `patient_change_history` —rectificable— y no a
     * `access_audit`, que es append-only y no se purga nunca (D-032).
     */
    const patient = await registerPatient({ countryOfNationalityCode: 'VEN' });

    const corrected = await correct(patient.id, {
      countryOfNationalityCode: 'ecu',
    }).expect(200);

    // Se normaliza a mayúsculas en el DTO: `ecu` es identificable y rechazarlo
    // sería un 422 que no enseña nada. La columna guarda `ECU`.
    expect((corrected.body as PatientBody).countryOfNationality?.code).toBe(
      'ECU',
    );

    const history = await prisma.patientChangeHistory.findMany({
      where: { patientId: patient.id, field: 'countryOfNationalityCode' },
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.valueBefore).toBe('VEN');
    expect(history[0]?.valueAfter).toBe('ECU');
    expect(history[0]?.changedById).toBe(recepcionUserId);

    /**
     * Y EL CAMPO ESTÁ EN LA LISTA BLANCA DE LA BASE, que es lo que la fila de
     * arriba demuestra sólo de paso: `patient_change_history_field_known` se
     * rehízo en esta migración para admitirlo. Sin eso, corregir el país
     * habría tumbado la transacción entera con un CHECK ilegible.
     */
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO patient_change_history (patient_id, field, value_before, value_after, changed_by)
         VALUES ($1::uuid, 'countryOfNationality', 'VEN', 'ECU', $2::uuid)`,
        patient.id,
        recepcionUserId,
      ),
    ).rejects.toThrow(/patient_change_history_field_known/);
  });

  it('PA-053 gives back the code when the catalogue cannot name the country', async () => {
    // Una edición anterior del catálogo, o un país que se dividió. El nombre
    // viaja `null` y el CÓDIGO SIGUE VIAJANDO — un nombre que falta es una
    // pantalla peor, un código que falta es un registro peor. Y la ficha no
    // revienta por eso, igual que con la provincia de PA-028.
    const patient = await registerPatient();
    await prisma.$executeRawUnsafe(
      `UPDATE patient SET country_of_nationality_code = 'SUN' WHERE id = $1::uuid`,
      patient.id,
    );

    const reread = (await read(patient.id).expect(200)).body as PatientBody;
    expect(reread.countryOfNationality).toEqual({ code: 'SUN', display: null });
  });

  it('PA-053 PA-032 does NOT count the country as a datum the RDACAA is missing', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * REQ-022 NO PIDE EL PAÍS, ASÍ QUE NO PUEDE MARCAR UNA FICHA INCOMPLETA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El reporte exige documento, sexo, autoidentificación étnica, nacionalidad
     * —la indígena—, edad y residencia. Marcar una ficha como incompleta por un
     * dato que el ministerio no pide convierte el indicador en ruido que
     * admisión aprende a ignorar, y un indicador que nadie lee es peor que
     * ninguno porque sigue pareciendo un control.
     */
    const completa = await registerPatient({
      ethnicityConceptId: ethnicityId,
      nationalityConceptId: nationalityId,
      residenceParishConceptId: parishId,
      identifier: { type: 'CEDULA', value: cedulaFor('171234567') },
    });

    // SIN PAÍS y aun así completa para el RDACAA.
    expect(completa.countryOfNationality).toBeNull();
    expect(completa.rdacaaMissingFields).toEqual([]);

    /**
     * Y ponerlo tampoco cambia el indicador en ninguna dirección.
     *
     * ⚠️ CON `ECU` Y NO CON `VEN`, corregido el 19-08-2026: la ficha ya declara
     * etnia, y PA-059 rechaza esa combinación porque el ministerio manda dejar
     * las columnas 12 a 14 en blanco cuando el usuario no es ecuatoriano. Lo
     * que esta prueba afirma —que el país no entra en el indicador— es
     * independiente de cuál sea; lo que el país extranjero SÍ cambia está en
     * `patient-rdacaa-instructivo.spec.ts` (PA-059), y es que la etnia y la
     * nacionalidad dejan de contar.
     */
    const conPais = await correct(completa.id, {
      countryOfNationalityCode: 'ECU',
    }).expect(200);
    expect((conPais.body as PatientBody).rdacaaMissingFields).toEqual([]);
  });

  it('PA-053 PA-021 keeps the country OUT of the listing row', async () => {
    // El listado se dispara con cada letra tecleada, y ponerle nombre al país
    // cuesta una consulta al catálogo por ficha. Lo que sí viaja allí es la
    // edad y qué falta.
    await registerPatient({ countryOfNationalityCode: 'VEN' });

    const page = await request(app.getHttpServer())
      .get('/api/v1/patients')
      .set('Authorization', `Bearer ${recepcion}`)
      .expect(200);

    const listed = (page.body as { items: Record<string, unknown>[] }).items[0];
    expect(listed).toBeDefined();
    expect(listed?.countryOfNationality).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // El rastro de una corrección (PA-031)
  // -------------------------------------------------------------------------

  it('PA-031 leaves two rows for one correction: the field history and an audit entry with no payload', async () => {
    const patient = await registerPatient({ familyName: 'Guaman' });

    const before = new Date();
    await correct(patient.id, { familyName: 'Guamán' }).expect(200);

    // 1. EL HISTÓRICO, con el valor anterior campo a campo.
    const history = await prisma.patientChangeHistory.findMany({
      where: { patientId: patient.id },
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.field).toBe('familyName');
    expect(history[0]?.valueBefore).toBe('Guaman');
    expect(history[0]?.valueAfter).toBe('Guamán');
    expect(history[0]?.changedById).toBe(recepcionUserId);
    expect(history[0]?.changedAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );

    /**
     * 2. LA BITÁCORA, con quién y cuándo y NADA MÁS.
     *
     * `before`/`after` a NULL es la mitad de la garantía: la lista blanca de
     * `access_audit_payload_only_for_declared_resources` no incluye
     * `'patient'`, y como registrar no lanza, una fila con carga útil se habría
     * perdido en silencio — la ficha corregida y sin rastro de acceso.
     */
    const trail = await prisma.accessAudit.findMany({
      where: { resourceType: 'patient', resourceId: patient.id, action: 'UPDATE' }, // prettier-ignore
    });
    expect(trail).toHaveLength(1);
    expect(trail[0]?.userId).toBe(recepcionUserId);
    expect(trail[0]?.before).toBeNull();
    expect(trail[0]?.after).toBeNull();

    // Y el apellido cambió de verdad, que es lo que las dos filas describen.
    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: patient.id },
    });
    expect(row.familyName).toBe('Guamán');
  });

  it('PA-031 keeps the audit whitelist without patient, so a payload row is refused by the database', async () => {
    // Escrito por SQL a propósito: lo que se pregunta es si la BASE lo rechaza,
    // no si nuestro código se abstiene de intentarlo. El día que alguien amplíe
    // la lista blanca «para reutilizar before/after», esta prueba lo dirá.
    const patient = await registerPatient();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO access_audit (resource_type, resource_id, action, "before")
         VALUES ('patient', $1, 'UPDATE', $2::jsonb)`,
        patient.id,
        JSON.stringify({ familyName: 'el apellido anterior' }),
      ),
    ).rejects.toThrow(/access_audit_payload_only_for_declared_resources/);
  });

  it('PA-031 leaves neither the chart changed nor a history row when the correction fails', async () => {
    /**
     * ATOMICIDAD, provocada con algo que RECHAZA LA BASE y no un doble: un
     * apellido válido y una fecha de fallecimiento anterior al nacimiento en el
     * MISMO `PATCH`. La actualización y el histórico viajan en una sola
     * transacción, así que o se escriben las dos cosas o ninguna.
     */
    const patient = await registerPatient({ familyName: 'Guaman' });

    const refused = await correct(patient.id, {
      familyName: 'Guamán',
      deceasedAt: '1980-01-01',
    }).expect(422);
    expect((refused.body as Problem).code).toBe('INVALID_DECEASED_DATE');

    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: patient.id },
    });
    expect(row.familyName).toBe('Guaman');
    expect(row.deceasedAt).toBeNull();
    expect(
      await prisma.patientChangeHistory.count({
        where: { patientId: patient.id },
      }),
    ).toBe(0);
    // Tampoco hay fila de bitácora de una mutación que no ocurrió.
    expect(
      await prisma.accessAudit.count({
        where: { resourceId: patient.id, action: 'UPDATE' },
      }),
    ).toBe(0);
  });

  it('PA-031 writes no history row when a field is re-sent with the value it already had', async () => {
    const patient = await registerPatient({ familyName: 'Guaman' });

    await correct(patient.id, { familyName: 'Guaman' }).expect(200);

    // Una fila que enseña el mismo valor a los dos lados no es un rastro: es
    // ruido que hace más difícil encontrar el cambio que se busca. Y el CHECK
    // `patient_change_history_value_changed` la rechazaría de todos modos.
    expect(
      await prisma.patientChangeHistory.count({
        where: { patientId: patient.id },
      }),
    ).toBe(0);

    /**
     * NI FILA DE BITÁCORA, que es la mitad que faltaba.
     *
     * `access_audit` es append-only y NO SE PURGA NUNCA. Un `UPDATE` por una
     * corrección que no cambió nada es una afirmación permanente de que la
     * ficha se modificó, sin ninguna fila de histórico que pueda decir qué —
     * exactamente el rastro que no se puede contrastar con nada.
     */
    expect(
      await prisma.accessAudit.count({
        where: { resourceId: patient.id, action: 'UPDATE' },
      }),
    ).toBe(0);
  });

  it('PA-031 chains the history of two simultaneous corrections of the same field', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * DOS MOSTRADORES, Y EL RASTRO TIENE QUE DECIR QUIÉN GANÓ.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Con la instantánea leída FUERA de la transacción y en READ COMMITTED, A
     * escribe `Guaman → Guamán` y B —que leyó antes del commit de A— escribe
     * `Guaman → Gúaman`. Quedan DOS filas afirmando que el valor anterior era
     * `Guaman`, y la cadena real de cambios ya no se puede reconstruir.
     * `patient_change_history_value_changed` no lo detecta: los dos valores
     * difieren. Es exactamente la garantía que PA-031 vende.
     *
     * ESTA PRUEBA AFIRMA QUIÉN GANA, no que «al menos una falle»: las dos deben
     * tener éxito, y el `value_before` de la segunda tiene que ser el
     * `value_after` de la primera.
     *
     * EL BLOQUEO EXTERNO ES LO QUE LA HACE DETERMINISTA. Una transacción aparte
     * toma `FOR UPDATE` sobre la fila y la retiene: las dos correcciones llegan
     * a leer su estado —un `SELECT` corriente no se bloquea— y ninguna puede
     * escribir. Al soltar, se serializan. Sin la corrección, las dos ya habían
     * planificado desde el valor original.
     */
    const patient = await registerPatient({ familyName: 'Guaman' });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const held = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT id FROM patient WHERE id = $1::uuid FOR UPDATE`,
          patient.id,
        );
        await gate;
      },
      { timeout: 20_000 },
    );

    const first = correct(patient.id, { familyName: 'Guamán' }).then((r) => r);
    const second = correct(patient.id, { familyName: 'Gúaman' }).then((r) => r);

    // Tiempo suficiente para que las dos hayan leído el estado y estén
    // esperando el bloqueo. Es la ventana en la que ocurría el defecto.
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    await held;

    const responses = await Promise.all([first, second]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);

    const history = await prisma.patientChangeHistory.findMany({
      where: { patientId: patient.id, field: 'familyName' },
    });
    expect(history).toHaveLength(2);

    // NUNCA DOS FILAS AFIRMANDO EL MISMO VALOR ANTERIOR.
    expect(new Set(history.map((row) => row.valueBefore)).size).toBe(2);

    // Y ENCADENADAS: la primera parte del valor original, la segunda del que la
    // primera dejó, y la ficha se queda con el de la segunda.
    const opener = history.find((row) => row.valueBefore === 'Guaman');
    const closer = history.find((row) => row.valueBefore !== 'Guaman');
    expect(opener).toBeDefined();
    expect(closer?.valueBefore).toBe(opener?.valueAfter);

    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: patient.id },
    });
    expect(row.familyName).toBe(closer?.valueAfter);
  });

  it('PA-031 refuses a correction whose chart was merged away while it waited', async () => {
    /**
     * LA COMPROBACIÓN DE FICHA FUSIONADA, DENTRO DE LA TRANSACCIÓN.
     *
     * El servicio la hace antes para fallar pronto y con buen mensaje, pero esa
     * lectura ocurre fuera: si la fusión se confirma entre ella y la escritura,
     * la corrección aterriza sobre la ficha ABSORBIDA y `PatientMergedError` no
     * se lanza nunca.
     *
     * La fusión se hace DENTRO de la transacción que retiene el bloqueo, que es
     * la única forma de colocarla en esa ventana: cualquier `UPDATE` de fuera
     * quedaría esperando el mismo bloqueo.
     */
    const survivor = await registerPatient({ familyName: 'Chimbo' });
    const absorbed = await registerPatient({ familyName: 'Guaman' });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const held = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT id FROM patient WHERE id = $1::uuid FOR UPDATE`,
          absorbed.id,
        );
        await gate;
        await tx.$executeRawUnsafe(
          `UPDATE patient SET merged_into_id = $2::uuid, merged_at = now() WHERE id = $1::uuid`,
          absorbed.id,
          survivor.id,
        );
      },
      { timeout: 20_000 },
    );

    const pending = correct(absorbed.id, { familyName: 'Guamán' }).then(
      (r) => r,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    await held;

    const response = await pending;
    expect(response.status).toBe(409);
    expect((response.body as Problem).code).toBe('PATIENT_MERGED');

    // Y NADA ESCRITO sobre la ficha absorbida: ni el apellido ni el histórico.
    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: absorbed.id },
    });
    expect(row.familyName).toBe('Guaman');
    expect(
      await prisma.patientChangeHistory.count({
        where: { patientId: absorbed.id },
      }),
    ).toBe(0);
  });

  it('PA-031 refuses by SQL a history row that shows the same value on both sides', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL ATAQUE POR SQL DIRECTO, QUE ES DONDE ESTÁ LA GARANTÍA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `patient_change_history_value_changed` sólo se comprobaba a través del
     * servicio, y un servicio que se abstiene de intentarlo no demuestra que la
     * base lo impida. Una importación, una migración de datos o un `INSERT` por
     * `psql` no pasan por aquí. Un `EXCLUDE` sin prueba es una intención, y un
     * `CHECK` sin prueba es lo mismo.
     *
     * `IS DISTINCT FROM` y no `<>`: con los dos lados a NULL, `NULL <> NULL` es
     * NULL y un CHECK acepta NULL. Por eso el caso de los dos nulos va aquí.
     */
    const patient = await registerPatient();

    const insert = (before: string | null, after: string | null) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO patient_change_history (patient_id, field, value_before, value_after, changed_by)
         VALUES ($1::uuid, 'familyName', $2, $3, $4::uuid)`,
        patient.id,
        before,
        after,
        recepcionUserId,
      );

    await expect(insert('Guaman', 'Guaman')).rejects.toThrow(
      /patient_change_history_value_changed/,
    );
    await expect(insert(null, null)).rejects.toThrow(
      /patient_change_history_value_changed/,
    );
    // Y lo que sí es un cambio entra, incluido vaciar un campo.
    await expect(insert('Guaman', null)).resolves.toBe(1);
  });

  it('PA-031 refuses by SQL a history row for a field the chart cannot correct', async () => {
    /**
     * `patient_change_history_field_known` se comprobaba leyendo el ARCHIVO de
     * la migración: eso demuestra que las dos listas coinciden, no que la
     * restricción esté aplicada en la base que corre. Esto sí.
     *
     * `mrn` es el caso que importa (PA-002): es el ancla de identidad, y una
     * fila diciendo que cambió sería el rastro de algo que el sistema no
     * permite.
     */
    const patient = await registerPatient();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO patient_change_history (patient_id, field, value_before, value_after, changed_by)
         VALUES ($1::uuid, 'mrn', 'HC0000000801', 'HC0000000999', $2::uuid)`,
        patient.id,
        recepcionUserId,
      ),
    ).rejects.toThrow(/patient_change_history_field_known/);

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO patient_change_history (patient_id, field, value_before, value_after, changed_by)
         VALUES ($1::uuid, 'isProvisional', 'true', 'false', $2::uuid)`,
        patient.id,
        recepcionUserId,
      ),
    ).rejects.toThrow(/patient_change_history_field_known/);
  });

  it('PA-031 keeps whoever corrected a chart in the trail when their account is removed', async () => {
    /**
     * LAS DOS CLAVES FORÁNEAS SON `ON DELETE RESTRICT`, y su argumento escrito
     * es «quien corrigió una ficha no desaparece del rastro». Sin prueba, ese
     * argumento es una nota en un comentario: `CASCADE` habría borrado el
     * histórico entero al desactivar mal una cuenta, y nadie lo habría notado
     * hasta que hiciera falta el rastro.
     *
     * Las cuentas se DESACTIVAN, no se borran (AU-024); esto es lo que lo hace
     * cierto también aquí.
     */
    const patient = await registerPatient({ familyName: 'Guaman' });
    await correct(patient.id, { familyName: 'Guamán' }).expect(200);

    /**
     * UNA CUENTA RECIÉN CREADA Y SIN NADA MÁS COLGANDO, a propósito: la de
     * recepción tiene concesiones de rol y sesiones, y su borrado chocaría
     * primero con `user_role_grant_user_id_fkey` — que probaría otra cosa.
     * Ésta sólo aparece en el histórico.
     */
    const author = await prisma.user.create({
      data: {
        email: 'auxiliar@clinica.ec',
        firstName: 'Luis',
        lastName: 'Andrade',
        cedula: cedulaFor('171003406'),
        passwordHash: 'no se usa: esta cuenta nunca inicia sesión',
      },
    });
    await prisma.patientChangeHistory.create({
      data: {
        patientId: patient.id,
        field: 'phone',
        valueBefore: null,
        valueAfter: '0991234567',
        changedById: author.id,
      },
    });

    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM app_user WHERE id = $1::uuid`,
        author.id,
      ),
    ).rejects.toThrow(/patient_change_history_changed_by_fkey/);

    // Y la ficha tampoco se borra por debajo del rastro que la describe.
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM patient WHERE id = $1::uuid`,
        patient.id,
      ),
    ).rejects.toThrow(/patient_change_history_patient_id_fkey/);

    expect(
      await prisma.patientChangeHistory.count({
        where: { patientId: patient.id },
      }),
    ).toBe(2);
  });

  it('PA-002 keeps the number of the chart when the chart is corrected', async () => {
    const patient = await registerPatient({ familyName: 'Guaman' });

    const corrected = await correct(patient.id, {
      familyName: 'Guamán',
      birthDate: '1990-03-16',
    }).expect(200);

    expect((corrected.body as PatientBody).mrn).toBe(patient.mrn);
    const row = await prisma.patient.findUniqueOrThrow({
      where: { id: patient.id },
    });
    expect(row.mrn).toBe(patient.mrn);
    // Y el MRN no está entre lo que el histórico puede nombrar: no es un dato
    // de la ficha, es el ancla de identidad.
    const history = await prisma.patientChangeHistory.findMany({
      where: { patientId: patient.id },
    });
    expect(history.map((change) => change.field).sort()).toEqual([
      'birthDate',
      'familyName',
    ]);
  });

  it('PA-031 lets a history row be corrected and deleted, unlike the access trail', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA ASIMETRÍA ES DELIBERADA, Y ESTA PRUEBA ES LO QUE IMPIDE «ARREGLARLA».
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `patient_change_history` es la única tabla de rastro del sistema que NO
     * lleva disparador de inmutabilidad, porque guarda CONTENIDO DE LA FICHA y
     * el derecho de rectificación obliga a poder corregirlo y eliminarlo.
     * `access_audit` guarda quién miró y por eso es append-only. Quien añada
     * aquí un disparador de inmutabilidad estará convirtiendo el histórico en
     * algo que no se puede rectificar jamás.
     */
    const patient = await registerPatient({ familyName: 'Guaman' });
    await correct(patient.id, { familyName: 'Guamán' }).expect(200);

    const change = await prisma.patientChangeHistory.findFirstOrThrow({
      where: { patientId: patient.id },
    });

    const minimised = await prisma.patientChangeHistory.update({
      where: { id: change.id },
      data: { valueBefore: null },
    });
    expect(minimised.valueBefore).toBeNull();

    await prisma.patientChangeHistory.delete({ where: { id: change.id } });
    expect(
      await prisma.patientChangeHistory.count({
        where: { patientId: patient.id },
      }),
    ).toBe(0);

    // Y la bitácora de la MISMA corrección no admite ninguna de las dos cosas.
    const entry = await prisma.accessAudit.findFirstOrThrow({
      where: { resourceId: patient.id, action: 'UPDATE' },
    });
    await expect(
      prisma.accessAudit.update({
        where: { id: entry.id },
        data: { action: 'READ' },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.accessAudit.delete({ where: { id: entry.id } }),
    ).rejects.toThrow(/append-only/);
  });

  // -------------------------------------------------------------------------
  // La ficha incompleta existe igualmente (PA-032)
  // -------------------------------------------------------------------------

  it('PA-032 creates the chart without the RDACAA data and names what is missing', async () => {
    // A las tres de la mañana con un neonato delante, bloquear el alta por un
    // selector de etnia vacío es exactamente lo que no se puede hacer.
    const created = await registerPatient();

    expect([...created.rdacaaMissingFields].sort()).toEqual([
      'ethnicityConceptId',
      'identifier',
      'nationalityConceptId',
      'residenceParishConceptId',
    ]);

    const completed = await correct(created.id, {
      ethnicityConceptId: ethnicityId,
      nationalityConceptId: nationalityId,
      residenceParishConceptId: parishId,
    }).expect(200);
    // La identidad de género NO cuenta para el indicador y por eso no hace
    // falta enviarla: el reporte no la pide.
    expect((completed.body as PatientBody).rdacaaMissingFields).toEqual([
      'identifier',
    ]);

    const withDocument = await addIdentifier(created.id, {
      type: 'CEDULA',
      value: cedulaFor('171234567'),
    }).expect(200);
    expect((withDocument.body as PatientBody).rdacaaMissingFields).toEqual([]);
  });

  it('PA-032 does NOT name the nationality on a chart that is not «Indígena», and does on one that is', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * UN INDICADOR QUE NADIE PUEDE DEJAR EN CERO ES UN INDICADOR QUE SE IGNORA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Desde que PA-027 hace cumplir el formulario del ministerio, la
     * nacionalidad o pueblo indígena sólo se puede rellenar si la
     * autoidentificación étnica es «Indígena». Contarla en toda ficha dejaba a
     * la de un paciente mestizo —la mayoría— marcada como incompleta para
     * siempre por una casilla que el propio sistema le prohíbe cerrar. D-037,
     * opción A, 17-08-2026.
     *
     * SOBRE LA RESPUESTA HTTP y no sólo en unitario, porque el código de la
     * etnia no está en la ficha: sale del catálogo, y lo que se comprueba aquí
     * es que el repositorio lo resuelve —también en el listado— y no sólo que
     * el dominio sabría decidir con él.
     */
    const mestizo = await registerPatient({
      ethnicityConceptId: mestizoEthnicityId,
      residenceParishConceptId: parishId,
      identifier: { type: 'CEDULA', value: cedulaFor('171234567') },
    });
    expect(mestizo.nationality).toBeNull();
    expect(mestizo.rdacaaMissingFields).not.toContain('nationalityConceptId');
    expect(mestizo.rdacaaMissingFields).toEqual([]);

    // Y LA MISMA FICHA EN EL LISTADO, que es la consulta que se dispara con
    // cada letra tecleada (PA-021) y la que resuelve el código por unión.
    const page = await request(app.getHttpServer())
      .get('/api/v1/patients')
      .set('Authorization', `Bearer ${recepcion}`)
      .expect(200);
    const listed = (page.body as { items: PatientBody[] }).items.find(
      (item) => item.id === mestizo.id,
    );
    expect(listed?.rdacaaMissingFields).toEqual([]);

    // LA FICHA INDÍGENA SÍ LA ECHA EN FALTA: es la única a la que el reporte
    // se la pide, y sacarla del indicador la habría dejado sin aviso ninguno.
    const indigena = await registerPatient({
      familyName: 'Cuji',
      ethnicityConceptId: ethnicityId,
      residenceParishConceptId: parishId,
      identifier: { type: 'CEDULA', value: cedulaFor('171234568') },
    });
    expect(indigena.rdacaaMissingFields).toEqual(['nationalityConceptId']);

    const completada = await correct(indigena.id, {
      nationalityConceptId: nationalityId,
    }).expect(200);
    expect((completada.body as PatientBody).rdacaaMissingFields).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // La edad, ya derivada, en la respuesta (PA-030)
  // -------------------------------------------------------------------------

  it('PA-030 carries the age in the response, resolved on the Ecuadorian clinical date', async () => {
    /**
     * SOBRE LA RESPUESTA HTTP, que es lo que la unitaria no puede: la edad no
     * es una columna, así que lo único que demuestra que viaja es leerla de la
     * ficha que devuelve el servidor. La garantía del huso ya está probada en
     * unitario y no se duplica aquí; lo que se comprueba es la coherencia con
     * la fecha clínica de Ecuador.
     */
    const newborn = await registerPatient({ birthDate: daysFromToday(-3) });
    expect(newborn.age).toEqual({ years: 0, months: null, days: 3 });

    const [year, month, day] = today().split('-').map(Number) as [
      number,
      number,
      number,
    ];
    const adult = await registerPatient({
      birthDate: new Date(Date.UTC(year - 30, month - 1, day))
        .toISOString()
        .slice(0, 10),
    });
    // `days` sólo viene relleno para menores de 29 días: un número de días para
    // un adulto sería ruido que alguien acabaría pintando.
    expect(adult.age).toEqual({ years: 30, months: null, days: null });

    // Y sigue ahí al releer la ficha, no sólo en la respuesta del alta.
    const reread = (await read(newborn.id).expect(200)).body as PatientBody;
    expect(reread.age.days).toBe(3);
  });

  it('PA-030 carries the age of an infant in months, on the chart and on the listing', async () => {
    /**
     * D-035 (a). SIN ESTO LA FICHA DECÍA «MENOS DE 1 AÑO» DE UN LACTANTE.
     *
     * Es cierto y no sirve para dosificar: las tablas pediátricas van por
     * meses. Se comprueba sobre la respuesta HTTP porque el cálculo unitario ya
     * está probado y lo que aquí puede fallar es otra cosa —que el campo no
     * viaje, o que viaje sólo en la ficha y no en el listado, que es donde
     * admisión trabaja—.
     */
    const infant = await registerPatient({
      familyName: 'Chimbo',
      givenName: 'Killa',
      /**
       * 220 DÍAS SON SIETE MESES CUMPLIDOS CUALQUIER DÍA DEL AÑO, y por eso se
       * cuenta así en vez de restar siete al número del mes: «el mismo día de
       * hace siete meses» no existe si hoy es 31 de enero, y la prueba fallaría
       * un día concreto al año. Siete meses consecutivos nunca pasan de 215
       * días y ocho nunca bajan de 242, así que 220 sólo puede ser siete.
       */
      birthDate: daysFromToday(-220),
    });

    expect(infant.age).toEqual({ years: 0, months: 7, days: null });

    const page = await request(app.getHttpServer())
      .get('/api/v1/patients')
      .set('Authorization', `Bearer ${recepcion}`)
      .expect(200);
    const listed = (page.body as { items: PatientBody[] }).items.find(
      (item) => item.id === infant.id,
    );
    expect(listed?.age).toEqual({ years: 0, months: 7, days: null });
  });
});
