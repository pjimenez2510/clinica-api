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
import { DuplicateIdentifierError } from '../../src/modules/patients/domain/patient.errors';
import { PrismaPatientRepository } from '../../src/modules/patients/infrastructure/prisma-patient.repository';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * El registro que ya existía, contra PostgreSQL 18 de verdad (P1).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ PRUEBA ESTO QUE NINGUNA UNITARIA PUEDE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. **La secuencia del número de historia** (PA-001). Que el número salga de
 *     `patient_mrn_seq` y no de `max(mrn)+1` sólo se ve moviendo la secuencia
 *     por debajo del código, o poniendo dos altas a la vez: la versión rota
 *     —leer el máximo y sumar uno— pasa cualquier prueba secuencial.
 *  2. **El índice único PARCIAL** (PA-013, PA-014). La comprobación previa del
 *     servicio es cortesía: bajo concurrencia las dos altas leen «libre». Quien
 *     impide de verdad las dos fichas es `patient_identifier_active_unique`, y
 *     un doble que devuelve lo que se le pide no demuestra que exista.
 *  3. **El `CHECK` del dígito verificador** (PA-011, PA-012). Se ataca por SQL
 *     directo además de por la ruta: una importación, una migración de datos o
 *     un `INSERT` por `psql` no pasan por el DTO.
 *  4. **Las tres garantías que consisten en que algo NO ocurra** (PA-023,
 *     PA-024, PA-025): filas de bitácora que no se escriben y datos que no
 *     salen. Se cuentan filas; una pantalla no puede enseñar lo que no se
 *     escribió.
 */
const PASSWORD = 'el caballo come alfalfa';
const RECEPCION_EMAIL = 'admision.registro@clinica.ec';

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: { field: string; code: string; message: string }[];
}

interface PatientBody {
  id: string;
  mrn: string;
  familyName: string;
  secondFamilyName: string | null;
  givenName: string;
  secondGivenName: string | null;
  sex: string;
  birthDate: string;
  birthDateEstimated: boolean;
  isProvisional: boolean;
  identifiers: { type: string; issuingCountry: string; value: string }[];
}

/**
 * Una cédula sintética con el dígito verificador CALCULADO, nunca copiado.
 *
 * Los nueve primeros dígitos se eligen para el caso que se quiere probar
 * —provincia, tercer dígito— y el décimo sale del módulo 10, que es lo que
 * `is_valid_cedula` recalcula en la base. Copiar el número de una persona real
 * está prohibido, y componerlo a ojo produce un rechazo por el motivo
 * equivocado: la prueba pasaría con la regla que dice probar ya rota.
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

/** El formato que PA-001 exige: `HC` y diez dígitos, ni uno más. */
const MRN_FORMAT = /^HC\d{10}$/;

/**
 * El navegador desde el que se abre la ficha, para PA-022.
 *
 * Un valor RECONOCIBLE y no el que supertest pone por defecto: lo que se
 * comprueba es que el «desde dónde» llega hasta la fila, y una cadena genérica
 * dejaría pasar una columna rellenada por cualquier otra vía.
 */
const USER_AGENT = 'ClinicaTest/1.0 (mostrador de admision)';

