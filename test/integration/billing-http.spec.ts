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
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * Billing as the browser consumes it.
 *
 * WHAT THIS ADDS over the domain and repository suites: everything BETWEEN the
 * browser and the database — the permission, the site scope, the shape of a
 * refusal under RFC 9457 and the exact `code` a client branches on. Half of
 * these requirements already had a domain test and no proof that the rule ever
 * reaches an HTTP response with the code the specification names.
 *
 * ⚠️ TWO REAL SESSIONS, not one with the grants edited by hand. What BI-046
 * and BI-134 claim is that whoever invoices cannot change prices, and a double
 * with the permissions set in a variable would not see the defect (the lesson
 * of AG-111): «Caja» is a factory role that genuinely lacks
 * `billing:price-manage`, and the administrator's grant is genuinely
 * clinic-wide.
 */
const PASSWORD = 'el caballo come alfalfa';
const CASHIER_EMAIL = 'caja@clinica.ec';
const TARIFF_EMAIL = 'tarifario@clinica.ec';

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

describe('la facturación por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let cashierToken: string;
  let tariffToken: string;
  let siteId: string;
  let otherSiteId: string;
  let patientId: string;
  let payerId: string;
  let serviceId: string;
  let emissionPointId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // No rate limit HERE, like the other HTTP suites: the real one is a
        // handful per second and this file makes a couple of dozen in a row.
        // The STORE is replaced, not the guard — `APP_GUARD` also covers the
        // authorisation guard, which is precisely what these tests exercise.
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
    await seedBilling(prisma);
    await syncAuthorisation(prisma);
    // The role→permission cache is indexed by id, and truncating recreates the
    // roles with new ones: without this every request answers 403.
    registry.invalidate();

    const site = await createSite(prisma);
    const other = await createSite(prisma, 'Sede Sur');
    const patient = await createPatient(prisma);

    siteId = site.id;
    otherSiteId = other.id;
    patientId = patient.id;
    payerId = (
      await prisma.payer.findUniqueOrThrow({ where: { code: 'PARTICULAR' } })
    ).id;
    serviceId = (
      await prisma.billableService.findUniqueOrThrow({
        where: { code: 'CONS-MG-PV' },
      })
    ).id;
    emissionPointId = (
      await prisma.emissionPoint.create({
        data: { siteId: site.id, code: '001', description: 'Caja principal' },
      })
    ).id;

    // AT ONE SITE, which is what makes BI-131 provable.
    cashierToken = await signIn(CASHIER_EMAIL, 'CAJA', siteId, '1710034065');
    /**
     * CLINIC-WIDE (`site_id IS NULL`), which is what `assertClinicWideScope`
     * demands of whoever changes the tariff: what the clinic charges is not a
     * site's (D-023).
     *
     * ⚠️ A ROLE CREATED HERE AND NOT `ADMIN`, and that is the point rather
     * than a shortcut. No factory role carries `billing:price-manage` —
     * neither «Caja», which invoices, nor the administrator (BI-134, and the
     * user's answer «flexible, el admin asigna»). So the clinic makes one, the
     * way roles are meant to be made: as DATA.
     */
    await createTariffRole();
    tariffToken = await signIn(TARIFF_EMAIL, 'TARIFARIO', null, '0919176818');
  }

  /** A role with the price permission and nothing else, as a clinic would. */
  async function createTariffRole(): Promise<void> {
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
  }

  async function signIn(
    email: string,
    roleCode: string,
    grantedSiteId: string | null,
    cedula: string,
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Rosa',
        lastName: 'Cedeño',
        // Synthetic cedula with a COMPUTED check digit, never a real person's.
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

    return (response.body as { accessToken: string }).accessToken;
  }

  const api = () => request(app.getHttpServer());

  async function openAccount(): Promise<string> {
    const response = await api()
      .post(`/api/v1/billing/sites/${siteId}/accounts`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ patientId, payerId })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  async function addCharge(accountId: string): Promise<void> {
    await api()
      .post(`/api/v1/billing/sites/${siteId}/accounts/${accountId}/charges`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ billableServiceId: serviceId, serviceDate: '2026-05-11' })
      .expect(201);
  }

  describe('BI-150 a BI-158 el paso de la consulta a la caja, por HTTP', () => {
    const NOWHERE = '01900000-0000-7000-8000-000000000000';

    /** Una atención sin cita: sirve para todo salvo la línea de la consulta. */
    async function anEncounter(): Promise<string> {
      const user = await prisma.user.findFirstOrThrow({
        where: { email: CASHIER_EMAIL },
      });
      const practitioner = await prisma.practitioner.create({
        data: { userId: user.id },
      });
      const encounter = await prisma.encounter.create({
        data: {
          siteId,
          practitionerId: practitioner.id,
          patientId,
          startedAt: new Date('2026-05-11T14:00:00Z'),
          careModality: 'MORBIDITY',
          visitSequence: 'FIRST_TIME',
        },
      });

      // Un procedimiento registrado en la atención, atado a una prestación por
      // el concepto que las dos partes ya nombran.
      const system = await prisma.catalogSystem.create({
        data: { code: `PR${Date.now()}`, name: 'Procedimientos' },
      });
      const concept = await prisma.catalogConcept.create({
        data: {
          systemId: system.id,
          code: 'SUTURA',
          display: 'Sutura simple',
          validFrom: new Date('2020-01-01'),
        },
      });
      await prisma.billableService.update({
        where: { code: 'PROC-SUTURA' },
        data: { procedureConceptId: concept.id },
      });
      await prisma.encounterProcedure.create({
        data: {
          encounterId: encounter.id,
          conceptId: concept.id,
          procedureCode: 'SUTURA',
          procedureDisplay: 'Sutura simple',
          quantity: 1,
          performedAt: new Date('2026-05-11T14:30:00Z'),
        },
      });

      return encounter.id;
    }

    const checkout = (encounterId: string, body: object = { payerId }) =>
      api()
        .post(
          `/api/v1/billing/sites/${siteId}/encounters/${encounterId}/checkout`,
        ) // prettier-ignore
        .set('Authorization', `Bearer ${cashierToken}`)
        .send(body);

    it('BI-150, BI-151 abre la cuenta de la atención y propone lo que se hizo', async () => {
      const encounterId = await anEncounter();

      const response = await checkout(encounterId).expect(200);
      const body = response.body as {
        statement: { charges: { origin: string; status: string }[] };
        raisedChargeIds: string[];
      };

      expect(body.raisedChargeIds).toHaveLength(1);
      expect(body.statement.charges[0]).toMatchObject({
        origin: 'PROCEDURE',
        // BI-152: nace PROPUESTA, y la factura no se la lleva hasta que
        // alguien la confirme.
        status: 'PLANNED',
      });
    });

    it('BI-154 pulsar dos veces no crea un segundo cargo', async () => {
      const encounterId = await anEncounter();

      await checkout(encounterId).expect(200);
      const second = await checkout(encounterId).expect(200);
      const body = second.body as {
        raisedChargeIds: string[];
        skipped: { reason: string }[];
      };

      expect(body.raisedChargeIds).toEqual([]);
      expect(body.skipped).toContainEqual(
        expect.objectContaining({ reason: 'ALREADY_CHARGED' }),
      );
    });

    it('BI-150 dice qué campo falta cuando la atención todavía no tiene cuenta', async () => {
      const encounterId = await anEncounter();

      const response = await checkout(encounterId, {}).expect(422);
      const problem = response.body as Problem;

      expect(problem.code).toBe('PAYER_REQUIRED_TO_OPEN_ACCOUNT');
      expect(problem.errors?.[0]?.field).toBe('payerId');
    });

    it('BI-135 responde igual ante una atención inexistente que ante una de otra sede', async () => {
      const encounterId = await anEncounter();

      const missing = await checkout(NOWHERE).expect(404);
      const elsewhere = await api()
        .post(
          `/api/v1/billing/sites/${otherSiteId}/encounters/${encounterId}/checkout`,
        ) // prettier-ignore
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ payerId });

      // 403 y no 404: la cajera no tiene alcance sobre la otra sede, y esa es
      // la primera puerta (BI-131). Lo que se afirma aquí es que la ruta NO
      // deja entrar, no cuál de las dos negativas llega.
      expect(elsewhere.status).toBe(403);
      expect((missing.body as Problem).code).toBe(
        'BILLING_ENCOUNTER_NOT_FOUND',
      );
    });

    it('BI-055 exige el motivo para quitar un cargo, y lo guarda', async () => {
      const encounterId = await anEncounter();
      const opened = await checkout(encounterId).expect(200);
      const { statement } = opened.body as {
        statement: { account: { id: string }; charges: { id: string }[] };
      };

      const withoutReason = await api()
        .post(
          `/api/v1/billing/sites/${siteId}/accounts/${statement.account.id}/charges/${statement.charges[0]!.id}/void`,
        ) // prettier-ignore
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({})
        .expect(422);
      expect((withoutReason.body as Problem).errors?.[0]?.field).toBe('reason');

      const voided = await api()
        .post(
          `/api/v1/billing/sites/${siteId}/accounts/${statement.account.id}/charges/${statement.charges[0]!.id}/void`,
        ) // prettier-ignore
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ reason: 'No se cobra: cortesía institucional' })
        .expect(200);

      expect(voided.body).toMatchObject({
        status: 'CANCELLED',
        voidReason: 'No se cobra: cortesía institucional',
      });
    });

    it('BI-059 no admite que un cargo anulado vuelva', async () => {
      const encounterId = await anEncounter();
      const opened = await checkout(encounterId).expect(200);
      const { statement } = opened.body as {
        statement: { account: { id: string }; charges: { id: string }[] };
      };
      const charge = `/api/v1/billing/sites/${siteId}/accounts/${statement.account.id}/charges/${statement.charges[0]!.id}`; // prettier-ignore

      await api()
        .post(`${charge}/void`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ reason: 'La paciente no se hizo el procedimiento' })
        .expect(200);

      const revived = await api()
        .post(`${charge}/confirm`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send()
        .expect(409);

      expect((revived.body as Problem).code).toBe('CHARGE_ALREADY_VOIDED');
    });

    it('BI-152 sólo lo confirmado llega a la factura', async () => {
      // El extracto dice 45.00 y la emisión no encuentra nada que facturar
      // mientras nadie confirme: por eso la respuesta separa los dos totales.
      const encounterId = await anEncounter();
      const opened = await checkout(encounterId).expect(200);
      const { statement } = opened.body as {
        statement: {
          account: { id: string };
          charges: { id: string }[];
          totals: { total: string };
          proposedTotals: { total: string };
        };
      };

      expect(statement.totals.total).toBe(statement.proposedTotals.total);

      const refused = await api()
        .post(`/api/v1/billing/sites/${siteId}/invoices`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          accountId: statement.account.id,
          emissionPointId,
          paymentMethod: '01',
          receiver: {
            // `05` es la cédula en la tabla del SRI, no la palabra.
            identificationType: '05',
            identification: '1710034065',
            name: 'Guamán Andrade, María José',
          },
        })
        .expect(422);
      expect((refused.body as Problem).code).toBe('INVOICE_HAS_NO_ITEMS');

      await api()
        .post(
          `/api/v1/billing/sites/${siteId}/accounts/${statement.account.id}/charges/${statement.charges[0]!.id}/confirm`,
        ) // prettier-ignore
        .set('Authorization', `Bearer ${cashierToken}`)
        .send()
        .expect(200);

      await api()
        .post(`/api/v1/billing/sites/${siteId}/invoices`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          accountId: statement.account.id,
          emissionPointId,
          paymentMethod: '01',
          receiver: {
            // `05` es la cédula en la tabla del SRI, no la palabra.
            identificationType: '05',
            identification: '1710034065',
            name: 'Guamán Andrade, María José',
          },
        })
        .expect(201);
    });

    it('BI-056 rechaza quitar un cargo ya facturado NOMBRANDO la nota de crédito', async () => {
      const accountId = await openAccount();
      await addCharge(accountId);
      const statement = await api()
        .get(`/api/v1/billing/sites/${siteId}/accounts/${accountId}`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);
      const chargeId = (statement.body as { charges: { id: string }[] })
        .charges[0]!.id;

      await api()
        .post(`/api/v1/billing/sites/${siteId}/invoices`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          accountId,
          emissionPointId,
          paymentMethod: '01',
          receiver: {
            // `05` es la cédula en la tabla del SRI, no la palabra.
            identificationType: '05',
            identification: '1710034065',
            name: 'Guamán Andrade, María José',
          },
        })
        .expect(201);

      const refused = await api()
        .post(
          `/api/v1/billing/sites/${siteId}/accounts/${accountId}/charges/${chargeId}/void`,
        ) // prettier-ignore
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ reason: 'Se cobró de más' })
        .expect(409);

      const problem = refused.body as Problem;
      expect(problem.code).toBe('CHARGE_ITEM_ALREADY_INVOICED');
      expect(problem.title).toContain('nota de crédito');
    });
  });

  describe('BI-001 el dinero viaja como cadena', () => {
    it('BI-001 sirve todo importe como cadena y nunca como número de JSON', async () => {
      const accountId = await openAccount();
      await addCharge(accountId);

      const response = await api()
        .get(`/api/v1/billing/sites/${siteId}/accounts/${accountId}`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);

      // An amount serialised as a JSON number has already lost precision
      // before the client reads it: `JSON.parse` turns 19.90 into a double.
      const body = response.body as {
        totals: Record<string, unknown>;
        charges: { unitAmount: unknown; lineTotal: unknown }[];
      };

      for (const value of Object.values(body.totals)) {
        expect(typeof value).toBe('string');
      }
      expect(typeof body.charges[0]?.unitAmount).toBe('string');
      expect(body.totals.total).toBe('30.00');
    });
  });

  describe('BI-036 el RUC de un pagador, como lo exige la interfaz', () => {
    const createPayer = (body: Record<string, unknown>) =>
      api()
        .post('/api/v1/billing/payers')
        .set('Authorization', `Bearer ${tariffToken}`)
        .send({ name: 'Aseguradora de prueba', kind: 'PRIVATE_INSURANCE', ...body }); // prettier-ignore

    it('BI-036 rechaza un RUC de doce dígitos en su campo, y no guarda nada', async () => {
      // An institutional payer went through `Ruc` before D-057 too: this one
      // pins the field and the absence of a row. What is NEW is that every
      // kind does (the «Particular» cases below) and the database (last one).
      const before = await prisma.payer.count();

      const response = await createPayer({ code: 'SEG-12', ruc: '179318990600' }).expect(422); // prettier-ignore

      const problem = response.body as Problem;
      expect(problem.code).toBe('INVALID_RUC');
      expect(problem.errors?.[0]?.field).toBe('ruc');
      expect(await prisma.payer.count()).toBe(before);
    });

    it('BI-036 rechaza también el RUC mal escrito de «Particular»', async () => {
      const response = await createPayer({ code: 'PART-2', kind: 'SELF_PAY', ruc: '12345' }).expect(422); // prettier-ignore

      expect((response.body as Problem).code).toBe('INVALID_RUC');
    });

    it('BI-036 al editar «Particular», rechaza un RUC mal escrito y deja el guardado como estaba', async () => {
      const response = await api()
        .patch(`/api/v1/billing/payers/${payerId}`)
        .set('Authorization', `Bearer ${tariffToken}`)
        .send({ ruc: '12345' })
        .expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('INVALID_RUC');
      expect(problem.errors?.[0]?.field).toBe('ruc');
      expect(
        await prisma.payer.findUniqueOrThrow({
          where: { id: payerId },
          select: { ruc: true },
        }),
      ).toEqual({ ruc: null });

      // Control: the same PATCH with a well-formed RUC is saved.
      await api()
        .patch(`/api/v1/billing/payers/${payerId}`)
        .set('Authorization', `Bearer ${tariffToken}`)
        .send({ ruc: '1793189906001' })
        .expect(200);
      expect(
        await prisma.payer.findUniqueOrThrow({
          where: { id: payerId },
          select: { ruc: true },
        }),
      ).toEqual({ ruc: '1793189906001' });
    });

    it('BI-036 guarda el RUC de una sociedad que no pasa módulo 11', async () => {
      const response = await createPayer({ code: 'SEG-N', ruc: '1793189906001' }).expect(201); // prettier-ignore

      expect(
        await prisma.payer.findUniqueOrThrow({
          where: { id: (response.body as { id: string }).id },
          select: { ruc: true },
        }),
      ).toEqual({ ruc: '1793189906001' });
    });

    it('BI-036 la base rechaza por su cuenta un RUC de pagador que no son trece dígitos', async () => {
      // Control first: the same INSERT with thirteen digits goes in, so what
      // refuses the second one is the shape and nothing else.
      await prisma.$executeRaw`
        INSERT INTO payer (code, name, kind, ruc, updated_at)
        VALUES ('RAW-13', 'Directo', 'PRIVATE_INSURANCE', '1793189906001', now())
      `;
      await expect(
        prisma.$executeRaw`
          INSERT INTO payer (code, name, kind, ruc, updated_at)
          VALUES ('RAW-12', 'Directo', 'PRIVATE_INSURANCE', '179318990600', now())
        `,
      ).rejects.toThrowError(/payer_ruc_format/);
      // And the other half of the shape: thirteen digits ending in `000`,
      // which is no establishment code.
      await expect(
        prisma.$executeRaw`
          INSERT INTO payer (code, name, kind, ruc, updated_at)
          VALUES ('RAW-000', 'Directo', 'PRIVATE_INSURANCE', '1793189906000', now())
        `,
      ).rejects.toThrowError(/payer_ruc_format/);
    });
  });

  describe('BI-046, BI-134 quien factura no fija precios', () => {
    it('BI-134 niega a caja el cambio de una tarifa, con el permiso propio', async () => {
      // No factory role carries `billing:write` and `billing:price-manage` at
      // once: a price is a datum that moves money.
      const response = await api()
        .post(`/api/v1/billing/payers/${payerId}/prices`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          billableServiceId: serviceId,
          amount: '35.00',
          effectiveFrom: '2026-07-01',
        })
        .expect(403);

      expect((response.body as Problem).code).toBe('PERMISSION_DENIED');
    });

    it('BI-044 admite a quien tiene `billing:price-manage` en TODA la clínica', async () => {
      const response = await api()
        .post(`/api/v1/billing/payers/${payerId}/prices`)
        .set('Authorization', `Bearer ${tariffToken}`)
        .send({
          billableServiceId: serviceId,
          amount: '35.00',
          effectiveFrom: '2026-07-01',
        })
        .expect(201);

      expect((response.body as { amount: string }).amount).toBe('35.00');
    });

    it('BI-046 deja leer el tarifario a caja, porque para cobrar hay que verlo', async () => {
      const response = await api()
        .get(`/api/v1/billing/payers/${payerId}/prices`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);

      expect((response.body as { items: unknown[] }).items.length).toBeGreaterThan(0); // prettier-ignore
    });
  });

  describe('BI-047, BI-057 lo que se le dice a quien está en caja', () => {
    it('BI-047 nombra prestación, pagador y fecha cuando no hay precio vigente', async () => {
      const accountId = await openAccount();

      const response = await api()
        .post(`/api/v1/billing/sites/${siteId}/accounts/${accountId}/charges`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ billableServiceId: serviceId, serviceDate: '2025-06-01' })
        .expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('PRICE_NOT_FOUND');
      expect(problem.errors?.[0]?.field).toBe('serviceDate');
      // ⚠️ AND THE NAME OF THE SERVICE IS NOWHERE IN IT (BI-007, SC-026): a
      // service name can be as revealing as a diagnosis.
      expect(JSON.stringify(problem)).not.toMatch(/Consulta de medicina/);
    });

    it('BI-057 rechaza por campo una cantidad que no es un número decimal', async () => {
      const accountId = await openAccount();

      const response = await api()
        .post(`/api/v1/billing/sites/${siteId}/accounts/${accountId}/charges`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          billableServiceId: serviceId,
          serviceDate: '2026-05-11',
          quantity: 'dos',
        })
        .expect(422);

      expect((response.body as Problem).errors?.[0]?.field).toBe('quantity');
    });
  });

  describe('BI-080, BI-081 el receptor de la factura', () => {
    it('BI-080 rechaza emitir sin receptor y dice qué campo falta', async () => {
      const accountId = await openAccount();
      await addCharge(accountId);

      const response = await api()
        .post(`/api/v1/billing/sites/${siteId}/invoices`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ accountId, emissionPointId, receiver: {}, paymentMethod: '01' })
        .expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('INVOICE_RECEIVER_REQUIRED');
      expect(problem.errors?.[0]?.field).toBe('receiver.identificationType');
    });

    it('BI-081 no admite «Consumidor Final» sin confirmación explícita y motivo', async () => {
      // The confirmation is the SERVER'S, not a dialog's: a warning that lives
      // on a screen disappears the moment somebody calls this route from a
      // cashier shortcut — and this is that route.
      const accountId = await openAccount();
      await addCharge(accountId);

      const response = await api()
        .post(`/api/v1/billing/sites/${siteId}/invoices`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          accountId,
          emissionPointId,
          paymentMethod: '01',
          receiver: { finalConsumer: { confirmed: true } },
        })
        .expect(422);

      expect((response.body as Problem).code).toBe(
        'FINAL_CONSUMER_NOT_CONFIRMED',
      );
    });

    it('BI-082 propone la identificación del paciente sin aplicarla por su cuenta', async () => {
      const accountId = await openAccount();
      await prisma.patientIdentifier.create({
        data: { patientId, type: 'CEDULA', value: '1710034065' },
      });

      const response = await api()
        .get(
          `/api/v1/billing/sites/${siteId}/accounts/${accountId}/invoice-receiver`,
        )
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        identificationType: '05',
        identification: '1710034065',
      });
    });

    it('BI-085, BI-086 emite la factura con su secuencial y sus totales congelados', async () => {
      const accountId = await openAccount();
      await addCharge(accountId);

      const response = await api()
        .post(`/api/v1/billing/sites/${siteId}/invoices`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          accountId,
          emissionPointId,
          paymentMethod: '01',
          receiver: {
            identificationType: '05',
            identification: '1710034065',
            name: 'Guamán Andrade, María José',
          },
        })
        .expect(201);

      expect(response.body).toMatchObject({
        sequential: '000000001',
        status: 'ISSUED',
        isFinalConsumer: false,
        totals: expect.objectContaining({ total: '30.00' }),
      });
    });
  });

  describe('BI-159 el RUC y la cédula del receptor, antes de emitir', () => {
    const issueTo = (
      accountId: string,
      identificationType: '04' | '05',
      identification: string,
    ) =>
      api()
        .post(`/api/v1/billing/sites/${siteId}/invoices`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          accountId,
          emissionPointId,
          paymentMethod: '01',
          receiver: { identificationType, identification, name: 'Receptor' },
        });

    it.each([
      ['sin establecimiento', '1790012345000'],
      ['de una provincia que no existe', '2590000000001'],
    ])(
      'BI-159 rechaza un RUC %s sin emitir ni gastar el secuencial',
      async (_, ruc) => {
        const accountId = await openAccount();
        await addCharge(accountId);

        const refused = await issueTo(accountId, '04', ruc).expect(422);

        const problem = refused.body as Problem;
        expect(problem.code).toBe('INVALID_RUC');
        expect(problem.errors?.[0]?.field).toBe('receiver.identification');
        expect(await prisma.invoice.count({ where: { accountId } })).toBe(0);

        // Control: the same account with a RUC the SRI accepts is issued, and
        // takes the FIRST sequential — the refusal consumed none.
        const issued = await issueTo(accountId, '04', '1793189906001').expect(201); // prettier-ignore
        expect(issued.body).toMatchObject({ sequential: '000000001' });
      },
    );

    it('BI-159 rechaza una cédula con verificador equivocado', async () => {
      const accountId = await openAccount();
      await addCharge(accountId);

      const refused = await issueTo(accountId, '05', '1710034066').expect(422);

      const problem = refused.body as Problem;
      expect(problem.code).toBe('INVALID_CEDULA');
      expect(problem.errors?.[0]?.field).toBe('receiver.identification');
      expect(await prisma.invoice.count({ where: { accountId } })).toBe(0);

      const issued = await issueTo(accountId, '05', '1710034065').expect(201);
      expect(issued.body).toMatchObject({ sequential: '000000001' });
    });
  });

  describe('BI-090, BI-130, BI-131, BI-135 la superficie de la API', () => {
    it('BI-090 no expone ninguna ruta que modifique o borre una factura emitida', async () => {
      const accountId = await openAccount();
      await addCharge(accountId);

      const issued = await api()
        .post(`/api/v1/billing/sites/${siteId}/invoices`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          accountId,
          emissionPointId,
          paymentMethod: '01',
          receiver: {
            identificationType: '05',
            identification: '1710034065',
            name: 'Guamán Andrade, María José',
          },
        })
        .expect(201);

      const invoiceId = (issued.body as { id: string }).id;
      const url = `/api/v1/billing/sites/${siteId}/invoices/${invoiceId}`;

      // THE ABSENCE IS THE REQUIREMENT (D-A-007). Not «there is a route and it
      // refuses»: there is no route, so the router answers 404 for the verb.
      for (const attempt of [
        api().patch(url),
        api().put(url),
        api().delete(url),
      ]) {
        await attempt
          .set('Authorization', `Bearer ${cashierToken}`)
          .send({ total: '1.00' })
          .expect(404);
      }
    });

    it('BI-131 niega a la cajera de una sede las cuentas de otra', async () => {
      const response = await api()
        .get(`/api/v1/billing/sites/${otherSiteId}/accounts`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(403);

      expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
    });

    it('BI-135 responde igual ante una cuenta de otra sede que ante una inexistente', async () => {
      // Distinguishing them would confirm other sites' accounts to whoever
      // guesses identifiers, and an account confirms that a patient was there.
      const accountId = await openAccount();

      const existing = await api()
        .get(`/api/v1/billing/sites/${siteId}/accounts/${accountId}`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);
      expect(existing.body).toBeDefined();

      const missing = await api()
        .get(
          `/api/v1/billing/sites/${siteId}/accounts/00000000-0000-4000-8000-000000000000`,
        )
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(404);

      expect((missing.body as Problem).code).toBe('ACCOUNT_NOT_FOUND');
    });

    it('BI-130 rechaza sin sesión toda ruta de facturación', async () => {
      // Closed by default, and billing has NO public route in this delivery:
      // the public tariff of BI-110 is B5 and is the only one there will be.
      await api().get(`/api/v1/billing/tax-rates`).expect(401);
      await api().get(`/api/v1/billing/sites/${siteId}/invoices`).expect(401);
    });
  });

  describe('BI-033, BI-071, BI-072 el ciclo de la cuenta', () => {
    it('BI-033 rechaza cambiar el pagador cuando la cuenta ya tiene cargos', async () => {
      const accountId = await openAccount();
      await addCharge(accountId);

      const response = await api()
        .patch(`/api/v1/billing/sites/${siteId}/accounts/${accountId}`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ payerId })
        .expect(409);

      expect((response.body as Problem).code).toBe('ACCOUNT_HAS_CHARGES');
    });

    it('BI-072 rechaza cerrar una cuenta con cargos sin facturar', async () => {
      const accountId = await openAccount();
      await addCharge(accountId);

      const response = await api()
        .post(`/api/v1/billing/sites/${siteId}/accounts/${accountId}/close`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(409);

      expect((response.body as Problem).code).toBe('ACCOUNT_HAS_OPEN_CHARGES');
    });

    it('BI-071 rechaza añadir cargos a una cuenta ya cerrada', async () => {
      const accountId = await openAccount();
      await api()
        .post(`/api/v1/billing/sites/${siteId}/accounts/${accountId}/close`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .expect(200);

      const response = await api()
        .post(`/api/v1/billing/sites/${siteId}/accounts/${accountId}/charges`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ billableServiceId: serviceId, serviceDate: '2026-05-11' })
        .expect(409);

      expect((response.body as Problem).code).toBe('ACCOUNT_CLOSED');
    });
  });
});
