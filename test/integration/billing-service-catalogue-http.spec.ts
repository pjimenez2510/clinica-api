import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { seedBilling } from '../../prisma/seed-billing.mts';
import { seedSpecialties } from '../../prisma/seed-specialties.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { addDays, clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * UN SOLO CATÁLOGO DE SERVICIOS, POR HTTP (B21, ADR-013).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo que decide la aplicación, con una sesión de verdad que tiene
 * `billing:price-manage`, sobre la semilla real: buscar y paginar en el
 * servidor (BI-282), la ficha en una respuesta (BI-283), el alta con su tipo y
 * su precio (BI-280, BI-279, BI-284), retirar (BI-288) y la bitácora (BI-290).
 * Lo que garantiza la base está en `service-catalogue-guarantees.spec.ts`.
 */

const PASSWORD = 'el caballo come alfalfa';

interface ListItem {
  id: string;
  code: string;
  name: string;
  kind: string;
  consultation: { specialtyId: string; durationMinutes: number } | null;
  prices: { payerId: string; amount: string }[];
}
interface Page {
  items: ListItem[];
  total: number;
  kindCounts: { kind: string; total: number }[];
  page: number;
  pageSize: number;
}
interface Problem {
  code: string;
  errors?: { field: string; code: string; message?: string }[];
}

