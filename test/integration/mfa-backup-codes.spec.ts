import { ThrottlerStorage } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { URI } from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { BACKUP_CODE_COUNT } from '../../src/modules/auth/domain/backup-code';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { PrismaAuthUserRepository } from '../../src/modules/auth/infrastructure/prisma-auth-user.repository';
import { RefreshTokenService } from '../../src/modules/auth/infrastructure/refresh-token.service';
import { PrismaAccountAdminRepository } from '../../src/modules/auth/infrastructure/prisma-account-admin.repository';
import { TokenService } from '../../src/modules/auth/infrastructure/token.service';
import { MFA_CHALLENGE_FAMILY } from '../../src/modules/auth/domain/session';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * AU-005 — los códigos de respaldo, de extremo a extremo y contra PostgreSQL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO NO PUEDE SER UNA PRUEBA UNITARIA.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «De un solo uso» no es una regla escrita en TypeScript: es un `UPDATE …
 * WHERE used_at IS NULL` que PostgreSQL arbitra con el bloqueo de fila. Un
 * doble que devuelve `count: 1` demuestra únicamente que el doble devuelve 1,
 * y el fallo que se busca —dos peticiones con el MISMO código abriendo dos
 * sesiones— solo aparece cuando hay dos conexiones de verdad compitiendo.
 *
 * Y se recorre por HTTP porque la mitad de la garantía vive fuera del
 * servicio: el DTO tiene que dejar pasar un código que no son seis dígitos, y
 * la respuesta a uno incorrecto tiene que ser indistinguible de la de un TOTP
 * incorrecto. Ninguna de las dos cosas se ve desde una prueba de la clase.
 */
const PASSWORD = 'el caballo come alfalfa';
const EMAIL = 'ana.torres@clinica.ec';

interface EnrolledAccount {
  userId: string;
  backupCodes: string[];
  /** El `otpauth://` del factor matriculado: con él se generan sus códigos. */
  uri: string;
  /** Sesión COMPLETA de esa cuenta, que es lo que AU-037 exige. */
  accessToken: string;
}

