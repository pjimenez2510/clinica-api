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
 * Las columnas del instructivo del RDACAA que faltaban, contra PostgreSQL 18 de
 * verdad (P5: PA-056 a PA-059, D-039).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ PRUEBA ESTO QUE LAS UNITARIAS NO PUEDEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. **La puerta de PA-058 con una sesión de verdad.** Un doble con los
 *     permisos puestos a mano no demuestra nada sobre el guard: el defecto de
 *     AG-111 fue exactamente eso. Aquí se firma con `RECEPCION` —que tiene
 *     `patient:read` y `patient:write` y NO el permiso nuevo— y con un rol al
 *     que alguien se lo concedió a propósito.
 *  2. **A qué roles reparte la semilla `patient:sexual-orientation`.**
 *     `syncAuthorisation` acaba de correr con el catálogo entero en el
 *     `beforeEach`, así que el conjunto de portadores es exacto: `MEDICO` y
 *     `ADMIN` desde el 19-08-2026 (D-039), el que esta prueba creó, y nadie
 *     más — ni `RECEPCION` ni `CAJA`.
 *  3. **Que la corrección deje su fila en `patient_change_history`** con el
 *     valor anterior, también para la orientación sexual — que es dato de
 *     categoría especial y por eso el rastro importa más, no menos.
 *  4. **Que el estado RESULTANTE decida.** Corregir sólo la nacionalidad de una
 *     ficha que ya tiene pueblo, o sólo el país de una que ya tiene etnia,
 *     depende de lo ALMACENADO: ninguna unitaria del servicio con dobles
 *     demuestra que la instantánea bloqueada de la transacción lo vea.
 *  5. **Que la etnia y la nacionalidad dejen de contar** en la ficha extranjera,
 *     también en la fila del listado, que es donde el indicador se arma con un
 *     `select` distinto del de la ficha.
 */
const PASSWORD = 'el caballo come alfalfa';
const RECEPCION_EMAIL = 'admision.rdacaa@clinica.ec';
const CLINICAL_EMAIL = 'medico.rdacaa@clinica.ec';

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

interface PatientBody {
  id: string;
  mrn: string;
  rdacaaMissingFields: string[];
  ethnicity: ConceptBody | null;
  nationality: ConceptBody | null;
  people: ConceptBody | null;
  countryOfNationality: { code: string; display: string | null } | null;
}