describe('el catálogo de servicios por HTTP (B21)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  let manager: string;
  let cashier: string;

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

    await seedSpecialties(prisma);
    await seedBilling(prisma);
    await syncAuthorisation(prisma);
    await prisma.role.create({
      data: {
        code: 'TARIFARIO',
        name: 'Tarifario',
        permissions: {
          create: [
            { permissionCode: 'billing:read' },
            { permissionCode: 'billing:price-manage' },
          ],
        },
      },
    });
    await prisma.role.create({
      data: {
        code: 'LECTOR',
        name: 'Sólo lee el catálogo',
        permissions: { create: [{ permissionCode: 'billing:read' }] },
      },
    });
    registry.invalidate();
    manager = await signIn('tarifario@clinica.ec', 'TARIFARIO', '0919176818');
    cashier = await signIn('lector@clinica.ec', 'LECTOR', '1710034065');
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
    return `Bearer ${(response.body as { accessToken: string }).accessToken}`;
  }

  const api = () => request(app.getHttpServer());
  const list = async (query: string, as = manager): Promise<Page> =>
    (
      await api()
        .get(`/api/v1/billing/services?${query}`)
        .set('Authorization', as)
        .expect(200)
    ).body as Page;

  describe('BI-189 los precios de un servicio en todas las listas', () => {
    it('BI-189 sirve el precio de cada lista con su vigencia, y marca el vigente hoy en Ecuador', async () => {
      const service = await prisma.service.findUniqueOrThrow({
        where: { code: 'CONS-MG-PV' },
      });
      const agreement = await prisma.payer.findUniqueOrThrow({
        where: { code: 'CONVENIO-EMPRESA-EJEMPLO' },
      });
      const list = await prisma.priceList.findFirstOrThrow({
        where: { payerId: agreement.id },
      });
      // From the clock, never by hand: one that ended, one in force today.
      const today = clinicalDateOf(new Date());
      const day = (offset: number) =>
        new Date(`${addDays(today, offset)}T00:00:00Z`);
      const ended = await prisma.price.create({
        data: { priceListId: list.id, serviceId: service.id, amount: '22.00', validFrom: day(-60), validTo: day(-30) }, // prettier-ignore
      });
      const current = await prisma.price.create({
        data: { priceListId: list.id, serviceId: service.id, amount: '24.00', validFrom: day(-30) }, // prettier-ignore
      });

      const { items } = (
        await api()
          .get(`/api/v1/billing/services/${service.id}/prices`)
          .set('Authorization', manager)
          .expect(200)
      ).body as {
        items: {
          priceId: string;
          amount: string;
          validFrom: string;
          validTo: string | null;
          inForce: boolean;
          payer: { kind: string };
        }[];
      };

      const byId = new Map(items.map((item) => [item.priceId, item]));
      expect(byId.get(ended.id)).toMatchObject({
        amount: '22.00',
        validFrom: addDays(today, -60),
        validTo: addDays(today, -30),
        inForce: false,
      });
      expect(byId.get(current.id)).toMatchObject({
        amount: '24.00',
        validTo: null,
        inForce: true,
      });
      // Control: the self-pay list is there too, in force today.
      expect(
        items.find((item) => item.payer.kind === 'SELF_PAY' && item.inForce),
      ).toMatchObject({ amount: '30.00' });
    });
  });

  describe('BI-014 el servicio desactivado', () => {
    it('BI-014 deja de ofrecerse en la lista y sólo vuelve cuando se piden los desactivados', async () => {
      const service = await prisma.service.findUniqueOrThrow({
        where: { code: 'LAB-TSH' },
      });
      // Control: active, it is offered.
      expect((await list('q=LAB-TSH')).items.map((item) => item.id)).toContain(service.id); // prettier-ignore

      await api()
        .patch(`/api/v1/billing/services/${service.id}`)
        .set('Authorization', manager)
        .send({ active: false })
        .expect(200);

      expect((await list('q=LAB-TSH')).items.map((item) => item.id)).not.toContain(service.id); // prettier-ignore
      expect(
        (await list('q=LAB-TSH&includeInactive=true')).items.map(
          (item) => item.id,
        ),
      ).toContain(service.id);
    });
  });

  describe('BI-282 buscar y paginar en el servidor', () => {
    it('BI-282 encuentra por el nombre sin tildes ni mayúsculas y por el código, con el exacto primero', async () => {
      const byName = await list('q=GLUCOSA%20en%20AYUNAS');
      expect(byName.items.map((item) => item.code)).toContain(
        'LAB-GLUCOSA-AYUNAS',
      );

      const withoutAccents = await list('q=cardiologia');
      expect(withoutAccents.items.length).toBeGreaterThan(0);
      expect(withoutAccents.items.every((item) => /cardiolog/i.test(item.name))).toBe(true); // prettier-ignore

      const byCode = await list('q=proc-ecg');
      expect(byCode.items[0]?.code).toBe('PROC-ECG');

      // Control: a text nobody has finds nothing.
      expect((await list('q=zzzz-nada')).total).toBe(0);
    });

    it('BI-282 pagina en la base y dice el total; sólo 20, 50 o 100 por página', async () => {
      const first = await list('pageSize=20&page=1');
      const second = await list('pageSize=20&page=2');
      expect(first.items).toHaveLength(20);
      expect(first.total).toBeGreaterThan(20);
      expect(second.page).toBe(2);
      expect(
        second.items.some((item) =>
          first.items.some((seen) => seen.id === item.id),
        ),
      ).toBe(false);

      const wrong = await api()
        .get('/api/v1/billing/services?pageSize=30')
        .set('Authorization', manager)
        .expect(422);
      expect((wrong.body as Problem).code).toBe('VALIDATION_FAILED');
    });

    it('BI-282 filtra por tipo y por especialidad', async () => {
      const exams = await list('kind=LAB_EXAM&pageSize=100');
      expect(exams.total).toBeGreaterThan(0);
      expect(exams.items.every((item) => item.kind === 'LAB_EXAM')).toBe(true);
      // BI-292. The tabs count every kind with the same text, the kind aside.
      const counts = new Map(
        exams.kindCounts.map((row) => [row.kind, row.total]),
      );
      expect(counts.get('LAB_EXAM')).toBe(exams.total);
      expect(counts.get('CONSULTATION')).toBeGreaterThan(0);

      const cardiology = await prisma.specialty.findFirstOrThrow({
        where: { code: 'cardiologia' },
      });
      const consultations = await list(`kind=CONSULTATION&specialtyId=${cardiology.id}`); // prettier-ignore
      expect(consultations.items.map((item) => item.name).sort()).toEqual([
        'Consulta de cardiología · Control',
        'Consulta de cardiología · Primera vez',
      ]);
    });

    it('BI-282 cada fila trae su precio vigente en la lista particular y en la de cada convenio activo', async () => {
      const glucose = (await list('q=LAB-GLUCOSA-AYUNAS')).items[0]!;
      const selfPay = await prisma.payer.findUniqueOrThrow({
        where: { code: 'PARTICULAR' },
      });
      expect(glucose.prices).toContainEqual(
        expect.objectContaining({ payerId: selfPay.id }),
      );

      // An agreement's own price shows in its column; without one, it is absent.
      const agreement = await prisma.payer.create({
        data: {
          code: 'CONV-1',
          name: 'Convenio Uno',
          kind: 'COMPANY_AGREEMENT',
        },
      });
      const agreementList = await prisma.priceList.create({
        data: { name: 'Convenio Uno', payerId: agreement.id },
      });
      await prisma.price.create({
        data: {
          priceListId: agreementList.id,
          serviceId: glucose.id,
          amount: '3.00',
          validFrom: new Date(Date.now() - 30 * 86_400_000),
        },
      });
      const repriced = (await list('q=LAB-GLUCOSA-AYUNAS')).items[0]!;
      expect(repriced.prices).toContainEqual(
        expect.objectContaining({ payerId: agreement.id, amount: '3.00' }),
      );
      const other = (await list('q=LAB-BH')).items[0]!;
      expect(other.prices.some((price) => price.payerId === agreement.id)).toBe(false); // prettier-ignore
    });
  });

  it('BI-023 en el orden de revisar el IVA, las pendientes primero y agrupadas por código del SRI', async () => {
    const reviewed = await prisma.service.findUniqueOrThrow({
      where: { code: 'LAB-BH' },
    });
    const reviewer = await prisma.user.findFirstOrThrow();
    await prisma.service.update({
      where: { id: reviewed.id },
      data: { taxReviewedAt: new Date(), taxReviewedById: reviewer.id },
    });

    const page = await list('forTaxReview=true&pageSize=100');
    const codes = page.items.map((item) => item.code);
    // The reviewed one goes after every pending one.
    expect(codes.at(-1)).toBe('LAB-BH');
    // Control: without the flag it is in its kind's place, not last.
    const plain = await list('pageSize=100');
    expect(plain.items.map((item) => item.code).at(-1)).not.toBe('LAB-BH');
  });

  describe('BI-280 crear con su tipo y su precio', () => {
    it('BI-279 BI-280 crea una consulta con su especialidad, su duración y su precio, y aparece una vez en la lista', async () => {
      const cardiology = await prisma.specialty.findFirstOrThrow({
        where: { code: 'cardiologia' },
      });
      const created = await api()
        .post('/api/v1/billing/services')
        .set('Authorization', manager)
        .send({
          kind: 'CONSULTATION',
          name: 'Consulta de cardiología · Control prenatal',
          specialtyId: cardiology.id,
          durationMinutes: 20,
          // The seed has its «Primera vez» and «Control» (BI-298): one
          // without visit is still free.
          visitKind: null,
          selfPayAmount: '25.00',
        })
        .expect(201);
      const body = created.body as ListItem;
      expect(body.code).toMatch(/^CONS-/);
      expect(body.consultation).toMatchObject({ durationMinutes: 20 });

      const found = await list('q=control%20prenatal');
      expect(found.items).toHaveLength(1);
      expect(found.items[0]!.prices.map((price) => price.amount)).toEqual(['25.00']); // prettier-ignore
    });

    it('BI-298 una segunda «Control» de cardiología se rechaza con 409 nombrando la que existe', async () => {
      const cardiology = await prisma.specialty.findFirstOrThrow({
        where: { code: 'cardiologia' },
      });
      const twin = {
        kind: 'CONSULTATION',
        name: 'Control cardiológico',
        specialtyId: cardiology.id,
        durationMinutes: 20,
        visitKind: 'FOLLOW_UP',
        selfPayAmount: '25.00',
      };

      const refused = await api()
        .post('/api/v1/billing/services')
        .set('Authorization', manager)
        .send(twin)
        .expect(409);
      const problem = refused.body as Problem;
      expect(problem.code).toBe('CONSULTATION_DUPLICATE');
      expect(problem.errors?.[0]?.message).toBe(
        `Ya existe la consulta de ${cardiology.name} · Control: edítela`,
      );

      // Control: the same request as a first visit of a specialty of its own.
      const other = await prisma.specialty.create({
        data: {
          code: 'cardiologia-pediatrica',
          name: 'Cardiología pediátrica',
        },
      });
      await api()
        .post('/api/v1/billing/services')
        .set('Authorization', manager)
        .send({ ...twin, specialtyId: other.id })
        .expect(201);
    });

    it('BI-280 exige el precio particular; cero vale (D-228)', async () => {
      const missing = await api()
        .post('/api/v1/billing/services')
        .set('Authorization', manager)
        .send({ kind: 'SUPPLY', name: 'Guantes de nitrilo' })
        .expect(422);
      expect((missing.body as Problem).errors).toContainEqual(
        expect.objectContaining({ field: 'selfPayAmount' }),
      );

      await api()
        .post('/api/v1/billing/services')
        .set('Authorization', manager)
        .send({
          kind: 'SUPPLY',
          name: 'Guantes de nitrilo',
          selfPayAmount: '0.00',
        })
        .expect(201);
    });

    it('BI-279 una consulta sin especialidad se rechaza nombrando el campo', async () => {
      const refused = await api()
        .post('/api/v1/billing/services')
        .set('Authorization', manager)
        .send({
          kind: 'CONSULTATION',
          name: 'Consulta suelta',
          durationMinutes: 20,
          selfPayAmount: '20.00',
        }) // prettier-ignore
        .expect(422);
      expect(refused.body).toMatchObject({
        code: 'CONSULTATION_INCOMPLETE',
        errors: [expect.objectContaining({ field: 'specialtyId' })],
      });
    });

    it('BI-278 dos servicios activos no comparten nombre', async () => {
      const refused = await api()
        .post('/api/v1/billing/services')
        .set('Authorization', manager)
        .send({
          kind: 'OTHER',
          name: 'glucosa EN ayunas',
          selfPayAmount: '5.00',
        })
        .expect(409);
      expect((refused.body as Problem).code).toBe('SERVICE_NAME_DUPLICATE');
    });

    it('BI-284 un examen nace con su extensión de orden y su ficha la devuelve', async () => {
      const created = await api()
        .post('/api/v1/billing/services')
        .set('Authorization', manager)
        .send({
          kind: 'LAB_EXAM',
          name: 'Ferritina',
          selfPayAmount: '12.00',
          exam: {
            specimenType: 'Suero',
            requiresFasting: true,
            fastingHours: 8,
          },
        })
        .expect(201);
      const detail = await api()
        .get(`/api/v1/billing/services/${(created.body as ListItem).id}`)
        .set('Authorization', manager)
        .expect(200);
      expect(detail.body).toMatchObject({
        kind: 'LAB_EXAM',
        exam: { specimenType: 'Suero', requiresFasting: true, fastingHours: 8 },
        analytes: [],
        prices: [expect.objectContaining({ amount: '12.00', inForce: true })],
      });
    });

    it('BI-046 crear exige billing:price-manage; quien sólo lee no crea', async () => {
      await api()
        .post('/api/v1/billing/services')
        .set('Authorization', cashier)
        .send({ kind: 'SUPPLY', name: 'Algodón', selfPayAmount: '1.00' })
        .expect(403);
      // Control: the same body, with the manager's key.
      await api()
        .post('/api/v1/billing/services')
        .set('Authorization', manager)
        .send({ kind: 'SUPPLY', name: 'Algodón', selfPayAmount: '1.00' })
        .expect(201);
    });
  });

  describe('BI-283 la ficha en una respuesta', () => {
    it('BI-283 trae la extensión, las determinaciones en orden con sus rangos vigentes y los precios', async () => {
      const glucose = await prisma.service.findUniqueOrThrow({
        where: { code: 'LAB-GLUCOSA-AYUNAS' },
      });
      const detail = await api()
        .get(`/api/v1/billing/services/${glucose.id}`)
        .set('Authorization', cashier)
        .expect(200);
      const body = detail.body as {
        exam: object | null;
        analytes: { position: number; ranges: { rangeKind: string }[] }[];
        prices: { inForce: boolean }[];
      };
      expect(body.exam).not.toBeNull();
      expect(body.analytes.length).toBeGreaterThan(0);
      expect(body.analytes.map((analyte) => analyte.position)).toEqual(
        [...body.analytes.map((analyte) => analyte.position)].sort(
          (a, b) => a - b,
        ),
      );
      expect(body.analytes.flatMap((analyte) => analyte.ranges).length).toBeGreaterThan(0); // prettier-ignore
      expect(body.prices.some((price) => price.inForce)).toBe(true);
    });
  });

  describe('BI-288 retirar y BI-290 la bitácora', () => {
    it('BI-288 BI-290 retira el que nadie usó, con su precio, y deja la bitácora; uno con cita no se retira', async () => {
      const created = await api()
        .post('/api/v1/billing/services')
        .set('Authorization', manager)
        .send({ kind: 'SUPPLY', name: 'Esparadrapo', selfPayAmount: '0.80' })
        .expect(201);
      const id = (created.body as ListItem).id;
      await api()
        .delete(`/api/v1/billing/services/${id}`)
        .set('Authorization', manager)
        .expect(204);
      expect(await prisma.service.count({ where: { id } })).toBe(0);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'service', resourceId: id },
        orderBy: { occurredAt: 'asc' },
      });
      expect(trail.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
      expect(trail[0]!.after).toMatchObject({
        name: 'Esparadrapo',
        kind: 'SUPPLY',
      });

      // An appointment names the next one: it is not retired, it is answered.
      const cardiology = await prisma.specialty.findFirstOrThrow({
        where: { code: 'cardiologia' },
      });
      const booked = (
        await api()
          .post('/api/v1/billing/services')
          .set('Authorization', manager)
          .send({
            kind: 'CONSULTATION',
            name: 'Consulta de cardiología · Preoperatoria',
            specialtyId: cardiology.id,
            durationMinutes: 30,
            selfPayAmount: '30.00',
          })
          .expect(201)
      ).body as ListItem;
      const site = await createSite(prisma);
      const practitioner = await createPractitioner(prisma);
      const patient = await createPatient(prisma);
      const startsAt = new Date(Date.now() + 86_400_000);
      await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 30 * 60_000),
          bookingChannel: 'PHONE',
          serviceId: booked.id,
        },
      });
      const refused = await api()
        .delete(`/api/v1/billing/services/${booked.id}`)
        .set('Authorization', manager)
        .expect(409);
      expect((refused.body as Problem).code).toBe('BILLABLE_SERVICE_IN_USE');
    });
  });
});
