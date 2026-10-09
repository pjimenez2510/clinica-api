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
 * B4 — descuentos con límite y con autorización (BI-060 a BI-066, BI-244 a
 * BI-246), contra PostgreSQL 18 de verdad.
 *
 *   - Lo que garantiza la BASE —nadie se autoriza a sí mismo, quién y cuándo,
 *     el descuento no se edita y su línea no se mueve— se prueba por SQL
 *     directo, cada rechazo con su control positivo por el mismo camino.
 *   - El límite y el permiso, por HTTP con SESIONES DE VERDAD: caja con su
 *     límite en `role_discount_limit` y una supervisora cuyo rol lleva
 *     `billing:discount-override`. Un doble con los permisos puestos a mano no
 *     vería el defecto que se busca, que es de permiso (AG-111).
 */
const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  status: number;
  code: string;
}

interface ChargeBody {
  id: string;
  discountAmount: string;
  discountReason: string | null;
  lineTotal: string;
  discountAppliedBy: { id: string; name: string } | null;
  discountAppliedAt: string | null;
  discountAuthorisedBy: { id: string; name: string } | null;
  discountAuthorisedAt: string | null;
}

describe('B4 descuentos con límite y con autorización', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let accountId: string;
  let serviceId: string;
  let caja: { token: string; userId: string };
  let supervisor: { token: string; userId: string };

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
    await seedBilling(prisma);

    // A role that can authorise and nothing else of caja's: what a clinic
    // creates to separate who charges from who approves (BI-134).
    const supervisorRole = await prisma.role.create({
      data: {
        code: 'SUPERVISION_CAJA',
        name: 'Supervisión de caja',
        permissions: {
          create: [
            { permissionCode: 'billing:discount-override' },
            { permissionCode: 'billing:read' },
          ],
        },
      },
    });
    registry.invalidate();

    const cajaRole = await prisma.role.findUniqueOrThrow({ where: { code: 'CAJA' } }); // prettier-ignore
    await prisma.roleDiscountLimit.create({
      data: { roleId: cajaRole.id, maxDiscountPercentage: '10.00' },
    });

    caja = await signIn('caja@clinica.ec', ['CAJA'], 'Rosa', 'Cedeño');
    supervisor = await signIn('supervision@clinica.ec', [supervisorRole.code], 'Ana', 'Pérez'); // prettier-ignore

    const site = await createSite(prisma);
    siteId = site.id;
    const patient = await createPatient(prisma);
    const payer = await prisma.payer.findUniqueOrThrow({ where: { code: 'PARTICULAR' } }); // prettier-ignore
    const priceList = await prisma.priceList.findFirstOrThrow({ where: { payerId: payer.id } }); // prettier-ignore
    serviceId =
      (await prisma.billableService.findUniqueOrThrow({ where: { code: 'CONS-MG-PV' } })) // prettier-ignore
      .id;
    accountId = (
      await prisma.patientAccount.create({
        data: { patientId: patient.id, siteId, payerId: payer.id, priceListId: priceList.id }, // prettier-ignore
      })
    ).id;
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(
    email: string,
    roleCodes: string[],
    firstName: string,
    lastName: string,
  ): Promise<{ token: string; userId: string }> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName,
        lastName,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    for (const code of roleCodes) {
      const role = await prisma.role.findUniqueOrThrow({ where: { code } });
      await prisma.userRoleGrant.create({ data: { userId: user.id, roleId: role.id } }); // prettier-ignore
    }
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      token: (response.body as { accessToken: string }).accessToken,
      userId: user.id,
    };
  }

  /** A confirmed line of $40.00 (two of the seeded consultation, whatever it costs, is not assumed). */
  async function line(status: 'BILLABLE' | 'PLANNED' = 'BILLABLE') {
    const accounts = new PrismaBillingAccountRepository(prisma as unknown as PrismaService); // prettier-ignore
    const charge = await accounts.addCharge({
      accountId,
      billableServiceId: serviceId,
      encounterId: null,
      serviceDate: clinicalDateOf(new Date()),
      quantity: Quantity.ONE,
      createdById: caja.userId,
      origin: 'MANUAL',
      encounterProcedureId: null,
      serviceOrderItemId: null,
      status,
    });
    return { id: charge.id, gross: charge.unitAmount };
  }

  const discount = (
    chargeId: string,
    body: Record<string, unknown>,
    token = caja.token,
  ) =>
    request(app.getHttpServer())
      .post(
        `/api/v1/billing/sites/${siteId}/accounts/${accountId}/charges/${chargeId}/discount`,
      ) // prettier-ignore
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  /** Percent of the line, in cents, from the price the seed gave it. */
  const percentOf = (gross: { toString(): string }, percent: number) =>
    (Math.round(Number(gross.toString()) * percent) / 100).toFixed(2);

  describe('lo que garantiza la base', () => {
    const stamp = (by: string) => ({ changedById: by, changedAt: new Date() });

    it('BI-064 la base rechaza un descuento autorizado por quien lo aplicó, y admite a otra persona (control)', async () => {
      const { id } = await line();
      const now = new Date();

      await expect(
        prisma.$executeRaw`
          UPDATE charge_item SET discount_amount = 1.00,
                 discount_applied_by_id = ${supervisor.userId}::uuid, discount_applied_at = ${now},
                 discount_authorised_by_id = ${supervisor.userId}::uuid, discount_authorised_at = ${now},
                 changed_by = ${supervisor.userId}::uuid, changed_at = ${now}
           WHERE id = ${id}::uuid`,
      ).rejects.toThrowError(/charge_item_discount_not_self_authorised/);

      await expect(
        prisma.$executeRaw`
          UPDATE charge_item SET discount_amount = 1.00,
                 discount_applied_by_id = ${caja.userId}::uuid, discount_applied_at = ${now},
                 discount_authorised_by_id = ${supervisor.userId}::uuid, discount_authorised_at = ${now},
                 changed_by = ${caja.userId}::uuid, changed_at = ${now}
           WHERE id = ${id}::uuid`,
      ).resolves.toBe(1);
    });

    it('BI-066 la base rechaza un descuento sin quién ni cuándo, y lo admite con ellos (control)', async () => {
      const { id } = await line();
      // An INSERT, so the CHECK is what answers and not the UPDATE trigger.
      const copy = (appliedBy: string | null, appliedAt: Date | null) =>
        prisma.$executeRaw`
          INSERT INTO charge_item (account_id, billable_service_id, service_date, quantity,
                 unit_amount, resolved_price_id, service_display, tax_sri_code, tax_percentage,
                 status, created_by_id, origin, updated_at,
                 discount_amount, discount_applied_by_id, discount_applied_at)
          SELECT account_id, billable_service_id, service_date, quantity,
                 unit_amount, resolved_price_id, service_display, tax_sri_code, tax_percentage,
                 status, created_by_id, origin, updated_at,
                 1.00, ${appliedBy}::uuid, ${appliedAt}
            FROM charge_item WHERE id = ${id}::uuid`;

      await expect(copy(null, null)).rejects.toThrowError(
        /charge_item_discount_states_who_and_when/,
      );
      await expect(copy(caja.userId, new Date())).resolves.toBe(1);
    });

    it('BI-066 la base no deja cambiar el motivo ni el autorizador de un descuento sin un acto nuevo, y sí con él (control)', async () => {
      const { id } = await line();
      const granted = new Date(Date.now() - 60_000);
      await prisma.chargeItem.update({
        where: { id },
        data: {
          discountAmount: '1.00',
          discountReason: 'Convenio',
          discountAppliedById: caja.userId,
          discountAppliedAt: granted,
          ...stamp(caja.userId),
        },
      });

      await expect(
        prisma.chargeItem.update({
          where: { id },
          data: {
            discountReason: 'Cortesía de la clínica',
            ...stamp(caja.userId),
          },
        }),
      ).rejects.toThrowError(/charge_item_discount_is_permanent/);

      // Control: the same change as a NEW act, with its own instant.
      await expect(
        prisma.chargeItem.update({
          where: { id },
          data: {
            discountReason: 'Cortesía de la clínica',
            discountAppliedAt: new Date(),
            ...stamp(caja.userId),
          },
        }),
      ).resolves.toMatchObject({ discountReason: 'Cortesía de la clínica' });
    });

    it('BI-244 la base no deja cambiar la cantidad de una línea con descuento, y sí sin él (control)', async () => {
      const { id } = await line();
      await prisma.chargeItem.update({
        where: { id },
        data: {
          discountAmount: '1.00',
          discountAppliedById: caja.userId,
          discountAppliedAt: new Date(Date.now() - 60_000),
          ...stamp(caja.userId),
        },
      });

      await expect(
        prisma.chargeItem.update({
          where: { id },
          data: { quantity: '2', ...stamp(caja.userId) },
        }),
      ).rejects.toThrowError(/charge_item_discount_is_permanent/);

      const other = await line();
      await expect(
        prisma.chargeItem.update({
          where: { id: other.id },
          data: { quantity: '2', ...stamp(caja.userId) },
        }),
      ).resolves.toMatchObject({ id: other.id });
    });
  });

  describe('por HTTP, con dos sesiones de verdad', () => {
    it('BI-062 BI-063 caja con tope del 10 % aplica un 20 %, se rechaza, la supervisora lo autoriza y la línea queda con los dos nombres', async () => {
      const { id, gross } = await line();

      const refused = await discount(id, { percentage: '20' }).expect(403);
      expect((refused.body as Problem).code).toBe('DISCOUNT_EXCEEDS_LIMIT');

      const granted = await discount(id, {
        percentage: '20',
        reason: 'Convenio',
        authorisedById: supervisor.userId,
      }).expect(200);
      const body = granted.body as ChargeBody;
      expect(body).toMatchObject({
        discountAmount: percentOf(gross, 20),
        discountReason: 'Convenio',
        discountAppliedBy: { id: caja.userId, name: 'Rosa Cedeño' },
        discountAuthorisedBy: { id: supervisor.userId, name: 'Ana Pérez' },
      });
      expect(body.discountAuthorisedAt).toBe(body.discountAppliedAt);

      // BI-066 in the ROW, not only in the response.
      const row = await prisma.chargeItem.findUniqueOrThrow({ where: { id } });
      expect(row.discountAppliedById).toBe(caja.userId);
      expect(row.discountAuthorisedById).toBe(supervisor.userId);

      // BI-132: the act is in the trail, by who applied it.
      await expect(
        prisma.accessAudit.count({
          where: { resourceType: 'charge_item', resourceId: id, userId: caja.userId }, // prettier-ignore
        }),
      ).resolves.toBe(1);
    });

    it('BI-063 dentro del límite entra sin autorizador, y no guarda al que se nombró de más', async () => {
      const { id, gross } = await line();

      const body =
        (await discount(id, { percentage: '10', authorisedById: supervisor.userId }).expect(200)) // prettier-ignore
        .body as ChargeBody;

      expect(body.discountAmount).toBe(percentOf(gross, 10));
      expect(body.discountAuthorisedBy).toBeNull();
    });

    it('BI-064 quien lleva el permiso no se autoriza a sí mismo por encima de su propio límite', async () => {
      const { id } = await line();
      const both = await signIn('jefa@clinica.ec', ['CAJA', 'SUPERVISION_CAJA'], 'Lucía', 'Mora'); // prettier-ignore

      const refused = await discount(id, { percentage: '20', authorisedById: both.userId }, both.token).expect(403); // prettier-ignore
      expect((refused.body as Problem).code).toBe('SELF_AUTHORISATION_DENIED');

      // Control: the same person authorises somebody else's.
      await discount(id, { percentage: '20', authorisedById: both.userId }).expect(200); // prettier-ignore
    });

    it('BI-063 un autorizador sin billing:discount-override se rechaza con DISCOUNT_NOT_AUTHORISED', async () => {
      const { id } = await line();
      const otherCaja = await signIn(
        'caja2@clinica.ec',
        ['CAJA'],
        'Pedro',
        'Loor',
      );

      const refused = await discount(id, { percentage: '20', authorisedById: otherCaja.userId }).expect(403); // prettier-ignore
      expect((refused.body as Problem).code).toBe('DISCOUNT_NOT_AUTHORISED');
    });

    it('BI-062 BI-141 un rol sin límite asignado no descuenta ni un centavo por sí solo', async () => {
      const { id } = await line();
      await prisma.roleDiscountLimit.deleteMany();

      const refused = await discount(id, { amount: '0.01' }).expect(403);
      expect((refused.body as Problem).code).toBe('DISCOUNT_EXCEEDS_LIMIT');
    });

    it('BI-065 un descuento mayor que la línea se rechaza, aunque lo autorice otra persona', async () => {
      const { id, gross } = await line();
      const over = (Number(gross.toString()) + 0.01).toFixed(2);

      const refused = await discount(id, { amount: over, authorisedById: supervisor.userId }).expect(422); // prettier-ignore
      expect((refused.body as Problem).code).toBe(
        'DISCOUNT_EXCEEDS_LINE_AMOUNT',
      );
    });

    it('BI-246 una propuesta sin confirmar no lleva descuento', async () => {
      const { id } = await line('PLANNED');

      const refused = await discount(id, { amount: '0.50' }).expect(409);
      expect((refused.body as Problem).code).toBe('CHARGE_NOT_CONFIRMED');
    });

    it('BI-244 con descuento la cantidad no cambia; quitado el descuento, sí', async () => {
      const { id } = await line();
      await discount(id, { percentage: '5' }).expect(200);
      const edit = () =>
        request(app.getHttpServer())
          .patch(
            `/api/v1/billing/sites/${siteId}/accounts/${accountId}/charges/${id}`,
          ) // prettier-ignore
          .set('Authorization', `Bearer ${caja.token}`)
          .send({ quantity: '2' });

      const refused = await edit().expect(409);
      expect((refused.body as Problem).code).toBe('CHARGE_HAS_DISCOUNT');

      const removed = (await discount(id, { amount: '0.00' }).expect(200)).body as ChargeBody; // prettier-ignore
      expect(removed).toMatchObject({ discountAmount: '0.00', discountAppliedBy: null }); // prettier-ignore
      await edit().expect(200);
    });

    it('BI-066 reemplazar un descuento deja el anterior en record_version, con quién lo autorizó', async () => {
      const { id } = await line();
      await discount(id, { percentage: '20', authorisedById: supervisor.userId }).expect(200); // prettier-ignore
      await discount(id, { percentage: '5' }).expect(200);

      const versions = await prisma.$queryRaw<{ authorised: string | null }[]>`
        SELECT data ->> 'discount_authorised_by_id' AS authorised
          FROM record_version
         WHERE resource_type = 'charge_item' AND resource_id = ${id}::uuid
         ORDER BY version`;
      expect(versions.map((v) => v.authorised)).toContain(supervisor.userId);
    });

    it('BI-142 cambiar el límite de un rol no mueve ni un centavo de un descuento ya concedido por su ruta', async () => {
      const { id } = await line();
      await discount(id, { percentage: '10' }).expect(200);
      const before = await prisma.chargeItem.findUniqueOrThrow({
        where: { id },
      });

      const cajaRole = await prisma.role.findUniqueOrThrow({ where: { code: 'CAJA' } }); // prettier-ignore
      // Control: the ceiling really changed.
      await prisma.roleDiscountLimit.update({
        where: { roleId: cajaRole.id },
        data: { maxDiscountPercentage: '0' },
      });
      await discount((await line()).id, { amount: '0.01' }).expect(403);

      const after = await prisma.chargeItem.findUniqueOrThrow({
        where: { id },
      });
      expect(after).toEqual(before);
    });

    it('BI-245 el diálogo sabe el límite de caja y a quién pedírselo, sin ella misma', async () => {
      const response = await request(app.getHttpServer())
        .get(
          `/api/v1/billing/sites/${siteId}/accounts/${accountId}/discount-policy`,
        ) // prettier-ignore
        .set('Authorization', `Bearer ${caja.token}`)
        .expect(200);

      expect(response.body).toEqual({
        maxDiscountPercentage: '10.00',
        authorisers: [{ userId: supervisor.userId, name: 'Ana Pérez' }],
      });
    });

    it('BI-131 quien no lleva billing:write no pone descuentos (403), y caja sí (control)', async () => {
      const { id } = await line();

      await discount(id, { amount: '0.50' }, supervisor.token).expect(403);
      await discount(id, { amount: '0.50' }).expect(200);
    });
  });
});