/**
 * Una cédula sintética con el dígito verificador CALCULADO, nunca copiado.
 *
 * Copiar el número de una persona real está prohibido, y componerlo a ojo
 * produce un rechazo por el motivo equivocado.
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

describe('las columnas del instructivo del RDACAA, contra la base', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  /** `RECEPCION` de fábrica: `patient:read` + `patient:write`, y nada más. */
  let recepcion: string;
  /** Un rol al que alguien concedió `patient:sexual-orientation` a propósito. */
  let clinico: string;
  let clinicoUserId: string;

  let indigenaId: string;
  let mestizoId: string;
  let kichwaId: string;
  let shuarId: string;
  let otavaloId: string;
  let heterosexualId: string;

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

    /**
     * ⚠️ `patient:sexual-orientation` SE CONCEDE AQUÍ, A MANO, y eso es la
     * mitad de PA-058 que se ve: los roles son datos, así que una clínica
     * arma desde la pantalla de roles el que quiera. Desde el 19-08-2026 lo
     * traen también `MEDICO` y `ADMIN` de fábrica (D-039), pero este fichero
     * firma con un rol propio para que la prueba de la puerta no dependa de
     * qué permisos lleve además el rol sembrado.
     */
    const role = await prisma.role.create({
      data: {
        code: 'MEDICO_RDACAA',
        name: 'Consulta con acceso a la columna 7',
        description: 'Rol de prueba con el permiso concedido a propósito',
        permissions: {
          create: [
            { permissionCode: 'patient:read' },
            { permissionCode: 'patient:write' },
            { permissionCode: 'patient:sexual-orientation' },
          ],
        },
      },
    });
    // The role→permission cache is indexed by id and truncation recreates the
    // roles with fresh ids: without this every request answers 403.
    registry.invalidate();

    recepcion = await signIn(RECEPCION_EMAIL, 'RECEPCION', '092345678');
    clinico = await signInWithRole(CLINICAL_EMAIL, role.id, '171003406');

    await seedCatalogues();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function createAccount(
    email: string,
    roleId: string,
    cedulaPrefix: string,
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Gabriela',
        lastName: 'Mera',
        cedula: cedulaFor(cedulaPrefix),
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    await prisma.userRoleGrant.create({ data: { userId: user.id, roleId } });
    return user.id;
  }

  async function token(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  async function signIn(
    email: string,
    roleCode: string,
    cedulaPrefix: string,
  ): Promise<string> {
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await createAccount(email, role.id, cedulaPrefix);
    return token(email);
  }

  async function signInWithRole(
    email: string,
    roleId: string,
    cedulaPrefix: string,
  ): Promise<string> {
    clinicoUserId = await createAccount(email, roleId, cedulaPrefix);
    return token(email);
  }

  /**
   * Los catálogos del instructivo de los que la ficha ELIGE, con SUS códigos.
   *
   * ⚠️ CON LOS CÓDIGOS DEL MINISTERIO Y NO CON NOMBRES INVENTADOS. `1` es
   * «Indígena» en la columna 12 y `6` es «Kichwa» en la 13: son los únicos
   * valores con los que el formulario activa la columna siguiente, y el sistema
   * los reconoce por su `code`. La lista del INEC que este catálogo tuvo
   * sembrada hasta el 19-08-2026 ponía Kichwa en el `14`, que ahora es Andoa —
   * un código leído bajo la lista equivocada es un dato distinto.
   */
  async function seedCatalogues(): Promise<void> {
    const rows = async (
      systemCode: string,
      name: string,
      concepts: readonly { code: string; display: string }[],
    ): Promise<string[]> => {
      const system = await prisma.catalogSystem.create({
        data: { code: systemCode, name, hierarchical: false },
      });
      const created: string[] = [];
      for (const concept of concepts) {
        const row = await prisma.catalogConcept.create({
          data: {
            systemId: system.id,
            code: concept.code,
            display: concept.display,
            validFrom: new Date('2020-01-01'),
            attributes: { level: 0 },
          },
        });
        created.push(row.id);
      }
      return created;
    };

    [indigenaId, mestizoId] = (await rows(
      'ETHNICITY',
      'Autoidentificación étnica (RDACAA, columna 12)',
      [
        { code: '1', display: 'Indígena' },
        { code: '6', display: 'Mestizo/a' },
      ],
    )) as [string, string];

    [kichwaId, shuarId] = (await rows(
      'NATIONALITY',
      'Nacionalidad indígena (RDACAA, columna 13)',
      [
        { code: '6', display: 'Kichwa' },
        { code: '8', display: 'Shuar' },
      ],
    )) as [string, string];

    [otavaloId] = (await rows('PEOPLE', 'Pueblo (RDACAA, columna 14)', [
      { code: '8', display: 'Otavalo' },
    ])) as [string];

    [heterosexualId] = (await rows(
      'SEXUAL_ORIENTATION',
      'Orientación sexual (RDACAA, columna 7)',
      [{ code: '4', display: 'Heterosexual' }],
    )) as [string];

    await rows('COUNTRY', 'Países (ISO 3166-1)', [
      { code: 'ECU', display: 'Ecuador' },
      { code: 'VEN', display: 'Venezuela (República Bolivariana de)' },
    ]);
  }

  // -------------------------------------------------------------------------
  // Atajos de transporte
  // -------------------------------------------------------------------------

  const register = (body: Record<string, unknown>, as = recepcion) =>
    request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${as}`)
      .send(body);

  const correct = (id: string, body: Record<string, unknown>, as = recepcion) =>
    request(app.getHttpServer())
      .patch(`/api/v1/patients/${id}`)
      .set('Authorization', `Bearer ${as}`)
      .send(body);

  const readOrientation = (id: string, as: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/patients/${id}/sexual-orientation`)
      .set('Authorization', `Bearer ${as}`);

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

  // =========================================================================
  // PA-056 · «Pueblos», la columna 14
  // =========================================================================

  it('PA-056 guarda el pueblo de una ficha kichwa y lo devuelve con su redacción', async () => {
    const chart = await registerPatient({
      ethnicityConceptId: indigenaId,
      nationalityConceptId: kichwaId,
      peopleConceptId: otavaloId,
    });

    expect(chart.people).toMatchObject({ code: '8', display: 'Otavalo' });

    const reopened = await request(app.getHttpServer())
      .get(`/api/v1/patients/${chart.id}`)
      .set('Authorization', `Bearer ${recepcion}`)
      .expect(200);

    expect((reopened.body as PatientBody).people?.display).toBe('Otavalo');
  });

  it('PA-056 rechaza un pueblo cuando la nacionalidad indígena no es «Kichwa»', async () => {
    const refused = await register({
      familyName: 'Guaman',
      givenName: 'Maria',
      sex: 'FEMALE',
      birthDate: '1990-03-15',
      ethnicityConceptId: indigenaId,
      nationalityConceptId: shuarId,
      peopleConceptId: otavaloId,
    }).expect(422);

    const problem = refused.body as Problem;
    expect(problem.code).toBe('PEOPLE_REQUIRES_KICHWA_NATIONALITY');
    expect(problem.errors?.[0]).toMatchObject({ field: 'peopleConceptId' });
    // El mensaje dice QUÉ HACER y ofrece las dos salidas.
    expect(problem.errors?.[0]?.message).toContain('Kichwa');

    // Y no queda media ficha: se decide antes de escribir nada.
    expect(await prisma.patient.count()).toBe(0);
  });

  it('PA-056 rechaza cambiar la nacionalidad de una ficha que ya declara pueblo, y no deja rastro', async () => {
    /**
     * ⚠️ EL ESTADO RESULTANTE, Y ESTE CASO NO LO VE UNA UNITARIA: depende de lo
     * ALMACENADO. La corrección no menciona el pueblo siquiera.
     */
    const chart = await registerPatient({
      ethnicityConceptId: indigenaId,
      nationalityConceptId: kichwaId,
      peopleConceptId: otavaloId,
    });

    const refused = await correct(chart.id, {
      nationalityConceptId: shuarId,
    }).expect(422);

    expect((refused.body as Problem).code).toBe(
      'PEOPLE_REQUIRES_KICHWA_NATIONALITY',
    );

    // Ni fila de histórico ni fila de bitácora de mutación: nada ocurrió.
    expect(
      await prisma.patientChangeHistory.count({
        where: { patientId: chart.id },
      }),
    ).toBe(0);
    expect(
      await prisma.accessAudit.count({
        where: { resourceId: chart.id, action: 'UPDATE' },
      }),
    ).toBe(0);
  });

  it('PA-056 acepta cambiar la nacionalidad si el pueblo se vacía en la MISMA petición', async () => {
    // La salida que el mensaje ofrece tiene que funcionar en un solo `PATCH`, o
    // la ficha se queda sin forma de corregirse.
    const chart = await registerPatient({
      ethnicityConceptId: indigenaId,
      nationalityConceptId: kichwaId,
      peopleConceptId: otavaloId,
    });

    const corrected = await correct(chart.id, {
      nationalityConceptId: shuarId,
      peopleConceptId: null,
    }).expect(200);

    expect((corrected.body as PatientBody).people).toBeNull();

    const trail = await prisma.patientChangeHistory.findMany({
      where: { patientId: chart.id },
      select: { field: true, valueBefore: true, valueAfter: true },
      orderBy: { field: 'asc' },
    });
    expect(trail).toEqual(
      expect.arrayContaining([
        { field: 'peopleConceptId', valueBefore: otavaloId, valueAfter: null },
      ]),
    );
  });

  // =========================================================================
  // PA-057, PA-058 · «Orientación sexual», la columna 7
  // =========================================================================

  it('PA-057 rechaza la orientación sexual de un paciente menor de diez años', async () => {
    const refused = await register({
      familyName: 'Guaman',
      givenName: 'Maria',
      sex: 'FEMALE',
      // Nacida hoy: cero años cumplidos, sea cual sea la hora en Guayaquil.
      birthDate: today(),
      sexualOrientationConceptId: heterosexualId,
    }).expect(422);

    const problem = refused.body as Problem;
    expect(problem.code).toBe('SEXUAL_ORIENTATION_BELOW_MINIMUM_AGE');
    expect(problem.errors?.[0]).toMatchObject({
      field: 'sexualOrientationConceptId',
    });
    // ⚠️ EL MENSAJE NO REPITE EL VALOR ENVIADO: es dato de categoría especial y
    // un error acaba en capturas de pantalla y en registros de log.
    expect(problem.errors?.[0]?.message).not.toContain('Heterosexual');
    expect(await prisma.patient.count()).toBe(0);
  });

  it('PA-057 rechaza mover la fecha de nacimiento por debajo del umbral en una ficha que ya la declara', async () => {
    const chart = await registerPatient({
      sexualOrientationConceptId: heterosexualId,
    });

    const refused = await correct(chart.id, { birthDate: today() }).expect(422);

    expect((refused.body as Problem).code).toBe(
      'SEXUAL_ORIENTATION_BELOW_MINIMUM_AGE',
    );
    expect(
      await prisma.patientChangeHistory.count({
        where: { patientId: chart.id },
      }),
    ).toBe(0);
  });

  it('PA-058 no deja que la orientación sexual viaje en la ficha ni en el listado', async () => {
    /**
     * LA MITAD QUE ES UNA AUSENCIA, y sólo se puede afirmar sobre la respuesta:
     * lo que una pantalla decida no pintar no demuestra nada. Quien lo escribió
     * tiene `patient:read`, así que si viajara, lo vería.
     */
    const chart = await registerPatient({
      sexualOrientationConceptId: heterosexualId,
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/patients/${chart.id}`)
      .set('Authorization', `Bearer ${recepcion}`)
      .expect(200);
    expect(JSON.stringify(detail.body)).not.toContain(heterosexualId);
    expect(detail.body).not.toHaveProperty('sexualOrientation');

    const listing = await request(app.getHttpServer())
      .get('/api/v1/patients?q=Guaman')
      .set('Authorization', `Bearer ${recepcion}`)
      .expect(200);
    expect(JSON.stringify(listing.body)).not.toContain(heterosexualId);
  });

  it('PA-058 niega la lectura a una sesión con `patient:read` y `patient:write`', async () => {
    // CON SESIÓN DE VERDAD, no con un doble con los permisos puestos a mano: el
    // defecto de AG-111 fue exactamente eso. `RECEPCION` acaba de ESCRIBIR este
    // dato y no puede volver a leerlo, que es la asimetría que PA-058 declara.
    const chart = await registerPatient({
      sexualOrientationConceptId: heterosexualId,
    });

    const refused = await readOrientation(chart.id, recepcion).expect(403);

    expect((refused.body as Problem).code).toBe('PERMISSION_DENIED');
  });

  it('PA-058 la sirve a quien tiene el permiso, y deja una fila de bitácora propia', async () => {
    const chart = await registerPatient({
      sexualOrientationConceptId: heterosexualId,
    });

    const read = await readOrientation(chart.id, clinico).expect(200);

    expect(
      (read.body as { sexualOrientation: ConceptBody }).sexualOrientation,
    ).toMatchObject({ code: '4', display: 'Heterosexual' });

    const trail = await prisma.accessAudit.findMany({
      where: { resourceType: 'patient_sexual_orientation' },
      select: {
        userId: true,
        resourceId: true,
        action: true,
        before: true,
        after: true,
      },
    });
    expect(trail).toEqual([
      {
        userId: clinicoUserId,
        resourceId: chart.id,
        action: 'READ',
        // ⚠️ SIN CARGA ÚTIL. La lista blanca de
        // `access_audit_payload_only_for_declared_resources` es exactamente
        // `'configuration'`, y registrar no lanza: la fila se habría perdido en
        // silencio (D-032).
        before: null,
        after: null,
      },
    ]);
  });

  it('PA-058 reparte `patient:sexual-orientation` a MEDICO y a ADMIN, y a ningun otro rol de fabrica', async () => {
    /**
     * ⚠️ ESTA PRUEBA AFIRMABA LO CONTRARIO HASTA EL 19-08-2026, y el cambio es
     * la decisión del usuario que cierra la última pregunta de D-039: el
     * permiso lo llevan `MEDICO` y `ADMIN`. Antes no lo traía nadie
     * (`explicitGrantOnly`) y la columna 7 se escribía y no se leía.
     *
     * SIGUE SIENDO UN REPARTO EXACTO, y por eso no se borró: `RECEPCION`,
     * `CAJA`, `ENFERMERIA` y `AUDITOR` no lo tienen, y que uno de ellos lo
     * reciba en una semilla falla aquí. `MEDICO_RDACAA` es el rol que este
     * fichero crea a mano en el `beforeEach`, que es lo que una clínica hace
     * desde la pantalla de roles.
     *
     * ⚠️ Y LA CONSECUENCIA, DICHA EN VOZ ALTA: con `ADMIN` llevándolo, quien
     * administra cuentas puede leer la orientación sexual de cualquier
     * paciente — esta ruta exige este permiso y ningún otro, así que no hace
     * falta ni `patient:read`. Es deliberado, no un descuido.
     */
    const holders = await prisma.rolePermission.findMany({
      where: { permissionCode: 'patient:sexual-orientation' },
      select: { role: { select: { code: true } } },
    });

    expect(holders.map((holder) => holder.role.code).sort()).toEqual([
      'ADMIN',
      'MEDICO',
      'MEDICO_RDACAA',
    ]);
  });

  it('PA-058 deja el valor anterior de la orientación sexual en el histórico de la ficha', async () => {
    // Es dato de categoría especial, así que el rastro importa MÁS y no menos —
    // y vive en `patient_change_history`, que es rectificable a propósito
    // (REQ-113), no en la bitácora append-only.
    const chart = await registerPatient({
      sexualOrientationConceptId: heterosexualId,
    });

    await correct(chart.id, { sexualOrientationConceptId: null }).expect(200);

    const trail = await prisma.patientChangeHistory.findMany({
      where: { patientId: chart.id, field: 'sexualOrientationConceptId' },
      select: { valueBefore: true, valueAfter: true },
    });
    expect(trail).toEqual([{ valueBefore: heterosexualId, valueAfter: null }]);

    const after = await readOrientation(chart.id, clinico).expect(200);
    expect(
      (after.body as { sexualOrientation: ConceptBody | null })
        .sexualOrientation,
    ).toBeNull();
  });

  // =========================================================================
  // PA-059 · la etnia sólo aplica a nacionalidad ecuatoriana
  // =========================================================================

  it('PA-059 rechaza la etnia de una ficha cuyo país de nacionalidad no es Ecuador', async () => {
    const refused = await register({
      familyName: 'Guaman',
      givenName: 'Maria',
      sex: 'FEMALE',
      birthDate: '1990-03-15',
      ethnicityConceptId: mestizoId,
      countryOfNationalityCode: 'VEN',
    }).expect(422);

    const problem = refused.body as Problem;
    expect(problem.code).toBe('ETHNICITY_REQUIRES_ECUADORIAN_NATIONALITY');
    expect(problem.errors?.[0]).toMatchObject({ field: 'ethnicityConceptId' });
    // ⚠️ EL MENSAJE DICE QUÉ HACER Y OFRECE LAS DOS SALIDAS: es la combinación
    // que se teclea por accidente, porque el país y la etnia están en dos
    // pantallas del mismo formulario.
    expect(problem.errors?.[0]?.message).toContain('Ecuador');
    expect(await prisma.patient.count()).toBe(0);
  });

  it('PA-059 admite la etnia con país `ECU` y también sin país registrado', async () => {
    // «Todavía nadie lo ha preguntado» no es «no es ecuatoriano»: el país es
    // opcional (PA-053) y la inmensa mayoría de las fichas no lo llevan.
    const ecuadorian = await registerPatient({
      ethnicityConceptId: mestizoId,
      countryOfNationalityCode: 'ECU',
    });
    expect(ecuadorian.ethnicity?.display).toBe('Mestizo/a');

    const unstated = await registerPatient({ ethnicityConceptId: mestizoId });
    expect(unstated.countryOfNationality).toBeNull();
    expect(unstated.ethnicity?.display).toBe('Mestizo/a');
  });

  it('PA-059 rechaza cambiar el país de una ficha que ya declara etnia, y no deja rastro', async () => {
    const chart = await registerPatient({ ethnicityConceptId: mestizoId });

    const refused = await correct(chart.id, {
      countryOfNationalityCode: 'VEN',
    }).expect(422);

    expect((refused.body as Problem).code).toBe(
      'ETHNICITY_REQUIRES_ECUADORIAN_NATIONALITY',
    );
    expect(
      await prisma.patientChangeHistory.count({
        where: { patientId: chart.id },
      }),
    ).toBe(0);
  });

  it('PA-059 acepta el país y la etnia vaciada en la MISMA petición', async () => {
    const chart = await registerPatient({ ethnicityConceptId: mestizoId });

    const corrected = await correct(chart.id, {
      countryOfNationalityCode: 'VEN',
      ethnicityConceptId: null,
    }).expect(200);

    const body = corrected.body as PatientBody;
    expect(body.ethnicity).toBeNull();
    expect(body.countryOfNationality).toMatchObject({ code: 'VEN' });
  });

  it('PA-059 deja de contar la etnia y la nacionalidad en la ficha extranjera, también en el listado', async () => {
    /**
     * ⚠️ ES EL DEFECTO QUE D-037 RESOLVIÓ UN ESCALÓN MÁS ABAJO. Si la etnia
     * deja de aplicar a un paciente extranjero, no puede seguir contando como
     * dato que falta: sería otra casilla que el sistema prohíbe cerrar, y un
     * indicador que nadie puede dejar en cero es un indicador que admisión
     * aprende a ignorar.
     *
     * Y SE COMPRUEBA TAMBIÉN EN EL LISTADO, que arma el indicador con un
     * `select` distinto del de la ficha: es donde admisión trabaja.
     */
    const foreign = await registerPatient({
      familyName: 'Piedra',
      countryOfNationalityCode: 'VEN',
      identifier: {
        type: 'CEDULA',
        issuingCountry: 'ECU',
        value: cedulaFor('171003406'),
      },
      residenceParishConceptId: undefined,
    });

    expect(foreign.rdacaaMissingFields).not.toContain('ethnicityConceptId');
    expect(foreign.rdacaaMissingFields).not.toContain('nationalityConceptId');
    expect(foreign.rdacaaMissingFields).toEqual(['residenceParishConceptId']);

    const listing = await request(app.getHttpServer())
      .get('/api/v1/patients?q=Piedra')
      .set('Authorization', `Bearer ${recepcion}`)
      .expect(200);

    const rows = (listing.body as { items: PatientBody[] }).items;
    expect(rows[0]?.rdacaaMissingFields).toEqual(['residenceParishConceptId']);
  });

  it('PA-059 sigue pidiendo la etnia mientras no haya país registrado', async () => {
    // La rama que se pierde con facilidad, y la misma que D-037 escribió para
    // la nacionalidad: mientras nadie haya hecho la pregunta, no se sabe si el
    // campo hará falta.
    const chart = await registerPatient({
      familyName: 'Sinpais',
      identifier: {
        type: 'CEDULA',
        issuingCountry: 'ECU',
        value: cedulaFor('092345678'),
      },
    });

    expect(chart.rdacaaMissingFields).toContain('ethnicityConceptId');
    expect(chart.rdacaaMissingFields).toContain('nationalityConceptId');
  });
});

/**
 * Hoy en Guayaquil, en formato de calendario.
 *
 * ⚠️ NO `new Date().toISOString()`: eso da el día UTC, y todo Ecuador está cinco
 * horas al oeste. Después de las 19:00 locales el día UTC ya es el siguiente, y
 * una fecha de nacimiento «de hoy» sería del futuro — que el DTO rechaza por el
 * motivo equivocado.
 */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
