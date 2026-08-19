import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { seedRdacaa } from '../../prisma/seed-rdacaa.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * El catálogo por HTTP, tal y como lo consume el navegador.
 *
 * QUÉ AÑADE SOBRE `catalog-search.spec.ts`, que ya prueba las consultas: todo
 * lo que hay ENTRE el navegador y el repositorio y que ninguna prueba tocaba —
 * la validación de los parámetros, la traducción de un código inexistente a un
 * problema RFC 9457, el permiso, y la forma exacta del cuerpo de la respuesta.
 *
 * Es la capa donde ya se perdió un contrato una vez: `POST /auth/refresh`
 * devolvía un token sin identidad y todas las pruebas unitarias pasaban porque
 * ninguna preguntaba qué contesta el endpoint. Aquí se pregunta.
 */
const PASSWORD = 'el caballo come alfalfa';

interface ConceptoCuerpo {
  id: string;
  code: string;
  display: string;
  chapter: string | null;
  chapterDisplay: string | null;
  level: number;
  selectable: boolean;
}

describe('catálogos por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  let token: string;

  beforeAll(async () => {
    enableBigIntSerialisation();
    prisma = db();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      /**
       * Sin límite de peticiones AQUÍ, y sólo aquí.
       *
       * El límite real es de cinco por segundo y este fichero hace una decena
       * seguidas: sin esto media suite falla con 429 y ninguna de esas pruebas
       * dice nada sobre el catálogo. Lo que se prueba aquí es qué contesta el
       * endpoint, no cuántas veces deja preguntarlo.
       *
       * SE SUSTITUYE EL ALMACÉN, NO EL GUARD. `overrideGuard(ThrottlerGuard)`
       * no hace nada: el guard está registrado con el token `APP_GUARD`, así
       * que su propia clase no es un proveedor que sustituir —lo intenté y las
       * pruebas seguían recibiendo 429—. Y sustituir `APP_GUARD` tumbaría
       * también el guard de autorización, que es justo lo que estas pruebas
       * comprueban. El almacén sí es un proveedor con nombre propio, y un
       * contador que siempre devuelve uno deja pasar todo sin tocar nada más.
       */
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
  });

  /**
   * Se siembra ANTES DE CADA PRUEBA, no una vez.
   *
   * `useDatabase` trunca todas las tablas después de cada prueba —es su forma
   * de aislarlas— así que sembrar en `beforeAll` deja la primera prueba con
   * datos y todas las demás con una base vacía. Sale como listas vacías y
   * códigos que «no existen», que parece un fallo de la consulta y no lo es.
   */
  beforeEach(async () => {
    await sembrarCatalogo();
    token = await iniciarSesion();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  /**
   * Un trozo de CIE-10 con lo que de verdad falla.
   *
   * Un capítulo que NO es diagnosticable, una categoría que sí, y una
   * descripción con tilde que se teclea sin ella.
   */
  async function sembrarCatalogo(): Promise<void> {
    const desde = new Date('2010-01-01T00:00:00Z');
    const sistema = await prisma.catalogSystem.create({
      data: {
        code: 'CIE10',
        name: 'Clasificación Internacional de Enfermedades',
        hierarchical: true,
      },
    });

    const capitulo = await prisma.catalogConcept.create({
      data: {
        systemId: sistema.id,
        code: 'J00-J99',
        display: 'Enfermedades del sistema respiratorio',
        validFrom: desde,
        attributes: { level: 0, chapter: 'J00-J99' },
      },
    });

    await prisma.catalogConcept.create({
      data: {
        systemId: sistema.id,
        code: 'J18.9',
        display: 'Neumonía, no especificada',
        parentId: capitulo.id,
        validFrom: desde,
        attributes: { level: 3, chapter: 'J00-J99' },
      },
    });

    /**
     * Y LOS CATÁLOGOS PLANOS DEL RDACAA, CON SU SEMBRADOR DE VERDAD.
     *
     * `ETHNICITY`, `NATIONALITY` y `GENDER_IDENTITY` son listas sin capítulos:
     * sus conceptos están en el nivel 0 y son exactamente lo que se elige. Se
     * sembraban aquí a mano mientras qué lista cargar era una decisión
     * pendiente; resuelta D-034 se llama al sembrador, así que lo que estas
     * pruebas recorren es la lista que sirve la aplicación y no una imitación
     * de tres filas que puede diferir de ella sin que nadie lo note.
     */
    await seedRdacaa(prisma);
  }

  async function iniciarSesion(): Promise<string> {
    await syncAuthorisation(prisma);

    /**
     * La caché de roles se tira DESPUÉS de recrearlos.
     *
     * `RolePermissionRegistry` guarda rol→permisos unos segundos, indexado por
     * el id del rol. Al truncar entre pruebas los roles se recrean con ids
     * NUEVOS, así que la caché de la prueba anterior no reconoce ninguno y
     * todas las peticiones responden 403 «Missing permission catalog:read» —
     * con el permiso perfectamente asignado en la base. La primera prueba pasa,
     * las demás no, que es la firma de este fallo.
     */
    registry.invalidate();

    const user = await prisma.user.create({
      data: {
        email: 'ana.torres@clinica.ec',
        firstName: 'Ana',
        lastName: 'Torres',
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

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ana.torres@clinica.ec', password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  const buscar = (consulta: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/catalogs/CIE10${consulta}`)
      .set('Authorization', `Bearer ${token}`);

  it('exige sesión', async () => {
    // Un catálogo no contiene datos de paciente, pero sin autenticación sería
    // un endpoint abierto con el que medir la instalación desde fuera.
    await request(app.getHttpServer())
      .get('/api/v1/catalogs/CIE10?q=neumonia')
      .expect(401);
  });

  it('encuentra una descripción tecleada con errata y sin tilde', async () => {
    // EL CAMINO COMPLETO, que es lo que ninguna otra prueba recorría: parámetro
    // de consulta → validación → similitud trigram → cuerpo de la respuesta.
    const response = await buscar('?q=nuemonia').expect(200);
    const { items } = response.body as { items: ConceptoCuerpo[] };

    expect(items.map((c) => c.code)).toContain('J18.9');
    expect(items[0]).toMatchObject({
      display: 'Neumonía, no especificada',
      chapter: 'J00-J99',
      selectable: true,
    });
  });

  it('el capítulo viaja con su nombre, no sólo con su código', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * ADR-005 §5. `J00-J99` NO DESAMBIGUA NADA PARA NADIE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El capítulo existe en el contrato «para desambiguar dos textos
     * parecidos», y un rango de códigos que quien lo lee no puede interpretar
     * no es información: es ruido con aspecto de dato. En la CIE-10 el código
     * SÍ se maneja —quien diagnostica lo dicta y lo teclea—, así que no se
     * esconde: se le pone el nombre al lado. Los dos viajan.
     */
    const response = await buscar('?q=nuemonia').expect(200);
    const { items } = response.body as { items: ConceptoCuerpo[] };

    expect(items[0]).toMatchObject({
      chapter: 'J00-J99',
      chapterDisplay: 'Enfermedades del sistema respiratorio',
    });
  });

  it('un catálogo sin capítulos no inventa un nombre de capítulo', async () => {
    // Etnia es una lista plana: no hay agrupador, y `null` en los dos campos
    // es la respuesta correcta — no una cadena vacía que la pantalla pintaría.
    const response = await request(app.getHttpServer())
      .get('/api/v1/catalogs/ETHNICITY?q=montubio')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const { items } = response.body as { items: ConceptoCuerpo[] };
    expect(items[0]).toMatchObject({ chapter: null, chapterDisplay: null });
  });

  it('no ofrece capítulos como diagnóstico, salvo si se piden', async () => {
    const codigos = async (consulta: string) =>
      (
        (await buscar(consulta).expect(200)).body as {
          items: ConceptoCuerpo[];
        }
      ).items.map((c) => c.code);

    // Omitido.
    expect(await codigos('?q=respiratori')).not.toContain('J00-J99');

    /**
     * Y PEDIDO EXPLÍCITAMENTE EN `false`, que es el caso que faltaba y el que
     * estaba roto. El esquema usaba `z.coerce.boolean()`, y `Boolean('false')`
     * es `true` porque la cadena no está vacía: la bandera NO SE PODÍA APAGAR.
     * La interfaz manda `includeGroups=false` en cada pulsación, así que la
     * caja de diagnóstico venía ofreciendo capítulos y grupos —`A00-B99` es un
     * título, no una enfermedad— que es exactamente el dato que el RDACAA
     * rechaza. Las dos ramas de arriba pasaban igual, y por eso duró.
     */
    expect(await codigos('?q=respiratori&includeGroups=false')).not.toContain(
      'J00-J99',
    );

    expect(await codigos('?q=respiratori&includeGroups=true')).toContain(
      'J00-J99',
    );
  });

  it('un catálogo PLANO devuelve resultados en vez de una lista vacía', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL DEFECTO QUE NO FALLA: UN SELECTOR VACÍO QUE PARECE FALTA DE SIEMBRA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `onlySelectable` está en `true` por defecto —quien busca en una caja de
     * diagnóstico no quiere títulos de capítulo— y antes de P2 filtraba por
     * profundidad SIN mirar si el sistema es jerárquico. Etnia, nacionalidad e
     * identidad de género son listas planas de nivel 0, así que
     * `/catalogs/ETHNICITY` devolvía la lista vacía SIEMPRE y con 200. Es la
     * rama que el cambio de `selectable` añadió, y ninguna prueba la ejercía.
     */
    const response = await request(app.getHttpServer())
      .get('/api/v1/catalogs/ETHNICITY?q=montubio')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const { items } = response.body as { items: ConceptoCuerpo[] };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      // El código del INEC, que es el que se reporta; el nombre es lo que se
      // lee. Ver `seed-rdacaa.mts`.
      code: '5',
      display: 'Montubio/a',
      selectable: true,
    });
  });

  it('rechaza una bandera que no es ni `true` ni `false`, en vez de adivinar', async () => {
    // Adivinar es como se llegó al defecto de arriba.
    await buscar('?q=respiratori&includeGroups=1').expect(422);
  });

  it('rechaza una búsqueda demasiado corta con un problema, no con una lista vacía', async () => {
    const response = await buscar('?q=a').expect(422);
    // RFC 9457: el frontend distingue por `type`, no por el texto.
    expect(response.body).toMatchObject({ type: expect.any(String) });
  });

  it('rechaza un catálogo que no existe', async () => {
    // Sin la lista cerrada esto devolvería 200 y cero resultados, que es
    // indistinguible de un catálogo sin datos.
    await request(app.getHttpServer())
      .get('/api/v1/catalogs/INVENTADO?q=neumonia')
      .set('Authorization', `Bearer ${token}`)
      .expect(422);
  });

  it('resuelve un código con su cadena de ancestros', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/catalogs/CIE10/J189')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const cuerpo = response.body as ConceptoCuerpo & {
      ancestors: ConceptoCuerpo[];
    };
    // Se pidió sin punto y responde con punto: es como se imprime.
    expect(cuerpo.code).toBe('J18.9');
    expect(cuerpo.ancestors.map((a) => a.code)).toEqual(['J00-J99']);
  });

  it('distingue un código inexistente de uno fuera de vigencia', async () => {
    /**
     * LAS DOS RAMAS, no sólo la primera. Este título prometía una distinción y
     * únicamente comprobaba el 404, así que la otra mitad pudo estar rota
     * desde el principio sin que nada fallara — y lo estaba: la comprobación
     * de «¿existió alguna vez?» preguntaba por el año 1900, en el que ningún
     * concepto está vigente, de modo que un código retirado respondía «no
     * existe».
     *
     * La diferencia no es cosmética. Sobre una historia de hace tres años, un
     * 404 dice que el diagnóstico registrado es basura; el 422 dice que el
     * código existió, que la historia es válida, y que hay que elegir otro
     * para lo que se escriba HOY.
     */
    const inexistente = await request(app.getHttpServer())
      .get('/api/v1/catalogs/CIE10/Z999')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect((inexistente.body as { code: string }).code).toBe(
      'CATALOG_CONCEPT_NOT_FOUND',
    );

    const retirado = await prisma.catalogConcept.findFirstOrThrow({
      where: { code: 'J18.9' },
    });
    await prisma.catalogConcept.update({
      where: { id: retirado.id },
      data: { validTo: new Date('2015-01-01T00:00:00Z') },
    });

    const fueraDeVigencia = await request(app.getHttpServer())
      .get('/api/v1/catalogs/CIE10/J189')
      .set('Authorization', `Bearer ${token}`)
      .expect(422);
    expect((fueraDeVigencia.body as { code: string }).code).toBe(
      'CATALOG_CONCEPT_NOT_IN_FORCE',
    );
  });

  it('rechaza una fecha de vigencia mal escrita', async () => {
    // `on` llegaba antes como texto suelto sin validar, y de ahí a un
    // `new Date()` que producía una fecha inválida en la consulta.
    await buscar('?q=neumonia&on=ayer').expect(422);
  });

  /**
   * Resolver por id lo que ya está guardado.
   *
   * Nace de una carencia concreta: `site.parish_concept_id` guarda una
   * parroquia del DPA y la pantalla de la sede sólo podía decir «Registrada»,
   * porque no existía forma de preguntar CUÁL.
   */
  describe('un concepto por su id', () => {
    const porId = (id: string) =>
      request(app.getHttpServer())
        .get(`/api/v1/catalogs/concepts/${id}`)
        .set('Authorization', `Bearer ${token}`);

    async function idDe(code: string): Promise<string> {
      const concepto = await prisma.catalogConcept.findFirstOrThrow({
        where: { code },
      });
      return concepto.id;
    }

    it('resuelve el concepto con su cadena de ancestros', async () => {
      const response = await porId(await idDe('J18.9')).expect(200);

      const cuerpo = response.body as ConceptoCuerpo & {
        ancestors: ConceptoCuerpo[];
      };
      expect(cuerpo.code).toBe('J18.9');
      expect(cuerpo.display).toBe('Neumonía, no especificada');
      expect(cuerpo.ancestors.map((a) => a.code)).toEqual(['J00-J99']);
    });

    /**
     * ESTA ES LA RAZÓN DE QUE NO PASE POR `resolveDiagnosis`.
     *
     * Una parroquia retirada del DPA —o un código de la CIE-10 sustituido—
     * sigue estando en la columna de una fila que nadie ha tocado. Si la
     * consulta exigiera vigencia, la dirección de una sede que no se ha movido
     * se quedaría en blanco el día que el INEC reorganiza las parroquias.
     */
    it('resuelve también un concepto que ya no está vigente', async () => {
      const retirado = await prisma.catalogConcept.findFirstOrThrow({
        where: { code: 'J18.9' },
      });
      await prisma.catalogConcept.update({
        where: { id: retirado.id },
        data: { validTo: new Date('2015-01-01T00:00:00Z') },
      });

      // Por código, con la fecha de hoy, ya no se puede registrar.
      const porCodigo = await request(app.getHttpServer())
        .get('/api/v1/catalogs/CIE10/J189')
        .set('Authorization', `Bearer ${token}`)
        .expect(422);
      expect((porCodigo.body as { code: string }).code).toBe(
        'CATALOG_CONCEPT_NOT_IN_FORCE',
      );

      // Por id sigue teniendo nombre, que es lo único que se preguntaba.
      const response = await porId(retirado.id).expect(200);
      expect((response.body as ConceptoCuerpo).code).toBe('J18.9');
    });

    /**
     * Y TAMPOCO EXIGE QUE SEA DIAGNOSTICABLE. Un capítulo es una referencia
     * perfectamente válida para una columna que no es un diagnóstico —una
     * provincia del DPA es exactamente eso—, y `resolveDiagnosis` lo rechaza
     * con `CATALOG_CONCEPT_NOT_SELECTABLE`.
     */
    it('resuelve un concepto que no es diagnosticable', async () => {
      const response = await porId(await idDe('J00-J99')).expect(200);

      const cuerpo = response.body as ConceptoCuerpo;
      expect(cuerpo.selectable).toBe(false);
      expect(cuerpo.display).toBe('Enfermedades del sistema respiratorio');
    });

    it('responde 404 con CATALOG_CONCEPT_NOT_FOUND a un id que no existe', async () => {
      const response = await porId(
        '01920000-0000-7000-8000-000000000000',
      ).expect(404);

      expect((response.body as { code: string }).code).toBe(
        'CATALOG_CONCEPT_NOT_FOUND',
      );
    });

    it('rechaza un id que no es un uuid en vez de llevarlo a la consulta', async () => {
      // Sin `ParseUUIDPipe` el texto llega al `::uuid` de la consulta y sale
      // como error de la base: un 500 por lo que es un error del cliente. 400
      // y no 422 porque es lo que responde el pipe de NestJS, igual que en el
      // resto de rutas que reciben un id en la URL.
      await porId('J18.9').expect(400);
    });

    it('exige sesión, como el resto del catálogo', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/catalogs/concepts/${await idDe('J18.9')}`)
        .expect(401);
    });

    /**
     * EL ORDEN DE DECLARACIÓN ES LA GARANTÍA, y esta prueba es lo que lo
     * sostiene. `/catalogs/concepts/<uuid>` encaja también en `:system/:code`;
     * si alguien mueve este método por debajo de `byCode`, `concepts` llega
     * como sistema, falla contra la lista cerrada y la ruta responde 422 sin
     * ejecutarse nunca. Sin esta prueba el fallo sería un 422 desconcertante
     * en la pantalla de sedes, meses después y lejos del cambio que lo causó.
     */
    it('no confunde «concepts» con el nombre de un catálogo', async () => {
      const response = await porId(await idDe('J18.9')).expect(200);

      // Un 422 aquí significa exactamente eso: `:system/:code` ganó la ruta.
      expect(response.status).not.toBe(422);
    });
  });

  /**
   * Recorrer el árbol, que es el camino que faltaba.
   *
   * `GET /catalogs/{system}` exige dos caracteres y devuelve como mucho 50
   * filas sin decir cuántas hay: sobre 1401 parroquias, quien teclea «SANTA»
   * recibe un puñado y no tiene forma de llegar al resto. Estas dos rutas son
   * el otro camino —provincia → cantón → parroquia— y no dependen de acertar
   * con el texto.
   */
  describe('el árbol por niveles', () => {
    interface PaginaCuerpo {
      items: ConceptoCuerpo[];
      total: number;
      page: number;
      pageSize: number;
    }

    const raices = (sistema: string, consulta = '') =>
      request(app.getHttpServer())
        .get(`/api/v1/catalogs/${sistema}/roots${consulta}`)
        .set('Authorization', `Bearer ${token}`);

    const hijos = (id: string, consulta = '') =>
      request(app.getHttpServer())
        .get(`/api/v1/catalogs/concepts/${id}/children${consulta}`)
        .set('Authorization', `Bearer ${token}`);

    async function idDeCodigo(code: string): Promise<string> {
      const concepto = await prisma.catalogConcept.findFirstOrThrow({
        where: { code },
      });
      return concepto.id;
    }

    it('devuelve el primer nivel con el total, no sólo un puñado', async () => {
      const cuerpo = (await raices('CIE10').expect(200)).body as PaginaCuerpo;

      expect(cuerpo.items.map((c) => c.code)).toEqual(['J00-J99']);
      // El total es lo que le dice al cliente si le falta algo por pedir.
      expect(cuerpo).toMatchObject({ total: 1, page: 1, pageSize: 100 });
    });

    it('un catálogo PLANO devuelve su lista entera como raíces', async () => {
      /**
       * Es el caso del selector de países y el de etnia: no hay más nivel que
       * éste, y sus conceptos son exactamente lo que se elige.
       *
       * LAS OCHO CATEGORÍAS, no las seis que el INEC publica: el formulario del
       * RDACAA separa afroecuatoriano, negro y mulato, y agrupar es trabajo de
       * la capa de exportación. Ver `seed-rdacaa.mts`.
       */
      const cuerpo = (await raices('ETHNICITY').expect(200))
        .body as PaginaCuerpo;

      expect(cuerpo.total).toBe(8);
      expect(cuerpo.items.map((c) => c.code).sort()).toEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
      ]);
      expect(cuerpo.items.every((c) => c.selectable)).toBe(true);
    });

    it('devuelve lo que cuelga de un concepto', async () => {
      const cuerpo = (await hijos(await idDeCodigo('J00-J99')).expect(200))
        .body as PaginaCuerpo;

      expect(cuerpo.items.map((c) => c.code)).toEqual(['J18.9']);
      expect(cuerpo.total).toBe(1);
    });

    it('distingue una hoja de un id que no es nada', async () => {
      /**
       * LAS DOS RESPUESTAS SON UNA LISTA VACÍA, y por eso hace falta la
       * comprobación del padre. Una parroquia tiene cero hijos con toda
       * legitimidad; un id caducado en la pantalla también devolvería cero, y
       * sin distinguirlos el usuario ve un nivel vacío donde hay un error.
       */
      const hoja = (await hijos(await idDeCodigo('J18.9')).expect(200))
        .body as PaginaCuerpo;
      expect(hoja.items).toEqual([]);
      expect(hoja.total).toBe(0);

      const inexistente = await hijos(
        '01920000-0000-7000-8000-000000000000',
      ).expect(404);
      expect((inexistente.body as { code: string }).code).toBe(
        'CATALOG_CONCEPT_NOT_FOUND',
      );
    });

    it('rechaza un id que no es un uuid antes de llegar a la consulta', async () => {
      await hijos('J18.9').expect(400);
    });

    it('rechaza una página imposible en vez de adivinar', async () => {
      await raices('CIE10', '?page=0').expect(422);
      await raices('CIE10', '?pageSize=0').expect(422);
      // 500 es el tope: cubre los 249 países de una vez, y no un catálogo
      // plano de miles de medicamentos.
      await raices('CIE10', '?pageSize=501').expect(422);
    });

    it('exige sesión, como el resto del catálogo', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/catalogs/CIE10/roots')
        .expect(401);
      await request(app.getHttpServer())
        .get(`/api/v1/catalogs/concepts/${await idDeCodigo('J18.9')}/children`)
        .expect(401);
    });

    /**
     * EL ORDEN DE DECLARACIÓN ES LA GARANTÍA, igual que con `concepts/:id`.
     * `/catalogs/CIE10/roots` encaja también en `:system/:code`; si aquélla
     * fuera primero, `roots` llegaría como CÓDIGO de la CIE-10 y esta ruta
     * respondería 404 sin ejecutarse nunca. Quien mueva el método de sitio lo
     * rompe en silencio, y esto es lo que lo detecta.
     */
    it('no confunde «roots» con un código del catálogo', async () => {
      const cuerpo = (await raices('CIE10').expect(200)).body as PaginaCuerpo;

      // Un 404 con CATALOG_CONCEPT_NOT_FOUND significaría que `:system/:code`
      // ganó la ruta y buscó un código llamado «roots».
      expect(cuerpo.items).toHaveLength(1);
    });

    it('acota la búsqueda a una rama', async () => {
      const capitulo = await idDeCodigo('J00-J99');

      const dentro = (
        await request(app.getHttpServer())
          .get(`/api/v1/catalogs/CIE10?q=neumonia&parentId=${capitulo}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
      ).body as { items: ConceptoCuerpo[] };
      expect(dentro.items.map((c) => c.code)).toEqual(['J18.9']);

      // Acotada a una rama que no la contiene, la misma búsqueda no devuelve
      // nada: es lo que demuestra que el filtro filtra.
      const fuera = (
        await request(app.getHttpServer())
          .get(
            `/api/v1/catalogs/CIE10?q=neumonia&parentId=${await idDeCodigo('J18.9')}`,
          )
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
      ).body as { items: ConceptoCuerpo[] };
      expect(fuera.items).toEqual([]);
    });
  });
});
