import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';
import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { Quantity } from '../../src/modules/billing/domain/money';
import { PrismaBillingAccountRepository } from '../../src/modules/billing/infrastructure/prisma-billing-account.repository';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * B7 — what the clinic changes without a deploy (BI-140 to BI-147), against a
 * real PostgreSQL 18.
 *
 *   - BI-144: the closed list of SRI codes and the case-blind uniqueness of the
 *     name are the DATABASE'S, proved by writing straight through SQL, each
 *     with its positive control on the same path.
 *   - BI-142: changing a role's ceiling does not move one cent of a discount
 *     already granted — proved by reading the charge row before and after.
 *   - BI-141, BI-146, BI-147 over HTTP: the contract the screen consumes, who
 *     may write, and the trail it leaves.
 */
const PASSWORD = 'el caballo come alfalfa';
/** Synthetic cedulas with a COMPUTED check digit; never a real person's. */
const ADMIN_CEDULA = '1710034065';
const CAJA_CEDULA = '0926687856';

interface Problem {
  status: number;
  code: string;
  errors?: { field: string }[];
}

interface MethodBody {
  id: string;
  name: string;
  sriCode: string;
  active: boolean;
  displayOrder: number;
  lastChange: { at: string; by: { id: string; name: string } } | null;
}

interface LimitBody {
  roleId: string;
  roleCode: string;
  maxDiscountPercentage: string;
  lastChange: { at: string; by: { id: string; name: string } } | null;
}

