import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { seedBilling } from '../../prisma/seed-billing.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LA CATEGORÍA DE UNA PRESTACIÓN ES UN CATÁLOGO, Y SU CLASE MANDA (B11).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo que garantiza la base se prueba con SQL directo, por debajo de la
 * aplicación (BI-186): la referencia `NOT NULL`, la clase conocida, el nombre
 * único sin mayúsculas y el `RESTRICT`. Cada rechazo lleva al lado su control
 * positivo por el mismo camino.
 *
 * Lo que decide el servicio se prueba por HTTP con una sesión de verdad que
 * tiene `billing:price-manage` (BI-185, BI-187).
 */

const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  status: number;
  code: string;
}
interface Category {
  id: string;
  name: string;
  kind: string;
  active: boolean;
}
interface Service {
  id: string;
  code: string;
  category: { id: string; name: string; kind: string };
}

/** The message of a rejected statement, constraint name included. */
async function refusal(statement: Promise<unknown>): Promise<string> {
  try {
    await statement;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('La sentencia se aceptó');
}

describe('las categorías de prestación (B11)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  let token: string;
  let taxRateId: string;

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

    await seedBilling(prisma);
    await syncAuthorisation(prisma);
    await prisma.role.create({
      data: {
        code: 'TARIFARIO',
        name: 'Tarifario',
        description: 'Fija lo que cobra la clínica. No factura.',
        permissions: {
          create: [
            { permissionCode: 'billing:read' },
            { permissionCode: 'billing:price-manage' },
          ],
        },
      },
    });
    registry.invalidate();
    token = await signIn('tarifario@clinica.ec', 'TARIFARIO', '0919176818');
    taxRateId = (
      await prisma.billableService.findUniqueOrThrow({
        where: { code: 'CONS-MG-PV' },
      })
    ).taxRateId;
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(
    email: string,
    roleCode: string,
    cedula: string,
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Rosa',
        lastName: 'Cedeño',
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId: null },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  const api = () => request(app.getHttpServer());
  const bearer = () => `Bearer ${token}`;

  async function categoryNamed(name: string) {
    return prisma.billableServiceCategory.findFirstOrThrow({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
  }

  describe('lo que garantiza la base', () => {
    it('BI-186 la siembra deja cada prestación en su categoría, con la clase de la categoría', async () => {
      const consultation = await prisma.billableService.findUniqueOrThrow({
        where: { code: 'CONS-MG-PV' },
        include: { category: true },
      });
      expect(consultation.category).toMatchObject({
        name: 'Consultas',
        kind: 'CONSULTATION',
      });
    });

    it('BI-186 no admite una prestación sin categoría', async () => {
      // Control: con categoría, la misma inserción pasa.
      const category = await categoryNamed('Insumos');
      await prisma.$executeRaw`
        INSERT INTO "billable_service" ("code", "name", "category_id", "tax_rate_id", "updated_at")
        VALUES ('INS-CONTROL', 'Control', ${category.id}::uuid, ${taxRateId}::uuid, CURRENT_TIMESTAMP)`;

      expect(
        await refusal(prisma.$executeRaw`
          INSERT INTO "billable_service" ("code", "name", "tax_rate_id", "updated_at")
          VALUES ('INS-SIN-CAT', 'Sin categoría', ${taxRateId}::uuid, CURRENT_TIMESTAMP)`),
      ).toMatch(/category_id/);
    });

    it('BI-186 no admite una clase que no es una de las seis', async () => {
      await prisma.$executeRaw`
        INSERT INTO "billable_service_category" ("name", "kind") VALUES ('Terapias', 'OTHER')`;

      expect(
        await refusal(prisma.$executeRaw`
          INSERT INTO "billable_service_category" ("name", "kind") VALUES ('Otra cosa', 'MAGIC')`),
      ).toMatch(/billable_service_category_kind_is_known/);
    });

    it('BI-185 el nombre es único sin distinguir mayúsculas', async () => {
      await prisma.$executeRaw`
        INSERT INTO "billable_service_category" ("name", "kind") VALUES ('Odontología', 'PROCEDURE')`;

      const rejection = await prisma.billableServiceCategory
        .create({ data: { name: 'ODONTOLOGÍA', kind: 'PROCEDURE' } })
        .then(() => null)
        .catch((error: unknown) => error);

      expect(extractDatabaseProblem(rejection)).toMatchObject({
        status: 409,
        code: 'SERVICE_CATEGORY_NAME_DUPLICATE',
      });
    });

    it('BI-186 una categoría que alguna prestación usa no se borra; una sin uso, sí', async () => {
      const unused = await prisma.billableServiceCategory.create({
        data: { name: 'Sin uso', kind: 'OTHER' },
      });
      await prisma.$executeRaw`DELETE FROM "billable_service_category" WHERE "id" = ${unused.id}::uuid`;

      const used = await categoryNamed('Laboratorio');
      expect(
        await refusal(
          prisma.$executeRaw`DELETE FROM "billable_service_category" WHERE "id" = ${used.id}::uuid`,
        ),
      ).toMatch(/billable_service_category_fk/);
    });
  });

  describe('lo que decide la aplicación', () => {
    it('BI-185 crea una categoría con su clase y la lista; desactivada, sigue leyéndose con las inactivas', async () => {
      const created = await api()
        .post('/api/v1/billing/service-categories')
        .set('Authorization', bearer())
        .send({ name: 'Terapia física', kind: 'PROCEDURE' })
        .expect(201);
      const category = created.body as Category;
      expect(category).toMatchObject({
        name: 'Terapia física',
        kind: 'PROCEDURE',
        active: true,
      });

      await api()
        .patch(`/api/v1/billing/service-categories/${category.id}`)
        .set('Authorization', bearer())
        .send({ active: false })
        .expect(200);

      const active = await api()
        .get('/api/v1/billing/service-categories')
        .set('Authorization', bearer())
        .expect(200);
      const all = await api()
        .get('/api/v1/billing/service-categories?includeInactive=true')
        .set('Authorization', bearer())
        .expect(200);
      const ids = (body: unknown) =>
        (body as { items: Category[] }).items.map((item) => item.id);
      expect(ids(active.body)).not.toContain(category.id);
      expect(ids(all.body)).toContain(category.id);
    });

    it('BI-185 el nombre repetido se dice sobre el campo', async () => {
      const response = await api()
        .post('/api/v1/billing/service-categories')
        .set('Authorization', bearer())
        .send({ name: 'laboratorio', kind: 'LABORATORY' })
        .expect(409);
      expect((response.body as Problem).code).toBe(
        'SERVICE_CATEGORY_NAME_DUPLICATE',
      );
    });

    it('BI-185 una prestación nueva toma su categoría del catálogo, y no una desactivada', async () => {
      const supplies = await categoryNamed('Insumos');
      const created = await api()
        .post('/api/v1/billing/services')
        .set('Authorization', bearer())
        .send({
          code: 'INS-VENDA',
          name: 'Venda elástica',
          categoryId: supplies.id,
          taxRateId,
        })
        .expect(201);
      expect((created.body as Service).category).toMatchObject({
        id: supplies.id,
        name: 'Insumos',
        kind: 'SUPPLY',
      });

      const retired = await prisma.billableServiceCategory.create({
        data: { name: 'Retirada', kind: 'SUPPLY', active: false },
      });
      const refused = await api()
        .post('/api/v1/billing/services')
        .set('Authorization', bearer())
        .send({
          code: 'INS-GASA2',
          name: 'Gasa',
          categoryId: retired.id,
          taxRateId,
        })
        .expect(422);
      expect((refused.body as Problem).code).toBe('SERVICE_CATEGORY_INACTIVE');
    });

    it('BI-185 la prestación que ya lleva una categoría desactivada la sigue leyendo', async () => {
      const lab = await categoryNamed('Laboratorio');
      await prisma.billableServiceCategory.update({
        where: { id: lab.id },
        data: { active: false },
      });

      const list = await api()
        .get('/api/v1/billing/services?includeInactive=true')
        .set('Authorization', bearer())
        .expect(200);
      const items = (list.body as { items: Service[] }).items;
      expect(
        items.filter((service) => service.category.id === lab.id).length,
      ).toBeGreaterThan(0);
    });

    it('BI-187 declarar «la consulta» de una especialidad sobre un insumo se rechaza; sobre una consulta, no', async () => {
      const specialty = await prisma.specialty.create({
        data: { code: 'pruebas-b11', name: 'Especialidad de prueba' },
      });
      const supply = await prisma.billableService.findFirstOrThrow({
        where: { category: { kind: 'SUPPLY' } },
      });
      const consultation = await prisma.billableService.findFirstOrThrow({
        where: { category: { kind: 'CONSULTATION' }, specialtyId: null },
      });
      const mapping = {
        consultation: {
          specialtyId: specialty.id,
          visitSequence: 'FIRST_TIME',
        },
      };

      const refused = await api()
        .patch(`/api/v1/billing/services/${supply.id}`)
        .set('Authorization', bearer())
        .send(mapping)
        .expect(422);
      expect((refused.body as Problem).code).toBe('SERVICE_KIND_MISMATCH');

      // Control: the same mapping on a service of kind CONSULTATION passes.
      await api()
        .patch(`/api/v1/billing/services/${consultation.id}`)
        .set('Authorization', bearer())
        .send(mapping)
        .expect(200);
    });

    it('BI-187 la consulta de una especialidad no se pasa a una categoría de otra clase', async () => {
      const specialty = await prisma.specialty.create({
        data: { code: 'pruebas-b11-cat', name: 'Especialidad de prueba' },
      });
      const mapped = await prisma.billableService.update({
        where: { code: 'CONS-MG-PV' },
        data: { specialtyId: specialty.id, visitSequence: 'FIRST_TIME' },
      });
      const supplies = await categoryNamed('Insumos');
      const other = await prisma.billableServiceCategory.create({
        data: { name: 'Consultas especiales', kind: 'CONSULTATION' },
      });

      const refused = await api()
        .patch(`/api/v1/billing/services/${mapped.id}`)
        .set('Authorization', bearer())
        .send({ categoryId: supplies.id })
        .expect(422);
      expect((refused.body as Problem).code).toBe('SERVICE_KIND_MISMATCH');

      // Control: to another category of the same kind it moves.
      await api()
        .patch(`/api/v1/billing/services/${mapped.id}`)
        .set('Authorization', bearer())
        .send({ categoryId: other.id })
        .expect(200);
    });
  });
});