describe('el registro de pacientes, contra la base', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  /** `RECEPCION`: `patient:read` + `patient:write`, que es quien admite. */
  let recepcion: string;
  /** Y quién es, para poder afirmar el «quién» de PA-022 sobre la fila. */
  let recepcionUserId: string;

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
    // El caché de rol→permiso se indexa por id y el truncado recrea los roles
    // con ids nuevos: sin esto cada petición responde 403.
    registry.invalidate();

    recepcion = await signIn(RECEPCION_EMAIL, 'RECEPCION');
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

  // -------------------------------------------------------------------------
  // Atajos de transporte
  // -------------------------------------------------------------------------

  const register = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${recepcion}`)
      .send(body);

  const read = (id: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/patients/${id}`)
      .set('Authorization', `Bearer ${recepcion}`)
      // PA-022 exige «desde dónde», y el navegador es la mitad que viaja en una
      // cabecera. Se manda SIEMPRE, no sólo en la prueba que lo afirma: así la
      // fila que las demás escriben es la misma que la producción escribe.
      .set('User-Agent', USER_AGENT);

  const search = (query: Record<string, string>) =>
    request(app.getHttpServer())
      .get('/api/v1/patients')
      .query(query)
      .set('Authorization', `Bearer ${recepcion}`);

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

  /**
   * Cuántas filas de bitácora hay ahora mismo sobre fichas de pacientes.
   *
   * SE CUENTA Y SE RESTA, no se vacía la tabla antes: `access_audit` es
   * append-only —un disparador rechaza `DELETE` y `TRUNCATE`, y hay prueba de
   * ello—, así que la línea base es lo que ya había. Es además cómo se mide en
   * producción: nadie borra el rastro para saber si creció.
   */
  async function auditRows(): Promise<number> {
    return prisma.accessAudit.count({ where: { resourceType: 'patient' } });
  }

  // =========================================================================
  // PA-001 — el número de historia sale de una secuencia
  // =========================================================================

  it('PA-001 emite el número de historia desde la secuencia, con HC y diez dígitos', async () => {
    const primera = await registerPatient();
    const segunda = await registerPatient({ familyName: 'Cedeno' });

    expect(primera.mrn).toMatch(MRN_FORMAT);
    expect(segunda.mrn).toMatch(MRN_FORMAT);

    /**
     * SE COMPARA CON LA SECUENCIA, no con `HC0000000001`.
     *
     * `patient_mrn_seq` no pertenece a ninguna columna, así que el
     * `TRUNCATE … RESTART IDENTITY` que aísla cada prueba no la reinicia — y no
     * debe: un número reutilizado apuntaría a dos historias en documentos ya
     * impresos, mientras que un hueco es visible y auditable. Una aserción
     * sobre el valor absoluto sólo pasaría siendo el primer archivo del
     * recorrido, que es una prueba que depende del orden.
     */
    const [{ last_value }] = await prisma.$queryRaw<[{ last_value: bigint }]>`
      SELECT last_value FROM patient_mrn_seq
    `;
    expect(segunda.mrn).toBe(`HC${String(last_value).padStart(10, '0')}`);
    expect(Number(segunda.mrn.slice(2))).toBe(Number(primera.mrn.slice(2)) + 1);
  });

  it('PA-001 toma el número de la SECUENCIA y no del máximo de la tabla', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA ALTERNATIVA OBVIA —LEER EL MÁXIMO Y SUMAR UNO— PASA CUALQUIER PRUEBA
     * SECUENCIAL, Y ESTA ES LA QUE NO.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Se mueve la secuencia por debajo del código sin tocar ninguna ficha. Si
     * el número saliera de `max(mrn)+1`, la siguiente alta seguiría siendo la
     * 2 y esta aserción caería; sólo `nextval` puede dar la 501. Es la misma
     * lectura que hace real el hueco al revertir una transacción: un hueco es
     * visible y auditable, un número reutilizado apunta a dos historias en
     * documentos ya impresos.
     */
    await registerPatient();
    await prisma.$executeRaw`SELECT setval('patient_mrn_seq', 500)`;

    const siguiente = await registerPatient({ familyName: 'Cedeno' });

    expect(siguiente.mrn).toBe('HC0000000501');
  });

  it('PA-001 con dos altas simultáneas emite dos números distintos', async () => {
    /**
     * Dos recepcionistas registrando en el mismo instante. La versión rota de
     * esto —leer el máximo y sumar uno— entrega el MISMO número a las dos, el
     * índice único rechaza a una, y lo que se ve en el mostrador es un error
     * incomprensible con un paciente delante.
     *
     * SE AFIRMA QUIÉN GANA: aquí ganan las dos, porque son dos personas
     * distintas y ninguna regla las enfrenta. Lo que no puede ocurrir es que
     * compartan número.
     */
    const [una, otra] = await Promise.all([
      register({
        familyName: 'Guaman',
        givenName: 'Maria',
        sex: 'FEMALE',
        birthDate: '1990-03-15',
      }),
      register({
        familyName: 'Cedeno',
        givenName: 'Jose',
        sex: 'MALE',
        birthDate: '1985-07-02',
      }),
    ]);

    expect([una.status, otra.status]).toEqual([201, 201]);

    const mrns = [una.body, otra.body].map((b) => (b as PatientBody).mrn);
    expect(mrns[0]).toMatch(MRN_FORMAT);
    expect(mrns[1]).toMatch(MRN_FORMAT);
    expect(new Set(mrns).size).toBe(2);

    // Y no hay dos fichas compartiendo número en toda la tabla.
    const total = await prisma.patient.count();
    const distintos = await prisma.patient.findMany({
      select: { mrn: true },
      distinct: ['mrn'],
    });
    expect(distintos).toHaveLength(total);
  });

  // =========================================================================
  // PA-003, PA-004, PA-005, PA-007 — lo que la ficha guarda
  // =========================================================================

  it('PA-003 registra sin ningún documento, con historia y marcada provisional', async () => {
    // Un recién nacido de veinte minutos y un politraumatizado inconsciente
    // necesitan ficha antes de que nadie tenga papeles suyos. Registrar sin
    // documento es lo NORMAL, no la excepción.
    const ficha = await registerPatient();

    expect(ficha.mrn).toMatch(MRN_FORMAT);
    expect(ficha.isProvisional).toBe(true);
    expect(ficha.identifiers).toEqual([]);

    const fila = await prisma.patient.findUniqueOrThrow({
      where: { id: ficha.id },
      select: { isProvisional: true, mrn: true, _count: { select: { identifiers: true } } }, // prettier-ignore
    });
    expect(fila.isProvisional).toBe(true);
    expect(fila._count.identifiers).toBe(0);
  });

  it('PA-004 guarda las cuatro partes del nombre por separado', async () => {
    const ficha = await registerPatient({
      familyName: 'Velez',
      secondFamilyName: 'Andrade',
      givenName: 'Maria',
      secondGivenName: 'del Carmen',
    });

    const fila = await prisma.patient.findUniqueOrThrow({
      where: { id: ficha.id },
      select: {
        familyName: true,
        secondFamilyName: true,
        givenName: true,
        secondGivenName: true,
      },
    });

    expect(fila).toEqual({
      familyName: 'Velez',
      secondFamilyName: 'Andrade',
      givenName: 'Maria',
      secondGivenName: 'del Carmen',
    });
  });

  it('PA-004 no ofrece en ninguna capa un campo único de nombre completo', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA AUSENCIA SE AFIRMA DONDE ES PERMANENTE: EN LA TABLA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Con un `full_name` no se puede ordenar el listado como se archiva a la
     * gente en Ecuador ni componer la fila del RDACAA, y separarlo después
     * obliga a adivinar dónde acaba el apellido de «María del Carmen Vélez
     * Andrade». `search_name` NO cuenta: es una columna GENERADA a partir de
     * las cuatro, no un campo que nadie pueda rellenar.
     */
    const columnas = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'patient'
         AND column_name IN ('full_name', 'fullname', 'name', 'display_name')
    `;
    expect(columnas).toEqual([]);

    const ficha = await registerPatient();
    expect(ficha).not.toHaveProperty('fullName');
    expect(ficha).not.toHaveProperty('name');
  });

  it('PA-005 devuelve el sexo tal como se documentó, sin colapsar INTERSEX ni UNKNOWN', async () => {
    /**
     * El formulario del ministerio sólo admite H/M, y ESA REDUCCIÓN ES DE LA
     * CAPA DE EXPORTACIÓN. Colapsar al guardar hace que la ficha mienta sobre
     * lo que se documentó, y ya no hay forma de volver atrás.
     */
    for (const sex of ['MALE', 'FEMALE', 'INTERSEX', 'UNKNOWN'] as const) {
      const ficha = await registerPatient({ familyName: `Caso${sex}`, sex });
      expect(ficha.sex, sex).toBe(sex);

      const fila = await prisma.patient.findUniqueOrThrow({
        where: { id: ficha.id },
        select: { sex: true },
      });
      expect(fila.sex, sex).toBe(sex);

      // Y vuelve igual al abrirla, que es donde una reducción al exportar se
      // habría colado sin que el alta lo notara.
      const abierta = await read(ficha.id).expect(200);
      expect((abierta.body as PatientBody).sex, sex).toBe(sex);
    }
  });

  it('PA-007 devuelve la fecha de nacimiento como fecha de calendario, no como instante', async () => {
    /**
     * Serializada como instante se desplaza un día según quién la lea, y el
     * paciente sale un día más joven en el reporte que en su ficha. Todo
     * Ecuador está al oeste de Greenwich, así que el fallo no es ocasional:
     * es sistemático.
     */
    const ficha = await registerPatient({ birthDate: '1990-03-15' });

    expect(ficha.birthDate).toBe('1990-03-15');
    expect(ficha.birthDate).not.toContain('T');

    const abierta = (await read(ficha.id).expect(200)).body as PatientBody;
    expect(abierta.birthDate).toBe('1990-03-15');

    const listado = (await search({ q: 'Guaman' }).expect(200)).body as {
      items: PatientBody[];
    };
    expect(listado.items.map((p) => p.birthDate)).toEqual(['1990-03-15']);

    // Y la columna es `date`: un `timestamptz` es lo que permitiría que algún
    // día viajara una hora dentro.
    const [{ data_type }] = await prisma.$queryRaw<[{ data_type: string }]>`
      SELECT data_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'patient'
         AND column_name = 'birth_date'
    `;
    expect(data_type).toBe('date');
  });

  // =========================================================================
  // PA-010 a PA-013 — los documentos y su unicidad
  // =========================================================================

  it('PA-010 identifica el documento por la TERNA, no por el valor suelto', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * DOS PASAPORTES DE PAÍSES DISTINTOS PUEDEN COMPARTIR NÚMERO.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Con la identidad puesta sólo en el valor, el registro fusionaría a dos
     * personas — y la primera vez que alguien lo nota es cuando una historia
     * clínica lleva las alergias de otra.
     */
    const numero = 'AB123456';

    const colombiano = await registerPatient({
      familyName: 'Restrepo',
      identifier: { type: 'PASSPORT', issuingCountry: 'COL', value: numero },
    });
    const peruano = await registerPatient({
      familyName: 'Quispe',
      identifier: { type: 'PASSPORT', issuingCountry: 'PER', value: numero },
    });

    expect(colombiano.id).not.toBe(peruano.id);

    // Y la terna COMPLETA sí es única: repetirla entera se rechaza.
    const repetido = await register({
      familyName: 'Otro',
      givenName: 'Nombre',
      sex: 'MALE',
      birthDate: '1980-01-01',
      identifier: { type: 'PASSPORT', issuingCountry: 'COL', value: numero },
    }).expect(409);
    expect((repetido.body as Problem).code).toBe('PATIENT_IDENTIFIER_TAKEN');
  });

  it('PA-010 admite cero, uno y varios documentos sobre la misma ficha', async () => {
    // Un refugiado llega con carné y obtiene la cédula dos años después: los
    // dos son parte de quién es, y ninguno sustituye al otro.
    const ficha = await registerPatient();
    expect(ficha.identifiers).toEqual([]);

    const addIdentifier = (body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post(`/api/v1/patients/${ficha.id}/identifiers`)
        .set('Authorization', `Bearer ${recepcion}`)
        .send(body);

    await addIdentifier({
      type: 'REFUGEE_CARD',
      issuingCountry: 'ECU',
      value: 'REF-000123',
    }).expect(200);
    const conDos = (
      await addIdentifier({
        type: 'CEDULA',
        issuingCountry: 'ECU',
        value: cedulaFor('171234567'),
      }).expect(200)
    ).body as PatientBody;

    expect(
      conDos.identifiers.map((i) => i.type).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['CEDULA', 'REFUGEE_CARD']);
  });

  it('PA-011 el CHECK de la base rechaza una cédula inválida insertada por SQL', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * SE ATACA POR SQL DIRECTO, QUE ES LO QUE EL DTO NO PUEDE DEFENDER.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `patient_identifier_cedula_valid` existe porque una importación, una
     * migración de datos o un `INSERT` por `psql` no pasan por la capa de
     * transporte. La misma regla en el DTO es la que le dice al mostrador qué
     * dígito está mal mientras la persona sigue delante; son dos garantías
     * distintas y las dos se prueban.
     */
    const ficha = await registerPatient();

    const insertar = (value: string) =>
      prisma.$executeRaw`
        INSERT INTO patient_identifier (patient_id, type, issuing_country, value)
        VALUES (${ficha.id}::uuid, 'CEDULA', 'ECU', ${value})
      `;

    // Dígito verificador que no corresponde: el mismo número con el último
    // dígito cambiado, que es lo que parece plausible en pantalla.
    const buena = cedulaFor('171234567');
    const malDigito = `${buena.slice(0, 9)}${(Number(buena[9]) + 1) % 10}`;
    await expect(insertar(malDigito)).rejects.toThrow(
      /patient_identifier_cedula_valid/,
    );

    // Provincia inexistente, con su dígito verificador CORRECTO: sin la puerta
    // de la provincia, el módulo 10 por sí solo la dejaría pasar.
    await expect(insertar(cedulaFor('991234567'))).rejects.toThrow(
      /patient_identifier_cedula_valid/,
    );

    // Tercer dígito ≥ 6: eso es un RUC —un ente público o una empresa—, que no
    // es algo que un paciente tenga.
    await expect(insertar(cedulaFor('096004808'))).rejects.toThrow(
      /patient_identifier_cedula_valid/,
    );

    // Y la 30 SÍ entra: son los ecuatorianos registrados en el exterior, y una
    // regla que diga «01 a 24» rechaza calladamente a toda la diáspora.
    await expect(insertar(cedulaFor('300123456'))).resolves.toBe(1);
  });

  it('PA-012 el CHECK no aplica el dígito verificador ecuatoriano a otro país', async () => {
    /**
     * Aplicárselo a una cédula colombiana rechaza una válida, y el resultado es
     * que el mostrador registra al extranjero como provisional para poder
     * seguir — un duplicado en cuanto la persona vuelva con su documento.
     *
     * EL VALOR ELEGIDO FALLA EL MÓDULO 10 A PROPÓSITO: si el CHECK se aplicara
     * a todo el mundo, esta fila no entraría.
     */
    const ficha = await registerPatient();
    const noEsCedulaEcuatoriana = '1712345670';
    expect(cedulaFor(noEsCedulaEcuatoriana.slice(0, 9))).not.toBe(
      noEsCedulaEcuatoriana,
    );

    await expect(
      prisma.$executeRaw`
        INSERT INTO patient_identifier (patient_id, type, issuing_country, value)
        VALUES (${ficha.id}::uuid, 'CEDULA', 'COL', ${noEsCedulaEcuatoriana})
      `,
    ).resolves.toBe(1);
  });

  it('PA-013 rechaza el alta cuyo documento ya tiene otra ficha activa, sin crearla', async () => {
    const cedula = cedulaFor('171234567');
    await registerPatient({
      identifier: { type: 'CEDULA', issuingCountry: 'ECU', value: cedula },
    });
    const antes = await prisma.patient.count();

    const rechazo = await register({
      familyName: 'Cedeno',
      givenName: 'Jose',
      sex: 'MALE',
      birthDate: '1985-07-02',
      identifier: { type: 'CEDULA', issuingCountry: 'ECU', value: cedula },
    }).expect(409);

    const problem = rechazo.body as Problem;
    expect(problem.code).toBe('PATIENT_IDENTIFIER_TAKEN');
    // Y NO SE CREÓ LA FICHA: un 409 que además deja una ficha huérfana sin
    // documento es el duplicado que el registro existe para evitar.
    expect(await prisma.patient.count()).toBe(antes);
  });

  it('PA-013 con dos altas simultáneas de la misma cédula sólo una ficha queda viva', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA PRUEBA INDEPENDIENTE DE LA ENTREGA, Y AFIRMA QUIÉN GANA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * La comprobación previa del servicio es CORTESÍA, no la garantía: bajo
     * concurrencia las dos altas leen «libre» y las dos siguen. Quien impide de
     * verdad las dos fichas es el índice único parcial
     * `patient_identifier_active_unique` (PA-014).
     *
     * Y LA PERDEDORA RECIBE `PATIENT_IDENTIFIER_TAKEN`, no una violación de
     * restricción: el `code` es lo que el cliente ramifica, y dos códigos
     * distintos para el mismo hecho —según se pierda la carrera o no— obligan
     * a la pantalla a conocer los dos o a tratar uno como fallo inesperado.
     */
    const cedula = cedulaFor('171234567');
    const alta = (familyName: string) =>
      register({
        familyName,
        givenName: 'Maria',
        sex: 'FEMALE',
        birthDate: '1990-03-15',
        identifier: { type: 'CEDULA', issuingCountry: 'ECU', value: cedula },
      });

    const [una, otra] = await Promise.all([alta('Guaman'), alta('Cedeno')]);

    const estados = [una.status, otra.status].sort((a, b) => a - b);
    expect(estados).toEqual([201, 409]);

    const perdedora = (una.status === 409 ? una : otra).body as Problem;
    expect(perdedora.code).toBe('PATIENT_IDENTIFIER_TAKEN');
    expect(perdedora.status).toBe(409);

    // UNA SOLA FICHA VIVA CON ESE DOCUMENTO. Es SC-008 escrito como aserción:
    // el número de fichas activas que comparten un documento es cero excepciones.
    const activos = await prisma.patientIdentifier.count({
      where: { value: cedula, use: 'OFFICIAL', patientMerged: false },
    });
    expect(activos).toBe(1);
    expect(await prisma.patient.count()).toBe(1);
  });

  it('PA-013 PA-014 el índice parcial es el árbitro, y responde lo MISMO que la comprobación previa', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * SE LLAMA AL REPOSITORIO A PROPÓSITO, SALTÁNDOSE LA CORTESÍA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Es la única forma DETERMINISTA de recorrer el camino que recorre quien
     * pierde la carrera: la comprobación previa vive en el servicio, y con dos
     * peticiones a la vez cuál de los dos caminos se toma lo decide el
     * milisegundo. Aquí no hay milisegundo que valga — el único árbitro posible
     * es `patient_identifier_active_unique`.
     *
     * Y LA RESPUESTA TIENE QUE SER LA MISMA. Antes de esto, perder la carrera
     * salía por el mapa genérico de violaciones como `DUPLICATE_IDENTIFIER`
     * mientras el caso secuencial salía como `PATIENT_IDENTIFIER_TAKEN`: dos
     * códigos para un mismo hecho, y el `code` es lo que ramifica el cliente.
     */
    const repository = new PrismaPatientRepository(
      prisma as unknown as PrismaService,
    );
    const identifier = {
      type: 'CEDULA' as const,
      issuingCountry: 'ECU',
      value: cedulaFor('171234567'),
    };
    const nueva = (familyName: string) => ({
      familyName,
      givenName: 'Maria',
      sex: 'FEMALE' as const,
      birthDate: new Date('1990-03-15T00:00:00Z'),
      birthDateEstimated: false,
      identifier,
    });

    await repository.create(nueva('Guaman'));

    await expect(repository.create(nueva('Cedeno'))).rejects.toBeInstanceOf(
      DuplicateIdentifierError,
    );
    await expect(repository.create(nueva('Cedeno'))).rejects.toMatchObject({
      code: 'PATIENT_IDENTIFIER_TAKEN',
    });

    // Y no queda una ficha huérfana de la que se revirtió: la ficha y su
    // documento entran en la misma transacción.
    expect(await prisma.patient.count()).toBe(1);
  });

  // =========================================================================
  // PA-023, PA-024, PA-025 — lo que NO se escribe y lo que NO sale
  // =========================================================================

  it('PA-023 una búsqueda que devuelve varias fichas no deja ninguna fila de bitácora', async () => {
    /**
     * Se teclea letra a letra: auditar cada pulsación escribe miles de filas al
     * día y ENTIERRA los accesos que importan, que es lo contrario de para lo
     * que existe la bitácora. Abrir una ficha sí es el acto del que se responde,
     * y ése se audita — lo comprueba la prueba de abajo por contraste.
     */
    await registerPatient({ familyName: 'Guaman' });
    await registerPatient({ familyName: 'Guaman', givenName: 'Ana' });
    const antes = await auditRows();

    const respuesta = await search({ q: 'Guaman' }).expect(200);
    expect((respuesta.body as { items: unknown[] }).items).toHaveLength(2);

    expect(await auditRows()).toBe(antes);
  });

  it('PA-022 PA-023 abrir UNA ficha deja exactamente una fila, y el listado ninguna', async () => {
    // El contraste es la prueba: sin él, cero filas después de una búsqueda
    // pasaría igual con la bitácora entera desconectada.
    const ficha = await registerPatient();
    const antes = await auditRows();

    await search({ q: 'Guaman' }).expect(200);
    expect(await auditRows()).toBe(antes);

    await read(ficha.id).expect(200);
    const lecturas = await prisma.accessAudit.findMany({
      where: { resourceType: 'patient', action: 'READ' },
      select: { action: true, resourceId: true },
    });
    expect(lecturas).toEqual([{ action: 'READ', resourceId: ficha.id }]);
    expect(await auditRows()).toBe(antes + 1);
  });

  it('PA-022 la fila dice QUIÉN y DESDE DÓNDE, no sólo qué y cuándo', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL «DESDE DÓNDE» ES LA MITAD QUE NADIE AFIRMABA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * PA-022 pide «quién, qué, cuándo y desde dónde», y es la evidencia que la
     * LOPDP espera para investigar un acceso indebido: sin dirección ni
     * dispositivo, el rastro dice que alguien miró y no permite llegar a la
     * máquina desde la que miró.
     *
     * LA MUTACIÓN QUE ESTA PRUEBA CAZA: poner `ip` y `userAgent` a `undefined`
     * en `requester()` de `patients.controller.ts`. Sobrevivía a las 1141
     * unitarias y a las cuatro suites de integración de `patients` — ninguna
     * miraba esas dos columnas, así que la bitácora podía quedarse ciega sin
     * que nada se pusiera rojo.
     *
     * `ip` se afirma contra el bucle local porque es de donde llega la
     * petición: `trust proxy` está en 0 hops en pruebas, así que `req.ip` ES la
     * dirección del socket. Lo que se demuestra no es qué dirección es, sino
     * que la que hubiera llega hasta la fila.
     */
    const ficha = await registerPatient();

    await read(ficha.id).expect(200);

    const [fila] = await prisma.accessAudit.findMany({
      where: { resourceType: 'patient', action: 'READ' },
      select: {
        userId: true,
        ip: true,
        userAgent: true,
        resourceId: true,
        occurredAt: true,
      },
    });

    expect(fila?.resourceId).toBe(ficha.id);
    // QUIÉN: el usuario de la sesión, nunca un id que venga en la petición.
    expect(fila?.userId).toBe(recepcionUserId);
    // DESDE DÓNDE, las dos mitades.
    expect(fila?.ip).toMatch(/127\.0\.0\.1$/);
    expect(fila?.userAgent).toBe(USER_AGENT);
    // CUÁNDO, que lo pone la base y no el proceso.
    expect(fila?.occurredAt).toBeInstanceOf(Date);
  });

  it('PA-024 una ficha que no existe responde PATIENT_NOT_FOUND y NO escribe bitácora', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * NO SE AUDITA PORQUE NO HAY TITULAR A QUIEN RENDIR CUENTAS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Si se auditara, cualquiera podría llenar el rastro de ruido probando
     * identificadores — y el rastro existe precisamente para poder encontrar
     * el acceso indebido entre lo demás.
     */
    await registerPatient();
    const antes = await auditRows();

    const inexistente = '01890000-0000-7000-8000-000000000001';
    const respuesta = await read(inexistente).expect(404);
    const problem = respuesta.body as Problem;

    expect(problem.code).toBe('PATIENT_NOT_FOUND');
    expect(await auditRows()).toBe(antes);
  });

  it('PA-024 responde lo MISMO a cualquier identificador que no lleve a una ficha', async () => {
    /**
     * Distinguirlos convierte el endpoint en un oráculo: se prueban
     * identificadores hasta que uno responde distinto y ya se sabe quién es
     * paciente aquí. Se comparan dos respuestas ENTERAS, no sólo el código: un
     * `detail` que dijera «no visible» filtraría exactamente lo mismo.
     *
     * ⚠️ EL SEGUNDO ID ES EL DE UNA FILA QUE SÍ EXISTE en la base —una cuenta
     * de personal— y que no es una ficha. Es la forma de «no lleva a un
     * paciente» que un `findUnique` sí distingue del primero.
     */
    const cuenta = await prisma.user.findFirstOrThrow({ select: { id: true } });
    const inexistente = '01890000-0000-7000-8000-000000000002';

    const uno = await read(inexistente).expect(404);
    const otro = await read(cuenta.id).expect(404);

    /**
     * Se comparan los dos problemas ENTEROS menos lo que identifica a la
     * PETICIÓN —el instante, el trazo y la URL pedida—, que por definición
     * difiere y no dice nada del paciente. Todo lo demás tiene que ser
     * idéntico: basta un `detail` distinto para que el endpoint diga si
     * alguien es paciente aquí.
     */
    const PER_REQUEST = new Set(['instance', 'timestamp', 'traceId']);
    const comparable = (body: unknown): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(body as Record<string, unknown>).filter(
          ([key]) => !PER_REQUEST.has(key),
        ),
      );

    expect(comparable(otro.body)).toEqual(comparable(uno.body));
    expect((uno.body as Problem).code).toBe('PATIENT_NOT_FOUND');
  });

  it('PA-025 ningún mensaje de error nombra al paciente ni a su documento', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * SE MIRA LA RESPUESTA ENTERA, NO EL CAMPO QUE SE ESPERA QUE FALLE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El dato se escapa por donde nadie mira: un `detail` que repite el cuerpo,
     * un `errors[].message` que cita el valor rechazado, un `title` compuesto
     * con el nombre para «ayudar». Así que se serializa el problema completo y
     * se busca dentro cada dato de la persona.
     *
     * EL MRN SÍ PUEDE APARECER —`PATIENT_MERGED` lo nombra a propósito—: es un
     * número interno, no un identificador nacional.
     */
    const cedula = cedulaFor('171234567');
    const APELLIDO = 'Zambranopozo';
    const NOMBRE = 'Yolandaesther';

    await registerPatient({
      familyName: APELLIDO,
      givenName: NOMBRE,
      identifier: { type: 'CEDULA', issuingCountry: 'ECU', value: cedula },
    });

    const problemas: unknown[] = [];

    // 409: el documento ya lo tiene otra ficha.
    problemas.push(
      (
        await register({
          familyName: APELLIDO,
          givenName: NOMBRE,
          sex: 'FEMALE',
          birthDate: '1990-03-15',
          identifier: { type: 'CEDULA', issuingCountry: 'ECU', value: cedula },
        }).expect(409)
      ).body,
    );

    // 404: la ficha no existe.
    problemas.push(
      (await read('01890000-0000-7000-8000-000000000003').expect(404)).body,
    );

    // 422: la cédula no pasa el dígito verificador. Es el caso donde el valor
    // rechazado está más cerca de acabar dentro del mensaje.
    problemas.push(
      (
        await register({
          familyName: APELLIDO,
          givenName: NOMBRE,
          sex: 'FEMALE',
          birthDate: '1990-03-15',
          identifier: {
            type: 'CEDULA',
            issuingCountry: 'ECU',
            value: `${cedula.slice(0, 9)}${(Number(cedula[9]) + 1) % 10}`,
          },
        }).expect(422)
      ).body,
    );

    for (const problema of problemas) {
      const texto = JSON.stringify(problema);
      expect(texto).not.toContain(APELLIDO);
      expect(texto).not.toContain(NOMBRE);
      expect(texto).not.toContain(cedula);
      expect(texto).not.toContain(cedula.slice(0, 9));
    }
  });
});
