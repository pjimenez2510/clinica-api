import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';

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
    await app.init();

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
    await app?.close();
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

  it('no ofrece capítulos como diagnóstico, salvo si se piden', async () => {
    expect(
      (
        (await buscar('?q=respiratori').expect(200)).body as {
          items: ConceptoCuerpo[];
        }
      ).items.map((c) => c.code),
    ).not.toContain('J00-J99');

    expect(
      (
        (await buscar('?q=respiratori&includeGroups=true').expect(200))
          .body as { items: ConceptoCuerpo[] }
      ).items.map((c) => c.code),
    ).toContain('J00-J99');
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
    await request(app.getHttpServer())
      .get('/api/v1/catalogs/CIE10/Z999')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('rechaza una fecha de vigencia mal escrita', async () => {
    // `on` llegaba antes como texto suelto sin validar, y de ahí a un
    // `new Date()` que producía una fecha inválida en la consulta.
    await buscar('?q=neumonia&on=ayer').expect(422);
  });
});