describe('B7 la parametrización de caja', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let adminToken: string;
  let adminUserId: string;
  let cajaToken: string;

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
    registry.invalidate();

    const admin = await signIn('gerencia@clinica.ec', 'ADMIN', ADMIN_CEDULA);
    adminToken = admin.token;
    adminUserId = admin.userId;
    cajaToken = (await signIn('caja@clinica.ec', 'CAJA', CAJA_CEDULA)).token;
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(
    email: string,
    roleCode: 'ADMIN' | 'CAJA',
    cedula: string,
    /** D-023: a grant confined to ONE site. Absent = clinic-wide. */
    grantedSiteId?: string,
  ): Promise<{ token: string; userId: string }> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: roleCode === 'ADMIN' ? 'Gabriela' : 'Rosa',
        lastName: roleCode === 'ADMIN' ? 'Mera' : 'Cedeño',
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
      data: { userId: user.id, roleId: role.id, siteId: grantedSiteId },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      token: (response.body as { accessToken: string }).accessToken,
      userId: user.id,
    };
  }

  const base = '/api/v1/billing';
  const get = (path: string, token = adminToken) =>
    request(app.getHttpServer())
      .get(`${base}${path}`)
      .set('Authorization', `Bearer ${token}`);
  const send = (
    method: 'post' | 'patch' | 'put',
    path: string,
    body: Record<string, unknown>,
    token = adminToken,
  ) =>
    request(app.getHttpServer())
      [method](`${base}${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  /** Two methods, as a clinic that takes cash and cards would have. */
  async function twoMethods(): Promise<{ cash: string; card: string }> {
    const cash = await prisma.paymentMethod.create({
      data: { name: 'Efectivo', sriCode: '01', displayOrder: 1 },
    });
    const card = await prisma.paymentMethod.create({
      data: { name: 'Tarjeta de crédito', sriCode: '19', displayOrder: 2 },
    });
    return { cash: cash.id, card: card.id };
  }

  describe('BI-144 lo que la base garantiza de un medio de pago', () => {
    it('BI-144 la base rechaza una forma de pago que no está en la Tabla 24, y admite la 20 (control)', async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO payment_method (name, sri_code, display_order)
          VALUES ('Deuna', '20', 1)`,
      ).resolves.toBe(1);

      await expect(
        prisma.$executeRaw`
          INSERT INTO payment_method (name, sri_code, display_order)
          VALUES ('Cheque', '02', 2)`,
      ).rejects.toThrowError(/payment_method_sri_code_is_known/);
    });

    it('BI-144 la base rechaza dos medios con el mismo nombre sin distinguir mayúsculas ni bordes, y admite otro nombre (control)', async () => {
      await prisma.$executeRaw`
        INSERT INTO payment_method (name, sri_code, display_order)
        VALUES ('Deuna', '20', 1)`;

      await expect(
        prisma.$executeRaw`
          INSERT INTO payment_method (name, sri_code, display_order)
          VALUES ('Peigo', '20', 2)`,
      ).resolves.toBe(1);
      await expect(
        prisma.$executeRaw`
          INSERT INTO payment_method (name, sri_code, display_order)
          VALUES ('  DEUNA ', '17', 3)`,
      ).rejects.toThrowError(/payment_method_name_unique/);
    });

    it('BI-144 dos medios pueden declararse con el mismo código del SRI', async () => {
      await prisma.$executeRaw`
        INSERT INTO payment_method (name, sri_code, display_order)
        VALUES ('Visa', '19', 1), ('Mastercard', '19', 2)`;

      expect(
        await prisma.paymentMethod.count({ where: { sriCode: '19' } }),
      ).toBe(2);
    });
  });

  describe('BI-100 BI-145 los medios de pago por HTTP', () => {
    it('BI-145 caja lee sólo los activos, en su orden; administración pide también los inactivos', async () => {
      const { card } = await twoMethods();
      await prisma.paymentMethod.create({
        data: { name: 'Endoso', sriCode: '21', displayOrder: 3, active: false },
      });

      const forCashier = await get('/payment-methods', cajaToken).expect(200);
      expect(
        (forCashier.body as { items: MethodBody[] }).items.map((m) => [
          m.name,
          m.sriCode,
        ]),
      ).toEqual([
        ['Efectivo', '01'],
        ['Tarjeta de crédito', '19'],
      ]);
      expect((forCashier.body as { items: MethodBody[] }).items[1]?.id).toBe(
        card,
      );

      const all = await get('/payment-methods?includeInactive=true').expect(
        200,
      );
      expect((all.body as { items: MethodBody[] }).items).toHaveLength(3);
    });

    it('BI-140 BI-147 administración da de alta «Deuna» con la forma 20: queda al final, con quién y cuándo, y en la bitácora', async () => {
      await twoMethods();

      const created = await send('post', '/payment-methods', {
        name: '  Deuna ',
        sriCode: '20',
      }).expect(201);
      const body = created.body as MethodBody;

      expect(body).toMatchObject({
        name: 'Deuna',
        sriCode: '20',
        active: true,
        displayOrder: 3,
      });
      expect(body.lastChange?.by).toEqual({
        id: adminUserId,
        name: 'Gabriela Mera',
      });

      const trail = await prisma.accessAudit.findFirstOrThrow({
        where: { resourceType: 'payment_method', resourceId: body.id },
      });
      expect(trail).toMatchObject({
        action: 'CREATE',
        userId: adminUserId,
        after: { name: 'Deuna', sriCode: '20', active: true },
      });
    });

    it('BI-144 un nombre repetido responde 409 PAYMENT_METHOD_NAME_TAKEN, y otro nombre entra (control)', async () => {
      await twoMethods();

      await send('post', '/payment-methods', {
        name: 'Deuna',
        sriCode: '20',
      }).expect(201);
      const twin = await send('post', '/payment-methods', {
        name: 'EFECTIVO',
        sriCode: '01',
      }).expect(409);
      expect((twin.body as Problem).code).toBe('PAYMENT_METHOD_NAME_TAKEN');
    });

    it('BI-144 una forma de pago fuera de la Tabla 24 se rechaza nombrando el campo', async () => {
      const response = await send('post', '/payment-methods', {
        name: 'Cheque',
        sriCode: '02',
      }).expect(422);
      expect((response.body as Problem).errors?.map((e) => e.field)).toContain(
        'sriCode',
      );
    });

    it('BI-146 BI-147 desactiva uno con otro activo y deja el antes y el después; el último activo responde 409 LAST_ACTIVE_PAYMENT_METHOD', async () => {
      const { cash, card } = await twoMethods();

      await send('patch', `/payment-methods/${card}`, { active: false }).expect(
        200,
      );
      const trail = await prisma.accessAudit.findFirstOrThrow({
        where: { resourceType: 'payment_method', resourceId: card },
      });
      expect(trail).toMatchObject({
        action: 'UPDATE',
        before: { active: true },
        after: { active: false },
      });

      const last = await send('patch', `/payment-methods/${cash}`, {
        active: false,
      }).expect(409);
      expect((last.body as Problem).code).toBe('LAST_ACTIVE_PAYMENT_METHOD');
      expect(
        (await prisma.paymentMethod.findUniqueOrThrow({ where: { id: cash } }))
          .active,
      ).toBe(true);
    });

    it('BI-100 un medio que no existe responde 404 PAYMENT_METHOD_NOT_FOUND', async () => {
      const { cash } = await twoMethods();
      // Control: the same route with an existing id answers 200.
      await send('patch', `/payment-methods/${cash}`, {
        name: 'Efectivo en caja',
      }).expect(200);

      const missing = await send(
        'patch',
        '/payment-methods/01900000-0000-7000-8000-000000000000',
        { active: false },
      ).expect(404);
      expect((missing.body as Problem).code).toBe('PAYMENT_METHOD_NOT_FOUND');
    });

    it('BI-140 caja lee los medios pero no los escribe: 403 sin settings:manage', async () => {
      await twoMethods();
      await get('/payment-methods', cajaToken).expect(200);

      await send(
        'post',
        '/payment-methods',
        { name: 'Deuna', sriCode: '20' },
        cajaToken,
      ).expect(403);
    });
  });

  describe('BI-146 lo que la base garantiza al desactivar y al borrar', () => {
    it('BI-146 la base rechaza desactivar el último activo por SQL directo, y desactiva uno cuando queda otro (control)', async () => {
      const { cash, card } = await twoMethods();

      await expect(
        prisma.$executeRaw`UPDATE payment_method SET active = false WHERE id = ${card}::uuid`,
      ).resolves.toBe(1);
      await expect(
        prisma.$executeRaw`UPDATE payment_method SET active = false WHERE id = ${cash}::uuid`,
      ).rejects.toThrowError(/payment_method_one_stays_active/);
    });

    it('BI-146 la base rechaza borrar un medio de pago, y lo renombra (control)', async () => {
      const { cash } = await twoMethods();

      await expect(
        prisma.$executeRaw`UPDATE payment_method SET name = 'Efectivo en caja' WHERE id = ${cash}::uuid`,
      ).resolves.toBe(1);
      await expect(
        prisma.$executeRaw`DELETE FROM payment_method WHERE id = ${cash}::uuid`,
      ).rejects.toThrowError(/payment_method_is_never_deleted/);
    });

    it('BI-146 dos administradores apagan a la vez los dos últimos: gana uno y el otro recibe LAST_ACTIVE_PAYMENT_METHOD', async () => {
      const { cash, card } = await twoMethods();

      const [first, second] = await Promise.all([
        send('patch', `/payment-methods/${cash}`, { active: false }),
        send('patch', `/payment-methods/${card}`, { active: false }),
      ]);

      // Exactly one winner. The loser is refused by the service's count (409)
      // when the winner already committed, or by the database's lock (422)
      // when both read two active methods: either way, the same code.
      expect(
        [first.status, second.status].filter((status) => status === 200),
      ).toHaveLength(1);
      const loser = first.status === 200 ? second : first;
      expect([409, 422]).toContain(loser.status);
      expect((loser.body as Problem).code).toBe('LAST_ACTIVE_PAYMENT_METHOD');
      expect(
        await prisma.paymentMethod.count({ where: { active: true } }),
      ).toBe(1);
    });
  });

  describe('D-023 la parametrización es de toda la clínica', () => {
    it('BI-140 un administrador con settings:manage en una sola sede recibe 403 al escribir, y el de toda la clínica escribe (control)', async () => {
      const { cash } = await twoMethods();
      const site = await createSite(prisma, 'Sede Norte');
      const scoped = await signIn(
        'norte@clinica.ec',
        'ADMIN',
        '1710034073',
        site.id,
      );
      const caja = await prisma.role.findUniqueOrThrow({
        where: { code: 'CAJA' },
      });

      await send('patch', `/payment-methods/${cash}`, {
        name: 'Efectivo',
      }).expect(200);

      await send(
        'post',
        '/payment-methods',
        { name: 'Deuna', sriCode: '20' },
        scoped.token,
      ).expect(403);
      await send(
        'patch',
        `/payment-methods/${cash}`,
        { active: false },
        scoped.token,
      ).expect(403);
      await send(
        'put',
        `/discount-limits/${caja.id}`,
        { maxDiscountPercentage: '50' },
        scoped.token,
      ).expect(403);
    });
  });

  describe('BI-141 BI-142 el límite de descuento de cada rol', () => {
    it('BI-141 todo rol sale con su límite, y el que no tiene ninguno sale en cero', async () => {
      const response = await get('/discount-limits').expect(200);
      const items = (response.body as { items: LimitBody[] }).items;

      expect(items.length).toBeGreaterThan(3);
      expect(items.find((item) => item.roleCode === 'CAJA')).toMatchObject({
        maxDiscountPercentage: '0.00',
        lastChange: null,
      });
    });

    it('BI-141 BI-147 administración asigna el 10 % a caja: se lee con quién y cuándo, y la bitácora guarda el antes y el después', async () => {
      const caja = await prisma.role.findUniqueOrThrow({
        where: { code: 'CAJA' },
      });

      const set = await send('put', `/discount-limits/${caja.id}`, {
        maxDiscountPercentage: '10',
      }).expect(200);
      expect(set.body as LimitBody).toMatchObject({
        maxDiscountPercentage: '10.00',
        lastChange: { by: { id: adminUserId, name: 'Gabriela Mera' } },
      });

      const trail = await prisma.accessAudit.findFirstOrThrow({
        where: { resourceType: 'role_discount_limit', resourceId: caja.id },
      });
      expect(trail).toMatchObject({
        before: { maxDiscountPercentage: '0.00' },
        after: { maxDiscountPercentage: '10.00' },
      });
    });

    it('BI-141 un límite por encima del 100 % se rechaza nombrando el campo, y el 100 % entra (control)', async () => {
      const caja = await prisma.role.findUniqueOrThrow({
        where: { code: 'CAJA' },
      });
      await send('put', `/discount-limits/${caja.id}`, {
        maxDiscountPercentage: '100.00',
      }).expect(200);

      const over = await send('put', `/discount-limits/${caja.id}`, {
        maxDiscountPercentage: '100.01',
      }).expect(422);
      expect((over.body as Problem).errors?.map((e) => e.field)).toContain(
        'maxDiscountPercentage',
      );
    });

    it('BI-141 la base rechaza un límite por encima del 100 % por SQL directo, y admite el 100 % (control)', async () => {
      const caja = await prisma.role.findUniqueOrThrow({
        where: { code: 'CAJA' },
      });

      await expect(
        prisma.$executeRaw`
          INSERT INTO role_discount_limit (role_id, max_discount_percentage, updated_at)
          VALUES (${caja.id}::uuid, 100.00, CURRENT_TIMESTAMP)`,
      ).resolves.toBe(1);
      await expect(
        prisma.$executeRaw`
          UPDATE role_discount_limit SET max_discount_percentage = 100.01
           WHERE role_id = ${caja.id}::uuid`,
      ).rejects.toThrowError(/role_discount_limit_percentage_in_range/);
    });

    it('BI-141 caja no lee ni asigna límites: 403 sin settings:read ni settings:manage', async () => {
      const caja = await prisma.role.findUniqueOrThrow({
        where: { code: 'CAJA' },
      });
      // Control: the administrator reads the same route.
      await get('/discount-limits').expect(200);

      await get('/discount-limits', cajaToken).expect(403);
      await send(
        'put',
        `/discount-limits/${caja.id}`,
        { maxDiscountPercentage: '50' },
        cajaToken,
      ).expect(403);
    });

    it('BI-141 un rol que no existe responde 404 DISCOUNT_LIMIT_ROLE_NOT_FOUND', async () => {
      const missing = await send(
        'put',
        '/discount-limits/01900000-0000-7000-8000-000000000000',
        { maxDiscountPercentage: '5' },
      ).expect(404);
      expect((missing.body as Problem).code).toBe(
        'DISCOUNT_LIMIT_ROLE_NOT_FOUND',
      );
    });

    it('BI-142 cambiar el límite de un rol no mueve ni un centavo de un descuento ya concedido', async () => {
      await seedBilling(prisma);
      const site = await createSite(prisma);
      const patient = await createPatient(prisma);
      const payer = await prisma.payer.findUniqueOrThrow({
        where: { code: 'PARTICULAR' },
      });
      const priceList = await prisma.priceList.findFirstOrThrow({
        where: { payerId: payer.id },
      });
      const service = await prisma.billableService.findUniqueOrThrow({
        where: { code: 'CONS-MG-PV' },
      });
      const account = await prisma.patientAccount.create({
        data: {
          patientId: patient.id,
          siteId: site.id,
          payerId: payer.id,
          priceListId: priceList.id,
        },
      });
      const accounts = new PrismaBillingAccountRepository(
        prisma as unknown as PrismaService,
      );
      const charged = await accounts.addCharge({
        accountId: account.id,
        billableServiceId: service.id,
        encounterId: null,
        serviceDate: clinicalDateOf(new Date()),
        quantity: Quantity.ONE,
        createdById: adminUserId,
        origin: 'MANUAL',
        encounterProcedureId: null,
        serviceOrderItemId: null,
        status: 'BILLABLE',
      });
      // A discount granted under the old ceiling, written as B4 will write it.
      await prisma.chargeItem.update({
        where: { id: charged.id },
        data: {
          discountAmount: '3.00',
          discountReason: 'Convenio con la empresa',
          changedById: adminUserId,
          changedAt: new Date(),
        },
      });
      const before = await prisma.chargeItem.findUniqueOrThrow({
        where: { id: charged.id },
      });
      const caja = await prisma.role.findUniqueOrThrow({
        where: { code: 'CAJA' },
      });

      // Control: the route really writes the ceiling.
      await send('put', `/discount-limits/${caja.id}`, {
        maxDiscountPercentage: '0',
      }).expect(200);
      expect(
        (
          await prisma.roleDiscountLimit.findUniqueOrThrow({
            where: { roleId: caja.id },
          })
        ).maxDiscountPercentage.toFixed(2),
      ).toBe('0.00');

      const after = await prisma.chargeItem.findUniqueOrThrow({
        where: { id: charged.id },
      });
      expect(after.discountAmount.toFixed(2)).toBe('3.00');
      expect(after).toEqual(before);
    });
  });
});