describe('AU-005 códigos de respaldo del segundo factor', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    enableBigIntSerialisation();
    prisma = db();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      // Sin límite de peticiones, como el resto de suites HTTP: el limitador
      // real permite diez por minuto por IP y aquí todas salen de la misma.
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
  });

  afterAll(async () => {
    await closeApp(app);
  });

  const server = () => app.getHttpServer();

  async function createAccount(): Promise<string> {
    await syncAuthorisation(prisma);

    const user = await prisma.user.create({
      data: {
        email: EMAIL,
        firstName: 'Ana',
        lastName: 'Torres',
        // Dígito verificador real: la base lo valida.
        cedula: '1710034065',
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });

    const medico = await prisma.role.findUniqueOrThrow({
      where: { code: 'MEDICO' },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: medico.id, siteId: null },
    });

    return user.id;
  }

  const signIn = () =>
    request(server()).post('/api/v1/auth/login').send({
      email: EMAIL,
      password: PASSWORD,
    });

  /**
   * Matricula el segundo factor recorriendo las rutas reales y devuelve los
   * códigos que el sistema entregó.
   *
   * El TOTP se calcula a partir del `uri` que devuelve la matrícula, que es lo
   * que haría la aplicación del teléfono al leer el QR. Reconstruirlo a mano
   * con los parámetros copiados del servicio sería probar la copia.
   */
  async function enrol(): Promise<EnrolledAccount> {
    const userId = await createAccount();

    const session = (await signIn().expect(200)).body as {
      accessToken: string;
    };

    const enrolment = (
      await request(server())
        .post('/api/v1/auth/mfa/enroll')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(200)
    ).body as { secret: string; uri: string };

    const confirmation = (
      await request(server())
        .post('/api/v1/auth/mfa/confirm')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ code: URI.parse(enrolment.uri).generate() })
        .expect(200)
    ).body as { backupCodes: string[] };

    return {
      userId,
      backupCodes: confirmation.backupCodes,
      uri: enrolment.uri,
      accessToken: session.accessToken,
    };
  }

  /**
   * El código que enseñaría el teléfono, opcionalmente para un paso futuro.
   *
   * ⚠️ EL DESPLAZAMIENTO NO ES UN TRUCO PARA QUE PASE LA PRUEBA, es la
   * protección contra repetición funcionando. Confirmar una matrícula guarda
   * el paso consumido (`mfa_last_step`), así que el código del MISMO paso ya
   * no vale: quien lo interceptara no podría reutilizarlo durante los treinta
   * segundos que sigue siendo válido. `+30 s` pide el paso siguiente, que
   * entra en la ventana de ±1 y es lo que tecleará una persona real un momento
   * después.
   */
  const totpFor = (uri: string, offsetMs = 0): string =>
    URI.parse(uri).generate({ timestamp: Date.now() + offsetMs });

  const NEXT_STEP = 30_000;

  /** Inicia sesión hasta el reto: el token que solo abre el segundo factor. */
  async function challenge(): Promise<string> {
    const response = await signIn().expect(200);
    const body = response.body as {
      mfaRequired?: true;
      challengeToken?: string;
    };

    expect(body.mfaRequired, 'la cuenta debe pedir segundo factor').toBe(true);
    return body.challengeToken!;
  }

  const verify = (token: string, code: string) =>
    request(server())
      .post('/api/v1/auth/mfa/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ code });

  it('AU-005 entrega los códigos al confirmar y guarda solo sus hashes Argon2', async () => {
    const { userId, backupCodes } = await enrol();

    expect(backupCodes).toHaveLength(BACKUP_CODE_COUNT);

    const stored = await prisma.backupCode.findMany({ where: { userId } });
    expect(stored).toHaveLength(BACKUP_CODE_COUNT);

    for (const row of stored) {
      // Argon2id, como una contraseña: un volcado de la base robado no
      // contiene un segundo factor que funcione.
      expect(row.codeHash).toMatch(/^\$argon2id\$/);
      expect(row.usedAt).toBeNull();
    }
    // Ninguno de los códigos aparece en claro en ninguna fila.
    for (const code of backupCodes) {
      expect(stored.map((row) => row.codeHash)).not.toContain(code);
    }
  });

  it('AU-005 completa el inicio de sesión con un código de respaldo, sin el teléfono', async () => {
    const { backupCodes } = await enrol();

    const session = (
      await verify(await challenge(), backupCodes[0]!).expect(200)
    ).body as { accessToken: string; user: { email: string } };

    expect(session.user.email).toBe(EMAIL);
    expect(session.accessToken).toEqual(expect.any(String));
  });

  it('AU-046 completar el segundo factor dice los segundos que le quedan a la familia nueva', async () => {
    const { backupCodes } = await enrol();

    const verified = await verify(await challenge(), backupCodes[0]!).expect(
      200,
    );
    const { sessionExpiresIn } = verified.body as { sessionExpiresIn: number };

    // La familia que se acaba de emitir: su fila dice la misma caducidad.
    const cookie = verified
      .get('Set-Cookie')!
      .find((c) => /^(__Host-)?refresh=/.test(c))!;
    const token = decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!);
    const { expiresAt } = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: TokenService.hashRefreshToken(token) },
    });
    const left = (expiresAt.getTime() - Date.now()) / 1000;
    expect(Math.abs(sessionExpiresIn - left)).toBeLessThan(5);
    expect(sessionExpiresIn).toBeGreaterThan(0);
  });

  it('AU-005 el mismo código no vale dos veces', async () => {
    const { userId, backupCodes } = await enrol();

    await verify(await challenge(), backupCodes[0]!).expect(200);
    await verify(await challenge(), backupCodes[0]!).expect(401);

    // Y el resto del lote sigue vivo: gastar uno no invalida los demás.
    const live = await prisma.backupCode.count({
      where: { userId, usedAt: null },
    });
    expect(live).toBe(BACKUP_CODE_COUNT - 1);
  });

  it('la sesión de una cuenta CON segundo factor lo dice, al verificarlo y al reanudar', async () => {
    /**
     * LA OTRA MITAD DEL CAMPO. `session-lifecycle.spec.ts` fija el estado «sin
     * matricular» en `login` y `refresh`; aquí se fija el estado contrario, en
     * las dos respuestas de sesión que una cuenta matriculada llega a recibir
     * —`login` le devuelve un reto, no una sesión—.
     *
     * Con los dos escritos, un `mfaEnabled` constante no puede pasar los dos:
     * es lo que impide que `/mi-cuenta` ofrezca la acción que va a fallar.
     */
    const { backupCodes } = await enrol();

    const verified = await verify(await challenge(), backupCodes[0]!).expect(
      200,
    );

    expect((verified.body as { mfaEnabled: boolean }).mfaEnabled).toBe(true);

    const resumed = await request(server())
      .post('/api/v1/auth/refresh')
      .set('Cookie', verified.get('Set-Cookie')!)
      .expect(200);

    expect((resumed.body as { mfaEnabled: boolean }).mfaEnabled).toBe(true);
  });

  it('AU-005 un código inexistente responde lo MISMO que un TOTP incorrecto', async () => {
    // Dos respuestas distintas dirían si la cuenta tiene códigos de respaldo
    // vivos, que es un dato sobre una persona que trabaja aquí.
    await enrol();

    const conCodigo = await verify(await challenge(), 'ZZZZZ-ZZZZZ').expect(401); // prettier-ignore
    const conTotp = await verify(await challenge(), '000000').expect(401);

    // Todo el cuerpo menos lo que es distinto en CUALQUIER par de peticiones:
    // el instante y el identificador de traza. Compararlos enteros solo
    // probaría que dos relojes no coinciden.
    const contrato = ({ body }: { body: unknown }): unknown => {
      const { timestamp, traceId, ...rest } = body as Record<string, unknown>;
      void timestamp;
      void traceId;
      return rest;
    };

    expect(contrato(conCodigo)).toEqual(contrato(conTotp));
    expect(conCodigo.get('Content-Type')).toBe(conTotp.get('Content-Type'));
  });

  it('AU-005 tres códigos de respaldo fallidos bloquean la cuenta igual que tres TOTP', async () => {
    // Si el respaldo no contara para el bloqueo, sería el camino débil: 50
    // bits sin límite de intentos y sin caducar cada treinta segundos.
    const { userId } = await enrol();
    const token = await challenge();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await verify(token, 'ZZZZZ-ZZZZZ').expect(401);
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.failedAttempts).toBe(3);
    expect(user.lockedUntil).not.toBeNull();
    expect(user.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('AU-005 en varias peticiones simultáneas con el MISMO código gana exactamente una', async () => {
    /**
     * EL MISMO PAPEL, VARIAS VECES A LA VEZ, POR EL CAMINO REAL.
     *
     * Se afirma QUIÉN gana en los tres sitios donde se puede afirmar con
     * peticiones idénticas: exactamente UNA respuesta es 200 y trae la sesión
     * de esta cuenta, todas las demás son 401 e indistinguibles de un código
     * incorrecto, y en la base hay exactamente UNA fila gastada. Dos ganadoras
     * —o dos filas gastadas— es el fallo que se busca.
     *
     * ⚠️ ESTA NO ES LA PRUEBA QUE PROTEGE LA RECLAMACIÓN, y conviene saberlo
     * antes de confiar en ella. Se sustituyó `UPDATE … WHERE used_at IS NULL`
     * por un «leer, comprobar, escribir» y SEGUÍA EN VERDE, con dos peticiones
     * y con cinco: cada una gasta un Argon2 antes de llegar a la reclamación,
     * los Argon2 terminan escalonados por más milisegundos de los que dura la
     * ventana, y las peticiones acaban entrando en fila. Lo que esto comprueba
     * es el COMPORTAMIENTO de extremo a extremo —un solo 200, una sola fila
     * gastada, la sesión correcta—; quien tumba la versión defectuosa es la
     * prueba de abajo, que ataca el adaptador sin nada delante que escalone
     * las llegadas.
     */
    const SIMULTANEAS = 5;
    const { userId, backupCodes } = await enrol();
    const token = await challenge();

    const outcomes = await Promise.all(
      Array.from({ length: SIMULTANEAS }, () => verify(token, backupCodes[0]!)),
    );

    const winners = outcomes.filter((outcome) => outcome.status === 200);
    const losers = outcomes.filter((outcome) => outcome.status === 401);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(SIMULTANEAS - 1);
    expect((winners[0]!.body as { user: { email: string } }).user.email).toBe(
      EMAIL,
    );

    const used = await prisma.backupCode.findMany({
      where: { userId, usedAt: { not: null } },
    });
    expect(used).toHaveLength(1);
    expect(
      await prisma.backupCode.count({ where: { userId, usedAt: null } }),
    ).toBe(BACKUP_CODE_COUNT - 1);
  });

  it('AU-005 diez reclamaciones del mismo código en la misma vuelta: gana una sola', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA PRUEBA QUE DE VERDAD DISTINGUE UNA RECLAMACIÓN CONDICIONAL DE UN
     * «LEER, COMPROBAR, ESCRIBIR». LÉASE ANTES DE SIMPLIFICARLA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * La carrera por HTTP de arriba NO lo distingue, y está comprobado: se
     * sustituyó `UPDATE … WHERE used_at IS NULL` por leer la fila, mirar
     * `used_at` y escribir después, y seguía en verde con dos peticiones y con
     * cinco. El motivo es que cada petición gasta un Argon2 antes de llegar
     * aquí, los Argon2 terminan escalonados por más milisegundos de los que
     * dura la ventana, y las peticiones acaban entrando en fila. Una prueba de
     * concurrencia que no falla con la versión defectuosa no prueba nada.
     *
     * Así que la reclamación se ataca donde vive —el adaptador contra
     * PostgreSQL— y sin nada delante que escalone las llegadas: diez llamadas
     * lanzadas en la MISMA vuelta del bucle de eventos. Con la versión
     * defectuosa las diez leen `used_at IS NULL` antes de que ninguna escriba
     * y las diez se creen ganadoras; con la condicional, PostgreSQL serializa
     * por el bloqueo de fila y solo la primera actualiza una fila.
     *
     * Se afirma QUIÉN gana: exactamente una llamada recibe `true`, y la fila
     * queda gastada una sola vez.
     */
    const userId = await createAccount();
    const { id } = await prisma.backupCode.create({
      data: { userId, codeHash: 'no-se-verifica-aqui: se reclama por id' },
      select: { id: true },
    });

    const repository = new PrismaAuthUserRepository(
      prisma as unknown as PrismaService,
    );

    const claims = await Promise.all(
      Array.from({ length: 10 }, () => repository.consumeBackupCode(id)),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      await prisma.backupCode.count({ where: { userId, usedAt: null } }),
    ).toBe(0);

    // Y reclamarlo después, sin competencia, tampoco vale: ya está gastado.
    expect(await repository.consumeBackupCode(id)).toBe(false);
  });

  it('AU-005 dos códigos DISTINTOS a la vez ganan los dos', async () => {
    // El contrapunto de la carrera anterior: la exclusión es por código, no
    // por cuenta. Un candado por usuario también dejaría «exactamente una
    // ganadora» arriba, y aquí se vería que rechaza un código legítimo.
    const { userId, backupCodes } = await enrol();
    const token = await challenge();

    const outcomes = await Promise.all([
      verify(token, backupCodes[0]!),
      verify(token, backupCodes[1]!),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual([200, 200]);
    expect(
      await prisma.backupCode.count({ where: { userId, usedAt: null } }),
    ).toBe(BACKUP_CODE_COUNT - 2);
  });

  it('AU-005 rematricular reemplaza el lote: los códigos viejos dejan de servir', async () => {
    // Se emiten códigos nuevos precisamente cuando los viejos ya no son de
    // fiar. Añadirlos al lote dejaría funcionando los que la persona cree
    // haber revocado.
    const { userId, backupCodes } = await enrol();
    const viejos = [...backupCodes];

    // La rematrícula se hace por el mismo camino que la primera vez, que solo
    // está abierto mientras el factor no esté confirmado.
    await prisma.user.update({
      where: { id: userId },
      data: { mfaEnabledAt: null, mfaSecretEncrypted: null, mfaLastStep: null },
    });
    const { backupCodes: nuevos } = await (async () => {
      const session = (await signIn().expect(200)).body as {
        accessToken: string;
      };
      const enrolment = (
        await request(server())
          .post('/api/v1/auth/mfa/enroll')
          .set('Authorization', `Bearer ${session.accessToken}`)
          .expect(200)
      ).body as { uri: string };

      return (
        await request(server())
          .post('/api/v1/auth/mfa/confirm')
          .set('Authorization', `Bearer ${session.accessToken}`)
          .send({ code: URI.parse(enrolment.uri).generate() })
          .expect(200)
      ).body as { backupCodes: string[] };
    })();

    expect(nuevos).not.toEqual(viejos);
    expect(
      await prisma.backupCode.count({ where: { userId } }),
      'el lote anterior se reemplaza, no se acumula',
    ).toBe(BACKUP_CODE_COUNT);

    await verify(await challenge(), viejos[0]!).expect(401);
    await verify(await challenge(), nuevos[0]!).expect(200);
  });

  it('AU-005 dos confirmaciones a la vez dejan UN solo lote vivo, no dos', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL DOBLE ENVÍO DEL FORMULARIO DE CONFIRMACIÓN, ATACADO DONDE SE DECIDE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Un doble clic —o el reintento del cliente— dentro de la misma ventana de
     * treinta segundos del TOTP llega dos veces con el MISMO código, y ambas
     * lo superan: la confirmación pasa `null` como último paso usado, a
     * diferencia de la verificación. Si la condición «este factor todavía no
     * está habilitado» la evalúa el proceso —leer el usuario, mirar
     * `mfaEnabledAt`, escribir después— las dos peticiones se creen ganadoras,
     * las dos generan lote, y bajo READ COMMITTED ninguna ve los INSERT de la
     * otra: el `deleteMany` de cada una solo alcanza filas anteriores. Quedan
     * VEINTE códigos vivos y dos respuestas 200 con lotes distintos, y la
     * persona apunta diez en un papel sin saber cuál de los dos vale.
     *
     * ⚠️ SE ATACA EL ADAPTADOR Y NO LA RUTA HTTP, por el mismo motivo que la
     * carrera de `consumeBackupCode` de más arriba: cada petición gasta diez
     * Argon2 —uno por código del lote— antes de llegar a la escritura, las
     * llegadas se escalonan por más milisegundos de los que dura la ventana y
     * la versión defectuosa se quedaría en verde. Aquí las dos transacciones
     * salen en la misma vuelta del bucle de eventos.
     *
     * Se afirma QUIÉN gana: exactamente una llamada recibe `true`, y tanto el
     * lote que queda en la base como el paso TOTP registrado son los SUYOS.
     */
    const userId = await createAccount();
    const repository = new PrismaAuthUserRepository(
      prisma as unknown as PrismaService,
    );

    // Dos lotes distinguibles: lo que importa no es solo cuántas filas quedan,
    // sino DE QUIÉN son. Un lote mezclado es tan roto como uno duplicado.
    const lote = (marca: string): string[] =>
      Array.from(
        { length: BACKUP_CODE_COUNT },
        (_, index) => `argon2-de:${marca}-${index}`,
      );
    const primera = { hashes: lote('primera'), step: 111n };
    const segunda = { hashes: lote('segunda'), step: 222n };

    const outcomes = await Promise.all([
      repository.confirmMfaWithBackupCodes(
        userId,
        primera.step,
        primera.hashes,
      ),
      repository.confirmMfaWithBackupCodes(
        userId,
        segunda.step,
        segunda.hashes,
      ),
    ]);

    expect(outcomes.filter(Boolean), 'una sola confirmación gana').toHaveLength(
      1,
    );

    const ganadora = outcomes[0] ? primera : segunda;

    const stored = await prisma.backupCode.findMany({
      where: { userId, usedAt: null },
      select: { codeHash: true },
    });
    expect(stored, 'un solo lote vivo, no dos').toHaveLength(BACKUP_CODE_COUNT);
    expect([...stored.map((row) => row.codeHash)].sort()).toEqual(
      [...ganadora.hashes].sort(),
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.mfaEnabledAt).not.toBeNull();
    // El paso consumido es el de la ganadora: la perdedora no escribió nada.
    expect(user.mfaLastStep).toBe(ganadora.step);
  });

  /**
   * AU-037 — cambiar de teléfono sin perder el acceso.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * QUÉ SE PRUEBA AQUÍ Y NO EN UNA PRUEBA UNITARIA.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Lo que la base garantiza: que al confirmar, el secreto viejo y el lote
   * viejo hayan DESAPARECIDO y el lote nuevo esté completo, en la misma
   * operación. Un doble que devuelve `true` no demuestra ninguna de las tres
   * cosas. Y lo que sólo se ve de extremo a extremo: que la ruta exija sesión
   * completa, que una prueba inválida responda exactamente igual que un TOTP
   * incorrecto, y —la que importa— que una rematrícula ABANDONADA deje el
   * factor viejo funcionando.
   */
  describe('AU-037 cambio del segundo factor por su propio titular', () => {
    const startChange = (token: string, code: string) =>
      request(server())
        .post('/api/v1/auth/mfa/change')
        .set('Authorization', `Bearer ${token}`)
        .send({ code });

    const confirmChange = (token: string, code: string) =>
      request(server())
        .post('/api/v1/auth/mfa/change/confirm')
        .set('Authorization', `Bearer ${token}`)
        .send({ code });

    /** Empieza el cambio con el TOTP del factor actual y devuelve el nuevo. */
    async function startWithTotp(account: EnrolledAccount): Promise<string> {
      const response = await startChange(
        account.accessToken,
        totpFor(account.uri, NEXT_STEP),
      ).expect(200);
      return (response.body as { uri: string }).uri;
    }

    it('AU-037 sustituye el secreto y entrega un lote de códigos nuevo', async () => {
      const account = await enrol();
      const nuevoUri = await startWithTotp(account);

      const { backupCodes: nuevos } = (
        await confirmChange(account.accessToken, totpFor(nuevoUri)).expect(200)
      ).body as { backupCodes: string[] };

      expect(nuevos).toHaveLength(BACKUP_CODE_COUNT);
      expect(nuevos).not.toEqual(account.backupCodes);

      // El teléfono viejo ya no abre nada; el nuevo sí. Es la prueba de que el
      // secreto se SUSTITUYÓ y no de que se añadió otro.
      await verify(await challenge(), totpFor(account.uri, NEXT_STEP)).expect(401); // prettier-ignore
      await verify(await challenge(), totpFor(nuevoUri, NEXT_STEP)).expect(200);
    });

    it('AU-037 al confirmar, el secreto viejo y el lote viejo han desaparecido', async () => {
      // LO QUE GARANTIZA LA BASE, COMPROBADO CONTRA LA BASE. Las tres cosas en
      // la misma operación: secreto sustituido, pendiente vaciado y lote
      // reemplazado —no acumulado—.
      const account = await enrol();
      const antes = await prisma.user.findUniqueOrThrow({
        where: { id: account.userId },
      });
      const hashesViejos = (
        await prisma.backupCode.findMany({ where: { userId: account.userId } })
      ).map((row) => row.codeHash);

      const nuevoUri = await startWithTotp(account);
      await confirmChange(account.accessToken, totpFor(nuevoUri)).expect(200);

      const despues = await prisma.user.findUniqueOrThrow({
        where: { id: account.userId },
      });
      expect(despues.mfaSecretEncrypted).not.toBe(antes.mfaSecretEncrypted);
      expect(despues.mfaSecretEncrypted).not.toBeNull();
      // El pendiente se vacía en la MISMA sentencia que instala el secreto:
      // dejarlo lleno permitiría confirmarlo una segunda vez.
      expect(despues.mfaPendingSecretEncrypted).toBeNull();
      expect(despues.mfaEnabledAt).not.toBeNull();

      const vivos = await prisma.backupCode.findMany({
        where: { userId: account.userId },
      });
      expect(vivos, 'el lote se reemplaza, no se acumula').toHaveLength(
        BACKUP_CODE_COUNT,
      );
      for (const row of vivos) {
        expect(hashesViejos).not.toContain(row.codeHash);
        expect(row.usedAt).toBeNull();
      }
    });

    it('AU-037 una rematrícula abandonada deja el factor viejo funcionando', async () => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * LA INVARIANTE DE LA ENTREGA. LÉASE ANTES DE TOCAR `startChange`.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Se cierra la pestaña entre el QR y la confirmación, o falla el
       * escaneo. Si empezar el cambio hubiera retirado el secreto en uso —que
       * es lo que hace `savePendingMfaSecret`, el camino de la primera
       * matrícula— la persona se quedaría sin ningún segundo factor y sin
       * sesión con la que arreglarlo. Es el mismo fallo que la revisión
       * adversarial encontró en AU-005 con la respuesta perdida.
       *
       * Se comprueba por los dos lados: la fila no ha cambiado, y el factor
       * viejo SIGUE ABRIENDO SESIÓN.
       */
      const account = await enrol();
      const antes = await prisma.user.findUniqueOrThrow({
        where: { id: account.userId },
      });
      const hashesAntes = (
        await prisma.backupCode.findMany({ where: { userId: account.userId } })
      ).map((row) => row.codeHash);

      /**
       * Se empieza y NO se confirma. La prueba se presenta con un código de
       * respaldo y no con el TOTP a propósito: gastar un paso TOTP deja
       * `mfa_last_step` en el escalón siguiente y ningún código del teléfono
       * viejo sería aceptable hasta pasados treinta segundos —que es la
       * protección contra repetición haciendo su trabajo, no un fallo—, así
       * que la mitad interesante de esta prueba no podría comprobarse.
       */
      await startChange(account.accessToken, account.backupCodes[0]!).expect(
        200,
      );

      const despues = await prisma.user.findUniqueOrThrow({
        where: { id: account.userId },
      });
      expect(despues.mfaSecretEncrypted).toBe(antes.mfaSecretEncrypted);
      expect(despues.mfaEnabledAt).toEqual(antes.mfaEnabledAt);
      expect(despues.mfaPendingSecretEncrypted).not.toBeNull();

      const vivos = await prisma.backupCode.findMany({
        where: { userId: account.userId, usedAt: null },
      });
      expect(
        vivos,
        'sigue vivo el lote VIEJO menos el que se gastó como prueba: no se emitió ninguno nuevo',
      ).toHaveLength(BACKUP_CODE_COUNT - 1);
      for (const row of vivos) expect(hashesAntes).toContain(row.codeHash);

      // Y lo que de verdad importa: la persona sigue pudiendo entrar, con el
      // teléfono viejo y con el papel viejo.
      await verify(await challenge(), account.backupCodes[1]!).expect(200);
      await verify(await challenge(), totpFor(account.uri, NEXT_STEP)).expect(200); // prettier-ignore
    });

    it('AU-037 el código de respaldo presentado como prueba se gasta', async () => {
      // Como cualquier otro uso de uno: si sobreviviera, el papel seguiría
      // abriendo la cuenta después de haberlo usado para cambiar de teléfono.
      const account = await enrol();

      await startChange(account.accessToken, account.backupCodes[0]!).expect(
        200,
      );

      expect(
        await prisma.backupCode.count({
          where: { userId: account.userId, usedAt: null },
        }),
      ).toBe(BACKUP_CODE_COUNT - 1);
      // Y no vale una segunda vez, ni siquiera para lo mismo.
      await startChange(account.accessToken, account.backupCodes[0]!).expect(
        401,
      );
    });

    it('AU-037 un código inválido no empieza el cambio y cuenta para el bloqueo', async () => {
      // Sin esto, la ruta sería una segunda puerta a adivinar el segundo
      // factor, sin límite de intentos y con sesión completa detrás.
      const account = await enrol();

      for (let intento = 0; intento < 3; intento += 1) {
        await startChange(account.accessToken, '000000').expect(401);
      }

      const user = await prisma.user.findUniqueOrThrow({
        where: { id: account.userId },
      });
      expect(user.failedAttempts).toBe(3);
      expect(user.lockedUntil).not.toBeNull();
      expect(user.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
      // Y nada quedó empezado: no hay secreto pendiente que confirmar.
      expect(user.mfaPendingSecretEncrypted).toBeNull();
    });

    it('AU-037 una prueba inválida responde lo MISMO que un TOTP incorrecto', async () => {
      // Dos respuestas distintas dirían si la cuenta tiene códigos de respaldo
      // vivos, exactamente igual que en AU-005 — y aquí quien pregunta puede
      // ser quien se encontró un portátil desbloqueado.
      const account = await enrol();

      const conCodigo = await startChange(account.accessToken, 'ZZZZZ-ZZZZZ').expect(401); // prettier-ignore
      const conTotp = await startChange(account.accessToken, '000000').expect(401); // prettier-ignore

      const contrato = ({ body }: { body: unknown }): unknown => {
        const { timestamp, traceId, ...rest } = body as Record<string, unknown>;
        void timestamp;
        void traceId;
        return rest;
      };

      expect(contrato(conCodigo)).toEqual(contrato(conTotp));
      expect(conCodigo.get('Content-Type')).toBe(conTotp.get('Content-Type'));
    });

    it('AU-037 NO cierra las sesiones abiertas', async () => {
      // A diferencia de AU-035 y del cambio de contraseña. No hay nadie de
      // quien desconfiar: la persona acaba de demostrar que es ella.
      const account = await enrol();
      const vivasAntes = await prisma.refreshToken.count({
        where: { userId: account.userId, revokedAt: null },
      });
      expect(vivasAntes).toBeGreaterThan(0);

      const nuevoUri = await startWithTotp(account);
      await confirmChange(account.accessToken, totpFor(nuevoUri)).expect(200);

      expect(
        await prisma.refreshToken.count({
          where: { userId: account.userId, revokedAt: null },
        }),
      ).toBe(vivasAntes);
    });

    it('AU-037 confirmar un cambio que nadie empezó responde 409 MFA_CHANGE_NOT_STARTED', async () => {
      const account = await enrol();

      const response = await confirmChange(
        account.accessToken,
        '123456',
      ).expect(409);

      const problem = response.body as { code: string; title: string };
      expect(problem.code).toBe('MFA_CHANGE_NOT_STARTED');
      expect(problem.title).toBe(
        'No hay ningún cambio de segundo factor a medias. Empiece de nuevo y escanee el código otra vez',
      );
      expect(response.get('Content-Type')).toContain(
        'application/problem+json',
      );
    });

    it('AU-037 una sesión a medio autenticar no llega a cambiar nada', async () => {
      // `mfa/enroll` y `mfa/confirm` sí son alcanzables con este token —tienen
      // que serlo—, y ésta no: exige haber completado el segundo factor.
      const account = await enrol();
      const medioAutenticada = await challenge();

      const response = await startChange(
        medioAutenticada,
        totpFor(account.uri, NEXT_STEP),
      ).expect(401);

      expect((response.body as { code: string }).code).toBe('MFA_REQUIRED');
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: account.userId } }))
          .mfaPendingSecretEncrypted,
      ).toBeNull();
    });

    it('AU-037 dos confirmaciones a la vez dejan UN solo lote y UN solo secreto', async () => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * LA RECLAMACIÓN QUE SUSTITUYE A `mfa_enabled_at IS NULL`.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * La de AU-005 no sirve aquí: la cuenta SÍ está matriculada, así que esa
       * condición la cumplen las dos peticiones y no arbitra nada. La
       * sustituye reclamar el secreto pendiente EXACTO, evaluado por
       * PostgreSQL en la misma sentencia que escribe.
       *
       * ⚠️ SE ATACA EL ADAPTADOR Y NO LA RUTA, por el motivo ya comprobado más
       * arriba: cada petición gasta diez Argon2 antes de llegar a la
       * escritura, las llegadas se escalonan y una versión defectuosa se
       * quedaría en verde. Aquí las dos transacciones salen en la misma vuelta
       * del bucle de eventos.
       *
       * Se afirma QUIÉN gana: exactamente una recibe `true`, y el secreto y el
       * lote que quedan son los SUYOS.
       */
      const userId = await createAccount();
      const repository = new PrismaAuthUserRepository(
        prisma as unknown as PrismaService,
      );
      await prisma.user.update({
        where: { id: userId },
        data: {
          mfaSecretEncrypted: 'el-secreto-viejo',
          mfaEnabledAt: new Date(),
          mfaPendingSecretEncrypted: 'el-secreto-pendiente',
        },
      });
      await prisma.backupCode.createMany({
        data: Array.from({ length: BACKUP_CODE_COUNT }, (_, index) => ({
          userId,
          codeHash: `argon2-del-lote-viejo-${index}`,
        })),
      });

      const lote = (marca: string): string[] =>
        Array.from(
          { length: BACKUP_CODE_COUNT },
          (_, index) => `argon2-de:${marca}-${index}`,
        );
      const primera = { hashes: lote('primera'), step: 111n };
      const segunda = { hashes: lote('segunda'), step: 222n };

      const outcomes = await Promise.all([
        repository.replaceMfaSecretWithBackupCodes(
          userId,
          'el-secreto-pendiente',
          primera.step,
          primera.hashes,
        ),
        repository.replaceMfaSecretWithBackupCodes(
          userId,
          'el-secreto-pendiente',
          segunda.step,
          segunda.hashes,
        ),
      ]);

      expect(
        outcomes.filter(Boolean),
        'una sola sustitución gana',
      ).toHaveLength(1);
      const ganadora = outcomes[0] ? primera : segunda;

      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } }); // prettier-ignore
      expect(user.mfaSecretEncrypted).toBe('el-secreto-pendiente');
      expect(user.mfaPendingSecretEncrypted).toBeNull();
      expect(user.mfaLastStep).toBe(ganadora.step);

      const stored = await prisma.backupCode.findMany({
        where: { userId },
        select: { codeHash: true },
      });
      expect(stored, 'un solo lote vivo, no dos').toHaveLength(
        BACKUP_CODE_COUNT,
      );
      expect([...stored.map((row) => row.codeHash)].sort()).toEqual(
        [...ganadora.hashes].sort(),
      );
    });

    it('AU-037 una confirmación de un cambio abandonado no instala su secreto', async () => {
      // Si la reclamación fuera «hay ALGO pendiente» en vez de «está esto
      // exactamente», empezar el cambio dos veces dejaría que la confirmación
      // del primero instalase el secreto del segundo: un factor cuyo QR esa
      // persona quizá nunca escaneó, que es un bloqueo causado por nosotros.
      const userId = await createAccount();
      const repository = new PrismaAuthUserRepository(
        prisma as unknown as PrismaService,
      );
      await prisma.user.update({
        where: { id: userId },
        data: {
          mfaSecretEncrypted: 'el-secreto-viejo',
          mfaEnabledAt: new Date(),
          // El cambio se empezó una segunda vez: el pendiente es el segundo.
          mfaPendingSecretEncrypted: 'el-segundo-pendiente',
        },
      });

      const reclamado = await repository.replaceMfaSecretWithBackupCodes(
        userId,
        'el-primer-pendiente-abandonado',
        7n,
        ['argon2-de:lo-que-sea'],
      );

      expect(reclamado).toBe(false);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } }); // prettier-ignore
      expect(user.mfaSecretEncrypted).toBe('el-secreto-viejo');
      expect(user.mfaPendingSecretEncrypted).toBe('el-segundo-pendiente');
      expect(await prisma.backupCode.count({ where: { userId } })).toBe(0);
    });
  });

  /**
   * AU-041 por el camino del segundo factor. Entre la contraseña y el código
   * pueden pasar minutos, y el desafío no tiene fila que revocar: lleva la
   * época leída con la contraseña, y completar el código la compara. Sin eso,
   * una cuenta dada de baja con el desafío en la mano obtenía una sesión
   * completa con su propio teléfono (revisión en contexto limpio, 30-09-2026).
   */
  describe('AU-041 cerrar todas las sesiones anula el desafío del segundo factor', () => {
    const liveSessions = (userId: string) =>
      prisma.refreshToken.count({
        where: { userId, revokedAt: null, usedAt: null },
      });

    it('AU-041 una cuenta desactivada después del desafío no completa el segundo factor', async () => {
      const account = await enrol();
      const pending = await challenge();

      // Lo que hace desactivarla (AU-023): la cuenta inactiva y todas sus
      // sesiones cerradas.
      await prisma.user.update({
        where: { id: account.userId },
        data: { active: false },
      });
      await app
        .get(RefreshTokenService)
        .revokeAllForUser(account.userId, 'ACCOUNT_DEACTIVATED');

      await verify(pending, totpFor(account.uri, NEXT_STEP)).expect(401);
      expect(await liveSessions(account.userId)).toBe(0);
    });

    it('AU-041 una cuenta inactiva no completa el segundo factor aunque nadie cerrara sus sesiones', async () => {
      // Sólo `active = false`, sin revocar: la época no cambia, así que lo
      // que rechaza es el estado de la cuenta.
      const account = await enrol();
      const pending = await challenge();
      await prisma.user.update({
        where: { id: account.userId },
        data: { active: false },
      });

      await verify(pending, totpFor(account.uri, NEXT_STEP)).expect(401);
      expect(await liveSessions(account.userId)).toBe(1);
    });

    it('AU-041 un desafío sin época no completa el segundo factor', async () => {
      const account = await enrol();
      const withoutEpoch = await app.get(TokenService).issueAccessToken({
        sub: account.userId,
        fam: MFA_CHALLENGE_FAMILY,
        grants: [],
        mfa: false,
      });

      await verify(withoutEpoch, totpFor(account.uri, NEXT_STEP)).expect(401);
      expect(await liveSessions(account.userId)).toBe(1);
    });

    it('AU-041 un desafío anterior a un reinicio del segundo factor no abre la matrícula', async () => {
      /**
       * Con la contraseña y sin el teléfono se consigue un desafío. Si soporte
       * reinicia el segundo factor (AU-036), la cuenta queda sin matricular y
       * `mfa/enroll` aceptaría: el dueño del desafío viejo instalaría SU
       * autenticador. El guardia compara la época del desafío.
       */
      const account = await enrol();
      const pending = await challenge();
      await app
        .get(PrismaAccountAdminRepository)
        .resetMfa(account.userId, 'MFA_RESET', { userId: account.userId });

      await request(server())
        .post('/api/v1/auth/mfa/enroll')
        .set('Authorization', `Bearer ${pending}`)
        .expect(401);
    });

    it('AU-041 control: el mismo desafío sin reinicio sí llega a la matrícula (que responde que ya hay factor)', async () => {
      const account = await enrol();
      const pending = await challenge();

      const answered = await request(server())
        .post('/api/v1/auth/mfa/enroll')
        .set('Authorization', `Bearer ${pending}`)
        .expect(409);
      expect(answered.body).toMatchObject({ code: 'MFA_ALREADY_ENROLLED' });
      expect(account.userId).toBeDefined();
    });

    it('AU-041 un cambio de contraseña después del desafío lo anula', async () => {
      const account = await enrol();
      const pending = await challenge();

      const { passwordHash } = await prisma.user.findUniqueOrThrow({
        where: { id: account.userId },
      });
      await app
        .get(PrismaAuthUserRepository)
        .rotateCredentials(account.userId, passwordHash, 'PASSWORD_CHANGE');

      await verify(pending, totpFor(account.uri, NEXT_STEP)).expect(401);
      expect(await liveSessions(account.userId)).toBe(0);
    });

    it('AU-041 control: sin cierre de por medio, el mismo desafío completa la sesión', async () => {
      const account = await enrol();
      const pending = await challenge();

      await verify(pending, totpFor(account.uri, NEXT_STEP)).expect(200);
      expect(await liveSessions(account.userId)).toBe(2);
    });
  });
});
